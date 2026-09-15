/**
 * The diagnostic footer under an answer.
 *
 * In a channel whose purpose is showing what Elixir MCP is like, the tool names
 * and arguments ARE the demonstration — a member who sees `war_current` called
 * with their clan tag learns something a polished answer hides. But the reason
 * it carries this much is debuggability: a screenshot of a wrong answer should
 * be enough to work out what went wrong, without anyone reading a log.
 *
 * What each part is for:
 *   shape (→ 1 players)   the tool answered fine WITH NOTHING IN IT, and the
 *                         model narrated around the hole. "1 player" and
 *                         "0 players" read identically in prose.
 *   envelope              as_of / recorded_since / freshness — whether "94
 *                         battles in 30 days" is the record or a fragment.
 *   completeness_note     the server explicitly saying capture was incomplete.
 *                         It has always reached the model and never the reader.
 *   latency               separates "slow because six calls" from "slow because
 *                         one call took nine seconds".
 *   rounds / stop reason  a pause_turn resume otherwise looks like a straight
 *                         run, and a max_tokens cutoff looks like a finished
 *                         answer.
 *   model / effort        cost without them is unattributable after a change,
 *                         and routines may each pick their own.
 *   contract fingerprint  when an answer changes shape between two days, this
 *                         says whether the bot saw the old surface or the new.
 *   request id            the server's own id for the last call (and for each
 *                         failed one), so a report can name the exact request.
 *
 * Any routine can ask for one with `trace: true`; message routines get it by
 * default, because that is the channel where people are judging the answers
 * rather than reading the news.
 */

import { unexpectedErrors, tallyCalls } from "./feedback.js";
import { cacheShare } from "./claude.js";

const TRACE_LIMIT = 1900;

const shortId = (id) => (id ? String(id).slice(0, 8) : null);

/**
 * The one line a reader gets when a post was built on failed calls, whether
 * or not the routine shows a trace.
 *
 * On 2026-09-11 a spotlight presented pros-collection card stats after four of
 * its eight calls had failed, and the only sign was a sweep note under it
 * saying "possible fabricated data". The maintainer's reply (#33) asked this
 * preview to stop publishing a claimed comparison over failed reads. This is
 * the deterministic half: the failures are visible under every post that had
 * them. The prompt carries the other half (stop retrying, leave the part out).
 */
export function errorFooter(result) {
  const failed = unexpectedErrors(result.errors);
  if (failed.length === 0) return null;
  const total = (result.called || []).length;
  const ids = failed.map((e) => shortId(e.requestId)).filter(Boolean);
  const which = tallyCalls(failed.map((e) => `${e.name}${e.code ? ` (${e.code})` : ""}`));
  return clip(
    `-# ⚠️ ${failed.length} of ${total} tool calls failed: ${which}${ids.length ? ` · req ${ids.join(", ")}` : ""}. Figures that depended on them may be missing or wrong.`,
    400,
  );
}

/** The caveat under a reply that stated figures without reading anything this turn. */
export const UNGROUNDED_FOOTER =
  "-# ⚠️ No tool was called for this reply, so any figures in it are repeated from earlier in the conversation, not re-read.";

export function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function agoLabel(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 120) return `fresh ${Math.round(seconds)}s`;
  if (seconds < 7200) return `fresh ${Math.round(seconds / 60)}m`;
  return `fresh ${Math.round(seconds / 3600)}h`;
}

export function renderTrace(result, { label = "How I got there" } = {}) {
  const short = (name) => name.replace(/^.*__/, "");

  // Built in priority order: the mechanical facts always fit, and reasoning
  // fills whatever room is left. Losing a thought costs less than losing the
  // completeness caveat that explains why the number is wrong.
  const head = `-# **${label}** · \`${result.turnId}\``;

  const cached = result.usage ? cacheShare(result.usage) : 0;
  const footer = [
    result.model,
    `effort ${result.effort}`,
    `$${result.usd.toFixed(4)}`,
    result.usage ? `cache ${Math.round(cached * 100)}%` : null,
    `${(result.ms / 1000).toFixed(1)}s`,
    result.rounds > 1 ? `${result.rounds} rounds` : null,
    result.stopReason,
    result.truncated ? "**TRUNCATED**" : null,
    result.serverVersion,
  ]
    .filter(Boolean)
    .join(" · ");

  const required = [];
  for (const step of result.trace) {
    if (step.kind === "tool") {
      let args = "{}";
      try {
        // A post's content is already in the channel above the footer.
        args = JSON.stringify(
          step.name === "post_message" ? { channel_id: step.input?.channel_id } : (step.input ?? {}),
        );
      } catch {
        /* keep the placeholder */
      }
      const clipped = args.length > 180;
      const parts = [`> 🔧 \`${short(step.name)}\` \`${clip(args, 180)}\``];
      if (clipped) parts.push("*(args clipped)*");
      if (step.shape) parts.push(`→ ${step.shape}`);
      if (step.ms !== undefined) parts.push(`· ${(step.ms / 1000).toFixed(1)}s`);
      required.push(parts.join(" "));
    } else if (step.kind === "error") {
      const code = step.code ? ` (${step.code})` : "";
      const req = step.requestId ? ` · req \`${shortId(step.requestId)}\`` : "";
      required.push(`> ⚠️ \`${short(step.name)}\` failed${code}: ${clip(step.detail, 200)}${req}`);
    }
  }

  const envelope = result.envelopes?.at(-1);
  if (envelope) {
    const bits = [
      envelope.as_of ? `as_of ${envelope.as_of.slice(11, 16)}Z` : null,
      envelope.recorded_since ? `recorded since ${envelope.recorded_since.slice(0, 10)}` : null,
      agoLabel(envelope.freshness_seconds),
      envelope.request_id ? `req \`${shortId(envelope.request_id)}\`` : null,
    ].filter(Boolean);
    if (bits.length) required.push(`> 📅 ${bits.join(" · ")}`);
  }

  const notes = [...new Set((result.envelopes || []).map((e) => e.completeness_note).filter(Boolean))];
  for (const note of notes.slice(0, 2)) {
    required.push(`> ❗ ${clip(note, 300)}`);
  }

  if (required.length === 0 && result.trace.length === 0) return null;

  const thoughts = result.trace
    .filter((step) => step.kind === "thought")
    .map((step) => `> 💭 ${clip(step.text.replace(/\s+/g, " "), 400)}`);

  const lines = [head, ...required];
  let used = [...lines, `-# ${footer}`].join("\n").length;
  let shown = 0;
  for (const thought of thoughts) {
    if (used + thought.length + 1 > TRACE_LIMIT) break;
    lines.push(thought);
    used += thought.length + 1;
    shown += 1;
  }
  if (shown < thoughts.length) {
    const omitted = `> 💭 *(${thoughts.length - shown} more reasoning step${thoughts.length - shown === 1 ? "" : "s"} not shown)*`;
    if (used + omitted.length + 1 <= TRACE_LIMIT) lines.push(omitted);
  }

  lines.push(`-# ${footer}`);
  return clip(lines.join("\n"), 2000);
}
