import assert from "node:assert/strict";
import test from "node:test";
import { calculate, Field, Generations, Move, Pokemon } from "@smogon/calc";
import { BattlePokemon, applyAbilityState, calculateDamageScenarios, assessImmediateDamage } from "../mechanics/calcPokemon.js";
import { Battle, Teams, TeamValidator } from "../battle-agent/nativeSimulator.js";
import { effectiveSpeed } from "../mechanics/speed.js";
const { applyRawFrameToRoomMap, roomToSnapshot } = await import(new URL("../../../extension/lib/showdown-parser.js", import.meta.url).href);
import { buildDamagePreview, buildThreatPreview } from "../prompting/damageNotes.js";
import { buildSelfActionRecommendation, weightedOpponentReplies } from "../prediction/selfActionRecommender.js";
import { buildOpponentActionPrediction } from "../prediction/opponentActionPredictor.js";
import { buildLocalIntelSnapshot, createEphemeralIntelEvaluationContext } from "../history/opponentIntelStore.js";
import type { BattleSnapshot, PokemonSnapshot, OpponentPosteriorPreview, OpponentActionPrediction } from "../types.js";

const gen = Generations.get(9);
function mon(species: string, side: string, options: ConstructorParameters<typeof Pokemon>[2] = {}): PokemonSnapshot {
  const pokemon = new Pokemon(gen, species, options);
  return {
    ident: `${side}: ${species}`, species, displayName: species, level: 100, conditionText: "100/100", hpPercent: 100,
    active: true, revealed: true, fainted: false, status: null, boosts: {}, stats: { ...pokemon.rawStats }, knownMoves: [],
    item: pokemon.item ?? null, removedItem: null, ability: pokemon.ability ?? null, types: [...pokemon.types], teraType: null, terastallized: false
  };
}
function snapshot(attacker: PokemonSnapshot, defender: PokemonSnapshot, moveName = "Earthquake"): BattleSnapshot {
  return {
    version: "0.1.0", capturedAt: "2026-10-18T00:00:00Z", roomId: "battle-gen9uu-calc-contract", title: null, format: "[Gen 9] UU", turn: 5, phase: "turn",
    yourSide: { slot: "p1", name: "You", active: attacker, team: [attacker] },
    opponentSide: { slot: "p2", name: "Them", active: defender, team: [defender] },
    field: { weather: null, terrain: null, pseudoWeather: [], yourSideConditions: [], opponentSideConditions: [] },
    legalActions: [{ id: "move:1|tera=0", kind: "move", moveName, moveSlot: 1, label: moveName, terastallize: false }],
    recentLog: [], notes: []
  };
}
function likely(bands: ReturnType<typeof buildDamagePreview>[number]["bands"]) {
  return bands.find((band) => band.label === "likely") ?? bands[0]!;
}
function oracle(attacker: Pokemon, defender: Pokemon, moveName: string, field = new Field()) {
  return calculate(gen, attacker, defender, new Move(gen, moveName), field).range().map((roll) => Number((roll / defender.maxHP() * 100).toFixed(1)));
}

// Stats/forms/known move match the retained validator-legal R37 Disguise fixture.
function disguiseState(species = "Mimikyu", hp = 251) {
  const target = { ...mon(species, "p1", { ability: "Disguise" }), identityStatus: "resolved" as const,
    conditionText: `${hp}/251`, hpPercent: hp / 251 * 100, ability: "disguise",
    stats: { hp: 251, atk: 279, def: 196, spa: 122, spd: 247, spe: 320 }, knownMoves: ["Swords Dance", "Shadow Claw"] };
  const source = { ...mon("Scizor", "p2", { item: "Life Orb" }), stats: {}, ability: null,
    boosts: { atk: 2 }, knownMoves: ["Iron Head", "Swords Dance"], hpPercent: 91, conditionText: "91/100" };
  const state = snapshot(target, source, "Shadow Claw");
  state.legalActions.unshift({ id: "move:2|tera=0", kind: "move", moveName: "Swords Dance", moveSlot: 2, label: "Swords Dance", terastallize: false });
  state.yourSide.team.push({ ...mon("Slowking", "p1", { ability: "Regenerator", nature: "Bold", evs: { hp: 252, def: 252, spd: 4 } }), active: false });
  state.legalActions.push({ id: "switch:2", kind: "switch", targetSlot: 2, label: "Switch to Slowking" });
  return state;
}

test("R38 intact Disguise corrects production incoming HP loss and preservation without changing raw pressure", async (t) => {
  const state = disguiseState(), before = JSON.stringify(state);
  const intel = await buildLocalIntelSnapshot(state, await createEphemeralIntelEvaluationContext());
  const busted = await buildLocalIntelSnapshot(disguiseState("Mimikyu-Busted"), await createEphemeralIntelEvaluationContext());
  const bands = intel.opponentThreatPreview!.find((p) => p.moveName === "Iron Head")!.currentTarget.bands;
  const ordinary = busted.opponentThreatPreview!.find((p) => p.moveName === "Iron Head")!.currentTarget.bands;
  assert.ok(bands.every((band) => band.minPercent! > 100));
  assert.ok(bands.every((band) => band.immediate.ko === "no_ko"), "Intact native251HP loses31HP, rather than taking the lethal stock range.");
  for (const [i, band] of bands.entries()) {
    assert.equal(band.immediate.minHpLossPercent, 31 / 251 * 100);
    assert.equal(band.immediate.maxHpLossPercent, 31 / 251 * 100);
    assert.deepEqual([band.minPercent, band.maxPercent], [ordinary[i]!.minPercent, ordinary[i]!.maxPercent]);
  }
  assert.ok(ordinary.every((band) => band.immediate.ko === "all_rolls"));
  const preservation = (value: typeof intel) => value.selfActionRecommendation!.rankedActions.find((a) => a.actionId === "move:1|tera=0")!.scoreBreakdown!.find((p) => p.key === "preserve")?.value ?? 0;
  assert.ok(preservation(intel) > preservation(busted), "The scorer must not retain the raw-lethal preservation penalty.");
  const switchReasons = (value: typeof intel) => value.selfActionRecommendation!.rankedActions.find((a) => a.actionId === "switch:2")!.reasons;
  assert.ok(!switchReasons(intel).some((reason) => reason.endsWith("safer than the obvious stay line")));
  assert.ok(switchReasons(busted).includes("Among considered move forecasts: safer than the obvious stay line"));
  t.diagnostic(JSON.stringify({ intact: { top: intel.selfActionRecommendation!.topActionId, switchReasons: switchReasons(intel) },
    busted: { top: busted.selfActionRecommendation!.topActionId, switchReasons: switchReasons(busted) } }));
  assert.equal(JSON.stringify(state), before);
});

test("R38 Disguise chip respects low HP, rounded support, busted form and resolved bypass", () => {
  const attacker = new Pokemon(gen, "Haxorus", { ability: "Rivalry", boosts: { atk: 6 } });
  const defender = new Pokemon(gen, "Mimikyu", { ability: "Disguise" });
  const assess = (target = defender, source = attacker, hp = 251, extra = {}) => {
    const result = calculate(gen, source, target, new Move(gen, "Earthquake"));
    const raw = JSON.stringify(result.damage), value = assessImmediateDamage(result, { currentHp: hp, maxHp: 251, sequence: "single_hit", ...extra });
    assert.equal(JSON.stringify(result.damage), raw); return value;
  };
  assert.equal(assess().maxHpLossPercent, 31 / 251 * 100);
  assert.deepEqual([assess(defender, attacker, 31).ko, assess(defender, attacker, 20).maxHpLossPercent], ["all_rolls", 20 / 251 * 100]);
  assert.equal(assess(defender, attacker, 32).ko, "no_ko");
  const rounded = assess(defender, attacker, 31, { currentHpRange: { min: 30, max: 32 } });
  assert.equal(rounded.ko, "conditional"); assert.equal(rounded.minHpLossPercent, 30 / 251 * 100); assert.equal(rounded.maxHpLossPercent, 31 / 251 * 100);
  assert.equal(assess(new Pokemon(gen, "Mimikyu-Busted", { ability: "Disguise" }), attacker, 220).ko, "all_rolls");
  const breaker = new Pokemon(gen, "Haxorus", { ability: "Mold Breaker", boosts: { atk: 6 } });
  assert.equal(assess(defender, breaker).ko, "all_rolls");
  assert.equal(assess(new Pokemon(gen, "Mimikyu", { ability: "Disguise", item: "Ability Shield" }), breaker).ko, "no_ko");
  assert.equal(assess(new Pokemon(gen, "Mimikyu", { ability: "No Ability" })).ko, "all_rolls");
  assert.equal(assess(defender, attacker, 251, { sequence: "unsupported" }).ko, "unknown");
  assert.equal(assess(defender, attacker, 251, { defenderFormUncertain: true }).ko, "unknown");
  const uncertain = disguiseState(); uncertain.yourSide.active!.identityStatus = "ambiguous";
  assert.ok(buildThreatPreview(uncertain, { moveCandidates: [{ name: "Iron Head", source: "known" }] })[0]!.currentTarget.bands.every((band) => band.immediate.ko === "unknown"));
  const zero = calculate(gen, new Pokemon(gen, "Machamp"), defender, new Move(gen, "Seismic Toss"));
  assert.equal(assessImmediateDamage(zero, { currentHp: 251, maxHp: 251, sequence: "single_hit" }).maxHpLossPercent, 0, "An immune move does not bust Disguise.");
});

test("R38 Disguise alternatives preserve joint posterior mass and raw weighted ranges", () => {
  const source = mon("Scizor", "p1", { boosts: { atk: 6 } }); source.boosts = { atk: 6 };
  const target = { ...mon("Mimikyu", "p2"), ability: null, item: null };
  const posterior: OpponentPosteriorPreview = { confidenceTier: "usable", statBands: [], evidenceKinds: [], evidence: [], usedFallback: false,
    topHypotheses: [
      { ability: "Disguise", item: "Leftovers", weight: .9, teraType: null, nature: "Serious", evs: {}, statArchetype: "bulky_phys", support: [] },
      { ability: "No Ability", item: "Leftovers", weight: .1, teraType: null, nature: "Serious", evs: {}, statArchetype: "bulky_phys", support: [] }
    ] };
  const before = JSON.stringify(posterior), state = snapshot(source, target, "Iron Head");
  const mixed = buildDamagePreview(state, { defenderPosterior: posterior })[0]!;
  const ordinary = buildDamagePreview(state, { defenderPosterior: { ...posterior, topHypotheses: posterior.topHypotheses.map((p) => ({ ...p, ability: "No Ability" })) } })[0]!;
  assert.ok(mixed.bands.every((band) => band.immediate.ko === "conditional"));
  assert.deepEqual(mixed.bands.map((b) => [b.minPercent, b.maxPercent]), ordinary.bands.map((b) => [b.minPercent, b.maxPercent]));
  assert.equal(JSON.stringify(posterior), before);
});

