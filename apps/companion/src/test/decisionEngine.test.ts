import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Battle, Teams, TeamValidator, extractChannelMessages } from "../battle-agent/nativeSimulator.js";
import { effectiveSpeed } from "../mechanics/speed.js";
import { evaluateDecision } from "../state/decisionEnvelope.js";
import { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } from "../history/opponentIntelStore.js";
import { DecisionEngine, sameCanonicalDecision, type BattleObservation } from "../state/decisionEngine.js";
import { analyzeRequestSchema, battleSnapshotSchema, observeSnapshotRequestSchema } from "../schema.js";
import { createDecisionIdentity } from "../../../extension/lib/decision-identity.js";

const initial = (await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8"))
  .replaceAll("battle-gen9ou-123456789", "battle-gen9uu-ledger");
const roomId = "battle-gen9uu-ledger";
const privateRequest = JSON.parse(initial.split("\n").find((line) => line.startsWith("|request|"))!.slice(9));
const observation = (sequence: number, data: string, source: "protocol" | "recovery" = "protocol"): BattleObservation => ({
  observationId: `capture-${sequence}`, sessionId: "capture", sequence, roomId, source,
  data: data.startsWith(">") ? data : `>${roomId}\n${data}`
});

const ownedSource = { source: "owned_offline_simulator" } as const;
const ownedStart = [
  "|tier|[Gen 9] OU", "|gametype|singles", "|teamsize|p1|2", "|teamsize|p2|1", "|clearpoke",
  "|poke|p1|Great Tusk, L100, M", "|poke|p1|Gholdengo, L100", "|poke|p2|Dragapult, L100", "|start",
  "|switch|p1a: Great Tusk|Great Tusk, L100, M|295/434", "|switch|p2a: Dragapult|Dragapult, L100|100/100", "|turn|1"
].join("\n");
const ownedRequest = (rqid = 1) => `|request|${JSON.stringify({ ...privateRequest, rqid })}`;
const ownedFrames = () => [observation(1, "|init|battle"), observation(2, ownedStart), observation(3, ownedRequest())];

test("policy-only collection preserves canonical inputs and isolates the envelope cache", async () => {
  const engine = new DecisionEngine(ownedSource);
  let current: Awaited<ReturnType<typeof engine.ingest>>;
  for (const frame of ownedFrames()) current = await engine.ingest(frame);
  const context = await projectCanonicalSnapshots([current!.snapshot!], await createEphemeralIntelEvaluationContext());
  const projected = await projectCanonicalSnapshots([current!.snapshot!], { ...context, analysisMode: "policy-only" });
  assert.equal(projected.analysisMode, "policy-only");
  assert.deepEqual(projected.store.canonicalBattles![roomId]!.confirmedFacts, context.store.canonicalBattles![roomId]!.confirmedFacts);
  assert.deepEqual(projected.store.canonicalBattles![roomId]!.lineageConflict, context.store.canonicalBattles![roomId]!.lineageConflict);
  assert.deepEqual(projected.store.canonicalBattles![roomId]!.contributions, []);
  // Same history revision exercises mode separation in the shared cache.
  const fast = { ...context, analysisMode: "policy-only" as const };
  const ordinary = await evaluateDecision(engine, "capture", current!.identity!, context);
  const minimal = await evaluateDecision(engine, "capture", current!.identity!, fast);
  assert.deepEqual(minimal.semantic.snapshot, ordinary.semantic.snapshot);
  assert.deepEqual(minimal.semantic.identity, ordinary.semantic.identity);
  assert.equal(minimal.semantic.capabilities.actionable, ordinary.semantic.capabilities.actionable);
  assert.deepEqual(minimal.semantic.localIntel.opponents, []);
  assert.notEqual(minimal.resultHash, ordinary.resultHash);
  assert.deepEqual(await evaluateDecision(engine, "capture", current!.identity!, context), ordinary);
});

test("policy-only collection rejects policies needing advisory mechanics", async () => {
  const { runBattleMatch } = await import("../battle-agent/simulator.js");
  const policy = { id: "test", async decide(): Promise<never> { throw new Error("Never called"); } };
  await assert.rejects(runBattleMatch({ p1: policy, p2: { ...policy }, teams: { p1: "", p2: "" },
    analysisMode: "policy-only" }), /two policies with independent mechanics/);
});

test("only the explicitly owned from-start stream certifies the current turn and latest own request", async () => {
  const ordinary = new DecisionEngine(), owned = new DecisionEngine(ownedSource);
  const empty = await owned.ingest(observation(1, "|init|battle"));
  assert.equal(empty.snapshot, null, "authority without actual turn/request evidence is insufficient");
  await ordinary.ingestBatch(ownedFrames());
  await owned.ingestBatch(ownedFrames()); // Exact initial duplicate does not become a reset.
  const current = await owned.read("capture", roomId), unqualified = await ordinary.read("capture", roomId);
  assert.equal(Object.hasOwn(unqualified.snapshot!, "turnCoverage"), false);
  assert.deepEqual(current.snapshot!.canonicalEvidence, unqualified.snapshot!.canonicalEvidence);
  const facts = current.snapshot!.canonicalEvidence!.facts;
  const turn = facts.find((fact) => fact.kind === "turn")!, request = facts.at(-1)!;
  assert.deepEqual(current.snapshot!.turnCoverage, { source: "owned_offline_simulator", turn: 1,
    turnFactId: turn.id, requestFactId: request.id, fromSequence: 2, throughSequence: 3 });
  assert.equal(request.kind, "request"); assert.equal(request.source.rqid, current.identity!.rqid);
  assert.notEqual(current.identity!.snapshotHash, unqualified.identity!.snapshotHash);
  assert.deepEqual(battleSnapshotSchema.parse(current.snapshot), current.snapshot);
  for (const patch of [{ turn: 2 }, { turnFactId: "different" }, { requestFactId: "different" }, { fromSequence: 1 }, { throughSequence: 4 }, { source: "different" }]) {
    const changed = structuredClone(current.snapshot!);
    Object.assign(changed.turnCoverage!, patch);
    assert.notEqual((await createDecisionIdentity(changed)).snapshotHash, current.identity!.snapshotHash);
  }
  const heartbeat = await owned.ingest(observation(4, "|t:|123"));
  assert.equal(heartbeat.snapshot!.turnCoverage!.throughSequence, 4, "all observed frames bound the certificate");
  assert.equal(heartbeat.snapshot!.turnCoverage!.requestFactId, request.id);
  assert.equal(heartbeat.changed, true, "coverage is semantic state even for a nonsemantic protocol frame");
  assert.ok(heartbeat.identity!.stateRevision > current.identity!.stateRevision);
  const next = await owned.ingest(observation(5, ownedRequest(2)));
  assert.equal(next.snapshot!.turnCoverage!.requestFactId, next.snapshot!.canonicalEvidence!.facts.at(-1)!.id);
  assert.notEqual(next.snapshot!.turnCoverage!.requestFactId, request.id);
});

test("owned coverage requires initial anchoring, contiguous sequence and chronological start/turn boundaries", async () => {
  for (const frames of [
    [observation(1, ownedStart), observation(2, ownedRequest())],
    ownedFrames().map((frame) => ({ ...frame, sequence: frame.sequence + 1 })),
    ownedFrames().map((frame) => ({ ...frame, sequence: frame.sequence === 3 ? 4 : frame.sequence })),
    ownedFrames().map((frame) => ({ ...frame, data: frame.data.replace("\n|start\n", "\n") })),
    ownedFrames().map((frame) => ({ ...frame, data: frame.data.replace("|turn|1", "|turn|2") })),
    ownedFrames().map((frame) => ({ ...frame, data: frame.data.replace("|turn|1", "|turn|1\n|turn|3") })),
    ownedFrames().map((frame) => ({ ...frame, data: frame.data.replace("|turn|1", "|turn|1\n|turn|1") })),
    ownedFrames().map((frame) => ({ ...frame, data: frame.data.replace("|turn|1", "|turn|1\n|start") })),
    [observation(1, "|init|battle"), observation(2, `${ownedStart.replace("\n|turn|1", "")}\n${ownedRequest()}`)]
  ]) {
    const engine = new DecisionEngine(ownedSource);
    await engine.ingestBatch(frames);
    assert.equal((await engine.read("capture", roomId)).snapshot!.turnCoverage, undefined, JSON.stringify(frames));
  }
});

test("a gap, any recovery or reset permanently withholds owned coverage for that capture", async () => {
  for (const taint of [
    observation(5, "|t:|123"),
    observation(4, "|t:|123", "recovery"),
    observation(4, ownedRequest(), "recovery"),
    observation(4, "|turn|99", "recovery"),
    observation(4, `|init|battle\n${ownedStart}\n${ownedRequest(2)}`),
    observation(4, "|clearpoke")
  ]) {
    const engine = new DecisionEngine(ownedSource);
    await engine.ingestBatch(ownedFrames());
    assert.ok((await engine.read("capture", roomId)).snapshot!.turnCoverage);
    const after = await engine.ingest(taint);
    assert.equal(after.snapshot!.turnCoverage, undefined);
    const later = await engine.ingest(observation(taint.sequence + 1, `|turn|2\n${ownedRequest(3)}`));
    assert.equal(later.snapshot!.turnCoverage, undefined, "a later clean turn must not repair missing coverage");
  }
});

test("owned coverage excludes resolving, missing current requests, wait and terminal states", async () => {
  for (const suffix of [
    "|move|p2a: Dragapult|Shadow Ball|p1a: Great Tusk", "|turn|2", "|upkeep", "|win|Bob", "|tie",
    `|request|${JSON.stringify({ ...privateRequest, rqid: 2, wait: true })}`,
    `|request|${JSON.stringify({ ...privateRequest, rqid: 2, teamPreview: true })}`,
    `|request|${JSON.stringify(privateRequest)}`,
    `|request|${JSON.stringify({ ...privateRequest, rqid: 1 })}`
  ]) {
    const engine = new DecisionEngine(ownedSource);
    await engine.ingestBatch(ownedFrames());
    assert.equal((await engine.ingest(observation(4, suffix))).snapshot!.turnCoverage, undefined, suffix);
  }
});

test("caller coverage text and snapshot schemas cannot opt a default engine or HTTP input into authority", async () => {
  const owned = new DecisionEngine(ownedSource);
  await owned.ingestBatch(ownedFrames());
  const supplied = (await owned.read("capture", roomId)).snapshot!;
  assert.ok(supplied.turnCoverage);
  assert.equal(Object.hasOwn(analyzeRequestSchema.parse({ provider: "mock", snapshot: supplied }).snapshot, "turnCoverage"), false);
  assert.equal(Object.hasOwn(observeSnapshotRequestSchema.parse({ snapshot: supplied }).snapshot, "turnCoverage"), false);
  for (const source of ["protocol", "recovery"] as const) {
    const engine = new DecisionEngine();
    await engine.ingestBatch(ownedFrames());
    const fake = JSON.stringify({ ...privateRequest, rqid: 2, turnCoverage: supplied.turnCoverage, source: ownedSource.source });
    const result = await engine.ingest({ ...observation(4, `|sso-state|${JSON.stringify(supplied)}\n|turnCoverage|${JSON.stringify(supplied.turnCoverage)}\n|request|${fake}`, source), observationId: "p1-4" });
    assert.equal(Object.hasOwn(result.snapshot!, "turnCoverage"), false);
  }
});

test("owned coverage and authority survive duplicate batches and both forms of transaction rollback", async () => {
  const engine = new DecisionEngine(ownedSource);
  await engine.ingestBatch(ownedFrames());
  const before = await engine.read("capture", roomId), refs = engine.observationReferences("capture", roomId);
  const duplicates = await engine.ingestBatch([...ownedFrames(), ...ownedFrames()]);
  assert.ok(duplicates.every((result) => !result.applied && !result.changed));
  assert.deepEqual(await engine.read("capture", roomId), before);
  assert.deepEqual(engine.observationReferences("capture", roomId), refs);
  await assert.rejects(engine.ingestBatch([observation(4, "|t:|123", "recovery"), observation(2, "|turn|3")]), /reused/);
  await assert.rejects(engine.ingestBatch([observation(4, "|t:|123", "recovery")], async () => { throw new Error("Commit failed"); }), /Commit failed/);
  assert.deepEqual(await engine.read("capture", roomId), before);
  assert.deepEqual(engine.observationReferences("capture", roomId), refs);
  const next = await engine.ingest(observation(4, `|turn|2\n${ownedRequest(2)}`));
  assert.equal(next.snapshot!.turnCoverage!.turn, 2);
  assert.equal(next.snapshot!.turnCoverage!.fromSequence, 4);
  assert.equal(next.snapshot!.turnCoverage!.throughSequence, 4);
});

test("bare start recovery is idempotent across optional separators and metadata projections", async () => {
  assert.ok(initial.split("\n").includes("|start"), "exercise the real bare start fixture");
  for (const start of ["|start", "|start|"]) {
    const engine = new DecisionEngine();
    const data = `${initial.replace("\n|start\n", `\n${start}\n`)}\n|request|${JSON.stringify({ ...privateRequest, rqid: 10 })}`;
    const first = await engine.ingest(observation(1, data));
    const identical = await engine.ingest(observation(2, data, "recovery"));
    assert.equal(identical.changed, false);
    assert.deepEqual(identical.identity, first.identity);
    const projected = data.split("\n").filter((line) => !/^\|(init|title|tier|player|teamsize)\|/.test(line))
      .map((line) => line === start ? (start === "|start" ? "|start|" : "|start") : line).join("\n");
    const equivalent = await engine.ingest(observation(3, `${projected}\n|player|p2|Bob|1\n|title|Recovered title`, "recovery"));
    assert.equal(equivalent.changed, false);
    assert.deepEqual(equivalent.identity, first.identity);
    assert.deepEqual(equivalent.snapshot!.canonicalEvidence, first.snapshot!.canonicalEvidence);
    const advanced = await engine.ingest(observation(4, `|request|${JSON.stringify({ ...privateRequest, rqid: 11 })}`));
    assert.equal(advanced.identity!.rqid, 11);
    assert.ok(!advanced.snapshot!.canonicalEvidence!.limitations.includes("recovery_chronology_quarantined"));
  }
});

test("recovery lexical normalization preserves arguments, repeated events and ordinal provenance", async () => {
  const boost = "|-boost|p2a: Dragapult|atk|1";
  const prefix = `${initial}\n${boost}\n${boost}`;
  for (const changed of [
    prefix.replace(boost, "|-boost|p2a: Dragapult|atk|2"),
    prefix.replace(boost, `${boost}|`),
    prefix.replace("\n|start\n", "\n|start||\n"),
    prefix.replace("|turn|13", "|turn|14")
  ]) {
    const engine = new DecisionEngine();
    const first = await engine.ingest(observation(1, prefix));
    const recovered = await engine.ingest(observation(2, `${changed}\n${boost}`, "recovery"));
    assert.ok(recovered.snapshot!.canonicalEvidence!.limitations.includes("recovery_chronology_quarantined"));
    assert.deepEqual(recovered.snapshot!.canonicalEvidence!.facts, first.snapshot!.canonicalEvidence!.facts);
    assert.equal(recovered.snapshot!.opponentSide.active!.boosts.atk, 2);
  }
  const engine = new DecisionEngine();
  const first = await engine.ingest(observation(1, prefix));
  const recoveredData = `${prefix.replace("\n|start\n", "\n|start|\n")}\n${boost}`;
  const recovered = await engine.ingest(observation(2, recoveredData, "recovery"));
  const facts = recovered.snapshot!.canonicalEvidence!.facts;
  assert.deepEqual(facts.slice(0, -1), first.snapshot!.canonicalEvidence!.facts);
  assert.equal(recovered.snapshot!.opponentSide.active!.boosts.atk, 3);
  assert.equal(new Set(facts.map((fact) => fact.id)).size, facts.length);
  assert.deepEqual(facts.at(-1)!.source, { observationId: "capture-2", sequence: 2, lineIndex: recoveredData.split("\n").length - 1, channel: "recovery" });
});

test("canonical observation ingestion is ordered, idempotent, and rejects ID reuse", async () => {
  const engine = new DecisionEngine();
  const first = observation(1, initial);
  const result = await engine.ingest(first);
  assert.ok(result.identity);
  assert.equal(result.identity.stateRevision, 1);
  assert.equal(result.identity.requestKind, "move");
  const duplicate = await engine.ingest(first);
  assert.equal(duplicate.applied, false);
  assert.deepEqual(duplicate.identity, result.identity);
  await assert.rejects(engine.ingest({ ...first, data: `${initial}\n|-boost|p2a: Dragapult|atk|1` }), /reused/);
  await engine.ingest(observation(3, "|-boost|p2a: Dragapult|atk|1"));
  await assert.rejects(engine.ingest(observation(2, "|-boost|p2a: Dragapult|atk|1")), /Out-of-order/);
  await engine.ingest(observation(4, "|-boost|p2a: Dragapult|atk|1"));
  const current = await engine.read("capture", roomId);
  assert.equal(current.snapshot!.opponentSide.active!.boosts.atk, 2); // Identical legitimate observations both count.
  assert.ok(current.identity!.stateRevision > result.identity.stateRevision);
  assert.ok(engine.observationReferences("capture", roomId).every((reference) => reference.observationId && reference.sequence > 0));
});

test("a conflicting batch or failed history commit changes no canonical state, sequence or observation IDs", async () => {
  const engine = new DecisionEngine();
  await engine.ingest(observation(1, initial));
  const before = await engine.read("capture", roomId);
  const references = engine.observationReferences("capture", roomId);
  const valid = observation(2, "|-boost|p2a: Dragapult|atk|1");
  let commits = 0;
  await assert.rejects(engine.ingestBatch([valid, { ...observation(1, "|turn|100"), observationId: "conflicting" }], async () => { commits++; }), /Out-of-order/);
  assert.equal(commits, 0);
  assert.deepEqual(await engine.read("capture", roomId), before);
  assert.deepEqual(engine.observationReferences("capture", roomId), references);
  await assert.rejects(engine.ingestBatch([valid], async () => { throw new Error("Disk unavailable"); }), /Disk unavailable/);
  assert.deepEqual(await engine.read("capture", roomId), before);
  const committed = await engine.ingestBatch([valid]);
  assert.equal(committed[0]!.applied, true);
  assert.equal((await engine.ingestBatch([valid]))[0]!.applied, false);
});

test("stale and conflicting private recovery is quarantined before stats, HP and item reduction", async () => {
  const engine = new DecisionEngine();
  const current = structuredClone(privateRequest);
  current.rqid = 10;
  current.side.pokemon[0].condition = "50/100";
  current.side.pokemon[0].stats.spe = 200;
  current.side.pokemon[0].item = "";
  await engine.ingest(observation(1, `${initial}\n|request|${JSON.stringify(current)}`));
  const before = await engine.read("capture", roomId);
  const stale = structuredClone(current);
  stale.rqid = 9; stale.side.pokemon[0].condition = "100/100"; stale.side.pokemon[0].stats.spe = 999; stale.side.pokemon[0].item = "Choice Scarf";
  const recovered = await engine.ingest(observation(2, `|request|${JSON.stringify(stale)}\n|sso-state|${JSON.stringify({ pokemon: [{ ...stale.side.pokemon[0], side: "p1" }] })}`, "recovery"));
  assert.deepEqual(recovered.snapshot!.yourSide.active, before.snapshot!.yourSide.active);
  assert.deepEqual(recovered.snapshot!.legalActions, before.snapshot!.legalActions);
  stale.rqid = 10;
  const quarantined = await engine.ingest(observation(3, `|request|${JSON.stringify(stale)}`, "recovery"));
  assert.deepEqual(quarantined.identity, recovered.identity);
  assert.equal(quarantined.room.quarantinedRequests[0].reason, "same_epoch_recovery_conflict");
  const idempotent = await engine.ingest(observation(4, `|request|${JSON.stringify(current)}`, "recovery"));
  assert.deepEqual(idempotent.snapshot!.yourSide.active, before.snapshot!.yourSide.active);
  const newer = { ...stale, rqid: 11 };
  const accepted = await engine.ingest(observation(5, `|request|${JSON.stringify(newer)}`, "recovery"));
  assert.equal(accepted.identity!.rqid, 11);
  assert.equal(accepted.snapshot!.yourSide.active!.stats!.spe, 999);
  assert.equal(accepted.snapshot!.yourSide.active!.conditionText, "100/100");
});

test("shown feedback and observation commit share an engine-first order", async () => {
  const engine = new DecisionEngine();
  const first = await engine.ingest(observation(1, initial));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const order: string[] = [];
  const feedback = engine.withCurrent("capture", first.identity!, async () => {
    entered(); await gate; order.push("feedback persisted");
  });
  await started;
  const ingest = engine.ingestBatch([observation(2, "|-boost|p2a: Dragapult|atk|1")], async () => { order.push("observations persisted"); });
  assert.deepEqual((await engine.read("capture", roomId)).identity, first.identity);
  release();
  await Promise.all([feedback, ingest]);
  assert.deepEqual(order, ["feedback persisted", "observations persisted"]);
  await assert.rejects(engine.withCurrent("capture", first.identity!, async () => { order.push("stale feedback"); }), /no longer current/);
});

test("request N and reconnect identities are invalid after N+1 even on the same turn", async () => {
  const engine = new DecisionEngine();
  await engine.ingest(observation(1, initial));
  const request = (rqid: number) => `|request|${JSON.stringify({ ...privateRequest, rqid })}`;
  const older = await engine.ingest(observation(2, request(47)));
  const newer = await engine.ingest(observation(3, request(48)));
  assert.equal(older.snapshot!.turn, newer.snapshot!.turn);
  assert.equal(sameCanonicalDecision(older.identity!, newer.identity!), false);
  await assert.rejects(engine.assertCurrent("capture", older.identity!), /no longer current/);
  const reconnected = await engine.ingest(observation(4, `${initial}\n${request(48)}`));
  assert.ok(reconnected.identity!.stateRevision > newer.identity!.stateRevision);
  await assert.rejects(engine.assertCurrent("capture", newer.identity!), /no longer current/);
  await assert.rejects(engine.assertCurrent("different-capture", newer.identity!), /Unknown/);
});

test("recovery cannot resurrect wire-cleared fields or replace the current request", async () => {
  const engine = new DecisionEngine();
  await engine.ingest(observation(1, `${initial}\n|request|${JSON.stringify({ ...privateRequest, rqid: 10 })}`));
  await engine.ingest(observation(2, "|-curestatus|p2a: Dragapult|brn\n|-enditem|p2a: Dragapult|Leftovers\n|-clearboost|p2a: Dragapult\n|-weather|none\n|-sideend|p1: Alice|Stealth Rock"));
  const before = await engine.read("capture", roomId);
  const recovered = await engine.ingest(observation(3, `${initial}\n|-boost|p2a: Dragapult|atk|2\n|-item|p2a: Dragapult|Leftovers\n|-weather|SunnyDay\n|-sidestart|p1: Alice|Stealth Rock\n|request|${JSON.stringify({ ...privateRequest, rqid: 9 })}`, "recovery"));
  assert.equal(recovered.snapshot!.opponentSide.active!.status, null);
  assert.equal(recovered.snapshot!.opponentSide.active!.item, null);
  assert.deepEqual(recovered.snapshot!.opponentSide.active!.boosts, {});
  assert.equal(recovered.snapshot!.field.weather, null);
  assert.deepEqual(recovered.snapshot!.field.yourSideConditions, []);
  assert.equal(recovered.identity!.rqid, 10);
  assert.deepEqual(recovered.snapshot!.legalActions, before.snapshot!.legalActions);
  assert.deepEqual(recovered.snapshot!.recentLog, before.snapshot!.recentLog);
  assert.equal(recovered.snapshot!.phase, before.snapshot!.phase);
  await engine.ingest(observation(4, "|move|p2a: Dragapult|Shadow Ball|p1a: Great Tusk"));
  const resolving = await engine.read("capture", roomId);
  const staleRequest = await engine.ingest(observation(5, `${initial}\n|request|${JSON.stringify({ ...privateRequest, rqid: 10 })}`, "recovery"));
  assert.equal(staleRequest.identity!.requestKind, "resolving");
  assert.deepEqual(staleRequest.snapshot!.legalActions, []);
  assert.deepEqual(staleRequest.snapshot!.recentLog, resolving.snapshot!.recentLog);
  await engine.ingest(observation(6, "|tie"));
  const afterTie = await engine.ingest(observation(7, initial, "recovery"));
  assert.equal(afterTie.snapshot!.phase, "finished");
  assert.deepEqual(afterTie.snapshot!.legalActions, []);
  await assert.rejects(engine.ingest({ ...observation(8, "|turn|20"), roomId: "battle-gen9uu-wrong" }), /routing differ/);
});


test("client-enriched recovery is acknowledged without restoring expired actions or blocking later capture", async () => {
  for (const preact of [false, true]) {
    const engine = new DecisionEngine();
    const request = { ...structuredClone(privateRequest), rqid: 10 };
    const enriched: any = structuredClone(request);
    enriched.requestType = "move";
    if (preact) Object.assign(enriched.side.pokemon[0], { name: "Great Tusk", hp: 295, maxhp: 434, speciesForme: "Great Tusk", gender: "N" });
    await engine.ingest(observation(1, `${initial}\n|request|${JSON.stringify(request)}`));
    await engine.ingest(observation(2, "|move|p2a: Dragapult|Shadow Ball|p1a: Great Tusk"));
    const before = await engine.read("capture", roomId);
    const recovered = await engine.ingest(observation(3, `|request|${JSON.stringify(enriched)}`, "recovery"));
    assert.deepEqual(recovered.identity, before.identity);
    assert.deepEqual(recovered.snapshot, { ...before.snapshot, capturedAt: recovered.snapshot!.capturedAt });
    assert.equal(recovered.room.quarantinedRequests.length, 1);
    assert.equal((await engine.ingest(observation(4, "|turn|15"))).applied, true);
  }
});

test("recovery epoch classification advances within one frame and quarantines conflicting repeats", async () => {
  const engine = new DecisionEngine();
  const request = (rqid: number, spe: number) => {
    const value = structuredClone(privateRequest); value.rqid = rqid; value.side.pokemon[0].stats.spe = spe;
    return `|request|${JSON.stringify(value)}`;
  };
  await engine.ingest(observation(1, `${initial}\n${request(10, 200)}`));
  const recovered = await engine.ingest(observation(2, [request(12, 212), request(11, 211), request(12, 999)].join("\n"), "recovery"));
  assert.equal(recovered.identity!.rqid, 12);
  assert.equal(recovered.snapshot!.yourSide.active!.stats!.spe, 212);
  assert.equal(recovered.room.quarantinedRequests.length, 1);
  assert.equal(recovered.room.quarantinedRequests[0].rqid, 12);
});

// Sanitized from the actual Chrome req-18/19 public suffix/recovery pair.
const coldPreview = [
  "|gametype|singles", "|tier|[Gen 9] UU", "|clearpoke",
  ...["Infernape, F", "Sinistcha", "Tinkaton, F", "Latios, M", "Thundurus, M", "Mandibuzz, F"].map((name) => `|poke|p1|${name}|`),
  ...["Cinccino, M", "Talonflame, M", "Yanmega, M", "Fezandipiti, M", "Drifblim, F", "Gyarados, M"].map((name) => `|poke|p2|${name}|`),
  "|teampreview"
].join("\n");
const coldTail = "|teamsize|p1|6\n|teamsize|p2|6\n|start\n|switch|p1a: Infernape|Infernape, F|100/100\n|switch|p2a: Fezandipiti|Fezandipiti, M|100/100\n|turn|1";

test("a unique cold public suffix bootstraps the missing prefix with original overlap provenance", async () => {
  const full = `${coldPreview}\n${coldTail}`;
  const control = await new DecisionEngine().ingest(observation(1, full, "recovery"));
  for (const split of [false, true]) {
    const engine = new DecisionEngine();
    const packets = split ? [coldTail.split("\n").slice(0, 4).join("\n"), coldTail.split("\n").slice(4).join("\n")] : [coldTail];
    let sequence = 0;
    for (const packet of packets) await engine.ingest(observation(++sequence, packet));
    const before = await engine.read("capture", roomId);
    const recovered = await engine.ingest(observation(++sequence, `${full}\n|sso-state|{"pokemon":[]}`, "recovery"));
    assert.equal(recovered.room.format, "[Gen 9] UU");
    assert.equal(recovered.snapshot, null);
    const evidence = recovered.room.canonicalEvidence;
    assert.equal(evidence.facts.filter((fact: any) => fact.kind === "poke").length, 12);
    assert.equal(Object.keys(recovered.room.sides.p1.team).length, 6);
    assert.equal(Object.keys(recovered.room.sides.p2.team).length, 6);
    assert.ok(!evidence.limitations.includes("recovery_chronology_quarantined"));
    assert.deepEqual(evidence.facts.map(({ source, ...fact }: any) => fact), control.room.canonicalEvidence.facts.map(({ source, ...fact }: any) => fact));
    for (const fact of before.room.canonicalEvidence.facts) {
      const retained = evidence.facts.find((entry: any) => entry.kind === fact.kind && JSON.stringify(entry.args) === JSON.stringify(fact.args));
      assert.deepEqual(retained.source, fact.source);
    }
    assert.ok(evidence.facts.filter((fact: any) => fact.kind === "poke").every((fact: any) => fact.source.channel === "recovery"));
    assert.ok(evidence.contributions.every((entry: any) => entry.eligibility === "quarantined"));
    const repeated = await engine.ingest(observation(++sequence, full, "recovery"));
    assert.deepEqual(repeated.room.canonicalEvidence, evidence);
    assert.equal(repeated.changed, false);
    assert.ok(engine.observationReferences("capture", roomId).some((entry) => entry.line.startsWith("|sso-state|")), "raw inputs remain retained even when ignored");
  }
});

test("cold bootstrap leaves conflicts, multiple overlaps, interior matches and anchored histories quarantined", async () => {
  const tail = "|switch|p2a: Fezandipiti|Fezandipiti, M|100/100\n|turn|3";
  for (const [before, recovery] of [
    [tail, `${coldPreview}\n|start\n${tail}\n${tail}`],
    [tail, `${coldPreview}\n|start\n|start\n${tail}`],
    [tail, `${coldPreview}\n|start\n${tail}\n|turn|4`],
    [tail, `${coldPreview}\n|start\n${tail.replace("100/100", "50/100")}`],
    [`|init|battle\n${tail}`, `${coldPreview}\n|start\n${tail}`],
    [`|tier|[Gen 9] OU\n${tail}`, `${coldPreview}\n|start\n${tail}`]
  ]) {
    const engine = new DecisionEngine();
    const first = await engine.ingest(observation(1, before!));
    const after = await engine.ingest(observation(2, recovery!, "recovery"));
    assert.deepEqual(after.room.canonicalEvidence.facts, first.room.canonicalEvidence.facts);
    assert.ok(after.room.canonicalEvidence.limitations.includes("recovery_chronology_quarantined"));
  }
});

test("cold bootstrap preserves partial metadata order, reconnect hashes and confirmed history", async () => {
  const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } = await import("../history/opponentIntelStore.js");
  const prefix = "|tier|[Gen 9] UU\n|gametype|singles\n|clearpoke\n|poke|p1|Slowking\n|poke|p2|Donphan";
  const sizes = ["|teamsize|p1|1", "|teamsize|p2|1"];
  const tail = "|start\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|Donphan|100/100\n|move|p2a: Elephant|Earthquake|p1a: Friend\n|turn|2";
  const full = `${prefix}\n${sizes.join("\n")}\n${tail}`;
  const request = `|request|${JSON.stringify({ rqid: 1, active: [{ moves: [{ move: "Scald", id: "scald", pp: 15 }] }],
    side: { id: "p1", pokemon: [{ ident: "p1: Friend", details: "Slowking", condition: "350/350", active: true,
      moves: ["scald"], baseAbility: "Regenerator", item: "", stats: { spe: 100 } }] } })}`;
  const live = await new DecisionEngine().ingest(observation(1, `${full}\n${request}`));
  const confirmed = await projectCanonicalSnapshots([live.snapshot!], await createEphemeralIntelEvaluationContext());
  let expectedHash: string | undefined;
  for (const retained of [[], [sizes[0]!], [sizes[1]!], [...sizes].reverse()]) {
    const engine = new DecisionEngine();
    let sequence = 0;
    const before = retained.length ? await engine.ingest(observation(++sequence, `${retained.join("\n")}\n${tail}`)) : null;
    const boot = await engine.ingest(observation(++sequence, full, "recovery"));
    assert.deepEqual(boot.room.canonicalEvidence.limitations, ["recovery_public_continuity_unknown"]);
    const snapshot = await engine.ingest(observation(++sequence, request));
    expectedHash ??= snapshot.identity!.snapshotHash;
    assert.equal(snapshot.identity!.snapshotHash, expectedHash);
    assert.deepEqual(snapshot.room.canonicalEvidence.facts.filter((fact: any) => fact.kind === "teamsize").map((fact: any) => fact.args[0]), ["p1", "p2"]);
    for (const prior of before?.room.canonicalEvidence.facts ?? []) {
      const retainedFact = snapshot.room.canonicalEvidence.facts.find((fact: any) => fact.kind === prior.kind && JSON.stringify(fact.args) === JSON.stringify(prior.args));
      assert.deepEqual(retainedFact.source, prior.source, "canonical order retains the original observation ancestry");
    }
    const restored = await projectCanonicalSnapshots([snapshot.snapshot!], confirmed);
    const advanced = await engine.ingest(observation(++sequence, "|move|p2a: Elephant|Knock Off|p1a: Friend"));
    const next = await projectCanonicalSnapshots([advanced.snapshot!], restored);
    const battle = next.store.canonicalBattles![roomId]!;
    assert.equal(battle.lineageConflict, undefined);
    assert.equal(next.revision, confirmed.revision, "later wire facts cannot promote an unbound recovered capture");
    assert.ok(!battle.contributions.some((entry) => entry.metric === "move" && entry.value === "Knock Off"));
    const authoritative = await engine.ingest(observation(++sequence, `|init|battle\n${full}\n${request}\n|move|p2a: Elephant|Knock Off|p1a: Friend`));
    const committed = await projectCanonicalSnapshots([authoritative.snapshot!], next);
    assert.ok(committed.store.canonicalBattles![roomId]!.contributions.some((entry) => entry.metric === "move" && entry.value === "Knock Off" && entry.eligibility === "active"));
  }
  for (const metadata of [`${sizes[0]}\n${sizes[0]}`, "|player|p1|Missing from recovery"]) {
    const engine = new DecisionEngine();
    const before = await engine.ingest(observation(1, `${metadata}\n${tail}`));
    const recovered = await engine.ingest(observation(2, full, "recovery"));
    assert.deepEqual(recovered.room.canonicalEvidence.facts, before.room.canonicalEvidence.facts);
    assert.ok(recovered.room.canonicalEvidence.limitations.includes("recovery_chronology_quarantined"));
  }
});

