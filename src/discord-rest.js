/**
 * Discord over REST, before the bot ever logs in.
 *
 * The gateway login in `src/index.js` is the real thing, but it fails in ways
 * that say nothing useful: a bot invited without the Message Content intent
 * is "Used disallowed intents" and a dead process; a bot not yet in the server
 * is a channel that "cannot be resolved". Setup wants to explain each of
 * those BEFORE they happen, with the fix, and the REST API answers every one
 * of them with nothing but the bot token — no intents, no gateway, no
 * presence flicker in the member list.
 *
 * The permission arithmetic below is Discord's documented algorithm (base
 * role permissions, then @everyone overwrite, then role overwrites, then the
 * member overwrite), reproduced here because discord.js only computes it for
 * a gateway-populated guild. It hands back a PermissionsBitField so
 * `inspectChannel` in src/permissions.js can judge the result the same way
 * the boot check does: one rule for what a channel needs, two ways to get
 * there.
 */

import {
  ApplicationFlags,
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  PermissionsBitField,
  REST,
  Routes,
} from "discord.js";
import { EVERY_PERMISSION } from "./permissions.js";

/** The permission integer for an invite link: everything any lane could need. */
export function requiredPermissionBits() {
  return new PermissionsBitField(Object.values(EVERY_PERMISSION)).bitfield;
}

/** The invite link for this application into this guild, with the scopes the
 *  bot needs: `bot` to exist, `applications.commands` to register slash
 *  commands — the one people forget, and the one whose absence is silent. */
export function inviteUrl(appId, guildId) {
  const params = new URLSearchParams({
    client_id: appId,
    scope: "bot applications.commands",
    permissions: requiredPermissionBits().toString(),
  });
  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }
  return `https://discord.com/oauth2/authorize?${params}`;
}

/** Message Content is a privileged intent, switched on per application in
 *  the developer portal; the application object says whether it was. The
 *  "limited" flag is the under-100-servers form, which is the one a clan bot
 *  gets. */
export function hasMessageContentIntent(application) {
  const flags = Number(application?.flags ?? 0);
  return Boolean(
    flags & ApplicationFlags.GatewayMessageContent ||
      flags & ApplicationFlags.GatewayMessageContentLimited,
  );
}

/** Discord's permission algorithm over raw REST payloads. */
export function computePermissions({ guild, roles, member, channel, botId }) {
  if (guild.owner_id === botId) return new PermissionsBitField(PermissionsBitField.All);
  const byId = new Map(roles.map((role) => [role.id, BigInt(role.permissions)]));
  const memberRoles = new Set(member.roles ?? []);
  let perms = byId.get(guild.id) ?? 0n;
  for (const id of memberRoles) perms |= byId.get(id) ?? 0n;
  if (perms & PermissionFlagsBits.Administrator) {
    return new PermissionsBitField(PermissionsBitField.All);
  }
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((o) => o.id === guild.id);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (Number(o.type) === 0 && o.id !== guild.id && memberRoles.has(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const mine = overwrites.find((o) => Number(o.type) === 1 && o.id === botId);
  if (mine) perms = (perms & ~BigInt(mine.deny)) | BigInt(mine.allow);
  return new PermissionsBitField(perms);
}

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/** A raw REST channel dressed as enough of a discord.js channel for
 *  `inspectChannel`: id, name, guildId, the type predicates, permissionsFor. */
export function channelLike(raw, permissions) {
  return {
    id: raw.id,
    name: raw.name,
    guildId: raw.guild_id,
    type: raw.type,
    isThread: () => false,
    isTextBased: () => TEXT_TYPES.has(raw.type),
    permissionsFor: () => permissions,
  };
}

function status(error) {
  return error instanceof DiscordAPIError ? error.status : null;
}

/**
 * Everything setup wants to know about one bot in one guild, in one pass.
 * Each field is filled in as far as the previous one allowed; `problems` is
 * the ordered list of what stopped it, each with the fix.
 */
export async function inspectDiscord({ token, appId = null, guildId }) {
  const rest = new REST().setToken(token);
  const out = { user: null, application: null, guild: null, channels: [], roles: [], member: null, problems: [] };

  try {
    out.user = await rest.get(Routes.user("@me"));
  } catch (error) {
    out.problems.push({
      what: "token",
      detail: status(error) === 401 ? "Discord rejected the bot token" : error.message,
      fix: "Developer Portal > your application > Bot > Reset Token, and paste the new one",
    });
    return out;
  }

  try {
    out.application = await rest.get(Routes.currentApplication());
  } catch (error) {
    out.problems.push({ what: "application", detail: error.message, fix: "retry; this endpoint needs only the bot token" });
    return out;
  }
  if (appId && out.application.id !== appId) {
    out.problems.push({
      what: "app_id",
      detail: `this token belongs to application ${out.application.id} (${out.application.name}), not ${appId}`,
      fix: "the token and the application id must come from the same application in the Developer Portal",
    });
  }
  if (!hasMessageContentIntent(out.application)) {
    out.problems.push({
      what: "intent",
      detail: "the Message Content intent is off for this application",
      fix: "Developer Portal > your application > Bot > Privileged Gateway Intents > turn on MESSAGE CONTENT INTENT and save; without it the gateway login fails with 'Used disallowed intents'",
    });
  }

  try {
    out.guild = await rest.get(Routes.guild(guildId));
  } catch (error) {
    const code = status(error);
    out.problems.push({
      what: "guild",
      detail:
        code === 403 || code === 404
          ? `the bot is not in guild ${guildId}`
          : error.message,
      fix: `invite it with this link (it carries the bot and applications.commands scopes and every permission a lane can need):\n      ${inviteUrl(out.application.id, guildId)}`,
    });
    return out;
  }

  try {
    [out.roles, out.channels, out.member] = await Promise.all([
      rest.get(Routes.guildRoles(guildId)),
      rest.get(Routes.guildChannels(guildId)),
      rest.get(Routes.guildMember(guildId, out.user.id)),
    ]);
  } catch (error) {
    out.problems.push({ what: "guild_read", detail: error.message, fix: "retry; reading roles, channels and the bot's own membership needs no extra permission" });
    return out;
  }
  out.channels = out.channels
    .filter((channel) => TEXT_TYPES.has(channel.type))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  return out;
}

/** The permissions the bot holds in one raw channel of an inspected guild. */
export function permissionsIn(inspected, rawChannel) {
  return computePermissions({
    guild: inspected.guild,
    roles: inspected.roles,
    member: inspected.member,
    channel: rawChannel,
    botId: inspected.user.id,
  });
}

/** One member of the guild by user id, or null if they are not in it. Used to
 *  check that an admin id is a real person in this server, not a channel id
 *  pasted into the wrong box. */
export async function memberOf({ token, guildId, userId }) {
  const rest = new REST().setToken(token);
  try {
    return await rest.get(Routes.guildMember(guildId, userId));
  } catch (error) {
    if (status(error) === 404 || status(error) === 400) return null;
    throw error;
  }
}
