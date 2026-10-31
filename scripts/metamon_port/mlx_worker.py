#!/usr/bin/env python3
"""MLX network adapter for the production worker's JSONL v2 protocol.

Only KakunaPolicy.__init__ and its get_actions implementation change. The
original propose/redraw/resolve_index/commit, decoder and RPC loop run verbatim.
Torch CPU tensors bridge the existing caller and stored redraw distribution;
no torch neural network, CUDA, or MPS execution is constructed.
"""
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import time
from types import SimpleNamespace

import action_probs
import lead_model
from common import CHECKPOINT, OUT, ROOT, configure_model, digest, setup

WORKER = ROOT / "scripts/metamon-worker.py"
WORKER_SHA = "917558eddf56e58dd1cd05332974df11d937549542fc4bc3674c8323d05ab5e9"
SOURCE = OUT / "fork"  # vendor/metamon assembled here; the worker checks its tree against the fork pin
WEIGHTS = OUT / "kakuna-fp32.safetensors"


def local_path(value):
    path = Path(value).resolve()
    if not path.is_relative_to((ROOT / "tmp").resolve()):
        raise ValueError("Device-local assets and traces must be inside project tmp/")
    return path


def worker_module():
    if digest(WORKER) != WORKER_SHA:
        raise RuntimeError("Pinned production worker hash mismatch")
    spec = importlib.util.spec_from_file_location("mlx_pinned_worker", WORKER)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker


def input_digest(obs, rl2, time_idx):
    import hashlib
    h = hashlib.sha256()
    for k, v in sorted({**obs, "_rl2": rl2, "_time": time_idx}.items()):
        h.update(json.dumps([k, v.shape, v.dtype.str]).encode())
        h.update(v.tobytes())
    return h.hexdigest()


