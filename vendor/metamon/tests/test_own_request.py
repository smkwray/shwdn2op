"""Private own identity resolves equal/unknown HP before replay state is exposed."""
import importlib.util
import json
import logging
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("own_request_decoder", ROOT/"vendor/metamon/metamon/env/metamon_battle.py")
decoder = importlib.util.module_from_spec(spec);sys.modules[spec.name] = decoder
spec.loader.exec_module(decoder)


def request(active=None, unknown=False):
    rows=[]
    for name,ability in (("Azumarill","hugepower"),("Zoroark-Hisui","illusion")):
        rows.append({"ident":"p1: "+name,"details":name+", L100",
            "condition":"300" if unknown and ability=="illusion" else "300/300",
            "ability":ability,"baseAbility":ability,"item":"","moves":["tackle"],"active":name==active})
    return {"side":{"id":"p1","pokemon":rows},"teamPreview":active is None}


class OwnRequest(unittest.TestCase):
    def test_equal_unknown_hp_lead_switch_drag_and_repeated_request(self):
        for kind,previous in (("switch",None),("switch","Azumarill"),("drag","Azumarill")):
            for unknown in (False,True):
                with self.subTest(kind=kind,unknown=unknown):
                    rule=decoder.OwnIllusion()
                    rule.rewrite(["","request",json.dumps(request(previous,unknown=unknown))])
                    self.assertEqual(rule.rewrite(["",kind,"p1a: Azumarill","Azumarill, L100","300/300"]),[])
                    damage=["","-damage","p1a: Azumarill","250/300"]
                    self.assertEqual(rule.rewrite(damage),[])
                    private=["","request",json.dumps(request("Zoroark-Hisui"))]
                    flushed=rule.rewrite(private)
                    self.assertEqual(flushed[0][2:4],["p1a: Zoroark-Hisui","Zoroark-Hisui, L100"])
                    self.assertEqual(flushed[1][2],"p1a: Zoroark-Hisui")
                    self.assertEqual(rule.rewrite(private),[private])
                    opponent=["","-damage","p2a: Azumarill","50/100"]
                    self.assertEqual(rule.rewrite(opponent),[opponent])

    def test_explicit_reveal_flushes_without_waiting_or_double_replace(self):
        rule=decoder.OwnIllusion();rule.rewrite(["","request",json.dumps(request())])
        rule.rewrite(["","switch","p1a: Azumarill","Azumarill, L100","300/300"])
        rows=rule.rewrite(["","replace","p1a: Zoroark-Hisui","Zoroark-Hisui, L100","300/300"])
        self.assertEqual(len(rows),1);self.assertEqual(rows[0][2],"p1a: Zoroark-Hisui")
        self.assertIsNone(rule.disguise);self.assertFalse(rule.pending)

    def test_unresolved_history_fails_instead_of_guessing(self):
        for tail in (["","drag","p1a: Azumarill","Azumarill, L100","300/300"],["","tie"]):
            rule=decoder.OwnIllusion();rule.rewrite(["","request",json.dumps(request())])
            rule.rewrite(["","switch","p1a: Azumarill","Azumarill, L100","300/300"])
            with self.assertRaisesRegex(ValueError,"Unresolved own switch"):rule.rewrite(tail)

    def battle(self):
        b=decoder.MetamonBackendBattle("battle-gen9uu-test","Offline p1",logging.getLogger("test"),False,9)
        for line in ("|player|p1|Offline p1","|player|p2|Offline p2","|gametype|singles","|gen|9","|tier|[Gen 9] UU"):
            b.parse_message(line.split("|"))
        b.parse_request(request())
        for line in ("|start|","|switch|p2a: Ditto|Ditto, L100|100/100",
                     "|switch|p1a: Azumarill|Azumarill, L100|300/300","|-damage|p1a: Azumarill|250/300"):
            b.parse_message(line.split("|"))
        return b

    def test_actual_parser_reconciles_before_private_observation_idempotently(self):
        b=self.battle();q=request("Zoroark-Hisui");q["side"]["pokemon"][1]["condition"]="250/300"
        b.parse_request(q);b.parse_request(q)
        self.assertEqual(b.active_pokemon.species,"zoroarkhisui")
        self.assertEqual(b.active_pokemon.current_hp,250)
        self.assertEqual(next(p for p in b.team.values() if p.species=="azumarill").current_hp,300)
        self.assertFalse(b._own_illusion.pending)

    def test_private_revival_clears_persistent_faint_status(self):
        b=self.battle();dead=request("Azumarill");dead["side"]["pokemon"][1]["condition"]="0 fnt"
        dead["side"]["pokemon"][0]["reviving"]=True;dead["forceSwitch"]=[True];b.parse_request(dead)
        self.assertTrue(next(p for p in b.team.values() if p.species=="zoroarkhisui").fainted)
        self.assertEqual([p.species for p in b.available_switches],["zoroarkhisui"])
        alive=request("Azumarill");alive["side"]["pokemon"][1]["condition"]="50/300";b.parse_request(alive)
        revived=next(p for p in b.team.values() if p.species=="zoroarkhisui")
        self.assertFalse(revived.fainted);self.assertEqual(revived.current_hp,50)


if __name__ == "__main__":unittest.main()
