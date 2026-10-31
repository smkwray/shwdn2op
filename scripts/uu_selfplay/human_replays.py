"""Gen 9 UU human demonstrations for Metamon fine-tuning: public Showdown replays -> Metamon's own
replay parser -> trajectories in the parsed-replay layout (<OUT>/gen9uu/*.json.lz4), plus a
reconstruction audit against self-play ground truth and a leakage-safe split.

Subcommands (stdlib only, except `audit` (lz4) and `teams` (the run's metamon source)):
  index  --out DIR [--days 240] [--max-pages 600]
         Page replay.pokemonshowdown.com/search.json?format=gen9uu (1 request/s). Writes DIR/index.jsonl
         (id, uploadtime, replay rating, private flag; no usernames) and DIR/supply.json (per month x rating).
  fetch  --index DIR --raw RAW --salt-file F [--min-rating 1300] [--since YYYY-MM-DD] [--limit N (default: all)] [--smogtours]
         Download selected replays (1 request/s, cached), drop chat/join/leave/raw lines, replace both
         usernames by HMAC pseudonyms (salt kept device-local), write RAW/gen9uu/<YYYY-MM>/<id>.json in
         Metamon's raw-replay schema, append RAW/manifest.jsonl (seat ratings, pseudonyms, preview species,
         source SHA256). No username is written anywhere. --smogtours also admits unrated Smogon tournament
         replays (smogtours-gen9uu-*), which the rating floor would otherwise drop.
  local  --logs FILE... --raw RAW --salt-file F [--exclude-player-prefix P ...]
         Locally saved battles (the extension's battle-room .log files: ">battle-<id>" header, protocol lines,
         plus the recording player's |request|; downloaded replay .html files holding the full log) -> the same
         raw schema, pseudonyms and manifest as fetch (+ "source": "local", "recorder_seats": seats whose player
         recorded any input log). Keeps completed (|win|/|tie|) Gen 9 UU singles with at least one turn; drops
         the player-only |request|/|sso-state| lines; skips players named with an excluded prefix (test
         accounts), ids already in RAW/manifest.jsonl, and same-battle copies (a replay .html, which has no
         private lines, beats a .log, which beats a Syncthing sync-conflict copy). Prints counts per reason,
         never names.
  selfplay --run RUN --raw RAW [--limit N] [--seed 0]
         Convert local Showdown battle logs of validated self-play blocks (RUN/ps/.../logs) to the same raw
         schema (id gen9uu-<block>-<n>), so the parser's spectator reconstruction can be compared with the
         player-POV trajectories the env recorded for the same battle (ground truth).
  audit  --parsed PARSED --run RUN --out REPORT.json
         Per POV: state-count alignment, action exactness on revealed actions, missing-action rate, and
         own-team / opponent-active field exactness against the env trajectory.
  split  --parsed PARSED --manifest RAW/manifest.jsonl --team-pool POOL/manifest.json --out SPLITDIR
         [--holdout-days 14] [--val-frac 0.1] [--usage-stats CACHE/usage-stats]
         Drop battles whose source replay or either six-species family belongs to the eval team pool's dev or
         held-out split; then test = battles in the last --holdout-days; val = POV players in a hashed
         --val-frac bucket (player-disjoint); train = the rest, minus POVs whose opponent is a val player (so no
         battle is seen from one side in train and the other in val). Hardlinks
         SPLITDIR/{train,val,test}/gen9uu/ and writes SPLITDIR/split.json, whose summary.provenance marks which
         observation fields are observed and which are inferred (hidden own-team fields: Metamon usage-stats guesses).
  privacy --raw RAW [--parsed PARSED ...] [--max-pages 800] [--vocab TOKENIZER_JSON] [--local FILE...]
         Privacy gate: take the real names of `local` battles from their source logs (--local), re-page the
         public search index (which lists player names) for the rest, back to the oldest fetched replay, hold
         the real names in memory only, and count any occurrence of a battle's names in its raw
         file, parsed trajectory filenames and contents. With --vocab, a hit whose containing text is a Metamon
         game token (species, move, item...; unnicknamed slot refs show the species) counts as game_vocab, not a
         leak. Prints counts, never names.
  teams  --split SPLITDIR --revealed REVEALED --out TEAMSET --showdown PSDIR --tokenizer JSON [--seed 0]
         Stress team stratum: complete the revealed rosters of train-split POVs with Metamon's NaiveUsagePredictor
         (independent samples from usage stats, so sets are more varied than uu_train_v1's modal completions), audit
         with audit_teams.cjs under pinned Showdown 0.11.11, keep only legal teams: TEAMSET/gen9uu/*.gen9uu_team,
         index.csv, manifest.json. Needs the run source (metamon) and METAMON_CACHE_DIR with usage stats.

Parse between fetch and audit/split with Metamon's unmodified CLI from the patched run source (add
--team_output_dir REVEALED to keep the revealed partial teams for `teams`):
  python -m metamon.backend.replay_parser --format gen9uu --raw_replay_dir RAW --output_dir PARSED
"""

