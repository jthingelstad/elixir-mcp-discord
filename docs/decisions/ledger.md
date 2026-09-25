# The turn ledger — since 2026-09-14

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/ledger.js, src/turns.js.*

`src/ledger.js` appends one JSON line per turn to
`<instance>/state/turns/YYYY-MM-DD.jsonl`, and `npm run turns` reads it back
as transcripts. It exists so the QUALITY of what the bot says can be judged:
before it, the log line had tool names and a price, `state.json` kept 200
turns with the answer clipped at 1200 chars and no tool inputs, and the
structured trace was rendered into the Discord footer and dropped. To ask "was
that number right?" you need the tool's result body, and nothing kept it.

- **Three record kinds, all keyed by `turnId`, all append-only:** `turn`
  (inputs — the question and thread history, or the brief and the timeline
  handed in; the system prompt's sha; the trace with every call's arguments
  AND result body, bounded at `LEDGER_BODY_CHARS`, 16 KB; the answer, where
  it went, footers, ungrounded/friction flags; usage and cost), `reaction`
  (👍/👎 with the reader's note) and `filed` (what the sweep sent upstream).
  Later signals are their own lines; `readTurns` folds them in on read.
- **The prompt is stored once per wording** at `state/prompts/<sha>.txt`,
  first time a sha is seen. Instance prompts live outside any git checkout,
  so this is the only record of which wording produced which answer.
- **Dry runs are not recorded.** `npm run try` is a rehearsal; the ledger is
  what Discord saw.
- **It never fails a turn.** `append` swallows and logs `ledger_write_failed`.
- **It holds members' names and questions.** It lives under `state/`,
  gitignored, and stays in the instance directory.
- **`src/claude.js` keeps each call's result body on its trace step**
  (`step.result`) for this; `renderTrace` does not show it and must not.
- Reading: `npm run turns -- --since 2026-09-13 --lane ask`, `--routine
  <key>`, `--turn <id>` (full bodies), `--full`, `--json`, `--export <dir>`
  (one `.md` per turn plus the prompts they ran on), `--instance <dir>` to
  read another instance's ledger. No `.env` is needed to read one —
  `ledger.js` resolves the instance directory itself rather than importing
  `config.js` for that reason.
