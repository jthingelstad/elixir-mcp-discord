# Proactive posting: the record is the trigger — 2026-09-16

**Status:** proposal. Nothing here is applied; the shipped routines are as
they were. The decisions for Jamie are listed first, each a yes/no with the
evidence under it. The hub half — what Elixir MCP would need to emit — is
`../../elixir-mcp/docs/reviews/2026-09-16-TIMELINE-FOR-PROACTIVE.md`.

**The thesis.** A proactive post should fire because something happened in
the record, not because a clock struck. `clan-feed` already works that way:
the timeline hands a batch of items to one turn that decides whether, what
and where. Six other routines fire on a wall clock and spend their turn
*looking for* something to say. This proposal makes the scheduled slot the
exception, folds the six into one editor turn per batch, and names what the
hub is missing for that to work. The ask lane is untouched — it is the part
that tests the thesis, and nothing here changes what a member sees when they
ask.

## Decisions for Jamie

1. **Retire `capability-spotlight`** (manufactured: a weekday rotation of
   demos). Its one real function — showing a question a member could paste —
   becomes a habit of the editor: end a post with the pasteable question when
   a moment naturally invites one. Yes/no.
2. **Retire `notable-movers` and `pilot-spotlight` as slots**; their
   functions become desks of the editor, fed by timeline moments. Movers
   depends on hub request 1 (session standouts); until it ships the editor
   has no movers desk and the clan hears no movers post. Yes/no, and whether
   to wait for the hub or run the editor without that desk meanwhile.
3. **`war-deck-check` and `rival-scout` become clock-armed one-shots**
   (`trigger: clock`, armed from `game_clock`), not daily/weekly slots. No
   more $0.08 SKIP on every training day. Yes/no.
4. **`meta-report` stays** as the one calendar routine. Yes/no.
5. **VOICE moves from a prompt lean to a coalescing knob** (how long warm
   items may wait before they wake a turn on their own). This reverses the
   2026-09-16 line "a lean on a skip decision, never a scheduler change",
   with the reason below. Yes/no.
6. **`quiet_crossed` at rung 5 stops waking a turn** (4 of 4 such turns
   ended SKIP, $0.33). Rungs 10 and 20 wake the editor and go to a
   leaders-only channel if the directory has one. Yes/no.

## What the ledger says (2026-09-09 → 09-16, three instances)

From the service logs (`routine_posted` / `routine_skipped` /
`post_without_destination`) and the turn ledger since 09-14. Costs are
Sonnet 5 at medium effort.

| routine | turns | posts | SKIP | lost | spend | per post | calls/turn |
|---|---|---|---|---|---|---|---|
| capability-spotlight | 14 | 12 | 0 | 2 | $1.90 | $0.158 | 4.5 (max 19, 7 failed calls in one turn) |
| clan-feed | 20 | 15 | 5 | 0 | $1.55 | $0.103 | 0.5 |
| notable-movers | 14 | 10 | 3 | 1 | $1.75 | $0.175 | 6.4 (max 24) |
| pilot-spotlight | 1 | 1 | 0 | 0 | $0.18 | $0.181 | 3 |
| rival-scout | 3 | 1 | 2 | 0 | $0.33 | $0.327 | 2.7 |
| war-deck-check | 13 | 4 | 9 | 0 | $1.11 | $0.278 | 0.4 |
| meta-report | 0 | 0 | — | — | — | — | never ran: every Sunday period was seeded by a restart |
| **total** | **65** | **43** | **19** | **3** | **$7.09** | **$0.165** | |

Five things fall out of it.

- **Twenty-nine percent of turns produced nothing** (19 SKIP + 3 lost,
  ~$1.85). Every SKIP is the calendar asking "anything to say?" on a day the
  record had nothing: nine war-deck turns on training days, two rival
  scouts and three movers on one-member clans, five feed turns on a member
  crossing five quiet days.
