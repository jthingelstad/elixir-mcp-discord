/**
 * Defaults are the part of an example project other people actually copy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";

test("the feed is polled every thirty minutes unless the operator says otherwise", () => {
  // The hub's own guidance: hourly is plenty, and five minutes was more than
  // half a member's daily call budget spent on an empty feed.
  if (!process.env.EVENT_POLL_SECONDS) assert.equal(config.eventPollSeconds, 1800);
});

test("a pre-config.json instance is migrated once: settings to config.json, .env down to secrets, a backup under state/", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { migrateEnvToConfig } = await import("../src/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-migrate-"));
  const env = path.join(dir, ".env");
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(env, "ELIXIR_MCP_URL=https://x/a/1/mcp\nELIXIR_MCP_TOKEN=svt_1\nDISCORD_BOT_TOKEN=t\nANTHROPIC_API_KEY=k\nCHANNEL_ASK=2\nMONTHLY_BUDGET_USD=20.00\nSTATE_PATH=state/s.json\n");
  const parsed = Object.fromEntries(fs.readFileSync(env, "utf8").trim().split("\n").map((l) => l.split("=")));
  const outcome = migrateEnvToConfig({ parsed, env, cfg, dir });
  assert.deepEqual(outcome.moved, ["CHANNEL_ASK", "MONTHLY_BUDGET_USD"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { CHANNEL_ASK: "2", MONTHLY_BUDGET_USD: "20.00" });
  const after = fs.readFileSync(env, "utf8");
  assert.match(after, /ELIXIR_MCP_TOKEN=svt_1\nDISCORD_BOT_TOKEN=t\nANTHROPIC_API_KEY=k\n\nELIXIR_MCP_URL=https:\/\/x\/a\/1\/mcp\nDISCORD_APP_ID=\nDISCORD_GUILD_ID=\nSTATE_PATH=state\/s\.json\n$/);
  assert.doesNotMatch(after, /MONTHLY_BUDGET_USD|CHANNEL_ASK/);
  assert.match(fs.readFileSync(outcome.backup, "utf8"), /MONTHLY_BUDGET_USD=20\.00/, "the old .env is kept under state/");
  assert.ok(outcome.backup.startsWith(path.join(dir, "state", "env-history")));
  assert.equal(migrateEnvToConfig({ parsed: Object.fromEntries(after.trim().split("\n").filter((l) => /^[A-Z]/.test(l)).map((l) => l.split("="))), env, cfg, dir }), null, "never twice");

  // A config.json from the day it briefly held the wiring: the ids go back.
  fs.writeFileSync(cfg, JSON.stringify({ CHANNEL_ASK: "2", ELIXIR_MCP_URL: "https://x/a/1/mcp", DISCORD_GUILD_ID: "g1" }));
  const parsedAfter = Object.fromEntries(after.trim().split("\n").filter((l) => /^[A-Z]/.test(l)).map((l) => l.split("=")));
  const back = migrateEnvToConfig({ parsed: parsedAfter, env, cfg, dir });
  assert.deepEqual(back.movedBack, ["DISCORD_GUILD_ID", "ELIXIR_MCP_URL"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { CHANNEL_ASK: "2" });
  assert.match(fs.readFileSync(env, "utf8"), /ELIXIR_MCP_URL=https:\/\/x\/a\/1\/mcp\nDISCORD_APP_ID=\nDISCORD_GUILD_ID=g1\n/);
  assert.ok(fs.existsSync(path.join(dir, ".history")), "the config.json before is kept");
  fs.rmSync(dir, { recursive: true, force: true });
});
