"""Scientific guard regressions: team/seed identity is the treatment control."""
import copy
import random
import itertools
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import shlex
import zipfile
import analyze as analysis
import evaluate
import verify
from spec import BASE_SHA, build, games_for, sha, validate
from analyze import paired_inference, private_material, analyze
from evaluate import launches, sharing_guard
from guards import guard
from observer import REMOTE
from verify import verify_recurrence

PROJECT=Path(__file__).resolve().parents[2]
HERE_NATIVE=Path(__file__).resolve().with_name('verify_native.ts')
# A synthetic roster pool: the real pool is device-local, and the design is checked on its structure, not its teams.
POOL=Path(__file__).resolve().with_name('fixtures')/'team-pool'
(PROJECT/'tmp').mkdir(exist_ok=True)  # Cohort outputs must live under project tmp/ (gitignored, absent in a fresh clone).

def setUpModule():
    for module in (evaluate,verify,analysis):
        patcher=patch.object(module,'TEAM_POOL',POOL);patcher.start();unittest.addModuleCleanup(patcher.stop)
RERANK='metamon:Kakuna:epoch34+rerank@2'
CONFIG={'tau':0.2,'demoted':[]}
KAKUNA='metamon:Kakuna:epoch34'
RUNTIME={'remoteRoot':'/p/tmp/test','python':'/v/bin/python','host':'user@gpubox','env':{},'baseCheckpoint':'/p/base.pt','project':'/p'}

def node(*args, tmp):
    return subprocess.run(['node','--import','tsx',*map(str,args)],cwd=PROJECT,text=True,capture_output=True,timeout=120,
                          env={**os.environ,'TMPDIR':str(tmp),'TSX_DISABLE_CACHE':'1'})

def local_remote(rt, code, data, timeout=60):
    """evaluate.remote minus ssh: the exact remote program, run against local files."""
    r=subprocess.run([sys.executable,'-B','-c',code,json.dumps(data)],text=True,capture_output=True,timeout=timeout)
    if r.returncode:raise RuntimeError('REMOTE_QUERY:'+r.stderr[-2000:])
    return json.loads(r.stdout)

def write_priors(folder):
    """A tiny loader-valid monthly ladder prior: descriptor plus sibling raw file."""
    raw=json.dumps({'info':{'metagame':'gen9uu','cutoff':1500,'team type':None},'data':{'Garchomp':{
        'Abilities':{'roughskin':10},'Moves':{'earthquake':9},'Items':{'choicescarf':5},'Tera Types':{'ground':4},'Raw count':12}}}).encode()
    (folder/'raw.json').write_bytes(raw)
    (folder/'priors.descriptor.json').write_text(json.dumps({'version':1,'rawFile':'raw.json','source':{
        'url':'https://www.smogon.com/stats/2026-09/chaos/gen9uu-1500.json','period':'2026-09','formatId':'gen9uu',
        'ratingCutoff':1500,'sha256':hashlib.sha256(raw).hexdigest()}}))
    return folder/'priors.descriptor.json'

def rerank_spec(folder, qualification=True):
    s=build(POOL,qualification)
    s.update(cohortID='test-cohort',runtime=copy.deepcopy(RUNTIME),guardPriors={'descriptor':str(write_priors(folder))},
             candidate={'kind':'rerank','policyId':RERANK,'sha256':BASE_SHA,'path':RUNTIME['baseCheckpoint'],
                        'rerankerVersion':'metamon-rerank@2','guardsVersion':'tactical-guards@6','rerankConfig':copy.deepcopy(CONFIG)})
    return s

def jl(path):return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
def wjl(path,xs):path.write_text(''.join(json.dumps(x)+'\n' for x in xs))

class DesignTests(unittest.TestCase):
    def setUp(self):self.s=build(POOL)
    def test_frozen_four_seed_plan_balances_1120_game_model_cohort(self):
        plan={'schema':'uu-eval-seeds@1','namespace':'model-confirmatory-test',
              'vectors':[[101,103,107,109],[113,127,131,137],[139,149,151,157],[163,167,173,179]]}
        s=build(POOL,seed_plan=plan);n=len(s['families'])
        self.assertEqual(len(s['games']),n*32);self.assertEqual(s['fullDevSlotsPerArm'],n*16)
        self.assertEqual(s['seedPlan'],plan)
        for f in s['families']:
            slots=[x for x in s['slots'] if x['family']==f['family']]
            self.assertEqual(len(slots),16)
            self.assertEqual(sum(x['opponentFamily']==f['family'] for x in s['slots']),16)
            self.assertEqual({(x['assignment'],x['seat'],tuple(x['seed'])) for x in slots},
                             set(itertools.product((1,2),('p1','p2'),map(tuple,plan['vectors']))))
        self.assertEqual(len({x['workerSeed'] for x in s['slots']}),len(s['slots']))
        self.assertEqual(len(build(POOL,True,seed_plan=plan)['games']),8)
        plan['vectors'][0][0]+=1
        self.assertNotEqual(s['seedPlan'],plan)
        s['seedPlan']=plan
        with self.assertRaisesRegex(AssertionError,'PREREGISTERED_SLOT_DESIGN_DRIFT'):validate(s,POOL)
        s=build(POOL,seed_plan=plan);s['fullDevSlotsPerArm']-=1
        with self.assertRaisesRegex(AssertionError,'PREREGISTERED_SLOT_COUNT_DRIFT'):validate(s,POOL)
    def test_malformed_seed_plan_rejected_before_pool_or_team_read(self):
        base={'schema':'uu-eval-seeds@1','namespace':'test','vectors':[[1,2,3,4]]}
        invalid=[{},dict(base,unknown=True),dict(base,schema='other'),dict(base,namespace=''),
                 dict(base,namespace='bad namespace'),dict(base,vectors=[]),
                 dict(base,vectors=[[1,2,3]]),dict(base,vectors=[[True,2,3,4]]),
                 dict(base,vectors=[[65536,2,3,4]]),dict(base,vectors=[[1,2,3,4]]*2)]
        for plan in invalid:
            with self.subTest(plan=plan),patch('spec.dev_families',side_effect=RuntimeError('TEAM_READ')):
                with self.assertRaisesRegex(AssertionError,'SEED_PLAN'):build(POOL,seed_plan=plan)
    def test_full_design_balances_every_team_without_cartesian_growth(self):
        n=len(self.s['families']);self.assertEqual(len(self.s['slots']),n*8)
        for f in self.s['families']:
            self.assertEqual(sum(s['family']==f['family'] for s in self.s['slots']),8)
            self.assertEqual(sum(s['opponentFamily']==f['family'] for s in self.s['slots']),8)
        self.assertEqual([g['arm'] for g in self.s['games'][:4]],['B0','B1','B1','B0'])
    def test_qualification_four_paired_slots_both_candidate_seats(self):
        s=build(POOL,True);self.assertEqual(len(s['slots']),4);self.assertEqual(len(s['games']),8)
        self.assertEqual({g['seat'] for g in s['games'] if g['arm']=='B1'},{'p1','p2'})
    def test_arm_seed_or_team_or_slot_mutation_fails(self):
        for mutation in ('seed','workerSeed','teamFiles','slotID'):
            s=copy.deepcopy(self.s);g=s['games'][1]
            if mutation=='seed':g['seed'][0]+=1
            elif mutation=='workerSeed':g['workerSeed']+=1
            elif mutation=='teamFiles':g['teamFiles']['p1']='other-team'
            else:g['slotID']='other-slot'
            with self.subTest(mutation=mutation),self.assertRaises(AssertionError):validate(s,POOL)
    def test_held_out_rejected_before_any_team_read(self):
        s=copy.deepcopy(self.s);s['slots'][0]['teamFiles']['p1']=str(POOL/'teams/uu_held_out_v1/forbidden')
        s['games']=games_for(s['slots'])
        with self.assertRaises(AssertionError):validate(s,POOL)
    def test_both_arms_cannot_coherently_change_the_seed_or_team(self):
        s=copy.deepcopy(self.s);s['slots'][0]['seed'][0]+=1;s['games']=games_for(s['slots'])
        with self.assertRaises(AssertionError):validate(s,POOL)
    def test_candidate_only_home_and_same_policy_streams(self):
        s=copy.deepcopy(self.s);s.update(cohortID='test-cohort',candidate={'path':'/p/x.pt','sha256':'a'*64,'policyId':'metamon:UUFinetuned:test:2'},
            runtime={'remoteRoot':'/p/tmp/test','python':'/v/bin/python','host':'user@gpubox','env':{},'baseCheckpoint':'/p/base.pt'})
        a,b=[launches(s,g) for g in s['games'][:2]];home=s['games'][0]['seat'];opp='p2' if home=='p1' else 'p1'
        self.assertEqual(json.dumps(a[opp]).replace('-B0','-ARM'),json.dumps(b[opp]).replace('-B1','-ARM'));self.assertEqual(b[home]['policyId'],s['candidate']['policyId'])
        self.assertIn('--policy-id',b[home]['args']);self.assertEqual(b[home]['args'].count('--policy-id'),1)
        for launch in (a[home],b[home],b[opp]):
            tokens=shlex.split(' '.join(launch['args'][launch['args'].index('user@gpubox')+1:]))
            self.assertEqual(tokens[tokens.index('--seed')+1],str(s['games'][0]['workerSeed']))
            self.assertIn('--seed-per-side',tokens)
    def test_bootstrap_clusters_not_seed_rows(self):
        pairs=[{'family':'a','x':1}]*20+[{'family':'b','x':-1}]
        r=paired_inference(pairs,'x',500,1)
        self.assertEqual(r['families'],2);self.assertEqual(r['mean'],0);self.assertEqual(r['permutationP'],1)
    def test_single_family_has_no_fake_ci(self):
        self.assertIsNone(paired_inference([{'family':'a','x':2}],'x',100)['ci95'])
    def test_terminal_exact_private_hp(self):
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            p=Path(folder)/'p.jsonl';mons=[{'ident':f'p1: Mon{i}','condition':'100/200'} for i in range(6)]
            request='|request|'+json.dumps({'side':{'id':'p1','pokemon':mons},'active':[{}]})
            p.write_text(json.dumps('|turn|1\n'+request+'\n|-damage|p1a: Mon0|50/200\n')+'\n')
            starts,end=private_material(p,'p1');self.assertEqual(starts,{1:300});self.assertEqual(end,275)

