import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Battle, Teams, TeamValidator, extractChannelMessages } from "../battle-agent/nativeSimulator.js";
import { calculate, Generations, Move, Pokemon } from "@smogon/calc";
import { createDecisionIdentity } from "../../../extension/lib/decision-identity.js";
import type { BattlePolicy, BattlePolicyInput, DecisionEnvelope } from "../battle-agent/battleAgent.js";
import type { BattleSnapshot } from "../types.js";

// Redirect before importing config. Tests never touch the owner's actual files.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-simulator-"));
const historyPath = path.join(directory, "history.json"), curatedPath = path.join(directory, "curated.json");
process.env.LOCAL_INTEL_STORE_PATH = historyPath;
process.env.EXTERNAL_CURATED_STORE_PATH = curatedPath;
const sentinel = '{"sentinel":"human observed history must remain untouched"}\n';
await fs.writeFile(historyPath, sentinel);
await fs.writeFile(curatedPath, sentinel);
const { runBattleMatch, RandomBattlePolicy } = await import("../battle-agent/simulator.js");
const { BattleActionExecutor, DeterministicBattlePolicy } = await import("../battle-agent/battleAgent.js");
const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } = await import("../history/opponentIntelStore.js");
after(async () => { mock.restoreAll(); await fs.rm(directory, { recursive: true, force: true }); });

const strong = `Scizor @ Choice Band
Ability: Technician
Tera Type: Fire
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Bullet Punch
- Close Combat`;
const weak = `Magikarp @ Focus Sash
Ability: Swift Swim
Level: 1
EVs: 252 HP / 4 Def / 252 Spe
- Splash

Sunkern @ Oran Berry
Ability: Chlorophyll
Level: 1
EVs: 252 HP / 4 Def / 252 Spe
- Tackle`;
const base = () => ({ p1: new DeterministicBattlePolicy(), p2: new RandomBattlePolicy(), teams: { p1: strong, p2: weak }, maxTurns: 10 });
const withoutTime = (protocol: string) => protocol.split("\n").filter((line) => !line.startsWith("|t:|")).join("\n");
async function promptly<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Cancelled match did not settle promptly.")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

test("seeded match finishes, every chosen token passes the official simulator, and semantic trace repeats", async () => {
  const first = await runBattleMatch({ ...base(), trace: true });
  const second = await runBattleMatch({ ...base(), trace: true });
  assert.equal(first.status, "completed", JSON.stringify(first.errors));
  assert.equal(first.outcome, "win");
  assert.equal(first.winner, "p1");
  assert.equal(first.stopReason, null);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.fallbacks, []);
  assert.ok(first.trajectory.length > 5);
  assert.ok(first.trajectory.every((record) => record.accepted));
  assert.equal(first.players.p2!.switches, 1);
  assert.equal(first.players.p2!.tera, 1);
  assert.ok(first.versions.simulator === "pokemon-showdown@0.11.11");
  assert.equal(first.versions.engines.length, 1);
  assert.deepEqual(first.trajectory.map(({ latencyMs, ...record }) => record), second.trajectory.map(({ latencyMs, ...record }) => record));
  assert.equal(withoutTime(first.replay), withoutTime(second.replay));
  assert.ok(!first.replay.includes("|request|") && !first.replay.includes("|split|"));
  for (const side of ["p1", "p2"] as const) {
    const requests = first.playerTraces![side].flatMap((packet) => packet.split("\n")).filter((line) => line.startsWith("|request|")).map((line) => JSON.parse(line.slice(9)));
    assert.ok(requests.length > 2);
    assert.ok(requests.every((request, index) => request.side.id === side && request.rqid === index + 1));
    assert.equal(withoutTime(first.playerTraces![side].join("\n")), withoutTime(second.playerTraces![side].join("\n")));
  }
});

test("explicit cleanup budgets preserve choices while timeouts and cleanup errors remain failures", async () => {
  const policy = (close: () => Promise<void>): BattlePolicy => ({
    id: "cleanup-budget-fixture", decide: (input) => new DeterministicBattlePolicy().decide(input), close,
  });
  const short = await runBattleMatch({ ...base(), p1: policy(() => delay(40)), cleanupDeadlineMs: 5 });
  assert.equal(short.status, "failed");
  assert.ok(short.errors.some((error) => error.message === "Policy cleanup failed."));
  const enough = await runBattleMatch({ ...base(), p1: policy(() => delay(40)), cleanupDeadlineMs: 500 });
  assert.equal(enough.status, "completed", JSON.stringify(enough.errors));
  assert.equal(enough.limits.cleanupDeadlineMs, 500);
  assert.deepEqual(short.trajectory.map((row) => row.choice), enough.trajectory.map((row) => row.choice));
  const broken = await runBattleMatch({ ...base(), p1: policy(async () => { throw new Error("cleanup fixture"); }), cleanupDeadlineMs: 500 });
  assert.equal(broken.status, "failed");
  assert.ok(broken.errors.some((error) => error.message === "Policy cleanup failed."));
  let closed = 0;
  await assert.rejects(runBattleMatch({ ...base(), p1: policy(async () => { closed++; }), cleanupDeadlineMs: 0 }), /cleanupDeadlineMs/);
  assert.equal(closed, 1, "malformed configuration still closes resources acquired by the policy");
});

test("recurrent commit receives the accepted action before any later actor observation", async () => {
  let pending: BattlePolicyInput | undefined;
  const committed: string[] = [];
  const actor: BattlePolicy = {
    id: "commit-order-fixture",
    async observe() { assert.equal(pending, undefined, "observations cannot outrun acceptance feedback"); },
    async decide(input) { pending = structuredClone(input); return new DeterministicBattlePolicy().decide(input); },
    async commit(input, decision, options) {
      assert.ok(pending); assert.deepEqual(input, pending);
      assert.equal(input.envelope.semantic.identity.rqid, decision.identity.rqid);
      assert.ok(Date.now() < options.deadlineAt && !options.signal.aborted);
      assert.ok(input.envelope.semantic.snapshot.legalActions.some((action) => action.id === decision.actionId));
      committed.push(decision.actionId); pending = undefined;
    }
  };
  const result = await runBattleMatch({ ...base(), p1: actor });
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.deepEqual(committed, result.trajectory.filter((entry) => entry.side === "p1" && entry.accepted).map((entry) => entry.actionId));
});

test("each policy sees only its own private requests; offline history never reads or changes configured stores", async () => {
  const before = await Promise.all([fs.stat(historyPath), fs.stat(curatedPath)]);
  const originalRead = fs.readFile;
  const spy = mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
    assert.ok(![historyPath, curatedPath].includes(String(args[0])), "offline evaluation read persistent intel");
    return originalRead(...args);
  });
  const previews: DecisionEnvelope[] = [];
  const policy = (side: "p1" | "p2"): BattlePolicy => ({
    id: `privacy-${side}`,
    async decide(input) {
      const { snapshot } = input.envelope.semantic;
      assert.equal(snapshot.yourSide.slot, side);
      for (const fact of snapshot.canonicalEvidence!.facts.filter((fact) => fact.kind === "request")) {
        assert.equal(JSON.parse(fact.args.join("|")).side.id, side);
      }
      if (snapshot.phase === "preview") {
        previews.push(structuredClone(input.envelope));
        assert.ok(snapshot.yourSide.team.every((mon) => mon.item && mon.stats && mon.knownMoves.length));
        for (const mon of snapshot.opponentSide.team) {
          assert.equal(mon.item, null);
          assert.equal(mon.ability, null);
          assert.equal(mon.teraType, null);
          assert.deepEqual(mon.knownMoves, []);
          assert.ok(!mon.stats || Object.keys(mon.stats).length === 0);
        }
      }
      return new DeterministicBattlePolicy().decide(input);
    }
  });
  try {
    const result = await runBattleMatch({ ...base(), p1: policy("p1"), p2: policy("p2"), fallback: "none" });
    assert.equal(result.status, "completed", JSON.stringify(result.errors));
    assert.equal(previews.length, 2);
  } finally { spy.mock.restore(); }
  assert.equal(await fs.readFile(historyPath, "utf8"), sentinel);
  assert.equal(await fs.readFile(curatedPath, "utf8"), sentinel);
  const afterStats = await Promise.all([fs.stat(historyPath), fs.stat(curatedPath)]);
  assert.deepEqual(afterStats.map((stat) => [stat.ino, stat.mtimeMs, stat.size]), before.map((stat) => [stat.ino, stat.mtimeMs, stat.size]));
});

