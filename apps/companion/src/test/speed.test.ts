import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { Field, Generations, Pokemon, Side } from "@smogon/calc";
import { getFinalSpeed } from "@smogon/calc/dist/mechanics/util.js";
import { effectiveSpeedField, effectiveSpeed, effectiveSpeedRange, speedAbilityMultiplierRange, unburdenSpeedMultiplier } from "../mechanics/speed.js";
const { applyRawFrameToRoomMap } = await import(new URL("../../../extension/lib/showdown-parser.js", import.meta.url).href);
import { buildOpponentPosterior } from "../inference/posterior.js";
import type { BattleSnapshot } from "../types.js";
import { DecisionEngine } from "../state/decisionEngine.js";
import { buildLocalIntelSnapshot, createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } from "../history/opponentIntelStore.js";
import { computeTacticalGuards } from "../battle-agent/tacticalGuards.js";

test("captured Speed rounds stages before chained modifiers and suppresses held items", async () => {
  const snapshot: BattleSnapshot = JSON.parse(await fs.readFile(new URL("../../../../examples/battle-snapshot.gen9ou.turn14.json", import.meta.url), "utf8"));
  const mon = { ...snapshot.yourSide.active!, species: "Donphan", ability: "Sturdy", item: "Choice Scarf", boosts: { spe: 2 }, status: null };
  const field = { ...snapshot.field, weather: null, terrain: null, pseudoWeather: [] };
  assert.equal(effectiveSpeed(9, 199, mon, [], field), 597);
  const rainy = { ...field, weather: "RainDance" };
  const swimmer = { ...mon, item: "Heavy-Duty Boots", ability: "Swift Swim", boosts: {} };
  assert.equal(effectiveSpeed(9, 145, swimmer, [], rainy), 290);
  assert.equal(effectiveSpeed(9, 145, swimmer, [], effectiveSpeedField(rainy, [swimmer, { ...mon, ability: "Cloud Nine" }])), 145);
  assert.equal(rainy.weather, "RainDance", "effective weather does not rewrite protocol truth");
  assert.equal(effectiveSpeed(9, 199, { ...mon, boosts: { spe: -1 } }, [], field), 198);
  assert.equal(effectiveSpeed(9, 199, { ...mon, boosts: { spe: -1 } }, ["Tailwind"], field), 396);
  assert.equal(effectiveSpeed(9, 199, { ...mon, ability: "Klutz" }, [], field), 398);
  assert.equal(effectiveSpeed(9, 199, mon, [], { ...field, pseudoWeather: ["Magic Room"] }), 398);
  assert.equal(effectiveSpeed(9, 199, { ...mon, item: "choicescarf", ability: "sturdy" }, [], field), 597);
  const opponent = { ...snapshot.opponentSide.active!, ...mon, level: 100, stats: undefined };
  const formatStats = { observedBattlesSeen: 0, observedMoves: {}, observedItems: {}, observedAbilities: {}, observedTeraTypes: {}, curatedMoves: {}, curatedItems: {}, curatedAbilities: {}, curatedTeraTypes: {} };
  for (const [stage, expected] of [[2, 597], [-1, 198]] as const) {
    const current = { ...opponent, boosts: { spe: stage } };
    const result = buildOpponentPosterior({ format: "[Gen 9] UU", opponent: current, formatStats, battleSnapshot: { ...snapshot, field } })!;
    assert.equal(result.topHypotheses.find((entry) => entry.statArchetype === "scarf_phys")!.effectiveSpeed, expected);
  }
});

test("Unburden activation ends on switch/re-entry, item gain, and ability loss", () => {
  const rooms = new Map();
  const apply = (line: string) => applyRawFrameToRoomMap(rooms, `>battle-gen9uu-unburden\n${line}`);
  const mon = () => rooms.get("battle-gen9uu-unburden").sides.p2.team["p2: Hawlucha"];
  const multiplier = () => unburdenSpeedMultiplier(mon().ability, mon().unburdenActive, mon().item);
  apply("|switch|p2a: Hawlucha|Hawlucha, L100|100/100\n|-ability|p2a: Hawlucha|Unburden\n|-item|p2a: Hawlucha|Electric Seed");
  assert.equal(multiplier(), 1);
  apply("|-enditem|p2a: Hawlucha|Electric Seed");
  assert.equal(multiplier(), 2);
  apply("|switch|p2a: Slowking|Slowking, L100|100/100\n|switch|p2a: Hawlucha|Hawlucha, L100|100/100");
  assert.equal(mon().removedItem, "Electric Seed");
  assert.equal(mon().unburdenActive, false);
  assert.equal(multiplier(), 1);
  apply("|-item|p2a: Hawlucha|Sitrus Berry\n|-enditem|p2a: Hawlucha|Sitrus Berry");
  assert.equal(multiplier(), 2);
  apply("|-item|p2a: Hawlucha|Leftovers");
  assert.equal(multiplier(), 1);
  apply("|-enditem|p2a: Hawlucha|Leftovers\n|-endability|p2a: Hawlucha|Unburden");
  assert.equal(mon().unburdenActive, false);
  assert.equal(multiplier(), 1);
  assert.equal(unburdenSpeedMultiplier("Unburden", true, "Leftovers"), 1);
  assert.equal(unburdenSpeedMultiplier("Unburden", undefined, null), 1);
});

for (const [ability, field, item] of [
  ["Protosynthesis", { weather: "SunnyDay" }, null],
  ["Quark Drive", { terrain: "Electric Terrain" }, null],
  ["Protosynthesis", {}, "Booster Energy"],
  ["Quark Drive", {}, "Booster Energy"],
  ["Quark Drive", { terrain: "Electric Terrain" }, "Booster Energy"]
] as const) {
  test(`${ability} activation retains uncertainty and respects revealed stats (${JSON.stringify(field)}, ${item})`, () => {
    assert.deepEqual(speedAbilityMultiplierRange(ability, field, item), { min: 1, max: 1.5 });
    assert.deepEqual(speedAbilityMultiplierRange(ability, field, item, "spe"), { min: 1.5, max: 1.5 });
    for (const stat of ["atk", "def", "spa", "spd", null]) {
      assert.deepEqual(speedAbilityMultiplierRange(ability, field, item, stat), { min: 1, max: 1 });
    }
  });
}

