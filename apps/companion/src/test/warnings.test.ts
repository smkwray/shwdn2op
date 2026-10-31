import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { parseMetaMovePrior } from "../history/metaPriorStore.js";
import { buildLocalIntelSnapshot, createEphemeralIntelEvaluationContext } from "../history/opponentIntelStore.js";
import { buildOpponentPosterior } from "../inference/posterior.js";
import { computeTacticalGuards, fitShort, SHORT_MAX, type TacticalGuard } from "../battle-agent/tacticalGuards.js";
import { adviceGuards } from "../battle-agent/liveMetamon.js";
import type { DecisionEnvelope } from "../battle-agent/battleAgent.js";
import type { BattleSnapshot, LegalAction, PokemonSnapshot } from "../types.js";

// Tactical warnings: warnings only, never a changed pick; each one line
// (≤ SHORT_MAX characters, the full fact a tooltip); derived from the engine's Speed/damage calcs, the type chart and ladder
// priors with no species, move or matchup special case. Every warning is exercised on two unrelated teams.

const mon = (species: string, side: "p1" | "p2", extra: Partial<PokemonSnapshot> = {}): PokemonSnapshot => ({
  ident: `${side}: ${species}`, instanceId: `${side}:${species}`, species, displayName: species, level: 100, conditionText: null, hpPercent: 100, status: null,
  fainted: false, active: false, revealed: true, boosts: {}, knownMoves: [], item: null, removedItem: null, ability: null, types: [], teraType: null,
  terastallized: false, identityStatus: "resolved", ...extra
} as PokemonSnapshot);
const moveAction = (slot: number, moveName: string, disabled = false): LegalAction => ({ id: `move:${slot}|tera=0`, kind: "move", label: moveName, moveName, moveSlot: slot,
  choice: `move ${slot}`, disabled, legality: disabled ? "disabled" : "certain" });
const switchAction = (slot: number, target: PokemonSnapshot): LegalAction => ({ id: `switch:${slot}`, kind: "switch", label: `Switch to ${target.species}`, targetSlot: slot,
  targetInstanceId: target.instanceId, choice: `switch ${slot}`, legality: "certain" });

function battle(you: PokemonSnapshot[], them: PokemonSnapshot[], actions: LegalAction[]): BattleSnapshot {
  return { version: "0.1.0", capturedAt: new Date(0).toISOString(), roomId: "battle-gen9uu-warnings", title: "warnings", format: "[Gen 9] UU", turn: 30, phase: "turn",
    yourSide: { slot: "p1", name: "You", active: you.find((entry) => entry.active)!, team: you },
    opponentSide: { slot: "p2", name: "Them", active: them.find((entry) => entry.active)!, team: them },
    field: { weather: null, terrain: null, pseudoWeather: [], yourSideConditions: [], opponentSideConditions: [] },
    legalActions: actions, recentLog: [], rawRequestSummary: { requestKind: "move" }, pendingAttacks: [] } as unknown as BattleSnapshot;
}

/** Synthetic monthly ladder data in Smogon's chaos format (ids as keys, raw weights). */
async function context(data: Record<string, { items: Record<string, number>; teras: Record<string, number>; moves: Record<string, number>; spread: string; abilities: Record<string, number> }>) {
  const bytes = Buffer.from(JSON.stringify({ info: { metagame: "gen9uu", cutoff: 1500, "team type": null }, data: Object.fromEntries(Object.entries(data).map(([species, entry]) =>
    [species, { "Raw count": 4000, Abilities: entry.abilities, Items: entry.items, "Tera Types": entry.teras, Spreads: { [entry.spread]: 100 }, Moves: entry.moves }])) }));
  return createEphemeralIntelEvaluationContext(parseMetaMovePrior(bytes, { url: "https://www.smogon.com/stats/2026-09/chaos/gen9uu-1500.json", period: "2026-09",
    formatId: "gen9uu", ratingCutoff: 1500, sha256: createHash("sha256").update(bytes).digest("hex") }));
}
async function envelope(snapshot: BattleSnapshot, ctx: Awaited<ReturnType<typeof context>>): Promise<DecisionEnvelope> {
  const localIntel = await buildLocalIntelSnapshot(snapshot, ctx);
  return { semantic: { snapshot, localIntel, capabilities: { status: "supported", limitations: [] } } } as unknown as DecisionEnvelope;
}
const kind = (guards: TacticalGuard[], name: string) => guards.filter((guard) => guard.kind === name);

// Fixture A: Scarf Arcanine-Hisui is locked into Flare Blitz against Cobalion (51%), whose
// Body Press is a two-hit threat; paralysed Serperior waits behind; Donphan and Slowking are too slow and too hurt for it.
const ladderA = {
  Cobalion: { items: { leftovers: 60, choicescarf: 5 }, teras: { water: 31, steel: 27, ghost: 20, fairy: 7, normal: 15 }, abilities: { justified: 100 },
    moves: { bodypress: 90, voltswitch: 80, stealthrock: 70, thunderwave: 60 }, spread: "Bold:252/0/252/0/4/0" },
  Serperior: { items: { heavydutyboots: 50, leftovers: 50 }, teras: { grass: 40, fire: 30, water: 30 }, abilities: { contrary: 100 },
    moves: { leafstorm: 95, glare: 80, dragonpulse: 50, synthesis: 40 }, spread: "Timid:0/0/0/252/4/252" }
};
function fixtureA() {
  const arcanine = mon("Arcanine-Hisui", "p1", { active: true, item: "Choice Scarf", ability: "Rock Head", types: ["Fire", "Rock"], teraType: "Fire",
    stats: { hp: 331, atk: 329, def: 196, spa: 203, spd: 197, spe: 306 }, knownMoves: ["Flare Blitz", "Head Smash", "Close Combat", "Extreme Speed"], appearanceMoves: ["Flare Blitz"] });
  const donphan = mon("Donphan", "p1", { hpPercent: 50.7, item: "Heavy-Duty Boots", ability: "Sturdy", types: ["Ground"], teraType: "Ghost",
    stats: { hp: 383, atk: 280, def: 370, spa: 140, spd: 156, spe: 136 }, knownMoves: ["Earthquake", "Rapid Spin", "Stealth Rock", "Knock Off"] });
  const slowking = mon("Slowking", "p1", { hpPercent: 52.5, item: "Heavy-Duty Boots", ability: "Regenerator", types: ["Water", "Psychic"], teraType: "Fairy",
    stats: { hp: 394, atk: 155, def: 256, spa: 236, spd: 286, spe: 58 }, knownMoves: ["Scald", "Future Sight", "Slack Off", "Chilly Reception"] });
  const cobalion = mon("Cobalion", "p2", { active: true, hpPercent: 51, types: ["Steel", "Fighting"], item: null, knownMoves: ["Stealth Rock", "Volt Switch"] });
  const serperior = mon("Serperior", "p2", { hpPercent: 62, status: "par", types: ["Grass"], knownMoves: ["Leaf Storm", "Glare"] });
  const fainted = mon("Hydreigon", "p2", { hpPercent: 0, fainted: true, types: ["Dark", "Dragon"] });
  return battle([arcanine, donphan, slowking], [cobalion, serperior, fainted], [moveAction(1, "Flare Blitz"), moveAction(2, "Head Smash", true),
    moveAction(3, "Close Combat", true), moveAction(4, "Extreme Speed", true), switchAction(2, donphan), switchAction(3, slowking)]);
}