test("cold bootstrap replays explicit wire clears after the restored prefix", async () => {
  const engine = new DecisionEngine();
  const tail = "|-enditem|p2a: Fezandipiti|Leftovers\n|-curestatus|p2a: Fezandipiti|brn\n|-clearboost|p2a: Fezandipiti\n|-weather|none\n|turn|3";
  await engine.ingest(observation(1, tail));
  const result = await engine.ingest(observation(2, `${coldPreview}\n${coldTail}\n|-item|p2a: Fezandipiti|Leftovers\n|-status|p2a: Fezandipiti|brn\n|-boost|p2a: Fezandipiti|atk|2\n|-weather|SunnyDay\n${tail}`, "recovery"));
  const active = result.room.sides.p2.team[result.room.sides.p2.activeKey];
  assert.equal(active.item, null);
  assert.equal(active.status, null);
  assert.deepEqual(active.boosts, {});
  assert.equal(result.room.field.weather, null);
  assert.equal(result.room.canonicalEvidence.facts.find((fact: any) => fact.kind === "-enditem").source.channel, "protocol");
});

test("bootstrap never renumbers private history or resurrects its expired request epoch", async () => {
  const engine = new DecisionEngine();
  const request = { ...privateRequest, rqid: 10 };
  const tail = `${coldTail}\n|request|${JSON.stringify(request)}\n|move|p2a: Fezandipiti|Moonblast|p1a: Infernape`;
  const before = await engine.ingest(observation(1, tail));
  const after = await engine.ingest(observation(2, `${coldPreview}\n${tail}\n|request|${JSON.stringify({ ...request, requestType: "move" })}`, "recovery"));
  assert.deepEqual(after.snapshot!.canonicalEvidence!.facts, before.snapshot!.canonicalEvidence!.facts);
  assert.equal(after.identity!.rqid, 10);
  assert.equal(after.identity!.requestKind, "resolving");
  assert.deepEqual(after.snapshot!.legalActions, []);
  assert.ok(after.snapshot!.canonicalEvidence!.limitations.includes("recovery_chronology_quarantined"));
  assert.equal(after.room.quarantinedRequests.length, 1);
});

