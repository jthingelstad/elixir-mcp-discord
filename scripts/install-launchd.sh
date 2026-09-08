#!/bin/bash
# Renders the launchd template for this checkout and loads it.
#   ./scripts/install-launchd.sh            install + start
#   ./scripts/install-launchd.sh uninstall  stop + remove
#
# Kept as a template rather than a committed plist because a plist is all
# absolute paths, and this repo is meant to be cloned by someone whose paths are
# not these.
set -euo pipefail

LABEL="com.poapkings.elixir-mcp-discord"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/elixir-mcp-discord"
LOG="$LOG_DIR/$LABEL.log"

if [ "${1:-install}" = "uninstall" ]; then
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

if [ ! -f "$REPO/.env" ]; then
  echo "no .env in $REPO — the job would crash-loop on boot" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
sed -e "s|__LABEL__|$LABEL|g" \
    -e "s|__NODE__|$NODE|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__LOG__|$LOG|g" \
    "$REPO/launchd/$LABEL.plist.template" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL"
echo "  plist: $PLIST"
echo "  log:   $LOG"
