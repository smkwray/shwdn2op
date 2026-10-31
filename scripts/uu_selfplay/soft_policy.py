"""Causal E3 targets in native replays and a critic-free anchored actor loss."""
import hashlib
import json
import math
from pathlib import Path
import re

import torch


def bound_json(reference):
    payload = Path(reference["path"]).read_bytes()
    if hashlib.sha256(payload).hexdigest()!=reference["sha256"]:
        raise ValueError("Soft training qualification proof drift")
    return json.loads(payload)


def qualified_collection(reference, teacher, members):
    qualification = bound_json(reference)
    if "native" not in reference:
        return (qualification.get("phase")=="QUALIFIED" and qualification.get("targetMet") is True
                and qualification.get("cpuReferenceQualified") is True
                and qualification.get("focalPolicyId")==teacher)
    native = reference["native"]
    registration = bound_json(native["registration"])
    cpu = bound_json(native["cpuReference"])
    config = bound_json(native["teacherConfig"])
    if (qualification.get("phase")!="PASS" or qualification.get("qualificationOnly") is not True
            or qualification.get("trainingEligible") is not False
            or registration["targetGamesPerHour"]<1000
            or qualification["targetGamesPerHour"]!=registration["targetGamesPerHour"]
            or qualification["sustainedGamesPerHour"]<registration["targetGamesPerHour"]
            or qualification["teacherReusedForwardCoverage"]<1
            or native["cpuReference"]["sha256"]!=registration["mlxRevivalParity"]["sha256"]
            or cpu.get("pass") is not True or cpu.get("commonCDFChoicesEqual") is not True
            or cpu["decisions"]<150 or cpu["revivalInputs"]<1
            or config["policyId"]!=teacher or [r["sha256"] for r in config["members"]]!=members):
        return False
    rows = qualification["results"]
    scales = registration["scales"]
    if len(rows)<=len(scales) or any(row["block"]!=scale["block"]
            or row["requestedGames"]!=scale["games"] or row["workers"]!=scale["workers"]
            for row,scale in zip(rows,scales)):
        return False
    for index,row in enumerate(rows):
        life = row["lifecycle"]
        if row["status"]!="PASS":
            if (index>=len(scales) or not scales[index].get("resource_optional")
                    or row["status"]!="FAILED_RESOURCE_SCALE_RETAINED"
                    or life["reason"] not in ("memory_available","memory_pressure")
                    or life["ownedProcessesAfter"] or life["port8000ListeningAfter"]):
                return False
            continue
        replay = bound_json(native["replays"][row["block"]])
        if (row["returncode"]!=0 or life["reason"]!="completed"
                or life["games"]!=row["requestedGames"] or life["validation_clean"] is not True
                or life["ownedProcessesAfter"] or life["port8000ListeningAfter"]
                or replay.get("pass") is not True or replay["games"]!=life["games"]
                or row["inputAudit"].get("pass") is not True or row["inputAudit"]["files"]<1):
            return False
    sustained = rows[len(scales):]
    workers = {"twoActorAlternating":2,"fourActorMixed":4}.get(qualification["selected"])
    games = sum(r["lifecycle"]["games"] for r in sustained)
    seconds = sum(r["lifecycle"]["elapsed_s"] for r in sustained)
    return (workers is not None and all(r["status"]=="PASS" and r["workers"]==workers for r in sustained)
            and games==registration["sustainedGames"] and games>=512 and seconds>0
            and math.isclose(games*3600/seconds,qualification["sustainedGamesPerHour"],rel_tol=1e-10))


