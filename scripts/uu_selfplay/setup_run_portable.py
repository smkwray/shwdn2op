"""Build a UU self-play run dir on Windows (ROCm/CUDA torch) or macOS (CPU/MPS): setup_run.sh's
step 0 without flex/Triton, setsid or GNU tools. Same Metamon fork (vendor/metamon, assembled and
checked against source-pins.json) and Showdown 0.11.11 server; attention is windowed_attention.py
bound via gin.

Usage: python setup_run_portable.py --run RUN --python PY --metamon-src DIR --amago-pkg DIR
         --ckpt FILE --node-dir DIR --team-pool DIR --device {cuda,mps,cpu} [--fetch-node]
  RUN          new run dir inside the project's ignored tmp/
  PY           venv python: torch 2.11.0, poke-env 0.8.3.3, amago 3.4.0 @0974781a
  DIR (metamon-src)  dir holding metamon/ with the fork's upstream data files (vendor/metamon/data.sha256): an
               upstream checkout at 0a00a759 or an existing run source
  node-dir     dir containing node(.exe); with --fetch-node (Windows) the official
               node-v26.7.0-win-x64 zip is downloaded there and checked against SHASUMS256.txt
Writes RUN/env.json (read by block_portable.py) plus env.sh or env.ps1 for manual commands.
"""

import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import urllib.request
import zipfile

K = Path(__file__).resolve().parent
CKPT_SHA = "7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c"
NODE_VERSION = "v26.7.0"
WIN = os.name == "nt"


