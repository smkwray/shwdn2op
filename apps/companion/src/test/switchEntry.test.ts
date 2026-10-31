import assert from "node:assert/strict";
import test from "node:test";
import { Battle, Teams, TeamValidator, extractChannelMessages } from "../battle-agent/nativeSimulator.js";
import { calculate, Generations, Pokemon, Move } from "@smogon/calc";
import { DecisionEngine } from "../state/decisionEngine.js";
import { buildThreatPreview, buildDamagePreview } from "../prompting/damageNotes.js";
import { buildSelfActionRecommendation } from "../prediction/selfActionRecommender.js";
import { buildOpponentActionPrediction } from "../prediction/opponentActionPredictor.js";
import { buildLocalIntelSnapshot, createEphemeralIntelEvaluationContext } from "../history/opponentIntelStore.js";
import { projectSwitchEntry } from "../mechanics/switchEntry.js";
import { effectiveSpeed } from "../mechanics/speed.js";
import { exactSnapshotHp } from "../mechanics/calcPokemon.js";
import type { BattleSnapshot, PokemonSnapshot, DamageAssumptionBand } from "../types.js";

// Literal legal UU teams and fixed native choices; no model or private history.
const fixtures = [{"id":"01-hp-hazards","teams":{"p1":"Slowking @ Heavy-Duty Boots\nAbility: Regenerator\nTera Type: Fairy\nEVs: 252 HP / 240 Def / 16 SpD\nSassy Nature\nIVs: 0 Atk / 0 Spe\n- Surf\n- Protect\n- Slack Off\n- Chilly Reception\n\nDonphan @ Rocky Helmet\nAbility: Sturdy\nTera Type: Water\nEVs: 252 Atk / 4 Def / 252 Spe\nAdamant Nature\n- Earthquake\n- Protect\n- Knock Off\n- Rapid Spin","p2":"Gardevoir @ Leftovers\nAbility: Synchronize\nEVs: 128 SpA / 128 Def / 252 Spe\nSerious Nature\n- Moonblast\n- Energy Ball\n- Protect\n\nForretress @ Heavy-Duty Boots\nAbility: Sturdy\nEVs: 252 HP / 252 Def / 4 SpD\nRelaxed Nature\n- Stealth Rock\n- Spikes\n- Protect\n- Tackle"},"steps":[{"choices":{"p1":"team 12","p2":"team 12"}},{"choices":{"p1":"move 1","p2":"move 1"}},{"choices":{"p1":"move 2","p2":"switch 2"},"label":"ordinary-no-hazards"},{"choices":{"p1":"move 2","p2":"move 1"}},{"choices":{"p1":"move 2","p2":"move 2"}},{"choices":{"p1":"move 2","p2":"move 2"}},{"choices":{"p1":"move 2","p2":"move 2"}},{"choices":{"p1":"move 2","p2":"switch 2"}},{"choices":{"p1":"switch 2","p2":"move 1"},"label":"before-entry"},{"label":"after-entry-and-attack"}]},{"id":"02-hp-boots","teams":{"p1":"Slowking @ Heavy-Duty Boots\nAbility: Regenerator\nTera Type: Fairy\nEVs: 252 HP / 240 Def / 16 SpD\nSassy Nature\nIVs: 0 Atk / 0 Spe\n- Surf\n- Protect\n- Slack Off\n- Chilly Reception\n\nDonphan @ Heavy-Duty Boots\nAbility: Sturdy\nTera Type: Water\nEVs: 252 Atk / 4 Def / 252 Spe\nAdamant Nature\n- Earthquake\n- Protect\n- Knock Off\n- Rapid Spin","p2":"Gardevoir @ Leftovers\nAbility: Synchronize\nEVs: 128 SpA / 128 Def / 252 Spe\nSerious Nature\n- Moonblast\n- Energy Ball\n- Protect\n\nForretress @ Heavy-Duty Boots\nAbility: Sturdy\nEVs: 252 HP / 252 Def / 4 SpD\nRelaxed Nature\n- Stealth Rock\n- Spikes\n- Protect\n- Tackle"},"steps":[{"choices":{"p1":"team 12","p2":"team 12"}},{"choices":{"p1":"move 1","p2":"move 1"}},{"choices":{"p1":"move 2","p2":"switch 2"},"label":"ordinary-no-hazards"},{"choices":{"p1":"move 2","p2":"move 1"}},{"choices":{"p1":"move 2","p2":"move 2"}},{"choices":{"p1":"move 2","p2":"move 2"}},{"choices":{"p1":"move 2","p2":"move 2"}},{"choices":{"p1":"move 2","p2":"switch 2"}},{"choices":{"p1":"switch 2","p2":"move 1"},"label":"before-entry"},{"label":"after-entry-and-attack"}]},{"id":"03-web-scarf","teams":{"p1":"Slowking @ Heavy-Duty Boots\nAbility: Regenerator\nTera Type: Fairy\nEVs: 252 HP / 240 Def / 16 SpD\nSassy Nature\nIVs: 0 Atk / 0 Spe\n- Surf\n- Protect\n- Slack Off\n- Chilly Reception\n\nArcanine-Hisui @ Choice Scarf\nAbility: Rock Head\nTera Type: Normal\nEVs: 252 Atk / 4 SpD / 252 Spe\nJolly Nature\n- Flare Blitz\n- Protect\n- Extreme Speed\n- Close Combat","p2":"Galvantula @ Leftovers\nAbility: Compound Eyes\nEVs: 252 SpA / 4 SpD / 252 Spe\nTimid Nature\n- Sticky Web\n- Thunderbolt\n- Protect"},"steps":[{"choices":{"p1":"team 12","p2":"team 1"}},{"choices":{"p1":"move 1","p2":"move 1"},"label":"ordinary-no-web"},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-entry"},{"choices":{"p1":"move 1","p2":"move 2"},"label":"after-entry"},{"label":"after-speed-order"}]},{"id":"04-web-boots","teams":{"p1":"Slowking @ Heavy-Duty Boots\nAbility: Regenerator\nTera Type: Fairy\nEVs: 252 HP / 240 Def / 16 SpD\nSassy Nature\nIVs: 0 Atk / 0 Spe\n- Surf\n- Protect\n- Slack Off\n- Chilly Reception\n\nArcanine-Hisui @ Heavy-Duty Boots\nAbility: Rock Head\nTera Type: Normal\nEVs: 252 Atk / 4 SpD / 252 Spe\nJolly Nature\n- Flare Blitz\n- Protect\n- Extreme Speed\n- Close Combat","p2":"Galvantula @ Leftovers\nAbility: Compound Eyes\nEVs: 252 SpA / 4 SpD / 252 Spe\nTimid Nature\n- Sticky Web\n- Thunderbolt\n- Protect"},"steps":[{"choices":{"p1":"team 12","p2":"team 1"}},{"choices":{"p1":"move 1","p2":"move 1"},"label":"ordinary-no-web"},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-entry"},{"choices":{"p1":"move 1","p2":"move 2"},"label":"after-entry"},{"label":"after-speed-order"}]},{"id":"05-web-tera-grounding","teams":{"p1":"Slowking @ Heavy-Duty Boots\nAbility: Regenerator\nTera Type: Fairy\nEVs: 252 HP / 240 Def / 16 SpD\nSassy Nature\nIVs: 0 Atk / 0 Spe\n- Surf\n- Protect\n- Slack Off\n- Chilly Reception\n\nThundurus @ Covert Cloak\nAbility: Prankster\nTera Type: Steel\nEVs: 252 SpA / 4 SpD / 252 Spe\nTimid Nature\n- Thunder Wave\n- Protect\n- Volt Switch","p2":"Galvantula @ Leftovers\nAbility: Compound Eyes\nEVs: 252 SpA / 4 SpD / 252 Spe\nTimid Nature\n- Sticky Web\n- Thunderbolt\n- Protect"},"steps":[{"choices":{"p1":"team 12","p2":"team 1"}},{"choices":{"p1":"move 1","p2":"move 1"}},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-flying-entry"},{"choices":{"p1":"move 2 terastallize","p2":"move 1"},"label":"after-flying-entry"},{"choices":{"p1":"switch 2","p2":"move 3"}},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-steel-entry"},{"label":"after-steel-entry"}]},{"id":"06-known-levitate","teams":{"p1":"Slowking @ Heavy-Duty Boots\nAbility: Regenerator\nTera Type: Fairy\nEVs: 252 HP / 240 Def / 16 SpD\nSassy Nature\nIVs: 0 Atk / 0 Spe\n- Surf\n- Protect\n- Slack Off\n- Chilly Reception\n\nBronzong @ Mental Herb\nAbility: Levitate\nTera Type: Water\nEVs: 252 HP / 252 Def / 4 SpD\nRelaxed Nature\nIVs: 0 Spe\n- Protect\n- Gyro Ball","p2":"Forretress @ Heavy-Duty Boots\nAbility: Sturdy\nEVs: 252 HP / 252 Def / 4 SpD\nRelaxed Nature\n- Stealth Rock\n- Spikes\n- Protect\n- Tackle\n\nGalvantula @ Leftovers\nAbility: Compound Eyes\nEVs: 252 SpA / 4 SpD / 252 Spe\nTimid Nature\n- Sticky Web\n- Thunderbolt\n- Protect"},"steps":[{"choices":{"p1":"team 12","p2":"team 12"}},{"choices":{"p1":"move 2","p2":"move 1"}},{"choices":{"p1":"move 2","p2":"move 2"}},{"choices":{"p1":"move 2","p2":"switch 2"}},{"choices":{"p1":"move 2","p2":"move 1"}},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-levitate-entry"},{"label":"after-levitate-entry"}]},{"id":"07-regenerator-boundary","teams":{"p1":"Slowking @ Heavy-Duty Boots\nAbility: Regenerator\nTera Type: Fairy\nEVs: 252 HP / 240 Def / 16 SpD\nSassy Nature\nIVs: 0 Atk / 0 Spe\n- Surf\n- Protect\n- Slack Off\n- Chilly Reception\n\nScizor @ Heavy-Duty Boots\nAbility: Technician\nTera Type: Fire\nEVs: 40 HP / 252 Atk / 216 Spe\nAdamant Nature\n- Bullet Punch\n- Protect","p2":"Gardevoir @ Leftovers\nAbility: Synchronize\nEVs: 128 SpA / 128 Def / 252 Spe\nSerious Nature\n- Moonblast\n- Energy Ball\n- Protect"},"steps":[{"choices":{"p1":"team 12","p2":"team 1"}},{"choices":{"p1":"move 1","p2":"move 1"}},{"choices":{"p1":"move 1","p2":"move 1"}},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-regenerator-out"},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-regenerator-in"},{"label":"after-regenerator-in"}]},{"id":"08-tera-rock-sturdy","teams":{"p1":"Slowking @ Heavy-Duty Boots\nAbility: Regenerator\nTera Type: Fairy\nEVs: 252 HP / 240 Def / 16 SpD\nSassy Nature\nIVs: 0 Atk / 0 Spe\n- Surf\n- Protect\n- Slack Off\n- Chilly Reception\n\nArcanine-Hisui @ Choice Scarf\nAbility: Rock Head\nTera Type: Normal\nEVs: 252 Atk / 4 SpD / 252 Spe\nJolly Nature\n- Flare Blitz\n- Protect\n- Extreme Speed\n- Close Combat\n\nDonphan @ Heavy-Duty Boots\nAbility: Sturdy\nTera Type: Water\nEVs: 252 Atk / 4 Def / 252 Spe\nAdamant Nature\n- Earthquake\n- Protect\n- Knock Off\n- Rapid Spin","p2":"Forretress @ Heavy-Duty Boots\nAbility: Sturdy\nEVs: 252 HP / 252 Def / 4 SpD\nRelaxed Nature\n- Stealth Rock\n- Spikes\n- Protect\n- Tackle\n\nGardevoir @ Leftovers\nAbility: Synchronize\nEVs: 252 SpA / 4 Def / 252 Spe\nModest Nature\n- Moonblast\n- Grass Knot\n- Protect"},"steps":[{"choices":{"p1":"team 123","p2":"team 12"}},{"choices":{"p1":"move 2","p2":"move 1"}},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-rock-entry"},{"choices":{"p1":"move 2 terastallize","p2":"move 3"},"label":"after-rock-entry"},{"choices":{"p1":"switch 2","p2":"move 3"}},{"choices":{"p1":"switch 2","p2":"move 3"},"label":"before-normal-tera-entry"},{"choices":{"p1":"switch 2","p2":"switch 2"},"label":"after-normal-tera-entry"},{"choices":{"p1":"move 1","p2":"move 2"}},{"choices":{"p1":"switch 3","p2":"move 2"},"label":"before-sturdy-entry"},{"label":"after-sturdy-entry"}]}];

