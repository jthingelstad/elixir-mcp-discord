/**
 * The connector can hand a tool call back to the client under a name the
 * server does not publish, and calling the wrong one fails in the worst
 * possible way: the model is told its call succeeded or failed on the strength
 * of a name we invented.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveToolName, describePrincipal, readPrincipal, PRINCIPAL_META_KEY } from "../src/mcp.js";

const NAMES = ["elixir_feedback", "elixir_my_feedback", "clans_roster", "players_search", "war_current"];
const resolve = (name) => resolveToolName(name, { serverName: "elixir-mcp", names: NAMES });

test("a published name is used as-is", async () => {
  assert.equal(await resolve("clans_roster"), "clans_roster");
});

test("the connector's renamed form resolves back to the real tool", async () => {
  // Observed: elixir_feedback came back as elixir-mcp_feedback, and the old
  // prefix-strip called "feedback", which does not exist.
  assert.equal(await resolve("elixir-mcp_feedback"), "elixir_feedback");
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
