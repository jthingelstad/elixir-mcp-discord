/**
 * The model call, and everything we can learn about it.
 *
 * Tools reach Claude through the Claude API's MCP connector: we hand the API
 * the Elixir MCP URL and our service token, and Anthropic opens the MCP
 * connection server-side and runs the tool loop. That is the whole integration.
 *
 * Two reasons this beats proxying tools by hand, and both are why this repo
 * exists:
 *
 *   1. Tool drift stops being our problem. Elixir MCP publishes
 *      `serverInfo.version` as `<contract>+tools.<fingerprint>` precisely
 *      because clients cache `tools/list` forever. A hand-written tool mirror
 *      goes stale silently — the way a "22 tools, contract 0.10" note went
 *      stale while the server shipped 36 tools at 0.28. The connector re-reads
 *      the surface itself.
 *
 *   2. It is the same path a member's own agent takes. A privileged shortcut
 *      would make the channel demonstrate something nobody can reproduce.
 *
 * A NOTE ON WHAT THE CONNECTOR GIVES BACK. Because tool results come home as
 * `mcp_tool_result` blocks, we can read the payloads Claude read. That is what
 * makes the diagnostic footer possible: the result SHAPE (how many rows, and
 * whether it was empty) and the meta envelope every Elixir MCP response carries
 * — as_of, recorded_since, freshness_seconds, and above all completeness_note,
 * which is the server saying "capture was incomplete, caveat this" and which
 * until now reached the model and never the reader.
 *
 * There is deliberately no local database, no roster cache, and no fallback. If
 * Elixir MCP cannot answer, neither can this bot, and it says so.
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { costOf, rateFor } from "./pricing.js";
import * as budget from "./budget.js";
import { callTool, resolveToolName, toolCatalog } from "./mcp.js";
import { disabledTools } from "./tools.js";
import { log } from "./log.js";
import * as state from "./state.js";

const MCP_BETA = "mcp-client-2025-11-20";
const MAX_ROUNDS = 5;
const client = new Anthropic();

const mcpServers = [
  {
    type: "url",
    url: config.mcp.url,
    name: config.mcp.serverName,
    authorization_token: config.mcp.token,
  },
];
/**
 * PROMPT CACHING. Two breakpoints, on the two things that are the same on
 * every turn: the tool surface and the system block.
 *
 * Fifty tool schemas from the server are most of a turn's input tokens, and
 * the system block (mechanics, identity, the standing brief) is built to be a
 * stable prefix — the per-asker id rides in the user turn for that reason.
 * The prefix is cached in the order tools → system → messages, so a
 * breakpoint on each means a routine that reads two small results pays the
 * cache-read rate for the bulk of what it sends. The usage block says how
 * much was actually served from cache; the trace footer shows it, because a
 * cache that silently stopped hitting is a cost regression nobody would see.
 */
/** The server's tools, with the writes this kind of turn may not use
 *  switched off (src/tools.js). Stable per kind of turn, so the cache
 *  breakpoint holds: a lane's disabled set changes only with the catalog. */
function mcpToolset(disabled = []) {
  return {
    type: "mcp_toolset",
    mcp_server_name: config.mcp.serverName,
    ...(disabled.length ? { configs: Object.fromEntries(disabled.map((name) => [name, { enabled: false }])) } : {}),
    cache_control: { type: "ephemeral" },
  };
}

/**
 * LOCAL tools — the few things this runner can do that the server cannot,
 * today `post_message` (src/run.js). They go BEFORE the toolset so the cache
 * breakpoint on it covers them; a lane without local tools (the ask lane)
 * has a different, equally stable prefix.
 */
function toolsFor(localTools, disabled) {
  return [
    ...localTools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    mcpToolset(disabled),
  ];
}

