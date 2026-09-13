/**
 * `npm run setup -- <instance-dir>` — stand up one bot, end to end, with every
 * credential checked against the service it is for before it is written down.
 *
 *   npm run setup -- ~/.elixir-mcp-discord/shipit          guided, re-runnable
 *   npm run setup -- ~/.elixir-mcp-discord/shipit --check  no prompts: validate
 *                                                          the .env that is there
 *
 * One bot is three API credentials and a Discord application, and each of the
 * four fails in its own unhelpful way: a wrong Elixir key is "http 401" at
 * 01:00, a personal key instead of an agent key answers as a person, a Claude
 * key for the wrong workspace is a 401 on the first question a member asks,
 * an application without the Message Content intent dies at login with "Used
 * disallowed intents", a bot that was never invited is "channel unresolvable",
 * and a channel the bot's role cannot see is a routine that spends a model
 * call and posts nothing. Doing three of these at once for three clans is
 * where a pasted id lands one channel off. So this asks for each value, tries
 * it, explains what is wrong with the fix beside it, and waits while you make
 * the change — then writes the .env only when it has seen every piece work.
 *
 * Re-running it on an existing instance keeps every value on Enter, so it is
 * also how you rotate one key or move one channel.
 *
 * It deliberately does not import src/config.js's validated sections: those
 * read the CURRENT working directory, and setup is about a directory that may
 * not have a .env yet.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { initialize, describePrincipal } from "./mcp.js";
import { loadRoutines } from "./routines.js";
import { priceBook } from "./pricing.js";
import { requirementsFor, inspectChannel } from "./permissions.js";
import { inspectDiscord, permissionsIn, channelLike, inviteUrl } from "./discord-rest.js";
import { channelEnvName } from "./config.js";
import { renderEnv } from "./env-file.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: npm run setup -- <instance-dir> [--check]");
  process.exit(2);
}
const instanceDir = path.resolve(target);
const envFile = path.join(instanceDir, ".env");
const agentDir = path.join(instanceDir, "agent");
const interactive = !checkOnly && process.stdin.isTTY;

// --- output ------------------------------------------------------------------

const ok = (line) => console.log(`ok    ${line}`);
const note = (line) => console.log(`      ${line}`);
const fail = (problem) => {
  console.log(`FAIL  ${problem.detail}`);
  if (problem.fix) for (const line of problem.fix.split("\n")) console.log(`      fix: ${line}`);
};
const heading = (title) => console.log(`\n== ${title}`);

// --- prompts -----------------------------------------------------------------

async function ask(question, { fallback = "", secret = false } = {}) {
  if (!interactive) return fallback;
  const hint = secret
    ? fallback ? " [Enter keeps the current one]" : ""
    : fallback ? ` [${fallback}]` : "";
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = readline.createInterface({
    input: process.stdin,
    output: secret ? muted : process.stdout,
    terminal: true,
  });
  // readline redraws its own prompt on the terminal, wiping anything written
  // before it; so the visible question goes through readline, and only the
  // muted one is written directly.
  const prompt = `${question}${hint}: `;
  if (secret) process.stdout.write(prompt);
  let answer;
  try {
    answer = (await rl.question(secret ? "" : prompt)).trim();
  } finally {
    rl.close();
    if (secret) process.stdout.write("\n");
  }
  return answer || fallback;
}

/** Run `attempt` until it reports no problems. Interactively, every failure
 *  is followed by a chance to fix it and try again; `skip` moves on with the
 *  problems left standing. */
async function untilOk(attempt) {
  for (;;) {
    const problems = await attempt();
    if (problems.length === 0) return true;
    for (const problem of problems) fail(problem);
    if (!interactive) return false;
    const answer = await ask("Fix that and press Enter to check again, or type 'skip'");
    if (answer.toLowerCase() === "skip") return false;
  }
}

// --- the instance directory --------------------------------------------------

