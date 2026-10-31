"""Manifest-only native replay loader and bounded version-by-version PPO runner."""
import argparse
from collections import Counter
import copy
import json
from pathlib import Path
import random
import sys

import numpy as np
import torch
import torch.nn.functional as F

from ppo import Learner,RECIPE,SCORES,calibration,categorical_kl,conditional,native_forward,sha,windows


def trainer_sources():
    return {name:sha(Path(__file__).with_name(name)) for name in ('ppo.py','ppo_collect.py','ppo_train.py')} | {
        'torch_backend.py':sha(Path(__file__).parents[1]/'metamon_port/torch_backend.py')}


def trainer_identity(job):
    identity=dict(arm=job['identity'],anchor=sha(job['anchor']),producer={
        name:sha(Path(__file__).with_name(name)) for name in ('ppo.py','ppo_collect.py','ppo_train.py')})
    guard=job.get('anchorGuard')
    if guard is not None:
        if (set(guard)!={'method','path','sha256'}
                or guard['method']!='initial-positive-excess-e34-kl@1'
                or sha(guard['path'])!=guard['sha256']):
            raise ValueError('Explicit fixed-initial anchor checkpoint and method required')
        binding=job['bindings']['preregistration']
        if sha(binding['path'])!=binding['sha256']:raise ValueError('Anchor registration drift')
        arms=json.loads(Path(binding['path']).read_bytes())['arms']
        matches=[arm for arm in arms if arm['identity']==job['identity']]
        if len(matches)!=1 or matches[0]['initSha256']!=guard['sha256']:
            raise ValueError('Anchor reference must remain the registered original arm initializer')
        identity['anchorGuard']=dict(method=guard['method'],initialSha256=guard['sha256'])
    return identity


def require_gpu_admission(job):
    if type(job['qualificationOnly']) is not bool:raise ValueError('Explicit qualification boolean required')
    if job['backend']=='torch-cpu':return
    if job['backend']!='torch-cuda-sdpa':raise ValueError('PPO GPU training requires qualified eager SDPA')
    qualification=job['qualificationOnly']
    binding=job['bindings']['gpuForwardQualification' if qualification else 'gpuQualification']
    if sha(binding['path'])!=binding['sha256']:raise ValueError('GPU admission receipt drift')
    proof=json.loads(Path(binding['path']).read_bytes())
    phase='GPU_FORWARD_PARITY' if qualification else 'QUALIFIED_GPU_NATIVE_PPO'
    if (proof.get('pass') is not True or proof.get('phase')!=phase or proof.get('backend')!=job['backend']
            or proof.get('trainerSources')!=trainer_sources()):
        raise ValueError('Matching GPU qualification stage and producer required')
    if qualification and (proof.get('checkpointSha256')!=sha(job['checkpoint'])
            or proof.get('cpuProbabilityParity') is not True or proof.get('nativeFullSplitParity') is not True
            or proof.get('cpuGradientParity') is not True):
        raise ValueError('Actual-checkpoint GPU forward parity required')


def decode_input(record,device):
    def tensor(row):
        a=np.asarray(row["data"],dtype=np.dtype(row["dtype"]))
        if list(a.shape)!=row["shape"]:raise ValueError("Stored native input shape mismatch")
        return torch.from_numpy(a.copy()).to(device)
    return dict(obs={k:tensor(v) for k,v in record["obs"].items()},
                rl2s=tensor(record["rl2s"]),time_idxs=tensor(record["time_idxs"]))


