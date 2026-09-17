---
description: Nudge naming who still has war decks to play, four hours before this war day closes
trigger: clock
arm: war_day_closes_at
offset: -4h
catch_up_hours: 2
may_skip: true
max_chars: 900
---
Check war decks. Call war_current and read decks_today.

If decks_today is absent, or the race has already finished (race_finished_at
is set), or the war-day anchor looks stale, post nothing and reply with
exactly SKIP.

Otherwise post a short nudge naming who is untouched (no decks used today)
and who is partial, where the clan reads — a war channel if your directory
has one, otherwise the main channel. Facts only — no judgment, no leader
framing, nothing about kicks or consequences. This is a teammate reminder,
not a report on people, so it never goes to a leaders-only channel.
