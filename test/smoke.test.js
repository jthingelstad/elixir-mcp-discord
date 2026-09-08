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
import { handleAsk, renderTrace } from "../src/ask.js";

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
        posted.push({ text: typeof child === "string" ? child : child.content, edits: [] });
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
    { kind: "tool", name: "players_search", input: { query: "King Thing" }, shape: "1 matches", ms: 989 },
  ],
  envelopes: [{ tool: "players_search", as_of: "2026-09-08T00:54:03.893Z", freshness_seconds: 61 }],
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
  await handleAsk(message, { askFn: async () => RESULT });

  assert.ok(posted.length >= 2, "expected an answer and a trace");
  assert.equal(posted[0].text, RESULT.text, "placeholder should become the answer");
  assert.ok(posted[0].edits.length > 0, "the answer arrives via edit, not a new message");
  assert.ok(posted[1].text.includes("abcd1234"), "trace should carry the turn id");
});

test("a failed turn reports the failure and does not crash", async () => {
  const { message, posted } = fakeMessage("break please");
  await handleAsk(message, {
    askFn: async () => ({ ok: false, error: "boom", called: [], errors: [], trace: [] }),
  });
  assert.ok(posted[0].text.includes("boom"), "the real error should reach the channel");
});

test("streaming progress reaches the live message", async () => {
  const { message, posted } = fakeMessage("what is the war day?");
  await handleAsk(message, {
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
    trace: [{ kind: "tool", name: "players_search", input: {}, shape: "0 matches (EMPTY)" }],
  });
  assert.ok(trace.includes("EMPTY"));
});

test("a truncated answer says so", () => {
  assert.ok(renderTrace({ ...RESULT, truncated: true }).includes("TRUNCATED"));
});
