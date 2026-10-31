"""finetune.sh for hosts without bash/setsid (Windows; macOS): fine-tune UUKakuna from epoch 34 on a mixed dataset YAML.

Usage: python finetune_portable.py --run RUN --name NAME --mix config/uu-iter2-mix.yaml --epochs E --steps S --every N
         [--arm ARM] [--metrics offline] [--remap OLD=NEW ...] [--seconds 28800] [--min-available-gb 5]
         [--start-available-gb 0] [--sample-seconds 10] [--dloader-workers 2] [--seed S]

Same trainer defaults as finetune.sh (batch_size_per_gpu 2, grad_accum 4; --batch-size / --grad-accum override them,
dloader_workers 2 unless set, no eval gens, ARM's
learning_rate / lr_warmup_steps / seq_floor_warmup_steps written to RUN/NAME.gin on top of RUN/finetune-flex.gin), plus
--async_env_mp_context spawn on Windows (no forkserver; no eval envs are built), and dynamo's TorchPatcher.patch()
before the trainer (see below; validation never changes values); --seed S seeds python, numpy and torch in the trainer
process first (Metamon/amago take no seed; CUDA kernels stay nondeterministic, so arms match in seed, not bitwise). RUN/env.json is the trainer
environment: it must set AMAGO_FLEX_TRAIN_EAGER=1 and its first PYTHONPATH amago must carry flex_train_eager.py's patch
(eager flex is exact; flex_probe.py). --remap rewrites custom_replays dir prefixes (the mix YAML's project-relative dirs) into
RUN/NAME.yaml; every dir must hold gen9uu/. The trainer runs in a block_portable Container (Windows Job Object,
kill-on-close) with a deadline, and is stopped if host available RAM falls below --min-available-gb (owner floor).
Writes RUN/NAME.yaml, RUN/NAME-jobs.json, RUN/logs/NAME-{before,after,lifecycle}.json, NAME-finetune.log, NAME-samples.jsonl
(RAM/VRAM every --sample-seconds), NAME-metrics.jsonl (train_metrics.py, with --metrics offline) and NAME.done;
checkpoints under RUN/checkpoints/NAME. Exit 0 only when the trainer completed with return code 0 and left nothing.
"""
import argparse, hashlib, json, os, pathlib, re, shutil, sys, time, zipfile

import psutil
import yaml

from block_portable import Container, WIN, gpu_by_pid, receipt, stop
from candidate_worker import policy_members, training_checkpoint_args
from filter_families import validate_training_data

K = pathlib.Path(__file__).resolve().parent


