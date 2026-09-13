/**
 * Running one routine, whatever woke it up.
 *
 * A scheduled post, an event brief and a `!run` from an admin are the same
 * three steps — assemble a prompt, spend one turn on it, put the result in a
 * channel — and they used to be three implementations of those steps that
 * drifted apart. The event lane never posted a trace, the scheduled lane never
 * filed friction, and only the ask lane clipped to Discord's limit correctly.
 *
 * The message lane stays separate (src/ask.js) because it is genuinely
 * different: it streams into a live message and carries conversation history.
 * Everything else comes through here.
 */

import { ask, spendBlock, cacheShare } from "./claude.js";
import { laneFor } from "./budget.js";
import { detectFriction, sweepFriction, looksUngrounded } from "./feedback.js";
import { systemFor, userMessageFor, isSkip } from "./prompt.js";
import { post, recentPosts } from "./post.js";
import { renderTrace, errorFooter, UNGROUNDED_FOOTER } from "./trace.js";
import { log } from "./log.js";
import * as state from "./state.js";

/** Reply under the last message of a post without pinging anyone; a failure
 *  to attach a footer must never undo the post. */
async function footnote(last, content, what) {
  if (!last || !content) return null;
  return last
    .reply({ content, allowedMentions: { repliedUser: false } })
    .catch((error) => {
      log.warn(`${what}_post_failed`, { error: error.message });
      return null;
    });
}

/** What a reaction sweep needs to know about a turn, kept small. */
export function turnRecord({ routine, lane, question, text, result, channelId }) {
  const requestIds = [
    ...(result.envelopes || []).map((e) => e.request_id),
    ...(result.errors || []).map((e) => e.requestId),
  ].filter(Boolean);
  return {
    routine: routine.key,
    lane,
    question: String(question || "").slice(0, 700),
    answer: String(text || "").slice(0, 1200),
    called: result.called || [],
    errors: (result.errors || []).map((e) => ({ name: e.name, code: e.code, detail: String(e.detail || "").slice(0, 200) })),
    requestIds: [...new Set(requestIds)].slice(0, 12),
    channelId: channelId || null,
    at: new Date().toISOString(),
  };
}

/**
 * @param {object} routine  parsed routine
 * @param {object} options.channel   Discord channel, omitted for a dry run
 * @param {Array}  options.events    feed events, for an event-triggered run
 * @param {boolean} options.dryRun   compose and return, post nothing
 * @param {Function} options.askFn   injectable model call, for tests
 */
export async function runRoutine(
  routine,
  { channel = null, events = null, dryRun = false, askFn = ask } = {},
) {
  const lane = laneFor(routine);
  const blocked = spendBlock(lane);
  if (blocked) {
    // A budget that stops the bot is doing its job, so this is INFO-with-teeth
    // rather than an error: the operator set the number.
    log.warn("routine_over_budget", {
      routine: routine.key,
      lane,
      reason: blocked.reason,
      spent: blocked.spent?.toFixed(2),
      budget: blocked.budget?.toFixed(2),
    });
    return { ok: false, error: `budget:${blocked.reason}` };
  }

  // What THIS routine said last, from its own ledger. The channel is the
  // fallback for a routine that has never posted since the ledger existed —
  // and a rough one: in a shared channel it hands back other routines' posts.
  let recent = routine.recall ? state.recentOwnPosts(routine.key, routine.recall) : [];
  if (recent.length === 0 && channel && routine.recall) {
    recent = await recentPosts(channel, routine.recall);
  }
  const result = await askFn({
    system: systemFor(routine),
    messages: [
      { role: "user", content: userMessageFor(routine, { events, recent }) },
    ],
    maxTokens: routine.maxTokens,
    model: routine.model,
    effort: routine.effort,
    routineKey: routine.key,
    lane,
  });

  if (!result.ok) {
    log.error("routine_failed", { routine: routine.key, error: result.error });
    return { ok: false, error: result.error };
  }

  const text = (result.text || "").trim();
  // A routine that may skip and did is a normal, successful, silent outcome.
  // One that may NOT skip and answered SKIP anyway is a prompt bug, and
  // posting the word SKIP into a channel is how you find out about it.
  const skipped = routine.maySkip && isSkip(text);

  if (dryRun || !channel) {
    return { ok: true, skipped, text, result };
  }

  if (skipped) {
    log.info("routine_skipped", {
      routine: routine.key,
      usd: result.usd.toFixed(4),
    });
    return { ok: true, skipped: true, text, result };
  }

  const sent = await post(channel, text, routine.maxChars);
  const last = sent.at(-1) ?? null;
  state.rememberPost(routine.key, text);
  const notes = [];
  if (routine.trace) {
    notes.push(await footnote(last, renderTrace(result, { label: routine.key }), "trace"));
  } else {
    // No trace, but a reader still gets the two caveats that change whether
    // the numbers above can be trusted.
    notes.push(await footnote(last, errorFooter(result), "error_footer"));
  }
  if (looksUngrounded({ text, called: result.called, events })) {
    log.warn("routine_ungrounded", { routine: routine.key, turnId: result.turnId });
    notes.push(await footnote(last, UNGROUNDED_FOOTER, "ungrounded_footer"));
  }
  // Every message this turn produced points back at the turn, so a reaction
  // on any of them — the post, its footer — finds the same record.
  state.rememberTurn(
    result.turnId,
    turnRecord({ routine, lane, question: routine.prompt, text, result, channelId: channel.id }),
    [...sent, ...notes].map((m) => m?.id),
  );

  log.info("routine_posted", {
    routine: routine.key,
    turnId: result.turnId,
    tools: result.called.length,
    toolNames: result.called.join(","),
    usd: result.usd.toFixed(4),
    cache: result.usage ? `${Math.round(cacheShare(result.usage) * 100)}%` : undefined,
    ms: result.ms,
    chars: text.length,
  });

  // Friction filing is not an ask-lane feature. A scheduled report that could
  // not get what it needed is the most useful thing this bot produces, and it
  // used to evaporate because nobody was in the channel to notice.
  const friction = detectFriction({
    text,
    called: result.called,
    errors: result.errors,
  });
  if (friction) {
    const summary = await sweepFriction({
      question: `Scheduled routine "${routine.key}":\n${routine.prompt}`,
      answer: text,
      friction,
      // The sweep is a second call caused by this turn, so it is charged where
      // the turn was.
      lane,
    }).catch((error) => {
      log.warn("feedback_sweep_crashed", { error: error.message });
      return null;
    });
    if (summary && last) {
      await last
        .reply({
          content: `-# 📮 Filed with Elixir MCP: ${summary}`,
          allowedMentions: { repliedUser: false },
        })
        .catch(() => {});
    }
  }

  return { ok: true, skipped: false, text, result };
}
