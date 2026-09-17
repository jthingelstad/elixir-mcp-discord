/**
 * `npm run turns` — read the turn ledger (src/ledger.js) as transcripts.
 *
 * The ledger is for judging what the bot said, and a JSON line with a 16 KB
 * tool body in it is not something a reviewer reads. This renders each turn
 * the way a review wants it: who asked (or which brief ran), what the model
 * thought, every call with its arguments and what came back, the answer,
 * where it went, and what readers did about it afterwards.
 *
 *   npm run turns                                  the last 7 days, this instance
 *   npm run turns -- --since 2026-09-13 --lane ask
 *   npm run turns -- --routine editor --full   tool bodies uncut
 *   npm run turns -- --turn d98fe553                   one turn, in full
 *   npm run turns -- --json                            raw records, one per line
 *   npm run turns -- --export ./review                 one .md per turn + the prompts
 *   npm run turns -- --instance ~/.elixir-mcp-discord/shipit
 *
 * The instance is the cwd or INSTANCE_DIR, as everywhere else; `--instance`
 * overrides both. No .env is needed to read a ledger.
 */

import fs from "node:fs";
import path from "node:path";
import { readTurns, readReviews, PROMPTS_DIR } from "./ledger.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};

const day = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => day(new Date(Date.now() - n * 86400000));

const instance = value("instance") ? path.resolve(value("instance").replace(/^~/, process.env.HOME || "")) : null;
const dir = instance ? path.join(instance, "state", "turns") : undefined;
const promptsDir = instance ? path.join(instance, "state", "prompts") : PROMPTS_DIR;
const full = flag("full") || Boolean(value("turn"));
const BODY_PREVIEW = 300;

function clip(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function body(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === "object" && result.clipped)
    return `${result.head}… (clipped at ${result.head.length} of ${result.chars} chars)`;
  return String(result);
}

