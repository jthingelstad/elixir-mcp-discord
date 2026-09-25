# The model picks the channel — since 2026-09-13

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/directory.js, src/run.js, the POSTING and DELIVER blocks in src/prompt.js.*

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
  2026-09-17, see timeline.md).** The SKIP rule points one
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
