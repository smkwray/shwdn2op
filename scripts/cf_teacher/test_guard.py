"""Production admission checks without a GPU or private device configuration."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

# The production dependency is already used by the project's self-play runners.
# Stub process inventory so these tests also run on a stdlib-only controller.
fake = types.SimpleNamespace(Error=RuntimeError, NoSuchProcess=ProcessLookupError)
spec = importlib.util.spec_from_file_location('cf_guard', Path(__file__).with_name('guard.py'))
guard = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, psutil=fake):
    spec.loader.exec_module(guard)


class GuardTest(unittest.TestCase):
    def setUp(self):
        fake.Process = lambda _: types.SimpleNamespace(children=lambda recursive: [types.SimpleNamespace(pid=12)])
        fake.process_iter = lambda _: []
        fake.virtual_memory = lambda: types.SimpleNamespace(available=16 * 2**30)

    def sample(self, heavy, gpu):
        with patch.object(guard.subprocess, 'check_output', side_effect=[json.dumps(heavy), gpu]):
            return guard.sample(10, ['production-status'])

    def test_only_owned_gpu_processes_are_admitted(self):
        s = self.sample({'ok': True, 'current': None}, '12\n99\n')
        self.assertEqual(s['ownedGpuPids'], [12])
        self.assertEqual(s['foreignGpuPids'], [99])

    def test_production_job_requires_yield_even_before_gpu_allocation(self):
        self.assertTrue(self.sample({'ok': True, 'current': {'kind': 'tts'}}, '')['heavyActive'])

    def test_missing_or_invalid_production_status_fails_closed(self):
        for status in ({'ok': True}, {'ok': False, 'current': None}):
            with self.assertRaises(ValueError):
                self.sample(status, '')

    def test_evaluation_queue_is_independent_of_gpu_inventory(self):
        fake.process_iter = lambda _: [types.SimpleNamespace(pid=88, info={'cmdline': ['zsh', '/example/scripts/uu_eval/queue_dev.sh']})]
        self.assertEqual(self.sample({'ok': True, 'current': None}, '')['evalProcesses'], 1)


if __name__ == '__main__':
    unittest.main()
