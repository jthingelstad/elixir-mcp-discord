/**
 * The scheduler's tick, which nobody watches: a routine that runs twice is a
 * duplicate post discovered by a member. The arithmetic of WHEN is pinned in
 * schedule.test.js; this pins that a period runs once however the ticks fall.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import fs from "node:fs";
import { tick } from "../src/scheduler.js";
import { parseRoutine } from "../src/routines.js";
import * as state from "../src/state.js";

const daily = (key) => parseRoutine(key, `---\ntrigger: schedule\nat: 12:00\n---\n${key}\n`);
const NOW = new Date("2026-09-25T12:05:00Z");

beforeEach(() => {
  fs.rmSync(process.env.STATE_PATH, { force: true });
  state.set({ runs: {} });
});

test("a due routine runs once and is marked before it runs", async () => {
  const ran = [];
  await tick([daily("a")], async () => null, NOW, {
    runFn: async (routine) => {
      ran.push([routine.key, state.get("runs")[routine.key]]);
      return { ok: true };
    },
  });
  assert.deepEqual(ran, [["a", "2026-09-25T12:00"]]);
  await tick([daily("a")], async () => null, NOW, { runFn: async () => assert.fail("already ran this period") });
});

test("a tick that overlaps a slow one does not run the same period twice", async () => {
  const ran = [];
  let releaseA;
  const slowA = new Promise((resolve) => (releaseA = resolve));
  const runFn = async (routine) => {
    ran.push(routine.key);
    if (routine.key === "a") await slowA;
    return { ok: true };
  };
  const routines = [daily("a"), daily("b")];

  // The first tick reads both as due, then spends minutes on a.
  const first = tick(routines, async () => null, NOW, { runFn });
  await new Promise((r) => setImmediate(r));
  // The next tick sees b still unmarked and runs it.
  await tick(routines, async () => null, NOW, { runFn });
  releaseA();
  await first;

  assert.deepEqual(ran.sort(), ["a", "b"], "b ran once, not once per tick");
});
