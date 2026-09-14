# Run the Preview

Own the outcome: **all three instances are up on `main`, cheap, hearing
the feed, writing the ledger, and speaking Elixir's current contract —
inside the boundaries that make the preview honest.** Three launchd
services on one Mac, one checkout, three instance directories. Most of
what goes wrong is a restart that never happened after a code change, a
routine file the running code cannot parse, a cursor that stopped moving,
or a budget lane that refused and nobody noticed.

## Every run

- **Alive, on `main`.** For each of `poapkings`, `shipit`, `elixirkings`:
  `launchctl print gui/$(id -u)/com.poapkings.elixir-mcp-discord.<name>`
  shows a running pid; the latest `discord_ready … build=<version>+<sha>`
  in `~/Library/Logs/elixir-mcp-discord/<label>.log` names the sha of
  `origin/main`. A running build behind `main` is a restart owed by whoever
  pushed; do it, one instance at a time, reading each boot before the next.
- **Booted clean.** Since the previous run: no `routine_invalid`,
  `no_routines_load`, `message_unclaimed`, `channel_problem`, `ERROR`. The
  2026-09-13 outage — six silent hours from a front-matter field the running
  code rejected — is the shape to look for. `channels_ok count=` matches
  what the instance binds.
- **Hearing the feed.** `state.json` cursors advance between runs on an
  active clan; `contract_version_changed` in the log is a read of Elixir's
  changelog entry and a check that `src/events.js` and the routines'
  `kinds:`/`sections:` still match. `INSTANCE_DIR=<dir> npm run probe`
  reports an *agent* principal and the current contract.
- **Writing the ledger.** A day with `ask_answered` or `routine_posted`
  lines in the log has a `state/turns/<day>.jsonl` with matching `turnId`s;
  `ledger_write_failed` in the log is a defect to fix in the run. Ledger
  size stays proportional to turns (a body bound that stopped binding
  shows here first).
- **Money.** `/…-budget` need not be run; read `state.json`'s `budgets`
  for the month per lane and `spendByRoutine` for the day. A lane at its
  ceiling logs `routine_over_budget` / `ask_over_budget`; that is the
  budget working, and it is reported, not raised. A routine whose cost
  jumped is a gap to explain (rounds, `many_calls`, a model or effort
  change in the instance's `.env` or a routine file).
- **The boundaries.** `git ls-files` holds no `.env*`, no `state/`, no
  ledger export, no member data; no CR tag in `src/`, `agent/` or `.env`
  (the test pins the shipped routines); no tool list, no tool schema
  hand-written; no code path reads `state/turns` or `state/prompts`.
  `npm test` green on `main`.
- **Secrets.** Keys live only in each instance's `.env`. The
  `aws-secrets-manager` skill first for any secret task; never a key in a
  log line, a note or a commit.

## Action

- A dead or stale instance, a boot error, a stuck cursor, a missing ledger
  day, a contract adaptation: fix in the run with the test, push, restart
  each instance, read the boot lines.
- A host-level failure (launchd will not start anything, disk, the Mac)
  goes to projects-sysadmin's team; say so.
- Anything Elixir must change goes to Elixir's team as one concrete
  request; never a local workaround.

## Success

Three pids, three boots on `origin/main`'s sha, cursors moving, every
turn in the log also in the ledger, no unexplained cost, no boundary
drift, `npm test` green.
