import test from "node:test";
import assert from "node:assert/strict";
import { DecisionEngine } from "../state/decisionEngine.js";
import { evaluateDecision } from "../state/decisionEnvelope.js";
import { createEphemeralIntelEvaluationContext } from "../history/opponentIntelStore.js";
import { appendCanonicalLines, createCanonicalLedger, materializeCanonicalLedger, contributionsFromLedger } from "../state/canonicalLedger.js";
const roomId = "battle-gen9uu-identity";
function fixture() {
  const ledger = createCanonicalLedger(roomId); let sequence = 0;
  const add = (lines: string) => appendCanonicalLines(ledger, lines.split("\n"), { observationId: `observation-${++sequence}`, sequence, source: "protocol" });
  return { ledger, add, room: () => materializeCanonicalLedger(ledger) };
}
const entry = (details: string, moves: string[], active: boolean) => ({ ident: "p1: Same", details, condition: "100/100", active, moves, baseAbility: "Pressure", item: "", stats: { spe: 200 } });
function request(pokemon: any[], rqid: number) { return `|request|${JSON.stringify({ rqid, active: [{ moves: [{ id: "tackle", move: "Tackle", pp: 20 }] }], side: { id: "p1", pokemon } })}`; }

test("synthetic Belly Drum protocol keeps the setboost fact, stage and ancestry", () => {
  const lines = [
    ">battle-gen9uu-belly-drum-fixture", "|init|battle", "|gametype|singles", "|tier|[Gen 9] UU",
    "|poke|p1|Azumarill", "|start", "|switch|p1a: Azumarill|Azumarill|100/100",
    "|move|p1a: Azumarill|Belly Drum|p1a: Azumarill",
    "|-setboost|p1a: Azumarill|atk|6|[from] move: Belly Drum", "|turn|2"
  ];
  const ledger = createCanonicalLedger(lines[0]!.slice(1));
  appendCanonicalLines(ledger, lines.slice(1), { observationId: "synthetic-protocol", sequence: 1, source: "protocol" });
  const room = materializeCanonicalLedger(ledger), mon = room.sides.p1.team[room.sides.p1.activeKey];
  assert.equal(mon.species, "Azumarill");
  assert.equal(mon.boosts.atk, 6);
  assert.equal(mon.fieldSources.boosts, "protocol");
  const fact = ledger.facts.find((fact) => fact.kind === "-setboost")!;
  assert.ok(fact);
  assert.deepEqual(fact.args, ["p1a: Azumarill", "atk", "6", "[from] move: Belly Drum"]);
  assert.equal(lines[fact.source.lineIndex], "|-setboost|p1a: Azumarill|atk|6|[from] move: Belly Drum");
  assert.equal(fact.source.observationId, "synthetic-protocol");
  assert.equal(fact.source.channel, "protocol");
  assert.equal(fact.subject.appearanceId, mon.appearanceId);
  assert.ok(mon.evidenceRefs.includes(fact.id));
});

test("setboost replaces one stage and clears on explicit reset, switch and drag", () => {
  const f = fixture();
  f.add("|poke|p2|Azumarill\n|poke|p2|Donphan\n|start\n|switch|p2a: Rabbit|Azumarill|100/100\n|-boost|p2a: Rabbit|spe|1\n|-boost|p2a: Rabbit|atk|2\n|-setboost|p2a: Rabbit|atk|6|[from] move: Belly Drum");
  const active = () => { const room = f.room(); return room.sides.p2.team[room.sides.p2.activeKey]; };
  const first = active(), facts = structuredClone(f.ledger.facts);
  assert.deepEqual(first.boosts, { spe: 1, atk: 6 });
  f.add("|-setboost|p2a: Rabbit|atk|0");
  assert.deepEqual(active().boosts, { spe: 1, atk: 0 });
  f.add("|-setboost|p2a: Rabbit|atk|-6");
  assert.deepEqual(active().boosts, { spe: 1, atk: -6 });
  for (const clear of ["|-clearboost|p2a: Rabbit", "|-clearallboost", "|switch|p2a: Elephant|Donphan|100/100\n|switch|p2a: Rabbit|Azumarill|100/100", "|drag|p2a: Elephant|Donphan|100/100\n|drag|p2a: Rabbit|Azumarill|100/100"]) {
    f.add("|-setboost|p2a: Rabbit|atk|6");
    assert.equal(active().boosts.atk, 6);
    f.add(clear);
    assert.deepEqual(active().boosts, {});
    assert.equal(active().fieldSources.boosts, "protocol");
    assert.equal(active().instanceId, first.instanceId);
  }
  assert.notEqual(active().appearanceId, first.appearanceId);
  assert.deepEqual(f.ledger.facts.slice(0, facts.length), facts);
});

test("private same-nickname entries stay distinct across server request-slot swaps", () => {
  const f = fixture();
  f.add(request([entry("Mamoswine", ["ice shard"], true), entry("Scizor", ["bullet punch"], false)], 1));
  let room = f.room();
  const before = Object.values(room.sides.p1.team) as any[];
  assert.equal(before.length, 2);
  assert.notEqual(before[0].instanceId, before[1].instanceId);
  const scizor = before.find((mon) => mon.species === "Scizor");
  assert.equal(room.legalActions.find((action: any) => action.id === "switch:2").targetInstanceId, scizor.instanceId);
  f.add("|switch|p1a: Same|Scizor|100/100");
  f.add(request([entry("Scizor", ["bullet punch"], true), entry("Mamoswine", ["ice shard"], false)], 2));
  room = f.room();
  assert.equal(room.sides.p1.team[room.sides.p1.activeKey].instanceId, scizor.instanceId);
  assert.equal(room.legalActions.find((action: any) => action.id === "switch:2").targetInstanceId, before.find((mon) => mon.species === "Mamoswine").instanceId);
});

