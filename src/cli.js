/**
 * `npm run try <routine>` — run one routine right now and print what it would
 * post. This is the prompt REPL, and it is the most important tool in the repo.
 *
 * Before it existed, the only way to see what a 01:00 routine produced was to
 * be awake at 01:00, or to edit the schedule, restart, wait, and read the
 * channel. Nobody iterates on a prompt under those conditions, so prompts
 * stayed as they were first written and quality was whatever the first draft
 * happened to be.
 *
 *   npm run try war-deck-check              compose it, print it, post nothing
 *   npm run try meta-report -- --show-prompt   also print the assembled system prompt
 *   npm run try editor -- --post            actually post it to its channel
 *
 * A dry run costs a real model call and real tokens; it just does not touch
 * Discord. `--post` connects, posts, and exits.
 *
 *   npm run replay -- editor <ledger.jsonl>... [--model <id>] [--limit <n>] [--pause <s>]
 *
 * `replay` runs a routine again on batches it was really handed: each turn
 * record in the files, oldest first, with that turn's own recall and what
 * its room tool read, as a dry run. One JSON line per turn on stdout, the
 * original's decision beside the replay's. It is how a model is judged
 * against the record before it posts anything (Haiku 5.5, 2026-10-08). Run
 * it against a scratch instance directory: a dry run still counts its
 * spend, and the live bot's state file is not a second process's to write.
 * The prompt's clock is the past turn's, so old news is judged as it was
 * then; the Elixir tools still answer as of now. Every turn spends the
 * owner's hourly hub requests, shared with the live bots: `--pause` spaces
 * the turns so a long replay cannot starve them (it did on 2026-10-08).
 */

import { config, provenance } from "./config.js";
import { initialize, describePrincipal } from "./mcp.js";
import { loadRoutines } from "./routines.js";
import * as budget from "./budget.js";
import { rateFor, UnpricedModel } from "./pricing.js";
import { runRoutine, ROOM_TOOL } from "./run.js";
import { systemFor, userMessageFor } from "./prompt.js";
import { renderTrace } from "./trace.js";
import { skipReason } from "./skip.js";
import fs from "node:fs";
import { eventsForDryRun } from "./events.js";
import * as state from "./state.js";
import { lastOccurrence, periodKey } from "./schedule.js";

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const VALUED = new Set(["--model", "--limit", "--pause"]);
const valueOf = (flag) => {
  const at = rest.indexOf(flag);
  return at >= 0 ? rest[at + 1] : undefined;
};
const positional = rest.filter((arg, i) => !arg.startsWith("--") && !VALUED.has(rest[i - 1]));
const key = positional[0];

function budgetLines() {
  return budget.status().map((b) => {
    const of =
      b.budget === null
        ? "unlimited"
        : `of $${b.budget.toFixed(2)}${b.source === "default" ? " (default cap: not set)" : ""}`;
    return `  ${b.label.padEnd(13)} $${b.spent.toFixed(2)} ${of}  (${b.state}, reserve $${b.reserve.toFixed(2)})`;
  });
}

function listRoutines() {
  warnAboutShadowedConfig();
  const { routines, errors } = loadRoutines();
  console.log(`agent dir: ${config.agentDir}   timezone: ${config.timezone}`);
  console.log(`model: ${config.claude.model} · effort ${config.claude.effort}\n`);
  console.log(`budgets (${budget.monthKey()}):`);
  for (const line of budgetLines()) console.log(line);
  console.log("");
  const spend = state.todaySpendByRoutine();
  for (const routine of routines) {
    try {
      rateFor(routine.model);
    } catch (error) {
      if (error instanceof UnpricedModel) {
        console.error(`✗ ${routine.key}: ${error.message}`);
        process.exitCode = 1;
      } else throw error;
    }
    const when =
      routine.trigger === "schedule"
        ? `${periodKey(lastOccurrence(routine)).slice(11)} ${routine.days ? `days ${routine.days.join(",")}` : "daily"}`
        : routine.trigger === "events"
          ? `timeline: ${routine.kinds?.join(",") ?? routine.sections?.join(",") ?? "everything"}`
          : "on message";
    console.log(
      [
        routine.disabled ? "○" : "●",
        routine.key.padEnd(22),
        routine.trigger.padEnd(9),
        `#${routine.channel}`.padEnd(14),
        when,
        spend[routine.key] ? `· $${spend[routine.key].toFixed(4)} today` : "",
      ].join(" "),
    );
  }
  for (const failure of errors) console.error(`✗ ${failure.key}: ${failure.error}`);
  if (errors.length) process.exitCode = 1;
}

/** Values coming from the shell rather than .env, which is the trap this
 *  project has already been caught by once: an exported CLAUDE_EFFORT quietly
 *  ran the bot at "high" for an evening and nobody could see why. */
