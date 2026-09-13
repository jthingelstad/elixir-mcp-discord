/**
 * The channel directory: what the model may post in, from Discord's own
 * permissions — with the one rule that makes it safe on a real server.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits as P } from "discord.js";
import { classify, explicitGrant, fromRest, render } from "../src/directory.js";
import { permissionsIn } from "../src/discord-rest.js";

const str = (b) => b.toString();

test("inherited permission is not enough; an explicit grant or a binding is", () => {
  const base = { id: "1", name: "memes", topic: "", canSend: true, canThread: false, everyoneCanView: true };
  assert.equal(classify({ ...base, explicitSend: false }), null, "@everyone can post in #memes; the bot should not");
  assert.ok(classify({ ...base, explicitSend: true }));
  assert.ok(classify({ ...base, explicitSend: false, bound: true }), "a CHANNEL_* binding keeps working");
  assert.equal(classify({ ...base, explicitSend: true, canSend: false }), null, "a grant the overwrites then deny is no grant");
});

test("an explicit grant is an overwrite for the bot's role or the bot itself allowing Send", () => {
  const ids = { botId: "bot", botRoleId: "botrole" };
  assert.equal(explicitGrant([{ id: "everyone", type: 0, allow: str(P.SendMessages), deny: "0" }], ids), false);
  assert.equal(explicitGrant([{ id: "botrole", type: 0, allow: str(P.SendMessages), deny: "0" }], ids), true);
  assert.equal(explicitGrant([{ id: "bot", type: 1, allow: str(P.SendMessages | P.ViewChannel), deny: "0" }], ids), true);
  assert.equal(explicitGrant([{ id: "bot", type: 1, allow: str(P.ViewChannel), deny: "0" }], ids), false, "View alone is not a grant to post");
});

test("fromRest builds the directory the boot check and setup agree on", () => {
  const inspected = {
    user: { id: "bot" },
    guild: { id: "g", owner_id: "owner" },
    roles: [
      { id: "g", permissions: str(P.ViewChannel | P.SendMessages) },
      { id: "botrole", permissions: "0", tags: { bot_id: "bot" } },
    ],
    member: { roles: ["botrole"] },
    channels: [
      { id: "10", name: "general", topic: "Everyone", type: 0, position: 0, guild_id: "g", permission_overwrites: [] },
      { id: "11", name: "news", topic: "Clan news", type: 0, position: 1, guild_id: "g", permission_overwrites: [{ id: "botrole", type: 0, allow: str(P.SendMessages), deny: "0" }] },
      { id: "12", name: "leaders", topic: "Leaders only", type: 0, position: 2, guild_id: "g", permission_overwrites: [
        { id: "g", type: 0, allow: "0", deny: str(P.ViewChannel) },
        { id: "bot", type: 1, allow: str(P.ViewChannel | P.SendMessages), deny: "0" },
      ] },
      { id: "13", name: "ask", topic: "Ask the bot", type: 0, position: 3, guild_id: "g", permission_overwrites: [{ id: "botrole", type: 0, allow: str(P.SendMessages | P.CreatePublicThreads | P.SendMessagesInThreads), deny: "0" }] },
    ],
  };
  const entries = fromRest(inspected, permissionsIn, { askIds: new Set(["13"]) });
  assert.deepEqual(entries.map((e) => e.name), ["news", "leaders", "ask"], "#general is inherited and left out");
  assert.equal(entries.find((e) => e.name === "leaders").visibility, "restricted");
  assert.equal(entries.find((e) => e.name === "news").visibility, "everyone");
  assert.equal(entries.find((e) => e.name === "ask").role, "ask");
  assert.equal(entries.find((e) => e.name === "ask").threads, true);

  const block = render(entries, { defaultId: "11" });
  assert.match(block, /^CHANNELS YOU MAY POST IN/);
  assert.match(block, /#news \(channel_id 11\) — Clan news \[DEFAULT for this routine\]/);
  assert.match(block, /#leaders .*restricted/);
  assert.match(block, /#ask .*ASK CHANNEL/);
  assert.equal(render([]), null);
});
