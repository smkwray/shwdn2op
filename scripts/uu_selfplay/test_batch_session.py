"""CPU protocol/decoder/accepted-commit check on a public simulator fixture.

The tensor forward is deterministic synthetic inference here; real-weight
probability/cache/RNG parity is tested separately by batch_parity.py.
"""
import argparse
import contextlib
import copy
import json
import random
from pathlib import Path
import tempfile
from types import SimpleNamespace
import zipfile

import torch
from batch_server import Session
from batched_inference import Batcher, temperature_probabilities
from candidate_worker import worker_module


def trapped_replay(worker,base,fixture):
    """Protocol regression only; replayed dev-fixture states never become data."""
    from metamon.interface import UniversalState
    with zipfile.ZipFile(fixture) as archive:
        attempts = [json.loads(l) for l in archive.read("trajectory.jsonl").decode().splitlines()]
        attempts = [row for row in attempts if row["side"]=="p1"]
        frames = [json.loads(l) for l in archive.read("p1-private.jsonl").decode().splitlines()]
    forwards = []
    target = {}
    def submit(owner,inputs):
        state = UniversalState.from_Battle(session.decoder.battle)
        legal = (~inputs["obs"]["illegal_actions"][0,0].bool()).nonzero().flatten().tolist()
        choices = [(worker.structural_choice(owner.model.action_space.agent_output_to_action(state,i)
                   .to_BattleOrder(session.decoder.battle),session.decoder.request),i) for i in legal]
        index = next(i for choice,i in choices if choice==target["choice"])
        probabilities = torch.full((1,1,1,13),.001)
        probabilities[...,index] = .988
        owner.last_dist = SimpleNamespace(probs=probabilities/probabilities.sum(-1,keepdim=True))
        forwards.append(inputs)
        return torch.tensor([[[index]]]),None
    batcher = SimpleNamespace(base=base,submit=submit)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)/"never-training"
        session = Session(worker,batcher,{"game":"trapped-fixture","side":"p1","seed":123,
            "team_file":"teams/public/gen9uu/team.txt"},out)
        serial,index = 0,0
        def rpc(message):
            nonlocal serial
            serial += 1
            return session.handle({"version":worker.VERSION,"id":serial,**message})
        for sequence,data in enumerate(frames,1):
            requests = [json.loads(line[9:]) for line in data.splitlines() if line.startswith("|request|")]
            active = bool(requests and not requests[-1].get("wait") and index<len(attempts))
            row = attempts[index] if active else None
            if row is not None:assert row["rqid"]==requests[-1]["rqid"]
            context = {"roomId":"battle-gen9uu-offline","side":"p1","format":"gen9uu",
                       "sequence":sequence,"identity":row["identity"] if row else None}
            rpc({"op":"observe","data":data,"context":context})
            if row is None:continue
            tokens = row["choice"].split()
            target["choice"] = ({"kind":"switch","switchSlot":int(tokens[1])} if tokens[0]=="switch" else
                {"kind":"move","moveSlot":int(tokens[1]),"terastallize":len(tokens)>2} if tokens[0]=="move" else
                {"kind":"team","team":[int(i) for i in tokens[1]]})
            binding = {"requestId":row["requestId"],"identity":row["identity"],
                       "resultHash":row["inputResultHash"],"sequence":sequence}
            rpc({"op":"propose",**binding})
            if row["accepted"]:rpc({"op":"commit",**binding,"choice":target["choice"]})
            index += 1
        accepted = sum(r["accepted"] and r["identity"]["requestKind"]!="team_preview" for r in attempts)
        assert index==len(attempts) and session.retries==2
        assert len(forwards)==session.policy.step==len(session.actions)==accepted
        assert session.pending is None and not (out/"piles").exists()
        return {"attempts":index,"acceptedNeuralCommits":accepted,"forwards":len(forwards),"retries":session.retries}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fixture",type=Path,required=True)
    p.add_argument("--trapped-fixture",type=Path)
    a = p.parse_args()
    from metamon.rl.pretrained import Kakuna
    from metamon.rl.metamon_to_amago import MetamonDiscrete
    from poke_env.player import Player
    logits = torch.tensor([[[[1.,8.,-1e9]]],[[[8.,1.,-1e9]]],[[[1.,1.,1.]]],[[[1.,8.,-1e9]]]])
    distribution = MetamonDiscrete(3)
    temperatures = [.7,1.,1.25,1.5]
    reference = distribution(logits).probs
    actual = temperature_probabilities(distribution,logits,reference,temperatures)
    for i,temperature in enumerate(temperatures):
        distribution.temperature = temperature
        assert torch.equal(actual[i:i+1],distribution(logits[i:i+1]).probs)
    distribution.temperature = 1.
    for temperature in (0.,float("nan"),float("inf")):
        try:temperature_probabilities(distribution,logits,reference,[temperature]*4)
        except ValueError:pass
        else:raise AssertionError("Invalid temperature admitted")
    fixture = json.loads(a.fixture.read_text())
    assert fixture["source"].startswith("independent native simulator; public training-split")
    worker = worker_module()
    base = SimpleNamespace(model=Kakuna(),experiment=SimpleNamespace(DEVICE=torch.device("cpu"),caster=contextlib.nullcontext),
                           policy=SimpleNamespace(traj_encoder=SimpleNamespace(init_hidden_state=lambda *_:None),
                                                  actor=SimpleNamespace(policy_dist=distribution)))
    constructor = Batcher(base)
    distribution(logits)
    assert torch.equal(constructor.logits,logits)
    forwards = []
    def submit(owner,inputs):
        legal = ~inputs["obs"]["illegal_actions"][0,0].bool()
        probabilities = legal.float()/legal.sum()
        owner.last_dist = SimpleNamespace(probs=probabilities.reshape(1,1,1,-1))
        forwards.append(copy.deepcopy(inputs))
        return torch.nonzero(legal)[0].reshape(1,1,1),None
    batcher = SimpleNamespace(base=base,submit=submit)
    with tempfile.TemporaryDirectory() as tmp:
        hello = {"game":"public-fixture","side":"p1","seed":123,"team_file":"teams/public/gen9uu/team.txt"}
        session = Session(worker,batcher,hello,Path(tmp)/"server")
        serial = 0
        for row in fixture["rows"]:
            serial += 1
            message = {k:v for k,v in row.items() if k!="executedChoice"}
            message.update(version=worker.VERSION,id=serial)
            response = session.handle(message)
            assert response["ok"] and response["id"]==serial
            if row["op"]=="propose" and row["executedChoice"]["kind"]=="team":
                state = random.getstate()
                random.seed(worker.side_seed(123,"p1"))
                official = Player.random_teampreview(None,session.decoder.battle)
                random.setstate(state)
                assert response["choice"]["team"]==[int(i) for i in official[6:]]
        assert session.policy.pending is None
        assert len(forwards)==len(session.actions)==len(session.states)==16
        assert session.policy.step==16
        assert session.finish("fixture is deliberately truncated") is False
        metadata = list((Path(tmp)/"server/piles").rglob("*.meta"))
        assert len(metadata)==1
        meta = json.loads(metadata[0].read_text())
        assert not meta["finished"] and meta["won"] is None and meta["states"]==17
        print(json.dumps({"pass":True,"messages":serial,"forwards":len(forwards),"acceptedNeuralCommits":len(session.actions),
                          "unfinishedReplayQuarantined":True,"nativePreviewParity":True,"temperatureGroups":temperatures}))
    if a.trapped_fixture:print(json.dumps({"trappedReplay":trapped_replay(worker,base,a.trapped_fixture)}))


if __name__ == "__main__":
    main()