def training_plan(path, manifest_path, purpose, directories=None):
    from export_candidate import BASE_SHA
    plan = json.loads(Path(path).read_text())
    content = Path(manifest_path).read_bytes()
    manifest = json.loads(content)
    teacher_rows = [row for row in manifest["kept"] if row["model"]==plan["teacherName"]]
    expected_directories = {(Path(manifest_path).parent/f"pile-{row['sourcePile']}/UUKakuna/metamon").resolve()
                            for row in teacher_rows}
    if directories is not None and {Path(p).resolve() for p in directories}!=expected_directories:
        raise ValueError("Training recipe must include every qualified teacher stratum")
    if (plan.get("schema")!="uu-soft-training@1" or
            hashlib.sha256(content).hexdigest()!=plan["dataManifestSha256"] or
            not re.fullmatch(r"metamon:Ensemble:[0-9a-f]{64}",plan["teacherId"]) or
            len(plan["members"])!=3 or plan["members"][0]!=BASE_SHA or
            any(not re.fullmatch(r"[0-9a-f]{64}",s) for s in plan["members"]) or
            not math.isfinite(plan["anchorWeight"]) or not 0<=plan["anchorWeight"]<=1 or
            type(plan["updates"]) is not int or plan["updates"]<1 or
            type(plan["finalEpoch"]) is not int or plan["finalEpoch"]<0):
        raise ValueError("Malformed or drifted fixed soft-training plan")
    def proof(key):
        return bound_json(plan[key])
    audit = proof("inputAudit")
    context = plan["context"]
    if (context.get("mode")!="initial_prefix" or type(context.get("maxDecisions")) is not int
            or context["maxDecisions"]<1 or audit.get("context",{}).get("mode")!=context["mode"]
            or audit["context"]["maxDecisions"]!=context["maxDecisions"]
            or audit["context"]["includedDecisions"]+audit["context"]["outsidePrefixExcluded"]!=audit["decisions"]):
        raise ValueError("Explicit initial-prefix teacher context and complete exclusion counts required")
    if (audit.get("complete") is not True or audit["teacher"]!=plan["teacherId"] or
            audit["members"]!=plan["members"] or audit["inputMismatchFiles"]!=0 or
            audit["files"]!=len(teacher_rows) or
            audit["proof"]["manifestSha256"]!=plan["dataManifestSha256"]):
        raise ValueError("Complete exact-input teacher audit required")
    if purpose=="generation":
        if (not qualified_collection(plan["collectionQualification"],plan["teacherId"],plan["members"]) or
                len({(r["block"],r["battle_tag"]) for r in teacher_rows})<plan["minimumBattles"] or
                plan["minimumBattles"]<20000):
            raise ValueError("Qualified teacher and at least 20000 frozen battles required")
    return plan


def input_digest(obs, rl2s, time_idxs):
    values = {**{"obs/" + k: v for k, v in obs.items()}, "rl2s": rl2s, "time_idxs": time_idxs}
    digest = hashlib.sha256()
    for name, value in sorted(values.items()):
        if tuple(value.shape[:2]) != (1, 1):
            raise ValueError("One exact causal decision input required")
        array = value.detach().cpu()[0, 0].contiguous().numpy()
        digest.update(json.dumps([name, array.dtype.str, array.shape], separators=(",", ":")).encode())
        digest.update(array.tobytes())
    return digest.hexdigest()


def capture_inputs(inputs):
    return {"sha256": input_digest(inputs["obs"], inputs["rl2s"], inputs["time_idxs"]),
            "keys": sorted(inputs["obs"]),
            "illegal": inputs["obs"]["illegal_actions"][0, 0].bool().cpu().tolist()}


def teacher_record(policy):
    from ensemble_policy import choice_token, combine, legal_distribution
    mapping = policy.pending[1]
    tokens = sorted({choice_token(choice) for choice, _ in mapping})
    groups = [sorted({index for choice, index in mapping if choice_token(choice) == token}) for token in tokens]
    members = [legal_distribution(probabilities, mapping) for probabilities in policy.member_probabilities]
    teacher, anchor = combine(members, tokens), combine(members[:1], tokens)
    return {"input": policy.teacher_input, "actions": tokens, "groups": groups,
            "teacher": [teacher[t] for t in tokens], "anchor": [anchor[t] for t in tokens],
            "reusedForward": bool(policy.redrawn)}


