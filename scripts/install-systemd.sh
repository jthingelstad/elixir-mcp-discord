#!/bin/bash
# Renders the systemd user unit for this checkout and starts it.
#   ./scripts/install-systemd.sh            install + start
#   ./scripts/install-systemd.sh uninstall  stop + remove
#
# Logs: journalctl --user -u elixir-mcp-discord -f
set -euo pipefail

UNIT="elixir-mcp-discord"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT.service"

if [ "${1:-install}" = "uninstall" ]; then
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
if [ ! -f "$REPO/.env" ]; then
  echo "no .env in $REPO — the service would crash-loop on boot" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE|g" \
    -e "s|__REPO__|$REPO|g" \
    "$REPO/systemd/$UNIT.service.template" > "$UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"

echo "installed $UNIT"
echo "  unit: $UNIT_FILE"
echo "  logs: journalctl --user -u $UNIT -f"
echo "  to survive logout: loginctl enable-linger $USER"