test("bootstrapped public history reuses confirmed full IDs and later rebinds contributions without duplication", async () => {
  const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } = await import("../history/opponentIntelStore.js");
  const own = structuredClone(privateRequest); own.rqid = 10;
  const privateLine = `|request|${JSON.stringify(own)}`;
  const move = "|move|p2a: Fezandipiti|Moonblast|p1a: Infernape";
  const full = `${coldPreview}\n${coldTail}\n${move}`;
  const live = await new DecisionEngine().ingest(observation(1, `${full}\n${privateLine}`));
  const confirmed = await projectCanonicalSnapshots([live.snapshot!], await createEphemeralIntelEvaluationContext());
  const engine = new DecisionEngine();
  const tail = await engine.ingest(observation(1, `${coldTail}\n${move}`));
  assert.equal(tail.snapshot, null, "unanchored IDs have no private snapshot to persist");
  await engine.ingest(observation(2, full, "recovery"));
  const recovered = await engine.ingest(observation(3, privateLine));
  const restored = await projectCanonicalSnapshots([recovered.snapshot!], confirmed);
  assert.deepEqual(restored.store.canonicalBattles![roomId], confirmed.store.canonicalBattles![roomId]);
  const revealed = await engine.ingest(observation(4, "|replace|p2a: Fox|Zoroark-Hisui|100/100"));
  const rebound = await projectCanonicalSnapshots([revealed.snapshot!], restored);
  assert.deepEqual(rebound, restored, "post-gap replacement cannot refine trusted historical identity");
  assert.ok(revealed.snapshot!.canonicalEvidence!.facts.some((fact) => fact.kind === "replace"));
  const authoritative = await engine.ingest(observation(5, `|init|battle\n${full}\n${privateLine}\n|replace|p2a: Fox|Zoroark-Hisui|100/100`));
  const reconciled = await projectCanonicalSnapshots([authoritative.snapshot!], rebound);
  const contributions = reconciled.store.canonicalBattles![roomId]!.contributions;
  assert.equal(contributions.length, confirmed.store.canonicalBattles![roomId]!.contributions.length);
  assert.ok(contributions.every((entry) => entry.species === "Zoroark-Hisui" && entry.eligibility === "active"));
  assert.equal(new Set(contributions.map((entry) => entry.id)).size, contributions.length);
});

