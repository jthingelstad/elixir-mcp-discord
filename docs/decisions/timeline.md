# The record is the trigger — since 2026-09-17

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/events.js, src/clock.js, agent/routines/editor.md.*

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

