/** Replay complete private local-ladder input logs without a network or model. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const job=JSON.parse(await fs.readFile(process.argv[2]!,'utf8'));
const run=path.resolve(job.run),out=path.resolve(job.out);
await fs.mkdir(out);
await fs.copyFile(process.argv[2]!,path.join(out,'job.json'));
const pkg=path.join(run,'ps/node_modules/pokemon-showdown');
const require=createRequire(import.meta.url);
const {BattleStream}=require(path.join(pkg,'dist/sim/battle-stream.js'));
const {extractChannelMessages}=require(path.join(pkg,'dist/sim/battle.js'));
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
async function files(dir:string):Promise<string[]>{
 const result:string[]=[];
 for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
  const name=path.join(dir,entry.name);
  if(entry.isDirectory()) result.push(...await files(name));
  else if(entry.name.endsWith('.json.lz4.meta')) result.push(name);
 }
 return result;
}
const metas=await Promise.all((await files(path.join(run,'piles',job.block))).map(async file=>({file,...JSON.parse(await fs.readFile(file,'utf8'))})));
const tags=[...new Set(metas.map(r=>r.battle_tag))].sort();
assert.equal(tags.length,job.games);assert.equal(metas.length,job.games*2);
const days=await fs.readdir(path.join(pkg,'logs/2026-10/gen9uu'));
const admin=new Set(job.serverOnlyKinds as string[]);
const supportedServerLines=new Set(['|-hint|If you want to tie earlier, consider using `/offertie`.']);
const serverLines=new Set((job.serverOnlyLines??[]) as string[]);
assert([...serverLines].every(line=>supportedServerLines.has(line)),'Unsupported exact server-only line');
const normalize=(lines:string[])=>{
 const full=extractChannelMessages(lines.join('\n'),[-1])[-1] as string[];
 let excludedServerLines=0;
 const log=full.filter((line,index)=>{
  if(serverLines.has(line)) {
   assert(index>0&&full[index-1].startsWith('|bigerror|You will auto-tie if '),'Unproved server hint context');
   excludedServerLines++;
   return false;
  }
  return line!==''&&!admin.has(line.split('|')[1]);
 });
 return {log,excludedServerLines};
};
const results:any[]=[];
for(const tag of tags) {
 const pair=metas.filter(r=>r.battle_tag===tag);
 assert.equal(pair.length,2);assert(pair.every(r=>r.finished&&!r.hit_time_limit&&r.invalid_actions===0&&r.parse_errors===0));
 const filename=tag.replace(/^battle-/,'')+'.log.json';const matches:string[]=[];
 for(const day of days) {const file=path.join(pkg,'logs/2026-10/gen9uu',day,filename);try{await fs.access(file);matches.push(file);}catch{}}
 assert.equal(matches.length,1);
 const bytes=await fs.readFile(matches[0]),expected=JSON.parse(bytes.toString());
 assert.equal(expected.roomid,tag);assert.equal(expected.format,'gen9uu');
 assert.deepEqual([expected.p1.toLowerCase(),expected.p2.toLowerCase()].sort(),pair.map(r=>r.player.toLowerCase()).sort());
 assert(expected.inputLog.length>0&&expected.inputLog[0].startsWith('>start '));
 assert(expected.inputLog.every((s:string)=>/^>(?:start|player|p1|p2) /.test(s)),'No forced terminal, reseed or unregistered commands');
 const stream=new BattleStream({keepAlive:true,noCatch:true});const chunks:string[]=[];
 const reader=(async()=>{for await(const chunk of stream) chunks.push(chunk);})();
 try {
  await stream.write(expected.inputLog.join('\n'));
  assert(stream.battle?.ended,'Recorded input log must complete');
  const actual=stream.battle;
  assert.equal(actual.winner,expected.winner);assert.equal(actual.turn,expected.turns);
  const actualNormalized=normalize(actual.log),expectedNormalized=normalize(expected.log);
  const actualLog=actualNormalized.log,expectedLog=expectedNormalized.log;
  try{assert.deepEqual(actualLog,expectedLog);}catch(error){
   await fs.writeFile(path.join(out,tag+'-mismatch.json'),JSON.stringify({actual:actualLog,expected:expectedLog},null,2));throw error;
  }
  results.push({battle:tag,sourceSha256:sha(bytes),inputLogSha256:sha(JSON.stringify(expected.inputLog)),
   mechanicsLogSha256:sha(actualLog.join('\n')),choices:expected.inputLog.filter((s:string)=>/^>p[12] /.test(s)).length,
   exactServerLineExclusions:{actual:actualNormalized.excludedServerLines,expected:expectedNormalized.excludedServerLines},pass:true});
 } finally {await stream.writeEnd();await reader;}
 await fs.writeFile(path.join(out,'progress.json'),JSON.stringify({completed:results.length,required:job.games}));
}
await fs.writeFile(path.join(out,'report.json'),JSON.stringify({pass:true,games:results.length,results,
 modelCalls:0,networkConnections:0,qualificationOnly:true,serverOnlyKinds:[...admin],serverOnlyLines:[...serverLines],
 measurement:'Exact official-simulator input-log replay, terminal and every omniscient mechanics line; explicit server administration kinds excluded'},null,2));