function systemBlocks(system) {
  if (Array.isArray(system)) return system;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

/** What a turn sent and where it came from, summed across rounds. */
function addUsage(total, usage) {
  return {
    input: total.input + (usage?.input_tokens || 0),
    cacheRead: total.cacheRead + (usage?.cache_read_input_tokens || 0),
    cacheWrite: total.cacheWrite + (usage?.cache_creation_input_tokens || 0),
    output: total.output + (usage?.output_tokens || 0),
  };
}

/** The share of prompt tokens served from cache, 0..1. */
export function cacheShare(usage) {
  const prompt = (usage?.input || 0) + (usage?.cacheRead || 0) + (usage?.cacheWrite || 0);
  return prompt ? (usage.cacheRead || 0) / prompt : 0;
}

/** An mcp_tool_result's content is a string or an array of text blocks. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
  }
  return "";
}

/**
 * Describes a result without reproducing it: how many rows, of what, and
 * whether it was empty.
 *
 * This is the cheapest guard against the failure that is hardest to see from a
 * transcript — a tool that answered perfectly well with nothing in it, and a
 * model that narrated smoothly around the hole. "1 player" and "0 players" read
 * identically in prose and could not be more different.
 */
export function describeShape(body) {
  if (!body || typeof body !== "object") return null;
  const counts = [];
  let sawArray = false;
  for (const [key, value] of Object.entries(body)) {
    // `notes` is the contract's per-call prose (one sentence each), not rows.
    if (key === "meta" || key === "notes" || !Array.isArray(value)) continue;
    sawArray = true;
    counts.push(`${value.length} ${key}`);
    if (counts.length === 2) break;
  }
  if (!sawArray) return "object";
  const total = counts.join(", ");
  return total.startsWith("0 ") && counts.length === 1 ? `${total} (EMPTY)` : total;
}

function readEnvelope(body) {
  const meta = body?.meta;
  if (!meta || typeof meta !== "object") return null;
  return {
    as_of: meta.as_of ?? null,
    recorded_since: meta.recorded_since ?? null,
    freshness_seconds: meta.freshness_seconds ?? null,
    completeness_note: meta.completeness_note ?? null,
    contract_version: meta.contract_version ?? null,
    // Minted per call and stamped into meta (protocol#request_id). It is what
    // the maintainer opens when a filing names a call, and what the trace
    // shows so a screenshot of a wrong answer can be joined to the audit row.
    request_id: meta.request_id ?? null,
  };
}

/**
 * ONE SHAPE FOR WHAT A TOOL SAID, whoever ran it.
 *
 * A tool result reaches this file three ways — an `mcp_tool_result` block the
 * connector ran server-side, a `tool_use` the API handed back for us to run
 * over the direct MCP client, and a local tool (post_message, the room
 * tool, the DM's tools) run by its own handler — and until 2026-09-17 each
 * had its own bookkeeping: three places deciding what "failed" meant, two
 * shapes for an error body, one of them setting the result shape and the
 * others not. `outcome` is the one reading: the raw text the model sees, the
 * parsed body when there is one, and whether it failed.
 *
 * is_error alone is not enough. A call can fail without the flag being set
 * — an unknown tool name resolves at the protocol layer, not the tool layer
 * — and Elixir MCP reports its own refusals as a body with an `error`
 * object. Both used to render as an ordinary success, so the model would
 * report "linked!" while nothing had been written (observed 2026-09-08: two
 * elixir_identify calls stored nothing and said they had). A refusal keeps
 * its request_id (the response cap says so explicitly), so an error can be
 * reported by id as well as by message; the code is from the contract's
 * closed set (no_subject, invalid_tag, quota_exceeded, ...) and the friction
 * sweep decides on it rather than on the English of the message.
 */
export function outcome(raw, { isError = false } = {}) {
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // A tool answering in prose is legal; there is just no shape to report.
  }
  const failed = Boolean(isError) || Boolean(body?.error);
  const requestId = typeof body?.meta?.request_id === "string" ? body.meta.request_id : null;
  return {
    ok: !failed,
    raw,
    body,
    requestId,
    code: failed && typeof body?.error?.code === "string" ? body.error.code : null,
    // The code's class (hub 3.18.0): retry | input | subject | server |
    // budget, so the friction sweep branches on one word.
    errorClass: failed && typeof body?.error?.class === "string" ? body.error.class : null,
    detail: failed ? String(body?.error?.message ?? raw).slice(0, 400) : null,
  };
}

