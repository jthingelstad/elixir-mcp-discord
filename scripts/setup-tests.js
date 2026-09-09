/**
 * Lives in scripts/ under this name because Node's default test discovery
 * claims both anything inside a test directory and anything named test-
 * something — under either of those it would be picked up and run as a test
 * file of its own, which is how it briefly turned a 13-test suite into 14.
 *
 * Loaded via `--import` so it runs BEFORE any test file's imports are
 * evaluated — ESM hoists imports, so setting these at the top of a test file
 * would be too late.
 *
 * Fills in only what is missing, so the suite runs on a fresh clone with no
 * .env at all. Nothing here reaches the network: these values exist purely to
 * let the modules construct. A test that needed a real credential would be an
 * integration test, and this suite is deliberately not that.
 *
 * STATE_PATH is redirected into a temp file. The suite exercises the spend
 * counter and the run ledger, and a test run must not move a live bot's cursor
 * or spend a day's budget on paper.
 */

import os from "node:os";
import path from "node:path";

process.env.ELIXIR_MCP_URL ||= "https://elixir.example.com/a/testagent/mcp";
process.env.ELIXIR_MCP_TOKEN ||= "svt_test";
process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_GUILD_ID ||= "1";
process.env.CHANNEL_ASK ||= "2";
process.env.CHANNEL_PULSE ||= "3";
process.env.ANTHROPIC_API_KEY ||= "sk-ant-test";
process.env.STATE_PATH ||= path.join(os.tmpdir(), `elixir-mcp-discord-test-${process.pid}.json`);
