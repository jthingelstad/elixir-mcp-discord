/**
 * `npm run probe` — a standalone connectivity and surface check. Run it before
 * starting the bot, and any time an answer looks wrong.
 *
 * It prints the contract version, the tool fingerprint, and the tool list, then
 * shows what changed since the last probe. That last part is the whole reason
 * it exists: this project's one standing operational risk is the Elixir MCP
 * tool surface moving without anyone noticing.
 */

import { initialize, listTools, callTool, describePrincipal } from "./mcp.js";
import * as state from "./state.js";
import { config } from "./config.js";

const handshake = await initialize();
if (!handshake.ok) {
  console.error(`FAIL  initialize: ${handshake.error}`);
  process.exit(1);
}
console.log(`ok    connected to ${config.mcp.url}`);
console.log(`      serverInfo.version = ${handshake.version}`);
console.log(`      principal = ${describePrincipal(handshake.principal)}`);
if (handshake.principal && handshake.principal.kind !== "agent") {
  console.log(`      WARNING: this is a ${handshake.principal.kind} connection, not an agent.`);
  console.log(`      "Me" will be a person, not the clan. See /docs/agents.`);
}

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

// game_clock, deliberately: it is on every principal's surface and needs no
// subject. This check used to call elixir_my_players, which an AGENT door does
// not publish and REFUSES on call -- so a perfectly healthy agent key failed
// its own probe with a person-only tool name in the error.
const clock = await callTool("game_clock", {});
if (!clock.ok) {
  console.error(`FAIL  game_clock: ${clock.error}`);
  process.exit(1);
}
console.log(`ok    key authenticated`);

const events = await callTool("elixir_events", { limit: 1, mark_seen: false });
if (!events.ok) {
  console.error(`FAIL  elixir_events: ${events.error}`);
  process.exit(1);
}
const cursors = state.get("cursors") || {};
const positions = Object.entries(cursors).map(([key, at]) => `${key}=${at}`).join(", ");
console.log(`ok    event feed readable; local cursors = ${positions || "unset (seed on first poll)"}`);
console.log(`      pending on account = ${events.body?.meta?.events_pending ?? "?"}`);
console.log(`      spend today = $${state.todaySpend().toFixed(4)}`);