test("inactive Paradox abilities and ordinary field speed abilities remain distinct", () => {
  assert.deepEqual(speedAbilityMultiplierRange("Quark Drive", {}, null), { min: 1, max: 1 });
  assert.deepEqual(speedAbilityMultiplierRange("Protosynthesis", { terrain: "Electric Terrain" }, null), { min: 1, max: 1 });
  assert.deepEqual(speedAbilityMultiplierRange("Swift Swim", { weather: "RainDance" }, null), { min: 2, max: 2 });
  assert.deepEqual(speedAbilityMultiplierRange("Swift Swim", {}, null), { min: 1, max: 1 });
  assert.deepEqual(speedAbilityMultiplierRange("Quark Drive", {}, "Booster Energy", "spe"), { min: 1.5, max: 1.5 });
});

test("posterior applies Paradox Speed to the appropriate spread hypotheses instead of every set", async () => {
  const snapshot: BattleSnapshot = JSON.parse(await fs.readFile(
    new URL("../../../../examples/battle-snapshot.gen9ou.turn14.json", import.meta.url), "utf8"));
  const opponent = {
    ...snapshot.opponentSide.active!, species: "Iron Valiant", displayName: "Iron Valiant",
    ability: "Quark Drive", item: null, removedItem: "Booster Energy", teraType: "Fairy",
    boosts: {}, knownMoves: [], status: null
  };
  snapshot.opponentSide = { ...snapshot.opponentSide, active: opponent, team: [opponent] };
  const formatStats = {
    observedBattlesSeen: 0, observedMoves: {}, observedItems: {}, observedAbilities: {}, observedTeraTypes: {},
    curatedMoves: {}, curatedItems: {}, curatedAbilities: {}, curatedTeraTypes: {}
  };
  const build = (paradoxBoostedStat?: "spe" | "spa" | null) => buildOpponentPosterior({
    format: snapshot.format, opponent: { ...opponent, paradoxBoostedStat }, battleSnapshot: snapshot, formatStats
  })!.topHypotheses;
  const baseline = new Map(build(null).map((hypothesis) => [hypothesis.statArchetype, hypothesis.effectiveSpeed!]));
  const uncertain = build();
  assert.ok(uncertain.some((hypothesis) => hypothesis.effectiveSpeed === baseline.get(hypothesis.statArchetype)));
  assert.ok(uncertain.some((hypothesis) => hypothesis.effectiveSpeed === Math.floor(baseline.get(hypothesis.statArchetype)! * 1.5)));
  for (const hypothesis of build("spa")) {
    assert.equal(hypothesis.effectiveSpeed, baseline.get(hypothesis.statArchetype));
  }
  for (const hypothesis of build("spe")) {
    assert.equal(hypothesis.effectiveSpeed, Math.floor(baseline.get(hypothesis.statArchetype)! * 1.5));
  }
});

async function canonicalOrderSnapshot(first = "opponent") {
  const roomId = "battle-gen9uu-speed-conflict", engine = new DecisionEngine();
  const request = { rqid: 1, active: [{ moves: [{ move: "Grass Knot", id: "grassknot", pp: 20, maxpp: 20, target: "normal", disabled: false }] }], side: { id: "p1", pokemon: [
    { ident: "p1: Cloud", details: "Thundurus, L100", condition: "299/299", active: true, stats: { atk: 239, def: 176, spa: 349, spd: 197, spe: 353 }, moves: ["grassknot"], item: "heavydutyboots", baseAbility: "prankster", ability: "prankster" },
    { ident: "p1: King", details: "Slowking, L100", condition: "394/394", active: false, stats: { atk: 139, def: 259, spa: 236, spd: 258, spe: 58 }, moves: ["scald"], item: "heavydutyboots", baseAbility: "regenerator", ability: "regenerator" }
  ] } };
  await engine.ingest({ sessionId: "speed", roomId, observationId: "setup", sequence: 1, source: "protocol", data: `>${roomId}\n|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Arcanine-Hisui, L100\n|start|\n|switch|p1a: Cloud|Thundurus, L100|299/299\n|switch|p2a: Ember|Arcanine-Hisui, L100|100/100\n|request|${JSON.stringify(request)}\n|turn|23` });
  const moves = ["|move|p2a: Ember|Head Smash|p1a: Cloud|[miss]\n|-miss|p2a: Ember|p1a: Cloud", "|move|p1a: Cloud|Grass Knot|p2a: Ember\n|-damage|p2a: Ember|56/100"];
  const result = await engine.ingest({ sessionId: "speed", roomId, observationId: "order", sequence: 2, source: "protocol", data: `>${roomId}\n${(first === "opponent" ? moves : moves.reverse()).join("\n")}\n|upkeep\n|turn|24\n|request|${JSON.stringify({ ...request, rqid: 2 })}` });
  return result.snapshot!;
}

