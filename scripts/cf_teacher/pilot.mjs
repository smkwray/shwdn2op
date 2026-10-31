/** Offline, conditional-world teacher pilot. No server, browser or history store. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import Showdown from 'pokemon-showdown';
import Native from 'pokemon-showdown/dist/sim/battle.js';
const { Battle, PRNG, Teams, TeamValidator } = Showdown;
const SIDES=['p1','p2'];
export const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const write=(p,x)=>fs.writeFileSync(p,typeof x==='string'?x:JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
export function legalChoices(r) {
  if (!r?.side?.pokemon || !Array.isArray(r.side.pokemon)) throw Error('Missing private request');
  if (r.wait) return [];
  if (r.teamPreview) throw Error('Preview is not a root action state');
  const out=[],forced=r.forceSwitch?.some(Boolean),a=r.active?.[0];
  if (!forced) {
    if (!a?.moves?.length) throw Error('Missing move request');
    a.moves.forEach((m,i)=>{if(!m.disabled && m.pp!==0){out.push(`move ${i+1}`);if(a.canTerastallize)out.push(`move ${i+1} terastallize`);}});
  }
  if (forced || !a?.trapped) r.side.pokemon.forEach((m,i)=>{if(!m.active && !/ fnt$/.test(m.condition) && !/^0(?:\s|\/|$)/.test(m.condition))out.push(`switch ${i+1}`);});
  if (!out.length) throw Error('No legal root actions');
  return out;
}
export function routeMessage({type,data}) {
  if (type==='update') {const ch=Native.extractChannelMessages(Array.isArray(data)?data.join('\n'):data,[1,2]);return {p1:ch[1].join('\n'),p2:ch[2].join('\n')};}
  if (type==='sideupdate') {const i=data.indexOf('\n'),s=data.slice(0,i);if(!SIDES.includes(s))throw Error('Unknown side channel');return {p1:'',p2:'',[s]:data.slice(i+1)};}
  if (type==='end') return {p1:'',p2:''};
  throw Error('Unknown native message type: '+type);
}
export function familyAllowed(names,exclusions) {
  if(!Array.isArray(exclusions?.exact)||!Array.isArray(exclusions.base)||!exclusions.to_base)throw Error('Missing family exclusions');
  const ids=names.map(n=>n.toLowerCase().replace(/[^a-z0-9]/g,''));
  return !exclusions.exact.includes([...ids].sort().join('|'))&&!exclusions.base.includes(ids.map(n=>exclusions.to_base[n]??n).sort().join('|'));
}
export function material(b,side) {
  const i=side==='p1'?0:1;
  const resource=s=>({hp:s.pokemon.reduce((n,p)=>n+p.hp/p.maxhp,0),alive:s.pokemon.filter(p=>p.hp>0).length});
  const own=resource(b.sides[i]),opp=resource(b.sides[1-i]);
  return {score:b.ended?(b.winner?(b.winner===b.sides[i].name?1:-1):0):(own.hp-opp.hp)/6,own,opponent:opp,terminal:Boolean(b.ended)};
}
const mean=x=>x.reduce((a,b)=>a+b,0)/x.length;
function ci(x){if(x.length!==4||x.some(v=>!Number.isFinite(v)))return null;const m=mean(x),se=Math.sqrt(x.reduce((n,v)=>n+(v-m)**2,0)/3/4);return [m-3.182446305*se,m+3.182446305*se];}
function uniqueBest(actions,field){const ordered=[...actions].sort((a,b)=>b[field]-a[field]||a.choice.localeCompare(b.choice));return ordered.length>1&&ordered[0][field]-ordered[1][field]>1e-12?ordered[0].choice:null;}
export function summarizeState(s) {
  const complete=s.legal.every(choice=>{const a=s.branches.filter(b=>b.choice===choice);return a.length===4&&new Set(a.map(b=>b.seed)).size===4&&a.every(b=>b.status==='ok'&&Number.isFinite(b.score));});
  const actions=s.legal.map(choice=>{const r=s.branches.filter(b=>b.choice===choice&&b.status==='ok'),v=r.map(x=>x.score);return {choice,n:r.length,mean:v.length?mean(v):null,ci95:ci(v),half0:r.filter(x=>x.seed<2).length===2?mean(r.filter(x=>x.seed<2).map(x=>x.score)):null,half1:r.filter(x=>x.seed>=2).length===2?mean(r.filter(x=>x.seed>=2).map(x=>x.score)):null};});
  if (!complete) return {complete:false,robust:false,preferred:null,actions,datasetReady:false,reason:'failed_or_missing_branch'};
  const preferred=uniqueBest(actions,'mean'),base=s.branches.filter(b=>b.choice===s.baseline),best=s.branches.filter(b=>b.choice===preferred);
  const differences=preferred&&base.length===4?best.map(b=>b.score-base.find(x=>x.seed===b.seed).score):[];
  const pairedCI=ci(differences),gap=differences.length?mean(differences):null;
  const max=Math.max(...actions.map(x=>x.mean)),z=actions.reduce((n,x)=>n+Math.exp((x.mean-max)/.10),0);
  actions.forEach(x=>x.softTarget=Math.exp((x.mean-max)/.10)/z);
  const pairwise=[];for(let i=0;i<actions.length;i++)for(let j=i+1;j<actions.length;j++){const a=actions[i].choice,b=actions[j].choice;const d=s.branches.filter(x=>x.choice===a).map(x=>x.score-s.branches.find(y=>y.choice===b&&y.seed===x.seed).score);pairwise.push({a,b,mean:mean(d),ci95:ci(d)});}
  return {complete,preferred,changed:preferred!==null&&preferred!==s.baseline,robust:Boolean(preferred&&preferred===uniqueBest(actions,'half0')&&preferred===uniqueBest(actions,'half1')&&pairedCI?.[0]>0&&gap>=.03),gap,pairedCI,actions,pairwise,datasetReady:false,information:'fixed_hidden_world_conditional'};
}
export function restoreBattle(text,send=()=>{}) {if(typeof text!=='string')throw Error('Checkpoint must be detached text');const b=Battle.fromJSON(text);b.restart(send);return b;}
export function workerPayload(r,expectedId) {
  if(r.id!==expectedId)throw Error('RPC identity mismatch');
  if(r.ok!==true)throw Error(r.error??'Worker RPC failed');
  const {id,ok,...payload}=r;return payload;
}
export class Worker {
  constructor(launch,side,out) {
    this.serial=0;this.pending=null;this.stderr=fs.openSync(path.join(out,side+'-worker.log'),'wx');
    this.proc=spawn(launch.command,[...launch.args,'--side',side],{env:{...process.env,...launch.env},stdio:['pipe','pipe',this.stderr]});
    this.done=new Promise(resolve=>this.proc.once('exit',(code,signal)=>{this.exit={code,signal};if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error(`Worker exited ${code}/${signal}`));this.pending=null;}resolve(this.exit);}));
    createInterface({input:this.proc.stdout}).on('line',line=>{try {const r=JSON.parse(line);if(!this.pending||r.id!==this.serial)throw Error('RPC identity mismatch');const p=this.pending;this.pending=null;clearTimeout(p.timer);try{p.resolve(workerPayload(r,this.serial));}catch(e){p.reject(e);}}catch(e){this.pending?.reject(e);}});
    this.proc.on('error',e=>this.pending?.reject(e));
  }
  rpc(op,data={}) {if(this.pending||this.exit)throw Error('Invalid worker lifecycle');return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{reject(Error('Worker RPC timeout'));this.proc.kill('SIGTERM');},120000);this.pending={resolve,reject,timer};this.proc.stdin.write(JSON.stringify({id:++this.serial,op,...data})+'\n');});}
  async close(){if(!this.exit&&!this.proc.stdin.writableEnded)this.proc.stdin.end();const timer=setTimeout(()=>this.proc.kill('SIGKILL'),10000);await this.done;clearTimeout(timer);fs.closeSync(this.stderr);}
}
export class Session {
  constructor(battle,workers,queue=[],requests={},rqids={p1:0,p2:0},traces={p1:[],p2:[]}){Object.assign(this,{battle,workers,queue,requests,rqids,traces});this.choices=[];this.rejections=[];this.retryStages={};}
  async flush(){
    while(this.queue.length){const m=this.queue.shift(),r=routeMessage(m);
      for(const s of SIDES)if(r[s]){const lines=[];let rejectedSwitch=false;
        for(const line of r[s].split('\n')){
          if(line.startsWith('|error|')){
            if(line!=="|error|[Unavailable choice] Can't switch: The active Pokémon is trapped"||this.attempt?.side!==s||this.attempt.accepted||!this.attempt.choice.startsWith('switch ')||this.retryStages[s])throw Error('Native rejected choice: '+line);
            this.retryStages[s]='error';rejectedSwitch=true;
          }
          if(line.startsWith('|request|')){
            const v=JSON.parse(line.slice(9));this.requests[s]=v;
            if(v){const retry=this.retryStages[s]==='error';if(retry){assert.equal(v.active?.[0]?.trapped,true);this.retryStages[s]='complete';rejectedSwitch=true;}
              lines.push('|request|'+JSON.stringify({...v,rqid:retry?this.rqids[s]:++this.rqids[s]}));}
          }else if(line)lines.push(line);
        }
        if(lines.length){const data=lines.join('\n');this.traces[s].push(data);await this.workers[s].rpc('observe',{data,rejectedSwitch});}
      }
    }
  }
  async propose(s){return this.workers[s].rpc('propose');}
  async choose(s,choice){
    for(let attempt=0;attempt<2;attempt++){
      const turn=this.battle.turn,accepted=this.battle.choose(s,choice);this.attempt={side:s,choice,accepted};
      if(accepted){await this.workers[s].rpc('commit',{choice});this.choices.push({side:s,choice,turn});this.requests[s]=null;}
      this.battle.sendUpdates();await this.flush();
      if(accepted){delete this.retryStages[s];this.attempt=null;return choice;}
      if(this.retryStages[s]!=='complete')throw Error(`Native rejected ${s}: ${choice}`);
      this.rejections.push({side:s,choice,turn,rqid:this.rqids[s],reason:'trapped_switch'});
      choice=(await this.propose(s)).choice;delete this.retryStages[s];
    }
    throw Error('Trapped redraw was rejected');
  }
  ready(){return SIDES.filter(s=>this.requests[s]&&!this.requests[s].wait);}
}
export function seedTuple(n){return [n&65535,(n*17+3)&65535,(n*31+11)&65535,(n*67+19)&65535];}
async function branch(root,side,choice,seed,workers,limit) {
  const start=performance.now(),queue=[];const battle=restoreBattle(root.text,(type,data)=>queue.push({type,data}));
  // Common simulator chance stream across actions, distinct from source-game RNG.
  battle.prng=new PRNG(seedTuple(20261025+seed));
  const session=new Session(battle,workers,queue,structuredClone(root.requests),structuredClone(root.rqids));
  try {
    for(const s of SIDES)await workers[s].rpc('restore',{seed:20261025+seed});
    let decisions=0,opponentRoot=null,opponentDistribution=null;
    const proposals={};for(const s of SIDES)proposals[s]=await session.propose(s);
    const opp=side==='p1'?'p2':'p1';opponentRoot=proposals[opp].choice;opponentDistribution=proposals[opp].probabilities;
    assert.ok(Object.hasOwn(proposals[side].probabilities,choice),'root choice outside e34 action mapping');
    for(const s of SIDES){await session.choose(s,s===side?choice:proposals[s].choice);decisions++;}
    // At root turn T, requests at T+2 follow exactly two completed joint turns.
    while(!battle.ended&&(battle.turn<root.turn+2||SIDES.some(s=>session.requests[s]?.forceSwitch?.some(Boolean)))) {
      limit();if(decisions>=32)throw Error('Branch dispatch limit');const ready=session.ready();if(!ready.length)throw Error('No actionable continuation request');
      const p={};for(const s of ready)p[s]=await session.propose(s);
      for(const s of ready){await session.choose(s,p[s].choice);decisions++;}
    }
    return {choice,seed,status:'ok',...material(battle,side),opponentRoot,opponentDistribution,decisions,endTurn:battle.turn,elapsedMs:performance.now()-start};
  } catch(e){return {choice,seed,status:'failed',reason:String(e.message),elapsedMs:performance.now()-start};}
  finally {battle.destroy();}
}
async function main(configPath) {
  const configText=fs.readFileSync(configPath,'utf8'),c=JSON.parse(configText),reg=JSON.parse(fs.readFileSync(c.registration,'utf8'));
  assert.equal(sha(fs.readFileSync(c.design)),reg.designSha256);assert.equal(sha(configText),reg.configSha256);
  const out=c.output;fs.mkdirSync(out,{recursive:false});
  const start=performance.now(),deadline=start+2700000;let stopping=null;
  const stop=signal=>{stopping=signal;for(const w of Object.values(workers))if(!w.exit)w.proc.stdin.end();};process.on('SIGTERM',()=>stop('SIGTERM'));process.on('SIGINT',()=>stop('SIGINT'));
  const limit=()=>{if(stopping)throw Error(stopping);if(performance.now()>deadline)throw Error('wall_deadline');};
  const workers=Object.fromEntries(SIDES.map(s=>[s,new Worker(c.worker,s,out)]));const states=[],games=[];let warmupMs=null,fatal=null;
  const sourceStart=performance.now();
  try {
    const hellos=await Promise.all(SIDES.map(s=>workers[s].rpc('hello')));warmupMs=performance.now()-sourceStart;write(path.join(out,'runtime.json'),hellos);
    for(let game=0;game<6&&states.length<12;game++) {
      limit();const gstart=performance.now(),queue=[],battle=new Battle({formatid:'gen9uu',seed:seedTuple(20261025+100+game),send:(type,data)=>queue.push({type,data})});
      const teams=c.teams.slice(game*2,game*2+2);assert.equal(teams.length,2);
      for(const t of teams){assert.equal(sha(fs.readFileSync(t.file)),t.sha256);assert.ok(familyAllowed(t.species,c.exclusions));const errors=new TeamValidator('gen9uu').validateTeam(Teams.import(fs.readFileSync(t.file,'utf8')));assert.equal(errors,null);}
      for(const s of SIDES)await workers[s].rpc('new_game',{game,seed:20261025+100+game});
      const session=new Session(battle,workers);session.queue=queue;const selected=new Set();let gameError=null;
      try {
        for(const s of SIDES){await workers[s].rpc('observe',{data:'|init|battle'});session.traces[s].push('|init|battle');battle.setPlayer(s,{name:'Offline '+s,team:Teams.import(fs.readFileSync(teams[s==='p1'?0:1].file,'utf8'))});}
        battle.sendUpdates();await session.flush();
        while(!battle.ended&&battle.turn<=40&&states.length<12) {
          limit();const ready=session.ready();if(!ready.length)throw Error('Source has no action request');
          if(ready.length===2&&[6,12].includes(battle.turn)&&!selected.has(battle.turn)&&SIDES.every(s=>!session.requests[s].forceSwitch?.some(Boolean)&&!session.requests[s].teamPreview)) {
            selected.add(battle.turn);assert.equal(queue.length,0);
            const root={text:JSON.stringify(battle.toJSON()),requests:structuredClone(session.requests),rqids:structuredClone(session.rqids),turn:battle.turn};
            for(const s of SIDES)await workers[s].rpc('save');
            const parity=await Promise.all(SIDES.map(s=>workers[s].rpc('replay_check')));write(path.join(out,'g'+game+'-t'+battle.turn+'-parity.json'),parity);
            const prefix='g'+game+'-t'+battle.turn;write(path.join(out,prefix+'-checkpoint.json'),root);write(path.join(out,prefix+'-protocol.json'),session.traces);
            // Verify distribution AND choice repeat with restored observation history/recurrence.
            for(const s of SIDES){await workers[s].rpc('restore',{seed:123});const a=await session.propose(s);await workers[s].rpc('restore',{seed:123});assert.deepEqual(await session.propose(s),a);await workers[s].rpc('restore');}
            for(const side of SIDES){if(states.length>=12)break;const t0=performance.now(),legal=legalChoices(root.requests[side]);const p=await session.propose(side);assert.deepEqual(Object.keys(p.probabilities).sort(),[...legal].sort(),'native/e34 legal sets differ');await workers[side].rpc('restore');
              const baseline=Object.keys(p.probabilities).sort((a,b)=>p.probabilities[b]-p.probabilities[a]||a.localeCompare(b))[0];
              const s={id:prefix+'-'+side,index:states.length,game,turn:root.turn,side,split:states.length<4?'engineering':'held_aside',families:teams.map(t=>t.family),checkpointSha256:sha(root.text),legal,baseline,probabilities:p.probabilities,branches:[]};
              for(const choice of legal)for(let seed=0;seed<4;seed++){limit();const row=await branch(root,side,choice,seed,workers,limit);s.branches.push(row);fs.appendFileSync(path.join(out,'branches.jsonl'),JSON.stringify({state:s.id,...row})+'\n');}
              // Real worker + native replay repeatability, not just an algebraic fixture.
              const repeated=await branch(root,side,legal[0],0,workers,limit),original=s.branches[0];const stable=x=>Object.fromEntries(Object.entries(x).filter(([k])=>k!=='elapsedMs'));assert.deepEqual(stable(repeated),stable(original),'same-seed rollout is not repeatable');
              s.elapsedMs=performance.now()-t0;Object.assign(s,summarizeState(s));states.push(s);write(path.join(out,s.id+'.json'),s);console.log(JSON.stringify({state:s.id,split:s.split,complete:s.complete,preferred:s.preferred,baseline:s.baseline,robust:s.robust,seconds:s.elapsedMs/1000}));
              for(const x of SIDES)await workers[x].rpc('restore');
            }
            assert.equal(JSON.stringify(battle.toJSON()),root.text,'source checkpoint mutated');
          }
          if(states.length>=12)break;
          const proposals={};for(const s of ready)proposals[s]=await session.propose(s);
          for(const s of ready)await session.choose(s,proposals[s].choice);
        }
      } catch(e){gameError=e.message;throw e;}
      finally {games.push({game,turn:battle.turn,completed:battle.ended,error:gameError,elapsedMs:performance.now()-gstart,teams:teams.map(t=>({family:t.family,sha256:t.sha256}))});write(path.join(out,'g'+game+'-source.json'),{...games.at(-1),nativeInputs:{format:'gen9uu',seed:seedTuple(20261025+100+game),teams:teams.map(t=>Teams.import(fs.readFileSync(t.file,'utf8')))},protocol:session.traces,choices:session.choices});battle.destroy();}
    }
  } catch(e){fatal=e.message;console.error(e.stack);}
  finally {await Promise.all(SIDES.map(s=>workers[s].close()));}
  const held=states.filter(s=>s.split==='held_aside'),nComplete=held.filter(s=>s.complete).length,changed=held.filter(s=>s.changed).length,robust=held.filter(s=>s.robust).length;
  const meanStateMs=states.length?mean(states.map(s=>s.elapsedMs)):null;
  const status=fatal||held.length!==8?'INCOMPLETE':nComplete===8&&changed>=2&&robust>=2&&meanStateMs<=120000?'PASS_CONDITIONAL_SIGNAL':'FAIL';
  const summary={status,fatal,states:states.length,heldAside:held.length,completeHeldAside:nComplete,changed,robust,meanStateSeconds:meanStateMs===null?null:meanStateMs/1000,warmupSeconds:warmupMs/1000,totalSeconds:(performance.now()-start)/1000,branches:states.reduce((n,s)=>n+s.branches.length,0),failedBranches:states.reduce((n,s)=>n+s.branches.filter(b=>b.status!=='ok').length,0),games,workerExits:SIDES.map(s=>workers[s].exit),datasetReady:false,informationLimitation:'fixed_hidden_world; e34 sampled replies, not adversarial best replies; 2-turn material, not terminal value',registrationSha256:sha(fs.readFileSync(c.registration)),configSha256:sha(configText)};
  write(path.join(out,'summary.json'),summary);console.log(JSON.stringify(summary));if(fatal)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main(process.argv[2]);
