"""Team-preview lead probabilities from the Gen 9 UU lead model, on our wrappers' team-preview propose reply.

The pinned worker's preview stays the official random_teampreview draw, committed exactly as before; this module only
adds one reply field `leadModel` to a successful team-preview propose reply:
  {"status": "ok", "checkpointSha256": SHA256, "leadProbabilities": [p(slot 1), ..., p(slot 6)], "inferenceMs": ms}
  {"status": "unavailable", "reason": REASON, "checkpointSha256": SHA256}
REASON: checkpoint_missing | checkpoint_mismatch | load_failed | opponent_not_6 | team_unmatched | inference_failed.
Slots are the request's party order (Showdown's `/team` digits). The model imitates rated human leads (val top-1 44.0%,
test 37.1%; tmp/uu-lead-20261023/receipt.json); it is not evidence of winning more.

Inference uses the pinned live fork's own TeamPreviewModel.predict_lead (upstream preview.py) with battle_format=None,
verified equal to the training fork's gen9uu path on 300 POVs (tmp/uu-lead-20261023/pinned-equivalence.json, max diff
0.0), so nothing from the unpinned patched preview.py is imported. Inputs follow UniversalState.from_Battle: our names
keep the forme (arcaninehisui), opponent names are base species (arcanine), as in the training data.

install(worker, checkpoint) patches only check_runtime (loads the checkpoint once, right after the runtime/provenance
gates and the pinned policy import that main() performs next), SocketlessBattle.observe (remembers the decoder) and
RpcInput.readline/reply (adds the field). Loading and inference save and restore the Python, NumPy and torch RNG states
and never sample (use_argmax), so no draw, recurrence, legality or existing reply field changes. A failure never stops
the worker: the reply says why, and the companion shows the random lead with that reason.
"""
import contextlib
import hashlib
import json
import math
from pathlib import Path
import random
import sys
import time
import traceback

FIELD = "leadModel"
SHA256 = "317b5a21bebefd6093d3b11ed8e5bf22d07f80045082552736b36e5b4755dd8c"


def preview_order(prediction):
    """Full singles order: lowest-slot argmax, then native slots; consumes no RNG."""
    values = prediction.get("leadProbabilities", [])
    if (prediction.get("status") != "ok" or len(values) != 6
            or any(type(p) not in (int, float) or not math.isfinite(p) or p < 0 for p in values)
            or abs(sum(values) - 1) > 1e-4):
        raise ValueError("Qualified lead prediction unavailable")
    slot = max(range(6), key=values.__getitem__) + 1
    return [slot] + [i for i in range(1, 7) if i != slot]


def log(message):
    sys.stderr.write(f"lead model: {message}\n")
    sys.stderr.flush()


@contextlib.contextmanager
def rng_preserved():
    import numpy as np
    import torch
    states = random.getstate(), np.random.get_state(), torch.get_rng_state()
    try:
        yield
    finally:
        random.setstate(states[0])
        np.random.set_state(states[1])
        torch.set_rng_state(states[2])


def preview_inputs(battle, request):
    """Request-slot-ordered UniversalPokemon for our team and base-species names for the opponent's preview."""
    from metamon.backend.replay_parser.str_parsing import pokemon_name
    from metamon.interface import UniversalPokemon
    opponents = [pokemon_name(p.base_species) for p in battle.teampreview_opponent_team if p is not None]
    if len(opponents) != 6:
        return None, None, "opponent_not_6"
    team = []
    for mon in request["side"]["pokemon"]:
        species = pokemon_name(str(mon.get("details", "")).split(",")[0])
        matches = [p for p in battle.team.values() if pokemon_name(p.species) == species]
        if len(matches) != 1:
            return None, None, "team_unmatched"
        team.append(UniversalPokemon.from_Pokemon(matches[0]))
    if len(team) != 6 or len({p.name for p in team}) != 6:
        return None, None, "team_unmatched"
    return team, opponents, None


def slot_probabilities(probs, sorted_names, team):
    """predict_lead's probabilities over its alphabetical team -> request slots 1..6."""
    slot_of = {p.name: slot for slot, p in enumerate(team)}
    if sorted(sorted_names) != sorted(slot_of) or len(probs) != 6:
        raise ValueError("lead model team does not match the request party")
    result = [0.0] * 6
    for name, p in zip(sorted_names, probs):
        result[slot_of[name]] = float(p)
    total = sum(result)
    if not all(p >= 0 for p in result) or abs(total - 1) > 1e-4:
        raise ValueError("lead probabilities are not a distribution")
    return [p / total for p in result]