class Rollouts:
    """Open exactly manifest rows; never construct a scanning dataset."""
    def __init__(self,path,model,device,policy_sha):
        self.path=Path(path);self.digest=sha(path);self.manifest=json.loads(self.path.read_bytes())
        m=self.manifest
        if (m["schema"]!="uu-ppo-rollout-batch@1" or m["policySha256"]!=policy_sha
                or m["complete"] is not True or m["replayVerified"] is not True):
            raise ValueError("Complete replay-verified on-policy manifest required")
        proof_path=(self.path.parent/m["replay"]["path"]).resolve()
        if (not proof_path.is_relative_to(self.path.parent.resolve()) or sha(proof_path)!=m["replay"]["sha256"]):
            raise ValueError("Exact replay receipt drift")
        proof=json.loads(proof_path.read_bytes())
        if (not proof["pass"] or proof["verifiedCompletedGames"]!=m["counts"]["battles"]
                or proof["censoredRawRetainedGames"] or proof["modelCalls"]):
            raise ValueError("Incomplete exact replay proof")
        self.rows=m["rows"];self.model,self.device=model,device
        if (not self.rows or len({r["path"] for r in self.rows})!=len(self.rows)
                or len({(r["battle"],r["side"]) for r in self.rows})!=len(self.rows)):
            raise ValueError("Unique files and battle POVs required")
        roles={}
        for row in self.rows:
            if (row["split"] not in ("actor","value","reserve") or row["outcome"] not in SCORES
                    or row["learnerPOV"] is not True):raise ValueError("Explicit split, terminal outcome and learner POV required")
            if row["battle"] in roles and roles[row["battle"]]!=row["split"]:raise ValueError("Battle split leakage")
            roles[row["battle"]]=row["split"]
            for field,checksum in (("path","sha256"),("metaPath","metaSha256")):
                target=(self.path.parent/row[field]).resolve()
                if not target.is_relative_to(self.path.parent.resolve()) or sha(target)!=row[checksum]:
                    raise ValueError("Allowlist escape or payload drift")

    def load(self,row):
        import lz4.frame
        from metamon.data.parsed_replay_dset import MetamonDataset
        from metamon.rl.metamon_to_amago import MetamonAMAGODataset
        from soft_policy import input_digest
        path=self.path.parent/row["path"]
        if sha(path)!=row["sha256"]:raise ValueError("Payload changed after admission")
        with lz4.frame.open(path,"rb") as stream:body=json.loads(stream.read())
        meta_path=self.path.parent/row["metaPath"]
        if sha(meta_path)!=row["metaSha256"]:raise ValueError("Metadata changed after admission")
        meta=json.loads(meta_path.read_bytes())
        if (not meta["finished"] or meta["hit_time_limit"] or meta["invalid_actions"] or meta["parse_errors"]
                or not meta["learnerPOV"] or meta["result"]!=row["outcome"]):raise ValueError("Censored/opponent/mismatched POV")
        if (body["states"][-1]["battle_complete"] is not True
                or body["states"][-1]["terminal_score"]!=SCORES[row["outcome"]]
                or any(type(s["player_remaining"])!=int or not 0<=s["player_remaining"]<=6
                       or type(s["opponents_remaining"])!=int or not 0<=s["opponents_remaining"]<=6
                       for s in body["states"])):
            raise ValueError("Persistent roster counts and explicit complete outcome required")
        saved=body["ppo"];records=saved["records"]
        if (saved["schema"]!="uu-ppo-actions@1" or not saved["learnerPOV"]
                or saved["version"]!=self.manifest["version"]
                or saved["policySha256"]!=self.manifest["policySha256"]
                or len(records)!=len(body["actions"])-1 or not records):raise ValueError("Policy lag or incomplete probability capture")
        # Reuse native state/action/observation and RL2 conversion without __init__
        # (which scans directories). Only these attributes enter load_filename.
        dataset=object.__new__(MetamonDataset)
        dataset.observation_space=copy.deepcopy(self.model.observation_space)
        dataset.action_space=self.model.action_space
        dataset.reward_function=self.model.reward_function
        dataset.max_seq_len=None
        native=MetamonAMAGODataset(dataset)._process_data(dataset.load_filename(str(path)))
        inputs=[]
        for i,record in enumerate(records):
            if record["index"]!=body["actions"][i] or record["step"]!=i:raise ValueError("Accepted action identity mismatch")
            captured=decode_input(record["input"],self.device)
            # Exact first-forward mask may differ from the final trapped mask.
            reconstructed=dict(obs={k:native.obs[k][i:i+1].unsqueeze(0).to(self.device)
                for k in captured["obs"]},rl2s=native.rl2s[i:i+1].unsqueeze(0).to(self.device),
                time_idxs=native.time_idxs[i:i+1].unsqueeze(0).to(self.device))
            reconstructed["obs"]["illegal_actions"]=captured["obs"]["illegal_actions"]
            expected=record["input"]["sha256"]
            if input_digest(captured["obs"],captured["rl2s"],captured["time_idxs"])!=expected:
                raise ValueError("Corrupt captured native input")
            if input_digest(reconstructed["obs"],reconstructed["rl2s"],reconstructed["time_idxs"])!=expected:
                raise ValueError("Native-loader input mismatch")
            q=torch.tensor(record["probabilities"],device=self.device)
            legal=torch.tensor(record["legal"],device=self.device,dtype=torch.bool)
            if (not torch.allclose(q,conditional(q,legal),atol=1e-7)
                    or not np.isclose(float(q[record["index"]]),record["probability"],rtol=1e-6)
                    or not np.isclose(np.log(record["probability"]),record["logProbability"],rtol=1e-6)):
                raise ValueError("Accepted-action probability mismatch")
            inputs.append(captured)
        joined=dict(obs={k:torch.cat([x["obs"][k] for x in inputs],dim=1) for k in inputs[0]["obs"]},
            rl2s=torch.cat([x["rl2s"] for x in inputs],dim=1),
            time_idxs=torch.cat([x["time_idxs"] for x in inputs],dim=1))
        return dict(inputs=joined,records=records,score=SCORES[row["outcome"]],row=row)


