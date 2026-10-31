// Reused R60 exact replay verifier; runtime cwd binds the frozen producer.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]!);const repo=process.cwd();
process.env.LOCAL_INTEL_STORE_PATH=path.join(root,'FORBIDDEN-history.json');process.env.EXTERNAL_CURATED_STORE_PATH=path.join(root,'FORBIDDEN-curated.json');
const {runBattleMatch}=await import(pathToFileURL(path.join(repo,'apps/companion/src/battle-agent/simulator.ts')).href);
const {Teams}=await import(pathToFileURL(path.join(repo,'apps/companion/src/battle-agent/nativeSimulator.ts')).href);
const inputs=JSON.parse(await fs.readFile(path.join(root,'replay-inputs.json'),'utf8'));
const summary=JSON.parse(await fs.readFile(path.join(root,'summary.json'),'utf8'));
const rows=(await fs.readFile(path.join(root,'trajectory.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const expected=new Map(['p1','p2'].map(side=>[side,rows.filter((r:any)=>r.side===side)]));const indices:any={p1:0,p2:0};
// match.ts builds every recorded seat on MetamonBattlePolicy (direct, re-ranked or candidate). The replay must pass
// the same BattleAgent actionability gate, so it inherits that seat's mechanics requirement rather than the default.
const {MetamonBattlePolicy}=await import(pathToFileURL(path.join(repo,'apps/companion/src/battle-agent/metamon.ts')).href);
const requiresSupportedMechanics=new MetamonBattlePolicy({command:'never-executed',args:[]}).requiresSupportedMechanics;
const policy=(side:string)=>({id:'recorded-choice-replay',requiresSupportedMechanics,async decide(input:any){const row=expected.get(side)![indices[side]++];assert.ok(row);assert.equal(input.requestId,row.requestId);assert.deepEqual(input.envelope.semantic.identity,row.identity);assert.equal(input.envelope.resultHash,row.inputResultHash);return{requestId:input.requestId,identity:row.identity,actionId:row.actionId,...(typeof row.reason==='string'?{reason:row.reason}:{})};}});
for(const side of ['p1','p2']){const attempts=expected.get(side)!;for(let i=0;i<attempts.length;i++){const row=attempts[i];if(row.accepted)continue;const next=attempts[i+1];assert.ok(row.choice.startsWith('switch ')&&next?.accepted&&next.choice.startsWith('move '));assert.equal(next.rqid,row.rqid);assert.notDeepEqual(next.identity,row.identity);}}
const complete=summary.status==='completed';assert.ok(complete||(summary.status==='truncated'&&['deadline','max_decisions','max_turns'].includes(summary.stopReason)));
const result=await runBattleMatch({p1:policy('p1'),p2:policy('p2'),teams:{p1:Teams.unpack(inputs.teams.p1)!,p2:Teams.unpack(inputs.teams.p2)!},format:inputs.format,seed:inputs.seed,movePriors:inputs.movePriors,analysisMode:inputs.analysisMode,trace:true,timeoutMs:process.argv[3]===undefined?600000:Number(process.argv[3]),maxTurns:1000,maxDecisions:complete?12012:rows.length,fallback:'none'});
if(result.status!==summary.status)await fs.writeFile(path.join(root,'native-replay-failure-r2.json'),JSON.stringify({status:result.status,errors:result.errors,indices},null,2));
assert.equal(result.status,summary.status);assert.equal(result.winner,summary.winner);assert.deepEqual(result.errors,[]);assert.deepEqual(result.fallbacks,[]);assert.equal(result.trajectory.length,rows.length);for(const side of ['p1','p2'])assert.equal(indices[side],expected.get(side)!.length);
for(let i=0;i<rows.length;i++){const actual=result.trajectory[i],old=rows[i];for(const k of ['side','turn','rqid','requestId','identity','inputResultHash','actionId','choice','accepted'])assert.deepEqual(actual[k],old[k]);}
const strip=(s:string)=>s.split('\n').filter(l=>!l.startsWith('|t:|')).join('\n');assert.equal(strip(result.replay),strip(await fs.readFile(path.join(root,'replay.log'),'utf8')));
for(const side of ['p1','p2']as const){const frames=(await fs.readFile(path.join(root,side+'-private.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(strip(result.playerTraces![side].join('\n')),strip(frames.join('\n')));}
await fs.writeFile(path.join(root,'native-replay.json'),JSON.stringify({status:complete?'PASS_EXACT_RECORDED_CHOICE_NATIVE_REPLAY':'PASS_EXACT_EXECUTED_PREFIX_NATIVE_REPLAY',originalStopReason:summary.stopReason??null,replayStopReason:result.stopReason??null,clockTimeoutReproduced:false,choices:rows.length,trappedRejections:rows.filter((r:any)=>!r.accepted).length,turn:result.turn,winner:result.winner,publicAndBothPrivateTracesEqualExceptWallclock:true,modelOrNNCalls:0,trainingAccepted:false},null,2)+'\n',{flag:'wx',mode:0o600});console.log(root,rows.length);
