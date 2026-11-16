#!/usr/bin/env bash
# Start the gatekeeper locally. Loads .env if present.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
if [ -z "${AGENT_GAMES_HMAC_SECRET:-}" ]; then
  echo "WARNING: AGENT_GAMES_HMAC_SECRET is not set — HMAC verification DISABLED (dev mode)." >&2
fi
exec node server.mjs