test("owned turn coverage binds actual own-channel frames through a live living U-turn replacement", async () => {
  const frames: Record<"p1" | "p2", string[]> = { p1: [], p2: [] };
  const snapshots: DecisionEnvelope["semantic"]["snapshot"][] = [];
  const policy = (side: "p1" | "p2"): BattlePolicy => ({
    id: `coverage-${side}`,
    async observe(data, context) {
      assert.equal(context.side, side);
      assert.equal(context.sequence, frames[side].length + 1);
      assert.ok(data.length > 0);
      frames[side].push(data);
    },
    async decide({ requestId, envelope }) {
      const { snapshot, identity } = envelope.semantic;
      snapshots.push(structuredClone(snapshot));
      const facts = snapshot.canonicalEvidence!.facts;
      const requests = facts.filter((fact) => fact.kind === "request");
      const latest = requests.at(-1)!;
      assert.ok(requests.every((fact) => JSON.parse(fact.args.join("|")).side.id === side));
      for (const mon of [snapshot.opponentSide.active, ...snapshot.opponentSide.team]) {
        if (mon) assert.ok(!mon.stats || Object.keys(mon.stats).length === 0);
      }
      if (snapshot.phase === "preview") assert.equal(snapshot.turnCoverage, undefined);
      else {
        const coverage = snapshot.turnCoverage!;
        assert.ok(coverage, `${side} current request ${identity.rqid} must be source-qualified`);
        const boundary = facts.find((fact) => fact.id === coverage.turnFactId)!;
        assert.equal(coverage.source, "owned_offline_simulator");
        assert.equal(coverage.turn, snapshot.turn);
        assert.equal(boundary.kind, "turn"); assert.equal(boundary.turn, snapshot.turn);
        assert.equal(coverage.fromSequence, boundary.source.sequence);
        assert.equal(coverage.requestFactId, latest.id); assert.equal(latest.turn, snapshot.turn);
        assert.equal(latest.source.rqid, identity.rqid);
        assert.equal(coverage.throughSequence, frames[side].length);
        assert.ok(coverage.throughSequence >= latest.source.sequence);
        assert.equal(frames[side][0], "|init|battle");
        for (const fact of [boundary, latest]) {
          assert.equal(frames[side][fact.source.sequence - 1]!.split("\n")[fact.source.lineIndex - 1],
            ["", fact.kind, ...fact.args].join("|"));
        }
        const { stateRevision: _revision, requestKind: _kind, ...structural } = identity;
        assert.deepEqual(structural, await createDecisionIdentity(snapshot));
      }
      const request = JSON.parse(latest.args.join("|"));
      const lead = side === "p1" ? "Dragapult" : "Donphan";
      const leadSlot = request.side.pokemon.findIndex((mon: { details: string }) => mon.details.split(",")[0] === lead) + 1;
      const reserve = snapshot.yourSide.team.find((mon) => mon.species === "Slowking");
      const action = snapshot.legalActions.find((candidate) => !candidate.disabled && (snapshot.phase === "preview"
        ? candidate.kind === "team" && candidate.teamSpec?.[0] === leadSlot
        : snapshot.rawRequestSummary?.requestKind === "forced_switch"
          ? candidate.kind === "switch" && candidate.targetInstanceId === reserve?.instanceId
          : candidate.kind === "move" && !candidate.terastallize && candidate.moveId === (side === "p1" ? "uturn" : "bodypress")));
      assert.ok(action, `${side} must have the scripted legal choice`);
      return { requestId, identity, actionId: action.id };
    }
  });
  const result = await runBattleMatch({ p1: policy("p1"), p2: policy("p2"), format: "gen9ou", seed: [13, 27, 42, 81],
    maxTurns: 1, maxDecisions: 8, timeoutMs: 15_000, fallback: "none", trace: true,
    teams: {
      p1: `Dragapult @ Heavy-Duty Boots
Ability: Infiltrator
Tera Type: Ghost
EVs: 252 HP / 4 Atk / 252 Spe
Jolly Nature
- U-turn

Slowking @ Heavy-Duty Boots
Ability: Regenerator
Tera Type: Fairy
EVs: 252 HP / 252 Def / 4 SpD
Bold Nature
- Slack Off`,
      p2: `Donphan @ Heavy-Duty Boots
Ability: Sturdy
Tera Type: Ground
EVs: 252 HP / 252 Def / 4 SpD
Impish Nature
- Body Press`
    } });
  assert.equal(result.status, "truncated", JSON.stringify(result.errors));
  assert.equal(result.stopReason, "max_turns");
  assert.deepEqual(result.errors, []); assert.deepEqual(result.fallbacks, []);
  assert.deepEqual(result.playerTraces, frames, "every retained channel frame was delivered and sequenced");
  assert.ok(result.trajectory.every((record) => record.accepted));
  const forced = snapshots.filter((snapshot) => snapshot.rawRequestSummary?.requestKind === "forced_switch");
  assert.equal(forced.length, 1);
  assert.equal(forced[0]!.yourSide.slot, "p1");
  assert.equal(forced[0]!.yourSide.active!.species, "Dragapult");
  assert.equal(forced[0]!.yourSide.active!.fainted, false);
  assert.ok(forced[0]!.yourSide.active!.hpPercent! > 0);
  assert.ok(forced[0]!.turnCoverage);
  assert.ok(result.replay.includes("|move|p1a: Dragapult|U-turn|p2a: Donphan"));
  assert.ok(result.replay.includes("|move|p2a: Donphan|Body Press|p1a: Slowking"));
});

test("an unsupported null simulator request stops the match rather than silently skipping a frame", async () => {
  const sendUpdates = Battle.prototype.sendUpdates;
  const spy = mock.method(Battle.prototype, "sendUpdates", function (this: Battle) {
    sendUpdates.call(this);
    this.send("sideupdate", "p1\n|request|null");
  });
  let decisions = 0;
  const policy: BattlePolicy = { id: "must-not-decide-after-null", async decide(input) {
    decisions++;
    return new DeterministicBattlePolicy().decide(input);
  } };
  try {
    const result = await runBattleMatch({ ...base(), p1: policy, p2: policy, trace: true, maxTurns: 1 });
    assert.equal(result.status, "failed"); assert.equal(result.stopReason, "error");
    assert.equal(decisions, 0); assert.deepEqual(result.trajectory, []); assert.deepEqual(result.fallbacks, []);
    assert.equal(result.playerTraces!.p1.at(-1), "|request|null");
    assert.ok(result.errors.some((error) => error.stage === "harness" && /Simulator request was cleared/.test(error.message)));
  } finally { spy.mock.restore(); }
});

