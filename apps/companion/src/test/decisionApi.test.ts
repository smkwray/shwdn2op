import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import vm from "node:vm";
import { buildAnalysisPrompt } from "../prompting/analysisPrompt.js";
import type { DelayedDamagePreview, LocalIntelSnapshot } from "../types.js";
import { createDecisionIdentity } from "../../../extension/lib/decision-identity.js";
import { battleSnapshotSchema, pokemonSnapshotSchema, legalActionSchema, analyzeRequestSchema, observeSnapshotRequestSchema } from "../schema.js";

const store = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-decision-api-"));
process.env.LOCAL_INTEL_STORE_PATH = path.join(store, "intel.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(store, "curated.json");
const { buildServer } = await import("../server.js");
after(() => fs.rm(store, { recursive: true, force: true }));

test("published snapshot schema matches runtime fields, requiredness and Pokemon nullability", async () => {
  const published = JSON.parse(await fs.readFile(new URL("../../../../packages/schemas/battle-snapshot.schema.json", import.meta.url), "utf8"));
  for (const [definition, runtime] of [[published, battleSnapshotSchema],
    [published.$defs.pokemonSnapshot, pokemonSnapshotSchema], [published.$defs.legalAction, legalActionSchema]] as const) {
    assert.deepEqual(Object.keys(definition.properties).sort(), Object.keys(runtime.shape).sort());
    assert.deepEqual([...definition.required].sort(), Object.entries(runtime.shape)
      .filter(([, field]) => !field.isOptional()).map(([name]) => name).sort());
    assert.equal(definition.type, "object");
  }
  const active = published.$defs.sideSnapshot.properties.active;
  assert.ok(active.anyOf.some((branch: { $ref?: string }) => branch.$ref === "#/$defs/pokemonSnapshot"));
  assert.equal(active.anyOf.some((branch: { type?: string }) => branch.type === "null"),
    battleSnapshotSchema.shape.yourSide.shape.active.isNullable());
  assert.equal(published.$defs.sideSnapshot.properties.team.items.$ref, "#/$defs/pokemonSnapshot");
});

test("HTTP parsing rejects invalid input and enforces the byte limit without history writes", async () => {
  const app = buildServer();
  const history = async () => fs.readFile(process.env.LOCAL_INTEL_STORE_PATH!, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const before = await history();
  try {
    for (const payload of ["{", "null", "[]", "{}", '"text"', '{"observations":"wrong"}',
      '{"__proto__":{"polluted":true},"observations":[]}']) {
      const response = await app.inject({ method: "POST", url: "/v1/observations",
        headers: { "content-type": "application/json" }, payload });
      assert.equal(response.statusCode, 400, response.body);
    }
    const text = await app.inject({ method: "POST", url: "/api/observe-snapshot",
      headers: { "content-type": "text/plain" }, payload: '{"snapshot":{}}' });
    assert.equal(text.statusCode, 400);
    const unsupported = await app.inject({ method: "POST", url: "/v1/observations",
      headers: { "content-type": "application/xml" }, payload: "<observations/>" });
    assert.equal(unsupported.statusCode, 415);

    const limit = 1_048_576;
    const overhead = Buffer.byteLength(JSON.stringify({ padding: "" }));
    for (const [bytes, status] of [[limit, 400], [limit + 1, 413]] as const) {
      const payload = JSON.stringify({ padding: "x".repeat(bytes - overhead) });
      assert.equal(Buffer.byteLength(payload), bytes);
      const response = await app.inject({ method: "POST", url: "/v1/observations",
        headers: { "content-type": "application/json" }, payload });
      assert.equal(response.statusCode, status, response.body);
    }
    const multibyte = JSON.stringify({ padding: "é".repeat((limit - overhead) / 2 + 1) });
    assert.ok(multibyte.length < limit && Buffer.byteLength(multibyte) > limit);
    const tooLarge = await app.inject({ method: "POST", url: "/v1/observations",
      headers: { "content-type": "application/json" }, payload: multibyte });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(await history(), before);
  } finally {
    await app.close();
  }
});

test("Showdown and extension JSON preflights retain their HTTP contract", async () => {
  const app = buildServer();
  try {
    for (const origin of ["https://play.pokemonshowdown.com", `chrome-extension://${"a".repeat(32)}`]) {
      const response = await app.inject({ method: "OPTIONS", url: "/v1/observations", headers: {
        origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type"
      } });
      assert.equal(response.statusCode, 204, response.body);
      assert.equal(response.headers["access-control-allow-origin"], origin);
      assert.match(String(response.headers["access-control-allow-methods"]), /POST/);
      assert.match(String(response.headers["access-control-allow-headers"]), /content-type/i);
    }
    const incomplete = await app.inject({ method: "OPTIONS", url: "/v1/observations",
      headers: { origin: "https://play.pokemonshowdown.com" } });
    assert.equal(incomplete.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("pending attack facts affect canonical state identity but cannot be injected through legacy snapshots", async () => {
  const snapshot = battleSnapshotSchema.parse(JSON.parse(await fs.readFile(
    new URL("../../../../examples/battle-snapshot.gen9ou.turn14.json", import.meta.url), "utf8")));
  const pending = { moveId: "futuresight", moveName: "Future Sight", sourceSide: "p1" as const,
    targetSide: "p2" as const, targetPosition: "a" as const, castTurn: 14, dueTurn: 16,
    phase: "end_of_turn" as const, status: "scheduled" as const, factIds: ["move-fact", "start-fact"] };
  const next = battleSnapshotSchema.parse({ ...snapshot, pendingAttacks: [pending] });
  const before = await createDecisionIdentity(snapshot), after = await createDecisionIdentity(next);
  assert.notEqual(after.snapshotHash, before.snapshotHash);
  assert.equal(after.legalActionSetHash, before.legalActionSetHash);
  assert.deepEqual(next.pendingAttacks, [pending]);
  assert.equal("pendingAttacks" in observeSnapshotRequestSchema.parse({ snapshot: next }).snapshot, false);
  assert.equal("pendingAttacks" in analyzeRequestSchema.parse({ provider: "mock", snapshot: next }).snapshot, false);
  for (const change of [{ castTurn: 0 }, { targetPosition: "b" }, { phase: "before_moves" }, { factIds: ["unbound"] }]) {
    assert.equal(battleSnapshotSchema.safeParse({ ...snapshot, pendingAttacks: [{ ...pending, ...change }] }).success, false);
  }
});

test("prompt and overlay distinguish zero immediate damage from conditional delayed impact", async () => {
  const snapshot = battleSnapshotSchema.parse(JSON.parse(await fs.readFile(
    new URL("../../../../examples/battle-snapshot.gen9ou.turn14.json", import.meta.url), "utf8")));
  const delayed: DelayedDamagePreview = { kind: "delayed", delayTurns: 2, phase: "end_of_turn", immediateDamagePercent: 0,
    scheduling: "clear", dueTurn: 16, targetSide: "p2", targetPosition: "a", recipient: "slot_at_impact", factIds: [],
    bands: [{ label: "likely", minPercent: 54.1, maxPercent: 63.7, immediate: { ko: "all_rolls", minHpLossPercent: 54.1, maxHpLossPercent: 54.1 }, outcome: "damage" }] };
  snapshot.pendingAttacks = [{ moveId: "futuresight", moveName: "Future Sight", sourceSide: "p1", targetSide: "p2", targetPosition: "a",
    castTurn: 14, dueTurn: 16, phase: "end_of_turn", status: "scheduled", factIds: ["move-fact", "start-fact"] }];
  const player = { actionId: "move:1|tera=0", label: "Future Sight", moveName: "Future Sight", targetName: "Target",
    category: "Special" as const, bands: [], delayed, summary: "Delayed impact", survivalCaveats: [], interactionHints: [] };
  const localIntel = { playerDamagePreview: [player], opponentThreatPreview: [{ moveName: "Future Sight", moveSource: "known",
    targetName: "Your active", currentTarget: { species: "Slowking", relation: "faster", bands: [], delayed: { ...delayed, targetSide: "p1" },
      summary: "Delayed impact", interactionHints: [] }, switchTargets: [], summary: "Delayed impact" }] } as unknown as LocalIntelSnapshot;
  const prompt = buildAnalysisPrompt(snapshot, { localIntel, compactSnapshot: true, maxDeterministicNotes: 0 });
  assert.match(prompt, /Future Sight: 0% damage now/);
  assert.match(prompt, /conditional impact range 54.1-63.7% of max HP into p2a/);
  assert.match(prompt, /Opponent known Future Sight: 0% damage now/);
  assert.match(prompt, /Scheduled attacks:/);
  assert.match(prompt, /end of turn 16, after ordinary actions/);
  assert.doesNotMatch(prompt, /Future Sight[^\n]*(?:KOs current HP|faster and can KO)/);

  const source = await fs.readFile(new URL("../../../extension/content-bridge.js", import.meta.url), "utf8");
  const functionSource = (name: string) => {
    const start = source.indexOf(`  function ${name}(`);
    assert.ok(start >= 0, name);
    const end = source.indexOf("\n  function ", start + 1);
    assert.ok(end > start, name);
    return source.slice(start, end);
  };
  const render = vm.runInNewContext(["formatPercentRange", "escapeHtml", "renderDelayedDamageNote"].map(functionSource).join("\n") + "\nrenderDelayedDamageNote");
  const html = render(delayed);
  assert.match(html, /0% damage now/);
  assert.match(html, /end of turn 16, after ordinary actions/);
  assert.match(html, /Conditional impact: 54-64% of max HP into p2a/);
  assert.doesNotMatch(html, /KOs|rolls|% rem/);
  assert.match(render({ ...delayed, scheduling: "occupied", dueTurn: null }), /another scheduling attempt fails/);
  assert.match(render({ ...delayed, scheduling: "unknown", dueTurn: null }), /scheduling is uncertain/);
});

test("deterministic API binds its output to the normalized snapshot and rejects incorrect identities before recording history", async () => {
  const app = buildServer();
  const snapshot = battleSnapshotSchema.parse(JSON.parse(await fs.readFile(
    new URL("../../../../examples/battle-snapshot.gen9ou.turn14.json", import.meta.url), "utf8")));
  snapshot.rawRequestSummary = { ...snapshot.rawRequestSummary, rqid: 47 };
  const identity = await createDecisionIdentity(snapshot);
  // History is written behind the request path: compare the disk after writing everything pending.
  const { flushIntelStore } = await import("../history/opponentIntelStore.js");
  const disk = async () => { await flushIntelStore(); return fs.readFile(process.env.LOCAL_INTEL_STORE_PATH!, "utf8"); };
  const diskStat = async () => { await flushIntelStore(); return fs.stat(process.env.LOCAL_INTEL_STORE_PATH!, { bigint: true }); };
  try {
    const invalid = await app.inject({ method: "POST", url: "/api/observe-snapshot", payload: {
      snapshot, decisionIdentity: { ...identity, rqid: 46 }
    } });
    assert.equal(invalid.statusCode, 400);
    await assert.rejects(fs.access(process.env.LOCAL_INTEL_STORE_PATH!));

    const observed = await app.inject({ method: "POST", url: "/api/observe-snapshot", payload: {
      snapshot, decisionIdentity: identity
    } });
    assert.equal(observed.statusCode, 200, observed.body);
    assert.equal(observed.json().historyAuthority, "legacy_untrusted");
    assert.deepEqual(observed.json().decisionIdentity, identity);
    assert.ok(observed.json().localIntel.selfActionRecommendation);

    const generated = await app.inject({ method: "POST", url: "/api/observe-snapshot", payload: { snapshot } });
    assert.equal(generated.statusCode, 200);
    assert.deepEqual(generated.json().decisionIdentity, identity);

    const analysis = await app.inject({ method: "POST", url: "/api/analyze", payload: {
      provider: "mock", snapshot, decisionIdentity: identity
    } });
    assert.equal(analysis.statusCode, 200, analysis.body);
    assert.deepEqual(analysis.json().decisionIdentity, identity);

    const mismatchedActionSet = await app.inject({ method: "POST", url: "/api/analyze", payload: {
      provider: "mock", snapshot: { ...snapshot, legalActions: snapshot.legalActions.slice(1) }, decisionIdentity: identity
    } });
    assert.equal(mismatchedActionSet.statusCode, 400);
    await assert.rejects(fs.access(process.env.LOCAL_INTEL_STORE_PATH!), "legacy adapter requests must not create canonical observed history");

    const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
    const roomId = "battle-gen9ou-123456789";
    const observation = { sessionId: "api-capture", observationId: "api-1", sequence: 1, roomId, source: "protocol", data: raw };
    const ingest = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
    assert.equal(ingest.statusCode, 200, ingest.body);
    const current = ingest.json();
    const query = { sessionId: observation.sessionId, identity: current.results[0].identity, historyRevision: current.historyRevision };
    const storeBefore = await disk();
    const rejectedBatch = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [
      { ...observation, observationId: "rejected-first", sequence: 2, data: `>${roomId}\n|-boost|p2a: Dragapult|atk|1` },
      { ...observation, data: `>${roomId}\n|turn|200` }
    ] } });
    assert.equal(rejectedBatch.statusCode, 409, rejectedBatch.body);
    assert.equal(await disk(), storeBefore);
    const untrusted = await app.inject({ method: "POST", url: "/api/observe-snapshot", payload: { snapshot } });
    assert.equal(untrusted.statusCode, 200, untrusted.body);
    assert.equal(await disk(), storeBefore);
    const storeStat = await diskStat();
    // after: "threats" asks for the complete result (the stage after the last partial one).
    const evaluate = () => app.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "threats" } });
    const first = await evaluate(), second = await evaluate();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(first.json().envelope, second.json().envelope);
    const envelope = first.json().envelope;
    assert.equal(envelope.semantic.contractVersion, "showdown-decision@1");
    assert.match(envelope.semantic.engineVersion, /sha256:/);
    assert.match(envelope.resultHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelope.semantic.capabilities.status, "degraded");
    const actionIds = new Set(envelope.semantic.snapshot.legalActions.filter((action: any) => !action.disabled).map((action: any) => action.id));
    for (const candidate of envelope.semantic.localIntel.selfActionRecommendation.rankedActions) assert.ok(actionIds.has(candidate.actionId));
    assert.equal(await disk(), storeBefore);
    assert.equal((await diskStat()).mtimeNs, storeStat.mtimeNs);
    const repeat = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
    assert.equal(repeat.json().results[0].applied, false);
    assert.equal(await disk(), storeBefore);

    const badFeedback = await app.inject({ method: "POST", url: "/v1/feedback", payload: { ...query, resultHash: "sha256:invalid" } });
    assert.equal(badFeedback.statusCode, 409, badFeedback.body);
    assert.equal(await disk(), storeBefore);
    const shown = await app.inject({ method: "POST", url: "/v1/feedback", payload: { ...query, resultHash: envelope.resultHash } });
    assert.equal(shown.statusCode, 200, shown.body);
    const afterShown = await disk();
    const repeatedFeedback = await app.inject({ method: "POST", url: "/v1/feedback", payload: { ...query, resultHash: envelope.resultHash } });
    assert.equal(repeatedFeedback.statusCode, 200, repeatedFeedback.body);
    assert.equal(repeatedFeedback.json().alreadyRecorded, true);
    assert.equal(await disk(), afterShown);

    const nextRequest = JSON.parse(raw.split("\n").find((line) => line.startsWith("|request|"))!.slice(9));
    const next = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [{ ...observation, observationId: "api-2", sequence: 2,
      data: `>${roomId}\n|request|${JSON.stringify({ ...nextRequest, rqid: 49 })}` }] } });
    assert.equal(next.statusCode, 200, next.body);
    const afterNewRequest = await disk();
    const stale = await evaluate();
    assert.equal(stale.statusCode, 409, stale.body);
    const staleFeedback = await app.inject({ method: "POST", url: "/v1/feedback", payload: { ...query, resultHash: envelope.resultHash } });
    assert.equal(staleFeedback.statusCode, 409, staleFeedback.body);
    assert.equal(await disk(), afterNewRequest);

    const previewRoom = "battle-gen9uu-api-preview";
    const previewObservation = { ...observation, roomId: previewRoom, observationId: "api-preview", sequence: 3,
      data: `>${previewRoom}\n|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Latios\n|request|${JSON.stringify({
        rqid: 1, teamPreview: true, side: { id: "p1", name: "You", pokemon: [
          { ident: "p1: Same", details: "Scizor, L100", condition: "100/100", active: false, moves: ["bulletpunch"] },
          { ident: "p1: Other", details: "Slowking, L100", condition: "100/100", active: false, moves: ["scald"] }
        ] }
      })}` };
    const previewIngest = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [previewObservation] } });
    assert.equal(previewIngest.statusCode, 200, previewIngest.body);
    const previewQuery = { sessionId: observation.sessionId, identity: previewIngest.json().results[0].identity, historyRevision: previewIngest.json().historyRevision };
    const preview = await app.inject({ method: "POST", url: "/v1/evaluate", payload: { ...previewQuery, after: "threats" } });
    assert.equal(preview.statusCode, 200, preview.body);
    const previewSemantic = preview.json().envelope.semantic;
    assert.deepEqual(previewSemantic.snapshot.legalActions.map((action: any) => action.choice), ["team 12", "team 21"]);
    assert.equal(previewSemantic.localIntel.selfActionRecommendation.rankedActions.length, 2);
    for (const candidate of previewSemantic.localIntel.selfActionRecommendation.rankedActions) {
      assert.ok(previewSemantic.snapshot.legalActions.some((action: any) => action.id === candidate.actionId));
      assert.ok(candidate.riskFlags.some((risk: string) => risk.includes("remaining team order")));
    }
  } finally {
    await app.close();
  }
});

