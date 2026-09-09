/**
 * Entry point: connect to Discord, check who we are, start the three triggers.
 *
 * There is no behaviour in this file. Every prompt, schedule and destination
 * comes from `agent/`, which means installing this bot for another clan is a
 * key, some channel ids, and whatever routines that clan wants — with no fork
 * and no code to edit.
 */

import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { config, provenance, channelEnvName } from "./config.js";
import { handleAsk } from "./ask.js";
import { startEventLoop } from "./events.js";
import { startScheduler } from "./scheduler.js";
import { runRoutine } from "./run.js";
import { loadRoutines, routinesFor } from "./routines.js";
import { initialize, describePrincipal } from "./mcp.js";
import { log } from "./log.js";
import * as state from "./state.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

/** Logical channel name -> Discord channel, resolved once and remembered. A
 *  routine names `channel: reports`; the operator binds CHANNEL_REPORTS. */
const channelCache = new Map();

async function resolveChannel(name) {
  if (channelCache.has(name)) return channelCache.get(name);
  const id = config.channels.get(name);
  if (!id) {
    log.error("channel_unbound", { channel: name, expected: channelEnvName(name) });
    channelCache.set(name, null);
    return null;
  }
  const channel = await client.channels.fetch(id).catch((error) => {
    log.error("channel_unresolvable", { channel: name, id, error: error.message });
    return null;
  });
  channelCache.set(name, channel);
  return channel;
}

/**
 * The connection this bot holds, checked out loud at boot.
 *
 * A person key here is not a crash — it works, and it is what this bot ran on
 * for its first week — but it means "me" is the owner's own player rather than
 * the clan, and the routines will quietly answer as a person. That deserves a
 * loud line in the log rather than a surprise in a channel.
 */
function reportPrincipal(handshake) {
  const principal = handshake.principal;
  log.info("mcp_connected", {
    version: handshake.version,
    url: config.mcp.url,
    principal: describePrincipal(principal),
  });

  if (principal && principal.kind !== "agent") {
    log.warn("not_an_agent", {
      kind: principal.kind,
      hint: "routines will answer as this principal, not for a clan. See /docs/agents.",
    });
  }
  if (principal?.kind === "agent" && !principal.subject) {
    log.error("agent_without_clan", { hint: "this agent has no clan; every routine will be lost" });
  }

  const previous = state.get("principal");
  if (previous?.subject?.tag && previous.subject.tag !== principal?.subject?.tag) {
    log.warn("principal_subject_changed", {
      from: previous.subject.tag,
      to: principal?.subject?.tag ?? null,
    });
  }
  if (principal) state.set({ principal });
}

client.once(Events.ClientReady, async (ready) => {
  log.info("discord_ready", { user: ready.user.tag });
  for (const entry of provenance) {
    const shadowed = entry.source.startsWith("SHELL");
    log[shadowed ? "warn" : "info"]("config_resolved", {
      name: entry.name,
      value: entry.value,
      source: entry.source,
    });
  }

  const handshake = await initialize();
  if (!handshake.ok) {
    log.error("mcp_unreachable_at_boot", { error: handshake.error });
  } else {
    if (state.get("serverVersion") && state.get("serverVersion") !== handshake.version) {
      log.warn("contract_version_changed_at_boot", {
        from: state.get("serverVersion"),
        to: handshake.version,
      });
    }
    state.set({ serverVersion: handshake.version });
    reportPrincipal(handshake);
  }

  const { routines, errors } = loadRoutines();
  for (const failure of errors) log.error("routine_invalid", failure);
  for (const routine of routines) {
    log.info("routine_loaded", {
      key: routine.key,
      trigger: routine.trigger,
      channel: routine.channel,
      when: routine.at ? `${routine.at.hour}:${String(routine.at.minute).padStart(2, "0")}` : undefined,
      disabled: routine.disabled || undefined,
    });
    if (!routine.disabled) await resolveChannel(routine.channel);
  }
  if (routines.every((routine) => routine.disabled)) {
    log.error("no_active_routines", { dir: config.agentDir });
  }

  startEventLoop(() => routinesFor("events"), resolveChannel);
  startScheduler(() => routinesFor("schedule"), resolveChannel);
});

/** `!run <key>` from an admin, for showing a routine to somebody or checking a
 *  prompt change in the real channel. Off unless ADMIN_USER_IDS is set. */
async function handleAdminCommand(message) {
  const [command, key] = message.content.trim().split(/\s+/);
  if (command === "!routines") {
    const listed = loadRoutines()
      .routines.map((r) => `${r.disabled ? "○" : "●"} \`${r.key}\` — ${r.trigger} → #${r.channel}`)
      .join("\n");
    await message.reply(listed || "No routines loaded.");
    return true;
  }
  if (command !== "!run") return false;

  const routine = loadRoutines().routines.find((entry) => entry.key === key);
  if (!routine) {
    await message.reply(`No routine called \`${key ?? ""}\`. Try \`!routines\`.`);
    return true;
  }
  const channel = await resolveChannel(routine.channel);
  if (!channel) {
    await message.reply(`\`${routine.key}\` posts to \`${routine.channel}\`, which is not bound.`);
    return true;
  }
  await message.react("⏳").catch(() => {});
  const run = await runRoutine(routine, { channel, events: null });
  log.info("routine_run_on_demand", { routine: routine.key, by: message.author.id, ok: run.ok });
  if (!run.ok) await message.reply(`\`${routine.key}\` failed: ${run.error}`);
  else if (run.skipped) await message.reply(`\`${routine.key}\` chose to skip.`);
  return true;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (config.adminUserIds.has(message.author.id) && message.content.startsWith("!")) {
    const handled = await handleAdminCommand(message).catch((error) => {
      log.error("admin_command_failed", { error: error.message });
      return true;
    });
    if (handled) return;
  }

  // Routines are re-read per message so a prompt edit takes effect on the next
  // question, not the next restart.
  const routine = routinesFor("message").find(
    (entry) => config.channels.get(entry.channel) === message.channelId,
  );
  if (!routine) return;
  await handleAsk(message, routine);
});

client.on(Events.Error, (error) => log.error("discord_error", { error: error.message }));
process.on("unhandledRejection", (reason) =>
  log.error("unhandled_rejection", { error: String(reason) }),
);

await client.login(config.discord.token);
