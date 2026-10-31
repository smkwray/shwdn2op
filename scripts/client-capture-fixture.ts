/** Reproduce only the explicitly selected actual Chrome observations below.
 * Run: node --import tsx scripts/client-capture-fixture.ts [--check]
 * Reads fixed, hash-bound prefixes of /tmp traces; never starts a server or reads history.
 * Raw IDs are printed to stdout for local provenance, never retained in the fixture.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { createDecisionIdentity, hashCanonical } from '../apps/extension/lib/decision-identity.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const target = new URL('../examples/chrome-client-observations.json', import.meta.url);
const sources = [
  { file: 'shwdn2op-chrome-capture.jsonl', bytes: 15550420, sha256: '69a418f4a426296eb98277d62952d7caac44a3049b6c56bb66170b5bd89b26a0', recorder: 'shwdn2op-capture-companion-v1.mts' },
  // Complete response to the final probe's first terminal evaluation, not later polling.
  { file: 'shwdn2op-chrome-capture-2.jsonl', bytes: 2926480, sha256: '933e646bc23bdd3596ca83136c93186e08316028e786dbf4abaf44ed033c18c6', recorder: 'shwdn2op-capture-companion.mts' },
];
// Exact original observation-ID hashes, not a search for convenient mechanics.
const selected: Array<[string, number, number, string, string?]> = [
  ['legacy-ou', 0, 4, '60fe57d2f0d0f1a3d90a977fb7e938c2552974f3aff3a2c8e5389fa7bfd19ef1'],
  ['preact-uu-preview', 0, 66, '776aa674930411587ca2d8e94f2df00e355d6d325e4e68b81f4e3f4651de1746'],
  ['preact-ou-prefix', 0, 74, '3bcafc6ecf338d9b18e0a946e7a71deccc8face6895f9b663a4a0941deb52f27', '|turn|12'],
  ['preact-uu-start', 0, 78, '30542176013d881078105c9cfa253e765f68255b77577ac5099444e0d6e74c69'],
  ['preact-uu-recovery-1', 0, 80, '87d991e0239b92ec472eb6059ed73e65a2e4300b7d0e30ef2996ca6739ff6107'],
  ['preact-uu-turn-2', 0, 88, 'a6395236611c596e1fa0300044159520c3322dca3f8bc88df9e5ea8df3073730'],
  ['preact-uu-recovery-2', 0, 90, 'e049cd75cef542bd9a8bd19bdc28a4722b4258f4809d4c954050575aed160671'],
  ['preact-uu-turn-3', 0, 112, '38a6fd46883d1717484ae72e31b24833aecf21cd147e41f287b26e2f34b059c8'],
  ['legacy-uu', 0, 208, 'a8b3f03e06d41e8c4a7431475dca8923ac06668dbabe9773c38b4492468b1fe4'],
  ['legacy-uu-turn-10', 0, 212, '755625f8d96ae10235a607bb9bdcd68160dd423c979d4d5894bfdc11e34cf8d1'],
  ['legacy-uu-turn-11', 1, 2, '4d85114c6c47626869e3ce0b0cf8013d49bd0a1e5ff3b989710695a8e6b70d70'],
  ['legacy-uu-faint', 1, 8, 'cff4b005140dfcc99ec511478bf9dda364c5b450e93828999d320a2e1bae95cc'],
  ['legacy-uu-turn-12', 1, 16, '4402525fe652ffe8c95b98fdcd0bcb3f80a69a3eeaceb9f925ecd68190598a46'],
  ['legacy-uu-turn-13', 1, 20, 'aef3d758a08371d673cbf73687658847d5af1fe28784f64a88466416a4af180a'],
  ['legacy-uu-turn-14', 1, 28, '5cd54cc781f30e8526efbc91d350c578fb587ae35e9878b83cc93bb89d41ed2d'],
  ['legacy-uu-turn-15', 1, 38, '9dc354c433d95333d435fd4d3e16e81b626fd9f3397c1b8254dd5abb150a38bb'],
  ['legacy-uu-faint-2', 1, 48, '475c20390632c77a6c7b49a6633dbf75d6eaa6c75203d1a0e08a2648c3570a08'],
  ['legacy-uu-turn-16', 1, 54, '44cbe7fbce0a4414047ef6e6c580aeb1331faa87d3b433523276ce18289386d2'],
  ['legacy-uu-recovery-16', 1, 56, '1f67429574c88619e1aff8ead3ffd48eeef79bfb4aa64a4c306bfd6c085de624'],
];
const traces: Array<{ lines: string[]; rows: any[]; provenance: (typeof sources)[number] & {
  recorderSha256: string; prefixThrough: string; jsonlRows: number;
} }> = [];
for (const source of sources) {
  const fd = await open(`/tmp/${source.file}`, 'r');
  const raw = Buffer.alloc(source.bytes);
  try {
    let offset = 0;
    while (offset < raw.length) {
      const { bytesRead } = await fd.read(raw, offset, raw.length - offset, offset);
      assert.ok(bytesRead, 'Truncated raw trace'); offset += bytesRead;
    }
  } finally { await fd.close(); }
  assert.equal(raw.at(-1), 10); assert.equal(sha256(raw), source.sha256);
  const lines = raw.toString('utf8').trimEnd().split('\n');
  const rows = lines.map((line) => JSON.parse(line));
  traces.push({ lines, rows, provenance: { ...source, recorderSha256: sha256(await readFile(`/tmp/${source.recorder}`)),
    prefixThrough: rows.at(-1).at, jsonlRows: rows.length } });
}
const aliases = new Map<string, string>();
function alias(domain: string, raw: string) {
  const key = `${domain}:${raw}`;
  if (!aliases.has(key)) aliases.set(key, `${domain}-${[...aliases.keys()].filter((key) => key.startsWith(`${domain}:`)).length + 1}`);
  return aliases.get(key)!;
}
// An explicit allowlist removes free-text/chat, join/leave, timers, timestamps,
// ratings and rule text. Removed lines stay blank to preserve raw line indexes.
const allowed = new Set(('init title player tier gametype teamsize poke start clearpoke teampreview turn switch drag replace move cant faint -damage -heal -status -curestatus -boost -unboost -setboost -clearboost -clearallboost -start -end -ability -endability -item -enditem -terastallize -activate detailschange -formechange -transform -weather -fieldstart -fieldend -sidestart -sideend -supereffective -resisted -immune -crit -fail -miss -hitcount -singleturn upkeep sso-state').split(' '));
const playerAliases = new Map<string, string>();
function sanitizeObservation(key: string, trace: number, row: number, idSha256: string, trimAfter?: string, observationIndex = 0, privateCapture = false) {
  const record = traces[trace]!.rows[row - 1];
  assert.equal(record.kind, 'request'); assert.equal(record.url, '/v1/observations');
  const original = record.body.observations[observationIndex];
  assert.equal(sha256(original.observationId), idSha256);
  const roomId = alias('battle-room', original.roomId);
  const sessionId = alias('session', original.sessionId);
  const [capture, ordinal] = original.observationId.split(':');
  const observationId = `${alias('capture', capture)}:${ordinal}:${roomId}`;
  const mon = (side: string, name: string) => `Mon ${alias(`${roomId}-${side}-mon`, name).split('-').at(-1)}`;
  const originalLines: string[] = original.data.split('\n');
  if (!privateCapture) assert.ok(!originalLines.some((line) => line.startsWith('|request|')), 'No private request in public spectator fixtures');
  const monIdent = (ident: string) => ident.replace(/^(p[12])([a-z])?:\s*(.*)$/, (_: string, side: string, slot: string, name: string) => `${side}${slot ?? ''}: ${mon(side, name)}`);
  const end = trimAfter ? originalLines.indexOf(trimAfter) + 1 : originalLines.length;
  assert.ok(end > 0, 'Missing declared canonical boundary');
  const data = originalLines.slice(0, end).map((line, index) => {
    if (index === 0) { assert.equal(line, `>${original.roomId}`); return `>${roomId}`; }
    const tag = line.split('|')[1] ?? '';
    if (!allowed.has(tag) && !(privateCapture && ['gen', 'request', 'win'].includes(tag))) return '';
    if (tag === 'title') return '|title|Player 1 vs. Player 2';
    if (tag === 'player') {
      const [, , side, name] = line.split('|'); assert.match(side!, /^p[12]$/);
      playerAliases.set(`${roomId}:${name}`, `Player ${side![1]}`);
      return `|player|${side}|Player ${side![1]}`;
    }
    if (tag === 'win') {
      const winner = playerAliases.get(`${roomId}:${line.slice(5)}`);
      assert.ok(winner, 'Winner must match an observed player'); return `|win|${winner}`;
    }
    if (tag === 'request') {
      const request = JSON.parse(line.slice(9));
      assert.deepEqual(Object.keys(request).sort(), ['rqid', 'side', 'teamPreview']);
      assert.deepEqual(Object.keys(request.side).sort(), ['id', 'name', 'pokemon']);
      assert.equal(request.teamPreview, true); assert.equal(request.active, undefined);
      assert.match(request.side.id, /^p[12]$/); assert.equal(request.side.pokemon.length, 6);
      request.side.name = `Player ${request.side.id[1]}`;
      for (const pokemon of request.side.pokemon) {
        assert.deepEqual(Object.keys(pokemon).sort(), ['ability', 'active', 'baseAbility', 'commanding', 'condition', 'details', 'ident', 'item', 'moves', 'pokeball', 'reviving', 'stats', 'teraType', 'terastallized']);
        pokemon.ident = monIdent(pokemon.ident);
      }
      return `|request|${JSON.stringify(request)}`;
    }
    if (tag === 'sso-state') {
      const state = JSON.parse(line.slice(11));
      for (const side of Object.keys(state.sideNames ?? {})) state.sideNames[side] = `Player ${side[1]}`;
      for (const pokemon of state.pokemon ?? []) {
        if (pokemon.ident) pokemon.ident = pokemon.ident.replace(/^(p[12])([a-z])?:\s*(.*)$/, (_: string, side: string, slot: string, name: string) => `${side}${slot ?? ''}: ${mon(side, name)}`);
      }
      return `|sso-state|${JSON.stringify(state)}`;
    }
    return line.replace(/\b(p[12])([a-z])?: ([^|\n]+)/g, (_: string, side: string, slot: string, name: string) =>
      `${side}${slot ?? ''}: ${slot ? mon(side, name) : `Player ${side[1]}`}`);
  }).join('\n');
  const client = key.startsWith('preact') ? 'preact-beta' : 'default-legacy';
  console.log(JSON.stringify({ key, client, at: record.at, originalObservationId: original.observationId, originalSessionId: original.sessionId,
    sequence: original.sequence, source: original.source, rawDataSha256: sha256(original.data), rawTraceSha256: sources[trace]!.sha256 }));
  return { key, client, provenance: { trace, jsonlLine: row, observationIndex, requestId: record.id, at: record.at,
    originalObservationIdSha256: idSha256, rawJsonlLineSha256: sha256(traces[trace]!.lines[row - 1]!), rawDataSha256: sha256(original.data),
    originalLineCount: originalLines.length, retainedLineCount: end, trimAfter: trimAfter ?? null },
    observation: { observationId, sessionId, sequence: original.sequence, roomId, source: original.source, data } };
}
const observations = selected.map(([key, trace, row, idSha256, trimAfter]) => sanitizeObservation(key, trace, row, idSha256, trimAfter));

// Keep private observations outside the unchanged public cases. These exact
// selections retain init, format, both players, roster, request and server win.
const privateSelections = [
  { id: 'preact-private-immediate-forfeit', coverage: 'Preview-only immediate forfeit; no lead or turn selected.',
    rows: [
      [100, 0, '808b6cd60fcb099019772b4c78405c588862d915c38811fed32243574536b5ea'],
      [100, 2, 'c8e4516b99b85c5a77c186143d80bffc66fe943d1650600f02aaf56466a66644'],
      [100, 3, '19f8980976cb6f7dba88db22b192e728842b915e54ecb47067d437886581da45'],
      [100, 4, '79c560f27b7e2672b51a10bec6e6b411f18a77e78cc714976924d07c42d293f4'],
      [100, 5, 'cd24c5081ac616be662e4b2d4ca20fef2ad4dd200aaaaf796b50c1566e108e68'],
      [106, 1, 'b8c64fec4f6e83654279159b4db904c5bf64385562fa18e718f912081851354b'],
    ], evaluations: [[101, 5, 104, 105], [107, 1, 108, 109]] },
  { id: 'preact-private-final-probe', coverage: 'Manual UI observation, not in the trace: Fezandipiti lead selected, opponent never selected. Forfeited before deadline; server win at turn 0. Inbound trace does not prove UI selection.',
    rows: [
      [128, 0, 'a4eead17a44cff34a7d1eb516f15d1f5f140b3088ad31a3cde148bc5e34e0a6a'],
      [128, 1, '9ae124c82bb5cfd1f9f64c7a169181018c0962aa8b1daba8b50397ff66932f98'],
      [128, 2, 'a93893b173b1ec3867f6449b652fa2a4c89820c0be88bb5356c625dbfd4fdac7'],
      [128, 3, '026fdb8d24e14a2155db73653d1210276f13cdd6397332a1712609aa599e212c'],
      [128, 4, '028c4a993b3a5eb6d4cc6b61089c29c7aa80a7dfb948414467db7e3b866fb7cf'],
      [150, 1, 'c4fea87214e59443a8a02299a09341ae5ed9bcb60a5cbb87d00195050c2117b0'],
    ], evaluations: [[129, 4, 132, 133], [151, 1, 154, 155]] },
] as const;
const rowProvenance = (line: number) => {
  const row = traces[1]!.rows[line - 1];
  return { trace: 1, jsonlLine: line, requestId: row.id, at: row.at, rawJsonlLineSha256: sha256(traces[1]!.lines[line - 1]!) };
};
const privateCaptures = [];
for (const selection of privateSelections) {
  const privateObservations = selection.rows.map(([row, index, hash], i) => sanitizeObservation(`preact-private-${privateCaptures.length + 1}-${i + 1}`, 1, row, hash, undefined, index, true));
  const evaluations = [];
  for (const [ackLine, resultIndex, requestLine, responseLine] of selection.evaluations) {
    const ackRow = traces[1]!.rows[ackLine - 1], ack = ackRow.body.results[resultIndex];
    const requestRow = traces[1]!.rows[requestLine - 1], request = requestRow.body;
    const responseRow = traces[1]!.rows[responseLine - 1], response = responseRow.body;
    const semantic = response.envelope.semantic, snapshot = semantic.snapshot;
    const observation = privateObservations.find((entry) => entry.provenance.originalObservationIdSha256 === sha256(ack.observationId));
    assert.ok(observation);
    const original = traces[1]!.rows[observation.provenance.jsonlLine - 1].body.observations[observation.provenance.observationIndex];
    assert.equal(ackRow.kind, 'response'); assert.equal(ackRow.url, '/v1/observations'); assert.equal(ackRow.status, 200);
    assert.equal(ackRow.id, observation.provenance.requestId); assert.equal(ack.acknowledgedSequence, original.sequence);
    assert.equal(requestRow.kind, 'request'); assert.equal(responseRow.kind, 'response');
    assert.equal(requestRow.url, '/v1/evaluate'); assert.equal(responseRow.url, requestRow.url);
    assert.equal(requestRow.id, responseRow.id); assert.equal(responseRow.status, 200);
    assert.equal(request.sessionId, original.sessionId); assert.equal(request.identity.roomId, original.roomId);
    assert.deepEqual(ack.identity, request.identity); assert.deepEqual(request.identity, semantic.identity);
    assert.equal(ackRow.body.historyRevision, request.historyRevision); assert.equal(request.historyRevision, semantic.historyRevision);
    assert.deepEqual(await createDecisionIdentity(snapshot), (({ stateRevision, requestKind, ...identity }) => identity)(semantic.identity));
    assert.equal(await hashCanonical(semantic), response.envelope.resultHash);
    const actions = snapshot.legalActions, ranked = semantic.localIntel.selfActionRecommendation?.rankedActions ?? [];
    const preview = semantic.identity.requestKind === 'team_preview';
    assert.equal(snapshot.turn, 0); assert.equal(snapshot.phase, preview ? 'preview' : 'finished');
    assert.equal(actions.length, preview ? 720 : 0); assert.equal(ranked.length, actions.length);
    assert.deepEqual(ranked.map((action: any) => action.actionId).sort(), actions.map((action: any) => action.id).sort());
    const identity = (value: any) => ({ ...value, roomId: observation.observation.roomId });
    evaluations.push({
      observationKey: observation.key,
      provenance: { acknowledgment: rowProvenance(ackLine), resultIndex, request: rowProvenance(requestLine), response: rowProvenance(responseLine),
        originalRoomIdSha256: sha256(original.roomId), originalSessionIdSha256: sha256(original.sessionId) },
      acknowledgment: { ...ack, observationId: observation.observation.observationId, identity: identity(ack.identity) },
      request: { ...request, sessionId: observation.observation.sessionId, identity: identity(request.identity) },
      response: { status: responseRow.status, evaluatedAt: response.evaluatedAt, contractVersion: semantic.contractVersion,
        engineVersion: semantic.engineVersion, identity: identity(semantic.identity), historyRevision: semantic.historyRevision,
        resultHash: response.envelope.resultHash, phase: snapshot.phase, turn: snapshot.turn, sideId: snapshot.rawRequestSummary.sideId,
        actionable: semantic.capabilities.actionable, legalActionCount: actions.length, rankedActionCount: ranked.length,
        topActionId: semantic.localIntel.selfActionRecommendation?.topActionId ?? null,
        rankedActionIdsHash: await hashCanonical(ranked.map((action: any) => action.actionId)),
        partyHash: await hashCanonical(snapshot.yourSide.team.map(({ species, conditionText, stats, knownMoves, item, ability, teraType, terastallized, active, hpPercent }: any) =>
          ({ species, conditionText, stats, knownMoves, item, ability, teraType, terastallized, active, hpPercent }))
          .sort((a: any, b: any) => a.species < b.species ? -1 : a.species > b.species ? 1 : 0)),
      },
    });
  }
  privateCaptures.push({ id: selection.id, client: 'preact-beta', coverage: selection.coverage, observations: privateObservations, evaluations });
}
const fixture = {
  schemaVersion: 1,
  purpose: 'Actual Chrome public spectator and separate private preview/terminal capture regression fixtures; not training samples or acceptance certificates.',
  producer: { path: 'scripts/client-capture-fixture.ts', sha256: sha256(await readFile(new URL(import.meta.url))) },
  captureContext: {
    browser: 'Actual Google Chrome browser 2',
    clientAttribution: 'Manual capture-session UI observation: default legacy OU at 16:47 UTC; actual /beta/ Preact entry at 16:49, then UU and OU spectator rooms; root reload around 16:52:15 returned to default legacy UU. Client labels come from this UI observation, not URL inference or trace payloads.',
    betaEntry: 'https://play.pokemonshowdown.com/beta/',
    routeCaveat: 'Preact rewrites the route to root; route alone does not identify the client. SPA room changes changed captureSession; retain those session boundaries.',
    history: 'Recorders used isolated temporary history; producer and tests do not access any history.',
  },
  traces: traces.map((trace) => trace.provenance),
  sanitization: 'Player names, rooms, capture/session UUIDs and all mon identifiers are aliased consistently. Removed free-text/chat/join/leave/timer/timestamp/rating/avatar lines or fields; blank lines preserve original source indexes. Protocol mechanics and supplemental sso-state values otherwise unchanged. Capture receipt UTC times retained only in provenance.',
  coverage: {
    privateRequests: false, rqid: false, ownLegalActions: false, privateBattleSnapshotParity: false, renderCertificate: false, battleCompletion: false,
    statusCure: 'Absent from frozen traces; test observed toxic/burn preservation only, not cure/non-resurrection after cure.',
    recovery: 'Lower authority. sso-state p1 hints, stale conditions and 1000/1000 placeholders are captured claims, not private HP or own-side truth.',
    omissions: 'Selected observations only: repeated recovery, nonmechanical frames and unrelated requests/responses omitted. Original sequence gaps and partial turns retained. Second trace is a fixed complete-row prefix and may continue appending.',
  },
  cases: [
    { id: 'legacy-ou', keys: ['legacy-ou'], coverage: 'Protocol backlog through partial turn 12.' },
    { id: 'preact-ou', keys: ['preact-ou-prefix'], coverage: 'Actual protocol backlog trimmed after turn 12 for common-prefix comparison; original frame reached turn 22.' },
    { id: 'preact-uu-session-gap', keys: ['preact-uu-preview', 'preact-uu-start', 'preact-uu-recovery-1'], coverage: 'Original preview belongs to a different session. New session starts without roster; later recovery contains its missing prefix and matching protocol suffix. Recovered roster remains recovery authority; do not join sessions.' },
    { id: 'preact-uu-cold', keys: ['preact-uu-recovery-1', 'preact-uu-turn-2', 'preact-uu-recovery-2', 'preact-uu-turn-3'], coverage: 'Explicit cold replay starting from a real recovery, omitting its earlier same-session protocol; recovered roster/turn 1 remains recovery, subsequent turns 2/3 remain protocol.' },
    { id: 'legacy-uu', keys: observations.filter((entry) => entry.key.startsWith('legacy-uu')).map((entry) => entry.key), coverage: 'Protocol backlog through turn 9, selected subsequent public protocol through turn 16, then matching recovery across the recorder rotation.' },
  ],
  comparisons: [
    { left: 'legacy-ou', right: 'preact-ou', through: '|turn|12' },
    { left: 'legacy-uu', right: 'preact-uu-cold', through: '|turn|3' },
  ],
  comparisonScope: 'Trim both comparison inputs at the declared canonical turn boundary; compare public facts and roster only, ignoring transport metadata and retaining original authority separately. No whole-frame or private BattleSnapshot parity claim.',
  observations,
  privateCoverage: {
    privatePreviewRequests: true, pairedEvaluations: true, terminalAtTurnZero: true, privateMoveRequest: false, privateTeraActionRequest: false,
    renderCertificate: false, playedTurn: false,
    identityScope: 'Receipt IDs are aliases; identity/result hashes, engineVersion and historyRevision are exact captured values verified against raw responses, not sanitized replay hashes. Party hashes sort the nonidentifying projection by species.',
    reconstruction: 'Tests replay selected sanitized protocol in memory. Omitted recovery/no-op frames and full envelopes remain in the local trace. Recomputed identities/actions are offline reconstruction, not recaptured evaluations or UI proof.',
    limits: 'Team move names/Tera types are captured; private move/Tera actions are not. Public cases remain spectator-only. No full-match or private cross-client parity claim.',
  },
  privateCaptures,
};
const output = JSON.stringify(fixture, null, 1) + '\n';
assert.ok(Buffer.byteLength(output) < 80_000, `Keep the single fixture below 80 KB (${Buffer.byteLength(output)} bytes)`);
assert.doesNotMatch(output, /[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|battle-gen9(?:ou|uu)-\d+/i);
for (const selection of privateSelections) for (const [row, index] of selection.rows) {
  const original = traces[1]!.rows[row - 1].body.observations[index];
  const names = original.data.split('\n').filter((line: string) => line.startsWith('|player|')).map((line: string) => line.split('|')[3]);
  for (const value of [original.roomId, original.sessionId, original.observationId, ...names]) {
    assert.ok(!output.includes(JSON.stringify(value).slice(1, -1)), 'Raw private identifier leaked');
  }
}
if (process.argv.includes('--check')) assert.equal(await readFile(target, 'utf8'), output);
else await writeFile(target, output);
console.log(JSON.stringify({ fixture: target.pathname, bytes: Buffer.byteLength(output), producer: fixture.producer, traces: fixture.traces }));
