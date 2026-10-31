"""Compare the selected native MLX backbone, actor probabilities and native RNG with CPU."""
import copy
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace


def run(args, environment, kit):
    import numpy as np
    import psutil
    import torch
    import common
    from torch_backend import TorchBackend
    from candidate_worker import policy_members
    from native_legal import register_native
    from mlx_kakuna import convert

    args.out.mkdir(parents=True)
    common.OUT = args.out / 'reference-work'
    members = policy_members(args.policies, Path(environment['UU_KAKUNA_CKPT']))
    member = next(row for row in members if row['name'] == args.member)
    config = json.loads(args.backbone_config.read_bytes())
    assert config['checkpointSha256'] == member['sha256']
    weights = Path(config['weights'])
    if weights.exists() or weights.with_suffix('.json').exists():
        raise FileExistsError('Fresh converted qualification assets required')
    conversion = convert(Path(member['path']), weights, expected=member['sha256'])
    (args.out / 'conversion.json').write_text(json.dumps(conversion, indent=2) + '\n')
    reference = TorchBackend('torch-cpu', Path(member['path']), args.run / 'source', 0)
    spec = importlib.util.spec_from_file_location('qualified_native_league', kit / 'league_serve.py')
    league = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(league)
    league.register()
    # league_serve deliberately removes its kit on import, then restores it in main().
    # Match that selected production path before the backend's deferred import.
    sys.path.insert(0, str(kit))
    seed = int(environment['UU_NATIVE_COLLECTION_SEED'])
    metadata = {'model': 'G1', 'policy_id': member['policyId'], 'checkpoint_sha256': member['sha256'],
                'purpose': 'progress', 'training_eligible': False}
    register_native('UUExport', args.out / 'native-traces', seed, metadata, backbone_config=config,
                    lead_checkpoint=environment['UU_NATIVE_LEAD_CHECKPOINT'])
    from metamon.rl.pretrained import get_pretrained_model
    maker = get_pretrained_model('UUExport')
    experiment = maker.initialize_agent(checkpoint=member['epoch'], log=False, action_temperature=1.)
    policy = experiment.policy.eval()
    assert policy.actor.num_gammas == reference.policy.actor.num_gammas == 7
    hidden = policy.init_hidden_state(1, torch.device('cpu'))
    fixture = json.loads(args.fixture.read_bytes())
    assert fixture['source'].startswith('independent native simulator;') and fixture['rows']
    maximum = 0.
    decisions = revival = 0
    samples, latencies = [], []
    context = experiment.native_legal_context
    import time
    torch.set_num_threads(1)
    while decisions < args.steps:
        decoder = reference.worker.SocketlessBattle()
        observations = common.ObservationPath(copy.deepcopy(reference.model), reference.worker)
        for row in fixture['rows']:
            if row['op'] == 'observe':
                decoder.observe(row['data'], row['context'])
                continue
            if row['op'] != 'propose' or row['executedChoice']['kind'] == 'team':
                continue
            if psutil.virtual_memory().available < 12 * 2**30:
                raise MemoryError('Native MLX qualification reserve')
            obs, rl2, times, legal, _ = observations.prepare(decoder.battle, decoder.request, row['executedChoice'])
            times = np.full_like(times, decisions)
            with torch.compiler.set_stance('force_eager'):
                expected = reference.step(obs, rl2, times)
            tag = decoder.battle.battle_tag
            if experiment.native_legal.get('battle') != tag:
                game_seed = int.from_bytes(hashlib.sha256(f'{seed}:{tag}'.encode()).digest()[:4], 'big')
                torch.manual_seed(reference.worker.side_seed(game_seed, decoder.request['side']['id']))
            before = torch.get_rng_state().clone()
            expected_action = reference.last_dist.sample()[..., -1, :]
            if int(expected_action.item()) not in legal:
                expected_action[...] = reference.worker.KakunaPolicy.redraw(SimpleNamespace(last_dist=reference.last_dist), legal)
            expected_rng = torch.get_rng_state().clone()
            torch.set_rng_state(before)
            from metamon.interface import UniversalState
            context['env'] = SimpleNamespace(current_battle=decoder.battle, _most_recent_state=UniversalState.from_Battle(decoder.battle))
            tensor = lambda value: torch.from_numpy(value).unsqueeze(1)
            started = time.perf_counter()
            with torch.no_grad():
                action, hidden = policy.get_actions(obs={key: tensor(value) for key, value in obs.items()}, rl2s=tensor(rl2), time_idxs=tensor(times), hidden_state=hidden, sample=True)
            latencies.append((time.perf_counter() - started) * 1000)
            actual = experiment.native_legal['distribution'].probs[0, -1, -1].numpy()
            maximum = max(maximum, float(np.max(np.abs(actual - expected))))
            assert np.allclose(actual, expected, atol=3e-5, rtol=3e-4), ('probability', decisions, maximum)
            assert int(action.item()) == int(expected_action.item()), ('native categorical choice', decisions)
            assert torch.equal(torch.get_rng_state(), expected_rng), ('native categorical RNG', decisions)
            assert all(cache[0].shape[2] <= 97 for cache in experiment.native_mlx_backbone.network.cache)
            samples.append({'step': decisions, 'maxProbabilityError': float(np.max(np.abs(actual - expected))), 'action': int(action.item())})
            revival += int(any(mon.get('reviving') for mon in decoder.request['side']['pokemon']))
            observations.commit(row['executedChoice'])
            decisions += 1
            if decisions >= args.steps:
                break
    report = {'pass': True, 'qualificationOnly': True, 'trainingEligible': False, 'checkpointSha256': member['sha256'],
              'steps': decisions, 'revivalInputs': revival, 'maxProbabilityError': maximum, 'nativeSevenHeadSamplingAndRNGEqual': True,
              'cacheBound': 97, 'forwards': experiment.native_mlx_backbone.forwards, 'medianDecisionMs': float(np.median(latencies)),
              'backend': config['backend'], 'fixtureSha256': hashlib.sha256(args.fixture.read_bytes()).hexdigest(), 'rows': samples}
    assert report['forwards'] == decisions
    (args.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'rows'}))
