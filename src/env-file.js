/**
 * The two files setup writes, rendered the same way every time so two
 * instances diff cleanly. The rule that decides which file a key goes in:
 *
 *   .env          what the bot may NOT change about itself — the three
 *                 secrets and the three wiring ids (the Elixir door, the
 *                 Discord application, the server) — plus, if someone set
 *                 one, a path override. Mode 0600, never versioned.
 *   config.json   what the bot MAY change from the DM (src/settings.js):
 *                 every other setting, flat, the same key names the docs
 *                 use, sorted. Versioned with the instance, backed up under
 *                 .history/.
 *
 * "If it isn't editable it belongs in .env" (Jamie, 2026-09-15). The ids
 * are not secrets, but a versioned settings file that carries lines the
 * DM refuses to touch is a file with two rules in it.
 *
 * Pure functions: src/config.js uses them for the one-time migration of a
 * pre-config.json instance, setup uses them to write.
 */

import path from "node:path";

/** The three secrets. */
export const SECRET_KEYS = ["ELIXIR_MCP_TOKEN", "DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY"];
/** The three wiring ids: not secret, not the bot's to change, so .env. */
export const WIRING_KEYS = ["ELIXIR_MCP_URL", "DISCORD_APP_ID", "DISCORD_GUILD_ID"];
/** Everything .env holds, in the order it is written. */
export const ENV_FILE_KEYS = [...SECRET_KEYS, ...WIRING_KEYS];

/** Environment-only: where an instance is, and test switches. Never in config.json. */
export const ENV_ONLY_KEYS = [
  "INSTANCE_DIR",
  "STATE_PATH",
  "AGENT_DIR",
  "LEDGER_DIR",
  "LEDGER_BODY_CHARS",
  "SERVICE_MANAGED",
  "PATH",
];

export const isEnvFile = (key) => ENV_FILE_KEYS.includes(key);
export const isEnvOnly = (key) => ENV_ONLY_KEYS.includes(key);

/** .env: secrets, wiring, and any path override, nothing else. */
export function renderSecrets({ values, instanceDir }) {
  return [
    `# elixir-mcp-discord instance: ${path.basename(instanceDir)}`,
    `# What the bot may not change about itself: secrets and wiring. Every`,
    `# other setting is in config.json (written by setup, editable from the DM).`,
    `# A path override such as STATE_PATH may also go here.`,
    ...SECRET_KEYS.map((k) => `${k}=${values[k] ?? ""}`),
    ``,
    ...WIRING_KEYS.map((k) => `${k}=${values[k] ?? ""}`),
    ...Object.entries(values)
      .filter(([k, v]) => isEnvOnly(k) && k !== "PATH" && k !== "INSTANCE_DIR" && String(v ?? "") !== "")
      .map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
}

/** config.json: every key that is not .env's or a path, with a value, sorted. */
export function renderConfig(values) {
  const keys = Object.keys(values)
    .filter((k) => !isEnvFile(k) && !isEnvOnly(k) && !k.startsWith("_") && String(values[k] ?? "") !== "")
    .sort();
  return `${JSON.stringify(Object.fromEntries(keys.map((k) => [k, String(values[k])])), null, 2)}\n`;
}

/** The flat string map a config.json holds; `_`-prefixed keys are notes. */
export function parseConfig(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([k, v]) => !k.startsWith("_") && v !== null && typeof v !== "object")
        .map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return null;
  }
}
