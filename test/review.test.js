/**
 * The review lane is the loop that turns the ledger into edits. What must
 * hold: an edit is checked against the file as it is NOW and again at apply
 * time; nothing outside agent/ is ever writable; every write keeps a backup
 * and can be undone while the file is untouched; a review reads flagged
 * turns first and in full; the DM shows a diff with the right buttons.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ledger from "../src/ledger.js";
import * as state from "../src/state.js";
import {
  planEdit,
  renderWindow,
  isFlagged,
  runReview,
  applyProposal,
  undoProposal,
  findReview,
  lastDecision,
  proposalMessage,
  parseButtonId,
  buttonId,
  handleButton,
  reviewRoutine,
} from "../src/review.js";
import { parseVerdict } from "../src/feedback.js";
import { looksLikeCorrection } from "../src/ask.js";
import { readMemory, systemFor } from "../src/prompt.js";
import { parseRoutine } from "../src/routines.js";
import { handleAsk } from "../src/ask.js";
import { handleReaction } from "../src/reactions.js";

const today = () => new Date().toISOString().slice(0, 10);

function agentDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-agent-"));
  fs.mkdirSync(path.join(dir, "routines"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fresh() {
  fs.rmSync(ledger.LEDGER_DIR, { recursive: true, force: true });
  state.set({ reviewedThrough: null });
}

const turn = (overrides = {}) => {
  const routine = parseRoutine("ask", "---\ntrigger: message\nchannel: ask\n---\nAnswer.");
  return ledger.turnEntry({
    routine,
    lane: "ask",
    result: {
      turnId: overrides.turnId ?? "t0000001",
      text: overrides.text ?? "9-2 today.",
      called: ["players_summary"],
      errors: [],
      trace: [{ kind: "tool", name: "players_summary", input: {}, shape: "1 players", result: JSON.stringify({ wins: 9, losses: 2 }) }],
      envelopes: [],
      usd: 0.01,
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 },
      ms: 100,
      rounds: 1,
      stopReason: "end_turn",
      model: "claude-sonnet-5",
      effort: "medium",
    },
    system: "s",
    input: { kind: "message", asker: { id: "42", name: "Tester" }, channelId: "2", threadId: null, question: overrides.question ?? "how am I playing?", history: [] },
    output: { text: overrides.text ?? "9-2 today.", messageIds: ["m1"], footers: [], ungrounded: false, friction: null },
  });
};

// ------------------------------------------------------------ planEdit

test("a memory entry appends as one dated line with its provenance; other files append raw text", () => {
  const ok = planEdit({ file: "memory.md", edit: { op: "append", text: "- 2026-09-14 (turns a1b2c3d4): pass segment to battles_meta_cards" }, current: "# Memory\n" });
  assert.equal(ok.ok, true);
  assert.match(ok.next, /\n- 2026-09-14 \(turns a1b2c3d4\): pass segment/);
  assert.equal(ok.preview.startsWith("+ - 2026-09-14"), true);
  assert.equal(planEdit({ file: "memory.md", edit: { op: "append", text: "pass segment" }, current: "" }).ok, false, "undated is refused");
  assert.equal(planEdit({ file: "memory.md", edit: { op: "append", text: "- 2026-09-14: no provenance" }, current: "" }).ok, false, "provenance is required");
  assert.equal(planEdit({ file: "memory.md", edit: { op: "append", text: "- 2026-09-14 (from owner) until 2026-09-21: pushing for top 10" }, current: "" }).ok, true, "owner entries with an expiry");
  // What the operator wrote is theirs to remove.
  const owned = "- 2026-09-14 (from owner): we call war days boat days\n";
  assert.match(planEdit({ file: "memory.md", edit: { op: "remove", find: "- 2026-09-14 (from owner): we call war days boat days" }, current: owned }).error, /came from the operator/);
  assert.equal(planEdit({ file: "memory.md", edit: { op: "remove", find: "- 2026-09-14 (from owner): we call war days boat days", by: "owner" }, current: owned }).ok, true);
  const rule = planEdit({ file: "identity.md", edit: { op: "append", text: "- Never names a member's losses in a channel the clan reads." }, current: "## What it never does\n\n- Never guesses.\n" });
  assert.equal(rule.ok, true, "a house rule appends as raw text");
  assert.match(rule.next, /- Never guesses\.\n\n- Never names a member's losses/);
  assert.equal(rule.preview, "+ - Never names a member's losses in a channel the clan reads.");
});

test("replace needs the text to occur exactly once, and never inside a routine's front matter", () => {
  const routine = "---\ntrigger: schedule\nat: 01:00\n---\nName three movers.\nFacts, never judgment.";
  assert.equal(planEdit({ file: "routines/movers.md", edit: { op: "replace", find: "at: 01:00", replace: "at: 02:00" }, current: routine }).ok, false, "front matter");
  const ok = planEdit({ file: "routines/movers.md", edit: { op: "replace", find: "Name three movers.", replace: "Name at most three movers." }, current: routine });
  assert.equal(ok.ok, true);
  assert.match(ok.next, /Name at most three movers\./);
  assert.match(ok.preview, /^- Name three movers\.\n\+ Name at most three movers\.$/);
  assert.equal(planEdit({ file: "identity.md", edit: { op: "replace", find: "e", replace: "x" }, current: "eee" }).ok, false, "ambiguous");
  assert.equal(planEdit({ file: "identity.md", edit: { op: "replace", find: "zzz", replace: "x" }, current: "abc" }).ok, false, "absent");
});

test("nothing outside agent/'s three kinds of file is editable, whatever the path says", () => {
  for (const file of ["../.env", ".env", "models.json", "routines/../../src/prompt.js", "src/prompt.js", "routines/x.txt"]) {
    assert.equal(planEdit({ file, edit: { op: "append", text: "- 2026-09-14 x" }, current: "" }).ok, false, file);
  }
});

test("memory.md is bounded by entries and by characters", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `- 2026-09-0${(i % 9) + 1} (turns x): lesson ${i}`).join("\n");
  assert.match(planEdit({ file: "memory.md", edit: { op: "append", text: "- 2026-09-14 (turns y): one more" }, current: twenty }).error, /already has 20/);
  const fat = `- 2026-09-01 (turns x): ${"x".repeat(5990)}`;
  assert.match(planEdit({ file: "memory.md", edit: { op: "append", text: "- 2026-09-14 (turns y): tip" }, current: fat }).error, /exceed/);
});

// ------------------------------------------------------- the window

test("flagged turns come first and in full; plain turns are compact", () => {
  const plain = { ...turn({ turnId: "aaaa0001" }), reactions: [], filed: [], findings: [], interventions: [] };
  const flagged = { ...turn({ turnId: "bbbb0002" }), reactions: [{ reaction: "down", note: "wrong week", userId: "7" }], filed: [], findings: [], interventions: [{ by: "other_member", text: "try players_search", userId: "8" }] };
  assert.equal(isFlagged(plain), false);
  assert.equal(isFlagged(flagged), true);
  const rendered = renderWindow([plain, flagged]);
  assert.equal(rendered.flagged, 1);
  assert.equal(rendered.shown, 2);
  assert.ok(rendered.text.indexOf("bbbb0002") < rendered.text.indexOf("aaaa0001"), "flagged first");
  assert.match(rendered.text, /ANOTHER MEMBER stepped in: "try players_search"/);
  assert.match(rendered.text, /👎 — "wrong week"/);
});

// --------------------------------------------------------- runReview

/** A fake model that calls the local tools the way the API would, then reports. */
function fakeAsk(calls) {
  return async ({ localTools }) => {
    const called = [];
    for (const [name, input] of calls) {
      const tool = localTools.find((t) => t.name === name);
      const out = await tool.handler(input);
      called.push({ name, ok: out.ok, error: out.error });
    }
    return {
      ok: true,
      text: "**Since last review**\nnothing to measure.\n**This window**\n2 turns, 1 flagged.\n**Proposed**\n- one lesson",
      called: called.map((c) => c.name),
      errors: [],
      trace: [],
      envelopes: [],
      usd: 0.42,
      usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200 },
      turnId: "rv000001",
      ms: 5000,
      rounds: 2,
      stopReason: "end_turn",
      truncated: false,
      model: "claude-opus-5",
      effort: "high",
      _called: called,
    };
  };
}

