"""Collect a frozen generation league using an already qualified shared worker.

Run under remrun from the project. No stage is retried after it starts: resource
yields and failures retain their own blocks and stop this invocation for review.
The native freezer and both-player family filter produce the training inputs.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from candidate_worker import policy_members,checkpoint_members
from export_candidate import BASE_SHA
from gpu_job import blockers


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def collection_panel(pool, panel, seed, ordinal):
    """Rotate public set variants while preserving the frozen family split."""
    families = {r["family"] for r in panel["collection"]}
    forbidden = {r["family"] for r in panel["progress"]} | set(panel["excludedCertificationFamilies"])
    if len(families)!=len(panel["collection"]) or families & forbidden or ordinal<0:
        raise ValueError("Distinct non-reserved collection families required")
    manifest = pool/"manifest.json"
    if digest(manifest)!=panel["poolManifestSha256"]:
        raise ValueError("Pool manifest drift")
    groups = {family:{} for family in families}
    unavailable,duplicates = 0,0
    public = (pool/"teams/uu_train_v1").resolve()
    for row in json.loads(manifest.read_text())["teams"]:
        if row["family_sha256"] not in families:continue
        if row["split"]!="train":raise ValueError("Collection metadata is not public train")
        if not row.get("file"):
            if row.get("validation",{}).get("status")!="dropped":
                raise ValueError("Missing required team file")
            unavailable += 1
            continue
        if row.get("validation",{}).get("status")!="valid" or any(not re.fullmatch(
                r"[0-9a-f]{64}",row.get(key,"")) for key in ("canonical_set_sha256","team_sha256")):
            raise ValueError("Missing or malformed required team hashes/validation")
        path = (pool/row["file"]).resolve()
        if not path.is_relative_to(public):raise ValueError("Public train team path required")
        variants = groups[row["family_sha256"]]
        canonical = row["canonical_set_sha256"]
        if canonical in variants:
            duplicates += 1
            if variants[canonical]["file"]<=row["file"]:continue
        variants[canonical] = row
    selected = []
    for original in panel["collection"]:
        family = original["family"]
        variants = sorted(groups[family].values(),key=lambda r:(r["canonical_set_sha256"],r["file"]))
        if not variants:raise ValueError("Collection family has no validated team variants")
        offset = int.from_bytes(hashlib.sha256(f"uu-collection-set-v1:{seed}:{family}".encode()).digest(),"big")
        row = variants[(offset+ordinal)%len(variants)]
        if digest(pool/row["file"])!=row["team_sha256"]:raise ValueError("Public team file hash mismatch")
        selected.append({**original,"source":row["file"],"sha256":row["team_sha256"],
                         "setVariant":row["canonical_set_sha256"]})
    return {**panel,"collection":selected,"collectionVariantSelection":{
        "method":"salted family offset plus block ordinal; cycle validated canonical sets",
        "seed":seed,"ordinal":ordinal,"canonicalVariants":sum(map(len,groups.values())),
        "duplicateCanonicalRows":duplicates,"unavailableRows":unavailable}}


def qualification(root):
    state = json.loads((root/"status.json").read_text())
    if state["phase"] != "QUALIFIED":
        raise ValueError("Completed CUDA collection qualification required")
    if state["targetMet"] is not True or state["gamesPerHour"] < state["targetGamesPerHour"]:
        raise ValueError("Collection throughput target is still unmet")
    selected = state["selected"]
    if not (1 <= selected["workers"] <= 4 and 1 <= selected["concurrency"] * selected["workers"] <= 64):
        raise ValueError("Invalid qualified concurrency")
    # Every source byte retained by qualification must still match. The shared
    # worker is invoked in this runtime, never copied from the mutable checkout.
    for name, expected in json.loads((root/"producer.json").read_text()).items():
        path = Path(name).resolve()
        if not path.is_relative_to(root.resolve()) or digest(path) != expected:
            raise ValueError("Qualified producer drift")
    return state


def completed_run(root, games):
    rate = json.loads((root/"throughput.json").read_text())
    stats = json.loads((root/"server/collector-stats.json").read_text())
    if not (rate["startedGames"] == rate["completed"] == games and rate["failed"] == 0
            and all(code == 0 for code in rate["exitCodes"])
            and stats["completedPOVs"] == 2*games and stats["failedPOVs"] == 0 and stats["active"] == 0):
        raise ValueError("Generation block incomplete, failed or not drained")
    return rate


def generation_members(path,base):
    members = policy_members(path,base)
    for member in members:
        if member["name"] == "G0":
            if member["sha256"] != BASE_SHA:raise ValueError("G0 must be the incumbent bytes")
        elif member.get("kind")!="ensemble":
            receipt = json.loads(Path(member["path"]+".receipt.json").read_text())
            if member["sha256"] == BASE_SHA or receipt.get("training_eligible") is not True or not re.fullmatch(
                    r"[0-9a-f]{64}",receipt.get("training_identity_sha256", "")):
                raise ValueError("Generation league needs a bound, generation-eligible training identity")
    return members


def block_name(out, stage):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",out.name) or re.fullmatch(
            r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]",out.name,re.IGNORECASE):
        raise ValueError("Portable unique program name required")
    # The freezer's identity is (block, battle_tag), so names must distinguish
    # generations as well as blocks. Native game IDs may safely restart at zero.
    namespace = hashlib.sha256(str(out.resolve()).encode()).hexdigest()[:16]
    return out.name+"-"+namespace+"-"+stage


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--qualified",required=True,type=Path)
    p.add_argument("--policies",required=True,type=Path)
    p.add_argument("--focal",required=True)
    p.add_argument("--opponents",nargs="+")
    p.add_argument("--temperatures",nargs="+",type=float,default=[.8,1.,1.2])
    p.add_argument("--checkpoint",required=True,type=Path)
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--pool",required=True,type=Path)
    p.add_argument("--panel",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--games",type=int,default=100000)
    p.add_argument("--block-games",type=int,default=10000)
    p.add_argument("--seed",required=True,type=int)
    a = p.parse_args()
    q = qualification(a.qualified)
    members = generation_members(a.policies,a.checkpoint)
    names = {m["name"] for m in members}
    if a.focal == "G0" or a.focal not in names or "G0" not in names:
        raise ValueError("A trained focal policy and G0 are required")
    opponents = a.opponents or sorted(names)
    if not opponents or any(n not in names for n in opponents):
        raise ValueError("Unknown league opponent")
    if not a.temperatures or any(not math.isfinite(t) or t<=0 for t in a.temperatures):
        raise ValueError("Positive finite temperatures required")
    if a.games < 64 or a.block_games < 64:
        raise ValueError("Positive collection target and blocks of at least 64 games required")
    concurrency = q["selected"]["workers"] * q["selected"]["concurrency"]
    if a.games % a.block_games and a.games % a.block_games < concurrency:
        raise ValueError("Last block needs at least one game per qualified concurrent slot")
    out = a.out.resolve()
    block_name(out,"check")
    out.mkdir(parents=True,exist_ok=False)
    program = Path(__file__).read_bytes()
    (out/"producer.py").write_bytes(program)
    (out/"policies.json").write_text(json.dumps(members,indent=2))
    (out/"panel.json").write_bytes(a.panel.read_bytes())
    shutil.copyfile(Path(__file__).with_name("filter_families.py"),out/"filter-producer.py")
    plan = {**{k:str(v.resolve()) if isinstance(v,Path) else v for k,v in vars(a).items()},
        "opponents":opponents,"qualificationStatusSha256":digest(a.qualified/"status.json"),
        "qualificationProducerSha256":digest(a.qualified/"producer.json"),
        "producerSha256":hashlib.sha256(program).hexdigest(),
        "pilotGames":128,"sustainedGames":512,"retryStartedStages":False}
    (out/"plan.json").write_text(json.dumps(plan,indent=2))
    kit = a.qualified.resolve()/"runtime/scripts/uu_selfplay"
    results, frozen = [], []
    def status(phase,**extra):
        temp = out/"status.tmp"
        temp.write_text(json.dumps({"phase":phase,"updated":time.time(),"results":results,**extra},indent=2))
        temp.replace(out/"status.json")
    def execute(stage,argv):
        import psutil
        while True:
            own = {os.getpid(),*[p.pid for p in psutil.Process().parents()]}
            reasons = blockers(own)
            if psutil.virtual_memory().available < 32*2**30:
                reasons.append({"kind":"start_memory_reserve"})
            if not reasons:break
            status("WAIT_RESOURCE",stage=stage,reasons=reasons)
            time.sleep(30)
        qualification(a.qualified)
        name = block_name(out,stage)
        status("RUNNING",stage=stage)
        with (out/(name+".log")).open("x") as log:
            code = subprocess.run([sys.executable,str(kit/"gpu_job.py"),"--receipt",str(out/(name+"-lifecycle.json")),
                "--",sys.executable,*map(str,argv(name))],stdout=log,stderr=subprocess.STDOUT).returncode
        life = json.loads((out/(name+"-lifecycle.json")).read_text())
        results.append({"stage":stage,"name":name,"returncode":code,"lifecycle":life})
        partial = out/name/"throughput.json"
        if partial.exists():results[-1]["throughput"] = json.loads(partial.read_text())
        if code:
            status("YIELDED" if code==75 else "FAILED",stage=stage)
            raise SystemExit(code)
        return name
    focal = next(m for m in members if m["name"]==a.focal)
    def collect(stage,games):
        seed = int.from_bytes(hashlib.sha256(f"{a.seed}:{out.name}:{stage}".encode()).digest()[:4],"big") >> 1
        panel_file = out/(block_name(out,stage)+"-panel.json")
        panel = collection_panel(a.pool,json.loads((out/"panel.json").read_text()),a.seed,len(frozen))
        with panel_file.open("x") as stream:json.dump(panel,stream,indent=2)
        name = execute(stage,lambda name:[kit/"batch_collect.py","--out",out/name,"--checkpoint",a.checkpoint,
            "--source",a.source,"--pool",a.pool,"--panel",panel_file,
            "--node-modules",a.qualified/"runtime/node_modules","--policies",out/"policies.json",
            "--focal",a.focal,"--opponents",*opponents,"--temperatures",*a.temperatures,
            "--simulator-workers",q["selected"]["workers"],"--concurrency",q["selected"]["concurrency"],
            "--games",games,"--seed",seed])
        rate = completed_run(out/name,games)
        results[-1]["throughput"] = rate
        target = out/(name+"-frozen")
        with (out/(name+"-freeze.log")).open("x") as log:
            subprocess.run([sys.executable,str(kit/"freeze_pile.py"),str(target),
                str(out/name/"server/piles"/name)],check=True,stdout=log,stderr=subprocess.STDOUT)
        manifest = json.loads((target/"manifest.json").read_text())
        if manifest["battles"] != games or manifest["trajectories"] != games*2 or manifest["excluded"]:
            raise ValueError("Native freeze lost completed generation games")
        frozen.append(target)
        return rate
    try:
        for asset in checkpoint_members([focal]):
            if asset["sha256"]==BASE_SHA:continue
            stage = "candidate-parity" if focal.get("kind")!="ensemble" else "candidate-parity-"+asset["sha256"][:12]
            execute(stage,lambda name,asset=asset:[kit/"batch_parity.py","--fixture",a.qualified/"fixture.json",
                "--source",a.source,"--checkpoint",asset["path"],"--out",out/(name+".json"),"--backend","torch-cuda-flex"])
        collect("pilot",128)
        rate = collect("sustained",512)
        if rate["gamesPerHour"] < q["targetGamesPerHour"]:
            status("REVIEW_THROUGHPUT",gamesPerHour=rate["gamesPerHour"])
            return 1
        for start in range(0,a.games,a.block_games):
            collect(f"data-{start//a.block_games:04d}",min(a.block_games,a.games-start))
        status("FILTERING")
        with (out/"filter.log").open("x") as log:
            subprocess.run([sys.executable,str(out/"filter-producer.py"),"--piles",*map(str,frozen),
                "--panel",str(out/"panel.json"),"--pool-manifest",str(a.pool/"manifest.json"),
                "--out",str(out/"training")],check=True,stdout=log,stderr=subprocess.STDOUT)
        admitted = json.loads((out/"training/manifest.json").read_text())
        if not admitted["complete"] or admitted["qualificationOnly"] or not admitted["trajectories"]:
            raise ValueError("Complete filtered generation data required")
        status("TRAINING_READY",completedGames=a.games+128+512,games=admitted["battles"],
               povs=admitted["trajectories"],excluded=admitted["excluded"])
    except Exception as e:
        status("FAILED",error=f"{type(e).__name__}: {e}")
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
