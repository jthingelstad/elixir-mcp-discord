/**
 * The message lane — a human asks in a channel, the agent answers.
 *
 * It is the one trigger that does not go through src/run.js, because it is
 * genuinely a different job: it streams into a live message, it carries the
 * channel's recent conversation, and it replies to a person who is waiting.
 * The other triggers compose one post and put it somewhere.
 *
 * Its prompt is not in this file. `agent/routines/<key>.md` with
 * `trigger: message` supplies the brief, and its channel decides where it
 * answers — so a clan can run one ask channel, three with different briefs, or
 * none at all, without touching this code.
 *
 * It does not know who anyone is. A member's own agent knows them because they
 * added their own player; this bot has no such link, and faking one with a
 * local nickname table would make the demo promise something a real user
 * cannot reproduce. So it passes on_behalf_of and lets the server remember.
 */

import { ask, spendBlock, cacheShare } from "./claude.js";
import { laneFor } from "./budget.js";
import { detectFriction, sweepFriction, looksUngrounded } from "./feedback.js";
import { systemFor } from "./prompt.js";
import { chunk } from "./post.js";
import { renderTrace, errorFooter, UNGROUNDED_FOOTER } from "./trace.js";
import { turnRecord } from "./run.js";
import { log } from "./log.js";
import * as state from "./state.js";

/**
 * ONE THREAD PER QUESTION.
 *
 * A question in the ask channel gets its own thread, and the answer, its
 * footer and any follow-ups live there. Before this the channel was one long
 * conversation: history was channel-wide, so a member's question arrived with
 * another member's context in the window, and "same as above — here's where
 * you stand" was the model answering one person from what it had told
 * another. A thread is the conversation boundary Discord already has.
 *
 * Follow-ups are messages in the thread; a new top-level message is a new
 * conversation with no history, on purpose. Thread creation needs the Create
 * Public Threads permission; without it the bot answers in the channel as it
 * used to, and says so once in the log.
 */
const THREAD_ARCHIVE_MINUTES = 1440;
let threadsUnavailable = false;

export function threadName(question) {
  const flat = question.replace(/\s+/g, " ").trim();
  return (flat.length > 90 ? `${flat.slice(0, 89)}…` : flat) || "question";
}

export function isThreadOf(channel, parentId) {
  return Boolean(channel?.isThread?.() && channel.parentId === parentId);
}

async function threadFor(message) {
  if (threadsUnavailable || typeof message.startThread !== "function") return null;
  try {
    return await message.startThread({
      name: threadName(message.cleanContent),
      autoArchiveDuration: THREAD_ARCHIVE_MINUTES,
    });
  } catch (error) {
    threadsUnavailable = true;
    log.warn("thread_create_failed", {
      error: error.message,
      hint: "grant Create Public Threads and Send Messages in Threads; answering in the channel until restart",
    });
    return null;
  }
}

/**
 * A Discord message edited on a throttle, which is as close to streaming as
 * Discord gets — there is no partial-message API, only `edit`. Discord rate
 * limits edits per channel (roughly 5 per 5s), so EDIT_MS keeps a comfortable
 * margin and a flush is skipped entirely when nothing changed.
 */
const EDIT_MS = 1500;

class LiveMessage {
  constructor(message) {
    this.message = message;
    this.rendered = null;
    this.next = null;
    this.timer = setInterval(() => this.flush(), EDIT_MS);
  }

  update(content) {
    const first = this.next === null;
    this.next = content.slice(0, 1900);
    // The first update goes out immediately. Waiting a full tick to show the
    // first tool call wastes the most valuable moment in the turn — the point
    // where the member learns something is actually happening. Everything after
    // it rides the throttle, so this costs one extra edit per turn.
    if (first) void this.flush();
  }

  async flush() {
    if (this.next === null || this.next === this.rendered) return;
    const content = this.next;
    this.rendered = content;
    await this.message.edit(content).catch((error) => {
      log.warn("live_edit_failed", { error: error.message });
    });
  }