import argparse
import collections
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import random
import re
import sys
import time
import urllib.request

API = "https://replay.pokemonshowdown.com"
UA = {"User-Agent": "personal-replay-research/0.2 (1 request/s)"}
# Log line types that carry usernames or chat and that the replay parser never needs.
DROP = {"c", "c:", "chat", "j", "J", "join", "l", "L", "leave", "n", "N", "name", "raw", "html", "uhtml",
        "uhtmlchange", "inactive", "inactiveoff", "badge", "chatmsg", "chatmsg-raw", "b", "B",
        "askreg", "request", "sso-state"}  # askreg names a player; request/sso-state: a battle-room log's private side


def to_id(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def get(url):
    err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return r.read()
        except Exception as e:  # network errors are retried, then raised
            err = e
            time.sleep(5 * (attempt + 1))
    raise err


def month(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m")


def cmd_index(a):
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cut = time.time() - a.days * 86400
    before, pages, seen = None, 0, {}
    while pages < a.max_pages:
        page = json.loads(get(f"{API}/search.json?format=gen9uu" + (f"&before={before}" if before else "")))
        pages += 1
        time.sleep(1.0)
        if not page:
            break
        for x in page:
            seen.setdefault(x["id"], {"id": x["id"], "uploadtime": x["uploadtime"], "rating": x.get("rating") or 0,
                                      "private": bool(x.get("private")) or bool(x.get("password"))})
        oldest = min(x["uploadtime"] for x in page)
        if oldest < cut or len(page) < 51:
            break
        before = oldest
    rows = sorted(seen.values(), key=lambda r: -r["uploadtime"])
    (out / "index.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    by = collections.defaultdict(collections.Counter)
    for r in rows:
        m = by[month(r["uploadtime"])]
        m["all"] += 1
        m["smogtours"] += r["id"].startswith("smogtours")
        for t in (1, 1200, 1300, 1400, 1500, 1600):
            m[f">={t}"] += r["rating"] >= t
    supply = {"pages": pages, "replays": len(rows), "window_days": a.days,
              "oldest": rows[-1]["uploadtime"] if rows else None, "newest": rows[0]["uploadtime"] if rows else None,
              "truncated_by_max_pages": pages >= a.max_pages, "by_month": {k: dict(v) for k, v in sorted(by.items())}}
    (out / "supply.json").write_text(json.dumps(supply, indent=1))
    print(json.dumps(supply, indent=1))


def pseudonym(key, name):
    return "u" + hmac.new(key, to_id(name).encode(), hashlib.sha256).hexdigest()[:12]


NAMED = {"player", "win", "tie", "-message", "message"}  # the only kept line types that carry usernames


SIDE = re.compile(r"^((?:\[of\] )?p([12]): )(.+)$")  # side refs "p1: <username>"; Pokémon refs are "p1a: <nick>"
SLOT = re.compile(r"p[12][a-c]: [^|]*")


def nick(ref, names, pseudo):
    for n, p in zip(names, pseudo):
        if len(to_id(n)) >= 3:
            ref = ref[:5] + re.sub(re.escape(n), p, ref[5:], flags=re.I)
    return ref


def sanitize(log, names, pseudo):
    """Drop username/chat lines; replace usernames in |player| and side refs (|-sidestart|p1: NAME|...), in the
    message-like line types that carry them, and inside Pokémon nicknames (slot refs "p1a: <nick>"; rewritten the
    same way everywhere, and the parser keys Pokémon by these refs, so identity is preserved). Species fields are
    never touched. Refuse the replay if a username survives outside slot refs."""
    out = []
    for line in log.split("\n"):
        parts = line.split("|")
        kind = parts[1] if len(parts) > 1 else ""
        if kind in DROP:
            continue
        if kind == "player" and len(parts) > 3:
            parts[3] = pseudo[0 if parts[2] == "p1" else 1] if parts[3] else parts[3]
            if len(parts) > 4:
                parts[4] = ""  # avatar
        for i, x in enumerate(parts[2:], 2):
            m = SIDE.match(x)
            if m and m.group(3).lower() == names[int(m.group(2)) - 1].lower():
                parts[i] = m.group(1) + pseudo[int(m.group(2)) - 1]
        if kind in NAMED:
            for n, p in zip(names, pseudo):
                parts[2:] = [re.sub(re.escape(n), p, x, flags=re.I) for x in parts[2:]]
        line = SLOT.sub(lambda m: nick(m.group(0), names, pseudo), "|".join(parts))
        if any(re.search(re.escape(n), SLOT.sub("", line), flags=re.I) for n in names if len(to_id(n)) >= 3):
            raise ValueError("username survived sanitization")
        out.append(line)
    return "\n".join(out)


def preview(log):
    teams = {"p1": [], "p2": []}
    for line in log.split("\n"):
        p = line.split("|")
        if len(p) > 3 and p[1] == "poke" and p[2] in teams:
            teams[p[2]].append(p[3].split(",")[0])
    return teams["p1"], teams["p2"]


def seat_ratings(log):
    r = {}
    for line in log.split("\n"):
        p = line.split("|")
        if len(p) > 5 and p[1] == "player" and p[3] and p[5].isdigit():
            r[p[2]] = int(p[5])
    return [r.get("p1"), r.get("p2")]


def salt(path):
    salt_file = pathlib.Path(path)
    if not salt_file.exists():
        salt_file.write_text(os.urandom(32).hex())
        salt_file.chmod(0o600)
    return bytes.fromhex(salt_file.read_text().strip())


def cmd_fetch(a):
    key = salt(a.salt_file)
    rows = [json.loads(l) for l in (pathlib.Path(a.index) / "index.jsonl").read_text().splitlines()]
    since = datetime.datetime.fromisoformat(a.since).replace(tzinfo=datetime.timezone.utc).timestamp() if a.since else 0
    rated = lambda r: r["rating"] >= a.min_rating or (a.smogtours and r["id"].startswith("smogtours-"))
    pick = [r for r in rows if not r["private"] and rated(r) and r["uploadtime"] >= since
            and re.fullmatch(r"(smogtours-)?gen9uu-\d+", r["id"])][: a.limit]
    raw = pathlib.Path(a.raw)
    manifest = raw / "manifest.jsonl"
    done = {json.loads(l)["id"] for l in manifest.read_text().splitlines()} if manifest.exists() else set()
    counts = collections.Counter()
    for r in pick:
        if r["id"] in done:
            counts["cached"] += 1
            continue
        try:
            body = get(f"{API}/{r['id']}.json")
            time.sleep(1.0)
            d = json.loads(body)
            names = list(d["players"])
            if d.get("formatid") != "gen9uu" or len(names) != 2 or not d.get("log"):
                counts["skipped_not_gen9uu_singles"] += 1
                continue
            pseudo = [pseudonym(key, n) for n in names]
            log = sanitize(d["log"], names, pseudo)
        except Exception as e:
            counts[f"error:{type(e).__name__}"] += 1
            continue
        t = int(d["uploadtime"])
        dest = raw / "gen9uu" / month(t) / f"{r['id']}.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({"id": r["id"], "formatid": "gen9uu", "format": d.get("format"),
                                    "players": pseudo, "uploadtime": t, "rating": d.get("rating"), "log": log}))
        p1, p2 = preview(log)
        bt = re.search(r"^\|t:\|(\d+)", log, flags=re.M)
        with manifest.open("a") as f:
            f.write(json.dumps({"id": r["id"], "uploadtime": t, "battle_time": int(bt.group(1)) if bt else None,
                                "replay_rating": d.get("rating"), "seat_ratings": seat_ratings(log), "players": pseudo,
                                "preview": [p1, p2], "source_sha256": hashlib.sha256(body).hexdigest()}) + "\n")
        counts["fetched"] += 1
    print(json.dumps({"selected": len(pick), **counts}))


