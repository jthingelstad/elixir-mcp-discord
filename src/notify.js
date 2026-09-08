/**
 * The notifications lane — the routine recipe from Elixir MCP's CLAN-PULSE
 * design, running as a real thing instead of a doc:
 *
 *   1. read elixir_events from a saved cursor
 *   2. drill with war_current / clans_roster / clans_standings when something moved
 *   3. write the brief
 *
 * It is built out of the same documented tools anyone else would use, on
 * purpose. If this lane needed a private hook, the recipe in the docs would be
 * a promise the product could not keep.
 *
 * CURSOR: we pass `mark_seen: false` on every poll and keep our own position in
 * state.json. `events_seen_through` is a single per-account marker, so
 * acknowledging here would silently consume events belonging to any other
 * routine on the same account. Our own cursor costs one integer and takes that
 * whole class of problem off the table.
 */

import { config } from "./config.js";
import { callTool } from "./mcp.js";
import { ask, overDailyCap } from "./claude.js";
import { newFeedbackResponses, FEEDBACK_PROMPT } from "./feedback.js";
import { log } from "./log.js";
import * as state from "./state.js";

const TOPICS = [
  "clan_pulse",
  "war_day_open",
  "member_joined",
  "member_left",
  "member_role_changed",
  "clan_war_week_finished",
];

const SYSTEM = `You write the clan notification feed for a Clash Royale Discord, using
nothing but the Elixir MCP server.

You are handed one or more events from the Elixir MCP event feed. Your job is to
turn them into a single short Discord post that a clan member would actually
want to read. The home clan is ${config.clanTag}.

HOW TO WORK
- The events carry facts, not judgments. Read them, then use the Elixir MCP
  tools to fill in whatever context makes the facts mean something: war_current
  for the current war day and who still has decks, clans_roster for who someone
  is, clans_standings or battles_trends when activity moved.
- Drill only where it earns its place. A single join does not need three tool
  calls.
- Never invent a number. If the feed says a thing and you cannot corroborate it,
  report the feed's version and say that is what was recorded.

VOICE
Plain and factual. No persona, no lore, no hype. Short bold labels, compact
lists, no tables, no raw JSON. At most one emoji. Under 1400 characters — this
is a feed, not an essay. If the events are genuinely dull, one line is the
correct length.

Do not open with a greeting or close with a sign-off. Start with the news.

${FEEDBACK_PROMPT}`;

/** First run: learn where the feed is now and start from there. Draining the
 *  whole backlog into Discord on boot would be a worse first impression than
 *  posting nothing. */
async function seedCursor() {
  const result = await callTool("elixir_events", { limit: 1, mark_seen: false });
  if (!result.ok) return null;
  const events = result.body?.events || [];
  const latest = events.at(-1)?.event_id ?? 0;
  state.set({ eventCursor: latest });
  log.info("cursor_seeded", { cursor: latest });
  return latest;
}

async function postFeedbackResponses(channel) {
  for (const item of await newFeedbackResponses()) {
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

export async function pollOnce(channel) {
  let cursor = state.get("eventCursor");
  if (cursor === null || cursor === undefined) {
    cursor = await seedCursor();
    if (cursor === null) return;
    await postFeedbackResponses(channel).catch(() => {});
    return;
  }

  const result = await callTool("elixir_events", {
    since: cursor,
    topics: TOPICS,
    limit: 50,
    mark_seen: false,
  });

  if (!result.ok) {
    log.warn("events_poll_failed", { error: result.error, cursor });
    return;
  }

  // Contract drift is worth a log line even when nothing broke: the tool
  // surface moving is exactly what this project is meant to notice early.
  const version = result.body?.meta?.contract_version;
  if (version && version !== state.get("serverVersion")) {
    log.info("contract_version_changed", { from: state.get("serverVersion"), to: version });
    state.set({ serverVersion: version });
  }

  const events = result.body?.events || [];
  await postFeedbackResponses(channel).catch((error) =>
    log.warn("feedback_post_failed", { error: error.message }),
  );

  if (events.length === 0) return;

  const newest = events.at(-1)?.event_id;
  if (newest === undefined) return;

  if (overDailyCap()) {
    log.warn("notify_over_cap", { pending: events.length });
    return;
  }

  const composed = await ask({
    system: SYSTEM,
    maxTokens: 6000,
    messages: [
      {
        role: "user",
        content: `New events from the Elixir MCP feed:\n\n${JSON.stringify(events, null, 2)}`,
      },
    ],
  });

  if (!composed.ok) {
    log.error("notify_compose_failed", { error: composed.error });
    return;
  }

  const text = (composed.text || "").trim();
  if (text) {
    await channel.send(text.slice(0, 1900));
  }

  // Advance only after a successful post, so a Discord failure re-runs the
  // batch rather than dropping it.
  state.set({ eventCursor: newest });
  log.info("notify_posted", {
    events: events.length,
    cursor: newest,
    tools: composed.called.length,
    usd: composed.usd.toFixed(4),
  });
}

export function startPolling(channel) {
  const run = () =>
    pollOnce(channel).catch((error) =>
      log.error("notify_poll_crashed", { error: error.message, stack: error.stack?.slice(0, 400) }),
    );
  run();
  return setInterval(run, config.notifyPollSeconds * 1000);
}
