import test from 'node:test';
import assert from 'node:assert/strict';
import {create,canonical,mapChoice,replayWorld,controlWorld} from './round2.mjs';
import {publicHistory} from './belief.mjs';
import {restoreBattle,material} from './pilot.mjs';
const sides=['p1','p2'];
const sinks=()=>Object.fromEntries(sides.map(x=>[x,{events:[],async rpc(op,v){this.events.push([op,v]);return {};}}]));
test('native prefix replay accepts observational equivalence, rejects changed reveals, never edits source',async()=>{
 const teams=[[{species:'Pikachu',moves:['splash'],gender:'M',ability:'Static'}],[{species:'Magikarp',moves:['splash'],gender:'M',ability:'Swift Swim'}]];
 const s=await create(teams,42,sinks(),'gen9customgame'),actions={};for(const side of sides)actions[side]=canonical(s.battle,side,'team 1');
 for(const side of sides)await s.choose(side,'team 1');
 const source={teams,format:'gen9customgame',steps:[{ready:sides,actions}],traces:s.traces,turn:1},before=JSON.stringify(source);
 let world=await replayWorld(source,'p1',teams[1],51);assert.equal(world.publicSha256.length,64);assert.equal(JSON.stringify(source),before);
 const bad=structuredClone(teams[1]);bad[0].species='Gyarados';await assert.rejects(replayWorld(source,'p1',bad,51),/prefix mismatch|Native rejected/);
 assert.equal(publicHistory(s.traces.p1),publicHistory(source.traces.p1));s.battle.destroy();
});
test('generic control predicates really separate terminal sacrifice/recovery from doing nothing',async()=>{
 for(let i=0;i<4;i++){
  const {world,spec}=await controlWorld(i,{seed:111});
  for(const choice of ['move 1','move 2']){
   const b=restoreBattle(world.text);b.choose('p1',choice);b.choose('p2','move 1');b.sendUpdates();
   for(let t=0;t<8&&!b.ended;t++)for(const side of sides){const r=b[side].activeRequest;if(r&&!r.wait){const action=r.forceSwitch?'switch 2':'move 1';b.choose(side,action);b.sendUpdates();}}
   assert.equal(b.ended,true,`control ${i} ${choice} must terminate`);assert.equal(material(b,'p1').score,choice===spec.expected?1:-1,`control ${i} ${choice}`);b.destroy();
  }
 }
});
test('native trapped-switch rejection preserves rqid and commits only the accepted redraw',async()=>{
 const workers=sinks();workers.p1.rpc=async function(op,v){this.events.push([op,v]);return op==='propose'?{choice:'move 1'}:{};};
 const s=await create([[{species:'Pikachu',gender:'M',moves:['splash']},{species:'Raichu',gender:'M',moves:['splash']}],[{species:'Magikarp',gender:'M',moves:['splash']}]],9,workers,'gen9customgame');
 for(const side of sides)await s.choose(side,side==='p1'?'team 12':'team 1');
 const before=s.rqids.p1;s.battle.p1.active[0].trapped=true;
 const accepted=await s.choose('p1','switch 2');assert.equal(accepted,'move 1');assert.equal(s.rqids.p1,before);assert.equal(s.rejections.length,1);
 assert.ok(workers.p1.events.some(([op,v])=>op==='observe'&&v.rejectedSwitch));
 assert.equal(workers.p1.events.filter(([op,v])=>op==='commit'&&v.choice==='switch 2').length,0);
 assert.equal(workers.p1.events.filter(([op,v])=>op==='commit'&&v.choice==='move 1').length,1);s.battle.destroy();
});
test('control setup discloses fainted reserves in private requests without impossible inactive faint events',async()=>{
 const {world}=await controlWorld(0,{seed:111});
 for(const side of sides){
  assert.equal(world.requests[side].side.pokemon.length,6);
  const transcript=world.events[side].filter(x=>x[0]==='observe').map(x=>x[1]).join('\n');
  assert.doesNotMatch(transcript,/\|faint\|p[12]: /,'inactive faint protocol is not a native singles transition');
 }
});
test('source choices use the native request menu when depleted PP forces Struggle',async()=>{
 const s=await create([[{species:'Pikachu',gender:'M',moves:['splash','tackle']}],[{species:'Magikarp',gender:'M',moves:['splash']}]],9,sinks(),'gen9customgame');
 for(const side of sides)await s.choose(side,'team 1');
 for(const m of s.battle.p1.active[0].moveSlots)m.pp=0;
 s.battle.makeRequest('move');
 assert.equal(s.battle.p1.activeRequest.active[0].moves[0].id,'struggle');
 const c=canonical(s.battle,'p1','move 1');assert.equal(c.move,'struggle');assert.equal(mapChoice(s.battle,'p1',c,true,()=>.5),'move 1');s.battle.destroy();
});
