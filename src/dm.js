/**
 * THE OPERATOR'S CONSOLE — a direct message with whoever runs this bot.
 *
 * Channels are for members. The DM is for the operator, and it is the one
 * place the bot talks ABOUT itself rather than about Clash Royale: review
 * proposals arrive here (src/review.js), notices arrive here (src/notify.js),
 * and this file is the conversation half. From a phone, with no terminal:
 *
 *   tell it something      "we call war days boat days" — the bot proposes a
 *                          memory.md line with an Apply button; live on tap
 *   ask why                "why d98fe553", or paste a message link — the turn's
 *                          transcript, what it thought, what the tools said
 *   try before posting     "try notable-movers" — the routine's dry run,
 *                          shown to you only; "post it" sends it
 *   ask as yourself        anything about the record, answered on your behalf,
 *                          without cluttering the ask channel
 *   run the calendar       "routines"; "move the movers post to 7:30", "add a
 *                          Friday war recap in #war" — a proposal on the
 *                          routine's file, parser-checked, live on Apply
 *   see what it knows      "memory" — the current memory.md, with expiry
 *   see the money          "budget"
 *
 * Admin-only (ADMIN_USER_IDS). Anyone else gets one polite line a day. What
 * the operator says is trusted more than a member's words and still never
 * executes anything by itself: a fact becomes a PROPOSAL with a button, so
 * the exact wording that will ride every prompt is seen before it does.
 *
 * What it never does: post to a member channel from here. There is no
 * post_message tool in this lane; "post it" sends a dry run the operator has
 * already read, to the channels the routine itself chose.
 *
 * Model turns are charged to the review lane — the operator's own pot for
 * the bot's upkeep. Every turn is ledgered (lane "dm"), so the review sees
 * these conversations too.
 */

import path from "node:path";
import { config, repoRoot } from "./config.js";
import { catalog } from "./setup-catalog.js";
import { notify } from "./notify.js";
import { ask, spendBlock } from "./claude.js";
import { systemFor, nowLine, readMemory, parseMemoryEntry, MEMORY_MAX_CHARS } from "./prompt.js";
import { loadRoutines } from "./routines.js";
import { runRoutine } from "./run.js";
import { directory, resolveById } from "./directory.js";
import { post, chunk } from "./post.js";
import { renderTrace } from "./trace.js";
import { renderTurn } from "./turns.js";
import { budgetReply, routinesReply } from "./commands.js";
import { FIELDS, splitFrontMatter } from "./routines.js";
import { SETTINGS, readConfigText, describeSettings, serviceManaged } from "./settings.js";
import { estimateMonthly } from "./setup-catalog.js";
import { parseRoutine } from "./routines.js";
import { buildId } from "./build.js";
import { callTool } from "./mcp.js";
import * as budget from "./budget.js";
import { deckLinkTool } from "./deck-link.js";
import { planEdit, proposalMessage, toComponents, readAgentFiles } from "./review.js";
import { isConversational } from "./ask.js";
import { turnRecord } from "./run.js";
import * as ledger from "./ledger.js";
import { log } from "./log.js";
import * as state from "./state.js";

const DAY_MS = 86_400_000;
const HISTORY_TURNS = 8;
const MAX_PROPOSALS = 3;

export const isAdmin = (userId) => config.adminUserIds.has(String(userId));

/** What the DM lane is for, in the model's terms. Rides after the house rules
 *  and memory, as the routine's own brief would. */