def rss_of(p):
    try:
        return p.memory_info().rss
    except psutil.Error:  # exited between listing and reading
        return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, type=pathlib.Path); ap.add_argument("--name", required=True)
    ap.add_argument("--mix", required=True, type=pathlib.Path); ap.add_argument("--arm", default="")
    ap.add_argument("--epochs", required=True, type=int); ap.add_argument("--steps", required=True, type=int)
    ap.add_argument("--every", required=True, type=int); ap.add_argument("--metrics", choices=["", "offline"], default="")
    ap.add_argument("--remap", action="append", default=[]); ap.add_argument("--seconds", type=float, default=28800)
    ap.add_argument("--grace", type=float, default=60); ap.add_argument("--min-available-gb", type=float, default=0)
    ap.add_argument("--start-available-gb", type=float, default=0); ap.add_argument("--sample-seconds", type=float, default=10)
    ap.add_argument("--dloader-workers", type=int, default=2, help="finetune.sh uses 2; fewer saves host RAM, same samples")
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--training-probe", action="store_true", help="measure real updates without saving weights")
    ap.add_argument("--mixed-precision","--probe-precision",dest="precision",choices=["no","bf16"],default="no")
    ap.add_argument("--generation-training",action="store_true")
    ap.add_argument("--resume",type=pathlib.Path)
    ap.add_argument("--policies",type=pathlib.Path)
    ap.add_argument("--initial-policy",default="G0")
    ap.add_argument("--critic-warmup-updates",type=int,default=0)
    ap.add_argument("--actor-warmup-updates",type=int,default=0)
    ap.add_argument("--reward-function",help="Explicit native dataset and trainer reward class")
    ap.add_argument("--training-purpose",choices=["qualification","generation"],default="qualification")
    ap.add_argument("--data-manifest",type=pathlib.Path)
    ap.add_argument("--panel",type=pathlib.Path)
    ap.add_argument("--soft-policy",type=pathlib.Path,help="fixed causal-teacher distillation plan")
    ap.add_argument("--seed", type=int, default=None, help="seed python/numpy/torch before the trainer (default: unseeded)")
    a = ap.parse_args()
    if a.batch_size < 1 or a.grad_accum < 1:
        raise ValueError("batch-size and grad-accum must be positive")
    if not re.fullmatch(r"[A-Za-z0-9_-]+",a.name):raise ValueError("Portable run name required")
    if a.training_probe and a.generation_training:raise ValueError("Choose probe or generation training")
    if a.precision!="no" and not (a.training_probe or a.generation_training):
        raise ValueError("Precision override requires a qualified training runtime")
    if a.resume and not a.generation_training:raise ValueError("Resume requires generation training")
    if a.critic_warmup_updates<0 or a.critic_warmup_updates and not a.generation_training:
        raise ValueError("Critic warmup requires generation training and nonnegative updates")
    if a.actor_warmup_updates<0 or a.actor_warmup_updates and not a.generation_training:
        raise ValueError('Actor warmup requires generation training and nonnegative updates')
    if a.reward_function and not a.generation_training:
        raise ValueError("Reward override requires qualified generation training")
    if a.training_purpose=="generation" and not (a.generation_training and a.data_manifest and a.panel):
        raise ValueError("Generation training requires the qualified runtime, data manifest and panel")
    if bool(a.data_manifest)!=bool(a.panel):raise ValueError("Data manifest and panel must be supplied together")
    soft = None
    if a.soft_policy:
        if not a.generation_training or not a.data_manifest or a.critic_warmup_updates or a.actor_warmup_updates or a.initial_policy!="G0":
            raise ValueError("Distillation requires e34, qualified data and no critic warmup")
    run = a.run.resolve(); logs = run / "logs"; logs.mkdir(exist_ok=True)
    stem = a.name if not a.resume else f"{a.name}-resume-{len(list(run.glob(a.name+'-resume-*-training-source.zip')))}"
    env = {**os.environ, **json.loads((run / "env.json").read_text())}
    initial,initial_args = None,[]
    if a.generation_training or a.policies:
        members = policy_members(a.policies,pathlib.Path(env["UU_KAKUNA_CKPT"]))
        initial = next((m for m in members if m["name"]==a.initial_policy),None)
        if initial is None:raise ValueError("Declared initial policy is missing")
        initial_args = training_checkpoint_args(initial)
        (run/f"{stem}-initial.json").write_text(json.dumps(initial,indent=2))
    elif a.initial_policy!="G0":raise ValueError("Initial policy requires a member manifest")
    if (run / "checkpoints" / a.name).exists() and not a.resume:
        raise SystemExit(f"run exists: {a.name}")
    if a.resume and not a.resume.resolve().is_relative_to(run/"checkpoints"/a.name/"ckpts/training_states"):
        raise ValueError("Resume must be this run's native training-state directory")
    if env.get("AMAGO_FLEX_TRAIN_EAGER") != "1":
        raise SystemExit("env.json must set AMAGO_FLEX_TRAIN_EAGER=1")
    tr = next((pathlib.Path(p, "amago/nets/transformer.py") for p in env["PYTHONPATH"].split(os.pathsep)
               if pathlib.Path(p, "amago/nets/transformer.py").is_file()), None)
    if tr is None or "_FLEX_TRAIN_EAGER" not in tr.read_text():
        raise SystemExit(f"first amago on PYTHONPATH lacks the eager flex training patch: {tr}")
    if (avail := psutil.virtual_memory().available / 2**30) < a.start_available_gb:
        raise SystemExit(f"available RAM {avail:.1f} GB < {a.start_available_gb} GB to start")

    cfg = yaml.safe_load(a.mix.read_text())
    remaps = [r.split("=", 1) for r in a.remap]
    for c in cfg["custom_replays"]:
        for old, new in remaps:
            if c["dir"].startswith(old):
                c["dir"] = str(pathlib.Path(new + c["dir"][len(old):]))
    missing = [c["dir"] for c in cfg["custom_replays"] if not pathlib.Path(c["dir"], "gen9uu").is_dir()]
    if missing:
        raise SystemExit(f"missing custom_replays dirs: {missing}")
    data_proof = validate_training_data(a.data_manifest.resolve(),a.panel.resolve(),[c["dir"] for c in cfg["custom_replays"]]) if a.data_manifest else None
    if a.soft_policy:
        from soft_policy import training_plan
        soft = training_plan(a.soft_policy,a.data_manifest,a.training_purpose,[c["dir"] for c in cfg["custom_replays"]])
        if (soft["finalEpoch"]+1)*a.steps!=soft["updates"] or a.epochs*a.steps>soft["updates"]:
            raise ValueError("Soft-training checkpoint schedule differs from the fixed plan")
    arms = cfg.pop("arms", {})
    (run / f"{a.name}.yaml").write_text(yaml.safe_dump(cfg, sort_keys=False))
    gin = run / "finetune-flex.gin"
    if a.arm:
        x = arms[a.arm]
        gin = run / f"{a.name}.gin"
        gin.write_text(f"include '{(run / 'finetune-flex.gin').as_posix()}'\n"
                       f"MetamonAMAGOExperiment.learning_rate = {x['learning_rate']}\n"
                       f"MetamonAMAGOExperiment.lr_warmup_steps = {x['lr_warmup_steps']}\n"
                       f"custom_agent.ISAdvantageFilter.seq_floor_warmup_steps = {x['seq_floor_warmup_steps']}\n")
    # With dynamo off (TORCHDYNAMO_DISABLE=1: no triton on Windows) torch never runs TorchPatcher.patch(), which on Linux
    # runs at the first compiled call and turns torch.distributions argument validation off process-wide; amago's
    # padded batches (pad 4.0 clamped to 1, masked out of the loss) then fail OneHotCategorical validation. Apply it.
    seed = (f"import random, numpy, torch; random.seed({a.seed}); numpy.random.seed({a.seed}); torch.manual_seed({a.seed}); "
            if a.seed is not None else "")
    boot = (seed + "import runpy, sys, torch._dynamo.eval_frame as e; e.TorchPatcher.patch(); "
            "sys.argv[0] = 'metamon.rl.finetune'; runpy.run_module('metamon.rl.finetune', run_name='__main__', alter_sys=True)")
    argv = [env["PY"], "-X", "utf8", "-c", boot, "--run_name", a.name, "--save_dir", str(run / "checkpoints"),
            "--base_model", "UUKakuna", "--base_checkpoint", "34", "--dataset_config", str(run / f"{a.name}.yaml"),
            "--train_gin_config", str(gin), "--epochs", str(a.epochs), "--steps_per_epoch", str(a.steps),
            "--batch_size_per_gpu", str(a.batch_size), "--grad_accum", str(a.grad_accum), "--ckpt_interval", str(a.every), "--dloader_workers", str(a.dloader_workers),
            *(["--async_env_mp_context", "spawn"] if WIN else []), "--eval_gens", *initial_args, *(["--log"] if a.metrics else [])]
    if a.reward_function:argv += ["--reward_function",a.reward_function]
    if a.training_probe or a.generation_training:
        archive = run / f"{stem}-{'probe' if a.training_probe else 'training'}-source.zip"
        filenames = ("training_probe.py", "generation_train.py", "training_attention.py", "finetune_portable.py", "block_portable.py", "candidate_worker.py", "export_candidate.py", "filter_families.py", "soft_policy.py")
        with zipfile.ZipFile(archive, "x") as source:
            for filename in filenames:
                source.writestr(filename, (K / filename).read_bytes())
        env["PYTHONPATH"] = str(archive) + os.pathsep + env["PYTHONPATH"]
        options = []
        if a.generation_training:
            identity = {"batch":a.batch_size,"gradAccum":a.grad_accum,"stepsPerEpoch":a.steps,
                "precision":a.precision,"seed":a.seed,"loaderWorkers":a.dloader_workers,"initial":initial,
                "criticWarmupUpdates":a.critic_warmup_updates,
                "actorWarmupUpdates":a.actor_warmup_updates,
                "rewardFunction":a.reward_function,
                "softPolicy":soft,
                "purpose":a.training_purpose,"dataProof":data_proof,
                "mix":hashlib.sha256((run/f"{a.name}.yaml").read_bytes()).hexdigest(),
                "gin":hashlib.sha256(gin.read_bytes()).hexdigest(),
                "environment":hashlib.sha256((run/"env.json").read_bytes()).hexdigest(),
                "source":{f:hashlib.sha256((K/f).read_bytes()).hexdigest() for f in filenames}}
            path = run/f"{a.name}-identity.json"
            encoded = json.dumps(identity,sort_keys=True,indent=2)
            if a.resume:
                if path.read_text()!=encoded:raise ValueError("Resume recipe/source changed")
                options += ["--resume",str(a.resume.resolve())]
            else:path.write_text(encoded)
            options += ["--identity",str(path),"--seed",str(a.seed if a.seed is not None else 2718),
                        "--critic-warmup-updates",str(a.critic_warmup_updates),
                        "--actor-warmup-updates",str(a.actor_warmup_updates)]
            if a.data_manifest:options += ["--data-manifest",str(a.data_manifest.resolve())]
            if soft:options += ["--soft-policy",str(a.soft_policy.resolve())]
        argv = [env["PY"], "-X", "utf8", "-m", "training_probe" if a.training_probe else "generation_train", "--out",
                str(logs / f"{stem}-{'probe' if a.training_probe else 'updates'}.jsonl"),
                "--mixed-precision",a.precision,*options,"--",*argv[5:]]
    (run / f"{stem}-jobs.json").write_text(json.dumps([{"argv": argv, "cwd": str(run)}], indent=1))
    env["TORCHINDUCTOR_COALESCE_TILING_ANALYSIS"] = "0"
    if a.metrics:
        env |= {"WANDB_MODE": "offline", "WANDB_CONSOLE": "off"}

    (logs / f"{stem}-before.json").write_text(json.dumps(receipt(run, "before"), indent=1))
    c = Container(a.name, argv, str(run), logs / f"{stem}-finetune.log", env)
    t0, reason, peak = time.monotonic(), None, {"rss_mb": 0.0, "gpu_dedicated_mb": 0.0, "gpu_shared_mb": 0.0}
    avail_min = psutil.virtual_memory().available / 2**30
    with open(logs / f"{stem}-samples.jsonl", "x") as samples:
        while c.active():
            procs = c.processes()
            rss = sum(rss_of(p) for p in procs) / 2**20
            gpu = gpu_by_pid({p.pid for p in procs})
            avail = psutil.virtual_memory().available / 2**30
            avail_min = min(avail_min, avail)
            peak = {"rss_mb": max(peak["rss_mb"], rss), "gpu_dedicated_mb": max(peak["gpu_dedicated_mb"], gpu.get("dedicated", 0.0)),
                    "gpu_shared_mb": max(peak["gpu_shared_mb"], gpu.get("shared", 0.0))}
            samples.write(json.dumps({"t": round(time.monotonic() - t0, 1), "rss_mb": round(rss), "procs": len(procs),
                                      "available_gb": round(avail, 2), **{f"gpu_{k}_mb": v for k, v in gpu.items()}}) + "\n")
            samples.flush()
            if avail < a.min_available_gb:
                reason = "memory_available"; print(f"memory guard: available {avail:.1f} GB < {a.min_available_gb} GB", flush=True)
                break
            if time.monotonic() - t0 > a.seconds:
                reason = "deadline"; break
            time.sleep(a.sample_seconds)
    survivors = stop([c], a.grace) if reason else []
    rc = c.proc.wait(timeout=30) if not c.active() else None
    life = {"reason": reason or ("completed" if rc == 0 else "trainer_failed"), "returncode": rc, "elapsed_s": round(time.monotonic() - t0, 1),
            "survivors": survivors, "peak_job_commit_mb": round(c.peak_commit_mb(), 1) if WIN else None,
            "peak": {k: round(v, 1) for k, v in peak.items()}, "host_available_min_gb": round(avail_min, 2)}
    c.close()
    (logs / f"{stem}-lifecycle.json").write_text(json.dumps(life, indent=1))
    (logs / f"{stem}-after.json").write_text(json.dumps(receipt(run, "after"), indent=1))
    if a.metrics:
        with open(logs / f"{a.name}-metrics.jsonl", "w") as out, open(logs / f"{a.name}-metrics.err", "w") as err:
            import subprocess
            if subprocess.run([env["PY"], str(K / "train_metrics.py"), str(run / "checkpoints" / a.name)], stdout=out, stderr=err, env=env).returncode:
                print(f"metrics dump failed: see {err.name}")
    # Optimizer snapshots cannot resume a run exactly (see finetune.sh); ~2.3 GB each. KEEP_TRAINING_STATES=1 keeps them.
    if not a.generation_training and os.environ.get("KEEP_TRAINING_STATES") != "1":
        shutil.rmtree(run / "checkpoints" / a.name / "ckpts" / "training_states", ignore_errors=True)
    (logs / f"{stem}.done").write_text(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n")
    print(json.dumps(life))
    sys.exit(0 if life["reason"] == "completed" and rc == 0 and not survivors else 1)


if __name__ == "__main__":
    main()
