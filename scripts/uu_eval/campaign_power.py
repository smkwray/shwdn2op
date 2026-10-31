"""Fixed-panel paired-slot sensitivity; never admits a real campaign.

The declared effect mode uses balanced fixed-panel effects or independent
population draws. Game seeds are independent across families and stages. Pair scores
are sampled from the exact joint difference law of the registered mixture of
shared and independent uniforms. This is synthetic planning, not calibration.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from campaign import alpha
from campaign_inference import C, log_e


def difference_probabilities(base, effect, shared):
    candidate = base + effect
    if (not 0 <= shared <= 1 or not np.isfinite(base).all() or not np.isfinite(effect).all()
            or np.any(base < 0) or np.any(base > 1)
            or np.any(candidate < 0) or np.any(candidate > 1)):
        raise ValueError('Invalid probabilities; clipping is forbidden')
    positive = shared*np.maximum(effect, 0)+(1-shared)*candidate*(1-base)
    negative = shared*np.maximum(-effect, 0)+(1-shared)*base*(1-candidate)
    if np.any(positive+negative > 1+1e-14):
        raise ArithmeticError('Invalid paired difference law')
    return positive, negative


def prefix_log_e(values, counts, margin):
    result = np.full((len(values), len(counts)), -np.inf)
    for c in C:
        terms = np.log1p(float(c)*(values-margin)/(1+margin))
        result = np.logaddexp(result, np.cumsum(terms, axis=1)[:, np.asarray(counts)-1])
    return result-math.log(len(C))


def stage(job):
    cfg, effect, amplitude, shared, seed = job
    counts = cfg['familyCounts']; maximum = max(counts)
    rng = np.random.default_rng(seed)
    offsets = np.repeat(np.asarray(cfg['opponentOffsets']), 2)+np.tile(cfg['seatOffsets'], len(cfg['opponentOffsets']))
    slots = len(offsets)
    balanced_effect = effect+amplitude*np.where(np.arange(maximum) % 2, -1, 1)
    # A sufficient event for the exact LCB to exceed the margin after its 1e-6
    # quantization. Ambiguous floating comparisons are conservatively failures.
    margin = float(Fraction(cfg['margin'])+Fraction(2, 10**6))
    output = []; maximum_error = 0.
    for start in range(0, cfg['replicates'], cfg['chunkReplicates']):
        size = min(cfg['chunkReplicates'], cfg['replicates']-start)
        baseline = .5+cfg['baselineOffset']*rng.choice([-1, 1], size=(size, maximum, 1))+offsets
        family_effect = (effect+amplitude*rng.choice([-1, 1], size=(size, maximum, 1))
            if cfg['effectMode']=='independent_family_population' else balanced_effect[None, :, None])
        positive, negative = difference_probabilities(baseline, family_effect, shared)
        draws = rng.random((size, maximum, slots))
        differences = (draws < positive).astype(np.int8)-(draws >= 1-negative).astype(np.int8)
        values = differences.mean(axis=2)
        logs = prefix_log_e(values, counts, margin)
        if start == 0:
            for i, count in enumerate(counts):
                reference = log_e(tuple(map(float, values[0, :count])), margin)
                maximum_error = max(maximum_error, abs(reference-logs[0, i]))
        output.append(logs)
    if maximum_error > cfg['numericalBuffer']/10:
        raise ArithmeticError('Vectorized kernel disagrees with canonical scalar kernel')
    return np.concatenate(output), maximum_error


def run(cfg):
    if (cfg['schema'] != 'uu-synthetic-campaign-power@1' or cfg['qualificationOnly'] is not True
            or cfg['effectMode'] not in ['balanced_fixed_panel', 'independent_family_population']
            or cfg['workers'] != 2 or cfg['replicates'] < 10000
            or not cfg['familyCounts'] or cfg['familyCounts'] != sorted(set(cfg['familyCounts']))
            or not cfg['effects'] or not cfg['effectAmplitudes'] or not cfg['sharedUniformProbabilities']
            or not cfg['attemptIndices'] or any(type(k) is not int or k < 1 for k in cfg['attemptIndices'])
            or len(set(cfg['attemptIndices'])) != len(cfg['attemptIndices'])
            or len(cfg['opponentOffsets']) < 2 or cfg['chunkReplicates'] < 1
            or len(cfg['seatOffsets']) != 2 or sum(cfg['seatOffsets']) != 0
            or any(type(n) is not int or n < 2 or n % 2 for n in cfg['familyCounts'])
            or not 0 < cfg['targetStage'] <= 1 or not 0 < cfg['targetJoint'] <= 1
            or not -1 < Fraction(cfg['margin']) < 1
            or not 0 < cfg['monteCarloAlpha'] < 1 or not cfg['numericalBuffer'] >= 1e-7
            or not all(math.isfinite(v) for key in ['effects', 'effectAmplitudes', 'sharedUniformProbabilities',
                'opponentOffsets', 'seatOffsets'] for v in cfg[key])
            or not math.isfinite(cfg['baselineOffset']) or cfg['baselineOffset'] < 0):
        raise ValueError('Complete prospective bounded synthetic design required')
    scenarios = [(e, a, r) for e in cfg['effects'] for a in cfg['effectAmplitudes'] for r in cfg['sharedUniformProbabilities']]
    children = np.random.SeedSequence(cfg['seed']).spawn(2*len(scenarios))
    jobs = [(cfg, *s, int(children[2*i+j].generate_state(1)[0])) for i, s in enumerate(scenarios) for j in [0, 1]]
    with ProcessPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(stage, jobs))
    endpoints = len(scenarios)*len(cfg['familyCounts'])*(1+2*len(cfg['attemptIndices']))
    error = math.sqrt(math.log(endpoints/cfg['monteCarloAlpha'])/(2*cfg['replicates']))
    rows = []
    def estimate(events):
        successes = int(events.sum()); observed = successes/cfg['replicates']
        return dict(successes=successes, replicates=cfg['replicates'], estimate=observed,
                    simultaneousHoeffdingLower=max(0., observed-error))
    for i, scenario in enumerate(scenarios):
        dev, dev_error = results[2*i]; held, held_error = results[2*i+1]
        for j, count in enumerate(cfg['familyCounts']):
            d = dev[:, j] > math.log(20)+cfg['numericalBuffer']
            for k in cfg['attemptIndices']:
                h = held[:, j] > math.log(float(1/alpha(k)))+cfg['numericalBuffer']
                values = dict(dev=estimate(d), heldout=estimate(h), joint=estimate(d & h))
                met = (values['dev']['simultaneousHoeffdingLower'] >= cfg['targetStage']
                       and values['heldout']['simultaneousHoeffdingLower'] >= cfg['targetStage']
                       and values['joint']['simultaneousHoeffdingLower'] >= cfg['targetJoint'])
                rows.append(dict(effect=scenario[0], familyEffectAmplitude=scenario[1], sharedUniformProbability=scenario[2],
                    families=count, pairedSlotsPerFamily=2*len(cfg['opponentOffsets']), attemptIndex=k,
                    heldoutAlpha=str(alpha(k)), **values, syntheticTargetsMet=met,
                    scalarKernelMaximumError=max(dev_error, held_error)))
    return dict(phase='COMPLETE_SYNTHETIC_SENSITIVITY_NOT_CAMPAIGN_QUALIFICATION', executionComplete=True,
        realDataRead=False, realPanels=0, reservations=0, modelCalls=0, productionAdmission=False,
        monteCarloSimultaneousAlpha=cfg['monteCarloAlpha'], monteCarloEndpoints=endpoints,
        monteCarloLowerCorrection=error, effectMode=cfg['effectMode'], rows=rows,
        limitations='Declared family-effect, no-draw synthetic model; native graph/assets/calibration and real writer remain unqualified. Buffered log-E sufficient-event power is conservative relative to exact LCB; it is not inferential authority.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args(); cfg = json.loads(args.job.read_bytes())
    report = run(cfg); report['jobSha256'] = hashlib.sha256(args.job.read_bytes()).hexdigest()
    with args.out.open('x') as stream:
        json.dump(report, stream, indent=2, allow_nan=False); stream.write('\n')


if __name__ == '__main__':
    main()