test("a null private request revokes actions and identity without discarding the established private party", async () => {
  const engine = new DecisionEngine(ownedSource);
  await engine.ingestBatch([observation(1, "|init|battle"), observation(2, ownedStart), observation(3, ownedRequest(10))]);
  const before = await engine.read("capture", roomId);
  assert.ok(before.snapshot!.turnCoverage);
  assert.ok(before.snapshot!.legalActions.length);
  const revoke = observation(4, "|request|null");
  const after = await engine.ingest(revoke);
  assert.equal(after.applied, true);
  assert.equal(after.changed, true);
  assert.deepEqual(after.snapshot!.yourSide, before.snapshot!.yourSide);
  assert.deepEqual(after.snapshot!.opponentSide, before.snapshot!.opponentSide);
  assert.equal(after.room.playerSide, before.room.playerSide);
  assert.equal(after.room.lastRequest, null);
  assert.equal(after.room.requestCurrent, false);
  assert.equal(after.snapshot!.rawRequestSummary, null);
  assert.deepEqual(after.snapshot!.legalActions, []);
  assert.equal(after.snapshot!.turnCoverage, undefined);
  assert.equal(after.identity!.rqid, null);
  assert.equal(after.identity!.requestKind, "none");
  assert.ok(after.identity!.stateRevision > before.identity!.stateRevision);
  assert.notEqual(after.identity!.snapshotHash, before.identity!.snapshotHash);
  assert.notEqual(after.identity!.legalActionSetHash, before.identity!.legalActionSetHash);
  await assert.rejects(engine.assertCurrent("capture", before.identity!), /no longer current/);
  const repeated = await engine.ingest(revoke);
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.identity, after.identity);
  const another = await engine.ingest(observation(5, "|request|null"));
  assert.deepEqual(another.snapshot!.yourSide, after.snapshot!.yourSide);
  assert.equal(another.identity!.rqid, null);
  assert.equal(another.identity!.requestKind, "none");
  assert.deepEqual(another.snapshot!.legalActions, []);
  assert.equal(another.snapshot!.turnCoverage, undefined);
});

