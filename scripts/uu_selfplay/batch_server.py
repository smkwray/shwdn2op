"""Private shared worker, using pinned decoder, propose and accepted commit code.

Experimental collection only. One private connection is one side of one game.
Windows uses an authenticated loopback endpoint; other hosts use a Unix socket.
"""
import argparse
import asyncio
import contextlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import math
import os
from pathlib import Path
import random
import re
import sys
import time
from types import SimpleNamespace
from urllib.parse import urlsplit

from candidate_worker import install, policy_members, worker_module
from batched_inference import Batcher, MLXBatcher, client_policy


def allocator_memory(pool):
    """The MLX allocator counters cover the process, not each policy."""
    return next((row[1].network.memory() for row in pool.values()
                 if isinstance(row[1], MLXBatcher)), None)


def preview_choice(rng, battle, request, lead=None):
    if lead is None:
        team=list(range(1,7));rng.shuffle(team)
    else:
        sys.path.insert(0,str(Path(__file__).parents[1]/"metamon_port"))
        from lead_model import preview_order
        team=preview_order(lead.predict(battle,request))
    return {"kind":"team","team":team}


def terminal_result(battle, complete):
    """An infrastructure failure never supplies a loss or a draw target."""
    if not complete:return "INCOMPLETE", None
    if not battle.finished:raise ValueError("Completed session has no official terminal")
    won, lost = battle.won, battle.lost
    if won is True and lost is False:return "WIN", 1.0
    if won is False and lost is True:return "LOSS", 0.0
    if won is False and lost is False:return "DRAW", 0.5
    raise ValueError("Ambiguous official outcome")


