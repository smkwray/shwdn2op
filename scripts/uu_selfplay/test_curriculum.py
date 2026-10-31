"""curriculum.py detectors on synthetic trajectories. Why they matter: a wrong noeffect label scores a correct play as
an error in the pre-registered screen, and a wrong event puts an ordinary game into the curriculum stratum.
Run with a python that has lz4, node on PATH: python -m unittest test_curriculum (from scripts/uu_selfplay)."""
import copy, json, pathlib, subprocess, sys, tempfile, unittest
import lz4.frame

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import curriculum as C

ROOT = pathlib.Path(__file__).resolve().parents[2]




def mv(name, type_, cat="special", pp=16):
    return {"name": name, "move_type": type_, "category": cat, "base_power": 80, "accuracy": 1.0, "priority": 0,
            "current_pp": pp, "max_pp": 16}


def mon(name, types, ability, moves, hp=1.0, tera="fairy"):
    return {"name": name, "hp_pct": hp, "types": types, "ability": ability, "item": "leftovers", "moves": moves,
            "tera_type": tera, "status": "nostatus", "effect": "noeffect"}


def state(me, opp, forced=False, can_tera=True, prev=None):
    return {"player_active_pokemon": me, "opponent_active_pokemon": opp, "available_switches": [mon("b", "normal notype", "x", [])],
            "forced_switch": forced, "can_tera": can_tera, "opponents_remaining": 6, "opponent_teampreview": ["o"] * 6,
            "player_prev_move": None, "opponent_prev_move": prev}


def write(tmp, states, actions, won=True):
    p = tmp / f"gen9uu-1_a_vs_b_{'WIN' if won else 'LOSS'}.json.lz4"
    with lz4.frame.open(p, "wb") as f:
        f.write(json.dumps({"states": states, "actions": actions}).encode())
    return p


class Detectors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._dir = tempfile.TemporaryDirectory()
        out = pathlib.Path(cls._dir.name) / "mech.json"
        subprocess.run(["node", "--import", "tsx", "scripts/uu_selfplay/curriculum_mechanics.mts", str(out)], cwd=ROOT,
                       check=True, capture_output=True)
        cls.mech = C.Mech(out)

    @classmethod
    def tearDownClass(cls):
        cls._dir.cleanup()

    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._t.name)
        self.addCleanup(self._t.cleanup)

    def test_scald_into_revealed_water_absorb_is_an_absorb_event_and_a_noeffect_error(self):
        mech, tmp_path = self.mech, self.tmp
        me = mon("slowking", "water psychic", "regenerator", [mv("scald", "water"), mv("slackoff", "normal", "status")])
        opp = mon("clodsire", "poison ground", "waterabsorb", [mv("earthquake", "ground", "physical")])
        s0 = state(me, opp); s1 = copy.deepcopy(s0); s1["player_active_pokemon"]["moves"][0]["current_pp"] = 15
        row = C.scan_file(mech, "t", write(tmp_path, [s0, s1], [0, -1]))  # alphabetical: 0 = scald
        assert row["events"]["absorb"] == 1 and row["events"]["absorb_into"] == 1
        lab = [l for l in row["labels"] if l["kind"] == "noeffect"]
        assert lab and lab[0]["actions"] == [0, 9] and lab[0]["chosen_bad"]


    def test_an_ability_ignoring_attacker_is_not_an_error(self):
        mech, tmp_path = self.mech, self.tmp
        # Mold Breaker hits through Water Absorb, so attacking is legitimate and must not be scored as an error.
        me = mon("x", "water notype", "moldbreaker", [mv("scald", "water"), mv("tackle", "normal", "physical")])
        opp = mon("clodsire", "poison ground", "waterabsorb", [])
        row = C.scan_file(mech, "t", write(tmp_path, [state(me, opp), state(me, opp)], [0, -1]))
        assert "absorb" not in row["events"] and not [l for l in row["labels"] if l["kind"] == "noeffect"]


    def test_type_immunity_is_an_error_but_an_unrevealed_ability_is_not_assumed(self):
        mech, tmp_path = self.mech, self.tmp
        me = mon("x", "electric notype", "static", [mv("thunderbolt", "electric"), mv("surf", "water")])
        opp = mon("y", "ground notype", "unknownability", [])
        row = C.scan_file(mech, "t", write(tmp_path, [state(me, opp, can_tera=False), state(me, opp)], [1, -1]))
        assert [l["actions"] for l in row["labels"] if l["kind"] == "noeffect"] == [[1]]  # surf=0, thunderbolt=1
        me2 = mon("x", "water notype", "static", [mv("surf", "water")])
        row2 = C.scan_file(mech, "t", write(tmp_path, [state(me2, mon("z", "fire notype", "unknownability", [])), state(me2, opp)], [0, -1]))
        assert not row2["labels"] and "absorb" not in row2["events"]


    def test_ko_before_acting_needs_unspent_pp(self):
        mech, tmp_path = self.mech, self.tmp
        me = mon("x", "normal notype", "y", [mv("tackle", "normal", "physical")])
        s0 = state(me, mon("o", "normal notype", "z", [])); dead = copy.deepcopy(s0)
        dead["player_active_pokemon"]["hp_pct"] = 0; dead["forced_switch"] = True
        assert C.scan_file(mech, "t", write(tmp_path, [s0, dead], [0, -1]))["events"].get("ko_first") == 1
        acted = copy.deepcopy(dead); acted["player_active_pokemon"]["moves"][0]["current_pp"] = 15  # it moved, then fainted
        assert "ko_first" not in C.scan_file(mech, "t", write(tmp_path, [s0, acted], [0, -1]))["events"]


    def test_three_heals_in_six_decisions_is_a_loop_and_two_is_not(self):
        mech, tmp_path = self.mech, self.tmp
        def run(n):
            states, acts = [], []
            for i in range(n + 1):
                me = mon("x", "normal notype", "y", [mv("recover", "normal", "status", pp=16 - i)], hp=0.6)
                states.append(state(me, mon("o", "normal notype", "z", []))); acts.append(0)
            acts[-1] = -1
            return C.scan_file(mech, "t", write(tmp_path, states, acts))["events"]
        assert run(3).get("heal_loop_own") == 1 and "heal_loop" not in run(2)


    def test_defensive_tera_needs_a_revealed_super_effective_move_resisted_by_the_tera_type(self):
        mech, tmp_path = self.mech, self.tmp
        me = mon("x", "dragon notype", "y", [mv("tackle", "normal", "physical")], tera="steel")
        opp = mon("o", "fairy notype", "z", [mv("moonblast", "fairy")])
        assert C.scan_file(mech, "t", write(tmp_path, [state(me, opp), state(me, opp)], [9, -1]))["events"] == {"def_tera": 1, "def_tera_used": 1}
        opp["moves"] = []
        assert "def_tera" not in C.scan_file(mech, "t", write(tmp_path, [state(me, opp), state(me, opp)], [0, -1]))["events"]

if __name__ == "__main__":
    unittest.main()
