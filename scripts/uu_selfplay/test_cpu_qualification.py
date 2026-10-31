"""The independent parent guard enforces a future start even with a yield permit."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import cpu_qualification as guard


class WindowGuard(unittest.TestCase):
    def exercise(self,not_before,cutoff,expected):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'tmp').mkdir();out=root/'receipt.json';plan=root/'plan.json'
            plan.write_text(json.dumps({'cwd':str(root),'run':'tmp/uu-selfplay-macbox-qualification',
                'argv':['unused'],'env':{},'receipt':str(out),'yieldStatus':'unused',
                'memory':dict(startGiB=22,startPercent=60,stableSeconds=2,stopGiB=8,stopPercent=35),
                'notBeforeUnix':not_before,'cutoffUnix':cutoff}))
            clock=[0.];started=[]
            process=SimpleNamespace(pid=123,nice=lambda:20,create_time=lambda:1.,children=lambda recursive:[],parents=lambda:[],
                                    status=lambda:guard.psutil.STATUS_ZOMBIE,
                                    memory_info=lambda:SimpleNamespace(rss=0))
            child=SimpleNamespace(pid=123,returncode=0,poll=lambda:0,wait=lambda **kwargs:0)
            def launch(*args,**kwargs):started.append(clock[0]);return child
            with patch('sys.argv',['guard','--plan',str(plan)]),patch.object(guard,'memory',lambda:(24,70)),\
                 patch.object(guard,'permitted',lambda path:True),patch.object(guard.psutil,'Process',lambda *args:process),\
                 patch.object(guard.time,'time',lambda:clock[0]),patch.object(guard.time,'monotonic',lambda:clock[0]),\
                 patch.object(guard.time,'sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)),\
                 patch.object(guard.os,'killpg'),patch.object(guard.psutil,'process_iter',lambda *_:[]),\
                 patch.object(guard.subprocess,'Popen',launch):
                result=guard.main()
            receipt=json.loads(out.read_text())
            self.assertEqual(receipt['phase'],expected)
            self.assertEqual(receipt['notBeforeUnix'],not_before)
            return result,started

    def test_cutoff_before_window_opens_never_dispatches(self):
        code,started=self.exercise(30,20,'CUTOFF_BEFORE_START')
        self.assertEqual(code,75);self.assertEqual(started,[])

    def test_stability_counts_only_after_window_opens(self):
        code,started=self.exercise(5,20,'COMPLETED')
        self.assertEqual(code,0);self.assertEqual(started,[7.])

    def test_exited_launcher_does_not_hide_a_reparented_collector(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'tmp').mkdir();scope=root/'tmp/owned'
            plan=root/'plan.json';receipt=root/'receipt.json';clock=[0.];killed=[]
            plan.write_text(json.dumps(dict(cwd=str(root),run='tmp/uu-selfplay-macbox-test',
                argv=['unused'],env={},receipt=str(receipt),yieldStatus='unused',
                memory=dict(startGiB=22,startPercent=60,stableSeconds=1,stopGiB=8,stopPercent=35),
                cutoffUnix=20,ownedNamespaces=[str(scope)])))
            def process(pid,script):
                return SimpleNamespace(pid=pid,info=dict(pid=pid,name='python'),nice=lambda:20,
                    parents=lambda:[processes[999]],
                    create_time=lambda:1.,children=lambda recursive:[],cmdline=lambda:['python',script],
                    memory_info=lambda:SimpleNamespace(rss=0),
                    status=lambda:guard.psutil.STATUS_ZOMBIE if pid==123 or pid in killed else 'running',
                    kill=lambda:killed.append(pid))
            processes={123:process(123,'launcher'),456:process(456,str(scope/'runtime/batch_server.py')),
                       789:process(789,str(root/'unrelated.py')),999:process(999,str(scope/'controller.py'))}
            def exiting():raise SystemError('proc_cmdline returned a result with an exception set')
            processes[789].cmdline=exiting  # An exiting foreign process must not crash the guard.
            child=SimpleNamespace(pid=123,returncode=1,poll=lambda:1,wait=lambda **kwargs:1)
            with patch('sys.argv',['guard','--plan',str(plan)]), \
                    patch.object(guard,'memory',lambda:(24,70)),patch.object(guard,'permitted',lambda _:True), \
                    patch.object(guard.psutil,'Process',lambda pid=123:processes[pid]), \
                    patch.object(guard.psutil,'process_iter',lambda *_:[processes[456],processes[789],processes[999]]), \
                    patch.object(guard.time,'time',lambda:clock[0]), \
                    patch.object(guard.time,'monotonic',lambda:clock[0]), \
                    patch.object(guard.time,'sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)), \
                    patch.object(guard.os,'killpg'),patch.object(guard.subprocess,'Popen',lambda *a,**k:child):
                self.assertEqual(guard.main(),1)
            result=json.loads(receipt.read_bytes())
            self.assertEqual(result['phase'],'FAILED_RETAINED')
            self.assertIn('456',result['ownedProcesses'])
            self.assertIn(456,killed);self.assertNotIn(789,killed)
            self.assertNotIn('999',result['ownedProcesses']);self.assertNotIn(999,killed)
            self.assertEqual(result['ownedSurvivors'],[])


if __name__=='__main__':unittest.main()
