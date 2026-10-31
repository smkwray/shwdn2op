#!/usr/bin/env python3
"""Sequential replay proof: composite, exported, rpc, compare.

Use training env.sh for composite, production PYTHONPATH for exported/rpc.
No battle server or network is used. Recorded commits drive every trajectory.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import select
import signal
import subprocess
import sys

from candidate_worker import WORKER_SHA, install, worker_module
from export_candidate import digest, registry_load

GAMES = ["drew-uu03-b-p2-s3", "alex-uu01-b-p1-s3", "avery-uu01-b-p2-s3"]


def read(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def choice(row):
    action = row["actionId"]
    if action.startswith("team:"):
        return {"kind": "team", "team": [int(c) for c in action[5:]]}
    if action.startswith("switch:"):
        return {"kind": "switch", "switchSlot": int(action.split(":")[1])}
    slot, tera = action[5:].split("|tera=")
    return {"kind": "move", "moveSlot": int(slot), "terastallize": bool(int(tera))}


def reset(policy, seed):
    import numpy as np
    import torch
    from metamon.rl.metamon_to_amago import make_placeholder_env
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    policy.seed = seed
    policy.wrapper = make_placeholder_env(policy.model.observation_space, policy.model.action_space)
    policy.model.observation_space.reset()
    policy.hidden = policy.policy.traj_encoder.init_hidden_state(1, policy.experiment.DEVICE)
    policy.previous_state = None
    policy.previous_action = np.zeros((1, policy.wrapper.action_size), dtype=policy.wrapper.action_dtype)
    policy.step, policy.pending = 0, None


def replay(a):
    import torch
    torch.set_num_threads(1)
    worker = worker_module()
    # Import registry before decoder (upstream GenData initialization ordering).
    import metamon.rl.pretrained
    if a.mode == "composite":
        maker, exp = registry_load(a.checkpoint, a.epoch, a.out.parent / "composite-load")
        policy = worker.KakunaPolicy.__new__(worker.KakunaPolicy)
        policy.model, policy.experiment, policy.policy = maker, exp, exp.policy
        actor = policy.policy.actor.forward

        def capture(*args, **kwargs):
            policy.last_dist = actor(*args, **kwargs)
            return policy.last_dist

        policy.policy.actor.forward = capture
    else:
        install(worker, a.checkpoint, a.checkpoint_sha256, a.base_checkpoint, a.policy_id)
        worker.check_runtime(a.checkpoint)
        policy = worker.KakunaPolicy(a.checkpoint, 0, "flex")
    from amago.nets.transformer import SelfAttention, SlidingWindowFlexAttention
    import gin
    # Composite also holds frozen EMA/base encoders; prove the MAIN encoder.
    layers = [m for m in policy.policy.traj_encoder.modules() if isinstance(m, SelfAttention)]
    if not (len(layers) == 10 and all(type(m) is SlidingWindowFlexAttention for m in layers)
            and gin.query_parameter("transformer.SlidingWindowFlexAttention.window_size") == 96):
        raise ValueError("Require exactly the production flex window-96 attention")
    if policy.experiment.DEVICE.type != "cuda":
        raise ValueError("Require CUDA production execution")
    policy.policy.eval()
    # Capture the ACTUAL tensors passed by the pinned propose() to get_actions().
    get_actions = policy.policy.get_actions

    def inputs(**kw):
        h = hashlib.sha256()
        for name, tensor in sorted({**kw["obs"], "_rl2": kw["rl2s"], "_time": kw["time_idxs"]}.items()):
            v = tensor.detach().cpu().numpy()
            h.update(json.dumps([name, v.shape, v.dtype.str]).encode())
            h.update(v.tobytes())
        policy.input_sha256 = h.hexdigest()
        return get_actions(**kw)

    policy.policy.get_actions = inputs
    records, files = [], {}
    for game in a.games:
        g = a.cohort / game
        rows = read(g / "trajectory.jsonl")
        launch = json.loads((g / "metamon-launch.json").read_text())
        for name in ["trajectory.jsonl", "metamon-launch.json", *[s + "-private.jsonl" for s in a.sides]]:
            files[str(g / name)] = digest(g / name)
        for side in a.sides:
            commits = {r["rqid"]: r for r in rows if r["side"] == side and r.get("accepted")}
            reset(policy, worker.side_seed(launch["workerSeed"], side))
            decoder, done = worker.SocketlessBattle(), set()
            for sequence, data in enumerate(read(g / f"{side}-private.jsonl"), 1):
                decoder.observe(data, {"roomId": "battle-gen9uu-offline", "side": side, "format": "gen9uu",
                                       "sequence": sequence, "identity": None})
                rqid = decoder.rqid
                if rqid in done or rqid not in commits or decoder.terminal:
                    continue
                done.add(rqid)
                if decoder.request.get("teamPreview"):
                    continue
                recorded = choice(commits[rqid])
                proposed = policy.propose(decoder.battle, decoder.request)
                probs = policy.last_dist.probs[0, -1, -1].float().cpu()
                index = policy.resolve_index(recorded)
                record = {"game": game, "side": side, "rqid": rqid, "step": policy.step - 1,
                          "sequence": sequence, "input_sha256": policy.input_sha256,
                          "probs": probs.tolist(), "argmax": int(probs.argmax()),
                          "legal": sorted({i for _, i in policy.pending[1]}), "committed_index": index,
                          "recorded_choice": recorded, "proposed_choice": proposed}
                policy.commit(recorded)
                records.append(record)
            if set(commits) != done:
                raise ValueError("Not all recorded commits were replayed")
        print(f"{a.mode}: {game}: {len(records)} decisions", flush=True)
    a.out.write_text("".join(json.dumps(r, allow_nan=False) + "\n" for r in records))
    summary = {"mode": a.mode, "decisions": len(records), "games": a.games,
               "checkpoint_sha256": digest(a.checkpoint), "worker_sha256": WORKER_SHA,
               "torch": torch.__version__, "mixed_precision": policy.experiment.mixed_precision,
               "attention": "SlidingWindowFlexAttention(96) x10", "inputs": files,
               "device": str(policy.experiment.DEVICE), "pid": os.getpid(),
               "peak_cuda_bytes": torch.cuda.max_memory_allocated()}
    a.out.with_suffix(".summary.json").write_text(json.dumps(summary, indent=2) + "\n")


def rpc(a):
    """Model-free supervisor; only one child owns a model/GPU at a time."""
    output = []
    for game in a.games:
        g = a.cohort / game
        launch = json.loads((g / "metamon-launch.json").read_text())
        for side in a.sides:
            stem = a.out.parent / f"rpc-{game}-{side}"
            trace = stem.with_suffix(".trace.jsonl")
            command = [sys.executable, "-B", "-u", str(Path(__file__).with_name("candidate_worker.py")),
                       "--checkpoint", str(a.checkpoint), "--checkpoint-sha256", a.checkpoint_sha256,
                       "--base-checkpoint", str(a.base_checkpoint), "--policy-id", a.policy_id,
                       "--probability-trace", str(trace), "--attention-backend", "flex",
                       "--seed", str(launch["workerSeed"]), "--seed-per-side"]
            rows = read(g / "trajectory.jsonl")
            commits = {r["rqid"]: r for r in rows if r["side"] == side and r.get("accepted")}
            calls, serial = [], 0
            with stem.with_suffix(".stderr.log").open("w") as err:
                proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=err, text=True, start_new_session=True)
                def call(message):
                    nonlocal serial
                    serial += 1
                    request = {"version": "metamon-worker@2", "id": serial, **message}
                    proc.stdin.write(json.dumps(request) + "\n")
                    proc.stdin.flush()
                    if not select.select([proc.stdout], [], [], 180)[0]:
                        raise TimeoutError("Worker RPC timed out")
                    line = proc.stdout.readline()
                    if not line:
                        raise RuntimeError(f"Worker exited: see {stem}.stderr.log")
                    response = json.loads(line)
                    calls.append({"request": request, "response": response})
                    if response.get("id") != serial or not response.get("ok"):
                        raise ValueError(response)
                    return response
                completed = []
                try:
                    rqid, done = 0, set()
                    for seq, data in enumerate(read(g / f"{side}-private.jsonl"), 1):
                        terminal = any(l.startswith(("|win|", "|tie|")) for l in data.splitlines())
                        for line in data.splitlines():
                            if line.startswith("|request|"):
                                rqid = json.loads(line[9:])["rqid"]
                        row = commits.get(rqid)
                        context = {"roomId": "battle-gen9uu-offline", "side": side, "format": "gen9uu",
                                   "sequence": seq, "identity": row["identity"] if row else None}
                        call({"op": "observe", "data": data, "context": context})
                        if row is None or rqid in done or terminal:
                            continue
                        binding = {"requestId": row["requestId"], "identity": row["identity"],
                                   "resultHash": row["inputResultHash"], "sequence": seq}
                        proposed = call({"op": "propose", **binding})
                        call({"op": "commit", **binding, "choice": choice(row)})
                        done.add(rqid)
                        if row["identity"]["requestKind"] != "team_preview":
                            completed.append({"game": game, "side": side, "rqid": rqid,
                                              "sequence": seq, "rpc_proposed_choice": proposed["choice"]})
                    if done != set(commits):
                        raise ValueError("Incomplete RPC recording")
                    proc.stdin.close()  # Only after final reply, per full-duplex contract.
                    if proc.wait(timeout=30):
                        raise RuntimeError("Worker did not exit cleanly")
                finally:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)  # Only this isolated worker/compiler group.
                    except ProcessLookupError:
                        pass
                    proc.wait()
                    stem.with_suffix(".wire.jsonl").write_text("".join(json.dumps(c) + "\n" for c in calls))
                    stem.with_suffix(".process.json").write_text(json.dumps({"argv": command, "pid": proc.pid,
                        "returncode": proc.returncode, "reaped": proc.returncode is not None,
                        "private_process_group_cleanup": True}, indent=2) + "\n")
            observations = read(trace)
            if len(observations) != len(completed):
                raise ValueError("RPC trace count mismatch")
            for meta, observed in zip(completed, observations):
                if meta["rpc_proposed_choice"] != observed["proposed_choice"]:
                    raise ValueError("Trace and JSON protocol proposal differ")
                output.append({**meta, **observed})
    a.out.write_text("".join(json.dumps(r) + "\n" for r in output))
    print(json.dumps({"rpc_decisions": len(output), "games": a.games, "sides": a.sides}))


def compare(a):
    ref, cand = read(a.ref), read(a.cand)
    key = lambda r: (r["game"], r["side"], r["rqid"])
    reference = {key(r): r for r in ref}
    if len(reference) != len(ref) or len({key(r) for r in cand}) != len(cand):
        raise ValueError("Duplicate replay decisions")
    if a.rpc_subset:
        ref = [reference[key(r)] for r in cand]
    if [key(r) for r in ref] != [key(r) for r in cand]:
        raise ValueError("Replay coverage/order differs")
    if len(cand) < a.min_decisions or len({r["game"] for r in cand}) < a.min_games:
        raise ValueError("Insufficient decision/game coverage")
    differences, agrees = [], 0
    for x, y in zip(ref, cand):
        for field in ("step", "sequence", "legal", "committed_index", "recorded_choice"):
            if x[field] != y[field]:
                raise ValueError(f"{key(x)}: {field} mismatch")
        if not a.rpc_subset and x["input_sha256"] != y["input_sha256"]:
            raise ValueError("Actual inference inputs differ")
        for row in (x, y):
            p = row["probs"]
            if len(p) != 13 or not all(math.isfinite(v) and v >= 0 for v in p) or abs(sum(p) - 1) > 1e-5:
                raise ValueError("Invalid probability vector")
            if row["argmax"] != max(range(13), key=p.__getitem__):
                raise ValueError("Invalid argmax")
        differences.append(max(abs(p - q) for p, q in zip(x["probs"], y["probs"])))
        agrees += x["argmax"] == y["argmax"]
    result = {"reference": str(a.ref), "candidate": str(a.cand), "decisions": len(cand),
              "games": sorted({r["game"] for r in cand}), "max_abs_dp": max(differences),
              "argmax_agree": agrees, "argmax_agree_rate": agrees / len(cand),
              "proposed_choice_agree": sum(x["proposed_choice"] == y["proposed_choice"] for x, y in zip(ref, cand)),
              "tolerance": 1e-5, "pass": max(differences) <= 1e-5 and agrees == len(cand)}
    a.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if not result["pass"]:
        raise ValueError("Candidate parity failed")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("mode", choices=("composite", "exported", "rpc", "compare"))
    p.add_argument("--checkpoint", type=Path)
    p.add_argument("--checkpoint-sha256")
    p.add_argument("--base-checkpoint", type=Path)
    p.add_argument("--epoch", type=int, default=0)
    p.add_argument("--policy-id", default="metamon:UUFinetuned:uu_smoke:0")
    p.add_argument("--cohort", type=Path)
    p.add_argument("--games", nargs="+", default=GAMES)
    p.add_argument("--sides", nargs="+", default=["p1", "p2"], choices=("p1", "p2"))
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--ref", type=Path)
    p.add_argument("--cand", type=Path)
    p.add_argument("--rpc-subset", action="store_true")
    p.add_argument("--min-decisions", type=int, default=100)
    p.add_argument("--min-games", type=int, default=3)
    a = p.parse_args()
    if a.out.exists():
        raise ValueError("Refusing to overwrite evidence")
    a.out.parent.mkdir(parents=True, exist_ok=True)
    if a.mode == "compare":
        compare(a)
    elif a.mode == "rpc":
        rpc(a)
    else:
        replay(a)


if __name__ == "__main__":
    main()
