"""Single-controller campaign reservations; a reservation never authorizes panel access."""
import argparse
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[2]
BINDINGS = {'source', 'schema', 'preview', 'seeds', 'familyBlocks', 'powerDesign', 'modelWeights'}


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def model_weights(path):
    """Bind tensor names, types, shapes and values independently of serialization."""
    import torch
    if sys.byteorder != 'little':
        raise ValueError('Little-endian tensor identity required')
    before = sha(path)
    state = torch.load(path, map_location='cpu', weights_only=True, mmap=True)
    if not isinstance(state, dict) or not state or any(not isinstance(k, str) for k in state):
        raise ValueError('Nonempty named tensor state required')
    digest = hashlib.sha256(b'uu-model-tensors@1\0')
    for key in sorted(state):
        value = state[key]
        if (not isinstance(value, torch.Tensor) or value.layout != torch.strided
                or value.is_quantized or not bool(torch.isfinite(value).all())):
            raise ValueError('Finite dense checkpoint tensors required')
        header = json.dumps([key, str(value.dtype), list(value.shape)],
                            ensure_ascii=True, separators=(',', ':')).encode()
        payload = value.detach().contiguous().reshape(-1).view(torch.uint8).numpy().tobytes()
        digest.update(len(header).to_bytes(8, 'little')); digest.update(header)
        digest.update(len(payload).to_bytes(8, 'little')); digest.update(payload)
    if sha(path) != before:
        raise ValueError('Checkpoint changed during identity audit')
    return dict(checkpointSha256=before, modelWeightsSha256=digest.hexdigest(),
                tensors=len(state), method='uu-model-tensors@1')


def policy_identity(kind, path, expected_sha):
    """Cover checkpoints and the registered three-member equal-probability ensemble."""
    if kind not in ('checkpoint', 'ensemble') or sha(path) != checksum(expected_sha):
        raise ValueError('Declared policy kind and matching artifact required')
    if kind == 'checkpoint':
        return model_weights(path)
    members = json.loads(Path(path).read_bytes())
    if (not isinstance(members, list) or len(members) != 3 or any(
            not isinstance(r, dict) or set(r) != {'name', 'path', 'epoch', 'sha256'}
            or type(r['epoch']) is not int or r['epoch'] < 0 for r in members)):
        raise ValueError('Registered three-member checkpoint ensemble required')
    identities = [model_weights(row['path']) for row in members]
    if any(identity['checkpointSha256'] != checksum(row['sha256'])
           for identity, row in zip(identities, members)):
        raise ValueError('Ensemble member artifact drift')
    weights = [identity['modelWeightsSha256'] for identity in identities]
    if len(set(weights)) != 3 or sha(path) != expected_sha:
        raise ValueError('Three distinct tensor identities and unchanged manifest required')
    digest = hashlib.sha256(b'uu-equal-probability-ensemble@1\0' +
                            json.dumps(weights, separators=(',', ':')).encode()).hexdigest()
    return dict(checkpointSha256=expected_sha, modelWeightsSha256=digest,
                members=identities, method='uu-equal-probability-ensemble@1')


def checksum(value):
    if not isinstance(value, str) or re.fullmatch('[0-9a-f]{64}', value) is None:
        raise ValueError('Canonical SHA256 required')
    return value


def alpha(k):
    if type(k) is not int or k < 1:
        raise ValueError('Positive global heldout attempt index required')
    return Fraction(1, 20 * k * (k + 1))