test("evaluation cannot publish an old revision after an observation commits during result hashing", { timeout: 15_000 }, async (t) => {
  const app = buildServer();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let hashing!: () => void;
  const entered = new Promise<void>((resolve) => { hashing = resolve; });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  try {
    const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
    const roomId = "battle-gen9ou-123456789";
    const observation = { sessionId: "api-hash-race", observationId: "race-1", sequence: 1, roomId, source: "protocol", data: raw };
    const first = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
    assert.equal(first.statusCode, 200, first.body);
    const initial = first.json();
    const query = { sessionId: observation.sessionId, identity: initial.results[0].identity, historyRevision: initial.historyRevision };

    // Hold only the envelope hash, after the evaluator's last freshness check.
    // Identity hashes and observation commits must still be able to complete.
    let gated = false;
    t.mock.method(crypto.subtle, "digest", async (...args: Parameters<typeof crypto.subtle.digest>) => {
      if (!gated && new TextDecoder().decode(args[1]).includes('"contractVersion":"showdown-decision@1"')) {
        gated = true;
        hashing();
        await held;
      }
      return digest(...args);
    });
    // Fastify injection is lazy until its then method is invoked.
    const pending = Promise.resolve(app.inject({ method: "POST", url: "/v1/evaluate", payload: query }));
    await entered;
    const newer = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [{
      ...observation, observationId: "race-2", sequence: 2, data: `>${roomId}\n|-boost|p2a: Dragapult|atk|1`
    }] } });
    assert.equal(newer.statusCode, 200, newer.body);
    const nextIdentity = newer.json().results[0].identity;
    assert.equal(nextIdentity.stateRevision, query.identity.stateRevision + 1);
    assert.equal(nextIdentity.rqid, query.identity.rqid, "public state changes also invalidate an in-flight result");
    const before = await fs.readFile(process.env.LOCAL_INTEL_STORE_PATH!, "utf8");
    const beforeStat = await fs.stat(process.env.LOCAL_INTEL_STORE_PATH!, { bigint: true });
    release();
    const stale = await pending;
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().ok, false);
    assert.match(stale.json().error, /no longer current/);
    assert.equal(stale.json().envelope, undefined);

    // A current decision remains a pure query against the explicitly pinned
    // history; rejecting the stale response must not replace that history view.
    const fresh = await Promise.all(Array.from({ length: 3 }, () => app.inject({
      method: "POST", url: "/v1/evaluate", payload: { ...query, identity: nextIdentity, after: "threats" }
    })));
    for (const result of fresh) {
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json().envelope, fresh[0]!.json().envelope);
      assert.deepEqual(result.json().envelope.semantic.identity, nextIdentity);
      assert.equal(result.json().envelope.semantic.historyRevision, query.historyRevision);
    }
    assert.equal(await fs.readFile(process.env.LOCAL_INTEL_STORE_PATH!, "utf8"), before);
    assert.equal((await fs.stat(process.env.LOCAL_INTEL_STORE_PATH!, { bigint: true })).mtimeNs, beforeStat.mtimeNs);
  } finally {
    release();
    t.mock.restoreAll();
    await app.close();
  }
});

