"""Supervise one shared policy and one concurrent official-simulator collector.

Experimental G0 throughput pilot. Invoke through gpu_job.py and remrun; no
generation or training data is accepted before real-worker parity passes.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import secrets
import sys
import time
import zipfile
from candidate_worker import policy_members
from progress_eval import slots, validate_censored_drain


def read_shard_statistics(path, previous):
    """A concurrent metadata rewrite cannot abort an otherwise healthy battle."""
    try:
        value=json.loads(path.read_text())
    except (FileNotFoundError, PermissionError, json.JSONDecodeError) as error:
        return previous, type(error).__name__
    required=('startedGames','completed','failed','censored')
    if not isinstance(value,dict) or any(type(value.get(k)) is not int or value[k]<0 for k in required):
        raise ValueError('Malformed shard statistics counts')
    return value, None


def validate_collection_slots(rows, families, models):
    """Explicit collection uses the paired runner's slot shape, without its analysis arms."""
    if not isinstance(rows, list) or not rows:
        raise ValueError("Nonempty explicit collection slots required")
    reserved = {"CON", "PRN", "AUX", "NUL", *[f"{p}{i}" for p in ("COM", "LPT") for i in range(1, 10)]}
    seen = set()
    for row in rows:
        if not isinstance(row, dict):raise ValueError("Malformed collection slot")
        ident = row.get("id")
        if (not isinstance(ident, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,96}", ident) is None
                or ident.upper() in reserved or ident in seen):
            raise ValueError("Unsafe or duplicate collection slot ID")
        seen.add(ident)
        if type(row.get("policySeed")) is not int or not 0 <= row["policySeed"] < 2**32:
            raise ValueError("Collection policySeed must be an unsigned 32-bit integer")
        for key, allowed in (("families", families), ("models", models)):
            value = row.get(key)
            if (not isinstance(value, dict) or set(value) != {"p1", "p2"}
                    or any(not isinstance(v, str) or v not in allowed for v in value.values())):
                raise ValueError("Unknown or malformed collection " + key)
        if row["families"]["p1"] == row["families"]["p2"]:
            raise ValueError("Self roster match")
    return rows  # Preserve declared split/opponentGroup and other prospective metadata.


