/**
 * The friction sweep decides on the contract's error CODES, not on the English
 * of a message. Two codes are the service working as designed and must never
 * cost a reflection call; everything else is still a signal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsFiling, detectFriction, readFeedbackPages, selectFreshResponses } from "../src/feedback.js";
import { feedbackResponseText, shouldReadFeedback } from "../src/events.js";

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

test("a retry-class error (hub 3.18.0) is the service working, not friction; the class is read before the code", () => {
  // live_pending and query_timeout carry class "retry" since 3.18.0 and
  // used to print a failure footer and fire a sweep.
  assert.equal(
    detectFriction(
      turn([{ name: "clans_roster", code: "live_pending", class: "retry", detail: "Queued; call again in 20 s." }]),
    ),
    null,
  );
  assert.equal(
    detectFriction(turn([{ name: "battles_meta_decks", code: "query_timeout", detail: "Budget exceeded." }])),
    null,
    "the code alone still counts as expected on a hub without classes",
  );
  // A class the hub calls server is friction whatever the code.
  const friction = detectFriction(
    turn([{ name: "battles_levels", code: "internal", class: "server", detail: "Failed unexpectedly." }]),
  );
  assert.deepEqual(friction.codes, ["internal"]);
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
      called: ["elixir_send_feedback"],
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

test("a reply that says it filed, with no elixir_send_feedback call, is friction of its own kind", () => {
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
      called: ["players_search", "elixir_send_feedback"],
      errors: [],
    }),
    null,
  );
  // Ordinary replies do not trip it.
  assert.equal(claimsFiling("Your win rate this week is 54% over 31 battles."), false);
  assert.equal(claimsFiling("I'll file that with the maintainer now."), true);
  assert.equal(claimsFiling("Feedback has been submitted."), true);
});

test("a needs_info question and the answer after it are both shown; an old bare id is upgraded in place (hub 11.10.0)", () => {
  const asked = {
    feedback_id: "12",
    message: "The war tool rounds fame.",
    response: "Which week did you read?",
    status: "needs_info",
    responded_at: "2026-10-11T18:00:00Z",
  };
  const old = {
    feedback_id: "7",
    message: "Old",
    response: "Fixed.",
    status: "done",
    responded_at: "2026-10-01T00:00:00Z",
  };

  // The ledger from before 11.10.0 holds bare ids: 7 was shown, 12 is new.
  const first = selectFreshResponses([asked, old], [7]);
  assert.deepEqual(
    first.fresh.map((f) => [f.id, f.key, f.status]),
    [["12", "12@2026-10-11T18:00:00Z", "needs_info"]],
  );
  assert.deepEqual(first.ledger, ["7@2026-10-01T00:00:00Z"], "7 upgraded; 12 waits until delivered");

  // Delivered, then answered again on the same item: the outcome is new.
  const ledger = [...first.ledger, "12@2026-10-11T18:00:00Z"];
  assert.deepEqual(selectFreshResponses([asked, old], ledger).fresh, []);
  const closed = { ...asked, status: "done", response: "Fixed in 11.11.0.", responded_at: "2026-10-12T15:00:00Z" };
  assert.deepEqual(
    selectFreshResponses([closed, old], ledger).fresh.map((f) => f.key),
    ["12@2026-10-12T15:00:00Z"],
  );
  assert.deepEqual(selectFreshResponses([closed, old], [], { seedOnly: true }), {
    fresh: [],
    ledger: ["12@2026-10-12T15:00:00Z", "7@2026-10-01T00:00:00Z"],
  });
});

test("a needs_info answer reaches the DM as a question with how to reply", () => {
  const text = feedbackResponseText({
    id: "12",
    message: "The war tool rounds fame.",
    response: "Which week did you read?",
    shippedIn: null,
    status: "needs_info",
  });
  assert.match(text, /^\*\*Elixir MCP asked a question about feedback #12/);
  assert.match(text, /follows_id 12/);
  const done = feedbackResponseText({ id: "12", message: "m", response: "r", shippedIn: "11.10.0", status: "done" });
  assert.match(done, /^\*\*Elixir MCP answered feedback this agent filed\*\* \(shipped in 11\.10\.0\)/);
  assert.doesNotMatch(done, /follows_id/);
});

test("a bare id from the old ledger does not hide an answer newer than the cutoff (Codex on #55)", () => {
  const cutoff = "2026-10-11T13:30:00Z";
  const answered = (respondedAt) => ({
    feedback_id: "12",
    message: "m",
    response: "r",
    status: "needs_info",
    responded_at: respondedAt,
  });
  // The old code showed #12's answer: it is older than the cutoff, so the
  // bare id covers it and is upgraded.
  const older = selectFreshResponses([answered("2026-10-10T09:00:00Z")], ["12"], { legacyCutoff: cutoff });
  assert.deepEqual(older.fresh, []);
  assert.deepEqual(older.ledger, ["12@2026-10-10T09:00:00Z"]);
  // #12 was answered again after this version booted, before the first read:
  // new, and the bare id is not upgraded onto it.
  const newer = selectFreshResponses([answered("2026-10-11T14:00:00Z")], ["12"], { legacyCutoff: cutoff });
  assert.deepEqual(
    newer.fresh.map((f) => f.key),
    ["12@2026-10-11T14:00:00Z"],
  );
  assert.deepEqual(newer.ledger, []);
});
