#!/usr/bin/env python3
"""Prepare or execute a finite, dev-only paired cohort. No automatic retries."""
import argparse
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time
import zipfile

import local_cleanup
from guards import guard, released_own_gpu
from observer import REMOTE
from spec import BASE_SHA, FLAG_KINDS, GUARDS_VERSION, RERANK_POLICY, RERANKER_VERSION, WORKER_SHA, TEAM_POOL, build, is_rerank, sha, validate

PROJECT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
# Monthly ladder set priors the live companion loads (scripts/start_companion.sh); re-ranker guards read them.
GUARD_PRIORS = PROJECT/'tmp/meta-priors/gen9uu-2026-09.descriptor.json'
# The qualified eval host's runtime (device-local, gitignored); prepare refuses any other host.
QUALIFIED_RUNTIME = PROJECT/'config/local/uu-eval-runtime.json'
SSH = ['ssh','-T','-o','BatchMode=yes','-o','ProxyJump=none','-o','ConnectTimeout=10',
       '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2']

def write(p, value):
    with Path(p).open('x') as f:
        json.dump(value, f, indent=2, allow_nan=False); f.write('\n')

def remote(runtime, code, data, timeout=60):
    command = '/usr/bin/python3 -B -c '+shlex.quote(code)+' '+shlex.quote(json.dumps(data))
    r = subprocess.run([*SSH,runtime['host'],command], text=True, capture_output=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError('REMOTE_QUERY:'+r.stderr[-2000:])
    return json.loads(r.stdout)

PREFLIGHT = r'''
import hashlib,json,os,sys
from pathlib import Path
x=json.loads(sys.argv[1]);result={}
for name, row in x['pins'].items():
 p=Path(row['path'])
 with p.open('rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
 assert h==row['sha256'],('REMOTE_PIN',name)
 result[name]={'path':str(p),'sha256':h,'bytes':p.stat().st_size}
receipt=None
if x['candidate']:
 p=Path(x['candidate']+'.receipt.json');receipt=json.loads(p.read_text())
 assert receipt['output_sha256']==x['pins']['candidate']['sha256'] and receipt['epoch']==x['epoch']
 assert receipt['base_sha256']==x['pins']['base']['sha256'] and receipt['key_shape_dtype_check'] is True
 assert receipt['output_tensors']==642
print(json.dumps({'pins':result,'exportReceipt':receipt}))
'''

# Only the active UU pilot fine-tune is an authorized sharing exception. A GPU identity that exited since the sample
# (no /proc entry, or a zombie's empty cmdline) is dropped: it shares nothing, and dropping only withdraws permission.
PROTECTED_GPU = r'''import sys,json,hashlib
from pathlib import Path
def protected(rows, proc=Path('/proc')):
 out=[]
 for x in rows:
  try:raw=(proc/str(x['pid'])/'cmdline').read_bytes()
  except (FileNotFoundError,ProcessLookupError):continue
  if not raw:continue
  assert hashlib.sha256(raw).hexdigest()==x['argv_sha256']
  argv=raw.split(b'\0');assert b'metamon.rl.finetune' in argv and b'uu_iter1' in argv
  out.append({'pid':x['pid'],'start_ticks':x['start_ticks'],'argv_sha256':x['argv_sha256'],'kind':'protected uu_iter1 fine-tune'})
 return out
if __name__=='__main__':print(json.dumps(protected(json.loads(sys.argv[1]))))
'''

def deployed(spec):
    """Producer scripts shipped to and pinned on the remote host; worker_trace.py loads action_probs.py by path."""
    names=['scripts/metamon-worker.py','scripts/uu_eval/worker_trace.py','scripts/metamon_port/action_probs.py']
    return names if is_rerank(spec) else names+['scripts/uu_selfplay/candidate_worker.py','scripts/uu_selfplay/export_candidate.py']

def pin_priors(out, descriptor):
    """Byte copies of the live set-prior descriptor and its sibling raw file; the sealed spec binds their hashes."""
    d=json.loads(descriptor.read_text());raw=descriptor.parent/d['rawFile']
    assert d['rawFile']==raw.name and sha(raw)==d['source']['sha256'], 'GUARD_PRIOR_DESCRIPTOR'
    dest=out/'guard-priors';dest.mkdir()
    for p in (descriptor,raw):shutil.copyfile(p,dest/p.name)
    return {'descriptor':str(dest/descriptor.name),'sha256':{p.name:sha(dest/p.name) for p in (descriptor,raw)}}

def check_priors(out, spec):
    if not is_rerank(spec):return
    p=spec['guardPriors'];d=Path(p['descriptor']).parent
    assert d==out/'guard-priors' and {n:sha(d/n) for n in p['sha256']}==p['sha256'], 'GUARD_PRIOR_DRIFT'

def observe(runtime, marker, prior):
    args = [runtime['remoteRoot']+'/producer/scripts/uu_eval/worker_trace.py',
            runtime['python'], marker, prior]
    r = remote(runtime, REMOTE.split("if __name__=='__main__':")[0]+
               '\nimport sys\nprint(json.dumps(collect(*json.loads(sys.argv[1]))))', args, timeout=15)
    return {'transport_returncode':0, 'sample':r}

def sharing_guard(receipt, protected, swap_floor, **kwargs):
    """Only exact pre-existing fine-tune GPU identities may be shared; never signal them."""
    r=copy.deepcopy(receipt); s=r['sample']
    current={x['pid']:x for x in s['gpu_identities']}
    for old in protected:
        x=current.get(old['pid'])
        # A finished training job need not survive, but PID reuse cannot inherit permission.
        if x and any(x[k]!=old[k] for k in ('start_ticks','argv_sha256')):
            return 'PROTECTED_GPU_IDENTITY_CHANGED'
    allowed={x['pid'] for x in protected if x['pid'] in current}
    s['gpu_pids']=[p for p in s['gpu_pids'] if p not in allowed]
    s['foreign_gpu_pids']=[p for p in s['foreign_gpu_pids'] if p not in allowed]
    if s['swap_free_bytes']<swap_floor: return 'SWAP_GROWTH'
    return guard(r, **kwargs)

def pins_local(root):
    return {str(p.relative_to(root)):sha(p) for p in sorted(root.rglob('*'))
            if p.is_file() and 'node_modules' not in p.parts and '__pycache__' not in p.parts}

def freeze(out):
    dest=out/'producer'; dest.mkdir()
    # Retain a producer instead of claiming a commit; no git operation is permitted.
    names=subprocess.run(['rg','--files','apps','scripts'],cwd=PROJECT,text=True,
                         capture_output=True,check=True).stdout.splitlines()
    names += ['package.json','package-lock.json']
    for name in sorted(set(names)):
        src=PROJECT/name
        if src.is_file():
            target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,target);target.chmod(src.stat().st_mode & 0o777)
    (dest/'node_modules').symlink_to(PROJECT/'node_modules',target_is_directory=True)
    manifest=pins_local(dest)
    write(out/'producer-manifest.json',manifest)
    with zipfile.ZipFile(out/'producer.zip','x',zipfile.ZIP_DEFLATED) as z:
        for name in manifest:z.write(dest/name,name)
    # Dependencies remain installed in place, but every byte/link is pinned before and after.
    runtime=runtime_pins()
    write(out/'runtime-manifest.json',runtime)
    return manifest

