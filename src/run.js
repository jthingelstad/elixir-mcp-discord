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

import { ask, spendBlock } from "./claude.js";
import { laneFor } from "./budget.js";
import { detectFriction, sweepFriction } from "./feedback.js";
import { systemFor, userMessageFor, isSkip } from "./prompt.js";
import { post, recentPosts } from "./post.js";
import { renderTrace } from "./trace.js";
import { log } from "./log.js";

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

  const recent =
    channel && routine.recall ? await recentPosts(channel, routine.recall) : [];
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

  const last = await post(channel, text, routine.maxChars);
  if (routine.trace && last) {
    const trace = renderTrace(result, { label: routine.key });
    if (trace) {
      await last
        .reply({ content: trace, allowedMentions: { repliedUser: false } })
        .catch((error) =>
          log.warn("trace_post_failed", { error: error.message }),
        );
    }
  }

  log.info("routine_posted", {
    routine: routine.key,
    turnId: result.turnId,
    tools: result.called.length,
    toolNames: result.called.join(","),
    usd: result.usd.toFixed(4),
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