test("R39 qualified Ice Face physical absorption keeps form, HP, generation and effective-ability boundaries", () => {
  const source = new Pokemon(gen, "Haxorus", { ability: "Rivalry", boosts: { atk: 6 } });
  const assess = (species: string, move: string, attacker = source, item = "", extra = {}) => {
    const target = new Pokemon(gen, species, { ability: "Ice Face", item });
    const result = calculate(gen, attacker, target, new Move(gen, move)), raw = JSON.stringify(result.damage);
    const value = assessImmediateDamage(result, { currentHp: target.maxHP(), maxHp: target.maxHP(), sequence: "single_hit", ...extra });
    assert.equal(JSON.stringify(result.damage), raw); return value;
  };
  const intact = assess("Eiscue", "Earthquake");
  assert.equal(intact.ko, "no_ko"); assert.equal(intact.minHpLossPercent, 0); assert.equal(intact.maxHpLossPercent, 0);
  assert.notEqual(assess("Eiscue", "Surf").ko, "unknown");
  assert.notEqual(assess("Eiscue-Noice", "Earthquake").ko, "unknown");
  const breaker = new Pokemon(gen, "Haxorus", { ability: "Mold Breaker", boosts: { atk: 6 } });
  assert.equal(assess("Eiscue", "Earthquake", breaker).ko, "all_rolls");
  assert.equal(assess("Eiscue", "Earthquake", breaker, "Ability Shield").maxHpLossPercent, 0, "Reuse the calculator's effective ability, without a second bypass resolver.");
  assert.equal(assess("Eiscue", "Earthquake", source, "", { defenderFormUncertain: true }).ko, "unknown");
  assert.equal(assess("Eiscue", "Earthquake", source, "", { sequence: "unsupported" }).ko, "unknown");
  assert.equal(assess("Eiscue", "Earthquake", source, "", { currentHp: null }).ko, "unknown");
  const previousGen = Generations.get(8), target = new Pokemon(previousGen, "Eiscue", { ability: "Ice Face" });
  const unqualified = calculate(previousGen, new Pokemon(previousGen, "Haxorus"), target, new Move(previousGen, "Earthquake"));
  assert.equal(assessImmediateDamage(unqualified, { currentHp: target.maxHP(), maxHp: target.maxHP(), sequence: "single_hit" }).ko, "unknown");
});

test("R39 saved Ice Face qualification reaches production threat and scoring consumers without changing raw pressure", async (t) => {
  // Exact private stats/current HP and public attacker knowledge from the
  // validator-legal R38 fixture: special354->214, physical214->214, Noice214->0.
  const target = { ...mon("Eiscue", "p1"), identityStatus: "resolved" as const, ability: "iceface", item: null,
    conditionText: "214/354", hpPercent: 60.5, knownMoves: ["Surf"], stats: { hp: 354, atk: 196, def: 257, spa: 149, spd: 216, spe: 218 } };
  const source = { ...mon("Scizor", "p2", { item: "Life Orb" }), stats: {}, ability: null, knownMoves: ["Iron Head", "Flash Cannon"], hpPercent: 81, conditionText: "81/100" };
  const state = snapshot(target, source, "Surf");
  state.yourSide.team.push({ ...mon("Slowking", "p1", { ability: "Regenerator", nature: "Bold", evs: { hp: 252, def: 252, spd: 4 } }), active: false });
  state.legalActions.push({ id: "switch:2", kind: "switch", targetSlot: 2, label: "Switch to Slowking" });
  const before = JSON.stringify(state), intel = await buildLocalIntelSnapshot(state, await createEphemeralIntelEvaluationContext());
  const physical = intel.opponentThreatPreview!.find((p) => p.moveName === "Iron Head")!.currentTarget.bands;
  assert.ok(physical.every((b) => b.immediate.ko === "no_ko" && b.immediate.minHpLossPercent === 0 && b.immediate.maxHpLossPercent === 0), "R38 honest UNKNOWN extends to qualified zero physical HP loss from the saved native fixture.");
  const ordinaryState = structuredClone(state); ordinaryState.yourSide.active!.ability = "No Ability";
  const ordinary = buildThreatPreview(ordinaryState, { moveCandidates: [{ name: "Iron Head", source: "known" }, { name: "Flash Cannon", source: "known" }] });
  assert.deepEqual(physical.map((b) => [b.minPercent, b.maxPercent]), ordinary.find((p) => p.moveName === "Iron Head")!.currentTarget.bands.map((b) => [b.minPercent, b.maxPercent]));
  assert.deepEqual(intel.opponentThreatPreview!.find((p) => p.moveName === "Flash Cannon")!.currentTarget.bands, ordinary.find((p) => p.moveName === "Flash Cannon")!.currentTarget.bands);
  const noice = structuredClone(state); noice.yourSide.active!.species = "Eiscue-Noice";
  noice.yourSide.active!.stats = { ...target.stats, def: 177, spd: 136, spe: 394 };
  assert.ok(buildThreatPreview(noice, { moveCandidates: [{ name: "Iron Head", source: "known" }] })[0]!.currentTarget.bands.every((b) => b.immediate.ko === "all_rolls"));
  assert.ok(intel.opponentActionPrediction!.topActions.some((a) => a.moveName === "Iron Head"));
  assert.ok(!intel.opponentActionPrediction!.topActions.find((a) => a.moveName === "Iron Head")!.riskFlags.some((flag) => /unavailable|not qualified/i.test(flag)));
  t.diagnostic(JSON.stringify({ top: intel.selfActionRecommendation!.topActionId, reasons: intel.selfActionRecommendation!.reasons,
    opponentActions: intel.opponentActionPrediction!.topActions.map((a) => ({ move: a.moveName, score: a.score, riskFlags: a.riskFlags })) }));
  assert.equal(JSON.stringify(state), before);
});

test("R39 Ice Face alternatives preserve joint posterior weights and raw weighted ranges", () => {
  const source = mon("Scizor", "p1"), target = { ...mon("Eiscue", "p2", { nature: "Jolly", evs: { hp: 252, def: 4, spe: 252 } }), ability: null, item: null, conditionText: "214/354", hpPercent: 60.5 };
  const posterior: OpponentPosteriorPreview = { confidenceTier: "usable", statBands: [], evidenceKinds: [], evidence: [], usedFallback: false,
    topHypotheses: [
      { ability: "Ice Face", item: "Leftovers", weight: .8, teraType: null, nature: "Jolly", evs: { hp: 252, def: 4, spe: 252 }, statArchetype: "bulky_phys", support: [] },
      { ability: "No Ability", item: "Leftovers", weight: .2, teraType: null, nature: "Jolly", evs: { hp: 252, def: 4, spe: 252 }, statArchetype: "bulky_phys", support: [] }
    ] };
  const before = JSON.stringify(posterior), state = snapshot(source, target, "Iron Head");
  const mixed = buildDamagePreview(state, { defenderPosterior: posterior })[0]!;
  const ordinary = buildDamagePreview(state, { defenderPosterior: { ...posterior, topHypotheses: posterior.topHypotheses.map((p) => ({ ...p, ability: "No Ability" })) } })[0]!;
  assert.ok(mixed.bands.every((b) => b.immediate.ko === "conditional" && b.immediate.minHpLossPercent === 0));
  assert.deepEqual(mixed.bands.map((b) => [b.minPercent, b.maxPercent]), ordinary.bands.map((b) => [b.minPercent, b.maxPercent]));
  assert.equal(JSON.stringify(posterior), before);
});

test("exact captured stats affect outgoing and incoming damage and survive repeated calculator clones", () => {
  const low = { nature: "Serious", evs: { atk: 0 } }, high = { nature: "Adamant", evs: { atk: 252 } };
  const defense = { nature: "Serious", evs: { hp: 252, def: 128 } };
  const target = mon("Slowking", "p2", defense);
  const ranges = [low, high].map((spread) => {
    const band = likely(buildDamagePreview(snapshot(mon("Donphan", "p1", spread), target))[0]!.bands);
    assert.deepEqual([band.minPercent, band.maxPercent], oracle(new Pokemon(gen, "Donphan", spread), new Pokemon(gen, "Slowking", defense), "Earthquake"));
    return band.maxPercent!;
  });
  assert.ok(ranges[1]! > ranges[0]!);
  const incoming = [0, 252].map((def) => {
    const state = snapshot(mon("Slowking", "p1", { evs: { def } }), mon("Donphan", "p2"));
    return likely(buildThreatPreview(state, { moveCandidates: [{ name: "Earthquake", source: "known" }] })[0]!.currentTarget.bands).maxPercent!;
  });
  assert.ok(incoming[1]! < incoming[0]!);
  const original = new BattlePokemon(gen, "Slowking");
  original.rawStats.hp = 900; original.stats.hp = 900; original.rawStats.def = 400; original.stats.def = 400; original.originalCurHP = 800;
  const clone = original.clone().clone();
  assert.deepEqual(clone.rawStats, original.rawStats);
  assert.equal(clone.originalCurHP, 800);
  clone.rawStats.def = 1;
  assert.equal(original.rawStats.def, 400);
});

test("private request ability and item IDs have the same damage as calculator display names", () => {
  const options = { ability: "Technician", item: "Choice Band" };
  const canonical = mon("Scizor", "p1", options);
  const ids = { ...canonical, ability: "technician", item: "choiceband" };
  const target = mon("Slowking", "p2");
  const expected = oracle(new Pokemon(gen, "Scizor", options), new Pokemon(gen, "Slowking"), "Bullet Punch");
  const outgoing = likely(buildDamagePreview(snapshot(ids, target, "Bullet Punch"))[0]!.bands);
  assert.deepEqual([outgoing.minPercent, outgoing.maxPercent], expected);
  const incoming = likely(buildThreatPreview(snapshot({ ...target, ident: "p1: Slowking" }, { ...ids, ident: "p2: Scizor" }), {
    moveCandidates: [{ name: "Bullet Punch", source: "known" }]
  })[0]!.currentTarget.bands);
  assert.deepEqual([incoming.minPercent, incoming.maxPercent], expected);
  assert.equal(ids.ability, "technician");
  assert.equal(ids.item, "choiceband");
  const clone = new BattlePokemon(gen, "Scizor", { ...options, ability: ids.ability, item: ids.item }).clone().clone();
  assert.equal(clone.ability, "Technician");
  assert.equal(clone.item, "Choice Band");
});

test("faint replacements have no outgoing preservation or stay-line rewards; living pivots retain them", () => {
  const active = { ...mon("Arcanine-Hisui", "p1"), hpPercent: 10, knownMoves: ["Extreme Speed"] };
  const reserve = { ...mon("Thundurus", "p1"), active: false };
  const other = { ...mon("Slowking", "p1"), active: false };
  const state = snapshot(active, mon("Donphan", "p2"));
  state.turn = 30;
  state.yourSide.team = [active, reserve, other];
  state.legalActions = [{ id: "switch:2", kind: "switch", targetSlot: 2, target: "Thundurus", label: "Switch to Thundurus", choice: "switch 2" }];
  const prediction = { topActionClass: "stay_attack", confidenceTier: "medium", topActions: [
    { actionClass: "stay_attack", moveName: "Earthquake", label: "Earthquake", score: 100 }
  ], topSwitchTargets: [] } as unknown as OpponentActionPrediction;
  const evaluate = () => buildSelfActionRecommendation({ snapshot: state, playerDamagePreview: [],
    opponentThreatPreview: buildThreatPreview(state, { moveCandidates: [{ name: "Earthquake", source: "known" }] }),
    opponentActionPrediction: prediction })!.rankedActions[0]!;
  const living = evaluate();
  assert.ok(living.scoreBreakdown!.some((entry) => entry.key === "preserve" && entry.value > 0));
  active.fainted = true; active.hpPercent = 0; active.conditionText = "0 fnt";
  const fainted = evaluate();
  assert.ok(!fainted.scoreBreakdown!.some((entry) => entry.key === "preserve"));
  assert.ok(!fainted.reasons.some((reason) => /preserv|stay line/i.test(reason)));
  assert.ok(fainted.reasons.some((reason) => /immunity|attack/i.test(reason)));
  assert.ok(living.score > fainted.score);
});

