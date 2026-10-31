"""League member launcher for heterogeneous UU self-play (block_portable.py --league).

Same arguments as metamon.rl.evaluate.ladder_self_play.serve_model; the account's `model_name` in the ladder
YAML selects what plays:
  UUKakuna               pinned epoch-34 Kakuna (run source registration, UU_KAKUNA_CKPT)
  UUExport               Kakuna-architecture export (export_candidate.py) at UU_EXPORT_DIR/policy_epoch_<c>.pt;
                         the agent's `sha256: {<c>: <hex>}` entry is verified before loading
  League<Name>           an upstream Gen-9-capable registry policy (Kakuna, Superkazam, Alakazam, Kadabra..4, Abra,
                         SmallRLGen9Beta, Minikazam) with its attention rebound to this run's attention class (the
                         UU_BASE_GIN template: windowed vanilla on CPU/MPS/ROCm, flex on CUDA) at its own window
  baseline:<Name>        a registered Metamon/poke-env heuristic (metamon.baselines), laddering with the account's
                         team set; it writes no trajectories (its opponents' POVs are the data)
Registrations happen in this process only; the pinned source is not modified. Upstream checkpoints load from
METAMON_CACHE_DIR/pretrained_models (HF offline at run time); fetch them once with
  python league_serve.py --prefetch LEAGUE.yaml        (needs HF_HUB_OFFLINE=0)
"""

import asyncio
import hashlib
import os
import re
import runpy
import sys
import tempfile
from pathlib import Path

# Keep the kit directory off the import path: its amago patch scripts (flex_train_*.py) run on import.
sys.path = [p for p in sys.path if Path(p or ".").resolve() != Path(__file__).resolve().parent]

