# Kakuna on native Windows GPUs (amdbox AMD ROCm, winbox NVIDIA CUDA)

The directory name is historical: everything here serves both Windows backends.

| host | device-local runtime | torch | Python |
| --- | --- | --- | --- |
| amdbox | `C:\path\to\shwdn2op\tmp\metamon-amd\` | 2.11.0+rocm10.0.0 (AMD stable index, gfx1151 extra) | uv CPython 3.12.14 |
| winbox | `C:\path\to\shwdn2op\tmp\metamon-cuda\` | 2.11.0+cu130 (download.pytorch.org cu130, production's CUDA 13.0 build; sm_120 included) | uv CPython 3.12.3 (= production) |

`install.ps1 -Target -TorchIndex -TorchSpec -Python` builds a runtime (exact lines in its header):
uv-managed CPython inside the target (no shims, no registry), torch from the vendor index, the gpubox
freeze `requirements-prod.txt` with torch held, the VCS pins `--no-deps`, `pip check`, and the pinned
metamon source checkout. Git runs with `core.autocrlf=false`, so pip's VCS installs keep upstream LF
bytes (the self-play pin check needs them). Then copy the checkpoint (SHA256 7e7474d5…) to
`RUNTIME\kakuna\ckpts\policy_weights\policy_epoch_34.pt`. `kakuna_port.py`/`run.ps1` are amdbox's
offline parity harness.

## Live advisor

`live_worker.py` runs the pinned `scripts/metamon-worker.py` (hash-checked, loaded by path, its
protocol, decoder, legality, redraw, trapped re-choice, `stage_switch` and commit unchanged) and
replaces only the native-Windows parts: Job Object transport instead of setsid (stdin EOF ends the
worker and everything it started), HIP or CUDA `KakunaPolicy` construction with window-96 attention
(`scripts/uu_selfplay/windowed_attention.py`, production flex semantics; Windows has no Triton, so
no compiled flex), and a loopback-only guard for poke-env's import-time asyncio loop. On HIP only,
batch-1 fp32 linears use a sum reduction (hipBLAS GEMV error otherwise moves probabilities up to
1.7e-5). CUDA keeps cuBLAS, as production does: winbox without the fix is 3.8e-6 from CPU on the
self-play path (amdbox HIP 1.69e-5) and 3.5e-6 from production on the live path. The runtime log
labels the backend `rocm-windows-window96-sumlinear` or `cuda-windows-window96`.

Switch the companion (owner action; it restarts the companion):

```sh
SHWDN2OP_METAMON_LIVE_LAUNCH=config/local/metamon-live-amdbox.json node apps/companion/dist/index.js
SHWDN2OP_METAMON_LIVE_LAUNCH=config/local/metamon-live-winbox-native.json node apps/companion/dist/index.js
```

Each launch is `ssh HOST <venv python> -u live_worker.py --runtime ... --label {seed} --checkpoint ...
--attention-backend flex --seed {seed} --seed-per-side`. Both hosts' OpenSSH shell is pwsh 7, so the
remote command is one PowerShell line: bare exe paths without spaces or quotes. Switching back is the
same variable pointing at `config/local/metamon-live-winbox.json` (winbox WSL). When the pinned worker changes, update
`WORKER_SHA` in `live_worker.py` and `workerSha256` in the launches together; a mismatch fails closed.

Each session logs non-private lifecycle events (start with torch/device/arch, policy ready, cancel,
exit) to `RUNTIME\live-logs\`; the companion journal's `start.args` names `live_worker.py`.
`METAMON_LIVE_PROB_LOG=DIR` (set in the remote command, validation only) logs every decision's
action distribution. Measured on winbox: one loaded worker holds 2.36 GB working set, 3.8 GB private
commit (`import torch` alone: 0.5 / 1.5 GB) and about 0.78 GB GPU; all of it is released about 1 s
after exit. Model load is 1.4–1.6 s and advice latency through the companion is p50 40–80 ms.

## Validation (from macbox)

```sh
L=config/local/metamon-live-winbox-native.json   # or config/local/metamon-live-amdbox.json
W=tmp/trapped-rechoice-20261020
python3 scripts/metamon_port/amd/wire_replay.py --launch $L --wire $W/final/rpc-wire.jsonl --seed 1206387275 [--close companion]
python3 scripts/metamon_port/amd/wire_replay.py --launch $L --wire $W/stage-protocol/rpc-wire.jsonl --seed 1206387275 --close companion
python3 scripts/metamon_port/amd/live_parity.py configs --launch $L --remote-dir 'RUNTIME\live-probs' --out OUT/configs GAME-SIDE...
cd apps/companion && node --import tsx ../../scripts/metamon_port/amd/replay_live.mts GAME_DIR SIDE OUT.json OUT/configs/GAME-SIDE.json
python3 scripts/metamon_port/amd/live_parity.py compare --probs OUT/probs --ref tmp/metamon-port/torch-cuda-flex.jsonl --out OUT/parity.json
ssh HOST "& C:\path\to\shwdn2op\scripts\metamon_port\amd\live_state.ps1 [-Seconds 30]"
```

`wire_replay.py` requires every reply to equal a recorded production reply. `replay_live.mts`
drives a recorded side through the in-process companion advisor (no port, no running companion
touched) with the recorded seed and recorded commits, including rejected attempts
(`HUMAN_SWITCH`), mid-game leave (`LEAVE_AFTER_CHUNKS`) and idle unload (`IDLE_MS`,
`IDLE_AFTER_CHUNKS`). `live_parity.py` writes the probability-logging launch variants and compares
the logged distributions (copied back from `RUNTIME\live-probs`) with production's CUDA-flex dump.
`live_state.ps1` is the unload proof: live_worker python processes (each worker is the venv launcher
plus the interpreter), their memory, GPU adapter memory and host available RAM.

Results with the three cohort games: amdbox 169/169, max |Δp| 5.99e-6; winbox 169/169, 3.50e-6; argmax,
legal sets and steps equal on both. Wire replays are byte-identical on both (trapped 80/80,
stage_switch 81/81), and every companion replay advises production's recorded move.
