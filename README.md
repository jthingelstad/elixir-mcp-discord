# elixir-mcp-discord

[![tests](https://github.com/jthingelstad/elixir-mcp-discord/actions/workflows/test.yml/badge.svg)](https://github.com/jthingelstad/elixir-mcp-discord/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

A Discord bot for a Clash Royale clan, powered **entirely** by
[Elixir MCP](https://elixir.poapkings.com). No local game database, no Clash
Royale API key, no cached roster. Every fact it states came from an MCP tool
call made moments earlier.

**There is no clan in this repository.** Not a tag, not a channel, not a prompt
about anyone's clan in particular. The bot connects as an Elixir MCP *agent*,
which already knows which clan it acts for, and everything it says comes from
files you own. Point it at your own agent key and your own channels and it is
your bot — no fork, no code to edit.

## The whole idea

One unit of behaviour, three ways to trigger it:

```
routine = trigger x prompt x destination
```

| Trigger | Fires when | Example |
|---|---|---|
| `message` | somebody speaks in the routine's channel | an ask-anything channel |
| `events` | Elixir MCP's feed carries a topic it watches | joins, leaves, war days, the daily clan pulse |
| `schedule` | a clock, in your timezone | a war-deck nudge at 01:00, a meta report on Sundays |

A routine is one markdown file:

```markdown
---
trigger: schedule
channel: pulse
at: 12:30
catch_up_hours: 4
may_skip: true
recall: 3
---
Look at the last 24 hours for your clan. Name AT MOST three players whose day
stood out, one line each, leading with the number that makes it interesting.
If nothing genuinely stood out, reply with exactly SKIP.
```

Drop that in `agent/routines/`, and it runs. Delete it and it stops. The code
is a runner: it holds the Discord connection, the model call, the run ledger,
the cost accounting and the feedback plumbing, and it holds no opinions about
Clash Royale at all.

## Layout

```
agent/                 <- yours
  identity.md            voice and house rules, prepended to every prompt
  models.json            what each model costs, so budgets can be enforced
  routines/*.md          one file per routine
src/                   <- the runner
state/state.json       cursors, run ledger, spend. Not game data.
```

Set `AGENT_DIR` to keep `agent/` somewhere private if your checkout is public.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
npm run probe             # verify the key, the surface, the feed
npm run routines          # what will run, and where
npm start
```

You need an **agent** key: Elixir MCP > Account > Agents > Create agent. It has
its own URL (`/a/<id>/mcp`), its own event feed and its own feedback inbox, and
its "me" is the clan rather than a person. A personal key works at a different
door and would answer as *you* — `npm run probe` says which one you have, and
the service logs a warning at boot if it is not an agent.

## Iterating on prompts

This is the part that matters, because the prompts are the product:

```bash
npm run try notable-movers                  # run it now, print it, post nothing
npm run try meta-report -- --show-prompt    # also print the assembled prompt
npm run try clan-feed -- --post             # actually post it
```

A dry run makes a real model call and shows you the answer, the tools it
called, the shapes they returned and what it cost — without waiting for 12:30
and without touching the channel. Files are re-read on every run, so editing a
prompt needs no restart and no deploy.

In Discord, an admin (`ADMIN_USER_IDS`) can also `!run <routine>` and
`!routines`.

## How it works

```
Discord ──▶ ask ─────▶ Claude (MCP connector) ═══▶ Elixir MCP
                                                        │
Discord ◀── runner ◀── Claude ◀── events.js ────────────┘
                                  elixir_events
```

**Answers use the Claude API's MCP connector.** We hand the API the server URL
and the key; Anthropic opens the MCP connection server-side and runs the tool
loop. There is no tool list in this repository — not a schema, not a name, not
a switch statement. Elixir MCP publishes `serverInfo.version` as
`<contract>+tools.<fingerprint>` precisely because MCP clients cache
`tools/list` forever, and a hand-written mirror goes stale in silence. The
connector re-reads the surface itself.

**Polling uses a direct MCP client** (`src/mcp.js`, about 150 lines of JSON-RPC
over `fetch`). Reading an event feed is plumbing, and plumbing should not cost
a model call. The model is only involved once there is something to write
about.

### No fallback, on purpose

If Elixir MCP is down, this bot says so and stops. It has nothing else to
consult. That makes it an honest instrument: when an answer is good, the MCP
server earned it.

### It does not know who you are

A member connecting their own agent has added their own player, so their agent
knows them. This one has no such link and does not fake one with a local
nickname table: it passes `on_behalf_of` with the Discord id, and the first
time somebody is not recognised it asks which player they are and calls
`elixir_identify` once. From then on the server remembers — for them, and for
everyone who asks later.

### Feedback is a feature, not an afterthought

The most valuable output of a channel like this is not the answers. It is the
record of what the agent *wanted* to do and could not.

`elixir_feedback` is a first-class door for exactly that, and every routine —
not just the ask lane — files through it two ways: inline, while the agent
still has the context that made the gap obvious, and via a post-turn sweep when
a tool errored or an answer conceded a limit and nothing was filed. Maintainer
replies are posted back into the channel. Members watching their complaint get
answered is the point.

### Silence is a valid output

Any routine with `may_skip: true` may answer `SKIP`, which posts nothing and
still marks the run done. A channel that manufactures content on a quiet day
teaches people to mute it. Routines that may *not* skip post what they said, so
a prompt bug is visible rather than looking like a quiet week.

## Budgets

Two monthly pots, because two different people spend them:

```
MONTHLY_BUDGET_USD=20.00       # what the bot does on its own
ASK_MONTHLY_BUDGET_USD=10.00   # what clan members ask for
```

The split is the point. Scheduled posts and event briefs cost what your
routines cost — predictable, and your decision. The ask channel costs whatever
the clan feels like asking, which is nobody's decision in advance. On one
shared pot a chatty afternoon silently cancels tomorrow's war-deck nudge, and
the only symptom is silence.

**They are strict.** The check runs before the call, not after: a lane refuses
to start a turn that could take it past the line, using the largest turn that
lane has ever produced as the estimate (floored by `TURN_RESERVE_USD`). So the
bot stops slightly short of your number rather than slightly past it. A lane
that runs out says so — in the log for routines, and in the channel for asks,
in a sentence aimed at a member rather than an operator.

Months are UTC calendar months and nothing rolls over. `npm run routines` and
`!budget` in Discord both show where you are.

## Choosing a model

`CLAUDE_MODEL` is yours, and any routine can override it in its own front
matter — a war-deck nudge that reads one field does not need what a weekly meta
report needs:

```markdown
---
trigger: schedule
model: claude-haiku-4-5
effort: low
max_tokens: 2000
---
```

Whatever you choose must have a price in `agent/models.json` (which extends the
catalog in `src/pricing.js`). That file is operator-owned for the same reason
the prompts are: prices change, and the person paying the bill should be able
to correct one without a deploy. **An unpriced model stops the bot at boot**
rather than being billed at zero — budgets you cannot enforce are worse than no
budgets, because they look like they work.

## Operating notes

- **Cursors are per routine, and local.** `elixir_events` advances one
  `events_seen_through` marker per *account*, so two consumers on one account
  eat each other's notifications. Every routine polls with `mark_seen: false`
  and keeps its own position. On first run each seeds from the newest event
  rather than draining the backlog into your channel.
- **Times are yours.** `TIMEZONE` decides what `at: 22:00` means, DST included.
- **Cost.** Roughly $0.05–0.20 per post. Every ask carries a footer with the
  tools called and what the turn cost; `npm run routines` shows this month
  against your budgets and per-routine spend today.
- **A missed run fires late only inside its own catch-up window.** A war-deck
  nudge at 4am because the host was asleep is worse than one that never fires.
- **Rough edges are expected.** This is a demonstration of a young service, and
  what it cannot do yet is as interesting as what it can.

## Tests

```bash
npm test
```

No network, no spend: the model call and Discord are both injectable. They
cover routine parsing (every mistake a hand-edited file can make), the schedule
arithmetic including a DST boundary, the runner's post/skip/split behaviour,
prompt assembly, and the ask path end to end. That last one exists because a
refactor once deleted `LiveMessage` and every static check passed — a missing
symbol is a runtime `ReferenceError`, and members found out instead.

## Running it as a service (macOS)

```bash
./scripts/install-launchd.sh              # install + start at login
./scripts/install-launchd.sh uninstall    # stop + remove
tail -f ~/Library/Logs/elixir-mcp-discord/com.poapkings.elixir-mcp-discord.log
```

The repo ships a template rather than a plist, because a plist is nothing but
absolute paths and yours are not these. Three things in it are deliberate:
`node` is referenced by absolute path (launchd never reads your shell profile);
`PATH` is set explicitly (launchd hands a job a minimal environment); and
`ThrottleInterval` is 30 so a job that dies on startup leaves a legible crash
loop in the log instead of drowning it.

## License

MIT.

---

This material is unofficial and is not endorsed by Supercell. For more
information see [Supercell's Fan Content Policy](https://www.supercell.com/fan-content-policy).