export const DM_BRIEF = `You are talking to the person who runs you, by direct message. Nobody else
sees this. Their id is the one on each message; when they ask about
themselves, that id is on_behalf_of. They may do four things:

ASK ABOUT THE RECORD. Answer as you would in the ask channel, with the tools.

TELL YOU SOMETHING TO REMEMBER — what this clan calls things, what they want
kept in mind, how they want a routine to behave. Call propose_change on
memory.md with ONE line in their words: "- YYYY-MM-DD (from owner): ...".
When it is true for a while ("this week", "until the season ends"), add
" until YYYY-MM-DD" before the colon, working the date out from today. When
it is a rule about how you speak or what a routine posts, propose the edit
to identity.md or that routine's brief instead. Nothing is written until
they press Apply; say so in one line and stop. Do not write the proposal
into your reply — the diff is sent separately.

ASK YOU TO FORGET: propose removing that line from memory.md. Ask "memory"
to see the current lines if you need the exact text.

SET IT UP, the first time. When list_routines is empty the bot does
nothing yet. Call list_example_routines (the shipped set, each with its
fields and full brief) and list_channels (where the bot may post, and the
ask channel). Offer the examples in a few lines each; if they say "the
usual", propose create for ask, clan-feed, notable-movers and
war-deck-check with the example's own fields and brief, times moved to
their evening if they said one. Propose the ask routine first — it is
what makes the ask channel answer. Three proposals per message; say what
else is on offer. Then ask about the clan: what they call things, what to
keep in mind — memory.md lines. This is also how a new routine is written
later: start from the nearest example's brief and change what differs.

CHANGE A SETTING — a budget, the default model or effort, the review's
day and time or whether it is on, the timezone, how often the feed is
read, the ask channel, who is an admin. propose_change with file
"config.json", op set_config and fields {KEY: value}: the keys and what each means are in
the tool's description; "settings" shows the current values. A channel
may be given as #name. Each value is checked the way setup checks it.
Applying rewrites config.json; nearly everything is live at once. The
two that are not (the command prefix, the feed poll interval) restart the
bot, which says so and is back in under a minute; if it is not running
as a service the operator restarts it. Never a token or a key (those are in .env, not here) and
never the Elixir URL or the app and server ids — those are wiring.

ADD TO A FILE: op append works on identity.md and a routine's brief too —
raw text at the end — for "add a house rule" or "also mention X".

MANAGE THE ROUTINES — what runs, when, where, and what it says. Call
list_routines first; it returns every routine with its fields and its
brief. Then propose_change on routines/<key>.md:
- set_fields to change when it runs (at: HH:MM in the operator's zone,
  days: mon,thu), where it posts (channel), which model, whether it is on
  (enabled: false), whether it may skip, how much it recalls.
- replace / remove to change the brief's wording (quote it exactly).
- create for a new routine: fields (trigger: schedule needs at:; events
  needs kinds: or sections:; message needs channel:) and text, the brief,
  written in the same style as the existing ones — plain, one job, says
  where to post and when to post nothing. Ask what it should do, where and
  when if they did not say; one question, then propose.
- delete to remove one (a copy is kept).
Every proposal is checked the way the bot loads the file; a refusal tells
you what the parser said — fix it or tell them. Nothing changes until they
press Apply; after that it is live on the next tick, no restart. They can
say "try <key>" to rehearse it.

ASK HOW YOU ARE DOING: call status — budgets, turns, the review, cursors.
Say the numbers plainly.

ASK WHAT HAPPENED: search_turns finds your earlier turns by text, lane,
routine and date ("did anyone ask about war decks this week?"); lookup_turn
shows one in full. estimate_cost says what a routine would cost before you
propose creating it — include that in the summary.

ASK WHY YOU SAID SOMETHING. Call lookup_turn with the turn id they gave (the
footer under every answer shows it). Say what the trace shows, plainly —
what you were asked, what the tools returned, where the answer came from —
and if it was wrong, what you would change, as a proposal.

WHAT YOU DO NOT REMEMBER, whoever asks: facts about the game — a member's
trophies, who is in the clan, what happened in war. Elixir has those; say
which tool answers it. Anything about a person beyond the role Elixir
already shows — an absence, a mood, a dispute — belongs with the clan's
leaders in Elixir Clan, not in your prompt; say so kindly.

You cannot post to a channel from here. If they want something posted, tell
them: "try <routine>" shows you the post; "post it" sends it.`;

const dmRoutine = () => ({
  key: "dm",
  trigger: "message",
  channel: null,
  prompt: DM_BRIEF,
  model: config.claude.model,
  effort: config.claude.effort,
  maxChars: 2000,
  maxTokens: 6000,
  historyTurns: HISTORY_TURNS,
  trace: true,
});

// -------------------------------------------------------------- helpers

/** A paste over 2,000 characters arrives as a `message.txt` attachment, not
 *  as text; Discord does that on its own. Read text attachments so a pasted
 *  FAQ is the message. Only text, only the operator's own upload from
 *  Discord's CDN, bounded — this is not web access. */
const ATTACHMENT_MAX_BYTES = 200_000;
const ATTACHMENT_MAX_CHARS = 60_000;

export async function attachedText(message, { fetchFn = fetch } = {}) {
  const parts = [];
  for (const a of message.attachments?.values?.() ?? []) {
    const type = String(a.contentType ?? "").toLowerCase();
    const name = String(a.name ?? "");
    if (!(type.startsWith("text/") || /\.(txt|md|markdown|csv)$/i.test(name))) continue;
    if ((a.size ?? 0) > ATTACHMENT_MAX_BYTES) {
      parts.push(`[${name}: ${a.size} bytes, too large to read — paste the part that matters]`);
      continue;
    }
    try {
      const res = await fetchFn(a.url, { signal: AbortSignal.timeout(10_000) });
      const text = (await res.text()).slice(0, ATTACHMENT_MAX_CHARS);
      parts.push(`--- ${name} ---\n${text}`);
    } catch (error) {
      log.warn("dm_attachment_unread", { name, error: error.message });
      parts.push(`[${name}: could not be read]`);
    }
  }
  return parts.join("\n\n");
}

