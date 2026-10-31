"""Small CPU checks for isolation and priority admission; real GPU parity is separate."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import torch
from batched_inference import pack_hidden, unpack_hidden
from gpu_job import blockers
from progress_panel import prepare


class HiddenTests(unittest.TestCase):
    def test_capacity_kernel_is_scoped_and_restored_after_failure(self):
        from batched_inference import capacity_kernel
        class Attention:
            def flex_attention_inf(self, *args):
                return "native"
        attention = Attention()
        policy = SimpleNamespace(modules=lambda: [attention])
        original = attention.flex_attention_inf
        with self.assertRaisesRegex(RuntimeError, "forward failed"):
            with capacity_kernel(policy):
                self.assertNotEqual(attention.flex_attention_inf, original)
                raise RuntimeError("forward failed")
        self.assertEqual(attention.flex_attention_inf, original)
        self.assertNotIn("flex_attention_inf", attention.__dict__)
        with self.assertRaisesRegex(ValueError, "FlexAttention"):
            with capacity_kernel(SimpleNamespace(modules=lambda: [])):
                pass

    def test_cuda_model_threads_cannot_overlap_compiler_entry(self):
        import threading,time
        from batched_inference import Batcher
        peak,active = 0,0
        count_lock = threading.Lock();barrier = threading.Barrier(2)
        def inference(jobs):
            nonlocal peak,active
            with count_lock:active+=1;peak=max(peak,active)
            time.sleep(.02)
            with count_lock:active-=1
        models = []
        for _ in range(2):
            model = Batcher.__new__(Batcher)
            model.base = SimpleNamespace(experiment=SimpleNamespace(DEVICE=SimpleNamespace(type="cuda")))
            model._forward = inference;models.append(model)
        def run(model):barrier.wait();model.forward([])
        threads = [threading.Thread(target=run,args=(model,)) for model in models]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertEqual(peak,1)

    def state(self,value,pos):
        return SimpleNamespace(key_cache=SimpleNamespace(data=torch.full((2,1,4,1,2),value)),
                               val_cache=SimpleNamespace(data=torch.full((2,1,4,1,2),value+10)),
                               seq_lens=torch.tensor([pos],dtype=torch.int32))

    def test_reordered_heterogeneous_cache_roundtrip_has_no_cross_client_alias(self):
        a,b = self.state(1.,1),self.state(7.,3)
        h = pack_hidden([b,a])
        self.assertEqual(h.seq_lens.tolist(),[3,1])
        h.key_cache.data[:,0] += 100
        h.val_cache.data[:,1] += 200
        self.assertEqual(float(b.key_cache.data[0,0,0,0,0]),7.)
        unpack_hidden(h,[b,a])
        self.assertEqual(float(b.key_cache.data[0,0,0,0,0]),107.)
        self.assertEqual(float(a.key_cache.data[0,0,0,0,0]),1.)
        self.assertEqual(float(a.val_cache.data[0,0,0,0,0]),211.)
        h.key_cache.data.fill_(0)
        self.assertEqual(float(b.key_cache.data[0,0,0,0,0]),107.)


class EnsembleTests(unittest.TestCase):
    def test_shared_server_can_publish_member_statistics_at_session_close(self):
        from ensemble_policy import EnsembleBatcher
        member=SimpleNamespace(base=object(),stats={"batches":2,"decisions":4,"inferenceSeconds":1.,"maxBatch":2})
        batcher=EnsembleBatcher([member,member,member])
        self.assertEqual(batcher.stats,{"batches":6,"decisions":12,"inferenceSeconds":3.,"maxBatch":2})

    def test_structural_aliases_are_aggregated_before_consensus_and_retry_reuses_forward(self):
        from ensemble_policy import install
        move = {"kind":"move","moveSlot":1,"terastallize":False}
        switch = {"kind":"switch","switchSlot":2}
        policy = SimpleNamespace(seed=91,step=0,redraw=lambda legal:legal[0],
            member_probabilities=[[.1,.2,.7],[.2,.4,.4],[.4,.2,.4]])
        calls = []
        def original(battle,request,rechoose=False):
            if not rechoose:policy.step+=1;calls.append("forward")
            mapping=[(move,0),(move,1)]+([] if rechoose else [(switch,2)])
            policy.pending=(None,mapping);policy.pending_alias=(0,True)
            return move
        policy.propose=original;install(policy)
        chosen=policy.propose(None,{})
        mass=(.3*.6*.6)**(1/3)
        other=(.7*.4*.4)**(1/3)
        self.assertAlmostEqual(policy.ensemble_distribution["move 1"],mass/(mass+other),places=14)
        self.assertIn(chosen,[move,switch])
        self.assertEqual(policy.propose(None,{},True),move)
        self.assertEqual(policy.ensemble_distribution,{"move 1":1.})
        self.assertEqual(calls,["forward"])
        self.assertEqual(policy.step,1)
        self.assertTrue(policy.redrawn)

    def test_member_caches_are_client_local_and_temperature_changes_are_rejected(self):
        from ensemble_policy import EnsembleBatcher
        def submit(owner,inputs):
            owner.last_dist=SimpleNamespace(probs=torch.tensor([[[[.2,.8]]]]))
            return torch.zeros(1,1,1,dtype=torch.int64),inputs["hidden_state"]+1
        base=SimpleNamespace(experiment=SimpleNamespace(DEVICE=torch.device("cpu")),
            policy=SimpleNamespace(traj_encoder=SimpleNamespace(init_hidden_state=lambda *_:torch.zeros(1))))
        batcher=EnsembleBatcher([SimpleNamespace(base=base,submit=submit) for _ in range(3)])
        a,b=[SimpleNamespace(seed=i,temperature=1.) for i in (31,41)]
        inputs={"hidden_state":torch.zeros(1),"obs":{"illegal_actions":torch.tensor([[[False,False]]])}}
        batcher.submit(a,inputs);batcher.submit(a,inputs);batcher.submit(b,inputs)
        self.assertEqual([s.hidden.item() for s in a.member_states],[2.,2.,2.])
        self.assertEqual([s.hidden.item() for s in b.member_states],[1.,1.,1.])
        b.temperature=1.2
        with self.assertRaisesRegex(ValueError,"temperature 1"):batcher.submit(b,inputs)


class PriorityTests(unittest.TestCase):
    def test_busy_project_lease_records_wait_without_spawning(self):
        import os,sys
        from gpu_job import main
        with tempfile.TemporaryDirectory() as tmp:
            previous = Path.cwd()
            try:
                os.chdir(tmp);Path("tmp").mkdir()
                receipt = Path(tmp)/"lifecycle.json"
                with patch("gpu_job.fcntl.flock",side_effect=BlockingIOError),patch("gpu_job.subprocess.Popen") as spawn,patch.object(sys,"argv",["gpu_job","--receipt",str(receipt),"--","unused"]):
                    self.assertEqual(main(),75);spawn.assert_not_called()
                self.assertEqual(json.loads(receipt.read_text())["reasons"],[{"kind":"project_gpu_lease"}])
            finally:os.chdir(previous)

    @patch("gpu_job.subprocess.run")
    @patch("gpu_job.psutil.process_iter")
    @patch("gpu_job.Path.glob",return_value=[])
    def test_eval_between_games_blocks_even_without_gpu_context(self,claims,processes,query):
        processes.return_value = [SimpleNamespace(pid=81,info={"cmdline":["python","/tmp/run/supervise_remote.py","dev"]})]
        query.return_value = SimpleNamespace(stdout="")
        self.assertEqual(blockers({1}),[{"kind":"priority_process","pid":81}])

    @patch("gpu_job.subprocess.run")
    @patch("gpu_job.psutil.process_iter")
    @patch("gpu_job.Path.glob",return_value=[])
    def test_cpu_verification_allows_collection_after_gpu_release(self,claims,processes,query):
        commands = [["python","-B","/tmp/frozen/scripts/uu_eval/"+name,"run"]
                    for name in ("verify.py","analyze.py")]
        commands += [["node","--import","tsx","/tmp/frozen/scripts/uu_eval/"+name,"run"]
                     for name in ("verify_native.ts","verify_canonical.ts","verify_rerank.ts","verify_teams.ts")]
        processes.return_value = [SimpleNamespace(pid=80+i,info={"cmdline":cmd}) for i,cmd in enumerate(commands)]
        query.return_value = SimpleNamespace(stdout="")
        self.assertEqual(blockers({1}),[])
        # A marker still excludes GPU work throughout the cohort, even if only
        # its CPU verifier is visible, and a foreign GPU context always blocks.
        claims.return_value = [SimpleNamespace(read_text=lambda:'{"status":"HOLD"}')]
        self.assertEqual(blockers({1})[0]["kind"],"evaluation_claim")
        claims.return_value = []
        query.return_value = SimpleNamespace(stdout="80\n")
        self.assertEqual(blockers({1}),[{"kind":"foreign_gpu","pid":80}])

    @patch("gpu_job.subprocess.run")
    @patch("gpu_job.psutil.process_iter")
    @patch("gpu_job.Path.glob",return_value=[])
    def test_generation_and_tts_still_block_without_a_gpu_context(self,claims,processes,query):
        commands = [["python","-B","/tmp/frozen/scripts/uu_eval/"+name]
                    for name in ("evaluate.py","ensemble_worker.py","unknown.py")]
        commands += [["python","/tmp/tts_serve.py"]]
        processes.return_value = [SimpleNamespace(pid=80+i,info={"cmdline":cmd}) for i,cmd in enumerate(commands)]
        query.return_value = SimpleNamespace(stdout="")
        self.assertEqual(blockers({1}),[{"kind":"priority_process","pid":80+i} for i in range(len(commands))])

    @patch("gpu_job.subprocess.run")
    @patch("gpu_job.psutil.process_iter")
    @patch("gpu_job.Path.glob",return_value=[])
    def test_own_gpu_allowed_foreign_gpu_is_not(self,claims,processes,query):
        processes.return_value = []
        query.return_value = SimpleNamespace(stdout="1\n5\n")
        self.assertEqual(blockers({1}),[{"kind":"foreign_gpu","pid":5}])

    @patch("gpu_job.subprocess.run")
    @patch("gpu_job.psutil.process_iter",return_value=[])
    def test_pre_registered_claim_blocks_even_if_supervisor_vanished(self,processes,query):
        query.return_value = SimpleNamespace(stdout="")
        claim = SimpleNamespace(read_text=lambda:'{"status":"SEALED_WAITING_IDLE"}')
        with patch("gpu_job.Path.glob",return_value=[claim]):
            self.assertEqual(blockers({1})[0]["kind"],"evaluation_claim")
        claim.read_text = lambda:'{"status":"RELEASED","gpuUnloadProven":true}'
        with patch("gpu_job.Path.glob",return_value=[claim]):
            self.assertEqual(blockers({1}),[])


class PanelTests(unittest.TestCase):
    def test_progress_is_disjoint_and_test_files_need_not_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            pool = Path(tmp)/"pool"
            teams = pool/"teams/uu_train_v1"
            teams.mkdir(parents=True)
            families = []
            for i in range(8):
                path = teams/f"team{i}.txt";path.write_text(f"Public team {i}")
                families.append({"sha256":str(i),"key":str(i),"split":"train",
                                 "representative":str(path.relative_to(pool))})
            families += [{"sha256":"dev","split":"dev","representative":"FORBIDDEN"},
                         {"sha256":"test","split":"held-out","representative":"FORBIDDEN"}]
            (pool/"manifest.json").write_text(json.dumps({"families":families}))
            panel = prepare(pool,Path(tmp)/"panel",3)
            self.assertFalse({r["family"] for r in panel["progress"]}&{r["family"] for r in panel["collection"]})
            families[0]["sha256"] = "dev"
            (pool/"manifest.json").write_text(json.dumps({"families":families}))
            with self.assertRaisesRegex(ValueError,"overlap"):
                prepare(pool,Path(tmp)/"bad",3)


if __name__ == "__main__":
    unittest.main()
