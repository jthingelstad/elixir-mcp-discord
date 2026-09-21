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
    { id: "14", name: "elixir", topic: "The old bot", visibility: "restricted", threads: false, role: "read" },
  ];
  const resolve = async (id) => ({ 11: news, 12: leaders })[id] ?? null;
  const seen = {};
  const askFn = async ({ system, localTools }) => {
    assert.match(system, /CHANNELS YOU MAY POST IN \(OR READ\)/);
    assert.match(system, /#leaders .*restricted/);
    assert.match(system, /#elixir .*READ ONLY/);
    const tool = localTools.find((t) => t.name === POST_TOOL.name);
    seen.unknown = await tool.handler({ channel_id: "99", content: "x" });
    seen.ask = await tool.handler({ channel_id: "13", content: "x" });
    seen.read = await tool.handler({ channel_id: "14", content: "x" });
    seen.first = await tool.handler({ channel_id: "11", content: "Two joined today." });
    seen.second = await tool.handler({ channel_id: "12", content: "One left: an elder." });
    seen.long = await tool.handler({ channel_id: "11", content: "x".repeat(901) });
    seen.third = await tool.handler({ channel_id: "11", content: "again" });
    seen.fourth = await tool.handler({ channel_id: "11", content: "cap" });
    seen.description = tool.description;
    seen.schema = tool.input_schema.properties.content.description;
    return answer("Posted.", { called: ["clans_roster", "post_message", "post_message", "post_message"], trace: [] });
  };
  const run = await runRoutine(routine({ trigger: "schedule", at: "01:00", max_chars: 900 }), {
    channel: null,
    askFn,
    entries,
    resolve,
  });
  assert.equal(seen.unknown.code, "unknown_channel");
  assert.equal(seen.ask.code, "ask_channel");
  assert.equal(seen.read.code, "read_only", "let in to look, not to speak");
  assert.equal(seen.first.ok, true);
  assert.equal(seen.second.ok, true);
  // max_chars is refused, not chunked (shipit 47f426a1: 2,060 chars on a
  // 1,400 routine went out as two messages, unflagged), and the limit is
  // named where the model reads the tool.
  assert.equal(seen.long.code, "too_long");
  assert.match(seen.long.error, /901 characters; this routine's limit is 900/);
  assert.match(seen.description, /limit is 900 characters/);
  assert.match(seen.schema, /at most 900 characters/);
  assert.equal(seen.third.ok, true, "a refusal does not count against the cap");
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

test("the operator can study a channel: whole messages, read-only channels included, paged backwards", async () => {
  const { studyTool } = await import("../src/run.js");
  const t0 = Date.parse("2026-09-01T00:00:00Z");
  const page = (n, before) => {
    // 120 messages, ids "1".."120", newest last; a page is the `limit`
    // newest ids below `before`.
    const upper = before ? Number(before) : 121;
    const ids = [];
    for (let id = upper - 1; id >= 1 && ids.length < n; id -= 1) ids.push(id);
    return new Map(
      ids.map((id) => [
        String(id),
        {
          id: String(id),
          createdTimestamp: t0 + id * 3600_000,
          cleanContent: id % 7 === 0 ? "" : `**Post ${id}.** the old bot said something long enough to matter`,
          author: { username: "Elixir", bot: true },
          embeds: id % 7 === 0 ? [{ title: `Embed ${id}`, description: "an embed only" }] : [],
        },
      ]),
    );
  };
  const tool = studyTool({
    entries: [{ id: "14", name: "elixir", role: "read" }],
    resolve: async () => ({ messages: { fetch: async ({ limit, before }) => page(limit, before) } }),
  });
  const first = await tool.handler({ channel_id: "14", limit: 100 });
  assert.equal(first.ok, true);
  assert.equal(first.body.channel, "#elixir");
  assert.equal(first.body.messages.length, 100);
  assert.equal(first.body.messages.at(-1).message_id, "120", "newest last");
  assert.equal(first.body.messages[0].message_id, "21");
  assert.equal(first.body.oldest_message_id, "21");
  assert.match(first.body.messages.at(-1).who, /Elixir \(bot\)/);
  const embedOnly = first.body.messages.find((m) => m.message_id === "112");
  assert.equal(embedOnly.text, "");
  assert.equal(embedOnly.embeds[0].title, "Embed 112", "an embed-only post is not dropped");

  const second = await tool.handler({ channel_id: "14", limit: 100, before: first.body.oldest_message_id });
  assert.equal(second.body.messages.length, 20);
  assert.equal(second.body.messages[0].message_id, "1");
  const end = await tool.handler({ channel_id: "14", before: "1" });
  assert.equal(end.body.messages.length, 0);
  assert.match(end.body.note, /Nothing further back/);
  assert.equal((await tool.handler({ channel_id: "99" })).ok, false, "only directory channels");
});

/**
 * The second ask. A turn that wrote its post and never called post_message
 * used to end as `no_destination` — one substantive turn in four did that on
 * Sonnet 5 (2026-09-14..16). The runner now hands ask() a nudge: prose with
 * no post and no SKIP gets one more round; a post, a SKIP, or an empty reply
 * is accepted as it is.
 */
test("prose with no post and no SKIP is nudged once; a post or a SKIP is not", async () => {
  const { deliveryNudge } = await import("../src/run.js");
  const entries = [{ id: "11", name: "news", topic: "", visibility: "everyone", threads: false, role: null }];
  const channel = fakeChannel();
  channel.id = "11";

  let handed = null;
  await runRoutine(routine({ trigger: "schedule", at: "01:00", may_skip: true }), {
    channel: null,
    entries,
    resolve: async () => channel,
    askFn: async ({ nudge }) => {
      handed = nudge;
      return answer("SKIP", { called: [], trace: [] });
    },
  });
  assert.equal(typeof handed, "function", "a turn with the directory is handed a nudge");
  assert.match(
    handed({ text: "Two joined today.", called: ["clans_roster"] }),
    /NOT DELIVERED[\s\S]*post_message[\s\S]*reply SKIP/,
  );
  assert.equal(handed({ text: "SKIP", called: [] }), null, "declining is a finished turn");
  assert.equal(handed({ text: "", called: [] }), null, "silence is a finished turn");

  const may = routine({ trigger: "schedule", at: "01:00", may_skip: true });
  const must = routine({ trigger: "schedule", at: "01:00" });
  assert.equal(
    deliveryNudge(may, { text: "Posted above.", posts: [{ channelId: "11" }] }),
    null,
    "a post is a finished turn",
  );
  assert.equal(
    deliveryNudge(must, { text: "SKIP", posts: [] }) !== null,
    true,
    "a routine that may not skip is nudged on SKIP",
  );
  assert.doesNotMatch(deliveryNudge(must, { text: "Prose.", posts: [] }), /reply SKIP/, "and is not offered SKIP");

  let legacy = "unset";
  await runRoutine(routine({ trigger: "schedule", at: "01:00" }), {
    channel,
    entries: [],
    resolve: async () => channel,
    askFn: async ({ nudge }) => {
      legacy = nudge;
      return answer("Plain reply.");
    },
  });
  assert.equal(legacy, null, "no directory, no tool, nothing to nudge toward");
});

/**
 * The silence clock: every routine post stamps its channel; a channel with
 * no stamp is anchored on first sight and reported as "at least". Since
 * 2026-09-17 no turn is told the reading — it is the editor's carry
 * release gate (src/events.js) — so the user turn must NOT carry it.
 */
test("a post resets the channel's silence clock; an unposted channel counts from first sight; no turn is told", async () => {
  const state = await import("../src/state.js");
  const entries = [
    { id: "21", name: "news", topic: "", visibility: "everyone", threads: false, role: null },
    { id: "22", name: "leaders", topic: "", visibility: "restricted", threads: false, role: null },
    { id: "23", name: "ask", topic: "", visibility: "everyone", threads: true, role: "ask" },
  ];
  const news = fakeChannel();
  const resolve = async (id) => ({ 21: news })[id] ?? null;
  const { POST_TOOL } = await import("../src/run.js");
  // The event lane anchors first sight when it reads the clock for the
  // carry release; a run no longer does.
  state.silence(entries.filter((e) => !e.role));

  let userTurn = null;
  const run = await runRoutine(routine({ trigger: "schedule", at: "01:00", may_skip: true }), {
    channel: null,
    entries,
    resolve,
    askFn: async ({ messages, localTools }) => {
      userTurn = messages[0].content;
      const tool = localTools.find((t) => t.name === POST_TOOL.name);
      await tool.handler({ channel_id: "21", content: "One true line." });
      return answer("", { called: ["clans_roster", "post_message"], trace: [] });
    },
  });
  assert.equal(run.ok, true);
  assert.doesNotMatch(userTurn, /\[silence/, "the reading is a scheduler input now, not a prompt line");

  const later = new Date(Date.now() + 30 * 3600000);
  const reading = state.silence(
    entries.filter((e) => !e.role),
    later,
  );
  const byName = Object.fromEntries(reading.map((s) => [s.name, s]));
  assert.equal(byName.news.atLeast, false, "the post stamped #news");
  assert.equal(byName.news.routine, "war-deck-check");
  assert.equal(Math.round(byName.news.hours), 30);
  assert.equal(byName.leaders.atLeast, true, "#leaders is still counting from first sight");
  assert.equal(Math.round(byName.leaders.hours), 30);
});

test("the clock is seeded from the ledger at boot, and a real stamp is never overwritten by a seed", async () => {
  const state = await import("../src/state.js");
  const turns = [
    {
      lane: "routines",
      routine: "clan-feed",
      at: "2026-09-14T02:00:00.000Z",
      output: { posts: [{ channelId: "31", channelName: "news" }] },
    },
    {
      lane: "routines",
      routine: "notable-movers",
      at: "2026-09-15T17:31:00.000Z",
      output: { posts: [{ channelId: "31", channelName: "news" }] },
    },
    {
      lane: "ask",
      routine: "ask",
      at: "2026-09-16T10:00:00.000Z",
      output: { posts: [{ channelId: "31", channelName: "news" }] },
    },
    {
      lane: "routines",
      routine: "war-deck-check",
      at: "2026-09-16T06:00:00.000Z",
      output: { posts: [], error: "no_destination" },
    },
  ];
  assert.equal(state.seedPostTimes(turns), 1);
  const [news] = state.silence([{ id: "31", name: "news" }], new Date("2026-09-16T17:31:00Z"));
  assert.equal(news.routine, "notable-movers", "the newest routine post wins; the ask lane does not count");
  assert.equal(Math.round(news.hours), 24);
  state.rememberPostAt("31", { name: "news", routine: "clan-feed", at: new Date("2026-09-16T12:00:00Z") });
  state.seedPostTimes([
    {
      lane: "routines",
      routine: "x",
      at: "2026-09-16T15:00:00.000Z",
      output: { posts: [{ channelId: "31", channelName: "news" }] },
    },
  ]);
  const [again] = state.silence([{ id: "31", name: "news" }], new Date("2026-09-16T17:31:00Z"));
  assert.equal(again.routine, "clan-feed", "a stamp the runtime set outranks any later seed");
});

/**
 * A turn cut off at max_tokens is not a decision. On 2026-09-20 the weekly
 * meta-report made four big reads at high effort, reached its 6,000-token
 * ceiling inside the thinking, and came back with no text — which `isSkip`
 * accepted and the ledger recorded as a deliberate skip. Nothing reached the
 * channel or the operator. Now: the nudge answers a cutoff with OUT OF ROOM
 * (a fresh round, the reads still in the turn), and a turn that is STILL
 * truncated with no post fails loudly instead of skipping quietly.
 */
test("a truncated turn with no post is a loud failure, never a SKIP; the nudge answers a cutoff", async () => {
  const { deliveryNudge } = await import("../src/run.js");
  const may = routine({ trigger: "schedule", at: "01:00", may_skip: true });
  const must = routine({ trigger: "schedule", at: "01:00" });
  assert.match(
    deliveryNudge(may, { text: "", posts: [], truncated: true }),
    /OUT OF ROOM[\s\S]*post_message[\s\S]*reply SKIP/,
  );
  assert.doesNotMatch(deliveryNudge(must, { text: "", posts: [], truncated: true }), /reply SKIP/);
  assert.equal(
    deliveryNudge(may, { text: "", posts: [{ channelId: "11" }], truncated: true }),
    null,
    "a post made before the cutoff stands",
  );

  const channel = fakeChannel();
  channel.id = "11";
  const entries = [{ id: "11", name: "news", topic: "", visibility: "everyone", threads: false, role: null }];
  const run = await runRoutine(may, {
    channel,
    entries,
    resolve: async () => channel,
    askFn: async () =>
      answer("", {
        called: ["battles_meta_decks"],
        trace: [],
        stopReason: "max_tokens",
        truncated: true,
        resumed: true,
        rounds: 2,
        usage: { input: 500, cacheRead: 40000, cacheWrite: 0, output: 6400 },
      }),
  });
  assert.equal(run.ok, false);
  assert.equal(run.error, "truncated");
  assert.notEqual(run.skipped, true, "silence after a cutoff is not a skip");
  assert.equal(channel.sent.length, 0, "a half-written report is not posted");

  const dry = await runRoutine(may, {
    channel,
    entries,
    resolve: async () => channel,
    dryRun: true,
    askFn: async () => answer("Half a rep", { called: [], trace: [], stopReason: "max_tokens", truncated: true }),
  });
  assert.equal(dry.ok, false, "the dry run says so too");
  assert.equal(dry.error, "truncated");
});

test("post() never sends more than Discord's 2,000 characters, whatever max_chars says", async () => {
  const { post } = await import("../src/post.js");
  const channel = fakeChannel();
  await post(channel, "y".repeat(2500), 3000);
  assert.equal(channel.sent.length, 2);
  assert.ok(channel.sent.every((m) => m.text.length <= 2000));
});
