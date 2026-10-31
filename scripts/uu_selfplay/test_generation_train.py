"""Outcome propagation and native-resume metadata for the generation entry point."""
from collections import deque
import copy
from types import SimpleNamespace
from pathlib import Path
import json
import tempfile
import unittest

import torch
from generation_train import (RunState, bounded_nstep_return, set_critic_warmup,
                              save_training_checkpoint, primary_optimizer, primary_schedule)


class TrainingTests(unittest.TestCase):
    def test_primary_ramp_uses_real_updates_and_native_resume_at_release(self):
        from accelerate import Accelerator
        class Policy(torch.nn.Module):
            def __init__(self):
                super().__init__()
                for name in ('tstep_encoder','traj_encoder','actor','critics'):
                    setattr(self,name,torch.nn.Linear(1,1))
                self.offline_coeff,self.bc_coeff=1.,0.
            @property
            def trainable_params(self):return self.parameters()
            def forward(self,x):
                return self.critics(x).square().sum()+self.actor(self.traj_encoder(self.tstep_encoder(x))).square().sum()
        accelerator=Accelerator(cpu=True,gradient_accumulation_steps=3)
        policy=Policy();optimizer=primary_optimizer(policy,3e-5,1e-4)
        schedule=primary_schedule(optimizer,1000,1000,1000)
        model,optimizer,schedule=accelerator.prepare(policy,optimizer,schedule)
        e=SimpleNamespace(policy=policy,grad_update_counter=0)
        inherited=copy.deepcopy(policy.actor.state_dict())
        def update():
            used=[]
            for _ in range(3):
                set_critic_warmup(e,1000)
                used.append([g['lr'] for g in optimizer.param_groups])
                with accelerator.accumulate(model):
                    optimizer.zero_grad();accelerator.backward(model(torch.ones(2,1)))
                    if accelerator.sync_gradients:e.grad_update_counter+=1
                    optimizer.step();schedule.step()
            self.assertEqual(used,[used[0]]*3)
            return used[0]
        for _ in range(1000):update()
        for name,value in policy.actor.state_dict().items():self.assertTrue(torch.equal(value,inherited[name]))
        self.assertEqual(e.grad_update_counter,1000)
        checkpoint=copy.deepcopy((policy.state_dict(),optimizer.state_dict(),schedule.state_dict()))
        self.assertAlmostEqual(update()[0],3e-8,places=15)
        self.assertAlmostEqual(update()[0],6e-8,places=15)
        uninterrupted=copy.deepcopy(policy.state_dict())
        # The production checkpoint restores these native objects, then RunState's counter.
        policy.load_state_dict(checkpoint[0]);optimizer.load_state_dict(checkpoint[1]);schedule.load_state_dict(checkpoint[2])
        e.grad_update_counter=1000
        self.assertAlmostEqual(update()[0],3e-8,places=15)
        update()
        for name,value in policy.state_dict().items():self.assertTrue(torch.equal(value,uninterrupted[name]),name)
        for _ in range(998):last=update()
        self.assertAlmostEqual(last[0],3e-5,places=15)
        self.assertAlmostEqual(last[1],3e-5,places=15)

    def test_native_save_failure_cannot_publish_ready_or_prune_and_success_keeps_policies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);(root/"policy_weights").mkdir();(root/"training_states").mkdir()
            for epoch in range(3):
                (root/f"training_states/run_epoch_{epoch}").mkdir()
                (root/f"policy_weights/policy_epoch_{epoch}.pt").write_bytes(b"closed native payload")
            e = SimpleNamespace(ckpt_dir=tmp,run_name="run",epoch=2,grad_update_counter=20)
            def failed_save(e):raise OSError("disk write failed")
            with self.assertRaises(OSError):save_training_checkpoint(e,failed_save,"id")
            self.assertFalse((root/"policy_weights/policy_epoch_2.ready.json").exists())
            self.assertTrue((root/"training_states/run_epoch_0").exists())
            save_training_checkpoint(e,lambda e:None,"id")
            self.assertFalse((root/"training_states/run_epoch_0").exists())
            self.assertTrue((root/"training_states/run_epoch_1").exists())
            self.assertEqual(len(list((root/"policy_weights").glob("*.pt"))),3)
            self.assertEqual(json.loads((root/"policy_weights/policy_epoch_2.ready.json").read_text())["nextEpoch"],3)

    def test_critic_warmup_freezes_primary_and_restores_training_after_boundary(self):
        p = torch.nn.Module()
        for name in ("tstep_encoder","traj_encoder","actor","critics"):setattr(p,name,torch.nn.Linear(2,2))
        p.offline_coeff,p.bc_coeff = 1.,1.
        e = SimpleNamespace(policy=p,grad_update_counter=2)
        self.assertTrue(set_critic_warmup(e,3))
        for module in (p.tstep_encoder,p.traj_encoder,p.actor):
            self.assertFalse(module.training)
            self.assertFalse(any(v.requires_grad for v in module.parameters()))
        self.assertTrue(all(v.requires_grad for v in p.critics.parameters()))
        self.assertEqual((p.offline_coeff,p.bc_coeff),(0.,0.))
        e.grad_update_counter = 3
        self.assertFalse(set_critic_warmup(e,3))
        self.assertTrue(all(v.requires_grad for v in p.parameters()))
        self.assertEqual((p.offline_coeff,p.bc_coeff),(1.,1.))

    def test_terminal_outcomes_override_arbitrarily_wrong_bootstrap_through_full_window(self):
        r = torch.zeros(2,7,1,2,1);d = torch.zeros_like(r);q = torch.full_like(r,12345.)
        mask = torch.ones(2,7,1,1,1);mask[0,4:] = 0
        r[0,3] = 200.;d[0,3] = 1.;d[1,6] = 1.
        gamma = torch.tensor([[1.],[.99]])
        # The production adapter handles short batches with configured n=32.
        target = bounded_nstep_return(r,d,q,gamma,mask,n=32)
        for t in range(4):
            torch.testing.assert_close(target[0,t,0,:,0],200.*gamma[:,0]**(3-t))
        self.assertTrue(torch.equal(target[1],torch.zeros_like(target[1])))
        short = bounded_nstep_return(r,d,q,gamma,mask,n=1)
        self.assertGreater(float(short[0,0,0,0,0]),10000)

    def test_truncated_window_bootstraps_at_last_valid_next_state(self):
        r = torch.ones(1,3,1,1,1);d = torch.zeros_like(r);q = torch.full_like(r,10.)
        target = bounded_nstep_return(r,d,q,torch.tensor([[.5]]),torch.ones(1,3,1,1,1),n=32)
        torch.testing.assert_close(target.flatten(),torch.tensor([3.,4.,6.]))

    def test_resume_restores_next_epoch_counter_and_filter_history_and_rejects_drift(self):
        f = SimpleNamespace(seq_enabled=True,_seq_buffer=deque([1.,2.],maxlen=4),_seq_step=19)
        e = SimpleNamespace(policy=SimpleNamespace(fbc_filter_func=f),epoch=2,grad_update_counter=100)
        checkpoint = RunState(e,"same").state_dict()
        e.epoch = 0;e.grad_update_counter = 0;f._seq_buffer.clear();f._seq_step = 0
        RunState(e,"same").load_state_dict(checkpoint)
        self.assertEqual((e.epoch,e.grad_update_counter,f._seq_step),(3,100,19))
        self.assertEqual(list(f._seq_buffer),[1.,2.])
        self.assertTrue(f._seq_cache_dirty)
        with self.assertRaisesRegex(ValueError,"identity"):RunState(e,"different").load_state_dict(checkpoint)
        f.seq_enabled = False
        with self.assertRaisesRegex(ValueError,"Filter"):RunState(e,"same").load_state_dict(checkpoint)


if __name__=="__main__":unittest.main()