def runtime_pins():
    root=PROJECT/'node_modules'
    result={}
    for parent, dirs, files in os.walk(root,followlinks=False):
        for name in sorted(dirs+files):
            p=Path(parent)/name
            if p.is_symlink():result[str(p.relative_to(root))]={'link':os.readlink(p)}
            elif p.is_file():result[str(p.relative_to(root))]=sha(p)
    return result

def require_qualification(qualification):
    if qualification is not True:
        raise RuntimeError('CERTIFICATION_CAMPAIGN_HOLD: legacy certification entry retired; campaign ledger, fresh blocks and powered inference must qualify first')


def prepare(a):
    require_qualification(a.qualification)  # Before reading any certification family.
    out=Path(a.out).resolve()
    assert out.is_relative_to((PROJECT/'tmp').resolve()), 'OUTPUT_MUST_BE_PROJECT_TMP'  # resolved: a frozen snapshot links tmp to the project's
    assert not out.exists(), 'FRESH_RUN_REQUIRED'
    candidate_args=(a.candidate,a.run,a.epoch,a.sha256)
    seed_path=getattr(a,'seed_plan',None)
    assert seed_path is None or not a.rerank, 'SEED_PLAN_MODEL_ONLY'
    seed_plan=json.loads(Path(seed_path).read_text()) if seed_path is not None else None
    assert seed_path is None or isinstance(seed_plan,dict), 'SEED_PLAN_OBJECT'
    if a.rerank:
        assert candidate_args==(None,)*4, 'RERANK_EXCLUDES_CANDIDATE_ARGS'
        # τ: set from the precision audit's false-positive rate (floor 0.05); demoted: kinds the audit sent to amber.
        config={'tau':0.2 if a.tau is None else float(a.tau),'demoted':[k for k in (a.demote or '').split(',') if k]}
        assert 0<config['tau']<1 and len(set(config['demoted']))==len(config['demoted']) and set(config['demoted'])<=set(FLAG_KINDS), 'RERANK_CONFIG'
    else:
        assert a.tau is None and a.demote is None, 'RERANK_CONFIG_NEEDS_RERANK'
        assert None not in candidate_args, 'CANDIDATE_ARGS_REQUIRED'
        assert a.run.replace('_','').replace('-','').isalnum() and a.epoch>=0
        assert len(a.sha256)==64 and all(c in '0123456789abcdef' for c in a.sha256)
    runtime=json.loads(Path(a.runtime).read_text())
    assert runtime['host']==json.loads(QUALIFIED_RUNTIME.read_text())['host'], 'QUALIFIED_RUNTIME_ONLY'
    assert runtime['remoteRoot'].startswith(runtime['project']+'/tmp/')
    spec=build(TEAM_POOL,a.qualification,seed_plan=seed_plan)
    out.mkdir(mode=0o700)
    if a.rerank:
        # B1 = the base weights plus the residual re-ranker: no exported checkpoint, same worker as B0.
        candidate={'kind':'rerank','policyId':RERANK_POLICY,'sha256':BASE_SHA,'path':runtime['baseCheckpoint'],
                   'rerankerVersion':RERANKER_VERSION,'guardsVersion':GUARDS_VERSION,'rerankConfig':config}
        spec['guardPriors']=pin_priors(out,GUARD_PRIORS)
    else:candidate={'path':a.candidate,'sha256':a.sha256,'run':a.run,'epoch':a.epoch,
                    'policyId':f'metamon:UUFinetuned:{a.run}:{a.epoch}'}
    spec.update(candidate=candidate,
                runtime=runtime, cohortID=out.name, concurrency=1,
                limits={'admissionAvailableGiB':a.admission_gib,'swapGrowthToleranceMiB':a.swap_tolerance_mib,'activeAvailableGiB':32,'spawnAvailableGiB':40,
                        'memberRSSGiB':8,'aggregateRSSGiB':40,'maxWorkerRoots':2,
                        'matchSeconds':3600,'decisionSeconds':120,'maxTurns':1000,
                        'cohortSeconds':len(spec['games'])*3610+300})
    write(out/'spec.json',spec)
    freeze(out)
    write(out/'preregistration.json',{'specSha256':sha(out/'spec.json'),'producerZipSha256':sha(out/'producer.zip'),'producerManifestSha256':sha(out/'producer-manifest.json'),'runtimeManifestSha256':sha(out/'runtime-manifest.json')})
    print(json.dumps({'status':'PREREGISTERED','root':str(out),'families':len(spec['families']),
                      'slotsPerArm':len(spec['slots']),'games':len(spec['games'])}))

