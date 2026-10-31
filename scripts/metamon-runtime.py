#!/usr/bin/env python3
"""Isolated Linux/WSL2 Metamon setup; never touches system Python or downloads datasets.

Bootstrap (Python 3.12, git and venv must already exist):
  python3 scripts/metamon-runtime.py bootstrap --root /unsynced/runtime --venv /unsynced/venv
Re-running syncs the committed dependency lock and verifies/reuses the one checkpoint.
Use the resulting interpreter with METAMON_CACHE_DIR=<root>/cache. Raw setup logs,
package caches, model weights and qualification evidence belong under <root>.
"""

import argparse
import base64
import csv
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

HF_REVISION = "ac8e88e7da8dc2a2b85176d88f81fd8854b1445b"
CHECKPOINT_FILE = "kakuna/ckpts/policy_weights/policy_epoch_34.pt"
CHECKPOINT_SHA256 = "7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c"
CHECKPOINT_BYTES = 571_581_627


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def runtime_env(root):
    env = os.environ.copy()
    env.update({key: "1" for key in (
        "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS", "RAYON_NUM_THREADS", "MAX_JOBS",
        "UV_CONCURRENT_DOWNLOADS", "UV_CONCURRENT_BUILDS", "UV_CONCURRENT_INSTALLS",
        "TORCHINDUCTOR_COMPILE_THREADS")})
    env.update(METAMON_CACHE_DIR=str(root / "cache"),
               PYTHONPATH=str(root / "source"),
               UV_CACHE_DIR=str(root / "uv-cache"),
               TORCHINDUCTOR_CACHE_DIR=str(root / "torch-cache"),
               TRITON_CACHE_DIR=str(root / "triton-cache"),
               HF_HUB_DISABLE_TELEMETRY="1", WANDB_MODE="disabled",
               PYTHONDONTWRITEBYTECODE="1")
    return env


def retain_producer(root):
    project = Path(__file__).resolve().parents[1]
    files = ("scripts/metamon-runtime.py", "requirements/metamon-runtime.in", "requirements/metamon-runtime.txt")
    digest = hashlib.sha256("".join(sha256(project / name) for name in files).encode()).hexdigest()
    path = root / f"producer-{digest}.zip"
    if not path.exists():
        with zipfile.ZipFile(path, "x", zipfile.ZIP_DEFLATED) as archive:
            for name in files:
                archive.write(project / name, name)
    return str(path)


