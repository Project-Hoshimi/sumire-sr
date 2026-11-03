#!/usr/bin/env bash
# Phase 2/3 — A1.2 instrumented window launcher (FIFO keepalive, as in A2).
# Launches the game under Frida with combined_hooks + descriptor_dump, logs
# [A1.2] lines + RPC trace to the capture dir, stays alive until killed.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_DIR="${1:-$REPO_ROOT/captures/$(date +%F)_a12d}"
mkdir -p "$SESSION_DIR"
LOG="$SESSION_DIR/capture_a12.log"
FIFO=/tmp/a12_frida_fifo

# make sure nothing stale
rm -f "$FIFO"; mkfifo "$FIFO"

echo "launching instrumented session -> $LOG"
echo "A1.2 target table embedded in descriptor_dump.js (1,727 classes; no upload needed)"

exec 3<>"$FIFO"   # keep FIFO open R/W so frida's stdin never hits EOF

frida -U -f game.qualiarts.idolypride \
  -l "$REPO_ROOT/frida/combined_hooks.js" \
  -l "$REPO_ROOT/phaseA1/descriptors/descriptor_dump.js" \
  <&3 >"$LOG" 2>&1 &

FPID=$!
echo "frida pid=$FPID  (log: $LOG)"

# keep the session alive in the foreground; Ctrl-C detaches frida (collects log)
# The FIFO fd stays open in this shell; when this shell exits, frida's stdin
# closes -> frida CLI detaches cleanly, leaving hooks until process ends.
wait $FPID
