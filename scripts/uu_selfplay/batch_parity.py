"""Real-weight cache/RNG parity on public-training simulator observations.

CPU mode allocates no GPU context and tests batching independently of a CUDA
kernel. GPU mode is a separate required qualification through gpu_job.py.
"""
import argparse
import contextlib
from concurrent.futures import Future
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import torch
from batched_inference import Batcher, MLXBatcher
from export_candidate import digest


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fixture",required=True,type=Path)
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--checkpoint",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--backend",choices=["torch-cpu","torch-cuda-flex","torch-cuda-sdpa","mlx-backbone"],default="torch-cpu")
    p.add_argument("--mlx-config",type=Path)
    p.add_argument("--steps",type=int,default=150)
    p.add_argument("--cpu-reference",action="store_true",help="also compare each native CUDA stream to fp32 CPU")
    a = p.parse_args()
    mlx = a.backend == "mlx-backbone"
    if mlx != bool(a.mlx_config):raise ValueError("Explicit MLX config required")
    if a.out.exists():raise FileExistsError(a.out)
    checkpoint_sha = digest(a.checkpoint)
    sys.path.insert(0,str(Path(__file__).parents[1]/"metamon_port"))
    import common
    common.OUT = a.out.parent/(a.out.stem+"-work")
    from torch_backend import TorchBackend
    backend = TorchBackend("torch-cpu" if mlx else a.backend,a.checkpoint,a.source,0)
    native_reference = TorchBackend("torch-cpu",a.checkpoint,a.source,0) if mlx else None
    if a.cpu_reference and a.backend not in ('torch-cuda-flex','torch-cuda-sdpa'):
        raise ValueError("CPU cross-reference is a CUDA qualification")
    reference = TorchBackend("torch-cpu",a.checkpoint,a.source,0) if a.cpu_reference else None
    torch.set_num_threads(1)
    worker = backend.worker
    fixture = json.loads(a.fixture.read_text())
    controlled = (fixture.get("schema")=="uu-controlled-qualification-fixture@1"
        and fixture.get("source")=="independent native simulator; controlled Revival Blessing qualification"
        and fixture.get("eligibleForTraining") is False
        and fixture.get("acceptedNeuralRevivals",0)>0
        and all(len(fixture.get(k,""))==64 for k in ("gameResultSha256","nativeReplaySha256","causalInputSha256")))
    if not fixture["source"].startswith("independent native simulator; public training-split") and not controlled:
        raise ValueError("Public training or explicitly bound controlled qualification fixture required")
    decoder = worker.SocketlessBattle()
    obs_path = common.ObservationPath(backend.model,worker)
    sequence = []
    for row in fixture["rows"]:
        if row["op"] == "observe":
            decoder.observe(row["data"],row["context"])
        elif row["op"] == "propose" and row["executedChoice"]["kind"] != "team":
            choice = row["executedChoice"]
            obs,rl2,times,*_ = obs_path.prepare(decoder.battle,decoder.request,choice)
            tensor = lambda x:torch.from_numpy(x).to(backend.device).unsqueeze(1)
            sequence.append({"obs":{k:tensor(v) for k,v in obs.items()},"rl2s":tensor(rl2),"time_idxs":tensor(times)})
            obs_path.commit(choice)
    if not sequence:raise ValueError("No neural observations")
    base = SimpleNamespace(model=backend.model,policy=backend.policy,
                           experiment=SimpleNamespace(DEVICE=backend.device,caster=contextlib.nullcontext,compiledFlex=a.backend=='torch-cuda-flex'))
    actor = backend.policy.actor.forward
    def capture(*args,**kw):
        base.last_dist = actor(*args,**kw)
        return base.last_dist
    backend.policy.actor.forward = capture
    batcher = (MLXBatcher if mlx else Batcher).__new__(MLXBatcher if mlx else Batcher)
    batcher.base = base
    if mlx:batcher.configure(base,json.loads(a.mlx_config.read_bytes()),checkpoint_sha)
    reference_policy = native_reference.policy if mlx else base.policy
    batcher.stats = {"inferenceSeconds":0.,"batches":0,"decisions":0,"maxBatch":0}
    owners = [SimpleNamespace(generator=torch.Generator(device=backend.device).manual_seed(i+41)) for i in range(4)]
    refs = [reference_policy.traj_encoder.init_hidden_state(1,backend.device) for _ in owners]
    states = [base.policy.traj_encoder.init_hidden_state(1,backend.device) for _ in owners]
    cpu_states = [reference.policy.traj_encoder.init_hidden_state(1,reference.device) for _ in owners] if reference else []
    ref_rngs = [o.generator.get_state() for o in owners]
    counters = [0]*len(owners)
    maximum,choices,cache_max = 0.,0,0.
    cpu_max,cpu_cache_max = 0.,0.
    # Reordered singleton/multi-client batches, unequal progression, and rollover.
    for tick in range(a.steps):
        active = [i for i in reversed(range(4)) if i==0 or (tick+i)%(i+1)==0]
        jobs,expected = [],[]
        for i in active:
            inputs = dict(sequence[counters[i]%len(sequence)])
            inputs["time_idxs"] = torch.full_like(inputs["time_idxs"],counters[i])
            devices = [backend.device.index if backend.device.index is not None else torch.cuda.current_device()] if backend.device.type=="cuda" else []
            with torch.random.fork_rng(devices=devices):
                if devices:torch.cuda.set_rng_state(ref_rngs[i],backend.device)
                else:torch.random.set_rng_state(ref_rngs[i])
                with torch.no_grad():
                    action,refs[i] = reference_policy.get_actions(**inputs,hidden_state=refs[i],sample=True)
                ref_rngs[i] = torch.cuda.get_rng_state(backend.device) if devices else torch.random.get_rng_state()
            expected.append((i,(native_reference.last_dist if mlx else base.last_dist).probs.clone(),action))
            if reference:
                cpu_inputs = {"obs":{k:v.cpu() for k,v in inputs["obs"].items()},
                    "rl2s":inputs["rl2s"].cpu(),"time_idxs":inputs["time_idxs"].cpu()}
                with torch.no_grad(),torch.compiler.set_stance("force_eager"):
                    _,cpu_states[i] = reference.policy.get_actions(**cpu_inputs,hidden_state=cpu_states[i],sample=False)
                cpu_prob = reference.last_dist.probs
                gpu_prob = base.last_dist.probs.cpu()
                cpu_max = max(cpu_max,float((cpu_prob-gpu_prob).abs().max()))
                if not torch.allclose(cpu_prob,gpu_prob,atol=3e-5,rtol=3e-4):
                    raise AssertionError(f"CPU/native CUDA probability parity: {tick}/{i}/{cpu_max}")
                for name in ("key_cache","val_cache"):
                    x,y = getattr(cpu_states[i],name).data,getattr(refs[i],name).data.cpu()
                    cpu_cache_max = max(cpu_cache_max,float(torch.nan_to_num(x-y).abs().max()))
                    if not torch.allclose(x,y,atol=3e-4,rtol=3e-4,equal_nan=True):
                        raise AssertionError(f"CPU/native CUDA cache parity: {tick}/{i}/{name}/{cpu_cache_max}")
            future = Future();jobs.append((owners[i],{**inputs,"hidden_state":states[i]},future))
            counters[i] += 1
        batcher.forward(jobs)
        for (owner,_,future),(i,prob,action) in zip(jobs,expected):
            actual,_ = future.result()
            error = float((owner.last_dist.probs-prob).abs().max())
            maximum = max(maximum,error)
            if not torch.allclose(owner.last_dist.probs,prob,atol=3e-5,rtol=3e-4):
                raise AssertionError(f"Probability parity: {tick}/{i}/{error}")
            if not torch.equal(actual,action) or not torch.equal(owner.generator.get_state(),ref_rngs[i]):
                raise AssertionError(f"Per-client RNG parity: {tick}/{i}")
            if mlx:
                if owner.mlx_step != counters[i]:raise AssertionError("MLX cache position")
                for cache in owner.mlx_network.cache:
                    if cache is not None and (cache[0].shape[2]>97 or cache[1].shape[2]>97):
                        raise AssertionError("MLX cache exceeded window")
            else:
                for name in ("key_cache","val_cache"):
                    x,y = getattr(states[i],name).data,getattr(refs[i],name).data
                    error = float(torch.nan_to_num(x-y).abs().max())
                    cache_max = max(cache_max,error)
                    if not torch.allclose(x,y,atol=3e-4,rtol=3e-4,equal_nan=True):
                        raise AssertionError(f"Cache parity: {tick}/{i}/{name}/{error}")
                if not torch.equal(states[i].seq_lens,refs[i].seq_lens):raise AssertionError("Cache position")
            choices += 1
    if digest(a.checkpoint)!=checkpoint_sha:raise ValueError("Checkpoint changed during parity")
    report = {"pass":True,"backend":a.backend,"checkpointSha256":checkpoint_sha,"decisions":choices,"streamSteps":counters,
              "maxProbabilityError":maximum,"maxCacheError":cache_max,
              "nativeSamplingParity":True, "batching":batcher.stats}
    if mlx:
        report.pop("maxCacheError")
        report.update(independentCPUReference=True,mlxCacheWindowBound=97,
                      mlxConfigSha256=digest(a.mlx_config))
    if reference:
        report["cpuReference"] = {"pass":True,"maxProbabilityError":cpu_max,"maxCacheError":cpu_cache_max}
    a.out.write_text(json.dumps(report,indent=2))
    print(json.dumps(report))


if __name__ == "__main__":
    main()
