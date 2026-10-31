"""Run the native fine-tuner with resumable epoch boundaries and local metrics.

Accelerate owns weights, optimizer, scheduler and RNG. Its custom checkpoint API
also stores the next epoch, real update count and the Python advantage-filter
history, which the upstream weight-only continuation does not preserve.
"""
import argparse
from collections import deque
from functools import partial
import hashlib
import json
import os
from pathlib import Path
import random
import runpy
import shutil
import sys
import time

import numpy as np
import torch
from metamon.rl.metamon_to_amago import MetamonAMAGOExperiment


def bounded_nstep_return(r,d,q,gamma,mask,n):
    # Native nstep_return pads shifted tensors to i, which exceeds the sequence
    # length when n > L. A horizon beyond the whole sampled window is identical
    # to L; retain the native targets, including bootstrap at truncated windows.
    from amago.agent import nstep_return
    return nstep_return(r,d,q,gamma,n=min(n,r.shape[1]),mask=mask)


def set_critic_warmup(experiment,updates):
    """Fit outcome values before using them to move the inherited policy."""
    e,p = experiment,experiment.policy
    if not hasattr(e,"_generation_primary"):
        modules = [p.tstep_encoder,p.traj_encoder,p.actor]
        e._generation_primary = (modules,[(v,v.requires_grad) for m in modules for v in m.parameters()],
                                 p.offline_coeff,p.bc_coeff)
    modules,parameters,offline,bc = e._generation_primary
    warming = e.grad_update_counter<updates
    for module in modules:module.train(False if warming else p.training)
    for parameter,enabled in parameters:parameter.requires_grad_(enabled and not warming)
    p.offline_coeff,p.bc_coeff = (0.,0.) if warming else (offline,bc)
    return warming


def primary_optimizer(policy,learning_rate,weight_decay):
    """Keep primary learning separate from critic and auxiliary parameters."""
    primary={id(p) for m in (policy.tstep_encoder,policy.traj_encoder,policy.actor) for p in m.parameters()}
    parameters=list(policy.trainable_params)
    if len(parameters)!=len({id(p) for p in parameters}):raise ValueError('Duplicate trainable parameter')
    groups=[dict(params=[p for p in parameters if (id(p) in primary)==actor],generationRole=role)
            for actor,role in [(True,'actor'),(False,'critic')]]
    if any(not g['params'] for g in groups):raise ValueError('Primary and critic optimizer groups required')
    return torch.optim.AdamW(groups,lr=learning_rate,weight_decay=weight_decay)


def primary_schedule(optimizer,critic_updates,actor_updates,num_warmup_steps,last_epoch=-1):
    """The first released primary update uses 1/ramp of its target LR."""
    if critic_updates<0 or actor_updates<1:raise ValueError('Bounded primary warmup required')
    if [g.get('generationRole') for g in optimizer.param_groups]!=['actor','critic']:
        raise ValueError('Generation optimizer group order changed')
    actor=lambda step:max(0.,min(1.,(step-critic_updates+1)/actor_updates))
    critic=lambda step:min(1.,step/max(1,num_warmup_steps))
    return torch.optim.lr_scheduler.LambdaLR(optimizer,[actor,critic],last_epoch=last_epoch)


def save_training_checkpoint(experiment,save,identity,keep=2):
    """Publish readiness after native save; retain the latest native resume states."""
    e = experiment
    save(e)  # A failed/partial save never publishes readiness or prunes history.
    root = Path(e.ckpt_dir)
    weights = root/"policy_weights"/f"policy_epoch_{e.epoch}.pt"
    ready = weights.with_suffix(".ready.json")
    temp = ready.with_suffix(".tmp")
    temp.write_text(json.dumps({"epoch":e.epoch,"nextEpoch":e.epoch+1,
        "updates":e.grad_update_counter,"identity":identity,"policyBytes":weights.stat().st_size}))
    temp.replace(ready)
    prefix = e.run_name+"_epoch_"
    states = [p for p in (root/"training_states").glob(prefix+"*")
              if p.name[len(prefix):].isdigit()]
    states.sort(key=lambda p:int(p.name[len(prefix):]))
    for old in states[:-keep]:
        if old.is_symlink() or not old.is_dir():raise ValueError("Unsafe native checkpoint state path")
        shutil.rmtree(old)
    print(json.dumps({"event":"checkpoint_ready","epoch":e.epoch,"updates":e.grad_update_counter,
        "retainedTrainingStates":[p.name for p in states[-keep:]]}),flush=True)