test("unproved forced-switch timing is a visible limitation while legal decisions remain actionable", async () => {
  const app = buildServer();
  try {
    const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
    const roomId = "battle-gen9ou-123456789", sessionId = "unproved-timing";
    const request = JSON.parse(raw.split("\n").find((line) => line.startsWith("|request|"))!.slice(9));
    const observed = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [
      { observationId: "timing-initial", roomId, sessionId, sequence: 1, source: "protocol", data: raw },
      { observationId: "timing-forced", roomId, sessionId, sequence: 2, source: "protocol",
        data: `>${roomId}\n|request|${JSON.stringify({ rqid: 48, forceSwitch: [true], noCancel: true, side: request.side })}` }
    ] } });
    assert.equal(observed.statusCode, 200, observed.body);
    const committed = observed.json();
    const evaluated = await app.inject({ method: "POST", url: "/v1/evaluate", payload: {
      sessionId, identity: committed.results[1].identity, historyRevision: committed.historyRevision, after: "threats"
    } });
    assert.equal(evaluated.statusCode, 200, evaluated.body);
    const { semantic } = evaluated.json().envelope;
    assert.equal(semantic.snapshot.rawRequestSummary.requestKind, "forced_switch");
    assert.equal(semantic.snapshot.turnCoverage, undefined);
    assert.equal(semantic.localIntel.opponentActionPrediction.replyTiming.status, "unknown");
    assert.ok(semantic.capabilities.limitations.includes("reply_timing_unknown"));
    assert.equal(semantic.capabilities.actionable, true);
    assert.ok(semantic.localIntel.selfActionRecommendation.rankedActions.length > 0);
  } finally { await app.close(); }
});

