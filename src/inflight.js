/**
 * Turns in progress, so a shutdown can wait for them.
 *
 * A restart used to be a kill: `launchctl kickstart -k` sends SIGTERM, Node
 * exits at once, and whatever turn was running — a member's question, a
 * scheduled report already marked in the run ledger — died between the model
 * call and the post. Twice on 2026-09-13. Now every turn is tracked here and
 * SIGTERM waits for the count to reach zero (bounded) before the process
 * goes; new work is refused meanwhile.
 */

let inFlight = 0;
let stopping = false;
const waiters = [];

export function isStopping() {
  return stopping;
}

export function count() {
  return inFlight;
}

/** Run `work` as a tracked turn. */
export async function track(work) {
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
    if (inFlight === 0) for (const resolve of waiters.splice(0)) resolve();
  }
}

/** Refuse new turns and resolve when the current ones are done, or when
 *  `timeoutMs` passes. Returns how many were still running at that point. */
export function drain(timeoutMs) {
  stopping = true;
  if (inFlight === 0) return Promise.resolve(0);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(inFlight), timeoutMs);
    waiters.push(() => {
      clearTimeout(timer);
      resolve(0);
    });
  });
}
