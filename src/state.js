/**
 * Tiny JSON file store: one event cursor per routine, the scheduled-run
 * ledger, today's measured spend, each routine's own last few posts, and the
 * last surface version we saw.
 *
 * This is the only thing that survives a restart, and it is deliberately not
 * game data. Nothing here caches an answer, a roster or a player: every fact
 * this bot states is fetched in the turn that states it.
 *
 * CURSORS ARE PER ROUTINE, not per bot. Two event routines watching different
 * topics are two independent readers, and a shared position would let the
 * quiet one skip what the busy one already consumed. Since hub contract
 * 3.18.0 each routine also reads as its own named `reader` and marks it
 * (src/events.js), which moves that reader's pointer and never the account's
 * `activity_seen_at`. The cursor kept here is still what `from` comes from:
 * it moves only after a successful turn, so a failed one reads its window
 * again even though the hub's pointer has moved on.
 */

import fs from "node:fs";
import path from "node:path";
import { instanceDir } from "./config.js";
import { log } from "./log.js";

// Relative to the INSTANCE directory, not the checkout. Several instances of
// one checkout must never share a state file; see instanceDir in config.js.
export const STATE_PATH = path.resolve(instanceDir, process.env.STATE_PATH || path.join("state", "state.json"));

const DEFAULTS = {
  // { [routineKey]: eventId }. A key absent means "start from now" and is
  // seeded on first poll — never drained. An agent that wakes up and posts a
  // month of history into a channel is the most common mistake with a feed.
  cursors: {},
  // { [routineKey]: item[] }. Timeline items an event routine named as
  // `carry`: not worth a turn on their own, kept until a `wake` item starts
  // one or the carry release lets them go (src/events.js). Bounded.
  carry: {},
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
  // Fingerprint of the channel problems last announced in Discord at boot, so
  // a crash loop with a bad channel id complains once, not every thirty
  // seconds. null once every channel checks out.
  channelProblems: null,
  // When the boot hello was last posted, so a crash loop says hello once an
  // hour rather than every thirty seconds.
  helloAt: null,
  // { [routineKey]: [text, ...] } — the last few posts EACH ROUTINE made,
  // newest first. This is the bot's own output, not game data, and it is the
  // routine's memory of itself: reading the channel instead gave a daily
  // spotlight the feed's and the movers' posts as "what I said recently" and
  // never its own, so it demonstrated rival scouting three days out of five.
  lastPosts: {},
  // The last few hundred turns, keyed by turn id, plus which Discord messages
  // each one produced — so a reader's 👍 / 👎 on a post can be joined back to
  // the question, the tools called and the server's request ids. Own output
  // again: nothing here is a fact about the game.
  turns: {},
  turnOrder: [],
  messageTurns: {},
};

const LAST_POSTS_KEEP = 10;
const LAST_POST_CHARS = 700;
const TURNS_KEEP = 200;

/**
 * A missing file is a fresh install. An UNREADABLE one is not: before
 * 2026-09-25 both returned the defaults, and every writer here is
 * read-modify-write of the whole file, so the next `markRun` saved the
 * defaults plus one key — the month's spend back to $0 (a budget that could
 * be spent twice), every cursor and run gone. The bad file is now moved
 * aside, never overwritten, and said out loud; what starts afresh is the
 * same seed-don't-drain state a new install gets.
 */
