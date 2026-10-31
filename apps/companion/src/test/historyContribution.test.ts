import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DecisionEngine } from "../state/decisionEngine.js";
import { parseInferenceEvents } from "../mechanics/inferenceEvents.js";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-contributions-"));
process.env.LOCAL_INTEL_STORE_PATH = path.join(directory, "history.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(directory, "curated.json");
const { commitCanonicalSnapshots, buildLocalIntelSnapshot, captureIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
const roomId = "battle-gen9uu-contributions";
const request = { rqid: 1, side: { id: "p1", pokemon: [{ ident: "p1: Friend", details: "Slowking", active: true, condition: "350/350", baseAbility: "Regenerator", item: "", moves: ["scald"], stats: { spe: 100 } }] }, active: [{ moves: [{ move: "Scald", id: "scald", pp: 15 }] }] };

test("Illusion history projection is reversible and replaying the same contribution set adds no counts", async () => {
  const engine = new DecisionEngine(); let sequence = 0;
  const ingest = async (lines: string) => {
    const current = await engine.ingest({ roomId, sessionId: "fixture", sequence: ++sequence, observationId: `event-${sequence}`, source: "protocol", data: `>${roomId}\n${lines}` });
    return { current, context: await commitCanonicalSnapshots([current.snapshot!]) };
  };
  const first = await ingest(`|tier|[Gen 9] UU\n|poke|p2|Mamoswine\n|poke|p2|Zoroark-Hisui\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Mammoth|Mamoswine|100/100\n|move|p2a: Mammoth|Hyper Voice|p1a: Friend\n|-status|p2a: Mammoth|brn\n|-damage|p2a: Mammoth|90/100 brn|[from] item: Life Orb\n|request|${JSON.stringify(request)}`);
  assert.deepEqual(first.current.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.instanceId.includes(":p2:")), []);
  const revealed = await ingest("|replace|p2a: Fox|Zoroark-Hisui|90/100 brn");
  const intel = await buildLocalIntelSnapshot(revealed.current.snapshot!, revealed.context);
  const fox = intel.opponents.find((entry) => entry.species === "Zoroark-Hisui")!;
  const mammoth = intel.opponents.find((entry) => entry.species === "Mamoswine")!;
  assert.deepEqual(fox.revealedMoves, ["Hyper Voice"]); assert.deepEqual(mammoth.revealedMoves, []);
  assert.equal(fox.battlesSeen, 1); assert.equal(mammoth.battlesSeen, 0);
  const events = parseInferenceEvents(revealed.current.snapshot!);
  assert.ok(events.some((event) => event.kind === "attack_recoil" && event.species === "Zoroark-Hisui"));
  assert.ok(events.every((event) => event.factIds!.length && event.factIds!.every((id) => revealed.current.snapshot!.canonicalEvidence!.facts.some((fact) => fact.id === id))));
  const again = await commitCanonicalSnapshots([revealed.current.snapshot!]);
  assert.deepEqual((await buildLocalIntelSnapshot(revealed.current.snapshot!, again)).opponents, intel.opponents);
  const erased = structuredClone(revealed.current.snapshot!); erased.recentLog = ["Mamoswine had HP change from Leftovers.", "Mamoswine used Ice Shard."];
  const altered = await buildLocalIntelSnapshot(erased, revealed.context);
  assert.deepEqual(parseInferenceEvents(erased), events);
  const { generatedAt: _one, ...semantic } = intel, { generatedAt: _two, ...changed } = altered;
  assert.deepEqual(changed, semantic);
  const context = await captureIntelEvaluationContext();
  assert.deepEqual(context.store.canonicalBattles![roomId]!.contributions, revealed.current.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.instanceId.includes(":p2:")));
});

test("unbound recovery preserves confirmed history until authoritative initialization restores promotion", async () => {
  const live = new DecisionEngine(), recovery = new DecisionEngine();
  const data = `>${roomId}-reconnect\n|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p2a: Elephant|Donphan|100/100\n|turn|1\n|move|p2a: Elephant|Earthquake|p1a: Friend\n|request|${JSON.stringify(request)}`;
  const first = await live.ingest({ sessionId: "live", roomId: `${roomId}-reconnect`, observationId: "wire", sequence: 1, source: "protocol", data });
  const before = await commitCanonicalSnapshots([first.snapshot!]);
  const recovered = await recovery.ingest({ sessionId: "new-capture", roomId: `${roomId}-reconnect`, observationId: "recovery", sequence: 1, source: "recovery", data: data.replace(JSON.stringify(request), JSON.stringify({ ...request, requestType: "move" })) });
  assert.ok(recovered.snapshot!.canonicalEvidence!.contributions.every((entry) => entry.eligibility === "quarantined"));
  const after = await commitCanonicalSnapshots([recovered.snapshot!]);
  assert.deepEqual(after.store.canonicalBattles![`${roomId}-reconnect`]!.contributions, before.store.canonicalBattles![`${roomId}-reconnect`]!.contributions);
  const result = await buildLocalIntelSnapshot(recovered.snapshot!, after);
  assert.equal(result.opponents.find((entry) => entry.species === "Donphan"), undefined);
  const historical = await buildLocalIntelSnapshot(first.snapshot!, after);
  assert.equal(historical.opponents.find((entry) => entry.species === "Donphan")!.battlesSeen, 1);
  const advanced = await recovery.ingest({ sessionId: "new-capture", roomId: `${roomId}-reconnect`, observationId: "new-wire", sequence: 2,
    source: "protocol", data: `>${roomId}-reconnect\n|move|p2a: Elephant|Knock Off|p1a: Friend` });
  const committed = await commitCanonicalSnapshots([advanced.snapshot!]);
  const donor = (await buildLocalIntelSnapshot(first.snapshot!, committed)).opponents.find((entry) => entry.species === "Donphan")!;
  assert.equal(donor.battlesSeen, 1);
  assert.ok(advanced.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  assert.ok(advanced.snapshot!.canonicalEvidence!.facts.some((fact) => fact.kind === "move" && fact.args[1] === "Knock Off"));
  assert.deepEqual({ ...committed.store, updatedAt: null }, { ...after.store, updatedAt: null });
  assert.ok(donor.revealedMoves.includes("Earthquake") && !donor.revealedMoves.includes("Knock Off"));
  const restored = await recovery.ingest({ sessionId: "new-capture", roomId: `${roomId}-reconnect`, observationId: "authoritative-init", sequence: 3,
    source: "protocol", data: data.replace(`>${roomId}-reconnect\n`, `>${roomId}-reconnect\n|init|battle\n`) + "\n|move|p2a: Elephant|Knock Off|p1a: Friend" });
  assert.ok(!restored.snapshot!.canonicalEvidence!.limitations.includes("recovery_public_continuity_unknown"));
  const restoredContext = await commitCanonicalSnapshots([restored.snapshot!]);
  const trusted = (await buildLocalIntelSnapshot(restored.snapshot!, restoredContext)).opponents.find((entry) => entry.species === "Donphan")!;
  assert.equal(trusted.battlesSeen, 1);
  assert.ok(trusted.revealedMoves.includes("Earthquake") && trusted.revealedMoves.includes("Knock Off"));
  assert.equal(restoredContext.store.canonicalBattles![`${roomId}-reconnect`]!.contributions.filter((entry) => entry.metric === "move" && entry.eligibility === "active").length, 2);
});

test("referenced contact defender carries its own binding ancestry and recovery-only binding cannot promote inference", async () => {
  const engine = new DecisionEngine(); let sequence = 0;
  const ingest = (lines: string, source: "protocol" | "recovery" = "protocol") => engine.ingest({ roomId: `${roomId}-contact`, sessionId: "contact", sequence: ++sequence,
    observationId: `contact-${sequence}`, source, data: `>${roomId}-contact\n${lines}` });
  const timeline = `|tier|[Gen 9] UU\n|poke|p2|Mamoswine\n|poke|p2|Zoroark-Hisui\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Mammoth|Mamoswine|100/100\n|request|${JSON.stringify(request)}\n|move|p1a: Friend|Tackle|p2a: Mammoth\n|-damage|p1a: Friend|90/100|[from] item: Rocky Helmet|[of] p2a: Mammoth`;
  await ingest(timeline);
  const resolved = await ingest("|replace|p2a: Fox|Zoroark-Hisui|100/100");
  const event = parseInferenceEvents(resolved.snapshot!).find((entry) => entry.kind === "contact_recoil")!;
  const replacement = resolved.snapshot!.canonicalEvidence!.facts.find((fact) => fact.kind === "replace")!;
  assert.equal(event.species, "Zoroark-Hisui");
  assert.equal(event.appearanceId, replacement.subject.appearanceId);
  assert.ok(event.factIds!.includes(replacement.id));
  const fresh = new DecisionEngine();
  const recoveryRoom = `${roomId}-contact-recovered`;
  await fresh.ingest({ roomId: recoveryRoom, sessionId: "recovered", sequence: 1, observationId: "live-before-recovery", source: "protocol",
    data: `>${recoveryRoom}\n${timeline}` });
  const recovered = await fresh.ingest({ roomId: recoveryRoom, sessionId: "recovered", sequence: 2, observationId: "recovery-binding", source: "recovery",
    data: `>${recoveryRoom}\n${timeline}\n|replace|p2a: Fox|Zoroark-Hisui|100/100` });
  assert.deepEqual(parseInferenceEvents(recovered.snapshot!), []);
});

test("raw completed damage windows retain impact context and reversible extrema after appearance rebinding", async () => {
  const engine = new DecisionEngine(), damageRoom = `${roomId}-damage`; let sequence = 0;
  const ingest = (data: string) => engine.ingest({ roomId: damageRoom, sessionId: "damage", sequence: ++sequence, observationId: `damage-${sequence}`, source: "protocol", data: `>${damageRoom}\n${data}` });
  const privateState = structuredClone(request);
  privateState.side.pokemon[0]!.stats = { hp: 350, atk: 150, def: 200, spa: 250, spd: 300, spe: 100 } as any;
  await ingest(`|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|Donphan|100/100 brn\n|request|${JSON.stringify(privateState)}`);
  const pending = await ingest("|move|p2a: Elephant|Knock Off|p1a: Friend\n|-damage|p1a: Friend|280/350");
  assert.equal(pending.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.metric === "damage").length, 0);
  const completed = await ingest("|turn|2");
  const windows = completed.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.metric === "damage");
  assert.equal(windows.length, 2);
  assert.equal(windows[0]!.damage!.percent, 20);
  assert.equal(windows[0]!.damage!.defender.hpPercent, 100);
  assert.equal(windows[0]!.damage!.defender.stats!.def, 200);
  const context = await commitCanonicalSnapshots([completed.snapshot!]);
  const intel = await buildLocalIntelSnapshot(completed.snapshot!, context);
  assert.ok(intel.opponents.find((entry) => entry.species === "Donphan")!.posterior!.evidence.some((entry) => entry.kind === "damage"));
  const second = await ingest("|move|p2a: Elephant|Knock Off|p1a: Friend\n|-damage|p1a: Friend|200/350\n|turn|3");
  const beforeRebind = await commitCanonicalSnapshots([second.snapshot!]);
  const original = beforeRebind.store.canonicalBattles![damageRoom]!.contributions.filter((entry) => entry.metric === "damage");
  assert.equal(original.length, 2);
  assert.deepEqual(original.map((entry) => entry.damage!.percent), [20, 22.9]);
  const rebound = await ingest("|replace|p2a: Fox|Zoroark-Hisui|100/100 brn");
  const afterRebind = await commitCanonicalSnapshots([rebound.snapshot!]);
  const reassigned = afterRebind.store.canonicalBattles![damageRoom]!.contributions.filter((entry) => entry.metric === "damage");
  assert.deepEqual(reassigned.map((entry) => entry.id), original.map((entry) => entry.id));
  assert.ok(reassigned.every((entry) => entry.species === "Zoroark-Hisui"));
  const afterIntel = await buildLocalIntelSnapshot(rebound.snapshot!, afterRebind);
  assert.ok(afterIntel.opponents.find((entry) => entry.species === "Zoroark-Hisui")!.posterior!.evidence.some((entry) => entry.kind === "damage"));
  const persisted = afterRebind.store.canonicalBattles![damageRoom]!.contributions;
  assert.ok(!persisted.some((entry) => entry.species === "Donphan"));
});