type Checkpoint = { snapshot: BattleSnapshot; hp: number; maxHp: number; speed: number; log: string[] };
async function nativeFixture(spec: typeof fixtures[number]) {
  const queue: Array<{type: string; data: string}> = [];
  const battle = new Battle({ formatid: "gen9uu" as ConstructorParameters<typeof Battle>[0]["formatid"], seed: "9,4,2,7", send(type, data) { queue.push({ type, data: Array.isArray(data) ? data.join("\n") : data }); } });
  const engine = new DecisionEngine({ source: "owned_offline_simulator" });
  const roomId = `battle-gen9uu-entry-test-${spec.id}`;
  let sequence = 0, rqid = 0;
  const ingest = async (data: string) => engine.ingest({ sessionId: "fixture", roomId, observationId: String(++sequence), sequence, source: "protocol", data: `>${roomId}\n${data}` });
  const flush = async () => {
    for (const packet of queue.splice(0)) {
      if (packet.type === "update") await ingest(extractChannelMessages(packet.data, [1])[1].join("\n"));
      if (packet.type === "sideupdate" && packet.data.startsWith("p1\n")) {
        for (const line of packet.data.slice(3).split("\n")) {
          assert.ok(!line.startsWith("|error|"), line);
          if (line.startsWith("|request|")) await ingest(`|request|${JSON.stringify({ ...JSON.parse(line.slice(9)), rqid: ++rqid })}`);
        }
      }
    }
  };
  const checkpoints = new Map<string, Checkpoint>();
  try {
    await ingest("|init|battle");
    for (const side of ["p1", "p2"] as const) {
      const team = Teams.import(spec.teams[side])!;
      assert.equal(TeamValidator.get("gen9uu").validateTeam(team), null);
      battle.setPlayer(side, { name: `Fixture ${side}`, team: Teams.pack(team) });
    }
    battle.sendUpdates(); await flush();
    for (const step of spec.steps) {
      if (step.label) {
        const active = battle.sides[0].active[0]!;
        checkpoints.set(step.label, { snapshot: (await engine.read("fixture", roomId)).snapshot!, hp: active.hp, maxHp: active.maxhp, speed: active.getStat("spe"), log: [...battle.log] });
      }
      if (step.choices) {
        for (const side of ["p1", "p2"] as const) {
          const choice: string = step.choices[side];
          if (side === "p1") assert.ok((await engine.read("fixture", roomId)).snapshot!.legalActions.some((a) => a.choice === choice && !a.disabled));
          assert.equal(battle.choose(side, choice), true);
        }
        battle.sendUpdates(); await flush();
      }
    }
  } finally { battle.destroy(); }
  return checkpoints;
}
const likely = (bands: ReturnType<typeof buildThreatPreview>[number]["currentTarget"]["bands"]) => bands.find((band) => band.label === "likely") ?? bands[0]!;
const incoming = (snapshot: BattleSnapshot, species: string, moveName = "Moonblast") => buildThreatPreview(snapshot, { moveCandidates: [{ name: moveName, source: "known" }] })[0]!.switchTargets.find((target) => target.species === species)!;

