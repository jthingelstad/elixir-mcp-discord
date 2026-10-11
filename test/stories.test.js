/**
 * Story memory: the editor never tells one timeline story twice. From
 * 09-27 to 10-11 one member's streaks were posted four times in 29 hours, a
 * race finish four times in a day and a departure twice, because recall kept
 * the text of the bot's posts and never the ids they covered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { coveredBy, mentions, storiesFor, untold, localDay, subjectsOf, rungsOf } from "../src/stories.js";

const sitting = (id, revision, tag, name, crossed, extra = {}) => ({
  id,
  revision,
  kind: "session_standout",
  at: "2026-10-11T10:25:28.000Z",
  subject_tag: "#CLAN",
  subject_name: "The Clan",
  facts: { player_tag: tag, name, crossed, newly: crossed.slice(-1), ...extra },
  text: `${name} sat down`,
});

const told = (item, toldAt, extra = {}) => ({
  ...storiesFor([item], { text: "x", covers: [item.id], now: new Date(toldAt) })[0],
  ...extra,
});

test("an id told at the same or a higher revision is not news; another kind's growth passes", () => {
  const join = { id: "tl_join", revision: 1, kind: "member_joined", subject_tag: "#P", subject_name: "New", facts: {} };
  const arena = { id: "tl_arena", revision: 2, kind: "arena_changed", facts: { player_tag: "#Q", name: "Mover" } };
  const stories = [told(join, "2026-10-11T10:00:00Z"), told({ ...arena, revision: 1 }, "2026-10-11T10:00:00Z")];
  const { keep, dropped } = untold([join, arena], stories, { now: new Date("2026-10-11T12:00:00Z") });
  assert.deepEqual(
    keep.map((i) => i.id),
    ["tl_arena"],
    "an arena move that grew (it now carries its battle) is the model's call",
  );
  assert.deepEqual(
    dropped.map((d) => [d.item.id, d.why]),
    [["tl_join", "told"]],
  );
});

test("a sitting told before is news again only on a rung it had not crossed", () => {
  const first = sitting("tl_s", 5, "#A", "Aaqib", ["won_in_a_row>=5"]);
  const stories = [told(first, "2026-10-11T08:00:00Z")];
  const now = new Date("2026-10-11T12:00:00Z");
  const moreBattles = sitting("tl_s", 9, "#A", "Aaqib", ["won_in_a_row>=5"]);
  const newRung = sitting("tl_s", 12, "#A", "Aaqib", ["won_in_a_row>=5", "won_in_a_row>=10"]);
  assert.equal(untold([moreBattles], stories, { now, perMemberPerDay: 0 }).dropped[0].why, "no_new_rung");
  assert.deepEqual(untold([newRung], stories, { now, perMemberPerDay: 0 }).keep, [newRung]);
});

test("one standout sitting per member per local day, in the operator's zone; 0 is no cap", () => {
  const timezone = "America/Chicago";
  // 23:00 Chicago on the 10th.
  const stories = [told(sitting("tl_one", 3, "#A", "Aaqib", ["won_in_a_row>=5"]), "2026-10-11T04:00:00Z")];
  const another = sitting("tl_two", 2, "#A", "Aaqib", ["won_in_a_row>=5"]);
  const someoneElse = sitting("tl_three", 2, "#B", "Andy", ["won_in_a_row>=5"]);
  // 22:30 Chicago, still the 10th: the cap holds.
  const sameDay = untold([another, someoneElse], stories, { now: new Date("2026-10-11T03:30:00Z"), timezone });
  assert.deepEqual(
    sameDay.dropped.map((d) => [d.item.id, d.why]),
    [["tl_two", "member_cap"]],
  );
  assert.deepEqual(
    sameDay.keep.map((i) => i.id),
    ["tl_three"],
  );
  // 01:00 Chicago on the 11th: a new day.
  assert.equal(untold([another], stories, { now: new Date("2026-10-11T06:00:00Z"), timezone }).keep.length, 1);
  assert.equal(
    untold([another], stories, { now: new Date("2026-10-11T03:30:00Z"), timezone, perMemberPerDay: 0 }).keep.length,
    1,
  );
  assert.equal(localDay("2026-10-11T04:00:00Z", timezone), "2026-10-10");
});

test("two sittings of one member in one batch are one story today; a sitting told today still grows", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const a = sitting("tl_a1", 2, "#A", "Aaqib", ["won_in_a_row>=5"]);
  const b = sitting("tl_a2", 2, "#A", "Aaqib", ["battles>=20"]);
  const { keep, dropped } = untold([a, b], [], { now });
  assert.deepEqual(
    keep.map((i) => i.id),
    ["tl_a1"],
  );
  assert.deepEqual(
    dropped.map((d) => [d.item.id, d.why]),
    [["tl_a2", "member_cap"]],
  );
  const stories = [told(a, "2026-10-11T10:00:00Z")];
  const grown = sitting("tl_a1", 6, "#A", "Aaqib", ["won_in_a_row>=5", "won_in_a_row>=10"]);
  assert.deepEqual(untold([grown], stories, { now }).keep, [grown], "its own new rung is not a second sitting");
});

test("a post's covers name the items it told; without them, the names it mentions do", () => {
  const items = [
    sitting("tl_ak", 4, "#AK", "Ak", ["won_in_a_row>=5"]),
    sitting("tl_nob", 4, "#NB", "NOBITA", ["won_in_a_row>=5"]),
    { id: "tl_race", revision: 1, kind: "race_finished", subject_tag: "#CLAN", subject_name: "The Clan", facts: {} },
  ];
  assert.deepEqual(
    coveredBy(items, { text: "anything", covers: ["tl_nob", "tl_unknown"] }).map((i) => i.id),
    ["tl_nob"],
  );
  assert.deepEqual(
    coveredBy(items, { text: "Take a bow, NOBITA: seven straight.", covers: [] }).map((i) => i.id),
    ["tl_nob"],
    "Ak is not in Take",
  );
  assert.deepEqual(
    coveredBy(items, { text: "The Clan crossed the line first; Ak won seven in a row." }).map((i) => i.id),
    ["tl_ak", "tl_race"],
  );
  assert.equal(mentions("✨فُؤَاد✨ left", "✨فُؤَاد✨"), true);
});

test("a story record is the bot's own output: id, revision, kind, who, rungs, when, where, first words", () => {
  const item = {
    ...sitting("tl_s", 7, "#A", "Aaqib", ["won_in_a_row>=5"]),
    subjects: [
      { tag: "#A", kind: "player", name: "Aaqib" },
      { tag: "#CLAN", kind: "clan", name: "The Clan" },
    ],
  };
  const [story] = storiesFor([item], {
    text: "Aaqib has won seven straight, the longest run in the clan this week.\n\nMore.",
    covers: ["tl_s"],
    channel: "#updates",
    now: new Date("2026-10-11T12:00:00Z"),
  });
  assert.deepEqual(story, {
    id: "tl_s",
    revision: 7,
    kind: "session_standout",
    tags: ["#A"],
    crossed: ["won_in_a_row>=5"],
    toldAt: "2026-10-11T12:00:00.000Z",
    channel: "#updates",
    gist: "Aaqib has won seven straight, the longest run in the clan this week.",
  });
  assert.deepEqual(subjectsOf({ subject_tag: "#CLAN", subject_name: "The Clan", facts: {} }), [
    { tag: "#CLAN", name: "The Clan" },
  ]);
  assert.deepEqual(rungsOf({ facts: { crossings: [{ rung: "battles>=20" }] } }), ["battles>=20"]);
});
