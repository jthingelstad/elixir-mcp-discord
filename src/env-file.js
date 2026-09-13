/**
 * The .env setup writes: the same keys in the same order every time, commented
 * the same way, so two instances' files diff cleanly and a value that moved
 * sections is visible. Anything setup does not manage is carried over verbatim
 * at the bottom rather than dropped — a DAILY_USD_CAP someone set by hand is
 * not setup's to lose.
 */

import path from "node:path";

export const MANAGED_KEYS = [
  "ELIXIR_MCP_URL", "ELIXIR_MCP_TOKEN",
  "DISCORD_APP_ID", "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID",
  "ANTHROPIC_API_KEY", "CLAUDE_MODEL",
  "COMMAND_PREFIX", "TIMEZONE", "MONTHLY_BUDGET_USD", "ASK_MONTHLY_BUDGET_USD",
  "EVENT_POLL_SECONDS", "ADMIN_USER_IDS",
];

export function isChannelKey(key) {
  return /^CHANNEL_[A-Z0-9_]+$/.test(key);
}

export function renderEnv({ values, instanceDir }) {
  const channelKeys = Object.keys(values).filter(isChannelKey);
  const carried = Object.entries(values).filter(
    ([key]) => !MANAGED_KEYS.includes(key) && !isChannelKey(key),
  );
  const line = (key) => `${key}=${values[key] ?? ""}`;
  return [
    `# elixir-mcp-discord instance: ${path.basename(instanceDir)}`,
    `# Written by npm run setup. Wiring only: what this bot says lives in ./agent.`,
    `# Every value is THIS bot's own; nothing here is shared with another instance.`,
    ``,
    `# --- Elixir MCP: the agent's door (elixir.poapkings.com > Account > Agents)`,
    line("ELIXIR_MCP_URL"),
    line("ELIXIR_MCP_TOKEN"),
    ``,
    `# --- Discord: this bot's own application, invited with bot + applications.commands`,
    line("DISCORD_APP_ID"),
    line("DISCORD_BOT_TOKEN"),
    line("DISCORD_GUILD_ID"),
    ...channelKeys.sort().map(line),
    `# Three bots on one server each register /run; the prefix keeps them apart.`,
    line("COMMAND_PREFIX"),
    ``,
    `# --- Claude`,
    line("ANTHROPIC_API_KEY"),
    line("CLAUDE_MODEL"),
    ``,
    `# --- Budgets (strict, UTC months, per lane) and schedule`,
    line("MONTHLY_BUDGET_USD"),
    line("ASK_MONTHLY_BUDGET_USD"),
    line("TIMEZONE"),
    line("EVENT_POLL_SECONDS"),
    line("ADMIN_USER_IDS"),
    ...(carried.length
      ? [``, `# --- Carried over from the previous .env`, ...carried.map(([key, value]) => `${key}=${value}`)]
      : []),
    ``,
  ].join("\n");
}

