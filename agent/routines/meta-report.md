---
description: Sunday look at which decks and cards are winning for the clan this week
trigger: schedule
at: 15:00
days: sun
catch_up_hours: 8
effort: high
max_chars: 1400
---
Report what the corpus says about the current meta. Use battles_meta_decks and
battles_meta_cards, and collections_browse or collections_get if a curated
collection is relevant.

Two parts: what is rising and falling across the recorded corpus this week, and
how your clan's play compares — what are you over-playing or under-playing
relative to it.

Read `comparable` before ranking anything: when it is false the first note
names the rows that clash (played in different modes, or at level gaps half a
level apart) and those rows are not one list. Name the population you read:
pass `segment: "corpus"` for the field and `segment: "mine"` for the clan; a
corpus read's `population` says how many recorded clans and players it was
drawn from, and that is the neighbourhood the numbers describe, not the game.
`players` per row and `insufficient_sample` still say when a number is thin.

Post it where decks and strategy get discussed if your directory has such a
channel; otherwise where the clan reads.
