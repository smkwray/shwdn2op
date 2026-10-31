"""Bounded recurrent PPO primitives; native actors and terminal outcome targets."""
import copy
import hashlib
import json
import math
from pathlib import Path
import random

import numpy as np
import torch
import torch.nn.functional as F


RECIPE = dict(clip=.2, anchor_beta=.1, anchor_limit=.03, behavior_limit=.02,
              entropy_fraction=.5, entropy_coeff=.01, actor_lr=3e-5,
              actor_ramp=1000, value_lr=1e-3, grad_norm=.5, window=32, passes=4)
SCORES = {"LOSS":0., "DRAW":.5, "WIN":1.}


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def conditional(probabilities, legal):
    """Condition native temperature/clipped probabilities on executable indices."""
    if probabilities.shape != legal.shape or legal.dtype != torch.bool:
        raise ValueError("One exact boolean legal mask per distribution required")
    if not bool(torch.isfinite(probabilities).all()) or bool((probabilities<0).any()):
        raise ValueError("Finite nonnegative native probabilities required")
    mass = probabilities * legal
    total = mass.sum(-1,keepdim=True)
    if not bool(torch.isfinite(total).all()) or not bool((total>0).all()):raise ValueError("No finite executable probability mass")
    return mass / total


def categorical_kl(p,q):
    if p.shape!=q.shape or bool(((p>0)&(q<=0)).any()):
        raise ValueError("Matching categorical support required")
    return (p*(p.clamp_min(1e-30).log()-q.clamp_min(1e-30).log())).sum(-1)


def objective(p,old,anchor,actions,advantages,recipe=RECIPE,initial_anchor_kl=None):
    if (p.ndim!=2 or old.shape!=p.shape or anchor.shape!=p.shape
            or actions.shape!=(len(p),) or advantages.shape!=(len(p),)):
        raise ValueError("One action and fixed advantage per frame required")
    for q in (p,old,anchor):
        if (not bool(torch.isfinite(q).all()) or bool((q<0).any())
                or not torch.allclose(q.sum(-1),torch.ones_like(q.sum(-1)),atol=1e-5)):
            raise ValueError("Normalized finite distributions required")
    taken = lambda q:q.gather(-1,actions[:,None]).squeeze(-1)
    if bool((taken(old)<=0).any()) or bool((taken(p)<=0).any()):
        raise ValueError("Accepted action has zero probability")
    ratio = taken(p)/taken(old)
    surrogate = torch.minimum(ratio*advantages,
        ratio.clamp(1-recipe["clip"],1+recipe["clip"])*advantages)
    kl = categorical_kl(p,anchor)
    if initial_anchor_kl is not None:
        if (initial_anchor_kl.shape!=kl.shape or initial_anchor_kl.device!=kl.device
                or initial_anchor_kl.requires_grad or not bool(torch.isfinite(initial_anchor_kl).all())
                or bool((initial_anchor_kl<0).any())):
            raise ValueError("One fixed finite nonnegative initial-anchor KL per decision required")
        guard_kl=(kl-initial_anchor_kl).clamp_min(0)
    else:guard_kl=kl
    entropy = -(p*p.clamp_min(1e-30).log()).sum(-1)
    floor = recipe["entropy_fraction"]*(old>0).sum(-1).float().log()
    deficit = (floor-entropy).clamp_min(0)
    loss = -surrogate.mean()+recipe["anchor_beta"]*kl.mean()+recipe["entropy_coeff"]*deficit.mean()
    metrics = {"loss":float(loss.detach()),"anchorKL":float(kl.mean().detach()),
        "anchorGuardKL":float(guard_kl.mean().detach()),
        "behaviorKL":float(categorical_kl(old,p).mean().detach()),
        "entropy":float(entropy.mean().detach()),"entropyDeficit":float(deficit.mean().detach()),
        "clipFraction":float(((ratio-1).abs()>recipe["clip"]).float().mean()),
        "ratioMin":float(ratio.min().detach()),"ratioMax":float(ratio.max().detach())}
    if not math.isfinite(metrics["loss"]):raise FloatingPointError("PPO loss")
    return loss,metrics


def windows(length,size=32):
    if type(length)!=int or length<1 or size<1:raise ValueError("Nonempty episode required")
    # Each tuple is burn-in start, first scored frame, exclusive scored end.
    return [(0,start,min(length,start+size)) for start in range(0,length,size)]


