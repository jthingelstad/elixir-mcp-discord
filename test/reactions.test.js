/**
 * A reader's 👍 / 👎 is joined back to the turn that produced the message and
 * filed — once per kind per turn — with fakes for the model and the door.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { handleReaction } from "../src/reactions.js";
import * as state from "../src/state.js";

const TURN = {
  routine: "ask",
  lane: "ask",
  question: "how am I playing?",
  answer: "55-38 this month.",
  called: ["players_summary"],
  errors: [],
  requestIds: ["dc5ec8de-b919"],
  channelId: "9",
};

function fakeReaction(emoji, messageId, { replies = [], partial = false } = {}) {
  const posted = [];
  const message = {
    id: messageId,
    partial,
    fetch: async () => ({ ...message, partial: false }),
    reply: async (body) => posted.push(body.content),
    channel: {
      messages: {
        fetch: async () => new Map(replies.map((r, i) => [String(i), r])),
      },
    },
  };
  return { posted, reaction: { emoji: { name: emoji }, message } };
}

const reader = { id: "77", bot: false, partial: false };

test("a 👍 files praise once, with the answer's request id", async () => {
  fs.rmSync(process.env.STATE_PATH, { force: true });
  state.rememberTurn("t1", TURN, ["m1", "m2"]);
  const filed = [];
  const { posted, reaction } = fakeReaction("👍", "m2");
  const first = await handleReaction(reaction, reader, { praiseFn: async ({ turn }) => (filed.push(turn), true) });
  assert.equal(first.filed, true);
  assert.equal(filed[0].requestIds[0], "dc5ec8de-b919");
  assert.equal(filed[0].turnId, "t1", "footer message resolves to the same turn as the post");
  assert.match(posted[0], /Filed as praise/);
  const again = await handleReaction(reaction, reader, { praiseFn: async () => (filed.push("again"), true) });
  assert.equal(again, null, "second 👍 on the same turn does nothing");
  assert.equal(filed.length, 1);
});

test("a 👎 sweeps with the reader's reply in hand and files", async () => {
  fs.rmSync(process.env.STATE_PATH, { force: true });
  state.rememberTurn("t2", TURN, ["m3"]);
  const reply = { author: { id: "77" }, reference: { messageId: "m3" }, cleanContent: "that's last month's number" };
  const { posted, reaction } = fakeReaction("👎", "m3", { replies: [reply] });
  let seen = null;
  const result = await handleReaction(reaction, reader, {
    sweepFn: async ({ turn, note }) => ((seen = { turn, note }), "Filed: window defaulted to last month"),
  });
  assert.equal(result.filed, true);
  assert.equal(seen.note, "that's last month's number");
  assert.equal(seen.turn.question, "how am I playing?");
  assert.match(posted[0], /Filed with Elixir MCP: Filed: window/);
});

test("a 👎 the sweep declines is released so a reply can be added", async () => {
  fs.rmSync(process.env.STATE_PATH, { force: true });
  state.rememberTurn("t3", TURN, ["m4"]);
  const { posted, reaction } = fakeReaction("👎", "m4");
  let sweeps = 0;
  const opts = { sweepFn: async () => ((sweeps += 1), null) };
  const first = await handleReaction(reaction, reader, opts);
  assert.equal(first.filed, false);
  assert.match(posted[0], /Reply to this message/);
  const second = await handleReaction(reaction, reader, opts);
  assert.notEqual(second, null, "not deduped: the mark was released");
  assert.equal(sweeps, 2);
});

test("reactions from bots, on unknown messages, or with other emoji are ignored", async () => {
  fs.rmSync(process.env.STATE_PATH, { force: true });
  state.rememberTurn("t4", TURN, ["m5"]);
  let touched = 0;
  const opts = { sweepFn: async () => ((touched += 1), "x"), praiseFn: async () => ((touched += 1), true) };
  assert.equal(await handleReaction(fakeReaction("👍", "m5").reaction, { id: "1", bot: true }, opts), null);
  assert.equal(await handleReaction(fakeReaction("👍", "nope").reaction, reader, opts), null);
  assert.equal(await handleReaction(fakeReaction("🔥", "m5").reaction, reader, opts), null);
  assert.equal(touched, 0);
});

test("a partial message is fetched before it is looked up", async () => {
  fs.rmSync(process.env.STATE_PATH, { force: true });
  state.rememberTurn("t5", TURN, ["m6"]);
  const { reaction } = fakeReaction("👍", "m6", { partial: true });
  const result = await handleReaction(reaction, reader, { praiseFn: async () => true });
  assert.equal(result.filed, true);
  fs.rmSync(process.env.STATE_PATH, { force: true });
});

test("turn records prune oldest first and drop their message ids", () => {
  fs.rmSync(process.env.STATE_PATH, { force: true });
  for (let i = 0; i < 205; i += 1) state.rememberTurn(`k${i}`, TURN, [`msg${i}`]);
  assert.equal(state.turnForMessage("msg0"), null);
  assert.equal(state.turnForMessage("msg4"), null);
  assert.equal(state.turnForMessage("msg5").turnId, "k5");
  assert.equal(state.turnForMessage("msg204").turnId, "k204");
  fs.rmSync(process.env.STATE_PATH, { force: true });
});