def evaluate(learner,episode,start,end,anchor=False,policy=None):
    policy=policy if policy is not None else (learner.anchor if anchor else learner.policy)
    records=episode["records"][start:end]
    temperatures={r["temperature"] for r in records}
    if len(temperatures)!=1:raise ValueError("One fixed temperature per POV required")
    distribution=policy.actor.policy_dist;previous=distribution.temperature
    try:
        distribution.temperature=temperatures.pop()
        probabilities,features=native_forward(policy,episode["inputs"],start,end)
    finally:distribution.temperature=previous
    legal=torch.tensor([r["legal"] for r in records],device=probabilities.device,dtype=torch.bool)
    return conditional(probabilities,legal),features


def prepare(learner,rollouts):
    """One full batch normalization and immutable baselines before actor passes."""
    episodes=[rollouts.load(row) for row in rollouts.rows]
    result={role:[e for e in episodes if e["row"]["split"]==role] for role in ("actor","value","reserve")}
    if any(not rows for rows in result.values()):raise ValueError("All three whole-battle splits required")
    # Head only: encoder features are detached and actor steps remain at zero.
    for episode in result["value"]:
        for _,start,end in windows(len(episode["records"]),learner.recipe["window"]):
            with torch.no_grad():_,features=evaluate(learner,episode,start,end)
            target=torch.full((end-start,),int(episode["score"]*2),device=features.device,dtype=torch.long)
            learner.value.zero_grad(set_to_none=True)
            F.cross_entropy(learner.head(features.detach()),target).backward();learner.value.step()
    advantages=[]
    for episode in result["actor"]:
        values=[];anchors=[];initial=[]
        for _,start,end in windows(len(episode["records"]),learner.recipe["window"]):
            with torch.no_grad():
                q,features=evaluate(learner,episode,start,end)
                ref,_=evaluate(learner,episode,start,end,anchor=True)
                if 'anchorGuard' in learner.identity:
                    fixed,_=evaluate(learner,episode,start,end,policy=learner.initial_reference)
                    initial.append(categorical_kl(fixed,ref).clamp_min(0))
                old=torch.tensor([r["probabilities"] for r in episode["records"][start:end]],device=q.device)
                if not torch.allclose(q,old,atol=3e-5,rtol=3e-4):raise ValueError("Behavior replay mismatch or stale learner")
                values.append(episode["score"]-learner.head.score(features));anchors.append(ref)
        episode["advantage"]=torch.cat(values);episode["anchor"]=torch.cat(anchors)
        if initial:episode['initialAnchorKL']=torch.cat(initial)
        advantages.append(episode["advantage"])
    all_adv=torch.cat(advantages);mean,std=all_adv.mean(),all_adv.std(unbiased=False).clamp_min(1e-8)
    for episode in result["actor"]:episode["advantage"]=(episode["advantage"]-mean)/std
    return result


def guard_baseline(learner,episode,start,end):
    if 'anchorGuard' not in learner.identity:return None
    if 'initialAnchorKL' not in episode:raise ValueError('Missing immutable initial-anchor baseline')
    return episode['initialAnchorKL'][start:end]


def pass_once(learner,episodes):
    work=[(e,start,end) for e in episodes for _,start,end in windows(len(e["records"]),learner.recipe["window"])]
    random.shuffle(work);rows=[]
    for episode,start,end in work:
        records=episode["records"][start:end];device=episode["inputs"]["rl2s"].device
        old=torch.tensor([r["probabilities"] for r in records],device=device)
        actions=torch.tensor([r["index"] for r in records],device=device)
        row=learner.step(lambda:evaluate(learner,episode,start,end)[0],old,episode["anchor"][start:end],actions,
                         episode["advantage"][start:end],guard_baseline(learner,episode,start,end))
        rows.append({**row,**{k:episode["row"][k] for k in ("battle","family","side","opponentGroup")},
            "split":"actor","decisions":end-start,"start":start,"end":end})
        if learner.stopped:break
    if not learner.stopped:learner.pass_index+=1
    return rows


