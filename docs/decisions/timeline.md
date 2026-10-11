# The record is the trigger — since 2026-09-17

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/events.js, src/clock.js, agent/routines/editor.md.*

## The storyteller: told stories are remembered — since 2026-10-11

Jamie approved the plan of 2026-10-11 ("Let's implement it."). Elixir
Clan's Discord activity channel now posts one line per timeline item, a
deterministic ticker of record, so the editor stops being a second one and
tells fewer, researched stories. The ledger of 09-27 to 10-11 is the
evidence: 70 posts, 53 of them with no Elixir call ("No drilling" was the
brief's word), "still going" in 25 of 77 posts, "1-0 win over X (+30)" in
15, the 30-day stat block in 11, one member's streaks posted four times in
29 hours, a race finish four times on 09-27, a departure twice, and a
44-item catch-up told as a headed digest.

- **Story memory** (`src/stories.js`, `state.stories`). Each post records
  the timeline stories it told: `{ id, revision, kind, tags, crossed,
  toldAt, channel, gist }`, a week of them: player tags for the cap, never
  names or when the item happened. `post_message` takes
  `covers`, the ids the post tells; a post without it is matched by the
  names it mentions. It is the bot's own output, the same class as recall,
  never read back as a fact about the game. The framing's rule ("an id you
  have posted before…") could not be kept before: recall held text, not
  ids.
- **The turn is shown the last 48 hours of it** (`storiesBlock`, in the user
  turn, so the cached prefix is untouched), one line a story: the id and
  revision, when and where it was told, and the post's own first line.
  Nothing from the old item rides along (Codex on #57: a name or kind kept
  from an earlier timeline would be a fact the turn did not read), so a
  fact the post writes still comes from this turn.
- **A deterministic filter before every turn** (`untold`, in the live lane
  and the dry run): an id told at the same or a higher revision is dropped;
  a sitting already told is dropped unless it crossed a rung it had not
  crossed when told; and `STANDOUTS_PER_MEMBER_PER_DAY` (default 1, 0 is no
  cap) sittings per member per local day. A batch the filter empties starts
  no turn; a told carried item no longer counts toward a release. Other
  kinds told at a lower revision pass: their growth is the model's call,
  with the told story beside it.
- **The brief** (`agent/routines/editor.md`) is rewritten as a storyteller:
  research with the item's `follow` before writing about a person and post
  only what the research found; group connected items into one story; a
  batch over about twelve hours is the one or two best stories, never a
  digest; at most one historical comparison instead of a stat block; an
  opponent named only when it means something; and the observed failures
  named as prohibitions ("still going", "on a tear", "a 1-0 win over
  <name> (+30)", the 30-day block, headed lists). It ships with `recall:
  6`, as the live instance has run since 10-09, and carries the live
  brief's later rules (`left_at`, the even sitting, HOW IT READS).
- **`npm run replay`** replays story memory too: turns not replayed leave
  their original posts' stories, replayed ones their replay's, and a
  replayed batch passes the same filter (`--only` picks turns by id).

### The suggested question is retired — since 2026-10-11

The editor ended a post, when a moment invited it, with a question a member
could paste into the ask channel (the 2026-09-16 decision below: all that
survived of the capability spotlight). Sixteen posts carried one from 09-27
to 10-11 and no member asked any of them. Jamie: "We should remove this. It
doesn't work and is not useful." The brief now lists it among the things
never to write; nothing in the code ever asked for it.

## Items say where they lead — since 2026-10-11

Since Elixir 11.9.0, each item on a full read carries `follow`: the reads
that tell more of its story, a tool and the arguments to call it with. The
timeline framing tells the model to start there when it drills, instead of
working out which tool holds the story. The hub owns these addresses; the
bot builds none of its own.

## Publication-grade items: observed, publishable, one per story — since 2026-10-11

Elixir 11.8.0 (feedback #373-#376) moved the guardrails this bot's
prompts carried into the hub's output. An item's `text` has no time in
it and names people by their in-game names. Each item carries `at_unix`
and `late`, plus `sort_at` for ordering. One story is one item under a
stable `id` that grows by `revision`. Each item also says whether it is
`publishable`.

- **Every read says `basis: "observed"`.** This lane walks what the
  record learned since its cursor. The seed read and a busy window's
  older pages name no reader, so without the argument the hub would
  read them as `occurred` (what happened in the window).
- **An item with `publishable: false` never reaches a routine.**
  `relevant` drops it before anything else.
- **One story, one item.** A batch keeps the highest revision of each
  `id`, and the carry holds one copy per id. A grown story moves to the
  end as news again. Items without an id, from an older hub, are keyed
  as before.
- **Oldest first by `sort_at`.** That is the hub's newsfeed order, so a
  sitting sorts by when it ended.
- **The turn's framing** says `text` may be quoted as it stands, `late`
  means learned now and happened earlier, and an `id` posted before is
  news only if its growth is. When a post says when, it uses Discord's
  stamp from `at_unix` (`<t:AT_UNIX:R>` or `:f`), never a clock time
  the model computed.

Rollout order: the hub first (an older hub refuses the unknown `basis`
argument), then each instance rebuilt.

## War participation recognizes contributions — since 2026-10-04

Jamie corrected a `war-deck-check` post that named nonplayers and partial
players while reducing the four-deck participants to a count. The routine
now thanks every named four-deck participant first and appreciates partial
participation with the recorded decks out of four. Nonparticipants are
absent entirely: no names, counts, inferred counts, percentages or roster
totals. Empty positive lists mean silence. The length allowance is 1,900
characters so a full roster of contributors can be named.

This remains a clock turn four hours before `war_day_closes_at`, reading
`war_current.decks_today`, not a Timeline event. It reports the game's daily
deck counter as observed so far, never weekly points as daily earnings or
four decks as four battles/wins. Battle-result enrichment needs its own
recorded evidence and coverage; it is not inferred by this participation
routine. The existing finished-race skip remains, and training days skip.

These are task instructions in the routine, not game rules in the runner.
Live instances own copies. Deployment exposed an older clock-timer bug:
already armed timers kept the parsed brief until restart. The Policy-context
consumer below fixes that by reading the current routine at firing. No
backdated posting test is an acceptance step.

## Private context gates dependent clock turns — since 2026-10-04

For issue [283](https://github.com/jthingelstad/elixir-mcp/issues/283), Jamie
approved a narrow assigned-agent read of war intent, independent of Policy's
war scoring. The shipped war check requires `war_intent=participating`.
The generic runner compares the routine's literal requirement before arming
it, refreshes before firing and checks again after prompt/channel preparation,
immediately before consuming the boundary and calling the model. Startup is
the first plan. A current successful read may be at most 60 seconds old;
five seconds of future clock skew is tolerated. An old policy save date does
not make a fresh read stale.

Explicit nonparticipation suppresses the dependent turn. Unknown intent,
missing tools, denied access and unavailable/invalid/stale context defer it
with a bounded operator reason. Deferred boundaries retry every ten minutes
inside the routine's catch-up window; expiration is reported without a model
call, spend or run mark. A cold installation cannot consume even its history
seed until eligibility is known, and recovery still seeds rather than drains.
Other factual routines and their cursors continue independently. Revocation
or a version change invalidates planned permission; failed reads never reuse
a cached allow. The context remains in memory and never enters model input.

**Since 2026-10-05 only a deferred boundary DMs when it lapses** (issue
#20). A suppressed one — the clan's explicit nonparticipation — is still
rechecked every ten minutes so a change of heart inside the window posts,
but its expiry is the policy working: the two clans that do not race were
DMing "catch-up window expired" on every war day. The log line stays, with
its disposition.

Timers re-read the brief and enabled state at firing. A removed, disabled or
rescheduled routine cannot fire from an old timer. New `requires` front matter
must reach instances only after the updated code has deployed and restarted.
Hold that deployment until the core transport is live, its grants are verified
and the coordinated rollout is approved. Acceptance is the next natural turn.

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
  recognition — plus texture and the pasteable-question habit (retired
  2026-10-11, above) that is all
  that survives of the spotlight.
- **`trigger: clock`** (`src/clock.js`): armed from one `game_clock`
  field plus an offset (`arm: war_day_closes_at`, `offset: -4h`), one
  clock read plans every clock routine, re-planned at `day_ends_at` and
  after a fire; the run-ledger key is the boundary's instant, so a
  boundary fires once across restarts; a training day (field null) arms
  nothing; first sight of a routine seeds a boundary already behind it
  (seed, never drain). `war-deck-check` is the one shipped clock routine.
  An edited `arm`/`offset` takes effect at the next plan — the day roll or
  a restart; since 2026-10-04 timers re-read the brief before firing and refuse
  an old schedule if its fields changed. The hub's 09-13 line holds: war
  day open/close stay clock facts and the routine schedules itself.
- **`schedule` is the exception.** `meta-report` is the one shipped
  calendar routine; the DM still creates them ("remind the clan Friday").
- **The regulators.** SKIP stays, narrower ("the room already knows").
  **Since 2026-10-07 a SKIP says why, in one line** (Jamie's yes). The
  rule said "SKIP and nothing else", so a return after eight quiet days
  skipped without a word looked the same as one the model never weighed,
  and the turn renderer dropped the reasons some turns gave anyway. The
  reason is ledger-only (`skipReason`, src/skip.js; the review and `why`
  show it), and an upper-case `SKIP: reason` on one line counts as a skip.
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
- **Adding proactive content** goes in that order: a timeline kind in
  the editor's `wake:`/`carry:` first, a `trigger: clock` routine second,
  a `schedule` only when no record moment exists. Scheduled movers or
  spotlight slots and a VOICE lean in the prompt were retired on the
  evidence above; do not bring them back.

## Departures wait for a leader's word — since 2026-09-25

Jamie, 2026-09-25, as this bot takes over from elixir-bot: "Departures
should be visible even on a kick… in clan chat everyone sees that the
person was kicked. We then comment on it so everyone knows why." Elixir
9.3.0 made `departure_classified` (a leader saying, through Elixir Clan,
that a departure was a leave or a kick) visible to the clan's agent; in
9.2.0 only leaders saw it.

- `member_left` moves from `wake:` to `carry:`; `departure_classified`
  and `award_granted` join `wake:`. A raw departure now rides until the
  leader's word (or anything else) wakes the editor, or the carry
  release lets it go; the brief says what the leader said and never adds a
  reason. The shipped brief used to send a departure to a leaders-only
  channel when one existed; a departure is clan news now, as it is in the
  game.
- Why: on 09-25 the editor posted an elder's raw departure within five
  minutes, before any leader could say what happened. With sharing on in
  Elixir Clan (per clan, per fact type, off to start) the post can say it.
- Nothing here is any clan's process: the leader's word comes from the
  clan's own app, and a clan without it still gets the raw departure, a
  batch later.

## Award standings ride; a lead change is news — since 2026-09-25

Elixir 9.6.0 added `award_standing`: where a member stands in one of the
clan's own awards while the season runs, written by the clan's app each
morning only when a place moves. The editor carries it (context, never a
post of its own) except a first place carrying `previous_player_tag`, the
lead changing hands, which is one line. The ask brief reads a season race
from these facts when the clan runs its awards in its app, and from
`clans_participation` otherwise. Jamie's ask: "Do the mid season
standings."
