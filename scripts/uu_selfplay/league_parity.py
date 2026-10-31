"""Check a native league export on CPU SDPA and the existing GPU attention path.

Only a public-training simulator fixture is accepted. Recorded commits build the
inputs through the pinned decoder; repeated inputs exercise cache rollover. This
probe does not connect to a battle server or change the league implementation.
"""
import argparse
import functools
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import zipfile


def digest(path):
    with Path(path).open("rb") as stream:return hashlib.file_digest(stream,"sha256").hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run",required=True,type=Path)
    p.add_argument("--policies",required=True,type=Path)
    p.add_argument("--member",required=True)
    p.add_argument("--fixture",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--steps",type=int,default=150)
    a = p.parse_args()
    if a.steps < 130:raise ValueError("Exercise window and cache rollover")
    cfg = json.loads((a.run/"env.json").read_text())
    os.environ.update(cfg)
    os.environ.update(ACCELERATE_USE_CPU="true",TORCHDYNAMO_DISABLE="1",WANDB_MODE="disabled")
    sys.path[:0] = cfg["PYTHONPATH"].split(os.pathsep)
    kit = Path(__file__).resolve().parent
    sys.path.insert(0,str(kit.parent/"metamon_port"))
    import common
    from torch_backend import dense_window
    from candidate_worker import policy_members,worker_module
    import torch
    torch.set_num_threads(1)
    if not torch.cuda.is_available():raise RuntimeError("Native GPU unavailable")
    members = policy_members(a.policies,Path(cfg["UU_KAKUNA_CKPT"]))
    member = next(m for m in members if m["name"]==a.member)
    checkpoint = Path(member["path"])
    receipt = json.loads(Path(str(checkpoint)+".receipt.json").read_text())
    if receipt.get("training_eligible") is not True:raise ValueError("Generation-trained export required")
    fixture = json.loads(a.fixture.read_text())
    if not fixture["source"].startswith("independent native simulator; public training-split"):
        raise ValueError("Public training fixture required")
    a.out.mkdir(parents=True,exist_ok=False)
    source_files = [Path(__file__),kit/"league_serve.py",kit/"windowed_attention.py",kit/"candidate_worker.py",
        kit/"export_candidate.py",kit.parent/"metamon_port/common.py",kit.parent/"metamon_port/torch_backend.py",
        kit.parent/"metamon-worker.py"]
    with zipfile.ZipFile(a.out/"producer.zip","x",zipfile.ZIP_DEFLATED) as z:
        for path in source_files:z.write(path,str(path.relative_to(kit.parents[1])))
    (a.out/"producer.json").write_text(json.dumps({str(f):digest(f) for f in source_files},indent=2))
    asset = a.out/"assets/ckpts/policy_weights"/checkpoint.name
    asset.parent.mkdir(parents=True)
    os.link(checkpoint,asset)
    os.environ["UU_EXPORT_DIR"] = str(asset.parent.resolve())
    # This is exactly the registry class selected by block_portable --league.
    spec = importlib.util.spec_from_file_location("parity_league_serve",kit/"league_serve.py")
    league = importlib.util.module_from_spec(spec);spec.loader.exec_module(league);league.register()
    from metamon.rl.pretrained import get_pretrained_model
    import windowed_attention
    worker = worker_module()
    worker.check_runtime(Path(cfg["UU_KAKUNA_CKPT"]))
    maker = get_pretrained_model("UUExport")
    experiment = maker.initialize_agent(checkpoint=member["epoch"],log=False)
    policy = experiment.policy.eval()
    from amago.nets.transformer import SelfAttention
    layers = [m for m in policy.traj_encoder.modules() if isinstance(m,SelfAttention)]
    if len(layers)!=10 or any(type(m) is not windowed_attention.SlidingWindowVanillaAttention or m.window_size!=96 for m in layers):
        raise ValueError("Require the existing native window-96 league path")
    if digest(windowed_attention.__file__) != digest(kit/"windowed_attention.py"):
        raise ValueError("Installed league attention differs from retained source")
    native = [m.forward for m in layers]
    decoder = worker.SocketlessBattle();path = common.ObservationPath(maker,worker)
    sequence = []
    for row in fixture["rows"]:
        if row["op"]=="observe":decoder.observe(row["data"],row["context"])
        elif row["op"]=="propose" and row["executedChoice"]["kind"]!="team":
            obs,rl2,times,*_ = path.prepare(decoder.battle,decoder.request,row["executedChoice"])
            tensor = lambda x:torch.from_numpy(x).clone().unsqueeze(1)
            sequence.append({"obs":{k:tensor(v) for k,v in obs.items()},"rl2s":tensor(rl2),"time_idxs":tensor(times)})
            path.commit(row["executedChoice"])
    if not sequence:raise ValueError("Fixture has no neural decisions")
    captured,original = [],policy.actor.forward
    def actor(*args,**kwargs):
        distribution = original(*args,**kwargs);captured[:] = [distribution];return distribution
    policy.actor.forward = actor
    references,caches = [],{}
    maximum,cache_error = 0.,0.
    started = time.monotonic()
    for device in ("cpu","cuda"):
        policy.to(device)
        for layer,forward in zip(layers,native):
            layer.forward = functools.partial(dense_window,window=96) if device=="cpu" else forward
        hidden = policy.traj_encoder.init_hidden_state(1,torch.device(device))
        for step in range(a.steps):
            row = sequence[step%len(sequence)]
            with torch.no_grad():
                _,hidden = policy.get_actions(obs={k:v.to(device) for k,v in row["obs"].items()},
                    rl2s=row["rl2s"].to(device),time_idxs=torch.full_like(row["time_idxs"],step).to(device),
                    hidden_state=hidden,sample=False)
                probabilities = captured[-1].probs[0,-1,-1].float().cpu()
            if device=="cpu":references.append(probabilities.clone())
            else:
                maximum = max(maximum,float((probabilities-references[step]).abs().max()))
                if not torch.allclose(probabilities,references[step],atol=3e-5,rtol=3e-4) or probabilities.argmax()!=references[step].argmax():
                    raise AssertionError(f"Native league GPU probability parity failed at {step}: {maximum}")
            if step in (96,127,128,a.steps-1):
                state = [getattr(hidden,name).data.cpu().clone() for name in ("key_cache","val_cache")]
                if device=="cpu":caches[step] = state
                else:
                    for expected,actual in zip(caches[step],state):
                        cache_error = max(cache_error,float(torch.nan_to_num(expected-actual).abs().max()))
                        if not torch.allclose(expected,actual,atol=3e-4,rtol=3e-4,equal_nan=True):
                            raise AssertionError(f"Native league GPU cache parity failed at {step}: {cache_error}")
    if digest(checkpoint)!=member["sha256"]:raise ValueError("Checkpoint changed during parity")
    report = {"pass":True,"qualificationOnly":True,"steps":a.steps,"fixtureSha256":digest(a.fixture),
        "checkpointSha256":member["sha256"],"torch":torch.__version__,"hip":torch.version.hip,
        "maxProbabilityError":maximum,"maxCacheError":cache_error,"wallSeconds":time.monotonic()-started,
        "cpuReference":"dense SDPA window96","gpu":"unchanged native league attention"}
    (a.out/"report.json").write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)


if __name__ == "__main__":main()
