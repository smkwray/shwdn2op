# Private extension of original-observer.py: read-only sampling; only own direct query children may be terminated.
import argparse,json,pathlib,shlex,subprocess,time
REMOTE=r'''
import csv,hashlib,io,json,os,socket,subprocess,time
from pathlib import Path

def cpu_window(current, prior):
 # Compact rows: PID, start ticks, utime+stime ticks, remote monotonic ns.
 def valid(x):
  if not isinstance(x,dict) or not isinstance(x.get('boot_id'),str) or not x['boot_id'] or type(x.get('hz')) is not int or not 0<x['hz']<2**31 or type(x.get('observed_ns')) is not int or not 0<x['observed_ns']<2**64:raise ValueError('cpu_metadata')
  rows=x.get('counters')
  if not isinstance(rows,list) or len(rows)>2048:raise ValueError('cpu_counter_limit')
  seen=set()
  for row in rows:
   if not isinstance(row,list) or len(row)!=4 or any(type(v)is not int or not 0<=v<2**64 for v in row) or not 0<row[0]<2**31 or row[0]in seen or row[3]<=0 or row[3]>x['observed_ns']:raise ValueError('cpu_counter_schema')
   seen.add(row[0])
  return {row[0]:row for row in rows}
 now=valid(current)
 if prior is None:return 'pending',[]
 old=valid(prior)
 if current['boot_id']!=prior['boot_id'] or current['hz']!=prior['hz']:raise ValueError('cpu_clock_identity')
 elapsed=current['observed_ns']-prior['observed_ns']
 if elapsed<=0:raise ValueError('cpu_time')
 high=[]
 for pid,row in now.items():
  before=old.get(pid)
  if before is None or before[1]!=row[1]:continue # Gone/reused identities establish no sustained claim.
  delta=row[2]-before[2];duration=row[3]-before[3]
  if delta<0 or duration<=0:raise ValueError('cpu_counter_regression')
  elapsed=min(elapsed,duration)
  pcpu=delta*100*10**9/(current['hz']*duration)
  if duration>=5*10**9 and pcpu>=80:high.append({'pid':pid,'start_ticks':str(row[1]),'pcpu':pcpu,'elapsed_ns':duration,'cpu_ticks_delta':delta})
 return ('hardstop' if high else 'clear' if elapsed>=5*10**9 else 'pending'),high

def collect(needle, interpreter, marker, prior, proc=Path('/proc'), run=None, read_asset=None, host=None):
 def identity(pid):
  try:
   raw=(proc/str(pid)/'stat').read_text();s=raw[raw.rfind(')')+2:].split()
   return {'pid':int(pid),'state':s[0],'ppid':int(s[1]),'start_ticks':s[19],'cpu_ticks':int(s[11])+int(s[12]),'cpu_monotonic_ns':time.monotonic_ns()}
  except (OSError,ValueError,IndexError):return None
 def same(a,b):return a and b and a['pid']==b['pid'] and a['start_ticks']==b['start_ticks']
 checks={};query_ids=[];query_processes=[]
 host=host or socket.gethostname().split('.')[0]  # the host's claim tools are <hostname>-ai and <hostname>-heavy
 commands=[('claims',[f'{host}-ai','status','--json']),('heavy',[f'{host}-heavy','status']),('gpu',['nvidia-smi','--query-compute-apps=pid,process_name,used_gpu_memory','--format=csv,noheader,nounits']),('cpu',['ps','-eo','pid=,ppid=,comm=,pcpu=,rss=,etimes=,stat=','--sort=-pcpu'])]
 def actual(argv):
  p=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  ident=identity(p.pid)
  if ident:query_ids.append(ident)
  record={'spawned_pid':p.pid,'spawned_identity':ident};query_processes.append(record)
  try:
   try:out,err=p.communicate(timeout=1)
   except subprocess.TimeoutExpired:
    p.kill()
    try:out,err=p.communicate(timeout=1)
    except subprocess.TimeoutExpired:
     return {'returncode':p.poll(),'error':'query_cleanup_unresolved','stdout':'','stderr':''}
    return {'returncode':p.returncode,'error':'query_timeout','stdout':out[:131072],'stderr':err[:16384],'spawned_identity':ident,'spawned_pid':p.pid,'owned_child_reaped':p.returncode is not None}
   return {'returncode':p.returncode,'stdout':out[:131072],'stderr':err[:16384],'truncated':len(out)>131072 or len(err)>16384,'spawned_identity':ident,'spawned_pid':p.pid,'owned_child_reaped':True}
  finally:record.update({'returncode':p.poll(),'owned_child_reaped':p.returncode is not None})
 for name,argv in commands:
  try:
   checks[name]={'argv':argv,**(run(argv) if run else actual(argv))}
   if checks[name].get('spawned_identity'):query_ids.append(checks[name]['spawned_identity'])
   if run:query_processes.append({k:v for k,v in checks[name].items() if k in ('spawned_identity','spawned_pid','owned_child_reaped','error')})
  except Exception as e:checks[name]={'argv':argv,'error':type(e).__name__}
 boot=(proc/'sys/kernel/random/boot_id').read_text().strip()
 allowed=prior.get('cohort_game_ids',[])
 if not isinstance(allowed,list) or len(allowed)>10 or len(set(allowed))!=len(allowed) or any(not isinstance(x,str) or not x or len(x)>120 for x in allowed):raise ValueError('cohort_game_ids')
 entries={};argv_hashes={};marked=[];path_candidates=[];identity_errors=[];unreadable=[];owners={};roots={}
 bound=prior.get('bound_roots',[])
 limits=prior.get('root_limits',{g:1 for g in allowed})
 if set(limits)!=set(allowed) or any(type(v)is not int or not 1<=v<=2 for v in limits.values()) or sum(limits.values())>10:raise ValueError('root_limits')
 for d in proc.iterdir():
  if not d.name.isdigit():continue
  x=identity(int(d.name))
  if not x:continue
  try:
   raw=(d/'cmdline').read_bytes();argv=raw.split(b'\0')
   rss=next((line.split()[1] for line in (d/'status').read_text().splitlines() if line.startswith('VmRSS:')),None)
   x['rss_available']=rss is not None;x['rss_bytes']=int(rss or '0')*1024
   x['worker']=needle.encode() in argv and argv[0]==interpreter.encode()
   if x['worker']:
    # Return only the dedicated nonsecret cohort/game identifiers, never environment data.
    environment=(d/'environ').read_bytes().split(b'\0')
    path_candidates.append(x.copy())
    match=(b'SHWDN2OP_MATCH_RUN_ID='+marker.encode()) in environment
    game_values=[v.split(b'=',1)[1].decode('ascii') for v in environment if v.startswith(b'SHWDN2OP_GAME_RUN_ID=')]
    game=game_values[0] if len(game_values)==1 else None
    if match and game in allowed:
     x['game_id']=game
     earlier=[b for b in bound if b['game_id']==game]
     if len([b for b in roots.values() if b['game_id']==game])>=limits[game]:identity_errors.append({'pid':x['pid'],'error':'duplicate_game_root'})
     if earlier and (prior.get('boot_id')!=boot or (not any(same(x,b) for b in earlier) and len(earlier)>=limits[game])):identity_errors.append({'pid':x['pid'],'error':'game_root_replaced'})
     roots[x['pid']]=x;marked.append(x['pid']);owners[x['pid']]=game
    else:identity_errors.append({'pid':x['pid'],'error':'undeclared_worker_root'})
   entries[x['pid']]=x;argv_hashes[x['pid']]=hashlib.sha256(raw).hexdigest()
  except (OSError,ValueError,IndexError):
   # Exited between listing and reading: like a PID gone before its stat, it has nothing left to bind or check.
   if not same(identity(x['pid']),x):continue
   unreadable.append(x.copy())
   if x.get('worker'):identity_errors.append({'pid':x['pid'],'error':'worker_marker_or_identity_unreadable'})
   continue
 # Persist only exact previously owned identities, never recycled PIDs.
 if prior.get('boot_id')==boot:
  for old in prior.get('selected',[]):
   x=entries.get(old['pid']);game=old.get('owner_game_id')
   if same(x,old) and game in allowed:
    if x['pid'] in owners and owners[x['pid']]!=game:identity_errors.append({'pid':x['pid'],'error':'owner_binding_changed'})
    owners[x['pid']]=game
 while True:
  more={pid:owners[x['ppid']] for pid,x in entries.items() if x['ppid'] in owners and pid not in owners}
  if not more:break
  owners.update(more)
 own=set(owners)
 for x in unreadable:
  if x['ppid'] in own or (prior.get('boot_id')==boot and any(same(x,y) for y in prior.get('selected',[]))):identity_errors.append({'pid':x['pid'],'error':'owned_tree_identity_unreadable'})
 for pid in own:
  x=entries[pid]
  if not x['rss_available'] and x['state']=='Z' and prior.get('boot_id')==boot and any(same(x,b) and owners[pid]==b.get('owner_game_id') for b in prior.get('selected',[])):
   x['rss_available']=True;x['rss_bytes']=0;x['zombie_rss_released']=True
  if not x['rss_available'] or x['rss_bytes']<0:identity_errors.append({'pid':pid,'error':'owned_rss_unavailable'})
 observer=identity(os.getpid());sampling=[x for x in [observer,*query_ids] if x]
 high=[];ignored=[];lifetime_high=[];counters=[];cpu_state='error'
 for line in checks.get('cpu',{}).get('stdout','').splitlines():
  try:
   fields=line.split();pid=int(fields[0]);pcpu=float(fields[-4])
   current=entries.get(pid)
   reason='owned_tree' if pid in own else 'sampling_process' if any(same(current,x) for x in sampling) else 'exited_before_identity_snapshot' if current is None and not (proc/str(pid)).exists() else None
   row={'pid':pid,'pcpu':pcpu,'identity':current}
   if reason:
    if pcpu>=80:ignored.append({**row,'reason':reason})
   elif current is None:checks['cpu']['error']='cpu_counter_identity_unavailable'
   else:
    counters.append([pid,int(current['start_ticks']),current['cpu_ticks'],current['cpu_monotonic_ns']])
    if pcpu>=80:lifetime_high.append(row)
  except (ValueError,IndexError):checks['cpu']['error']='cpu_parse'
 measurement={'boot_id':boot,'hz':os.sysconf('SC_CLK_TCK'),'observed_ns':time.monotonic_ns(),'counters':counters}
 coverage={'status':'unknown','counts':None,'note':'Counter evidence unavailable; no coverage estimate.'}
 try:
  cpu_state,high=cpu_window(measurement,prior.get('cpu_prior'))
  for row in (prior.get('cpu_prior') or {}).get('counters',[]):
   x=entries.get(row[0])
   if x and int(x['start_ticks'])==row[1] and row[0]not in own and not any(same(x,y) for y in sampling) and not any(y[0]==row[0] for y in counters):raise ValueError('cpu_counter_missing_live_identity')
  if checks['cpu'].get('error'):raise ValueError(checks['cpu']['error'])
  previous=prior.get('cpu_prior');old={r[0]:r[1] for r in previous['counters']} if previous is not None else {};current={r[0]:r[1] for r in counters}
  counts={key:0 for key in ('no_baseline','not_in_prior','pid_reused','no_longer_present','matching_persistent')}
  for pid,start in current.items():
   cause='no_baseline' if previous is None else 'not_in_prior' if pid not in old else 'pid_reused' if start!=old[pid] else 'matching_persistent'
   counts[cause]+=1
  counts['no_longer_present']=len(old.keys()-current.keys())
  coverage={'status':'validated','counts':counts,'note':'Unmatched identities have no sustained CPU estimate, not CPU zero. Not in prior does not prove birth; no longer present means absent from eligible counters. Matching alone does not qualify a 5-second window; pending stays unresolved.'}
 except (ValueError,TypeError,KeyError) as e:checks['cpu']['error']=str(e)
 cpu_details={'cpu_state':cpu_state,'cpu_measurement':measurement,'cpu_ps_rows':len(checks.get('cpu',{}).get('stdout','').splitlines()),'cpu_counter_count':len(counters),'cpu_counter_limit':2048,'cpu_counter_headroom':2048-len(counters),'foreign_high_cpu_basis':'matching_identity_cpu_time_delta_at_least_5s','foreign_lifetime_high_cpu':lifetime_high}
 cpu_details['cpu_coverage']=coverage
 gpu=[];gpu_memory={}
 try:
  for row in csv.reader(io.StringIO(checks.get('gpu',{}).get('stdout',''))):
   if row:
    pid=int(row[0].strip());gpu.append(pid)
    gpu_memory[str(pid)]=int(row[2].strip()) if len(row)>2 and row[2].strip().isdigit() else None
 except (ValueError,IndexError):checks['gpu']['error']='gpu_parse'
 available=int(next(x.split()[1] for x in (proc/'meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))*1024
 return {**cpu_details,'worker_sha256':hashlib.sha256(read_asset(needle) if read_asset else Path(needle).read_bytes()).hexdigest(),'sample_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'boot_id':boot,'selected':[{**entries[p],'owner_game_id':owners[p]} for p in sorted(own)],'worker_roots':list(roots.values()),'game_tree_rss_bytes':{game:sum(entries[p]['rss_bytes'] for p in own if owners[p]==game) for game in allowed},'marked_worker_count':len(marked),'identity_errors':identity_errors,'worker_path_candidates':path_candidates,'sampling_identities':sampling,'query_processes':query_processes,'foreign_high_cpu':high,'ignored_high_cpu':ignored,'gpu_identities':[{**entries[p], 'argv_sha256':argv_hashes[p]} for p in gpu if p in entries], 'swap_free_bytes':int(next(x.split()[1] for x in (proc/'meminfo').read_text().splitlines() if x.startswith('SwapFree:')))*1024, 'gpu_pids':gpu,'gpu_memory_mib':gpu_memory,'foreign_gpu_pids':[p for p in gpu if p not in own],'available_bytes':available,'load1':float((proc/'loadavg').read_text().split()[0]),'own_tree_rss_bytes':sum(entries[p]['rss_bytes'] for p in own),'checks':checks}
if __name__=='__main__':
 import sys
 print(json.dumps(collect(*json.loads(sys.argv[1]))))
'''