test("Illusion replacement rebinds one appearance and all its facts, leaving preview disguise clean", () => {
  const f = fixture();
  f.add("|poke|p2|Mamoswine\n|poke|p2|Zoroark-Hisui\n|start|\n|-sidestart|p2: Enemy|Stealth Rock\n|switch|p2a: Mammoth|Mamoswine|100/100\n|move|p2a: Mammoth|Hyper Voice|p1a: Friend\n|-status|p2a: Mammoth|brn\n|-item|p2a: Mammoth|Choice Specs\n|-ability|p2a: Mammoth|Illusion");
  assert.equal(contributionsFromLedger(f.ledger).length, 0);
  const immutable = structuredClone(f.ledger.facts);
  f.add("|replace|p2a: Fox|Zoroark-Hisui|76/100 brn\n|turn|2");
  assert.deepEqual(f.ledger.facts.slice(0, immutable.length), immutable);
  assert.equal(Object.keys(f.ledger.appearances).length, 1);
  const room = f.room();
  const team = Object.values(room.sides.p2.team) as any[];
  const fox = team.find((mon) => mon.species === "Zoroark-Hisui");
  const mammoth = team.find((mon) => mon.species === "Mamoswine");
  assert.deepEqual(fox.knownMoves, ["Hyper Voice"]);
  assert.equal(fox.status, "brn"); assert.equal(fox.item, "Choice Specs"); assert.equal(fox.ability, "Illusion");
  assert.deepEqual(mammoth.knownMoves, []); assert.equal(mammoth.status, null); assert.equal(mammoth.item, null);
  assert.equal(room.entryObservations.length, 1);
  assert.equal(room.entryObservations[0].instanceId, fox.instanceId);
  assert.ok(contributionsFromLedger(f.ledger).every((contribution) => contribution.species === "Zoroark-Hisui" && contribution.factIds.length));
});

test("re-entry creates a fresh appearance while retaining instance knowledge and clearing active-stint state", () => {
  const f = fixture();
  f.add("|poke|p2|Hawlucha\n|poke|p2|Donphan\n|start|\n|switch|p2a: Bird|Hawlucha|100/100\n|-ability|p2a: Bird|Unburden\n|-enditem|p2a: Bird|White Herb\n|-boost|p2a: Bird|atk|2\n|move|p2a: Bird|Acrobatics|p1a: Friend");
  const first = f.room().sides.p2.team[f.room().sides.p2.activeKey];
  f.add("|switch|p2a: Elephant|Donphan|100/100\n|switch|p2a: Bird|Hawlucha|70/100");
  const room = f.room(), later = room.sides.p2.team[room.sides.p2.activeKey];
  assert.equal(first.instanceId, later.instanceId); assert.notEqual(first.appearanceId, later.appearanceId);
  assert.equal(later.unburdenActive, false); assert.deepEqual(later.boosts, {}); assert.deepEqual(later.knownMoves, ["Acrobatics"]);
});

test("indistinguishable preview tokens remain separate and ambiguous facts cannot promote history", () => {
  const f = fixture();
  f.add("|poke|p2|Pikachu\n|poke|p2|Pikachu\n|start|\n|switch|p2a: Same|Pikachu|100/100\n|move|p2a: Same|Thunderbolt|p1a: Friend");
  assert.equal(Object.keys(f.ledger.instances).length, 2);
  const appearance = Object.values(f.ledger.appearances)[0]!;
  assert.equal(appearance.resolution, "ambiguous"); assert.equal(appearance.candidateInstanceIds.length, 2);
  assert.deepEqual(contributionsFromLedger(f.ledger), []);
  const room = f.room();
  assert.equal(room.sides.p2.team[room.sides.p2.activeKey].identityStatus, "ambiguous");
});

test("incomplete public rosters cannot establish singleton identity or species history", () => {
  for (const prefix of ["|teamsize|p2|6\n|poke|p2|Mamoswine\n|teampreview\n|start", "|poke|p2|Mamoswine"]) {
    const f = fixture();
    f.add(`${prefix}\n|switch|p2a: Mammoth|Mamoswine|100/100\n|move|p2a: Mammoth|Hyper Voice|p1a: Friend`);
    const appearance = Object.values(f.ledger.appearances)[0]!;
    assert.equal(appearance.resolution, "provisional");
    assert.equal(appearance.instanceId, undefined);
    assert.deepEqual(contributionsFromLedger(f.ledger), []);
    const room = f.room();
    assert.ok(room.canonicalEvidence.ambiguities.length);
    const preview = (Object.values(room.sides.p2.team) as any[]).find((mon) => mon.identityStatus === "resolved");
    assert.deepEqual(preview.knownMoves, [], "appearance facts never contaminate the unresolved preview candidate");
    f.add("|replace|p2a: Fox|Zoroark-Hisui|90/100");
    assert.ok(contributionsFromLedger(f.ledger).some((entry) => entry.species === "Zoroark-Hisui" && entry.value === "Hyper Voice"));
  }
});

test("a repeated public roster reset explicitly degrades instead of binding stale preview tokens", () => {
  const f = fixture();
  f.add("|clearpoke\n|poke|p2|Mamoswine\n|teampreview\n|clearpoke\n|poke|p2|Donphan\n|teampreview\n|start\n|switch|p2a: Elephant|Donphan|100/100\n|move|p2a: Elephant|Earthquake|p1a: Friend");
  assert.equal(Object.values(f.ledger.appearances)[0]!.resolution, "provisional");
  assert.deepEqual(contributionsFromLedger(f.ledger), []);
  assert.ok(f.room().canonicalEvidence.limitations.includes("preview_reset_unavailable"));
});

test("semantic instance, appearance and fact IDs ignore capture UUID and frame boundaries", () => {
  const lines = ["|poke|p2|Hawlucha", "|start|", "|switch|p2a: Bird|Hawlucha|100/100", "|move|p2a: Bird|Acrobatics|p1a: Friend", "|turn|2"];
  const one = createCanonicalLedger(roomId), split = createCanonicalLedger(roomId);
  appendCanonicalLines(one, lines, { observationId: "capture-A", sequence: 1, source: "protocol" });
  for (const [index, line] of lines.entries()) appendCanonicalLines(split, [line], { observationId: `capture-B-${index}`, sequence: index + 1, source: "protocol" });
  assert.deepEqual(Object.keys(one.instances), Object.keys(split.instances));
  assert.deepEqual(Object.keys(one.appearances), Object.keys(split.appearances));
  assert.deepEqual(one.facts.map(({ source, ...fact }) => fact), split.facts.map(({ source, ...fact }) => fact));
  assert.deepEqual(contributionsFromLedger(one), contributionsFromLedger(split));
});

test("first private roster reconciles prior bench stints and supplies private-stat ancestry", () => {
  const f = fixture();
  f.add("|poke|p1|Mamoswine\n|poke|p1|Scizor\n|start|\n|switch|p1a: Same|Mamoswine|100/100\n|move|p1a: Same|Ice Shard|p2a: Foe\n|switch|p1a: Same|Scizor|100/100");
  f.add(request([entry("Scizor", ["bullet punch"], true), entry("Mamoswine", ["ice shard"], false)], 5));
  const room = f.room(), team = Object.values(room.sides.p1.team) as any[];
  assert.equal(team.length, 2);
  assert.equal(team.filter((mon) => mon.species === "Mamoswine").length, 1);
  const mammoth = team.find((mon) => mon.species === "Mamoswine");
  assert.ok(mammoth.knownMoves.includes("Ice Shard"));
  const privateFact = f.ledger.facts.find((fact) => fact.kind === "request")!;
  assert.ok(team.every((mon) => mon.evidenceRefs.includes(privateFact.id)));
});

