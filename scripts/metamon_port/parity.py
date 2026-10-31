#!/usr/bin/env python3
"""Offline, process-isolated Kakuna replay / conversion / parity harness.

Examples (from project root, using the prepared venv):
  python -B scripts/metamon_port/parity.py convert
  python -B scripts/metamon_port/parity.py suite
  python -B scripts/metamon_port/parity.py run --backend torch-cuda-flex
  python -B scripts/metamon_port/parity.py compare BASE.jsonl CANDIDATE.jsonl
"""

import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import resource
import shlex
import signal
import subprocess
import sys
import time

from common import (CHECKPOINT, COHORT, CKPT_SHA, DEFAULT_GAMES, OUT, ROOT, SOURCE,
                    ObservationPath, configure_model, digest, replay, setup, worker_module)

BACKENDS = ("torch-cpu", "torch-mps", "mlx", "torch-cuda-flex")


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def compare(reference, candidate, min_decisions=100, min_games=3):
    """Fail closed on missing/misaligned inputs as well as numerical regression."""
    import numpy as np
    read = lambda p: [json.loads(l) for l in Path(p).read_text().splitlines()]
    a, b = read(reference), read(candidate)
    if len(a) != len(b) or len(a) < min_decisions:
        raise AssertionError(f"Decision coverage mismatch: {len(a)}, {len(b)}; require {min_decisions}")
    games = {r["game"] for r in a}
    if len(games) < min_games:
        raise AssertionError(f"Need {min_games} games, have {len(games)}")
    errors, agree, legal_errors = [], [], []
    for x, y in zip(a, b):
        for key in ("game", "side", "rqid", "step", "input_sha256", "legal_mask", "commit", "commit_indices"):
            if x[key] != y[key]:
                raise AssertionError(f"Replay mismatch at {x['game']} rqid {x['rqid']}: {key}")
        p, q = np.array(x["probs"]), np.array(y["probs"])
        for v in (p, q):
            if v.shape != (13,) or not np.isfinite(v).all() or (v < 0).any() or abs(v.sum() - 1) > 1e-5:
                raise AssertionError("Invalid action probabilities")
        for row, vec in ((x, p), (y, q)):
            if row["argmax"] != int(vec.argmax()):
                raise AssertionError("Dumped argmax disagrees with probability vector")
        errors.append(float(np.max(np.abs(p - q))))
        legal_errors.append(float(np.max(np.abs(np.array(x["legal_probs"]) - np.array(y["legal_probs"])))))
        agree.append(int(x["argmax"] == y["argmax"]))
    result = {"reference": str(reference), "candidate": str(candidate), "decisions": len(a),
              "games": sorted(games), "max_abs_error": max(errors), "argmax_agreement": float(np.mean(agree)),
              "max_legal_conditional_abs_error": max(legal_errors),
              "decisions_after_window_boundary": sum(x["step"] > 96 for x in a),
              "nonfinite": 0, "bar_max_abs": 1e-3, "bar_argmax": 0.999}
    result["passed"] = result["max_abs_error"] <= 1e-3 and result["argmax_agreement"] >= 0.999
    if not result["passed"]:
        raise AssertionError(json.dumps(result))
    return result


def input_digest(obs, rl2, time_idx):
    import hashlib
    h = hashlib.sha256()
    for k, v in sorted({**obs, "_rl2": rl2, "_time": time_idx}.items()):
        h.update(json.dumps([k, v.shape, v.dtype.str]).encode())
        h.update(v.tobytes())
    return h.hexdigest()


