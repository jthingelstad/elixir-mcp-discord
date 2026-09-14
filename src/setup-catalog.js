/**
 * The parts of setup that touch files and arithmetic rather than people:
 * what routines the checkout offers, which an instance already has, copying
 * the chosen ones across, moving a schedule, estimating what a month costs,
 * and adding a clan's own notes to identity.md. Kept apart from the prompts
 * in src/setup.js so every one of them is testable without a terminal.
 */

import fs from "node:fs";
import path from "node:path";
import { parseRoutine, splitFrontMatter } from "./routines.js";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "daily at 01:00", "Sun at 15:00", "on member_joined, war_day_open", "on message". */
export function describeWhen(routine) {
  if (routine.trigger === "schedule") {
    const hhmm = `${String(routine.at.hour).padStart(2, "0")}:${String(routine.at.minute).padStart(2, "0")}`;
    const days = routine.days ? routine.days.map((d) => WEEKDAY_NAMES[d]).join(",") : "daily";
    return `${days} at ${hhmm}`;
  }
  if (routine.trigger === "events") return `timeline: ${routine.kinds?.join(", ") ?? routine.sections?.join(", ") ?? "everything"}`;
  return "on message";
}

function readRoutineFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ key: name.slice(0, -3), file: path.join(dir, name) }));
}

/**
 * Every routine the checkout ships, annotated with whether this instance
 * already has a file by that key. An instance file that is not in the
 * catalog (the operator wrote their own) is listed too, as `custom`, so the
 * picker never hides something that will run.
 */
export function catalog({ exampleDir, instanceDir }) {
  const entries = new Map();
  for (const { key, file } of readRoutineFiles(path.join(exampleDir, "routines"))) {
    const text = fs.readFileSync(file, "utf8");
    let parsed = null;
    let error = null;
    try {
      parsed = parseRoutine(key, text);
    } catch (problem) {
      error = problem.message;
    }
    entries.set(key, { key, example: file, text, routine: parsed, error, installed: false, custom: false });
  }
  for (const { key, file } of readRoutineFiles(path.join(instanceDir, "routines"))) {
    const entry = entries.get(key);
    if (entry) {
      entry.installed = true;
      entry.instanceFile = file;
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    let parsed = null;
    let error = null;
    try {
      parsed = parseRoutine(key, text);
    } catch (problem) {
      error = problem.message;
    }
    entries.set(key, { key, example: null, instanceFile: file, text, routine: parsed, error, installed: true, custom: true });
  }
  return [...entries.values()];
}

/**
 * Put the chosen routines in place. A file the instance already has is never
 * overwritten — the operator may have rewritten it, and that rewrite is the
 * whole point of a per-instance agent directory. Nothing is deleted either;
 * a routine chosen off goes to ROUTINES_DISABLED, which `/run` still honours.
 */
export function installRoutines({ exampleDir, instanceDir, keys }) {
  const target = path.join(instanceDir, "routines");
  fs.mkdirSync(target, { recursive: true });
  const copied = [];
  const kept = [];
  for (const key of keys) {
    const destination = path.join(target, `${key}.md`);
    if (fs.existsSync(destination)) {
      kept.push(key);
      continue;
    }
    fs.copyFileSync(path.join(exampleDir, "routines", `${key}.md`), destination);
    copied.push(key);
  }
  return { copied, kept };
}

/** The ROUTINES_DISABLED value after a selection: installed-but-unchosen keys
 *  on, chosen keys off, anything else the operator had in there left alone. */
export function disabledAfter({ previous, installedKeys, chosenKeys }) {
  const disabled = new Set(
    (previous || "").split(",").map((k) => k.trim()).filter(Boolean),
  );
  for (const key of installedKeys) {
    if (chosenKeys.includes(key)) disabled.delete(key);
    else disabled.add(key);
  }
  return [...disabled].sort().join(",");
}

/** Replace the `at:` line of a routine's front matter, touching nothing else. */
export function rewriteAt(text, hhmm) {
  const time = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) throw new Error(`"${hhmm}" is not HH:MM`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const { fields } = splitFrontMatter(text);
  if (!match || !fields || fields.at === undefined) throw new Error("routine has no at: to move");
  // Only the front matter is edited; the body may well say "at: 01:00" too.
  const front = match[1].replace(/^at:[^\n]*$/m, `at: ${hhmm}`);
  return text.slice(0, 4) + front + text.slice(4 + match[1].length);
}

/**
 * Roughly what a month of these routines costs, at an assumed price per post.
 * A schedule is 30 runs a month (or 4.3 per named weekday); an events routine
 * is put at one post a day, which is about what a clan's feed produces; the
 * ask lane is not counted because members decide that, and it has its own
 * budget. This is a starting number for MONTHLY_BUDGET_USD, not a forecast.
 */
export function estimateMonthly(routines, { perPostUsd = 0.1 } = {}) {
  const lines = [];
  let runs = 0;
  for (const routine of routines) {
    let monthly;
    if (routine.trigger === "schedule") monthly = routine.days ? Math.round(4.3 * routine.days.length) : 30;
    else if (routine.trigger === "events") monthly = 30;
    else continue;
    runs += monthly;
    lines.push({ key: routine.key, runs: monthly, usd: monthly * perPostUsd });
  }
  return { runs, usd: runs * perPostUsd, perPostUsd, lines };
}

export const CLAN_SECTION = "## About this clan";

/**
 * Add a clan's own notes under a heading of their own at the end of
 * identity.md. Returns the new text, or null when the section already exists
 * — that is the operator's text now, and setup does not edit it.
 */
export function withClanSection(identity, { clanName, notes }) {
  if (identity.includes(CLAN_SECTION)) return null;
  const body = [
    `${CLAN_SECTION}`,
    ``,
    `You work for ${clanName}.`,
    ...(notes ? [``, notes.trim()] : []),
    ``,
  ].join("\n");
  return `${identity.trimEnd()}\n\n${body}`;
}
