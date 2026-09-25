/**
 * The clock lane (2026-09-17): a routine armed from one game_clock field
 * plus an offset. Arithmetic, the catch-up window, seeding, once-per-boundary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { armFrom, nextPlanAt, startClockLane } from "../src/clock.js";
import { parseRoutine } from "../src/routines.js";
import * as state from "../src/state.js";
import * as budget from "../src/budget.js";
import { config } from "../src/config.js";

const doc = (fields) =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\nNudge.\n`;

const nudge = parseRoutine(
  "nudge",
  doc({ trigger: "clock", arm: "war_day_closes_at", offset: "-4h", catch_up_hours: 2 }),
);

test("armFrom: the field plus the offset; null arms nothing; a missed boundary fires inside catch-up only", () => {
  const now = new Date("2026-09-17T01:00:00Z");
  const clock = { war_day_closes_at: "2026-09-17T10:00:00.000Z", day_ends_at: "2026-09-17T10:00:00.000Z" };
  const armed = armFrom(nudge, clock, now);
  assert.equal(armed.at.toISOString(), "2026-09-17T06:00:00.000Z");
  assert.equal(armed.key, "war_day_closes_at@2026-09-17T10:00:00.000Z");
  assert.match(armFrom(nudge, { war_day_closes_at: null }, now).skip, /is null/, "a training day arms nothing");
  const late = armFrom(nudge, clock, new Date("2026-09-17T07:00:00Z"));
  assert.equal(late.late, true, "one hour late is inside a two-hour catch-up: fire now");
  assert.equal(late.at.toISOString(), "2026-09-17T07:00:00.000Z");
  assert.match(armFrom(nudge, clock, new Date("2026-09-17T09:00:00Z")).skip, /missed by 3\.0h/);
  assert.equal(
    nextPlanAt(clock, now).toISOString(),
    "2026-09-17T10:01:00.000Z",
    "re-plan a minute after the day rolls",
  );
  assert.equal(nextPlanAt({}, now).toISOString(), "2026-09-17T01:10:00.000Z", "no clock: retry in ten minutes");
});

test("the lane arms a timer per routine, fires once per boundary, seeds a boundary already behind it, and stops cleanly", async () => {
  state.set({ runs: {} });
  const fired = [];
  const clock = { war_day_closes_at: "2026-09-17T10:00:00.000Z", day_ends_at: "2026-09-17T10:00:00.000Z" };
  // Arms in the past within catch-up: the first sight seeds it, no fire.
  const lane = startClockLane(
    () => [nudge],
    async () => null,
    {
      readClock: async () => clock,
      runFn: async (routine) => {
        fired.push(routine.key);
        return { ok: true, skipped: false };
      },
      now: () => new Date("2026-09-17T07:00:00Z"),
    },
  );
  await lane.plan();
  assert.deepEqual(fired, [], "seed, never drain");
  assert.equal(state.get("runs").nudge, "war_day_closes_at@2026-09-17T10:00:00.000Z");
  lane.stop();

  // Next day: a fresh boundary, and the plan runs with the clock at the
  // firing instant, so the timer is immediate.
  const tomorrow = { war_day_closes_at: "2026-09-18T10:00:00.000Z", day_ends_at: "2026-09-18T10:00:00.000Z" };
  const lane2 = startClockLane(
    () => [nudge],
    async () => null,
    {
      readClock: async () => tomorrow,
      runFn: async (routine) => {
        fired.push(routine.key);
        return { ok: true, skipped: false };
      },
      now: () => new Date("2026-09-18T06:30:00Z"),
    },
  );
  await lane2.plan();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fired, ["nudge"], "thirty minutes late, inside catch-up: fired once");
  assert.equal(state.get("runs").nudge, "war_day_closes_at@2026-09-18T10:00:00.000Z");
  await lane2.plan();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fired, ["nudge"], "the same boundary never fires twice");
  lane2.stop();
});

test("a boundary the budget declines waits to retry instead of re-arming at once", async () => {
  state.set({ runs: { nudge: "war_day_closes_at@2026-09-18T10:00:00.000Z" } });
  const before = config.monthlyBudgetUsd;
  config.monthlyBudgetUsd = 1;
  budget.record("routines", 5);
  let reads = 0;
  const clock = { war_day_closes_at: "2026-09-19T10:00:00.000Z", day_ends_at: "2026-09-19T10:00:00.000Z" };
  const lane = startClockLane(
    () => [nudge],
    async () => null,
    {
      readClock: async () => {
        reads += 1;
        return clock;
      },
      runFn: async () => assert.fail("the lane is over budget"),
      // Thirty minutes late, inside catch-up: armed at zero delay.
      now: () => new Date("2026-09-19T06:30:00Z"),
    },
  );
  try {
    await lane.plan();
    await new Promise((r) => setTimeout(r, 50));
    // The lane plans on start and the test plans again; the decline re-plans
    // once and holds the boundary for ten minutes.
    assert.ok(reads <= 3, `one decline, then a ten-minute wait — not a loop (${reads} reads)`);
    assert.equal(state.get("runs").nudge, "war_day_closes_at@2026-09-18T10:00:00.000Z", "declined, so not marked");
  } finally {
    lane.stop();
    config.monthlyBudgetUsd = before;
  }
});
