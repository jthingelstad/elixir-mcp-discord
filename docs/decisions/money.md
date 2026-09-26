# Money is configuration, not code

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/budget.js, src/pricing.js, the budget settings in src/config.js.*

Three monthly pots, split by who spends them: `MONTHLY_BUDGET_USD` for what the
bot decides to do (schedules, event briefs), `ASK_MONTHLY_BUDGET_USD` for
what clan members ask for (their 👎 sweeps included), and
`REVIEW_MONTHLY_BUDGET_USD` for the operator: the review lane and every DM
turn. One pot would let a chatty afternoon cancel the 01:00 war-deck post,
with silence as the only symptom.

**Since 2026-09-25 setup asks for all three and every surface shows all
three.** Setup asked for two, so the third was unset — unlimited — on every
install, and `budget.status()` hid the review lane while `REVIEW` was off,
so the boot log's unlimited-budget warning, `/budget` and `status` never
mentioned that the operator's DM turns (on `CLAUDE_MODEL`; the review
itself runs on `REVIEW_MODEL`) had no ceiling. The status line reads `review + DMs`.

**Since 2026-09-25 an unset budget is a cap, not unlimited** (Jamie's D4).
Unset used to mean unlimited with a boot-log warning, and it failed open
three ways: a container started without `config.json`, the review lane on
every install, a hand edit that dropped a key. Now `laneBudget` in
`config.js` reads a number, or `"unlimited"` (the only way to say no cap),
and anything else — unset, empty, a typo — is `DEFAULT_LANE_BUDGET_USD`
($10). A cap rather than a refusal on purpose: a refused review lane would
lock the operator out of the DM turn that sets it. `budget.status()`
carries `source` (set / default / unlimited); boot logs each lane and DMs
the defaulted ones once a day. `$0` now turns a lane off: `check` read
`!budget` as unlimited, so a zero budget was the opposite of what it said.
`"unlimited"` is a lane budget's word only (`laneMoney` in
`src/settings.js`): accepted for `TURN_RESERVE_USD` it read as NaN, and a
NaN reserve makes every reserve comparison false, so the strict check let a
lane overshoot; `config.turnReserveUsd` falls back to 0.30 for anything
that is not a number.

**Strict means checked BEFORE the call.** A lane refuses to start a turn that
could take it past its budget, estimating from the largest turn that lane has
ever produced (floored by `TURN_RESERVE_USD`, which climbs and never drops).
Checking `spent >= budget` afterwards guarantees an overshoot of one turn a
month, and a big turn overshoots a lot. Do not "simplify" that to a post-hoc
check.

The scheduler declines BEFORE marking the run ledger, so a routine skipped for
budget is not recorded as done and runs again next month rather than having
silently missed its window.

**The model is the operator's and so is its price.** `CLAUDE_MODEL` plus
per-routine `model` / `effort` / `max_tokens`, priced from `agent/models.json`
over the catalog in `src/pricing.js`. An unpriced model throws at boot and on
call: the old hardcoded table returned $0 for anything it did not know, which
turned every budget into a number that could not be reached. A budget that
cannot be enforced is worse than none, because it looks like it works.