class Ledger:
    def __init__(self, root, rule, controller=None):
        self.root, self.rule = Path(root), rule
        self.controller = hashlib.sha256((platform.node() if controller is None else controller).encode()).hexdigest()

    def require_qualification(self):
        r = self.rule
        if (r.get('schema') != 'uu-certification-campaign-rule@1'
                or r.get('status') != 'QUALIFIED_CAMPAIGN'
                or r.get('familywiseAlpha') != .05
                or r['canonicalLedger'].get('singleControllerBinding') != self.controller
                or r['canonicalLedger'].get('ledgerProducer') != sha(__file__)):
            raise RuntimeError('CERTIFICATION_CAMPAIGN_HOLD: matching qualified canonical writer required')
        canonical = Path(r['canonicalLedger']['path'])
        if not canonical.is_absolute() or canonical.resolve() != self.root.resolve():
            raise RuntimeError('CERTIFICATION_CAMPAIGN_HOLD: one absolute canonical ledger directory required')
        history = r['canonicalLedger'].get('historicalUses')
        if not isinstance(history, dict):
            raise RuntimeError('CERTIFICATION_CAMPAIGN_HOLD: historical candidate uses must be imported')
        path = Path(history['path'])
        if (not path.is_absolute() or not path.resolve().is_relative_to(canonical.parent.resolve())
                or sha(path) != checksum(history['sha256'])):
            raise ValueError('Historical candidate-use binding changed')
        imported = json.loads(path.read_bytes())
        if imported['schema'] != 'uu-certification-historical-uses@1':
            raise ValueError('Explicit historical use manifest required')
        for row in imported['uses']:
            checksum(row['candidateSha256']); checksum(row['receiptSha256'])
            checksum(row.get('modelWeightsSha256'))
            if row['stage'] not in ('dev', 'heldout'):
                raise ValueError('Unknown historical candidate stage')
        self.history, self.history_sha = imported['uses'], history['sha256']

    def reserve(self, stage, candidate, bindings):
        self.require_qualification()
        checksum(candidate)
        if stage not in ('dev', 'heldout') or set(bindings) != BINDINGS:
            raise ValueError('Explicit stage and complete frozen campaign bindings required')
        for value in bindings.values():
            checksum(value)
        # The canonical writer is POSIX-bound. Remote hosts never write this ledger.
        import fcntl
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / 'writer.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            path = self.root / 'ledger.json'
            data = json.loads(path.read_bytes()) if path.exists() else dict(
                schema='uu-certification-ledger@1', controller=self.controller,
                historicalUsesSha256=self.history_sha, reservations=[])
            if (data['schema'] != 'uu-certification-ledger@1' or data['controller'] != self.controller
                    or data['historicalUsesSha256'] != self.history_sha):
                raise ValueError('Canonical ledger identity changed')
            rows = data['reservations']
            for prior in rows:
                checksum(prior['candidateSha256'])
                if prior['stage'] not in ('dev', 'heldout') or set(prior['bindings']) != BINDINGS:
                    raise ValueError('Canonical history malformed; no reset or repair by this writer')
                for value in prior['bindings'].values():
                    checksum(value)
                if prior['stage'] == 'dev' and (prior['attemptIndex'] is not None or prior['alpha'] != '1/20'):
                    raise ValueError('Canonical history malformed; no reset or repair by this writer')
            uses = [(r['candidateSha256'], r['stage']) for r in rows]
            weights = [(r['bindings']['modelWeights'], r['stage']) for r in rows]
            heldout = [r for r in rows if r['stage'] == 'heldout']
            if len(set(uses)) != len(uses) or len(set(weights)) != len(weights) or any(
                    r['attemptIndex'] != i or r['alpha'] != str(alpha(i))
                    for i, r in enumerate(heldout, 1)):
                raise ValueError('Canonical history malformed; no reset or repair by this writer')
            historical = [(r['candidateSha256'], r['stage']) for r in self.history]
            historical_weights = [(r['modelWeightsSha256'], r['stage']) for r in self.history]
            if ((candidate, stage) in uses or (candidate, stage) in historical
                    or (bindings['modelWeights'], stage) in weights
                    or (bindings['modelWeights'], stage) in historical_weights):
                raise ValueError('Canonical candidate stage already reserved; no namespace reset or refund')
            identities = [(r['candidateSha256'], r['bindings']['modelWeights']) for r in rows]
            identities += [(r['candidateSha256'], r['modelWeightsSha256']) for r in self.history]
            if any(file_sha == candidate and model_sha != bindings['modelWeights']
                   for file_sha, model_sha in identities):
                raise ValueError('Checkpoint tensor identity changed across reservations')
            k = len(heldout) + 1 if stage == 'heldout' else None
            row = dict(candidateSha256=candidate, stage=stage, bindings=bindings,
                       attemptIndex=k, alpha=str(alpha(k)) if k else '1/20',
                       reservedUnix=time.time(), producerSha256=sha(__file__),
                       disposition='RESERVED_ONLY_NOT_PANEL_ACCESS_AUTHORIZATION')
            rows.append(row)
            # One atomic snapshot contains both global alpha allocation and candidate use.
            with tempfile.NamedTemporaryFile(mode='w', dir=self.root, delete=False) as stream:
                json.dump(data, stream, sort_keys=True, indent=2, allow_nan=False)
                stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
            Path(stream.name).replace(path)
            directory = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=['dev', 'heldout'], required=True)
    parser.add_argument('--candidate-sha256', required=True)
    parser.add_argument('--bindings', type=Path, required=True)
    args = parser.parse_args()
    rule = json.loads((PROJECT / 'do/certification/campaign-rule.json').read_bytes())
    root = PROJECT / rule['canonicalLedger']['path']
    if not root.resolve().is_relative_to(PROJECT / 'do/certification'):
        raise ValueError('Canonical private campaign directory required')
    ledger = Ledger(root, rule)
    ledger.require_qualification()  # Refuse before reading any supplied panel bindings.
    print(json.dumps(ledger.reserve(args.stage, args.candidate_sha256,
                                    json.loads(args.bindings.read_bytes())), indent=2))


if __name__ == '__main__':
    main()