test("canonical projection is pure, idempotent, and pinned to an epoch empty context", async () => {
  const empty = await createEphemeralIntelEvaluationContext();
  const independent = await createEphemeralIntelEvaluationContext();
  const before = structuredClone(empty);
  assert.deepEqual(empty, independent);
  assert.notEqual(empty.store, independent.store);
  assert.equal(empty.store.updatedAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(empty.store.externalCurated, { species: {}, imports: {} });
  let snapshot: BattleSnapshot | undefined;
  const result = await runBattleMatch({ ...base(), onDecision(event) {
    if (event.side === "p1") snapshot = { ...event.envelope.semantic.snapshot, capturedAt: "1970-01-01T00:00:00.000Z" };
  } });
  assert.equal(result.status, "completed");
  assert.ok(snapshot);
  const snapshotBefore = structuredClone(snapshot);
  const projected = await projectCanonicalSnapshots([snapshot], empty);
  assert.notDeepEqual(projected, empty);
  assert.deepEqual(await projectCanonicalSnapshots([snapshot], projected), projected);
  assert.deepEqual(await projectCanonicalSnapshots([], projected), projected);
  assert.deepEqual(empty, before);
  assert.deepEqual(independent, before);
  assert.deepEqual(snapshot, snapshotBefore);
  assert.equal(projected.store.updatedAt, empty.store.updatedAt);
  for (const contribution of projected.store.canonicalBattles![snapshot.roomId]!.contributions) {
    assert.notEqual(contribution.factIds, snapshot.canonicalEvidence!.contributions.find((entry) => entry.id === contribution.id)!.factIds);
  }
});

test("controlled living Tera persists through re-entry with Ghost immunity and private action binding", async () => {
  const events: Array<Parameters<NonNullable<Parameters<typeof runBattleMatch>[0]["onDecision"]>>[0]> = [];
  const policy = (side: "p1" | "p2"): BattlePolicy => ({
    id: `controlled-tera-${side}`,
    async decide({ requestId, envelope }) {
      const { snapshot, identity } = envelope.semantic;
      const actions = snapshot.legalActions.filter((action) => !action.disabled);
      const lead = side === "p1" ? "Arcanine-Hisui" : "Gengar";
      const request = JSON.parse(snapshot.canonicalEvidence!.facts.filter((fact) => fact.kind === "request").at(-1)!.args.join("|"));
      const leadSlot = request.side.pokemon.findIndex((mon: { details: string }) => mon.details.split(",")[0] === lead) + 1;
      const switchSpecies = snapshot.turn === 2 ? "Slowking" : "Arcanine-Hisui";
      const target = snapshot.yourSide.team.find((mon) => mon.species === switchSpecies);
      const moveId = side === "p1" ? "extremespeed" : snapshot.turn === 2 ? "protect" : "shadowball";
      const action = actions.find((candidate) => snapshot.phase === "preview"
        ? candidate.kind === "team" && candidate.teamSpec?.[0] === leadSlot
        : side === "p1" && [2, 3].includes(snapshot.turn)
          ? candidate.kind === "switch" && candidate.targetInstanceId === target?.instanceId
          : candidate.kind === "move" && candidate.moveId === moveId && candidate.terastallize === (side === "p1" && snapshot.turn === 1));
      assert.ok(action, `Missing scripted legal action for ${side} turn ${snapshot.turn}`);
      return { requestId, identity, actionId: action.id };
    }
  });
  // The runner creates a separate ephemeral history for each side. Slowking is
  // listed first deliberately: preview must select Arcanine structurally.
  const result = await runBattleMatch({ p1: policy("p1"), p2: policy("p2"), format: "gen9uu",
    seed: [1, 2, 3, 4], maxTurns: 4, fallback: "none", trace: true,
    teams: {
      p1: `Slowking @ Heavy-Duty Boots
Ability: Regenerator
Tera Type: Fairy
EVs: 252 HP / 4 Def / 252 SpD
Calm Nature
- Slack Off

Arcanine-Hisui @ Choice Scarf
Ability: Rock Head
Tera Type: Normal
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Extreme Speed`,
      p2: `Gengar @ Heavy-Duty Boots
Ability: Cursed Body
Tera Type: Poison
EVs: 252 HP / 4 SpA / 252 Spe
Timid Nature
- Shadow Ball
- Protect`
    }, onDecision(event) { events.push(event); } });
  assert.equal(result.status, "truncated", JSON.stringify(result.errors));
  assert.equal(result.stopReason, "max_turns");
  assert.equal(result.outcome, null); assert.equal(result.winner, null);
  assert.deepEqual(result.errors, []); assert.deepEqual(result.fallbacks, []);
  assert.equal(events.length, 10);
  assert.ok(result.trajectory.every((record) => record.accepted));
  assert.equal(result.players.p1!.tera, 1); assert.equal(result.players.p1!.switches, 2);

  for (const [index, { side, envelope, decision, choice }] of events.entries()) {
    const { snapshot, identity } = envelope.semantic;
    const { stateRevision, requestKind, ...structuralIdentity } = identity;
    assert.deepEqual(structuralIdentity, await createDecisionIdentity(snapshot));
    assert.ok(stateRevision > 0);
    assert.equal(requestKind, snapshot.phase === "preview" ? "team_preview" : "move");
    assert.deepEqual(decision.identity, identity);
    assert.equal(decision.inputResultHash, envelope.resultHash);
    assert.deepEqual(result.trajectory[index]!.identity, identity);
    const action = snapshot.legalActions.find((candidate) => candidate.id === decision.actionId)!;
    assert.ok(action && !action.disabled); assert.equal(choice, action.choice);
    const requests = snapshot.canonicalEvidence!.facts.filter((fact) => fact.kind === "request");
    assert.ok(requests.every((fact) => JSON.parse(fact.args.join("|")).side.id === side));
    const latest = requests.at(-1)!;
    const request = JSON.parse(latest.args.join("|"));
    assert.equal(request.rqid, identity.rqid);
    if (action.kind === "move") {
      assert.equal(action.actorAppearanceId, snapshot.yourSide.active!.appearanceId);
      assert.equal(action.moveId, request.active[0].moves[action.moveSlot! - 1].id);
      assert.equal(action.id, `move:${action.moveSlot}|tera=${Number(action.terastallize)}`);
      if (action.terastallize) assert.equal(request.active[0].canTerastallize, "Normal");
    } else if (action.kind === "switch") {
      assert.equal(action.actorAppearanceId, snapshot.yourSide.active!.appearanceId);
      assert.equal(action.targetInstanceId, latest.requestSlots![action.targetSlot! - 1]!.instanceId);
      assert.equal(action.id, `switch:${action.targetSlot}`);
    }
    for (const mon of [snapshot.opponentSide.active, ...snapshot.opponentSide.team]) {
      if (!mon) continue;
      assert.ok(!mon.stats || Object.keys(mon.stats).length === 0, "opponent must not acquire simulator private stats");
      assert.equal(mon.item, null); assert.equal(mon.ability, null);
    }
  }

  for (const side of ["p1", "p2"] as const) {
    const turns = events.filter((event) => event.side === side && event.envelope.semantic.snapshot.phase === "turn");
    assert.deepEqual(turns.map((event) => event.envelope.semantic.snapshot.turn), [1, 2, 3, 4]);
    const teamView = (index: number) => turns[index]!.envelope.semantic.snapshot[side === "p1" ? "yourSide" : "opponentSide"];
    const original = teamView(0).active!, living = teamView(1).active!, reserve = teamView(2).team.find((mon) => mon.species === "Arcanine-Hisui")!, returned = teamView(3).active!;
    assert.equal(original.species, "Arcanine-Hisui"); assert.equal(original.terastallized, false);
    assert.equal(original.teraType, side === "p1" ? "Normal" : null);
    assert.ok(original.instanceId && original.appearanceId && returned.appearanceId);
    for (const mon of [living, reserve, returned]) {
      assert.equal(mon.species, "Arcanine-Hisui"); assert.equal(mon.instanceId, original.instanceId);
      assert.equal(mon.terastallized, true); assert.equal(mon.teraType, "Normal");
      assert.equal(mon.fainted, false); assert.equal(mon.hpPercent, 100);
    }
    assert.equal(living.appearanceId, original.appearanceId);
    assert.notEqual(returned.appearanceId, original.appearanceId);
    assert.equal(teamView(2).active!.species, "Slowking"); assert.equal(reserve.active, false);
    for (const event of turns) {
      const snapshot = event.envelope.semantic.snapshot;
      const slowking = snapshot[side === "p1" ? "yourSide" : "opponentSide"].team.find((mon) => mon.species === "Slowking")!;
      assert.equal(slowking.terastallized, false); assert.equal(slowking.teraType, side === "p1" ? "Fairy" : null);
      assert.equal(slowking.fainted, false);
      assert.equal(slowking.hpPercent, side === "p2" && snapshot.turn < 3 ? null : 100);
      assert.notEqual(slowking.instanceId, original.instanceId);
      if (side === "p1" && snapshot.turn > 1) {
        assert.equal(snapshot.rawRequestSummary!.canTerastallize, false);
        assert.ok(snapshot.legalActions.every((action) => !action.terastallize));
      }
    }
    const facts = turns[3]!.envelope.semantic.snapshot.canonicalEvidence!.facts;
    const tera = facts.filter((fact) => fact.kind === "-terastallize");
    assert.equal(tera.length, 1); assert.equal(tera[0]!.args[1], "Normal");
    assert.equal(tera[0]!.subject.appearanceId, original.appearanceId);
    const immune = facts.filter((fact) => fact.kind === "-immune" && fact.subject.side === "p1");
    assert.deepEqual(immune.map((fact) => [fact.turn, fact.subject.appearanceId]), [[1, original.appearanceId], [3, returned.appearanceId]]);
  }

  const gen = Generations.get(9);
  const attacker = new Pokemon(gen, "Gengar", { ability: "Cursed Body" });
  assert.ok(calculate(gen, attacker, new Pokemon(gen, "Arcanine-Hisui"), new Move(gen, "Shadow Ball")).range()[0] > 0);
  for (const turn of [2, 4]) {
    const { snapshot, localIntel } = events.find((event) => event.side === "p1" && event.envelope.semantic.snapshot.turn === turn)!.envelope.semantic;
    const active = snapshot.yourSide.active!;
    const threat = localIntel.opponentThreatPreview!.find((entry) => entry.moveName === "Shadow Ball")!;
    assert.ok(threat && threat.currentTarget.bands.length > 0);
    assert.equal(threat.moveSource, "known");
    assert.equal(threat.currentTarget.instanceId, active.instanceId);
    assert.equal(threat.currentTarget.targetCurrentHpPercent, 100);
    const slowking = snapshot.yourSide.team.find((mon) => mon.species === "Slowking")!;
    const reserveThreat = threat.switchTargets.find((target) => target.instanceId === slowking.instanceId)!;
    assert.ok(reserveThreat?.bands.length && reserveThreat.bands.every((band) => band.minPercent! > 0));
    const native = calculate(gen, attacker, new Pokemon(gen, "Arcanine-Hisui", { teraType: "Normal" }), new Move(gen, "Shadow Ball")).range();
    assert.deepEqual(native, [0, 0]);
    for (const band of threat.currentTarget.bands) {
      assert.equal(band.outcome, "immune"); assert.deepEqual([band.minPercent, band.maxPercent], native);
    }
  }
  const last = events.filter((event) => event.side === "p2").at(-1)!.envelope.semantic.snapshot;
  const projected = await projectCanonicalSnapshots([{ ...last, capturedAt: "1970-01-01T00:00:00.000Z" }], await createEphemeralIntelEvaluationContext());
  const contributions = projected.store.canonicalBattles![last.roomId]!.contributions.filter((entry) => entry.metric === "tera");
  assert.deepEqual(contributions.map((entry) => [entry.instanceId, entry.value, entry.eligibility]), [[last.opponentSide.active!.instanceId, "Normal", "active"]]);
  assert.match(result.replay, /\|move\|p1a: Arcanine\|Extreme Speed\|p2a: Gengar\n\|-immune\|p2a: Gengar/);
  assert.equal(result.replay.match(/\|move\|p2a: Gengar\|Shadow Ball\|p1a: Arcanine\n\|-immune\|p1a: Arcanine/g)?.length, 3);
  assert.doesNotMatch(result.replay, /\|faint\||\|-damage\||\|win\||\|tie(?:\||\n)/);
});

test("bad output gets an explicit deterministic fallback under the current identity", async () => {
  const invalid: BattlePolicy = { id: "invalid-fixture", async decide(input) {
    return { requestId: input.requestId, identity: input.envelope.semantic.identity, actionId: "not-an-action" };
  } };
  const result = await runBattleMatch({ ...base(), p1: invalid, trace: true, ownedCheckpointAt: [1] });
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.ok(result.errors.some((error) => error.stage === "policy"));
  assert.ok(result.fallbacks.length > 0);
  assert.equal(result.players.p1!.policyId, "invalid-fixture");
  assert.match(result.trajectory[0]!.requestId, /attempt-2$/, "failed policy call is not a trajectory entry");
  assert.equal(result.ownedCheckpoints![0]!.trajectoryIndex, 1);
  assert.equal(result.ownedCheckpoints![0]!.requestId, result.trajectory[0]!.requestId);
  assert.equal(result.players.p1!.fallbacks, result.fallbacks.length);
  assert.ok(result.trajectory.filter((entry) => entry.side === "p1").every((entry) => entry.fallback && entry.policyId === "deterministic-fallback" && entry.accepted));
  const disabled = await runBattleMatch({ ...base(), p1: invalid, fallback: "none" });
  assert.equal(disabled.status, "failed");
  assert.equal(disabled.outcome, null);
  assert.equal(disabled.fallbacks.length, 0);
});

test("an uncooperative timed-out policy cannot hang or reuse the fallback deadline", async () => {
  const uncooperative: BattlePolicy = { id: "timeout-fixture", decide() { return new Promise(() => {}); } };
  const result = await runBattleMatch({ ...base(), p1: uncooperative, decisionDeadlineMs: 15, fallbackDeadlineMs: 1000 });
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.ok(result.fallbacks.length > 0);
  assert.ok(result.errors.some((error) => /timeout|aborted/i.test(error.message)));
  assert.ok(result.trajectory.filter((entry) => entry.side === "p1").every((entry) => entry.fallback && entry.accepted));
});

test("an uncertain trapped switch is tried only when selected, then re-chosen under the same private rqid", async () => {
  let attemptedSwitch = false;
  const switcher: BattlePolicy = { id: "switch-fixture", async decide(input) {
    const snapshot = input.envelope.semantic.snapshot;
    const action = snapshot.legalActions.find((action) => action.kind === "switch" && !action.disabled);
    if (!action) return new DeterministicBattlePolicy().decide(input);
    attemptedSwitch = true;
    const requestFact = snapshot.canonicalEvidence!.facts.filter((fact) => fact.kind === "request").at(-1)!;
    const request = JSON.parse(requestFact.args.join("|"));
    assert.notEqual(request.active[0].trapped, true, "trap must not be pre-revealed by speculative legality probing");
    return { requestId: input.requestId, identity: input.envelope.semantic.identity, actionId: action.id };
  } };
  const result = await runBattleMatch({ ...base(), p2: switcher, format: "gen9customgame", maxTurns: 1,
    trace: true, ownedCheckpointAt: [1, 2, 3, 4, 5, 6],
    teams: { p1: "Dugtrio\nAbility: Arena Trap\nEVs: 252 Atk / 4 Def / 252 Spe\n- Earthquake",
      p2: `${strong}\n\nDonphan @ Heavy-Duty Boots\nAbility: Sturdy\nEVs: 252 HP / 252 Def / 4 Atk\n- Earthquake` } });
  assert.ok(attemptedSwitch);
  const rejected = result.trajectory.find((entry) => !entry.accepted)!;
  assert.ok(rejected && rejected.side === "p2" && rejected.choice.startsWith("switch "));
  const capture = result.ownedCheckpoints!.find((entry) => entry.requestId === rejected.requestId)!;
  assert.ok(capture);
  assert.equal(result.trajectory[capture.trajectoryIndex - 1]!.accepted, false);
  const restored = Battle.fromJSON(capture.checkpoint.checkpointJson);
  try { assert.equal(restored.p2.choice.actions.length, 0); } finally { restored.destroy(); }
  const rechoice = result.trajectory[result.trajectory.indexOf(rejected) + 1]!;
  assert.ok(rechoice?.accepted && rechoice.choice.startsWith("move "), JSON.stringify({ errors: result.errors, trajectory: result.trajectory, traces: result.playerTraces!.p2.slice(-5) }));
  assert.equal(rechoice.rqid, rejected.rqid);
  assert.notDeepEqual(rechoice.identity, rejected.identity);
  assert.deepEqual(result.fallbacks, []);
  assert.deepEqual(result.errors, []);
  assert.ok(result.playerTraces!.p2.some(frame => frame.includes("|error|[Unavailable choice] Can\'t switch: The active Pokémon is trapped")));
  const replayDirectory = await fs.mkdtemp(path.join(directory, "trapped-replay-"));
  for (const [name, value] of Object.entries({
    "summary.json": JSON.stringify(result), "replay-inputs.json": JSON.stringify(result.replayInputs),
    "trajectory.jsonl": result.trajectory.map(row => JSON.stringify(row)).join("\n") + "\n", "replay.log": result.replay,
    ...Object.fromEntries(["p1", "p2"].map(side => [side + "-private.jsonl", result.playerTraces![side as "p1"].map(frame => JSON.stringify(frame)).join("\n") + "\n"]))
  })) await fs.writeFile(path.join(replayDirectory, name), value);
  for (const verifier of ["canonical", "native"]) await promisify(execFile)(process.execPath,
    ["--import", "tsx", `scripts/uu_eval/verify_${verifier}.ts`, replayDirectory],
    // The verifiers resolve from the project root whichever package directory runs the suite.
    { cwd: new URL("../../../../", import.meta.url).pathname, timeout: 20_000, env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
  const verified = JSON.parse(await fs.readFile(path.join(replayDirectory, "native-replay.json"), "utf8"));
  assert.equal(verified.trappedRejections, 1); assert.equal(verified.choices, result.trajectory.length);

});

test("turn, decision and wall-time caps report truncation without a winner", async () => {
  for (const limits of [{ maxTurns: 1 }, { maxDecisions: 1 }, { timeoutMs: 1 }]) {
    const result = await runBattleMatch({ ...base(), ...limits });
    assert.equal(result.status, "truncated", JSON.stringify(result.errors));
    assert.equal(result.outcome, null);
    assert.equal(result.winner, null);
    assert.equal(result.stopReason, "maxTurns" in limits ? "max_turns" : "maxDecisions" in limits ? "max_decisions" : "deadline");
  }
});

test("pre-aborted matches never call policies or dispatch, and remove caller listeners", async () => {
  const controller = new AbortController();
  controller.abort(new Error("PRIVATE_CALLER_REASON"));
  let calls = 0;
  const policy: BattlePolicy = { id: "must-not-run", async decide(input) { calls++; return new DeterministicBattlePolicy().decide(input); } };
  const result = await runBattleMatch({ ...base(), p1: policy, p2: policy, callerAbortSignal: controller.signal });
  assert.equal(result.status, "truncated");
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.outcome, null); assert.equal(result.winner, null);
  assert.equal(calls, 0);
  assert.deepEqual(result.trajectory, []); assert.deepEqual(result.fallbacks, []); assert.deepEqual(result.errors, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CALLER_REASON/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("caller abort cancels a pending policy without fallback, dispatch or late-result side effects", async () => {
  const controller = new AbortController();
  let started!: () => void, finish!: () => void, policySignal!: AbortSignal, calls = 0;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const policy: BattlePolicy = { id: "late-cancelled", async decide(input, { signal }) {
    calls++; policySignal = signal; started();
    await new Promise<void>((resolve) => { finish = resolve; });
    return new DeterministicBattlePolicy().decide(input);
  } };
  const choices = mock.method(Battle.prototype, "choose");
  try {
    const pending = runBattleMatch({ ...base(), p1: policy, callerAbortSignal: controller.signal });
    await began;
    controller.abort(new Error("PRIVATE_CALLER_REASON"));
    const result = await promptly(pending);
    assert.equal(policySignal.aborted, true);
    assert.equal(result.status, "truncated"); assert.equal(result.stopReason, "cancelled");
    assert.equal(result.outcome, null); assert.equal(result.winner, null);
    assert.deepEqual(result.trajectory, []); assert.deepEqual(result.fallbacks, []); assert.deepEqual(result.errors, []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    finish(); await delay(0);
    assert.equal(calls, 1);
    assert.equal(choices.mock.callCount(), 0, "late policy settlement must never reach simulator.choose");
  } finally { finish?.(); choices.mock.restore(); }
});

test("match cancellation reaches a queued executor; releasing its lock cannot choose later", async () => {
  const controller = new AbortController();
  let queued!: () => void, release!: () => void, lock: Promise<unknown> | undefined;
  const began = new Promise<void>((resolve) => { queued = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = BattleActionExecutor.prototype.execute;
  const executor = mock.method(BattleActionExecutor.prototype, "execute", async function (this: InstanceType<typeof BattleActionExecutor>, ...args: Parameters<typeof original>) {
    const [decision, options] = args;
    lock = this.engine.withCurrent(this.sessionId, decision.identity, async () => { queued(); await held; });
    return original.call(this, decision, options);
  });
  const choices = mock.method(Battle.prototype, "choose");
  try {
    const pending = runBattleMatch({ ...base(), callerAbortSignal: controller.signal });
    await began;
    controller.abort(new Error("PRIVATE_CALLER_REASON"));
    const result = await promptly(pending);
    assert.equal(result.status, "truncated"); assert.equal(result.stopReason, "cancelled");
    assert.equal(result.outcome, null); assert.equal(result.winner, null);
    assert.equal(result.trajectory.length, 1);
    assert.equal(result.trajectory[0]!.accepted, false);
    assert.equal(result.trajectory[0]!.identity.rqid, result.trajectory[0]!.rqid);
    assert.match(result.trajectory[0]!.reason!, /Deterministic candidate ranking/);
    assert.deepEqual(result.fallbacks, []); assert.deepEqual(result.errors, []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    release(); await lock; await delay(0);
    assert.equal(choices.mock.callCount(), 0);
  } finally { release(); await lock; executor.mock.restore(); choices.mock.restore(); }
});

test("cancellation after an accepted action preserves identity/reason and schedules no further moves", async () => {
  const controller = new AbortController();
  const result = await runBattleMatch({ ...base(), callerAbortSignal: controller.signal, onDecision({ decision }) {
    assert.ok(decision.identity.rqid); assert.ok(decision.reason);
    controller.abort();
  } });
  assert.equal(result.status, "truncated"); assert.equal(result.stopReason, "cancelled");
  assert.equal(result.outcome, null); assert.equal(result.winner, null);
  assert.equal(result.trajectory.length, 1); assert.equal(result.trajectory[0]!.accepted, true);
  assert.equal(result.trajectory[0]!.identity.rqid, result.trajectory[0]!.rqid);
  assert.match(result.trajectory[0]!.reason!, /Deterministic candidate ranking/);
  assert.deepEqual(result.fallbacks, []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const finished = new AbortController();
  const completed = await runBattleMatch({ ...base(), callerAbortSignal: finished.signal });
  assert.equal(completed.status, "completed");
  assert.equal(getEventListeners(finished.signal, "abort").length, 0);
});

test("invalid pinned UU teams are rejected before policies run and input sets remain unchanged", async () => {
  let calls = 0;
  const policy: BattlePolicy = { id: "must-not-run", async decide(_input: BattlePolicyInput) { calls++; throw new Error("unexpected"); } };
  const banned = Teams.import("Miraidon\nAbility: Hadron Engine\nEVs: 252 SpA / 4 SpD / 252 Spe\n- Electro Drift")!;
  const before = structuredClone(banned);
  await assert.rejects(runBattleMatch({ ...base(), p1: policy, teams: { p1: banned, p2: weak } }), /p1 team rejected by gen9uu.*Miraidon/);
  assert.equal(calls, 0);
  assert.deepEqual(banned, before);
  const sets = Teams.import(strong)!;
  const setsBefore = structuredClone(sets);
  assert.equal((await runBattleMatch({ ...base(), teams: { p1: sets, p2: weak } })).status, "completed");
  assert.deepEqual(sets, setsBefore);
});

test("recurrent policies receive ordered private channels before deciding and close after terminal frames", async () => {
  const frames = { p1: [] as string[], p2: [] as string[] };
  const closes = { p1: 0, p2: 0 };
  const policy = (side: "p1" | "p2"): BattlePolicy => {
    let identity: unknown = null;
    return {
      id: `recurrent-${side}`,
      async observe(data, context, { signal, deadlineAt }) {
        assert.equal(signal.aborted, false);
        assert.ok(deadlineAt > Date.now());
        assert.equal(context.side, side);
        assert.equal(context.sequence, frames[side].length + 1);
        assert.equal(context.format, "gen9uu");
        assert.doesNotMatch(data, /\|split\|/);
        for (const line of data.split("\n").filter((line) => line.startsWith("|request|"))) {
          assert.equal(JSON.parse(line.slice(9)).side.id, side);
        }
        frames[side].push(data);
        identity = structuredClone(context.identity);
      },
      async decide(input) {
        assert.deepEqual(input.envelope.semantic.identity, identity);
        assert.ok(frames[side].at(-1)?.includes("|request|"));
        return new DeterministicBattlePolicy().decide(input);
      },
      async close() { closes[side]++; }
    };
  };
  const result = await runBattleMatch({ ...base(), p1: policy("p1"), p2: policy("p2"), fallback: "none", trace: true });
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.deepEqual(closes, { p1: 1, p2: 1 });
  for (const side of ["p1", "p2"] as const) {
    assert.deepEqual(frames[side], result.playerTraces![side]);
    assert.match(frames[side].join("\n"), /\|win\|/);
  }
});

test("stalled recurrent observation cancels without decisions or fallback and still closes", async () => {
  const controller = new AbortController();
  let began!: () => void, received!: AbortSignal, closed = 0, decisions = 0;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const policy: BattlePolicy = {
    id: "stalled-observation",
    async observe(_data, _context, { signal }) { received = signal; began(); await new Promise(() => {}); },
    async decide(input) { decisions++; return new DeterministicBattlePolicy().decide(input); },
    async close() { closed++; }
  };
  const pending = runBattleMatch({ ...base(), p1: policy, callerAbortSignal: controller.signal });
  await started;
  controller.abort();
  const result = await promptly(pending);
  assert.equal(result.status, "truncated");
  assert.equal(result.stopReason, "cancelled");
  assert.equal(received.aborted, true);
  assert.equal(closed, 1); assert.equal(decisions, 0);
  assert.deepEqual(result.trajectory, []); assert.deepEqual(result.fallbacks, []);
});

test("failed observation cannot produce fallback advice and recurrent instances cannot be shared", async () => {
  let closed = 0, decisions = 0;
  const policy: BattlePolicy = {
    id: "failed-observation",
    async observe() { throw new Error("Observation rejected."); },
    async decide(input) { decisions++; return new DeterministicBattlePolicy().decide(input); },
    async close() { closed++; }
  };
  const result = await runBattleMatch({ ...base(), p1: policy });
  assert.equal(result.status, "failed");
  assert.equal(closed, 1); assert.equal(decisions, 0);
  assert.deepEqual(result.fallbacks, []);
  await assert.rejects(runBattleMatch({ ...base(), p1: policy, p2: policy }), /separate instance/);
  assert.equal(closed, 2, "shared recurrent policy closes exactly once after preflight rejection");
});

test("preflight and producer failures close each policy once without replacing the original error", async () => {
  const closes = [0, 0];
  const policy = (index: number): BattlePolicy => ({
    id: `preflight-${index}`,
    async decide(input) { return new DeterministicBattlePolicy().decide(input); },
    async close() { closes[index] = (closes[index] ?? 0) + 1; }
  });
  const p1 = policy(0), p2 = policy(1);
  await assert.rejects(runBattleMatch({ ...base(), p1, p2, maxTurns: 0 }), /maxTurns/);
  assert.deepEqual(closes, [1, 1]);
  await assert.rejects(runBattleMatch({ ...base(), p1, p2, teams: { p1: "", p2: weak } }), /empty/);
  assert.deepEqual(closes, [2, 2]);
  const read = fs.readFile;
  const spy = mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).includes("/battle-agent/simulator.")) throw new Error("Producer unavailable.");
    return read(...args);
  });
  try {
    await assert.rejects(runBattleMatch({ ...base(), p1, p2 }), /Producer unavailable/);
    assert.deepEqual(closes, [3, 3]);
  } finally { spy.mock.restore(); }
  const start = Date.now();
  await assert.rejects(runBattleMatch({ ...base(), maxTurns: 0,
    p1: { ...p1, async close() { await new Promise(() => {}); } } }), /maxTurns/);
  assert.ok(Date.now() - start < 3000, "uncooperative cleanup remains bounded");
});

test("Chilly Reception and Eject Button do not spend an opponent action twice", async () => {
  for (const mode of ["chilly", "eject"] as const) {
    const captures: DecisionEnvelope[] = [];
    const p1: BattlePolicy = { id: `scripted-${mode}`, async decide({ requestId, envelope }) {
      const s = envelope.semantic.snapshot;
      const actions = s.legalActions.filter((action) => !action.disabled && action.choice);
      let action;
      if (s.phase === "preview") action = actions.find((candidate) => candidate.kind === "team" && candidate.teamSpec?.[0] === 1);
      else if (s.rawRequestSummary?.requestKind === "forced_switch") {
        captures.push(envelope);
        assert.equal(s.yourSide.active?.species, "Slowking");
        assert.ok(s.yourSide.active!.hpPercent! > 0);
        assert.equal(s.turnCoverage?.source, "owned_offline_simulator");
        const prediction = envelope.semantic.localIntel.opponentActionPrediction!;
        assert.equal(prediction.replyTiming?.status, "spent");
        assert.deepEqual(prediction.topActions, []);
        assert.ok(envelope.semantic.localIntel.selfActionRecommendation!.rankedActions.every((candidate) =>
          candidate.riskFlags[0] === prediction.replyTiming!.summary
          && !candidate.scoreBreakdown?.some((part) => ["prediction", "search"].includes(part.key))));
        assert.deepEqual(s.opponentSide.active!.stats, {});
        assert.equal(s.opponentSide.active!.item, null);
        assert.equal(s.opponentSide.active!.ability, null);
        action = actions.find((candidate) => candidate.kind === "switch");
      } else {
        const move = s.yourSide.active?.species === "Scizor" ? "Bullet Punch"
          : mode === "chilly" ? "Chilly Reception" : s.turn === 1 ? "Protect" : "Scald";
        action = actions.find((candidate) => candidate.kind === "move" && !candidate.terastallize && candidate.moveName === move);
      }
      assert.ok(action);
      return { requestId, identity: envelope.semantic.identity, actionId: action.id };
    } };
    const p2: BattlePolicy = { id: "scripted-body-press", async decide({ requestId, envelope }) {
      const s = envelope.semantic.snapshot;
      const action = s.legalActions.find((candidate) => !candidate.disabled && (s.phase === "preview"
        ? candidate.kind === "team" : candidate.kind === "move" && candidate.moveName === "Body Press" && !candidate.terastallize));
      assert.ok(action);
      return { requestId, identity: envelope.semantic.identity, actionId: action.id };
    } };
    const result = await runBattleMatch({ p1, p2, format: "gen9uu", seed: [13, 27, 42, 81],
      maxTurns: 2, maxDecisions: 20, timeoutMs: 30_000, decisionDeadlineMs: 5000, fallback: "none",
      teams: { p1: `Slowking @ ${mode === "chilly" ? "Heavy-Duty Boots" : "Eject Button"}
Ability: Regenerator
Tera Type: Fairy
EVs: 252 HP / 252 Def / 4 SpD
Sassy Nature
IVs: 0 Spe
- Chilly Reception
- Protect
- Scald

Scizor @ Heavy-Duty Boots
Ability: Technician
EVs: 252 HP / 252 Atk / 4 Def
Adamant Nature
- Bullet Punch`, p2: `Donphan @ Heavy-Duty Boots
Ability: Sturdy
EVs: 252 HP / 252 Def / 4 Spe
Impish Nature
- Body Press` } });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.fallbacks, []);
    assert.equal(result.status, "truncated");
    assert.equal(captures.length, 1);
    const turn = captures[0]!.semantic.snapshot.turn;
    const segment = result.replay.split(`|turn|${turn}`).at(-1)!.split(`|turn|${turn + 1}`)[0]!;
    assert.equal(segment.match(/\|move\|p2a: Donphan\|Body Press/g)?.length, 1);
    assert.ok(segment.indexOf("|move|p2a: Donphan|Body Press") < segment.indexOf("|switch|p1a: Scizor|"));
  }
});


test("owned native checkpoints detach branches and preserve structural decisions through queued Tera pivot", async () => {
  const { checkpointOwnedBattle, advanceOwnedBattle } = await import("../battle-agent/simulator.js");
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  type Side = "p1" | "p2";
  type Message = { type: string; data: string | string[] };
  // Frozen fixture from the qualified native continuation experiment; no live history.
  const team = Teams.pack(Teams.import(await fs.readFile(new URL("../../../../examples/gen9uu-scizor-proposal.txt", import.meta.url), "utf8"))!);
  const producer = "frozenr25:79b29db97e730390c9cfb42691202383ffd1e39620363edb22b4d14d3483679b";
  const queue: Message[] = [];
  const original = new Battle({ formatid: new TeamValidator("gen9uu").format.id, seed: "9,4,2,7", send(type, data) { queue.push({ type, data: structuredClone(data) }); } });
  const roomId = "battle-gen9uu-owned-checkpoint";
  const prefix: Record<Side, string[]> = { p1: ["|init|battle"], p2: ["|init|battle"] };
  const counters = { p1: 0, p2: 0 };
  const engines = { p1: new DecisionEngine({ source: "owned_offline_simulator" }), p2: new DecisionEngine({ source: "owned_offline_simulator" }) };
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") return value.split("\n").map((line) => line.startsWith("|t:|") ? "|t:|" : line).join("\n");
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(key === "checkpointJson" ? JSON.parse(entry) : entry)]));
    return value;
  };
  const ingest = async (engine: InstanceType<typeof DecisionEngine>, frames: string[]) => {
    for (let i = 0; i < frames.length; i++) await engine.ingest({ sessionId: "owned", roomId, sequence: i + 1,
      observationId: `owned-${i + 1}`, source: "protocol", data: `>${roomId}\n${frames[i]}` });
    return engine.read("owned", roomId);
  };
  const route = (messages: Message[], rqids: Record<Side, number>) => {
    const result: Record<Side, string[]> = { p1: [], p2: [] };
    for (const message of messages) {
      const data = Array.isArray(message.data) ? message.data.join("\n") : message.data;
      if (message.type === "update") {
        const channels = extractChannelMessages(data, [0, 1, 2]);
        for (const side of ["p1", "p2"] as const) if (channels[side === "p1" ? 1 : 2].length) result[side].push(channels[side === "p1" ? 1 : 2].join("\n"));
      } else if (message.type === "sideupdate") {
        const split = data.indexOf("\n"), side = data.slice(0, split) as Side;
        assert.ok(side === "p1" || side === "p2");
        for (const line of data.slice(split + 1).split("\n")) {
          if (line.startsWith("|request|")) {
            const request = JSON.parse(line.slice(9));
            if (request !== null) {
              assert.equal(request.side.id, side);
              result[side].push(`|request|${JSON.stringify({ ...request, rqid: ++rqids[side] })}`);
            } else result[side].push(line);
          } else result[side].push(line);
        }
      } else assert.equal(message.type, "end");
    }
    return result;
  };
  const flush = async () => {
    const messages = queue.splice(0), routed = route(messages, counters);
    for (const side of ["p1", "p2"] as const) {
      prefix[side].push(...routed[side]);
      await ingest(engines[side], prefix[side]);
    }
    return messages;
  };
  const action = async (side: Side, predicate: (action: BattleSnapshot["legalActions"][number]) => boolean) => {
    const current = await engines[side].read("owned", roomId);
    const selected = current.snapshot!.legalActions.find((candidate) => !candidate.disabled && candidate.choice && predicate(candidate));
    assert.ok(selected?.choice, `${side} enabled structural action`);
    return { side, choice: selected.choice };
  };
  const step = async (input: { side: Side; choice: string }) => {
    assert.equal(original.choose(input.side, input.choice), true);
    original.sendUpdates();
    return flush();
  };
  const compareBranch = async (steps: Array<[Side, (action: BattleSnapshot["legalActions"][number]) => boolean]>) => {
    const checkpoint = await checkpointOwnedBattle(original, producer), sibling = structuredClone(checkpoint);
    const before = JSON.stringify(original.toJSON());
    const first = await action(steps[0]![0], steps[0]![1]);
    const current = await engines[first.side].read("owned", roomId);
    const alternative = current.snapshot!.legalActions.find((candidate) => !candidate.disabled && candidate.choice && candidate.choice !== first.choice)!;
    const negative = await advanceOwnedBattle(checkpoint, [{ side: first.side, choice: alternative.choice! }], producer);
    assert.notEqual(negative.checkpoint.checkpointJson, checkpoint.checkpointJson);
    assert.equal(JSON.stringify(original.toJSON()), before, "choice probe cannot touch source");
    assert.deepEqual(checkpoint, sibling, "choice probe cannot touch sibling checkpoint");
    let branch = checkpoint;
    const branchPrefix = structuredClone(prefix), branchCounters = { ...counters };
    const branchEngines = { p1: new DecisionEngine({ source: "owned_offline_simulator" }), p2: new DecisionEngine({ source: "owned_offline_simulator" }) };
    for (const [side, predicate] of steps) {
      const input = await action(side, predicate);
      const fork = await advanceOwnedBattle(branch, [input], producer);
      const repeat = await advanceOwnedBattle(branch, [input], producer);
      assert.deepEqual(normalize(fork), normalize(repeat));
      const actual = await step(input);
      assert.deepEqual(normalize(fork.emittedMessages), normalize(actual));
      assert.deepEqual(normalize(JSON.parse(fork.checkpoint.checkpointJson)), normalize(JSON.parse(JSON.stringify(original.toJSON()))), "native queue/state/current RNG parity");
      const routed = route(fork.emittedMessages, branchCounters);
      for (const recipient of ["p1", "p2"] as const) {
        branchPrefix[recipient].push(...routed[recipient]);
        const restored = await ingest(branchEngines[recipient], branchPrefix[recipient]);
        const live = await engines[recipient].read("owned", roomId);
        assert.deepEqual(restored.identity, live.identity, "same ledger prefix gives same canonical identity");
        assert.deepEqual(restored.snapshot!.legalActions, live.snapshot!.legalActions);
      }
      branch = fork.checkpoint;
    }
  };
  const move = (id: string, tera = false) => (candidate: BattleSnapshot["legalActions"][number]) => candidate.moveId === id && Boolean(candidate.terastallize) === tera;
  try {
    original.setPlayer("p1", { name: "Fixture Alpha", team });
    original.setPlayer("p2", { name: "Fixture Beta", team });
    original.sendUpdates(); await flush();
    await step(await action("p1", (candidate) => candidate.choice === "team 412356"));
    await step(await action("p2", (candidate) => candidate.choice === "team 123456"));
    await step(await action("p1", move("scald")));
    await step(await action("p2", move("moonblast")));
    assert.equal(original.turn, 2);
    await compareBranch([["p1", move("futuresight")], ["p2", move("moonblast")]]);
    await step(await action("p1", move("scald")));
    await compareBranch([["p2", move("uturn", true)]]);
    assert.equal(original.requestState, "switch");
    assert.equal(original.p1.activeRequest!.wait, true);
    await compareBranch([["p2", (candidate) => candidate.choice === "switch 2"], ["p1", move("slackoff")], ["p2", move("stealthrock")]]);
    assert.equal(original.turn, 5);
    assert.ok(original.log.some((line) => line.includes("|-end|") && line.includes("Future Sight")));
    const checkpoint = await checkpointOwnedBattle(original, producer);
    await assert.rejects(advanceOwnedBattle({ ...checkpoint, checkpointJson: "invalid", simulatorVersion: "other" }, [], producer), /version mismatch/);
    await assert.rejects(advanceOwnedBattle({ ...checkpoint, checkpointJson: "invalid" }, [], "other"), /producer mismatch/);
    await assert.rejects(advanceOwnedBattle(checkpoint, [{ side: "p1", choice: "move 999" }], producer), /reject|error/i);
    await assert.rejects(advanceOwnedBattle(checkpoint, [{ side: "p3" as Side, choice: "move 1" }], producer), /Invalid/);
    await assert.rejects(advanceOwnedBattle({ ...checkpoint, checkpointJson: "invalid" }, [], producer));
    await assert.rejects(checkpointOwnedBattle(original, ""), /producer/);
    const mutable = structuredClone(checkpoint), inputs = [await action("p1", move("slackoff"))];
    const expected = await advanceOwnedBattle(checkpoint, inputs, producer);
    const pending = advanceOwnedBattle(mutable, inputs, producer);
    mutable.checkpointJson = "invalid"; mutable.producerHash = "other"; mutable.simulatorVersion = "other";
    inputs[0]!.side = "p2"; inputs[0]!.choice = "move 999";
    assert.deepEqual(normalize(await pending), normalize(expected), "capture caller state and choices before first await");
    assert.equal(JSON.stringify(original.toJSON()), checkpoint.checkpointJson);
  } finally { original.destroy(); }
});


test("selected owned checkpoints bind predispatch actors without changing ordinary policy or protocol", async () => {
  const { hashCanonical } = await import("../../../extension/lib/decision-identity.js");
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  const selected = [1, 2, 99];
  const observations: unknown[] = [], inputs: unknown[] = [];
  const policy: BattlePolicy = { id: "capture-privacy", async decide(input) {
    assert.deepEqual(Object.keys(input).sort(), ["envelope", "requestId"]);
    inputs.push(structuredClone(input));
    return new DeterministicBattlePolicy().decide(input);
  } };
  const pending = runBattleMatch({ ...base(), p1: policy, p2: policy, trace: true, ownedCheckpointAt: selected,
    maxDecisions: 2, onDecision(event) { observations.push(event); } });
  selected.splice(0, selected.length, 3);
  const result = await pending;
  const ordinary = await runBattleMatch({ ...base(), p1: policy, p2: policy, trace: true, maxDecisions: 2 });
  assert.equal("ownedCheckpoints" in ordinary, false);
  assert.equal("ownedCheckpointSelection" in ordinary, false);
  assert.equal(withoutTime(result.replay), withoutTime(ordinary.replay));
  assert.deepEqual(result.playerTraces!.p1.map(withoutTime), ordinary.playerTraces!.p1.map(withoutTime));
  assert.deepEqual(result.playerTraces!.p2.map(withoutTime), ordinary.playerTraces!.p2.map(withoutTime));
  assert.deepEqual(result.trajectory.map(({ latencyMs, ...row }) => row), ordinary.trajectory.map(({ latencyMs, ...row }) => row));
  assert.deepEqual(result.ownedCheckpointSelection, { requested: [1, 2, 99], captured: [1, 2], uncaptured: [], unreached: [99] });
  assert.equal(result.ownedCheckpoints!.length, 2);
  for (const capture of result.ownedCheckpoints!) {
    const record = result.trajectory[capture.trajectoryIndex - 1]!;
    assert.equal(capture.contractVersion, "owned-offline-decision-checkpoint@1");
    assert.equal(capture.requestId, record.requestId); assert.deepEqual(capture.identity, record.identity);
    assert.equal(capture.inputResultHash, record.inputResultHash); assert.equal(capture.roomId, record.identity.roomId);
    assert.equal(capture.checkpoint.producerHash, result.versions.producer);
    assert.equal(capture.checkpointHash, await hashCanonical(capture.checkpoint.checkpointJson));
    const native = Battle.fromJSON(capture.checkpoint.checkpointJson);
    try {
      assert.equal(native[capture.side].choice.actions.length, 0, "actor has not dispatched");
      assert.equal(native.p1.choice.actions.length > 0, capture.side === "p2", "second actor retains pending first choice");
    } finally { native.destroy(); }
    const engine = new DecisionEngine({ source: "owned_offline_simulator" });
    const context = capture.externalContext[capture.side];
    assert.equal(context.rqid, record.rqid); assert.equal(context.sequence, context.tracePrefixLength);
    const prefix = result.playerTraces![capture.side].slice(0, context.tracePrefixLength);
    for (const [i, frame] of prefix.entries()) await engine.ingest({ sessionId: "offline-" + capture.side,
      roomId: capture.roomId, sequence: i + 1, observationId: `${capture.side}-${i + 1}`, source: "protocol", data: `>${capture.roomId}\n${frame}` });
    assert.deepEqual((await engine.read("offline-" + capture.side, capture.roomId)).identity, capture.identity);
  }
  assert.doesNotMatch(JSON.stringify({ inputs, observations }), /checkpointJson|ownedCheckpoints/);
  const sibling = structuredClone(result.ownedCheckpoints![1]);
  const recordsBefore = structuredClone(result.trajectory), inputsBefore = structuredClone(inputs);
  // Mutate the actual returned capture, rather than a copy of it.
  result.ownedCheckpoints![0]!.checkpoint.checkpointJson = "changed";
  result.ownedCheckpoints![0]!.identity.rqid = 999;
  result.ownedCheckpoints![0]!.externalContext.p2.rqid = 999;
  assert.deepEqual(result.ownedCheckpoints![1], sibling);
  assert.deepEqual(result.trajectory, recordsBefore); assert.deepEqual(inputs, inputsBefore);
});

test("selected owned indices reject invalid or untraced requests before policies", async () => {
  let calls = 0;
  const policy: BattlePolicy = { id: "must-not-decide", async decide(input) { calls++; return new DeterministicBattlePolicy().decide(input); } };
  for (const selection of [[0], [-1], [1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1], [1, 1]]) {
    await assert.rejects(runBattleMatch({ ...base(), p1: policy, trace: true, ownedCheckpointAt: selection }), /ownedCheckpointAt/);
  }
  await assert.rejects(runBattleMatch({ ...base(), p1: policy, ownedCheckpointAt: [1] }), /trace/);
  assert.equal(calls, 0);
});

for (const mode of ["cancel", "deadline"] as const) test(`selected owned capture ${mode} cannot append or dispatch after its original deadline`, async () => {
  const controller = new AbortController();
  let entered!: () => void, release!: () => void, metadataReads = 0;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const read = fs.readFile;
  const spy = mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith("/node_modules/pokemon-showdown/package.json") && ++metadataReads === 2) { entered(); await held; }
    return read(...args);
  });
  const choose = mock.method(Battle.prototype, "choose");
  try {
    const pending = runBattleMatch({ ...base(), trace: true, ownedCheckpointAt: [1, 2], callerAbortSignal: controller.signal, decisionDeadlineMs: 100 });
    await began;
    if (mode === "cancel") controller.abort();
    const result = await promptly(pending);
    assert.equal(result.stopReason, mode === "cancel" ? "cancelled" : "error");
    assert.equal(result.trajectory.length, 1); assert.equal(result.trajectory[0]!.accepted, false);
    assert.deepEqual(result.ownedCheckpoints, []);
    assert.deepEqual(result.ownedCheckpointSelection, { requested: [1, 2], captured: [], uncaptured: [1], unreached: [2] });
    release(); await delay(20);
    assert.deepEqual(result.ownedCheckpoints, []); assert.equal(choose.mock.callCount(), 0);
  } finally { release(); spy.mock.restore(); choose.mock.restore(); }
});