def repair_vendor_metadata(root, venv, producer):
    """Correct the proven cuSPARSELt 0.8.0 ARM wheel tag, never its payload."""
    if sys.platform != "linux" or platform.machine() != "aarch64":
        return None
    # Bootstrap uses system Python; discover ONLY the explicitly selected venv.
    venv = venv.resolve()
    config = dict(line.lower().strip().split("=", 1)
                  for line in (venv / "pyvenv.cfg").read_text().splitlines() if "=" in line)
    config = {key.strip(): value.strip() for key, value in config.items()}
    site = venv / "lib/python3.12/site-packages"
    if config.get("include-system-site-packages") != "false" or site.resolve() != site or not site.is_dir():
        raise RuntimeError("Vendor metadata repair requires an isolated Python 3.12 venv")
    distributions = list(importlib.metadata.Distribution.discover(
        name="nvidia-cusparselt-cu13", path=[str(site)]))
    if (len(distributions) != 1 or distributions[0].version != "0.8.0"
            or distributions[0].metadata["Name"] != "nvidia-cusparselt-cu13"):
        raise RuntimeError("Expected exactly nvidia-cusparselt-cu13==0.8.0 in the target venv")
    wheel_name = "nvidia_cusparselt_cu13-0.8.0.dist-info/WHEEL"
    wheel = site / wheel_name
    record = wheel.parent / "RECORD"
    library = site / "nvidia/cusparselt/lib/libcusparseLt.so.0"
    for path in (wheel, record, library):
        if path.resolve() != path or not path.is_file():
            raise RuntimeError(f"Refusing vendor metadata repair through an indirect/missing path: {path}")
    wheel_before, record_before = wheel.read_bytes(), record.read_bytes()
    old_tag = b"Tag: py3-none-manylinux2014_sbsa\n"
    new_tag = b"Tag: py3-none-manylinux2014_aarch64\n"
    original = wheel_before.replace(new_tag, old_tag)
    # Official aarch64 wheel SHA256: 400c6ed1cf6780fc6efedd64ec9f1345871767e6a1a0a552a1ea0578117ea77c.
    if hashlib.sha256(original).hexdigest() != "f44130c350c4a5261dabead1793c18f3c1b9d54a075af0015ae445e92cbff01b":
        raise RuntimeError("Unrecognized cuSPARSELt WHEEL metadata; refusing repair")
    wheel_after = original.replace(old_tag, new_tag)
    with library.open("rb") as stream:
        header = stream.read(20)
    library_hash = sha256(library)
    if (len(header) != 20 or header[:6] != b"\x7fELF\x02\x01"
            or int.from_bytes(header[18:20], "little") != 183
            or library.stat().st_size != 273_881_681
            or library_hash != "20de6b36cbbf5753b26826eec753a2005608e14cbc3bfdd4681138098be86941"):
        raise RuntimeError("cuSPARSELt native library differs from the qualified AArch64 payload")
    entries = []
    for data in (original, wheel_after):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        entries.append([wheel_name, "sha256=" + digest, str(len(data))])
    rows = list(csv.reader(record_before.decode().splitlines(), strict=True))
    matching = [row for row in rows if row and row[0] == wheel_name]
    if (any(len(row) != 3 for row in rows) or len(matching) != 1
            or matching[0] not in entries[:1 if wheel_before == original else 2]):
        raise RuntimeError("Unrecognized cuSPARSELt WHEEL entry in RECORD; refusing repair")
    # Change only this row; preserve all other RECORD bytes, including newlines.
    old_line = ",".join(matching[0]).encode()
    lines = record_before.splitlines(keepends=True)
    indices = [i for i, line in enumerate(lines) if line.rstrip(b"\r\n") == old_line]
    if len(indices) != 1:
        raise RuntimeError("Unrecognized cuSPARSELt RECORD row encoding; refusing repair")
    index = indices[0]
    lines[index] = lines[index].replace(old_line, ",".join(entries[1]).encode(), 1)
    record_after = b"".join(lines)
    changes = ((wheel, wheel_before, wheel_after), (record, record_before, record_after))
    evidence = Path(tempfile.mkdtemp(prefix="vendor-metadata-", dir=root))
    receipt = {"package": "nvidia-cusparselt-cu13", "version": "0.8.0", "venv": str(venv),
               "old_tag": old_tag.decode().strip()[5:], "new_tag": new_tag.decode().strip()[5:],
               "library_sha256": library_hash, "library_bytes": library.stat().st_size,
               "elf_class": 64, "elf_endian": "little", "elf_machine": 183,
               "producer": producer, "setup_source_sha256": sha256(Path(__file__)),
               "status": "pending", "files": {}}
    receipt_path = evidence / "repair.json"
    for path, before, after in changes:
        (evidence / f"{path.name}-before").write_bytes(before)
        receipt["files"][path.name] = {"path": str(path), "changed": before != after,
                                     "before_sha256": hashlib.sha256(before).hexdigest(),
                                     "expected_after_sha256": hashlib.sha256(after).hexdigest()}
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    staged = []
    try:
        # Stage BOTH files before replacement. Never write cache-hardlinked metadata in place.
        for path, before, after in changes:
            if before == after:
                continue
            with tempfile.NamedTemporaryFile(prefix=f".{path.name}-", dir=path.parent, delete=False) as stream:
                temporary = Path(stream.name)
                staged.append((path, before, temporary))
                os.fchmod(stream.fileno(), path.stat().st_mode & 0o777)
                stream.write(after)
                stream.flush()
                os.fsync(stream.fileno())
        for path, before, temporary in staged:
            if path.read_bytes() != before:
                raise RuntimeError(f"Vendor metadata changed during repair: {path}")
            os.replace(temporary, path)
        # WHEEL goes first: a retry accepts its new tag with the old RECORD entry.
        receipt["status"] = "repaired" if staged else "already-correct"
    except Exception as error:
        receipt.update(status="failed", error=str(error))
        raise
    finally:
        for _, _, temporary in staged:
            temporary.unlink(missing_ok=True)
        for path, _, after in changes:
            actual = path.read_bytes()
            (evidence / f"{path.name}-after").write_bytes(actual)
            receipt["files"][path.name]["after_sha256"] = hashlib.sha256(actual).hexdigest()
            if actual != after and receipt["status"] != "failed":
                receipt.update(status="failed", error=f"Vendor metadata verification failed: {path}")
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    if receipt["status"] == "failed":
        raise RuntimeError(receipt["error"])
    return str(receipt_path)