heading(`instance ${instanceDir}`);
fs.mkdirSync(path.join(instanceDir, "state"), { recursive: true });
if (!fs.existsSync(path.join(agentDir, "routines"))) {
  if (checkOnly) {
    fail({ detail: `${agentDir} has no routines`, fix: `cp -R ${path.join(repoRoot, "agent")} ${agentDir}` });
    process.exit(1);
  }
  fs.cpSync(path.join(repoRoot, "agent"), agentDir, { recursive: true });
  ok(`copied the example prompts to ${agentDir} — rewrite identity.md for this clan`);
} else {
  ok(`prompts in ${agentDir}`);
}

const env = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile, "utf8")) : {};
note(fs.existsSync(envFile) ? `existing .env loaded; Enter keeps each current value` : `no .env yet; one will be written at the end`);

const { routines, errors } = loadRoutines({ dir: agentDir });
for (const failure of errors) fail({ detail: `routine ${failure.key}: ${failure.error}` });
const requirements = requirementsFor(routines, { feedbackChannel: env.FEEDBACK_CHANNEL || null });
ok(`${routines.length} routines need channels: ${requirements.map((r) => r.name).join(", ")}`);

const values = { ...env };
const unresolved = [];

// --- Elixir MCP ----------------------------------------------------------------

heading("Elixir MCP (the agent's door)");
note("Create the agent at https://elixir.poapkings.com > Account > Agents. The URL");
note("and key are shown together, once; the key is stored only as a hash.");
const elixirOk = await untilOk(async () => {
  values.ELIXIR_MCP_URL = await ask("Agent URL", { fallback: values.ELIXIR_MCP_URL });
  values.ELIXIR_MCP_TOKEN = await ask("Agent key", { fallback: values.ELIXIR_MCP_TOKEN, secret: true });
  if (!values.ELIXIR_MCP_URL || !values.ELIXIR_MCP_TOKEN) {
    return [{ detail: "the Elixir MCP URL and key are both required" }];
  }
  if (!/\/a\/[0-9a-f]+\/mcp$/i.test(values.ELIXIR_MCP_URL)) {
    return [{
      detail: `${values.ELIXIR_MCP_URL} is not an agent door`,
      fix: "an agent's URL ends in /a/<id>/mcp; the personal /mcp would answer as you, not the clan",
    }];
  }
  const handshake = await initialize({ url: values.ELIXIR_MCP_URL, token: values.ELIXIR_MCP_TOKEN });
  if (!handshake.ok) {
    return [{
      detail: `initialize failed: ${handshake.error}`,
      fix: handshake.error.includes("401")
        ? "the key was refused at this door; check the key matches this agent's URL, or revoke and mint a new one"
        : "check the URL, then that the host is reachable from here",
    }];
  }
  const principal = handshake.principal;
  ok(`connected · ${handshake.version} · ${describePrincipal(principal)}`);
  if (principal && principal.kind !== "agent") {
    return [{
      detail: `this is a ${principal.kind} key, not an agent`,
      fix: "the bot must be its own principal; create an agent and use its key",
    }];
  }
  if (principal?.kind === "agent" && !principal.subject) {
    return [{ detail: "this agent has no clan", fix: "an agent acts for a clan; set one on the agent in Elixir" }];
  }
  return [];
});
if (!elixirOk) unresolved.push("Elixir MCP");

// --- Claude --------------------------------------------------------------------