  async finish(content) {
    clearInterval(this.timer);
    this.next = content.slice(0, 2000);
    this.rendered = null; // force the last write through
    await this.flush();
  }
}

/** The in-progress view: tools as they fire, then prose as it arrives. */
function renderProgress(toolsSoFar, text) {
  const lines = toolsSoFar.map(
    (name) => `-# 🔧 \`${name.replace(/^.*__/, "")}\``,
  );
  if (text) {
    lines.push("");
    lines.push(text.length > 1500 ? `${text.slice(0, 1500)}…` : text);
  } else if (lines.length === 0) {
    lines.push("-# thinking…");
  }
  return lines.join("\n");
}

/**
 * Recent channel messages as conversation turns, oldest first. Cheap context —
 * no summarization, no durable memory. When it scrolls off, it is gone.
 *
 * Not every bot message is a turn. Trace footers, filed-feedback notes and the
 * "thinking…" placeholder all begin with Discord's small-text marker, and a
 * pinned message is a notice rather than an answer. Fed back as assistant
 * turns, the model was reading its own tool arguments and cost lines as
 * things it had said to the member.
 */
export function isConversational(message) {
  const content = message.cleanContent?.trim();
  if (!content) return false;
  if (message.pinned) return false;
  if (message.author?.bot && content.startsWith("-#")) return false;
  return true;
}

function asTurn(message) {
  const content = message.cleanContent.trim();
  return {
    role: message.author.bot ? "assistant" : "user",
    content: message.author.bot
      ? content
      : `${message.member?.displayName || message.author.username} (discord:${message.author.id}): ${content}`,
  };
}

/** A thread's history, oldest first: the message that started it, then what
 *  was said in it before this message. */
async function recentTurns(thread, upToId, turns) {
  const fetched = await thread.messages.fetch({
    // Each exchange is an answer plus a footer or two, so over-fetch and filter.
    limit: Math.min(100, turns * 4),
    before: upToId,
  });
  const history = [];
  // The starter lives in the parent channel, not in the thread's own messages.
  const starter = await thread.fetchStarterMessage?.().catch(() => null);
  if (starter && isConversational(starter)) history.push(asTurn(starter));
  for (const message of [...fetched.values()].reverse()) {
    if (!isConversational(message)) continue;
    if (starter && message.id === starter.id) continue;
    history.push(asTurn(message));
  }
  // The API requires the first turn to be a user turn.
  while (history.length && history[0].role !== "user") history.shift();
  return history.slice(-turns);
}

/**
 * `askFn` is injectable so the smoke test can drive this whole path without a
 * network call or a Discord connection. That seam exists because a refactor
 * once deleted LiveMessage and every static check still passed — a missing
 * symbol is a runtime ReferenceError, and nothing exercised this function.
 */
