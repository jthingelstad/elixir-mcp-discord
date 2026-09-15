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
surface. `trigger` is `message`, `events` or `schedule`; `channel` is a logical
name bound to an id by `CHANNEL_<NAME>`; the body is the prompt. `src/` is a
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

**Public repo, no secrets.** `.env` and `.env.*` are gitignored, `state/` is
gitignored. Check `git ls-files` before assuming something is untracked. Since
2026-09-13 the live instances keep nothing in the checkout at all — see below.

## Three bots, one checkout — since 2026-09-13

The **instance is a directory** — the cwd, or `INSTANCE_DIR`. `.env`,
`agent/` and `state/` resolve against it, never against the checkout
(`instanceDir` in `src/config.js`, `STATE_PATH` in `src/state.js`). The live instances are

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
  / `routines`. (Your shell's `CLAUDE_EFFORT=high` shadows every instance's
  .env for CLI runs — the provenance line says so; launchd is unaffected.)
- **`npm run setup -- <instance-dir>` is the whole process** (`src/setup.js`,
  helpers in `src/setup-catalog.js`, `src/discord-rest.js`, `src/env-file.js`):
  Elixir key, Claude key and Discord app each tried against its service BEFORE
  `.env` is written; invite link printed when the bot is not in the server; a
  routine picker over the checkout's `agent/routines` (each carries a
  `description:` front-matter field — a real field, the parser rejects
  unknown ones); schedule times rewritten in the instance copy; channels
  picked from the server's list and permission-checked over REST
  (`computePermissions` reproduces Discord's overwrite algorithm so
  `inspectChannel` judges a REST channel by the boot check's rule); clan
  notes appended to `identity.md` once; budget estimate; admin ids checked as
  members; then an offer to install the service and show the boot lines.
  **Setup only ever ADDS routine files** — never overwrites or deletes one;
  chosen-off is `ROUTINES_DISABLED`. `--check` is the no-prompt form and
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
  `elixir_feedback` filing (the hub).
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
  question, edit anything outside `agent/`, edit a routine's front matter,
  read the ledger into a member-facing turn. The `EDITABLE` pattern and
  `planEdit` are the fence; the tests pin them.

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
  brief, forced `(from owner)` provenance and `edit.by = "owner"`),
  `lookup_turn`, and Anthropic's server-side `web_fetch` (`serverTools` in
  `ask()`; this lane ONLY — it reads URLs already in the conversation, so a
  pasted clan FAQ becomes proposed memory lines and a member can never make
  the bot read anything). A proposal rides the review machinery — a `review` record
  with `trigger: "dm"` — so Apply/Skip/Undo and `.history/` are the same
  code. Charged to the `review` lane; ledgered as lane `dm`.
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

## The model picks the channel — since 2026-09-13

`src/directory.js` + `post_message` in `src/run.js`. A scheduled or event turn
gets a system block listing the channels it may post in (name, topic, who can
see it — `visible to: Leader, Co-Leader` from the role overwrites — and which
one is the ask channel) and a client-side `post_message(channel_id, content)`
tool; the model chooses. `channel:` on a routine is now an optional DEFAULT
hint (bound in `.env` or matched by channel name); no `post_message` call =
skip; prose with no call still goes to the default (legacy), or is
`post_without_destination` if there is none.

- **The directory rule: EXPLICIT grants only.** A channel is in the
  directory when an overwrite for the bot's role or the bot itself allows
  Send Messages. Inherited @everyone permission does not count — on POAP
  KINGS that would be 20 channels; explicit is 2. A `CHANNEL_*`-bound
  channel is always in. Do not "simplify" this to effective permissions.
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
  every response — `elixir_events` included — carries
  `meta.feedback_responses_pending`; `startEventLoop` reads
  `elixir_my_feedback` only when the last feed poll said it is non-zero, and
  always on the seeding run. Before that gate the bot re-read its whole ledger
  every 300 s: 761 metered calls a week to learn nothing. A tick with no hint
  at all (no event routine, or a pre-1.0.0 server) reads as it used to, so a
  missing signal never turns into silence.
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
- **The renamed tool does not un-rename by prefix strip.** `elixir_feedback`
  came back as `elixir-mcp_feedback`; stripping the server name gives
  `feedback`, which is not a tool. `resolveToolName` matches against the live
  `tools/list`.
- **The feed is a TIMELINE since contract 3.0.0 (2026-09-13, two shape
  changes in one evening).** The tool is `elixir_timeline` (`mark_read:
  false` + our own ISO cursor); the response carries `timeline[]` — what
  happened, oldest first, typed items `{at, subject_tag, subject_name, kind,
  section, text, facts}` — and `entries[]`, one per subject as context
  (for an agent, ONE clan entry). A routine wakes only for the item kinds
  or sections it names (`kinds:` / `sections:` front matter; `relevant()` in
  `src/events.js`): an active clan emits a `battle_session` in nearly every
  window, so a routine naming nothing fires on every poll. The model is
  handed `{window, timeline: items, entries}`. A file still saying
  `topics:` fails to parse with the migration in the message. There is no
  war-day-open item; a war-day post is a schedule routine's job
  (`game_clock` says when).
- **The seen bookmark is per ACCOUNT (an agent is its own account).** Every
  event routine polls with `mark_seen: false` and keeps its own ISO cursor
  in `state/state.json`; a pre-2.0.0 integer cursor re-seeds from now. Never
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
