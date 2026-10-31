"""Own-side Illusion in the fork's decoder (MetamonBackendBattle.parse_message through OwnIllusion).

Why it matters: Showdown names our disguised Zoroark as the mon it imitates even in our own private stream, so upstream
Metamon tracked the wrong active mon. Kakuna then saw a wrong state, and when the imitated mon was the only switch left
no legal action remained (self-play fell back to random orders; the ft1 evaluation lost games). The fix must name our
own disguise only: streams without it, and the opponent's disguise (we must not see through it), decode byte-identically.

Run against an assembled fork (data files present) with Metamon's runtime, from the project root:
  PYTHONPATH=RUN/source python -m unittest discover -s vendor/metamon/tests -v
streams.json.gz: private streams of seeded random-player battles in Pokemon Showdown 0.11.11's own simulator, made by
make_streams.cjs (test accounts "Offline p1/p2"; each entry names its seed and its two UU team-pool teams).
"""

import gzip
import hashlib
import json
import logging
from pathlib import Path
import unittest
import warnings

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
from metamon.env.metamon_battle import MetamonBackendBattle, OwnIllusion  # noqa: E402
from metamon.interface import UniversalAction, UniversalState  # noqa: E402
from metamon.rl.pretrained import Kakuna  # noqa: E402

FIXTURE = Path(__file__).parent / "streams.json.gz"
MODEL = Kakuna()


class NoRewrite(OwnIllusion):
    """Upstream Metamon: every line goes to the replay parser as received."""

    def rewrite(self, fields):
        return [fields]


class NoPrivateReconcile(MetamonBackendBattle):
    """Retain the historical upstream failure as the negative control."""
    def _reconcile_own_active(self, pokemon):
        pass


def toid(name):
    return "".join(c for c in name.lower() if c.isalnum())


def decode(frames, side, rewrite=True):
    """The worker's and MetamonPlayer's order: every line to parse_message, requests to parse_request too.
    One row per actionable request: active mon (ours and theirs), the request's active, legal agent indices and a
    digest of Kakuna's observation bytes."""
    battle_type = MetamonBackendBattle if rewrite else NoPrivateReconcile
    battle = battle_type("battle-gen9uu-offline", "Offline " + side, logging.getLogger("decode"), False, 9)
    if not rewrite:
        battle._own_illusion = NoRewrite()
    space, actions = MODEL.observation_space, MODEL.action_space
    space.reset()
    rows = []
    for data in frames:
        request = None
        for line in data.split("\n"):
            if not line:
                continue
            kind = line.split("|", 2)[1]
            if kind == "request":
                request = json.loads(line[9:])
            battle.parse_message(line.split("|"))
            if kind == "request":
                battle.parse_request(request)
            elif kind == "turn":
                battle._mm_battle.turnlist = battle._mm_battle.turnlist[-2:]
        if not request or request.get("wait") or request.get("teamPreview"):
            continue
        state = UniversalState.from_Battle(battle)
        legal = sorted(actions.action_to_agent_output(state, a) for a in UniversalAction.definitely_valid_actions(state, battle))
        obs = space.state_to_obs(state)
        digest = hashlib.sha256()
        for key in sorted(obs):
            value = np.asarray(obs[key])
            digest.update(f"{key}:{value.dtype}:{value.shape}".encode())
            digest.update(value.tobytes())
        ours, theirs = battle._current_turn.get_active_pokemon(side == "p1")[0], battle._current_turn.get_active_pokemon(side != "p1")[0]
        rows.append({"rqid": request.get("rqid"), "active": ours and toid(ours.name), "opponent": theirs and toid(theirs.name),
                     "request_active": [toid(m["details"].split(",")[0]) for m in request["side"]["pokemon"] if m["active"]],
                     "legal": legal, "obs": digest.hexdigest()})
    return rows


def changed_lines(frames):
    """(original, rewritten-or-None) for each line the rule changes or drops."""
    rule, out, rewritten = OwnIllusion(), [], []
    original = [line for data in frames for line in data.split("\n") if line]
    for line in original:
        rewritten.extend("|".join(row) for row in rule.rewrite(line.split("|")))
    index = 0
    for line in original:
        if index < len(rewritten) and rewritten[index] == line:
            index += 1
        elif line.startswith(f"|replace|{rule.side}a: "):
            out.append((line,None))
        else:
            out.append((line,rewritten[index]));index += 1
    assert index == len(rewritten)
    return out


