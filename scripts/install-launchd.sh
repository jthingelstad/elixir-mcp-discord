#!/bin/bash
# Renders the launchd template for one INSTANCE and loads it.
#   ./scripts/install-launchd.sh                      the checkout is the instance
#   ./scripts/install-launchd.sh ~/.elixir-mcp-discord/pk   a named instance
#   ./scripts/install-launchd.sh [instance] uninstall stop + remove
#
# An instance is a directory holding `.env`, `agent/` and `state/`; the code
# stays in this checkout. Several instances of one checkout are several bots —
# one Discord app, one Elixir agent and one Claude key each — and each gets
# its own label, `com.poapkings.elixir-mcp-discord.<dirname>`, and its own log.
#
# Kept as a template rather than a committed plist because a plist is all
# absolute paths, and this repo is meant to be cloned by someone whose paths are
# not these.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_LABEL="com.poapkings.elixir-mcp-discord"

INSTANCE="$REPO"
ACTION="install"
for arg in "$@"; do
  case "$arg" in
    install|uninstall) ACTION="$arg" ;;
    *) INSTANCE="$(cd "$arg" && pwd)" ;;
  esac
done

if [ "$INSTANCE" = "$REPO" ]; then
  LABEL="$BASE_LABEL"
else
  LABEL="$BASE_LABEL.$(basename "$INSTANCE")"
fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/elixir-mcp-discord"
LOG="$LOG_DIR/$LABEL.log"

if [ "$ACTION" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi
# Resolve through the Homebrew symlink but stop there: pinning to the Cellar
# path (…/Cellar/node/26.8.1/bin/node) breaks silently on the next brew upgrade.

if [ ! -f "$INSTANCE/.env" ]; then
  echo "no .env in $INSTANCE — the job would crash-loop on boot" >&2
  exit 1
fi
if [ ! -d "$INSTANCE/agent/routines" ]; then
  echo "no agent/routines in $INSTANCE — nothing would run (copy $REPO/agent to start)" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents" "$INSTANCE/state"
sed -e "s|__LABEL__|$LABEL|g" \
    -e "s|__NODE__|$NODE|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__INSTANCE__|$INSTANCE|g" \
    -e "s|__LOG__|$LOG|g" \
    "$REPO/launchd/$BASE_LABEL.plist.template" > "$PLIST"

# bootout returns before the job is gone, and a running instance now finishes
# its in-flight turn first (up to 45s). Bootstrapping into a label that is
# still unloading fails with "Input/output error" and leaves NOTHING loaded,
# so wait for it to actually disappear.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in $(seq 1 70); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL"
echo "  instance: $INSTANCE"
echo "  plist:    $PLIST"
echo "  log:      $LOG"
