/**
 * The runner is what every trigger except a member's message goes through, so
 * a bug here is silent: a scheduled post that never lands, or the word SKIP
 * arriving in a channel as though it were the news.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runRoutine } from "../src/run.js";
import { parseRoutine } from "../src/routines.js";

function fakeChannel() {
  const sent = [];
  const channel = {
    sent,
    send: (text) => {
      const message = { text, replies: [] };
      sent.push(message);
      return Promise.resolve({
        reply: (body) => {
          message.replies.push(typeof body === "string" ? body : body.content);
          return Promise.resolve({});
        },
      });
    },
    messages: { fetch: () => Promise.resolve(new Map()) },
  };
  return channel;
}

const answer = (text, extra = {}) => ({
  ok: true,
  text,
  called: ["war_current"],
  errors: [],
  trace: [{ kind: "tool", name: "war_current", input: {}, shape: "1 clans" }],
  envelopes: [],
  usd: 0.01,
  turnId: "aaaa1111",
  ms: 1200,
  rounds: 1,
  stopReason: "end_turn",
  truncated: false,
  model: "claude-sonnet-5",
  effort: "medium",
  serverVersion: "0.31.0+tools.abc",
  ...extra,
});

const routine = (fields, body = "Report the war decks, and skip if it is not a war day.") =>
  parseRoutine(
    "war-deck-check",
    `---\n${Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n---\n${body}`,
  );

test("a routine's answer reaches its channel", async () => {
  const channel = fakeChannel();
  const run = await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), {
    channel,
    askFn: async () => answer("**War decks** — 3 untouched."),
  });
  assert.equal(run.ok, true);
  assert.equal(run.skipped, false);
  assert.equal(channel.sent[0].text, "**War decks** — 3 untouched.");
  assert.equal(channel.sent[0].replies.length, 0, "no trace unless asked for");
});

test("SKIP posts nothing at all", async () => {
  const channel = fakeChannel();
  const run = await runRoutine(
    routine({
      trigger: "schedule",
      channel: "pulse",
      at: "01:00",
      may_skip: "true",
    }),
    {
      channel,
      askFn: async () => answer('period.kind is "training".\n\nSKIP'),
    },
  );
  assert.equal(run.skipped, true);
  assert.equal(channel.sent.length, 0, "a quiet day must stay quiet");
});

test("a routine that may NOT skip posts what it said", async () => {
  // Otherwise a prompt bug is invisible: the routine looks like it ran and the
  // channel looks like a quiet day, forever.
  const channel = fakeChannel();
  const run = await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), {
    channel,
    askFn: async () => answer("SKIP"),
  });
  assert.equal(run.skipped, false);
  assert.equal(channel.sent.length, 1);
});

test("trace: true attaches the diagnostics under the post", async () => {
  const channel = fakeChannel();
  await runRoutine(
    routine({
      trigger: "schedule",
      channel: "pulse",
      at: "01:00",
      trace: "true",
    }),
    {
      channel,
      askFn: async () => answer("**War decks** — 3 untouched."),
    },
  );
  assert.match(channel.sent[0].replies[0], /war_current/);
  assert.match(channel.sent[0].replies[0], /aaaa1111/);
});

test("a long post is split rather than truncated", async () => {
  const channel = fakeChannel();
  const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  await runRoutine(
    routine({
      trigger: "schedule",
      channel: "pulse",
      at: "01:00",
      max_chars: 900,
    }),
    {
      channel,
      askFn: async () => answer(long),
    },
  );
  assert.ok(channel.sent.length > 1, "expected more than one message");
  for (const message of channel.sent) assert.ok(message.text.length <= 900);
  assert.equal(channel.sent.map((m) => m.text).join("\n"), long);
});

test("a dry run composes without touching Discord", async () => {
  const run = await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), {
    dryRun: true,
    askFn: async () => answer("Would have posted this."),
  });
  assert.equal(run.text, "Would have posted this.");
});

test("a failed turn is reported, not posted", async () => {
  const channel = fakeChannel();
  const run = await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), {
    channel,
    askFn: async () => ({
      ok: false,
      error: "overloaded_error",
      called: [],
      errors: [],
      trace: [],
    }),
  });
  assert.equal(run.ok, false);
  assert.equal(run.error, "overloaded_error");
  assert.equal(channel.sent.length, 0);
});

/**
 * The runner has to REFUSE, not merely report.
 *
 * A budget checked after the fact is a receipt. These pin that a spent lane
 * never reaches the model at all — the injected askFn is the proof, because a
 * call that never happens cannot cost anything.
 */
