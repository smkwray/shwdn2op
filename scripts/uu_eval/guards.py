# Adapted from retained R60 controller guard, unchanged thresholds.
import json,math
GPU_RELEASE_GRACE_SECONDS=30
GIB=2**30
def guard(receipt,admission=False,boot=None,worker_sha=None,max_roots=10,game_ids=(),root_limits=None,admission_gib=80):
 if receipt.get('transport_returncode')!=0 or receipt.get('error'):return 'OBSERVER_TRANSPORT'
 root_limits=root_limits if root_limits is not None else {g:1 for g in game_ids}
 s=receipt.get('sample',{})
 if not isinstance(s,dict):return 'SAMPLE_SCHEMA'
 if boot is not None and s.get('boot_id')!=boot:return 'BOOT_ID_CHANGED'
 if worker_sha is not None and s.get('worker_sha256')!=worker_sha:return 'WORKER_HASH_CHANGED'
 for name in ['claims','heavy','gpu','cpu']:
  q=s.get('checks',{}).get(name,{})
  if q.get('returncode')!=0 or q.get('error') or q.get('truncated'):return 'QUERY_FAILURE:'+name
 try:
  if json.loads(s['checks']['claims']['stdout'])!={'ok':True,'claims':[]}:return 'CLAIM_HARDSTOP'
  h=json.loads(s['checks']['heavy']['stdout'])
  if h.get('ok') is not True or h.get('current') is not None:return 'HEAVY_HARDSTOP'
  if not s.get('boot_id') or s['marked_worker_count']>max_roots or s.get('identity_errors'):return 'WORKER_IDENTITY_AMBIGUOUS'
  if any(not isinstance(s[k],(int,float)) or not math.isfinite(s[k]) or s[k]<0 for k in ('available_bytes','own_tree_rss_bytes','load1')):return 'SAMPLE_SCHEMA'
  if s['available_bytes']<(admission_gib if admission else 32)*GIB:return 'AVAILABLE_MEMORY_HARDSTOP'
  if s['own_tree_rss_bytes']>40*GIB:return 'OWN_RSS_HARDSTOP'
  roots=s['worker_roots'];selected=s['selected'];member=s['game_tree_rss_bytes']
  if not isinstance(roots,list) or not isinstance(selected,list) or not isinstance(member,dict):return 'COHORT_SCHEMA'
  if type(s['marked_worker_count'])is not int or len(roots)!=s['marked_worker_count'] or any(sum(x['game_id']==g for x in roots)>root_limits.get(g,0) for g in game_ids) or len({x['pid'] for x in roots})!=len(roots):return 'COHORT_ROOT_AMBIGUOUS'
  if any(x['game_id'] not in game_ids for x in roots):return 'UNDECLARED_GAME_ROOT'
  if any(x.get('owner_game_id') not in game_ids for x in selected):return 'UNDECLARED_OWNED_IDENTITY'
  if len({x['pid'] for x in selected})!=len(selected) or any(type(x['rss_bytes'])is not int or x['rss_bytes']<0 for x in selected):return 'OWNED_IDENTITY_SCHEMA'
  if any(not any(x['pid']==y['pid'] and x['start_ticks']==y['start_ticks'] and x['game_id']==y['owner_game_id'] for y in selected) for x in roots):return 'ROOT_TREE_BINDING'
  if any(sum(x['rss_bytes'] for x in selected if x['owner_game_id']==game)!=value for game,value in member.items()):return 'MEMBER_RSS_MISMATCH'
  if any(not any(x['pid']==y['pid'] and x['start_ticks']==y['start_ticks'] for y in roots) for x in s['worker_path_candidates']):return 'FOREIGN_WORKER_PATH'
  if set(member)!=set(game_ids) or any(type(v)is not int or v<0 for v in member.values()) or sum(member.values())!=s['own_tree_rss_bytes']:return 'COHORT_RSS_SCHEMA'
  if any(v>8*GIB for v in member.values()):return 'MEMBER_RSS_HARDSTOP'
  if admission and (roots or selected):return 'PREEXISTING_COHORT'
  if admission:
   if s['gpu_pids']:return 'GPU_NOT_IDLE'
   if s['worker_path_candidates']:return 'PREEXISTING_WORKER_PATH'
  elif s['foreign_gpu_pids']:return 'FOREIGN_GPU_HARDSTOP'
  # The CPU/load guard was removed: it did more harm than good. CPU and load are
  # telemetry only; daemons and other workloads no longer stop or delay a cohort.
 except (KeyError,TypeError,ValueError,AttributeError):return 'SAMPLE_SCHEMA'
 return None

def released_own_gpu(receipt,captures,exited,first_seen,now,grace=GPU_RELEASE_GRACE_SECONDS):
 # A worker's CUDA context can outlive its process by a sample: nvidia-smi still lists
 # the PID, with no resolvable name, after the exact owned process left the full ps table.
 # Exempt only that case and only briefly; every other foreign GPU PID stays a hardstop.
 try:
  s=receipt['sample'];foreign=s['foreign_gpu_pids']
  if not foreign:return None
  ps={int(line.split()[0]) for line in s['checks']['cpu']['stdout'].splitlines() if line.split()}
  names={}
  for line in s['checks']['gpu']['stdout'].splitlines():
   parts=[x.strip() for x in line.split(',')]
   if len(parts)==3 and parts[0].isdigit():names[int(parts[0])]=parts[1]
  live={x['pid'] for k in ('selected','worker_roots','worker_path_candidates') for x in s[k]}
  released=[]
  for pid in foreign:
   owners=[g for g,roots in captures.items() if any(r['pid']==pid for r in roots)]
   if len(owners)!=1 or owners[0] not in exited:return None
   if pid in ps or pid in live or names.get(pid)!='[No data]':return None
   first=first_seen.setdefault(pid,now)
   if now-first>grace:return None
   released.append({'pid':pid,'gameID':owners[0],'ageSeconds':now-first})
  probe=json.loads(json.dumps(receipt));probe['sample']['foreign_gpu_pids']=[];probe['releasedOwnGpuContexts']=released
  return probe
 except (KeyError,TypeError,ValueError,AttributeError,IndexError):return None
