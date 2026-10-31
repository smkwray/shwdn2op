/** Round 2: native prefix-conditioned worlds, complete root reply coverage, paired leaves. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import Showdown from 'pokemon-showdown';
import {Worker,Session,seedTuple,sha,restoreBattle,legalChoices,familyAllowed,material} from './pilot.mjs';
import {publicHistory,revealedFacts,sampleTeam,replyPlan,aggregate,controlSpec,id,mean} from './belief.mjs';
const {Battle,Teams,TeamValidator,PRNG}=Showdown,SIDES=['p1','p2'];
const write=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
const sink=()=>({events:[],async rpc(op,x){if(op==='observe')this.events.push(['observe',x.data,x.rejectedSwitch??false]);else if(op==='commit')this.events.push(['commit',x.choice]);return op==='propose'?{choice:this.retryChoice}:{};}});
export function canonical(b,side,choice){
 const p=b[side],tokens=choice.split(' ');
 if(tokens[0]==='team')return {kind:'team',order:tokens[1].split('').map(n=>p.pokemon[Number(n)-1].species.name)};
 if(tokens[0]==='switch')return {kind:'switch',species:p.pokemon[Number(tokens[1])-1].species.name};
 return {kind:'move',move:p.activeRequest.active[0].moves[Number(tokens[1])-1].id,tera:tokens.includes('terastallize')};
}
export function mapChoice(b,side,c,own,rng){
 const p=b[side];
 if(c.kind==='team') {const order=own?c.order:[c.order[0],...p.pokemon.map(x=>x.species.name).filter(x=>x!==c.order[0])];return 'team '+order.map(n=>p.pokemon.findIndex(x=>x.species.name===n)+1).join('');}
 if(c.kind==='switch')return 'switch '+(p.pokemon.findIndex(x=>x.species.name===c.species)+1);
 if(!own&&c.unseen){const legal=legalChoices(p.activeRequest);return legal[Math.floor(rng()*legal.length)];}
 const slot=p.activeRequest.active[0].moves.findIndex(x=>x.id===c.move);if(slot<0)throw Error('revealed move missing from world');
 return `move ${slot+1}${c.tera?' terastallize':''}`;
}
export async function create(teams,seed,workers,format='gen9uu'){
 const queue=[],battle=new Battle({formatid:format,seed:seedTuple(seed),send:(type,data)=>queue.push({type,data})}),s=new Session(battle,workers,queue);
 for(let i=0;i<2;i++){await workers[SIDES[i]].rpc('observe',{data:'|init|battle'});s.traces[SIDES[i]].push('|init|battle');battle.setPlayer(SIDES[i],{name:'Offline '+SIDES[i],team:structuredClone(teams[i])});}
 battle.sendUpdates();await s.flush();return s;
}
function rootOf(s){return {text:JSON.stringify(s.battle.toJSON()),requests:structuredClone(s.requests),rqids:structuredClone(s.rqids),turn:s.battle.turn};}
export async function replayWorld(source,side,team,attempt){
 const workers=Object.fromEntries(SIDES.map(x=>[x,sink()])),teams=structuredClone(source.teams);teams[side==='p1'?1:0]=team;
 const rng=new PRNG(seedTuple(attempt+74001)),s=await create(teams,attempt+410003,workers,source.format??'gen9uu');
 try {
  for(const step of source.steps){assert.deepEqual(s.ready(),step.ready,'prefix request schedule');for(const seat of step.ready){const resolved=step.resolved?.[seat]??step.actions[seat];workers[seat].retryChoice=mapChoice(s.battle,seat,resolved,seat===side,()=>rng.random());await s.choose(seat,mapChoice(s.battle,seat,seat===side?step.actions[seat]:resolved,seat===side,()=>rng.random()));}}
  assert.equal(publicHistory(s.traces[side]),publicHistory(source.traces[side]),'public prefix mismatch');
  const requests=t=>t.join('\n').split('\n').filter(x=>x.startsWith('|request|'));
  assert.deepEqual(requests(s.traces[side]),requests(source.traces[side]),'known private request mismatch');
  assert.equal(s.battle.turn,source.turn);const root=rootOf(s);
  return {...root,events:Object.fromEntries(SIDES.map(x=>[x,workers[x].events])),team,attempt,publicSha256:sha(publicHistory(s.traces[side]))};
 }finally{s.battle.destroy();}
}
async function sourceGame(c,game,workers,limit,out){
 const teams=c.teams.slice(game*2,game*2+2).map(t=>{assert.equal(sha(fs.readFileSync(t.file)),t.sha256);assert.ok(familyAllowed(t.species,c.exclusions));const team=Teams.import(fs.readFileSync(t.file,'utf8'));assert.equal(new TeamValidator('gen9uu').validateTeam(team),null);return team.map(p=>({...p,name:p.species}));});
 for(const side of SIDES)await workers[side].rpc('new_game',{game,seed:c.seed+game});
 const s=await create(teams,c.seed+game,workers),steps=[],target=c.turns[game%c.turns.length];let error=null;
 try {
  while(!s.battle.ended){limit();const ready=s.ready();if(ready.length===2&&s.battle.turn>=target&&SIDES.every(x=>!s.requests[x].teamPreview&&!s.requests[x].forceSwitch?.some(Boolean)))break;
   if(s.battle.turn>target+3)throw Error('source root unavailable');if(!ready.length)throw Error('source stalled');
   const proposals={},actions={},resolved={},before=structuredClone(s.requests),start=Object.fromEntries(SIDES.map(x=>[x,s.traces[x].length]));
   for(const side of ready){proposals[side]=await s.propose(side);actions[side]=canonical(s.battle,side,proposals[side].choice);}
   for(const side of ready){const token=await s.choose(side,proposals[side].choice);resolved[side]=token===proposals[side].choice?structuredClone(actions[side]):{kind:'move',move:before[side].active[0].moves[Number(token.split(' ')[1])-1].id,tera:token.includes('terastallize')};}
   for(const side of ready)if(resolved[side].kind==='move'){
    const transcript=publicHistory(s.traces[side].slice(start[side]));
    if(!transcript.split('\n').some(line=>{const p=line.split('|');return p[1]==='move'&&p[2].startsWith(side)&&id(p[3])===resolved[side].move;}))resolved[side].unseen=true;
   }
   steps.push({ready,actions,resolved});
  }
  if(s.battle.ended)throw Error('source ended before root');
  return {game,teams,steps,turn:s.battle.turn,traces:s.traces,root:rootOf(s),families:c.teams.slice(game*2,game*2+2).map(x=>x.family)};
 }catch(e){error=e.message;throw e;}
 finally {write(path.join(out,`source-${game}.json`),{game,teams,steps,turn:s.battle.turn,traces:s.traces,root:rootOf(s),error});s.battle.destroy();}
}
async function rebuild(workers,world,game,seed){for(const side of SIDES)await workers[side].rpc('rebuild',{game,seed,events:world.events[side]});}
async function rollout(root,side,choice,reply,seed,workers,c,limit,terminal=false){
 const start=performance.now(),queue=[],battle=restoreBattle(root.text,(type,data)=>queue.push({type,data}));battle.prng=new PRNG(seedTuple(c.seed+90000+seed));
 const s=new Session(battle,workers,queue,structuredClone(root.requests),structuredClone(root.rqids));let decisions=0,short=null;
 try{
  for(const x of SIDES)await workers[x].rpc('restore',{seed:c.seed+90000+seed});
  for(const x of SIDES)await s.propose(x);
  for(const x of SIDES){await s.choose(x,x===side?choice:reply);decisions++;}
  const horizon=terminal?c.terminalTurns:c.longTurns,dispatchLimit=terminal?c.terminalDispatchCap:c.dispatchCap;
  while(!battle.ended&&(battle.turn<root.turn+horizon||SIDES.some(x=>s.requests[x]?.forceSwitch?.some(Boolean)))){
   limit();if(decisions>=dispatchLimit)throw Error('dispatch cap');
   if(short===null&&battle.turn>=root.turn+c.shortTurns&&!SIDES.some(x=>s.requests[x]?.forceSwitch?.some(Boolean)))short=material(battle,side).score;
   const ready=s.ready();if(!ready.length)throw Error('branch stalled');const p={};for(const x of ready)p[x]=await s.propose(x);for(const x of ready){if(decisions>=dispatchLimit)throw Error('dispatch cap');await s.choose(x,p[x].choice);decisions++;}
  }
  const leaf=material(battle,side);return {status:terminal&&!battle.ended?'censored':'ok',short:short??leaf.score,long:leaf.score,terminal:leaf.terminal,decisions,rejections:s.rejections,endTurn:battle.turn,elapsedMs:performance.now()-start,...(terminal&&!battle.ended?{reason:'terminal turn cap'}:{})};
 }catch(e){return {status:'failed',reason:e.message,elapsedMs:performance.now()-start};}finally{battle.destroy();}
}
async function evaluateWorld(s,world,w,workers,c,limit,append,terminalChoices=null){
 await rebuild(workers,world,s.game,c.seed+s.game);const props={};for(const x of SIDES){props[x]=await workers[x].rpc('propose');await workers[x].rpc('restore');}
 const own=props[s.side],opp=s.side==='p1'?'p2':'p1';
 assert.deepEqual(Object.keys(own.probabilities).sort(),[...s.legal].sort(),'own legal-world parity');
 if(s.probabilities)for(const x of s.legal)assert.ok(Math.abs(s.probabilities[x]-own.probabilities[x])<1e-6,'acting policy leaked hidden world');else{s.probabilities=own.probabilities;s.baseline=Object.keys(own.probabilities).sort((a,b)=>own.probabilities[b]-own.probabilities[a]||a.localeCompare(b))[0];}
 const legal=legalChoices(world.requests[opp]),rng=new PRNG(seedTuple(c.seed+21000+w));
 const plan=replyPlan(legal,props[opp].probabilities,[rng.random(),rng.random(),rng.random(),rng.random()]);
 if(!terminalChoices){
  s.replyPlans.push({world:w,plan});
  for(const choice of s.legal)for(let seed=0;seed<c.seeds;seed++)for(const reply of plan){limit();const r={world:w,seed,choice,reply:reply.choice,replyCount:plan.length,weight:reply.weight,...await rollout(world,s.side,choice,reply.choice,seed,workers,c,limit)};s.rows.push(r);append(r);}
  const first=s.rows.find(x=>x.world===w),again=await rollout(world,s.side,first.choice,first.reply,first.seed,workers,c,limit);
  assert.deepEqual(Object.fromEntries(Object.entries(again).filter(([k])=>k!=='elapsedMs')),Object.fromEntries(Object.entries(first).filter(([k])=>!['elapsedMs','world','seed','choice','reply','replyCount','weight'].includes(k))),'native/worker repeatability');
 }else{
  for(let seed=0;seed<c.seeds;seed++){
   const u=new PRNG(seedTuple(c.seed+53000+w*100+seed)).random();let n=u;const reply=(plan.find(x=>(n-=x.weight)<0)??plan.at(-1)).choice;
   for(const choice of terminalChoices){limit();const r={world:w,seed,choice,reply,...await rollout(world,s.side,choice,reply,seed,workers,c,limit,true)};s.terminalRows.push(r);append({...r,kind:'terminal'});}
  }
 }
}
function terminalSummary(s,c){
 const choices=[...new Set(s.terminalRows.map(x=>x.choice))],complete=choices.length>=2&&s.terminalRows.length===choices.length*c.worlds*c.seeds&&s.terminalRows.every(x=>x.status==='ok');
 if(!complete)return {complete:false,agree:false};
 const values=choices.map(choice=>({choice,value:mean(s.terminalRows.filter(x=>x.choice===choice).map(x=>x.long))})).sort((a,b)=>b.value-a.value||a.choice.localeCompare(b.choice));
 const top=values.filter(x=>Math.abs(x.value-values[0].value)<1e-9).map(x=>x.choice);
 return {complete:true,agree:top.includes(s.preferred),strict:top.length===1&&top[0]===s.preferred,values};
}
export async function controlWorld(i,c){
 const spec=controlSpec(i),fillers=Showdown.Dex.species.all().filter(x=>x.gen===1&&!x.forme&&!['Electrode','Azelf','Magikarp','Feebas','Blissey','Chansey','Latias','Mew'].includes(x.name)).sort((a,b)=>a.id.localeCompare(b.id)).slice(i*12,i*12+12);
 const teams=spec.teams.map((t,j)=>[...t,...fillers.slice(j*6,j*6+6-t.length).map(p=>({species:p.name,moves:['splash'],gender:p.gender||'M',ability:Object.values(p.abilities)[0]}))]),workers=Object.fromEntries(SIDES.map(x=>[x,sink()])),s=await create(teams,c.seed+80000+i,workers,'gen9customgame');
 for(const side of SIDES)await s.choose(side,'team '+s.battle[side].pokemon.map((_,j)=>j+1).join(''));
 for(const side of SIDES){for(const [j,p] of s.battle[side].pokemon.entries()){if(j>0&&!(spec.sacrifice&&side==='p1'&&j===1)){p.hp=0;p.fainted=true;}}s.battle[side].pokemonLeft=s.battle[side].pokemon.filter(p=>!p.fainted).length;const p=s.battle[side].active[0];p.hp=1;s.battle.add('-damage',p,p.getHealth);}
 if(!spec.sacrifice)s.battle.p2.active[0].setStatus('psn');
 s.battle.makeRequest('move');s.battle.sendUpdates();await s.flush();
 const world={...rootOf(s),events:Object.fromEntries(SIDES.map(x=>[x,workers[x].events]))};s.battle.destroy();return {spec,world};
}
export async function run(configPath){
 const text=fs.readFileSync(configPath,'utf8'),c=JSON.parse(text),reg=JSON.parse(fs.readFileSync(c.registration));assert.equal(sha(text),reg.configSha256);assert.equal(sha(fs.readFileSync(c.design)),reg.designSha256);
 const out=c.output;fs.mkdirSync(out);const start=performance.now(),workers=Object.fromEntries(SIDES.map(x=>[x,new Worker(c.worker,x,out)])),states=[],controls=[];let fatal=null,stop=false;
 process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});const limit=()=>{if(stop||performance.now()-start>c.wallSeconds*1000)throw Error('stopped/deadline');};
 const raw=fs.readFileSync(c.prior.file);assert.equal(sha(raw),c.prior.sha256);const prior=JSON.parse(raw);
 const append=(s,r)=>fs.appendFileSync(path.join(out,'branches.jsonl'),JSON.stringify({state:s.id,...r})+'\n');
 try{
  write(path.join(out,'runtime.json'),await Promise.all(SIDES.map(x=>workers[x].rpc('hello'))));
  for(let i=0;i<4;i++){
   limit();const {spec,world}=await controlWorld(i,c),s={id:'control'+i,game:c.games+i,side:'p1',legal:legalChoices(world.requests.p1),rows:[],replyPlans:[],terminalRows:[],spec};controls.push(s);
   await evaluateWorld(s,world,0,workers,{...c,worlds:1},limit,r=>append(s,r));Object.assign(s,aggregate(s.legal,s.baseline,s.rows,1,c.seeds));s.pass=s.complete&&s.actions.filter(x=>Math.abs(x.longWeighted-Math.max(...s.actions.map(a=>a.longWeighted)))<1e-9).some(x=>x.choice===spec.expected||x.choice===spec.expected+' terastallize');write(path.join(out,s.id+'.json'),s);console.log(JSON.stringify({control:s.id,preferred:s.preferred,pass:s.pass}));
  }
  for(let game=0;game<c.games;game++){
   limit();const t0=performance.now(),s={id:'g'+game,game,side:SIDES[game%2],rows:[],replyPlans:[],terminalRows:[],worldAttempts:0,worlds:[],worldFailures:{}};states.push(s);
   try{
    const source=await sourceGame(c,game,workers,limit,out);s.turn=source.turn;s.families=source.families;s.legal=legalChoices(source.root.requests[s.side]);
    await workers[s.side].rpc('save');const original=await workers[s.side].rpc('propose');await workers[s.side].rpc('restore');s.probabilities=original.probabilities;s.baseline=Object.keys(original.probabilities).sort((a,b)=>original.probabilities[b]-original.probabilities[a]||a.localeCompare(b))[0];
    const opp=s.side==='p1'?'p2':'p1',facts=revealedFacts(publicHistory(source.traces[s.side]),opp),roster=source.teams[opp==='p1'?0:1].map(p=>({species:p.species,level:p.level??100,gender:p.gender}));
    const rng=new PRNG(seedTuple(c.seed+60000+game)),worlds=[];
    for(let attempt=0;attempt<c.worldAttempts&&worlds.length<c.worlds;attempt++){
     limit();s.worldAttempts++;
     try{const team=sampleTeam(roster,facts,prior,()=>rng.random());const errors=new TeamValidator('gen9uu').validateTeam(structuredClone(team));if(errors)throw Error('sampled set illegal');const world=await replayWorld(source,s.side,team,c.seed+game*100000+attempt);if(worlds.some(x=>sha(JSON.stringify(x.team))===sha(JSON.stringify(world.team))))throw Error('duplicate world');worlds.push(world);}
     catch(e){const reason=e.code==='ERR_ASSERTION'?'prefix_or_request_mismatch':e.message;s.worldFailures[reason]=(s.worldFailures[reason]??0)+1;}
    }
    s.worldCount=worlds.length;write(path.join(out,s.id+'-worlds.json'),worlds);
    if(worlds.length!==c.worlds)throw Error('insufficient public-consistent worlds');
    for(let w=0;w<worlds.length;w++)await evaluateWorld(s,worlds[w],w,workers,c,limit,r=>append(s,r));
    Object.assign(s,aggregate(s.legal,s.baseline,s.rows,c.worlds,c.seeds));
    if(game%c.terminalEvery===0&&s.complete){const ranked=[...s.actions].sort((a,b)=>b.longWeighted-a.longWeighted||a.choice.localeCompare(b.choice)),choices=[...new Set([s.preferred??ranked[0].choice,s.baseline,ranked[1].choice])];for(let w=0;w<worlds.length;w++)await evaluateWorld(s,worlds[w],w,workers,c,limit,r=>append(s,r),choices);s.terminalValidation=terminalSummary(s,c);}
   }catch(e){s.error=e.message;s.complete=false;s.robust=false;}
   s.elapsedSeconds=(performance.now()-t0)/1000;write(path.join(out,s.id+'.json'),s);console.log(JSON.stringify({id:s.id,complete:s.complete,worlds:s.worldCount,attempts:s.worldAttempts,preferred:s.preferred,robust:s.robust,error:s.error,seconds:s.elapsedSeconds}));
  }

 }catch(e){fatal=e.message;console.error(e.stack);}finally{await Promise.all(SIDES.map(x=>workers[x].close()));}
 const complete=states.filter(x=>x.complete),changed=complete.filter(x=>x.changed),robust=complete.filter(x=>x.robust),validated=states.filter(x=>x.terminalValidation?.complete),terminalAgree=validated.filter(x=>x.terminalValidation.agree),seconds=states.length?mean(states.map(x=>x.elapsedSeconds)):null;
 const gates={completion:states.length===c.games&&complete.length===c.games,independence:new Set(states.flatMap(x=>x.families??[])).size===c.games*2,changed:changed.length>=Math.ceil(c.games*c.gates.changedShare),robust:robust.length>=c.gates.robustCount&&new Set(robust.map(x=>x.game)).size>=c.gates.robustCount,shortLong:complete.filter(x=>x.shortLongAgree).length>=Math.ceil(c.games*c.gates.shortLongShare),terminalCompletion:validated.length===Math.ceil(c.games/c.terminalEvery),terminalAgreement:terminalAgree.length>=Math.ceil(Math.ceil(c.games/c.terminalEvery)*c.gates.terminalShare),controls:controls.length===4&&controls.every(x=>x.pass),cost:seconds!==null&&seconds<=c.gates.secondsPerState};
 const summary={status:fatal?'INCOMPLETE':Object.values(gates).every(Boolean)?'PASS_SIGNAL':'FAIL',gates,fatal,states:states.length,complete:complete.length,changed:changed.length,robust:robust.length,shortLongAgreement:complete.filter(x=>x.shortLongAgree).length,terminalComplete:validated.length,terminalAgree:terminalAgree.length,controlsPass:controls.filter(x=>x.pass).length,meanStateSeconds:seconds,totalSeconds:(performance.now()-start)/1000,worldAttempts:states.reduce((n,x)=>n+x.worldAttempts,0),worlds:states.reduce((n,x)=>n+(x.worldCount??0),0),branches:states.reduce((n,x)=>n+x.rows.length+x.terminalRows.length,0),failedBranches:states.reduce((n,x)=>n+[...x.rows,...x.terminalRows].filter(x=>x.status!=='ok').length,0),workerExits:SIDES.map(x=>workers[x].exit),registrationSha256:sha(fs.readFileSync(c.registration)),configSha256:sha(text),datasetReady:false};
 write(path.join(out,'summary.json'),summary);console.log(JSON.stringify(summary));if(fatal)process.exitCode=1;return summary;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await run(process.argv[2]);