test("a review reads the window, records proposals with diffs, and moves the cursor", async (t) => {
  fresh();
  const dir = agentDir(t, { "memory.md": "# Memory\n", "identity.md": "Plain and direct.\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  ledger.append(turn({ turnId: "bbbb0002" }));
  ledger.append(ledger.reactionEntry({ turnId: "bbbb0002", reaction: "down", userId: "7", note: "wrong" }));

  const outcome = await runReview({
    trigger: "command",
    agentDir: dir,
    askFn: fakeAsk([
      ["propose_change", { file: "memory.md", rule: "windows", turn_ids: ["bbbb0002"], summary: "Say which window a summary covers.", edit: { op: "append", text: "- 2026-09-14 (turns bbbb0002): name the window in every summary" } }],
      ["propose_change", { file: "identity.md", rule: "voice", turn_ids: ["aaaa0001", "bbbb0002"], summary: "Shorter.", edit: { op: "replace", find: "Plain and direct.", replace: "Plain, direct, short." } }],
      ["propose_change", { file: "src/prompt.js", rule: "x", turn_ids: ["aaaa0001"], summary: "no", edit: { op: "append", text: "- 2026-09-14 x" } }],
      ["report_mechanics", { rule: "WHO_IS_ASKING", turn_ids: ["bbbb0002"], summary: "asked for a tag it could look up" }],
    ]),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.turns, 2);
  assert.equal(outcome.flagged, 1);
  assert.equal(outcome.proposals.length, 2, "the src/ edit was refused");
  assert.equal(outcome.proposals[0].file, "memory.md");
  assert.match(outcome.proposals[0].preview, /^\+ - 2026-09-14/);
  assert.equal(outcome.proposals[1].preview, "- Plain and direct.\n+ Plain, direct, short.");
  assert.equal(outcome.reports.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "memory.md"), "utf8"), "# Memory\n", "nothing written without a click");

  const review = findReview(outcome.reviewId);
  assert.equal(review.turnsRead, 2);
  assert.equal(review.proposals.length, 2);
  assert.equal(review.proposals[0].next, undefined, "the planned file is not persisted");
  assert.equal(state.get("reviewedThrough"), outcome.window.until);

  // The next review starts after this one's window.
  const again = await runReview({ trigger: "command", agentDir: dir, askFn: fakeAsk([]) });
  assert.equal(again.empty, true);
});

test("a dry run costs the call and writes nothing — here or upstream", async (t) => {
  fresh();
  const dir = agentDir(t, { "memory.md": "# Memory\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  let system;
  const inner = fakeAsk([["propose_change", { file: "memory.md", rule: "r", turn_ids: ["aaaa0001"], summary: "s", edit: { op: "append", text: "- 2026-09-14 (turns aaaa0001): x" } }]]);
  const outcome = await runReview({ trigger: "cli", dryRun: true, agentDir: dir, askFn: async (args) => ((system = args.system), inner(args)) });
  assert.match(system, /REHEARSAL: do not call elixir_feedback/);
  assert.equal(outcome.proposals.length, 1);
  assert.equal(findReview(outcome.reviewId), null);
  assert.equal(state.get("reviewedThrough"), null);
});

test("the proposal cap holds, and a refused proposal says why", async (t) => {
  fresh();
  const dir = agentDir(t, { "memory.md": "# Memory\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  const calls = Array.from({ length: 5 }, (_, i) => ["propose_change", { file: "memory.md", rule: "r", turn_ids: ["aaaa0001"], summary: `s${i}`, edit: { op: "append", text: `- 2026-09-14 (turns aaaa0001): lesson ${i}` } }]);
  const askFn = fakeAsk(calls);
  let seen;
  const outcome = await runReview({ trigger: "command", agentDir: dir, askFn: async (args) => (seen = await askFn(args)) });
  assert.equal(outcome.proposals.length, 3);
  assert.match(seen._called[3].error, /cap/);
});

// ------------------------------------------------- apply, undo, buttons

test("apply writes the file with a backup; undo restores it while untouched; a hand edit in between refuses", async (t) => {
  fresh();
  const dir = agentDir(t, { "identity.md": "Plain and direct.\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  ledger.append(turn({ turnId: "bbbb0002" }));
  const outcome = await runReview({ trigger: "command", agentDir: dir, askFn: fakeAsk([["propose_change", { file: "identity.md", rule: "voice", turn_ids: ["aaaa0001", "bbbb0002"], summary: "Shorter.", edit: { op: "replace", find: "Plain and direct.", replace: "Plain, direct, short." } }]]) });
  const review = findReview(outcome.reviewId);
  const [proposal] = review.proposals;

  const applied = applyProposal({ review, proposal, by: "9", agentDir: dir });
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "identity.md"), "utf8"), "Plain, direct, short.\n");
  assert.equal(fs.readFileSync(applied.backup, "utf8"), "Plain and direct.\n");
  assert.equal(lastDecision(findReview(outcome.reviewId), "p1").decision, "applied");

  // Applying again is refused: the find text is gone.
  const twice = applyProposal({ review, proposal, by: "9", agentDir: dir });
  assert.equal(twice.ok, false);

  const undone = undoProposal({ review: findReview(outcome.reviewId), proposal, by: "9", agentDir: dir });
  assert.equal(undone.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "identity.md"), "utf8"), "Plain and direct.\n");
  assert.equal(lastDecision(findReview(outcome.reviewId), "p1").decision, "reverted");

  // Apply, then edit by hand, then undo: refused, the backup is named.
  applyProposal({ review: findReview(outcome.reviewId), proposal, by: "9", agentDir: dir });
  fs.appendFileSync(path.join(dir, "identity.md"), "Say hi.\n");
  const refused = undoProposal({ review: findReview(outcome.reviewId), proposal, by: "9", agentDir: dir });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /changed since/);
});

test("the DM for a proposal carries the diff and the right buttons for its state", () => {
  const review = { reviewId: "r1", proposals: [] };
  const proposal = { id: "p1", file: "memory.md", rule: "windows", turnIds: ["a", "b"], summary: "Name the window.", preview: "+ - 2026-09-14 (turns a, b): name the window" };
  const pending = proposalMessage(review, proposal, { index: 1, total: 2 });
  assert.match(pending.content, /Proposal 1 of 2/);
  assert.match(pending.content, /```diff\n\+ - 2026-09-14/);
  assert.deepEqual(pending.buttons.map((b) => b.label), ["Apply", "Skip", "Show turns"]);
  const applied = proposalMessage(review, proposal, { index: 1, total: 2, decision: { decision: "applied", by: "9", detail: { backup: "/x/.history/memory.md.t" } } });
  assert.match(applied.content, /✅ Applied by <@9>/);
  assert.deepEqual(applied.buttons.map((b) => b.label), ["Undo", "Show turns"]);
  const skipped = proposalMessage(review, proposal, { index: 1, total: 2, decision: { decision: "skipped", by: "9" } });
  assert.deepEqual(skipped.buttons, []);
  assert.deepEqual(parseButtonId(buttonId("r1", "p1", "apply")), { reviewId: "r1", proposalId: "p1", action: "apply" });
  assert.equal(parseButtonId("nope"), null);
});

test("a button applies for an admin and refuses everyone else", async (t) => {
  fresh();
  const dir = agentDir(t, { "memory.md": "# Memory\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  const outcome = await runReview({ trigger: "command", agentDir: dir, askFn: fakeAsk([["propose_change", { file: "memory.md", rule: "r", turn_ids: ["aaaa0001"], summary: "s", edit: { op: "append", text: "- 2026-09-14 (turns aaaa0001): a lesson" } }]]) });
  const fake = (userId, action) => {
    const replies = [];
    const updates = [];
    return {
      interaction: {
        customId: buttonId(outcome.reviewId, "p1", action),
        user: { id: userId },
        reply: async (m) => replies.push(m),
        update: async (m) => updates.push(m),
        followUp: async (m) => replies.push(m),
      },
      replies,
      updates,
    };
  };
  const stranger = fake("1", "apply");
  await handleButton(stranger.interaction, { isAdmin: (id) => id === "9" });
  assert.match(stranger.replies[0].content, /whoever runs this bot/);
  assert.equal(fs.readFileSync(path.join(dir, "memory.md"), "utf8"), "# Memory\n");

  // The live apply resolves agentDir from config; point the proposal at ours
  // by writing to config's dir is not possible here, so exercise skip+show.
  const skip = fake("9", "skip");
  await handleButton(skip.interaction, { isAdmin: (id) => id === "9" });
  assert.match(skip.updates[0].content, /⏭ Skipped by <@9>/);
  assert.equal(skip.updates[0].components.length, 0);
  const show = fake("9", "show");
  await handleButton(show.interaction, { isAdmin: (id) => id === "9" });
  assert.match(show.replies[0].content, /turn `aaaa0001`/);
});

// ------------------------------------------------ signals and lessons

test("a sweep verdict parses into a class, and only ELIXIR files", () => {
  assert.deepEqual(parseVerdict("PROMPT: the brief should name the window"), { cls: "prompt", note: "the brief should name the window" });
  assert.deepEqual(parseVerdict("MECHANICS: identity rule asks for a tag it could look up"), { cls: "mechanics", note: "identity rule asks for a tag it could look up" });
  assert.equal(parseVerdict("ELIXIR: battles_query has no mode filter").cls, "elixir");
  assert.equal(parseVerdict("NONE").cls, null);
  assert.equal(parseVerdict("Filed: something").cls, null, "an unlabelled line files nothing");
});

test("a correction from the asker is recognised; ordinary follow-ups are not", () => {
  assert.equal(looksLikeCorrection("no, I meant this week"), true);
  assert.equal(looksLikeCorrection("that's not right"), true);
  assert.equal(looksLikeCorrection("Actually I play 2v2 mostly"), true);
  assert.equal(looksLikeCorrection("and what about my deck?"), false);
  assert.equal(looksLikeCorrection("thanks!"), false);
});

test("memory.md rides the system prompt after the house rules; expired lines drop out; a missing file is nothing", (t) => {
  const dir = agentDir(t, {
    "memory.md": [
      "- 2026-09-14 (turns a): pass the segment to battles_meta_cards",
      "- 2026-09-14 (from owner) until 2026-09-21: pushing for top 10 this week",
      "- 2026-09-01 (from owner) until 2026-09-07: last week's push, now over",
    ].join("\n"),
  });
  const routine = parseRoutine("ask", "---\ntrigger: message\nchannel: ask\n---\nAnswer.");
  const memory = readMemory({ dir, today: "2026-09-15" });
  const system = systemFor(routine, { identity: "Plain.", memory });
  assert.ok(system.indexOf("HOUSE RULES") < system.indexOf("MEMORY"));
  assert.match(system, /pass the segment to battles_meta_cards/);
  assert.match(system, /pushing for top 10 this week/);
  assert.doesNotMatch(system, /last week's push/, "expired entries are not loaded");
  assert.equal(readMemory({ dir: path.join(dir, "nowhere") }), null);
  assert.doesNotMatch(systemFor(routine, { identity: "Plain.", memory: null }), /MEMORY/);
});

test("the review clock is a schedule routine in the operator's zone, off when the lane is off", () => {
  const routine = reviewRoutine();
  assert.equal(routine.key, "__review");
  assert.equal(routine.trigger, "schedule");
  assert.equal(typeof routine.at.hour, "number");
  assert.equal(routine.disabled, true, "REVIEW is off in the test env");
});

// ------------------------------------------- the signals, end to end

function threadMessage({ authorId, starterAuthorId, content, priorBotMessageId }) {
  const posted = [];
  const reply = async (body) => {
    const entry = { id: `r${posted.length + 1}`, text: typeof body === "string" ? body : body.content };
    posted.push(entry);
    return { id: entry.id, edit: async () => {}, reply: async () => ({ id: "n" }) };
  };
  const prior = new Map([[priorBotMessageId, { id: priorBotMessageId, author: { bot: true }, cleanContent: "9-2 today.", pinned: false }]]);
  return {
    id: "q2",
    cleanContent: content,
    author: { id: authorId, username: "u", bot: false },
    member: { displayName: "U" },
    reply,
    channel: {
      id: "thread1",
      isThread: () => true,
      send: reply,
      fetchStarterMessage: async () => ({ id: "q1", author: { id: starterAuthorId, bot: false }, cleanContent: "how am I playing?", pinned: false, member: { displayName: "Asker" } }),
      messages: { fetch: async () => prior },
    },
  };
}

test("another member speaking in the thread is recorded as an intervention on the bot's last turn", async () => {
  fresh();
  const routine = parseRoutine("ask", "---\ntrigger: message\nchannel: ask\nhistory_turns: 4\n---\nAnswer.");
  state.rememberTurn("prev0001", { routine: "ask", lane: "ask", question: "q", answer: "a", called: [], errors: [], requestIds: [] }, ["bot-msg-1"]);
  const result = { ok: true, text: "Linked.", called: ["players_search"], errors: [], trace: [], envelopes: [], usd: 0.01, turnId: "next0002", ms: 10, rounds: 1, stopReason: "end_turn", model: "m", effort: "e" };
  await handleAsk(threadMessage({ authorId: "leader", starterAuthorId: "asker", content: "try players_search for their name", priorBotMessageId: "bot-msg-1" }), routine, { askFn: async () => result });
  await handleAsk(threadMessage({ authorId: "asker", starterAuthorId: "asker", content: "no, that's not me", priorBotMessageId: "bot-msg-1" }), routine, { askFn: async () => result });
  await handleAsk(threadMessage({ authorId: "asker", starterAuthorId: "asker", content: "and my deck?", priorBotMessageId: "bot-msg-1" }), routine, { askFn: async () => result });
  const interventions = ledger.readRecords({ since: today() }).filter((r) => r.kind === "intervention");
  assert.deepEqual(
    interventions.map((i) => [i.turnId, i.by, i.userId]),
    [
      ["prev0001", "other_member", "leader"],
      ["prev0001", "asker", "asker"],
    ],
  );
});

test("a 👎 the sweep pins on this bot becomes a finding, not a filing", async () => {
  fresh();
  state.rememberTurn("ask00009", { routine: "ask", lane: "ask", question: "q", answer: "a", called: [], errors: [], requestIds: [] }, ["msg-19"]);
  const replies = [];
  const message = { id: "msg-19", partial: false, reply: async (m) => replies.push(m.content), channel: { messages: { fetch: async () => new Map() } } };
  const out = await handleReaction({ emoji: { name: "👎" }, message }, { id: "7", bot: false, partial: false }, {
    sweepFn: async ({ turn }) => {
      ledger.append(ledger.findingEntry({ turnId: turn.turnId, cls: "prompt", source: "reaction", note: "the brief never names the window" }));
      return { cls: "prompt", note: "the brief never names the window" };
    },
  });
  assert.equal(out.filed, false);
  assert.equal(out.finding.cls, "prompt");
  assert.match(replies[0], /on this bot's side, not Elixir's/);
  const records = ledger.readRecords({ since: today() });
  assert.deepEqual(records.map((r) => r.kind), ["reaction", "finding"]);
});

// ------------------------------------------- the operator's routine ops

const MOVERS = "---\ntrigger: schedule\nat: 01:00\nchannel: news\n---\nName three movers.\n";

test("set_fields rewrites the front matter, is checked by the routine parser, and is the operator's alone", () => {
  const ok = planEdit({ file: "routines/movers.md", edit: { op: "set_fields", by: "owner", fields: { at: "07:30", days: "mon,thu", enabled: "false" } }, current: MOVERS });
  assert.equal(ok.ok, true);
  assert.match(ok.next, /^---\ntrigger: schedule\nat: 07:30\nchannel: news\ndays: mon,thu\nenabled: false\n---\nName three movers\.\n$/);
  assert.equal(ok.preview, "- at: 01:00\n+ at: 07:30\n+ days: mon,thu\n+ enabled: false");
  assert.match(planEdit({ file: "routines/movers.md", edit: { op: "set_fields", by: "owner", fields: { at: "25:00" } }, current: MOVERS }).error, /not a real time/);
  assert.match(planEdit({ file: "routines/movers.md", edit: { op: "set_fields", by: "owner", fields: { catchup: "2" } }, current: MOVERS }).error, /not a routine field/);
  assert.match(planEdit({ file: "routines/movers.md", edit: { op: "set_fields", by: "owner", fields: { at: "" } }, current: MOVERS }).error, /at must be HH:MM/, "removing a required field is refused by the parser");
  assert.match(planEdit({ file: "routines/movers.md", edit: { op: "set_fields", fields: { at: "07:30" } }, current: MOVERS }).error, /operator's/, "the review cannot reschedule");
  assert.match(planEdit({ file: "memory.md", edit: { op: "set_fields", by: "owner", fields: { at: "07:30" } }, current: "" }).error, /for routines/);
});

test("create makes a routine that parses, and refuses one that would not", () => {
  const ok = planEdit({ file: "routines/war-recap.md", edit: { op: "create", by: "owner", fields: { trigger: "schedule", at: "20:00", days: "fri", channel: "war", may_skip: "true" }, text: "Recap the war week." }, current: null });
  assert.equal(ok.ok, true);
  assert.equal(ok.created, true);
  assert.match(ok.next, /^---\ntrigger: schedule\nat: 20:00\ndays: fri\nchannel: war\nmay_skip: true\n---\nRecap the war week\.\n$/);
  assert.match(ok.preview, /^\+ ---\n\+ trigger: schedule/);
  assert.match(planEdit({ file: "routines/war-recap.md", edit: { op: "create", by: "owner", fields: { trigger: "schedule" }, text: "x" }, current: null }).error, /at must be HH:MM/);
  assert.match(planEdit({ file: "routines/movers.md", edit: { op: "create", by: "owner", fields: { trigger: "schedule", at: "01:00" }, text: "x" }, current: MOVERS }).error, /already exists/);
});

test("apply of a create writes the file and seeds its period; undo removes it; delete keeps a backup and undo restores", async (t) => {
  fresh();
  const dir = agentDir(t, { "routines/movers.md": MOVERS });
  ledger.append(turn({ turnId: "aaaa0001" }));
  const outcome = await runReview({
    trigger: "command",
    agentDir: dir,
    askFn: fakeAsk([
      ["propose_change", { file: "routines/war-recap.md", rule: "new", turn_ids: ["aaaa0001"], summary: "A Friday recap.", edit: { op: "create", by: "owner", fields: { trigger: "schedule", at: "00:01", days: "sun,mon,tue,wed,thu,fri,sat", channel: "war" }, text: "Recap the war week." } }],
      ["propose_change", { file: "routines/movers.md", rule: "gone", turn_ids: ["aaaa0001"], summary: "Drop movers.", edit: { op: "delete", by: "owner" } }],
    ]),
  });
  const review = findReview(outcome.reviewId);
  const [create, del] = review.proposals;

  const made = applyProposal({ review, proposal: create, by: "9", agentDir: dir });
  assert.equal(made.ok, true);
  assert.match(fs.readFileSync(path.join(dir, "routines/war-recap.md"), "utf8"), /Recap the war week/);
  assert.ok(state.get("runs")?.["war-recap"], "the new routine's current period is marked done, so it does not fire on save");
  const undoneCreate = undoProposal({ review: findReview(outcome.reviewId), proposal: create, by: "9", agentDir: dir });
  assert.equal(undoneCreate.ok, true);
  assert.equal(fs.existsSync(path.join(dir, "routines/war-recap.md")), false, "undoing a create removes the file");

  const gone = applyProposal({ review: findReview(outcome.reviewId), proposal: del, by: "9", agentDir: dir });
  assert.equal(gone.ok, true);
  assert.equal(fs.existsSync(path.join(dir, "routines/movers.md")), false);
  assert.equal(fs.readFileSync(gone.backup, "utf8"), MOVERS);
  const restored = undoProposal({ review: findReview(outcome.reviewId), proposal: del, by: "9", agentDir: dir });
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "routines/movers.md"), "utf8"), MOVERS);
});

// ------------------------------------------------- settings (.env by DM)

test("a setting is checked like setup checks it, previewed as a diff, and only the operator may change one", () => {
  const env = "ELIXIR_MCP_TOKEN=secret\nMONTHLY_BUDGET_USD=20.00\nTIMEZONE=UTC\n";
  const ok = planEdit({ file: ".env", edit: { op: "set_env", by: "owner", fields: { ASK_MONTHLY_BUDGET_USD: "15", TIMEZONE: "America/Chicago", MONTHLY_BUDGET_USD: "25.00" } }, current: env, by: "9" });
  assert.equal(ok.ok, true);
  assert.equal(ok.settings, true);
  assert.match(ok.next, /^ELIXIR_MCP_TOKEN=secret\nMONTHLY_BUDGET_USD=25\.00\nTIMEZONE=America\/Chicago\n\n# --- Set from the DM\nASK_MONTHLY_BUDGET_USD=15\n$/);
  assert.equal(ok.preview, "- MONTHLY_BUDGET_USD=20.00\n+ MONTHLY_BUDGET_USD=25.00\n- TIMEZONE=UTC\n+ TIMEZONE=America/Chicago\n+ ASK_MONTHLY_BUDGET_USD=15");
  assert.doesNotMatch(ok.preview, /secret/, "secrets never appear in a preview");
  assert.match(planEdit({ file: ".env", edit: { op: "set_env", by: "owner", fields: { ELIXIR_MCP_TOKEN: "x" } }, current: env, by: "9" }).error, /not a setting the DM may change/);
  assert.match(planEdit({ file: ".env", edit: { op: "set_env", by: "owner", fields: { REVIEW_AT: "sometime" } }, current: env, by: "9" }).error, /REVIEW_AT/);
  assert.match(planEdit({ file: ".env", edit: { op: "set_env", by: "owner", fields: { CLAUDE_MODEL: "claude-9" } }, current: env, by: "9" }).error, /price|priced|claude-9/i);
  assert.match(planEdit({ file: ".env", edit: { op: "set_env", by: "owner", fields: { TIMEZONE: "CST" } }, current: env, by: "9" }).error, /IANA/);
  assert.match(planEdit({ file: ".env", edit: { op: "set_env", by: "owner", fields: { ADMIN_USER_IDS: "12345678" } }, current: env, by: "9" }).error, /remove you as an admin/);
  assert.equal(planEdit({ file: ".env", edit: { op: "set_env", by: "owner", fields: { ADMIN_USER_IDS: "9, 12345678" } }, current: env, by: "9" }).ok, false, "9 is too short to be a Discord id; the check is numeric ids");
  assert.match(planEdit({ file: ".env", edit: { op: "set_env", fields: { MONTHLY_BUDGET_USD: "1" } }, current: env }).error, /operator's/, "the review cannot touch settings");
  assert.match(planEdit({ file: ".env", edit: { op: "set_env", by: "owner", fields: { MONTHLY_BUDGET_USD: "20.00" } }, current: env, by: "9" }).error, /nothing would change/);
});

test("a channel setting resolves a #name to an id the bot is granted in", async () => {
  const { checkSetting } = await import("../src/settings.js");
  const entries = [{ id: "77", name: "news", role: "post" }, { id: "2", name: "ask-bot", role: "ask" }];
  assert.deepEqual(checkSetting("CHANNEL_ASK", "#ask-bot", { entries }), { ok: true, value: "2", shown: "#ask-bot" });
  assert.deepEqual(checkSetting("CHANNEL_ASK", "77", { entries }), { ok: true, value: "77", shown: "#news" });
  assert.match(checkSetting("CHANNEL_ASK", "#elsewhere", { entries }).error, /not a channel the bot is granted in/);
});
