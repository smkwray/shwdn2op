"""Frozen E3 arithmetic and common-random-number sampling. No model or outcome inputs."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import math

FLOOR=1e-8


def combine(members, legal):
    legal=sorted(legal)
    if not members or not legal or len(set(legal))!=len(legal):
        raise ValueError('empty or duplicate legal set/members')
    normalized=[]
    for p in members:
        if set(p)!=set(legal):raise ValueError('member legal-set mismatch')
        if any(not math.isfinite(p[a]) or p[a]<0 for a in legal):raise ValueError('invalid probability')
        total=math.fsum(p.values())
        if total<=0:raise ValueError('zero legal mass')
        normalized.append({a:max(p[a]/total,FLOOR) for a in legal})
    if len(normalized)==1:
        # No log/exp round trip: a one-member policy is bit-identical to its legal conditional.
        q=normalized[0]
    else:
        logs={a:math.fsum(math.log(p[a]) for p in normalized)/len(normalized) for a in legal}
        peak=max(logs.values());q={a:math.exp(logs[a]-peak) for a in legal}
    total=math.fsum(q.values())
    return {a:q[a]/total for a in legal}


def uniform(seed, step):
    if type(seed) is not int or type(step) is not int or seed<0 or step<0:raise ValueError('invalid draw identity')
    bits=int.from_bytes(hashlib.sha256(f'uu-e3-v1:{seed}:{step}'.encode()).digest()[:8],'big')>>11
    return bits/2**53


def draw(p,u):
    if not 0<=u<1:raise ValueError('uniform outside [0,1)')
    cumulative=0.
    for a in sorted(p):
        cumulative+=p[a]
        if u<cumulative:return a
    if abs(cumulative-1)>1e-12:raise ValueError('unnormalized distribution')
    return sorted(p)[-1]


def parallel_members(call, members):
    with ThreadPoolExecutor(max_workers=len(members)) as pool:
        futures=[pool.submit(call,m) for m in members]
        return [f.result() for f in futures]
