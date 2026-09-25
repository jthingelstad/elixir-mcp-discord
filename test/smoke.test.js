/**
 * Drives the full ask path with fakes: no network, no Discord, no spend.
 *
 * It exists because `node --check` cannot catch a missing symbol. A refactor
 * deleted LiveMessage, every syntax check passed, and the first person to find
 * out was a member watching the bot say "I fell over answering that" twice.
 * Anything that runs on every message deserves something that runs it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAsk } from "../src/ask.js";
import { renderTrace } from "../src/trace.js";
import { parseRoutine } from "../src/routines.js";

/** The ask lane is now driven by a routine file like everything else, so the
 *  smoke test drives it with one rather than with a module-level constant. */
const ROUTINE = parseRoutine(
  "ask",
  "---\ntrigger: message\nchannel: ask\nhistory_turns: 4\n---\nAnswer clan questions.",
);

function fakeMessage(content) {
  const posted = [];
  const reply = (body) => {
    const text = typeof body === "string" ? body : body.content;
    const entry = { text, edits: [] };
    posted.push(entry);
    return Promise.resolve({
      edit: (next) => {
        entry.edits.push(next);
        entry.text = next;
        return Promise.resolve();
      },
      reply: (child) => {
        posted.push({
          text: typeof child === "string" ? child : child.content,
          edits: [],
        });
        return Promise.resolve({});
      },
    });
  };
  return {
    posted,
    message: {
      id: "1",
      cleanContent: content,
      author: { id: "42", username: "tester", bot: false },
      member: { displayName: "Tester" },
      reply,
      channel: {
        send: (body) => reply(body),
        messages: { fetch: () => Promise.resolve(new Map()) },
      },
    },
  };
}

const RESULT = {
  ok: true,
  text: "King Thing has 15 recorded battles in the last 7 days.",
  called: ["players_search"],
  errors: [],
  trace: [
    { kind: "thought", text: "Look the player up first." },
    {
      kind: "tool",
      name: "players_search",
      input: { query: "King Thing" },
      shape: "1 matches",
      ms: 989,
    },
  ],
  envelopes: [
    {
      tool: "players_search",
      as_of: "2026-09-08T00:54:03.893Z",
      freshness_seconds: 61,
    },
  ],
  usd: 0.0421,
  turnId: "abcd1234",
  ms: 9656,
  rounds: 1,
  stopReason: "end_turn",
  truncated: false,
  model: "claude-sonnet-5",
  effort: "medium",
  serverVersion: "0.28.0+tools.79457603b3b3",
};

test("answers a question, replacing the placeholder with the answer", async () => {
  const { message, posted } = fakeMessage("how many battles?");
  await handleAsk(message, ROUTINE, { askFn: async () => RESULT });

  assert.ok(posted.length >= 2, "expected an answer and a trace");
  assert.equal(posted[0].text, RESULT.text, "placeholder should become the answer");
  assert.ok(posted[0].edits.length > 0, "the answer arrives via edit, not a new message");
  assert.ok(posted[1].text.includes("abcd1234"), "trace should carry the turn id");
});

test("a failed turn reports the failure and does not crash", async () => {
  const { message, posted } = fakeMessage("break please");
  await handleAsk(message, ROUTINE, {
    askFn: async () => ({
      ok: false,
      error: "boom",
      called: [],
      errors: [],
      trace: [],
    }),
  });
  assert.ok(posted[0].text.includes("boom"), "the real error should reach the channel");
});

test("streaming progress reaches the live message", async () => {
  const { message, posted } = fakeMessage("what is the war day?");
  await handleAsk(message, ROUTINE, {
    askFn: async ({ onEvent }) => {
      onEvent({ kind: "tool_start", name: "war_current" });
      onEvent({ kind: "text", text: "Training day." });
      return RESULT;
    },
  });
  // Assert on the EDITS, not just that something was posted: the crash path
  // also posts two messages, and an assertion both paths satisfy is not a test.
  const live = posted[0];
  assert.ok(
    live.edits.some((edit) => edit.includes("war_current")),
    "the tool name should appear in the live message while the turn runs",
  );
  assert.equal(live.text, RESULT.text, "and the live message ends as the answer");
});

test("the trace carries the diagnostics that make an answer debuggable", () => {
  const trace = renderTrace(RESULT);
  for (const needle of [
    "players_search",
    "1 matches",
    "1.0s",
    "claude-sonnet-5",
    "effort medium",
    "0.28.0+tools.79457603b3b3",
    "end_turn",
  ]) {
    assert.ok(trace.includes(needle), `trace missing ${needle}`);
  }
  assert.ok(trace.length <= 2000, "trace must fit a Discord message");
});

