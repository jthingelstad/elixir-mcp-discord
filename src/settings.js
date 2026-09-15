/**
 * The operator's settings in config.json, editable from the DM.
 *
 * "Raise the ask budget to $15", "run the review Saturday morning", "use
 * opus for everything", "add my co-leader as an admin", "move questions to
 * #ask-bot" — operator decisions, like a schedule is, and until now the only
 * way to make one was a terminal. They live in config.json (src/config.js:
 * every knob that is not a secret, flat, same key names as the docs), and
 * this file lets the DM propose a change to that file under three rules
 * that agent/ edits do not need:
 *
 *   AN ALLOWLIST. Only the keys below. config.json also holds wiring — the
 *   Elixir URL, the app and guild ids — that the DM may not touch: the bot
 *   editing its own wiring from a chat is how a bot locks itself out.
 *
 *   VALIDATION PER KEY, the same checks setup runs: a budget is a number, a
 *   model has a price, a timezone is IANA, an admin id is numeric, a channel
 *   is one the bot may see. A value the bot could not boot on never reaches
 *   a button — the parser-checks-the-routine rule, for settings.
 *
 *   LIVE, MOSTLY. config.json is re-read on use (src/config.js), so nearly
 *   every change is in effect the moment it is written. The exceptions are
 *   marked `restart` below: values something was built from at boot (the
 *   slash-command prefix, the feed poll timer). For those the bot drains
 *   and exits after applying when a service (launchd KeepAlive, systemd
 *   Restart=always) will bring it back; otherwise it says a restart is
 *   needed. The prior config.json is kept under .history/ in the instance.
 */

import fs from "node:fs";
import path from "node:path";
import { instanceDir, configFile, parseReviewAt } from "./config.js";
import { renderConfig, parseConfig } from "./env-file.js";
import { rateFor } from "./pricing.js";
import { directory } from "./directory.js";
import { log } from "./log.js";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function isTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return /\//.test(tz) || tz === "UTC";
  } catch {
    return false;
  }
}

const money = (name) => (v) =>
  v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0)
    ? null
    : `${name} must be a number of dollars (or empty for unlimited)`;
const onOff = (v) => (["on", "off"].includes(v.toLowerCase()) ? null : "on or off");
const trueFalse = (v) => (["true", "false"].includes(v.toLowerCase()) ? null : "true or false");
const intAtLeast = (min, what) => (v) =>
  Number.isInteger(Number(v)) && Number(v) >= min ? null : `${what} must be a whole number ≥ ${min}`;
const pricedModel = (v) => {
  try {
    rateFor(v);
    return null;
  } catch (error) {
    return error.message;
  }
};
const effort = (v) => (EFFORTS.has(v.toLowerCase()) ? null : `effort is one of ${[...EFFORTS].join(", ")}`);

/** What the DM may change, with what makes a value acceptable. */
export const SETTINGS = {
  MONTHLY_BUDGET_USD: {
    about: "monthly budget for scheduled and event posts, USD; empty = unlimited",
    check: money("MONTHLY_BUDGET_USD"),
  },
  ASK_MONTHLY_BUDGET_USD: {
    about: "monthly budget for members' questions, USD; empty = unlimited",
    check: money("ASK_MONTHLY_BUDGET_USD"),
  },
  REVIEW_MONTHLY_BUDGET_USD: {
    about: "monthly budget for the review lane and DM turns, USD",
    check: money("REVIEW_MONTHLY_BUDGET_USD"),
  },
  ASK_DAILY_TURNS_PER_MEMBER: {
    about: "questions one member may ask per day; 0 = no cap; admins exempt",
    check: intAtLeast(0, "ASK_DAILY_TURNS_PER_MEMBER"),
  },
  DAILY_USD_CAP: {
    about: "a daily ceiling on top of the monthly budgets; empty = none",
    check: money("DAILY_USD_CAP"),
  },
  TURN_RESERVE_USD: { about: "what one turn is assumed to cost before any has run", check: money("TURN_RESERVE_USD") },
  CLAUDE_MODEL: { about: "default model for routines that name none", check: pricedModel },
  CLAUDE_EFFORT: { about: "default effort: low, medium, high, xhigh, max", check: effort },
  CLAUDE_MAX_TOKENS: { about: "default output ceiling per turn", check: intAtLeast(256, "CLAUDE_MAX_TOKENS") },
  REVIEW: {
    about: "the review lane: on or off (the /review slash command appears after a restart; the lane itself is live)",
    check: onOff,
  },
  REVIEW_AT: {
    about: '"<weekday|daily> HH:MM" in TIMEZONE, e.g. "sun 20:00"',
    check: (v) => {
      try {
        parseReviewAt(v);
        return null;
      } catch (error) {
        return error.message;
      }
    },
  },
  REVIEW_MODEL: { about: "model for the review lane", check: pricedModel },
  REVIEW_EFFORT: { about: "effort for the review lane", check: effort },
  REVIEW_AUTO_MEMORY: { about: "let the review write memory.md without a click: true or false", check: trueFalse },
  REVIEW_MAX_PROPOSALS: { about: "proposals per review", check: intAtLeast(1, "REVIEW_MAX_PROPOSALS") },
  TIMEZONE: {
    about: "IANA zone schedules are written in, e.g. America/Chicago",
    check: (v) => (isTimezone(v) ? null : `"${v}" is not an IANA timezone (Region/City)`),
  },
  EVENT_POLL_SECONDS: {
    about: "how often the timeline is read; every poll is a metered call (restart)",
    check: intAtLeast(60, "EVENT_POLL_SECONDS"),
    restart: true,
  },
  STARTUP_MESSAGE: { about: "the one-line hello on boot: on or off", check: onOff },
  MAX_POSTS_PER_TURN: { about: "how many posts one routine turn may make", check: intAtLeast(1, "MAX_POSTS_PER_TURN") },
  COMMAND_PREFIX: {
    about: "slash-command prefix (/<prefix>-run); empty for plain /run (restart)",
    check: (v) => (/^[a-z0-9_-]*$/.test(v) ? null : "letters, digits, - and _ only"),
    restart: true,
  },
  FEEDBACK_CHANNEL: {
    about: "logical channel name for Elixir's replies to filed feedback",
    check: (v) => (/^[a-z0-9-]*$/.test(v) ? null : "a channel's logical name (lowercase, hyphens)"),
  },
  ADMIN_USER_IDS: {
    about: "who may DM the bot and use its commands; comma-separated Discord user ids",
    check: (v) =>
      v.split(",").every((id) => /^\d{5,}$/.test(id.trim())) ? null : "comma-separated numeric Discord user ids",
  },
};

