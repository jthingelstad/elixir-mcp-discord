/**
 * THE REVIEW LANE — evaluation as a feature of the bot, not a job beside it.
 *
 * Every other lane talks to clan members. This one talks to the operator: it
 * reads the turn ledger (src/ledger.js) for a window, grades what the bot said
 * against the bot's own rules, and turns what it finds into EDITS to the
 * files the operator owns — proposed by DM with a button to apply. Accepted
 * edits are the bot's memory (agent/lessons.md, identity.md, a routine's
 * brief); prompts hot-load, so accepting is deploying.
 *
 * Why it is shaped this way, in order of importance:
 *
 *   FINDINGS BECOME DIFFS. A review that produces observations produces a
 *   to-do list nobody works. Every proposal here is a concrete edit to a named
 *   file, shown as a diff, one click from live. A finding that cannot be
 *   expressed as an edit is either a mechanics report (for the code, pasted
 *   into an issue) or an Elixir filing (for the hub) — never a paragraph.
 *
 *   HUMANS OUTRANK THE RUBRIC. Grading against the rules can only find rules
 *   broken. The worst answers follow the rules perfectly (2026-09-13: the bot
 *   asked a member for a tag it could have read off the roster, exactly as
 *   instructed). What catches those is a person stepping in — a 👎, a leader
 *   nudging in the thread, the asker saying "no". Those are recorded on the
 *   turn (reactions, interventions, findings) and the review reads them first.
 *
 *   MEASURE THE LAST CHANGE. A review opens by checking whether the previous
 *   review's applied edits did what they claimed, from the turns since. An
 *   edit that did not help gets a revert proposal. This is what keeps
 *   model-written prompt edits from becoming drift.
 *
 *   BOUNDED. At most REVIEW_MAX_PROPOSALS per review; diffs, never rewrites;
 *   each cites turns; lessons.md has a hard cap and the review prunes it.
 *   Its own model, budget lane and clock, so it can never cost a member an
 *   answer.
 *
 * What it may touch: files under agent/ — lessons.md, identity.md,
 * routines/<key>.md below the front matter. Nothing else, ever: not src/,
 * not .env, not a routine's fields. Every write keeps the prior version under
 * agent/.history/. Nothing here posts to a member channel.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ask, spendBlock } from "./claude.js";
import { MECHANICS, LESSONS_MAX_CHARS } from "./prompt.js";
import { renderTurn } from "./turns.js";
import { dueRoutines, periodKey, lastOccurrence } from "./schedule.js";
import { chunk } from "./post.js";
import * as budget from "./budget.js";
import * as ledger from "./ledger.js";
import { log } from "./log.js";
import * as state from "./state.js";

export const REPO_ISSUES = "https://github.com/jthingelstad/elixir-mcp-discord/issues";

const DAY_MS = 86_400_000;
/** How much transcript one review reads. ~180K tokens: a busy week whole. */
const WINDOW_CHARS = 700_000;
/** A flagged turn is shown with tool bodies, unless it is this big. */
const FULL_TURN_CHARS = 30_000;
const MAX_LESSON_ENTRIES = 20;
const MAX_MECHANICS_REPORTS = 5;
const HISTORY_DIR = ".history";

// ---------------------------------------------------------------- the files

const EDITABLE = /^(lessons\.md|identity\.md|routines\/[a-z0-9-]+\.md)$/;

/** The operator's files as the review may see and edit them. */
export function readAgentFiles({ dir = config.agentDir } = {}) {
  const files = {};
  for (const name of ["identity.md", "lessons.md"]) {
    try {
      files[name] = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      files[name] = null;
    }
  }
  try {
    for (const entry of fs.readdirSync(path.join(dir, "routines"))) {
      if (entry.endsWith(".md")) files[`routines/${entry}`] = fs.readFileSync(path.join(dir, "routines", entry), "utf8");
    }
  } catch {
    /* no routines dir */
  }
  return files;
}

/** Where a routine's editable text starts: after the front matter. */
function bodyStart(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? match[0].length : 0;
}

const lessonLines = (text) => (text || "").split("\n").filter((l) => /^- /.test(l));

/**
 * Check an edit against the file as it is NOW, and produce the file as it
 * would be. Pure: nothing is written. `{ ok, next, preview }` or
 * `{ ok: false, error }`. The same check runs at proposal time and again at
 * apply time, so a file edited by hand in between refuses cleanly.
 */
