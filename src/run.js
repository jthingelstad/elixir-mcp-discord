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

import { ask, spendBlock, cacheShare } from "./claude.js";
import { laneFor } from "./budget.js";
import { detectFriction, sweepFriction, looksUngrounded } from "./feedback.js";
import { systemFor, userMessageFor, isSkip, notDelivered } from "./prompt.js";
import { post, recentPosts } from "./post.js";
import { renderTrace, errorFooter, UNGROUNDED_FOOTER } from "./trace.js";
import { directory, resolveById } from "./directory.js";
import { config } from "./config.js";
import { track, isStopping } from "./inflight.js";
import { log } from "./log.js";
import * as state from "./state.js";
import * as ledger from "./ledger.js";
import { notify } from "./notify.js";

/**
 * THE POST TOOL. A scheduled or event turn posts by calling `post_message`
 * with a channel from the directory in its system block (src/directory.js);
 * the model chooses the channel the way it chooses a data tool, from the
 * description. The handler is the rule-keeper: the channel must be in the
 * directory and not an ask channel, the turn may not exceed the cap, and a
 * dry run records what would have been posted without touching Discord.
 *
 * NOT offered to the ask lane. Its input is other people's words, and "post
 * this in #announcements" must stay a request, not an instruction.
 */
export const POST_TOOL = {
  name: "post_message",
  description:
    "Post a message to one of the channels listed under CHANNELS YOU MAY POST IN. Choose the channel whose name and topic fit what you are posting; the routine may name a default. Markdown as Discord renders it. Call it once per post; making no call is how you post nothing.",
  input_schema: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The channel_id from the directory." },
      content: { type: "string", description: "The message, Discord markdown, up to the routine's length limit." },
    },
    required: ["channel_id", "content"],
    additionalProperties: false,
  },
};

function postTool({ routine, entries, dryRun, posts, resolve = resolveById }) {
  return {
    ...POST_TOOL,
    async handler({ channel_id, content }) {
      const entry = entries.find((e) => e.id === String(channel_id));
      if (!entry) {
        return {
          ok: false,
          code: "unknown_channel",
          error: `channel_id ${channel_id} is not in the directory; use one listed under CHANNELS YOU MAY POST IN`,
        };
      }
      if (entry.role === "ask") {
        return {
          ok: false,
          code: "ask_channel",
          error: `#${entry.name} is where members ask questions; routine output does not go there`,
        };
      }
      if (entry.role === "read") {
        return {
          ok: false,
          code: "read_only",
          error: `#${entry.name} was opened to this bot to read, not to post in`,
        };
      }
      if (posts.length >= config.maxPostsPerTurn) {
        return {
          ok: false,
          code: "post_cap",
          error: `this turn has already posted ${posts.length} times; that is the cap`,
        };
      }
      const text = String(content ?? "").trim();
      if (!text) return { ok: false, code: "empty", error: "content is empty" };
      const record = { channelId: entry.id, channelName: entry.name, text, messages: [] };
      posts.push(record);
      if (dryRun) return { ok: true, body: { posted: true, channel: `#${entry.name}`, dry_run: true } };
      const channel = await resolve(entry.id);
      if (!channel) {
        posts.pop();
        return { ok: false, code: "unresolvable", error: `#${entry.name} could not be fetched` };
      }
      record.messages = await post(channel, text, routine.maxChars);
      record.channel = channel;
      return {
        ok: true,
        body: { posted: true, channel: `#${entry.name}`, message_id: record.messages.at(-1)?.id ?? null },
      };
    },
  };
}

/**
 * READ THE ROOM. A scheduled post knew the bot's own last posts (recall)
 * and nothing about what the humans said in the channel in the last hour,
 * so the movers post could repeat what a member had just celebrated and
 * the war-deck nudge could land under "everyone's done". The last few
 * messages in a directory channel, on request, before posting there. The
 * words enter this turn only (and its ledger record, as every tool result
 * does); nothing is kept.
 */