class FailedGameVerificationTests(unittest.TestCase):
    # Matters: e2 (2026-10-22) attempted all 560 games and lost one to a worker start failure. The pre-registration
    # excludes incomplete pairs from paired statistics, so that run must still verify its 559 completed games; but a
    # censored, drifted, partial or hardstopped run must never verify, and the failures must be listed, not hidden.
    def terminal(self, codes, failure=None, unchanged=True, unloaded=True):
        return {'status':'COMPLETED' if not failure and unchanged and all(c == 0 for c in codes) else 'FAILED_OR_CENSORED',
                'failure':failure,'producerAndRuntimeUnchanged':unchanged,
                'games':[{'gameID':f'g{i}','exitCode':c,'unloaded':unloaded} for i, c in enumerate(codes)]}

    def test_only_a_complete_attempt_with_few_failures_verifies(self):
        spec = {'games':[{'gameID':f'g{i}'} for i in range(4)]}
        self.assertEqual(verify.failed_games(self.terminal([0,0,0,0]), spec), set())
        self.assertEqual(verify.failed_games(self.terminal([0,1,0,0]), spec, allow=True), {'g1'})
        for terminal, allow in [(self.terminal([0,1,0,0]), False),                       # needs the explicit flag
                                (self.terminal([0,1,0,0], failure='RuntimeError:UNLOAD_UNPROVED:HEAVY_HARDSTOP'), True),
                                (self.terminal([0,1,0,0], unchanged=False), True),     # producer/runtime drift
                                (self.terminal([0,1,0,0], unloaded=False), True),      # cleanup not proven
                                (self.terminal([1,1,1,0]), True),                      # three failures = hardstop
                                (self.terminal([0,1,0]), True)]:                       # not every game attempted
            with self.assertRaises(AssertionError):
                verify.failed_games(terminal, spec, allow=allow)


class CensoringTests(unittest.TestCase):
    def test_true_terminal_carries_but_truncation_and_missing_games_do_not(self):
        spec=build(POOL,True);spec['candidate']={'policyId':'metamon:UUFinetuned:test:0'}
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder);(root/'spec.json').write_text(json.dumps(spec))
            for i,g in enumerate(spec['games'][:4]):
                d=root/g['gameID'];d.mkdir()
                summary={'status':'completed' if i<2 else 'truncated','turn':1,'winner':'p1' if i<2 else None,
                         'errors':[],'fallbacks':[],'stopReason':None if i<2 else 'deadline',
                         'players':{s:{'switches':0,'tera':0} for s in ('p1','p2')}}
                (d/'summary.json').write_text(json.dumps(summary));(d/'trajectory.jsonl').write_text('')
                if i>=2:continue
                (d/'replay-inputs.json').write_text('{}')
                for side in ('p1','p2'):
                    condition='100/200' if side=='p1' else '200/200'
                    mons=[{'ident':f'{side}: Mon{n}','condition':condition} for n in range(6)]
                    frame='|turn|1\n|request|'+json.dumps({'side':{'id':side,'pokemon':mons},'active':[{}]})+'\n'
                    (d/(side+'-private.jsonl')).write_text(json.dumps(frame)+'\n')
            result=analyze(root)
            self.assertEqual(result['arms']['B0']['completed'],1)
            self.assertEqual(result['arms']['B0']['censoredOrMissing'],3)
            self.assertEqual(result['arms']['B0']['M5'],-300)
            self.assertEqual(result['arms']['B0']['AUC5-15'],-300)
            self.assertEqual(result['paired']['AUC5-15']['pairs'],1)
            self.assertEqual(len(result['excluded']),6)
            self.assertEqual(result['arms']['B0']['timeouts'],1)

class SharingTests(unittest.TestCase):
    def receipt(self):
        return {'transport_returncode':0,'sample':{'gpu_identities':[{'pid':7,'start_ticks':'10','argv_sha256':'abc'}],
                 'swap_free_bytes':100,'gpu_pids':[7],'foreign_gpu_pids':[7]}}
    def test_only_exact_protected_gpu_subtracted(self):
        r=self.receipt();protected=copy.deepcopy(r['sample']['gpu_identities'])
        with patch('evaluate.guard',return_value=None) as g:
            self.assertIsNone(sharing_guard(r,protected,100));self.assertEqual(g.call_args.args[0]['sample']['gpu_pids'],[])
        self.assertEqual(r['sample']['gpu_pids'],[7])
    def test_new_foreign_gpu_keeps_its_guard(self):
        r=self.receipt();r['sample']['gpu_pids'].append(8);r['sample']['foreign_gpu_pids'].append(8)
        with patch('evaluate.guard',return_value='FOREIGN_GPU_HARDSTOP') as g:
            self.assertEqual(sharing_guard(r,r['sample']['gpu_identities'],100),'FOREIGN_GPU_HARDSTOP')
            self.assertEqual(g.call_args.args[0]['sample']['foreign_gpu_pids'],[8])
    def test_pid_reuse_is_not_permission(self):
        r=self.receipt();protected=copy.deepcopy(r['sample']['gpu_identities']);r['sample']['gpu_identities'][0]['start_ticks']='11'
        self.assertEqual(sharing_guard(r,protected,100),'PROTECTED_GPU_IDENTITY_CHANGED')
    def test_swap_growth_stops(self):
        r=self.receipt();self.assertEqual(sharing_guard(r,[],101),'SWAP_GROWTH')

