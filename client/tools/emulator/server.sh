#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=8443
SESSION=idoly.server
LOG="$REPO/tools/emulator/idoly.server.log"
API="$REPO/fastify-api"

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") [stop|start|restart|status|logs [N]]
  stop      stop the dev server (screen session + listener on port $PORT)
  start     start the dev server in screen session '$SESSION'
  restart   stop then start
  status    report listener/pid/start time and checkout state
  logs [N]  tail the last N lines of $LOG (default 60)
EOF
}

listener_pids() {
  lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

current_branch() {
  git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown"
}

current_commit() {
  git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

stop_server() {
  screen -S "$SESSION" -X quit 2>/dev/null || true

  pids="$(listener_pids)"
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true

    i=0
    while [ "$i" -lt 20 ]; do
      [ -z "$(listener_pids)" ] && break
      sleep 0.5
      i=$((i + 1))
    done

    pids="$(listener_pids)"
    if [ -n "$pids" ]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi

  echo "stopped"
}

start_server() {
  pids="$(listener_pids)"
  if [ -n "$pids" ]; then
    echo "already running (pid $(echo "$pids" | sed -n '1p'))"
    exit 1
  fi

  profile="${SUMIRE_PROFILE:-sandbox}"
  branch="$(current_branch)"
  commit="$(current_commit)"

  printf '=== server.sh start %s branch=%s commit=%s ===\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$branch" "$commit" >>"$LOG"

  (
    cd "$API" &&
      screen -dmS "$SESSION" /bin/bash -c "SUMIRE_PROFILE=$profile PORT=$PORT TLS=1 HTTP2=1 DEBUG_RPC=1 exec node src/server.ts >>../tools/emulator/idoly.server.log 2>&1"
  )

  i=0
  while [ "$i" -lt 60 ]; do
    if [ -n "$(listener_pids)" ]; then
      echo "started pid=$(listener_pids | sed -n '1p') branch=$branch commit=$commit"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done

  echo "failed to start; last log lines:"
  tail -n 40 "$LOG" || true
  exit 1
}

status_server() {
  pids="$(listener_pids)"
  pid="$(echo "$pids" | sed -n '1p')"
  if [ -z "$pid" ]; then
    echo "not running"
    exit 3
  fi

  lstart="$(ps -o lstart= -p "$pid")"
  lstart="$(echo "$lstart" | tr -s ' ' | sed 's/^ //; s/ $//')"
  start_epoch="$(/bin/date -j -f "%a %b %d %T %Y" "$lstart" +%s 2>/dev/null || true)"
  branch="$(current_branch)"
  commit="$(current_commit)"

  echo "running pid=$pid since=$lstart"
  echo "branch=$branch commit=$commit"

  head_epoch="$(git -C "$REPO" log -1 --format=%ct 2>/dev/null || true)"
  if [ -n "$start_epoch" ] && [ -n "$head_epoch" ] && [ "$head_epoch" -gt "$start_epoch" ]; then
    echo "WARNING: HEAD is newer than the running server; restart needed"
  fi
}

case "${1:-status}" in
  stop)
    stop_server
    ;;
  start)
    start_server
    ;;
  restart)
    stop_server
    start_server
    ;;
  status)
    status_server
    ;;
  logs)
    tail -n "${2:-60}" "$LOG"
    ;;
  *)
    usage
    exit 2
    ;;
esac
