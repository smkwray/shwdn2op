"""Export invariants and candidate gate; run with the prepared torch interpreter."""
import tempfile
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import torch

from export_candidate import check_format, verify_export, source_key
from candidate_worker import install, policy_members, training_checkpoint_args
from export_candidate import BASE_SHA, digest


class ExportTests(unittest.TestCase):
    def test_soft_student_can_only_select_the_fixed_final_completed_checkpoint(self):
        from export_candidate import training_eligible
        identity={"purpose":"generation","dataProof":{"manifest":"bound"},
                  "softPolicy":{"updates":4000,"finalEpoch":3}}
        self.assertFalse(training_eligible(identity,2,{"updates":3000}))
        self.assertFalse(training_eligible(identity,3,{"updates":3999}))
        self.assertFalse(training_eligible(identity,3))
        self.assertTrue(training_eligible(identity,3,{"updates":4000}))
        self.assertFalse(training_eligible({**identity,"purpose":"qualification"},3,{"updates":4000}))

    def setUp(self):
        # Small synthetic tensors, real 642-key invariant; deliberately different EMA.
        self.base = {f"actor.w{i}": torch.zeros(1) for i in range(642)}
        self.parameters = set(self.base)
        self.raw = {k: torch.ones(1) for k in self.base}
        self.raw.update({source_key(k, self.parameters): torch.full((1,), 2.) for k in self.base})
        self.promoted = {k: self.raw[source_key(k, self.parameters)].clone() for k in self.base}

    def test_promoted_export(self):
        mapping = verify_export(self.promoted, self.raw, self.promoted, self.base, self.parameters)
        self.assertTrue(all(m["kind"] == "EMA" for m in mapping.values()))
        self.assertEqual(source_key("target_actor.w", {"target_actor.w"}), "_tortoise_actor.w")
        self.assertEqual(source_key("maximized_critics.w", {"maximized_critics.w"}), "_tortoise_critics.w")
        self.assertEqual(source_key("popart.mu", set()), "popart.mu")

    def test_raw_buffers_must_stay_raw(self):
        key = "actor.w0"
        self.parameters.remove(key)
        self.promoted[key] = self.raw[key]
        mapping = verify_export(self.promoted, self.raw, self.promoted, self.base, self.parameters)
        self.assertEqual(mapping[key]["kind"], "raw")
        wrong = {**self.promoted, key: self.raw["_tortoise_" + key]}
        with self.assertRaisesRegex(ValueError, "registry-promoted"):
            verify_export(wrong, self.raw, self.promoted, self.base, self.parameters)

    def test_raw_export_must_fail(self):
        raw_export = {k: self.raw[k] for k in self.base}
        with self.assertRaisesRegex(ValueError, "registry-promoted"):
            verify_export(raw_export, self.raw, self.promoted, self.base, self.parameters)

    def test_promotion_itself_must_match_ema(self):
        raw_export = {k: self.raw[k] for k in self.base}
        with self.assertRaisesRegex(ValueError, "EMA promotion"):
            verify_export(raw_export, self.raw, raw_export, self.base, self.parameters)

    def test_key_shape_dtype_drift_must_fail(self):
        for mutation in (lambda d: d.pop("actor.w0"),
                         lambda d: d.update({"actor.w0": torch.zeros(2)}),
                         lambda d: d.update({"actor.w0": torch.zeros(1, dtype=torch.float64)})):
            state = dict(self.promoted)
            mutation(state)
            with self.assertRaises(ValueError):
                check_format(state, self.base)

    def test_missing_or_wrong_hash_must_fail_before_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.pt"
            path.write_bytes(b"not a checkpoint")
            for declared in ("", "0" * 64):
                worker = Mock()
                with self.assertRaisesRegex(ValueError, "declared SHA256"):
                    install(worker, path, declared, path, "metamon:UUFinetuned:smoke:0")
                worker.check_runtime.assert_not_called()