def child_run(args):
    setup(args.backend)
    # The wheel also omitted tokenizer JSON package data. Use the already
    # present, pinned source package intact instead of repairing the install.
    sys.path.insert(0, str(args.source))
    import numpy as np
    start = time.perf_counter()
    worker = worker_module()
    if digest(args.checkpoint) != CKPT_SHA:
        raise RuntimeError("Checkpoint hash mismatch")
    if args.backend == "mlx":
        from mlx_kakuna import MLXKakuna
        model = configure_model(args.source)
        backend = MLXKakuna(args.weights)
    else:
        from torch_backend import TorchBackend
        backend = TorchBackend(args.backend, args.checkpoint, args.source, args.seed)
        model = backend.model
    backend.sync()
    load_ms = (time.perf_counter() - start) * 1000
    rows, input_files = [], {}
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w") as dump:
        for game_name in args.games:
            game = Path(args.cohort) / game_name
            for side in args.sides:
                launch = json.loads((game / "metamon-launch.json").read_text())
                for name in (f"{side}-private.jsonl", "trajectory.jsonl", "metamon-launch.json"):
                    p = game / name
                    input_files[str(p)] = digest(p)
                backend.reset()
                if args.backend == "torch-cuda-flex":
                    import torch
                    seed = worker.side_seed(launch["workerSeed"], side)
                    torch.manual_seed(seed)
                    np.random.seed(seed)
                path = ObservationPath(model, worker)
                for row, obs, rl2, time_idx, legal, aliases, sequence in replay(game, side, path):
                    backend.sync()
                    t = time.perf_counter()
                    probs = backend.step(obs, rl2, time_idx)
                    backend.sync()
                    elapsed = (time.perf_counter() - t) * 1000
                    if not np.isfinite(probs).all():
                        raise RuntimeError("Nonfinite inference result")
                    mask = np.zeros(13, bool)
                    mask[legal] = True
                    conditional = probs * mask
                    conditional = conditional / conditional.sum()
                    record = {"game": game_name, "side": side, "rqid": row["rqid"],
                        "step": int(time_idx.item()), "sequence": sequence,
                        "probs": probs.tolist(), "legal_mask": mask.tolist(),
                        "legal_probs": conditional.tolist(), "argmax": int(probs.argmax()),
                        "legal_argmax": int(conditional.argmax()), "latency_ms": elapsed,
                        "first_call": len(rows) == 0, "first_in_trajectory": int(time_idx.item()) == 0,
                        "input_sha256": input_digest(obs, rl2, time_idx), "commit": row["actionId"],
                        "commit_indices": aliases, "recorded_seed": launch["workerSeed"]}
                    dump.write(json.dumps(record, allow_nan=False) + "\n")
                    dump.flush()
                    rows.append(record)
                    if args.limit and len(rows) >= args.limit:
                        break
                print(f"{args.backend}: {game_name}/{side}, total {len(rows)} decisions", flush=True)
                if args.limit and len(rows) >= args.limit:
                    break
            if args.limit and len(rows) >= args.limit:
                break
    if not rows:
        raise RuntimeError("No recorded decisions replayed")
    latencies = [r["latency_ms"] for r in rows[1:]] or [rows[0]["latency_ms"]]
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    summary = {"backend": args.backend, "pid": os.getpid(), "platform": platform.platform(),
        "metadata": backend.metadata, "decisions": len(rows), "games": sorted({r["game"] for r in rows}),
        "load_ms": load_ms, "first_call_ms": rows[0]["latency_ms"],
        "p50_ms": float(np.percentile(latencies, 50)), "p95_ms": float(np.percentile(latencies, 95)),
        "peak_rss_bytes": int(peak if sys.platform == "darwin" else peak * 1024),
        "memory_before_exit": backend.memory(), "checkpoint_sha256": CKPT_SHA,
        "worker_sha256": digest(ROOT / "scripts/metamon-worker.py"),
        "source_files": {str(p): digest(p) for p in Path(__file__).parent.glob("*.py")},
        "inputs": input_files, "alias_decisions": sum(len(r["commit_indices"]) > 1 for r in rows),
        "observations": "official SocketlessBattle/UniversalState/tokenizer/reward/Timestep; recorded commits",
        "latency_scope": "numpy input transfer + forward + probability copy + device synchronization; excludes parser/tokenizer",
        "threads": 4}
    import importlib.metadata
    import amago.nets.transformer
    import metamon.rl.metamon_to_amago
    dependency_files = [Path(amago.nets.transformer.__file__), Path(metamon.rl.metamon_to_amago.__file__),
        Path(args.source) / "metamon/rl/configs/models/superkazam.gin",
        Path(args.source) / "metamon/rl/configs/training/kakuna.gin"]
    dependency_files += list((Path(args.source) / "metamon/tokenizer").glob("*.json"))
    summary["dependency_files"] = {str(p): digest(p) for p in dependency_files}
    summary["packages"] = {p: importlib.metadata.version(p) for p in ("torch", "numpy", "metamon", "amago", "poke-env", "gymnasium")}
    summary["packages"]["mlx"] = importlib.metadata.version("mlx") if args.backend == "mlx" else None
    summary["memory_after_explicit_unload"] = backend.close()
    write_json(destination.with_suffix(".summary.json"), summary)
    print(json.dumps({k: v for k, v in summary.items() if k in ("decisions", "p50_ms", "p95_ms", "peak_rss_bytes", "first_call_ms")}))


