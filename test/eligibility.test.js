import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createPolicyGate, CONTEXT_MAX_AGE_MS, POLICY_CONTEXT_TOOL } from "../src/eligibility.js";

// Exact synthetic core handoff, not a local tool/schema mirror:
// elixir-mcp@2d1b618e/packages/contracts/test/fixtures/clan-policy-context.json
const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/clan-policy-context.json", import.meta.url), "utf8"));
// Exact public MCP-envelope handoff from elixir-mcp@599ff6d6.
const mcpFixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/clans-context-mcp.json", import.meta.url), "utf8"));
const base = fixtures.find((f) => f.case === "participating").context;
const at = Date.parse(base.read_at);
const principal = () => ({ kind: "agent", subject: { type: "clan", tag: base.clan_tag } });
const routine = { key: "dependent", requires: { field: "war_intent", value: "participating" } };
const gateFor = (read, extras = {}) =>
  createPolicyGate({ read, principal, now: () => at, notice: async () => {}, ...extras });

test("the MCP transport reads the assigned context with no clan argument and unwraps the core result", async () => {
  const original = globalThis.fetch;
  const calls = [];
  let fixture;
  globalThis.fetch = async (_url, options) => {
    const call = JSON.parse(options.body);
    calls.push(call);
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            isError: fixture.isError,
            content: [{ type: "text", text: JSON.stringify(fixture.response) }],
          },
        }),
    };
  };
  try {
    for (fixture of mcpFixtures) {
      const gate = createPolicyGate({ principal, now: () => at, notice: async () => {} });
      const expected = ["participating", "old_policy_fresh_read"].includes(fixture.case)
        ? "allow"
        : fixture.case === "not_participating"
          ? "suppress"
          : "defer";
      assert.equal((await gate.check(routine)).disposition, expected, fixture.case);
    }
    assert.equal(calls[0].method, "tools/call");
    for (const call of calls) assert.deepEqual(call.params, { name: POLICY_CONTEXT_TOOL, arguments: {} });
  } finally {
    globalThis.fetch = original;
  }
});

test("the canonical handoff cases distinguish explicit intent, legacy unknown and fresh reads of old policy", async () => {
  const expected = {
    no_policy: "defer",
    legacy_or_unspecified: "defer",
    participating: "allow",
    not_participating: "suppress",
    old_policy_fresh_read: "allow",
  };
  for (const fixture of fixtures) {
    const gate = gateFor(async () => ({ ok: true, body: fixture.context }));
    assert.equal((await gate.check(routine)).disposition, expected[fixture.case], fixture.case);
  }
});

test("only read_at determines the 60-second permission bound, including transport delay and future skew", async () => {
  for (const [age, expected] of [
    [CONTEXT_MAX_AGE_MS, "allow"],
    [CONTEXT_MAX_AGE_MS + 1, "defer"],
    [-5000, "allow"],
    [-5001, "defer"],
  ]) {
    const gate = gateFor(async () => ({ ok: true, body: base }), { now: () => at + age });
    assert.equal((await gate.check(routine)).disposition, expected, `${age} ms old`);
  }
  let time = at;
  const gate = gateFor(
    async () => {
      time += CONTEXT_MAX_AGE_MS + 1;
      return { ok: true, body: base };
    },
    { now: () => time },
  );
  assert.equal((await gate.check(routine)).reason, "context_stale", "freshness is checked after the read finishes");
});

test("successful transport cannot admit wrong-clan, unsupported, inconsistent or overbroad context", async () => {
  const invalid = [
    { ...base, clan_tag: "#029" },
    { ...base, schema_version: 2 },
    { ...base, read_at: "not a date" },
    { ...base, policy_version: 0 },
    { ...base, reason: "no_policy" },
    { ...base, status: "unknown" },
    { ...base, private_notes: "must not be consumed" },
    { ...base, policy_saved_at: "yesterday" },
    { ...base, policy_version: undefined },
  ];
  for (const body of invalid) {
    assert.equal((await gateFor(async () => ({ ok: true, body })).check(routine)).disposition, "defer");
  }
  assert.equal(
    (await gateFor(async () => ({ ok: true, body: base }), { principal: () => ({ kind: "person" }) }).check(routine))
      .reason,
    "assigned_agent_required",
  );
});

test("denied, missing-tool, unavailable and error-envelope reads invalidate a previous allow", async () => {
  for (const failed of [
    { ok: false, error: "403" },
    { ok: false, error: "Unknown tool" },
    { ok: false, body: base },
    { ok: true, isError: true, body: base },
    null,
  ]) {
    let reply = { ok: true, body: base };
    const gate = gateFor(async () => reply);
    assert.equal((await gate.check(routine)).disposition, "allow");
    reply = failed;
    assert.equal((await gate.check(routine)).reason, "context_unavailable");
    assert.equal((await gate.check(routine, { fresh: false })).disposition, "defer", "no last-known allow");
  }
  assert.equal(
    (
      await gateFor(async () => {
        throw new Error("transport");
      }).check(routine)
    ).reason,
    "context_unavailable",
  );
});

test("revision changes replace permission; an older or mutated same-version response cannot restore it", async () => {
  let body = base;
  const gate = gateFor(async () => ({ ok: true, body }));
  assert.equal((await gate.check(routine)).disposition, "allow");
  body = { ...base, policy_version: 3, war_intent: "not_participating" };
  assert.equal((await gate.check(routine)).disposition, "suppress");
  assert.equal((await gate.check(routine, { fresh: false })).disposition, "suppress");
  body = base;
  assert.equal((await gate.check(routine)).reason, "context_revision_regressed");
  body = { ...base, policy_version: 3 };
  assert.equal((await gate.check(routine)).reason, "context_revision_inconsistent");
  body = { ...base, policy_version: 4 };
  assert.equal((await gate.check(routine)).disposition, "allow");
});

test("out-of-order refreshes never cache the earlier permission; ungated routines need no context", async () => {
  let resolveFirst;
  let calls = 0;
  const gate = gateFor(async () => {
    calls += 1;
    if (calls === 1)
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    return { ok: true, body: { ...base, war_intent: "not_participating" } };
  });
  const first = gate.check(routine);
  assert.equal((await gate.check(routine)).disposition, "suppress");
  resolveFirst({ ok: true, body: base });
  assert.equal((await first).reason, "context_superseded");
  assert.equal((await gate.check(routine, { fresh: false })).disposition, "suppress");
  assert.equal((await gate.check({ key: "factual" })).disposition, "allow");
  assert.equal(calls, 2);
});

test("operator diagnostics contain a bounded reason, never raw errors or the private payload", async () => {
  const notices = [];
  const gate = gateFor(async () => ({ ok: false, error: "private notes and credential material" }), {
    notice: async (...args) => notices.push(args),
  });
  const decision = await gate.check(routine);
  await gate.report(routine, decision, "fire");
  assert.match(notices[0][1], /context_unavailable/);
  assert.doesNotMatch(JSON.stringify(notices), /credential|private notes/);
});
