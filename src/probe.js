/**
 * `npm run probe` — a standalone connectivity and surface check. Run it before
 * starting the bot, and any time an answer looks wrong.
 *
 * It prints the contract version, the tool fingerprint, and the tool list, then
 * shows what changed since the last probe. That last part is the whole reason
 * it exists: this project's one standing operational risk is the Elixir MCP
 * tool surface moving without anyone noticing.
 */

import { initialize, listTools, callTool } from "./mcp.js";
import * as state from "./state.js";
import { config } from "./config.js";

const handshake = await initialize();
if (!handshake.ok) {
  console.error(`FAIL  initialize: ${handshake.error}`);
  process.exit(1);
}
console.log(`ok    connected to ${config.mcp.url}`);
console.log(`      serverInfo.version = ${handshake.version}`);

const previous = state.get("serverVersion");
if (previous && previous !== handshake.version) {
  console.log(`      CHANGED since last probe (was ${previous})`);
  const changelog = await callTool("elixir_changelog", {});
  if (changelog.ok) {
    console.log(`      changelog: ${JSON.stringify(changelog.body).slice(0, 800)}`);
  }
}
state.set({ serverVersion: handshake.version });

const tools = await listTools();
if (!tools.ok) {
  console.error(`FAIL  tools/list: ${tools.error}`);
  process.exit(1);
}
console.log(`ok    ${tools.tools.length} tools published`);
console.log(`      ${tools.tools.map((t) => t.name).sort().join(", ")}`);

const identity = await callTool("elixir_my_players", {});
if (!identity.ok) {
  console.error(`FAIL  elixir_my_players: ${identity.error}`);
  process.exit(1);
}
console.log(`ok    token authenticated`);

const events = await callTool("elixir_events", { limit: 1, mark_seen: false });
if (!events.ok) {
  console.error(`FAIL  elixir_events: ${events.error}`);
  process.exit(1);
}
console.log(`ok    event feed readable; local cursor = ${state.get("eventCursor") ?? "unset"}`);
console.log(`      pending on account = ${events.body?.meta?.events_pending ?? "?"}`);
console.log(`      spend today = $${state.todaySpend().toFixed(4)}`);