def read_local(path):
    """(battle id without the private-room password, log, real player names) of a battle-room log or replay
    .html; (None, None, None) if the file holds neither."""
    text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
    if pathlib.Path(path).suffix == ".html":
        rid = re.search(r'name="replayid" value="([^"]+)"', text)
        body = re.search(r'class="battle-log-data">(.*?)</script>', text, flags=re.S)
        rid, text = (rid.group(1), body.group(1).replace("\\/", "/")) if rid and body else (None, None)
    else:
        rid = re.match(r">battle-(\S+)", text)
        rid = rid.group(1) if rid else None
    gid = re.match(r"((?:smogtours-)?[a-z0-9]+-\d+)", rid or "")
    if not gid:
        return None, None, None
    text = "\n".join(l for l in text.split("\n") if l.startswith("|"))  # the room header carries the password
    names = {}
    for p, n in re.findall(r"^\|player\|(p[12])\|([^|\n]+)", text, flags=re.M):
        names.setdefault(p, n)
    return gid.group(1), text, [names.get("p1"), names.get("p2")]


def cmd_local(a):
    key = salt(a.salt_file)
    raw = pathlib.Path(a.raw)
    manifest = raw / "manifest.jsonl"
    done = {json.loads(l)["id"] for l in manifest.read_text().splitlines()} if manifest.exists() else set()
    counts, best, recorders = collections.Counter(inputs=len(a.logs)), {}, set()
    for path in a.logs:
        gid, log, names = read_local(path)
        if gid is None:
            counts["skipped:unreadable"] += 1
            continue
        for line in re.findall(r"^\|request\|(\{.*)$", log, flags=re.M):
            side = json.loads(line).get("side") or {}
            recorders.add(to_id(side.get("name", "")))
        lines = set(log.split("\n"))
        if not (gid.startswith("gen9uu-") and "|tier|[Gen 9] UU" in lines and "|gametype|singles" in lines
                and all(names)):
            reason = "not_gen9uu_singles"
        elif any(to_id(n).startswith(tuple(a.exclude_player_prefix)) for n in names):
            reason = "test_account"
        elif not re.search(r"^\|(win|tie)\|", log, flags=re.M):
            reason = "incomplete"
        elif "|turn|1" not in lines:
            reason = "no_turns"
        elif gid in done:
            reason = "already_in_manifest"
        else:
            rank = (pathlib.Path(path).suffix == ".html", ".sync-conflict-" not in pathlib.Path(path).name, len(log))
            if gid in best:
                counts["skipped:duplicate"] += 1
                if rank <= best[gid][0]:
                    continue
            best[gid] = (rank, path, log, names)
            continue
        counts[f"skipped:{reason}"] += 1
    for gid, (_rank, path, log, names) in sorted(best.items()):
        pseudo = [pseudonym(key, n) for n in names]
        try:
            log = sanitize(log, names, pseudo)
        except ValueError:
            counts["skipped:name_survived_sanitize"] += 1
            continue
        t = int(re.search(r"^\|t:\|(\d+)", log, flags=re.M).group(1))
        dest = raw / "gen9uu" / month(t) / f"{gid}.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({"id": gid, "formatid": "gen9uu", "format": "[Gen 9] UU", "players": pseudo,
                                    "uploadtime": t, "rating": None, "log": log}))
        p1, p2 = preview(log)
        with manifest.open("a") as f:
            f.write(json.dumps({"id": gid, "uploadtime": t, "battle_time": t, "replay_rating": None,
                                "seat_ratings": seat_ratings(log), "players": pseudo, "preview": [p1, p2],
                                "source_sha256": hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest(),
                                "source": "local",
                                "recorder_seats": [s for s, n in zip(("p1", "p2"), names) if to_id(n) in recorders]})
                    + "\n")
        counts["written"] += 1
    print(json.dumps(dict(counts)))


