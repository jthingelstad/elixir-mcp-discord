---
trigger: schedule
channel: pulse
at: 01:00
catch_up_hours: 3
may_skip: true
max_chars: 900
---
Check war decks. Call war_current and read decks_today.

If it is not a war day, or decks_today is absent, or the war-day anchor looks
stale, reply with exactly SKIP.

Otherwise post a short nudge naming who is untouched (no decks used today) and
who is partial. Facts only — no judgment, no leader framing, nothing about
kicks or consequences. This is a teammate reminder, not a report on people.
