/**
 * Scheduled prompts — the other half of what a clan agent powered by Elixir MCP
 * is for. The event lane reacts to things that happened; these ask questions
 * nobody was awake to ask.
 *
 * Two rules shaped the roster:
 *
 *   1. Do not restate the feed. clan_pulse, war_day_open, joins, leaves and
 *      week-close already get written up when they fire. A scheduled digest on
 *      top of them only proves we can post twice.
 *   2. Favour what a single-clan bot structurally cannot do — the multi-clan
 *      corpus, meta decks, rival scouting, Pilot Score. Those are the posts that
 *      argue for the product rather than merely filling the channel.
 *
 * SILENCE IS A VALID OUTPUT. Every prompt that can be dull is told to answer
 * SKIP, and a SKIP posts nothing while still marking the run done. A channel
 * that manufactures content on a quiet day stops being worth reading, and the
 * first thing anyone learns to do with it is mute it.
 */

import { config } from "./config.js";
import { ask, overDailyCap } from "./claude.js";
import { FEEDBACK_PROMPT } from "./feedback.js";
import { log } from "./log.js";
import * as state from "./state.js";

const SYSTEM = `You write scheduled posts for a Clash Royale clan's Discord channel, using
nothing but the Elixir MCP server. The home clan is ${config.clanTag}.

GROUNDING
Every number you print must come from a tool call in this turn. Never guess,
never fill a gap from general Clash Royale knowledge, and never present a
recalled figure as recorded data. Recording has a start date and coverage is
uneven — when a number could mislead because of that, say so. "No recorded
battles" is not "did not play".

VOICE
Plain and factual. No persona, no lore, no hype, no sign-off. Start with the
news. At most one emoji. Short bold labels and compact lists.

NEVER use a markdown table — Discord renders them as literal pipe characters.
One short line per row instead, like "**De stichting** — 0 fame".

SILENCE
If your instructions say you may skip and there is genuinely nothing worth
posting, reply with SKIP on a line by itself and nothing else. A quiet day is
allowed to be quiet. Do not pad.

QUOTA
Prefer recorded data. live_fetch goes out to the collector fleet and draws on a
daily quota shared with every other consumer — use it only when the answer is
genuinely impossible without a live read, and never more than once per post.

${FEEDBACK_PROMPT}`;

/**
 * `schedule` is UTC. `weekday` is 0=Sunday when present, otherwise the job is
 * daily. `catchUpHours` bounds how late a missed run may still fire — a war
 * deck nudge that fires at 4am because the host was asleep is worse than one
 * that never fires.
 */
export const JOBS = [
  {
    key: "war-deck-check",
    schedule: { hour: 1, minute: 0 },
    catchUpHours: 3,
    prompt: `Check war decks for ${config.clanTag}. Call war_current and read decks_today.

If it is not a war day, or decks_today is absent, or the war-day anchor looks
stale, reply with exactly SKIP.

Otherwise post a short nudge naming who is untouched (no decks used today) and
who is partial. Facts only — no judgment, no leader framing, nothing about
kicks or consequences. This is a teammate reminder, not a report on people.
Under 900 characters.`,
  },
  {
    key: "notable-movers",
    schedule: { hour: 12, minute: 30 },
    catchUpHours: 4,
    prompt: `Look at the last 24 hours for ${config.clanTag}. Use clans_roster, then
battles_performance, players_timeline or battles_trends as needed.

Name AT MOST three players whose last 24 hours stood out — a win streak, a
notable trophy swing, unusually high volume, or a return after being quiet. One
line each, leading with the number that makes it interesting.

Facts, never judgment. If nothing genuinely stood out, reply with exactly SKIP.`,
  },
  {
    key: "capability-spotlight",
    schedule: { hour: 17, minute: 0 },
    catchUpHours: 5,
    prompt: `Pick ONE thing a clan member could ask in #ask-elixir-mcp today, ask it
yourself using the tools, and show the answer.

Rotate what you demonstrate day to day: meta decks, rival clan scouting, card
level comparisons, a head-to-head player comparison, deck archetypes, curated
collections. Prefer something a single-clan bot could not answer at all.

Format: one bold line naming the capability, the real answer you got in two to
four lines, then the exact question they could paste, in backticks. Under 1000
characters. Do not SKIP — there is always something to show.`,
  },
  {
    key: "rival-scout",
    schedule: { weekday: 1, hour: 12, minute: 0 },
    catchUpHours: 8,
    prompt: `Scout this week's war bracket for ${config.clanTag}. Use war_current and
war_rivals, plus clans_standings or clans_roster on the rivals where it helps.

For each rival we face: what is recorded about them — size, recent activity,
how they have finished before. Then where we plausibly sit, and say plainly
where the record is thin.

This is scouting, not prediction. Under 1400 characters. If the bracket is not
known yet, reply with exactly SKIP.`,
  },
  {
    key: "pilot-spotlight",
    schedule: { weekday: 5, hour: 23, minute: 0 },
    catchUpHours: 6,
    prompt: `Use clans_pilot_scores for ${config.clanTag} to find who improved most over
the past week. Pick ONE player and go deeper with battles_compare,
players_timeline or battles_levels.

Write a short spotlight: what they are doing well, specifically, with the
numbers that show it. Recognition, not ranking — do not present a leaderboard
and do not compare them unfavourably to anyone.

Under 1200 characters. If Pilot Scores are unavailable or the week has too
little recorded play, reply with exactly SKIP.`,
  },
  {
    key: "meta-report",
    schedule: { weekday: 0, hour: 15, minute: 0 },
    catchUpHours: 8,
    prompt: `Report what the corpus says about the current meta. Use battles_meta_decks and
battles_meta_cards, and collections_browse or collections_get if a curated
collection is relevant.

Two parts: what is rising and falling across the recorded corpus this week, and
how ${config.clanTag}'s play compares — what are we over-playing or
under-playing relative to it.

Be honest about sample size: a card with few recorded battles is not a trend.
Under 1400 characters.`,
  },
];

