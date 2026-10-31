import test from 'node:test';
import assert from 'node:assert/strict';
import Showdown from 'pokemon-showdown';
import { publicHistory, revealedFacts, sampleTeam, replyPlan, aggregate, controlSpec } from './belief.mjs';
const { Dex }=Showdown;
test('history strips private requests/clocks but keeps acting-side HP, reveals and failures',()=>{
 assert.equal(publicHistory(['|t:|1\n|request|SECRET\n|-damage|p1a: X|17/243\n|cant|p2a: Y|par']), '|-damage|p1a: X|17/243\n|cant|p2a: Y|par');
});
test('set sampler uses public reveals and prior only; missing support fails loudly',()=>{
 const log='|switch|p2a: Zapdos|Zapdos|100/100\n|move|p2a: Zapdos|Roost|p2a: Zapdos\n|-ability|p2a: Zapdos|Pressure\n|-item|p2a: Zapdos|Leftovers\n|-terastallize|p2a: Zapdos|Steel';
 const facts=revealedFacts(log,'p2');
 const raw={data:{Zapdos:{Moves:{roost:20,thunderbolt:10,protect:8,rest:2},Abilities:{Pressure:10,Static:5},Items:{Leftovers:10},'Tera Types':{Steel:10},Spreads:{'Timid:0/0/0/252/4/252':10}}}};
 const t=sampleTeam([{species:'Zapdos',level:100}],facts,raw,()=>.5);
 assert.equal(t[0].ability,'Pressure');assert.equal(t[0].item,'Leftovers');assert.equal(t[0].teraType,'Steel');assert.ok(t[0].moves.includes('roost'));
 assert.throws(()=>sampleTeam([{species:'Magikarp'}],facts,raw,()=>.5),/prior/);
 assert.throws(()=>revealedFacts(log+'\n|move|p2a: Zapdos|Trick|p1a: X','p2'),/unsupported/);
});
test('reply coverage contains every switch/Tera/move, e34 sampling mass does not become uniform',()=>{
 const p=replyPlan(['move 1','move 1 terastallize','switch 2'],{'move 1':.9,'move 1 terastallize':.05,'switch 2':.05},[.01,.99]);
 assert.equal(p.length,3);assert.equal(p[0].weight,.9);assert.equal(p.find(x=>x.choice==='switch 2').sampleCount,1);
 assert.throws(()=>replyPlan(['move 1'],{'move 1':.5},[.1]),/mass/);
});
test('world and seed robustness use each independent axis and root-specific worst reply',()=>{
 const rows=[];for(let w=0;w<2;w++)for(let seed=0;seed<2;seed++)for(const a of ['stay','switch'])for(const reply of ['hit','defend']) rows.push({world:w,seed,choice:a,reply,replyCount:2,weight:reply==='hit'?.9:.1,status:'ok',short:a==='stay'?.1:.5,long:a==='stay'?.1:(reply==='hit'?.8:-.2)});
 let s=aggregate(['stay','switch'],'stay',rows,2,2);
 assert.equal(s.preferred,'switch');assert.equal(s.robust,true);assert.equal(s.actions[1].longWorst,-.2);assert.ok(Math.abs(s.actions[1].longWeighted-.7)<1e-12);
 rows.find(x=>x.world===1&&x.seed===1&&x.choice==='switch').long=-4;
 assert.equal(aggregate(['stay','switch'],'stay',rows,2,2).robust,false);
 rows.pop();assert.equal(aggregate(['stay','switch'],'stay',rows,2,2).complete,false);
});
test('controls are specified by pre-outcome mechanics and have independent rosters',()=>{
 const s=[0,1,2,3].map(controlSpec);assert.deepEqual(s.map(x=>x.kind),['sacrifice','sacrifice','recovery','recovery']);
 assert.equal(new Set(s.map(x=>JSON.stringify(x.teams))).size,4);assert.ok(s.every(x=>x.expected==='move 1'&&x.predicate));
 for(const c of s)for(const team of c.teams)for(const m of team)assert.ok(Dex.species.get(m.species).exists);
});
test('a root best reply averages chance seeds before choosing the opponent action',()=>{
 const rows=[];for(let seed=0;seed<2;seed++)for(const reply of ['risky','safe'])rows.push({world:0,seed,choice:'stay',reply,replyCount:2,weight:.5,status:'ok',short:0,long:reply==='safe'?0:seed===0?1:-1});
 const a=aggregate(['stay'],'stay',rows,1,2).actions[0];
 assert.equal(a.longWorst,0,'opponent cannot choose its root action after learning the future chance seed');
 assert.equal(a.longWorstChanceBound,-.5);
});
test('Struggle and Recharge are forced requests, never revealed learned set moves',()=>{
 const f=revealedFacts('|switch|p2a: Pikachu|Pikachu|100/100\n|move|p2a: Pikachu|Struggle|p1a: X\n|move|p2a: Pikachu|Recharge|p2a: Pikachu','p2');
 assert.deepEqual(f.pikachu.moves,[]);
});
