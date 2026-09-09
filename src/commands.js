/**
 * Slash commands, because this is Discord.
 *
 * These started as `!run` / `!routines` message prefixes, which is a habit
 * from IRC-shaped bots: it needs MessageContent to read every message in every
 * channel just in case one starts with a bang, it is undiscoverable (nothing
 * lists the commands, nothing describes the arguments), it cannot be
 * permission-gated by Discord itself, and a typo is indistinguishable from
 * chat. Slash commands are the platform's answer to all four.
 *
 * Registered per GUILD rather than globally: guild commands appear instantly,
 * global ones take up to an hour to propagate, and this bot belongs to one
 * clan's server anyway.
 *
 * Every command here spends money, so all of them are admin-gated twice: a
 * default permission that hides them from members in the picker, and an
 * explicit id check that actually enforces it. The first is a UI hint the
 * server can override; the second is the rule.
 */

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  REST,
  Routes,
} from "discord.js";
import { config } from "./config.js";
import { loadRoutines } from "./routines.js";
import { runRoutine } from "./run.js";
import * as budget from "./budget.js";
import { log } from "./log.js";

export function commandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName("budget")
      .setDescription("What this bot has spent this month, per lane")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("routines")
      .setDescription("What this bot runs, when, and where it posts")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("run")
      .setDescription("Run one routine now and post it to its channel")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName("routine")
          .setDescription("Which routine to run")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  ].map((c) => c.toJSON());
}

/** A missing applications.commands scope is the one failure worth naming: the
 *  bot works, the commands simply never appear, and nothing says why. */
export async function registerCommands(client) {
  const rest = new REST().setToken(config.discord.token);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, config.discord.guildId),
      { body: commandDefinitions() },
    );
    log.info("commands_registered", {
      guild: config.discord.guildId,
      commands: "budget,routines,run",
    });
  } catch (error) {
    log.error("commands_registration_failed", {
      error: error.message,
      hint: "re-invite the bot with the applications.commands scope; it cannot add slash commands without it",
    });
  }
}

export function isAdmin(userId) {
  return config.adminUserIds.has(String(userId));
}

const money = (n) => `$${n.toFixed(2)}`;

export function budgetReply(status = budget.status()) {
  const lines = status.map((b) => {
    const cap = b.budget === null ? "no budget set" : `of ${money(b.budget)}`;
    const left =
      b.remaining === null ? "" : ` · ${money(b.remaining)} left`;
    const mark = b.state === "ok" ? "" : ` · **${b.state}**`;
    return `**${b.lane}** — ${money(b.spent)} ${cap}${left}${mark}`;
  });
  return [
    `**Spend so far in ${status[0]?.month ?? budget.monthKey()}**`,
    ...lines,
    `-# Strict: a lane stops before a turn that could cross its budget. Resets on the 1st, nothing rolls over.`,
  ].join("\n");
}

export function routinesReply(routines = loadRoutines().routines) {
  if (routines.length === 0) return "No routines loaded.";
  return routines
    .map((r) => {
      const when =
        r.trigger === "schedule"
          ? `${String(r.at.hour).padStart(2, "0")}:${String(r.at.minute).padStart(2, "0")}${r.days ? ` on ${r.days.join(",")}` : " daily"}`
          : r.trigger === "events"
            ? r.topics.join(", ")
            : "on message";
      return `${r.disabled ? "○" : "●"} \`${r.key}\` — ${r.trigger} → #${r.channel} · ${when} · ${r.model}`;
    })
    .join("\n");
}

export async function handleInteraction(interaction, { resolveChannel }) {
  if (interaction.isAutocomplete()) {
    const typed = (interaction.options.getFocused() ?? "").toLowerCase();
    const keys = loadRoutines()
      .routines.map((r) => r.key)
      .filter((k) => k.includes(typed))
      .slice(0, 25);
    await interaction.respond(keys.map((k) => ({ name: k, value: k })));
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({
      content:
        "That one is for whoever runs this bot — every command here spends money.",
      flags: MessageFlags.Ephemeral,
    });
    log.warn("command_refused", {
      command: interaction.commandName,
      user: interaction.user.id,
    });
    return;
  }

  if (interaction.commandName === "budget") {
    await interaction.reply({
      content: budgetReply(),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "routines") {
    await interaction.reply({
      content: routinesReply(),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "run") {
    const key = interaction.options.getString("routine");
    const routine = loadRoutines().routines.find((r) => r.key === key);
    if (!routine) {
      await interaction.reply({
        content: `No routine called \`${key}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const channel = await resolveChannel(routine.channel);
    if (!channel) {
      await interaction.reply({
        content: `\`${routine.key}\` posts to \`${routine.channel}\`, which is not bound to a channel id.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // A turn is a model call and Discord wants an answer in three seconds.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const run = await runRoutine(routine, { channel });
    log.info("routine_run_on_demand", {
      routine: routine.key,
      by: interaction.user.id,
      ok: run.ok,
    });
    await interaction.editReply(
      !run.ok
        ? `\`${routine.key}\` failed: ${run.error}`
        : run.skipped
          ? `\`${routine.key}\` chose to skip — nothing posted.`
          : `\`${routine.key}\` posted to #${routine.channel} · $${run.result.usd.toFixed(4)}`,
    );
  }
}
