#!/bin/bash
# Run one bounded self-play block in a run dir (Linux): block.sh RUN BLOCK WORKERS BATTLES_PER_ACCOUNT [DEADLINE_S]
# Accounts UU<BLOCK><A..>; temperatures cycle 1.0, 1.25, 1.5 by account. Writes ladder, jobs, manifest,
# before/after receipts, lifecycle and validation under RUN/logs; trajectories under RUN/piles/BLOCK. Starts only when
# RUN/source/metamon is the pinned Metamon fork tree (source-pins.json); the manifest records it.
set -u
RUN=$1 B=$2 W=$3 N=$4 D=${5:-3600}
K=$(cd "$(dirname "$0")" && pwd)
source "$RUN/env.sh"; cd "$R"
[ ! -e "piles/$B" ] || { echo "block exists: $B"; exit 1; }
"$PY" - "$B" "$W" "$N" "$K" <<'PY' || exit 1
import hashlib, json, os, pathlib, socket, string, sys
b, w, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]); r = pathlib.Path(os.environ["R"]); temps = [1.0, 1.25, 1.5]
sys.path.insert(0, sys.argv[4]); from setup_run_portable import assembler
pinned = json.loads(pathlib.Path(sys.argv[4], "source-pins.json").read_text())["metamon"]["tree_sha256"]
tree, _ = assembler().tree(r / "source")
if tree != pinned:
    sys.exit(f"run source metamon tree {tree} is not the pinned fork {pinned}: swap it with vendor/metamon/assemble.py swap")
names = [f"UU{b}{string.ascii_uppercase[i]}" for i in range(w)]
lines = ["defaults:", "  team_set: uu_train_v1", "  battle_backend: metamon", "  checkpoints: [34]", "  temperatures: [1.0]", "  num_agents: 1", "agents:"]
lines += [f"  {x}: {{model_name: UUKakuna, temperatures: [{temps[i % 3]}]}}" for i, x in enumerate(names)]
(r / f"ladder-{b}.yaml").write_text("\n".join(lines) + "\n")
jobs = [{"argv": [os.environ["PY"], "-m", "metamon.rl.evaluate.ladder_self_play.serve_model", "--username", x, "--format", "gen9uu",
                  "--config", str(r / f"ladder-{b}.yaml"), "--n_challenges", str(n), "--save_trajectories_to", str(r / "piles" / b)],
         "cwd": str(r / "source"), "log": str(r / "logs" / f"{b}-{x}.log")} for x in names]
(r / f"{b}-jobs.json").write_text(json.dumps(jobs, indent=1))
src = {str(p.relative_to(r)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((r / "source").rglob("*.py"))
       if any(s in str(p) for s in ("metamon/env/", "ladder_self_play", "rl/pretrained.py", "metamon/config.py", "amago/experiment.py"))}
(r / f"{b}-manifest.json").write_text(json.dumps({"block": b, "host": socket.gethostname(), "workers": w, "battles_per_account": n,
    "temperatures": {x: temps[i % 3] for i, x in enumerate(names)}, "checkpoint": os.environ["UU_KAKUNA_CKPT"],
    "gin": os.environ["UU_BASE_GIN"], "metamon_tree_sha256": tree, "source_sha256": src}, indent=1))
PY
bash "$K/observe.sh" "$RUN" > "logs/$B-before.txt"
setsid -f bash "$K/tail_guard.sh" "$RUN" "$R/ladder-$B.yaml" > "logs/$B-tail-guard.log" 2>&1 < /dev/null
"$PY" "$K/run_bounded.py" --seconds "$D" --grace 30 "$B-jobs.json" > "logs/$B-lifecycle.json" 2> "logs/$B-runner.err"
bash "$K/observe.sh" "$RUN" > "logs/$B-after.txt"
"$PY" "$K/validate_pile.py" "piles/$B" > "logs/$B-validate.json" 2> "logs/$B-validate.err"
date -u +%FT%TZ > "logs/$B.done"