def illusion_holders(frames, side):
    request = next(json.loads(l[9:]) for f in frames for l in f.split("\n") if l.startswith("|request|"))
    return [m["ident"] for m in request["side"]["pokemon"] if "illusion" in (m.get("ability"), m.get("baseAbility"))]


class OwnIllusionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.streams = json.loads(gzip.decompress(FIXTURE.read_bytes()))

    def own_streams(self):
        return [(s["name"], side, s["frames"][side]) for s in self.streams for side in ("p1", "p2")
                if illusion_holders(s["frames"][side], side)]

    def test_fixtures_cover_the_failure(self):
        """The own-disguise streams must reproduce upstream's mis-tracking, including an empty legal set."""
        wrong = empty = 0
        for name, side, frames in self.own_streams():
            for row in decode(frames, side, rewrite=False):
                wrong += [row["active"]] != row["request_active"]
                empty += not row["legal"]
        self.assertGreater(wrong, 0)
        self.assertGreater(empty, 0)

    def test_own_disguise_decodes_as_the_real_mon(self):
        """Every decision's active mon is the one our request says is active, and some action is always legal."""
        streams = self.own_streams()
        self.assertGreaterEqual(len(streams), 2)
        for name, side, frames in streams:
            rows = decode(frames, side)
            self.assertGreater(len(rows), 10)
            for row in rows:
                self.assertEqual([row["active"]], row["request_active"], (name, side, row["rqid"]))
                self.assertTrue(row["legal"], (name, side, row["rqid"]))

    def test_rule_renames_and_drops_only_our_own_disguise(self):
        """Only our own position's fields (and a renamed switch's details) change; |replace| is dropped; a dragged-in
        disguise (Roar, Whirlwind, Dragon Tail) is renamed like a switch."""
        dropped = dragged = 0
        for name, side, frames in self.own_streams():
            changes = changed_lines(frames)
            self.assertTrue(changes, name)
            for old, new in changes:
                if new is None:
                    dropped += 1
                    self.assertTrue(old.startswith(f"|replace|{side}a: "), (name, old))
                    continue
                before, after = old.split("|"), new.split("|")
                dragged += before[1] == "drag"
                self.assertEqual(len(before), len(after), (name, old))
                for i, (a, b) in enumerate(zip(before, after)):
                    ours = a.removeprefix("[of] ").startswith(f"{side}a: ") and b.removeprefix("[of] ").startswith(f"{side}a: ")
                    details = i == 3 and before[1] in ("switch", "drag")
                    self.assertTrue(a == b or ours or details, (name, old, new))
        self.assertGreater(dropped, 0)
        self.assertGreater(dragged, 0)

    def test_streams_without_own_illusion_decode_byte_identically(self):
        """No own Illusion holder (incl. a side facing the opponent's Zoroark): no line changes and every observation,
        legal set and active mon is identical with and without the rule."""
        checked = foe_disguised = 0
        for s in self.streams:
            for side in ("p1", "p2"):
                frames = s["frames"][side]
                if illusion_holders(frames, side):
                    continue
                self.assertEqual(changed_lines(frames), [], (s["name"], side))
                rows = decode(frames, side)
                self.assertEqual(rows, decode(frames, side, rewrite=False), (s["name"], side))
                checked += len(rows)
                foe = "p2" if side == "p1" else "p1"
                foe_disguised += illusion_holders(s["frames"][foe], foe) != []
        self.assertGreater(checked, 50)
        self.assertGreater(foe_disguised, 0)

    def test_opponent_disguise_is_untouched_when_both_sides_hold_illusion(self):
        """Mirror match: our own disguise is fixed while the opponent's shown mon stays exactly as Showdown shows it."""
        mirrors = [s for s in self.streams if all(illusion_holders(s["frames"][x], x) for x in ("p1", "p2"))]
        self.assertTrue(mirrors)
        for s in mirrors:
            for side in ("p1", "p2"):
                fixed, upstream = decode(s["frames"][side], side), decode(s["frames"][side], side, rewrite=False)
                self.assertEqual([r["opponent"] for r in fixed], [r["opponent"] for r in upstream], (s["name"], side))

    def test_idempotent_on_already_named_lines(self):
        """The TypeScript OwnIllusion may already have renamed the stream: a second pass changes nothing."""
        for name, side, frames in self.own_streams():
            rule, renamed = OwnIllusion(), []
            for data in frames:
                renamed.append("\n".join("|".join(f) for line in data.split("\n") for f in rule.rewrite(line.split("|"))))
            self.assertEqual(changed_lines(renamed), [], name)
            self.assertEqual(decode(renamed, side), decode(frames, side), name)


if __name__ == "__main__":
    unittest.main()
