# AGENTS.md — elixir-mcp-discord

`CLAUDE.md` is a symlink to this file. Do not fork them.

Domain rules are one level up in [`../AGENTS.md`](../AGENTS.md); repo-wide AWS
and secret-safety rules are two levels up in `~/Projects/AGENTS.md`.

## What this is

A public reference implementation: a Discord bot for a Clash Royale clan powered
entirely by Elixir MCP. It runs two channels in POAP KINGS' **Testing** category
(`#ask-elixir-mcp`, `#elixir-mcp`), and it is simultaneously a working preview
for clan members and an example anyone can copy.

The preview exists to answer one question: **is Elixir MCP good enough to
replace elixir-bot's native Clash Royale data?** The long-term direction is that
Ask Elixir goes away and members connect Elixir MCP to their own agent, on their
own tokens. This repo is how we find out whether that lands.

## The rules that are the whole point

**No local data. None.** No database, no roster cache, no nickname table, no
Clash Royale API key, no memory across restarts beyond a cursor and a spend
counter. Every fact in a reply came from an MCP tool call in that turn. This is
not a style preference — a local shortcut makes the demo *flatter* than reality,
and we would conclude MCP is ready when elixir-bot was quietly propping it up.

**No local fallback.** elixir-bot's MCP client falls back to local tables on
failure; this one has nothing to fall back to and says so out loud. An outage
being visible is a feature here.

**No tool list in this repo.** The ask lane uses the Claude API's MCP connector,
so tool discovery happens server-side. Never hand-mirror an MCP tool schema
here. `elixir-bot`'s AGENTS.md sat on "22 tools, contract 0.10" while the server
shipped 36 tools at 0.28 — the mirror is what rots.

**It does not know who Discord users are.** Resolving a member to a player tag
via anything but `players_search` is the leak that would make this demo lie.

**Public repo, no secrets.** `.env` is gitignored, `state/` is gitignored. Check
`git ls-files` before assuming something is untracked.

## It is an AGENT now, not Jamie

Since 2026-09-08 this bot authenticates as its own principal — an Elixir MCP
*agent* (`public_id 272bd891a21d`, role `leader`, owned by Jamie's account) with
its own key, its own event cursor and its own feedback inbox. It connects at its
own door, `https://elixir.poapkings.com/a/272bd891a21d/mcp`, and its key is
refused at the personal `/mcp` with `wrong_resource`.

That closes a real exposure rather than a theoretical one. Riding Jamie's
account, this bot could answer "what players do you track?" with his personal
claimed-player list, and on first boot it read *his* answered feedback as its
own and posted eight items into a public channel. Both are now impossible by
construction: the agent surface publishes 34 tools instead of 37, and
`elixir_my_players`, `elixir_add_player` and `elixir_add_clan` are not merely
hidden but refused on call.

**So do not add them back to a prompt.** If a member asks "how am I doing", the
answer is still to ask for a tag and use `players_search` — that friction is
part of what the channel demonstrates.

**`game_clock` is the right first call** for "what day is it", not a borrowed
clan's river race.

## Feedback is the deliverable

Jamie's framing: *"we really want this agent to give feedback on what it wants
to do but cannot."* `src/feedback.js` is not a nice-to-have; it is the reason
the channels are worth running. Two paths — inline (the agent files as it works)
and a post-turn sweep (a tool errored, or the answer conceded a limit, and the
agent had not filed). Do not "simplify" the sweep away: a graceful failure is
precisely when friction vanishes without a trace.

## Things that will bite you

- **The event cursor is per ACCOUNT, not per token.** `elixir_events` advances
  one `events_seen_through` marker for the whole account, so a second consumer
  on the same account eats the first one's notifications. We poll with
  `mark_seen: false` and keep our own cursor in `state/state.json`. Never flip
  that to `true` as a "simplification".
- **Seed the cursor, don't drain the feed.** First run reads the newest event id
  and starts there. Posting the backlog into Discord on boot is a bad first
  impression and was a known failure class in elixir-bot.
- **The service token is this bot's own**, not elixir-bot's. Calls are audited
  per token on the Admin page; a shared token makes the two consumers
  indistinguishable and couples their revocation.
- **Sonnet 5 has no mid-conversation system messages** and rejects
  `budget_tokens` and sampling params. Thinking is `{type: "adaptive"}`; depth
  is `output_config.effort`.
- **`npm run probe` before debugging anything.** It reports the contract version
  and tool fingerprint and tells you whether the surface moved.

## Voice

Plain. No persona, no lore, no nicknames. Members should be comparing whether
the answers are *right*, not whether they are charming — Elixir's personality
lives in elixir-bot and deliberately does not live here.
