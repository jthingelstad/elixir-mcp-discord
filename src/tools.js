/**
 * WHAT EACH KIND OF TURN MAY DO THROUGH ELIXIR — since 2026-09-25.
 *
 * Every lane used to get the whole toolset, and the filing prompt in every
 * system block says to file "without being asked". So a rehearsal — `npm
 * run try`, the DM's `try`, a proposal's Try it, `npm run review` — could
 * file real feedback with Elixir's maintainer (the first dry-run review did,
 * and a prompt line was the only fence after that), and since hub 7.1.0 an
 * agent door also publishes elixir_track_clan and elixir_track_player,
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

/** The writes each kind of turn keeps. Both names are already in the prompts. */
export const POLICIES = {
  // Reads, and nothing else — upstream included.
  rehearsal: [],
  // Filing what it wanted to do and could not is the job (src/feedback.js).
  routines: ["elixir_send_feedback"],
  // A member's turn files friction. Linking who is asking is link_me
  // (src/link.js), where the runner — not the model — says who that is.
  ask: ["elixir_send_feedback"],
  // The weekly review files what belongs to the hub.
  review: ["elixir_send_feedback"],
  // The operator's console files; it links the operator through link_me too.
  dm: ["elixir_send_feedback"],
};

/**
 * Without annotations nothing here can tell a write from a read. Switching
 * everything off would take every tool from every lane; switching nothing
 * off is today's behaviour. So a live lane keeps everything and says so, and
 * a rehearsal switches off the writes the prompts themselves can drive.
 */
const PROMPTED_WRITES = ["elixir_send_feedback", "elixir_identify"];

let warnedUnannotated = false;

/** The published tool names to switch off for this kind of turn. */
export function disabledTools(policy, catalog) {
  const keep = new Set(POLICIES[policy] ?? POLICIES.rehearsal);
  if (!catalog?.ok) return [];
  if (catalog.annotated) return catalog.tools.filter((t) => !t.readOnly && !keep.has(t.name)).map((t) => t.name);
  if (!warnedUnannotated) {
    warnedUnannotated = true;
    log.warn("tool_annotations_missing", {
      hint: "the server marks no tool readOnlyHint; live lanes keep every tool, rehearsals lose the prompted writes",
    });
  }
  if (policy !== "rehearsal") return [];
  const published = new Set(catalog.tools.map((t) => t.name));
  return PROMPTED_WRITES.filter((name) => published.has(name) && !keep.has(name));
}
