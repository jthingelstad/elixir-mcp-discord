/**
 * The event lane — Elixir MCP's timeline, read on a timer, handed to
 * whichever routines find something in it worth a post.
 *
 * This is the routine recipe from Elixir MCP's own docs running as a real
 * thing instead of a worked example: read `elixir_timeline` from a saved cursor,
 * drill with the data tools when something moved, write the brief. It is built
 * out of the same documented tools anyone else would use, on purpose — if this
 * lane needed a private hook, the recipe would be a promise the product could
 * not keep.
 *
 * Polling is plumbing and plumbing should not cost a model call, so this file
 * talks to MCP directly (src/mcp.js). The model is only involved once there is
 * something to write about — and since contract 2.0.0 (2026-09-13) deciding
 * THAT is this file's job too, see `relevant`.
 *
 * CURSORS: the local cursor per routine in state.json is still what `from`
 * comes from — a restart can never skip a window it failed to post. Since
 * hub contract 3.18.0 each routine ALSO names itself as a `reader` on the
 * poll (`<instance>-<routine>`) and marks: the hub keeps one pointer per
 * reader, so two routines and three instances on one account no longer
 * move each other's window, and `meta.timeline_pending` on every response
 * counts against this reader's own mark instead of a pointer nothing ever
 * moved. The reader's pointer can run a window ahead of the local cursor
 * after a failed turn; the local cursor is the one that decides `from`.
 */

import path from "node:path";
import { callTool } from "./mcp.js";
import { config, instanceDir } from "./config.js";
import { runRoutine } from "./run.js";
import { markFeedbackShown, newFeedbackResponses } from "./feedback.js";
import { directory, postable } from "./directory.js";
import { log } from "./log.js";
import { instanceName } from "./ledger.js";
import { notify } from "./notify.js";
import * as state from "./state.js";

/**
 * One read of the timeline from `from` (an ISO instant) to now, or to `to`.
 *
 * Since contract 3.0.0 (2026-09-13, the same evening as 2.0.0) the tool is
 * `elixir_timeline` and the feed is a TIMELINE: `timeline[]` is what happened,
 * one typed item each — `{ at, observed_at, subject_tag, subject_name, kind,
 * section, text, facts }` — and `entries[]` is the window's context, one per
 * subject with sections null when nothing happened. For an agent, the entry
 * is the clan it acts for, members inside it. `next_cursor` is the window's
 * end and goes back as `from` next time.
 *
 * Since contract 7.0.0 (2026-09-23) the timeline is a newsfeed: NEWEST
 * first, and a window past the hub's size cap serves only its newest items,
 * counts the older ones in `timeline_more` and sets `has_more` — see
 * `readWindow`, which reads them back. Everything handed to a model is
 * re-sorted oldest first (`oldestFirst`).
 *
 * `meta` is the envelope; it carries the hints the loop runs on
 * (`feedback_responses_pending`, `contract_version`).
 */
export const TIMELINE_TOOL = "elixir_timeline";

/** How many older pages one poll may read back from a busy window before it
 *  stops and says how many items it left unread. Each page is up to the hub's
 *  ~40,000-character budget, and every item read goes into one turn. */
export const MAX_CATCHUP_PAGES = 4;

/** This consumer's reader name on the hub: the instance directory's name
 *  and the routine's key, lowercased to the hub's alphabet, at most 32. */