heading("Claude");
note("One key per bot, ideally from its own Workspace at console.anthropic.com so");
note("the spend is visible per clan there as well as in /budget here.");
const claudeOk = await untilOk(async () => {
  values.ANTHROPIC_API_KEY = await ask("API key", { fallback: values.ANTHROPIC_API_KEY, secret: true });
  values.CLAUDE_MODEL = await ask("Default model", { fallback: values.CLAUDE_MODEL || "claude-sonnet-5" });
  if (!values.ANTHROPIC_API_KEY) return [{ detail: "an API key is required" }];
  const client = new Anthropic({ apiKey: values.ANTHROPIC_API_KEY, maxRetries: 0 });
  try {
    const model = await client.models.retrieve(values.CLAUDE_MODEL);
    ok(`key accepted · ${model.display_name} (${model.id})`);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return [{ detail: "Claude rejected the key", fix: "console.anthropic.com > API keys; paste the whole key including the sk-ant- prefix" }];
    }
    if (error instanceof Anthropic.NotFoundError) {
      return [{ detail: `no model called ${values.CLAUDE_MODEL}`, fix: "use an id from https://docs.anthropic.com/en/docs/about-claude/models" }];
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return [{ detail: `this key may not use ${values.CLAUDE_MODEL}`, fix: "the workspace this key belongs to is not allowed that model; pick another or change the workspace's model access" }];
    }
    return [{ detail: `Claude API: ${error.message}`, fix: "retry; if it persists, check the key's workspace is active" }];
  }
  // Priced, or the budgets are decoration — the same rule as boot.
  const book = priceBook({ dir: agentDir, reload: true });
  const rate = book[values.CLAUDE_MODEL];
  const perRoutine = routines.filter((r) => r.model && r.model !== values.CLAUDE_MODEL && !book[r.model]);
  if (!rate) {
    return [{
      detail: `${values.CLAUDE_MODEL} has no price in ${path.join(agentDir, "models.json")}`,
      fix: "add it with input and output prices per million tokens, or pick a priced model; a model that cannot be priced cannot be budgeted",
    }];
  }
  ok(`priced at $${rate.input}/M in, $${rate.output}/M out`);
  if (perRoutine.length) {
    return [{
      detail: `routines name unpriced models: ${perRoutine.map((r) => `${r.key} → ${r.model}`).join(", ")}`,
      fix: `add them to ${path.join(agentDir, "models.json")} or change the routine's model`,
    }];
  }
  return [];
});
if (!claudeOk) unresolved.push("Claude");

// --- Discord -------------------------------------------------------------------

heading("Discord (this bot's own application)");
note("Developer Portal > New Application > Bot: copy the token. The Application ID");
note("is on General Information. One application per bot, so three clans on one");
note("server are three applications.");
let inspected = null;
const discordOk = await untilOk(async () => {
  values.DISCORD_APP_ID = await ask("Application ID", { fallback: values.DISCORD_APP_ID });
  values.DISCORD_BOT_TOKEN = await ask("Bot token", { fallback: values.DISCORD_BOT_TOKEN, secret: true });
  values.DISCORD_GUILD_ID = await ask("Server (guild) id", { fallback: values.DISCORD_GUILD_ID });
  if (!values.DISCORD_BOT_TOKEN || !values.DISCORD_GUILD_ID) {
    return [{ detail: "the bot token and the server id are both required" }];
  }
  inspected = await inspectDiscord({
    token: values.DISCORD_BOT_TOKEN,
    appId: values.DISCORD_APP_ID || null,
    guildId: values.DISCORD_GUILD_ID,
  });
  if (inspected.user) ok(`token is ${inspected.user.username}#${inspected.user.discriminator} (${inspected.user.id})`);
  if (inspected.application) {
    ok(`application ${inspected.application.name} (${inspected.application.id})`);
    if (!values.DISCORD_APP_ID) values.DISCORD_APP_ID = inspected.application.id;
  }
  if (inspected.guild) ok(`in server ${inspected.guild.name} · ${inspected.channels.length} text channels`);
  return inspected.problems.map((p) => ({ detail: p.detail, fix: p.fix }));
});
if (!discordOk) unresolved.push("Discord application");

// --- Channels ------------------------------------------------------------------