class Session:
    def __init__(self,worker,batcher,hello,out,spec=None,purpose="selfplay",lead=None):
        self.w, self.hello, self.out = worker, hello, out
        self.spec = spec
        if purpose not in ("selfplay","progress"):raise ValueError("Unknown replay purpose")
        self.purpose = purpose
        worker.require(re.fullmatch(r"[A-Za-z0-9_-]+",hello["game"]) is not None)
        worker.require(hello["side"] in ("p1","p2"))
        worker.require(type(hello["seed"]) is int and 0<=hello["seed"]<2**32)
        self.decoder = worker.SocketlessBattle()
        seed = worker.side_seed(hello["seed"],hello["side"])
        self.policy = client_policy(worker,batcher,seed,hello.get("temperature",1.))
        self.policy.capture_teacher = purpose=="selfplay" and spec is not None and spec.get("kind")=="ensemble"
        self.rng = random.Random(seed)
        self.serial, self.pending, self.committed = 0, None, None
        self.states, self.actions, self.retries = [], [], 0
        self.soft_records = []
        self.lead = lead

    def handle(self,m):
        w, d, p = self.w,self.decoder,self.policy
        w.require(m.get("version")==w.VERSION and type(m.get("id")) is int and m["id"]==self.serial+1)
        self.serial = m["id"]
        op = m.get("op")
        if op == "observe":
            w.require(set(m)=={"version","id","op","data","context"})
            w.require(m["context"]["side"]==self.hello["side"])
            w.require(self.pending is None or self.pending["choice"]["kind"]=="switch","identity")
            d.observe(m["data"],m["context"],self.pending is not None)
            payload = {"context":d.context}
        elif op == "commit":
            w.require(set(m)=={"version","id","op","requestId","identity","resultHash","sequence","choice"})
            w.require(d.rechoice==0,"identity")
            binding = {k:m[k] for k in ("requestId","identity","resultHash","sequence")}
            choice = m["choice"]
            w.check_choice(choice)
            if self.pending is None:
                w.require(self.committed==(binding,choice) and d.context["identity"]==binding["identity"],"identity")
            else:
                w.require(binding==self.pending["binding"],"identity")
                if d.request.get("teamPreview"):
                    w.require(choice["kind"]=="team","official_action")
                else:
                    index = p.resolve_index(choice)
                    if p.capture_teacher:
                        from soft_policy import teacher_record
                        self.soft_records.append(teacher_record(p))
                    self.states.append(p.pending[0].to_dict())
                    self.actions.append(index)
                    p.commit(choice)
                d.decided_rqid = d.rqid
                self.committed = (binding,choice)
                self.pending = None
            payload = {"binding":binding,"choice":choice}
        else:
            w.require(op=="propose" and set(m)=={"version","id","op","requestId","identity","resultHash","sequence"})
            binding = d.bind(m)
            if self.pending is not None and d.rechoice:
                w.require(d.rechoice==2 and binding["identity"]["rqid"]==self.pending["binding"]["identity"]["rqid"]
                          and binding["identity"]!=self.pending["binding"]["identity"],"identity")
                choice = p.propose(d.battle,d.request,True)
                self.pending = {"binding":binding,"choice":choice}
                self.retries += 1
                d.rechoice = 0
            elif self.pending is not None:
                w.require(self.pending["binding"]==binding,"identity")
            else:
                if d.request.get("teamPreview"):
                    choice = preview_choice(self.rng,d.battle,d.request,self.lead)
                else:
                    choice = p.propose(d.battle,d.request)
                self.pending = {"binding":binding,"choice":choice}
            payload = self.pending
        return {"version":w.VERSION,"id":self.serial,"ok":True,**payload}

    def finish(self,error=None):
        from metamon.interface import UniversalState
        import lz4.frame
        d, h = self.decoder,self.hello
        complete = d.terminal and self.pending is None and error is None
        if d.battle is not None and self.states:
            result, score = terminal_result(d.battle, complete)
            final = UniversalState.from_Battle(d.battle).to_dict()
            final.update(battle_complete=complete, terminal_score=score,
                         battle_won=complete and result=="WIN", battle_lost=complete and result=="LOSS")
            self.states.append(final)
            target = self.out/("piles" if self.purpose=="selfplay" else "progress-replays")/self.out.parent.name/h.get("model","G0")/"metamon"/"gen9uu"
            target.mkdir(parents=True,exist_ok=True)
            date = datetime.now().strftime("%m-%d-%Y")
            name = f"metamon-gen9uu-{h['game']}_Unrated_{h['side']}_vs_other_{date}_{result}.json.lz4"
            path = target/name
            body = {"schema":"uu-native-replay@2", "states":self.states,"actions":self.actions+[-1],
                    "complete":complete,"outcome":result,"terminal_score":score}
            if self.policy.capture_teacher:
                if len(self.soft_records)!=len(self.actions):
                    raise ValueError("Missing accepted-decision teacher record")
                body["soft_policy"] = {"schema":"uu-soft-policy@1","policyId":self.spec["policyId"],
                    "members":[m["sha256"] for m in self.spec["members"]],"records":self.soft_records}
            with lz4.frame.open(str(path)+".tmp","wb") as f:
                f.write(json.dumps(body,allow_nan=False).encode())
            os.replace(str(path)+".tmp",path)
            meta = {"battle_tag":h["game"],"player":h["side"],"opponent":"p2" if h["side"]=="p1" else "p1",
                    "team_file":h["team_file"],"result":result,"finished":complete,
                    "won":d.battle.won if complete and result!="DRAW" else None,
                    "terminal_score":score,"schema":"uu-native-replay@2","hit_time_limit":not complete,
                    "turns":d.battle.turn,"valid_actions":len(self.actions),"invalid_actions":0,
                    "states":len(self.states),"format":"gen9uu","parse_errors":int(error is not None),
                    "verified_trapped_retries":self.retries,"seed":h["seed"],"error":error}
            meta.update(model=h.get("model","G0"),temperature=self.policy.temperature,
                        purpose=self.purpose,training_eligible=self.purpose=="selfplay" and complete,
                        policy_id=h.get("policy_id","metamon:Kakuna:epoch34"),
                        checkpoint_sha256=self.spec["sha256"] if self.spec else None)
            Path(str(path)+".meta").write_text(json.dumps(meta))
        return complete