def batch_metrics(learner,episodes):
    from ppo import objective
    totals={};count=0
    with torch.no_grad():
        for episode in episodes:
            for _,start,end in windows(len(episode["records"]),learner.recipe["window"]):
                records=episode["records"][start:end];device=episode["inputs"]["rl2s"].device
                old=torch.tensor([r["probabilities"] for r in records],device=device)
                actions=torch.tensor([r["index"] for r in records],device=device)
                q,_=evaluate(learner,episode,start,end)
                _,metrics=objective(q,old,episode["anchor"][start:end],actions,episode["advantage"][start:end],learner.recipe,
                                    guard_baseline(learner,episode,start,end))
                for key,value in metrics.items():
                    if key=="ratioMin":totals[key]=min(totals.get(key,value),value)
                    elif key=="ratioMax":totals[key]=max(totals.get(key,value),value)
                    else:totals[key]=totals.get(key,0.)+value*(end-start)
                count+=end-start
    return {key:value if key in ("ratioMin","ratioMax") else value/count for key,value in totals.items()}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--job",required=True,type=Path)
    a=p.parse_args();job=json.loads(a.job.read_bytes())
    if job["schema"]!="uu-ppo-train@1":raise ValueError("Bounded frozen PPO training job required")
    from export_candidate import BASE_SHA
    if sha(job["anchor"])!=BASE_SHA:raise ValueError("PPO anchor must be canonical e34")
    for name,binding in job["bindings"].items():
        if sha(binding["path"])!=binding["sha256"]:raise ValueError(f"Training binding drift: {name}")
    require_gpu_admission(job)
    sys.path.insert(0,str(Path(__file__).parents[1]/"metamon_port"))
    from torch_backend import TorchBackend
    torch.set_num_threads(1);torch.compiler.set_stance("force_eager")
    random.seed(job["seed"]);np.random.seed(job["seed"])
    learner_backend=TorchBackend(job["backend"],job["checkpoint"],job["source"],job["seed"])
    anchor_backend=TorchBackend(job["backend"],job["anchor"],job["source"],job["seed"])
    torch.set_num_threads(1)  # Backend construction has its own reference default.
    print(json.dumps({"event":"learner_cpu_threads","threads":torch.get_num_threads()}),flush=True)
    identity=trainer_identity(job)
    learner=Learner(learner_backend.policy,anchor_backend.policy,learner_backend.policy.traj_encoder.emb_dim,
                    identity,job.get("recipe"))
    if 'anchorGuard' in identity:
        reference=job['anchorGuard']
        learner.initial_reference=(anchor_backend.policy if reference['sha256']==BASE_SHA else
            TorchBackend(job['backend'],reference['path'],job['source'],job['seed']).policy)
        for parameter in learner.initial_reference.parameters():parameter.requires_grad_(False)
    if job.get("resume"):learner.resume(job["resume"])
    rollouts=Rollouts(job["manifest"],learner_backend.model,learner_backend.device,sha(job["checkpoint"]))
    if rollouts.manifest["qualificationOnly"] and not job["qualificationOnly"]:
        raise ValueError("Qualification games cannot enter the pilot")
    out=Path(job["out"])
    if learner.batch_sha==rollouts.digest:
        prepared=Path(job["resume"]).parent/"prepared.pt"
        if sha(prepared)!=Path(str(prepared)+".sha256").read_text().strip():raise ValueError("Prepared batch drift")
        prepared_body=torch.load(prepared,map_location=learner_backend.device,weights_only=False)
        if prepared_body["manifestSha256"]!=rollouts.digest or prepared_body["identity"]!=learner.identity:
            raise ValueError("Prepared resume batch identity drift")
        splits=prepared_body["splits"]
        if out.resolve()!=prepared.parent.resolve():raise ValueError("Resume must retain its original output")
    else:
        if learner.batch_sha is not None:
            if (rollouts.manifest["version"]!=learner.version+1
                    or not (learner.stopped or learner.pass_index==learner.recipe["passes"])):
                raise ValueError("Previous version incomplete or new policy version skipped")
            checkpoint=torch.load(job["checkpoint"],map_location="cpu",weights_only=True)
            if any(not torch.equal(v.detach().cpu(),checkpoint[k]) for k,v in learner.policy.state_dict().items()):
                raise ValueError("Next collection checkpoint differs from the resumed actor")
        learner.version=rollouts.manifest["version"];learner.batch_sha=rollouts.digest
        learner.pass_index=0;learner.stopped=False
        splits=prepare(learner,rollouts)
        out.mkdir(parents=True,exist_ok=False)
        torch.save(dict(splits=splits,manifestSha256=rollouts.digest,identity=learner.identity),out/"prepared.pt")
        Path(str(out/"prepared.pt")+".sha256").write_text(sha(out/"prepared.pt")+"\n")
        learner.save(out/"resume.pt")
    run_passes(learner,splits,out)
    export_policy(learner,job,out)


