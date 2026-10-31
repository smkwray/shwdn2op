"""Frozen real-trainer scaling probes; yield to evaluation/TTS and shared memory.

Source the existing env.sh, run from the project root under remrun. Completed
probes and interrupted attempts are immutable. No learned weights are retained.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import zipfile

import psutil
from gpu_job import blockers


def confirm_stable(passed, confirm):
    confirmed, rejected = {},[]
    for candidate in reversed(passed):
        batch = candidate["batch"]
        row = confirm(batch)
        if row is None:rejected.append(batch)
        else:
            confirmed[batch] = row
            break
    largest = max(confirmed,default=None)
    if largest is not None:
        best = max((r for r in passed if r["batch"]<=largest),
                   key=lambda r:r["summary"]["trajectorySamplesPerHour"])["batch"]
        if best not in confirmed:
            row = confirm(best)
            if row is None:rejected.append(best)
            else:confirmed[best] = row
    best = max(confirmed,key=lambda b:confirmed[b]["summary"]["trajectorySamplesPerHour"],default=None)
    return {"largestStableBatch":largest,"bestMeasuredBatch":best,
            "confirmed":list(confirmed.values()),"memoryRejectedBatches":rejected}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--batches",type=int,nargs="+",default=[2,4,8,16,32,48,64])
    p.add_argument("--precisions",choices=["no","bf16"],nargs="+",default=["no","bf16"])
    p.add_argument("--steps",type=int,default=26)
    p.add_argument("--confirm-steps",type=int,default=600)
    p.add_argument("--min-available-gib",type=float,default=24.)
    p.add_argument("--wait",action="store_true")
    a = p.parse_args()
    if sorted(set(a.batches))!=a.batches or min(a.batches)<1 or a.steps<4 or a.confirm_steps<a.steps:
        raise ValueError("Increasing positive batches, >=4 probe steps and a longer confirmation required")
    out = a.out.resolve();out.mkdir(parents=True,exist_ok=False)
    (out/"execution.json").write_text(json.dumps({"torchDynamoDisable":os.environ.get("TORCHDYNAMO_DISABLE"),
        "minimumAvailableGiB":a.min_available_gib,"batches":a.batches,"precisions":a.precisions,
        "probeSteps":a.steps,"confirmationSteps":a.confirm_steps,"retainsLearnedWeights":False},indent=2))
    kit = Path(__file__).resolve().parent
    sources = [kit/x for x in ["training_sweep.py","gpu_job.py","training_probe.py","training_attention.py","attention_probe.py"]]
    with zipfile.ZipFile(out/"producer.zip","x",zipfile.ZIP_DEFLATED) as archive:
        for source in sources:archive.write(source,str(source.relative_to(Path.cwd())))
    (out/"producer.json").write_text(json.dumps({str(s.relative_to(Path.cwd())):
        hashlib.sha256(s.read_bytes()).hexdigest() for s in sources},indent=2))
    frozen = out/"source";frozen.mkdir()
    for source in sources:shutil.copyfile(source,frozen/source.name)
    kit = frozen
    (out/"data.yaml").write_text("replay_weight: 0.0\nformats: [gen9uu]\ncustom_replays:\n"+
        "".join(f"  - dir: {Path.cwd()}/tmp/uu-iter2/piles-v2/{s}/UUKakuna/metamon\n    weight: {w}\n"
                for s,w in [("league-kakuna",.5),("league-other",.25),("continuity",.25)]))
    (out/"math.gin").write_text(f"include '{Path(os.environ['R'])}/finetune-flex.gin'\n"
        "import training_attention\ntraj_encoders.TformerTrajEncoder.attention_type = @training_attention.WindowSDPA\n"
        "MetamonAMAGOExperiment.always_save_latest = False\n")
    env = {**os.environ,"PYTHONPATH":str(kit)+os.pathsep+os.environ["PYTHONPATH"]}
    results,qualifications = [],{}

    def status(phase,**fields):
        (out/"status.json").write_text(json.dumps({"phase":phase,"updated":time.time(),"results":results,**fields},indent=2))

    def wait_ready():
        while True:
            own = {os.getpid(),*[p.pid for p in psutil.Process().parents()]}
            reasons = blockers(own)
            available = psutil.virtual_memory().available
            if available<a.min_available_gib*2**30:reasons.append({"kind":"memory_floor","available":available})
            if not reasons:return available
            status("WAIT_RESOURCE",reasons=reasons)
            if not a.wait:raise SystemExit(75)
            time.sleep(30)

    def execute(name,argv):
        command = [sys.executable,str(kit/"gpu_job.py"),"--receipt",str(out/f"{name}-lifecycle.json"),
            "--min-available-gib",str(a.min_available_gib),"--",sys.executable,*map(str,argv)]
        with (out/f"{name}.log").open("x") as log:
            code = subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT).returncode
        lifecycle = json.loads((out/f"{name}-lifecycle.json").read_text())
        return code,lifecycle

    def probe(precision,batch,steps,label):
        attempt = 0
        while True:
            wait_ready();attempt += 1
            name = f"{label}-{precision}-b{batch}-a{attempt}"
            status("PROBING",name=name,batch=batch,precision=precision)
            argv = [kit/"training_probe.py","--out",out/f"{name}.jsonl","--mixed-precision",precision,"--",
                "--run_name",name,"--save_dir",out/"checkpoints","--base_model","UUKakuna","--base_checkpoint","34",
                "--dataset_config",out/"data.yaml","--train_gin_config",out/"math.gin","--epochs","1",
                "--steps_per_epoch",steps,"--batch_size_per_gpu",batch,"--grad_accum","1","--ckpt_interval","0",
                "--dloader_workers","2","--eval_gens"]
            code,life = execute(name,argv)
            row = {"name":name,"batch":batch,"precision":precision,"returncode":code,"lifecycle":life}
            results.append(row)
            if code==75:
                if any(r["kind"]=="memory_floor" for r in life["reasons"]):return None
                if a.wait:continue
            if code:
                status("FAILED_PROBE",name=name);raise SystemExit(code)
            row["summary"] = json.loads((out/f"{name}.summary.json").read_text())
            return row

    for precision in a.precisions:
        attempt = 0
        while True:
            wait_ready();attempt += 1
            name = f"attention-{precision}-a{attempt}"
            dtype = "float32" if precision=="no" else "bfloat16"
            code,life = execute(name,[kit/"attention_probe.py","--mode","MATH","--dtype",dtype,"--out",out/f"{name}.json"])
            results.append({"name":name,"precision":precision,"returncode":code,"lifecycle":life})
            if code==75 and a.wait:continue
            if code:
                status("FAILED_ATTENTION",name=name);return code
            if not json.loads((out/f"{name}.json").read_text())["pass"]:raise ValueError("Attention parity failed")
            break
        passed = []
        for batch in a.batches:
            available = wait_ready()
            if passed:
                last = passed[-1]
                projected = last["summary"]["gpuPeakBytes"]*batch/last["batch"]*1.1
                if projected+a.min_available_gib*2**30>available:
                    results.append({"precision":precision,"batch":batch,"status":"NOT_RUN_HEADROOM_BOUND",
                        "projectedPeakBytes":projected,"availableBytes":available})
                    break
            row = probe(precision,batch,a.steps,"probe")
            if row is None:break
            passed.append(row)
        if not passed:
            status("NO_STABLE_BATCH",precision=precision);return 1
        qualifications[precision] = confirm_stable(passed,
            lambda batch:probe(precision,batch,a.confirm_steps,"confirm"))
        if qualifications[precision]["largestStableBatch"] is None:
            status("NO_STABLE_CONFIRMATION",precision=precision,qualifications=qualifications);return 75
    status("SWEEP_COMPLETE",qualifications=qualifications)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