test("selected owned CLI validates private output before policies and keeps native state out of stdout", { timeout: 30_000 }, async () => {
  const root = new URL("../../../../", import.meta.url).pathname;
  const temp = await fs.mkdtemp(path.join(directory, "owned-cli-"));
  const team = path.join(temp, "team.txt"); await fs.writeFile(team, strong);
  const invoke = async (args: string[]) => {
    try { return { ...(await promisify(execFile)(process.execPath, ["--import", "tsx", new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname, ...args],
      { timeout: 10_000, maxBuffer: 1_048_576, env: { ...process.env, LOCAL_INTEL_STORE_PATH: historyPath, EXTERNAL_CURATED_STORE_PATH: curatedPath } })), code: 0 }; }
    catch (error) { return error as Error & { code: number; stdout: string; stderr: string }; }
  };
  for (const args of [
    ["--owned-checkpoint-at", "0", "--trace"], ["--owned-checkpoint-at", "1.5", "--trace"],
    ["--owned-checkpoint-at", "9007199254740992", "--trace"],
    ["--owned-checkpoint-at", "1", "--owned-checkpoint-at", "1", "--trace"], ["--owned-checkpoint-at", "1"]
  ]) {
    const result = await invoke([...args, "--p1", "must-not-construct"]);
    assert.equal(result.code, 1); assert.match(result.stderr, /owned-checkpoint-at|requires --trace/); assert.equal(result.stdout, "");
  }
  const alias = path.join(temp, "project-link"); await fs.symlink(root, alias, "dir");
  for (const output of [path.join(root, "owned-checkpoint-must-not-create"), path.join(alias, "owned-checkpoint-must-not-create")]) {
    const result = await invoke(["--trace", "--owned-checkpoint-at", "1", "--output", output, "--p1", "must-not-construct"]);
    assert.equal(result.code, 1); assert.match(result.stderr, /outside the project/); assert.equal(result.stdout, "");
    await assert.rejects(fs.stat(output), { code: "ENOENT" });
  }
  const output = path.join(temp, "private-run");
  const result = await invoke(["--trace", "--owned-checkpoint-at", "1", "--owned-checkpoint-at", "2", "--owned-checkpoint-at", "99",
    "--team", team, "--p1", "deterministic", "--p2", "random", "--max-decisions", "2", "--output", output]);
  assert.equal(result.code, 2, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.ownedCheckpointSelection, { requested: [1, 2, 99], captured: [1, 2], uncaptured: [], unreached: [99] });
  assert.deepEqual(JSON.parse(await fs.readFile(summary.paths.summary, "utf8")), summary);
  assert.doesNotMatch(result.stdout, /checkpointJson|checkpointHash|prngSeed|externalContext/);
  const ordinaryOutput = path.join(temp, "ordinary-run");
  const ordinary = await invoke(["--trace", "--team", team, "--p1", "deterministic", "--p2", "random", "--max-decisions", "2", "--output", ordinaryOutput]);
  assert.equal(ordinary.code, 2, ordinary.stderr || ordinary.stdout);
  const ordinarySummary = JSON.parse(ordinary.stdout);
  assert.equal("ownedCheckpointSelection" in ordinarySummary, false);
  assert.equal("ownedCheckpoints" in ordinarySummary.paths, false);
  assert.deepEqual((await fs.readdir(output)).filter((name) => name !== "owned-checkpoints.jsonl").sort(), (await fs.readdir(ordinaryOutput)).sort());
  const captures = (await fs.readFile(summary.paths.ownedCheckpoints, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.length, 2); assert.ok(captures.every((entry) => entry.checkpoint.checkpointJson));
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  for (const side of ["p1", "p2"] as const) {
    const parsed: string[][] = [];
    for (const saved of [summary, ordinarySummary]) {
      const tracePath = saved.paths[`${side}Trace`];
      const content = await fs.readFile(tracePath, "utf8");
      const frames: unknown[] = content ? content.trimEnd().split("\n").map((line) => JSON.parse(line)) : [];
      assert.ok(frames.every((frame) => typeof frame === "string"), "one JSON string per routed observation frame");
      const strings = frames as string[];
      assert.ok(strings.some((frame) => frame.includes("\n")), "actual multiline update survives JSONL roundtrip");
      assert.equal(path.basename(tracePath), `${side}-private.jsonl`);
      assert.ok(!(await fs.readdir(path.dirname(tracePath))).includes(`${side}-private.log`));
      for (const frame of strings) for (const line of frame.split("\n")) {
        if (line.startsWith("|request|")) assert.equal(JSON.parse(line.slice(9)).side.id, side);
      }
      if (process.platform !== "win32") assert.equal((await fs.stat(tracePath)).mode & 0o777, 0o600);
      parsed.push(strings);
    }
    assert.deepEqual(parsed[0]!.map(withoutTime), parsed[1]!.map(withoutTime), "selected and ordinary trace frames are exact except clocks");
    for (const capture of captures.filter((entry) => entry.side === side)) {
      const context = capture.externalContext[side];
      const prefix = parsed[0]!.slice(0, context.tracePrefixLength);
      assert.equal(prefix.length, context.sequence);
      const engine = new DecisionEngine({ source: "owned_offline_simulator" });
      for (const [i, frame] of prefix.entries()) await engine.ingest({ sessionId: `offline-${side}`,
        roomId: capture.roomId, sequence: i + 1, observationId: `${side}-${i + 1}`, source: "protocol", data: `>${capture.roomId}\n${frame}` });
      const current = await engine.read(`offline-${side}`, capture.roomId);
      assert.deepEqual(current.identity, capture.identity, "saved JSONL prefix restores the whole canonical identity");
      assert.equal(current.identity!.rqid, context.rqid);
    }
  }
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(summary.paths.ownedCheckpoints)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(output)).mode & 0o777, 0o700);
  }
});

