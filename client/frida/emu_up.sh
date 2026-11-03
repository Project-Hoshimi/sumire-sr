#!/usr/bin/env bash
# emu_up.sh — one idempotent entry point for the IDOLY PRIDE Android emulator.
# macOS counterpart to device_up.sh: screen sessions instead of systemd, adb root
# instead of Magisk, snapshots instead of reinstalls.
#
# Usage:
#   bash frida/emu_up.sh provision            # one-time steps 1-7 (CA_PEM=... to install the CA)
#   bash frida/emu_up.sh private [SESSION_DIR] # boot if needed, root, frida-server, reverse, attach
#   bash frida/emu_up.sh status               # check only, change nothing
#   bash frida/emu_up.sh reset                # load the clean-rooted snapshot
#   bash frida/emu_up.sh down                 # stop the frida job, force-stop the game
#   bash frida/emu_up.sh kill                 # down + shut the emulator down
#   bash frida/emu_up.sh help                 # this text
#
# The CA step takes the path to the dev CA PEM in $CA_PEM; if it is unset the
# step prints [WARN] and is skipped.
#
# Exit codes: 0 = no failures, 1 = at least one [FAIL], 2 = emulator not running.
#
# See docs/EMULATOR_RUNBOOK.md for the architecture and every known failure mode.
set -u

SERIAL="${EMU_SERIAL:-emulator-5580}"
export ANDROID_SERIAL="$SERIAL"
export ANDROID_HOME="${ANDROID_SDK_ROOT:?set ANDROID_SDK_ROOT}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ADB="$ANDROID_HOME/platform-tools/adb"
EMU_BIN="$ANDROID_HOME/emulator/emulator"
AVD=idoly33
PORT=5580
PKG=game.qualiarts.idolypride
SNAPSHOT=clean-rooted
FRIDA_VERSION=17.18.0
FRIDA_BIN="$REPO/.venv-frida/bin"
TOOLS_DIR="$REPO/tools/emulator"
CA_PEM="${CA_PEM:-$REPO/tls/ca.crt}"
LABEL_EMU=idoly.emulator
LABEL_FRIDA=idoly.frida
SYS_CA_DIR=/system/etc/security/cacerts

if [ ! -x "$ADB" ]; then
  ADB="$(command -v adb 2>/dev/null || true)"
fi

MODE="${1:-private}"
SESSION_DIR="${2:-}"
CHECK_ONLY=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

case "$MODE" in
  provision) ;;
  private)   ;;
  status)    CHECK_ONLY=1 ;;
  reset|down|kill) ;;
  -h|--help|help) usage; exit 0 ;;
  *) echo "unknown mode: $MODE (use provision | private | status | reset | down | kill | help)"; exit 64 ;;
esac

if [ -z "$ADB" ] || [ ! -x "$ADB" ]; then
  echo "[FAIL] adb: not found (looked at $ANDROID_HOME/platform-tools/adb and PATH) — set ANDROID_HOME"
  exit 1
fi

if [ -z "$SESSION_DIR" ]; then
  SESSION_DIR="$REPO/captures/$(date +%F)_emu_e2e"
