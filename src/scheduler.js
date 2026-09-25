/**
 * The clock lane. Ticks once a minute, runs whatever is due.
 *
 * Routines are re-read on every tick, so adding a post, changing a time or
 * fixing a prompt is a file edit and nothing else — no restart, no deploy. The
 * whole point of running this bot is finding out what the prompts should say,
 * and a restart between attempts is how a person stops iterating.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { dueRoutines, currentPeriods } from "./schedule.js";
import { runRoutine } from "./run.js";
import { spendBlock } from "./claude.js";
import { withFields } from "./routines.js";
import { log } from "./log.js";
import { notify } from "./notify.js";
import { commitInstance } from "./instance-git.js";
import * as state from "./state.js";

/** A one-shot has fired: write it back disabled, keeping the file. */
export function retireOnce(routine, { agentDir = config.agentDir } = {}) {
  const file = path.join(agentDir, "routines", `${routine.key}.md`);
  try {
    const text = fs.readFileSync(file, "utf8");
    const history = path.join(agentDir, ".history");
    fs.mkdirSync(history, { recursive: true });
    fs.copyFileSync(
      file,
      path.join(history, `routines__${routine.key}.md.${new Date().toISOString().replace(/[:.]/g, "-")}`),
    );
    fs.writeFileSync(file, withFields(text, { enabled: "false" }));
    log.info("routine_once_done", { routine: routine.key });
    void commitInstance({ message: `Retire one-shot ${routine.key} after it ran` });
    return true;
  } catch (error) {
    log.warn("routine_once_retire_failed", { routine: routine.key, error: error.message });
    return false;
  }
}

export async function tick(routines, resolveChannel, now = new Date(), { runFn = runRoutine } = {}) {
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
    await notify(
      "budget",
      `${due.map((e) => e.routine.key).join(", ")} due and not run: the routines lane is ${blocked.reason} ($${blocked.spent?.toFixed(2) ?? "?"} of $${blocked.budget?.toFixed(2) ?? "?"} this month). They run again when it resets.`,
      { fingerprint: `budget:routines:${blocked.reason}`, every: 24 * 3600 * 1000 },
    );
    return;
  }

  for (const { routine, periodKey } of due) {
    // `due` was read before the first routine in it ran, and a turn can take
    // minutes: whoever else ran this period since (another tick, another
    // process) has marked it, and it is theirs.
    if ((state.get("runs") || {})[routine.key] === periodKey) continue;
    // Recorded BEFORE the call, not after. A crash mid-post must not leave the
    // routine eligible again on the next tick and post twice.
    state.markRun(routine.key, periodKey);
    // A bound channel that cannot be resolved is an error; no binding at all
    // is a routine that posts through the directory.
    const channel = routine.channel ? await resolveChannel(routine.channel) : null;
    if (routine.channel && !channel) {
      log.error("scheduled_channel_missing", {
        routine: routine.key,
        channel: routine.channel,
      });
      continue;
    }
    const run = await runFn(routine, { channel }).catch((error) => {
      log.error("scheduled_crashed", {
        routine: routine.key,
        error: error.message,
      });
      return null;
    });
    if (routine.once && run) {
      retireOnce(routine);
      await notify(
        "one-shot done",
        `${routine.key} ran${run.ok ? (run.skipped ? " (and chose to post nothing)" : "") : ` and failed: ${run.error}`}; it is now disabled. Delete it from the DM when you are done with it.`,
        { fingerprint: `once:${routine.key}` },
      );
    }
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

  // One tick at a time. A tick that runs two due routines, the first of which
  // takes longer than a minute, used to overlap the next tick — which ran the
  // second routine, and then the first tick ran it again.
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(routinesFn(), resolveChannel);
    } catch (error) {
      log.error("scheduler_tick_failed", { error: error.message });
    } finally {
      busy = false;
    }
  };
  void run();
  return setInterval(run, 60_000);
}
