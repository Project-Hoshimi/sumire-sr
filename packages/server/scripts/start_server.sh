#!/usr/bin/env bash
# Start the A4 gateway (HTTP/2 + TLS) fully detached.
# Usage: bash scripts/start_server.sh [port]
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
PORT="${1:-8443}"
export PORT HTTP2=1 TLS=1
setsid nohup node src/server.ts >/tmp/a4_server.log 2>&1 </dev/null &
echo "server pid $!"
sleep 1.5
grep -E "listening|Error" /tmp/a4_server.log | tail -2 || true
