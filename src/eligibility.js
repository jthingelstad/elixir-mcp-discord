/**
 * Private policy context is permission for a dependent routine, never a
 * fallback fact source or model input. A failed refresh discards permission.
 * Schema ownership stays in Elixir MCP; this consumer checks the small result
 * it uses, without carrying a tool declaration or selecting a clan in a call.
 */
import { callTool } from "./mcp.js";
import { log } from "./log.js";
import { notify } from "./notify.js";
import * as state from "./state.js";

export const CONTEXT_MAX_AGE_MS = 60_000;
// Core issue 283 transport; no caller-supplied clan or private context input.
export const POLICY_CONTEXT_TOOL = "clans_context";
const FUTURE_SKEW_MS = 5_000;
const KEYS = [
  "schema_version",
  "clan_tag",
  "status",
  "reason",
  "war_intent",
  "policy_version",
  "policy_saved_at",
  "read_at",
];

const instant = (value) =>
  typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

function coherent(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return false;
  if (Object.keys(context).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(context, key))) return false;
  if (context.schema_version !== 1 || !instant(context.read_at)) return false;
  if (context.policy_saved_at !== null && !instant(context.policy_saved_at)) return false;
  const version = Number.isSafeInteger(context.policy_version) && context.policy_version >= 1;
  if (context.status === "known")
    return version && context.reason === null && ["participating", "not_participating"].includes(context.war_intent);
  if (context.status !== "unknown" || context.war_intent !== "unknown") return false;
  return context.reason === "no_policy"
    ? context.policy_version === null && context.policy_saved_at === null
    : context.reason === "war_intent_unspecified" && version;
}

/** Every refresh is an authenticated current read. No cached allow on error. */
export function createPolicyGate({
  read = async () => {
    const result = await callTool(POLICY_CONTEXT_TOOL, {});
    return { ...result, body: result.body?.context };
  },
  principal = () => state.get("principal"),
  now = Date.now,
  notice = notify,
} = {}) {
  let cached = null;
  let sequence = 0;
  let revision = null;

  const inspect = (context) => {
    const bound = principal();
    if (bound?.kind !== "agent" || bound.subject?.type !== "clan" || !bound.subject?.tag)
      return { disposition: "defer", reason: "assigned_agent_required" };
    if (!coherent(context)) return { disposition: "defer", reason: "invalid_context" };
    if (context.clan_tag !== bound.subject.tag) return { disposition: "defer", reason: "wrong_clan" };
    const age = now() - Date.parse(context.read_at);
    if (age < -FUTURE_SKEW_MS) return { disposition: "defer", reason: "context_from_future" };
    if (age > CONTEXT_MAX_AGE_MS) return { disposition: "defer", reason: "context_stale" };
    return { disposition: "ready", context };
  };

  const refresh = async () => {
    const request = ++sequence;
    cached = null;
    let result;
    try {
      result = await read();
    } catch {
      result = { ok: false };
    }
    if (request !== sequence) return { disposition: "defer", reason: "context_superseded" };
    // isError is checked too: a transport succeeding is not a successful read.
    if (!result?.ok || result.isError) return { disposition: "defer", reason: "context_unavailable" };
    const checked = inspect(result.body);
    if (checked.disposition !== "ready") return checked;
    const context = checked.context;
    const signature = JSON.stringify([context.status, context.reason, context.war_intent, context.policy_saved_at]);
    if (context.policy_version !== null && revision?.clan === context.clan_tag) {
      if (context.policy_version < revision.version)
        return { disposition: "defer", reason: "context_revision_regressed" };
      if (context.policy_version === revision.version && signature !== revision.signature)
        return { disposition: "defer", reason: "context_revision_inconsistent" };
    }
    if (context.policy_version !== null)
      revision = { clan: context.clan_tag, version: context.policy_version, signature };
    cached = context;
    return checked;
  };

  const check = async (routine, { fresh = true } = {}) => {
    if (!routine.requires) return { disposition: "allow" };
    const checked = fresh ? await refresh() : inspect(cached);
    if (checked.disposition !== "ready") return checked;
    const context = checked.context;
    if (context.status !== "known") return { disposition: "defer", reason: context.reason };
    const { field, value } = routine.requires;
    if (!Object.hasOwn(context, field)) return { disposition: "defer", reason: "requirement_unavailable" };
    return String(context[field]) === value
      ? { disposition: "allow" }
      : { disposition: "suppress", reason: "intent_mismatch" };
  };

  const report = async (routine, decision, stage) => {
    if (decision.disposition === "allow") return;
    log.info("routine_ineligible", {
      routine: routine.key,
      stage,
      disposition: decision.disposition,
      reason: decision.reason,
    });
    if (decision.disposition === "defer")
      await notice(
        "policy context",
        `${routine.key} deferred (${decision.reason}); no model call or scheduled run consumed. Only this dependent routine is held.`,
        { fingerprint: `policy:${routine.key}:${decision.reason}` },
      );
  };
  return { check, report };
}

export const policyGate = createPolicyGate();

/** The same refusal shape for clock delivery and an operator's dry run. */
export function eligibilityRefusal(decision) {
  return {
    ok: false,
    error: `eligibility:${decision.reason}`,
    deferred: decision.disposition === "defer",
    suppressed: decision.disposition === "suppress",
  };
}