def deploy(out, spec):
    rt=spec['runtime']; files={}
    for name in deployed(spec):
        files[name]=base64.b64encode((out/'producer'/name).read_bytes()).decode()
    code="""import json,sys,base64,os
from pathlib import Path
os.umask(0o077)
x=json.loads(sys.argv[1]);r=Path(x['root']);r.mkdir()
for name,data in x['files'].items():
 p=r/'producer'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(data))
for name in ['scratch','cache/xdg','cache/hf','cache/torch','cache/matplotlib','cache/inductor','cache/triton','cache/cuda','events']:(r/name).mkdir(parents=True,exist_ok=True)
print(json.dumps({'deployed':str(r)}))"""
    return remote(rt,code,{'root':rt['remoteRoot'],'files':files})

def checkpoint_proof(out,spec):
    rt=spec['runtime']; c=spec['candidate'];prefix=rt['remoteRoot']+'/producer/';rerank=is_rerank(spec)
    pins={'base':{'path':rt['baseCheckpoint'],'sha256':BASE_SHA}}
    # The re-rank arm runs the base checkpoint itself: there is no export or receipt to prove.
    if not rerank:pins['candidate']={'path':c['path'],'sha256':c['sha256']}
    for p in deployed(spec):
        pins[p]={'path':prefix+p,'sha256':sha(out/'producer'/p)}
    assert pins['scripts/metamon-worker.py']['sha256']==WORKER_SHA
    return remote(rt,PREFLIGHT,{'pins':pins,'candidate':None if rerank else c['path'],'epoch':c.get('epoch')},timeout=90)