def freeze_runtime(runtime,dependencies):
    """Retain the same worker/simulator implementation for every queued attempt."""
    root = Path(__file__).resolve().parents[2]
    runtime.mkdir()
    for relative in ("apps/companion/src","apps/extension/lib","packages"):
        shutil.copytree(root/relative,runtime/relative,ignore=shutil.ignore_patterns(".syncthing.*","__pycache__","node_modules"))
    for relative in ("package.json","package-lock.json","scripts/uu_selfplay/batch_collect.py",
                     "scripts/uu_selfplay/collection_sweep.py","scripts/uu_selfplay/gpu_job.py",
                     "scripts/uu_selfplay/batch_parity.py","scripts/uu_selfplay/freeze_pile.py","scripts/metamon-worker.py","vendor/metamon/assemble.py",
                     "scripts/uu_selfplay/batch_collect.mts","scripts/uu_selfplay/batch_client.py",
                     "scripts/uu_selfplay/candidate_seat.ts","scripts/uu_selfplay/candidate_worker.py",
                     "scripts/uu_selfplay/export_candidate.py","scripts/uu_selfplay/source-pins.json",
                     "scripts/uu_selfplay/progress_eval.py","scripts/uu_eval/analyze.py","scripts/uu_eval/spec.py","scripts/uu_eval/verify_native.ts",
                     "scripts/uu_selfplay/batch_server.py","scripts/uu_selfplay/batched_inference.py",
                     "scripts/uu_selfplay/ensemble_policy.py","scripts/uu_eval/ensemble.py",
                     "scripts/uu_selfplay/soft_policy.py",
                     "scripts/uu_selfplay/filter_families.py",
                     "scripts/metamon_port/action_probs.py",
                     "scripts/metamon_port/lead_model.py",
                     "scripts/metamon_port/common.py","scripts/metamon_port/torch_backend.py",
                     "scripts/metamon_port/mlx_kakuna.py","scripts/uu_selfplay/native_mlx_backbone.py"):
        target = runtime/relative;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(root/relative,target)
    if os.name=='nt':
        subprocess.run(['node','-e',"require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                        str(dependencies),str(runtime/'node_modules')],check=True)
    else:(runtime/"node_modules").symlink_to(dependencies,target_is_directory=True)


def retain_producer(out,runtime,extra=()):
    sources = list(extra)+sorted(p for p in runtime.rglob("*") if p.is_file() and "node_modules" not in p.parts)
    with zipfile.ZipFile(out/"producer.zip","x") as z:
        for f in sources:z.write(f,str(f.relative_to(Path.cwd())))
    (out/"producer.json").write_text(json.dumps({str(f.relative_to(Path.cwd())):hashlib.sha256(f.read_bytes()).hexdigest() for f in sources},indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--checkpoint",required=True,type=Path)
    p.add_argument("--panel",required=True,type=Path)
    p.add_argument("--pool",required=True,type=Path)
    p.add_argument("--concurrency",type=int,default=8)
    p.add_argument("--simulator-workers",type=int,default=1)
    p.add_argument("--games",type=int,default=100)
    p.add_argument("--seed",type=int,default=20261025)
    p.add_argument("--backend",choices=["torch-cuda-flex","torch-cuda-sdpa","torch-cpu","mlx-backbone"],default="torch-cuda-flex")
    p.add_argument("--mlx-configs",type=Path)
    p.add_argument("--source",type=Path)
    p.add_argument("--node-modules",type=Path,default=Path("node_modules"))
    p.add_argument("--policies",type=Path)
    p.add_argument("--focal")
    p.add_argument("--baseline",default="G0",help="progress comparator; independent of training opponents")
    p.add_argument("--opponents",nargs="+")
    p.add_argument("--temperatures",nargs="+",type=float,default=[1.])
    p.add_argument("--purpose",choices=["selfplay","progress"],default="selfplay")
    p.add_argument("--collection-slots",type=Path,help="Explicit self-play slot IDs/families/models/policySeed")
    p.add_argument("--progress-repetitions",type=int,default=1)
    p.add_argument("--cleanup-deadline-ms",type=int)
    p.add_argument("--match-timeout-ms",type=int,default=1200000)
    p.add_argument("--progress-censor-max-fraction",type=float)
    p.add_argument("--lead-checkpoint",type=Path)
    p.add_argument("--lead-sha256")
    p.add_argument("--retain-all-traces",action="store_true")
    p.add_argument("--analysis-mode",choices=["policy-only"])
    a = p.parse_args()
    if (a.backend == "mlx-backbone") != bool(a.mlx_configs):raise ValueError("Explicit MLX configuration required")
    collection_slots = None
    collection_bytes = None
    if a.collection_slots:
        if a.purpose != "selfplay":raise ValueError("Collection slots are selfplay-only")
        collection_bytes = a.collection_slots.read_bytes()
        collection_slots = json.loads(collection_bytes)
        if not isinstance(collection_slots, list) or not collection_slots:
            raise ValueError("Nonempty explicit collection slots required")
        a.games = len(collection_slots)
    if a.progress_censor_max_fraction is not None and (a.purpose!="progress" or not a.retain_all_traces
            or not math.isfinite(a.progress_censor_max_fraction) or not 0<=a.progress_censor_max_fraction<=.02):
        raise ValueError("Progress-only censoring needs all traces and a maximum fraction at most .02")
    if not 1<=a.match_timeout_ms<=86400000:raise ValueError("Match timeout must be within one day")
    if a.cleanup_deadline_ms is not None and not 1<=a.cleanup_deadline_ms<=300000:raise ValueError("Bounded cleanup deadline required")
    if bool(a.lead_checkpoint)!=bool(a.lead_sha256):raise ValueError("Explicit lead path/hash binding required")
    if a.lead_checkpoint and hashlib.sha256(a.lead_checkpoint.read_bytes()).hexdigest()!=a.lead_sha256:raise ValueError("Lead weight drift")
    total_concurrency = a.concurrency*a.simulator_workers
    if not 1<=a.simulator_workers<=4 or not 1<=total_concurrency<=64 or a.games<total_concurrency:
        raise ValueError("Use 1..4 simulator workers, at most 64 games in flight, at least one game per slot")
    members = policy_members(a.policies,a.checkpoint)
    names = [m["name"] for m in members]
    if a.policies and not a.focal:raise ValueError("Explicit focal policy required for a declared league")
    focal = a.focal or "G0"
    opponents = a.opponents or names
    if focal not in names or any(n not in names for n in opponents):raise ValueError("Unknown league policy")
    if any(not math.isfinite(t) or t<=0 for t in a.temperatures):raise ValueError("Positive finite temperatures required")
    if any(m.get("kind")=="ensemble" or m.get("sampler")=="e3_common" for m in members) and a.temperatures!=[1.]:
        raise ValueError("Fixed E3 and its common-draw controls require temperature 1")
    progress_slots = None
    if a.purpose=="progress":
        if a.baseline not in names or a.baseline==focal or a.temperatures!=[1.]:
            raise ValueError("Progress requires a distinct declared baseline and temperature 1")
        progress_slots = slots(json.loads(a.panel.read_text()),focal,a.baseline,a.seed,a.progress_repetitions)
        a.games = len(progress_slots)
    if collection_slots is not None:
        validate_collection_slots(collection_slots,
            {r["family"] for r in json.loads(a.panel.read_bytes())["collection"]}, set(names))
    out = a.out.resolve();out.mkdir(parents=True,exist_ok=False)
    panel_bytes = a.panel.read_bytes()
    pool_bytes = (a.pool/"manifest.json").read_bytes()
    if json.loads(panel_bytes)["poolManifestSha256"]!=hashlib.sha256(pool_bytes).hexdigest():
        raise ValueError("Public pool manifest drift")
    (out/"panel.json").write_bytes(panel_bytes)
    (out/"pool-manifest.json").write_bytes(pool_bytes)
    kit = Path(__file__).resolve().parent
    dependencies = a.node_modules.resolve()
    if not (dependencies/"tsx/package.json").is_file():
        raise FileNotFoundError("Explicit installed Node dependencies must include tsx")
    runtime = out/"runtime"
    freeze_runtime(runtime,dependencies)
    # Short local socket name: Unix domain paths are limited to 108 bytes.
    socket = ('tcp://'+secrets.token_hex(32)+'@127.0.0.1:0') if os.name=='nt' else str(Path('/tmp')/('uu-batch-'+hashlib.sha256(str(out).encode()).hexdigest()[:16]+'.sock'))
    retained = [Path(__file__).resolve(),out/"panel.json",out/"pool-manifest.json"]
    if collection_bytes is not None:
        (out/"collection-slots.json").write_bytes(collection_bytes)
        retained.append(out/"collection-slots.json")
    retain_producer(out,runtime,retained)
    job = {"out":str(out),"pool":str(a.pool.resolve()),"panel":str(out/"panel.json"),
           "socket":str(socket),"python":sys.executable,"concurrency":a.concurrency,"games":a.games,
           "seed":a.seed,"simulatorWorkers":a.simulator_workers,"policies":members,
           "focal":focal,"opponents":opponents,"temperatures":a.temperatures,
           "baseline":a.baseline,
           "purpose":a.purpose,"progressSlots":progress_slots}
    if collection_slots is not None:
        job.update(collectionSlots=collection_slots,
                   collectionSlotsSha256=hashlib.sha256(collection_bytes).hexdigest())
    job["matchTimeoutMs"] = a.match_timeout_ms
    if a.progress_censor_max_fraction is not None:
        job["progressCensoring"] = {"schema":"uu-progress-censoring@1","maxFraction":a.progress_censor_max_fraction}
    if a.retain_all_traces:job["retainAllTraces"]=True
    if a.analysis_mode:job["analysisMode"]=a.analysis_mode
    if a.cleanup_deadline_ms is not None:job["cleanupDeadlineMs"]=a.cleanup_deadline_ms
    if a.lead_checkpoint:job.update(leadCheckpoint=str(a.lead_checkpoint.resolve()),leadSha256=a.lead_sha256)
    (out/"job.json").write_text(json.dumps(job,indent=2))
    (out/"policies.json").write_text(json.dumps(members,indent=2))
    if a.mlx_configs:
        (out/"mlx-configs.json").write_bytes(a.mlx_configs.read_bytes())
    kit = runtime/"scripts/uu_selfplay"
    log = (out/"server.log").open("x")
    server = subprocess.Popen([sys.executable,str(kit/"batch_server.py"),"--checkpoint",str(a.checkpoint),
        "--out",str(out/"server"),"--socket",str(socket),"--max-sessions",str(total_concurrency*2),
        "--max-batch",str(min(64,total_concurrency*2)),"--backend",a.backend,
        "--policies",str(out/"policies.json"),
        *(["--mlx-configs",str(out/"mlx-configs.json")] if a.mlx_configs else []),
        "--purpose",a.purpose,
        *(["--lead-checkpoint",str(a.lead_checkpoint.resolve()),"--lead-sha256",a.lead_sha256] if a.lead_checkpoint else []),
        *(["--source",str(a.source)] if a.source is not None else [])],stdout=log,stderr=subprocess.STDOUT)
    processes, logs, shards = [], [], []
    started = time.monotonic()
    try:
        deadline = time.monotonic()+300
        while not (out/"server/ready.json").exists():
            if server.poll() is not None:
                raise RuntimeError(f"Shared worker exited {server.returncode}; see server.log")
            if time.monotonic()>deadline:raise TimeoutError("Shared worker startup")
            time.sleep(.5)
        job['socket']=json.loads((out/'server/ready.json').read_bytes())['socket']
        offset = 0
        for index in range(a.simulator_workers):
            directory = out/f"worker-{index}";directory.mkdir()
            count = a.games//a.simulator_workers + int(index<a.games%a.simulator_workers)
            shard = {**job,"out":str(directory),"games":count,"gameOffset":offset}
            offset += count
            path = directory/"job.json";path.write_text(json.dumps(shard,indent=2));shards.append(directory)
            output = (directory/"node.log").open("x");logs.append(output)
            processes.append(subprocess.Popen(["node","--import","tsx",
                str(runtime/"scripts/uu_selfplay/batch_collect.mts"),str(path)],cwd=runtime,
                stdout=output,stderr=subprocess.STDOUT))
        shard_statistics,drain_deadline,statistics_errors = {},None,{}
        while True:
            codes = [p.poll() for p in processes]
            totals = {"startedGames":0,"completed":0,"failed":0,"censored":0}
            unreadable=[]
            for directory in shards:
                path = directory/"throughput.json"
                value,error=read_shard_statistics(path,shard_statistics.get(directory))
                if value is not None:shard_statistics[directory]=value
                if error:
                    unreadable.append(directory.name)
                    statistics_errors[error]=statistics_errors.get(error,0)+1
                for key in totals:totals[key] += shard_statistics.get(directory,{}).get(key,0)
            wall = time.monotonic()-started
            (out/"throughput.tmp").write_text(json.dumps({**totals,"wallSeconds":wall,
                "gamesPerHour":totals["completed"]*3600/wall,"simulatorWorkers":a.simulator_workers,
                "concurrencyPerWorker":a.concurrency,"exitCodes":codes,
                "statisticsReadErrors":statistics_errors,"unreadableStatistics":unreadable},indent=2))
            (out/"throughput.tmp").replace(out/"throughput.json")
            if all(code is not None for code in codes):
                # Client exit can precede the server's final replay/sidecar write.
                # A completed run requires both POVs durably closed before unload.
                if not any(codes):
                    try:closed = json.loads((out/"server/collector-stats.json").read_text())
                    except (OSError,json.JSONDecodeError):closed = {}
                    drained = (not unreadable and len(shard_statistics)==len(shards)
                               and not closed.get("active",1) and closed.get("completedPOVs")==a.games*2)
                    if job.get("progressCensoring"):
                        try:
                            records=[json.loads(line) for directory in shards for line in (directory/"games.jsonl").read_text().splitlines()]
                            ledger=out/"server/sessions.jsonl"
                            events=[json.loads(line) for line in ledger.read_text().splitlines()] if ledger.exists() else []
                            proof=validate_censored_drain(job,records,events,closed)
                            (out/"progress-session-drain.json").write_text(json.dumps(proof,indent=2)+"\n")
                            drained=not unreadable and len(shard_statistics)==len(shards)
                        except (ValueError,OSError,json.JSONDecodeError):drained=False
                    elif closed.get("failedPOVs",0):raise RuntimeError("Shared worker rejected a completed game POV")
                    if not drained:
                        if drain_deadline is None:drain_deadline = time.monotonic()+30
                        if time.monotonic()>drain_deadline:raise TimeoutError("Final replay/sidecar drain incomplete")
                        time.sleep(.1);continue
                policy_members(out/"policies.json",a.checkpoint)  # assets stayed byte-bound throughout
                return int(any(code!=0 for code in codes))
            if any(code not in (None,0) for code in codes):
                raise RuntimeError(f"Simulator worker failed: {codes}; original starts/results retained")
            if server.poll() is not None:raise RuntimeError("Shared model process exited")
            time.sleep(1)
    finally:
        for process in processes:
            if process.poll() is None:process.terminate()
        for process in processes:
            try:process.wait(timeout=30)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        server.terminate()
        try:server.wait(timeout=15)
        except subprocess.TimeoutExpired:server.kill();server.wait()
        if not socket.startswith('tcp://'):Path(socket).unlink(missing_ok=True)
        log.close()
        for output in logs:output.close()


if __name__ == "__main__":
    raise SystemExit(main())
