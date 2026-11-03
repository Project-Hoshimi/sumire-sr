#!/usr/bin/env bash
# device_up.sh — one idempotent entry point for the IDOLY PRIDE device proxy.
# Checks each piece of the USB proxy chain, fixes what is safe to fix, and
# reports every step as [OK] / [FIXED] / [WARN] / [FAIL].
#
# Usage:
#   bash frida/device_up.sh status                  # check only, change nothing (mode
#                                                   # auto-detected from adb reverse)
#   bash frida/device_up.sh private [SESSION_DIR]   # private-server mode (default)
#   bash frida/device_up.sh official [SESSION_DIR]  # official-capture mode (LIVE servers)
#   bash frida/device_up.sh down                    # stop frida/proxy units, force-stop game
#
# Exit codes: 0 = no failures, 1 = at least one [FAIL], 2 = Pixel 6 not connected.
# Official mode connects the throwaway account to the real servers: run it only
# when the user explicitly asks for it.
#
# See docs/DEVICE_RUNBOOK.md for the architecture and every known failure mode.
set -u

SERIAL="${ANDROID_SERIAL:?set ANDROID_SERIAL to your device serial}"
export ANDROID_SERIAL="$SERIAL"
PKG=game.qualiarts.idolypride
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"

UNITS_FRIDA="idoly-frida idoly-photo-frida idoly-photo-proxy"
OFFICIAL_IPS="35.221.155.103 34.120.154.49 34.102.172.238 130.211.5.37"

MODE="${1:-private}"
SESSION_DIR="${2:-}"
CHECK_ONLY=0

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

case "$MODE" in
  status)   CHECK_ONLY=1; MODE=private ;;
  private)  ;;
  official) ;;
  down)     ;;
  -h|--help|help) usage; exit 0 ;;
  *) echo "unknown mode: $MODE (use status | private | official | down)"; exit 64 ;;
esac

if [ -z "$SESSION_DIR" ]; then
  if [ "$MODE" = official ]; then
    SESSION_DIR="$REPO/captures/$(date +%F)_photo"
  else
    SESSION_DIR="$REPO/captures/$(date +%F)_e2e"
  fi
