"""human_replays.py `local`: the owner's own saved games become pipeline raw replays without leaking anything private.

Why: the extension saves each finished battle-room log, which also carries the recording player's |request| (their
name and full private team) and a room password. Only completed Gen 9 UU games between real players may train, each
battle once, under the same HMAC pseudonyms as fetched replays (so the player-disjoint split still holds), and the
privacy gate must check them offline because private ladder games are not in the public index. Synthetic names only.
Run with any python that has lz4 (e.g. the run venv):  python -m unittest test_human_replays
"""
import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import human_replays as hr

OWNER, RIVAL, TESTER = "Owner Name", "Rival_99", "s2oAtest1"
PASSWORD = "abc123secretpw"


def battle(p1, p2, *, end="|win|" + RIVAL, turns=True, tier="[Gen 9] UU", request_side=None):
    lines = ["|j|☆" + p1, "|t:|1792600000", "|gametype|singles", f"|player|p1|{p1}|1|1500",
             f"|player|p2|{p2}|2|1480", f"|tier|{tier}", "|rated|", "|poke|p1|Scizor, M|", "|poke|p1|Donphan, F|",
             "|poke|p2|Gliscor, M|", "|poke|p2|Slowking, F|", "|teampreview", "|start",
             f"|switch|p1a: Scizor|Scizor, M|281/281", "|switch|p2a: Gliscor|Gliscor, M|100/100"]
    if request_side:
        name = OWNER if request_side == "p1" else p2
        lines.append("|request|" + json.dumps({"side": {"name": name, "id": request_side, "pokemon": [
            {"ident": f"{request_side}: Scizor", "item": "choiceband", "moves": ["bulletpunch"]}]}}))
        lines.append("|sso-state|" + json.dumps({"playerSide": request_side, "myPokemon": [{"item": "choiceband"}]}))
    if turns:
        lines += ["|turn|1", "|move|p1a: Scizor|Bullet Punch|p2a: Gliscor", "|-damage|p2a: Gliscor|60/100",
                  f"|-message|{p1} forfeited."]
    if end:
        lines += [end, f"|raw|{p1}'s rating: 1500 &rarr; <strong>1480</strong>", f"|askreg|{p1.lower()}"]
    return "\n".join(lines) + "\n"


def room_log(d, name, bid, text):
    path = d / name
    path.write_text(f">battle-gen9uu-{bid}-{PASSWORD}\n" + text)
    return str(path)


def replay_html(d, name, bid, text):
    path, body = d / name, text.replace("/", "\\/")  # the client's replay download escapes every "/"
    path.write_text(f'<input type="hidden" name="replayid" value="gen9uu-{bid}" />\n'
                    f'<script type="text/plain" class="battle-log-data">{body}</script>\n')
    return str(path)


def run(fn, **kw):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        fn(argparse.Namespace(**kw))
    return json.loads(out.getvalue())


class LocalGamesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.src, self.raw, self.salt = t / "src", t / "raw", str(t / "pseudonym.salt")
        self.src.mkdir()
        s = self.src
        self.logs = [
            room_log(s, "a.log", 101, battle(OWNER, RIVAL, request_side="p1")),          # usable owner game
            room_log(s, "a.sync-conflict-20260331-1-X.log", 101, battle(OWNER, RIVAL)),  # same battle, conflict copy
            room_log(s, "b.log", 102, battle(OWNER, RIVAL, request_side="p1")),          # also downloaded below
            replay_html(s, "b.html", 102, battle(OWNER, RIVAL)),
            room_log(s, "c.log", 103, battle(TESTER, OWNER, request_side="p2")),         # test account
            room_log(s, "d.log", 104, battle(OWNER, RIVAL, end=None, request_side="p1")),  # never finished
            room_log(s, "e.log", 105, battle(OWNER, RIVAL, turns=False)),                # forfeited at preview
            room_log(s, "f.log", 106, battle(OWNER, RIVAL, tier="[Gen 9] OU")),          # other format
            str(s / "notes.log"),
        ]
        (s / "notes.log").write_text("not a battle\n")

    def tearDown(self):
        self.tmp.cleanup()

    def local(self):
        return run(hr.cmd_local, logs=self.logs, raw=str(self.raw), salt_file=self.salt, exclude_player_prefix=["s2o"])

    def test_only_complete_real_uu_games_once_each_with_reasons(self):
        counts = self.local()
        self.assertEqual(counts, {"inputs": 9, "written": 2, "skipped:duplicate": 2, "skipped:test_account": 1,
                                  "skipped:incomplete": 1, "skipped:no_turns": 1, "skipped:not_gen9uu_singles": 1,
                                  "skipped:unreadable": 1})
        rows = [json.loads(l) for l in (self.raw / "manifest.jsonl").read_text().splitlines()]
        self.assertEqual([r["id"] for r in rows], ["gen9uu-101", "gen9uu-102"])
        files = {r["id"]: r for r in rows}
        # The replay .html (no private lines to drop) wins over the room log, and the owner's seat is still
        # marked although that copy carries no |request|.
        self.assertEqual(files["gen9uu-102"]["source_sha256"],
                         hr.hashlib.sha256((self.src / "b.html").read_bytes()).hexdigest())
        self.assertEqual(files["gen9uu-101"]["source_sha256"],
                         hr.hashlib.sha256((self.src / "a.log").read_bytes()).hexdigest())
        self.assertEqual([r["recorder_seats"] for r in rows], [["p1"], ["p1"]])
        self.assertEqual(rows[0]["preview"], [["Scizor", "Donphan"], ["Gliscor", "Slowking"]])
        self.assertEqual(rows[0]["seat_ratings"], [1500, 1480])
        html = json.loads(next(self.raw.glob("gen9uu/*/gen9uu-102.json")).read_text())["log"]
        self.assertIn("|switch|p1a: Scizor|Scizor, M|281/281", html.split("\n"))  # HP the parser can read
        # A second run (e.g. at the next freeze, into a merged RAW) adds nothing.
        again = self.local()
        self.assertEqual(again.get("written", 0), 0)
        self.assertEqual(again["skipped:already_in_manifest"], 4)

    def test_nothing_private_reaches_raw_and_pseudonyms_match_fetch(self):
        self.local()
        key = bytes.fromhex(Path(self.salt).read_text().strip())
        text = "".join(p.read_text() for p in self.raw.rglob("*") if p.is_file())
        for secret in (OWNER, RIVAL, "Owner", "choiceband", "playerSide", PASSWORD, "|request|", "|sso-state|"):
            self.assertNotIn(secret.lower(), text.lower())
        game = json.loads(next(self.raw.glob("gen9uu/*/gen9uu-101.json")).read_text())
        # fetch's pseudonym for the same player, so a player in public and local data is one player in the split
        self.assertEqual(game["players"], [hr.pseudonym(key, OWNER), hr.pseudonym(key, RIVAL)])
        self.assertTrue(game["log"].startswith("|t:|"))  # no room header line for the parser to choke on
        self.assertIn("|turn|1", game["log"].split("\n"))

    def test_privacy_gate_checks_local_games_offline(self):
        self.local()

        def offline(url):
            raise AssertionError("privacy gate went to the network for local games")
        hr.get, real_get = offline, hr.get
        try:
            report = run(hr.cmd_privacy, raw=str(self.raw), parsed=None, max_pages=1, vocab=None, local=self.logs)
        finally:
            hr.get = real_get
        self.assertEqual((report["raw_files"], report["raw_with_names"], report["raw_name_hits"]), (2, 2, 0))
        self.assertEqual(report["unverified_replay_ids"], [])
        # a battle whose names cannot be found (a public replay deleted after fetch) is listed, not passed silently
        hr.get = lambda url: b"[]"
        try:
            report = run(hr.cmd_privacy, raw=str(self.raw), parsed=None, max_pages=1, vocab=None, local=self.logs[:0])
        finally:
            hr.get = real_get
        self.assertEqual(report["raw_with_names"], 0)
        self.assertEqual(len(report["unverified_replay_ids"]), 2)
        # and the gate does detect a name that slipped through
        leaked = next(self.raw.glob("gen9uu/*/gen9uu-101.json"))
        leaked.write_text(leaked.read_text().replace("|turn|1", "|turn|1\\n|-message|" + RIVAL))
        hr.get = offline
        try:
            report = run(hr.cmd_privacy, raw=str(self.raw), parsed=None, max_pages=1, vocab=None, local=self.logs)
        finally:
            hr.get = real_get
        self.assertEqual(report["raw_name_hits"], 1)


class ProvenanceTest(unittest.TestCase):
    """Why: hidden own-team fields are usage-stat guesses, and the parser picks the stats by each battle's date
    (half-year windows, clamped to the newest monthly file; the all_tiers fallback reads every month). The split's
    provenance must name the windows the data actually used and pin every file the parser could read, so that
    adding older battles (2025) cannot leave their guess source unrecorded."""

    def test_windows_follow_battle_half_years_clamped_to_latest(self):
        self.assertEqual(hr.usage_windows({"2025-10", "2025-12", "2026-03", "2026-10"}),
                         ["2025-07..2025-12", "2026-01..2026-04", "2026-04..2026-04"])

    def test_tree_hash_pins_every_file_including_older_months(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            old = root / "movesets_data/gen9/uu/1500/2025-11.json"
            for f in (old, root / "movesets_data/gen9/all_tiers/0/2026-04.json"):
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text("{}")
            before = hr.provenance(str(root), {"2025-11"})["usage_stats"]
            old.write_text('{"scizor": {}}')
            after = hr.provenance(str(root), {"2025-11"})["usage_stats"]
        self.assertEqual(before["format_windows_used"], ["2025-07..2025-12"])
        self.assertEqual(before["tree"]["files"], 2)
        self.assertNotEqual(before["tree"]["tree_sha256"], after["tree"]["tree_sha256"])


if __name__ == "__main__":
    unittest.main()
