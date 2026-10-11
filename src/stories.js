/**
 * STORY MEMORY. Which timeline stories the editor has already told, so it
 * never tells one twice.
 *
 * Since contract 11.8.0 one story is one timeline item under a stable `id`
 * that grows by `revision`, and the turn's framing told the model "an id you
 * have posted before is news only if its growth is". It could not keep that
 * rule: recall (state.lastPosts) holds the TEXT of its last posts, never the
 * ids or revisions they covered. From 09-27 to 10-11 the POAP KINGS editor
 * posted one member's streaks four times in 29 hours, another's three times
 * in six, a race finish four times on one day and a departure twice.
 *
 * So each post now leaves a record of the stories it told: `{ id, revision,
 * kind, subjects, crossed, at, toldAt, gist }`. It is the bot's own output,
 * the same class as recall, not game data: nothing here is read back as a
 * fact about the game. Two things read it:
 *
 *   - `untold`, a deterministic filter in front of every turn: an item whose
 *     id was told at the same or a higher revision is dropped; a sitting
 *     (`session_standout`) already told is dropped unless it crossed a rung
 *     that was not crossed when it was told; and at most
 *     STANDOUTS_PER_MEMBER_PER_DAY sittings per member are told per local
 *     day. A batch the filter empties never starts a turn.
 *   - the turn itself, which is handed the stories told in the last 48 hours
 *     (src/prompt.js `storiesBlock`), so the model can connect a new moment
 *     to the last one instead of repeating it.
 *
 * Which items a post told is the model's word first: post_message takes
 * `covers`, the ids it is telling. A post without it is matched by the names
 * it mentions (`coveredBy`), which is how older ledger turns are read too.
 */

/** How long a told story is kept: long enough for a sitting to grow over a
 *  weekend and for the turn's 48-hour list. */
export const STORY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const STORY_KEEP = 300;
/** What the turn is shown. */
export const STORIES_SHOWN_MS = 48 * 60 * 60 * 1000;
const GIST_CHARS = 90;

/** The people an item is about, as `{ tag, name }`; its clan when it is
 *  about no one person. */
export function subjectsOf(item) {
  const people = (item?.subjects ?? [])
    .filter((s) => s?.kind === "player" && s.tag)
    .map((s) => ({ tag: s.tag, name: s.name ?? null }));
  if (people.length) return people;
  const f = item?.facts ?? {};
  if (f.player_tag) return [{ tag: f.player_tag, name: f.name ?? null }];
  if (item?.subject_tag) return [{ tag: item.subject_tag, name: item.subject_name ?? null }];
  return [];
}

/** Every rung a sitting has crossed, by label. */
export function rungsOf(item) {
  const f = item?.facts ?? {};
  const labels = [
    ...(Array.isArray(f.crossed) ? f.crossed : []),
    ...(Array.isArray(f.newly) ? f.newly.map((n) => (typeof n === "string" ? n : n?.label)) : []),
    ...(Array.isArray(f.crossings) ? f.crossings.map((c) => c?.rung ?? c?.label) : []),
  ];
  return [...new Set(labels.filter((l) => typeof l === "string" && l))];
}

/** The first line of a post, short, for the turn's list. */
function gistOf(text) {
  const line =
    String(text ?? "")
      .split("\n")
      .find((l) => l.trim()) ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > GIST_CHARS ? `${flat.slice(0, GIST_CHARS - 1)}…` : flat;
}

const WORDISH = /[\p{L}\p{N}]/u;

/** Whether `name` appears in `text` as a whole name: the characters either
 *  side of it are not letters or digits ("Ak" is not in "take"). */
export function mentions(text, name) {
  const hay = String(text ?? "").toLowerCase();
  const needle = String(name ?? "")
    .toLowerCase()
    .trim();
  if (needle.length < 2) return false;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at > 0 ? hay[at - 1] : "";
    const after = hay[at + needle.length] ?? "";
    if (!(before && WORDISH.test(before)) && !(after && WORDISH.test(after))) return true;
  }
  return false;
}

/**
 * The items of a batch one post told. `covers` (the ids the model passed to
 * post_message) wins when it names any item in the batch; otherwise an item
 * is covered when the post names one of its people (or, for an item about
 * no one person, its clan).
 */
export function coveredBy(items, { text, covers = null }) {
  const list = items ?? [];
  if (Array.isArray(covers) && covers.length) {
    const ids = new Set(covers.map(String));
    const named = list.filter((it) => it?.id && ids.has(String(it.id)));
    if (named.length) return named;
  }
  return list.filter((it) => subjectsOf(it).some((s) => mentions(text, s.name)));
}

/** The story records one post leaves. */
export function storiesFor(items, { text, covers = null, channel = null, now = new Date() }) {
  const toldAt = now.toISOString();
  const gist = gistOf(text);
  return coveredBy(items, { text, covers }).map((it) => ({
    id: it.id ?? null,
    revision: Number(it.revision) || 0,
    kind: it.kind ?? null,
    subjects: subjectsOf(it),
    ...(it.kind === "session_standout" ? { crossed: rungsOf(it) } : {}),
    at: it.at ?? null,
    toldAt,
    channel,
    gist,
  }));
}

/** The local calendar day of an instant in a zone, "YYYY-MM-DD". */
export function localDay(instant, timezone) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * THE FILTER. `items` minus what has been told: `{ keep, dropped }`, each
 * dropped item with why (`told`, `no_new_rung`, `member_cap`).
 *
 *   - an id told at the same or a higher revision is the same story;
 *   - a sitting told before, at a lower revision, is news only if it has
 *     crossed a rung it had not crossed when it was told (a streak of five
 *     becoming ten, not five battles more);
 *   - `perMemberPerDay` sittings per member per local day, the sitting's own
 *     earlier telling included; 0 is no cap.
 *
 * Any other kind told at a lower revision passes: its growth is for the
 * model to judge, with the told story beside it.
 */
export function untold(items, stories, { now = new Date(), timezone = "UTC", perMemberPerDay = 1 } = {}) {
  const told = new Map();
  for (const s of stories ?? []) {
    if (!s?.id) continue;
    const have = told.get(s.id);
    told.set(s.id, {
      revision: Math.max(have?.revision ?? 0, Number(s.revision) || 0),
      crossed: new Set([...(have?.crossed ?? []), ...(s.crossed ?? [])]),
    });
  }
  const today = localDay(now, timezone);
  const sittingsToday = new Map();
  for (const s of stories ?? []) {
    if (s?.kind !== "session_standout" || localDay(s.toldAt, timezone) !== today) continue;
    for (const { tag } of s.subjects ?? []) {
      if (!tag) continue;
      const set = sittingsToday.get(tag) ?? new Set();
      set.add(s.id ?? s.toldAt);
      sittingsToday.set(tag, set);
    }
  }

  const keep = [];
  const dropped = [];
  for (const item of items ?? []) {
    const story = item?.id ? told.get(item.id) : null;
    if (story && (Number(item.revision) || 0) <= story.revision) {
      dropped.push({ item, why: "told" });
      continue;
    }
    if (story && item.kind === "session_standout" && !rungsOf(item).some((r) => !story.crossed.has(r))) {
      dropped.push({ item, why: "no_new_rung" });
      continue;
    }
    if (item?.kind === "session_standout" && perMemberPerDay > 0) {
      const tags = subjectsOf(item).map((s) => s.tag);
      if (tags.some((tag) => (sittingsToday.get(tag)?.size ?? 0) >= perMemberPerDay)) {
        dropped.push({ item, why: "member_cap" });
        continue;
      }
    }
    keep.push(item);
  }
  return { keep, dropped };
}
