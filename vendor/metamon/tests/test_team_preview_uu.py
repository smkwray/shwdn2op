"""Team-preview lead model on a format the tokenizer predates (gen9uu), with a separate validation set.

Why it matters: the live advisor shows a random lead because Kakuna has no lead model, and Metamon's only lead
checkpoint is gen9ou. Training a UU one with Metamon's own trainer failed twice over upstream:
- "<gen9uu>" is not in DefaultObservationSpace-v1, so the format token is UNKNOWN_TOKEN (-1) and the embedding lookup
  crashes in training and in predict_lead. The fork drops the format prefix when every token in the batch is unknown.
- validation was a random 95/5 split of the training directory, which puts the other POV of a training battle (and
  the same players) in validation and overstates accuracy. val_dset_root takes our player-disjoint val split, whole
  and unfiltered: checkpoint selection must see every val POV, including unrated (tournament) games.
- UU has ~25x fewer human POVs than gen9ou, so init_checkpoint lets the UU model start from the gen9ou lead model's
  weights; it must start from exactly those weights, and refuse a checkpoint whose architecture differs.

Synthetic fixtures only. Runs from the project root against the fork itself (no data files needed):
  PYTHONPATH=vendor/metamon python -m unittest vendor/metamon/tests/test_team_preview_uu.py -v
"""

import json
import os
from pathlib import Path
import tempfile
import unittest
import warnings

warnings.filterwarnings("ignore")

import torch  # noqa: E402
from metamon.backend.team_preview.preview import (  # noqa: E402
    TeamPreviewDataset,
    TeamPreviewModel,
    train_team_preview,
)
from metamon.tokenizer import UNKNOWN_TOKEN, get_tokenizer  # noqa: E402

TOKENIZER = get_tokenizer("DefaultObservationSpace-v1")
OURS = ["skarmory", "toxapex", "chesnaught", "latios", "manaphy", "goodrahisui"]
THEIRS = ["slowking", "arcanine", "donphan", "ogerpon", "tornadus", "greninja"]
NOMOVE = {"name": "nomove", "move_type": "nomove", "category": "nomove", "base_power": 0, "accuracy": 1.0,
          "priority": 0, "current_pp": 0, "max_pp": 0}


def mon(name):
    moves = [dict(NOMOVE, name=m, move_type="normal", category="status") for m in ("protect", "rest")]
    return {"name": name, "hp_pct": 1.0, "types": "normal notype", "item": "leftovers", "ability": "pressure",
            "lvl": 100, "status": "nostatus", "effect": "noeffect", "moves": moves, "atk_boost": 0, "spa_boost": 0,
            "def_boost": 0, "spd_boost": 0, "spe_boost": 0, "accuracy_boost": 0, "evasion_boost": 0, "base_atk": 80,
            "base_spa": 80, "base_def": 80, "base_spd": 80, "base_spe": 80, "base_hp": 80, "tera_type": "normal",
            "base_species": name}


def write_pov(folder, i, lead, rating="1500", result="WIN"):
    state = {"format": "gen9uu", "player_active_pokemon": mon(lead), "opponent_active_pokemon": mon(THEIRS[0]),
             "available_switches": [mon(n) for n in OURS if n != lead], "player_prev_move": NOMOVE,
             "opponent_prev_move": NOMOVE, "opponents_remaining": 6, "player_conditions": "noconditions",
             "opponent_conditions": "noconditions", "weather": "noweather", "battle_field": "nofield",
             "forced_switch": False, "battle_won": False, "battle_lost": False, "can_tera": True,
             "opponent_teampreview": THEIRS}
    name = f"gen9uu-{1000 + i}_{rating}_ua_vs_ub_10-01-2026_{result}.json"
    Path(folder, name).write_text(json.dumps({"states": [state], "actions": [0]}))