function disabledKeys() {
  return new Set(
    (process.env.SCHEDULE_DISABLED || "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

/**
 * The most recent time this job was due, at or before `now`.
 *
 * Returning the occurrence rather than a boolean is what makes the run ledger
 * work: its date string is the period key, so a restart at 12:29 and one at
 * 23:50 agree on which run they are talking about.
 */
export function lastOccurrence(job, now) {
  const { hour, minute, weekday } = job.schedule;
  const at = new Date(now);
  at.setUTCHours(hour, minute, 0, 0);

  if (weekday === undefined) {
    if (at > now) at.setUTCDate(at.getUTCDate() - 1);
    return at;
  }

  let back = (at.getUTCDay() - weekday + 7) % 7;
  if (back === 0 && at > now) back = 7;
  at.setUTCDate(at.getUTCDate() - back);
  return at;
}

const periodKey = (occurrence) => occurrence.toISOString().slice(0, 16);

/** Jobs due now: past their occurrence, inside the catch-up window, not yet run. */
export function dueJobs(now = new Date(), ledger = state.get("scheduledRuns") || {}, jobs = JOBS) {
  const disabled = disabledKeys();
  const due = [];
  for (const job of jobs) {
    if (disabled.has(job.key)) continue;
    const occurrence = lastOccurrence(job, now);
    const ageHours = (now - occurrence) / 3_600_000;
    if (ageHours > job.catchUpHours) continue;
    if (ledger[job.key] === periodKey(occurrence)) continue;
    due.push({ job, occurrence });
  }
  return due;
}

/**
 * Did the model decline to post?
 *
 * Anchoring on the start of the response was wrong: told to "reply with exactly
 * SKIP", the model sometimes explains its reasoning first and puts SKIP on its
 * own line at the end. That parses as a normal answer, and the channel gets
 * "period.kind is training, not a war day" as though it were the post. Accept
 * SKIP as any line of its own.
 */
export function isSkip(text) {
  const lines = (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 0 || lines.some((line) => /^SKIP[.!]?$/i.test(line));
}

async function runJob(channel, job, occurrence) {
  // Recorded BEFORE the call, not after. A crash mid-post must not leave the
  // job eligible to run again on the next tick and post twice.
  state.set({
    scheduledRuns: { ...(state.get("scheduledRuns") || {}), [job.key]: periodKey(occurrence) },
  });

  const result = await ask({
    system: SYSTEM,
    maxTokens: 6000,
    messages: [{ role: "user", content: job.prompt }],
  });

  if (!result.ok) {
    log.error("scheduled_failed", { job: job.key, error: result.error });
    return;
  }

  const text = (result.text || "").trim();
  if (isSkip(text)) {
    log.info("scheduled_skipped", { job: job.key, usd: result.usd.toFixed(4) });
    return;
  }

  await channel.send(text.slice(0, 1900));
  log.info("scheduled_posted", {
    job: job.key,
    turnId: result.turnId,
    tools: result.called.length,
    toolNames: result.called.join(","),
    usd: result.usd.toFixed(4),
    ms: result.ms,
  });
}

export async function tick(channel, now = new Date()) {
  const due = dueJobs(now);
  if (due.length === 0) return;
  if (overDailyCap()) {
    log.warn("scheduled_over_cap", { due: due.map((entry) => entry.job.key).join(",") });
    return;
  }
  for (const { job, occurrence } of due) {
    await runJob(channel, job, occurrence).catch((error) =>
      log.error("scheduled_crashed", { job: job.key, error: error.message }),
    );
  }
}

/**
 * First run marks every job as already done for its current window, so a fresh
 * install does not fire three backdated posts in the same minute. Same rule as
 * the event cursor and the feedback ledger: seed, never drain.
 */
function seedLedger(now = new Date()) {
  const ledger = {};
  for (const job of JOBS) ledger[job.key] = periodKey(lastOccurrence(job, now));
  state.set({ scheduledRuns: ledger });
  log.info("scheduler_seeded", { jobs: Object.keys(ledger).length });
}

export function startScheduler(channel) {
  if (state.get("scheduledRuns") === null) seedLedger();
  const disabled = disabledKeys();
  const active = JOBS.filter((job) => !disabled.has(job.key)).map((job) => job.key);
  log.info("scheduler_started", { jobs: active.join(","), disabled: [...disabled].join(",") });
  const run = () =>
    tick(channel).catch((error) => log.error("scheduler_tick_failed", { error: error.message }));
  run();
  return setInterval(run, 60_000);
}
