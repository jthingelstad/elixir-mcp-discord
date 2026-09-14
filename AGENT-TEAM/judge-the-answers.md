# Judge the Answers

Own the outcome: **what the bot said in Discord was grounded, right,
on-brief and in voice — and when it was not, the highest-leverage fix is
found and made.** The turn ledger is the evidence. Before it, the only
record of an answer was the thread it sat in; now every live turn carries
the question or brief, every tool call with what came back, the answer,
where it went, and what readers did about it.

The rubric is not invented here. It is the bot's own rules in
`src/prompt.js` and the instance's `identity.md`, read against what the
trace shows it actually had in hand.

## Every run

- **Read every turn since the last graded `at`**, per instance:
  `npm run turns -- --instance ~/.elixir-mcp-discord/<name> --since <date>`
  (`--turn <id>` for bodies uncut). Reactions first: a 👎 with a note is
  the highest-priority turn in the set; a 👍 is a turn to protect.
- **Grade each turn** against the rules, from the trace not the prose:
  - *Grounded.* Every number, name and claim in the answer appears in a
    tool result body of THIS turn (`GROUNDING`). A figure with no source in
    the trace is a defect even when it happens to be right.
    `output.ungrounded` is the mechanical version; this is the semantic one.
  - *Right.* The tool bodies say what the answer says they say: window,
    subject, count, direction. A completeness note or an `error` step the
    answer glossed over is a defect.
  - *Answered the question asked* (ask lane) — not a neighbouring one, not
    a re-answer of the thread's previous question. The history in `input`
    shows what the model saw.
  - *Identity.* First contact resolved by the `WHO_IS_ASKING` rule: a
    whole-name single roster match linked and answered in one reply;
    anything less asked; never a guess, never a partial match linked.
  - *On-brief* (routine lanes). The post did what the routine's file asked,
    posted where the directory and the brief pointed, respected `maySkip`
    both ways (posted nothing when nothing was new; did not answer SKIP to
    a routine that may not), did not repeat `recent`.
  - *Voice and format.* `DISCORD_FORMAT` and the house rules: no table, no
    greeting or sign-off, no narration of what it checked or is about to
    do, no in-line self-correction, at most one emoji, plain and short.
  - *Economy.* Calls proportional to the question (`many_calls`), no
    third try of a failing call, no live read where the record answered,
    no `truncated`.
- **Rank what was found by leverage**, not by count: one rule the prompt
  states badly, seen across several turns, outranks three one-off slips.
  A defect that traces to Elixir (a misleading body, a missing note) is a
  Close the Loop finding — hand it over with the `turnId` and request id.
- **Write the run's grades** as `AGENT-TEAM/notes/<date>-judge-the-answers.md`
  when anything is below the bar: one line per graded turn (instance,
  `turnId`, lane, verdict, the rule broken), then the ranked findings. No
  member names, ids, tags, questions or tool bodies in the note — the
  repo is public; the transcript is in the instance.

## Action

- A mechanics defect (the rule is in `src/prompt.js` or in code): fix in
  the run with a test in `test/prompt.test.js` or the lane's test, push,
  restart each instance, and accept against the next natural turns in the
  ledger.
- An example-prompt defect (`agent/` in the checkout): fix it there; the
  live instances are unchanged until Jamie applies it — frame that as one
  decision naming the file and the line.
- An instance-prompt defect with no checkout counterpart: one decision for
  Jamie with the evidence, never an edit to `~/.elixir-mcp-discord/*/agent/`.
- Never grade by asking the bot something. Never post. Never react.

## Sunday synthesis

Once per Chicago ISO week (the schedule names the slot; catch up if
blocked): turns graded per instance and lane, the share below the bar by
rule, the reactions and what they pointed at, what improved after the
week's fixes (before/after turns by `turnId`), one ranked list of the
highest-leverage prompt and code changes — shipped where within authority,
proposed to Jamie as single decisions where not. Write
`AGENT-TEAM/summaries/<year>-W<week>.md`. A retry resumes an incomplete
summary.

## Success

Every turn since the ledger began has been read by someone who checked
the numbers against the bodies. A 👎 is answered by a fix or a framed
decision within a week. The Sunday summary reads like an editor who
actually read the week's answers, and the trend it reports is up.