class RetainedGuardTests(unittest.TestCase):
    def sample(self):
        return {'transport_returncode':0,'sample':{
            'boot_id':'boot','worker_sha256':'hash','marked_worker_count':0,
            'worker_roots':[],'selected':[],'identity_errors':[],'worker_path_candidates':[],
            'available_bytes':80*2**30,'own_tree_rss_bytes':0,'load1':0,
            'game_tree_rss_bytes':{},'gpu_pids':[],'foreign_gpu_pids':[],
            'checks':{k:{'returncode':0,'stdout':v} for k,v in {
                'claims':'{"ok":true,"claims":[]}','heavy':'{"ok":true,"current":null}',
                'gpu':'','cpu':''}.items()}}}
    def test_admission_memory_claim_and_boot_are_real_stops(self):
        r=self.sample();self.assertIsNone(guard(r,admission=True,worker_sha='hash'))
        r['sample']['available_bytes']-=1
        self.assertEqual(guard(r,admission=True),'AVAILABLE_MEMORY_HARDSTOP')
        # Matters: the pre-registered admission floor must actually govern admission, not a hard-coded 80 GiB.
        self.assertIsNone(guard(r,admission=True,worker_sha='hash',admission_gib=60))
        r=self.sample();r['sample']['checks']['claims']['stdout']='{"ok":true,"claims":[1]}'
        self.assertEqual(guard(r),'CLAIM_HARDSTOP')
        self.assertEqual(guard(self.sample(),boot='other'),'BOOT_ID_CHANGED')
    def test_gpu_query_failure_and_worker_hash_cannot_be_ignored(self):
        r=self.sample();r['sample']['checks']['gpu']['returncode']=1
        self.assertEqual(guard(r),'QUERY_FAILURE:gpu')
        self.assertEqual(guard(self.sample(),worker_sha='other'),'WORKER_HASH_CHANGED')
    def test_counter_limit_is_bounded_and_covers_busy_host(self):
        ns={'__name__':'test_observer'};exec(REMOTE,ns)
        def counters(n):return {'boot_id':'boot','hz':100,'observed_ns':100,
                               'counters':[[i+1,1,0,99] for i in range(n)]}
        self.assertEqual(ns['cpu_window'](counters(525),None),('pending',[]))
        with self.assertRaisesRegex(ValueError,'cpu_counter_limit'):
            ns['cpu_window'](counters(2049),None)

class VanishedProcessTests(unittest.TestCase):
    """Eval-host processes exit between the /proc listing and later reads (an e4 cohort died on exactly this when its own
    worker exited at game end). A vanished process is skipped; a live process whose files cannot be read still fails."""
    WORKER,PYTHON,MARK,GAME=b'/r/worker_trace.py',b'/v/bin/python','cohort','g1'
    def setUp(self):
        self.proc=Path(tempfile.mkdtemp());self.addCleanup(shutil.rmtree,self.proc)
        (self.proc/'sys/kernel/random').mkdir(parents=True);(self.proc/'sys/kernel/random/boot_id').write_text('boot\n')
        (self.proc/'meminfo').write_text('MemAvailable: 104857600 kB\nSwapFree: 5 kB\n');(self.proc/'loadavg').write_text('0.1 0 0\n')
        self.ns={'__name__':'test_observer'};exec(REMOTE,self.ns)
    def pid(self, pid, ppid, argv, environ=b''):
        d=self.proc/str(pid);d.mkdir()
        fields=['S',str(ppid)]+['0']*9+['3','4']+['0']*6+[str(1000+pid)]+['0']*5
        (d/'stat').write_text(f'{pid} (x) '+' '.join(fields));(d/'cmdline').write_bytes(b'\0'.join(argv)+b'\0')
        (d/'status').write_text('VmRSS:\t8 kB\n');(d/'environ').write_bytes(environ)
    def host(self):
        """Our cohort worker (GPU) with a child, plus a foreign GPU process."""
        self.pid(100,1,[self.PYTHON,self.WORKER],b'SHWDN2OP_MATCH_RUN_ID=cohort\0SHWDN2OP_GAME_RUN_ID=g1\0')
        self.pid(101,100,[b'/usr/bin/nvcc'])
        self.pid(200,1,[b'/usr/bin/python3',b'-m',b'metamon.rl.finetune'])
    def collect(self, vanish=(), deny=()):
        """vanish: (pid, file, nth read) exits the process at that read; deny: (pid, file) is unreadable but alive."""
        reads={}
        def hooked(original):
            def read(path,*args,**kwargs):
                pid,name=path.parent.name,path.name;reads[(pid,name)]=reads.get((pid,name),0)+1
                for v_pid,v_name,nth in vanish:
                    if (str(v_pid),v_name,nth)==(pid,name,reads[(pid,name)]):
                        shutil.rmtree(path.parent);raise FileNotFoundError(str(path))
                if (pid,name) in {(str(a),b) for a,b in deny}:raise PermissionError(str(path))
                return original(path,*args,**kwargs)
            return read
        outputs={'gpubox-ai':'{"ok":true,"claims":[]}','gpubox-heavy':'{"ok":true,"current":null}','nvidia-smi':'100, python, 900\n200, python, 900\n','ps':''}
        prior={'cohort_game_ids':[self.GAME],'root_limits':{self.GAME:2},'boot_id':'boot','bound_roots':[],'selected':[]}
        with patch.object(Path,'read_bytes',hooked(Path.read_bytes)),patch.object(Path,'read_text',hooked(Path.read_text)):
            return self.ns['collect'](self.WORKER.decode(),self.PYTHON.decode(),self.MARK,prior,proc=self.proc,
                                      run=lambda argv:{'returncode':0,'stdout':outputs[argv[0]],'stderr':''},read_asset=lambda _:b'w',host='gpubox')
    def test_baseline_binds_worker_tree_and_hashes_gpu_argv(self):
        self.host();s=self.collect()
        self.assertEqual(s['identity_errors'],[]);self.assertEqual([x['pid'] for x in s['selected']],[100,101])
        self.assertEqual({x['pid']:x['argv_sha256'] for x in s['gpu_identities']},
                         {p:hashlib.sha256((self.proc/str(p)/'cmdline').read_bytes()).hexdigest() for p in (100,200)})
    def test_gpu_process_exiting_after_the_listing_keeps_its_listed_identity(self):
        # The e4 crash: the owned worker's cmdline was re-read for its GPU hash after it exited.
        self.host();listed=hashlib.sha256((self.proc/'100'/'cmdline').read_bytes()).hexdigest()
        s=self.collect(vanish=[(100,'cmdline',2)])
        self.assertEqual([x['argv_sha256'] for x in s['gpu_identities'] if x['pid']==100],[listed])
        self.assertEqual(s['identity_errors'],[])
    def test_process_exiting_during_the_listing_is_skipped_not_an_identity_error(self):
        for pid,name in ((100,'cmdline'),(100,'status'),(100,'environ'),(101,'cmdline'),(101,'status'),(200,'cmdline')):
            with self.subTest(pid=pid,file=name):
                for d in [d for d in self.proc.iterdir() if d.name.isdigit()]:shutil.rmtree(d)
                self.host();s=self.collect(vanish=[(pid,name,1)])
                # Identity errors and unbound worker paths are what the guard turns into hardstops.
                self.assertEqual(s['identity_errors'],[]);self.assertEqual(s['worker_path_candidates'] if pid==100 else [],[])
                self.assertNotIn(pid,[x['pid'] for x in s['selected']+s['gpu_identities']])
    def test_live_process_with_unreadable_files_still_fails_closed(self):
        self.host();s=self.collect(deny=[(100,'environ')])
        self.assertIn({'pid':100,'error':'worker_marker_or_identity_unreadable'},s['identity_errors'])
        for d in [d for d in self.proc.iterdir() if d.name.isdigit()]:shutil.rmtree(d)
        self.host();s=self.collect(deny=[(101,'cmdline')])
        self.assertIn({'pid':101,'error':'owned_tree_identity_unreadable'},s['identity_errors'])
    def test_protected_finetune_check_skips_exited_but_not_changed_identities(self):
        ns={'__name__':'remote'};exec(evaluate.PROTECTED_GPU,ns);self.host()
        argv=(self.proc/'200'/'cmdline').read_bytes()
        argv=argv.replace(b'finetune\0',b'finetune\0--run_name\0uu_iter1\0');(self.proc/'200'/'cmdline').write_bytes(argv)
        row=lambda pid:{'pid':pid,'start_ticks':str(1000+pid),'argv_sha256':hashlib.sha256((self.proc/str(pid)/'cmdline').read_bytes()).hexdigest()}
        rows=[row(200),{**row(200),'pid':999}]
        self.assertEqual([x['pid'] for x in ns['protected'](rows,proc=self.proc)],[200])
        (self.proc/'200'/'cmdline').write_bytes(argv+b'x\0')  # same PID, different program: never permission
        with self.assertRaises(AssertionError):ns['protected'](rows,proc=self.proc)
        (self.proc/'200'/'cmdline').write_bytes(b'')  # exited, awaiting reap
        self.assertEqual(ns['protected'](rows,proc=self.proc),[])

