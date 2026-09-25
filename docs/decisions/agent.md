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
`elixir_track_player`** (54 tools; an agent may watch a rival, and every
track spends the OWNER's recording slots). The line above used to name
them as absent; it was stale for a week, and in that week any lane — a
member's question included — could have tracked a clan on Jamie's slots.
Since 2026-09-25 `src/tools.js` decides which writes each kind of turn
keeps, from the server's own `readOnlyHint` annotations (`toolCatalog` in
`src/mcp.js`): rehearsals none; routines and the review
`elixir_send_feedback`; the ask lane and the DM that plus
`elixir_identify`. Every other write — tracking, `collections_edit`,
`elixir_nickname`, and any the hub adds later — is switched off through
the connector's per-tool `configs`, and refused again (`not_available`) on
the direct-client path the API sometimes hands back. The first dry-run
review filed a real item with the maintainer; a prompt line was the only
fence until now. `npm run probe` prints the writes each kind of turn keeps;
without annotations (`tool_annotations_missing`) live lanes keep
everything and rehearsals lose the two prompted writes. Belt and braces
for an operator: an agent key's capabilities can be narrowed on its page in
Elixir (untick `recordings:write` and `collections:write`), which the hub
enforces on the next call.

Since contract 0.37.0 the connection describes itself as data:
`initialize._meta["elixir.poapkings.com/principal"]` carries `kind` and
`subject`. `src/mcp.js` reads it, `npm run probe` prints it, and the service
warns at boot if the key is not an agent. Do not go back to regexing the English
in `instructions` — the wording is tuned for the model and changes often.
