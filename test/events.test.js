/**
 * The feed lane's judgment since contract 2.0.0: a clan entry arrives on
 * every read, so whether to spend a model call is decided here, from the
 * sections a routine named. Pinned against the real shape of a live read on
 * 2026-09-13.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { noteworthy, shouldReadFeedback } from "../src/events.js";

// A trimmed real clan entry: an active clan on a war day, nothing in roster
// or presence, one ranked promotion in standouts, no notables.
const busyButDull = {
  kind: "clan_activity",
  subject_tag: "#AAAAAAAA",
  name: "Example",
  summary: "Example: 454 battles by 35 of 47 members; war day 4.",
  activity: { battles: 454, members_active: 35, members_total: 47, by_mode: { war: 35, ladder: 160 }, late_captures: 0 },
  roster: { joined: { items: [], more: 0 }, left: { items: [], more: 0 }, role_changes: { items: [], more: 0 }, bounced: 0, size: { from: 47, to: 47 } },
  war: { season_id: 136, week: 1, day_kind: "war", war_day: 4, fame: 10134, place_of_five: 1, race_finished_at: "2026-09-13T09:38:04.000Z", decks: { as_of: "x", untouched: 37, partial: 4, finished: 6, participants: 47 }, resolved: [] },
  presence: { quiet_crossed: { items: [], more: 0 }, returned: { items: [], more: 0 }, never_recorded: 0, rungs_days: [5, 10, 20] },
  standouts: { most_battles: [{ name: "sikander", battles: 64 }], new_bests: { items: [], more: 0 }, ranked_promotions: { items: [{ name: "Ollie", league: "Champion" }], more: 0 } },
  donations: { week_total: 9758, members_counted: 47, leader: { name: "Vijay", given: 984 } },
  notables: [],
};

test("numbers alone never fire; a list with an item in a named section does", () => {
  assert.equal(noteworthy([busyButDull], ["roster", "presence"]), false, "454 battles is not news to a roster routine");
  assert.equal(noteworthy([busyButDull], ["roster", "presence", "war"]), false, "rungs_days is a disclosure, not an event");
  const joined = structuredClone(busyButDull);
  joined.roster.joined.items.push({ tag: "#B", name: "New", at: "2026-09-13T10:00:00Z" });
  assert.equal(noteworthy([joined], ["roster", "presence"]), true);
  const back = structuredClone(busyButDull);
  back.presence.returned.items.push({ name: "round hamster", after_days: 7 });
  assert.equal(noteworthy([back], ["presence"]), true);
  const finished = structuredClone(busyButDull);
  finished.war.resolved.push({ season_id: 136, week: 1, fame: 10134, rank: 1 });
  assert.equal(noteworthy([finished], ["war"]), true);
});

test("a routine that names standouts accepts a busier feed, and notables always count", () => {
  assert.equal(noteworthy([busyButDull], ["standouts"]), true, "a ranked promotion is an item");
  const notable = structuredClone(busyButDull);
  notable.notables.push({ kind: "clan_joined" });
  assert.equal(noteworthy([notable], ["roster"]), true);
  assert.equal(noteworthy([], ["roster"]), false);
  assert.equal(noteworthy([{ kind: "clan_activity", summary: "quiet", roster: null, presence: null, notables: [] }], null), false, "null sections are silence");
});

test("the feedback ledger is read on the hint, always on the seeding run", () => {
  assert.equal(shouldReadFeedback({ seeded: false, pending: 0 }), true);
  assert.equal(shouldReadFeedback({ seeded: true, pending: 0 }), false);
  assert.equal(shouldReadFeedback({ seeded: true, pending: 2 }), true);
  assert.equal(shouldReadFeedback({ seeded: true, pending: undefined }), true, "no hint degrades to the old cost, never to silence");
});