class NativeReplayTests(unittest.TestCase):
    """Recorded seats are Metamon, which acts on mechanics-only gaps (e.g. its own Substitute). The exact native replay
    must pass the same actionability gate; otherwise every such game reads as a replay failure (e2 slot-0012-B0)."""
    GENERATOR=r'''import fs from 'node:fs/promises';import path from 'node:path';
const [project,out]=process.argv.slice(2);
process.env.LOCAL_INTEL_STORE_PATH=path.join(out,'FORBIDDEN-history.json');process.env.EXTERNAL_CURATED_STORE_PATH=path.join(out,'FORBIDDEN-curated.json');
const {runBattleMatch}=await import(project+'/apps/companion/src/battle-agent/simulator.ts');
const p1=`Serperior @ Leftovers
Ability: Contrary
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Substitute
- Leaf Storm`;
const p2=`Magikarp
Ability: Swift Swim
Level: 1
- Splash`;
let gated=0;
const seat={id:'metamon-like',requiresSupportedMechanics:false,async decide(input:any){
  const cap=input.envelope.semantic.capabilities;if(cap.actionable===false)gated++;
  const legal=input.envelope.semantic.snapshot.legalActions.filter((a:any)=>!a.disabled&&a.choice).sort((a:any,b:any)=>a.id.localeCompare(b.id));
  return {requestId:input.requestId,identity:input.envelope.semantic.identity,actionId:legal[0].id};}};
const result:any=await runBattleMatch({p1:seat,p2:seat,teams:{p1,p2},seed:[1,2,3,4],trace:true,fallback:'none',maxTurns:1000,maxDecisions:12012});
const {trajectory,replay,replayInputs,playerTraces,producerSources,ownedCheckpoints,...summary}=result;
const w=(n:string,d:unknown)=>fs.writeFile(path.join(out,n),typeof d==='string'?d:JSON.stringify(d,null,2)+'\n');
await w('trajectory.jsonl',trajectory.map((x:any)=>JSON.stringify(x)).join('\n')+'\n');await w('replay.log',replay);await w('replay-inputs.json',replayInputs);
for(const side of ['p1','p2'])await w(side+'-private.jsonl',playerTraces[side].map((x:any)=>JSON.stringify(x)).join('\n')+'\n');
await w('summary.json',summary);console.log(JSON.stringify({status:result.status,turn:result.turn,decisions:trajectory.length,gated,errors:result.errors}));
'''
    def test_replay_accepts_recorded_decisions_on_mechanics_only_gaps(self):
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            folder=Path(folder);game=folder/'game';game.mkdir();(folder/'gen.mts').write_text(self.GENERATOR)
            made=node(folder/'gen.mts',PROJECT,game,tmp=folder);self.assertEqual(made.returncode,0,made.stderr[-2000:])
            produced=json.loads(made.stdout.splitlines()[-1])
            # The fixture must exercise the gate: a completed game with recorded non-actionable decisions.
            self.assertEqual(produced['status'],'completed');self.assertGreater(produced['gated'],0)
            p=node(HERE_NATIVE,game,tmp=folder);self.assertEqual(p.returncode,0,p.stderr[-2000:])
            self.assertEqual(json.loads((game/'native-replay.json').read_text())['choices'],produced['decisions'])

class TrappedReplayTests(unittest.TestCase):
    def fixture(self):
        ch=lambda n:{'kind':'move','moveSlot':n,'terastallize':False}
        identity={'requestKind':'move','rqid':22,'stateRevision':1}
        rows=[{'identity':identity,'rqid':22,'choice':'switch 6','accepted':False},
              {'identity':{**identity,'stateRevision':2},'rqid':22,'choice':'move 2','accepted':True}]
        es=[{'event':'forward'},{'event':'proposal','step':1,'forwards':1,'choice':{'kind':'switch','switchSlot':6}},
            {'event':'proposal','step':1,'forwards':1,'choice':ch(2)},{'event':'commit','choice':ch(2)}]
        return es,rows
    def test_rejection_is_proposed_but_never_committed(self):
        es,rows=self.fixture();self.assertEqual(verify_recurrence(es,rows)['proposal'],2)
    def test_skip_rejection_extra_forward_or_wrong_commit_fails(self):
        for mode in ('skip','forward','commit','rqid'):
            es,rows=self.fixture()
            if mode=='skip':es.pop(1)
            if mode=='forward':es.insert(2,{'event':'forward'})
            if mode=='commit':es[-1]['choice']={'kind':'switch','switchSlot':6}
            if mode=='rqid':rows[-1]['rqid']+=1
            with self.subTest(mode=mode),self.assertRaises(AssertionError):verify_recurrence(es,rows)

