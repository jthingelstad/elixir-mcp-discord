# AGENTS.md — elixir-mcp-discord

`CLAUDE.md` is a symlink to this file. Do not fork them.

Domain rules are one level up in [`../AGENTS.md`](../AGENTS.md); repo-wide AWS
and secret-safety rules are two levels up in `~/Projects/AGENTS.md`.

## What this is

A public reference implementation: a Discord bot for a Clash Royale clan powered
entirely by Elixir MCP. It runs three clans' channels on the POAP KINGS
Discord server as three instances (see "Three bots, one checkout" below),
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
  `elixir-mcp` minus React), knip (dead files, exports, dependencies), then
  the tests. Run it before every commit; CI (`.github/workflows/verify.yml`)
  runs the same four steps on Node 22 and 24 and a separate `npm run audit`.
  A red step names itself. `npm run format` fixes formatting; `oxlint
  --fix` fixes what it can.
- **Commit directly to `main`, small and often**, one change per commit
  with a message that says why (the commit history is the design record
  alongside this file). No feature branches, no PRs for your own work;
  Dependabot's PRs are the exception. Push after each commit; there is no
  checkout lease here — one checkout, one actor at a time.
- **A `src/` change is live only after each instance restarts**
  (`launchctl kickstart -k gui/$(id -u)/com.poapkings.elixir-mcp-discord.<name>`,
  one at a time, reading each boot line for `build=<version>+<sha>`). A
  change under `agent/` in the checkout changes no live bot. `config.json`
  is live. Verify from the boot lines and the next natural turn in the
  ledger; never run a routine early, ask the bot a question, or post as
  acceptance.
- **A release is a tag**: bump `package.json`, `git tag v<version>`, push
  the tag; `release.yml` verifies, checks the tag matches, and publishes
  notes from the commits. The boot hello names the build.
- **Docs are part of the change.** A behaviour that moved gets its `since
  <date>` line here and its sentence in `README.md` in the same commit; a
  new knob goes in `config.example.json` (or `.env.example` if the bot may
  not change it). This file is the decision ledger — dated, with the
  reason — so read what changed since your last visit before assuming.
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
server-side defaulting bug for weeks instead of getting it fixed (see below). A
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
rule forbids. Its one reader is the review lane, whose audience is the
operator and whose output is a proposal. And `agent/memory.md` is memory,
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
in `WHO_IS_ASKING` is: compare the author's Discord name against
`clans_roster`, link on a whole-name single match, otherwise ask. A member
whose Discord name was exactly their in-game name was told to type a tag the
bot could have read off the roster; the server refuses `elixir_identify` for
anyone outside the clan and a re-call replaces the mapping, so the exact
match is cheap to make and cheap to undo.

**Public repo, no secrets.** `.env`, `.env.*`, `/config.json` and `state/`
are gitignored. Check `git ls-files` before assuming something is untracked. Since
2026-09-13 the live instances keep nothing in the checkout at all — see below.

## Three bots, one checkout — since 2026-09-13

