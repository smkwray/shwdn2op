#!/usr/bin/env python3
"""Candidate-only checkpoint gate around the immutable production JSONL worker.

Use the PRODUCTION PYTHONPATH/runtime, not the training source overlay.
Original check_runtime is called on --base-checkpoint: all original filename,
byte count, hash, package version/VCS and cache pins remain mandatory. Only this
module's private worker instance substitutes the candidate checkpoint gate.
KakunaPolicy construction, attention, parser, sampling and commits are unchanged.
--policy-id is launch provenance (the v2 wire has no policy ID field).
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

from export_candidate import BASE_SHA, check_format, digest

WORKER = Path(__file__).resolve().parents[1] / "metamon-worker.py"
WORKER_SHA = "917558eddf56e58dd1cd05332974df11d937549542fc4bc3674c8323d05ab5e9"


def policy_members(path, base):
    """Read the existing name/path/epoch/SHA member schema with actor IDs."""
    base = Path(base).resolve()
    if digest(base)!=BASE_SHA:
        raise ValueError("Baseline must be the byte-pinned epoch-34 checkpoint")
    members = json.loads(Path(path).read_text()) if path else [
        {"name":"G0","path":str(base),"epoch":34,"sha256":BASE_SHA,"policyId":"metamon:Kakuna:epoch34"}]
    return validate_members(members, base)


def validate_members(members, base):
    if not isinstance(members,list) or not members:
        raise ValueError("Nonempty policy member list required")
    names,identities = set(),{}
    for member in members:
        name = member["name"]
        if (not re.fullmatch(r"[A-Za-z0-9_-]+",name) or name.casefold() in names
                or re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]",name,re.IGNORECASE)):
            raise ValueError("Unique portable policy names required")
        names.add(name.casefold())
        if type(member["epoch"]) is not int or member["epoch"]<0:
            raise ValueError("Nonnegative integer policy epoch required")
        checkpoint = Path(member["path"]).resolve()
        if not re.fullmatch(r"[0-9a-f]{64}",member["sha256"]) or digest(checkpoint)!=member["sha256"]:
            raise ValueError("Policy member checkpoint hash mismatch")
        identity = member["policyId"]
        if member.get("sampler") not in (None,"e3_common"):
            raise ValueError("Unknown policy sampler")
        if member.get("kind") == "ensemble":
            if identity!="metamon:Ensemble:"+member["sha256"] or member["epoch"]!=0:
                raise ValueError("Ensemble manifest identity required")
            components = json.loads(checkpoint.read_text())
            if (not isinstance(components,list) or len(components)!=3
                    or components[0]["sha256"]!=BASE_SHA
                    or len({r["sha256"] for r in components})!=3):
                raise ValueError("Fixed ensemble needs e34 and two distinct checkpoints")
            declarations = []
            for i,row in enumerate(components):
                if set(row)!={"name","path","epoch","sha256"}:
                    raise ValueError("Checkpoint-only ensemble components required")
                run = Path(row["path"]).parents[2].name
                declarations.append({**row,"name":f"member_{i}","policyId":
                    "metamon:Kakuna:epoch34" if row["sha256"]==BASE_SHA else
                    f"metamon:UUFinetuned:{run}:{row['epoch']}"})
            member["members"] = validate_members(declarations, base)
        elif member.get("kind") not in (None,"checkpoint"):
            raise ValueError("Unknown policy kind")
        elif member["sha256"]==BASE_SHA:
            if identity!="metamon:Kakuna:epoch34" or member["epoch"]!=34:
                raise ValueError("Base weights require the incumbent identity")
        else:
            match = re.fullmatch(r"metamon:UUFinetuned:[A-Za-z0-9_-]+:([0-9]+)",identity)
            if not match or int(match[1])!=member["epoch"]:
                raise ValueError("Candidate identity/epoch mismatch")
            receipt = json.loads(Path(str(checkpoint)+".receipt.json").read_text())
            if receipt.get("training_eligible") is False:
                raise ValueError("Qualification weights are ineligible for the generation league or progress selection")
            if not (receipt["output_sha256"]==member["sha256"] and receipt["base_sha256"]==BASE_SHA
                    and receipt["epoch"]==member["epoch"] and receipt["output_tensors"]==642
                    and receipt["key_shape_dtype_check"] is True):
                raise ValueError("Canonical candidate export receipt required")
        if identity in identities and identities[identity]!=member["sha256"]:
            raise ValueError("One actor ID cannot name different weights")
        identities[identity] = member["sha256"]
        member["path"] = str(checkpoint)
    return members


def worker_module():
    if digest(WORKER) != WORKER_SHA:
        raise ValueError("Pinned production worker hash mismatch")
    spec = importlib.util.spec_from_file_location("pinned_candidate_worker", WORKER)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker


def checkpoint_members(members):
    """Enumerate exact neural assets once, including composite policies."""
    result = {}
    for member in members:
        rows = checkpoint_members(member["members"]) if member.get("kind")=="ensemble" else [member]
        for row in rows:
            result.setdefault(row["sha256"],row)
    return list(result.values())


def training_checkpoint_args(member):
    """Use the native iterative fine-tune CLI; require its canonical layout."""
    if member.get("kind")=="ensemble":
        raise ValueError("Ensemble policies require distillation before RL initialization")
    if member["sha256"]==BASE_SHA:return []
    path = Path(member["path"])
    if (path.name!=f"policy_epoch_{member['epoch']}.pt" or path.parent.name!="policy_weights"
            or path.parent.parent.name!="ckpts"):
        raise ValueError("Training export must use RUN/ckpts/policy_weights/policy_epoch_N.pt")
    return ["--prev_run_dir",str(path.parents[3]),"--prev_run_name",path.parents[2].name,
            "--prev_checkpoint",str(member["epoch"])]


def install(worker, checkpoint, declared_sha, base, policy_id, trace=None):
    if not re.fullmatch(r"[0-9a-f]{64}", declared_sha) or digest(checkpoint) != declared_sha:
        raise ValueError("Candidate requires a matching declared SHA256")
    if not re.fullmatch(r"metamon:UUFinetuned:[A-Za-z0-9_-]+:[0-9]+", policy_id):
        raise ValueError("Distinct UUFinetuned run:epoch policy ID required")
    original_runtime, original_init = worker.check_runtime, worker.KakunaPolicy.__init__

    def candidate_hash(path):
        worker.require(Path(path).resolve() == checkpoint.resolve() and digest(path) == declared_sha, "provenance")

    def runtime(path):
        original_runtime(base)  # Retain EVERY original asset/runtime pin.
        candidate_hash(path)
        import torch
        standard = torch.load(base, map_location="cpu", weights_only=True, mmap=True)
        candidate = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
        check_format(candidate, standard)
        worker.require(all(bool(torch.isfinite(v).all()) for v in candidate.values()), "provenance")

    def initialize(self, path, *args, **kwargs):
        candidate_hash(path)  # Recheck immediately before the standard strict load.
        original_init(self, path, *args, **kwargs)

    worker.check_runtime = runtime
    worker.KakunaPolicy.__init__ = initialize
    if trace is not None:
        # Optional passive observer: never changes a proposal, RNG draw or commit.
        propose, commit = worker.KakunaPolicy.propose, worker.KakunaPolicy.commit

        def traced_propose(self, *args):
            result = propose(self, *args)
            p = self.last_dist.probs[0, -1, -1].float().cpu()
            self.trace_row = {"step": self.step - 1, "probs": p.tolist(), "argmax": int(p.argmax()),
                              "legal": sorted({i for _, i in self.pending[1]}), "proposed_choice": result}
            return result

        def traced_commit(self, choice):
            row = {**self.trace_row, "committed_index": self.resolve_index(choice), "recorded_choice": choice}
            commit(self, choice)
            with trace.open("a") as stream:
                stream.write(json.dumps(row, allow_nan=False) + "\n")

        worker.KakunaPolicy.propose, worker.KakunaPolicy.commit = traced_propose, traced_commit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--checkpoint-sha256", required=True)
    parser.add_argument("--base-checkpoint", required=True, type=Path)
    parser.add_argument("--policy-id", required=True)
    parser.add_argument("--probability-trace", type=Path)
    args, remaining = parser.parse_known_args()
    if args.probability_trace and args.probability_trace.exists():
        raise ValueError("Refusing to append to an existing probability trace")
    worker = worker_module()
    install(worker, args.checkpoint, args.checkpoint_sha256, args.base_checkpoint,
            args.policy_id, args.probability_trace)
    print(json.dumps({"policy_id": args.policy_id, "checkpoint_sha256": args.checkpoint_sha256,
                      "worker_sha256": WORKER_SHA}), file=sys.stderr, flush=True)
    sys.argv = [str(WORKER), "--checkpoint", str(args.checkpoint), *remaining]
    return worker.main()


if __name__ == "__main__":
    sys.exit(main())