class RerankPrepareTests(unittest.TestCase):
    def prepare(self, root, qualified_host=RUNTIME['host'], **kw):
        runtime=root/'runtime.json';runtime.write_text(json.dumps({**RUNTIME,'project':str(PROJECT),'remoteRoot':str(PROJECT)+'/tmp/x'}))
        qualified=root/'qualified-runtime.json';qualified.write_text(json.dumps({**RUNTIME,'host':qualified_host}))  # device-local
        a=types.SimpleNamespace(out=str(root/'cohort'),runtime=str(runtime),rerank=True,candidate=None,run=None,epoch=None,
                                sha256=None,qualification=True,admission_gib=60,swap_tolerance_mib=256,tau=None,demote=None)
        vars(a).update(kw)
        def freeze(out):  # The real freeze hashes all of node_modules; the seal only needs its three outputs.
            (out/'producer').mkdir()
            for name in ('producer-manifest.json','runtime-manifest.json'):(out/name).write_text('{}')
            zipfile.ZipFile(out/'producer.zip','x').close()
        with patch('evaluate.GUARD_PRIORS',write_priors(root)),patch('evaluate.QUALIFIED_RUNTIME',qualified),patch('evaluate.freeze',freeze),patch('builtins.print'):
            evaluate.prepare(a)
        return Path(a.out).resolve()
    def test_model_prepare_seals_explicit_seed_plan_and_rerank_rejects_it(self):
        # Matters: the seed plan binds model cohorts only, and the full cohort is the retired certification entry: it must
        # stop at the hold before any family is read or anything is written, while a qualification still seals the plan.
        plan={'schema':'uu-eval-seeds@1','namespace':'model-confirmatory-test',
              'vectors':[[101,103,107,109],[113,127,131,137],[139,149,151,157],[163,167,173,179]]}
        model=dict(rerank=False,candidate='/p/candidate.pt',run='student',epoch=3,sha256='a'*64)
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder);path=root/'seeds.json';path.write_text(json.dumps(plan))
            with self.assertRaisesRegex(AssertionError,'SEED_PLAN_MODEL_ONLY'):self.prepare(root,seed_plan=str(path))
            self.assertFalse((root/'cohort').exists())
            with patch('evaluate.build',side_effect=AssertionError('FAMILY_READ')),self.assertRaisesRegex(RuntimeError,'CERTIFICATION_CAMPAIGN_HOLD'):
                self.prepare(root,**model,qualification=False,seed_plan=str(path))
            self.assertFalse((root/'cohort').exists())
            out=self.prepare(root,**model,seed_plan=str(path))
            s=json.loads((out/'spec.json').read_text());seal=json.loads((out/'preregistration.json').read_text())
            self.assertEqual(s['seedPlan'],plan);self.assertTrue(s['qualification']);self.assertEqual(len(s['games']),8)
            self.assertEqual({x['seedFamily'] for x in s['slots']},{'model-confirmatory-test-seed1'})
            self.assertEqual(seal['specSha256'],sha(out/'spec.json'));validate(s,POOL)
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder);path=root/'seeds.json'
            for invalid in ({**plan,'vectors':[]},None):
                path.write_text(json.dumps(invalid))
                with self.subTest(plan=invalid),self.assertRaisesRegex(AssertionError,'SEED_PLAN'):
                    self.prepare(root,rerank=False,candidate='/p/candidate.pt',run='student',epoch=3,sha256='a'*64,seed_plan=str(path))
                self.assertFalse((root/'cohort').exists())
    def test_rerank_cohort_pins_base_weights_and_live_guard_priors(self):
        # Matters: B1 differs from B0 only by the re-ranker, so its "candidate" is the base checkpoint, and the set priors that drive its guards are frozen with the spec.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder);out=self.prepare(root);s=json.loads((out/'spec.json').read_text())
            self.assertEqual(s['candidate'],{'kind':'rerank','policyId':RERANK,'sha256':BASE_SHA,'path':RUNTIME['baseCheckpoint'],
                                             'rerankerVersion':'metamon-rerank@2','guardsVersion':'tactical-guards@6','rerankConfig':CONFIG})
            design=build(POOL,True);self.assertEqual(s['slots'],design['slots']);self.assertEqual(s['games'],design['games'])
            self.assertEqual(Path(s['guardPriors']['descriptor']),out/'guard-priors/priors.descriptor.json')
            for name in ('priors.descriptor.json','raw.json'):
                self.assertEqual((out/'guard-priors'/name).read_bytes(),(root/name).read_bytes())
                self.assertEqual(s['guardPriors']['sha256'][name],sha(root/name))
            self.assertEqual(json.loads((out/'preregistration.json').read_text())['specSha256'],sha(out/'spec.json'))
    def test_prepare_refuses_a_runtime_other_than_the_qualified_host(self):
        # Matters: cohort results are only comparable on the one qualified eval host; a runtime naming any other host must
        # stop before anything is registered.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder)
            with self.assertRaisesRegex(AssertionError,'QUALIFIED_RUNTIME_ONLY'):self.prepare(root,qualified_host='user@otherbox')
            self.assertFalse((root/'cohort').exists())
    def test_registered_versions_match_the_companion_that_will_run(self):
        # Matters: verify.py rejects a cohort whose trace rows carry another reranker or guards version than the spec
        # registered, so a guard change the cohort is not re-registered for would only fail after hours of eval-host games.
        import re,spec
        source=lambda rel,name:re.search(rf'export const {name} = "([^"]+)";',(PROJECT/rel).read_text()).group(1)
        self.assertEqual(spec.GUARDS_VERSION,source('apps/companion/src/battle-agent/tacticalGuards.ts','GUARDS_VERSION'))
        self.assertEqual(spec.RERANKER_VERSION,source('apps/companion/src/battle-agent/rerank.ts','RERANKER_VERSION'))
    def test_rerank_tau_and_audit_demotions_are_pinned_in_the_spec(self):
        # Matters: τ (set from the precision audit's false-positive rate) and the kinds the audit demoted to amber are B1's treatment; they must be fixed in the sealed spec, validated, and impossible to give a candidate cohort.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder);out=self.prepare(root,tau=0.07,demote='setup_dead_end,switch_into_ko')
            self.assertEqual(json.loads((out/'spec.json').read_text())['candidate']['rerankConfig'],{'tau':0.07,'demoted':['setup_dead_end','switch_into_ko']})
            for i,kw in enumerate(({'tau':0.},{'tau':1.},{'demote':'not_a_kind'},{'demote':'choice_lock'},{'rerank':False,'candidate':'/p/x.pt','run':'r','epoch':1,'sha256':'a'*64,'tau':0.1})):
                with self.subTest(kw=kw),self.assertRaises(AssertionError):self.prepare(root/str(i) if (root/str(i)).mkdir() is None else root,**kw)

    def test_rerank_and_candidate_arguments_cannot_mix(self):
        # Matters: a cohort is exactly one comparison; a stray --candidate (or a candidate cohort missing its SHA) would mean a different, unregistered B1.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder)
            for kw in ({'candidate':'/p/x.pt'},{'sha256':'a'*64},{'rerank':False}):
                with self.subTest(kw=kw):
                    with self.assertRaises(AssertionError):self.prepare(root,**kw)
                    self.assertFalse((root/'cohort').exists())
    def test_guard_prior_drift_stops_execution_and_verification_before_any_remote_call(self):
        # Matters: guards (hence B1's actions) are a function of the set priors; changed prior bytes would be an unregistered treatment.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            out=self.prepare(Path(folder));s=json.loads((out/'spec.json').read_text())
            evaluate.check_priors(out,s)
            raw=out/'guard-priors/raw.json';raw.write_bytes(raw.read_bytes()+b' ')
            with self.assertRaisesRegex(AssertionError,'GUARD_PRIOR_DRIFT'):evaluate.check_priors(out,s)
            with patch('evaluate.remote') as r,self.assertRaisesRegex(AssertionError,'GUARD_PRIOR_DRIFT'):evaluate.execute(out)
            r.assert_not_called()
            with patch('verify.remote') as r,self.assertRaisesRegex(AssertionError,'GUARD_PRIOR_DRIFT'):verify.verify(out)
            r.assert_not_called()

class RerankLaunchTests(unittest.TestCase):
    def tokens(self, launch):return shlex.split(' '.join(launch['args'][launch['args'].index('user@gpubox')+1:]))
    def test_b1_home_is_the_plain_production_worker_labelled_as_reranked(self):
        # Matters: both arms must share weights, worker, seeds and args; only the identity label (and game ID) may differ, or B1-B0 is not the re-ranker's effect.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            s=rerank_spec(Path(folder));g0,g1=s['games'][:2];home=g0['seat'];opp='p2' if home=='p1' else 'p1'
            b0,b1=[launches(s,g) for g in (g0,g1)];self.assertEqual((g0['arm'],g1['arm']),('B0','B1'))
            t0,t1=self.tokens(b0[home]),self.tokens(b1[home])
            self.assertEqual((b0[home]['policyId'],b1[home]['policyId']),(KAKUNA,RERANK))
            self.assertIn('UU_EVAL_POLICY='+RERANK,t1);self.assertIn('UU_EVAL_CHECKPOINT_SHA256='+BASE_SHA,t1)
            self.assertNotIn('--policy-id',t1);self.assertFalse(any('candidate_worker' in t for t in t1))
            self.assertTrue(any(t.endswith('/producer/scripts/metamon-worker.py') for t in t1))
            self.assertEqual(t1[t1.index('--checkpoint')+1],RUNTIME['baseCheckpoint'])
            norm=lambda ts:[t.replace(RERANK,KAKUNA).replace('-B0','-ARM').replace('-B1','-ARM') for t in ts]
            self.assertEqual(norm(t0),norm(t1))
            self.assertEqual(json.dumps(b0[opp]).replace('-B0','-ARM'),json.dumps(b1[opp]).replace('-B1','-ARM'))
    def test_both_arms_wrap_the_home_seat_but_only_b1_executes_the_rerank(self):
        # Matters: B0 must log the same guard features as a shadow with the same per-decision seed, so the arms differ only in what is executed.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            out=Path(folder);s=rerank_spec(out);g=s['games'][0]
            jobs={x['arm']:evaluate.job_for(out,s,x) for x in s['games'][:2]}
            for arm,mode in (('B0','shadow'),('B1','rerank')):
                self.assertEqual(jobs[arm]['rerank'],{'homeSide':g['seat'],'mode':mode,'seed':g['workerSeed'],
                                                      'priorsDescriptor':s['guardPriors']['descriptor'],'config':CONFIG})
                self.assertEqual(jobs[arm]['output'],str(out/jobs[arm]['gameID']))
            c=copy.deepcopy(s);c['candidate']={'path':'/p/x.pt','sha256':'a'*64,'policyId':'metamon:UUFinetuned:test:2'}
            self.assertNotIn('rerank',evaluate.job_for(out,c,s['games'][1]))
    def test_match_builds_seats_and_priors_from_the_job(self):
        # Matters: evaluate.py and match.ts must agree on the job contract, or B1 could run unwrapped (silently B0) or without the live set priors.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            out=Path(folder);s=rerank_spec(out);c=copy.deepcopy(s);g0,g1=s['games'][:2];home=g0['seat'];opp='p2' if home=='p1' else 'p1'
            c['candidate']={'path':'/p/x.pt','sha256':'a'*64,'policyId':'metamon:UUFinetuned:test:2'};seen={}
            for name,spec_,g in (('B0',s,g0),('B1',s,g1),('candidate',c,g1)):
                job=evaluate.job_for(out,spec_,g)
                for launch in job['launches'].values():launch['command']=shutil.which('false')  # never a real worker or host
                p=out/(name+'.json');p.write_text(json.dumps(job))
                r=node(PROJECT/'scripts/uu_eval/match.ts',p,'--dry',tmp=out);self.assertEqual(r.returncode,0,r.stderr[-2000:])
                seen[name]=json.loads(r.stdout)
            self.assertEqual(seen['B0'][home],{'id':KAKUNA,'reranked':True});self.assertEqual(seen['B1'][home],{'id':RERANK,'reranked':True})
            self.assertEqual(seen['candidate'][home],{'id':'metamon:UUFinetuned:test:2','reranked':False})
            for name in seen:self.assertEqual(seen[name][opp],{'id':KAKUNA,'reranked':False})
            self.assertTrue(seen['B0']['priorsRevision'].startswith('sha256:'));self.assertEqual(seen['B0']['priorsRevision'],seen['B1']['priorsRevision'])
            self.assertIsNone(seen['candidate']['priorsRevision'])