def bootstrap(root, venv):
    if sys.platform != "linux" or sys.version_info[:2] != (3, 12):
        raise RuntimeError("This lock is qualified only on Linux/WSL2, Python 3.12")
    project = Path(__file__).resolve().parents[1]
    lock = project / "requirements/metamon-runtime.txt"
    env = runtime_env(root)
    python = venv / "bin/python"
    (root / "cache").mkdir(parents=True, exist_ok=True)
    producer = retain_producer(root)
    log_path = root / f"bootstrap-{time.time_ns()}.log"
    with log_path.open("w") as log:
        def run(argv):
            print(json.dumps({"command": [str(arg) for arg in argv]}), flush=True)
            subprocess.run(argv, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        if not python.exists():
            run([sys.executable, "-m", "venv", str(venv)])
        run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "uv==0.11.17"])
        run([str(python), "-m", "uv", "pip", "sync", "--python", str(python), str(lock)])
        vendor_metadata = repair_vendor_metadata(root, venv, producer)
        run([str(python), "-m", "uv", "pip", "check", "--python", str(python)])
        # Upstream recommends editable/source installs. Its wheel omits gin,
        # tokenizer and JSON assets; import the identical pinned source instead.
        metadata_code = 'import importlib.metadata,json; print(importlib.metadata.distribution("metamon").read_text("direct_url.json"))'
        direct = json.loads(subprocess.check_output([str(python), "-c", metadata_code], env=env, text=True))
        source = root / "source"
        commit = direct["vcs_info"]["commit_id"]
        if not (source / ".git").exists():
            run(["git", "init", str(source)])
            run(["git", "-C", str(source), "remote", "add", "origin", direct["url"]])
            run(["git", "-C", str(source), "fetch", "--depth=1", "origin", commit])
            run(["git", "-C", str(source), "checkout", "--detach", commit])
        actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip()
        if actual != commit or dirty:
            raise RuntimeError("Pinned source checkout differs; refusing to overwrite it")
    checkpoint = root / "cache" / CHECKPOINT_FILE
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    if not checkpoint.exists():
        url = f"https://huggingface.co/jakegrigsby/metamon/resolve/{HF_REVISION}/{CHECKPOINT_FILE}"
        partial = checkpoint.with_suffix(f".partial-{time.time_ns()}")
        # One HTTP stream, no snapshot_download or archive clone.
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("xb") as out:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                out.write(chunk)
        if partial.stat().st_size != CHECKPOINT_BYTES or sha256(partial) != CHECKPOINT_SHA256:
            raise RuntimeError(f"Checkpoint digest/size failed; retained {partial}")
        partial.rename(checkpoint)
    if checkpoint.stat().st_size != CHECKPOINT_BYTES or sha256(checkpoint) != CHECKPOINT_SHA256:
        raise RuntimeError("Existing checkpoint digest/size mismatch; refusing to replace")
    receipt = {"python": str(python), "checkpoint": str(checkpoint),
               "checkpoint_sha256": CHECKPOINT_SHA256, "hf_revision": HF_REVISION,
               "requirements_sha256": sha256(lock), "setup_source_sha256": sha256(Path(__file__)),
               "log": str(log_path), "producer": producer, "METAMON_CACHE_DIR": env["METAMON_CACHE_DIR"],
               "vendor_metadata_repair": vendor_metadata,
               "PYTHONPATH": str(source), "source_commit": commit}
    (root / "setup.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)


def smoke(root):
    """Test upstream FlexAttention against dense window math, then the real weights."""
    os.environ.update(runtime_env(root))
    os.environ["HF_HUB_OFFLINE"] = "1"
    sys.path.insert(0, str(root / "source"))
    producer = retain_producer(root)
    import importlib.metadata
    import resource
    import numpy as np
    import torch
    from amago.nets.transformer import SelfAttention, SlidingWindowFlexAttention, Cache, TformerHiddenState
    from amago.hindsight import Timestep
    from metamon.rl.pretrained import Kakuna
    from metamon.rl.metamon_to_amago import make_placeholder_env

    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    provenance = {}
    for name, version, commit in (
        ("metamon", "1.6.0", "0a00a759c9a4382a2877088d828302ec294a05a5"),
        ("amago", "3.4.0", "0974781a9096ff43df1b708312256f96fc2ab127"),
        ("poke-env", "0.8.3.3", "e1268d270c3f2bd32c7ff5713e01062302020579"),
    ):
        dist = importlib.metadata.distribution(name)
        direct = json.loads(dist.read_text("direct_url.json"))
        assert dist.version == version and direct["vcs_info"]["commit_id"] == commit
        provenance[name] = {"version": version, "commit": commit}
    if not torch.cuda.is_available():
        raise RuntimeError("This qualification requires CUDA")
    torch.cuda.reset_peak_memory_stats()
    device = torch.device("cuda:0")
    attention = SlidingWindowFlexAttention(causal=True, dropout=0.0, window_size=96).eval()
    assert not attention.state_dict(), "Attention substitution must add no weights"
    qidx = torch.arange(256)[:, None]
    kidx = torch.arange(256)[None, :]
    expected = (qidx >= kidx) & (qidx - kidx <= 96)
    actual = attention.mask_mod(0, 0, qidx, kidx) & attention.causal_mask(0, 0, qidx, kidx)
    assert torch.equal(actual, expected)
    errors = []
    for index in (0, 95, 96, 97, 127):
        qkv = torch.randn(1, 1, 3, 12, 75, device=device)
        keys = torch.randn(1, 128, 12, 75, device=device)
        values = torch.randn_like(keys)
        lengths = torch.tensor([index], dtype=torch.int32, device=device)
        keys[:, index + 1:] = float("nan")
        values[:, index + 1:] = float("nan")
        with torch.no_grad():
            out = attention(qkv, keys, values, lengths)
            query = qkv[:, :, 0].transpose(1, 2).double()
            key = keys[:, :index + 1].transpose(1, 2).double()
            value = values[:, :index + 1].transpose(1, 2).double()
            allowed = (torch.arange(index + 1, device=device) >= index - 96)
            scores = query @ key.transpose(-1, -2) / (75 ** 0.5)
            scores.masked_fill_(~allowed, -torch.inf)
            reference = (scores.softmax(-1) @ value).transpose(1, 2).float()
            error = float((out - reference).abs().max())
            assert torch.allclose(out, reference, atol=0.0002, rtol=0.0002), error
        assert torch.equal(keys[:, index], qkv[:, 0, 1])
        assert torch.equal(values[:, index], qkv[:, 0, 2])
        errors.append({"cache_index": index, "max_abs_error": error})
    caches = [Cache(device=device, dtype=torch.float32, layers=1, batch_size=1,
                    max_seq_len=128, n_heads=1, head_dim=1) for _ in range(2)]
    for cache in caches:
        cache.data.copy_(torch.arange(128, device=device).view(1, 1, 128, 1, 1))
    hidden = TformerHiddenState(*caches, torch.tensor([127], dtype=torch.int32, device=device))
    hidden.update()
    assert hidden.seq_lens.item() == 127
    assert caches[0].data[0, 0, 0, 0, 0].item() == 1
    assert torch.isnan(caches[0].data[0, 0, -1, 0, 0])
    hidden.reset(np.array([True]))
    assert hidden.seq_lens.item() == 0
    print(json.dumps({"attention_tests": errors, "mask_pairs": 65536, "cache_roll_reset": True}), flush=True)

    checkpoint = root / "cache" / CHECKPOINT_FILE
    assert checkpoint.stat().st_size == CHECKPOINT_BYTES and sha256(checkpoint) == CHECKPOINT_SHA256
    model = Kakuna()
    def local_checkpoint(epoch):
        import gin
        assert epoch == 34
        # initialize_agent calls this AFTER config files, before constructing modules.
        gin.bind_parameter("traj_encoders.TformerTrajEncoder.attention_type", SlidingWindowFlexAttention)
        gin.bind_parameter("transformer.SlidingWindowFlexAttention.window_size", 96)
        # AMAGO's default is float 1e10; Python 3.12 randint requires an integer.
        gin.bind_parameter("MetamonAMAGOExperiment.traj_save_len", 10_000_000_000)
        return str(checkpoint)
    model.get_path_to_checkpoint = local_checkpoint
    started = time.monotonic()
    experiment = model.initialize_agent(checkpoint=34, log=False)  # upstream strict=True
    policy = experiment.policy.eval()
    initialization_seconds = time.monotonic() - started
    assert policy.traj_encoder.attention_type is SlidingWindowFlexAttention
    layers = [module for module in policy.modules() if isinstance(module, SelfAttention)]
    assert len(layers) == 10 and all(type(module) is SlidingWindowFlexAttention for module in layers)
    for layer in layers:
        assert not layer.state_dict() and layer.causal and layer.dropout == 0.0
        assert torch.equal(layer.mask_mod(0, 0, qidx, kidx) & layer.causal_mask(0, 0, qidx, kidx), expected)
    wrapper = make_placeholder_env(model.observation_space, model.action_space)
    obs = {key: np.zeros((1, *space.shape), dtype=space.dtype)
           for key, space in wrapper.observation_space.items()}
    timestep = Timestep(obs=obs, prev_action=np.zeros((1, wrapper.action_size), dtype=wrapper.action_dtype),
                        reward=np.zeros(1, dtype=np.float32), terminal=np.zeros(1, dtype=bool),
                        time_idx=np.zeros(1, dtype=np.int64), batched_envs=1)
    obs, rl2, times = timestep.as_input()
    tensor = lambda array: torch.from_numpy(array).to(device).unsqueeze(1)
    hidden = policy.traj_encoder.init_hidden_state(1, device)
    assert hidden.key_cache.data.dtype == torch.float32
    started = time.monotonic()
    with torch.no_grad(), experiment.caster():
        actions, hidden = policy.get_actions(obs={k: tensor(v) for k, v in obs.items()},
            rl2s=tensor(rl2), time_idxs=tensor(times), sample=False, hidden_state=hidden)
    torch.cuda.synchronize()
    assert actions.numel() == 1 and 0 <= actions.item() < model.action_space.gym_space.n
    assert hidden.seq_lens.item() == 1
    receipt = {"torch": torch.__version__, "gpu": torch.cuda.get_device_name(),
               "checkpoint_sha256": CHECKPOINT_SHA256, "strict_weight_load": True,
               "attention": "SlidingWindowFlexAttention", "window_size": 96,
               "instantiated_attention_layers": len(layers), "provenance": provenance,
               "mask_pairs": 65536, "attention_tests": errors, "cache_roll_reset": True,
               "parameters": sum(p.numel() for p in policy.parameters()),
               "initialization_seconds": initialization_seconds,
               "synthetic_input_action": int(actions.item()),
               "first_input_seconds": time.monotonic() - started,
               "peak_process_rss_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
               "peak_cuda_allocated_mib": torch.cuda.max_memory_allocated() / 2**20,
               "peak_cuda_reserved_mib": torch.cuda.max_memory_reserved() / 2**20,
               "precision_note": "Official Flex uses float32 KV cache; Flash uses bfloat16. Not bitwise parity.",
               "setup_source_sha256": sha256(Path(__file__)), "producer": producer}
    (root / "smoke.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)


def validate_runtime_storage(root, venv):
    project = Path(__file__).resolve().parents[1]
    for path in (root, venv):
        if not path.is_absolute():
            raise ValueError("root and venv must be absolute unsynced device-local paths")
        resolved = path.resolve()
        if resolved == project or project in resolved.parents or any(
            (parent / ".stfolder").exists() for parent in (resolved, *resolved.parents)):
            raise ValueError("root and venv must be outside the project and Syncthing folders")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("bootstrap", "smoke"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--venv", type=Path, required=True)
    args = parser.parse_args()
    try:
        validate_runtime_storage(args.root, args.venv)
    except ValueError as error:
        parser.error(str(error))
    if args.command == "bootstrap":
        bootstrap(args.root, args.venv)
    else:
        smoke(args.root)


if __name__ == "__main__":
    main()
