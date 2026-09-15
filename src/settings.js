/**
 * The operator's settings in .env, editable from the DM.
 *
 * "Raise the ask budget to $15", "run the review Saturday morning", "use
 * opus for everything", "add my co-leader as an admin", "move questions to
 * #ask-bot" — operator decisions, like a schedule is, and until now the only
 * way to make one was a terminal. They live in .env because .env is where
 * every knob is documented and setup writes it; this file lets the DM
 * propose a change to the SAME file, under three rules that agent/ edits do
 * not need:
 *
 *   AN ALLOWLIST. Only the keys below. Never a token, a key, a URL, an app
 *   or guild id, STATE_PATH or AGENT_DIR: those are wiring, and the bot
 *   editing its own wiring from a chat is how a bot locks itself out.
 *
 *   VALIDATION PER KEY, the same checks setup runs: a budget is a number, a
 *   model has a price, a timezone is IANA, an admin id is numeric, a channel
 *   is one the bot may see. A value the bot could not boot on never reaches
 *   a button — the parser-checks-the-routine rule, for .env.
 *
 *   A RESTART TO APPLY. .env is read at boot. When the bot runs as a service
 *   (launchd KeepAlive, systemd Restart=always) it drains and exits after
 *   applying, and the service brings it back on the new values; otherwise
 *   it says a restart is needed. The backup of .env goes under state/, not
 *   agent/.history/: a copy of a secrets file is a secrets file.
 */

import fs from "node:fs";
import path from "node:path";
import { instanceDir, envFile, parseReviewAt } from "./config.js";
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

const money = (name) => (v) => (v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0) ? null : `${name} must be a number of dollars (or empty for unlimited)`);
const onOff = (v) => (["on", "off"].includes(v.toLowerCase()) ? null : "on or off");
const trueFalse = (v) => (["true", "false"].includes(v.toLowerCase()) ? null : "true or false");
const intAtLeast = (min, what) => (v) => (Number.isInteger(Number(v)) && Number(v) >= min ? null : `${what} must be a whole number ≥ ${min}`);
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
  MONTHLY_BUDGET_USD: { about: "monthly budget for scheduled and event posts, USD; empty = unlimited", check: money("MONTHLY_BUDGET_USD") },
  ASK_MONTHLY_BUDGET_USD: { about: "monthly budget for members' questions, USD; empty = unlimited", check: money("ASK_MONTHLY_BUDGET_USD") },
  REVIEW_MONTHLY_BUDGET_USD: { about: "monthly budget for the review lane and DM turns, USD", check: money("REVIEW_MONTHLY_BUDGET_USD") },
  DAILY_USD_CAP: { about: "a daily ceiling on top of the monthly budgets; empty = none", check: money("DAILY_USD_CAP") },
  TURN_RESERVE_USD: { about: "what one turn is assumed to cost before any has run", check: money("TURN_RESERVE_USD") },
  CLAUDE_MODEL: { about: "default model for routines that name none", check: pricedModel },
  CLAUDE_EFFORT: { about: "default effort: low, medium, high, xhigh, max", check: effort },
  CLAUDE_MAX_TOKENS: { about: "default output ceiling per turn", check: intAtLeast(256, "CLAUDE_MAX_TOKENS") },
  REVIEW: { about: "the review lane: on or off", check: onOff },
  REVIEW_AT: { about: '"<weekday|daily> HH:MM" in TIMEZONE, e.g. "sun 20:00"', check: (v) => { try { parseReviewAt(v); return null; } catch (error) { return error.message; } } },
  REVIEW_MODEL: { about: "model for the review lane", check: pricedModel },
  REVIEW_EFFORT: { about: "effort for the review lane", check: effort },
  REVIEW_AUTO_MEMORY: { about: "let the review write memory.md without a click: true or false", check: trueFalse },
  REVIEW_MAX_PROPOSALS: { about: "proposals per review", check: intAtLeast(1, "REVIEW_MAX_PROPOSALS") },
  TIMEZONE: { about: "IANA zone schedules are written in, e.g. America/Chicago", check: (v) => (isTimezone(v) ? null : `"${v}" is not an IANA timezone (Region/City)`) },
  EVENT_POLL_SECONDS: { about: "how often the timeline is read; every poll is a metered call", check: intAtLeast(60, "EVENT_POLL_SECONDS") },
  STARTUP_MESSAGE: { about: "the one-line hello on boot: on or off", check: onOff },
  MAX_POSTS_PER_TURN: { about: "how many posts one routine turn may make", check: intAtLeast(1, "MAX_POSTS_PER_TURN") },
  COMMAND_PREFIX: { about: "slash-command prefix (/<prefix>-run); empty for plain /run", check: (v) => (/^[a-z0-9_-]*$/.test(v) ? null : "letters, digits, - and _ only") },
  FEEDBACK_CHANNEL: { about: "logical channel name for Elixir's replies to filed feedback", check: (v) => (/^[a-z0-9-]*$/.test(v) ? null : "a channel's logical name (lowercase, hyphens)") },
  ADMIN_USER_IDS: { about: "who may DM the bot and use its commands; comma-separated Discord user ids", check: (v) => (v.split(",").every((id) => /^\d{5,}$/.test(id.trim())) ? null : "comma-separated numeric Discord user ids") },
};

