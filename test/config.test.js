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
  fs.writeFileSync(
    env,
    "ELIXIR_MCP_URL=https://x/a/1/mcp\nELIXIR_MCP_TOKEN=svt_1\nDISCORD_BOT_TOKEN=t\nANTHROPIC_API_KEY=k\nCHANNEL_ASK=2\nMONTHLY_BUDGET_USD=20.00\nSTATE_PATH=state/s.json\n",
  );
  const parsed = Object.fromEntries(
    fs
      .readFileSync(env, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split("=")),
  );
  const outcome = migrateEnvToConfig({ parsed, env, cfg, dir });
  assert.deepEqual(outcome.moved, ["CHANNEL_ASK", "MONTHLY_BUDGET_USD"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { CHANNEL_ASK: "2", MONTHLY_BUDGET_USD: "20.00" });
  const after = fs.readFileSync(env, "utf8");
  assert.match(
    after,
    /ELIXIR_MCP_TOKEN=svt_1\nDISCORD_BOT_TOKEN=t\nANTHROPIC_API_KEY=k\n\nELIXIR_MCP_URL=https:\/\/x\/a\/1\/mcp\nDISCORD_APP_ID=\nDISCORD_GUILD_ID=\nSTATE_PATH=state\/s\.json\n$/,
  );
  assert.doesNotMatch(after, /MONTHLY_BUDGET_USD|CHANNEL_ASK/);
  assert.match(
    fs.readFileSync(outcome.backup, "utf8"),
    /MONTHLY_BUDGET_USD=20\.00/,
    "the old .env is kept under state/",
  );
  assert.ok(outcome.backup.startsWith(path.join(dir, "state", "env-history")));
  assert.equal(
    migrateEnvToConfig({
      parsed: Object.fromEntries(
        after
          .trim()
          .split("\n")
          .filter((l) => /^[A-Z]/.test(l))
          .map((l) => l.split("=")),
      ),
      env,
      cfg,
      dir,
    }),
    null,
    "never twice",
  );

  // A config.json from the day it briefly held the wiring: the ids go back.
  fs.writeFileSync(
    cfg,
    JSON.stringify({ CHANNEL_ASK: "2", ELIXIR_MCP_URL: "https://x/a/1/mcp", DISCORD_GUILD_ID: "g1" }),
  );
  const parsedAfter = Object.fromEntries(
    after
      .trim()
      .split("\n")
      .filter((l) => /^[A-Z]/.test(l))
      .map((l) => l.split("=")),
  );
  const back = migrateEnvToConfig({ parsed: parsedAfter, env, cfg, dir });
  assert.deepEqual(back.movedBack, ["DISCORD_GUILD_ID", "ELIXIR_MCP_URL"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { CHANNEL_ASK: "2" });
  assert.match(
    fs.readFileSync(env, "utf8"),
    /ELIXIR_MCP_URL=https:\/\/x\/a\/1\/mcp\nDISCORD_APP_ID=\nDISCORD_GUILD_ID=g1\n/,
  );
  assert.ok(fs.existsSync(path.join(dir, ".history")), "the config.json before is kept");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings are live: a change to config.json is seen on the next read, no restart", async () => {
  const { config, _setSettings } = await import("../src/config.js");
  _setSettings({
    ASK_MONTHLY_BUDGET_USD: "15",
    TIMEZONE: "America/Chicago",
    ADMIN_USER_IDS: "111111111111111111",
    CHANNEL_ASK: "2",
    REVIEW: "on",
    REVIEW_AT: "sat 09:00",
  });
  assert.equal(config.askMonthlyBudgetUsd, 15);
  assert.equal(config.timezone, "America/Chicago");
  assert.deepEqual([...config.adminUserIds], ["111111111111111111"]);
  assert.equal(config.review.enabled, true);
  assert.deepEqual(config.review.at, { days: [6], hour: 9, minute: 0 });
  _setSettings({ ASK_MONTHLY_BUDGET_USD: "40", TIMEZONE: "not/a/zone", CHANNEL_ASK: "2" });
  assert.equal(config.askMonthlyBudgetUsd, 40, "the new value on the next read");
  assert.equal(config.timezone, "America/Chicago", "an invalid zone written later keeps the last good one");
  _setSettings(null);
  const { needsRestart } = await import("../src/settings.js");
  assert.equal(needsRestart(["ASK_MONTHLY_BUDGET_USD", "REVIEW_AT"]), false);
  assert.equal(needsRestart(["COMMAND_PREFIX"]), true);
  assert.equal(needsRestart(["EVENT_POLL_SECONDS"]), true);
});

test("a supervisor is recognised: launchd (pid 1), systemd user units (INVOCATION_ID), or SERVICE_MANAGED=1", async () => {
  const { serviceManaged } = await import("../src/settings.js");
  assert.equal(serviceManaged({}, 1), true, "launchd, or a systemd system unit");
  assert.equal(serviceManaged({ INVOCATION_ID: "5f0c…" }, 812), true, "a systemd --user unit's parent is not pid 1");
  assert.equal(serviceManaged({ SERVICE_MANAGED: "1" }, 0), true, "the container sets it; node is pid 1 there");
  assert.equal(serviceManaged({}, 4242), false, "a terminal: say a restart is needed, do not exit");
});
