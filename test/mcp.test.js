/**
 * The connector can hand a tool call back to the client under a name the
 * server does not publish, and calling the wrong one fails in the worst
 * possible way: the model is told its call succeeded or failed on the strength
 * of a name we invented.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveToolName,
  describePrincipal,
  readPrincipal,
  PRINCIPAL_META_KEY,
  callTool,
  requestIdOf,
} from "../src/mcp.js";

const NAMES = ["elixir_send_feedback", "elixir_my_feedback", "clans_roster", "players_search", "war_current"];
const resolve = (name) => resolveToolName(name, { serverName: "elixir-mcp", names: NAMES });

test("a published name is used as-is", async () => {
  assert.equal(await resolve("clans_roster"), "clans_roster");
});

test("the connector's renamed form resolves back to the real tool", async () => {
  // Observed: elixir_send_feedback came back as elixir-mcp_send_feedback, and the old
  // prefix-strip called "feedback", which does not exist.
  assert.equal(await resolve("elixir-mcp_send_feedback"), "elixir_send_feedback");
  assert.equal(await resolve("elixir-mcp_my_feedback"), "elixir_my_feedback");
});

test("an unknown name is passed through, not silently substituted", async () => {
  // Better the server says "unknown tool" than that we quietly run a different
  // one and report it as the one that was asked for.
  assert.equal(await resolve("elixir-mcp_nothing_like_this"), "nothing_like_this");
});

test("the principal block is read from _meta and described in one line", () => {
  const principal = { kind: "agent", subject: { type: "clan", tag: "#ABC", name: "Test Clan", members: 12 } };
  assert.deepEqual(readPrincipal({ _meta: { [PRINCIPAL_META_KEY]: principal } }), principal);
  assert.equal(readPrincipal({}), null, "an older server publishing no block is not an error");
  assert.match(describePrincipal(principal), /agent acting for clan Test Clan #ABC, 12 members/);
  assert.match(describePrincipal({ kind: "agent", subject: null }), /no subject/);
  assert.match(describePrincipal(null), /unknown/);
});

// One line per call (2026-10-10): the tool, how long, how big, and the hub's
// request id, which keys the hub's own audit row.
test("every tool call logs one line carrying the hub's request id", async () => {
  const original = globalThis.fetch;
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  globalThis.fetch = async (_url, options) => {
    const call = JSON.parse(options.body);
    const body = { timeline: [], meta: { request_id: "req-123" } };
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: { content: [{ type: "text", text: JSON.stringify(body) }] },
        }),
    };
  };
  try {
    const result = await callTool("elixir_timeline", { mark_read: false });
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = original;
    console.log = originalLog;
  }
  const line = lines.find((l) => l.includes(" mcp_call "));
  assert.ok(line, "an mcp_call line");
  assert.match(line, /tool=elixir_timeline/);
  assert.match(line, /ok=true/);
  assert.match(line, /request_id=req-123/);
  assert.match(line, /ms=\d+/);
  assert.match(line, /bytes=\d+/);
});

test("a failed call still logs its line, with the error", async () => {
  const original = globalThis.fetch;
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  try {
    const result = await callTool("game_clock", {});
    assert.equal(result.ok, false);
  } finally {
    globalThis.fetch = original;
    console.log = originalLog;
  }
  const line = lines.find((l) => l.includes(" mcp_call "));
  assert.match(line, /tool=game_clock .*ok=false .*error=http 429/);
});

test("the request id is read from a refusal as well as a success", () => {
  const wrap = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
  assert.equal(requestIdOf(wrap({ meta: { request_id: "a" } })), "a");
  assert.equal(requestIdOf(wrap({ error: { code: "rate_limited", request_id: "b" } })), "b");
  assert.equal(requestIdOf(wrap({ timeline: [] })), null);
  assert.equal(requestIdOf({ content: [{ type: "text", text: "not json request_id" }] }), null);
  assert.equal(requestIdOf(null), null);
});
