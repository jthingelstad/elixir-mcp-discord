/**
 * The event lane — Elixir MCP's feed, read on a timer, handed to whichever
 * routines subscribe to the topics that arrived.
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
 * something to write about.
 *
 * CURSORS: we pass `mark_seen: false` on every poll and keep our own position
 * per routine in state.json. `events_seen_through` is a single per-account
 * marker, so acknowledging would consume events belonging to anything else
 * polling this account — and with two event routines here, each other's. The
 * local cursor also means a restart can never skip an event it failed to post.
 */

import { callTool } from "./mcp.js";
import { config } from "./config.js";
import { runRoutine } from "./run.js";
import { newFeedbackResponses } from "./feedback.js";
import { log } from "./log.js";
import * as state from "./state.js";

/**
 * Reads every event after `since`, following the server's paging contract:
 * responses carry `next_cursor` and `has_more`, and the tool's own note says to
 * pass next_cursor back as `since`. Capped at PAGE_LIMIT pages so a pathological
 * feed can never spin here.
 *
 * The returned cursor takes the max of `next_cursor` and the highest event_id
 * seen. With a topics filter those can differ — next_cursor tracks matching
 * events — and taking the max only ever costs us re-scanning a few rows the
 * filter would drop anyway.
 */
const PAGE_LIMIT = 10;

export async function drain(since, topics) {
  const collected = [];
  let cursor = since;

  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const args = { since: cursor, limit: 50, mark_seen: false };
    if (topics) args.topics = topics;
    const result = await callTool("elixir_events", args);
    if (!result.ok) return { ok: false, error: result.error };

    const events = result.body?.events || [];
    collected.push(...events);

    const highest = events.reduce((max, e) => Math.max(max, e.event_id ?? 0), cursor);
    cursor = Math.max(result.body?.next_cursor ?? 0, highest);

    if (!result.body?.has_more) {
      return { ok: true, events: collected, cursor, meta: result.body?.meta };
    }
  }
  return { ok: true, events: collected, cursor, truncated: true };
}

/** Where the feed is right now. First run starts here rather than replaying the
 *  backlog: an agent that wakes up and posts a month of history into a channel
 *  is a worse first impression than posting nothing. Seed, never drain. */
async function newestEventId() {
  const result = await drain(0, null);
  return result.ok ? result.cursor : null;
}

async function pollRoutine(routine, channel) {
  const cursor = state.cursorFor(routine.key);
  if (cursor === null) {
    const newest = await newestEventId();
    if (newest === null) return;
    state.setCursor(routine.key, newest);
    log.info("cursor_seeded", { routine: routine.key, cursor: newest });
    return;
  }

  const result = await drain(cursor, routine.topics);
  if (!result.ok) {
    log.warn("events_poll_failed", { routine: routine.key, error: result.error, cursor });
    return;
  }

  // Contract drift is worth a log line even when nothing broke: the tool
  // surface moving is exactly what this project is meant to notice early.
  const version = result.meta?.contract_version;
  if (version && version !== state.get("contractVersion")) {
    log.info("contract_version_changed", { from: state.get("contractVersion"), to: version });
    state.set({ contractVersion: version });
  }

  if (result.events.length === 0) {
    // Nothing to say, but the cursor may still have moved past filtered rows.
    if (result.cursor > cursor) state.setCursor(routine.key, result.cursor);
    return;
  }

  const run = await runRoutine(routine, { channel, events: result.events });
  // Advance only after a successful turn, so a failure re-runs the batch
  // rather than dropping it. A skip counts: the routine saw them and declined.
  if (run.ok) {
    state.setCursor(routine.key, result.cursor);
    log.info("events_consumed", {
      routine: routine.key,
      events: result.events.length,
      cursor: result.cursor,
      posted: !run.skipped,
    });
  }
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
    const feedbackName = config.feedbackChannel || routines[0]?.channel || null;
    const feedbackChannel = feedbackName ? await resolveChannel(feedbackName) : null;

    // First run marks the whole feedback history as already shown. An empty
    // ledger meeting a year of answered feedback is a channel full of old
    // news, which is a worse first impression than silence.
    await postFeedbackResponses(feedbackChannel, { seedOnly: !seeded }).catch((error) =>
      log.warn("feedback_post_failed", { error: error.message }),
    );

    for (const routine of routines) {
      const channel = await resolveChannel(routine.channel);
      if (!channel) continue;
      await pollRoutine(routine, channel).catch((error) =>
        log.error("events_routine_crashed", { routine: routine.key, error: error.message }),
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