export async function handleAsk(message, routine, { askFn = ask } = {}) {
  const question = message.cleanContent.trim();
  if (!question) return;

  const lane = laneFor(routine);
  const blocked = spendBlock(lane);
  if (blocked) {
    // Members are not the operator and cannot fix this, so the reply says what
    // happened and when it changes, and nothing about configuration.
    await message.reply(
      blocked.reason === "daily_cap"
        ? "I've hit today's spend cap for this channel. It resets at midnight UTC."
        : "I've used up this channel's budget for the month. It resets on the 1st — ask your clan leader if you need it raised.",
    );
    log.warn("ask_over_budget", {
      routine: routine.key,
      lane,
      reason: blocked.reason,
      user: message.author.id,
    });
    return;
  }

  try {
    const inThread = Boolean(message.channel?.isThread?.());
    const history = inThread
      ? await recentTurns(message.channel, message.id, routine.historyTurns)
      : [];
    const asker = message.member?.displayName || message.author.username;

    // A new question opens a thread and is answered inside it; a follow-up is
    // already in one. If threads are not available, reply in place.
    const thread = inThread ? null : await threadFor(message);
    const target = thread ?? message.channel;
    const placeholder = thread
      ? await thread.send("-# thinking…")
      : await message.reply("-# thinking…");
    const live = new LiveMessage(placeholder);
    const toolsSoFar = [];
    let streamed = "";

    const result = await askFn({
      system: systemFor(routine, { includePrompt: true }),
      model: routine.model,
      effort: routine.effort,
      routineKey: routine.key,
      lane,
      messages: [
        ...history,
        {
          role: "user",
          // The id rides here rather than in the system block: the system
          // prompt is the cached prefix, and rewriting it per asker would
          // discard that cache on every single turn.
          content: `${asker} (discord:${message.author.id}): ${question}`,
        },
      ],
      onEvent: (event) => {
        if (event.kind === "tool_start") toolsSoFar.push(event.name);
        else if (event.kind === "text") streamed += event.text;
        live.update(renderProgress(toolsSoFar, streamed));
      },
    });

    clearInterval(live.timer);

    if (!result.ok) {
      await live.finish(
        result.error === "refusal"
          ? "I'm not able to answer that one."
          : `Something broke on my side talking to Elixir MCP: \`${result.error}\`. There's no local fallback here by design, so that's the whole answer.`,
      );
      log.error("ask_failed", { routine: routine.key, error: result.error });
      return;
    }

    const answer = result.text || "I got nothing back for that.";
    const friction = detectFriction({
      text: answer,
      called: result.called,
      errors: result.errors,
    });

    // The live message becomes the answer, so the reply the member is already
    // watching turns into the final text rather than being orphaned above it.
    const parts = chunk(answer, routine.maxChars);
    await live.finish(parts[0]);
    const produced = [placeholder];
    let sent = placeholder;
    for (const part of parts.slice(1)) {
      sent = await target.send(part);
      produced.push(sent);
    }

    const footnote = async (content, what) => {
      if (!sent || !content) return;
      const note = await sent
        .reply({ content, allowedMentions: { repliedUser: false } })
        .catch((error) => {
          log.warn(`${what}_post_failed`, { error: error.message });
          return null;
        });
      produced.push(note);
    };
    if (routine.trace) await footnote(renderTrace(result), "trace");
    else await footnote(errorFooter(result), "error_footer");
    const ungrounded = looksUngrounded({ text: answer, called: result.called });
    if (ungrounded) await footnote(UNGROUNDED_FOOTER, "ungrounded_footer");

    state.rememberTurn(
      result.turnId,
      turnRecord({ routine, lane, question, text: answer, result, channelId: target?.id }),
      produced.map((m) => m?.id),
    );

    log.info("ask_answered", {
      routine: routine.key,
      turnId: result.turnId,
      user: message.author.id,
      thread: thread ? "new" : inThread ? "follow-up" : "none",
      tools: result.called.length,
      toolNames: result.called.join(","),
      usd: result.usd.toFixed(4),
      cache: result.usage ? `${Math.round(cacheShare(result.usage) * 100)}%` : undefined,
      ms: result.ms,
      rounds: result.rounds,
      stopReason: result.stopReason,
      truncated: result.truncated || undefined,
      ungrounded: ungrounded || undefined,
      friction: friction?.reason,
    });

    if (friction) {
      const summary = await sweepFriction({ question, answer, friction, lane });
      if (summary && sent) {
        await sent.reply({
          content: `-# 📮 Filed with Elixir MCP: ${summary}`,
          allowedMentions: { repliedUser: false },
        });
      }
    }
  } catch (error) {
    log.error("ask_crashed", {
      error: error.message,
      stack: error.stack?.slice(0, 400),
    });
    await message
      .reply("I fell over answering that. It's logged.")
      .catch(() => {});
  }
}
