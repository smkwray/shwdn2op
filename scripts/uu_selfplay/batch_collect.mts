/** Experimental local-simulator collection through the shared pinned-policy worker. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const job = JSON.parse(await fs.readFile(process.argv[2]!, 'utf8'));
const out = path.resolve(job.out);
process.env.LOCAL_INTEL_STORE_PATH = path.join(out, 'FORBIDDEN-history.json');
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(out, 'FORBIDDEN-curated.json');
// Configure isolation before app modules capture config during ESM evaluation.
const { runBattleMatch } = await import('../../apps/companion/src/battle-agent/simulator.js');
const { MetamonBattlePolicy } = await import('../../apps/companion/src/battle-agent/metamon.js');
const { candidateSeat } = await import('./candidate_seat.js');
const panel = JSON.parse(await fs.readFile(job.panel, 'utf8'));
if (panel.schema !== 'uu-progress-panel@1' || panel.certification !== false) throw new Error('Progress panel required');
const forbidden = new Set([...panel.progress.map((f: any) => f.family), ...panel.excludedCertificationFamilies]);
if (panel.collection.some((f: any) => forbidden.has(f.family))) throw new Error('Training family leakage');
if (!['selfplay','progress'].includes(job.purpose)) throw new Error('Explicit replay purpose required');
if (job.collectionSlots && job.purpose !== 'selfplay') throw new Error('Collection slots are selfplay-only');
const explicitSlots = job.purpose === 'progress' ? job.progressSlots : job.collectionSlots;
if (explicitSlots && (!Array.isArray(explicitSlots)
    || !Number.isSafeInteger(job.gameOffset) || job.gameOffset < 0
    || explicitSlots.length < job.gameOffset + job.games
    || new Set(explicitSlots.map((s: any) => s.id)).size !== explicitSlots.length)) {
  throw new Error('Malformed or duplicate explicit slots');
}
for (const slot of explicitSlots ?? []) {
  if (typeof slot?.id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(slot.id)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(slot.id)
      || !Number.isSafeInteger(slot.policySeed) || slot.policySeed < 0 || slot.policySeed >= 2 ** 32
      || ['families','models'].some(key => !slot[key]
        || Object.keys(slot[key]).sort().join(',') !== 'p1,p2'
        || ['p1','p2'].some(side => typeof slot[key][side] !== 'string' || !slot[key][side]))) {
    throw new Error('Malformed explicit slot identity, families, models or seed');
  }
}
if (job.progressCensoring && (job.purpose!=='progress' || !job.retainAllTraces
    || job.progressCensoring.schema!=='uu-progress-censoring@1'
    || !Number.isFinite(job.progressCensoring.maxFraction) || job.progressCensoring.maxFraction<0
    || job.progressCensoring.maxFraction>.02)) throw new Error('Invalid progress-only censoring rule');
const records = job.purpose==='progress' ? panel.progress : panel.collection;
const teams = await Promise.all(records.map(async (r: any) => {
  const file = path.resolve(job.pool, r.source);
  if (!file.startsWith(path.resolve(job.pool, 'teams/uu_train_v1') + path.sep)) throw new Error('Public train teams only');
  const text = await fs.readFile(file, 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== r.sha256) throw new Error('Team hash drift');
  return { file, text, family: r.family };
}));
const abort = new AbortController();
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());
let next = 0, completed = 0, failed = 0, censored = 0;
const started = performance.now();
const file = await fs.open(path.join(out, 'games.jsonl'), 'wx');
const starts = await fs.open(path.join(out, 'games-started.jsonl'), 'wx');
let writes = Promise.resolve();
const record = (handle: typeof file, value: unknown) => {
  writes = writes.then(async () => { await handle.write(JSON.stringify(value)+'\n'); });
  return writes;
};
const throughput = () => {
  writes = writes.then(async () => {
    const temp = path.join(out,'throughput.tmp');
    await fs.writeFile(temp,JSON.stringify({startedGames:next,completed,failed,censored,
      wallSeconds:(performance.now()-started)/1000,gamesPerHour:completed*3600000/(performance.now()-started)},null,2));
    await fs.rename(temp,path.join(out,'throughput.json'));
  });
  return writes;
};
await Promise.all(Array.from({length: job.concurrency}, async () => {
  while (!abort.signal.aborted) {
    if (next >= job.games) return;
    const i = job.gameOffset + next++;
    const slot = explicitSlots?.[i];
    if ((job.purpose==='progress' || explicitSlots) && !slot) throw new Error('Missing explicit slot');
    const id = slot?.id ?? `game-${String(i).padStart(7, '0')}`;
    const p1 = slot ? teams.find(t=>t.family===slot.families.p1)! : teams[i % teams.length]!;
    const p2 = slot ? teams.find(t=>t.family===slot.families.p2)! : teams[(i + 1 + Math.floor(i / teams.length) % (teams.length - 1)) % teams.length]!;
    if (!p1 || !p2) throw new Error('Unknown explicit slot family');
    if (p1.family === p2.family) throw new Error('Self roster match');
    const policySeed = slot?.policySeed ?? job.seed + i;
    const seedBytes = createHash('sha256').update(String(policySeed)).digest();
    const seed: [number,number,number,number] = [0,2,4,6].map(offset=>seedBytes.readUInt16BE(offset)) as [number,number,number,number];
    const opponent = job.opponents[Math.floor(i/2) % job.opponents.length];
    const modelNames = slot?.models ?? (i%2 ? {p1:opponent,p2:job.focal} : {p1:job.focal,p2:opponent});
    const temperatures = {p1:job.temperatures[(i*2)%job.temperatures.length],
      p2:job.temperatures[(i*2+1)%job.temperatures.length]};
    const actors = Object.fromEntries((['p1','p2'] as const).map(side=>{
      const member = job.policies.find((m:any)=>m.name===modelNames[side]);
      if (!member) throw new Error('Unknown league actor');
      return [side,{...member,temperature:temperatures[side]}];
    }));
    await record(starts,{id,slot,seed,policySeed,actors,families:{p1:p1.family,p2:p2.family}});
    const launch = (side: 'p1' | 'p2', team: typeof p1) => {
      const actor = actors[side];
      const options = {command:job.python,policyId:actor.policyId,
        args:[path.resolve('scripts/uu_selfplay/batch_client.py'),'--socket',job.socket,
          '--seed',String(policySeed),'--game',id,'--side',side,'--team-file',team.file,
          '--model',actor.name,'--temperature',String(actor.temperature),'--policy-id',actor.policyId]};
      return actor.policyId==='metamon:Kakuna:epoch34' ? new MetamonBattlePolicy(options) : candidateSeat(options);
    };
    const result = await runBattleMatch({p1: launch('p1', p1), p2: launch('p2', p2),
      teams: {p1:p1.text, p2:p2.text}, format:'gen9uu', seed, trace:true, fallback:'none',
      maxTurns:1000, maxDecisions:12012, timeoutMs:job.matchTimeoutMs ?? 1200000, decisionDeadlineMs:120000,
      ...(job.cleanupDeadlineMs===undefined?{}:{cleanupDeadlineMs:job.cleanupDeadlineMs}),
      ...(job.analysisMode===undefined?{}:{analysisMode:job.analysisMode}),
      callerAbortSignal:abort.signal});
    const ok = result.status === 'completed' && result.errors.length === 0 && result.fallbacks.length === 0;
    const censor = Boolean(job.progressCensoring && result.status==='truncated' && result.stopReason==='deadline'
      && result.winner===null && result.fallbacks.length===0 && result.errors.length===1
      && result.errors[0]!.stage==='harness' && result.errors[0]!.side===null && result.errors[0]!.rqid===null
      && result.errors[0]!.message==='Match deadline expired.');
    if (ok) completed++; else if (censor) censored++; else failed++;
    await record(file,{id, slot, status:result.status, winner:result.winner, turns:result.turn,
      stopReason:result.stopReason??null, censored:censor,
      errors:result.errors, fallbacks:result.fallbacks, seed, policySeed,actors,
      families:{p1:p1.family,p2:p2.family}, elapsedSeconds:(performance.now()-started)/1000});
    // Preserve complete native/parsing evidence for parity samples and every failure.
    if (job.retainAllTraces || i < 8 || !ok) {
      const dir = path.join(out, id); await fs.mkdir(dir);
      const {trajectory,replay,replayInputs,playerTraces,producerSources,ownedCheckpoints,...summary}=result;
      await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify(summary));
      await fs.writeFile(path.join(dir,'trajectory.jsonl'),result.trajectory.map(x=>JSON.stringify(x)).join('\n')+'\n');
      await fs.writeFile(path.join(dir,'replay-inputs.json'),JSON.stringify(result.replayInputs));
      await fs.writeFile(path.join(dir,'replay.log'),result.replay);
      for (const side of ['p1','p2'] as const) await fs.writeFile(path.join(dir,side+'-private.jsonl'),
        result.playerTraces![side].map(x=>JSON.stringify(x)).join('\n')+'\n');
    }
    await throughput();
    if (!ok && !censor) abort.abort(new Error('Retained failed game; stop pilot for diagnosis'));
  }
}));
await file.close();
await starts.close();
process.exitCode = failed ? 1 : 0;
