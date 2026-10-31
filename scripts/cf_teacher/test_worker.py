"""Replay worker's small-team controls use the same production RPC seat."""
import importlib.util
from pathlib import Path
import types
import unittest
spec=importlib.util.spec_from_file_location('cf_worker',Path(__file__).with_name('worker.py'))
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
class WorkerTest(unittest.TestCase):
    def test_preview_commits_bind_the_actual_private_roster(self):
        def require(ok,*args):
            if not ok: raise ValueError('bad preview')
        seat=worker.Seat(types.SimpleNamespace(require=require,SocketlessBattle=lambda: None),None,'p1')
        seat.decoder=types.SimpleNamespace(request={'teamPreview':True,'side':{'pokemon':[{}]}})
        seat.commit('team 1')
        with self.assertRaises(ValueError): seat.commit('team 123456')
if __name__=='__main__': unittest.main()