def cmd_privacy(a):
    import lz4.frame
    raw = {p.stem: p for p in pathlib.Path(a.raw).rglob("*.json")}
    man = [json.loads(l) for l in (pathlib.Path(a.raw) / "manifest.jsonl").read_text().splitlines()]
    stop_at = min(r["uploadtime"] for r in man) - 86400
    names, before, pages = {}, None, 0
    for path in a.local or []:
        gid, _log, ns = read_local(path)
        if gid in raw and all(ns):
            names[gid] = ns
    while set(raw) - set(names) and pages < a.max_pages:
        page = json.loads(get(f"{API}/search.json?format=gen9uu" + (f"&before={before}" if before else "")))
        pages += 1
        time.sleep(1.0)
        if not page:
            break
        names.update({x["id"]: x["players"] for x in page if x["id"] in raw})
        before = min(x["uploadtime"] for x in page)
        if before < stop_at or len(page) < 51:
            break
    hit = lambda ns, text: sum(1 for n in ns if len(to_id(n)) >= 3 and re.search(re.escape(n), text, flags=re.I))
    vocab = set(json.loads(pathlib.Path(a.vocab).read_text())) if a.vocab else set()
    leak_ids, current = set(), [None]

    def classify(ns, values, key):
        for n in ns:
            for v in values:
                if len(to_id(n)) >= 3 and re.search(re.escape(n), v, flags=re.I):
                    leak = to_id(v) not in vocab
                    c[f"{key}_LEAK" if leak else f"{key}_game_vocab"] += 1
                    if leak:
                        leak_ids.add(current[0])

    def strings(x):
        if isinstance(x, str):
            yield x
        elif isinstance(x, dict):
            for v in x.values():
                yield from strings(v)
        elif isinstance(x, list):
            for v in x:
                yield from strings(v)
    c = collections.Counter(index_pages=pages, raw_files=len(raw), raw_with_names=sum(i in names for i in raw))
    for i, f in raw.items():
        current[0] = i
        if i in names:
            n = hit(names[i], f.read_text())
            c["raw_name_hits"] += n
            c["raw_name_hits_outside_slot_refs"] += hit(names[i], SLOT.sub("", f.read_text())) if n else 0
            if n and vocab:
                classify(names[i], [m.split(": ", 1)[1] for m in SLOT.findall(f.read_text())], "raw_slot_ref")
    for parsed in a.parsed or []:
        for f in pathlib.Path(parsed).glob("gen9uu/*.json.lz4"):
            gid = f.name.split("_")[0]
            current[0] = gid
            if gid not in names:
                c["parsed_without_names"] += 1
                continue
            c["parsed_files"] += 1
            c["parsed_filename_hits"] += hit(names[gid], f.name)
            text = lz4.frame.open(f).read().decode()
            n = hit(names[gid], text)
            c["parsed_content_hits"] += n
            if n and vocab:
                classify(names[gid], set(strings(json.loads(text))), "parsed_value")
    # unverified: no names found (replay since deleted or made private), so neither its raw nor its parsed files
    # were checked; a split must exclude these ids rather than count them as passed
    print(json.dumps({**c, "leak_replay_ids": sorted(leak_ids), "unverified_replay_ids": sorted(set(raw) - set(names))},
                     indent=1))


