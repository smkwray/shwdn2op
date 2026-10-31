"""Frozen CUDA collection qualification, queued after the real training sweep.

Native RNG/cache parity precedes full-game singleton/batch parity, scaling and
a sustained run. Every attempt is retained; resource yields create new attempts.
"""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import psutil
from batch_collect import freeze_runtime,retain_producer
from gpu_job import blockers
from candidate_worker import policy_members,checkpoint_members


def compare_games(reference,batched,count=8):
    def choices(directory,game):
        matches = list(directory.glob(f"worker-*/game-{game:07d}/trajectory.jsonl"))
        if len(matches)!=1:raise ValueError("Exactly one retained parity trace required")
        rows = [json.loads(l) for l in matches[0].read_text().splitlines()]
        return {side:[{k:r[k] for k in ("turn","rqid","choice","accepted")} for r in rows if r["side"]==side]
                for side in ("p1","p2")}
    errors,decisions = [],0
    for game in range(count):
        expected,actual = choices(reference,game),choices(batched,game)
        for side in ("p1","p2"):
            decisions += len(expected[side])
            if actual[side]!=expected[side]:errors.append({"game":game,"side":side,
                "referenceDecisions":len(expected[side]),"batchDecisions":len(actual[side])})
    return {"pass":not errors,"games":count,"attempts":decisions,"differences":errors}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--after-training",required=True,type=Path)
    p.add_argument("--checkpoint",required=True,type=Path)
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--pool",required=True,type=Path)
    p.add_argument("--panel",required=True,type=Path)
    p.add_argument("--fixture",required=True,type=Path)
    p.add_argument("--node-modules",required=True,type=Path)
    p.add_argument("--pool-policies",type=Path,help="optional real second model for league qualification")
    p.add_argument("--pool-focal",help="measure the declared composite collector, including its target recording")
    p.add_argument("--after-collection",type=Path)
    p.add_argument("--target-games-per-hour",type=float,default=3000.)
    p.add_argument("--cpu-reference",action="store_true")
    p.add_argument("--wait",action="store_true")
    a = p.parse_args()
    for name in ("after_training","checkpoint","source","pool","panel","fixture","node_modules"):
        setattr(a,name,getattr(a,name).resolve())
    out = a.out.resolve();out.mkdir(parents=True,exist_ok=False)
    (out/"policies.json").write_text(json.dumps(policy_members(None,a.checkpoint),indent=2))
    pool_members = policy_members(a.pool_policies,a.checkpoint) if a.pool_policies else None
    if not math.isfinite(a.target_games_per_hour) or a.target_games_per_hour<=0 or a.pool_focal and (not pool_members or a.pool_focal not in {m["name"] for m in pool_members}):
        raise ValueError("Positive throughput target and declared pool focal required")
    if pool_members and len({m["sha256"] for m in pool_members})<2:
        raise ValueError("Model-pool qualification needs distinct weight bytes")
    if pool_members:(out/"pool-policies.json").write_text(json.dumps(pool_members,indent=2))
    runtime = out/"runtime";freeze_runtime(runtime,a.node_modules)
    shutil.copyfile(a.panel,out/"panel.json");shutil.copyfile(a.fixture,out/"fixture.json")
    retain_producer(out,runtime,[out/"panel.json",out/"fixture.json",out/"policies.json",
        *([out/"pool-policies.json"] if pool_members else [])])
    kit = runtime/"scripts/uu_selfplay"
    results = []
    def status(phase,**extra):
        (out/"status.tmp").write_text(json.dumps({"phase":phase,"updated":time.time(),"results":results,**extra},indent=2))
        (out/"status.tmp").replace(out/"status.json")
    def wait_ready():
        while True:
            training = json.loads(a.after_training.read_text())
            if training["phase"] not in ("WAIT_RESOURCE","PROBING","SWEEP_COMPLETE"):
                status("FAILED_DEPENDENCY",trainingPhase=training["phase"])
                raise RuntimeError(f"Training qualification needs review: {training['phase']}")
            own = {os.getpid(),*[p.pid for p in psutil.Process().parents()]}
            reasons = blockers(own)
            if a.after_collection:
                dependency = json.loads(a.after_collection.read_text())
                if dependency["phase"] not in ("WAIT_RESOURCE","RUNNING","QUALIFIED"):
                    status("FAILED_DEPENDENCY",collectionPhase=dependency["phase"])
                    raise RuntimeError("Prior collection qualification needs review")
                if dependency["phase"]!="QUALIFIED":
                    reasons.append({"kind":"collection_qualification","phase":dependency["phase"]})
            if training["phase"]!="SWEEP_COMPLETE":reasons.append({"kind":"training_sweep","phase":training["phase"]})
            if psutil.virtual_memory().available<32*2**30:reasons.append({"kind":"start_memory_reserve"})
            if not reasons:return
            status("WAIT_RESOURCE",reasons=reasons)
            if not a.wait:raise SystemExit(75)
            time.sleep(30)
    def execute(label,arguments):
        attempt = 0
        while True:
            wait_ready();attempt += 1;name = f"{label}-a{attempt}"
            status("RUNNING",name=name)
            argv = [sys.executable,str(kit/"gpu_job.py"),"--receipt",str(out/f"{name}-lifecycle.json"),
                    "--",sys.executable,*map(str,arguments(name))]
            with (out/f"{name}.log").open("x") as log:
                code = subprocess.run(argv,stdout=log,stderr=subprocess.STDOUT).returncode
            lifecycle = json.loads((out/f"{name}-lifecycle.json").read_text())
            results.append({"name":name,"returncode":code,"lifecycle":lifecycle})
            if code==75 and a.wait:
                if any(r["kind"]=="memory_floor" for r in lifecycle["reasons"]):
                    status("CAPACITY_STOP",name=name);raise SystemExit(75)
                if lifecycle["status"]!="WAIT_RESOURCE":
                    status("YIELDED",name=name);raise SystemExit(75)
                continue
            if code:
                status("FAILED",name=name);raise SystemExit(code)
            return out/name
    execute("native-parity",lambda name:[kit/"batch_parity.py","--fixture",out/"fixture.json","--source",a.source,
        "--checkpoint",a.checkpoint,"--out",out/f"{name}.json","--backend","torch-cuda-flex",
        *(["--cpu-reference"] if a.cpu_reference else [])])
    def collect(label,workers,concurrency,games,extra=()):
        run = execute(label,lambda name:[kit/"batch_collect.py","--out",out/name,"--checkpoint",a.checkpoint,
            "--panel",out/"panel.json","--pool",a.pool,"--source",a.source,"--node-modules",a.node_modules,
            "--backend","torch-cuda-flex","--simulator-workers",workers,"--concurrency",concurrency,
            "--games",games,"--seed","441026",*extra])
        throughput = json.loads((run/"throughput.json").read_text())
        stats = json.loads((run/"server/collector-stats.json").read_text())
        if throughput["completed"]!=games or throughput["failed"] or stats["completedPOVs"]!=games*2 or stats["failedPOVs"]:
            raise ValueError("Collection qualification incomplete or failed")
        results[-1].update(throughput=throughput,collector=stats)
        return run,throughput
    reference,_ = collect("singleton",1,1,8)
    batched,_ = collect("batch-parity",2,4,8)
    parity = compare_games(reference,batched)
    (out/"game-parity.json").write_text(json.dumps(parity,indent=2))
    if not parity["pass"]:status("FAILED_GAME_PARITY");return 1
    if pool_members:
        candidate = next(m for m in pool_members if m["name"]==a.pool_focal) if a.pool_focal else next(
            m for m in pool_members if m["sha256"]!=pool_members[0]["sha256"])
        for asset in checkpoint_members(pool_members):
            if asset["sha256"]==pool_members[0]["sha256"]:continue
            execute("candidate-native-parity-"+asset["sha256"][:12],lambda name,asset=asset:[kit/"batch_parity.py",
                "--fixture",out/"fixture.json","--source",a.source,"--checkpoint",asset["path"],
                "--out",out/f"{name}.json","--backend","torch-cuda-flex",*(["--cpu-reference"] if a.cpu_reference else [])])
        collect("model-pool",2,4,8,["--policies",str(out/"pool-policies.json"),"--focal",candidate["name"],"--opponents","G0"])
        policy_members(out/"pool-policies.json",a.checkpoint)
    pilots = []
    pool_args = ["--policies",str(out/"pool-policies.json"),"--focal",a.pool_focal,"--opponents","G0",a.pool_focal] if a.pool_focal else []
    for workers,concurrency in ((2,4),(2,8),(4,8),(4,16)):
        run,rate = collect(f"scale-s{workers}-c{concurrency}",workers,concurrency,128,pool_args)
        pilots.append((rate["gamesPerHour"],workers,concurrency))
    _,workers,concurrency = max(pilots)
    run,rate = collect("sustained",workers,concurrency,512,pool_args)
    block = run/"server/piles"/run.name
    with (out/"freeze.log").open("x") as log:
        subprocess.run([sys.executable,str(kit/"freeze_pile.py"),str(out/"frozen"),str(block)],check=True,stdout=log,stderr=subprocess.STDOUT)
    frozen = json.loads((out/"frozen/manifest.json").read_text())
    if frozen["battles"]!=512 or frozen["trajectories"]!=1024 or frozen["excluded"]:
        raise ValueError("Native pile freeze did not preserve every completed game")
    if a.cpu_reference:
        reports = [json.loads((out/(row["name"]+".json")).read_text()) for row in results
            if row["name"].startswith(("native-parity-","candidate-native-parity-"))]
        assets = checkpoint_members(pool_members) if pool_members else policy_members(None,a.checkpoint)
        if ({r["checkpointSha256"] for r in reports}!={r["sha256"] for r in assets}
                or not all(r["pass"] and r["cpuReference"]["pass"] for r in reports)):
            status("FAILED_CPU_REFERENCE")
            raise ValueError("Every neural asset needs qualified CPU/native CUDA parity")
    status("QUALIFIED",gamesPerHour=rate["gamesPerHour"],targetGamesPerHour=a.target_games_per_hour,
           targetMet=rate["gamesPerHour"]>=a.target_games_per_hour,selected={"workers":workers,"concurrency":concurrency},
           measuredFocal=a.pool_focal or "G0",cpuReferenceQualified=a.cpu_reference,
           focalPolicyId=next(m["policyId"] for m in pool_members if m["name"]==a.pool_focal) if a.pool_focal else "metamon:Kakuna:epoch34")
    return 0


if __name__=="__main__":raise SystemExit(main())