function warnAboutShadowedConfig() {
  for (const entry of provenance) {
    if (entry.source.startsWith("SHELL") || entry.source === "shell") {
      console.error(`# ${entry.name}=${entry.value} (from your SHELL, not .env)`);
    }
  }
}

/**
 * The channel directory, over REST, so a dry run exercises the model's
 * choice of channel exactly as the service would — and prints it.
 */
async function loadDirectory(routines, routine) {
  let entries = [];
  if (routine.trigger !== "message" && process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID) {
    try {
      const { inspectDiscord, permissionsIn } = await import("./discord-rest.js");
      const directory = await import("./directory.js");
      const inspected = await inspectDiscord({ token: config.discord.token, guildId: config.discord.guildId });
      if (inspected.guild) {
        const active = routines.filter((r) => !r.disabled);
        const bound = new Set(active.map((r) => r.channel && config.channels.get(r.channel)).filter(Boolean));
        const askIds = new Set(
          active
            .filter((r) => r.trigger === "message")
            .map((r) => config.channels.get(r.channel))
            .filter(Boolean),
        );
        entries = directory.fromRest(inspected, permissionsIn, { bound, askIds });
        directory.configure({ list: () => entries, resolve: null });
        console.error(
          `# directory: ${entries.map((e) => `#${e.name}${e.role === "ask" ? "(ask)" : ""}`).join(", ") || "EMPTY — the model gets no post tool"}`,
        );
      } else {
        console.error(`# directory: unavailable (${inspected.problems[0]?.detail ?? "not in the guild"})`);
      }
    } catch (error) {
      console.error(`# directory: unavailable (${error.message})`);
    }
  }

  return entries;
}

async function tryRoutine() {
  warnAboutShadowedConfig();
  const { routines } = loadRoutines();
  const routine = routines.find((entry) => entry.key === key);
  if (!routine) {
    console.error(`No routine called "${key ?? ""}". Run \`npm run routines\` to see them.`);
    process.exit(1);
  }

  // Refresh who we are connected as, so a dry run assembles the same prompt the
  // service would. It is one HTTP call and it costs nothing.
  const handshake = await initialize();
  if (handshake.ok && handshake.principal) {
    state.set({
      principal: handshake.principal,
      serverVersion: handshake.version,
    });
    console.error(`# connected as ${describePrincipal(handshake.principal)}`);
  } else if (!handshake.ok) {
    console.error(`# WARNING: initialize failed (${handshake.error}) — prompt may lack its subject`);
  }

  const entries = await loadDirectory(routines, routine);

  let events = null;
  if (routine.trigger === "events") {
    const found = await eventsForDryRun(routine);
    events = found.events;
    console.error(`# timeline: ${found.note} (${found.count} item(s))`);
  }

  if (flags.has("--show-prompt")) {
    console.log("=== SYSTEM ===\n");
    console.log(
      systemFor(routine, {
        includePrompt: routine.trigger === "message",
        entries,
        defaultChannelId: routine.channel ? (config.channels.get(routine.channel) ?? null) : null,
      }),
    );
    console.log("\n=== USER ===\n");
    console.log(
      userMessageFor(routine, {
        events,
        withTool: entries.length > 0,
      }),
    );
    console.log("\n=== ANSWER ===\n");
  }

  let channel = null;
  let client = null;
  const posting = flags.has("--post");
  if (posting) {
    const { Client, GatewayIntentBits } = await import("discord.js");
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(config.discord.token);
    const id = routine.channel ? config.channels.get(routine.channel) : null;
    channel = id ? await client.channels.fetch(id) : null;
    if (routine.channel && !channel) {
      console.error(`channel "${routine.channel}" is not bound or not reachable`);
      process.exit(1);
    }
    if (!channel && entries.length === 0) {
      console.error("nowhere to post: the routine binds no channel and the directory is empty");
      process.exit(1);
    }
  }

  const started = Date.now();
  const run = await runRoutine(routine, {
    channel,
    events,
    dryRun: !posting,
    entries,
    resolve: client ? (id) => client.channels.fetch(id).catch(() => null) : undefined,
  });
  if (!run.ok) {
    console.error(`FAILED: ${run.error}`);
    process.exit(1);
  }

  console.log(run.skipped ? "(SKIP — nothing would be posted)\n" : "");
  if (run.posts?.length) {
    for (const p of run.posts) console.log(`=== ${p.channel} ===\n${p.text}\n`);
    if (run.text && run.text !== run.posts.map((p) => p.text).join("\n\n"))
      console.log(`(prose outside the posts, not posted)\n${run.text}`);
  } else {
    console.log(run.text);
  }
  console.log("\n---");
  console.log(renderTrace(run.result, { label: routine.key }) ?? "(no tool activity)");
  console.log(
    `\n${routine.model} · effort ${routine.effort} · $${run.result.usd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${posting ? "POSTED" : "dry run, nothing posted"}`,
  );
  if (client) await client.destroy();
}

