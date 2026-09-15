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

import { config } from "./config.js";
import { ask, spendBlock } from "./claude.js";
import { systemFor, readMemory, parseMemoryEntry, MEMORY_MAX_CHARS } from "./prompt.js";
import { loadRoutines } from "./routines.js";
import { runRoutine } from "./run.js";
import { directory, resolveById } from "./directory.js";
import { post, chunk } from "./post.js";
import { renderTrace } from "./trace.js";
import { renderTurn } from "./turns.js";
import { budgetReply } from "./commands.js";
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

function proposeTool({ files, proposals, by }) {
  return {
    name: "propose_change",
    description: "Propose ONE edit to memory.md, identity.md or routines/<key>.md, in the operator's words. Checked against the file as it is now; a refusal says why. The operator gets it as a diff with an Apply button.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string" },
        summary: { type: "string", description: "One line for the operator: what this remembers or changes." },
        edit: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["append", "replace", "remove"] },
            text: { type: "string", description: "append: '- YYYY-MM-DD (from owner)[ until YYYY-MM-DD]: their words'" },
            find: { type: "string" },
            replace: { type: "string" },
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
      const current = proposals.filter((p) => p.file === file).at(-1)?.next ?? files[file] ?? "";
      const plan = planEdit({ file, edit: { ...edit, by }, current });
      if (!plan.ok) return { ok: false, code: "refused", error: plan.error };
      const proposal = { id: `p${proposals.length + 1}`, class: "prompt", file, rule: "from the operator", turnIds: [], summary: String(summary ?? "").slice(0, 300), edit: { ...edit, by }, preview: plan.preview.slice(0, 1500), next: plan.next };
      proposals.push(proposal);
      return { ok: true, body: { proposal_id: proposal.id, diff: proposal.preview } };
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
    messages: [...history, { role: "user", content: `${message.author.username} (discord:${message.author.id}): ${question}` }],
    model: routine.model,
    effort: routine.effort,
    maxTokens: routine.maxTokens,
    routineKey: "dm",
    lane: "review",
    localTools: [proposeTool({ files, proposals, by: "owner" }), lookupTool()],
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
  if (/^(help|\?)$/i.test(text)) {
    return send(
      message,
      [
        "Tell me something to remember, ask me why I said something (`why <turn id>` or paste a message link), or ask me anything about the record.",
        "`try <routine>` — rehearse a post here; `post it` — send it",
        "`memory` — what I have been told and learned · `budget` — this month's spend",
      ].join("\n"),
    );
  }
  return converse(message, options);
}

/** For tests: the outstanding drafts. */
export const _drafts = drafts;
