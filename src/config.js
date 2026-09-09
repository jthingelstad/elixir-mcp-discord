/**
 * Configuration: environment for the WIRING, files for the CONTENT.
 *
 * That split is the whole shape of this project. Everything in here is about
 * how to reach things — credentials, channel ids, a timezone, a spend cap.
 * Nothing in here is about a clan, and nothing in here is a prompt. What the
 * agent says and when it says it lives in `agent/` as text an operator owns,
 * so installing this for a different clan is a token, some channel ids, and
 * whatever prompts you want. There is no code to fork.
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

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const loaded = dotenv.config({ quiet: true });

export const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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
  const fromEnv = (process.env[name] || "").trim();
  const fromFile = (loaded.parsed?.[name] || "").trim();
  let source = "default";
  if (fromEnv && fromFile && fromEnv !== fromFile)
    source = "SHELL (shadows .env)";
  else if (fromEnv && fromFile) source = ".env";
  else if (fromEnv) source = "shell";
  provenance.push({ name, value: fromEnv || fallback, source });
  return fromEnv || fallback;
}

function required(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name, fallback) {
  const value = (process.env[name] || "").trim();
  return value || fallback;
}

function list(name) {
  return new Set(
    (process.env[name] || "")
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

export function readChannels(env = process.env) {
  const channels = new Map();
  for (const [key, value] of Object.entries(env)) {
    const match = /^CHANNEL_([A-Z0-9_]+)$/.exec(key);
    if (!match || !String(value).trim()) continue;
    channels.set(
      match[1].toLowerCase().replace(/_/g, "-"),
      String(value).trim(),
    );
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

export const config = {
  // THE MODEL IS THE OPERATOR'S CHOICE. This is the default for every routine
  // that does not name its own; prices live in agent/models.json, and a model
  // with no price is refused rather than billed at zero.
  claude: {
    model: tracked("CLAUDE_MODEL", "claude-sonnet-5"),
    effort: tracked("CLAUDE_EFFORT", "medium"),
    maxTokens: Number(optional("CLAUDE_MAX_TOKENS", "8000")),
  },
  // Schedules are written in whatever timezone the clan lives in. UTC is the
  // default because it is the only one that is never surprising, but an
  // operator writing "22:00" means their own evening, not Greenwich's.
  timezone: (() => {
    const tz = tracked("TIMEZONE", "UTC");
    if (!validTimezone(tz)) {
      throw new Error(
        `TIMEZONE "${tz}" is not a recognised IANA zone (e.g. America/Chicago).`,
      );
    }
    return tz;
  })(),
  eventPollSeconds: Number(optional("EVENT_POLL_SECONDS", "300")),

  // MONTHLY BUDGETS, per lane, in dollars. Unset means unlimited — which is a
  // choice, not a default anybody should arrive at by accident, so the boot
  // log says so out loud.
  //
  // Two pots because two different people spend them: MONTHLY_BUDGET_USD is
  // what the bot does on its own (schedules, event briefs — a function of the
  // routines you wrote), and ASK_MONTHLY_BUDGET_USD is what clan members ask
  // for. One pot means a chatty afternoon quietly cancels tomorrow's war-deck
  // nudge and the only symptom is silence.
  monthlyBudgetUsd: process.env.MONTHLY_BUDGET_USD
    ? Number(process.env.MONTHLY_BUDGET_USD)
    : null,
  askMonthlyBudgetUsd: process.env.ASK_MONTHLY_BUDGET_USD
    ? Number(process.env.ASK_MONTHLY_BUDGET_USD)
    : null,
  // What a single turn is assumed to cost before we have seen one. A lane
  // refuses to start a turn that could take it past its budget, and this is
  // the floor for that estimate; the real figure climbs to the largest turn
  // the lane has actually produced.
  turnReserveUsd: Number(optional("TURN_RESERVE_USD", "0.30")),

  // Soft guard on top of the monthly budgets: the process stops answering once
  // the day's measured spend crosses this. Unset means no daily cap.
  dailyUsdCap: process.env.DAILY_USD_CAP
    ? Number(process.env.DAILY_USD_CAP)
    : null,
  // Where the prompts live. Point it at a private directory to keep your own
  // agent's voice out of a public checkout.
  agentDir: path.resolve(repoRoot, optional("AGENT_DIR", "agent")),
  // SCHEDULE_DISABLED is the pre-refactor name and still works; routines are
  // no longer only schedules, hence the better one.
  disabled: new Set([
    ...list("ROUTINES_DISABLED"),
    ...list("SCHEDULE_DISABLED"),
  ]),
  // Discord ids allowed to run a routine on demand with `!run <key>`.
  adminUserIds: list("ADMIN_USER_IDS"),
  // Logical channel name for maintainer replies to filed feedback. Unset falls
  // back to the first event routine's channel.
  feedbackChannel: optional("FEEDBACK_CHANNEL", "") || null,
};

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

lazy(config, "channels", () => readChannels());