/** `npm run review` — read the window and print what the review WOULD
 *  propose, persisting nothing and DMing nobody. Costs a real review turn. */
async function reviewDry() {
  warnAboutShadowedConfig();
  const { runReview } = await import("./review.js");
  const outcome = await runReview({ trigger: "cli", dryRun: true });
  if (!outcome.ok) {
    console.error(`FAILED: ${outcome.error}`);
    process.exit(1);
  }
  if (outcome.empty) {
    console.log("(nothing in the ledger since the last review)");
    return;
  }
  console.log(`=== REPORT (${outcome.turns} turns, ${outcome.flagged} flagged) ===\n\n${outcome.report}\n`);
  for (const [i, p] of outcome.proposals.entries()) {
    console.log(
      `=== PROPOSAL ${i + 1}: ${p.file} · ${p.rule} ===\n${p.summary}\nturns ${p.turnIds.join(", ")}\n${p.preview}\n`,
    );
  }
  for (const r of outcome.reports)
    console.log(`=== MECHANICS: ${r.rule} ===\n${r.summary}\nturns ${r.turnIds.join(", ")}\n`);
  for (const f of outcome.filed) console.log(`=== FILED WITH ELIXIR ===\n${f}\n`);
  console.log(
    `---\n${config.review.model} · effort ${config.review.effort} · $${outcome.usd.toFixed(4)} · dry run, nothing written${outcome.truncated ? " · TRUNCATED" : ""}`,
  );
}

/** What a ledger turn or a replay decided, in the same shape. */
function decision({ posts, skipped, text }) {
  return {
    posted: posts.length > 0,
    posts: posts.map((p) => ({ channel: p.channel, text: p.text })),
    why: skipped ? skipReason(text) : null,
  };
}

/** The room as the past turn read it, or quiet when it never looked. */
function recordedRoom(turn) {
  const read = (turn.trace || []).find((t) => t.kind === "tool" && t.name === "recent_channel_messages");
  let body = { messages: [], note: "Quiet for two hours." };
  if (read?.result) {
    try {
      body = JSON.parse(read.result);
    } catch {
      body = { as_read_then: read.result };
    }
  }
  return { ...ROOM_TOOL, handler: async () => ({ ok: true, body }) };
}

async function replayRoutine() {
  warnAboutShadowedConfig();
  const files = positional.slice(1);
  const { routines } = loadRoutines();
  const found = routines.find((entry) => entry.key === key);
  if (!found || files.length === 0) {
    console.error("usage: cli.js replay <routine> <ledger.jsonl>... [--model <id>] [--limit <n>] [--pause <s>]");
    process.exit(1);
  }
  const routine = valueOf("--model") ? { ...found, model: valueOf("--model") } : found;
  rateFor(routine.model);
  const turns = files
    .flatMap((file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line))
    .filter((r) => r.kind === "turn" && r.routine === key && r.input?.events)
    .sort((a, b) => a.at.localeCompare(b.at));
  const limit = Number(valueOf("--limit")) || turns.length;
  const handshake = await initialize();
  if (handshake.ok && handshake.principal) state.set({ principal: handshake.principal });
  const entries = await loadDirectory(routines, routine);
  console.error(`# replaying ${Math.min(limit, turns.length)} of ${turns.length} ${key} turns on ${routine.model}`);

  const pauseMs = (Number(valueOf("--pause")) || 0) * 1000;
  for (const [index, turn] of turns.slice(-limit).entries()) {
    if (index > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const run = await runRoutine(routine, {
      events: turn.input.events,
      dryRun: true,
      entries,
      replay: { recent: turn.input.recent ?? [], room: recordedRoom(turn), now: new Date(turn.at) },
    });
    const posts = (turn.output?.posts || []).map((p) => ({ channel: `#${p.channelName}`, text: p.text }));
    const trace = run.result?.trace || [];
    console.log(
      JSON.stringify({
        turnId: turn.turnId,
        at: turn.at,
        kinds: (turn.input.events.timeline || []).map((i) => i.kind),
        original: {
          model: turn.model,
          usd: turn.usd,
          ...decision({ posts, skipped: turn.output?.skipped, text: turn.output?.text }),
        },
        replay: run.ok
          ? {
              model: routine.model,
              usd: run.result.usd,
              ...decision({ posts: run.posts || [], skipped: run.skipped, text: run.text }),
              searches: trace.filter((t) => t.kind === "search").map((t) => ({ query: t.query, found: t.found })),
              called: run.result.called,
            }
          : { model: routine.model, error: run.error },
      }),
    );
  }
}

if (command === "list") listRoutines();
else if (command === "try") await tryRoutine();
else if (command === "replay") await replayRoutine();
else if (command === "review") await reviewDry();
else {
  console.error(
    "usage: cli.js list | try <routine> [--post] [--show-prompt] | replay <routine> <ledger.jsonl>... [--model <id>] [--limit <n>] [--pause <s>] | review",
  );
  process.exit(1);
}
