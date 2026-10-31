#!/usr/bin/env python3
"""Export registry-promoted UU weights. Source env.sh, then: CKPT EPOCH OUT.

OUT must be in a device-local evaluation directory. No source tree is modified.
The receipt maps ALL Kakuna tensors, including EMA-synchronized targets/popart.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path

BASE_SHA = "7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c"
TENSORS = 642


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def check_format(state, base):
    if len(state) != TENSORS or state.keys() != base.keys():
        raise ValueError("Kakuna key drift (expected exactly 642 keys)")
    for key in base:
        if state[key].shape != base[key].shape or state[key].dtype != base[key].dtype:
            raise ValueError(f"Kakuna shape/dtype drift: {key}")


def source_key(key, parameter_keys):
    # AMAGO _full_copy copies parameters ONLY. In particular SigmaReparam u/v
    # buffers remain raw, and using EMA buffers would change inference.
    if key not in parameter_keys:
        return key
    # on_checkpoint_loaded(False) copies EMA -> main, then hard_sync_targets().
    for prefix in ("target_", "maximized_"):
        if key.startswith(prefix):
            key = key[len(prefix):]
            break
    if key.split(".")[0] in ("tstep_encoder", "traj_encoder", "actor", "critics"):
        return "_tortoise_" + key
    if key.startswith("popart."):
        return key
    raise ValueError(f"Unproved promotion mapping: {key}")


def verify_export(exported, raw, promoted, base, parameter_keys):
    """Exact checks intentionally reject unpromoted raw weights and schema drift."""
    import torch
    check_format(exported, base)
    mapping = {}
    for key, value in exported.items():
        origin = source_key(key, parameter_keys)
        if not torch.isfinite(value).all():
            raise ValueError(f"Nonfinite output: {key}")
        if not torch.equal(value, promoted[key].detach().cpu()):
            raise ValueError(f"Not the registry-promoted main policy: {key}")
        if origin not in raw or not torch.equal(value, raw[origin]):
            raise ValueError(f"EMA promotion mismatch: {key} <- {origin}")
        mapping[key] = {"source_tensor": origin, "kind": "EMA" if origin.startswith("_tortoise_") else "raw",
                        "shape": list(value.shape), "dtype": str(value.dtype)}
    return mapping


def registry_load(checkpoint, epoch, work):
    """Normal registry path for >0; identical manual strict steps for epoch 0."""
    import torch
    from metamon.rl.pretrained import UUFinetuned
    if epoch < 0 or checkpoint.name != f"policy_epoch_{epoch}.pt":
        raise ValueError("Epoch must match the named source policy_epoch_N.pt")
    # Experiment.start writes scaffolding relative to parents[2] of this path.
    # Keep those writes under eval-prep instead of the training checkpoint tree.
    link = work / "registry" / "ckpts" / "policy_weights" / checkpoint.name
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        if link.resolve() != checkpoint.resolve():
            raise ValueError("Registry staging link points to a different source")
    elif link.exists():
        raise ValueError("Registry staging path already occupied")
    else:
        link.symlink_to(checkpoint.resolve())
    maker = UUFinetuned()
    maker.get_path_to_checkpoint = lambda requested: str(link) if requested == epoch else None
    exp = maker.initialize_agent(checkpoint=epoch, log=False, action_temperature=1.0)
    if epoch == 0:
        raw = torch.load(checkpoint, map_location="cpu", weights_only=True)
        maker._validate_checkpoint(raw, exp.policy.state_dict())
        exp.policy.load_state_dict(raw, strict=True)
        exp.policy.on_checkpoint_loaded(is_resume=False)
    if exp.policy.use_tortoise_for_inference:
        raise ValueError("Proof requires the promoted MAIN policy inference path")
    exp.policy.eval()
    return maker, exp


def training_eligible(identity, epoch, ready=None):
    if identity.get("purpose")!="generation" or not identity.get("dataProof"):
        return False
    soft = identity.get("softPolicy")
    if soft:
        return (epoch==soft["finalEpoch"] and ready is not None
                and ready["updates"]==soft["updates"])
    return True


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("checkpoint", type=Path)
    p.add_argument("epoch", type=int)
    p.add_argument("out", type=Path)
    a = p.parse_args()
    import torch
    torch.set_num_threads(1)
    a.checkpoint = a.checkpoint.resolve()
    a.out = a.out.absolute()
    receipt_path = a.out.with_suffix(a.out.suffix + ".receipt.json")
    if a.out.exists() or receipt_path.exists():
        raise ValueError("Refusing to overwrite an export/receipt")
    a.out.parent.mkdir(parents=True, exist_ok=True)
    base_path = Path(os.environ["UU_KAKUNA_CKPT"])
    if digest(base_path) != BASE_SHA:
        raise ValueError("Pinned epoch-34 hash mismatch")
    before = digest(a.checkpoint)
    maker, exp = registry_load(a.checkpoint, a.epoch, a.out.parent / (a.out.stem + "-load"))
    raw = torch.load(a.checkpoint, map_location="cpu", weights_only=True, mmap=True)
    base = torch.load(base_path, map_location="cpu", weights_only=True, mmap=True)
    promoted = exp.policy.state_dict()
    exported = {key: promoted[key].detach().cpu().clone() for key in base}
    mapping = verify_export(exported, raw, promoted, base, set(dict(exp.policy.named_parameters())))
    changed = [key for key in base if not torch.equal(exported[key], base[key])]
    ema_changed = [key for key in base if mapping[key]["kind"] == "EMA"
                   and not torch.equal(raw[key], exported[key])]
    if not changed or not ema_changed:
        raise ValueError("Vacuous export: require base difference and raw/EMA divergence")
    if digest(a.checkpoint) != before:
        raise ValueError("Source changed during export")
    torch.save(exported, a.out)
    check_format(torch.load(a.out, map_location="cpu", weights_only=True), base)
    receipt = {"source": str(a.checkpoint), "source_sha256": before, "epoch": a.epoch,
               "output": str(a.out), "output_sha256": digest(a.out), "base_sha256": BASE_SHA,
               "source_tensors": len(raw), "output_tensors": len(exported), "key_shape_dtype_check": True,
               "load": "registry >0" if a.epoch else "registry build + manual validate/strict load/on_checkpoint_loaded(False)",
               "differs_from_base_tensors": len(changed), "raw_vs_promoted_different_tensors": len(ema_changed),
               "max_abs_weight_difference_from_base": max(float((exported[k] - base[k]).abs().max()) for k in base),
               "mapping": mapping, "producer_sha256": digest(__file__),
               "registry_source_sha256": digest(__import__("inspect").getfile(type(maker))),
               "promotion_source_sha256": digest(__import__("inspect").getfile(type(exp.policy)))}
    identity_path = a.checkpoint.parents[4]/f"{a.checkpoint.parents[2].name}-identity.json"
    if identity_path.exists():
        identity = json.loads(identity_path.read_text())
        receipt["training_identity_sha256"] = digest(identity_path)
        ready_path = a.checkpoint.with_suffix(".ready.json")
        ready = json.loads(ready_path.read_text()) if identity.get("softPolicy") and ready_path.exists() else None
        if ready is not None and ready["identity"]!=receipt["training_identity_sha256"]:
            raise ValueError("Soft-training checkpoint readiness identity drift")
        receipt["training_eligible"] = training_eligible(identity,a.epoch,ready)
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k: v for k, v in receipt.items() if k != "mapping"}, indent=2))


if __name__ == "__main__":
    main()
