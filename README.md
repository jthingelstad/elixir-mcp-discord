# elixir-mcp-discord

A Discord bot for a Clash Royale clan, powered **entirely** by
[Elixir MCP](https://elixir.poapkings.com). No local game database, no Clash
Royale API key, no cached roster. Every fact it states came from an MCP tool
call made moments earlier.

It runs two channels:

- **an ask channel** — members ask anything about players, decks, war, or other
  clans, and the agent answers from the recorded corpus.
- **a notifications channel** — the clan's event feed, read on a timer and
  written up as a short brief.

It is small on purpose. If you want to power your own clan's Discord with
Elixir MCP, this is roughly the amount of code it takes.

## How it works

```
Discord ──▶ ask.js ──▶ Claude (MCP connector) ═══▶ Elixir MCP
                                                        │
Discord ◀── notify.js ◀── Claude ◀── mcp.js ────────────┘
                                     elixir_events
```

Two different paths reach the same server, and the split is the main design
decision in the repo:

**The ask lane uses the Claude API's MCP connector.** We hand the API the
server URL and a token; Anthropic opens the MCP connection server-side and runs
the tool loop. There is no tool list in this repository — not a schema, not a
name, not a switch statement. That matters more than it sounds like it does.
Elixir MCP publishes `serverInfo.version` as `<contract>+tools.<fingerprint>`
specifically because MCP clients cache `tools/list` forever, and a hand-written
tool mirror goes stale in silence. The connector re-reads the surface itself, so
a tool that shipped this morning is usable this afternoon with no deploy here.

**The notifications lane uses a direct MCP client** (`src/mcp.js`, ~100 lines of
JSON-RPC over `fetch`). Polling an event feed is plumbing, and plumbing should
not cost a model call. The model only gets involved once there is something to
write about.

### No fallback, on purpose

If Elixir MCP is down, this bot says so and stops. It has nothing else to
consult. That makes it an honest instrument: when an answer is good, the MCP
server earned it.

### It does not know who you are

A member connecting their own agent has added their own player, so their agent
knows them. This bot has no such link and does not fake one with a local
nickname table — it asks for a player tag and looks it up. That friction is part
of what is being demonstrated.

### Feedback is a feature, not an afterthought

The most valuable output of a channel like this is not the answers. It is the
record of what the agent *wanted* to do and could not.

Elixir MCP has a first-class door for that: `elixir_feedback`, which every
connected agent is invited to call on its own judgment, and which the maintainer
answers. This bot files through it two ways:

1. **Inline** — the system prompt tells the agent to file as it works, while it
   still has the context that made the gap obvious.
2. **A sweep** — after any turn where a tool errored or the answer conceded a
   limit ("I can't see donation history"), a deterministic check notices, and if
   the agent has not already filed, asks it to reflect once and file. Graceful
   failure is exactly when friction disappears without a trace, so it is worth a
   second look.

When something is filed, a one-line note is appended in the channel. When the
maintainer answers, the response is posted back. Members watching their
complaint get answered is the point.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
npm run probe             # verify the token, the tool surface, the feed
npm start
```

**The service token must be its own.** Mint a token named for this bot rather
than reusing one from another integration: calls are audited per token on the
Elixir MCP admin page, and revoking one integration should never take down
another.

`npm run probe` needs only the two `ELIXIR_MCP_*` values, so you can verify a
token before you have a Discord app. It is also worth running any time an answer
looks wrong. It prints the
contract version and tool fingerprint, tells you if either moved since last
time, and pulls the changelog when it did.

## Scheduled posts

Beyond reacting to the event feed, the bot runs prompts on a clock and posts the
answers. Times are UTC; `src/schedule.js` holds the prompts.

| Job | When | What |
|---|---|---|
| `war-deck-check` | daily 01:00 | who still has war decks today (war days only) |
| `notable-movers` | daily 12:30 | up to three players whose last 24h stood out |
| `capability-spotlight` | daily 17:00 | one thing you could ask, asked and answered |
| `rival-scout` | Mon 12:00 | this week's war bracket, scouted |
| `pilot-spotlight` | Fri 23:00 | who improved most, one player in depth |
| `meta-report` | Sun 15:00 | what's rising in the corpus vs how we play |

Two rules picked this roster: don't restate the event feed (`clan_pulse`,
`war_day_open`, joins and week-close already get written up when they fire), and
favour what a single-clan bot structurally cannot do — the multi-clan corpus,
meta decks, rival scouting, Pilot Score.

**Silence is a valid output.** Any prompt that can be dull is told it may answer
`SKIP`, which posts nothing and still marks the run done. A channel that
manufactures content on a quiet day teaches people to mute it.

Turn jobs off by key, no code change:

```
SCHEDULE_DISABLED=meta-report,pilot-spotlight
```

Roughly $0.05–0.20 per post. A missed run fires late only inside its own
catch-up window — a war-deck nudge at 4am because the host was asleep is worse
than one that never fires.

## Tests

```bash
npm test
```

Six fast tests, no network and no spend: `handleAsk` runs against a fake Discord
message and an injected `askFn`. They exist because a refactor once deleted the
`LiveMessage` class and every static check still passed — a missing symbol is a
runtime `ReferenceError`, and nothing exercised the path. Members found out
instead. Deleting that class again fails three of these.

(The tests import `src/config.js`, so they need a populated `.env`.)

## Running it as a service (macOS)

```bash
./scripts/install-launchd.sh              # install + start at login
./scripts/install-launchd.sh uninstall    # stop + remove
launchctl print gui/$(id -u)/com.poapkings.elixir-mcp-discord
tail -f ~/Library/Logs/elixir-mcp-discord/com.poapkings.elixir-mcp-discord.log
```

The repo ships a template rather than a plist, because a plist is nothing but
absolute paths and yours are not these. Three things in it are deliberate:
`node` is referenced by absolute path (launchd never reads your shell profile,
so a bare `node` simply fails to spawn); `PATH` is set explicitly (launchd hands
a job a minimal environment without `/opt/homebrew/bin`, and anything this
process ever shells out to would inherit that gap); and `ThrottleInterval` is 30
so a job that dies on startup — bad token, missing `.env` — leaves a legible
crash loop in the log instead of drowning it at one restart every ten seconds.
The installer refuses to run without a `.env` for the same reason.

## Operating notes

- **The event cursor is local.** `elixir_events` keeps one `events_seen_through`
  marker per *account*, so any two consumers on the same account will consume
  each other's notifications. This bot polls with `mark_seen: false` and tracks
  its own position in `state/state.json`, leaving the account cursor untouched.
  On first run it seeds from the newest event rather than draining the backlog
  into your channel.
- **Silence is a valid output.** A quiet poll posts nothing.
- **Cost.** Every answer footer shows the tools called and what the turn cost.
  Set `DAILY_USD_CAP` to have the bot stop answering past a daily figure.
- **Rough edges are expected.** This is a demonstration of a young service, and
  what it cannot do yet is as interesting as what it can.

## Configuration

Everything is environment-driven; see `.env.example`. There is no clan-specific
anything in the source — point `CLAN_TAG` and the two channel IDs elsewhere and
it runs for a different clan.

## Layout

| File | What it does |
|---|---|
| `src/index.js` | Discord connection, wiring, boot handshake |
| `src/ask.js` | the ask lane: prompt, history, reply |
| `src/notify.js` | the feed poller and the brief |
| `src/claude.js` | the model call via the MCP connector, cost accounting |
| `src/mcp.js` | direct MCP JSON-RPC client |
| `src/feedback.js` | friction detection, filing, response readback |
| `src/state.js` | cursor, spend, last-seen contract version |
| `src/probe.js` | `npm run probe` |

## License

MIT.

---

This material is unofficial and is not endorsed by Supercell. For more
information see [Supercell's Fan Content Policy](https://www.supercell.com/fan-content-policy).