// Matters: likely sets should reflect the player's own games. Pre-canonical battles live in
// the legacy ledger, which the canonical live view ignored, so "your games" showed only today's battles. Their set counts
// (moves/items/abilities/Tera, battles seen) must reach the live view; damage and speed stay canonical-only.
test("canonical live intel includes the owner's legacy set counts but not legacy damage or speed", async () => {
  const active = mon("Slowking", "p1"), opponent = mon("Scizor", "p2");
  const state = snapshot(active, opponent);
  state.canonicalEvidence = { version: "ledger@1", facts: [], contributions: [], ambiguities: [], limitations: [] };
  const context = await createEphemeralIntelEvaluationContext();
  context.store.species.scizor = { species: "Scizor", formats: { "[Gen 9] UU": { battlesSeen: 5, leadCount: 1, moves: { "Bullet Punch": 4, "Knock Off": 3 },
    items: { "Choice Band": 2 }, abilities: { Technician: 5 }, teraTypes: { Steel: 2 }, observedDamage: { "Bullet Punch|Slowking": { min: 90, max: 99, count: 1 } },
    observedTakenDamage: {}, observedDamageByContext: {}, observedTakenDamageByContext: {}, speedFirstVs: {}, speedSecondVs: {}, speedFasterThan: { "300|Slowking": 1 }, speedSlowerThan: {} } } } as any;
  const entry = (await buildLocalIntelSnapshot(state, context)).opponents.find((o) => o.species === "Scizor")!;
  assert.ok(entry.battlesSeen >= 5);
  const bp = entry.likelyMoves.find((m) => m.name === "Bullet Punch")!;
  assert.equal(bp.count, 4); assert.equal(bp.source, undefined);
  assert.ok(entry.likelyItems.some((i) => i.name === "Choice Band" && i.count === 2));
  assert.ok(entry.likelyTeraTypes.some((t) => t.name === "Steel" && t.count === 2));
});

test("fainted current targets have no damage, KO coverage or Speed comparison; living replacements retain forecasts", async () => {
  const active = mon("Slowking", "p1"), reserve = { ...mon("Thundurus", "p1"), active: false };
  const opponent = { ...mon("Scizor", "p2", { ability: "Technician" }), knownMoves: ["Bullet Punch"] };
  const state = snapshot(active, opponent);
  state.yourSide.team = [active, reserve];
  state.legalActions = [{ id: "switch:2", kind: "switch", targetSlot: 2, target: "Thundurus", label: "Switch", choice: "switch 2" }];
  const options = { moveCandidates: [{ name: "Bullet Punch", source: "known" as const }] };
  const living = buildThreatPreview(state, options)[0]!;
  const context = await createEphemeralIntelEvaluationContext();
  const livingIntel = await buildLocalIntelSnapshot(state, context);
  for (const condition of [{ fainted: true, hpPercent: 0 }, { fainted: true, hpPercent: null }, { fainted: false, hpPercent: 0 }]) {
    Object.assign(active, condition);
    const resolvedSubjects: string[] = [];
    const threat = buildThreatPreview(state, { ...options, observedThreatResolver: (_move, _attacker, defender) => {
      resolvedSubjects.push(defender.species!);
      return undefined;
    } })[0]!;
    assert.equal(threat.currentTarget.species, "Slowking");
    assert.deepEqual(threat.currentTarget.bands, []);
    assert.equal(threat.currentTarget.observedRange, undefined);
    assert.equal(threat.currentTarget.likelyBandSource, undefined);
    assert.match(threat.currentTarget.summary, /fainted/);
    assert.doesNotMatch(threat.currentTarget.summary, /KOs|\d+.*%/);
    assert.deepEqual(resolvedSubjects, ["Thundurus"]);
    assert.deepEqual(threat.switchTargets, living.switchTargets);
    const intel = await buildLocalIntelSnapshot(state, context);
    assert.equal(intel.speedPreview?.activeRelation, "unknown");
    assert.equal(intel.speedPreview?.yourActiveEffectiveSpeed, undefined);
    assert.deepEqual(intel.speedPreview?.switchMatchups, livingIntel.speedPreview?.switchMatchups.filter((entry) => entry.species !== "Slowking"));
  }
});

test("forced replacements retain damaging reply branches and rank the safer living target", async () => {
  const active = mon("Scizor", "p1");
  const dangerous = { ...mon("Arcanine-Hisui", "p1"), active: false };
  const safer = { ...mon("Slowking", "p1", { nature: "Bold", evs: { hp: 252, def: 252 } }), active: false };
  const opponent = { ...mon("Arcanine-Hisui", "p2", { ability: "Rock Head" }),
    knownMoves: ["Head Smash", "Flare Blitz"] };
  const state = snapshot(active, opponent);
  state.turn = 14;
  state.yourSide.team = [active, dangerous, safer];
  state.legalActions = [dangerous, safer].map((target, index) => ({
    id: `switch:${index + 2}`, kind: "switch", targetSlot: index + 2, target: target.species!, label: `Switch to ${target.species}`
  }));
  const context = await createEphemeralIntelEvaluationContext();
  const living = await buildLocalIntelSnapshot(state, context);
  for (const condition of [{ fainted: true, hpPercent: 0 }, { fainted: true, hpPercent: null }, { fainted: false, hpPercent: 0 }]) {
    Object.assign(active, condition);
    const intel = await buildLocalIntelSnapshot(state, context);
    const prediction = intel.opponentActionPrediction!;
    assert.ok(prediction.classScores!.stayAttack > 0, "living replacement damage must support attacking replies");
    for (const moveName of opponent.knownMoves) {
      assert.ok(prediction.topActions.some((candidate) => candidate.actionClass === "stay_attack" && candidate.moveName === moveName));
      const threat = intel.opponentThreatPreview!.find((entry) => entry.moveName === moveName)!;
      assert.deepEqual(threat.currentTarget.bands, []);
      assert.equal(threat.currentTarget.relation, "unknown");
      assert.equal(threat.currentTarget.observedRange, undefined);
      assert.equal(threat.currentTarget.likelyBandSource, undefined);
      assert.doesNotMatch(threat.currentTarget.summary, /KOs|\d+.*%/);
      assert.deepEqual(threat.switchTargets, living.opponentThreatPreview!.find((entry) => entry.moveName === moveName)!.switchTargets);
    }
    assert.equal(intel.speedPreview!.activeRelation, "unknown");
    assert.equal(intel.speedPreview!.yourActiveEffectiveSpeed, undefined);
    assert.ok(!prediction.topActions.some((candidate) => candidate.reasons.some((reason) => /faster.*KO/i.test(reason))));
    const headSmash = intel.opponentThreatPreview!.find((entry) => entry.moveName === "Head Smash")!;
    assert.equal(likely(headSmash.switchTargets.find((target) => target.species === dangerous.species)!.bands).immediate.ko, "all_rolls");
    assert.equal(likely(headSmash.switchTargets.find((target) => target.species === safer.species)!.bands).immediate.ko, "no_ko");
    const recommendation = intel.selfActionRecommendation!;
    const riskyAction = recommendation.rankedActions.find((action) => action.actionId === "switch:2")!;
    const safeAction = recommendation.rankedActions.find((action) => action.actionId === "switch:3")!;
    assert.equal(recommendation.topActionId, "switch:3");
    assert.ok(safeAction.score > riskyAction.score);
    assert.ok(riskyAction.scoreBreakdown!.some((entry) => entry.key === "search" && entry.value < 0));
    assert.ok(safeAction.scoreBreakdown!.some((entry) => entry.key === "search" && entry.value > 0));
  }
  // Missing identity cannot establish numerical support for an attack.
  Object.assign(dangerous, { species: null, displayName: null, ident: null, ability: null, item: null, types: [], stats: {} });
  safer.fainted = true; safer.hpPercent = 0;
  state.legalActions = [{ ...state.legalActions[0]!, target: null, label: "Unknown replacement" }];
  const unavailable = await buildLocalIntelSnapshot(state, context);
  assert.ok(unavailable.opponentThreatPreview!.every((threat) => threat.switchTargets.every((target) =>
    target.bands.every((band) => band.minPercent === null && band.maxPercent === null))));
  assert.equal(unavailable.opponentActionPrediction!.classScores!.stayAttack, 0);
  assert.ok(!unavailable.opponentActionPrediction!.topActions.some((candidate) => candidate.actionClass === "stay_attack"));

  // No living replacement means there is no supported damaging reply target.
  dangerous.fainted = true; dangerous.hpPercent = 0;
  safer.hpPercent = 0;
  state.legalActions = [];
  const exhausted = await buildLocalIntelSnapshot(state, context);
  assert.ok(exhausted.opponentThreatPreview!.every((threat) => threat.currentTarget.bands.length === 0 && threat.switchTargets.length === 0));
  assert.equal(exhausted.opponentActionPrediction!.classScores!.stayAttack, 0);
  assert.ok(!exhausted.opponentActionPrediction!.topActions.some((candidate) => candidate.actionClass === "stay_attack"));
  assert.equal(exhausted.selfActionRecommendation, undefined);
});

test("living target attack predictions do not substitute replacement forecasts for current damage or immunity", () => {
  const active = mon("Gengar", "p1", { ability: "Cursed Body" });
  const reserve = { ...mon("Arcanine-Hisui", "p1"), active: false };
  const opponent = { ...mon("Donphan", "p2"), knownMoves: ["Earthquake", "Body Slam"] };
  const state = snapshot(active, opponent);
  state.yourSide.team = [active, reserve];
  const threats = buildThreatPreview(state, { moveCandidates: opponent.knownMoves.map((name) => ({ name, source: "known" })) });
  const predict = (opponentThreatPreview: typeof threats) => buildOpponentActionPrediction({ snapshot: state, opponentThreatPreview });
  const prediction = predict(threats)!;
  assert.ok(prediction.topActions.some((candidate) => candidate.moveName === "Earthquake"));
  assert.ok(!prediction.topActions.some((candidate) => candidate.moveName === "Body Slam"));
  assert.deepEqual(prediction, predict(threats.map((threat) => ({ ...threat, switchTargets: [] }))));
  assert.equal(predict(threats.map((threat) => ({ ...threat, currentTarget: { ...threat.currentTarget, bands: [] } })))!.classScores!.stayAttack, 0);
});

test("damage previews never use a fainted attacker or target", () => {
  for (const side of ["yourSide", "opponentSide"] as const) {
    const state = snapshot(mon("Donphan", "p1"), mon("Slowking", "p2"));
    state[side].active!.fainted = true;
    state[side].active!.hpPercent = 0;
    assert.deepEqual(buildDamagePreview(state), []);
    if (side === "opponentSide") assert.deepEqual(buildThreatPreview(state, { moveCandidates: [{ name: "Scald", source: "known" }] }), []);
  }
});

