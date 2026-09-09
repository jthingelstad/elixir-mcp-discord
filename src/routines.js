/**
 * A routine is the only unit of behaviour in this bot:
 *
 *     routine = trigger x prompt x destination
 *
 * There used to be three hand-written lanes — an ask channel, an event
 * notifier, and a table of scheduled jobs — and they were the same three
 * things wired three different ways, with their prompts embedded in source. So
 * a clan that wanted a different post had to edit JavaScript, and a repo that
 * wanted to be an example had a roster of somebody's actual channels in it.
 *
 * Now the trigger is a field. `message` fires when a human speaks in the
 * routine's channel, `events` fires when Elixir MCP's feed carries a topic the
 * routine subscribes to, and `schedule` fires on a clock. Everything else —
 * what to say, which channel, how often, which model — is front matter and
 * prose in `agent/routines/*.md`, which an operator owns and this repository
 * merely ships a default set of.
 *
 * Files are re-read on every use. Editing a prompt is not a deploy and must
 * never require a restart: the whole reason to run this thing is to find out
 * what the prompts should say, and a 30-second restart between attempts is how
 * a person stops iterating.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const TRIGGERS = new Set(["message", "events", "schedule"]);

/** Every key a routine may declare. An unknown one is an error rather than an
 *  ignored line, because `catchup_hours` for `catch_up_hours` would otherwise
 *  read as a working config that silently never catches up. */
const FIELDS = new Set([
  "trigger",
  "channel",
  "enabled",
  "at",
  "days",
  "catch_up_hours",
  "topics",
  "may_skip",
  "recall",
  "history_turns",
  "trace",
  "model",
  "effort",
  "max_chars",
  "max_tokens",
]);

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function fail(key, message) {
  throw new Error(`${key}: ${message}`);
}

function asList(raw) {
  return String(raw)
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function asBool(key, field, raw) {
  const value = String(raw).toLowerCase();
  if (["true", "yes", "on"].includes(value)) return true;
  if (["false", "no", "off"].includes(value)) return false;
  return fail(key, `${field} must be true or false, got "${raw}"`);
}

function asInt(key, field, raw, { min = 0 } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    return fail(key, `${field} must be a number >= ${min}, got "${raw}"`);
  }
  return value;
}

/** Front matter, deliberately the smallest thing that works: `key: value`
 *  lines between two `---` fences, then the prompt. No YAML dependency for
 *  fifteen scalar fields. */
export function splitFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: null, body: text.trim() };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at === -1) continue;
    fields[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

export function parseRoutine(key, text) {
  const { fields, body } = splitFrontMatter(text);
  if (!fields) fail(key, "no front matter — a routine starts with a --- block");
  for (const field of Object.keys(fields)) {
    if (!FIELDS.has(field)) fail(key, `unknown field "${field}"`);
  }

  const trigger = fields.trigger;
  if (!TRIGGERS.has(trigger)) {
    fail(
      key,
      `trigger must be one of ${[...TRIGGERS].join(", ")}, got "${trigger ?? ""}"`,
    );
  }
  if (!fields.channel) fail(key, "needs a channel");
  if (!body) fail(key, "has no prompt");

  const routine = {
    key,
    trigger,
    channel: fields.channel.toLowerCase(),
    prompt: body,
    enabled:
      fields.enabled === undefined
        ? true
        : asBool(key, "enabled", fields.enabled),
    maySkip:
      fields.may_skip === undefined
        ? false
        : asBool(key, "may_skip", fields.may_skip),
    // How many of the bot's own recent messages in the destination channel to
    // show the model. This is the cheapest possible memory and it needs no
    // storage: Discord already kept them. Without it a daily routine happily
    // reports the same three players every day and reads like a broken loop.
    recall:
      fields.recall === undefined ? 0 : asInt(key, "recall", fields.recall),
    model: fields.model || config.claude.model,
    effort: fields.effort || config.claude.effort,
    maxChars:
      fields.max_chars === undefined
        ? 1900
        : asInt(key, "max_chars", fields.max_chars, { min: 200 }),
    // The output ceiling for one turn. Priced exactly, unlike input, so it is
    // the part of a turn's cost an operator can actually bound.
    maxTokens:
      fields.max_tokens === undefined
        ? 6000
        : asInt(key, "max_tokens", fields.max_tokens, { min: 256 }),
  };

  if (trigger === "schedule") {
    const at = /^(\d{1,2}):(\d{2})$/.exec(fields.at || "");
    if (!at)
      fail(
        key,
        `at must be HH:MM in the configured timezone, got "${fields.at ?? ""}"`,
      );
    const hour = Number(at[1]);
    const minute = Number(at[2]);
    if (hour > 23 || minute > 59)
      fail(key, `at "${fields.at}" is not a real time`);
    routine.at = { hour, minute };

    if (fields.days) {
      routine.days = asList(fields.days).map((day) => {
        const index = WEEKDAYS[day.slice(0, 3).toLowerCase()];
        if (index === undefined) fail(key, `days: "${day}" is not a weekday`);
        return index;
      });
    }
    // A missed run fires late only inside this window. A war-deck nudge at 4am
    // because the host was asleep is worse than one that never fires.
    routine.catchUpHours =
      fields.catch_up_hours === undefined
        ? 4
        : asInt(key, "catch_up_hours", fields.catch_up_hours, { min: 1 });
  } else if (fields.at || fields.days || fields.catch_up_hours) {
    fail(
      key,
      `at/days/catch_up_hours only mean something for trigger: schedule`,
    );
  }

  if (trigger === "events") {
    if (!fields.topics) fail(key, "an events routine must name its topics");
    routine.topics = asList(fields.topics);
  } else if (fields.topics) {
    fail(key, "topics only mean something for trigger: events");
  }

  if (trigger === "message") {
    routine.historyTurns =
      fields.history_turns === undefined
        ? 8
        : asInt(key, "history_turns", fields.history_turns);
    routine.maxChars = fields.max_chars === undefined ? 2000 : routine.maxChars;
  } else if (fields.history_turns) {
    fail(key, "history_turns only means something for trigger: message");
  }

  // A trace footer is the demonstration in a channel people are watching to
  // judge the answers, and noise in a channel they are reading for the news.
  routine.trace =
    fields.trace === undefined
      ? trigger === "message"
      : asBool(key, "trace", fields.trace);

  return routine;
}

/**
 * Every routine in the agent directory, plus whatever failed to parse.
 *
 * A bad file is reported and skipped, never fatal. One routine with a typo in
 * it must not take the other five off the air — and the operator finds out
 * from a log line rather than from a bot that would not start.
 */
export function loadRoutines({
  dir = config.agentDir,
  disabled = config.disabled,
} = {}) {
  const routineDir = path.join(dir, "routines");
  let files;
  try {
    files = fs
      .readdirSync(routineDir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return {
      routines: [],
      errors: [{ key: routineDir, error: "no routines directory" }],
    };
  }

  const routines = [];
  const errors = [];
  for (const file of files) {
    const key = file.replace(/\.md$/, "");
    try {
      const routine = parseRoutine(
        key,
        fs.readFileSync(path.join(routineDir, file), "utf8"),
      );
      routine.disabled = !routine.enabled || disabled.has(key);
      routines.push(routine);
    } catch (error) {
      errors.push({ key, error: error.message });
    }
  }
  return { routines, errors };
}

export function activeRoutines(options) {
  return loadRoutines(options).routines.filter((routine) => !routine.disabled);
}

export function routinesFor(trigger, options) {
  return activeRoutines(options).filter(
    (routine) => routine.trigger === trigger,
  );
}