export const isSetting = (key) => Object.hasOwn(SETTINGS, key) || /^CHANNEL_[A-Z0-9_]+$/.test(key);

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
    if (!entry) return { ok: false, error: `${value} is not a channel the bot is granted in; it may post in ${entries.map((e) => `#${e.name}`).join(", ") || "nothing yet"}` };
    return { ok: true, value: entry.id, shown: `#${entry.name}` };
  }
  const setting = SETTINGS[key];
  if (!setting) return { ok: false, error: `${key} is not a setting the DM may change` };
  const problem = setting.check(value);
  if (problem) return { ok: false, error: `${key}: ${problem}` };
  if (key === "ADMIN_USER_IDS" && by && !value.split(",").map((s) => s.trim()).includes(String(by))) {
    return { ok: false, error: "that would remove you as an admin; keep your own id in the list" };
  }
  return { ok: true, value };
}

/** The .env text with keys set (a value of "" removes the line), everything else untouched. */
export function withSettings(text, changes) {
  const lines = (text ?? "").split("\n");
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (match && Object.hasOwn(changes, match[1])) {
      seen.add(match[1]);
      if (changes[match[1]] !== "") out.push(`${match[1]}=${changes[match[1]]}`);
      continue;
    }
    out.push(line);
  }
  const added = Object.entries(changes).filter(([k, v]) => !seen.has(k) && v !== "");
  if (added.length) {
    while (out.length && out.at(-1) === "") out.pop();
    out.push("", "# --- Set from the DM", ...added.map(([k, v]) => `${k}=${v}`));
  }
  return `${out.join("\n").replace(/\n*$/, "")}\n`;
}

export function currentSettings(text) {
  const values = {};
  for (const line of (text ?? "").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && isSetting(match[1])) values[match[1]] = match[2];
  }
  return values;
}

/** A diff for the operator: old and new, only the keys that change. */
export function settingsPreview(before, after) {
  const a = currentSettings(before);
  const b = currentSettings(after);
  const lines = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === b[k]) continue;
    if (a[k] !== undefined) lines.push(`- ${k}=${a[k]}`);
    if (b[k] !== undefined) lines.push(`+ ${k}=${b[k]}`);
  }
  return lines.join("\n");
}

export const readEnv = () => {
  try {
    return fs.readFileSync(envFile, "utf8");
  } catch {
    return "";
  }
};

/** Write .env with a backup under state/ (never under agent/). */
export function writeEnv(next) {
  const dir = path.join(instanceDir, "state", "env-history");
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `.env.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, backup);
  else fs.writeFileSync(backup, "");
  fs.writeFileSync(envFile, next, { mode: 0o600 });
  return backup;
}

/** Is a supervisor going to bring this process back if it exits? launchd is
 *  pid 1 on macOS; systemd system units too. SERVICE_MANAGED=1 says so
 *  explicitly for anything else. */
export function serviceManaged() {
  return process.env.SERVICE_MANAGED === "1" || process.ppid === 1;
}

/** Drain and exit so the service restarts on the new .env. The caller has
 *  already told the operator. */
export function restartSoon({ delayMs = 1500 } = {}) {
  log.info("restart_requested", { reason: "settings changed by DM", managed: serviceManaged() });
  setTimeout(() => process.kill(process.pid, "SIGTERM"), delayMs).unref();
}

/** The current settings, for the DM to show. Secrets never appear here. */
export function describeSettings() {
  const values = currentSettings(readEnv());
  const entries = directory();
  return Object.keys(SETTINGS)
    .concat(Object.keys(values).filter((k) => /^CHANNEL_/.test(k)))
    .map((k) => {
      const raw = values[k];
      const shown = /^CHANNEL_/.test(k) ? `#${entries.find((e) => e.id === raw)?.name ?? raw}` : raw;
      return `${k} = ${raw === undefined ? "(default)" : shown || "(unset)"}${SETTINGS[k] ? ` — ${SETTINGS[k].about}` : ""}`;
    })
    .join("\n");
}