test("resolved damage precedes immunity explanations for offensive Tera, Scrappy and Gravity", () => {
  const attacker = { ...mon("Thundurus", "p1"), teraType: "Ice" };
  const state = snapshot(attacker, mon("Sinistcha", "p2", { ability: "Heatproof" }), "Tera Blast");
  state.legalActions.push({ ...state.legalActions[0]!, id: "move:1|tera=1", label: "Tera + Tera Blast", terastallize: true });
  const preview = buildDamagePreview(state);
  assert.equal(preview[0]!.bands[0]!.outcome, "immune");
  const tera = likely(preview[1]!.bands);
  assert.deepEqual([tera.minPercent, tera.maxPercent], oracle(new Pokemon(gen, "Thundurus", { teraType: "Ice" }), new Pokemon(gen, "Sinistcha", { ability: "Heatproof" }), "Tera Blast"));
  assert.equal(buildSelfActionRecommendation({ snapshot: state, playerDamagePreview: preview, opponentThreatPreview: [] })!.topActionId, "move:1|tera=1");
  const gravity = snapshot(mon("Donphan", "p1"), mon("Gengar", "p2", { ability: "Cursed Body", item: "Air Balloon" }));
  gravity.field.pseudoWeather = ["Gravity"];
  assert.ok(likely(buildDamagePreview(gravity)[0]!.bands).minPercent! > 0);
  const scrappy = snapshot(mon("Flamigo", "p1", { ability: "Scrappy" }), mon("Gengar", "p2"), "Close Combat");
  assert.ok(likely(buildDamagePreview(scrappy)[0]!.bands).minPercent! > 0);
});

test("revealed offensive/defensive Paradox boosts match the calculator; unknown activation retains intervals", () => {
  const attacker = { ...mon("Iron Moth", "p1", { ability: "Quark Drive" }), removedItem: "Booster Energy", paradoxBoostedStat: "spa" as const };
  const defender = mon("Slowking", "p2");
  const active = likely(buildDamagePreview(snapshot(attacker, defender, "Flamethrower"))[0]!.bands);
  assert.deepEqual([active.minPercent, active.maxPercent], oracle(new Pokemon(gen, "Iron Moth", { ability: "Quark Drive", boostedStat: "spa" }), new Pokemon(gen, "Slowking"), "Flamethrower"));
  const inactive = likely(buildDamagePreview(snapshot({ ...attacker, paradoxBoostedStat: null }, defender, "Flamethrower"))[0]!.bands);
  assert.ok(active.minPercent! > inactive.minPercent!);
  const uncertain = { ...attacker }; delete (uncertain as PokemonSnapshot).paradoxBoostedStat;
  const interval = likely(buildDamagePreview(snapshot(uncertain, defender, "Flamethrower"))[0]!.bands);
  assert.equal(interval.minPercent, inactive.minPercent);
  assert.equal(interval.maxPercent, active.maxPercent);
  const hands = { ...mon("Iron Hands", "p2", { ability: "Quark Drive" }), paradoxBoostedStat: "def" as const };
  const protectedBand = likely(buildDamagePreview(snapshot(mon("Donphan", "p1"), hands))[0]!.bands);
  assert.deepEqual([protectedBand.minPercent, protectedBand.maxPercent], oracle(new Pokemon(gen, "Donphan"), new Pokemon(gen, "Iron Hands", { ability: "Quark Drive", boostedStat: "def" }), "Earthquake"));
});

test("Stellar Tera retains the original defensive typing for targeted status", () => {
  const steel = { ...mon("Scizor", "p2"), teraType: "Stellar", terastallized: true };
  const state = snapshot(mon("Salazzle", "p1", { ability: "Oblivious" }), steel, "Toxic");
  assert.equal(buildDamagePreview(state)[0]!.bands[0]!.outcome, "immune");
});

test("top-three posterior consensus cannot erase a represented damaging hypothesis", () => {
  const target = { ...mon("Vaporeon", "p2"), ability: null };
  const posterior: OpponentPosteriorPreview = {
    confidenceTier: "usable", statBands: [], evidenceKinds: ["priors"], evidence: [], usedFallback: false,
    topHypotheses: [0.32, 0.32, 0.32, 0.04].map((weight, index) => ({
      weight, ability: index === 3 ? "Hydration" : "Water Absorb", item: null, teraType: null,
      statArchetype: "bulky_spec", nature: "Serious", evs: { hp: 252 }, support: []
    }))
  };
  const preview = buildDamagePreview(snapshot(mon("Greninja", "p1"), target, "Hydro Pump"), { defenderPosterior: posterior })[0]!;
  assert.equal(preview.bands.length, 3);
  assert.equal(preview.bands.some((band) => band.outcome === "immune"), false);
  assert.equal(preview.likelyBandSource, "posterior");
});

test("living forced pivots distinguish queued, spent and unproved opponent actions", () => {
  const active = { ...mon("Dragapult", "p1"), appearanceId: "p1a-stint", identityStatus: "resolved" as const };
  const reserves = [mon("Blissey", "p1"), mon("Slowking", "p1")].map((entry, index) => ({ ...entry, instanceId: `p1-reserve-${index}`, active: false }));
  const opponent = { ...mon("Donphan", "p2"), appearanceId: "p2a-stint", identityStatus: "resolved" as const, knownMoves: ["Body Press", "Earthquake"] };
  const state = snapshot(active, opponent);
  state.turn = 2;
  state.yourSide.team = [active, ...reserves];
  state.opponentSide.team.push({ ...mon("Scizor", "p2"), active: false });
  state.legalActions = reserves.map((entry, index) => ({ id: `switch:${index + 2}`, kind: "switch", targetSlot: index + 2, targetInstanceId: entry.instanceId, target: entry.species!, label: `Switch to ${entry.species}` }));
  state.rawRequestSummary = { rqid: 4, requestKind: "forced_switch", forceSwitch: [true] };
  const request = (rqid: number, forced = false) => JSON.stringify({ rqid, side: { id: "p1" },
    ...(forced ? { forceSwitch: [true] } : { active: [{ moves: [{ id: "uturn" }] }] }) });
  type Fact = NonNullable<BattleSnapshot["canonicalEvidence"]>["facts"][number];
  const fact = (kind: string, args: string[], side?: "p1" | "p2"): Fact => ({
    id: `fact-${kind}-${args.join(":")}`, kind, args, turn: 2,
    subject: side ? { side, appearanceId: `${side}a-stint` } : {}, references: {},
    ...(kind === "request" ? { requestSlots: [{ side: "p1" as const, appearanceId: "p1a-stint" }] } : {}),
    source: { observationId: "pivot-frame", sequence: 8, lineIndex: 1, channel: kind === "request" ? "private-request" : "protocol" },
    identityStatus: "resolved", supportingFactIds: []
  });
  const start = fact("turn", ["2"]), normal = fact("request", [request(3)]);
  const pivot = fact("move", ["p1a: Dragapult", "U-turn", "p2a: Donphan"], "p1");
  const forced = fact("request", [request(4, true)]);
  const evaluate = (facts?: Fact[]) => {
    state.canonicalEvidence = facts ? { version: "ledger@1", facts, contributions: [], ambiguities: [], limitations: [] } : undefined;
    const prediction = buildOpponentActionPrediction({ snapshot: state,
      opponentThreatPreview: buildThreatPreview(state, { moveCandidates: [{ name: "Body Press", source: "known" }] }) })!;
    return prediction as OpponentActionPrediction & { replyTiming?: { status: string; factIds: string[]; summary: string } };
  };
  assert.equal(evaluate([start, normal, pivot, forced]).replyTiming?.status, "unknown", "ancestry alone does not certify complete capture");
  // A constructed certificate tests the classifier only; source-owned engine
  // production and rejection of incoming claims have separate integration tests.
  state.turnCoverage = { source: "owned_offline_simulator", turn: 2, turnFactId: start.id, requestFactId: forced.id, fromSequence: 8, throughSequence: 8 };
  const queued = evaluate([start, normal, pivot, forced]);
  assert.equal(queued.replyTiming?.status, "pending");
  assert.ok(queued.replyTiming!.factIds.includes(pivot.id));
  assert.ok(weightedOpponentReplies(queued).some(({ candidate }) => candidate.moveName === "Body Press"));
  assert.ok(!queued.topActions.some((candidate) => candidate.actionClass === "switch"));
  assert.ok(queued.topActions.every((candidate) => !candidate.riskFlags.includes("move order is still unclear")),
    "certified queued replies follow the replacement; global Speed uncertainty must not contradict that order");
  const spent = evaluate([start, normal, fact("move", ["p2a: Donphan", "Earthquake", "p1a: Dragapult"], "p2"), pivot, forced]);
  assert.equal(spent.replyTiming?.status, "spent");
  assert.deepEqual(weightedOpponentReplies(spent), []);
  const itemSwitch = evaluate([start, normal, fact("move", ["p2a: Donphan", "Earthquake", "p1a: Dragapult"], "p2"),
    fact("-enditem", ["p1a: Dragapult", "Eject Button"], "p1"), forced]);
  assert.equal(itemSwitch.replyTiming?.status, "spent");
  assert.deepEqual(weightedOpponentReplies(itemSwitch), []);
  assert.deepEqual(weightedOpponentReplies({ ...queued, replyTiming: spent.replyTiming as OpponentActionPrediction["replyTiming"] }), []);
  for (const facts of [undefined, [pivot, forced], [start, pivot, forced],
    [start, normal, fact("switch", ["p2a: Donphan", "Donphan", "100/100"], "p2"), pivot, forced],
    [start, normal, fact("move", ["p2a: Donphan", "Earthquake", "p1a: Dragapult", "[from] ability: Dancer"], "p2"), pivot, forced],
    [start, normal, pivot, fact("upkeep", []), forced],
    [start, normal, fact("move", ["p2a: Donphan", "Instruct", "p1a: Dragapult"], "p2"), pivot, forced],
    [start, normal, fact("cant", ["p2a: Donphan", "slp"], "p2"), pivot, forced]]) {
    state.recentLog = ["Turn 2 started.", "Dragapult used U-turn."];
    const unknown = evaluate(facts);
    assert.equal(unknown.replyTiming?.status, "unknown");
    assert.deepEqual(weightedOpponentReplies(unknown), []);
    assert.match(unknown.riskFlags.join(" "), /timing|unresolved|unknown/i);
    const recommendation = buildSelfActionRecommendation({ snapshot: state,
      opponentThreatPreview: buildThreatPreview(state, { moveCandidates: [{ name: "Body Press", source: "known" }] }),
      opponentActionPrediction: unknown })!;
    assert.ok(recommendation.rankedActions.every((candidate) => candidate.riskFlags[0] === unknown.replyTiming!.summary));
    assert.ok(recommendation.rankedActions.every((candidate) => !candidate.scoreBreakdown?.some((part) => ["prediction", "search"].includes(part.key))),
      "unknown timing must not regain an immediate reply through class defaults");
  }
  state.rawRequestSummary = { rqid: 4, requestKind: "move" };
  assert.equal(evaluate([start, normal, pivot, forced]).replyTiming, undefined);
});