/** The outcome of a call this process made — a local handler or the direct
 *  MCP client — rendered to the text the model will read, then read back
 *  the same way a server-side result is. `{ ok, body, error, code }` in;
 *  the wire text is what goes into the tool_result block. */
function outcomeOfCall(call) {
  const raw = JSON.stringify(
    call.ok ? (call.body ?? { ok: true }) : { error: { message: String(call.error), code: call.code ?? null } },
  );
  return outcome(raw, { isError: !call.ok });
}

/**
 * The turn's tool bookkeeping: what was called, what failed, the trace the
 * footer and the ledger render, and the meta envelopes the footer reads.
 * `use` opens a step when the model decides on a call; `settle` closes it
 * with an outcome — from a connector result block, from the direct client,
 * or from a local handler, all through the same door.
 */
function newActivity() {
  return { called: [], errors: [], trace: [], envelopes: [], byId: new Map() };
}

function use(activity, block) {
  const name = block.name || "unknown";
  const step = { kind: "tool", name, input: block.input, id: block.id };
  if (block.id) activity.byId.set(block.id, step);
  activity.called.push(name);
  activity.trace.push(step);
  return step;
}

function settle(activity, { step, name, result, ms }) {
  if (step && ms !== undefined) step.ms = ms;
  if (!result.ok) {
    const failure = {
      name,
      code: result.code,
      class: result.errorClass ?? null,
      detail: result.detail,
      requestId: result.requestId,
    };
    activity.errors.push(failure);
    activity.trace.push({ kind: "error", ...failure, result: result.raw });
    return;
  }
  if (step) {
    step.shape = describeShape(result.body);
    step.requestId = result.requestId;
    // The body itself, for the turn ledger (src/ledger.js): the footer
    // shows the shape, but "was that number right?" needs what the tool
    // actually said. Not rendered anywhere in Discord.
    step.result = result.raw;
  }
  const envelope = readEnvelope(result.body);
  if (envelope) activity.envelopes.push({ tool: name, ...envelope });
}

/**
 * Walks one response and records what the connector's tools did. Block type
 * names are matched by suffix so a rename on the API side degrades to "we
 * saw no tool activity" rather than crashing the reply.
 */
function readResponse(activity, content, timings) {
  for (const block of content) {
    if (typeof block?.type !== "string") continue;
    if (block.type === "thinking") {
      const text = (block.thinking || "").trim();
      if (text) activity.trace.push({ kind: "thought", text });
    } else if (block.type.endsWith("tool_use")) {
      use(activity, block);
    } else if (block.type.endsWith("tool_result")) {
      const step = activity.byId.get(block.tool_use_id);
      settle(activity, {
        step,
        name: step?.name || "unknown",
        result: outcome(resultText(block.content), { isError: block.is_error }),
        ms: timings?.get(block.tool_use_id),
      });
    }
  }
}

/**
 * A CLIENT-SIDE tool call: the API handed back an ordinary `tool_use` and
 * stopped, asking us to run it. Ours (a local tool) or the server's, over the
 * direct MCP client against the same server and the same key — NOT a tool
 * mirror: the name and arguments are forwarded opaquely, and nothing here
 * knows what any tool does. A handler's refusal (a channel not in the
 * directory, a cap reached) is a tool error the model sees, not an
 * exception.
 */
async function executeClientSide(block, localTools, turnId, { disabled = [], names = null } = {}) {
  const local = localTools.find((t) => t.name === block.name);
  if (local) {
    let call;
    try {
      call = await local.handler(block.input ?? {});
    } catch (error) {
      call = { ok: false, error: error.message };
    }
    log.info("client_tool_call", { turnId, tool: block.name, via: "local", ok: call.ok });
    return { name: block.name, result: outcomeOfCall(call) };
  }
  const tool = await resolveToolName(block.name, { names });
  // This path runs a server tool over the direct client, past the
  // connector's `configs`: a switched-off tool is refused here as well.
  if (disabled.includes(tool)) {
    log.warn("client_tool_refused", { turnId, tool, reason: "not available to this kind of turn" });
    return {
      name: tool,
      result: outcomeOfCall({ ok: false, code: "not_available", error: `${tool} is not available in this turn` }),
    };
  }
  const call = await callTool(tool, block.input ?? {});
  log.info("client_tool_call", { turnId, tool, via: "mcp", ok: call.ok });
  // The direct client reports a refusal as ok:false WITH the refusal body
  // (error code, request_id); the model reads that body, not our paraphrase.
  const refusal = !call.ok && call.body?.error ? JSON.stringify(call.body) : null;
  return { name: tool, result: refusal ? outcome(refusal, { isError: true }) : outcomeOfCall(call) };
}

