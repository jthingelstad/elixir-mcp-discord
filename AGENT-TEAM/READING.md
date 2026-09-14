# Objective reading map

Read `AGENTS.md`, `WORKFLOW.md`, this map and your objective. `AGENTS.md`
is the decision ledger as well as the guide — its dated "since" sections
and the bite list are where decisions live; there is no separate NOTES
file. Read what changed since the previous successful run (`git log
--since`), and on first use read it whole. Record the reviewed commit in
automation memory. A saved summary never overrides current source.

The source of the bot's behaviour is `src/` and the instance's `agent/`;
the source of Elixir's behaviour is <https://elixir.poapkings.com/docs>
(`agents`, `protocol`, `events`, `choosing-a-tool`) and its
`elixir_changelog` tool.

| Objective or finding | Required current documents |
|---|---|
| Run the Preview | `AGENTS.md` §Three bots one checkout, §Money, §Things that will bite you; `src/index.js` (boot, hello, shutdown), `src/permissions.js`, `src/events.js`, `src/budget.js`, `src/mcp.js` (principal, versions), `launchd/`; each instance's boot lines |
| Judge the Answers | `src/prompt.js` (every mechanics block — the rubric is these rules), the instance's `agent/identity.md` and `agent/routines/*.md` (read-only), `src/feedback.js` (`looksUngrounded`, `detectFriction`), `src/trace.js`, `src/ledger.js`, `src/turns.js`; `AGENTS.md` §The turn ledger, §The model picks the channel, §Voice |
| Close the Loop | `src/feedback.js` (what is filed and when), `src/reactions.js`, `AGENTS.md` §Feedback is the deliverable, §It is an AGENT not Jamie; Elixir's `agents` and `choosing-a-tool` docs; the ledger's `filed` records and the log's `feedback_filed` lines |
| An answer a member reacted 👎 to | Judge the Answers' row, plus that turn in full (`npm run turns -- --instance <dir> --turn <id>`) and its `reaction` note |
| A scheduled post in the wrong channel or repeated | `src/directory.js`, `src/run.js` (`postTool`), the routine's file in the instance, `state.lastPosts` for that routine, `AGENTS.md` §The model picks the channel and the recall bite |
| A first-contact identity miss | `WHO_IS_ASKING` in `src/prompt.js`, the house rule in the instance's `identity.md`, Elixir's `elixir_identify` semantics (clan members only; re-call replaces) |
| Elixir contract moved | `state.json` `serverVersion`/`contractVersion` and the log's `contract_version_changed`, Elixir's changelog entry, `src/mcp.js`, `src/events.js` if the timeline shape moved, the routine front matter (`kinds:`/`sections:`) |
| An instance silent | `AGENTS.md` first-bite (the 2026-09-13 format outage): `routine_invalid`, `no_routines_load`, `message_unclaimed` in the log; `launchctl print gui/$(id -u)/com.poapkings.elixir-mcp-discord.<name>` |