for (const spec of fixtures) test(`native switch-entry ${spec.id}`, async () => {
  const points = await nativeFixture(spec);
  const before = points.get("before-entry");
  if (spec.id === "01-hp-hazards" || spec.id === "02-hp-boots") {
    const state = before!.snapshot, frozen = JSON.stringify(state);
    const target = state.yourSide.team.find((mon) => mon.species === "Donphan")!;
    const projected = projectSwitchEntry(state, target, "your");
    const hp = spec.id === "01-hp-hazards" ? 221 : 321;
    assert.equal(exactSnapshotHp(projected.pokemon, 321), hp);
    assert.equal(incoming(state, "Donphan").targetCurrentHpPercent, hp / 321 * 100);
    assert.equal(likely(incoming(state, "Donphan").bands).immediate.ko, hp === 221 ? "some_rolls" : "no_ko");
    assert.equal(likely(incoming(points.get("ordinary-no-hazards")!.snapshot, "Donphan").bands).immediate.ko, "no_ko");
    assert.equal(points.get("after-entry-and-attack")!.hp, hp === 221 ? 0 : 75);
    const gen = Generations.get(9);
    assert.deepEqual(calculate(gen, new Pokemon(gen, "Gardevoir", { evs: { spa: 128, def: 128, spe: 252 } }), new Pokemon(gen, "Donphan", { evs: { atk: 252, def: 4, spe: 252 } }), new Move(gen, "Moonblast")).range(), [208, 246]);
    assert.equal(JSON.stringify(state), frozen);
  }
  if (spec.id === "05-web-tera-grounding") {
    for (const [label, expected] of [["before-flying-entry", 353], ["before-steel-entry", 235]] as const) {
      const state = points.get(label)!.snapshot;
      const intel = await buildLocalIntelSnapshot(state, await createEphemeralIntelEvaluationContext());
      assert.equal(intel.speedPreview!.switchMatchups.find((mon) => mon.species === "Thundurus")!.effectiveSpeed, expected);
    }
    assert.equal(points.get("after-flying-entry")!.speed, 353);
    assert.equal(points.get("after-steel-entry")!.speed, 235);
  }
  if (spec.id === "06-known-levitate" || spec.id === "07-regenerator-boundary" || spec.id === "08-tera-rock-sturdy") {
    const pairs = spec.id === "06-known-levitate" ? [["before-levitate-entry", "after-levitate-entry", "Bronzong", 317]] as const
      : spec.id === "07-regenerator-boundary" ? [["before-regenerator-in", "after-regenerator-in", "Slowking", 289]] as const
      : [["before-rock-entry", "after-rock-entry", "Arcanine-Hisui", 249], ["before-normal-tera-entry", "after-normal-tera-entry", "Arcanine-Hisui", 208]] as const;
    for (const [beforeLabel, afterLabel, species, hp] of pairs) {
      const state = points.get(beforeLabel)!.snapshot, original = JSON.stringify(state);
      const target = state.yourSide.team.find((mon) => mon.species === species)!;
      const entry = projectSwitchEntry(state, target, "your");
      assert.equal(exactSnapshotHp(entry.pokemon, target.stats!.hp!), hp);
      assert.equal(points.get(afterLabel)!.hp, hp);
      assert.equal(effectiveSpeed(9, target.stats!.spe!, entry.pokemon, state.field.yourSideConditions, state.field), points.get(afterLabel)!.speed);
      assert.equal(JSON.stringify(state), original);
    }
    if (spec.id === "08-tera-rock-sturdy") assert.equal(points.get("after-sturdy-entry")!.hp, 1);
  }
  if (spec.id === "03-web-scarf" || spec.id === "04-web-boots") {
    const state = before!.snapshot;
    const result = await buildLocalIntelSnapshot(state, await createEphemeralIntelEvaluationContext());
    const speed = result.speedPreview!.switchMatchups.find((mon) => mon.species === "Arcanine-Hisui")!;
    assert.equal(speed.effectiveSpeed, 306);
    assert.equal(speed.relation, "overlap");
    assert.equal(points.get("after-entry")!.speed, 306);
    if (spec.id === "03-web-scarf") {
      const clean = structuredClone(state); clean.field.yourSideConditions = [];
      const cleanIntel = await buildLocalIntelSnapshot(clean, await createEphemeralIntelEvaluationContext());
      assert.equal(cleanIntel.speedPreview!.switchMatchups.find((mon) => mon.species === "Arcanine-Hisui")!.effectiveSpeed, 459);
      assert.ok(!result.selfActionRecommendation?.rankedActions.find((a) => a.switchTargetSpecies === "Arcanine-Hisui")?.reasons.includes("faster after switching"));
    }
  }
});


test("entry projection retains exact floors, HP-sensitive calc state, uncertainty and lethal legality", async () => {
  const points = await nativeFixture(fixtures[0]!);
  const state = points.get("before-entry")!.snapshot;
  const target = state.yourSide.team.find((mon) => mon.species === "Donphan")!;
  const cleanCurrent = structuredClone(state); cleanCurrent.field.yourSideConditions = [];
  assert.deepEqual(buildThreatPreview(state, { moveCandidates: [{ name: "Moonblast", source: "known" }] })[0]!.currentTarget,
    buildThreatPreview(cleanCurrent, { moveCandidates: [{ name: "Moonblast", source: "known" }] })[0]!.currentTarget, "current active is never charged entry hazards again");
  for (const [layers, expected] of [[1, 261], [2, 248], [3, 221]] as const) {
    const branch = structuredClone(state); branch.field.yourSideConditions = ["Stealth Rock", ...Array<string>(layers).fill("Spikes")];
    assert.equal(exactSnapshotHp(projectSwitchEntry(branch, target, "your").pokemon, 321), expected);
  }
  // Exact post-entry HP changes Brine's damage; changing only outcome cannot pass.
  const branch = structuredClone(state);
  const chipped = branch.yourSide.team.find((mon) => mon.species === "Donphan")!;
  chipped.conditionText = "240/321"; chipped.hpPercent = 240 * 100 / 321;
  const entry = projectSwitchEntry(branch, chipped, "your");
  assert.equal(exactSnapshotHp(entry.pokemon, 321), 140);
  const attacking = branch.opponentSide.active!;
  attacking.species = "Slowking"; attacking.ability = "Regenerator"; attacking.item = "Leftovers";
  attacking.stats = { ...new Pokemon(Generations.get(9), "Slowking").rawStats };
  const projectedBand = likely(incoming(branch, "Donphan", "Brine").bands);
  const oracle = calculate(Generations.get(9), new Pokemon(Generations.get(9), "Slowking", { ability: "Regenerator", item: "Leftovers" }),
    new Pokemon(Generations.get(9), "Donphan", { curHP: 140, evs: { atk: 252, def: 4, spe: 252 } }), new Move(Generations.get(9), "Brine")).range().map((value) => Number((value * 100 / 321).toFixed(1)));
  assert.deepEqual([projectedBand.minPercent, projectedBand.maxPercent], oracle);
  const equality = structuredClone(state);
  equality.field.yourSideConditions = ["Spikes"];
  const equalityTarget = equality.yourSide.team.find((mon) => mon.species === "Donphan")!;
  equalityTarget.conditionText = "286/321"; equalityTarget.hpPercent = 286 * 100 / 321;
  equality.opponentSide.active!.stats = { ...new Pokemon(Generations.get(9), "Gardevoir", { evs: { spa: 128, def: 128, spe: 252 } }).rawStats };
  const atThreshold = incoming(equality, "Donphan");
  assert.equal(atThreshold.targetCurrentHpPercent, 246 / 321 * 100);
  assert.equal(likely(atThreshold.bands).immediate.ko, "some_rolls", "246 damage covers exact246HP despite rounded76.6% display");
  let observedCalls = 0;
  buildThreatPreview(equality, { moveCandidates: [{ name: "Moonblast", source: "known" }], observedThreatResolver: () => { observedCalls++; return undefined; } });
  assert.equal(observedCalls, 1, "only current target can resolve historical context; changed entry target is withheld");
  const posterior = { confidenceTier: "usable" as const, statBands: [], evidenceKinds: [], evidence: [], usedFallback: false,
    topHypotheses: [{ weight: 1, ability: "Synchronize", item: "Leftovers", teraType: null, statArchetype: "fast_spec" as const, nature: "Serious", evs: { spa: 128, def: 128, spe: 252 }, support: [] }] };
  const posteriorBand = likely(buildThreatPreview(equality, { moveCandidates: [{ name: "Moonblast", source: "known" }], attackerPosterior: posterior })[0]!.switchTargets.find((mon) => mon.species === "Donphan")!.bands);
  assert.equal(posteriorBand.immediate.ko, "some_rolls");
  assert.equal(posterior.topHypotheses[0]!.weight, 1);
  const noHazards = structuredClone(branch); noHazards.field.yourSideConditions = [];
  assert.ok(projectedBand.minPercent! > likely(incoming(noHazards, "Donphan", "Brine").bands).maxPercent!);

  for (const uncertain of [{ ...target, item: null }, { ...target, stats: undefined, conditionText: "100/100" }]) {
    const unknown = structuredClone(state); unknown.yourSide.team = unknown.yourSide.team.map((mon) => mon.species === "Donphan" ? uncertain : mon);
    const forecast = incoming(unknown, "Donphan");
    assert.equal(forecast.targetCurrentHpPercent, null);
    assert.ok(forecast.bands.every((band) => band.immediate.ko === "unknown" && band.minPercent === null && band.maxPercent === null));
    assert.match(forecast.summary, /Conditional/);
    unknown.field.yourSideConditions = [];
    assert.ok(incoming(unknown, "Donphan").bands.some((band) => Number.isFinite(band.minPercent)), "no-hazard uncertainty preserves ordinary bands");
  }
  const lethal = structuredClone(state), dying = lethal.yourSide.team.find((mon) => mon.species === "Donphan")!;
  dying.conditionText = "100/321"; dying.hpPercent = 100 * 100 / 321;
  const raw = JSON.stringify(lethal);
  assert.equal(projectSwitchEntry(lethal, dying, "your").fainted, true);
  assert.deepEqual(incoming(lethal, "Donphan").bands, []);
  const intel = await buildLocalIntelSnapshot(lethal, await createEphemeralIntelEvaluationContext());
  assert.ok(!intel.speedPreview!.switchMatchups.some((mon) => mon.species === "Donphan"));
  const candidate = intel.selfActionRecommendation!.rankedActions.find((a) => a.switchTargetSpecies === "Donphan")!;
  assert.ok(candidate.riskFlags.some((text) => /hazards KO/.test(text)));
  assert.ok(lethal.legalActions.some((action) => action.kind === "switch" && action.choice === "switch 2"));
  assert.equal(JSON.stringify(lethal), raw);

  const symmetric = structuredClone(state);
  symmetric.yourSide = { ...state.opponentSide, slot: "p1" };
  symmetric.opponentSide = { ...state.yourSide, slot: "p2" };
  symmetric.field = { ...state.field, yourSideConditions: [], opponentSideConditions: state.field.yourSideConditions };
  symmetric.legalActions = [{ id: "move:1|tera=0", kind: "move", moveSlot: 1, moveName: "Moonblast", label: "Moonblast", terastallize: false }];
  const prediction = buildOpponentActionPrediction({ snapshot: symmetric, playerDamagePreview: buildDamagePreview(symmetric) })!;
  const damage = prediction.topSwitchTargets!.find((c) => c.switchTargetSpecies === "Donphan")!.switchTargetPlayerPreview!.find((p) => p.moveName === "Moonblast")!;
  assert.ok(damage.bands.some((band) => band.immediate.ko !== "no_ko"));
  assert.ok(!damage.survivalCaveats.some((caveat) => caveat.kind === "Sturdy"));
  const baseIntel = await buildLocalIntelSnapshot(symmetric, await createEphemeralIntelEvaluationContext());
  symmetric.opponentSide.team.find((mon) => mon.species === "Donphan")!.item = null;
  const inferredBoots = baseIntel.opponents.map((entry) => entry.species !== "Donphan" ? entry : { ...entry, posterior: { ...posterior,
    topHypotheses: [0.7, 0.2, 0.1].map((weight) => ({ ...posterior.topHypotheses[0]!, weight, item: "Heavy-Duty Boots", ability: "Sturdy" })) } });
  const uncertainPrediction = buildOpponentActionPrediction({ snapshot: symmetric, allOpponentEntries: inferredBoots, playerDamagePreview: buildDamagePreview(symmetric) })!;
  const uncertainDamage = uncertainPrediction.topSwitchTargets!.find((candidate) => candidate.switchTargetSpecies === "Donphan")!.switchTargetPlayerPreview!;
  assert.ok(uncertainDamage.every((preview) => preview.bands.every((band) => band.minPercent === null && band.maxPercent === null && band.immediate.ko === "unknown")), "posterior agreement cannot turn unknown Boots into known entry protection on actual opponent switch path");

});


