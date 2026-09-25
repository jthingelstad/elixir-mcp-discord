# Three bots, one checkout — since 2026-09-13

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/config.js, src/env-file.js, src/setup.js, src/permissions.js, src/commands.js.*

The **instance is a directory** — the cwd, or `INSTANCE_DIR`. `.env`,
`config.json`, `agent/` and `state/` resolve against it, never against the
checkout (`instanceDir` in `src/config.js`, `STATE_PATH` in `src/state.js`).
**Since 2026-09-15 `.env` holds what the bot may not change about itself**
— `ENV_FILE_KEYS` in `src/env-file.js`: the three secrets and the three
wiring ids (`ELIXIR_MCP_URL`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`) — and
`config.json` holds every setting it may change, flat, the same key names
as before, so it can be versioned with the instance, backed up under
`.history/` and edited from the DM with a diff. That is the rule for which
file a key goes in ("if it isn't editable it belongs in .env" — Jamie),
not secrecy: the ids briefly sat in `config.json` and were moved back the
same day. `lookup()` in `config.js` reads `.env`'s keys and path overrides
from the environment and everything else from `config.json` first,
environment second (tests and deliberate shell overrides); a shell
`CLAUDE_EFFORT` no longer silently outranks the file. A pre-`config.json`
instance is migrated on its first boot by `migrateEnvToConfig` (settings
out, `.env` rewritten, the old copy under `state/env-history/`, a
`config_migrated` log line and a DM); a `config.json` from the wiring day
has the ids moved back the same way (`wiring_moved_back`).
`config.example.json` documents every setting; `.env.example` the rest.

One checkout can run several: the maintainer runs three clans as three
Discord applications in ONE server, each with its own ask channel and
whatever channels its role is explicitly granted, its own Elixir agent (an
agent is its own account, so its feed cursor and feedback inbox are its
own) and its own Claude key. Which ones, where, and under which service
labels is the maintainer's own `../AGENTS.md`, outside this repository.

- **There is no `.env` in the checkout any more**, so a bare `npm run try`
  fails and says so. The instance is the cwd OR `INSTANCE_DIR`:
  `INSTANCE_DIR=~/.elixir-mcp-discord/shipit npm run try <routine>` / `probe`
  / `routines`. (A shell `CLAUDE_EFFORT` no longer shadows anything:
  `config.json` wins for every setting it names; the provenance line says
  where each value came from.)
- **`npm run setup -- <instance-dir>` is the whole process** (`src/setup.js`,
  helpers in `src/setup-catalog.js`, `src/discord-rest.js`, `src/env-file.js`):
  Elixir key, Claude key and Discord app each tried against its service BEFORE
  `.env` is written; invite link printed when the bot is not in the server;
  the timezone; the ask channel picked from the server's list and
  permission-checked over REST (`computePermissions` reproduces Discord's
  overwrite algorithm so `inspectChannel` judges a REST channel by the boot
  check's rule) — bound whether or not a message routine exists yet;
  budgets; admin ids checked as members; then an offer to install the
  service and show the boot lines. **Since 2026-09-14 setup wires the
  connection and nothing else**: routines, schedules and the clan notes
  moved to the DM (dm.md), because choosing them needs the directory, the
  clan and the operator's evening, which the bot has only once connected —
  and the person choosing is on a phone. The terminal picker remains behind
  a yes/no (default no). A bot that boots with nothing enabled sends
  `introduce()` — where it may post, what it can run, "say the usual" — as
  a `welcome` notice, once a day. **Setup only ever ADDS routine files** —
  never overwrites or deletes one; chosen-off is `ROUTINES_DISABLED`. `--check` is the no-prompt form and
  passes on a live instance. It does not import `config.js`'s validated sections on
  purpose — those read the cwd, and setup's directory may have no `.env` yet;
  `initialize(auth)` in `src/mcp.js` takes an override for the same reason.
- **Prompts are per instance and diverge on purpose** — each clan's `agent/`
  is how that clan decides how its bot engages. The checkout's `agent/` is the
  example everyone else copies; editing it changes no live bot. A change
  meant for all three is three edits (or a copy).
- **A code change is a restart of each instance**, prompts hot-load as ever.
  Restart one first: `launchctl kickstart -k gui/$(id -u)/<label>`.
- **`COMMAND_PREFIX` keeps the slash commands apart.** Discord registers
  commands per application; three unprefixed `/run`s differ only by avatar.
  `baseCommand` strips the prefix on the way in and returns null for a name
  that is not ours.
- **Channels are checked at boot** (`src/permissions.js`): in the guild, text
  channel, role has View/Send/ReadHistory, plus CreatePublicThreads and
  SendMessagesInThreads where a message routine listens. Every failure is an
  `ERROR` with the permission named, plus one Discord post in the first
  usable channel, deduplicated by a fingerprint in `state.channelProblems`
  so a crash loop does not repeat it. The bot keeps running — the lanes that
  work should — but a pasted id from the wrong clan's channel is now a loud
  boot, not a stranger's clan report.
