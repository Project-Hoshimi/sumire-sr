#!/usr/bin/env bash
# A4 E2E attach launcher — attach frida to the ALREADY-RUNNING game process by
# name (needed when spawn hangs), keep FIFO stdin open so the session stays alive.
# Usage: attach_e2e.sh [SESSION_DIR]
set -u

SERIAL="${ANDROID_SERIAL:?set ANDROID_SERIAL to your device serial}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

SESSION_DIR="${1:-$REPO/captures/$(date +%F)_a4e2e_attach}"
mkdir -p "$SESSION_DIR" 2>/dev/null || { SESSION_DIR="/tmp/$(date +%F)_a4e2e_attach"; mkdir -p "$SESSION_DIR"; }
LOG="$SESSION_DIR/capture_e2e.log"
FIFO=/tmp/a4e2e_attach_fifo

rm -f "$FIFO"; mkfifo "$FIFO"

PID="${PID:-$(adb -s "$SERIAL" shell pidof game.qualiarts.idolypride 2>/dev/null | tr -d '\r\n')}"
if [ -z "$PID" ]; then echo "game not running (no pid); abort"; exit 1; fi

echo "attaching E2E session -> $LOG (pid=$PID)"
exec 3<>"$FIFO"

frida -D "$SERIAL" -p "$PID" \
  -l "$REPO/frida/e2e_hooks.js" \
  <&3 >"$LOG" 2>&1 &

FPID=$!
echo "frida pid=$FPID  (log: $LOG, target pid=$PID)"
wait $FPID
