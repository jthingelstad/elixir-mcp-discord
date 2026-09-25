# Contributing

Thank you for looking. This is a public reference implementation of a
Discord bot powered entirely by [Elixir MCP](https://elixir.poapkings.com),
and a working preview for the clans that run it, so the bar is "keeps the
rules and says why".

## Before you change anything

Read [AGENTS.md](AGENTS.md): the rules that are the whole point (no clan
in the repo, no local game data, no tool list, no fallback), how a change
is made here, and the map of [`docs/decisions/`](docs/decisions/) — the
dated reason for most of what the code does. Read the decision file for
the area you are touching first; a lot of odd-looking code is there
because the obvious version went wrong once.

## The gate

```bash
npm ci
npm run verify   # prettier, oxlint, knip, then the tests — what CI runs
```

The tests need no keys and no network (a fetch in a test fails its file).
The model, Discord and Elixir are injected; add a test beside the change,
and for a bug, a test that fails without the fix.

## Pull requests

- **Bugs, tests, docs, refactors that keep every test green:** a PR is
  welcome as is. One change per commit, with a message that says why.
- **Product changes** — anything that changes what the bot says to
  members, what it remembers, or what it may touch — start as an issue: the
  change as one concrete yes/no, with the evidence (turns from the ledger,
  a transcript, a number). The maintainer decides; then a PR.
- **Docs are part of the change.** A behaviour that moved gets its dated
  entry in the right `docs/decisions/` file and its sentence in the README;
  a new setting goes in `config.example.json`.
- **Never** a Clash Royale tag, a secret, an instance directory, or a
  hand-written tool list or schema in a commit.

## Security

Found a way for a member's message to make the bot do something it
should not — post elsewhere, change a setting, spend another lane's
budget, link someone else? Please open a private security advisory on
GitHub rather than an issue.