function turnIdIn(text) {
  const link = /discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d+)/.exec(text);
  if (link) return state.turnForMessage(link[1])?.turnId ?? null;
  const id = /\b([0-9a-f]{8})\b/i.exec(text);
  return id ? id[1].toLowerCase() : null;
}

function findTurn(turnId) {
  if (!turnId) return null;
  const since = new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);
  return ledger.readTurns({ since }).find((t) => t.turnId === turnId) ?? null;
}

async function send(message, text) {
  for (const part of chunk(text || "(nothing)", 1900)) await message.channel.send({ content: part, allowedMentions: { parse: [] } });
}

async function dmHistory(channel, beforeId) {
  try {
    const fetched = await channel.messages.fetch({ limit: HISTORY_TURNS * 3, before: beforeId });
    const history = [];
    for (const m of [...fetched.values()].reverse()) {
      if (!isConversational(m)) continue;
      history.push({ role: m.author.bot ? "assistant" : "user", content: m.author.bot ? m.cleanContent.trim() : `${m.author.username} (discord:${m.author.id}): ${m.cleanContent.trim()}` });
    }
    while (history.length && history[0].role !== "user") history.shift();
    return history.slice(-HISTORY_TURNS);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- commands

async function why(message, text) {
  const turnId = turnIdIn(text);
  const turn = findTurn(turnId);
  if (!turn) {
    await send(message, turnId ? `I have no turn \`${turnId}\` in the last 60 days of the ledger.` : "Give me a turn id (the footer under an answer shows it) or paste a link to the message.");
    return;
  }
  const full = /\bfull\b/i.test(text);
  const rendered = renderTurn(turn, { full });
  const parts = chunk(rendered, 1900);
  for (const part of parts.slice(0, full ? 8 : 4)) await message.channel.send({ content: part, allowedMentions: { parse: [] } });
  if (parts.length > (full ? 8 : 4)) await send(message, `-# ${parts.length - (full ? 8 : 4)} more part(s) not shown; \`npm run turns -- --turn ${turnId}\` has it all.`);
  log.info("dm_why", { user: message.author.id, turnId });
}

/** Drafts from "try", per operator, in memory only: a draft outlives nothing. */
const drafts = new Map();

async function tryRoutine(message, key, { runFn = runRoutine } = {}) {
  const routine = loadRoutines().routines.find((r) => r.key === key);
  if (!routine) {
    await send(message, `No routine called \`${key}\`. The ones I have: ${loadRoutines().routines.map((r) => `\`${r.key}\``).join(", ") || "none"}.`);
    return;
  }
  if (routine.trigger === "message") {
    await send(message, `\`${key}\` answers questions; there is nothing to try. Ask me something instead.`);
    return;
  }
  const entries = directory();
  const defaultId = routine.channel ? config.channels.get(routine.channel) ?? entries.find((e) => e.name === routine.channel)?.id ?? null : null;
  const channel = defaultId ? await resolveById(defaultId) : null;
  await send(message, `-# running \`${key}\` as a rehearsal — nothing is posted…`);
  const run = await runFn(routine, { channel, dryRun: true, entries });
  if (!run.ok) {
    await send(message, `\`${key}\` failed: ${run.error}`);
    return;
  }
  if (run.skipped || run.posts.length === 0) {
    await send(message, `\`${key}\` would post nothing${run.text && !run.skipped ? `:\n\n${run.text}` : " (SKIP)"}.`);
    drafts.delete(message.author.id);
    return;
  }
  drafts.set(message.author.id, { key, routine, run, at: Date.now() });
  const shown = run.posts.map((p) => `**${p.channel}**\n${p.text}`).join("\n\n");
  await send(message, shown);
  const trace = renderTrace(run.result, { label: key });
  if (trace) await send(message, trace);
  await send(message, `-# $${run.result.usd.toFixed(4)} · say **post it** to send this to ${run.posts.map((p) => p.channel).join(", ")}, or try again after editing the routine.`);
  log.info("dm_try", { user: message.author.id, routine: key, posts: run.posts.length });
}

