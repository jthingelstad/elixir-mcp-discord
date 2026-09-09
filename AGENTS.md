# AGENTS.md — elixir-mcp-discord

`CLAUDE.md` is a symlink to this file. Do not fork them.

Domain rules are one level up in [`../AGENTS.md`](../AGENTS.md); repo-wide AWS
and secret-safety rules are two levels up in `~/Projects/AGENTS.md`.

## What this is

A public reference implementation: a Discord bot for a Clash Royale clan powered
entirely by Elixir MCP. It runs POAP KINGS' **Testing** channels
(`#ask-elixir-mcp`, `#elixir-mcp`), and it is simultaneously a working preview
for clan members and an example anyone can install.

The preview exists to answer one question: **is Elixir MCP good enough to
replace elixir-bot's native Clash Royale data?** The long-term direction is that
Ask Elixir goes away and members connect Elixir MCP to their own agent, on their
own tokens. This repo is how we find out whether that lands.

## The architecture, in one line

    routine = trigger x prompt x destination

`agent/routines/*.md` — front matter plus prose — is the entire configuration
surface. `trigger` is `message`, `events` or `schedule`; `channel` is a logical
name bound to an id by `CHANNEL_<NAME>`; the body is the prompt. `src/` is a
runner with no Clash Royale in it: Discord, the model call, the run ledger, cost
accounting, feedback.

Files are re-read on every use. **A prompt change is never a deploy and never a
restart** — that is deliberate, and `npm run try <routine>` exists so a prompt
can be judged in seconds instead of at 01:00.

## The rules that are the whole point

**No clan in this repo. None.** No tag in `.env`, no tag in a prompt, no tag in
`src/`. The agent key knows which clan it acts for; a second copy could disagree
with it, and `CLAN_TAG` existing is what let every prompt paper over the fact
that omitting `clan_tag` does not actually work yet (see below). A test asserts
no shipped routine contains a CR tag. Do not reintroduce one.

**No local data. None.** No database, no roster cache, no nickname table, no
Clash Royale API key, no memory across restarts beyond cursors, a run ledger and
a spend counter. Every fact in a reply came from an MCP tool call in that turn. A
local shortcut makes the demo *flatter* than reality, and we would conclude MCP
is ready when something else was quietly propping it up.

**No local fallback.** elixir-bot's MCP client falls back to local tables on
failure; this one has nothing to fall back to and says so out loud. An outage
being visible is a feature here.

**No tool list in this repo.** Tool discovery happens server-side through the
Claude API's MCP connector. The one place tool names are read is
`resolveToolName`, which asks the server what it publishes at runtime — that is
not a mirror. Never hand-write a schema here.

**It does not know who Discord users are.** Resolving a member to a player tag
via anything but `on_behalf_of` + `elixir_identify` (or `players_search`) is the
leak that would make this demo lie.

**Public repo, no secrets.** `.env` and `.env.*` are gitignored, `state/` is
gitignored. Check `git ls-files` before assuming something is untracked.

## It is an AGENT, not Jamie

