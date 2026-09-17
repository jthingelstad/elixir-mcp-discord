/**
 * The clock lane — since 2026-09-17. A `trigger: clock` routine is armed
 * from one field of Elixir MCP's `game_clock` plus an offset, not from a
 * wall time typed into front matter:
 *
 *     trigger: clock
 *     arm: war_day_closes_at
 *     offset: -4h
 *
 * fires four hours before THIS war day closes, and on a training day —
 * where the field is null — arms nothing and spends nothing. Before this,
 * `war-deck-check` ran at 01:00 every night and paid ~$0.08 to say SKIP on
 * every training day (nine of thirteen turns, three instances, 09-09..16).
 *
 * The record decides when most proactive turns fire (src/events.js); this
 * lane is for the genuinely clock-bound remainder — a nudge that has to
 * land BEFORE a boundary — and the clock it reads is the hub's, so the
 * war day open/close rule ratified there on 2026-09-13 ("the clock is the
 * agent's, never the feed's") is honoured: the routine schedules itself.
 *
 * One `game_clock` read plans every clock routine; the plan is re-read at
 * the next day roll (`day_ends_at`) and after any routine fires. The run
 * ledger key is the boundary's own instant, so a restart never fires the
 * same boundary twice and a re-read that yields the same boundary is a
 * no-op. Seed, never drain: the first plan for a routine marks a boundary
 * already behind it as done rather than firing it late.
 */

import { callTool } from "./mcp.js";
import { runRoutine } from "./run.js";
import { spendBlock } from "./claude.js";
import { log } from "./log.js";
import { notify } from "./notify.js";
import * as state from "./state.js";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
/** setTimeout's ceiling is ~24.8 days; a day roll is never further than a day. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const RETRY_MS = 10 * MIN_MS;

/**
 * When a routine should fire given a clock reading, or why not.
 *   { at, key }         — arm at this instant (may be `now` for a missed one inside catch-up)
 *   { skip: reason }    — nothing to arm from this reading
 */
export function armFrom(routine, clock, now = new Date()) {
  const raw = clock?.[routine.arm];
  if (!raw) return { skip: `${routine.arm} is null` };
  const boundary = new Date(raw);
  if (Number.isNaN(boundary.getTime())) return { skip: `${routine.arm} unreadable: ${raw}` };
  const at = new Date(boundary.getTime() + (routine.offsetMinutes ?? 0) * MIN_MS);
  const key = `${routine.arm}@${boundary.toISOString()}`;
  if (at <= now) {
    const ageHours = (now - at) / HOUR_MS;
    if (ageHours > routine.catchUpHours) return { skip: `missed by ${ageHours.toFixed(1)}h`, key };
    return { at: now, key, late: true };
  }
  return { at, key };
}

/** The next moment the plan should be re-read: the day roll, or a retry. */
export function nextPlanAt(clock, now = new Date()) {
  const roll = clock?.day_ends_at ? new Date(clock.day_ends_at) : null;
  if (roll && roll > now) return new Date(roll.getTime() + MIN_MS);
  return new Date(now.getTime() + RETRY_MS);
}

export async function fire(routine, resolveChannel, { key, runFn = runRoutine } = {}) {
  const blocked = spendBlock("routines");
  if (blocked) {
    // Same rule as the scheduler: not marked, so it runs at the next boundary
    // once the month turns rather than having silently missed this one.
    log.warn("clock_over_budget", { routine: routine.key, reason: blocked.reason });
    await notify(
      "budget",
      `${routine.key} was due and not run: the routines lane is ${blocked.reason}. It runs again when the budget resets.`,
      { fingerprint: `budget:routines:${blocked.reason}`, every: 24 * HOUR_MS },
    );
    return null;
  }
  // Marked BEFORE the call, like the scheduler: a crash mid-post must not
  // leave the boundary eligible again — and a boundary already marked (two
  // timers racing after a re-plan) fires nothing.
  if ((state.get("runs") || {})[routine.key] === key) return null;
  state.markRun(routine.key, key);
  const channel = routine.channel ? await resolveChannel(routine.channel) : null;
  if (routine.channel && !channel) {
    log.error("clock_channel_missing", { routine: routine.key, channel: routine.channel });
    return null;
  }
  const run = await runFn(routine, { channel }).catch((error) => {
    log.error("clock_crashed", { routine: routine.key, error: error.message });
    return null;
  });
  log.info("clock_fired", { routine: routine.key, key, ok: run?.ok ?? false, posted: run ? !run.skipped : false });
  return run;
}

/**
 * @param {Function} routinesFn      the current clock routines (re-read on every plan)
 * @param {Function} resolveChannel  logical name -> Discord channel
 * @param {object}   deps            readClock / runFn / now, injectable for tests
 * @returns {{ stop: Function, plan: Function }}
 */
export function startClockLane(
  routinesFn,
  resolveChannel,
  { readClock = null, runFn = runRoutine, now = () => new Date() } = {},
) {
  const read =
    readClock ??
    (async () => {
      const result = await callTool("game_clock", {});
      return result.ok ? (result.body ?? null) : null;
    });
  const timers = new Map();
  let planTimer = null;
  let stopped = false;

  const clear = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    if (planTimer) clearTimeout(planTimer);
    planTimer = null;
  };

  // Plans are serialized: a re-plan while one is still reading the clock
  // would arm a second timer for the same boundary.
  let chain = Promise.resolve();
  const plan = () => {
    chain = chain.then(planNow).catch((error) => log.error("clock_plan_failed", { error: error.message }));
    return chain;
  };
  const planNow = async () => {
    if (stopped) return;
    clear();
    const routines = routinesFn();
    const at = now();
    let clock = null;
    if (routines.length) {
      clock = await read().catch((error) => {
        log.warn("clock_read_failed", { error: error.message });
        return null;
      });
      if (!clock) log.warn("clock_unreadable", { retry_minutes: RETRY_MS / MIN_MS });
    }
    if (stopped) return;
    const ledger = state.get("runs") || {};
    for (const routine of routines) {
      if (!clock) continue;
      const armed = armFrom(routine, clock, at);
      if (armed.skip) {
        log.info("clock_idle", { routine: routine.key, reason: armed.skip });
        continue;
      }
      if (ledger[routine.key] === armed.key) continue;
      if (!(routine.key in ledger)) {
        // First sight of this routine: a boundary already behind it is
        // history, not a missed run. Future ones fire.
        if (armed.late) {
          state.markRun(routine.key, armed.key);
          log.info("clock_seeded", { routine: routine.key, key: armed.key });
          continue;
        }
      }
      const delay = Math.min(MAX_TIMER_MS, Math.max(0, armed.at - at));
      log.info("clock_armed", {
        routine: routine.key,
        at: armed.at.toISOString(),
        key: armed.key,
        late: armed.late ?? false,
      });
      const timer = setTimeout(() => {
        timers.delete(routine.key);
        void fire(routine, resolveChannel, { key: armed.key, runFn })
          .catch((error) => log.error("clock_fire_failed", { routine: routine.key, error: error.message }))
          .finally(() => void plan());
      }, delay);
      // Never the reason the process stays up: the Discord client is.
      timer.unref?.();
      timers.set(routine.key, timer);
    }
    const again = nextPlanAt(clock, at);
    planTimer = setTimeout(() => void plan(), Math.min(MAX_TIMER_MS, Math.max(MIN_MS, again - at)));
    planTimer.unref?.();
    if (routines.length) log.info("clock_planned", { routines: routines.length, next_plan: again.toISOString() });
  };

  void plan();
  return {
    plan,
    stop() {
      stopped = true;
      clear();
    },
  };
}