async function postDraft(message, { postFn = post } = {}) {
  const draft = drafts.get(message.author.id);
  if (!draft) {
    await send(message, "Nothing to post. Say `try <routine>` first.");
    return;
  }
  if (Date.now() - draft.at > 2 * 3600 * 1000) {
    drafts.delete(message.author.id);
    await send(message, "That draft is over two hours old; try it again so you post what the record says now.");
    return;
  }
  const { routine, run } = draft;
  const entries = directory();
  const posted = [];
  for (const p of run.posts) {
    const entry = entries.find((e) => `#${e.name}` === p.channel);
    const channel = entry ? await resolveById(entry.id) : null;
    if (!channel) {
      await send(message, `${p.channel} is not in my directory any more; skipped.`);
      continue;
    }
    const messages = await postFn(channel, p.text, routine.maxChars);
    posted.push({ channelId: entry.id, channelName: entry.name, messageIds: messages.map((m) => m?.id).filter(Boolean), text: p.text });
    state.rememberPost(routine.key, run.posts.length > 1 ? `[${p.channel}] ${p.text}` : p.text);
  }
  drafts.delete(message.author.id);
  if (posted.length) {
    const text = posted.map((p) => p.text).join("\n\n");
    state.rememberTurn(run.result.turnId, turnRecord({ routine, lane: "routines", question: routine.prompt, text, result: run.result, channelId: posted.at(-1).channelId }), posted.flatMap((p) => p.messageIds));
    ledger.append(
      ledger.turnEntry({
        routine,
        lane: "routines",
        result: run.result,
        system: null,
        contractVersion: state.get("contractVersion"),
        input: { kind: routine.trigger, brief: routine.prompt, postedBy: message.author.id, viaDm: true },
        output: { text, posts: posted, skipped: false, footers: [], ungrounded: false, friction: null },
      }),
    );
  }
  await send(message, posted.length ? `Posted to ${posted.map((p) => `#${p.channelName}`).join(", ")}.` : "Nothing was posted.");
  log.info("dm_posted_draft", { user: message.author.id, routine: routine.key, posts: posted.length });
}

/** What this bot has filed with Elixir's maintainer, and the answers. */
async function showFeedback(message) {
  const result = await callTool("elixir_my_feedback", {});
  if (!result.ok) {
    await send(message, `Could not read the feedback ledger: ${result.error}`);
    return;
  }
  const items = result.body?.items || result.body?.feedback || [];
  if (items.length === 0) {
    await send(message, "Nothing filed yet.");
    return;
  }
  const lines = items.slice(0, 12).map((item) => {
    const id = item.feedback_id ?? item.id;
    const response = item.response ?? item.maintainer_response;
    const when = String(item.created_at ?? item.filed_at ?? "").slice(0, 10);
    return `**#${id}** ${when} · ${item.category ?? ""} · ${item.status ?? (response ? "answered" : "open")}\n> ${String(item.message ?? "").slice(0, 240).replace(/\n/g, " ")}${response ? `\n↳ ${String(response).slice(0, 300).replace(/\n/g, " ")}` : ""}`;
  });
  await send(message, `**Feedback** (${items.length} filed; newest ${Math.min(12, items.length)} shown)\n\n${lines.join("\n\n")}`);
}

async function showMemory(message) {
  const files = readAgentFiles();
  const raw = files["memory.md"];
  if (!raw || !raw.split("\n").some((l) => parseMemoryEntry(l))) {
    await send(message, "Memory is empty. Tell me something to remember, or wait for the review.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const lines = raw
    .split("\n")
    .map((l) => parseMemoryEntry(l))
    .filter(Boolean)
    .map((e) => `${e.until && e.until < today ? "~~" : ""}${e.date} · ${e.source === "owner" ? "you" : `turns ${e.turns.join(", ")}`}${e.until ? ` · until ${e.until}` : ""} — ${e.text}${e.until && e.until < today ? "~~ (expired)" : ""}`);
  const live = readMemory();
  await send(message, `**Memory** (${live ? live.length : 0} of ${MEMORY_MAX_CHARS} characters in the prompt)\n${lines.map((l) => `- ${l}`).join("\n")}`);
}

// ---------------------------------------------------------- the model

function proposeTool({ files, proposals, by, operatorId = null }) {
  return {
    name: "propose_change",
    description:
      "Propose ONE edit to memory.md, identity.md or routines/<key>.md, in the operator's words. Checked against the file as it is now (a routine must parse); a refusal says why. The operator gets it as a diff with an Apply button.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "memory.md, identity.md, routines/<key>.md (key: lowercase letters, digits, hyphens), or config.json for settings" },
        summary: { type: "string", description: "One line for the operator: what this remembers or changes." },
        edit: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["append", "replace", "remove", "set_fields", "create", "delete", "set_config"] },
            text: { type: "string", description: "append to memory.md: '- YYYY-MM-DD (from owner)[ until YYYY-MM-DD]: their words'; append elsewhere: the text. create: the routine's brief." },
            find: { type: "string", description: "replace/remove: exact text occurring once" },
            replace: { type: "string" },
            fields: {
              type: "object",
              description: `set_fields/create: front matter as strings — ${[...FIELDS].join(", ")}; an empty string removes a field. set_config: settings — ${Object.entries(SETTINGS).map(([k, v]) => `${k} (${v.about})`).join("; ")}; CHANNEL_<NAME> (a #name or id the bot is granted in); empty string unsets.`,
              additionalProperties: { type: "string" },
            },
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
      required: ["file", "summary", "edit"],
      additionalProperties: false,
    },
    async handler({ file, summary, edit }) {
      if (proposals.length >= MAX_PROPOSALS) return { ok: false, code: "cap", error: `${MAX_PROPOSALS} proposals is enough for one message` };
      if (file === "memory.md" && edit?.op === "append" && !/\(from owner\)/.test(String(edit.text ?? ""))) {
        return { ok: false, code: "provenance", error: 'a memory entry from this conversation is "- YYYY-MM-DD (from owner): ..."' };
      }
      const current = proposals.filter((p) => p.file === file).at(-1)?.next ?? (file === "config.json" ? readConfigText() : files[file] ?? null);
      const plan = planEdit({ file, edit: { ...edit, by }, current, by: operatorId });
      if (!plan.ok) return { ok: false, code: "refused", error: plan.error };
      const proposal = { id: `p${proposals.length + 1}`, class: file === "config.json" ? "settings" : "prompt", file, rule: file === "config.json" ? "settings" : "from the operator", turnIds: [], summary: String(summary ?? "").slice(0, 300), edit: { ...edit, by }, preview: plan.preview.slice(0, 1500), next: plan.next };
      proposals.push(proposal);
      return { ok: true, body: { proposal_id: proposal.id, diff: proposal.preview } };
    },
  };
}

function routinesTool() {
  return {
    name: "list_routines",
    description: "Every routine this bot runs: key, trigger, when, where it posts, model, whether it is enabled, its description and its brief. Read this before proposing a change to one.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const { routines, errors } = loadRoutines();
      return {
        ok: true,
        body: {
          timezone: config.timezone,
          routines: routines.map((r) => ({
            key: r.key,
            file: `routines/${r.key}.md`,
            trigger: r.trigger,
            enabled: !r.disabled,
            channel: r.channel,
            at: r.at ? `${String(r.at.hour).padStart(2, "0")}:${String(r.at.minute).padStart(2, "0")}` : undefined,
            days: r.days?.map((d) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d]),
            kinds: r.kinds ?? undefined,
            sections: r.sections ?? undefined,
            may_skip: r.maySkip,
            recall: r.recall,
            model: r.model,
            effort: r.effort,
            description: r.description,
            brief: r.prompt,
          })),
          failed_to_load: errors,
        },
      };
    },
  };
}