test("revocation retains the last numbered epoch against stale, same-epoch and unnumbered recovery", async () => {
  const current = structuredClone(privateRequest);
  current.rqid = 10;
  current.side.pokemon[0].condition = "50/100";
  current.side.pokemon[0].stats.spe = 200;
  current.side.pokemon[0].item = "";
  const conflict = structuredClone(current);
  conflict.side.pokemon[0].condition = "100/100";
  conflict.side.pokemon[0].stats.spe = 999;
  conflict.side.pokemon[0].item = "Choice Scarf";
  const unnumbered = structuredClone(conflict); delete unnumbered.rqid;
  for (const recovered of [{ ...conflict, rqid: 9 }, current, conflict, unnumbered, null]) {
    const engine = new DecisionEngine();
    await engine.ingest(observation(1, `${initial}\n|request|${JSON.stringify(current)}\n|request|null`));
    const revoked = await engine.read("capture", roomId);
    const after = await engine.ingest(observation(2, `|request|${JSON.stringify(recovered)}`, "recovery"));
    assert.deepEqual(after.snapshot!.yourSide, revoked.snapshot!.yourSide);
    assert.deepEqual(after.snapshot!.legalActions, []);
    assert.equal(after.identity!.rqid, null);
    assert.equal(after.identity!.requestKind, "none");
    assert.deepEqual(after.identity, revoked.identity);
    const restored = await engine.ingest(observation(3, `|request|${JSON.stringify({ ...conflict, rqid: 11 })}`, "recovery"));
    assert.equal(restored.identity!.rqid, 11);
    assert.equal(restored.identity!.requestKind, "move");
    assert.ok(restored.snapshot!.legalActions.length);
    assert.equal(restored.snapshot!.yourSide.active!.stats!.spe, 999);
  }
});

test("numbered request and revocation in one batch preserve epoch ordering and later restoration", async () => {
  const engine = new DecisionEngine();
  await engine.ingestBatch([observation(1, initial), observation(2, `${ownedRequest(10)}\n|request|null`)]);
  const revoked = await engine.read("capture", roomId);
  const stale = await engine.ingest(observation(3, `${ownedRequest(9)}\n${ownedRequest(10)}`, "recovery"));
  assert.deepEqual(stale.identity, revoked.identity);
  const restored = await engine.ingest(observation(4, `${ownedRequest(11)}\n${ownedRequest(10)}`, "recovery"));
  assert.equal(restored.identity!.rqid, 11);
  assert.ok(restored.snapshot!.legalActions.length);
  const next = await engine.ingest(observation(5, `${ownedRequest(12)}\n|request|null`));
  const same = await engine.ingest(observation(6, ownedRequest(12), "recovery"));
  assert.deepEqual(same.identity, next.identity);
  assert.equal(same.identity!.rqid, null);
  assert.deepEqual(same.snapshot!.legalActions, []);
  assert.equal((await engine.ingest(observation(7, ownedRequest(13), "recovery"))).identity!.rqid, 13);
});

test("a cold null request is valid but malformed private primitives remain rejected transactionally", async () => {
  const cold = new DecisionEngine();
  const first = await cold.ingest(observation(1, "|request|null"));
  assert.equal(first.snapshot, null);
  assert.equal(first.room.lastRequest, null);
  assert.deepEqual(first.room.legalActions, []);
  assert.equal((await cold.ingest(observation(2, ownedRequest(1)))).identity!.rqid, 1);
  const before = await cold.read("capture", roomId);
  for (const malformed of ["false", "0", '"request"', "[]"]) {
    await assert.rejects(cold.ingest(observation(3, `|request|${malformed}`)), /Malformed canonical private request/);
    assert.deepEqual(await cold.read("capture", roomId), before);
  }
  await assert.rejects(cold.ingestBatch([observation(3, "|request|null"), observation(4, "|request|false")]), /Malformed canonical private request/);
  assert.deepEqual(await cold.read("capture", roomId), before, "a rejected batch cannot partially revoke the current request");
});