export function readerName(routineKey) {
  const inst = path
    .basename(instanceDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  const key = String(routineKey ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  return `${inst}-${key}`.replace(/^-+|-+$/g, "").slice(0, 32) || "discord";
}

export async function read(
  from,
  {
    sections = null,
    kinds = null,
    verbosity = "full",
    reader = null,
    to = null,
    skipEmpty = false,
    call = callTool,
  } = {},
) {
  // A named reader marks its own pointer; a read with no reader (the seed,
  // the dry run, a busy window's older pages) never moves anything.
  const args = reader ? { reader, mark_read: true, verbosity } : { mark_read: false, verbosity };
  // Since contract 11.7.0 a window with nothing these kinds could keep is
  // answered without building the entries (`entries_skipped`): the poll
  // that finds nothing costs the hub a few milliseconds instead of a full
  // read. A window with any item reads exactly as without it.
  if (skipEmpty) args.skip_empty = true;
  if (from) args.from = from;
  if (to) args.to = to;
  if (sections?.length) args.sections = sections;
  // Since contract 3.9.0 the server keeps only the item kinds named, so a
  // routine that wakes on a dozen kinds and carries four reads only those.
  if (kinds?.length) args.kinds = kinds;
  const result = await call(TIMELINE_TOOL, args);
  if (!result.ok) return { ok: false, error: result.error };
  const body = result.body ?? {};
  return {
    ok: true,
    timeline: body.timeline ?? [],
    entries: body.entries ?? [],
    quiet: body.quiet ?? [],
    window: body.window ?? null,
    cursor: body.next_cursor ?? null,
    hasMore: body.has_more === true,
    entriesSkipped: body.entries_skipped === true,
    more: Number(body.timeline_more) || 0,
    meta: body.meta ?? null,
  };
}

/** Items in the order a turn reads them: oldest `at` first. */
export function oldestFirst(items) {
  return [...(items ?? [])].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
}

/**
 * Where the older remainder of a busy page ends: one millisecond before the
 * oldest OBSERVED instant the page served. The hub cuts a busy window on
 * observed_at and serves everything observed after the newest item it left
 * out, so every item not served was observed before the oldest one served —
 * and a window selects (from, to] at the millisecond. The hub states its cut
 * only in a note's prose (written for a model, rewritten often), so the
 * boundary is read off the items rather than the sentence. Null when the
 * page gives nothing to go on.
 */
function olderThan(timeline) {
  const instants = (timeline ?? []).map((it) => Date.parse(it.observed_at ?? it.at)).filter(Number.isFinite);
  return instants.length ? new Date(Math.min(...instants) - 1).toISOString() : null;
}

/**
 * THE WHOLE WINDOW. `read`, then — when the hub says the window was busier
 * than a page (`has_more`) — the older items it counted instead of serving,
 * read back by window as the hub's note says: the same `from`, `to` at the
 * cut, `mark_read: false` and no reader, so the continuation moves nothing.
 * At most `maxPages` more pages; `unread` is what the last page still
 * counted and did not serve (0 when the window was read to its start).
 *
 * Before this (contract 7.0.0 to 2026-09-25) the lane read one page and moved
 * its cursor to the window's end, so in a busy window every item older than
 * the newest page was never posted — a join after an hour of badges was
 * simply gone.
 *
 * The first read's window, entries, cursor and meta are the window's; the
 * items are every page's, oldest first. A failed continuation fails the
 * read, so the caller keeps its cursor and the next poll reads it again.
 */
export async function readWindow(from, options = {}, { call = callTool, maxPages = MAX_CATCHUP_PAGES } = {}) {
  const first = await read(from, { ...options, call });
  if (!first.ok) return first;
  const items = [...first.timeline];
  const windowFrom = first.window?.from ?? from;
  const floorMs = Date.parse(windowFrom);
  let page = first;
  let pages = 1;
  let to = null;
  while (page.hasMore && pages <= maxPages) {
    const next = olderThan(page.timeline);
    // A boundary that does not move back, or reaches the window's start,
    // cannot serve anything new: stop rather than loop.
    if (next === null || (to !== null && next >= to) || !(Date.parse(next) > floorMs)) break;
    to = next;
    page = await read(windowFrom, { ...options, reader: null, to, skipEmpty: false, call });
    if (!page.ok) return page;
    pages += 1;
    items.push(...page.timeline);
  }
  return { ...first, timeline: oldestFirst(items), pages, unread: page.more };
}

/**
 * The timeline items a routine cares about: all of them, or those whose
 * `kind` is in the routine's `kinds:` and whose `section` is in its
 * `sections:` (either list, or both). A window is worth a model call exactly
 * when this is non-empty — a clan entry arrives on EVERY read and an active
 * clan's members play in almost every five-minute window, so a routine that
 * names no kinds fires on every item. The shipped editor names what wakes
 * it and what it carries (`partition`, below).
 */
/**
 * Timeline items for a dry run of an event routine.
 *
 * Its real cursor is never advanced here — a rehearsal must not consume the
 * feed. When the window since the cursor holds nothing the routine cares
 * about (or there is no cursor yet) it reads the last 24 hours instead,
 * because "nothing happened, nothing to show" is a useless answer to
 * somebody trying to improve the wording of the brief.
 *
 * The items reach the model as the live lane hands them: the routine's
 * kinds asked of the server, the pending window read to its start, oldest
 * first. The hub serves newest first (contract 7.0.0), and a rehearsal that
 * showed the model the other order was rehearsing a different prompt.
 */
export async function eventsForDryRun(routine, { call = callTool } = {}) {
  const cursor = state.cursorFor(routine.key);
  const seeded = typeof cursor === "string";
  const payload = (result, items) => ({ window: result.window, timeline: oldestFirst(items), entries: result.entries });
  const filters = { sections: routine.sections, kinds: subscribedKinds(routine) };
  if (seeded) {
    const pending = await readWindow(cursor, filters, { call });
    const items = pending.ok ? relevant(pending.timeline, routine) : [];
    if (items.length) return { events: payload(pending, items), count: items.length, note: `pending since ${cursor}` };
  }
  const day = await read(null, { ...filters, call });
  if (!day.ok) return { events: null, count: 0, note: `feed unreadable: ${day.error}` };
  const items = relevant(day.timeline, routine);
  const why = seeded ? "nothing new since the cursor" : "no cursor yet (seeds on the first live poll)";
  return {
    events: payload(day, items),
    count: items.length,
    note: items.length
      ? `${why} — showing the last 24 hours`
      : `${why}, and nothing this routine cares about in the last 24 hours either — the live lane would not have fired`,
  };
}

export function relevant(timeline, { kinds = null, wake = null, carry = null, sections = null } = {}) {
  const named = wake ? [...wake, ...(carry ?? [])] : kinds;
  return (timeline ?? []).filter((item) => {
    if (named?.length && !named.includes(item.kind)) return false;
    if (sections?.length && item.section && !sections.includes(item.section)) return false;
    return true;
  });
}

export function noteworthy(timeline, filters = {}) {
  return relevant(timeline, filters).length > 0;
}

/** The kinds a routine reads at all — its filter for the server. */
export function subscribedKinds(routine) {
  if (routine.wake) return [...routine.wake, ...(routine.carry ?? [])];
  return routine.kinds ?? null;
}

/**
 * THE BATCH. An event routine that names `wake` and `carry` kinds is an
 * editor: a wake item starts a turn now and everything carried since the
 * last turn rides in the same batch; a carry item alone waits. What a
 * routine names with `kinds` still wakes it every time, as before.
 *
 * Why: on a 47-member clan the timeline carried 26 items in one day — 14
 * badge level-ups, 5 collection steps, 2 card unlocks, 3 quiet crossings,
 * 2 ranked promotions. Under `kinds` that is up to 26 turns at the ~$0.08
 * floor a cold turn costs before a word; under wake/carry it is two, and
 * the promotions carry the texture with them
 * (docs/PROACTIVE-2026-09-16.md).
 */
export function partition(timeline, routine) {
  const items = relevant(timeline, routine);
  if (!routine.wake) return { wake: items, carry: [] };
  return {
    wake: items.filter((i) => routine.wake.includes(i.kind)),
    carry: items.filter((i) => !routine.wake.includes(i.kind)),
  };
}

/**
 * THE CARRY RELEASE. Carried items never start a turn on their own — unless
 * the channels the routine may post in have gone quiet past the instance's
 * VOICE line: quiet never, normal 12 h, chatty 4 h. This is what VOICE
 * means since 2026-09-17: a coalescing interval, not a lean on the model's
 * skip decision. The record decides WHEN; VOICE only decides how long
 * texture may wait before it is allowed to be the reason.
 */
export const CARRY_RELEASE_HOURS = { quiet: null, normal: 12, chatty: 4 };

export function releaseDue(silences, { voice = config.voice } = {}) {
  const line = voice in CARRY_RELEASE_HOURS ? CARRY_RELEASE_HOURS[voice] : CARRY_RELEASE_HOURS.normal;
  if (line === null || !silences?.length) return false;
  // Channels the bot has actually posted in set the pace; a channel it has
  // never posted in counts only when there is no other.
  const stamped = silences.filter((s) => !s.atLeast);
  const pool = stamped.length ? stamped : silences;
  return Math.min(...pool.map((s) => s.hours)) >= line;
}

/** An ISO instant, or null: cursors from before 2.0.0 were integer event
 *  ids, and one of those means "never seeded" now. */
function isoCursor(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** Where the feed is right now. First run starts here rather than replaying
 *  the last day: an agent that wakes up and posts history into a channel is
 *  a worse first impression than posting nothing. Seed, never drain. */
async function seedCursor() {
  const now = new Date().toISOString();
  const result = await read(now, { verbosity: "compact" });
  return result.ok ? { cursor: result.cursor ?? now, meta: result.meta } : null;
}

/** The longest an event routine waits between failed turns. */
export const FAILURE_HOLD_CAP_MS = 60 * 60 * 1000;

/**
 * How long an event routine holds its unconsumed window after its `n`th
 * failed turn in a row. A failed turn keeps the cursor by design, so the
 * next poll hands the model the same batch — right for one blip, and a loop
 * when the failure is not a blip: from 2026-09-27 22:45Z to 09-28 10:03Z the
 * POAP KINGS editor woke every five minutes on the same seven items and died
 * on the same provider 400 each time (issue #22). The first failure retries
 * at the next poll; each one after doubles the wait from the poll interval
 * to the cap. An error the next poll cannot fix (`hard`, src/claude.js) goes
 * to the cap at once. A named reset time (`retryAt`) wins over both.
 */
export function failureHoldMs(n, { hard = false, pollMs = config.eventPollSeconds * 1000 } = {}) {
  if (hard) return FAILURE_HOLD_CAP_MS;
  if (n <= 1) return 0;
  return Math.min(FAILURE_HOLD_CAP_MS, pollMs * 2 ** (n - 1));
}

/**
 * The entries a turn reads the clan from. A poll with `skip_empty` that
 * found nothing (contract 11.7.0, `entries_skipped`) came back without
 * them; a turn still runs from such a window when held items go out on the
 * VOICE line's silence. Then the same window is read again for its
 * entries, by no reader, so nothing moves. Every other read already has
 * them and costs no call.
 */
export async function windowEntries(result, cursor, routine, { call = callTool } = {}) {
  if (!result.entriesSkipped) return { ok: true, entries: result.entries };
  const context = await read(cursor, {
    sections: routine.sections,
    kinds: subscribedKinds(routine),
    to: result.window?.to ?? null,
    call,
  });
  return context.ok ? { ok: true, entries: context.entries } : context;
}

/** Polls one routine. Returns `{ meta, items }`: the envelope of the first
 *  `elixir_timeline` response it read, so the tick can act on the hints
 *  without a call of its own, and how many timeline items that read held,
 *  so the loop knows whether the clan is active. Null when it read nothing
 *  (held, or the read failed). `call` and `run` are the transport and the
 *  turn, for tests. */
export async function pollRoutine(
  routine,
  channel,
  { call = callTool, run: runTurn = runRoutine, now = () => new Date(), pollMs = config.eventPollSeconds * 1000 } = {},
) {
  const retryAt = state.retryAtFor(routine.key);
  if (retryAt && Date.parse(retryAt) > now().getTime()) {
    log.info("events_held", { routine: routine.key, retryAt });
    return null;
  }
  if (retryAt) state.clearRetryAt(routine.key);

  const cursor = isoCursor(state.cursorFor(routine.key));
  if (cursor === null) {
    const seeded = await seedCursor();
    if (seeded === null) return null;
    state.setCursor(routine.key, seeded.cursor);
    log.info("cursor_seeded", { routine: routine.key, cursor: seeded.cursor });
    return { meta: seeded.meta, items: 0 };
  }

  const result = await readWindow(
    cursor,
    { sections: routine.sections, kinds: subscribedKinds(routine), reader: readerName(routine.key), skipEmpty: true },
    { call },
  );
  if (!result.ok) {
    log.warn("events_poll_failed", { routine: routine.key, error: result.error, cursor });
    return null;
  }
  if (result.pages > 1) {
    log.info("events_busy_window", { routine: routine.key, pages: result.pages, items: result.timeline.length });
  }
  if (result.unread > 0) {
    // Past MAX_CATCHUP_PAGES, or more items at one observed instant than a
    // page holds: the hub counted them and nothing here can serve them.
    log.warn("events_unread", { routine: routine.key, unread: result.unread, pages: result.pages, cursor });
  }
  const { wake, carry } = partition(result.timeline, routine);

  // Contract drift is worth a log line even when nothing broke: the tool
  // surface moving is exactly what this project is meant to notice early.
  const version = result.meta?.contract_version;
  if (version && version !== state.get("contractVersion")) {
    log.info("contract_version_changed", { from: state.get("contractVersion"), to: version });
    if (state.get("contractVersion")) {
      await notify(
        "Elixir changed",
        `contract ${state.get("contractVersion")} → ${version} while running. Tool schemas may have moved; the elixir_changelog tool says what.`,
        { fingerprint: `contract:${version}` },
      );
    }
    state.set({ contractVersion: version });
  }

  const held = state.carried(routine.key);
  let release = false;
  if (wake.length === 0) {
    // Nothing that starts a turn. Carry what was named to carry, and let
    // the batch go only if the room has been quiet past the VOICE line.
    if (carry.length) {
      state.addCarry(routine.key, carry);
      log.info("events_carried", { routine: routine.key, items: carry.length, held: held.length + carry.length });
    }
    release = held.length + carry.length > 0 && releaseDue(silenceFor(routine));
    if (!release) {
      if (result.cursor) state.setCursor(routine.key, result.cursor);
      return { meta: result.meta, items: result.timeline.length };
    }
  }
  const items = oldestFirst([...held, ...wake, ...carry]);

  const context = await windowEntries(result, cursor, routine, { call });
  if (!context.ok) {
    log.warn("events_poll_failed", { routine: routine.key, error: context.error, cursor, stage: "release_entries" });
    return null;
  }
  const entries = context.entries;

  const run = await runTurn(routine, {
    channel,
    events: { window: result.window, timeline: items, entries },
  });
  // Advance only after a successful turn, so a failure re-runs the window
  // rather than dropping it. A skip counts: the routine saw it and declined.
  if (run.ok) {
    // The same guard as the no-turn path above: a read with no cursor keeps
    // the one we have rather than writing null over it.
    if (result.cursor) state.setCursor(routine.key, result.cursor);
    state.clearCarry(routine.key);
    state.clearFailures(routine.key);
    log.info("events_consumed", {
      routine: routine.key,
      items: items.length,
      carried: held.length + (wake.length ? carry.length : 0),
      release,
      kinds: [...new Set(items.map((i) => i.kind))].join(","),
      window: result.window ? `${result.window.from}..${result.window.to}` : undefined,
      pages: result.pages > 1 ? result.pages : undefined,
      cursor: result.cursor,
      posted: !run.skipped,
    });
  } else {
    const failures = state.noteFailure(routine.key);
    const named = run.retryAt && Date.parse(run.retryAt) > now().getTime() ? run.retryAt : null;
    const holdMs = failureHoldMs(failures, { hard: run.hard, pollMs });
    const until = named ?? (holdMs > 0 ? new Date(now().getTime() + holdMs).toISOString() : null);
    if (until) {
      state.setRetryAt(routine.key, until);
      log.warn("events_backing_off", {
        routine: routine.key,
        failures,
        hard: run.hard || undefined,
        retryAt: until,
        reason: named ? "named_reset" : run.hard ? "hard_error" : "repeated_failure",
      });
    }
  }
  return { meta: result.meta, items: result.timeline.length };
}

/** The silence clock over the channels this routine could post in. */
function silenceFor(routine) {
  if (!routine.wake) return [];
  return state.silence(postable(directory()));
}

/**
 * Whether a tick should read `elixir_my_feedback` at all.
 *
 * Since contract 1.0.0 every response — now `elixir_timeline` included — carries
 * `meta.feedback_responses_pending`, so the feed poll the loop already makes
 * says whether there is anything to read. Before that hint reached the feed,
 * this bot re-read its whole feedback ledger every tick to find out: 761 calls
 * and about 4 MB a week to discover, almost always, nothing (review
 * 2026-09-10 §4.1), on a call that is metered like any other.
 *
 *   - the seeding run always reads: it marks history as already shown (seed,
 *     never drain), and that has to happen before any hint is trusted;
 *   - a hint of 0 skips the read;
 *   - a hint above 0 reads;
 *   - no hint at all — no event routine polled this tick, or a server older
 *     than 1.0.0 that does not stamp the feed's envelope — falls back to
 *     reading. A missing signal degrades to the old cost, never to silence.
 */
export function shouldReadFeedback({ seeded, pending }) {
  if (!seeded) return true;
  if (pending === undefined || pending === null) return true;
  return Number(pending) > 0;
}

/**
 * Elixir's replies to feedback this agent filed go to the operator's DM, and
 * only there (Jamie, 2026-10-07).
 *
 * They used to be posted into a member channel too, on the theory that a
 * member watching a complaint get answered sells the product. In practice
 * the agent files almost everything itself, and on 2026-10-06 two
 * thank-yous for 👍 praise landed in POAP KINGS' updates channel between
 * member news, quoting the editor's brief. The operator is the one who can
 * act on an answer ("pass the segment", "that ships next week"), and
 * `feedback` in the DM lists them all.
 */
export async function deliverFeedbackResponses({ seedOnly = false } = {}) {
  for (const item of await newFeedbackResponses({ seedOnly })) {
    const shipped = item.shippedIn ? ` (shipped in ${item.shippedIn})` : "";
    const text = [
      `**Elixir MCP answered feedback this agent filed**${shipped}`,
      `> ${item.message.slice(0, 400).replace(/\n/g, "\n> ")}`,
      "",
      item.response.slice(0, 1200),
    ].join("\n");
    await notify("Elixir answered", text, { fingerprint: `feedback_response:${item.id}` });
    markFeedbackShown(item.id);
    log.info("feedback_response_delivered", { id: item.id });
  }
}

/**
 * THE POLL'S PACE (Jamie, 2026-10-10). Every poll is a metered call that
 * builds the clan's whole entry, and on 2026-10-09 the three bots made 864
 * of them in a day, 89% of the hub's MCP traffic, nearly all empty: two of
 * the clans woke a turn once a day. So the pace follows the clan:
 *
 *   - while items are arriving, and for ACTIVE_POLLS polls after the last
 *     one, the timeline is read every EVENT_POLL_SECONDS — a join still
 *     posts within minutes of a busy stretch;
 *   - after that each empty poll doubles the wait, up to
 *     EVENT_POLL_MAX_SECONDS (an hour);
 *   - the first poll that reads any item puts it straight back to the base.
 *
 * A read that failed or was held says nothing about the clan and keeps the
 * pace it had. The worst case is a join in a long-quiet clan waiting up to
 * the cap, which Jamie chose over polling an empty feed every five minutes.
 */
export const ACTIVE_POLLS = 6;

export function nextPollMs({ baseMs, maxMs, sinceActivityMs, lastMs }) {
  const ceiling = Math.max(baseMs, maxMs);
  if (sinceActivityMs < ACTIVE_POLLS * baseMs) return baseMs;
  return Math.min(ceiling, Math.max(baseMs, lastMs) * 2);
}

/** Where in the first interval this instance starts. Three bots rebuilt
 *  together used to poll in the same second for as long as they ran; an
 *  offset from the instance's name spreads them, and the same name always
 *  lands in the same place. */
export function staggerMs(name, baseMs) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % Math.max(1, Math.floor(baseMs));
}

/** ±10%, so instances that started together drift apart rather than back
 *  into step. */
export function jittered(ms, random = Math.random) {
  return Math.round(ms * (0.9 + 0.2 * random()));
}

/**
 * @param {Function} routinesFn  returns the current event routines (re-read
 *   every tick, so adding one is a file, not a restart)
 * @param {Function} resolveChannel  logical name -> Discord channel
 * @returns {{ stop: Function }}
 */
export function startEventLoop(routinesFn, resolveChannel, { now = () => Date.now(), random = Math.random } = {}) {
  let seeded = state.get("cursors") && Object.keys(state.get("cursors")).length > 0;

  const run = async () => {
    const routines = routinesFn();

    // The feed polls run first: their envelopes say whether the maintainer
    // has answered anything, so the feedback read below is a decision rather
    // than a habit.
    let pending;
    let read = false;
    let items = 0;
    for (const routine of routines) {
      const channel = routine.channel ? await resolveChannel(routine.channel) : null;
      if (routine.channel && !channel) continue;
      const polled = await pollRoutine(routine, channel).catch(async (error) => {
        log.error("events_routine_crashed", { routine: routine.key, error: error.message });
        await notify("feed routine crashed", `${routine.key}: ${error.message.slice(0, 300)}`, {
          fingerprint: `events_crashed:${routine.key}`,
        });
        return null;
      });
      if (!polled) continue;
      read = true;
      items += polled.items;
      if (polled.meta?.feedback_responses_pending !== undefined) {
        pending = polled.meta.feedback_responses_pending;
      }
    }

    // First run marks the whole feedback history as already shown. An empty
    // ledger meeting a year of answered feedback is a DM full of old news.
    if (shouldReadFeedback({ seeded, pending })) {
      if (seeded && pending) log.info("feedback_responses_pending", { pending });
      await deliverFeedbackResponses({ seedOnly: !seeded }).catch((error) =>
        log.warn("feedback_post_failed", { error: error.message }),
      );
    }
    seeded = true;
    return { read, items };
  };

  // One poll at a time, by construction: the next is scheduled only when this
  // one has finished. A turn can outlast the interval (a busy window, a slow
  // model), and the cursor moves only after it succeeds — so an overlapping
  // poll read the same window from the same cursor and posted it twice.
  const baseMs = config.eventPollSeconds * 1000;
  const maxMs = config.eventPollMaxSeconds * 1000;
  let lastActivity = now();
  let paceMs = baseMs;
  let timer = null;
  let stopped = false;

  const tick = async () => {
    let outcome = null;
    try {
      outcome = await run();
    } catch (error) {
      log.error("events_tick_failed", { error: error.message });
    }
    if (outcome?.items > 0) lastActivity = now();
    if (outcome?.read) {
      const next = nextPollMs({ baseMs, maxMs, sinceActivityMs: now() - lastActivity, lastMs: paceMs });
      if (next !== paceMs) {
        log.info("events_pace", {
          seconds: Math.round(next / 1000),
          quietMinutes: Math.round((now() - lastActivity) / 60000),
        });
      }
      paceMs = next;
    }
    schedule(jittered(paceMs, random));
  };
  const schedule = (ms) => {
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };

  // The instance's name, not its directory's: in Docker every instance is
  // mounted at /instance, and the first stagger (2026-10-10) put all three
  // bots in the same second.
  schedule(staggerMs(instanceName(), baseMs));
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
