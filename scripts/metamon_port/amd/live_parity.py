"""Live-path parity of a Windows launch (live_worker.py) against production's CUDA-flex dump.

  python3 live_parity.py configs --launch config/metamon-live-X.json --remote-dir 'C:\\...\\live-probs' \\
          --out DIR NAME [NAME ...]
  python3 live_parity.py compare --probs DIR --ref tmp/metamon-port/torch-cuda-flex.jsonl --out X.json [--tol 1e-5]

configs writes DIR/NAME.json: the launch with METAMON_LIVE_PROB_LOG=REMOTE_DIR\\NAME set in its
remote pwsh command line (validation only: the log holds private battle state). Feed each to
replay_live.mts, then copy REMOTE_DIR back as --probs. NAME is GAME-SIDE (e.g. alex-uu01-b-p1-s3-p1).
compare matches every reference decision (game, side, rqid) to the one first-choice
(rechoose=false) row in probs/GAME-SIDE/*.jsonl. Pass: all matched, max |dp| <= tol, argmax,
legal sets and recurrence steps all equal.
"""

import argparse
import json
from pathlib import Path


def configs(a):
    launch = json.loads(a.launch.read_text())
    a.out.mkdir(parents=True, exist_ok=True)
    for name in a.names:
        cfg = dict(launch, args=list(launch["args"]))
        cfg["args"][-1] = f"$env:METAMON_LIVE_PROB_LOG='{a.remote_dir}\\{name}'; {cfg['args'][-1]}"
        cfg["validation"] = "probability logging enabled (private state); not for live use"
        (a.out / f"{name}.json").write_text(json.dumps(cfg, indent=1) + "\n")
    print(f"{len(a.names)} configs in {a.out}")


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, round(q * (len(values) - 1)))] if values else None


def compare(a):
    ref = [json.loads(line) for line in a.ref.read_text().splitlines() if line.strip()]
    cand, files, logged, propose_ms = {}, {}, 0, []
    for side_dir in sorted(p for p in a.probs.iterdir() if p.is_dir()):
        game, side = side_dir.name[:-3], side_dir.name[-2:]
        files[side_dir.name] = len(list(side_dir.glob("*.jsonl")))
        for f in sorted(side_dir.glob("*.jsonl")):
            rows = [json.loads(line) for line in f.read_text().splitlines() if line.strip()]
            propose_ms += [r["propose_ms"] for r in rows[1:]]  # first decision includes model load
            for r in rows:
                if not r["rechoose"]:
                    logged += 1
                    cand.setdefault((game, side, r["rqid"]), []).append(r)
    diffs, missing, agree, legal_eq, step_eq, late = [], [], 0, 0, 0, []
    for r in ref:
        key = (r["game"], r["side"], r["rqid"])
        found = cand.get(key, [])
        if len(found) != 1:
            missing.append([*key, len(found)])
            continue
        c = found[0]
        d = max(abs(x - y) for x, y in zip(r["probs"], c["probs"], strict=True))
        diffs.append((d, key))
        agree += r["argmax"] == c["argmax"]
        legal_eq += [i for i, m in enumerate(r["legal_mask"]) if m] == c["legal"]
        step_eq += r["step"] == c["step"]
        if r["step"] >= 97:
            late.append(d)
    n = len(diffs)
    worst = max(diffs) if diffs else (None, None)
    out = {"reference": str(a.ref), "probs": str(a.probs), "files_per_side": files, "reference_decisions": len(ref),
           "matched": n, "missing": missing, "max_abs_dp": worst[0], "worst": list(worst[1]) if worst[1] else None,
           f"decisions_over_{a.tol:g}": sum(d > a.tol for d, _ in diffs), "argmax_agree": agree,
           "legal_sets_equal": legal_eq, "steps_equal": step_eq,
           "window_active": {"n": len(late), "max_abs_dp": max(late) if late else None},
           "all_sides_logged": logged, "propose_ms_excl_first": {"p50": pct(propose_ms, 0.5), "p95": pct(propose_ms, 0.95)},
           "tol": a.tol}
    out["pass"] = (n == len(ref) and not missing and out[f"decisions_over_{a.tol:g}"] == 0
                   and agree == legal_eq == step_eq == n)
    a.out.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out, indent=1))
    return 0 if out["pass"] else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    c = sub.add_parser("configs")
    c.add_argument("--launch", type=Path, required=True)
    c.add_argument("--remote-dir", required=True)
    c.add_argument("--out", type=Path, required=True)
    c.add_argument("names", nargs="+")
    m = sub.add_parser("compare")
    m.add_argument("--probs", type=Path, required=True)
    m.add_argument("--ref", type=Path, required=True)
    m.add_argument("--out", type=Path, required=True)
    m.add_argument("--tol", type=float, default=1e-5)
    a = ap.parse_args()
    return configs(a) if a.mode == "configs" else compare(a)


if __name__ == "__main__":
    raise SystemExit(main())
