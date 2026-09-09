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
import { callTool, resolveToolName } from "./mcp.js";
import { log } from "./log.js";
import * as state from "./state.js";

const MCP_BETA = "mcp-client-2025-11-20";
const MAX_ROUNDS = 5;
const client = new Anthropic();

// USD per million tokens. Used only to report what the experiment costs.
const PRICING = {
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

function costOf(model, usage) {
  const rate = PRICING[model];
  if (!rate || !usage) return 0;
  return (
    ((usage.input_tokens || 0) * rate.input +
      (usage.output_tokens || 0) * rate.output +
      (usage.cache_creation_input_tokens || 0) * rate.cacheWrite +
      (usage.cache_read_input_tokens || 0) * rate.cacheRead) /
    1_000_000
  );
}

const mcpServers = [
  {
    type: "url",
    url: config.mcp.url,
    name: config.mcp.serverName,
    authorization_token: config.mcp.token,
  },
];
const tools = [{ type: "mcp_toolset", mcp_server_name: config.mcp.serverName }];

/** An mcp_tool_result's content is a string or an array of text blocks. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("");
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
function describeShape(body) {
  if (!body || typeof body !== "object") return null;
  const counts = [];
  let sawArray = false;
  for (const [key, value] of Object.entries(body)) {
    if (key === "meta" || !Array.isArray(value)) continue;
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
  };
}

/**
 * Walks one response and reports what the tools actually did. Block type names
 * are matched by suffix so a rename on the API side degrades to "we saw no tool
 * activity" rather than crashing the reply.
 */
function readToolActivity(content, timings) {
  const byId = new Map();
  const called = [];
  const errors = [];
  const trace = [];
  const envelopes = [];

  for (const block of content) {
    if (typeof block?.type !== "string") continue;

    if (block.type === "thinking") {
      const text = (block.thinking || "").trim();
      if (text) trace.push({ kind: "thought", text });
    } else if (block.type.endsWith("tool_use")) {
      const name = block.name || "unknown";
      const step = { kind: "tool", name, input: block.input, id: block.id };
      if (block.id) byId.set(block.id, step);
      called.push(name);
      trace.push(step);
    } else if (block.type.endsWith("tool_result")) {
      const step = byId.get(block.tool_use_id);
      const name = step?.name || "unknown";
      const ms = timings?.get(block.tool_use_id);
      if (step && ms !== undefined) step.ms = ms;

      let body = null;
      const raw = resultText(block.content);
      try {
        body = JSON.parse(raw);
      } catch {
        // A tool answering in prose is legal; there is just no shape to report.
      }

      // is_error alone is not enough. A call can fail without the flag being
      // set -- an unknown tool name resolves at the protocol layer, not the
      // tool layer -- and Elixir MCP reports its own refusals as a body with
      // an `error` object. Both used to render as an ordinary success, so the
      // model would report "linked!" while nothing had been written. Observed
      // 2026-09-08: two elixir_identify calls stored nothing and said they had.
      const failed = block.is_error || Boolean(body?.error);
      if (failed) {
        const detail = (body?.error?.message ?? raw).slice(0, 400);
        errors.push({ name, detail });
        trace.push({ kind: "error", name, detail });
        continue;
      }
      if (step) step.shape = describeShape(body);
      const envelope = readEnvelope(body);
      if (envelope) envelopes.push({ tool: name, ...envelope });
    }
  }
  return { called, errors, trace, envelopes };
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
  // Spend is bucketed by routine so "what does this post cost" is answerable.
  routineKey = "unattributed",
}) {
  const history = [...messages];
  const started = Date.now();
  // Ours, not the server's. It cannot join to Elixir MCP's mcp_call_audit row —
  // that needs a request_id on the response envelope, a server change — but it
  // does turn "the war numbers looked wrong on Tuesday" into one grep of this
  // process's log.
  const turnId = randomUUID().slice(0, 8);

  const called = [];
  const errors = [];
  const trace = [];
  const envelopes = [];
  let usdTotal = 0;
  let text = "";
  let rounds = 0;
  let stopReason = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    rounds = round + 1;
    let response;
    const timings = new Map();

    try {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: maxTokens,
        betas: [MCP_BETA],
        system,
        messages: history,
        mcp_servers: mcpServers,
        tools,
        // "omitted" is the default on Sonnet 5 and returns empty thinking
        // blocks. We show our work in-channel, so ask for the summary.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
      });

      // Per-call latency, which separates "slow because six calls" from "slow
      // because one call took nine seconds". A tool starts executing when its
      // arguments finish streaming (content_block_stop), and is done when its
      // result block opens. content_block_stop carries only an index, so the
      // index->id mapping from content_block_start is what joins the two.
      const idByIndex = new Map();
      const execStart = new Map();

      stream.on("streamEvent", (event) => {
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

      response = await stream.finalMessage();
    } catch (error) {
      log.error("claude_call_failed", { turnId, error: error.message });
      return { ok: false, error: error.message, called, errors, trace, envelopes, usd: usdTotal };
    }

    const usd = costOf(model, response.usage);
    usdTotal += usd;
    state.addSpend(usd, routineKey);

    const activity = readToolActivity(response.content, timings);
    called.push(...activity.called);
    errors.push(...activity.errors);
    trace.push(...activity.trace);
    envelopes.push(...activity.envelopes);
    text = readText(response.content) || text;
    stopReason = response.stop_reason;

    if (stopReason === "refusal") {
      return { ok: false, error: "refusal", called, errors, trace, envelopes, usd: usdTotal };
    }
    // A CLIENT-SIDE tool call, on a connection whose tools are all server-side.
    //
    // Most of the time an mcp_toolset call comes home as `mcp_tool_use` +
    // `mcp_tool_result` in the same response: Anthropic ran it. But sometimes
    // the same tool arrives as an ordinary `tool_use` block, named
    // "<server>_<tool>", with stop_reason "tool_use" — the API asking US to run
    // it and hand back a result. Reproduced 2026-09-08: a turn ended on
    // `tool_use elixir-mcp_feedback` (toolu_...) after two server-side
    // `mcp_tool_use clans_roster` calls (mcptoolu_...).
    //
    // Left unhandled, that response has no text, and the routine runner read
    // empty text as SKIP: the turn did all its work, spent all its tokens, and
    // posted nothing. Echoing the assistant turn back without results is not an
    // option either — the API rejects it ("tool_use ids were found without
    // tool_result blocks immediately after").
    //
    // So we execute it, over the direct MCP client, against the same server and
    // the same key. This is NOT a tool mirror: the name and arguments are
    // forwarded opaquely, and nothing here knows what any tool does.
    if (stopReason === "tool_use") {
      const pending = response.content.filter((block) => block.type === "tool_use");
      if (pending.length > 0) {
        history.push({ role: "assistant", content: response.content });
        const results = [];
        for (const block of pending) {
          const tool = await resolveToolName(block.name);
          const call = await callTool(tool, block.input ?? {});
          log.info("client_side_tool_call", { turnId, tool, ok: call.ok });
          if (!call.ok) {
            errors.push({ name: tool, detail: String(call.error).slice(0, 400) });
            trace.push({ kind: "error", name: tool, detail: String(call.error).slice(0, 400) });
          }
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: !call.ok,
            content: JSON.stringify(call.ok ? call.body : { error: { message: call.error } }),
          });
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
    break;
  }

  return {
    ok: true,
    text,
    called,
    errors,
    trace,
    envelopes,
    usd: usdTotal,
    turnId,
    ms: Date.now() - started,
    rounds,
    stopReason,
    // A max_tokens cutoff otherwise reads as a complete answer.
    truncated: stopReason === "max_tokens" || rounds >= MAX_ROUNDS,
    model,
    effort,
    serverVersion: state.get("serverVersion"),
  };
}

export function overDailyCap() {
  if (!config.dailyUsdCap) return false;
  return state.todaySpend() >= config.dailyUsdCap;
}
