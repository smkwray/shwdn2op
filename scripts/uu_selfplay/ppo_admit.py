"""Verify one closed PPO version and admit only its exact planned learner POVs."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import psutil
from gpu_job import capture_tree,live_owned,stop_owned


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job',required=True,type=Path);parser.add_argument('--admit',action='store_true')
    args=parser.parse_args();job=json.loads(args.job.read_bytes())
    if job['schema']!='uu-ppo-version-admission@1':raise ValueError('Frozen version admission required')
    for name,digest in job['hashes'].items():
        if sha(name)!=digest:raise ValueError('Admission producer/input drift: '+name)
    source=json.loads(Path(job['sourceReport']).read_bytes());guard=json.loads(Path(job['sourceGuard']).read_bytes())
    if (source['phase']!='RAW_PPO_VERSION_COMPLETE' or source.get('pass') is not True
            or source['jobSha256']!=job['collectionJobSha256'] or guard['status']!='COMPLETED'
            or guard['returncode']!=0):raise ValueError('Collection and native guard must close successfully')
    for pid,birth in guard['capturedProcesses'].items():
        try:
            p=psutil.Process(int(pid))
            if p.create_time()==birth and p.status()!=psutil.STATUS_ZOMBIE:raise ValueError('Source descendant remains alive')
        except psutil.NoSuchProcess:pass
    if args.admit:
        from ppo_collect import admit
        manifest=admit(job['collection'],job['slots'],job['replayReport'],job['manifest'])
        counts=Counter(r['split'] for r in manifest['rows'])
        if manifest['counts']!={'battles':1000,'learnerPOVs':1200} or counts!=dict(actor=1020,value=120,reserve=60):
            raise ValueError('Whole-version POV and split quotas differ')
        return
    out=Path(job['out']);out.mkdir(parents=True,exist_ok=False)
    report=dict(phase='WAIT_CPU_ADMISSION',pass_=False,trainingEligible=False,optimizerStarted=False,
        jobSha256=sha(args.job),resourceGate=job['resources'],commands=[])
    def save():
        report['updatedUnix']=time.time();temp=out/'status.tmp'
        temp.write_text(json.dumps(report,indent=2)+'\n');temp.replace(out/'status.json')
    captured={};child=None;stable=None;save()
    try:
        while True:
            if time.time()>=job['latestStartUnix']:raise TimeoutError('Unstarted CPU admission boundary')
            memory=psutil.virtual_memory().available/2**30;busy=psutil.cpu_percent(interval=1)
            safe=memory>=job['resources']['minimumAvailableGiB'] and busy<job['resources']['maximumCpuBusyPercent']
            stable=(stable if stable is not None else time.monotonic()) if safe else None
            report.update(availableGiB=memory,cpuBusyPercent=busy);save()
            if stable is not None and time.monotonic()-stable>=job['resources']['stableSeconds']:break
            time.sleep(4)
        collection=Path(job['collection']);slots=json.loads(Path(job['slots']).read_bytes())
        planned={r['id'] for r in slots};games=sorted(collection.glob('worker-*/*/summary.json'))
        if len(games)!=1000 or {p.parent.name for p in games}!=planned:raise ValueError('Closed game set differs from schedule')
        replay=dict(programSha256=job['replayProducerSha256'],runtime=job['runtime'],
            verifierSha256=job['verifierSha256'],workers=2,out=str(out/'replay'),
            verifierTimeoutMs=job['verifierTimeoutMs'],games=[str(p.parent) for p in games])
        replay_job=out/'replay-job.json'
        with replay_job.open('x') as stream:json.dump(replay,stream,indent=2)
        started=time.monotonic()
        commands=[('exact-replays',[sys.executable,job['replayProducer'],str(replay_job)]),
                  ('allowlist',[sys.executable,str(Path(__file__).resolve()),'--job',str(args.job.resolve()),'--admit'])]
        for label,command in commands:
            report.update(phase='RUNNING_'+label.upper().replace('-','_'));save();begin=time.monotonic()
            with (out/(label+'.log')).open('x') as log:
                child=subprocess.Popen(command,cwd=job['projectRoot'],env=os.environ|job['env'],
                    stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                captured[child.pid]=psutil.Process(child.pid).create_time()
                while child.poll() is None:
                    capture_tree(captured,(child.pid,))
                    if (psutil.virtual_memory().available<job['resources']['minimumAvailableGiB']*2**30
                            or time.monotonic()-started>job['resources']['maximumSeconds']):
                        raise RuntimeError('Admission memory/deadline guard; retain partial proofs')
                    time.sleep(1)
                code=child.wait()
            report['commands'].append(dict(stage=label,returncode=code,seconds=time.monotonic()-begin));save()
            if code:raise RuntimeError('Started admission failed; preserve, no automatic retry: '+label)
        proof=json.loads(Path(job['replayReport']).read_bytes());manifest=json.loads(Path(job['manifest']).read_bytes())
        if proof['verifiedCompletedGames']!=1000 or proof['modelCalls']!=0:raise ValueError('Exact zero-NN replay coverage differs')
        report.update(phase='ROLLOUT_MANIFEST_ADMITTED_NATIVE_TRAINING_PENDING',pass_=True,
            exactReplays=1000,learnerPOVs=1200,manifestSha256=sha(job['manifest']),
            replayReportSha256=sha(job['replayReport']),nativeLoaderBehaviorAndGpuMemoryAdmission='PENDING')
    except BaseException as error:
        report.update(phase='FAILED_RETAINED',error=repr(error));raise
    finally:
        stop_owned(captured)
        if child is not None:child.wait()
        report['ownedSurvivors']=[p.pid for p in live_owned(captured)]
        if report['ownedSurvivors']:
            report.update(phase='CLEANUP_UNPROVED',pass_=False)
        report['pass']=report.pop('pass_');save()


if __name__=='__main__':main()