test("native Web stage blockers, reversal, grounding and chained rounding", () => {
  const cases = [
    ["Sturdy", "Choice Scarf", false, false], ["Clear Body", "Choice Scarf", false, false],
    ["White Smoke", "Choice Scarf", false, false], ["Full Metal Body", "Choice Scarf", false, false],
    ["Contrary", "Choice Scarf", false, false], ["Simple", "Choice Scarf", false, false],
    ["Sturdy", "Clear Amulet", false, false], ["Levitate", "Choice Scarf", false, false],
    ["Sturdy", "Air Balloon", false, false], ["Levitate", "Iron Ball", false, false],
    ["Sturdy", "Choice Scarf", true, false], ["Sturdy", "Choice Scarf", true, true],
    ["Levitate", "Air Balloon", false, true]
  ] as const;
  for (const [ability, item, flying, gravity] of cases) {
    // Custom Game isolates otherwise unavailable species/ability combinations;
    // the eight whole fixtures above separately validate legal literal UU teams.
    const battle = new Battle({ formatid: "gen9customgame" as ConstructorParameters<typeof Battle>[0]["formatid"], seed: "9,4,2,7" });
    try {
      const own = Teams.import(`Slowking @ Heavy-Duty Boots\nAbility: Regenerator\n- Protect\n\n${flying ? "Thundurus" : "Donphan"} @ ${item}\nAbility: ${ability}\nEVs: 252 Spe\nJolly Nature\n- Protect`)!;
      battle.setPlayer("p1", { name: "Fixture A", team: Teams.pack(own) });
      battle.setPlayer("p2", { name: "Fixture B", team: Teams.pack(Teams.import("Galvantula @ Heavy-Duty Boots\nAbility: Compound Eyes\n- Sticky Web\n- Gravity\n- Protect")!) });
      battle.makeChoices("team 12", "team 1");
      battle.makeChoices("move 1", "move 1");
      if (gravity) battle.makeChoices("move 1", "move 2");
      const native = battle.sides[0].pokemon[1]!;
      const target: PokemonSnapshot = { ident: "p1: Target", species: native.species.name, displayName: "Target", level: 100,
        conditionText: `${native.hp}/${native.maxhp}`, hpPercent: 100, status: null, fainted: false, active: false, revealed: true,
        boosts: {}, stats: { hp: native.maxhp, ...native.storedStats }, knownMoves: [], item, removedItem: null, ability,
        types: native.getTypes(), teraType: null, terastallized: false };
      const state = { field: { weather: null, terrain: null, pseudoWeather: gravity ? ["Gravity"] : [], yourSideConditions: ["Sticky Web"], opponentSideConditions: [] } } as unknown as BattleSnapshot;
      const projection = projectSwitchEntry(state, target, "your");
      battle.makeChoices("switch 2", "move 3");
      const entered = battle.sides[0].active[0]!;
      assert.equal(projection.speedCertain, true);
      assert.equal(projection.pokemon.boosts.spe ?? 0, entered.boosts.spe, `${ability}/${item}/${flying}/${gravity}`);
      assert.equal(effectiveSpeed(9, target.stats!.spe!, projection.pokemon, state.field.yourSideConditions, state.field), entered.getStat("spe"));
    } finally { battle.destroy(); }
  }
});

