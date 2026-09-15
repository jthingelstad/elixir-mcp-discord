/**
 * The turn ledger is the record an answer's quality is judged from, so what
 * matters is that a turn on either lane lands there whole — question and
 * history, every call with its result body, the answer and where it went —
 * and that later signals join back to it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import * as ledger from "../src/ledger.js";
import { runRoutine } from "../src/run.js";
import { handleAsk } from "../src/ask.js";
import { handleReaction } from "../src/reactions.js";
import { parseRoutine } from "../src/routines.js";
import { renderTurn } from "../src/turns.js";
import * as state from "../src/state.js";

const today = () => new Date().toISOString().slice(0, 10);

function fresh() {
  fs.rmSync(ledger.LEDGER_DIR, { recursive: true, force: true });
  fs.rmSync(ledger.PROMPTS_DIR, { recursive: true, force: true });
}

const result = (extra = {}) => ({
  ok: true,
  text: "**canavar** — 9-2 over 11 battles.",
  called: ["battles_performance"],
  errors: [],
  trace: [
    { kind: "thought", text: "Read the last day first." },
    {
      kind: "tool",
      name: "battles_performance",
      input: { days: 1 },
      shape: "1 players",
      ms: 800,
      requestId: "req-1234-5678",
      result: JSON.stringify({ players: [{ name: "canavar", wins: 9, losses: 2 }] }),
    },
  ],
  envelopes: [{ tool: "battles_performance", as_of: "2026-09-13T12:00:00Z", request_id: "req-1234-5678" }],
  usd: 0.02,
  usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 },
  turnId: "feed0001",
  ms: 3000,
  rounds: 1,
  stopReason: "end_turn",
  truncated: false,
  model: "claude-sonnet-5",
  effort: "medium",
  serverVersion: "3.0.0+tools.abc",
  ...extra,
});

function fakeChannel() {
  const sent = [];
  return {
    id: "3",
    name: "pulse",
    sent,
    send: (text) => {
      const message = { id: `m${sent.length + 1}`, text, replies: [] };
      sent.push(message);
      return Promise.resolve({
        id: message.id,
        reply: (body) => {
          message.replies.push(typeof body === "string" ? body : body.content);
          return Promise.resolve({ id: `${message.id}-note` });
        },
      });
    },
    messages: { fetch: () => Promise.resolve(new Map()) },
  };
}

test("a scheduled turn is recorded whole: brief, trace with bodies, post and destination", async () => {
  fresh();
  const routine = parseRoutine(
    "notable-movers",
    "---\ntrigger: schedule\nchannel: pulse\nat: 01:00\ntrace: true\n---\nName three movers.",
  );
  const channel = fakeChannel();
  await runRoutine(routine, { channel, askFn: async () => result() });

  const turns = ledger.readTurns({ since: today() });
  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn.kind, "turn");
  assert.equal(turn.turnId, "feed0001");
  assert.equal(turn.routine, "notable-movers");
  assert.equal(turn.trigger, "schedule");
  assert.equal(turn.input.kind, "schedule");
  assert.equal(turn.input.brief, "Name three movers.");
  // The call's arguments AND what came back, not just its shape.
  const call = turn.trace.find((s) => s.kind === "tool");
  assert.deepEqual(call.input, { days: 1 });
  assert.match(call.result, /canavar/);
  assert.equal(call.requestId, "req-1234-5678");
  assert.equal(turn.output.text, "**canavar** — 9-2 over 11 battles.");
  assert.equal(turn.output.posts[0].channelName, "pulse");
  assert.deepEqual(turn.output.posts[0].messageIds, ["m1"]);
  assert.equal(turn.output.footers.length, 1, "the rendered trace footer is kept");
  assert.equal(turn.usd, 0.02);
  // The prompt that produced it is on disk under its hash.
  assert.match(turn.prompt.system, /^[0-9a-f]{12}$/);
  const snapshot = fs.readFileSync(path.join(ledger.PROMPTS_DIR, `${turn.prompt.system}.txt`), "utf8");
  assert.match(snapshot, /Your ONLY source of information is the Elixir MCP server/);
});

test("a skipped turn and a failed turn are recorded too", async () => {
  fresh();
  const routine = parseRoutine(
    "clan-feed",
    "---\ntrigger: schedule\nchannel: pulse\nat: 01:00\nmay_skip: true\n---\nSay what changed.",
  );
  await runRoutine(routine, {
    channel: fakeChannel(),
    askFn: async () => result({ text: "SKIP", turnId: "skip0001" }),
  });
  await runRoutine(routine, {
    channel: fakeChannel(),
    askFn: async () => ({
      ok: false,
      error: "overloaded",
      called: [],
      errors: [],
      trace: [],
      envelopes: [],
      usd: 0,
      turnId: "fail0001",
    }),
  });
  const turns = ledger.readTurns({ since: today() });
  assert.deepEqual(
    turns.map((t) => [t.turnId, t.output.skipped ?? false, t.output.error ?? null]),
    [
      ["skip0001", true, null],
      ["fail0001", false, "overloaded"],
    ],
  );
});

test("a dry run is a rehearsal and is not recorded", async () => {
  fresh();
  const routine = parseRoutine(
    "clan-feed",
    "---\ntrigger: schedule\nchannel: pulse\nat: 01:00\n---\nSay what changed.",
  );
  await runRoutine(routine, { channel: fakeChannel(), dryRun: true, askFn: async () => result() });
  assert.equal(ledger.readTurns({ since: today() }).length, 0);
});

test("an ask turn keeps the asker, the question, the thread history and the answer", async () => {
  fresh();
  const routine = parseRoutine(
    "ask",
    "---\ntrigger: message\nchannel: ask\nhistory_turns: 4\n---\nAnswer clan questions.",
  );
  const posted = [];
  const reply = (body) => {
    const entry = { id: `r${posted.length + 1}`, text: typeof body === "string" ? body : body.content };
    posted.push(entry);
    return Promise.resolve({
      id: entry.id,
      edit: (next) => {
        entry.text = next;
        return Promise.resolve();
      },
      reply: (child) => {
        posted.push({ id: `r${posted.length + 1}`, text: typeof child === "string" ? child : child.content });
        return Promise.resolve({ id: `r${posted.length}` });
      },
    });
  };
  const message = {
    id: "q1",
    cleanContent: "how am I playing?",
    author: { id: "42", username: "tester", bot: false },
    member: { displayName: "sikander sidhu" },
    reply,
    channel: { id: "2", send: (body) => reply(body), messages: { fetch: () => Promise.resolve(new Map()) } },
  };
  await handleAsk(message, routine, {
    askFn: async () => result({ turnId: "ask00001", text: "Linked you to sikander sidhu #JYRQ8U92C. 9-2 today." }),
  });

  const [turn] = ledger.readTurns({ since: today() });
  assert.equal(turn.lane, "ask");
  assert.equal(turn.input.kind, "message");
  assert.deepEqual(turn.input.asker, { id: "42", name: "sikander sidhu" });
  assert.equal(turn.input.question, "how am I playing?");
  assert.deepEqual(turn.input.history, []);
  assert.match(turn.output.text, /Linked you to sikander sidhu/);
  assert.ok(turn.output.messageIds.length >= 1);
  assert.equal(turn.output.ungrounded, false);
});

test("a reaction joins back to its turn as its own line", async () => {
  fresh();
  state.rememberTurn(
    "ask00002",
    { routine: "ask", lane: "ask", question: "q", answer: "a", called: [], errors: [], requestIds: [] },
    ["msg-9"],
  );
  const message = {
    id: "msg-9",
    partial: false,
    reply: async () => {},
    channel: { messages: { fetch: async () => new Map() } },
  };
  await handleReaction(
    { emoji: { name: "👍" }, message },
    { id: "7", bot: false, partial: false },
    { praiseFn: async () => true },
  );
  const records = ledger.readRecords({ since: today() });
  assert.deepEqual(
    records.map((r) => [r.kind, r.turnId, r.reaction]),
    [["reaction", "ask00002", "up"]],
  );
});

test("later signals fold into the turn on read, and the reader renders it", async () => {
  fresh();
  const routine = parseRoutine(
    "notable-movers",
    "---\ntrigger: schedule\nchannel: pulse\nat: 01:00\n---\nName three movers.",
  );
  await runRoutine(routine, { channel: fakeChannel(), askFn: async () => result() });
  ledger.append(ledger.reactionEntry({ turnId: "feed0001", reaction: "down", userId: "7", note: "canavar is 8-3" }));
  ledger.append(ledger.filedEntry({ turnId: "feed0001", summary: "off-by-one in the window" }));

  const [turn] = ledger.readTurns({ since: today() });
  assert.equal(turn.reactions.length, 1);
  assert.equal(turn.reactions[0].note, "canavar is 8-3");
  assert.equal(turn.filed[0].summary, "off-by-one in the window");

  const md = renderTurn(turn);
  assert.match(md, /## .* · notable-movers \(schedule\) · turn `feed0001`/);
  assert.match(md, /Name three movers\./);
  assert.match(md, /🔧 `battles_performance` `\{"days":1\}` → 1 players/);
  assert.match(md, /"canavar"/, "the body is in the transcript");
  assert.match(md, /👎 discord:7 .* — "canavar is 8-3"/);
  assert.match(md, /📮 filed: off-by-one/);
  assert.match(md, /claude-sonnet-5 · effort medium · \$0\.0200 · cache 90%/);
});

test("a tool body past the bound is clipped, not dropped", () => {
  const routine = parseRoutine("x", "---\ntrigger: schedule\nchannel: pulse\nat: 01:00\n---\nb");
  const big = "x".repeat(ledger.BODY_CHARS + 500);
  const entry = ledger.turnEntry({
    routine,
    lane: "routines",
    result: result({ trace: [{ kind: "tool", name: "live_fetch", input: {}, result: big }] }),
    system: "s",
    input: { kind: "schedule", brief: "b" },
    output: { text: "" },
  });
  const step = entry.trace[0];
  assert.equal(step.result.clipped, true);
  assert.equal(step.result.chars, big.length);
  assert.equal(step.result.head.length, ledger.BODY_CHARS);
});

test("a ledger that cannot be written is a warning, not a failed turn", () => {
  const entry = ledger.filedEntry({ turnId: "t", summary: "s" });
  const ok = ledger.append(entry, { dir: "/dev/null/not-a-directory" });
  assert.equal(ok, false);
});
