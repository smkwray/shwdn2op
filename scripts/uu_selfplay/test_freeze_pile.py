"""freeze_pile.py's own-Illusion rule: only blocks whose manifest records upstream's decoder lose own-Illusion POVs.

Why: upstream Metamon mis-tracked its own disguised Zoroark, so those POVs' states are wrong and must not train; the
fork decodes them correctly, so blocks collected with it keep them. Holders are read from the trajectory because the
sidecar's team_file names the account's next sampled team. Run with any python that has lz4 (e.g. the run venv):
  python -m unittest test_freeze_pile
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import lz4.frame

K = Path(__file__).resolve().parent
UPSTREAM = "562969d66e2bd2cb749ec00c044f730236e65e33f10b2c50e9a06e711cb5e900"  # 0a00a759 metamon_battle.py
FORK = "0" * 64


def mon(name, ability):
    return {"name": name, "ability": ability, "hp_pct": 1.0}


def pov(pile, tag, player, opponent, ours, team_file):
    """One finished POV: two states (our mons active and benched) plus its sidecar."""
    d = pile / "UUKakuna/metamon/gen9uu"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{tag}-{player}.json.lz4"
    states = [{"player_active_pokemon": ours[0], "available_switches": ours[1:]}] * 2
    with lz4.frame.open(path, "wb") as f:
        f.write(json.dumps({"states": states, "actions": [0, -1]}).encode())
    Path(str(path) + ".meta").write_text(json.dumps({
        "battle_tag": tag, "player": player, "opponent": opponent, "team_file": team_file, "result": "WIN",
        "finished": True, "won": True, "hit_time_limit": False, "invalid_actions": 0, "valid_actions": 1, "states": 2}))


class FreezeIllusionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name)
        zoroark = [mon("zoroarkhisui", "illusion"), mon("hydrapple", "regenerator")]
        plain = [mon("tinkaton", "moldbreaker"), mon("swampert", "torrent")]
        # The sidecar names a plain team for the Zoroark POV (next sampled team), as in production.
        for block, decoder in (("lg1", UPSTREAM), ("lg2", FORK)):
            pile = self.run / "piles" / block
            pov(pile, "battle-1", "UUA", "UUB", zoroark, "/x/teams/uu_train_v1/gen9uu/team_000001.gen9uu_team")
            pov(pile, "battle-1", "UUB", "UUA", plain, "/x/teams/uu_train_v1/gen9uu/team_000242.gen9uu_team")
            (self.run / f"{block}-manifest.json").write_text(json.dumps(
                {"source_sha256": {"source/metamon/env/metamon_battle.py": decoder}}))

    def tearDown(self):
        self.tmp.cleanup()

    def freeze(self, *blocks):
        out = self.run / "out"
        done = subprocess.run([sys.executable, str(K / "freeze_pile.py"), str(out), *(str(self.run / "piles" / b) for b in blocks)],
                              capture_output=True, text=True)
        return done, (json.loads((out / "manifest.json").read_text()) if done.returncode == 0 else None)

    def test_pre_fix_block_drops_only_its_own_illusion_pov(self):
        done, manifest = self.freeze("lg1", "lg2")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(manifest["excluded"], {"own_illusion_pre_fix": 1})
        self.assertEqual(manifest["excluded_files"][0]["file"], "battle-1-UUA.json.lz4")
        self.assertIn("lg1", manifest["excluded_files"][0]["block"])
        kept = sorted((k["block"], k["player"]) for k in manifest["kept"])
        self.assertEqual(kept, [("lg1", "UUB"), ("lg2", "UUA"), ("lg2", "UUB")])  # opponent POV and fixed block kept
        self.assertEqual(manifest["pre_fix_blocks"], [str(self.run / "piles/lg1")])

    def test_block_without_decoder_record_stops_the_freeze(self):
        (self.run / "lg2-manifest.json").unlink()
        done, manifest = self.freeze("lg1", "lg2")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("no decoder record", done.stderr)
        self.assertFalse((self.run / "out").exists())


if __name__ == "__main__":
    unittest.main()
