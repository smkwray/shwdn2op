"""Only the probability, recurrent, objective and resume correctness contracts."""
import copy
import json
import math
from pathlib import Path
import random
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np
import torch

from ppo import Learner,RECIPE,categorical_kl,conditional,native_forward,objective,windows
from ppo_collect import capture_policy


class AdmissionTest(unittest.TestCase):
    def test_gpu_forward_receipt_cannot_admit_production_or_another_producer(self):
        from ppo_train import require_gpu_admission,trainer_sources,sha
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);checkpoint=root/'weights';checkpoint.write_bytes(b'qualification fixture')
            receipt=root/'forward.json'
            proof=dict(pass_=True,phase='GPU_FORWARD_PARITY',backend='torch-cuda-sdpa',
                trainerSources=trainer_sources(),checkpointSha256=sha(checkpoint),
                cpuProbabilityParity=True,nativeFullSplitParity=True,cpuGradientParity=True)
            proof['pass']=proof.pop('pass_');receipt.write_text(json.dumps(proof))
            binding=dict(path=str(receipt),sha256=sha(receipt))
            job=dict(qualificationOnly=True,backend='torch-cuda-sdpa',checkpoint=str(checkpoint),
                bindings=dict(gpuForwardQualification=binding,gpuQualification=binding))
            require_gpu_admission(job)
            with self.assertRaises(ValueError):require_gpu_admission({**job,'qualificationOnly':False})
            with self.assertRaises(ValueError):require_gpu_admission({**job,'qualificationOnly':'true'})
            proof['trainerSources']={};receipt.write_text(json.dumps(proof));binding['sha256']=sha(receipt)
            with self.assertRaises(ValueError):require_gpu_admission(job)


class ProbabilityTest(unittest.TestCase):
    def test_temperature_mask_and_accepted_retry(self):
        # The adapter consumes native temperature/clipping probabilities, then
        # applies its exact final legal conditional. The native sampler is reused.
        logits=torch.tensor([2.,-1.,4.])/1.4
        native=logits.softmax(-1).clamp(.001,.99);native/=native.sum()
        p=SimpleNamespace(generator=torch.Generator().manual_seed(12),temperature=1.4,
            step=0,redrawn=False,last_dist=SimpleNamespace(probs=native.reshape(1,1,1,-1)),pending=None)
        inputs=dict(obs={"illegal_actions":torch.tensor([[[False,True,False]]])},
                    rl2s=torch.zeros(1,1,4),time_idxs=torch.zeros(1,1,1,dtype=torch.long))
        calls=[]
        def forward(**kw):calls.append(1);return torch.zeros(1,1,1,dtype=torch.long),None
        p.policy=SimpleNamespace(get_actions=forward)
        def propose(battle,request,rechoose=False):
            if rechoose:
                index=p.redraw([0]);p.redrawn=True
            else:
                index=int(p.policy.get_actions(**inputs)[0]);p.step+=1
            p.sampled=index;p.pending=(SimpleNamespace(to_dict=lambda:{"turn":1}),None)
            return {"index":index}
        p.propose=propose;p.resolve_index=lambda choice:choice["index"]
        p.commit=lambda choice:setattr(p,"pending",None)
        capture_policy(p)
        p.propose(None,None)
        expected=conditional(native,torch.tensor([True,False,True]))
        self.assertTrue(torch.allclose(torch.tensor(p.ppo_sample["probabilities"]),expected))
        self.assertEqual(len(p.ppo_records),0)  # proposals never train
        choice=p.propose(None,None,True)
        self.assertEqual(len(calls),1)
        p.commit(choice)
        self.assertEqual(p.ppo_records[0]["index"],0)
        self.assertEqual(p.ppo_records[0]["probability"],1.)
        self.assertEqual(p.ppo_records[0]["logProbability"],0.)
        self.assertTrue(p.ppo_records[0]["reusedForward"])
        with self.assertRaises(ValueError):conditional(native,torch.zeros(3,dtype=torch.bool))

    def test_clip_kl_entropy_math(self):
        p=torch.tensor([[.8,.2],[.2,.8]],requires_grad=True)
        old=torch.full((2,2),.5);a=torch.tensor([0,1]);adv=torch.tensor([1.,-1.])
        recipe={**RECIPE,"anchor_beta":0.,"entropy_coeff":0.}
        loss,metrics=objective(p,old,old,a,adv,recipe)
        self.assertAlmostEqual(float(loss.detach()),.2,places=6)
        self.assertEqual(metrics["clipFraction"],1.)
        expected=.8*math.log(1.6)+.2*math.log(.4)
        self.assertAlmostEqual(float(categorical_kl(p,old)[0].detach()),expected,places=6)
        self.assertAlmostEqual(metrics["entropy"],-.8*math.log(.8)-.2*math.log(.2),places=6)
        loss.backward();self.assertTrue(torch.isfinite(p.grad).all())
        q=torch.tensor([[1.,0.]])
        _,single=objective(q,q,q,torch.tensor([0]),torch.tensor([1.]))
        self.assertEqual(single["entropyDeficit"],0.)


