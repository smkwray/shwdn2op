"""The collection entry point preserves quotas and rejects implicit slot fallbacks."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from batch_collect import validate_collection_slots


class CollectionSlots(unittest.TestCase):
    def setUp(self):
        self.row = {"id":"game-1", "families":{"p1":"a","p2":"b"},
                    "models":{"p1":"learner","p2":"base"}, "policySeed":17,
                    "split":"actor", "opponentGroup":"e34"}

    def test_declared_order_seeds_and_opaque_quotas_are_preserved(self):
        rows = [self.row, {**copy.deepcopy(self.row), "id":"game-2", "policySeed":2}]
        before = json.dumps(rows)
        self.assertIs(validate_collection_slots(rows, {"a","b"}, {"learner","base"}), rows)
        self.assertEqual(json.dumps(rows), before)

    def test_bad_ids_seeds_and_rosters_cannot_fall_back(self):
        bad = [{"id":"CON"}, {"id":"../escape"}, {"policySeed":True}, {"policySeed":2**32},
               {"families":{"p1":"a","p2":"a"}}, {"families":{"p1":"a","p2":"reserved"}},
               {"models":{"p1":"unknown","p2":"base"}}, {"models":None}]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_collection_slots([{**copy.deepcopy(self.row), **change}], {"a","b"}, {"learner","base"})
        for rows in ([], [self.row,self.row]):
            with self.assertRaises(ValueError):validate_collection_slots(rows, {"a","b"}, {"learner","base"})

    def test_progress_cli_rejects_collection_slots_before_assets_or_workers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);slots = root/"slots.json";slots.write_text(json.dumps([self.row]))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("batch_collect.py")),
                "--out", str(root/"run"), "--checkpoint", "missing", "--panel", "missing", "--pool", "missing",
                "--purpose", "progress", "--collection-slots", str(slots)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Collection slots are selfplay-only", result.stderr)
            self.assertFalse((root/"run").exists())


if __name__ == "__main__":unittest.main()
