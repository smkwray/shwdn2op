"""Pinned, offline observation/commit path shared by all inference backends."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tmp/metamon-port"
CHECKPOINT = OUT / "ckpt/policy_epoch_34.pt"
COHORT = ROOT / "tmp/shwdn2op-r60-veto-MWis249x/cohort"
SOURCE = OUT / "fork"  # vendor/metamon assembled with its upstream data (assemble.py build)
WORKER_SHA = "917558eddf56e58dd1cd05332974df11d937549542fc4bc3674c8323d05ab5e9"
CKPT_SHA = "7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c"
DEFAULT_GAMES = ["drew-uu03-b-p2-s3", "alex-uu01-b-p1-s3", "avery-uu01-b-p2-s3"]


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def setup(backend="torch-cpu"):
    """Run before third-party imports; contain caches and forbid network connections."""
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ[name] = "4"
    for name, value in {
        "METAMON_CACHE_DIR": "cache/metamon", "XDG_CACHE_HOME": "cache/xdg",
        "HF_HOME": "cache/hf", "TORCH_HOME": "cache/torch",
        "TORCHINDUCTOR_CACHE_DIR": "cache/inductor", "TRITON_CACHE_DIR": "cache/triton",
        "MPLCONFIGDIR": "cache/matplotlib", "TMPDIR": "scratch",
    }.items():
        path = OUT / value
        path.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(path)
    os.environ.update(HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", WANDB_MODE="disabled",
                      PYTHONDONTWRITEBYTECODE="1", PYTORCH_ENABLE_MPS_FALLBACK="0",
                      TORCHDYNAMO_DISABLE="0" if backend == "torch-cuda-flex" else "1",
                      TORCHINDUCTOR_COMPILE_THREADS="1", MAX_JOBS="1")
    sys.dont_write_bytecode = True
    def offline(event, args):
        if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto"):
            raise RuntimeError("Network is forbidden in the offline parity harness")
    sys.addaudithook(offline)


def worker_module():
    path = ROOT / "scripts/metamon-worker.py"
    if digest(path) != WORKER_SHA:
        raise RuntimeError("Pinned worker changed")
    spec = importlib.util.spec_from_file_location("pinned_metamon_worker", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def configure_model(source=SOURCE):
    import amago
    import gin
    from metamon.rl.pretrained import Kakuna
    model = Kakuna()
    # The prepared wheel omitted package-data gin files. Read the existing pinned
    # source copy; never change the wheel or invoke the downloader.
    config = Path(source) / "metamon/rl/configs"
    model.model_gin_config_path = str(config / "models/superkazam.gin")
    model.train_gin_config_path = str(config / "training/kakuna.gin")
    amago.cli_utils.use_config(model.base_config | {"MetamonDiscrete.temperature": 1.0},
                               [model.model_gin_config_path, model.train_gin_config_path], finalize=False)
    gin.bind_parameter("MetamonAMAGOExperiment.traj_save_len", 10_000_000_000)
    return model


class ObservationPath:
    """Reuse the official decoder, Timestep, action representation and worker commit.

    Only propose's inference call is replaced. Recorded structural actions are
    committed, never backend argmax/samples, so future inputs remain identical.
    """

    def __init__(self, model, worker):
        import numpy as np
        from metamon.rl.metamon_to_amago import make_placeholder_env
        self.worker = worker
        self.policy = worker.KakunaPolicy.__new__(worker.KakunaPolicy)
        p = self.policy
        p.model = model
        p.wrapper = make_placeholder_env(model.observation_space, model.action_space)
        model.observation_space.reset()
        p.previous_state = None
        p.previous_action = np.zeros((1, p.wrapper.action_size), dtype=p.wrapper.action_dtype)
        p.step, p.pending = 0, None

    def prepare(self, battle, request, choice):
        import numpy as np
        from amago.hindsight import Timestep
        from metamon.interface import UniversalState, UniversalAction
        p = self.policy
        state = UniversalState.from_Battle(battle)
        legal = [p.model.action_space.action_to_agent_output(state, a)
                 for a in UniversalAction.definitely_valid_actions(state, battle)]
        if not legal:
            raise RuntimeError("No official legal action")
        obs = p.model.observation_space.state_to_obs(state)
        p.wrapper.add_illegal_action_mask_to_obs(obs, {"legal_actions": legal})
        reward = 0.0 if p.previous_state is None else p.model.reward_function(p.previous_state, state)
        t = Timestep(obs={k: v[np.newaxis, ...] for k, v in obs.items()},
                     prev_action=p.previous_action, reward=np.array([reward], np.float32),
                     terminal=np.zeros(1, bool), time_idx=np.array([p.step], np.int64), batched_envs=1)
        choices = []
        for index in legal:
            order = p.model.action_space.agent_output_to_action(state, index).to_BattleOrder(battle)
            choices.append((self.worker.structural_choice(order, request), index))
        p.pending = (state, choices)
        matches = sorted({index for candidate, index in choices if candidate == choice})
        if not matches:
            raise RuntimeError(f"Recorded commit is not an official legal action: {choice}")
        # Full structural recordings cannot identify the original random index
        # among Struggle/Recharge aliases. Match upstream's canonical index and
        # expose every ambiguous mapping in the dump, rather than hiding it.
        moves = (request.get("active") or [{}])[0].get("moves", [])
        forced = len(moves) == 1 and moves[0].get("id") in ("struggle", "recharge")
        p.pending_alias = (matches[0], forced)
        p.step += 1
        return (*t.as_input(), legal, matches)

    def commit(self, choice):
        self.policy.commit(choice)


def structural_record(record):
    action = record["actionId"]
    if action.startswith("switch:"):
        return {"kind": "switch", "switchSlot": int(action.split(":")[1])}
    if action.startswith("move:"):
        slot, tera = action[5:].split("|tera=")
        return {"kind": "move", "moveSlot": int(slot), "terastallize": bool(int(tera))}
    raise ValueError(action)


def replay(game, side, path):
    """Yield real decision inputs after each recorded private protocol chunk."""
    trajectory = [json.loads(l) for l in (game / "trajectory.jsonl").read_text().splitlines()]
    commits = {}
    for row in trajectory:
        if row["side"] == side and row.get("accepted"):
            if row["rqid"] in commits:
                raise RuntimeError("Multiple accepted commits for one request")
            commits[row["rqid"]] = row
    decoder = path.worker.SocketlessBattle()
    done = set()
    for sequence, raw in enumerate((game / f"{side}-private.jsonl").read_text().splitlines(), 1):
        data = json.loads(raw)
        if not isinstance(data, str):
            raise TypeError("Expected private protocol string")
        # The input recording retains protocol chunks, not TS snapshot hashes.
        # Identity is intentionally None: SocketlessBattle's real parse path is
        # used; this harness does not claim TS bind/envelope qualification.
        context = {"roomId": "battle-gen9uu-offline", "side": side, "format": "gen9uu",
                   "sequence": sequence, "identity": None}
        decoder.observe(data, context)
        rqid = decoder.rqid
        if rqid in done or rqid not in commits or decoder.terminal:
            continue
        row = commits[rqid]
        if decoder.request.get("wait"):
            raise RuntimeError("Commit on a wait request")
        done.add(rqid)
        if decoder.request.get("teamPreview"):
            continue  # Official preview is random; it never advances the network.
        choice = structural_record(row)
        obs, rl2, time_idx, legal, aliases = path.prepare(decoder.battle, decoder.request, choice)
        yield row, obs, rl2, time_idx, legal, aliases, sequence
        path.commit(choice)
    if done != set(commits):
        raise RuntimeError(f"Unreplayed commits: {set(commits) - done}")
