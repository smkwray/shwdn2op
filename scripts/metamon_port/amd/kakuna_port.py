"""Kakuna epoch-34 inference port harness for amdbox (AMD gfx1151, PyTorch ROCm on Windows).

Device-local scratch (lives in <project>/tmp/metamon-amd/harness). It never edits the
pinned worker: it loads scripts/metamon-worker.py by path after checking its SHA256 and
reuses SocketlessBattle, KakunaPolicy.propose/resolve_index/commit and structural_choice.
Only KakunaPolicy.__init__ is replaced, because the pinned one requires CUDA plus
flash-attn or torch 2.11.0+cu130 flex. The replacement binds an eager attention that
reproduces production's SlidingWindowFlexAttention(window_size=96) KV-cache mask.

Modes:
  runtime-check  pinned worker check_runtime() + HIP device facts
  replay      replay recorded games, dump per-decision probabilities (JSONL + summary)
  attn-check  compare the eager window attention with amago's SlidingWindowFlexAttention
  compare     parity/latency report between two replay dumps
"""

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import statistics
import sys
import time

HERE = Path(__file__).resolve().parent
T = HERE.parent  # <project>/tmp/metamon-amd
ROOT = T.parents[1]  # <project>
WORKER = ROOT / "scripts" / "metamon-worker.py"
WORKER_SHA = "917558eddf56e58dd1cd05332974df11d937549542fc4bc3674c8323d05ab5e9"
CKPT = T / "kakuna" / "ckpts" / "policy_weights" / "policy_epoch_34.pt"
CKPT_SHA = "7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c"
COHORT = T / "cohort"
SOURCE = T / "fork"  # vendor/metamon assembled with data from T/source (install.ps1's upstream checkout)
GAMES = ["drew-uu03-b-p2-s3", "alex-uu01-b-p1-s3", "avery-uu01-b-p2-s3"]
WINDOW = 96  # production: --attention-backend flex -> SlidingWindowFlexAttention(window_size=96)


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def setup(device):
    """Run before third-party imports: device-local caches, offline, eager torch."""
    cache = T / "cache"
    for name, sub in {"METAMON_CACHE_DIR": "metamon", "HF_HOME": "hf", "TORCH_HOME": "torch",
                      "XDG_CACHE_HOME": "xdg"}.items():
        (cache / sub).mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(cache / sub)
    os.environ["TEMP"] = os.environ["TMP"] = str(T / "scratch")
    # Triton/inductor do not exist for this stack; torch.compile decorators run eagerly.
    os.environ.update(HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", WANDB_MODE="disabled",
                      TORCHDYNAMO_DISABLE="1", PYTHONDONTWRITEBYTECODE="1")
    if device == "cpu":
        os.environ["ACCELERATE_USE_CPU"] = "true"
    sys.dont_write_bytecode = True
    # The project's Metamon fork (assembled at T/fork); the worker's check_runtime pins its tree.
    sys.path.insert(0, str(SOURCE))

    def offline(event, args):
        # Windows asyncio (poke_env's import-time loop) builds socketpair() from a
        # 127.0.0.1 connect; allow loopback only. DNS and other addresses stay blocked.
        if event == "socket.connect" and isinstance(args[1], tuple) and args[1][0] in ("127.0.0.1", "::1"):
            return
        if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto"):
            raise RuntimeError("network is forbidden in the offline port harness")
    sys.addaudithook(offline)