export function planEdit({ file, edit, current }) {
  if (!EDITABLE.test(file)) return { ok: false, error: `${file} is not editable; only lessons.md, identity.md and routines/<key>.md are` };
  const text = current ?? "";
  const op = edit?.op;
  if (op === "append") {
    if (file !== "lessons.md") return { ok: false, error: "append is only for lessons.md; use replace for the other files" };
    const entry = String(edit.text ?? "").trim();
    if (!/^- \d{4}-\d{2}-\d{2} /.test(entry)) return { ok: false, error: 'a lesson is one line: "- YYYY-MM-DD (turns a1b2c3d4, ...): what to do here"' };
    if (entry.includes("\n")) return { ok: false, error: "a lesson is one line" };
    if (lessonLines(text).length >= MAX_LESSON_ENTRIES) return { ok: false, error: `lessons.md already has ${MAX_LESSON_ENTRIES} entries; propose removing one first` };
    const next = `${text.trim() ? `${text.replace(/\s*$/, "")}\n` : ""}${entry}\n`;
    if (next.length > LESSONS_MAX_CHARS) return { ok: false, error: `lessons.md would exceed ${LESSONS_MAX_CHARS} characters; prune first` };
    return { ok: true, next, preview: `+ ${entry}` };
  }
  if (op === "replace" || op === "remove") {
    const find = String(edit.find ?? "");
    if (!find.trim()) return { ok: false, error: "find is empty" };
    const first = text.indexOf(find);
    if (first === -1) return { ok: false, error: "find does not occur in the file as it is now; quote it exactly" };
    if (text.indexOf(find, first + 1) !== -1) return { ok: false, error: "find occurs more than once; include more context" };
    if (file.startsWith("routines/") && first < bodyStart(text)) return { ok: false, error: "the front matter of a routine is not editable; edit the brief below it" };
    const replacement = op === "remove" ? "" : String(edit.replace ?? "");
    if (op === "replace" && !replacement.trim()) return { ok: false, error: "replace is empty; use remove to delete" };
    let next = text.slice(0, first) + replacement + text.slice(first + find.length);
    if (op === "remove") next = next.replace(/\n{3,}/g, "\n\n");
    const preview = [
      ...find.split("\n").map((l) => `- ${l}`),
      ...(op === "remove" ? [] : replacement.split("\n").map((l) => `+ ${l}`)),
    ].join("\n");
    return { ok: true, next, preview };
  }
  return { ok: false, error: `unknown op "${op}"; use append, replace or remove` };
}

/** Write a planned edit, keeping the prior version. Returns the backup path. */
function writeWithHistory({ dir, file, next }) {
  const target = path.join(dir, file);
  const backups = path.join(dir, HISTORY_DIR);
  fs.mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(backups, `${file.replace(/\//g, "__")}.${stamp}`);
  if (fs.existsSync(target)) fs.copyFileSync(target, backup);
  else fs.writeFileSync(backup, "");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, next);
  return backup;
}

// ------------------------------------------------------------- the window

/** Which turns to read: everything since the last review, or seven days. */
export function windowFor(now = new Date()) {
  const since = state.get("reviewedThrough") || new Date(now.getTime() - 7 * DAY_MS).toISOString();
  return { since, until: now.toISOString() };
}

export const isFlagged = (t) =>
  Boolean(
    t.reactions?.length ||
      t.interventions?.length ||
      t.findings?.length ||
      t.output?.ungrounded ||
      t.output?.error ||
      t.errors?.length ||
      t.truncated ||
      t.output?.friction,
  );

function afterwards(t) {
  const lines = [];
  for (const r of t.reactions || []) lines.push(`${r.reaction === "up" ? "👍" : "👎"}${r.note ? ` — "${r.note}"` : ""}`);
  for (const i of t.interventions || []) lines.push(`${i.by === "other_member" ? "ANOTHER MEMBER stepped in" : "THE ASKER pushed back"}: "${i.text}"`);
  for (const f of t.findings || []) lines.push(`sweep verdict (${f.class}): ${f.note}`);
  for (const f of t.filed || []) lines.push(`filed with Elixir: ${f.summary}`);
  return lines.length ? `\nHUMAN AND SWEEP SIGNALS:\n${lines.map((l) => `- ${l}`).join("\n")}\n` : "";
}

