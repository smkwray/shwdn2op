"""Both-player split isolation on the production frozen-pile filtering entry point."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import lz4.frame
from filter_families import family_map,roster_family,validate_training_data
from filter_families import install_manifest_allowlist,replay_score
from unittest.mock import patch


class FilterTests(unittest.TestCase):
    def test_native_constructor_uses_manifest_despite_extra_files_and_stale_index(self):
        from metamon.data.parsed_replay_dset import MetamonDataset
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);directory=root/'pile-0/UUKakuna/metamon';data=directory/'gen9uu'
            data.mkdir(parents=True)
            for name in ['approved.json','extra.json']:(data/name).write_text('{}')
            (directory/'index.csv').write_text('stale unapproved index')
            manifest=root/'manifest.json';manifest.write_text(json.dumps({'kept':[
                {'sourcePile':0,'file':'approved.json'}]}))
            original=MetamonDataset.refresh_files
            try:
                receipt=install_manifest_allowlist(manifest,[directory])
                dataset=MetamonDataset(str(directory),None,None,None,['gen9uu'],use_cached_filenames=True)
                self.assertEqual(dataset.filenames,[str((data/'approved.json').resolve())])
                self.assertFalse(receipt['cachedDirectoryIndexUsed'])
                for kwargs in [{'min_rating':1000},{'wins_losses_both':'wins'},{'split':'train'}]:
                    with self.assertRaises(ValueError):
                        MetamonDataset(str(directory),None,None,None,['gen9uu'],**kwargs)
                with self.assertRaises(ValueError):
                    MetamonDataset(str(root),None,None,None,['gen9uu'])
            finally:MetamonDataset.refresh_files=original

    def test_explicit_draw_reaches_native_loader_and_incomplete_cannot(self):
        from metamon.data.parsed_replay_dset import MetamonDataset
        from metamon.interface import UniversalState
        state={'battle_complete':True,'battle_won':False,'battle_lost':False,'terminal_score':.5}
        replay={'schema':'uu-native-replay@2','complete':True,'outcome':'DRAW','terminal_score':.5,
                'states':[state],'actions':[-1]}
        self.assertEqual(replay_score(replay),.5)
        dataset=object.__new__(MetamonDataset);dataset._load_json=lambda _:replay
        # Stop at native state construction: validates the real loader header gate without a network.
        with patch.object(UniversalState,'from_dict',side_effect=RuntimeError('accepted native header')):
            with self.assertRaisesRegex(RuntimeError,'accepted native header'):dataset.load_filename('fixture')
            replay['complete']=False
            with self.assertRaises(ValueError):dataset.load_filename('fixture')
            replay['complete']=True;replay['terminal_score']=0
            with self.assertRaises(ValueError):dataset.load_filename('fixture')
        self.assertIsNone(replay_score({'states':[{'battle_won':False,'battle_lost':False}]}))

    def test_form_collapse_cannot_admit_a_reserved_family(self):
        catalog = json.dumps({"families":[{"sha256":"train","key":"A|B|C|D|E|F"},
            {"sha256":"test","key":"A-form|B|C|D|E|F"}]}).encode()
        panel = {"poolManifestSha256":hashlib.sha256(catalog).hexdigest(),
                 "collection":[{"family":"train"}],"progress":[],"excludedCertificationFamilies":["test"]}
        mapping,allowed = family_map(catalog,panel,lambda s:s.split("-")[0].lower())
        state = {"player_active_pokemon":{"base_species":"a"},
                 "available_switches":[{"base_species":c} for c in "bcdef"]}
        self.assertEqual(roster_family(state,mapping,allowed),(None,"unknown_or_ambiguous_family"))

    def test_cli_excludes_reserved_opponent_and_unpaired_and_preserves_hash_failure(self):
        teams = [["Pikachu","Charizard","Blastoise","Venusaur","Snorlax","Gengar"],
            ["Eevee","Vaporeon","Jolteon","Flareon","Espeon","Umbreon"],
            ["Mew","Dragonite","Metagross","Latias","Salamence","Scizor"]]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);pool = root/"pool.json"
            pool.write_text(json.dumps({"families":[{"sha256":str(i),"key":"|".join(t)} for i,t in enumerate(teams)]}))
            panel = root/"panel.json";panel.write_text(json.dumps({"schema":"uu-progress-panel@1","certification":False,
                "poolManifestSha256":hashlib.sha256(pool.read_bytes()).hexdigest(),
                "collection":[{"family":"0"},{"family":"1"}],"progress":[{"family":"2"}],"excludedCertificationFamilies":[]}))
            pile = root/"pile";data = pile/"UUKakuna/metamon/gen9uu";data.mkdir(parents=True)
            kept = []
            for game,pair in enumerate(((0,1),(0,2),(0,))):
                for side,team in enumerate(pair):
                    mons = [{"base_species":s.lower()} for s in teams[team]]
                    state = {"player_active_pokemon":mons[0],"available_switches":mons[1:]}
                    terminal = {**state,"battle_won":side==0,"battle_lost":side!=0}
                    content = lz4.frame.compress(json.dumps({"states":[state,terminal],"actions":[0,-1]}).encode())
                    name = f"g{game}-p{side}.json.lz4";(data/name).write_bytes(content)
                    (data/(name+".meta")).write_text("{}")
                    kept.append({"file":name,"sha256":hashlib.sha256(content).hexdigest(),
                                 "block":"block","battle_tag":str(game),"player":str(side)})
            (pile/"manifest.json").write_text(json.dumps({"trajectories":len(kept),"kept":kept}))
            command = [sys.executable,str(Path(__file__).with_name("filter_families.py")),"--piles",str(pile),
                       "--panel",str(panel),"--pool-manifest",str(pool),"--out"]
            run = subprocess.run([*command,str(root/"filtered")],capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr)
            report = json.loads((root/"filtered/manifest.json").read_text())
            self.assertEqual(report["trajectories"],2)
            self.assertEqual(report["excluded"],{"reserved_family":1,"unpaired_or_duplicate_pov":1})
            self.assertTrue(report["complete"])
            manifest_path = root/"filtered/manifest.json"
            directory = root/"filtered/pile-0/UUKakuna/metamon"
            verified = validate_training_data(manifest_path,panel,[directory])
            self.assertEqual(sum(verified["verifiedPOVs"].values()),2)
            reserve = root/'reserve.json'
            reserve.write_text(json.dumps({'complete':True,'reservedFromFutureTraining':True,'povs':2,
                'inputs':[{'sha256':row['sha256']} for row in kept[:2]],'battles':[{'povIndexes':[0,1]}]}))
            reserve_sha = hashlib.sha256(reserve.read_bytes()).hexdigest()
            run = subprocess.run([*command,str(root/'reserved'),'--reserved-manifest',str(reserve),
                '--reserved-manifest-sha256',reserve_sha],capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr)
            blocked = json.loads((root/'reserved/manifest.json').read_bytes())
            self.assertEqual(blocked['trajectories'],0)
            # These fixtures repeat an identical POV across three games. Every
            # matching payload excludes its whole battle, conservatively.
            self.assertEqual(blocked['excluded']['reserved_diagnostic_battle'],3)
            report['reservedDiagnostics'] = blocked['reservedDiagnostics']
            manifest_path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError,'Reserved diagnostic'):
                validate_training_data(manifest_path,panel,[directory])
            report.pop('reservedDiagnostics')
            run = subprocess.run([*command,str(root/'bad-reserve'),'--reserved-manifest',str(reserve),
                '--reserved-manifest-sha256','0'*64],capture_output=True,text=True)
            self.assertNotEqual(run.returncode,0)
            report["kept"][0]["opponent_family"] = "2"
            manifest_path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError,"family"):validate_training_data(manifest_path,panel,[directory])
            report["kept"][0]["opponent_family"] = "1"
            report["qualificationOnly"] = True
            manifest_path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError,"qualification"):validate_training_data(manifest_path,panel,[directory])
            (data/kept[0]["file"]).write_bytes(b"changed")
            run = subprocess.run([*command,str(root/"failed")],capture_output=True,text=True)
            self.assertNotEqual(run.returncode,0)
            self.assertEqual(json.loads((root/"failed/status.json").read_text())["phase"],"FAILED")
            self.assertFalse((root/"failed/manifest.json").exists())


if __name__=="__main__":unittest.main()
