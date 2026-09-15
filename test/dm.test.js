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
  config.adminUserIds = new Set([ADMIN]);
  _drafts.clear();
}

function dm(content, { userId = ADMIN, history = [] } = {}) {
  const sent = [];
  const channel = {
    id: "dm-chan",
    send: async (body) => {
      const entry = {
        id: `s${sent.length + 1}`,
        content: typeof body === "string" ? body : body.content,
        components: body.components ?? [],
      };
      sent.push(entry);
      return {
        id: entry.id,
        edit: async (next) =>
          Object.assign(entry, typeof next === "string" ? { content: next } : { content: next.content }),
      };
    },
    messages: {
      fetch: async () =>
        new Map(
          history.map((m, i) => [
            `h${i}`,
            {
              id: `h${i}`,
              author: { id: m.bot ? "bot" : userId, bot: Boolean(m.bot), username: "jamie" },
              cleanContent: m.text,
              pinned: false,
            },
          ]),
        ),
    },
  };
  return {
    sent,
    message: {
      id: "m1",
      guildId: null,
      cleanContent: content,
      author: { id: userId, username: "jamie", bot: false },
      channel,
      attachments: new Map(),
    },
  };
}

const turnFixture = (turnId) => {
  const routine = parseRoutine("ask", "---\ntrigger: message\nchannel: ask\n---\nAnswer.");
  return ledger.turnEntry({
    routine,
    lane: "ask",
    result: {
      turnId,
      text: "9-2 today.",
      called: ["players_summary"],
      errors: [],
      trace: [{ kind: "tool", name: "players_summary", input: {}, shape: "1 players", result: "{}" }],
      envelopes: [],
      usd: 0.01,
      ms: 1,
      rounds: 1,
      stopReason: "end_turn",
      model: "m",
      effort: "e",
    },
    system: "s",
    input: {
      kind: "message",
      asker: { id: "42", name: "T" },
      channelId: "2",
      threadId: null,
      question: "how am I playing?",
      history: [],
    },
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
  const askFn = async ({ localTools, system, messages }) => {
    assert.match(system, /talking to the person who runs you/);
    assert.match(messages.at(-1).content, /jamie \(discord:9\): we call war days boat days/);
    const propose = localTools.find((t) => t.name === "propose_change");
    const bad = await propose.handler({
      file: "memory.md",
      summary: "x",
      edit: { op: "append", text: "- 2026-09-14 (turns abc): no" },
    });
    assert.match(bad.error, /from owner/, "a DM entry must carry its provenance");
    const ok = await propose.handler({
      file: "memory.md",
      summary: "Remember the clan's word for war days.",
      edit: { op: "append", text: `- ${today()} (from owner): we call war days "boat days"` },
    });
    assert.equal(ok.ok, true);
    return {
      ok: true,
      text: "Got it — I will call them boat days once you apply.",
      called: ["propose_change"],
      errors: [],
      trace: [],
      envelopes: [],
      usd: 0.02,
      usage: null,
      turnId: "dm000001",
      ms: 5,
      rounds: 2,
      stopReason: "end_turn",
      model: "m",
      effort: "e",
    };
  };
  await handleDm(message, { askFn });
  const proposal = sent.find((s) => s.components.length);
  assert.ok(proposal, "a proposal message with buttons");
  assert.match(proposal.content, /```diff\n\+ - \d{4}-\d{2}-\d{2} \(from owner\): we call war days "boat days"/);
  assert.deepEqual(
    proposal.components[0].components.map((b) => b.label),
    ["Apply", "Try it", "Skip", "Show turns"],
  );
  const records = ledger.readRecords({ since: today() });
  assert.deepEqual(
    records.map((r) => r.kind),
    ["review", "turn"],
  );
  assert.equal(records[0].trigger, "dm");
  assert.equal(records[1].lane, "dm");
});

test("why <turn id> and a pasted message link both find the transcript", async () => {
  fresh();
  ledger.append(turnFixture("abcd1234"));
  state.rememberTurn(
    "abcd1234",
    { routine: "ask", lane: "ask", question: "q", answer: "a", called: [], errors: [], requestIds: [] },
    ["100200300"],
  );
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
  const channel = {
    id: "77",
    name: "news",
    sent: [],
    send: async (text) => (channel.sent.push(text), { id: `n${channel.sent.length}` }),
  };
  directory.configure({
    list: () => [{ id: "77", name: "news", role: "post" }],
    resolve: async (id) => (id === "77" ? channel : null),
  });

  const result = {
    turnId: "draft001",
    text: "",
    called: ["clans_roster", "post_message"],
    errors: [],
    trace: [],
    envelopes: [],
    usd: 0.03,
    ms: 1,
    rounds: 1,
    stopReason: "end_turn",
    model: "m",
    effort: "e",
    usage: null,
  };
  const runFn = async (routine, { dryRun }) => {
    assert.equal(dryRun, true, "try never posts");
    return {
      ok: true,
      skipped: false,
      text: "",
      posts: [{ channel: "#news", text: "**canavar** — 9-2 today." }],
      result,
    };
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

test("a long paste that Discord turned into message.txt is read as the message", async () => {
  fresh();
  const { message } = dm("Please use what is helpful in here:");
  message.attachments = new Map([
    [
      "a1",
      {
        name: "message.txt",
        contentType: "text/plain; charset=utf-8",
        size: 6000,
        url: "https://cdn.discordapp.com/attachments/x/message.txt",
      },
    ],
  ]);
  let seen;
  await handleDm(message, {
    fetchFn: async (url) => ({
      text: async () =>
        url.endsWith("message.txt")
          ? "About the Clan\n\nWhy the name POAP KINGS?\nThe clan began by publishing POAP collectibles."
          : "",
    }),
    askFn: async ({ messages }) => {
      seen = messages.at(-1).content;
      return {
        ok: true,
        text: "Read it.",
        called: [],
        errors: [],
        trace: [],
        envelopes: [],
        usd: 0.01,
        usage: null,
        turnId: "dm000002",
        ms: 1,
        rounds: 1,
        stopReason: "end_turn",
        model: "m",
        effort: "e",
      };
    },
  });
  assert.match(seen, /Please use what is helpful in here:/);
  assert.match(seen, /--- message\.txt ---\nAbout the Clan/);
  assert.match(seen, /POAP collectibles/);
});

test("a non-text attachment is ignored and an oversized one is named, not read", async () => {
  fresh();
  const { message } = dm("here");
  message.attachments = new Map([
    ["img", { name: "deck.png", contentType: "image/png", size: 100, url: "https://cdn.discordapp.com/x/deck.png" }],
    [
      "big",
      { name: "dump.txt", contentType: "text/plain", size: 5_000_000, url: "https://cdn.discordapp.com/x/dump.txt" },
    ],
  ]);
  let seen;
  await handleDm(message, {
    fetchFn: async () => assert.fail("nothing should be fetched"),
    askFn: async ({ messages }) => (
      (seen = messages.at(-1).content),
      {
        ok: true,
        text: "ok",
        called: [],
        errors: [],
        trace: [],
        envelopes: [],
        usd: 0.01,
        usage: null,
        turnId: "dm000003",
        ms: 1,
        rounds: 1,
        stopReason: "end_turn",
        model: "m",
        effort: "e",
      }
    ),
  });
  assert.doesNotMatch(seen, /deck\.png/);
  assert.match(seen, /dump\.txt: 5000000 bytes, too large/);
});

test("a bot with nothing enabled introduces itself: where it may post, what it can run, how to say yes", async () => {
  fresh();
  const sent = [];
  notify.configure({ client: { users: { fetch: async (id) => ({ send: async (m) => sent.push([id, m.content]) }) } } });
  directory.configure({
    list: () => [
      { id: "1", name: "elixir", role: "read" },
      { id: "77", name: "news", role: "post" },
      { id: "2", name: "ask-elixir", role: "ask" },
    ],
    resolve: null,
  });
  const { introduce } = await import("../src/dm.js");
  const reached = await introduce({ guildName: "POAP KINGS Discord", subject: { name: "POAP KINGS", members: 47 } });
  assert.equal(reached, 1);
  const text = sent.map((s) => s[1]).join("\n");
  assert.match(
    text,
    /connected to \*\*POAP KINGS Discord\*\* for \*\*POAP KINGS\*\* \(47 members\), and nothing runs yet/,
  );
  assert.match(text, /I may post in #news; questions are answered in #ask-elixir/);
  assert.doesNotMatch(text, /#elixir/);
  assert.match(text, /• \*\*ask\*\* — Answers members' questions/);
  assert.match(text, /• \*\*war-deck-check\*\* — /);
  assert.match(text, /Say \*\*the usual\*\*/);
  assert.equal(await introduce({ guildName: "x" }), 0, "once a day, not once a boot loop");
  directory.configure({ list: () => [], resolve: null });
  notify.configure({ client: null });
});

test("the DM lane can list the shipped examples with their briefs, and the channels", async () => {
  fresh();
  directory.configure({ list: () => [{ id: "77", name: "news", role: "post", topic: "Clan news" }], resolve: null });
  const { message } = dm("what can you run?");
  let tools;
  await handleDm(message, {
    askFn: async ({ localTools }) => {
      tools = Object.fromEntries(localTools.map((t) => [t.name, t]));
      return {
        ok: true,
        text: "…",
        called: [],
        errors: [],
        trace: [],
        envelopes: [],
        usd: 0.01,
        usage: null,
        turnId: "dm000004",
        ms: 1,
        rounds: 1,
        stopReason: "end_turn",
        model: "m",
        effort: "e",
      };
    },
  });
  const examples = await tools.list_example_routines.handler({});
  assert.equal(examples.ok, true);
  const ask = examples.body.examples.find((e) => e.key === "ask");
  assert.equal(ask.fields.trigger, "message");
  assert.match(ask.brief, /\S/);
  assert.deepEqual(examples.body.the_usual, ["ask", "clan-feed", "notable-movers", "war-deck-check"]);
  const channels = await tools.list_channels.handler({});
  assert.equal(channels.body.channels[0].name, "news");
  assert.equal(channels.body.channels[0].topic, "Clan news");
  assert.equal(channels.body.bound.ask, "2", "CHANNEL_ASK from the test env, not in the directory");
  directory.configure({ list: () => [], resolve: null });
});

test("retract deletes every message a turn produced and records it on the turn", async () => {
  fresh();
  const routine = parseRoutine("movers", "---\ntrigger: schedule\nat: 01:00\n---\nMovers.");
  ledger.append(
    ledger.turnEntry({
      routine,
      lane: "routines",
      result: {
        turnId: "ab120001",
        text: "",
        called: [],
        errors: [],
        trace: [],
        envelopes: [],
        usd: 0.01,
        ms: 1,
        rounds: 1,
        stopReason: "end_turn",
        model: "m",
        effort: "e",
      },
      system: "s",
      input: { kind: "schedule", brief: "Movers." },
      output: {
        text: "**x** — 1-9.",
        posts: [{ channelId: "77", channelName: "news", messageIds: ["m1", "m2"], text: "**x** — 1-9." }],
        skipped: false,
        footers: [],
        ungrounded: false,
        friction: null,
      },
    }),
  );
  state.rememberTurn(
    "ab120001",
    { routine: "movers", lane: "routines", question: "q", answer: "a", called: [], errors: [], requestIds: [] },
    ["m1", "m2", "m2-note"],
  );
  const deleted = [];
  const { sent, message } = dm("retract ab120001 — named the worst players in #news");
  await handleDm(message, { deleteFn: async (channelId, id) => deleted.push([channelId, id]) });
  assert.deepEqual(deleted.sort(), [
    ["77", "m1"],
    ["77", "m2"],
    ["77", "m2-note"],
  ]);
  assert.match(sent[0].content, /deleted 3 messages/);
  const [turn] = ledger.readTurns({ since: today() });
  assert.equal(turn.retractions.length, 1);
  assert.equal(turn.retractions[0].deleted, 3);
  assert.match(turn.retractions[0].reason, /named the worst players/);
  const { isFlagged } = await import("../src/review.js");
  assert.equal(isFlagged(turn), true);
});

test("a DM reply that claims a filing with no call behind it is swept: filed for real, or corrected under the claim", async () => {
  // The operator's DM of 2026-09-15: "Filing as a bug is right call" ->
  // "Filed as a data-quality bug against elixir_timeline ..." with four
  // reads and no elixir_feedback call. The lane had no sweep at all.
  fresh();
  const modelTurn = (text) => ({
    ok: true,
    text,
    called: ["players_search", "elixir_timeline", "players_profile"],
    errors: [],
    trace: [],
    envelopes: [],
    usd: 0.05,
    usage: null,
    turnId: "dm00claim",
    ms: 5,
    rounds: 1,
    stopReason: "end_turn",
    model: "m",
    effort: "e",
  });
  const claim =
    "Filed as a data-quality bug against elixir_timeline, with the request_id attached so the maintainer can see exactly what I saw.";

  // The sweep makes the claim true: the footer names what was filed.
  const swept = [];
  const filed = dm("Filing as a bug is right call.");
  await handleDm(filed.message, {
    askFn: async () => modelTurn(claim),
    sweepFn: async (args) => {
      swept.push(args);
      return "arena move missing from the clan timeline";
    },
  });
  assert.equal(swept.length, 1);
  assert.equal(swept[0].friction.reason, "claimed_filing");
  assert.equal(swept[0].lane, "review", "DM turns are the operator's pot");
  assert.equal(swept[0].turnId, "dm00claim");
  assert.equal(filed.sent.at(-1).content, "-# 📮 Filed with Elixir MCP: arena move missing from the clan timeline");
  const records = ledger.readRecords({ since: today() });
  assert.deepEqual(
    records.map((r) => r.kind),
    ["turn", "filed"],
  );
  assert.equal(records[0].output.friction, "claimed_filing");

  // The sweep declines: the reader is told, under the claim, that nothing
  // was filed this turn.
  fresh();
  const declined = dm("Filing as a bug is right call.");
  await handleDm(declined.message, {
    askFn: async () => modelTurn(claim),
    sweepFn: async () => null,
  });
  assert.match(declined.sent.at(-1).content, /^-# ⚠️ No feedback was filed with Elixir MCP in this turn/);

  // A reply whose calls include the filing is not swept and gets no footer.
  fresh();
  const honest = dm("Filing as a bug is right call.");
  await handleDm(honest.message, {
    askFn: async () => ({ ...modelTurn(claim), called: ["elixir_timeline", "elixir_feedback"] }),
    sweepFn: async () => assert.fail("nothing to sweep"),
  });
  assert.equal(honest.sent.at(-1).content, claim);
});
