#!/usr/bin/env bash
# Official-server FULLRAW capture launcher for PHOTO MODE (Phase 0).
# Loads combined_hooks.js (FULLRAW plaintext dump) + photo_redirect.js
# (DNS redirect of api.octo-cloud.com / api.game-idolypride.jp -> 127.0.0.1).
# The guest Wi-Fi blocks TCP 443 to the official GCP servers, so TLS connects
# are tunnelled over USB: adb reverse tcp:443 -> host photo_sni_proxy.py
# (transparent SNI relay to the real servers; no MITM, byte-exact).
# Modeled on launch_a12.sh but without the descriptor_dump side-script.
set -u

SERIAL="${ANDROID_SERIAL:?set ANDROID_SERIAL to your device serial}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_DIR="${1:-$REPO_ROOT/captures/$(date +%F)_photo}"
mkdir -p "$SESSION_DIR"
LOG="$SESSION_DIR/capture_a12.log"
FIFO=/tmp/photo_frida_fifo

# make sure nothing stale
rm -f "$FIFO"; mkfifo "$FIFO"

echo "launching official FULLRAW photo session -> $LOG"
echo "hooks: combined_hooks.js (FULLRAW) + photo_redirect.js (dns->127.0.0.1 via USB tunnel)"

exec 3<>"$FIFO"   # keep FIFO open R/W so frida's stdin never hits EOF

frida -D "$SERIAL" -f game.qualiarts.idolypride \
  -l "$REPO_ROOT/frida/combined_hooks.js" \
  -l "$REPO_ROOT/frida/photo_redirect.js" \
  <&3 >"$LOG" 2>&1 &

FPID=$!
echo "frida pid=$FPID  (log: $LOG)"

# keep the session alive in the foreground; Ctrl-C detaches frida (collects log)
wait $FPID