test("persistent form changes keep the instance; temporary forms and Transform stay within the appearance", () => {
  const f = fixture();
  f.add("|poke|p2|Palafin\n|poke|p2|Ditto\n|start|\n|switch|p2a: Hero|Palafin|100/100\n|detailschange|p2a: Hero|Palafin-Hero\n|move|p2a: Hero|Jet Punch|p1a: Foe");
  const first = f.room().sides.p2.team[f.room().sides.p2.activeKey];
  f.add("|switch|p2a: Copy|Ditto|100/100\n|switch|p2a: Hero|Palafin-Hero|80/100");
  let room = f.room(), later = room.sides.p2.team[room.sides.p2.activeKey];
  assert.equal(later.instanceId, first.instanceId); assert.deepEqual(later.knownMoves, ["Jet Punch"]);
  f.add("|-formechange|p2a: Hero|Palafin\n|switch|p2a: Copy|Ditto|100/100\n|switch|p1a: Foe|Mamoswine|100/100\n|-transform|p2a: Copy|p1a: Foe\n|move|p2a: Copy|Ice Shard|p1a: Foe");
  room = f.room();
  const ditto = room.sides.p2.team[room.sides.p2.activeKey];
  assert.equal(ditto.species, "Mamoswine"); assert.equal(ditto.canonicalSpecies, "Ditto");
  assert.equal((Object.values(room.sides.p2.team) as any[]).find((mon) => mon.canonicalSpecies === "Palafin-Hero").species, "Palafin-Hero");
  assert.ok(!contributionsFromLedger(f.ledger).some((entry) => entry.species === "Ditto" && entry.value === "Ice Shard"));
  assert.ok(room.canonicalEvidence.limitations.includes("transform_mechanics_unavailable"));
  f.add("|switch|p2a: Hero|Palafin-Hero|80/100\n|switch|p2a: Copy|Ditto|70/100");
  room = f.room();
  const reentered = room.sides.p2.team[room.sides.p2.activeKey];
  assert.equal(reentered.species, "Ditto");
  assert.ok(!reentered.knownMoves.includes("Ice Shard"));
  assert.ok(!room.canonicalEvidence.limitations.includes("transform_mechanics_unavailable"));
});

test("hazard ancestry keeps the original appearance after the same instance re-enters", () => {
  const f = fixture();
  f.add("|poke|p2|Donphan\n|poke|p2|Scizor\n|start|\n|-sidestart|p2: Enemy|Stealth Rock\n|switch|p2a: Elephant|Donphan|100/100\n|turn|2\n|switch|p2a: Bug|Scizor|100/100\n|turn|3\n|switch|p2a: Elephant|Donphan|100/100\n|turn|4");
  const room = f.room();
  assert.notEqual(room.entryObservations[0].appearanceId, room.entryObservations[2].appearanceId);
  for (const entry of room.entryObservations) {
    const start = f.ledger.facts.find((fact) => `${fact.source.observationId}#${fact.source.lineIndex}` === entry.observationIds[0])!;
    assert.equal(entry.appearanceId, start.subject.appearanceId);
    assert.ok(entry.factIds.some((id: string) => f.ledger.facts.find((fact) => fact.id === id)?.kind === "-sidestart"));
  }
});


test("request-only active ownership does not create a nickname phantom on the next protocol move", () => {
  const f = fixture();
  f.add(request([entry("Scizor", ["bullet punch"], true), entry("Mamoswine", ["ice shard"], false)], 1));
  const id = f.room().sides.p1.team[f.room().sides.p1.activeKey].instanceId;
  f.add("|move|p1a: Same|Bullet Punch|p2a: Enemy");
  const room = f.room(), team = Object.values(room.sides.p1.team) as any[];
  assert.equal(team.length, 2); assert.equal(room.sides.p1.team[room.sides.p1.activeKey].instanceId, id);
  assert.ok(team.find((mon) => mon.instanceId === id).knownMoves.includes("Bullet Punch"));
});

// Minimal public identity sequence from Chrome req-16; trainer/battle IDs omitted.
test("wildcard preview identity keeps all four moves and Leftovers through re-entry", () => {
  const f = fixture();
  f.add("|teamsize|p1|6\n|clearpoke\n|poke|p1|Latios, M|\n|poke|p1|Great Tusk|\n|poke|p1|Heatran, M|\n|poke|p1|Pecharunt|\n|poke|p1|Samurott-Hisui, M|\n|poke|p1|Zamazenta-*|\n|teampreview\n|start\n|switch|p1a: Zamazenta|Zamazenta|100/100\n|move|p1a: Zamazenta|Substitute|p1a: Zamazenta\n|move|p1a: Zamazenta|Iron Defense|p1a: Zamazenta\n|move|p1a: Zamazenta|Body Press|p2a: Enemy\n|move|p1a: Zamazenta|Crunch|p2a: Enemy\n|-heal|p1a: Zamazenta|59/100|[from] item: Leftovers");
  const first = f.room().sides.p1.team[f.room().sides.p1.activeKey];
  f.add("|switch|p1a: Pecharunt|Pecharunt|100/100\n|switch|p1a: Zamazenta|Zamazenta|59/100");
  const room = f.room(), active = room.sides.p1.team[room.sides.p1.activeKey];
  assert.equal(Object.keys(room.sides.p1.team).length, 6);
  assert.equal(active.instanceId, first.instanceId);
  assert.notEqual(active.appearanceId, first.appearanceId);
  assert.equal(active.identityStatus, "resolved");
  assert.equal(active.canonicalSpecies, "Zamazenta");
  assert.equal(active.item, "Leftovers");
  assert.deepEqual(active.knownMoves, ["Substitute", "Iron Defense", "Body Press", "Crunch"]);
  assert.ok(f.ledger.facts.some((fact) => fact.kind === "poke" && fact.args[1] === "Zamazenta-*"), "raw preview stays unchanged");
  assert.ok(contributionsFromLedger(f.ledger).filter((entry) => entry.metric === "move").every((entry) => entry.instanceId === active.instanceId && entry.species === "Zamazenta"));
});

