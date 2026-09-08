/**
 * The ask lane — a member asks, the agent answers, using nothing but Elixir MCP.
 *
 * The voice here is deliberately plain. This channel exists so people can feel
 * what Elixir MCP is like behind an agent, and a strong persona would have them
 * comparing writing styles instead. What they should be comparing is whether
 * the answers are right, fast, and complete.
 *
 * It also does not know who anyone is. A member's own agent knows them because
 * they added their own player; this bot has no such link, and faking one with a
 * local nickname table would make the demo promise something a real user cannot
 * reproduce. So it asks for a tag, the way the real thing would.
 */

import { config } from "./config.js";
import { ask, overDailyCap } from "./claude.js";
import { detectFriction, sweepFriction, FEEDBACK_PROMPT } from "./feedback.js";
import { log } from "./log.js";

const DISCORD_LIMIT = 2000;

const SYSTEM = `You are a Clash Royale clan assistant whose ONLY source of information is the
Elixir MCP server. You are running in a Discord channel as a public
demonstration of what Elixir MCP can do.

WHAT YOU HAVE
Every tool you can call comes from Elixir MCP. You have no local database, no
memory of previous days, no roster list, and no access to the Clash Royale API
directly. Elixir MCP records battles, player timelines, war seasons, clan
rosters, deck and card statistics, and a multi-clan corpus you can search.

WHAT THAT MEANS IN PRACTICE
- If Elixir MCP cannot answer something, say so plainly and say what you tried.
  Never guess a number, never reconstruct a fact from general Clash Royale
  knowledge, and never present a recalled figure as recorded data.
- You do not know who anyone in this Discord is. If a member asks about
  "my" stats, ask for their player tag or in-game name and look it up with
  players_search. Do not assume.
- Recording has a start date and coverage is not uniform. When a number could
  be misread because of that, check elixir_coverage or say so. "No recorded
  battles" is not the same as "did not play".
- The corpus is not limited to this clan. Scouting other clans and players is a
  real capability — use it when someone asks.
- The home clan for this channel is ${config.clanTag}. Use it when someone says
  "the clan" or "us" without naming one.

VOICE
Plain and direct. No persona, no lore, no nicknames, no roleplay. Short answers
by default; go long only when the question earns it. At most one emoji, and
usually zero. Lead with the answer, then the supporting numbers. Say "I don't
know" in three words rather than thirty.

FORMAT
Discord messages are capped at 2000 characters — stay well under.

NEVER use a markdown table. Discord does not render them; a table arrives as
literal pipe characters and is unreadable. For anything you would tabulate, use
one short line per row instead, like "**De stichting** — 0 fame". Bold labels
and compact lists over paragraphs whenever you present numbers. Never paste raw
JSON.

HONESTY
This is unofficial fan content, not endorsed by Supercell. If someone asks how
to get this themselves, tell them Elixir MCP is a service they can request
access to and connect to their own agent — this bot has no special access
beyond the same MCP server.

${FEEDBACK_PROMPT}`;

/**
 * Renders the turn's reasoning and tool calls for the channel.
 *
 * Jamie asked for this and it is more than a debug view: in a channel whose
 * entire purpose is showing what Elixir MCP is like, the tool names and the
 * arguments ARE the demonstration. A member who sees `war_current` called with
 * their clan tag learns something a polished answer hides. It also makes a
 * wrong answer diagnosable by whoever noticed it, rather than only by whoever
 * reads the logs.
 */
