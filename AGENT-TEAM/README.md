# AGENT-TEAM — objective owners for the Elixir MCP Discord preview

Three objective owners maintain this preview. Each owns a durable outcome,
not a task type, and follows evidence through diagnosis, implementation,
verification, restart and acceptance itself. There is no dispatcher and no
Build Manager; building and testing are capabilities of every owner.

This project exists to answer one question — **is Elixir MCP good enough to
stand alone?** — and it answers it two ways: by filing what it wanted and
could not get (feedback upstream), and by what it actually says to clan
members in Discord. Since 2026-09-14 every live turn is written whole to the
turn ledger (`src/ledger.js`, `npm run turns`), so the second half is finally
something a reviewer can read rather than scroll for. Judging those answers
against the bot's own rules, and turning what is found into prompt and code
fixes, is the reason this team exists.

## The team

| Objective | File | Primary question |
|---|---|---|
| **Run the Preview** | `run-the-preview.md` | Are all three instances up on `main`, cheap, hearing the feed, writing the ledger, and speaking Elixir's current contract — inside the repo's boundaries? |
| **Judge the Answers** | `judge-the-answers.md` | Was what the bot said in Discord grounded, right, on-brief and in voice — and what is the highest-leverage fix when it was not? |
| **Close the Loop** | `close-the-loop.md` | Is what the bot files upstream true and useful, is what came back acted on here, and do the docs describe the shipped bot? |

Calendar cadence: [generated schedule](SCHEDULE.md), sourced from
`automations.toml`.

Do not add a Guard, Cost or Analyst role: the public-repo, no-local-data
and no-tool-list boundaries are checks inside Run the Preview (the tests
pin most of them), cost belongs to Run, and answer quality to Judge.

## How Jamie engages the team

Start with the outcome instead of choosing a role or preparing a ticket:

- `Run <objective> now and own the highest-impact measured gap.`
- `Investigate <symptom>; choose the owner by the failed outcome, not the file.`
- `Show me team status only; make no changes.`
- `What across this team needs Jamie?`

Choose **Run the Preview** for a bot that is down, silent, on old code,
over budget, missing feed items or missing ledger days; **Judge the
Answers** for an answer or post that was wrong, ungrounded, off-brief or
off-voice, or to hear what the week's turns say about the prompts; **Close
the Loop** when a filing looks wrong, the hub answered and nothing changed
here, or the docs lie. Cross-cutting work keeps one originating owner
through acceptance.

## Boundaries with the neighbors

- **Elixir (`../elixir-mcp`)** is the only source of facts and has its own
  team. A capability this bot lacks is filed through the bot's own
  `elixir_feedback` path in the normal course of a turn — this team never
  files as the bot and never manufactures a turn to produce a filing. A
  finding about a tool's *behaviour* (a wrong shape, a misleading note) is
  a request to Elixir's team; a finding about how this bot *used* a tool is
  ours.
- **Elixir's AGENT-TEAM** named this preview under its Run Elixir MCP and
  Close the Loop objectives before this team existed. This team now owns
  the preview's operation and its answer quality; Elixir's team keeps the
  upstream half of feedback (the answer to a filing). The pointer edits in
  `../elixir-mcp/AGENT-TEAM` are Jamie's to approve.
- **elixir-bot (`../elixir-bot`)** is the established clan agent and is not
  a reference for this bot's voice or data: the preview deliberately has no
  persona and no local data. Never read its database.
- **The three instances** (`~/.elixir-mcp-discord/{poapkings,shipit,elixirkings}`)
  are outside this checkout. Their `agent/` prompts are each clan's own and
  are not edited by this team (Jamie, 2026-09-14): a prompt finding becomes
  a change to the checkout's example `agent/` plus one decision for Jamie
  naming the instance edit. Their `state/` (ledger, prompts, cursors) is
  read-only evidence and holds members' names and questions.
- **projects-sysadmin AGENT-TEAM** owns the host. A launchd service that
  will not start for a host reason is theirs; why the bot exited is ours.
- **Interactive Claude sessions** share this checkout. Every mutating actor
  serializes through the checkout lease (`scripts/objective-lease.mjs`).

## Project map

- `AGENTS.md` (= `CLAUDE.md`): the rules that are the whole point, the
  instance model, the directory, the ledger, money, the bite list. Read it
  first; it is the product contract.
- `src/` — the runner. `prompt.js` (mechanics blocks), `ask.js` (message
  lane), `run.js` (every other trigger), `claude.js` (the model call and
  trace), `ledger.js` + `turns.js` (the record and its reader),
  `feedback.js` (friction detection and the sweep), `events.js` (the
  timeline lane), `budget.js`.
- `agent/` — the example prompts every instance copied from.
- `test/` — `npm test`; the gate before every commit.
- Logs: `~/Library/Logs/elixir-mcp-discord/<label>.log`.
