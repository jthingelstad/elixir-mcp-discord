/**
 * The event lane — Elixir MCP's activity feed, read on a timer, handed to
 * whichever routines find something in it worth a post.
 *
 * This is the routine recipe from Elixir MCP's own docs running as a real
 * thing instead of a worked example: read `elixir_events` from a saved cursor,
 * drill with the data tools when something moved, write the brief. It is built
 * out of the same documented tools anyone else would use, on purpose — if this
 * lane needed a private hook, the recipe would be a promise the product could
 * not keep.
 *
 * Polling is plumbing and plumbing should not cost a model call, so this file
 * talks to MCP directly (src/mcp.js). The model is only involved once there is
 * something to write about — and since contract 2.0.0 (2026-09-13) deciding
 * THAT is this file's job too, see `noteworthy`.
 *
 * CURSORS: we pass `mark_seen: false` on every poll and keep our own position
 * per routine in state.json. The seen bookmark is a single per-account
 * instant, so acknowledging would move the window for anything else polling
 * this account — and with two event routines here, each other's. The local
 * cursor also means a restart can never skip a window it failed to post.
 */

import { callTool } from "./mcp.js";
import { config } from "./config.js";
import { runRoutine } from "./run.js";
import { newFeedbackResponses } from "./feedback.js";
import { directory, resolveById } from "./directory.js";
import { log } from "./log.js";
import * as state from "./state.js";

/**
 * One read of the activity feed from `from` (an ISO instant) to now.
 *
 * Since contract 2.0.0 the feed is not rows of events but ONE ENTRY PER
 * SUBJECT summarizing the whole window — for an agent, the clan it acts for,
 * with its members inside. Sections are always present and null when nothing
 * happened; `sections` trims the wire to the ones a routine handles.
 * `has_more` is always false, so there is no paging: `next_cursor` is the
 * window's end and goes back as `from` next time.
 *
 * `meta` is the envelope; it carries the hints the loop runs on
 * (`feedback_responses_pending`, `contract_version`).
 */
export async function read(from, { sections = null, verbosity = "full" } = {}) {
  const args = { mark_seen: false, verbosity };
  if (from) args.from = from;
  if (sections?.length) args.sections = sections;
  const result = await callTool("elixir_events", args);
  if (!result.ok) return { ok: false, error: result.error };
  const body = result.body ?? {};
  return {
    ok: true,
    entries: body.entries ?? [],
    quiet: body.quiet ?? [],
    window: body.window ?? null,
    cursor: body.next_cursor ?? null,
    meta: body.meta ?? null,
  };
}

/**
 * Whether a window's entries carry anything a routine would post about.
 *
 * A clan entry arrives on EVERY read — "a clan's silence is the clan's
 * activity" — and in an active clan `activity` and `standouts.most_battles`
 * are non-empty in almost every five-minute window. A lane that ran the model
 * on each poll would post 288 times a day. So a routine names the sections it
 * cares about, and something is noteworthy when a notable was recorded or
 * any list inside those sections holds a RECORD — an object with fields: a
 * join under `roster`, a return under `presence`, a finished week under
 * `war.resolved`. Numbers alone (battles played, a boat's fame, the
 * disclosed rungs `[5, 10, 20]`) never count: they are always there.
 *
 * Shape-agnostic on purpose: lists are looked for, not named, so a section
 * the server adds a list to is noticed without a release here.
 */
export function noteworthy(entries, sections = null) {
  const hasItems = (value) => {
    if (Array.isArray(value)) return value.some((item) => item && typeof item === "object");
    if (value && typeof value === "object") return Object.values(value).some(hasItems);
    return false;
  };
  return (entries ?? []).some((entry) => {
    if (Array.isArray(entry.notables) && entry.notables.length > 0) return true;
    const keys = sections?.length ? sections : Object.keys(entry);
    return keys.some((key) => {
      if (["notables", "window", "summary"].includes(key)) return false;
      return hasItems(entry[key]);
    });
  });
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

/** Polls one routine. Returns the envelope of the last `elixir_events`
 *  response it read (or null when it read none), so the tick can act on the
 *  hints without a call of its own. */
async function pollRoutine(routine, channel) {
  const cursor = isoCursor(state.cursorFor(routine.key));
  if (cursor === null) {
    const seeded = await seedCursor();
    if (seeded === null) return null;
    state.setCursor(routine.key, seeded.cursor);
    log.info("cursor_seeded", { routine: routine.key, cursor: seeded.cursor });
    return seeded.meta;
  }

  const result = await read(cursor, { sections: routine.sections });
  if (!result.ok) {
    log.warn("events_poll_failed", { routine: routine.key, error: result.error, cursor });
    return null;
  }

  // Contract drift is worth a log line even when nothing broke: the tool
  // surface moving is exactly what this project is meant to notice early.
  const version = result.meta?.contract_version;
  if (version && version !== state.get("contractVersion")) {
    log.info("contract_version_changed", { from: state.get("contractVersion"), to: version });
    state.set({ contractVersion: version });
  }

  if (!noteworthy(result.entries, routine.sections)) {
    // A quiet window: move on without a model call.
    if (result.cursor) state.setCursor(routine.key, result.cursor);
    return result.meta;
  }

  const run = await runRoutine(routine, { channel, events: result.entries });
  // Advance only after a successful turn, so a failure re-runs the window
  // rather than dropping it. A skip counts: the routine saw it and declined.
  if (run.ok) {
    state.setCursor(routine.key, result.cursor);
    log.info("events_consumed", {
      routine: routine.key,
      entries: result.entries.length,
      window: result.window ? `${result.window.from}..${result.window.to}` : undefined,
      cursor: result.cursor,
      posted: !run.skipped,
    });
  }
  return result.meta;
}

/**
 * Whether a tick should read `elixir_my_feedback` at all.
 *
 * Since contract 1.0.0 every response — `elixir_events` included — carries
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
  if (!channel) return;
  for (const item of await newFeedbackResponses({ seedOnly })) {
    const shipped = item.shippedIn ? ` (shipped in ${item.shippedIn})` : "";
    await channel.send(
      [
        `**Elixir MCP answered feedback this agent filed**${shipped}`,
        `> ${item.message.slice(0, 400).replace(/\n/g, "\n> ")}`,
        "",
        item.response.slice(0, 1200),
      ].join("\n"),
    );
    log.info("feedback_response_posted", { id: item.id });
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
      : await resolveById(directory().find((e) => e.role !== "ask")?.id);

    // The feed polls run first: their envelopes say whether the maintainer
    // has answered anything, so the feedback read below is a decision rather
    // than a habit.
    let pending;
    for (const routine of routines) {
      const channel = routine.channel ? await resolveChannel(routine.channel) : null;
      if (routine.channel && !channel) continue;
      const meta = await pollRoutine(routine, channel).catch((error) => {
        log.error("events_routine_crashed", { routine: routine.key, error: error.message });
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
