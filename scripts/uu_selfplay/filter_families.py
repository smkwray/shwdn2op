"""Filter frozen self-play by both players' observed own rosters, never sidecar teams.

Only unambiguous collection families survive. Unknown, incomplete, form-collapsed
or unpaired rosters are counted and excluded. A probe writes no training files.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
import random
import re
from pathlib import Path
import shutil
import time

import lz4.frame


def sha(data):return hashlib.sha256(data).hexdigest()


def reserved_hashes(record):
    hashes = record['fileSha256s']
    if (not re.fullmatch(r'[0-9a-f]{64}',record['manifestSha256'])
            or not isinstance(hashes,list) or not hashes or len(hashes)!=len(set(hashes))
            or any(not isinstance(value,str) or not re.fullmatch(r'[0-9a-f]{64}',value) for value in hashes)):
        raise ValueError('Malformed reserved diagnostic binding')
    return set(hashes)


def reserve_manifest(path, expected_sha):
    content = path.read_bytes()
    if sha(content)!=expected_sha:raise ValueError('Reserved diagnostic manifest drift')
    data = json.loads(content)
    if data.get('complete') is not True or data.get('reservedFromFutureTraining') is not True:
        raise ValueError('Complete reserved diagnostic manifest required')
    record = {'manifestSha256':expected_sha,'fileSha256s':sorted(row['sha256'] for row in data['inputs'])}
    reserved_hashes(record)
    indexes = [index for battle in data['battles'] for index in battle['povIndexes']]
    if (data['povs']!=len(data['inputs']) or sorted(indexes)!=list(range(data['povs']))
            or any(len(battle['povIndexes'])!=2 for battle in data['battles'])):
        raise ValueError('Whole reserved battles required')
    return record


def family_map(catalog, panel, normalize):
    if sha(catalog)!=panel["poolManifestSha256"]:raise ValueError("Pool manifest drift")
    mapping = defaultdict(set)
    for family in json.loads(catalog)["families"]:
        roster = tuple(sorted(normalize(s) for s in family["key"].split("|")))
        if len(roster)!=6 or len(set(roster))!=6:raise ValueError("Ambiguous catalog roster")
        mapping[roster].add(family["sha256"])
    allowed = {r["family"] for r in panel["collection"]}
    forbidden = {r["family"] for r in panel["progress"]}|set(panel["excludedCertificationFamilies"])
    if allowed&forbidden:raise ValueError("Panel overlap")
    return mapping,allowed


def roster_family(state, mapping, allowed):
    roster = tuple(sorted(m["base_species"] for m in
        [state["player_active_pokemon"],*state["available_switches"]]))
    if len(roster)!=6 or len(set(roster))!=6:return None,"incomplete_own_roster"
    candidates = mapping.get(roster,set())
    if len(candidates)!=1:return None,"unknown_or_ambiguous_family"
    family = next(iter(candidates))
    return (family,None) if family in allowed else (None,"reserved_family")


def replay_score(replay):
    terminal = replay["states"][-1]
    if "schema" in replay:
        from metamon.interface import replay_outcome
        return replay_outcome(replay)[1]
    won, lost = terminal["battle_won"], terminal["battle_lost"]
    return float(won) if type(won) is bool and type(lost) is bool and won != lost else None


def validate_training_data(manifest_path,panel_path,directories):
    """Production preflight: complete filter, approved families, exact payload bytes."""
    content = manifest_path.read_bytes();manifest = json.loads(content)
    panel_bytes = panel_path.read_bytes();panel = json.loads(panel_bytes)
    if manifest.get("complete") is not True or manifest.get("qualificationOnly") is not False:
        raise ValueError("Complete non-qualification data manifest required")
    if manifest["panelSha256"]!=sha(panel_bytes):raise ValueError("Training panel drift")
    if sha((manifest_path.parent/"producer.py").read_bytes())!=manifest["producerSha256"]:
        raise ValueError("Retained data producer mismatch")
    allowed = {r["family"] for r in panel["collection"]}
    forbidden = {r["family"] for r in panel["progress"]}|set(panel["excludedCertificationFamilies"])
    if allowed&forbidden:raise ValueError("Training panel overlap")
    known = {(manifest_path.parent/f"pile-{i}/UUKakuna/metamon").resolve():i for i in range(len(manifest["sources"]))}
    selected = {Path(p).resolve() for p in directories}
    if not selected or not selected<=known.keys():raise ValueError("Training directory outside filtered manifest")
    if manifest["trajectories"]!=len(manifest["kept"]):raise ValueError("Training manifest count mismatch")
    reserved = reserved_hashes(manifest['reservedDiagnostics']) if 'reservedDiagnostics' in manifest else set()
    verified,seen = Counter(),set()
    for row in manifest["kept"]:
        if row['sha256'] in reserved:raise ValueError('Reserved diagnostic trajectory entered training')
        if row["family"] not in allowed or row["opponent_family"] not in allowed:
            raise ValueError("Reserved or unknown training family")
        directory = (manifest_path.parent/f"pile-{row['sourcePile']}/UUKakuna/metamon").resolve()
        if directory not in selected:continue
        if Path(row["file"]).name!=row["file"]:raise ValueError("Unsafe training filename")
        path = directory/"gen9uu"/row["file"]
        if path in seen or sha(path.read_bytes())!=row["sha256"]:raise ValueError("Training payload duplicate/hash mismatch")
        seen.add(path);verified[str(directory)] += 1
    if any(not verified[str(d)] for d in selected):raise ValueError("Empty selected training stratum")
    return {"manifestSha256":sha(content),"panelSha256":sha(panel_bytes),"verifiedPOVs":dict(verified)}


def install_manifest_allowlist(manifest_path, directories):
    """Index only manifested files; directory scans and cached indexes cannot add data."""
    from metamon.data.parsed_replay_dset import MetamonDataset
    manifest_path = Path(manifest_path).resolve()
    content = manifest_path.read_bytes();manifest = json.loads(content)
    selected = {Path(p).resolve() for p in directories}
    if not selected:raise ValueError("Manifest loader needs selected directories")
    approved = {root:[] for root in selected}
    for row in manifest["kept"]:
        root = (manifest_path.parent/f"pile-{row['sourcePile']}/UUKakuna/metamon").resolve()
        if root not in selected:continue
        if Path(row["file"]).name != row["file"]:raise ValueError("Unsafe manifest filename")
        approved[root].append(str(root/"gen9uu"/row["file"]))
    if any(not rows or len(rows)!=len(set(rows)) for rows in approved.values()):
        raise ValueError("Empty or duplicate manifested loader files")

    def refresh(dataset):
        root = Path(dataset.dset_root).resolve()
        if root not in approved:raise ValueError("Loader directory is outside the manifest")
        filters = (dataset.min_rating,dataset.max_rating,dataset.min_date,dataset.max_date,dataset.split)
        if any(value is not None for value in filters) or dataset.wins_losses_both != "both":
            raise ValueError("Manifest loader cannot silently re-filter its approved files")
        if dataset.formats != ["gen9uu"]:raise ValueError("Manifest loader requires the declared UU format")
        dataset.filenames = sorted(approved[root])
        if dataset.shuffle:random.shuffle(dataset.filenames)

    MetamonDataset.refresh_files = refresh
    return {"manifestSha256":sha(content),"resolvedFiles":{str(root):len(rows) for root,rows in approved.items()},
            "cachedDirectoryIndexUsed":False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--piles",nargs="+",required=True,type=Path)
    p.add_argument("--panel",required=True,type=Path)
    p.add_argument("--pool-manifest",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--probe",type=int,default=0,help="first N games only; never writes training files")
    p.add_argument("--reserved-manifest",type=Path)
    p.add_argument("--reserved-manifest-sha256")
    a = p.parse_args()
    if a.probe<0:raise ValueError("Nonnegative probe count required")
    if bool(a.reserved_manifest)!=bool(a.reserved_manifest_sha256):raise ValueError('Reserved manifest and SHA required together')
    reservation = reserve_manifest(a.reserved_manifest,a.reserved_manifest_sha256) if a.reserved_manifest else None
    reserved = reserved_hashes(reservation) if reservation else set()
    out = a.out.resolve();out.mkdir(parents=True,exist_ok=False)
    source = Path(__file__).read_bytes();(out/"producer.py").write_bytes(source)
    panel_bytes = a.panel.read_bytes();panel = json.loads(panel_bytes)
    if panel["schema"]!="uu-progress-panel@1" or panel["certification"] is not False:
        raise ValueError("Progress/collection panel required")
    from poke_env.environment.pokemon import Pokemon
    from metamon.backend.replay_parser.str_parsing import pokemon_name
    normalize = lambda species:pokemon_name(Pokemon(gen=9,species=species).base_species)
    mapping,allowed = family_map(a.pool_manifest.read_bytes(),panel,normalize)
    groups,sources = defaultdict(list),[]
    for index,pile in enumerate(a.piles):
        content = (pile/"manifest.json").read_bytes();manifest = json.loads(content)
        if manifest["trajectories"]!=len(manifest["kept"]):raise ValueError("Frozen manifest count drift")
        sources.append({"pile":str(pile.resolve()),"manifestSha256":sha(content)})
        for row in manifest["kept"]:
            if Path(row["file"]).name!=row["file"]:raise ValueError("Unsafe frozen filename")
            groups[(row["block"],row["battle_tag"])].append((index,row))
    excluded,kept,per_pile = [],[],defaultdict(list)
    counts = Counter();started = time.monotonic();processed = 0;read_bytes = 0
    def status(phase,**extra):
        data = {"phase":phase,"qualificationOnly":bool(a.probe),"gamesScanned":processed,
            "totalGames":len(groups),"keptPOVs":len(kept),"excludedGames":dict(counts),
            "wallSeconds":time.monotonic()-started,"compressedBytesRead":read_bytes,**extra}
        (out/"status.tmp").write_text(json.dumps(data,indent=2));(out/"status.tmp").replace(out/"status.json")
    try:
        for identity,rows in sorted(groups.items()):
            if a.probe and processed>=a.probe:break
            processed += 1
            reason = None;families = []
            if any(row['sha256'] in reserved for _,row in rows):
                reason = 'reserved_diagnostic_battle'
            elif len(rows)!=2 or len({r["player"].casefold() for _,r in rows})!=2:
                reason = "unpaired_or_duplicate_pov"
            else:
                outcomes = []
                for index,row in rows:
                    path = a.piles[index]/"UUKakuna/metamon/gen9uu"/row["file"]
                    content = path.read_bytes();read_bytes += len(content)
                    if sha(content)!=row["sha256"]:raise ValueError(f"Frozen trajectory hash mismatch: {path.name}")
                    replay = json.loads(lz4.frame.decompress(content))
                    family,problem = roster_family(replay["states"][0],mapping,allowed)
                    if problem:reason = problem
                    families.append(family)
                    score = replay_score(replay)
                    if replay.get("schema") == "uu-native-replay@2":
                        meta = json.loads(Path(str(path)+".meta").read_bytes())
                        if (meta.get("schema") != replay["schema"] or meta.get("finished") is not True
                                or meta.get("result") != replay["outcome"] or meta.get("terminal_score") != score):
                            raise ValueError("Native outcome sidecar disagrees with payload")
                    outcomes.append(score)
                if any(score is None for score in outcomes) or sum(outcomes)!=1.0:
                    reason = "terminal_outcome_mismatch"
            if reason:
                counts[reason] += 1
                excluded.append({"block":identity[0],"battle_tag":identity[1],"reason":reason,
                                 "files":[r["file"] for _,r in rows]})
            else:
                for side,(index,row) in enumerate(rows):
                    entry = {**row,"family":families[side],"opponent_family":families[1-side],
                             "sourcePile":index,"terminal_score":outcomes[side]}
                    kept.append(entry);per_pile[index].append(entry)
                    if not a.probe:
                        dest = out/f"pile-{index}/UUKakuna/metamon/gen9uu";dest.mkdir(parents=True,exist_ok=True)
                        source_dir = a.piles[index]/"UUKakuna/metamon/gen9uu"
                        for name in (row["file"],row["file"]+".meta"):
                            try:os.link(source_dir/name,dest/name)
                            except OSError:shutil.copy2(source_dir/name,dest/name)
            if processed%1000==0:status("FILTERING")
        if not a.probe:
            for index,rows in per_pile.items():
                (out/f"pile-{index}/manifest.json").write_text(json.dumps({"trajectories":len(rows),
                    "battles":len({(r["block"],r["battle_tag"]) for r in rows}),"kept":rows,
                    "source":sources[index],"panelSha256":sha(panel_bytes),"complete":True},indent=1))
        report = {"complete":not a.probe,"qualificationOnly":bool(a.probe),"sources":sources,
            "panelSha256":sha(panel_bytes),"producerSha256":sha(source),"trajectories":len(kept),
            "battles":len(kept)//2,"kept":kept,"excluded":dict(counts),"excluded_files":excluded}
        if reservation:report['reservedDiagnostics'] = reservation
        (out/"manifest.json").write_text(json.dumps(report,indent=1))
        status("PROBE_COMPLETE" if a.probe else "FILTER_COMPLETE")
    except BaseException as e:
        status("FAILED",error=f"{type(e).__name__}: {e}");raise


if __name__=="__main__":main()