// Fixture B, an unrelated team: Choice Band Weavile is locked into Knock Off against Gengar (whose Focus Blast KOs it);
// a weakened Hydreigon waits behind, and only Weavile both outspeeds and KOs it (Hippowdon and Slowking cannot).
const ladderB = {
  Gengar: { items: { choicespecs: 50, lifeorb: 50 }, teras: { fairy: 40, dark: 30, ghost: 30 }, abilities: { cursedbody: 100 },
    moves: { shadowball: 99, focusblast: 90, sludgewave: 80, nastyplot: 30 }, spread: "Timid:0/0/0/252/4/252" },
  Hydreigon: { items: { choicespecs: 70, leftovers: 30 }, teras: { dark: 60, steel: 40 }, abilities: { levitate: 100 },
    moves: { darkpulse: 99, dracometeor: 90, flashcannon: 60, earthpower: 50 }, spread: "Timid:0/0/0/252/4/252" }
};
function fixtureB() {
  const weavile = mon("Weavile", "p1", { active: true, item: "Choice Band", ability: "Pressure", types: ["Dark", "Ice"], teraType: "Ice",
    stats: { hp: 281, atk: 339, def: 166, spa: 126, spd: 206, spe: 383 }, knownMoves: ["Knock Off", "Triple Axel", "Ice Shard", "Low Kick"], appearanceMoves: ["Knock Off"] });
  const hippowdon = mon("Hippowdon", "p1", { item: "Leftovers", ability: "Sand Stream", types: ["Ground"], teraType: "Dragon",
    stats: { hp: 420, atk: 248, def: 368, spa: 176, spd: 236, spe: 117 }, knownMoves: ["Earthquake", "Slack Off", "Stealth Rock", "Whirlwind"] });
  const slowking = mon("Slowking", "p1", { hpPercent: 80, item: "Heavy-Duty Boots", ability: "Regenerator", types: ["Water", "Psychic"], teraType: "Fairy",
    stats: { hp: 394, atk: 155, def: 256, spa: 236, spd: 286, spe: 58 }, knownMoves: ["Scald", "Psyshock", "Slack Off", "Chilly Reception"] });
  const gengar = mon("Gengar", "p2", { active: true, hpPercent: 100, types: ["Ghost", "Poison"], knownMoves: ["Shadow Ball", "Focus Blast"] });
  const hydreigon = mon("Hydreigon", "p2", { hpPercent: 35, types: ["Dark", "Dragon"], knownMoves: ["Dark Pulse"] });
  return battle([weavile, hippowdon, slowking], [gengar, hydreigon], [moveAction(1, "Knock Off"), moveAction(2, "Triple Axel", true),
    moveAction(3, "Ice Shard", true), moveAction(4, "Low Kick", true), switchAction(2, hippowdon), switchAction(3, slowking)]);
}