def target_tensors(records, device="cpu"):
    if not records:
        raise ValueError("Nonempty teacher records required")
    matrices, teachers, anchors = [], [], []
    for record in records:
        groups = record["groups"]
        indices = [i for group in groups for i in group]
        if (not 1 <= len(groups) <= 13 or any(not group for group in groups)
                or len(indices) != len(set(indices))
                or any(type(i) is not int or not 0 <= i < 13 for i in indices)):
            raise ValueError("Disjoint nonempty structural action groups required")
        matrix = [[float(i in group) for i in range(13)] for group in groups]
        matrices.append(matrix + [[0.] * 13] * (13 - len(groups)))
        for key, destination in (("teacher", teachers), ("anchor", anchors)):
            values = record[key]
            if (len(values) != len(groups) or any(not math.isfinite(v) or v < 0 for v in values)
                    or abs(math.fsum(values) - 1.) > 1e-10):
                raise ValueError("Normalized finite soft targets required")
            destination.append(values + [0.] * (13 - len(groups)))
    tensor = lambda x: torch.tensor(x, dtype=torch.float32, device=device)
    return tensor(matrices), tensor(teachers), tensor(anchors)


def tensor_loss(probabilities, groups, teacher, anchor, anchor_weight):
    if (probabilities.ndim != 2 or probabilities.shape[-1] != 13 or not len(probabilities)
            or groups.shape != (*probabilities.shape,13) or teacher.shape != probabilities.shape
            or anchor.shape != probabilities.shape or not math.isfinite(anchor_weight)
            or not 0 <= anchor_weight <= 1):
        raise ValueError("Nonempty 13-action frames and an explicit anchor weight required")
    if not bool(torch.isfinite(probabilities).all()) or bool((probabilities < 0).any()):
        raise ValueError("Invalid student probabilities")
    mass = torch.einsum("nca,na->nc", groups.float(), probabilities.float())
    total = mass.sum(-1, keepdim=True)
    if not bool((total > 0).all()):
        raise ValueError("Student has no final-request legal mass")
    logp = (mass / total).clamp_min(1e-12).log()
    kl = lambda q: (q * (q.clamp_min(1e-12).log() - logp)).sum(-1)
    teacher_kl, anchor_kl = kl(teacher).mean(), kl(anchor).mean()
    return (1 - anchor_weight) * teacher_kl + anchor_weight * anchor_kl, teacher_kl, anchor_kl


def distillation_loss(probabilities, records, anchor_weight):
    """KL(E3 || student) plus an explicit e34 KL anchor, over structural actions."""
    if len(probabilities)!=len(records):
        raise ValueError("One target per student frame required")
    return tensor_loss(probabilities, *target_tensors(records, probabilities.device), anchor_weight)


def actor_loss(policy, batch, anchor_weight):
    # Match the qualified teacher's inference distribution. Evaluation mode
    # disables dropout and spectral-buffer updates while preserving gradients.
    for module in (policy.tstep_encoder,policy.traj_encoder,policy.actor):
        module.eval()
    if bool(batch.time_idxs[:,0].ne(0).any()):
        raise ValueError("Teacher loss requires the initial recurrent history")
    valid = batch.obs["soft_valid"][:, :-1, 0].eq(1)
    if not bool(valid.any()):
        raise ValueError("Sampled batch has no qualified soft targets")
    embedding, _ = policy.get_state_embedding(obs=batch.obs, rl2s=batch.rl2s, time_idxs=batch.time_idxs)
    distribution = policy.actor(embedding, straight_from_obs={k:batch.obs[k] for k in policy.pass_obs_keys_to_actor})
    probabilities = distribution.probs[:, :-1, -1, :][valid]
    loss, teacher, anchor = tensor_loss(probabilities, batch.obs["soft_groups"][:, :-1][valid],
        batch.obs["soft_teacher"][:, :-1][valid], batch.obs["soft_anchor"][:, :-1][valid], anchor_weight)
    policy.update_info = {"Actor Loss":loss.detach(),"Critic Loss":0.,"Teacher KL":teacher.detach(),
        "Anchor KL":anchor.detach(),"Teacher Decisions":int(valid.sum()),"Sequence Length":batch.rl2s.shape[1]}
    return loss


def install_actor(policy, anchor_weight):
    selected = 0
    for name, parameter in policy.named_parameters():
        enabled = name.startswith(("tstep_encoder.","traj_encoder.","actor."))
        parameter.requires_grad_(enabled)
        selected += int(enabled)
    if not selected:
        raise ValueError("Native actor and encoders are missing")
    policy.forward = lambda batch,log_step=False:actor_loss(policy,batch,anchor_weight)