// Matters: the live strip said "You move first" against a Choice Scarf Hydreigon that had already moved before
// Thundurus 353, and Arcanine-Hisui (459 with its own Scarf) was then KOed by the faster Hydreigon. An observed
// priority-0 order that the item-free range cannot explain must bound the range (Scarf implied) for later decisions.
test("in-battle order before 353 with an unknown item implies Choice Scarf for the next switch-in", async () => {
  const roomId = "battle-gen9uu-speed-scarf", engine = new DecisionEngine();
  const thundurus = { ident: "p1: Cloud", details: "Thundurus, L100", condition: "299/299", active: true, stats: { atk: 239, def: 176, spa: 349, spd: 197, spe: 353 }, moves: ["voltswitch"], item: "heavydutyboots", baseAbility: "prankster", ability: "prankster" };
  const arcanine = { ident: "p1: Fire", details: "Arcanine-Hisui, L100", condition: "300/300", active: false, stats: { atk: 361, def: 196, spa: 203, spd: 196, spe: 306 }, moves: ["flareblitz"], item: "choicescarf", baseAbility: "rockhead", ability: "rockhead" };
  const request = (rqid: number, active: "Cloud" | "Fire") => ({ rqid, active: [{ moves: [active === "Cloud" ? { move: "Volt Switch", id: "voltswitch", pp: 32, maxpp: 32, target: "normal", disabled: false } : { move: "Flare Blitz", id: "flareblitz", pp: 24, maxpp: 24, target: "normal", disabled: false }] }],
    side: { id: "p1", pokemon: active === "Cloud" ? [thundurus, arcanine] : [{ ...arcanine, active: true }, { ...thundurus, active: false }] } });
  await engine.ingest({ sessionId: "speed", roomId, observationId: "setup", sequence: 1, source: "protocol", data: `>${roomId}\n|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Hydreigon, L100\n|start|\n|switch|p1a: Cloud|Thundurus, L100|299/299\n|switch|p2a: Dragon|Hydreigon, L100|100/100\n|request|${JSON.stringify(request(1, "Cloud"))}\n|turn|17` });
  const result = await engine.ingest({ sessionId: "speed", roomId, observationId: "order", sequence: 2, source: "protocol", data: `>${roomId}\n|move|p2a: Dragon|Dark Pulse|p1a: Cloud\n|-damage|p1a: Cloud|140/299\n|move|p1a: Cloud|Volt Switch|p2a: Dragon\n|-damage|p2a: Dragon|79/100\n|switch|p1a: Fire|Arcanine-Hisui, L100|300/300\n|upkeep\n|turn|18\n|request|${JSON.stringify(request(2, "Fire"))}` });
  const intel = await buildLocalIntelSnapshot(result.snapshot!, await projectCanonicalSnapshots([result.snapshot!], await createEphemeralIntelEvaluationContext()));
  assert.equal(intel.speedPreview!.yourActiveEffectiveSpeed, 459);
  assert.ok(intel.speedPreview!.effectiveRange!.min >= 353, JSON.stringify(intel.speedPreview!.effectiveRange));
  assert.equal(intel.speedPreview!.effectiveRange!.max, 486);
  assert.notEqual(intel.speedPreview!.activeRelation, "faster");
  assert.ok(intel.speedPreview!.evidence.some((entry) => /Choice Scarf implied \(T17 before Thundurus 353\)/.test(entry.label)), JSON.stringify(intel.speedPreview!.evidence));
  assert.equal(intel.opponents[0]!.revealedItem, null, "the implied item is a range assumption, never a reveal");
  const posterior = intel.opponents.find((entry) => entry.species === "Hydreigon")!.posterior!;
  assert.ok(posterior.evidenceKinds.includes("speed"), "unknown item/ability with no order-affecting ability still informs the set guesser");
  assert.equal(posterior.topHypotheses[0]!.item, "Choice Scarf");
});

// Matters: when no hidden item can explain an observed order (item revealed), the engine must not claim either order.
test("canonical order contradicting every supported range withholds every order claim without inventing a hidden item", async () => {
  const snapshot = await canonicalOrderSnapshot();
  for (const mon of [snapshot.opponentSide.active!, ...snapshot.opponentSide.team, ...snapshot.canonicalEvidence!.contributions.filter((entry) => entry.metric === "speed").flatMap((entry) => [entry.speed!.pokemon, entry.speed!.other])]) {
    if (mon.instanceId === snapshot.opponentSide.active!.instanceId) mon.item = "Heavy-Duty Boots";
  }
  const context = await createEphemeralIntelEvaluationContext();
  const intel = await buildLocalIntelSnapshot(snapshot, context);
  assert.equal(intel.speedPreview!.yourActiveEffectiveSpeed, 353);
  assert.deepEqual(intel.speedPreview!.effectiveRange, { min: 194, max: 306 });
  assert.equal(intel.speedPreview!.activeRelation, "unknown");
  assert.equal(intel.speedPreview!.reason, "confounded");
  assert.match(intel.speedPreview!.activeSummary!, /conditional/i);
  assert.ok(intel.speedPreview!.confounders.some((entry) => /observed order/i.test(entry)));
  assert.ok(intel.speedPreview!.switchMatchups.every((entry) => entry.relation === "unknown"));
  assert.ok(intel.opponentThreatPreview!.every((entry) => entry.currentTarget.relation === "unknown" && entry.switchTargets.every((target) => target.relation === "unknown")));
  assert.equal(intel.opponents[0]!.activeSpeedRelation, "unknown");
  const evidence = intel.speedPreview!.evidence.find((entry) => entry.kind === "confounded")!;
  const refs = evidence.factIds!;
  assert.ok(refs.length >= 2);
  assert.ok(refs.every((id) => snapshot.canonicalEvidence!.facts.some((fact) => fact.id === id)));
  assert.deepEqual(new Set(refs.filter((id) => snapshot.canonicalEvidence!.facts.find((fact) => fact.id === id)?.kind === "move")),
    new Set(snapshot.canonicalEvidence!.facts.filter((fact) => fact.kind === "move").map((fact) => fact.id)));
  assert.ok(!intel.selfActionRecommendation!.rankedActions.some((entry) => entry.reasons.some((reason) => /faster and|moves first|outspeed/i.test(reason))));
  const withoutOrder = structuredClone(snapshot);
  withoutOrder.canonicalEvidence!.contributions = withoutOrder.canonicalEvidence!.contributions.filter((entry) => entry.metric !== "speed");
  const baseline = await buildLocalIntelSnapshot(withoutOrder, context);
  assert.equal(baseline.speedPreview!.activeRelation, "faster");
  assert.deepEqual(intel.playerDamagePreview, baseline.playerDamagePreview, "damage mechanics are unchanged by the uncertainty veto");
});

