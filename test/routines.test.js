/**
 * A routine file is the whole configuration surface of this bot, and it is
 * edited by hand at 1am by somebody tuning a prompt. Every mistake it is
 * possible to make in one should produce a named error, not a routine that
 * loads and quietly never fires.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoutine, splitFrontMatter, loadRoutines } from "../src/routines.js";

const doc = (fields, body = "Say something useful about the clan.") =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n${body}`;

test("a schedule routine parses its clock, days and window", () => {
  const routine = parseRoutine(
    "meta",
    doc({ trigger: "schedule", channel: "Pulse", at: "15:00", days: "sun,wed", catch_up_hours: 8 }),
  );
  assert.equal(routine.trigger, "schedule");
  assert.equal(routine.channel, "pulse", "channel names are case-insensitive");
  assert.deepEqual(routine.at, { hour: 15, minute: 0 });
  assert.deepEqual(routine.days, [0, 3]);
  assert.equal(routine.catchUpHours, 8);
  assert.equal(routine.trace, false, "only message routines trace by default");
});

test("an events routine must name topics, and a schedule routine must not", () => {
  const events = parseRoutine("feed", doc({ trigger: "events", channel: "pulse", topics: "[clan_pulse, war_day_open]" }));
  assert.deepEqual(events.topics, ["clan_pulse", "war_day_open"]);
  assert.throws(
    () => parseRoutine("feed", doc({ trigger: "events", channel: "pulse" })),
    /must name its topics/,
  );
  assert.throws(
    () => parseRoutine("x", doc({ trigger: "schedule", channel: "pulse", at: "01:00", topics: "clan_pulse" })),
    /topics only mean something/,
  );
});

test("a message routine defaults to tracing and to eight turns of history", () => {
  const routine = parseRoutine("ask", doc({ trigger: "message", channel: "ask" }));
  assert.equal(routine.trace, true);
  assert.equal(routine.historyTurns, 8);
  assert.equal(routine.maxChars, 2000);
});

test("the mistakes that would otherwise fail silently are errors", () => {
  const bad = [
    [{ trigger: "hourly", channel: "pulse" }, /trigger must be one of/],
    [{ trigger: "schedule", channel: "pulse" }, /at must be HH:MM/],
    [{ trigger: "schedule", channel: "pulse", at: "25:00" }, /not a real time/],
    [{ trigger: "schedule", channel: "pulse", at: "01:00", days: "funday" }, /not a weekday/],
    // The one this rule exists for: a near-miss field name would otherwise be
    // ignored, and the routine would catch up forever with the default window.
    [{ trigger: "schedule", channel: "pulse", at: "01:00", catchup_hours: 3 }, /unknown field/],
    [{ trigger: "schedule", channel: "pulse", at: "01:00", may_skip: "sometimes" }, /must be true or false/],
    [{ trigger: "message" }, /needs a channel/],
  ];
  for (const [fields, pattern] of bad) {
    assert.throws(() => parseRoutine("bad", doc(fields)), pattern, JSON.stringify(fields));
  }
  assert.throws(() => parseRoutine("bad", doc({ trigger: "message", channel: "ask" }, "")), /no prompt/);
  assert.throws(() => parseRoutine("bad", "no front matter here"), /no front matter/);
});

test("front matter is separated from the prompt, comments and all", () => {
  const { fields, body } = splitFrontMatter("---\n# a note\ntrigger: message\n---\nThe prompt.\n");
  assert.deepEqual(fields, { trigger: "message" });
  assert.equal(body, "The prompt.");
});

test("the shipped bundle loads, is uniquely keyed, and names no clan", () => {
  const { routines, errors } = loadRoutines({ disabled: new Set() });
  assert.deepEqual(errors, [], "every shipped routine must parse");
  assert.ok(routines.length >= 6);

  const keys = new Set();
  for (const routine of routines) {
    assert.ok(!keys.has(routine.key), `duplicate key ${routine.key}`);
    keys.add(routine.key);
    assert.ok(routine.prompt.length > 80, `${routine.key} prompt looks empty`);

    // The rule this whole refactor exists to enforce: the agent key already
    // knows which clan it acts for, so nothing shipped here may name one. A CR
    // tag in a prompt would teach the model to pass clan_tag explicitly, which
    // is exactly what the agent door removes — and would be wrong the day the
    // key is repointed.
    assert.doesNotMatch(routine.prompt, /#[0-9A-Z]{5,}/, `${routine.key} names a Clash Royale tag`);
  }
  assert.ok(routines.some((routine) => routine.trigger === "message"));
  assert.ok(routines.some((routine) => routine.trigger === "events"));
  assert.ok(routines.filter((routine) => routine.trigger === "schedule").length >= 4);
});

test("a routine can be turned off by key without editing it", () => {
  const { routines } = loadRoutines({ disabled: new Set(["meta-report"]) });
  assert.equal(routines.find((routine) => routine.key === "meta-report").disabled, true);
  assert.equal(routines.find((routine) => routine.key === "ask").disabled, false);
});