test("wildcard compatibility uses Dex families and never selects among multiple candidates or Illusion", () => {
  for (const concrete of ["Zamazenta", "Zamazenta-Crowned", "Urshifu-Rapid-Strike", "Gourgeist-Super"]) {
    const base = concrete.startsWith("Urshifu") ? "Urshifu" : concrete.startsWith("Gourgeist") ? "Gourgeist" : "Zamazenta";
    const f = fixture();
    f.add(`|poke|p2|${base}-*\n|start\n|switch|p2a: Same|${concrete}|100/100\n|move|p2a: Same|Tackle|p1a: Friend`);
    const room = f.room(), active = room.sides.p2.team[room.sides.p2.activeKey];
    assert.equal(Object.keys(room.sides.p2.team).length, 1);
    assert.equal(active.canonicalSpecies, concrete);
    assert.equal(active.identityStatus, "resolved");
  }
  for (const other of ["Zamazenta-*", "Zamazenta", "Zoroark-Hisui"]) {
    const f = fixture();
    f.add(`|poke|p2|Zamazenta-*\n|poke|p2|${other}\n|start\n|switch|p2a: Same|Zamazenta|100/100\n|move|p2a: Same|Crunch|p1a: Friend`);
    const appearance = Object.values(f.ledger.appearances)[0]!;
    assert.equal(appearance.resolution, "ambiguous");
    assert.equal(appearance.candidateInstanceIds.length, 2);
    assert.deepEqual(contributionsFromLedger(f.ledger), []);
    assert.equal(Object.values(f.ledger.instances)[0]!.species, "Zamazenta-*", "ambiguous facts cannot concretize a candidate");
  }
  const unrelated = fixture();
  unrelated.add("|poke|p2|Zamazenta-*\n|start\n|switch|p2a: Same|Zacian|100/100");
  assert.equal(Object.values(unrelated.ledger.appearances)[0]!.resolution, "provisional");
});

test("side-qualified presentation keeps Mandibuzz Defog separate from Pecharunt", () => {
  const f = fixture();
  f.add("|poke|p1|Pecharunt\n|poke|p2|Mandibuzz\n|start\n|switch|p1a: Pecharunt|Pecharunt|100/100\n|switch|p2a: Mandibuzz|Mandibuzz|100/100\n|move|p2a: Mandibuzz|Defog|p1a: Pecharunt\n|move|p1a: Pecharunt|Shadow Ball|p2a: Mandibuzz\n|move|p2a: Mandibuzz|U-turn|p1a: Pecharunt");
  const room = f.room();
  assert.ok(room.recentLog.includes("Mandibuzz used Defog."));
  assert.ok(room.recentLog.includes("Mandibuzz used U-turn."));
  assert.ok(room.recentLog.includes("Pecharunt used Shadow Ball."));
  assert.ok(!room.recentLog.includes("Pecharunt used Defog."));
  assert.ok(!room.recentLog.some((line: string) => line.includes("@team-preview")));
  assert.deepEqual(room.sides.p2.team[room.sides.p2.activeKey].knownMoves, ["Defog", "U-turn"]);
  assert.deepEqual(room.sides.p1.team[room.sides.p1.activeKey].knownMoves, ["Shadow Ball"]);
  assert.equal(f.ledger.facts.find((fact) => fact.kind === "move")!.args[0], "p2a: Mandibuzz");
});


test("Slow Start facts bind to appearances through expiry, Skill Swap and re-entry", () => {
  const f = fixture();
  f.add("|poke|p2|Regigigas\n|poke|p2|Slowking\n|start\n|switch|p2a: Giant|Regigigas|100/100\n|-start|p2a: Giant|ability: Slow Start");
  const active = () => { const room = f.room(); return room.sides.p2.team[room.sides.p2.activeKey]; };
  const first = active();
  assert.equal(first.slowStartActive, true);
  const activation = f.ledger.facts.find((fact) => fact.kind === "-start")!;
  assert.equal(activation.subject.appearanceId, first.appearanceId);
  assert.ok(first.evidenceRefs.includes(activation.id));
  f.add("|-end|p2a: Giant|Slow Start");
  assert.equal(active().slowStartActive, false);
  f.add("|switch|p2a: King|Slowking|100/100\n|switch|p2a: Giant|Regigigas|100/100");
  assert.equal(active().instanceId, first.instanceId);
  assert.notEqual(active().appearanceId, first.appearanceId);
  assert.equal(active().slowStartActive, undefined);
  f.add("|-start|p2a: Giant|ability: Slow Start");
  assert.equal(active().slowStartActive, true);
  // The [of] target must remain side-qualified when canonical keys replace names.
  f.add("|switch|p1a: King|Slowking|100/100\n|-activate|p1a: King|Skill Swap|Slow Start|Regenerator|[of] p2a: Giant\n|-end|p2a: Giant|Slow Start|[silent]\n|-start|p1a: King|ability: Slow Start");
  const room = f.room();
  assert.equal(active().ability, "Regenerator");
  assert.ok(active().evidenceRefs.includes(f.ledger.facts.find((fact) => fact.kind === "-activate")!.id), "the target retains the two-party ability-change fact");
  assert.equal(room.sides.p1.team[room.sides.p1.activeKey].ability, "Slow Start");
  assert.equal(room.sides.p1.team[room.sides.p1.activeKey].slowStartActive, true);
});


test("Skill Swap current capture explicitly withholds canonical forecasts without a base-ability entry model", async () => {
  for (const payload of ["|-activate|p1a: King|Skill Swap|Slow Start|Regenerator|[of] p2a: Giant", "|-activate|p1a: King|Skill Swap|[of] p2a: Giant"]) {
    const engine = new DecisionEngine();
    const own = { ...entry("Slowking", ["surf"], true), ident: "p1: King", baseAbility: "Regenerator", ability: "Slow Start" };
    const data = [`>${roomId}`, "|init|battle", "|tier|[Gen 9] UU", "|gametype|singles", "|poke|p2|Regigigas", "|start", "|switch|p1a: King|Slowking|100/100", "|switch|p2a: Giant|Regigigas|100/100", "|-start|p2a: Giant|ability: Slow Start", payload,
      "|-end|p2a: Giant|Slow Start|[silent]", "|-start|p1a: King|ability: Slow Start", request([own], 1)].join("\n");
    const result = await engine.ingest({ sessionId: "skill-swap", roomId, observationId: "swap", sequence: 1, source: "protocol", data });
    assert.ok(result.snapshot!.canonicalEvidence!.limitations.includes("temporary_ability_forecasts_unavailable"));
    const evaluated = await evaluateDecision(engine, "skill-swap", result.identity!, await createEphemeralIntelEvaluationContext());
    assert.equal(evaluated.semantic.capabilities.actionable, false);
    assert.ok(evaluated.semantic.capabilities.limitations.includes("temporary_ability_forecasts_unavailable"));
    assert.equal(evaluated.semantic.localIntel.selfActionRecommendation, undefined);
    const current = await engine.ingest({ sessionId: "skill-swap", roomId, observationId: "entry", sequence: 2, source: "protocol", data: `>${roomId}\n|switch|p2a: Giant|Regigigas|100/100\n|-start|p2a: Giant|ability: Slow Start` });
    assert.ok(current.snapshot!.canonicalEvidence!.limitations.includes("temporary_ability_forecasts_unavailable"), "re-entry cannot silently restore forecast support");
  }
});

