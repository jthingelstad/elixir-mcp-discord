/**
 * Boot-time check that every channel a routine posts to is one this bot can
 * actually use — in THIS guild, with the permissions each lane needs.
 *
 * Nothing here is recoverable at runtime. A channel id from another server,
 * a role that cannot see the channel, an ask channel without Create Public
 * Threads: each one turns into a routine that runs, spends the model call,
 * and then fails to post — or posts into the wrong clan's channel. With three
 * bots on one server, a pasted id one channel off is the likeliest mistake,
 * and the only symptom would be silence in one channel and a stranger's clan
 * report in another. So this complains at boot, per channel, with the exact
 * permission names, and says so in Discord too if any channel will take it.
 */

import { PermissionFlagsBits } from "discord.js";
import { config, channelEnvName } from "./config.js";
import { log } from "./log.js";
import * as state from "./state.js";

/** What every lane needs: to see the channel, post in it, and read its
 *  history (recall, ask threads, a 👎 on an older post). */
const BASE = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
};

/** The ask lane answers in a thread per question. */
const THREADS = {
  CreatePublicThreads: PermissionFlagsBits.CreatePublicThreads,
  SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
};

/**
 * Which logical channels to check and what each needs, from the routines.
 * `{ name, needs }` per channel, threads only where a message routine listens.
 */
export function requirementsFor(routines, { feedbackChannel = config.feedbackChannel } = {}) {
  const needs = new Map();
  for (const routine of routines) {
    if (routine.disabled) continue;
    const entry = needs.get(routine.channel) ?? { ...BASE };
    if (routine.trigger === "message") Object.assign(entry, THREADS);
    needs.set(routine.channel, entry);
  }
  if (feedbackChannel && !needs.has(feedbackChannel)) needs.set(feedbackChannel, { ...BASE });
  return [...needs].map(([name, flags]) => ({ name, needs: flags }));
}

/**
 * Inspect one resolved channel. Returns null when it is fine, otherwise a
 * problem: `{ name, id, reason, missing?, hint }`.
 *
 * `channel` is whatever `resolveChannel` gave back (null when unbound or
 * unresolvable, which the resolver has already logged); `botId` is the
 * bot's own user id.
 */
export function inspectChannel({ name, needs, channel, botId, guildId = config.discord.guildId }) {
  const expected = channelEnvName(name);
  if (!channel) {
    return {
      name,
      id: config.channels.get(name) ?? null,
      reason: "unresolved",
      hint: `${expected} is unset or names a channel this bot cannot see`,
    };
  }
  if (!channel.guildId || channel.guildId !== guildId) {
    return {
      name,
      id: channel.id,
      reason: "wrong_guild",
      hint: `${expected} is a channel in guild ${channel.guildId ?? "?"}, not DISCORD_GUILD_ID ${guildId}`,
    };
  }
  if (channel.isThread?.() || typeof channel.permissionsFor !== "function" || !channel.isTextBased?.()) {
    return {
      name,
      id: channel.id,
      reason: "not_a_text_channel",
      hint: `${expected} must be a text channel, not a thread, category or voice channel`,
    };
  }
  const permissions = channel.permissionsFor(botId);
  if (!permissions) {
    return {
      name,
      id: channel.id,
      reason: "no_member",
      hint: "the bot is not a member of this guild; re-invite it",
    };
  }
  const missing = Object.entries(needs)
    .filter(([, flag]) => !permissions.has(flag))
    .map(([label]) => label);
  if (missing.length === 0) return null;
  return {
    name,
    id: channel.id,
    reason: "missing_permissions",
    missing,
    hint: `grant ${missing.join(", ")} to the bot's role in #${channel.name ?? channel.id}`,
  };
}

function describe(problem) {
  const where = problem.id ? `<#${problem.id}>` : `\`${problem.name}\``;
  return problem.missing
    ? `${where} (\`${problem.name}\`): missing ${problem.missing.map((m) => `\`${m}\``).join(", ")}`
    : `${where} (\`${problem.name}\`): ${problem.hint}`;
}

/**
 * Check every channel the routines use and complain, loudly, about each one
 * that will not work: an ERROR line per problem in the log, a summary line,
 * and — because the log is the last place an operator looks when a channel
 * simply goes quiet — one message in the first channel that CAN take it,
 * naming the rest. That message is posted once per distinct set of problems
 * (kept in state), so a crash loop with a bad id does not paper a channel
 * with the same complaint every thirty seconds.
 *
 * Returns the problems so the caller can decide what else to do; the bot
 * keeps running, because the lanes that do work should.
 */
export async function checkChannelPermissions({ client, routines, resolveChannel, post = true }) {
  const botId = client.user.id;
  const problems = [];
  const healthy = [];
  for (const requirement of requirementsFor(routines)) {
    const channel = await resolveChannel(requirement.name);
    const problem = inspectChannel({ ...requirement, channel, botId });
    if (problem) {
      problems.push(problem);
      log.error("channel_unusable", {
        channel: problem.name,
        id: problem.id,
        reason: problem.reason,
        missing: problem.missing,
        hint: problem.hint,
      });
    } else {
      healthy.push({ name: requirement.name, channel });
      log.info("channel_ok", {
        channel: requirement.name,
        id: channel.id,
        needs: Object.keys(requirement.needs).join(","),
      });
    }
  }

  if (problems.length === 0) {
    log.info("channels_ok", { count: healthy.length });
    state.set({ channelProblems: null });
    return problems;
  }

  log.error("channels_unusable", {
    count: problems.length,
    of: problems.length + healthy.length,
    channels: problems.map((p) => p.name).join(","),
    hint: "routines bound to these channels will spend the model call and fail to post; fix the ids or the role and restart",
  });

  const fingerprint = JSON.stringify(
    problems.map((p) => [p.name, p.id, p.reason, p.missing ?? []]),
  );
  if (!post || healthy.length === 0 || state.get("channelProblems") === fingerprint) {
    if (healthy.length === 0) {
      log.error("no_usable_channel", {
        hint: "not one bound channel is usable, so this bot cannot even say so in Discord",
      });
    }
    return problems;
  }
  const lines = [
    `⚠️ **${client.user.username} cannot use ${problems.length} of its ${problems.length + healthy.length} channels.** Routines bound to them will fail until this is fixed and the bot restarted:`,
    ...problems.map((p) => `• ${describe(p)}`),
  ];
  try {
    await healthy[0].channel.send({
      content: lines.join("\n"),
      allowedMentions: { parse: [] },
    });
    state.set({ channelProblems: fingerprint });
  } catch (error) {
    log.error("channel_warning_unposted", { error: error.message });
  }
  return problems;
}
