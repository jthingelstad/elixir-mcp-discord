/**
 * PROPOSALS: one edit to one file the operator owns, checked, applied,
 * undone, rehearsed.
 *
 * This is the machinery both the review lane (src/review.js) and the
 * operator's DM (src/dm.js) put their changes through. A proposal names a
 * file under agent/ — or config.json for settings — and an edit; planEdit
 * checks it against the file AS IT IS NOW and produces the text it would
 * become and the diff the operator sees; apply re-plans (a hand edit in
 * between refuses cleanly), writes with a backup under .history/, records
 * the decision in the ledger and commits when the instance is a git repo;
 * undo restores the backup while the file is untouched; try runs the
 * routine's dry run on the proposed text.
 *
 * The fences live here: EDITABLE (three kinds of file), the front-matter
 * ops and settings only for the operator (edit.by === "owner"), a memory
 * entry's format and cap, a routine result that must parse, an operator's
 * own memory line that only they remove.
 */

import fs from "node:fs";
import path from "node:path";
import { config, instanceDir } from "./config.js";
import { MEMORY_MAX_CHARS, MEMORY_ENTRY, parseMemoryEntry } from "./prompt.js";
import { splitFrontMatter, parseRoutine, withFields, FIELDS, loadRoutines } from "./routines.js";
import { periodKey, lastOccurrence } from "./schedule.js";
import { runRoutine } from "./run.js";
import { renderTrace } from "./trace.js";
import { eventsForDryRun } from "./events.js";
import { directory, resolveById } from "./directory.js";
import {
  checkSetting,
  withSettings,
  settingsPreview,
  readConfigText,
  writeConfig,
  serviceManaged,
  restartSoon,
  needsRestart,
} from "./settings.js";
import { commitInstance } from "./instance-git.js";
import * as ledger from "./ledger.js";
import { log } from "./log.js";
import * as state from "./state.js";

const DAY_MS = 86_400_000;
const MAX_MEMORY_ENTRIES = 20;
const HISTORY_DIR = ".history";

// ---------------------------------------------------------------- the files

const EDITABLE = /^(memory\.md|identity\.md|routines\/[a-z0-9-]+\.md)$/;

