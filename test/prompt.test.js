/**
 * The system prompt is assembled from three layers, and which layer a rule
 * lives in is a design decision this suite pins down: mechanics in code,
 * voice in the operator's file, task in the routine.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { systemFor, userMessageFor, isSkip, readIdentity } from "../src/prompt.js";
import { parseRoutine } from "../src/routines.js";

const routine = (fields, body = "Do the thing.") =>
  parseRoutine(
    "r",
    `---\n${Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n---\n${body}`,
  );

test("every prompt carries the rules a routine is not allowed to get wrong", () => {
  const system = systemFor(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), {
    identity: null,
  });
  assert.match(system, /ONLY source of information is the Elixir MCP server/);
  assert.match(system, /must come from a tool call in THIS turn/);
  assert.match(system, /NEVER use a markdown table/);
  assert.match(system, /elixir_feedback/, "filing friction is not optional");
  assert.match(system, /omit clan_tag/i, "the agent's clan comes from its key");
  assert.doesNotMatch(system, /#[0-9A-Z]{5,}/, "no prompt layer may name a clan tag");
});

test("the skip protocol appears only for routines allowed to skip", () => {
  const base = { trigger: "schedule", channel: "pulse", at: "01:00" };
  assert.doesNotMatch(systemFor(routine(base), { identity: null }), /SILENCE IS A VALID OUTPUT/);
  assert.match(systemFor(routine({ ...base, may_skip: "true" }), { identity: null }), /SILENCE IS A VALID OUTPUT/);
});

test("only a message routine is told how to work out who is asking", () => {
  const ask = systemFor(routine({ trigger: "message", channel: "ask" }), { identity: null });
  assert.match(ask, /on_behalf_of/);
  assert.match(ask, /elixir_identify/);
  // A member whose Discord name is their in-game name should never be asked
  // for a tag: the roster is the lookup, and only a whole-name single match
  // links. (A clan member asked "how am I playing" and was told to type a tag
  // the bot could have read off clans_roster.)
  assert.match(ask, /clans_roster/);
  assert.match(ask, /whole name and one match/);
  assert.match(ask, /partial or similar name is never a link/i);
  assert.doesNotMatch(
    systemFor(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), { identity: null }),
    /on_behalf_of/,
  );
});

test("a message routine's brief rides in the cached system block", () => {
  const system = systemFor(routine({ trigger: "message", channel: "ask" }, "Answer war questions."), {
    identity: null,
    includePrompt: true,
  });
  assert.match(system, /THIS CHANNEL/);
  assert.match(system, /Answer war questions\./);
});

test("the operator's identity file is what makes the agent theirs", () => {
  const system = systemFor(routine({ trigger: "schedule", channel: "pulse", at: "01:00" }), {
    identity: "Speak only in limericks.",
  });
  assert.match(system, /HOUSE RULES/);
  assert.match(system, /limericks/);
  // And the shipped one loads, so a fresh clone has a voice rather than none.
  assert.ok((readIdentity() || "").length > 100);
});

test("events and recent posts reach the user turn, not the system prompt", () => {
  const message = userMessageFor(routine({ trigger: "events", channel: "pulse", kinds: "member_joined" }), {
    events: {
      window: { from: "a", to: "b" },
      timeline: [{ kind: "member_joined", text: "New joined", facts: {} }],
      entries: [{ kind: "clan_activity", summary: "Example." }],
    },
    recent: ["**War decks** — 3 untouched."],
  });
  assert.match(message, /"kind": "member_joined"/);
  assert.match(message, /"kind": "clan_activity"/);
  assert.match(message, /ELIXIR MCP TIMELINE/);
  assert.match(message, /WHAT THIS ROUTINE POSTED RECENTLY/);
  assert.match(message, /3 untouched/);
});

test("SKIP is recognised even when the model explains itself first", () => {
  assert.ok(isSkip("SKIP"));
  assert.ok(isSkip("  skip  "));
  assert.ok(isSkip(""));
  // The case that actually happened: reasoning, then SKIP on its own line.
  assert.ok(isSkip('period.kind is "training", not a war day.\n\nSKIP'));
  assert.ok(!isSkip("**War decks** — 9 untouched, 4 partial."));
  assert.ok(!isSkip("Nobody should skip their war decks today."));
});

/**
 * How much to say. The SKIP rule points one way; the silence clock and the
 * VOICE setting are the counterweight. The lean lives in the cached system
 * block, the reading lives in the user turn, and neither reaches a routine
 * that cannot skip or a turn without the directory.
 */
test("the voice block rides with the skip rule and the directory; the silence line names who is past the line", async () => {
  const { VOICES, silenceLine } = await import("../src/prompt.js");
  const entries = [{ id: "11", name: "news", topic: "", visibility: "everyone", threads: false, role: null }];
  const may = routine({ trigger: "schedule", at: "01:00", may_skip: true });
  const must = routine({ trigger: "schedule", at: "01:00" });

  assert.equal(VOICES.quiet.hours, 72);
  assert.equal(VOICES.normal.hours, 12);
  assert.equal(VOICES.chatty.hours, 4);
  assert.match(systemFor(may, { entries, voice: "chatty" }), /HOW MUCH TO SAY: chatty/);
  assert.match(systemFor(may, { entries, voice: "nonsense" }), /HOW MUCH TO SAY: normal/, "an unknown level is normal");
  assert.doesNotMatch(systemFor(must, { entries }), /HOW MUCH TO SAY/, "a routine that cannot skip has no lean");
  assert.doesNotMatch(systemFor(may, { entries: [] }), /HOW MUCH TO SAY/, "no directory, no clock, no lean");

  const now = new Date("2026-09-16T17:30:00Z");
  const silence = [
    {
      channelId: "11",
      name: "news",
      hours: 29,
      at: new Date("2026-09-15T12:31:00Z"),
      atLeast: false,
      routine: "notable-movers",
    },
    {
      channelId: "12",
      name: "leaders",
      hours: 150,
      at: new Date("2026-09-10T12:00:00Z"),
      atLeast: true,
      routine: null,
    },
    {
      channelId: "13",
      name: "fresh",
      hours: 2,
      at: new Date("2026-09-16T15:30:00Z"),
      atLeast: false,
      routine: "clan-feed",
    },
  ];
  const line = silenceLine(silence, { level: "normal", timezone: "UTC" });
  assert.match(line, /^\[silence, your line is 12h: #news 29h \(last: notable-movers, Tue 12:31\) — past the line;/);
  assert.match(line, /#leaders ≥6d \(no post since the clock started\) — past the line;/);
  assert.match(line, /#fresh 2h \(last: clan-feed, Wed 15:30\)\]$/, "under the line is a fact, not a lean");
  assert.doesNotMatch(
    silenceLine(silence, { level: "chatty", timezone: "UTC" }),
    /#fresh 2h[^;]*past/,
    "chatty: 2h is still under 4h",
  );
  assert.doesNotMatch(
    silenceLine(silence, { level: "quiet", timezone: "UTC" }),
    /#news 29h[^;]*past your line/,
    "quiet: 29h is under 72h",
  );
  assert.equal(silenceLine([], {}), null);

  const user = userMessageFor(may, { withTool: true, silence, now, voice: "normal" });
  assert.match(user, /^\[now: [^\n]*\]\n\n\[silence, your line is 12h: #news 29h/, "the clock sits beside the date");
  assert.doesNotMatch(userMessageFor(must, { withTool: true, silence, now }), /\[silence:/);
  assert.doesNotMatch(userMessageFor(may, { withTool: false, silence, now }), /\[silence:/);
});