const futureTeams = [`Slowking @ Heavy-Duty Boots
Ability: Regenerator
EVs: 4 HP / 252 SpA / 252 Spe
Timid Nature
- Future Sight
- Chilly Reception
- Scald
- Slack Off

Blissey @ Heavy-Duty Boots
Ability: Natural Cure
EVs: 252 HP / 252 Def / 4 SpD
Bold Nature
- Protect
- Soft-Boiled
- Seismic Toss
- Thunder Wave`, `Torkoal @ Heavy-Duty Boots
Ability: White Smoke
EVs: 252 HP / 252 Atk / 4 SpD
Brave Nature
IVs: 0 Spe
- Earth Power
- Protect
- Stealth Rock
- Body Press

Umbreon @ Heavy-Duty Boots
Ability: Synchronize
EVs: 252 HP / 252 SpD / 4 Def
Calm Nature
- Protect
- Wish
- Foul Play
- Snarl`];

async function nativeFutureBattle(protectedTarget = false, targetLevel?: number) {
  const { Battle, Teams, TeamValidator, extractChannelMessages } = await import("../battle-agent/nativeSimulator.js");
  const teams = [Teams.import(futureTeams[0]!)!, Teams.import(protectedTarget ? `Clodsire @ Heavy-Duty Boots
Ability: Water Absorb
EVs: 252 HP / 4 Def / 252 SpD
Careful Nature
- Earthquake
- Protect
- Recover
- Stealth Rock` : futureTeams[1]!)!];
  if (targetLevel !== undefined) teams[1]![0]!.level = targetLevel;
  assert.deepEqual(teams.map((team) => TeamValidator.get("gen9uu").validateTeam(team)), [null, null]);
  const battle = new Battle({ formatid: TeamValidator.get("gen9uu").format.id, seed: "9,4,2,7" });
  const engine = new DecisionEngine({ source: "owned_offline_simulator" });
  let offset = 0, sequence = 0;
  const capture = async () => {
    const lines = extractChannelMessages(battle.log.join("\n"), [1])[1]!;
    const privateRequest = { ...structuredClone(battle.sides[0].activeRequest), rqid: ++sequence };
    const data = [sequence === 1 ? "|init|battle" : "", ...lines.slice(offset), `|request|${JSON.stringify(privateRequest)}`].filter(Boolean).join("\n");
    offset = lines.length;
    return (await engine.ingest({ sessionId: "native-pending-attack", roomId, observationId: `native-future-${sequence}`, sequence, source: "protocol", data: `>${roomId}\n${data}` })).snapshot!;
  };
  battle.setPlayer("p1", { name: "Alice", team: Teams.pack(teams[0]!) });
  battle.setPlayer("p2", { name: "Bob", team: Teams.pack(teams[1]!) });
  battle.makeChoices("team 12", protectedTarget ? "team 1" : "team 12");
  return { battle, capture };
}

test("native Future Sight schedule follows the target slot through pivots, repeat failure and Dark immunity", async () => {
  for (const variant of ["stay", "pivot", "repeat", "dark"]) {
    const { battle, capture } = await nativeFutureBattle();
    try {
      assert.equal((await capture()).pendingAttacks, undefined);
      battle.makeChoices("move 3", "move 1");
      const before = await capture();
      const cleanScald = before.canonicalEvidence!.contributions.filter((contribution) => contribution.metric === "damage" && contribution.value === "Scald");
      assert.equal(cleanScald.length, 2, "ordinary immediate Scald retains both exact damage roles");
      const targetHp = battle.sides[1].active[0]!.hp;
      battle.makeChoices("move 1", "move 1");
      const scheduled = await capture(), pending = scheduled.pendingAttacks![0]!;
      assert.equal(battle.sides[1].active[0]!.hp, targetHp, "cast turn has no Future Sight damage");
      assert.deepEqual({ moveId: pending.moveId, moveName: pending.moveName, sourceSide: pending.sourceSide, targetSide: pending.targetSide,
        targetPosition: pending.targetPosition, castTurn: pending.castTurn, dueTurn: pending.dueTurn, phase: pending.phase, status: pending.status },
      { moveId: "futuresight", moveName: "Future Sight", sourceSide: "p1", targetSide: "p2", targetPosition: "a", castTurn: 2, dueTurn: 4, phase: "end_of_turn", status: "scheduled" });
      assert.equal(pending.sourceInstanceId, scheduled.yourSide.active!.instanceId);
      assert.equal(pending.sourceAppearanceId, scheduled.yourSide.active!.appearanceId);
      const support = scheduled.canonicalEvidence!.facts.filter((fact) => pending.factIds.includes(fact.id));
      assert.ok(support.some((fact) => fact.kind === "turn" && fact.args[0] === "2"));
      assert.ok(support.some((fact) => fact.kind === "move" && fact.args[1] === "Future Sight"));
      assert.ok(support.some((fact) => fact.kind === "-start" && fact.subject.appearanceId === pending.sourceAppearanceId && fact.args[1] === "move: Future Sight"));
      assert.ok(support.every((fact) => fact.source.channel !== "recovery"));
      assert.ok(support.filter((fact) => ["turn", "move", "-start"].includes(fact.kind)).every((fact) => fact.source.channel === "protocol"));
      if (variant === "pivot") {
        battle.makeChoices("move 2", "move 1");
        assert.deepEqual((await capture()).pendingAttacks, [pending]);
        battle.makeChoices("switch 2", "");
        const pivoted = await capture();
        assert.equal(pivoted.yourSide.active!.species, "Blissey");
        assert.deepEqual(pivoted.pendingAttacks, [pending]);
        battle.makeChoices("move 1", "move 1");
      } else {
        battle.makeChoices(variant === "repeat" ? "move 1" : "move 4", "move 1");
        assert.deepEqual((await capture()).pendingAttacks, [pending], "failed recast cannot change the original due turn");
        if (variant === "repeat") assert.ok(battle.log.includes("|-fail|p1a: Slowking"));
        battle.makeChoices("move 4", variant === "dark" ? "switch 2" : "move 1");
      }
      const impact = await capture();
      assert.equal(impact.pendingAttacks, undefined);
      assert.ok(battle.log.some((line) => line === `|-end|p2a: ${variant === "dark" ? "Umbreon" : "Torkoal"}|move: Future Sight`));
      if (variant === "dark") assert.ok(battle.log.some((line) => line === "|-immune|p2a: Umbreon"));
      assert.deepEqual(impact.canonicalEvidence!.contributions.filter((contribution) => contribution.metric === "damage" && contribution.value === "Scald").map((contribution) => contribution.damage), cleanScald.map((contribution) => contribution.damage));
      assert.equal(impact.canonicalEvidence!.contributions.filter((contribution) => contribution.metric === "damage" && contribution.value === "Future Sight").length, 0);
    } finally { battle.destroy(); }
  }
});

