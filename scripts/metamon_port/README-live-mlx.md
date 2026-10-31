# MLX live advisor on Apple Silicon

Live launch config: `config/local/metamon-live.json` (device-local, gitignored). It runs the local
`tmp/metamon-port/.venv/bin/python` and `scripts/metamon_port/mlx_worker.py`.
It uses Metal for the network and keeps the existing human-only live adapter.
No browser control or move execution is added. Each live battle runs its own
worker, up to `maxWorkers` in the launch config (the companion enforces it and
tells a battle over the limit to wait). Live workers hold
`tmp/metamon-port/model.lock` shared; the offline parity harness and device
setup hold it exclusively, so they never overlap a live game.

On the **next authorized companion start**, set:

```sh
SHWDN2OP_METAMON_LIVE_LAUNCH="$PWD/config/local/metamon-live.json" node apps/companion/dist/index.js
```

Run this from the project root (`zsh scripts/start_companion.sh` does the same with the newest priors).
The already running companion was deliberately left untouched. An independent
manual instance can use a free `COMPANION_PORT`; the extension must point to that
instance's port. Live parity tests use in-process HTTP injection without a port.

The wrapper hash checks and imports production worker
`917558eddf56e58dd1cd05332974df11d937549542fc4bc3674c8323d05ab5e9`.
Its checkpoint hash, size, filename, Metamon fork tree pin, poke-env/amago VCS commits,
protocol loop, decoder, legality, redraw, trapped retry and commit methods are
preserved. Construction installs the pinned observation configuration and an
MLX-backed `get_actions` adapter. CPU Torch tensors bridge the existing caller
and stored probabilities; no Torch network is built or executed.

Initial actions sample the full temperature-1 distribution using NumPy. NumPy,
MLX and Torch are seeded from the worker seed, including its unchanged
`--seed-per-side` derivation. Original illegal-action and trapped redraws use
CPU `torch.multinomial` on the **same stored MLX probabilities**, renormalized
by the original worker. These seeded streams are repeatable on the qualified
runtime; samples can differ from CUDA even when probability vectors match.
Each ordinary decision advances MLX once. Trapped retries advance neither the
network nor its KV cache. `MLXKakuna` retains its inclusive distance-96 window
and 97 KV slots; it rejects Metal unavailability without falling back to CPU.

All assets, caches and logs belong under project `tmp/`. By default, use:

- `tmp/metamon-port/fork/`: the project's Metamon fork (`vendor/metamon`) assembled with its
  upstream data files (`python vendor/metamon/assemble.py build tmp/metamon-port/fork --data-from
  tmp/metamon-port/source --expect <pin>`; on macbox `source` links to `tmp/metamon-src-0a00a759`).
  The worker checks the imported package's tree hash against `scripts/uu_selfplay/source-pins.json`.
- `tmp/metamon-port/ckpt/policy_epoch_34.pt`: checkpoint SHA256
  `7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c`.
- `tmp/metamon-port/kakuna-fp32.safetensors` plus its conversion manifest.

`SHWDN2OP_MLX_SOURCE` and `SHWDN2OP_MLX_WEIGHTS` may select other project-local
`tmp/` assets. Optional `SHWDN2OP_MLX_TRACE=/absolute/project/tmp/trace.jsonl`
appends validation-only forward/proposal/commit probabilities, timings, input
hashes, process IDs and GPU/RSS counters. It is off by default; use a fresh file
per process. RSS is the process high-water mark, not current resident size.

## Another Mac

Requires native arm64 macOS with Metal support and an existing native Python
3.12 executable (`PYTHON` may select it). From the synced checkout:

```sh
scripts/metamon_port/setup_mlx_device.sh /path/to/copied/policy_epoch_34.pt
```

A `user@macbox:/absolute/checkpoint/path` or gpubox checkpoint source also works;
the script runs only `scp` on that source, without remote inference. It creates
this Mac's venv, pinned dependency installations, source package, checked
checkpoint and converted weights entirely inside `tmp/metamon-port/`, and writes
`tmp/metamon-port/metamon-live-mlx.json` with this checkout's absolute paths.
It downloads pinned dependency sources/wheels and the manifest-checked Metamon
source archive. It never installs Python or changes a global environment.
Use that generated launch file on other Macs, after local qualification.
The setup script has not been run on another Mac in this task.

## Validation

With the existing three recorded games, CUDA-flex dump, and trapped fixture:

```sh
TMPDIR="$PWD/tmp/metamon-port/scratch" TSX_DISABLE_CACHE=1 node --import tsx --test scripts/metamon_port/mlx_launch.test.mts
tmp/metamon-port/.venv/bin/python -B scripts/metamon_port/test_mlx_live.py
```

The tests replay real companion `/v1/observations`, `/v1/evaluate`, advice and
human-choice event routes sequentially in separate processes. They require
identical input hashes, legal sets, recorded recurrence commits, probability
error <=1e-5 and 100% argmax agreement. They also cover wait requests, staged
human switches, trapped retries with a reused distribution, and worker PID
absence after win, leave and simulated idle timeout. At a terminal outcome the
existing adapter unloads without committing the final pending action: no next
recurrent input is needed. All earlier commits are checked.

Evidence, per-decision timing/memory, process proofs and measured summary:
`tmp/metamon-port/live-mlx/`. Network timings include transfer, forward,
probability copy and Metal synchronization. Proposal timings include the
original observation/tokenization/action path; companion advice latency also
includes JSON RPC. Loading and first calls are reported separately.
