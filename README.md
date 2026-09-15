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

## Quick start

```bash
git clone https://github.com/jthingelstad/elixir-mcp-discord && cd elixir-mcp-discord
npm install
npm run setup -- ~/.elixir-mcp-discord/myclan     # guided: keys, Discord app, channels; then DM the bot
```

That is the whole install. Setup asks for each thing, tries it against the
service it is for before writing anything, and at the end offers to start the
bot as a service. You need three things in hand: an **Elixir MCP agent key**
(elixir.poapkings.com > Account > Agents > Create agent), a **Claude API
key** (console.anthropic.com), and a **Discord application** with a bot token
(discord.com/developers). Setup explains the rest as it goes, including the
invite link.

## The whole idea

One unit of behaviour, three ways to trigger it:

```
routine = trigger x prompt x destination
```

| Trigger | Fires when | Example |
|---|---|---|
| `message` | somebody speaks in the routine's channel | an ask-anything channel |
| `events` | Elixir MCP's timeline carries an item of a kind it names | joins, departures, returns, a resolved war week |
| `schedule` | a clock, in your timezone | a war-deck nudge at 01:00, a meta report on Sundays |

A routine is one markdown file:

```markdown
---
description: Midday note on up to three players whose day stood out
trigger: schedule
at: 12:30
catch_up_hours: 4
may_skip: true
recall: 3
---
Look at the last 24 hours for your clan. Name AT MOST three players whose day
stood out, one line each, leading with the number that makes it interesting.
If nothing genuinely stood out, reply with exactly SKIP.
```

