/**
 * Entry point. Two lanes, one Discord connection, no shared state between them
 * beyond the state file.
 */

import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { config, provenance } from "./config.js";
import { handleAsk } from "./ask.js";
import { startPolling } from "./notify.js";
import { startScheduler } from "./schedule.js";
import { initialize } from "./mcp.js";
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
    log.info("mcp_connected", { version: handshake.version, url: config.mcp.url });
    if (state.get("serverVersion") && state.get("serverVersion") !== handshake.version) {
      log.warn("contract_version_changed_at_boot", {
        from: state.get("serverVersion"),
        to: handshake.version,
      });
    }
    state.set({ serverVersion: handshake.version });
  }

  const notifyChannel = await client.channels.fetch(config.discord.notifyChannelId).catch(() => null);
  if (!notifyChannel) {
    log.error("notify_channel_unresolvable", { id: config.discord.notifyChannelId });
    return;
  }
  startPolling(notifyChannel);
  log.info("notify_polling_started", { everySeconds: config.notifyPollSeconds });
  startScheduler(notifyChannel);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== config.discord.askChannelId) return;
  await handleAsk(message);
});

client.on(Events.Error, (error) => log.error("discord_error", { error: error.message }));
process.on("unhandledRejection", (reason) =>
  log.error("unhandled_rejection", { error: String(reason) }),
);

await client.login(config.discord.token);