function examplesTool() {
  return {
    name: "list_example_routines",
    description: "The routines this bot ships as examples — each with its fields and its full brief — to offer when setting up, and to start from when writing a new one.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const entries = catalog({ exampleDir: path.join(repoRoot, "agent"), instanceDir: config.agentDir });
      return {
        ok: true,
        body: {
          examples: entries
            .filter((e) => e.example && e.routine)
            .map((e) => ({ key: e.key, installed: e.installed, description: e.routine.description, fields: splitFrontMatter(e.text).fields, brief: e.routine.prompt })),
          the_usual: ["ask", "clan-feed", "notable-movers", "war-deck-check"],
        },
      };
    },
  };
}

function channelsTool() {
  return {
    name: "list_channels",
    description: "Where this bot may post (its directory: channels where its role is explicitly granted), with topics and who can see them, and which channel is bound as the ask channel.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const entries = directory();
      return {
        ok: true,
        body: {
          channels: entries.map((e) => ({ name: e.name, id: e.id, role: e.role, topic: e.topic ?? null, visibility: e.visibility ?? null, visible_to: e.visibleTo ?? null })),
          bound: Object.fromEntries([...config.channels].map(([name, id]) => [name, entries.find((e) => e.id === id)?.name ? `#${entries.find((e) => e.id === id).name}` : id])),
          timezone: config.timezone,
        },
      };
    },
  };
}

