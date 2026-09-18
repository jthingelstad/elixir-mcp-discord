/**
 * The feed lane's judgment since contract 3.0.0: the timeline says what
 * happened, and a routine wakes only for the kinds (or sections) it named —
 * because an active clan produces a battle_session in nearly every window.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  relevant,
  noteworthy,
  shouldReadFeedback,
  partition,
  releaseDue,
  subscribedKinds,
  readerName,
  CARRY_RELEASE_HOURS,
} from "../src/events.js";

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

/**
 * The batch (2026-09-17): wake kinds start a turn, carry kinds ride along
 * or wait, and the carry release is the VOICE line over the silence clock.
 */
test("wake and carry partition a window; the server is asked for both; kinds alone still wakes on everything named", () => {
  const editor = { wake: ["member_joined", "returned"], carry: ["ranked_promotion"] };
  const split = partition(timeline, editor);
  assert.deepEqual(
    split.wake.map((i) => i.kind),
    ["member_joined", "returned"],
  );
  assert.deepEqual(
    split.carry.map((i) => i.kind),
    ["ranked_promotion"],
  );
  assert.deepEqual(subscribedKinds(editor), ["member_joined", "returned", "ranked_promotion"]);
  const legacy = { kinds: ["member_joined", "ranked_promotion"] };
  assert.deepEqual(
    partition(timeline, legacy).wake.map((i) => i.kind),
    ["member_joined", "ranked_promotion"],
  );
  assert.deepEqual(partition(timeline, legacy).carry, []);
  assert.deepEqual(subscribedKinds(legacy), ["member_joined", "ranked_promotion"]);
  assert.equal(subscribedKinds({}), null, "a routine naming nothing reads everything");
});

test("the carry release: quiet never, normal 12h, chatty 4h, paced by channels the bot has posted in", () => {
  assert.deepEqual(CARRY_RELEASE_HOURS, { quiet: null, normal: 12, chatty: 4 });
  const silences = [
    { channelId: "1", name: "news", hours: 13, atLeast: false },
    { channelId: "2", name: "leaders", hours: 200, atLeast: true },
  ];
  assert.equal(releaseDue(silences, { voice: "normal" }), true, "13h in the posted channel passes 12h");
  assert.equal(releaseDue(silences, { voice: "quiet" }), false, "quiet never releases");
  assert.equal(releaseDue([{ channelId: "1", name: "news", hours: 5, atLeast: false }], { voice: "chatty" }), true);
  assert.equal(releaseDue([{ channelId: "1", name: "news", hours: 3, atLeast: false }], { voice: "chatty" }), false);
  assert.equal(
    releaseDue(
      [
        { channelId: "1", name: "news", hours: 2, atLeast: false },
        { channelId: "2", name: "leaders", hours: 200, atLeast: true },
      ],
      { voice: "normal" },
    ),
    false,
    "a never-posted channel does not pace the release while a posted one is fresh",
  );
  assert.equal(
    releaseDue([{ channelId: "2", name: "leaders", hours: 20, atLeast: true }], { voice: "normal" }),
    true,
    "with no posted channel at all, first sight paces it",
  );
  assert.equal(releaseDue([], { voice: "chatty" }), false);
  assert.equal(releaseDue(silences, { voice: "nonsense" }), true, "an unknown level is normal");
});

test("the reader name is the instance and the routine in the hub's alphabet, at most 32 characters", () => {
  // The instance directory under test is the checkout itself.
  const name = readerName("editor");
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,31}$/);
  assert.ok(name.length <= 32, name);
  assert.match(readerName("War Deck Check!"), /^[a-z0-9][a-z0-9-]{0,31}$/);
  assert.ok(readerName("x".repeat(60)).length <= 32);
  assert.notEqual(readerName("editor"), readerName("clock"), "two routines are two readers");
});