test("scripted hybrid pipeline keeps actor and opponent observations separate and commits before advancing", async () => {
  const { MetamonAdvisedBattlePolicy } = await import("../battle-agent/metamon.js");
  type Event = import("../battle-agent/metamon.js").MetamonAdviceEvent;
  const events: Event[] = [], seen: BattlePolicyInput[] = [];
  const recurrent = (expectedSide: "p1" | "p2") => {
    let pending = false, proposals = 0, observations = 0;
    const committed: string[] = [];
    return { id: "metamon:Kakuna:epoch34" as const,
      observe: async (data: string, context: { side: "p1" | "p2" }) => {
        assert.equal(pending, false, "executor acceptance precedes later observations");
        assert.equal(context.side, expectedSide); observations++;
        for (const line of data.split("\n")) if (line.startsWith("|request|")) {
          const request = JSON.parse(line.slice(9)); if (request?.side) assert.equal(request.side.id, expectedSide);
        }
      },
      decide: async (value: BattlePolicyInput) => {
        assert.equal(pending, false); assert.equal(value.envelope.semantic.snapshot.yourSide.slot, expectedSide);
        const enabled = value.envelope.semantic.snapshot.legalActions.filter((action) => action.choice && !action.disabled && action.legality !== "disabled");
        pending = true; proposals++;
        return { requestId: value.requestId, identity: value.envelope.semantic.identity, actionId: enabled.at(-1)!.id };
      },
      commit: async (_value: BattlePolicyInput, accepted: { actionId: string }) => { assert.equal(pending, true); committed.push(accepted.actionId); pending = false; },
      close: async () => {}, counts: () => ({ proposals, observations, commits: committed.length }), committed
    };
  };
  const actor = recurrent("p1"), opponent = recurrent("p2"), deterministic = new DeterministicBattlePolicy();
  const primary: BattlePolicy = { id: "scripted-model", decide: async (value, operation) => {
    seen.push(structuredClone(value)); return deterministic.decide(value);
  } };
  const hybrid = new MetamonAdvisedBattlePolicy(primary, actor, { onAdvice: (event) => { events.push(event); } });
  const result = await runBattleMatch({ ...base(), p1: hybrid, p2: opponent, maxTurns: 3, trace: true });
  assert.equal(result.errors.length, 0); assert.equal(result.fallbacks.length, 0);
  assert.ok(["completed", "truncated"].includes(result.status));
  for (const [side, policy] of [["p1", actor], ["p2", opponent]] as const) {
    const choices = result.trajectory.filter((entry) => entry.side === side);
    assert.equal(policy.counts().proposals, choices.length); assert.equal(policy.counts().commits, choices.length);
    assert.ok(policy.counts().observations > 0);
    assert.deepEqual(policy.committed, choices.map((entry) => entry.actionId));
  }
  assert.ok(seen.some((value) => value.advice !== undefined));
  for (const value of seen) if (value.advice) {
    assert.equal(value.advice.inputResultHash, value.envelope.resultHash);
    assert.deepEqual(value.advice.identity, value.envelope.semantic.identity);
    assert.ok(!("advice" in value.envelope.semantic));
  }
  assert.equal(events.filter((event) => event.phase === "commit").length, actor.counts().commits);
  assert.equal(await fs.readFile(historyPath, "utf8"), sentinel);
});


