/**
 * The runner is what every trigger except a member's message goes through, so
 * a bug here is silent: a scheduled post that never lands, or the word SKIP
 * arriving in a channel as though it were the news.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runRoutine } from "../src/run.js";
import { parseRoutine } from "../src/routines.js";

function fakeChannel() {
  const sent = [];
  const channel = {
    sent,
    send: (text) => {
      const message = { text, replies: [] };
      sent.push(message);
      return Promise.resolve({
        reply: (body) => {
          message.replies.push(typeof body === "string" ? body : body.content);
          return Promise.resolve({});
        },
      });
    },
    messages: { fetch: () => Promise.resolve(new Map()) },
  };
  return channel;
}

const answer = (text, extra = {}) => ({
  ok: true,
  text,
  called: ["war_current"],
  errors: [],
  trace: [{ kind: "tool", name: "war_current", input: {}, shape: "1 clans" }],
  envelopes: [],
  usd: 0.01,
  turnId: "aaaa1111",
  ms: 1200,
  rounds: 1,
  stopReason: "end_turn",
  truncated: false,
  model: "claude-sonnet-5",
  effort: "medium",
  serverVersion: "0.31.0+tools.abc",
  ...extra,
});

const routine = (
  fields,
  body = "Report the war decks, and skip if it is not a war day.",
) =>
  parseRoutine(
    "war-deck-check",
    `---\n${Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n---\n${body}`,
  );

test("a routine's answer reaches its channel", async () => {
  const channel = fakeChannel();
  const run = await runRoutine(
    routine({ trigger: "schedule", channel: "pulse", at: "01:00" }),
    {
      channel,
      askFn: async () => answer("**War decks** — 3 untouched."),
    },
  );
  assert.equal(run.ok, true);
  assert.equal(run.skipped, false);
  assert.equal(channel.sent[0].text, "**War decks** — 3 untouched.");
  assert.equal(channel.sent[0].replies.length, 0, "no trace unless asked for");
});

test("SKIP posts nothing at all", async () => {
  const channel = fakeChannel();
  const run = await runRoutine(
    routine({
      trigger: "schedule",
      channel: "pulse",
      at: "01:00",
      may_skip: "true",
    }),
    {
      channel,
      askFn: async () => answer('period.kind is "training".\n\nSKIP'),
    },
  );
  assert.equal(run.skipped, true);
  assert.equal(channel.sent.length, 0, "a quiet day must stay quiet");
});

test("a routine that may NOT skip posts what it said", async () => {
  // Otherwise a prompt bug is invisible: the routine looks like it ran and the
  // channel looks like a quiet day, forever.
  const channel = fakeChannel();
  const run = await runRoutine(
    routine({ trigger: "schedule", channel: "pulse", at: "01:00" }),
    {
      channel,
      askFn: async () => answer("SKIP"),
    },
  );
  assert.equal(run.skipped, false);
  assert.equal(channel.sent.length, 1);
});

test("trace: true attaches the diagnostics under the post", async () => {
  const channel = fakeChannel();
  await runRoutine(
    routine({
      trigger: "schedule",
      channel: "pulse",
      at: "01:00",
      trace: "true",
    }),
    {
      channel,
      askFn: async () => answer("**War decks** — 3 untouched."),
    },
  );
  assert.match(channel.sent[0].replies[0], /war_current/);
  assert.match(channel.sent[0].replies[0], /aaaa1111/);
});

test("a long post is split rather than truncated", async () => {
  const channel = fakeChannel();
  const long = Array.from(
    { length: 60 },
    (_, i) => `line ${i} ${"x".repeat(40)}`,
  ).join("\n");
  await runRoutine(
    routine({
      trigger: "schedule",
      channel: "pulse",
      at: "01:00",
      max_chars: 900,
    }),
    {
      channel,
      askFn: async () => answer(long),
    },
  );
  assert.ok(channel.sent.length > 1, "expected more than one message");
  for (const message of channel.sent) assert.ok(message.text.length <= 900);
  assert.equal(channel.sent.map((m) => m.text).join("\n"), long);
});

test("a dry run composes without touching Discord", async () => {
  const run = await runRoutine(
    routine({ trigger: "schedule", channel: "pulse", at: "01:00" }),
    {
      dryRun: true,
      askFn: async () => answer("Would have posted this."),
    },
  );
  assert.equal(run.text, "Would have posted this.");
});

test("a failed turn is reported, not posted", async () => {
  const channel = fakeChannel();
  const run = await runRoutine(
    routine({ trigger: "schedule", channel: "pulse", at: "01:00" }),
    {
      channel,
      askFn: async () => ({
        ok: false,
        error: "overloaded_error",
        called: [],
        errors: [],
        trace: [],
      }),
    },
  );
  assert.equal(run.ok, false);
  assert.equal(run.error, "overloaded_error");
  assert.equal(channel.sent.length, 0);
});

/**
 * The runner has to REFUSE, not merely report.
 *
 * A budget checked after the fact is a receipt. These pin that a spent lane
 * never reaches the model at all — the injected askFn is the proof, because a
 * call that never happens cannot cost anything.
 */
test("a routine whose lane is spent never calls the model", async () => {
  const { config } = await import("../src/config.js");
  const budget = await import("../src/budget.js");
  const fs = await import("node:fs");
  fs.rmSync(process.env.STATE_PATH, { force: true });
  config.monthlyBudgetUsd = 1;
  budget.record("routines", 1);

  const channel = fakeChannel();
  let called = false;
  const run = await runRoutine(
    routine({ trigger: "schedule", channel: "pulse", at: "01:00" }),
    {
      channel,
      askFn: async () => {
        called = true;
        return answer("should never be composed");
      },
    },
  );

  assert.equal(called, false, "the model was not called");
  assert.equal(run.ok, false);
  assert.match(run.error, /^budget:/);
  assert.equal(channel.sent.length, 0);
  config.monthlyBudgetUsd = null;
  fs.rmSync(process.env.STATE_PATH, { force: true });
});

test("the runner charges the lane the trigger belongs to", async () => {
  // Recording happens inside the model call (one place, always), so what the
  // RUNNER owes is the lane it hands over. An injected askFn is exactly the
  // seam to read that from.
  const channel = fakeChannel();
  let seen = null;
  await runRoutine(
    routine({ trigger: "schedule", channel: "pulse", at: "01:00" }),
    {
      channel,
      askFn: async (args) => {
        seen = args;
        return answer("posted");
      },
    },
  );
  assert.equal(
    seen.lane,
    "routines",
    "a scheduled post is the operator's cost",
  );
  assert.equal(seen.routineKey, "war-deck-check");
  assert.equal(seen.maxTokens, 6000, "the routine's own output ceiling");
});
