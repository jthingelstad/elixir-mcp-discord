/**
 * The channel directory: where this bot may post, described so the model can
 * choose.
 *
 * Until 2026-09-13 a routine named a logical channel and .env bound it to an
 * id; the model never saw a channel, only its prose went somewhere. The bot's
 * strength is reasoning across described tools, and a Discord channel is
 * already described — it has a name and a topic an operator wrote in Discord
 * — so now the model reads the directory and posts where it fits, and a clan
 * with one channel or ten needs no wiring difference.
 *
 * THE ALLOW-LIST IS DISCORD PERMISSIONS, WITH ONE RULE: a channel is in the
 * directory when the bot holds an EXPLICIT grant there — a permission
 * overwrite for its role or for the bot itself allowing Send Messages. What
 * it merely inherits from @everyone does not count. On a typical server
 * @everyone can post almost everywhere, and "everywhere the bot could post"
 * would be twenty channels and a memes channel; "every channel somebody
 * deliberately let the bot into" is two. An operator widens it by granting
 * the bot's role Send Messages in one more channel, in Discord, and narrows
 * it the same way. A channel a routine binds by id (CHANNEL_*) is in the
 * directory too, so nothing that worked before stops.
 *
 * The directory is built from the gateway's cache in the service and over
 * REST in the CLI, through one `classify` so both agree.
 */

import { PermissionFlagsBits } from "discord.js";
import { log } from "./log.js";

/** One directory entry. `role` is "ask" for a channel a message routine
 *  listens in — the model must not post routine output there. */
export function classify({
  id,
  name,
  topic,
  position = 0,
  explicitSend,
  canSend,
  canThread,
  everyoneCanView,
  visibleTo = [],
  bound = false,
  role = null,
}) {
  if (!canSend) return null;
  if (!explicitSend && !bound) return null;
  return {
    id,
    name,
    topic: (topic || "").trim() || null,
    position,
    threads: Boolean(canThread),
    visibility: everyoneCanView ? "everyone" : "restricted",
    // Who can see a restricted channel: the roles whose overwrite allows
    // View. "visible to: Leader, Co-Leader" tells the model what a channel is
    // for better than "restricted" does — a clan-only main channel and a
    // leaders-only channel are both restricted.
    visibleTo: everyoneCanView ? [] : visibleTo,
    explicit: Boolean(explicitSend),
    role,
  };
}

/** Role names whose overwrite on this channel allows View, excluding the
 *  bot's own role and @everyone. `roleName(id)` maps an id to a name. */
export function viewersOf(overwrites, { everyoneId, botRoleId, roleName }) {
  return (overwrites ?? [])
    .filter(
      (o) => Number(o.type) === 0 && o.id !== everyoneId && o.id !== botRoleId && (BigInt(o.allow ?? 0) & VIEW) !== 0n,
    )
    .map((o) => roleName(o.id))
    .filter(Boolean);
}

const SEND = PermissionFlagsBits.SendMessages;
const VIEW = PermissionFlagsBits.ViewChannel;
const THREADS = PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.SendMessagesInThreads;

/** Does any overwrite for the bot (its managed role or itself) allow Send? */
export function explicitGrant(overwrites, { botId, botRoleId }) {
  return (overwrites ?? []).some((o) => {
    const mine = (Number(o.type) === 1 && o.id === botId) || (Number(o.type) === 0 && botRoleId && o.id === botRoleId);
    return mine && (BigInt(o.allow ?? 0) & SEND) !== 0n;
  });
}

/**
 * From discord.js gateway objects. `bound` is the set of channel ids routines
 * bind explicitly; `askIds` the ones message routines listen in.
 */