- **The per-turn floor is ~$0.08 before a single word.** A cold turn writes
  ~30k tokens of cache (the toolset plus the system block) — `cw 30933,
  out 6, $0.082` is what a SKIP costs in the ledger. A quiet-day probe is
  not cheap because it is short; it costs the same as a post. The only way
  under the floor is fewer, fuller turns.
- **Movers is a tool loop pretending to be a routine.** Its brief names
  four kinds of standout; the record carries one of them (`returned`) and
  the bot reconstructs the other three (win streak, trophy swing, W-L) by
  calling `battles_performance` per member — 9.9 calls a turn on POAP
  KINGS, 24 in one run, three failures in another, and `many_calls`
  friction already filed for it. `clans_standings`' own description
  concedes the gap: "trophy swing and streaks still need a selected
  member's battles_performance".
- **The spotlight is the most expensive and the least grounded.** The
  $0.50 turn, the "possible fabricated data" incident (2026-09-11), two of
  the three lost turns, and the only 19-call turn are all spotlights. It
  rotates by weekday — content manufactured on the calendar by
  construction.
- **The two one-member clans show the calendar's failure mode plainly:**
  Ship It! and Elixir Kings spent $1.96 for 8 posts; 60% of their turns
  were SKIP, because a war-deck check, a rival scout and a movers scan
  fire whether or not there is a race, a rival or a mover.

What clan-feed did in the same window is the model: six turns on POAP
KINGS since the 3.0.0 timeline, each handed items, zero drills for a role
change ("Two promotions to elder"), one call for a return — and the four
SKIPs were all `quiet_crossed` at rung 5, a kind that should not have
woken it.

## The redesign

    editor = the timeline x one brief with desks x the directory

One event routine, `editor.md`, replaces clan-feed, notable-movers,
pilot-spotlight and capability-spotlight. It is clan-feed with a wider
subscription and a longer brief: the runner hands it a batch of timeline
items plus the clan entry, and one turn decides whether, what and where.

### The batch

Two lists of kinds in the front matter instead of one:

```
---
description: The editor: turns the clan's timeline into posts, one turn per batch
trigger: events
wake: member_joined, member_left, member_role_changed, race_finished, week_resolved,
      returned, ranked_promotion, arena_changed, legendary_badge_earned,
      best_trophies_band, career_wins_step, session_standout, bracket_observed
carry: badge_earned, collection_level_step, card_unlocked, quiet_crossed
may_skip: true
max_chars: 1400
---
```

- A **wake** kind in the poll window starts a turn now (the 300 s poll
  keeps joins posted within minutes, as the preview wants). Everything
  carried since the last turn rides in the same batch.
- A **carry** kind is kept (`state.carry[routine]`, items only) and never
  starts a turn by itself — unless the clan has been quiet longer than the
  VOICE line (below), in which case the carried items are released as a
  batch of their own. `quiet` never releases; `normal` after 12 h;
  `chatty` after 4 h.
- `kinds:` keeps working as today (everything named wakes) so no existing
  file breaks; `wake:`/`carry:` are new fields, which is a code deploy
  before any instance's files use them (the 2026-09-13 rule).

The batch is the unit of cost. On POAP KINGS' last 24 hours the clan
timeline carried 26 items: 14 badge level-ups, 5 collection-level steps,
2 card unlocks, 3 quiet crossings — and 2 ranked promotions. Under `kinds:`
that is up to 26 turns; under wake/carry it is two, and the promotions
carry the texture with them.

### The brief

One brief, four desks, each a paragraph — the movers and pilot briefs
already read like this, they just lacked the items:

- **News** (roster, war): as clan-feed says it today. A departure stays
  raw; never announce the time; `week_resolved` and `race_finished` are one
  line each.
- **Movers** (`session_standout`): the streak, the swing, the record, led by
  the number, at most three names, one line each. No drilling for it — the
  item carries the session.
- **Recognition** (`ranked_promotion`, `best_trophies_band`,
  `career_wins_step`, `legendary_badge_earned`, `arena_changed`): one member,
  one moment, a little deeper — `players_summary` or `battles_performance`
  on that member only — recognition, not ranking. This is what
  pilot-spotlight was for, fired by the record instead of Friday.
