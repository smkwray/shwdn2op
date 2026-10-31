#!/usr/bin/env python3
"""Socketless, single-side Kakuna worker; JSON-lines v2 on stdin/stdout.

Runtime (installed by the match owner, NEVER downloaded by this worker):
  metamon: the project's MIT fork vendor/metamon (upstream 0a00a759 plus the own-side
    Illusion decoder fix), assembled by vendor/metamon/assemble.py; the imported package's
    tree hash must equal scripts/uu_selfplay/source-pins.json metamon.tree_sha256
  UT-Austin-RPL/poke-env git e1268d270c3f2bd32c7ff5713e01062302020579, 0.8.3.3
  UT-Austin-RPL/amago v3.4.0 / 0974781a9096ff43df1b708312256f96fc2ab127
  Python >=3.10, torch >=2.6, CUDA, flash-attn 2.x, upstream dependencies.
  --attention-backend flex selects official AMAGO SlidingWindowFlexAttention
  (window 96) instead, pinned to torch 2.11.0+cu130 for Kakuna's head_dim=75;
  requires separate GPU qualification, never auto-fallback or Flash parity.
Install poke-env and amago from pinned VCS URLs (pip direct_url metadata is checked)
and put the assembled fork first on the path. METAMON_CACHE_DIR must be a writable,
isolated scratch directory.
Launch: /absolute/venv/bin/python -u /absolute/repo/scripts/metamon-worker.py \
  --checkpoint /assets/kakuna/ckpts/policy_weights/policy_epoch_34.pt --seed 123
HF revision ac8e88e7da8dc2a2b85176d88f81fd8854b1445b; SHA256 below is its LFS oid.

Sources in the Metamon fork:
  env/metamon_player.py: _handle_battle_message, teampreview
  env/metamon_battle.py: MetamonBackendBattle.parse_message / parse_request
  interface.py: UniversalState, UniversalAction.to_BattleOrder
  rl/pretrained.py: Kakuna.initialize_agent (only checkpoint path overridden)
  rl/metamon_to_amago.py: make_placeholder_env / illegal-action mask
AMAGO pin: experiment.py:interact, envs/amago_env.py, hindsight.py:Timestep.
No network/player/server, model reimplementation, alternative action policy or
saved replays. Preview uses official random_teampreview, not a learned lead.
One process = one side = one match. New process resets recurrence/observations.
Gen 9 OU is the baseline; literal Gen 9 UU is experimental/out_of_distribution,
not trained UU support. The same checkpoint and 13-action contract are used.
"""

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import logging
import os
from pathlib import Path
import random
import re
import signal
import sys
import threading

VERSION = "metamon-worker@2"
FORK = Path(__file__).resolve().parents[1] / "vendor/metamon"
FORK_PINS = Path(__file__).resolve().parent / "uu_selfplay/source-pins.json"
POKE_ENV_COMMIT = "e1268d270c3f2bd32c7ff5713e01062302020579"
AMAGO_COMMIT = "0974781a9096ff43df1b708312256f96fc2ab127"
CHECKPOINT_SHA256 = "7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c"
MAX_FRAME = 262_144
TRAPPED_ERROR = "|error|[Unavailable choice] Can't switch: The active Pokémon is trapped"


class WorkerError(Exception):
    pass


def require(condition, code="protocol"):
    if not condition:
        raise WorkerError(code)