def install_sampler(plan, manifest_path):
    """Use the native replay dataset, slicing, loader, optimizer and checkpoint path."""
    import random
    from pathlib import Path
    from metamon.rl.metamon_to_amago import MetamonAMAGODataset
    manifest_path = Path(manifest_path)
    if hashlib.sha256(manifest_path.read_bytes()).hexdigest()!=plan["dataManifestSha256"]:
        raise ValueError("Soft training manifest drift")
    manifest = json.loads(manifest_path.read_text())
    approved = {}
    for row in manifest["kept"]:
        if row["model"]!=plan["teacherName"]:
            continue
        directory=(manifest_path.parent/f"pile-{row['sourcePile']}/UUKakuna/metamon").resolve()
        approved.setdefault(directory,[]).append(str(directory/"gen9uu"/row["file"]))
    if not approved:
        raise ValueError("No selected teacher trajectories")
    def sample(wrapper):
        dataset = wrapper.parsed_replay_dset
        directory = Path(dataset.dset_root).resolve()
        if directory not in approved or dataset.max_seq_len is not None:
            raise ValueError("Full qualified teacher trajectory directory required")
        limit = plan["context"]["maxDecisions"]
        if plan["context"]["mode"]!="initial_prefix" or wrapper.max_seq_len!=limit:
            raise ValueError("Native loader length differs from the qualified initial prefix")
        path = random.choice(sorted(approved[directory]))
        result, records, valid, _ = replay_sample(dataset, wrapper, path, plan["teacherId"], plan["members"])
        groups, teacher, anchor = target_tensors(records)
        for key,value in (("soft_groups",groups),("soft_teacher",teacher),("soft_anchor",anchor)):
            result.obs[key]=torch.cat([value,torch.zeros_like(value[:1])])
        mask=torch.zeros(len(records)+1,1)
        mask[valid]=1.
        result.obs["soft_valid"]=mask
        # Native RLDataset.__getitem__ otherwise crops a long game at a random
        # offset, discarding the history that produced the cached teacher target.
        # Keep a complete initial prefix within the existing memory-bound loader.
        result.obs={key:value[:limit+1] for key,value in result.obs.items()}
        for key in ("rl2s","time_idxs"):
            setattr(result,key,getattr(result,key)[:limit+1])
        for key in ("actions","rews","dones"):
            setattr(result,key,getattr(result,key)[:limit])
        return result
    MetamonAMAGODataset.sample_random_trajectory = sample


def replay_sample(dataset, wrapper, path, expected_teacher, expected_members=None):
    """Rebuild the native trainer inputs and reject teacher/input drift before use."""
    from amago.loading import RLData_pad_collate
    payload = dataset._load_json(str(path))
    teacher = payload.get("soft_policy")
    if (not teacher or teacher.get("schema") != "uu-soft-policy@1"
            or teacher.get("policyId") != expected_teacher):
        raise ValueError("Matching causal teacher record required")
    if expected_members is not None and teacher.get("members") != expected_members:
        raise ValueError("Teacher component identity drift")
    records = teacher["records"]
    if len(records) != len(payload["states"]) - 1 or len(records) != len(payload["actions"]) - 1:
        raise ValueError("Every accepted decision needs one teacher record")
    sample = wrapper._process_data(dataset.load_filename(str(path)))
    sample.obs["illegal_actions"][:-1] = torch.tensor([r["input"]["illegal"] for r in records], dtype=torch.bool)
    batch = RLData_pad_collate([sample])
    valid, mismatches, reused = [], [], []
    for index, record in enumerate(records):
        if record["reusedForward"]:
            # Native trapped retries reuse an earlier forward: they are explicit
            # excluded targets, while their accepted action remains in recurrence.
            reused.append(index)
            continue
        obs = {k: batch.obs[k][:, index:index + 1] for k in record["input"]["keys"]}
        actual = input_digest(obs, batch.rl2s[:, index:index + 1], batch.time_idxs[:, index:index + 1])
        if actual != record["input"]["sha256"]:
            mismatches.append(index)
        else:
            valid.append(index)
    if mismatches:
        raise ValueError(f"Teacher/native trainer input mismatch at {mismatches}")
    if not valid:
        raise ValueError("No qualified teacher decisions")
    return sample, records, valid, reused