class DeployTests(unittest.TestCase):
    def producer(self, out):
        for name in ('scripts/metamon-worker.py','scripts/uu_eval/worker_trace.py','scripts/metamon_port/action_probs.py',
                     'scripts/uu_selfplay/candidate_worker.py','scripts/uu_selfplay/export_candidate.py'):
            p=out/'producer'/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(PROJECT/name,p)
    def test_deploy_ships_the_distribution_module_worker_trace_loads(self):
        # Matters: worker_trace.py loads metamon_port/action_probs.py by path; a remote producer without it kills every worker, and the re-ranker would get no p.
        self.assertIn("parents[1]/'metamon_port/action_probs.py'",(PROJECT/'scripts/uu_eval/worker_trace.py').read_text())
        for candidate in ({'kind':'rerank'},{'policyId':'metamon:UUFinetuned:test:2'}):
            with self.subTest(candidate=candidate),tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
                out=Path(folder);self.producer(out);root=out/'remote'
                with patch('evaluate.remote',local_remote):evaluate.deploy(out,{'runtime':{**RUNTIME,'remoteRoot':str(root)},'candidate':candidate})
                trace=root/'producer/scripts/uu_eval/worker_trace.py'
                self.assertEqual((trace.resolve().parents[1]/'metamon_port/action_probs.py').read_bytes(),
                                 (PROJECT/'scripts/metamon_port/action_probs.py').read_bytes())
    def test_rerank_proof_pins_deployed_scripts_without_an_export_receipt(self):
        # Matters: the re-rank arm has no exported checkpoint, but its base weights and every deployed script must still be hash-pinned; candidates keep the receipt gate.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            out=Path(folder);self.producer(out);base=out/'base.pt';base.write_bytes(b'weights')
            rt={**RUNTIME,'remoteRoot':str(out/'remote'),'baseCheckpoint':str(base)}
            c={'runtime':rt,'candidate':{'path':str(base),'sha256':sha(base),'epoch':2,'policyId':'metamon:UUFinetuned:test:2'}}
            s={'runtime':rt,'candidate':{'kind':'rerank','policyId':RERANK,'sha256':sha(base),'path':str(base)}}
            with patch('evaluate.remote',local_remote),patch('evaluate.BASE_SHA',sha(base)):
                evaluate.deploy(out,c)
                # The deployed worker must be the pinned qualified one; the pin is set here, not read off the checkout.
                with patch('evaluate.WORKER_SHA','f'*64),self.assertRaises(AssertionError):evaluate.checkpoint_proof(out,s)
                with patch('evaluate.WORKER_SHA',sha(out/'producer/scripts/metamon-worker.py')):
                    with self.assertRaisesRegex(RuntimeError,'receipt'):evaluate.checkpoint_proof(out,c)
                    proof=evaluate.checkpoint_proof(out,s)
            self.assertIsNone(proof['exportReceipt'])
            self.assertEqual(set(proof['pins']),{'base','scripts/metamon-worker.py','scripts/uu_eval/worker_trace.py','scripts/metamon_port/action_probs.py'})

class RerankRecurrenceTests(unittest.TestCase):
    ch=staticmethod(lambda n:{'kind':'move','moveSlot':n,'terastallize':False})
    def test_worker_proposes_raw_and_commits_executed(self):
        # Matters: under re-ranking the worker samples Metamon's raw pick but the game executes p''s pick; a join to the wrong side hides a desynced recurrence.
        identity={'requestKind':'move','rqid':3,'stateRevision':1}
        rows=[{'identity':identity,'rqid':3,'choice':'move 2','accepted':True}]
        es=[{'event':'forward'},{'event':'proposal','step':1,'forwards':1,'choice':self.ch(1)},{'event':'commit','choice':self.ch(2)}]
        self.assertEqual(verify_recurrence(es,rows,['move 1'])['commit'],1)
        with self.assertRaises(AssertionError):verify_recurrence(es,rows)
        bad=copy.deepcopy(es);bad[-1]['choice']=self.ch(1)
        with self.assertRaises(AssertionError):verify_recurrence(bad,rows,['move 1'])
    def test_reranked_trapped_switch_is_staged_not_reforwarded(self):
        # Matters: a re-ranked switch into a hidden trap is staged with the worker; the re-choice must reuse the same forward and never advance the recurrence.
        identity={'requestKind':'move','rqid':22,'stateRevision':1}
        rows=[{'identity':identity,'rqid':22,'choice':'switch 6','accepted':False},
              {'identity':{**identity,'stateRevision':2},'rqid':22,'choice':'move 2','accepted':True}]
        raw=['move 1','move 2']
        es=[{'event':'forward'},{'event':'proposal','step':1,'forwards':1,'choice':self.ch(1)},
            {'event':'proposal','step':1,'forwards':1,'choice':self.ch(2)},{'event':'commit','choice':self.ch(2)}]
        self.assertEqual(verify_recurrence(es,rows,raw)['proposal'],2)
        for mode in ('forward','executed-join','rqid','commit'):
            e,r,p=copy.deepcopy(es),copy.deepcopy(rows),list(raw)
            if mode=='forward':e.insert(2,{'event':'forward'})
            if mode=='executed-join':p=None
            if mode=='rqid':r[1]['rqid']+=1
            if mode=='commit':e[-1]['choice']=self.ch(1)
            with self.subTest(mode=mode),self.assertRaises(AssertionError):verify_recurrence(e,r,p)