test("prompt and damage chips separate raw pressure from immediate survival", async () => {
  const snapshot = battleSnapshotSchema.parse(JSON.parse(await fs.readFile(new URL("../../../../examples/battle-snapshot.gen9ou.turn14.json", import.meta.url), "utf8")));
  const band = { label: "likely", minPercent: 140.6, maxPercent: 165.6, outcome: "damage",
    immediate: { ko: "no_ko", minHpLossPercent: 99.6, maxHpLossPercent: 99.6, note: "Sturdy leaves target at 1 HP <safe>" } };
  const intel = { playerDamagePreview: [{ label: "Surf", bands: [band], survivalCaveats: [], interactionHints: [] }],
    opponentThreatPreview: [{ moveName: "Surf", moveSource: "known", currentTarget: { bands: [band], relation: "faster" } }] } as unknown as LocalIntelSnapshot;
  const prompt = buildAnalysisPrompt(snapshot, { localIntel: intel, compactSnapshot: true, maxDeterministicNotes: 0 });
  assert.match(prompt, /raw likely 140.6-165.6%/);
  assert.match(prompt, /"ko":"no_ko"/);
  assert.match(prompt, /Sturdy leaves target at 1 HP/);
  assert.doesNotMatch(prompt, /KOs current HP|faster and can KO/);
  const source = await fs.readFile(new URL("../../../extension/content-bridge.js", import.meta.url), "utf8");
  const functions = ["escapeHtml", "renderCompactChip", "formatPercentRange", "formatRemainingRange", "formatBandCoverage", "formatImmediateOutcome", "compactBandLabel", "bandTone", "renderBandChip"].flatMap((name) => {
    const start = source.indexOf(`  function ${name}(`); if (start < 0) return [];
    return [source.slice(start, source.indexOf("\n  function ", start + 1))];
  });
  const render = vm.runInNewContext(functions.join("\n") + "\nrenderBandChip");
  const html = render(band, 100, "calc");
  assert.match(html, /raw 141-166%/);
  assert.match(html, /no KO on this hit/);
  assert.match(html, /Sturdy leaves target at 1 HP &lt;safe&gt;/);
  assert.doesNotMatch(html, /rgba\(74,222,128|<safe>|% rem/);
  for (const [ko, label] of [["all_rolls", "KO on hit: all rolls"], ["some_rolls", "KO on hit: some rolls"], ["conditional", "conditional KO"], ["unknown", "immediate outcome unknown"]]) {
    const output = render({ ...band, immediate: { ko, minHpLossPercent: null, maxHpLossPercent: null } }, 100);
    assert.ok(output.includes(label), ko);
    if (ko !== "all_rolls") assert.doesNotMatch(output, /rgba\(74,222,128/);
  }
});


async function startupPriorFiles() {
  const { createHash } = await import("node:crypto");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-startup-prior-"));
  const bytes = Buffer.from(JSON.stringify({ info: { metagame: "gen9uu", cutoff: 1760, "team type": null }, data: { "Arcanine-Hisui": { Abilities: { rockhead: 10 }, Moves: { flareblitz: 9, extremespeed: 8 } } } }));
  const source = { url: "https://www.smogon.com/stats/2026-09/chaos/gen9uu-1760.json", period: "2026-09", formatId: "gen9uu", ratingCutoff: 1760, sha256: createHash("sha256").update(bytes).digest("hex") };
  const raw = path.join(directory, "raw.json"), descriptor = path.join(directory, "descriptor.json");
  await fs.writeFile(raw, bytes, { mode: 0o600 });
  await fs.writeFile(descriptor, JSON.stringify({ version: 1, source, rawFile: "raw.json" }), { mode: 0o600 });
  return { directory, raw, descriptor, source, bytes };
}

test("R37 startup prior pins canonical HTTP contexts once and leaves legacy and pure evaluation writes unchanged", async () => {
  const f = await startupPriorFiles(), options = { movePriorDescriptor: f.descriptor }, app = buildServer(options);
  options.movePriorDescriptor = path.join(f.directory, "not-captured.json");
  const history = () => fs.readFile(process.env.LOCAL_INTEL_STORE_PATH!, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
  const curated = () => fs.readFile(process.env.EXTERNAL_CURATED_STORE_PATH!, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
  const beforeStartup = await history(), curatedBeforeStartup = await curated();
  try {
    await app.ready(); assert.equal(await history(), beforeStartup, "readiness never writes observed history");
    assert.equal(await curated(), curatedBeforeStartup, "readiness never writes curated data");
    await fs.unlink(f.raw); await fs.unlink(f.descriptor);
    const room = "battle-gen9uu-startup-prior", sessionId = "startup-prior";
    const own = { rqid: 1, side: { id: "p1", pokemon: [{ ident: "p1: Friend", details: "Slowking", active: true, condition: "350/350", baseAbility: "Regenerator", item: "", moves: ["scald"], stats: { hp: 350, atk: 150, def: 200, spa: 250, spd: 250, spe: 100 } }] }, active: [{ moves: [{ move: "Scald", id: "scald", pp: 15 }] }] };
    const observation = { sessionId, roomId: room, observationId: "startup-1", sequence: 1, source: "protocol", data: `>${room}\n|init|battle\n|tier|[Gen 9] UU\n|poke|p1|Slowking\n|poke|p2|Arcanine-Hisui\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Hound|Arcanine-Hisui|100/100\n|turn|7\n|request|${JSON.stringify(own)}` };
    const ingest = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
    assert.equal(ingest.statusCode, 200, ingest.body);
    const body = ingest.json(), query = { sessionId, identity: body.results[0].identity, historyRevision: body.historyRevision };
    const bytes = await history(), stat = await fs.stat(process.env.LOCAL_INTEL_STORE_PATH!, { bigint: true });
    const evaluate = () => app.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "threats" } });
    const first = await evaluate(); assert.equal(first.statusCode, 200, first.body);
    const envelope = first.json().envelope, entry = envelope.semantic.localIntel.opponents.find((p: any) => p.species === "Arcanine-Hisui");
    assert.equal(entry.metaMovePrior?.status, "cold_start");
    assert.deepEqual(entry.metaMovePrior.source, f.source);
    assert.ok(envelope.semantic.localIntel.opponentThreatPreview.some((p: any) => p.moveName === "Flare Blitz"));
    const { hashCanonical } = await import("../../../extension/lib/decision-identity.js");
    const { captureIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
    const captured = await captureIntelEvaluationContext();
    assert.equal(captured.revision, await hashCanonical(captured.store));
    assert.equal(envelope.semantic.historyRevision, await hashCanonical({ store: captured.store, metaPriorRevision: entry.metaMovePrior.revision }));
    assert.equal(envelope.resultHash, await hashCanonical(envelope.semantic));
    assert.deepEqual((await evaluate()).json().envelope, envelope);
    assert.equal(await history(), bytes); assert.equal((await fs.stat(process.env.LOCAL_INTEL_STORE_PATH!, { bigint: true })).mtimeNs, stat.mtimeNs);
    assert.equal(await curated(), curatedBeforeStartup, "canonical commits and pure evaluation never write curated data");
    const legacy = await app.inject({ method: "POST", url: "/api/observe-snapshot", payload: { snapshot: { ...envelope.semantic.snapshot, capturedAt: "2026-10-19T00:00:00.000Z" } } });
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.json().historyAuthority, "legacy_untrusted");
    assert.ok(legacy.json().localIntel.opponents.every((p: any) => p.metaMovePrior === undefined));
    assert.equal(await history(), bytes);
    const bad = await app.inject({ method: "POST", url: "/v1/feedback", payload: { ...query, resultHash: "sha256:wrong" } });
    assert.equal(bad.statusCode, 409); assert.equal(await history(), bytes);
    const feedback = await app.inject({ method: "POST", url: "/v1/feedback", payload: { ...query, resultHash: envelope.resultHash } });
    assert.equal(feedback.statusCode, 200, feedback.body);
    const afterFeedback = await history(); assert.doesNotMatch(afterFeedback!, /metaMovePrior|movePriors|setInclusionShare|metaPriorRevision/);
    assert.equal((await app.inject({ method: "POST", url: "/v1/feedback", payload: { ...query, resultHash: envelope.resultHash } })).json().alreadyRecorded, true);
    assert.equal(await history(), afterFeedback);
    const next = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [{ ...observation, sequence: 2, observationId: "startup-2", data: `>${room}\n|turn|8` }] } });
    assert.equal(next.statusCode, 200, next.body);
    const updated = next.json(), result = await app.inject({ method: "POST", url: "/v1/evaluate", payload: { sessionId, identity: updated.results[0].identity, historyRevision: updated.historyRevision, after: "threats" } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().envelope.semantic.localIntel.opponents.find((p: any) => p.species === "Arcanine-Hisui").metaMovePrior.revision, entry.metaMovePrior.revision);
  } finally { await app.close(); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("R37 invalid configured prior rejects readiness before requests or listening", { timeout: 15000 }, async () => {
  const f = await startupPriorFiles();
  const cases: Array<[string, RegExp]> = [[path.relative(process.cwd(), f.descriptor), /absolute descriptor/], [f.directory, /regular file/], [path.join(f.directory, "missing.json"), /ENOENT/]];
  const oversized = path.join(f.directory, "oversized.json"); await fs.writeFile(oversized, "x".repeat(16_385)); cases.push([oversized, /size limit/]);
  const bad = path.join(f.directory, "bad.json"); await fs.writeFile(bad, JSON.stringify({ version: 1, source: { ...f.source, sha256: "f".repeat(64) }, rawFile: "raw.json" })); cases.push([bad, /SHA-256/]);
  const alias = path.join(f.directory, "project-alias"); await fs.symlink(new URL("../../README.md", import.meta.url).pathname, alias); cases.push([alias, /outside the project/]);
  if (process.platform !== "win32") {
    const { execFile } = await import("node:child_process"), { promisify } = await import("node:util"), fifo = path.join(f.directory, "fifo");
    await promisify(execFile)("mkfifo", [fifo]); cases.push([fifo, /regular file/]);
  }
  const before = await fs.readFile(process.env.LOCAL_INTEL_STORE_PATH!, "utf8").catch(() => null);
  try {
    for (const [movePriorDescriptor, pattern] of cases) {
      const app = buildServer({ movePriorDescriptor });
      try {
        await assert.rejects(async () => { await app.ready(); }, pattern);
        const rejected = await app.inject({ method: "POST", url: "/v1/observations", payload: {} });
        assert.equal(rejected.statusCode, 500); assert.match(rejected.body, /prior is unavailable/);
        assert.equal(app.server.listening, false);
      }
      finally { await app.close().catch(() => undefined); }
    }
    const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
    const script = `const { buildServer } = await import(${JSON.stringify(new URL("../server.ts", import.meta.url).href)}); const app = buildServer(); try { await app.ready(); } finally { await app.close(); }`;
    await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      timeout: 5000, env: { ...process.env, TMPDIR: os.tmpdir(), TSX_DISABLE_CACHE: "1", MOVE_PRIOR_DESCRIPTOR: "relative.json", LOCAL_INTEL_STORE_PATH: path.join(f.directory, "forbidden-history.json"), EXTERNAL_CURATED_STORE_PATH: path.join(f.directory, "forbidden-curated.json") }
    }), (error: any) => { assert.match(error.stderr, /absolute descriptor/); return true; });
    await assert.rejects(fs.access(path.join(f.directory, "forbidden-history.json")));
    await assert.rejects(fs.access(path.join(f.directory, "forbidden-curated.json")));
    assert.equal(await fs.readFile(process.env.LOCAL_INTEL_STORE_PATH!, "utf8").catch(() => null), before);
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("R37 existing intel renderer exposes escaped monthly provenance without probability or path jargon", async () => {
  const source = await fs.readFile(new URL("../../../extension/content-bridge.js", import.meta.url), "utf8");
  const functions = ["escapeHtml", "renderMechanicsNotice", "renderMetaMovePrior", "renderIntelPanelMarkup"].flatMap((name) => {
    const start = source.indexOf(`  function ${name}(`); return start < 0 ? [] : [source.slice(start, source.indexOf("\n  function ", start + 1))];
  });
  const entry: any = { species: "Arcanine-Hisui", revealedMoves: [], likelyMoves: [], likelyItems: [], likelyAbilities: [], likelyTeraTypes: [], metaMovePrior: { status: "cold_start", source: { period: "2026-09", formatId: "gen9uu", ratingCutoff: 1760, sha256: "f".repeat(64), url: "javascript:private" }, revision: "sha256:private", rawFile: "/private/cache", moves: [{ name: "Flare Blitz", setInclusionShare: 0.9 }] } };
  const intel = { note: "", opponents: [entry] };
  const render = vm.runInNewContext(functions.join("\n") + "\nrenderIntelPanelMarkup", { getLocalIntel: () => intel, latestOverlayPayload: { snapshot: { yourSide: { team: [] }, opponentSide: { team: [] } } }, findSnapshotPokemonBySpecies: () => null, renderCurrentReveal: () => "", renderLikelihoodList: () => "", renderTeamTypeSection: () => "", renderTypeMatchupDisclosure: () => "" });
  const html = render(); assert.match(html, /Monthly.*2026-09/); assert.match(html, /Gen 9 UU/); assert.match(html, /1760/); assert.match(html, /Flare Blitz.*90%/); assert.match(html, /Percentages describe the sampled monthly sets\./);
  assert.doesNotMatch(html, /sha256:|private|href|confidence samples|next.action.*90%/);
  entry.metaMovePrior.moves[0].name = "<move>"; entry.metaMovePrior.source.period = "<period>";
  const escaped = render(); assert.match(escaped, /&lt;move&gt;/); assert.match(escaped, /&lt;period&gt;/); assert.doesNotMatch(escaped, /<move>|<period>/);
  entry.metaMovePrior.status = "unrevealed_slots"; assert.match(render(), /Percentages describe the sampled monthly sets/);
  entry.metaMovePrior.status = "moves_known"; assert.match(render(), /All four moves have been revealed/);
  entry.metaMovePrior.status = "format_mismatch"; assert.match(render(), /format/i);
  entry.metaMovePrior.status = "species_missing"; assert.match(render(), /No monthly move data/);
  entry.metaMovePrior.status = "no_supported_candidate"; assert.match(render(), /No monthly move estimates available\./);
  assert.doesNotMatch(render(), /&lt;move&gt;|% of sets/);
  delete entry.metaMovePrior; assert.doesNotMatch(render(), /Monthly|set.inclusion/i);
});