def main():
 p=argparse.ArgumentParser();p.add_argument('host');p.add_argument('worker');p.add_argument('output');p.add_argument('--run-id',required=True);p.add_argument('--python',required=True);p.add_argument('--before')
 a=p.parse_args();prior=json.loads(pathlib.Path(a.before).read_text()) if a.before else {}
 remote='/usr/bin/python3 -c '+shlex.quote(REMOTE)+' '+shlex.quote(json.dumps([a.worker,a.python,a.run_id,prior]))
 if len(remote.encode())>120000:raise ValueError('cpu_prior_serialization_limit')
 start=time.monotonic()
 r=subprocess.run(['ssh','-T','-o','BatchMode=yes','-o','ProxyJump=none','-o','ConnectTimeout=2',a.host,remote],capture_output=True,text=True,timeout=4.5)
 receipt={'transport_returncode':r.returncode,'transport_seconds':round(time.monotonic()-start,6),'transport_stderr':r.stderr[:16384]}
 if r.returncode:receipt['transport_stdout']=r.stdout[:1048576]
 else:receipt['sample']=json.loads(r.stdout)
 if len(r.stdout)>1048576 or len(r.stderr)>16384:receipt['error']='transport_output_limit'
 out=pathlib.Path(a.output)
 with out.open('x') as stream:json.dump(receipt,stream,indent=2);stream.write('\n')
 out.chmod(0o600)
 print(json.dumps({'receipt':str(out),'transport_returncode':r.returncode}))
if __name__=='__main__':main()
