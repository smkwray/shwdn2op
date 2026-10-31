# UU self-play kit

Producer for Metamon Kakuna Gen 9 UU self-play training data. It syncs to every device. Run dirs (sources,
caches, server, piles, logs) are device-local under the project's Syncthing-ignored `tmp/`.

The Metamon code is the project's fork, `vendor/metamon` (upstream 0a00a759 plus every UU change, including the
own-side Illusion fix; see its README). A run source is that fork assembled with upstream's large data files, and
`source-pins.json` pins its tree hash: setup builds it, and a block refuses to start on any other tree. To deploy a fork
change: re-pin, pass `vendor/metamon/tests` and the parity checks, then, between blocks on each device,
`python vendor/metamon/assemble.py swap RUN/source --expect <pin>`.

Linux + CUDA (gpubox, winbox WSL), production flex attention:

```sh
K=scripts/uu_selfplay
bash $K/setup_run.sh RUN PY METAMON_SRC AMAGO_PKG KAKUNA_CKPT NODE_BIN .local-data/uu-team-pool-v1/teams
bash $K/server.sh RUN start
bash $K/block.sh RUN BLOCK WORKERS BATTLES_PER_ACCOUNT [DEADLINE_S]   # about BATTLES*WORKERS/2 games
bash $K/server.sh RUN stop
```

- `setup_run.sh` checks the amago pin, assembles the fork (data from METAMON_SRC) against the tree pin and applies the two amago flex-training patches. It installs Pokémon Showdown 0.11.11 (loopback only, no REPL) and audits the team pool.
- `block.sh` writes the ladder, jobs and a manifest (host, temperatures by account, source hashes), and runs the jobs under `run_bounded.py`. `tail_guard.sh` stops a last worker left with no opponent. The block ends with receipts and `validate_pile.py`.
- Each trajectory `X.json.lz4` has a sidecar `X.json.lz4.meta` (deliberately not `*.json`): battle tag, finished/won, time limit, invalid-order count, parse errors, team file.
- Upstream Metamon keeps invalid-order episodes as training data (the illegal choice leads to a random move, and the critic learns it is bad). Here they are kept and flagged, so a fine-tune can include or exclude them.

Windows (amdbox ROCm, winbox native NVIDIA CUDA) and macOS (macbox, CPU), with window-96 attention instead of flex:

```sh
PY setup_run_portable.py --run RUN --python PY --metamon-src SRC --amago-pkg AMAGO --ckpt CKPT --node-dir NODE \
   --team-pool .local-data/uu-team-pool-v1/teams --device {cuda|cpu|mps} [--fetch-node]
PY block_portable.py --run RUN --block BLOCK --workers W --challenges N --seconds S [--device cpu] [--min-available-gb G]
```

On Windows the runtime comes from `scripts/metamon_port/amd/install.ps1` (venv, pinned metamon source
`RUNTIME\source`, LF amago `RUNTIME\venv\Lib\site-packages\amago`, checkpoint), for example winbox (pwsh):

```powershell
$P = 'C:\path\to\shwdn2op'; $T = "$P\tmp\metamon-cuda"; $Py = "$T\venv\Scripts\python.exe"
& $Py $P\scripts\uu_selfplay\setup_run_portable.py --run $P\tmp\uu-selfplay-winbox-native --python $Py --metamon-src $T\source `
  --amago-pkg $T\venv\Lib\site-packages\amago --ckpt $T\kakuna\ckpts\policy_weights\policy_epoch_34.pt `
  --node-dir $T\node-v26.7.0-win-x64 --team-pool $P\.local-data\uu-team-pool-v1\teams --device cuda --fetch-node
& $Py $P\scripts\uu_selfplay\block_portable.py --run $P\tmp\uu-selfplay-winbox-native --block zn2 --workers 2 --challenges N --seconds S --min-available-gb 4
```

winbox native (RTX 5060 Ti, torch 2.11.0+cu130): window parity 324/324 decisions, max |Δp| 3.8e-6. Each
worker holds about 2.4 GB working set and 3.8 GB private commit, and Windows frees it at exit (no
WSL VM, page cache or inductor compile workers). Two workers took host available RAM from 9.1 to
3.6 GB on the owner's desktop, so the 4 GB floor stopped qualification block zn1 after 3 games (validated clean).

