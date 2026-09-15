/**
 * The DM is the operator's console. What must hold: a stranger gets one
 * line and nothing else; the operator's statement becomes a proposal with a
 * diff and a button, never a silent write; "why" finds the turn; "try" posts
 * nothing and "post it" posts exactly what was shown; notices reach the
 * admins once, not once a minute.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import * as ledger from "../src/ledger.js";
import * as state from "../src/state.js";
import { config } from "../src/config.js";
import { handleDm, _drafts } from "../src/dm.js";
import * as notify from "../src/notify.js";
import { parseRoutine } from "../src/routines.js";
import * as directory from "../src/directory.js";

const today = () => new Date().toISOString().slice(0, 10);
const ADMIN = "9";

function fresh() {
  fs.rmSync(ledger.LEDGER_DIR, { recursive: true, force: true });
  state.set({ dmRefused: {}, notices: {} });
  config.adminUserIds.add(ADMIN);
  _drafts.clear();
}

function dm(content, { userId = ADMIN, history = [] } = {}) {
  const sent = [];
  const channel = {
    id: "dm-chan",
    send: async (body) => {
      const entry = { id: `s${sent.length + 1}`, content: typeof body === "string" ? body : body.content, components: body.components ?? [] };
      sent.push(entry);
      return { id: entry.id, edit: async (next) => Object.assign(entry, typeof next === "string" ? { content: next } : { content: next.content }) };
    },
    messages: { fetch: async () => new Map(history.map((m, i) => [`h${i}`, { id: `h${i}`, author: { id: m.bot ? "bot" : userId, bot: Boolean(m.bot), username: "jamie" }, cleanContent: m.text, pinned: false }])) },
  };
  return { sent, message: { id: "m1", guildId: null, cleanContent: content, author: { id: userId, username: "jamie", bot: false }, channel } };
}

const turnFixture = (turnId) => {
  const routine = parseRoutine("ask", "---\ntrigger: message\nchannel: ask\n---\nAnswer.");
  return ledger.turnEntry({
    routine,
    lane: "ask",
    result: { turnId, text: "9-2 today.", called: ["players_summary"], errors: [], trace: [{ kind: "tool", name: "players_summary", input: {}, shape: "1 players", result: "{}" }], envelopes: [], usd: 0.01, ms: 1, rounds: 1, stopReason: "end_turn", model: "m", effort: "e" },
    system: "s",
    input: { kind: "message", asker: { id: "42", name: "T" }, channelId: "2", threadId: null, question: "how am I playing?", history: [] },
    output: { text: "9-2 today.", messageIds: ["100200300"], footers: [], ungrounded: false, friction: null },
  });
};

test("a stranger gets one polite line a day and nothing runs", async () => {
  fresh();
  const first = dm("hello", { userId: "stranger" });
  const out = await handleDm(first.message, { askFn: async () => assert.fail("no model call for a stranger") });
  assert.equal(out.refused, true);
  assert.match(first.sent[0].content, /only take direct messages from whoever runs me/);
  const second = dm("hello again", { userId: "stranger" });
  await handleDm(second.message, { askFn: async () => assert.fail("no model call") });
  assert.equal(second.sent.length, 0, "silence the second time");
});

test("the operator's fact becomes a memory proposal with a diff and an Apply button, and nothing is written", async () => {
  fresh();
  const { sent, message } = dm("we call war days boat days");
  const askFn = async ({ localTools, system, messages, serverTools }) => {
    assert.match(system, /talking to the person who runs you/);
    assert.equal(serverTools?.[0]?.name, "web_fetch", "the operator's links are readable in this lane only");
    assert.match(messages.at(-1).content, /jamie \(discord:9\): we call war days boat days/);
    const propose = localTools.find((t) => t.name === "propose_change");
    const bad = await propose.handler({ file: "memory.md", summary: "x", edit: { op: "append", text: "- 2026-09-14 (turns abc): no" } });
    assert.match(bad.error, /from owner/, "a DM entry must carry its provenance");
    const ok = await propose.handler({ file: "memory.md", summary: "Remember the clan's word for war days.", edit: { op: "append", text: `- ${today()} (from owner): we call war days "boat days"` } });
    assert.equal(ok.ok, true);
    return { ok: true, text: "Got it — I will call them boat days once you apply.", called: ["propose_change"], errors: [], trace: [], envelopes: [], usd: 0.02, usage: null, turnId: "dm000001", ms: 5, rounds: 2, stopReason: "end_turn", model: "m", effort: "e" };
  };
  await handleDm(message, { askFn });
  const proposal = sent.find((s) => s.components.length);
  assert.ok(proposal, "a proposal message with buttons");
  assert.match(proposal.content, /```diff\n\+ - \d{4}-\d{2}-\d{2} \(from owner\): we call war days "boat days"/);
  assert.deepEqual(proposal.components[0].components.map((b) => b.label), ["Apply", "Skip", "Show turns"]);
  const records = ledger.readRecords({ since: today() });
  assert.deepEqual(records.map((r) => r.kind), ["review", "turn"]);
  assert.equal(records[0].trigger, "dm");
  assert.equal(records[1].lane, "dm");
});

test("why <turn id> and a pasted message link both find the transcript", async () => {
  fresh();
  ledger.append(turnFixture("abcd1234"));
  state.rememberTurn("abcd1234", { routine: "ask", lane: "ask", question: "q", answer: "a", called: [], errors: [], requestIds: [] }, ["100200300"]);
  const byId = dm("why abcd1234");
  await handleDm(byId.message, { askFn: async () => assert.fail("deterministic, no model") });
  assert.match(byId.sent[0].content, /turn `abcd1234`/);
  assert.match(byId.sent[0].content, /players_summary/);
  const byLink = dm("https://discord.com/channels/1/2/100200300");
  await handleDm(byLink.message, { askFn: async () => assert.fail("no model") });
  assert.match(byLink.sent[0].content, /turn `abcd1234`/);
  const missing = dm("why ffffffff");
  await handleDm(missing.message, { askFn: async () => assert.fail("no model") });
  assert.match(missing.sent[0].content, /no turn `ffffffff`/);
});

test("try rehearses a routine and posts nothing; post it sends exactly that, then the draft is gone", async (t) => {
  fresh();
  const dir = fs.mkdtempSync("/tmp/dm-agent-");
  fs.mkdirSync(`${dir}/routines`);
  fs.writeFileSync(`${dir}/routines/movers.md`, "---\ntrigger: schedule\nat: 01:00\n---\nName movers.");
  const previous = config.agentDir;
  Object.defineProperty(config, "agentDir", { value: dir, configurable: true, writable: true });
  t.after(() => {
    Object.defineProperty(config, "agentDir", { value: previous, configurable: true, writable: true });
    fs.rmSync(dir, { recursive: true, force: true });
    directory.configure({ list: () => [], resolve: null });
  });
  const channel = { id: "77", name: "news", sent: [], send: async (text) => (channel.sent.push(text), { id: `n${channel.sent.length}` }) };
  directory.configure({ list: () => [{ id: "77", name: "news", role: "post" }], resolve: async (id) => (id === "77" ? channel : null) });

  const result = { turnId: "draft001", text: "", called: ["clans_roster", "post_message"], errors: [], trace: [], envelopes: [], usd: 0.03, ms: 1, rounds: 1, stopReason: "end_turn", model: "m", effort: "e", usage: null };
  const runFn = async (routine, { dryRun }) => {
    assert.equal(dryRun, true, "try never posts");
    return { ok: true, skipped: false, text: "", posts: [{ channel: "#news", text: "**canavar** — 9-2 today." }], result };
  };
  const rehearsal = dm("try movers");
  await handleDm(rehearsal.message, { runFn });
  assert.equal(channel.sent.length, 0, "nothing posted by try");
  assert.match(rehearsal.sent.map((s) => s.content).join("\n"), /\*\*#news\*\*\n\*\*canavar\*\* — 9-2 today\./);
  assert.match(rehearsal.sent.at(-1).content, /say \*\*post it\*\*/);
  assert.equal(_drafts.size, 1);

  const posted = [];
  const go = dm("post it");
  await handleDm(go.message, { postFn: async (ch, text) => (posted.push([ch.id, text]), [{ id: "sent-1" }]) });
  assert.deepEqual(posted, [["77", "**canavar** — 9-2 today."]]);
  assert.match(go.sent.at(-1).content, /Posted to #news/);
  assert.equal(_drafts.size, 0);
  const turns = ledger.readTurns({ since: today() });
  assert.equal(turns.length, 1, "the posted draft is in the ledger");
  assert.equal(turns[0].input.viaDm, true);
  assert.equal(turns[0].output.posts[0].channelName, "news");

  const again = dm("post it");
  await handleDm(again.message, {});
  assert.match(again.sent[0].content, /Nothing to post/);
});

test("memory and budget answer without a model", async () => {
  fresh();
  const m = dm("memory");
  await handleDm(m.message, { askFn: async () => assert.fail("no model") });
  assert.match(m.sent[0].content, /Memory|Tell me something to remember/);
  const b = dm("budget");
  await handleDm(b.message, { askFn: async () => assert.fail("no model") });
  assert.match(b.sent[0].content, /Spend so far/);
});

test("a notice reaches every admin once, then stays quiet for the hour", async () => {
  fresh();
  const sent = [];
  notify.configure({ client: { users: { fetch: async (id) => ({ send: async (m) => sent.push([id, m.content]) }) } } });
  assert.equal(await notify.notify("routine failed", "movers: overloaded"), 1);
  assert.equal(await notify.notify("routine failed", "movers: overloaded"), 0, "same notice, same hour");
  assert.equal(await notify.notify("routine failed", "movers: something else"), 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /🔔 \*\*routine failed\*\* · movers: overloaded/);
  notify.configure({ client: null });
  assert.equal(await notify.notify("budget", "x"), 0, "no client is a log line, not a throw");
});