class RpcInput:
    """One bounded reader, independent of imports/inference in the RPC thread.

    This is a full-duplex request/reply protocol, not a batch stdin interface:
    EOF before the reply is flushed cancels the worker and its compiler tree.
    EOF after a reply exits normally. The lock orders EOF against reply flush,
    including the race where the peer closes immediately upon seeing the reply.
    Only this reader touches stdin; no polling, competing reads or unbounded queue.
    """

    def __init__(self):
        require(os.name == "posix", "runtime")  # Qualified runtime: Linux/WSL, not native Windows.
        self.pid = os.getpid()
        # The CLI may already be a session leader (TS detached spawn).
        # Never signal an inherited SSH/shell group. Fail if isolation fails.
        if os.getsid(0) != self.pid:
            os.setsid()
        require(os.getsid(0) == self.pid and os.getpgrp() == self.pid, "runtime")
        self.condition = threading.Condition()
        self.frame = None
        self.busy = False
        self.eof = False
        threading.Thread(target=self._read, name="metamon-stdin", daemon=True).start()

    def _cancel(self):
        # Check ownership again at the point of signalling. SIGKILL also
        # reaches compiler children that ignore SIGTERM during cancellation.
        try:
            if os.getsid(0) == self.pid and os.getpgrp() == self.pid:
                os.killpg(self.pid, signal.SIGKILL)
        finally:
            os._exit(1)  # Failed ownership is never permission to kill another group.

    def _read(self):
        try:
            while True:
                raw = sys.stdin.buffer.readline(MAX_FRAME + 1)
                with self.condition:
                    if not raw:
                        if self.busy:
                            self._cancel()
                        self.eof = True
                        self.condition.notify()
                        return
                    # One in-flight RPC and at most one bounded frame. A peer
                    # violating request/reply cannot hide EOF behind a full queue.
                    if self.frame is not None:
                        self._cancel()
                    self.frame = raw
                    self.busy = True
                    self.condition.notify()
        except BaseException:
            self._cancel()

    def readline(self):
        with self.condition:
            self.condition.wait_for(lambda: self.frame is not None or self.eof)
            raw, self.frame = self.frame, None
            return raw

    def reply(self, wire, response):
        with self.condition:
            wire.write(json.dumps(response, separators=(",", ":")) + "\n")
            wire.flush()
            self.busy = self.frame is not None


def check_identity(identity, room):
    require(isinstance(identity, dict) and set(identity) == {
        "roomId", "rqid", "snapshotHash", "legalActionSetHash", "stateRevision", "requestKind"
    }, "identity")
    require(identity["roomId"] == room and type(identity["stateRevision"]) is int
            and identity["stateRevision"] > 0 and isinstance(identity["requestKind"], str), "identity")
    require(identity["rqid"] is None or (type(identity["rqid"]) is int and identity["rqid"] >= 0), "identity")
    for key in ("snapshotHash", "legalActionSetHash"):
        require(isinstance(identity[key], str) and re.fullmatch(r"sha256:[a-f0-9]{64}", identity[key]), "identity")


def structural_choice(order, request):
    """Map the OFFICIAL BattleOrder to exact slots in this PRIVATE request.

    Species/details decoding uses poke-env, not nickname heuristics. Reject
    ambiguity (including duplicate identities) instead of guessing a party slot.
    """
    from poke_env.environment import Move, Pokemon
    from poke_env.data import to_id_str
    require(order is not None and not (order.mega or order.z_move or order.dynamax), "official_action")
    if isinstance(order.order, Move):
        active = request.get("active", [])
        require(len(active) == 1 and not any(request.get("forceSwitch", [])), "official_action")
        slots = [i + 1 for i, move in enumerate(active[0]["moves"])
                 if to_id_str(move["id"]) == order.order.id and not move.get("disabled", False)]
        require(len(slots) == 1 and slots[0] <= 4, "official_action")
        require(not order.terastallize or bool(active[0].get("canTerastallize")), "official_action")
        return {"kind": "move", "moveSlot": slots[0], "terastallize": bool(order.terastallize)}
    require(isinstance(order.order, Pokemon) and not order.terastallize, "official_action")
    slots = [i + 1 for i, mon in enumerate(request["side"]["pokemon"])
             if not mon["active"] and Pokemon(gen=9, details=mon["details"]).species == order.order.species]
    require(len(slots) == 1, "official_action")
    return {"kind": "switch", "switchSlot": slots[0]}


