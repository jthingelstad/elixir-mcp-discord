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

/**
 * Who this connection is, as data.
 *
 * Elixir MCP puts a principal block in `_meta` on the initialize result:
 * `{kind: "person"|"agent"|"integration", subject: {...}}`. We asked for it
 * because the alternative was regexing the English in `instructions` — which
 * is written for the model and therefore rewritten often — or inferring the
 * kind from which tools are missing. Both are guesses about a fact the server
 * already knows.
 *
 * It may be absent: an older deployment, or another MCP server entirely. That
 * is not an error, it just means we cannot label the connection.
 */
export const PRINCIPAL_META_KEY = "elixir.poapkings.com/principal";

export function readPrincipal(initializeResult) {
  const block = initializeResult?._meta?.[PRINCIPAL_META_KEY];
  return block && typeof block === "object" ? block : null;
}

/** `initialize` — the handshake. serverInfo.version is `<contract>+tools.<fingerprint>`;
 *  it changes whenever the published tool schemas change, which makes it the one
 *  reliable signal that the surface moved under us. */
export async function initialize() {
  const result = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "elixir-mcp-discord", version: "0.2.0" },
  });
  if (!result.ok) return result;
  return {
    ok: true,
    body: result.body,
    version: result.body?.serverInfo?.version || null,
    principal: readPrincipal(result.body),
    instructions: result.body?.instructions || null,
  };
}

/** A one-line description of the connection, for a log or a probe. */
export function describePrincipal(principal) {
  if (!principal) return "unknown (server published no principal block)";
  const subject = principal.subject;
  if (!subject) return `${principal.kind} with no subject`;
  const name = [subject.name, subject.tag].filter(Boolean).join(" ");
  const size = subject.members ? `, ${subject.members} members` : "";
  return `${principal.kind} acting for ${subject.type} ${name}${size}`;
}

/**
 * Map a name the Claude API handed back to a name this server actually
 * publishes.
 *
 * When the connector asks the CLIENT to run an mcp_toolset tool, the tool
 * arrives renamed: `elixir_feedback` on a server we named `elixir-mcp` came
 * back as `elixir-mcp_feedback`. Stripping the server prefix gives "feedback",
 * which is not a tool, and calling it returns "Unknown tool: feedback" —
 * observed 2026-09-08, and the model reads that as its feedback having failed.
 *
 * Rather than encode a mangling rule that is not ours to depend on, ask the
 * server what it publishes and match. Still no tool inventory in this repo: the
 * list is fetched at runtime and nothing here knows what any tool does. An
 * unresolvable name is returned unchanged, so the failure surfaces as the
 * server's own "unknown tool" rather than as a silent substitution.
 */
let publishedTools = null;

export async function resolveToolName(name, { serverName = config.mcp.serverName, names = null } = {}) {
  if (!name) return name;
  const published = async () => {
    if (publishedTools) return publishedTools;
    const listed = await listTools();
    if (listed.ok) publishedTools = listed.tools.map((tool) => tool.name);
    return publishedTools || [];
  };

  // `names` is injectable so the resolution rules can be tested without a
  // network call; the service always reads them from the server.
  const resolved = names ?? (await published());
  if (resolved.includes(name)) return name;

  const bare = name.startsWith(`${serverName}_`) ? name.slice(serverName.length + 1) : name;
  if (resolved.includes(bare)) return bare;

  // The renamed form dropped the tool's own namespace, so match on the tail.
  // Prefer the shortest match: `elixir_feedback` over `elixir_my_feedback`,
  // which is the tool that was actually asked for.
  const tails = resolved.filter((tool) => tool.endsWith(`_${bare}`)).sort((a, b) => a.length - b.length);
  if (tails.length === 0) {
    log.warn("tool_name_unresolved", { name, bare });
    return bare;
  }
  if (tails.length > 1) {
    log.warn("tool_name_ambiguous", { name, chose: tails[0], others: tails.slice(1).join(",") });
  }
  return tails[0];
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