- **The pasteable question**: when a moment invites one, end with the
  question a member could paste into the ask channel, real names in it, in
  backticks. Never a template, never "you can ask". This is all that
  survives of the spotlight.

Plus the existing rules: read the room, the leaders-only channel for
departures and quiet rungs 10/20, the same text never twice, SKIP when the
room already said it.

### The clock lane, for what is genuinely the clock's

Two routines are calendar-bound by nature and stay, but stop being wall
times typed into front matter:

```
---
trigger: clock
arm: war_day_closes_at
offset: -4h
---
```

`trigger: clock` reads one `game_clock` field at boot and after each run,
arms a one-shot timer at that instant plus `offset`, and re-arms from the
next read. `war-deck-check` arms on `war_day_closes_at` (null on a training
day: nothing armed, nothing spent). `rival-scout` arms on `week_ends_at`
(+2h: the new bracket is in the record by then) — or, if the hub ships
`bracket_observed` (request 3), it becomes a wake kind of the editor and
the clock version is deleted. A clock-armed turn on a clan that is not in
a race still costs a turn to learn so (the Ship It! and Elixir Kings
pattern); the timer removes the training-day SKIPs, not that one. The
cheap guard is the runner reading the clan entry's `war` section from the
last poll before arming — `war.decks` null across a war day means no race
— and that is a small implementation choice, not a design one.

`schedule` stays for `meta-report` and for anything an operator creates
by DM ("remind the clan Friday at 8"). It is the exception now, not the
default.

## Per-routine decisions