function renderTrace(trace, usd) {
  if (!trace || trace.length === 0) return null;
  const lines = [];

  for (const step of trace) {
    if (step.kind === "thought") {
      lines.push(`> 💭 ${step.text.replace(/\s+/g, " ").slice(0, 400)}`);
    } else if (step.kind === "tool") {
      let args = "";
      try {
        args = JSON.stringify(step.input ?? {});
      } catch {
        args = "{}";
      }
      if (args.length > 180) args = `${args.slice(0, 177)}…`;
      const name = step.name.replace(/^.*__/, "");
      lines.push(`> 🔧 \`${name}\` \`${args}\``);
    } else if (step.kind === "error") {
      lines.push(`> ⚠️ \`${step.name.replace(/^.*__/, "")}\` failed: ${step.detail.slice(0, 200)}`);
    }
  }

  let body = lines.join("\n");
  if (body.length > 1700) body = `${body.slice(0, 1700)}\n> …`;
  return `-# **How I got there** · $${usd.toFixed(4)}\n${body}`;
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
    this.next = content.slice(0, 1900);
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
  const lines = toolsSoFar.map((name) => `-# 🔧 \`${name.replace(/^.*__/, "")}\``);
  if (text) {
    lines.push("");
    lines.push(text.length > 1500 ? `${text.slice(0, 1500)}…` : text);
  } else if (lines.length === 0) {
    lines.push("-# thinking…");
  }
  return lines.join("\n");
}

function chunk(text) {
  const parts = [];
  let rest = text;
  while (rest.length > DISCORD_LIMIT) {
    let cut = rest.lastIndexOf("\n", DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT * 0.5) cut = DISCORD_LIMIT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Recent channel messages as conversation turns, oldest first. Cheap context —
 *  no summarization, no durable memory. When it scrolls off, it is gone. */
async function recentTurns(channel, upToId) {
  const fetched = await channel.messages.fetch({ limit: config.askHistoryTurns * 2, before: upToId });
  const turns = [];
  for (const message of [...fetched.values()].reverse()) {
    const content = message.cleanContent?.trim();
    if (!content) continue;
    turns.push({
      role: message.author.bot ? "assistant" : "user",
      content: message.author.bot ? content : `${message.member?.displayName || message.author.username}: ${content}`,
    });
  }
  // The API requires the first turn to be a user turn.
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns.slice(-config.askHistoryTurns);
}

export async function handleAsk(message) {
  const question = message.cleanContent.trim();
  if (!question) return;

  if (overDailyCap()) {
    await message.reply(
      "I've hit the daily spend cap for this test channel. Resets at midnight UTC.",
    );
    log.warn("ask_over_cap", { user: message.author.id });
    return;
  }

  try {
    const history = await recentTurns(message.channel, message.id);
    const asker = message.member?.displayName || message.author.username;

    const placeholder = await message.reply("-# thinking…");
    const live = new LiveMessage(placeholder);
    const toolsSoFar = [];
    let streamed = "";

    const result = await ask({
      system: SYSTEM,
      messages: [...history, { role: "user", content: `${asker}: ${question}` }],
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
      log.error("ask_failed", { error: result.error });
      return;
    }

    const answer = result.text || "I got nothing back for that.";
    const friction = detectFriction({ text: answer, called: result.called, errors: result.errors });

    // The live message becomes the answer, so the reply the member is already
    // watching turns into the final text rather than being orphaned above it.
    const parts = chunk(answer);
    await live.finish(parts[0]);
    let sent = placeholder;
    for (const part of parts.slice(1)) {
      sent = await message.channel.send(part);
    }

    const trace = renderTrace(result.trace, result.usd);
    if (trace && sent) {
      await sent
        .reply({ content: trace, allowedMentions: { repliedUser: false } })
        .catch((error) => log.warn("trace_post_failed", { error: error.message }));
    }

    log.info("ask_answered", {
      user: message.author.id,
      tools: result.called.length,
      usd: result.usd.toFixed(4),
      friction: friction?.reason,
    });

    if (friction) {
      const summary = await sweepFriction({ question, answer, friction });
      if (summary && sent) {
        await sent.reply({
          content: `-# 📮 Filed with Elixir MCP: ${summary}`,
          allowedMentions: { repliedUser: false },
        });
      }
    }
  } catch (error) {
    log.error("ask_crashed", { error: error.message, stack: error.stack?.slice(0, 400) });
    await message.reply("I fell over answering that. It's logged.").catch(() => {});
  }
}
