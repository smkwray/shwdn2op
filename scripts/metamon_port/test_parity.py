"""Behavioral checks: recorded-state parity, strict evidence, attention boundary.

Run after `parity.py suite`. Missing local replay evidence is a failure, not a
skip: a new device must actually execute both backends before claiming parity.
"""

import copy
import json
import subprocess
import sys
import unittest

from common import OUT, ROOT, digest, setup
from parity import compare


class ParityTests(unittest.TestCase):
    def test_recorded_fixture(self):
        """Execute both implementations now, so changed code cannot pass stale dumps."""
        for backend in ("torch-cpu", "mlx"):
            subprocess.run([sys.executable, "-B", str(ROOT / "scripts/metamon_port/parity.py"),
                "run", "--backend", backend, "--limit", "3", "--output", str(OUT / f"test-{backend}.jsonl")],
                cwd=ROOT, check=True)
        result = compare(OUT / "test-torch-cpu.jsonl", OUT / "test-mlx.jsonl", min_decisions=3, min_games=1)
        self.assertTrue(result["passed"])

    def test_full_replay_evidence(self):
        """The full run must cover eviction, and its producer must be the current code."""
        result = compare(OUT / "torch-cpu.jsonl", OUT / "mlx.jsonl")
        self.assertTrue(result["passed"])
        self.assertGreater(result["decisions_after_window_boundary"], 0,
                           "Short trajectories cannot qualify cache eviction")
        for backend in ("torch-cpu", "mlx"):
            summary = json.loads((OUT / f"{backend}.summary.json").read_text())
            for name, sha in summary["source_files"].items():
                self.assertEqual(digest(name), sha, "Rerun the suite after producer edits")
        mlx = json.loads((OUT / "mlx.summary.json").read_text())
        self.assertEqual(mlx["metadata"]["device"], "Device(gpu, 0)")
        self.assertEqual(mlx["memory_after_explicit_unload"]["gpu_active_bytes"], 0)

    def test_comparator_rejects_changed_decision(self):
        """A probability regression must fail even when the legal mask matches."""
        rows = [json.loads(l) for l in (OUT / "mlx.jsonl").read_text().splitlines()]
        changed = copy.deepcopy(rows)
        p = changed[0]["probs"]
        maximum, minimum = max(range(13), key=p.__getitem__), min(range(13), key=p.__getitem__)
        p[maximum] -= 0.01
        p[minimum] += 0.01
        path = OUT / "scratch/test-corrupted.jsonl"
        try:
            path.write_text("".join(json.dumps(r) + "\n" for r in changed))
            with self.assertRaises(AssertionError):
                compare(OUT / "torch-cpu.jsonl", path)
        finally:
            path.unlink(missing_ok=True)

    def test_inclusive_window_matches_upstream(self):
        """Distance 96 remains visible; distance 97 and future tokens do not."""
        import torch
        from amago.nets.transformer import SlidingWindowFlexAttention
        from torch_backend import dense_window
        attention = SlidingWindowFlexAttention(causal=True, dropout=0.0, window_size=96)
        lengths = torch.tensor([98], dtype=torch.int32)
        mask = attention.kv_cache_mask_mod(lengths)
        self.assertTrue(mask(0, 0, 0, 2))
        self.assertFalse(mask(0, 0, 0, 1))
        self.assertFalse(mask(0, 0, 0, 99))
        keys = torch.zeros(1, 128, 1, 1)
        values = torch.zeros_like(keys)
        values[0, 1] = 10000  # Must be excluded.
        values[0, 2] = 97     # Oldest included value; uniform mean must be 1.
        out = dense_window(torch.zeros(1, 1, 3, 1, 1), keys, values, lengths)
        torch.testing.assert_close(out, torch.ones_like(out))


if __name__ == "__main__":
    setup()
    unittest.main()