def launches(spec,g):
    rt=spec['runtime']; c=spec['candidate']; result={}
    for side in ('p1','p2'):
        # A re-rank B1 home is the production worker on the base checkpoint; only its identity label differs.
        candidate=g['arm']=='B1' and side==g['seat'] and not is_rerank(spec)
        identity=c['policyId'] if g['arm']=='B1' and side==g['seat'] else 'metamon:Kakuna:epoch34'
        env=copy.deepcopy(rt['env']); r=rt['remoteRoot']
        for key,suffix in {'XDG_CACHE_HOME':'xdg','HF_HOME':'hf','TORCH_HOME':'torch',
                           'MPLCONFIGDIR':'matplotlib','TORCHINDUCTOR_CACHE_DIR':'inductor',
                           'TRITON_CACHE_DIR':'triton','CUDA_CACHE_PATH':'cuda'}.items():env[key]=r+'/cache/'+suffix
        env.update(TMPDIR=r+'/scratch',SHWDN2OP_MATCH_RUN_ID=spec['cohortID'],
                   SHWDN2OP_GAME_RUN_ID=g['gameID'],UU_EVAL_POLICY=identity,
                   UU_EVAL_CHECKPOINT_SHA256=c['sha256'] if candidate else BASE_SHA,
                   UU_EVAL_EVENTS=r+'/events/'+g['gameID']+'-'+side+'.jsonl')
        args=['-B','-u',r+'/producer/scripts/uu_eval/worker_trace.py',
              r+'/producer/scripts/'+('uu_selfplay/candidate_worker.py' if candidate else 'metamon-worker.py'),
              '--checkpoint',c['path'] if candidate else rt['baseCheckpoint']]
        if candidate:args+=['--checkpoint-sha256',c['sha256'],'--base-checkpoint',rt['baseCheckpoint'],
                            '--policy-id',identity]
        args+=['--attention-backend','flex','--seed',str(g['workerSeed']),'--seed-per-side']
        result[side]={'policyId':identity,'command':'ssh','args':[*SSH[1:],rt['host'],
                      *[shlex.quote(t) for t in ['/usr/bin/env',*[k+'='+v for k,v in env.items()],rt['python'],*args]]]}
    return result

def job_for(out, spec, g):
    """match.ts input. Re-rank cohorts wrap the home seat in both arms with the same seed and pinned set priors:
    B1 executes the re-ranked pick, B0 executes Metamon's raw pick and logs the re-ranker as a shadow."""
    job={**g,'launches':launches(spec,g),'output':str(out/g['gameID'])}
    if is_rerank(spec):
        job['rerank']={'homeSide':g['seat'],'mode':'rerank' if g['arm']=='B1' else 'shadow','seed':g['workerSeed'],
                       'priorsDescriptor':spec['guardPriors']['descriptor'],'config':spec['candidate']['rerankConfig']}
    return job