test("a routine whose lane is spent never calls the model", async () => {
  const { config } = await import("../src/config.js");
  const budget = await import("../src/budget.js");
  const fs = await import("node:fs");
  fs.rmSync(process.env.STATE_PATH, { force: true });
  config.monthlyBudgetUsd = 1;
  budget.record("routines", 1);

  const channel = fakeChannel();
  let called = false;
  const run = await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), {
    channel,
    askFn: async () => {
      called = true;
      return answer("should never be composed");
    },
  });

  assert.equal(called, false, "the model was not called");
  assert.equal(run.ok, false);
  assert.match(run.error, /^budget:/);
  assert.equal(channel.sent.length, 0);
  config.monthlyBudgetUsd = null;
  fs.rmSync(process.env.STATE_PATH, { force: true });
});

test("the runner charges the lane the trigger belongs to", async () => {
  // Recording happens inside the model call (one place, always), so what the
  // RUNNER owes is the lane it hands over. An injected askFn is exactly the
  // seam to read that from.
  const channel = fakeChannel();
  let seen = null;
  await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), {
    channel,
    askFn: async (args) => {
      seen = args;
      return answer("posted");
    },
  });
  assert.equal(seen.lane, "routines", "a scheduled post is the operator's cost");
  assert.equal(seen.routineKey, "war-deck-check");
  assert.equal(seen.maxTokens, 6000, "the routine's own output ceiling");
});

/**
 * A routine remembers what IT posted, and reads that back next time — not
 * whatever the channel happened to hold, which in a shared channel was other
 * routines' posts and never its own.
 */
test("recall comes from the routine's own ledger, newest first", async () => {
  const fs = await import("node:fs");
  const state = await import("../src/state.js");
  fs.rmSync(process.env.STATE_PATH, { force: true });
  const channel = fakeChannel();
  const spotlight = routine({ trigger: "schedule", channel: "pulse", at: "17:00", recall: 2 });

  const prompts = [];
  const run = async (text) =>
    runRoutine(spotlight, {
      channel,
      askFn: async ({ messages }) => {
        prompts.push(messages[0].content);
        return answer(text);
      },
    });
  await run("**Rival scouting** — De stichting, 0 fame.");
  await run("**Meta decks** — Cannon cycle, 87%.");
  await run("**Card levels** — King Thing +1.2.");

  assert.doesNotMatch(prompts[0], /WHAT THIS ROUTINE POSTED/, "nothing to recall on the first run");
  assert.match(prompts[1], /Rival scouting/);
  assert.match(prompts[2], /Meta decks/);
  assert.match(prompts[2], /Rival scouting/);
  assert.deepEqual(
    state.recentOwnPosts("war-deck-check", 5).map((t) => t.slice(0, 6)),
    ["**Card", "**Meta", "**Riva"],
    "newest first, only this routine's posts",
  );
  fs.rmSync(process.env.STATE_PATH, { force: true });
});