heading("Channels");
if (!inspected?.guild) {
  note("skipped: the bot is not in the server yet, so nothing can be checked.");
  if (values.DISCORD_APP_ID && values.DISCORD_GUILD_ID) note(`invite: ${inviteUrl(values.DISCORD_APP_ID, values.DISCORD_GUILD_ID)}`);
  unresolved.push("channels");
} else {
  const botRole = inspected.roles.find((role) => role.tags?.bot_id === inspected.user.id);
  const roleName = botRole ? `the "${botRole.name}" role` : "the bot's role";
  if (interactive) {
    note("text channels in this server:");
    inspected.channels.forEach((channel, index) => note(`  ${String(index + 1).padStart(2)}. #${channel.name}  (${channel.id})`));
  }
  for (const requirement of requirements) {
    const envName = channelEnvName(requirement.name);
    const channelOk = await untilOk(async () => {
      const answer = await ask(`Channel for \`${requirement.name}\` (number or id)`, { fallback: values[envName] });
      const raw =
        inspected.channels[Number(answer) - 1] ??
        inspected.channels.find((channel) => channel.id === answer);
      if (!raw) {
        return [{
          detail: answer ? `${answer} is not a text channel in ${inspected.guild.name}` : `${envName} is required`,
          fix: "pick a number from the list above, or paste the channel id (right-click the channel > Copy Channel ID)",
        }];
      }
      values[envName] = raw.id;
      const problem = inspectChannel({
        name: requirement.name,
        needs: requirement.needs,
        channel: channelLike(raw, permissionsIn(inspected, raw)),
        botId: inspected.user.id,
        guildId: values.DISCORD_GUILD_ID,
      });
      if (problem) {
        return [{
          detail: `#${raw.name}: ${problem.missing ? `missing ${problem.missing.join(", ")}` : problem.hint}`,
          fix: `#${raw.name} > Edit Channel > Permissions > add ${roleName} (or the bot itself) and allow: ${problem.missing?.join(", ") ?? "the permissions above"}`,
        }];
      }
      ok(`${requirement.name} → #${raw.name} · ${Object.keys(requirement.needs).join(", ")}`);
      return [];
    });
    if (!channelOk) unresolved.push(`channel ${requirement.name}`);
  }
}

// --- Settings ------------------------------------------------------------------

heading("Settings");
values.COMMAND_PREFIX = (await ask("Slash-command prefix (e.g. pk → /pk-run; blank for /run)", { fallback: values.COMMAND_PREFIX ?? "" }))
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "");
values.TIMEZONE = await ask("Timezone for schedules", { fallback: values.TIMEZONE || "UTC" });
try {
  new Intl.DateTimeFormat("en-US", { timeZone: values.TIMEZONE });
} catch {
  fail({ detail: `${values.TIMEZONE} is not an IANA timezone`, fix: "e.g. America/Chicago; falling back to UTC" });
  values.TIMEZONE = "UTC";
}
values.MONTHLY_BUDGET_USD = await ask("Monthly budget for schedules and events, USD", { fallback: values.MONTHLY_BUDGET_USD || "20.00" });
values.ASK_MONTHLY_BUDGET_USD = await ask("Monthly budget for member questions, USD", { fallback: values.ASK_MONTHLY_BUDGET_USD || "10.00" });
values.EVENT_POLL_SECONDS = await ask("Feed poll interval, seconds", { fallback: values.EVENT_POLL_SECONDS || "1800" });
values.ADMIN_USER_IDS = await ask("Discord user ids allowed to use the admin commands (comma-separated)", { fallback: values.ADMIN_USER_IDS || "" });
if (!values.ADMIN_USER_IDS) fail({ detail: "no admin user ids", fix: "without ADMIN_USER_IDS nobody can use /run, /budget or /routines" });

// --- Write ---------------------------------------------------------------------

if (!checkOnly) {
  fs.writeFileSync(envFile, renderEnv({ values, instanceDir }), { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  ok(`wrote ${envFile}`);
}

// --- Summary -------------------------------------------------------------------

heading("summary");
if (unresolved.length === 0) {
  ok("everything checked out");
  if (!checkOnly) {
    note(`next:  ./scripts/instance.sh ${instanceDir} probe`);
    note(`       ./scripts/install-launchd.sh ${instanceDir}`);
  }
} else {
  fail({ detail: `still unresolved: ${unresolved.join(", ")}`, fix: `run this again when fixed: npm run setup -- ${instanceDir}` });
  process.exit(1);
}
