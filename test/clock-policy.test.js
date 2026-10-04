import assert from "node:assert/strict";
import fs from "node:fs";
import { test, beforeEach } from "node:test";
import { createPolicyGate } from "../src/eligibility.js";
import { fire, startClockLane } from "../src/clock.js";
import { runRoutine } from "../src/run.js";
import { parseRoutine } from "../src/routines.js";
import * as state from "../src/state.js";

const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/clan-policy-context.json", import.meta.url), "utf8"));
const base = fixtures.find((f) => f.case === "participating").context;
const boundary = "war_day_closes_at@2026-10-05T10:00:00.000Z";
const previous = "war_day_closes_at@2026-10-04T10:00:00.000Z";
const clock = {
  war_day_closes_at: "2026-10-05T10:00:00Z",
  day_ends_at: "2026-10-05T10:00:00Z",
  week_ends_at: "2026-10-05T10:00:00Z",
};
const dependent = (extra = "") =>
  parseRoutine(
    "war-deck-check",
    `---\ntrigger: clock\narm: war_day_closes_at\noffset: -4h\nrequires: war_intent=participating\ncatch_up_hours: 2\nmay_skip: true\n${extra}---\nA synthetic positive participation brief.`,
  );
const factual = parseRoutine(
  "factual",
  "---\ntrigger: clock\narm: week_ends_at\noffset: -4h\nmay_skip: true\n---\nRead factual history.",
);

