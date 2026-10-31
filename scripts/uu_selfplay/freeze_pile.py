"""Freeze a training pile from validated self-play blocks.

Usage: freeze_pile.py OUT BLOCK_DIR [BLOCK_DIR ...] [--exclude BATTLE_TAG:PLAYER ...] [--single-pov-accounts A,B] [--models M,N]
Creates OUT/UUKakuna/metamon/gen9uu/ with hardlinks (copies across filesystems) of included
trajectories plus their sidecars, and OUT/manifest.json (per-file SHA256, exclusions with reasons).
Excluded: no sidecar, unfinished, time-limit truncated, no winner, tracker parse errors, unpaired
battle tag within its block (a league battle against a --single-pov-accounts baseline has one POV by
design), an own Illusion holder in a block collected before the Metamon fork's own-Illusion fix (the upstream
decoder mis-tracks its own disguised Zoroark; the opponent's POV is kept), or explicit excludes. A block's decoder is
read from its manifest, RUN/<block>-manifest.json beside RUN/piles/<block> (block.sh, block_portable.py): pre-fix means
its source_sha256 records upstream 0a00a759's metamon/env/metamon_battle.py; a block without that record stops the
freeze. An own Illusion holder is read from the trajectory itself (one of our mons, active or benched, with ability
illusion), not from the sidecar's team_file, which names the account's next sampled team in most POVs. Each kept entry records
the producing model (the pile's model directory) and its team set (an account's set is fixed; its file is not
reliable); --models keeps only those
models' POVs (pairing is still checked over the whole block), so league strata freeze separately. Invalid-order episodes are kept and counted
(upstream Metamon trains on them deliberately); a fine-tune config can still drop them by manifest.
"""
import argparse, collections, hashlib, json, os, pathlib, shutil
import lz4.frame

ap = argparse.ArgumentParser()
ap.add_argument("out"); ap.add_argument("blocks", nargs="+"); ap.add_argument("--exclude", action="append", default=[])
ap.add_argument("--single-pov-accounts", default="")
ap.add_argument("--models", default="", help="comma list of model directories to keep (default all)")
a = ap.parse_args()
out = pathlib.Path(a.out); dest = out / "UUKakuna/metamon/gen9uu"
if out.exists():
    raise SystemExit(f"refusing to overwrite {out}")
explicit = {tuple(x.rsplit(":", 1)) for x in a.exclude}
uid = lambda name: "".join(c for c in name.lower() if c.isalnum())  # sidecar opponents are user IDs
single = {uid(x) for x in a.single_pov_accounts.split(",") if x}
models = set(filter(None, a.models.split(",")))
PRE_FIX_DECODER = "562969d66e2bd2cb749ec00c044f730236e65e33f10b2c50e9a06e711cb5e900"  # upstream metamon_battle.py


def pre_fix(block):
    manifest = block.parent.parent / f"{block.name}-manifest.json"
    try:
        decoder = json.loads(manifest.read_text())["source_sha256"]["source/metamon/env/metamon_battle.py"]
    except (OSError, ValueError, KeyError) as e:
        raise SystemExit(f"{block}: no decoder record in {manifest} ({type(e).__name__})")
    return decoder == PRE_FIX_DECODER


def own_illusion(path):
    states = json.loads(lz4.frame.open(path).read())["states"]
    return any(mon.get("ability") == "illusion" for s in states for mon in [s["player_active_pokemon"], *s["available_switches"]])


pre_fix_blocks = [b for b in a.blocks if pre_fix(pathlib.Path(b))]
dest.mkdir(parents=True)
team_set = lambda m: m["team_file"].replace("\\", "/").split("/")[-3]  # .../TEAM_SET/FORMAT/TEAM_FILE
kept, excluded, counts = [], [], collections.Counter()
for block in map(pathlib.Path, a.blocks):
    files = sorted(block.rglob("*.json.lz4"))
    metas = {f: json.loads(pathlib.Path(str(f) + ".meta").read_text()) if pathlib.Path(str(f) + ".meta").exists() else None for f in files}
    tags = collections.Counter(m["battle_tag"] for m in metas.values() if m)
    for f, m in metas.items():
        draw = m is not None and m.get("schema")=="uu-native-replay@2" and m.get("result")=="DRAW" and m.get("terminal_score")==.5
        reason = ("no_sidecar" if m is None else "not_training_data" if m.get("purpose","selfplay")!="selfplay"
                  else "censored_incomplete" if m.get("schema")=="uu-native-replay@2" and m.get("result")=="INCOMPLETE"
                  else "not_training_data" if m.get("training_eligible",True) is not True
                  else "unfinished" if not m["finished"] else "time_limit" if m["hit_time_limit"]
                  else "no_winner" if m["won"] is None and not draw else "parse_errors" if m.get("parse_errors", 0) else "unpaired" if tags[m["battle_tag"]] != (1 if uid(m["opponent"]) in single else 2)
                  else None)
        if not reason and models and f.relative_to(block).parts[0] not in models:
            continue  # another stratum's POV, not an exclusion
        reason = reason or ("own_illusion_pre_fix" if str(block) in pre_fix_blocks and own_illusion(f)
                            else "explicit" if (m["battle_tag"], m["player"]) in explicit else None)
        if reason:
            excluded.append({"block": str(block), "file": f.name, "reason": reason}); counts[reason] += 1; continue
        name = f"{block.name}--{f.name}"
        for src, dst in ((f, dest / name), (pathlib.Path(str(f) + ".meta"), dest / (name + ".meta"))):
            try: os.link(src, dst)
            except OSError: shutil.copy2(src, dst)
        kept.append({"block": block.name, "file": name, "model": f.relative_to(block).parts[0], "sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
                     "battle_tag": m["battle_tag"], "player": m["player"], "team_set": team_set(m), "invalid_actions": m["invalid_actions"], "result": m["result"]})
manifest = {"trajectories": len(kept), "battles": len({(k["block"], k["battle_tag"]) for k in kept}),
            "with_invalid_orders": sum(k["invalid_actions"] > 0 for k in kept), "excluded": dict(counts),
            "explicit_excludes": sorted(map(list, explicit)), "pre_fix_blocks": pre_fix_blocks,
            "models": sorted(models),
            "single_pov_accounts": sorted(single), "blocks": a.blocks, "kept": kept, "excluded_files": excluded}
(out / "manifest.json").write_text(json.dumps(manifest, indent=1))
print(json.dumps({k: manifest[k] for k in ("trajectories", "battles", "with_invalid_orders", "excluded", "explicit_excludes")}))
