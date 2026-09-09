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
  parseRoutine("r", `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`);

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
  assert.match(
    systemFor(routine({ ...base, may_skip: "true" }), { identity: null }),
    /SILENCE IS A VALID OUTPUT/,
  );
});

test("only a message routine is told how to work out who is asking", () => {
  const ask = systemFor(routine({ trigger: "message", channel: "ask" }), { identity: null });
  assert.match(ask, /on_behalf_of/);
  assert.match(ask, /elixir_identify/);
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
  const message = userMessageFor(routine({ trigger: "events", channel: "pulse", topics: "clan_pulse" }), {
    events: [{ event_id: 7, topic: "clan_pulse" }],
    recent: ["**War decks** — 3 untouched."],
  });
  assert.match(message, /"event_id": 7/);
  assert.match(message, /ALREADY POSTED/);
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
