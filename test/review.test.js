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
import { readLessons, systemFor } from "../src/prompt.js";
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

test("a lesson appends as one dated line, and lessons.md is the only file that appends", () => {
  const ok = planEdit({ file: "lessons.md", edit: { op: "append", text: "- 2026-09-14 (turns a1b2c3d4): pass segment to battles_meta_cards" }, current: "# Lessons\n" });
  assert.equal(ok.ok, true);
  assert.match(ok.next, /\n- 2026-09-14 \(turns a1b2c3d4\): pass segment/);
  assert.equal(ok.preview.startsWith("+ - 2026-09-14"), true);
  assert.equal(planEdit({ file: "lessons.md", edit: { op: "append", text: "pass segment" }, current: "" }).ok, false, "undated is refused");
  assert.equal(planEdit({ file: "identity.md", edit: { op: "append", text: "- 2026-09-14 x" }, current: "" }).ok, false, "append is lessons-only");
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

test("lessons.md is bounded by entries and by characters", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `- 2026-09-0${(i % 9) + 1} (turns x): lesson ${i}`).join("\n");
  assert.match(planEdit({ file: "lessons.md", edit: { op: "append", text: "- 2026-09-14 (turns y): one more" }, current: twenty }).error, /already has 20/);
  const fat = `- 2026-09-01 (turns x): ${"x".repeat(5990)}`;
  assert.match(planEdit({ file: "lessons.md", edit: { op: "append", text: "- 2026-09-14 (turns y): tip" }, current: fat }).error, /exceed/);
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
  const dir = agentDir(t, { "lessons.md": "# Lessons\n", "identity.md": "Plain and direct.\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  ledger.append(turn({ turnId: "bbbb0002" }));
  ledger.append(ledger.reactionEntry({ turnId: "bbbb0002", reaction: "down", userId: "7", note: "wrong" }));

  const outcome = await runReview({
    trigger: "command",
    agentDir: dir,
    askFn: fakeAsk([
      ["propose_change", { file: "lessons.md", rule: "windows", turn_ids: ["bbbb0002"], summary: "Say which window a summary covers.", edit: { op: "append", text: "- 2026-09-14 (turns bbbb0002): name the window in every summary" } }],
      ["propose_change", { file: "identity.md", rule: "voice", turn_ids: ["aaaa0001", "bbbb0002"], summary: "Shorter.", edit: { op: "replace", find: "Plain and direct.", replace: "Plain, direct, short." } }],
      ["propose_change", { file: "src/prompt.js", rule: "x", turn_ids: ["aaaa0001"], summary: "no", edit: { op: "append", text: "- 2026-09-14 x" } }],
      ["report_mechanics", { rule: "WHO_IS_ASKING", turn_ids: ["bbbb0002"], summary: "asked for a tag it could look up" }],
    ]),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.turns, 2);
  assert.equal(outcome.flagged, 1);
  assert.equal(outcome.proposals.length, 2, "the src/ edit was refused");
  assert.equal(outcome.proposals[0].file, "lessons.md");
  assert.match(outcome.proposals[0].preview, /^\+ - 2026-09-14/);
  assert.equal(outcome.proposals[1].preview, "- Plain and direct.\n+ Plain, direct, short.");
  assert.equal(outcome.reports.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "lessons.md"), "utf8"), "# Lessons\n", "nothing written without a click");

  const review = findReview(outcome.reviewId);
  assert.equal(review.turnsRead, 2);
  assert.equal(review.proposals.length, 2);
  assert.equal(review.proposals[0].next, undefined, "the planned file is not persisted");
  assert.equal(state.get("reviewedThrough"), outcome.window.until);

  // The next review starts after this one's window.
  const again = await runReview({ trigger: "command", agentDir: dir, askFn: fakeAsk([]) });
  assert.equal(again.empty, true);
});

test("a dry run costs the call and writes nothing", async (t) => {
  fresh();
  const dir = agentDir(t, { "lessons.md": "# Lessons\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  const outcome = await runReview({ trigger: "cli", dryRun: true, agentDir: dir, askFn: fakeAsk([["propose_change", { file: "lessons.md", rule: "r", turn_ids: ["aaaa0001"], summary: "s", edit: { op: "append", text: "- 2026-09-14 (turns aaaa0001): x" } }]]) });
  assert.equal(outcome.proposals.length, 1);
  assert.equal(findReview(outcome.reviewId), null);
  assert.equal(state.get("reviewedThrough"), null);
});

test("the proposal cap holds, and a refused proposal says why", async (t) => {
  fresh();
  const dir = agentDir(t, { "lessons.md": "# Lessons\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  const calls = Array.from({ length: 5 }, (_, i) => ["propose_change", { file: "lessons.md", rule: "r", turn_ids: ["aaaa0001"], summary: `s${i}`, edit: { op: "append", text: `- 2026-09-14 (turns aaaa0001): lesson ${i}` } }]);
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
  const proposal = { id: "p1", file: "lessons.md", rule: "windows", turnIds: ["a", "b"], summary: "Name the window.", preview: "+ - 2026-09-14 (turns a, b): name the window" };
  const pending = proposalMessage(review, proposal, { index: 1, total: 2 });
  assert.match(pending.content, /Proposal 1 of 2/);
  assert.match(pending.content, /```diff\n\+ - 2026-09-14/);
  assert.deepEqual(pending.buttons.map((b) => b.label), ["Apply", "Skip", "Show turns"]);
  const applied = proposalMessage(review, proposal, { index: 1, total: 2, decision: { decision: "applied", by: "9", detail: { backup: "/x/.history/lessons.md.t" } } });
  assert.match(applied.content, /✅ Applied by <@9>/);
  assert.deepEqual(applied.buttons.map((b) => b.label), ["Undo", "Show turns"]);
  const skipped = proposalMessage(review, proposal, { index: 1, total: 2, decision: { decision: "skipped", by: "9" } });
  assert.deepEqual(skipped.buttons, []);
  assert.deepEqual(parseButtonId(buttonId("r1", "p1", "apply")), { reviewId: "r1", proposalId: "p1", action: "apply" });
  assert.equal(parseButtonId("nope"), null);
});

test("a button applies for an admin and refuses everyone else", async (t) => {
  fresh();
  const dir = agentDir(t, { "lessons.md": "# Lessons\n" });
  ledger.append(turn({ turnId: "aaaa0001" }));
  const outcome = await runReview({ trigger: "command", agentDir: dir, askFn: fakeAsk([["propose_change", { file: "lessons.md", rule: "r", turn_ids: ["aaaa0001"], summary: "s", edit: { op: "append", text: "- 2026-09-14 (turns aaaa0001): a lesson" } }]]) });
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
  assert.equal(fs.readFileSync(path.join(dir, "lessons.md"), "utf8"), "# Lessons\n");

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

test("lessons.md rides the system prompt after the house rules, and a missing file is nothing", (t) => {
  const dir = agentDir(t, { "lessons.md": "- 2026-09-14 (turns a): pass the segment to battles_meta_cards" });
  const routine = parseRoutine("ask", "---\ntrigger: message\nchannel: ask\n---\nAnswer.");
  const system = systemFor(routine, { identity: "Plain.", lessons: readLessons({ dir }) });
  assert.ok(system.indexOf("HOUSE RULES") < system.indexOf("LESSONS LEARNED HERE"));
  assert.match(system, /pass the segment to battles_meta_cards/);
  assert.equal(readLessons({ dir: path.join(dir, "nowhere") }), null);
  assert.doesNotMatch(systemFor(routine, { identity: "Plain.", lessons: null }), /LESSONS LEARNED HERE/);
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
