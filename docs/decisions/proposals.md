# Proposals — since 2026-09-15

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/proposals.js.*

`src/proposals.js` is the one machinery every change to the operator's files
goes through, from the review lane and from the DM: `planEdit` checks an
edit against the file AS IT IS NOW and returns the text it would become and
the diff; `applyProposal` re-plans (a hand edit in between refuses), writes
with a backup under `.history/`, records the decision, commits when the
instance is a repo; `undoProposal` restores while untouched; `tryProposal`
runs the routine's dry run on the proposed text. The fences are here too:
`EDITABLE`, operator-only ops (`edit.by === "owner"`), the memory entry
format and cap, a routine result that must parse, an owner's memory line
that only they remove. `src/review.js` re-exports it, so one import means
"a proposal".
