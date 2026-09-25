/**
 * The turn loop, round by round, with a fake stream playing the model. What
 * it pins: a turn cut off at max_tokens is asked again ONCE with the caller's
 * message, the echo carries the reads but never a client-side tool_use whose
 * input may be cut, and the second ask gets a fresh ceiling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ask } from "../src/claude.js";

const usage = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 };

function playing(responses) {
  const requests = [];
  const stream = (params) => {
    requests.push(params);
    const response = responses[requests.length - 1];
    if (!response) throw new Error(`no scripted response for round ${requests.length}`);
    return { on() {}, finalMessage: async () => response };
  };
  return { stream, requests };
}

const read = {
  type: "mcp_tool_use",
  id: "mcptoolu_1",
  name: "battles_meta_decks",
  server_name: "elixir-mcp",
  input: { segment: "corpus" },
};
const result = {
  type: "mcp_tool_result",
  tool_use_id: "mcptoolu_1",
  is_error: false,
  content: [{ type: "text", text: "{}" }],
};

test("a turn cut off at max_tokens is resumed once with the caller's message; the reads are echoed, a cut tool_use is not", async () => {
  const cut = { type: "tool_use", id: "toolu_cut", name: "post_message", input: { channel_id: "11" } };
  const { stream, requests } = playing([
    { content: [read, result, cut], stop_reason: "max_tokens", usage },
    { content: [{ type: "text", text: "Posted." }], stop_reason: "end_turn", usage },
  ]);
  const asked = [];
  const out = await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    maxTokens: 6000,
    nudge: (args) => {
      asked.push(args);
      return args.truncated ? "OUT OF ROOM." : null;
    },
    stream,
  });
  assert.equal(requests.length, 2, "one resume round");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].truncated, true);
  const [, echo, message] = requests[1].messages;
  assert.equal(echo.role, "assistant");
  assert.deepEqual(
    echo.content.map((b) => b.type),
    ["mcp_tool_use", "mcp_tool_result"],
    "the reads ride the echo; the cut tool_use is dropped, never run",
  );
  assert.deepEqual(message, { role: "user", content: "OUT OF ROOM." });
  assert.equal(requests[1].max_tokens, 6000, "the resume gets the full ceiling again");
  assert.equal(out.ok, true);
  assert.equal(out.resumed, true);
  assert.equal(out.nudged, true);
  assert.equal(out.truncated, false, "the turn finished on the second ask");
  assert.equal(out.rounds, 2);
  assert.equal(out.text, "Posted.");
});

test("cut off twice is truncated, and a turn with no nudge is never resumed", async () => {
  const twice = playing([
    { content: [read, result], stop_reason: "max_tokens", usage },
    { content: [{ type: "text", text: "Still going" }], stop_reason: "max_tokens", usage },
  ]);
  const out = await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    nudge: () => "OUT OF ROOM.",
    stream: twice.stream,
  });
  assert.equal(twice.requests.length, 2, "asked again once, not forever");
  assert.equal(out.truncated, true);
  assert.equal(out.resumed, true);
  assert.equal(out.stopReason, "max_tokens");

  const plain = playing([{ content: [{ type: "text", text: "Half an ans" }], stop_reason: "max_tokens", usage }]);
  const bare = await ask({ system: "s", messages: [{ role: "user", content: "go" }], stream: plain.stream });
  assert.equal(plain.requests.length, 1, "no nudge, no second ask");
  assert.equal(bare.truncated, true);
  assert.equal(bare.resumed, false);
});

test("a model without adaptive thinking is sent neither thinking nor effort; the rest are sent both", async () => {
  const done = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage };
  const haiku = playing([done]);
  const out = await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    model: "claude-haiku-4-5",
    effort: "low",
    stream: haiku.stream,
  });
  assert.equal(out.ok, true);
  assert.equal(haiku.requests[0].thinking, undefined, "adaptive thinking is a 400 on Haiku 4.5");
  assert.equal(haiku.requests[0].output_config, undefined, "and so is effort");

  const sonnet = playing([done]);
  await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    model: "claude-sonnet-5",
    stream: sonnet.stream,
  });
  assert.equal(sonnet.requests[0].thinking.type, "adaptive");
  assert.ok(sonnet.requests[0].output_config.effort);
});

test("an unpriced model is refused before the call, not discovered on the bill", async () => {
  const { stream, requests } = playing([]);
  const out = await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    model: "claude-nonesuch-9",
    stream,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /No price for model "claude-nonesuch-9"/);
  assert.equal(requests.length, 0, "nothing was sent, so nothing was paid for");
  assert.ok(out.turnId, "and the failure is still a turn the ledger can hold");
});
