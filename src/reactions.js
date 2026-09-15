/**
 * Reader reactions as feedback.
 *
 * The agent files friction on its own judgment and a sweep catches what it
 * missed, but neither knows whether an answer was RIGHT. Only a reader does,
 * and until now a reader had no way to say so that reached anyone. A 👎 on
 * any message a turn produced — the post, its footer — is joined back to the
 * turn (question, tools called, the server's request ids) and swept: the
 * model reflects once and files at most one item with elixir_feedback. A 👍
 * files praise deterministically, without a model call, so a good answer is
 * protected from regression at no cost.
 *
 * Each kind is handled once per turn. A 👎 the sweep could make nothing of
 * is released again, so the reader can reply with what was wrong and react a
 * second time; the reply is then part of the filing.
 */

import { ask, spendBlock } from "./claude.js";
import { callTool } from "./mcp.js";
import { FEEDBACK_PROMPT, CLASSIFY_RULES, parseVerdict, recordFinding, tallyCalls } from "./feedback.js";
import { config } from "./config.js";
import { log } from "./log.js";
import * as ledger from "./ledger.js";
import * as state from "./state.js";

export const REACTIONS = { "👍": "up", "👎": "down" };

function calledFeedback(called) {
  return (called || []).some((name) => name.includes("elixir_feedback"));
}

/** What the reader said about the message, if they replied to it. */
async function readerNote(message, user) {
  try {
    const after = await message.channel.messages.fetch({ after: message.id, limit: 30 });
    const reply = [...after.values()]
      .filter((m) => m.author?.id === user.id && m.reference?.messageId === message.id)
      .at(-1);
    return reply?.cleanContent?.trim() || null;
  } catch {
    return null;
  }
}

function describeTurn(turn, note) {
  const lines = [
    `ROUTINE: ${turn.routine}`,
    `QUESTION OR BRIEF:\n${turn.question}`,
    `ANSWER POSTED:\n${turn.answer}`,
    `TOOLS CALLED: ${tallyCalls(turn.called) || "none"}`,
  ];
  if (turn.errors?.length) {
    lines.push(
      `TOOL ERRORS: ${turn.errors.map((e) => `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.detail}`).join(" | ")}`,
    );
  }
  if (turn.requestIds?.length) lines.push(`REQUEST IDS: ${turn.requestIds.join(", ")}`);
  if (note) lines.push(`THE READER SAID: ${note}`);
  return lines.join("\n\n");
}

/**
 * The 👎 path: one reflection, at most one filing. Returns the filed summary
 * (a string) when Elixir owns the fix, `{ cls, note }` when this bot does —
 * recorded as a finding for the review lane — or null for nothing.
 */
export async function sweepReaction({ turn, note }) {
  const blocked = spendBlock(turn.lane || "routines");
  if (blocked) {
    log.warn("reaction_sweep_over_budget", { turnId: turn.turnId, reason: blocked.reason });
    return null;
  }
  const system = `A clan member marked one of this agent's answers as wrong or unhelpful. The
agent's only data source is the Elixir MCP server. Decide whose fault it was:
the SERVER (a missing capability, a misleading result, a failed call), the
agent's own PROMPT (its house rules or brief), or the runner's MECHANICS.

${FEEDBACK_PROMPT}

Rules for this review:
- File AT MOST one item, and only if it is concrete and actionable.
- A reader's note is the strongest evidence you have; weigh it above the
  agent's own account of what it did.

${CLASSIFY_RULES}`;

  const result = await ask({
    system,
    lane: turn.lane || "routines",
    routineKey: "reaction-sweep",
    maxTokens: 3000,
    messages: [{ role: "user", content: describeTurn(turn, note) }],
  });
  if (!result.ok) {
    log.warn("reaction_sweep_failed", { turnId: turn.turnId, error: result.error });
    return null;
  }
  const verdict = parseVerdict(result.text);
  if (verdict.cls === "prompt" || verdict.cls === "mechanics") {
    recordFinding({ turnId: turn.turnId, verdict, source: "reaction" });
    return { cls: verdict.cls, note: verdict.note };
  }
  if (!calledFeedback(result.called) || verdict.cls !== "elixir") {
    log.info("reaction_sweep_declined", { turnId: turn.turnId, usd: result.usd.toFixed(4) });
    return null;
  }
  const summary = verdict.note || "filed";
  log.info("reaction_feedback_filed", { turnId: turn.turnId, summary, usd: result.usd.toFixed(4) });
  return summary.slice(0, 200);
}

/** The 👍 path: praise, filed directly, no model. Returns true when filed. */
export async function filePraise({ turn }) {
  const args = {
    category: "praise",
    context: tallyCalls(turn.called) || turn.routine,
    message: `A reader marked this answer as good (routine "${turn.routine}"). ${
      turn.question ? `Asked: ${turn.question.slice(0, 300)}` : ""
    } Tools: ${tallyCalls(turn.called) || "none"}. Worth protecting from regression.`,
  };
  if (turn.requestIds?.[0]) args.request_id = turn.requestIds[0];
  const result = await callTool("elixir_feedback", args);
  if (!result.ok) {
    log.warn("praise_file_failed", { turnId: turn.turnId, error: result.error });
    return false;
  }
  log.info("praise_filed", { turnId: turn.turnId, routine: turn.routine });
  return true;
}

/**
 * @param reaction  discord.js MessageReaction (possibly partial)
 * @param user      the reacting user (possibly partial)
 */
export async function handleReaction(reaction, user, { sweepFn = sweepReaction, praiseFn = filePraise } = {}) {
  const kind = REACTIONS[reaction.emoji?.name];
  if (!kind) return null;
  if (user.partial) await user.fetch().catch(() => {});
  if (user.bot) return null;

  const message = reaction.message?.partial ? await reaction.message.fetch() : reaction.message;
  const turn = state.turnForMessage(message.id);
  if (!turn) return null;
  if (!state.markReaction(turn.turnId, kind)) return null;

  const respond = (content) =>
    message
      .reply({ content, allowedMentions: { repliedUser: false } })
      .catch((error) => log.warn("reaction_reply_failed", { error: error.message }));

  if (kind === "up") {
    ledger.append(ledger.reactionEntry({ turnId: turn.turnId, reaction: kind, userId: user.id }));
    const filed = await praiseFn({ turn });
    if (filed) await respond("-# 📮 Filed as praise with Elixir MCP, with this answer's request id.");
    return { kind, filed };
  }

  const note = await readerNote(message, user);
  ledger.append(ledger.reactionEntry({ turnId: turn.turnId, reaction: kind, userId: user.id, note: note || null }));
  const summary = await sweepFn({ turn, note });
  if (summary && typeof summary === "object") {
    // Ours, not Elixir's. The finding is already in the ledger; the reader
    // learns it landed somewhere, and the operator sees it at the next review.
    await respond(
      `-# 📮 Noted — that one is on this bot's side, not Elixir's${config.review.enabled ? "; it is queued for the next review" : ""}.`,
    );
    return { kind, filed: false, finding: summary };
  }
  if (summary) {
    ledger.append(ledger.filedEntry({ turnId: turn.turnId, summary }));
    await respond(`-# 📮 Filed with Elixir MCP: ${summary}`);
    return { kind, filed: true, summary };
  }
  // Nothing specific to file. Release the mark so a second 👎 after a reply
  // gets swept with the reader's words in hand.
  if (!note) {
    state.markReaction(turn.turnId, kind, false);
    await respond(
      "-# 📮 Noted. Reply to this message with what was wrong and react 👎 again, and it will be filed with the maintainer.",
    );
  }
  return { kind, filed: false };
}