test("native UU Slow Start damage and Speed agree through expiry, re-entry and Skill Swap", () => {
  const regiTeam = `Regigigas @ Leftovers
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
- Thunder Wave`;
  const kingTeam = `Slowking @ Leftovers
Ability: Regenerator
EVs: 252 HP / 252 Def
Serious Nature
- Protect
- Slack Off
- Skill Swap
- Surf`;
  const teams = [regiTeam, kingTeam].map((text) => Teams.import(text)!);
  for (const team of teams) assert.deepEqual(TeamValidator.get("gen9uu").validateTeam(team), null);
  const battle = new Battle({ formatid: "gen9uu" as ConstructorParameters<typeof Battle>[0]["formatid"], seed: "9,4,2,7" });
  try {
    battle.setPlayer("p1", { name: "Player A", team: Teams.pack(teams[0]!) });
    battle.setPlayer("p2", { name: "Player B", team: Teams.pack(teams[1]!) });
    battle.makeChoices("team 12", "team 1");
    const inspect = () => {
      const attacker = battle.sides[0].active[0]!, defender = battle.sides[1].active[0]!;
      const rooms = new Map();
      const roomId = "battle-gen9uu-slow-start-native";
      applyRawFrameToRoomMap(rooms, `>${roomId}\n${battle.log.join("\n")}\n|request|${JSON.stringify(battle.sides[0].activeRequest)}`);
      const state = roomToSnapshot(rooms.get(roomId)) as BattleSnapshot;
      const active = state.yourSide.active!;
      // The protocol supplies activation; the private request supplies raw stats.
      const activeCounter = attacker.ability === "slowstart" && Boolean(attacker.abilityState.counter);
      assert.equal(active.ability!.toLowerCase().replace(/[^a-z]/g, ""), attacker.ability);
      if (attacker.ability === "slowstart") assert.equal(active.slowStartActive, activeCounter);
      assert.equal(effectiveSpeed(9, attacker.storedStats.spe, active, [], state.field), attacker.getStat("spe"));
      state.opponentSide.active!.stats = { hp: defender.maxhp, ...defender.storedStats };
      const previews = buildDamagePreview(state);
      for (const name of ["Body Slam", "Thunderbolt"]) {
        const random = battle.random;
        let rolls: number[];
        try {
          rolls = Array.from({ length: 16 }, (_, index) => {
            battle.random = ((from?: number, to?: number) => { assert.equal(from, 16); assert.equal(to, undefined); return 15 - index; }) as typeof random;
            const move = battle.dex.getActiveMove(name); move.willCrit = false;
            return battle.actions.getDamage(attacker, defender, move, true) as number;
          });
        } finally { battle.random = random; }
        const oracleAttacker = new Pokemon(gen, attacker.species.name, { level: attacker.level, evs: attacker.set.evs, ivs: attacker.set.ivs, nature: attacker.set.nature, ability: battle.dex.abilities.get(attacker.ability).name, abilityOn: activeCounter });
        const oracleDefender = new Pokemon(gen, defender.species.name, { level: defender.level, evs: defender.set.evs, ivs: defender.set.ivs, nature: defender.set.nature, ability: battle.dex.abilities.get(defender.ability).name });
        assert.deepEqual(calculate(gen, oracleAttacker, oracleDefender, new Move(gen, name), new Field()).damage, rolls!, "all sixteen native rolls agree with the stock calculator");
        const expected = [Math.min(...rolls!), Math.max(...rolls!)].map((value) => Number((100 * value / defender.maxhp).toFixed(1)));
        const preview = previews.find((entry) => entry.moveName === name)!;
        assert.ok(preview);
        for (const band of preview.bands) assert.deepEqual([band.minPercent, band.maxPercent], expected, `${name}, turn ${battle.turn}, counter ${attacker.abilityState.counter}`);
      }
      assert.equal(previews.find((entry) => entry.moveName === "Protect")!.bands[0]!.minPercent, null);
      return active;
    };
    for (let turn = 1; turn <= 7; turn++) { inspect(); battle.makeChoices("move 1", "move 1"); }
    battle.makeChoices("switch 2", "move 1");
    battle.makeChoices("switch 2", "move 1");
    assert.equal(inspect().slowStartActive, true);
    battle.makeChoices("move 4", "move 3");
    assert.equal(inspect().ability!.toLowerCase(), "regenerator");
    battle.makeChoices("move 4", "move 3");
    assert.equal(inspect().slowStartActive, true);
  } finally { battle.destroy(); }
});

test("unobserved Slow Start damage is one interval per hypothesis, without branch probability", () => {
  const attacker = { ...mon("Regigigas", "p1", { ability: "Slow Start", nature: "Jolly", evs: { hp: 252, spe: 252 } }), slowStartActive: undefined };
  const target = mon("Slowking", "p2", { evs: { hp: 252, def: 252 } });
  const native = new BattlePokemon(gen, "Regigigas", { ability: "Slow Start", nature: "Jolly", evs: { hp: 252, spe: 252 } });
  applyAbilityState(native, attacker);
  assert.equal(native.clone().clone().abilityActivationUncertain, true);
  const results = calculateDamageScenarios(gen, native.clone().clone(), new Pokemon(gen, "Slowking", { evs: { hp: 252, def: 252 } }), new Move(gen, "Body Slam"), new Field());
  assert.equal(results.length, 2);
  for (const abilityOn of [false, true]) assert.ok(results.some((result) => JSON.stringify(result.damage) === JSON.stringify(calculate(gen,
    new Pokemon(gen, "Regigigas", { ability: "Slow Start", abilityOn, nature: "Jolly", evs: { hp: 252, spe: 252 } }), new Pokemon(gen, "Slowking", { evs: { hp: 252, def: 252 } }), new Move(gen, "Body Slam"), new Field()).damage)));
  const build = (slowStartActive?: boolean, moveName = "Body Slam") => likely(buildDamagePreview(snapshot({ ...attacker, slowStartActive }, target, moveName))[0]!.bands);
  const inactive = build(false), active = build(true), unknown = build();
  assert.equal(unknown.minPercent, active.minPercent);
  assert.equal(unknown.maxPercent, inactive.maxPercent);
  assert.match(unknown.detail!, /activation is unobserved/);
  assert.deepEqual(build(true, "Thunderbolt"), build(false, "Thunderbolt"));
  const posterior: OpponentPosteriorPreview = { confidenceTier: "usable", statBands: [], evidenceKinds: ["priors"], evidence: [], usedFallback: false,
    topHypotheses: [{ weight: 1, ability: "Slow Start", item: null, teraType: null, statArchetype: "fast_phys", nature: "Jolly", evs: { hp: 252, spe: 252 }, support: [] }] };
  const enemy = { ...attacker, ident: "p2: Regigigas", stats: undefined };
  const threats = (slowStartActive?: boolean) => buildThreatPreview(snapshot({ ...target, ident: "p1: Slowking" }, { ...enemy, slowStartActive }), {
    moveCandidates: [{ name: "Body Slam", source: "known" }], attackerPosterior: posterior
  })[0]!.currentTarget.bands;
  const unknownBands = threats(), activeBands = threats(true), inactiveBands = threats(false);
  assert.equal(unknownBands.length, 3);
  for (const band of unknownBands) {
    assert.equal(band.minPercent, activeBands.find((entry) => entry.label === band.label)!.minPercent);
    assert.equal(band.maxPercent, inactiveBands.find((entry) => entry.label === band.label)!.maxPercent);
  }
  assert.equal(posterior.topHypotheses.length, 1);
  assert.equal(posterior.topHypotheses[0]!.weight, 1);
});

test("fresh Slow Start entry changes incoming Gyro Ball and the switch resolver sees that entry state", () => {
  const regigigas = { ...mon("Regigigas", "p1", { ability: "Slow Start", nature: "Jolly", evs: { hp: 252, spe: 252 } }), slowStartActive: false };
  const bronzong = mon("Bronzong", "p2", { ability: "Levitate", evs: { hp: 252, def: 252 } });
  const options = { moveCandidates: [{ name: "Gyro Ball", source: "known" as const }] };
  const current = likely(buildThreatPreview(snapshot(regigigas, bronzong), options)[0]!.currentTarget.bands);
  const oracleFor = (abilityOn: boolean) => oracle(new Pokemon(gen, "Bronzong", { ability: "Levitate", evs: { hp: 252, def: 252 } }),
    new Pokemon(gen, "Regigigas", { ability: "Slow Start", abilityOn, nature: "Jolly", evs: { hp: 252, spe: 252 } }), "Gyro Ball");
  assert.deepEqual([current.minPercent, current.maxPercent], oracleFor(false));
  const state = snapshot(mon("Slowking", "p1"), bronzong);
  const reserve = { ...regigigas, active: false };
  state.yourSide.team.push(reserve);
  const resolvedTargets: PokemonSnapshot[] = [];
  const entering = buildThreatPreview(state, { ...options, observedThreatResolver: (_move, _attacker, defender) => {
    resolvedTargets.push(defender); return undefined;
  } })[0]!.switchTargets.find((target) => target.species === "Regigigas")!;
  const band = likely(entering.bands);
  assert.deepEqual([band.minPercent, band.maxPercent], oracleFor(true));
  assert.ok(band.maxPercent! < current.minPercent!, "Gyro Ball depends on the fresh entry's lower Speed");
  assert.equal(resolvedTargets.find((target) => target.species === "Regigigas")!.slowStartActive, true);
  assert.equal(reserve.slowStartActive, false, "entry forecasting never mutates the captured bench state");

  // The opponent switch predictor must use the same entry state in its native
  // calculator input, even when the captured previous stint had expired.
  const predictive = snapshot({ ...bronzong, ident: "p1: Bronzong" }, mon("Slowking", "p2"), "Gyro Ball");
  predictive.opponentSide.team.push({ ...reserve, ident: "p2: Regigigas" });
  const prediction = buildOpponentActionPrediction({ snapshot: predictive, playerDamagePreview: buildDamagePreview(predictive) })!;
  const candidate = prediction.topSwitchTargets!.find((entry) => entry.switchTargetSpecies === "Regigigas")!;
  assert.ok(candidate);
  const predictedBand = likely(candidate.switchTargetPlayerPreview!.find((entry) => entry.moveName === "Gyro Ball")!.bands);
  assert.deepEqual([predictedBand.minPercent, predictedBand.maxPercent], oracleFor(true));
  assert.equal(predictive.opponentSide.team.find((entry) => entry.species === "Regigigas")!.slowStartActive, false);
});

test("R33 immediate survival separates full Sturdy from raw lethal damage", () => {
 const target = mon("Donphan", "p2", { ability: "Sturdy" });
 const source = mon("Kyogre", "p1", { item: "Choice Specs" });
 const band = likely(buildDamagePreview(snapshot(source, target, "Surf"))[0]!.bands);
 assert.ok(band.minPercent! > 100);
 assert.equal(band.immediate.ko, "no_ko");
 });

test("R33 immediate helper resolves effective protection, HP knowledge and fixed damage", () => {
  const attack = new Pokemon(gen, "Haxorus", { ability: "Mold Breaker", boosts: { atk: 6 } });
  const target = new Pokemon(gen, "Donphan", { ability: "Sturdy" });
  const evaluate = (attacker: Pokemon, defender: Pokemon, hp: number | null, move = "Earthquake") => {
    const result = calculate(gen, attacker, defender, new Move(gen, move));
    return { result, immediate: assessImmediateDamage(result, { currentHp: hp, maxHp: defender.maxHP(), sequence: "single_hit" }) };
  };
  const bypass = evaluate(attack, target, target.maxHP());
  assert.equal(bypass.result.defender.hasAbility("Sturdy"), false);
  assert.equal(bypass.immediate.ko, "all_rolls");
  const shield = target.clone(); shield.item = "Ability Shield" as NonNullable<typeof shield.item>;
  assert.equal(evaluate(attack, shield, shield.maxHP()).immediate.ko, "no_ko");
  const sash = target.clone(); sash.ability = "Sand Veil" as NonNullable<typeof sash.ability>; sash.item = "Focus Sash" as NonNullable<typeof sash.item>;
  const protectedHit = evaluate(attack, sash, sash.maxHP()).immediate;
  assert.equal(protectedHit.ko, "no_ko");
  assert.equal(protectedHit.maxHpLossPercent, (sash.maxHP() - 1) / sash.maxHP() * 100);
  assert.equal(evaluate(attack, sash, sash.maxHP() - 1).immediate.ko, "all_rolls");
  assert.equal(evaluate(attack, sash, null).immediate.ko, "unknown");
  const levelOne = new Pokemon(gen, "Donphan", { level: 1, ability: "Sturdy" });
  const fixed = evaluate(new Pokemon(gen, "Machamp", { ability: "Guts" }), levelOne, levelOne.maxHP(), "Seismic Toss");
  assert.equal(typeof fixed.result.damage, "number"); assert.equal(fixed.immediate.ko, "no_ko");
  assert.equal(assessImmediateDamage(fixed.result, { currentHp: levelOne.maxHP(), maxHp: levelOne.maxHP(), sequence: "unsupported" }).ko, "unknown");
  assert.equal(assessImmediateDamage(bypass.result, { currentHp: 1, maxHp: target.maxHP(), sequence: "single_hit", protectionUncertain: true }).ko, "all_rolls");
});

