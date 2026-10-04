# It is an AGENT, not Jamie

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/mcp.js, src/tools.js, src/link.js.*

Since 2026-09-08 this bot authenticates as its own principal — an Elixir MCP
*agent* (owned by the operator's account) with its own key,
its own event cursor and its own feedback inbox, at its own door
`/a/<public_id>/mcp`. Its key is refused at the personal `/mcp`.

Riding Jamie's account, this bot could answer "what players do you track?" with
his personal claimed-player list, and on first boot it posted eight of his
answered feedback items into a public channel. `elixir_my_players` is
still absent from an agent door *and* refused on call. **So do not add it
to a prompt.**

**Since hub 7.1.0 an agent door publishes `elixir_track_clan` and
`elixir_track_player`** (an agent may watch a rival, and every
track spends the OWNER's recording slots). The line above used to name
them as absent; it was stale for a week, and in that week any lane — a
member's question included — could have tracked a clan on Jamie's slots.
Since 2026-09-25 `src/tools.js` decides which writes each kind of turn
keeps, from the server's own `readOnlyHint` annotations (`toolCatalog` in
`src/mcp.js`): rehearsals none; routines, the review, the ask lane and
the DM `elixir_send_feedback` (since D2, 2026-09-25, `elixir_identify` is
off in every lane: `link_me`'s handler calls it; since 2026-09-26 it is
switched off by name even when the server annotates nothing). Every other write — tracking,
`elixir_nickname`, and any the hub adds later — is switched off through
the connector's per-tool `configs`, and refused again (`not_available`) on
the direct-client path the API sometimes hands back. The first dry-run
review filed a real item with the maintainer; a prompt line was the only
fence until now. `npm run probe` prints the writes each kind of turn keeps;
without annotations (`tool_annotations_missing`) live lanes keep
everything and rehearsals lose the two prompted writes. Belt and braces
for an operator: an agent key's capabilities can be narrowed on its page in
Elixir (untick `recordings:write`), which the hub
enforces on the next call.

Since contract 0.37.0 the connection describes itself as data:
`initialize._meta["elixir.poapkings.com/principal"]` carries `kind` and
`subject`. `src/mcp.js` reads it, `npm run probe` prints it, and the service
warns at boot if the key is not an agent. Do not go back to regexing the English
in `instructions` — the wording is tuned for the model and changes often.

## 2026-10-02: Elixir is a recorder

Jamie retired global leaderboards, game-wide meta statistics, named Collections
and gameplay/upgrade recommendation tools. The runner still discovers the live
tool registry; the shared prompt, deck-link description and reference ask prompt
stop directing it toward those capabilities. The default meta-report routine
is removed. Historical ledger evidence and the old shipped-memory-example
filter remain; the latter prevents old installation text entering a new turn.
No member-facing test post or early routine is an acceptance step.

## Ask keeps factual records separate from recommendations — since 2026-10-04

Jamie explicitly excluded deck construction, card substitutions/upgrades,
counters and meta advice from Ask, including advice disguised as personal
battle analysis. The brief gives a friendly scope explanation, answers only
the factual part of mixed requests, and permits descriptions of the decks,
cards and results actually recorded without recommending what to play.
Tool availability or a disclaimer does not relax the boundary.

The retired elixir-bot is historical evidence, not a fallback: its July 11
tool review documented counter advice without opponent-deck capture and
upgrade advice obscured by incomplete card coverage. That is an example of
the failure Jamie wants to avoid, not a reason to restore those tools.
This decision is in the task prompt, and live Ask channels remain whichever
ones the operator has enabled; syncing the brief never re-enables a routine.

## Assigned-agent Policy context — since 2026-10-04

Jamie approved only a narrow private intent read for the existing assigned
bots in [core issue 283](https://github.com/jthingelstad/elixir-mcp/issues/283).
The core owns authorization: explicit agent/owner/clan grants and current
ownership, assignment and verified membership checks on every request.
This consumer selects no clan, creates no grants and changes no credentials.
It requires the initialize principal to be an assigned clan agent and the
response to match that subject.
The runner calls `clans_context` with empty arguments and reads only its
`context` projection. That private tool is disabled in every model lane on
both the connector and direct-client paths, regardless of read annotations.

The core's versioned eight-field context is the complete allowed response:
schema version, clan, known/unknown status and reason, explicit war intent,
policy version, save provenance and read time. Extra private fields or an
incoherent response fail closed. A newer version replaces permission; a
regressing version or different intent at the same version is refused.
Missing/legacy intent stays unknown: scoring, minimums, awards and clan size
never substitute for intent. No local database, browser-session read or
public-fact fallback supplies private context. The tiny cache is confined to
the current plan/process; no context is persisted, shown to the model or
included in a member-facing turn. Fixture data is the core's public synthetic
contract evidence, not an instance's policy.
