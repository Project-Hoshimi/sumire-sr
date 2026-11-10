#!/usr/bin/env bash
# Official-server FULLRAW capture by attaching, for LSPatch manager-mode builds.
#
# Use this when the full combined_hooks.js misbehaves: on the 6.1.0 manager-mode
# build a cold spawn with it crashes in LSPatch init, and attaching with it fails
# with "timeout was reached" and leaves the game frozen on a white screen. Only
# the il2cpp section of combined_hooks.js is loaded here. That also leaves out
# the SSL_VERIFY_NONE pass, and no SNI proxy or adb reverse is involved, so the
# network must reach the official servers directly.
#
#   ANDROID_SERIAL=<serial> bash frida/attach_official.sh start <session dir>
#     Restarts the game and attaches. Stays in the foreground; Ctrl-C detaches.
#     Tap past the title screen only after "All il2cpp hooks installed" is logged.
#   ANDROID_SERIAL=<serial> bash frida/attach_official.sh pull <session dir>
#     Copies the dumps to <session dir>/raw/. Safe while the game is running.
#   bash frida/attach_official.sh hooks
#     Prints the il2cpp section that gets loaded.
#
# Then decode with: node tools/decode_capture.ts <session dir>
# captures/ is not gitignored and these dumps hold tokens: never stage them.
set -u

PKG=game.qualiarts.idolypride
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS="$REPO_ROOT/frida/combined_hooks.js"
PHONE_RAW="/data/data/$PKG/cache/raw"
[ -d "$HOME/.venvs/frida/bin" ] && PATH="$HOME/.venvs/frida/bin:$PATH"

die() { echo "attach_official: $*" >&2; exit 2; }

# The il2cpp section starts with a comment opened on the last line of section 2.
print_hooks() {
  awk 'found { print } /^setInterval\(runNativePass, 3000\);\/\*$/ { found = 1; print "/*" }' "$HOOKS"
}

phone() { timeout 20 adb -s "$SERIAL" shell "$@" </dev/null | tr -d '\r'; }

attached_pids() {
  ps -axo pid=,command= | grep -E "[f]rida -D $SERIAL -p" | awk '{print $1}'
}

pull_raw() {
  mkdir -p "$1/raw"
  timeout 120 adb -s "$SERIAL" exec-out "su -c 'tar -C $PHONE_RAW -cf - .'" </dev/null \
    | tar -C "$1/raw" -xf - || die "pull failed"
  echo "$1/raw: $(ls "$1/raw" | wc -l | tr -d ' ') files"
}

start() {
  local session=$1

  # Checks that change nothing come first, so a refusal leaves the game running.
  local want have
  want=$(sed -nE "s/^const GAME_VERSION = '([^']+)';.*/\1/p" "$HOOKS")
  have=$(phone dumpsys package "$PKG" | sed -nE 's/^ *versionName=(.*)$/\1/p' | head -n 1)
  [ -n "$want" ] || die "no GAME_VERSION in $HOOKS"
  [ "$have" = "$want" ] || die "phone has game version '$have', hooks are set to '$want'"

  # A restarted capture numbers its files from 0 again and would overwrite these.
  if [ -n "$(ls -A "$session/raw" 2>/dev/null)" ]; then
    die "$session/raw already has dumps; use a new session dir"
  fi

  [ -z "$(attached_pids)" ] || die "frida is already attached; detach it first (this would end that capture)"

  mkdir -p "$session"
  local js="$session/hooks_il2cpp.js"
  print_hooks > "$js"
  [ -s "$js" ] || die "il2cpp section not found in $HOOKS"

  # Move old dumps aside rather than delete them; the hooks recreate the directory.
  local stamp old
  stamp=$(date +%Y%m%d-%H%M%S)
  old=$(phone "su -c 'ls $PHONE_RAW 2>/dev/null | wc -l'")
  if [ "${old:-0}" != 0 ]; then
    phone "su -c 'mv $PHONE_RAW $PHONE_RAW.prev-$stamp'"
    echo "moved $old old dumps to $PHONE_RAW.prev-$stamp on the phone"
  fi

  phone am force-stop "$PKG" >/dev/null
  sleep 1
  phone monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 4
  local pid
  pid=$(phone pidof "$PKG")
  [ -n "$pid" ] || die "game did not start"

  local fifo log="$session/capture.log"
  fifo=$(mktemp -u /tmp/attach_official.XXXXXX)
  mkfifo "$fifo" || die "mkfifo failed"
  exec 3<>"$fifo"   # keeps frida's stdin open without a terminal
  rm -f "$fifo"

  echo "attaching to game pid $pid, log: $log"
  echo "Ctrl-C detaches. If the game restarts, the hooks are gone: run this again with a new session dir."
  frida -D "$SERIAL" -p "$pid" -l "$js" <&3 >"$log" 2>&1
}

cmd=${1:-}
case "$cmd" in
  hooks) print_hooks; exit 0 ;;
  start|pull) ;;
  *) die "usage: attach_official.sh start|pull <session dir>, or hooks" ;;
esac

SERIAL="${ANDROID_SERIAL:?set ANDROID_SERIAL to your device serial}"
command -v adb >/dev/null || PATH="$HOME/android-sdk-en/platform-tools:$PATH"
command -v adb >/dev/null || die "adb not found"
command -v frida >/dev/null || die "frida not found"
SESSION="${2:?usage: attach_official.sh $cmd <session dir>}"

case "$cmd" in
  start) start "$SESSION" ;;
  pull) pull_raw "$SESSION" ;;
esac