def execute(out):
    spec=json.loads((out/'spec.json').read_text());rt=spec['runtime']
    require_qualification(spec['qualification'])  # Frozen historical producers remain unchanged.
    seal=json.loads((out/'preregistration.json').read_text())
    for name,key in [('spec.json','specSha256'),('producer.zip','producerZipSha256'),('producer-manifest.json','producerManifestSha256'),('runtime-manifest.json','runtimeManifestSha256')]:assert sha(out/name)==seal[key], 'PREREGISTRATION_DRIFT'
    validate(spec,TEAM_POOL)
    check_priors(out,spec)
    assert pins_local(out/'producer')==json.loads((out/'producer-manifest.json').read_text()),'PRODUCER_DRIFT'
    assert runtime_pins()==json.loads((out/'runtime-manifest.json').read_text()),'RUNTIME_DRIFT'
    assert not (out/'execution-start.json').exists(),'NO_RELAUNCH_OR_RETRY'
    write(out/'execution-start.json',{'pid':os.getpid(),'time':time.time()})
    write(out/'deployment.json',deploy(out,spec))
    write(out/'checkpoint-before.json',checkpoint_proof(out,spec))
    prior={'cohort_game_ids':[],'bound_roots':[],'selected':[],'root_limits':{}}
    first=observe(rt,spec['cohortID'],prior);write(out/'admission.json',first)
    protected=first['sample']['gpu_identities']
    protected=remote(rt,PROTECTED_GPU,protected)
    write(out/'protected-gpu.json',protected)
    # Pre-registered tolerance for unrelated swap noise on a shared host (0 = strict).
    swap=first['sample']['swap_free_bytes']-spec['limits'].get('swapGrowthToleranceMiB',0)*2**20;boot=first['sample']['boot_id']
    problem=sharing_guard(first,protected,swap,admission=True,admission_gib=spec['limits']['admissionAvailableGiB'],worker_sha=sha(HERE/'worker_trace.py'),max_roots=2,game_ids=[],root_limits={})
    if problem:
        write(out/'terminal.json',{'status':'HELD','problem':problem,'launched':0});return 2
    cancel=[False]
    for sig in (signal.SIGINT,signal.SIGTERM):signal.signal(sig,lambda *_:cancel.__setitem__(0,True))
    records=[];failure=None;start=time.monotonic()
    local_cleanup.O=out;local_cleanup.COHORT_ID=spec['cohortID'];known={}
    try:
        for g in spec['games']:
            if cancel[0]:raise RuntimeError('CANCELLED')
            if time.monotonic()-start>spec['limits']['cohortSeconds']:raise RuntimeError('COHORT_DEADLINE')
            before=observe(rt,spec['cohortID'],prior)
            problem=sharing_guard(before,protected,swap,boot=boot,worker_sha=sha(HERE/'worker_trace.py'),max_roots=2,game_ids=[],root_limits={})
            if problem or before['sample']['available_bytes']<40*2**30:raise RuntimeError(problem or 'SPAWN_AVAILABLE_RESERVATION')
            d=out/g['gameID'];d.mkdir(mode=0o700);write(d/'before.json',before)
            write(d/'job.json',job_for(out,spec,g))
            prior={'cohort_game_ids':[g['gameID']],'bound_roots':[],'selected':[],
                   'root_limits':{g['gameID']:2},'boot_id':boot}
            command=[shutil.which('node'),'--import','tsx',str(out/'producer/scripts/uu_eval/match.ts'),str(d/'job.json')]
            write(d/'command.json',command)
            captures={};proc=None;game_problem=None;began=time.monotonic();n=0
            with (d/'stdout.log').open('x') as stdout,(d/'stderr.log').open('x') as stderr:
                try:
                    proc=subprocess.Popen(command,cwd=out/'producer',stdout=stdout,stderr=stderr,start_new_session=True,
                        env={**os.environ,'TMPDIR':str(out/'scratch'),'TSX_DISABLE_CACHE':'1','PYTHONDONTWRITEBYTECODE':'1',
                             'PATH':str(HERE/'bin')+os.pathsep+os.environ['PATH'],
                             'SHWDN2OP_GAME_RUN_ID':g['gameID'],'SHWDN2OP_COHORT_ID':spec['cohortID'],
                             'SHWDN2OP_COHORT_REGISTRY':str(out/'cli-processes.jsonl')})
                    while proc.poll() is None:
                        local_cleanup.capture_owned({g['gameID']:proc},known)
                        if cancel[0] or time.monotonic()-began>3610:raise RuntimeError('CANCELLED_OR_MATCH_DEADLINE')
                        r=observe(rt,spec['cohortID'],prior);n+=1;write(d/f'sample-{n:04d}.json',r)
                        for x in r['sample']['worker_roots']:captures[(x['pid'],x['start_ticks'])]=x
                        prior.update(bound_roots=list(captures.values()),selected=r['sample']['selected'])
                        problem=sharing_guard(r,protected,swap,boot=boot,worker_sha=sha(HERE/'worker_trace.py'),max_roots=2,game_ids=[g['gameID']],root_limits={g['gameID']:2})
                        if problem:raise RuntimeError(problem)
                        until=time.monotonic()+5
                        while time.monotonic()<until and proc.poll() is None and not cancel[0]:time.sleep(.1)
                except BaseException as e:game_problem=type(e).__name__+':'+str(e)
                finally:
                    if proc is not None and proc.poll() is None:
                        proc.send_signal(signal.SIGINT)
                        try:proc.wait(timeout=8)
                        except subprocess.TimeoutExpired:
                            proc.terminate()
                            try:proc.wait(timeout=3)
                            except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=3)
            local_result=local_cleanup.stop_all({g['gameID']:proc},lambda ps:local_cleanup.capture_owned(ps,known)) if proc else {'ownedSurvivors':{}}
            write(d/'local-cleanup.json',local_result)
            # Standard worker finally closes CUDA compiler group; verify all remote descendants before next match.
            cleanup=None;released={};release_log=[]
            for k in range(31):
                cleanup=observe(rt,spec['cohortID'],prior);write(d/f'cleanup-{k}.json',cleanup)
                live=cleanup['sample']['selected']
                owned_gpu={x['pid'] for x in prior['selected']} & set(cleanup['sample']['gpu_pids'])
                if not live and not cleanup['sample']['worker_roots']:
                    screened=released_own_gpu(cleanup,{g['gameID']:list(captures.values())},{g['gameID']},released,time.monotonic())
                    if screened is not None:
                        release_log.extend(screened.get('releasedOwnGpuContexts',[]));cleanup=screened;owned_gpu=set()
                    if not owned_gpu and not release_log:break
                time.sleep(1)
            problem=sharing_guard(cleanup,protected,swap,boot=boot,worker_sha=sha(HERE/'worker_trace.py'),max_roots=2,game_ids=[g['gameID']],root_limits={g['gameID']:2})
            unloaded=not (set(x['pid'] for x in captures.values()) & set(cleanup['sample']['gpu_pids'])) and not local_result['ownedSurvivors'] and not live and not cleanup['sample']['worker_roots'] and not owned_gpu and not problem
            record={'gameID':g['gameID'],'exitCode':proc.returncode if proc else None,'problem':game_problem,
                    'capturedWorkers':list(captures.values()),'releasedOwnGpuContexts':release_log,'unloaded':unloaded,'cleanupProblem':problem}
            write(d/'lifecycle.json',record);records.append(record)
            if not unloaded:raise RuntimeError('UNLOAD_UNPROVED:'+str(problem))
            if game_problem:raise RuntimeError(game_problem)
            if len(captures)!=2:raise RuntimeError('EXACT_TWO_WORKER_IDENTITIES_REQUIRED')
            prior={'cohort_game_ids':[],'bound_roots':[],'selected':[],'root_limits':{}}
            if sum(r['exitCode'] not in (0,2) for r in records)>=3:raise RuntimeError('THREE_FAILED_GAMES_HARDSTOP')
    except BaseException as e:failure=type(e).__name__+':'+str(e)
    write(out/'checkpoint-after.json',checkpoint_proof(out,spec))
    unchanged=pins_local(out/'producer')==json.loads((out/'producer-manifest.json').read_text()) and runtime_pins()==json.loads((out/'runtime-manifest.json').read_text())
    write(out/'terminal.json',{'status':'COMPLETED' if not failure and unchanged and len(records)==len(spec['games']) and all(r['exitCode']==0 for r in records) else 'FAILED_OR_CENSORED',
                             'failure':failure,'producerAndRuntimeUnchanged':unchanged,'games':records})
    print(json.dumps({'root':str(out),'games':len(records),'failure':failure,'unchanged':unchanged}))
    return 0 if not failure and unchanged and all(r['exitCode']==0 for r in records) else 1

