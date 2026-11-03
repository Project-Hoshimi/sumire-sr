#!/usr/bin/env bash
# A4 E2E window launcher — cold-spawn the game under e2e_hooks.js (unpin +
# getaddrinfo redirect), keep FIFO open for clean detach on Ctrl-C.
set -u

SERVER_HOST="${SERVER_HOST:?set SERVER_HOST to your server's LAN IP}"
SESSION_DIR="${1:-}"
if [ -z "$SESSION_DIR" ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  SESSION_DIR="$REPO_ROOT/captures/$(date +%F)_a4e2e"
fi
if ! mkdir -p "$SESSION_DIR" 2>/dev/null; then
  SESSION_DIR="/tmp/$(date +%F)_a4e2e"
  echo "SESSION_DIR not writable; falling back to $SESSION_DIR"
  mkdir -p "$SESSION_DIR"
fi
LOG="$SESSION_DIR/capture_e2e.log"
FIFO=/tmp/a4e2e_frida_fifo

rm -f "$FIFO"; mkfifo "$FIFO"

echo "launching E2E instrumented session -> $LOG"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "hooks: $REPO_ROOT/frida/e2e_hooks.js"

exec 3<>"$FIFO"

frida -U -f game.qualiarts.idolypride \
  -l "$REPO_ROOT/frida/e2e_hooks.js" \
  <&3 >"$LOG" 2>&1 &

FPID=$!
echo "frida pid=$FPID  (log: $LOG)"
echo "hit Ctrl-C here to detach; server is on https://$SERVER_HOST:8443"

wait $FPID
