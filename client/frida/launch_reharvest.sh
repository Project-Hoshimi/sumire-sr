#!/usr/bin/env bash
# A2 reharvest window launcher — cold-spawn the game under combined_hooks.js
# (FULLRAW=true dumps plaintext req/resp to /data/data/.../cache/raw/*.bin).
# Keep FIFO open for clean detach on Ctrl-C.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_DIR="${1:-$REPO_ROOT/captures/$(date +%F)_reharvest}"
mkdir -p "$SESSION_DIR"
LOG="$SESSION_DIR/capture_reharvest.log"
FIFO=/tmp/reharvest_frida_fifo

rm -f "$FIFO"; mkfifo "$FIFO"

echo "launching reharvest instrumented session -> $LOG"
echo "hooks: $REPO_ROOT/frida/combined_hooks.js (FULLRAW=true)"

exec 3<>"$FIFO"

frida -U -f game.qualiarts.idolypride \
  -l "$REPO_ROOT/frida/combined_hooks.js" \
  <&3 >"$LOG" 2>&1 &

FPID=$!
echo "frida pid=$FPID  (log: $LOG)"
echo "hit Ctrl-C here to detach"

wait $FPID