test("native protected Scald cannot absorb delayed Future Sight impact into damage history", async () => {
  const { battle, capture } = await nativeFutureBattle(true);
  try {
    await capture();
    const full = battle.sides[1].active[0]!.hp;
    battle.makeChoices("move 1", "move 1");
    await capture();
    battle.makeChoices("move 4", "move 3");
    await capture();
    const impactIndex = battle.log.length;
    battle.makeChoices("move 3", "move 2");
    const snapshot = await capture(), impact = battle.log.slice(impactIndex);
    assert.ok(impact.includes("|-activate|p2a: Clodsire|move: Protect"));
    assert.ok(impact.includes("|-end|p2a: Clodsire|move: Future Sight"));
    assert.ok(battle.sides[1].active[0]!.hp > 0 && battle.sides[1].active[0]!.hp < full);
    assert.equal(snapshot.pendingAttacks, undefined);
    assert.deepEqual(snapshot.canonicalEvidence!.contributions.filter((contribution) => contribution.metric === "damage" && ["Scald", "Future Sight"].includes(contribution.value)), []);
    const context = await (await import("../history/opponentIntelStore.js")).projectCanonicalSnapshots([snapshot], await createEphemeralIntelEvaluationContext());
    const observedKeys = Object.values(context.store.species).flatMap((species) => Object.values(species.formats))
      .flatMap((format) => [format.observedDamage, format.observedTakenDamage, format.observedDamageByContext, format.observedTakenDamageByContext])
      .flatMap((samples) => Object.keys(samples));
    assert.ok(!observedKeys.some((key) => /^(Scald|Future Sight)\|/.test(key)), "no false immediate or delayed roll reaches observed history");
    assert.ok(snapshot.canonicalEvidence!.facts.some((fact) => fact.kind === "-damage" && fact.turn === 3 && fact.subject.side === "p2"), "raw delayed impact remains inspectable");
  } finally { battle.destroy(); }
});

test("native Future Sight pending attacks expire when a fainted target emits no end event", async () => {
  const { battle, capture } = await nativeFutureBattle(false, 1);
  try {
    await capture();
    battle.makeChoices("move 1", "move 1");
    const cast = await capture(), pending = cast.pendingAttacks![0]!;
    assert.equal(pending.castTurn, 1);
    assert.equal(pending.dueTurn, 3);
    battle.makeChoices("move 4", "move 2");
    assert.deepEqual((await capture()).pendingAttacks, [pending], "due-turn actions have not resolved yet");
    battle.makeChoices("move 3", "move 1");
    const expired = await capture();
    assert.ok(battle.sides[1].active[0]!.fainted);
    assert.ok(battle.log.includes("|-hint|Future Sight did not hit because the target is fainted."));
    assert.ok(!battle.log.some((line) => line.startsWith("|-end|") && line.endsWith("move: Future Sight")));
    assert.equal(expired.turn, 3, "expiry must not wait for the next turn's forced replacement");
    assert.equal(expired.pendingAttacks, undefined);
    assert.ok(expired.canonicalEvidence!.facts.some((fact) => fact.kind === "-start" && fact.args[1] === "move: Future Sight"), "historical cast evidence survives expiry");
    battle.makeChoices("", "switch 2");
    await capture();
    battle.makeChoices("move 1", "move 1");
    const recast = await capture();
    assert.equal(recast.pendingAttacks![0]!.castTurn, 4);
    assert.equal(recast.pendingAttacks![0]!.dueTurn, 6);
  } finally { battle.destroy(); }
});

test("pending attacks require a proven cast pair and expire after their due phase without inventing a source", () => {
  const initial = "|tier|[Gen 9] UU\n|poke|p1|Slowking\n|poke|p1|Zoroark-Hisui\n|poke|p2|Torkoal\n|start\n|switch|p1a: King|Slowking|100/100\n|switch|p2a: Coal|Torkoal|100/100";
  for (const data of ["|-start|p1a: King|move: Future Sight", "|turn|1\n|move|p1a: King|Future Sight|p2a: Coal", "|move|p1a: King|Future Sight|p2a: Coal\n|-start|p1a: King|move: Future Sight", "|turn|1\n|move|p1a: King|Future Sight|p2a: Coal\n|-fail|p1a: King\n|-start|p1a: King|move: Future Sight", "|turn|1\n|move|p1a: King|Future Sight|p2a: Coal\n|-start|p2a: Coal|move: Future Sight", "|turn|1\n|move|p1a: King|Future Sight|p2: Coal\n|-start|p1a: King|move: Future Sight"]) {
    const f = fixture(); f.add(initial); f.add(data);
    assert.equal(f.room().pendingAttacks, undefined);
  }
  const f = fixture(); f.add(initial); f.add("|turn|1\n|move|p1a: King|Future Sight|p2a: Coal\n|-start|p1a: King|move: Future Sight");
  const pending = structuredClone(f.room().pendingAttacks[0]);
  assert.equal(pending.sourceInstanceId, undefined, "unresolved identity is not guessed from nickname");
  assert.ok(pending.sourceAppearanceId);
  f.add("|turn|3"); assert.deepEqual(f.room().pendingAttacks, [pending]);
  f.add("|upkeep"); assert.equal(f.room().pendingAttacks, undefined);
  const recovered = fixture(); recovered.add(initial);
  appendCanonicalLines(recovered.ledger, ["|turn|1", "|move|p1a: King|Future Sight|p2a: Coal", "|-start|p1a: King|move: Future Sight"], { observationId: "cold-import", sequence: 2, source: "recovery" });
  assert.equal(recovered.room().pendingAttacks, undefined);
  appendCanonicalLines(f.ledger, ["|turn|4"], { observationId: "gap", sequence: 5, source: "recovery" });
  assert.equal(f.room().pendingAttacks, undefined);
  const generic = fixture(); generic.add(initial); generic.add("|turn|2\n|move|p1a: King|Doom Desire|p2a: Coal\n|-start|p1a: King|move: Doom Desire");
  assert.equal(generic.room().pendingAttacks[0].moveId, "doomdesire", "catalogued futuremove shares the protocol boundary");
});