test("pinned current UU bank validates and native restoration retains the same rules", async () => {
  const bank = await fs.readFile(new URL("../../../../examples/gen9uu-opponent-bank.txt", import.meta.url), "utf8");
  const imports = bank.split(/^=== .* ===\s*$/m).map((body) => body.trim()).filter(Boolean);
  assert.equal(imports.length, 6);
  const validator = new TeamValidator("gen9uu");
  const home = Teams.import(await fs.readFile(new URL("../../../../examples/gen9uu-scizor-proposal.txt", import.meta.url), "utf8"))!;
  assert.equal(validator.validateTeam(home), null);
  for (const body of imports) {
    const team = Teams.import(body)!;
    assert.equal(team.length, 6);
    assert.equal(validator.validateTeam(team), null);
    const native = new Battle({ formatid: validator.format.id, seed: "9,4,2,7" });
    let restored: InstanceType<typeof Battle> | undefined;
    try {
      native.setPlayer("p1", { name: "Alex", team: Teams.pack(home) });
      native.setPlayer("p2", { name: "Morgan", team: Teams.pack(team) });
      const checkpoint = await (await import("../battle-agent/simulator.js")).checkpointOwnedBattle(native, "bank-fixture");
      restored = Battle.fromJSON(checkpoint.checkpointJson);
      assert.equal(restored.format.id, validator.format.id);
      assert.equal(restored.dex.species.get("Heatran").tier, "UU");
      assert.deepEqual(restored.ruleTable.isBanned("move:terablast"), true);
      assert.deepEqual(restored.toJSON(), JSON.parse(checkpoint.checkpointJson));
    } finally { restored?.destroy(); native.destroy(); }
  }
  assert.ok(validator.validateTeam(Teams.import("Miraidon\nAbility: Hadron Engine\n- Electro Drift")!)?.length);
  const teraBlast = structuredClone(home); teraBlast[0]!.moves[0] = "Tera Blast";
  assert.ok(validator.validateTeam(teraBlast)?.some((problem) => problem.includes("Tera Blast")));
});
