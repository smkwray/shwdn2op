"""E3 wrapper around f5's pinned decoder/commit loop; parallel CUDA or MLX inference.

Every seat uses the same inverse-CDF stream. Single-member seats are the e34 control.
No sequential inference fallback. Shadow mode executes e34 and only records distributions.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import time

from ensemble import combine, draw, parallel_members, uniform

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/metamon_port'))
from action_probs import choice_token, legal_distribution
from lead_model import preview_order


def team_preview(lead, battle, request):
    return '/team '+''.join(map(str,preview_order(lead.predict(battle,request))))


def worker_module():
    path=ROOT/'scripts/metamon-worker.py'
    from spec import WORKER_SHA,sha
    if sha(path)!=WORKER_SHA:raise ValueError('f5 worker pin mismatch')
    spec=importlib.util.spec_from_file_location('e3_pinned_worker',path)
    worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
    return worker


def install(worker, members, backend='cuda', weights=None, shadow=False, trace=None):
    original_init=worker.KakunaPolicy.__init__
    original_propose=worker.KakunaPolicy.propose
    from spec import sha

    def record(row):
        if trace:
            with Path(trace).open('a') as f:f.write(json.dumps(row,allow_nan=False)+'\n')

    def initialize(self,checkpoint,seed,attention='flex'):
        import numpy as np
        import torch
        self.member_rows=members
        if backend=='cuda':
            original_init(self,checkpoint,seed,attention)
            # Undo only the old passive actor capture before copying its network.
            self.policy.actor.forward=type(self.policy.actor).forward.__get__(self.policy.actor)
            self.networks=[self.policy]+[copy.deepcopy(self.policy) for _ in members[1:]]
            for network,row in zip(self.networks,members):
                network.load_state_dict(torch.load(row['path'],map_location='cpu',weights_only=True,mmap=True),strict=True)
                network.eval()
            self.member_hidden=[self.hidden]+[n.traj_encoder.init_hidden_state(1,self.experiment.DEVICE) for n in self.networks[1:]]
            self.streams=[torch.cuda.Stream() for _ in members]
            torch.cuda.synchronize()

            def forward(i,obs,rl2,time_idx):
                network=self.networks[i]
                with torch.cuda.stream(self.streams[i]),torch.no_grad(),self.experiment.caster():
                    embedding,hidden=network.get_state_embedding(obs=obs,rl2s=rl2,time_idxs=time_idx,hidden_state=self.member_hidden[i])
                    distribution=network.actor(embedding,straight_from_obs={k:obs[k] for k in network.pass_obs_keys_to_actor})
                    p=distribution.probs[0,-1,-1].float()
                self.member_hidden[i]=hidden
                return p
        else:
            import contextlib
            import mlx.core as mx
            from common import configure_model
            from mlx_kakuna import MLXKakuna
            from metamon.rl.metamon_to_amago import make_placeholder_env
            torch.set_num_threads(1)
            self.seed=seed;self.model=configure_model()
            self.experiment=SimpleNamespace(DEVICE=torch.device('cpu'),caster=contextlib.nullcontext)
            self.wrapper=make_placeholder_env(self.model.observation_space,self.model.action_space)
            self.model.observation_space.reset()
            self.hidden=None;self.previous_state=None
            self.previous_action=np.zeros((1,self.wrapper.action_size),dtype=self.wrapper.action_dtype)
            self.step=0;self.pending=None
            self.networks=[MLXKakuna(p,expected=row['sha256']) for p,row in zip(weights,members)]
            self.streams=[mx.new_stream(mx.gpu) for _ in members]

            def forward(i,obs,rl2,time_idx):
                obs={k:v[:,0].numpy() for k,v in obs.items()}
                with mx.stream(self.streams[i]):
                    return self.networks[i].step(obs,rl2[:,0].numpy(),time_idx[:,0].numpy()).tolist()

        self.calls=0
        def get_actions(*,obs,rl2s,time_idxs,sample,hidden_state):
            import torch
            started=time.perf_counter()
            legal=[i for i,v in enumerate(obs['illegal_actions'][0,-1].cpu().tolist()) if not v]
            # The immutable caller constructs one observation/mask, shared by every member.
            inputs={k:v for k,v in obs.items()}
            if backend=='cuda':
                # Dynamo/FX compilation has process-global tracing state. Enqueue
                # from one host thread, on independent CUDA streams, and collect
                # only after all members have been launched. No per-member CPU
                # copy or stream wait may serialize the launches.
                torch.cuda.synchronize()
                outputs=[forward(i,inputs,rl2s,time_idxs) for i in range(len(members))]
                for stream in self.streams:stream.synchronize()
                self.member_probs=[p.cpu().tolist() for p in outputs]
            else:
                self.member_probs=parallel_members(lambda i:forward(i,inputs,rl2s,time_idxs),list(range(len(members))))
            self.forward_legal=legal
            p=combine([{str(i):values[i] for i in legal} for values in self.member_probs],[str(i) for i in legal])
            # The outer pinned propose converts this placeholder index to the exact structural mapping.
            index=int(next(iter(p)))
            arr=[0.]*13
            for i,value in p.items():arr[int(i)]=value
            self.last_dist=SimpleNamespace(probs=torch.tensor(arr,dtype=torch.float64).reshape(1,1,1,13))
            self.calls+=1;self.forward_ms=(time.perf_counter()-started)*1000
            return torch.tensor([[[index]]]),self.calls
        self.policy=SimpleNamespace(get_actions=get_actions)

    def propose(self,battle,request,rechoose=False):
        started=time.perf_counter()
        # No neural forward on trapped retry; the first mapping establishes structural legal actions.
        if rechoose:
            saved_redraw=self.redraw
            self.redraw=lambda legal:legal[0]
            try:original_propose(self,battle,request,True)
            finally:self.redraw=saved_redraw
        else:original_propose(self,battle,request,False)
        mapping=self.pending[1]
        legal=sorted({choice_token(ch) for ch,_ in mapping})
        distributions=[legal_distribution(p,mapping) for p in self.member_probs]
        p=combine(distributions,legal)
        control=combine([distributions[0]],legal)
        u=uniform(self.seed,self.step-1)
        token=draw(control if shadow else p,u)
        choice=next(ch for ch,_ in mapping if choice_token(ch)==token)
        index=min(i for ch,i in mapping if choice_token(ch)==token)
        self.pending_alias=(index,self.pending_alias[1]);self.redrawn=rechoose
        self.ensemble_trace={'event':'ensemble','step':self.step,'legal':legal,'mapping':mapping,
            'members':distributions,'ensemble':p,'control':control,'uniform':u,'choice':choice,
            'memberSha256':[r['sha256'] for r in members],'parallel':True,'rechoose':rechoose,
            'shadow':shadow,'forwardMs':self.forward_ms,'requestToPickMs':(time.perf_counter()-started)*1000}
        record(self.ensemble_trace)
        return choice

    worker.KakunaPolicy.__init__=initialize
    worker.KakunaPolicy.propose=propose


def configure(worker):
    parser=argparse.ArgumentParser()
    parser.add_argument('--members',required=True,type=Path)
    parser.add_argument('--backend',choices=['cuda','mlx'],default='cuda')
    parser.add_argument('--weights',nargs='+')
    parser.add_argument('--shadow',action='store_true')
    parser.add_argument('--lead-checkpoint',required=True,type=Path)
    args,remaining=parser.parse_known_args()
    members=json.loads(args.members.read_text())
    original=worker.check_runtime
    from spec import sha
    def check(path):
        original(path)
        from importlib.machinery import SourceFileLoader
        exporter=SourceFileLoader('e3_export',str(ROOT/'scripts/uu_selfplay/export_candidate.py')).load_module()
        import torch
        base=torch.load(path,map_location='cpu',weights_only=True,mmap=True)
        for row in members:
            if sha(row['path'])!=row['sha256']:raise ValueError('member hash mismatch')
            value=torch.load(row['path'],map_location='cpu',weights_only=True,mmap=True)
            exporter.check_format(value,base)
            if not all(bool(torch.isfinite(v).all()) for v in value.values()):raise ValueError('nonfinite weights')
    worker.check_runtime=check
    install(worker,members,args.backend,args.weights,args.shadow,os.environ.get('UU_E3_TRACE'))
    # Existing argmax lead model, identical in both arms; never an E3 member vote.
    from lead_model import LeadModel
    lead=LeadModel(args.lead_checkpoint)
    checked=worker.check_runtime
    observe=worker.SocketlessBattle.observe
    state={}
    def observed(decoder,*a,**kw):
        state['decoder']=decoder
        return observe(decoder,*a,**kw)
    def runtime(path):
        checked(path)
        import metamon.rl.pretrained
        from poke_env.player import Player
        lead.load()
        if lead.model is None:raise ValueError('lead model unavailable')
        def preview(player,battle):
            return team_preview(lead,battle,state['decoder'].request)
        Player.random_teampreview=preview
    worker.check_runtime=runtime
    worker.SocketlessBattle.observe=observed
    if os.environ.get('UU_E3_WIRE'):
        wire_path=Path(os.environ['UU_E3_WIRE'])
        read,reply=worker.RpcInput.readline,worker.RpcInput.reply
        def line(self):
            raw=read(self)
            if raw:
                with wire_path.open('a') as f:f.write(json.dumps({'in':json.loads(raw)})+'\n')
            return raw
        def response(self,wire,value):
            with wire_path.open('a') as f:f.write(json.dumps({'out':value})+'\n')
            return reply(self,wire,value)
        worker.RpcInput.readline,worker.RpcInput.reply=line,response
    sys.argv=[str(ROOT/'scripts/metamon-worker.py'),*remaining]


def main():
    worker=worker_module()
    configure(worker)
    return worker.main()


if __name__=='__main__':sys.exit(main())