/** The operator's files as the review may see and edit them. */
export function readAgentFiles({ dir = config.agentDir } = {}) {
  const files = {};
  for (const name of ["identity.md", "memory.md"]) {
    try {
      files[name] = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      files[name] = null;
    }
  }
  try {
    for (const entry of fs.readdirSync(path.join(dir, "routines"))) {
      if (entry.endsWith(".md"))
        files[`routines/${entry}`] = fs.readFileSync(path.join(dir, "routines", entry), "utf8");
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

const memoryLines = (text) => (text || "").split("\n").filter((l) => parseMemoryEntry(l));

/** Must parse as a routine, or the proposal is refused with the parser's words. */
function checkRoutine(file, next) {
  const key = file.replace(/^routines\//, "").replace(/\.md$/, "");
  try {
    parseRoutine(key, next);
    return null;
  } catch (error) {
    return String(error.message).replace(/^[^:]+: /, "");
  }
}

function fieldDiff(before, after) {
  const a = splitFrontMatter(before || "").fields || {};
  const b = splitFrontMatter(after || "").fields || {};
  const lines = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === b[k]) continue;
    if (a[k] !== undefined) lines.push(`- ${k}: ${a[k]}`);
    if (b[k] !== undefined) lines.push(`+ ${k}: ${b[k]}`);
  }
  return lines.join("\n");
}

/**
 * Check an edit against the file as it is NOW, and produce the file as it
 * would be. Pure: nothing is written. `{ ok, next, preview }` or
 * `{ ok: false, error }`. The same check runs at proposal time and again at
 * apply time, so a file edited by hand in between refuses cleanly.
 */
export function planEdit({ file, edit, current, by = null }) {
  const op = edit?.op;
  // SETTINGS. config.json keys on an allowlist, each value checked the way
  // setup checks it (src/settings.js). Never the review's.
  if (file === "config.json" || op === "set_config") {
    if (file !== "config.json" || op !== "set_config")
      return { ok: false, error: 'settings are changed with file "config.json" and op set_config' };
    if (edit?.by !== "owner")
      return { ok: false, error: "settings are the operator's; the review edits only the text under agent/" };
    if (!edit.fields || typeof edit.fields !== "object" || Object.keys(edit.fields).length === 0)
      return { ok: false, error: "fields is empty" };
    const changes = {};
    const shown = [];
    for (const [key, value] of Object.entries(edit.fields)) {
      const checked = checkSetting(String(key).toUpperCase(), value, { by });
      if (!checked.ok) return { ok: false, error: checked.error };
      changes[String(key).toUpperCase()] = checked.value;
      if (checked.shown) shown.push(`${String(key).toUpperCase()} → ${checked.shown}`);
    }
    const text = current ?? "";
    const next = withSettings(text, changes);
    const preview = settingsPreview(text, next);
    if (!preview) return { ok: false, error: "nothing would change" };
    return {
      ok: true,
      next,
      preview: shown.length ? `${preview}\n${shown.map((l) => `# ${l}`).join("\n")}` : preview,
      settings: true,
    };
  }
  if (!EDITABLE.test(file))
    return {
      ok: false,
      error: `${file} is not editable; only memory.md, identity.md, routines/<key>.md and (from the DM) config.json are`,
    };
  const text = current ?? "";
  if (op === "append" && file !== "memory.md") {
    // A house rule, a line for a brief: raw text at the end, below a
    // routine's front matter by construction.
    const added = String(edit.text ?? "").trim();
    if (!added) return { ok: false, error: "text is empty" };
    const next = `${text.replace(/\s*$/, "")}\n\n${added}\n`;
    return {
      ok: true,
      next,
      preview: added
        .split("\n")
        .map((l) => `+ ${l}`)
        .join("\n"),
    };
  }
  if (op === "append") {
    const entry = String(edit.text ?? "").trim();
    if (entry.includes("\n")) return { ok: false, error: "a memory entry is one line" };
    if (!MEMORY_ENTRY.test(entry))
      return {
        ok: false,
        error:
          'a memory entry is one line: "- YYYY-MM-DD (turns a1b2c3d4, ...): ..." or "- YYYY-MM-DD (from owner): ..." with an optional " until YYYY-MM-DD" before the colon',
      };
    if (memoryLines(text).length >= MAX_MEMORY_ENTRIES)
      return { ok: false, error: `memory.md already has ${MAX_MEMORY_ENTRIES} entries; propose removing one first` };
    const next = `${text.trim() ? `${text.replace(/\s*$/, "")}\n` : ""}${entry}\n`;
    if (next.length > MEMORY_MAX_CHARS)
      return { ok: false, error: `memory.md would exceed ${MEMORY_MAX_CHARS} characters; prune first` };
    return { ok: true, next, preview: `+ ${entry}` };
  }
  // THE OPERATOR'S OPS. Schedules, channels, models, whole routines: the
  // review never touches these (it grades answers, it does not run the
  // calendar), the operator does, by DM, and the parser refuses anything
  // the bot could not load.
  const owner = edit?.by === "owner";
  if (op === "set_fields" || op === "create" || op === "delete") {
    if (!owner) return { ok: false, error: `${op} is the operator's; the review edits only the text of a brief` };
    if (!file.startsWith("routines/")) return { ok: false, error: `${op} is for routines/<key>.md` };
  }
  if (op === "set_fields") {
    if (current === null || current === undefined) return { ok: false, error: `${file} does not exist; use create` };
    if (!edit.fields || typeof edit.fields !== "object" || Object.keys(edit.fields).length === 0)
      return { ok: false, error: "fields is empty" };
    for (const k of Object.keys(edit.fields))
      if (!FIELDS.has(String(k).toLowerCase()))
        return { ok: false, error: `"${k}" is not a routine field; the fields are ${[...FIELDS].join(", ")}` };
    const next = withFields(text, edit.fields);
    const bad = checkRoutine(file, next);
    if (bad) return { ok: false, error: bad };
    const preview = fieldDiff(text, next);
    if (!preview) return { ok: false, error: "nothing would change" };
    return { ok: true, next, preview };
  }
  if (op === "create") {
    if (current !== null && current !== undefined)
      return { ok: false, error: `${file} already exists; use set_fields or replace` };
    if (!edit.fields || typeof edit.fields !== "object")
      return { ok: false, error: "create needs fields (at least trigger) and text (the brief)" };
    for (const k of Object.keys(edit.fields))
      if (!FIELDS.has(String(k).toLowerCase()))
        return { ok: false, error: `"${k}" is not a routine field; the fields are ${[...FIELDS].join(", ")}` };
    if (!String(edit.text ?? "").trim()) return { ok: false, error: "the brief (text) is empty" };
    const next = withFields("", edit.fields, String(edit.text));
    const bad = checkRoutine(file, next);
    if (bad) return { ok: false, error: bad };
    return {
      ok: true,
      next,
      preview: next
        .split("\n")
        .map((l) => `+ ${l}`)
        .join("\n"),
      created: true,
    };
  }
  if (op === "delete") {
    if (current === null || current === undefined) return { ok: false, error: `${file} does not exist` };
    return {
      ok: true,
      next: null,
      preview: text
        .split("\n")
        .map((l) => `- ${l}`)
        .join("\n"),
      deleted: true,
    };
  }
  if (op === "replace" || op === "remove") {
    const find = String(edit.find ?? "");
    if (!find.trim()) return { ok: false, error: "find is empty" };
    const first = text.indexOf(find);
    if (first === -1) return { ok: false, error: "find does not occur in the file as it is now; quote it exactly" };
    if (text.indexOf(find, first + 1) !== -1)
      return { ok: false, error: "find occurs more than once; include more context" };
    if (file.startsWith("routines/") && first < bodyStart(text))
      return { ok: false, error: "the front matter of a routine is not editable; edit the brief below it" };
    const replacement = op === "remove" ? "" : String(edit.replace ?? "");
    if (op === "replace" && !replacement.trim()) return { ok: false, error: "replace is empty; use remove to delete" };
    let next = text.slice(0, first) + replacement + text.slice(first + find.length);
    if (op === "remove") next = next.replace(/\n{3,}/g, "\n\n");
    // What the operator said is theirs to remove, never the review's.
    if (
      file === "memory.md" &&
      op === "remove" &&
      edit.by !== "owner" &&
      find.split("\n").some((l) => parseMemoryEntry(l)?.source === "owner")
    ) {
      return { ok: false, error: "that entry came from the operator; only they remove it" };
    }
    const preview = [
      ...find.split("\n").map((l) => `- ${l}`),
      ...(op === "remove" ? [] : replacement.split("\n").map((l) => `+ ${l}`)),
    ].join("\n");
    return { ok: true, next, preview };
  }
  return { ok: false, error: `unknown op "${op}"; use append, replace, remove, set_fields, create or delete` };
}

/** Write a planned edit, keeping the prior version. `next === null` deletes.
 *  Returns the backup path. */
function writeWithHistory({ dir, file, next }) {
  const target = path.join(dir, file);
  const backups = path.join(dir, HISTORY_DIR);
  fs.mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(backups, `${file.replace(/\//g, "__")}.${stamp}`);
  if (fs.existsSync(target)) fs.copyFileSync(target, backup);
  else fs.writeFileSync(backup, "");
  if (next === null) {
    fs.rmSync(target, { force: true });
    return backup;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, next);
  return backup;
}

// ------------------------------------------------------------ decisions

/** The review a button refers to, with its decisions. */
export function findReview(reviewId) {
  return (
    ledger
      .readReviews({ since: new Date(Date.now() - 120 * DAY_MS).toISOString().slice(0, 10) })
      .find((r) => r.reviewId === reviewId) ?? null
  );
}

export function lastDecision(review, proposalId, { ignore = [] } = {}) {
  return (
    (review?.decisions || []).filter((d) => d.proposalId === proposalId && !ignore.includes(d.decision)).at(-1) ?? null
  );
}

/**
 * Apply a proposal to the live file. Re-planned against the file as it is
 * NOW, so a hand edit since the review refuses instead of clobbering.
 */
export function applyProposal({ review, proposal, by, agentDir = config.agentDir }) {
  if (proposal.file === "config.json") return applySettings({ review, proposal, by });
  const target = path.join(agentDir, proposal.file);
  let current = null;
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    current = null;
  }
  const plan = planEdit({ file: proposal.file, edit: proposal.edit, current, by });
  if (!plan.ok) {
    log.warn("review_apply_refused", { reviewId: review.reviewId, proposal: proposal.id, error: plan.error });
    ledger.append(
      ledger.decisionEntry({
        reviewId: review.reviewId,
        proposalId: proposal.id,
        decision: "refused",
        by,
        detail: plan.error,
      }),
    );
    return { ok: false, error: plan.error };
  }
  const backup = writeWithHistory({ dir: agentDir, file: proposal.file, next: plan.next });
  const detail = {
    backup,
    afterSha: plan.next === null ? null : ledger.sha(plan.next),
    created: plan.created || undefined,
    deleted: plan.deleted || undefined,
  };
  // A routine whose clock moved must not fire the moment it is saved: the
  // new period is marked done, as a fresh install's would be. Same for a
  // new routine whose time is already past today.
  if (
    proposal.file.startsWith("routines/") &&
    plan.next !== null &&
    (plan.created || proposal.edit?.fields?.at !== undefined || proposal.edit?.fields?.days !== undefined)
  ) {
    try {
      const key = proposal.file.replace(/^routines\//, "").replace(/\.md$/, "");
      const parsed = parseRoutine(key, plan.next);
      if (parsed.trigger === "schedule") state.markRun(key, periodKey(lastOccurrence(parsed)));
    } catch {
      /* the plan already parsed it; nothing to seed otherwise */
    }
  }
  ledger.append(
    ledger.decisionEntry({
      reviewId: review.reviewId,
      proposalId: proposal.id,
      decision: by === "auto" ? "auto" : "applied",
      by,
      detail,
    }),
  );
  log.info("review_applied", { reviewId: review.reviewId, proposal: proposal.id, file: proposal.file, by, backup });
  if (repoFor(agentDir))
    void commitInstance({
      message: commitMessage(proposal),
      body: commitBody(review, proposal, by),
      dir: repoFor(agentDir),
    });
  return { ok: true, file: proposal.file, backup };
}

/** The instance to commit in: only when the files written live inside it. */
function repoFor(agentDir) {
  return path.resolve(agentDir).startsWith(path.resolve(instanceDir) + path.sep) ? instanceDir : null;
}

/** The commit message is the proposal's summary; the body says where it came from. */
function commitMessage(proposal) {
  const summary = String(proposal.summary || "")
    .trim()
    .replace(/\s+/g, " ");
  const verb =
    {
      append: "Add to",
      replace: "Change",
      remove: "Remove from",
      set_fields: "Reschedule",
      create: "Create",
      delete: "Retire",
      set_config: "Settings",
    }[proposal.edit?.op] ?? "Change";
  return summary ? summary.slice(0, 120) : `${verb} ${proposal.file}`;
}

function commitBody(review, proposal, by) {
  return [
    `file: ${proposal.file} · op: ${proposal.edit?.op ?? "?"} · proposal ${proposal.id} of ${review.trigger === "dm" ? "a DM" : `review ${review.reviewId}`}`,
    proposal.turnIds?.length ? `turns: ${proposal.turnIds.join(", ")}` : null,
    `applied by: ${by === "auto" ? "the review (auto)" : `discord:${by}`}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Settings: re-checked against config.json as it is NOW, written with a
 *  backup, then a restart when a supervisor will bring the bot back. */
function applySettings({ review, proposal, by }) {
  const current = readConfigText();
  const plan = planEdit({ file: "config.json", edit: proposal.edit, current, by });
  if (!plan.ok) {
    log.warn("review_apply_refused", { reviewId: review.reviewId, proposal: proposal.id, error: plan.error });
    ledger.append(
      ledger.decisionEntry({
        reviewId: review.reviewId,
        proposalId: proposal.id,
        decision: "refused",
        by,
        detail: plan.error,
      }),
    );
    return { ok: false, error: plan.error };
  }
  const backup = writeConfig(plan.next);
  const keys = Object.keys(proposal.edit.fields || {});
  const restart = !needsRestart(keys) ? "none" : serviceManaged() ? "automatic" : "needed";
  ledger.append(
    ledger.decisionEntry({
      reviewId: review.reviewId,
      proposalId: proposal.id,
      decision: "applied",
      by,
      detail: { backup, afterSha: ledger.sha(plan.next), settings: true, restart },
    }),
  );
  log.info("settings_applied", { reviewId: review.reviewId, proposal: proposal.id, keys: keys.join(","), by, restart });
  // Commit before a restart, so the history has it even if the exit is quick.
  void commitInstance({ message: commitMessage(proposal), body: commitBody(review, proposal, by) }).then(() => {
    if (restart === "automatic") restartSoon();
  });
  return { ok: true, file: "config.json", backup, restart };
}

/** Put the file back as it was before this proposal, if nothing else has touched it since. */
export function undoProposal({ review, proposal, by, agentDir = config.agentDir }) {
  if (proposal.file === "config.json") {
    const decision = lastDecision(review, proposal.id, { ignore: ["refused"] });
    if (!decision || decision.decision !== "applied") return { ok: false, error: "not applied" };
    if (ledger.sha(readConfigText()) !== decision.detail?.afterSha)
      return { ok: false, error: `config.json has changed since; restore by hand from ${decision.detail?.backup}` };
    writeConfig(fs.readFileSync(decision.detail.backup, "utf8"));
    const restart = !needsRestart(Object.keys(proposal.edit?.fields || {}))
      ? "none"
      : serviceManaged()
        ? "automatic"
        : "needed";
    ledger.append(
      ledger.decisionEntry({
        reviewId: review.reviewId,
        proposalId: proposal.id,
        decision: "reverted",
        by,
        detail: { restart },
      }),
    );
    log.info("settings_reverted", { reviewId: review.reviewId, proposal: proposal.id, by, restart });
    void commitInstance({ message: `Undo: ${commitMessage(proposal)}`, body: commitBody(review, proposal, by) }).then(
      () => {
        if (restart === "automatic") restartSoon();
      },
    );
    return { ok: true, restart };
  }
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
  const exists = fs.existsSync(target);
  if (decision.detail?.deleted ? exists : ledger.sha(current) !== decision.detail?.afterSha)
    return {
      ok: false,
      error: `${proposal.file} has changed since this was applied; undo by hand from ${decision.detail?.backup}`,
    };
  const before = fs.readFileSync(decision.detail.backup, "utf8");
  // Undoing a create removes the file; undoing anything else restores it.
  writeWithHistory({ dir: agentDir, file: proposal.file, next: decision.detail?.created ? null : before });
  ledger.append(ledger.decisionEntry({ reviewId: review.reviewId, proposalId: proposal.id, decision: "reverted", by }));
  log.info("review_reverted", { reviewId: review.reviewId, proposal: proposal.id, file: proposal.file, by });
  if (repoFor(agentDir))
    void commitInstance({
      message: `Undo: ${commitMessage(proposal)}`,
      body: commitBody(review, proposal, by),
      dir: repoFor(agentDir),
    });
  return { ok: true };
}

/**
 * TRY IT: run a routine's dry run on the PROPOSED file, before applying.
 * A diff is an opinion; the post it would have produced is evidence. For a
 * routine proposal, the routine is the edited one; for identity.md or
 * memory.md, the routine of the first cited turn (or the first scheduled
 * routine) runs with the proposed text in its prompt. Charged to the
 * review lane. Nothing is applied and nothing is posted.
 */
export async function tryProposal({ proposal, agentDir = config.agentDir, runFn = runRoutine }) {
  const current = (() => {
    try {
      return fs.readFileSync(path.join(agentDir, proposal.file), "utf8");
    } catch {
      return null;
    }
  })();
  const plan = planEdit({ file: proposal.file, edit: proposal.edit, current, by: "owner" });
  if (!plan.ok) return { ok: false, error: plan.error };
  if (plan.next === null) return { ok: false, error: "nothing to rehearse for a deletion" };

  let routine = null;
  const overrides = {};
  if (proposal.file.startsWith("routines/")) {
    const key = proposal.file.replace(/^routines\//, "").replace(/\.md$/, "");
    try {
      routine = { ...parseRoutine(key, plan.next), disabled: false };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  } else {
    if (proposal.file === "identity.md") overrides.identity = plan.next.trim() || null;
    if (proposal.file === "memory.md") overrides.memory = plan.next.trim() || null;
    const { routines } = loadRoutines({ dir: agentDir });
    const cited = ledger
      .readTurns({ since: new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10) })
      .find((t) => proposal.turnIds?.includes(t.turnId) && t.trigger !== "message");
    routine =
      routines.find((r) => r.key === cited?.routine && r.trigger !== "message") ??
      routines.find((r) => r.trigger === "schedule" && !r.disabled) ??
      null;
    if (!routine) return { ok: false, error: "no scheduled routine to rehearse this on" };
  }
  if (routine.trigger === "message")
    return {
      ok: false,
      error: `${routine.key} answers questions; ask it something in the ask channel to see the change`,
    };

  const entries = directory();
  const defaultId = routine.channel
    ? (config.channels.get(routine.channel) ?? entries.find((e) => e.name === routine.channel)?.id ?? null)
    : null;
  const channel = defaultId ? await resolveById(defaultId) : null;
  let events = null;
  if (routine.trigger === "events") {
    const found = await eventsForDryRun(routine);
    events = found.events;
  }
  const run = await runFn(routine, { channel, events, dryRun: true, entries, overrides, lane: "review" });
  if (!run.ok) return { ok: false, error: run.error };
  return {
    ok: true,
    routine: routine.key,
    skipped: run.skipped,
    posts: run.posts,
    text: run.text,
    trace: renderTrace(run.result, { label: `${routine.key} · with ${proposal.id}` }),
    usd: run.result.usd,
  };
}

export function skipProposal({ review, proposal, by }) {
  ledger.append(ledger.decisionEntry({ reviewId: review.reviewId, proposalId: proposal.id, decision: "skipped", by }));
  log.info("review_skipped", { reviewId: review.reviewId, proposal: proposal.id, by });
  return { ok: true };
}

export { withFields };
