/**
 * A direct MCP client, used for the calls this bot makes on its OWN behalf
 * rather than through the model: polling `elixir_events`, reading
 * `elixir_my_feedback`, and the startup probe.
 *
 * The ask lane does NOT go through here — it uses the Claude API's MCP
 * connector (src/claude.js), which opens its own connection to the same server.
 * That split is deliberate. Deterministic plumbing should not cost a model call,
 * and answering a member's question should not require this file to know
 * anything about the tool surface.
 *
 * Error contract: every helper returns `{ ok: true, body }` or
 * `{ ok: false, error }`. Nothing here throws across the module boundary, so a
 * caller always has to look at the failure. There is no local fallback in this
 * project by design — when Elixir MCP is down, the honest move is to say so.
 */

import { config } from "./config.js";
import { log } from "./log.js";

const TIMEOUT_MS = 20_000;
let nextId = 0;

async function rpc(method, params) {
  const id = ++nextId;
  let response;
  try {
    response = await fetch(config.mcp.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.mcp.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: `transport: ${error.message}` };
  }

  if (!response.ok) {
    return { ok: false, error: `http ${response.status}` };
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch (error) {
    return { ok: false, error: `malformed envelope: ${error.message}` };
  }
  if (envelope.error) {
    return { ok: false, error: `rpc ${envelope.error.code}: ${envelope.error.message}` };
  }
  return { ok: true, body: envelope.result };
}

/** `initialize` — the handshake. serverInfo.version is `<contract>+tools.<fingerprint>`;
 *  it changes whenever the published tool schemas change, which makes it the one
 *  reliable signal that the surface moved under us. */
export async function initialize() {
  const result = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "elixir-mcp-discord", version: "0.1.0" },
  });
  if (!result.ok) return result;
  return { ok: true, body: result.body, version: result.body?.serverInfo?.version || null };
}

export async function listTools() {
  const result = await rpc("tools/list", {});
  if (!result.ok) return result;
  return { ok: true, tools: result.body?.tools || [] };
}

/** One `tools/call`, unwrapped to the tool's parsed JSON body. */
export async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (!result.ok) {
    log.warn("mcp_call_failed", { tool: name, error: result.error });
    return result;
  }

  const text = result.body?.content?.[0]?.text;
  if (typeof text !== "string") {
    return { ok: false, error: "no text content in tool result" };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Not every tool has to answer in JSON; hand back the raw text.
    return { ok: true, body: { text }, isError: Boolean(result.body?.isError) };
  }

  if (result.body?.isError) {
    const message = body?.error?.message || "tool error";
    log.warn("mcp_tool_error", { tool: name, message });
    return { ok: false, error: message, body };
  }
  return { ok: true, body };
}
