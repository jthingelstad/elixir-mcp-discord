# AGENTS.md — elixir-mcp-discord

`CLAUDE.md` is a symlink to this file. Do not fork them.

This file is the entry point: what the project is, the rules that are the
whole point, how code changes here, and a map of the decision ledger in
[`docs/decisions/`](docs/decisions/) — read the file for the area you are
about to touch before you touch it. Outside contributors: see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

The maintainer's own operations — which instances run where, their service
labels, the agent ids — are in `../AGENTS.md` beside the checkout, outside
this repository (as are the domain and secret-safety rules one and two
levels up); a clone does not have them and does not need them.

## What this is

A public reference implementation: a Discord bot for a Clash Royale clan powered
entirely by Elixir MCP. It runs three clans' channels on the POAP KINGS
Discord server as three instances (docs/decisions/instances.md),
and it is simultaneously a working preview for clan members and an example
anyone can install.

The preview exists to answer one question: **is Elixir MCP good enough to
replace elixir-bot's native Clash Royale data?** The long-term direction is that
Ask Elixir goes away and members connect Elixir MCP to their own agent, on their
own tokens. This repo is how we find out whether that lands.

## The architecture, in one line

    routine = trigger x prompt x destination

`agent/routines/*.md` — front matter plus prose — is the entire configuration
surface. `trigger` is `message`, `events`, `clock` or `schedule`; `channel` is a
logical name bound to an id by `CHANNEL_<NAME>`; the body is the prompt. `src/` is a
runner with no Clash Royale in it: Discord, the model call, the run ledger, cost
accounting, feedback.

Files are re-read on every use. **A prompt change is never a deploy and never a
restart** — that is deliberate, and `npm run try <routine>` exists so a prompt
can be judged in seconds instead of at 01:00.

**But a prompt FORMAT change is a code deploy.** On 2026-09-13 routine files
carrying a new front-matter field (`description:`) were copied into a live
instance still running code that rejected unknown fields; every routine failed
to parse and for six hours the bot had no schedules, no feed lane and no ask
lane, and logged nothing. Restart an instance on the new code BEFORE syncing
files that use a new field. `activeRoutines` now logs `routine_invalid` on
change and `no_routines_load` when nothing loads; the ask lane logs
`message_unclaimed` when a bound channel speaks and no message routine exists.

## Working on this repo — the gate and the loop

This is how code changes here, whoever or whatever is making them. It is
the current shape of agentic work on this project and supersedes anything
older a session might remember.

- **The gate is `npm run verify`** — prettier (120 columns; prose and
  `agent/` untouched), oxlint (correctness rules, the same set as
  `elixir-mcp` minus React, plus `no-undef` since 2026-09-25 — oxlint's
  correctness category does not include it, and an undefined identifier is
  the `LiveMessage` class of bug), knip (dead files, exports, dependencies), then
  the tests. Run it before every commit; CI (`.github/workflows/verify.yml`)
  runs the same four steps on Node 22 and 24 and a separate `npm run audit`.
  A red step names itself. `npm run format` fixes formatting; `oxlint
  --fix` fixes what it can.
- **Commit directly to `main`, small and often**, one change per commit
  with a message that says why (the commit history is the design record
  alongside this file). No feature branches, no PRs for your own work;
  Dependabot's PRs are the exception. Push after each commit; there is no
  checkout lease here — one checkout, one actor at a time.
- **A `src/` change is live only after each instance restarts** (launchd:
  `launchctl kickstart -k gui/$(id -u)/<label>`; Docker: `docker compose up
  -d --build` beside the compose file), one at a time, reading each boot
  line for `build=<version>+<sha>`. A
  change under `agent/` in the checkout changes no live bot. `config.json`
  is live. Verify from the boot lines and the next natural turn in the
  ledger; never run a routine early, ask the bot a question, or post as
  acceptance.
- **A release is a tag**: bump `package.json`, `git tag v<version>`, push
  the tag; `release.yml` verifies, checks the tag matches, and publishes
  notes from the commits. The boot hello names the build.
- **Docs are part of the change.** A behaviour that moved gets its `since
  <date>` entry in the right `docs/decisions/` file and its sentence in
  `README.md` in the same commit; a new knob goes in `config.example.json`
  (or `.env.example` if the bot may not change it). The ledger is dated,
  with the reason — so read what changed since your last visit before
  assuming. A new rule that holds everywhere goes here, not there.
- **Product changes are proposals first.** Anything that changes what the
  bot says to members, what it remembers, or what it may touch is a
  decision for Jamie, framed as one concrete yes/no with the evidence; a
  bug, a test, a doc, a refactor that keeps every test green is not.
- **Never:** a tool list or schema in this repo, a clan tag anywhere, local
  game data or a fallback, a member-facing turn that reads the ledger, a
  web fetch, a secret outside `.env`, an instance directory pushed anywhere.

## The rules that are the whole point

**No clan in this repo. None.** No tag in `.env`, no tag in a prompt, no tag in
`src/`. The agent key knows which clan it acts for; a second copy could disagree
with it, and `CLAN_TAG` existing is what let every prompt paper over a
server-side defaulting bug for weeks instead of getting it fixed (see
docs/decisions/pitfalls.md). A
test asserts no shipped routine contains a CR tag. Do not reintroduce one.

