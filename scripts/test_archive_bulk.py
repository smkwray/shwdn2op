"""Deletion guards exercise the selected archiver; no real host is contacted."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import archive_bulk


class DeletionGuards(unittest.TestCase):
    def exercise(self, deduplication):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); scope = root/'closed'; scope.mkdir()
            source = scope/'weights.bin'
            with source.open('wb') as stream:
                stream.truncate(51*2**20)
            digest = archive_bulk.sha(source); stat = source.stat()
            job = dict(schema='closed-bulk-archive@1', root=str(root), scopes=['closed'],
                       protectedPaths=[], hashes={}, out=str(root/'result'),
                       stopByUnix=time.time()+60, destinationHost='archive-host',
                       destinationRoot='/archive', files=[dict(path='closed/weights.bin',
                           bytes=stat.st_size, mtimeNs=stat.st_mtime_ns)])
            if deduplication:
                job['deduplicateObjects'] = {digest:'/archive/known-object'}
            config = root/'job.json'; config.write_text(json.dumps(job))
            replies = [SimpleNamespace(stdout=json.dumps(dict(
                sha256=None if deduplication else 'f'*64, freeBytes=10**12, totalBytes=2*10**12)))]
            if deduplication:
                replies.append(subprocess.CalledProcessError(1, ['ssh'], stderr='object SHA mismatch'))
            with patch.object(sys, 'argv', ['archive', '--job', str(config)]), \
                    patch.object(archive_bulk.subprocess, 'run', side_effect=replies) as remote:
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    archive_bulk.main()
            self.assertTrue(source.exists())
            self.assertTrue(all(call.args[0][0]=='ssh' for call in remote.call_args_list))
            report = json.loads((root/'result/status.json').read_bytes())
            self.assertEqual(report['phase'], 'FAILED_OR_UNKNOWN_RETAINED')
            self.assertEqual(report['deletedBytes'], 0)

    def test_destination_collision_prevents_copy_and_unlink(self):
        self.exercise(False)

    def test_changed_deduplication_object_prevents_unlink(self):
        self.exercise(True)


if __name__ == '__main__':
    unittest.main()
