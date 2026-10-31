"""Validate the full native on-policy batch before dispatching its actor trainer."""
import argparse
from collections import Counter
import gc
import json
from pathlib import Path
import random
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
import torch

import ppo_train
from ppo import sha, windows
from ppo_train import Rollouts, evaluate, require_gpu_admission


def validate_resume(train):
    """A new batch keeps the prior learner state and exact exported actor."""
    if not train.get('resume'):
        return None
    binding = train['bindings'].get('resumeState')
    if (not binding or binding['path'] != train['resume']
            or sha(binding['path']) != binding['sha256']):
        raise ValueError('The complete prior learner state must be hash-bound')
    state = torch.load(train['resume'], map_location='cpu', weights_only=False)
    required = {'policy', 'head', 'actor', 'value', 'actorSteps', 'version', 'passIndex',
                'batchSha', 'stopped', 'identity', 'recipe', 'pythonRNG', 'numpyRNG',
                'torchRNG', 'cudaRNG'}
    identity = ppo_train.trainer_identity(train)
    manifest = json.loads(Path(train['manifest']).read_bytes())
    if (set(state) != required or state['identity'] != identity
            or state['recipe'] != train['recipe']
            or type(state['actorSteps']) is not int or state['actorSteps'] < 0
            or manifest['version'] != state['version'] + 1
            or state['batchSha'] == sha(train['manifest'])
            or not (state['stopped'] or state['passIndex'] == state['recipe']['passes'])
            or Path(train['out']).resolve() == Path(train['resume']).parent.resolve()):
        raise ValueError('Closed prior version, unchanged learner identity and fresh next batch required')
    checkpoint = torch.load(train['checkpoint'], map_location='cpu', weights_only=True)
    if (state['policy'].keys() != checkpoint.keys()
            or any(not torch.equal(value, checkpoint[name])
                   for name, value in state['policy'].items())):
        raise ValueError('Next collection checkpoint differs from the complete resumed actor')
    return dict(priorVersion=state['version'], nextVersion=manifest['version'],
                actorSteps=state['actorSteps'], resumeSha256=binding['sha256'],
                completePriorStateBound=True)


