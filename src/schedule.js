/**
 * When a scheduled routine is due, in the operator's own timezone.
 *
 * Scheduling is unattended by definition — nobody is watching when it fires —
 * so a wrong occurrence shows up as a duplicate post or a silent week, both
 * discovered by a member rather than by us.
 *
 * WHY NOT UTC. It used to be UTC-only, which is fine for a maintainer who
 * thinks in Z and wrong for everyone else: "22:00" from a clan running an
 * evening war-deck nudge means their evening. Worse, a UTC schedule drifts an
 * hour twice a year against the humans it is talking to, which is exactly the
 * kind of bug nobody reports and everybody notices.
 *
 * The arithmetic is done on WALL CLOCK values and converted to instants at the
 * end, because that is what an operator means. `instantOf` resolves a wall
 * time in a zone with two passes: the first offset lookup is taken at the
 * naive UTC guess, the second at the corrected instant, which settles the
 * hour-wide disagreements at a DST boundary. The period key is the wall time
 * too, so the ledger is unambiguous even on a day that contains 01:30 twice.
 */

import { config } from "./config.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function wallParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const wall = {};
  for (const part of parts) {
    if (part.type !== "literal") wall[part.type] = Number(part.value);
  }
  return wall;
}

function offsetMs(instant, timezone) {
  const wall = wallParts(instant, timezone);
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) -
    instant.getTime()
  );
}

/** The instant at which a given wall-clock time occurs in a zone. */
export function instantOf(wall, timezone) {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  let instant = naive - offsetMs(new Date(naive), timezone);
  instant = naive - offsetMs(new Date(instant), timezone);
  return new Date(instant);
}

function shiftDays(wall, days) {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + days * DAY_MS);
  return {
    ...wall,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

const weekdayOf = (wall) => new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();

const pad = (value) => String(value).padStart(2, "0");

/**
 * The wall time of the most recent occurrence at or before `now`.
 *
 * Returning the occurrence rather than a boolean is what makes the run ledger
 * work: its rendering is the period key, so a restart at 12:29 and one at
 * 23:50 agree on which run they are talking about.
 */
export function lastOccurrence(routine, now = new Date(), timezone = config.timezone) {
  const here = wallParts(now, timezone);
  let wall = { ...here, hour: routine.at.hour, minute: routine.at.minute, second: 0 };
  if (instantOf(wall, timezone) > now) wall = shiftDays(wall, -1);

  if (routine.days?.length) {
    for (let back = 0; back < 7 && !routine.days.includes(weekdayOf(wall)); back += 1) {
      wall = shiftDays(wall, -1);
    }
  }
  return wall;
}

export const periodKey = (wall) =>
  `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;

/** Routines past their occurrence, inside the catch-up window, not yet run. */
export function dueRoutines(routines, { now = new Date(), ledger = {}, timezone = config.timezone } = {}) {
  const due = [];
  for (const routine of routines) {
    if (routine.trigger !== "schedule" || routine.disabled) continue;
    const wall = lastOccurrence(routine, now, timezone);
    const key = periodKey(wall);
    if (ledger[routine.key] === key) continue;
    const ageHours = (now - instantOf(wall, timezone)) / HOUR_MS;
    if (ageHours > routine.catchUpHours) continue;
    due.push({ routine, periodKey: key });
  }
  return due;
}

/** Every schedule routine's current period, for seeding a fresh install. */
export function currentPeriods(routines, { now = new Date(), timezone = config.timezone } = {}) {
  const ledger = {};
  for (const routine of routines) {
    if (routine.trigger !== "schedule") continue;
    ledger[routine.key] = periodKey(lastOccurrence(routine, now, timezone));
  }
  return ledger;
}
