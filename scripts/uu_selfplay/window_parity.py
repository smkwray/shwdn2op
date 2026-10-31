"""Kakuna numerics on the self-play construction path (ROCm/MPS/CPU, windowed attention).

The model is built exactly as serve_model builds it: UUKakuna().initialize_agent(...) with
the run's env (UU_BASE_GIN -> base-window.gin -> `import windowed_attention`). Recorded games
are replayed through the pinned scripts/metamon-worker.py (SocketlessBattle, propose,
resolve_index, commit; hash-checked, never edited) with the recorded actions committed, and
every decision's action distribution (last_dist.probs) is dumped for comparison.

  python window_parity.py replay --run RUN --device {cuda,mps,cpu} --cohort DIR --out X.jsonl --summary X.json
  python window_parity.py compare --ref A.jsonl --cand B.jsonl --summary C.json [--tol 1e-3]
Pass: >=100 decisions, max |dp| <= tol, argmax agreement >= 99.9%, no NaN/inf, identical legal
sets and committed indices.
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

K = Path(__file__).resolve().parent
WORKER = K.parents[1] / "scripts" / "metamon-worker.py"
WORKER_SHA = "917558eddf56e58dd1cd05332974df11d937549542fc4bc3674c8323d05ab5e9"
GAMES = ["drew-uu03-b-p2-s3", "alex-uu01-b-p1-s3", "avery-uu01-b-p2-s3"]


def pct(values, q):
    values = sorted(values)
    if not values:
        return None
    k = (len(values) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def recorded_choice(row):
    action = row["actionId"]
    if action.startswith("switch:"):
        return {"kind": "switch", "switchSlot": int(action.split(":")[1])}
    slot, tera = action[5:].split("|tera=")
    return {"kind": "move", "moveSlot": int(slot), "terastallize": bool(int(tera))}


def replay(a):
    run = a.run.resolve()
    cfg = json.loads((run / "env.json").read_text())
    os.environ.update(cfg)
    os.environ.pop("ACCELERATE_USE_CPU", None)
    if a.device == "cpu":
        os.environ["ACCELERATE_USE_CPU"] = "true"
    for entry in reversed(cfg["PYTHONPATH"].split(os.pathsep)):
        sys.path.insert(0, entry)

    def offline(event, args):  # Windows asyncio socketpair needs a loopback connect; nothing else.
        if event == "socket.connect" and isinstance(args[1], tuple) and args[1][0] in ("127.0.0.1", "::1"):
            return
        if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto"):
            raise RuntimeError("network is forbidden in the parity harness")
    sys.addaudithook(offline)

    import psutil
    import torch
    with open(WORKER, "rb") as f:
        if hashlib.file_digest(f, "sha256").hexdigest() != WORKER_SHA:
            raise SystemExit("pinned worker hash mismatch")
    spec = importlib.util.spec_from_file_location("pinned_metamon_worker", WORKER)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    from metamon.rl.pretrained import UUKakuna  # worker order: policy import before decoder GenData
    from amago.nets.transformer import SelfAttention
    sync = {"cuda": torch.cuda.synchronize, "mps": torch.mps.synchronize}.get(a.device, lambda: None)
    torch.set_num_threads(1)  # serve_model workers run with OMP_NUM_THREADS=1

    t0 = time.perf_counter()
    maker = UUKakuna()
    experiment = maker.initialize_agent(checkpoint=34, log=False, action_temperature=1.0)
    sync()
    load_s = time.perf_counter() - t0
    import windowed_attention
    if experiment.DEVICE.type != a.device:
        raise SystemExit(f"experiment device {experiment.DEVICE} != {a.device}")
    layers = [m for m in experiment.policy.modules() if isinstance(m, SelfAttention)]
    if not (len(layers) == 10 and all(type(m) is windowed_attention.SlidingWindowVanillaAttention
                                      and m.window_size == 96 for m in layers)):
        raise SystemExit("attention layers are not the gin-bound window-96 class")

    policy = worker.KakunaPolicy.__new__(worker.KakunaPolicy)  # pinned propose/commit, self-play model
    policy.model, policy.experiment, policy.policy = maker, experiment, experiment.policy
    policy.policy.eval()
    actor_forward = policy.policy.actor.forward

    def capture(*args, **kwargs):
        policy.last_dist = actor_forward(*args, **kwargs)
        return policy.last_dist
    policy.policy.actor.forward = capture
    forward_ms, get_actions = [], policy.policy.get_actions

    def timed(*args, **kwargs):
        sync()
        s = time.perf_counter()
        out = get_actions(*args, **kwargs)
        sync()
        forward_ms.append((time.perf_counter() - s) * 1000)
        return out
    policy.policy.get_actions = timed

    def reset(seed):
        import numpy as np
        from metamon.rl.metamon_to_amago import make_placeholder_env
        torch.manual_seed(seed)
        np.random.seed(seed)
        policy.seed = seed
        policy.wrapper = make_placeholder_env(maker.observation_space, maker.action_space)
        maker.observation_space.reset()
        policy.hidden = policy.policy.traj_encoder.init_hidden_state(1, experiment.DEVICE)
        policy.previous_state = None
        policy.previous_action = np.zeros((1, policy.wrapper.action_size), dtype=policy.wrapper.action_dtype)
        policy.step, policy.pending = 0, None

    dump = []
    for game in a.games:
        gdir = a.cohort / game
        seed = json.loads((gdir / "metamon-launch.json").read_text())["workerSeed"]
        rows = [json.loads(l) for l in (gdir / "trajectory.jsonl").read_text().splitlines()]
        room = rows[0]["identity"]["roomId"]
        for side in ("p1", "p2"):
            commits = {r["rqid"]: r for r in rows if r["side"] == side and r.get("accepted")}
            decoder = worker.SocketlessBattle()
            reset(worker.side_seed(seed, side))
            done = set()
            chunks = (gdir / f"{side}-private.jsonl").read_text(encoding="utf8").splitlines()
            for sequence, raw in enumerate(chunks, 1):
                decoder.observe(json.loads(raw), {"roomId": room, "side": side, "format": room.split("-")[1],
                                                  "sequence": sequence, "identity": None})
                rqid = decoder.rqid
                if rqid in done or rqid not in commits or decoder.terminal:
                    continue
                done.add(rqid)
                if decoder.request.get("teamPreview"):
                    continue
                choice, step = recorded_choice(commits[rqid]), policy.step
                s = time.perf_counter()
                proposed = policy.propose(decoder.battle, decoder.request)
                sync()
                propose_ms = (time.perf_counter() - s) * 1000
                probs = policy.last_dist.probs[0, -1, -1].float().cpu()
                legal = sorted({i for _, i in policy.pending[1]})
                matches = sorted({i for c, i in policy.pending[1] if c == choice})
                if policy.pending_alias[1]:
                    policy.pending_alias = (matches[0], True)  # Struggle/Recharge: lowest alias on every device
                index = policy.resolve_index(choice)
                policy.commit(choice)
                p = probs.tolist()
                lp = [p[i] for i in legal]
                dump.append({"game": game, "side": side, "rqid": rqid, "step": step, "sequence": sequence,
                             "probs": p, "legal": legal, "argmax": int(probs.argmax()),
                             "argmax_legal": legal[lp.index(max(lp))], "finite": bool(torch.isfinite(probs).all()),
                             "committed_index": index, "recorded_choice": choice, "proposed_choice": proposed,
                             "redrawn": bool(policy.redrawn), "forced_alias": bool(policy.pending_alias[1]),
                             "propose_ms": propose_ms, "forward_ms": forward_ms[-1]})
            if set(commits) - done:
                raise SystemExit(f"{game} {side}: unreplayed commits")
    a.out.write_text("".join(json.dumps(d) + "\n" for d in dump), encoding="utf8")
    rest = dump[1:]  # first decision after load = warmup
    mem = psutil.Process().memory_info()
    summary = {"device": a.device, "experiment_device": str(experiment.DEVICE), "decisions": len(dump),
               "torch": torch.__version__, "construction": "UUKakuna().initialize_agent via UU_BASE_GIN",
               "base_gin": cfg["UU_BASE_GIN"], "attention": "windowed_attention.SlidingWindowVanillaAttention(96) x10",
               "load_s": round(load_s, 2), "first_forward_ms": forward_ms[0] if forward_ms else None,
               "forward_ms": {"p50": pct([d["forward_ms"] for d in rest], 0.5), "p95": pct([d["forward_ms"] for d in rest], 0.95)},
               "propose_ms": {"p50": pct([d["propose_ms"] for d in rest], 0.5), "p95": pct([d["propose_ms"] for d in rest], 0.95),
                              "mean": statistics.fmean(d["propose_ms"] for d in rest) if rest else None},
               "host_rss_mb": round(mem.rss / 2**20, 1)}
    if a.device == "cuda":
        summary.update(gpu=torch.cuda.get_device_name(0), gpu_peak_alloc_mb=round(torch.cuda.max_memory_allocated() / 2**20, 1))
    if a.device == "mps":
        summary.update(mps_driver_allocated_mb=round(torch.mps.driver_allocated_memory() / 2**20, 1))
    a.summary.write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    return 0


def compare(a):
    load = lambda p: {(d["game"], d["side"], d["rqid"]): d for d in map(json.loads, p.read_text(encoding="utf8").splitlines())}
    ref, cand = load(a.ref), load(a.cand)
    if ref.keys() != cand.keys():
        raise SystemExit(f"decision sets differ: {len(ref.keys() ^ cand.keys())} unmatched")
    diffs, agree, nonfinite, mismatch, late = [], 0, 0, 0, []
    for key, r in ref.items():
        c = cand[key]
        nonfinite += not (r["finite"] and c["finite"] and all(math.isfinite(x) for x in r["probs"] + c["probs"]))
        mismatch += r["legal"] != c["legal"] or r["committed_index"] != c["committed_index"]
        d = max(abs(x - y) for x, y in zip(r["probs"], c["probs"]))
        diffs.append(d)
        if r["step"] >= 97:
            late.append(d)
        agree += r["argmax"] == c["argmax"]
    n = len(diffs)
    out = {"ref": str(a.ref), "cand": str(a.cand), "decisions": n, "max_abs_dp": max(diffs),
           "p50_abs_dp": pct(diffs, 0.5), "p99_abs_dp": pct(diffs, 0.99), "decisions_over_tol": sum(d > a.tol for d in diffs),
           "argmax_agree": agree, "argmax_agree_rate": agree / n, "nonfinite_decisions": nonfinite,
           "legal_or_commit_mismatch": mismatch, "window_active_decisions": len(late),
           "window_active_max_abs_dp": max(late) if late else None, "tol": a.tol}
    out["pass"] = n >= 100 and out["decisions_over_tol"] == 0 and out["argmax_agree_rate"] >= 0.999 \
        and nonfinite == 0 and mismatch == 0
    a.summary.write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    return 0 if out["pass"] else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=("replay", "compare"))
    ap.add_argument("--run", type=Path)
    ap.add_argument("--device", choices=("cuda", "mps", "cpu"))
    ap.add_argument("--cohort", type=Path)
    ap.add_argument("--games", nargs="+", default=GAMES)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--ref", type=Path)
    ap.add_argument("--cand", type=Path)
    ap.add_argument("--summary", type=Path, required=True)
    ap.add_argument("--tol", type=float, default=1e-3)
    a = ap.parse_args()
    return replay(a) if a.mode == "replay" else compare(a)


if __name__ == "__main__":
    raise SystemExit(main())
