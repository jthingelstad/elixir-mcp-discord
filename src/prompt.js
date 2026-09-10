/**
 * Building a system prompt out of three layers, from least to most editable:
 *
 *   1. MECHANICS (this file). Facts about the runtime a prompt cannot be
 *      allowed to get wrong: Discord's formatting limits, how to decline to
 *      post, what "on_behalf_of" is, that every number must come from a tool
 *      call in this turn. These are properties of the client and the service,
 *      not opinions about a clan, so they live in code and are not editable.
 *   2. IDENTITY (agent/identity.md). Voice, house rules, what the channels are
 *      for, what this agent will not do. The operator's file, and the one they
 *      should actually spend time on.
 *   3. THE ROUTINE (agent/routines/*.md). The task itself.
 *
 * NOTHING HERE NAMES A CLAN. It cannot: the agent key already knows which clan
 * it acts for, and Elixir MCP puts that in its opening instructions along with
 * the standing invitation to omit clan_tag. A prompt that repeated the tag
 * would teach the model to pass it explicitly — undoing the one thing the
 * agent door is for — and would be wrong the day the key is repointed.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { FEEDBACK_PROMPT } from "./feedback.js";
import { log } from "./log.js";
import * as state from "./state.js";

const GROUNDING = `Your ONLY source of information is the Elixir MCP server. You have no local
database, no memory of previous days, and no direct access to the Clash Royale
API.

Every number you state must come from a tool call in THIS turn. Never guess,
never fill a gap from general Clash Royale knowledge, and never present a
recalled figure as recorded data. If Elixir MCP cannot answer, say so plainly
and say what you tried — there is no fallback here on purpose.

Recording has a start date and coverage is uneven. When a number could mislead
because of that, check elixir_coverage or say so. "No recorded battles" is not
"did not play".

You act for a clan: omit clan_tag and it means yours. Your opening instructions
name it. Pull clans_roster once if you need the roster; it is not in your
instructions because it changes daily.`;

const DISCORD_FORMAT = `You are writing a Discord message.

NEVER use a markdown table — Discord renders one as literal pipe characters.
Use one short line per row instead, like "**De stichting** — 0 fame". Prefer
bold labels and compact lists over paragraphs whenever you present numbers.
Never paste raw JSON. At most one emoji, usually zero.

Do not open with a greeting or close with a sign-off. Start with the news.`;

const QUOTA = `Prefer recorded data. A live read goes out to the collector fleet and draws on a
daily quota shared with every other consumer — spend one only when a fresh read
genuinely changes the answer, and never more than once per post.

When it does, ask the recorded tool for it: players_profile, clans_roster,
war_current and battles_query each take live: true and answer in their normal
shape. live_fetch is the raw catch-all for an endpoint none of them cover and
should be rare; it refuses /players/{tag}/battlelog (use battles_query with
live: true instead).`;

const SKIP = `SILENCE IS A VALID OUTPUT. If there is genuinely nothing worth posting, reply
with SKIP on a line by itself and nothing else. A quiet day is allowed to be
quiet, and a channel that manufactures content on one teaches people to mute
it. Do not pad.`;

const WHO_IS_ASKING = `Each message names its author and their id from this surface, like
"Raquaza (discord:12345): how am I doing?". When a question is about the person
asking — "my stats", "how am I playing", "my deck" — pass that id as
on_behalf_of and OMIT player_tag. The server remembers who they are.

The first time someone asks, it will not know them yet and will say so. Ask
which player in the clan they are, then call elixir_identify once with their id
and tag. From then on it is remembered, for them and for everyone who asks
later. Never guess who somebody is from their display name.

You do not otherwise know who anyone here is, and you have no local nickname
table. Asking for a tag is the honest answer, not a failure.`;

const RECALL_HEADER = `ALREADY POSTED IN THIS CHANNEL RECENTLY. Do not repeat these, and do not
re-report the same players or the same angle unless something genuinely
changed. If everything you would say is already here, that is a reason to
skip.`;

/** The operator's file. Missing is legal — the defaults above are a working
 *  agent — but it is the file that makes this bot theirs, so say so once. */
export function readIdentity({ dir = config.agentDir } = {}) {
  const file = path.join(dir, "identity.md");
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text || null;
  } catch {
    log.warn("identity_missing", { file });
    return null;
  }
}

/**
 * The clan this key acts for, named from the SERVER's own principal block
 * rather than from configuration.
 *
 * This is not the CLAN_TAG that used to sit in .env. Nobody types it, nothing
 * can disagree with the key, and repointing the key repoints this. It is the
 * connection describing itself, recorded at boot — context for the model, not
 * an instruction to pass the tag. Omitting clan_tag resolves server-side.
 */
export function subjectBlock(principal = state.get("principal")) {
  const subject = principal?.subject;
  if (principal?.kind !== "agent" || !subject?.tag) return null;
  const name = [subject.name, subject.tag].filter(Boolean).join(" ");
  return `YOUR SUBJECT

You act for ${name}${subject.members ? ` (${subject.members} members at last connect)` : ""}.
That is what your key is for; the server reported it when you connected. Omit
clan_tag and it means this clan.`;
}

export function systemFor(routine, { identity = readIdentity(), includePrompt = false, subject = subjectBlock() } = {}) {
  const blocks = [GROUNDING, DISCORD_FORMAT];
  if (subject) blocks.push(subject);
  if (routine.trigger === "message") blocks.push(WHO_IS_ASKING);
  blocks.push(QUOTA);
  if (routine.maySkip) blocks.push(SKIP);
  if (identity) blocks.push(`HOUSE RULES\n\n${identity}`);
  // A message routine's own prompt is a standing brief for the channel, so it
  // belongs in the system block where prompt caching keeps it: the per-message
  // user turn is the only thing that should change between calls.
  if (includePrompt) blocks.push(`THIS CHANNEL\n\n${routine.prompt}`);
  blocks.push(FEEDBACK_PROMPT);
  return blocks.join("\n\n");
}

/** The routine's own prompt, plus whatever its trigger handed it. */
export function userMessageFor(routine, { events, recent } = {}) {
  const parts = [routine.prompt];
  if (events?.length) {
    parts.push(
      `EVENTS FROM THE ELIXIR MCP FEED — these are nods, not reports. Drill with the tools where it earns its place.\n\n${JSON.stringify(events, null, 2)}`,
    );
  }
  if (recent?.length) {
    parts.push(`${RECALL_HEADER}\n\n${recent.map((text) => `--- ${text}`).join("\n\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Did the model decline to post?
 *
 * Anchoring on the start of the response was wrong: told to "reply with
 * exactly SKIP", the model sometimes explains its reasoning first and puts
 * SKIP on its own line at the end. That parses as a normal answer, and the
 * channel gets "period.kind is training, not a war day" as though it were the
 * post. Accept SKIP as any line of its own.
 */
export function isSkip(text) {
  const lines = (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 0 || lines.some((line) => /^SKIP[.!]?$/i.test(line));
}