- `windowed_attention.py` is gin-bound through `RUN/base-window.gin` (`import windowed_attention`), so no extra source patch is needed. `window_parity.py` checks it on the self-play construction path. The windowed class covers the cached inference path only; do not train with it.
- `block_portable.py` owns the full block lifecycle: a Windows Job Object or macOS session, an internal lone-worker tail guard, the macOS `memory_pressure` gate (start at ≥40% free, stop below 35%), a per-block server, receipts, the manifest and validation.

Training (Linux/CUDA): `flex_train_kernel.py` and `flex_train_eager.py` patch only amago's training flex call. On GB10/torch 2.11 the compiled flex backward returns wrong gradients at some sequence lengths, so `env.sh` sets `AMAGO_FLEX_TRAIN_EAGER=1` (eager flex is exact). Battle tags restart in every block; key across blocks by (host, block, tag). `freeze_pile.py` pairs within a block.

## Iteration 2 data

League self-play (`config/uu-league-iter2.yaml`, a Metamon ladder config): `block_portable.py --league FILE
[--export-dir DIR]` launches each account through `league_serve.py`, which registers in-process (pinned source
untouched) `UUExport` (ft1 exports, SHA256-pinned in the YAML), `League<Name>` upstream Gen-9 policies with
attention rebound to the run's `UU_BASE_GIN` class at their own window (96, or 32 for Abra/Kadabra/SmallRLGen9Beta),
and `baseline:<Name>` poke-env/Metamon heuristics (no trajectories; validated as single-POV battles). Fetch and
strict-load upstream weights once with `league_serve.py --prefetch FILE` (HF online). Opponent shares are emergent
(local ladder matching): read `pov_vs_opponent` in the block lifecycle. Freeze strata separately with
`freeze_pile.py ... --single-pov-accounts <baseline accounts> --models <model dirs>`; it drops POVs that hold an own
Illusion mon (read from the trajectory) from blocks whose manifest records upstream's decoder (collected before the fork's
own-Illusion fix, which mis-tracked its own disguise); later blocks keep them. The sidecar's `team_file` usually names
the account's next sampled team, not the one played, so nothing keys on it. `block.sh` (Linux) is
unchanged; run league blocks through `block_portable.py`, which needs `RUN/env.json` (setup_run_portable.py).

Human demonstrations: `human_replays.py index|fetch` (public replay search, 1 request/s, HMAC pseudonyms, chat and
side-ref names removed; `human_replays.py local` adds locally saved games under the same salt, and `privacy --local`
checks them without the index) -> `python -m metamon.backend.replay_parser --format gen9uu` (needs METAMON_CACHE_DIR with
Metamon gen9 usage stats) -> `validate_pile.py PARSED --human` -> `human_replays.py split` (eval-team-pool dev and
held-out families/sources excluded, last 14 days test, player-disjoint val). `human_replays.py selfplay|audit`
measures reconstruction against self-play ground truth; `human_replays.py teams` builds the `uu_stress_v1` set.

Mix and optimizer arms: `config/uu-iter2-mix.yaml` (Metamon dataset config plus `arms`), run with
`finetune.sh RUN NAME config/uu-iter2-mix.yaml EPOCHS STEPS EVERY DEADLINE ARM [offline]`. `offline` records amago's
training metrics locally (`--log` with W&B offline, every 300 batches, nothing uploaded) and `train_metrics.py` dumps
them to `RUN/logs/NAME-metrics.jsonl`; without it the trainer argv is unchanged. `lr_probes.sh PREFIX` runs every arm
as `PREFIX_<arm>` with metrics, after the eval queue, once gpubox's synced copies of the mix, `finetune.sh` and
`train_metrics.py` hash-match the driver's.

Windows/macOS training: `finetune_portable.py` is `finetune.sh` without bash/setsid (block_portable's Job Object, a
deadline, the owner's available-RAM floor, RAM/VRAM samples). `RUN/env.json` must put an amago patched by
`flex_train_kernel.py` + `flex_train_eager.py` first on PYTHONPATH and set `AMAGO_FLEX_TRAIN_EAGER=1`; `--remap` maps the
mix YAML's gpubox data paths to local copies. With dynamo disabled (no triton on Windows) it applies dynamo's
`TorchPatcher.patch()` first, as the first compiled call does on Linux (distribution validation off; amago's padded
batches fail it otherwise). Offline screen: `heldout_nll.py score|compare` (held-out action NLL and top-1 through
Metamon's dataset and registry, paired battle-clustered differences); a screen, not playing strength.
