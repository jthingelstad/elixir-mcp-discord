/**
 * Entry point: connect to Discord, check who we are, start the three triggers.
 *
 * There is no behaviour in this file. Every prompt, schedule and destination
 * comes from `agent/`, which means installing this bot for another clan is a
 * key, some channel ids, and whatever routines that clan wants — with no fork
 * and no code to edit.
 */

import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import {
  config,
  provenance,
  channelEnvName,
  instanceDir,
  envFile,
  configFile,
  envLoaded,
  migrated,
} from "./config.js";
import { handleAsk, isThreadOf } from "./ask.js";
import { handleReaction } from "./reactions.js";
import { startEventLoop } from "./events.js";
import { startScheduler } from "./scheduler.js";
import { startReview } from "./review.js";
import * as notify from "./notify.js";
import { handleDm, introduce } from "./dm.js";
import { loadRoutines, routinesFor } from "./routines.js";
import { registerCommands, handleInteraction } from "./commands.js";
import { checkChannelPermissions } from "./permissions.js";
import * as directory from "./directory.js";
import { buildId } from "./build.js";
import { drain, count } from "./inflight.js";
import { commandName } from "./commands.js";
import { rateFor } from "./pricing.js";
import * as budget from "./budget.js";
import { initialize, describePrincipal } from "./mcp.js";
import { log } from "./log.js";
import * as state from "./state.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // Reader 👍 / 👎 on a post is feedback; see src/reactions.js.
    GatewayIntentBits.GuildMessageReactions,
    // The operator's console (src/dm.js) and where notices land (src/notify.js).
    GatewayIntentBits.DirectMessages,
  ],
  // A reaction on a message posted before this process started arrives with
  // the message, the reaction and sometimes the user uncached; partials let
  // the event through so it can be fetched.
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

/** Logical channel name -> Discord channel, resolved once and remembered. A
 *  routine names `channel: reports`; the operator binds CHANNEL_REPORTS. */
const channelCache = new Map();