export const isSetting = (key) => Object.hasOwn(SETTINGS, key) || /^CHANNEL_[A-Z0-9_]+$/.test(key);

/** Do any of these keys need the process rebuilt to take effect? */
export const needsRestart = (keys) => (keys || []).some((k) => SETTINGS[String(k).toUpperCase()]?.restart);

/**
 * Check one change against the running bot. `by` is the operator's id: they
 * may add admins and may not remove themselves. A channel value may be an
 * id or a #name; it must be one the bot is granted in (the directory).
 */
export function checkSetting(key, rawValue, { by = null, entries = directory() } = {}) {
  const value = String(rawValue ?? "").trim();
  if (/^CHANNEL_[A-Z0-9_]+$/.test(key)) {
    if (!value) return { ok: true, value: "" };
    const wanted = value.replace(/^#/, "");
    const entry = entries.find((e) => e.id === wanted || e.name === wanted);
    if (!entry)
      return {
        ok: false,
        error: `${value} is not a channel the bot is granted in; it may post in ${entries.map((e) => `#${e.name}`).join(", ") || "nothing yet"}`,
      };
    return { ok: true, value: entry.id, shown: `#${entry.name}` };
  }
  const setting = SETTINGS[key];
  if (!setting) return { ok: false, error: `${key} is not a setting the DM may change` };
  const problem = setting.check(value);
  if (problem) return { ok: false, error: `${key}: ${problem}` };
  if (
    key === "ADMIN_USER_IDS" &&
    by &&
    !value
      .split(",")
      .map((s) => s.trim())
      .includes(String(by))
  ) {
    return { ok: false, error: "that would remove you as an admin; keep your own id in the list" };
  }
  return { ok: true, value };
}

/** config.json with keys set (a value of "" removes the key), everything else untouched. */
export function withSettings(text, changes) {
  const values = parseConfig(text) ?? {};
  for (const [k, v] of Object.entries(changes)) {
    if (v === "") delete values[k];
    else values[k] = v;
  }
  return renderConfig(values);
}

export function currentSettings(text) {
  return Object.fromEntries(Object.entries(parseConfig(text) ?? {}).filter(([k]) => isSetting(k)));
}

/** A diff for the operator: old and new, only the keys that change. */
export function settingsPreview(before, after) {
  const a = currentSettings(before);
  const b = currentSettings(after);
  const lines = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === b[k]) continue;
    if (a[k] !== undefined) lines.push(`- ${k}: ${a[k]}`);
    if (b[k] !== undefined) lines.push(`+ ${k}: ${b[k]}`);
  }
  return lines.join("\n");
}

export const readConfigText = () => {
  try {
    return fs.readFileSync(configFile, "utf8");
  } catch {
    return "{}";
  }
};

/** Write config.json with a backup under .history/ in the instance. */
export function writeConfig(next) {
  const dir = path.join(instanceDir, ".history");
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `config.json.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (fs.existsSync(configFile)) fs.copyFileSync(configFile, backup);
  else fs.writeFileSync(backup, "{}\n");
  fs.writeFileSync(configFile, next);
  return backup;
}

/** Is a supervisor going to bring this process back if it exits? launchd is
 *  pid 1 on macOS; systemd system units too. SERVICE_MANAGED=1 says so
 *  explicitly for anything else. */
export function serviceManaged() {
  return process.env.SERVICE_MANAGED === "1" || process.ppid === 1;
}

/** Drain and exit so the service restarts on the new config.json — only
 *  for the few keys that need it. The caller has already told the operator. */
export function restartSoon({ delayMs = 1500 } = {}) {
  log.info("restart_requested", { reason: "settings changed by DM", managed: serviceManaged() });
  setTimeout(() => process.kill(process.pid, "SIGTERM"), delayMs).unref();
}

/** The current settings, for the DM to show. Secrets are not in this file. */
export function describeSettings() {
  const values = currentSettings(readConfigText());
  const entries = directory();
  return Object.keys(SETTINGS)
    .concat(Object.keys(values).filter((k) => k.startsWith("CHANNEL_")))
    .map((k) => {
      const raw = values[k];
      const shown = k.startsWith("CHANNEL_") ? `#${entries.find((e) => e.id === raw)?.name ?? raw}` : raw;
      return `${k} = ${raw === undefined ? "(default)" : shown || "(unset)"}${SETTINGS[k] ? ` — ${SETTINGS[k].about}` : ""}`;
    })
    .join("\n");
}
