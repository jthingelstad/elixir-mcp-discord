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

/** A server catalog as tools/list annotates it: two reads and three writes. */
const CATALOG = async () => ({
  ok: true,
  annotated: true,
  tools: [
    { name: "players_summary", readOnly: true },
    { name: "battles_meta_decks", readOnly: true },
    { name: "elixir_send_feedback", readOnly: false },
    { name: "elixir_identify", readOnly: false },
    { name: "elixir_track_clan", readOnly: false },
  ],
});

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
    catalogFn: CATALOG,
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
    catalogFn: CATALOG,
  });
  assert.equal(twice.requests.length, 2, "asked again once, not forever");
  assert.equal(out.truncated, true);
  assert.equal(out.resumed, true);
  assert.equal(out.stopReason, "max_tokens");

  const plain = playing([{ content: [{ type: "text", text: "Half an ans" }], stop_reason: "max_tokens", usage }]);
  const bare = await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    stream: plain.stream,
    catalogFn: CATALOG,
  });
  assert.equal(plain.requests.length, 1, "no nudge, no second ask");
  assert.equal(bare.truncated, true);
  assert.equal(bare.resumed, false);
});

test("a turn that ends on its last allowed round finished; one still paused there ran out of rounds", async () => {
  const paused = { content: [read, result], stop_reason: "pause_turn", usage };
  const done = { content: [{ type: "text", text: "SKIP" }], stop_reason: "end_turn", usage };
  const ends = playing([paused, done]);
  const finished = await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    maxRounds: 2,
    stream: ends.stream,
    catalogFn: CATALOG,
  });
  assert.equal(finished.rounds, 2);
  assert.equal(finished.truncated, false, "end_turn on the last round is a finished turn");
  const stuck = playing([paused, paused]);
  const out = await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    maxRounds: 2,
    stream: stuck.stream,
    catalogFn: CATALOG,
  });
  assert.equal(out.truncated, true);
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
    catalogFn: CATALOG,
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
    catalogFn: CATALOG,
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
    catalogFn: CATALOG,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /No price for model "claude-nonesuch-9"/);
  assert.equal(requests.length, 0, "nothing was sent, so nothing was paid for");
  assert.ok(out.turnId, "and the failure is still a turn the ledger can hold");
});

test("the toolset switches off the writes a kind of turn may not make; a rehearsal makes none", async () => {
  const done = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage };
  const configsFor = async (policy) => {
    const { stream, requests } = playing([done]);
    await ask({ system: "s", messages: [{ role: "user", content: "go" }], policy, stream, catalogFn: CATALOG });
    const toolset = requests[0].tools.find((t) => t.type === "mcp_toolset");
    return Object.keys(toolset.configs ?? {}).sort();
  };
  assert.deepEqual(await configsFor("rehearsal"), ["elixir_identify", "elixir_send_feedback", "elixir_track_clan"]);
  assert.deepEqual(await configsFor("routines"), ["elixir_identify", "elixir_track_clan"]);
  assert.deepEqual(
    await configsFor("ask"),
    ["elixir_identify", "elixir_track_clan"],
    "no member steers the bot into tracking a clan, or links anyone the runner did not name (link_me)",
  );
  assert.deepEqual(await configsFor("nonsense"), await configsFor("rehearsal"), "an unknown kind is the strictest");
});

test("a switched-off tool the API hands back to run is refused on the direct path too", async () => {
  const handedBack = { type: "tool_use", id: "toolu_1", name: "elixir-mcp_track_clan", input: { clan_tag: "#X" } };
  const { stream, requests } = playing([
    { content: [handedBack], stop_reason: "tool_use", usage },
    { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage },
  ]);
  const out = await ask({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    policy: "ask",
    stream,
    catalogFn: CATALOG,
  });
  assert.equal(out.ok, true);
  const result = requests[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /not available in this turn/);
});
