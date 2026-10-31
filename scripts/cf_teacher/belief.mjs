/** Offline information-set utilities. All history comes from the acting player's channel. */
import assert from 'node:assert/strict';
import Showdown from 'pokemon-showdown';
const {Dex}=Showdown;
export const id=x=>String(x).toLowerCase().replace(/[^a-z0-9]/g,'');
export const mean=x=>x.reduce((a,b)=>a+b,0)/x.length;
export function publicHistory(chunks) {
 return chunks.join('\n').split('\n').filter(x=>x&&!/^\|(?:request|t:|c:|seed)\|/.test(x)).join('\n');
}
export function revealedFacts(history,side) {
 const facts={},aliases={};
 const get=who=>{const species=aliases[who];if(!species)throw Error('unsupported public identity: '+who);return facts[id(species)]??= {species,moves:[]};};
 for(const line of history.split('\n')) {
  const p=line.split('|'),kind=p[1],who=p[2];
  if(['replace','detailschange','-transform','-formechange','-endability'].includes(kind))throw Error('unsupported history transformation');
  if(['switch','drag'].includes(kind)&&who.startsWith(side)){aliases[who]=p[3].split(',')[0];get(who);}
  if(kind==='move'&&who.startsWith(side)) {
   if(['trick','switcheroo','skillswap','roleplay','entrainment','worryseed','simplebeam','transform','mimic','sketch','metronome','assist','sleeptalk','copycat','instruct','mefirst'].includes(id(p[3])))throw Error('unsupported history move');
   const f=get(who);if(!['struggle','recharge'].includes(id(p[3]))&&!f.moves.includes(id(p[3])))f.moves.push(id(p[3]));
  }
  if(['-item','-enditem','-ability','-terastallize'].includes(kind)&&who?.startsWith(side))get(who)[kind==='-ability'?'ability':kind==='-terastallize'?'teraType':'item']=p[3];
  // Passive item/ability reveals are attributed by [of], or to the affected mon if absent.
  for(const tag of p.filter(x=>/^\[from\] (?:item|ability): /.test(x))) {
   const target=p.find(x=>x.startsWith('[of] '))?.slice(5)??who;
   if(target?.startsWith(side))get(target)[tag.includes('item:')?'item':'ability']=tag.replace(/^\[from\] (?:item|ability): /,'');
  }
 }
 return facts;
}
function weighted(entries,rng,label) {
 const valid=entries.filter(([,w])=>Number.isFinite(w)&&w>0),total=valid.reduce((n,[,w])=>n+w,0);
 if(!total)throw Error('missing prior support: '+label);
 let u=rng()*total;for(const [v,w] of valid){u-=w;if(u<0)return v;}return valid.at(-1)[0];
}
export function sampleTeam(roster,facts,prior,rng) {
 return roster.map(publicMon=>{
  const species=Dex.species.get(publicMon.species),entry=prior.data[species.name],f=facts[id(species.name)]??{moves:[]};
  if(!entry)throw Error('missing prior species: '+species.name);
  const moves=[...f.moves];if(moves.length>4)throw Error('unsupported >4 revealed moves');
  while(moves.length<4){const next=weighted(Object.entries(entry.Moves).filter(([m])=>id(m)&&!moves.includes(id(m))),rng,'moves');moves.push(id(next));}
  const spread=weighted(Object.entries(entry.Spreads??{}),rng,'spread'),m=/^([A-Za-z]+):([\d/]+)$/.exec(spread);
  if(!m||m[2].split('/').length!==6)throw Error('malformed spread');
  const pick=(field,key)=>f[field]??weighted(Object.entries(entry[key]??{}),rng,field);
  return {...publicMon,name:species.baseSpecies,species:species.name,moves,nature:m[1],evs:Object.fromEntries(['hp','atk','def','spa','spd','spe'].map((x,i)=>[x,Number(m[2].split('/')[i])])),ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},ability:pick('ability','Abilities'),item:pick('item','Items').replace(/^nothing$/,''),teraType:pick('teraType','Tera Types')};
 });
}
export function replyPlan(legal,distribution,uniforms) {
 assert.deepEqual(Object.keys(distribution).sort(),[...legal].sort(),'reply mapping');
 assert.ok(Object.values(distribution).every(x=>Number.isFinite(x)&&x>=0),'reply probabilities');
 assert.ok(Math.abs(Object.values(distribution).reduce((a,b)=>a+b,0)-1)<1e-5,'reply mass');
 const rows=legal.map(choice=>({choice,weight:distribution[choice],sampleCount:0}));
 for(const u of uniforms){let n=u;const found=rows.find(x=>(n-=x.weight)<0)??rows.at(-1);found.sampleCount++;}
 return rows;
}
function best(rows,key){const a=[...rows].sort((a,b)=>b[key]-a[key]||a.choice.localeCompare(b.choice));return a.length===1||a[0][key]-a[1][key]>1e-9?a[0].choice:null;}
export function aggregate(legal,baseline,rows,K,seeds) {
 const actions=legal.map(choice=>{
  const cells=[];
  for(let world=0;world<K;world++)for(let seed=0;seed<seeds;seed++) {
   const r=rows.filter(x=>x.choice===choice&&x.world===world&&x.seed===seed),ok=r.length>0&&r.every(x=>x.status==='ok'&&Number.isFinite(x.short)&&Number.isFinite(x.long))&&new Set(r.map(x=>x.reply)).size===r.length&&Math.abs(r.reduce((n,x)=>n+x.weight,0)-1)<1e-5&&r.length===r[0]?.replyCount;
   const complete=ok;
   cells.push({world,seed,complete,shortWeighted:complete?r.reduce((n,x)=>n+x.weight*x.short,0):null,longWeighted:complete?r.reduce((n,x)=>n+x.weight*x.long,0):null,longWorst:complete?Math.min(...r.map(x=>x.long)):null});
  }
  const complete=cells.every(x=>x.complete);
  const longWorst=complete?mean(Array.from({length:K},(_,world)=>{const replies=[...new Set(rows.filter(x=>x.choice===choice&&x.world===world).map(x=>x.reply))];return Math.min(...replies.map(reply=>mean(rows.filter(x=>x.choice===choice&&x.world===world&&x.reply===reply).map(x=>x.long))));})):null;
  return {choice,complete,cells,...Object.fromEntries(['shortWeighted','longWeighted'].map(k=>[k,complete?mean(cells.map(x=>x[k])):null])),longWorst,longWorstChanceBound:complete?mean(cells.map(x=>x.longWorst)):null};
 });
 if(!actions.every(x=>x.complete))return {complete:false,preferred:null,robust:false,actions,datasetReady:false};
 const preferred=best(actions,'longWeighted'),shortPreferred=best(actions,'shortWeighted'),worstPreferred=best(actions,'longWorst');
 const axis=(key,n)=>Array.from({length:n},(_,i)=>best(actions.map(a=>({choice:a.choice,v:mean(a.cells.filter(c=>c[key]===i).map(c=>c.longWeighted))})),'v'));
 const worldBest=axis('world',K),seedBest=axis('seed',seeds),gap=preferred?actions.find(x=>x.choice===preferred).longWeighted-actions.find(x=>x.choice===baseline).longWeighted:null;
 return {complete:true,preferred,shortPreferred,worstPreferred,changed:preferred!==null&&preferred!==baseline,gap,worldBest,seedBest,robust:Boolean(preferred&&gap>=.03&&worldBest.every(x=>x===preferred)&&seedBest.every(x=>x===preferred)),shortLongAgree:Boolean(preferred&&preferred===shortPreferred),actions,datasetReady:false};
}
export function controlSpec(i) {
 if(!Number.isInteger(i)||i<0||i>3)throw Error('unknown control');
 const sacrifice=i<2;
 const mon=(species,moves)=>({species,level:100,moves,ability:Object.values(Dex.species.get(species).abilities)[0],nature:'Serious',gender:Dex.species.get(species).gender||'M',evs:{hp:252,atk:252},teraType:Dex.species.get(species).types[0]});
 return {kind:sacrifice?'sacrifice':'recovery',expected:'move 1',predicate:sacrifice?'Last foe at 1 HP, no immunity/protection, faster active at 1 HP with only Explosion/Splash and a living reserve; Explosion converts self-KO to victory.':'Faster last survivor at 1 HP, only recovery/Splash, known slower hit is lethal before healing and nonlethal after; last foe at 1 HP with lethal poison at end of turn.',teams:sacrifice?[[mon(i===0?'Electrode':'Azelf',['explosion','splash']),mon(i===0?'Magikarp':'Feebas',['splash'])],[mon(i===0?'Blissey':'Chansey',['tackle'])]]:[[mon(i===2?'Latias':'Mew',[i===2?'recover':'softboiled','splash'])],[mon(i===2?'Magikarp':'Chansey',[i===2?'tackle':'seismictoss'])]],sacrifice};
}
