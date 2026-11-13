/**
 * WHAT EACH KIND OF TURN MAY DO THROUGH ELIXIR — since 2026-09-25.
 *
 * Every lane used to get the whole toolset, and the filing prompt in every
 * system block says to file "without being asked". So a rehearsal — `npm
 * run try`, the DM's `try`, a proposal's Try it, `npm run review` — could
 * file real feedback with Elixir's maintainer (the first dry-run review did,
 * and a prompt line was the only fence after that), and since hub 7.1.0 an
 * agent door also publishes elixir_follow_clan and elixir_follow_player
 * (elixir_track_* until hub 12.0.0),
 * which spend the owner's recording slots: a member's question could steer
 * the ask lane into tracking a clan.
 *
 * The server says which tools only read (MCP `annotations.readOnlyHint`,
 * read from tools/list at runtime — src/mcp.js `toolCatalog`), so what
 * lives here is not a tool list but a decision: which WRITES each kind of
 * turn keeps. Everything else that writes is switched off for it through
 * the connector's per-tool `configs`. A new write tool on the server is off
 * everywhere until someone decides otherwise here.
 */

import { log } from "./log.js";
import { POLICY_CONTEXT_TOOL } from "./eligibility.js";

/** The writes each kind of turn keeps. Both names are already in the prompts. */
export const POLICIES = {
  // Reads, and nothing else — upstream included.
  rehearsal: [],
  // Filing what it wanted to do and could not is the job (src/feedback.js).
  routines: ["elixir_send_feedback"],
  // A member's turn files friction. Who is asking is the hub's to resolve,
  // through the member's connected Discord.
  ask: ["elixir_send_feedback"],
  // The weekly review files what belongs to the hub.
  review: ["elixir_send_feedback"],
  // The operator's console files.
  dm: ["elixir_send_feedback"],
};

/**
 * Without annotations nothing here can tell a write from a read. Switching
 * everything off would take every tool from every lane; switching nothing
 * off is today's behaviour. So a live lane keeps everything and says so, and
 * a rehearsal switches off the writes the prompts themselves can drive.
 */
const PROMPTED_WRITES = ["elixir_send_feedback"];

let warnedUnannotated = false;

/**
 * The eligibility read is runner plumbing (src/eligibility.js), never a
 * model-facing read (since hub 12.0.0 it is clans_directory; before, the
 * private clans_context), so it is off in every lane WHATEVER the catalog says
 * (since 2026-10-10). It used to be named only when the catalog listed it:
 * a failed tools/list, or an hour-old catalog taken before the hub
 * published it, left it on for every model lane while the connector
 * discovered it on its own. The connector accepts a `configs` name the
 * server does not publish (a warning on its side, never an error), and the
 * direct-client path refuses by the same name.
 */
const ALWAYS_OFF = [POLICY_CONTEXT_TOOL];

/** The tool names to switch off for this kind of turn. */
export function disabledTools(policy, catalog) {
  const keep = new Set(POLICIES[policy] ?? POLICIES.rehearsal);
  if (!catalog?.ok) return [...ALWAYS_OFF];
  if (catalog.annotated)
    return [
      ...ALWAYS_OFF,
      ...catalog.tools
        .filter((t) => !ALWAYS_OFF.includes(t.name) && !t.readOnly && !keep.has(t.name))
        .map((t) => t.name),
    ];
  if (!warnedUnannotated) {
    warnedUnannotated = true;
    log.warn("tool_annotations_missing", {
      hint: "the server marks no tool readOnlyHint; live lanes keep every tool, rehearsals lose the prompted writes",
    });
  }
  const published = new Set(catalog.tools.map((t) => t.name));
  if (policy !== "rehearsal") return [...ALWAYS_OFF];
  return [...ALWAYS_OFF, ...PROMPTED_WRITES.filter((name) => published.has(name) && !keep.has(name))];
}
