"""Use the qualified MLX backbone while retaining the native actor and sampler."""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace


def load(config, checkpoint_sha):
    from mlx_kakuna import MLXKakuna
    if set(config) != {'checkpointSha256', 'weights', 'backend'} or config['backend'] != 'mlx_backbone_cpu_actor':
        raise ValueError('Explicit single-policy MLX backbone configuration required')
    if config['checkpointSha256'] != checkpoint_sha:
        raise ValueError('Native policy and MLX checkpoint identities differ')
    return MLXKakuna(Path(config['weights']), expected=checkpoint_sha)


def encode(network, step, obs, rl2s):
    import numpy as np
    import torch
    if any(value.shape[:2] != (1, 1) for value in obs.values()):
        raise ValueError('Single-actor incremental MLX stream required')
    arrays = {name: network.mx.array(value[:, 0].detach().cpu().numpy()) for name, value in obs.items()}
    timestep = network.timestep(arrays, network.mx.array(rl2s[:, 0].detach().cpu().numpy()))
    encoded = network.trajectory(timestep, step)
    network.mx.eval(encoded, network.cache)
    result = torch.from_numpy(np.array(encoded))
    if result.shape != (1, 1, 900) or not bool(torch.isfinite(result).all()):
        raise ValueError('Invalid native MLX backbone output')
    return result


def install(experiment, context, config, metadata):
    import numpy as np
    import torch
    if any(parameter.device.type != 'cpu' for parameter in experiment.policy.actor.parameters()):
        raise ValueError('This qualified profile retains the native actor on CPU')
    weights = Path(config['weights'])
    network = load(config, metadata['checkpoint_sha256'])
    state = SimpleNamespace(network=network, battle=None, step=0, forwards=0, last_embedding=None)

    def embedding(*, obs, rl2s, time_idxs, hidden_state=None):
        battle = context['env'].current_battle
        if state.battle != battle.battle_tag:
            network.reset()
            state.battle, state.step = battle.battle_tag, 0
        if int(time_idxs.item()) != state.step or any(value.shape[:2] != (1, 1) for value in obs.values()):
            raise ValueError('Single-actor incremental native MLX stream required')
        result = encode(network, state.step, obs, rl2s)
        state.last_embedding = result
        state.step += 1
        state.forwards += 1
        return result, hidden_state

    # Agent.get_actions, all seven native actor heads, categorical RNG draws,
    # legal redraw, cached trapped retry, lead selection and accepted feedback stay native.
    experiment.policy.get_state_embedding = embedding
    experiment.native_mlx_backbone = state
    manifest = weights.with_suffix('.json').read_bytes()
    return {'backend': config['backend'], 'converted_weights_sha256': json.loads(manifest)['weights_sha256'],
            'converted_manifest_sha256': hashlib.sha256(manifest).hexdigest()}
