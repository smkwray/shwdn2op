"""Event-balanced curriculum piles and the mechanical diagnostic screen (no new labels,
no reward change, no pick overrides). Generic: every rule reads types, move flags and ability behaviour from
curriculum_mechanics.mts output (Showdown data + the companion's ability-immunity table); no species or move lists.

  curriculum.py scan MECH.json SOURCE=DIR [SOURCE=DIR ...] --out SCAN.jsonl [--procs N]
  curriculum.py freeze MECH.json SCAN.jsonl --sources-root SOURCE=DIR ... --eval-families FAM.json --out PILE
                [--per-category 600] [--family-cap 0.02] [--seed 20261024] [--exclude-battle ID ...]
  curriculum.py screen SCAN.jsonl U_PROBS.jsonl C_PROBS.jsonl [--boot 2000] [--seed 20261024]

A trajectory is Metamon's parsed replay: states[t] is the observation, actions[t] the action taken there (-1 = an
unrevealed human choice). Action ids: 0-3 the active's moves in alphabetical id order, 4-8 switches, 9-12 the moves
with Tera (metamon.interface). A move "executed" when its PP fell between t and t+1 (same active mon).

Event categories (per decision t, not forced to switch; the episode qualifies if any occurs):
  absorb      the opponent's revealed ability is type-immune (immunityAbilities) and our active has a damaging move of that
              type (not type-changing, no ability-ignoring move or ability)                    sub: absorb_into = chose it
  ko_first    we chose a move (or a hidden human choice) and the same mon is at 0 HP at t+1 without having used it
                                                                   sub: ko_first_priority = the opponent's move had priority
  drop_ko     we executed a self-stat-drop or recoil move and that mon is at 0 HP at t+1, or at t+2 while still in
  def_tera    Tera available; an opponent's revealed damaging move is >=2x on our current types and <=0.5x on our Tera type
                                                                                         sub: def_tera_used = chose a Tera action
  heal_loop   one mon (ours: heal_loop_own; theirs: heal_loop_opp) executed direct self-heals >=3 times within 6 decisions
Freeze: per source, eligible episodes (no reviewed battle, no dev/held-out family on either side) are drawn round-robin
into one stratum per category (--per-category each), alternating the category's two continuations (SPLIT: into/avoided,
priority/not, won/lost, Tera used/not, own/opponent loop); at most one POV per battle and --family-cap of the source's
target per own-roster family. Files are hardlinked into PILE/SOURCE/gen9uu with a per-file SHA256 manifest.
Diagnostic labels (screen; mechanically checkable, scored only where some legal action is outside the set):
  noeffect    actions whose damaging move cannot affect the current target: its type is blocked by the target's revealed
              immunity ability (as absorb) or by the target's types (type chart 0x; no immunity-ignoring move/ability)
  ctl_heal    winner POV, revealed direct self-heal executed at <=50% HP, the mon alive at t+1 (positive control)
  ctl_sack    winner POV, a damaging move executed with a switch legal, the mon at 0 HP at t+1 and the target lost HP or
              fainted (positive control: a trade the winner chose)
Probabilities are legal-normalised under the training mask (maybe_valid_actions).
"""
import argparse, collections, hashlib, json, os, pathlib, random, re, sys

CATS = ("absorb", "ko_first", "drop_ko", "def_tera", "heal_loop")
SPLIT = {"absorb": lambda r: bool(r["events"].get("absorb_into")), "ko_first": lambda r: bool(r["events"].get("ko_first_priority")),
         "drop_ko": lambda r: r["won"], "def_tera": lambda r: bool(r["events"].get("def_tera_used")),
         "heal_loop": lambda r: bool(r["events"].get("heal_loop_own"))}
cid = lambda s: re.sub(r"[^a-z0-9]", "", str(s).lower())


def load(path):
    import lz4.frame
    with lz4.frame.open(path) as f:
        return json.loads(f.read())


def sorted_moves(mon):
    return sorted(mon["moves"], key=lambda m: cid(m["name"]))


def legal(s):  # metamon UniversalAction.maybe_valid_actions
    out = [] if s["forced_switch"] else list(range(len(s["player_active_pokemon"]["moves"])))
    if not s["forced_switch"] and s["can_tera"]:
        out += [9 + i for i in range(len(s["player_active_pokemon"]["moves"]))]
    return out + [4 + i for i in range(len(s["available_switches"]))]


