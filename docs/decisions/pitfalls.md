# Things that will bite you

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing anything; skim it before debugging.*

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
- **What breaks after boot reaches the operator too — since 2026-09-25.**
  A routine file that stops parsing while the bot runs (the 2026-09-13
  outage, exactly), a scheduled or clock routine whose bound channel cannot
  be found, and a routine that crashes were log lines only; each is a DM
  notice now, on the boot check's fingerprints. A boot that throws (an
  unpriced model, anything in the `ClientReady` handler) used to leave a
  half-started process — ask and DM answering, no scheduler, feed, clock
  or review, and no exit for the supervisor to restart — it drains and
  exits 1 now (`boot_failed`).
- **Nothing the bot writes pings anyone but the asker — since 2026-09-25.**
  Routine posts and ask-lane chunks were sent with no `allowedMentions`
  and the client set no default, so a `<@id>`, a mentionable role or
  `@everyone` (if the role were ever granted it) in a post built from the
  record, a room read or a member's question would ping. The client
  default is `{ parse: [], repliedUser: true }`; a message that sets its
  own still wins (the DM and notices already did).
- **A failed answer names the service that failed — since 2026-09-25.**
  Every ask-lane failure read "Something broke … talking to Elixir MCP",
  an Anthropic `overloaded_error` included, in the channel that exists to
  judge Elixir MCP. `failureLine` in `src/ask.js`: an error naming the MCP
  server is Elixir's, a refusal is a refusal, an unpriced model is ours,
  anything else is the model API's.
- **Ask history skips footers and pinned messages.** `isConversational` in
  `src/ask.js` drops bot messages starting with `-#` (traces, filed notes,
  the placeholder) and anything pinned; before that the model read its own
  tool arguments and cost lines as prior answers.
- **The feed poll defaults to 1800 s.** Five minutes was 288 metered calls a
  day for a feed that is empty most of the time — over half a member's daily
  allowance, and against the hub's own "hourly is plenty". An install whose
  agent has no ceiling and wants joins posted within minutes sets
  `EVENT_POLL_SECONDS=300` explicitly; the shipped default is for everyone
  else.
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
- **A container still says which commit it is — since 2026-09-25.** The
  boot line's `build=<version>+<sha>` is how a deploy is verified, and the
  image left `.git` out, so a bot built from the checkout would have logged
  the version alone. `.dockerignore` now lets `.git/HEAD`, `.git/refs` and
  `.git/packed-refs` through (never the objects), a first build stage makes
  an empty `.git` when the context has none (a tarball), and `buildId`
  reads a packed ref as well as a loose one — a fresh clone packs them.
  Not built here either; the first real build's boot line is the check.
- **Docker is the recommended install — since 2026-09-25 (Jamie's D1).**
  `scripts/install-docker.sh <instance>...` writes one `compose.yml` beside
  the instances (one service each: `restart: unless-stopped`, `init`, the
  host user's uid:gid, a 60 s stop grace for the drain, rotated json-file
  logs), builds from the checkout or, with `--image <version>`, uses the
  image `release.yml` now publishes to GHCR (amd64 + arm64) per tag. It
  refuses while a launchd job or systemd unit for the same instance runs —
  two processes on one bot token answer everything twice — and only
  overwrites a `compose.yml` it wrote. `docs/DOCKER.md` is the operator's
  page: the four words, day-to-day commands beside their launchctl
  equivalents, and moving a bot off launchd one at a time. Node on the host
  stays the path for working on the code (`npm run try` against an
  instance works either way). Not run against a live daemon in the session
  that wrote it: the first real build and boot is the acceptance test.
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
