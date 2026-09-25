/**
 * `npm run setup -- <instance-dir>` — stand up one bot, end to end, with every
 * credential tried against its service before it is written down, and every
 * choice about what the bot does made in the open.
 *
 *   npm run setup -- ~/.elixir-mcp-discord/shipit          guided, re-runnable
 *   npm run setup -- ~/.elixir-mcp-discord/shipit --check  no prompts: validate
 *                                                          what is there
 *
 * One bot is three API credentials, a Discord application, a handful of
 * routines with a schedule, two channels, a voice and a budget. Each piece
 * fails in its own unhelpful way at its own later moment: a wrong Elixir key
 * is "http 401" at 01:00, a personal key answers as a person, a Claude key
 * for the wrong workspace is a 401 on a member's first question, an
 * application without the Message Content intent dies at login with "Used
 * disallowed intents", a bot never invited is "channel unresolvable", a
 * channel the role cannot see is a routine that spends a model call and
 * posts nothing, and a schedule written for another timezone posts at 4am.
 * Doing all of it for three clans is where a pasted id lands one channel
 * off. So this asks for each thing, tries it, explains what is wrong with the
 * fix beside it, waits while you make the change, and writes the instance
 * only when it has seen every piece work.
 *
 * Re-running keeps every value on Enter, so it is also how you rotate one key,
 * move one channel, add a routine or change a time. It never overwrites or
 * deletes a routine file the instance already has: those are the operator's.
 *
 * It deliberately does not import src/config.js's validated sections: those
 * read the CURRENT working directory, and setup is about a directory that may
 * not have a .env yet.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { initialize, describePrincipal } from "./mcp.js";
import { loadRoutines } from "./routines.js";
import { priceBook } from "./pricing.js";
import { requirementsFor, inspectChannel } from "./permissions.js";
import { inspectDiscord, permissionsIn, channelLike, inviteUrl, memberOf } from "./discord-rest.js";
import { fromRest } from "./directory.js";
import { channelEnvName } from "./config.js";
import { renderSecrets, renderConfig, parseConfig } from "./env-file.js";
import { catalog, installRoutines, disabledAfter, rewriteAt, estimateMonthly, describeWhen } from "./setup-catalog.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = path.join(repoRoot, "agent");

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
const money = (n) => `$${Number(n).toFixed(2)}`;

// --- prompts -----------------------------------------------------------------

/**
 * A secret, typed or pasted, echoed as one • per character and closed with
 * the count — so a paste that landed is visibly different from one that did
 * not, and a token cut short by a clipboard is visibly short. Raw mode, by
 * hand: readline's muted-output trick shows nothing at all, which reads as
 * "nothing happened" when a 90-character key just arrived.
 */
function readSecret(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      if (chunk.startsWith("\u001b")) return; // arrow keys and the like
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          process.stdout.write(value ? ` (${value.length} chars)\n` : "\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          done();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        process.stdout.write("•");
      }
    };
    stdin.on("data", onData);
  });
}

