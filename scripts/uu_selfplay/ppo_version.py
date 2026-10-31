"""Collect one prospectively registered on-policy PPO version; no optimizer."""
import argparse,hashlib,json,pathlib,subprocess,sys,time
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--job',required=True,type=pathlib.Path);job_path=parser.parse_args().job
job=json.loads(job_path.read_bytes());sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
if (job['schema']!='uu-ppo-registered-version-data@1' or job['qualificationOnly'] is not False
        or job['optimizerAdmitted'] is not False):raise ValueError('Registered collection-only PPO version required')
for name,digest in job['inputHashes'].items():assert sha(name)==digest,name
stage=pathlib.Path(job['out']);stage.mkdir();report={'phase':'COLLECTING_REGISTERED_PPO_VERSION','qualificationOnly':False,'trainingEligible':False,'optimizerStarted':False,'jobSha256':sha(job_path),'startedUnix':time.time()}
def save():report['updatedUnix']=time.time();(stage/'report.json').write_text(json.dumps(report,indent=2)+'\n')
save()
try:
 runtime=pathlib.Path(job['runtime']);kit=runtime/'scripts/uu_selfplay'
 args=[sys.executable,str(kit/'ppo_collect.py'),'--plan',job['collectionPlan'],'--','--out',str(stage/'games'),'--checkpoint',job['baseline'],'--source',job['source'],'--panel',job['panel'],'--pool',job['pool'],'--policies',job['policies'],'--focal','PPO','--opponents','G0','R1','R2','PPO','--temperatures','1','--collection-slots',job['slots'],'--concurrency','2','--simulator-workers','1','--backend','torch-cuda-sdpa','--node-modules',job['nodeModules'],'--retain-all-traces','--analysis-mode','policy-only','--lead-checkpoint',job['lead'],'--lead-sha256',job['leadSha256']]
 args += ['--cleanup-deadline-ms',str(job['cleanupDeadlineMs']),'--match-timeout-ms',str(job['matchTimeoutMs'])]
 with (stage/'collect.log').open('x') as log:r=subprocess.run(args,cwd=job['projectRoot'],stdout=log,stderr=subprocess.STDOUT)
 if r.returncode:raise RuntimeError('Started PPO version collection failed; keep all exposed games, no retry')
 rate=json.loads((stage/'games/throughput.json').read_bytes());stats=json.loads((stage/'games/server/collector-stats.json').read_bytes());slots=json.loads(pathlib.Path(job['slots']).read_bytes())
 assert rate['startedGames']==rate['completed']==len(slots)==1000 and rate['failed']==rate['censored']==0 and rate['exitCodes']==[0]
 assert stats['completedPOVs']==2000 and stats['failedPOVs']==stats['active']==0
 actual=[json.loads(l) for l in (stage/'games/worker-0/games-started.jsonl').read_text().splitlines()];planned={s['id']:s for s in slots}
 assert len(actual)==1000 and {s['id'] for s in actual}==set(planned)
 for row in actual:
  slot=planned[row['id']];assert row['slot']==slot and row['families']==slot['families'] and row['policySeed']==slot['policySeed']
  assert all(row['actors'][side]['name']==slot['models'][side] for side in ['p1','p2'])
 report.update(phase='RAW_PPO_VERSION_COMPLETE',pass_=True,actualBattles=1000,actualNativePOVs=2000,plannedLearnerPOVs=1200,throughput=rate,replayStatus='PENDING_ALL1000_EXACT_REPLAYS_AND_ALLOWLIST',trainingEligible=False)
 report['pass']=report.pop('pass_')
except BaseException as error:report.update(phase='FAILED_RETAINED',pass_=False,error=repr(error));report['pass']=report.pop('pass_');raise
finally:save()
