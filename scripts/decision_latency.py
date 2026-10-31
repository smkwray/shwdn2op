"""Per-section paint latency of live or e2e decisions, from the journals' `latency` rows (written by the companion from
the extension's client status: ms after the page saw each request until each section first painted).
Usage: python3 scripts/decision_latency.py JOURNAL_OR_DIR...   (default .local-data/metamon-live)"""
import json, pathlib, sys

SECTIONS = ("speed", "sets", "damage", "threats", "pick", "warnings")
paths = [pathlib.Path(p) for p in sys.argv[1:]] or [pathlib.Path(".local-data/metamon-live")]
files = sorted(f for p in paths for f in ([p] if p.is_file() else p.rglob("*.jsonl")))
rows = [r for f in files for r in map(json.loads, f.read_text().splitlines()) if r.get("kind") == "latency"]
def pct(xs, q): xs = sorted(xs); return xs[min(len(xs) - 1, int(q * len(xs)))]
print(f"{len(rows)} requests from {len(files)} journals")
for kind in sorted({r["request"] for r in rows}):
    group = [r for r in rows if r["request"] == kind]
    print(f"{kind} ({len(group)}):")
    for section in SECTIONS:
        xs = [r["sections"][section] for r in group if section in r["sections"]]
        if xs: print(f"  {section:9} n={len(xs):3}  p50 {pct(xs, .5):6.0f} ms  p90 {pct(xs, .9):6.0f} ms  max {max(xs):6.0f} ms")