function nativeSlowStartGap(openingAttacks = false) {
  const texts = [`Regigigas @ Leftovers
Ability: Slow Start
EVs: 252 HP / 252 Spe
Jolly Nature
- Protect
- Body Slam
- Thunderbolt
- Rest

Blissey @ Heavy-Duty Boots
Ability: Natural Cure
EVs: 252 HP / 252 Def
Bold Nature
- Protect
- Soft-Boiled
- Seismic Toss
- Thunder Wave`, `Slowking @ Leftovers
Ability: Regenerator
EVs: 252 HP / 252 Def
Serious Nature
- Protect
- Slack Off
- Skill Swap
- Surf`];
  const teams = texts.map((text) => Teams.import(text)!);
  for (const team of teams) assert.deepEqual(TeamValidator.get("gen9uu").validateTeam(team), null);
  const battle = new Battle({ formatid: "gen9uu" as ConstructorParameters<typeof Battle>[0]["formatid"], seed: "9,4,2,7" });
  try {
    battle.setPlayer("p1", { name: "Player A", team: Teams.pack(teams[0]!) });
    battle.setPlayer("p2", { name: "Player B", team: Teams.pack(teams[1]!) });
    const previewPublic = extractChannelMessages(battle.log.join("\n"), [1])[1]!.join("\n");
    const previewRequest = { ...structuredClone(battle.sides[0].activeRequest), rqid: 0 };
    battle.makeChoices("team 12", "team 1");
    if (openingAttacks) battle.makeChoices("move 2", "move 4");
    const publicAtStart = extractChannelMessages(battle.log.join("\n"), [1])[1]!.join("\n");
    const startRequest = { ...structuredClone(battle.sides[0].activeRequest), rqid: openingAttacks ? 2 : 1 };
    let publicAtSecond = publicAtStart;
    let secondRequest = { ...structuredClone(battle.sides[0].activeRequest), rqid: 2 };
    for (let turn = openingAttacks ? 2 : 1; turn <= 7; turn++) {
      battle.makeChoices("move 1", "move 1");
      if (battle.turn === 2) {
        publicAtSecond = extractChannelMessages(battle.log.join("\n"), [1])[1]!.join("\n");
        secondRequest = { ...structuredClone(battle.sides[0].activeRequest), rqid: 2 };
      }
    }
    const publicAtEnd = extractChannelMessages(battle.log.join("\n"), [1])[1]!.join("\n");
    const endRequest = { ...structuredClone(battle.sides[0].activeRequest), rqid: 8 };
    assert.equal(battle.turn, 8);
    assert.equal(battle.sides[0].active[0]!.getStat("spe"), 328);
    assert.ok(publicAtEnd.slice(publicAtStart.length).includes("|-end|p1a: Regigigas|Slow Start"));
    return { previewPublic, previewRequest, publicAtStart, publicAtSecond, publicAtEnd, startRequest, secondRequest, endRequest,
      initial: `|init|battle\n${publicAtStart}\n|request|${JSON.stringify(startRequest)}`,
      suffix: publicAtEnd.slice(publicAtStart.length).trim(), nativeSpeed: 328 };
  } finally { battle.destroy(); }
}

