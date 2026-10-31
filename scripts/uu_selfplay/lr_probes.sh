#!/bin/zsh
# Iteration-2 learning-rate probes on the eval host, driven from the driver once the ft1 eval queue releases the GPU:
#   nohup remrun observe --label 'uu lr probes' -- zsh scripts/uu_selfplay/lr_probes.sh PREFIX >> tmp/uu-eval-runs/lr-probes-PREFIX.log 2>&1 &
# Runs are named PREFIX_<arm> for every arm in config/uu-iter2-mix.yaml `arms` (v1 2026-10-22 = uu_iter2: v1 piles, no
# metrics). Waits for scripts/uu_eval/queue_dev.sh to exit (a pre-registered cohort allows no other GPU work), then checks
# that the eval host's synced mix YAML, finetune.sh and train_metrics.py hash-match this checkout (finetune.sh copies whatever YAML
# the host holds), then runs the arms one at a time: the first run writes index.csv into each data dir, so arms never start
# together. Before each arm it waits for the host to be idle (no <hostname>-heavy job, no GPU compute apps, 3 checks 5 min apart), as
# queue_dev.sh does, because the host's production work has priority. Each arm is 2 epochs x 1,000 updates with a checkpoint per
# epoch, a 3 h deadline and METRICS=offline (training metrics in RUN/logs/NAME-metrics.jsonl), run under remrun observe on
# the host so it registers. Host and project come from the eval runtime (config/local/uu-eval-runtime.json).
set -u
cd "$(dirname "$0")/../.."
PREFIX=${1:?usage: lr_probes.sh RUN_NAME_PREFIX}
[[ "$PREFIX" =~ '^[A-Za-z0-9_-]+$' ]] || { echo "bad prefix: $PREFIX"; exit 1; }
MIX=config/uu-iter2-mix.yaml
SYNCED=(scripts/uu_selfplay/finetune.sh scripts/uu_selfplay/train_metrics.py $MIX)
ARMS=($(awk '/^arms:/{f=1; next} f && /^[^ #]/{f=0} f && /^  [A-Za-z0-9]/{sub(/:.*/, ""); sub(/^ +/, ""); print}' $MIX))
[ ${#ARMS} -gt 0 ] || { echo "no arms in $MIX"; exit 1; }
H=$(python3 -c "import json; print(json.load(open('config/local/uu-eval-runtime.json'))['host'])")
P=$(python3 -c "import json; print(json.load(open('config/local/uu-eval-runtime.json'))['project'])")
RUN=$P/tmp/uu-selfplay-20261020
on_eval() { ssh -T -o BatchMode=yes -o ProxyJump=none -o ConnectTimeout=10 -o ServerAliveInterval=30 "$H" "$@"; }
idle() {
  on_eval '"$(hostname -s)-heavy" status | python3 -c "import json,sys; sys.exit(json.load(sys.stdin).get(\"current\") is not None)" && [ -z "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader)" ]' 2>/dev/null
}
wait_idle() { local n=0; while [ $n -lt 3 ]; do if idle; then n=$((n+1)); else n=0; fi; [ $n -lt 3 ] && sleep 300; done; }
echo "$(date -u +%FT%TZ) prefix $PREFIX arms ${ARMS[*]}"
while pgrep -f "uu_eval/queue_dev.sh" >/dev/null; do sleep 300; done
echo "$(date -u +%FT%TZ) eval queue ended: $(tail -1 tmp/uu-eval-runs/queue-dev.log)"
here=$(shasum -a 256 $SYNCED | awk '{print $1}')
there=$(on_eval "cd $P && sha256sum ${SYNCED[*]}" | awk '{print $1}')
[ "$here" = "$there" ] || { echo "$(date -u +%FT%TZ) eval-host copies of ${SYNCED[*]} differ from this checkout; not starting"; exit 1; }
for arm in $ARMS; do
  name=${PREFIX}_$arm
  if on_eval "[ -e $RUN/logs/$name.done ]"; then echo "$(date -u +%FT%TZ) $name already done"; continue; fi
  echo "$(date -u +%FT%TZ) $name waiting for eval host idle"
  wait_idle
  echo "$(date -u +%FT%TZ) $name start"
  # The synced remrun launcher has no exec bit on the eval host, so call it through bash.
  on_eval "cd $P && bash $P/../../remrun/bin/remrun observe --label 'uu $arm' -- bash scripts/uu_selfplay/finetune.sh $RUN $name $MIX 2 1000 1 10800 $arm offline"
  rc=$?
  # finetune.sh exits 0 whatever the trainer did; the run_bounded lifecycle carries the trainer's outcome.
  echo "$(date -u +%FT%TZ) $name exited rc=$rc done=$(on_eval "cat $RUN/logs/$name.done 2>/dev/null")" \
    "trainer=$(on_eval "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d[\"reason\"], d[\"returncodes\"])' $RUN/logs/$name-lifecycle.json 2>&1")" \
    "metrics_rows=$(on_eval "wc -l < $RUN/logs/$name-metrics.jsonl 2>/dev/null")"
done
echo "$(date -u +%FT%TZ) probes finished"
