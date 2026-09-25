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
import { newFeedbackResponses } from "./feedback.js";
import { directory, postable, resolveById } from "./directory.js";
import { log } from "./log.js";
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
  { sections = null, kinds = null, verbosity = "full", reader = null, to = null, call = callTool } = {},
) {
  // A named reader marks its own pointer; a read with no reader (the seed,
  // the dry run, a busy window's older pages) never moves anything.
  const args = reader ? { reader, mark_read: true, verbosity } : { mark_read: false, verbosity };
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
    page = await read(windowFrom, { ...options, reader: null, to, call });
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
 */
export async function eventsForDryRun(routine) {
  const cursor = state.cursorFor(routine.key);
  const seeded = typeof cursor === "string";
  const payload = (result, items) => ({ window: result.window, timeline: items, entries: result.entries });
  if (seeded) {
    const pending = await read(cursor, { sections: routine.sections });
    const items = pending.ok ? relevant(pending.timeline, routine) : [];
    if (items.length) return { events: payload(pending, items), count: items.length, note: `pending since ${cursor}` };
  }
  const day = await read(null, { sections: routine.sections });
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

/** Polls one routine. Returns the envelope of the first `elixir_timeline`
 *  response it read (or null when it read none), so the tick can act on the
 *  hints without a call of its own. `call` and `run` are the transport and
 *  the turn, for tests. */
export async function pollRoutine(routine, channel, { call = callTool, run: runTurn = runRoutine } = {}) {
  const cursor = isoCursor(state.cursorFor(routine.key));
  if (cursor === null) {
    const seeded = await seedCursor();
    if (seeded === null) return null;
    state.setCursor(routine.key, seeded.cursor);
    log.info("cursor_seeded", { routine: routine.key, cursor: seeded.cursor });
    return seeded.meta;
  }

  const result = await readWindow(
    cursor,
    { sections: routine.sections, kinds: subscribedKinds(routine), reader: readerName(routine.key) },
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
      return result.meta;
    }
  }
  const items = oldestFirst([...held, ...wake, ...carry]);

  const run = await runTurn(routine, {
    channel,
    events: { window: result.window, timeline: items, entries: result.entries },
  });
  // Advance only after a successful turn, so a failure re-runs the window
  // rather than dropping it. A skip counts: the routine saw it and declined.
  if (run.ok) {
    state.setCursor(routine.key, result.cursor);
    state.clearCarry(routine.key);
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
  }
  return result.meta;
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
 * Maintainer replies to feedback this agent filed, posted back into a channel.
 *
 * Closing this loop in public is half the point of running the channels at
 * all: a member watching their complaint get answered is the strongest
 * argument for the product there is.
 */
export async function postFeedbackResponses(channel, { seedOnly = false } = {}) {
  for (const item of await newFeedbackResponses({ seedOnly })) {
    const shipped = item.shippedIn ? ` (shipped in ${item.shippedIn})` : "";
    const text = [
      `**Elixir MCP answered feedback this agent filed**${shipped}`,
      `> ${item.message.slice(0, 400).replace(/\n/g, "\n> ")}`,
      "",
      item.response.slice(0, 1200),
    ].join("\n");
    if (channel) await channel.send(text);
    // The operator is the one who can act on an answer ("pass the segment",
    // "that ships next week"), so it is also a DM — whether or not a channel
    // is bound.
    await notify("Elixir answered", text, { fingerprint: `feedback_response:${item.id}` });
    log.info("feedback_response_posted", { id: item.id, channel: channel ? channel.id : "dm only" });
  }
}

/**
 * @param {Function} routinesFn  returns the current event routines (re-read
 *   every tick, so adding one is a file, not a restart)
 * @param {Function} resolveChannel  logical name -> Discord channel
 */
export function startEventLoop(routinesFn, resolveChannel) {
  let seeded = state.get("cursors") && Object.keys(state.get("cursors")).length > 0;

  const run = async () => {
    const routines = routinesFn();
    // Maintainer replies are posted by the runner, not the model, so they
    // need a fixed place: FEEDBACK_CHANNEL, else the first event routine
    // that binds one, else the first channel in the directory.
    const feedbackName = config.feedbackChannel || routines.find((r) => r.channel)?.channel || null;
    const feedbackChannel = feedbackName
      ? await resolveChannel(feedbackName)
      : await resolveById(postable(directory())[0]?.id);

    // The feed polls run first: their envelopes say whether the maintainer
    // has answered anything, so the feedback read below is a decision rather
    // than a habit.
    let pending;
    for (const routine of routines) {
      const channel = routine.channel ? await resolveChannel(routine.channel) : null;
      if (routine.channel && !channel) continue;
      const meta = await pollRoutine(routine, channel).catch(async (error) => {
        log.error("events_routine_crashed", { routine: routine.key, error: error.message });
        await notify("feed routine crashed", `${routine.key}: ${error.message.slice(0, 300)}`, {
          fingerprint: `events_crashed:${routine.key}`,
        });
        return null;
      });
      if (meta?.feedback_responses_pending !== undefined) {
        pending = meta.feedback_responses_pending;
      }
    }

    // First run marks the whole feedback history as already shown. An empty
    // ledger meeting a year of answered feedback is a channel full of old
    // news, which is a worse first impression than silence.
    if (shouldReadFeedback({ seeded, pending })) {
      if (seeded && pending) log.info("feedback_responses_pending", { pending });
      await postFeedbackResponses(feedbackChannel, { seedOnly: !seeded }).catch((error) =>
        log.warn("feedback_post_failed", { error: error.message }),
      );
    }
    seeded = true;
  };

  void run().catch((error) => log.error("events_tick_failed", { error: error.message }));
  return setInterval(
    () => void run().catch((error) => log.error("events_tick_failed", { error: error.message })),
    config.eventPollSeconds * 1000,
  );
}
