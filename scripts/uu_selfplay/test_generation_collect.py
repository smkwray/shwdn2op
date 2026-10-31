"""Generation admission must prove source, throughput and every closed POV."""
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import generation_collect as program
from generation_collect import BASE_SHA, block_name, completed_run, generation_members, qualification


class CollectionTests(unittest.TestCase):
    def variant_fixture(self, root):
        first,second,progress,reserved = (x*64 for x in "abcd")
        rows = []
        for name,family,variant in (("a",first,"e"),("b",first,"e"),("c",first,"f"),("d",second,"1")):
            path = root/f"teams/uu_train_v1/{name}.txt"
            path.parent.mkdir(parents=True,exist_ok=True);path.write_text(name)
            rows.append({"family_sha256":family,"split":"train","file":str(path.relative_to(root)),
                "validation":{"status":"valid"},"canonical_set_sha256":variant*64,
                "team_sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
        rows.extend([{"family_sha256":first,"split":"train","validation":{"status":"dropped"}},
            {"family_sha256":reserved,"split":"held-out","file":"NEVER_OPEN_THIS"},
            {"family_sha256":progress,"split":"train","file":"NEVER_OPEN_PROGRESS"}])
        manifest = root/"manifest.json";manifest.write_text(json.dumps({"teams":rows}))
        panel = {"poolManifestSha256":hashlib.sha256(manifest.read_bytes()).hexdigest(),
            "collection":[{"family":first},{"family":second}],"progress":[{"family":progress}],
            "excludedCertificationFamilies":[reserved],"certification":False}
        return panel,rows

    def test_collection_rotates_sets_without_changing_families_or_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);panel,_ = self.variant_fixture(root);original = json.dumps(panel,sort_keys=True)
            outputs = [program.collection_panel(root,panel,42,i) for i in range(2)]
            self.assertEqual({r["source"] for p in outputs for r in p["collection"] if r["family"]=="a"*64},
                {"teams/uu_train_v1/a.txt","teams/uu_train_v1/c.txt"})
            for p in outputs:
                self.assertEqual([r["family"] for r in p["collection"]],[r["family"] for r in panel["collection"]])
                self.assertEqual(p["progress"],panel["progress"])
                self.assertEqual(p["excludedCertificationFamilies"],panel["excludedCertificationFamilies"])
                self.assertEqual(p["collectionVariantSelection"]["canonicalVariants"],3)
                self.assertEqual(p["collectionVariantSelection"]["duplicateCanonicalRows"],1)
                self.assertEqual(p["collectionVariantSelection"]["unavailableRows"],1)
                for row in p["collection"]:
                    self.assertEqual(row["sha256"],hashlib.sha256((root/row["source"]).read_bytes()).hexdigest())
            self.assertEqual(outputs[0],program.collection_panel(root,panel,42,0))
            self.assertEqual(original,json.dumps(panel,sort_keys=True))

    def test_collection_rejects_manifest_drift_and_team_bytes_changed_after_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);panel,_ = self.variant_fixture(root)
            for path in (root/"teams/uu_train_v1/a.txt",root/"teams/uu_train_v1/c.txt"):
                path.write_text("changed")
            with self.assertRaisesRegex(ValueError,"hash"):
                program.collection_panel(root,panel,42,0)
            (root/"manifest.json").write_text("{}")
            with self.assertRaisesRegex(ValueError,"manifest"):
                program.collection_panel(root,panel,42,0)

    def test_collection_never_opens_reserved_paths_or_accepts_incomplete_required_metadata(self):
        for mutation in ("reserved_family","reserved_path","missing_hash","missing_file"):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp);panel,rows = self.variant_fixture(root)
                if mutation=="reserved_family":panel["collection"][0]["family"]="d"*64
                elif mutation=="reserved_path":rows[0]["file"]="teams/held_out_v1/DO_NOT_OPEN.txt"
                elif mutation=="missing_hash":rows[0].pop("team_sha256")
                else:rows[0].pop("file")
                manifest = root/"manifest.json";manifest.write_text(json.dumps({"teams":rows}))
                panel["poolManifestSha256"]=hashlib.sha256(manifest.read_bytes()).hexdigest()
                with self.assertRaises(ValueError):program.collection_panel(root,panel,42,0)

    def test_production_entry_passes_the_derived_panel_to_the_qualified_collector(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);panel,_ = self.variant_fixture(root)
            original = root/"panel.json";original.write_text(json.dumps(panel));before=original.read_bytes()
            qualified = root/"qualified";qualified.mkdir()
            for name in ("status.json","producer.json"):(qualified/name).write_text("{}")
            out = root/"generation";inspected=[]
            def run(argv,**kwargs):
                if any(Path(x).name=="batch_collect.py" for x in argv):
                    passed = Path(argv[argv.index("--panel")+1]);inspected.append(passed)
                    self.assertNotEqual(passed,out/"panel.json")
                    derived = json.loads(passed.read_text())
                    self.assertEqual(derived["collectionVariantSelection"]["canonicalVariants"],3)
                    self.assertEqual(derived["progress"],panel["progress"])
                    raise RuntimeError("inspected production collector panel")
                receipt = Path(argv[argv.index("--receipt")+1]);receipt.write_text("{}")
                return SimpleNamespace(returncode=0)
            arguments = ["generation_collect","--qualified",str(qualified),"--policies",str(root/"policies.json"),
                "--focal","G1","--checkpoint",str(root/"base.pt"),"--source",str(root/"source"),
                "--pool",str(root),"--panel",str(original),"--out",str(out),"--games","64",
                "--block-games","64","--seed","42"]
            with patch("sys.argv",arguments),patch.object(program,"qualification",return_value={
                    "selected":{"workers":1,"concurrency":1},"targetGamesPerHour":3000}),patch.object(
                    program,"generation_members",return_value=[{"name":"G0","sha256":BASE_SHA},
                    {"name":"G1","path":"candidate.pt","sha256":"a"*64}]),patch.object(
                    program,"blockers",return_value=[]),patch("psutil.virtual_memory",return_value=SimpleNamespace(
                    available=2**50)),patch.object(program.subprocess,"run",side_effect=run):
                with self.assertRaisesRegex(RuntimeError,"inspected production collector panel"):program.main()
            self.assertEqual(len(inspected),1)
            self.assertEqual(original.read_bytes(),before)

    def test_legacy_or_qualification_weights_cannot_enter_the_new_generation_league(self):
        with tempfile.TemporaryDirectory() as tmp:
            checkpoint = Path(tmp)/"policy.pt"
            receipt = Path(str(checkpoint)+".receipt.json")
            base = {"name":"G0","sha256":BASE_SHA}
            candidate = {"name":"G1","sha256":"a"*64,"path":str(checkpoint)}
            valid = {"training_eligible":True,"training_identity_sha256":"b"*64}
            with patch("generation_collect.policy_members",return_value=[base,candidate]):
                receipt.write_text(json.dumps(valid));self.assertEqual(len(generation_members(None,None)),2)
                for data in ({},{**valid,"training_eligible":False},{**valid,"training_identity_sha256":"unbound"}):
                    receipt.write_text(json.dumps(data))
                    with self.subTest(data=data),self.assertRaises(ValueError):generation_members(None,None)
            with patch("generation_collect.policy_members",return_value=[{**base,"sha256":"a"*64}]):
                with self.assertRaisesRegex(ValueError,"incumbent bytes"):generation_members(None,None)

    def test_blocks_with_restarted_native_game_ids_remain_distinct_across_generations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = block_name(root/"g1/collection","data-0000")
            second = block_name(root/"g2/collection","data-0000")
            self.assertNotEqual((first,"game-0000000"),(second,"game-0000000"))
            self.assertEqual(first,block_name(root/"g1/collection","data-0000"))
            self.assertNotEqual(first,block_name(root/"g1/collection","data-0001"))
            for name in ("NUL","con","LPT1","ends."):
                with self.subTest(name=name),self.assertRaises(ValueError):block_name(root/name,"data-0000")

    def test_source_and_real_throughput_are_required_in_addition_to_qualified_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);source = root/"runtime/worker.py";source.parent.mkdir();source.write_bytes(b"synthetic producer")
            (root/"producer.json").write_text(json.dumps({str(source):hashlib.sha256(source.read_bytes()).hexdigest()}))
            state = {"phase":"QUALIFIED","targetMet":True,"gamesPerHour":4000,"targetGamesPerHour":3000,
                     "selected":{"workers":4,"concurrency":16}}
            path = root/"status.json"
            path.write_text(json.dumps(state));self.assertEqual(qualification(root),state)
            for patch in ({"phase":"WAIT_RESOURCE"},{"targetMet":False},{"gamesPerHour":2999}):
                path.write_text(json.dumps({**state,**patch}))
                with self.subTest(patch=patch),self.assertRaises(ValueError):qualification(root)
            path.write_text(json.dumps(state));source.write_bytes(b"changed producer")
            with self.assertRaisesRegex(ValueError,"producer drift"):qualification(root)

    def test_completed_games_cannot_hide_missing_or_undrained_povs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);(root/"server").mkdir()
            rate = {"startedGames":8,"completed":8,"failed":0,"exitCodes":[0,0]}
            stats = {"completedPOVs":16,"failedPOVs":0,"active":0}
            (root/"throughput.json").write_text(json.dumps(rate))
            path = root/"server/collector-stats.json"
            path.write_text(json.dumps(stats));self.assertEqual(completed_run(root,8),rate)
            for patch in ({"completedPOVs":15},{"active":1},{"failedPOVs":1}):
                path.write_text(json.dumps({**stats,**patch}))
                with self.subTest(patch=patch),self.assertRaises(ValueError):completed_run(root,8)
            path.write_text(json.dumps(stats))
            (root/"throughput.json").write_text(json.dumps({**rate,"exitCodes":[0,-15]}))
            with self.assertRaises(ValueError):completed_run(root,8)


if __name__ == "__main__":
    unittest.main()
