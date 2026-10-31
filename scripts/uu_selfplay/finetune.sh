#!/bin/bash
# Fine-tune UUKakuna from epoch 34 on a frozen pile (Linux CUDA run dir from setup_run.sh):
#   finetune.sh RUN NAME PILE EPOCHS STEPS_PER_EPOCH CKPT_INTERVAL [DEADLINE_S] [ARM] [METRICS]
# PILE is a freeze_pile.py output dir relative to RUN (e.g. piles/iter1), or a mixed dataset YAML (e.g.
# config/uu-iter2-mix.yaml), copied to RUN/NAME.yaml after checking every custom_replays dir. ARM names an entry of
# that YAML's `arms` (learning_rate, lr_warmup_steps, seq_floor_warmup_steps), written to RUN/NAME.gin on top of
# finetune-flex.gin. METRICS=offline records amago's training metrics locally: the trainer gets --log with
# WANDB_MODE=offline (amago logs every 300 batches to RUN/checkpoints/NAME/wandb_logs; nothing is uploaded), and
# train_metrics.py dumps them to RUN/logs/NAME-metrics.jsonl. Writes RUN/NAME.yaml (dataset),
# RUN/NAME-jobs.json, before/after receipts, lifecycle and the trainer log under RUN/logs; checkpoints
# under RUN/checkpoints/NAME. ft1 (2026-10-20) = uu_iter1 piles/iter1 10 1000 2 28800 (no ARM, no METRICS).
set -u
RUN=$1 NAME=$2 PILE=$3 EP=$4 STEPS=$5 EVERY=$6 D=${7:-28800} ARM=${8:-} METRICS=${9:-}
case "$METRICS" in ""|offline) ;; *) echo "METRICS must be empty or offline: $METRICS"; exit 1 ;; esac
[[ "$PILE" != *.yaml ]] || PILE=$(realpath "$PILE")
K=$(cd "$(dirname "$0")" && pwd)
source "$RUN/env.sh"; cd "$R"
[ ! -e "checkpoints/$NAME" ] || { echo "run exists: $NAME"; exit 1; }
# Compiled flex backward returns wrong gradients at some lengths on GB10/torch 2.11 (flex_probe.py); train eager.
[ "${AMAGO_FLEX_TRAIN_EAGER:-}" = 1 ] || { echo "env.sh must export AMAGO_FLEX_TRAIN_EAGER=1"; exit 1; }
if [[ "$PILE" == *.yaml ]]; then
  "$PY" - "$PILE" "$NAME" "$ARM" <<'PY' || exit 1
import os, pathlib, shutil, sys, yaml
mix, name, arm = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
cfg = yaml.safe_load(mix.read_text())
missing = [c["dir"] for c in cfg["custom_replays"] if not pathlib.Path(c["dir"], "gen9uu").is_dir()]
if missing:
    sys.exit(f"missing custom_replays dirs: {missing}")
shutil.copyfile(mix, f"{name}.yaml")
if arm:
    a = cfg["arms"][arm]
    r = os.environ["R"]
    pathlib.Path(f"{name}.gin").write_text(
        f"include '{r}/finetune-flex.gin'\n"
        f"MetamonAMAGOExperiment.learning_rate = {a['learning_rate']}\n"
        f"MetamonAMAGOExperiment.lr_warmup_steps = {a['lr_warmup_steps']}\n"
        f"custom_agent.ISAdvantageFilter.seq_floor_warmup_steps = {a['seq_floor_warmup_steps']}\n")
PY
else
  [ -z "$ARM" ] || { echo "ARM needs a mixed dataset YAML"; exit 1; }
  [ -d "$PILE/UUKakuna/metamon/gen9uu" ] || { echo "not a frozen pile: $PILE"; exit 1; }
  cat > "$NAME.yaml" <<YAML
replay_weight: 0.0
formats: [gen9uu]
custom_replays:
  - dir: $R/$PILE/UUKakuna/metamon
    weight: 1.0
YAML
fi
"$PY" - "$NAME" "$EP" "$STEPS" "$EVERY" "$METRICS" <<'PY'
import json, os, pathlib, sys
name, epochs, steps, every, metrics = sys.argv[1:]
r = pathlib.Path(os.environ["R"])
argv = [os.environ["PY"], "-m", "metamon.rl.finetune", "--run_name", name, "--save_dir", str(r / "checkpoints"),
        "--base_model", "UUKakuna", "--base_checkpoint", "34", "--dataset_config", str(r / f"{name}.yaml"),
        "--train_gin_config", str(r / (f"{name}.gin" if (r / f"{name}.gin").exists() else "finetune-flex.gin")), "--epochs", epochs, "--steps_per_epoch", steps,
        "--batch_size_per_gpu", "2", "--grad_accum", "4", "--ckpt_interval", every, "--dloader_workers", "2", "--eval_gens",
        *(["--log"] if metrics else [])]
(r / f"{name}-jobs.json").write_text(json.dumps([{"argv": argv, "cwd": str(r / "source"), "log": str(r / f"logs/{name}-finetune.log")}], indent=1))
PY
# Inductor tiling analysis asserts in torch 2.11 backward codegen (tiling_utils _solve_simple_expr); off for training only.
export TORCHINDUCTOR_COALESCE_TILING_ANALYSIS=0
[ -z "$METRICS" ] || export WANDB_MODE=offline WANDB_CONSOLE=off  # env.sh disables W&B; offline writes local files only
bash "$K/observe.sh" "$RUN" > "logs/$NAME-before.txt"
"$PY" "$K/run_bounded.py" --seconds "$D" --grace 60 "$NAME-jobs.json" > "logs/$NAME-lifecycle.json" 2> "logs/$NAME-runner.err"
bash "$K/observe.sh" "$RUN" > "logs/$NAME-after.txt"
[ -z "$METRICS" ] || "$PY" "$K/train_metrics.py" "checkpoints/$NAME" > "logs/$NAME-metrics.jsonl" 2> "logs/$NAME-metrics.err" \
  || echo "metrics dump failed: see logs/$NAME-metrics.err"
# amago cannot resume exactly from its optimizer snapshots (load_checkpoint(N) retrains epoch N; the IS-filter state is
# unsaved), so they are ~2.3 GB per checkpoint of dead weight; KEEP_TRAINING_STATES=1 keeps them.
[ "${KEEP_TRAINING_STATES:-}" = 1 ] || rm -rf -- "checkpoints/$NAME/ckpts/training_states"
date -u +%FT%TZ > "logs/$NAME.done"
