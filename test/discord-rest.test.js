/**
 * Discord's permission algorithm, reproduced over REST payloads so setup can
 * judge a channel before the bot logs in. Pinned against the documented
 * order: base roles, @everyone overwrite, role overwrites, member overwrite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits, ApplicationFlags } from "discord.js";
import {
  computePermissions,
  inviteUrl,
  hasMessageContentIntent,
  requiredPermissionBits,
  channelLike,
} from "../src/discord-rest.js";
import { inspectChannel, requirementsFor } from "../src/permissions.js";
import { renderEnv } from "../src/env-file.js";

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const HISTORY = PermissionFlagsBits.ReadMessageHistory;
const THREADS = PermissionFlagsBits.CreatePublicThreads;
const str = (bits) => bits.toString();

const guild = { id: "g", owner_id: "owner" };
const roles = [
  { id: "g", permissions: str(VIEW | SEND) },
  { id: "bots", permissions: str(HISTORY) },
];
const member = { roles: ["bots"] };

test("base permissions are the union of @everyone and the member's roles", () => {
  const perms = computePermissions({ guild, roles, member, channel: {}, botId: "b" });
  assert.ok(perms.has([VIEW, SEND, HISTORY]));
  assert.ok(!perms.has(THREADS));
});

test("overwrites apply in order: @everyone, then roles, then the member", () => {
  const channel = {
    permission_overwrites: [
      { id: "g", type: 0, allow: "0", deny: str(VIEW | SEND) },
      { id: "bots", type: 0, allow: str(VIEW | THREADS), deny: "0" },
      { id: "b", type: 1, allow: str(SEND), deny: str(HISTORY) },
    ],
  };
  const perms = computePermissions({ guild, roles, member, channel, botId: "b" });
  assert.ok(perms.has(VIEW), "@everyone denied it, the bot role allowed it back");
  assert.ok(perms.has(SEND), "the member overwrite allows what @everyone denied");
  assert.ok(perms.has(THREADS), "role overwrite grants");
  assert.ok(!perms.has(HISTORY), "member overwrite denies what the base role granted");
});

test("Administrator and ownership short-circuit to everything", () => {
  const admin = computePermissions({
    guild,
    roles: [{ id: "g", permissions: "0" }, { id: "adm", permissions: str(PermissionFlagsBits.Administrator) }],
    member: { roles: ["adm"] },
    channel: { permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: str(VIEW) }] },
    botId: "b",
  });
  assert.ok(admin.has(VIEW), "an overwrite cannot deny an administrator");
  const owner = computePermissions({ guild, roles, member: { roles: [] }, channel: {}, botId: "owner" });
  assert.ok(owner.has(THREADS));
});

test("a REST channel can be judged by the same rule as the boot check", () => {
  const needs = requirementsFor([{ trigger: "message", channel: "ask" }], { feedbackChannel: null })[0].needs;
  const raw = { id: "c", name: "ask", guild_id: "g", type: 0, permission_overwrites: [] };
  const perms = computePermissions({ guild, roles, member, channel: raw, botId: "b" });
  const problem = inspectChannel({ name: "ask", needs, channel: channelLike(raw, perms), botId: "b", guildId: "g" });
  assert.equal(problem.reason, "missing_permissions");
  assert.deepEqual(problem.missing, ["CreatePublicThreads", "SendMessagesInThreads"]);
  const voice = channelLike({ ...raw, type: 2 }, perms);
  assert.equal(inspectChannel({ name: "ask", needs, channel: voice, botId: "b", guildId: "g" }).reason, "not_a_text_channel");
});

test("the invite link carries both scopes and every permission a lane can need", () => {
  const url = new URL(inviteUrl("app", "guild"));
  assert.equal(url.searchParams.get("scope"), "bot applications.commands");
  assert.equal(url.searchParams.get("guild_id"), "guild");
  assert.equal(url.searchParams.get("permissions"), requiredPermissionBits().toString());
  const bits = BigInt(url.searchParams.get("permissions"));
  for (const flag of [VIEW, SEND, HISTORY, THREADS, PermissionFlagsBits.SendMessagesInThreads]) {
    assert.ok(bits & flag);
  }
  assert.ok(!(bits & PermissionFlagsBits.Administrator), "never ask for more than the lanes use");
});

test("the Message Content intent is read from the application's flags", () => {
  assert.equal(hasMessageContentIntent({ flags: 0 }), false);
  assert.equal(hasMessageContentIntent({ flags: ApplicationFlags.GatewayMessageContentLimited }), true);
  assert.equal(hasMessageContentIntent({ flags: ApplicationFlags.GatewayMessageContent }), true);
});

test("the written .env keeps every managed key in order and carries the rest", () => {
  const text = renderEnv({
    values: {
      ELIXIR_MCP_URL: "https://x/a/1/mcp",
      DAILY_USD_CAP: "5.00",
      CHANNEL_PULSE: "2",
      CHANNEL_ASK: "1",
      COMMAND_PREFIX: "pk",
    },
    instanceDir: "/tmp/kings",
  });
  const keys = text.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
  assert.ok(keys.indexOf("CHANNEL_ASK") < keys.indexOf("CHANNEL_PULSE"), "channels sorted");
  assert.ok(keys.indexOf("DAILY_USD_CAP") > keys.indexOf("ADMIN_USER_IDS"), "unmanaged keys carried at the end");
  assert.ok(text.includes("COMMAND_PREFIX=pk"));
  assert.ok(text.includes("DISCORD_BOT_TOKEN=\n"), "unset managed keys are written blank, not dropped");
  assert.ok(text.startsWith("# elixir-mcp-discord instance: kings"));
});
