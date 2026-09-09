/**
 * The clock lane. Ticks once a minute, runs whatever is due.
 *
 * Routines are re-read on every tick, so adding a post, changing a time or
 * fixing a prompt is a file edit and nothing else — no restart, no deploy. The
 * whole point of running this bot is finding out what the prompts should say,
 * and a restart between attempts is how a person stops iterating.
 */

import { config } from "./config.js";
import { dueRoutines, currentPeriods } from "./schedule.js";
import { runRoutine } from "./run.js";
import { spendBlock } from "./claude.js";
import { log } from "./log.js";
import * as state from "./state.js";

export async function tick(routines, resolveChannel, now = new Date()) {
  const due = dueRoutines(routines, { now, ledger: state.get("runs") || {} });
  if (due.length === 0) return;
  const blocked = spendBlock("routines");
  if (blocked) {
    // Deliberately BEFORE the run ledger is marked, so a routine skipped for
    // budget is not recorded as done: when the month turns over it runs again
    // rather than having silently missed its window.
    log.warn("scheduled_over_budget", {
      reason: blocked.reason,
      due: due.map((entry) => entry.routine.key).join(","),
    });
    return;
  }

  for (const { routine, periodKey } of due) {
    // Recorded BEFORE the call, not after. A crash mid-post must not leave the
    // routine eligible again on the next tick and post twice.
    state.markRun(routine.key, periodKey);
    const channel = await resolveChannel(routine.channel);
    if (!channel) {
      log.error("scheduled_channel_missing", {
        routine: routine.key,
        channel: routine.channel,
      });
      continue;
    }
    await runRoutine(routine, { channel }).catch((error) =>
      log.error("scheduled_crashed", {
        routine: routine.key,
        error: error.message,
      }),
    );
  }
}

export function startScheduler(routinesFn, resolveChannel) {
  // First run marks every routine as already done for its current window, so a
  // fresh install does not fire three backdated posts in the same minute. Same
  // rule as the event cursor and the feedback ledger: seed, never drain.
  if (state.get("runs") === null) {
    const seeded = currentPeriods(routinesFn());
    state.set({ runs: seeded });
    log.info("scheduler_seeded", { routines: Object.keys(seeded).length });
  }

  log.info("scheduler_started", {
    timezone: config.timezone,
    routines: routinesFn()
      .map((routine) => routine.key)
      .join(","),
  });

  const run = () =>
    tick(routinesFn(), resolveChannel).catch((error) =>
      log.error("scheduler_tick_failed", { error: error.message }),
    );
  void run();
  return setInterval(run, 60_000);
}