test("critical, capped, residual and multi-hit damage cannot become exact single-roll evidence", async () => {
  for (const middle of ["|-crit|p1a: Friend\n|-damage|p1a: Friend|280/350", "|-ability|p1a: Friend|Sturdy\n|-damage|p1a: Friend|1/350", "|-enditem|p1a: Friend|Focus Sash\n|-damage|p1a: Friend|1/350", "|-activate|p1a: Friend|item: Focus Band\n|-damage|p1a: Friend|1/350", "|-damage|p1a: Friend|280/350\n|-hitcount|p1a: Friend|1", "|-damage|p1a: Friend|0 fnt", "|-damage|p1a: Friend|280/350|[from] brn", "|-damage|p1a: Friend|300/350\n|-damage|p1a: Friend|280/350\n|-hitcount|p1a: Friend|2"]) {
    const engine = new DecisionEngine();
    const current = await engine.ingest({ roomId: `${roomId}-excluded`, sessionId: "excluded", observationId: "excluded", sequence: 1, source: "protocol",
      data: `>${roomId}-excluded\n|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|Donphan|100/100\n|request|${JSON.stringify(request)}\n|move|p2a: Elephant|Knock Off|p1a: Friend\n${middle}\n|turn|2` });
    assert.ok(!current.snapshot!.canonicalEvidence!.contributions.some((entry) => entry.metric === "damage"));
  }
});

test("suppression at move start or anywhere inside the hit excludes damage while later clean windows return", async () => {
  for (const target of ["p2a: Rabbit", "p1a: Friend"]) for (const effect of ["Embargo", "Gastro Acid", "Neutralizing Gas", "replaced gas"]) {
    const gas = effect.includes("Gas") || effect === "replaced gas";
    const start = gas ? `|-ability|${target}|Neutralizing Gas` : `|-start|${target}|${effect}`;
    const end = effect === "replaced gas" ? `|-ability|${target}|${target.startsWith("p2") ? "Huge Power" : "Regenerator"}`
      : gas ? `|-endability|${target}|Neutralizing Gas` : `|-end|${target}|${effect}`;
    for (const timing of ["before", "during", "ends-during", "transient-before-hit", "transient-after-hit"]) {
      const label = `${target}-${effect}-${timing}`, engine = new DecisionEngine();
      const damageRoom = `${roomId}-suppression-window`;
      const data = `>${damageRoom}\n|tier|[Gen 9] UU\n|poke|p2|Azumarill\n|start\n|switch|p1a: Friend|Slowking|350/350\n|switch|p2a: Rabbit|Azumarill|100/100\n|-ability|p2a: Rabbit|Huge Power\n|request|${JSON.stringify(request)}\n${["before", "ends-during"].includes(timing) ? `${start}\n` : ""}|move|p2a: Rabbit|Play Rough|p1a: Friend\n${timing === "during" ? `${start}\n` : timing === "ends-during" ? `${end}\n` : timing === "transient-before-hit" ? `${start}\n${end}\n` : ""}|-damage|p1a: Friend|280/350\n${timing === "transient-after-hit" ? `${start}\n${end}\n` : ""}|turn|2`;
      const current = await engine.ingest({ roomId: damageRoom, sessionId: "suppression", observationId: "suppressed", sequence: 1, source: "protocol", data });
      const evidence = current.snapshot!.canonicalEvidence!;
      assert.equal(evidence.contributions.filter((entry) => entry.metric === "damage").length, 0, label);
      const rawDamage = evidence.facts.find((fact) => fact.kind === "-damage")!;
      assert.deepEqual(rawDamage.args, ["p1a: Friend", "280/350"], label);
      assert.deepEqual(rawDamage.source, { observationId: "suppressed", sequence: 1, lineIndex: data.split("\n").indexOf("|-damage|p1a: Friend|280/350"), channel: "protocol" });
      const suppression = evidence.facts.find((fact) => `|${fact.kind}|${fact.args.join("|")}` === start)!;
      assert.ok(suppression.subject.appearanceId, label);
      assert.ok(suppression.supportingFactIds.includes(suppression.id), label);
      const clean = await engine.ingest({ roomId: damageRoom, sessionId: "suppression", observationId: "clean", sequence: 2, source: "protocol",
        data: `>${damageRoom}\n${end}\n|move|p2a: Rabbit|Play Rough|p1a: Friend\n|-damage|p1a: Friend|210/350\n|turn|3` });
      const later = clean.snapshot!.canonicalEvidence!;
      assert.ok(!later.limitations.includes("suppressed_mechanics_unavailable"), label);
      assert.deepEqual(later.facts.slice(0, evidence.facts.length), evidence.facts, label);
      const windows = later.contributions.filter((entry) => entry.metric === "damage");
      assert.equal(windows.length, 2, label);
      const move = later.facts.find((fact) => fact.kind === "move" && fact.source.observationId === "clean")!;
      assert.ok(windows.every((entry) => entry.id.startsWith(`${move.id}:damage:`) && entry.damage!.percent === 20 && entry.eligibility === "active"), label);
      assert.ok(windows.every((entry) => entry.factIds.includes(move.id) && entry.factIds.every((id) => later.facts.some((fact) => fact.id === id))), label);
    }
  }
});

test("suppressed Huge Power damage never enters persisted posterior after re-entry", async () => {
  const engine = new DecisionEngine(), damageRoom = `${roomId}-suppression-posterior`; let sequence = 0;
  const ingest = (data: string) => engine.ingest({ roomId: damageRoom, sessionId: "suppression-posterior", observationId: `suppression-${++sequence}`, sequence, source: "protocol", data: `>${damageRoom}\n${data}` });
  const own = structuredClone(request);
  Object.assign(own.side.pokemon[0]!, { details: "Eelektross", baseAbility: "Levitate", moves: ["gastroacid", "thunderbolt"], stats: { hp: 350, atk: 150, def: 200, spa: 250, spd: 300, spe: 100 } });
  own.active[0]!.moves = [{ move: "Thunderbolt", id: "thunderbolt", pp: 15 }];
  const suppressed = await ingest(`|tier|[Gen 9] UU\n|poke|p2|Azumarill\n|poke|p2|Donphan\n|start\n|switch|p1a: Friend|Eelektross|350/350\n|switch|p2a: Rabbit|Azumarill|100/100\n|-ability|p2a: Rabbit|Huge Power\n|request|${JSON.stringify(own)}\n|move|p1a: Friend|Gastro Acid|p2a: Rabbit\n|-start|p2a: Rabbit|Gastro Acid\n|move|p2a: Rabbit|Play Rough|p1a: Friend\n|-damage|p1a: Friend|280/350\n|turn|2`);
  assert.ok(suppressed.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"));
  assert.ok(!suppressed.snapshot!.canonicalEvidence!.contributions.some((entry) => entry.metric === "damage"));
  await commitCanonicalSnapshots([suppressed.snapshot!]);
  own.rqid = 2; own.side.pokemon[0]!.condition = "280/350";
  const reentered = await ingest(`|switch|p2a: Elephant|Donphan|100/100\n|switch|p2a: Rabbit|Azumarill|100/100\n|request|${JSON.stringify(own)}`);
  assert.ok(!reentered.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"));
  assert.notEqual(reentered.snapshot!.opponentSide.active!.appearanceId, suppressed.snapshot!.opponentSide.active!.appearanceId);
  assert.equal(reentered.snapshot!.opponentSide.active!.instanceId, suppressed.snapshot!.opponentSide.active!.instanceId);
  const context = await commitCanonicalSnapshots([reentered.snapshot!]);
  assert.ok(!context.store.canonicalBattles![damageRoom]!.contributions.some((entry) => entry.metric === "damage"));
  const intel = await buildLocalIntelSnapshot(reentered.snapshot!, context);
  assert.ok(!intel.opponents.find((entry) => entry.species === "Azumarill")!.posterior!.evidence.some((entry) => entry.kind === "damage"));
  const clean = await ingest("|move|p2a: Rabbit|Play Rough|p1a: Friend\n|-damage|p1a: Friend|210/350\n|turn|3");
  const windows = clean.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.metric === "damage");
  assert.equal(windows.length, 2);
  assert.ok(windows.every((entry) => entry.damage!.attacker.ability === "Huge Power" && entry.damage!.attacker.appearanceId === reentered.snapshot!.opponentSide.active!.appearanceId));
  const after = await commitCanonicalSnapshots([clean.snapshot!]);
  const afterIntel = await buildLocalIntelSnapshot(clean.snapshot!, after);
  assert.deepEqual(afterIntel.opponents.find((entry) => entry.species === "Azumarill")!.posterior!.evidence.filter((entry) => entry.kind === "damage"), [{ kind: "damage", label: "Clean damage observations: 1" }]);
});


test("multihit definitions and an already transformed defender are excluded before damage promotion", async () => {
  for (const transformed of [false, true]) {
    const engine = new DecisionEngine();
    const own = structuredClone(request);
    own.side.pokemon[0]!.stats = { hp: 350, atk: 150, def: 200, spa: 250, spd: 300, spe: 100 } as any;
    const current = await engine.ingest({ roomId: `${roomId}-excluded-definition`, sessionId: "excluded", observationId: "excluded", sequence: 1, source: "protocol",
      data: `>${roomId}-excluded-definition\n|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|Donphan|100/100\n|request|${JSON.stringify(own)}\n${transformed ? "|-transform|p1a: Friend|p2a: Elephant\n" : ""}|move|p2a: Elephant|${transformed ? "Knock Off" : "Triple Axel"}|p1a: Friend\n|-damage|p1a: Friend|280/350\n|turn|2` });
    assert.ok(!current.snapshot!.canonicalEvidence!.contributions.some((entry) => entry.metric === "damage"));
  }
});

test("damage which breaks Illusion reprojects onto the revealed defender without a second entry", async () => {
  const engine = new DecisionEngine(), damageRoom = `${roomId}-illusion-damage`;
  const own = structuredClone(request);
  own.side.pokemon[0]!.stats = { hp: 350, atk: 150, def: 200, spa: 250, spd: 300, spe: 100 } as any;
  const current = await engine.ingest({ roomId: damageRoom, sessionId: "illusion-damage", sequence: 1, observationId: "illusion-damage", source: "protocol",
    data: `>${damageRoom}\n|tier|[Gen 9] UU\n|poke|p2|Mamoswine\n|poke|p2|Zoroark-Hisui\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Mammoth|Mamoswine|100/100\n|request|${JSON.stringify(own)}\n|move|p1a: Friend|Scald|p2a: Mammoth\n|-damage|p2a: Mammoth|80/100\n|replace|p2a: Fox|Zoroark-Hisui|80/100\n|turn|2` });
  const windows = current.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.metric === "damage" && entry.instanceId.includes(":p2:"));
  assert.equal(windows.length, 1); assert.equal(windows[0]!.species, "Zoroark-Hisui");
  assert.equal(windows[0]!.damage!.defender.species, "Zoroark-Hisui");
  const replacement = current.snapshot!.canonicalEvidence!.facts.find((fact) => fact.kind === "replace")!;
  assert.ok(windows[0]!.factIds.includes(replacement.id));
  const context = await commitCanonicalSnapshots([current.snapshot!]);
  assert.ok(context.store.canonicalBattles![damageRoom]!.contributions.every((entry) => entry.species === "Zoroark-Hisui"));
});