def load_worker():
    if sha256(WORKER) != WORKER_SHA:
        raise RuntimeError(f"pinned worker hash mismatch: {WORKER}")
    spec = importlib.util.spec_from_file_location("pinned_metamon_worker", WORKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def metamon_from_source():
    import metamon
    path = Path(metamon.__file__).resolve()
    if SOURCE.resolve() not in path.parents:
        raise RuntimeError(f"metamon imported from {path}, not the assembled fork {SOURCE}")
    return str(path)


def window_attention_class(window):
    import torch
    from amago.nets.transformer import VanillaAttention

    class SlidingWindowVanillaAttention(VanillaAttention):
        """amago VanillaAttention, KV-cache path, plus production's sliding window.

        Production (SlidingWindowFlexAttention.kv_cache_mask_mod) lets the query at cache
        index s see key kv iff kv <= s and s - kv <= window. Upstream VanillaAttention
        masks only kv > s (full causal), so it is wrong once s > window. Cache indices are
        rolled with the cache, so this is the same relative window as production.
        """

        window_size = window

        def _inference_with_cache(self, qkv, key_cache, val_cache, cache_seqlens):
            queries, keys, values = torch.unbind(qkv, dim=2)
            B, L, H, E = queries.shape
            assert L == 1
            scale = 1.0 / math.sqrt(E)
            cache_idxs = torch.arange(key_cache.shape[0], device=key_cache.device)
            key_cache[cache_idxs, cache_seqlens] = keys[:, 0]
            val_cache[cache_idxs, cache_seqlens] = values[:, 0]
            end = cache_seqlens + 1
            max_len = end.max()
            k_cache = torch.nan_to_num(key_cache[:, :max_len])
            v_cache = torch.nan_to_num(val_cache[:, :max_len])
            scores = scale * torch.einsum("blhe,blhe->blh", queries, k_cache)
            kv = torch.arange(max_len, device=cache_seqlens.device)[None, :]
            # The only change from upstream: OR in the window bound.
            mask = (kv >= end[:, None]) | (cache_seqlens[:, None] - kv > self.window_size)
            scores.masked_fill_(mask[:, :, None], -torch.inf)
            A = self.dropout(torch.softmax(scores, dim=1))
            return torch.einsum("blh,blhd->bhd", A, v_cache).unsqueeze(1)

        def forward(self, qkv, key_cache=None, val_cache=None, cache_seqlens=None):
            if key_cache is None or val_cache is None or cache_seqlens is None:
                raise RuntimeError("inference-only attention: the no-cache path is not windowed")
            assert not self.training
            return self._inference_with_cache(qkv, key_cache, val_cache, cache_seqlens)

    return SlidingWindowVanillaAttention


def policy_class(worker):
    class PortKakunaPolicy(worker.KakunaPolicy):
        """The pinned worker's policy; only construction (device, attention) differs."""

        def __init__(self, checkpoint, device, attention_cls):
            import amago
            import gin
            import torch
            from metamon.rl.pretrained import Kakuna
            from amago.nets.transformer import SelfAttention
            worker.require(amago.__version__ == "3.4.0", "runtime")
            torch.set_num_threads(1)  # as the pinned worker
            self.model = Kakuna()

            def local_checkpoint(epoch):
                worker.require(epoch == 34, "provenance")
                gin.bind_parameter("MetamonAMAGOExperiment.traj_save_len", 10_000_000_000)
                gin.bind_parameter("traj_encoders.TformerTrajEncoder.attention_type", attention_cls)
                return str(checkpoint)

            self.model.get_path_to_checkpoint = local_checkpoint
            self.experiment = self.model.initialize_agent(checkpoint=34, log=False)
            worker.require(self.experiment.DEVICE.type == device, "runtime")
            self.policy = self.experiment.policy
            self.policy.eval()
            actor_forward = self.policy.actor.forward

            def capture(*args, **kwargs):
                self.last_dist = actor_forward(*args, **kwargs)
                return self.last_dist

            self.policy.actor.forward = capture
            layers = [m for m in self.policy.modules() if isinstance(m, SelfAttention)]
            worker.require(len(layers) == 10 and all(type(m) is attention_cls for m in layers), "runtime")

        def reset(self, seed):
            """Per (game, side) state exactly as the pinned __init__ leaves it (new process)."""
            import numpy as np
            import torch
            from metamon.rl.metamon_to_amago import make_placeholder_env
            torch.manual_seed(seed)
            np.random.seed(seed)
            self.seed = seed
            self.wrapper = make_placeholder_env(self.model.observation_space, self.model.action_space)
            self.model.observation_space.reset()
            self.hidden = self.policy.traj_encoder.init_hidden_state(1, self.experiment.DEVICE)
            self.previous_state = None
            self.previous_action = np.zeros((1, self.wrapper.action_size), dtype=self.wrapper.action_dtype)
            self.step = 0
            self.pending = None

    return PortKakunaPolicy


def recorded_choice(row):
    action = row["actionId"]
    if action.startswith("switch:"):
        return {"kind": "switch", "switchSlot": int(action.split(":")[1])}
    if action.startswith("move:"):
        slot, tera = action[5:].split("|tera=")
        return {"kind": "move", "moveSlot": int(slot), "terastallize": bool(int(tera))}
    raise ValueError(action)


def replay(args):
    setup(args.device)
    import psutil
    import torch
    worker = load_worker()
    import metamon.rl.pretrained  # noqa: F401  (worker order: before the decoder's GenData)
    metamon_path = metamon_from_source()
    if sha256(CKPT) != CKPT_SHA:
        raise RuntimeError("checkpoint hash mismatch")
    gpu = args.device == "cuda"
    if gpu and not torch.cuda.is_available():
        raise RuntimeError("torch.cuda.is_available() is False (HIP device not visible)")
    sync = torch.cuda.synchronize if gpu else (lambda: None)

    if args.attention == "window":
        attention_cls = window_attention_class(WINDOW)
    else:  # upstream full-causal VanillaAttention: diagnostic only, NOT production semantics
        from amago.nets.transformer import VanillaAttention
        attention_cls = VanillaAttention
    proc = psutil.Process()
    t0 = time.perf_counter()
    policy = policy_class(worker)(CKPT, args.device, attention_cls)
    sync()
    load_s = time.perf_counter() - t0
    mem_after_load = torch.cuda.memory_allocated() if gpu else None
    if gpu:
        torch.cuda.reset_peak_memory_stats()

    forward_ms = []
    get_actions = policy.policy.get_actions

    def timed_get_actions(*a, **k):
        sync()
        s = time.perf_counter()
        out = get_actions(*a, **k)
        sync()
        forward_ms.append((time.perf_counter() - s) * 1000)
        return out

    policy.policy.get_actions = timed_get_actions

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out_path.open("w", encoding="utf8") as out:
        for game in args.games:
            gdir = COHORT / game
            seed = json.loads((gdir / "metamon-launch.json").read_text())["workerSeed"]
            rows = [json.loads(l) for l in (gdir / "trajectory.jsonl").read_text().splitlines()]
            room = rows[0]["identity"]["roomId"]
            fmt = room.split("-")[1]
            for side in ("p1", "p2"):
                commits = {}
                for row in rows:
                    if row["side"] == side and row.get("accepted"):
                        if row["rqid"] in commits:
                            raise RuntimeError("multiple accepted commits for one request")
                        commits[row["rqid"]] = row
                decoder = worker.SocketlessBattle()
                policy.reset(worker.side_seed(seed, side))  # launch used --seed-per-side
                done = set()
                chunks = (gdir / f"{side}-private.jsonl").read_text(encoding="utf8").splitlines()
                for sequence, raw in enumerate(chunks, 1):
                    context = {"roomId": room, "side": side, "format": fmt, "sequence": sequence, "identity": None}
                    decoder.observe(json.loads(raw), context)
                    rqid = decoder.rqid
                    if rqid in done or rqid not in commits or decoder.terminal:
                        continue
                    done.add(rqid)
                    worker.require(not decoder.request.get("wait"), "identity")
                    if decoder.request.get("teamPreview"):
                        continue  # official random preview; no network call
                    choice = recorded_choice(commits[rqid])
                    step = policy.step
                    n_fwd = len(forward_ms)
                    s = time.perf_counter()
                    proposed = policy.propose(decoder.battle, decoder.request)
                    sync()
                    propose_ms = (time.perf_counter() - s) * 1000
                    worker.require(len(forward_ms) == n_fwd + 1, "runtime")
                    probs = policy.last_dist.probs[0, -1, -1].float().cpu()
                    legal = sorted({index for _, index in policy.pending[1]})
                    matches = sorted({i for c, i in policy.pending[1] if c == choice})
                    worker.require(bool(matches), "official_action")
                    _, forced = policy.pending_alias
                    if forced:
                        # Struggle/Recharge: indices alias one action. The recording keeps the
                        # structural choice only, so both devices commit the lowest alias.
                        policy.pending_alias = (matches[0], True)
                    index = policy.resolve_index(choice)
                    policy.commit(choice)
                    p = probs.tolist()
                    legal_p = [p[i] for i in legal]
                    out.write(json.dumps({
                        "game": game, "side": side, "rqid": rqid, "step": step, "sequence": sequence,
                        "probs": p, "legal": legal, "argmax": int(probs.argmax()),
                        "argmax_legal": legal[legal_p.index(max(legal_p))],
                        "finite": bool(torch.isfinite(probs).all()), "committed_index": index,
                        "recorded_choice": choice, "proposed_choice": proposed, "redrawn": bool(policy.redrawn),
                        "forced_alias": bool(forced), "propose_ms": propose_ms, "forward_ms": forward_ms[-1],
                    }) + "\n")
                    n += 1
                missing = set(commits) - done
                if missing:
                    raise RuntimeError(f"{game} {side}: unreplayed commits {sorted(missing)}")
    mem = proc.memory_info()
    summary = {
        "device": args.device, "attention": args.attention, "decisions": n, "games": args.games,
        "torch": torch.__version__, "hip": getattr(torch.version, "hip", None),
        "gpu_name": torch.cuda.get_device_name(0) if gpu else None,
        "gcn_arch": getattr(torch.cuda.get_device_properties(0), "gcnArchName", None) if gpu else None,
        "python": sys.version.split()[0], "pid": os.getpid(), "threads": torch.get_num_threads(),
        "metamon_module": metamon_path,
        "load_s": load_s, "first_propose_ms": None, "first_forward_ms": forward_ms[0] if forward_ms else None,
        "host_rss_mb": mem.rss / 2**20, "host_peak_wset_mb": getattr(mem, "peak_wset", 0) / 2**20,
        "gpu_alloc_after_load_mb": mem_after_load / 2**20 if gpu else None,
        "gpu_peak_alloc_mb": torch.cuda.max_memory_allocated() / 2**20 if gpu else None,
        "gpu_peak_reserved_mb": torch.cuda.max_memory_reserved() / 2**20 if gpu else None,
    }
    dump = [json.loads(l) for l in out_path.read_text(encoding="utf8").splitlines()]
    summary["first_propose_ms"] = dump[0]["propose_ms"] if dump else None
    summary.update(latency_stats(dump))
    # In-process unload: drop every reference and the caching allocator's pool.
    del policy, get_actions
    import gc
    gc.collect()
    if gpu:
        torch.cuda.synchronize()
        summary["gpu_alloc_after_del_mb"] = torch.cuda.memory_allocated() / 2**20
        # torch keeps the BLAS(Lt) handle workspaces in the caching allocator until cleared.
        torch._C._cuda_clearCublasWorkspaces()
        torch.cuda.empty_cache()
        summary["gpu_alloc_after_unload_mb"] = torch.cuda.memory_allocated() / 2**20
        summary["gpu_reserved_after_unload_mb"] = torch.cuda.memory_reserved() / 2**20
    Path(args.summary).write_text(json.dumps(summary, indent=2), encoding="utf8")
    print(json.dumps(summary, indent=2))


def pct(values, q):
    values = sorted(values)
    if not values:
        return None
    k = (len(values) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def latency_stats(dump):
    """Warmup = the first decision after model load; steady state = all later decisions."""
    rest = dump[1:]
    stats = {}
    for key in ("propose_ms", "forward_ms"):
        values = [d[key] for d in rest]
        stats[key] = {"n": len(values), "p50": pct(values, 0.5), "p95": pct(values, 0.95),
                      "max": max(values) if values else None,
                      "mean": statistics.fmean(values) if values else None}
    return stats


def runtime_check(args):
    """Pinned worker's own provenance check plus the HIP device facts."""
    setup("cuda")
    import torch
    worker = load_worker()
    worker.check_runtime(CKPT)  # checkpoint size/hash, VCS commit pins, METAMON_CACHE_DIR
    result = {"worker_check_runtime": "pass", "metamon_module": metamon_from_source(),
              "torch": torch.__version__, "hip": torch.version.hip,
              "cuda_available": torch.cuda.is_available(), "device_count": torch.cuda.device_count()}
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        result.update(name=props.name, gcn_arch=getattr(props, "gcnArchName", None),
                      total_memory_mb=props.total_memory / 2**20)
        a = torch.randn(512, 512)
        result["matmul_max_abs_diff_gpu_vs_cpu"] = float(((a.cuda() @ a.cuda()).cpu() - a @ a).abs().max())
        result["sdpa_backends"] = {k: getattr(torch.backends.cuda, k)() for k in
                                   ("flash_sdp_enabled", "mem_efficient_sdp_enabled", "math_sdp_enabled")}
    Path(args.summary).write_text(json.dumps(result, indent=2), encoding="utf8")
    print(json.dumps(result, indent=2))


def attn_check(args):
    """Eager window attention vs amago's own SlidingWindowFlexAttention (eager flex math path)."""
    setup("cuda")
    import torch
    from amago.nets.transformer import SlidingWindowFlexAttention, VanillaAttention
    torch.manual_seed(0)
    # amago's flex KV path calls create_block_mask without device=, i.e. torch's default
    # "cuda"; run where production runs it (HIP here) so mask indices share the device.
    dev = torch.device("cuda")
    mine = window_attention_class(WINDOW)(causal=True, dropout=0.0).eval()
    flex = SlidingWindowFlexAttention(causal=True, dropout=0.0, window_size=WINDOW).eval()
    full = VanillaAttention(causal=True, dropout=0.0).eval()
    H, E, MAX = 12, 75, 128  # Kakuna: 12 heads x 75 dims, max_seq_len 128
    report = []
    for s in (0, 1, 50, 95, 96, 97, 98, 120, 127):
        k = torch.randn(1, MAX, H, E, device=dev)
        v = torch.randn(1, MAX, H, E, device=dev)
        k[:, s + 1:] = torch.nan  # amago's NaN-filled unused cache slots
        v[:, s + 1:] = torch.nan
        qkv = torch.randn(1, 1, 3, H, E, device=dev)
        seqlens = torch.tensor([s], dtype=torch.int32, device=dev)
        with torch.no_grad():
            outs = [m(qkv, k.clone(), v.clone(), seqlens.clone()) for m in (mine, flex, full)]
        report.append({"cache_index": s, "visible_keys": min(s, WINDOW) + 1,
                       "max_abs_window_vs_flex": float((outs[0] - outs[1]).abs().max()),
                       "max_abs_full_vs_flex": float((outs[2] - outs[1]).abs().max())})
    ok = all(r["max_abs_window_vs_flex"] <= 1e-5 for r in report)
    result = {"torch": torch.__version__, "device": torch.cuda.get_device_name(0), "window": WINDOW,
              "pass": ok, "cases": report}
    Path(args.summary).write_text(json.dumps(result, indent=2), encoding="utf8")
    print(json.dumps(result, indent=2))
    if not ok:
        sys.exit(1)


def compare(args):
    ref = {(d["game"], d["side"], d["rqid"]): d for d in map(json.loads, Path(args.ref).read_text(encoding="utf8").splitlines())}
    cand = {(d["game"], d["side"], d["rqid"]): d for d in map(json.loads, Path(args.cand).read_text(encoding="utf8").splitlines())}
    if ref.keys() != cand.keys():
        raise SystemExit(f"decision sets differ: {len(ref.keys() ^ cand.keys())} unmatched")
    diffs, agree, nonfinite, legal_mismatch, worst = [], 0, 0, 0, None
    by_window = {"step<97": [], "step>=97": []}
    for key, r in ref.items():
        c = cand[key]
        finite = all(math.isfinite(x) for x in r["probs"] + c["probs"]) and r["finite"] and c["finite"]
        nonfinite += not finite
        legal_mismatch += r["legal"] != c["legal"] or r["committed_index"] != c["committed_index"]
        d = max(abs(a - b) for a, b in zip(r["probs"], c["probs"]))
        diffs.append(d)
        by_window["step>=97" if r["step"] >= 97 else "step<97"].append(d)
        agree += r["argmax"] == c["argmax"]
        if worst is None or d > worst[0]:
            worst = (d, key)
    n = len(diffs)
    result = {
        "ref": args.ref, "cand": args.cand, "decisions": n,
        "max_abs_dp": max(diffs), "p50_abs_dp": pct(diffs, 0.5), "p99_abs_dp": pct(diffs, 0.99),
        "worst_decision": list(worst[1]), "decisions_over_tol": sum(d > args.tol for d in diffs),
        "argmax_agree": agree, "argmax_agree_rate": agree / n,
        "nonfinite_decisions": nonfinite, "legal_or_commit_mismatch": legal_mismatch,
        "max_abs_dp_by_step": {k: {"n": len(v), "max": max(v) if v else None} for k, v in by_window.items()},
        "tol": args.tol,
    }
    result["pass"] = (n >= 100 and result["decisions_over_tol"] == 0 and result["argmax_agree_rate"] >= 0.999
                      and nonfinite == 0 and legal_mismatch == 0)
    Path(args.summary).write_text(json.dumps(result, indent=2), encoding="utf8")
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("runtime-check", "replay", "attn-check", "compare"))
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--attention", choices=("window", "full"), default="window")
    parser.add_argument("--games", nargs="+", default=GAMES)
    parser.add_argument("--out")
    parser.add_argument("--summary", required=True)
    parser.add_argument("--ref")
    parser.add_argument("--cand")
    parser.add_argument("--tol", type=float, default=1e-3)
    args = parser.parse_args()
    {"runtime-check": runtime_check, "replay": replay, "attn-check": attn_check, "compare": compare}[args.mode](args)


if __name__ == "__main__":
    main()
