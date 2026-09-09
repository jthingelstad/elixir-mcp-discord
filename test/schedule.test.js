/**
 * Scheduling is unattended by definition — nobody is watching when it fires,
 * so a wrong occurrence or a broken ledger shows up as a duplicate post or a
 * silent week, discovered by a member rather than by us. That is exactly the
 * code that has to be tested.
 *
 * The timezone cases are here because "22:00" written by an operator means
 * their 22:00, and a schedule that drifts an hour twice a year against the
 * humans reading it is a bug nobody reports and everybody notices.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { lastOccurrence, instantOf, periodKey, dueRoutines, currentPeriods } from "../src/schedule.js";

const CHICAGO = "America/Chicago";
const at = (iso) => new Date(iso);
const daily = { key: "d", trigger: "schedule", at: { hour: 12, minute: 30 }, catchUpHours: 4 };
const weekly = { key: "w", trigger: "schedule", at: { hour: 12, minute: 0 }, days: [1], catchUpHours: 8 };
const occurrence = (routine, now, tz = "UTC") => periodKey(lastOccurrence(routine, at(now), tz));

test("a daily routine's occurrence is today when past, yesterday when not", () => {
  assert.equal(occurrence(daily, "2026-09-08T13:00:00Z"), "2026-09-08T12:30");
  assert.equal(occurrence(daily, "2026-09-08T11:00:00Z"), "2026-09-07T12:30");
});

test("a weekly routine walks back to its own weekday", () => {
  // 2026-09-08 is a Tuesday; the Monday routine's last run was the day before.
  assert.equal(occurrence(weekly, "2026-09-08T09:00:00Z"), "2026-09-07T12:00");
  // On the day itself, before the hour, it must not claim today.
  assert.equal(occurrence(weekly, "2026-09-07T09:00:00Z"), "2026-08-31T12:00");
  // On the day itself, after the hour, it is today.
  assert.equal(occurrence(weekly, "2026-09-07T13:00:00Z"), "2026-09-07T12:00");
});

test("times are the operator's wall clock, not UTC", () => {
  // 18:00Z is 13:00 in Chicago, so the 12:30 routine has already run today.
  assert.equal(occurrence(daily, "2026-09-08T18:00:00Z", CHICAGO), "2026-09-08T12:30");
  // 16:00Z is 11:00 there — today's has not happened yet.
  assert.equal(occurrence(daily, "2026-09-08T16:00:00Z", CHICAGO), "2026-09-07T12:30");
});

test("a daily routine fires once per local day across a DST boundary", () => {
  const early = { key: "e", trigger: "schedule", at: { hour: 1, minute: 0 }, catchUpHours: 4 };
  // US clocks jump forward at 02:00 on 2026-03-08, so 01:00 is CST that day and
  // CDT the next: 23 hours apart in real time, one day apart on the wall clock.
  assert.equal(instantOf({ year: 2026, month: 3, day: 8, hour: 1, minute: 0 }, CHICAGO).toISOString(), "2026-03-08T07:00:00.000Z");
  assert.equal(instantOf({ year: 2026, month: 3, day: 9, hour: 1, minute: 0 }, CHICAGO).toISOString(), "2026-03-09T06:00:00.000Z");

  const ledger = {};
  let fires = 0;
  // Walk an hour at a time through the boundary; the ledger must let it fire
  // exactly once on each local day, never twice and never zero times.
  for (let hour = 0; hour < 72; hour += 1) {
    const now = new Date(Date.UTC(2026, 2, 7, 12) + hour * 3_600_000);
    for (const { routine, periodKey: key } of dueRoutines([early], { now, ledger, timezone: CHICAGO })) {
      ledger[routine.key] = key;
      fires += 1;
    }
  }
  assert.equal(fires, 3, "one run for each of the three local days covered");
});

test("a routine is due once, then never again for that period", () => {
  const now = at("2026-09-08T12:31:00Z");
  const first = dueRoutines([daily], { now, timezone: "UTC" });
  assert.equal(first.length, 1);

  const ledger = { d: first[0].periodKey };
  assert.equal(dueRoutines([daily], { now, ledger, timezone: "UTC" }).length, 0, "must not repeat");
  assert.equal(
    dueRoutines([daily], { now: at("2026-09-09T12:31:00Z"), ledger, timezone: "UTC" }).length,
    1,
    "but must fire again the next day",
  );
});

test("a missed run fires late, but only inside its catch-up window", () => {
  assert.equal(dueRoutines([daily], { now: at("2026-09-08T16:00:00Z"), timezone: "UTC" }).length, 1, "3.5h late still counts");
  assert.equal(
    dueRoutines([daily], { now: at("2026-09-08T17:00:00Z"), timezone: "UTC" }).length,
    0,
    "4.5h late is stale — a war nudge at 4am is worse than none",
  );
});

test("a disabled routine is never due, and non-schedule triggers are ignored", () => {
  const now = at("2026-09-08T12:31:00Z");
  assert.equal(dueRoutines([{ ...daily, disabled: true }], { now, timezone: "UTC" }).length, 0);
  assert.equal(dueRoutines([{ ...daily, trigger: "events" }], { now, timezone: "UTC" }).length, 0);
});

test("seeding marks every schedule routine's current period", () => {
  const seeded = currentPeriods([daily, weekly, { key: "m", trigger: "message" }], {
    now: at("2026-09-08T13:00:00Z"),
    timezone: "UTC",
  });
  assert.deepEqual(seeded, { d: "2026-09-08T12:30", w: "2026-09-07T12:00" });
  assert.equal(dueRoutines([daily, weekly], { now: at("2026-09-08T13:00:00Z"), ledger: seeded, timezone: "UTC" }).length, 0);
});