test("withheld switch bands never reassure through actual local intel or opponent summaries", async () => {
  const points = await nativeFixture(fixtures[0]!);
  const original = points.get("before-entry")!.snapshot;
  for (const kind of ["item", "percent", "max", "safe", "punished"] as const) {
    const state = structuredClone(original);
    const target = state.yourSide.team.find((mon) => mon.species === "Donphan")!;
    if (kind === "item") target.item = null;
    if (kind === "percent") target.conditionText = "69/100";
    if (kind === "max") delete target.stats!.hp;
    if (kind === "safe") {
      target.item = "Heavy-Duty Boots";
      target.stats = { ...new Pokemon(Generations.get(9), "Donphan", { nature: "Careful", evs: { hp: 252, spd: 252 } }).rawStats };
      target.conditionText = `${target.stats.hp}/${target.stats.hp}`;
      // Safety now needs every represented profile, not the old likely-only
      // 41.7% while its high profile reached50.3%. Pin this positive control.
      state.opponentSide.active!.stats = { ...new Pokemon(Generations.get(9), "Gardevoir", { evs: { spa: 128, def: 128, spe: 252 } }).rawStats };
      state.opponentSide.active!.item = "Leftovers";
      state.opponentSide.active!.ability = "Synchronize";
    }
    const raw = JSON.stringify(state);
    const intel = await buildLocalIntelSnapshot(state, await createEphemeralIntelEvaluationContext());
    const candidate = intel.selfActionRecommendation!.rankedActions.find((action) => action.switchTargetSpecies === "Donphan")!;
    if (["item", "percent", "max"].includes(kind)) {
      assert.ok(!candidate.reasons.some((reason) => /safer|absorbs|lines up well|faster after/.test(reason)), `${kind}: unknown outcome cannot imply a safe switch`);
    } else if (kind === "safe") {
      assert.ok(candidate.reasons.some((reason) => /lines up well|absorbs|safer/.test(reason)), "known safe finite outcome retains reassurance");
    } else {
      assert.ok(candidate.riskFlags.some((reason) => /pressures|broken|KO|heavy hit/.test(reason)), "known punished outcome retains its risk");
    }
    assert.equal(JSON.stringify(state), raw);
  }

  const state = structuredClone(original);
  state.field.yourSideConditions = ["Sticky Web", "Mist"];
  state.opponentSide.active!.species = "Forretress";
  state.opponentSide.active!.item = "Heavy-Duty Boots";
  state.opponentSide.active!.ability = "Sturdy";
  state.opponentSide.active!.stats = { ...new Pokemon(Generations.get(9), "Forretress", { nature: "Relaxed", ivs: { spe: 0 } }).rawStats };
  const mirrored = structuredClone(state);
  mirrored.yourSide = { ...state.opponentSide, slot: "p1" };
  mirrored.opponentSide = { ...state.yourSide, slot: "p2" };
  mirrored.field = { ...state.field, yourSideConditions: [], opponentSideConditions: state.field.yourSideConditions };
  mirrored.legalActions = [{ id: "move:1|tera=0", kind: "move", moveSlot: 1, moveName: "Gyro Ball", label: "Gyro Ball", terastallize: false }];
  const raw = JSON.stringify(mirrored);
  const prediction = buildOpponentActionPrediction({ snapshot: mirrored, playerDamagePreview: buildDamagePreview(mirrored) })!;
  const output = prediction.topSwitchTargets!.find((candidate) => candidate.switchTargetSpecies === "Donphan")!.switchTargetPlayerPreview![0]!;
  assert.ok(output.bands.every((band) => band.minPercent === null && band.maxPercent === null && band.immediate.ko === "unknown"));
  assert.ok(!/\d+(?:\.\d+)?-\d+(?:\.\d+)?%|no current-HP KO|rolls to KO|KOs current HP/.test(output.summary), "summary must describe final withheld bands");
  assert.match(output.summary, /unknown|withheld/i);
  assert.equal(JSON.stringify(mirrored), raw);

  const scores = new Map<string, number>();
  for (const kind of ["unknown", "known-safe", "none"]) {
    const branch = structuredClone(mirrored);
    branch.opponentSide.active!.hpPercent = 1;
    branch.opponentSide.active!.conditionText = "4/394";
    if (kind === "known-safe") branch.field.opponentSideConditions = ["Sticky Web"];
    if (kind === "none") branch.opponentSide.team = branch.opponentSide.team.filter((mon) => mon.active);
    const result = buildOpponentActionPrediction({ snapshot: branch, playerDamagePreview: buildDamagePreview(branch),
      opponentThreatPreview: buildThreatPreview(branch, { moveCandidates: [{ name: "Surf", source: "known" }] }) })!;
    scores.set(kind, result.topActions.find((candidate) => candidate.moveName === "Surf")!.score);
  }
  assert.equal(scores.get("unknown"), scores.get("none"), "all-null bands cannot establish safe reserve availability");
  assert.ok(scores.get("known-safe")! < scores.get("unknown")!, "known finite safe reserve retains threatened-active penalty");

  // A move-specific unknown preview cannot borrow a different move's safe band.
  const mixedState = structuredClone(original);
  mixedState.field.yourSideConditions = ["Sticky Web", "Mist"];
  const mixed = buildThreatPreview(mixedState, { moveCandidates: [{ name: "Gyro Ball", source: "known" }, { name: "Moonblast", source: "known" }] });
  const unrelated = mixed.find((preview) => preview.moveName === "Moonblast")!.switchTargets.find((target) => target.species === "Donphan")!;
  unrelated.bands = [{ label: "likely", minPercent: 10, maxPercent: 20, immediate: { ko: "no_ko", minHpLossPercent: 10, maxHpLossPercent: 20 } }];
  const actionPrediction = { topActionClass: "stay_attack" as const, confidenceTier: "high" as const, reasons: [], riskFlags: [],
    topActions: [{ type: "known_move" as const, actionClass: "stay_attack" as const, moveName: "Gyro Ball", label: "Gyro Ball", source: "known" as const, score: 80, reasons: [], riskFlags: [] }] };
  for (const empty of [false, true]) {
    const previews = structuredClone(mixed);
    if (empty) previews.find((preview) => preview.moveName === "Gyro Ball")!.switchTargets.find((target) => target.species === "Donphan")!.bands = [];
    const result = buildSelfActionRecommendation({ snapshot: mixedState, opponentThreatPreview: previews, playerDamagePreview: [], opponentActionPrediction: actionPrediction })!;
    const candidate = result.rankedActions.find((action) => action.switchTargetSpecies === "Donphan")!;
    assert.ok(!candidate.reasons.includes("lines up well into their top attacking move"));
    assert.ok(!candidate.scoreBreakdown?.some((component) => component.key === "search" && component.value > 0), "unknown specific move has no positive absence-based search value");
  }
  const withheldOnly = [structuredClone(mixed.find((preview) => preview.moveName === "Gyro Ball")!)];
  withheldOnly[0]!.currentTarget.bands = [{ label: "likely", minPercent: 110, maxPercent: 120, immediate: { ko: "all_rolls", minHpLossPercent: 100, maxHpLossPercent: 100 } }];
  withheldOnly[0]!.switchTargets.find((target) => target.species === "Donphan")!.bands = [];
  const withheldCandidate = buildSelfActionRecommendation({ snapshot: mixedState, opponentThreatPreview: withheldOnly,
    playerDamagePreview: [], opponentActionPrediction: actionPrediction })!.rankedActions.find((action) => action.switchTargetSpecies === "Donphan")!;
  assert.ok(!withheldCandidate.reasons.some((reason) => /safer|absorbs|lines up well/.test(reason)), "present-but-empty forecast is not base safe-switch evidence");
  assert.ok(!withheldCandidate.scoreBreakdown?.some((component) => ["tactical", "prediction", "preserve"].includes(component.key) && component.value > 0));
  const absentCandidate = buildSelfActionRecommendation({ snapshot: mixedState, opponentThreatPreview: [],
    playerDamagePreview: [], opponentActionPrediction: actionPrediction })!.rankedActions.find((action) => action.switchTargetSpecies === "Donphan")!;
  assert.ok(!absentCandidate.scoreBreakdown?.some((component) => component.key === "tactical" && component.value === 10), "an absent incoming table cannot establish a safe-switch bonus");

});

test("mixed unknown top attack cannot borrow a weaker known move's aggregate safety", async () => {
  const points = await nativeFixture(fixtures[0]!);
  const original = points.get("before-entry")!.snapshot;
  const rows = new Map<string, Awaited<ReturnType<typeof buildLocalIntelSnapshot>>>();
  for (const kind of ["mixed", "known-punished", "unknown-only", "known-safe", "mixed-punished"]) {
    const state = structuredClone(original);
    state.field.yourSideConditions = kind.startsWith("known-") ? [] : ["Sticky Web", "Mist"];
    const target = state.yourSide.team.find((mon) => mon.species === "Donphan")!;
    const hp = kind === "known-safe" ? 321 : kind === "mixed-punished" ? 6 : 40;
    target.hpPercent = hp / 321 * 100;
    target.conditionText = `${hp}/321`;
    const attacker = new Pokemon(Generations.get(9), "Forretress", { item: "Heavy-Duty Boots", ability: "Sturdy", nature: "Relaxed", ivs: { spe: 0 } });
    Object.assign(state.opponentSide.active!, { species: "Forretress", displayName: "Forretress", item: "Heavy-Duty Boots", ability: "Sturdy",
      stats: { ...attacker.rawStats }, types: ["Bug", "Steel"], knownMoves: kind === "unknown-only" ? ["Gyro Ball"] : ["Gyro Ball", "Tackle"] });
    Object.assign(state.opponentSide.team.find((mon) => mon.active)!, structuredClone(state.opponentSide.active));
    Object.assign(state.yourSide.active!, { terastallized: true, teraType: "Ice", hpPercent: 1, conditionText: "4/394" });
    Object.assign(state.yourSide.team.find((mon) => mon.active)!, structuredClone(state.yourSide.active));
    state.legalActions = state.legalActions.filter((action) => !action.terastallize);
    const raw = JSON.stringify(state);
    const intel = await buildLocalIntelSnapshot(state, await createEphemeralIntelEvaluationContext());
    rows.set(kind, intel);
    const candidate = intel.selfActionRecommendation!.rankedActions.find((action) => action.switchTargetSpecies === "Donphan")!;
    if (kind !== "known-safe") assert.ok(!candidate.reasons.some((reason) => (kind === "known-punished" ? /safer|absorbs|lines up well/ : /safer|absorbs|lines up well|best against|gains value across|preserves a pressured/).test(reason)), `${kind}: no aggregate safe-switch reassurance`);
    else assert.ok(candidate.reasons.some((reason) => /safer|absorbs|lines up well/.test(reason)), "all known safe attacks retain affirmative reassurance");
    assert.equal(JSON.stringify(state), raw);
  }
  const mixed = rows.get("mixed")!;
  const gyro = mixed.opponentThreatPreview!.find((preview) => preview.moveName === "Gyro Ball")!.switchTargets.find((target) => target.species === "Donphan")!;
  const tackle = mixed.opponentThreatPreview!.find((preview) => preview.moveName === "Tackle")!.switchTargets.find((target) => target.species === "Donphan")!;
  assert.ok(gyro.bands.every((band) => band.minPercent === null && band.immediate.ko === "unknown"));
  assert.equal(likely(tackle.bands).immediate.ko, "no_ko");
  assert.deepEqual([likely(tackle.bands).minPercent, likely(tackle.bands).maxPercent], [7.2, 8.7]);
  assert.equal(mixed.opponentActionPrediction!.topActions[0]!.moveName, "Gyro Ball");
  const candidate = mixed.selfActionRecommendation!.rankedActions.find((action) => action.switchTargetSpecies === "Donphan")!;
  assert.ok(candidate.riskFlags.some((reason) => /unknown.*matchup|matchup.*unknown/.test(reason)));
  assert.ok(candidate.scoreBreakdown?.filter((component) => component.key === "search").every((component) => /conditional/i.test(component.label)));
  const punished = rows.get("known-punished")!;
  const knownGyro = punished.opponentThreatPreview!.find((preview) => preview.moveName === "Gyro Ball")!.switchTargets.find((target) => target.species === "Donphan")!;
  assert.equal(likely(knownGyro.bands).immediate.ko, "all_rolls");
  assert.ok(punished.selfActionRecommendation!.rankedActions.find((action) => action.switchTargetSpecies === "Donphan")!.riskFlags.some((reason) => /pressures|broken|KO/.test(reason)));
  const mixedPunished = rows.get("mixed-punished")!;
  const knownTackle = mixedPunished.opponentThreatPreview!.find((preview) => preview.moveName === "Tackle")!.switchTargets.find((target) => target.species === "Donphan")!;
  assert.equal(likely(knownTackle.bands).immediate.ko, "all_rolls");
  assert.ok(mixedPunished.selfActionRecommendation!.rankedActions.find((action) => action.switchTargetSpecies === "Donphan")!.scoreBreakdown?.some((component) => component.key === "risk" && component.value <= -24), "known punitive finite band remains usable alongside unknown attack");

});

