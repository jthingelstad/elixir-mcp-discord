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
import * as ledger from "./ledger.js";
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
the honest \`category\` (bug / data_quality / feature / praise / other). When
the item is about one call, pass that call's \`request_id\` — every result
carries it in \`meta.request_id\` — so the maintainer can open the exact
request rather than guess at it.

File it in the same turn, then answer the member normally. Do not mention the
filing in your reply unless they asked about it — a short note is appended to
your message automatically.
`.trim();

function calledFeedback(called) {
  return called.some((name) => name.includes("elixir_feedback"));
}

/**
 * WHOSE FAULT WAS IT. Every sweep used to end one of two ways: a filing to
 * Elixir's maintainer, or NONE. But "not Elixir's fault" is not "nobody's":
 * a first-contact rule that made the bot ask for a tag it could have looked
 * up, a brief that told a routine to report what the feed already said, a
 * limit conceded because the prompt never mentioned the tool that answers
 * it. Those are this bot's, and NONE threw them away. A sweep now says which
 * of three parties owns the fix, and the two that are ours become `finding`
 * records the review lane (src/review.js) reads.
 *
 *   ELIXIR: <summary>     filed upstream; the summary is the footer
 *   PROMPT: <note>        this instance's agent/ — wording, a brief, a rule
 *   MECHANICS: <note>     src/ — a rule in code, a runner behaviour
 *   NONE                  nothing worth anyone's time
 */
export const CLASSIFY_RULES = `Decide who owns the fix, and reply with ONE line in one of these forms:
- \`ELIXIR: <under 140 chars>\` — the server is missing a capability, gave a
  misleading result, or failed a call. File it with elixir_feedback FIRST
  (at most one item, concrete, with the request id when it is about one
  call), then reply with this line summarising what you filed.
- \`PROMPT: <under 200 chars>\` — the agent's own instructions caused it: a
  rule in its house rules or brief that produced a bad outcome, a tool it
  was never told about, wording it should not have used. Do NOT file; say
  what the instruction should say instead.
- \`MECHANICS: <under 200 chars>\` — the runner's own rules or behaviour
  caused it (the grounding rule, the Discord format rules, how identity is
  resolved, the post tool, budgets). Do NOT file; say what is wrong.
- \`NONE\` — nothing concrete and actionable for anyone.`;

/** Parse a sweep's one-line verdict. */
export function parseVerdict(text) {
  const line = (text || "").trim().split("\n").find((l) => l.trim()) || "";
  const match = /^\s*(ELIXIR|PROMPT|MECHANICS|NONE)\s*:?\s*(.*)$/i.exec(line);
  if (!match) return { cls: null, note: line.slice(0, 200) };
  const cls = match[1].toLowerCase();
  return { cls: cls === "none" ? null : cls, note: match[2].trim().slice(0, 200) };
}

/** Record a PROMPT/MECHANICS verdict for the review lane. */
export function recordFinding({ turnId, verdict, source }) {
  if (!turnId || !verdict?.cls || verdict.cls === "elixir") return;
  ledger.append(ledger.findingEntry({ turnId, cls: verdict.cls, source, note: verdict.note }));
  log.info("finding_recorded", { turnId, class: verdict.cls, source, note: verdict.note });
}

function looksLikeLimit(text) {
  const low = (text || "").toLowerCase();
  return LIMIT_MARKERS.some((marker) => low.includes(marker));
}

/**
 * Error codes that are the service working as designed, not friction. Both are
 * in the contract's closed set (1.0.0):
 *
 *   no_subject      there was nobody to answer about — an unmapped
 *                   on_behalf_of, or a question with no default player. The
 *                   agent's next move is to ask who is asking, which the prompt
 *                   already tells it to do; filing that would report the
 *                   identity flow as a bug every time a new member speaks.
 *   quota_exceeded  the ceiling did what it is for. The maintainer sets it and
 *                   can read it in the audit log; a feedback item adds nothing.
 *
 * Every other code — invalid_tag, not_entitled, not_recorded, not_found,
 * live_unavailable, bad_request, result_too_large — stays a signal.
 */
const EXPECTED_ERROR_CODES = new Set(["no_subject", "quota_exceeded"]);

