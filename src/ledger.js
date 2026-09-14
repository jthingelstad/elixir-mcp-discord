/**
 * The turn ledger: what every turn was handed, what it did, and what it said,
 * one JSON line each, appended to
 *
 *     <instance>/state/turns/YYYY-MM-DD.jsonl
 *
 * This exists so the QUALITY of what the bot says can be judged after the
 * fact. Before it, the only complete record of an answer was the Discord
 * thread itself — the log line carried tool names and a price, state.json kept
 * the last 200 turns with the answer clipped at 1200 characters, and the
 * structured trace (every thought, every call with its arguments and result)
 * was rendered into a footer and thrown away. To ask "was that number right?"
 * you needed the tool's result body, and nothing kept it.
 *
 * Three record kinds, all keyed by turnId, all append-only:
 *
 *   turn      the full turn — inputs (question and thread history, or the
 *             brief and the timeline it was handed), the system prompt's hash,
 *             the trace with each tool call's arguments AND result body,
 *             the answer and where it went, cost and usage
 *   reaction  a reader's 👍 / 👎 on any message the turn produced, with the
 *             reply they left if any
 *   filed     what the friction sweep filed with the maintainer for the turn
 *
 * Later signals are their own lines rather than edits to the turn line, so a
 * file is only ever appended to and a reader joins on turnId.
 *
 * The system prompt is not stored per turn — it is 10 KB and identical for
 * hundreds of turns — but its sha is, and the first time a sha is seen the
 * text is written once to state/prompts/<sha>.txt. Instance prompts live
 * outside any git checkout, so this is the only record of which wording
 * produced which answer.
 *
 * TWO RULES. Nothing in the runtime reads this back: it is an audit record,
 * not memory, and a model that could see its old answers would be the local
 * data this repo forbids. And it holds members' names and questions, so it
 * stays in the instance directory under state/, gitignored like state.json.
 *
 * The directory is resolved the same way config.js resolves the instance —
 * deliberately without importing config.js, whose .env validation would stop
 * the reader (src/turns.js) opening a ledger without the instance's secrets.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "./log.js";

const instanceDir = path.resolve(process.env.INSTANCE_DIR || process.cwd());

export const LEDGER_DIR = path.resolve(
  instanceDir,
  process.env.LEDGER_DIR || path.join("state", "turns"),
);
export const PROMPTS_DIR = path.join(path.dirname(LEDGER_DIR), "prompts");

/** A tool result body larger than this is clipped in the record. 16 KB keeps a
 *  roster or a battle list whole and stops a raw live_fetch from becoming the
 *  file. Override with LEDGER_BODY_CHARS. */
export const BODY_CHARS = Number(process.env.LEDGER_BODY_CHARS) || 16000;
/** The timeline payload handed to an event routine, same idea. */
const EVENTS_CHARS = 64000;

export const RECORD_VERSION = 1;

export const sha = (text) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 12);

export const instanceName = () => path.basename(instanceDir);

function clipBody(text) {
  if (text === undefined || text === null) return null;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  return s.length > BODY_CHARS ? { clipped: true, chars: s.length, head: s.slice(0, BODY_CHARS) } : s;
}

/**
 * Write the prompt once per distinct text and return its sha. A snapshot that
 * exists is never rewritten, so the file is the wording as first seen.
 */
