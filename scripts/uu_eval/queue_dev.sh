#!/bin/zsh
# Sequential dev evaluations on the eval host that yield to its production work (other
# production jobs, such as TTS, take priority). Host from config/local/uu-eval-runtime.json. Usage (from the driver):
#   nohup zsh scripts/uu_eval/queue_dev.sh EXPORT_DIR RUN ADMISSION_GIB SWAP_TOLERANCE_MIB EPOCH:SHA256 [...] >> LOG 2>&1 &
# Before each cohort: wait until the host's `<hostname>-heavy status` has no current job and the GPU has no compute apps on 3
# consecutive checks 5 min apart. A cohort that production preempts (HEAVY_HARDSTOP) or that is HELD at admission is
# censored and re-run as a fresh cohort after the next idle window, at most 3 times per epoch; anything else stops.
set -u
cd "$(dirname "$0")/../.."  # project root, or a frozen eval snapshot of it (tmp/uu-eval-src-*)
X=$1 RUN=$2 ADM=$3 SWAP=$4; shift 4
H=$(python3 -c "import json; print(json.load(open('config/local/uu-eval-runtime.json'))['host'])")
idle() {
  ssh -T -o BatchMode=yes -o ProxyJump=none -o ConnectTimeout=10 "$H" \
    '"$(hostname -s)-heavy" status | python3 -c "import json,sys; sys.exit(json.load(sys.stdin).get(\"current\") is not None)" && [ -z "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader)" ]' 2>/dev/null
}
wait_idle() { local n=0; while [ $n -lt 3 ]; do if idle; then n=$((n+1)); else n=0; fi; [ $n -lt 3 ] && sleep 300; done; }
for spec in "$@"; do
  e=${spec%%:*} sha=${spec#*:} censored=0
  while true; do
    echo "$(date -u +%FT%TZ) e$e waiting for eval host idle"
    wait_idle
    log=tmp/uu-eval-runs/dev-$RUN-e$e-$(date -u +%Y%m%dT%H%M%SZ).log
    echo "$(date -u +%FT%TZ) e$e start, log $log"
    zsh scripts/uu_eval/run_dev.sh "$X/policy_epoch_$e.pt" "$RUN" "$e" "$sha" "$ADM" "$SWAP" > "$log" 2>&1
    rc=$?
    cohort=$(sed -n 's/^cohort //p' "$log" | head -1)
    term=$(python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print(t["status"], t.get("problem") or t.get("failure") or "")' "$cohort/terminal.json" 2>/dev/null || echo NO_TERMINAL)
    echo "$(date -u +%FT%TZ) e$e exited rc=$rc cohort=$cohort terminal=$term"
    [ $rc -eq 0 ] && [ -e "$cohort/DONE" ] && break
    case $term in
      HELD*|*HEAVY_HARDSTOP*) censored=$((censored+1)); [ $censored -lt 3 ] && continue;;
    esac
    echo "$(date -u +%FT%TZ) queue stopped at e$e"; exit 1
  done
done
echo "$(date -u +%FT%TZ) queue done"