function timerHarness(start = "2026-10-05T05:59:00Z") {
  let time = Date.parse(start);
  const timers = new Set();
  return {
    now: () => new Date(time),
    setTimer: (fn, delay) => {
      const timer = { fn, at: time + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    async advance(iso) {
      time = Date.parse(iso);
      for (let i = 0; i < 30; i += 1) {
        const timer = [...timers].filter((t) => t.at <= time).sort((a, b) => a.at - b.at)[0];
        if (!timer) return;
        timers.delete(timer);
        await timer.fn();
      }
      assert.fail("timer loop: a refused boundary must wait ten minutes");
    },
  };
}

beforeEach(() =>
  state.set({
    runs: { "war-deck-check": previous, factual: previous },
    cursors: { editor: "unchanged" },
    carry: { editor: [] },
  }),
);

const fakeAnswer = {
  ok: true,
  text: "SKIP",
  called: [],
  errors: [],
  trace: [],
  envelopes: [],
  usd: 0,
  turnId: "fixture",
  ms: 0,
  rounds: 1,
  truncated: false,
};
const runner = (models) => (routine, options) =>
  runRoutine(routine, {
    ...options,
    dryRun: true,
    entries: [],
    sweepFn: async () => null,
    askFn: async () => {
      models.push(routine.key);
      return fakeAnswer;
    },
  });

test("policy changes between planning and firing suppress only the dependent turn without consuming it", async () => {
  const timers = timerHarness();
  let intent = "participating";
  let version = 2;
  const models = [];
  const gate = createPolicyGate({
    read: async () => ({
      ok: true,
      body: { ...base, war_intent: intent, policy_version: version, read_at: timers.now().toISOString() },
    }),
    principal: () => ({ kind: "agent", subject: { type: "clan", tag: base.clan_tag } }),
    now: () => Number(timers.now()),
    notice: async () => {},
  });
  const lane = startClockLane(
    () => [dependent(), factual],
    async () => null,
    { ...timers, readClock: async () => clock, gate, runFn: runner(models) },
  );
  try {
    await lane.plan();
    intent = "not_participating";
    version += 1;
    await timers.advance("2026-10-05T06:00:00Z");
    assert.deepEqual(models, ["factual"]);
    assert.equal(state.get("runs")["war-deck-check"], previous);
    assert.equal(state.get("cursors").editor, "unchanged");
    await timers.advance("2026-10-05T06:09:00Z");
    assert.deepEqual(models, ["factual"], "no refusal loop");
    intent = "participating";
    version += 1;
    await timers.advance("2026-10-05T06:10:00Z");
    assert.deepEqual(models, ["factual", "war-deck-check"]);
    assert.equal(state.get("runs")["war-deck-check"], boundary);
    await lane.plan();
    await timers.advance("2026-10-05T06:20:00Z");
    assert.equal(models.filter((k) => k === "war-deck-check").length, 1);
  } finally {
    lane.stop();
  }
});

test("missing tool, revoked access, stale data and legacy intent defer without model/run/cursor/spend consumption", async () => {
  for (const mode of ["missing", "denied", "stale", "unknown"]) {
    state.set({ runs: { "war-deck-check": previous }, cursors: { editor: "unchanged" } });
    const timers = timerHarness();
    let failed = true;
    const models = [];
    const notices = [];
    const gate = createPolicyGate({
      read: async () => {
        if (failed && ["missing", "denied"].includes(mode)) return { ok: false, error: mode };
        const context =
          failed && mode === "unknown" ? fixtures.find((f) => f.case === "legacy_or_unspecified").context : base;
        return {
          ok: true,
          body: {
            ...context,
            read_at: new Date(Number(timers.now()) - (failed && mode === "stale" ? 60_001 : 0)).toISOString(),
          },
        };
      },
      principal: () => ({ kind: "agent", subject: { type: "clan", tag: base.clan_tag } }),
      now: () => Number(timers.now()),
      notice: async (...args) => notices.push(args),
    });
    const spend = state.get("spendUsd");
    const lane = startClockLane(
      () => [dependent()],
      async () => null,
      { ...timers, gate, readClock: async () => clock, runFn: runner(models) },
    );
    try {
      await lane.plan();
      await timers.advance("2026-10-05T06:00:00Z");
      assert.deepEqual(models, [], mode);
      assert.equal(state.get("runs")["war-deck-check"], previous);
      assert.equal(state.get("cursors").editor, "unchanged");
      assert.equal(state.get("spendUsd"), spend);
      assert.ok(notices.length > 0, "operator gets the reason");
      failed = false;
      await timers.advance("2026-10-05T06:10:00Z");
      assert.deepEqual(models, ["war-deck-check"], `${mode} recovered`);
      assert.equal(state.get("runs")["war-deck-check"], boundary);
    } finally {
      lane.stop();
    }
  }
});

test("the last read happens after preparation; a revocation there cannot consume the run", async () => {
  let revoked = false;
  const now = () => new Date("2026-10-05T06:00:00Z");
  const gate = createPolicyGate({
    read: async () => (revoked ? { ok: false } : { ok: true, body: { ...base, read_at: now().toISOString() } }),
    principal: () => ({ kind: "agent", subject: { type: "clan", tag: base.clan_tag } }),
    now: () => Number(now()),
    notice: async () => {},
  });
  const models = [];
  const channel = {
    id: "default",
    messages: {
      fetch: async () => {
        revoked = true;
        return new Map();
      },
    },
  };
  const result = await fire(dependent("channel: pulse\nrecall: 1\n"), async () => channel, {
    key: boundary,
    gate,
    now,
    runFn: runner(models),
  });
  assert.equal(result.deferred, true);
  assert.deepEqual(models, []);
  assert.equal(state.get("runs")["war-deck-check"], previous);
});

test("the final read checks transport age and preparation cannot outlive the catch-up window", async () => {
  for (const mode of ["stale_read", "expired_window"]) {
    state.set({ runs: { "war-deck-check": previous } });
    let time = Date.parse("2026-10-05T06:00:00Z");
    let reads = 0;
    const models = [];
    const gate = createPolicyGate({
      read: async () => {
        const readAt = new Date(time).toISOString();
        if (++reads === 2 && mode === "stale_read") time += 60_001;
        return { ok: true, body: { ...base, read_at: readAt } };
      },
      principal: () => ({ kind: "agent", subject: { type: "clan", tag: base.clan_tag } }),
      now: () => time,
      notice: async () => {},
    });
    const result = await fire(
      dependent("channel: pulse\nrecall: 1\n"),
      async () => ({
        id: "default",
        messages: {
          fetch: async () => {
            if (mode === "expired_window") time = Date.parse("2026-10-05T08:00:00.001Z");
            return new Map();
          },
        },
      }),
      {
        key: boundary,
        gate,
        now: () => new Date(time),
        expiresAt: new Date("2026-10-05T08:00:00Z"),
        runFn: runner(models),
      },
    );
    assert.equal(result.error, mode === "stale_read" ? "eligibility:context_stale" : "eligibility:window_expired");
    assert.deepEqual(models, []);
    assert.equal(state.get("runs")["war-deck-check"], previous);
  }
});

test("eligible direct rehearsals receive no private context and denied rehearsals never call the model", async () => {
  let available = true;
  const now = () => Date.parse("2026-10-05T06:00:00Z");
  const gate = createPolicyGate({
    read: async () =>
      available ? { ok: true, body: { ...base, read_at: new Date(now()).toISOString() } } : { ok: false },
    principal: () => ({ kind: "agent", subject: { type: "clan", tag: base.clan_tag } }),
    now,
    notice: async () => {},
  });
  const inputs = [];
  const options = {
    dryRun: true,
    gate,
    entries: [],
    sweepFn: async () => null,
    askFn: async (input) => {
      inputs.push(input);
      return fakeAnswer;
    },
  };
  await runRoutine(dependent(), options);
  assert.equal(inputs.length, 1);
  assert.ok(!JSON.stringify(inputs).includes(base.clan_tag));
  assert.ok(!JSON.stringify(inputs).includes("policy_saved_at"));
  available = false;
  assert.equal((await runRoutine(dependent(), options)).deferred, true);
  assert.equal(inputs.length, 1);
  assert.equal(state.get("runs")["war-deck-check"], previous);
  assert.ok(!fs.readFileSync(state.STATE_PATH, "utf8").includes("policy_saved_at"));
});

test("expired deferred work is reported and stays unconsumed; cold installation never drains historical work", async () => {
  const timers = timerHarness();
  const models = [];
  const gate = createPolicyGate({ read: async () => ({ ok: false }), notice: async () => {} });
  const lane = startClockLane(
    () => [dependent()],
    async () => null,
    { ...timers, gate, readClock: async () => clock, runFn: runner(models) },
  );
  try {
    await lane.plan();
    await timers.advance("2026-10-05T06:00:00Z");
    await timers.advance("2026-10-05T08:01:00Z");
    assert.deepEqual(models, []);
    assert.equal(state.get("runs")["war-deck-check"], previous);
  } finally {
    lane.stop();
  }
  state.set({ runs: {} });
  const cold = timerHarness("2026-10-05T06:30:00Z");
  let available = false;
  const coldGate = createPolicyGate({
    read: async () => (available ? { ok: true, body: { ...base, read_at: cold.now().toISOString() } } : { ok: false }),
    principal: () => ({ kind: "agent", subject: { type: "clan", tag: base.clan_tag } }),
    now: () => Number(cold.now()),
    notice: async () => {},
  });
  const coldLane = startClockLane(
    () => [dependent()],
    async () => null,
    { ...cold, gate: coldGate, readClock: async () => clock, runFn: runner(models) },
  );
  try {
    await coldLane.plan();
    assert.equal(state.get("runs")["war-deck-check"], undefined, "unknown startup does not consume even a seed");
    available = true;
    await cold.advance("2026-10-05T06:40:00Z");
    assert.deepEqual(models, [], "a recovered first sight seeds history instead of posting it");
    assert.equal(state.get("runs")["war-deck-check"], boundary);
  } finally {
    coldLane.stop();
  }
});

test("a timer re-reads the prompt and disabled state instead of keeping the old parsed brief", async () => {
  const timers = timerHarness();
  let current = { ...dependent(), prompt: "old brief" };
  const seen = [];
  const gate = createPolicyGate({
    read: async () => ({ ok: true, body: { ...base, read_at: timers.now().toISOString() } }),
    principal: () => ({ kind: "agent", subject: { type: "clan", tag: base.clan_tag } }),
    now: () => Number(timers.now()),
    notice: async () => {},
  });
  const lane = startClockLane(
    () => (current ? [current] : []),
    async () => null,
    {
      ...timers,
      readClock: async () => clock,
      gate,
      runFn: async (r, options) => {
        const refusal = await options.beforeInvoke();
        if (refusal) return refusal;
        seen.push(r.prompt);
        return { ok: true, skipped: true };
      },
    },
  );
  try {
    await lane.plan();
    current = { ...current, prompt: "new brief" };
    await timers.advance("2026-10-05T06:00:00Z");
    assert.deepEqual(seen, ["new brief"]);
  } finally {
    lane.stop();
  }
  state.set({ runs: { "war-deck-check": previous } });
  const disabled = timerHarness();
  const lane2 = startClockLane(
    () => [current],
    async () => null,
    { ...disabled, readClock: async () => clock, gate, runFn: async () => assert.fail("disabled timer must not run") },
  );
  try {
    await lane2.plan();
    current = { ...current, disabled: true };
    await disabled.advance("2026-10-05T06:00:00Z");
    assert.equal(state.get("runs")["war-deck-check"], previous);
  } finally {
    lane2.stop();
  }
});
