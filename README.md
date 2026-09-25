# elixir-mcp-discord

[![verify](https://github.com/jthingelstad/elixir-mcp-discord/actions/workflows/verify.yml/badge.svg)](https://github.com/jthingelstad/elixir-mcp-discord/actions/workflows/verify.yml)
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

One unit of behaviour, four ways to trigger it — and **the record is the
trigger, not the calendar**: a proactive post fires because something
happened in Elixir's timeline, and a scheduled slot is the exception.

```
routine = trigger x prompt x destination
```

| Trigger | Fires when | Example |
|---|---|---|
| `message` | somebody speaks in the routine's channel | an ask-anything channel |
| `events` | Elixir MCP's timeline carries an item of a kind it names | the editor: joins, departures, returns, a standout session, a promotion, a resolved war week |
| `clock` | a boundary Elixir's `game_clock` names, plus an offset | a war-deck nudge four hours before this war day closes |
| `schedule` | a wall clock, in your timezone | a meta report on Sundays |

A routine is one markdown file. The shipped editor:

```markdown
---
description: The editor — turns the clan's timeline into posts, one turn per batch
trigger: events
wake: member_joined, member_left, member_role_changed, race_finished, week_resolved, returned, session_standout, ranked_promotion, ...
carry: badge_earned, collection_level_step, card_unlocked, quiet_crossed
may_skip: true
---
You have been handed a batch of timeline items ... You are the editor: decide
whether any of it is worth a post, what to say, and where it goes.
```

A `wake` kind starts a turn the moment the poll sees it; everything named
`carry` waits and rides in the next batch — or is released on its own once
the channels have been quiet past the `VOICE` line (`quiet` never, `normal`
12h, `chatty` 4h). The batch is the unit of cost: a turn costs about the
same whether it says one line or SKIP, so texture never buys one by itself.

Drop a file in your instance's `agent/routines/`, and it runs. Delete it and
it stops. `once: true` on a scheduled routine fires at its next occurrence and
then turns itself off — "remind the clan Friday at 8" is a routine, not a
special case. A `clock` routine names `arm: war_day_closes_at` and
`offset: -4h` and never fires on a training day, where that field is null.
Notice none of them names a channel: the bot posts **where it decides the post
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
  .env                          the three secrets and the wiring ids — what the bot may not change
  config.json                   every other setting — what the DM may change; versionable
  agent/
    identity.md                 voice and house rules, prepended to every prompt
    memory.md                   what it has been told and learned here, one dated line each
    models.json                 what each model costs, so budgets can be enforced
    routines/*.md               one file per routine, chosen and then rewritten by you
    .history/                   the prior version of anything the bot changed
  state/                        cursors, run ledger, spend, the turn ledger. Not game data.
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
8. **Budgets** — the three pots: routines, members' questions, and your
   DMs with the bot plus its reviews (an estimate once routines exist; the
   bot says what a set would cost when you choose it).
9. **Admins** — each user id checked to be a member of the server. These are
   the people the bot DMs.
10. Writes `.env` and `config.json` (after every section, so a cancelled
    run keeps what you typed) and offers to install and start the service,
    showing the boot check's lines from the log. Then DM it.

Every failure comes with its fix and a chance to retry; `skip` moves on.
Re-running keeps every value on Enter, so it is also how you rotate one key,
move one channel, add a routine or change a time. `--check` runs the same
validation with no prompts and writes nothing.

Setup also offers to make the instance directory a **local git
repository** (`.env` and `state/` ignored). Then every change you accept
from the DM is a commit with the proposal's summary as its message — a
real history of what the bot says and when, with diffs and blame. Nothing
is ever pushed; there is no remote unless you add one.

Two files come out of it. **`.env` holds what the bot may not change
about itself** — the three secrets and the three wiring ids — and
**`config.json` holds every setting it may** — the same key names, flat,
documented in `config.example.json`. That split is what lets an
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
npm run try editor                          # run it now, print it, post nothing
npm run try meta-report -- --show-prompt    # also print the assembled prompt
npm run try editor -- --post                # actually post it
npm run probe                               # the key, the surface, the feed
npm run routines                            # what will run, where, and this month's spend
```

A dry run makes a real model call and shows you the answer, the tools it
called, the shapes they returned and what it cost — without waiting for 12:30
and without touching the channel. Files are re-read on every run, so editing a
prompt needs no restart and no deploy. An event routine's dry run is handed
the timeline the way the live lane hands it (the routine's kinds, oldest
first) and moves no cursor.

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

Members can paste a **screenshot** — a deck, a battle result — and the
bot reads it, answering from the record; and a **deck link**, which it
reads off the URL. When a member asks for something that is not a
question ("can the war reminder come earlier?") the bot passes it to you
by DM. Each member gets `ASK_DAILY_TURNS_PER_MEMBER` questions a day
(default 20), so nobody drains the pot for everyone. Before a scheduled
post, the bot can read the last two hours in the channel so it does not
restate what the room already said.

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
about a person. A new instance starts with none: the file's notes to you
sit in an HTML comment, which the bot never reads. (If yours was set up
before 2026-09-25 and still has three example lines dated 2026-09-14 — one
says war days are "boat days" — delete them; they are ignored either way.)

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
- **Take a post back.** `retract <turn id> — why`: every message that
  turn posted is deleted, and the review treats it as the strongest signal
  it has.
- **Ask why.** `why d98fe553`, or paste a link to one of its messages: the
  transcript — what it was asked, what it thought, what every tool
  returned. Tell it what it should have done and it proposes the change.
- **Run the calendar.** `routines` lists what runs and when. "Move the
  meta report to Saturday at 9", "turn off the war-deck nudge", "add a
  Friday war recap in #war that skips quiet weeks", "make the meta report
  shorter" —
  each becomes a proposal on the routine's file, checked the way the bot
  loads it, live on Apply with no restart.
- **Change a setting.** "Raise the ask budget to $15", "run the review
  Saturday at 9", "use opus by default", "add @Levy as an admin", "move
  questions to #ask-bot". Each is checked the way setup checks it and shown
  as a diff; Apply rewrites `config.json` and the change is live — only
  the command prefix and the feed poll interval restart the bot, which it
  does itself under launchd, systemd or Docker's restart policy. Keys, tokens and the wiring ids
  live in `.env`, which it cannot reach. `settings` shows the current
  values.
- **Try before posting.** `try war-deck-check` runs the routine and shows
  you the post without sending it; `post it` sends it.
- **Try before applying.** Every proposal that changes a routine, a house
  rule or memory has a **Try it** button: the routine runs on the proposed
  file and shows you the post it would have made, so you apply evidence,
  not a diff.
- **Ask it anything** about the record, on your own behalf, without
  cluttering the ask channel. Or about itself: "how am I doing on budget?",
  "did anyone ask about war decks this week?", "what would a Friday recap
  cost?" — it has `status`, `search_turns` and `estimate_cost` for those.
  `memory` shows what it knows; `budget` the month's spend; `status` the
  whole picture; `feedback` what it has filed with Elixir and what came
  back.
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
                                 elixir_timeline
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
clearly fits"), by logical name bound in `config.json` (`CHANNEL_<NAME>`) or
simply by channel name.
Making no `post_message` call is how a routine posts nothing; up to
`MAX_POSTS_PER_TURN` (3) posts may go to different channels when they
genuinely differ.

The ask lane is the exception, on purpose: it answers in the thread of the
question and **never gets the post tool**, because its input is other
people's words and "post this in #announcements" must stay a request rather
than an instruction. Where the bot *listens* is the one binding that stays
explicit (`CHANNEL_ASK`).

### What it may change in Elixir

Almost everything Elixir MCP offers only reads. Six tools write something
— feedback, identity links, nicknames, tracked clans and players,
collections — and the server marks which. Each kind of turn gets every
read and only the writes it needs: a routine and the weekly review may
file feedback; a member's question and your DM may also link who is
asking; a rehearsal (`npm run try`, `try` in the DM, a proposal's **Try
it**, `npm run review`) writes nothing at all. Nothing the bot does can
track a clan or player on your account. `npm run probe` prints the
split. For belt and braces, untick `recordings:write` and
`collections:write` on your agent's page in Elixir; the hub enforces that
on the next call.

### No fallback, on purpose

If Elixir MCP is down, this bot says so and stops. It has nothing else to
consult. (When the model API is what failed, it says that instead: an
outage should be blamed on the service that had it.) That makes it an honest instrument: when an answer is good, the MCP
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
time somebody is not recognised it asks which player they are and links them
once. From then on the server remembers — for them, and for everyone who asks
later. The link is always to whoever sent the message: the model names a
player, and the bot supplies who is asking from Discord itself, so nobody can
type their way into linking someone else.

### Feedback is a feature, not an afterthought

The most valuable output of a channel like this is not the answers. It is the
record of what the agent *wanted* to do and could not.

`elixir_send_feedback` is a first-class door for exactly that, and every routine —
not just the ask lane — files through it two ways: inline, while the agent
still has the context that made the gap obvious, and via a post-turn sweep when
a tool errored or an answer conceded a limit and nothing was filed. Maintainer
replies are posted back into the channel. Members watching their complaint get
answered is the point.

Readers take part too: a 👎 on any post or answer sends the turn back for
one reflection and at most one filing (reply to the message with what was
wrong, and that reply is the strongest evidence it gets); a 👍 files
praise with no model call. A 👎 is paid from the ask budget, since a
member started it, and one turn takes at most three.

### Silence is a valid output

Any routine with `may_skip: true` may answer `SKIP`, which posts nothing and
still marks the run done. A channel that manufactures content on a quiet day
teaches people to mute it. Routines that may *not* skip post what they said, so
a prompt bug is visible rather than looking like a quiet week. A turn that is
cut off at its `max_tokens` ceiling is not a SKIP: it is asked once more with
a fresh ceiling (the reads it made stay in the turn), and if it still cannot
deliver, the run fails and you get a DM saying which routine ran out of room.

Since the record decides *when* a proactive turn fires, a SKIP means "the
room already knows" rather than "nothing happened today" — the batch that
woke the editor is the news. The one knob for how much to say is `VOICE` in
`config.json`, and it is a coalescing interval, not a prompt: items the
editor names as `carry` (badge level-ups, collection steps, card unlocks,
quiet crossings) never start a turn on their own until the channels the bot
posts in have been quiet past the line — `quiet` (never), `normal` (12h, the
default) or `chatty` (4h). Only routine posts reset that clock; answering a
question in the ask channel is not sharing. "Make it chattier" in the DM
changes it.

## Budgets

Three monthly pots in `config.json`, because three different things spend
them:

```json
"MONTHLY_BUDGET_USD": "20.00",         what the bot does on its own
"ASK_MONTHLY_BUDGET_USD": "10.00",     what clan members ask for
"REVIEW_MONTHLY_BUDGET_USD": "10.00",  the review lane and your DMs
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

Months are UTC calendar months and nothing rolls over. Each pot is a
number of dollars or `"unlimited"`, said on purpose; one left unset (or
set to something that is not a number) is capped at $10 a month, and the
boot log and a DM say which. `0` turns a lane off. `npm run
routines`, `/budget` and `budget` in the DM all show where you are — all
three pots, the review one whether or not the review is on, and "raise the ask
budget to $15" in the DM changes it, live. `ASK_DAILY_TURNS_PER_MEMBER`
(default 20) keeps one member from spending the ask pot for everyone.

## Choosing a model

`CLAUDE_MODEL` is yours, and any routine can override it in its own front
matter — a war-deck nudge that reads one field does not need what a weekly meta
report needs:

```markdown
---
trigger: schedule
model: claude-sonnet-5
effort: low
max_tokens: 2000
---
```

`effort` (and the adaptive thinking it tunes) is sent only to models that
take them. `claude-haiku-4-5` takes neither — either is an API error there —
so a Haiku routine runs without thinking and its `effort` is ignored; mark
another such model `"adaptive": false` in `models.json`.

`max_tokens` (default 6000) caps thinking plus text plus tool arguments for
one turn; at `effort: high` a routine that makes several large reads can
reach it inside the thinking. When the DM says a routine ran out of room,
raise its `max_tokens` or lower its effort.

`max_chars` (default 1900) is the length of one post. The model is told the
number, and `post_message` refuses anything longer with an error it can
answer by shortening; a post is never cut or split to fit. Discord's own
2,000 is the ceiling whatever you set.

Whatever you choose must have a price in `agent/models.json` (which extends the
catalog in `src/pricing.js`). That file is operator-owned for the same reason
the prompts are: prices change, and the person paying the bill should be able
to correct one without a deploy. **An unpriced model stops the bot at boot**
rather than being billed at zero — budgets you cannot enforce are worse than no
budgets, because they look like they work — and a routine whose `model:` is
changed to an unpriced one later fails before the call, not after it.

## Operating notes

- **Cursors are per routine.** Each event routine reads `elixir_timeline`
  as its own named `reader` (`<instance>-<routine>`, Elixir MCP contract
  3.18.0) with `mark_read: true`, which moves only that reader's pointer on
  the server — never the account's (an agent is its own account) and never
  another routine's or instance's. Where the next read starts is still the
  routine's own cursor in `state/`, moved only after a successful turn, so a
  failed turn reads its window again. On first run each seeds from now
  rather than draining the backlog into your channel.
- **`state/state.json` is replaced, never rewritten in place.** A crash or
  a full disk mid-write leaves the previous state. If the file is ever
  unreadable (a hand edit gone wrong), it is moved to
  `state.json.corrupt-<time>` with an `ERROR state_corrupt` line, and the
  bot starts over from a fresh state rather than overwriting it — this
  month's spend is in the kept copy.
- **A busy window is read to its start.** Elixir MCP serves the newest items
  of a window too big for one page and counts the rest (`has_more`,
  `timeline_more`); before the turn the bot reads the older ones back by
  window (the same `from`, `to` at the cut, `mark_read: false`), up to four
  more pages, so a join under an hour of badges is still posted. What the
  bound leaves unread is an `events_unread` warning in the log.
- **A routine can remember what it posted.** `recall: 3` hands the model
  that routine's last three posts, from its own ledger in `state/`, so a
  recurring post you write can rotate instead of repeating itself. None of
  the shipped routines use it — the editor is handed the news itself — but
  the field is yours. It is the bot's own output, not game data.
- **Failed calls are visible under the post.** When a turn's tool calls
  errored, a one-line footer says which and how many, whether or not the
  routine shows a trace; a reply that states figures without having called a
  tool gets a footer saying so. The footers name the server's `request_id`
  so a screenshot can be joined to the exact call.
- **Maintainer replies are read on the server's hint.** Every Elixir MCP
  response carries `meta.feedback_responses_pending` (contract 1.0.0), so the
  bot reads `elixir_my_feedback` only when a feed poll says there is something
  new — not every tick. Since contract 3.8.0 it follows `next_offset` until the
  bounded feedback ledger is complete, so long histories do not strand older
  replies.
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
  kings/     .env  config.json  agent/  state/
  shipit/    .env  config.json  agent/  state/
  rookies/   .env  config.json  agent/  state/
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

## Tests and the gate

```bash
npm run verify      # format:check + lint + knip + test — what CI runs
npm test            # just the tests
npm run format      # prettier --write
```

`verify` is the gate before every commit and what the `verify` workflow runs
on every push and pull request, on Node 22 and 24, step by step so a red run
says which one. Formatting is prettier at 120 columns (prose and the example
prompts are left alone); lint is oxlint with correctness rules; knip finds
files, exports and dependencies nothing uses; `npm run audit` checks runtime
dependencies for high-severity advisories in a separate job. Dependabot
opens a grouped PR for dev tooling weekly.

No network, no spend in the tests — enforced: `scripts/setup-tests.js`
refuses every fetch and fails the file that tried one. The model call and Discord are both
injectable. They cover routine parsing (every mistake a hand-edited file can
make), the schedule arithmetic including a DST boundary, the runner's
post/skip/split behaviour, prompt assembly, the ask path end to end, the
ledger, the review lane's proposals and buttons, the DM console, settings,
and the instance repository. The ask-path test exists because a refactor
once deleted `LiveMessage` and every static check passed — a missing symbol
is a runtime `ReferenceError`, and members found out instead. Since
2026-09-25 lint has `no-undef` too, so that one no longer gets past the
static checks either.

A tag is a release: `npm version minor && git push --follow-tags` runs
`verify`, checks the tag matches `package.json`, and publishes the commits
since the previous tag as the notes. `git checkout v0.3.0` is a known
build, and the boot hello names it.

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
# setup, in the image, if node is not on the host
docker run -it --rm --user "$(id -u):$(id -g)" -v "$I:/instance" \
  elixir-mcp-discord node src/setup.js /instance
# the bot
docker run -d --name elixir-mcp-discord-myclan --restart unless-stopped \
  --user "$(id -u):$(id -g)" -v "$I:/instance" elixir-mcp-discord
```

Both service templates are rendered rather than committed, because a unit file
is nothing but absolute paths and yours are not these. Three things in them are
deliberate: `node` is referenced by absolute path (neither launchd nor systemd
reads your shell profile); the working directory is the instance so its
`.env`, `agent/` and `state/` are the ones found; and the restart throttle is
30 seconds so a job that dies on startup leaves a legible crash loop in the
log instead of drowning it. The container mounts the whole instance —
`.env`, `config.json`, `agent/`, `state/` — as the host user that owns it,
so settings, cursors and budgets survive a replacement, a prompt edit needs
no rebuild, and a setting that needs a restart is applied by the restart
policy. (Before 2026-09-25 the recipe mounted only `state/` and `agent/`;
a container started that way has no `config.json`, which means no
budgets, no admins and no ask channel.)

Every boot checks the channels again — in the guild, the role can see, post
and read history, plus threads for an ask channel — and complains in the log
and in the first channel that works. The lanes that work keep working.

## License

MIT.

---

This material is unofficial and is not endorsed by Supercell. For more
information see [Supercell's Fan Content Policy](https://www.supercell.com/fan-content-policy).