export function fromGateway(guild, botUser, { bound = new Set(), askIds = new Set() } = {}) {
  const botMember = guild.members.me ?? guild.members.cache.get(botUser.id);
  const botRoleId = guild.roles.cache.find((r) => r.tags?.botId === botUser.id)?.id ?? null;
  const everyone = guild.roles.everyone;
  const entries = [];
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased?.() || channel.isThread?.()) continue;
    const perms = botMember ? channel.permissionsFor(botMember) : null;
    if (!perms) continue;
    const overwrites = [...(channel.permissionOverwrites?.cache.values() ?? [])].map((o) => ({
      id: o.id,
      type: o.type,
      allow: o.allow.bitfield,
      deny: o.deny.bitfield,
    }));
    const entry = classify({
      id: channel.id,
      name: channel.name,
      topic: channel.topic,
      position: channel.rawPosition ?? channel.position ?? 0,
      explicitSend: explicitGrant(overwrites, { botId: botUser.id, botRoleId }),
      canSend: perms.has(VIEW) && perms.has(SEND),
      canThread: perms.has(THREADS),
      everyoneCanView: everyone ? (channel.permissionsFor(everyone)?.has(VIEW) ?? false) : true,
      visibleTo: viewersOf(overwrites, {
        everyoneId: guild.id,
        botRoleId,
        roleName: (id) => guild.roles.cache.get(id)?.name,
      }),
      bound: bound.has(channel.id),
      role: askIds.has(channel.id) ? "ask" : null,
    });
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** From an `inspectDiscord` result (src/discord-rest.js), for the CLI and setup. */
export function fromRest(inspected, permissionsIn, { bound = new Set(), askIds = new Set() } = {}) {
  const botId = inspected.user.id;
  const botRoleId = inspected.roles.find((r) => r.tags?.bot_id === botId)?.id ?? null;
  const everyoneRole = inspected.roles.find((r) => r.id === inspected.guild.id);
  const entries = [];
  for (const raw of inspected.channels) {
    const perms = permissionsIn(inspected, raw);
    const everyoneOverwrite = (raw.permission_overwrites ?? []).find((o) => o.id === inspected.guild.id);
    const everyoneCanView = everyoneOverwrite
      ? (BigInt(everyoneOverwrite.deny) & VIEW) === 0n
      : (BigInt(everyoneRole?.permissions ?? 0) & VIEW) !== 0n;
    const entry = classify({
      id: raw.id,
      name: raw.name,
      topic: raw.topic,
      position: raw.position ?? 0,
      explicitSend: explicitGrant(raw.permission_overwrites, { botId, botRoleId }),
      canSend: perms.has(VIEW) && perms.has(SEND),
      canThread: perms.has(THREADS),
      everyoneCanView,
      visibleTo: viewersOf(raw.permission_overwrites, {
        everyoneId: inspected.guild.id,
        botRoleId,
        roleName: (id) => inspected.roles.find((r) => r.id === id)?.name,
      }),
      bound: bound.has(raw.id),
      role: askIds.has(raw.id) ? "ask" : null,
    });
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** The system-prompt block: one line per channel, stable order, so it caches. */
export function render(entries, { defaultId = null } = {}) {
  if (!entries?.length) return null;
  const lines = entries.map((e) => {
    const marks = [];
    if (e.role === "ask") marks.push("ASK CHANNEL: members ask questions here; never post routine output here");
    if (e.visibility === "restricted")
      marks.push(
        e.visibleTo?.length ? `visible to: ${e.visibleTo.join(", ")}` : "restricted: not every member can see it",
      );
    if (e.id === defaultId) marks.push("DEFAULT for this routine");
    const tail = [e.topic, marks.length ? `[${marks.join("; ")}]` : null].filter(Boolean).join(" ");
    return `#${e.name} (channel_id ${e.id})${tail ? ` — ${tail}` : ""}`;
  });
  return `CHANNELS YOU MAY POST IN\n\n${lines.join("\n")}`;
}

// --- the live provider ---------------------------------------------------------

let provider = null;
let cached = { at: 0, entries: [] };
const TTL_MS = 60_000;

/** `{ list(): entries, resolve(id): channel|null }`, set once by whoever owns
 *  a Discord connection. Unset means no directory: routines post to their
 *  bound channel as before, and the model gets no post tool. */
export function configure(next) {
  provider = next;
  cached = { at: 0, entries: [] };
}

export function directory() {
  if (!provider) return [];
  if (Date.now() - cached.at > TTL_MS) {
    try {
      cached = { at: Date.now(), entries: provider.list() };
    } catch (error) {
      log.warn("directory_failed", { error: error.message });
    }
  }
  return cached.entries;
}

export async function resolveById(id) {
  if (!provider?.resolve) return null;
  return provider.resolve(id);
}