export const ROOM_TOOL = {
  name: "recent_channel_messages",
  description:
    "What people said in one of the channels you may post in or read, recently — newest last, humans and bots, the last two hours. Read the room before posting there: do not repeat what it already knows, add what the record adds, or post nothing.",
  input_schema: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "A channel_id from the directory." },
      limit: { type: "integer", minimum: 1, maximum: 30, description: "How many messages, default 15." },
    },
    required: ["channel_id"],
    additionalProperties: false,
  },
};

const ROOM_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * STUDY A CHANNEL. The room tool answers "what was just said here" before a
 * post; the operator's console needs "what has been said here" - the
 * clan's older bot posts in #elixir, and the operator wants this bot to
 * read a month of that and say whether it could do the same. Any directory
 * channel, read-only ones included; up to a hundred messages a page, whole
 * text, paged backwards by message id. DM lane only: the operator is the
 * one reader, and a member's question never earns a walk through another
 * channel.
 */
export const STUDY_TOOL = {
  name: "read_channel",
  description:
    "Read a channel you may post in or read, as far back as you like: newest last, humans and bots, whole messages, up to 100 a page. Pass before to page further back. Use it to study what is posted somewhere (another bot's output, a channel's habits) before proposing what you would do there.",
  input_schema: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "A channel_id from the directory (list_channels)." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many messages, default 50." },
      before: {
        type: "string",
        description: "A message_id from an earlier page: the page ending just before it.",
      },
    },
    required: ["channel_id"],
    additionalProperties: false,
  },
};

export function studyTool({ entries, resolve = resolveById }) {
  return {
    ...STUDY_TOOL,
    async handler({ channel_id, limit, before }) {
      const entry = entries.find((e) => e.id === String(channel_id));
      if (!entry)
        return { ok: false, code: "unknown_channel", error: `channel_id ${channel_id} is not in the directory` };
      const channel = await resolve(entry.id);
      if (!channel?.messages?.fetch)
        return { ok: false, code: "unresolvable", error: `#${entry.name} could not be read` };
      let fetched;
      try {
        fetched = await channel.messages.fetch({
          limit: Math.min(100, limit || 50),
          ...(before ? { before: String(before) } : {}),
        });
      } catch (error) {
        return { ok: false, code: "unreadable", error: error.message };
      }
      const messages = [...fetched.values()]
        .filter((m) => (m.cleanContent || "").trim() || m.embeds?.length)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => ({
          message_id: m.id,
          at: new Date(m.createdTimestamp).toISOString(),
          who: m.author?.bot ? `${m.author.username} (bot)` : m.member?.displayName || m.author?.username || "someone",
          text: String(m.cleanContent || "").slice(0, 4000),
          ...(m.embeds?.length
            ? {
                embeds: m.embeds.slice(0, 5).map((e) => ({
                  title: e.title ?? null,
                  description: e.description ? String(e.description).slice(0, 2000) : null,
                })),
              }
            : {}),
        }));
      return {
        ok: true,
        body: {
          channel: `#${entry.name}`,
          messages,
          oldest_message_id: messages[0]?.message_id ?? null,
          note: messages.length
            ? "Oldest first. Pass oldest_message_id as before for the page behind it."
            : "Nothing further back.",
        },
      };
    },
  };
}

export function roomTool({ entries, resolve = resolveById, now = () => Date.now() }) {
  return {
    ...ROOM_TOOL,
    async handler({ channel_id, limit }) {
      const entry = entries.find((e) => e.id === String(channel_id));
      if (!entry)
        return { ok: false, code: "unknown_channel", error: `channel_id ${channel_id} is not in the directory` };
      const channel = await resolve(entry.id);
      if (!channel?.messages?.fetch)
        return { ok: false, code: "unresolvable", error: `#${entry.name} could not be read` };
      let fetched;
      try {
        fetched = await channel.messages.fetch({ limit: Math.min(30, limit || 15) });
      } catch (error) {
        return { ok: false, code: "unreadable", error: error.message };
      }
      const since = now() - ROOM_WINDOW_MS;
      const messages = [...fetched.values()]
        .filter((m) => (m.createdTimestamp ?? 0) >= since && (m.cleanContent || "").trim())
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => ({
          at: new Date(m.createdTimestamp).toISOString(),
          who: m.author?.bot ? `${m.author.username} (bot)` : m.member?.displayName || m.author?.username || "someone",
          text: String(m.cleanContent).slice(0, 300),
        }));
      return {
        ok: true,
        body: {
          channel: `#${entry.name}`,
          messages,
          note: messages.length
            ? "What the room already knows. Add to it or stay quiet; do not restate it."
            : "Quiet for two hours.",
        },
      };
    },
  };
}