def check_choice(choice):
    require(isinstance(choice, dict), "official_action")
    kind = choice.get("kind")
    if kind == "move":
        require(set(choice) == {"kind", "moveSlot", "terastallize"} and type(choice["moveSlot"]) is int
                and 1 <= choice["moveSlot"] <= 4 and type(choice["terastallize"]) is bool, "official_action")
    elif kind == "switch":
        require(set(choice) == {"kind", "switchSlot"} and type(choice["switchSlot"]) is int
                and 1 <= choice["switchSlot"] <= 6, "official_action")
    else:
        require(kind == "team" and set(choice) == {"kind", "team"} and isinstance(choice["team"], list)
                and len(choice["team"]) == 6 and all(type(slot) is int for slot in choice["team"])
                and sorted(choice["team"]) == list(range(1, 7)), "official_action")


class SocketlessBattle:
    """The official decoder is independently testable without torch/weights."""

    def __init__(self):
        self.battle = None
        self.context = None
        self.request = None
        self.rqid = 0
        self.decided_rqid = None
        self.bytes = 0
        self.terminal = False
        self.initialized = False
        self.rechoice = 0  # 0: ordinary, 1: awaiting trapped request, 2: ready to redraw

    def observe(self, data, context, rejected_switch=False):
        from metamon.env.metamon_battle import MetamonBackendBattle
        require(isinstance(data, str) and isinstance(context, dict) and set(context) == {
            "roomId", "side", "format", "sequence", "identity"
        })
        require(context["format"] in ("gen9ou", "gen9uu") and context["side"] in ("p1", "p2"), "unsupported")
        require(isinstance(context["roomId"], str) and re.fullmatch(r"battle-" + context["format"] + r"-[a-zA-Z0-9-]+", context["roomId"]), "unsupported")
        # A pending proposal admits only the exact rejection and its immediately
        # following same-rqid trapped request, together or in two observations.
        retry_request = None
        if rejected_switch:
            lines = [line for line in data.splitlines() if line]
            require(self.rechoice in (0, 1), "identity")
            if self.rechoice == 0:
                require(lines and lines.pop(0) == TRAPPED_ERROR, "official_action")
            require(len(lines) <= 1 and (self.rechoice == 0 or len(lines) == 1), "official_action")
            if lines:
                require(lines[0].startswith("|request|"), "official_action")
                retry_request = json.loads(lines[0][9:])
                require(isinstance(retry_request, dict) and type(retry_request.get("rqid")) is int
                        and retry_request["rqid"] == self.rqid
                        and len(retry_request.get("active", [])) == 1
                        and retry_request["active"][0].get("trapped") is True
                        and not retry_request.get("wait") and not any(retry_request.get("forceSwitch", [])), "identity")
        else:
            require(self.rechoice == 0, "identity")
        previous = self.context
        require(type(context["sequence"]) is int and context["sequence"] == (previous["sequence"] if previous else 0) + 1)
        if context["identity"] is not None:
            check_identity(context["identity"], context["roomId"])
        if previous:
            require(all(context[key] == previous[key] for key in ("roomId", "side", "format")), "private_channel")
            if previous["identity"] is not None and context["identity"] is not None:
                require(context["identity"]["stateRevision"] >= previous["identity"]["stateRevision"], "identity")
        else:
            self.battle = MetamonBackendBattle(context["roomId"], "Offline " + context["side"],
                                               logging.getLogger("metamon-worker"), False, 9)
        self.bytes += len(data.encode("utf8"))
        require(self.bytes <= 16_777_216 and context["sequence"] <= 20_000)
        for line in data.splitlines():
            if not line:
                continue
            require(line.startswith("|") and not line.startswith("|split|"), "private_channel")
            kind = line.split("|", 2)[1]
            if kind == "init":
                # The upstream decoder ignores init, whereas the canonical
                # reducer resets. Never bind stale observations/recurrence to it.
                require(previous is None and not self.initialized and line == "|init|battle")
                self.initialized = True
            require(kind != "error" or (rejected_switch and line == TRAPPED_ERROR), "official_action")  # A rejected prior choice cannot silently advance recurrence.
            if kind == "request":
                request = json.loads(line[9:])
                require(isinstance(request, dict) and request.get("side", {}).get("id") == context["side"], "private_channel")
                require(type(request.get("rqid")) is int and request["rqid"] == self.rqid + (0 if retry_request is not None else 1), "identity")
                party = request["side"].get("pokemon", [])
                require(len(party) == 6 and all(mon.get("ident", "").startswith(context["side"] + ": ") for mon in party), "unsupported")
                require(len(request.get("active", [])) <= 1 and not any(mon.get("reviving") for mon in party), "unsupported")
                self.request, self.rqid = request, request["rqid"]
            # Match the official MetamonPlayer ordering: every message goes to
            # parse_message, then private requests go through parse_request too.
            self.battle.parse_message(line.split("|"))
            if kind == "request":
                self.battle.parse_request(self.request)
            elif kind == "turn":
                self.battle._mm_battle.turnlist = self.battle._mm_battle.turnlist[-2:]
            elif kind in ("win", "tie"):
                self.terminal = True
        self.context = context
        if rejected_switch:
            self.rechoice = 2 if retry_request is not None else 1

    def bind(self, message):
        require(self.context is not None and self.request is not None and not self.terminal, "identity")
        identity = message.get("identity")
        check_identity(identity, self.context["roomId"])
        require(identity == self.context["identity"] and message.get("sequence") == self.context["sequence"]
                and identity["rqid"] == self.rqid and self.decided_rqid != self.rqid, "identity")
        require(not self.request.get("wait"), "identity")
        kind = "team_preview" if self.request.get("teamPreview") else "forced_switch" if any(self.request.get("forceSwitch", [])) else "move"
        require(identity["requestKind"] == kind, "identity")
        require(isinstance(message.get("requestId"), str) and 0 < len(message["requestId"]) <= 256, "identity")
        require(isinstance(message.get("resultHash"), str) and re.fullmatch(r"sha256:[a-f0-9]{64}", message["resultHash"]), "identity")
        # Canonical hashes are opaque here; exact matching to the last ingested
        # context binds them. The TS BattleAgent verifies/rechecks the envelope.
        return {key: message[key] for key in ("requestId", "identity", "resultHash", "sequence")}