test("failed calls are visible under a post even without a trace", async () => {
  // The 2026-09-11 spotlight: pros stats presented after four of eight calls
  // failed, and the reader saw a confident post. The footer is the guard.
  const channel = fakeChannel();
  await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "17:00" }), {
    channel,
    askFn: async () =>
      answer("**Pros run** Barbarian Barrel 51%.", {
        called: ["war_rivals", "battles_meta_cards", "battles_meta_cards", "battles_meta_cards"],
        errors: [
          { name: "battles_meta_cards", code: null, detail: "Connection closed", requestId: "7272147a-206a" },
          { name: "battles_meta_cards", code: null, detail: "Connection closed", requestId: "7256268f-19c5" },
        ],
      }),
  });
  const footer = channel.sent[0].replies[0];
  assert.match(footer, /^-# ⚠️ 2 of 4 tool calls failed: battles_meta_cards ×2/);
  assert.match(footer, /req 7272147a, 7256268f/);
});

test("expected error codes do not earn a footer", async () => {
  const channel = fakeChannel();
  await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "17:00" }), {
    channel,
    askFn: async () =>
      answer("Who are you?", {
        called: ["players_summary"],
        errors: [{ name: "players_summary", code: "no_subject", detail: "Nobody." }],
      }),
  });
  assert.equal(channel.sent[0].replies.length, 0);
});

test("a post that states figures without a tool call is caveated", async () => {
  const channel = fakeChannel();
  await runRoutine(routine({ trigger: "schedule", channel: "pulse", at: "17:00" }), {
    channel,
    askFn: async () => answer("King Thing is 55-38 this month.", { called: [], trace: [] }),
  });
  assert.match(channel.sent[0].replies[0], /No tool was called/);
  // An event brief written from the feed alone is grounded by the feed.
  const feed = fakeChannel();
  await runRoutine(routine({ trigger: "events", channel: "pulse", sections: "roster" }), {
    channel: feed,
    events: [{ kind: "clan_activity", roster: { joined: { items: [{ name: "A" }, { name: "B" }], more: 0 } } }],
    askFn: async () => answer("2 members joined.", { called: [], trace: [] }),
  });
  assert.equal(feed.sent[0].replies.length, 0);
});

/**
 * The post tool: the model chooses a channel from the directory; the runner
 * keeps the rules. A fake askFn plays the model and calls the tool it is
 * handed, exactly as src/claude.js would.
 */