function readText(content) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * `onEvent` receives live progress: `tool_start` the moment Claude decides on a
 * call (content_block_start carries the name before arguments finish
 * streaming), and `text` deltas as prose arrives.
 *
 * Worth being clear about what streaming does and does not reach here. Elixir
 * MCP's own transport is invisible to us — the connector means Anthropic holds
 * that connection, and a tool call is request/response regardless. Discord has
 * no streaming message API; the ask lane approximates it by editing one message
 * on a throttle. What genuinely streams is Claude to us, and the valuable part
 * is not prose arriving letter by letter — it is the tool calls becoming
 * visible the instant they happen.
 */
export async function ask({
  system,
  messages,
  maxTokens = config.claude.maxTokens,
  onEvent,
  // A routine may pick its own model and effort: a war-deck nudge that reads
  // one field does not need what a weekly meta report needs, and paying the
  // same for both is how a schedule quietly becomes expensive.
  model = config.claude.model,
  effort = config.claude.effort,
  // Spend is bucketed by routine so "what does this post cost" is answerable,
  // and by LANE so a chatty ask channel cannot spend the schedule's budget.
  routineKey = "unattributed",
  lane = "routines",
  // What this turn may DO through Elixir beyond reading (src/tools.js):
  // "rehearsal" for a dry run, else the kind of turn. Defaults to the lane.
  policy = lane,
  // The server's tool catalog, injectable so a test never reaches the network.
  catalogFn = toolCatalog,
  // `[{ name, description, input_schema, handler(input) -> {ok, body} }]`.
  // Executed here when the model calls them; see src/run.js.
  localTools = [],
  // A member's answer is done in five rounds or it is looping. A review
  // (src/review.js) proposes edits one tool call at a time and needs more.
  maxRounds = MAX_ROUNDS,
  // `nudge({ text, called, truncated })` is asked ONCE when the model ends
  // the turn in prose, or when the turn is cut off at max_tokens. Return a
  // user message to send back and the turn gets one more round; return null
  // to accept the reply. The caller knows what "done" means (a routine turn
  // is done when post_message was called or the reply is SKIP); this loop
  // only knows how to ask again. See src/run.js.
  nudge = null,
  // The API call, injectable so a test can play the model round by round
  // (a fake needs `.on("streamEvent", fn)` and `.finalMessage()`).
  stream = (params) => client.beta.messages.stream(params),
}) {
  const history = [...messages];
  const started = Date.now();
  // Ours, not the server's: it turns "the war numbers looked wrong on Tuesday"
  // into one grep of this process's log. The server's own request_id rides
  // each tool result's meta and is read beside it (the join to Elixir's call
  // audit).
  const turnId = randomUUID().slice(0, 8);

  const activity = newActivity();
  const { called, errors, trace, envelopes } = activity;
  let usdTotal = 0;
  let usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let text = "";
  let rounds = 0;
  let stopReason = null;
  let nudged = false;
  let resumed = false;
  // What every return carries, failed or not. A round can fail AFTER a
  // client-side tool already acted — post_message sent, then the next API
  // call 529s — and a failure with no turnId was dropped by the ledger's
  // reader, so the turn that put a message in a channel had no record.
  const summary = () => ({
    text,
    called,
    errors,
    trace,
    envelopes,
    usd: usdTotal,
    usage,
    turnId,
    ms: Date.now() - started,
    rounds,
    stopReason,
    nudged,
    resumed,
    model,
    effort,
    policy,
  });

  // The price first, BEFORE anything is paid for. Boot checks the models it
  // can see, but a routine's `model:` edited later (by hand, or set from the
  // DM) reached the API, and costOf threw on the response — a paid call whose
  // spend no budget ever saw, repeated every poll by an event routine.
  let adaptive;
  try {
    ({ adaptive } = rateFor(model));
  } catch (error) {
    log.error("model_unpriced", { turnId, model, routine: routineKey });
    return { ...summary(), ok: false, error: error.message };
  }
  // The writes this turn may not make, from the server's own annotations.
  // Read before the call like the price: a rehearsal that filed with the
  // maintainer is the reason this exists.
  const catalog = await catalogFn();
  const disabled = disabledTools(policy, catalog);
  // A tool handed back to run is named against the same catalog.
  const published = catalog?.ok ? catalog.tools.map((t) => t.name) : null;

  // Thinking and effort only where the model takes them: on Haiku 4.5 either
  // is a 400, so `model: claude-haiku-4-5` failed every turn.
  const depth = adaptive
    ? {
        // "omitted" is the default on Sonnet 5 and returns empty thinking
        // blocks. We show our work in-channel, so ask for the summary.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
      }
    : {};

  for (let round = 0; round < maxRounds; round += 1) {
    rounds = round + 1;
    let response;
    const timings = new Map();

    try {
      const call = stream({
        model,
        max_tokens: maxTokens,
        betas: [MCP_BETA],
        system: systemBlocks(system),
        messages: history,
        mcp_servers: mcpServers,
        tools: toolsFor(localTools, disabled),
        ...depth,
      });

      // Per-call latency, which separates "slow because six calls" from "slow
      // because one call took nine seconds". A tool starts executing when its
      // arguments finish streaming (content_block_stop), and is done when its
      // result block opens. content_block_stop carries only an index, so the
      // index->id mapping from content_block_start is what joins the two.
      const idByIndex = new Map();
      const execStart = new Map();

      call.on("streamEvent", (event) => {
        try {
          if (event.type === "content_block_start") {
            const block = event.content_block;
            const type = block?.type;
            if (typeof type !== "string") return;
            if (type.endsWith("tool_use")) {
              if (block.id) idByIndex.set(event.index, block.id);
              onEvent?.({ kind: "tool_start", name: block.name || "unknown" });
            } else if (type.endsWith("tool_result") && block.tool_use_id) {
              const start = execStart.get(block.tool_use_id);
              if (start !== undefined) timings.set(block.tool_use_id, Date.now() - start);
            }
          } else if (event.type === "content_block_stop") {
            const id = idByIndex.get(event.index);
            if (id) execStart.set(id, Date.now());
          } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            onEvent?.({ kind: "text", text: event.delta.text });
          }
        } catch {
          // A failing progress renderer must never take down the answer.
        }
      });

      response = await call.finalMessage();
    } catch (error) {
      log.error("claude_call_failed", { turnId, error: error.message });
      return { ...summary(), ok: false, error: error.message };
    }

    const usd = costOf(model, response.usage);
    usdTotal += usd;
    usage = addUsage(usage, response.usage);
    state.addSpend(usd, routineKey);
    budget.record(lane, usd, new Date(), turnId);

    readResponse(activity, response.content, timings);
    text = readText(response.content) || text;
    stopReason = response.stop_reason;

    if (stopReason === "refusal") return { ...summary(), ok: false, error: "refusal" };
    // A CLIENT-SIDE tool call, on a connection whose tools are all server-side.
    //
    // Most of the time an mcp_toolset call comes home as `mcp_tool_use` +
    // `mcp_tool_result` in the same response: Anthropic ran it. But sometimes
    // the same tool arrives as an ordinary `tool_use` block, named
    // "<server>_<tool>", with stop_reason "tool_use" — the API asking US to run
    // it and hand back a result. Reproduced 2026-09-08: a turn ended on
    // `tool_use elixir-mcp_feedback` (toolu_...) after two server-side
    // `mcp_tool_use clans_roster` calls (mcptoolu_...). Local tools arrive
    // the same way, on purpose.
    //
    // Left unhandled, that response has no text, and the routine runner read
    // empty text as SKIP: the turn did all its work, spent all its tokens, and
    // posted nothing. Echoing the assistant turn back without results is not an
    // option either — the API rejects it ("tool_use ids were found without
    // tool_result blocks immediately after").
    if (stopReason === "tool_use") {
      const pending = response.content.filter((block) => block.type === "tool_use");
      if (pending.length > 0) {
        history.push({ role: "assistant", content: response.content });
        const results = [];
        for (const block of pending) {
          const { name, result } = await executeClientSide(block, localTools, turnId, { disabled, names: published });
          settle(activity, { step: activity.byId.get(block.id), name, result });
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: !result.ok, content: result.raw });
        }
        // All results in ONE user message: splitting them teaches the model to
        // stop making parallel calls.
        history.push({ role: "user", content: results });
        continue;
      }
    }

    // TWO ways a turn can come back unfinished, and both used to end it.
    //
    // `pause_turn` is the documented one: the server-side sampling loop hit its
    // iteration limit and expects the assistant turn echoed back to resume.
    //
    // `pause_turn` means the server-side sampling loop hit its iteration limit.
    // Echo the assistant turn back and ask again; do NOT add a "continue"
    // message, the server resumes from the trailing tool block on its own.
    if (stopReason === "pause_turn") {
      history.push({ role: "assistant", content: response.content });
      continue;
    }
    // The model ended in prose when the caller needed a tool call. One more
    // round, once, with the caller's nudge as the user turn. The case that
    // paid for this: a scheduled turn that did nine tool calls, wrote its
    // post, and never called post_message — Sonnet 5 did that on one turn in
    // four with the posting rule first and DELIVER last (2026-09-14..16, all
    // three instances). The work is done and cached; asking again costs a
    // cache read, dropping it cost the whole turn.
    //
    // The same round serves a turn cut off at max_tokens (2026-09-20, turn
    // c0aa7196): the meta-report made four big reads at high effort, the
    // thinking about them reached the 6,000-token ceiling, and the response
    // had no text — which the runner read as SKIP. The reads are done and in
    // the turn; the continuation gets a fresh ceiling and the caller's
    // message. A client-side tool_use in a max_tokens response is dropped
    // from the echo: its input may be cut mid-argument (never run it), and
    // an assistant turn with a tool_use and no tool_result is a 400.
    const cutOff = stopReason === "max_tokens";
    if ((stopReason === "end_turn" || cutOff) && nudge && !nudged) {
      const message = nudge({ text, called, truncated: cutOff });
      const echo = cutOff ? response.content.filter((block) => block.type !== "tool_use") : response.content;
      if (message && echo.length > 0) {
        nudged = true;
        if (cutOff) resumed = true;
        log.info(cutOff ? "turn_resumed" : "turn_nudged", {
          turnId,
          routine: routineKey,
          chars: text.length,
          ...(cutOff ? { maxTokens, output: response.usage?.output_tokens } : {}),
        });
        history.push({ role: "assistant", content: echo });
        history.push({ role: "user", content: message });
        continue;
      }
    }
    break;
  }

  return {
    ...summary(),
    ok: true,
    // `resumed` (in the summary): the turn was cut off at max_tokens and
    // asked again; a post that follows was delivered on the second ask.
    // Beside `nudged` so the review can tell "too little room" from "forgot
    // to call the tool". A max_tokens cutoff otherwise reads as a complete
    // answer.
    // Out of rounds only when the last round still wanted another: a turn
    // that ended normally on its last allowed round finished (2026-09-26
    // review: that read as truncated, the events cursor held, and the next
    // poll paid for the same batch again).
    truncated: stopReason === "max_tokens" || (rounds >= maxRounds && stopReason !== "end_turn"),
    serverVersion: state.get("serverVersion"),
  };
}

export function overDailyCap() {
  if (!config.dailyUsdCap) return false;
  return state.todaySpend() >= config.dailyUsdCap;
}

/**
 * May this lane spend? The monthly budget first, then the daily cap on top.
 * Returns null when there is nothing in the way, or a short reason to show.
 */
export function spendBlock(lane) {
  const verdict = budget.check(lane);
  if (!verdict.ok) return verdict;
  if (overDailyCap()) return { ok: false, reason: "daily_cap" };
  return null;
}