test("an empty result is called out, not smoothed over", () => {
  const trace = renderTrace({
    ...RESULT,
    trace: [
      {
        kind: "tool",
        name: "players_search",
        input: {},
        shape: "0 matches (EMPTY)",
      },
    ],
  });
  assert.ok(trace.includes("EMPTY"));
});

test("a truncated answer says so", () => {
  assert.ok(renderTrace({ ...RESULT, truncated: true }).includes("TRUNCATED"));
});

test("a tool that failed without the error flag is still reported as failed", () => {
  // The failure this closes: an unknown tool name fails at the PROTOCOL layer,
  // so the result block carries no is_error, and Elixir MCP reports its own
  // refusals as a body with an `error` object. Both used to render as a normal
  // success, and the model would tell a member "linked!" having written
  // nothing. Observed live on 2026-09-08.
  const trace = renderTrace({
    ...RESULT,
    errors: [{ name: "elixir_identify", detail: "unknown tool" }],
    trace: [{ kind: "error", name: "elixir_identify", detail: "unknown tool" }],
  });
  assert.ok(trace.includes("⚠️"), "a failure must be visible in the footer");
  assert.ok(trace.includes("elixir_identify"));
});

test("a member's question is charged to the ask lane", async () => {
  // The whole point of two pots: clan members driving cost must not be able to
  // spend the schedule's budget.
  const { message } = fakeMessage("how am I doing?");
  let seen = null;
  await handleAsk(message, ROUTINE, {
    askFn: async (args) => {
      seen = args;
      return RESULT;
    },
  });
  assert.equal(seen.lane, "ask");
});

test("the conversation history skips footers, placeholders and pinned notices", async () => {
  const { isConversational } = await import("../src/ask.js");
  const bot = (cleanContent, extra = {}) => ({ cleanContent, author: { bot: true }, ...extra });
  const human = (cleanContent) => ({ cleanContent, author: { bot: false } });
  assert.equal(isConversational(bot("King Thing is 55-38.")), true);
  assert.equal(isConversational(bot("-# **How I got there** · `abcd1234`\n> 🔧 `players_search`")), false);
  assert.equal(isConversational(bot("-# 📮 Filed with Elixir MCP: …")), false);
  assert.equal(isConversational(bot("-# thinking…")), false);
  assert.equal(isConversational(bot("**How to use this channel**", { pinned: true })), false);
  assert.equal(isConversational(human("-# whispering")), true, "a member's small text is still a turn");
  assert.equal(isConversational(human("")), false);
});

test("an answer with figures and no tool call is caveated under the reply", async () => {
  const { message, posted } = fakeMessage("how am I playing?");
  await handleAsk(message, ROUTINE, {
    askFn: async () => ({ ...RESULT, text: "Same as above: 55-38, 59.1%.", called: [], trace: [] }),
  });
  assert.ok(
    posted.some((p) => p.text.includes("No tool was called")),
    "the caveat must be visible",
  );
});

test("the trace names the request id of a failed call and of the last envelope", () => {
  const trace = renderTrace({
    ...RESULT,
    envelopes: [{ tool: "players_search", as_of: "2026-09-08T00:54:03.893Z", request_id: "dc5ec8de-b919-4934" }],
    trace: [
      ...RESULT.trace,
      {
        kind: "error",
        name: "battles_query",
        code: "bad_request",
        detail: "inverted window",
        requestId: "7272147a-206a",
      },
    ],
  });
  assert.ok(trace.includes("req `dc5ec8de`"), "envelope request id");
  assert.ok(trace.includes("req `7272147a`"), "failed call request id");
});

/**
 * One reading of a tool result, whoever ran it (2026-09-17): a connector
 * block, the direct client and a local handler all go through `outcome`.
 */
test("a tool result is read one way: is_error, a refusal body, prose, and a plain success", async () => {
  const { outcome } = await import("../src/claude.js");
  const refusal = outcome(
    JSON.stringify({ error: { code: "no_subject", message: "Who?" }, meta: { request_id: "r1" } }),
  );
  assert.equal(refusal.ok, false, "a body with an error object failed even without is_error");
  assert.equal(refusal.code, "no_subject");
  assert.equal(refusal.detail, "Who?");
  assert.equal(refusal.requestId, "r1");
  assert.equal(refusal.errorClass, null, "a hub before 3.18.0 carries no class");
  const classed = outcome(
    JSON.stringify({ error: { code: "live_pending", class: "retry", message: "Queued." }, meta: { request_id: "r3" } }),
  );
  assert.equal(classed.errorClass, "retry");
  const flagged = outcome("boom", { isError: true });
  assert.equal(flagged.ok, false);
  assert.equal(flagged.code, null, "no body, no code");
  assert.equal(flagged.detail, "boom");
  const prose = outcome("Just words.");
  assert.equal(prose.ok, true);
  assert.equal(prose.body, null);
  const fine = outcome(JSON.stringify({ rivals: [1], meta: { request_id: "r2", as_of: "x" } }));
  assert.equal(fine.ok, true);
  assert.equal(fine.requestId, "r2");
  assert.deepEqual(fine.body.rivals, [1]);
});