test("typed move order uses historical known modifiers, retains ties, and never creates hard population bounds", async () => {
  for (const opponentFirst of [true, false]) {
    const engine = new DecisionEngine(), speedRoom = `${roomId}-order-${opponentFirst}`;
    const own = structuredClone(request); own.rqid = 1;
    own.side.pokemon[0]!.item = "Heavy-Duty Boots";
    own.side.pokemon[0]!.stats = { hp: 350, atk: 150, def: 200, spa: 250, spd: 300, spe: 136 } as any;
    const prefix = `|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|Donphan|100/100\n|-item|p2a: Elephant|Heavy-Duty Boots\n|-ability|p2a: Elephant|Sturdy\n|request|${JSON.stringify(own)}`;
    const theirMove = "|move|p2a: Elephant|Earthquake|p1a: Friend\n|-damage|p1a: Friend|280/350";
    const yourMove = "|move|p1a: Friend|Scald|p2a: Elephant\n|-damage|p2a: Elephant|80/100";
    const data = `${prefix}\n${opponentFirst ? [theirMove, yourMove].join("\n") : [yourMove, theirMove].join("\n")}\n|turn|2`;
    const current = await engine.ingest({ roomId: speedRoom, sessionId: "order", observationId: "order-1", sequence: 1, source: "protocol", data: `>${speedRoom}\n${data}` });
    const order = current.snapshot!.canonicalEvidence!.contributions.find((entry) => entry.metric === "speed" && entry.instanceId.includes(":p2:"))!;
    assert.ok(order); assert.equal(order.speed!.relation, opponentFirst ? "first" : "second");
    assert.equal(order.speed!.other.stats!.spe, 136);
    const context = await commitCanonicalSnapshots([current.snapshot!]);
    const intel = await buildLocalIntelSnapshot(current.snapshot!, context);
    const posterior = intel.opponents.find((entry) => entry.species === "Donphan")!.posterior!;
    assert.ok(posterior.evidenceKinds.includes("speed"));
    assert.ok(posterior.topHypotheses.some((hypothesis) => hypothesis.effectiveSpeed === 136), "ties remain compatible in either observed order");
    const altered = structuredClone(current.snapshot!); altered.recentLog = ["Elephant used Ice Shard.", "Friend could not move (paralysis)."];
    assert.deepEqual((await buildLocalIntelSnapshot(altered, context)).opponents, intel.opponents);
    own.rqid = 2; own.side.pokemon[0]!.stats.spe = 100;
    const later = await engine.ingest({ roomId: speedRoom, sessionId: "order", observationId: "order-2", sequence: 2, source: "protocol",
      data: `>${speedRoom}\n|-enditem|p2a: Elephant|Heavy-Duty Boots\n|request|${JSON.stringify(own)}` });
    const retained = later.snapshot!.canonicalEvidence!.contributions.find((entry) => entry.id === order.id)!;
    assert.equal(retained.speed!.other.stats!.spe, 136);
    assert.equal(retained.speed!.pokemon.item, "Heavy-Duty Boots");
  }
});

// Matters: order explained by priority, order items/abilities or suppression must never feed the set guesser. A hidden
// item alone is now a posterior hypothesis (Choice Scarf can explain the order; see speed.test.ts).
test("uncertain priority, order items, suppression and unclosed move order cannot constrain Speed", async () => {
  for (const scenario of ["quick-claw", "prankster", "unknown-prankster", "priority", "partial", "magic-room", "klutz", "embargo", "gastro", "gas", "cloudnine", "airlock"]) {
    const engine = new DecisionEngine(), speedRoom = `${roomId}-order-${scenario}`;
    const own = structuredClone(request); own.side.pokemon[0]!.item = "Heavy-Duty Boots";
    if (scenario === "klutz") own.side.pokemon[0]!.baseAbility = "Klutz";
    if (scenario === "cloudnine" || scenario === "airlock") own.side.pokemon[0]!.baseAbility = scenario === "cloudnine" ? "Cloud Nine" : "Air Lock";
    const item = scenario === "hidden" ? "" : `|-item|p2a: Elephant|${scenario === "quick-claw" ? "Quick Claw" : "Heavy-Duty Boots"}\n`;
    const species = scenario.includes("prankster") ? "Thundurus" : "Donphan";
    const ability = scenario === "unknown-prankster" ? "" : `|-ability|p2a: Elephant|${scenario === "prankster" ? "Prankster" : "Sturdy"}`;
    const data = `|tier|[Gen 9] UU\n|poke|p2|${species}\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|${species}|100/100\n${item}${ability}\n|request|${JSON.stringify(own)}\n${scenario === "magic-room" ? "|-fieldstart|move: Magic Room\n" : scenario === "embargo" ? "|-start|p1a: Friend|Embargo\n" : scenario === "gastro" ? "|-start|p1a: Friend|Gastro Acid\n" : scenario === "gas" ? "|-ability|p1a: Friend|Neutralizing Gas\n" : scenario === "quick-claw" ? "|-activate|p2a: Elephant|item: Quick Claw\n" : ""}|move|p2a: Elephant|${scenario === "priority" ? "Ice Shard" : scenario.includes("prankster") ? "Thunder Wave" : scenario === "change" ? "Rapid Spin" : "Earthquake"}|p1a: Friend\n${scenario === "change" ? "|-boost|p2a: Elephant|spe|1\n" : ""}|move|p1a: Friend|Scald|p2a: Elephant${scenario === "partial" ? "" : "\n|turn|2"}`;
    const current = await engine.ingest({ roomId: speedRoom, sessionId: "order", observationId: "order", sequence: 1, source: "protocol", data: `>${speedRoom}\n${data}` });
    const context = await commitCanonicalSnapshots([current.snapshot!]);
    const intel = await buildLocalIntelSnapshot(current.snapshot!, context);
    assert.ok(!intel.opponents.find((entry) => entry.species === species)!.posterior!.evidenceKinds.includes("speed"), scenario);
    if (scenario === "partial") assert.ok(!current.snapshot!.canonicalEvidence!.contributions.some((entry) => entry.metric === "speed"));
  }
});

// Matters: in singles the second mover cannot overtake a move that already happened, so a Knock Off removing an item
// (or a Rapid Spin boost) between the two moves must not erase the order, e.g. when Metagross's Knock Off hits before
// Fezandipiti's U-turn and the pivot switch follows.
test("state changes after the first move keep the order sample at the first move's state", async () => {
  for (const scenario of ["knock-off-pivot", "rapid-spin"]) {
    const engine = new DecisionEngine(), speedRoom = `${roomId}-order-after-${scenario}`;
    const own = structuredClone(request); own.side.pokemon[0]!.item = "Heavy-Duty Boots";
    own.side.pokemon[0]!.stats = { hp: 350, atk: 150, def: 200, spa: 250, spd: 300, spe: 136 } as any;
    own.side.pokemon.push({ ...structuredClone(own.side.pokemon[0]!), ident: "p1: Reserve", details: "Scizor", active: false, condition: "300/300", baseAbility: "Technician" });
    const prefix = `|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|Donphan|100/100\n|-item|p2a: Elephant|Heavy-Duty Boots\n|-ability|p2a: Elephant|Sturdy\n|request|${JSON.stringify(own)}\n|turn|1`;
    const turn = scenario === "knock-off-pivot"
      ? "|move|p2a: Elephant|Knock Off|p1a: Friend\n|-damage|p1a: Friend|280/350\n|-enditem|p1a: Friend|Heavy-Duty Boots|[from] move: Knock Off|[of] p2a: Elephant\n|move|p1a: Friend|U-turn|p2a: Elephant\n|-damage|p2a: Elephant|90/100\n|switch|p1a: Reserve|Scizor|300/300\n|upkeep\n|turn|2"
      : "|move|p2a: Elephant|Rapid Spin|p1a: Friend\n|-damage|p1a: Friend|330/350\n|-boost|p2a: Elephant|spe|1\n|move|p1a: Friend|Scald|p2a: Elephant\n|-damage|p2a: Elephant|80/100\n|upkeep\n|turn|2";
    const current = await engine.ingest({ roomId: speedRoom, sessionId: "order", observationId: "order", sequence: 1, source: "protocol", data: `>${speedRoom}\n${prefix}\n${turn}` });
    const order = current.snapshot!.canonicalEvidence!.contributions.find((entry) => entry.metric === "speed" && entry.instanceId.includes(":p2:"));
    assert.ok(order, scenario);
    assert.equal(order.speed!.relation, "first", scenario);
    assert.equal(order.speed!.other.stats!.spe, 136, scenario);
    assert.equal(order.speed!.other.item, "Heavy-Duty Boots", `${scenario}: order uses the state at the first move`);
    assert.equal(order.speed!.pokemon.boosts?.spe ?? 0, 0, `${scenario}: a later boost does not apply to the order`);
  }
});