test("R33 preview keeps protection nuisance unweighted and unsupported sequences unknown", () => {
  const source = mon("Kyogre", "p1", { item: "Choice Specs" });
  const target = { ...mon("Donphan", "p2"), ability: null, item: null };
  const preview = (defender: PokemonSnapshot, move = "Surf", options = {}) => buildDamagePreview(snapshot(source, defender, move), options)[0]!;
  const baseline = preview(target);
  const possible = preview(target, "Surf", { likelyDefenderAbilities: ["Sturdy"] });
  assert.deepEqual(possible.bands.map(({ minPercent, maxPercent }) => [minPercent, maxPercent]), baseline.bands.map(({ minPercent, maxPercent }) => [minPercent, maxPercent]));
  assert.ok(possible.bands.every((band) => band.immediate.ko === "conditional" && Number.isFinite(band.immediate.minHpLossPercent) && Number.isFinite(band.immediate.maxHpLossPercent)));
  assert.ok(preview({ ...target, ability: "Sand Veil", item: "Leftovers" }, "Surf", { likelyDefenderAbilities: ["Sturdy"], likelyDefenderItems: ["Focus Sash"] }).bands.every((band) => band.immediate.ko === "all_rolls"));
  assert.ok(preview({ ...target, removedItem: "Focus Sash", hpPercent: 99, conditionText: "99/100" }, "Surf", { likelyDefenderItems: ["Focus Sash"] }).bands.every((band) => band.immediate.ko === "all_rolls"));
  for (const move of ["Fissure", "Double Hit", "Triple Axel"]) {
    const result = preview({ ...target, ability: "Sturdy" }, move);
    assert.ok(result.bands.every((band) => band.immediate.ko === "unknown" && band.immediate.maxHpLossPercent === null), move);
    assert.ok(result.bands.every((band) => band.outcome !== "immune"), move);
  }
  const unknownHp = preview({ ...target, ability: "Sturdy", hpPercent: null, conditionText: null });
  assert.ok(unknownHp.bands.every((band) => band.immediate.ko === "unknown"));
  const observed = preview({ ...target, ability: "Sturdy" }, "Surf", { observedPlayerDamage: { "Surf|Kyogre": { minPercent: 200, maxPercent: 300, sampleCount: 5, source: "context" } } });
  assert.equal(likely(observed.bands).immediate.ko, "unknown");
  assert.ok(preview({ ...target, item: "Focus Band", hpPercent: 50, conditionText: "50/100" }).bands.every((band) => band.immediate.ko === "conditional" && band.immediate.maxHpLossPercent === null));
  const mold = snapshot(mon("Haxorus", "p1", { ability: "Mold Breaker", boosts: { atk: 6 } }), target);
  mold.yourSide.active!.boosts = { atk: 6 };
  const withoutShield = buildDamagePreview(mold, { likelyDefenderAbilities: ["Sturdy"] })[0]!;
  assert.ok(withoutShield.bands.every((band) => band.immediate.ko === "all_rolls"));
  const withShield = buildDamagePreview(mold, { likelyDefenderAbilities: ["Sturdy"], likelyDefenderItems: ["Ability Shield"] })[0]!;
  assert.ok(withShield.bands.every((band) => band.immediate.ko === "conditional"));
  const incoming = buildThreatPreview(snapshot({ ...target, ident: "p1: Donphan", ability: "Sturdy" }, { ...source, ident: "p2: Kyogre" }), { moveCandidates: [{ name: "Surf", source: "known" }] })[0]!;
  assert.ok(incoming.currentTarget.bands.every((band) => band.immediate.ko === "no_ko"));
});

test("R33 posterior aggregates concrete survival before weighted raw quantiles", () => {
  const source = mon("Kyogre", "p1", { item: "Choice Specs" });
  const target = { ...mon("Donphan", "p2"), ability: null, item: null };
  const posterior: OpponentPosteriorPreview = { confidenceTier: "usable", statBands: [], evidenceKinds: [], evidence: [], usedFallback: false,
    topHypotheses: [
      { ability: "Sand Veil", item: "Leftovers", weight: .9, teraType: null, nature: "Serious", evs: {}, statArchetype: "bulky_phys", support: [] },
      { ability: "Sturdy", item: "Leftovers", weight: .1, teraType: null, nature: "Serious", evs: {}, statArchetype: "bulky_phys", support: [] }
    ] };
  const before = JSON.stringify(posterior);
  const mixed = buildDamagePreview(snapshot(source, target, "Surf"), { defenderPosterior: posterior })[0]!;
  assert.ok(mixed.bands.every((band) => band.immediate.ko === "conditional" && Number.isFinite(band.immediate.minHpLossPercent) && Number.isFinite(band.immediate.maxHpLossPercent)));
  const ordinary = buildDamagePreview(snapshot(source, target, "Surf"), { defenderPosterior: { ...posterior, topHypotheses: posterior.topHypotheses.map((value) => ({ ...value, ability: "Sand Veil" })) } })[0]!;
  assert.deepEqual(mixed.bands.map(({ minPercent, maxPercent }) => [minPercent, maxPercent]), ordinary.bands.map(({ minPercent, maxPercent }) => [minPercent, maxPercent]));
  assert.equal(JSON.stringify(posterior), before);
});

test("R33 protection uses post-entry HP and preserves raw posterior mass across nuisance variants", () => {
  const source = mon("Kyogre", "p2", { item: "Choice Specs" });
  const own = mon("Slowking", "p1");
  const reserve = { ...mon("Donphan", "p1", { ability: "Sturdy", item: "Leftovers" }), active: false };
  reserve.conditionText = `${reserve.stats!.hp}/${reserve.stats!.hp}`;
  const state = snapshot(own, source, "Surf"); state.yourSide.team.push(reserve);
  const assessEntry = () => buildThreatPreview(state, { moveCandidates: [{ name: "Surf", source: "known" }] })[0]!.switchTargets[0]!;
  assert.ok(assessEntry().bands.every((band) => band.immediate.ko === "no_ko"));
  state.field.yourSideConditions = ["Stealth Rock"];
  assert.ok(assessEntry().bands.every((band) => band.immediate.ko === "all_rolls"));
  reserve.item = null;
  assert.ok(assessEntry().bands.every((band) => band.immediate.ko === "unknown"));

  const target = { ...mon("Regigigas", "p2"), ability: null, item: null };
  const posterior: OpponentPosteriorPreview = { confidenceTier: "usable", statBands: [], evidenceKinds: [], evidence: [], usedFallback: false,
    topHypotheses: [
      { ability: "Pressure", item: "Leftovers", weight: .9, teraType: null, nature: "Serious", evs: {}, statArchetype: "bulky_phys", support: [] },
      { ability: "Slow Start", item: "Focus Sash", weight: .1, teraType: null, nature: "Serious", evs: {}, statArchetype: "bulky_phys", support: [] }
    ] };
  const attacker = mon("Kyogre", "p1", { item: "Choice Specs", boosts: { spa: 6 } }); attacker.boosts = { spa: 6 };
  const original = JSON.stringify(posterior);
  const mixed = buildDamagePreview(snapshot(attacker, target, "Surf"), { defenderPosterior: posterior })[0]!;
  const noActivationVariants = buildDamagePreview(snapshot(attacker, target, "Surf"), { defenderPosterior: { ...posterior, topHypotheses: posterior.topHypotheses.map((value) => ({ ...value, ability: "Pressure" })) } })[0]!;
  assert.ok(mixed.bands.every((band) => band.immediate.ko === "conditional"));
  assert.deepEqual(mixed.bands.map(({ minPercent, maxPercent }) => [minPercent, maxPercent]), noActivationVariants.bands.map(({ minPercent, maxPercent }) => [minPercent, maxPercent]));
  assert.match(mixed.bands[0]!.detail!, /active and inactive/);
  assert.equal(JSON.stringify(posterior), original);
});

test("R33 effective ability resolver and rounded HP preserve only supported claims", () => {
  const defender = new Pokemon(gen, "Donphan", { ability: "Sturdy" });
  for (const ability of ["Teravolt", "Turboblaze"] as const) {
    const result = calculate(gen, new Pokemon(gen, "Haxorus", { ability, boosts: { atk: 6 } }), defender, new Move(gen, "Earthquake"));
    assert.equal(result.defender.hasAbility("Sturdy"), false, ability);
    assert.equal(assessImmediateDamage(result, { currentHp: defender.maxHP(), maxHp: defender.maxHP(), sequence: "single_hit" }).ko, "all_rolls");
  }
  const ignoreMove = calculate(gen, new Pokemon(gen, "Solgaleo", { boosts: { atk: 6 } }), defender, new Move(gen, "Sunsteel Strike"));
  assert.equal(ignoreMove.defender.hasAbility("Sturdy"), false);
  assert.equal(assessImmediateDamage(ignoreMove, { currentHp: defender.maxHP(), maxHp: defender.maxHP(), sequence: "single_hit" }).ko, "all_rolls");
  const partial = calculate(gen, new Pokemon(gen, "Haxorus", { ability: "Rivalry" }), defender, new Move(gen, "Earthquake"));
  const [min, max] = partial.range();
  assert.ok(min < max);
  assert.equal(assessImmediateDamage(partial, { currentHp: max, maxHp: defender.maxHP(), sequence: "single_hit" }).ko, "some_rolls");
  const rounded = assessImmediateDamage(partial, { currentHp: null, maxHp: defender.maxHP(), currentHpRange: { min, max }, sequence: "single_hit" });
  assert.equal(rounded.ko, "conditional");
  const fullTarget = { ...mon("Donphan", "p2", { ability: "Sturdy" }), stats: undefined };
  const source = mon("Kyogre", "p1", { item: "Choice Specs" });
  assert.ok(buildDamagePreview(snapshot(source, fullTarget, "Surf"))[0]!.bands.every((band) => band.immediate.ko === "no_ko"));
  const nonfull = { ...fullTarget, hpPercent: 99, conditionText: "99/100" };
  assert.ok(buildDamagePreview(snapshot(source, nonfull, "Surf"))[0]!.bands.every((band) => band.immediate.ko === "all_rolls"));
});

