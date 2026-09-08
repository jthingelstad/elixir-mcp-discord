/**
 * Scheduling is unattended by definition — nobody is watching when it fires,
 * so a wrong occurrence or a broken ledger shows up as a duplicate post or a
 * silent week. That is exactly the code that has to be tested.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JOBS, lastOccurrence, dueJobs, isSkip } from "../src/schedule.js";

const daily = { key: "d", schedule: { hour: 12, minute: 30 }, catchUpHours: 4 };
const weekly = { key: "w", schedule: { weekday: 1, hour: 12, minute: 0 }, catchUpHours: 8 };
const at = (iso) => new Date(iso);

test("a daily job's occurrence is today when past, yesterday when not", () => {
  assert.equal(lastOccurrence(daily, at("2026-09-08T13:00:00Z")).toISOString(), "2026-09-08T12:30:00.000Z");
  assert.equal(lastOccurrence(daily, at("2026-09-08T11:00:00Z")).toISOString(), "2026-09-07T12:30:00.000Z");
});

test("a weekly job walks back to its own weekday", () => {
  // 2026-09-08 is a Tuesday; the Monday job's last run was the day before.
  assert.equal(lastOccurrence(weekly, at("2026-09-08T09:00:00Z")).toISOString(), "2026-09-07T12:00:00.000Z");
  // On the day itself, before the hour, it must not claim today.
  assert.equal(lastOccurrence(weekly, at("2026-09-07T09:00:00Z")).toISOString(), "2026-08-31T12:00:00.000Z");
  // On the day itself, after the hour, it is today.
  assert.equal(lastOccurrence(weekly, at("2026-09-07T13:00:00Z")).toISOString(), "2026-09-07T12:00:00.000Z");
});

test("a job is due once, then never again for that period", () => {
  const now = at("2026-09-08T12:31:00Z");
  const first = dueJobs(now, {}, [daily]);
  assert.equal(first.length, 1);

  const ledger = { d: first[0].occurrence.toISOString().slice(0, 16) };
  assert.equal(dueJobs(now, ledger, [daily]).length, 0, "must not repeat within the period");
  assert.equal(
    dueJobs(at("2026-09-09T12:31:00Z"), ledger, [daily]).length,
    1,
    "but must fire again the next day",
  );
});

test("a missed run fires late, but only inside its catch-up window", () => {
  assert.equal(dueJobs(at("2026-09-08T16:00:00Z"), {}, [daily]).length, 1, "3.5h late still counts");
  assert.equal(
    dueJobs(at("2026-09-08T17:00:00Z"), {}, [daily]).length,
    0,
    "4.5h late is stale — a war nudge at 4am is worse than none",
  );
});

test("SCHEDULE_DISABLED turns a job off by key", () => {
  const now = at("2026-09-08T12:31:00Z");
  process.env.SCHEDULE_DISABLED = "d";
  assert.equal(dueJobs(now, {}, [daily]).length, 0);
  process.env.SCHEDULE_DISABLED = "";
  assert.equal(dueJobs(now, {}, [daily]).length, 1);
});

test("every shipped job is well formed and uniquely keyed", () => {
  const keys = new Set();
  for (const job of JOBS) {
    assert.ok(job.key && !keys.has(job.key), `duplicate or missing key: ${job.key}`);
    keys.add(job.key);
    assert.ok(job.prompt.length > 100, `${job.key} prompt looks empty`);
    assert.ok(job.catchUpHours > 0, `${job.key} needs a catch-up window`);
    const { hour, minute, weekday } = job.schedule;
    assert.ok(hour >= 0 && hour <= 23, `${job.key} bad hour`);
    assert.ok(minute >= 0 && minute <= 59, `${job.key} bad minute`);
    if (weekday !== undefined) assert.ok(weekday >= 0 && weekday <= 6, `${job.key} bad weekday`);
  }
  assert.equal(JOBS.length, 6);
});

test("SKIP is recognised even when the model explains itself first", () => {
  assert.ok(isSkip("SKIP"));
  assert.ok(isSkip("  skip  "));
  assert.ok(isSkip(""));
  // The case that actually happened: reasoning, then SKIP on its own line.
  assert.ok(isSkip('period.kind is "training", not a war day.\n\nSKIP'));
  assert.ok(!isSkip("**War decks** — 9 untouched, 4 partial."));
  assert.ok(!isSkip("Nobody should skip their war decks today."));
});
