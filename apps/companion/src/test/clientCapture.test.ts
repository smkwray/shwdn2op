import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PokemonSnapshot } from '../types.js';
import { DecisionEngine, observationSchema, type BattleObservation, type CanonicalDecisionIdentity } from '../state/decisionEngine.js';
import { isCanonicalTimelineLine, type CanonicalFact } from '../state/canonicalLedger.js';
import { createDecisionIdentity, hashCanonical } from '../../../extension/lib/decision-identity.js';

interface Captured {
  key: string;
  client: string;
  provenance: {
    trace: number; jsonlLine: number; observationIndex: number; requestId: string; at: string; originalObservationIdSha256: string;
    rawDataSha256: string; rawJsonlLineSha256: string;
    originalLineCount: number; retainedLineCount: number; trimAfter: string | null;
  };
  observation: BattleObservation;
}
interface Fixture {
  producer: { path: string; sha256: string };
  observations: Captured[];
  cases: Array<{ id: string; keys: string[]; coverage: string }>;
  comparisons: Array<{ left: string; right: string; through: string }>;
  coverage: Record<string, string | boolean>;
  traces: Array<{ bytes: number; sha256: string; prefixThrough: string; jsonlRows: number }>;
  privateCoverage: Record<string, string | boolean>;
  privateCaptures: Array<{ id: string; client: string; coverage: string; observations: Captured[]; evaluations: Array<{
    observationKey: string;
    provenance: {
      acknowledgment: RowProvenance; request: RowProvenance; response: RowProvenance; resultIndex: number;
      originalRoomIdSha256: string; originalSessionIdSha256: string;
    };
    acknowledgment: { observationId: string; acknowledgedSequence: number; identity: CanonicalDecisionIdentity; phase: string; turn: number };
    request: { sessionId: string; identity: CanonicalDecisionIdentity; historyRevision: string };
    response: { status: number; evaluatedAt: string; contractVersion: string; engineVersion: string; identity: CanonicalDecisionIdentity;
      historyRevision: string; resultHash: string; phase: string; turn: number; sideId: string; actionable: boolean;
      legalActionCount: number; rankedActionCount: number; topActionId: string | null; rankedActionIdsHash: string; partyHash: string };
  }> }>;
}
interface RowProvenance { trace: number; jsonlLine: number; requestId: string; at: string; rawJsonlLineSha256: string }
const root = new URL('../../../../', import.meta.url);
const raw = await readFile(new URL('examples/chrome-client-observations.json', root), 'utf8');
const fixture: Fixture = JSON.parse(raw);
const captured = (key: string) => {
  const entry = fixture.observations.find((entry) => entry.key === key);
  assert.ok(entry, key); return entry;
};
const keys = (id: string) => {
  const entry = fixture.cases.find((entry) => entry.id === id);
  assert.ok(entry, id); return entry.keys;
};
async function replay(selected: string[]) {
  const engine = new DecisionEngine();
  const results = [];
  for (const key of selected) results.push(await engine.ingest(captured(key).observation));
  return { engine, results, last: results.at(-1)! };
}
const facts = (room: any): CanonicalFact[] => room.canonicalEvidence.facts;
function pokemon(room: any, side: string, species: string): any {
  const found = Object.values(room.sides[side].team).filter((mon: any) => mon.species === species);
  assert.equal(found.length, 1, `${side} ${species}`); return found[0];
}
function assertRoster(room: any) {
  for (const side of ['p1', 'p2']) assert.equal(facts(room).filter((fact) => fact.kind === 'poke' && fact.args[0] === side).length, 6);
}
function assertSpectator(result: Awaited<ReturnType<DecisionEngine['ingest']>>) {
  assert.equal(result.room.playerSide, null);
  assert.equal(result.room.lastRequest, null);
  assert.deepEqual(result.room.legalActions, []);
  assert.equal(result.snapshot, null, 'No private BattleSnapshot from spectator data');
  assert.equal(result.identity, null, 'No own decision/rqid from supplemental p1');
  assert.ok(facts(result.room).every((fact) => !['request', 'sso-state'].includes(fact.kind)));
}

