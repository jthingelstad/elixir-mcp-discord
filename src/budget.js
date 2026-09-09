/**
 * Monthly budgets the bot cannot exceed, kept per LANE because the two lanes
 * are driven by different people.
 *
 *   routines — what the bot decides to do: scheduled posts, event briefs.
 *              Its cost is a function of the schedule YOU wrote, so it is
 *              predictable and it is yours.
 *
 *   ask      — what clan members ask for. Its cost is a function of how
 *              talkative the channel is, which is nobody's decision in
 *              particular. Sharing one pot means a busy afternoon in the ask
 *              channel silently cancels the war-deck nudge at 01:00, and the
 *              operator finds out from the silence.
 *
 * STRICT means the check happens BEFORE the call, against a reserve rather
 * than against the spend so far. A turn's cost is not knowable in advance, so
 * refusing only once spent >= budget guarantees an overshoot of one turn every
 * month, and a big turn can overshoot a lot. Instead every lane keeps the
 * largest turn it has ever seen, floored by TURN_RESERVE_USD, and refuses to
 * start a turn that could take it past the line. The ceiling climbs to meet
 * reality: a lane that once cost $0.42 in a turn reserves $0.42 from then on.
 *
 * The month is a UTC calendar month, because that is the one that matches an
 * invoice. Nothing rolls over.
 */

import { config } from "./config.js";
import { log } from "./log.js";
import * as state from "./state.js";

export const LANES = ["routines", "ask"];

export const monthKey = (now = new Date()) => now.toISOString().slice(0, 7);

export function laneFor(routine) {
  return routine?.trigger === "message" ? "ask" : "routines";
}

function budgetFor(lane) {
  return lane === "ask" ? config.askMonthlyBudgetUsd : config.monthlyBudgetUsd;
}

function ledger(now = new Date()) {
  const all = state.get("budgets") || {};
  return all[monthKey(now)] || {};
}

export function spent(lane, now = new Date()) {
  return ledger(now)[lane] || 0;
}

/** The largest single turn this lane has produced, floored by config. A lane
 *  with no history reserves the floor, which is why the floor should be a
 *  believable turn rather than a rounding error. */
export function reserveFor(lane) {
  const seen = (state.get("turnCeilings") || {})[lane] || 0;
  return Math.max(seen, config.turnReserveUsd);
}

/**
 * May this lane start a turn?
 *
 * Returns { ok } or { ok: false, reason, spent, budget, reserve } — the caller
 * decides whether that is a log line or a sentence in a channel.
 */
export function check(lane, now = new Date()) {
  const budget = budgetFor(lane);
  if (!budget) return { ok: true, unlimited: true };
  const used = spent(lane, now);
  const reserve = reserveFor(lane);
  if (used >= budget) {
    return { ok: false, reason: "exhausted", spent: used, budget, reserve };
  }
  if (used + reserve > budget) {
    // Not exhausted, but the next turn could cross the line — so this is where
    // it stops. The alternative is spending past a number the operator set.
    return { ok: false, reason: "reserve", spent: used, budget, reserve };
  }
  return { ok: true, spent: used, budget, reserve, remaining: budget - used };
}

/** Record what a turn actually cost, and let the lane's ceiling climb to it. */
export function record(lane, usd, now = new Date()) {
  if (!(usd > 0)) return;
  const key = monthKey(now);
  const budgets = { ...(state.get("budgets") || {}) };
  const month = { ...(budgets[key] || {}) };
  month[lane] = (month[lane] || 0) + usd;
  budgets[key] = month;

  const ceilings = { ...(state.get("turnCeilings") || {}) };
  if (usd > (ceilings[lane] || 0)) {
    ceilings[lane] = usd;
    log.info("turn_ceiling_raised", { lane, usd: usd.toFixed(4) });
  }

  // Months are kept for a year: enough to answer "what did last season cost"
  // without the file growing forever.
  const keep = Object.keys(budgets).sort().slice(-12);
  state.set({
    budgets: Object.fromEntries(keep.map((k) => [k, budgets[k]])),
    turnCeilings: ceilings,
  });
}

/** What to show an operator: per lane, this month. */
export function status(now = new Date()) {
  return LANES.map((lane) => {
    const budget = budgetFor(lane);
    const used = spent(lane, now);
    return {
      lane,
      month: monthKey(now),
      spent: used,
      budget: budget ?? null,
      remaining: budget ? Math.max(0, budget - used) : null,
      reserve: reserveFor(lane),
      state: !budget
        ? "unlimited"
        : check(lane, now).ok
          ? "ok"
          : used >= budget
            ? "exhausted"
            : "reserved",
    };
  });
}