class RunState:
    def __init__(self,experiment,identity):
        self.experiment,self.identity = experiment,identity

    def state_dict(self):
        e = self.experiment;f = e.policy.fbc_filter_func
        seq = None
        if f.seq_enabled:
            seq = {"buffer":list(f._seq_buffer),"maxlen":f._seq_buffer.maxlen,"step":f._seq_step}
        return {"identity":self.identity,"nextEpoch":e.epoch+1,
                "gradientUpdates":e.grad_update_counter,"sequenceFilter":seq}

    def load_state_dict(self,state):
        if state["identity"]!=self.identity:raise ValueError("Training resume identity mismatch")
        e = self.experiment;f = e.policy.fbc_filter_func
        seq = state["sequenceFilter"]
        if bool(seq is not None)!=bool(f.seq_enabled):raise ValueError("Filter resume mismatch")
        if seq is not None:
            if seq["maxlen"]!=f._seq_buffer.maxlen:raise ValueError("Filter capacity mismatch")
            f._seq_buffer = deque(seq["buffer"],maxlen=seq["maxlen"])
            f._seq_step = seq["step"];f._seq_sorted_cache = None;f._seq_cache_dirty = True
        e.epoch = state["nextEpoch"];e.grad_update_counter = state["gradientUpdates"]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--identity",required=True,type=Path)
    p.add_argument("--resume",type=Path)
    p.add_argument("--mixed-precision",choices=["no","bf16"],default="no")
    p.add_argument("--deterministic",action="store_true")
    p.add_argument("--seed",type=int,default=2718)
    p.add_argument("--critic-warmup-updates",type=int,default=0)
    p.add_argument("--actor-warmup-updates",type=int,default=0)
    p.add_argument("--soft-policy",type=Path)
    p.add_argument("--data-manifest",type=Path)
    a,trainer = p.parse_known_args()
    if a.critic_warmup_updates<0:raise ValueError("Nonnegative critic warmup required")
    if a.actor_warmup_updates<0:raise ValueError('Nonnegative actor warmup required')
    if trainer[:1]==["--"]:trainer = trainer[1:]
    identity = hashlib.sha256(a.identity.read_bytes()).hexdigest()
    declared = json.loads(a.identity.read_text())
    if declared.get('deterministic', False) != a.deterministic:
        raise ValueError('Determinism differs from frozen identity')
    if a.deterministic:
        if os.environ.get('CUBLAS_WORKSPACE_CONFIG') != ':4096:8':
            raise ValueError('Registered deterministic cuBLAS workspace required')
        torch.use_deterministic_algorithms(True)
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    if declared.get('actorWarmupUpdates',0)!=a.actor_warmup_updates:
        raise ValueError('Actor warmup differs from frozen identity')
    if a.data_manifest:
        from filter_families import install_manifest_allowlist
        membership = install_manifest_allowlist(a.data_manifest,declared["dataProof"]["verifiedPOVs"])
        if membership["manifestSha256"] != declared["dataProof"]["manifestSha256"]:
            raise ValueError("Training manifest changed after preflight")
        if membership["resolvedFiles"] != declared["dataProof"]["verifiedPOVs"]:
            raise ValueError("Resolved loader membership disagrees with preflight")
        print(json.dumps({"event":"manifest_loader_allowlist",**membership}),flush=True)
    soft = None
    if a.soft_policy:
        from soft_policy import install_sampler,training_plan
        soft = training_plan(a.soft_policy,a.data_manifest,declared["purpose"],declared["dataProof"]["verifiedPOVs"])
        if soft!=declared["softPolicy"] or a.critic_warmup_updates or a.actor_warmup_updates:
            raise ValueError("Distillation plan differs from the frozen training identity")
        install_sampler(soft,a.data_manifest)
    torch.manual_seed(a.seed);np.random.seed(a.seed);random.seed(a.seed)
    torch.distributions.Distribution.set_default_validate_args(False)
    initialize,start,load,step,save_checkpoint = (MetamonAMAGOExperiment.__post_init__,MetamonAMAGOExperiment.start,
        MetamonAMAGOExperiment.load_checkpoint_from_path,MetamonAMAGOExperiment.train_step,MetamonAMAGOExperiment.save_checkpoint)
    native_optimizer=MetamonAMAGOExperiment.init_optimizer
    def optimizer(e,policy):
        return primary_optimizer(policy,e.learning_rate,e.l2_coeff) if a.actor_warmup_updates else native_optimizer(e,policy)
    def init(e):
        e.mixed_precision = a.mixed_precision
        initialize(e)
    def begin(e):
        if a.actor_warmup_updates:
            from amago import utils
            native_schedule=utils.get_constant_schedule_with_warmup
            utils.get_constant_schedule_with_warmup=partial(primary_schedule,
                critic_updates=a.critic_warmup_updates,actor_updates=a.actor_warmup_updates)
            try:start(e)
            finally:utils.get_constant_schedule_with_warmup=native_schedule
        else:start(e)
        e.verbose = False;e.always_save_latest = False
        if soft:
            from soft_policy import install_actor
            install_actor(e.policy,soft["anchorWeight"])
        e.policy._nstep_fn = partial(bounded_nstep_return,n=e.policy.n_step)
        # This pinned agent's load_state_dict omits PyTorch's return value;
        # safetensors.load_model requires it. Accelerate's native PyTorch
        # serialization restores the same model/optimizer/RNG without that
        # incompatible adapter. Never edit an existing checkpoint in place.
        save_state = e.accelerator.save_state
        def save(*args,**kwargs):
            kwargs["safe_serialization"] = False
            return save_state(*args,**kwargs)
        e.accelerator.save_state = save
        e.accelerator.register_for_checkpointing(RunState(e,identity))
        print(json.dumps({"event":"training_runtime","nStep":e.policy.n_step,"precision":e.mixed_precision,
            "deterministic":a.deterministic,
            "criticWarmupUpdates":a.critic_warmup_updates,"actorWarmupUpdates":a.actor_warmup_updates,"identity":identity}),flush=True)
    def restore(e,path,is_accelerate_state=True):
        if a.resume is not None:
            load(e,str(a.resume),is_accelerate_state=True)
            print(json.dumps({"event":"resumed","nextEpoch":e.epoch,"updates":e.grad_update_counter}),flush=True)
        else:load(e,path,is_accelerate_state)
    previous = None
    def update(e,batch,log_step):
        nonlocal previous
        warming = set_critic_warmup(e,a.critic_warmup_updates)
        rates={g['generationRole']:g['lr'] for g in e.optimizer.param_groups} if a.actor_warmup_updates else {}
        result = step(e,batch,log_step)
        gradients = [torch.isfinite(p.grad).all() for p in e.policy.parameters() if p.grad is not None]
        if not gradients or not bool(torch.stack(gradients).all()):raise FloatingPointError("Nonfinite or absent gradients")
        now = time.monotonic()
        row = {"nativeEpochCounter":e.epoch,"updates":e.grad_update_counter,"batch":int(batch.actions.shape[0]),
               "criticWarmup":warming,"wallSeconds":None if previous is None else now-previous}
        if rates:row.update(actorLearningRate=rates['actor'],criticLearningRate=rates['critic'])
        for key,value in result.items():
            if isinstance(value,(int,float)) or isinstance(value,torch.Tensor) and value.numel()==1:
                scalar = float(value)
                if not np.isfinite(scalar):
                    if "loss" in key.lower() or "grad" in key.lower():raise FloatingPointError(key)
                    scalar = None
                row[key] = scalar
        previous = now
        with a.out.open("a") as stream:stream.write(json.dumps(row)+"\n")
        return result
    MetamonAMAGOExperiment.__post_init__ = init
    MetamonAMAGOExperiment.init_optimizer = optimizer
    MetamonAMAGOExperiment.start = begin
    MetamonAMAGOExperiment.load_checkpoint_from_path = restore
    MetamonAMAGOExperiment.train_step = update
    MetamonAMAGOExperiment.save_checkpoint = lambda e:save_training_checkpoint(e,save_checkpoint,identity)
    sys.argv = ["metamon.rl.finetune",*trainer]
    runpy.run_module("metamon.rl.finetune",run_name="__main__")


if __name__=="__main__":main()