def cmd_selfplay(a):
    run = pathlib.Path(a.run)
    logroot = run / "ps/node_modules/pokemon-showdown/logs"
    files = sorted(logroot.glob("*/gen9uu/*/gen9uu-*.log.json"))
    random.Random(a.seed).shuffle(files)
    raw = pathlib.Path(a.raw)
    counts = collections.Counter()
    for f in files:
        if counts["written"] >= a.limit:
            break
        d = json.loads(f.read_text())
        m = re.fullmatch(r"UU([a-z]{1,3}\d+)[A-Z]", d.get("p1", ""))
        n = re.fullmatch(r"battle-gen9uu-(\d+)", d.get("roomid", ""))
        if not (m and n and (run / "logs" / f"{m.group(1)}-lifecycle.json").exists()):
            counts["no_block"] += 1
            continue
        lc = json.loads((run / "logs" / f"{m.group(1)}-lifecycle.json").read_text())
        if not lc.get("validation_clean"):
            counts["block_not_clean"] += 1
            continue
        log = "\n".join(d["log"])
        t = int(re.search(r"^\|t:\|(\d+)", log, flags=re.M).group(1))
        gid = f"gen9uu-{m.group(1)}-{n.group(1)}"
        dest = raw / "gen9uu" / month(t) / f"{gid}.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({"id": gid, "formatid": "gen9uu", "players": [d["p1"], d["p2"]], "uploadtime": t,
                                    "rating": None, "log": log}))
        counts["written"] += 1
    print(json.dumps(dict(counts)))


def _load(path):
    import lz4.frame
    with lz4.frame.open(path) as f:
        return json.loads(f.read())


def _mon(p, fields):
    return {k: (sorted(m["name"] for m in p["moves"]) if k == "moves" else p[k]) for k in fields}


OWN = ("name", "item", "ability", "tera_type", "moves", "lvl", "types")


def decode(state, idx):
    """Action index -> semantic action within its own state (Metamon's alphabetical move/switch order), so a
    reconstruction whose predicted moveset shifts the index still counts as the same chosen move."""
    moves = sorted(m["name"] for m in state["player_active_pokemon"]["moves"])
    switches = sorted(p["name"] for p in state["available_switches"])
    if idx == -1:
        return None
    if 0 <= idx < 4:
        return ("move", moves[idx] if idx < len(moves) else f"slot{idx}")
    if 4 <= idx < 9:
        return ("switch", switches[idx - 4] if idx - 4 < len(switches) else f"slot{idx}")
    return ("tera", moves[idx - 9] if idx - 9 < len(moves) else f"slot{idx}")