Drop that in your instance's `agent/routines/`, and it runs. Delete it and it
stops. Notice it names no channel: the bot posts **where it decides the post
belongs**, choosing among the channels you have let it into (see
[Channels](#channels-where-it-posts)). The code is a runner: it holds the Discord connection, the model call, the run ledger,
the cost accounting and the feedback plumbing, and it holds no opinions about
Clash Royale at all.

## Layout

```
elixir-mcp-discord/          <- the code (this checkout)
  src/                          the runner: Discord, the model call, the ledger, feedback
  agent/                        the EXAMPLE prompts that setup offers you
  scripts/                      service installers

~/.elixir-mcp-discord/myclan/  <- an INSTANCE (yours; setup creates it)
  .env                          keys, ids, budgets — wiring only
  agent/
    identity.md                 voice and house rules, prepended to every prompt
    models.json                 what each model costs, so budgets can be enforced
    routines/*.md               one file per routine, chosen and then rewritten by you
  state/state.json              cursors, run ledger, spend. Not game data.
```

The **instance is a directory** and the checkout is only where the code is.
Every command reads the instance from the working directory or from
`INSTANCE_DIR`; the boot log's first lines say which `.env`, `agent/` and
`state/` a process actually read. Keeping the instance outside the checkout
is what keeps your keys and your agent's voice out of a public repository,
and it is what lets one checkout run several clans.

## Setup

`npm run setup -- <instance-dir>` wires one bot — keys, the Discord app, the
ask channel, admins, budgets — with every step tried before anything is
written. What the bot *does* is decided afterwards, in a DM with the bot:
it introduces itself once it is connected, offers the routines it can run,
and each choice comes back as a proposal with an Apply button. In order:

1. **Elixir** — the key must open an *agent* door with a clan. An agent has
   its own URL (`/a/<id>/mcp`), its own event feed and its own feedback
   inbox, and its "me" is the clan rather than a person; a personal key
   would answer as *you*, and setup refuses it.
2. **Claude** — the key must return the model you chose, and the model must
   have a price in `models.json`.
3. **Discord** — the token must belong to the application id you gave, with
   the Message Content intent on, in the server you named. Not invited yet?
   It prints the invite link with both scopes and exactly the permission bits
   the lanes need, and waits.
4. **Routines** — none, by default: the bot offers them by DM once it can
   see your channels and your clan. Answer *yes* here to use the terminal
   checklist instead. Either way a file already in the instance is **never
   overwritten**, and one turned off goes to `ROUTINES_DISABLED` rather
   than being deleted.
5. **Schedule** — your timezone (schedules and the DM's "run it at 7:30"
   are read in it).
6. **Channels** — shows where the bot may post (every channel where its role
   is *explicitly* granted Send Messages), insists on at least one, and asks
   which channel is the ask channel, checking thread permissions there.
   Create channels in Discord first; the bot does not need Manage Channels
   and never asks for it.
7. **Identity** — nothing to type: tell the bot about the clan in the DM and
   it proposes the lines to keep. `identity.md` is yours to edit any time.
8. **Budgets** — the two pots (an estimate once routines exist; the bot
   says what a set would cost when you choose it).
9. **Admins** — each user id checked to be a member of the server. These are
   the people the bot DMs.
10. Writes `.env` and offers to install and start the service, showing the
    boot check's lines from the log. Then DM it.

Every failure comes with its fix and a chance to retry; `skip` moves on.
Re-running keeps every value on Enter, so it is also how you rotate one key,
move one channel, add a routine or change a time. `--check` runs the same
validation with no prompts and writes nothing.

Two files come out of it. **`.env` holds the three secrets and nothing
else**; **`config.json` holds every other setting** — the same key names,
flat, documented in `config.example.json`. That split is what lets an
instance directory be a git repository (`.env` and `state/` ignored,
`config.json` and `agent/` committed), keeps `config.json` in `.history/`
beside your prompts, and lets the DM change a setting with a diff you read.
An instance from before this split is migrated the first time the new code
starts: settings move out, `.env` is rewritten to the secrets, the old copy
is kept under `state/env-history/`.

## Iterating on prompts

This is the part that matters, because the prompts are the product:

```bash
export INSTANCE_DIR=~/.elixir-mcp-discord/myclan  # once per shell
npm run try notable-movers                  # run it now, print it, post nothing
npm run try meta-report -- --show-prompt    # also print the assembled prompt
npm run try clan-feed -- --post             # actually post it
npm run probe                               # the key, the surface, the feed
npm run routines                            # what will run, where, and this month's spend
```

A dry run makes a real model call and shows you the answer, the tools it
called, the shapes they returned and what it cost — without waiting for 12:30
and without touching the channel. Files are re-read on every run, so editing a
prompt needs no restart and no deploy.

## Reviewing what it said

Every live turn is appended to `state/turns/YYYY-MM-DD.jsonl` in the instance
directory: the question (or the brief and the timeline it was handed), every
tool call with its arguments and what came back, the answer, where it went,
and any 👍/👎 or filed feedback afterwards. The system prompt it ran on is
saved once per wording under `state/prompts/`. Read it as transcripts:

```bash
npm run turns                                # the last 7 days
npm run turns -- --since 2026-09-13 --lane ask
npm run turns -- --turn d98fe553             # one turn, tool bodies uncut
npm run turns -- --export ./review           # one .md per turn, plus the prompts
```

No member-facing turn reads this back — it is a record for judging answers,
not memory — and it holds members' names and questions, so it stays under
`state/`, which is gitignored.

## Letting it review itself

Set `REVIEW=on` (and `ADMIN_USER_IDS`) and once a week the bot reads its
own ledger, grades what it said against its own rules and against what
people did afterwards — a 👎, a leader stepping into a thread, the asker
saying "no" — and DMs you at most three **proposed edits** to the files
under `agent/`, each a diff with Apply / Skip buttons. Apply writes the file
(a copy is kept under `agent/.history/`) and the change is live, because
prompts hot-load. The next review opens by checking whether the last one's
edits actually helped.

Accepted edits are the bot's memory. `agent/memory.md` collects how to do
this job here — which tool answers what, what your clan calls things; the
house rules and a routine's brief change only when a rule itself was wrong.
It never learns facts about the game (Elixir has those) and never anything
about a person.

It runs on its own model and its own budget (`REVIEW_MODEL`,
`REVIEW_MONTHLY_BUDGET_USD`), so it can never cost a member an answer.
`/review` runs it now; `npm run review` shows what it would propose without
writing or sending anything.

## Talking to it directly

DM the bot from the account in `ADMIN_USER_IDS` and it is your console —
nobody else sees it, and anyone else who DMs it gets one polite line:

- **Tell it something.** "We call war days boat days." "This week we're
  pushing for top 10." It replies with the exact line it would add to
  `agent/memory.md` and an Apply button; on tap it is live. Context that
  is only true for a while carries an `until` date and drops out on its
  own. Ask it to forget and it proposes the removal.
- **Paste it something long.** A clan FAQ, a rules post: Discord turns a
  long paste into `message.txt`, and the bot reads that too. It proposes
  the parts worth remembering, three at a time. It has no web access;
  pasting is you saying it.
- **Ask why.** `why d98fe553`, or paste a link to one of its messages: the
  transcript — what it was asked, what it thought, what every tool
  returned. Tell it what it should have done and it proposes the change.
- **Run the calendar.** `routines` lists what runs and when. "Move the
  movers post to 7:30", "turn off the rival scout", "add a Friday war
  recap in #war that skips quiet weeks", "make the meta report shorter" —
  each becomes a proposal on the routine's file, checked the way the bot
  loads it, live on Apply with no restart.
- **Change a setting.** "Raise the ask budget to $15", "run the review
  Saturday at 9", "use opus by default", "add @Levy as an admin", "move
  questions to #ask-bot". Each is checked the way setup checks it and shown
  as a diff; Apply rewrites `config.json` and the bot restarts itself
  (under launchd or systemd) to pick it up. Keys and tokens live in `.env`
  and the Elixir URL and server ids are wiring — none of those can be
  changed this way. `settings` shows the current values.
- **Try before posting.** `try notable-movers` runs the routine and shows
  you the post without sending it; `post it` sends it.
- **Ask it anything** about the record, on your own behalf, without
  cluttering the ask channel. `memory` shows what it knows; `budget` the
  month's spend.
- **It tells you when something is wrong**: a routine file that failed to
  load, a lane at its budget, a channel it cannot post in, an answer that
  errored, Elixir's maintainer replying to something it filed. These used
  to be log lines.

It will not remember facts about the game (Elixir has those) or anything
about a person, and it cannot post to a channel from the DM — only send a
rehearsal you have already read. DM turns are charged to the review lane's
budget.

In Discord, an admin (`ADMIN_USER_IDS`) has slash commands: **`/run`** with
autocomplete over your routine names, **`/routines`**, and **`/budget`**
(prefixed, e.g. `/pk-run`, if the instance sets `COMMAND_PREFIX`). They are
registered to your guild at startup, so they appear immediately — if they
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

### Channels: where it posts

The bot posts where *it* decides a post belongs, the way it chooses a data
tool: from a description. Every turn that may post gets a directory of
channels — name, topic, who can see it — and a `post_message` tool. A war
week's result goes where the clan reads; a departure with the role they
held can go to a leaders-only channel if one exists; a clan with one channel
and a clan with ten need no different wiring.

**The allow-list is Discord permissions, with one rule.** A channel is in the
directory when the bot's role (or the bot itself) is **explicitly** granted
Send Messages there. What it merely inherits from @everyone does not count —
on most servers that would be every channel, memes included. So you decide
where it may post by granting its role in each channel, in Discord, and the
channel's topic is how you tell it what that channel is for. Write topics;
they are the prompt for this choice.

A routine may still name a `channel:` as its default ("here unless another
clearly fits"), by logical name bound in `.env` or simply by channel name.
Making no `post_message` call is how a routine posts nothing; up to
`MAX_POSTS_PER_TURN` (3) posts may go to different channels when they
genuinely differ.

The ask lane is the exception, on purpose: it answers in the thread of the
question and **never gets the post tool**, because its input is other
people's words and "post this in #announcements" must stay a request rather
than an instruction. Where the bot *listens* is the one binding that stays
explicit (`CHANNEL_ASK`).

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
`/budget` in Discord both show where you are; `npm run setup` suggests a
starting number from the routines you chose.

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
  `events_seen_through` marker per *account* (an agent is its own account),
  so two consumers on one key eat each other's notifications. Every routine
  polls with `mark_seen: false` and keeps its own position. On first run each
  seeds from the newest event rather than draining the backlog into your
  channel.
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

Three clans on one Discord server is three instance directories, each with
its own Discord application, its own Elixir MCP agent and its own Claude key,
and nothing shared but the code:

```
~/.elixir-mcp-discord/
  kings/     .env  agent/  state/
  shipit/    .env  agent/  state/
  rookies/   .env  agent/  state/
```

Run `npm run setup` once per directory. Two things to know:

- Slash commands are registered per Discord application, so three bots in one
  server each bring a `/run` and Discord tells them apart only by avatar. Set
  `COMMAND_PREFIX` per instance (`pk`, `si`, …) and they become `/pk-run`,
  `/si-run`: an admin cannot run one clan's routine on another by picking the
  wrong avatar.
- Bots ignore each other's messages and reactions; each listens only in its
  own ask channel and posts only where its own role is explicitly granted,
  which setup and the boot check both verify.

Each instance's prompts are its own — that is how a clan decides how its bot
engages — so `agent/` is copied, not shared. A code change is a restart per
instance; a prompt change is never either.

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

Setup offers this at the end; the installers also run on their own.

**macOS (launchd):**

```bash
./scripts/install-launchd.sh ~/.elixir-mcp-discord/myclan     # label com.poapkings.elixir-mcp-discord.myclan
./scripts/install-launchd.sh ~/.elixir-mcp-discord/myclan uninstall
tail -f ~/Library/Logs/elixir-mcp-discord/com.poapkings.elixir-mcp-discord.myclan.log
```

**Linux (systemd user unit):**

```bash
./scripts/install-systemd.sh ~/.elixir-mcp-discord/myclan     # unit elixir-mcp-discord-myclan
./scripts/install-systemd.sh ~/.elixir-mcp-discord/myclan uninstall
journalctl --user -u elixir-mcp-discord-myclan -f
loginctl enable-linger $USER              # keep it running after you log out
```

**Docker:**

```bash
I=~/.elixir-mcp-discord/myclan
docker build -t elixir-mcp-discord .
docker run -d --name elixir-mcp-discord-myclan --restart unless-stopped \
  --env-file $I/.env -v "$I/state:/app/state" -v "$I/agent:/app/agent" \
  elixir-mcp-discord
```

Both service templates are rendered rather than committed, because a unit file
is nothing but absolute paths and yours are not these. Three things in them are
deliberate: `node` is referenced by absolute path (neither launchd nor systemd
reads your shell profile); the working directory is the instance so its
`.env`, `agent/` and `state/` are the ones found; and the restart throttle is
30 seconds so a job that dies on startup leaves a legible crash loop in the
log instead of drowning it. The container mounts the instance's `state/` and
`agent/` so cursors and budgets survive a replacement and a prompt edit needs
no rebuild.

Every boot checks the channels again — in the guild, the role can see, post
and read history, plus threads for an ask channel — and complains in the log
and in the first channel that works. The lanes that work keep working.

## License

MIT.

---

This material is unofficial and is not endorsed by Supercell. For more
information see [Supercell's Fan Content Policy](https://www.supercell.com/fan-content-policy).