class LeagueMemberTests(unittest.TestCase):
    def test_neural_qualification_expands_the_ensemble_and_deduplicates_the_baseline(self):
        from candidate_worker import checkpoint_members
        base={"name":"G0","path":"base.pt","sha256":BASE_SHA}
        first={"name":"one","path":"one.pt","sha256":"a"*64}
        second={"name":"two","path":"two.pt","sha256":"b"*64}
        ensemble={"name":"E3","kind":"ensemble","path":"not_a_torch_checkpoint.json",
                  "sha256":"c"*64,"members":[base,first,second]}
        self.assertEqual(checkpoint_members([base,ensemble]),[base,first,second])

    def test_ensemble_binds_manifest_and_every_component_and_cannot_seed_rl(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root/"base.pt";base.write_bytes(b"base")
            components = [{"name":"e34","path":str(base),"epoch":34,"sha256":BASE_SHA}]
            for i in (1,2):
                path=root/f"candidate{i}/ckpts/policy_weights/policy_epoch_{i}.pt"
                path.parent.mkdir(parents=True);path.write_bytes(bytes([i]))
                components.append({"name":f"candidate {i}","path":str(path),"epoch":i,"sha256":digest(path)})
                Path(str(path)+".receipt.json").write_text(json.dumps({"output_sha256":digest(path),
                    "base_sha256":BASE_SHA,"epoch":i,"output_tensors":642,"key_shape_dtype_check":True}))
            source=root/"ensemble.json";source.write_text(json.dumps(components))
            row={"name":"E3","kind":"ensemble","path":str(source),"epoch":0,
                 "sha256":digest(source),"policyId":"metamon:Ensemble:"+digest(source)}
            manifest=root/"policies.json";manifest.write_text(json.dumps([row]))
            actual_digest=digest
            with patch("candidate_worker.digest",side_effect=lambda p:BASE_SHA if Path(p).resolve()==base.resolve() else actual_digest(p)):
                result=policy_members(manifest,base)[0]
                self.assertEqual([r["sha256"] for r in result["members"]],[r["sha256"] for r in components])
                with self.assertRaisesRegex(ValueError,"Ensemble"):
                    training_checkpoint_args(result)
                Path(components[1]["path"]).write_bytes(b"drift")
                with self.assertRaisesRegex(ValueError,"hash"):
                    policy_members(manifest,base)
                source.write_text("[]")
                with self.assertRaisesRegex(ValueError,"hash"):
                    policy_members(manifest,base)

    def test_training_uses_declared_prior_generation_in_native_cli(self):
        self.assertEqual(training_checkpoint_args({"sha256":BASE_SHA}),[])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"G1/ckpts/policy_weights/policy_epoch_3.pt"
            member = {"path":str(path),"sha256":"new","epoch":3}
            from argparse import ArgumentParser
            from metamon.rl.finetune import add_cli, _resolve_checkpoint_path
            parser = ArgumentParser();add_cli(parser)
            arguments = parser.parse_args(["--run_name","G2","--save_dir",directory,
                "--base_model","UUKakuna","--base_checkpoint","34","--dataset_config","fixture.yaml",
                *training_checkpoint_args(member)])
            self.assertEqual(Path(_resolve_checkpoint_path(arguments,Mock())),path)
            with self.assertRaisesRegex(ValueError,"canonical|layout|Training export"):
                training_checkpoint_args({**member,"path":str(path.with_name("arbitrary.pt"))})

    def test_members_bind_exact_bytes_epoch_actor_and_canonical_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root/"base.pt";base.write_bytes(b"baseline fixture")
            candidate = root/"candidate.pt";candidate.write_bytes(b"candidate fixture")
            declaration = {"name":"G1","path":str(candidate),"epoch":1,
                "sha256":digest(candidate),"policyId":"metamon:UUFinetuned:test:1"}
            receipt = {"output_sha256":declaration["sha256"],"base_sha256":BASE_SHA,
                "epoch":1,"output_tensors":642,"key_shape_dtype_check":True}
            manifest = root/"members.json"
            proof = Path(str(candidate)+".receipt.json")
            manifest.write_text(json.dumps([declaration]));proof.write_text(json.dumps(receipt))
            actual_digest = digest
            with patch("candidate_worker.digest",side_effect=lambda p:BASE_SHA if Path(p).resolve()==base.resolve() else actual_digest(p)):
                self.assertEqual(policy_members(manifest,base)[0]["policyId"],declaration["policyId"])
                for key,value in (("name","CON"),("epoch",True),("epoch",2),
                                  ("sha256","0"*64),("policyId","metamon:Kakuna:epoch34")):
                    manifest.write_text(json.dumps([{**declaration,key:value}]))
                    with self.subTest(key=key,value=value),self.assertRaises(ValueError):policy_members(manifest,base)
                manifest.write_text(json.dumps([declaration,{**declaration,"name":"g1"}]))
                with self.assertRaises(ValueError):policy_members(manifest,base)
                manifest.write_text(json.dumps([declaration]))
                proof.write_text(json.dumps({**receipt,"base_sha256":"0"*64}))
                with self.assertRaises(ValueError):policy_members(manifest,base)
                proof.write_text(json.dumps({**receipt,"training_eligible":False}))
                with self.assertRaisesRegex(ValueError,"Qualification"):policy_members(manifest,base)

    def test_missing_baseline_pin_and_empty_league_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);base=root/"base.pt";base.write_bytes(b"bad base")
            manifest=root/"members.json";manifest.write_text("[]")
            with self.assertRaises(ValueError):policy_members(manifest,base)
            with patch("candidate_worker.digest",return_value=BASE_SHA):
                with self.assertRaises(ValueError):policy_members(manifest,base)


if __name__ == "__main__":
    unittest.main()