fi
# the frida units run in $REPO, so hand them an absolute path
case "$SESSION_DIR" in /*) ;; *) SESSION_DIR="$PWD/$SESSION_DIR" ;; esac

N_OK=0
N_FIXED=0
N_WARN=0
N_FAIL=0
GAME_PID=""

ok()    { N_OK=$((N_OK + 1));    printf '[OK] %s\n' "$*"; }
fixed() { N_FIXED=$((N_FIXED + 1)); printf '[FIXED] %s\n' "$*"; }
warn()  { N_WARN=$((N_WARN + 1));  printf '[WARN] %s\n' "$*"; }
fail()  { N_FAIL=$((N_FAIL + 1));  printf '[FAIL] %s\n' "$*"; }

A()  { timeout 20 adb -s "$SERIAL" "$@"; }
SU() { A shell "su -c \"$*\""; }

# Never match our own shell chain: an agent command line can contain the
# pattern text (e.g. when quoting this script in a tool call).
SELF_CHAIN=" $$ $PPID "

# Only frida CLIs that belong to this project: pinned to the Pixel 6, aimed at
# the game, or loading one of our hook scripts. Frida sessions for other
# projects or the Moto G are left alone.
stray_frida_pids() {
  ps -eo pid=,comm=,args= | awk -v skip="$SELF_CHAIN" -v serial="$SERIAL" '
    index(skip, " " $1 " ") {next}
    !($2 == "frida" || $0 ~ /[f]rida (-U|-D|-p|-f)/) {next}
    index($0, serial) || index($0, "game.qualiarts.idolypride") || index($0, "privateserver/frida/") {print $1}'
}

stray_proxy_pids() {
  ps -eo pid=,args= | awk -v skip="$SELF_CHAIN" '
    index(skip, " " $1 " ") {next}
    $0 ~ /[p]hoto_sni_proxy/ {print $1}'
}

summary() {
  echo
  echo "Summary: OK=$N_OK FIXED=$N_FIXED WARN=$N_WARN FAIL=$N_FAIL"
  if [ "$N_FAIL" -gt 0 ]; then
    echo "Exit: 1 (fix the [FAIL] lines above)"
  else
    echo "Exit: 0"
  fi
}

# ---------------------------------------------------------------- steps

step_adb() {
  timeout 10 adb start-server >/dev/null 2>&1
  local state
  state=$(timeout 10 adb devices 2>/dev/null | tr -d '\r' | awk -v s="$SERIAL" '$1 == s {print $2; exit}')
  case "${state:-}" in
    device)       ok "adb: Pixel 6 ($SERIAL) is connected" ;;
    unauthorized) fail "adb: $SERIAL is unauthorized — unlock the phone and accept the USB debugging prompt"; summary; exit 2 ;;
    "")           fail "adb: $SERIAL not attached — plug in / replug the Pixel 6 (never the Moto G or Pixel 10 XL)"; summary; exit 2 ;;
    *)            fail "adb: $SERIAL is '$state' — plug in / replug the Pixel 6"; summary; exit 2 ;;
  esac
}

step_root() {
  local out
  out=$(SU id 2>/dev/null | tr -d '\r')
  case "$out" in
    *uid=0*) ok "root: su works (do not use 'adb root')" ;;
    *)       fail "root: 'su -c id' did not return uid=0 — check Magisk"; summary; exit 2 ;;
  esac
}

step_cleanup() {
  local pids fifo acted=0 what=""

  systemctl --user stop $UNITS_FRIDA >/dev/null 2>&1
  systemctl --user reset-failed $UNITS_FRIDA >/dev/null 2>&1

  pids=$(stray_frida_pids)
  if [ -n "$pids" ]; then
    printf '%s\n' "$pids" | xargs -r kill >/dev/null 2>&1
    sleep 1
    printf '%s\n' "$pids" | xargs -r kill -9 >/dev/null 2>&1
    acted=1
    what="$what stray-frida[pids: $(echo $pids)]"
  fi

  pids=$(stray_proxy_pids)
  if [ -n "$pids" ]; then
    printf '%s\n' "$pids" | xargs -r kill >/dev/null 2>&1
    sleep 1
    printf '%s\n' "$pids" | xargs -r kill -9 >/dev/null 2>&1
    acted=1
    what="$what stray-proxy[pids: $(echo $pids)]"
  fi

  for fifo in /tmp/a4e2e_attach_fifo /tmp/photo_frida_fifo; do
    if [ -e "$fifo" ]; then
      rm -f "$fifo"
      acted=1
      what="$what $fifo"
    fi
  done

  if [ "$acted" -eq 1 ]; then
    fixed "cleared leftover host state:$what"
  else
    ok "host: no leftover frida/proxy processes or FIFOs"
  fi
}

frida_ps_ok() { timeout 15 frida-ps -D "$SERIAL" >/dev/null 2>&1; }

restart_frida_server() {
  SU kill -9 "\$(pidof frida-server)" >/dev/null 2>&1
  sleep 1
  A shell 'su -c "nohup /data/local/tmp/frida-server -D >/data/local/tmp/fs.log 2>&1 &"' >/dev/null 2>&1
  local i
  for i in $(seq 1 10); do
    sleep 1
    frida_ps_ok && return 0
  done
  return 1
}

step_frida_server() {
  local pid i
  pid=$(SU pidof frida-server 2>/dev/null | tr -d '\r\n ')

  if [ -n "$pid" ] && frida_ps_ok; then
    ok "frida-server: running (pid $pid), frida-ps responds"
  elif [ "$CHECK_ONLY" -eq 1 ]; then
    fail "frida-server: not usable (pid '${pid:-none}') — run: bash frida/device_up.sh private"
  else
    if restart_frida_server; then
      fixed "frida-server: restarted on the device"
    else
      fail "frida-server: still not reachable after restart — see: adb -s $SERIAL shell 'su -c \"cat /data/local/tmp/fs.log\"'"
    fi
  fi

  local hostver devver
  hostver=$(timeout 10 frida --version 2>/dev/null | tr -d '\r\n')
  devver=$(SU /data/local/tmp/frida-server --version 2>/dev/null | tr -d '\r\n ')
  if [ -n "$devver" ] && [ -n "$hostver" ] && [ "$devver" != "$hostver" ]; then
    warn "frida version mismatch: host $hostver, device $devver (push the matching frida-server)"
  elif [ -n "$devver" ]; then
    ok "frida-server: version $devver matches host"
  fi
}

step_device_sanity() {
  # global HTTP proxy must be unset (it is persistent across reboots)
  local p h port
  p=$(A shell settings get global http_proxy 2>/dev/null | tr -d '\r\n ')
  h=$(A shell settings get global global_http_proxy_host 2>/dev/null | tr -d '\r\n ')
  port=$(A shell settings get global global_http_proxy_port 2>/dev/null | tr -d '\r\n ')
  if [ "$p" = "null" ] || [ "$p" = ":0" ]; then
    if [ "$h" = "null" ] && [ "$port" = "null" ]; then
      ok "device: global http_proxy is unset"
    else
      warn "device: global http_proxy is '$p' but host='$h' port='$port' are set"
    fi
  elif [ "$CHECK_ONLY" -eq 1 ]; then
    fail "device: global http_proxy is '$p' — run: bash frida/device_up.sh private"
  else
    A shell settings delete global http_proxy >/dev/null 2>&1
    A shell settings delete global global_http_proxy_host >/dev/null 2>&1
    A shell settings delete global global_http_proxy_port >/dev/null 2>&1
    p=$(A shell settings get global http_proxy 2>/dev/null | tr -d '\r\n ')
    if [ "$p" = "null" ] || [ "$p" = ":0" ]; then
      fixed "device: cleared global http_proxy"
    else
      fail "device: could not clear global http_proxy (still '$p')"
    fi
  fi

  # our CA: certs shipped by the mitmproxy-cacert Magisk module, installed into
  # the conscrypt apex at boot. Report only — the module must be reinstalled.
  local modcerts missing=""
  modcerts=$(SU ls /data/adb/modules/mitmproxy-cacert/system/etc/security/cacerts/ 2>/dev/null | tr -d '\r' | tr ' ' '\n' | grep -E '\.0$')
  if [ -z "$modcerts" ]; then
    warn "device: mitmproxy-cacert module not found — reinstall it from ~/.opencode/mitmproxy-cacert/"
  else
    for c in $modcerts; do
      SU ls "/apex/com.android.conscrypt/cacerts/$c" >/dev/null 2>&1 || missing="$missing $c"
    done
    if [ -n "$missing" ]; then
      fail "device: CA missing from conscrypt apex:$missing — reinstall the mitmproxy-cacert Magisk module (report only)"
    else
      ok "device: CA installed in conscrypt apex ($(echo $modcerts))"
    fi
  fi

  # hosts module must not contain game hostnames (it caused E203 before)
  local hosts bad
  hosts=$(SU cat /data/adb/modules/hosts/system/etc/hosts 2>/dev/null | tr -d '\r')
  if [ -z "$hosts" ]; then
    warn "device: hosts module file not readable / missing (report only)"
  else
    bad=$(printf '%s\n' "$hosts" | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' | grep -v '^127\.0\.0\.1[[:space:]]\{1,\}localhost$')
    if [ -z "$bad" ]; then
      ok "device: hosts file only has 127.0.0.1 localhost"
    else
      warn "device: hosts file has extra entries (report only, can cause E203): $(printf '%s' "$bad" | tr '\n' ';')"
    fi
  fi
}

our_iptables_rules() {
  SU iptables -t nat -S OUTPUT 2>/dev/null | tr -d '\r' | grep -E '35\.221\.155\.103|34\.120\.154\.49|34\.102\.172\.238|130\.211\.5\.37'
}

step_iptables() {
  if [ "$MODE" != "official" ]; then
    local rules count
    rules=$(our_iptables_rules)
    count=$(printf '%s\n' "$rules" | grep -c 'REDIRECT' || true)
    if [ "${count:-0}" -gt 0 ]; then
      ok "iptables: $count legacy REDIRECT rule(s) present (harmless in private mode)"
    else
      ok "iptables: no REDIRECT rules"
    fi
    return
  fi

  if [ "$CHECK_ONLY" -eq 1 ]; then
    if our_iptables_rules | grep -q 'REDIRECT'; then
      warn "iptables: REDIRECT rules still present — run: bash frida/device_up.sh official"
    else
      ok "iptables: no REDIRECT rules for the official IPs"
    fi
    return
  fi

  local ip port n removed=0
  for ip in $OFFICIAL_IPS; do
    for port in 8443 9443; do
      n=0
      while [ "$n" -lt 5 ]; do
        if SU iptables -t nat -D OUTPUT -p tcp -d "$ip" --dport 443 -j REDIRECT --to-ports "$port" >/dev/null 2>&1; then
          removed=$((removed + 1))
          n=$((n + 1))
        else
          break
        fi
      done
    done
  done

  if our_iptables_rules | grep -q .; then
    fail "iptables: could not remove all REDIRECT rules: $(our_iptables_rules | tr '\n' ';')"
  elif [ "$removed" -gt 0 ]; then
    fixed "iptables: removed $removed REDIRECT rule(s)"
  else
    ok "iptables: no REDIRECT rules for the official IPs"
  fi
}

reverse_specs() {
  A reverse --list 2>/dev/null | tr -d '\r' | awk 'NF >= 2 {print $(NF-1), $NF}' | sort
}

join_specs() { awk 'BEGIN {sep=""} {printf "%s%s", sep, $0; sep=", "}'; }

step_reverse() {
  local want current
  if [ "$MODE" = "official" ]; then
    want=$'tcp:443 tcp:8444'
  else
    want=$'tcp:443 tcp:8443\ntcp:8443 tcp:8443'
  fi
  current=$(reverse_specs)
  want=$(printf '%s\n' "$want" | sort)

  if [ "$current" = "$want" ]; then
    ok "adb reverse: $(printf '%s\n' "$current" | join_specs)"
    return
  fi

  if [ "$CHECK_ONLY" -eq 1 ]; then
    warn "adb reverse: expected '$(printf '%s\n' "$want" | join_specs)' but found '$(printf '%s\n' "$current" | join_specs)'"
    return
  fi

  A reverse --remove-all >/dev/null 2>&1
  if [ "$MODE" = "official" ]; then
    A reverse tcp:443 tcp:8444 >/dev/null 2>&1
  else
    A reverse tcp:443 tcp:8443 >/dev/null 2>&1
    A reverse tcp:8443 tcp:8443 >/dev/null 2>&1
  fi
  sleep 1
  current=$(reverse_specs)
  if [ "$current" = "$want" ]; then
    fixed "adb reverse: set to '$(printf '%s\n' "$want" | join_specs)'"
  else
    fail "adb reverse: wanted '$(printf '%s\n' "$want" | join_specs)' but got '$(printf '%s\n' "$current" | join_specs)'"
  fi
}

server_health() {
  curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1:8443/ 2>/dev/null
}

start_server() {
  systemctl --user stop idoly-server >/dev/null 2>&1
  systemctl --user reset-failed idoly-server >/dev/null 2>&1
  systemd-run --user --unit=idoly-server --collect \
    -p WorkingDirectory="$REPO/fastify-api" \
    -p Environment=PORT=8443 -p Environment=TLS=1 \
    -p Environment=HTTP2=1 -p Environment=DEBUG_RPC=1 \
    /usr/bin/node src/server.ts >/dev/null 2>&1
}

step_listener() {
  if [ "$MODE" = "official" ]; then
    if ss -tln 2>/dev/null | grep -q '127\.0\.0\.1:8444 '; then
      ok "photo proxy: listening on 127.0.0.1:8444"
      return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "photo proxy: not listening on 127.0.0.1:8444"
      return
    fi
    systemctl --user stop idoly-photo-proxy >/dev/null 2>&1
    systemctl --user reset-failed idoly-photo-proxy >/dev/null 2>&1
    systemd-run --user --unit=idoly-photo-proxy --collect \
      -p WorkingDirectory="$REPO" \
      /usr/bin/python3 frida/photo_sni_proxy.py 127.0.0.1 8444 >/dev/null 2>&1
    local i
    for i in $(seq 1 10); do
      sleep 1
      if ss -tln 2>/dev/null | grep -q '127\.0\.0\.1:8444 '; then
        fixed "photo proxy: started on 127.0.0.1:8444"
        return
      fi
    done
    fail "photo proxy: did not start — see: journalctl --user -u idoly-photo-proxy"
    return
  fi

  local code
  code=$(server_health)
  if systemctl --user is-active --quiet idoly-server && [ "$code" != "000" ]; then
    ok "server: idoly-server healthy on :8443 (HTTP $code)"
    return
  fi

  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "server: idoly-server unhealthy (unit $(systemctl --user is-active idoly-server 2>/dev/null), health $code)"
    return
  fi

  if ! ss -tln 2>/dev/null | grep -q ':5432 '; then
    fail "server: Postgres is not listening on :5432 — run: sudo systemctl start postgresql"
    return
  fi
  ok "server: Postgres is listening on :5432"

  if ! systemctl --user is-active --quiet idoly-server; then
    local line pid cmd
    line=$(ss -tlnp 2>/dev/null | grep ':8443 ' | head -n1)
    if [ -n "$line" ]; then
      pid=$(printf '%s' "$line" | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2)
      cmd=""
      [ -n "$pid" ] && cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
      if [ -n "$cmd" ] && printf '%s' "$cmd" | grep -q 'src/server.ts'; then
        kill "$pid" 2>/dev/null
        sleep 1
        fixed "server: killed stale node on :8443 (pid $pid)"
      elif [ -n "$pid" ]; then
        fail "server: :8443 is held by pid $pid ($cmd) — free it and rerun"
        return
      fi
    fi
  fi

  start_server
  local i
  for i in $(seq 1 30); do
    sleep 1
    code=$(server_health)
    if [ "$code" != "000" ]; then
      fixed "server: idoly-server started (HTTP $code)"
      return
    fi
  done
  fail "server: idoly-server did not come up — last log lines:"
  journalctl --user -u idoly-server --no-pager -n 20 2>/dev/null | sed 's/^/    /'
}

step_blind_flag() {
  if [ "$MODE" = "official" ]; then
    ok "blind flag: irrelevant in official mode (left as is)"
    return
  fi
  if SU ls /tmp/a4e2e_blind >/dev/null 2>&1; then
    ok "device: blind flag /tmp/a4e2e_blind exists"
    return
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    fail "device: blind flag /tmp/a4e2e_blind is missing"
    return
  fi
  SU touch /tmp/a4e2e_blind >/dev/null 2>&1
  if SU ls /tmp/a4e2e_blind >/dev/null 2>&1; then
    fixed "device: created blind flag /tmp/a4e2e_blind"
  else
    fail "device: could not create /tmp/a4e2e_blind"
  fi
}

log_has_error() {
  # frida CLI errors only; a bare word like "cancelled" also shows up in normal hook logs
  [ -f "$1" ] && grep -qE 'unable to connect to remote frida-server|need Gadget|Failed to attach|Failed to spawn|Failed to load script' "$1"
}

private_try() {
  local i log="$SESSION_DIR/capture_e2e.log"
  stop_game
  sleep 1
  A shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  GAME_PID=""
  for i in $(seq 1 20); do
    GAME_PID=$(A shell pidof "$PKG" 2>/dev/null | tr -d '\r\n ')
    [ -n "$GAME_PID" ] && break
    sleep 1
  done
  [ -z "$GAME_PID" ] && return 1
  sleep 5

  rm -f "$log"
  systemctl --user stop idoly-frida >/dev/null 2>&1
  systemctl --user reset-failed idoly-frida >/dev/null 2>&1
  systemd-run --user --unit=idoly-frida --collect -p WorkingDirectory="$REPO" \
    -p Environment=PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    -p Environment=ANDROID_SERIAL="$SERIAL" -p Environment=PID="$GAME_PID" \
    /bin/bash frida/attach_e2e.sh "$SESSION_DIR" >/dev/null 2>&1

  for i in $(seq 1 25); do
    grep -q 'e2e_hooks loaded' "$log" 2>/dev/null && return 0
    log_has_error "$log" && return 1
    sleep 1
  done
  return 1
}

# Force-stop the game and wait until its old process is really gone, so a
# later pidof cannot pick up the dying instance.
stop_game() {
  local i
  A shell am force-stop "$PKG" >/dev/null 2>&1
  for i in $(seq 1 10); do
    [ -z "$(A shell pidof "$PKG" 2>/dev/null | tr -d '\r\n ')" ] && return 0
    sleep 1
  done
  return 1
}

official_try() {
  local i pid log="$SESSION_DIR/capture_a12.log"
  GAME_PID=""
  stop_game
  rm -f "$log"
  systemctl --user stop idoly-photo-frida >/dev/null 2>&1
  systemctl --user reset-failed idoly-photo-frida >/dev/null 2>&1
  systemd-run --user --unit=idoly-photo-frida --collect -p WorkingDirectory="$REPO" \
    -p Environment=PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    -p Environment=ANDROID_SERIAL="$SERIAL" \
    /bin/bash frida/launch_photo.sh "$SESSION_DIR" >/dev/null 2>&1

  for i in $(seq 1 30); do
    pid=$(A shell pidof "$PKG" 2>/dev/null | tr -d '\r\n ')
    if [ -n "$pid" ]; then
      GAME_PID="$pid"
      break
    fi
    log_has_error "$log" && return 1
    sleep 1
  done
  [ -z "$GAME_PID" ] && return 1
  sleep 3
  systemctl --user is-active --quiet idoly-photo-frida || return 1
  return 0
}

step_game_frida() {
  if [ "$CHECK_ONLY" -eq 1 ]; then
    GAME_PID=$(A shell pidof "$PKG" 2>/dev/null | tr -d '\r\n ')
    if [ -n "$GAME_PID" ]; then
      ok "game: running (pid $GAME_PID)"
    else
      warn "game: not running"
    fi
    if systemctl --user is-active --quiet idoly-frida; then
      ok "frida session: idoly-frida active (private)"
    fi
    if systemctl --user is-active --quiet idoly-photo-frida; then
      ok "frida session: idoly-photo-frida active (official)"
    fi
    return
  fi

  mkdir -p "$SESSION_DIR" 2>/dev/null || SESSION_DIR="/tmp/device_up_$(date +%F)"
  mkdir -p "$SESSION_DIR"

  if [ "$MODE" = "private" ]; then
    if private_try; then
      fixed "private: game restarted (pid $GAME_PID) and e2e_hooks attached"
      return
    fi
    warn "private: first attach attempt failed — restarting frida-server and retrying once"
    if restart_frida_server && private_try; then
      fixed "private: attach succeeded on retry (pid $GAME_PID)"
      return
    fi
    fail "private: e2e_hooks did not attach — last log lines:"
    tail -n 15 "$SESSION_DIR/capture_e2e.log" 2>/dev/null | sed 's/^/    /'
    return
  fi

  if official_try; then
    fixed "official: cold-spawned with combined_hooks + photo_redirect (pid $GAME_PID)"
    return
  fi
  warn "official: first launch attempt failed — restarting frida-server and retrying once"
  if restart_frida_server && official_try; then
    fixed "official: launch succeeded on retry (pid $GAME_PID)"
    return
  fi
  fail "official: capture session did not start — last log lines:"
  tail -n 15 "$SESSION_DIR/capture_a12.log" 2>/dev/null | sed 's/^/    /'
}

detected_mode() {
  local r
  r=$(reverse_specs)
  if printf '%s\n' "$r" | grep -qx 'tcp:443 tcp:8444'; then
    echo official
  elif printf '%s\n' "$r" | grep -qx 'tcp:443 tcp:8443'; then
    echo private
  else
    echo unknown
  fi
}

run_status_extra() {
  echo
  echo "Unit states:"
  local u st
  for u in idoly-server idoly-frida idoly-photo-frida idoly-photo-proxy; do
    st=$(systemctl --user is-active "$u" 2>/dev/null || true)
    printf '  %-20s %s\n' "$u" "${st:-unknown}"
  done
  printf 'Detected mode (from adb reverse): %s\n' "$(detected_mode)"
  printf 'Photo proxy on 127.0.0.1:8444: %s\n' "$(ss -tln 2>/dev/null | grep -q '127\.0\.0\.1:8444 ' && echo listening || echo down)"
}

run_down() {
  step_adb
  step_cleanup
  A shell am force-stop "$PKG" >/dev/null 2>&1
  fixed "game: force-stopped"
  A reverse --remove-all >/dev/null 2>&1
  if [ -z "$(reverse_specs)" ]; then
    fixed "adb reverse: removed all"
  else
    fail "adb reverse: still present: $(reverse_specs | tr '\n' ' ')"
  fi
  echo
  echo "Left alone: idoly-server, frida-server, device iptables."
  summary
  [ "$N_FAIL" -eq 0 ] && exit 0 || exit 1
}

main() {
  if [ "$MODE" = "down" ]; then
    run_down
  fi

  echo "device_up.sh mode=$MODE"
  [ "$CHECK_ONLY" -eq 0 ] && echo "session dir: $SESSION_DIR"
  echo

  step_adb
  step_root

  # status checks against whichever mode the device is currently set up for
  if [ "$CHECK_ONLY" -eq 1 ] && [ "$(detected_mode)" = official ]; then
    MODE=official
    echo "(adb reverse points at :8444 — checking official mode)"
  fi

  if [ "$CHECK_ONLY" -eq 0 ]; then
    step_cleanup
  fi

  step_frida_server
  step_device_sanity
  step_iptables
  step_reverse
  step_listener
  step_blind_flag
  step_game_frida

  [ "$CHECK_ONLY" -eq 1 ] && run_status_extra

  echo
  if [ "$CHECK_ONLY" -eq 0 ]; then
    echo "Session log: $SESSION_DIR/"
    if [ "$MODE" = "private" ] && [ "$N_FAIL" -eq 0 ]; then
      echo "Next: when the screen shows TAP TO START:"
      echo "  ANDROID_SERIAL=$SERIAL python3 frida/ocr_tap.py --tap 'TAP' --wait 60"
    fi
  fi
  summary
  [ "$N_FAIL" -eq 0 ] && exit 0 || exit 1
}

main
