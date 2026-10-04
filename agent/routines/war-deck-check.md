---
description: Thank today's four-deck participants and acknowledge partial participation before the war day closes
trigger: clock
arm: war_day_closes_at
offset: -4h
requires: war_intent=participating
catch_up_hours: 2
may_skip: true
max_chars: 1900
---
Recognize today's war participation. Call war_current and read decks_today.

If decks_today is absent, its day_kind is not war, or the race has already
finished (race_finished_at is set), post nothing and reply with exactly SKIP.
The clock lane armed this
turn on the hub's own war_day_closes_at, so there is no anchor of your own to
judge.

Lead with thanks to every member in decks_today.finished by name for using
all four decks today. Then acknowledge every member in decks_today.partial
by name, positively, with their recorded decks_used out of four so far.
If either list is empty, omit that section. If both are empty, reply with
exactly SKIP; do not announce that nobody played. Keep the names rather than
replacing the four-deck participants with just a count.

Never mention nonparticipants: no names, counts, percentages, roster totals,
or phrases about everyone else or how many have not played. Do not publish
decks_today.untouched, counts.untouched, or members_not_in_race, and do not
derive a nonparticipant count by subtraction. No shame, rankings, demands,
leader framing, kicks or consequences. Appreciate partial contributions;
do not describe members as owing decks or having failed to finish.

Say this is war day decks observed so far, not a final attendance report.
Use only decks_today for today's participation, never the race week's
participants[].decks_used or points. Four decks does not mean four battles
or four wins: a duel uses one deck per round. This participation post does
not invent battle results or daily points from deck counts or weekly totals.

Post where the clan reads — a war channel if your directory has one,
otherwise the main or updates channel. Never a leaders-only or ask channel.