test("R34 conditional survival retains supported HP-loss bounds without inventing an expectation", () => {
  const source = mon("Kyogre", "p1", { item: "Choice Specs" });
  const target = { ...mon("Donphan", "p2"), ability: null, item: null };
  const state = snapshot(source, target, "Surf");
  const baseline = buildDamagePreview(state)[0]!;
  const protectedState = snapshot(source, { ...target, ability: "Sturdy" }, "Surf");
  const protectedPreview = buildDamagePreview(protectedState)[0]!;
  const mixed = buildDamagePreview(state, { likelyDefenderAbilities: ["Sturdy"] })[0]!;
  for (const [index, band] of mixed.bands.entries()) {
    assert.equal(band.immediate.ko, "conditional");
    assert.equal(band.immediate.minHpLossPercent, Math.min(baseline.bands[index]!.immediate.minHpLossPercent!, protectedPreview.bands[index]!.immediate.minHpLossPercent!));
    assert.equal(band.immediate.maxHpLossPercent, Math.max(baseline.bands[index]!.immediate.maxHpLossPercent!, protectedPreview.bands[index]!.immediate.maxHpLossPercent!));
    assert.deepEqual([band.minPercent, band.maxPercent], [baseline.bands[index]!.minPercent, baseline.bands[index]!.maxPercent]);
  }
  const posterior: OpponentPosteriorPreview = { confidenceTier: "usable", statBands: [], evidenceKinds: [], evidence: [], usedFallback: false,
    topHypotheses: [
      { ability: "Sand Veil", item: "Leftovers", weight: .9, teraType: null, nature: "Serious", evs: {}, statArchetype: "bulky_phys", support: [] },
      { ability: "Sturdy", item: "Leftovers", weight: .1, teraType: null, nature: "Serious", evs: {}, statArchetype: "bulky_phys", support: [] }
    ] };
  const before = JSON.stringify(posterior);
  const weighted = buildDamagePreview(state, { defenderPosterior: posterior })[0]!;
  for (const band of weighted.bands) {
    assert.equal(band.immediate.ko, "conditional");
    assert.equal(band.immediate.minHpLossPercent, (target.stats!.hp! - 1) / target.stats!.hp! * 100);
    assert.equal(band.immediate.maxHpLossPercent, 100);
  }
  assert.equal(JSON.stringify(posterior), before);
  const nuisanceSource = mon("Regigigas", "p1", { ability: "Slow Start" });
  const nuisanceTarget = mon("Slowbro", "p2");
  const nuisance = (active: boolean | undefined) => buildDamagePreview(snapshot({ ...nuisanceSource, slowStartActive: active }, nuisanceTarget, "Body Slam"))[0]!;
  const inactive = nuisance(false), active = nuisance(true), unresolved = nuisance(undefined);
  for (const [index, band] of unresolved.bands.entries()) {
    assert.equal(band.immediate.minHpLossPercent, Math.min(active.bands[index]!.immediate.minHpLossPercent!, inactive.bands[index]!.immediate.minHpLossPercent!));
    assert.equal(band.immediate.maxHpLossPercent, Math.max(active.bands[index]!.immediate.maxHpLossPercent!, inactive.bands[index]!.immediate.maxHpLossPercent!));
  }
  assert.notEqual(unresolved.bands[0]!.immediate.minHpLossPercent, unresolved.bands[0]!.immediate.maxHpLossPercent);
  for (const unsupported of [
    buildDamagePreview(snapshot(source, { ...target, hpPercent: null, conditionText: null }, "Surf"))[0]!,
    buildDamagePreview(snapshot(source, target, "Double Hit"))[0]!
  ]) assert.ok(unsupported.bands.every((band) => band.immediate.ko === "unknown" && band.immediate.minHpLossPercent === null && band.immediate.maxHpLossPercent === null));
});

// Matters: a Choice Band Metagross Earthquake can take 74.9% of Scizor while an item-blind "high" says ~50%.
// With the attacker's item unknown, "high" must assume the strongest live likely offensive item and say which.
test("unknown-item threat high band assumes the strongest live likely offensive item and is labelled", () => {
  const scizor = mon("Scizor", "p1", { nature: "Adamant", evs: { hp: 40, atk: 252, spe: 216 }, ability: "Technician", item: "Heavy-Duty Boots" });
  const metagross = { ...mon("Metagross", "p2"), item: null, ability: null, stats: undefined };
  const threat = (attacker: PokemonSnapshot, likelyAttackerItems?: string[]) => buildThreatPreview(snapshot(scizor, attacker),
    { moveCandidates: [{ name: "Earthquake", source: "known" }], ...(likelyAttackerItems ? { likelyAttackerItems } : {}) })[0]!.currentTarget.bands;
  const base = threat(metagross), banded = threat(metagross, ["Choice Band", "Leftovers"]);
  const high = banded.find((band) => band.label === "high")!;
  assert.ok(high.maxPercent! >= 74, JSON.stringify(high));
  assert.match(high.detail ?? "", /high assumes Choice Band/i);
  assert.deepEqual(likely(banded), likely(base), "only the high band takes the item assumption");
  assert.ok(threat({ ...metagross, item: "Leftovers" }, ["Choice Band"]).find((band) => band.label === "high")!.maxPercent! < 74, "a revealed item is never replaced");
  const twoMoves = { ...metagross, instanceId: "battle:p2:metagross", appearanceMoves: ["Earthquake", "Knock Off"] };
  assert.ok(threat(twoMoves, ["Choice Band"]).find((band) => band.label === "high")!.maxPercent! < 74, "two moves this stint rule out a Choice item");
});

async function metagrossPrior() {
  const { createHash } = await import("node:crypto");
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const bytes = Buffer.from(JSON.stringify({ info: { metagame: "gen9uu", cutoff: 1500, "team type": null }, data: { Metagross: { "Raw count": 4000, Abilities: { clearbody: 100 },
    Items: { choiceband: 30, assaultvest: 19, leftovers: 14 }, "Tera Types": { steel: 50, ground: 50 }, Moves: { earthquake: 90, knockoff: 85, bulletpunch: 70, psychicfangs: 60 } } } }));
  return parseMetaMovePrior(bytes, { url: "https://www.smogon.com/stats/2026-09/chaos/gen9uu-1500.json", period: "2026-09", formatId: "gen9uu", ratingCutoff: 1500, sha256: createHash("sha256").update(bytes).digest("hex") });
}

// Matters: a Metagross (Choice Band 30% on the ladder) that used only Earthquake this stint is likely to repeat it.
// One move used this stint with a possible Choice item means the repeat is the most likely reply, not its best coverage.
test("one move this stint with a possible Choice item boosts repeating that move", async () => {
  const prior = await metagrossPrior(), slowking = mon("Slowking", "p1", { item: "Heavy-Duty Boots", ability: "Regenerator" });
  const metagross = (appearanceMoves: string[]) => ({ ...mon("Metagross", "p2"), item: null, ability: null, stats: undefined, instanceId: "battle-gen9uu-calc-contract:p2:metagross",
    appearanceMoves, knownMoves: ["Earthquake", "Knock Off"] });
  const predict = async (appearanceMoves: string[], withPrior = true) => {
    const intel = await buildLocalIntelSnapshot(snapshot(slowking, metagross(appearanceMoves), "Scald"), await createEphemeralIntelEvaluationContext(withPrior ? prior : undefined));
    return intel.opponentActionPrediction!.topActions.find((action) => action.moveName === "Earthquake")!;
  };
  const locked = await predict(["Earthquake"]), unlocked = await predict(["Earthquake", "Knock Off"]), noChoice = await predict(["Earthquake"], false);
  assert.ok(locked.reasons.some((reason) => /Choice-locked into Earthquake/.test(reason)), JSON.stringify(locked));
  assert.ok(!unlocked.reasons.some((reason) => /Choice-locked/.test(reason)), "two moves this stint rule out a Choice lock");
  assert.ok(!noChoice.reasons.some((reason) => /Choice-locked/.test(reason)), "no evidence a Choice item is possible");
  assert.ok(locked.score > unlocked.score && locked.score > noChoice.score);
});

// Matters: a "you move first" verdict is wrong against Bullet Punch or Aqua Jet; the speed data must carry the caveat.
test("speed verdict data carries a priority caveat when the opponent's likely moves include priority", async () => {
  const you = mon("Thundurus", "p1", { item: "Heavy-Duty Boots", ability: "Prankster" });
  const scizor = { ...mon("Scizor", "p2"), item: null, ability: null, stats: undefined, knownMoves: ["U-turn", "Bullet Punch"] };
  const intel = await buildLocalIntelSnapshot(snapshot(you, scizor, "Thunderbolt"), await createEphemeralIntelEvaluationContext());
  assert.deepEqual(intel.speedPreview!.priorityMoves, ["Bullet Punch"]);
  assert.match(intel.speedPreview!.activeSummary ?? "", /Priority possible: Bullet Punch/);
  const plain = await buildLocalIntelSnapshot(snapshot(you, { ...scizor, knownMoves: ["U-turn"] }, "Thunderbolt"), await createEphemeralIntelEvaluationContext());
  assert.equal(plain.speedPreview!.priorityMoves, undefined);
});

// Matters: your own Choice Scarf is applied exactly (459 shown), so listing it as a confounder mislabels a clean verdict
// as "confounded" and hides the real reason on the strip.
test("your exactly-applied Choice Scarf is not a speed confounder", async () => {
  const arcanine = mon("Arcanine-Hisui", "p1", { item: "Choice Scarf", ability: "Rock Head", nature: "Jolly", evs: { spe: 252 } });
  const intel = await buildLocalIntelSnapshot(snapshot(arcanine, { ...mon("Hydreigon", "p2"), item: null, ability: null, stats: undefined }, "Flare Blitz"), await createEphemeralIntelEvaluationContext());
  assert.equal(intel.speedPreview!.yourActiveEffectiveSpeed, 459);
  assert.ok(!intel.speedPreview!.confounders.some((entry) => /your Choice Scarf/.test(entry)), JSON.stringify(intel.speedPreview!.confounders));
  assert.notEqual(intel.speedPreview!.reason, "confounded");
});

// Matters: an observed "likely" band of 74.9% beside a calc "high" of 50% (Metagross into Scizor) reads as
// if the worst case were milder than the expected case; the high band must never sit below likely.
test("the high band is raised to at least the observed likely band", () => {
  const state = snapshot(mon("Scizor", "p1", { item: "Heavy-Duty Boots", ability: "Technician" }), { ...mon("Metagross", "p2"), item: null, ability: null, stats: undefined });
  const bands = buildThreatPreview(state, { moveCandidates: [{ name: "Earthquake", source: "known" }],
    observedThreatResolver: () => ({ minPercent: 70, maxPercent: 74.9, sampleCount: 1, source: "context" }) })[0]!.currentTarget.bands;
  const likelyBand = bands.find((band) => band.label === "likely")!, high = bands.find((band) => band.label === "high")!;
  assert.equal(likelyBand.maxPercent, 74.9);
  assert.ok(high.maxPercent! >= likelyBand.maxPercent! && high.minPercent! >= likelyBand.minPercent!, JSON.stringify(bands));
});