async def serve(a,pool):
    loop = asyncio.get_running_loop()
    loop.set_default_executor(ThreadPoolExecutor(max_workers=a.max_sessions))
    active, seen = set(), set()
    stats = {"completedPOVs":0,"failedPOVs":0,"connections":0,"started":time.time()}
    lead=None
    if a.lead_checkpoint:
        sys.path.insert(0,str(Path(__file__).parents[1]/"metamon_port"))
        from lead_model import LeadModel
        lead=LeadModel(a.lead_checkpoint);lead.load()
        if lead.model is None:raise ValueError("Qualified lead model unavailable")

    async def connection(reader,writer):
        session, key, error = None, None, None
        try:
            hello = json.loads(await asyncio.wait_for(reader.readline(),30))
            if a.socket.startswith('tcp://') and hello.get('socket')!=endpoint:
                raise ValueError('Private worker endpoint authentication failed')
            worker,batcher,spec = pool[hello["model"]]
            worker.require(hello["policy_id"]==spec["policyId"],"identity")
            key = (hello["game"],hello["side"])
            if key in seen or len(active)>=a.max_sessions:
                raise ValueError("Duplicate session or session limit")
            seen.add(key);active.add(key)
            stats["connections"] += 1
            with (a.out/"sessions.jsonl").open("a") as ledger:
                ledger.write(json.dumps({"event":"started","time":time.time(),**hello})+"\n")
            session = Session(worker,batcher,hello,a.out,spec,a.purpose,lead)
            writer.write(b'{"ready":true}\n');await writer.drain()
            while raw := await asyncio.wait_for(reader.readline(),180):
                message = json.loads(raw)
                response = await asyncio.to_thread(session.handle,message)
                writer.write((json.dumps(response)+"\n").encode());await writer.drain()
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            print(error,file=sys.stderr,flush=True)
            if session:
                writer.write((json.dumps({"version":session.w.VERSION,"id":session.serial,"ok":False,"error":"official_action"})+"\n").encode())
        finally:
            if session:
                complete = session.finish(error)
                stats["completedPOVs" if complete else "failedPOVs"] += 1
                with (a.out/"sessions.jsonl").open("a") as ledger:
                    ledger.write(json.dumps({"event":"completed" if complete else "failed_or_censored",
                                             "game":key[0],"side":key[1],"time":time.time(),"error":error})+"\n")
            active.discard(key)
            services = {id(row[1]):row[1].stats for row in pool.values()}.values()
            total = {k:sum(s[k] for s in services) for k in ("batches","decisions","inferenceSeconds")}
            total["maxBatch"] = max(s["maxBatch"] for s in services)
            import torch
            cuda = next(iter(pool.values()))[1].base.experiment.DEVICE.type=="cuda"
            total["gpuAllocatedPeakBytes"] = torch.cuda.max_memory_allocated() if cuda else None
            total["gpuReservedPeakBytes"] = torch.cuda.max_memory_reserved() if cuda else None
            total["mlxMemory"] = allocator_memory(pool)
            a.out.joinpath("collector-stats.json").write_text(json.dumps({**stats,**total,"active":len(active),
                "models":{name:row[1].stats for name,row in pool.items()},"updated":time.time()},indent=2))
            writer.close();await writer.wait_closed()

    endpoint=a.socket
    if endpoint.startswith('tcp://'):
        address=urlsplit(endpoint)
        if address.hostname!='127.0.0.1' or not address.username or address.port!=0:
            raise ValueError('Private loopback listener requires an ephemeral port and token')
        server=await asyncio.start_server(connection,host='127.0.0.1',port=0,limit=262145)
        endpoint=f'tcp://{address.username}@127.0.0.1:{server.sockets[0].getsockname()[1]}'
    else:
        server = await asyncio.start_unix_server(connection,path=a.socket,limit=262145)
        os.chmod(a.socket,0o600)
    a.out.joinpath("collector-stats.json").write_text(json.dumps({**stats,"active":0},indent=2))
    a.out.joinpath("ready.json").write_text(json.dumps({"pid":os.getpid(),"socket":endpoint,
        "models":{name:row[2] for name,row in pool.items()}}))
    async with server:
        await server.serve_forever()