/** Reply under the last message of a post without pinging anyone; a failure
 *  to attach a footer must never undo the post. */
async function footnote(last, content, what) {
  if (!last || !content) return null;
  return last.reply({ content, allowedMentions: { repliedUser: false } }).catch((error) => {
    log.warn(`${what}_post_failed`, { error: error.message });
    return null;
  });
}

/** What a reaction sweep needs to know about a turn, kept small. */
export function turnRecord({ routine, lane, question, text, result, channelId }) {
  const requestIds = [
    ...(result.envelopes || []).map((e) => e.request_id),
    ...(result.errors || []).map((e) => e.requestId),
  ].filter(Boolean);
  return {
    routine: routine.key,
    lane,
    question: String(question || "").slice(0, 700),
    answer: String(text || "").slice(0, 1200),
    called: result.called || [],
    errors: (result.errors || []).map((e) => ({
      name: e.name,
      code: e.code,
      detail: String(e.detail || "").slice(0, 200),
    })),
    requestIds: [...new Set(requestIds)].slice(0, 12),
    channelId: channelId || null,
    at: new Date().toISOString(),
  };
}

/**
 * @param {object} routine  parsed routine
 * @param {object} options.channel   the routine's DEFAULT Discord channel (its
 *   `channel:` binding), or null; with a directory the model may post elsewhere
 * @param {Array}  options.events    feed entries, for an event-triggered run
 * @param {boolean} options.dryRun   compose and return, post nothing
 * @param {Function} options.askFn   injectable model call, for tests
 * @param {Array}  options.entries   the channel directory (default: live)
 * @param {object} options.overrides { identity, memory } text to run on instead of the files
 * @param {string} options.lane      which budget pays (default: the routine's own)
 */
export async function runRoutine(routine, options = {}) {
  if (isStopping()) return { ok: false, error: "shutting_down" };
  return track(() => runRoutineNow(routine, options));
}

/**
 * Is this reply a finished turn? A routine turn with the post tool is done when
 * it posted or declined; prose with neither is a post that was never delivered,
 * and the answer is to ask once more (src/claude.js `nudge`), not to drop $0.10
 * of tool calls on the floor. Null accepts the reply.
 */
export function deliveryNudge(routine, { text, posts }) {
  if (posts.length > 0) return null;
  const reply = (text || "").trim();
  if (!reply) return null;
  if (routine.maySkip && isSkip(reply)) return null;
  return notDelivered(routine);
}