/** Everything an operator asks "how are you doing?" about, as data. */
export function statusReport() {
  const today = new Date().toISOString().slice(0, 10);
  const turns = ledger.readTurns({ since: new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10) });
  const lastBy = {};
  for (const t of turns) if (!lastBy[t.lane] || t.at > lastBy[t.lane].at) lastBy[t.lane] = { at: t.at, routine: t.routine, turnId: t.turnId };
  const cursors = state.get("cursors") || {};
  const reviews = ledger.readReviews({ since: new Date(Date.now() - 90 * DAY_MS).toISOString().slice(0, 10) });
  const last = reviews.filter((r) => r.trigger !== "dm").at(-1) ?? null;
  const { routines, errors } = loadRoutines();
  return {
    instance: ledger.instanceName(),
    build: buildId(),
    uptime_minutes: Math.round(process.uptime() / 60),
    elixir: { contract: state.get("contractVersion"), server: state.get("serverVersion"), subject: state.get("principal")?.subject ?? null },
    budgets: budget.status().map((b) => ({ lane: b.lane, spent_usd: Number(b.spent.toFixed(2)), budget_usd: b.budget, state: b.state })),
    today_usd: Number(state.todaySpend().toFixed(2)),
    turns_last_7_days: turns.length,
    turns_today: turns.filter((t) => t.at.startsWith(today)).length,
    last_turn_by_lane: lastBy,
    feed_cursors: Object.fromEntries(Object.entries(cursors).map(([k, v]) => [k, typeof v === "string" ? `${Math.round((Date.now() - Date.parse(v)) / 60000)} min ago` : String(v)])),
    routines: { enabled: routines.filter((r) => !r.disabled).map((r) => r.key), disabled: routines.filter((r) => r.disabled).map((r) => r.key), failed_to_load: errors.map((e) => e.key) },
    review: { enabled: config.review.enabled, at: `${config.review.at.days ? config.review.at.days.map((d) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d]).join(",") : "daily"} ${String(config.review.at.hour).padStart(2, "0")}:${String(config.review.at.minute).padStart(2, "0")} ${config.timezone}`, model: config.review.model, reviewed_through: state.get("reviewedThrough"), last: last ? { reviewId: last.reviewId, at: last.at, turnsRead: last.turnsRead, proposals: last.proposals.length, decisions: last.decisions.map((d) => `${d.proposalId}:${d.decision}`) } : null },
    service_managed: serviceManaged(),
    timezone: config.timezone,
  };
}

function statusTool() {
  return {
    name: "status",
    description: "How this bot is doing right now: build, Elixir contract, budgets per lane and today's spend, turns this week, the last turn per lane, feed cursor age, which routines are on, the review's clock and last run.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      return { ok: true, body: statusReport() };
    },
  };
}

export function searchTool() {
  return {
    name: "search_turns",
    description: "Find your own earlier turns: a text query over what was asked, what you answered, the tools you called and the routine, with lane/routine/date filters. Returns compact rows with turn ids; lookup_turn shows one in full.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "text to match, case-insensitive; empty for everything in the window" },
        since: { type: "string", description: "YYYY-MM-DD; default 14 days ago" },
        until: { type: "string", description: "YYYY-MM-DD" },
        lane: { type: "string", enum: ["ask", "routines", "dm"] },
        routine: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    async handler({ query, since, until, lane, routine, limit }) {
      const rows = ledger.searchTurns({ query, since: since || new Date(Date.now() - 14 * DAY_MS).toISOString().slice(0, 10), until: until || null, lane: lane || null, routine: routine || null, limit: limit || 20 });
      return { ok: true, body: { matches: rows.length, turns: rows } };
    },
  };
}

function estimateTool() {
  return {
    name: "estimate_cost",
    description: "Roughly what a routine costs per month from its fields (schedule: days and at; events: about daily), at ~$0.10 a post, plus what the current set costs. A starting point, not a forecast.",
    input_schema: {
      type: "object",
      properties: { fields: { type: "object", description: "front matter for the routine to estimate (trigger, at, days, ...)", additionalProperties: { type: "string" } } },
      additionalProperties: false,
    },
    async handler({ fields }) {
      const { routines } = loadRoutines();
      const current = estimateMonthly(routines.filter((r) => !r.disabled));
      let proposed = null;
      if (fields && Object.keys(fields).length) {
        try {
          const text = `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\nestimate`;
          const [line] = estimateMonthly([parseRoutine("estimate", text)]).lines;
          proposed = line ? { posts_per_month: line.runs, usd_per_month: Number(line.usd.toFixed(2)) } : { posts_per_month: 0, usd_per_month: 0, note: "a message routine costs by the question, not the calendar" };
        } catch (error) {
          return { ok: false, code: "bad_fields", error: error.message };
        }
      }
      return { ok: true, body: { proposed, current_set: { posts_per_month: current.runs, usd_per_month: Number(current.usd.toFixed(2)), per_post_usd: current.perPostUsd, lines: current.lines }, budget_routines_usd: config.monthlyBudgetUsd } };
    },
  };
}