def sha(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def run(argv, log, **kw):
    with open(log, "ab") as out:
        out.write(("$ " + " ".join(map(str, argv)) + "\n").encode())
        out.flush()
        subprocess.run([str(a) for a in argv], stdout=out, stderr=subprocess.STDOUT, check=True, **kw)


def assembler():
    """vendor/metamon/assemble.py, loaded by path (its directory holds the fork's metamon/ package)."""
    spec = importlib.util.spec_from_file_location("metamon_fork_assemble", K.parents[1] / "vendor/metamon/assemble.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fetch_node(node_dir):
    """Official Windows zip from nodejs.org, verified against the release's SHASUMS256.txt."""
    name = f"node-{NODE_VERSION}-win-x64"
    base = f"https://nodejs.org/dist/{NODE_VERSION}/"
    sums = urllib.request.urlopen(base + "SHASUMS256.txt", timeout=60).read().decode()
    want = next(line.split()[0] for line in sums.splitlines() if line.endswith(f" {name}.zip"))
    blob = urllib.request.urlopen(base + f"{name}.zip", timeout=600).read()
    if hashlib.sha256(blob).hexdigest() != want:
        raise SystemExit("node zip SHA256 mismatch")
    node_dir.parent.mkdir(parents=True, exist_ok=True)
    zipfile.ZipFile(io.BytesIO(blob)).extractall(node_dir.parent)
    if node_dir.name != name:
        raise SystemExit(f"--node-dir must end in {name}")
    (node_dir / "SHASUMS256.verified").write_text(f"{want}  {name}.zip\n")
    print("node fetched", want)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("run", "python", "metamon-src", "amago-pkg", "ckpt", "node-dir", "team-pool"):
        p.add_argument(f"--{name}", type=Path, required=True)
    p.add_argument("--device", choices=("cuda", "mps", "cpu"), required=True)
    p.add_argument("--fetch-node", action="store_true")
    a = p.parse_args()
    pins = json.loads((K / "source-pins.json").read_text())
    run_dir, py = a.run.resolve(), a.python
    if run_dir.exists():
        raise SystemExit(f"run dir exists: {run_dir}")
    if sha(a.ckpt) != CKPT_SHA:
        raise SystemExit("checkpoint hash mismatch")
    node = a.node_dir / ("node.exe" if WIN else "node")
    if not node.exists():
        if not (a.fetch_node and WIN):
            raise SystemExit(f"missing {node}")
        fetch_node(a.node_dir)
    for d in ("source", "ext", "logs", "piles", "checkpoints", "cache/teams", "cache/npm", "scratch",
              "kakuna/ckpts/policy_weights"):
        (run_dir / d).mkdir(parents=True, exist_ok=True)
    logs, src = run_dir / "logs", run_dir / "source"
    # Checkpoint at production's layout (initialize_agent writes under parents[2]); hardlink, no copy.
    ckpt = run_dir / "kakuna/ckpts/policy_weights/policy_epoch_34.pt"
    try:
        os.link(a.ckpt, ckpt)
    except OSError:
        shutil.copy2(a.ckpt, ckpt)
    if sha(ckpt) != CKPT_SHA:
        raise SystemExit("linked checkpoint hash mismatch")

    shutil.copytree(a.amago_pkg, src / "amago", ignore=shutil.ignore_patterns("__pycache__"))
    bad = [rel for rel, want in pins["amago"].items() if sha(src / rel) != want]
    if bad:
        raise SystemExit(f"amago pin MISMATCH {bad}")
    tree, count = assembler().build(src, a.metamon_src.resolve(), pins["metamon"]["tree_sha256"])
    print("metamon fork tree", tree, count, "files; amago pin ALL MATCH")
    shutil.copy2(K / "windowed_attention.py", run_dir / "ext/windowed_attention.py")

    fwd = lambda path: Path(path).as_posix()  # gin string literals: no backslash escapes
    for name, train in (("base", "kakuna"), ("finetune", "finetune")):
        lines = ["import windowed_attention",
                 f"include '{fwd(src / 'metamon/rl/configs/training' / (train + '.gin'))}'",
                 "traj_encoders.TformerTrajEncoder.attention_type = @windowed_attention.SlidingWindowVanillaAttention",
                 "windowed_attention.SlidingWindowVanillaAttention.window_size = 96"]
        if name == "finetune":
            lines.append("amago.nets.transformer.SigmaReparam.fast_init = True")
        (run_dir / f"{name}-window.gin").write_text("\n".join(lines) + "\n", newline="\n")

    env = {"R": str(run_dir), "PY": str(py), "NODE": str(node), "DEVICE": a.device,
           "PYTHONPATH": os.pathsep.join([str(src), str(run_dir / "ext")]),
           "METAMON_CACHE_DIR": str(run_dir / "cache"),
           "HF_HUB_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1", "WANDB_MODE": "disabled", "TOKENIZERS_PARALLELISM": "false",
           "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "PYTHONDONTWRITEBYTECODE": "1",
           "TORCHDYNAMO_DISABLE": "1", "PYTHONUTF8": "1", "PYTHONNOUSERSITE": "1",
           "UU_BASE_GIN": str(run_dir / "base-window.gin"), "UU_KAKUNA_CKPT": str(ckpt),
           "UU_FT_CKPT_DIR": str(run_dir / "checkpoints"), "UU_FT_RUN": "uu_iter1", "UU_FT_EPOCH": "10",
           "UU_FT_GIN": str(run_dir / "finetune-window.gin"),
           "npm_config_cache": str(run_dir / "cache/npm"), "npm_config_update_notifier": "false"}
    if a.device == "cpu":
        env["ACCELERATE_USE_CPU"] = "true"
    if a.device == "mps":
        env["PYTORCH_ENABLE_MPS_FALLBACK"] = "0"
    if WIN:
        env["TEMP"] = env["TMP"] = str(run_dir / "scratch")
    else:
        env["TMPDIR"] = str(run_dir / "scratch")
    (run_dir / "env.json").write_text(json.dumps(env, indent=1) + "\n")
    if WIN:
        (run_dir / "env.ps1").write_text("".join(f"$env:{k} = '{v}'\n" for k, v in env.items()))
    else:
        (run_dir / "env.sh").write_text("".join(f"export {k}='{v}'\n" for k, v in env.items()))
    child_env = {**os.environ, **env, "PATH": os.pathsep.join([str(a.node_dir), os.environ.get("PATH", "")])}

    teams = run_dir / "cache/teams"
    for name in ("uu_train_v1", "uu_dev_v1", "uu_held_out_v1"):
        shutil.copytree(a.team_pool / name, teams / name)
    for f in (teams / "uu_held_out_v1").rglob("*"):
        if f.is_file():
            os.chmod(f, stat.S_IREAD)  # read-only; never used for collection

    ps_root = run_dir / "ps"
    ps_root.mkdir()
    (ps_root / "package.json").write_text('{"private":true}\n')
    npm_cli = next(c for c in (a.node_dir / "node_modules/npm/bin/npm-cli.js",
                               a.node_dir.parent / "lib/node_modules/npm/bin/npm-cli.js") if c.exists())
    # --ignore-scripts: the package ships dist/ and the server starts with --skip-build, so no install
    # script is needed. Otherwise esbuild's postinstall can resolve an ancestor node_modules/@esbuild
    # (e.g. the project root on macbox) and abort; npm 11's allowScripts already skips it on fresh hosts.
    run([node, npm_cli, "install", "--no-audit", "--no-fund", "--omit=optional", "--ignore-scripts", "pokemon-showdown@0.11.11"],
        logs / "ps-install.log", cwd=ps_root, env=child_env)
    ps = ps_root / "node_modules/pokemon-showdown"
    cfg = (ps / "config/config-example.js").read_text()
    cfg += ('\n// shwdn2op UU self-play: loopback-only private server, no REPL sockets\n'
            'exports.port = 8000;\nexports.bindaddress = "127.0.0.1";\nexports.watchconfig = false;\nexports.repl = false;\n')
    (ps / "config/config.js").write_text(cfg, newline="\n")
    for d in ("logs/repl", "logs/chat", "logs/modlog", "logs/tickets", "config/chat-plugins"):
        (ps / d).mkdir(parents=True, exist_ok=True)
    with open(logs / "team-audit.json", "wb") as out:
        subprocess.run([str(node), str(K / "audit_teams.cjs"), str(ps), str(src / "metamon/tokenizer/DefaultObservationSpace-v1.json"),
                        str(teams / "uu_train_v1"), str(teams / "uu_dev_v1"), str(teams / "uu_held_out_v1")],
                       stdout=out, check=True, env=child_env)
    audit = json.loads((logs / "team-audit.json").read_text())
    print("team audit", {k: audit[k] for k in ("files", "valid", "distinctValidTeams", "missingTokens")})

    check = (f"import metamon, amago, torch, windowed_attention; from metamon.config import SUPPORTED_BATTLE_FORMATS as F; "
             f"from metamon.rl import pretrained; R={str(run_dir)!r}; "
             f"assert metamon.__file__.startswith(R) and amago.__file__.startswith(R) and windowed_attention.__file__.startswith(R); "
             f"assert 'gen9uu' in F and hasattr(pretrained, 'UUKakuna'); d={a.device!r}; "
             f"assert d == 'cpu' or (torch.cuda.is_available() if d == 'cuda' else torch.backends.mps.is_available()); "
             f"print('step0 ok', torch.__version__, d)")
    print(subprocess.run([str(py), "-c", check], env=child_env, capture_output=True, text=True, check=True).stdout.strip())
    manifest = {"kit": {f.name: sha(f) for f in sorted(K.iterdir()) if f.is_file()},
                "ext/windowed_attention.py": sha(run_dir / "ext/windowed_attention.py"),
                "base-window.gin": sha(run_dir / "base-window.gin"), "checkpoint": CKPT_SHA,
                "metamon_tree_sha256": tree, "amago": {rel: sha(src / rel) for rel in pins["amago"]},
                "node": str(node), "python": str(py), "device": a.device}
    (run_dir / "setup-manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print("setup ok", run_dir)


if __name__ == "__main__":
    main()
