/**
 * Friction capture — the reason this project earns its keep.
 *
 * The interesting output of these channels is not the answers. It is the record
 * of what the agent WANTED to do and could not: a capability that isn't there,
 * a workflow that took five calls when it should take one, a result that
 * misled it. Elixir MCP has a first-class door for exactly that
 * (`elixir_feedback`, answered by the maintainer, readable back via
 * `elixir_my_feedback`), and the server's own instructions tell agents to file
 * on their own judgment.
 *
 * Relying on that judgment alone is not enough, though. A model that has just
 * produced a graceful "I can't see donation history" is done — it has answered
 * the member and moved on, and the friction evaporates. So there are two paths
 * here, and they cover different failures:
 *
 *   1. INLINE. The system prompt tells the agent to file as it goes. This
 *      catches friction the model notices while it still has the context.
 *   2. SWEEP. After the turn, a deterministic check looks for the signatures of
 *      friction — a tool error, or an answer that concedes a limit — and if the
 *      model did not already file, asks it to reflect once and file.
 *
 * The sweep is a second model call and it is not free. It only fires when a
 * signature matched, which in practice is a small fraction of turns.
 */

import { ask } from "./claude.js";
import { callTool } from "./mcp.js";
import { log } from "./log.js";
import * as state from "./state.js";

/** Answer text that concedes a limit. Deliberately over-inclusive: a false
 *  positive costs one cheap reflection call that ends in NONE, while a false
 *  negative loses the signal permanently. */
const LIMIT_MARKERS = [
  "i can't",
  "i cannot",
  "i'm not able",
  "i am not able",
  "not available",
  "no tool",
  "isn't exposed",
  "is not exposed",
  "doesn't expose",
  "does not expose",
  "isn't recorded",
  "is not recorded",
  "no way to",
  "unable to",
  "not supported",
  "doesn't support",
  "does not support",
  "couldn't find a tool",
  "there's no ",
  "i don't have access",
  "not something i can",
];

export const FEEDBACK_PROMPT = `
FILING FEEDBACK (do this without being asked)

You are one of the first agents using Elixir MCP in production, and the
maintainer reads everything you file. Filing friction is part of your job here,
not an interruption of it.

Call elixir_feedback the moment any of these happen:
- You wanted a capability that does not exist, or could not find a tool for
  something a clan member reasonably asked for.
- A question took noticeably more tool calls than it should have.
- A result confused you, contradicted another tool, or looked wrong.
- Something worked unusually well and should be protected from regression.

Be specific and concrete. "battles_query has no way to filter by game mode, so
answering 'how do I do in 2v2' meant pulling 200 battles and counting by hand"
is useful. "Some things are hard" is not. Name the tool in \`context\`, and pick
the honest \`category\` (bug / data_quality / feature / praise / other).

File it in the same turn, then answer the member normally. Do not mention the
filing in your reply unless they asked about it — a short note is appended to
your message automatically.
`.trim();

function calledFeedback(called) {
  return called.some((name) => name.includes("elixir_feedback"));
}

function looksLikeLimit(text) {
  const low = (text || "").toLowerCase();
  return LIMIT_MARKERS.some((marker) => low.includes(marker));
}

/** Did this turn hit friction worth a second look? */
export function detectFriction({ text, called, errors }) {
  if (calledFeedback(called)) return null;
  if (errors.length > 0) {
    return {
      reason: "tool_error",
      detail: errors.map((e) => `${e.name}: ${e.detail}`).join(" | "),
    };
  }
  if (looksLikeLimit(text)) {
    return { reason: "conceded_limit", detail: text.slice(0, 600) };
  }
  return null;
}

/**
 * The sweep. Asks the model to reflect on one turn and file if it is warranted,
 * and returns a short summary for the Discord footer. Returns null when the
 * model decides there is nothing worth filing — that is a normal outcome and
 * not an error.
 */
export async function sweepFriction({
  question,
  answer,
  friction,
  lane = "routines",
}) {
  const system = `You are reviewing one exchange between a Clash Royale clan member and an
agent whose only data source is the Elixir MCP server. Your job is to decide
whether the agent hit real friction worth reporting to the maintainer, and if
so, to file it with elixir_feedback.

${FEEDBACK_PROMPT}

Rules for this review:
- File AT MOST one item, and only if it is concrete and actionable.
- Do not file because an answer was merely short, or because the member asked
  something outside Clash Royale entirely.
- Do not file a duplicate of an obvious, already-known gap unless this exchange
  adds a new specific.

Reply with ONE line: a plain-language summary of what you filed (under 140
characters), or exactly NONE if you filed nothing.`;

  const detected =
    friction.reason === "tool_error"
      ? `A tool returned an error: ${friction.detail}`
      : `The agent conceded a limit in its answer.`;

  const result = await ask({
    system,
    lane,
    routineKey: "feedback-sweep",
    maxTokens: 3000,
    messages: [
      {
        role: "user",
        content: `MEMBER ASKED:\n${question}\n\nAGENT ANSWERED:\n${answer}\n\nDETECTED: ${detected}`,
      },
    ],
  });

  if (!result.ok) {
    log.warn("feedback_sweep_failed", { error: result.error });
    return null;
  }
  const summary = (result.text || "").trim();
  if (!calledFeedback(result.called) || /^none\b/i.test(summary)) {
    log.info("feedback_sweep_declined", {
      reason: friction.reason,
      usd: result.usd.toFixed(4),
    });
    return null;
  }
  log.info("feedback_filed", {
    reason: friction.reason,
    summary,
    usd: result.usd.toFixed(4),
  });
  return summary.slice(0, 200);
}

/**
 * Reads maintainer responses to feedback this account filed, newest first, and
 * returns the ones we have not shown yet. Closing this loop in public is half
 * the point: a member watching their complaint get answered is the strongest
 * argument for the product there is.
 */
export async function newFeedbackResponses({ seedOnly = false } = {}) {
  const result = await callTool("elixir_my_feedback", {});
  if (!result.ok) {
    log.warn("feedback_read_failed", { error: result.error });
    return [];
  }

  const items = result.body?.items || result.body?.feedback || [];
  const seen = new Set(state.get("answeredFeedbackIds") || []);
  const fresh = [];

  for (const item of items) {
    const id = item.feedback_id ?? item.id;
    const response = item.response ?? item.maintainer_response;
    if (id === undefined || !response || seen.has(id)) continue;
    fresh.push({
      id,
      message: item.message || "",
      response,
      shippedIn: item.shipped_in ?? item.shippedIn ?? null,
      status: item.status ?? null,
    });
    seen.add(id);
  }

  if (fresh.length > 0) {
    state.set({ answeredFeedbackIds: [...seen].slice(-500) });
  }

  // First run marks the whole history as already shown and returns nothing.
  // Same rule as the event cursor: seed, never drain. An empty ledger meeting a
  // year of answered feedback is a channel full of old news, which is a worse
  // first impression than silence — and it happened, once, on 2026-09-08.
  return seedOnly ? [] : fresh;
}