test("same-species same-nickname reserves retain separate instance damage and switch targets", async () => {
  const engine = new DecisionEngine(), duplicateRoom = `${roomId}-duplicate-reserves`;
  const own = structuredClone(request);
  own.side.pokemon.push(...[200, 328].map((def) => ({ ident: "p1: Same", details: "Scizor", active: false, condition: "350/350", baseAbility: "Technician", item: "Heavy-Duty Boots", moves: ["bulletpunch"], stats: { hp: 350, atk: 315, def, spa: 130, spd: 200, spe: 166 } })));
  const current = await engine.ingest({ roomId: duplicateRoom, sessionId: "duplicate", observationId: "duplicate", sequence: 1, source: "protocol",
    data: `>${duplicateRoom}\n|tier|[Gen 9] UU\n|poke|p2|Infernape\n|start|\n|switch|p2a: Fire|Infernape|100/100\n|move|p2a: Fire|Flare Blitz|p1a: Friend\n|request|${JSON.stringify(own)}` });
  const snapshot = current.snapshot!;
  const reserves = snapshot.yourSide.team.filter((mon) => mon.species === "Scizor");
  assert.equal(reserves.length, 2); assert.notEqual(reserves[0]!.instanceId, reserves[1]!.instanceId);
  const context = await commitCanonicalSnapshots([snapshot]);
  const intel = await buildLocalIntelSnapshot(snapshot, context);
  const fire = intel.opponentThreatPreview!.find((entry) => entry.moveName === "Flare Blitz")!;
  const targets = reserves.map((mon) => fire.switchTargets.find((target) => target.instanceId === mon.instanceId)!);
  assert.ok(targets.every(Boolean));
  const max = (target: typeof targets[number]) => target.bands.find((band) => band.label === "Likely")?.maxPercent ?? target.bands[0]!.maxPercent!;
  assert.notEqual(max(targets[0]!), max(targets[1]!));
  for (const action of snapshot.legalActions.filter((action) => action.kind === "switch")) {
    assert.ok(reserves.some((mon) => mon.instanceId === action.targetInstanceId));
    assert.ok(action.label.includes(`slot ${action.targetSlot}`));
    assert.ok(intel.selfActionRecommendation!.rankedActions.some((candidate) => candidate.actionId === action.id));
  }
});

test("overlapping suppression effects withhold evidence until all effects end", async () => {
  const engine = new DecisionEngine(), suppressionRoom = `${roomId}-suppression-lifecycle`;
  const own = structuredClone(request); own.side.pokemon[0]!.item = "Heavy-Duty Boots";
  const pair = (hp: number) => `|move|p2a: Elephant|Earthquake|p1a: Friend\n|-damage|p1a: Friend|${hp}/350\n|move|p1a: Friend|Scald|p2a: Elephant`;
  const first = await engine.ingest({ roomId: suppressionRoom, sessionId: "suppression", observationId: "suppression-1", sequence: 1, source: "protocol",
    data: `>${suppressionRoom}\n|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p1a: Friend|Slowking|350/350\n|switch|p2a: Elephant|Donphan|100/100\n|-item|p2a: Elephant|Heavy-Duty Boots\n|-ability|p2a: Elephant|Sturdy\n|request|${JSON.stringify(own)}\n|turn|1\n|-start|p1a: Friend|Embargo\n|-start|p1a: Friend|Gastro Acid\n|-end|p1a: Friend|Embargo\n${pair(280)}\n|turn|2` });
  assert.ok(first.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"));
  assert.ok(!first.snapshot!.canonicalEvidence!.contributions.some((entry) => entry.metric === "speed"));
  assert.ok(!first.snapshot!.canonicalEvidence!.contributions.some((entry) => entry.metric === "damage"));
  const restored = await engine.ingest({ roomId: suppressionRoom, sessionId: "suppression", observationId: "suppression-2", sequence: 2, source: "protocol",
    data: `>${suppressionRoom}\n|-end|p1a: Friend|Gastro Acid\n${pair(210)}\n|turn|3` });
  assert.ok(!restored.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"));
  assert.equal(restored.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.metric === "speed").length, 2);
  assert.equal(restored.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.metric === "damage").length, 2);
});