def verify_teacher_assets(members, assets=None):
    """Keep the frozen teacher identity while locating its exact weights locally."""
    from candidate_worker import digest
    if assets is None:
        paths = {row["sha256"]: row["path"] for row in members}
    else:
        if (not isinstance(assets, list) or len(assets)!=len(members)
                or len({row["sha256"] for row in assets})!=len(assets)
                or {row["sha256"] for row in assets}!={row["sha256"] for row in members}):
            raise ValueError("Teacher asset identity mismatch")
        paths = {row["sha256"]: row["path"] for row in assets}
    if any(digest(paths[row["sha256"]])!=row["sha256"] for row in members):
        raise ValueError("Teacher weight drift")


def main():
    import argparse
    from pathlib import Path
    from candidate_worker import digest
    from filter_families import validate_training_data
    from metamon.data.parsed_replay_dset import MetamonDataset
    from metamon.rl.metamon_to_amago import MetamonAMAGODataset
    from metamon.rl.pretrained import Kakuna
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("manifest", "panel", "teacher-members", "out"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--data-dir",required=True,type=Path,nargs="+")
    parser.add_argument("--teacher-name",required=True)
    parser.add_argument("--teacher-assets",type=Path,
                        help="Explicit local paths with the same frozen member hashes")
    parser.add_argument("--prefix-decisions",required=True,type=int)
    args = parser.parse_args()
    if args.prefix_decisions<1:
        raise ValueError("Positive initial-prefix length required")
    if args.out.exists():
        raise FileExistsError(args.out)
    if len(args.data_dir)!=len({p.resolve() for p in args.data_dir}):
        raise ValueError("Duplicate teacher directories")
    proof = validate_training_data(args.manifest, args.panel, args.data_dir)
    members = json.loads(args.teacher_members.read_text())
    verify_teacher_assets(members, json.loads(args.teacher_assets.read_bytes()) if args.teacher_assets else None)
    teacher = "metamon:Ensemble:" + digest(args.teacher_members)
    model = Kakuna()
    manifest = json.loads(args.manifest.read_text())
    report = {"qualificationOnly":True,"complete":False,"proof":proof,"teacher":teacher,
              "members":[r["sha256"] for r in members],"files":0,"decisions":0,
              "reusedForwardExcluded":0,"inputMismatchFiles":0,"selectedModel":args.teacher_name,
              "context":{"mode":"initial_prefix","maxDecisions":args.prefix_decisions,
                  "includedDecisions":0,"outsidePrefixExcluded":0,"filesWithExcludedTargets":0},
              "producerSha256":digest(__file__)}
    if args.teacher_assets:
        report["teacherAssetBindingsSha256"] = digest(args.teacher_assets)
    try:
        for directory in args.data_dir:
            dataset = MetamonDataset(dset_root=str(directory), observation_space=model.observation_space,
                action_space=model.action_space, reward_function=model.reward_function, formats=["gen9uu"], max_seq_len=None)
            wrapper = MetamonAMAGODataset(dataset)
            rows = [r for r in manifest["kept"] if r["model"]==args.teacher_name and
                    directory.resolve()==(args.manifest.parent/f"pile-{r['sourcePile']}/UUKakuna/metamon").resolve()]
            if not rows:
                raise ValueError("No teacher POVs in the qualified family-filtered stratum")
            for row in rows:
                _, records, valid, reused = replay_sample(dataset, wrapper,
                    directory / "gen9uu" / row["file"], teacher, report["members"])
                distillation_loss(torch.ones(len(records), 13), records, .1)
                report["files"] += 1
                report["decisions"] += len(valid)
                report["reusedForwardExcluded"] += len(reused)
                outside=sum(index>=args.prefix_decisions for index in valid)
                report["context"]["includedDecisions"] += len(valid)-outside
                report["context"]["outsidePrefixExcluded"] += outside
                report["context"]["filesWithExcludedTargets"] += int(outside>0)
        report["complete"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        if "input mismatch" in str(error):
            report["inputMismatchFiles"] += 1
        raise
    finally:
        with args.out.open("x") as stream:
            json.dump(report, stream, indent=2)
        print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
