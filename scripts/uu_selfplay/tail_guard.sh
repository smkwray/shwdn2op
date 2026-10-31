#!/bin/bash
# Stop a block's last serve_model once it has had no possible opponent for 60 s.
# Matches only the venv python's own argv (never this script or its awk), arms after seeing
# >=2 workers, re-verifies the target and requires pgid == pid (run_bounded session) before killing.
source "$1/env.sh"; cfg="$2"; py="$PY"; alone=0; seen=0; start=$(date +%s)
workers() { ps -eo pid=,args= | awk -v py="$py" -v c="--config $cfg" '$2 == py && $3 == "-m" && $4 == "metamon.rl.evaluate.ladder_self_play.serve_model" && index($0, c) {print $1}'; }
while true; do
  pids=$(workers); n=$(printf '%s\n' "$pids" | grep -c .)
  [ "$n" -ge 2 ] && seen=1
  if [ "$n" -eq 0 ]; then
    [ "$seen" -eq 1 ] && { echo "$(date -u +%FT%TZ) all workers exited"; exit 0; }
    [ $(( $(date +%s) - start )) -gt 600 ] && { echo "no workers seen in 600 s"; exit 1; }
  fi
  if [ "$seen" -eq 1 ] && [ "$n" -eq 1 ]; then alone=$((alone+1)); else alone=0; fi
  if [ "$alone" -ge 2 ]; then
    pg=$(ps -o pgid= -p "$pids" | tr -d ' ')
    if [ -n "$pg" ] && [ "$pg" = "$pids" ] && [ "$(workers)" = "$pids" ]; then
      echo "$(date -u +%FT%TZ) stopping lone worker pid $pids (own session)"; kill -TERM -- "-$pg"; exit 0
    fi
    echo "$(date -u +%FT%TZ) refused: pid $pids pgid '$pg' failed verification"; alone=0
  fi
  sleep 30
done