/** This runner's own tools. Their refusals (a channel not in the directory,
 *  the post cap) are this consumer's behaviour, never hub friction to file. */
const LOCAL_TOOLS = new Set(["post_message", "deck_link", "propose_change", "lookup_turn", "search_turns", "status", "estimate_cost", "list_routines", "list_example_routines", "list_channels", "report_mechanics"]);

/** The errors worth a reader's or the maintainer's attention. */
export function unexpectedErrors(errors) {
  return (errors || []).filter((e) => !EXPECTED_ERROR_CODES.has(e.code) && !LOCAL_TOOLS.has(e.name));
}

/**
 * How many tool calls in one turn is "noticeably more than it should have
 * taken". A movers post once made thirteen per-member battles_performance
 * calls — exactly the friction the prompt asks the agent to file, and it never
 * did, because nothing on this side counted. Eight is above every routine's
 * normal run and below that one.
 */
export const MANY_CALLS = 8;

function describeError(e) {
  const req = e.requestId ? ` req ${String(e.requestId).slice(0, 8)}` : "";
  return `${e.name}${e.code ? ` [${e.code}]` : ""}${req}: ${e.detail}`;
}

/** Tool names with their call counts, busiest first: "battles_performance ×13, clans_roster ×1". */
export function tallyCalls(called) {
  const counts = new Map();
  for (const name of called || []) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(", ");
}

/**
 * Did this reply state figures without reading anything this turn?
 *
 * "How am I playing?" was once answered from the previous exchange with zero
 * tool calls, which breaks the one rule every prompt layer carries. Events
 * handed to a routine are a legitimate source, so a brief written from the
 * feed alone is not ungrounded. Digits are the cheapest proxy for "a figure"
 * and over-include a little (dates, "2v2"); the cost of a false positive is
 * one small-text caveat.
 */
export function looksUngrounded({ text, called, events }) {
  if ((called || []).length > 0) return false;
  // Handed timeline items (an array, or the {timeline, entries} object) are a source.
  if (Array.isArray(events) ? events.length : events?.timeline?.length) return false;
  return /\d/.test(text || "");
}

/** Did this turn hit friction worth a second look? */
export function detectFriction({ text, called, errors }) {
  if (calledFeedback(called)) return null;
  const unexpected = unexpectedErrors(errors);
  if (unexpected.length > 0) {
    return {
      reason: "tool_error",
      codes: unexpected.map((e) => e.code).filter(Boolean),
      requestIds: unexpected.map((e) => e.requestId).filter(Boolean),
      detail: unexpected.map(describeError).join(" | "),
    };
  }
  if ((called || []).length >= MANY_CALLS) {
    return {
      reason: "many_calls",
      count: called.length,
      detail: tallyCalls(called),
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
  turnId = null,
}) {
  const system = `You are reviewing one exchange between a Clash Royale clan member and an
agent whose only data source is the Elixir MCP server. Your job is to decide
whether the agent hit real friction, and whose fault it was.

${FEEDBACK_PROMPT}

Rules for this review:
- File AT MOST one item, and only if it is concrete and actionable.
- Do not file because an answer was merely short, or because the member asked
  something outside Clash Royale entirely.
- Do not file a duplicate of an obvious, already-known gap unless this exchange
  adds a new specific.

${CLASSIFY_RULES}`;

  const detected =
    friction.reason === "tool_error"
      ? `A tool returned an error: ${friction.detail}${
          friction.requestIds?.length
            ? `\nPass the request_id of the failing call when you file: ${friction.requestIds.join(", ")}`
            : ""
        }`
      : friction.reason === "many_calls"
        ? `The turn took ${friction.count} tool calls (${friction.detail}). Was there a tool or an argument that would have answered in fewer, and if not, what is missing?`
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
  const verdict = parseVerdict(result.text);
  if (verdict.cls === "prompt" || verdict.cls === "mechanics") {
    recordFinding({ turnId, verdict, source: "sweep" });
    return null;
  }
  if (!calledFeedback(result.called) || verdict.cls !== "elixir") {
    log.info("feedback_sweep_declined", {
      reason: friction.reason,
      usd: result.usd.toFixed(4),
    });
    return null;
  }
  const summary = verdict.note || "filed";
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
