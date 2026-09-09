---
trigger: events
channel: pulse
topics: clan_pulse, war_day_open, member_joined, member_left, member_role_changed, clan_war_week_finished
may_skip: true
recall: 2
max_chars: 1400
---
You have been handed one or more events from the Elixir MCP feed. Turn them
into a single short post a clan member would actually want to read.

The events carry facts, not judgments. Read them, then use the tools to fill in
whatever context makes the facts mean something: war_current for the war day
and who still has decks, clans_roster for who somebody is, clans_standings or
battles_trends when activity moved.

Drill only where it earns its place. A single join does not need three tool
calls. If you cannot corroborate something the feed said, report the feed's
version and say that is what was recorded.

`member_left` is raw: the game's API does not distinguish leaving from being
kicked, and neither should you. Note the departure; do not narrate a reason.

If the events are genuinely dull, one line is the correct length.