def chosen_move(s, a):
    if a is None or a < 0 or 4 <= a <= 8 or s["forced_switch"]:
        return None
    moves = sorted_moves(s["player_active_pokemon"])
    i = a - 9 if a >= 9 else a
    return moves[i] if i < len(moves) else None


def pp(mon, name):
    return next((m["current_pp"] for m in mon["moves"] if m["name"] == name), None)


def executed(m0, m1, name):  # the same mon, and the move's PP fell
    if m0["name"] != m1["name"]:
        return False
    a, b = pp(m0, name), pp(m1, name)
    return a is not None and b is not None and b < a


class Mech:
    def __init__(self, path):
        m = json.loads(pathlib.Path(path).read_text())
        self.chart, self.moves, self.abil, self.immune = m["typeChart"], m["moves"], m["abilities"], m["immunityAbilities"]

    def move(self, name):
        return self.moves.get(cid(name), {})

    def eff(self, atk, types):
        out = 1.0
        for t in types:
            if t in self.chart.get(atk, {}):
                out *= self.chart[atk][t]
        return out

    def damaging(self, mv):
        return mv.get("category", "status") != "status" and not mv.get("changesType")

    def noeffect_actions(self, s):
        """Action ids whose damaging move cannot affect the opponent's active (empty when forced)."""
        if s["forced_switch"]:
            return []
        me, opp = s["player_active_pokemon"], s["opponent_active_pokemon"]
        ab = self.abil.get(cid(me["ability"]), {})
        if ab.get("changesMoveType"):
            return []
        blocked_type = None if ab.get("ignoresAbilities") else self.immune.get(cid(opp["ability"]))
        opp_types = [t for t in opp["types"].split() if t in self.chart]
        out = []
        for i, m in enumerate(sorted_moves(me)):
            mv = self.move(m["name"])
            if not mv or not self.damaging(mv):
                continue
            by_ability = blocked_type == mv["type"] and not mv.get("ignoreAbility")
            by_type = (not mv.get("ignoreImmunity") and not ab.get("ignoresImmunity") and opp_types
                       and self.eff(mv["type"], opp_types) == 0)
            if by_ability or by_type:
                out.append(i)
        return out + ([9 + i for i in out] if s["can_tera"] else [])