test("native bare suppression withholds advice and history despite nominal ability requests until reentry", async () => {
  const { evaluateDecision } = await import("../state/decisionEnvelope.js");
  const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  // Sanitized minimal native-equivalent Gen9UU Gastro Acid frames. Native
  // requests retain nominal ability; switching clears suppression without -end.
  for (const ownSuppressed of [true, false]) {
    const engine = new DecisionEngine(), battle = `${roomId}-bare-${ownSuppressed}`; let sequence = 0;
    const ownSpecies = ownSuppressed ? "Scizor" : "Swalot", foeSpecies = ownSuppressed ? "Swalot" : "Flygon";
    const ability = ownSuppressed ? "technician" : "liquidooze", move = ownSuppressed ? "Bullet Punch" : "Earthquake";
    const own = { rqid: 1, side: { id: "p1", pokemon: [
      { ident: `p1: ${ownSpecies}`, details: ownSpecies, active: true, condition: "291/291", baseAbility: ability, ability,
        item: "heavydutyboots", moves: [ownSuppressed ? "bulletpunch" : "earthquake"], stats: { atk: 394, def: 236, spa: 131, spd: 196, spe: 220 } },
      { ident: "p1: Slowking", details: "Slowking", active: false, condition: "331/331", baseAbility: "regenerator", ability: "regenerator", item: "heavydutyboots", moves: ["scald"], stats: { atk: 186, def: 196, spa: 236, spd: 256, spe: 96 } }
    ] }, active: [{ moves: [{ move, id: ownSuppressed ? "bulletpunch" : "earthquake", pp: 16, disabled: false }] }] };
    const ingest = (data: string) => engine.ingest({ roomId: battle, sessionId: "bare", observationId: `bare-${++sequence}`, sequence, source: "protocol", data: `>${battle}\n${data}` });
    const envelope = async (current: Awaited<ReturnType<typeof ingest>>) => evaluateDecision(engine, "bare", current.identity!, await createEphemeralIntelEvaluationContext());
    const ordinary = await ingest(`|tier|[Gen 9] UU\n|poke|p2|${foeSpecies}\n|poke|p2|Slowking\n|start\n|switch|p1a: ${ownSpecies}|${ownSpecies}|291/291\n|switch|p2a: ${foeSpecies}|${foeSpecies}|100/100\n|turn|1${ownSuppressed ? "" : "\n|move|p1a: Swalot|Earthquake|p2a: Flygon\n|-immune|p2a: Flygon|[from] ability: Levitate\n|turn|2"}\n|request|${JSON.stringify(own)}`);
    assert.equal((await envelope(ordinary)).semantic.capabilities.actionable, true);
    const target = ownSuppressed ? "p1a: Scizor" : "p2a: Flygon";
    const beforeAppearance = (ownSuppressed ? ordinary.snapshot!.yourSide.active : ordinary.snapshot!.opponentSide.active)!.appearanceId;
    const raw = await ingest(`|move|${ownSuppressed ? "p2a: Swalot" : "p1a: Swalot"}|Gastro Acid|${target}\n|-endability|${target}\n|turn|${ownSuppressed ? 2 : 3}`);
    assert.ok(raw.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"));
    own.rqid++;
    const suppressed = await ingest(`|request|${JSON.stringify(own)}`);
    if (ownSuppressed) assert.equal(suppressed.snapshot!.yourSide.active!.ability, "technician");
    const result = await envelope(suppressed);
    assert.equal(result.semantic.capabilities.actionable, false);
    assert.deepEqual(result.semantic.localIntel, { note: "suppressed_mechanics_unavailable", opponents: [] });
    const hit = await ingest(`|move|p1a: ${ownSpecies}|${move}|p2a: ${foeSpecies}\n|-damage|p2a: ${foeSpecies}|${ownSuppressed ? 49 : 77}/100\n|move|p2a: ${foeSpecies}|${ownSuppressed ? "Amnesia" : "Dragon Dance"}|p2a: ${foeSpecies}\n|turn|4\n|request|${JSON.stringify({ ...own, rqid: ++own.rqid })}`);
    assert.ok(!hit.snapshot!.canonicalEvidence!.contributions.some((entry) => entry.metric === "damage" || entry.metric === "speed"));
    assert.equal((await envelope(hit)).semantic.capabilities.actionable, false);
    const nominal = await ingest(`|-ability|${target}|${ownSuppressed ? "Technician" : "Levitate"}\n|-end|${target}|Gastro Acid\n|request|${JSON.stringify({ ...own, rqid: ++own.rqid })}`);
    assert.ok(nominal.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"), "nominal ability and synthetic end cannot prove restoration");
    const side = ownSuppressed ? "p1" : "p2", details = ownSuppressed ? ownSpecies : foeSpecies;
    await ingest(`|switch|${side}a: Slowking|Slowking|100/100`);
    const returned = await ingest(`|switch|${side}a: ${details}|${details}|${ownSuppressed ? "291/291" : "77/100"}\n|turn|5\n|request|${JSON.stringify({ ...own, rqid: ++own.rqid })}`);
    assert.ok(!returned.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"));
    assert.notEqual((ownSuppressed ? returned.snapshot!.yourSide.active : returned.snapshot!.opponentSide.active)!.appearanceId, beforeAppearance);
    assert.equal((await envelope(returned)).semantic.capabilities.actionable, true);
    const clean = await ingest(`|move|p1a: ${ownSpecies}|${move}|p2a: ${foeSpecies}\n|-damage|p2a: ${foeSpecies}|30/100\n|turn|6`);
    const damage = clean.snapshot!.canonicalEvidence!.contributions.filter((entry) => entry.metric === "damage");
    assert.equal(damage.length, 2);
    assert.ok(damage.every((entry) => entry.factIds.includes(clean.snapshot!.canonicalEvidence!.facts.find((fact) => fact.kind === "move" && fact.source.observationId === `bare-${sequence}`)!.id)));
    assert.ok(nominal.snapshot!.canonicalEvidence!.facts.some((fact) => fact.kind === "-endability" && fact.args.length === 1));
    if (!ownSuppressed) assert.ok(nominal.snapshot!.canonicalEvidence!.facts.some((fact) => fact.kind === "-immune" && fact.args.includes("[from] ability: Levitate")), "revealed ability knowledge retained");
  }
});

test("bare suppression invalidates an ongoing hit and move order without erasing earlier clean evidence", async () => {
  for (const timing of ["before", "during", "after"]) {
    const engine = new DecisionEngine(), battle = `${roomId}-bare-window-${timing}`;
    const bare = "|-endability|p2a: Elephant", own = structuredClone(request); own.side.pokemon[0]!.item = "Heavy-Duty Boots";
    const current = await engine.ingest({ roomId: battle, sessionId: "bare-window", observationId: "bare-window", sequence: 1, source: "protocol",
      data: `>${battle}\n|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start\n|switch|p1a: Friend|Slowking|350/350\n|switch|p2a: Elephant|Donphan|100/100\n|-item|p2a: Elephant|Heavy-Duty Boots\n|-ability|p2a: Elephant|Sturdy\n|request|${JSON.stringify(own)}\n|turn|1\n${timing === "before" ? `${bare}\n` : ""}|move|p2a: Elephant|Earthquake|p1a: Friend\n${timing === "during" ? `${bare}\n` : ""}|-damage|p1a: Friend|280/350\n|move|p1a: Friend|Scald|p2a: Elephant\n|-damage|p2a: Elephant|80/100\n${timing === "after" ? `${bare}\n` : ""}|turn|2` });
    const contributions = current.snapshot!.canonicalEvidence!.contributions;
    assert.equal(contributions.filter((entry) => entry.metric === "speed").length, 0, timing);
    assert.equal(contributions.filter((entry) => entry.metric === "damage").length, timing === "after" ? 2 : 0, timing);
  }
  const engine = new DecisionEngine(), battle = `${roomId}-bare-illusion`;
  const first = await engine.ingest({ roomId: battle, sessionId: "illusion", observationId: "illusion-1", sequence: 1, source: "protocol",
    data: `>${battle}\n|tier|[Gen 9] UU\n|poke|p2|Mamoswine\n|poke|p2|Zoroark-Hisui\n|start\n|switch|p1a: Friend|Slowking|350/350\n|switch|p2a: Mammoth|Mamoswine|100/100\n|request|${JSON.stringify(request)}\n|-endability|p2a: Mammoth` });
  const replaced = await engine.ingest({ roomId: battle, sessionId: "illusion", observationId: "illusion-2", sequence: 2, source: "protocol",
    data: `>${battle}\n|replace|p2a: Fox|Zoroark-Hisui|100/100\n|-ability|p2a: Fox|Illusion` });
  assert.equal(replaced.snapshot!.opponentSide.active!.appearanceId, first.snapshot!.opponentSide.active!.appearanceId);
  assert.ok(replaced.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"));
  const fainted = await engine.ingest({ roomId: battle, sessionId: "illusion", observationId: "illusion-3", sequence: 3, source: "protocol", data: `>${battle}\n|faint|p2a: Fox` });
  assert.ok(!fainted.snapshot!.canonicalEvidence!.limitations.includes("suppressed_mechanics_unavailable"));
});

async function substituteFixture(label: string, ownSpecies = "Scizor", ability = "Technician", move = "Knock Off", moveId = "knockoff") {
  const { evaluateDecision } = await import("../state/decisionEnvelope.js");
  const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  const engine = new DecisionEngine(), battle = `${roomId}-sub-${label}`; let sequence = 0;
  const own = { rqid: 1, side: { id: "p1", pokemon: [
    { ident: "p1: Friend", details: ownSpecies, active: true, condition: "291/291", baseAbility: ability, ability,
      item: "heavydutyboots", moves: [moveId], stats: { atk: 394, def: 236, spa: 300, spd: 196, spe: 220 } },
    { ident: "p1: Reserve", details: "Slowking", active: false, condition: "394/394", baseAbility: "Regenerator", ability: "Regenerator",
      item: "heavydutyboots", moves: ["scald"], stats: { atk: 186, def: 196, spa: 236, spd: 256, spe: 96 } }
  ] }, active: [{ moves: [{ move, id: moveId, pp: 16, disabled: false }] }] };
  const ingest = (data: string) => engine.ingest({ roomId: battle, sessionId: "sub", observationId: `sub-${++sequence}`, sequence, source: "protocol", data: `>${battle}\n${data}` });
  const initial = await ingest(`|tier|[Gen 9] UU\n|poke|p2|Slowking\n|poke|p2|Donphan\n|start\n|switch|p1a: Friend|${ownSpecies}|291/291\n|switch|p2a: Same|Slowking|296/394\n|-item|p2a: Same|Heavy-Duty Boots\n|turn|1\n|move|p2a: Same|Scald|p1a: Friend\n|turn|2\n|-boost|p1a: Friend|atk|2\n|request|${JSON.stringify(own)}`);
  const evaluate = async (current: Awaited<ReturnType<typeof ingest>>) => evaluateDecision(engine, "sub", current.identity!, await createEphemeralIntelEvaluationContext());
  return { engine, own, ingest, initial, evaluate };
}

test("your active Substitute withholds advice but preserves exact legal choices and clears on explicit end", async () => {
  for (const targets of [["p1a: Friend"], ["p1a: Friend", "p2a: Same"]]) {
    const f = await substituteFixture(targets.join("-"));
    assert.equal((await f.evaluate(f.initial)).semantic.capabilities.actionable, true);
    const beforeLegal = structuredClone(f.initial.snapshot!.legalActions);
    const active = await f.ingest(targets.map((target) => `|-start|${target}|Substitute`).join("\n"));
    assert.ok(active.snapshot!.canonicalEvidence!.limitations.includes("substitute_mechanics_unavailable"));
    assert.deepEqual(active.snapshot!.legalActions, beforeLegal);
    assert.equal(active.identity!.rqid, f.initial.identity!.rqid);
    assert.equal(active.identity!.requestKind, f.initial.identity!.requestKind);
    assert.equal(active.identity!.legalActionSetHash, f.initial.identity!.legalActionSetHash);
    for (const target of targets) assert.ok(active.snapshot!.canonicalEvidence!.facts.some((fact) => fact.kind === "-start" && fact.args[0] === target && fact.args[1] === "Substitute" && fact.subject.appearanceId));
    const gated = await f.evaluate(active);
    assert.equal(gated.semantic.capabilities.status, "unsupported"); assert.equal(gated.semantic.capabilities.actionable, false);
    assert.deepEqual(gated.semantic.localIntel, { note: "substitute_mechanics_unavailable", opponents: [] }, "no damage, threat, KO, prediction or ranked intel survives");
    const refreshed = await f.ingest(`|request|${JSON.stringify({ ...f.own, rqid: ++f.own.rqid })}\n|sso-state|${JSON.stringify({ pokemon: [{ ...f.own.side.pokemon[0], side: "p1", volatiles: [] }] })}`);
    assert.ok(refreshed.snapshot!.canonicalEvidence!.limitations.includes("substitute_mechanics_unavailable"));
    assert.deepEqual(refreshed.snapshot!.legalActions, beforeLegal);
    let ended = refreshed;
    for (const [i, target] of targets.entries()) {
      ended = await f.ingest(`|-end|${target}|Substitute`);
      const remaining = targets.slice(i + 1), limitations = ended.snapshot!.canonicalEvidence!.limitations;
      assert.equal(limitations.includes("substitute_mechanics_unavailable"), remaining.includes("p1a: Friend"), "one side ending cannot clear the other");
      assert.equal(limitations.includes("opponent_substitute_active"), remaining.length > 0 && !remaining.includes("p1a: Friend"));
    }
    assert.equal((await f.evaluate(ended)).semantic.capabilities.actionable, true);
    assert.deepEqual(ended.snapshot!.legalActions, beforeLegal);
  }
});

// Matters: a Gyarados Substitute blanked the whole strip, hiding the speed verdict and Gyarados's
// threats to you. Only your damage into the Substitute is unmodeled; withhold that and keep everything else.
test("opponent Substitute withholds only your damage into it and keeps speed and their threats", async () => {
  const f = await substituteFixture("opponent-only");
  const before = await f.evaluate(f.initial);
  assert.ok(before.semantic.localIntel.playerDamagePreview!.length > 0);
  const active = await f.ingest("|-start|p2a: Same|Substitute");
  assert.ok(!active.snapshot!.canonicalEvidence!.limitations.includes("substitute_mechanics_unavailable"));
  assert.ok(active.snapshot!.canonicalEvidence!.limitations.includes("opponent_substitute_active"));
  const result = await f.evaluate(active);
  assert.equal(result.semantic.capabilities.actionable, true);
  assert.ok(result.semantic.capabilities.limitations.includes("opponent_substitute_active"));
  assert.deepEqual(result.semantic.localIntel.playerDamagePreview, [], "your damage into the Substitute is withheld");
  assert.ok(result.semantic.localIntel.speedPreview, "speed verdict is kept");
  assert.deepEqual(result.semantic.localIntel.speedPreview, before.semantic.localIntel.speedPreview);
  assert.deepEqual(result.semantic.localIntel.opponentThreatPreview, before.semantic.localIntel.opponentThreatPreview, "their threats to you are kept");
  assert.ok(!result.semantic.localIntel.selfActionRecommendation!.rankedActions.some((action) => action.reasons.some((reason) => /KO|damage/i.test(reason) && /your|deal/i.test(reason))));
  const ended = await f.ingest("|-end|p2a: Same|Substitute");
  assert.ok(!ended.snapshot!.canonicalEvidence!.limitations.includes("opponent_substitute_active"));
  // Known bypass abilities stay conservative: your damage is still withheld while their Substitute stands.
  for (const [species, ability, move, id] of [["Chandelure", "Infiltrator", "Shadow Ball", "shadowball"], ["Toxtricity", "Punk Rock", "Boomburst", "boomburst"]]) {
    const g = await substituteFixture(id!, species, ability, move, id);
    const bypass = await g.evaluate(await g.ingest("|-start|p2a: Same|Substitute"));
    assert.equal(bypass.semantic.capabilities.actionable, true);
    assert.deepEqual(bypass.semantic.localIntel.playerDamagePreview, []);
  }
});

test("Substitute belongs to an active appearance, not its nickname, side or battle", async () => {
  for (const side of ["p1", "p2"]) for (const transition of ["switch", "drag", "faint"]) {
    const f = await substituteFixture(`${side}-${transition}`), target = side === "p1" ? "p1a: Friend" : "p2a: Same";
    const limitation = side === "p1" ? "substitute_mechanics_unavailable" : "opponent_substitute_active";
    const active = await f.ingest(`|-start|${target}|Substitute`);
    const old = (side === "p1" ? active.snapshot!.yourSide.active : active.snapshot!.opponentSide.active)!.appearanceId;
    const departed = await f.ingest(transition === "faint" ? `|faint|${target}` : `|${transition}|${side}a: Same|${side === "p1" ? "Slowking" : "Donphan"}|100/100`);
    assert.ok(!departed.snapshot!.canonicalEvidence!.limitations.includes(limitation));
    const returned = await f.ingest(`|switch|${target}|${side === "p1" ? "Scizor" : "Slowking"}|100/100`);
    assert.notEqual((side === "p1" ? returned.snapshot!.yourSide.active : returned.snapshot!.opponentSide.active)!.appearanceId, old);
    assert.ok(!returned.snapshot!.canonicalEvidence!.limitations.includes(limitation));
    const later = await f.ingest(`|-start|${target}|Substitute`);
    assert.ok(later.snapshot!.canonicalEvidence!.limitations.includes(limitation));
  }
});

test("Substitute survives same-appearance Illusion replacement and ignores lookalike effect names", async () => {
  const engine = new DecisionEngine(), battle = `${roomId}-sub-illusion`; let sequence = 0;
  const ingest = (data: string) => engine.ingest({ roomId: battle, sessionId: "sub-illusion", observationId: `sub-illusion-${++sequence}`, sequence, source: "protocol", data: `>${battle}\n${data}` });
  const first = await ingest(`|tier|[Gen 9] UU\n|poke|p2|Mamoswine\n|poke|p2|Zoroark-Hisui\n|start\n|switch|p1a: Friend|Slowking|350/350\n|switch|p2a: Mammoth|Mamoswine|100/100\n|request|${JSON.stringify(request)}\n|-start|p2a: Mammoth|Substitute`);
  const replaced = await ingest("|replace|p2a: Fox|Zoroark-Hisui|100/100\n|-ability|p2a: Fox|Illusion\n|-end|p2a: Fox|SubstituteExtra");
  assert.equal(replaced.snapshot!.opponentSide.active!.appearanceId, first.snapshot!.opponentSide.active!.appearanceId);
  assert.ok(replaced.snapshot!.canonicalEvidence!.limitations.includes("opponent_substitute_active"));
  const ended = await ingest("|-end|p2a: Fox|Substitute");
  assert.ok(!ended.snapshot!.canonicalEvidence!.limitations.includes("opponent_substitute_active"));
  const ordinary = await ingest("|-start|p2a: Fox|NotSubstitute");
  assert.ok(!ordinary.snapshot!.canonicalEvidence!.limitations.includes("opponent_substitute_active"));
});

async function metaColdSnapshot(format = "[Gen 9] UU", suffix = "") {
  const engine = new DecisionEngine({ source: "owned_offline_simulator" });
  const ownRequest = structuredClone(request);
  ownRequest.side.pokemon[0]!.stats = { hp: 350, atk: 150, def: 200, spa: 250, spd: 250, spe: 100 } as typeof ownRequest.side.pokemon[number]["stats"];
  const current = await engine.ingest({ sessionId: "meta", roomId: `${roomId}-meta${suffix}`, sequence: 1, observationId: "p1-1", source: "protocol",
    data: `>${roomId}-meta${suffix}\n|init|battle\n|tier|${format}\n|poke|p1|Slowking\n|poke|p2|Arcanine-Hisui\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Hound|Arcanine-Hisui|100/100\n|turn|7\n|request|${JSON.stringify(ownRequest)}` });
  return { engine, current, snapshot: current.snapshot! };
}
async function syntheticMetaPrior() {
  const { createHash } = await import("node:crypto");
  const body = { version: 1, source: { url: "https://www.smogon.com/stats/2026-09/chaos/gen9uu-1760.json", period: "2026-09", formatId: "gen9uu", ratingCutoff: 1760, sha256: "0".repeat(64) },
    species: { arcaninehisui: [{ id: "flareblitz", name: "Flare Blitz", setInclusionShare: 0.9 }, { id: "extremespeed", name: "Extreme Speed", setInclusionShare: 0.8 }, { id: "headsmash", name: "Head Smash", setInclusionShare: 0.7 }] } };
  return { ...body, revision: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}` };
}

test("monthly move prior cold-start reaches both forecast consumers without invented observed counts", async () => {
  const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  const { snapshot } = await metaColdSnapshot();
  const prior = await syntheticMetaPrior();
  const context = await (createEphemeralIntelEvaluationContext as (...args: any[]) => ReturnType<typeof createEphemeralIntelEvaluationContext>)(prior);
  const intel = await buildLocalIntelSnapshot(snapshot, context), entry = intel.opponents.find((p) => p.species === "Arcanine-Hisui")!;
  assert.equal((entry as any).metaMovePrior?.status, "cold_start");
  assert.ok(intel.opponentThreatPreview!.some((p) => p.moveName === "Flare Blitz" && p.moveSource === "likely"));
  assert.ok(intel.opponentActionPrediction!.topActions.some((p) => p.moveName === "Flare Blitz"));
  assert.equal(entry.battlesSeen, 0); assert.equal(entry.curatedTeamCount, 0);
  assert.ok(entry.likelyMoves.every((m) => m.count === 0 && m.sampleCount === 0 && m.share === 0));
  assert.equal(JSON.stringify(context.store), JSON.stringify((await createEphemeralIntelEvaluationContext()).store));
});

async function rawMetaFixture(data: Record<string, unknown> = { "Arcanine-Hisui": { Abilities: { rockhead: 10 }, Moves: { flareblitz: 9, extremespeed: 8, headsmash: 7, "": 1 } } }) {
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from(JSON.stringify({ info: { metagame: "gen9uu", cutoff: 1760, "team type": null }, data }));
  const declared = { ...(await syntheticMetaPrior()).source, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { bytes, declared };
}

test("revealed Swords Dance retains boosted attack hypotheses and explicitly discloses partial threat coverage", async () => {
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  const raw = await rawMetaFixture({ Scizor: { Abilities: { technician: 10 }, Moves: { bulletpunch: 10, knockoff: 9, closecombat: 8, swordsdance: 7 } } });
  const context = await createEphemeralIntelEvaluationContext(parseMetaMovePrior(raw.bytes, raw.declared));
  const { snapshot } = await metaColdSnapshot();
  const mon = snapshot.opponentSide.active!;
  Object.assign(mon, { species: "Scizor", canonicalSpecies: "Scizor", knownMoves: ["Swords Dance"], boosts: { atk: 2 }, ability: "Technician" });
  snapshot.opponentSide.team = [structuredClone(mon)];
  const before = JSON.stringify(context);
  const boosted = await buildLocalIntelSnapshot(snapshot, context);
  assert.equal(boosted.opponents[0]!.metaMovePrior!.status, "unrevealed_slots");
  assert.deepEqual(boosted.opponentThreatPreview!.map((move) => move.moveName), ["Bullet Punch", "Knock Off", "Close Combat"]);
  assert.equal(boosted.opponentThreatCoverage!.unrevealedSlots, 3);
  assert.ok(boosted.opponentThreatCoverage!.uncomputedMoves.some((move) => move.name === "Swords Dance"));
  assert.match(boosted.opponentThreatCoverage!.note, /not exhaustive upper bounds/);
  const unboosted = structuredClone(snapshot); unboosted.opponentSide.active!.boosts = {}; unboosted.opponentSide.team[0]!.boosts = {};
  const normal = await buildLocalIntelSnapshot(unboosted, context);
  const max = (intel: typeof boosted) => intel.opponentThreatPreview![0]!.currentTarget.bands.find((band) => band.label === "likely")!.maxPercent!;
  assert.ok(max(boosted) > max(normal), "observed +2 Attack reaches actual damage calculation");
  const full = structuredClone(snapshot); full.opponentSide.active!.knownMoves = ["Swords Dance", "Bullet Punch", "Knock Off", "U-turn"]; full.opponentSide.team[0]!.knownMoves = full.opponentSide.active!.knownMoves;
  const complete = await buildLocalIntelSnapshot(full, context);
  assert.equal(complete.opponents[0]!.metaMovePrior!.status, "moves_known");
  assert.ok(!complete.opponentThreatPreview!.some((move) => move.moveName === "Close Combat"));
  assert.equal(complete.opponentThreatCoverage!.unrevealedSlots, 0);
  const noPrior = await buildLocalIntelSnapshot(snapshot, await createEphemeralIntelEvaluationContext());
  assert.deepEqual(noPrior.opponentThreatPreview, []);
  assert.equal(noPrior.opponentThreatCoverage!.unrevealedSlots, 3);
  assert.match(noPrior.opponentThreatCoverage!.note, /missing rows do not establish safety/);
  assert.equal(JSON.stringify(context), before, "candidate filling does not promote monthly data into observed history");
});

test("monthly move import validates bounded source metadata, marginals and normalized replay revision", async () => {
  const { parseMetaMovePrior, validateMetaMovePrior } = await import("../history/metaPriorStore.js");
  const f = await rawMetaFixture(), prior = parseMetaMovePrior(f.bytes, f.declared);
  assert.equal(prior.species.arcaninehisui![0]!.setInclusionShare, 0.9, "denominator is one species mass, not all move slots");
  assert.equal(prior.species.arcaninehisui!.length, 3, "explicit empty-slot key is omitted");
  assert.deepEqual(validateMetaMovePrior(JSON.parse(JSON.stringify(prior))), prior);
  assert.ok(Object.isFrozen(prior.species.arcaninehisui![0]));
  assert.throws(() => parseMetaMovePrior(Buffer.alloc(5_000_001), f.declared), /5 MB/);
  assert.throws(() => parseMetaMovePrior(f.bytes, { ...f.declared, sha256: "f".repeat(64) }), /SHA-256/);
  assert.throws(() => parseMetaMovePrior(f.bytes, { ...f.declared, period: "2026-08" }), /period/);
  assert.throws(() => parseMetaMovePrior(f.bytes, { ...f.declared, formatId: "gen9ou" }));
  assert.throws(() => parseMetaMovePrior(f.bytes, { ...f.declared, ratingCutoff: 1500 }));
  for (const data of [
    { "Arcanine-Hisui": { Abilities: { rockhead: 0 }, Moves: { flareblitz: 1 } } },
    { "Arcanine-Hisui": { Abilities: { rockhead: 10 }, Moves: { flareblitz: 11 } } },
    { "Arcanine-Hisui": { Abilities: { rockhead: 10 }, Moves: { nonexistent: 1 } } },
    { "Missing Species": { Abilities: { rockhead: 10 }, Moves: { flareblitz: 1 } } },
    { "Arcanine-Hisui": { Abilities: { rockhead: null }, Moves: { flareblitz: 1 } } },
    { "Arcanine-Hisui": { Abilities: { rockhead: 10 }, Moves: { flareblitz: -1 } } }
  ]) { const bad = await rawMetaFixture(data); assert.throws(() => parseMetaMovePrior(bad.bytes, bad.declared)); }
  const altered = structuredClone(prior); altered.species.arcaninehisui![0]!.setInclusionShare = 0.8;
  assert.throws(() => validateMetaMovePrior(altered), /revision/);
});

test("monthly prior is detached before await, survives pure projection and never changes history or curated pools", async () => {
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } = await import("../history/opponentIntelStore.js");
  const f = await rawMetaFixture(), input = structuredClone(parseMetaMovePrior(f.bytes, f.declared));
  const creating = createEphemeralIntelEvaluationContext(input); input.source.period = "2026-08"; input.species.arcaninehisui![0]!.setInclusionShare = 0;
  const context = await creating, empty = await createEphemeralIntelEvaluationContext();
  assert.equal(context.movePriors!.source.period, "2026-09"); assert.equal(context.movePriors!.species.arcaninehisui![0]!.setInclusionShare, 0.9);
  assert.notEqual(context.revision, empty.revision); assert.deepEqual(context.store, empty.store);
  assert.throws(() => { context.movePriors!.species.arcaninehisui![0]!.setInclusionShare = 0; }, TypeError);
  const { snapshot } = await metaColdSnapshot();
  const projected = await projectCanonicalSnapshots([snapshot], context), baseline = await projectCanonicalSnapshots([snapshot], empty);
  assert.deepEqual(projected.store, baseline.store); assert.deepEqual(projected.movePriors, context.movePriors);
  assert.equal((await projectCanonicalSnapshots([snapshot], projected)).revision, projected.revision);
  const before = JSON.stringify(projected), one = await buildLocalIntelSnapshot(snapshot, projected), two = await buildLocalIntelSnapshot(snapshot, projected);
  assert.deepEqual({ ...one, generatedAt: null }, { ...two, generatedAt: null }); assert.equal(JSON.stringify(projected), before);
});

test("monthly move hypotheses fill unrevealed slots alongside revealed and historical support; misses are explicit", async () => {
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } = await import("../history/opponentIntelStore.js");
  const f = await rawMetaFixture(), prior = parseMetaMovePrior(f.bytes, f.declared), context = await createEphemeralIntelEvaluationContext(prior);
  const cold = await metaColdSnapshot(), entry = async (snapshot: typeof cold.snapshot, ctx = context) => (await buildLocalIntelSnapshot(snapshot, ctx)).opponents.find((p) => p.species === "Arcanine-Hisui")!;
  const reveal = structuredClone(cold.snapshot); reveal.opponentSide.active!.knownMoves = ["Flare Blitz"]; reveal.opponentSide.team.find((p) => p.active)!.knownMoves = ["Flare Blitz"];
  assert.equal((await entry(reveal)).metaMovePrior!.status, "unrevealed_slots");
  assert.deepEqual((await entry(reveal)).metaMovePrior!.moves.map((move) => move.name), ["Extreme Speed", "Head Smash"]);
  const historical = await metaColdSnapshot("[Gen 9] UU", "-history");
  const moved = await historical.engine.ingest({ sessionId: "meta", roomId: historical.snapshot.roomId, sequence: 2, observationId: "p1-2", source: "protocol",
    data: `>${historical.snapshot.roomId}\n|move|p2a: Hound|Extreme Speed|p1a: Friend` });
  const observed = await projectCanonicalSnapshots([moved.snapshot!], context);
  assert.equal((await entry(cold.snapshot, observed)).metaMovePrior!.status, "cold_start");
  const curated = structuredClone(context);
  curated.store.externalCurated.species.arcaninehisui = { species: "Arcanine-Hisui", formats: { [cold.snapshot.format]: { teamCount: 1, leadSlotCount: 0, moves: { "Head Smash": 1 }, items: {}, abilities: {}, teraTypes: {} } } };
  assert.equal((await entry(cold.snapshot, curated)).metaMovePrior!.status, "cold_start");
  const miss = await metaColdSnapshot("[Gen 9] OU"); assert.equal((await entry(miss.snapshot)).metaMovePrior!.status, "format_mismatch");
  const other = await rawMetaFixture({ Scizor: { Abilities: { technician: 10 }, Moves: { bulletpunch: 9 } } });
  assert.equal((await entry(cold.snapshot, await createEphemeralIntelEvaluationContext(parseMetaMovePrior(other.bytes, other.declared)))).metaMovePrior!.status, "species_missing");
  const weak = await rawMetaFixture({ "Arcanine-Hisui": { Abilities: { rockhead: 10 }, Moves: { flareblitz: 1 } } });
  assert.equal((await entry(cold.snapshot, await createEphemeralIntelEvaluationContext(parseMetaMovePrior(weak.bytes, weak.declared)))).metaMovePrior!.status, "no_supported_candidate");
});

test("monthly actor JSON exposes the same candidate provenance without full dataset or private cache paths", async () => {
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  const { evaluateDecision } = await import("../state/decisionEnvelope.js");
  const { buildBattlePolicyPrompt } = await import("../battle-agent/opencode.js");
  const f = await rawMetaFixture(), prior = parseMetaMovePrior(f.bytes, f.declared), { engine, current } = await metaColdSnapshot();
  const envelope = await evaluateDecision(engine, "meta", current.identity!, await createEphemeralIntelEvaluationContext(prior));
  const prompt = buildBattlePolicyPrompt({ requestId: "fixture", envelope });
  const wire = JSON.parse(prompt.split("\n").find((line) => line.startsWith('{"capabilities"'))!);
  assert.deepEqual(wire.engineAnalysis.opponents[0].metaMovePrior, envelope.semantic.localIntel.opponents[0]!.metaMovePrior);
  assert.match(wire.engineAnalysis.opponents[0].metaMovePrior.note, /not next-action probability/);
  assert.doesNotMatch(prompt, /rawFile|"arcaninehisui":|sampleCount.*setInclusionShare/);
});

test("monthly CLI bounded local-input guards run before any policy construction", async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util"), exec = promisify(execFile);
  const cli = new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname, cache = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-meta-cli-"));
  const descriptor = path.join(cache, "descriptor.json"), raw = path.join(cache, "raw.json"), f = await rawMetaFixture();
  await fs.writeFile(raw, f.bytes, { mode: 0o600 });
  const run = async (pattern: RegExp, file = descriptor) => {
    await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "--p1", "invalid-policy", "--move-priors", file], { env: { ...process.env, TMPDIR: os.tmpdir(), TSX_DISABLE_CACHE: "1" }, maxBuffer: 65536 }), (error: any) => { assert.match(error.stderr, pattern); assert.doesNotMatch(error.stderr, /Unknown policy/); return true; });
  };
  await fs.writeFile(descriptor, "x".repeat(16_385)); await run(/size limit/);
  await fs.writeFile(descriptor, JSON.stringify({ version: 1, source: f.declared, rawFile: "raw.json" })); await fs.writeFile(raw, Buffer.alloc(5_000_001)); await run(/size limit/);
  await fs.writeFile(raw, f.bytes); await fs.writeFile(descriptor, JSON.stringify({ version: 1, source: { ...f.declared, sha256: "f".repeat(64) }, rawFile: "raw.json" })); await run(/SHA-256/);
  const alias = path.join(cache, "project-alias"); await fs.symlink(new URL("../../README.md", import.meta.url).pathname, alias);
  await run(/outside the project/, alias);
  await run(/absolute descriptor path/, path.relative(process.cwd(), descriptor));
  await run(/regular file/, cache);
  await fs.writeFile(descriptor, JSON.stringify({ version: 1, source: f.declared, rawFile: "raw.json" }));
  await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "--p1", "invalid-policy", "--move-priors", descriptor], { env: { ...process.env, TSX_DISABLE_CACHE: "1" } }), (error: any) => { assert.match(error.stderr, /Unknown policy/); return true; });
});


test("R37 canonical commit detaches monthly prior and binds its context without persisting prior evidence", async () => {
  const { hashCanonical } = await import("../../../extension/lib/decision-identity.js");
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const f = await rawMetaFixture(), input = structuredClone(parseMetaMovePrior(f.bytes, f.declared));
  const off = await commitCanonicalSnapshots([]), creating = commitCanonicalSnapshots([], input);
  input.source.period = "2026-08"; input.species.arcaninehisui![0]!.setInclusionShare = 0;
  const on = await creating;
  assert.equal(on.movePriors?.source.period, "2026-09");
  assert.equal(on.movePriors!.species.arcaninehisui![0]!.setInclusionShare, 0.9);
  assert.deepEqual(on.store, off.store);
  assert.equal(off.revision, await hashCanonical(off.store));
  assert.equal(on.revision, await hashCanonical({ store: on.store, metaPriorRevision: on.movePriors!.revision }));
  assert.notEqual(on.revision, off.revision);
  assert.throws(() => { on.movePriors!.species.arcaninehisui![0]!.setInclusionShare = 0; }, TypeError);
  const { snapshot } = await metaColdSnapshot("[Gen 9] UU", "-commit");
  const committed = await commitCanonicalSnapshots([snapshot], on.movePriors);
  const captured = await captureIntelEvaluationContext();
  assert.deepEqual(committed.store, captured.store);
  assert.equal(captured.movePriors, undefined, "legacy capture remains prior-free");
  assert.equal(captured.revision, await hashCanonical(captured.store));
  assert.equal(committed.revision, await hashCanonical({ store: captured.store, metaPriorRevision: on.movePriors!.revision }));
  assert.doesNotMatch(await fs.readFile(process.env.LOCAL_INTEL_STORE_PATH!, "utf8"), /metaMovePrior|movePriors|setInclusionShare|metaPriorRevision/);
  const intel = await buildLocalIntelSnapshot(snapshot, committed);
  assert.equal(intel.opponents.find((p) => p.species === "Arcanine-Hisui")!.metaMovePrior!.status, "cold_start");
});

// Matters: monthly priors must be loadable live from the project's device-local, sync-ignored tmp/ (Syncthing
// ignores proj/*/tmp), while every other project path stays refused so synced or committed trees never feed priors.
test("monthly prior descriptor loads from the project's sync-ignored tmp/ and nowhere else in the project", async () => {
  const { loadMetaMovePriorDescriptor } = await import("../history/metaPriorStore.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-prior-root-")), f = await rawMetaFixture();
  for (const dir of ["tmp/meta-priors", "docs"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(path.join(root, dir, "raw.json"), f.bytes);
    await fs.writeFile(path.join(root, dir, "descriptor.json"), JSON.stringify({ version: 1, source: f.declared, rawFile: "raw.json" }));
  }
  const loaded = await loadMetaMovePriorDescriptor(path.join(root, "tmp/meta-priors/descriptor.json"), root);
  assert.equal(loaded.species.arcaninehisui![0]!.name, "Flare Blitz");
  await assert.rejects(loadMetaMovePriorDescriptor(path.join(root, "docs/descriptor.json"), root), /outside the project/);
});

// Matters: a Choice Scarf Hydreigon can outspeed a 353-Speed Thundurus while the item-free range is only 208-324.
// Smogon's monthly items (Scarf 39%), abilities and Tera types must reach the likely sources, tagged as monthly
// ladder data, so the Scarf range is shown before it moves and owner history stays distinguishable.
test("monthly item, ability and Tera shares feed likely sources and the possible Choice Scarf Speed range", async () => {
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  const raw = await rawMetaFixture({ Hydreigon: { "Raw count": 5901, Abilities: { levitate: 100 }, Items: { choicescarf: 39, choicespecs: 24, leftovers: 21, "": 16 },
    "Tera Types": { steel: 40, poison: 35, dark: 25 }, Moves: { darkpulse: 95, dracometeor: 80, flamethrower: 50, uturn: 60 } } });
  const prior = parseMetaMovePrior(raw.bytes, raw.declared);
  assert.deepEqual(prior.sets?.hydreigon?.items[0], { id: "choicescarf", name: "Choice Scarf", share: 0.39 });
  const engine = new DecisionEngine(), battle = `${roomId}-meta-items`;
  const own = { rqid: 1, side: { id: "p1", pokemon: [{ ident: "p1: Cloud", details: "Thundurus", active: true, condition: "299/299", baseAbility: "prankster", ability: "prankster", item: "heavydutyboots", moves: ["voltswitch"], stats: { atk: 239, def: 176, spa: 349, spd: 197, spe: 353 } }] },
    active: [{ moves: [{ move: "Volt Switch", id: "voltswitch", pp: 32, disabled: false }] }] };
  const current = await engine.ingest({ roomId: battle, sessionId: "meta-items", sequence: 1, observationId: "meta-items", source: "protocol",
    data: `>${battle}\n|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Hydreigon\n|start|\n|switch|p1a: Cloud|Thundurus|299/299\n|switch|p2a: Dragon|Hydreigon|100/100\n|turn|17\n|request|${JSON.stringify(own)}` });
  const intel = await buildLocalIntelSnapshot(current.snapshot!, await createEphemeralIntelEvaluationContext(prior));
  const hydreigon = intel.opponents.find((entry) => entry.species === "Hydreigon")!;
  assert.equal(hydreigon.likelyItems[0]!.name, "Choice Scarf");
  assert.equal(hydreigon.likelyItems[0]!.source, "monthly_ladder");
  assert.equal(hydreigon.likelyItems[0]!.sampleCount, 5901);
  const steel = hydreigon.likelyTeraTypes.find((entry) => entry.name === "Steel")!;
  assert.ok(Math.abs(steel.share - 0.4) < 1e-9 && steel.source === "monthly_ladder", JSON.stringify(hydreigon.likelyTeraTypes));
  assert.deepEqual(hydreigon.likelyAbilities.map((entry) => [entry.name, entry.share, entry.source]), [["Levitate", 1, "monthly_ladder"]]);
  assert.equal(intel.speedPreview!.possibleRange?.max, 486);
  assert.equal(hydreigon.battlesSeen, 0, "monthly items never become observed counts");
  const without = await buildLocalIntelSnapshot(current.snapshot!, await createEphemeralIntelEvaluationContext());
  assert.equal(without.speedPreview!.possibleRange, undefined);
});

// Matters: re-reading, re-hashing and rewriting the ~3 MB history file inside every observation request made each
// captured frame cost ~75 ms before the advisor could start (2026-10-23). History is now written behind the request
// path, but a change must never be lost: a failed write is reported, kept and written by a later flush.
test("history commits are written behind the request path, never dropped, and flushed on demand", async () => {
  const { flushIntelStore, intelStorePersistence } = await import("../history/opponentIntelStore.js");
  await flushIntelStore();
  const file = process.env.LOCAL_INTEL_STORE_PATH!, room = "battle-gen9uu-write-behind";
  const engine = new DecisionEngine();
  const current = await engine.ingest({ roomId: room, sessionId: "write-behind", sequence: 1, observationId: "wb-1", source: "protocol",
    data: `>${room}\n|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p2a: Elephant|Donphan|100/100\n|turn|1\n|move|p2a: Elephant|Earthquake|p1a: Friend\n|request|${JSON.stringify(request)}` });
  // Block the atomic write: its temporary path is a directory.
  const blocker = `${file}.pending-${process.pid}`;
  await fs.mkdir(blocker);
  const context = await commitCanonicalSnapshots([current.snapshot!]);
  assert.ok(context.store.canonicalBattles![room], "the commit returns its context without waiting for the disk");
  assert.doesNotMatch(await fs.readFile(file, "utf8").catch(() => ""), new RegExp(room));
  await assert.rejects(flushIntelStore());
  assert.equal(intelStorePersistence().pending, true);
  assert.ok(intelStorePersistence().error, "the failed write is reported");
  assert.deepEqual((await captureIntelEvaluationContext()).store, context.store, "the change is still the live history");
  await fs.rm(blocker, { recursive: true });
  await flushIntelStore();
  assert.equal(intelStorePersistence().pending, false); assert.equal(intelStorePersistence().error, null);
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(persisted.canonicalBattles[room], context.store.canonicalBattles![room]);
  // An empty batch changes nothing: same store object, same revision, nothing to write.
  const again = await commitCanonicalSnapshots([]);
  assert.equal(again.store, context.store); assert.equal(again.revision, context.revision);
  assert.equal(intelStorePersistence().pending, false);
  // Another process's edit is picked up when nothing of ours is pending.
  persisted.canonicalBattles[`${room}-external`] = persisted.canonicalBattles[room];
  await fs.writeFile(file, JSON.stringify(persisted));
  assert.ok((await captureIntelEvaluationContext()).store.canonicalBattles![`${room}-external`]);
});

// Matters: the companion could stop writing history for hours and would have lost it on restart. A
// change committed while a write was running is written by that same run, and its timer then fired with nothing
// pending: that empty drain left a settled run installed as "running", so every later write and flush was a no-op.
test("a write timer that fires with nothing pending never blocks later history writes", async () => {
  const { flushIntelStore, intelStorePersistence } = await import("../history/opponentIntelStore.js");
  await flushIntelStore();
  const file = process.env.LOCAL_INTEL_STORE_PATH!, engine = new DecisionEngine();
  const snap = async (room: string) => (await engine.ingest({ roomId: room, sessionId: room, sequence: 1, observationId: `${room}-1`, source: "protocol",
    data: `>${room}\n|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p2a: Elephant|Donphan|100/100\n|turn|1\n|request|${JSON.stringify(request)}` })).snapshot!;
  const [a, b, c] = [await snap("battle-gen9uu-timer-a"), await snap("battle-gen9uu-timer-b"), await snap("battle-gen9uu-timer-c")];
  const settle = async () => { for (let i = 0; i < 200 && intelStorePersistence().writing; i++) await new Promise((r) => setImmediate(r)); };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await commitCanonicalSnapshots([a]);
    mock.timers.tick(1000); // the write of A starts
    await commitCanonicalSnapshots([b]); // committed during that write: same run writes it, and a timer is armed
    await settle();
    assert.equal(intelStorePersistence().pending, false, "precondition: B was written by A's run");
    mock.timers.tick(1000); // the armed timer fires with nothing pending
    await settle();
    await commitCanonicalSnapshots([c]);
    mock.timers.tick(1000);
    await settle();
  } finally { mock.timers.reset(); }
  await flushIntelStore();
  assert.equal(intelStorePersistence().pending, false);
  assert.ok(JSON.parse(await fs.readFile(file, "utf8")).canonicalBattles["battle-gen9uu-timer-c"], "a later change reaches the disk");
});

// Matters: the monthly prior was cloned and fully revalidated on every observation batch (~55 ms each, 2026-10-23).
// A prior that validation produced is immutable and is used as is; any other object is still validated.
test("a validated monthly prior is reused without revalidation; an unvalidated copy is still checked", async () => {
  const { parseMetaMovePrior, detachMetaMovePrior } = await import("../history/metaPriorStore.js");
  const f = await rawMetaFixture(), prior = parseMetaMovePrior(f.bytes, f.declared);
  assert.equal(detachMetaMovePrior(prior), prior);
  assert.equal((await commitCanonicalSnapshots([], prior)).movePriors, prior);
  const copy = structuredClone(prior);
  assert.notEqual(detachMetaMovePrior(copy), copy);
  copy.species.arcaninehisui![0]!.setInclusionShare = 0.5;
  assert.throws(() => detachMetaMovePrior(copy), /revision/);
});

// Matters: the live advisor and /v1/evaluate each built the same envelope for one decision (~40-70 ms each, on the
// path to the pick). One build is shared; each caller gets its own copy; other content gets its own build.
test("one decision envelope build is shared per session, identity, snapshot content and history revision", async () => {
  const { sharedDecisionEnvelope } = await import("../state/decisionEnvelope.js");
  const engine = new DecisionEngine(), room = "battle-gen9uu-shared-envelope";
  const current = await engine.ingest({ roomId: room, sessionId: "shared", sequence: 1, observationId: "se-1", source: "protocol",
    data: `>${room}\n|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Donphan\n|start|\n|switch|p1a: Friend|Slowking|100/100\n|switch|p2a: Elephant|Donphan|100/100\n|turn|1\n|request|${JSON.stringify(request)}` });
  const base = await captureIntelEvaluationContext();
  let reads = 0;
  const context = { ...base, get store() { reads += 1; return base.store; } };
  const [first, second] = await Promise.all([1, 2].map(() => sharedDecisionEnvelope("shared", current.snapshot!, current.identity!, context)));
  const afterShared = reads;
  assert.ok(afterShared > 0);
  assert.deepEqual(first, second); assert.notEqual(first, second, "each caller owns its copy");
  await sharedDecisionEnvelope("shared", current.snapshot!, current.identity!, context);
  assert.equal(reads, afterShared, "a repeat is served from the shared build");
  await sharedDecisionEnvelope("other-session", current.snapshot!, current.identity!, context);
  assert.ok(reads > afterShared, "another capture session builds its own");
});