/** Transcripts for the model: flagged turns first and in full, the rest compact, inside a char budget. */
export function renderWindow(turns, { budgetChars = WINDOW_CHARS } = {}) {
  const ordered = [...turns].sort((a, b) => (b.at > a.at ? 1 : -1));
  const flagged = ordered.filter(isFlagged);
  const plain = ordered.filter((t) => !isFlagged(t));
  const parts = [];
  let used = 0;
  let omitted = 0;
  const push = (t, full) => {
    let text = renderTurn(t, { full });
    if (full && text.length > FULL_TURN_CHARS) text = renderTurn(t, { full: false });
    text += afterwards(t);
    if (used + text.length > budgetChars) {
      omitted += 1;
      return;
    }
    parts.push(text);
    used += text.length;
  };
  for (const t of flagged) push(t, true);
  for (const t of plain) push(t, false);
  return { text: parts.join("\n\n---\n\n"), shown: parts.length, flagged: flagged.length, omitted };
}

function describePrevious(previous) {
  if (!previous) return "No previous review. There is nothing to measure yet.";
  const lines = [`Review ${previous.reviewId} at ${previous.at.slice(0, 16)}Z read ${previous.turnsRead} turns.`];
  for (const p of previous.proposals || []) {
    const decision = previous.decisions.filter((d) => d.proposalId === p.id).at(-1)?.decision ?? "no decision";
    lines.push(`- ${p.id} · ${p.file} · ${decision.toUpperCase()} · ${p.summary}${decision === "applied" || decision === "auto" ? `\n  edit: ${p.preview.replace(/\n/g, "\n  ")}` : ""}`);
  }
  if ((previous.proposals || []).length === 0) lines.push("- it proposed nothing");
  return lines.join("\n");
}

// ---------------------------------------------------------------- the turn

const SYSTEM = `You are reviewing a Discord bot's own answers, for the person who runs it.
The bot answers Clash Royale questions for one clan using ONLY the Elixir MCP
server, following instructions in text files its operator owns. You have the
full record of every turn in the window: what it was asked or briefed, what
it thought, every tool call with what came back, what it said, where it went,
and what humans did afterwards.

YOUR JOB: find what should change so next week's answers are better, and turn
each finding into a concrete edit the operator can accept with one click.

THE RUBRIC is the bot's own rules — the MECHANICS blocks (code, which you
cannot edit) and the operator's files (which you can). Grade from the trace,
not the prose:
- Grounded: every number, name and claim in the answer appears in a tool
  result body of THAT turn. A figure with no source is a defect even if right.
- Right: the bodies say what the answer says they say — window, subject,
  count, direction. A completeness note or a failed call glossed over is a
  defect.
- Answered the question asked (ask lane), not a neighbouring one.
- First contact: a whole-name single roster match linked and answered in one
  reply; anything less asked; never a guess.
- On-brief (routine lanes): did what the brief asked, posted where the brief
  and directory pointed, skipped when nothing was new, did not repeat recall.
- Voice and format: no table, no greeting, no narration of what it checked,
  no in-line self-correction, at most one emoji, plain and short.
- Economy: calls proportional to the question, no third try of a failing
  call, no live read where the record answered, not truncated.

TWO KINDS OF FAILURE, and the second matters more. A rule BROKEN: the bot did
not follow its instructions. A rule WRONG: it followed them and the outcome
was still bad — a 👎, another member stepping into the thread, the asker
pushing back, a sweep verdict of PROMPT or MECHANICS. Human signals outrank
your own reading of the rubric. Read the flagged turns first; they are shown
in full.

WHAT YOU CAN CHANGE — call propose_change, at most the number allowed:
- lessons.md (append): one dated line on how to do this job HERE — which tool
  answers which question and with what arguments, what this clan calls
  things, what a brief left out. Never a fact about the game (Elixir has
  those), never anything about a person, never a member's name or tag.
- identity.md (replace/remove): a house rule that produced bad outcomes.
- routines/<key>.md (replace/remove): a brief that asks for the wrong thing.
  The front matter is not editable.
Rules for proposals: the SMALLEST edit that fixes the pattern — diffs, never
rewrites. Each must cite at least two turns, or one turn with a human signal.
Prefer lessons.md for procedure; touch identity.md or a brief only when a
rule is wrong. Quote \`find\` text exactly as it appears in the file. If a
proposal is refused, read the error and fix it or drop it.

WHAT YOU CANNOT CHANGE: MECHANICS (code). If the fix belongs there, call
report_mechanics — it becomes a report the operator can paste into an issue.
If the fix is Elixir's (a tool's shape, a misleading note, a missing
capability), call elixir_feedback with the request ids — and if you ALSO add
a lesson that works around it, say so in the lesson so it can be dropped when
Elixir ships the fix.

MEASURE FIRST. The previous review's proposals and what the operator did with
them are listed. For each APPLIED or AUTO edit, say from the turns since
whether it did what it claimed, with turn ids and counts. If it did not,
propose reverting it (a remove or replace edit).

PRUNE. A lessons.md entry that no turn in this window needed and that is
older than 30 days gets a remove proposal, unless it is plainly still
load-bearing. Reversing something a human accepted needs a reason; say it.

YOUR FINAL TEXT IS THE REPORT the operator reads in a DM, Discord markdown,
under 1500 characters, no greeting. Three parts, in this order:
**Since last review** — the measurement, or "nothing to measure".
**This window** — turns read, how many flagged, the one pattern that
mattered most, cited by turn id.
**Proposed** — one line per proposal you made (or "nothing this week", which
is a fine outcome). Never put a member's name, id or tag in the report.`;

