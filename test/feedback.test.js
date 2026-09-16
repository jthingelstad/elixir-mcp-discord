/**
 * The friction sweep decides on the contract's error CODES, not on the English
 * of a message. Two codes are the service working as designed and must never
 * cost a reflection call; everything else is still a signal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsFiling, detectFriction, readFeedbackPages } from "../src/feedback.js";
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
  assert.equal(
    detectFriction({
      text: "ok",
      called: ["elixir_feedback"],
      errors: [{ name: "x", code: "not_found", detail: "d" }],
    }),
    null,
  );
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

test("the feedback reader follows every bounded page and keeps the first call compatible", async () => {
  const calls = [];
  const result = await readFeedbackPages(async (args) => {
    calls.push(args);
    if (args.offset === undefined) {
      return {
        ok: true,
        body: { feedback: [{ feedback_id: 3 }], next_offset: 1 },
      };
    }
    return {
      ok: true,
      body: {
        feedback: [{ feedback_id: 2 }, { feedback_id: 1 }],
        next_offset: null,
      },
    };
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.items.map((item) => item.feedback_id),
    [3, 2, 1],
  );
  assert.deepEqual(calls, [{ limit: 50 }, { limit: 50, offset: 1 }]);
});

test("a turn that took many calls is friction, tallied by tool", () => {
  // Thirteen per-member battles_performance calls in one movers post never
  // filed anything: no error, no conceded limit, and nothing counted.
  const called = ["clans_roster", ...Array(12).fill("battles_performance")];
  const friction = detectFriction({ text: "Three standouts.", called, errors: [] });
  assert.equal(friction.reason, "many_calls");
  assert.equal(friction.count, 13);
  assert.match(friction.detail, /^battles_performance ×12, clans_roster$/);
  // Seven is a busy turn, not a complaint.
  assert.equal(detectFriction({ text: "ok", called: Array(7).fill("x"), errors: [] }), null);
});

test("a failed call's request_id rides into the sweep", () => {
  const friction = detectFriction(
    turn([
      {
        name: "battles_meta_cards",
        code: null,
        detail: "Connection closed",
        requestId: "dc5ec8de-b919-4934-97af-4dd95433a4ff",
      },
    ]),
  );
  assert.deepEqual(friction.requestIds, ["dc5ec8de-b919-4934-97af-4dd95433a4ff"]);
  assert.match(friction.detail, /req dc5ec8de/);
});

test("figures with no tool call are ungrounded, unless the feed supplied them", async () => {
  const { looksUngrounded } = await import("../src/feedback.js");
  assert.equal(looksUngrounded({ text: "You are 55-38 this month.", called: [] }), true);
  assert.equal(looksUngrounded({ text: "You are 55-38 this month.", called: ["players_summary"] }), false);
  assert.equal(
    looksUngrounded({ text: "Two members joined.", called: [], events: [{ kind: "clan_activity" }] }),
    false,
  );
  assert.equal(looksUngrounded({ text: "Which player are you?", called: [] }), false, "no figures, no problem");
});

test("a reply that says it filed, with no elixir_feedback call, is friction of its own kind", () => {
  // 2026-09-15, the operator's DM: "Filed as a data-quality bug against
  // elixir_timeline ... with the request_id attached" after four reads and
  // no filing. The words and the calls disagreed and nothing compared them.
  const claimed = detectFriction({
    text: "Filed as a data-quality bug against elixir_timeline, with the request_id attached so the maintainer can see exactly what I saw.",
    called: ["players_search", "elixir_timeline", "players_profile"],
    errors: [],
  });
  assert.equal(claimed.reason, "claimed_filing");
  assert.match(claimed.detail, /^Filed as a data-quality bug/);
  // It outranks the other signatures: a conceded limit in the same reply is
  // not the headline when the reply also claims a filing.
  assert.equal(
    detectFriction({
      text: "I can't see that, so I'm filing it as a gap.",
      called: ["players_summary"],
      errors: [],
    }).reason,
    "claimed_filing",
  );
  // The call makes the claim true, and then it is not friction at all.
  assert.equal(
    detectFriction({
      text: "Filed as a data-quality bug.",
      called: ["players_search", "elixir_feedback"],
      errors: [],
    }),
    null,
  );
  // Ordinary replies do not trip it.
  assert.equal(claimsFiling("Your win rate this week is 54% over 31 battles."), false);
  assert.equal(claimsFiling("I'll file that with the maintainer now."), true);
  assert.equal(claimsFiling("Feedback has been submitted."), true);
});
