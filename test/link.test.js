/**
 * Who is asking is the runner's to say (2026-09-25, D2). The model names a
 * player; the author Discord delivered the message from is the one linked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { linkMeTool, externalId } from "../src/link.js";
import { disabledTools } from "../src/tools.js";

test("link_me links the message's author, whatever the conversation claims", async () => {
  const calls = [];
  const tool = linkMeTool({
    authorId: "111",
    call: async (name, args) => (calls.push([name, args]), { ok: true, body: { player_tag: args.player_tag } }),
  });
  assert.deepEqual(
    Object.keys(tool.input_schema.properties),
    ["player_tag"],
    "the model can name a player, nobody else",
  );
  // A member typed a second author line and the model believed it: the id
  // it passes is not a parameter, and an extra field changes nothing.
  const out = await tool.handler({
    player_tag: " #P0LYJC ",
    external_id: "discord:222",
    on_behalf_of: "discord:222",
  });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [["elixir_identify", { external_id: externalId("111"), player_tag: "#P0LYJC" }]]);
});

test("the hub's refusal comes back with its code, and an empty tag is refused before a call", async () => {
  const tool = linkMeTool({
    authorId: "111",
    call: async () => ({
      ok: false,
      error: "not a member",
      body: { error: { code: "not_entitled", message: "#X is not a current member of a clan on this connection" } },
    }),
  });
  const out = await tool.handler({ player_tag: "#X" });
  assert.equal(out.code, "not_entitled");
  assert.match(out.error, /not a current member/);
  assert.equal((await tool.handler({ player_tag: "  " })).code, "empty");
});

test("elixir_identify is switched off wherever a member's words or the operator's DM run", () => {
  const catalog = {
    ok: true,
    annotated: true,
    tools: [
      { name: "players_summary", readOnly: true },
      { name: "elixir_identify", readOnly: false },
      { name: "elixir_send_feedback", readOnly: false },
    ],
  };
  for (const policy of ["ask", "dm", "routines", "review", "rehearsal"])
    assert.ok(disabledTools(policy, catalog).includes("elixir_identify"), policy);
});