class KakunaPolicy:
    def __init__(self, checkpoint, seed, attention="flash"):
        import numpy as np
        import torch
        import amago
        from metamon.rl.pretrained import Kakuna
        from metamon.rl.metamon_to_amago import make_placeholder_env
        require(amago.__version__ == "3.4.0" and torch.cuda.is_available(), "runtime")
        require(tuple(map(int, torch.__version__.split("+")[0].split(".")[:2])) >= (2, 6), "runtime")
        if attention == "flash":
            require(importlib.metadata.version("flash-attn").split(".")[0] == "2", "runtime")
        else:
            require(attention == "flex" and torch.__version__ == "2.11.0+cu130", "runtime")
        torch.set_num_threads(1)
        torch.manual_seed(seed)
        np.random.seed(seed)
        self.model = Kakuna()
        # Official extension point, called AFTER gin files are parsed and BEFORE
        # the experiment is built. base_config/gin_overrides would be overwritten
        # by superkazam.gin in AMAGO use_config, so bind the explicit backend here.
        def local_checkpoint(epoch):
            require(epoch == 34, "provenance")
            import gin
            # Preserve upstream's value as an integer: Python 3.12 randint
            # rejects its float default 1e10 when building the placeholder env.
            gin.bind_parameter("MetamonAMAGOExperiment.traj_save_len", 10_000_000_000)
            if attention == "flex":
                from amago.nets.transformer import SlidingWindowFlexAttention
                gin.bind_parameter("traj_encoders.TformerTrajEncoder.attention_type", SlidingWindowFlexAttention)
                gin.bind_parameter("transformer.SlidingWindowFlexAttention.window_size", 96)
            return str(checkpoint)
        self.model.get_path_to_checkpoint = local_checkpoint
        self.experiment = self.model.initialize_agent(checkpoint=34, log=False)
        require(self.experiment.DEVICE.type == "cuda", "runtime")
        self.policy = self.experiment.policy
        self.policy.eval()
        self.seed = seed
        # Keep the actor's sampling distribution for propose's legal redraw.
        actor_forward = self.policy.actor.forward
        def capture(*args, **kwargs):
            self.last_dist = actor_forward(*args, **kwargs)
            return self.last_dist
        self.policy.actor.forward = capture
        from amago.nets.transformer import SelfAttention, FlashAttention, SlidingWindowFlexAttention
        expected_attention = FlashAttention if attention == "flash" else SlidingWindowFlexAttention
        layers = [module for module in self.policy.modules() if isinstance(module, SelfAttention)]
        require(len(layers) == 10 and all(type(module) is expected_attention for module in layers), "runtime")
        self.wrapper = make_placeholder_env(self.model.observation_space, self.model.action_space)
        self.model.observation_space.reset()
        self.hidden = self.policy.traj_encoder.init_hidden_state(1, self.experiment.DEVICE)
        self.previous_state = None
        self.previous_action = np.zeros((1, self.wrapper.action_size), dtype=self.wrapper.action_dtype)
        self.step = 0
        self.pending = None

    def redraw(self, legal):
        import torch
        # Upstream clamps every masked probability up to clip_prob_low (0.001) before
        # sampling, so illegal indices keep ~0.1% each. Redrawing from the legal-only
        # conditional is exactly the policy renormalized over legal actions, and it
        # leaves every legal first draw, and its RNG path, unchanged. A trapped
        # rejection uses this same conditional and generator, without another forward.
        probs = self.last_dist.probs[0, -1, -1].float()
        keep = torch.zeros_like(probs)
        keep[legal] = 1.0
        probs = probs * keep
        require(bool(probs.sum() > 0), "official_action")
        return int(torch.multinomial(probs / probs.sum(), 1).item())

    def propose(self, battle, request, rechoose=False):
        import numpy as np
        import torch
        from amago.hindsight import Timestep
        from metamon.interface import UniversalState, UniversalAction
        require((self.pending is not None) == rechoose, "identity")
        state = UniversalState.from_Battle(battle)
        legal = [self.model.action_space.action_to_agent_output(state, action)
                 for action in UniversalAction.definitely_valid_actions(state, battle)]
        require(legal, "official_action")
        if rechoose:
            self.redrawn = True
            action = self.redraw(legal)
        else:
            obs = self.model.observation_space.state_to_obs(state)
            self.wrapper.add_illegal_action_mask_to_obs(obs, {"legal_actions": legal})
            reward = 0.0 if self.previous_state is None else self.model.reward_function(self.previous_state, state)
            timestep = Timestep(obs={k: v[np.newaxis, ...] for k, v in obs.items()},
                                prev_action=self.previous_action, reward=np.array([reward], dtype=np.float32),
                                terminal=np.zeros(1, dtype=bool), time_idx=np.array([self.step], dtype=np.int64), batched_envs=1)
            obs, rl2, time_idx = timestep.as_input()
            tensor = lambda array: torch.from_numpy(array).to(self.experiment.DEVICE).unsqueeze(1)
            self.last_dist = None
            with torch.no_grad(), self.experiment.caster():
                actions, self.hidden = self.policy.get_actions(obs={k: tensor(v) for k, v in obs.items()},
                    rl2s=tensor(rl2), time_idxs=tensor(time_idx), sample=True, hidden_state=self.hidden)
                action = int(actions.item())
                self.redrawn = action not in legal
                if self.redrawn:
                    action = self.redraw(legal)
        require(action in legal, "official_action")
        order = self.model.action_space.agent_output_to_action(state, action).to_BattleOrder(battle)
        choice = structural_choice(order, request)
        # Retain the inverse mapping now: later moves/party order can differ.
        choices = []
        for index in legal:
            origin_order = self.model.action_space.agent_output_to_action(state, index).to_BattleOrder(battle)
            choices.append((structural_choice(origin_order, request), index))
        self.pending = (state, choices)
        # Upstream maps every move index to the one order when Struggle or Recharge is
        # the only move, so several indices can name the same executed action.
        moves = (request.get("active") or [{}])[0].get("moves", [])
        forced = len(moves) == 1 and moves[0].get("id") in ("struggle", "recharge")
        self.pending_alias = (action, forced)
        if not rechoose:
            self.step += 1
        require(self.step <= 10_000)
        return choice

    def resolve_index(self, choice):
        """The single agent index whose action representation records `choice`."""
        require(self.pending is not None, "identity")
        check_choice(choice)
        matches = sorted({index for candidate, index in self.pending[1] if candidate == choice})
        require(matches, "official_action")
        if len(matches) == 1:
            return matches[0]
        # Aliases are the same game action, so only the recurrent input is at stake: keep
        # the policy's own sample when it was executed, else the lowest alias (upstream
        # replays record Struggle as index 0). Any other ambiguity stays an error.
        sampled, forced = self.pending_alias
        require(forced, "official_action")
        return sampled if sampled in matches else matches[0]

    def commit(self, choice):
        import numpy as np
        index = self.resolve_index(choice)
        self.previous_action = self.wrapper.make_action_rep(np.array([[index]], dtype=np.int64))
        self.previous_state = self.pending[0]
        self.pending = None


