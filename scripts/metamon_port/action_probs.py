"""Expose the pinned worker's own legal-action distribution on its propose reply (our wrappers only).

The pinned scripts/metamon-worker.py samples a first draw from the stored actor distribution
(`last_dist`) and redraws illegal indices from the legal-only conditional. The marginal of the
executed proposal is therefore exactly last_dist restricted to the legal indices, renormalized:
P(a) = q(a) + q(illegal) * q(a) / q(legal) = q(a) / q(legal). A trapped re-choice redraws from
the same conditional over the new legal set. This module reports that conditional, keyed by the
pinned decoder's own structural choice for each index (`self.pending[1]`), summed over aliases.

install(worker) patches only: propose/commit (to remember the pending proposal's distribution)
and RpcInput.readline/reply (to add one optional reply field `actionProbabilities` to a propose
reply). It never touches sampling, RNG, recurrence, legality or any existing reply field.
Team preview (official random_teampreview, no network) has no distribution and no field.
"""
import json

FIELD = "actionProbabilities"


def choice_token(choice):
    """Showdown /choose grammar, identical to the companion's LegalAction.choice."""
    if choice["kind"] == "move":
        return f"move {choice['moveSlot']}" + (" terastallize" if choice["terastallize"] else "")
    if choice["kind"] == "switch":
        return f"switch {choice['switchSlot']}"
    raise ValueError("team preview has no network distribution")


def legal_distribution(probs, mapping):
    """probs: the stored 13-way distribution (list); mapping: [(choice, index)] from the pinned decoder."""
    choice_of = {}
    for choice, index in mapping:
        token = choice_token(choice)
        if choice_of.setdefault(index, token) != token:
            raise ValueError("one action index maps to two choices")
    total = sum(float(probs[index]) for index in choice_of)
    if not total > 0:
        raise ValueError("no legal probability mass")
    result = {}
    for index, token in sorted(choice_of.items()):
        result[token] = result.get(token, 0.0) + float(probs[index]) / total
    return result


def install(worker):
    """Idempotent per worker module. Returns the worker for chaining."""
    if getattr(worker, "_action_probs_installed", False):
        return worker
    worker._action_probs_installed = True
    policy_class, transport_class = worker.KakunaPolicy, worker.RpcInput
    propose, commit = policy_class.propose, policy_class.commit
    readline, reply = transport_class.readline, transport_class.reply
    state = {"op": None, "id": None, "distribution": None}

    def exposed_propose(self, battle, request, rechoose=False):
        choice = propose(self, battle, request, rechoose)
        probs = self.last_dist.probs[0, -1, -1].float().cpu().tolist()
        state["distribution"] = legal_distribution(probs, self.pending[1])
        return choice

    def exposed_commit(self, choice):
        commit(self, choice)
        state["distribution"] = None

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
        # Only a successful reply to this propose, carrying a network (non-team) choice.
        if (response.get("ok") is True and state["op"] == "propose" and response.get("id") == state["id"]
                and isinstance(response.get("choice"), dict) and response["choice"].get("kind") in ("move", "switch")):
            distribution = state["distribution"]
            if distribution is None or choice_token(response["choice"]) not in distribution:
                raise RuntimeError("propose reply without the matching pending distribution")
            response = {**response, FIELD: distribution}
        return reply(self, wire, response)

    policy_class.propose, policy_class.commit = exposed_propose, exposed_commit
    transport_class.readline, transport_class.reply = remembered_readline, exposed_reply
    return worker
