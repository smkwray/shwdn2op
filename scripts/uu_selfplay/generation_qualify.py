"""Qualify the production generation entry point with full and resumed native runs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time

import psutil
from gpu_job import capture_tree,live_owned,stop_owned


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def train(job,label,epochs,resume):
    """Hooks count real auxiliary forwards without changing inputs, losses or RNG."""
    import torch
    from metamon.rl.metamon_to_amago import MetamonAMAGOExperiment as Experiment
    start,step=Experiment.start,Experiment.train_step
    out=Path(job['out'])
    def begin(e):
        start(e);e._qualification_base_calls=0
        if (e.accelerator.device.type != job.get('device', 'cpu')
                or e.accelerator.mixed_precision != job.get('mixedPrecision', 'no')
                or torch.are_deterministic_algorithms_enabled() != job.get('deterministic', False)):
            raise RuntimeError('Native qualification device or precision differs from registration')
        def called(*args):e._qualification_base_calls+=1
        e.policy._base_tstep_encoder.register_forward_hook(called)
    def update(e,batch,log_step):
        before=e._qualification_base_calls;result=step(e,batch,log_step)
        with (out/(label+'-auxiliary.jsonl')).open('a') as stream:
            stream.write(json.dumps(dict(updates=e.grad_update_counter,logStep=log_step,
                baseForwards=e._qualification_base_calls-before,
                gpuPeakAllocatedBytes=torch.cuda.max_memory_allocated()
                    if e.accelerator.device.type == 'cuda' else 0))+'\n')
        return result
    Experiment.start,Experiment.train_step=begin,update
    name='split' if label.startswith('split') else 'full'
    args=['generation_train','--out',str(out/(label+'-updates.jsonl')),
        '--identity',job['identity'],'--seed',str(job['seed']),
        '--critic-warmup-updates',str(job['criticWarmupUpdates']),
        '--actor-warmup-updates',str(job['actorWarmupUpdates']),
        '--mixed-precision',job.get('mixedPrecision', 'no'),
        '--data-manifest',job['manifest']]
    if resume:args+=['--resume',resume]
    if job.get('deterministic', False):args+=['--deterministic']
    sys.argv=args+['--','--run_name','qualification','--save_dir',str(out/name),
        '--epochs',str(epochs),*job['trainerArguments']]
    runpy.run_module('generation_train',run_name='__main__')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job',required=True,type=Path)
    parser.add_argument('--train',choices=['full','split-initial','split-resume'])
    args=parser.parse_args();job=json.loads(args.job.read_bytes())
    if job['schema']!='uu-generation-learning-qualification@1' or job['qualificationOnly'] is not True:
        raise ValueError('Frozen qualification-only job required')
    for name,digest in job['hashes'].items():
        if sha(name)!=digest:raise ValueError('Qualification input drift: '+name)
    out=Path(job['out'])
    resume=out/'split/qualification/ckpts/training_states/qualification_epoch_0'
    if args.train:
        train(job,args.train,1 if args.train=='split-initial' else 3,
              str(resume) if args.train=='split-resume' else None);return
    out.mkdir(parents=True,exist_ok=False)
    report=dict(phase='WAIT_CPU_ADMISSION',pass_=False,qualificationOnly=True,trainingEligible=False,
        jobSha256=sha(args.job),resourceGate=job['resources'],commands=[],newGames=0)
    def save():
        report['updatedUnix']=time.time();temp=out/'report.tmp'
        temp.write_text(json.dumps(report,indent=2)+'\n');temp.replace(out/'report.json')
    save();stable=None;child=None;captured={}
    try:
        while True:
            available=psutil.virtual_memory().available/2**30;busy=psutil.cpu_percent(interval=1)
            safe=available>=job['resources']['minimumAvailableGiB'] and busy<job['resources']['maximumCpuBusyPercent']
            stable=(stable if stable is not None else time.monotonic()) if safe else None
            report.update(availableGiB=available,cpuBusyPercent=busy);save()
            if stable is not None and time.monotonic()-stable>=job['resources']['stableSeconds']:break
            time.sleep(4)
        env=os.environ|job['environment'];started=time.monotonic()
        for label in ['full','split-initial','split-resume']:
            report.update(phase='RUNNING_NATIVE_TRAINER',stage=label);save();begin=time.monotonic()
            cmd=[sys.executable,str(Path(__file__).resolve()),'--job',str(args.job.resolve()),'--train',label]
            with (out/(label+'.log')).open('x') as log:
                child=subprocess.Popen(cmd,cwd=job['cwd'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                captured[child.pid]=psutil.Process(child.pid).create_time()
                while child.poll() is None:
                    capture_tree(captured,(child.pid,))
                    if (psutil.virtual_memory().available<job['resources']['minimumAvailableGiB']*2**30
                            or time.monotonic()-started>job['resources']['maximumSeconds']):
                        raise RuntimeError('Qualification memory/deadline guard; retain partial work')
                    time.sleep(1)
                code=child.wait()
            report['commands'].append(dict(stage=label,returncode=code,seconds=time.monotonic()-begin));save()
            if code:raise RuntimeError('Started native qualification stage failed: '+label)
        report['phase']='COMPARING_NATIVE_STATES';save()
        import numpy as np
        import torch
        def equal(a,b):
            if isinstance(a,torch.Tensor):return isinstance(b,torch.Tensor) and a.dtype==b.dtype and a.shape==b.shape and a.layout==b.layout and torch.equal(a,b)
            if isinstance(a,np.ndarray):return isinstance(b,np.ndarray) and a.dtype==b.dtype and np.array_equal(a,b)
            if isinstance(a,dict):return isinstance(b,dict) and a.keys()==b.keys() and all(equal(v,b[k]) for k,v in a.items())
            if isinstance(a,(tuple,list)):return type(a)==type(b) and len(a)==len(b) and all(equal(x,y) for x,y in zip(a,b))
            return a==b
        weights=lambda run,epoch:out/run/'qualification/ckpts/policy_weights'/f'policy_epoch_{epoch}.pt'
        final=torch.load(weights('full',2),map_location='cpu',weights_only=True)
        repeated=torch.load(weights('split',2),map_location='cpu',weights_only=True)
        if not equal(final,repeated):raise AssertionError('Full/split native model tensors differ')
        state=lambda run:out/run/'qualification/ckpts/training_states/qualification_epoch_2'
        files=sorted(p.name for p in state('full').iterdir() if p.is_file())
        if files!=sorted(p.name for p in state('split').iterdir() if p.is_file()):raise AssertionError('Native checkpoint members differ')
        compared=[]
        for name in files:
            if name.endswith(('.bin','.pkl','.pt')):
                a=torch.load(state('full')/name,map_location='cpu',weights_only=False)
                b=torch.load(state('split')/name,map_location='cpu',weights_only=False)
                if not equal(a,b):raise AssertionError('Native resume state differs: '+name)
                compared.append(name)
        if not any('optimizer' in p for p in compared) or not any('random' in p for p in compared):
            raise AssertionError('Optimizer and RNG checkpoint comparison required')
        base=torch.load(job['checkpoint'],map_location='cpu',weights_only=True)
        early=torch.load(weights('full',0),map_location='cpu',weights_only=True)
        primary=lambda k:k.startswith(('tstep_encoder.','traj_encoder.','actor.'))
        if any(not torch.equal(v,base[k]) for k,v in early.items() if primary(k)):
            raise AssertionError('Primary moved during critic-only warmup')
        rows=[json.loads(s) for s in (out/'full-updates.jsonl').read_text().splitlines()]
        released=[r for r in rows if not r['criticWarmup']]
        first=job['learningRate']/job['actorWarmupUpdates']
        if rows[-1]['updates']!=9 or not released or released[0]['actorLearningRate']!=first:
            raise AssertionError('Native update counter or actor release LR differs')
        calls=[json.loads(s) for s in (out/'full-auxiliary.jsonl').read_text().splitlines()]
        if not any(r['baseForwards']==0 and not r['logStep'] for r in calls):
            raise AssertionError('No real disabled base forward was skipped')
        if any(r['baseForwards']!=int(r['logStep']) for r in calls):
            raise AssertionError('Auxiliary forward cadence differs from declared monitor')
        gpu = job.get('device', 'cpu') == 'cuda'
        if job.get('microbatch') is not None and any(r['batch'] != job['microbatch'] for r in rows):
            raise AssertionError('Actual native microbatch differs from registration')
        report.update(phase='QUALIFIED_GPU_GENERATION_LEARNING_COMPONENT' if gpu else 'QUALIFIED_CPU_GENERATION_LEARNING',pass_=True,
            nativeModelResumeIdentical=True,nativeOptimizerSchedulerRngIdentical=True,
            comparedStateFiles=compared,primaryFrozenDuringCriticWarmup=True,
            firstActorLearningRate=first,actualUpdates=9,actualMicrobatches=len(rows),
            skippedAuxiliaryForwards=sum(r['baseForwards']==0 for r in calls),
            nativeGpuQualified=gpu,mixedPrecision=job.get('mixedPrecision', 'no'),
            deterministic=job.get('deterministic', False),
            gpuPeakAllocatedBytes=max(r['gpuPeakAllocatedBytes'] for r in calls),
            finalPolicySha256=sha(weights('full',2)))
    except BaseException as error:
        report.update(phase='FAILED_RETAINED',error=repr(error));raise
    finally:
        stop_owned(captured)
        if child is not None:child.wait()
        report['ownedSurvivors']=[p.pid for p in live_owned(captured)]
        report['pass']=report.pop('pass_');save()


if __name__=='__main__':main()