test('actual Chrome fixture is compact, sanitized and bound to its retained producer', async () => {
  assert.ok(Buffer.byteLength(raw) < 80_000);
  assert.equal(createHash('sha256').update(await readFile(new URL(fixture.producer.path, root))).digest('hex'), fixture.producer.sha256);
  assert.doesNotMatch(raw, /[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i);
  assert.doesNotMatch(raw, /battle-gen9(?:ou|uu)-\d+/);
  for (const entry of fixture.observations) {
    const o = observationSchema.parse(entry.observation);
    const p = entry.provenance;
    assert.match(p.at, /^2026-10-18T16:/);
    for (const hash of [p.rawDataSha256, p.rawJsonlLineSha256, p.originalObservationIdSha256]) assert.match(hash, /^[a-f\d]{64}$/);
    const lines = o.data.split('\n');
    assert.equal(lines.length, p.retainedLineCount);
    assert.equal(lines[0], `>${o.roomId}`);
    if (p.trimAfter) { assert.equal(lines.at(-1), p.trimAfter); assert.ok(lines.length < p.originalLineCount); }
    else assert.equal(lines.length, p.originalLineCount);
    for (const line of lines) {
      assert.doesNotMatch(line, /^\|(?:c|c:|chat|j|J|l|L|join|leave|t:|timestamp|inactive|inactiveoff|rated|request)\|/);
      if (line.startsWith('|player|')) assert.match(line, /^\|player\|p[12]\|Player [12]$/);
      if (line.startsWith('|sso-state|')) {
        const state = JSON.parse(line.slice(11));
        assert.equal(state.playerSide, 'p1', 'Retain the real misleading hint for regression');
        for (const mon of state.pokemon) if (mon.ident) assert.match(mon.ident, /^p[12]: Mon \d+$/);
      } else for (const match of line.matchAll(/p[12][a-z]: ([^|]+)/g)) assert.match(match[1]!, /^Mon \d+$/);
    }
  }
  assert.equal(fixture.coverage.privateBattleSnapshotParity, false);
  assert.equal(fixture.coverage.battleCompletion, false);
  assert.match(String(fixture.coverage.statusCure), /Absent/);
});

test('both recorded clients capture roster and ordered public turns, with exact observation ancestry', async () => {
  for (const [id, lastTurn] of [['legacy-ou', 12], ['preact-ou', 12], ['preact-uu-cold', 3], ['legacy-uu', 16]] as const) {
    const { last, results } = await replay(keys(id));
    assertRoster(last.room);
    assert.deepEqual(facts(last.room).filter((fact) => fact.kind === 'turn').map((fact) => Number(fact.args[0])), Array.from({ length: lastTurn }, (_, i) => i + 1));
    for (const result of results) assertSpectator(result);
    for (const fact of facts(last.room)) {
      const origin = fixture.observations.find((entry) => entry.observation.observationId === fact.source.observationId)!;
      assert.ok(origin);
      assert.equal(fact.source.sequence, origin.observation.sequence);
      assert.equal(fact.source.channel, origin.observation.source);
      const line = origin.observation.data.split('\n')[fact.source.lineIndex];
      assert.equal(line, `|${fact.kind}${fact.args.length ? `|${fact.args.join('|')}` : ''}`);
    }
  }
  const preview = await replay(['preact-uu-preview']);
  assertRoster(preview.last.room); assert.equal(preview.last.room.turn, 0);
});

test('actual SPA session gap starts partial; anchored and cold recovery retain their own authority', async () => {
  const preview = captured('preact-uu-preview').observation, start = captured('preact-uu-start').observation;
  assert.notEqual(preview.sessionId, start.sessionId);
  const partial = await replay(keys('preact-uu-session-gap'));
  assert.equal(facts(partial.results[1]!.room).filter((fact) => fact.kind === 'poke').length, 0);
  assertRoster(partial.last.room);
  assert.deepEqual(partial.last.room.canonicalEvidence.limitations, ['recovery_public_continuity_unknown']);
  assert.ok(facts(partial.last.room).filter((fact) => fact.kind === 'poke').every((fact) => fact.source.channel === 'recovery'));
  for (const prior of facts(partial.results[1]!.room)) {
    const retained = facts(partial.last.room).find((fact) => fact.source.observationId === prior.source.observationId && fact.source.lineIndex === prior.source.lineIndex);
    assert.ok(retained); assert.deepEqual(retained.source, prior.source);
    assert.equal(retained.kind, prior.kind);
    const line = (fact: CanonicalFact) => `|${fact.kind}|${fact.args.join('|')}`.replace(/^(\|[^|]+)\|$/, '$1');
    assert.equal(line(retained), line(prior), 'Bare start and start with its optional separator are equivalent');
  }
  assert.ok(facts(partial.last.room).every((fact) => fact.source.observationId !== preview.observationId));
  assertRoster((await partial.engine.read(preview.sessionId, preview.roomId)).room);
  const cold = await replay(keys('preact-uu-cold'));
  assertRoster(cold.last.room);
  assert.deepEqual(cold.last.room.canonicalEvidence.limitations, ['recovery_public_continuity_unknown']);
  assert.ok(facts(cold.last.room).filter((fact) => fact.kind === 'poke').every((fact) => fact.source.channel === 'recovery'));
  assert.deepEqual(facts(cold.last.room).filter((fact) => fact.kind === 'turn').map((fact) => fact.source.channel), ['recovery', 'protocol', 'protocol']);
});

test('matching recovery cannot overwrite captured status or restore removed items and cleared boosts', async () => {
  const beta = await replay(keys('preact-uu-cold'));
  const before = beta.results[1]!, after = beta.results[2]!;
  assert.equal(pokemon(before.room, 'p1', 'Infernape').status, 'tox');
  assert.equal(pokemon(before.room, 'p1', 'Infernape').hpPercent, 77);
  assert.deepEqual(pokemon(before.room, 'p1', 'Infernape').boosts, { spa: -2 });
  const supplemental = JSON.parse(captured('preact-uu-recovery-2').observation.data.split('\n').find((line) => line.startsWith('|sso-state|'))!.slice(11));
  assert.equal(supplemental.pokemon.find((mon: any) => mon.details.startsWith('Infernape')).condition, '100/100');
  assert.deepEqual(after.room.sides, before.room.sides);
  assert.deepEqual(facts(after.room), facts(before.room));
  assert.deepEqual(pokemon(beta.last.room, 'p1', 'Infernape').boosts, {}, 'Actual switch clears the active-stint drop');
  assert.equal(pokemon(beta.last.room, 'p1', 'Infernape').status, 'tox');

  const legacy = await replay(keys('legacy-uu'));
  const prior = legacy.results.at(-2)!;
  assert.equal(pokemon(legacy.results[0]!.room, 'p1', 'Thundurus').boosts.spa, 2);
  for (const result of [prior, legacy.last]) {
    assert.equal(pokemon(result.room, 'p1', 'Tinkaton').item, null);
    assert.equal(pokemon(result.room, 'p1', 'Tinkaton').removedItem, 'Air Balloon');
    assert.equal(pokemon(result.room, 'p2', 'Drifblim').item, null);
    assert.equal(pokemon(result.room, 'p2', 'Drifblim').removedItem, 'Flame Orb');
    assert.equal(pokemon(result.room, 'p2', 'Drifblim').status, 'brn');
    assert.deepEqual(pokemon(result.room, 'p1', 'Thundurus').boosts, {}, 'Actual re-entry must not restore Nasty Plot');
    assert.equal(pokemon(result.room, 'p1', 'Infernape').status, 'tox');
  }
  assert.deepEqual(legacy.last.room.sides, prior.room.sides);
  assert.deepEqual(facts(legacy.last.room), facts(prior.room));
  assert.deepEqual(legacy.last.room.canonicalEvidence.limitations, []);
});

test('actual public Tera and multihit facts survive recovery without inventing hit damage', async () => {
  const { last } = await replay(keys('legacy-uu'));
  const tera = pokemon(last.room, 'p1', 'Mandibuzz');
  assert.equal(tera.teraType, 'Steel'); assert.equal(tera.terastallized, true);
  const fs = facts(last.room);
  assert.deepEqual(fs.filter((fact) => fact.kind === '-hitcount').map((fact) => fact.args[1]), ['6', '3']);
  assert.deepEqual(fs.filter((fact) => fact.kind === '-terastallize').map((fact) => fact.args[1]), ['Steel']);
  const triple = fs.findIndex((fact) => fact.kind === 'move' && fact.args[1] === 'Triple Axel');
  const count = fs.findIndex((fact, i) => i > triple && fact.kind === '-hitcount');
  assert.deepEqual(fs.slice(triple, count).filter((fact) => fact.kind === '-damage').map((fact) => fact.args[1]), ['90/100', '70/100', '40/100']);
  assert.equal(fs.filter((fact) => fact.kind === '-miss').length, 1, 'The next Triple Axel missed; no extra hitcount');
  assert.ok(fs.filter((fact) => ['-hitcount', '-terastallize'].includes(fact.kind)).every((fact) => fact.source.channel === 'protocol'));
});

test('spectator supplemental p1 and 1000/1000 placeholders create neither private HP nor actions', async () => {
  for (const scenario of fixture.cases) {
    const { results } = await replay(scenario.keys);
    for (const result of results) assertSpectator(result);
  }
  for (const key of ['preact-uu-recovery-1', 'legacy-uu-recovery-16']) {
    const { last } = await replay([key]); // Explicit cold recovery, not a protocol relabel.
    assertSpectator(last);
    const state = JSON.parse(captured(key).observation.data.split('\n').find((line) => line.startsWith('|sso-state|'))!.slice(11));
    const unknown = state.pokemon.filter((mon: any) => mon.condition === '1000/1000');
    assert.ok(unknown.length > 0);
    for (const mon of unknown) {
      const reduced = pokemon(last.room, mon.side, mon.details.split(',')[0]);
      assert.notEqual(reduced.conditionText, '1000/1000');
      assert.equal(reduced.stats?.hp, undefined);
    }
    // Some stale placeholders concern already switched-in mons: those retain
    // public HP. The unrevealed Sinistcha has no HP evidence at all.
    assert.equal(pokemon(last.room, 'p1', 'Sinistcha').hpPercent, null);
    const observation = captured(key).observation;
    const withoutSupplement = await new DecisionEngine().ingest({ ...observation,
      data: observation.data.split('\n').map((line) => line.startsWith('|sso-state|') ? '' : line).join('\n') });
    assert.deepEqual(last.room.sides, withoutSupplement.room.sides);
    assert.ok(facts(last.room).every((fact) => fact.source.channel === 'recovery'));
  }
});

test('equivalent recorded client prefixes agree on public facts and roster, not private snapshots', async () => {
  for (const comparison of fixture.comparisons) {
    const projections = [];
    for (const id of [comparison.left, comparison.right]) {
      const engine = new DecisionEngine(); let result;
      for (const key of keys(id)) {
        const original = captured(key).observation;
        const lines = original.data.split('\n'), boundary = lines.indexOf(comparison.through);
        // This is an explicit comparison-only prefix, not the whole original frame.
        result = await engine.ingest({ ...original, data: (boundary < 0 ? lines : lines.slice(0, boundary + 1)).join('\n') });
        if (boundary >= 0) break;
      }
      assert.ok(result); assertSpectator(result); assertRoster(result.room);
      assert.equal(result.room.turn, Number(comparison.through.split('|')[2]));
      projections.push({
        timeline: facts(result.room).filter((fact) => isCanonicalTimelineLine(`|${fact.kind}|${fact.args.join('|')}`)).map((fact) => ({ kind: fact.kind, args: fact.args, turn: fact.turn })),
        roster: facts(result.room).filter((fact) => fact.kind === 'poke').map((fact) => fact.args),
      });
    }
    assert.deepEqual(projections[0], projections[1], `${comparison.left} / ${comparison.right}`);
  }
});

test('selected real observations retain session, sequence gaps, ordering and idempotence', async () => {
  const engine = new DecisionEngine();
  const init = captured('legacy-uu').observation, next = captured('legacy-uu-turn-10').observation;
  const rotation = captured('legacy-uu-turn-11').observation;
  assert.equal(init.sequence, 2); assert.equal(next.sequence, 4); assert.equal(rotation.sequence, 8);
  assert.equal(init.sessionId, rotation.sessionId, 'Recorder rotation is not a new browser session');
  await engine.ingest(init); const first = await engine.ingest(next);
  const duplicate = await engine.ingest(next);
  assert.equal(duplicate.applied, false); assert.deepEqual(duplicate.room, first.room);
  const outOfOrder = new DecisionEngine(); await outOfOrder.ingest(next);
  await assert.rejects(outOfOrder.ingest(init), /Out-of-order/);
});

test('private captures preserve public fixtures and original protocol ancestry without identifying text', async () => {
  assert.equal(await hashCanonical({ observations: fixture.observations, cases: fixture.cases, comparisons: fixture.comparisons, coverage: fixture.coverage }),
    'sha256:cbb04fc89db08988baf812e455cc1fb8b258b16067a91d29199ab4c55140d662', 'Prior public assertions and data remain unchanged');
  assert.equal(fixture.privateCaptures.length, 2);
  assert.equal(fixture.traces[1]!.bytes, 2926480);
  assert.equal(fixture.traces[1]!.sha256, '933e646bc23bdd3596ca83136c93186e08316028e786dbf4abaf44ed033c18c6');
  assert.equal(fixture.traces[1]!.prefixThrough, '2026-10-18T17:04:25.224Z');
  assert.equal(fixture.traces[1]!.jsonlRows, 155);
  for (const [index, scenario] of fixture.privateCaptures.entries()) {
    assert.equal(scenario.client, 'preact-beta');
    assert.deepEqual(scenario.observations.map((entry) => entry.observation.sequence), index === 0 ? [1, 3, 4, 5, 6, 9] : [1, 2, 3, 4, 5, 13]);
    assert.equal(new Set(scenario.observations.map((entry) => entry.observation.sessionId)).size, 1);
    const engine = new DecisionEngine();
    for (const entry of scenario.observations) {
      const o = observationSchema.parse(entry.observation), p = entry.provenance, lines = o.data.split('\n');
      assert.equal(o.source, 'protocol'); assert.equal(p.trace, 1); assert.match(p.at, /^2026-10-18T17:0[034]:/);
      assert.equal(p.trimAfter, null); assert.equal(lines.length, p.originalLineCount); assert.equal(lines.length, p.retainedLineCount);
      assert.equal(lines[0], `>${o.roomId}`);
      assert.ok(fixture.observations.every((entry) => entry.observation.roomId !== o.roomId && entry.observation.sessionId !== o.sessionId));
      for (const hash of [p.rawDataSha256, p.rawJsonlLineSha256, p.originalObservationIdSha256]) assert.match(hash, /^[a-f\d]{64}$/);
      for (const line of lines.slice(1)) {
        assert.match(line, /^(?:|\|(?:init|title|gametype|player|gen|tier|clearpoke|poke|teampreview|request|win)(?:\|.*)?)$/);
        if (line.startsWith('|title|')) assert.equal(line, '|title|Player 1 vs. Player 2');
        if (line.startsWith('|player|')) assert.match(line, /^\|player\|p[12]\|Player [12]$/);
        if (line.startsWith('|win|')) assert.match(line, /^\|win\|Player [12]$/);
        if (line.startsWith('|request|')) {
          const request = JSON.parse(line.slice(9));
          assert.equal(request.side.name, `Player ${request.side.id[1]}`);
          for (const [i, mon] of request.side.pokemon.entries()) assert.equal(mon.ident, `${request.side.id}: Mon ${i + 1}`);
          assert.equal(request.active, undefined); assert.equal(request.teamPreview, true);
        }
      }
      const result = await engine.ingest(o);
      for (const fact of facts(result.room)) {
        const source = scenario.observations.find((entry) => entry.observation.observationId === fact.source.observationId)!;
        assert.ok(source); assert.equal(fact.source.channel, fact.kind === 'request' ? 'private-request' : source.observation.source);
        assert.equal(fact.source.sequence, source.observation.sequence);
        assert.equal(source.observation.data.split('\n')[fact.source.lineIndex], `|${fact.kind}${fact.args.length ? `|${fact.args.join('|')}` : ''}`);
      }
    }
  }
  assert.equal(fixture.privateCoverage.privatePreviewRequests, true);
  assert.equal(fixture.privateCoverage.privateMoveRequest, false);
  assert.equal(fixture.privateCoverage.privateTeraActionRequest, false);
  assert.equal(fixture.privateCoverage.playedTurn, false);
  assert.equal(fixture.privateCoverage.renderCertificate, false);
});

test('real private preview requests retain exact six-party HP, stats and all 720 team action choices', async () => {
  const expected = [
    ['Fezandipiti', 380, { atk: 218, def: 260, spa: 158, spd: 319, spe: 234 }],
    ['Donphan', 383, { atk: 308, def: 332, spa: 140, spd: 156, spe: 141 }],
    ['Arcanine-Hisui', 331, { atk: 329, def: 196, spa: 203, spd: 197, spe: 306 }],
    ['Slowking', 394, { atk: 155, def: 256, spa: 236, spd: 286, spe: 58 }],
    ['Thundurus', 299, { atk: 239, def: 177, spa: 349, spd: 196, spe: 353 }],
    ['Mamoswine', 361, { atk: 359, def: 196, spa: 158, spd: 157, spe: 284 }],
  ] as const;
  for (const [index, scenario] of fixture.privateCaptures.entries()) {
    const engine = new DecisionEngine();
    for (const entry of scenario.observations.slice(0, -1)) await engine.ingest(entry.observation);
    const o = scenario.observations[4]!.observation;
    const { snapshot, identity, room } = await engine.read(o.sessionId, o.roomId);
    assert.ok(snapshot); assert.ok(identity); assertRoster(room);
    assert.equal(snapshot.phase, 'preview'); assert.equal(snapshot.turn, 0);
    assert.equal(room.playerSide, index === 0 ? 'p1' : 'p2'); assert.equal(identity.rqid, index + 2);
    assert.equal(identity.requestKind, 'team_preview'); assert.equal(identity.stateRevision, 2);
    const request = JSON.parse(o.data.split('\n').find((line) => line.startsWith('|request|'))!.slice(9));
    assert.equal(request.side.pokemon.length, 6); assert.equal(snapshot.yourSide.team.length, 6);
    for (const [slot, [species, hp, stats]] of expected.entries()) {
      // Snapshot display order changes when names are aliased; request slots do not.
      const captured = request.side.pokemon[slot];
      const reduced: PokemonSnapshot | undefined = snapshot.yourSide.team.find((mon) => mon.instanceId === `${o.roomId}:${room.playerSide}:private-party:${slot + 1}`);
      assert.ok(reduced);
      assert.equal(captured.details.split(',')[0], species); assert.equal(reduced.species, species);
      assert.equal(captured.condition, `${hp}/${hp}`); assert.equal(reduced.conditionText, captured.condition);
      assert.deepEqual(captured.stats, stats); assert.deepEqual(reduced.stats, { ...stats, hp });
      assert.deepEqual(reduced.knownMoves, captured.moves); assert.equal(captured.moves.length, 4);
      assert.equal(reduced.item, captured.item); assert.equal(reduced.ability, captured.ability);
      assert.equal(reduced.teraType, captured.teraType); assert.equal(reduced.terastallized, false);
      assert.equal(reduced.hpPercent, 100);
      assert.equal(reduced.instanceId, `${o.roomId}:${room.playerSide}:private-party:${slot + 1}`);
    }
    const party = snapshot.yourSide.team.map(({ species, conditionText, stats, knownMoves, item, ability, teraType, terastallized, active, hpPercent }) =>
      ({ species, conditionText, stats, knownMoves, item, ability, teraType, terastallized, active, hpPercent }))
      .sort((a, b) => String(a.species) < String(b.species) ? -1 : String(a.species) > String(b.species) ? 1 : 0);
    assert.equal(await hashCanonical(party), scenario.evaluations[0]!.response.partyHash, 'Matches the captured response party projection');
    const actions = snapshot.legalActions;
    assert.equal(actions.length, 720); assert.equal(new Set(actions.map((action) => action.id)).size, 720);
    for (const action of actions) {
      assert.deepEqual([...action.teamSpec!].sort(), [1, 2, 3, 4, 5, 6]);
      const order = action.teamSpec!.join('');
      const { label, ...structural } = action;
      assert.deepEqual(structural, { id: `team:${order}`, kind: 'team', actorSlot: 1, teamSpec: action.teamSpec, choice: `team ${order}`, legality: 'certain', canUndo: true });
      assert.equal(label, `Lead ${expected[action.teamSpec![0]! - 1]![0]}, slot ${action.teamSpec![0]}; order ${order}`);
    }
    for (let slot = 1; slot <= 6; slot++) assert.equal(actions.filter((action) => action.teamSpec![0] === slot).length, 120);
    assert.equal(actions[0]!.id, 'team:123456'); assert.equal(actions.at(-1)!.id, 'team:654321');
    assert.equal(identity.legalActionSetHash, scenario.evaluations[0]!.response.identity.legalActionSetHash, 'Complete structural ABI matches captured response');
    assert.equal(await hashCanonical(actions.map((action) => action.id).sort()), scenario.evaluations[0]!.response.rankedActionIdsHash);
    assert.notEqual(identity.snapshotHash, scenario.evaluations[0]!.response.identity.snapshotHash, 'Sanitized replay is not the original captured identity');
    assert.deepEqual(await createDecisionIdentity(snapshot), (({ stateRevision, requestKind, ...base }) => base)(identity));
  }
});

test('captured request/evaluation receipts bind exact identity, history and deterministic producer provenance', () => {
  const rows = [[[101, 104, 105], [107, 108, 109]], [[129, 132, 133], [151, 154, 155]]];
  const snapshotHashes = [
    ['1777ad3d82430781a2679862e75482d759a4859f7e8a4d7806eb519250c4a968', '0f39cbab42926a0db1958ad7b230f5392a392fb6a6ca8371b289c3354f04d074'],
    ['6ba48a9214768c6d1a602d20f325971a650a17d73bfa4b2528237e86e23e63a4', 'a84a01c9c7ac237f101c97e84cfaf319777d76f02e8c9536b68358095164c9ac'],
  ];
  for (const [caseIndex, scenario] of fixture.privateCaptures.entries()) for (const [stage, receipt] of scenario.evaluations.entries()) {
    const observation = scenario.observations.find((entry) => entry.key === receipt.observationKey)!;
    const { provenance: p, acknowledgment: ack, request, response } = receipt;
    assert.deepEqual([p.acknowledgment.jsonlLine, p.request.jsonlLine, p.response.jsonlLine], rows[caseIndex]![stage]);
    for (const row of [p.acknowledgment, p.request, p.response]) {
      assert.equal(row.trace, 1); assert.match(row.rawJsonlLineSha256, /^[a-f\d]{64}$/);
      assert.ok(row.jsonlLine <= fixture.traces[1]!.jsonlRows); assert.ok(row.at <= fixture.traces[1]!.prefixThrough);
    }
    assert.equal(p.acknowledgment.requestId, observation.provenance.requestId); assert.equal(p.resultIndex, observation.provenance.observationIndex);
    assert.equal(p.request.requestId, p.response.requestId); assert.ok(p.acknowledgment.at < p.request.at); assert.ok(p.request.at <= p.response.at);
    assert.match(p.originalRoomIdSha256, /^[a-f\d]{64}$/); assert.match(p.originalSessionIdSha256, /^[a-f\d]{64}$/);
    assert.equal(ack.observationId, observation.observation.observationId); assert.equal(ack.acknowledgedSequence, observation.observation.sequence);
    assert.equal(request.sessionId, observation.observation.sessionId); assert.equal(request.identity.roomId, observation.observation.roomId);
    assert.deepEqual(ack.identity, request.identity); assert.deepEqual(request.identity, response.identity);
    assert.equal(request.historyRevision, response.historyRevision); assert.match(response.historyRevision, /^sha256:[a-f\d]{64}$/);
    assert.equal(response.identity.snapshotHash, `sha256:${snapshotHashes[caseIndex]![stage]}`);
    assert.equal(response.identity.legalActionSetHash, stage === 0 ? 'sha256:daa07dc92a5f555f13f5123b12148bb4503f4a73ead0de225135462816cf64a3' : 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
    assert.equal(response.identity.stateRevision, stage + 2); assert.equal(response.identity.rqid, caseIndex + 2);
    assert.equal(response.identity.requestKind, stage === 0 ? 'team_preview' : 'finished');
    assert.equal(response.status, 200); assert.equal(response.contractVersion, 'showdown-decision@1');
    assert.equal(response.engineVersion, 'shwdn2op:sha256:96bf88c344bc6a0286f5f722b6588f361638517b860376a8a61caf95313840ee');
    assert.match(response.resultHash, /^sha256:[a-f\d]{64}$/); assert.ok(response.evaluatedAt <= p.response.at);
    assert.equal(response.turn, 0); assert.equal(response.phase, stage === 0 ? 'preview' : 'finished');
    assert.equal(ack.phase, response.phase); assert.equal(ack.turn, response.turn);
    assert.equal(response.sideId, caseIndex === 0 ? 'p1' : 'p2'); assert.equal(response.actionable, stage === 0);
    assert.equal(response.legalActionCount, stage === 0 ? 720 : 0); assert.equal(response.rankedActionCount, response.legalActionCount);
    assert.equal(response.topActionId, stage === 0 ? 'team:123456' : null);
  }
});

test('real server terminal clears every action at turn zero and invalidates the offline preview identity', async () => {
  for (const scenario of fixture.privateCaptures) {
    const engine = new DecisionEngine();
    for (const entry of scenario.observations.slice(0, -1)) await engine.ingest(entry.observation);
    const terminal = scenario.observations.at(-1)!.observation;
    const preview = await engine.read(terminal.sessionId, terminal.roomId);
    assert.ok(preview.identity);
    const finished = await engine.ingest(terminal), receipt = scenario.evaluations[1]!.response;
    assert.ok(finished.snapshot); assert.ok(finished.identity);
    assert.equal(finished.snapshot.phase, 'finished'); assert.equal(finished.snapshot.turn, 0);
    assert.equal(finished.identity.requestKind, 'finished'); assert.equal(finished.identity.rqid, preview.identity.rqid);
    assert.equal(finished.identity.stateRevision, preview.identity.stateRevision + 1);
    assert.notEqual(finished.identity.snapshotHash, preview.identity.snapshotHash);
    assert.equal(finished.identity.legalActionSetHash, receipt.identity.legalActionSetHash);
    assert.deepEqual(finished.room.legalActions, []); assert.deepEqual(finished.snapshot.legalActions, []);
    assert.equal(receipt.rankedActionCount, 0); assert.equal(receipt.rankedActionIdsHash, await hashCanonical([]));
    assert.equal(receipt.partyHash, scenario.evaluations[0]!.response.partyHash, 'Captured terminal retained the exact private party projection');
    assert.equal(facts(finished.room).filter((fact) => fact.kind === 'win').length, 1);
    assert.ok(facts(finished.room).every((fact) => !['turn', 'start', 'switch', 'move', '-terastallize'].includes(fact.kind)));
    assert.match(terminal.data, /\|win\|Player [12]$/);
    assert.deepEqual(finished.snapshot.yourSide.team, preview.snapshot!.yourSide.team);
    await assert.rejects(engine.assertCurrent(terminal.sessionId, preview.identity), /no longer current/);
    await engine.assertCurrent(terminal.sessionId, finished.identity);
    const duplicate = await engine.ingest(terminal);
    assert.equal(duplicate.applied, false); assert.deepEqual(duplicate.identity, finished.identity);
    const second = new DecisionEngine();
    for (const entry of scenario.observations) await second.ingest(entry.observation);
    assert.deepEqual((await second.read(terminal.sessionId, terminal.roomId)).identity, finished.identity, 'Offline reconstruction is deterministic');
  }
});

test('canonical full-HP Sturdy preview retains raw pressure without a KO assertion or KO reward', async () => {
  const { evaluateDecision } = await import('../state/decisionEnvelope.js');
  const { createEphemeralIntelEvaluationContext } = await import('../history/opponentIntelStore.js');
  const engine = new DecisionEngine({ source: 'owned_offline_simulator' });
  const request = { rqid: 1, active: [{ moves: [{ move: 'Surf', id: 'surf', pp: 24, disabled: false }] }],
    side: { id: 'p1', pokemon: [{ ident: 'p1: Inteleon', details: 'Inteleon, M', condition: '281/281', active: true,
      stats: { atk: 185, def: 166, spa: 349, spd: 167, spe: 372 }, moves: ['surf'], baseAbility: 'torrent', ability: 'torrent', item: 'choicespecs' }] } };
  // Minimal native-audit-equivalent capture; Sturdy knowledge is an explicit
  // controlled public reveal, not an organic preactivation event claim.
  const current = await engine.ingest({ sessionId: 'survival', roomId: 'battle-gen9uu-survival-consumer', observationId: '1', sequence: 1, source: 'protocol',
    data: `>battle-gen9uu-survival-consumer\n|tier|[Gen 9] UU\n|poke|p1|Inteleon, M\n|poke|p2|Donphan, M\n|start\n|switch|p1a: Inteleon|Inteleon, M|281/281\n|switch|p2a: Donphan|Donphan, M|100/100\n|-ability|p2a: Donphan|Sturdy\n|turn|1\n|request|${JSON.stringify(request)}` });
  const envelope = await evaluateDecision(engine, 'survival', current.identity!, await createEphemeralIntelEvaluationContext());
  assert.equal(envelope.semantic.capabilities.actionable, true);
  const preview = envelope.semantic.localIntel.playerDamagePreview!.find((entry) => !entry.terastallize)!;
  assert.ok(preview.bands.every((band) => band.minPercent! > 100), 'raw offensive ranges remain unchanged above HP');
  assert.ok(preview.bands.every((band) => band.immediate.ko === 'no_ko'));
  assert.ok(preview.bands.every((band) => band.immediate.maxHpLossPercent! < 100));
  assert.doesNotMatch(preview.summary, /KOs current HP|guaranteed KO/);
  const action = envelope.semantic.localIntel.selfActionRecommendation!.rankedActions[0]!;
  assert.ok(!action.reasons.some((reason) => /can KO|clean KO|KO roll/.test(reason)));
  assert.deepEqual(envelope.semantic.snapshot.legalActions, current.snapshot!.legalActions);
});