async function resolveChannel(name) {
  if (channelCache.has(name)) return channelCache.get(name);
  let id = config.channels.get(name);
  if (!id) {
    // Unbound in .env: a directory channel of that NAME will do, so a routine
    // can say `channel: general` and mean #general with no id anywhere.
    const byName = directory.directory().find((e) => e.name === name);
    if (byName) {
      id = byName.id;
      log.info("channel_resolved_by_name", { channel: name, id });
    }
  }
  if (!id) {
    log.error("channel_unbound", {
      channel: name,
      expected: channelEnvName(name),
      hint: "set it in .env, or name a channel from the directory",
    });
    channelCache.set(name, null);
    return null;
  }
  const channel = await client.channels.fetch(id).catch((error) => {
    log.error("channel_unresolvable", {
      channel: name,
      id,
      error: error.message,
    });
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
    log.error("agent_without_clan", {
      hint: "this agent has no clan; every routine will be lost",
    });
  }

  const previous = state.get("principal");
  if (
    previous?.subject?.tag &&
    previous.subject.tag !== principal?.subject?.tag
  ) {
    log.warn("principal_subject_changed", {
      from: previous.subject.tag,
      to: principal?.subject?.tag ?? null,
    });
  }
  if (principal) state.set({ principal });
}

client.once(Events.ClientReady, async (ready) => {
  log.info("discord_ready", { user: ready.user.tag, guild: config.discord.guildId, build: buildId() });
  notify.configure({ client });
  // Which instance this is, first. One checkout can run several bots, and a
  // log line that does not say whose .env it read is a log line that will be
  // read as another clan's.
  log[envLoaded ? "info" : "warn"]("instance", {
    dir: instanceDir,
    env: envLoaded ? envFile : `${envFile} (not found; shell environment only)`,
    config: configFile,
    agent: config.agentDir,
    state: state.STATE_PATH,
  });
  if (migrated?.moved) {
    log.info("config_migrated", { moved: migrated.moved.join(","), backup: migrated.backup });
    await notify.notify("settings moved", `${migrated.moved.length} settings moved from .env to config.json (${migrated.moved.join(", ")}). .env now holds the secrets and the wiring; the old one is backed up under state/env-history/.`, { fingerprint: "config_migrated" });
  } else if (migrated?.movedBack) {
    log.info("wiring_moved_back", { keys: migrated.movedBack.join(","), backup: migrated.backup });
  }
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
    await notify.notify("Elixir unreachable at boot", `initialize failed: ${handshake.error}. Every lane will fail until it is back.`);
  } else {
    if (
      state.get("serverVersion") &&
      state.get("serverVersion") !== handshake.version
    ) {
      log.warn("contract_version_changed_at_boot", {
        from: state.get("serverVersion"),
        to: handshake.version,
      });
      await notify.notify("Elixir changed", `contract ${state.get("serverVersion")} → ${handshake.version}. Tool schemas may have moved; the elixir_changelog tool says what.`, { fingerprint: `contract:${handshake.version}` });
    }
    state.set({ serverVersion: handshake.version });
    reportPrincipal(handshake);
  }

  const { routines, errors } = loadRoutines();
  for (const failure of errors) log.error("routine_invalid", failure);
  if (errors.length) {
    // The 2026-09-13 outage: every routine failed to parse and the only
    // record was here. Now it is also a DM.
    await notify.notify("routine files", `${errors.length} routine file${errors.length === 1 ? "" : "s"} failed to load and ${errors.length === 1 ? "is" : "are"} off the air: ${errors.map((e) => `${e.key} — ${e.error}`).join("; ")}`, { fingerprint: `routine_invalid:${errors.map((e) => e.key).join(",")}` });
  }

  // THE DIRECTORY: where the model may post, from Discord's own permissions
  // (src/directory.js). Built from the gateway cache on demand; the ask
  // channels are marked so routine output never lands where members ask.
  const guild = await client.guilds.fetch(config.discord.guildId).catch(() => null);
  if (guild) {
    await guild.channels.fetch().catch(() => {});
    await guild.members.fetchMe().catch(() => {});
  }
  directory.configure({
    list: () => {
      if (!guild) return [];
      const active = loadRoutines().routines.filter((r) => !r.disabled);
      const bound = new Set(active.map((r) => r.channel && config.channels.get(r.channel)).filter(Boolean));
      const askIds = new Set(
        active.filter((r) => r.trigger === "message").map((r) => config.channels.get(r.channel)).filter(Boolean),
      );
      return directory.fromGateway(guild, client.user, { bound, askIds });
    },
    resolve: (id) => client.channels.fetch(id).catch(() => null),
  });
  const entries = directory.directory();
  const postable = entries.filter((e) => e.role !== "ask");
  log[postable.length ? "info" : "error"]("directory", {
    postable: postable.map((e) => `#${e.name}${e.visibility === "restricted" ? "(restricted)" : ""}`).join(",") || "NONE",
    ask: entries.filter((e) => e.role === "ask").map((e) => `#${e.name}`).join(",") || undefined,
    hint: postable.length ? undefined : "grant the bot's role Send Messages explicitly in each channel it may post in",
  });

  // Every model in play has to have a price, or the budgets below are decoration.
  // Checked at boot rather than at 01:00 when a routine with an exotic model
  // silently records $0 against a cap it can never reach.
  const models = new Set([
    config.claude.model,
    ...routines.filter((r) => !r.disabled).map((r) => r.model),
    ...(config.review.enabled ? [config.review.model] : []),
  ]);
  for (const model of models) {
    try {
      const rate = rateFor(model);
      log.info("model_priced", {
        model,
        input_per_mtok: rate.input,
        output_per_mtok: rate.output,
      });
    } catch (error) {
      log.error("model_unpriced", { model, error: error.message });
      await notify.notify("unpriced model", `${model} has no price in agent/models.json, so no budget could be enforced against it; the bot will not run until it does.`);
      throw error;
    }
  }

  for (const lane of budget.status()) {
    log[lane.budget ? "info" : "warn"]("budget", {
      lane: lane.lane,
      month: lane.month,
      spent: lane.spent.toFixed(2),
      budget: lane.budget ? lane.budget.toFixed(2) : "UNLIMITED",
      state: lane.state,
    });
  }
  for (const routine of routines) {
    log.info("routine_loaded", {
      key: routine.key,
      trigger: routine.trigger,
      channel: routine.channel,
      when: routine.at
        ? `${routine.at.hour}:${String(routine.at.minute).padStart(2, "0")}`
        : undefined,
      disabled: routine.disabled || undefined,
    });
    if (!routine.disabled && routine.channel) await resolveChannel(routine.channel);
  }
  if (routines.every((routine) => routine.disabled)) {
    // Not an error on a fresh instance: setup wires the connection and the
    // bot introduces itself here. An error only when it stays that way.
    log[routines.length ? "error" : "warn"]("no_active_routines", { dir: config.agentDir, hint: "the admins are being introduced by DM" });
    await introduce({ guildName: guild?.name, subject: state.get("principal")?.subject });
  }
  // Loud, per channel, before anything runs: a wrong id or a missing
  // permission is a routine that spends a model call and then cannot post.
  const problems = await checkChannelPermissions({ client, routines, resolveChannel });
  if (problems.length) {
    await notify.notify("channels", `${problems.length} bound channel${problems.length === 1 ? "" : "s"} unusable: ${problems.map((p) => `${p.name} (${p.reason}${p.missing?.length ? `: ${p.missing.join(", ")}` : ""})`).join("; ")}. Routines bound to them will fail until fixed and restarted.`, { fingerprint: `channels:${problems.map((p) => p.name).join(",")}` });
  }

  await registerCommands(client);
  await postHello({ handshake, routines });
  timers.push(startEventLoop(() => routinesFor("events"), resolveChannel));
  timers.push(startScheduler(() => routinesFor("schedule"), resolveChannel));
  // After the scheduler: both seed the same run ledger, and the scheduler's
  // first seeding replaces it wholesale.
  timers.push(startReview(client));
});

