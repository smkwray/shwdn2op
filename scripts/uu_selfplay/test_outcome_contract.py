"""Prospective roster reward and official terminal outcomes, without model execution."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from poke_env.environment import Pokemon, Status
from batch_server import Session, terminal_result

ROOT = Path(__file__).resolve().parents[2]


def source_module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT/relative)
    module = importlib.util.module_from_spec(spec);sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


api = source_module("prospective_interface", "vendor/metamon/metamon/interface.py")
decoder = source_module("prospective_decoder", "vendor/metamon/metamon/env/metamon_battle.py")


class OutcomeContract(unittest.TestCase):
    def test_kakuna_collection_and_training_share_roster_reward(self):
        from metamon.rl.pretrained import Kakuna
        self.assertEqual(type(Kakuna().reward_function).__name__,"RosterShapedReward")

    def test_native_step_retains_accepted_index_draw_and_censored_terminal(self):
        import lz4.frame
        from metamon.env.wrappers import PokeEnvWrapper
        from metamon.interface import UniversalState
        class Native(PokeEnvWrapper):
            @property
            def current_battle(self):return self.fixture_battle
            @property
            def player_username(self):return "fixture"
        for incomplete in (False,True):
            with self.subTest(incomplete=incomplete),tempfile.TemporaryDirectory() as directory:
                env=object.__new__(Native);battle=self.battle();env.fixture_battle=battle
                initial=UniversalState.from_Battle(battle);battle.finished=True;battle.won=False;battle.lost=False
                battle.battle_tag="battle-gen9uu-draw";battle.opponent_username="opponent"
                env.agent=SimpleNamespace(n_won_battles=0)
                env.turn_counter=env.valid_action_counter=env.invalid_action_counter=env.battle_reference=0
                env.turn_limit=1000;env._most_recent_legal_actions=[7];env._most_recent_state=initial
                env.save_trajectories_to=directory;env.save_results_to=None;env.metamon_opponent_name="opponent"
                env.metamon_battle_format="gen9uu";env.trajectory={"states":[initial],"actions":[]}
                env.metamon_team_set=SimpleNamespace(most_recent_team_file="fixtures/teams/uu/team.txt")
                env.metamon_action_space=SimpleNamespace(agent_output_to_action=lambda **kw:SimpleNamespace(action_idx=kw["agent_output"]))
                env.shwdn2op_strict_policy=True;env.shwdn2op_accepted_index=7
                with patch.object(PokeEnvWrapper.__bases__[0],"step",return_value=({},0.,True,incomplete,{})):
                    env.step(0)
                path=next(Path(directory).glob("*.json.lz4"))
                with lz4.frame.open(path,"rb") as stream:body=json.loads(stream.read())
                meta=json.loads(Path(str(path)+".meta").read_text())
                self.assertEqual(body["actions"],[7,-1])
                self.assertEqual(body["outcome"],"INCOMPLETE" if incomplete else "DRAW")
                self.assertEqual(body["terminal_score"],None if incomplete else .5)
                self.assertEqual(meta["training_eligible"],not incomplete)
                self.assertEqual(body["states"][-1]["battle_complete"],not incomplete)

    def battle(self):
        party = [Pokemon(gen=9, species=s) for s in
                 ("pikachu", "bulbasaur", "charmander", "squirtle", "eevee", "magikarp")]
        for p in party:p.set_hp_status("100/100")
        party[0]._active = True;party[-1].set_hp_status("0 fnt")
        opponent = Pokemon(gen=9, species="ditto");opponent.set_hp_status("100/100")
        return SimpleNamespace(battle_tag="battle-gen9uu-test", weather={}, fields={}, side_conditions={},
            opponent_side_conditions={}, active_pokemon=party[0], opponent_active_pokemon=opponent,
            team={str(i):p for i,p in enumerate(party)}, opponent_team={"opponent":opponent},
            reviving=False, force_switch=False, won=None, lost=None, finished=False,
            can_tera=None, teampreview_opponent_team=[])

    def test_revival_menu_is_not_a_casualty_and_counts_round_trip(self):
        battle = self.battle();before = api.UniversalState.from_Battle(battle)
        battle.reviving = True;menu = api.UniversalState.from_Battle(battle)
        self.assertEqual((len(before.available_switches),len(menu.available_switches)),(4,1))
        self.assertEqual(api.AggressiveShapedReward()(before,menu),-2.)
        self.assertEqual(api.RosterShapedReward()(before,menu),0.)
        restored = api.UniversalState.from_dict(copy.deepcopy(menu.to_dict()))
        self.assertEqual((restored.player_remaining,restored.opponents_remaining),(5,6))
        self.assertIs(restored.battle_complete,False);self.assertIsNone(restored.terminal_score)

    def test_real_revival_and_faint_are_signed_roster_changes(self):
        battle = self.battle();before = api.UniversalState.from_Battle(battle)
        revived = battle.team["5"];revived._status = None;revived.set_hp_status("50/100")
        after = api.UniversalState.from_Battle(battle)
        self.assertEqual(api.RosterShapedReward()(before,after),2.)
        battle.team["4"].set_hp_status("0 fnt")
        self.assertEqual(api.RosterShapedReward()(after,api.UniversalState.from_Battle(battle)),-2.)

    def test_official_draw_is_half_credit_and_never_a_loss(self):
        battle = self.battle();before = api.UniversalState.from_Battle(battle)
        battle.finished=True;battle.won=False;battle.lost=False
        after=api.UniversalState.from_Battle(battle)
        self.assertEqual(terminal_result(battle,True),("DRAW",.5))
        self.assertEqual(api.RosterShapedReward()(before,after),100.)
        fake=SimpleNamespace(_mm_battle=SimpleNamespace(winner=decoder.Winner.TIE),won=False)
        self.assertFalse(decoder.MetamonBackendBattle.lost.fget(fake))

    def test_infrastructure_incomplete_has_no_outcome_target(self):
        for won,lost in ((None,None),(True,False),(False,False)):
            battle=SimpleNamespace(finished=True,won=won,lost=lost)
            self.assertEqual(terminal_result(battle,False),("INCOMPLETE",None))
        with self.assertRaises(ValueError):terminal_result(SimpleNamespace(finished=False),True)

    def test_legacy_missing_counts_and_bad_scores_fail_explicitly(self):
        battle=self.battle();before=api.UniversalState.from_Battle(battle)
        data=before.to_dict()
        for key in ("player_remaining","battle_complete","terminal_score"):data.pop(key)
        legacy=api.UniversalState.from_dict(data)
        self.assertIsNone(legacy.player_remaining)
        with self.assertRaises(ValueError):api.RosterShapedReward()(legacy,before)
        bad=copy.deepcopy(before);bad.battle_complete=True;bad.battle_won=True;bad.terminal_score=True
        with self.assertRaises(ValueError):api.RosterShapedReward()(before,bad)

    def test_session_writes_draw_and_incomplete_without_loss_labels(self):
        import lz4.frame
        for complete in (True,False):
            with self.subTest(complete=complete), tempfile.TemporaryDirectory() as directory:
                battle=self.battle();initial=api.UniversalState.from_Battle(battle).to_dict()
                battle.finished=True;battle.won=False;battle.lost=False
                session=object.__new__(Session)
                session.decoder=SimpleNamespace(terminal=complete,battle=battle)
                session.pending=None;session.states=[initial];session.actions=[0];session.retries=0
                session.hello={"game":"one","side":"p1","team_file":"fixture.txt","seed":1}
                session.out=Path(directory)/"worker";session.purpose="selfplay";session.spec=None
                session.policy=SimpleNamespace(capture_teacher=False,temperature=1.)
                battle.turn=1
                with patch.dict(sys.modules,{"metamon.interface":api}):
                    self.assertEqual(session.finish(),complete)
                path=next(session.out.rglob("*.json.lz4"))
                with lz4.frame.open(path,"rb") as stream:body=json.loads(stream.read())
                meta=json.loads(Path(str(path)+".meta").read_text())
                self.assertEqual(body["outcome"],"DRAW" if complete else "INCOMPLETE")
                self.assertEqual(body["terminal_score"],.5 if complete else None)
                self.assertEqual(body["complete"],complete)
                self.assertEqual(meta["training_eligible"],complete)
                self.assertIsNone(meta["won"])
                self.assertEqual(body["states"][-1]["player_remaining"],5)


if __name__ == "__main__":unittest.main()
