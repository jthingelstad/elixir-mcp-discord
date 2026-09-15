/**
 * The boot-time channel check. Three bots on one server make a pasted id one
 * channel off the likeliest mistake, so what counts as unusable, and what
 * gets said about it, is pinned here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionsBitField, PermissionFlagsBits } from "discord.js";
import { config } from "../src/config.js";
import { requirementsFor, inspectChannel, checkChannelPermissions } from "../src/permissions.js";
import * as state from "../src/state.js";

// scripts/setup-tests.js sets DISCORD_GUILD_ID=1.
const GUILD = "1";
const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
];

function fakeChannel({ id = "2", guildId = GUILD, perms = ALL, name = "general", thread = false } = {}) {
  const sent = [];
  return {
    id,
    name,
    guildId,
    sent,
    isThread: () => thread,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(perms),
    send: async (payload) => {
      sent.push(payload);
      return { id: `${id}-sent` };
    },
  };
}

test("an ask channel needs thread permissions, a report channel does not", () => {
  const reqs = requirementsFor(
    [
      { key: "ask", trigger: "message", channel: "ask" },
      { key: "feed", trigger: "events", channel: "pulse" },
      { key: "off", trigger: "schedule", channel: "nowhere", disabled: true },
    ],
    { feedbackChannel: null },
  );
  const byName = Object.fromEntries(reqs.map((r) => [r.name, Object.keys(r.needs)]));
  assert.deepEqual(Object.keys(byName).sort(), ["ask", "pulse"], "a disabled routine's channel is not checked");
  assert.ok(byName.ask.includes("CreatePublicThreads"));
  assert.ok(byName.ask.includes("SendMessagesInThreads"));
  assert.ok(!byName.pulse.includes("CreatePublicThreads"));
  assert.ok(byName.pulse.includes("ReadMessageHistory"), "recall and reactions read history");
});

test("inspectChannel names the exact permissions missing, and the guild mismatch", () => {
  const needs = requirementsFor([{ trigger: "message", channel: "ask" }], { feedbackChannel: null })[0].needs;

  assert.equal(inspectChannel({ name: "ask", needs, channel: fakeChannel(), botId: "b", guildId: GUILD }), null);

  const noThreads = inspectChannel({
    name: "ask",
    needs,
    channel: fakeChannel({ perms: ALL.slice(0, 3) }),
    botId: "b",
    guildId: GUILD,
  });
  assert.equal(noThreads.reason, "missing_permissions");
  assert.deepEqual(noThreads.missing, ["CreatePublicThreads", "SendMessagesInThreads"]);
  assert.match(noThreads.hint, /CreatePublicThreads/);

  const elsewhere = inspectChannel({
    name: "ask",
    needs,
    channel: fakeChannel({ guildId: "999" }),
    botId: "b",
    guildId: GUILD,
  });
  assert.equal(elsewhere.reason, "wrong_guild", "a channel from another server is the three-bot mistake");

  assert.equal(
    inspectChannel({ name: "ask", needs, channel: fakeChannel({ thread: true }), botId: "b", guildId: GUILD }).reason,
    "not_a_text_channel",
  );
  assert.equal(inspectChannel({ name: "ask", needs, channel: null, botId: "b", guildId: GUILD }).reason, "unresolved");
});

test("the check says so in a channel that works, once per distinct problem set", async () => {
  const good = fakeChannel({ id: "2", name: "general" });
  const bad = fakeChannel({ id: "3", name: "ask", perms: ALL.slice(0, 2) });
  const channels = { pulse: good, ask: bad };
  const routines = [
    { key: "feed", trigger: "events", channel: "pulse" },
    { key: "ask", trigger: "message", channel: "ask" },
  ];
  const client = { user: { id: "bot", username: "Elixir" } };
  const resolveChannel = async (name) => channels[name] ?? null;
  assert.equal(config.discord.guildId, GUILD);
  state.set({ channelProblems: null });
  {
    const problems = await checkChannelPermissions({ client, routines, resolveChannel });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].name, "ask");
    assert.equal(good.sent.length, 1, "posted to the channel that works");
    assert.match(good.sent[0].content, /cannot use 1 of its 2 channels/);
    assert.match(good.sent[0].content, /ReadMessageHistory/);
    assert.deepEqual(good.sent[0].allowedMentions, { parse: [] });

    await checkChannelPermissions({ client, routines, resolveChannel });
    assert.equal(good.sent.length, 1, "the same problems are not re-announced on a restart");

    channels.ask = fakeChannel({ id: "3", name: "ask" });
    const fixed = await checkChannelPermissions({ client, routines, resolveChannel });
    assert.equal(fixed.length, 0);
    assert.equal(state.get("channelProblems"), null, "clearing the problems clears the memory of them");
  }
});

test("a COMMAND_PREFIX renames every command and is stripped on the way back in", async () => {
  const { commandName, baseCommand, commandDefinitions } = await import("../src/commands.js");
  assert.equal(commandName("run", ""), "run");
  assert.equal(commandName("run", "pk"), "pk-run");
  assert.equal(baseCommand("pk-run", "pk"), "run");
  assert.equal(baseCommand("run", "pk"), null, "another bot's command is not ours");
  assert.equal(baseCommand("run", ""), "run");
  const before = config.commandPrefix;
  config.commandPrefix = "pk";
  try {
    assert.deepEqual(
      commandDefinitions()
        .map((d) => d.name)
        .sort(),
      ["pk-budget", "pk-routines", "pk-run"],
    );
  } finally {
    config.commandPrefix = before;
  }
});
