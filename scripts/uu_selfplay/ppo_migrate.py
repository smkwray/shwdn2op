"""Explicit fixed-initial anchor migration; all mutable learner state survives."""
import argparse
import json
from pathlib import Path

import torch

from ppo import sha
from ppo_train import trainer_identity


def prepare(job):
    if (job['schema']!='uu-ppo-resume-migration@1'
            or type(job['qualificationOnly']) is not bool):
        raise ValueError('Explicit frozen resume migration required')
    for binding in job['bindings'].values():
        if sha(binding['path'])!=binding['sha256']:raise ValueError('Migration binding drift')
    prior=job['bindings']['priorState'];target=json.loads(Path(job['bindings']['targetTrainJob']['path']).read_bytes())
    if target['schema']!='uu-ppo-train@1' or target['qualificationOnly']!=job['qualificationOnly']:
        raise ValueError('Matching qualification disposition required')
    identity=trainer_identity(target)
    if identity.get('anchorGuard',{}).get('method')!='initial-positive-excess-e34-kl@1':
        raise ValueError('Only the registered fixed-initial anchor migration is supported')
    state=torch.load(prior['path'],map_location='cpu',weights_only=False,mmap=True)
    fields={'policy','head','actor','value','actorSteps','version','passIndex','batchSha','stopped',
            'identity','recipe','pythonRNG','numpyRNG','torchRNG','cudaRNG'}
    producers={name:job['bindings'][name]['sha256'] for name in ('ppo.py','ppo_collect.py','ppo_train.py')}
    expected=dict(arm=target['identity'],anchor=identity['anchor'],producer=producers)
    proof=json.loads(Path(job['bindings']['priorGpuQualification']['path']).read_bytes())
    receipt=json.loads(Path(job['bindings']['priorExportReceipt']['path']).read_bytes())
    if (set(state)!=fields or state['identity']!=expected or state['recipe']!=target['recipe']
            or not (state['stopped'] or state['passIndex']==state['recipe']['passes'])
            or type(state['actorSteps']) is not int or state['actorSteps']<0
            or proof.get('pass') is not True or proof.get('phase')!='QUALIFIED_GPU_NATIVE_PPO'
            or any(proof['trainerSources'].get(name)!=digest for name,digest in producers.items())
            or receipt['identity']!=expected or receipt['actorSteps']!=state['actorSteps']
            or receipt['completedPasses']!=state['passIndex'] or receipt['klStopped']!=state['stopped']
            or receipt['output_sha256']!=sha(target['checkpoint'])):
        raise ValueError('Closed qualified prior learner, identical recipe, and exact export required')
    checkpoint=torch.load(target['checkpoint'],map_location='cpu',weights_only=True,mmap=True)
    if (checkpoint.keys()!=state['policy'].keys() or any(
            not torch.equal(value,checkpoint[name]) for name,value in state['policy'].items())):
        raise ValueError('Migration cannot change the exported actor')
    if not job['qualificationOnly']:
        binding=job['bindings'].get('nativeMigrationQualification')
        if not binding:raise ValueError('Actual native GPU full-state migration qualification required')
        proof=json.loads(Path(binding['path']).read_bytes())
        if (proof.get('pass') is not True or proof.get('phase')!='NATIVE_GPU_RESUME_MIGRATION_QUALIFIED'
                or proof.get('migrationProducerSha256')!=sha(__file__)
                or proof.get('priorStateSha256')!=prior['sha256']
                or proof.get('targetIdentity')!=identity
                or proof.get('wholeStateFullSplitResumeIdentical') is not True
                or proof.get('ownedSurvivors')!=[]):
            raise ValueError('Matching whole-state native migration proof required')
    # A shallow replacement deliberately retains every mutable value by identity.
    migrated=dict(state,identity=identity)
    assert all(migrated[key] is state[key] for key in fields-{'identity'})
    return migrated,dict(priorStateSha256=prior['sha256'],priorIdentity=state['identity'],
        targetIdentity=identity,actorSteps=state['actorSteps'],version=state['version'],
        unchangedFields=sorted(fields-{'identity'}),migrationProducerSha256=sha(__file__),
        qualificationOnly=job['qualificationOnly'],trainingEligible=not job['qualificationOnly'])


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--job',required=True,type=Path)
    args=parser.parse_args();job=json.loads(args.job.read_bytes());state,report=prepare(job)
    out=Path(job['out']);out.mkdir(parents=True,exist_ok=False)
    torch.save(state,out/'resume.pt');report['outputSha256']=sha(out/'resume.pt')
    (out/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')


if __name__=='__main__':main()
