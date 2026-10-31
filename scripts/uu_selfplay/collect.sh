#!/bin/zsh
# Continuous UU self-play on one device: back-to-back blocks until tmp/uu-collect/STOP (all devices) or
# tmp/uu-collect/STOP-<host> exists (<host> is MODE up to its first '-'; it stops every mode of that host). Stop files
# are checked between blocks and during rests; a running block finishes first.
# Modes are device-specific and live in the gitignored config/local/collect-modes.zsh, which defines
#   collect_block_id MODE N  (prints the block id for counter N; non-zero for an unknown mode),
#   collect_block MODE BLOCK (runs one block; its exit status is the block's) and
#   collect_rest MODE        (prints the rest in seconds after a successful block; a failed block rests 600 s).
# Usage (from the project root): nohup remrun observe --label '<mode>' -- zsh scripts/uu_selfplay/collect.sh MODE \
#   >> tmp/uu-collect/MODE.log 2>&1 &
# State (block counters, logs, stop files) lives in tmp/uu-collect. Owner windows are written only in ROUTING.md
# `## Owner presence` and read through `remrun fleet presence`: no block starts inside a window on its device or within
# 90 min (the longest block) of one. A schedule remrun cannot read counts as a window, so the loop waits rather than guesses.
# Edit this file only by writing a new file and renaming it over this one: running loops keep the old inode open.
set -u
cd "${0:A:h}/../.."
dev=$1; D=tmp/uu-collect; host=${dev%%-*}
source config/local/collect-modes.zsh
until_epoch=${COLLECT_START_UNTIL_EPOCH:-}
stop_on_failure=${COLLECT_STOP_ON_FAILURE:-0}
case $stop_on_failure in 0|1) ;; *) print -u2 'COLLECT_STOP_ON_FAILURE must be 0 or 1'; exit 2;; esac
terminal_rc=0
if [[ -n $until_epoch && $until_epoch != <-> ]]; then
  print -u2 'COLLECT_START_UNTIL_EPOCH must be a nonnegative epoch second'; exit 2
fi
stopped() { [ -e $D/STOP ] || [ -e $D/STOP-$host ] ||
  { [[ -n $until_epoch ]] && (( $(date +%s) >= until_epoch )); }; }
rest() { local t=$1; while [ $t -gt 0 ] && ! stopped; do sleep 10; t=$((t - 10)); done; }
quiet() {  # an owner window on this device now or $1 minutes from now
  remrun fleet presence --device ${(U)host} --in $1 --json 2>/dev/null | python3 -c 'import json, sys
try: r = json.load(sys.stdin)
except ValueError: sys.exit(0)
sys.exit(0 if r["status"] in ("unavailable", "malformed") or any(d["window_until"] for d in r["devices"]) else 1)'; }
n=$(cat $D/$dev.counter 2>/dev/null || echo 0)
while ! stopped; do
  if quiet 0 || quiet 90; then echo "$(date -u +%FT%TZ) $dev waiting out the owner's quiet window"
    while ! stopped && { quiet 0 || quiet 90; }; do rest 300; done; continue; fi
  n=$((n+1)); echo $n > $D/$dev.counter
  b=$(collect_block_id $dev $n) || { echo "unknown mode $dev (config/local/collect-modes.zsh)"; exit 2; }
  echo "$(date -u +%FT%TZ) $dev block $b start"
  collect_block $dev $b
  rc=$?
  echo "$(date -u +%FT%TZ) $dev block $b exited rc=$rc"
  if [ $rc -ne 0 ] && [ $stop_on_failure = 1 ]; then
    echo "$(date -u +%FT%TZ) $dev failed block retained; loop stopping"
    terminal_rc=$rc; break
  fi
  if [ $rc -ne 0 ]; then rest 600; else rest $(collect_rest $dev); fi
done
echo "$(date -u +%FT%TZ) $dev stopped (stop file, deadline or failure)"
exit $terminal_rc
