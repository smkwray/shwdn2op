"""Guard an isolated CPU qualification using an existing live-game yield permit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

import psutil


def memory():
    result=subprocess.run(['memory_pressure'],capture_output=True,text=True,timeout=2,check=True)
    match=re.search(r'memory free percentage: (\d+)%',result.stdout)
    if match is None:raise RuntimeError('Missing memory pressure reading')
    return psutil.virtual_memory().available/2**30,int(match[1])


def permitted(path):
    try:
        row=json.loads(Path(path).read_bytes())
        return row['permit'] is True and row['active']==0 and 0<=time.time()-row['unix']<8
    except (OSError,ValueError,KeyError):return False


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',type=Path)
    parser.add_argument('--run',type=Path)
    parser.add_argument('--payload',type=Path)
    args=parser.parse_args()
    if args.run:
        if args.plan or not args.payload:raise ValueError('Bound payload required')
        job=json.loads(args.payload.read_bytes())
        os.kill(os.getpid(),signal.SIGSTOP)  # Existing yield must grant the first instruction.
        return subprocess.call(job['argv'],cwd=job['cwd'],env={**os.environ,**job['env']})
    if not args.plan or args.payload:raise ValueError('Qualification plan required')
    job=json.loads(args.plan.read_bytes());root=Path(job['cwd']).resolve();out=Path(job['receipt']).resolve()
    for name,digest in job.get('producerHashes',{}).items():
        if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:
            raise ValueError('Qualification producer drift: '+name)
    if psutil.Process().nice()<19:raise ValueError('Qualification must run at nice20')
    if Path(job['run']).is_absolute() or not (root/job['run']).resolve().is_relative_to(root/'tmp'):
        raise ValueError('Relative project-local run required')
    namespaces=[Path(p).resolve() for p in job.get('ownedNamespaces',[])]
    if any(not p.is_relative_to(root/'tmp') for p in namespaces):
        raise ValueError('Owned namespaces must be isolated project outputs')
    namespace_aliases=namespaces+[Path(os.path.abspath(p)) for p in job.get('ownedNamespaces',[])]
    supervisors={os.getpid(),*[p.pid for p in psutil.Process().parents()]}
    lexical_root=Path(os.path.abspath(job['cwd']))
    out.parent.mkdir(parents=True,exist_ok=True)
    gates=job['memory'];report={'phase':'WAIT_ADMISSION','memoryGate':gates,'cutoffUnix':job['cutoffUnix'],
        'notBeforeUnix':job.get('notBeforeUnix',0),
        'yieldStatus':job['yieldStatus'],'planSha256':hashlib.sha256(args.plan.read_bytes()).hexdigest(),
        'producerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'nice':psutil.Process().nice(),
        'ownedProcesses':{},'qualificationOnly':job.get('qualificationOnly',True)}
    def save():
        report['updatedUnix']=time.time()
        with tempfile.NamedTemporaryFile(mode='w',dir=out.parent,prefix=out.name+'.',suffix='.tmp',delete=False) as stream:
            stream.write(json.dumps(report,indent=2)+'\n')
        Path(stream.name).replace(out)
    stable=None;child=None;known={};reason=None
    try:
        while time.time()<job['cutoffUnix']:
            now=time.time();not_before=job.get('notBeforeUnix',0)
            if now<not_before:
                report['phase']='WAIT_START_WINDOW';save()
                time.sleep(min(30,not_before-now,job['cutoffUnix']-now));continue
            available,percent=memory();allow=permitted(job['yieldStatus'])
            report.update(phase='WAIT_ADMISSION',availableGiB=available,freePercent=percent,yieldPermit=allow);save()
            if (time.time()>=job.get('notBeforeUnix',0) and allow and
                available>=gates['startGiB'] and percent>=gates['startPercent']):
                if stable is None:stable=time.monotonic()
                if time.monotonic()-stable>=gates['stableSeconds']:break
            else:stable=None
            time.sleep(1)
        else:reason='CUTOFF_BEFORE_START';return 75
        report['phase']='RUNNING';save()
        child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--run',job['run'],
            '--payload',str(args.plan.resolve())],cwd=root,start_new_session=True)
        birth=psutil.Process(child.pid).create_time();report.update(pid=child.pid,birth=birth)
        def capture():
            members=[]
            try:
                process=psutil.Process(child.pid)
                if process.create_time()==birth:members=[process,*process.children(recursive=True)]
            except psutil.NoSuchProcess:pass
            # A failed launcher can exit between samples. Detached collectors
            # still carry their registered output/script/job namespace.
            for process in psutil.process_iter(['pid','name']):
                if process.pid in supervisors or not namespaces:continue
                if not any(name in (process.info['name'] or '').lower() for name in ('python','node')):continue
                try:
                    args=process.cmdline();paths=args[:4]+[args[i+1] for i,arg in enumerate(args[:-1]) if arg in ('--out','--job','--run')]
                    if any(Path(os.path.abspath(lexical_root/arg)).is_relative_to(p)
                           for p in namespace_aliases for arg in paths):
                        members.extend([process,*process.children(recursive=True)])
                # macOS psutil can raise SystemError for a foreign process that is exiting.
                except (psutil.Error,SystemError):pass
            rss=0
            for p in {member.pid:member for member in members}.values():
                if p.pid in supervisors:continue
                try:
                    known[p.pid]=p.create_time()
                    rss+=p.memory_info().rss
                except psutil.NoSuchProcess:pass
            report['peakCapturedRssGiBSum']=max(report.get('peakCapturedRssGiBSum',0),rss/2**30)
        while child.poll() is None:
            capture()
            if time.time()>=job['cutoffUnix']:reason='CUTOFF';break
            available,percent=memory();allow=permitted(job['yieldStatus'])
            report.update(availableGiB=available,freePercent=percent,yieldPermit=allow,
                          ownedProcesses={str(k):v for k,v in known.items()});save()
            if available<gates['stopGiB'] or percent<gates['stopPercent']:reason='MEMORY_GUARD';break
            if not allow:
                # The yield controller owns normal pause/resume. Cover newly born children too.
                for pid,created in known.items():
                    try:
                        p=psutil.Process(pid)
                        if p.create_time()==created:p.suspend()
                    except psutil.NoSuchProcess:pass
            time.sleep(1)
        if reason is None:
            report['returncode']=child.wait();reason='COMPLETED' if child.returncode==0 else 'FAILED_RETAINED'
            return child.returncode
        return 75
    except BaseException as error:
        reason='GUARD_ERROR';report['error']=repr(error);raise
    finally:
        if child is not None:
            capture()
            # End the owned session even if its original leader already exited.
            # A reused PID cannot authorize a signal to a different session.
            leader_reused=False
            try:leader_reused=psutil.Process(child.pid).create_time()!=birth
            except psutil.NoSuchProcess:pass
            if not leader_reused:
                try:os.killpg(child.pid,signal.SIGTERM);os.killpg(child.pid,signal.SIGCONT)
                except ProcessLookupError:pass
            if child.poll() is None:
                try:child.wait(timeout=3)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
            # Only captured PID generations; nothing else on the host is a cleanup target.
            for _ in range(3):
                capture()
                for pid,created in known.items():
                    try:
                        p=psutil.Process(pid)
                        if p.create_time()==created and p.status()!=psutil.STATUS_ZOMBIE:p.kill()
                    except psutil.NoSuchProcess:pass
                time.sleep(.1)
            time.sleep(.2)
            survivors=[]
            for pid,created in known.items():
                try:
                    p=psutil.Process(pid)
                    if p.create_time()==created and p.status()!=psutil.STATUS_ZOMBIE:survivors.append(pid)
                except psutil.NoSuchProcess:pass
            report['ownedSurvivors']=survivors
            if survivors:reason='CLEANUP_UNPROVED'
        report.update(phase=reason or 'FAILED_RETAINED',ownedProcesses={str(k):v for k,v in known.items()});save()


if __name__=='__main__':sys.exit(main())
