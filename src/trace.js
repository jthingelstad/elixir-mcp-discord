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
 *
 * Any routine can ask for one with `trace: true`; message routines get it by
 * default, because that is the channel where people are judging the answers
 * rather than reading the news.
 */

const TRACE_LIMIT = 1900;

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

  const footer = [
    result.model,
    `effort ${result.effort}`,
    `$${result.usd.toFixed(4)}`,
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
        args = JSON.stringify(step.input ?? {});
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
      required.push(`> ⚠️ \`${short(step.name)}\` failed: ${clip(step.detail, 200)}`);
    }
  }

  const envelope = result.envelopes?.at(-1);
  if (envelope) {
    const bits = [
      envelope.as_of ? `as_of ${envelope.as_of.slice(11, 16)}Z` : null,
      envelope.recorded_since ? `recorded since ${envelope.recorded_since.slice(0, 10)}` : null,
      agoLabel(envelope.freshness_seconds),
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
