# The DM is the operator's console — since 2026-09-14

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/dm.js, src/notify.js, src/settings.js, src/instance-git.js, src/link.js.*

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
- **Review proposals** (review.md).
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
  instance (`repoFor`).
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