function proposeTool({ files, proposals, max }) {
  return {
    name: "propose_change",
    description:
      "Propose ONE edit to a file under agent/. Checked against the file as it is now; a refusal tells you why. Returns the proposal id and the diff the operator will see.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "lessons.md, identity.md, or routines/<key>.md" },
        rule: { type: "string", description: "The rule this is about, in a few words (e.g. 'first-contact identity', 'notable-movers brief')." },
        turn_ids: { type: "array", items: { type: "string" }, description: "The turns that taught this. At least two, or one with a human signal." },
        summary: { type: "string", description: "What changes and why, for the operator, under 200 characters." },
        edit: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["append", "replace", "remove"] },
            text: { type: "string", description: "append: the one-line lesson, '- YYYY-MM-DD (turns ...): ...'" },
            find: { type: "string", description: "replace/remove: the exact text to change, quoted from the file, occurring once" },
            replace: { type: "string", description: "replace: the new text" },
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
      required: ["file", "rule", "turn_ids", "summary", "edit"],
      additionalProperties: false,
    },
    async handler({ file, rule, turn_ids, summary, edit }) {
      if (proposals.length >= max) return { ok: false, code: "cap", error: `that is already ${max} proposals, the cap for one review` };
      const ids = (turn_ids || []).map(String).filter(Boolean);
      if (ids.length === 0) return { ok: false, code: "uncited", error: "cite the turn ids that taught this" };
      // The plan runs against the file plus any earlier proposal to the same
      // file this review, so two edits to lessons.md do not both claim slot 20.
      const current = proposals.filter((p) => p.file === file).at(-1)?.next ?? files[file] ?? "";
      const plan = planEdit({ file, edit, current });
      if (!plan.ok) return { ok: false, code: "refused", error: plan.error };
      const proposal = {
        id: `p${proposals.length + 1}`,
        class: "prompt",
        file,
        rule: String(rule ?? "").slice(0, 80),
        turnIds: ids.slice(0, 12),
        summary: String(summary ?? "").slice(0, 300),
        edit,
        preview: plan.preview.slice(0, 1500),
        next: plan.next,
      };
      proposals.push(proposal);
      return { ok: true, body: { proposal_id: proposal.id, file, diff: proposal.preview } };
    },
  };
}

function reportTool({ reports }) {
  return {
    name: "report_mechanics",
    description: "Report a defect in the bot's CODE-level rules or runner behaviour — something no file under agent/ can fix. The operator gets it as a pasteable issue.",
    input_schema: {
      type: "object",
      properties: {
        rule: { type: "string", description: "Which mechanics block or behaviour (e.g. WHO_IS_ASKING, the trace footer, SKIP handling)." },
        turn_ids: { type: "array", items: { type: "string" } },
        summary: { type: "string", description: "What went wrong and what should change, under 400 characters. No member names, ids or tags." },
      },
      required: ["rule", "turn_ids", "summary"],
      additionalProperties: false,
    },
    async handler({ rule, turn_ids, summary }) {
      if (reports.length >= MAX_MECHANICS_REPORTS) return { ok: false, code: "cap", error: "enough mechanics reports for one review" };
      reports.push({ rule: String(rule ?? "").slice(0, 80), turnIds: (turn_ids || []).map(String).slice(0, 12), summary: String(summary ?? "").slice(0, 400) });
      return { ok: true, body: { reported: true } };
    },
  };
}

