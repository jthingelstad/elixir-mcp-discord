# Slash commands, not a bang prefix

*Part of the decision ledger — dated, with the reason. [AGENTS.md](../../AGENTS.md) has the map and the rules. Read this before changing src/commands.js.*

`/budget`, `/routines`, `/run` (autocompleting over routine keys), registered
per guild at startup so they appear instantly. They replaced `!run` / `!routines`,
which needed MessageContent on every message on the off-chance one began with
a bang, could not be permission-gated by Discord, listed nothing, described
nothing, and made a typo indistinguishable from chat.

Admin-gated twice on purpose: `setDefaultMemberPermissions` hides them in the
picker (a hint a server can override) and `ADMIN_USER_IDS` actually enforces it
(the rule). `/run` defers its reply — a turn is a model call and Discord wants
an answer within three seconds.

If the commands never appear, the bot was invited without the
`applications.commands` scope; registration logs that with the fix.