test("immediate survival, all-profile support and hit accuracy govern KO credit and reply forecasts", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = JSON.parse(await readFile(new URL("../../../../examples/battle-snapshot.gen9ou.turn14.json", import.meta.url), "utf8")) as BattleSnapshot;
  state.turn = 2; state.phase = "turn"; state.pendingAttacks = [];
  const own = { ...state.yourSide.active!, species: "Inteleon", displayName: "Inteleon", hpPercent: 100, knownMoves: ["Surf"], boosts: {}, fainted: false };
  const foe = { ...state.opponentSide.active!, species: "Donphan", displayName: "Donphan", hpPercent: 100, knownMoves: ["Earthquake"], boosts: {}, status: null, fainted: false };
  state.yourSide.active = own; state.yourSide.team = [own]; state.opponentSide.active = foe; state.opponentSide.team = [foe];
  state.legalActions = [{ id: "move:surf", kind: "move", label: "Surf", moveName: "Surf", moveId: "surf", choice: "move 1", disabled: false }];
  const band = (ko: "all_rolls" | "some_rolls" | "conditional" | "no_ko" | "unknown", min: number | null, max = min) => ({ label: "likely", minPercent: 140, maxPercent: 166,
    outcome: "damage" as const, immediate: { ko, minHpLossPercent: min, maxHpLossPercent: max } });
  const preview = (bands: ReturnType<typeof band>[]) => [{ actionId: "move:surf", label: "Surf", moveName: "Surf", targetName: "Donphan", category: "Special" as const, bands,
    summary: "Raw pressure", survivalCaveats: [], interactionHints: [] }];
  const threats = [{ moveName: "Earthquake", moveSource: "known" as const, targetName: "Inteleon", currentTarget: { species: "Inteleon", relation: "faster" as const,
    bands: [{ ...band("no_ko", 20, 30), minPercent: 20, maxPercent: 30 }], summary: "Reply", interactionHints: [] }, switchTargets: [], summary: "Reply" }];
  const prediction = { topActionClass: "stay_attack" as const, confidenceTier: "high" as const, reasons: [], riskFlags: [], topActions: [{ type: "known_move" as const,
    actionClass: "stay_attack" as const, moveName: "Earthquake", label: "Earthquake", source: "known" as const, score: 100, reasons: [], riskFlags: [] }] };
  const speed = { activeRelation: "faster", switchMatchups: [] } as unknown as Parameters<typeof buildSelfActionRecommendation>[0]["speedPreview"];
  const recommend = (bands: ReturnType<typeof band>[], input = state) => buildSelfActionRecommendation({ snapshot: input, playerDamagePreview: preview(bands), opponentThreatPreview: threats,
    speedPreview: speed, opponentActionPrediction: prediction })!.rankedActions[0]!;
  const protectedHit = recommend([band("no_ko", 99.7)]), ordinary = recommend([band("all_rolls", 100)]);
  assert.ok(ordinary.score > protectedHit.score, "survival protection removes clean-KO credit and keeps the reply live");
  assert.ok(ordinary.reasons.some((reason) => /can KO|clean KO/.test(reason)));
  for (const bands of [[band("conditional", null)], [band("unknown", null)], [band("all_rolls", 100), { ...band("no_ko", 99.7), label: "conservative" }]]) {
    const candidate = recommend(bands);
    assert.ok(!candidate.reasons.some((reason) => /can KO|clean KO|KO roll/.test(reason)), "likely alone cannot certify KO across another surviving/unknown profile");
    assert.ok(candidate.score < ordinary.score);
  }
  const search = (candidate: ReturnType<typeof recommend>) => candidate.scoreBreakdown?.find((component) => component.key === "search")?.value ?? 0;
  const modestLoss = recommend([band("no_ko", 30)]);
  assert.ok(search(protectedHit) > search(modestLoss), "forecast HP swing uses supported HP-loss bounds");
  const inflatedRaw = { ...band("no_ko", 30), minPercent: 1000, maxPercent: 1200 };
  assert.equal(search(recommend([inflatedRaw])), search(modestLoss), "raw pressure is not forecast HP loss");
  const inaccurateState = structuredClone(state); inaccurateState.legalActions[0]!.moveName = "Hydro Pump";
  const inaccuratePreview = preview([band("all_rolls", 100)]); inaccuratePreview[0]!.moveName = "Hydro Pump";
  const inaccurate = buildSelfActionRecommendation({ snapshot: inaccurateState, playerDamagePreview: inaccuratePreview, opponentThreatPreview: threats, speedPreview: speed, opponentActionPrediction: prediction })!.rankedActions[0]!;
  assert.ok(search(inaccurate) < search(ordinary), "a missed-hit reply is retained for lower accuracy");
  const setupState = structuredClone(state); setupState.legalActions = [{ id: "move:setup", kind: "move", label: "Swords Dance", moveName: "Swords Dance", choice: "move 1" }];
  const unresolved = structuredClone(threats); unresolved[0]!.currentTarget.bands = [band("unknown", null)];
  const setup = buildSelfActionRecommendation({ snapshot: setupState, opponentThreatPreview: unresolved })!.rankedActions[0]!;
  assert.ok(!setup.reasons.includes("safe enough board to set up"));
  // A known incoming attack must remain a penalty even when our immediate
  // outgoing HP loss is zero or unavailable. No favorable unknown loss is used.
  const forecast = (moveName: string, ownBands: ReturnType<typeof band>[], enemyBands: ReturnType<typeof band>[]) => {
    const input = structuredClone(state);
    input.legalActions[0]!.moveName = moveName;
    input.legalActions[0]!.label = moveName;
    const ownPreview = preview(ownBands); ownPreview[0]!.moveName = moveName;
    const replies = structuredClone(threats); replies[0]!.currentTarget.bands = enemyBands;
    return buildSelfActionRecommendation({ snapshot: input, playerDamagePreview: ownPreview, opponentThreatPreview: replies,
      speedPreview: speed, opponentActionPrediction: prediction })!.rankedActions[0]!;
  };
  const zero = band("no_ko", 0), unknown = band("unknown", null);
  for (const moveName of ["Future Sight", "Stealth Rock", "Surf"]) {
    const withReply = forecast(moveName, [zero], [band("no_ko", 30)]);
    const noLossReply = forecast(moveName, [zero], [zero]);
    assert.equal(search(withReply), search(noLossReply) - 3, `${moveName}: ordinary enemy reply still removes 30% HP`);
    assert.match(withReply.scoreBreakdown!.find((component) => component.key === "search")!.label, /conditional on hit/i);
  }
  assert.equal(search(forecast("Surf", [unknown], [band("no_ko", 30)])), search(forecast("Surf", [zero], [band("no_ko", 30)])),
    "unresolved outgoing loss contributes conservative zero while retaining known incoming loss");
  assert.equal(search(forecast("Surf", [band("no_ko", 90)], [unknown])), search(forecast("Surf", [zero], [unknown])),
    "unknown incoming loss cannot yield favorable HP swing");
  const rawThreat = [{ ...threats[0]!, currentTarget: { ...threats[0]!.currentTarget, bands: [band("no_ko", 99.7)], relation: "slower" as const } }];
  const opponent = buildOpponentActionPrediction({ snapshot: state, playerDamagePreview: [], opponentThreatPreview: rawThreat });
  assert.ok(!opponent?.topActions.some((candidate) => candidate.reasons.some((reason) => /can KO|KO roll/.test(reason))), "opponent scorer also uses survival-aware outcome");
});