def native_forward(policy,inputs,start,end):
    """Full prefix, native transformer; detach burn-in memory at every layer.

    Training mode stays eval to match collection (no dropout/spectral updates).
    A dense sliding-window SDPA replaces only the native attention kernel. The
    whole prefix is recomputed, so multilayer context and absolute times survive.
    """
    from types import MethodType
    from amago.nets.transformer import SlidingWindowFlexAttention,TransformerLayer
    if not 0<=start<end<=inputs["rl2s"].shape[1]:raise ValueError("Invalid recurrent window")
    times_all=inputs["time_idxs"]
    if (times_all.shape[0]!=1 or not torch.equal(times_all[0,:,0],
            torch.arange(times_all.shape[1],device=times_all.device))):
        raise ValueError("One uninterrupted episode from reset required")
    obs = {k:v[:,:end] for k,v in inputs["obs"].items()}
    rl2,times = inputs["rl2s"][:,:end],inputs["time_idxs"][:,:end]
    policy.eval()
    changed,hooks = [],[]
    def dense(module,qkv,key_cache=None,val_cache=None,cache_seqlens=None):
        if key_cache is not None or val_cache is not None:raise ValueError("Training uses full prefix")
        if start:qkv=torch.cat((qkv[:,:start].detach(),qkv[:,start:]),dim=1)
        q,k,v=qkv.unbind(2)
        index=torch.arange(q.shape[1],device=q.device)
        distance=index[:,None]-index[None,:]
        mask=((distance>=0)&(distance<=96))[None,None]
        return F.scaled_dot_product_attention(q.transpose(1,2),k.transpose(1,2),v.transpose(1,2),
            attn_mask=mask,dropout_p=0.).transpose(1,2)
    def detach_prefix(module,args,out):
        return torch.cat((out[:,:start].detach(),out[:,start:]),dim=1) if start else out
    try:
        for module in policy.traj_encoder.modules():
            if isinstance(module,SlidingWindowFlexAttention):
                changed.append((module,module.forward));module.forward=MethodType(dense,module)
            if isinstance(module,TransformerLayer):hooks.append(module.register_forward_hook(detach_prefix))
        if not changed:raise ValueError("Expected native sliding-window transformer")
        if start:
            with torch.no_grad():prefix=policy.tstep_encoder(obs={k:v[:,:start] for k,v in obs.items()},rl2s=rl2[:,:start])
            tail=policy.tstep_encoder(obs={k:v[:,start:] for k,v in obs.items()},rl2s=rl2[:,start:])
            embedded=torch.cat((prefix,tail),dim=1)
        else:embedded=policy.tstep_encoder(obs=obs,rl2s=rl2)
        features,_=policy.traj_encoder(embedded,time_idxs=times,hidden_state=None)
        dist=policy.actor(features[:,start:],straight_from_obs={k:obs[k][:,start:] for k in policy.pass_obs_keys_to_actor})
        return dist.probs[0,:,-1,:],features[0,start:]
    finally:
        for hook in hooks:hook.remove()
        for module,forward in changed:module.forward=forward


class OutcomeHead(torch.nn.Linear):
    def __init__(self,dimension):super().__init__(dimension,3)  # LOSS, DRAW, WIN

    def score(self,features):
        return self(features).softmax(-1) @ features.new_tensor([0.,.5,1.])


def calibration(logits,targets,battles,prior):
    if logits.ndim!=2 or logits.shape[1]!=3 or len(logits)!=len(targets) or not len(targets):
        raise ValueError("Nonempty WDL calibration split required")
    p=logits.softmax(-1);y=targets.float()/2
    score=p@p.new_tensor([0.,.5,1.]);prior=prior.to(p.device)
    if (len(battles)!=len(targets) or prior.shape!=(3,) or bool((prior<=0).any())
            or not torch.isclose(prior.sum(),prior.new_tensor(1.))):raise ValueError("Fit-split WDL prior and battle IDs required")
    bins=[]
    for low in range(10):
        mask=(score>=low/10)&((score<(low+1)/10) if low<9 else (score<=1))
        bins.append(dict(low=low/10,count=int(mask.sum()),predicted=float(score[mask].mean()) if mask.any() else None,
                         observed=float(y[mask].mean()) if mask.any() else None))
    values=torch.stack((F.cross_entropy(logits,targets,reduction="none"),(score-y)**2,score-y),dim=-1).detach().cpu().numpy()
    ids=sorted(set(battles));groups=np.asarray([values[np.asarray(battles)==battle].mean(0) for battle in ids])
    rng=np.random.default_rng(2718)
    boot=groups[rng.integers(len(groups),size=(1000,len(groups)))].mean(1)
    ci=np.quantile(boot,[.025,.975],axis=0)
    return dict(wdlLogLoss=float(values[:,0].mean()),scoreMSE=float(values[:,1].mean()),meanBias=float(values[:,2].mean()),
        fitPriorScoreMSE=float(((prior@p.new_tensor([0.,.5,1.])-y)**2).mean()),
        fitPriorLogLoss=float(-prior[targets].log().mean()),bins=bins,
        battleClustered=dict(battles=len(ids),resamples=1000,meanBattleMetrics=dict(zip(
            ("wdlLogLoss","scoreMSE","meanBias"),[dict(mean=float(groups[:,i].mean()),interval95=ci[:,i].tolist()) for i in range(3)]))))


