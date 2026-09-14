# AGENT-TEAM operating model

The Elixir MCP Discord preview is maintained by three objective owners. An
owner is accountable for an outcome, not a job type or a directory, and
follows evidence through diagnosis, code, tests, restart and natural
acceptance instead of handing each step to another role.

Read `AGENTS.md`, this file, `AGENT-TEAM/README.md`, `AGENT-TEAM/READING.md`
and the selected objective before acting. The entry point never replaces
the product docs it points at.

## Operating loop

1. Run `AGENT-TEAM/scripts/preflight.sh`. A dirty, behind, diverged,
   detached or unexpectedly-ahead checkout makes the run read-only. Never
   publish a pre-existing commit.
2. Measure current state: the three instance logs (boot lines, the last
   event of each lane, `ERROR`/`WARN` since the previous run), the ledgers
   (`npm run turns -- --instance <dir> --since <date>`), the state files
   (cursors, budgets, `serverVersion`/`contractVersion`, read-only), and
   `INSTANCE_DIR=<dir> npm run probe` for the principal and contract.
3. Decide whether a real objective gap exists. Healthy is a complete result.
4. Only when a safe, authorized gap requires mutation, claim the checkout:
   `node AGENT-TEAM/scripts/objective-lease.mjs claim <run|judge|loop>`.
   Keep the returned `leaseId`. A held lease leaves the run read-only;
   never clear one merely because it looks old (`clear-stale` records the
   proof), and use `abort` with a reason when a run cannot finish.
5. Fix the gap at the source in the same run, with the regression test that
   would have caught it. A warning, a guard or a ticket chain is not a fix.
   A prompt-mechanics fix lives in `src/prompt.js` with a test in
   `test/prompt.test.js`; an example-prompt fix lives in `agent/`.
6. Recheck the lease (`check <objective> --lease-id <id>`), the branch, the
   upstream and the worktree immediately before the first edit and before
   push. Stop if the state changed.
7. `npm test` before every commit. Commit and push only this run's work,
   directly to `main`. There is no CI deploy: **a `src/` change is live
   only after each instance restarts** (`launchctl kickstart -k
   gui/$(id -u)/com.poapkings.elixir-mcp-discord.<name>`, one at a time,
   reading the boot lines of each before the next). A change under
   `agent/` in the checkout changes no live bot.
8. Verify from natural evidence: the boot lines name the new build
   (`discord_ready … build=<version>+<sha>`); the next natural turn lands
   in the ledger with the expected shape. Never run a routine early, never
   ask the bot a question as acceptance, never post to a channel, never
   replay a backlog.
9. Release only this run's lease after the repository is clean. If safe
   cleanup is impossible, leave the lease and report it.

## Ownership and acceptance

- The originating objective restarts the instances for its own commit and
  reads their boot lines; Run the Preview owns a boot that fails and
  continuing health.
- Judge the Answers owns semantic acceptance of anything that changes what
  the bot says: a prompt or code change is accepted against the tests AND
  the next natural turns read back from the ledger.
- Close the Loop owns the truth of what was filed upstream and of the docs.
- A clean boot never substitutes for natural evidence.

## The ledger is evidence, never memory

`state/turns/*.jsonl` and `state/prompts/` in each instance are read by
this team and by nobody in `src/`. No run may add a code path that reads
them back into a prompt, cache an answer from them, or summarise them into
anything the bot consumes. That is the local data `AGENTS.md` forbids.

## Members' words stay in the instance

This repository is PUBLIC and `AGENT-TEAM/notes` and `summaries` are in it.
A note cites a turn by `turnId`, instance and date, describes the defect,
and quotes the bot's own rule it broke. It never carries a member's
question, display name, Discord id or player tag, and never pastes a tool
body. The transcript is one `npm run turns -- --turn <id>` away for anyone
with the instance.

## Issues are the exception ledger

Do not open an issue to authorize, claim, route, deploy or close same-run
work. Keep one only when work spans runs, an external dependency blocks it
(usually Elixir), Jamie must decide, or the arc needs a durable record.
One objective label each; no dispatch or handoff labels.

## Human boundary

Jamie decides: any edit to an instance's `agent/` (their prompts diverge on
purpose and are the clans' own, held as-is since 2026-09-14), a budget
number or model in an instance's `.env`, any new channel binding or
directory grant, adding a tool name to a prompt, restarting during a live
conversation for anything short of a broken bot, the pointer edits in
Elixir's AGENT-TEAM, and anything that would post to a channel outside the
bot's own lanes. Ask one concrete yes/no question with the evidence and
the smallest useful version.

Never, regardless of who asks: local game data or a fallback, a tool list
in the repo, a clan tag in `.env` or a prompt, a manufactured turn, a
replayed backlog, `mark_seen: true`, a secret in the checkout.

Autonomous when they preserve that boundary: mechanics fixes in
`src/prompt.js`, example-prompt fixes in `agent/`, bug and reliability
fixes, test coverage, the ledger and reader, docs, and a restart to bring
an instance onto `main`.

## Automation memory

Automation memory holds only `Current state`, `Active watches` and one
replace-in-place `Latest run`, plus for Judge the Answers the last graded
`at` per instance. Remove resolved watches. Git, the logs and the ledgers
hold history.

## Reporting

End as `HEALTHY`, `CHANGED`, `WATCHING`, `BLOCKED` or `NEEDS JAMIE`:

```text
Outcome: HEALTHY | CHANGED | WATCHING | BLOCKED | NEEDS JAMIE
Objective: <objective name>
Evidence: <most decision-relevant facts>
Action: <what changed, or None>
Next check: <natural event/date, or None>
Jamie: <one yes/no question, or None>
```

Report the measured outcome and the remaining risk, not workflow ceremony.

## Calendar and due work

`automations.toml` owns the calendar; `SCHEDULE.md` is its generated view
(`../projects-sysadmin/scripts/render_automation_schedules.py --repo . --write`).
Weekly subtasks keep last successful evidence and the next due date in
current state; a retry checks that receipt before repeating work; a blocked
due subtask remains due at the next eligible invocation.