test("agreeing canonical order preserves the supported Speed relation", async () => {
  const snapshot = await canonicalOrderSnapshot("your");
  const intel = await buildLocalIntelSnapshot(snapshot, await createEphemeralIntelEvaluationContext());
  assert.equal(intel.speedPreview!.activeRelation, "faster");
  assert.ok(!intel.speedPreview!.confounders.some((entry) => /observed order/i.test(entry)));
});

// Matters: only same-stint, supported, priority-0 evidence may move the verdict; explained or untrusted orders must not.
test("changed-stint, explained-modifier, priority, and quarantined order cannot invalidate current Speed", async () => {
  const original = await canonicalOrderSnapshot();
  for (const control of ["forme change", "other instance", "changed item", "changed field", "Trick Room", "priority", "called move", "recovery", "recovery fact", "missing fact", "order activation", "no canonical evidence"]) {
    const snapshot = structuredClone(original);
    const contribution = snapshot.canonicalEvidence!.contributions.find((entry) => entry.metric === "speed" && entry.instanceId === snapshot.opponentSide.active!.instanceId)!;
    const sample = contribution.speed!;
    if (control === "old turn") snapshot.turn += 2;
    if (control === "forme change") sample.pokemon.species = "Arcanine";
    if (control === "other instance") sample.pokemon.instanceId += "-other";
    if (control === "changed Speed") snapshot.yourSide.active!.stats!.spe = 354;
    if (control === "changed item") sample.pokemon.item = "Choice Scarf";
    if (control === "changed field") sample.field.opponentSideConditions.push("Tailwind");
    if (control === "Trick Room") { sample.field.pseudoWeather.push("Trick Room"); snapshot.field.pseudoWeather.push("Trick Room"); }
    if (control === "priority") sample.moveName = "Extreme Speed";
    if (control === "called move") snapshot.canonicalEvidence!.facts.find((fact) => fact.kind === "move")!.args.push("[from] move: Instruct");
    if (control === "recovery") contribution.eligibility = "quarantined";
    if (control === "recovery fact") snapshot.canonicalEvidence!.facts.find((fact) => fact.kind === "move")!.source.channel = "recovery";
    if (control === "missing fact") contribution.factIds.push("absent");
    if (control === "order activation") {
      const moveIndex = snapshot.canonicalEvidence!.facts.findIndex((fact) => fact.kind === "move");
      const fact = structuredClone(snapshot.canonicalEvidence!.facts[moveIndex]!);
      fact.id += "-activation"; fact.kind = "-activate"; fact.args = ["p2a: Ember", "item: Quick Claw"];
      snapshot.canonicalEvidence!.facts.splice(moveIndex, 0, fact); contribution.factIds.push(fact.id);
    }
    if (control === "no canonical evidence") { delete snapshot.canonicalEvidence; snapshot.recentLog = ["Turn 24 started.", "Ember used Head Smash.", "Cloud used Grass Knot."]; }
    const intel = await buildLocalIntelSnapshot(snapshot, await createEphemeralIntelEvaluationContext());
    assert.equal(intel.speedPreview!.activeRelation, "faster", control);
    assert.ok(!intel.speedPreview!.confounders.some((entry) => /observed order/i.test(entry)), control);
  }
});

// Matters: the opponent's raw Speed does not change within a stint, so an earlier order and a since-changed own
// Speed still bound the current verdict (the bound is taken against your effective Speed at that time).
test("an earlier same-stint order still bounds Speed after turns pass and your Speed changes", async () => {
  const original = await canonicalOrderSnapshot();
  for (const control of ["old turn", "changed Speed", "other appearance"]) {
    const snapshot = structuredClone(original);
    if (control === "old turn") snapshot.turn += 2;
    if (control === "other appearance") snapshot.opponentSide.active!.appearanceId += "-new";
    if (control === "changed Speed") snapshot.yourSide.active!.stats!.spe = 354;
    const intel = await buildLocalIntelSnapshot(snapshot, await createEphemeralIntelEvaluationContext());
    assert.notEqual(intel.speedPreview!.activeRelation, "faster", control);
    assert.ok(intel.speedPreview!.effectiveRange!.min >= 353, control);
  }
});