test("the result shape counts rows, not the contract's notes", async () => {
  const { describeShape } = await import("../src/claude.js");
  assert.equal(describeShape({ rivals: [1, 2, 3, 4], notes: ["a", "b", "c"], meta: {} }), "4 rivals");
  assert.equal(describeShape({ notes: ["a"], season_id: 136, meta: {} }), "object");
  assert.equal(describeShape({ players: [], notes: ["a"] }), "0 players (EMPTY)");
});

/**
 * Threads. A new question opens one and is answered inside it; a follow-up in
 * the thread sees the starter and the thread, and nothing from anyone else.
 */
function threadedMessage(content, { thread = true, inThread = false, starter = null, threadMessages = [] } = {}) {
  const posted = [];
  const mk = (where) => (body) => {
    const text = typeof body === "string" ? body : body.content;
    const entry = { text, where, edits: [], id: `m${posted.length + 1}` };
    posted.push(entry);
    return Promise.resolve({
      id: entry.id,
      edit: (next) => ((entry.edits.push(next), (entry.text = next)), Promise.resolve()),
      reply: (child) => mk(where)(child),
    });
  };
  const threadObj = {
    id: "thread-1",
    isThread: () => true,
    parentId: "2",
    send: mk("thread"),
    messages: { fetch: () => Promise.resolve(new Map(threadMessages.map((m, i) => [String(i), m]))) },
    fetchStarterMessage: () => Promise.resolve(starter),
  };
  const channel = inThread
    ? threadObj
    : { id: "2", isThread: () => false, send: mk("channel"), messages: { fetch: () => Promise.resolve(new Map()) } };
  const message = {
    id: "q1",
    cleanContent: content,
    author: { id: "42", username: "tester", bot: false },
    member: { displayName: "Tester" },
    reply: mk("channel"),
    channel,
    startThread: thread
      ? ({ name }) => ((threadObj.name = name), Promise.resolve(threadObj))
      : () => Promise.reject(new Error("Missing Permissions")),
  };
  return { posted, message, threadObj };
}

test("a new question opens a thread named after it and is answered there", async () => {
  const { posted, message, threadObj } = threadedMessage("what are the top meta decks this week?");
  let seen = null;
  await handleAsk(message, ROUTINE, { askFn: async (args) => ((seen = args), RESULT) });
  assert.equal(threadObj.name, "what are the top meta decks this week?");
  assert.ok(
    posted.every((p) => p.where === "thread"),
    "nothing lands in the channel itself",
  );
  assert.equal(posted[0].text, RESULT.text);
  assert.equal(seen.messages.length, 1, "a new question carries no history");
});

test("a follow-up in the thread sees the starter and the thread only", async () => {
  const starter = { id: "q0", cleanContent: "how am I playing?", author: { id: "42", username: "tester", bot: false } };
  const earlier = [
    { id: "a0", cleanContent: "55-38 this month.", author: { bot: true } },
    { id: "a0t", cleanContent: "-# **How I got there** · `x`", author: { bot: true } },
  ];
  const { message } = threadedMessage("and last month?", { inThread: true, starter, threadMessages: earlier });
  let seen = null;
  await handleAsk(message, ROUTINE, { askFn: async (args) => ((seen = args), RESULT) });
  // The current turn is content blocks (a picture may come first); history is text.
  const contents = seen.messages.map((m) =>
    Array.isArray(m.content)
      ? m.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("")
      : m.content,
  );
  assert.match(contents[0], /how am I playing\?/, "the starter opens the history");
  assert.equal(contents[1], "55-38 this month.");
  assert.match(contents[2], /and last month\?/);
  assert.equal(contents.length, 3, "the trace footer is not a turn");
});

test("without thread permissions the bot answers in the channel", async () => {
  const { posted, message } = threadedMessage("hello?", { thread: false });
  await handleAsk(message, ROUTINE, { askFn: async () => RESULT });
  assert.ok(posted.length > 0);
  assert.ok(posted.every((p) => p.where === "channel"));
  assert.equal(posted[0].text, RESULT.text);
});