async function ask(question, { fallback = "", secret = false } = {}) {
  if (!interactive) return fallback;
  const hint = secret ? (fallback ? " [Enter keeps the current one]" : "") : fallback ? ` [${fallback}]` : "";
  const prompt = `${question}${hint}: `;
  if (secret) {
    const typed = (await readSecret(prompt)).trim();
    return typed || fallback;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let answer;
  try {
    answer = (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
  return answer || fallback;
}

/** Ask until `validate` returns null (ok) or a problem string; a bad answer
 *  is a retry with the reason, never a silent default. */
async function askValid(question, { fallback = "", validate }) {
  for (;;) {
    const answer = await ask(question, { fallback });
    const problem = validate(answer);
    if (!problem) return answer;
    fail({ detail: problem });
    if (!interactive) return fallback;
  }
}

const isTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const numberIn = (label, min) => (value) =>
  Number.isFinite(Number(value)) && Number(value) >= min
    ? null
    : `${label} must be a number${min ? ` ≥ ${min}` : ""}, got "${value}"`;

async function yesNo(question, fallback = false) {
  const answer = (await ask(question, { fallback: fallback ? "y" : "n" })).toLowerCase();
  return answer.startsWith("y");
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

/** A checklist: numbers toggle, `all` / `none`, Enter accepts. */
async function chooseMany(items, chosen) {
  for (;;) {
    items.forEach((item, index) => {
      const mark = chosen.has(item.key) ? "x" : " ";
      note(`[${mark}] ${String(index + 1).padStart(2)}. ${item.label}`);
      if (item.detail) note(`         ${item.detail}`);
    });
    const answer = await ask("Toggle by number (e.g. 3 5), 'all', 'none', or Enter to accept");
    if (!answer) return chosen;
    if (answer === "all") items.forEach((item) => chosen.add(item.key));
    else if (answer === "none") chosen.clear();
    else {
      for (const token of answer.split(/[\s,]+/).filter(Boolean)) {
        const item = items[Number(token) - 1];
        if (!item) {
          fail({ detail: `${token} is not on the list` });
          continue;
        }
        if (chosen.has(item.key)) chosen.delete(item.key);
        else chosen.add(item.key);
      }
    }
    console.log();
  }
}

// --- 1. the instance directory -------------------------------------------------

heading(`instance ${instanceDir}`);
if (checkOnly && !fs.existsSync(agentDir)) {
  fail({ detail: `${instanceDir} is not an instance (no agent/)`, fix: `npm run setup -- ${instanceDir}` });
  process.exit(1);
}
if (!checkOnly) {
  fs.mkdirSync(path.join(instanceDir, "state"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "routines"), { recursive: true });
  // memory.md too: the review lane writes it, and the example's header tells
  // the model (and the operator) what the file is for. Missing is legal.
  for (const file of ["identity.md", "models.json", "memory.md"]) {
    if (!fs.existsSync(path.join(agentDir, file)))
      fs.copyFileSync(path.join(exampleDir, file), path.join(agentDir, file));
  }
}
for (const file of ["identity.md", "models.json"]) {
  if (!fs.existsSync(path.join(agentDir, file)))
    fail({ detail: `${agentDir} has no ${file}`, fix: `cp ${path.join(exampleDir, file)} ${agentDir}/` });
}
ok(`agent directory ${agentDir}`);

const configFile = path.join(instanceDir, "config.json");
const env = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile, "utf8")) : {};
const cfg = fs.existsSync(configFile) ? (parseConfig(fs.readFileSync(configFile, "utf8")) ?? {}) : {};
// .env holds the secrets, config.json everything else; a pre-config.json
// .env still loads (the bot migrates it on its first boot, and so does the
// write below: setup always writes the two files in their new shape).
note(
  fs.existsSync(envFile) || fs.existsSync(configFile)
    ? `existing .env and config.json loaded; Enter keeps each current value`
    : `no .env or config.json yet; both will be written at the end`,
);

const values = { ...env, ...cfg };
const unresolved = [];

/** Written after EVERY section, not just at the end: a cancelled run — or a
 *  wrong answer that made someone quit — keeps everything entered so far,
 *  and the next run offers it back on Enter. */
function save(section) {
  if (checkOnly) return;
  fs.writeFileSync(envFile, renderSecrets({ values, instanceDir }), { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  fs.writeFileSync(configFile, renderConfig(values));
  if (section) note(`saved ${section}`);
}

// --- 2. Elixir MCP ----------------------------------------------------------------

heading("Elixir MCP (the agent's door)");
note("Create the agent at https://elixir.poapkings.com > Account > Agents. The URL");
note("and key are shown together, once; the key is stored only as a hash.");
let clanName = null;
const elixirOk = await untilOk(async () => {
  values.ELIXIR_MCP_URL = await ask("Agent URL", { fallback: values.ELIXIR_MCP_URL });
  values.ELIXIR_MCP_TOKEN = await ask("Agent key", { fallback: values.ELIXIR_MCP_TOKEN, secret: true });
  if (!values.ELIXIR_MCP_URL || !values.ELIXIR_MCP_TOKEN) {
    return [{ detail: "the Elixir MCP URL and key are both required" }];
  }
  if (!/\/a\/[0-9a-f]+\/mcp$/i.test(values.ELIXIR_MCP_URL)) {
    return [
      {
        detail: `${values.ELIXIR_MCP_URL} is not an agent door`,
        fix: "an agent's URL ends in /a/<id>/mcp; the personal /mcp would answer as you, not the clan",
      },
    ];
  }
  const handshake = await initialize({ url: values.ELIXIR_MCP_URL, token: values.ELIXIR_MCP_TOKEN });
  if (!handshake.ok) {
    return [
      {
        detail: `initialize failed: ${handshake.error}`,
        fix: handshake.error.includes("401")
          ? "the key was refused at this door; check the key matches this agent's URL, or revoke and mint a new one"
          : "check the URL, then that the host is reachable from here",
      },
    ];
  }
  const principal = handshake.principal;
  ok(`connected · ${handshake.version} · ${describePrincipal(principal)}`);
  if (principal && principal.kind !== "agent") {
    return [
      {
        detail: `this is a ${principal.kind} key, not an agent`,
        fix: "the bot must be its own principal; create an agent and use its key",
      },
    ];
  }
  if (principal?.kind === "agent" && !principal.subject) {
    return [{ detail: "this agent has no clan", fix: "an agent acts for a clan; set one on the agent in Elixir" }];
  }
  clanName = principal?.subject?.name ?? null;
  return [];
});
if (!elixirOk) unresolved.push("Elixir MCP");
save("Elixir");

// --- 3. Claude --------------------------------------------------------------------

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
      return [
        {
          detail: "Claude rejected the key",
          fix: "console.anthropic.com > API keys; paste the whole key including the sk-ant- prefix",
        },
      ];
    }
    if (error instanceof Anthropic.NotFoundError) {
      return [
        {
          detail: `no model called ${values.CLAUDE_MODEL}`,
          fix: "use an id from https://docs.anthropic.com/en/docs/about-claude/models",
        },
      ];
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return [
        {
          detail: `this key may not use ${values.CLAUDE_MODEL}`,
          fix: "the workspace this key belongs to is not allowed that model; pick another or change the workspace's model access",
        },
      ];
    }
    return [
      { detail: `Claude API: ${error.message}`, fix: "retry; if it persists, check the key's workspace is active" },
    ];
  }
  // Priced, or the budgets are decoration — the same rule as boot.
  const rate = priceBook({ dir: agentDir, reload: true })[values.CLAUDE_MODEL];
  if (!rate) {
    return [
      {
        detail: `${values.CLAUDE_MODEL} has no price in ${path.join(agentDir, "models.json")}`,
        fix: "add it with input and output prices per million tokens, or pick a priced model; a model that cannot be priced cannot be budgeted",
      },
    ];
  }
  ok(`priced at $${rate.input}/M in, $${rate.output}/M out`);
  return [];
});
if (!claudeOk) unresolved.push("Claude");
save("Claude");