def validate(job):
    if job['schema'] != 'uu-ppo-behavior-admission@1':
        raise ValueError('Frozen full-batch behavior admission required')
    if job['trainJob'] not in job['hashes']:
        raise ValueError('The dispatched training job must be hash-bound')
    for name, digest in job['hashes'].items():
        if sha(name) != digest:
            raise ValueError('Behavior admission input drift: '+name)
    train = json.loads(Path(job['trainJob']).read_bytes())
    if (type(job['runTraining']) is not bool or type(train['qualificationOnly']) is not bool
            or train['schema'] != 'uu-ppo-train@1'):
        raise ValueError('Explicit new-version identity and training disposition required')
    if not train['qualificationOnly'] and (
            train['backend'] != 'torch-cuda-sdpa'
            or job['counts'] != dict(battles=1000, learnerPOVs=1200)
            or train['recipe']['passes'] != 4):
        raise ValueError('The registered pilot requires the full native GPU batch and four-pass cap')
    if job['runTraining'] and train['qualificationOnly']:
        raise ValueError('Qualification data never dispatches the pilot actor')
    if not train['qualificationOnly']:
        admission = job['cpuAdmission']
        if admission not in job['hashes']:
            raise ValueError('The exact native CPU admission must be hash-bound')
        proof = json.loads(Path(admission).read_bytes())
        if (proof['phase'] != 'ROLLOUT_MANIFEST_ADMITTED_NATIVE_TRAINING_PENDING'
                or proof['pass'] is not True or proof['ownedSurvivors'] != []
                or proof['exactReplays'] != 1000 or proof['learnerPOVs'] != 1200
                or proof['manifestSha256'] != sha(train['manifest'])):
            raise ValueError('Closed exact CPU admission for this full manifest required')
    for binding in train['bindings'].values():
        if sha(binding['path']) != binding['sha256']:
            raise ValueError('Training admission binding drift')
    resume = validate_resume(train)
    require_gpu_admission(train)
    sys.path.insert(0, str(Path(ppo_train.__file__).parents[1]/'metamon_port'))
    from torch_backend import TorchBackend
    torch.set_num_threads(1); torch.compiler.set_stance('force_eager')
    random.seed(train['seed']); np.random.seed(train['seed']); torch.manual_seed(train['seed'])
    backend = TorchBackend(train['backend'], train['checkpoint'], train['source'], train['seed'])
    torch.set_num_threads(1)
    rollouts = Rollouts(train['manifest'], backend.model, backend.device, sha(train['checkpoint']))
    if rollouts.manifest['counts'] != job['counts']:
        raise ValueError('Full-batch coverage differs from the prospective admission')
    if rollouts.manifest['qualificationOnly'] != train['qualificationOnly']:
        raise ValueError('Qualification and pilot data cannot be interchanged')
    roles = Counter(row['split'] for row in rollouts.rows)
    if not train['qualificationOnly'] and roles != dict(actor=1020, value=120, reserve=60):
        raise ValueError('Whole-version learner role quotas differ')
    policy = SimpleNamespace(policy=backend.policy)
    versions = [(name, value._version) for name, value in backend.policy.state_dict().items()]
    episodes = []
    decisions, maximum = 0, 0.
    with torch.no_grad():
        for row in rollouts.rows:
            episode = rollouts.load(row)
            episodes.append(episode)  # Measure the actual full resident batch, not one POV at a time.
            for _, start, end in windows(len(episode['records']), train['recipe']['window']):
                actual, _ = evaluate(policy, episode, start, end)
                expected = torch.tensor([r['probabilities'] for r in episode['records'][start:end]],
                                        device=actual.device)
                if not torch.allclose(actual, expected, atol=3e-5, rtol=3e-4):
                    raise ValueError('Full-batch native behavior replay mismatch')
                maximum = max(maximum, float((actual-expected).abs().max()))
                decisions += end-start
    if versions != [(name, value._version) for name, value in backend.policy.state_dict().items()]:
        raise ValueError('Behavior admission modified model state')
    return dict(phase='FULL_BATCH_NATIVE_BEHAVIOR_PASS', pass_=True,
                qualificationOnly=train['qualificationOnly'], trainingEligible=False,
                manifestSha256=rollouts.digest, counts=job['counts'], roles=dict(roles),
                decisions=decisions, maximumProbabilityError=maximum,
                residentPOVs=len(episodes), modelStateUnchanged=True, optimizersCreated=0,
                priorLearnerState=resume,
                trainerSources=ppo_train.trainer_sources(), producerSha256=sha(__file__),
                gpuPeakAllocatedBytes=torch.cuda.max_memory_allocated()
                if train['backend']=='torch-cuda-sdpa' else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', required=True, type=Path)
    args = parser.parse_args(); job = json.loads(args.job.read_bytes())
    out = Path(job['out']); out.mkdir(parents=True, exist_ok=False)
    report = dict(phase='VALIDATING_NATIVE_BEHAVIOR', pass_=False, optimizerStarted=False)
    try:
        report.update(validate(job))
        report['pass'] = report.pop('pass_')
        (out/'behavior.json').write_text(json.dumps(report, indent=2)+'\n')
        if job['runTraining']:
            gc.collect(); torch.cuda.empty_cache()
            for name, digest in job['hashes'].items():
                if sha(name) != digest:
                    raise ValueError('Admission changed before trainer dispatch')
            report.update(phase='NATIVE_BEHAVIOR_PASSED_DISPATCHING_TRAINER',
                          trainerDispatched=True, optimizerStarted=None)
            (out/'status.json').write_text(json.dumps(report, indent=2)+'\n')
            subprocess.run([sys.executable, ppo_train.__file__, '--job', job['trainJob']], check=True)
            report.update(phase='NATIVE_TRAINER_COMPLETE', optimizerStarted=True)
    except BaseException as error:
        report.update(phase='FAILED_RETAINED', pass_=False, error=repr(error))
        report['pass'] = report.pop('pass_'); raise
    finally:
        report['pass'] = report.pop('pass_', report.get('pass', False))
        (out/'status.json').write_text(json.dumps(report, indent=2)+'\n')


if __name__ == '__main__':
    main()
