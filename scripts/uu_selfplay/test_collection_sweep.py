"""Game parity compares every attempt per side, independent of completion order."""
import json
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import unittest
from unittest.mock import patch
import collection_sweep as program
from collection_sweep import compare_games


class CollectionTests(unittest.TestCase):
    def test_started_qualification_yield_keeps_the_failed_attempt_and_never_retries_its_seed(self):
        from export_candidate import BASE_SHA
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);training=root/'training.json';training.write_text(json.dumps({'phase':'SWEEP_COMPLETE'}))
            for name in ('panel.json','fixture.json'):(root/name).write_text('{}')
            out=root/'collection'
            argv=['collection_sweep','--out',str(out),'--after-training',str(training),
                '--checkpoint',str(root/'base.pt'),'--source',str(root/'source'),'--pool',str(root/'pool'),
                '--panel',str(root/'panel.json'),'--fixture',str(root/'fixture.json'),'--node-modules',str(root/'deps'),'--wait']
            def interrupted(arguments,**kwargs):
                receipt=Path(arguments[arguments.index('--receipt')+1])
                receipt.write_text(json.dumps({'status':'YIELDED','reasons':[{'kind':'evaluation_claim'}],'returncode':-15}))
                return type('Result',(),{'returncode':75})()
            with patch('sys.argv',argv),patch.object(program,'policy_members',return_value=[{'name':'G0','sha256':BASE_SHA}]),patch.object(
                    program,'freeze_runtime',side_effect=lambda runtime,deps:runtime.mkdir()),patch.object(program,'retain_producer'),patch.object(
                    program,'blockers',return_value=[]),patch.object(program.psutil,'virtual_memory',return_value=type('Memory',(),{'available':2**60})()),patch.object(
                    program.subprocess,'run',side_effect=interrupted) as execute:
                with self.assertRaises(SystemExit) as stopped:program.main()
                self.assertEqual(stopped.exception.code,75)
                self.assertEqual(execute.call_count,1)
            state=json.loads((out/'status.json').read_text())
            self.assertEqual(state['phase'],'YIELDED')
            self.assertEqual(len(state['results']),1)
            self.assertEqual(state['results'][0]['lifecycle']['status'],'YIELDED')

    def test_frozen_runtime_contains_the_teacher_audits_real_imports(self):
        from batch_collect import freeze_runtime
        with tempfile.TemporaryDirectory() as tmp:
            runtime=Path(tmp)/"runtime"
            freeze_runtime(runtime,Path(tmp)/"deps")
            kit=runtime/"scripts/uu_selfplay"
            probe="import soft_policy, filter_families; from pathlib import Path; assert Path(filter_families.__file__).is_relative_to("+repr(str(runtime))+")"
            result=subprocess.run([sys.executable,"-c",probe],cwd=tmp,
                env={**os.environ,"PYTHONPATH":str(kit)},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)

    def test_terminal_training_dependency_is_recorded_before_the_queue_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);training=root/"training.json";training.write_text(json.dumps({"phase":"CONFIRMATION_MEMORY_STOP"}))
            for name in ("panel.json","fixture.json"):(root/name).write_text("{}")
            out=root/"collection"
            argv=["collection_sweep","--out",str(out),"--after-training",str(training),
                "--checkpoint",str(root/"policy.pt"),"--source",str(root/"source"),"--pool",str(root/"pool"),
                "--panel",str(root/"panel.json"),"--fixture",str(root/"fixture.json"),
                "--node-modules",str(root/"deps"),"--wait"]
            with patch("sys.argv",argv),patch.object(program,"policy_members",return_value=[{"name":"G0"}]),patch.object(
                    program,"freeze_runtime",side_effect=lambda runtime,deps:runtime.mkdir()),patch.object(program,"retain_producer"):
                with self.assertRaisesRegex(RuntimeError,"needs review"):program.main()
            state=json.loads((out/"status.json").read_text())
            self.assertEqual(state["phase"],"FAILED_DEPENDENCY")
            self.assertEqual(state["trainingPhase"],"CONFIRMATION_MEMORY_STOP")
            self.assertEqual(state["results"],[])

    def test_side_interleaving_is_irrelevant_and_missing_retry_or_action_drift_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            roots = [Path(tmp)/name for name in ("reference","batch")]
            rows = [{"side":"p1","turn":1,"rqid":3,"choice":"switch 2","accepted":False},
                    {"side":"p1","turn":1,"rqid":3,"choice":"move 1","accepted":True},
                    {"side":"p2","turn":1,"rqid":3,"choice":"move 2","accepted":True}]
            files = []
            for root in roots:
                directory = root/"worker-0/game-0000000";directory.mkdir(parents=True)
                files.append(directory/"trajectory.jsonl")
            files[0].write_text("\n".join(map(json.dumps,rows)))
            files[1].write_text("\n".join(map(json.dumps,[rows[2],*rows[:2]])))
            self.assertTrue(compare_games(*roots,count=1)["pass"])
            files[1].write_text("\n".join(map(json.dumps,rows[1:])))
            self.assertFalse(compare_games(*roots,count=1)["pass"])
            rows[1]["choice"] = "move 3"
            files[1].write_text("\n".join(map(json.dumps,rows)))
            self.assertFalse(compare_games(*roots,count=1)["pass"])


if __name__=="__main__":unittest.main()