// --- 4. Discord -------------------------------------------------------------------

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
  if (inspected.user) ok(`token is ${inspected.user.username} (${inspected.user.id})`);
  if (inspected.application) {
    ok(`application ${inspected.application.name} (${inspected.application.id})`);
    if (!values.DISCORD_APP_ID) values.DISCORD_APP_ID = inspected.application.id;
  }
  if (inspected.guild) ok(`in server ${inspected.guild.name} · ${inspected.channels.length} text channels`);
  return inspected.problems.map((p) => ({ detail: p.detail, fix: p.fix }));
});
if (!discordOk) unresolved.push("Discord application");
save("Discord");

// --- 5. Routines ------------------------------------------------------------------

heading("Routines (what this bot does)");
const entries = catalog({ exampleDir, instanceDir: agentDir });
for (const entry of entries.filter((e) => e.error)) fail({ detail: `${entry.key}: ${entry.error}` });
const usable = entries.filter((e) => e.routine);
const previouslyDisabled = new Set(
  (values.ROUTINES_DISABLED || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
);
// WHAT THE BOT DOES IS DECIDED IN THE DM, NOT HERE. Choosing routines needs
// the channel directory, the clan's name and its evenings, all of which the
// bot only has once it is connected; and the person choosing is on a phone,
// not at this terminal. So setup wires the connection and leaves the
// instance with whatever routines it already has — none, on a fresh one —
// and the bot's first DM to the admins is the introduction. The picker is
// still here for anyone who prefers the terminal.
const chosen = new Set(usable.filter((e) => e.installed && !previouslyDisabled.has(e.key)).map((e) => e.key));
const pickHere =
  interactive &&
  (await yesNo(`Pick routines here now? (No: the bot introduces itself by DM and you choose there)`, false));
if (pickHere) {
  note("Each routine is one file in agent/routines; pick the ones this clan wants.");
  note("A file already in the instance is never overwritten — rewrite it freely.");
  console.log();
  for (const e of usable) if (!e.installed) chosen.add(e.key);
  await chooseMany(
    usable.map((e) => ({
      key: e.key,
      label: `${e.key}${e.custom ? " (yours)" : ""} — ${e.routine.trigger} → ${e.routine.channel} · ${describeWhen(e.routine)}`,
      detail: e.routine.description,
    })),
    chosen,
  );
}
const installedKeys = usable.filter((e) => e.installed).map((e) => e.key);
if (!checkOnly) {
  const shipped = [...chosen].filter((key) => usable.find((e) => e.key === key && !e.custom));
  const { copied, kept } = installRoutines({ exampleDir, instanceDir: agentDir, keys: shipped });
  if (copied.length) ok(`added ${copied.join(", ")}`);
  if (kept.length) ok(`kept your copies of ${kept.join(", ")}`);
  const disabled = disabledAfter({ previous: values.ROUTINES_DISABLED, installedKeys, chosenKeys: [...chosen] });
  if (disabled) {
    values.ROUTINES_DISABLED = disabled;
    note(`off (still available to /run): ${disabled}`);
  } else {
    delete values.ROUTINES_DISABLED;
  }
}
if (chosen.size === 0) note("no routines yet — the bot will DM the admins to set them up once it is running");
save("routines");

// --- 6. Schedule ------------------------------------------------------------------

heading("Schedule");
note("An IANA zone such as America/Chicago, Europe/London, Asia/Kolkata — not an");
note("abbreviation like CST. DST is handled from the zone.");
values.TIMEZONE = await askValid("Timezone the times below are written in", {
  fallback: values.TIMEZONE || "UTC",
  validate: (tz) =>
    isTimezone(tz) ? null : `"${tz}" is not an IANA timezone; try the form Region/City, e.g. America/Chicago`,
});
save("timezone");
const active = loadRoutines({ dir: agentDir }).routines.filter((r) => chosen.has(r.key));
for (const routine of active.filter((r) => r.trigger === "schedule")) {
  const current = describeWhen(routine).split(" at ")[1];
  const answer = await ask(`${routine.key} · ${describeWhen(routine)} ${values.TIMEZONE} · run at`, {
    fallback: current,
  });
  if (answer === current) continue;
  const file = path.join(agentDir, "routines", `${routine.key}.md`);
  try {
    fs.writeFileSync(file, rewriteAt(fs.readFileSync(file, "utf8"), answer));
    ok(`${routine.key} now runs at ${answer}`);
  } catch (error) {
    fail({ detail: `${routine.key}: ${error.message}`, fix: "HH:MM, 24-hour; left as it was" });
  }
}
const routines = loadRoutines({ dir: agentDir }).routines.filter((r) => chosen.has(r.key));
ok(`${routines.length} routines active`);
note("later, from the DM: reschedule, edit, add or remove any of them — no restart.");

// --- 7. Channels ------------------------------------------------------------------

heading("Channels");
const requirements = requirementsFor(routines, { feedbackChannel: values.FEEDBACK_CHANNEL || null });
// The ask channel is the one binding that stays explicit, whether or not a
// message routine exists yet: it is where members will speak, and the DM
// introduction offers the ask routine first.
if (!requirements.some((r) => r.name === "ask"))
  requirements.unshift(
    requirementsFor([{ trigger: "message", channel: "ask", disabled: false }], { feedbackChannel: null })[0],
  );
if (!inspected?.guild) {
  note("skipped: the bot is not in the server yet, so nothing can be checked.");
  if (values.DISCORD_APP_ID && values.DISCORD_GUILD_ID)
    note(`invite: ${inviteUrl(values.DISCORD_APP_ID, values.DISCORD_GUILD_ID)}`);
  unresolved.push("channels");
} else {
  const botRole = inspected.roles.find((role) => role.tags?.bot_id === inspected.user.id);
  const roleName = botRole ? `the "${botRole.name}" role` : "the bot's role";
  // WHERE THE BOT MAY POST is decided in Discord, not here: every channel
  // where its role (or the bot itself) is explicitly granted Send Messages.
  // The model reads that directory — names and topics — and chooses. Setup
  // shows it, insists on at least one, and waits while the operator grants.
  note("The bot posts wherever its role is EXPLICITLY granted Send Messages — a");
  note("permission it merely inherits from @everyone does not count. The model reads");
  note("those channels' names and topics and chooses among them; a topic on each");
  note("channel is what makes the choice good. Widen or narrow it in Discord.");
  const directoryOk = await untilOk(async () => {
    inspected = await inspectDiscord({
      token: values.DISCORD_BOT_TOKEN,
      appId: values.DISCORD_APP_ID || null,
      guildId: values.DISCORD_GUILD_ID,
    });
    const entries = fromRest(inspected, permissionsIn);
    if (entries.length === 0) {
      return [
        {
          detail: "the bot is not explicitly allowed to post anywhere yet",
          fix: `in each channel it should post in: Edit Channel > Permissions > add ${roleName} > allow View Channel and Send Messages`,
        },
      ];
    }
    for (const entry of entries) {
      const who =
        entry.visibility === "everyone"
          ? "everyone"
          : entry.visibleTo?.length
            ? `visible to ${entry.visibleTo.join(", ")}`
            : "restricted";
      ok(
        `may post in #${entry.name} (${who})${entry.topic ? ` — ${entry.topic.slice(0, 60)}` : "  — no topic; a one-line topic helps the model choose"}`,
      );
    }
    return [];
  });
  if (!directoryOk) unresolved.push("channels");

  // The channels a routine binds — today just the ask channel — are chosen
  // from the DIRECTORY, not the whole server: the bot is already granted
  // there, and one of them is usually named for it. That one is the default.
  const granted = inspected ? fromRest(inspected, permissionsIn) : [];
  for (const requirement of requirements) {
    const envName = channelEnvName(requirement.name);
    const needsThreads = "CreatePublicThreads" in requirement.needs;
    const candidates = granted.filter((e) => !needsThreads || e.threads);
    const guess =
      candidates.find((e) => e.name.includes(requirement.name)) ?? (candidates.length === 1 ? candidates[0] : null);
    const current = inspected.channels.find((c) => c.id === values[envName]);
    const fallbackName = current ? `#${current.name}` : guess ? `#${guess.name}` : "";
    if (interactive) {
      note(`channels the bot is granted in${needsThreads ? " with thread permissions" : ""}:`);
      candidates.forEach((e, index) =>
        note(`  ${String(index + 1).padStart(2)}. #${e.name}  (${e.id})${e.topic ? ` — ${e.topic.slice(0, 50)}` : ""}`),
      );
      if (candidates.length === 0)
        note("  (none yet — grant the bot's role in the channel, then answer with its id or #name)");
    }
    const what = requirement.name === "ask" ? "where members ask the bot questions" : `for \`${requirement.name}\``;
    const channelOk = await untilOk(async () => {
      const answer = await ask(`Channel ${what} (number, #name or id)`, { fallback: fallbackName });
      const wanted = answer.replace(/^#/, "");
      const raw =
        (candidates[Number(answer) - 1] &&
          inspected.channels.find((c) => c.id === candidates[Number(answer) - 1].id)) ||
        inspected.channels.find((c) => c.id === wanted) ||
        inspected.channels.find((c) => c.name === wanted);
      if (!raw) {
        return [
          {
            detail: answer ? `${answer} is not a text channel in ${inspected.guild.name}` : `${envName} is required`,
            fix: "a number from the list, the channel's #name, or its id (right-click the channel > Copy Channel ID)",
          },
        ];
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
        return [
          {
            detail: `#${raw.name}: ${problem.missing ? `missing ${problem.missing.join(", ")}` : problem.hint}`,
            fix: `#${raw.name} > Edit Channel > Permissions > add ${roleName} (or the bot itself) and allow: ${problem.missing?.join(", ") ?? "the permissions above"}`,
          },
        ];
      }
      ok(`${requirement.name} → #${raw.name} · ${Object.keys(requirement.needs).join(", ")}`);
      return [];
    });
    if (!channelOk) unresolved.push(`channel ${requirement.name}`);
  }
}
save("channels");

// --- 8. Identity ------------------------------------------------------------------

heading("Identity (how this bot speaks)");
const identityFile = path.join(agentDir, "identity.md");
const identity = fs.readFileSync(identityFile, "utf8");
if (identity.includes("## About this clan")) {
  ok(`${identityFile} already has its clan section; edit the file directly, or tell the bot by DM`);
} else {
  note(`${identityFile} is prepended to every prompt: voice, boundaries, what it is for.`);
  note("Tell the bot about this clan in the DM once it is running — what you call");
  note("things, what it should keep in mind — and it proposes the lines to keep.");
}

// --- 9. Money, polling, admins ----------------------------------------------------

heading("Budgets");
const estimate = estimateMonthly(routines);
if (routines.length) {
  for (const line of estimate.lines)
    note(`${line.key.padEnd(22)} ~${String(line.runs).padStart(3)} posts/month  ~${money(line.usd)}`);
  note(`≈ ${money(estimate.usd)}/month at ~${money(estimate.perPostUsd)} a post — a starting point, not a forecast.`);
} else {
  note("No routines yet, so no estimate: a scheduled post is roughly $0.10, and the");
  note("bot says what a set would cost when you choose it in the DM.");
}
note("Budgets are strict: a lane stops BEFORE a turn that could cross the line.");
const suggested = routines.length ? Math.max(5, Math.ceil(estimate.usd * 2)).toFixed(2) : "20.00";
values.MONTHLY_BUDGET_USD = await askValid("Monthly budget for schedules and events, USD", {
  fallback: values.MONTHLY_BUDGET_USD || suggested,
  validate: numberIn("a budget", 0),
});
values.ASK_MONTHLY_BUDGET_USD = await askValid("Monthly budget for member questions, USD", {
  fallback: values.ASK_MONTHLY_BUDGET_USD || "10.00",
  validate: numberIn("a budget", 0),
});
// The third pot pays for your DMs to the bot and, if you turn it on, the
// weekly review. Unasked, it was unset — unlimited — on every install.
values.REVIEW_MONTHLY_BUDGET_USD = await askValid("Monthly budget for your DMs with the bot and its reviews, USD", {
  fallback: values.REVIEW_MONTHLY_BUDGET_USD || "10.00",
  validate: numberIn("a budget", 0),
});
save("budgets");

heading("Polling and commands");
note("Every feed poll is a metered call; 1800 s is the hub's own advice, 300 s posts");
note("joins within minutes.");
values.EVENT_POLL_SECONDS = await askValid("Feed poll interval, seconds", {
  fallback: values.EVENT_POLL_SECONDS || "1800",
  validate: numberIn("the interval", 60),
});
values.COMMAND_PREFIX = (
  await ask("Slash-command prefix (→ /<prefix>-run; 'none' for plain /run)", {
    fallback: values.COMMAND_PREFIX || path.basename(instanceDir),
  })
)
  .replace(/^none$/i, "")
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "");
save("polling and commands");

heading("Admins (who may use /run, /budget, /routines)");
note("Discord user ids: Settings > Advanced > Developer Mode, then right-click a");
note("name > Copy User ID. Every command spends money, so this is an allow-list.");
const adminsOk = await untilOk(async () => {
  values.ADMIN_USER_IDS = await ask("Admin user ids (comma-separated)", { fallback: values.ADMIN_USER_IDS || "" });
  const ids = values.ADMIN_USER_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0)
    return [{ detail: "no admin user ids", fix: "without ADMIN_USER_IDS nobody can use the commands" }];
  if (!inspected?.guild) {
    note("cannot check them against the server until the bot is in it");
    return [];
  }
  const problems = [];
  for (const id of ids) {
    const member = await memberOf({ token: values.DISCORD_BOT_TOKEN, guildId: values.DISCORD_GUILD_ID, userId: id });
    if (member) ok(`${id} is ${member.user.username}${member.nick ? ` (${member.nick})` : ""}`);
    else
      problems.push({
        detail: `${id} is not a member of ${inspected.guild.name}`,
        fix: "copy the USER id, not a channel or role id",
      });
  }
  return problems;
});
if (!adminsOk) unresolved.push("admins");
save("admins");

