/**
 * Configuration: `.env` for SECRETS, `config.json` for SETTINGS, `agent/` for
 * CONTENT.
 *
 * That split is the whole shape of this project. `.env` holds what the bot
 * may not change about itself — the three secrets and the three wiring ids
 * (the Elixir door, the Discord application, the server) — so it is the
 * one file that is never versioned, never backed up beside a prompt, never
 * shown in a diff. `config.json` holds every other knob (same key names,
 * flat): what the DM may change, which is why it CAN be versioned with the
 * instance, backed up under `.history/`, and edited with a diff the
 * operator reads. Nothing in either is about a clan, and nothing is a
 * prompt: what the agent says and when lives in `agent/` as text.
 *
 * Until 2026-09-15 everything was in `.env`. An instance from before is
 * migrated the first time this code loads it: the non-secret keys move to
 * `config.json` and `.env` is rewritten to the secrets (backup under
 * `state/env-history/`). Paths and test switches (INSTANCE_DIR, STATE_PATH,
 * AGENT_DIR, LEDGER_DIR, SERVICE_MANAGED) stay environment: they say where
 * an instance IS, and belong to whoever starts the process.
 *
 * THERE IS NO CLAN_TAG. There used to be, and removing it is the point of the
 * agent model: an Elixir MCP agent key already knows the clan it acts for, and
 * the server says so in its opening instructions ("YOU ACT FOR ... OMIT
 * clan_tag to mean it"). A second copy in .env could disagree with the token,
 * and disagreeing quietly is the worst thing a configuration value can do.
 *
 * Each section validates when it is first READ, not at import. `npm run probe`
 * needs nothing but the MCP credentials, and making it demand a Discord token
 * to tell you whether your key works would be a silly gate to walk into on
 * your first run.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { isEnvFile, isEnvOnly, renderSecrets, renderConfig, parseConfig } from "./env-file.js";

export { renderConfig };

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * THE INSTANCE IS A DIRECTORY: `.env`, `agent/` and `state/` live together in
 * it, and the checkout is only where the code is. It is the working
 * directory, or INSTANCE_DIR when that is set — the second form exists
 * because `npm run` always changes into the checkout, and `npm run try` is
 * the most important command in the repo.
 *
 * One checkout can therefore run several bots — three clans on one server,
 * each its own Discord app, Elixir agent and Claude key — by starting the
 * same `src/index.js` against three directories:
 *
 *   ~/.elixir-mcp-discord/<name>/   .env  agent/  state/state.json
 *
 * The defaults used to resolve against the CHECKOUT, which is identical when
 * you run from the checkout and silently wrong when you do not: two instances
 * that both forgot STATE_PATH would share one cursor and one budget ledger,
 * and the only symptom would be a feed post missing from one channel. So
 * everything resolves against the instance, and the boot log prints where
 * each file came from.
 */
export const instanceDir = path.resolve(process.env.INSTANCE_DIR || process.cwd());
export const envFile = path.join(instanceDir, ".env");
export const configFile = path.join(instanceDir, "config.json");

const loaded = dotenv.config({ path: envFile, quiet: true });
export const envLoaded = Boolean(loaded.parsed);