async function runRoutineNow(
  routine,
  {
    channel = null,
    events = null,
    dryRun = false,
    askFn = ask,
    entries = directory(),
    resolve = resolveById,
    overrides = {},
    lane = laneFor(routine),
  } = {},
) {
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
    if (!dryRun)
      await notify(
        "budget",
        `${routine.key} did not run: the ${lane} lane is at $${blocked.spent?.toFixed(2) ?? "?"} of $${blocked.budget?.toFixed(2) ?? "?"} this month (${blocked.reason}). It resets on the 1st.`,
        { fingerprint: `budget:${lane}:${blocked.reason}`, every: 24 * 3600 * 1000 },
      );
    return { ok: false, error: `budget:${blocked.reason}` };
  }

  // What THIS routine said last, from its own ledger. The channel is the
  // fallback for a routine that has never posted since the ledger existed —
  // and a rough one: in a shared channel it hands back other routines' posts.
  let recent = routine.recall ? state.recentOwnPosts(routine.key, routine.recall) : [];
  if (recent.length === 0 && channel && routine.recall) {
    recent = await recentPosts(channel, routine.recall);
  }
  // The directory the model sees. The ask lane never gets it (src/ask.js has
  // its own path); a routine whose bound channel is not in the directory
  // still gets that channel as its default, so a legacy binding keeps working.
  const posts = [];
  const directoryEntries = routine.trigger === "message" ? [] : entries;
  const withTool = directoryEntries.length > 0;
  // The silence clock, for the channels this turn could post in. A dry run
  // reads it (a rehearsal should see what the real run sees) but the first
  // sighting it anchors is harmless: the same anchor the real run would set.
  const silence =
    withTool && routine.maySkip
      ? state.silence(directoryEntries.filter((e) => e.role !== "ask" && e.role !== "read"))
      : null;
  // `overrides` (identity, memory) let a rehearsal run on a PROPOSED file
  // before it is applied — src/review.js "Try it".
  const system = systemFor(routine, { entries: directoryEntries, defaultChannelId: channel?.id ?? null, ...overrides });
  // The ledger's view of what this turn was handed. A dry run is a rehearsal
  // and is not recorded: the ledger is what Discord actually saw.
  const record = (output) => {
    if (dryRun) return;
    ledger.append(
      ledger.turnEntry({
        routine,
        lane,
        result,
        system,
        contractVersion: state.get("contractVersion"),
        input: {
          kind: routine.trigger,
          brief: routine.prompt,
          events: events ?? undefined,
          recent,
          silence: silence?.map((s) => ({ channel: `#${s.name}`, hours: Math.round(s.hours), atLeast: s.atLeast })),
          defaultChannelId: channel?.id ?? null,
        },
        output,
      }),
    );
  };
  const result = await askFn({
    system,
    messages: [{ role: "user", content: userMessageFor(routine, { events, recent, withTool, silence }) }],
    maxTokens: routine.maxTokens,
    model: routine.model,
    effort: routine.effort,
    routineKey: routine.key,
    lane,
    localTools: withTool
      ? [
          postTool({ routine, entries: directoryEntries, dryRun: dryRun || false, posts, resolve }),
          roomTool({ entries: directoryEntries, resolve }),
        ]
      : [],
    nudge: withTool ? ({ text }) => deliveryNudge(routine, { text, posts }) : null,
  });

  if (!result.ok) {
    log.error("routine_failed", { routine: routine.key, error: result.error });
    record({ error: result.error });
    if (!dryRun)
      await notify("routine failed", `${routine.key}: ${String(result.error).slice(0, 300)}`, {
        fingerprint: `routine_failed:${routine.key}`,
      });
    return { ok: false, error: result.error };
  }

  const text = (result.text || "").trim();
  // Three ways a turn ends. It posted through the tool: those posts are the
  // output and trailing prose is not. It posted nothing and replied SKIP (or
  // nothing): it declined. It posted nothing and replied prose: that prose
  // goes to the routine's default channel — the pre-directory behaviour, and
  // what a routine with no directory still does. A routine that may NOT skip
  // and answered SKIP anyway is a prompt bug, and posting the word SKIP into
  // a channel is how you find out about it.
  const skipped = posts.length === 0 && routine.maySkip && isSkip(text);
  const textPost = posts.length === 0 && !skipped && text ? text : null;

  if (dryRun) {
    return {
      ok: true,
      skipped,
      text,
      posts: posts.map(({ channelName, text: t }) => ({ channel: `#${channelName}`, text: t })),
      result,
    };
  }

  if (skipped) {
    log.info("routine_skipped", {
      routine: routine.key,
      usd: result.usd.toFixed(4),
    });
    record({ text, posts: [], skipped: true });
    return { ok: true, skipped: true, text, posts: [], result };
  }

  if (textPost) {
    if (!channel) {
      // Prose with nowhere to go: the routine has no default and the model
      // did not call the tool. Loud, because the turn was paid for.
      log.error("post_without_destination", {
        routine: routine.key,
        turnId: result.turnId,
        hint: withTool
          ? "the model replied in prose instead of calling post_message, even when nudged, and the routine names no channel:"
          : "the routine names no channel: and there is no directory",
        chars: text.length,
      });
      record({ text, posts: [], error: "no_destination" });
      await notify(
        "routine had nowhere to post",
        `${routine.key} wrote ${text.length} characters but called no post tool${result.nudged ? " (even after a second ask)" : ""} and names no channel; the turn was paid for and nothing was posted.`,
        { fingerprint: `no_destination:${routine.key}` },
      );
      return { ok: false, error: "no_destination", text, result };
    }
    const messages = await post(channel, textPost, routine.maxChars);
    posts.push({ channelId: channel.id, channelName: channel.name ?? channel.id, text: textPost, messages, channel });
  } else if (text && posts.length > 0) {
    log.info("prose_after_posts", { routine: routine.key, turnId: result.turnId, chars: text.length });
  }

  const sent = posts.flatMap((p) => p.messages);
  const last = sent.at(-1) ?? null;
  for (const p of posts) {
    state.rememberPost(
      routine.key,
      posts.length > 1 || p.channelId !== channel?.id ? `[#${p.channelName}] ${p.text}` : p.text,
    );
    state.rememberPostAt(p.channelId, { name: p.channelName, routine: routine.key });
  }
  const notes = [];
  const footers = [];
  const attach = async (content, what) => {
    if (content) footers.push(content);
    notes.push(await footnote(last, content, what));
  };
  if (routine.trace) {
    await attach(renderTrace(result, { label: routine.key }), "trace");
  } else {
    // No trace, but a reader still gets the two caveats that change whether
    // the numbers above can be trusted.
    await attach(errorFooter(result), "error_footer");
  }
  const posted = posts.map((p) => p.text).join("\n\n");
  const ungrounded = looksUngrounded({
    text: posted,
    called: result.called.filter((n) => n !== POST_TOOL.name),
    events,
  });
  if (ungrounded) {
    log.warn("routine_ungrounded", { routine: routine.key, turnId: result.turnId });
    await attach(UNGROUNDED_FOOTER, "ungrounded_footer");
  }
  // Every message this turn produced points back at the turn, so a reaction
  // on any of them — the post, its footer — finds the same record.
  state.rememberTurn(
    result.turnId,
    turnRecord({
      routine,
      lane,
      question: routine.prompt,
      text: posted,
      result,
      channelId: posts.at(-1)?.channelId ?? null,
    }),
    [...sent, ...notes].map((m) => m?.id),
  );

  log.info("routine_posted", {
    routine: routine.key,
    turnId: result.turnId,
    posts: posts.length,
    channels: posts.map((p) => `#${p.channelName}`).join(","),
    tools: result.called.length,
    toolNames: result.called.join(","),
    usd: result.usd.toFixed(4),
    cache: result.usage ? `${Math.round(cacheShare(result.usage) * 100)}%` : undefined,
    ms: result.ms,
    chars: posted.length,
  });

  // Friction filing is not an ask-lane feature. A scheduled report that could
  // not get what it needed is the most useful thing this bot produces, and it
  // used to evaporate because nobody was in the channel to notice.
  const friction = detectFriction({
    text: posted,
    called: result.called,
    errors: result.errors,
  });
  record({
    text: posted,
    posts: posts.map((p) => ({
      channelId: p.channelId,
      channelName: p.channelName,
      messageIds: p.messages.map((m) => m?.id).filter(Boolean),
      text: p.text,
    })),
    skipped: false,
    footers,
    ungrounded,
    friction: friction?.reason ?? null,
  });
  if (friction) {
    const summary = await sweepFriction({
      question: `Scheduled routine "${routine.key}":\n${routine.prompt}`,
      answer: posted,
      friction,
      // The sweep is a second call caused by this turn, so it is charged where
      // the turn was.
      lane,
      turnId: result.turnId,
    }).catch((error) => {
      log.warn("feedback_sweep_crashed", { error: error.message });
      return null;
    });
    if (summary) ledger.append(ledger.filedEntry({ turnId: result.turnId, summary }));
    if (summary && last) {
      await last
        .reply({
          content: `-# 📮 Filed with Elixir MCP: ${summary}`,
          allowedMentions: { repliedUser: false },
        })
        .catch(() => {});
    }
  }

  return {
    ok: true,
    skipped: false,
    text: posted,
    posts: posts.map(({ channelName, text: t }) => ({ channel: `#${channelName}`, text: t })),
    result,
  };
}