def install(worker, source, weights, trace=None):
    """Patch construction/network boundary; optional observation never draws RNG."""
    from mlx_kakuna import MLXKakuna

    def initialize(self, checkpoint, seed, attention="flash"):
        import numpy as np
        import torch
        import mlx.core as mx
        from metamon.rl.metamon_to_amago import make_placeholder_env
        started = time.perf_counter()
        torch.set_num_threads(1)
        torch.manual_seed(seed)  # Original redraw uses torch.multinomial on CPU.
        np.random.seed(seed)    # Initial full-distribution sample, temperature 1.
        mx.random.seed(seed)
        self.seed = seed
        self.model = configure_model(source)
        self.network = MLXKakuna(weights)
        self.experiment = SimpleNamespace(DEVICE=torch.device("cpu"), caster=contextlib.nullcontext)
        self.wrapper = make_placeholder_env(self.model.observation_space, self.model.action_space)
        self.model.observation_space.reset()
        self.hidden = None
        self.previous_state = None
        self.previous_action = np.zeros((1, self.wrapper.action_size), dtype=self.wrapper.action_dtype)
        self.step, self.pending = 0, None
        self.network_calls = 0
        self.load_ms = (time.perf_counter() - started) * 1000

        def get_actions(*, obs, rl2s, time_idxs, sample, hidden_state):
            worker.require(sample and hidden_state == (None if self.network_calls == 0 else self.network_calls), "identity")
            # Undo only the existing caller's sequence-axis insertion. Timestep's
            # original numpy shapes/dtypes are retained for parity and tokenization.
            numpy_obs = {k: v[:, 0].numpy() for k, v in obs.items()}
            rl2, time_idx = rl2s[:, 0].numpy(), time_idxs[:, 0].numpy()
            worker.require(int(time_idx.item()) == self.network_calls, "identity")
            started = time.perf_counter()
            probs = self.network.step(numpy_obs, rl2, time_idx)
            self.network.sync()
            latency = (time.perf_counter() - started) * 1000
            worker.require(probs.shape == (13,) and bool(np.isfinite(probs).all())
                           and bool((probs >= 0).all()) and abs(float(probs.sum()) - 1) < 1e-5, "runtime")
            # The original redraw reads precisely this stored, unclipped-again
            # distribution, including when a trapped request changes legality.
            self.last_dist = SimpleNamespace(probs=torch.from_numpy(probs.copy()).reshape(1, 1, 1, 13))
            sampling_probs = probs.astype(np.float64)
            sampling_probs /= sampling_probs.sum()
            action = int(np.random.choice(13, p=sampling_probs))
            self.network_calls += 1
            if trace:
                import resource
                self.trace_row = {"event": "forward", "pid": os.getpid(), "seed": seed,
                    "step": int(time_idx.item()), "probs": probs.tolist(), "argmax": int(probs.argmax()),
                    "input_sha256": input_digest(numpy_obs, rl2, time_idx),
                    "network_calls": self.network_calls, "latency_ms": latency,
                    "load_ms": self.load_ms, "rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                    **self.network.memory(), "device": self.network.metadata}
                record(self.trace_row)
            return torch.tensor([[[action]]]), self.network_calls

        self.policy = SimpleNamespace(get_actions=get_actions)

    worker.KakunaPolicy.__init__ = initialize
    if trace is None:
        return

    def record(row):
        with trace.open("a") as stream:
            stream.write(json.dumps(row, allow_nan=False) + "\n")

    propose, commit = worker.KakunaPolicy.propose, worker.KakunaPolicy.commit

    def traced_propose(self, battle, request, rechoose=False):
        started = time.perf_counter()
        result = propose(self, battle, request, rechoose)
        legal = sorted({i for _, i in self.pending[1]})
        record({"event": "proposal", "pid": os.getpid(), "rqid": request["rqid"], "step": self.step - 1,
                "network_calls": self.network_calls, "rechoose": rechoose, "redrawn": self.redrawn,
                "legal": legal, "choice": result, "total_ms": (time.perf_counter() - started) * 1000,
                "probs": self.last_dist.probs[0, -1, -1].tolist(),
                # The pinned decoder's own index -> structural choice map, for wire-distribution parity.
                "mapping": [[choice, index] for choice, index in self.pending[1]]})
        return result

    def traced_commit(self, choice):
        index = self.resolve_index(choice)
        commit(self, choice)
        record({"event": "commit", "pid": os.getpid(), "step": self.step - 1,
                "network_calls": self.network_calls, "choice": choice, "index": index})

    worker.KakunaPolicy.propose, worker.KakunaPolicy.commit = traced_propose, traced_commit


def lead_checkpoint(argv):
    """Ours, not the pinned worker's: `--lead-checkpoint PATH` (relative = to the project root) is removed before its
    parser sees argv. Absent: no lead model and no reply field (the companion says so). A missing or changed file is
    the reply's explicit status, never a failed worker."""
    if "--lead-checkpoint" not in argv:
        return None
    index = argv.index("--lead-checkpoint")
    if index + 1 >= len(argv):
        raise ValueError("--lead-checkpoint needs a path")
    path = ROOT / argv[index + 1]  # an absolute PATH stays absolute
    del argv[index:index + 2]
    return path


def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Apple Silicon Mac with Metal required")
    # Before importing upstream libraries, contain caches and forbid networking.
    setup("mlx")
    source = local_path(os.environ.get("SHWDN2OP_MLX_SOURCE", SOURCE))
    weights = local_path(os.environ.get("SHWDN2OP_MLX_WEIGHTS", WEIGHTS))
    sys.path.insert(0, str(source))
    lead = lead_checkpoint(sys.argv)
    worker = worker_module()
    trace = os.environ.get("SHWDN2OP_MLX_TRACE")
    if trace:
        trace = local_path(trace)
        trace.parent.mkdir(parents=True, exist_ok=True)
    # Live workers share the lock (the companion bounds how many run: maxWorkers in the launch config); the offline
    # parity harness and device setup take it exclusively, so neither overlaps a live game. Fail immediately, never
    # queue. Held until process exit (including SIGKILL).
    with (OUT / "model.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        install(worker, source, weights, trace)
        action_probs.install(worker)  # Optional actionProbabilities on propose replies; sampling unchanged.
        if lead is not None:
            lead_model.install(worker, lead)  # Optional leadModel on the team-preview reply; the random draw unchanged.
        return worker.main()  # Includes unchanged checkpoint/runtime VCS gates.


if __name__ == "__main__":
    sys.exit(main())