# Writes one home game (preview, a red delayed-attack guard on move 1, an unguarded turn) using the companion's own helpers.
TRACE_FIXTURE = r'''
import fs from 'node:fs/promises'; import path from 'node:path';
const [dir, descriptor] = process.argv.slice(2), repo = process.cwd();
const {rerankDecision, rerankSeedKey} = await import(repo + '/apps/companion/src/battle-agent/rerank.ts');
const {loadMetaMovePriorDescriptor} = await import(repo + '/apps/companion/src/history/metaPriorStore.ts');
const {hashCanonical} = await import(repo + '/apps/extension/lib/decision-identity.js');
const seed = 777, side = 'p1', roomId = 'battle-gen9uu-offline', config = {tau: 0.2, demoted: []};
const moves = [{id: 'move:1|tera=0', kind: 'move', moveName: 'Future Sight', choice: 'move 1', moveSlot: 1},
               {id: 'move:2|tera=0', kind: 'move', moveName: 'Psychic', choice: 'move 2', moveSlot: 2}];
const sides = {yourSide: {slot: side, active: {species: 'Slowking', hpPercent: 100}, team: []}, opponentSide: {active: {species: 'Garchomp', hpPercent: 100}, team: []}};
const cases: any[] = [
  {kind: 'team_preview', phase: 'preview', actions: [{id: 'team:123456', kind: 'team', choice: 'team 123456'}], intel: {}, raw: undefined, pick: 'team:123456'},
  {kind: 'move', phase: 'turn', actions: moves, intel: {playerDamagePreview: [{actionId: 'move:1|tera=0', moveName: 'Future Sight', delayed: {scheduling: 'occupied', targetSide: 'p2'}}]},
   raw: {'move:1|tera=0': 0.6, 'move:2|tera=0': 0.4}, pick: 'move:1|tera=0'},
  {kind: 'move', phase: 'turn', actions: moves, intel: {}, raw: {'move:1|tera=0': 0.3, 'move:2|tera=0': 0.7}, pick: 'move:2|tera=0'}];
const trajectory: any[] = [], trace: any[] = [], envelopes: any[] = [];
for (const [i, c] of cases.entries()) {
  const identity = {roomId, rqid: i + 1, stateRevision: i + 1, requestKind: c.kind}, requestId = `${side}-${i + 1}-attempt-${2 * i + 1}`;
  const semantic = {capabilities: {status: 'supported'}, identity, localIntel: c.intel,
    snapshot: {phase: c.phase, turn: i, rawRequestSummary: null, ...sides, field: {pseudoWeather: []}, legalActions: c.actions}};
  const envelope = {semantic, resultHash: await hashCanonical(semantic)};
  const record = rerankDecision(envelope, c.raw, c.pick, rerankSeedKey(seed, side, identity), config), executedActionId = record.rerankActionId ?? c.pick;
  trajectory.push({side, requestId, identity, inputResultHash: envelope.resultHash, actionId: executedActionId,
    choice: c.actions.find((a: any) => a.id === executedActionId).choice, accepted: true});
  trajectory.push({side: 'p2', requestId: `p2-${i + 1}-attempt-${2 * i + 2}`, identity: {...identity, rqid: 9}, actionId: 'move:3|tera=0', choice: 'move 3', accepted: true});
  trace.push({...record, requestId, identity, mode: 'rerank', executedActionId});
  envelopes.push({side, requestId, executed: true, actionId: executedActionId, envelope});
}
const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';
await fs.writeFile(path.join(dir, 'trajectory.jsonl'), jsonl(trajectory));
await fs.writeFile(path.join(dir, 'rerank-trace.jsonl'), jsonl(trace));
await fs.writeFile(path.join(dir, 'reconstructed-envelopes.jsonl'), jsonl(envelopes));
await fs.writeFile(path.join(dir, 'replay-inputs.json'), JSON.stringify({format: 'gen9uu', movePriors: await loadMetaMovePriorDescriptor(descriptor, repo)}));
await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({rerank: {homeSide: side, mode: 'rerank', seed, priorsDescriptor: descriptor, config}}));
'''

class RerankTraceVerifierTests(unittest.TestCase):
    def test_every_executed_action_recomputes_from_envelope_distribution_and_seed(self):
        # Matters: B1's only treatment is metamon-rerank@2 (zero / τ-cap over guard flags) with a coupled draw; every executed action must be reproducible from the verified envelope, Metamon's logged p, the job seed and the pinned τ.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder);gen=root/'fixture.mts';gen.write_text(TRACE_FIXTURE);game=root/'game';game.mkdir()
            r=node(gen,game,write_priors(root),tmp=root);self.assertEqual(r.returncode,0,r.stderr[-2000:])
            trace=jl(game/'rerank-trace.jsonl');self.assertNotEqual(trace[1]['rerankActionId'],trace[1]['rawActionId'])  # the fixture really re-ranks
            home=[x for x in jl(game/'trajectory.jsonl') if x['side']=='p1']
            self.assertEqual(verify.raw_choices(game,'p1',home),['team 123456','move 1','move 2'])
            pristine={p.name:p.read_text() for p in game.iterdir()}
            run=lambda:node(PROJECT/'scripts/uu_eval/verify_rerank.ts',game,tmp=root)
            r=run();self.assertEqual(r.returncode,0,r.stderr[-2000:]);self.assertEqual(json.loads(r.stdout)['changed'],1)
            def rows_edit(name,fn):
                xs=jl(game/name);fn(xs);wjl(game/name,xs)
            def json_edit(name,fn):
                x=json.loads((game/name).read_text());fn(x);(game/name).write_text(json.dumps(x))
            def executed_raw(xs):xs[1]['executedActionId']=xs[1]['rawActionId']
            def trajectory_raw(xs):
                row=[x for x in xs if x['side']=='p1'][1];row.update(actionId='move:1|tera=0',choice='move 1')
            def shadow(xs):
                for x in xs:x['mode']='shadow'
            def no_distribution(xs):xs[2].update(rawProbabilities=None,rerankedProbabilities=None,rerankActionId=None)
            mutations={
                'B1 executed the raw pick':lambda:(rows_edit('rerank-trace.jsonl',executed_raw),rows_edit('trajectory.jsonl',trajectory_raw)),
                'trajectory differs from the trace':lambda:rows_edit('trajectory.jsonl',trajectory_raw),
                'flags not from the envelope':lambda:rows_edit('rerank-trace.jsonl',lambda xs:xs[1].update(flagged={})),
                'τ not the pinned one':lambda:json_edit('job.json',lambda x:x['rerank']['config'].update(tau=0.5)),
                'seed not from the job':lambda:json_edit('job.json',lambda x:x['rerank'].update(seed=778)),
                'shadow executed the re-ranked pick':lambda:(json_edit('job.json',lambda x:x['rerank'].update(mode='shadow')),rows_edit('rerank-trace.jsonl',shadow)),
                'missing distribution':lambda:rows_edit('rerank-trace.jsonl',no_distribution),
                'unpinned priors':lambda:json_edit('replay-inputs.json',lambda x:x.pop('movePriors')),
                'envelope not the verified one':lambda:rows_edit('reconstructed-envelopes.jsonl',lambda xs:xs[1]['envelope']['semantic'].update(localIntel={})),
            }
            for name,mutate in mutations.items():
                for p,text in pristine.items():(game/p).write_text(text)
                mutate()
                with self.subTest(mutation=name):self.assertNotEqual(run().returncode,0)

def write_game(d, seat, turns, home_hp, opp_hp, winner):
    """A completed game whose private requests give every Pokemon of a side the same HP at each turn start."""
    d.mkdir()
    (d/'summary.json').write_text(json.dumps({'status':'completed','turn':turns,'winner':winner,'errors':[],'fallbacks':[],'stopReason':None,
                                              'players':{s:{'switches':0,'tera':0} for s in ('p1','p2')}}))
    for name in ('trajectory.jsonl','replay-inputs.json'):(d/name).write_text('' if name.endswith('l') else '{}')
    for side in ('p1','p2'):
        hp=home_hp if side==seat else opp_hp
        frames=['|turn|%d\n|request|%s'%(t,json.dumps({'side':{'id':side,'pokemon':[{'ident':f'{side}: Mon{n}','condition':f'{hp(t)}/100'} for n in range(6)]},'active':[{}]}))
                for t in range(1,turns+1)]
        (d/(side+'-private.jsonl')).write_text(''.join(json.dumps(f)+'\n' for f in frames))

class LaterWindowTests(unittest.TestCase):
    def test_later_auc_weights_m20_and_carries_true_terminals(self):
        # Matters: the pre-registered later-window secondary must use M15/M20/M25 with AUC5-15's terminal carry, or long and short games score inconsistently.
        spec=build(POOL,True);spec['candidate']={'policyId':'metamon:UUFinetuned:test:0'}
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder);(root/'spec.json').write_text(json.dumps(spec));b0,b1=spec['games'][:2]
            write_game(root/b0['gameID'],b0['seat'],30,lambda t:100-t,lambda t:100,None)  # M_t = -6(t+1)
            write_game(root/b1['gameID'],b1['seat'],18,lambda t:100-t,lambda t:100,None)  # ends at 18: M20=M25=-108
            r=analyze(root)
            self.assertEqual([r['arms']['B0'][m] for m in ('M15','M20','M25','AUC15-25','AUC5-15')],[-96,-126,-156,-126,-66])
            self.assertEqual([r['arms']['B1'][m] for m in ('M15','M20','M25','AUC15-25')],[-96,-108,-108,-105])
            self.assertEqual(r['paired']['AUC15-25']['mean'],21)
            carried={x['arm']:x['terminalCarried20'] for x in csv.DictReader((root/'material.csv').open())}
            self.assertEqual(carried,{'B0':'False','B1':'True'})