UPSTREAM = ["Kakuna", "Superkazam", "Alakazam", "Kadabra4", "Kadabra3", "Kadabra2", "Kadabra", "Abra",
            "SmallRLGen9Beta", "Minikazam"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()


def window_of(m):
    """Attention window the policy was trained with (FlashAttention (W, 0)); None for recurrent policies."""
    w = (m.gin_overrides or {}).get("amago.nets.transformer.FlashAttention.window_size")
    if w:
        return int(w[0])
    found = re.search(r"FlashAttention\.window_size\s*=\s*\((\d+)", Path(m.model_gin_config_path).read_text())
    return int(found.group(1)) if found else None


def rebound_gin(train_gin_path, window):
    """This run's UU_BASE_GIN with the policy's own training gin and window substituted."""
    text = Path(os.environ["UU_BASE_GIN"]).read_text()
    text, n_inc = re.subn(r"include '[^']*'", f"include '{Path(train_gin_path).as_posix()}'", text)
    text, n_win = re.subn(r"window_size = \d+", f"window_size = {window}", text)
    if (n_inc, n_win) != (1, 1):
        raise RuntimeError("UU_BASE_GIN is not a one-include, one-window template")
    # Per process (no torn reads), in the run's scratch: env.json sets TMPDIR (POSIX) or TEMP/TMP (Windows, where a
    # literal "/tmp" would mean C:\tmp).
    out = Path(tempfile.gettempdir()) / f"league-{Path(train_gin_path).stem}-w{window}-{os.getpid()}.gin"
    out.write_text(text, newline="\n")
    return str(out)


def register():
    from metamon.rl import pretrained

    for name in UPSTREAM:
        base = pretrained.ALL_PRETRAINED_MODELS[name]

        def __init__(self, _base=base):
            _base.__init__(self)
            w = window_of(self)
            if w is not None:
                self.train_gin_config_path = rebound_gin(self.train_gin_config_path, w)

        pretrained.pretrained_model()(type(f"League{name}", (base,), {"__init__": __init__}))

    class UUExport(pretrained.Kakuna):
        def __init__(self):
            super().__init__()
            self.train_gin_config = self.train_gin_config_path = os.environ["UU_BASE_GIN"]

        def get_path_to_checkpoint(self, checkpoint):
            path = Path(os.environ["UU_EXPORT_DIR"]) / f"policy_epoch_{checkpoint}.pt"
            if not path.is_file():
                raise FileNotFoundError(path)
            return str(path)

    pretrained.pretrained_model()(UUExport)


def account(config_path, username):
    from metamon.rl.evaluate.common import load_config, merge_defaults

    cfg = load_config(config_path)
    return merge_defaults(cfg.get("defaults", {}), cfg["agents"][username] or {})


def run_baseline(name, acct, args):
    from poke_env import AccountConfiguration, LocalhostServerConfiguration
    from metamon.baselines import get_baseline
    from metamon.env import get_metamon_teams
    from metamon.rl.evaluate.common import random_choice

    team_set = random_choice(acct["team_set"])
    print(f"baseline {name} team_set {team_set} games {args.n_challenges}", flush=True)
    player = get_baseline(name)(
        battle_format=args.format, team=get_metamon_teams(args.format, team_set), max_concurrent_battles=1,
        account_configuration=AccountConfiguration(args.username, None),
        server_configuration=LocalhostServerConfiguration)
    asyncio.run(player.ladder(args.n_challenges))
    print(f"baseline {name} finished {player.n_finished_battles} won {player.n_won_battles}", flush=True)


def main():
    import argparse

    if sys.argv[1:2] == ["--prefetch"]:
        from metamon.rl.evaluate.common import load_config
        from metamon.rl.pretrained import get_pretrained_model

        register()
        cfg = load_config(sys.argv[2])
        for user, agent in cfg["agents"].items():
            name = (agent or {}).get("model_name", cfg["defaults"].get("model_name"))
            if name.startswith("League"):
                m = get_pretrained_model(name)
                for c in (agent.get("checkpoints") or cfg["defaults"]["checkpoints"]):
                    c = c if c is not None else m.default_checkpoint
                    p = m.get_path_to_checkpoint(c)
                    # Strict-load what was fetched (the same path serve_model takes) and report the bound attention.
                    import gin
                    gin.clear_config()
                    exp = get_pretrained_model(name).initialize_agent(checkpoint=c)
                    attn = {type(mod).__name__ for mod in exp.policy.modules() if "Attention" in type(mod).__name__}
                    print(f"{user} {name} {c} {p} {os.path.getsize(p)} {sha256(p)} attention={sorted(attn)}", flush=True)
                    del exp
        return 0
    ap = argparse.ArgumentParser()
    for flag in ("--username", "--format", "--config", "--save_trajectories_to"):
        ap.add_argument(flag, required=flag != "--save_trajectories_to")
    ap.add_argument("--n_challenges", type=int, default=10)
    args, _ = ap.parse_known_args()
    acct = account(args.config, args.username)
    name = acct["model_name"]
    if name.startswith("baseline:"):
        return run_baseline(name.split(":", 1)[1], acct, args)
    if name == "UUExport":
        want = {int(k): v for k, v in (acct.get("sha256") or {}).items()}
        for c in acct["checkpoints"]:
            path = Path(os.environ["UU_EXPORT_DIR"]) / f"policy_epoch_{c}.pt"
            if c not in want or sha256(path) != want[c]:
                raise SystemExit(f"UUExport checkpoint {c}: missing or mismatched sha256 pin ({path})")
    register()
    import json,random,numpy as np,torch
    sys.path[:0]=[str(Path(__file__).resolve().parent),str(Path(__file__).resolve().parents[1]/"metamon_port"),str(Path(__file__).resolve().parents[1]/"uu_eval")]
    master=int(os.environ["UU_NATIVE_COLLECTION_SEED"])
    if not 0<=master<2**32:raise ValueError("Explicit native collection seed required")
    actor_seed=int.from_bytes(hashlib.sha256(f"{master}:{args.username}".encode()).digest()[:4],"big")
    random.seed(actor_seed);np.random.seed(actor_seed);torch.manual_seed(actor_seed)
    if name in ("UUKakuna","UUExport"):
        from native_legal import register_native
        eligible=os.environ["UU_NATIVE_TRAINING_ELIGIBLE"]
        if eligible not in ("0","1"):raise ValueError("Explicit native replay eligibility required")
        epoch=int(acct["checkpoints"][0]);digest=acct["sha256"][epoch]
        identity="metamon:Kakuna:epoch34" if name=="UUKakuna" else f"metamon:UUFinetuned:{Path(os.environ['UU_EXPORT_DIR']).parents[1].name}:{epoch}"
        backend=acct.get("native_backend","torch")
        if backend not in ("torch","mlx_backbone_cpu_actor"):raise ValueError("Unknown native inference backend")
        backbone=json.loads(Path(os.environ["UU_NATIVE_BACKBONE_CONFIG"]).read_bytes()) if backend=="mlx_backbone_cpu_actor" else None
        register_native(name,Path(os.environ["R"])/"native-traces"/args.username,master,
            {"model":"G0" if name=="UUKakuna" else "G1","policy_id":identity,"checkpoint_sha256":digest,
             "purpose":"selfplay" if eligible=="1" else "progress","training_eligible":eligible=="1"},backbone_config=backbone,
            lead_checkpoint=os.environ['UU_NATIVE_LEAD_CHECKPOINT'])
    if name == "UUE3MLX":
        import json
        sys.path.insert(0,str(Path(__file__).resolve().parent))
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"metamon_port"))
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"uu_eval"))
        from native_e3_mlx import register as register_e3
        config=json.loads(Path(os.environ["UU_E3_NATIVE_CONFIG"]).read_text())
        config["traceDir"]=str(Path(config["traceDir"])/args.username)
        register_e3(config)
    runpy.run_module("metamon.rl.evaluate.ladder_self_play.serve_model", run_name="__main__", alter_sys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
