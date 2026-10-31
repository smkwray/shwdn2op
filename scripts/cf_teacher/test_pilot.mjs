import test from 'node:test';
import assert from 'node:assert/strict';
import Showdown from 'pokemon-showdown';
import { legalChoices, routeMessage, familyAllowed, material, summarizeState, restoreBattle, workerPayload } from './pilot.mjs';
const { Battle } = Showdown;
const request = {side: {id:'p1',pokemon:[{active:true,condition:'100/100'}, {active:false,condition:'100/100'}, {active:false,condition:'0 fnt'}]},active:[{moves:[{id:'tackle',pp:35},{id:'protect',pp:0},{id:'rest',pp:1,disabled:true}],canTerastallize:'Normal'}]};
test('all legal ordinary/Tera moves and living switches, plus forced and trapped requests', () => {
  assert.deepEqual(legalChoices(request),['move 1','move 1 terastallize','switch 2']);
  assert.deepEqual(legalChoices({...request,forceSwitch:[true]}),['switch 2']);
  assert.deepEqual(legalChoices({...request,wait:true}),[]);
  assert.deepEqual(legalChoices({...request,active:[{...request.active[0],trapped:true}]}),['move 1','move 1 terastallize']);
  assert.throws(()=>legalChoices({active:[]}),/request/);
});
test('private channels never cross; raw end teams never become observations', () => {
  const messages=routeMessage({type:'update',data:'|split|p1\n|-damage|p1a: X|42/123\n|-damage|p1a: X|35/100\n|turn|2'});
  assert.match(messages.p1,/42\/123/);assert.doesNotMatch(messages.p2,/42\/123/);
  assert.equal(routeMessage({type:'sideupdate',data:'p2\n|request|{}'}).p1,'');
  assert.deepEqual(routeMessage({type:'end',data:'SECRET SETS'}),{p1:'',p2:''});
  assert.throws(()=>routeMessage({type:'unknown',data:'x'}));
});
test('exact and base family exclusions fail closed', () => {
  const families={exact:['a|b'],base:['a|c'],to_base:{d:'c'}};
  assert.equal(familyAllowed(['B','A'],families),false);
  assert.equal(familyAllowed(['D','A'],families),false);
  assert.equal(familyAllowed(['E','A'],families),true);
  assert.throws(()=>familyAllowed(['A'],{}));
});
test('material counts useful conversion symmetrically, terminal result overrides material', () => {
  const mon=(hp)=>({hp,maxhp:100});const b={sides:[{name:'one',pokemon:[mon(100),mon(0)]},{name:'two',pokemon:[mon(0),mon(100)]}]};
  assert.equal(material(b,'p1').score,0);
  b.sides[1].pokemon[1].hp=50;assert.ok(material(b,'p1').score>0);
  assert.equal(material(b,'p1').score,-material(b,'p2').score);
  b.ended=true;b.winner='two';assert.equal(material(b,'p1').score,-1);
});
test('seed halves, paired CI and failures govern robustness; no training-ready labels', () => {
  const rows=(choice,score)=>Array.from({length:4},(_,seed)=>({choice,seed,score,status:'ok',elapsedMs:1}));
  let s=summarizeState({legal:['move 1','switch 2'],baseline:'move 1',branches:[...rows('move 1',0),...rows('switch 2',.2)]});
  assert.equal(s.robust,true);assert.equal(s.preferred,'switch 2');assert.equal(s.datasetReady,false);
  assert.ok(s.actions.reduce((n,a)=>n+a.softTarget,0)>.99999);
  s=summarizeState({legal:['move 1','switch 2'],baseline:'move 1',branches:[...rows('move 1',0),...rows('switch 2',.2).map((x,i)=>({...x,score:i<2?.2:-.2}))]});
  assert.equal(s.robust,false);
  s=summarizeState({legal:['move 1','switch 2'],baseline:'move 1',branches:[...rows('move 1',0),...rows('switch 2',.2).map((x,i)=>i?x:{...x,status:'failed'})]});
  assert.equal(s.complete,false);assert.equal(s.robust,false);
});
function fixture(aMoves=['tackle'],bMoves=['splash']) {
 const team=(species,moves)=>Array.from({length:6},()=>({species,moves,level:100,ability:'No Ability'}));
 const b=new Battle({formatid:'gen9customgame',seed:[1,2,3,4]});b.setPlayer('p1',{name:'one',team:team('Magikarp',aMoves)});b.setPlayer('p2',{name:'two',team:team('Gastly',bMoves)});
 b.choose('p1','team 123456');b.choose('p2','team 123456');b.sendUpdates();return b;
}
test('native text restoration is exact, detached and replayable',()=>{
 const b=fixture(),saved=JSON.stringify(b.toJSON());const a=restoreBattle(saved),c=restoreBattle(saved);
 assert.deepEqual(a.toJSON(),c.toJSON());
 a.choose('p1','move 1');a.choose('p2','move 1');a.sendUpdates();
 assert.equal(JSON.stringify(b.toJSON()),saved);assert.deepEqual(c.toJSON(),JSON.parse(saved));
 const d=restoreBattle(saved);d.choose('p1','move 1');d.choose('p2','move 1');d.sendUpdates();assert.equal(JSON.stringify(a.toJSON()),JSON.stringify(d.toJSON()));
 [b,a,c,d].forEach(x=>x.destroy());
});
test('known immunity and priority knockout precede damage, useful trade is retained',()=>{
 let b=fixture();let before=b.p2.active[0].hp;b.choose('p1','move 1');b.choose('p2','move 1');assert.equal(b.p2.active[0].hp,before);b.destroy();
 b=fixture(['splash'],['aquajet']);b.p1.active[0].hp=1;b.choose('p1','move 1');b.choose('p2','move 1');assert.equal(b.p1.pokemon[0].hp,0);assert.equal(b.p1.pokemon[0].moveSlots[0].pp,b.p1.pokemon[0].moveSlots[0].maxpp);b.destroy();
 b=fixture(['explosion'],['splash']);b.p1.active[0].types=['Normal'];b.p2.active[0].types=['Normal'];b.p2.active[0].hp=1;b.choose('p1','move 1');b.choose('p2','move 1');assert.equal(b.p1.pokemon[0].hp,0);assert.equal(b.p2.pokemon[0].hp,0);b.destroy();
});

test('replay equality compares payloads while each RPC has its own checked sequence',()=>{
 assert.deepEqual(workerPayload({id:1,ok:true,choice:'switch 2'},1),workerPayload({id:9,ok:true,choice:'switch 2'},9));
 assert.throws(()=>workerPayload({id:2,ok:true},1),/identity/);
 assert.throws(()=>workerPayload({id:1,ok:false,error:'broken'},1),/broken/);
});
