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
 */

process.env.ELIXIR_MCP_TOKEN ||= "svt_test";
process.env.CLAN_TAG ||= "#2GUCVLQR";
process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_GUILD_ID ||= "1";
process.env.ASK_CHANNEL_ID ||= "2";
process.env.NOTIFY_CHANNEL_ID ||= "3";
process.env.ANTHROPIC_API_KEY ||= "sk-ant-test";
