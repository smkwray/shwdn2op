"""Bind compute permission without coupling it to delegate-model prose."""
import hashlib
from pathlib import Path
import time


def digest(path):
    lines = Path(path).read_text().splitlines(keepends=True)
    content = ''.join(line for line in lines if not line.startswith(('- delegates:', '- consult:'))
                      and not (line.startswith('- use ') and line.rstrip().endswith(' delegates')))
    return hashlib.sha256(content.encode()).hexdigest()


def check(plan):
    allowed = {plan['routingComputeSha256']}
    for transition in plan.get('routingTransitions', []):
        if time.time() >= transition['notBeforeEpoch']:
            allowed.add(transition['computeSha256'])
    assert digest(plan['routingFile']) in allowed, 'Compute routing changed; re-read the authority'
