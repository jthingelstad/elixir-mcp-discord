# Close the Loop

Own the outcome: **what the bot files upstream is true and useful, what
comes back is acted on here, and the docs describe the shipped bot.**
Jamie's framing of this project: *"we really want this agent to give
feedback on what it wants to do but cannot."* That only pays if the
filings are about Elixir and not about this bot's own mistakes, and if an
answer from the maintainer changes something on this side.

## Every run

- **What was filed.** The ledger's `filed` records and the log's
  `feedback_filed`, `praise_filed`, `reaction_feedback_filed` lines since
  the previous run, per instance. For each: read the turn (`npm run turns
  -- --turn <id>`) and decide whether the filing names an Elixir
  limitation (a missing fact, a misleading shape, an unhelpful refusal) or
  a consumer defect wearing Elixir's clothes — the wrong tool for the
  question, a window the model chose badly, a retry loop, an answer the
  prompt should have shaped. The second kind is a Judge the Answers
  finding and a filing to stop repeating: fix the cause here.
- **The sweep's judgement.** `detectFriction` and `sweepFriction` in
  `src/feedback.js` decide when a turn files. A filing class that is
  consistently ours (`unexpectedErrors` letting through a code that is
  expected, `conceded_limit` firing on ordinary caveats) is a code fix
  with a test in `test/feedback.test.js`.
- **What came back.** Responses reach the bot on the feed hint
  (`meta.feedback_responses_pending`) and are posted by the bot in its
  channel; the log's `feedback_response_posted id=` lines name them. A response that asks this
  bot to change (use another tool, pass a parameter, read a note) is a
  gap here until shipped; a response that declines is recorded in the
  note so the same filing is not re-argued.
- **Praise.** A 👍 files praise with the turn's request id. Praise on a
  turn Judge graded below the bar is worth a line: readers and rules
  disagree, and the rule may be wrong.
- **Docs currency.** `AGENTS.md`, `README.md` and the example `agent/`
  describe the shipped bot: every `since <date>` section names behaviour
  that exists, every `npm run` script named exists, the bite list still
  bites. A rule this team changed is written where the next reader will
  find it.

## Sunday synthesis

Once per Chicago ISO week (the schedule names the slot; catch up if
blocked): filings per instance by kind, the share that were really about
Elixir, what Elixir answered and what changed here because of it, and the
one or two capability gaps the week's turns kept running into — the
material Jamie takes to Elixir's team. Append to the week's
`AGENT-TEAM/summaries/<year>-W<week>.md` under its own heading (Judge the
Answers writes the other). A retry resumes an incomplete section.

## Success

Every filing since the previous run has been read against its turn and
classified. No consumer-side defect is still being filed upstream a week
after it was found. Every maintainer response that asked for a change here
has one, or one framed decision. The docs and the bot agree.