function quote(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function renderTurn(turn, { full = false } = {}) {
  const out = [];
  const when = turn.at.replace("T", " ").slice(0, 16) + "Z";
  const lane = turn.lane === "ask" ? "ask" : turn.trigger;
  out.push(`## ${when} · ${turn.routine} (${lane}) · turn \`${turn.turnId}\` · ${turn.instance}`);
  out.push("");

  const input = turn.input || {};
  if (input.kind === "message") {
    const where = input.threadId ? `thread ${input.threadId}` : `channel ${input.channelId}`;
    out.push(`**${input.asker?.name ?? "?"}** (discord:${input.asker?.id ?? "?"}) in ${where}`);
    if (input.history?.length) {
      out.push("");
      out.push(`<details><summary>history: ${input.history.length} turn(s)</summary>`);
      out.push("");
      for (const h of input.history) out.push(`- **${h.role}:** ${clip(h.content, full ? Infinity : 400)}`);
      out.push("");
      out.push("</details>");
    }
    out.push("");
    out.push(quote(input.question));
  } else {
    out.push(`**Brief** (${turn.routine}):`);
    out.push("");
    out.push(quote(input.brief));
    if (input.events) {
      const text = typeof input.events === "string" ? input.events : JSON.stringify(input.events, null, 1);
      out.push("");
      out.push(`<details><summary>timeline handed in (${text.length} chars)</summary>`);
      out.push("");
      out.push("```json");
      out.push(full ? text : clip(text, 2000));
      out.push("```");
      out.push("");
      out.push("</details>");
    }
    if (input.recent?.length) out.push(`\n_recall: ${input.recent.length} earlier post(s) shown to the model_`);
  }

  out.push("");
  out.push("### Trace");
  out.push("");
  if (!turn.trace?.length) out.push("_(no tool activity)_");
  for (const step of turn.trace || []) {
    if (step.kind === "thought") {
      out.push(`💭 ${clip(step.text.replace(/\s+/g, " "), full ? Infinity : 600)}`);
    } else if (step.kind === "tool") {
      const meta = [
        step.shape ? `→ ${step.shape}` : null,
        step.ms !== null && step.ms !== undefined ? `${(step.ms / 1000).toFixed(1)}s` : null,
        step.requestId ? `req ${String(step.requestId).slice(0, 8)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      out.push(`🔧 \`${step.name}\` \`${JSON.stringify(step.input ?? {})}\`${meta ? ` ${meta}` : ""}`);
      const b = body(step.result);
      if (b !== null) {
        out.push("```json");
        out.push(full ? b : clip(b, BODY_PREVIEW));
        out.push("```");
      }
    } else if (step.kind === "error") {
      out.push(
        `⚠️ \`${step.name}\` failed${step.code ? ` (${step.code})` : ""}: ${step.detail}${step.requestId ? ` · req ${String(step.requestId).slice(0, 8)}` : ""}`,
      );
    }
    out.push("");
  }

  out.push("### Answer");
  out.push("");
  const output = turn.output || {};
  if (output.error) out.push(`**FAILED:** ${output.error}`);
  if (output.skipped) out.push("_SKIP — nothing posted_");
  if (output.posts?.length) {
    for (const p of output.posts) {
      out.push(`**#${p.channelName}** (${p.messageIds?.length ?? 0} message(s))`);
      out.push("");
      out.push(p.text);
      out.push("");
    }
    if (output.text && output.text !== output.posts.map((p) => p.text).join("\n\n")) {
      out.push("_prose outside the posts, not posted:_");
      out.push("");
      out.push(output.text);
    }
  } else if (output.text && !output.skipped) {
    out.push(output.text);
  }
  const flags = [
    output.ungrounded ? "**UNGROUNDED**" : null,
    output.friction ? `friction: ${output.friction}` : null,
    turn.truncated ? "**TRUNCATED**" : null,
  ].filter(Boolean);
  if (flags.length) out.push(`\n_${flags.join(" · ")}_`);
  for (const f of output.footers || []) out.push(`\n${clip(f, full ? Infinity : 500)}`);

  if (
    turn.reactions?.length ||
    turn.filed?.length ||
    turn.findings?.length ||
    turn.interventions?.length ||
    turn.retractions?.length
  ) {
    out.push("");
    out.push("### Afterwards");
    out.push("");
    for (const r of turn.retractions || [])
      out.push(
        `- 🗑 RETRACTED by discord:${r.by}${r.at ? ` at ${r.at.slice(0, 16)}Z` : ""} (${r.deleted} message(s))${r.reason ? ` — "${r.reason}"` : ""}`,
      );
    for (const r of turn.reactions || [])
      out.push(
        `- ${r.reaction === "up" ? "👍" : "👎"} discord:${r.userId}${r.at ? ` at ${r.at.slice(0, 16)}Z` : ""}${r.note ? ` — "${r.note}"` : ""}`,
      );
    for (const i of turn.interventions || [])
      out.push(
        `- 🙋 ${i.by === "other_member" ? "another member stepped in" : "the asker pushed back"} (discord:${i.userId}): "${clip(i.text, full ? Infinity : 200)}"`,
      );
    for (const f of turn.findings || []) out.push(`- 🔎 ${f.class} (${f.source}): ${f.note}`);
    for (const f of turn.filed || []) out.push(`- 📮 filed: ${f.summary}`);
  }

  out.push("");
  const cache =
    turn.usage && turn.usage.input + turn.usage.cacheRead > 0
      ? `cache ${Math.round((turn.usage.cacheRead / (turn.usage.input + turn.usage.cacheRead + turn.usage.cacheWrite)) * 100)}%`
      : null;
  out.push(
    `_${[
      turn.model,
      `effort ${turn.effort}`,
      turn.usd !== null ? `$${Number(turn.usd).toFixed(4)}` : null,
      cache,
      turn.ms ? `${(turn.ms / 1000).toFixed(1)}s` : null,
      turn.rounds > 1 ? `${turn.rounds} rounds` : null,
      turn.nudged ? "nudged" : null,
      turn.stopReason,
      turn.serverVersion,
      turn.prompt?.system ? `prompt ${turn.prompt.system}` : null,
    ]
      .filter(Boolean)
      .join(" · ")}_`,
  );
  return out.join("\n");
}

function select() {
  const since = value("since") ?? (value("turn") ? null : daysAgo(7));
  const until = value("until");
  let turns = readTurns({ dir, since, until });
  if (value("lane")) turns = turns.filter((t) => t.lane === value("lane"));
  if (value("routine")) turns = turns.filter((t) => t.routine === value("routine"));
  if (value("turn")) turns = turns.filter((t) => t.turnId === value("turn") || t.turnId?.startsWith(value("turn")));
  return turns;
}

function renderReview(r) {
  const out = [
    `## Review ${r.reviewId} · ${r.at.slice(0, 16)}Z · ${r.trigger} · ${r.turnsRead} turns (${r.flagged ?? "?"} flagged) · $${Number(r.usd ?? 0).toFixed(2)}`,
    "",
    r.report || "_(no report)_",
    "",
  ];
  for (const p of r.proposals || []) {
    const d = (r.decisions || []).filter((x) => x.proposalId === p.id).at(-1);
    out.push(`- **${p.id}** \`${p.file}\` · ${p.rule} · ${d ? d.decision.toUpperCase() : "pending"} — ${p.summary}`);
    out.push("  ```diff");
    out.push(
      p.preview
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
    out.push("  ```");
  }
  for (const m of r.reports || []) out.push(`- 🛠 mechanics · ${m.rule} — ${m.summary}`);
  for (const f of r.filed || []) out.push(`- 📮 filed with Elixir — ${f}`);
  return out.join("\n");
}

function main() {
  if (flag("help")) {
    console.log(
      "usage: turns [--instance <dir>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--lane ask|routines] [--routine <key>] [--turn <id>] [--full] [--json] [--export <dir>] | --reviews",
    );
    return;
  }
  if (flag("reviews")) {
    const reviews = readReviews({ dir, since: value("since") ?? daysAgo(60), until: value("until") });
    if (reviews.length === 0) {
      console.error("no reviews in the window");
      process.exitCode = 1;
      return;
    }
    console.log(reviews.map(renderReview).join("\n\n---\n\n"));
    return;
  }
  const turns = select();
  if (turns.length === 0) {
    console.error(`no turns${value("since") ? ` since ${value("since")}` : ""} in ${dir ?? "this instance's ledger"}`);
    process.exitCode = 1;
    return;
  }

  if (flag("json")) {
    for (const t of turns) console.log(JSON.stringify(t));
    return;
  }

  const target = value("export");
  if (target) {
    fs.mkdirSync(target, { recursive: true });
    const prompts = new Set();
    for (const t of turns) {
      fs.writeFileSync(
        path.join(target, `${t.at.slice(0, 10)}-${t.routine}-${t.turnId}.md`),
        `${renderTurn(t, { full: true })}\n`,
      );
      if (t.prompt?.system) prompts.add(t.prompt.system);
    }
    const promptOut = path.join(target, "prompts");
    for (const hash of prompts) {
      const src = path.join(promptsDir, `${hash}.txt`);
      if (fs.existsSync(src)) {
        fs.mkdirSync(promptOut, { recursive: true });
        fs.copyFileSync(src, path.join(promptOut, `${hash}.txt`));
      }
    }
    console.error(`exported ${turns.length} turn(s) and ${prompts.size} prompt(s) to ${target}`);
    return;
  }

  console.log(turns.map((t) => renderTurn(t, { full })).join("\n\n---\n\n"));
  console.error(`\n${turns.length} turn(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