function lookupTool() {
  return {
    name: "lookup_turn",
    description: "The transcript of one of your own earlier turns, by its 8-character id: what you were asked, your thoughts, every tool call with its result, what you answered.",
    input_schema: { type: "object", properties: { turn_id: { type: "string" } }, required: ["turn_id"], additionalProperties: false },
    async handler({ turn_id }) {
      const turn = findTurn(String(turn_id ?? "").toLowerCase());
      if (!turn) return { ok: false, code: "not_found", error: `no turn ${turn_id} in the last 60 days` };
      return { ok: true, body: { transcript: renderTurn(turn, { full: false }).slice(0, 12000) } };
    },
  };
}

async function converse(message, options = {}) {
  const { askFn = ask } = options;
  const blocked = spendBlock("review");
  if (blocked) {
    await send(message, `The review lane's budget is ${blocked.reason} for the month ($${blocked.spent?.toFixed(2) ?? "?"} of $${blocked.budget?.toFixed(2) ?? "?"}), and DM turns are charged there. \`why\`, \`try\`, \`memory\` and \`budget\` still work.`);
    return;
  }
  const routine = dmRoutine();
  const attached = await attachedText(message, options);
  const question = [message.cleanContent.trim(), attached].filter(Boolean).join("\n\n");
  const history = await dmHistory(message.channel, message.id);
  const files = readAgentFiles();
  const proposals = [];
  const system = systemFor(routine, { includePrompt: true });
  const placeholder = await message.channel.send("-# thinking…").catch(() => null);

  const result = await askFn({
    system,
    messages: [...history, { role: "user", content: `${message.author.username} (discord:${message.author.id}): ${question}\n\n${nowLine()}` }],
    model: routine.model,
    effort: routine.effort,
    maxTokens: routine.maxTokens,
    routineKey: "dm",
    lane: "review",
    localTools: [proposeTool({ files, proposals, by: "owner", operatorId: message.author.id }), routinesTool(), examplesTool(), channelsTool(), lookupTool(), searchTool(), statusTool(), estimateTool(), deckLinkTool()],
    maxRounds: 8,
  });

  if (!result.ok) {
    if (placeholder) await placeholder.edit(`Something broke talking to the model: \`${result.error}\`.`).catch(() => {});
    log.error("dm_failed", { user: message.author.id, error: result.error });
    return;
  }
  const answer = (result.text || "").trim() || (proposals.length ? "Here is what I would remember:" : "I got nothing back for that.");
  const parts = chunk(answer, 1900);
  if (placeholder) await placeholder.edit({ content: parts[0], allowedMentions: { parse: [] } }).catch(() => send(message, parts[0]));
  else await send(message, parts[0]);
  for (const part of parts.slice(1)) await send(message, part);

  // Proposals ride the review machinery: a `review` record with trigger
  // "dm", so the buttons, the history and Undo are exactly the same.
  if (proposals.length) {
    const review = ledger.reviewEntry({
      reviewId: `dm${result.turnId}`.slice(0, 8),
      trigger: "dm",
      window: { since: new Date().toISOString(), until: new Date().toISOString() },
      turnsRead: 0,
      proposals: proposals.map(({ next, ...p }) => p),
      report: answer,
      usd: result.usd,
      model: result.model,
    });
    review.by = message.author.id;
    ledger.append(review);
    for (const [i, p] of review.proposals.entries()) {
      const { content, buttons } = proposalMessage(review, p, { index: i + 1, total: review.proposals.length });
      await message.channel.send({ content, components: toComponents(buttons), allowedMentions: { parse: [] } });
    }
  }

  ledger.append(
    ledger.turnEntry({
      routine,
      lane: "dm",
      result,
      system,
      contractVersion: state.get("contractVersion"),
      input: { kind: "message", asker: { id: message.author.id, name: message.author.username }, channelId: message.channel.id, threadId: null, messageId: message.id, question, history, dm: true },
      output: { text: answer, messageIds: [placeholder?.id].filter(Boolean), footers: [], ungrounded: false, friction: null, proposals: proposals.map((p) => p.id) },
    }),
  );
  log.info("dm_answered", { user: message.author.id, turnId: result.turnId, tools: result.called.length, toolNames: result.called.join(","), proposals: proposals.length, usd: result.usd.toFixed(4), ms: result.ms });
}

// --------------------------------------------------------------- entry