test("Slow Start exact Speed and intervals preserve native chained rounding without guessing its timer", async () => {
  const snapshot: BattleSnapshot = JSON.parse(await fs.readFile(new URL("../../../../examples/battle-snapshot.gen9ou.turn14.json", import.meta.url), "utf8"));
  const field = { ...snapshot.field, weather: null, terrain: null, pseudoWeather: [] };
  const base = { ...snapshot.yourSide.active!, species: "Regigigas", ability: "Slow Start", item: "Choice Scarf", status: "par", boosts: { spe: -1 } };
  const gen = Generations.get(9);
  const expected = (raw: number, abilityOn: boolean) => {
    const oracle = new Pokemon(gen, "Regigigas", { ability: "Slow Start", abilityOn, item: "Choice Scarf", status: "par", boosts: { spe: -1 } });
    oracle.rawStats.spe = raw;
    return getFinalSpeed(gen, oracle, new Field(), new Side({ isTailwind: true }));
  };
  for (const raw of [199, 328, 329]) for (const slowStartActive of [true, false]) {
    assert.equal(effectiveSpeed(9, raw, { ...base, slowStartActive }, ["Tailwind"], field), expected(raw, slowStartActive));
  }
  assert.equal(effectiveSpeed(9, 328, base, ["Tailwind"], field), null);
  assert.deepEqual(effectiveSpeedRange(9, { min: 199, max: 329 }, base, ["Tailwind"], field), { min: expected(199, true), max: expected(329, false) });
  assert.deepEqual(speedAbilityMultiplierRange("Slow Start", {}, null, undefined, true), { min: 0.5, max: 0.5 });
  assert.deepEqual(speedAbilityMultiplierRange("Slow Start", {}, null, undefined, false), { min: 1, max: 1 });
  assert.deepEqual(speedAbilityMultiplierRange("Slow Start", {}, null), { min: 0.5, max: 1 });
  const paradox = { ...base, ability: "Quark Drive", item: null, status: null, boosts: {}, removedItem: "Booster Energy", paradoxBoostedStat: undefined };
  assert.deepEqual(effectiveSpeedRange(9, { min: 199, max: 199 }, paradox, [], field), { min: 199, max: 298 });
  const stats = { observedBattlesSeen: 0, observedMoves: {}, observedItems: {}, observedAbilities: {}, observedTeraTypes: {}, curatedMoves: {}, curatedItems: {}, curatedAbilities: {}, curatedTeraTypes: {} };
  const opponent = { ...base, stats: undefined, item: null, status: null, boosts: {} };
  const build = (slowStartActive?: boolean) => buildOpponentPosterior({ format: "[Gen 9] UU", opponent: { ...opponent, slowStartActive }, formatStats: stats, battleSnapshot: snapshot })!.topHypotheses;
  assert.ok(build().every((hypothesis) => hypothesis.effectiveSpeed === null), "unknown timer cannot become a definite full-speed hypothesis");
  const active = build(true), expired = build(false);
  assert.equal(active.length, expired.length);
  for (const hypothesis of active) {
    const control = expired.find((entry) => entry.statArchetype === hypothesis.statArchetype && entry.item === hypothesis.item)!;
    assert.equal(hypothesis.effectiveSpeed, Math.floor(control.effectiveSpeed! / 2));
    assert.equal(hypothesis.weight, control.weight, "activation branches do not add posterior probability");
  }
});

function crossStintRoom(roomId: string) {
  const engine = new DecisionEngine();
  const fez = { ident: "p1: Fez", details: "Fezandipiti, L100", condition: "380/380", active: true, stats: { atk: 170, def: 280, spa: 196, spd: 236, spe: 234 }, moves: ["uturn"], item: "heavydutyboots", baseAbility: "toxicchain", ability: "toxicchain" };
  const scizor = { ident: "p1: Bug", details: "Scizor, L100", condition: "300/300", active: false, stats: { atk: 394, def: 236, spa: 131, spd: 196, spe: 220 }, moves: ["swordsdance"], item: "heavydutyboots", baseAbility: "technician", ability: "technician" };
  const thundurus = { ident: "p1: Cloud", details: "Thundurus, L100", condition: "299/299", active: false, stats: { atk: 239, def: 176, spa: 349, spd: 197, spe: 353 }, moves: ["knockoff"], item: "heavydutyboots", baseAbility: "prankster", ability: "prankster" };
  const request = (rqid: number, active: typeof fez) => ({ rqid, active: [{ moves: [{ move: active.moves[0], id: active.moves[0], pp: 16, maxpp: 16, target: "normal", disabled: false }] }],
    side: { id: "p1", pokemon: [active, ...[fez, scizor, thundurus].filter((mon) => mon !== active)].map((mon) => ({ ...mon, active: mon === active })) } });
  let sequence = 0;
  const ingest = (data: string) => engine.ingest({ sessionId: "stint", roomId, observationId: `o${++sequence}`, sequence, source: "protocol", data: `>${roomId}\n${data}` });
  return { ingest, request, fez, scizor, thundurus };
}

// Matters: raw Speed cannot change between stints. A Metagross that moved before a 234-Speed Fezandipiti, switched out
// and came back is still faster than a 220-Speed Scizor; the strip must not say "Speed uncertain".
test("an order from an earlier stint of the same Pokemon bounds its Speed after it returns", async () => {
  const f = crossStintRoom("battle-gen9uu-speed-stints");
  await f.ingest(`|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Metagross, L100\n|poke|p2|Rotom-Heat, L100\n|start|\n|switch|p1a: Fez|Fezandipiti, L100|380/380\n|switch|p2a: Meta|Metagross, L100|100/100\n|request|${JSON.stringify(f.request(1, f.fez))}\n|turn|25`);
  await f.ingest(`|move|p2a: Meta|Knock Off|p1a: Fez\n|-damage|p1a: Fez|300/380\n|-enditem|p1a: Fez|Heavy-Duty Boots|[from] move: Knock Off|[of] p2a: Meta\n|move|p1a: Fez|U-turn|p2a: Meta\n|-damage|p2a: Meta|89/100\n|switch|p1a: Bug|Scizor, L100|300/300\n|upkeep\n|turn|26\n|request|${JSON.stringify(f.request(2, f.scizor))}`);
  await f.ingest(`|switch|p2a: Heat|Rotom-Heat, L100|100/100\n|move|p1a: Bug|Swords Dance|p1a: Bug\n|-boost|p1a: Bug|atk|2\n|upkeep\n|turn|27\n|request|${JSON.stringify(f.request(3, f.scizor))}`);
  const back = await f.ingest(`|switch|p2a: Meta|Metagross, L100|89/100\n|move|p1a: Bug|Swords Dance|p1a: Bug\n|-boost|p1a: Bug|atk|2\n|upkeep\n|turn|29\n|request|${JSON.stringify(f.request(4, f.scizor))}`);
  const intel = await buildLocalIntelSnapshot(back.snapshot!, await createEphemeralIntelEvaluationContext());
  assert.equal(intel.speedPreview!.yourActiveEffectiveSpeed, 220);
  assert.equal(intel.speedPreview!.activeRelation, "slower", JSON.stringify(intel.speedPreview));
  assert.ok(intel.speedPreview!.effectiveRange!.min >= 234);
  assert.ok(intel.speedPreview!.evidence.some((entry) => /T25 before Fezandipiti 234/.test(entry.label)), JSON.stringify(intel.speedPreview!.evidence));
});

