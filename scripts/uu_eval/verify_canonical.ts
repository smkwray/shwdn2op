// Reused R60 exact replay verifier; runtime cwd binds the frozen producer.
import fs from 'node:fs/promises'; import assert from 'node:assert/strict'; import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const root=path.resolve(process.argv[2]!); const repo=process.cwd();
process.env.LOCAL_INTEL_STORE_PATH=path.join(root,'FORBIDDEN-history.json'); process.env.EXTERNAL_CURATED_STORE_PATH=path.join(root,'FORBIDDEN-curated.json');
const {DecisionEngine}=await import(repo+'/apps/companion/src/state/decisionEngine.ts');
const {evaluateDecision}=await import(repo+'/apps/companion/src/state/decisionEnvelope.ts');
const {createEphemeralIntelEvaluationContext,projectCanonicalSnapshots}=await import(repo+'/apps/companion/src/history/opponentIntelStore.ts');
const {trappedSwitchRejection}=await import(repo+'/apps/companion/src/battle-agent/metamon.ts');
const {hashCanonical}=await import(repo+'/apps/extension/lib/decision-identity.js');
const inputs=JSON.parse(await fs.readFile(path.join(root,'replay-inputs.json'),'utf8'));
const rows=(await fs.readFile(path.join(root,'trajectory.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
let checked=0; const envelopes:any[]=[];
for(const side of ['p1','p2']){
 const engine=new DecisionEngine({source:'owned_offline_simulator'});let context=await createEphemeralIntelEvaluationContext(inputs.movePriors);
 const own=rows.filter((r:any)=>r.side===side);let index=0,sequence=0;
 const frames=(await fs.readFile(path.join(root,side+'-private.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 for(const [frameIndex,data] of frames.entries()){
  const roomId='battle-'+inputs.format+'-offline';const current=await engine.ingest({sessionId:'offline-'+side,roomId,source:'protocol',observationId:side+'-'+(++sequence),sequence,data:'>'+roomId+'\n'+data});
  if(current.snapshot)context=await projectCanonicalSnapshots([current.snapshot],context);
  const row=own[index];if(!row||!isDeepStrictEqual(current.identity,row.identity))continue;
  const envelope=await evaluateDecision(engine,'offline-'+side,current.identity,context);
  assert.equal(envelope.resultHash,await hashCanonical(envelope.semantic));assert.equal(envelope.resultHash,row.inputResultHash);
  const action=envelope.semantic.snapshot.legalActions.find((a:any)=>a.id===row.actionId);
  assert.ok(action&&!action.disabled&&action.legality!=='disabled');assert.equal(action.choice,row.choice);
  if(!row.accepted){
   assert.ok(row.choice.startsWith('switch '));const next=own[index+1];
   assert.ok(next?.accepted&&next.choice.startsWith('move '));assert.equal(next.rqid,row.rqid);assert.notDeepEqual(next.identity,row.identity);
   const complete=trappedSwitchRejection(frames[frameIndex+1],row.rqid);
   if(!complete)assert.ok(trappedSwitchRejection(frames[frameIndex+2],row.rqid,true));
  }
  envelopes.push({side,requestId:row.requestId,executed:row.accepted,actionId:row.actionId,envelope}); index++;checked++;
 }
 assert.equal(index,own.length);
}
assert.equal(checked,rows.length);
// One line per write: a long game's envelopes joined into one string exceeded V8's string limit (e4 slot-0161-B1, 311 decisions).
{const out=await fs.open(path.join(root,'reconstructed-envelopes.jsonl'),'wx',0o600);try{for(const x of envelopes)await out.write(JSON.stringify(x)+'\n');}finally{await out.close();}}
await fs.writeFile(path.join(root,'canonical-reconstruction.json'),JSON.stringify({status:'PASS_EXACT_CANONICAL_IDENTITIES_LEGAL_CHOICES_AND_RESULT_HASHES',choices:checked,trappedRejections:rows.filter((r:any)=>!r.accepted).length,priors:!!inputs.movePriors,actualModelOrNNCalls:0,trainingAccepted:false},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,checked}));
