"""Offline teacher seat. Existing e34 decoder/policy; reusable weights, detached branch state.

No socket or server. This separate entry point changes no production worker.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import sys
import traceback

ROOT = Path(__file__).resolve().parents[2]
FIELDS = ('hidden', 'previous_state', 'previous_action', 'step', 'pending')


def load_worker():
    spec = importlib.util.spec_from_file_location('cf_base_worker', ROOT / 'scripts/metamon-worker.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker


class Seat:
    def __init__(self, base, checkpoint, side):
        self.base, self.side = base, side
        self.checkpoint = checkpoint
        self.policy = None
        self.decoder = base.SocketlessBattle()
        self.sequence = 0
        self.saved = None
        self.room = 'battle-gen9uu-cf-0'
        self.events = []
        self.game = self.game_seed = None

    def seed(self, seed):
        import numpy as np
        import torch
        seed = self.base.side_seed(seed, self.side)
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)

    def new_game(self, game, seed):
        import numpy as np
        self.seed(seed)
        self.game, self.game_seed = game, seed
        self.events = []
        self.decoder = self.base.SocketlessBattle()
        self.sequence = 0
        self.room = f'battle-gen9uu-cf-{game}'
        self.saved = None
        if self.policy is not None:
            p = self.policy
            p.model.observation_space.reset()
            p.hidden = p.policy.traj_encoder.init_hidden_state(1, p.experiment.DEVICE)
            p.previous_state = p.pending = None
            p.previous_action = np.zeros((1, p.wrapper.action_size), dtype=p.wrapper.action_dtype)
            p.step = 0

    def observe(self, data, rejected_switch=False):
        if rejected_switch and self.policy.pending is None:
            self.propose()  # Chronological replay reaches a rejected uncommitted proposal.
        self.events.append(('observe', data, rejected_switch))
        self.sequence += 1
        self.decoder.observe(data, {'roomId': self.room, 'side': self.side, 'format': 'gen9uu',
                                    'sequence': self.sequence, 'identity': None}, rejected_switch=rejected_switch)

    def propose(self):
        from poke_env.player import Player
        from scripts.metamon_port.action_probs import choice_token, legal_distribution
        d = self.decoder
        self.base.require(d.request is not None and not d.request.get('wait'), 'no_request')
        if d.request.get('teamPreview'):
            return {'choice': Player.random_teampreview(None, d.battle)[1:]}
        if self.policy is None:
            self.policy = self.base.KakunaPolicy(self.checkpoint, 20261025, 'flex')
        p = self.policy
        rechoose = d.rechoice == 2
        choice = p.propose(d.battle, d.request, rechoose=rechoose)
        if rechoose:
            d.rechoice = 0
        probs = p.last_dist.probs[0, -1, -1].float().cpu().tolist()
        return {'choice': choice_token(choice), 'probabilities': legal_distribution(probs, p.pending[1])}

    def commit(self, token):
        self.events.append(('commit', token))
        if self.decoder.request.get('teamPreview'):
            self.base.require(token.startswith('team ') and sorted(token[5:]) == [str(i + 1) for i in range(len(self.decoder.request['side']['pokemon']))])
            return
        p = self.policy
        from scripts.metamon_port.action_probs import choice_token
        choices = [c for c, _ in p.pending[1] if choice_token(c) == token]
        self.base.require(bool(choices), 'unmapped_action')
        p.commit(choices[0])

    def save(self):
        import numpy as np
        import torch
        if self.policy is None:
            self.policy = self.base.KakunaPolicy(self.checkpoint, 20261025, 'flex')
        self.base.require(self.policy.pending is None, 'uncommitted_snapshot')
        self.saved = copy.deepcopy({
            'decoder': self.decoder, 'sequence': self.sequence, 'events': self.events,
            'policy': {f: getattr(self.policy, f) for f in FIELDS},
            'observation': self.policy.model.observation_space,
            'python_rng': random.getstate(), 'numpy_rng': np.random.get_state(),
            'torch_rng': torch.get_rng_state(), 'cuda_rng': torch.cuda.get_rng_state_all(),
        })

    def restore(self, seed=None):
        import numpy as np
        import torch
        self.base.require(self.saved is not None, 'no_snapshot')
        s = copy.deepcopy(self.saved)
        self.decoder, self.sequence, self.events = s['decoder'], s['sequence'], s['events']
        for f, value in s['policy'].items():
            setattr(self.policy, f, value)
        self.policy.model.observation_space = s['observation']
        random.setstate(s['python_rng'])
        np.random.set_state(s['numpy_rng'])
        torch.set_rng_state(s['torch_rng'])
        torch.cuda.set_rng_state_all(s['cuda_rng'])
        if seed is not None:
            self.seed(seed)


    def replay_check(self):
        """Rebuild decoder, token history and recurrence from source observations/actions.

        Weights are immutable and reused; state is reconstructed from an empty seat.
        This compares the actual saved branch path against chronological replay.
        """
        saved = self.saved
        events = copy.deepcopy(saved['events'])
        self.restore(991)
        expected = self.propose()
        game, seed = self.game, self.game_seed
        self.new_game(game, seed)
        for event in events:
            op, value, *flags = event
            if op == 'observe':
                self.observe(value, *flags)
            else:
                self.propose()
                self.commit(value)
        self.seed(991)
        actual = self.propose()
        self.base.require(expected == actual, 'replay_snapshot_mismatch')
        self.saved = saved
        self.restore()
        return {'replayDecisions': sum(event[0] == 'commit' for event in events), 'match': True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint', type=Path, required=True)
    p.add_argument('--side', choices=('p1', 'p2'), required=True)
    a = p.parse_args()
    wire = sys.stdout
    sys.stdout = sys.stderr
    base = load_worker()
    # Same bounded full-duplex lifecycle and owned process-group cancellation as production.
    transport = base.RpcInput()
    base.check_runtime(a.checkpoint)
    import metamon.rl.pretrained  # GenData initialization must precede decoder creation.
    import torch
    def no_network(event, _args):
        if event in ('socket.connect', 'socket.getaddrinfo'):
            raise RuntimeError('Network forbidden in offline teacher')
    sys.addaudithook(no_network)
    seat = Seat(base, a.checkpoint, a.side)
    serial = 0
    while True:
        raw = transport.readline()
        if not raw:
            return
        try:
            m = json.loads(raw)
            base.require(len(raw) <= base.MAX_FRAME and m['id'] == serial + 1)
            serial = m['id']
            op = m['op']
            if op == 'hello':
                payload = {'torch': torch.__version__, 'checkpointSha256': base.CHECKPOINT_SHA256,
                           'baseWorkerSha256': hashlib.sha256((ROOT / 'scripts/metamon-worker.py').read_bytes()).hexdigest(),
                           'forkTreeSha256': json.loads(base.FORK_PINS.read_text())['metamon']['tree_sha256']}
            elif op == 'new_game':
                seat.new_game(m['game'], m['seed']); payload = {}
            elif op == 'observe':
                seat.observe(m['data'], m.get('rejectedSwitch', False)); payload = {}
            elif op == 'propose':
                payload = seat.propose()
            elif op == 'commit':
                seat.commit(m['choice']); payload = {}
            elif op == 'rebuild':
                seat.new_game(m['game'], m['seed'])
                for entry in m['events']:
                    event, value, *flags = entry
                    if event == 'observe':
                        seat.observe(value, *flags)
                    elif event == 'commit':
                        seat.propose()
                        seat.commit(value)
                    else:
                        raise ValueError('Unknown replay event')
                seat.save(); payload = {}
            elif op == 'save':
                seat.save(); payload = {}
            elif op == 'replay_check':
                payload = seat.replay_check()
            elif op == 'restore':
                seat.restore(m.get('seed')); payload = {}
            else:
                raise ValueError('Unknown teacher RPC')
            transport.reply(wire, {'id': serial, 'ok': True, **payload})
        except Exception as e:
            traceback.print_exc()
            transport.reply(wire, {'id': serial, 'ok': False, 'error': f'{type(e).__name__}: {e}'})
            return 1


if __name__ == '__main__':
    raise SystemExit(main())