Since 2026-09-08 this bot authenticates as its own principal — an Elixir MCP
*agent* (`public_id 272bd891a21d`, owned by Jamie's account) with its own key,
its own event cursor and its own feedback inbox, at its own door
`/a/272bd891a21d/mcp`. Its key is refused at the personal `/mcp`.

Riding Jamie's account, this bot could answer "what players do you track?" with
his personal claimed-player list, and on first boot it posted eight of his
answered feedback items into a public channel. Both are impossible by
construction now: the agent surface publishes 36 tools, and
`elixir_my_players`, `elixir_add_player` and `elixir_add_clan` are absent *and*
refused on call. **So do not add them to a prompt.**

Since contract 0.37.0 the connection describes itself as data:
`initialize._meta["elixir.poapkings.com/principal"]` carries `kind` and
`subject`. `src/mcp.js` reads it, `npm run probe` prints it, and the service
warns at boot if the key is not an agent. Do not go back to regexing the English
in `instructions` — the wording is tuned for the model and changes often.

## Slash commands, not a bang prefix

`/budget`, `/routines`, `/run` (autocompleting over routine keys), registered
per guild at startup so they appear instantly. They replaced `!run` / `!routines`,
which needed MessageContent on every message on the off-chance one began with
a bang, could not be permission-gated by Discord, listed nothing, described
nothing, and made a typo indistinguishable from chat.

Admin-gated twice on purpose: `setDefaultMemberPermissions` hides them in the
picker (a hint a server can override) and `ADMIN_USER_IDS` actually enforces it
(the rule). `/run` defers its reply — a turn is a model call and Discord wants
an answer within three seconds.

If the commands never appear, the bot was invited without the
`applications.commands` scope; registration logs that with the fix.

## Money is configuration, not code

Two monthly pots, split by who spends them: `MONTHLY_BUDGET_USD` for what the
bot decides to do (schedules, event briefs) and `ASK_MONTHLY_BUDGET_USD` for
what clan members ask for. One pot would let a chatty afternoon cancel the
01:00 war-deck post, with silence as the only symptom.

**Strict means checked BEFORE the call.** A lane refuses to start a turn that
could take it past its budget, estimating from the largest turn that lane has
ever produced (floored by `TURN_RESERVE_USD`, which climbs and never drops).
Checking `spent >= budget` afterwards guarantees an overshoot of one turn a
month, and a big turn overshoots a lot. Do not "simplify" that to a post-hoc
check.

The scheduler declines BEFORE marking the run ledger, so a routine skipped for
budget is not recorded as done and runs again next month rather than having
silently missed its window.

**The model is the operator's and so is its price.** `CLAUDE_MODEL` plus
per-routine `model` / `effort` / `max_tokens`, priced from `agent/models.json`
over the catalog in `src/pricing.js`. An unpriced model throws at boot and on
call: the old hardcoded table returned $0 for anything it did not know, which
turned every budget into a number that could not be reached. A budget that
cannot be enforced is worse than none, because it looks like it works.

## Things that will bite you

- **Omitting `clan_tag` does not default yet.** Observed 2026-09-08 on contract
  0.37.0: `war_current {}` and `clans_roster {}` both return
  `not_entitled: No recorded clan membership on this account` on a connection
  whose own principal block reports 48 members of POAP KINGS. Docs and the
  server's own instructions say otherwise. `subjectBlock()` in `src/prompt.js`
  names the tag from the *server's* principal block and tells the model to pass
  it explicitly when a tool claims not to know — config-free, and it disappears
  when the server-side default lands. **Filed upstream; fix belongs in
  elixir-mcp, not here.**
- **A turn can end with a CLIENT-side `tool_use` on an all-server-side
  connection.** With an `mcp_toolset`, most calls come home as
  `mcp_tool_use`/`mcp_tool_result` in one response — but sometimes the API
  returns an ordinary `tool_use` named `<server>_<tool>` and `stop_reason:
  "tool_use"`, asking the client to run it. Unhandled, the response has no text,
  and the runner read that as SKIP: a turn that did all its work and posted
  nothing. `src/claude.js` executes those over the direct MCP client and
  continues. Echoing the assistant turn back *without* results is a 400.
- **The renamed tool does not un-rename by prefix strip.** `elixir_feedback`
  came back as `elixir-mcp_feedback`; stripping the server name gives
  `feedback`, which is not a tool. `resolveToolName` matches against the live
  `tools/list`.
- **The event cursor is per ACCOUNT, not per key.** `elixir_events` advances one
  `events_seen_through` marker for the whole account. Every event routine polls
  with `mark_seen: false` and keeps its own cursor in `state/state.json`. Never
  flip that to `true` as a "simplification".
- **Seed, don't drain.** First run reads the newest event id and starts there;
  the scheduler marks every routine's current period as done; the feedback
  ledger marks history as shown. All three have posted a backlog into a channel
  at least once. Do not "helpfully" replay.
- **Sonnet 5 has no mid-conversation system messages** and rejects
  `budget_tokens` and sampling params. Thinking is `{type: "adaptive"}`; depth
  is `output_config.effort`.
- **A shell variable outranks `.env`.** dotenv does not override `process.env`,
  and an exported `CLAUDE_EFFORT=high` ran this bot at high effort for an
  evening. The service logs provenance at boot and the CLI prints a warning.
- **`npm run probe` before debugging anything.** It reports the principal, the
  contract version and the tool fingerprint, and tells you whether the surface
  moved. It must only call tools an agent surface publishes — it used to check
  auth with `elixir_my_players`, which an agent door *refuses*, so a healthy key
  failed its own probe.

## Feedback is the deliverable

Jamie's framing: *"we really want this agent to give feedback on what it wants
to do but cannot."* `src/feedback.js` is not a nice-to-have; it is the reason
the channels are worth running. Two paths — inline (the agent files as it works)
and a post-turn sweep (a tool errored, or the answer conceded a limit, and the
agent had not filed). Both now run for **every** routine, not just the ask lane:
a scheduled report that could not get what it needed is the most useful thing
this bot produces, and it used to evaporate because nobody was in the channel.

Do not "simplify" the sweep away: a graceful failure is precisely when friction
vanishes without a trace.

## Voice

Plain. No persona, no lore, no nicknames. Members should be comparing whether
the answers are *right*, not whether they are charming — Elixir's personality
lives in elixir-bot and deliberately does not live here.

The voice is not in the source, though: it is `agent/identity.md`, which an
operator is meant to rewrite. Keep code-level prompt blocks to mechanics
(grounding, Discord formatting, the skip protocol, who is asking) and leave
opinions to that file.