function userMessage({ window, previous, files, rendered, lessonsCap }) {
  const fileBlocks = Object.entries(files)
    .filter(([, text]) => text !== null)
    .map(([name, text]) => `### ${name}\n\`\`\`\n${text}\n\`\`\``)
    .join("\n\n");
  const mechanics = Object.entries(MECHANICS)
    .map(([name, text]) => `### ${name}\n${text}`)
    .join("\n\n");
  return [
    `## WINDOW\n${window.since.slice(0, 16)}Z to ${window.until.slice(0, 16)}Z. ${rendered.shown} turns shown (${rendered.flagged} flagged, shown in full); ${rendered.omitted} older turns omitted for length. lessons.md may hold ${MAX_LESSON_ENTRIES} entries / ${lessonsCap} characters.`,
    `## PREVIOUS REVIEW\n${describePrevious(previous)}`,
    `## THE OPERATOR'S FILES (editable through propose_change)\n\n${fileBlocks || "(none)"}`,
    `## MECHANICS (code; report_mechanics if the fix is here)\n\n${mechanics}`,
    `## THE TURNS\n\n${rendered.text || "(no turns in the window)"}`,
  ].join("\n\n");
}

/**
 * Run one review. Reads the window, calls the model, persists the review
 * record, applies auto-lessons if configured, and returns everything the
 * caller needs to deliver it. `dryRun` reads and calls but persists nothing.
 */
export async function runReview({ trigger = "schedule", dryRun = false, askFn = ask, now = new Date(), agentDir = config.agentDir } = {}) {
  const lane = "review";
  const blocked = spendBlock(lane);
  if (blocked) {
    log.warn("review_over_budget", { reason: blocked.reason, spent: blocked.spent?.toFixed(2), budget: blocked.budget?.toFixed(2) });
    return { ok: false, error: `budget:${blocked.reason}` };
  }
  const window = windowFor(now);
  const turns = ledger.readTurns({ since: window.since.slice(0, 10) }).filter((t) => t.at > window.since && t.at <= window.until);
  const previous = ledger.readReviews({ since: new Date(now.getTime() - 90 * DAY_MS).toISOString().slice(0, 10) }).at(-1) ?? null;
  const files = readAgentFiles({ dir: agentDir });
  const rendered = renderWindow(turns);
  const proposals = [];
  const reports = [];
  const reviewId = randomUUID().slice(0, 8);

  if (turns.length === 0) {
    log.info("review_nothing_to_read", { since: window.since });
    if (!dryRun) state.set({ reviewedThrough: window.until });
    return { ok: true, reviewId, empty: true, window, turns: 0, proposals: [], reports: [], report: null, usd: 0 };
  }

  const result = await askFn({
    system: SYSTEM,
    messages: [{ role: "user", content: userMessage({ window, previous, files, rendered, lessonsCap: LESSONS_MAX_CHARS }) }],
    model: config.review.model,
    effort: config.review.effort,
    maxTokens: 16000,
    routineKey: "review",
    lane,
    localTools: [proposeTool({ files, proposals, max: config.review.maxProposals }), reportTool({ reports })],
    maxRounds: 12,
  });
  if (!result.ok) {
    log.error("review_failed", { reviewId, error: result.error });
    return { ok: false, error: result.error, reviewId };
  }

  const report = (result.text || "").trim();
  const filed = (result.trace || []).filter((s) => s.kind === "tool" && s.name.includes("elixir_feedback")).map((s) => String(s.input?.message ?? "").slice(0, 200));
  const record = ledger.reviewEntry({
    reviewId,
    trigger,
    window,
    turnsRead: turns.length,
    proposals: proposals.map(({ next, ...p }) => p),
    report,
    usd: result.usd,
    model: result.model,
  });
  record.flagged = rendered.flagged;
  record.omitted = rendered.omitted;
  record.reports = reports;
  record.filed = filed;

  const applied = [];
  if (!dryRun) {
    ledger.append(record);
    for (const summary of filed) ledger.append({ ...ledger.filedEntry({ turnId: null, summary }), reviewId });
    state.set({ reviewedThrough: window.until });
    if (config.review.autoLessons) {
      for (const p of proposals) {
        if (p.file !== "lessons.md" || p.edit?.op !== "append") continue;
        const outcome = applyProposal({ review: record, proposal: p, by: "auto", agentDir });
        if (outcome.ok) applied.push(p.id);
      }
    }
  }

  log.info("review_done", {
    reviewId,
    trigger,
    turns: turns.length,
    flagged: rendered.flagged,
    omitted: rendered.omitted,
    proposals: proposals.length,
    reports: reports.length,
    filed: filed.length,
    autoApplied: applied.length || undefined,
    usd: result.usd.toFixed(4),
    rounds: result.rounds,
    truncated: result.truncated || undefined,
    dryRun: dryRun || undefined,
  });
  return { ok: true, reviewId, window, turns: turns.length, flagged: rendered.flagged, proposals: record.proposals, reports, filed, report, usd: result.usd, autoApplied: applied, truncated: result.truncated, record };
}