fi
# detached jobs do not inherit our cwd, so hand them an absolute path
case "$SESSION_DIR" in /*) ;; *) SESSION_DIR="$PWD/$SESSION_DIR" ;; esac

N_OK=0
N_FIXED=0
N_WARN=0
N_FAIL=0

ok()    { N_OK=$((N_OK + 1));    printf '[OK] %s\n' "$*"; }
fixed() { N_FIXED=$((N_FIXED + 1)); printf '[FIXED] %s\n' "$*"; }
warn()  { N_WARN=$((N_WARN + 1));  printf '[WARN] %s\n' "$*"; }
fail()  { N_FAIL=$((N_FAIL + 1));  printf '[FAIL] %s\n' "$*"; }

adbs() { "$ADB" -s "$SERIAL" "$@"; }

summary() {
  local code="${1:-}"
  echo
  echo "Summary: OK=$N_OK FIXED=$N_FIXED WARN=$N_WARN FAIL=$N_FAIL"
  if [ "$code" = 2 ]; then
    echo "Exit: 2 (emulator not running)"
  elif [ "$N_FAIL" -gt 0 ]; then
    echo "Exit: 1 (fix the [FAIL] lines above)"
  else
    echo "Exit: 0"
  fi
}

finish() {
  local code="${1:-}"
  if [ -z "$code" ]; then
    if [ "$N_FAIL" -gt 0 ]; then code=1; else code=0; fi
  fi
  summary "$code"
  exit "$code"
}

# ------------------------------------------------------------ host jobs

# Long-lived host processes run in detached screen sessions named after the
# label. launchd agents cannot read ~/Documents (TCC), where the repo lives, and
# a screen session started from the terminal inherits its file access. Sessions
# are one-shot: an exited frida attach is not respawned with a stale PID.
job_running() { screen -ls 2>/dev/null | grep -q "[0-9]\.$1[[:space:]]"; }

stop_job() {
  screen -S "$1" -X quit >/dev/null 2>&1
  launchctl remove "$1" >/dev/null 2>&1   # pre-screen launchd jobs
}

# Replaces any previous instance of the label; output goes to tools/emulator/<label>.log
launch_job() {
  local label="$1"
  shift
  mkdir -p "$TOOLS_DIR"
  stop_job "$label"
  # macOS ships screen 4.00 (no -Logfile), so redirect inside the session
  screen -dmS "$label" /bin/bash -c 'log="$1"; shift; exec "$@" >>"$log" 2>&1' \
    _ "$TOOLS_DIR/$label.log" "$@"
}

# ------------------------------------------------------------ device helpers

adb_state() {
  adbs devices 2>/dev/null | tr -d '\r' | awk -v s="$SERIAL" '$1 == s {print $2; exit}'
}

wait_device() {
  local i
  for i in $(seq 1 30); do
    [ "$(adb_state)" = device ] && return 0
    sleep 1
  done
  return 1
}

boot_completed() {
  adbs shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n '
}

boot_wait() {
  local i
  for i in $(seq 1 90); do
    [ "$(boot_completed)" = 1 ] && return 0
    sleep 2
  done
  return 1
}

system_writable() {
  adbs shell 'touch /system/etc/.emu_up_probe 2>/dev/null && rm -f /system/etc/.emu_up_probe' >/dev/null 2>&1
}

ensure_root() {
  local uid i
  uid=$(adbs shell id -u 2>/dev/null | tr -d '\r\n ')
  [ "$uid" = 0 ] && return 0
  adbs root >/dev/null 2>&1
  for i in $(seq 1 10); do
    sleep 1
    uid=$(adbs shell id -u 2>/dev/null | tr -d '\r\n ')
    [ "$uid" = 0 ] && return 0
  done
  return 1
}

stop_game() {
  local i
  adbs shell am force-stop "$PKG" >/dev/null 2>&1
  for i in $(seq 1 10); do
    [ -z "$(adbs shell pidof "$PKG" 2>/dev/null | tr -d '\r\n ')" ] && return 0
    sleep 1
  done
  return 1
}

# ------------------------------------------------------------ frida helpers

host_frida_version() {
  [ -x "$FRIDA_BIN/frida" ] || return 0
  "$FRIDA_BIN/frida" --version 2>/dev/null | tr -d '\r\n'
}

frida_server_version() {
  adbs shell /data/local/tmp/frida-server --version 2>/dev/null | tr -d '\r\n '
}

frida_ps_ok() {
  [ -x "$FRIDA_BIN/frida-ps" ] || return 1
  "$FRIDA_BIN/frida-ps" -D "$SERIAL" >/dev/null 2>&1
}

frida_server_bin() { echo "$TOOLS_DIR/frida-server-$FRIDA_VERSION-android-arm64"; }

download_frida_server() {
  local bin url
  bin="$(frida_server_bin)"
  [ -f "$bin" ] && return 0
  mkdir -p "$TOOLS_DIR" || return 1
  if [ ! -f "$bin.xz" ]; then
    url="https://github.com/frida/frida/releases/download/$FRIDA_VERSION/frida-server-$FRIDA_VERSION-android-arm64.xz"
    command -v curl >/dev/null 2>&1 || { fail "frida: curl not found"; return 1; }
    curl -fsSL "$url" -o "$bin.xz" || { rm -f "$bin.xz"; fail "frida: download failed: $url"; return 1; }
  fi
  command -v xz >/dev/null 2>&1 || { fail "frida: xz not found — install it: brew install xz"; return 1; }
  xz -d -f "$bin.xz" || { fail "frida: could not unpack $bin.xz"; return 1; }
  [ -f "$bin" ]
}

push_frida_server() {
  local bin
  bin="$(frida_server_bin)"
  [ -f "$bin" ] || download_frida_server || return 1
  adbs push "$bin" /data/local/tmp/frida-server >/dev/null 2>&1 || { fail "frida: push of $bin failed"; return 1; }
  adbs shell chmod 755 /data/local/tmp/frida-server >/dev/null 2>&1
  [ "$(frida_server_version)" = "$FRIDA_VERSION" ]
}

start_frida_server() {
  # the '&' is inside the device shell; the host side must not background anything
  adbs shell "nohup /data/local/tmp/frida-server -D >/data/local/tmp/fs.log 2>&1 &" >/dev/null 2>&1
}

restart_frida_server() {
  local pid i
  pid=$(adbs shell pidof frida-server 2>/dev/null | tr -d '\r\n ')
  [ -n "$pid" ] && adbs shell kill -9 "$pid" >/dev/null 2>&1
  sleep 1
  start_frida_server
  for i in $(seq 1 10); do
    sleep 1
    frida_ps_ok && return 0
  done
  return 1
}

# ------------------------------------------------------------ steps

step_sdk() {
  local pkg="system-images;android-33;google_apis;arm64-v8a" sm img
  img="$ANDROID_HOME/system-images/android-33/google_apis/arm64-v8a"
  if [ -x "$EMU_BIN" ] && [ -d "$img" ]; then
    ok "sdk: emulator + $pkg installed"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "sdk: emulator or $pkg missing under $ANDROID_HOME"
    return 1
  fi
  sm="$(sdkmanager_path)" || { fail "sdk: sdkmanager not found under $ANDROID_HOME (install cmdline-tools)"; return 1; }
  yes 2>/dev/null | "$sm" "emulator" "$pkg" >/dev/null 2>&1
  if [ -x "$EMU_BIN" ] && [ -d "$img" ]; then
    fixed "sdk: installed emulator + $pkg"
  else
    fail "sdk: sdkmanager did not install them — run by hand: sdkmanager \"emulator\" \"$pkg\""
  fi
}

sdkmanager_path() {
  local c
  for c in "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
           "$ANDROID_HOME/cmdline-tools/bin/sdkmanager" \
           "$ANDROID_HOME/tools/bin/sdkmanager"; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

avdmanager_path() {
  local c
  for c in "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" \
           "$ANDROID_HOME/cmdline-tools/bin/avdmanager" \
           "$ANDROID_HOME/tools/bin/avdmanager"; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

# replace key=value in an .ini file, appending it when absent
ini_set() {
  local file="$1" key="$2" val="$3" tmp
  tmp="$file.emu_up.$$"
  awk -v k="$key" -v v="$val" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp" && mv "$tmp" "$file"
}

step_avd() {
  local cfg="$HOME/.android/avd/$AVD.avd/config.ini" am kv key val mism=""
  if [ -f "$cfg" ]; then
    ok "avd: $AVD exists"
  else
    if [ "$CHECK_ONLY" -eq 1 ]; then
      fail "avd: $AVD is missing — run: bash frida/emu_up.sh provision"
      return 1
    fi
    am="$(avdmanager_path)" || { fail "avd: avdmanager not found under $ANDROID_HOME"; return 1; }
    echo no | "$am" create avd -n "$AVD" -k "system-images;android-33;google_apis;arm64-v8a" -d pixel_6 >/dev/null 2>&1
    if [ -f "$cfg" ]; then
      fixed "avd: created $AVD (device profile pixel_6)"
    else
      fail "avd: avdmanager could not create $AVD"
      return 1
    fi
  fi

  for kv in "hw.ramSize=4096" "disk.dataPartition.size=16G" "hw.gpu.enabled=yes" "hw.gpu.mode=host" "hw.keyboard=yes"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    grep -qx "$key=$val" "$cfg" 2>/dev/null || mism="$mism $key"
  done
  if [ -z "$mism" ]; then
    ok "avd: config.ini has the runbook values"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "avd: config.ini missing runbook values:$mism"
    return 1
  fi
  for kv in "hw.ramSize=4096" "disk.dataPartition.size=16G" "hw.gpu.enabled=yes" "hw.gpu.mode=host" "hw.keyboard=yes"; do
    ini_set "$cfg" "${kv%%=*}" "${kv#*=}"
  done
  fixed "avd: set config.ini values:$mism"
}

# step 1 of the daily flow: emulator running on $SERIAL with a writable system
step_emulator() {
  local started=0 state
  state=$(adb_state)
  if [ "$state" = device ] && [ "$(boot_completed)" = 1 ]; then
    ok "emulator: $SERIAL is booted"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ -n "$state" ]; then
      fail "emulator: $SERIAL is '$state' — wait for the boot, or restart: bash frida/emu_up.sh kill && bash frida/emu_up.sh private"
    else
      fail "emulator: $SERIAL is not running — start it with: bash frida/emu_up.sh private"
    fi
    return 1
  fi
  if [ ! -x "$EMU_BIN" ]; then
    fail "emulator: $EMU_BIN is missing — run: bash frida/emu_up.sh provision"
    return 1
  fi
  if [ -z "$state" ] && ! job_running "$LABEL_EMU"; then
    launch_job "$LABEL_EMU" /usr/bin/env "ANDROID_HOME=$ANDROID_HOME" \
      "$EMU_BIN" -avd "$AVD" -port "$PORT" -no-boot-anim -writable-system
    started=1
  fi
  if ! boot_wait; then
    fail "emulator: did not finish booting in 180s — check: tools/emulator/$LABEL_EMU.log (then bash frida/emu_up.sh kill and rerun)"
    return 1
  fi
  if [ "$started" -eq 1 ]; then
    fixed "emulator: started $SERIAL (-avd $AVD -port $PORT -writable-system)"
  else
    ok "emulator: $SERIAL finished booting"
  fi
}

step_root_remount() {
  if ! ensure_root; then
    fail "root: 'adb root' did not give uid=0 — is this the google_apis image (not playstore)?"
    return 1
  fi
  ok "root: adbd is running as root (no Magisk needed)"

  # only provision writes /system; the CA persists in the overlay across boots
  [ "$MODE" = provision ] || return 0

  if system_writable; then
    ok "system: /system is writable (overlay mounted)"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "system: /system is read-only — run: bash frida/emu_up.sh private"
    return 1
  fi

  adbs remount >/dev/null 2>&1
  if system_writable; then
    fixed "system: remounted /system read-write"
    return 0
  fi

  if [ "$MODE" = provision ]; then
    warn "system: remount failed — disabling dm-verity and rebooting once"
    adbs shell avbctl disable-verification >/dev/null 2>&1 || warn "system: avbctl disable-verification failed (continuing)"
    adbs reboot >/dev/null 2>&1
    sleep 3
    if wait_device && boot_wait && ensure_root; then
      adbs remount >/dev/null 2>&1
      if system_writable; then
        fixed "system: remounted /system read-write after the verity reboot"
        return 0
      fi
    fi
  fi

  fail "system: /system is still read-only — restart the emulator writable: bash frida/emu_up.sh kill && bash frida/emu_up.sh private"
  return 1
}

ca_hash() {
  [ -n "${CA_PEM:-}" ] || return 1
  [ -f "${CA_PEM:-}" ] || return 1
  openssl x509 -subject_hash_old -noout -in "$CA_PEM" 2>/dev/null | tr -d '\r\n'
}

# provisioning step 5: install the dev CA into the system store
step_ca() {
  local hash target
  if [ -z "${CA_PEM:-}" ]; then
    warn "CA: CA_PEM is not set — skipping (export CA_PEM=/path/to/ca.pem and rerun)"
    return 0
  fi
  if [ ! -f "$CA_PEM" ]; then
    fail "CA: CA_PEM=$CA_PEM does not exist"
    return 1
  fi
  hash="$(ca_hash)" || hash=""
  if [ -z "$hash" ]; then
    fail "CA: could not compute 'openssl x509 -subject_hash_old' for $CA_PEM"
    return 1
  fi
  target="$SYS_CA_DIR/$hash.0"
  if adbs shell test -f "$target" >/dev/null 2>&1; then
    ok "CA: $hash.0 already in the system store"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "CA: $hash.0 missing from the system store — run: CA_PEM=$CA_PEM bash frida/emu_up.sh provision"
    return 1
  fi
  if ! system_writable; then
    fail "CA: /system is read-only — rerun provision to root/remount first"
    return 1
  fi
  adbs push "$CA_PEM" /data/local/tmp/emu_up_ca.pem >/dev/null 2>&1 || { fail "CA: push of $CA_PEM failed"; return 1; }
  adbs shell "cp /data/local/tmp/emu_up_ca.pem $target && chmod 644 $target && rm -f /data/local/tmp/emu_up_ca.pem" >/dev/null 2>&1
  if ! adbs shell test -f "$target" >/dev/null 2>&1; then
    fail "CA: copy to $target failed (is /system still writable?)"
    return 1
  fi
  fixed "CA: installed $hash.0 into $SYS_CA_DIR"
  fixed "CA: rebooting once so the new trust anchor is loaded"
  adbs reboot >/dev/null 2>&1
  sleep 3
  if wait_device && boot_wait; then
    ok "CA: device is back after the CA reboot"
  else
    fail "CA: device did not come back after the CA reboot"
  fi
}

# daily check: the dev CA is still in the system store
step_ca_check() {
  local hash target
  if [ -z "${CA_PEM:-}" ]; then
    warn "CA: CA_PEM is not set — cannot verify the dev CA hash (export CA_PEM=/path/to/ca.pem)"
    return 0
  fi
  hash="$(ca_hash)" || hash=""
  if [ -z "$hash" ]; then
    fail "CA: could not compute 'openssl x509 -subject_hash_old' for $CA_PEM"
    return 1
  fi
  target="$SYS_CA_DIR/$hash.0"
  if adbs shell test -f "$target" >/dev/null 2>&1; then
    ok "CA: $hash.0 present in $SYS_CA_DIR"
  else
    fail "CA: $hash.0 missing — run: CA_PEM=$CA_PEM bash frida/emu_up.sh provision"
  fi
}

step_game_install() {
  local base="$REPO/phase3d/apk/base.apk" split="$REPO/phase3d/apk/split_config.arm64_v8a.apk"
  if adbs shell pm path "$PKG" 2>/dev/null | tr -d '\r' | grep -q '^package:'; then
    ok "game: $PKG installed"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "game: $PKG is not installed — run: bash frida/emu_up.sh provision"
    return 1
  fi
  if [ ! -f "$base" ] || [ ! -f "$split" ]; then
    fail "game: APKs missing ($base / $split) — check git lfs pull"
    return 1
  fi
  if adbs install-multiple "$base" "$split" >/dev/null 2>&1; then
    fixed "game: installed $PKG"
  else
    fail "game: install-multiple failed — run by hand: adbs install-multiple $base $split"
  fi
}

# provisioning step 7: host venv + device binary
step_frida_install() {
  local have devver
  have="$(host_frida_version)"
  if [ "$have" = "$FRIDA_VERSION" ]; then
    ok "frida: host $FRIDA_VERSION in .venv-frida"
  elif [ "$CHECK_ONLY" -eq 1 ]; then
    fail "frida: host version '${have:-none}' != $FRIDA_VERSION — run: bash frida/emu_up.sh provision"
    return 1
  else
    if [ ! -x "$FRIDA_BIN/python" ]; then
      python3 -m venv "$REPO/.venv-frida" >/dev/null 2>&1 || { fail "frida: could not create $REPO/.venv-frida"; return 1; }
    fi
    # frida-tools has its own version series; pinning frida is what matters
    "$FRIDA_BIN/pip" install -q "frida==$FRIDA_VERSION" frida-tools >/dev/null 2>&1
    have="$(host_frida_version)"
    if [ "$have" = "$FRIDA_VERSION" ]; then
      fixed "frida: installed frida $FRIDA_VERSION into .venv-frida"
    else
      fail "frida: pip install did not produce $FRIDA_VERSION (got '${have:-none}')"
      return 1
    fi
  fi

  devver="$(frida_server_version)"
  if [ "$devver" = "$FRIDA_VERSION" ] && adbs shell test -x /data/local/tmp/frida-server >/dev/null 2>&1; then
    ok "frida-server: $FRIDA_VERSION on the device"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "frida-server: device version '${devver:-none}' != $FRIDA_VERSION — run: bash frida/emu_up.sh provision"
    return 1
  fi
  if push_frida_server; then
    fixed "frida-server: pushed $FRIDA_VERSION to /data/local/tmp/frida-server"
  else
    fail "frida-server: could not install $FRIDA_VERSION (see the [FAIL] above)"
  fi
}

# daily check 3: frida-server running and matching the host version
step_frida_server() {
  local pid devver hostver
  hostver="$(host_frida_version)"
  pid=$(adbs shell pidof frida-server 2>/dev/null | tr -d '\r\n ')
  devver="$(frida_server_version)"

  if [ -n "$pid" ] && [ "$devver" = "$hostver" ] && [ -n "$hostver" ] && frida_ps_ok; then
    ok "frida-server: running (pid $pid), version $devver matches host"
    return 0
  fi

  if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ -z "$hostver" ]; then
      fail "frida-server: host frida missing in .venv-frida — run: bash frida/emu_up.sh provision"
    elif [ -z "$pid" ]; then
      fail "frida-server: not running — run: bash frida/emu_up.sh private"
    elif [ "$devver" != "$hostver" ]; then
      fail "frida-server: device $devver != host $hostver — run: bash frida/emu_up.sh provision"
    else
      fail "frida-server: pid $pid but frida-ps does not respond — run: bash frida/emu_up.sh private"
    fi
    return 1
  fi

  if [ -z "$hostver" ]; then
    fail "frida-server: host frida missing in .venv-frida — run: bash frida/emu_up.sh provision"
    return 1
  fi
  ensure_root >/dev/null 2>&1 || warn "frida-server: adb root not available, continuing anyway"
  if [ "$devver" != "$hostver" ] || [ -z "$devver" ]; then
    warn "frida-server: device version '${devver:-none}' != host $hostver — pushing the matching binary"
    push_frida_server || { fail "frida-server: could not push $hostver"; return 1; }
  fi
  if restart_frida_server; then
    fixed "frida-server: restarted (pid $(adbs shell pidof frida-server 2>/dev/null | tr -d '\r\n '), version $hostver)"
  else
    fail "frida-server: still not reachable — see: adbs shell cat /data/local/tmp/fs.log"
  fi
}

reverse_specs() {
  adbs reverse --list 2>/dev/null | tr -d '\r' | awk 'NF >= 2 {print $(NF-1), $NF}' | sort
}

join_specs() { awk 'BEGIN {sep=""} {printf "%s%s", sep, $0; sep=", "}'; }

step_reverse() {
  local want current
  want=$(printf '%s\n' 'tcp:443 tcp:8443' 'tcp:8443 tcp:8443' | sort)
  current=$(reverse_specs)
  if [ "$current" = "$want" ]; then
    ok "adb reverse: $(printf '%s\n' "$current" | join_specs)"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "adb reverse: expected '$(printf '%s\n' "$want" | join_specs)' but found '$(printf '%s\n' "$current" | join_specs)' — run: bash frida/emu_up.sh private"
    return 1
  fi
  adbs reverse --remove-all >/dev/null 2>&1
  adbs reverse tcp:443 tcp:8443 >/dev/null 2>&1
  adbs reverse tcp:8443 tcp:8443 >/dev/null 2>&1
  sleep 1
  current=$(reverse_specs)
  if [ "$current" = "$want" ]; then
    fixed "adb reverse: set $(printf '%s\n' "$want" | join_specs)"
  else
    fail "adb reverse: wanted '$(printf '%s\n' "$want" | join_specs)' but got '$(printf '%s\n' "$current" | join_specs)'"
  fi
}

# daily check 5: the host private server must already be running
step_listener() {
  local out
  out=$(lsof -nP -iTCP:8443 -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {print $1 "(pid " $2 ")"; exit}')
  if [ -n "$out" ]; then
    ok "server: host :8443 is listening ($out)"
  else
    fail "server: nothing is listening on host :8443 — start the private server (fastify-api) yourself; emu_up.sh does not start it"
  fi
}

# daily check 6: force-stop, launch, attach e2e_hooks.js, wait for the marker
# e2e_hooks.js polls for this file to turn on the blind verifier. The emulator
# has no /tmp (read-only rootfs), so the flag lives in the app's own files dir.
BLIND_FLAG="/data/data/$PKG/files/a4e2e_blind"
step_blind_flag() {
  if adbs shell "ls $BLIND_FLAG" >/dev/null 2>&1; then
    ok "blind flag: $BLIND_FLAG exists"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "blind flag: $BLIND_FLAG is missing — run: bash frida/emu_up.sh private"
    return 1
  fi
  local uid
  uid="$(adbs shell "stat -c %u /data/data/$PKG" 2>/dev/null | tr -d '\r\n')"
  adbs shell "mkdir -p /data/data/$PKG/files && touch $BLIND_FLAG && chown -R $uid:$uid /data/data/$PKG/files && restorecon -R /data/data/$PKG/files" >/dev/null 2>&1
  if adbs shell "ls $BLIND_FLAG" >/dev/null 2>&1; then
    fixed "blind flag: created $BLIND_FLAG"
  else
    fail "blind flag: could not create $BLIND_FLAG"
    return 1
  fi
}

step_game_attach() {
  local log="$SESSION_DIR/capture_e2e.log" pid i
  mkdir -p "$SESSION_DIR" 2>/dev/null || {
    SESSION_DIR="/tmp/emu_up_$(date +%F)"
    mkdir -p "$SESSION_DIR"
    log="$SESSION_DIR/capture_e2e.log"
  }

  if [ "$CHECK_ONLY" -eq 1 ]; then
    pid=$(adbs shell pidof "$PKG" 2>/dev/null | tr -d '\r\n ')
    if [ -n "$pid" ]; then ok "game: running (pid $pid)"; else warn "game: not running"; fi
    if job_running "$LABEL_FRIDA"; then ok "frida session: $LABEL_FRIDA is loaded"; else warn "frida session: $LABEL_FRIDA is not loaded"; fi
    if [ -f "$log" ] && grep -q 'e2e_hooks loaded' "$log" 2>/dev/null; then
      ok "frida session: 'e2e_hooks loaded' in $log"
    else
      warn "frida session: no 'e2e_hooks loaded' in $log"
    fi
    return 0
  fi

  stop_game || warn "game: force-stop did not settle, launching anyway"
  adbs shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  pid=""
  for i in $(seq 1 20); do
    pid=$(adbs shell pidof "$PKG" 2>/dev/null | tr -d '\r\n ')
    [ -n "$pid" ] && break
    sleep 1
  done
  if [ -z "$pid" ]; then
    fail "game: did not start within 20s — see: adbs logcat -d | grep -i -E 'qualiarts|unity|il2cpp' | tail -50"
    return 1
  fi
  ok "game: running (pid $pid)"

  rm -f "$log"
  # PID is handed over so attach_e2e.sh does not need adb on that minimal PATH
  launch_job "$LABEL_FRIDA" /usr/bin/env "ANDROID_SERIAL=$SERIAL" "PATH=$FRIDA_BIN:/usr/bin:/bin" "PID=$pid" \
    bash "$REPO/frida/attach_e2e.sh" "$SESSION_DIR"

  for i in $(seq 1 30); do
    if grep -q 'e2e_hooks loaded' "$log" 2>/dev/null; then
      fixed "frida: e2e_hooks loaded (pid $pid, log $log)"
      return 0
    fi
    sleep 1
  done
  fail "frida: 'e2e_hooks loaded' not seen in 30s — last log lines:"
  tail -n 15 "$log" 2>/dev/null | sed 's/^/    /'
  return 1
}

# ------------------------------------------------------------ modes

run_provision() {
  echo "emu_up.sh mode=provision serial=$SERIAL"
  echo "session dir: $SESSION_DIR"
  echo
  step_sdk
  step_avd
  if step_emulator; then
    step_root_remount
    step_ca
    step_game_install
    step_frida_install
  fi
  echo
  echo "Manual (runbook step 8): launch the game once so the asset cache is warm, then:"
  echo "  $ADB -s $SERIAL emu avd snapshot save $SNAPSHOT"
  finish
}

run_private() {
  echo "emu_up.sh mode=$MODE serial=$SERIAL"
  [ "$CHECK_ONLY" -eq 0 ] && echo "session dir: $SESSION_DIR"
  echo

  step_emulator || finish 2
  step_root_remount
  step_ca_check
  step_frida_server
  step_reverse
  step_listener
  step_blind_flag
  step_game_attach

  if [ "$CHECK_ONLY" -eq 1 ]; then
    run_status_extra
  else
    echo
    echo "Session log: $SESSION_DIR/"
    if [ "$N_FAIL" -eq 0 ]; then
      echo "Next: when the screen shows TAP TO START:"
      echo "  ANDROID_SERIAL=$SERIAL $REPO/.venv-frida/bin/python frida/ocr_tap.py --tap 'TAP' --wait 60"
    fi
  fi
  finish
}

run_status_extra() {
  local l spec
  echo
  echo "Jobs:"
  for l in "$LABEL_EMU" "$LABEL_FRIDA"; do
    if job_running "$l"; then printf '  %-16s loaded\n' "$l"; else printf '  %-16s not loaded\n' "$l"; fi
  done
  printf 'host frida (.venv-frida): %s\n' "$(host_frida_version)"
  printf 'frida-server (device):    %s\n' "$(frida_server_version)"
  spec=$(reverse_specs | join_specs)
  printf 'adb reverse:              %s\n' "${spec:-none}"
  printf 'host :8443 listeners:     %s\n' "$(lsof -nP -iTCP:8443 -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {printf "%s(pid %s) ", $1, $2}')"
}

run_reset() {
  echo "emu_up.sh mode=reset serial=$SERIAL"
  echo
  if [ "$(adb_state)" != device ]; then
    fail "emulator: $SERIAL is not running — start it first: bash frida/emu_up.sh private"
    finish 2
  fi
  ok "emulator: $SERIAL is running"

  if adbs emu avd snapshot load "$SNAPSHOT" >/dev/null 2>&1; then
    fixed "snapshot: loaded '$SNAPSHOT'"
  else
    fail "snapshot: could not load '$SNAPSHOT' — list them with: adbs emu avd snapshot list"
    echo
    echo "Left alone: frida jobs, adb reverse, host server."
    finish
  fi

  sleep 3
  if wait_device && boot_wait; then
    fixed "emulator: booted from '$SNAPSHOT'"
  else
    fail "emulator: did not finish booting after the snapshot load"
  fi
  echo
  echo "Left alone: frida jobs, adb reverse, host server."
  finish
}

stop_frida_job() {
  if job_running "$LABEL_FRIDA"; then
    stop_job "$LABEL_FRIDA"
    fixed "frida: removed $LABEL_FRIDA"
  else
    ok "frida: $LABEL_FRIDA is not loaded"
  fi
}

run_down() {
  echo "emu_up.sh mode=down serial=$SERIAL"
  echo
  stop_frida_job
  if [ "$(adb_state)" = device ]; then
    if stop_game; then
      fixed "game: force-stopped"
    else
      fail "game: force-stop did not take effect"
    fi
  else
    warn "emulator: $SERIAL is not attached — nothing to force-stop"
  fi
  echo
  echo "Left alone: emulator, frida-server, adb reverse, host server."
}

run_kill() {
  echo "emu_up.sh mode=kill serial=$SERIAL"
  echo
  stop_frida_job
  if [ "$(adb_state)" = device ]; then
    adbs shell am force-stop "$PKG" >/dev/null 2>&1
    fixed "game: force-stopped"
    adbs emu kill >/dev/null 2>&1
    local i
    for i in $(seq 1 20); do
      [ "$(adb_state)" != device ] && break
      sleep 1
    done
    if [ "$(adb_state)" != device ]; then
      fixed "emulator: shut down"
    else
      fail "emulator: still attached 20s after 'adb emu kill'"
    fi
  else
    ok "emulator: $SERIAL already stopped"
  fi
  if job_running "$LABEL_EMU"; then
    stop_job "$LABEL_EMU"
    fixed "emulator: removed job $LABEL_EMU"
  else
    ok "emulator: job $LABEL_EMU is not loaded"
  fi
}

main() {
  case "$MODE" in
    reset) run_reset ;;
    down)  run_down; finish ;;
    kill)  run_kill; finish ;;
    provision) run_provision ;;
    *) run_private ;;
  esac
}

main
