/**
 * The feed lane's judgment since contract 3.0.0: the timeline says what
 * happened, and a routine wakes only for the kinds (or sections) it named —
 * because an active clan produces a battle_session in nearly every window.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { relevant, noteworthy, shouldReadFeedback } from "../src/events.js";

const timeline = [
  {
    at: "2026-09-13T21:00:00Z",
    subject_tag: "#A",
    subject_name: "sikander",
    kind: "battle_session",
    section: "activity",
    text: "sikander played 12 battles",
    facts: { battles: 12 },
  },
  {
    at: "2026-09-13T21:05:00Z",
    subject_tag: "#B",
    subject_name: "New",
    kind: "member_joined",
    section: "roster",
    text: "New joined",
    facts: {},
  },
  {
    at: "2026-09-13T21:06:00Z",
    subject_tag: "#C",
    subject_name: "Ollie",
    kind: "ranked_promotion",
    section: "standouts",
    text: "Ollie reached Champion",
    facts: { league: "Champion" },
  },
  {
    at: "2026-09-13T21:07:00Z",
    subject_tag: "#D",
    subject_name: "hamster",
    kind: "returned",
    section: "presence",
    text: "hamster is back after 7 days",
    facts: { after_days: 7 },
  },
];

test("a routine wakes for its kinds, or its sections, or everything if it names neither", () => {
  assert.deepEqual(
    relevant(timeline, { kinds: ["member_joined", "member_left"] }).map((i) => i.kind),
    ["member_joined"],
  );
  assert.deepEqual(
    relevant(timeline, { sections: ["roster", "presence"] }).map((i) => i.kind),
    ["member_joined", "returned"],
  );
  assert.deepEqual(relevant(timeline, { kinds: ["returned"], sections: ["roster"] }), [], "both filters apply");
  assert.equal(relevant(timeline, {}).length, 4, "no filter is every item, battle sessions included");
  assert.equal(noteworthy(timeline, { kinds: ["week_resolved"] }), false);
  assert.equal(noteworthy(timeline, { kinds: ["member_joined"] }), true);
  assert.equal(noteworthy([], {}), false);
  assert.equal(noteworthy(undefined, {}), false);
});

test("the feedback ledger is read on the hint, always on the seeding run", () => {
  assert.equal(shouldReadFeedback({ seeded: false, pending: 0 }), true);
  assert.equal(shouldReadFeedback({ seeded: true, pending: 0 }), false);
  assert.equal(shouldReadFeedback({ seeded: true, pending: 2 }), true);
  assert.equal(
    shouldReadFeedback({ seeded: true, pending: undefined }),
    true,
    "no hint degrades to the old cost, never to silence",
  );
});
