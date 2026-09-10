/**
 * The friction sweep decides on the contract's error CODES, not on the English
 * of a message. Two codes are the service working as designed and must never
 * cost a reflection call; everything else is still a signal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectFriction } from "../src/feedback.js";
import { shouldReadFeedback } from "../src/events.js";

const turn = (errors, text = "Here is the answer.") => ({
  text,
  called: ["players_summary"],
  errors,
});

test("a tool error is friction, and the sweep is told its code", () => {
  const friction = detectFriction(
    turn([{ name: "war_history", code: "invalid_tag", detail: "Tag '#OOPS' is not a tag." }]),
  );
  assert.equal(friction.reason, "tool_error");
  assert.deepEqual(friction.codes, ["invalid_tag"]);
  assert.match(friction.detail, /war_history \[invalid_tag\]: Tag/);
});

test("no_subject and quota_exceeded are expected flows, not friction", () => {
  assert.equal(
    detectFriction(turn([{ name: "players_summary", code: "no_subject", detail: "Nobody to answer about." }])),
    null,
  );
  assert.equal(
    detectFriction(turn([{ name: "battles_query", code: "quota_exceeded", detail: "Daily quota reached." }])),
    null,
  );
  // Mixed: the expected one is dropped, the other still files.
  const friction = detectFriction(
    turn([
      { name: "players_summary", code: "no_subject", detail: "Nobody." },
      { name: "clans_roster", code: "not_recorded", detail: "Clan is not recorded." },
    ]),
  );
  assert.deepEqual(friction.codes, ["not_recorded"]);
  assert.doesNotMatch(friction.detail, /no_subject/);
});

test("an error without a code is still friction", () => {
  // A protocol-level failure (unknown tool, no JSON body) carries no code and
  // is exactly the kind of thing worth a look.
  const friction = detectFriction(turn([{ name: "unknown", code: null, detail: "Method not found" }]));
  assert.equal(friction.reason, "tool_error");
  assert.deepEqual(friction.codes, []);
  assert.match(friction.detail, /^unknown: Method not found$/);
});

test("a filed turn and a clean turn are not friction", () => {
  assert.equal(detectFriction({ text: "ok", called: ["elixir_feedback"], errors: [{ name: "x", code: "not_found", detail: "d" }] }), null);
  assert.equal(detectFriction(turn([])), null);
  assert.equal(detectFriction(turn([], "I can't see donation history.")).reason, "conceded_limit");
});

test("the feedback ledger is read on the hint, always on the seeding run, and when no hint arrived", () => {
  assert.equal(shouldReadFeedback({ seeded: false, pending: 0 }), true, "seeding run marks history shown");
  assert.equal(shouldReadFeedback({ seeded: true, pending: 0 }), false, "0 pending is the whole point");
  assert.equal(shouldReadFeedback({ seeded: true, pending: 2 }), true);
  assert.equal(shouldReadFeedback({ seeded: true, pending: undefined }), true, "pre-1.0.0 feed envelope");
  assert.equal(shouldReadFeedback({ seeded: true, pending: null }), true);
});