/**
 * GRACEFUL SHUTDOWN. SIGTERM (what `launchctl kickstart -k` and systemd
 * send) stops the clocks, refuses new turns, waits for the ones in flight —
 * a member's answer, a scheduled post already marked in the ledger — and only
 * then disconnects. The plist's ExitTimeOut is longer than this wait, so
 * launchd does not SIGKILL first.
 */
const timers = [];
const DRAIN_MS = 45_000;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of timers) clearInterval(timer);
  const running = count();
  log.info("shutdown", { signal, inFlight: running, waitUpToMs: running ? DRAIN_MS : 0 });
  const left = await drain(DRAIN_MS);
  if (left) log.warn("shutdown_abandoned_turns", { inFlight: left });
  await client.destroy().catch(() => {});
  log.info("shutdown_complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * One line on boot, in the first channel the bot may post in, so a restart
 * is visible to the people it serves and the build is on record beside
 * whatever it posts next. Runner-posted: no model, no cost. At most once an
 * hour, so a crash loop is a log problem and not a channel problem.
 */
const HELLO_INTERVAL_MS = 60 * 60 * 1000;

async function postHello({ handshake, routines }) {
  if (!config.startupMessage) return;
  const last = state.get("helloAt");
  if (last && Date.now() - Date.parse(last) < HELLO_INTERVAL_MS) {
    log.info("hello_skipped", { lastAt: last });
    return;
  }
  const target = directory.directory().find((e) => e.role !== "ask");
  if (!target) return;
  const channel = await directory.resolveById(target.id);
  if (!channel) return;
  const active = routines.filter((r) => !r.disabled);
  const counts = {
    schedule: active.filter((r) => r.trigger === "schedule").length,
    events: active.filter((r) => r.trigger === "events").length,
    message: active.filter((r) => r.trigger === "message").length,
  };
  const parts = [
    `Online · build ${buildId()}`,
    handshake?.ok ? `Elixir MCP ${handshake.version?.split("+")[0] ?? "?"}` : "Elixir MCP unreachable",
    `${counts.schedule} scheduled, ${counts.events ? "watching the timeline" : "no feed"}${counts.message ? ", answering questions" : ""}`,
    `\`/${commandName("routines")}\` for the list`,
  ];
  try {
    await channel.send({ content: `-# 👋 ${parts.join(" · ")}`, allowedMentions: { parse: [] } });
    state.set({ helloAt: new Date().toISOString() });
    log.info("hello_posted", { channel: `#${target.name}` });
  } catch (error) {
    log.warn("hello_failed", { error: error.message });
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  await handleInteraction(interaction, { resolveChannel }).catch((error) => {
    log.error("interaction_failed", {
      command: interaction.commandName,
      error: error.message,
    });
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.system) return;

  // A direct message is the operator's console, or a stranger to turn away.
  if (!message.guildId) {
    await handleDm(message).catch((error) => log.error("dm_crashed", { error: error.message, stack: error.stack?.slice(0, 400) }));
    return;
  }

  // Routines are re-read per message so a prompt edit takes effect on the next
  // question, not the next restart. A message in a thread under the routine's
  // channel is a follow-up in that conversation.
  const askRoutines = routinesFor("message");
  const routine = askRoutines.find((entry) => {
    const id = config.channels.get(entry.channel);
    return id === message.channelId || isThreadOf(message.channel, id);
  });
  if (!routine) {
    // A member speaking in a bound channel while NO message routine exists
    // is the ask lane being off the air (see activeRoutines), not chatter.
    if (askRoutines.length === 0 && [...config.channels.values()].includes(message.channelId)) {
      log.warn("message_unclaimed", { channel: message.channelId, hint: "no message routine loaded; see routine_invalid above" });
    }
    return;
  }
  await handleAsk(message, routine);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  await handleReaction(reaction, user).catch((error) =>
    log.error("reaction_failed", { error: error.message }),
  );
});

client.on(Events.Error, (error) =>
  log.error("discord_error", { error: error.message }),
);
process.on("unhandledRejection", (reason) =>
  log.error("unhandled_rejection", { error: String(reason) }),
);

await client.login(config.discord.token);