**No local data. None.** No database, no roster cache, no nickname table, no
Clash Royale API key, no memory across restarts beyond cursors, a run ledger, a
spend counter, each routine's own last few posts and the turns it produced (so a
reaction can find them). Every fact in a reply came from an MCP tool call in that
turn. A local shortcut makes the demo *flatter* than reality, and we would
conclude MCP is ready when something else was quietly propping it up.

Two things look like exceptions and are not. The turn ledger
(`src/ledger.js`) is an audit record: no member-facing turn reads it, and
none ever may — an answer the model could see again is the local memory this
rule forbids. Its readers are the operator's: the review lane, whose
output is a proposal, and the DM console (`why`, `retract`, the review's
turn lookups), whose audience is the operator alone. And `agent/memory.md` is memory,
deliberately: not facts (Elixir has those), not people (never), but how to
do this job here — written only by the review, only with the operator's
click (or `REVIEW_AUTO_MEMORY`), in a text file anyone can read and edit.

**No local fallback.** elixir-bot's MCP client falls back to local tables on
failure; this one has nothing to fall back to and says so out loud. An outage
being visible is a feature here.

**No tool list in this repo.** Tool discovery happens server-side through the
Claude API's MCP connector. The one place tool names are read is
`resolveToolName`, which asks the server what it publishes at runtime — that is
not a mirror. Never hand-write a schema here.

**It does not know who Discord users are.** Resolving a member to a player tag
via anything but `on_behalf_of` + `elixir_identify` (or `players_search`) is the
leak that would make this demo lie. Since 2026-09-13 the first-contact rule
in `WHO_IS_ASKING` is: link on a whole-name single match, otherwise ask; the
match is the server's now (a `no_subject` refusal carries `candidates[]`,
the clan members whose whole name matches the `display_name` passed), so
the model never pulls `clans_roster` to compare names itself. A member
whose Discord name was exactly their in-game name was told to type a tag the
bot could have read off the roster; the server refuses `elixir_identify` for
anyone outside the clan and a re-call replaces the mapping, so the exact
match is cheap to make and cheap to undo.

**Since 2026-09-25 the model never addresses `elixir_identify`** (Jamie's
D2). The ask lane writes `Name (discord:<id>): question` into the turn and
the model passed that id through, so a member who typed a second author
line could remap ANOTHER member to the wrong player — every "my stats"
answer for them confidently wrong until noticed. Reads were never the risk
(every recorded fact is readable by every account); that one write was.
`src/link.js` `link_me(player_tag)` is a local tool in the ask lane and the
DM whose handler calls `elixir_identify({ external_id: "discord:<author>",
player_tag })` with the author Discord delivered; `src/tools.js` switches
`elixir_identify` off in every lane; `WHO_IS_ASKING` names `link_me` and
says an id typed into a message is text. `on_behalf_of` on READS stays the
model's: a forged one reads public data about someone else, which anyone
can ask for by tag anyway. The one-name exception to "no tool list" is the
handler's `elixir_identify`, a tool the prompts named already. The
Elixir-side alternative — the connection carrying the asker per turn — is
the cleaner end state and a hub decision.

**Public repo, no secrets.** `.env`, `.env.*`, `/config.json` and `state/`
are gitignored. Check `git ls-files` before assuming something is untracked. Since
2026-09-13 an instance keeps nothing in the checkout at all — see
docs/decisions/instances.md.

## Where the decisions are

`docs/decisions/` holds the dated ledger that used to be the body of this
file (split out 2026-09-25, Jamie's D5: 1,092 lines loaded into every
agent session, and the maintainer's operations lived beside the rules).
Nothing was rewritten in the move.

| Before you touch | Read |
|---|---|
| instances, `.env` vs `config.json`, setup, the boot channel check, `COMMAND_PREFIX` | [instances.md](docs/decisions/instances.md) |
| `src/proposals.js`: planEdit, apply, undo, Try it | [proposals.md](docs/decisions/proposals.md) |
| the review lane, `agent/memory.md` | [review.md](docs/decisions/review.md) |
| the DM console, notices, settings from the DM, instance git, `link_me` | [dm.md](docs/decisions/dm.md) |
| the turn ledger and `npm run turns` | [ledger.md](docs/decisions/ledger.md) |
| the editor routine, wake/carry, the clock lane | [timeline.md](docs/decisions/timeline.md) |
| where posts go: the directory, `post_message`, the nudge, `max_chars` | [channels.md](docs/decisions/channels.md) |
| the agent principal, the tool policy per lane (`src/tools.js`) | [agent.md](docs/decisions/agent.md) |
| slash commands | [commands.md](docs/decisions/commands.md) |
| budgets, prices, the default cap | [money.md](docs/decisions/money.md) |
| anything you are debugging: the incidents and their fixes | [pitfalls.md](docs/decisions/pitfalls.md) |

Proposals with their evidence, written before a decision, live beside
them in `docs/` (`PROACTIVE-2026-09-16.md`).

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