// ------------------------------------------------------------ decisions

/** The review a button refers to, with its decisions. */
export function findReview(reviewId) {
  return ledger.readReviews({ since: new Date(Date.now() - 120 * DAY_MS).toISOString().slice(0, 10) }).find((r) => r.reviewId === reviewId) ?? null;
}

export function lastDecision(review, proposalId, { ignore = [] } = {}) {
  return (review?.decisions || []).filter((d) => d.proposalId === proposalId && !ignore.includes(d.decision)).at(-1) ?? null;
}

/**
 * Apply a proposal to the live file. Re-planned against the file as it is
 * NOW, so a hand edit since the review refuses instead of clobbering.
 */
export function applyProposal({ review, proposal, by, agentDir = config.agentDir }) {
  const target = path.join(agentDir, proposal.file);
  let current = null;
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    current = null;
  }
  const plan = planEdit({ file: proposal.file, edit: proposal.edit, current });
  if (!plan.ok) {
    log.warn("review_apply_refused", { reviewId: review.reviewId, proposal: proposal.id, error: plan.error });
    ledger.append(ledger.decisionEntry({ reviewId: review.reviewId, proposalId: proposal.id, decision: "refused", by, detail: plan.error }));
    return { ok: false, error: plan.error };
  }
  const backup = writeWithHistory({ dir: agentDir, file: proposal.file, next: plan.next });
  const detail = { backup, afterSha: ledger.sha(plan.next) };
  ledger.append(ledger.decisionEntry({ reviewId: review.reviewId, proposalId: proposal.id, decision: by === "auto" ? "auto" : "applied", by, detail }));
  log.info("review_applied", { reviewId: review.reviewId, proposal: proposal.id, file: proposal.file, by, backup });
  return { ok: true, file: proposal.file, backup };
}

/** Put the file back as it was before this proposal, if nothing else has touched it since. */
export function undoProposal({ review, proposal, by, agentDir = config.agentDir }) {
  // A refused re-apply does not un-apply anything: look past it.
  const decision = lastDecision(review, proposal.id, { ignore: ["refused"] });
  if (!decision || !["applied", "auto"].includes(decision.decision)) return { ok: false, error: "not applied" };
  const target = path.join(agentDir, proposal.file);
  let current = "";
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    current = "";
  }
  if (ledger.sha(current) !== decision.detail?.afterSha) return { ok: false, error: `${proposal.file} has changed since this was applied; undo by hand from ${decision.detail?.backup}` };
  const before = fs.readFileSync(decision.detail.backup, "utf8");
  writeWithHistory({ dir: agentDir, file: proposal.file, next: before });
  ledger.append(ledger.decisionEntry({ reviewId: review.reviewId, proposalId: proposal.id, decision: "reverted", by }));
  log.info("review_reverted", { reviewId: review.reviewId, proposal: proposal.id, file: proposal.file, by });
  return { ok: true };
}

export function skipProposal({ review, proposal, by }) {
  ledger.append(ledger.decisionEntry({ reviewId: review.reviewId, proposalId: proposal.id, decision: "skipped", by }));
  log.info("review_skipped", { reviewId: review.reviewId, proposal: proposal.id, by });
  return { ok: true };
}

// ------------------------------------------------------------- delivery

/** The pasteable issue body for mechanics reports. No member data by rule. */
export function mechanicsIssue(review) {
  if (!review.reports?.length) return null;
  const lines = [
    `Review ${review.reviewId} of ${review.instance ?? "an instance"} (${review.window?.since?.slice(0, 10)} to ${review.window?.until?.slice(0, 10)}, ${review.turnsRead} turns) found mechanics-level defects:`,
    "",
    ...review.reports.map((r, i) => `${i + 1}. **${r.rule}** — ${r.summary} (turns ${r.turnIds.join(", ")})`),
    "",
    `Bot build ${state.get("serverVersion") ? `against Elixir ${state.get("serverVersion")}` : ""}.`,
  ];
  return lines.join("\n");
}

export const BUTTON_PREFIX = "rv";

export function buttonId(reviewId, proposalId, action) {
  return `${BUTTON_PREFIX}:${reviewId}:${proposalId}:${action}`;
}

export function parseButtonId(customId) {
  const [prefix, reviewId, proposalId, action] = String(customId || "").split(":");
  if (prefix !== BUTTON_PREFIX || !reviewId || !proposalId || !action) return null;
  return { reviewId, proposalId, action };
}