The **instance is a directory** — the cwd, or `INSTANCE_DIR`. `.env`,
`config.json`, `agent/` and `state/` resolve against it, never against the
checkout (`instanceDir` in `src/config.js`, `STATE_PATH` in `src/state.js`).
**Since 2026-09-15 `.env` holds what the bot may not change about itself**
— `ENV_FILE_KEYS` in `src/env-file.js`: the three secrets and the three
wiring ids (`ELIXIR_MCP_URL`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`) — and
`config.json` holds every setting it may change, flat, the same key names
as before, so it can be versioned with the instance, backed up under
`.history/` and edited from the DM with a diff. That is the rule for which
file a key goes in ("if it isn't editable it belongs in .env" — Jamie),
not secrecy: the ids briefly sat in `config.json` and were moved back the
same day. `lookup()` in `config.js` reads `.env`'s keys and path overrides
from the environment and everything else from `config.json` first,
environment second (tests and deliberate shell overrides); a shell
`CLAUDE_EFFORT` no longer silently outranks the file. A pre-`config.json`
instance is migrated on its first boot by `migrateEnvToConfig` (settings
out, `.env` rewritten, the old copy under `state/env-history/`, a
`config_migrated` log line and a DM); a `config.json` from the wiring day
has the ids moved back the same way (`wiring_moved_back`).
`config.example.json` documents every setting; `.env.example` the rest. The live instances are

    ~/.elixir-mcp-discord/poapkings/     POAP KINGS   /pk-*   com.poapkings.elixir-mcp-discord.poapkings
    ~/.elixir-mcp-discord/shipit/        Ship It!     /si-*   com.poapkings.elixir-mcp-discord.shipit
    ~/.elixir-mcp-discord/elixirkings/   Elixir Kings /ek-*   com.poapkings.elixir-mcp-discord.elixirkings

three Discord applications in ONE server, each with its own ask channel and
whatever channels its role is explicitly granted, its own Elixir agent (an agent is its own account, so its
feed cursor and feedback inbox are its own) and its own Claude key. Logs are
`~/Library/Logs/elixir-mcp-discord/<label>.log`.

- **There is no `.env` in the checkout any more**, so a bare `npm run try`
  fails and says so. The instance is the cwd OR `INSTANCE_DIR`:
  `INSTANCE_DIR=~/.elixir-mcp-discord/shipit npm run try <routine>` / `probe`
  / `routines`. (A shell `CLAUDE_EFFORT` no longer shadows anything:
  `config.json` wins for every setting it names; the provenance line says
  where each value came from.)
- **`npm run setup -- <instance-dir>` is the whole process** (`src/setup.js`,
  helpers in `src/setup-catalog.js`, `src/discord-rest.js`, `src/env-file.js`):
  Elixir key, Claude key and Discord app each tried against its service BEFORE
  `.env` is written; invite link printed when the bot is not in the server;
  the timezone; the ask channel picked from the server's list and
  permission-checked over REST (`computePermissions` reproduces Discord's
  overwrite algorithm so `inspectChannel` judges a REST channel by the boot
  check's rule) — bound whether or not a message routine exists yet;
  budgets; admin ids checked as members; then an offer to install the
  service and show the boot lines. **Since 2026-09-14 setup wires the
  connection and nothing else**: routines, schedules and the clan notes
  moved to the DM (below), because choosing them needs the directory, the
  clan and the operator's evening, which the bot has only once connected —
  and the person choosing is on a phone. The terminal picker remains behind
  a yes/no (default no). A bot that boots with nothing enabled sends
  `introduce()` — where it may post, what it can run, "say the usual" — as
  a `welcome` notice, once a day. **Setup only ever ADDS routine files** —
  never overwrites or deletes one; chosen-off is `ROUTINES_DISABLED`. `--check` is the no-prompt form and
  passes on poapkings. It does not import `config.js`'s validated sections on
  purpose — those read the cwd, and setup's directory may have no `.env` yet;
  `initialize(auth)` in `src/mcp.js` takes an override for the same reason.
- **Prompts are per instance and diverge on purpose** — each clan's `agent/`
  is how that clan decides how its bot engages. The checkout's `agent/` is the
  example everyone else copies; editing it changes no live bot. A change
  meant for all three is three edits (or a copy).
- **A code change is a restart of each instance**, prompts hot-load as ever.
  Restart one first: `launchctl kickstart -k gui/$(id -u)/<label>`.
- **`COMMAND_PREFIX` keeps the slash commands apart.** Discord registers
  commands per application; three unprefixed `/run`s differ only by avatar.
  `baseCommand` strips the prefix on the way in and returns null for a name
  that is not ours.
- **Channels are checked at boot** (`src/permissions.js`): in the guild, text
  channel, role has View/Send/ReadHistory, plus CreatePublicThreads and
  SendMessagesInThreads where a message routine listens. Every failure is an
  `ERROR` with the permission named, plus one Discord post in the first
  usable channel, deduplicated by a fingerprint in `state.channelProblems`
  so a crash loop does not repeat it. The bot keeps running — the lanes that
  work should — but a pasted id from the wrong clan's channel is now a loud
  boot, not a stranger's clan report.

## Proposals — since 2026-09-15

`src/proposals.js` is the one machinery every change to the operator's files
goes through, from the review lane and from the DM: `planEdit` checks an
edit against the file AS IT IS NOW and returns the text it would become and
the diff; `applyProposal` re-plans (a hand edit in between refuses), writes
with a backup under `.history/`, records the decision, commits when the
instance is a repo; `undoProposal` restores while untouched; `tryProposal`
runs the routine's dry run on the proposed text. The fences are here too:
`EDITABLE`, operator-only ops (`edit.by === "owner"`), the memory entry
format and cap, a routine result that must parse, an owner's memory line
that only they remove. `src/review.js` re-exports it, so one import means
"a proposal".

## The review lane — since 2026-09-14

`src/review.js`. Evaluation as a FEATURE of the bot, on the operator's key
and budget, not a job beside it — because other people run this for their
own clans, and an eval that only Jamie's machine performs does not ship.
`REVIEW=on` in `.env`; off by default. Read the header comment first; the
design is there. The short version:

- **Findings become diffs.** The review reads the ledger for the window,
  grades every turn against the bot's own rules (`MECHANICS` in
  `src/prompt.js` plus the operator's files) and against what humans did
  afterwards, and produces at most `REVIEW_MAX_PROPOSALS` (3) edits to
  files under `agent/` — `memory.md` (append one dated line), `identity.md`
  or a routine's brief (replace/remove, never the front matter). Each cites
  turns and is shown as a diff. A finding that is not an edit is a
  `report_mechanics` (code — the DM carries a pasteable issue) or an
  `elixir_send_feedback` filing (the hub).
- **Humans outrank the rubric.** The signals that flag a turn: 👎/👍 with
  notes, an `intervention` (another member speaking in the answer thread,
  or the asker pushing back — `looksLikeCorrection` in `src/ask.js`), a
  sweep `finding` (see below), `ungrounded`, errors, truncation. Flagged
  turns are shown first and in full.
- **The sweeps classify before filing** (`CLASSIFY_RULES` in
  `src/feedback.js`): `ELIXIR:` files upstream as before; `PROMPT:` and
  `MECHANICS:` become `finding` records for the review instead of being
  dropped as NONE. A 👎 on this bot's own mistake no longer becomes noise
  for Elixir's maintainer.
- **Delivery is a DM to `ADMIN_USER_IDS`**: header, the report, one message
  per proposal with **Apply / Skip / Show turns** buttons (`rv:` custom
  ids, handled in `handleInteraction`). Apply re-plans the edit against the
  file as it is NOW (a hand edit since refuses cleanly), keeps the prior
  version under `agent/.history/`, and shows **Undo**. Undo restores the
  backup only while the file is untouched since.
- **Measure, then prune.** The review opens with the previous review's
  applied edits and whether the turns since show the improvement; an edit
  that did not help gets a revert proposal. A `memory.md` entry no turn
  needed in a month gets a remove proposal.
- **`agent/memory.md` is the bot's memory**, loaded after `identity.md`
  (`readMemory`, `MEMORY_MAX_CHARS` 6000, 20 entries). One line per entry,
  `MEMORY_ENTRY` in `src/prompt.js`: `- YYYY-MM-DD (turns a, b): ...` from
  the review, `- YYYY-MM-DD (from owner): ...` from the operator by DM,
  optionally ` until YYYY-MM-DD` before the colon for context that is true
  for a while — expired lines are dropped at load. How to do this job here
  — which tool answers what, what this clan calls things, what the
  operator wants kept in mind — never a game fact, never a person. The
  review may prune a turn-cited entry nothing needed in a month; it never
  removes or rewords an owner entry (`planEdit` refuses unless
  `edit.by === "owner"`, which only the DM lane sets).
  `REVIEW_AUTO_MEMORY=true` lets the review write it without a click (never
  `identity.md`, never a brief), still reported by DM with Undo.
- **Its own lane.** `review` beside `routines` and `ask` in `src/budget.js`,
  `REVIEW_MODEL` (default `claude-opus-5`), `REVIEW_EFFORT`, `REVIEW_AT` in
  the operator's timezone as a pseudo-routine on the same run ledger
  (`__review`; started AFTER the scheduler, whose first seeding replaces
  the ledger). `/review` runs it on demand; `npm run review` is the dry
  run: real call, nothing persisted, nobody DMed.
- **What it may never do:** post to a member channel, react, ask the bot a
  question, edit anything outside `agent/`, edit a routine's front matter
  (the operator can, by DM — below), read the ledger into a member-facing
  turn. The `EDITABLE` pattern and `planEdit` are the fence; the tests pin
  them.

## The DM is the operator's console — since 2026-09-14

Channels are for members; the direct message is for whoever runs the bot,
and it is the one place the bot talks ABOUT itself. Three things live there:

- **Notices** (`src/notify.js`). Everything operator-facing that used to be
  only a log line is also a DM: routine files that failed to load, no
  routines enabled, Elixir unreachable at boot, an unpriced model, unusable
  channels, a lane at its budget (daily), a routine or the ask lane
  failing, a feed routine crashing, the review failing, and Elixir's
  maintainer answering a filing (still posted in the channel too). No
  model, no cost; one line, deduplicated by fingerprint for an hour;
  `notice_unsent` in the log when there is no client yet or no
  `ADMIN_USER_IDS`. A notice must never fail a turn — `notify` swallows.
- **Review proposals** (above).
- **The conversation** (`src/dm.js`, `handleDm`): admin-only, a stranger
  gets one polite line a day. Deterministic commands first — `why <turn
  id>` or a pasted message link (the transcript; `full` for bodies),
  `try <routine>` (the dry run shown to the operator only, a draft held in
  memory for two hours), `post it` (sends the draft to the channels the
  routine chose, ledgered as a routine turn with `viaDm`), `memory`,
  `budget`, `help`. Anything else is a model turn: the ask-lane prompt plus
  `DM_BRIEF`, with `propose_change` (an edit to `memory.md`/`identity.md`/a
  brief, forced `(from owner)` provenance and `edit.by = "owner"`) and
  `lookup_turn`. A proposal rides the review machinery — a `review` record
  with `trigger: "dm"` — so Apply/Skip/Undo and `.history/` are the same
  code. Charged to the `review` lane; ledgered as lane `dm`.
- **The operator runs the calendar from the DM.** `list_routines`,
  `list_example_routines` (the checkout's `agent/routines`, with briefs, for
  first setup and as the pattern for a new one) and `list_channels` (the
  directory plus the ask binding) are tools; `routines` is a command; `propose_change` has
  three operator-only ops on `routines/<key>.md` — `set_fields` (front
  matter: `at`, `days`, `channel`, `model`, `enabled`, `may_skip`, ...;
  `""` removes a key), `create` (fields + the brief) and `delete` — beside
  `replace`/`remove` for the brief's text. `planEdit` refuses them unless
  `edit.by === "owner"`, and every routine result must pass `parseRoutine`
  or the proposal is refused with the parser's words, so a file the bot
  could not load never reaches a button. Apply of a rescheduled or new
  routine marks its current period done (`markRun`) so it does not fire
  the moment it is saved; undo of a create deletes, undo of a delete
  restores from `.history/`. Front-matter comments do not survive
  `withFields`; the fields do.
- **The clock rides every user turn** (`nowLine` in `src/prompt.js`): date,
  time and weekday in the operator's zone, in the user message so the
  cached prefix is untouched. Before it the model had no way to know the
  date and spent a `game_clock` call on the weekday.
- **`once: true`** on a schedule routine: fires at its next occurrence,
  then `retireOnce` in `src/scheduler.js` writes it back `enabled: false`
  (copy in `.history/`) and DMs.
- **Try it** (`tryProposal` in `src/review.js`, a button on every
  proposal that is not settings or a deletion): the routine's dry run on
  the PROPOSED file — the edited routine, or a scheduled routine with the
  proposed `identity.md`/`memory.md` as `overrides` to `runRoutine` — shown
  in the DM, charged to the review lane, nothing applied or posted.
- **DM tools beyond the files:** `status` (`statusReport`: build,
  contract, budgets, turns, cursors, routines, the review), `search_turns`
  (`ledger.searchTurns`: text over question/answer/tools/routine with
  lane/routine/date filters; the review lane has it too, for measuring a
  previous edit beyond the window), `estimate_cost` (`estimateMonthly` on
  proposed fields), `deck_link`. Commands: `status`, `feedback`
  (`elixir_my_feedback`).
- **`deck_link`** (`src/deck-link.js`) is the one local tool a MEMBER's
  turn gets: a pasted `link.clashroyale.com` / `clashroyale://copyDeck`
  link carries eight card ids and the tower troop in the URL (`slots` is
  always zero — a link never says what is evolved); resolved through
  `cards_catalog`. Text, not the web. Its errors are ours
  (`LOCAL_TOOLS` in `src/feedback.js`), never hub friction.
- **Screenshots in the ask lane** (`imageBlocks` in `src/ask.js`): up to two
  image attachments on the member's own message ride the turn as `image`
  blocks (URL source, Discord's CDN — the member's upload, not the web;
  same class as the DM's text attachment). The prompt says a picture is
  what they showed the bot, never a recorded fact, and cannot override
  instructions. The ledger notes the URLs.
- **Read the room** (`roomTool` in `src/run.js`, `recent_channel_messages`):
  a routine turn may read the last two hours in a directory channel before
  posting there; `POSTING` tells it to, and not to restate what the room
  already knows. Members' words enter that turn and its ledger record, as
  every tool result does, and nothing else.
- **`retract <turn id> — why`** (DM): deletes every message a turn produced
  (posts and answer parts from the ledger, footers from `state.messageTurns`),
  records a `retraction` on the turn — the strongest review signal, shown
  first — with the reason if given.
- **`tell_operator`** (ask lane): a member's request that is not a question
  about the record reaches the operator as a `member request` notice, once
  per turn, three per member per day (`state.operatorRequests`).
- **`ASK_DAILY_TURNS_PER_MEMBER`** (config.json, default 20, live): one
  member cannot drain the shared ask pot; admins exempt; `state.askCounts`.
  Since 2026-09-25 a question is counted when its turn STARTS (and given
  back if the turn fails on our side): counted after the answer, five
  questions sent at once all passed a cap of two.
- **Every accepted change is a commit** (`src/instance-git.js`) when the
  instance directory is a git repository: apply, undo and a one-shot's
  retirement commit `config.json` and `agent/` with the proposal's summary
  as the message and its provenance (file, op, review or DM, turns, who)
  as the body. Zero config: no `.git`, nothing happens. **Local only, never
  a remote, never a push** (Jamie, 2026-09-15). `initInstanceRepo` (setup
  offers it, default yes) writes a `.gitignore` for `.env`, `state/` and
  `.history/` — the pre-git backups are not history twice — and refuses to
  proceed if `.env` or `state/` is tracked. `commitInstance` never runs in
  the checkout (`repoRoot`) and only when the written files are inside the
  instance (`repoFor`). Jamie's three instances are repos since 2026-09-15.
- **The operator changes settings from the DM** (`src/settings.js`).
  `propose_change` with `file: "config.json"`, `op: set_config`, `fields:
  {KEY: value}` on an ALLOWLIST (`SETTINGS`: budgets, `CLAUDE_*`,
  `REVIEW_*`, `TIMEZONE`, `EVENT_POLL_SECONDS`, `STARTUP_MESSAGE`,
  `MAX_POSTS_PER_TURN`, `VOICE`, `COMMAND_PREFIX`, `FEEDBACK_CHANNEL`,
  `ADMIN_USER_IDS`, plus `CHANNEL_*` resolved against the directory) —
  which is every key `config.json` holds; secrets and wiring are in
  `.env`, which the DM cannot reach. Each value is checked the way setup checks it
  (`checkSetting`: a priced model, an IANA zone, numbers, `parseReviewAt`;
  an admin may not remove themselves). `withSettings` changes only the
  named keys; the preview is the diff. Apply writes `config.json` with a
  backup under `<instance>/.history/`, then, when `serviceManaged()`
  (launchd or systemd is the parent, or `SERVICE_MANAGED=1`), sends itself
  SIGTERM after the reply so the supervisor brings it back on the new
  values; otherwise the message says a restart is needed. Undo restores
  the backup, same rule. The review lane cannot touch settings (`planEdit`
  refuses without `edit.by === "owner"`). `settings` in the DM shows the
  current values. **Since the same day, settings are LIVE**: `config.js`
  re-reads `config.json` when its mtime moves and exposes settings as
  getters, so a change is in effect on the next use; only
  `COMMAND_PREFIX` and `EVENT_POLL_SECONDS` (`restart: true` in
  `SETTINGS`) restart the process, and `REVIEW=on` needs one for the slash
  command to appear (the lane itself runs live — the clock ticks whether
  or not it is on). Tests assign `config.x = …`; that is an override map,
  not the file.
  `models.json` stays terminal-only on purpose: a wrong price typed in chat
  silently defeats every budget. `append` now works on `identity.md` and a
  brief too (raw text at the end) for "add a house rule".
- **A long paste is an attachment.** Over 2,000 characters Discord sends
  `message.txt` instead of text, and the first pasted FAQ arrived as an
  empty message. `attachedText` reads text attachments (text/* or
  .txt/.md/.csv, ≤200 KB, ≤60K chars) from Discord's CDN — the operator's
  own upload, not the web, which was tried for the DM and pulled the same
  day (`web_fetch` needed a code-execution container across rounds, and a
  fetched page is not the operator's words the way a paste is).
- **What the DM never does:** post to a member channel. There is no
  `post_message` tool in the lane; `post it` sends only a rehearsal the
  operator has already read. The DM brief also refuses to remember game
  facts (Elixir's) or anything about a person beyond the role Elixir
  shows (a hold in Elixir Clan, not a prompt line).
- Needs the `DirectMessages` intent and `Partials.Channel`; without them a
  DM never arrives and nothing says so.

## The turn ledger — since 2026-09-14

`src/ledger.js` appends one JSON line per turn to
`<instance>/state/turns/YYYY-MM-DD.jsonl`, and `npm run turns` reads it back
as transcripts. It exists so the QUALITY of what the bot says can be judged:
before it, the log line had tool names and a price, `state.json` kept 200
turns with the answer clipped at 1200 chars and no tool inputs, and the
structured trace was rendered into the Discord footer and dropped. To ask "was
that number right?" you need the tool's result body, and nothing kept it.

- **Three record kinds, all keyed by `turnId`, all append-only:** `turn`
  (inputs — the question and thread history, or the brief and the timeline
  handed in; the system prompt's sha; the trace with every call's arguments
  AND result body, bounded at `LEDGER_BODY_CHARS`, 16 KB; the answer, where
  it went, footers, ungrounded/friction flags; usage and cost), `reaction`
  (👍/👎 with the reader's note) and `filed` (what the sweep sent upstream).
  Later signals are their own lines; `readTurns` folds them in on read.
- **The prompt is stored once per wording** at `state/prompts/<sha>.txt`,
  first time a sha is seen. Instance prompts live outside any git checkout,
  so this is the only record of which wording produced which answer.
- **Dry runs are not recorded.** `npm run try` is a rehearsal; the ledger is
  what Discord saw.
- **It never fails a turn.** `append` swallows and logs `ledger_write_failed`.
- **It holds members' names and questions.** It lives under `state/`,
  gitignored, and stays in the instance directory.
- **`src/claude.js` keeps each call's result body on its trace step**
  (`step.result`) for this; `renderTrace` does not show it and must not.
- Reading: `npm run turns -- --since 2026-09-13 --lane ask`, `--routine
  <key>`, `--turn <id>` (full bodies), `--full`, `--json`, `--export <dir>`
  (one `.md` per turn plus the prompts they ran on), `--instance <dir>` to
  read another instance's ledger. No `.env` is needed to read one —
  `ledger.js` resolves the instance directory itself rather than importing
  `config.js` for that reason.

## The record is the trigger — since 2026-09-17

Jamie, 2026-09-16: "make the record the trigger, not the calendar." The
proposal and its evidence are `docs/PROACTIVE-2026-09-16.md` (65 routine
turns across three instances: 29% produced nothing, every one the calendar
asking on a day the record had nothing; movers spent 9.9 calls a turn
rebuilding streaks the hub already computed; the spotlight was the most
expensive, least grounded routine and manufactured by weekday). Jamie said
yes to all six decisions the same day. What changed:

- **One editor routine on the timeline** (`agent/routines/editor.md`)
  replaced clan-feed, notable-movers, pilot-spotlight, capability-spotlight
  and rival-scout. Its front matter names `wake:` kinds (a turn now) and
  `carry:` kinds (ride in the next batch); `kinds:` alone still means every
  one wakes. `partition` in `src/events.js` splits a window; carried items
  live in `state.carry[routine]` (`CARRY_CAP` 60) until a wake item takes
  them or the **carry release** lets them go: `releaseDue` over the
  silence clock, past `CARRY_RELEASE_HOURS[config.voice]` — quiet never,
  normal 12 h, chatty 4 h. The poll passes `kinds` to the server (contract
  3.9.0) so the bot reads only what it subscribes to. The brief has four
  desks — news, scouting (`bracket_observed`), movers (`session_standout`),
  recognition — plus texture and the pasteable-question habit that is all
  that survives of the spotlight.
- **`trigger: clock`** (`src/clock.js`): armed from one `game_clock`
  field plus an offset (`arm: war_day_closes_at`, `offset: -4h`), one
  clock read plans every clock routine, re-planned at `day_ends_at` and
  after a fire; the run-ledger key is the boundary's instant, so a
  boundary fires once across restarts; a training day (field null) arms
  nothing; first sight of a routine seeds a boundary already behind it
  (seed, never drain). `war-deck-check` is the one shipped clock routine.
  An edited `arm`/`offset` takes effect at the next plan — the day roll or
  a restart; the brief hot-loads as ever. The hub's 09-13 line holds: war
  day open/close stay clock facts and the routine schedules itself.
- **`schedule` is the exception.** `meta-report` is the one shipped
  calendar routine; the DM still creates them ("remind the clan Friday").
- **The regulators.** SKIP stays, narrower ("the room already knows").
  `recall` is dropped from every shipped file (a ledger moment is emitted
  once; the field stays for operators). The nudge stays (a model
  mechanic). **The silence line and the VOICE block are gone from the
  prompt** (`prompt.js` no longer has `VOICES`, `silenceLine`, a `voice`
  option or `input.silence` in the ledger); `state.silence` survives as
  the carry-release input, stamped by `rememberPostAt` and seeded from the
  ledger at boot as before. VOICE's three names keep their hours and mean
  a coalescing interval. This reverses the 2026-09-16 "never a scheduler
  change" line: with the record deciding when, the only "how much" left is
  whether texture ever earns a post of its own, and that is a release
  interval, not a lean.
- **The hub half** shipped the same evening as contract 3.9.0
  (`elixir-mcp/docs/reviews/2026-09-16-TIMELINE-FOR-PROACTIVE.md`):
  `session_standout`, `bracket_observed`, `kinds`, named badge/card
  moments, `clans_standings` trophy_net + current_streak.
- **Rolling it out to an instance** is the 2026-09-13 rule: restart on
  the new code first (`wake`, `carry`, `arm`, `offset` and `trigger:
  clock` are new fields), THEN sync the routine files; the old `clan-feed`
  cursor is left behind and `editor` seeds its own at the next poll.

## The model picks the channel — since 2026-09-13

`src/directory.js` + `post_message` in `src/run.js`. A scheduled or event turn
gets a system block listing the channels it may post in (name, topic, who can
see it — `visible to: Leader, Co-Leader` from the role overwrites — and which
one is the ask channel) and a client-side `post_message(channel_id, content)`
tool; the model chooses. `channel:` on a routine is now an optional DEFAULT
hint (bound in `.env` or matched by channel name); no `post_message` call =
skip; prose with no call still goes to the default (legacy), or is
`post_without_destination` if there is none.

- **Prose with no call is asked again, once (2026-09-16).** With the
  posting rule first and `DELIVER` last, Sonnet 5 still ended one
  substantive turn in four in prose — the post written, nine tool calls
  behind it, no `post_message` (3 of 12 across the three instances,
  2026-09-14..16; `notable-movers` and `capability-spotlight`). Each was a
  paid turn and a "routine had nowhere to post" alert. `ask()` now takes a
  `nudge({ text, called })` hook; the runner's `deliveryNudge` returns
  `notDelivered(routine)` when the reply is neither a post nor (for a
  `may_skip` routine) SKIP, and the turn gets ONE more round with that as
  the user message — same turn id, cached prefix, `nudged: true` in the
  ledger and `nudged` in the `turns` footer. A turn that still will not
  call the tool ends as before. The nudge is a mechanics fix, not a prompt
  fix: do not answer this failure by making `DELIVER` longer.
- **A cutoff is not a SKIP (2026-09-21).** Turn c0aa7196 (poapkings,
  `meta-report`, effort high): four big meta reads, 6,408 output tokens,
  `stop_reason: max_tokens` inside the thinking, no text — and `isSkip("")`
  is true, so the runner ledgered the week's report as a deliberate skip.
  No post, no notice, nothing in the channel; review 6f5cd835 found it.
  Now the same nudge hook answers `max_tokens`: `ask()` calls
  `nudge({ text, called, truncated: true })`, `deliveryNudge` returns
  `outOfRoom(routine)`, and the turn gets its ONE extra round with a fresh
  `max_tokens` — the assistant turn echoed back as the `pause_turn` path
  already does, minus any client-side `tool_use` (its input may be cut
  mid-argument; the API guide says never run one from a `max_tokens`
  response, and an echoed `tool_use` without a result is a 400).
  `resumed: true` in the ledger and `resumed` in the footers say a post
  was delivered on the second ask, which is the signal that the routine's
  ceiling is too low for its effort. A turn STILL `truncated` with no post
  is `routine_truncated` + a "routine ran out of room" DM, `error:
  "truncated"` in the ledger, and `ok: false` — the run ledger was marked
  before the call, so it does not re-fire. Partial prose is never posted.
  `ask()` takes an injectable `stream` for the loop's tests
  (`test/claude.test.js`). Not changed: the 6,000 default `max_tokens`
  in `src/routines.js` — a routine that resumes every week wants its own
  `max_tokens:` in its front matter, which is the operator's call.
- **`max_chars` is refused, not chunked (2026-09-21).** Review 6feff89e
  (shipit, turn 47f426a1): a 2,060-character meta-report on a `max_chars:
  1400` routine went out through `post_message` as two Discord messages,
  unflagged — `post(channel, text, routine.maxChars)` used the limit as a
  chunk size, the tool's description said "up to the routine's length
  limit" without a number, and nothing in the turn named one. Now
  `postToolFor(routine)` renders the limit into the tool's description
  and the `content` schema, `deliverLine(routine)` puts it in the user
  turn beside DELIVER (per routine, so the cached prefix is untouched),
  and the handler answers over-length content with `too_long` — a local
  tool error the model sees and shortens for (`LOCAL_TOOLS` keeps it out
  of friction filing). It does not count against the post cap. Nothing
  is truncated: a report cut mid-sentence is the same failure as a lost
  one. `post()` now caps its chunk at Discord's 2,000 whatever limit it
  is handed, so a `max_chars` above it cannot produce a rejected send.
  The legacy prose path (no directory) and the DM's `post it` still chunk
  at `max_chars`: there is no tool there for the model to react to.
- **The silence clock and VOICE (2026-09-16; the prompt half retired
  2026-09-17, see "The record is the trigger").** The SKIP rule points one
  way, and a bot judging "worth saying?" against the same bar an hour after
  its last post and a day after had no idea POAP KINGS heard nothing for
  ~29h (five SKIPs in a row plus the lost post above). Then
  `state.silence(entries)` gives hours since THIS bot last posted in each
  directory channel it may post in (`rememberPostAt` on every routine post,
  including the DM's "post it"; ask-lane answers do not count; a channel
  with no stamp is anchored on first sight and shown as `≥`; at boot
  `seedPostTimes` fills missing stamps from the ledger's last 14 days —
  timestamps and channel ids only, never content). `silenceLine` puts it in
  the USER turn beside the date, naming which channels are past the line,
  so the cached prefix is untouched; the lean is `VOICES[config.voice]` in
  the system block, after the SKIP rule, only for a `may_skip` routine with
  the directory. Jamie set the lines: `quiet` 72h, `normal` 12h (default),
  `chatty` 4h. It is a lean on a skip decision, never a scheduler change:
  no extra turns fire because a channel is quiet, and grounding and "do not
  repeat" hold at every level. The ledger's `input.silence` records what
  the turn was told.

- **The directory rule: EXPLICIT grants only.** A channel is in the
  directory when an overwrite for the bot's role or the bot itself allows
  Send Messages. Inherited @everyone permission does not count — on POAP
  KINGS that would be 20 channels; explicit is 2. A `CHANNEL_*`-bound
  channel is always in. Do not "simplify" this to effective permissions.
- **Read-only entries (2026-09-15).** An explicit View overwrite WITHOUT
  Send is also deliberate — the operator let the bot into a channel to
  look — and is in the directory as `role: "read"`: `post_message` refuses
  it (`read_only`), `recent_channel_messages` and the DM's `read_channel`
  read it. The first was #elixir, the older bot's channel, opened so this
  bot could study what it is meant to replace; the bot told the operator
  the channel had to be "added as a `CHANNEL_ELIXIR` config entry", which
  has not been true since 2026-09-13. The DM brief now states the rule
  (Discord permissions, nothing configured, re-read within a minute) and
  `list_channels`' description says the same, so the model cannot invent a
  registration step. `read_channel` is the operator's study tool — whole
  messages, embeds, 100 a page, `before` to page back — and lives in the
  DM lane only; routines keep the two-hour room tool. Jamie's intent for
  read-only channels is LISTENING: "a good way for the bot to listen to
  what is being discussed for awareness" - member channels opened View-only
  so a routine reads the mood before it posts elsewhere. The posting rule
  says so (read them when what members said could change the post; never
  post there; never quote a member's words into another channel).
- **The ask lane never gets the tool or the directory.** Its input is
  untrusted; where it listens stays an explicit binding. `postTool` also
  refuses `role: "ask"` channels, the post cap (`MAX_POSTS_PER_TURN`, 3),
  and ids outside the directory — as tool errors the model sees, which
  `unexpectedErrors` excludes from feedback filing (they are ours).
- **Two builders, one classifier.** `fromGateway` in the service,
  `fromRest` in the CLI and setup, both through `classify`; a dry run prints
  `# directory: …` and each `=== #channel ===` the model chose.
- **The posting rule is the FIRST system block** and the user turn ends with
  `DELIVER`; with it in the middle Sonnet 5 replied in prose and never
  called the tool (observed on the first dry run).
- The trace footer shows `post_message {channel_id}` only, never the
  content — it is already above the footer.

## It is an AGENT, not Jamie

Since 2026-09-08 this bot authenticates as its own principal — an Elixir MCP
*agent* (`public_id 272bd891a21d`, owned by Jamie's account) with its own key,
its own event cursor and its own feedback inbox, at its own door
`/a/272bd891a21d/mcp`. Its key is refused at the personal `/mcp`.

Riding Jamie's account, this bot could answer "what players do you track?" with
his personal claimed-player list, and on first boot it posted eight of his
answered feedback items into a public channel. Both are impossible by
construction now: the agent surface publishes 36 tools, and
`elixir_my_players`, `elixir_track_player` and `elixir_track_clan` (the
`elixir_add_*` names before contract 1.0.0) are absent *and* refused on call.
**So do not add them to a prompt.**

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

Three monthly pots, split by who spends them: `MONTHLY_BUDGET_USD` for what the
bot decides to do (schedules, event briefs), `ASK_MONTHLY_BUDGET_USD` for
what clan members ask for (their 👎 sweeps included), and
`REVIEW_MONTHLY_BUDGET_USD` for the operator: the review lane and every DM
turn. One pot would let a chatty afternoon cancel the 01:00 war-deck post,
with silence as the only symptom.

**Since 2026-09-25 setup asks for all three and every surface shows all
three.** Setup asked for two, so the third was unset — unlimited — on every
install, and `budget.status()` hid the review lane while `REVIEW` was off,
so the boot log's unlimited-budget warning, `/budget` and `status` never
mentioned that the operator's DM turns (on `REVIEW_MODEL`, Opus at high
effort by default) had no ceiling. The status line reads `review + DMs`.

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

- **Omitting `clan_tag` defaults to the agent's clan — since 2026-09-09.**
  Before that (observed 2026-09-08 on contract 0.37.0) `war_current {}` and
  `clans_roster {}` answered `not_entitled: No recorded clan membership` on a
  connection whose own principal block named the clan, and `subjectBlock()` in
  `src/prompt.js` carried a workaround telling the model to pass the tag
  explicitly when a tool claimed not to know. That instruction is gone (1.0.0
  pass); the block still names the subject as context. If a bare call ever
  answers `no_subject` again, that is a server regression to file, not a reason
  to teach the model the tag.
- **The feedback ledger is read on the hint, not on the clock.** Since 1.0.0
  every response — `elixir_timeline` included — carries
  `meta.feedback_responses_pending`; `startEventLoop` reads
  `elixir_my_feedback` only when the last feed poll said it is non-zero, and
  always on the seeding run. Before that gate the bot re-read its whole ledger
  every 300 s: 761 metered calls a week to learn nothing. A tick with no hint
  at all (no event routine, or a pre-1.0.0 server) reads as it used to, so a
  missing signal never turns into silence. Since contract 3.8.0 the read follows
  each `next_offset` page; the first request omits offset so the reader remains
  callable against an older server that does not declare pagination.
- **Recall is per ROUTINE, from its own ledger — since 2026-09-13.** Before
  that `recall: N` fetched the channel's last N bot messages, which in a
  shared channel were the feed's and the movers' posts and never the
  routine's own: the capability spotlight demonstrated rival scouting three
  days out of five with `recall: 5` in force. `state.rememberPost` /
  `recentOwnPosts` are the ledger; the channel read is only the fallback for a
  routine that has never posted since the ledger existed.
- **Failed calls get a footer even without a trace.** On 2026-09-11 a
  spotlight presented pros-collection stats after four of its eight calls had
  failed, and the only sign was the sweep note under it saying "possible
  fabricated data". The maintainer's reply (#33) asked the preview for a
  consumer-side guard. `errorFooter` in `src/trace.js` is it, and the prompt
  now says stop after two identical failures. Do not make the footer
  conditional on `trace`.
- **A reply with figures and no tool call is caveated.** "How am I playing?"
  was once answered from the previous exchange with zero calls. `looksUngrounded`
  is the check; events handed to a routine count as a source. Do not file it
  as hub friction — it is this consumer's behaviour, not the server's.
- **Eight tool calls in a turn is friction.** `detectFriction` files
  `many_calls` above `MANY_CALLS`; a movers run once made thirteen
  per-member calls and never told anyone. Errors and the trace carry
  `meta.request_id`, and the sweep hands failing ids to the model so a filing
  names the exact call.
- **A reply that says it filed, with no `elixir_send_feedback` call, is friction
  of its own kind — and the DM lane sweeps too (2026-09-15).** The operator
  DM'd "filing as a bug is the right call" and the bot answered "Filed as a
  data-quality bug against elixir_timeline ... with the request_id
  attached" after four reads and no filing; the DM lane had no sweep and
  hard-coded `friction: null`, so the false statement stood. `claimsFiling`
  (`CLAIM_MARKERS`, over-inclusive like the limit markers) makes
  `detectFriction` return `claimed_filing`, which outranks the other
  signatures; the sweep is told the claim is false as it stands and either
  files the item so it becomes true (the 📮 footer) or declines, in which
  case `UNFILED_FOOTER` goes under the reply — a fact about the turn, not
  the sentence, so it stays true when the reply was discussing someone
  else's filing. `converse` in `src/dm.js` now runs `detectFriction` and
  the sweep on the review lane's pot, records `friction` on the turn and
  `filed` in the ledger, and takes `sweepFn` for tests. The prompt says it
  too: never claim a filing the call does not back.
- **Ask history skips footers and pinned messages.** `isConversational` in
  `src/ask.js` drops bot messages starting with `-#` (traces, filed notes,
  the placeholder) and anything pinned; before that the model read its own
  tool arguments and cost lines as prior answers.
- **The feed poll defaults to 1800 s.** Five minutes was 288 metered calls a
  day for a feed that is empty most of the time — over half a member's daily
  allowance, and against the hub's own "hourly is plenty". This install sets
  `EVENT_POLL_SECONDS=300` explicitly because the agent has no ceiling and the
  preview wants joins posted within minutes; the shipped default is for
  everyone else.
- **The ask lane answers in a thread per question — since 2026-09-13.**
  History used to be channel-wide, so one member's question arrived with
  another's context and the model once answered "same as above" to the
  wrong person. `handleAsk` starts a thread from a top-level message and
  answers inside it; a message whose channel `isThreadOf` the routine's
  channel is a follow-up and gets the thread's history (starter first). If
  `startThread` fails (permissions) the lane falls back to replying in place
  until restart. Do not put history back on the channel.
- **Reactions are feedback.** `src/reactions.js`: 👎 sweeps the turn (one
  reflection, at most one filing, request ids quoted), 👍 files praise with
  no model call. `state.rememberTurn` records every message id a turn
  produced — the post AND its footers — so a reaction on either resolves.
  Needs the `GuildMessageReactions` intent and Message/Reaction/User
  partials, or reactions on posts older than the process never arrive.
  **Since 2026-09-25 a 👎 sweep is the ask lane's and bounded.** A bare 👎
  the sweep declined released its mark (so a reply could follow), which
  meant removing and re-adding it swept the same turn again — a paid call
  and a "Noted" line per toggle, charged to the POST's lane, so any member
  could spend the budget the scheduled posts run on. Now a turn is swept
  without a note once (`reactions.bare`), at most `SWEEPS_PER_TURN` (3)
  times in all (`state.countSweep`), and every sweep is charged to `ask`:
  a member started it.
- **Cache breakpoints on the toolset and the system block.** Verified live:
  a second consecutive turn was 89% cache reads and cost a third of the
  first. Keep the system block a stable prefix — the asker's id rides in the
  user turn for exactly this reason — and keep `cache_control` on the
  `mcp_toolset`; the trace footer's `cache N%` is how you notice it broke.
- **Tool errors carry a code.** `readToolActivity` keeps `error.code` (from
  the contract's closed set) beside the message, and `detectFriction` decides
  on it: `no_subject` (ask who is asking) and `quota_exceeded` (the ceiling
  working) are expected flows and never trigger the sweep.
- **A turn can end with a CLIENT-side `tool_use` on an all-server-side
  connection.** With an `mcp_toolset`, most calls come home as
  `mcp_tool_use`/`mcp_tool_result` in one response — but sometimes the API
  returns an ordinary `tool_use` named `<server>_<tool>` and `stop_reason:
  "tool_use"`, asking the client to run it. Unhandled, the response has no text,
  and the runner read that as SKIP: a turn that did all its work and posted
  nothing. `src/claude.js` executes those over the direct MCP client and
  continues. Echoing the assistant turn back *without* results is a 400.
- **One reading of a tool result, whoever ran it (2026-09-17).** A result
  reaches `src/claude.js` three ways — an `mcp_tool_result` block the
  connector ran, a `tool_use` the API handed back for the direct client,
  a local tool's handler — and each had its own bookkeeping: three
  definitions of "failed", two error-body shapes, shape/request id set on
  one path only. Now `outcome(raw, {isError})` is the single reading
  (`ok`, `body`, `code`, `detail`, `requestId`), `settle` the single
  recorder (trace step, `errors`, `envelopes`), `executeClientSide` the
  single executor for anything the API asks us to run. The log line is
  `client_tool_call` with `via: local | mcp`. A direct-client refusal now
  hands the model the refusal body itself (code and request id) instead of
  a paraphrase. Do not add a fourth path; add a case to `outcome`.
- **The renamed tool does not un-rename by prefix strip.** `elixir_send_feedback`
  came back as `elixir-mcp_send_feedback`; stripping the server name gives
  `feedback`, which is not a tool. `resolveToolName` matches against the live
  `tools/list`.
- **The feed is a TIMELINE since contract 3.0.0 (2026-09-13, two shape
  changes in one evening).** The tool is `elixir_timeline` (a named
  `reader` + our own ISO cursor, below); the response carries `timeline[]` — what
  happened, typed items `{at, observed_at, subject_tag, subject_name, kind,
  section, text, facts}`, NEWEST first since hub contract 7.0.0 (2026-09-23,
  the timeline is a newsfeed) — and `entries[]`, one per subject as context
  (for an agent, ONE clan entry). A routine wakes only for the item kinds
  or sections it names (`kinds:` / `sections:` front matter; `relevant()` in
  `src/events.js`): a routine naming nothing fires on every poll. The model
  is handed `{window, timeline: items, entries}` with the items re-sorted
  OLDEST first by `oldestFirst` — what `prompt.js` and the editor brief
  tell it — in the live lane and, since 2026-09-25, the dry run too, which
  had passed the hub's newest-first order straight through (and now asks
  the server for the routine's kinds and reads a busy pending window to its
  start, as the live lane does). A file still saying
  `topics:` fails to parse with the migration in the message. There is no
  war-day-open item; a war-day post is a `clock` routine's job
  (`game_clock` says when; since 2026-09-17).
- **A busy window is read to its start — since 2026-09-25.** Since hub
  contract 7.0.0 a window past the hub's page budget (~40,000 characters)
  serves only its NEWEST items, counts the older ones in `timeline_more`
  and sets `has_more`; the note says to read them with the same `from`,
  `to` at the cut and `mark_read: false`. The lane read one page and moved
  its cursor to `next_cursor`, so every older item — a join under an hour
  of badges — was never posted, and nothing said so. `readWindow` in
  `src/events.js` now reads those pages back before the turn (no reader,
  `mark_read: false`, the same `kinds`), at most `MAX_CATCHUP_PAGES` (4)
  more, and hands every item to one turn oldest first. The cut is taken
  from the items — one millisecond before the oldest `observed_at` served
  — not from the note's prose. `events_busy_window` logs a catch-up;
  `events_unread` (WARN) counts what the bound or a one-instant burst
  left unread. A failed continuation fails the poll, so the cursor stays
  and the next tick reads the window again.
- **The read pointer is per READER — since hub contract 3.18.0
  (2026-09-18).** Until then the hub kept one pointer per ACCOUNT (an
  agent is its own account), so every routine polled with `mark_read:
  false` and the rule here was never to flip it. Now each event routine
  polls as its own `reader` (`readerName`: `<instance>-<routine>`) with
  `mark_read: true`, which moves that reader's pointer only — never the
  account's unnamed one, never another routine's or instance's — and makes
  `meta.timeline_pending` count against it. The local ISO cursor in
  `state/state.json` still decides `from`, and it moves only after a
  successful turn, so a failed turn re-reads its window even though the
  hub's pointer ran ahead; a pre-2.0.0 integer cursor re-seeds from now.
  Reads that must move nothing — the seed, the dry run, `npm run probe`,
  a busy window's older pages — pass no reader and `mark_read: false`.
  Never mark without a reader: that moves the account's shared pointer.
- **Seed, don't drain.** First run saves the timeline window's end and starts there;
  the scheduler marks every routine's current period as done; the feedback
  ledger marks history as shown. All three have posted a backlog into a channel
  at least once. Do not "helpfully" replay.
- **The container mounts the whole instance — since 2026-09-25.** The
  Docker recipe mounted `state/` and `agent/` and passed `.env` as
  `--env-file`, which was right until settings moved to `config.json`
  (2026-09-15): after that a container had no budgets (unset is
  unlimited), no admins, no ask channel, and a DM setting change was
  written inside the container and lost. The image now sets
  `INSTANCE_DIR=/instance` and `SERVICE_MANAGED=1`, carries git (an
  instance repo keeps committing), no longer `chown`s the code to the
  runtime user, and runs setup too (`node src/setup.js /instance`, which
  skips the service installer inside a container). Separately,
  `serviceManaged()` read only `ppid === 1`, but a systemd `--user`
  unit's parent is the user manager, so the README's "restarts itself
  under systemd" was false; it reads `INVOCATION_ID` now, and the unit
  template sets `SERVICE_MANAGED=1`. Not built here (no Docker daemon in
  the session that made it): build and boot it once before relying on it.
- **`state.json` is written by rename, and an unreadable one is kept — since
  2026-09-25.** Every writer in `src/state.js` is read-modify-write of the
  whole file, and `read` used to return the defaults for a torn or
  hand-broken file as it does for a missing one, so the next `markRun`
  saved the defaults plus one key: the month's spend back to $0, every
  cursor and run gone. `npm run try` and `probe` write the same file as the
  running service. Now `write` goes to a temp file, fsyncs and renames, so
  a reader never sees half a file; a file that still fails to parse is
  renamed to `state.json.corrupt-<time>`, logged as `state_corrupt`, and
  the process starts from the seed-don't-drain defaults. Do not go back to
  `writeFileSync` in place.
- **Every lane runs one pass at a time — since 2026-09-25.** Three found
  in review, none yet seen live: the scheduler's `setInterval` overlapped a
  tick that was still on a slow routine, and the second tick ran the next
  due routine that the first then ran again (`tick` now re-reads `runs`
  before each `markRun`, and `startScheduler` skips a tick while one runs);
  the event loop's did the same with a turn longer than
  `EVENT_POLL_SECONDS`, reading the unmoved cursor's window twice
  (`events_tick_skipped` now); and a clock boundary the budget declined is
  left unmarked by design, so the re-plan after the decline armed it again
  at zero delay — 30 `game_clock` reads in 50 ms in the test, for the whole
  catch-up window live. `fire` returns `{ blocked }` and the lane holds that
  boundary `RETRY_MS`. A failed release turn also no longer carries the
  same items twice (`addCarry` keeps one of each).
- **A post is a post once Discord has it, and only then — since
  2026-09-25.** Every client-side tool result is followed by another API
  round, and when that round failed (a 529, a dropped stream) `ask()`
  returned `ok:false` with no `turnId`: the runner reported a failed
  routine, the event cursor stayed, the next poll posted the same news
  again, and the ledger's reader dropped the record, so `why` and
  `retract` could not find a message that was in the channel. Now every
  `ask()` return carries the turn's `summary()` (turnId, usage, rounds),
  and `runRoutine` treats a failure with `posts.length > 0` as delivered
  (`routine_failed_after_post`, `error: "after_post: …"` in the ledger).
  The other half: `post_message` pushed its record before the send, so a
  send Discord refused still counted as posted; it is recorded after, a
  refusal is a `send_failed` tool error the model sees, and `post()` puts
  the parts already sent on `error.sent`.
- **Sonnet 5 has no mid-conversation system messages** and rejects
  `budget_tokens` and sampling params. Thinking is `{type: "adaptive"}`; depth
  is `output_config.effort`.
- **Haiku 4.5 takes neither — since 2026-09-25 it is sent neither.** Every
  call sent adaptive thinking and `effort`, so `model: claude-haiku-4-5` —
  the README's own example — was a 400 on every turn, and nothing caught it
  because the model has a price. The price book carries `adaptive` (the
  catalog marks Haiku `false`; `models.json` can mark another), and `ask()`
  leaves both out for such a model. `ask()` also reads the price BEFORE the
  call now: boot checks the models it can see, but a routine's `model:`
  edited later reached the API and `costOf` threw on the response — a paid
  call no budget recorded, repeated every poll. `model_unpriced` in the log.
- **A shell variable used to outrank `.env`.** dotenv does not override
  `process.env`, and an exported `CLAUDE_EFFORT=high` ran this bot at high
  effort for an evening. Since `config.json` (2026-09-15) a setting the file
  names wins over the shell; only secrets, wiring and path overrides still
  come from the environment. The boot log's provenance line says which.
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
