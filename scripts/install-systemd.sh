#!/bin/bash
# Renders the systemd user unit for one INSTANCE and starts it.
#   ./scripts/install-systemd.sh                        the checkout is the instance
#   ./scripts/install-systemd.sh ~/.elixir-mcp-discord/pk   a named instance
#   ./scripts/install-systemd.sh [instance] uninstall   stop + remove
#
# An instance is a directory holding `.env`, `agent/` and `state/`; the code
# stays in this checkout, and several instances are several bots. A named
# instance's unit is `elixir-mcp-discord-<dirname>`.
#
# Logs: journalctl --user -u <unit> -f
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="$REPO"
ACTION="install"
for arg in "$@"; do
  case "$arg" in
    install|uninstall) ACTION="$arg" ;;
    *) INSTANCE="$(cd "$arg" && pwd)" ;;
  esac
done
UNIT="elixir-mcp-discord"
[ "$INSTANCE" = "$REPO" ] || UNIT="$UNIT-$(basename "$INSTANCE")"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT.service"

if [ "$ACTION" = "uninstall" ]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "uninstalled $UNIT"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi
if [ ! -f "$INSTANCE/.env" ]; then
  echo "no .env in $INSTANCE — the service would crash-loop on boot" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR" "$INSTANCE/state"
sed -e "s|__NODE__|$NODE|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__INSTANCE__|$INSTANCE|g" \
    "$REPO/systemd/elixir-mcp-discord.service.template" > "$UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"

echo "installed $UNIT"
echo "  unit: $UNIT_FILE"
echo "  logs: journalctl --user -u $UNIT -f"
echo "  to survive logout: loginctl enable-linger $USER"