| routine | verdict | why | hub request |
|---|---|---|---|
| clan-feed | becomes the editor | already the model | 0 (name defect), 5 (`kinds` filter) |
| notable-movers | **(a)** event: `session_standout` | 9.9 calls/turn reconstructing streak, swing, W-L from battle rows the hub already groups into sessions at read time | **1** (session standouts on the clan entry), **2** (`clans_standings` trophy_net + streak as the one-call drill) |
| pilot-spotlight | **(c)** as a slot; its function is the recognition desk | "who improved most this week" is not a quantity the hub offers; Pilot Score is a 90-day residual the tool itself says is not proof of improvement. The record's moments (promotion, new best, 1,000th win) are what a member would be glad to have read | none; the moments exist |
| capability-spotlight | **(c)** goes | manufactured by weekday; the most expensive, least grounded, two of three lost turns | none |
| war-deck-check | **(b)** stays, clock-armed | a "4 h left" nudge is a clock fact — ratified 2026-09-13, not re-litigated. Armed from `war_day_closes_at` so training days cost nothing | 4 (`war_day_resolved`, optional: the day's result is an observation the review already lists as one) |
| rival-scout | **(a) if the hub agrees, else (b)** | the *time* the week starts is the clock's; *which five clans* is an observation the reader cannot compute. Proposed as `bracket_observed`; if declined, clock-armed from `week_ends_at` | **3** |
| meta-report | **(b)** stays | a weekly read of a moving corpus; no record moment corresponds. Note it has never actually run | none |

Season close: the war side already exists (`week_resolved` with
`is_colosseum: true`); the ladder reset is a clock fact by the ratified
rule; no routine needs it; no request. Win streak, trophy swing, return
after quiet: `returned` exists; the other two are request 1.

## What it does to the regulators

Every regulator was built to correct a symptom of the calendar. Under the
record as trigger:

| regulator | today | after | verdict |
|---|---|---|---|
| **SKIP** | "is there anything?" — 29% of turns say no | "does the room already know?" — the batch *is* the news | **stays, narrower.** The deterministic half (which kinds wake) moves into `wake:`/`carry:`, where it costs nothing. |
| **recall** (own last N posts) | stops a rotating demo or a daily scan re-reporting the same angle | a ledger moment is emitted once; an item cannot recur | **unnecessary for the editor.** Field stays in the parser; the shipped editor sets none. Meta-report does not need it either. |
| **nudge** (NOT DELIVERED) | Sonnet 5 writes the post and forgets `post_message`, one turn in four | same model, same failure mode | **stays** — it is a model mechanic, not a trigger mechanic. Exposure drops: two of three lost turns were spotlights. |
| **silence clock** | tells a skip decision that the channel has starved | silence is now the record's: a quiet clan gets a quiet channel, which is the honest state | **unnecessary as a prompt line.** `state.silence` survives only as the input to the carry release below. |
| **VOICE** | a lean on the skip bar (quiet 72h / normal 12h / chatty 4h) | the carry-release line: how long texture may accumulate before it wakes a turn on its own | **repurposed.** The three levels keep their names and hours; they move from `systemFor` to `pollRoutine`. Nothing else in the prompt asks the model how much to say. |
| **catch_up_hours** | every scheduled routine | meta-report only | stays for `schedule`; `clock` re-arms instead |

Why VOICE belongs on the scheduler now: the 2026-09-16 rule kept the
scheduler deterministic because the prompt was the only place "how much" had
a meaning — the calendar decided *when*, and the model decided *whether*.
With the record deciding *when*, the only "how much" left is whether badge
level-ups and collection steps ever earn a post of their own, and that is a
release interval, not a lean. A lean on a SKIP the model no longer takes is
a paragraph of cached prefix for nothing.

## Cost per post

Today (POAP KINGS, 8 days): 43 turns, 34 posts, $5.13 — **$0.151 per post**,
$0.64 a day, with 9.9 calls a turn on movers and 21% of spend on turns that
posted nothing. All three instances: $0.165 per post.

After, on the same clan (projection from the last 24 hours of its timeline
and the ledger's per-turn costs):

- Wake batches: ~2–4 a day (roster moves ~1/day, `returned` ~0.5/day,
  ranked/arena/best moments ~1–2/day, race and week once a week, session
  standouts capped at 5 per window). Carry releases: ≤1 a day on `normal`.
- Calls per turn: 0–2 (the item carries its facts; recognition drills one
  member). Movers' 9.9 becomes 0.
- Per turn: the $0.08 floor plus ~$0.02–0.04 of items and output —
  **~$0.10–0.12**, against $0.15–0.20 for movers and spotlight turns today.
- SKIP share: ~5–10% (room-already-said-it), against 29%.

**≈ $0.11 per post, ~3–4 posts a day, ~$0.40 a day** — a third less per
post, similar volume, and every post anchored on an item with a timestamp
rather than on the hour the file named. On the one-member clans the saving
is almost the whole spend: nothing wakes when nothing happens.

The floor is the toolset's cache write. If the editor turns out to fire in
clusters (a race finishing during a session standout), the second turn
inside five minutes reads the cache instead of writing it (~$0.02); the
batch already captures most of that.

## Untouched

The ask lane (`ask.md`, `src/ask.js`, threads, `WHO_IS_ASKING`,
`deck_link`, screenshots, the per-member cap). Grounding, the feedback
sweep, the ledger, the directory and `post_message`, the review lane, the
DM console, budgets. No local data, no fallback, no tag.

## Order of work

1. **Hub, request 0** (member moment items lose the member's name — a one-line
   defect; the editor cannot attribute a badge or a card unlock without it).
2. **Bot: `wake:`/`carry:`, the carry store, the VOICE release; the editor
   brief; retire spotlight and pilot-spotlight files in the checkout** (each
   instance's `agent/` is its own — three copies, or the DM). Ship without
   the movers desk; the feed lane is already the editor minus two desks.
3. **Bot: `trigger: clock`**; `war-deck-check` and `rival-scout` rewritten
   onto it.
4. **Hub, requests 1 and 2**; then the movers desk paragraph in the brief —
   a prompt change, no deploy.
5. **Hub, request 3** if accepted; then rival-scout's clock file is deleted
   and `bracket_observed` joins `wake:`.
6. Drop `silenceLine` and the VOICE block from `systemFor`; drop `recall`
   from the shipped files; AGENTS.md gets its `since` lines.

Steps 2 and 3 need nothing from the hub and remove every SKIP the table
above attributes to the calendar.
