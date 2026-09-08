/**
 * Configuration is entirely environment-driven — there is no POAP KINGS
 * anything in this repo. Point CLAN_TAG and the two channel IDs somewhere else
 * and this bot runs for a different clan with no code change. That is the
 * point: this is a worked example of powering a clan Discord with Elixir MCP,
 * not a private tool with the serial numbers filed off.
 *
 * Each section validates when it is first READ, not at import. `npm run probe`
 * needs nothing but the MCP credentials, and making it demand a Discord token
 * to tell you whether your service token works would be a silly gate to walk
 * into on your first run.
 */

import "dotenv/config";

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

export const config = {
  claude: {
    model: optional("CLAUDE_MODEL", "claude-sonnet-5"),
    effort: optional("CLAUDE_EFFORT", "medium"),
    maxTokens: 8000,
  },
  notifyPollSeconds: Number(optional("NOTIFY_POLL_SECONDS", "300")),
  askHistoryTurns: Number(optional("ASK_HISTORY_TURNS", "8")),
  // Soft guard, not a hard gate: the process warns loudly and stops answering
  // once the day's measured spend crosses this. Unset means no cap.
  dailyUsdCap: process.env.DAILY_USD_CAP ? Number(process.env.DAILY_USD_CAP) : null,
};

lazy(config, "mcp", () => ({
  url: optional("ELIXIR_MCP_URL", "https://elixir.poapkings.com/mcp"),
  token: required("ELIXIR_MCP_TOKEN"),
  // The name the Claude API uses to reference this server in an mcp_toolset.
  serverName: "elixir-mcp",
}));

/**
 * Clash Royale tags start with `#`, which is a comment character to dotenv — an
 * unquoted `CLAN_TAG=#J2RGCRVG` parses as the empty string and the failure
 * surfaces far from its cause. So: say so in the error, and accept the tag with
 * or without the `#` since quoting is the thing people forget.
 */
lazy(config, "clanTag", () => {
  const raw = (process.env.CLAN_TAG || "").trim();
  if (!raw) {
    throw new Error(
      'Missing CLAN_TAG. If it is set, check that it is QUOTED in .env — an ' +
        'unquoted value starting with "#" is read as a comment. Use CLAN_TAG="#J2RGCRVG".',
    );
  }
  return raw.startsWith("#") ? raw : `#${raw}`;
});

lazy(config, "discord", () => ({
  token: required("DISCORD_BOT_TOKEN"),
  guildId: required("DISCORD_GUILD_ID"),
  askChannelId: required("ASK_CHANNEL_ID"),
  notifyChannelId: required("NOTIFY_CHANNEL_ID"),
}));