export function snapshotPrompt(text, { dir = PROMPTS_DIR } = {}) {
  const hash = sha(text);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${hash}.txt`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, String(text ?? ""));
  } catch (error) {
    log.warn("ledger_prompt_snapshot_failed", { error: error.message });
  }
  return hash;
}

/** The trace as the model produced it, plus each call's result body, bounded. */
function traceFor(result) {
  return (result?.trace || []).map((step) => {
    if (step.kind === "thought") return { kind: "thought", text: step.text };
    if (step.kind === "tool") {
      return {
        kind: "tool",
        name: step.name,
        input: step.input ?? {},
        shape: step.shape ?? null,
        ms: step.ms ?? null,
        requestId: step.requestId ?? null,
        result: clipBody(step.result),
      };
    }
    if (step.kind === "error") {
      return {
        kind: "error",
        name: step.name,
        code: step.code ?? null,
        detail: step.detail,
        requestId: step.requestId ?? null,
        result: clipBody(step.result),
      };
    }
    return step;
  });
}

/**
 * Build a `turn` record. `input` and `output` are the lane's own shapes:
 *
 *   ask      input  { kind: "message", asker: {id, name}, channelId, threadId,
 *                     question, history: [{role, content}] }
 *            output { text, messageIds, footers, ungrounded, friction }
 *   routine  input  { kind: "schedule" | "events", brief, events, recent,
 *                     defaultChannelId }
 *            output { text, posts: [{channelId, channelName, messageIds, text}],
 *                     skipped, footers, ungrounded, friction }
 *
 * A failed turn has `output.error` and whatever the trace got to.
 */
export function turnEntry({ routine, lane, result, system, input, output, contractVersion = null }) {
  const events = input?.events;
  const eventsText = events === undefined || events === null ? null : JSON.stringify(events);
  return {
    kind: "turn",
    v: RECORD_VERSION,
    turnId: result?.turnId ?? null,
    at: new Date().toISOString(),
    instance: instanceName(),
    routine: routine.key,
    lane,
    trigger: routine.trigger,
    model: result?.model ?? routine.model ?? null,
    effort: result?.effort ?? routine.effort ?? null,
    serverVersion: result?.serverVersion ?? null,
    contractVersion,
    prompt: {
      system: system ? snapshotPrompt(system) : null,
      routine: sha(routine.prompt),
    },
    input: {
      ...input,
      events:
        eventsText === null
          ? undefined
          : eventsText.length > EVENTS_CHARS
            ? { clipped: true, chars: eventsText.length, head: eventsText.slice(0, EVENTS_CHARS) }
            : events,
    },
    trace: traceFor(result),
    envelopes: result?.envelopes ?? [],
    errors: result?.errors ?? [],
    output,
    usage: result?.usage ?? null,
    usd: result?.usd ?? null,
    ms: result?.ms ?? null,
    rounds: result?.rounds ?? null,
    stopReason: result?.stopReason ?? null,
    truncated: result?.truncated ?? false,
  };
}

export function reactionEntry({ turnId, reaction, userId, note = null }) {
  return { kind: "reaction", v: RECORD_VERSION, turnId, at: new Date().toISOString(), instance: instanceName(), reaction, userId, note };
}

export function filedEntry({ turnId, summary }) {
  return { kind: "filed", v: RECORD_VERSION, turnId, at: new Date().toISOString(), instance: instanceName(), summary };
}

export const fileFor = (at, dir = LEDGER_DIR) => path.join(dir, `${String(at).slice(0, 10)}.jsonl`);

/**
 * Append one record. Never throws: a ledger that cannot be written is a
 * warning in the log, not a turn that fails after the answer was posted.
 */
export function append(record, { dir = LEDGER_DIR } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fileFor(record.at, dir), `${JSON.stringify(record)}\n`);
    return true;
  } catch (error) {
    log.warn("ledger_write_failed", { kind: record?.kind, turnId: record?.turnId, error: error.message });
    return false;
  }
}

/**
 * Every record in the window, oldest first. `since`/`until` are YYYY-MM-DD
 * (inclusive) and select files, not lines, since a file is a day.
 */
export function readRecords({ dir = LEDGER_DIR, since = null, until = null } = {}) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const records = [];
  for (const file of files) {
    const day = file.slice(0, 10);
    if (since && day < since) continue;
    if (until && day > until) continue;
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // A torn last line from a crash mid-write is the only way this happens.
      }
    }
  }
  return records;
}

/** Turns with their later signals folded in: `{ ...turn, reactions: [], filed: [] }`. */
export function readTurns(options = {}) {
  const records = readRecords(options);
  const turns = new Map();
  for (const r of records) if (r.kind === "turn" && r.turnId) turns.set(r.turnId, { ...r, reactions: [], filed: [] });
  for (const r of records) {
    const turn = turns.get(r.turnId);
    if (!turn) continue;
    if (r.kind === "reaction") turn.reactions.push(r);
    else if (r.kind === "filed") turn.filed.push(r);
  }
  return [...turns.values()];
}