class UnknownFormatToken(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.makedirs(Path(self.tmp.name, "gen9uu"))
        for i in range(4):
            write_pov(Path(self.tmp.name, "gen9uu"), i, OURS[i])

    def tearDown(self):
        self.tmp.cleanup()

    def test_gen9uu_has_no_token_so_the_model_runs_without_a_format_prefix(self):
        self.assertEqual(TOKENIZER["<gen9uu>"], UNKNOWN_TOKEN)
        data = TeamPreviewDataset(TOKENIZER, "gen9uu", self.tmp.name, min_rating=None, shuffle=False)
        team, info, lead, fmt = (torch.stack(x) for x in zip(*(data[i] for i in range(len(data)))))
        self.assertTrue(bool((fmt == UNKNOWN_TOKEN).all()))
        torch.manual_seed(0)
        model = TeamPreviewModel(TOKENIZER, d_model=16, n_heads=2, n_layers=1, dropout=0.0).eval()
        with torch.no_grad():
            self.assertTrue(torch.equal(model(team, info, fmt), model(team, info, None)))
            known = torch.full_like(fmt, TOKENIZER["<gen9ou>"])
            self.assertFalse(torch.equal(model(team, info, known), model(team, info, None)))
            with self.assertRaises(IndexError):  # mixing known and unknown formats must not pass silently
                model(team, info, torch.cat([known[:1], fmt[1:]]))

    def test_predict_lead_accepts_gen9uu(self):
        model = TeamPreviewModel(TOKENIZER, d_model=16, n_heads=2, n_layers=1, use_argmax=True)
        name, probs, order = model.predict_lead(OURS, [["protect", "rest"]] * 6, ["pressure"] * 6,
                                                ["leftovers"] * 6, THEIRS, battle_format="gen9uu", device="cpu")
        self.assertEqual(order, sorted(OURS))
        self.assertAlmostEqual(float(probs.sum()), 1.0, places=5)
        self.assertEqual(name, order[int(probs.argmax())])


class Training(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.train, self.val = Path(self.tmp.name, "train"), Path(self.tmp.name, "val")
        os.makedirs(self.train / "gen9uu")
        os.makedirs(self.val / "gen9uu")
        for i in range(8):  # one constant lead, so a few steps learn it and a best checkpoint gets saved
            write_pov(self.train / "gen9uu", i, OURS[2], result="WIN" if i % 2 else "LOSS")
        write_pov(self.train / "gen9uu", 50, OURS[0], rating="1100")  # below min_rating: not trained on
        for i in range(3):
            write_pov(self.val / "gen9uu", 100 + i, OURS[2], result="LOSS")
        write_pov(self.val / "gen9uu", 103, OURS[2], rating="Unrated")  # a tournament POV: still validated on

    def tearDown(self):
        self.tmp.cleanup()

    def run_trainer(self, out, **kw):
        torch.manual_seed(0)
        args = dict(battle_format="gen9uu", dset_root=str(self.train), min_rating=1300, val_dset_root=str(self.val),
                    epochs=1, steps_per_epoch=20, batch_size=4, lr=1e-2, d_model=16, n_heads=2, n_layers=1,
                    dloader_workers=0, log_wandb=False, device="cpu")
        train_team_preview(TOKENIZER, str(Path(self.tmp.name, out)), **{**args, **kw})
        return torch.load(Path(self.tmp.name, out, "latest_model.pt"), map_location="cpu", weights_only=False)

    def test_val_dset_root_is_used_whole_and_unfiltered(self):
        ckpt = self.run_trainer("out")
        data = ckpt["hparams"]["data"]
        self.assertEqual((data["train_size"], data["val_size"]), (8, 4))
        self.assertEqual(data["val_dset_root"], str(self.val))
        self.assertEqual(ckpt["val_acc"], 1.0)

    def test_init_checkpoint_starts_from_its_weights(self):
        first = self.run_trainer("first")
        init = str(Path(self.tmp.name, "first", "best_model.pt"))
        # lr 0 leaves the weights where they started: exactly the init checkpoint's, not a fresh draw.
        again = self.run_trainer("again", lr=0.0, init_checkpoint=init)
        self.assertEqual(again["hparams"]["training"]["init_checkpoint"], init)
        for key, value in first["model_state_dict"].items():
            self.assertTrue(torch.equal(value, again["model_state_dict"][key]), key)
        self.assertEqual(again["val_acc"], 1.0)
        with self.assertRaises(ValueError):
            self.run_trainer("wider", d_model=32, init_checkpoint=init)


if __name__ == "__main__":
    unittest.main()