// --- 10. Write ----------------------------------------------------------------------

heading("write");
if (checkOnly) {
  note("--check: nothing written");
} else {
  save();
  ok(`wrote ${envFile} (secrets) and ${configFile} (settings)`);
  // The instance as a repository: config.json and agent/ committed, .env and
  // state/ ignored, every accepted change from the DM a commit. Local only;
  // nothing here sets a remote.
  const { isRepo, initInstanceRepo } = await import("./instance-git.js");
  if (isRepo(instanceDir)) {
    ok("instance is a git repository; accepted changes are committed");
  } else if (
    !interactive ||
    (await yesNo("Track this instance's config and prompts in a local git repository? (never pushed)", true))
  ) {
    try {
      const repo = await initInstanceRepo({ dir: instanceDir });
      ok(`git repository in ${instanceDir}: ${repo.tracked} files at ${repo.sha}; .env and state/ ignored`);
    } catch (error) {
      fail({ detail: `git: ${error.message}`, fix: "install git, or skip; the bot works without it" });
    }
  }
}

// --- 11. Summary ------------------------------------------------------------------

heading(`summary${clanName ? ` — ${clanName}` : ""}`);
const channelName = (logical) => {
  const id = values[channelEnvName(logical)];
  const raw = inspected?.channels.find((c) => c.id === id);
  return raw ? `#${raw.name}` : id ? `#${id}` : "(unbound)";
};
for (const routine of routines) {
  const where =
    routine.trigger === "message"
      ? `listens in ${channelName(routine.channel)}`
      : routine.channel
        ? `→ ${channelName(routine.channel)}`
        : "→ model's choice";
  note(`${routine.key.padEnd(22)} ${describeWhen(routine).padEnd(34)} ${where}`);
}
if (values.ROUTINES_DISABLED) note(`off: ${values.ROUTINES_DISABLED}`);
if (routines.length === 0) note("routines: none yet — chosen in the DM");
note(
  `commands: /${values.COMMAND_PREFIX ? `${values.COMMAND_PREFIX}-` : ""}run, -budget, -routines · admins: ${values.ADMIN_USER_IDS}`,
);
note(
  `budgets: ${money(values.MONTHLY_BUDGET_USD)} routines + ${money(values.ASK_MONTHLY_BUDGET_USD)} ask per month · schedule in ${values.TIMEZONE}`,
);

