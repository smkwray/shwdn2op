"""heldout_nll.py compare: the arm verdict rests on paired per-decision differences with battle-clustered errors, so
a shifted arm must show its exact shift, unpaired files must be refused, and a constant per-decision shift must have
zero clustered error (the centering is per cluster size, not per file). Run: python3 -m unittest test_heldout_nll"""
import json, pathlib, subprocess, sys, tempfile, unittest

H = pathlib.Path(__file__).resolve().parent / "heldout_nll.py"


def result(path, rows, ckpt=r"C:\x\ckpts\arm_a\ckpts\policy_weights\policy_epoch_1.pt", data=r"C:\x\league-other\UUKakuna\metamon"):
    scored = sum(r["scored"] for r in rows)
    path.write_text(json.dumps({"model": "UUFinetuned", "checkpoint_path": ckpt, "data": {data: {
        "nll": sum(r["nll_sum"] for r in rows) / scored, "top1": sum(r["correct"] for r in rows) / scored, "rows": rows}}}))


def row(name, scored, nll, correct):
    return {"file": name, "scored": scored, "nll_sum": nll, "correct": correct}


class Compare(unittest.TestCase):
    def run_compare(self, base_rows, arm_rows):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            result(d / "b.json", base_rows); result(d / "a.json", arm_rows)
            return subprocess.run([sys.executable, str(H), "compare", str(d / "b.json"), str(d / "a.json")],
                                  capture_output=True, text=True)

    def test_constant_shift_exact_with_zero_error(self):
        names = ["zl1--metamon-gen9uu-001_x.json.lz4", "zl1--metamon-gen9uu-002_x.json.lz4", "zl2--metamon-gen9uu-001_x.json.lz4"]
        sizes = [10, 30, 20]
        base = [row(n, k, 2.0 * k, k // 2) for n, k in zip(names, sizes)]
        arm = [row(n, k, 1.5 * k, k // 2) for n, k in zip(names, sizes)]  # every decision 0.5 nats better
        out = self.run_compare(base, arm)
        self.assertEqual(out.returncode, 0, out.stderr)
        r = json.loads(out.stdout)
        self.assertEqual((r["arm"], r["data"], r["battles"], r["scored"]), ("UUFinetuned:arm_a", "league-other", 3, 60))
        self.assertAlmostEqual(r["d_nll"], -0.5)
        self.assertAlmostEqual(r["d_nll_se"], 0.0)

    def test_povs_of_one_battle_share_a_cluster(self):
        base = [row("gen9uu-77_1500_a_vs_b.json.lz4", 10, 10.0, 5), row("gen9uu-77_1500_b_vs_a.json.lz4", 10, 10.0, 5)]
        arm = [row("gen9uu-77_1500_a_vs_b.json.lz4", 10, 5.0, 6), row("gen9uu-77_1500_b_vs_a.json.lz4", 10, 15.0, 5)]
        out = self.run_compare(base, arm)
        r = json.loads(out.stdout)
        self.assertEqual(r["battles"], 1)
        self.assertAlmostEqual(r["d_nll"], 0.0)
        self.assertAlmostEqual(r["d_top1"], 0.05)
        self.assertNotEqual(r["d_nll_se"], r["d_nll_se"])  # NaN: one cluster has no error estimate

    def test_unpaired_files_refused(self):
        out = self.run_compare([row("gen9uu-1_x.json.lz4", 5, 5.0, 1)], [row("gen9uu-2_x.json.lz4", 5, 5.0, 1)])
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("differ from base", out.stderr)


if __name__ == "__main__":
    unittest.main()