/** Message + buttons for one proposal, as discord.js message options. */
export function proposalMessage(review, proposal, { index, total, decision = null, components = true }) {
  const status = decision
    ? { applied: "✅ Applied", auto: "✅ Applied automatically (lessons)", skipped: "⏭ Skipped", reverted: "↩️ Reverted", refused: "⚠️ Could not apply" }[decision.decision] ?? decision.decision
    : null;
  const content = [
    `**Proposal ${index} of ${total}** · \`${proposal.file}\` · ${proposal.rule}`,
    proposal.summary,
    `-# turns ${proposal.turnIds.join(", ")}`,
    "```diff",
    proposal.preview,
    "```",
    status ? `${status}${decision?.by && decision.by !== "auto" ? ` by <@${decision.by}>` : ""}${decision?.detail?.backup ? `\n-# backup: ${path.basename(decision.detail.backup)}` : ""}${decision?.decision === "refused" ? `\n-# ${decision.detail}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const buttons = [];
  if (components) {
    const applied = decision && ["applied", "auto"].includes(decision.decision);
    const done = decision && ["skipped", "reverted"].includes(decision.decision);
    if (!decision) {
      buttons.push({ id: buttonId(review.reviewId, proposal.id, "apply"), label: "Apply", style: "success" });
      buttons.push({ id: buttonId(review.reviewId, proposal.id, "skip"), label: "Skip", style: "secondary" });
    }
    if (applied) buttons.push({ id: buttonId(review.reviewId, proposal.id, "undo"), label: "Undo", style: "danger" });
    if (!done) buttons.push({ id: buttonId(review.reviewId, proposal.id, "show"), label: "Show turns", style: "secondary" });
  }
  return { content: content.slice(0, 2000), buttons };
}

function toComponents(buttons) {
  if (!buttons.length) return [];
  return [
    {
      type: 1,
      components: buttons.map((b) => ({
        type: 2,
        custom_id: b.id,
        label: b.label,
        style: { success: 3, secondary: 2, danger: 4, primary: 1 }[b.style] ?? 2,
      })),
    },
  ];
}

/** Send a finished review to every admin by DM. Returns how many were reached. */
export async function deliver({ client, review, outcome }) {
  const admins = [...config.adminUserIds];
  if (admins.length === 0) {
    log.warn("review_nobody_to_tell", { hint: "set ADMIN_USER_IDS; the review is in the ledger" });
    return 0;
  }
  const budgetLine = budget.status().find((b) => b.lane === "review");
  const header = [
    `**Review of ${review.instance}** · ${review.window.since.slice(0, 10)} → ${review.window.until.slice(0, 10)} · \`${review.reviewId}\``,
    `${review.turnsRead} turns read (${review.flagged ?? 0} flagged) · ${review.proposals.length} proposal${review.proposals.length === 1 ? "" : "s"}${review.reports?.length ? ` · ${review.reports.length} mechanics report${review.reports.length === 1 ? "" : "s"}` : ""}${review.filed?.length ? ` · ${review.filed.length} filed with Elixir` : ""} · $${Number(review.usd).toFixed(2)}${budgetLine?.budget ? ` of $${budgetLine.budget.toFixed(0)}/mo` : ""}${outcome?.truncated ? " · **TRUNCATED**" : ""}`,
  ].join("\n");
  let reached = 0;
  for (const id of admins) {
    let user;
    try {
      user = await client.users.fetch(id);
      await user.send({ content: header, allowedMentions: { parse: [] } });
      for (const part of chunk(review.report || "_(no report)_", 1900)) await user.send({ content: part, allowedMentions: { parse: [] } });
      for (const [i, p] of review.proposals.entries()) {
        const decision = lastDecision(review, p.id);
        const { content, buttons } = proposalMessage(review, p, { index: i + 1, total: review.proposals.length, decision });
        await user.send({ content, components: toComponents(buttons), allowedMentions: { parse: [] } });
      }
      const issue = mechanicsIssue(review);
      if (issue) {
        await user.send({ content: `**Mechanics** — this is the bot's code, not your files. Paste into ${REPO_ISSUES}:`, allowedMentions: { parse: [] } });
        for (const part of chunk(issue, 1900)) await user.send({ content: `\`\`\`\n${part}\n\`\`\``, allowedMentions: { parse: [] } });
      }
      reached += 1;
    } catch (error) {
      log.warn("review_dm_failed", { user: id, error: error.message, hint: "the admin may have DMs from server members off" });
    }
  }
  log.info("review_delivered", { reviewId: review.reviewId, admins: reached });
  return reached;
}

/** A button pressed on a proposal DM. Returns what happened, for the log. */
export async function handleButton(interaction, { isAdmin }) {
  const parsed = parseButtonId(interaction.customId);
  if (!parsed) return null;
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "That is for whoever runs this bot.", flags: 64 });
    return { refused: true };
  }
  const review = findReview(parsed.reviewId);
  const proposal = review?.proposals?.find((p) => p.id === parsed.proposalId);
  if (!review || !proposal) {
    await interaction.reply({ content: "I no longer have that review in the ledger.", flags: 64 });
    return { missing: true };
  }
  const by = interaction.user.id;
  const index = review.proposals.indexOf(proposal) + 1;
  const refresh = async () => {
    const fresh = findReview(parsed.reviewId);
    const { content, buttons } = proposalMessage(fresh, proposal, { index, total: fresh.proposals.length, decision: lastDecision(fresh, proposal.id) });
    await interaction.update({ content, components: toComponents(buttons) });
  };

  if (parsed.action === "show") {
    const turns = ledger.readTurns({ since: review.window.since.slice(0, 10), until: review.window.until.slice(0, 10) }).filter((t) => proposal.turnIds.includes(t.turnId)).slice(0, 3);
    const text = turns.map((t) => renderTurn(t, { full: false })).join("\n\n---\n\n") || "_(those turns are no longer in the ledger window)_";
    await interaction.reply({ content: chunk(text, 1900)[0], allowedMentions: { parse: [] } });
    for (const part of chunk(text, 1900).slice(1, 4)) await interaction.followUp({ content: part, allowedMentions: { parse: [] } });
    return { action: "show" };
  }
  const existing = lastDecision(review, proposal.id);
  if (parsed.action === "apply") {
    if (existing && ["applied", "auto"].includes(existing.decision)) {
      await refresh();
      return { action: "apply", already: true };
    }
    const outcome = applyProposal({ review, proposal, by });
    await refresh();
    return { action: "apply", ...outcome };
  }
  if (parsed.action === "skip") {
    skipProposal({ review, proposal, by });
    await refresh();
    return { action: "skip" };
  }
  if (parsed.action === "undo") {
    const outcome = undoProposal({ review, proposal, by });
    if (!outcome.ok) {
      await interaction.reply({ content: outcome.error, flags: 64 });
      return { action: "undo", ...outcome };
    }
    await refresh();
    return { action: "undo", ok: true };
  }
  return null;
}

