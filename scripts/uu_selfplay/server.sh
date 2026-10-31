#!/bin/bash
# Owned loopback Showdown server for a run dir: server.sh RUN start|stop|status. Stop kills only its own group.
set -euo pipefail
source "$1/env.sh"; PS=$R/ps/node_modules/pokemon-showdown; PID=$R/ps-server.pid
listening() { (ss -ltn 2>/dev/null || netstat -an -p tcp 2>/dev/null) | grep -qE '127\.0\.0\.1[:.]8000 '; }
case "${2:-status}" in
  start)
    if listening; then echo "port 8000 already in use"; exit 1; fi
    cd "$PS"; setsid node pokemon-showdown start --skip-build --no-security > "$R/logs/ps-server-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 < /dev/null &
    echo $! > "$PID"
    for i in $(seq 1 90); do listening && { echo "server up pid $(cat "$PID")"; exit 0; }; sleep 1; done
    echo "server failed to listen"; exit 1 ;;
  stop)
    [ -f "$PID" ] || { echo "no pid file"; exit 0; }
    p=$(cat "$PID"); kill -TERM -- "-$p" 2>/dev/null || true
    for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$p" 2>/dev/null || true; rm -f "$PID"
    if listening; then echo "port 8000 still listening"; exit 1; else echo "server stopped"; fi ;;
  status) if listening; then echo listening; else echo "not listening"; fi ;;
esac
