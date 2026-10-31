"""Fixed E3 arithmetic over shared member workers, with independent client caches."""
from pathlib import Path
import sys
from types import SimpleNamespace

import torch

sys.path.insert(0, str(Path(__file__).parents[1] / "uu_eval"))
from ensemble import combine, draw, uniform
sys.path.insert(0, str(Path(__file__).parents[1] / "metamon_port"))
from action_probs import choice_token, legal_distribution


class EnsembleBatcher:
    def __init__(self, members):
        if len(members) not in (1, 3):
            raise ValueError("E3 uses three members; its common-draw controls use one")
        self.members, self.base = members, members[0].base

    @property
    def stats(self):
        rows = [member.stats for member in self.members]
        return {**{key:sum(row[key] for row in rows) for key in ("batches","decisions","inferenceSeconds")},
                "maxBatch":max(row["maxBatch"] for row in rows)}

    def submit(self, owner, inputs):
        if owner.temperature != 1.:
            raise ValueError("Fixed E3 collector requires temperature 1")
        if getattr(owner,"capture_teacher",False):
            from soft_policy import capture_inputs
            owner.teacher_input = capture_inputs(inputs)
        if not hasattr(owner, "member_states"):
            owner.member_states = [SimpleNamespace(temperature=1.,
                generator=torch.Generator(device=self.base.experiment.DEVICE).manual_seed(owner.seed),
                hidden=(inputs["hidden_state"] if i == 0 else
                    batcher.base.policy.traj_encoder.init_hidden_state(1, self.base.experiment.DEVICE)))
                for i, batcher in enumerate(self.members)]
        probabilities = []
        for batcher, member in zip(self.members, owner.member_states):
            _, member.hidden = batcher.submit(member, {**inputs, "hidden_state": member.hidden})
            probabilities.append(member.last_dist.probs[0, -1, -1].float().cpu().tolist())
        owner.member_probabilities = probabilities
        owner.last_dist = owner.member_states[0].last_dist
        # The pinned proposal builds the structural mapping from this legal placeholder.
        legal = (~inputs["obs"]["illegal_actions"][0, -1].bool()).nonzero().flatten()
        if not len(legal):
            raise ValueError("No legal ensemble action")
        return legal[0].reshape(1, 1, 1), owner.member_states[0].hidden


def install(policy):
    """Reuse the sealed E3 legal-alias aggregation and inverse-CDF sampling rule."""
    original = policy.propose

    def propose(battle, request, rechoose=False):
        if rechoose:
            redraw = policy.redraw
            policy.redraw = lambda legal: legal[0]
            try:
                original(battle, request, True)
            finally:
                policy.redraw = redraw
        else:
            original(battle, request, False)
        mapping = policy.pending[1]
        legal = sorted({choice_token(choice) for choice, _ in mapping})
        distributions = [legal_distribution(p, mapping) for p in policy.member_probabilities]
        probabilities = combine(distributions, legal)
        token = draw(probabilities, uniform(policy.seed, policy.step - 1))
        choice = next(choice for choice, _ in mapping if choice_token(choice) == token)
        index = min(i for choice, i in mapping if choice_token(choice) == token)
        policy.pending_alias = (index, policy.pending_alias[1])
        policy.redrawn = rechoose
        policy.ensemble_distribution = probabilities
        return choice

    policy.propose = propose
    return policy