// Matters: turn 38 lost the game: Arcanine stayed in as the only Pokémon that outspeeds and KOs Serperior, and Cobalion's
// Tera Water (its most common ladder Tera) blanked the locked Flare Blitz. Both facts must reach the owner on the stay pick,
// on any team: here and on an unrelated Weavile/Gengar board.
test("last fast answer and locked move vs defensive Tera warn on the stay pick, on two unrelated boards", async () => {
  const a = computeTacticalGuards(await envelope(fixtureA(), await context(ladderA))).guards;
  const lastA = kind(a, "last_answer");
  assert.equal(lastA.length, 1, JSON.stringify(a)); assert.deepEqual(lastA[0]!.actionIds, ["move:1|tera=0"]);
  assert.match(lastA[0]!.short, /^Last fast answer to .*Serperior/); assert.equal(lastA[0]!.severity, "amber");
  assert.match(lastA[0]!.message, /outspeeds Serperior \(459 vs ≤\d+\) and KOs it \(Flare Blitz/);
  const teraA = kind(a, "tera_resist");
  assert.equal(teraA.length, 1); assert.equal(teraA[0]!.short, "Cobalion may Tera to resist (Water 31%)"); assert.deepEqual(teraA[0]!.actionIds, ["move:1|tera=0"]);

  const b = computeTacticalGuards(await envelope(fixtureB(), await context(ladderB))).guards;
  const lastB = kind(b, "last_answer");
  assert.equal(lastB.length, 1, JSON.stringify(b)); assert.match(lastB[0]!.short, /^Last fast answer to .*Hydreigon/); assert.deepEqual(lastB[0]!.actionIds, ["move:1|tera=0"]);
  assert.match(lastB[0]!.message, /Focus Blast/);
  const teraB = kind(b, "tera_resist");
  assert.equal(teraB.length, 1); assert.equal(teraB[0]!.short, "Gengar may Tera to resist (Fairy 40%, Dark 30%)");
  for (const guard of [...a, ...b]) assert.equal(guard.severity === "red" && ["last_answer", "tera_resist"].includes(guard.kind), false, "warnings only: never re-ranked");
});

// Matters: a warning that fires regardless of the board is noise the owner learns to ignore. Another answer on the bench,
// a spent Tera, or no Choice lock must each silence the matching warning.
test("last answer and Tera warnings stay silent when another answer exists, Tera is spent or nothing is locked", async () => {
  const ctxA = await context(ladderA), ctxB = await context(ladderB);
  // A healthy fast bench Pokémon that also KOs Hydreigon is a second answer.
  const second = fixtureB();
  second.yourSide.team.push(mon("Thundurus", "p1", { item: "Heavy-Duty Boots", ability: "Prankster", types: ["Electric", "Flying"], teraType: "Steel",
    stats: { hp: 299, atk: 239, def: 176, spa: 349, spd: 197, spe: 353 }, knownMoves: ["Grass Knot", "Volt Switch", "Thunderbolt", "Focus Blast"] }));
  second.opponentSide.team[1]!.hpPercent = 10;
  assert.doesNotMatch(kind(computeTacticalGuards(await envelope(second, ctxB)).guards, "last_answer")[0]?.short ?? "", /Hydreigon/, "Thundurus also outspeeds and KOs a 10% Hydreigon");
  const scizor = fixtureA(); scizor.opponentSide.team[1]!.hpPercent = 20;
  scizor.yourSide.team.push(mon("Scizor", "p1", { item: "Heavy-Duty Boots", ability: "Technician", types: ["Bug", "Steel"], teraType: "Steel",
    stats: { hp: 291, atk: 394, def: 236, spa: 131, spd: 196, spe: 220 }, knownMoves: ["Bullet Punch", "U-turn", "Knock Off", "Close Combat"] }));
  assert.doesNotMatch(kind(computeTacticalGuards(await envelope(scizor, ctxA)).guards, "last_answer")[0]?.short ?? "", /Serperior/, "Scizor also outspeeds the paralysed Serperior and KOs it");
  for (const [name, build, ctx] of [["A", fixtureA, ctxA], ["B", fixtureB, ctxB]] as const) {
    const spent = build(); spent.opponentSide.team.push(mon("Skeledirge", "p2", { hpPercent: 0, fainted: true, terastallized: true, teraType: "Fairy" }));
    assert.equal(kind(computeTacticalGuards(await envelope(spent, ctx)).guards, "tera_resist").length, 0, `${name}: the opponent's Tera is spent`);
    const free = build(); free.yourSide.active!.appearanceMoves = []; free.legalActions = free.legalActions.map((action) => ({ ...action, disabled: false, legality: "certain" }));
    assert.equal(kind(computeTacticalGuards(await envelope(free, ctx)).guards, "tera_resist").length, 0, `${name}: not locked, the owner can pick another move`);
  }
});

// Matters: at turn 38 the engine put Body Press at 78–92% into Arcanine: no one-hit KO, yet staying lost the last answer
// (a resisted Flare Blitz, then the second hit). A hit that KOs within two uses is a risk; one that cannot is not.
test("a last answer facing a two-hit KO is at risk; facing a hit that cannot KO in two it is not", async () => {
  const ladder = { ...ladderA, Cobalion: { ...ladderA.Cobalion, spread: "Timid:0/0/0/252/4/252" } };
  const twoHit = await envelope(fixtureA(), await context(ladder));
  const press = (twoHit.semantic.localIntel as any).opponentThreatPreview.find((threat: any) => threat.moveName === "Body Press");
  const max = Math.max(...press.currentTarget.bands.map((band: any) => band.maxPercent));
  assert.ok(max < 100 && 2 * max >= 100, `Body Press ${max}% is a two-hit KO only`);
  assert.equal(kind(computeTacticalGuards(twoHit).guards, "last_answer").length, 1);
  const tera = fixtureA(); Object.assign(tera.yourSide.active!, { terastallized: true, teraType: "Fire", types: ["Fire"] });
  assert.equal(kind(computeTacticalGuards(await envelope(tera, await context(ladder))).guards, "last_answer").length, 0, "Tera Fire halves Body Press: no risk");
});

// Matters: two constraints. A long warning wraps and resizes Showdown's controls, so every
// short line fits SHORT_MAX on both boards and fitShort cuts anything that still would not.
test("every warning's strip line fits the one-line limit and keeps the full fact for the tooltip", async () => {
  const all = [...computeTacticalGuards(await envelope(fixtureA(), await context(ladderA))).guards, ...computeTacticalGuards(await envelope(fixtureB(), await context(ladderB))).guards];
  assert.ok(all.length >= 4);
  for (const guard of all) {
    assert.ok(guard.short.length > 0 && guard.short.length <= SHORT_MAX, `${guard.kind}: "${guard.short}" (${guard.short.length})`);
    assert.ok(guard.message.length >= guard.short.length, "the message keeps the detail");
  }
  assert.equal(fitShort("x".repeat(80), "y".repeat(40)), "y".repeat(40));
  const cut = fitShort("z".repeat(200));
  assert.equal(cut.length, SHORT_MAX); assert.ok(cut.endsWith("…"));
});

// Matters: turns 11 and 29 showed a pick (Knock Off, U-turn) while a guard said the active is KO'd before it moves.
// The pick stays (warnings only), but the KO'd-first warning must lead the shown guards and be marked as on the pick.
test("a KO'd-first guard on the shown pick leads the advice guards and is marked on the pick", () => {
  const guards: TacticalGuard[] = [
    { kind: "choice_lock", severity: "amber", actionIds: [], message: "lock", short: "lock" },
    { kind: "switch_into_ko", severity: "red", actionIds: ["switch:2"], message: "entry", short: "entry" },
    { kind: "pre_move_ko", severity: "amber", actionIds: ["move:1|tera=0", "move:2|tera=0"], message: "Gardevoir moves first; its likely Psychic Noise KOs", short: "May be KO'd first by Psychic Noise" }
  ];
  const shown = adviceGuards(guards, "move:1|tera=0");
  assert.equal(shown[0]!.kind, "pre_move_ko"); assert.equal(shown[0]!.onPick, true); assert.equal(shown[0]!.short, "May be KO'd first by Psychic Noise");
  assert.deepEqual(shown.map((guard) => guard.kind), ["pre_move_ko", "choice_lock"], "another action's fact is not shown beside the pick");
  assert.ok(shown.slice(1).every((guard) => !guard.onPick));
  assert.equal(adviceGuards(guards, "switch:2").find((guard) => guard.kind === "pre_move_ko"), undefined, "not shown when the pick does not use it");
});

// Matters: the lock warning reads this battle's item marginals, not the truncated top hypotheses that said "Choice
// Scarf 100%" (turn 29). Two unrelated holders: the shown share is the marginal and never 100% for a hidden item.
test("the Choice-lock warning shows the posterior's item marginal, never a truncated 100%", async () => {
  for (const [build, ladder] of [[fixtureA, ladderA], [fixtureB, ladderB]] as const) {
    const env = await envelope(build(), await context(ladder));
    const snap = env.semantic.snapshot as BattleSnapshot, intel = env.semantic.localIntel as any;
    const them = snap.opponentSide.active!; them.appearanceMoves = [them.knownMoves[0]!];
    const entry = intel.opponents.find((candidate: any) => candidate.instanceId === them.instanceId);
    entry.posterior = { confidenceTier: "usable", evidenceKinds: ["damage"], statBands: [], evidence: [], usedFallback: false,
      topHypotheses: [{ item: "Choice Scarf", weight: 1, ability: null, teraType: null, statArchetype: "scarf_spec", nature: "Timid", evs: {}, effectiveSpeed: null, support: [] }],
      itemShares: [{ name: "Choice Scarf", share: 0.996 }, { name: "Leftovers", share: 0.004 }] };
    const lock = computeTacticalGuards(env).guards.find((guard) => guard.kind === "choice_lock")!;
    assert.match(lock.message, /Choice Scarf 99% given this battle/); assert.match(lock.short, /\(Scarf 99%\)$/);
    entry.posterior.itemShares = [{ name: "Choice Scarf", share: 0.6 }, { name: "Leftovers", share: 0.4 }];
    assert.match(computeTacticalGuards(env).guards.find((guard) => guard.kind === "choice_lock")!.message, /Choice Scarf 60% given this battle/);
  }
});

// Matters: turn 29: after one Moonblast the advisor claimed "Choice Scarf 100%" (the top-12 hypothesis cut held only
// Scarf sets) and Gardevoir then changed moves. One move keeps the alternatives; two moves in a stint rule Choice out.
test("one observed move keeps item alternatives; a second move in the stint rules Choice items out", () => {
  const stats = { observedBattlesSeen: 0, observedMoves: {}, observedItems: {}, observedAbilities: {}, observedTeraTypes: {}, curatedMoves: {}, curatedItems: {}, curatedAbilities: {}, curatedTeraTypes: {} };
  for (const [species, ladderItems, moves, choice] of [
    ["Gardevoir", [{ name: "Choice Scarf", share: 0.73 }, { name: "Assault Vest", share: 0.11 }, { name: "Heavy-Duty Boots", share: 0.06 }, { name: "Choice Specs", share: 0.05 }], ["Moonblast", "Psychic Noise"], "Choice Scarf"],
    ["Metagross", [{ name: "Choice Band", share: 0.7 }, { name: "Assault Vest", share: 0.15 }, { name: "Leftovers", share: 0.1 }], ["Earthquake", "Knock Off"], "Choice Band"]
  ] as const) {
    const opponent = (seen: string[]) => mon(species, "p2", { active: true, knownMoves: seen, appearanceMoves: seen });
    const one = buildOpponentPosterior({ format: "[Gen 9] UU", opponent: opponent([moves[0]]), formatStats: { ...stats, ladderItems: [...ladderItems] } })!;
    const share = (posterior: typeof one, item: string) => posterior.itemShares?.find((entry) => entry.name === item)?.share ?? 0;
    assert.ok(share(one, choice) > 0.5 && share(one, choice) < 0.95, `${species}: one move is not a demonstrated lock (${share(one, choice)})`);
    assert.ok((one.itemShares ?? []).filter((entry) => entry.name !== choice).reduce((sum, entry) => sum + entry.share, 0) > 0.05, `${species}: alternatives kept`);
    const two = buildOpponentPosterior({ format: "[Gen 9] UU", opponent: opponent([...moves]), formatStats: { ...stats, ladderItems: [...ladderItems] } })!;
    assert.ok(two.topHypotheses.every((hypothesis) => !/^Choice /.test(hypothesis.item ?? "")), `${species}: changed moves without switching`);
    assert.equal((two.itemShares ?? []).filter((entry) => /^Choice /.test(entry.name)).length, 0);
  }
});

// Matters: turns 2 and 37 said the opponent "may move first" while its shown maximum Speed was below Arcanine's 459. The
// relation already applies paralysis (and stages, Tailwind, known items) exactly; listing them as confounders made every
// guard doubt it. A possible Choice Scarf is a real "may", and then the message must name it and its Speed.
test("Speed guards trust the exact relation and name a possible Scarf as the only way to move first", async () => {
  // A paralysed Serperior (≤178) against Arcanine (459): Leaf Storm would KO, but Arcanine surely moves first.
  const serperior = fixtureA();
  serperior.opponentSide.team = [{ ...serperior.opponentSide.team[1]!, active: true }, { ...serperior.opponentSide.team[0]!, active: false }];
  serperior.opponentSide.active = serperior.opponentSide.team[0]!;
  serperior.yourSide.active!.appearanceMoves = []; serperior.legalActions = serperior.legalActions.map((action) => ({ ...action, disabled: false, legality: "certain" }));
  const envA = await envelope(serperior, await context(ladderA));
  const speedA = (envA.semantic.localIntel as any).speedPreview;
  assert.equal(speedA.activeRelation, "faster"); assert.ok(speedA.effectiveRange.max < 459, JSON.stringify(speedA.effectiveRange));
  assert.ok(!speedA.confounders.includes("opponent paralysis"), "paralysis is applied, not a confounder");
  assert.notEqual(speedA.reason, "confounded");
  assert.deepEqual(kind(computeTacticalGuards(envA).guards, "pre_move_ko"), [], "no 'may move first' below our Speed");
  // A paralysed Fezandipiti (117) against Gardevoir (≥176): Gardevoir surely moves first; only the unrevealed hit is a "may".
  const fez = mon("Fezandipiti", "p1", { active: true, hpPercent: 19, status: "par", item: "Heavy-Duty Boots", ability: "Toxic Chain", types: ["Poison", "Fairy"], teraType: "Water",
    stats: { hp: 380, atk: 196, def: 286, spa: 176, spd: 290, spe: 234 }, knownMoves: ["Moonblast", "Taunt", "Roost", "U-turn"] });
  const gardevoir = mon("Gardevoir", "p2", { active: true, types: ["Psychic", "Fairy"], knownMoves: ["Moonblast"], appearanceMoves: ["Moonblast"] });
  const ladderG = { Gardevoir: { items: { choicescarf: 73, assaultvest: 11, heavydutyboots: 6, choicespecs: 5 }, teras: { fairy: 50, psychic: 50 }, abilities: { trace: 100 },
    moves: { moonblast: 99, psychicnoise: 80, mysticalfire: 60, trick: 40 }, spread: "Timid:0/0/0/252/4/252" } };
  const envB = await envelope(battle([fez], [gardevoir], [moveAction(1, "Moonblast"), moveAction(2, "Taunt"), moveAction(3, "Roost"), moveAction(4, "U-turn")]), await context(ladderG));
  assert.equal((envB.semantic.localIntel as any).speedPreview.activeRelation, "slower");
  const preB = kind(computeTacticalGuards(envB).guards, "pre_move_ko");
  assert.equal(preB.length, 1, JSON.stringify(computeTacticalGuards(envB).guards));
  assert.match(preB[0]!.message, /^Gardevoir moves first \(Speed \d+–\d+ vs your 117\); its likely Psychic Noise KOs Fezandipiti/);
  // Possible Scarf: Hydreigon's item-free 208–324 is below 459, but a Scarf makes 486. The message says so.
  const hydreigon = fixtureA();
  hydreigon.opponentSide.team[0] = mon("Hydreigon", "p2", { active: true, types: ["Dark", "Dragon"], knownMoves: ["Draco Meteor"] });
  hydreigon.opponentSide.active = hydreigon.opponentSide.team[0]!;
  hydreigon.yourSide.active!.appearanceMoves = []; hydreigon.yourSide.active!.hpPercent = 60; hydreigon.legalActions = hydreigon.legalActions.map((action) => ({ ...action, disabled: false, legality: "certain" }));
  const ladderH = { Hydreigon: { items: { choicescarf: 38, choicespecs: 24, leftovers: 22 }, teras: { dark: 60, steel: 40 }, abilities: { levitate: 100 },
    moves: { dracometeor: 95, darkpulse: 90, flashcannon: 60, uturn: 50 }, spread: "Timid:0/0/0/252/4/252" } };
  const envH = await envelope(hydreigon, await context(ladderH));
  const preH = kind(computeTacticalGuards(envH).guards, "pre_move_ko");
  assert.ok(preH.length >= 1, JSON.stringify(computeTacticalGuards(envH).guards));
  for (const guard of preH) assert.match(guard.message, /^Hydreigon may move first \(Speed 208–324, ≤486 with Choice Scarf vs your 459\)/);
});

// ---- tactical-guards@5. Warnings only; facts, never instructions.
const teraAction = (slot: number, moveName: string): LegalAction => ({ id: `move:${slot}|tera=1`, kind: "move", label: `Tera + ${moveName}`, moveName, moveSlot: slot,
  choice: `move ${slot} terastallize`, terastallize: true, legality: "certain" } as LegalAction);
const guardsOf = async (snapshot: BattleSnapshot, ladder: Parameters<typeof context>[0]) => computeTacticalGuards(await envelope(snapshot, await context(ladder))).guards;
const on = (guards: TacticalGuard[], name: string, id: string) => guards.filter((guard) => guard.kind === name && guard.actionIds.includes(id));
const fits = (guards: TacticalGuard[]) => { for (const guard of guards) assert.ok(guard.short.length <= SHORT_MAX, `${guard.kind}: "${guard.short}"`); };
const ladderSlither = { "Slither Wing": { items: { choiceband: 40, heavydutyboots: 30, leftovers: 30 }, teras: { fighting: 60, bug: 40 }, abilities: { protosynthesis: 100 },
  moves: { earthquake: 99, firstimpression: 90, closecombat: 90, uturn: 80 }, spread: "Adamant:0/252/0/0/4/252" } };

// Matters: a Terastallization changes the defensive type chart, so every KO fact must follow the real chart for the
// action's own Tera. Tera Ghost does not blank Earthquake (Ground hits Ghost neutrally), so
// the KO stays on Tera Ghost actions, while a Tera that is immune (Flying) or resists (Fairy vs Bug) lifts it.
test("KO facts follow the type chart of each action's Tera: Ghost keeps an Earthquake KO, Flying and Fairy lift theirs", async () => {
  const donphan = (teraType: string) => mon("Donphan", "p1", { active: true, hpPercent: 12.5, item: "Heavy-Duty Boots", ability: "Sturdy", types: ["Ground"], teraType,
    stats: { hp: 383, atk: 280, def: 370, spa: 140, spd: 156, spe: 136 }, knownMoves: ["Earthquake", "Rapid Spin", "Knock Off", "Ice Spinner"] });
  const slither = () => mon("Slither Wing", "p2", { active: true, hpPercent: 63, types: ["Bug", "Fighting"], knownMoves: ["Earthquake"], appearanceMoves: ["Earthquake"], turnsSinceEntry: 3 });
  const board = (teraType: string) => battle([donphan(teraType)], [slither()], [moveAction(1, "Earthquake"), moveAction(3, "Knock Off"), teraAction(1, "Earthquake"), teraAction(3, "Knock Off")]);
  const ghost = await guardsOf(board("Ghost"), ladderSlither);
  const eqKo = (guards: TacticalGuard[], id: string) => guards.some((guard) => guard.kind === "pre_move_ko" && guard.actionIds.includes(id) && /Earthquake/.test(guard.message));
  assert.ok(eqKo(ghost, "move:1|tera=0") && eqKo(ghost, "move:1|tera=1"), `Tera Ghost does not stop Earthquake: ${JSON.stringify(ghost)}`);
  const flying = await guardsOf(board("Flying"), ladderSlither);
  assert.ok(eqKo(flying, "move:1|tera=0") && !eqKo(flying, "move:1|tera=1"), "Tera Flying is immune to Ground");
  // The second board: a priority Bug hit into Slowking; Tera Fairy resists it, so the caveat stays off the Tera actions.
  const slowking = mon("Slowking", "p1", { active: true, hpPercent: 34.5, item: "Heavy-Duty Boots", ability: "Regenerator", types: ["Water", "Psychic"], teraType: "Fairy",
    stats: { hp: 394, atk: 155, def: 256, spa: 236, spd: 286, spe: 58 }, knownMoves: ["Scald", "Future Sight", "Slack Off", "Chilly Reception"] });
  const fresh = mon("Slither Wing", "p2", { active: true, hpPercent: 88, types: ["Bug", "Fighting"], knownMoves: [], turnsSinceEntry: 1 });
  const fi = await guardsOf(battle([slowking], [fresh], [moveAction(1, "Scald"), moveAction(3, "Slack Off"), teraAction(1, "Scald"), teraAction(3, "Slack Off")]), ladderSlither);
  const caveat = kind(fi, "priority_caveat").filter((guard) => /First Impression/.test(guard.short));
  assert.ok(caveat.length && caveat.every((guard) => guard.actionIds.length && guard.actionIds.every((id) => id.endsWith("tera=0"))), `no state-level or Tera Fairy caveat: ${JSON.stringify(caveat)}`);
  fits([...ghost, ...flying, ...fi]);
});

// Matters: "KO'd first by Poison Jab" (a Tera Fairy fact) showed under a non-Tera Slack Off, and a Tera
// Steel line under Knock Off. Only facts about the shown action appear, plus one state-level line; no-safe-option leads.
test("advice shows only the shown action's warnings plus at most one state-level line", () => {
  const guards: TacticalGuard[] = [
    { kind: "pre_move_ko", severity: "red", actionIds: ["move:1|tera=1", "move:3|tera=1"], message: "Tera Fairy Poison Jab KO", short: "KO'd first by Poison Jab" },
    { kind: "tera_survival", severity: "amber", actionIds: ["move:3|tera=1"], message: "Tera Steel", short: "Tera Steel: Earthquake becomes a KO" },
    { kind: "choice_lock", severity: "amber", actionIds: [], message: "lock", short: "lock" },
    { kind: "priority_caveat", severity: "amber", actionIds: [], message: "old state-level", short: "state 2" },
    { kind: "no_progress", severity: "amber", actionIds: ["move:3|tera=0"], message: "loop", short: "No progress: 3rd Slack Off in a row" }
  ];
  const shown = adviceGuards(guards, "move:3|tera=0");
  assert.deepEqual(shown.map((guard) => guard.short), ["No progress: 3rd Slack Off in a row", "lock"]);
  assert.ok(!shown.some((guard) => /Tera|Poison Jab/.test(guard.short)), "no Tera-only fact beside a non-Tera pick");
  const forced = adviceGuards([...guards, { kind: "no_safe_option", severity: "amber", actionIds: ["move:3|tera=0"], message: "all", short: "No safe option: every action risks a KO" }], "move:3|tera=0");
  assert.equal(forced[0]!.kind, "no_safe_option"); assert.ok(forced.length <= 3);
});

// Matters: "may be KO'd first by Foul Play" alone was shown while Close Combat could not KO Mandibuzz and its own
// Defense drop made the reply a KO in either order. The reply is judged after the pick's self-effects; a drop that does not
// touch the reply's stat changes nothing. Board 2: Psyshock reads Defense, so Close Combat's drop matters there too.
test("retaliation is judged after the pick's own stat drops; Foul Play and Psyshock read the right stats", async () => {
  const scizor = mon("Scizor", "p1", { active: true, hpPercent: 59.5, item: "Heavy-Duty Boots", ability: "Technician", types: ["Bug", "Steel"], teraType: "Steel", boosts: { atk: 2 },
    stats: { hp: 291, atk: 394, def: 236, spa: 131, spd: 196, spe: 220 }, knownMoves: ["Swords Dance", "Bullet Punch", "Knock Off", "Close Combat"] });
  const mandibuzz = mon("Mandibuzz", "p2", { active: true, hpPercent: 80, types: ["Dark", "Flying"], knownMoves: ["Foul Play"], item: null });
  const ladderM = { Mandibuzz: { items: { heavydutyboots: 90, leftovers: 10 }, teras: { steel: 60, fairy: 40 }, abilities: { overcoat: 100 },
    moves: { foulplay: 99, roost: 95, uturn: 80, knockoff: 70 }, spread: "Impish:248/0/252/0/8/0" } };
  const a = await guardsOf(battle([scizor], [mandibuzz], [moveAction(2, "Bullet Punch"), moveAction(3, "Knock Off"), moveAction(4, "Close Combat")]), ladderM);
  const cc = on(a, "retaliation_ko", "move:4|tera=0")[0], knock = on(a, "retaliation_ko", "move:3|tera=0")[0];
  assert.ok(cc && knock, JSON.stringify(a));
  assert.match(cc.short, /^No KO; Foul Play KOs back \(after −1 Def −1 SpD\)$/);
  const low = (guard: TacticalGuard) => Number(guard.message.match(/≈(\d+)–/)![1]);
  assert.ok(low(cc) > 1.4 * low(knock), `the −1 Defense raises Foul Play by ~1.5× (${low(cc)} vs ${low(knock)})`);
  assert.doesNotMatch(cc.message + cc.short, /switch/i, "a fact, not an instruction");
  // Board 2: a special Psyshock into Iron Hands' Defense; Drain Punch (no drop) survives it, Close Combat does not.
  const hands = mon("Iron Hands", "p1", { active: true, hpPercent: 100, item: "Leftovers", ability: "Quark Drive", types: ["Fighting", "Electric"], teraType: "Fighting",
    stats: { hp: 461, atk: 416, def: 252, spa: 122, spd: 200, spe: 136 }, knownMoves: ["Close Combat", "Drain Punch", "Thunder Punch", "Fake Out"] });
  const hatterene = mon("Hatterene", "p2", { active: true, hpPercent: 100, types: ["Psychic", "Fairy"], knownMoves: ["Psyshock"], ability: "Magic Bounce" });
  const ladderH = { Hatterene: { items: { leftovers: 100 }, teras: { steel: 100 }, abilities: { magicbounce: 100 }, moves: { psyshock: 99, drainingkiss: 90, calmmind: 90, mysticalfire: 60 }, spread: "Quiet:252/0/0/252/4/0" } };
  const board = (hpPercent: number) => battle([{ ...hands, hpPercent }], [hatterene], [moveAction(1, "Close Combat"), moveAction(2, "Drain Punch")]);
  const env = await envelope(board(100), await context(ladderH));
  const psyshock = likely((env.semantic.localIntel as any).opponentThreatPreview.find((threat: any) => threat.moveName === "Psyshock").currentTarget.bands)!;
  const hp = Math.min(99, psyshock.maxPercent! * 1.2);
  assert.ok(psyshock.minPercent! * 1.5 > hp, "the board puts Iron Hands between the plain and the −1 Defense range");
  const b = await guardsOf(board(hp), ladderH);
  assert.equal(on(b, "retaliation_ko", "move:1|tera=0").length, 1, JSON.stringify(b));
  assert.equal(on(b, "retaliation_ko", "move:2|tera=0").length, 0, "Drain Punch leaves Defense alone");
  fits([...a, ...b]);
});
const likely = (bands: Array<{ label: string; minPercent: number | null; maxPercent: number | null }> | undefined) => (bands ?? []).find((band) => band.label === "likely");

// Matters: Scald into a Clodsire with 67% Water Absorb on the ladder heals it, and so does Scald again after
// the ability is revealed. Unrevealed: an amber line with the ladder share; revealed: a red fact; another ability: nothing.
test("attacks into a nullifying ability warn with its ladder share, and as a fact once it is revealed", async () => {
  const cases = [
    { ladder: { Clodsire: { items: { leftovers: 100 }, teras: { flying: 100 }, abilities: { waterabsorb: 67, unaware: 33 }, moves: { earthquake: 99, toxic: 90, recover: 90, poisonjab: 60 }, spread: "Careful:252/0/4/0/252/0" } },
      you: mon("Slowking", "p1", { active: true, hpPercent: 68, item: "Heavy-Duty Boots", ability: "Regenerator", types: ["Water", "Psychic"], teraType: "Fairy",
        stats: { hp: 394, atk: 155, def: 256, spa: 236, spd: 286, spe: 58 }, knownMoves: ["Scald", "Future Sight", "Slack Off", "Chilly Reception"] }),
      species: "Clodsire", types: ["Poison", "Ground"], move: "Scald", ability: "Water Absorb", other: "Unaware", pct: "67%" },
    { ladder: { Lanturn: { items: { leftovers: 100 }, teras: { water: 100 }, abilities: { voltabsorb: 70, illuminate: 30 }, moves: { scald: 99, voltswitch: 90, healbell: 60, thunderwave: 60 }, spread: "Calm:252/0/0/0/252/4" } },
      you: mon("Rotom-Heat", "p1", { active: true, hpPercent: 90, item: "Leftovers", ability: "Levitate", types: ["Electric", "Fire"], teraType: "Electric",
        stats: { hp: 304, atk: 149, def: 272, spa: 246, spd: 250, spe: 230 }, knownMoves: ["Thunderbolt", "Overheat", "Will-O-Wisp", "Volt Switch"] }),
      species: "Lanturn", types: ["Water", "Electric"], move: "Thunderbolt", ability: "Volt Absorb", other: "Illuminate", pct: "70%" }
  ];
  for (const entry of cases) {
    const board = (ability: string | null) => battle([entry.you], [mon(entry.species, "p2", { active: true, hpPercent: 80, types: entry.types, ability, knownMoves: [] })],
      [moveAction(1, entry.move), moveAction(2, entry.you.knownMoves[1]!)]);
    const hidden = on(await guardsOf(board(null), entry.ladder), "ability_immune", "move:1|tera=0");
    assert.equal(hidden.length, 1, entry.species); assert.equal(hidden[0]!.severity, "amber");
    assert.equal(hidden[0]!.short, `${entry.ability} ${entry.pct}: ${entry.move} may do nothing`);
    const shown = on(await guardsOf(board(entry.ability), entry.ladder), "ability_immune", "move:1|tera=0");
    assert.equal(shown.length, 1); assert.equal(shown[0]!.severity, "red"); assert.equal(shown[0]!.short, `${entry.move} does nothing (${entry.ability})`);
    assert.equal(kind(await guardsOf(board(entry.other), entry.ladder), "ability_immune").length, 0, `${entry.other} does not nullify ${entry.move}`);
  }
});

// Matters: a Slowking using Slack Off turn after turn into a full-HP Clodsire gains HP, but nothing
// else changes and the recovery PP drains. The recurrence is shown on the recovery pick from the third use; any progress
// (the opponent loses HP, gets a status, a hazard) or a different opponent ends it.
test("a recovery move repeated against the same opponent with no progress is flagged from its third use", async () => {
  type Fact = { id: string; kind: string; turn: number; subject: { side?: string | undefined; appearanceId?: string | undefined }; args: string[] };
  const withFacts = (snapshot: BattleSnapshot, facts: Fact[]) => { snapshot.canonicalEvidence = { version: "canonical-evidence@1", facts, contributions: [], ambiguities: [], limitations: [] } as any; return snapshot; };
  const boards = [
    { you: mon("Slowking", "p1", { active: true, hpPercent: 57, status: "psn", item: "Heavy-Duty Boots", ability: "Regenerator", types: ["Water", "Psychic"], teraType: "Fairy", appearanceId: "a:p1:14",
        stats: { hp: 394, atk: 155, def: 256, spa: 236, spd: 286, spe: 58 }, knownMoves: ["Scald", "Future Sight", "Slack Off", "Chilly Reception"] }),
      them: mon("Clodsire", "p2", { active: true, hpPercent: 100, types: ["Poison", "Ground"], ability: "Water Absorb", appearanceId: "a:p2:13", knownMoves: ["Earthquake", "Poison Jab"] }),
      heal: "Slack Off", attack: "Earthquake", ladder: { Clodsire: { items: { leftovers: 100 }, teras: { flying: 100 }, abilities: { waterabsorb: 100 }, moves: { earthquake: 99, poisonjab: 90, recover: 90, toxic: 60 }, spread: "Careful:252/0/4/0/252/0" } } },
    { you: mon("Corviknight", "p1", { active: true, hpPercent: 70, item: "Leftovers", ability: "Pressure", types: ["Flying", "Steel"], teraType: "Dragon", appearanceId: "a:p1:3",
        stats: { hp: 399, atk: 218, def: 317, spa: 127, spd: 237, spe: 172 }, knownMoves: ["Brave Bird", "Roost", "U-turn", "Defog"] }),
      them: mon("Iron Treads", "p2", { active: true, hpPercent: 90, types: ["Ground", "Steel"], ability: "Quark Drive", appearanceId: "a:p2:5", knownMoves: ["Stone Edge", "Knock Off"] }),
      heal: "Roost", attack: "Stone Edge", ladder: { "Iron Treads": { items: { boosterenergy: 100 }, teras: { ground: 100 }, abilities: { quarkdrive: 100 }, moves: { stoneedge: 99, knockoff: 90, rapidspin: 90, earthquake: 80 }, spread: "Jolly:0/252/0/0/4/252" } } }
  ];
  for (const entry of boards) {
    const { you, them } = entry;
    const facts = (uses: number, extra: Fact[] = []): Fact[] => {
      const out: Fact[] = [{ id: "e", kind: "switch", turn: 20, subject: { side: "p2", appearanceId: them.appearanceId }, args: [`p2a: ${them.species}`, them.species!, `${them.hpPercent}/100`] }];
      for (let i = 0; i < uses; i++) {
        const turn = 30 - uses + i;
        out.push({ id: `a${i}`, kind: "move", turn, subject: { side: "p2", appearanceId: them.appearanceId }, args: [`p2a: ${them.species}`, entry.attack, `p1a: ${you.species}`] },
          { id: `h${i}`, kind: "move", turn, subject: { side: "p1", appearanceId: you.appearanceId }, args: [`p1a: ${you.species}`, entry.heal, `p1a: ${you.species}`] });
      }
      return [...out, ...extra];
    };
    const board = (uses: number, extra: Fact[] = []) => withFacts(battle([you], [them], [moveAction(1, you.knownMoves[0]!), moveAction(2, entry.heal), teraAction(2, entry.heal)]), facts(uses, extra));
    const loop = on(await guardsOf(board(2), entry.ladder), "no_progress", "move:2|tera=0");
    assert.equal(loop.length, 1, you.species!); assert.equal(loop[0]!.short, `No progress: 3rd ${entry.heal} in a row`);
    assert.deepEqual(loop[0]!.actionIds.sort(), ["move:2|tera=0", "move:2|tera=1"], "only on the recovery move");
    assert.equal(on(await guardsOf(board(4), entry.ladder), "no_progress", "move:2|tera=0")[0]!.short, `No progress: 5th ${entry.heal} in a row`);
    assert.equal(kind(await guardsOf(board(1), entry.ladder), "no_progress").length, 0, "a second use is not yet a loop");
    const status: Fact = { id: "s", kind: "-status", turn: 29, subject: { side: "p2", appearanceId: them.appearanceId }, args: [`p2a: ${them.species}`, "brn"] };
    assert.equal(kind(await guardsOf(board(3, [status]), entry.ladder), "no_progress").length, 0, "a status on the opponent is progress");
    const fresh = board(3); fresh.canonicalEvidence!.facts[0]!.turn = 28;
    assert.equal(kind(await guardsOf(fresh, entry.ladder), "no_progress").length, 0, "a different opponent is a different board");
  }
});

// Matters: "Last fast answer" fired on most Arcanine turns, including straightforward kills,
// a free Arcanine 2HKO'd by Foul Play and a last-Pokémon position. It stays for the locked case:
// Choice-locked into a move a common Tera blunts, and the reply 2HKOs (fixture A, still asserted above).
test("last answer is silent for forced positions, plain KOs and an unlocked two-hit risk", async () => {
  for (const [build, ladder] of [[fixtureA, ladderA], [fixtureB, ladderB]] as const) {
    assert.equal(kind(await guardsOf(build(), ladder), "last_answer").length, 1, "the locked two-hit case still fires");
    const forced = build(); forced.legalActions = forced.legalActions.filter((action) => action.kind !== "switch");
    assert.equal(kind(await guardsOf(forced, ladder), "last_answer").length, 0, "no switch-in: a forced position");
    fits(await guardsOf(forced, ladder));
  }
  // Unlocked, the same two-hit Body Press (Timid Cobalion: below 100% per hit) is no warning; a one-hit reply still is.
  const unlock = <T extends BattleSnapshot>(snapshot: T) => { snapshot.yourSide.active!.appearanceMoves = []; snapshot.legalActions = snapshot.legalActions.map((action) => ({ ...action, disabled: false, legality: "certain" as const })); return snapshot; };
  const timid = { ...ladderA, Cobalion: { ...ladderA.Cobalion, spread: "Timid:0/0/0/252/4/252" } };
  assert.equal(kind(await guardsOf(fixtureA(), timid), "last_answer").length, 1, "locked: the two-hit case fires");
  assert.equal(kind(await guardsOf(unlock(fixtureA()), timid), "last_answer").length, 0, "unlocked: a two-hit reply is no warning");
  // A plain KO: at 15% Cobalion falls to Flare Blitz even through Tera Water or Ghost, so a one-hit Body Press into a 60%
  // Arcanine is no role risk; at 51% the same Teras save it and the risk is real.
  const plain = (hp: number) => { const snapshot = unlock(fixtureA()); snapshot.yourSide.active!.hpPercent = 60; Object.assign(snapshot.opponentSide.active!, { hpPercent: hp, item: "Leftovers" }); return snapshot; };
  const flareAtRisk = async (hp: number) => kind(await guardsOf(plain(hp), timid), "last_answer").some((guard) => guard.actionIds.includes("move:1|tera=0"));
  assert.equal(await flareAtRisk(15), false, "a KO first that no common Tera prevents");
  assert.equal(await flareAtRisk(51), true, "Teras that save Cobalion make the stay a risk");
  const oneHit = kind(await guardsOf(unlock(fixtureB()), ladderB), "last_answer");
  assert.equal(oneHit.length, 1, "Focus Blast KOs Weavile in one hit: still a risk"); assert.match(oneHit[0]!.message, /in one hit/);
});

// Matters: with Arcanine the last Pokémon, locked into Head Smash, First Impression can KO it whatever
// was chosen. That is a distinct state ("no safe option"), stated as a fact; a surviving switch-in removes it.
test("no safe option is a distinct state when every legal action risks a KO, and only then", async () => {
  const arcanine = mon("Arcanine-Hisui", "p1", { active: true, hpPercent: 32, item: "Choice Scarf", ability: "Rock Head", types: ["Fire"], teraType: "Fire", terastallized: true,
    stats: { hp: 331, atk: 329, def: 196, spa: 203, spd: 197, spe: 306 }, knownMoves: ["Flare Blitz", "Head Smash", "Close Combat", "Extreme Speed"], appearanceMoves: ["Head Smash"] });
  const slither = mon("Slither Wing", "p2", { active: true, hpPercent: 50, types: ["Bug", "Fighting"], knownMoves: ["Earthquake"], turnsSinceEntry: 1 });
  const last = await guardsOf(battle([arcanine], [slither], [moveAction(1, "Flare Blitz", true), moveAction(2, "Head Smash")]), ladderSlither);
  const state = kind(last, "no_safe_option");
  assert.equal(state.length, 1, JSON.stringify(last)); assert.deepEqual(state[0]!.actionIds, ["move:2|tera=0"]);
  assert.equal(state[0]!.short, "No safe option: every action risks a KO"); assert.doesNotMatch(state[0]!.message, /switch|should/i);
  const fez = mon("Fezandipiti", "p1", { hpPercent: 100, item: "Heavy-Duty Boots", ability: "Toxic Chain", types: ["Poison", "Fairy"], teraType: "Water",
    stats: { hp: 380, atk: 196, def: 286, spa: 176, spd: 290, spe: 234 }, knownMoves: ["Moonblast", "Taunt", "Roost", "U-turn"] });
  const out = await guardsOf(battle([arcanine, fez], [slither], [moveAction(2, "Head Smash"), switchAction(2, fez)]), ladderSlither);
  assert.equal(kind(out, "no_safe_option").length, 0, `Fezandipiti survives entry: ${JSON.stringify(out)}`);
  // Board 2 (Fixture B's Weavile, at 10% HP): Ice Shard-free Gengar cannot priority-KO it, so no state; with a sure KO
  // first and every switch KO'd on entry, the state appears.
  const b = fixtureB(); b.yourSide.active!.hpPercent = 5; b.legalActions = b.legalActions.filter((action) => action.kind !== "switch");
  const bGuards = await guardsOf(b, ladderB);
  const losing = bGuards.some((guard) => ["pre_move_ko", "retaliation_ko", "priority_caveat"].includes(guard.kind) && guard.actionIds.includes("move:1|tera=0"));
  assert.equal(kind(bGuards, "no_safe_option").length, losing ? 1 : 0, JSON.stringify(bGuards));
  fits([...last, ...out, ...bGuards]);
});