def scan_file(mech, source, path):
    d = load(path)
    S, A = d["states"], d["actions"]
    ev = collections.Counter()
    labels = []
    name = pathlib.Path(path).name
    won = name.endswith("_WIN.json.lz4")
    heals = {"own": collections.defaultdict(list), "opp": collections.defaultdict(list)}
    for t, s in enumerate(S[:-1]):
        a, s1 = A[t], S[t + 1]
        me, opp, me1, opp1 = s["player_active_pokemon"], s["opponent_active_pokemon"], s1["player_active_pokemon"], s1["opponent_active_pokemon"]
        lg = legal(s)
        m = chosen_move(s, a)
        mv = mech.move(m["name"]) if m else {}
        if not s["forced_switch"]:
            # absorb
            blocked = mech.immune.get(cid(opp["ability"]))
            ab = mech.abil.get(cid(me["ability"]), {})
            if blocked and not ab.get("ignoresAbilities") and not ab.get("changesMoveType"):
                hits = [x for x in sorted_moves(me) if mech.damaging(mech.move(x["name"])) and mech.move(x["name"])["type"] == blocked
                        and not mech.move(x["name"]).get("ignoreAbility")]
                if hits:
                    ev["absorb"] += 1
                    if m and m in hits:
                        ev["absorb_into"] += 1
            # ko_first
            if (m is not None or a == -1) and me1["name"] == me["name"] and me1["hp_pct"] == 0 and not (m and executed(me, me1, m["name"])):
                ev["ko_first"] += 1
                if (s1.get("opponent_prev_move") or {}).get("priority", 0) > 0:
                    ev["ko_first_priority"] += 1
            # drop_ko
            if m and (mv.get("selfDrop") or mv.get("recoil")) and executed(me, me1, m["name"]):
                later = me1["hp_pct"] == 0 or (t + 2 < len(S) and not s1["forced_switch"] and S[t + 2]["player_active_pokemon"]["name"] == me["name"]
                                               and S[t + 2]["player_active_pokemon"]["hp_pct"] == 0)
                if later:
                    ev["drop_ko"] += 1
            # def_tera
            tera = cid(me.get("tera_type"))
            if s["can_tera"] and tera in mech.chart:
                mine = [x for x in me["types"].split() if x in mech.chart]
                for x in opp["moves"]:
                    ov = mech.move(x["name"])
                    if ov and mech.damaging(ov) and mech.eff(ov["type"], mine) >= 2 and mech.eff(ov["type"], [tera]) <= 0.5:
                        ev["def_tera"] += 1
                        if a is not None and a >= 9:
                            ev["def_tera_used"] += 1
                        break
            # diagnostic labels
            bad = mech.noeffect_actions(s)
            if bad and any(x not in bad for x in lg):
                labels.append({"t": t, "kind": "noeffect", "actions": bad, "chosen_bad": a in bad})
            if won and m and mv.get("directHeal") and me["hp_pct"] <= 0.5 and executed(me, me1, m["name"]) and me1["hp_pct"] > 0:
                labels.append({"t": t, "kind": "ctl_heal", "actions": [a]})
            if (won and m and mech.damaging(mv) and executed(me, me1, m["name"]) and me1["hp_pct"] == 0 and any(4 <= x <= 8 for x in lg)
                    and (s1["opponents_remaining"] < s["opponents_remaining"] or (opp1["name"] == opp["name"] and opp1["hp_pct"] < opp["hp_pct"]))):
                labels.append({"t": t, "kind": "ctl_sack", "actions": [a]})
        # heal loops (both sides), executed direct self-heals of one mon
        if m and mv.get("directHeal") and executed(me, me1, m["name"]):
            heals["own"][me["name"]].append(t)
        om = s1.get("opponent_prev_move") or {}
        if om.get("name") and mech.move(om["name"]).get("directHeal") and executed(opp, opp1, om["name"]):
            heals["opp"][opp["name"]].append(t)
    for side, mons in heals.items():
        if any(ts[i + 2] - ts[i] < 6 for ts in mons.values() for i in range(len(ts) - 2)):
            ev["heal_loop"] += 1
            ev[f"heal_loop_{side}"] += 1
    s0 = S[0]
    fam = lambda names: "|".join(sorted(cid(n) for n in names))
    meta = pathlib.Path(str(path) + ".meta")
    tag = json.loads(meta.read_text())["battle_tag"] if meta.exists() else re.search(r"gen9uu-(\d+)", name).group(0)
    block = name.split("--")[0] + ":" if "--" in name else ""
    return {"source": source, "file": name, "battle": block + tag, "won": won, "states": len(S),
            "own_family": fam([s0["player_active_pokemon"]["name"], *[m["name"] for m in s0["available_switches"]]]),
            "opp_family": fam(s0["opponent_teampreview"]), "events": dict(ev), "labels": labels}


def _work(args):
    mech_path, source, path = args
    global _MECH
    if "_MECH" not in globals():
        _MECH = Mech(mech_path)
    try:
        return scan_file(_MECH, source, path)
    except Exception as e:  # counted and reported, never dropped silently
        return {"source": source, "file": pathlib.Path(path).name, "error": f"{type(e).__name__}: {e}"[:300]}


def files_of(d):
    return sorted(pathlib.Path(d, "gen9uu").glob("*.json.lz4"))


