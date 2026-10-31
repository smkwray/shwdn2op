"""Compare native uninterrupted/resumed qualification weights and training state."""
import argparse
import json
from pathlib import Path
import torch


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("run",type=Path)
    p.add_argument("full")
    p.add_argument("resumed")
    p.add_argument("--epoch",type=int,default=1)
    a = p.parse_args()
    root = a.run/"checkpoints"
    paths = [root/name/"ckpts" for name in (a.full,a.resumed)]
    weights = [torch.load(p/"policy_weights"/f"policy_epoch_{a.epoch}.pt",map_location="cpu",weights_only=True) for p in paths]
    if weights[0].keys()!=weights[1].keys():raise ValueError("Checkpoint schema drift")
    unequal = {k:float((weights[0][k]-weights[1][k]).abs().max()) for k in weights[0]
               if not torch.equal(weights[0][k],weights[1][k])}
    del weights
    states = []
    for path,name in zip(paths,(a.full,a.resumed)):
        custom = []
        for f in (path/"training_states"/f"{name}_epoch_{a.epoch}").glob("custom_checkpoint_*.pkl"):
            data = torch.load(f,map_location="cpu",weights_only=False)
            if isinstance(data,dict) and "nextEpoch" in data:custom.append(data)
        if len(custom)!=1:raise ValueError("Exactly one native continuation state required")
        states.append(custom[0])
    matching = all(states[0][key]==states[1][key] for key in ("nextEpoch","gradientUpdates","sequenceFilter"))
    report = {"exactWeightParity":not unequal,"unequalTensors":unequal,"trainingStateParity":matching,
              "nextEpoch":states[1]["nextEpoch"],"gradientUpdates":states[1]["gradientUpdates"],
              "qualificationOnly":True}
    print(json.dumps(report),flush=True)
    return int(bool(unequal) or not matching)


if __name__=="__main__":raise SystemExit(main())