test("pending attacks expire across a missing due-phase tail and permit a fresh cast", () => {
  for (const source of ["protocol", "recovery"] as const) {
    const f = fixture();
    f.add("|tier|[Gen 9] UU\n|start\n|switch|p1a: King|Slowking|100/100\n|switch|p2a: Coal|Torkoal|100/100\n|turn|15\n|move|p1a: King|Future Sight|p2a: Coal\n|-start|p1a: King|move: Future Sight");
    const historical = structuredClone(f.ledger.facts), pending = structuredClone(f.room().pendingAttacks[0]);
    f.add("|turn|17\n|faint|p2a: Coal");
    assert.deepEqual(f.room().pendingAttacks, [pending], "fainting alone does not advance the due phase");
    appendCanonicalLines(f.ledger, ["|turn|21"], { observationId: `late-${source}`, sequence: 3, source });
    assert.equal(f.room().pendingAttacks, undefined, "a missing upkeep/end cannot retain overdue occupancy");
    assert.deepEqual(f.ledger.facts.slice(0, historical.length), historical, "expiry does not erase immutable history");
    f.add("|move|p1a: King|Future Sight|p2a: Coal\n|-start|p1a: King|move: Future Sight");
    assert.equal(f.room().pendingAttacks?.[0]?.castTurn, source === "protocol" ? 21 : undefined, "only a proven protocol turn can establish a fresh schedule");
  }
});


test("delayed schedule is invariant to capture frames and unpaired impact cannot become an immediate roll", () => {
  const lines = ["|tier|[Gen 9] UU", "|poke|p2|Torkoal", "|start", "|switch|p1a: King|Slowking|100/100", "|switch|p2a: Coal|Torkoal|100/100",
    request([{ ...entry("Slowking", ["future sight", "scald"], true), ident: "p1: King" }], 1), "|turn|1", "|move|p1a: King|Future Sight|p2a: Coal", "|-start|p1a: King|move: Future Sight"];
  const whole = fixture(), split = fixture(); whole.add(lines.join("\n")); for (const line of lines) split.add(line);
  assert.deepEqual(whole.room().pendingAttacks, split.room().pendingAttacks);
  const unpaired = fixture(); unpaired.add(lines.slice(0, 7).join("\n"));
  unpaired.add("|move|p1a: King|Scald|p2a: Coal\n|-end|p2a: Coal|move: Future Sight\n|-damage|p2a: Coal|55/100\n|upkeep");
  assert.deepEqual(unpaired.room().canonicalEvidence.contributions.filter((contribution: any) => contribution.metric === "damage"), []);
  assert.equal(unpaired.room().pendingAttacks, undefined, "an end-only observation does not invent a caster or due turn");
  const castOnly = fixture(); castOnly.add(lines.slice(0, 8).join("\n"));
  castOnly.add("|-damage|p2a: Coal|55/100\n|upkeep");
  assert.deepEqual(castOnly.room().canonicalEvidence.contributions.filter((contribution: any) => contribution.metric === "damage"), [], "futuremove never opens an immediate roll window");
});

test("late caster identity resolution cannot add an unsupported instance claim to a proven schedule", () => {
  const disguise = fixture();
  disguise.add("|poke|p2|Slowking\n|poke|p2|Zoroark-Hisui\n|poke|p1|Torkoal\n|start\n|switch|p1a: Coal|Torkoal|100/100\n|switch|p2a: King|Slowking|100/100\n|turn|1\n|move|p2a: King|Future Sight|p1a: Coal|[from] move: Copycat\n|-start|p2a: King|move: Future Sight");
  const pending = structuredClone(disguise.room().pendingAttacks[0]);
  assert.equal(pending.sourceInstanceId, undefined);
  disguise.add("|replace|p2a: Fox|Zoroark-Hisui|100/100");
  assert.deepEqual(disguise.room().pendingAttacks, [pending], "late Illusion proof belongs to the appearance, not the original schedule's instance ancestry");
  const coldParty = fixture();
  coldParty.add("|poke|p2|Torkoal\n|start\n|switch|p1a: King|Slowking|100/100\n|switch|p2a: Coal|Torkoal|100/100\n|turn|1\n|move|p1a: King|Future Sight|p2a: Coal\n|-start|p1a: King|move: Future Sight");
  const before = structuredClone(coldParty.room().pendingAttacks[0]);
  coldParty.add(request([{ ...entry("Slowking", ["future sight"], true), ident: "p1: King" }], 1));
  assert.deepEqual(coldParty.room().pendingAttacks, [before], "a first private roster after casting cannot retroactively add an uncited source instance");
});

// A possible Illusion (synthetic frames): the opponent's Team Preview holds an
// Illusion-capable species, so every other opposing switch-in is ambiguous until proven. The engine used to withhold every
// species-dependent section for the whole game (only Metamon's pick showed, under a misleading "Speed: not enough
// information yet"), and listed each disguised stint as an extra roster entry (8 for a team of 6).
const illusionRoom = "battle-gen9uu-illusion-presumption";
const ownMon = (name: string, details: string, active: boolean, moves: string[]) => ({ ident: `p1: ${name}`, details, condition: "300/300", active,
  stats: { atk: 150, def: 200, spa: 250, spd: 200, spe: 180 }, moves, baseAbility: "flashfire", item: "leftovers", pokeball: "pokeball", ability: "flashfire",
  commanding: false, reviving: false, teraType: "Fairy", terastallized: "" });
const ownParty = (lead: boolean) => [ownMon("Heatran", "Heatran, M", lead, ["magmastorm", "earthpower"]), ownMon("Swampert", "Swampert, F", false, ["earthquake", "flipturn"])];
const ownRequest = (rqid: number) => `|request|${JSON.stringify({ rqid, active: [{ moves: [{ move: "Magma Storm", id: "magmastorm", pp: 8, maxpp: 8, target: "normal", disabled: false },
  { move: "Earth Power", id: "earthpower", pp: 16, maxpp: 16, target: "normal", disabled: false }] }], side: { name: "A", id: "p1", pokemon: ownParty(true) } })}`;