// Matters: the strip showed Head Smash into an intact Disguise as "74–87% · may KO", Volt
// Switch into Volt Absorb Thundurus-T as 32–38% and Scald into Water Absorb Volcanion as 23–27%: the only ability each
// species can have was treated as unknown until revealed. A species' sole possible ability is known; a choice is not,
// and an unresolved identity (possible Illusion) assumes nothing.
test("a species' only possible ability counts as known before it is revealed", () => {
  const unrevealed = (species: string, extra: Partial<PokemonSnapshot> = {}) => ({ ...mon(species, "p2"), ability: null, item: null, stats: undefined, identityStatus: "resolved" as const, ...extra });
  const arcanine = mon("Arcanine-Hisui", "p1", { ability: "Rock Head", item: "Choice Scarf", nature: "Jolly", evs: { atk: 252, spe: 252 } });
  const smash = buildDamagePreview(snapshot(arcanine, unrevealed("Mimikyu", { hpPercent: 56, conditionText: "56/100" }), "Head Smash"))[0]!;
  assert.ok(smash.bands.every((band) => band.immediate.ko === "no_ko"), JSON.stringify(smash.bands));
  assert.match(likely(smash.bands).immediate.note ?? "", /Disguise absorbs/);
  assert.equal(buildDamagePreview(snapshot(mon("Thundurus", "p1", { ability: "Prankster" }), unrevealed("Thundurus-Therian"), "Volt Switch"))[0]!.bands[0]!.outcome, "immune");
  assert.equal(buildDamagePreview(snapshot(mon("Slowking", "p1", { ability: "Regenerator" }), unrevealed("Volcanion"), "Scald"))[0]!.bands[0]!.outcome, "immune");
  assert.ok(likely(buildDamagePreview(snapshot(mon("Thundurus", "p1", { ability: "Prankster" }), unrevealed("Lanturn"), "Volt Switch"))[0]!.bands).maxPercent! > 0,
    "Lanturn may have Illuminate: a choice of abilities stays unknown");
  const illusion = buildDamagePreview(snapshot(arcanine, unrevealed("Mimikyu", { identityStatus: "provisional", hpPercent: 56, conditionText: "56/100" }), "Head Smash"))[0]!;
  assert.ok(!illusion.bands.some((band) => /Disguise absorbs/.test(band.immediate.note ?? "")), "an unresolved identity assumes no ability");
});

// Matters: Knock Off does 1.5x into a held item. The game showed 15–18% (high 21–25%) for Thundurus's Knock Off into a
// Thundurus-T whose Boots were unrevealed; it did 34%. An unknown item is assumed held unless one was removed.
test("Knock Off assumes an unrevealed item is held unless one was removed", () => {
  const thundurus = mon("Thundurus", "p1", { ability: "Prankster", nature: "Timid", evs: { spa: 252, spe: 252 } });
  const target = { ...mon("Thundurus-Therian", "p2"), ability: null, item: null, stats: undefined };
  const knock = (defender: PokemonSnapshot, options = {}) => likely(buildDamagePreview(snapshot(thundurus, defender, "Knock Off"), options)[0]!.bands);
  const unknown = knock(target), removed = knock({ ...target, removedItem: "Heavy-Duty Boots" }), revealed = knock({ ...target, item: "Heavy-Duty Boots" });
  assert.deepEqual([unknown.minPercent, unknown.maxPercent], [revealed.minPercent, revealed.maxPercent], "unknown item = held item");
  assert.ok(Math.abs(unknown.maxPercent! / removed.maxPercent! - 1.5) < 0.05, JSON.stringify({ unknown, removed }));
  const likelyBoots = knock(target, { likelyDefenderItems: ["Heavy-Duty Boots"] });
  assert.deepEqual([likelyBoots.minPercent, likelyBoots.maxPercent], [revealed.minPercent, revealed.maxPercent]);
  assert.deepEqual(likely(buildDamagePreview(snapshot(thundurus, target, "Thunderbolt"))[0]!.bands), likely(buildDamagePreview(snapshot(thundurus, { ...target, removedItem: "Heavy-Duty Boots" }, "Thunderbolt"))[0]!.bands),
    "only Knock Off takes the held-item assumption");
});

async function mimikyuPrior() {
  const { createHash } = await import("node:crypto");
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const bytes = Buffer.from(JSON.stringify({ info: { metagame: "gen9uu", cutoff: 1500, "team type": null }, data: { Mimikyu: { "Raw count": 5000, Abilities: { disguise: 100 },
    Items: { lifeorb: 47, redcard: 42, choiceband: 2 }, "Tera Types": { ghost: 60, fairy: 40 },
    Spreads: { "Jolly:0/252/0/0/4/252": 56, "Jolly:4/252/0/0/0/252": 16, "Brave:252/252/0/0/4/0": 5, "Adamant:0/252/4/0/0/252": 2, "Careful:252/0/4/0/252/0": 21 },
    Moves: { shadowsneak: 89, playrough: 80, shadowclaw: 70, swordsdance: 60, drainpunch: 40 } } } }));
  return parseMetaMovePrior(bytes, { url: "https://www.smogon.com/stats/2026-09/chaos/gen9uu-1500.json", period: "2026-09", formatId: "gen9uu", ratingCutoff: 1500, sha256: createHash("sha256").update(bytes).digest("hex") });
}

// Matters: the opponent's "likely" attacker was a generic 128-EV neutral no-item profile, so Mimikyu's Shadow Claw showed
// 37–44% on Slowking and did 66%; the ladder had Jolly 252 Atk on ~74% of spreads and Life Orb at 47%.
// The likely band uses the ladder's modal spread and live-plausible modal item; a revealed item overrides the ladder.
test("opponent likely band uses the ladder's modal attacking spread and item; a revealed item overrides", async () => {
  const prior = await mimikyuPrior(), context = await createEphemeralIntelEvaluationContext(prior);
  const slowking = mon("Slowking", "p1", { ability: "Regenerator", item: "Heavy-Duty Boots", nature: "Bold", evs: { hp: 252, def: 252, spd: 4 } });
  const mimikyu = { ...mon("Mimikyu-Busted", "p2"), ability: "Disguise", item: null, stats: undefined, knownMoves: ["Shadow Claw"], identityStatus: "resolved" as const };
  const band = async (attacker: PokemonSnapshot, ctx = context) => likely((await buildLocalIntelSnapshot(snapshot(slowking, attacker, "Scald"), ctx))
    .opponentThreatPreview!.find((p) => p.moveName === "Shadow Claw")!.currentTarget.bands);
  const expected = (item?: string) => oracle(new Pokemon(gen, "Mimikyu-Busted", { nature: "Jolly", evs: { atk: 252 }, ...(item ? { item } : {}) }),
    new Pokemon(gen, "Slowking", { ability: "Regenerator", item: "Heavy-Duty Boots", nature: "Bold", evs: { hp: 252, def: 252, spd: 4 } }), "Shadow Claw");
  const ladder = await band(mimikyu);
  assert.deepEqual([ladder.minPercent, ladder.maxPercent], expected("Life Orb"), JSON.stringify(ladder));
  const revealed = await band({ ...mimikyu, item: "Red Card" });
  assert.deepEqual([revealed.minPercent, revealed.maxPercent], expected(), "a revealed item replaces the ladder's");
  const generic = await band(mimikyu, await createEphemeralIntelEvaluationContext());
  assert.ok(generic.maxPercent! < ladder.maxPercent!, "without priors the generic profile stays");
});

// Matters: priors are keyed by species ID and "mimikyubusted" has no ladder entry, so a broken Disguise dropped every
// Mimikyu prior and Shadow Sneak vanished from the threats and the speed line just before it KO'd Arcanine.
// A battle-only forme reads its starting forme's ladder data; a separate ladder forme (Thundurus-T) keeps its own.
test("a battle-only forme change keeps the base forme's ladder priors", async () => {
  const { priorSpeciesId, metaSetPriorEntries } = await import("../history/metaPriorStore.js");
  const prior = await mimikyuPrior(), context = await createEphemeralIntelEvaluationContext(prior);
  const arcanine = mon("Arcanine-Hisui", "p1", { ability: "Rock Head", item: "Choice Scarf", nature: "Jolly", evs: { atk: 252, spe: 252 } });
  const intel = async (species: string) => buildLocalIntelSnapshot(snapshot(arcanine, { ...mon(species, "p2"), ability: "Disguise", item: "Life Orb", stats: undefined, knownMoves: ["Shadow Claw"] }, "Head Smash"), context);
  for (const species of ["Mimikyu", "Mimikyu-Busted"]) {
    const value = await intel(species);
    assert.equal(value.opponents[0]!.metaMovePrior!.status, "unrevealed_slots", species);
    assert.deepEqual(value.speedPreview!.priorityMoves, ["Shadow Sneak"], species);
    assert.ok(value.opponentThreatPreview!.some((threat) => threat.moveName === "Shadow Sneak"), species);
  }
  assert.equal(metaSetPriorEntries(prior, "[Gen 9] UU", "Mimikyu-Busted", "items")[0]!.name, "Life Orb");
  assert.equal(priorSpeciesId("Eiscue-Noice"), "eiscue"); assert.equal(priorSpeciesId("Thundurus-Therian"), "thundurustherian");
});

// Matters: Gengar's posterior once put 0.19 on Eviolite (no effect on a fully evolved Pokémon) and
// weighed items Gengar never runs on the ladder, because the candidates were a fixed generic list with a flat prior.
// Candidates must have an effect for the species, and with ladder data they are the ladder's items at its shares.
test("posterior item candidates have an effect for the species and follow the ladder's items and shares", async () => {
  const { buildOpponentPosterior } = await import("../inference/posterior.js");
  const { createHash } = await import("node:crypto");
  const { parseMetaMovePrior } = await import("../history/metaPriorStore.js");
  const stats = { observedBattlesSeen: 0, observedMoves: {}, observedItems: {}, observedAbilities: {}, observedTeraTypes: {}, curatedMoves: {}, curatedItems: {}, curatedAbilities: {}, curatedTeraTypes: {} };
  const unrevealed = (species: string) => ({ ...mon(species, "p2"), ability: null, item: null, stats: undefined, knownMoves: [] as string[] });
  // Even when stored history names it (a mislabelled record), an item with no effect for the species is no candidate.
  const items = (species: string) => new Set(buildOpponentPosterior({ format: "[Gen 9] UU", opponent: { ...unrevealed(species), knownMoves: ["Shadow Ball"] },
    formatStats: { ...stats, observedBattlesSeen: 3, observedItems: { Eviolite: 3 } } })!.topHypotheses.map((h) => h.item));
  assert.ok(items("Haunter").has("Eviolite"), "not fully evolved: Eviolite stays a candidate");
  assert.ok(!items("Gengar").has("Eviolite"), "fully evolved: Eviolite does nothing");
  const bytes = Buffer.from(JSON.stringify({ info: { metagame: "gen9uu", cutoff: 1500, "team type": null }, data: { Gengar: { "Raw count": 5000, Abilities: { cursedbody: 100 },
    Items: { choicespecs: 39, focussash: 30, lifeorb: 11, choicescarf: 9, airballoon: 6 }, "Tera Types": { ghost: 50, fairy: 50 }, Spreads: { "Timid:0/0/0/252/4/252": 90 },
    Moves: { shadowball: 99, sludgewave: 80, focusblast: 60, nastyplot: 50 } } } }));
  const prior = parseMetaMovePrior(bytes, { url: "https://www.smogon.com/stats/2026-09/chaos/gen9uu-1500.json", period: "2026-09", formatId: "gen9uu", ratingCutoff: 1500, sha256: createHash("sha256").update(bytes).digest("hex") });
  const gengar = { ...unrevealed("Gengar"), knownMoves: ["Shadow Ball"] };
  const intel = await buildLocalIntelSnapshot(snapshot(mon("Slowking", "p1", { ability: "Regenerator" }), gengar, "Scald"), await createEphemeralIntelEvaluationContext(prior));
  const posterior = intel.opponents[0]!.posterior!;
  const ladder = ["Choice Specs", "Focus Sash", "Life Orb", "Choice Scarf", "Air Balloon"];
  assert.ok(posterior.topHypotheses.every((h) => ladder.includes(h.item!)), JSON.stringify(posterior.topHypotheses.map((h) => h.item)));
  const mass = (item: string) => posterior.topHypotheses.filter((h) => h.item === item).reduce((sum, h) => sum + h.weight, 0);
  assert.ok(mass("Choice Specs") > mass("Air Balloon"), "the ladder's shares are the item prior");
});
