/**
 * Configuration is entirely environment-driven — there is no POAP KINGS
 * anything in this repo. Point CLAN_TAG and the two channel IDs somewhere else
 * and this bot runs for a different clan with no code change. That is the
 * point: this is a worked example of powering a clan Discord with Elixir MCP,
 * not a private tool with the serial numbers filed off.
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

export const config = {
  mcp: {
    url: optional("ELIXIR_MCP_URL", "https://elixir.poapkings.com/mcp"),
    token: required("ELIXIR_MCP_TOKEN"),
    // The name the Claude API uses to reference this server in an mcp_toolset.
    serverName: "elixir-mcp",
  },
  clanTag: required("CLAN_TAG"),
  discord: {
    token: required("DISCORD_BOT_TOKEN"),
    guildId: required("DISCORD_GUILD_ID"),
    askChannelId: required("ASK_CHANNEL_ID"),
    notifyChannelId: required("NOTIFY_CHANNEL_ID"),
  },
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
