#!/usr/bin/env bash
# A1.2 call-shape probe launcher — spawns the game under Frida with ONLY the
# probe script (no combined_hooks: we want a clean, minimal attach).
# Logs to the given capture dir. Stays alive until killed; Ctrl-C detaches.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_DIR="${1:-$REPO_ROOT/captures/$(date +%F)_a12d}"
mkdir -p "$SESSION_DIR"
LOG="$SESSION_DIR/probe_a12.log"
FIFO=/tmp/a12_frida_fifo

rm -f "$FIFO"; mkfifo "$FIFO"

echo "launching probe session -> $LOG"
exec 3<>"$FIFO"

frida -U -f game.qualiarts.idolypride \
  -l "$REPO_ROOT/phaseA1/descriptors/descriptor_probe.js" \
  <&3 >"$LOG" 2>&1 &

FPID=$!
echo "frida pid=$FPID  (log: $LOG)"
wait $FPID