def cmd_audit(a):
    run = pathlib.Path(a.run)
    metas = {}
    for meta in (run / "piles").glob("*/**/*.json.lz4.meta"):
        block = meta.relative_to(run / "piles").parts[0]
        m = json.loads(meta.read_text())
        metas[(block, m["battle_tag"], m["player"])] = pathlib.Path(str(meta)[: -len(".meta")])
    tot = collections.Counter()
    field_eq = collections.Counter()
    field_n = collections.Counter()
    worst = []
    for f in sorted(pathlib.Path(a.parsed).glob("gen9uu/*.json.lz4")):
        gid, _rating, pov, _vs, opp, _date, _res = f.name[: -len(".json.lz4")].split("_")
        _, block, n = gid.split("-")
        env = metas.get((block, f"battle-gen9uu-{n}", pov))
        if env is None:
            tot["no_env_trajectory"] += 1
            continue
        rp, ev = _load(f), _load(env)
        tot["trajectories"] += 1
        same_len = len(rp["states"]) == len(ev["states"])
        tot["aligned"] += same_len
        if not same_len:
            worst.append({"file": f.name, "parsed_states": len(rp["states"]), "env_states": len(ev["states"])})
            continue
        acts = list(zip(rp["actions"][:-1], ev["actions"][:-1]))
        sem = [(decode(s, x), decode(t, y)) for s, t, (x, y) in zip(rp["states"], ev["states"], acts)]
        tot["actions"] += len(acts)
        tot["missing"] += sum(x == -1 for x, _ in acts)
        tot["action_index_exact"] += sum(x == y for x, y in acts if x != -1)
        tot["action_semantic_exact"] += sum(x == y for x, y in sem if x is not None)
        tot["traj_actions_all_semantic_exact"] += all(x == y for x, y in sem if x is not None)
        for x, y in sem:
            if x is not None and x != y:
                tot[f"semantic_mismatch:{x[0]}->{y[0]}"] += 1
        for i, (s, t) in enumerate(zip(rp["states"], ev["states"])):
            own_s = sorted([s["player_active_pokemon"], *s["available_switches"]], key=lambda p: p["name"])
            own_t = sorted([t["player_active_pokemon"], *t["available_switches"]], key=lambda p: p["name"])
            tot["states"] += 1
            tot["own_roster_equal"] += [p["name"] for p in own_s] == [p["name"] for p in own_t]
            if [p["name"] for p in own_s] == [p["name"] for p in own_t]:
                for ps, pt in zip(own_s, own_t):
                    for k in OWN:
                        field_n[f"own.{k}"] += 1
                        field_eq[f"own.{k}"] += _mon(ps, OWN)[k] == _mon(pt, OWN)[k]
                    field_n["own.hp_pct±0.02"] += 1
                    field_eq["own.hp_pct±0.02"] += abs(ps["hp_pct"] - pt["hp_pct"]) <= 0.02
            for k in ("name", "item", "ability", "status", "tera_type"):
                field_n[f"opp_active.{k}"] += 1
                field_eq[f"opp_active.{k}"] += s["opponent_active_pokemon"][k] == t["opponent_active_pokemon"][k]
            for k in ("forced_switch", "can_tera", "weather", "player_conditions", "opponent_conditions", "opponents_remaining"):
                field_n[f"state.{k}"] += 1
                field_eq[f"state.{k}"] += s[k] == t[k]
    rate = lambda x, y: round(x / y, 4) if y else None
    report = {"parsed_dir": a.parsed, "counts": dict(tot),
              "alignment_rate": rate(tot["aligned"], tot["trajectories"]),
              "missing_action_rate": rate(tot["missing"], tot["actions"]),
              "revealed_action_index_exact_rate": rate(tot["action_index_exact"], tot["actions"] - tot["missing"]),
              "revealed_action_semantic_exact_rate": rate(tot["action_semantic_exact"], tot["actions"] - tot["missing"]),
              "trajectories_all_revealed_actions_semantic_exact": rate(tot["traj_actions_all_semantic_exact"], tot["aligned"]),
              "own_roster_equal_rate": rate(tot["own_roster_equal"], tot["states"]),
              "field_exact_rate": {k: rate(field_eq[k], field_n[k]) for k in sorted(field_n)},
              "misaligned_examples": worst[:20]}
    pathlib.Path(a.out).write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))


def norm_family(species):
    return "|".join(sorted(to_id(s.split("-*")[0]) for s in species))


USAGE_LATEST = "2026-04"  # metamon stat_reader LATEST_USAGE_STATS_DATE in the pinned run source


def usage_windows(months):
    """Metamon's NaiveUsagePredictor reads the format's movesets for the battle's half-year (Jan-Jun / Jul-Dec),
    clamped to the newest monthly file; its all_tiers fallback reads every month. YYYY-MM months -> windows."""
    out = set()
    for m in months:
        y, mo = m.split("-")
        lo, hi = (f"{y}-01", f"{y}-06") if int(mo) <= 6 else (f"{y}-07", f"{y}-12")
        out.add((min(lo, USAGE_LATEST), min(hi, USAGE_LATEST)))
    return [f"{lo}..{hi}" for lo, hi in sorted(out)]