// Sanitized T4 values from the closed legal UU Ice Face entry trace. The bench
// Noice had private 354/354 HP and these stats; entry into existing Snow restored
// Ice Face before Iron Head (zero HP loss). No native battle is advanced here.
function noiceEntryState(): BattleSnapshot {
  const mon = (species: string, ident: string, stats: PokemonSnapshot["stats"], active: boolean, ability: string | null, hp: string): PokemonSnapshot => ({
    ident, instanceId: ident, identityStatus: "resolved", species, displayName: species, level: 100,
    conditionText: hp, hpPercent: Number(hp.split("/")[0]) / Number(hp.split("/")[1]) * 100,
    status: null, fainted: false, active, revealed: true, boosts: {}, stats, knownMoves: [],
    item: null, removedItem: null, ability, types: [], teraType: null, terastallized: false
  });
  const slowking = mon("Slowking", "p2: Slowking", { hp: 394, atk: 167, def: 284, spa: 236, spd: 257, spe: 96 }, true, "Regenerator", "364/394");
  const noice = mon("Eiscue-Noice", "p2: Eiscue", { hp: 354, atk: 196, def: 177, spa: 149, spd: 136, spe: 394 }, false, "Ice Face", "354/354");
  const scizor = mon("Scizor", "p1: Scizor", {}, true, null, "71/100");
  scizor.item = "Life Orb"; scizor.knownMoves = ["Iron Head", "Flash Cannon"];
  return { version: "0.1", capturedAt: "2026-10-19T00:00:00.000Z", roomId: "battle-gen9uu-entry-form-test", title: "Entry form", format: "[Gen 9] UU", turn: 4, phase: "turn",
    yourSide: { slot: "p2", name: "Own", active: slowking, team: [slowking, noice] },
    opponentSide: { slot: "p1", name: "Other", active: scizor, team: [scizor] },
    field: { weather: "Snowscape", terrain: null, pseudoWeather: [], yourSideConditions: [], opponentSideConditions: [] },
    legalActions: [{ id: "move:1|tera=0", kind: "move", label: "Slack Off", moveName: "Slack Off", choice: "move 1", moveSlot: 1, terastallize: false },
      { id: "switch:2", kind: "switch", label: "Switch to Eiscue-Noice", target: noice.ident, targetInstanceId: noice.instanceId, targetSlot: 2, choice: "switch 2" }],
    recentLog: [], notes: [] } as BattleSnapshot;
}
const unknownEntryBands = (bands: DamageAssumptionBand[]) => {
  assert.ok(bands.length > 0, "unknown damage retains explicit rows");
  for (const band of bands) {
    assert.equal(band.minPercent, null); assert.equal(band.maxPercent, null);
    assert.deepEqual(band.immediate, { ko: "unknown", minHpLossPercent: null, maxHpLossPercent: null });
    assert.equal(band.outcome, undefined);
    assert.match(band.detail!, /entry form/i);
    assert.ok(!/\d+(?:\.\d+)?%/.test(band.detail!), "no stale numeric detail");
  }
};

test("R40 closed Noice entry withholds raw, observed, posterior and delayed forecasts without changing HP", () => {
  const state = noiceEntryState(), target = state.yourSide.team[1]!;
  const frozen = JSON.stringify(state), entry = projectSwitchEntry(state, target, "your");
  unknownEntryBands(incoming(state, "Eiscue-Noice", "Iron Head").bands);
  assert.equal(entry.damageQualified, false); assert.equal(entry.speedCertain, false);
  assert.equal(entry.hpCertain, true); assert.equal(exactSnapshotHp(entry.pokemon, 354), 354);
  assert.equal(entry.pokemon.species, "Eiscue-Noice"); assert.deepEqual(entry.pokemon.stats, target.stats);
  const posterior = { confidenceTier: "usable" as const, statBands: [], evidenceKinds: [], evidence: [], usedFallback: false,
    topHypotheses: [{ weight: 1, ability: "Technician", item: "Life Orb", teraType: null, statArchetype: "fast_phys" as const, nature: "Adamant", evs: { atk: 252, spe: 252 }, support: [] }] };
  for (const move of ["Iron Head", "Flash Cannon", "Gyro Ball", "Electro Ball", "Future Sight"]) {
    for (const withPosterior of [false, true]) {
      const preview = buildThreatPreview(state, { moveCandidates: [{ name: move, source: "known" }],
        observedThreatResolver: () => ({ minPercent: 0, maxPercent: 0, sampleCount: 9, source: "context" }),
        ...(withPosterior ? { attackerPosterior: posterior } : {}) })[0]!;
      const forecast = preview.switchTargets[0]!;
      unknownEntryBands(forecast.delayed?.bands ?? forecast.bands);
      assert.equal(forecast.targetCurrentHpPercent, 100);
      assert.equal(forecast.observedRange, undefined); assert.equal(forecast.likelyBandSource, undefined);
      assert.deepEqual(forecast.interactionHints, []);
      assert.ok(!/\d+(?:\.\d+)?-\d+(?:\.\d+)?%|rolls to KO|no current-HP KO/.test(forecast.summary));
      assert.ok((preview.currentTarget.delayed?.bands ?? preview.currentTarget.bands).some((band) => band.minPercent !== null), "current active stays ordinary");
    }
  }
  assert.equal(posterior.topHypotheses[0]!.weight, 1); assert.equal(JSON.stringify(state), frozen);
});

test("R40 entry form qualification keeps hazard HP and ordinary active/no-snow/known-other-ability controls", () => {
  for (const weather of ["Snowscape", "Snow", "Hail"]) for (const item of [null, "Ability Shield"]) for (const ability of [null, "Ice Face"]) for (const opponentAbility of ["Mold Breaker", "Cloud Nine"]) {
    const state = noiceEntryState(), target = state.yourSide.team[1]!;
    state.field.weather = weather; target.item = item; target.ability = ability;
    state.opponentSide.active!.ability = opponentAbility;
    const entry = projectSwitchEntry(state, target, "your");
    assert.equal(entry.damageQualified, false); assert.equal(entry.speedCertain, false); assert.equal(entry.hpCertain, true);
  }
  for (const kind of ["no-snow", "other-ability", "active", "intact"] as const) {
    const state = noiceEntryState(), target = state.yourSide.team[1]!;
    if (kind === "no-snow") state.field.weather = null;
    if (kind === "other-ability") target.ability = "Swift Swim";
    if (kind === "active") target.active = true;
    if (kind === "intact") target.species = "Eiscue";
    assert.equal(projectSwitchEntry(state, target, "your").damageQualified, true, kind);
  }
  const state = noiceEntryState(), target = state.yourSide.team[1]!;
  target.item = "Leftovers"; state.field.yourSideConditions = ["Stealth Rock"];
  const chip = projectSwitchEntry(state, target, "your");
  assert.equal(chip.hpCertain, true); assert.equal(exactSnapshotHp(chip.pokemon, 354), 266); assert.equal(chip.damageQualified, false);
  target.conditionText = "88/354"; target.hpPercent = 88 / 354 * 100;
  const dead = projectSwitchEntry(state, target, "your"); assert.equal(dead.fainted, true);
  const preview = incoming(state, "Eiscue-Noice", "Iron Head"); assert.deepEqual(preview.bands, []); assert.match(preview.summary, /hazards KO/);
  target.item = null;
  const conditional = projectSwitchEntry(state, target, "your"); assert.equal(conditional.hpCertain, false); assert.equal(conditional.fainted, false); assert.equal(conditional.pokemon.hpPercent, null);
  state.field.yourSideConditions = ["Spikes"]; target.item = "Leftovers"; target.ability = null;
  assert.equal(projectSwitchEntry(state, target, "your").hpCertain, true, "known Eiscue ability support does not introduce grounding ambiguity");
});

