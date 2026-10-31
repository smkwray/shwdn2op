/** Per-seat entry point to the existing official offline match engine. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBattleMatch } from '../../apps/companion/src/battle-agent/simulator.js';
import { MetamonBattlePolicy } from '../../apps/companion/src/battle-agent/metamon.js';
import { RerankedMetamonPolicy } from '../../apps/companion/src/battle-agent/rerank.js';
import { loadMetaMovePriorDescriptor } from '../../apps/companion/src/history/metaPriorStore.js';
import { candidateSeat } from '../uu_selfplay/candidate_seat.js';

const job = JSON.parse(await fs.readFile(process.argv[2]!, 'utf8'));
const abort = new AbortController();
let signal: string | null = null;
const cancel = (s: string) => { signal = s; abort.abort(new Error(s)); };
process.on('SIGINT', () => cancel('SIGINT'));
process.on('SIGTERM', () => cancel('SIGTERM'));
process.env.LOCAL_INTEL_STORE_PATH = path.join(job.output, 'FORBIDDEN-history.json');
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(job.output, 'FORBIDDEN-curated.json');
// Re-rank cohorts (evaluate.py job_for): the home seat is wrapped in both arms and every envelope uses the pinned live
// set priors, so guards see what the live advisor sees. B1 executes the re-ranked pick; B0 executes raw and logs a shadow.
const rerank: { homeSide: 'p1' | 'p2'; mode: 'rerank' | 'shadow'; seed: number; priorsDescriptor: string;
  config: { tau: number; demoted: Array<'delayed_slot_occupied' | 'pre_move_ko' | 'setup_dead_end' | 'switch_into_ko'> } } | undefined = job.rerank;
const movePriors = rerank ? await loadMetaMovePriorDescriptor(rerank.priorsDescriptor, process.cwd()) : undefined;
const rerankTrace: string[] = [];
const actor = (side: 'p1' | 'p2', launch: any) => {
  if (launch.policyId.startsWith('metamon:UUFinetuned:')) return candidateSeat(launch);
  const transport = new MetamonBattlePolicy(launch);
  return rerank?.homeSide !== side ? transport : new RerankedMetamonPolicy(transport, { id: launch.policyId, mode: rerank.mode,
    seed: rerank.seed, side, config: rerank.config, onRecord: (row) => {
      // Without the worker's distribution the seat would silently play raw Metamon: fail the game instead.
      if (!row.rawProbabilities && row.identity.requestKind !== 'team_preview') throw new Error('Re-rank seat got no worker distribution.');
      rerankTrace.push(JSON.stringify(row));
    } });
};
const players = { p1: actor('p1', job.launches.p1), p2: actor('p2', job.launches.p2) };
if (process.argv[3] === '--dry') {
  // Job-contract check only: seats and priors are built, no worker is started.
  console.log(JSON.stringify({ ...Object.fromEntries((['p1', 'p2'] as const).map((side) => [side,
    { id: players[side].id, reranked: players[side] instanceof RerankedMetamonPolicy }])), priorsRevision: movePriors?.revision ?? null }));
  process.exit(0);
}
const result = await runBattleMatch({
  p1: players.p1, p2: players.p2,
  teams: {p1: await fs.readFile(job.teamFiles.p1, 'utf8'), p2: await fs.readFile(job.teamFiles.p2, 'utf8')},
  format: 'gen9uu', seed: job.seed, trace: true, fallback: 'none',
  maxTurns: 1000, maxDecisions: 12012, timeoutMs: 3600000, decisionDeadlineMs: 120000,
  callerAbortSignal: abort.signal, ...(movePriors ? { movePriors } : {}),
});
const { trajectory, replay, replayInputs, playerTraces, producerSources, ownedCheckpoints, ...summary } = result;
const write = (name: string, data: unknown) => fs.writeFile(path.join(job.output, name),
  typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
await write('trajectory.jsonl', trajectory.map(x => JSON.stringify(x)).join('\n') + '\n');
await write('replay.log', replay);
await write('replay-inputs.json', replayInputs);
await write('producer-source.json', {hash: result.versions.producer, sources: producerSources});
for (const side of ['p1', 'p2'] as const) await write(side + '-private.jsonl',
  playerTraces![side].map(x => JSON.stringify(x)).join('\n') + '\n');
if (rerank) await write('rerank-trace.jsonl', rerankTrace.join('\n') + '\n');
await write('summary.json', {...summary, cancellationSignal: signal});
process.exitCode = signal ? 130 : result.status === 'completed' ? 0 : result.status === 'truncated' ? 2 : 1;