function read() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") log.error("state_unreadable", { path: STATE_PATH, error: error.message });
    return { ...DEFAULTS };
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (error) {
    const kept = `${STATE_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.renameSync(STATE_PATH, kept);
    } catch {
      // Another process moved it first; its copy is the one kept.
    }
    log.error("state_corrupt", {
      path: STATE_PATH,
      error: error.message,
      kept,
      hint: "starting from a fresh state (cursors and the run ledger re-seed; this month's spend is in the kept copy)",
    });
    return { ...DEFAULTS };
  }
}

/**
 * Write to a temporary file, flush it, then rename it into place. A rename
 * is atomic, so a reader — this process or `npm run try` beside the service —
 * sees the old state or the new one and never half a file, and a crash or a
 * full disk mid-write leaves the previous state where it was.
 */
function write(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, STATE_PATH);
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

/** How many carried items one routine keeps; the oldest fall off. A batch
 *  of sixty texture items is already more than one post should carry. */
export const CARRY_CAP = 60;

export function carried(routineKey) {
  return read().carry?.[routineKey] ?? [];
}

export function addCarry(routineKey, items) {
  if (!items?.length) return;
  const state = read();
  const kept = [...(state.carry?.[routineKey] ?? []), ...items].slice(-CARRY_CAP);
  write({ ...state, carry: { ...state.carry, [routineKey]: kept } });
}

export function clearCarry(routineKey) {
  const state = read();
  if (!state.carry?.[routineKey]?.length) return;
  write({ ...state, carry: { ...state.carry, [routineKey]: [] } });
}

/** Remember what a routine just posted, so its next run can avoid repeating it. */
export function rememberPost(routineKey, text) {
  const state = read();
  const previous = state.lastPosts?.[routineKey] || [];
  const kept = [String(text).slice(0, LAST_POST_CHARS), ...previous].slice(0, LAST_POSTS_KEEP);
  write({ ...state, lastPosts: { ...state.lastPosts, [routineKey]: kept } });
}

/** A routine's own recent posts, newest first. */
export function recentOwnPosts(routineKey, count) {
  if (!count) return [];
  return (read().lastPosts?.[routineKey] || []).slice(0, count);
}

/**
 * THE SILENCE CLOCK. When this bot last posted in each channel, so a turn
 * can be told how long the room has gone without hearing from it. Only
 * routine posts count — an answer in the ask thread is answering, not
 * sharing — and a channel the bot has never posted in (or not since this
 * clock existed) is anchored on the first time the directory showed it,
 * reported as "at least" that long. The clock is a fact handed to the
 * model (src/prompt.js `silenceLine`); the lean it puts on a SKIP decision
 * is the instance's VOICE setting.
 */
export function rememberPostAt(channelId, { name = null, routine = null, at = new Date() } = {}) {
  if (!channelId) return;
  const state = read();
  write({
    ...state,
    lastPostAt: { ...state.lastPostAt, [String(channelId)]: { at: at.toISOString(), name, routine, seeded: false } },
  });
}

/**
 * Seed the clock once, at boot, from the turn ledger's post timestamps —
 * channels with no stamp yet only. Without this, the first days after the
 * clock shipped would read "≥0h since the clock started" in a channel the
 * ledger knows went quiet yesterday. A timestamp and a channel id are all
 * that is read: this is the audit record's WHEN, never its content, and it
 * happens at boot, not in a member-facing turn (the two rules in ledger.js).
 */
export function seedPostTimes(turns) {
  const state = read();
  const lastPostAt = { ...state.lastPostAt };
  let changed = false;
  for (const turn of turns) {
    if (turn.lane !== "routines") continue;
    for (const p of turn.output?.posts ?? []) {
      const id = String(p.channelId ?? "");
      if (!id || !turn.at) continue;
      const have = lastPostAt[id];
      if (have?.seeded === false || (have && have.at >= turn.at)) continue;
      lastPostAt[id] = { at: turn.at, name: p.channelName ?? null, routine: turn.routine ?? null, seeded: true };
      changed = true;
    }
  }
  if (changed) write({ ...state, lastPostAt });
  return Object.values(lastPostAt).filter((v) => v.seeded).length;
}

/** Per directory channel: hours since this bot last posted there, or since it
 *  first saw the channel (`atLeast: true`). Anchors first sightings. */
export function silence(entries, now = new Date()) {
  const state = read();
  const lastPostAt = { ...state.lastPostAt };
  const firstSeen = { ...state.channelFirstSeen };
  let changed = false;
  const out = [];
  for (const entry of entries) {
    const id = String(entry.id);
    const last = lastPostAt[id];
    if (!last && !firstSeen[id]) {
      firstSeen[id] = now.toISOString();
      changed = true;
    }
    const since = last ? new Date(last.at) : new Date(firstSeen[id]);
    out.push({
      channelId: id,
      name: entry.name,
      hours: Math.max(0, (now - since) / 3600000),
      at: since,
      atLeast: !last,
      routine: last?.routine ?? null,
    });
  }
  if (changed) write({ ...state, channelFirstSeen: firstSeen });
  return out;
}

/** Record a turn and the message ids it produced, pruning the oldest. */
export function rememberTurn(turnId, record, messageIds = []) {
  if (!turnId) return;
  const state = read();
  const turns = { ...state.turns };
  const order = (state.turnOrder || []).filter((id) => id !== turnId);
  const messageTurns = { ...state.messageTurns };
  turns[turnId] = { ...record, reactions: turns[turnId]?.reactions || {} };
  order.push(turnId);
  for (const id of messageIds) if (id) messageTurns[String(id)] = turnId;
  while (order.length > TURNS_KEEP) {
    const gone = order.shift();
    delete turns[gone];
    for (const [mid, tid] of Object.entries(messageTurns)) if (tid === gone) delete messageTurns[mid];
  }
  write({ ...state, turns, turnOrder: order, messageTurns });
}

/** The turn that produced a Discord message, or null. */
export function turnForMessage(messageId) {
  const state = read();
  const turnId = state.messageTurns?.[String(messageId)];
  if (!turnId || !state.turns?.[turnId]) return null;
  return { turnId, ...state.turns[turnId] };
}

/** Claim a reaction kind for a turn. False if it was already handled. */
export function markReaction(turnId, kind, value = true) {
  const state = read();
  const turn = state.turns?.[turnId];
  if (!turn) return false;
  const reactions = { ...turn.reactions };
  if (value && reactions[kind]) return false;
  if (value) reactions[kind] = new Date().toISOString();
  else delete reactions[kind];
  write({ ...state, turns: { ...state.turns, [turnId]: { ...turn, reactions } } });
  return true;
}

export function markRun(routineKey, periodKey) {
  const state = read();
  write({ ...state, runs: { ...state.runs, [routineKey]: periodKey } });
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