def side_seed(seed, side):
    require(side in ("p1", "p2"), "identity")
    return int.from_bytes(hashlib.sha256(f"{seed}:{side}".encode()).digest()[:4], "big") >> 1


def check_runtime(checkpoint):
    require(checkpoint.is_file() and checkpoint.name == "policy_epoch_34.pt"
            and checkpoint.stat().st_size == 571_581_627, "missing_assets")
    digest = hashlib.sha256()
    with checkpoint.open("rb") as file:
        for chunk in iter(lambda: file.read(1_048_576), b""):
            digest.update(chunk)
    require(digest.hexdigest() == CHECKPOINT_SHA256, "provenance")
    import metamon
    spec = importlib.util.spec_from_file_location("metamon_fork_assemble", FORK / "assemble.py")
    assemble = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assemble)
    tree, _ = assemble.tree(Path(metamon.__file__).resolve().parents[1])
    require(tree == json.loads(FORK_PINS.read_text())["metamon"]["tree_sha256"], "provenance")
    for name, version, commit in (("poke-env", "0.8.3.3", POKE_ENV_COMMIT), ("amago", "3.4.0", AMAGO_COMMIT)):
        dist = importlib.metadata.distribution(name)
        require(dist.version == version, "runtime")
        direct = json.loads(dist.read_text("direct_url.json") or "{}")
        require(direct.get("vcs_info", {}).get("commit_id") == commit, "provenance")
    cache = os.environ.get("METAMON_CACHE_DIR")
    require(cache and Path(cache).is_dir() and os.access(cache, os.W_OK), "missing_assets")