def provenance(usage_stats, months=()):
    """Hidden own-team fields stay as Metamon's guesses
    and are labelled here so training and evaluation know which observation fields are inferred. The usage-stats
    tree is hashed whole: the parser's windows depend on each battle's date and its fallbacks read every month."""
    tree = None
    if usage_stats:
        root, h, n = pathlib.Path(usage_stats), hashlib.sha256(), 0
        for f in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.relative_to(root).as_posix()):
            h.update(f.relative_to(root).as_posix().encode() + b"\0" + hashlib.sha256(f.read_bytes()).digest())
            n += 1
        tree = {"files": n, "tree_sha256": h.hexdigest(),
                "tree_hash": "sha256 over sorted (relative path, NUL, sha256(file bytes)) of every file"}
    return {
        "hidden_own_fields": "kept as Metamon's guesses and marked (upstream practice)",
        "observed": ["own and opposing species rosters (team preview)", "every revealed move, item, ability and "
                     "Tera type", "public battle state", "own actions where revealed (unrevealed = -1, masked from "
                     "the actor loss)"],
        "inferred": ["own-team hidden fields: unrevealed moves, held item, ability, Tera type, EVs/nature"],
        "inferred_by": "Metamon replay_parser backward fill, NaiveUsagePredictor (independent samples from usage "
                       "stats; unseeded, so a re-parse draws different guesses)",
        "usage_stats": {"source": "HF jakegrigsby/metamon-usage-stats revision v5, format gen9uu",
                        "period": f"monthly files end {USAGE_LATEST}; a battle's moveset guesses merge its half-year "
                                  "(clamped to that end); the all_tiers fallback merges every month",
                        "format_windows_used": usage_windows(months),
                        "rank": "by the POV seat rating: 0 / 1500 / 1630 / 1760 (smogtours: top rank); species "
                                "missing at that rank fall back to lower ranks, then all_tiers",
                        "tree": tree},
        "measured_accuracy": "human_replays.py audit vs self-play ground truth (2026-10-21, 586 POVs): revealed "
                             "actions 99.3% exact; own roster 100%, ability 90%, item 69%, Tera 46%, full moveset 27%",
    }


def cmd_split(a):
    pool = json.loads(pathlib.Path(a.team_pool).read_text())
    eval_fams = {norm_family(f["key"].split("|")) for f in pool["families"] if f["split"] != "train"}
    eval_src = {t["provenance_id"].split(":")[0] for t in pool["teams"] if t.get("split") not in (None, "train")}
    man = {}
    for l in pathlib.Path(a.manifest).read_text().splitlines():
        r = json.loads(l)
        man[r["id"]] = r
    files = sorted(pathlib.Path(a.parsed).glob("gen9uu/*.json.lz4"))
    newest = max((man[f.name.split("_")[0]]["uploadtime"] for f in files if f.name.split("_")[0] in man), default=0)
    cut = newest - a.holdout_days * 86400
    in_val = lambda p: int(hashlib.sha256(p.encode()).hexdigest()[:13], 16) / 16**13 < a.val_frac
    out = pathlib.Path(a.out)
    rows, counts = [], collections.Counter()
    for f in files:
        gid, rating, pov, _vs, opp, date, res = f.name[: -len(".json.lz4")].split("_")
        r = man.get(gid)
        if r is None:
            reason, split = "not_in_manifest", None
        elif gid in eval_src:
            reason, split = "eval_team_pool_source_replay", None
        elif any(norm_family(t) in eval_fams for t in r["preview"]):
            reason, split = "eval_family", None
        elif r["uploadtime"] >= cut:
            reason, split = None, "test"
        elif in_val(pov):
            reason, split = None, "val"
        elif in_val(opp):
            reason, split = "opponent_is_val_player", None
        else:
            reason, split = None, "train"
        counts[split or f"excluded:{reason}"] += 1
        rows.append({"file": f.name, "id": gid, "pov": pov, "split": split, "reason": reason,
                     "pov_rating": rating, "result": res})
        if split:
            d = out / split / "gen9uu"
            d.mkdir(parents=True, exist_ok=True)
            if not (d / f.name).exists():
                os.link(f, d / f.name)
    summary = {"newest_upload": newest, "holdout_after": cut, "val_frac": a.val_frac, "counts": dict(counts),
               "eval_families_guarded": len(eval_fams), "eval_source_replays_guarded": len(eval_src),
               "players": {s: len({r["pov"] for r in rows if r["split"] == s}) for s in ("train", "val", "test")}}
    months = collections.Counter(month(man[r["id"]]["uploadtime"]) for r in rows if r["id"] in man)
    summary["battle_upload_months"] = dict(sorted(months.items()))
    parsed_months = {f"{d[6:10]}-{d[0:2]}" for d in (f.name.split("_")[5] for f in files)}  # parser's MM-DD-YYYY
    summary["provenance"] = provenance(a.usage_stats, parsed_months)
    (out / "split.json").write_text(json.dumps({"summary": summary, "rows": rows}, indent=1))
    print(json.dumps(summary, indent=1))