test("R40 self consumers reject stale safe and faster inputs, even with empty incoming attacks; fresh active request stays authoritative", async () => {
  const state = noiceEntryState(), target = state.yourSide.team[1]!;
  const threats = buildThreatPreview(state, { moveCandidates: [{ name: "Iron Head", source: "known" }] });
  const stale = structuredClone(threats);
  stale[0]!.switchTargets[0]!.bands = [{ label: "likely", minPercent: 0, maxPercent: 0, outcome: "immune", immediate: { ko: "no_ko", minHpLossPercent: 0, maxHpLossPercent: 0 } }];
  stale[0]!.switchTargets[0]!.relation = "faster";
  const intel = await buildLocalIntelSnapshot(state, await createEphemeralIntelEvaluationContext());
  assert.ok(!intel.speedPreview?.switchMatchups.some((row) => row.instanceId === target.instanceId));
  const speed = { ...intel.speedPreview!, switchMatchups: [{ instanceId: target.instanceId, species: "Eiscue-Noice", effectiveSpeed: 394, relation: "faster" as const }] };
  const prediction = buildOpponentActionPrediction({ snapshot: state, playerDamagePreview: buildDamagePreview(state), opponentThreatPreview: threats })!;
  for (const incomingThreats of [stale, []]) {
    const recommendation = buildSelfActionRecommendation({ snapshot: state, playerDamagePreview: buildDamagePreview(state), opponentThreatPreview: incomingThreats, speedPreview: speed, opponentActionPrediction: prediction })!;
    const choice = recommendation.rankedActions.find((row) => row.switchTargetSpecies === "Eiscue-Noice")!;
    assert.ok(!choice.reasons.some((text) => /faster|safer|absorbs|immunity|lines up well|covers hidden/.test(text)));
    assert.ok(choice.riskFlags.some((text) => /entry form/i.test(text)));
    assert.equal(choice.scoreBreakdown?.find((row) => row.key === "board")?.value ?? 0, 0);
  }
  const paired = (rows: typeof threats, relation: "faster" | "unknown") => buildSelfActionRecommendation({ snapshot: state,
    playerDamagePreview: buildDamagePreview(state), opponentThreatPreview: rows, opponentActionPrediction: prediction,
    speedPreview: { ...speed, switchMatchups: [{ ...speed.switchMatchups[0]!, relation }] } })!.rankedActions.find((row) => row.kind === "switch")!;
  assert.deepEqual(paired(stale, "faster").scoreBreakdown, paired(threats, "unknown").scoreBreakdown,
    "stale zero-damage and faster previews cannot add reply-search HP swing or tempo value");
  const active = structuredClone(state); active.yourSide.active = active.yourSide.team[1]!; active.yourSide.team[0]!.active = false; active.yourSide.active.active = true;
  const ordinary = buildThreatPreview(active, { moveCandidates: [{ name: "Iron Head", source: "known" }] })[0]!.currentTarget;
  assert.ok(ordinary.bands.some((band) => band.minPercent !== null), "T3 active Noice under existing Snow uses the authoritative request stats");
  active.yourSide.active.species = "Eiscue"; active.yourSide.active.stats = { hp: 354, atk: 196, def: 257, spa: 149, spd: 216, spe: 218 };
  assert.ok(buildThreatPreview(active, { moveCandidates: [{ name: "Iron Head", source: "known" }] })[0]!.currentTarget.bands.every((band) => band.immediate.maxHpLossPercent === 0), "fresh intact form retains R39 qualification");
});

test("R40 opponent switch previews withhold physical, special and delayed bands and defensive reassurance", () => {
  const own = noiceEntryState();
  const state = { ...own, yourSide: own.opponentSide, opponentSide: own.yourSide, field: { ...own.field, yourSideConditions: [], opponentSideConditions: [] } };
  for (const move of ["Iron Head", "Flash Cannon", "Gyro Ball", "Future Sight"]) {
    state.legalActions = [{ id: "move:1|tera=0", kind: "move", moveSlot: 1, moveName: move, label: move, terastallize: false }];
    const frozen = JSON.stringify(state);
    const prediction = buildOpponentActionPrediction({ snapshot: state, playerDamagePreview: buildDamagePreview(state) })!;
    const choice = prediction.topSwitchTargets!.find((row) => row.switchTargetSpecies === "Eiscue-Noice")!;
    const preview = choice.switchTargetPlayerPreview![0]!;
    unknownEntryBands(preview.delayed?.bands ?? preview.bands);
    assert.equal(preview.observedRange, undefined); assert.equal(preview.likelyBandSource, undefined);
    assert.deepEqual(preview.interactionHints, []); assert.deepEqual(preview.survivalCaveats, []);
    assert.ok(!/\d+(?:\.\d+)?-\d+(?:\.\d+)?%/.test(preview.summary));
    assert.ok(!choice.reasons.some((text) => /absorbs|safer|immunity/.test(text)));
    assert.equal(JSON.stringify(state), frozen);
  }
});


test("R40 R2 incoming delayed summary distinguishes unknown eventual damage from zero immediate damage", () => {
  const state = noiceEntryState(), frozen = JSON.stringify(state);
  const forecast = incoming(state, "Eiscue-Noice", "Future Sight");
  unknownEntryBands(forecast.delayed!.bands);
  assert.equal(forecast.delayed!.immediateDamagePercent, 0);
  assert.match(forecast.summary, /zero immediate damage/);
  assert.match(forecast.summary, /Conditional eventual matchup: conservative unknown damage; likely unknown damage; high unknown damage/);
  assert.doesNotMatch(forecast.summary, /no direct damage/);
  assert.equal(JSON.stringify(state), frozen);

  const ordinary = structuredClone(state); ordinary.field.weather = null;
  const delayed = incoming(ordinary, "Eiscue-Noice", "Future Sight");
  assert.ok(delayed.delayed!.bands.every((band) => band.minPercent !== null && band.maxPercent !== null));
  assert.equal(delayed.delayed!.immediateDamagePercent, 0);
  assert.match(delayed.summary, /zero immediate damage/); assert.doesNotMatch(delayed.summary, /unknown damage/);
  assert.equal(delayed.delayed!.scheduling, forecast.delayed!.scheduling);
  const immediate = incoming(ordinary, "Eiscue-Noice", "Iron Head");
  assert.equal(immediate.delayed, undefined); assert.ok(immediate.bands.some((band) => band.minPercent !== null));
  assert.doesNotMatch(immediate.summary, /zero immediate damage|eventual matchup/);

  const immune = structuredClone(ordinary), target = immune.yourSide.team[1]!;
  target.species = "Umbreon"; target.types = ["Dark"]; target.ability = "Synchronize";
  const zero = incoming(immune, "Umbreon", "Future Sight");
  assert.ok(zero.delayed!.bands.every((band) => band.minPercent === 0 && band.maxPercent === 0));
  assert.match(zero.summary, /Conditional eventual matchup: immune 0%/);
  assert.doesNotMatch(zero.summary, /unknown damage/);
});


test("R41 ordinary conditional entry retains eventual damage and legacy immediate uncertainty notes", () => {
  const own = noiceEntryState(), target = own.yourSide.team[1]!;
  target.species = "Donphan"; target.displayName = "Donphan"; target.ability = "Sturdy"; target.types = ["Ground"];
  target.stats = { hp: 321, atk: 372, def: 277, spa: 140, spd: 156, spe: 199 }; target.conditionText = "321/321";
  own.field.yourSideConditions = ["Stealth Rock"];
  const state = { ...own, yourSide: own.opponentSide, opponentSide: own.yourSide,
    field: { ...own.field, yourSideConditions: [], opponentSideConditions: ["Stealth Rock"] },
    legalActions: [{ id: "move:1|tera=0", kind: "move" as const, moveSlot: 1, moveName: "Future Sight", label: "Future Sight", terastallize: false }] };
  const frozen = JSON.stringify(state);
  const choice = buildOpponentActionPrediction({ snapshot: state, playerDamagePreview: buildDamagePreview(state) })!.topSwitchTargets!.find((row) => row.switchTargetSpecies === "Donphan")!;
  const future = choice.switchTargetPlayerPreview![0]!;
  assert.ok(future.delayed!.bands.every((band) => band.minPercent !== null && band.maxPercent !== null), "ordinary conditional HP retains numerical eventual raw damage");
  assert.ok(future.delayed!.bands.every((band) => band.immediate.note === "Immediate outcome is unavailable."));
  assert.equal(future.targetCurrentHpPercent, null); assert.equal(future.delayed!.immediateDamagePercent, 0);
  assert.match(future.summary, /Conditional eventual matchup: conservative \d/);
  assert.doesNotMatch(future.summary, /eventual matchup is unknown|entry form/i);
  assert.equal(JSON.stringify(state), frozen);

  for (const move of ["Iron Head", "Future Sight", "Gyro Ball"]) {
    const incomingPreview = incoming(own, "Donphan", move);
    const bands = incomingPreview.delayed?.bands ?? incomingPreview.bands;
    assert.ok(bands.length > 0);
    assert.ok(bands.every((band) => band.minPercent === null && band.maxPercent === null
      && band.immediate.ko === "unknown" && band.immediate.note === "Immediate outcome is unavailable."), "ordinary incoming HP withholding retains its legacy note");
  }
  target.item = "Heavy-Duty Boots";
  assert.ok(incoming(own, "Donphan", "Iron Head").bands.every((band) => band.minPercent !== null), "certain ordinary protection retains numeric immediate forecasts");
  const form = noiceEntryState();
  for (const move of ["Iron Head", "Future Sight"]) {
    const preview = incoming(form, "Eiscue-Noice", move);
    unknownEntryBands(preview.delayed?.bands ?? preview.bands);
    assert.doesNotMatch(preview.summary, /no direct damage/);
  }
});