// Matters: a hidden item later revealed by Knock Off was held when the earlier order happened. Treating that order as
// item-free would call a Choice Scarf turn a contradiction; the revealed Scarf explains it and the current range drops it.
test("a later revealed item is applied to earlier orders and removed from the current range", async () => {
  const f = crossStintRoom("battle-gen9uu-speed-knocked-scarf");
  await f.ingest(`|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Hydreigon, L100\n|start|\n|switch|p1a: Cloud|Thundurus, L100|299/299\n|switch|p2a: Dragon|Hydreigon, L100|100/100\n|request|${JSON.stringify(f.request(1, f.thundurus))}\n|turn|17`);
  await f.ingest(`|move|p2a: Dragon|Dark Pulse|p1a: Cloud\n|-damage|p1a: Cloud|140/299\n|move|p1a: Cloud|Knock Off|p2a: Dragon\n|-damage|p2a: Dragon|70/100\n|-enditem|p2a: Dragon|Choice Scarf|[from] move: Knock Off|[of] p1a: Cloud\n|upkeep\n|turn|18\n|request|${JSON.stringify(f.request(2, f.thundurus))}`);
  const now = await f.ingest(`|switch|p1a: Bug|Scizor, L100|300/300\n|move|p2a: Dragon|Dark Pulse|p1a: Bug\n|-resisted|p1a: Bug\n|-damage|p1a: Bug|250/300\n|upkeep\n|turn|19\n|request|${JSON.stringify(f.request(3, f.scizor))}`);
  const intel = await buildLocalIntelSnapshot(now.snapshot!, await createEphemeralIntelEvaluationContext());
  assert.notEqual(intel.speedPreview!.activeRelation, "unknown", JSON.stringify(intel.speedPreview!.confounders));
  assert.deepEqual(intel.speedPreview!.effectiveRange, { min: 236, max: 324 }, "Scarf held at T17 (raw >= 236), no longer held now");
  assert.equal(intel.speedPreview!.activeRelation, "slower");
});

// Matters: Trick swaps items; the item the other side receives is the one held during the earlier order.
test("an item given away by Trick is applied to earlier orders and the received item to the current range", async () => {
  const f = crossStintRoom("battle-gen9uu-speed-trick");
  await f.ingest(`|init|battle\n|tier|[Gen 9] UU\n|poke|p2|Hydreigon, L100\n|start|\n|switch|p1a: Cloud|Thundurus, L100|299/299\n|switch|p2a: Dragon|Hydreigon, L100|100/100\n|request|${JSON.stringify(f.request(1, f.thundurus))}\n|turn|17`);
  await f.ingest(`|move|p2a: Dragon|Dark Pulse|p1a: Cloud\n|-damage|p1a: Cloud|140/299\n|move|p1a: Cloud|Knock Off|p2a: Dragon\n|-damage|p2a: Dragon|70/100\n|upkeep\n|turn|18\n|request|${JSON.stringify(f.request(2, f.thundurus))}`);
  const now = await f.ingest(`|move|p2a: Dragon|Trick|p1a: Cloud\n|-activate|p2a: Dragon|move: Trick|[of] p1a: Cloud\n|-item|p1a: Cloud|Choice Scarf|[from] move: Trick\n|-item|p2a: Dragon|Heavy-Duty Boots|[from] move: Trick\n|move|p1a: Cloud|Knock Off|p2a: Dragon\n|-damage|p2a: Dragon|40/100\n|upkeep\n|turn|19\n|request|${JSON.stringify(f.request(3, f.thundurus))}`);
  assert.equal(now.snapshot!.opponentSide.active!.item, "Heavy-Duty Boots");
  const intel = await buildLocalIntelSnapshot(now.snapshot!, await createEphemeralIntelEvaluationContext());
  assert.deepEqual(intel.speedPreview!.effectiveRange, { min: 236, max: 324 }, JSON.stringify(intel.speedPreview!.confounders));
});

