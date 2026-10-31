# Reused R60 exact local identity capture and bounded cleanup.
import os,signal,subprocess,time,json
def process_rows():
    result=subprocess.run(['/bin/ps','-axo','pid=,ppid=,pgid=,lstart='],capture_output=True,text=True,check=True,timeout=3)
    rows={}
    for line in result.stdout.splitlines():
        fields=line.split()
        if len(fields)==8:
            rows[int(fields[0])]={'pid':int(fields[0]),'ppid':int(fields[1]),'pgid':int(fields[2]),'start':fields[3:]}
    return rows
def same_identity(a,b):return bool(b) and a['pid']==b['pid'] and a['start']==b['start'] and a['pgid']==b['pgid']
def owned_snapshot(proc,known):
    rows=process_rows()
    registry=O/'cli-processes.jsonl'
    if registry.exists():
        for line in registry.read_text().splitlines():
            try:r=json.loads(line)
            except json.JSONDecodeError:raise ValueError('CLI_REGISTRY_MALFORMED')
            if r.get('gameID')!=GAME_ID or r.get('cohortID')!=COHORT_ID:continue
            if same_identity(r,rows.get(r['pid'])):known[(r['pid'],tuple(r['start']))]=rows[r['pid']]
    alive={r['pid'] for r in known.values() if same_identity(r,rows.get(r['pid']))}
    changed=True
    while changed:
        changed=False
        for r in rows.values():
            if r['ppid'] in alive and r['pid'] not in alive:
                alive.add(r['pid']);known[(r['pid'],tuple(r['start']))]=r;changed=True
    return [rows[i] for i in alive]

def capture_owned(processes,known):
 global GAME_ID,process_rows
 real_rows=process_rows;rows=real_rows();answer={}
 try:
  process_rows=lambda:rows
  for game,proc in processes.items():
   GAME_ID=game;ledger=known.setdefault(game,{})
   if proc.poll() is None and proc.pid in rows:
    value=rows[proc.pid];ledger[(value['pid'],tuple(value['start']))]=value
   answer[game]=owned_snapshot(proc,ledger)
 finally:process_rows=real_rows
 return answer

def stop_all(processes,snapshot,rows=process_rows,clock=time.monotonic,sleep=time.sleep,kill=os.kill):
 actions=[]
 # Each still-unreaped Popen child reserves its PID. Broadcast before waiting.
 for game,proc in processes.items():
  if proc.poll() is None:
   try:proc.send_signal(signal.SIGINT);actions.append({'gameID':game,'pid':proc.pid,'signal':'SIGINT','kind':'reserved_Popen_child'})
   except ProcessLookupError:pass
 try:
  end=clock()+3
  while clock()<end:
   live=snapshot(processes)
   if all(p.poll()is not None for p in processes.values()) and not any(live.values()):break
   sleep(.1)
  for sig in (signal.SIGTERM,signal.SIGKILL):
   for game,targets in snapshot(processes).items():
    for target in targets:
     current=rows().get(target['pid'])
     if same_identity(target,current):
      try:kill(target['pid'],sig);actions.append({'gameID':game,'signal':sig.name,'identity':target})
      except ProcessLookupError:pass
   sleep(.2)
  for proc in processes.values():
   try:proc.wait(timeout=1)
   except subprocess.TimeoutExpired:pass
  survivors={g:v for g,v in snapshot(processes).items() if v}
  return {'actions':actions,'exitCodes':{g:p.poll()for g,p in processes.items()},'ownedSurvivors':survivors,'identityPrecision':'macOS_ps_lstart_second_resolution','upstreamCancellationAttested':False}
 except Exception as error:
  # Inventory failure cannot authorize an unbound PID or numeric process group.
  # Still-unreaped Popen children reserve their own PID; stop those only.
  for sig,wait in [(signal.SIGINT,3),(signal.SIGTERM,1),(signal.SIGKILL,1)]:
   for game,proc in processes.items():
    if proc.poll() is None:
     try:proc.send_signal(sig);actions.append({'gameID':game,'pid':proc.pid,'signal':sig.name,'kind':'reserved_child_inventory_fallback'})
     except ProcessLookupError:pass
   end=clock()+wait
   while any(p.poll()is None for p in processes.values()) and clock()<end:sleep(min(.05,max(0,end-clock())))
  return {'status':'UNVERIFIED_DETACHED_DESCENDANTS','actions':actions,'exitCodes':{g:p.poll()for g,p in processes.items()},'ownedSurvivors':{'UNVERIFIED_DETACHED_DESCENDANTS':[]},'error':type(error).__name__,'upstreamCancellationAttested':False}
