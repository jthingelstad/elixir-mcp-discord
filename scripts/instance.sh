#!/bin/bash
# Run the CLI against one instance without leaving this checkout.
#   ./scripts/instance.sh <instance-dir> probe
#   ./scripts/instance.sh <instance-dir> routines
#   ./scripts/instance.sh <instance-dir> try <routine>
#   ./scripts/instance.sh <instance-dir> start
#
# `npm run` always changes into the checkout, which is exactly the wrong
# directory: the instance's .env, agent/ and state/ live where you point this.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ $# -lt 2 ]; then
  sed -n '2,6p' "$0" >&2
  exit 1
fi
INSTANCE="$(cd "$1" && pwd)"; shift
COMMAND="$1"; shift

cd "$INSTANCE"
case "$COMMAND" in
  probe) exec node "$REPO/src/probe.js" "$@" ;;
  start) exec node "$REPO/src/index.js" "$@" ;;
  routines) exec node "$REPO/src/cli.js" list "$@" ;;
  *) exec node "$REPO/src/cli.js" "$COMMAND" "$@" ;;
esac
