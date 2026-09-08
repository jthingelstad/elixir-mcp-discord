/**
 * Tiny JSON file store: the feed cursor, today's measured spend, and the last
 * serverInfo.version we saw.
 *
 * The cursor is the important one. `elixir_events` keeps a per-ACCOUNT
 * `events_seen_through` marker, and a second token on the same account shares
 * it — so if this bot acknowledged events, it would silently consume
 * notifications belonging to any other routine on that account, and vice versa.
 * We therefore poll with `mark_seen: false` and track our own position here.
 * The account cursor is left exactly where it was.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(here, "..", "state", "state.json");

const DEFAULTS = {
  eventCursor: null, // null = "start from now", set on first poll
  spendDate: null,
  spendUsd: 0,
  // serverInfo.version from `initialize` — "<contract>+tools.<fingerprint>".
  // Moves when the TOOL SCHEMAS change, which is the signal we actually care
  // about. Distinct from contractVersion below: they are different strings from
  // different calls, and storing both in one field logs drift forever.
  serverVersion: null,
  // meta.contract_version carried on every tool response — bare "<contract>".
  contractVersion: null,
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

/** Adds to today's spend and returns the new total, rolling over at UTC midnight. */
export function addSpend(usd) {
  const today = new Date().toISOString().slice(0, 10);
  const state = read();
  const spendUsd = (state.spendDate === today ? state.spendUsd : 0) + usd;
  write({ ...state, spendDate: today, spendUsd });
  return spendUsd;
}

export function todaySpend() {
  const today = new Date().toISOString().slice(0, 10);
  const state = read();
  return state.spendDate === today ? state.spendUsd : 0;
}
