#!/bin/bash
# Build a UU self-play run dir on a Linux/CUDA device (flex attention), reproducing gpubox step 0.
# Usage: setup_run.sh RUN PY METAMON_SRC AMAGO_PKG KAKUNA_CKPT NODE_BIN TEAM_POOL
#   RUN         new run dir, inside the project's ignored tmp/
#   PY          venv python with torch 2.11.0+cu130, poke-env 0.8.3.3, amago 3.4.0 @0974781a
#   METAMON_SRC dir holding metamon/ with the fork's upstream data files (an upstream checkout at 0a00a759 or a run source);
#               the code is the project's Metamon fork, vendor/metamon, assembled and checked against source-pins.json
#   AMAGO_PKG   pinned amago/ package dir (e.g. the venv's site-packages/amago)
#   KAKUNA_CKPT policy_epoch_34.pt (SHA256 7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c)
#   NODE_BIN    dir with node and npm (v26.7.0)
#   TEAM_POOL   dir with uu_train_v1/ uu_dev_v1/ uu_held_out_v1/ (each gen9uu/*.gen9uu_team)
set -euo pipefail
[ $# -eq 7 ] || { sed -n 2,11p "$0"; exit 2; }
RUN=$1 PY=$2 MSRC=$3 APKG=$4 CKPT=$5 NODE_BIN=$6 POOL=$7
K=$(cd "$(dirname "$0")" && pwd)
[ ! -e "$RUN" ] || { echo "run dir exists: $RUN"; exit 1; }
[ "$(sha256sum "$CKPT" | cut -c1-64)" = 7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c ] || { echo "checkpoint hash mismatch"; exit 1; }
mkdir -p "$RUN"/{source,logs,piles,checkpoints,cache/teams,cache/torch-inductor,cache/triton}
cp -R "$APKG" "$RUN/source/amago"
find "$RUN/source" -name __pycache__ -type d -prune -exec rm -rf {} +
pin() { "$PY" -c "import json, sys; p = json.load(open(sys.argv[1])); print(p[sys.argv[2]][sys.argv[3]] if sys.argv[3] else ' '.join(p[sys.argv[2]]))" "$K/source-pins.json" "$@"; }
for f in $(pin amago ''); do [ "$(sha256sum "$RUN/source/$f" | cut -c1-64)" = "$(pin amago "$f")" ] || { echo "amago pin mismatch: $f"; exit 1; }; done
"$PY" "$K/../../vendor/metamon/assemble.py" build "$RUN/source" --data-from "$MSRC" --expect "$(pin metamon tree_sha256)"
"$PY" "$K/flex_train_kernel.py" "$RUN/source" && "$PY" "$K/flex_train_eager.py" "$RUN/source"
cat > "$RUN/env.sh" <<ENV
# Source before any UU self-play command. Device-local paths only.
export R=$RUN PY=$PY
export PATH=$NODE_BIN:\$PATH
export PYTHONPATH=$RUN/source METAMON_CACHE_DIR=$RUN/cache
export HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 WANDB_MODE=disabled TOKENIZERS_PARALLELISM=false
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1
export TORCHINDUCTOR_CACHE_DIR=$RUN/cache/torch-inductor TRITON_CACHE_DIR=$RUN/cache/triton CUDA_VISIBLE_DEVICES=0
# Training only: compiled flex backward is wrong at some lengths on GB10/torch 2.11; eager is exact.
export AMAGO_FLEX_TRAIN_EAGER=1
export UU_BASE_GIN=$RUN/base-flex.gin UU_KAKUNA_CKPT=$CKPT
export UU_FT_CKPT_DIR=$RUN/checkpoints UU_FT_RUN=uu_iter1 UU_FT_EPOCH=10 UU_FT_GIN=$RUN/finetune-flex.gin
ENV
for g in base:kakuna finetune:finetune; do
  { echo "include '$RUN/source/metamon/rl/configs/training/${g#*:}.gin'"
    echo "traj_encoders.TformerTrajEncoder.attention_type = @transformer.SlidingWindowFlexAttention"
    echo "transformer.SlidingWindowFlexAttention.window_size = 96"
    [ "${g%%:*}" = finetune ] && echo "amago.nets.transformer.SigmaReparam.fast_init = True"; } > "$RUN/${g%%:*}-flex.gin"
done
cp -R "$POOL"/uu_train_v1 "$POOL"/uu_dev_v1 "$POOL"/uu_held_out_v1 "$RUN/cache/teams/"; chmod -R a-w "$RUN/cache/teams/uu_held_out_v1"
mkdir -p "$RUN/ps" && cd "$RUN/ps" && printf '{"private":true}\n' > package.json
PATH=$NODE_BIN:$PATH npm install --no-audit --no-fund --omit=optional --ignore-scripts pokemon-showdown@0.11.11 > "$RUN/logs/ps-install.log" 2>&1
PS=$RUN/ps/node_modules/pokemon-showdown
cp "$PS/config/config-example.js" "$PS/config/config.js"
printf '\n// shwdn2op UU self-play: loopback-only private server, no REPL sockets\nexports.port = 8000;\nexports.bindaddress = "127.0.0.1";\nexports.watchconfig = false;\nexports.repl = false;\n' >> "$PS/config/config.js"
mkdir -p "$PS/logs/repl" "$PS/logs/chat" "$PS/logs/modlog" "$PS/logs/tickets" "$PS/config/chat-plugins"
PATH=$NODE_BIN:$PATH node "$K/audit_teams.cjs" "$PS" "$RUN/source/metamon/tokenizer/DefaultObservationSpace-v1.json" \
  "$RUN/cache/teams/uu_train_v1" "$RUN/cache/teams/uu_dev_v1" "$RUN/cache/teams/uu_held_out_v1" > "$RUN/logs/team-audit.json"
source "$RUN/env.sh"
"$PY" -m pip check
"$PY" -c "import metamon, amago; from metamon.config import SUPPORTED_BATTLE_FORMATS as F; from metamon.rl import pretrained; import torch; assert metamon.__file__.startswith('$RUN') and amago.__file__.startswith('$RUN') and 'gen9uu' in F and hasattr(pretrained, 'UUKakuna') and torch.cuda.is_available(); print('step0 ok', torch.__version__)" 2>&1 | tail -1
