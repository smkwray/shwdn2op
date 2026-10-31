"""Disabled auxiliary work preserves the primary objective and zero BC updates."""
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import torch
from metamon.rl.custom_agent import MetamonFinetuneAgent, MultiTaskAgent


class Step(torch.nn.Module):
    def __init__(self):
        super().__init__();self.net=torch.nn.Sequential(torch.nn.Linear(2,2),torch.nn.Dropout(.5));self.calls=0
    def forward(self,obs,rl2s):
        self.calls+=1;return self.net(obs['x'])


class Trajectory(torch.nn.Module):
    def forward(self,seq,time_idxs,hidden_state):return seq,None


class Actor(torch.nn.Linear):
    def forward(self,x,straight_from_obs):
        return torch.distributions.Normal(super().forward(x).unsqueeze(-2),1.)


def policy():
    p=MetamonFinetuneAgent.__new__(MetamonFinetuneAgent);torch.nn.Module.__init__(p)
    p._checkpoint_loaded=True;p.discrete=False;p.multibinary=False;p.gammas=torch.tensor([.99])
    p.actor=torch.nn.Sequential(torch.nn.Dropout(.25),torch.nn.Linear(2,1))
    p._base_tstep_encoder=Step();p._base_traj_encoder=Trajectory();p._base_actor=Actor(2,1)
    p._bc_actor=copy.deepcopy(p._base_actor)
    for m in (p._base_tstep_encoder,p._base_traj_encoder,p._base_actor):m.requires_grad_(False)
    p.bc_coeff=0.;p.use_is_correction=False;p.pass_obs_keys_to_actor=[];p.pad_val=4.
    p.update_info={};p.edit_actor_mask=lambda batch,loss,mask:mask
    p.fbc_filter_func=SimpleNamespace(seq_enabled=True,_seq_last_weights=None)
    p.fbc_filter_func.set_seq_mask=lambda x:setattr(p.fbc_filter_func,'mask',x)
    p.fbc_filter_func.set_delta_log=lambda x:setattr(p.fbc_filter_func,'delta',x)
    return p


class DisabledAuxiliary(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(109)
        self.batch=SimpleNamespace(obs={'x':torch.randn(1,3,2)},rl2s=torch.zeros(1,3,4),
                                   actions=torch.ones(1,2,1)*.2,time_idxs=torch.arange(3).reshape(1,3,1))

    def test_skipped_primary_loss_gradients_rng_and_adamw_match_aligned_reference(self):
        p=policy();reference=copy.deepcopy(p);rng=torch.get_rng_state();entries=[]
        def run(model,monitor):
            optimizer=torch.optim.AdamW([*model.actor.parameters(),*model._bc_actor.parameters()],lr=3e-5)
            def primary(agent,batch,log_step):
                entries.append(torch.get_rng_state().clone())
                # Reference auxiliary dropout consumes RNG. Align only at the
                # primary boundary to compare its objective, not legacy RNG streams.
                if monitor:torch.set_rng_state(rng)
                return agent.actor(batch.obs['x']).square().mean()
            torch.set_rng_state(rng)
            with patch.object(MultiTaskAgent,'forward',primary):loss=model(self.batch,monitor)
            loss.backward();end=torch.get_rng_state().clone()
            gradients={n:v.grad.clone() for n,v in model.named_parameters() if v.grad is not None}
            optimizer.step();return loss.detach(),end,gradients,optimizer.state_dict()
        actual=run(p,False);expected=run(reference,True)
        self.assertEqual(p._base_tstep_encoder.calls,0);self.assertEqual(reference._base_tstep_encoder.calls,1)
        self.assertTrue(torch.equal(entries[0],rng));self.assertFalse(torch.equal(entries[1],rng))
        self.assertTrue(torch.equal(actual[0],expected[0]));self.assertTrue(torch.equal(actual[1],expected[1]))
        self.assertEqual(actual[2].keys(),expected[2].keys())
        for name,grad in actual[2].items():self.assertTrue(torch.equal(grad,expected[2][name]),name)
        for v in p._bc_actor.parameters():self.assertIsNotNone(v.grad);self.assertEqual(float(v.grad.abs().sum()),0.)
        for name,value in p.state_dict().items():self.assertTrue(torch.equal(value,reference.state_dict()[name]),name)
        for key,state in actual[3]['state'].items():
            for name,value in state.items():self.assertTrue(torch.equal(value,expected[3]['state'][key][name]))
        self.assertTrue(p.fbc_filter_func.mask.all())

    def test_enabled_objectives_and_declared_monitor_still_compute_auxiliary(self):
        for coefficient,importance,monitor in [(1.,False,False),(0.,True,False),(0.,False,True)]:
            with self.subTest(coefficient=coefficient,importance=importance,monitor=monitor):
                p=policy();p.bc_coeff=coefficient;p.use_is_correction=importance
                with patch.object(MultiTaskAgent,'forward',lambda agent,batch,log_step:agent.actor(batch.obs['x']).square().mean()):
                    p(self.batch,monitor).backward()
                self.assertEqual(p._base_tstep_encoder.calls,1)
                if coefficient:self.assertGreater(sum(float(v.grad.abs().sum()) for v in p._bc_actor.parameters()),0.)
                if importance:self.assertTrue(torch.isfinite(p.fbc_filter_func.delta).all())
                if monitor:self.assertIn('BC Loss',p.update_info)


if __name__=='__main__':unittest.main()
