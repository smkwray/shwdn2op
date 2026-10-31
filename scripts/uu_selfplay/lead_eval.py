"""Score team-preview lead models on parsed UU human replays (Metamon format): top-1 and NLL of the POV's actual lead.

Each POV's first state gives our six (with moves, ability, item), the opponent's preview, and the lead we sent (the
first state's active mon). Models are scored through TeamPreviewModel.predict_lead, the inference path a live caller
would use, against two baselines:
  uniform    1/6 for each of our six;
  frequency  each species' lead rate in the --train split (add-one smoothed toward 1/6), renormalised over our six.
Every POV is scored or the run fails: no silent skips. Confidence intervals and model-minus-frequency differences
come from a bootstrap over battles (both POVs of a battle move together; 1,000 resamples, seed 0).

Also top-1/NLL on the POVs that won (to compare winners-only training). Descriptive only, confounded by player
skill and team: win rate of POVs whose actual lead was the model's sole top pick versus the rest.

  python lead_eval.py --root SPLIT_ROOT --splits val [test] --train train --out OUT.json \
      --model NAME=CKPT[@FORMAT] ...    (FORMAT defaults to gen9uu; the gen9ou checkpoint is also scored as @gen9ou)
Needs Metamon's runtime (the project fork) on PYTHONPATH.
"""

import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
import random

import lz4.frame
import torch

from metamon.backend.replay_parser.str_parsing import pokemon_name
from metamon.backend.team_preview.preview import TeamPreviewModel
from metamon.interface import UniversalState


def load_split(folder):
    """One record per POV file; raises on anything TeamPreviewDataset would skip."""
    rows = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith((".json", ".json.lz4")):
            continue
        parts = name.split(".json")[0].split("_")
        if len(parts) != 7 or parts[6] not in ("WIN", "LOSS"):
            raise ValueError(f"unexpected file name {name}")
        opener = lz4.frame.open if name.endswith(".lz4") else open
        with opener(os.path.join(folder, name), "rb") as f:
            state = UniversalState.from_dict(json.load(f)["states"][0])
        team = [state.player_active_pokemon] + state.available_switches
        if len(team) != 6 or len(state.opponent_teampreview) != 6:
            raise ValueError(f"{name}: team {len(team)}, opponent preview {len(state.opponent_teampreview)}")
        rows.append({
            "battle": parts[0], "won": parts[6] == "WIN",
            "names": [p.name for p in team], "moves": [[m.name for m in p.moves] for p in team],
            "abilities": [p.ability for p in team], "items": [p.item for p in team],
            "opponent": list(state.opponent_teampreview), "lead": pokemon_name(state.player_active_pokemon.name),
        })
    if not rows:
        raise ValueError(f"no POVs in {folder}")
    return rows


def frequency_table(rows):
    seen, led = Counter(), Counter()
    for r in rows:
        for n in r["names"]:
            seen[pokemon_name(n)] += 1
        led[r["lead"]] += 1
    return {s: (led[s] + 1) / (seen[s] + 6) for s in seen}


def score(rows, probs_of):
    """Per-POV (p of the actual lead, top-1 credit). Ties at the top share the credit (uniform scores 1/6)."""
    out = []
    for r in rows:
        order, probs = probs_of(r)
        if sorted(order) != order or len(probs) != 6:
            raise ValueError("lead probabilities must be over our six in sorted-name order")
        i = [pokemon_name(n) for n in order].index(r["lead"])
        tops = [j for j in range(6) if probs[j] == max(probs)]
        out.append((float(probs[i]), (i in tops) / len(tops)))
    return out