def scan(a):
    import multiprocessing as mp
    jobs = [(a.mech, src, str(f)) for src, d in (x.split("=", 1) for x in a.sources) for f in files_of(d)]
    counts = collections.Counter()
    with open(a.out, "x") as out, mp.Pool(a.procs) as pool:
        for row in pool.imap(_work, jobs, chunksize=64):
            out.write(json.dumps(row) + "\n")
            counts[(row["source"], "error" if "error" in row else "ok")] += 1
    print(json.dumps({f"{s}:{k}": v for (s, k), v in sorted(counts.items())}))
    if any(k == "error" for _, k in counts):
        sys.exit(1)


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def freeze(a):
    out = pathlib.Path(a.out)
    if out.exists():
        raise SystemExit(f"refusing to overwrite {out}")
    roots = dict(x.split("=", 1) for x in a.sources_root)
    ev_fams = json.loads(pathlib.Path(a.eval_families).read_text())
    exact, base = set(ev_fams["exact"]), set(ev_fams["base"])
    to_base = ev_fams["to_base"]
    bfam = lambda f: "|".join(sorted(to_base.get(i, i) for i in f.split("|")))
    rows = [json.loads(l) for l in open(a.scan)]
    errors = [r for r in rows if "error" in r]
    if errors:
        raise SystemExit(f"scan has {len(errors)} errors")
    exclude = set(a.exclude_battle)
    rng = random.Random(a.seed)
    manifest = {"producer": "scripts/uu_selfplay/curriculum.py", "producer_sha256": sha256(__file__), "seed": a.seed,
                "scan": str(a.scan), "scan_sha256": sha256(a.scan), "mechanics_sha256": sha256(a.mech),
                "per_category": a.per_category, "family_cap": a.family_cap, "exclude_battles": sorted(exclude),
                "sources": {}, "kept": []}
    for source in sorted({r["source"] for r in rows}):
        src = [r for r in rows if r["source"] == source]
        reasons = collections.Counter()
        ok = []
        for r in src:
            hit = next((x for x in exclude if x in r["battle"] or x in r["file"]), None)
            fams = (r["own_family"], r["opp_family"])
            if hit:
                reasons["reviewed_game"] += 1
            elif any(f in exact for f in fams) or any(bfam(f) in base for f in fams):
                reasons["eval_family"] += 1
            else:
                ok.append(r)
        pools = {}
        for c in CATS:  # alternate the two continuations of each situation (harmful and useful), each shuffled
            yes = [r for r in ok if r["events"].get(c) and SPLIT[c](r)]
            no = [r for r in ok if r["events"].get(c) and not SPLIT[c](r)]
            rng.shuffle(yes); rng.shuffle(no)
            pools[c] = [r for pair in zip(yes, no) for r in pair] + yes[len(no):] + no[len(yes):]
        cap = max(1, int(a.family_cap * a.per_category * len(CATS)))
        taken, battles, fam_n, strata = set(), set(), collections.Counter(), collections.defaultdict(list)
        idx = {c: 0 for c in CATS}
        skipped = collections.Counter()
        while True:
            progressed = False
            for c in CATS:
                if len(strata[c]) >= a.per_category:
                    continue
                while idx[c] < len(pools[c]):
                    r = pools[c][idx[c]]; idx[c] += 1
                    if r["file"] in taken:
                        continue
                    if r["battle"] in battles:
                        skipped["battle_cap"] += 1; continue
                    if fam_n[r["own_family"]] >= cap:
                        skipped["family_cap"] += 1; continue
                    taken.add(r["file"]); battles.add(r["battle"]); fam_n[r["own_family"]] += 1
                    strata[c].append(r); progressed = True
                    break
            if not progressed:
                break
        dest = out / source / "gen9uu"
        dest.mkdir(parents=True)
        for c in CATS:
            for r in strata[c]:
                srcf = pathlib.Path(roots[source], "gen9uu", r["file"])
                dst = dest / r["file"]
                try:
                    os.link(srcf, dst)
                except OSError:
                    import shutil; shutil.copy2(srcf, dst)
                manifest["kept"].append({"source": source, "stratum": c, "file": r["file"], "sha256": sha256(dst),
                                         "battle": r["battle"], "own_family": r["own_family"], "won": r["won"],
                                         "events": r["events"]})
        kept = [k for k in manifest["kept"] if k["source"] == source]
        manifest["sources"][source] = {
            "scanned": len(src), "excluded": dict(reasons), "eligible": len(ok),
            "eligible_with_event": {c: len(pools[c]) for c in CATS},
            "eligible_any_event": sum(any(r["events"].get(c) for c in CATS) for r in ok),
            "strata": {c: len(strata[c]) for c in CATS}, "kept": len(kept),
            "kept_files_with_event": {c: sum(bool(k["events"].get(c)) for k in kept) for c in CATS},
            "subevents_in_kept": dict(sum((collections.Counter({e: 1 for e in k["events"]}) for k in kept), collections.Counter())),
            "families": len({k["own_family"] for k in kept}), "max_per_family": max(fam_n.values()) if fam_n else 0,
            "family_cap": cap, "skipped": dict(skipped), "won": sum(k["won"] for k in kept)}
        print(source, json.dumps(manifest["sources"][source]), flush=True)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))