// -------------------------------------------------------------- the clock

/** The review as a pseudo-routine for src/schedule.js. */
export function reviewRoutine() {
  return { key: "__review", trigger: "schedule", at: { hour: config.review.at.hour, minute: config.review.at.minute }, days: config.review.at.days, catchUpHours: 12, disabled: !config.review.enabled };
}

export async function tick({ client, now = new Date() }) {
  const routine = reviewRoutine();
  const due = dueRoutines([routine], { now, ledger: state.get("runs") || {} });
  if (due.length === 0) return false;
  state.markRun(routine.key, due[0].periodKey);
  const outcome = await runReview({ trigger: "schedule", now }).catch((error) => {
    log.error("review_crashed", { error: error.message });
    return { ok: false, error: error.message };
  });
  // Re-read from the ledger so auto-applied lessons carry their decisions.
  if (outcome.ok && !outcome.empty) await deliver({ client, review: findReview(outcome.reviewId) ?? outcome.record, outcome });
  return true;
}

export function startReview(client) {
  if (!config.review.enabled) return null;
  const routine = reviewRoutine();
  // Seed, never drain: a fresh install does not owe last Sunday's review.
  const runs = state.get("runs") || {};
  if (!runs[routine.key]) state.set({ runs: { ...runs, [routine.key]: periodKey(lastOccurrence(routine)) } });
  log.info("review_started", {
    model: config.review.model,
    effort: config.review.effort,
    at: `${routine.days ? routine.days.join(",") : "daily"} ${routine.at.hour}:${String(routine.at.minute).padStart(2, "0")}`,
    budget: config.review.monthlyBudgetUsd ?? "UNLIMITED",
    autoLessons: config.review.autoLessons || undefined,
    admins: config.adminUserIds.size,
  });
  const run = () => tick({ client }).catch((error) => log.error("review_tick_failed", { error: error.message }));
  void run();
  return setInterval(run, 60_000);
}
