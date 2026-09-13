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
description: Midday note on up to three players whose day stood out
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

The **working directory is the instance**: `.env`, `agent/` and `state/` are
read from wherever the process starts, and the checkout is just where the
code is. Running from the checkout works as you would expect; running from
somewhere else is how one checkout serves several clans (see
[Several bots](#several-bots-one-checkout)), and how a public checkout keeps
your agent's voice and your keys out of it.

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

In Discord, an admin (`ADMIN_USER_IDS`) has slash commands: **`/run`** with
autocomplete over your routine names, **`/routines`**, and **`/budget`**. They
are registered to your guild at startup, so they appear immediately — if they
never show up, the bot was invited without the `applications.commands` scope
and the boot log says so.

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

### One thread per question

A question in the ask channel opens a thread named after it, and the answer,
its footer and any follow-ups live there. History is the thread's — the
question that started it and what was said since — never another member's
conversation. A new top-level message is a new conversation. The bot needs
the *Create Public Threads* and *Send Messages in Threads* permissions;
without them it answers in the channel and says so in the log.

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
`/budget` in Discord both show where you are.

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
- **A routine remembers what it posted.** `recall: 3` hands the model that
  routine's last three posts, from its own ledger in `state/`, so a daily
  spotlight can rotate and a movers post does not name the same three players
  every morning. It is the bot's own output, not game data.
- **Failed calls are visible under the post.** When a turn's tool calls
  errored, a one-line footer says which and how many, whether or not the
  routine shows a trace; a reply that states figures without having called a
  tool gets a footer saying so. The footers name the server's `request_id`
  so a screenshot can be joined to the exact call.
- **Maintainer replies are read on the server's hint.** Every Elixir MCP
  response carries `meta.feedback_responses_pending` (contract 1.0.0), so the
  bot reads `elixir_my_feedback` only when a feed poll says there is something
  new — not every tick.
- **Times are yours.** `TIMEZONE` decides what `at: 22:00` means, DST included.
- **Cost.** Roughly $0.03–0.15 per post. The tool surface and the system
  block are cache breakpoints, so a turn that follows another within the
  cache window pays the cache-read rate for most of what it sends; the footer
  shows the share (`cache 89%`), because a cache that quietly stops hitting
  is a cost regression nobody would otherwise see. Every ask carries a footer
  with the tools called and what the turn cost; `npm run routines` shows this month
  against your budgets and per-routine spend today.
- **A missed run fires late only inside its own catch-up window.** A war-deck
  nudge at 4am because the host was asleep is worse than one that never fires.
- **Every channel is checked at boot.** For each channel a routine uses, the
  bot confirms it is in `DISCORD_GUILD_ID` and that its role can see it, post
  in it and read its history — plus create and post in threads for an ask
  channel. Each failure is an `ERROR` line naming the exact permission, and
  the bot says so in the first channel that *does* work, so a pasted id one
  channel off is a complaint at boot rather than a routine that spends a
  model call and posts nothing.
- **Rough edges are expected.** This is a demonstration of a young service, and
  what it cannot do yet is as interesting as what it can.

## Several bots, one checkout

One clan is one instance: one directory with a `.env`, an `agent/` and a
`state/`, started from the checkout's `src/index.js`. Three clans on one
Discord server is three such directories, each with its own Discord
application, its own Elixir MCP agent and its own Claude key, and nothing
shared but the code:

```
~/.elixir-mcp-discord/
  kings/     .env  agent/  state/
  shipit/    .env  agent/  state/
  rookies/   .env  agent/  state/
```

```bash
npm run setup -- ~/.elixir-mcp-discord/kings          # guided; creates the directory
./scripts/instance.sh ~/.elixir-mcp-discord/kings probe
./scripts/instance.sh ~/.elixir-mcp-discord/kings try war-deck-check
./scripts/install-launchd.sh ~/.elixir-mcp-discord/kings
```

`npm run setup` is the whole process for one bot, in order, with every step
tried before anything is written:

1. **Elixir** — the key must open an *agent* door with a clan.
2. **Claude** — the key must return the model you chose, and the model must
   have a price.
3. **Discord** — the token must belong to the application id you gave, with
   the Message Content intent on, in the server you named. Not invited yet?
   It prints the invite link with both scopes and exactly the permission bits
   the lanes need, and waits.
4. **Routines** — a checklist of everything in `agent/routines`, each with
   its one-line `description`. Chosen files are copied into the instance; a
   file already there is **never overwritten** (that rewrite is yours), and
   one chosen off goes to `ROUTINES_DISABLED` rather than being deleted.
5. **Schedule** — your timezone, then each scheduled routine's time, written
   back into the instance's copy.
6. **Channels** — lists the server's text channels, asks which one each
   routine posts to, and checks the bot's effective permissions there
   (including thread permissions for an ask channel), naming what to grant.
7. **Identity** — a sentence or two about this clan, appended to
   `identity.md` under its own heading; after that the file is yours.
8. **Budgets** — an estimate from the routines you chose, then the two pots.
9. **Admins** — each user id checked to be a member of the server.
10. Writes `.env`, prints what runs where and when, and offers to install and
    start the service, showing the boot check's lines from the log.

Every failure comes with its fix and a chance to retry; `skip` moves on.
Re-running keeps every value on Enter, so it is also how you rotate one key,
move one channel, add a routine or change a time. `--check` runs the same
validation with no prompts and writes nothing.

Slash commands are registered per Discord application, so three bots in one
server each bring a `/run` and Discord tells them apart only by avatar. Set
`COMMAND_PREFIX` per instance (`pk`, `si`, …) and they become `/pk-run`,
`/si-run`: an admin cannot run one clan's routine on another by picking the
wrong avatar. Bots ignore each other's messages and reactions; each listens
only on its own `CHANNEL_*` ids, which the boot check verifies are in the
guild and usable.

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

## Running it as a service

**macOS (launchd):**

```bash
./scripts/install-launchd.sh              # this checkout is the instance
./scripts/install-launchd.sh ~/.elixir-mcp-discord/kings   # a named instance
./scripts/install-launchd.sh [instance] uninstall
tail -f ~/Library/Logs/elixir-mcp-discord/com.poapkings.elixir-mcp-discord.log
# a named instance logs to …/com.poapkings.elixir-mcp-discord.<name>.log
```

**Linux (systemd user unit):**

```bash
./scripts/install-systemd.sh              # this checkout is the instance
./scripts/install-systemd.sh ~/.elixir-mcp-discord/kings   # unit elixir-mcp-discord-kings
./scripts/install-systemd.sh [instance] uninstall
journalctl --user -u elixir-mcp-discord -f
loginctl enable-linger $USER              # keep it running after you log out
```

**Docker:**

```bash
docker build -t elixir-mcp-discord .
docker run -d --name elixir-mcp-discord --restart unless-stopped \
  --env-file .env -v "$PWD/state:/app/state" -v "$PWD/agent:/app/agent" \
  elixir-mcp-discord
```

Both service templates are rendered rather than committed, because a unit file
is nothing but absolute paths and yours are not these. Three things in them are
deliberate: `node` is referenced by absolute path (neither launchd nor systemd
reads your shell profile); the working directory is the instance so its
`.env`, `agent/` and `state/` are the ones found; and the restart throttle is 30 seconds so a job that dies on startup
leaves a legible crash loop in the log instead of drowning it. The container
mounts `state/` and `agent/` so cursors and budgets survive a replacement and
a prompt edit needs no rebuild.

## License

MIT.

---

This material is unofficial and is not endorsed by Supercell. For more
information see [Supercell's Fan Content Policy](https://www.supercell.com/fan-content-policy).