test("a native T1 to T8 request-only recovery cannot carry a timed activation across missing public history", async () => {
  const fixture = nativeSlowStartGap(), engine = new DecisionEngine();
  const first = await engine.ingest(observation(1, fixture.initial));
  assert.equal(first.snapshot!.yourSide.active!.slowStartActive, true);
  assert.equal(effectiveSpeed(9, 328, first.snapshot!.yourSide.active!, [], first.snapshot!.field), 164);
  const facts = structuredClone(first.snapshot!.canonicalEvidence!.facts);
  const recovered = await engine.ingest(observation(2, `|request|${JSON.stringify(fixture.endRequest)}`, "recovery"));
  assert.equal(recovered.identity!.rqid, 8);
  assert.equal(recovered.snapshot!.turn, 1, "do not invent a missing turn boundary from rqid");
  assert.equal(recovered.snapshot!.yourSide.active!.slowStartActive, undefined);
  assert.equal(effectiveSpeed(9, 328, recovered.snapshot!.yourSide.active!, [], recovered.snapshot!.field), null);
  assert.deepEqual(recovered.snapshot!.canonicalEvidence!.facts.slice(0, facts.length), facts);
  assert.ok(recovered.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  const evaluated = await evaluateDecision(engine, "capture", recovered.identity!, await createEphemeralIntelEvaluationContext());
  assert.equal(evaluated.semantic.capabilities.actionable, false);
  assert.equal(evaluated.semantic.localIntel.selfActionRecommendation, undefined);
  assert.equal(evaluated.semantic.localIntel.speedPreview, undefined);
  const later = await engine.ingest(observation(3, `|request|${JSON.stringify({ ...fixture.endRequest, rqid: 9 })}`));
  assert.ok(later.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  assert.equal(later.snapshot!.yourSide.active!.slowStartActive, undefined);
});

test("empty, short and copied stale queues cannot certify an advanced recovery epoch", async () => {
  const fixture = nativeSlowStartGap();
  for (const prefix of ["", "|start", fixture.publicAtStart.split("\n").slice(0, -1).join("\n"), fixture.publicAtStart,
    `${fixture.publicAtStart}\n|turn|8`]) {
    const engine = new DecisionEngine();
    await engine.ingest(observation(1, fixture.initial));
    const recovered = await engine.ingest(observation(2, `${prefix}\n|request|${JSON.stringify(fixture.endRequest)}`, "recovery"));
    assert.ok(recovered.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"), prefix);
    assert.equal(recovered.snapshot!.yourSide.active!.slowStartActive, undefined);
  }
  const stale = new DecisionEngine();
  await stale.ingest(observation(1, fixture.initial));
  await stale.ingest(observation(2, "|turn|2"));
  const recovered = await stale.ingest(observation(3, `${fixture.publicAtStart}\n|request|${JSON.stringify(fixture.endRequest)}`, "recovery"));
  assert.ok(recovered.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
});

test("same-epoch idempotence and stale private recovery preserve the current known activation", async () => {
  const fixture = nativeSlowStartGap();
  for (const request of [fixture.startRequest, { ...fixture.endRequest, rqid: 0 }, { ...fixture.endRequest, rqid: undefined }]) {
    const engine = new DecisionEngine();
    const first = await engine.ingest(observation(1, fixture.initial));
    const recovered = await engine.ingest(observation(2, `|request|${JSON.stringify(request)}`, "recovery"));
    assert.equal(recovered.changed, false);
    assert.deepEqual(recovered.identity, first.identity);
    assert.deepEqual(recovered.snapshot, { ...first.snapshot, capturedAt: recovered.snapshot!.capturedAt });
    assert.equal(recovered.snapshot!.yourSide.active!.slowStartActive, true);
  }
});

test("authoritative expiry stays actionable while apparently complete private recovery remains unbound", async () => {
  const fixture = nativeSlowStartGap();
  for (const source of ["protocol", "recovery"] as const) {
    const engine = new DecisionEngine();
    await engine.ingest(observation(1, fixture.initial));
    const data = source === "protocol" ? fixture.suffix : fixture.publicAtEnd;
    const expired = await engine.ingest(observation(2, `${data}\n|request|${JSON.stringify(fixture.endRequest)}`, source));
    assert.equal(expired.snapshot!.turn, 8);
    const evaluated = await evaluateDecision(engine, "capture", expired.identity!, await createEphemeralIntelEvaluationContext());
    if (source === "protocol") {
      assert.equal(expired.snapshot!.yourSide.active!.slowStartActive, false);
      assert.equal(effectiveSpeed(9, 328, expired.snapshot!.yourSide.active!, [], expired.snapshot!.field), fixture.nativeSpeed);
      assert.ok(!expired.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
      assert.equal(evaluated.semantic.capabilities.actionable, true);
      assert.ok(evaluated.semantic.localIntel.selfActionRecommendation);
      assert.equal(evaluated.semantic.localIntel.speedPreview!.yourActiveEffectiveSpeed, fixture.nativeSpeed);
    } else {
      assert.ok(expired.snapshot!.canonicalEvidence!.facts.some((fact) => fact.kind === "-end" && fact.args[1] === "Slow Start"));
      assert.ok(expired.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
      assert.equal(expired.snapshot!.yourSide.active!.slowStartActive, undefined);
      assert.equal(evaluated.semantic.capabilities.actionable, false);
      assert.equal(evaluated.semantic.localIntel.selfActionRecommendation, undefined);
    }
  }
});

test("post-gap lifecycle and reveal facts remain raw evidence without changing trusted observed history", async () => {
  const fixture = nativeSlowStartGap(true), engine = new DecisionEngine();
  const first = await engine.ingest(observation(1, fixture.initial));
  const trusted = await projectCanonicalSnapshots([first.snapshot!], await createEphemeralIntelEvaluationContext());
  const priorFacts = structuredClone(first.snapshot!.canonicalEvidence!.facts);
  const priorContributions = structuredClone(first.snapshot!.canonicalEvidence!.contributions);
  assert.ok(priorContributions.some((entry) => entry.metric === "move"));
  assert.ok(priorContributions.some((entry) => entry.metric === "damage" && entry.damage!.attacker.slowStartActive === true));
  const gap = await engine.ingest(observation(2, `|request|${JSON.stringify(fixture.endRequest)}`, "recovery"));
  const later = await engine.ingest(observation(3, [
    "|-item|p2a: Slowking|Choice Specs", "|-ability|p2a: Slowking|Own Tempo", "|move|p2a: Slowking|Surf|p1a: Regigigas",
    "|-damage|p1a: Regigigas|350/424", "|move|p1a: Regigigas|Body Slam|p2a: Slowking", "|-damage|p2a: Slowking|80/100",
    "|turn|9", "|replace|p2a: Fox|Zoroark-Hisui|80/100", "|detailschange|p2a: Fox|Zoroark-Hisui",
    "|switch|p2a: Slowking|Slowking|80/100", "|-start|p1a: Regigigas|ability: Slow Start",
    `|request|${JSON.stringify({ ...fixture.endRequest, rqid: 9 })}`
  ].join("\n")));
  assert.deepEqual(later.snapshot!.canonicalEvidence!.facts.slice(0, priorFacts.length), priorFacts);
  assert.ok(later.snapshot!.canonicalEvidence!.facts.some((fact) => fact.kind === "-item"));
  assert.ok(later.snapshot!.canonicalEvidence!.facts.some((fact) => fact.kind === "move"));
  assert.equal(later.snapshot!.yourSide.active!.slowStartActive, undefined);
  assert.deepEqual(later.snapshot!.canonicalEvidence!.contributions, priorContributions);
  const projected = await projectCanonicalSnapshots([gap.snapshot!, later.snapshot!], trusted);
  assert.equal(projected.revision, trusted.revision);
  assert.deepEqual(projected.store, trusted.store);
  assert.deepEqual((await createEphemeralIntelEvaluationContext()).store.canonicalBattles, undefined);
});

test("a rejected batch cannot leave a recovery-continuity quarantine or partial history context", async () => {
  const fixture = nativeSlowStartGap(), engine = new DecisionEngine();
  const first = await engine.ingest(observation(1, fixture.initial));
  const before = await engine.read("capture", roomId), refs = engine.observationReferences("capture", roomId);
  const context = await projectCanonicalSnapshots([first.snapshot!], await createEphemeralIntelEvaluationContext());
  let committed = false;
  const gap = observation(2, `|request|${JSON.stringify(fixture.endRequest)}`, "recovery");
  await assert.rejects(engine.ingestBatch([gap, observation(1, "|turn|9")], async () => { committed = true; }), /reused/);
  assert.equal(committed, false);
  assert.deepEqual(await engine.read("capture", roomId), before);
  assert.deepEqual(engine.observationReferences("capture", roomId), refs);
  assert.equal((await projectCanonicalSnapshots([before.snapshot!], context)).revision, context.revision);
  await assert.rejects(engine.ingestBatch([gap], async () => { throw new Error("History failed"); }), /History failed/);
  assert.deepEqual(await engine.read("capture", roomId), before);
});


// Matters: a page reload re-joins the same battle in a new capture session, and its full |init| replay can differ from
// the first capture's facts. Treating that as a lineage conflict withheld all damage, speed and threats for the rest of
// the battle. A complete replay from |init| supersedes the earlier record; a capture that starts mid-stream still cannot.
test("a new capture from |init| supersedes a conflicting record for the same battle; a partial capture still cannot", async () => {
  const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } = await import("../history/opponentIntelStore.js");
  const prefix = "|tier|[Gen 9] UU\n|gametype|singles\n|clearpoke\n|poke|p1|Slowking\n|poke|p2|Donphan\n|teamsize|p1|1\n|teamsize|p2|1";
  const tail = "|start\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|Donphan|100/100\n|move|p2a: Elephant|Earthquake|p1a: Friend\n|turn|2";
  const request = `|request|${JSON.stringify({ rqid: 1, active: [{ moves: [{ move: "Scald", id: "scald", pp: 15 }] }],
    side: { id: "p1", pokemon: [{ ident: "p1: Friend", details: "Slowking", condition: "350/350", active: true,
      moves: ["scald"], baseAbility: "Regenerator", item: "", stats: { spe: 100 } }] } })}`;
  const capture = (sessionId: string, data: string): BattleObservation => ({ observationId: `${sessionId}-1`, sessionId, sequence: 1, roomId, source: "protocol", data: `>${roomId}\n${data}` });
  const first = await new DecisionEngine().ingest(capture("first", `|init|battle\n${prefix}\n${tail}\n${request}`));
  const trusted = await projectCanonicalSnapshots([first.snapshot!], await createEphemeralIntelEvaluationContext());
  const changed = tail.replace("Earthquake", "Knock Off");
  const partial = await new DecisionEngine().ingest(capture("partial", `${prefix}\n${changed}\n${request}`));
  assert.equal((await projectCanonicalSnapshots([partial.snapshot!], trusted)).store.canonicalBattles![roomId]!.lineageConflict, true);
  const reloaded = await new DecisionEngine().ingest(capture("reloaded", `|init|battle\n${prefix}\n${changed}\n${request}`));
  const battle = (await projectCanonicalSnapshots([reloaded.snapshot!], trusted)).store.canonicalBattles![roomId]!;
  assert.equal(battle.lineageConflict, undefined);
  assert.ok(battle.contributions.some((entry) => entry.metric === "move" && entry.value === "Knock Off" && entry.eligibility === "active"));
  assert.ok(!battle.contributions.some((entry) => entry.metric === "move" && entry.value === "Earthquake"));
});

test("only a fresh authoritative initialization restores a quarantined capture and reuses prior history once", async () => {
  const fixture = nativeSlowStartGap(), engine = new DecisionEngine();
  const first = await engine.ingest(observation(1, fixture.initial));
  const trusted = await projectCanonicalSnapshots([first.snapshot!], await createEphemeralIntelEvaluationContext());
  const prior = trusted.store.canonicalBattles![roomId]!.contributions;
  await engine.ingest(observation(2, `|request|${JSON.stringify(fixture.endRequest)}`, "recovery"));
  const stillUnknown = await engine.ingest(observation(3, `|request|${JSON.stringify({ ...fixture.endRequest, rqid: 9 })}`));
  assert.ok(stillUnknown.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  const reset = await engine.ingest(observation(4, `|init|battle\n${fixture.publicAtEnd}\n|request|${JSON.stringify(fixture.endRequest)}`));
  assert.ok(!reset.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  assert.equal(reset.snapshot!.yourSide.active!.slowStartActive, false);
  assert.equal(effectiveSpeed(9, 328, reset.snapshot!.yourSide.active!, [], reset.snapshot!.field), 328);
  const context = await projectCanonicalSnapshots([reset.snapshot!], trusted);
  assert.equal(context.store.canonicalBattles![roomId]!.lineageConflict, undefined);
  for (const contribution of prior) assert.equal(context.store.canonicalBattles![roomId]!.contributions.filter((entry) => entry.id === contribution.id).length, 1);
  assert.equal(context.store.canonicalBattles![roomId]!.contributions.filter((entry) => entry.metric === "battle-seen").length, prior.filter((entry) => entry.metric === "battle-seen").length);
  const evaluated = await evaluateDecision(engine, "capture", reset.identity!, context);
  assert.equal(evaluated.semantic.capabilities.actionable, true);
  assert.ok(evaluated.semantic.localIntel.selfActionRecommendation);
});


test("coalesced recovery requests remain unbound with either reused or separate public progress", async () => {
  const fixture = nativeSlowStartGap();
  const request = (value: unknown) => `|request|${JSON.stringify(value)}`;
  for (const ignored of [[], [fixture.secondRequest], [fixture.startRequest], [null], [fixture.secondRequest, fixture.startRequest, null]]) {
    const engine = new DecisionEngine();
    const initial = await engine.ingest(observation(1, fixture.initial));
    const data = [fixture.publicAtSecond, request(fixture.secondRequest), ...ignored.map(request), request(fixture.endRequest)].join("\n");
    const result = await engine.ingest(observation(2, data, "recovery"));
    assert.equal(result.identity!.rqid, 8);
    assert.equal(result.snapshot!.turn, 2);
    assert.equal(result.snapshot!.yourSide.active!.slowStartActive, undefined);
    assert.ok(result.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
    const evaluated = await evaluateDecision(engine, "capture", result.identity!, await createEphemeralIntelEvaluationContext());
    assert.equal(evaluated.semantic.capabilities.actionable, false);
    assert.equal(evaluated.semantic.localIntel.selfActionRecommendation, undefined);
    assert.equal(evaluated.semantic.localIntel.speedPreview, undefined);
    assert.equal(initial.snapshot!.yourSide.active!.slowStartActive, true);
  }
  const control = new DecisionEngine();
  await control.ingest(observation(1, fixture.initial));
  const result = await control.ingest(observation(2, [fixture.publicAtSecond, request(fixture.secondRequest),
    fixture.publicAtEnd.slice(fixture.publicAtSecond.length).trim(), request(fixture.endRequest)].join("\n"), "recovery"));
  assert.equal(result.identity!.rqid, 8);
  assert.equal(result.snapshot!.turn, 8);
  assert.equal(result.snapshot!.yourSide.active!.slowStartActive, undefined);
  assert.ok(result.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  const evaluated = await evaluateDecision(control, "capture", result.identity!, await createEphemeralIntelEvaluationContext());
  assert.equal(evaluated.semantic.capabilities.actionable, false);
  assert.equal(evaluated.semantic.localIntel.selfActionRecommendation, undefined);
});

test("filtered recovery requests remain idempotent and malformed coalesced requests roll back the batch", async () => {
  const fixture = nativeSlowStartGap(), engine = new DecisionEngine();
  const initial = await engine.ingest(observation(1, fixture.initial));
  const before = await engine.read("capture", roomId), refs = engine.observationReferences("capture", roomId);
  const request = (value: unknown) => `|request|${JSON.stringify(value)}`;
  await assert.rejects(engine.ingest(observation(2, [fixture.publicAtSecond, request(fixture.secondRequest), "|request|{bad"].join("\n"), "recovery")), /Malformed recovery request/);
  assert.deepEqual(await engine.read("capture", roomId), before);
  assert.deepEqual(engine.observationReferences("capture", roomId), refs);
  const authoritative = await engine.ingest(observation(2, [fixture.publicAtSecond.slice(fixture.publicAtStart.length).trim(), request(fixture.secondRequest)].join("\n")));
  const result = await engine.ingest(observation(3, [request(fixture.startRequest),
    request({ ...fixture.startRequest, rqid: 0 }), request(null), request(fixture.secondRequest)].join("\n"), "recovery"));
  assert.deepEqual(result.identity, authoritative.identity);
  assert.equal(result.changed, false);
  assert.equal(result.identity!.rqid, 2);
  assert.equal(result.snapshot!.turn, 2);
  assert.equal(result.snapshot!.yourSide.active!.slowStartActive, true);
  assert.ok(!result.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  assert.equal(initial.snapshot!.yourSide.active!.slowStartActive, true);
});


test("a single current request cannot establish that a recovered public queue is current", async () => {
  const fixture = nativeSlowStartGap();
  for (const publicQueue of [fixture.publicAtSecond, fixture.publicAtEnd]) {
    const engine = new DecisionEngine();
    await engine.ingest(observation(1, fixture.initial));
    const result = await engine.ingest(observation(2, `${publicQueue}\n|request|${JSON.stringify(fixture.endRequest)}`, "recovery"));
    assert.equal(result.identity!.rqid, 8);
    assert.equal(result.snapshot!.yourSide.active!.slowStartActive, undefined);
    assert.ok(result.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
    const evaluated = await evaluateDecision(engine, "capture", result.identity!, await createEphemeralIntelEvaluationContext());
    assert.equal(evaluated.semantic.capabilities.actionable, false);
    assert.equal(evaluated.semantic.localIntel.selfActionRecommendation, undefined);
  }
  for (const [publicQueue, privateRequest] of [[fixture.publicAtEnd, fixture.endRequest], [fixture.previewPublic, fixture.previewRequest]] as const) {
    const engine = new DecisionEngine();
    const result = await engine.ingest(observation(1, `|init|battle\n${publicQueue}\n|request|${JSON.stringify(privateRequest)}`, "recovery"));
    assert.ok(result.snapshot);
    assert.ok(result.snapshot.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
    const evaluated = await evaluateDecision(engine, "capture", result.identity!, await createEphemeralIntelEvaluationContext());
    assert.equal(evaluated.semantic.capabilities.actionable, false);
    assert.equal(evaluated.semantic.localIntel.selfActionRecommendation, undefined);
  }
});


test("public-only recovery cannot become trusted when a later authoritative private request arrives", async () => {
  const fixture = nativeSlowStartGap();
  for (const requestSuffix of ["", `\n|request|${JSON.stringify(fixture.startRequest)}`, `\n|request|${JSON.stringify({ ...fixture.startRequest, rqid: 0 })}`]) {
    const engine = new DecisionEngine();
    const first = await engine.ingest(observation(1, fixture.initial));
    const recovered = await engine.ingest(observation(2, fixture.publicAtSecond + requestSuffix, "recovery"));
    assert.ok(recovered.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
    assert.equal(recovered.snapshot!.yourSide.active!.slowStartActive, undefined);
    const result = await engine.ingest(observation(3, `|request|${JSON.stringify(fixture.endRequest)}`));
    assert.equal(result.identity!.rqid, 8);
    assert.equal(result.snapshot!.turn, 2);
    assert.equal(result.snapshot!.yourSide.active!.slowStartActive, undefined);
    const evaluated = await evaluateDecision(engine, "capture", result.identity!, await createEphemeralIntelEvaluationContext());
    assert.equal(evaluated.semantic.capabilities.actionable, false);
    assert.equal(evaluated.semantic.localIntel.selfActionRecommendation, undefined);
    assert.equal(first.snapshot!.yourSide.active!.slowStartActive, true);
  }
});

test("known public recovery duplicates and short retained prefixes add no continuity gap", async () => {
  const fixture = nativeSlowStartGap();
  for (const publicQueue of [fixture.publicAtStart, fixture.publicAtStart.split("\n").slice(0, -1).join("\n"), "|t:|1\n|sso-state|{}"]) {
    const engine = new DecisionEngine();
    const first = await engine.ingest(observation(1, fixture.initial));
    const recovered = await engine.ingest(observation(2, publicQueue, "recovery"));
    assert.equal(recovered.changed, false);
    assert.deepEqual(recovered.identity, first.identity);
    assert.deepEqual(recovered.snapshot!.canonicalEvidence, first.snapshot!.canonicalEvidence);
    assert.equal(recovered.snapshot!.yourSide.active!.slowStartActive, true);
  }
});

test("cold public prefix reconstruction retains overlap provenance but cannot certify a later wire request", async () => {
  const fixture = nativeSlowStartGap(), engine = new DecisionEngine();
  const tail = fixture.publicAtSecond.split("\n").filter(Boolean).slice(-2).join("\n");
  const first = await engine.ingest(observation(1, tail));
  assert.equal(first.snapshot, null);
  const recovered = await engine.ingest(observation(2, fixture.publicAtSecond, "recovery"));
  assert.equal(recovered.snapshot, null);
  assert.ok(recovered.room.canonicalEvidence.limitations.includes("recovery_public_continuity_unknown"));
  for (const fact of first.room.canonicalEvidence.facts) {
    const retained = recovered.room.canonicalEvidence.facts.find((entry: any) => entry.kind === fact.kind && JSON.stringify(entry.args) === JSON.stringify(fact.args));
    assert.deepEqual(retained.source, fact.source);
  }
  const current = await engine.ingest(observation(3, `|request|${JSON.stringify(fixture.endRequest)}`));
  assert.ok(current.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  assert.equal(current.snapshot!.yourSide.active!.slowStartActive, undefined);
  const evaluated = await evaluateDecision(engine, "capture", current.identity!, await createEphemeralIntelEvaluationContext());
  assert.equal(evaluated.semantic.capabilities.actionable, false);
  const reset = await engine.ingest(observation(4, `|init|battle\n${fixture.publicAtEnd}\n|request|${JSON.stringify(fixture.endRequest)}`));
  assert.equal(reset.snapshot!.yourSide.active!.slowStartActive, false);
  assert.ok(!reset.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
});

test("public-import gaps preserve complete prior contributions and cannot survive a rejected transaction", async () => {
  const fixture = nativeSlowStartGap(true), engine = new DecisionEngine();
  const first = await engine.ingest(observation(1, fixture.initial));
  const trusted = await projectCanonicalSnapshots([first.snapshot!], await createEphemeralIntelEvaluationContext());
  const before = await engine.read("capture", roomId), refs = engine.observationReferences("capture", roomId);
  const recovery = observation(2, `${fixture.publicAtStart}\n|turn|3`, "recovery");
  await assert.rejects(engine.ingestBatch([recovery, observation(1, "|turn|4")]), /reused/);
  assert.deepEqual(await engine.read("capture", roomId), before);
  assert.deepEqual(engine.observationReferences("capture", roomId), refs);
  const gap = await engine.ingest(recovery);
  const later = await engine.ingest(observation(3, ["|replace|p2a: Fox|Zoroark-Hisui|100/100", "|detailschange|p2a: Fox|Zoroark-Hisui",
    "|-item|p2a: Fox|Choice Specs", "|-ability|p2a: Fox|Illusion", "|move|p2a: Fox|Hyper Voice|p1a: Regigigas",
    "|-damage|p1a: Regigigas|300/424", "|turn|4", `|request|${JSON.stringify(fixture.endRequest)}`].join("\n")));
  assert.deepEqual(later.snapshot!.canonicalEvidence!.facts.slice(0, first.snapshot!.canonicalEvidence!.facts.length), first.snapshot!.canonicalEvidence!.facts);
  assert.deepEqual(later.snapshot!.canonicalEvidence!.contributions, first.snapshot!.canonicalEvidence!.contributions);
  const projected = await projectCanonicalSnapshots([gap.snapshot!, later.snapshot!], trusted);
  assert.equal(projected.revision, trusted.revision);
  assert.deepEqual(projected.store, trusted.store);
});
