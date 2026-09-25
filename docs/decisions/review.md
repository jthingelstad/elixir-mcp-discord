# The review lane — since 2026-09-14

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/review.js, agent/memory.md, the memory code in src/prompt.js.*

`src/review.js`. Evaluation as a FEATURE of the bot, on the operator's key
and budget, not a job beside it — because other people run this for their
own clans, and an eval that only Jamie's machine performs does not ship.
`REVIEW=on` in `.env`; off by default. Read the header comment first; the
design is there. The short version:

- **Findings become diffs.** The review reads the ledger for the window,
  grades every turn against the bot's own rules (`MECHANICS` in
  `src/prompt.js` plus the operator's files) and against what humans did
  afterwards, and produces at most `REVIEW_MAX_PROPOSALS` (3) edits to
  files under `agent/` — `memory.md` (append one dated line), `identity.md`
  or a routine's brief (replace/remove, never the front matter). Each cites
  turns and is shown as a diff. A finding that is not an edit is a
  `report_mechanics` (code — the DM carries a pasteable issue) or an
  `elixir_send_feedback` filing (the hub).
- **Humans outrank the rubric.** The signals that flag a turn: 👎/👍 with
  notes, an `intervention` (another member speaking in the answer thread,
  or the asker pushing back — `looksLikeCorrection` in `src/ask.js`), a
  sweep `finding` (see below), `ungrounded`, errors, truncation. Flagged
  turns are shown first and in full.
- **The sweeps classify before filing** (`CLASSIFY_RULES` in
  `src/feedback.js`): `ELIXIR:` files upstream as before; `PROMPT:` and
  `MECHANICS:` become `finding` records for the review instead of being
  dropped as NONE. A 👎 on this bot's own mistake no longer becomes noise
  for Elixir's maintainer.
- **Delivery is a DM to `ADMIN_USER_IDS`**: header, the report, one message
  per proposal with **Apply / Skip / Show turns** buttons (`rv:` custom
  ids, handled in `handleInteraction`). Apply re-plans the edit against the
  file as it is NOW (a hand edit since refuses cleanly), keeps the prior
  version under `agent/.history/`, and shows **Undo**. Undo restores the
  backup only while the file is untouched since.
- **Measure, then prune.** The review opens with the previous review's
  applied edits and whether the turns since show the improvement; an edit
  that did not help gets a revert proposal. A `memory.md` entry no turn
  needed in a month gets a remove proposal.
- **`agent/memory.md` is the bot's memory**, loaded after `identity.md`
  (`readMemory`, `MEMORY_MAX_CHARS` 6000, 20 entries). One line per entry,
  `MEMORY_ENTRY` in `src/prompt.js`: `- YYYY-MM-DD (turns a, b): ...` from
  the review, `- YYYY-MM-DD (from owner): ...` from the operator by DM,
  optionally ` until YYYY-MM-DD` before the colon for context that is true
  for a while — expired lines are dropped at load. How to do this job here
  — which tool answers what, what this clan calls things, what the
  operator wants kept in mind — never a game fact, never a person. The
  review may prune a turn-cited entry nothing needed in a month; it never
  removes or rewords an owner entry (`planEdit` refuses unless
  `edit.by === "owner"`, which only the DM lane sets).
  `REVIEW_AUTO_MEMORY=true` lets the review write it without a click (never
  `identity.md`, never a brief), still reported by DM with Undo.
  **Since 2026-09-25 the example file has no entries.** It shipped three
  example lines, indented as a code block — and `parseMemoryEntry` trims,
  so each was a live entry in every instance setup copied it into: every
  new bot was told, as its operator, that the clan calls war days "boat
  days", and the review could never remove an owner's line. The notes and
  examples are now inside an HTML comment with `YYYY-MM-DD` placeholders;
  `memoryText` drops comments (so the file's own notes are no longer paid
  for on every turn) and a title with nothing under it; and the three old
  lines are `SHIPPED_EXAMPLES` — never an entry, never in the prompt,
  `memory_example_ignored` once in the log — wherever they still sit.
- **Its own lane.** `review` beside `routines` and `ask` in `src/budget.js`,
  `REVIEW_MODEL` (default `claude-opus-5`), `REVIEW_EFFORT`, `REVIEW_AT` in
  the operator's timezone as a pseudo-routine on the same run ledger
  (`__review`; started AFTER the scheduler, whose first seeding replaces
  the ledger). `/review` runs it on demand; `npm run review` is the dry
  run: real call, nothing persisted, nobody DMed.
- **What it may never do:** post to a member channel, react, ask the bot a
  question, edit anything outside `agent/`, edit a routine's front matter
  (the operator can, by DM — dm.md), read the ledger into a member-facing
  turn. The `EDITABLE` pattern and `planEdit` are the fence; the tests pin
  them. **Since 2026-09-25 the fence is in code, not in the schema.**
  `planEdit`'s operator-only checks read `edit.by === "owner"`, and the
  review's `propose_change` handler passed the model's `edit` straight
  through — a tool's `enum` and `additionalProperties: false` are advice
  to the model when the tool is not strict, and the review reads members'
  words from the ledger. A test even created and deleted routines through
  the review lane that way. `reviewEdit` now rebuilds the edit from `op`
  (append/replace/remove only), `text`, `find` and `replace`, refuses
  `config.json`, and requires `(turns …)` provenance on any memory line a
  review writes (with `REVIEW_AUTO_MEMORY`, that line is applied unseen).
  `planEdit` also fences `replace` of an operator's memory line, not only
  `remove`, and refuses a non-owner line that claims `(from owner)`.