def load_policy(a,member):
    if member.get("kind")=="ensemble":
        from ensemble_policy import EnsembleBatcher
        components = [load_policy(a,row) for row in member["members"]]
        return components[0][0],EnsembleBatcher([batcher for _,batcher in components])
    worker = worker_module()
    asset = a.out/"assets"/member["name"]/"ckpts/policy_weights/policy_epoch_34.pt"
    asset.parent.mkdir(parents=True)
    if os.name=='nt':os.link(member['path'],asset)
    else:asset.symlink_to(member["path"])
    if member["policyId"]!="metamon:Kakuna:epoch34":
        install(worker,asset,member["sha256"],a.checkpoint,member["policyId"])
    worker.check_runtime(asset)
    if a.backend=="torch-cuda-flex":
        if a.source is None:raise ValueError("Explicit pinned source required for CUDA package data")
        import metamon.rl
        for directory,attribute in (("models","MODEL_CONFIG_DIR"),("training","TRAINING_CONFIG_DIR")):
            target = a.source/"metamon/rl/configs"/directory
            if not target.is_dir():raise FileNotFoundError(target)
            setattr(metamon.rl,attribute,str(target))
        base = worker.KakunaPolicy(asset,0,"flex")
    else:
        if a.source is None:raise ValueError("CPU reference requires an explicit source")
        sys.path.insert(0,str(Path(__file__).parents[1]/"metamon_port"))
        from torch_backend import TorchBackend
        backend = TorchBackend('torch-cuda-sdpa' if a.backend=='torch-cuda-sdpa' else 'torch-cpu',asset,a.source,0)
        import torch
        torch.set_num_threads(1)
        base = SimpleNamespace(model=backend.model,policy=backend.policy,
            experiment=SimpleNamespace(DEVICE=backend.device,caster=contextlib.nullcontext,compiledFlex=False))
        original = backend.policy.actor.forward
        def capture(*args,**kwargs):
            base.last_dist = original(*args,**kwargs)
            return base.last_dist
        backend.policy.actor.forward = capture
    if a.backend == "mlx-backbone":
        configs = json.loads(a.mlx_configs.read_bytes())
        batcher = MLXBatcher(base,configs[member['sha256']],member['sha256'],a.max_batch)
    else:
        batcher = Batcher(base,a.max_batch)
    if member.get("sampler")=="e3_common":
        from ensemble_policy import EnsembleBatcher
        batcher = EnsembleBatcher([batcher])
    return worker,batcher


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint",required=True,type=Path)
    p.add_argument("--socket",required=True)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--max-sessions",type=int,default=32)
    p.add_argument("--max-batch",type=int,default=32)
    p.add_argument("--backend",choices=["torch-cuda-flex","torch-cuda-sdpa","torch-cpu","mlx-backbone"],default="torch-cuda-flex")
    p.add_argument("--mlx-configs",type=Path)
    p.add_argument("--source",type=Path)
    p.add_argument("--policies",type=Path)
    p.add_argument("--purpose",choices=["selfplay","progress"],default="selfplay")
    p.add_argument("--lead-checkpoint",type=Path)
    p.add_argument("--lead-sha256")
    a = p.parse_args()
    if (a.backend == "mlx-backbone") != bool(a.mlx_configs):raise ValueError("Explicit MLX configuration required")
    if bool(a.lead_checkpoint)!=bool(a.lead_sha256):raise ValueError("Explicit lead path/hash binding required")
    if a.lead_checkpoint:
        from export_candidate import digest
        if digest(a.lead_checkpoint)!=a.lead_sha256:raise ValueError("Lead weight drift")
    a.out.mkdir(parents=True,exist_ok=False)
    members = policy_members(a.policies,a.checkpoint)
    pool,loaded = {},{}
    for member in members:
        if member["sha256"] not in loaded:loaded[member["sha256"]] = load_policy(a,member)
        worker,batcher = loaded[member["sha256"]]
        pool[member["name"]] = (worker,batcher,member)
    # freeze_pile.py binds the decoder using this existing manifest seam.
    import metamon.env.metamon_battle
    from export_candidate import digest
    a.out.joinpath(f"{a.out.parent.name}-manifest.json").write_text(json.dumps({"source_sha256":{
        "source/metamon/env/metamon_battle.py":digest(Path(metamon.env.metamon_battle.__file__))},
        "worker_sha256":digest(Path(__file__).parents[1]/"metamon-worker.py"),"models":members}))
    try:
        asyncio.run(serve(a,pool))
    finally:
        if not a.socket.startswith('tcp://'):Path(a.socket).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