const REFUSAL_EVERY = DAY_MS;

export async function handleDm(message, options = {}) {
  const userId = message.author.id;
  if (!isAdmin(userId)) {
    const refused = state.get("dmRefused") || {};
    if (!refused[userId] || Date.now() - Date.parse(refused[userId]) > REFUSAL_EVERY) {
      const askChannel = loadRoutines().routines.find((r) => r.trigger === "message" && !r.disabled);
      const where = askChannel ? ` Ask in the server's #${askChannel.channel} channel instead.` : "";
      await message.channel.send({ content: `I only take direct messages from whoever runs me.${where}`, allowedMentions: { parse: [] } }).catch(() => {});
      state.set({ dmRefused: { ...refused, [userId]: new Date().toISOString() } });
    }
    log.info("dm_refused", { user: userId });
    return { refused: true };
  }
  const text = message.cleanContent.trim();
  if (!text && !message.attachments?.size) return null;

  if (/^why\b/i.test(text) || /discord(?:app)?\.com\/channels\//.test(text)) return why(message, text);
  const tryMatch = /^try\s+([a-z0-9-]+)\s*$/i.exec(text);
  if (tryMatch) return tryRoutine(message, tryMatch[1].toLowerCase(), options);
  if (/^post(\s+it)?\s*[.!]?$/i.test(text)) return postDraft(message, options);
  if (/^memory\s*[?]?$/i.test(text)) return showMemory(message);
  if (/^(budget|spend)\s*[?]?$/i.test(text)) return send(message, budgetReply());
  if (/^routines\s*[?]?$/i.test(text)) return send(message, routinesReply());
  if (/^status\s*[?]?$/i.test(text)) return send(message, `**Status**\n\`\`\`json\n${JSON.stringify(statusReport(), null, 1).slice(0, 1800)}\n\`\`\``);
  if (/^feedback\s*[?]?$/i.test(text)) return showFeedback(message);
  if (/^settings\s*[?]?$/i.test(text)) return send(message, `**Settings** (live on Apply; the ones marked restart ${serviceManaged() ? "restart me automatically" : "need you to restart me"})\n\`\`\`\n${describeSettings()}\n\`\`\``);
  if (/^(help|\?)$/i.test(text)) {
    return send(
      message,
      [
        "Tell me something to remember, ask me why I said something (`why <turn id>` or paste a message link), or ask me anything about the record.",
        "`try <routine>` — rehearse a post here; `post it` — send it",
        "`routines` — what runs and when; or just tell me what to change, add or remove",
        "`settings` — budgets, models, the review, timezone, admins, channels; tell me what to change",
        "`memory` — what I have been told and learned · `budget` — this month's spend",
        "`status` — how I am doing · `feedback` — what I have filed with Elixir and what came back",
      ].join("\n"),
    );
  }
  return converse(message, options);
}

/**
 * THE INTRODUCTION. A bot with nothing enabled says so to its admins, by
 * DM, on boot: what it is connected to, where it may post, what it could
 * run. Setup used to make this choice at the terminal; the person choosing
 * is on a phone, and the bot only knows the channels and the clan once it
 * is connected. Deterministic, free, once a day at most.
 */
export async function introduce({ guildName, subject, examples = null } = {}) {
  const entries = directory();
  const postable = entries.filter((e) => e.role !== "ask").map((e) => `#${e.name}`);
  const askId = config.channels.get("ask");
  const askName = entries.find((e) => e.id === askId)?.name;
  const shipped = examples ?? catalog({ exampleDir: path.join(repoRoot, "agent"), instanceDir: config.agentDir }).filter((e) => e.example && e.routine);
  const lines = [
    `I'm connected to **${guildName ?? "the server"}**${subject?.name ? ` for **${subject.name}**${subject.members ? ` (${subject.members} members)` : ""}` : ""}, and nothing runs yet.`,
    `I may post in ${postable.length ? postable.join(", ") : "no channel yet — grant my role Send Messages where I should post"}${askName ? `; questions are answered in #${askName}` : ""}. Times are ${config.timezone}.`,
    "",
    "What I can run:",
    ...shipped.map((e) => `• **${e.key}** — ${e.routine.description}`),
    "",
    'Say **the usual** for ask, clan-feed, notable-movers and war-deck-check, or tell me which you want and when. Each comes back as a proposal with an Apply button. Then tell me about the clan — what you call things, what to keep in mind.',
  ];
  return notify("welcome", lines.join("\n"), { fingerprint: "introduce", every: 24 * 3600 * 1000 });
}

/** For tests: the outstanding drafts. */
export const _drafts = drafts;
