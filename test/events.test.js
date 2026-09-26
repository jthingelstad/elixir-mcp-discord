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
  readWindow,
  pollRoutine,
  eventsForDryRun,
  CARRY_RELEASE_HOURS,
} from "../src/events.js";
import * as state from "../src/state.js";

const timeline = [
  {
    at: "2026-09-13T21:00:00Z",
    subject_tag: "#A",
    subject_name: "sam",
    kind: "battle_session",
    section: "activity",
    text: "sam played 12 battles",
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

/**
 * A fake `elixir_timeline` with the hub's busy-window rule (contract 7.0.0):
 * select by observed_at over (from, to], keep the newest `pageSize` by
 * observed instant, count the rest in timeline_more, set has_more, serve
 * newest first, next_cursor at the window's end. `now` stands in for the
 * clock. Every call is recorded.
 */
function fakeHub(items, { pageSize = 3, now = "2026-09-25T12:00:00.000Z" } = {}) {
  const calls = [];
  const observed = (it) => Date.parse(it.observed_at ?? it.at);
  const iso = (ms) => new Date(ms).toISOString();
  const call = async (name, args) => {
    calls.push({ name, args });
    const toMs = Math.min(args.to ? Date.parse(args.to) : Infinity, Date.parse(now));
    const fromMs = args.from ? Date.parse(args.from) : toMs - 86_400_000;
    const all = items.filter(
      (it) => observed(it) > fromMs && observed(it) <= toMs && (!args.kinds || args.kinds.includes(it.kind)),
    );
    const byObserved = [...all].sort((a, b) => observed(b) - observed(a));
    const leftOut = byObserved.slice(pageSize);
    const cutMs = leftOut.length ? observed(leftOut[0]) : null;
    const timeline = (cutMs === null ? all : all.filter((it) => observed(it) > cutMs)).sort(
      (a, b) => Date.parse(b.at) - Date.parse(a.at),
    );
    return {
      ok: true,
      body: {
        window: { from: iso(fromMs), to: iso(toMs) },
        timeline,
        timeline_more: all.length - timeline.length,
        has_more: cutMs !== null,
        entries: [{ kind: "clan", subject_tag: "#CLAN" }],
        next_cursor: iso(toMs),
        meta: {},
      },
    };
  };
  return { call, calls };
}

const moment = (kind, at, observedAt = at, name = kind) => ({
  at,
  observed_at: observedAt,
  subject_tag: `#${name}`,
  subject_name: name,
  kind,
  section: "roster",
  text: `${name} ${kind}`,
  facts: {},
});

// An hour of badges after a join: the join is the oldest item, so the
// newest page never holds it. One item was learned hours after it happened
// (`at` early, observed late) — the continuation pages by observed_at.
const busyHour = [
  moment("member_joined", "2026-09-25T11:00:00.000Z", "2026-09-25T11:00:00.000Z", "joiner"),
  moment("badge_earned", "2026-09-25T11:05:00.000Z", "2026-09-25T11:05:00.000Z", "b1"),
  moment("badge_earned", "2026-09-25T11:10:00.000Z", "2026-09-25T11:10:00.000Z", "b2"),
  moment("returned", "2026-09-25T02:00:00.000Z", "2026-09-25T11:15:00.000Z", "late"),
  moment("badge_earned", "2026-09-25T11:20:00.000Z", "2026-09-25T11:20:00.000Z", "b3"),
  moment("badge_earned", "2026-09-25T11:30:00.000Z", "2026-09-25T11:30:00.000Z", "b4"),
  moment("card_unlocked", "2026-09-25T11:40:00.000Z", "2026-09-25T11:40:00.000Z", "c1"),
  moment("badge_earned", "2026-09-25T11:50:00.000Z", "2026-09-25T11:50:00.000Z", "b5"),
];

test("a busy window is read to its start: older pages by the same from, to at the cut, mark_read false", async () => {
  const key = "busy-window-editor";
  const cursor = "2026-09-25T10:55:00.000Z";
  state.setCursor(key, cursor);
  const editor = {
    key,
    trigger: "events",
    wake: ["member_joined", "returned"],
    carry: ["badge_earned", "card_unlocked"],
  };
  const hub = fakeHub(busyHour, { pageSize: 3 });
  const turns = [];
  const run = async (routine, { events }) => {
    turns.push(events);
    return { ok: true, skipped: false };
  };

  await pollRoutine(editor, null, { call: hub.call, run });

  // The first read is the routine's own reader, marking; every later one
  // continues the SAME window backwards and moves nothing.
  const [first, ...older] = hub.calls.map((c) => c.args);
  assert.equal(first.reader, readerName(key));
  assert.equal(first.mark_read, true);
  assert.equal(first.from, cursor);
  assert.equal(first.to, undefined);
  assert.equal(older.length, 2, "8 items at 3 a page is two more pages");
  for (const args of older) {
    assert.equal(args.mark_read, false);
    assert.equal(args.reader, undefined, "a continuation names no reader");
    assert.equal(args.from, cursor, "the same from");
    assert.deepEqual(args.kinds, first.kinds, "the same kinds");
  }
  assert.ok(older[0].to > older[1].to, "each page reaches further back");

  // One turn, every item exactly once, oldest first — the join included.
  assert.equal(turns.length, 1);
  const names = turns[0].timeline.map((i) => i.subject_name);
  assert.deepEqual(names, ["late", "joiner", "b1", "b2", "b3", "b4", "c1", "b5"]);
  assert.equal(new Set(names).size, busyHour.length, "no item twice");
  // The cursor goes to the window's end, never to a cut.
  assert.equal(state.cursorFor(key), "2026-09-25T12:00:00.000Z");
});

test("the catch-up is bounded, and says what it left unread", async () => {
  const hub = fakeHub(busyHour, { pageSize: 2 });
  const result = await readWindow("2026-09-25T10:55:00.000Z", { reader: "x" }, { call: hub.call, maxPages: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.pages, 2, "the first page and one more");
  assert.equal(hub.calls.length, 2);
  assert.equal(result.timeline.length, 4);
  assert.equal(result.unread, 4, "the older half, counted by the last page");
  assert.deepEqual(
    result.timeline.map((i) => i.subject_name),
    ["b3", "b4", "c1", "b5"],
    "the newest items, oldest first",
  );

  const calm = await readWindow("2026-09-25T10:55:00.000Z", {}, { call: fakeHub(busyHour, { pageSize: 50 }).call });
  assert.equal(calm.pages, 1, "a window that fits is one call");
  assert.equal(calm.unread, 0);

  const failing = async (name, args) =>
    args.to ? { ok: false, error: "transport: boom" } : fakeHub(busyHour, { pageSize: 3 }).call(name, args);
  const failed = await readWindow("2026-09-25T10:55:00.000Z", { reader: "x" }, { call: failing });
  assert.equal(failed.ok, false, "a failed continuation fails the read, so the cursor stays");
});

test("a dry run hands the model the items the way the live lane does: its kinds, oldest first", async () => {
  // No cursor: the rehearsal reads the last 24 hours, which the hub serves
  // newest first. The live lane re-sorts; the rehearsal must too, or it is
  // rehearsing a different prompt.
  const editor = { key: "dry-run-order-editor", wake: ["member_joined", "returned"], carry: ["badge_earned"] };
  const hub = fakeHub(busyHour, { pageSize: 50 });
  const found = await eventsForDryRun(editor, { call: hub.call });
  assert.deepEqual(hub.calls[0].args.kinds, ["member_joined", "returned", "badge_earned"], "the routine's kinds");
  assert.equal(hub.calls[0].args.mark_read, false, "a rehearsal moves nothing");
  assert.equal(hub.calls[0].args.reader, undefined);
  assert.deepEqual(
    found.events.timeline.map((i) => i.subject_name),
    ["late", "joiner", "b1", "b2", "b3", "b4", "b5"],
  );

  // With a cursor, the pending window is read to its start like the live one.
  state.setCursor(editor.key, "2026-09-25T10:55:00.000Z");
  const busy = fakeHub(busyHour, { pageSize: 3 });
  const pending = await eventsForDryRun(editor, { call: busy.call });
  assert.equal(pending.count, 7);
  assert.ok(busy.calls.length > 1, "the older pages were read");
  assert.ok(
    busy.calls.every((c) => c.args.mark_read === false && c.args.reader === undefined),
    "and nothing was marked",
  );
  assert.equal(pending.events.timeline[0].subject_name, "late");
  assert.equal(state.cursorFor(editor.key), "2026-09-25T10:55:00.000Z", "the cursor is untouched");
});