class LeadModel:
    def __init__(self, checkpoint, expected=SHA256):
        self.checkpoint, self.expected = Path(checkpoint), expected
        self.model, self.reason, self.load_ms = None, "load_failed", None

    def unavailable(self, reason):
        return {"status": "unavailable", "reason": reason, "checkpointSha256": self.expected}

    def load(self):
        """Once per worker. Never raises; a refusal is kept as the reply's reason and logged."""
        started = time.perf_counter()
        try:
            if not self.checkpoint.is_file():
                self.reason = "checkpoint_missing"
                log(f"checkpoint missing: {self.checkpoint}")
                return
            with self.checkpoint.open("rb") as file:
                actual = hashlib.file_digest(file, "sha256").hexdigest()
            if actual != self.expected:
                self.reason = "checkpoint_mismatch"
                log(f"REFUSED: checkpoint SHA256 {actual} != pinned {self.expected}")
                return
            from metamon.backend.team_preview.preview import TeamPreviewModel
            with rng_preserved(), contextlib.redirect_stdout(sys.stderr):
                self.model = TeamPreviewModel.load_from_checkpoint(str(self.checkpoint), device="cpu", use_argmax=True)
            self.load_ms = (time.perf_counter() - started) * 1000
            log(f"loaded in {self.load_ms:.0f} ms")
        except Exception:
            self.model, self.reason = None, "load_failed"
            log("load failed\n" + traceback.format_exc())

    def predict(self, battle, request):
        """The reply field for this team preview."""
        if self.model is None:
            return self.unavailable(self.reason)
        try:
            team, opponents, reason = preview_inputs(battle, request)
            if reason:
                return self.unavailable(reason)
            started = time.perf_counter()
            with rng_preserved(), contextlib.redirect_stdout(sys.stderr):
                _, probs, sorted_names = self.model.predict_lead(
                    [p.name for p in team], [[m.name for m in p.moves] for p in team], [p.ability for p in team],
                    [p.item for p in team], opponents, battle_format=None, device="cpu")
            slots = slot_probabilities(probs.tolist(), sorted_names, team)
            return {"status": "ok", "checkpointSha256": self.expected, "leadProbabilities": slots,
                    "inferenceMs": round((time.perf_counter() - started) * 1000, 3)}
        except Exception:
            log("inference failed\n" + traceback.format_exc())
            return self.unavailable("inference_failed")


def install(worker, checkpoint, lead=None):
    """Idempotent per worker module. `lead` is injectable for tests. Returns the worker for chaining."""
    if getattr(worker, "_lead_model_installed", False):
        return worker
    worker._lead_model_installed = True
    lead = lead or LeadModel(checkpoint)
    check_runtime, observe = worker.check_runtime, worker.SocketlessBattle.observe
    readline, reply = worker.RpcInput.readline, worker.RpcInput.reply
    state = {"op": None, "id": None, "decoder": None, "field": None}

    def checked_runtime(path):
        check_runtime(path)
        import metamon.rl.pretrained  # noqa: F401 -- main() imports it next; it must precede any other metamon import
        lead.load()

    def remembered_observe(self, *args, **kwargs):
        state["decoder"] = self
        return observe(self, *args, **kwargs)

    def remembered_readline(self):
        raw = readline(self)
        state["op"] = state["id"] = None
        try:
            message = json.loads(raw) if raw else None
            if isinstance(message, dict):
                state["op"], state["id"] = message.get("op"), message.get("id")
        except (ValueError, UnicodeDecodeError):
            pass  # The pinned loop rejects it with its own error code.
        return raw

    def exposed_reply(self, wire, response):
        decoder = state["decoder"]
        if (response.get("ok") is True and state["op"] == "propose" and response.get("id") == state["id"]
                and isinstance(response.get("choice"), dict) and response["choice"].get("kind") == "team"
                and decoder is not None and decoder.request and decoder.request.get("teamPreview")):
            if state["field"] is None:  # One preview per worker; a repeated propose repeats it.
                state["field"] = lead.predict(decoder.battle, decoder.request)
            response = {**response, FIELD: state["field"]}
        return reply(self, wire, response)

    worker.check_runtime = checked_runtime
    worker.SocketlessBattle.observe = remembered_observe
    worker.RpcInput.readline, worker.RpcInput.reply = remembered_readline, exposed_reply
    return worker
