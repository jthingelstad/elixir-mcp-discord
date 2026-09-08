/**
 * The model call.
 *
 * Tools reach Claude through the Claude API's MCP connector: we hand the API
 * the Elixir MCP URL and our service token, and Anthropic opens the MCP
 * connection server-side and runs the tool loop. That is the whole integration.
 *
 * Two reasons this beats proxying tools by hand, and both are the reason this
 * repo exists:
 *
 *   1. Tool drift stops being our problem. Elixir MCP publishes
 *      `serverInfo.version` as `<contract>+tools.<fingerprint>` precisely
 *      because clients cache `tools/list` forever. A hand-written tool mirror
 *      goes stale silently — the same way a hand-maintained "22 tools, contract
 *      0.10" note went stale while the server shipped 36 tools at 0.28. The
 *      connector re-reads the surface itself, so a tool that shipped this
 *      morning is callable this afternoon with no deploy here.
 *
 *   2. It is the same path a member's own agent takes. If this bot had a
 *      privileged shortcut into the data, the channel would be demonstrating
 *      something nobody else can reproduce.
 *
 * There is deliberately no local database, no roster cache, and no fallback. If
 * Elixir MCP cannot answer, neither can this bot, and it says so.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log } from "./log.js";
import * as state from "./state.js";

const MCP_BETA = "mcp-client-2025-11-20";
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

/**
 * Walks the response content and reports what actually happened with tools.
 * The block type names for connector tool use are matched by suffix rather than
 * exact string so a rename on the API side degrades to "we saw no tool
 * activity" instead of crashing the reply.
 */
function readToolActivity(content) {
  const namesById = new Map();
  const called = [];
  const errors = [];
  // The trace is the ordered story of the turn — what it thought, then what it
  // called, interleaved as it happened. Showing it is a product decision, not a
  // debug affordance: in a channel whose whole purpose is "what is Elixir MCP
  // like", the tool names ARE the demonstration.
  const trace = [];

  for (const block of content) {
    if (typeof block?.type !== "string") continue;
    if (block.type === "thinking") {
      // Empty unless display:"summarized" is set on the request.
      const text = (block.thinking || "").trim();
      if (text) trace.push({ kind: "thought", text });
    } else if (block.type.endsWith("tool_use")) {
      const name = block.name || "unknown";
      if (block.id) namesById.set(block.id, name);
      called.push(name);
      trace.push({ kind: "tool", name, input: block.input });
    } else if (block.type.endsWith("tool_result")) {
      const name = namesById.get(block.tool_use_id) || "unknown";
      if (!block.is_error) continue;
      const detail = JSON.stringify(block.content ?? "").slice(0, 400);
      errors.push({ name, detail });
      trace.push({ kind: "error", name, detail });
    }
  }
  return { called, errors, trace };
}

function readText(content) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * One turn against Elixir MCP. Returns the text, what the tools did, and what
 * it cost. `pause_turn` is resumed rather than treated as an answer — the
 * connector can pause a long tool sequence, and stopping there would truncate
 * the reply mid-investigation.
 */
export async function ask({ system, messages, maxTokens = config.claude.maxTokens }) {
  const history = [...messages];
  const called = [];
  const errors = [];
  const trace = [];
  let usdTotal = 0;
  let text = "";

  for (let round = 0; round < 5; round += 1) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: config.claude.model,
        max_tokens: maxTokens,
        betas: [MCP_BETA],
        system,
        messages: history,
        mcp_servers: mcpServers,
        tools,
        // "omitted" is the default on Sonnet 5 and returns empty thinking
        // blocks. We show our work in-channel, so ask for the summary.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: config.claude.effort },
      });
    } catch (error) {
      log.error("claude_call_failed", { error: error.message });
      return { ok: false, error: error.message, called, errors, trace, usd: usdTotal };
    }

    const usd = costOf(config.claude.model, response.usage);
    usdTotal += usd;
    state.addSpend(usd);

    const activity = readToolActivity(response.content);
    called.push(...activity.called);
    errors.push(...activity.errors);
    trace.push(...activity.trace);
    text = readText(response.content) || text;

    if (response.stop_reason === "refusal") {
      return { ok: false, error: "refusal", called, errors, trace, usd: usdTotal };
    }
    if (response.stop_reason === "pause_turn") {
      history.push({ role: "assistant", content: response.content });
      continue;
    }

    return {
      ok: true,
      text,
      called,
      errors,
      trace,
      usd: usdTotal,
      truncated: response.stop_reason === "max_tokens",
    };
  }

  return { ok: true, text, called, errors, trace, usd: usdTotal, truncated: true };
}

export function overDailyCap() {
  if (!config.dailyUsdCap) return false;
  return state.todaySpend() >= config.dailyUsdCap;
}
