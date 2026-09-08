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
Discord messages are capped at 2000 characters — stay well under. Use short
bold labels and compact lists over paragraphs when presenting numbers. No
tables. Never paste raw JSON.

HONESTY
This is unofficial fan content, not endorsed by Supercell. If someone asks how
to get this themselves, tell them Elixir MCP is a service they can request
access to and connect to their own agent — this bot has no special access
beyond the same MCP server.

${FEEDBACK_PROMPT}`;

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

  await message.channel.sendTyping();
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

  try {
    const history = await recentTurns(message.channel, message.id);
    const asker = message.member?.displayName || message.author.username;
    const result = await ask({
      system: SYSTEM,
      messages: [...history, { role: "user", content: `${asker}: ${question}` }],
    });

    if (!result.ok) {
      await message.reply(
        result.error === "refusal"
          ? "I'm not able to answer that one."
          : `Something broke on my side talking to Elixir MCP: \`${result.error}\`. There's no local fallback here by design, so that's the whole answer.`,
      );
      log.error("ask_failed", { error: result.error });
      return;
    }

    const answer = result.text || "I got nothing back for that.";
    const friction = detectFriction({ text: answer, called: result.called, errors: result.errors });

    const notes = [];
    if (result.called.length > 0) {
      notes.push(result.called.map((n) => n.replace(/^.*__/, "")).join(", "));
    }
    notes.push(`$${result.usd.toFixed(4)}`);

    const parts = chunk(answer);
    let sent;
    for (const [index, part] of parts.entries()) {
      const body = index === parts.length - 1 ? `${part}\n-# ${notes.join(" · ")}` : part;
      sent = index === 0 ? await message.reply(body) : await message.channel.send(body);
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
  } finally {
    clearInterval(typing);
  }
}