class RecurrentTest(unittest.TestCase):
    def test_native_prefix_burnin_and_boundaries(self):
        from amago.nets.transformer import AttentionLayer,SlidingWindowFlexAttention,TransformerLayer
        class Step(torch.nn.Linear):
            def forward(self,obs,rl2s):return super().forward(obs["x"])
        class Trajectory(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.layers=torch.nn.ModuleList([TransformerLayer(AttentionLayer(
                    SlidingWindowFlexAttention(causal=True,dropout=0.,window_size=96),
                    d_model=8,d_qkv=4,n_heads=2,dropout_qkv=0.,sigma_reparam=False),
                    d_model=8,d_ff=16,dropout_ff=0.,sigma_reparam=False) for _ in range(2)])
            def forward(self,seq,time_idxs,hidden_state):
                for layer in self.layers:seq=layer(seq,pos_idxs=time_idxs)
                return seq,None
        class Actor(torch.nn.Linear):
            def forward(self,x,straight_from_obs):return SimpleNamespace(probs=super().forward(x).softmax(-1).unsqueeze(-2))
        class Policy(torch.nn.Module):
            def __init__(self):
                super().__init__();self.tstep_encoder=Step(3,8);self.traj_encoder=Trajectory();self.actor=Actor(8,3)
                self.pass_obs_keys_to_actor=[]
        torch.manual_seed(4);policy=Policy();x=torch.randn(1,135,3,requires_grad=True)
        inputs=dict(obs={"x":x},rl2s=torch.zeros(1,135,4),time_idxs=torch.arange(135).reshape(1,135,1))
        full,_=native_forward(policy,inputs,0,135)
        tail,_=native_forward(policy,inputs,128,135)
        self.assertTrue(torch.allclose(tail,full[128:],atol=2e-6))
        tail[:,0].sum().backward()
        self.assertEqual(float(x.grad[:,:128].abs().sum()),0.)
        self.assertGreater(float(x.grad[:,128:].abs().sum()),0.)
        self.assertEqual(windows(65),[(0,0,32),(0,32,64),(0,64,65)])
        self.assertEqual(sum(end-start for _,start,end in windows(65)),65)
        with self.assertRaises(ValueError):native_forward(policy,{**inputs,"time_idxs":inputs["time_idxs"]+1},0,2)
        # A new episode always recomputes from reset, without prior cache.
        again,_=native_forward(policy,inputs,128,135)
        self.assertTrue(torch.equal(again,tail))


class ResumeTest(unittest.TestCase):
    @staticmethod
    def make(recipe=None):
        class Policy(torch.nn.Module):
            def __init__(self):super().__init__();self.actor=torch.nn.Linear(2,2)
        torch.manual_seed(17);policy=Policy()
        return Learner(policy,copy.deepcopy(policy),2,"synthetic-arm",recipe)

    @staticmethod
    def update(learner):
        x=torch.tensor([[1.,0.],[0.,1.]])
        old=learner.anchor.actor(x).softmax(-1).detach()
        return learner.step(lambda:learner.policy.actor(x).softmax(-1),old,old,
            torch.tensor([0,1]),torch.tensor([1.,-1.]))

    def test_exact_next_step_and_actor_ramp(self):
        learner=self.make()
        learner.value.zero_grad()
        torch.nn.functional.cross_entropy(learner.head(torch.eye(2)),torch.tensor([0,2])).backward()
        learner.value.step()
        first=self.update(learner)
        self.assertAlmostEqual(first["actorLR"],3e-8,places=20)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"resume.pt";learner.save(path)
            expected=self.update(learner);weights=copy.deepcopy(learner.policy.state_dict())
            random_value=(random.random(),np.random.rand(),float(torch.rand(())))
            restored=self.make();restored.resume(path);actual=self.update(restored)
            self.assertEqual(expected,actual)
            for k,v in weights.items():self.assertTrue(torch.equal(v,restored.policy.state_dict()[k]))
            for k,v in learner.head.state_dict().items():self.assertTrue(torch.equal(v,restored.head.state_dict()[k]))
            self.assertEqual(learner.value.state_dict()["param_groups"],restored.value.state_dict()["param_groups"])
            self.assertEqual(random_value,(random.random(),np.random.rand(),float(torch.rand(()))))
            restored.identity="drift"
            with self.assertRaises(ValueError):restored.resume(path)

    def test_kl_rollback_preserves_optimizer_and_weights(self):
        learner=self.make({**RECIPE,"actor_lr":.1,"actor_ramp":1,"anchor_limit":1e-10})
        before=copy.deepcopy(learner.policy.state_dict());result=self.update(learner)
        self.assertFalse(result["accepted"]);self.assertEqual(learner.actor_steps,0)
        self.assertTrue(learner.stopped);self.assertEqual(len(learner.actor.state),0)
        for k,v in before.items():self.assertTrue(torch.equal(v,learner.policy.state_dict()[k]))


if __name__=="__main__":
    torch.set_num_threads(1)
    unittest.main()