class Learner:
    def __init__(self,policy,anchor,dimension,identity,recipe=None):
        self.policy,self.anchor,self.identity=policy,anchor,identity
        self.recipe=dict(RECIPE if recipe is None else recipe)
        if (self.recipe.keys()!=RECIPE.keys() or not 1<=self.recipe["passes"]<=4
                or not 1<=self.recipe["window"]<=32 or self.recipe["actor_ramp"]<1
                or any(not math.isfinite(float(v)) or v<0 for v in self.recipe.values())):
            raise ValueError("Finite bounded PPO recipe required")
        self.head=OutcomeHead(dimension).to(next(policy.parameters()).device)
        for name,p in policy.named_parameters():p.requires_grad_(name.startswith(("tstep_encoder.","traj_encoder.","actor.")))
        for p in anchor.parameters():p.requires_grad_(False)
        self.parameters=[p for p in policy.parameters() if p.requires_grad]
        self.actor=torch.optim.AdamW(self.parameters,lr=self.recipe["actor_lr"])
        self.value=torch.optim.AdamW(self.head.parameters(),lr=self.recipe["value_lr"])
        self.actor_steps=0;self.version=-1;self.pass_index=0;self.batch_sha=None;self.stopped=False

    def _state(self):
        return dict(policy=self.policy.state_dict(),head=self.head.state_dict(),actor=self.actor.state_dict(),
            value=self.value.state_dict(),actorSteps=self.actor_steps,version=self.version,passIndex=self.pass_index,
            batchSha=self.batch_sha,stopped=self.stopped,identity=self.identity,recipe=self.recipe,
            pythonRNG=random.getstate(),numpyRNG=np.random.get_state(),torchRNG=torch.get_rng_state(),
            cudaRNG=torch.cuda.get_rng_state_all() if next(self.policy.parameters()).is_cuda else None)

    def _restore(self,s):
        if s["identity"]!=self.identity or s["recipe"]!=self.recipe:raise ValueError("Resume identity/recipe drift")
        self.policy.load_state_dict(s["policy"],strict=True);self.head.load_state_dict(s["head"],strict=True)
        self.actor.load_state_dict(s["actor"]);self.value.load_state_dict(s["value"])
        self.actor_steps,self.version,self.pass_index=s["actorSteps"],s["version"],s["passIndex"]
        self.batch_sha,self.stopped=s["batchSha"],s["stopped"]
        random.setstate(s["pythonRNG"]);np.random.set_state(s["numpyRNG"]);torch.set_rng_state(s["torchRNG"])
        if s["cudaRNG"] is not None:torch.cuda.set_rng_state_all(s["cudaRNG"])

    def save(self,path):
        path=Path(path);temporary=path.with_suffix(".partial")
        torch.save(self._state(),temporary);temporary.replace(path)

    def resume(self,path):self._restore(torch.load(path,map_location="cpu",weights_only=False))

    def step(self,predict,old,anchor,actions,advantage,initial_anchor_kl=None):
        """Atomic actor step with exact categorical limits before and after."""
        if self.stopped:raise ValueError("Stopped version cannot update")
        if ("anchorGuard" in self.identity)!=(initial_anchor_kl is not None):
            raise ValueError("Fixed-initial anchor identity and baseline must agree")
        before=copy.deepcopy(self._state())
        self.actor.zero_grad(set_to_none=True)
        probability=predict()
        loss,metrics=objective(probability,old,anchor,actions,advantage,self.recipe,initial_anchor_kl)
        allowed=lambda m:m["anchorGuardKL"]<=self.recipe["anchor_limit"] and m["behaviorKL"]<=self.recipe["behavior_limit"]
        if not allowed(metrics):self.stopped=True;return {**metrics,"accepted":False,"reason":"pre_step_kl_limit"}
        lr=self.recipe["actor_lr"]*min(1.,(self.actor_steps+1)/self.recipe["actor_ramp"])
        for group in self.actor.param_groups:group["lr"]=lr
        # A short final window has proportionally fewer decision exposures.
        (loss*(len(probability)/self.recipe["window"])).backward()
        norm=torch.nn.utils.clip_grad_norm_(self.parameters,self.recipe["grad_norm"],error_if_nonfinite=True)
        self.actor.step()
        with torch.no_grad():_,after=objective(predict(),old,anchor,actions,advantage,self.recipe,initial_anchor_kl)
        if not allowed(after):
            self._restore(before);self.stopped=True
            return {**after,"accepted":False,"reason":"post_step_kl_limit_rolled_back","actorLR":lr}
        self.actor_steps+=1
        return {**after,"accepted":True,"actorLR":lr,"actorStep":self.actor_steps,"gradNorm":float(norm)}
