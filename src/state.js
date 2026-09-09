/**
 * Tiny JSON file store: one event cursor per routine, the scheduled-run
 * ledger, today's measured spend, and the last surface version we saw.
 *
 * This is the only thing that survives a restart, and it is deliberately not
 * game data. Nothing here caches an answer, a roster or a player: every fact
 * this bot states is fetched in the turn that states it.
 *
 * CURSORS ARE PER ROUTINE, not per bot. Two event routines watching different
 * topics are two independent readers, and a shared position would let the
 * quiet one skip what the busy one already consumed. They are also kept here
 * rather than acknowledged server-side: `elixir_events` advances a single
 * per-ACCOUNT `events_seen_through` marker, so anything else polling the same
 * account would eat notifications this bot never showed anybody. We poll with
 * `mark_seen: false` and leave that marker exactly where it was.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.STATE_PATH
  ? path.resolve(process.env.STATE_PATH)
  : path.join(here, "..", "state", "state.json");

const DEFAULTS = {
  // { [routineKey]: eventId }. A key absent means "start from now" and is
  // seeded on first poll — never drained. An agent that wakes up and posts a
  // month of history into a channel is the most common mistake with a feed.
  cursors: {},
  // { [routineKey]: periodKey }. null = never seeded, which is distinct from
  // {} on purpose: an empty ledger on a fresh install would make every routine
  // whose window is still open fire at once, in the same minute.
  runs: null,
  spendDate: null,
  spendUsd: 0,
  // { [routineKey]: usd } for today. One global number cannot answer "is the
  // weekly meta report worth what it costs", which is the question an operator
  // tuning a schedule actually has.
  spendByRoutine: {},
  // { "YYYY-MM": { routines: usd, ask: usd } } — the monthly budget ledger,
  // kept per lane because the schedule's spend and the members' spend are
  // different people's decisions. Twelve months are retained.
  budgets: {},
  // { routines: usd, ask: usd } — the largest single turn each lane has ever
  // produced. A lane refuses to START a turn that could take it past its
  // budget, and this is what "could" means: it climbs to meet reality so the
  // estimate stops being optimistic after the first expensive turn.
  turnCeilings: {},
  // serverInfo.version from `initialize` — "<contract>+tools.<fingerprint>".
  // Moves when the TOOL SCHEMAS change. Distinct from contractVersion below:
  // different strings from different calls, and storing both in one field logs
  // drift forever.
  serverVersion: null,
  // meta.contract_version carried on every tool response — bare "<contract>".
  contractVersion: null,
  // The principal block from initialize, so a key repointed at another clan is
  // a log line rather than a channel quietly reporting on strangers.
  principal: null,
  answeredFeedbackIds: [],
};

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export function get(key) {
  return read()[key];
}

export function set(updates) {
  const state = { ...read(), ...updates };
  write(state);
  return state;
}

export function cursorFor(routineKey) {
  return read().cursors[routineKey] ?? null;
}

export function setCursor(routineKey, cursor) {
  const state = read();
  write({ ...state, cursors: { ...state.cursors, [routineKey]: cursor } });
}

export function markRun(routineKey, periodKey) {
  const state = read();
  write({ ...state, runs: { ...(state.runs || {}), [routineKey]: periodKey } });
}

/** Adds to today's spend and returns the new total, rolling over at midnight UTC. */
export function addSpend(usd, routineKey = "unattributed") {
  const today = new Date().toISOString().slice(0, 10);
  const state = read();
  const fresh = state.spendDate !== today;
  const spendUsd = (fresh ? 0 : state.spendUsd) + usd;
  const byRoutine = fresh ? {} : { ...state.spendByRoutine };
  byRoutine[routineKey] = (byRoutine[routineKey] || 0) + usd;
  write({ ...state, spendDate: today, spendUsd, spendByRoutine: byRoutine });
  return spendUsd;
}

export function todaySpend() {
  const today = new Date().toISOString().slice(0, 10);
  const state = read();
  return state.spendDate === today ? state.spendUsd : 0;
}

export function todaySpendByRoutine() {
  const today = new Date().toISOString().slice(0, 10);
  const state = read();
  return state.spendDate === today ? state.spendByRoutine : {};
}