def screen(a):
    """Primary: relative reduction of mean noeffect mass, C vs U. Control: mean recorded-action probability on ctl_*."""
    rows = {r["file"]: r for r in map(json.loads, open(a.scan)) if "error" not in r}
    probs, chosen = [], {}
    for path in (a.u, a.c):
        p = {}
        for l in open(path):
            r = json.loads(l)
            p[r["file"]] = r["probs"]
            chosen[r["file"]] = r["chosen"]
        probs.append(p)
    missing = [f for f in rows if f not in probs[0] or f not in probs[1]]
    if missing:
        raise SystemExit(f"{len(missing)} scanned files lack probabilities, e.g. {missing[:3]}")
    # Alignment: the scorer's recorded action at t must be the scan's (ctl_* label it; noeffect records whether it was bad).
    off = sum(1 for f, r in rows.items() for lab in r["labels"] if chosen[f][lab["t"]] >= 0 and
              ((chosen[f][lab["t"]] in lab["actions"]) != lab["chosen_bad"] if lab["kind"] == "noeffect" else chosen[f][lab["t"]] != lab["actions"][0]))
    if off:
        raise SystemExit(f"{off} labelled states disagree with the scorer's recorded action: misaligned inputs")
    per = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0, 0.0, 0]))  # kind -> battle -> [U, C, n]
    for f, r in rows.items():
        for lab in r["labels"]:
            for k, P in enumerate(probs):
                q = P[f][lab["t"]]
                per[lab["kind"]][r["battle"]][k] += sum(q[i] for i in lab["actions"])
            per[lab["kind"]][r["battle"]][2] += 1
    rng = random.Random(a.seed)
    out = {}
    def stats(kinds, fn):
        cl = collections.defaultdict(lambda: [0.0, 0.0, 0])
        for kind in kinds:
            for b, v in per[kind].items():
                for i in range(3):
                    cl[b][i] += v[i]
        keys = list(cl)
        if not keys:
            return {"battles": 0}
        point = fn([cl[b] for b in keys])
        boots = sorted(fn([cl[rng.choice(keys)] for _ in keys]) for _ in range(a.boot))
        return {"battles": len(keys), "states": sum(cl[b][2] for b in keys),
                "mean_U": sum(cl[b][0] for b in keys) / sum(cl[b][2] for b in keys),
                "mean_C": sum(cl[b][1] for b in keys) / sum(cl[b][2] for b in keys), "point": point,
                "lo95": boots[int(0.025 * a.boot)], "hi95": boots[int(0.975 * a.boot) - 1], "hi95_one_sided": boots[int(0.95 * a.boot) - 1]}
    rel = lambda v: 1 - sum(x[1] for x in v) / sum(x[0] for x in v) if sum(x[0] for x in v) else float("nan")
    drop = lambda v: (sum(x[0] for x in v) - sum(x[1] for x in v)) / sum(x[2] for x in v)
    out["primary_noeffect_relative_reduction"] = stats(["noeffect"], rel)
    out["control_heal_and_sack_drop_U_minus_C"] = stats(["ctl_heal", "ctl_sack"], drop)
    out["control_heal_drop"] = stats(["ctl_heal"], drop)
    out["control_sack_drop"] = stats(["ctl_sack"], drop)
    p, c = out["primary_noeffect_relative_reduction"], out["control_heal_and_sack_drop_U_minus_C"]
    out["pass_primary"] = p.get("battles", 0) >= 100 and p["point"] >= 0.25 and p["lo95"] > 0
    out["pass_control"] = c.get("battles", 0) > 0 and c["hi95_one_sided"] <= 0.05
    out["pass"] = out["pass_primary"] and out["pass_control"]
    print(json.dumps(out, indent=1))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan"); s.add_argument("mech"); s.add_argument("sources", nargs="+"); s.add_argument("--out", required=True)
    s.add_argument("--procs", type=int, default=4)
    f = sub.add_parser("freeze"); f.add_argument("mech"); f.add_argument("scan"); f.add_argument("--sources-root", nargs="+", required=True)
    f.add_argument("--eval-families", required=True); f.add_argument("--out", required=True)
    f.add_argument("--per-category", type=int, default=600); f.add_argument("--family-cap", type=float, default=0.02)
    f.add_argument("--seed", type=int, default=20261024); f.add_argument("--exclude-battle", nargs="*", default=[])
    c = sub.add_parser("screen"); c.add_argument("scan"); c.add_argument("u"); c.add_argument("c")
    c.add_argument("--boot", type=int, default=2000); c.add_argument("--seed", type=int, default=20261024)
    a = p.parse_args()
    {"scan": scan, "freeze": freeze, "screen": screen}[a.cmd](a)


if __name__ == "__main__":
    main()