export function readConfigFile(file = configFile) {
  try {
    return parseConfig(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * ONE-TIME MIGRATION of a pre-config.json instance: everything in .env that
 * is not a secret or a path moves to config.json, and .env is rewritten to
 * what belongs there. A backup of the old .env goes under state/, which is
 * gitignored; nothing is lost, nothing is duplicated afterwards.
 */
export function migrateEnvToConfig({
  parsed = loaded.parsed,
  env = envFile,
  cfg = configFile,
  dir = instanceDir,
} = {}) {
  if (!parsed) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const history = path.join(dir, "state", "env-history");
  const existing = fs.existsSync(cfg) ? (parseConfig(fs.readFileSync(cfg, "utf8")) ?? {}) : null;

  if (existing === null) {
    // First time: settings out of .env into a new config.json.
    const moved = Object.fromEntries(Object.entries(parsed).filter(([k]) => !isEnvFile(k) && !isEnvOnly(k)));
    if (Object.keys(moved).length === 0) return null;
    fs.mkdirSync(history, { recursive: true });
    const backup = path.join(history, `.env.${stamp}.pre-config`);
    fs.copyFileSync(env, backup);
    fs.writeFileSync(cfg, renderConfig(moved));
    fs.writeFileSync(env, renderSecrets({ values: parsed, instanceDir: dir }), { mode: 0o600 });
    return { moved: Object.keys(moved).sort(), backup };
  }

  // A config.json from the day it briefly held the wiring ids: those go
  // back to .env, where what the bot may not change belongs.
  const back = Object.fromEntries(Object.entries(existing).filter(([k]) => isEnvFile(k)));
  if (Object.keys(back).length === 0) return null;
  fs.mkdirSync(history, { recursive: true });
  const backup = path.join(history, `.env.${stamp}.pre-wiring`);
  fs.copyFileSync(env, backup);
  const dot = path.join(dir, ".history");
  fs.mkdirSync(dot, { recursive: true });
  fs.copyFileSync(cfg, path.join(dot, `config.json.${stamp}`));
  const merged = { ...parsed, ...back };
  fs.writeFileSync(env, renderSecrets({ values: merged, instanceDir: dir }), { mode: 0o600 });
  fs.writeFileSync(cfg, renderConfig(existing));
  for (const [k, v] of Object.entries(back)) if (!process.env[k]) process.env[k] = v;
  return { movedBack: Object.keys(back).sort(), backup };
}

export const migrated = migrateEnvToConfig();

/**
 * THE SETTINGS ARE LIVE. config.json is re-read when its mtime moves, so a
 * change from the DM (src/settings.js) or by hand takes effect on the next
 * use with no restart — a budget, the review's clock, the timezone, who is
 * an admin, the ask channel. The exceptions are the values something is
 * BUILT from at boot: the slash-command prefix (registered once), the feed
 * poll interval (a timer), and whether the review's slash command exists.
 * Those say "restart" in the DM; everything else says "live now".
 */
let settingsCache = { mtimeMs: -1, values: {} };
let settingsOverride = null;

function liveSettings() {
  if (settingsOverride) return settingsOverride;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(configFile).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (mtimeMs !== settingsCache.mtimeMs) settingsCache = { mtimeMs, values: readConfigFile() || {} };
  return settingsCache.values;
}

/** Tests: pin the settings to an object (null to go back to the file). */
export function _setSettings(values) {
  settingsOverride = values;
}

/**
 * Where a value comes from. Secrets and paths: the environment (the shell,
 * or .env through dotenv). Everything else: config.json first, then the
 * environment as a fallback — for tests, and for a shell override somebody
 * means. The old trap of a shell CLAUDE_EFFORT silently outranking the file
 * is gone: config.json wins when it names the key.
 */
export function lookup(name) {
  if (isEnvFile(name) || isEnvOnly(name)) return (process.env[name] || "").trim();
  const live = liveSettings();
  if (Object.hasOwn(live, name)) return String(live[name]).trim();
  return (process.env[name] || "").trim();
}

/**
 * Where each optional value actually came from.
 *
 * dotenv does NOT override an existing process.env entry, so a variable
 * exported in your shell silently outranks .env. Generic names like
 * CLAUDE_EFFORT are exactly the ones a developer already has set globally for
 * something else — and this bot ran at effort "high" for its first evening
 * because of one, quietly paying for thinking nobody asked for. Neither
 * behaviour is wrong; being unable to see which one happened is.
 */
export const provenance = [];

function tracked(name, fallback) {
  const live = liveSettings();
  const fromConfig = Object.hasOwn(live, name) ? String(live[name]).trim() : "";
  const fromEnv = (process.env[name] || "").trim();
  const fromFile = (loaded.parsed?.[name] || "").trim();
  let source = "default";
  if (fromConfig) source = fromEnv && fromEnv !== fromConfig ? "config.json (shell differs, ignored)" : "config.json";
  else if (fromEnv && fromFile && fromEnv !== fromFile) source = "SHELL (shadows .env)";
  else if (fromEnv && fromFile) source = ".env (legacy; belongs in config.json)";
  else if (fromEnv) source = "shell";
  const value = fromConfig || fromEnv || fallback;
  provenance.push({ name, value, source });
  return value;
}

function required(name) {
  const value = lookup(name);
  if (!value) {
    throw new Error(
      `Missing ${name}: no usable ${isEnvFile(name) ? ".env" : "config.json"} in ${instanceDir}. Run \`npm run setup -- <instance-dir>\`, then \`INSTANCE_DIR=<instance-dir> npm run ...\`.`,
    );
  }
  return value;
}

function optional(name, fallback) {
  return lookup(name) || fallback;
}

function list(name) {
  return new Set(
    lookup(name)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/** Evaluates `build` once, on first access, then caches the result. */
function lazy(target, key, build) {
  let cached;
  let built = false;
  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      if (!built) {
        cached = build();
        built = true;
      }
      return cached;
    },
  });
}

/**
 * A routine names its destination by a logical name — `channel: reports` — and
 * the operator binds that name to an id with CHANNEL_REPORTS. The alternative
 * (ASK_CHANNEL_ID, NOTIFY_CHANNEL_ID) hardcoded not just two ids but the
 * existence of exactly two lanes, which is the thing this refactor is undoing.
 */
export function channelEnvName(name) {
  return `CHANNEL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function readChannels(env = { ...process.env, ...liveSettings() }) {
  const channels = new Map();
  for (const [key, value] of Object.entries(env)) {
    const match = /^CHANNEL_([A-Z0-9_]+)$/.exec(key);
    if (!match || !String(value).trim()) continue;
    channels.set(match[1].toLowerCase().replace(/_/g, "-"), String(value).trim());
  }
  return channels;
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const num = (name, fallback) => Number(optional(name, fallback));
const money = (name) => (lookup(name) ? Number(lookup(name)) : null);
let lastGoodTimezone = null;

export const config = {
  // THE MODEL IS THE OPERATOR'S CHOICE. This is the default for every routine
  // that does not name its own; prices live in agent/models.json, and a model
  // with no price is refused rather than billed at zero. Live: a routine
  // re-reads it every run.
  claude: {
    get model() {
      return optional("CLAUDE_MODEL", "claude-sonnet-5");
    },
    get effort() {
      return optional("CLAUDE_EFFORT", "medium");
    },
    get maxTokens() {
      return num("CLAUDE_MAX_TOKENS", "8000");
    },
  },
  // Schedules are written in whatever timezone the clan lives in. UTC is the
  // default because it is the only one that is never surprising, but an
  // operator writing "22:00" means their own evening, not Greenwich's. An
  // invalid zone is fatal at boot and ignored (last good one kept) later.
  get timezone() {
    const tz = optional("TIMEZONE", "UTC");
    if (validTimezone(tz)) {
      lastGoodTimezone = tz;
      return tz;
    }
    if (lastGoodTimezone) return lastGoodTimezone;
    throw new Error(`TIMEZONE "${tz}" is not a recognised IANA zone (e.g. America/Chicago).`);
  },
  // How often the feed is read. Thirty minutes, not five: every poll is a
  // metered call against the OWNER's budget, the feed is empty most of the
  // time, and the hub's own agents page says hourly is plenty. Five minutes
  // is 288 calls a day for the feed alone — more than half a member's whole
  // daily allowance — which is fine for an unlimited agent and a bad default
  // for an example project. Read once: it is a timer.
  eventPollSeconds: num("EVENT_POLL_SECONDS", "1800"),

  // MONTHLY BUDGETS, per lane, in dollars. Unset means unlimited — which is a
  // choice, not a default anybody should arrive at by accident, so the boot
  // log says so out loud.
  //
  // Two pots because two different people spend them: MONTHLY_BUDGET_USD is
  // what the bot does on its own (schedules, event briefs — a function of the
  // routines you wrote), and ASK_MONTHLY_BUDGET_USD is what clan members ask
  // for. One pot means a chatty afternoon quietly cancels tomorrow's war-deck
  // nudge and the only symptom is silence.
  get monthlyBudgetUsd() {
    return money("MONTHLY_BUDGET_USD");
  },
  get askMonthlyBudgetUsd() {
    return money("ASK_MONTHLY_BUDGET_USD");
  },
  // One member cannot spend the shared ask pot for everyone. 0 = no cap.
  get askDailyTurnsPerMember() {
    return num("ASK_DAILY_TURNS_PER_MEMBER", "20");
  },
  // What a single turn is assumed to cost before we have seen one. A lane
  // refuses to start a turn that could take it past its budget, and this is
  // the floor for that estimate; the real figure climbs to the largest turn
  // the lane has actually produced.
  get turnReserveUsd() {
    return num("TURN_RESERVE_USD", "0.30");
  },

  // Soft guard on top of the monthly budgets: the process stops answering once
  // the day's measured spend crosses this. Unset means no daily cap.
  get dailyUsdCap() {
    return money("DAILY_USD_CAP");
  },
  // Where the prompts live: `agent/` in the instance directory. Relative paths
  // resolve against the cwd, not the checkout — see instanceDir above.
  agentDir: path.resolve(instanceDir, optional("AGENT_DIR", "agent")),
  // Optional prefix for the slash commands. Three bots in one server each
  // register their own `/run`, and Discord tells them apart only by the
  // bot's avatar in the picker; `COMMAND_PREFIX=pk` makes this one's
  // `/pk-run` and leaves nothing to squint at. Read once: registered at boot.
  commandPrefix: optional("COMMAND_PREFIX", "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ""),
  // SCHEDULE_DISABLED is the pre-refactor name and still works; routines are
  // no longer only schedules, hence the better one.
  get disabled() {
    return new Set([...list("ROUTINES_DISABLED"), ...list("SCHEDULE_DISABLED")]);
  },
  // Discord ids allowed to use the admin slash commands and to DM the bot.
  get adminUserIds() {
    return list("ADMIN_USER_IDS");
  },
  // Logical channel name for maintainer replies to filed feedback. Unset falls
  // back to the first event routine's channel.
  get feedbackChannel() {
    return optional("FEEDBACK_CHANNEL", "") || null;
  },
  // How many post_message calls one turn may make. One event can fairly be
  // two posts (a welcome for members, a note for leaders); it is never five.
  get maxPostsPerTurn() {
    return num("MAX_POSTS_PER_TURN", "3");
  },
  // How much silence before the bot leans toward posting: quiet, normal or
  // chatty (src/prompt.js VOICES holds the hours). The bar for a post never
  // goes away; past the threshold it drops to "one true line beats nothing".
  get voice() {
    return optional("VOICE", "normal").toLowerCase();
  },
  // The boot hello: one line to the admins' DM saying the bot is up and
  // what build it is. STARTUP_MESSAGE=off to silence it.
  get startupMessage() {
    return optional("STARTUP_MESSAGE", "on").toLowerCase() !== "off";
  },

  // THE REVIEW LANE (src/review.js): the bot reading its own turn ledger and
  // proposing edits to agent/ — evaluation as a feature, off by default. Its
  // own model, because judging answers is a different job from giving them;
  // its own budget, because a week's reading is one big turn and must never
  // cost the ask lane a question; its own clock, in the operator's timezone.
  // All live except the slash command's existence (registered at boot).
  review: {
    get enabled() {
      return optional("REVIEW", "off").toLowerCase() === "on";
    },
    get model() {
      return optional("REVIEW_MODEL", "claude-opus-5");
    },
    get effort() {
      return optional("REVIEW_EFFORT", "high");
    },
    get monthlyBudgetUsd() {
      return money("REVIEW_MONTHLY_BUDGET_USD");
    },
    // "sun 20:00" — weekday (or "daily") and wall time. Weekly is the shape
    // this was designed for: enough turns to see a pattern, few enough
    // proposals to read.
    get at() {
      return parseReviewAt(optional("REVIEW_AT", "sun 20:00"));
    },
    // Let the review write agent/memory.md without a click. Never
    // identity.md, never a routine — those are policy and stay gated.
    get autoMemory() {
      return optional("REVIEW_AUTO_MEMORY", "false").toLowerCase() === "true";
    },
    // Proposals per review. Three is a decision; ten is a backlog.
    get maxProposals() {
      return num("REVIEW_MAX_PROPOSALS", "3");
    },
  },
};

/**
 * Every live getter above accepts assignment: a set value overrides the
 * file for this process. That is for tests (config.monthlyBudgetUsd = 10)
 * and for nothing else; the DM writes config.json.
 */
function overridable(target) {
  const overrides = new Map();
  for (const key of Object.keys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor?.get) {
      if (
        descriptor &&
        typeof descriptor.value === "object" &&
        descriptor.value &&
        !Array.isArray(descriptor.value) &&
        !(descriptor.value instanceof Set)
      )
        overridable(descriptor.value);
      continue;
    }
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => (overrides.has(key) ? overrides.get(key) : descriptor.get.call(target)),
      set: (value) => {
        overrides.set(key, value);
      },
    });
  }
  return target;
}
overridable(config);

// Boot-time provenance for the log, and a fail-fast on a bad zone.
tracked("CLAUDE_MODEL", "claude-sonnet-5");
tracked("CLAUDE_EFFORT", "medium");
tracked("TIMEZONE", "UTC");
tracked("REVIEW_MODEL", "claude-opus-5");
tracked("REVIEW_EFFORT", "high");
void config.timezone;

lazy(config, "mcp", () => ({
  // No default. The old one pointed at the personal /mcp door, which is not
  // where an agent lives, and a default that authenticates as the wrong kind
  // of principal is worse than an error message.
  url: required("ELIXIR_MCP_URL"),
  token: required("ELIXIR_MCP_TOKEN"),
  // The name the Claude API uses to reference this server in an mcp_toolset.
  serverName: "elixir-mcp",
}));

lazy(config, "discord", () => ({
  token: required("DISCORD_BOT_TOKEN"),
  guildId: required("DISCORD_GUILD_ID"),
}));

Object.defineProperty(config, "channels", { enumerable: true, get: () => readChannels() });

/** "sun 20:00" | "daily 07:30" | "mon,thu 21:00" -> { days: [0] | null, hour, minute }. */
export function parseReviewAt(raw) {
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const match = /^\s*([a-z,]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(String(raw));
  if (!match) throw new Error(`REVIEW_AT "${raw}" is not "<weekday|daily> HH:MM" (e.g. "sun 20:00")`);
  const [, when, h, m] = match;
  const hour = Number(h);
  const minute = Number(m);
  if (hour > 23 || minute > 59) throw new Error(`REVIEW_AT "${raw}": bad time`);
  if (when.toLowerCase() === "daily") return { days: null, hour, minute };
  const days = when
    .toLowerCase()
    .split(",")
    .map((d) => names.indexOf(d.slice(0, 3)));
  if (days.some((d) => d < 0)) throw new Error(`REVIEW_AT "${raw}": unknown weekday`);
  return { days, hour, minute };
}
