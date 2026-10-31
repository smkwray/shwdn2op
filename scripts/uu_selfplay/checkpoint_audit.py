"""Read-only native checkpoint audit: value learning and primary-policy freeze.

No model construction or GPU allocation. Map trusted local tensors on CPU and
bind the diagnostic to the exact checkpoint, baseline and audit source bytes.
"""
import argparse
import json
import re
from pathlib import Path

import psutil
import torch
from export_candidate import BASE_SHA,digest


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint",required=True,type=Path)
    p.add_argument("--base",required=True,type=Path)
    p.add_argument("--base-sha256",default=BASE_SHA)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--expect-primary-frozen",action="store_true")
    p.add_argument("--expect-critic-frozen",action="store_true")
    p.add_argument("--optimizer-state",type=Path)
    p.add_argument("--min-available-gib",type=float,default=6.)
    a = p.parse_args()
    if a.expect_primary_frozen and a.expect_critic_frozen:
        raise ValueError("Choose the declared trainable side of the checkpoint")
    if a.out.exists():raise FileExistsError(a.out)
    torch.set_num_threads(1)
    if not re.fullmatch(r"[0-9a-f]{64}",a.base_sha256) or digest(a.base)!=a.base_sha256:
        raise ValueError("Pinned initial checkpoint mismatch")
    before = digest(a.checkpoint)
    base = torch.load(a.base,map_location="cpu",weights_only=True,mmap=True)
    current = torch.load(a.checkpoint,map_location="cpu",weights_only=True,mmap=True)
    primary,critics,changed_primary,changed_critics = [],[],[],[]
    maximum = 0.
    for key,original in base.items():
        if psutil.virtual_memory().available<a.min_available_gib*2**30:raise MemoryError("Audit RAM reserve")
        if key not in current or current[key].shape!=original.shape or current[key].dtype!=original.dtype:
            raise ValueError(f"Native checkpoint schema drift: {key}")
        if key.startswith(("tstep_encoder.","traj_encoder.","actor.")):
            primary.append(key)
            if not torch.equal(original,current[key]):changed_primary.append(key)
        if key.startswith("critics.") and key.endswith(("weight","bias")):
            critics.append(key)
            if not torch.equal(original,current[key]):
                changed_critics.append(key)
                maximum = max(maximum,float((current[key]-original).abs().max()))
    if digest(a.checkpoint)!=before:raise ValueError("Checkpoint changed during audit")
    moments,optimizer_sha = None,None
    if a.optimizer_state:
        optimizer_sha = digest(a.optimizer_state)
        optimizer = torch.load(a.optimizer_state,map_location="cpu",weights_only=True,mmap=True)
        moments = 0
        for state in optimizer["state"].values():
            if psutil.virtual_memory().available<a.min_available_gib*2**30:raise MemoryError("Audit RAM reserve")
            moment = state.get("exp_avg")
            if moment is not None:
                if not torch.isfinite(moment).all():raise ValueError("Nonfinite optimizer moment")
                moments += int(bool(torch.count_nonzero(moment)))
    learned = bool(changed_primary and not changed_critics) if a.expect_critic_frozen else bool(
        changed_critics and (not a.expect_primary_frozen or not changed_primary))
    report = {"diagnosticOnly":True,"checkpointSha256":before,"baseSha256":a.base_sha256,
        "producerSha256":digest(__file__),"primaryTensors":len(primary),"criticWeightTensors":len(critics),
        "changedPrimary":changed_primary,"changedCriticWeights":changed_critics,"maxCriticWeightChange":maximum,
        "expectCriticFrozen":a.expect_critic_frozen,
        "optimizerSha256":optimizer_sha,"nonzeroOptimizerMomentTensors":moments,
        "pass":bool(primary and critics and learned and (moments is None or moments>0))}
    with a.out.open("x") as stream:json.dump(report,stream,indent=2)
    a.out.with_suffix(".producer.py").write_bytes(Path(__file__).read_bytes())
    print(json.dumps({k:v for k,v in report.items() if k not in ("changedPrimary","changedCriticWeights")}),flush=True)
    return int(not report["pass"])


if __name__=="__main__":raise SystemExit(main())