class AdoptionRuleTests(unittest.TestCase):
    def inference(self, mean, lower, upper, p=.01):
        return {'mean':mean,'ci95':None if lower is None else [lower,upper],'permutationP':p}
    def paired(self, lower=.01, p=.01, auc=(.5,-.1,1.), late=(.5,-.1,1.), mean=.05):
        return {'score':self.inference(mean,lower,.1,p),'AUC5-15':self.inference(*auc),'AUC15-25':self.inference(*late)}
    def divergence(self, ndiv=40, ok=True):
        return {'N_div':ndiv,'determinism':{'pass':ok}}
    def test_exact_sign_flip_permutation_matches_enumeration(self):
        # Matters: the primary's permutation p must be exact at 35 families (2^35 sign vectors), not Monte Carlo, and agree with brute force where enumerable.
        from fractions import Fraction
        rng=random.Random(5)
        for n in (1,4,9):
            values=[Fraction(rng.randint(-8,8),rng.choice((1,2,4,8))) for _ in range(n)]
            obs=abs(sum(values));brute=sum(abs(sum(v*s for v,s in zip(values,signs)))>=obs for signs in itertools.product((-1,1),repeat=n))/2**n
            self.assertEqual(analysis.exact_sign_flip_p(values),brute)
        self.assertEqual(analysis.exact_sign_flip_p([Fraction(1,2)]*6),2/64)
        self.assertEqual(analysis.exact_sign_flip_p([Fraction(1,8)]*35),2/2**35)
    def test_primary_needs_the_bootstrap_bound_and_the_exact_permutation(self):
        # Matters: the adopted primary is the paired terminal score with family-cluster bootstrap LB > 0 AND exact sign-flip permutation p < 0.05; either alone is not enough.
        for lower,p,expected in ((.01,.01,True),(.01,.2,False),(-.01,.01,False),(0.,.01,False)):
            with self.subTest(lower=lower,p=p):
                r=analysis.adoption(self.paired(lower=lower,p=p),self.divergence(),verified=True,qualification=False,notRun=0)
                self.assertIs(r['primary']['pass'],expected);self.assertEqual(r['primary']['permutationP'],p)
    def test_secondary_regresses_only_when_its_ci_is_entirely_below_zero(self):
        # Matters: a noisy negative point estimate is not a regression under the adopted rule; only a 95% CI wholly below 0 blocks adoption.
        r=analysis.adoption(self.paired(auc=(-.4,-.9,.2)),self.divergence(),verified=True,qualification=False,notRun=0)
        self.assertEqual(r['adoptionBlockers']['regressions'],[]);self.assertIs(r['adoptLiveDefault'],True);self.assertEqual(r['recommendation']['action'],'adopt')
        r=analysis.adoption(self.paired(late=(-.4,-.9,-.1)),self.divergence(),verified=True,qualification=False,notRun=0)
        self.assertEqual(r['adoptionBlockers']['regressions'],['AUC15-25']);self.assertIs(r['adoptLiveDefault'],False);self.assertEqual(r['recommendation']['action'],'stop')
    def test_extension_rule_is_an_explicit_recommendation(self):
        # Matters: the pre-agreed next step must be computed, not argued after the fact: extend (one more 560-game cohort, seeds 3-4, pooled 97.5% LB) only when the estimate is positive, the bound is not, and N_div >= 20.
        cases=(({'lower':-.01,'mean':.03},40,'extend'),({'lower':-.01,'mean':.03},19,'stop'),({'lower':-.05,'mean':-.01},40,'stop'),
               ({'lower':.01,'p':.2,'mean':.03},40,'extend'),({},40,'adopt'))
        for kw,ndiv,action in cases:
            with self.subTest(kw=kw,ndiv=ndiv):
                r=analysis.adoption(self.paired(**kw),self.divergence(ndiv),verified=True,qualification=False,notRun=0)
                self.assertEqual(r['recommendation']['action'],action)
        self.assertIn('97.5%',analysis.adoption(self.paired(lower=-.01,mean=.03),self.divergence(),verified=True,qualification=False,notRun=0)['recommendation']['reason'])
    def test_missing_or_nondeterministic_data_never_reads_as_a_decision(self):
        # Matters: an unverified, partial or nondeterministic cohort cannot adopt, extend or stop; it is undetermined (or invalid) until fixed.
        for kw,div in (({'verified':False},self.divergence()),({'qualification':True},self.divergence()),({'notRun':3},self.divergence()),({},self.divergence(ok=False))):
            args={'verified':True,'qualification':False,'notRun':0,**kw}
            with self.subTest(kw=kw,determinism=div['determinism']['pass']):
                r=analysis.adoption(self.paired(),div,**args)
                self.assertIsNone(r['adoptLiveDefault']);self.assertIn(r['recommendation']['action'],('undetermined','invalid'))
        self.assertEqual(analysis.adoption(self.paired(),self.divergence(ok=False),verified=True,qualification=False,notRun=0)['recommendation']['action'],'invalid')
    def test_rerank_analysis_reports_divergence_determinism_and_the_suite_as_regression_only(self):
        # Matters: B1 can differ from B0 only after an executed re-rank. N_div comes from B1's own trace, its conditional effect is reported with CI and exact p, pairs that never diverged must tie exactly, and the loss-turn suite is a regression report, never adoption evidence.
        with tempfile.TemporaryDirectory(dir=PROJECT/'tmp') as folder:
            root=Path(folder);spec=rerank_spec(root);(root/'spec.json').write_text(json.dumps(spec))
            red={'kind':'delayed_slot_occupied','severity':'red','actionIds':['move:1|tera=0'],'message':'x'}
            for i,slot in enumerate(spec['slots']):
                diverges=i<2
                for g in [x for x in spec['games'] if x['slotID']==slot['slotID']]:
                    b1=g['arm']=='B1';opp='p2' if g['seat']=='p1' else 'p1'
                    win=b1 and diverges and i==0
                    write_game(root/g['gameID'],g['seat'],20,lambda t:100,lambda t:100,g['seat'] if win else opp)
                    wjl(root/g['gameID']/'rerank-trace.jsonl',[
                        {'rawActionId':'move:1|tera=0','executedActionId':'move:2|tera=0' if (b1 and diverges) else 'move:1|tera=0','guards':[red],'flagged':{'move:1|tera=0':['delayed_slot_occupied']}},
                        {'rawActionId':'move:2|tera=0','executedActionId':'move:2|tera=0','guards':[],'flagged':{}}])
            suite=root/'tactical.json'
            suite.write_text(json.dumps({'schema':'tactical-suite@2','arms':{'B0':{'failureRate':.2,'n':50},'B1':{'failureRate':.9,'n':50}}}))
            r=analyze(root,tactical=suite)
            self.assertEqual(r['divergence']['N_div'],2);self.assertEqual(r['divergence']['N_flip'],1)
            self.assertEqual(r['divergence']['conditional']['pairs'],2);self.assertIn('permutationP',r['divergence']['conditional'])
            self.assertEqual(r['divergence']['determinism'],{'pairs':2,'violations':[],'pass':True})
            self.assertEqual(r['tacticalRegressionReport']['sha256'],sha(suite));self.assertNotIn('tacticalFailureRate',r['adoptionBlockers']['regressions'])
            self.assertEqual(r['arms']['B1']['inGameTactical']['rerankedAway'],2)
            self.assertIsNone(r['adoptLiveDefault']);self.assertEqual(r['recommendation']['action'],'undetermined')  # qualification, unverified
            for name in ('analysis.json','analysis-inputs.json','process.json','material.csv','paired.csv'):(root/name).unlink()
            # A pair with no executed re-rank but a different result breaks the experiment's premise.
            g=[x for x in spec['games'] if x['slotID']==spec['slots'][3]['slotID'] and x['arm']=='B1'][0]
            (root/g['gameID']/'summary.json').write_text((root/g['gameID']/'summary.json').read_text().replace('"winner": "p','"winner": "x').replace('"winner": "x1"','"winner": "'+g['seat']+'"').replace('"winner": "x2"','"winner": "'+g['seat']+'"'))
            r=analyze(root)
            self.assertEqual(r['divergence']['determinism']['violations'],[spec['slots'][3]['slotID']]);self.assertEqual(r['recommendation']['action'],'invalid')

if __name__=='__main__':unittest.main()
