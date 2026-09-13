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
  assert.equal(
    posted[0].text,
    RESULT.text,
    "placeholder should become the answer",
  );
  assert.ok(
    posted[0].edits.length > 0,
    "the answer arrives via edit, not a new message",
  );
  assert.ok(
    posted[1].text.includes("abcd1234"),
    "trace should carry the turn id",
  );
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
  assert.ok(
    posted[0].text.includes("boom"),
    "the real error should reach the channel",
  );
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
  assert.equal(
    live.text,
    RESULT.text,
    "and the live message ends as the answer",
  );
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
  assert.ok(posted.some((p) => p.text.includes("No tool was called")), "the caveat must be visible");
});

test("the trace names the request id of a failed call and of the last envelope", () => {
  const trace = renderTrace({
    ...RESULT,
    envelopes: [{ tool: "players_search", as_of: "2026-09-08T00:54:03.893Z", request_id: "dc5ec8de-b919-4934" }],
    trace: [
      ...RESULT.trace,
      { kind: "error", name: "battles_query", code: "bad_request", detail: "inverted window", requestId: "7272147a-206a" },
    ],
  });
  assert.ok(trace.includes("req `dc5ec8de`"), "envelope request id");
  assert.ok(trace.includes("req `7272147a`"), "failed call request id");
});

test("the result shape counts rows, not the contract's notes", async () => {
  const { describeShape } = await import("../src/claude.js");
  assert.equal(describeShape({ rivals: [1, 2, 3, 4], notes: ["a", "b", "c"], meta: {} }), "4 rivals");
  assert.equal(describeShape({ notes: ["a"], season_id: 136, meta: {} }), "object");
  assert.equal(describeShape({ players: [], notes: ["a"] }), "0 players (EMPTY)");
});