if (unresolved.length > 0) {
  fail({
    detail: `still unresolved: ${unresolved.join(", ")}`,
    fix: `run this again when fixed: npm run setup -- ${instanceDir}`,
  });
  process.exit(1);
}
ok("everything checked out");

// --- 12. Run it -------------------------------------------------------------------

if (interactive) {
  heading("run it");
  const installer =
    os.platform() === "darwin" ? "install-launchd.sh" : os.platform() === "linux" ? "install-systemd.sh" : null;
  if (!installer) {
    note(`start it with: INSTANCE_DIR=${instanceDir} npm start`);
  } else if (await yesNo(`Install and start it now as a service (${installer})?`, true)) {
    const label = `com.poapkings.elixir-mcp-discord.${path.basename(instanceDir)}`;
    const logFile = path.join(os.homedir(), "Library", "Logs", "elixir-mcp-discord", `${label}.log`);
    const before = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    const run = spawnSync("bash", [path.join(repoRoot, "scripts", installer), instanceDir], { stdio: "inherit" });
    if (run.status !== 0) {
      fail({ detail: `${installer} exited ${run.status}` });
    } else if (os.platform() === "darwin") {
      note("waiting for the boot log…");
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(before) : "";
      const lines = text
        .split("\n")
        .filter((line) =>
          /\b(instance|mcp_connected|not_an_agent|channel_ok|channel_unusable|channels_ok|channels_unusable|commands_registered|scheduler_started|ERROR)\b/.test(
            line,
          ),
        );
      if (lines.length === 0) note(`nothing in ${logFile} yet — tail it`);
      for (const line of lines) note(line.length > 200 ? `${line.slice(0, 200)}…` : line);
      note(`log: ${logFile}`);
    } else {
      note(`journalctl --user -u elixir-mcp-discord-${path.basename(instanceDir)} -f`);
    }
  } else {
    note(`later: ./scripts/${installer} ${instanceDir}`);
  }
} else if (!checkOnly) {
  note(`next: ./scripts/install-launchd.sh ${instanceDir}`);
}
if (!checkOnly && unresolved.length === 0) {
  note("next: DM the bot from an admin account. It introduces itself, offers the");
  note("routines it can run, and proposes each with an Apply button; tell it about");
  note("the clan the same way. Everything it proposes is a file under agent/.");
  note(`from the terminal any time: INSTANCE_DIR=${instanceDir} npm run try <routine>`);
}