def run_passes(learner,splits,out):
    if not (out/"exposure.json").exists():
        exposure=Counter();povs=Counter()
        for role,episodes in splits.items():
            for episode in episodes:
                row=episode["row"]
                key=(role,row["family"],row["opponentGroup"],row["side"],row["outcome"])
                exposure[key]+=len(episode["records"])
                povs[key]+=1
        (out/"exposure.json").write_text(json.dumps([dict(zip(
            ("split","family","opponentGroup","side","outcome"),key),battles=povs[key],povs=povs[key],decisions=count)
            for key,count in sorted(exposure.items())],indent=2))
        (out/"calibration-before.json").write_text(json.dumps(value_report(learner,splits),indent=2))
    while learner.pass_index<learner.recipe["passes"] and not learner.stopped:
        before=copy.deepcopy(learner._state())
        pre=batch_metrics(learner,splits["actor"])
        allowed=lambda m:m["anchorGuardKL"]<=learner.recipe["anchor_limit"] and m["behaviorKL"]<=learner.recipe["behavior_limit"]
        if not allowed(pre):
            learner.stopped=True
            (out/"batch-kl-stop.json").write_text(json.dumps(dict(reason="pre_pass_batch_kl",metrics=pre)))
            learner.save(out/"resume.pt");break
        rows=pass_once(learner,splits["actor"])
        after=batch_metrics(learner,splits["actor"])
        attempt=before["passIndex"]+1;rolled_back=not allowed(after)
        if rolled_back:learner._restore(before);learner.stopped=True
        with (out/f"pass-{attempt}.jsonl").open("x") as stream:
            for row in rows:stream.write(json.dumps(dict(version=learner.version,passIndex=attempt,
                retained=not rolled_back and row["accepted"],**row))+"\n")
            stream.write(json.dumps(dict(event="whole_batch_kl_guard",before=pre,after=after,rolledBack=rolled_back))+"\n")
        learner.save(out/"resume.pt")
    (out/"calibration.json").write_text(json.dumps(value_report(learner,splits),indent=2))


def value_report(learner,splits):
    report={};prior=torch.ones(3,device=next(learner.head.parameters()).device)  # Laplace smoothing, fit split only
    for episode in splits["value"]:prior[int(episode["score"]*2)]+=len(episode["records"])
    prior/=prior.sum()
    with torch.no_grad():
        for role in ("value","reserve"):
            logits=[];targets=[];battles=[]
            for episode in splits[role]:
                for _,start,end in windows(len(episode["records"]),learner.recipe["window"]):
                    _,features=evaluate(learner,episode,start,end)
                    logits.append(learner.head(features));targets.extend([int(episode["score"]*2)]*(end-start))
                    battles.extend([episode["row"]["battle"]]*(end-start))
            report[role]=calibration(torch.cat(logits),torch.tensor(targets,device=logits[0].device),battles,prior)
    return report


def export_policy(learner,job,out):
    from export_candidate import BASE_SHA,check_format
    base=torch.load(job["anchor"],map_location="cpu",weights_only=True,mmap=True)
    state={k:v.detach().cpu() for k,v in learner.policy.state_dict().items()}
    check_format(state,base)
    if any(not torch.isfinite(v).all() for v in state.values()):raise FloatingPointError("Nonfinite PPO export")
    epoch=learner.version+1
    path=out/"ckpts/policy_weights"/f"policy_epoch_{epoch}.pt";path.parent.mkdir(parents=True,exist_ok=True)
    torch.save(state,path)
    receipt=dict(output_sha256=sha(path),base_sha256=BASE_SHA,epoch=epoch,output_tensors=len(state),
        key_shape_dtype_check=True,training_eligible=not job["qualificationOnly"],
        method="recurrent PPO native main weights; no EMA selection",identity=learner.identity,
        rolloutManifestSha256=learner.batch_sha,actorSteps=learner.actor_steps,
        completedPasses=learner.pass_index,klStopped=learner.stopped,
        device=str(next(learner.policy.parameters()).device),
        gpuPeakAllocatedBytes=torch.cuda.max_memory_allocated() if job['backend']=='torch-cuda-sdpa' else None)
    Path(str(path)+".receipt.json").write_text(json.dumps(receipt,indent=2))


if __name__=="__main__":main()