test("every message a turn produced points back at the turn", async () => {
  const state = await import("../src/state.js");
  const { posted, message } = threadedMessage("who plays Mortar best?");
  await handleAsk(message, ROUTINE, { askFn: async () => RESULT });
  for (const p of posted) {
    assert.equal(state.turnForMessage(p.id)?.turnId, RESULT.turnId, `${p.id} (${p.text.slice(0, 20)})`);
  }
  assert.equal(state.turnForMessage(posted[0].id).question, "who plays Mortar best?");
});

test("a member's screenshot rides the turn as an image block, before the words, and is noted in the ledger", async () => {
  const { message } = fakeMessage("is this deck any good?");
  message.attachments = new Map([
    [
      "a",
      {
        name: "deck.png",
        contentType: "image/png",
        size: 200_000,
        url: "https://cdn.discordapp.com/attachments/1/2/deck.png",
      },
    ],
    [
      "b",
      {
        name: "notes.txt",
        contentType: "text/plain",
        size: 100,
        url: "https://cdn.discordapp.com/attachments/1/2/notes.txt",
      },
    ],
    [
      "c",
      {
        name: "huge.png",
        contentType: "image/png",
        size: 50_000_000,
        url: "https://cdn.discordapp.com/attachments/1/2/huge.png",
      },
    ],
  ]);
  let seen;
  await handleAsk(message, ROUTINE, { askFn: async (args) => ((seen = args), RESULT) });
  const content = seen.messages.at(-1).content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.url, "https://cdn.discordapp.com/attachments/1/2/deck.png");
  assert.equal(content.length, 2, "one image (the text file and the oversized one are not images), then the words");
  assert.match(content[1].text, /is this deck any good\?/);
});

test("a member's request reaches the operator once, three a day, and the cap stops the twenty-first question", async () => {
  const state = await import("../src/state.js");
  const notify = await import("../src/notify.js");
  const { config } = await import("../src/config.js");
  const sent = [];
  notify.configure({ client: { users: { fetch: async () => ({ send: async (m) => sent.push(m.content) }) } } });
  config.adminUserIds = new Set(["9"]);
  state.set({ operatorRequests: {}, notices: {}, askCounts: null });

  const { message } = fakeMessage("can you post the war reminder earlier?");
  let tool;
  await handleAsk(message, ROUTINE, {
    askFn: async ({ localTools }) => {
      tool = localTools.find((t) => t.name === "tell_operator");
      assert.ok(tool, "the ask lane offers tell_operator");
      assert.ok(
        localTools.find((t) => t.name === "link_me"),
        "and link_me, bound to the author — elixir_identify is not the model's to address",
      );
      return RESULT;
    },
  });
  for (let i = 0; i < 4; i += 1) await tool.handler({ request: `request ${i}` });
  assert.equal(sent.length, 3, "three per member per day reach the operator");
  assert.match(sent[0], /member request/);
  assert.match(sent[0], /request 0/);

  config.askDailyTurnsPerMember = 2;
  const { message: second, posted } = fakeMessage("and again?");
  await handleAsk(second, ROUTINE, { askFn: async () => RESULT });
  const { message: third, posted: blocked } = fakeMessage("one more");
  await handleAsk(third, ROUTINE, { askFn: async () => assert.fail("capped: no model call") });
  assert.match(blocked[0].text, /questions from you today/);
  assert.ok(posted.length > 0);

  // A burst: every question arrives before the first answer. Counted after
  // the answer, all of them passed the check.
  state.set({ askCounts: null });
  let calls = 0;
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const burst = [1, 2, 3, 4, 5].map((i) =>
    handleAsk(fakeMessage(`quick ${i}`).message, ROUTINE, {
      askFn: async () => {
        calls += 1;
        await slow;
        return RESULT;
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all(burst);
  assert.equal(calls, 2, "the cap holds for questions asked at once");

  // A turn that fails on our side gives the question back.
  state.set({ askCounts: null });
  await handleAsk(fakeMessage("breaks").message, ROUTINE, {
    askFn: async () => ({ ...RESULT, ok: false, error: "overloaded_error" }),
  });
  assert.equal((await import("../src/ask.js")).memberTurnsToday("42"), 0);
  config.askDailyTurnsPerMember = 20;
  notify.configure({ client: null });
});

test("a failed answer says which service failed: the model API is not Elixir MCP", async () => {
  const { failureLine } = await import("../src/ask.js");
  assert.match(failureLine("overloaded_error"), /Claude API/);
  assert.doesNotMatch(failureLine("overloaded_error"), /talking to Elixir MCP/);
  assert.match(failureLine("MCP server 'elixir-mcp' connection failed"), /talking to Elixir MCP/);
  assert.match(failureLine("refusal"), /not able to answer/);
  assert.match(failureLine('No price for model "x"'), /misconfigured/);
});
