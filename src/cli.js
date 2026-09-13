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
 *   npm run try clan-feed -- --post         actually post it to its channel
 *
 * A dry run costs a real model call and real tokens; it just does not touch
 * Discord. `--post` connects, posts, and exits.
 */

import { config, provenance } from "./config.js";
import { initialize, describePrincipal } from "./mcp.js";
import { loadRoutines } from "./routines.js";
import * as budget from "./budget.js";
import { rateFor, UnpricedModel } from "./pricing.js";
import { runRoutine } from "./run.js";
import { systemFor, userMessageFor } from "./prompt.js";
import { renderTrace } from "./trace.js";
import { read, noteworthy } from "./events.js";
import * as state from "./state.js";
import { lastOccurrence, periodKey } from "./schedule.js";

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const key = rest.find((arg) => !arg.startsWith("--"));

function budgetLines() {
  return budget.status().map((b) => {
    const of =
      b.budget === null ? "no budget set" : `of $${b.budget.toFixed(2)}`;
    return `  ${b.lane.padEnd(9)} $${b.spent.toFixed(2)} ${of}  (${b.state}, reserve $${b.reserve.toFixed(2)})`;
  });
}

function listRoutines() {
  warnAboutShadowedConfig();
  const { routines, errors } = loadRoutines();
  console.log(`agent dir: ${config.agentDir}   timezone: ${config.timezone}`);
  console.log(
    `model: ${config.claude.model} · effort ${config.claude.effort}\n`,
  );
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
          ? `feed: ${routine.sections?.join(",") ?? "all sections"}`
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
  for (const failure of errors)
    console.error(`✗ ${failure.key}: ${failure.error}`);
  if (errors.length) process.exitCode = 1;
}

/**
 * Feed entries for a dry run of an event routine.
 *
 * Its real cursor is never advanced here — a rehearsal must not consume the
 * feed. When the window since the cursor holds nothing noteworthy (or there
 * is no cursor yet) it reads the last 24 hours instead, because "nothing
 * happened, nothing to show" is a useless answer to somebody trying to
 * improve the wording of the brief.
 */
async function eventsForDryRun(routine) {
  const cursor = state.cursorFor(routine.key);
  const seeded = typeof cursor === "string";
  if (seeded) {
    const pending = await read(cursor, { sections: routine.sections });
    if (pending.ok && noteworthy(pending.entries, routine.sections))
      return { events: pending.entries, note: `pending since ${cursor}` };
  }
  const day = await read(null, { sections: routine.sections });
  if (!day.ok) return { events: [], note: `feed unreadable: ${day.error}` };
  const why = seeded ? "nothing new since the cursor" : "no cursor yet (seeds on the first live poll)";
  return {
    events: day.entries,
    note: noteworthy(day.entries, routine.sections)
      ? `${why} — showing the last 24 hours`
      : `${why}, and nothing noteworthy in the last 24 hours either — the live lane would not have fired`,
  };
}

/** Values coming from the shell rather than .env, which is the trap this
 *  project has already been caught by once: an exported CLAUDE_EFFORT quietly
 *  ran the bot at "high" for an evening and nobody could see why. */
function warnAboutShadowedConfig() {
  for (const entry of provenance) {
    if (entry.source.startsWith("SHELL") || entry.source === "shell") {
      console.error(
        `# ${entry.name}=${entry.value} (from your SHELL, not .env)`,
      );
    }
  }
}

async function tryRoutine() {
  warnAboutShadowedConfig();
  const { routines } = loadRoutines();
  const routine = routines.find((entry) => entry.key === key);
  if (!routine) {
    console.error(
      `No routine called "${key ?? ""}". Run \`npm run routines\` to see them.`,
    );
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
    console.error(
      `# WARNING: initialize failed (${handshake.error}) — prompt may lack its subject`,
    );
  }

  let events = null;
  if (routine.trigger === "events") {
    const found = await eventsForDryRun(routine);
    events = found.events;
    console.error(`# events: ${found.note} (${events.length})`);
  }

  if (flags.has("--show-prompt")) {
    console.log("=== SYSTEM ===\n");
    console.log(
      systemFor(routine, { includePrompt: routine.trigger === "message" }),
    );
    console.log("\n=== USER ===\n");
    console.log(userMessageFor(routine, { events }));
    console.log("\n=== ANSWER ===\n");
  }

  let channel = null;
  let client = null;
  if (flags.has("--post")) {
    const { Client, GatewayIntentBits } = await import("discord.js");
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(config.discord.token);
    const id = config.channels.get(routine.channel);
    channel = id ? await client.channels.fetch(id) : null;
    if (!channel) {
      console.error(
        `channel "${routine.channel}" is not bound or not reachable`,
      );
      process.exit(1);
    }
  }

  const started = Date.now();
  const run = await runRoutine(routine, { channel, events, dryRun: !channel });
  if (!run.ok) {
    console.error(`FAILED: ${run.error}`);
    process.exit(1);
  }

  console.log(run.skipped ? "(SKIP — nothing would be posted)\n" : "");
  console.log(run.text);
  console.log("\n---");
  console.log(
    renderTrace(run.result, { label: routine.key }) ?? "(no tool activity)",
  );
  console.log(
    `\n${routine.model} · effort ${routine.effort} · $${run.result.usd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${channel ? "POSTED" : "dry run, nothing posted"}`,
  );
  if (client) await client.destroy();
}

if (command === "list") listRoutines();
else if (command === "try") await tryRoutine();
else {
  console.error("usage: cli.js list | try <routine> [--post] [--show-prompt]");
  process.exit(1);
}