def main():
    transport = RpcInput()  # Isolate before upstream libraries or compiler threads.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--seed-per-side", action="store_true",
                        help="Seed the policy from sha256(seed:side), so each actor gets its own stream.")
    parser.add_argument("--attention-backend", choices=("flash", "flex"), default="flash")
    args = parser.parse_args()
    require(0 <= args.seed < 2**32)
    random.seed(args.seed)
    wire = sys.stdout
    sys.stdout = sys.stderr  # All upstream imports/logging stay off the JSON wire.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["WANDB_MODE"] = "disabled"
    os.environ.pop("METAMON_ALLOW_ANY_POKE_ENV", None)

    def no_network(event, _args):
        if event in ("socket.connect", "socket.getaddrinfo"):
            raise WorkerError("runtime")
    sys.addaudithook(no_network)
    decoder, policy, checked, serial = SocketlessBattle(), None, False, 0
    pending, committed = None, None
    while True:
        raw = transport.readline()
        if not raw:
            return
        message = None
        code = "protocol"
        try:
            require(len(raw) <= MAX_FRAME and raw.endswith(b"\n"))
            message = json.loads(raw)
            require(isinstance(message, dict) and message.get("version") == VERSION
                    and type(message.get("id")) is int and message["id"] == serial + 1)
            serial = message["id"]
            if not checked:
                code = "runtime"
                check_runtime(args.checkpoint)
                # The pinned policy import initializes baseline GenData directly.
                # It must precede the decoder's cached GenData.from_gen(9), or
                # the first decide fails with "GenData ... already initialized".
                # Import only; weights and recurrence remain lazy until decide.
                import metamon.rl.pretrained
                checked = True
            if message.get("op") == "observe":
                require(set(message) == {"version", "id", "op", "data", "context"})
                if pending is not None:
                    require(pending["choice"]["kind"] == "switch", "identity")
                code = "official_parser"
                if pending is None:
                    decoder.observe(message["data"], message["context"])
                else:
                    decoder.observe(message["data"], message["context"], True)
                payload = {"context": decoder.context}
            elif message.get("op") == "stage_switch":
                # Human-only adapter: record the submitted switch as the pending
                # proposal, without committing it or changing sample/recurrence.
                require(set(message) == {"version", "id", "op", "requestId", "identity", "resultHash", "sequence", "choice"})
                binding = decoder.bind(message)
                choice = message["choice"]
                check_choice(choice)
                require(pending is not None and decoder.rechoice == 0 and binding == pending["binding"]
                        and choice["kind"] == "switch" and not decoder.request.get("teamPreview"), "identity")
                policy.resolve_index(choice)  # Must be in the original definitely-valid mapping.
                pending = {"binding": binding, "choice": choice}
                payload = pending
            elif message.get("op") == "commit":
                require(set(message) == {"version", "id", "op", "requestId", "identity", "resultHash", "sequence", "choice"})
                require(decoder.rechoice == 0, "identity")
                binding = {key: message[key] for key in ("requestId", "identity", "resultHash", "sequence")}
                choice = message["choice"]
                check_choice(choice)
                if pending is None:
                    require(committed == (binding, choice) and decoder.context["identity"] == binding["identity"], "identity")
                else:
                    require(binding == pending["binding"], "identity")
                    if decoder.request.get("teamPreview"):
                        require(choice["kind"] == "team", "official_action")
                    else:
                        policy.commit(choice)
                    decoder.decided_rqid = decoder.rqid
                    committed = (binding, choice)
                    pending = None
                payload = {"binding": binding, "choice": choice}
            else:
                require(message.get("op") == "propose" and set(message) == {
                    "version", "id", "op", "requestId", "identity", "resultHash", "sequence"})
                binding = decoder.bind(message)
                if pending is not None and decoder.rechoice:
                    require(decoder.rechoice == 2 and binding["identity"]["rqid"] == pending["binding"]["identity"]["rqid"]
                            and binding["identity"] != pending["binding"]["identity"], "identity")
                    choice = policy.propose(decoder.battle, decoder.request, True)
                    pending = {"binding": binding, "choice": choice}
                    decoder.rechoice = 0
                    payload = pending
                elif pending is not None:
                    require(pending["binding"] == binding, "identity")
                    payload = pending
                elif policy is None:
                    code = "runtime"
                    policy = KakunaPolicy(args.checkpoint, side_seed(args.seed, decoder.context["side"])
                                          if args.seed_per_side else args.seed, args.attention_backend)
                if pending is None:
                    code = "official_action"
                    if decoder.request.get("teamPreview"):
                        from poke_env.player import Player
                        if args.seed_per_side:
                            # The preview draws from the global `random`, seeded once with the base seed, so both
                            # sides of a slot produced the same permutation. Give each side its own stream.
                            random.seed(side_seed(args.seed, decoder.context["side"]))
                        preview = Player.random_teampreview(None, decoder.battle)
                        require(re.fullmatch(r"/team [1-6]{6}", preview), "official_action")
                        team = [int(slot) for slot in preview[6:]]
                        require(len(set(team)) == 6, "official_action")
                        choice = {"kind": "team", "team": team}
                    else:
                        choice = policy.propose(decoder.battle, decoder.request)
                    pending = {"binding": binding, "choice": choice}
                    payload = pending
            response = {"version": VERSION, "id": serial, "ok": True, **payload}
        except Exception as error:
            response = {"version": VERSION, "id": message.get("id") if isinstance(message, dict) else None,
                        "ok": False, "error": str(error) if isinstance(error, WorkerError) else code}
            transport.reply(wire, response)
            return 1  # Partially advanced parser/recurrent state is never reused.
        transport.reply(wire, response)


if __name__ == "__main__":
    sys.exit(main())
