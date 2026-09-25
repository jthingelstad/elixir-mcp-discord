# Running it with Docker

The recommended way to run a bot on a machine that is always on — a
Mac mini, a Linux box, a NAS, a Raspberry Pi, a small VPS. This page
assumes you know what Docker is but have not run anything with it.

## The four words you need

- **Image** — a frozen bundle of Node, this code and its dependencies,
  built from the `Dockerfile`. Like a release tarball that brings its own
  runtime. Building it again after a code change makes a new image; the old
  one is untouched.
- **Container** — a running copy of an image. It sees only the folders you
  hand it. Here that is one: the instance directory (`.env`,
  `config.json`, `agent/`, `state/`), mounted at `/instance`. Stopping or
  deleting a container loses nothing, because everything the bot keeps is
  in that folder on your disk.
- **Compose** — a small YAML file, `compose.yml`, that says "run these
  containers, with these folders, and bring each back if it stops". It
  replaces the launchd plist or systemd unit. One file can run several
  bots.
- **Runtime** — the program that runs containers. On Linux, Docker Engine.
  On a Mac, containers need a small Linux VM, which one of these provides:
  **Docker Desktop** (the most documented), **OrbStack** (lighter, faster
  to start) or **Colima** (open source, command line). Any of them works;
  set it to **start at login**, or the bots do not come back after a
  reboot.

## First bot

```bash
git clone https://github.com/jthingelstad/elixir-mcp-discord && cd elixir-mcp-discord
docker build -t elixir-mcp-discord .
mkdir -p ~/.elixir-mcp-discord/myclan

# Setup, inside the image, so the host needs no Node:
docker run -it --rm --user "$(id -u):$(id -g)" \
  -v ~/.elixir-mcp-discord/myclan:/instance \
  elixir-mcp-discord node src/setup.js /instance

# The bot:
./scripts/install-docker.sh ~/.elixir-mcp-discord/myclan
```

The last line writes `~/.elixir-mcp-discord/compose.yml` and starts the
bot. Then DM it, as the README says. From a release on, `--image 0.4.0`
runs the published image (`ghcr.io/jthingelstad/elixir-mcp-discord`)
instead of building this checkout.

## Day to day

Run these from the directory that holds `compose.yml`
(`~/.elixir-mcp-discord`):

| You want to | Docker | launchd, for comparison |
|---|---|---|
| see what is running | `docker compose ps` | `launchctl list \| grep elixir` |
| read a bot's log | `docker compose logs -f myclan` | `tail -f ~/Library/Logs/...` |
| restart one bot | `docker compose restart myclan` | `launchctl kickstart -k gui/$(id -u)/<label>` |
| run new code | `git pull` in the checkout, then `docker compose up -d --build` | `git pull`, then kickstart each |
| stop one bot | `docker compose stop myclan` | `./scripts/install-launchd.sh <dir> uninstall` |
| try a routine | unchanged: `INSTANCE_DIR=~/.elixir-mcp-discord/myclan npm run try editor` on the host, or `docker compose exec myclan node src/cli.js try editor` | same |

A prompt edit is still never a restart: `agent/` is the folder on your
disk, and the bot re-reads it. The log rotates on its own (five files of
10 MB per bot).

## Moving a bot from launchd (or systemd) to Docker

Nothing inside the instance moves: the same `.env`, `config.json`,
`agent/`, `state/` and git history are mounted as they are. Do one bot
first and live with it for a few days.

1. **Install a runtime** (above) and set it to start at login. Check with
   `docker info`.
2. **Build the image** from the checkout: `docker build -t
   elixir-mcp-discord .`
3. **Stop the old service for that one bot** — never run both: two
   processes on one bot token answer every question twice.
   `./scripts/install-launchd.sh ~/.elixir-mcp-discord/<name> uninstall`
   (or `install-systemd.sh ... uninstall`).
4. **Start it in Docker:** `./scripts/install-docker.sh
   ~/.elixir-mcp-discord/<name>`. The script refuses if the old service is
   still running.
5. **Read the boot lines:** `docker compose logs <name>` from
   `~/.elixir-mcp-discord`. Look for `discord_ready`, `mcp_connected`,
   `channels_ok` and the `build=` line, exactly as in the launchd log. The
   startup DM arrives as before.
6. **Later bots:** stop each one's old service, then run the script again
   with every instance that should be in Docker (the file is regenerated,
   not merged): `./scripts/install-docker.sh ~/.elixir-mcp-discord/{a,b,c}`.

**Going back** is the same in reverse: `docker compose stop <name>` (and
`./scripts/install-docker.sh <dir> uninstall` to remove the container),
then `./scripts/install-launchd.sh <dir>`.

## When something is wrong

- **The bot is gone after a reboot.** The runtime did not start at login.
  Start it; `restart: unless-stopped` brings the bots back on its own.
- **`permission denied` on `.env` or `state/`.** The container runs as the
  user in `compose.yml`'s `user:` line, which the script sets to whoever
  ran it. Run the script as the user who owns the instance directory.
- **A setting changed from the DM that needs a restart** (the command
  prefix, the poll interval): the bot exits and Docker starts it again.
  That is what `SERVICE_MANAGED=1` in the image is for.
- **`docker compose` says the file was not written by the script.** The
  script only overwrites a `compose.yml` it wrote; move yours aside.