def summarise(rows, scored, base, rng):
    """Means, battle-bootstrap 95% CIs, the paired difference against `base`, and the descriptive win split."""
    battles = sorted({r["battle"] for r in rows})
    by_battle = {b: [] for b in battles}
    for k, r in enumerate(rows):
        by_battle[r["battle"]].append(k)

    def stats(idx):
        n = len(idx)
        acc = sum(scored[k][1] for k in idx) / n
        nll = -sum(math.log(max(scored[k][0], 1e-12)) for k in idx) / n
        bacc = sum(base[k][1] for k in idx) / n
        bnll = -sum(math.log(max(base[k][0], 1e-12)) for k in idx) / n
        return acc, nll, acc - bacc, nll - bnll

    point = stats(range(len(rows)))
    boots = []
    for _ in range(1000):
        idx = [k for b in rng.choices(battles, k=len(battles)) for k in by_battle[b]]
        boots.append(stats(idx))

    def ci(j):
        v = sorted(x[j] for x in boots)
        return [round(v[25], 4), round(v[974], 4)]

    won = [k for k, r in enumerate(rows) if r["won"]]
    followed = [r["won"] for r, s in zip(rows, scored) if s[1] == 1]
    other = [r["won"] for r, s in zip(rows, scored) if s[1] < 1]
    return {
        "n_pov": len(rows), "n_battles": len(battles),
        "top1": round(point[0], 4), "top1_ci": ci(0), "nll": round(point[1], 4), "nll_ci": ci(1),
        "top1_minus_frequency": round(point[2], 4), "top1_minus_frequency_ci": ci(2),
        "nll_minus_frequency": round(point[3], 4), "nll_minus_frequency_ci": ci(3),
        "winners_only": {"n_pov": len(won), "top1": round(stats(won)[0], 4), "nll": round(stats(won)[1], 4)},
        "descriptive_win_rate": {
            "lead_was_top1": [round(sum(followed) / max(len(followed), 1), 4), len(followed)],
            "lead_was_not_top1": [round(sum(other) / max(len(other), 1), 4), len(other)],
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--splits", nargs="+", required=True)
    ap.add_argument("--train", default="train")
    ap.add_argument("--model", action="append", default=[])
    ap.add_argument("--format", default="gen9uu")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()

    freq = frequency_table(load_split(a.root / a.train / a.format))

    def frequency(r):
        order = sorted(r["names"], key=pokemon_name)
        rates = [freq.get(pokemon_name(n), 1 / 6) for n in order]  # species never seen in train: 1/6
        return order, [x / sum(rates) for x in rates]

    scorers = {"uniform": lambda r: (sorted(r["names"], key=pokemon_name), [1 / 6] * 6), "frequency": frequency}
    models = {}
    for spec in a.model:
        name, rest = spec.split("=", 1)
        path, _, fmt = rest.partition("@")
        model = TeamPreviewModel.load_from_checkpoint(path, device=a.device, use_argmax=True)
        models[name] = {"path": path, "format": fmt or a.format,
                        "trained_formats": model.trained_formats}

        def probs_of(r, model=model, fmt=fmt or a.format):
            lead, probs, order = model.predict_lead(r["names"], r["moves"], r["abilities"], r["items"],
                                                    r["opponent"], battle_format=fmt, device=a.device)
            return order, probs.tolist()

        scorers[name] = probs_of

    result = {"root": str(a.root), "frequency_from": a.train, "models": models, "splits": {}}
    for split in a.splits:
        rows = load_split(a.root / split / a.format)
        with torch.no_grad():
            scored = {name: score(rows, f) for name, f in scorers.items()}
        result["splits"][split] = {
            name: summarise(rows, s, scored["frequency"], random.Random(0)) for name, s in scored.items()
        }
        for name, m in result["splits"][split].items():
            print(f"{split:5} {name:28} n={m['n_pov']} top1={m['top1']:.4f} {m['top1_ci']} nll={m['nll']:.4f} "
                  f"{m['nll_ci']} d_top1_vs_freq={m['top1_minus_frequency']:+.4f} {m['top1_minus_frequency_ci']} "
                  f"d_nll_vs_freq={m['nll_minus_frequency']:+.4f} {m['nll_minus_frequency_ci']} "
                  f"win|top1={m['descriptive_win_rate']}", flush=True)
    a.out.write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