def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='action',required=True)
    a=sub.add_parser('prepare');a.add_argument('--out',required=True);a.add_argument('--runtime',required=True)
    # Exactly one B1: an exported candidate (all four) or --rerank (base weights + re-ranker; live set priors pinned).
    a.add_argument('--candidate');a.add_argument('--run');a.add_argument('--epoch',type=int)
    a.add_argument('--sha256');a.add_argument('--rerank',action='store_true');a.add_argument('--qualification',action='store_true')
    a.add_argument('--seed-plan',type=Path,help='Frozen native seed vectors for a model cohort')
    # Re-rank cohorts only: τ (default 0.2) and comma-separated guard kinds the precision audit demoted to amber.
    a.add_argument('--tau',type=float);a.add_argument('--demote')
    # Admission floor (GiB available). 80 = inherited R60 value; 60 leaves ample margin over a ~5 GiB match while the protected fine-tune runs.
    a.add_argument('--admission-gib',type=int,default=80)
    # Swap growth tolerance (MiB) before fail-closed SWAP_GROWTH; 0 = strict. Kernel/other-tenant swap of a few hundred KB is routine on the eval host.
    a.add_argument('--swap-tolerance-mib',type=int,default=0)
    a=sub.add_parser('run');a.add_argument('out')
    a=p.parse_args()
    if a.action=='prepare':prepare(a);return 0
    out=Path(a.out).resolve();(out/'scratch').mkdir(mode=0o700)
    return execute(out)
if __name__=='__main__':raise SystemExit(main())
