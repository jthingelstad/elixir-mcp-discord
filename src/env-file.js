/**
 * The two files setup writes, rendered the same way every time so two
 * instances diff cleanly:
 *
 *   .env          SECRETS ONLY — the Elixir key, the Discord token, the
 *                 Claude key — plus, if someone set one, a path override
 *                 (STATE_PATH, AGENT_DIR). Mode 0600, never versioned.
 *   config.json   every other setting, flat, the same key names the docs
 *                 use, sorted. Versioned with the instance, backed up under
 *                 .history/, edited from the DM (src/settings.js).
 *
 * Pure functions: src/config.js uses them for the one-time migration of a
 * pre-config.json instance, setup uses them to write.
 */

import path from "node:path";

/** The three that belong in .env and nowhere else. */
export const SECRET_KEYS = ["ELIXIR_MCP_TOKEN", "DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY"];

/** Environment-only: where an instance is, and test switches. Never in config.json. */
export const ENV_ONLY_KEYS = ["INSTANCE_DIR", "STATE_PATH", "AGENT_DIR", "LEDGER_DIR", "LEDGER_BODY_CHARS", "SERVICE_MANAGED", "PATH"];

export const isSecret = (key) => SECRET_KEYS.includes(key);
export const isEnvOnly = (key) => ENV_ONLY_KEYS.includes(key);

export function isChannelKey(key) {
  return /^CHANNEL_[A-Z0-9_]+$/.test(key);
}

/** .env: secrets, and any path override, nothing else. */
export function renderSecrets({ values, instanceDir }) {
  return [
    `# elixir-mcp-discord instance: ${path.basename(instanceDir)}`,
    `# Secrets only. Every other setting is in config.json (written by setup,`,
    `# editable from the DM). A path override such as STATE_PATH may also go here.`,
    ...SECRET_KEYS.map((k) => `${k}=${values[k] ?? ""}`),
    ...Object.entries(values)
      .filter(([k, v]) => isEnvOnly(k) && k !== "PATH" && k !== "INSTANCE_DIR" && String(v ?? "") !== "")
      .map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
}

/** config.json: every non-secret, non-path key with a value, sorted. */
export function renderConfig(values) {
  const keys = Object.keys(values)
    .filter((k) => !isSecret(k) && !isEnvOnly(k) && !k.startsWith("_") && String(values[k] ?? "") !== "")
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
