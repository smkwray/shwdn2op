# Kakuna inference parity port

An offline, inference-only MLX port of the pinned Kakuna epoch 34 model. This
directory is portable source. All generated assets, evidence, logs, caches, and
process locks live under the project's device-local `tmp/metamon-port/`.
The existing worker is imported and hash checked; it is never modified.

From the project root, with the already prepared environment:

```sh
tmp/metamon-port/.venv/bin/python -B scripts/metamon_port/parity.py convert
tmp/metamon-port/.venv/bin/python -B scripts/metamon_port/parity.py suite
tmp/metamon-port/.venv/bin/python -B scripts/metamon_port/test_parity.py
```

The default suite runs CPU, MLX, and MPS **sequentially** in separate processes.
It replays p1 of three full recorded games (169 decisions, including 27 beyond
the window boundary). `--games`, `--sides`, `--cohort`, `--checkpoint`, and
`--source` select other local assets. `run --limit 3 --output
tmp/metamon-port/example.jsonl` provides a short fixture check. A suite requires
a fresh CPU reference; comparison fails on mismatched inputs, masks, commits,
coverage, nonfinite probabilities, error above 0.001, or argmax agreement below
0.999. The tests execute a fresh three-decision fixture on both backends and
also validate full-run evidence, deliberate probability corruption, and the
inclusive attention boundary. Missing assets/evidence fail explicitly.

The prepared wheel omitted gin and tokenizer package data, so the harness
imports the **existing pinned source package** at
`tmp/shwdn2op-metamon-source/metamon-0a00a759c9a4382a2877088d828302ec294a05a5/`.
Other devices can select their existing local pinned source with `--source`.
No downloader, package installer, server, or battle connection is used.
Python network connections are explicitly rejected by an audit hook.

For gpubox, using its existing torch 2.11.0+cu130 environment and local assets:

```sh
python -B scripts/metamon_port/parity.py run --backend torch-cuda-flex
python -B scripts/metamon_port/parity.py compare tmp/metamon-port/torch-cpu.jsonl tmp/metamon-port/torch-cuda-flex.jsonl --output tmp/metamon-port/torch-cuda-flex.parity.json
```

Supply `--source`/`--checkpoint`/`--cohort` if their local locations differ. The
CUDA backend invokes the actual pinned `KakunaPolicy(..., attention="flex")`
constructor, caster, and `get_actions`, including legal-redraw sampling. It
restores the recorded per-side seed at trajectory start. Upstream experiment
scaffolding is contained by a checkpoint symlink under `tmp/metamon-port/native/`.
CUDA execution and numerical parity remain unqualified until run there.

## Semantics and scope

- The real worker `SocketlessBattle`, upstream `UniversalState`, tokenizer,
  observation/reward functions, `Timestep.as_input`, and worker `commit` form
  every trajectory. Recorded executed choices, including veto overrides, are
  mapped to official action indices and committed. Team preview never advances
  the network. Input hashes must match between backends at every decision.
- The recordings contain private protocol chunks and structural commits, not
  TS snapshot envelopes. `identity=None` uses the real decoder without claiming
  TS hash/bind qualification. The supplied cohort is gen9uu, an OOD ruleset for
  Kakuna; this measures implementation parity, not playing strength.
- CPU/MPS use the unmodified AMAGO observation encoder, trajectory blocks, and
  actor. Only Flex's CUDA-only attention kernel is replaced by dense fp32 SDPA
  with its exact mask `0 <= q-k <= 96`. Torch compilation is disabled for these
  reference backends. All 642 checkpoint keys/shapes are validated and loaded.
- MLX implements the full Perceiver encoder (10 cross/self pairs, SiLU FFs),
  sinusoidal positions, 10 NormFormer/SigmaReparam trajectory layers, head
  scaling, and the three-block residual actor. It keeps 97 KV slots per layer;
  discarding older masked keys preserves upstream's rolling-128-cache behavior.
  The QKV projection's upstream `(three, head_dim, heads)` order is preserved.
- Conversion freezes the 40 evaluation-mode SigmaReparam weights using the
  upstream torch/einops reduction order and retains biases unchanged. This is
  an algebraic evaluation optimization. No fp16, quantization, training,
  critic/target/PopArt evaluation, or torch inference is used in MLX's forward.
  MLX still imports Metamon's torch-dependent observation package.
- The last of seven actor gamma heads supplies the 13-action distribution.
  Logit masking is followed by clipping probabilities to [0.001, 0.99] and
  normalization, matching upstream. Dumps include both this **full** distribution
  and its legal-only conditional, with separate argmax values.
- CPU/MPS use deterministic argmax instead of random sampling because recorded
  commits determine recurrence. MLX returns distributions, not torch-identical
  random samples. CUDA samples/redraws using the production path. Structural
  Struggle/Recharge recordings cannot disambiguate original sampled aliases;
  the harness uses the lowest valid index and exposes `commit_indices`. Such
  cases must be reported; there are none in the default qualification set.

`latency_ms` covers input transfer, neural forward, probability copy, and GPU
synchronization, excluding protocol parsing/tokenization/commit and model
loading. Summaries separate load time and the process's first call from p50/p95
of the remaining calls. Kernel/driver caches can survive process exit; a process
first call is not necessarily the machine's first kernel compilation.

Each model process explicitly drops weights/KV state and clears framework GPU
caches before exit. The supervisor waits and reaps it, checks PID absence, and
retains before/after system memory counters. Those counters include unrelated
shared-host activity and file cache; PID disappearance is the process-unload
proof. A nonblocking lock prevents overlapping harness model processes.

See the generated `tmp/metamon-port/report.md` for measured results, exact
commands, evidence paths, and a proposed future worker selector. No live worker
integration is implemented here.
