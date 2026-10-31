// Re-rank seat replay: every home decision's guards, p' and executed pick recompute exactly from the hash-verified
// envelope (reconstructed-envelopes.jsonl, written by verify_canonical.ts), Metamon's logged p, the job seed and τ.
// Runtime cwd binds the frozen producer.
import fs from 'node:fs/promises'; import assert from 'node:assert/strict'; import path from 'node:path';
const root=path.resolve(process.argv[2]!); const repo=process.cwd();
const {rerankDecision,rerankSeedKey}=await import(repo+'/apps/companion/src/battle-agent/rerank.ts');
const {loadMetaMovePriorDescriptor}=await import(repo+'/apps/companion/src/history/metaPriorStore.ts');
const {hashCanonical}=await import(repo+'/apps/extension/lib/decision-identity.js');
const read=async(name:string)=>(await fs.readFile(path.join(root,name),'utf8')).split('\n').filter(Boolean).map((line)=>JSON.parse(line));
const json=(value:unknown)=>JSON.parse(JSON.stringify(value));
const {rerank}=JSON.parse(await fs.readFile(path.join(root,'job.json'),'utf8'));
const inputs=JSON.parse(await fs.readFile(path.join(root,'replay-inputs.json'),'utf8'));
// The match's envelopes used exactly the pinned live set priors.
assert.deepEqual(inputs.movePriors,json(await loadMetaMovePriorDescriptor(rerank.priorsDescriptor,repo)));
const home=(await read('trajectory.jsonl')).filter((row:any)=>row.side===rerank.homeSide),trace=await read('rerank-trace.jsonl');
const envelopes=new Map((await read('reconstructed-envelopes.jsonl')).filter((x:any)=>x.side===rerank.homeSide).map((x:any)=>[x.requestId,x.envelope]));
assert.equal(trace.length,home.length);
let changed=0;
for(const [i,row] of home.entries()){
 const {requestId,identity,mode,executedActionId,...record}=trace[i],envelope=envelopes.get(row.requestId);
 assert.ok(envelope);assert.equal(await hashCanonical(envelope.semantic),row.inputResultHash);
 assert.equal(requestId,row.requestId);assert.deepEqual(identity,row.identity);assert.equal(mode,rerank.mode);
 assert.equal(record.seedKey,rerankSeedKey(rerank.seed,rerank.homeSide,row.identity));
 assert.ok(record.rawProbabilities||row.identity.requestKind==='team_preview','NO_WORKER_DISTRIBUTION');
 assert.deepEqual(record.config,rerank.config);
 assert.deepEqual(record,json(rerankDecision(envelope,record.rawProbabilities??undefined,record.rawActionId,record.seedKey,rerank.config)));
 assert.equal(executedActionId,row.actionId);
 assert.equal(executedActionId,mode==='rerank'?record.rerankActionId??record.rawActionId:record.rawActionId);
 changed+=Number(executedActionId!==record.rawActionId);
}
console.log(JSON.stringify({root,mode:rerank.mode,decisions:home.length,changed}));