async function illusionBattle() {
  const engine = new DecisionEngine({ source: "owned_offline_simulator" }), context = await createEphemeralIntelEvaluationContext();
  let sequence = 0, current: any;
  const add = async (data: string) => {
    current = await engine.ingest({ sessionId: "illusion", roomId: illusionRoom, source: "protocol", observationId: `i${++sequence}`, sequence, data: `>${illusionRoom}\n${data}` });
    return current;
  };
  await add(`|init|battle\n|gametype|singles\n|player|p1|A||\n|player|p2|B||\n|gen|9\n|tier|[Gen 9] UU\n|clearpoke\n|poke|p1|Heatran, M|\n|poke|p1|Swampert, F|\n|poke|p2|Volcanion|\n|poke|p2|Tinkaton, F|\n|poke|p2|Zoroark-Hisui, M|\n|poke|p2|Metagross|\n|teampreview`);
  await add(`|request|${JSON.stringify({ teamPreview: true, side: { name: "A", id: "p1", pokemon: ownParty(false) }, rqid: 1 })}`);
  let rqid = 1;
  const turn = async (lines: string) => { await add(lines); return add(ownRequest(++rqid)); };
  const evaluate = async () => (await evaluateDecision(engine, "illusion", current.identity, context)).semantic;
  return { add, turn, evaluate, current: () => current };
}
const roster = (snapshot: any) => snapshot.opponentSide.team.map((mon: any) => mon.species).sort();

test("a possible Illusion keeps one roster entry per Pokémon and shows the shown species' sections with the Illusion user's view", async () => {
  const b = await illusionBattle();
  await b.turn("|\n|teamsize|p1|2\n|teamsize|p2|4\n|start\n|switch|p1a: Heatran|Heatran, M|300/300\n|switch|p2a: Volcanion|Volcanion|100/100\n|turn|1");
  let snapshot = b.current().snapshot;
  assert.deepEqual(roster(snapshot), ["Metagross", "Tinkaton", "Volcanion", "Zoroark-Hisui"]);
  const shown = snapshot.opponentSide.active;
  assert.equal(shown.identityStatus, "ambiguous");
  assert.equal(shown.presumedInstanceId, snapshot.opponentSide.team.find((mon: any) => mon.species === "Volcanion").presumedInstanceId);
  let semantic = await b.evaluate();
  assert.ok(semantic.capabilities.limitations.includes("identity_ambiguous"), "the identity stays uncertain: no ranking or guards");
  assert.deepEqual(semantic.localIntel.illusion, { shown: "Volcanion", possible: ["Zoroark-Hisui"] });
  // (No ladder priors in this fixture, so no likely moves: the threat section is computed but empty.)
  assert.ok(semantic.localIntel.speedPreview && semantic.localIntel.playerDamagePreview?.length && Array.isArray(semantic.localIntel.opponentThreatPreview),
    "speed, damage and threats are shown for the shown species instead of being withheld");
  assert.equal(semantic.localIntel.illusionAlternative?.species, "Zoroark-Hisui");
  assert.ok(semantic.localIntel.illusionAlternative.speedPreview && semantic.localIntel.illusionAlternative.playerDamagePreview.length);

  // Its move under the disguise, then a switch: the disguised stint is no second Volcanion (it was 6 + 2 = 8 entries).
  await b.turn("|\n|move|p2a: Volcanion|Flamethrower|p1a: Heatran\n|-immune|p1a: Heatran|[from] ability: Flash Fire\n|\n|upkeep\n|turn|2");
  await b.turn("|\n|switch|p2a: Tinkaton|Tinkaton, F|100/100\n|\n|upkeep\n|turn|3");
  snapshot = b.current().snapshot;
  assert.deepEqual(roster(snapshot), ["Metagross", "Tinkaton", "Volcanion", "Zoroark-Hisui"]);
  semantic = await b.evaluate();
  assert.equal(semantic.localIntel.illusion?.shown, "Tinkaton");
  // History never takes evidence from an unresolved stint.
  assert.ok(!semantic.snapshot.canonicalEvidence!.contributions.some((c: any) => c.metric === "move" && c.value === "Flamethrower"));

  // A damaging hit that leaves the disguise standing proves the shown species: the caveat goes, history may count it.
  await b.turn("|\n|move|p1a: Heatran|Earth Power|p2a: Tinkaton\n|-supereffective|p2a: Tinkaton\n|-damage|p2a: Tinkaton|40/100\n|\n|upkeep\n|turn|4");
  snapshot = b.current().snapshot;
  assert.equal(snapshot.opponentSide.active.identityStatus, "resolved");
  assert.deepEqual(snapshot.canonicalEvidence.ambiguities, []);
  semantic = await b.evaluate();
  assert.equal(semantic.localIntel.illusion, undefined);
  assert.equal(semantic.capabilities.status, "degraded");
});

test("an Illusion user that fainted, or cannot learn a move the shown Pokémon used, no longer casts doubt", async () => {
  const b = await illusionBattle();
  await b.turn("|\n|teamsize|p1|2\n|teamsize|p2|4\n|start\n|switch|p1a: Heatran|Heatran, M|300/300\n|switch|p2a: Volcanion|Volcanion|100/100\n|turn|1");
  // Steam Eruption is not in the Illusion user's learnset: the shown Volcanion is proven (learnsets, never a species list).
  await b.turn("|\n|move|p2a: Volcanion|Steam Eruption|p1a: Heatran\n|-supereffective|p1a: Heatran\n|-damage|p1a: Heatran|120/300\n|\n|upkeep\n|turn|2");
  let semantic = await b.evaluate();
  assert.equal(semantic.localIntel.illusion, undefined);
  assert.ok(semantic.localIntel.playerDamagePreview?.length);
  // The disguise breaks (|replace|) as the Illusion user faints; afterwards no switch-in can be it.
  await b.turn("|\n|switch|p2a: Metagross|Metagross|100/100\n|\n|upkeep\n|turn|3");
  assert.equal((await b.evaluate()).localIntel.illusion?.shown, "Metagross");
  await b.add("|\n|move|p1a: Heatran|Magma Storm|p2a: Metagross\n|replace|p2a: Fox|Zoroark-Hisui, M\n|-end|p2a: Fox|Illusion\n|-damage|p2a: Fox|0 fnt\n|faint|p2a: Fox\n|\n|upkeep");
  await b.add(`|request|${JSON.stringify({ rqid: 9, wait: true, side: { name: "A", id: "p1", pokemon: ownParty(true) } })}`);
  await b.turn("|\n|switch|p2a: Tinkaton|Tinkaton, F|100/100\n|turn|4");
  const snapshot = b.current().snapshot;
  assert.equal(snapshot.opponentSide.active.identityStatus, "resolved");
  assert.deepEqual(roster(snapshot), ["Metagross", "Tinkaton", "Volcanion", "Zoroark-Hisui"]);
  assert.equal(snapshot.opponentSide.team.find((mon: any) => mon.species === "Zoroark-Hisui").fainted, true);
  assert.equal(snapshot.opponentSide.team.find((mon: any) => mon.species === "Metagross").fainted, false, "the stint it disguised is not Metagross's");
  semantic = await b.evaluate();
  assert.equal(semantic.localIntel.illusion, undefined);
});
