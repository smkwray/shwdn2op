"""Validate a UU pile: raw trajectory shape, sidecar quarantine flags and POV pairing,
and a full load through MetamonDataset with UUKakuna's spaces.
Usage: validate_pile.py PILE_DIR [--single-pov-accounts A,B] [--human]
  --single-pov-accounts  league accounts that write no trajectories (heuristic baselines): a battle against
                         one of them has exactly one POV, counted as single_pov_expected instead of a bad pair.
  --human                reconstructed replays (human_replays.py): action -1 marks an unrevealed choice
                         (Metamon masks it in the actor loss); counted, not a shape error. No sidecars."""
import argparse, json, pathlib, collections, re
import lz4.frame

ap = argparse.ArgumentParser()
ap.add_argument("pile")
ap.add_argument("--single-pov-accounts", default="")
ap.add_argument("--human", action="store_true")
args = ap.parse_args()
uid = lambda name: re.sub(r"[^a-z0-9]", "", name.lower())  # sidecar opponents are Showdown user IDs
single = {uid(x) for x in args.single_pov_accounts.split(",") if x}
pile = pathlib.Path(args.pile)
files = sorted(pile.rglob("*.json.lz4"))
report = {"pile": str(pile), "trajectories": len(files), "shape_errors": [], "sidecars": 0}
tags = collections.defaultdict(list)
flags = collections.Counter()
lengths = []
missing = 0
lo = -1 if args.human else 0
for f in files:
    d = json.loads(lz4.frame.open(f).read())
    s, a = d.get("states"), d.get("actions")
    ok = isinstance(s, list) and isinstance(a, list) and len(s) == len(a) and a and a[-1] == -1 \
        and all(isinstance(x, int) and x >= lo for x in a[:-1])
    if not ok:
        report["shape_errors"].append(f.name)
    lengths.append(len(a or []))
    missing += sum(x == -1 for x in (a or [])[:-1])
    meta = pathlib.Path(str(f) + ".meta")
    if meta.exists():
        m = json.loads(meta.read_text())
        report["sidecars"] += 1
        tags[m["battle_tag"]].append(m)
        flags["unfinished"] += not m["finished"]
        flags["time_limit"] += m["hit_time_limit"]
        flags["invalid_orders"] += m["invalid_actions"] > 0
        draw = (m.get("schema") == "uu-native-replay@2" and m.get("result") == "DRAW"
                and m.get("terminal_score") == .5)
        flags["no_winner"] += m["won"] is None and not draw
        flags["states_mismatch"] += m["states"] != len(s)
        flags["parse_errors"] += m.get("parse_errors", 0) > 0
report["decisions_per_trajectory"] = {"min": min(lengths, default=0), "max": max(lengths, default=0),
                                      "mean": round(sum(lengths) / max(len(lengths), 1), 1)}
if args.human:
    decisions = sum(lengths) - len(lengths)
    report["missing_actions"] = missing
    report["missing_action_rate"] = round(missing / max(decisions, 1), 4)
if report["sidecars"]:
    exact = lambda v: len(v) == 2 and v[0]["player"] != v[1]["player"]
    lone = lambda v: len(v) == 1 and uid(v[0]["opponent"]) in single
    report["battle_tags"] = len(tags)
    report["pairs_exact"] = sum(1 for v in tags.values() if exact(v))
    report["single_pov_expected"] = sum(1 for v in tags.values() if lone(v))
    report["pairs_bad"] = [t for t, v in tags.items() if not (exact(v) or lone(v))]
    report["quarantine_flags"] = dict(flags)
    report["pov_vs_opponent"] = dict(collections.Counter(f"{uid(m['player'])}>{uid(m['opponent'])}" for v in tags.values() for m in v))

# Full load through the training data path with the model's own spaces.
from metamon.rl.pretrained import UUKakuna
from metamon.data.parsed_replay_dset import MetamonDataset
model = UUKakuna()
roots = {p.parent.parent for p in files}
loaded, load_errors = 0, []
for root in sorted(roots):
    ds = MetamonDataset(dset_root=str(root), observation_space=model.observation_space,
                        action_space=model.action_space, reward_function=model.reward_function,
                        formats=["gen9uu"], verbose=False)
    for i in range(len(ds)):
        try:
            ds[i]; loaded += 1
        except Exception as e:
            load_errors.append(f"{root}:{i}:{type(e).__name__}:{e}"[:200])
report["dataset_loaded"] = loaded
report["dataset_errors"] = load_errors[:10]
print(json.dumps(report, indent=1))