def isolated(argv, log):
    """Supervisor holds no model. Wait/reap before another backend can start."""
    command = [sys.executable, "-B", str(Path(__file__).resolve()), *argv, "--child"]
    env = os.environ.copy()
    env.update(PYTHONDONTWRITEBYTECODE="1", OMP_NUM_THREADS="4", MKL_NUM_THREADS="4",
               OPENBLAS_NUM_THREADS="4", TMPDIR=str(OUT / "scratch"))
    (OUT / "scratch").mkdir(parents=True, exist_ok=True)
    before = subprocess.check_output(["vm_stat"] if sys.platform == "darwin" else ["cat", "/proc/meminfo"], text=True)
    with Path(log).open("w") as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, cwd=ROOT, env=env,
                                   start_new_session=True)
        try:
            status = process.wait()
        except BaseException:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
    try:
        os.kill(process.pid, 0)
        absent = False
    except ProcessLookupError:
        absent = True
    # Compiled CUDA Flex can spawn compiler subprocesses. They are in our
    # private process group; clean up any survivors without touching other jobs.
    compiler_cleanup = False
    try:
        os.killpg(process.pid, 0)
        os.killpg(process.pid, signal.SIGKILL)
        compiler_cleanup = True
    except ProcessLookupError:
        pass
    after = subprocess.check_output(["vm_stat"] if sys.platform == "darwin" else ["cat", "/proc/meminfo"], text=True)
    proof = {"command": shlex.join(command), "pid": process.pid, "exit_code": status,
             "reaped": process.returncode is not None, "pid_absent_after_exit": absent,
             "surviving_compiler_group_cleaned": compiler_cleanup,
             "before_system_memory": before, "after_system_memory": after,
             "interpretation": "Process address space and GPU allocations released on exit. System counters include unrelated shared-host activity and file cache."}
    write_json(Path(log).with_suffix(".process.json"), proof)
    if status or not absent:
        raise RuntimeError(f"Child failed or remains alive; see {log}")
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("convert", "run", "suite", "compare"))
    parser.add_argument("files", nargs="*")
    parser.add_argument("--backend", choices=BACKENDS, default="torch-cpu")
    parser.add_argument("--backends", nargs="+", choices=BACKENDS, default=["torch-cpu", "mlx", "torch-mps"])
    parser.add_argument("--checkpoint", type=Path, default=CHECKPOINT)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--weights", type=Path, default=OUT / "kakuna-fp32.safetensors")
    parser.add_argument("--cohort", type=Path, default=COHORT)
    parser.add_argument("--games", nargs="+", default=DEFAULT_GAMES)
    parser.add_argument("--sides", nargs="+", choices=("p1", "p2"), default=["p1"])
    parser.add_argument("--seed", type=int, default=123)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for path in (args.weights, args.output):
        if path is not None and not path.resolve().is_relative_to(OUT):
            parser.error("All outputs/converted weights must stay under tmp/metamon-port")
    if args.command == "compare":
        if len(args.files) != 2:
            parser.error("compare needs reference and candidate JSONL")
        result = compare(*args.files)
        if args.output:
            write_json(args.output, result)
        print(json.dumps(result, indent=2))
        return
    if args.child:
        if args.command == "convert":
            setup()
            from mlx_kakuna import convert
            print(json.dumps(convert(args.checkpoint, args.weights), indent=2))
        else:
            if args.output is None:
                args.output = OUT / f"{args.backend}.jsonl"
            child_run(args)
        return
    # Nonblocking lock: no queued model can unexpectedly load after this run.
    with (OUT / "model.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "suite":
            if "torch-cpu" not in args.backends:
                parser.error("suite requires torch-cpu so it cannot reuse a stale reference")
            args.backends = ["torch-cpu"] + [b for b in args.backends if b != "torch-cpu"]
            for backend in args.backends:
                output = OUT / f"{backend}.jsonl"
                argv = ["run", "--backend", backend, "--output", str(output),
                        "--checkpoint", str(args.checkpoint), "--source", str(args.source),
                        "--weights", str(args.weights), "--cohort", str(args.cohort),
                        "--games", *args.games, "--sides", *args.sides, "--seed", str(args.seed)]
                isolated(argv, OUT / f"{backend}.log")
                if backend != "torch-cpu":
                    result = compare(OUT / "torch-cpu.jsonl", output)
                    write_json(OUT / f"{backend}.parity.json", result)
                    print(json.dumps(result), flush=True)
        else:
            log = OUT / "convert.log" if args.command == "convert" else (args.output or OUT / f"{args.backend}.jsonl").with_suffix(".log")
            isolated(sys.argv[1:], log)


if __name__ == "__main__":
    main()
