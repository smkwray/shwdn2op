"""Concurrent telemetry failure stays explicit and cannot fabricate completion."""
import json
from types import SimpleNamespace
import unittest
from batch_collect import read_shard_statistics


class Statistics(unittest.TestCase):
    def test_locked_partial_missing_then_complete(self):
        previous=dict(startedGames=3,completed=2,failed=0,censored=0)
        for error in (PermissionError(),FileNotFoundError(),json.JSONDecodeError('partial','{',1)):
            def read():raise error
            value,status=read_shard_statistics(SimpleNamespace(read_text=read),previous)
            self.assertIs(value,previous);self.assertEqual(status,type(error).__name__)
        final={**previous,'completed':3}
        self.assertEqual(read_shard_statistics(SimpleNamespace(read_text=lambda:json.dumps(final)),previous),(final,None))
        with self.assertRaisesRegex(ValueError,'Malformed'):
            read_shard_statistics(SimpleNamespace(read_text=lambda:'{}'),previous)


if __name__=='__main__':unittest.main()