def cmd_teams(a):
    import subprocess
    from metamon.backend.team_prediction.predictor import NaiveUsagePredictor
    from metamon.backend.team_prediction.team import TeamSet
    import numpy
    random.seed(a.seed)
    numpy.random.seed(a.seed)
    rows = [r for r in json.loads((pathlib.Path(a.split) / "split.json").read_text())["rows"] if r["split"] == "train"]
    out = pathlib.Path(a.out) / "gen9uu"
    out.mkdir(parents=True, exist_ok=False)
    pred, made, failed = NaiveUsagePredictor(), [], collections.Counter()
    for r in rows:
        src = pathlib.Path(a.revealed) / "gen9uu" / (r["file"][: -len(".json.lz4")] + ".gen9uu_team")
        try:
            gid, rating, _pov, _vs, _opp, date, _res = src.name.split(".")[0].split("_")
            team = TeamSet.from_showdown_file(str(src), format="gen9uu")
            filled = pred.predict(team, date=datetime.datetime.strptime(date, "%m-%d-%Y").date(),
                                  rating=int(rating) if rating.isdigit() else None, gameid=gid)
        except Exception as e:
            failed[type(e).__name__] += 1
            continue
        name = f"team_{len(made) + 1:06d}.gen9uu_team"
        filled.write_to_file(str(out / name))
        made.append({"file": name, "source": r["file"]})
    audit = json.loads(subprocess.run(["node", str(pathlib.Path(__file__).with_name("audit_teams.cjs")), a.showdown,
                                       a.tokenizer, str(out)], capture_output=True, text=True).stdout)
    valid = {pathlib.Path(x["file"]).name for x in audit["rows"] if x["valid"]}
    errors = collections.Counter(e.split(":")[0] for x in audit["rows"] for e in x["errors"])
    for m in made:
        m["valid"] = m["file"] in valid
        if not m["valid"]:
            (out / m["file"]).unlink()
    (out / "index.csv").write_text("filename\n" + "".join(m["file"] + "\n" for m in made if m["valid"]))
    summary = {"train_povs": len(rows), "completed": len(made), "completion_failures": dict(failed),
               "valid": len(valid), "distinct_valid": audit["distinctValidTeams"], "invalid_reasons": dict(errors.most_common(10)),
               "missing_tokens": audit["missingTokens"], "predictor": "NaiveUsagePredictor", "seed": a.seed}
    (pathlib.Path(a.out) / "manifest.json").write_text(json.dumps({"summary": summary, "teams": made}, indent=1))
    print(json.dumps(summary, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("index"); s.add_argument("--out", required=True); s.add_argument("--days", type=int, default=240)
    s.add_argument("--max-pages", type=int, default=600)
    s = sub.add_parser("fetch"); s.add_argument("--index", required=True); s.add_argument("--raw", required=True)
    s.add_argument("--salt-file", required=True); s.add_argument("--min-rating", type=int, default=1300)
    s.add_argument("--since"); s.add_argument("--limit", type=int, default=None); s.add_argument("--smogtours", action="store_true")
    s = sub.add_parser("local"); s.add_argument("--logs", nargs="+", required=True); s.add_argument("--raw", required=True)
    s.add_argument("--salt-file", required=True); s.add_argument("--exclude-player-prefix", action="append", default=[])
    s = sub.add_parser("selfplay"); s.add_argument("--run", required=True); s.add_argument("--raw", required=True)
    s.add_argument("--limit", type=int, default=100); s.add_argument("--seed", type=int, default=0)
    s = sub.add_parser("audit"); s.add_argument("--parsed", required=True); s.add_argument("--run", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("split"); s.add_argument("--parsed", required=True); s.add_argument("--manifest", required=True)
    s.add_argument("--team-pool", required=True); s.add_argument("--out", required=True)
    s.add_argument("--holdout-days", type=int, default=14); s.add_argument("--val-frac", type=float, default=0.1)
    s.add_argument("--usage-stats", help="METAMON_CACHE_DIR/usage-stats used by the parser (hashed into provenance)")
    s = sub.add_parser("privacy"); s.add_argument("--raw", required=True); s.add_argument("--parsed", nargs="*")
    s.add_argument("--max-pages", type=int, default=800); s.add_argument("--vocab")
    s.add_argument("--local", nargs="*", help="source logs of `local` battles: names come from them, not the index")
    s = sub.add_parser("teams"); s.add_argument("--split", required=True); s.add_argument("--revealed", required=True)
    s.add_argument("--out", required=True); s.add_argument("--showdown", required=True)
    s.add_argument("--tokenizer", required=True); s.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    {"privacy": cmd_privacy, "teams": cmd_teams, "index": cmd_index, "fetch": cmd_fetch, "selfplay": cmd_selfplay, "audit": cmd_audit, "split": cmd_split, "local": cmd_local}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