// Matters: an Armarouge (item-free max 273) that KOs a 353-Speed Thundurus before it moves outsped it. Only one
// move happens, so no order used to be recorded: later turns showed Armarouge at 167–273 and the item as Weakness Policy,
// and a slower switch-in was told "may move first" into a Scarf Psychic. A KO before our active acted is an order when none of
// its moves could have had lower priority; the bound stays for the opponent's later stints. Board 2: Tyranitar vs
// Gardevoir; and a moveset holding a negative-priority move gives no bound.
test("an opponent that KOs our active before it acts outsped it, and the bound persists across stints", async () => {
  const boards = [
    { opp: "Armarouge", attack: "Armor Cannon", ours: { name: "Cloud", species: "Thundurus", spe: 353, moves: ["voltswitch", "thunderbolt", "thunderwave", "grassknot"], ability: "prankster" }, scarfMax: 409 },
    { opp: "Tyranitar", attack: "Crunch", ours: { name: "Gard", species: "Gardevoir", spe: 284, moves: ["moonblast", "psychic", "calmmind", "mysticalfire"], ability: "trace" }, scarfMax: 364 }
  ];
  for (const board of boards) {
    for (const negative of [false, true]) {
      const roomId = `battle-gen9uu-unacted-${board.opp.toLowerCase()}-${negative}`, engine = new DecisionEngine();
      const moves = negative ? [...board.ours.moves.slice(0, 3), "trickroom"] : board.ours.moves;
      const ours = { ident: `p1: ${board.ours.name}`, details: `${board.ours.species}, L100`, condition: "250/299", active: true, stats: { atk: 200, def: 180, spa: 300, spd: 200, spe: board.ours.spe }, moves, item: "heavydutyboots", baseAbility: board.ours.ability, ability: board.ours.ability };
      const wall = { ident: "p1: Wall", details: "Slowking, L100", condition: "394/394", active: false, stats: { atk: 155, def: 256, spa: 236, spd: 286, spe: 58 }, moves: ["scald", "slackoff", "futuresight", "chillyreception"], item: "heavydutyboots", baseAbility: "regenerator", ability: "regenerator" };
      const move = (id: string) => ({ move: id, id, pp: 16, maxpp: 16, target: "normal", disabled: false });
      const request = (rqid: number, first: boolean) => ({ rqid, active: [{ moves: (first ? moves : wall.moves).map(move) }],
        side: { id: "p1", pokemon: first ? [ours, wall] : [{ ...wall, active: true }, { ...ours, condition: "0 fnt", active: false }] } });
      const feed = (observationId: string, sequence: number, text: string) => engine.ingest({ sessionId: "speed", roomId, observationId, sequence, source: "protocol", data: `>${roomId}\n${text}` });
      await feed("setup", 1, `|init|battle\n|tier|[Gen 9] UU\n|poke|p2|${board.opp}, L100\n|poke|p2|Clodsire, L100\n|start|\n|switch|p1a: ${board.ours.name}|${board.ours.species}, L100|250/299\n|switch|p2a: Foe|${board.opp}, L100|100/100\n|request|${JSON.stringify(request(1, true))}\n|turn|12`);
      const fainted = { id: "p1", pokemon: [{ ...ours, condition: "0 fnt" }, wall] }; // Showdown keeps the fainted active first until the switch
      await feed("ko", 2, `|move|p2a: Foe|${board.attack}|p1a: ${board.ours.name}\n|-damage|p1a: ${board.ours.name}|0 fnt\n|faint|p1a: ${board.ours.name}\n|upkeep\n|request|${JSON.stringify({ rqid: 2, forceSwitch: [true], side: fainted })}`);
      // Re-entry: the opponent leaves for Clodsire and comes back before the next decision.
      const result = await feed("back", 3, `|switch|p1a: Wall|Slowking, L100|394/394\n|turn|13\n|switch|p2a: Mud|Clodsire, L100|100/100\n|move|p1a: Wall|Scald|p2a: Mud\n|-damage|p2a: Mud|80/100\n|upkeep\n|turn|14\n|switch|p2a: Foe|${board.opp}, L100|100/100\n|move|p1a: Wall|Slack Off|p1a: Wall\n|upkeep\n|turn|15\n|move|p2a: Foe|${board.attack}|p1a: Wall\n|-damage|p1a: Wall|300/394\n|move|p1a: Wall|Slack Off|p1a: Wall\n|-heal|p1a: Wall|394/394\n|upkeep\n|turn|16\n|request|${JSON.stringify(request(3, false))}`);
      const intel = await buildLocalIntelSnapshot(result.snapshot!, await projectCanonicalSnapshots([result.snapshot!], await createEphemeralIntelEvaluationContext()));
      const range = intel.speedPreview!.effectiveRange!;
      if (negative) { assert.ok(range.min < board.ours.spe, `${board.opp}: a possible Trick Room choice is no Speed order (${JSON.stringify(range)})`); continue; }
      assert.ok(range.min >= board.ours.spe && range.max === board.scarfMax, `${board.opp}: ${JSON.stringify(range)} after re-entry`);
      assert.ok(intel.speedPreview!.evidence.some((entry) => /^Choice Scarf implied \(T12 before /.test(entry.label)), JSON.stringify(intel.speedPreview!.evidence));
      const posterior = intel.opponents.find((entry) => entry.species === board.opp)!.posterior!;
      assert.equal(posterior.topHypotheses[0]!.item, "Choice Scarf", `${board.opp}: the order implies the item`);
      // The implied Scarf locks the opponent into the one move of its stint; the warning says so as a fact.
      const guards = computeTacticalGuards({ semantic: { snapshot: result.snapshot!, localIntel: intel, capabilities: { status: "supported", limitations: [] } } } as any).guards;
      const lock = guards.find((guard) => guard.kind === "choice_lock");
      assert.equal(lock?.short, `${board.opp} is locked into ${board.attack} (Scarf)`, JSON.stringify(guards));
    }
  }
});

// Matters: a rare item (Choice Scarf at 1.2% of Armarouge's ladder sets) was pruned from the
// posterior before evidence was scored, and a contradicted canonical order cost only 1:100, so "Weakness Policy 74%"
// survived the order. With many common items, one canonical order the others cannot meet must make the rare item dominant.
test("a canonical order that only a rare item explains makes it the posterior's leading item", () => {
  const formatStats = { observedBattlesSeen: 0, observedMoves: {}, observedItems: {}, observedAbilities: {}, observedTeraTypes: {}, curatedMoves: {}, curatedItems: {}, curatedAbilities: {}, curatedTeraTypes: {} };
  const common = ["Weakness Policy", "Heavy-Duty Boots", "Focus Sash", "Power Herb", "Life Orb", "Leftovers", "Assault Vest", "Expert Belt", "Choice Specs", "Rocky Helmet"];
  for (const [species, threshold] of [["Armarouge", 353], ["Tyranitar", 284]] as const) {
    const ladderItems = [...common.map((name, index) => ({ name, share: index === 0 ? 0.7 : 0.03 })), { name: "Choice Scarf", share: 0.012 }];
    const opponent = { ident: `p2: ${species}`, species, displayName: species, level: 100, conditionText: null, hpPercent: 76, status: null, fainted: false, active: true, revealed: true,
      boosts: {}, knownMoves: [], item: null, removedItem: null, ability: null, types: [], teraType: null, terastallized: false } as any;
    const field = { weather: null, terrain: null, pseudoWeather: [], yourSideConditions: [], opponentSideConditions: [] };
    const posterior = buildOpponentPosterior({ format: "[Gen 9] UU", opponent, formatStats: { ...formatStats, ladderItems },
      battleEvidence: { incomingDamage: [], outgoingDamage: [], speedObservations: [{ key: "o", turn: 12, relation: "first", yourSpecies: "Ours", yourSpeedStat: threshold, opponent, field, factIds: ["f1"] }] } })!;
    const scarf = posterior.itemShares?.find((entry) => entry.name === "Choice Scarf")?.share ?? 0;
    assert.ok(scarf > 0.6, `${species}: Choice Scarf ${scarf}`);
  }
});

// Matters: three Earthquakes impossible without a power item left Choice Band at 35–49% beside
// Booster Energy, which Slither Wing could not be holding: Booster Energy is consumed on entry whenever its Protosynthesis
// (or Quark Drive) is not already active from the field. Sun or Electric Terrain keeps it possible.
test("Booster Energy is ruled out for an active Paradox Pokemon whose field would have consumed it", () => {
  const formatStats = { observedBattlesSeen: 0, observedMoves: {}, observedItems: {}, observedAbilities: {}, observedTeraTypes: {}, curatedMoves: {}, curatedItems: {}, curatedAbilities: {}, curatedTeraTypes: {} };
  const ladderItems = [{ name: "Booster Energy", share: 0.4 }, { name: "Choice Band", share: 0.3 }, { name: "Leftovers", share: 0.3 }];
  for (const [species, ability, field] of [["Slither Wing", "Protosynthesis", { weather: "SunnyDay", terrain: null }], ["Iron Treads", "Quark Drive", { weather: null, terrain: "Electric Terrain" }]] as const) {
    const opponent = { ident: `p2: ${species}`, species, displayName: species, level: 100, conditionText: null, hpPercent: 88, status: null, fainted: false, active: true, revealed: true,
      boosts: {}, knownMoves: [], item: null, removedItem: null, ability, types: [], teraType: null, terastallized: false } as any;
    const snapshot = (activating: boolean) => ({ yourSide: { slot: "p1", name: null, active: null, team: [] }, opponentSide: { slot: "p2", name: null, active: opponent, team: [opponent] }, field: { weather: activating ? field.weather : null, terrain: activating ? field.terrain : null, pseudoWeather: [], yourSideConditions: [], opponentSideConditions: [] } }) as any;
    const booster = (activating: boolean) => buildOpponentPosterior({ format: "[Gen 9] UU", opponent, formatStats: { ...formatStats, ladderItems }, battleSnapshot: snapshot(activating) })!
      .itemShares?.find((entry) => entry.name === "Booster Energy")?.share ?? 0;
    assert.equal(booster(false), 0, `${species}: an unconsumed Booster Energy is impossible here`);
    assert.ok(booster(true) > 0.2, `${species}: under its field the item can stay held`);
  }
});

// Matters: Slither Wing Earthquakes taking 31%, 28% and 28% of Donphan's exact 383 HP are beyond
// any item-free roll, yet the posterior said "Band 35%". Repeated observed rolls that only a power item reaches must make it
// the leading item over commoner items (Booster Energy is consumed here); one unrelated attacker checks it is not tuned.
test("repeated hits only a power item reaches make that item dominate the posterior", () => {
  const formatStats = { observedBattlesSeen: 0, observedMoves: {}, observedItems: {}, observedAbilities: {}, observedTeraTypes: {}, curatedMoves: {}, curatedItems: {}, curatedAbilities: {}, curatedTeraTypes: {} };
  const field = { weather: null, terrain: null, pseudoWeather: [], yourSideConditions: [], opponentSideConditions: [] };
  const mon = (side: "p1" | "p2", species: string, extra: Record<string, unknown>) => ({ ident: `${side}: ${species}`, species, displayName: species, level: 100, conditionText: null, hpPercent: 100,
    status: null, fainted: false, active: true, revealed: true, boosts: {}, knownMoves: [], item: null, removedItem: null, ability: null, types: [], teraType: null, terastallized: false, ...extra }) as any;
  const donphan = mon("p1", "Donphan", { item: "Heavy-Duty Boots", ability: "Sturdy", conditionText: "383/383", stats: { hp: 383, atk: 280, def: 370, spa: 140, spd: 156, spe: 136 } });
  for (const [species, ability, move, observed, ladderItems] of [
    ["Slither Wing", "Protosynthesis", "Earthquake", [31.1, 28.5, 27.9], [{ name: "Booster Energy", share: 0.38 }, { name: "Assault Vest", share: 0.22 }, { name: "Choice Scarf", share: 0.17 }, { name: "Choice Band", share: 0.11 }, { name: "Heavy-Duty Boots", share: 0.08 }]],
    ["Rhyperior", "Solid Rock", "High Horsepower", [42.0, 40.5, 43.1], [{ name: "Weakness Policy", share: 0.4 }, { name: "Leftovers", share: 0.3 }, { name: "Assault Vest", share: 0.18 }, { name: "Choice Band", share: 0.12 }]]
  ] as const) {
    const opponent = mon("p2", species, { ability, hpPercent: 88 });
    const incomingDamage = observed.map((percent, index) => ({ key: `d${index}`, direction: "incoming" as const, turn: 3 + index, moveName: move, percent, attacker: opponent, defender: { ...donphan, hpPercent: 100 }, field, factIds: [`f${index}`] }));
    const posterior = buildOpponentPosterior({ format: "[Gen 9] UU", opponent, formatStats: { ...formatStats, ladderItems: [...ladderItems] },
      battleSnapshot: { yourSide: { slot: "p1", name: null, active: donphan, team: [donphan] }, opponentSide: { slot: "p2", name: null, active: opponent, team: [opponent] }, field } as any,
      battleEvidence: { incomingDamage, outgoingDamage: [], speedObservations: [] } })!;
    const band = posterior.itemShares?.find((entry) => entry.name === "Choice Band")?.share ?? 0;
    assert.ok(band > 0.6, `${species}: Choice Band ${band} (${JSON.stringify(posterior.itemShares?.slice(0, 4))})`);
  }
});
