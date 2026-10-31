"""PPO-only adapter for the existing accepted-commit batch collector.

The frozen server wrapper selects this adapter; ordinary collection is unchanged.
No network services or live advisor integration are added.
"""
import argparse
from collections import Counter
import copy
import json
import math
from pathlib import Path
import random
import shutil
import sys

import torch
from ppo import conditional,sha


def schedule(panel,learner,recent,version,seed,games=1000):
    """Prospective exact opponent/split quotas and balanced learner families."""
    families=sorted(r["family"] for r in panel["collection"])
    forbidden={r["family"] for r in panel["progress"]}|set(panel["excludedCertificationFamilies"])
    if (len(families)<2 or len(set(families))!=len(families) or set(families)&forbidden
            or not recent or games%200 or games<200 or learner=="G0" or learner in recent):
        raise ValueError("Disjoint train panel, recent pool and multiple-of-200 budget required")
    rng=random.Random(seed+version);rows=[];cursor=version*games*6//5
    for group,count in (("e34",games*3//5),("recent",games//5),("self",games//5)):
        labels=["actor"]*(count*85//100)+["value"]*(count//10)+["reserve"]*(count//20)
        rng.shuffle(labels)
        for i in range(count):
            home="p1" if i%2==0 else "p2";away="p2" if home=="p1" else "p1"
            family=families[cursor%len(families)];cursor+=1
            if group=="self":other=families[cursor%len(families)];cursor+=1
            else:other=families[(families.index(family)+1+version%(len(families)-1))%len(families)]
            opponent="G0" if group=="e34" else recent[(i//2)%len(recent)] if group=="recent" else learner
            rows.append(dict(id=f"v{version}-{len(rows):06d}",home=home,split=labels[i],opponentGroup=group,
                families={home:family,away:other},models={home:learner,away:opponent},
                policySeed=rng.randrange(2**31)))
    rng.shuffle(rows)
    exposure=Counter(row["families"][side] for row in rows for side in ("p1","p2") if row["models"][side]==learner)
    if max(exposure.values())-min(exposure.get(f,0) for f in families)>1:
        raise ValueError("Learner-family exposure imbalance")
    return rows


def admit(collection,schedule_path,replay_report,out):
    """Produce an allowlist only after every planned official game exact-replays."""
    collection=Path(collection).resolve();out=Path(out).resolve()
    if not collection.is_relative_to(out.parent):raise ValueError("Manifest must contain its collection below its root")
    slots=json.loads(Path(schedule_path).read_bytes());planned={s["id"]:s for s in slots}
    proof=json.loads(Path(replay_report).read_bytes())
    if (not proof["pass"] or proof["verifiedCompletedGames"]!=len(slots)
            or proof["games"]!=len(slots) or proof["censoredRawRetainedGames"] or proof["modelCalls"]):
        raise ValueError("Every planned battle must exact-replay; failures remain retained")
    verified={Path(r["game"]).name:r for r in proof["rows"]}
    if set(verified)!=set(planned) or len(verified)!=len(proof["rows"]):raise ValueError("Replay schedule mismatch")
    frozen_plan=json.loads((collection/"runtime/ppo-plan.json").read_bytes())
    frozen_job=json.loads((collection/"job.json").read_bytes())
    if frozen_job["collectionSlots"]!=slots:raise ValueError("Admitted schedule differs from collected slots")
    actual=[json.loads(line) for path in collection.glob("worker-*/games.jsonl") for line in path.read_text().splitlines()]
    if len(actual)!=len(slots) or {g["id"] for g in actual}!=set(planned):raise ValueError("Collection schedule incomplete")
    for game in actual:
        slot=planned[game["id"]]
        if (game["families"]!=slot["families"] or game["policySeed"]!=slot["policySeed"]
                or any(game["actors"][side]["name"]!=slot["models"][side] for side in ("p1","p2"))):
            raise ValueError("Actual families, actors or seeds differ from schedule")
    rows=[];versions=set();policies=set();seen=set()
    for meta_path in sorted((collection/"server/piles").rglob("*.meta")):
        meta=json.loads(meta_path.read_bytes());game=meta["battle_tag"];side=meta["player"]
        if game not in planned or (game,side) in seen:raise ValueError("Unplanned or duplicate POV")
        seen.add((game,side));slot=planned[game]
        replay=Path(verified[game]["game"])/"native-replay.json"
        if sha(replay)!=verified[game]["proofSha256"]:raise ValueError("Exact replay proof drift")
        if meta["learnerPOV"]!=(slot["models"][side]==frozen_plan["learnerName"]):
            raise ValueError("Learner POV identity differs from schedule")
        if not meta["learnerPOV"]:continue
        if (not meta["finished"] or meta["hit_time_limit"] or meta["invalid_actions"] or meta["parse_errors"]
                or meta["result"] not in ("WIN","DRAW","LOSS")):
            raise ValueError("Invalid learner episode; batch not admitted")
        path=Path(str(meta_path)[:-5]);versions.add(meta["ppoVersion"]);policies.add(meta["checkpoint_sha256"])
        summary=json.loads((Path(verified[game]["game"])/"summary.json").read_bytes())
        winner=summary["winner"]
        if winner not in (None,"p1","p2"):raise ValueError("Unknown terminal winner")
        expected="DRAW" if winner is None else "WIN" if winner==side else "LOSS"
        if meta["result"]!=expected:raise ValueError("Native POV terminal disagrees with simulator")
        rows.append(dict(path=str(path.relative_to(out.parent)),sha256=sha(path),
            metaPath=str(meta_path.relative_to(out.parent)),metaSha256=sha(meta_path),battle=game,side=side,
            learnerPOV=True,split=slot["split"],outcome=meta["result"],family=slot["families"][side],
            opponentGroup=slot["opponentGroup"]))
    if (seen!={(game,side) for game in planned for side in ("p1","p2")}
            or len(versions)!=1 or len(policies)!=1):raise ValueError("Incomplete or mixed-version collection")
    manifest=dict(schema="uu-ppo-rollout-batch@1",complete=True,replayVerified=True,
        version=versions.pop(),policySha256=policies.pop(),rows=rows,
        qualificationOnly=frozen_plan["qualificationOnly"],
        scheduleSha256=sha(schedule_path),replay=dict(path=str(Path(replay_report).resolve().relative_to(out.parent)),
        sha256=sha(replay_report)),counts=dict(battles=len(slots),learnerPOVs=len(rows)))
    with out.open("x") as stream:json.dump(manifest,stream,indent=2)
    return manifest


def tensor_record(inputs):
    from soft_policy import input_digest
    def encode(t):
        a=t.detach().cpu().contiguous().numpy()
        return dict(dtype=a.dtype.str,shape=list(a.shape),data=a.tolist())
    return dict(sha256=input_digest(inputs["obs"],inputs["rl2s"],inputs["time_idxs"]),
        obs={k:encode(v) for k,v in inputs["obs"].items()},
        rl2s=encode(inputs["rl2s"]),time_idxs=encode(inputs["time_idxs"]))


def capture_policy(policy):
    """Capture the final accepted index, never a rejected or repeated proposal."""
    submit,propose,commit=policy.policy.get_actions,policy.propose,policy.commit
    policy.ppo_records=[]
    def sample(legal):
        p=policy.last_dist.probs[0,-1,-1].float()
        mask=torch.zeros_like(p,dtype=torch.bool);mask[legal]=True
        q=conditional(p,mask)
        index=int(torch.multinomial(q,1,generator=policy.generator))
        policy.ppo_sample=dict(index=index,probability=float(q[index]),logProbability=float(q[index].log()),
            probabilities=q.cpu().tolist(),legal=mask.cpu().tolist(),temperature=policy.temperature)
        return index
    def forward(**inputs):
        _,hidden=submit(**inputs)
        policy.ppo_input=tensor_record(inputs)
        legal=(~inputs["obs"]["illegal_actions"][0,0].bool()).nonzero().flatten().tolist()
        index=sample(legal)
        return torch.tensor([[[index]]],device=inputs["rl2s"].device),hidden
    def propose_action(battle,request,rechoose=False):
        choice=propose(battle,request,rechoose)
        if not rechoose:policy.ppo_forward_state=copy.deepcopy(policy.pending[0].to_dict())
        return choice
    def accepted(choice):
        index=policy.resolve_index(choice)
        if index!=policy.ppo_sample["index"]:raise ValueError("Accepted index was not the sampled action")
        record={**policy.ppo_sample,"input":policy.ppo_input,"choice":choice,
                "step":policy.step-1,"reusedForward":bool(policy.redrawn)}
        commit(choice)
        policy.ppo_records.append(record)
    policy.policy.get_actions=forward
    policy.redraw=sample
    policy.propose,policy.commit=propose_action,accepted
    return policy


def install(server,plan):
    original_client,original_session=server.client_policy,server.Session
    if plan["schema"]!="uu-ppo-collection@1":raise ValueError("Versioned PPO collection plan required")
    def client(*args,**kwargs):return capture_policy(original_client(*args,**kwargs))
    server.client_policy=client
    class Session(original_session):
        def handle(self,message):
            count=len(self.actions)
            result=super().handle(message)
            if len(self.actions)>count:
                # A trapped retry reuses the first forward; retain its state,
                # exact native inputs and separate final sampling mask.
                self.states[-1]=self.policy.ppo_forward_state
            return result

        def finish(self,error=None):
            import lz4.frame
            result=super().finish(error)
            target=self.out/("piles" if self.purpose=="selfplay" else "progress-replays")/self.out.parent.name/self.hello.get("model","G0")/"metamon/gen9uu"
            paths=list(target.glob(f"metamon-gen9uu-{self.hello['game']}_Unrated_{self.hello['side']}_vs_other_*.json.lz4"))
            if not self.states:return result
            if len(paths)!=1:raise ValueError("Exactly one saved native POV required")
            path=paths[0];meta_path=Path(str(path)+".meta")
            meta=json.loads(meta_path.read_text())
            learner=(self.spec["sha256"]==plan["learnerSha256"] and self.hello["model"]==plan["learnerName"])
            meta.update(ppoVersion=plan["version"],learnerPOV=learner,
                training_eligible=learner and result and not plan["qualificationOnly"],ppoPlanSha256=plan["planSha256"])
            meta_path.write_text(json.dumps(meta,allow_nan=False))
            with lz4.frame.open(path,"rb") as stream:body=json.loads(stream.read())
            if len(self.policy.ppo_records)!=len(self.actions):raise ValueError("Missing accepted PPO probability")
            body["ppo"]=dict(schema="uu-ppo-actions@1",version=plan["version"],
                policySha256=self.spec["sha256"],learnerPOV=learner,records=self.policy.ppo_records)
            temporary=Path(str(path)+".partial")
            with lz4.frame.open(temporary,"wb") as stream:stream.write(json.dumps(body,allow_nan=False).encode())
            temporary.replace(path)
            return result
    server.Session=Session


def server_main():
    import base_batch_server as server
    path=Path(__file__).resolve().parents[2]/"ppo-plan.json"
    plan=json.loads(path.read_bytes())
    plan["planSha256"]=sha(path)
    install(server,plan)
    server.main()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--plan",required=True,type=Path)
    args,remaining=p.parse_known_args()
    if remaining[:1]==["--"]:remaining=remaining[1:]
    plan=json.loads(args.plan.read_bytes())
    if (plan.get("schema")!="uu-ppo-collection@1" or type(plan["version"])!=int
            or plan["version"]<0 or not plan.get("sharedProducerQualified")):
        raise ValueError("Prospectively qualified shared producer and policy version required")
    for name,reference in plan["bindings"].items():
        if sha(reference["path"])!=reference["sha256"]:raise ValueError(f"Collection binding drift: {name}")
    reference=plan["bindings"]["sharedQualification"]
    if json.loads(Path(reference["path"]).read_bytes()).get("pass") is not True:
        raise ValueError("Prospective shared producer qualification must pass")
    import batch_collect
    original=batch_collect.freeze_runtime
    def freeze(runtime,dependencies):
        original(runtime,dependencies)
        kit=Path(__file__).parent
        for name in ("ppo.py","ppo_collect.py"):
            shutil.copyfile(kit/name,runtime/"scripts/uu_selfplay"/name)
        (runtime/"ppo-plan.json").write_bytes(args.plan.read_bytes())
        server=runtime/"scripts/uu_selfplay/batch_server.py"
        server.rename(server.with_name("base_batch_server.py"))
        server.write_text('from ppo_collect import server_main\nserver_main()\n')
    batch_collect.freeze_runtime=freeze
    sys.argv=[str(batch_collect.__file__),*remaining]
    batch_collect.main()


if __name__=="__main__":main()