test("a turn posts through post_message to the channel it chose, and the rules hold", async () => {
  const { POST_TOOL } = await import("../src/run.js");
  const news = fakeChannel();
  const leaders = fakeChannel();
  const entries = [
    { id: "11", name: "news", topic: "Clan news", visibility: "everyone", threads: false, role: null },
    { id: "12", name: "leaders", topic: "Leaders", visibility: "restricted", threads: false, role: null },
    { id: "13", name: "ask", topic: "Ask", visibility: "everyone", threads: true, role: "ask" },
  ];
  const resolve = async (id) => ({ 11: news, 12: leaders })[id] ?? null;
  const seen = {};
  const askFn = async ({ system, localTools }) => {
    assert.match(system, /CHANNELS YOU MAY POST IN/);
    assert.match(system, /#leaders .*restricted/);
    const tool = localTools.find((t) => t.name === POST_TOOL.name);
    seen.unknown = await tool.handler({ channel_id: "99", content: "x" });
    seen.ask = await tool.handler({ channel_id: "13", content: "x" });
    seen.first = await tool.handler({ channel_id: "11", content: "Two joined today." });
    seen.second = await tool.handler({ channel_id: "12", content: "One left: an elder." });
    seen.third = await tool.handler({ channel_id: "11", content: "again" });
    seen.fourth = await tool.handler({ channel_id: "11", content: "cap" });
    return answer("Posted.", { called: ["clans_roster", "post_message", "post_message", "post_message"], trace: [] });
  };
  const run = await runRoutine(routine({ trigger: "schedule", at: "01:00" }), {
    channel: null,
    askFn,
    entries,
    resolve,
  });
  assert.equal(seen.unknown.code, "unknown_channel");
  assert.equal(seen.ask.code, "ask_channel");
  assert.equal(seen.first.ok, true);
  assert.equal(seen.second.ok, true);
  assert.equal(seen.third.ok, true);
  assert.equal(seen.fourth.code, "post_cap", "three posts is the cap");
  assert.equal(run.ok, true);
  assert.deepEqual(
    run.posts.map((p) => p.channel),
    ["#news", "#leaders", "#news"],
  );
  assert.equal(news.sent.length, 2);
  assert.equal(leaders.sent.length, 1);
  assert.match(leaders.sent[0].text, /One left/);
  assert.equal(
    run.text,
    "Two joined today.\n\nOne left: an elder.\n\nagain",
    "the posts are the output; trailing prose is not",
  );
});

test("with a directory, no post call and prose still goes to the routine's default; SKIP still skips", async () => {
  const channel = fakeChannel();
  channel.id = "11";
  const entries = [{ id: "11", name: "news", topic: "", visibility: "everyone", threads: false, role: null }];
  const prose = await runRoutine(routine({ trigger: "schedule", at: "01:00" }), {
    channel,
    entries,
    resolve: async () => channel,
    askFn: async ({ system }) => {
      assert.match(system, /DEFAULT for this routine/);
      return answer("Plain reply.", { called: ["war_current"], trace: [] });
    },
  });
  assert.equal(prose.ok, true);
  assert.equal(channel.sent.length, 1);
  const skip = await runRoutine(routine({ trigger: "schedule", at: "01:00", may_skip: true }), {
    channel,
    entries,
    resolve: async () => channel,
    askFn: async () => answer("SKIP", { called: [], trace: [] }),
  });
  assert.equal(skip.skipped, true);
  assert.equal(channel.sent.length, 1);
  const nowhere = await runRoutine(routine({ trigger: "schedule", at: "01:00" }), {
    channel: null,
    entries,
    resolve: async () => channel,
    askFn: async () => answer("Prose with no home.", { called: [], trace: [] }),
  });
  assert.equal(nowhere.ok, false);
  assert.equal(nowhere.error, "no_destination");
});

test("the ask lane never sees the directory or the post tool", async () => {
  const { systemFor } = await import("../src/prompt.js");
  const entries = [{ id: "11", name: "news", topic: "", visibility: "everyone", threads: false, role: null }];
  const system = systemFor(routine({ trigger: "message", channel: "ask" }), { entries: [] });
  assert.doesNotMatch(system, /CHANNELS YOU MAY POST IN/);
  assert.match(system, /YOUR WHOLE REPLY IS THE POST/);
  const scheduled = systemFor(routine({ trigger: "schedule", at: "01:00" }), { entries });
  assert.match(scheduled, /YOU POST BY CALLING post_message/);
  assert.doesNotMatch(scheduled, /YOUR WHOLE REPLY IS THE POST/);
});

test("a routine turn can read the room: the last two hours in a directory channel, newest last", async () => {
  const { roomTool } = await import("../src/run.js");
  const now = Date.parse("2026-09-15T20:00:00Z");
  const messages = new Map([
    [
      "1",
      {
        createdTimestamp: now - 10 * 60000,
        cleanContent: "GG everyone, decks done",
        author: { username: "levy", bot: false },
        member: { displayName: "King Levy" },
      },
    ],
    ["2", { createdTimestamp: now - 3 * 3600 * 1000, cleanContent: "old news", author: { username: "x", bot: false } }],
    [
      "3",
      {
        createdTimestamp: now - 5 * 60000,
        cleanContent: "-# 👋 Online",
        author: { username: "Elixir MCP", bot: true },
      },
    ],
  ]);
  const tool = roomTool({
    entries: [{ id: "77", name: "news" }],
    resolve: async () => ({ messages: { fetch: async () => messages } }),
    now: () => now,
  });
  const out = await tool.handler({ channel_id: "77" });
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.body.messages.map((m) => m.who),
    ["King Levy", "Elixir MCP (bot)"],
    "two hours, oldest first, humans and bots",
  );
  assert.match(out.body.messages[0].text, /decks done/);
  assert.equal((await tool.handler({ channel_id: "99" })).ok, false, "only directory channels");
});
