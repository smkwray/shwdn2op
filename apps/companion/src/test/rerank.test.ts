import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DecisionEnvelope } from "../battle-agent/battleAgent.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-rerank-"));
process.env.LOCAL_INTEL_STORE_PATH = path.join(directory, "history.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(directory, "curated.json");
after(() => fs.rm(directory, { recursive: true, force: true }));
const { computeTacticalGuards } = await import("../battle-agent/tacticalGuards.js");
const { rerankDistribution, coupledRerankPick, rerankDecision, rerankSeedKey, RerankedMetamonPolicy, decisionUniforms, DEFAULT_RERANK_CONFIG } = await import("../battle-agent/rerank.js");
const { MetamonBattlePolicy, TRAPPED_SWITCH_ERROR } = await import("../battle-agent/metamon.js");
const { runBattleMatch } = await import("../battle-agent/simulator.js");
const { DeterministicBattlePolicy } = await import("../battle-agent/battleAgent.js");

// Engine-shaped envelopes for tactical states (concrete stats and bands, ladder prior).
const band = (label: string, min: number, max: number) => ({ label, minPercent: min, maxPercent: max, immediate: { ko: "unknown", minHpLossPercent: null, maxHpLossPercent: null } });
const bands = (min: number, max: number) => [band("conservative", min * 0.9, max * 0.9), band("likely", min, max), band("high", min * 1.1, max * 1.1)];
const move = (slot: number, name: string, tera = false) => ({ id: `move:${slot}|tera=${tera ? 1 : 0}`, kind: "move", label: `${tera ? "Tera + " : ""}${name}`, moveName: name, moveSlot: slot, terastallize: tera, choice: `move ${slot}${tera ? " terastallize" : ""}` });
const swap = (slot: number, name: string) => ({ id: `switch:${slot}`, kind: "switch", label: `Switch to ${name}, slot ${slot}`, targetSlot: slot, targetInstanceId: `p1:${slot}`, choice: `switch ${slot}` });
function scizorVsMetagross(overrides: { hp?: number; relation?: string; threats?: any[]; reason?: string; item?: string | null; status?: string | null } = {}) {
  const hp = overrides.hp ?? 16.2;
  const actions = ["Swords Dance", "Bullet Punch", "Knock Off", "Close Combat"].flatMap((name, i) => [move(i + 1, name), move(i + 1, name, true)]);
  const envelope = { resultHash: "r", semantic: {
    identity: { roomId: "battle-gen9uu-t", rqid: 94, snapshotHash: "s", legalActionSetHash: "l", stateRevision: 7, requestKind: "move" },
    capabilities: { status: "degraded", limitations: [], actionable: true },
    snapshot: { phase: "turn", turn: 31, format: "[Gen 9] UU", rawRequestSummary: { requestKind: "move", wait: false },
      field: { weather: null, terrain: null, pseudoWeather: [], yourSideConditions: [], opponentSideConditions: [] },
      yourSide: { slot: "p1", active: { species: "Scizor", hpPercent: hp, ability: "technician", item: "heavydutyboots", types: ["Bug", "Steel"], teraType: "Fire", terastallized: false, boosts: {}, fainted: false },
        team: [{ species: "Fezandipiti", instanceId: "p1:3", hpPercent: 52.9, fainted: false, active: false }] },
      opponentSide: { slot: "p2", active: { species: "Metagross", instanceId: "p2:3", hpPercent: 76, item: overrides.item === undefined ? null : overrides.item, removedItem: null,
        status: overrides.status ?? null, types: ["Steel", "Psychic"], appearanceMoves: ["Earthquake"], fainted: false }, team: [{ terastallized: true }] },
      legalActions: [...actions, swap(3, "Fezandipiti")], pendingAttacks: [] },
    localIntel: {
      playerDamagePreview: [
        { actionId: "move:1|tera=0", moveName: "Swords Dance", bands: [] },
        { actionId: "move:2|tera=0", moveName: "Bullet Punch", bands: bands(28.5, 33.8) },
        { actionId: "move:3|tera=0", moveName: "Knock Off", bands: bands(122.5, 144.4) },
        { actionId: "move:4|tera=0", moveName: "Close Combat", bands: bands(75.8, 89.4) }],
      opponentThreatPreview: overrides.threats ?? [
        { moveName: "Earthquake", moveSource: "known", currentTarget: { species: "Scizor", targetCurrentHpPercent: hp, bands: bands(63.6, 74.9) },
          switchTargets: [{ instanceId: "p1:3", species: "Fezandipiti", targetCurrentHpPercent: 52.9, bands: bands(80.5, 94.7), summary: "" }] },
        { moveName: "Knock Off", moveSource: "known", currentTarget: { species: "Scizor", targetCurrentHpPercent: hp, bands: bands(61.5, 72.5) },
          switchTargets: [{ instanceId: "p1:3", species: "Fezandipiti", targetCurrentHpPercent: 52.9, bands: bands(12.9, 15.3), summary: "" }] }],
      speedPreview: { activeRelation: overrides.relation ?? "slower", reason: overrides.reason ?? "current_turn_order", confounders: [], evidence: [],
        effectiveRange: { min: 234, max: 262 }, yourActiveEffectiveSpeed: 220, switchMatchups: [], historyNotes: [] },
      opponents: [{ instanceId: "p2:3", species: "Metagross", likelyItems: [{ name: "Choice Band", share: 0.3 }, { name: "Assault Vest", share: 0.19 }] }]
    } } };
  return envelope as unknown as DecisionEnvelope & { semantic: any };
}
const byKind = (envelope: DecisionEnvelope, kind: string) => computeTacticalGuards(envelope).guards.filter((guard) => guard.kind === kind);

// Matters: a certainly faster Metagross with a revealed, 100%-accurate Earthquake that KOs at the
// set prior's min roll makes every non-priority stay (Swords Dance, Knock Off, Close Combat) a pre-move KO; Bullet
// Punch (+1) and the switch must stay unpenalized or the re-ranker removes the only useful plays.
test("pre-move KO: certain order and a revealed min-roll KO penalize exactly the non-priority stays", () => {
  const report = computeTacticalGuards(scizorVsMetagross());
  const red = report.guards.filter((guard) => guard.kind === "pre_move_ko" && guard.severity === "red");
  assert.deepEqual(red.flatMap((guard) => guard.actionIds).sort(), ["move:1|tera=0", "move:1|tera=1", "move:3|tera=0", "move:3|tera=1", "move:4|tera=0", "move:4|tera=1"]);
  assert.deepEqual(report.flagged["move:3|tera=0"], ["pre_move_ko"]);
  for (const id of ["move:2|tera=0", "move:2|tera=1", "switch:3"]) assert.equal(report.flagged[id], undefined, id);
  assert.match(red[0]!.message, /Metagross moves first \(Speed 234–262 vs your 220\); its Earthquake KOs Scizor/);
});

// Matters: Scizor's Bullet Punch (+1) never runs when a faster Basculegion's known Aqua Jet
// (+1) KOs first. At equal priority the Speed order decides, so our priority move is a pre-move KO too, and the message
// must not tell the owner it only applies to non-priority moves.
test("pre-move KO: an equal-priority reply from a faster opponent also KOs before our priority move", () => {
  const envelope = scizorVsMetagross({ threats: [{ moveName: "Bullet Punch", moveSource: "known",
    currentTarget: { species: "Scizor", targetCurrentHpPercent: 16.2, bands: bands(20, 24) }, switchTargets: [] }] });
  envelope.semantic.snapshot.opponentSide.active.appearanceMoves = ["Bullet Punch"];
  const red = byKind(envelope, "pre_move_ko").filter((guard) => guard.severity === "red");
  const tie = red.find((guard) => guard.actionIds.includes("move:2|tera=0"));
  assert.ok(tie, "our Bullet Punch is KO'd first");
  assert.match(tie.message, /^Metagross moves first.*before Scizor moves\.$/);
  assert.ok(red.every((guard) => !/non-priority/.test(guard.message)));
  const slower = scizorVsMetagross({ relation: "faster", threats: envelope.semantic.localIntel.opponentThreatPreview });
  Object.assign(slower.semantic.localIntel.speedPreview, { effectiveRange: { min: 150, max: 200 } });
  assert.ok(!byKind(slower, "pre_move_ko").flatMap((guard) => guard.actionIds).includes("move:2|tera=0"), "we are faster: our Bullet Punch acts first");
});

// Matters: Metamon suggested Stealth Rock with rocks already up against a Pokémon that cannot remove
// them. It fails for certain, so it gets no mass. Against a possible remover (it may clear
// them first) or without rocks up, it is at most a warning and never re-ranked.
test("a hazard already up against a non-remover gets no mass; a possible remover keeps it a warning", () => {
  const rocks = (species: string, up = true) => {
    const e = scizorVsMetagross({ relation: "faster" });
    Object.assign(e.semantic.localIntel.speedPreview, { effectiveRange: { min: 150, max: 200 } });
    e.semantic.snapshot.legalActions[2] = { ...e.semantic.snapshot.legalActions[2], label: "Stealth Rock", moveName: "Stealth Rock" };
    e.semantic.snapshot.opponentSide.active.species = species;
    e.semantic.snapshot.field.opponentSideConditions = up ? ["stealthrock"] : [];
    return e;
  };
  const id = "move:2|tera=0";
  const gligar = computeTacticalGuards(rocks("Gligar"));
  assert.deepEqual(gligar.flagged[id], ["hazard_maxed"]);
  const reranked = rerankDistribution({ [id]: 0.83, "move:3|tera=0": 0.17 }, gligar.flagged, DEFAULT_RERANK_CONFIG);
  assert.equal(reranked[id], 0); assert.equal(reranked["move:3|tera=0"], 1);
  const excadrill = computeTacticalGuards(rocks("Excadrill"));
  assert.equal(excadrill.flagged[id], undefined, "Excadrill can Rapid Spin first");
  assert.ok(excadrill.guards.some((guard) => guard.kind === "hazard_maxed" && guard.severity === "amber"));
  assert.ok(!computeTacticalGuards(rocks("Gligar", false)).guards.some((guard) => guard.kind === "hazard_maxed"), "no rocks up: no guard");
  const unknown = rocks("Gligar"); delete unknown.semantic.snapshot.field.opponentSideConditions;
  assert.ok(!computeTacticalGuards(unknown).guards.some((guard) => guard.kind === "hazard_maxed"), "side conditions unknown: no claim");
});

// Matters: exact facts may re-rank, probabilistic ones only warn. Turn 19 had an overlapping Speed range (implied
// Scarf, 354-486 vs 459): that is a warning, never a penalty; nor is an unrevealed move, an inaccurate move, Trick Room,
// a possible Choice lock into a different move, or a full-HP Focus Sash.
test("pre-move KO stays a zero-penalty warning whenever order, reveal, accuracy or the KO itself is uncertain", () => {
  const cases: Array<[string, ReturnType<typeof scizorVsMetagross>]> = [];
  cases.push(["overlap", scizorVsMetagross({ relation: "overlap" })]);
  const unrevealed = scizorVsMetagross(); unrevealed.semantic.localIntel.opponentThreatPreview.forEach((t: any) => { t.moveSource = "likely"; }); cases.push(["unrevealed", unrevealed]);
  const inaccurate = scizorVsMetagross(); inaccurate.semantic.localIntel.opponentThreatPreview = [{ ...inaccurate.semantic.localIntel.opponentThreatPreview[0], moveName: "Stone Edge" }]; cases.push(["inaccurate", inaccurate]);
  const room = scizorVsMetagross(); room.semantic.snapshot.field.pseudoWeather = ["Trick Room"]; cases.push(["trick room", room]);
  const locked = scizorVsMetagross(); locked.semantic.snapshot.opponentSide.active.appearanceMoves = ["Knock Off"];
  locked.semantic.localIntel.opponentThreatPreview = [locked.semantic.localIntel.opponentThreatPreview[0]]; cases.push(["locked elsewhere", locked]);
  for (const [name, envelope] of cases) {
    const report = computeTacticalGuards(envelope);
    assert.ok(report.guards.some((guard) => guard.kind === "pre_move_ko" && guard.severity === "amber"), `${name}: still warned`);
    assert.deepEqual(report.flagged, {}, `${name}: never flagged for re-ranking`);
  }
  const sash = scizorVsMetagross({ hp: 100 }); sash.semantic.snapshot.yourSide.active.item = "focussash";
  sash.semantic.localIntel.opponentThreatPreview[0].currentTarget.bands = bands(101, 120);
  assert.deepEqual(computeTacticalGuards(sash).flagged, {}, "Focus Sash at full HP survives any single hit");
});

// Matters: "may move first" was shown while the opponent's maximum Speed was below ours. The engine's
// relation already includes every modelled modifier (a possible Swift Swim widens its range); a listed confounder must not
// turn a certain "faster" into a possible pre-move KO, while Trick Room still does.
test("a listed Speed confounder never overrides a faster relation whose range already includes it", () => {
  const faster = () => { const e = scizorVsMetagross({ relation: "faster" }); Object.assign(e.semantic.localIntel.speedPreview, {
    effectiveRange: { min: 150, max: 200 }, confounders: ["possible opponent Swift Swim"], reason: "confounded" }); return e; };
  assert.deepEqual(byKind(faster(), "pre_move_ko"), [], "220 beats every possible 150–200: no pre-move KO");
  const room = faster(); room.semantic.snapshot.field.pseudoWeather = ["Trick Room"];
  assert.ok(byKind(room, "pre_move_ko").length > 0, "Trick Room reverses the order: still warned");
});

// Matters: a fact must hold whatever the opponent does to act. A sleeping or frozen opponent may not move at all and a
// paralysed one may be fully paralysed; Sucker Punch fails into a status move; Fake Out only works on a stint's first
// turn; an intact Disguise absorbs the hit. None of those may be penalized (a red guard would steer B1 off good plays).
test("pre-move KO is never certain when the opponent may not act or the hit cannot land", () => {
  for (const status of ["slp", "frz", "par"]) assert.deepEqual(computeTacticalGuards(scizorVsMetagross({ status })).flagged, {}, status);
  const sucker = scizorVsMetagross(); sucker.semantic.localIntel.opponentThreatPreview = [{ ...sucker.semantic.localIntel.opponentThreatPreview[0], moveName: "Sucker Punch" }];
  sucker.semantic.snapshot.opponentSide.active.appearanceMoves = ["Sucker Punch"];
  const flagged = computeTacticalGuards(sucker).flagged;
  assert.equal(flagged["move:1|tera=0"], undefined, "Sucker Punch fails into Swords Dance");
  assert.deepEqual(flagged["move:3|tera=0"], ["pre_move_ko"], "but beats Knock Off");
  const fakeOut = scizorVsMetagross(); fakeOut.semantic.localIntel.opponentThreatPreview = [{ ...fakeOut.semantic.localIntel.opponentThreatPreview[0], moveName: "Fake Out" }];
  fakeOut.semantic.snapshot.opponentSide.active.appearanceMoves = ["Fake Out"]; fakeOut.semantic.snapshot.opponentSide.active.turnsSinceEntry = 3;
  assert.deepEqual(computeTacticalGuards(fakeOut).flagged, {}, "Fake Out fails after the first turn");
  const mimikyu = scizorVsMetagross(); Object.assign(mimikyu.semantic.snapshot.yourSide.active, { species: "Mimikyu", ability: "disguise", types: ["Ghost", "Fairy"] });
  assert.equal(computeTacticalGuards(mimikyu).flagged["move:3|tera=0"], undefined, "an intact Disguise takes the hit");
});

// Matters: turn 23/29. A second delayed attack into an occupied slot certainly fails: a rules-certain flag, while
// switching (and sacrificing) remain open, so nothing else is touched.
test("delayed attack into an occupied slot is a rules-certain failure flag", () => {
  const envelope = scizorVsMetagross({ hp: 100, threats: [] });
  envelope.semantic.localIntel.playerDamagePreview[2] = { actionId: "move:3|tera=0", moveName: "Future Sight", bands: [], delayed: { scheduling: "occupied", targetSide: "p2" } };
  envelope.semantic.snapshot.pendingAttacks = [{ moveName: "Future Sight", targetSide: "p2", sourceSide: "p1", dueTurn: 32 }];
  const report = computeTacticalGuards(envelope);
  assert.deepEqual(report.flagged, { "move:3|tera=0": ["delayed_slot_occupied"] });
  assert.match(report.guards[0]!.message, /^Future Sight will fail: a Future Sight already lands at the end of turn 32/);
  envelope.semantic.localIntel.playerDamagePreview[2].delayed.scheduling = "unknown";
  assert.deepEqual(computeTacticalGuards(envelope).flagged, {}, "unknown scheduling is not a rules fact");
});

// Matters: turn 30, the decisive error. Swords Dance survives one Earthquake but the same hit KOs next turn before any
// non-priority move, and +2 Bullet Punch (the only faster move) cannot KO even after every bounded chip: a dead end.
// If Bullet Punch could KO, or the setup raised Speed, or our pending delayed hit cannot be bounded, it is no longer a fact.
test("two-ply setup dead end is penalized only when the boost cannot be cashed out", () => {
  const t30 = () => {
    const envelope = scizorVsMetagross({ hp: 91.1 });
    envelope.semantic.snapshot.opponentSide.active.hpPercent = 89;
    envelope.semantic.localIntel.opponentThreatPreview[0].currentTarget.bands = bands(57.7, 68);
    envelope.semantic.localIntel.opponentThreatPreview[1].currentTarget.bands = bands(56, 66);
    envelope.semantic.localIntel.playerDamagePreview[1].bands = bands(14.2, 16.9);
    return envelope;
  };
  const plain = (envelope: DecisionEnvelope) => byKind(envelope, "setup_dead_end").filter((guard) => guard.actionIds.includes("move:1|tera=0"));
  const dead = plain(t30());
  assert.equal(dead.length, 1); assert.equal(dead[0]!.severity, "red"); assert.deepEqual(dead[0]!.actionIds, ["move:1|tera=0"]);
  assert.match(dead[0]!.message, /Earthquake leaves Scizor at ≤33% and KOs it next turn.*only Bullet Punch acts first and cannot KO/);
  assert.deepEqual(computeTacticalGuards(t30()).flagged["move:1|tera=0"], ["setup_dead_end"]);
  const lowTarget = t30(); lowTarget.semantic.snapshot.opponentSide.active.hpPercent = 30;
  assert.deepEqual(plain(lowTarget).map((g) => g.severity), [], "+2 Bullet Punch can KO: an escape exists");
  const pending = t30(); pending.semantic.snapshot.opponentSide.team = [{ terastallized: false }];
  pending.semantic.snapshot.pendingAttacks = [{ moveName: "Future Sight", sourceSide: "p1", targetSide: "p2", dueTurn: 31, sourceInstanceId: "p1:4" }];
  pending.semantic.snapshot.turn = 31;
  const unbounded = plain(pending);
  assert.equal(unbounded[0]?.severity, "amber"); assert.match(unbounded[0]!.message, /pending delayed damage is not quantified/);
  const speedy = t30(); speedy.semantic.snapshot.legalActions[0] = move(1, "Dragon Dance"); speedy.semantic.localIntel.playerDamagePreview[0].moveName = "Dragon Dance";
  assert.deepEqual(computeTacticalGuards(speedy).flagged["move:1|tera=0"], undefined, "a Speed boost may outspeed next turn");
});

// Matters: a switch-in that every considered reply KOs (while another option survives them all) wastes a Pokémon; but if
// any reply leaves it standing, or nothing survives, switching there is a judgment call and must not be penalized.
test("switch target KO'd by every considered reply is penalized only with a surviving alternative", () => {
  const envelope = scizorVsMetagross({ hp: 100 });
  envelope.semantic.localIntel.opponentThreatPreview = [
    { moveName: "Earthquake", moveSource: "known", currentTarget: { species: "Scizor", targetCurrentHpPercent: 100, bands: bands(57.7, 68) },
      switchTargets: [{ instanceId: "p1:3", species: "Fezandipiti", targetCurrentHpPercent: 52.9, bands: bands(80.5, 94.7), summary: "" }] }];
  // (Tera Fire variants are separately penalized: Fire doubles Earthquake into a KO.)
  assert.deepEqual(computeTacticalGuards(envelope).flagged["switch:3"], ["switch_into_ko"]);
  const knock = structuredClone(envelope); knock.semantic.localIntel.opponentThreatPreview.push({ moveName: "Knock Off", moveSource: "known",
    currentTarget: { species: "Scizor", targetCurrentHpPercent: 100, bands: bands(56, 66) },
    switchTargets: [{ instanceId: "p1:3", species: "Fezandipiti", targetCurrentHpPercent: 52.9, bands: bands(12.9, 15.3), summary: "" }] });
  assert.equal(computeTacticalGuards(knock).flagged["switch:3"], undefined, "Knock Off leaves Fezandipiti standing");
  const doomed = structuredClone(envelope); doomed.semantic.localIntel.opponentThreatPreview[0].currentTarget.bands = bands(120, 140);
  assert.equal(computeTacticalGuards(doomed).flagged["switch:3"], undefined, "no alternative survives");
});

// Matters: the warning-only signals. A likely Choice lock, a Tera that turns a KO into survival (turn 32: Tera
// Water vs Earthquake) and a priority move that can KO are shown to the human but never re-rank.
test("choice lock, Tera survival delta and priority caveat are amber warnings that never re-rank", () => {
  const fez = scizorVsMetagross({ hp: 52.9 });
  const active = fez.semantic.snapshot.yourSide.active;
  Object.assign(active, { species: "Fezandipiti", types: [], teraType: "Water", ability: "toxicchain", item: null });
  fez.semantic.snapshot.legalActions = [move(3, "Roost"), move(3, "Roost", true)];
  fez.semantic.localIntel.playerDamagePreview = [];
  fez.semantic.localIntel.speedPreview.activeRelation = "overlap";
  fez.semantic.localIntel.speedPreview.priorityMoves = ["Bullet Punch"];
  fez.semantic.localIntel.opponentThreatPreview = [
    { moveName: "Earthquake", moveSource: "known", currentTarget: { species: "Fezandipiti", targetCurrentHpPercent: 52.9, bands: bands(80.5, 94.7) }, switchTargets: [] },
    { moveName: "Bullet Punch", moveSource: "likely", currentTarget: { species: "Fezandipiti", targetCurrentHpPercent: 52.9, bands: bands(48.9, 57.4) }, switchTargets: [] }];
  const report = computeTacticalGuards(fez);
  const tera = report.guards.find((guard) => guard.kind === "tera_survival")!;
  assert.deepEqual(tera.actionIds, ["move:3|tera=1"]);
  assert.match(tera.message, /^Tera Water: Earthquake no longer KOs \(≈40–47% vs 53% HP/);
  assert.match(report.guards.find((guard) => guard.kind === "choice_lock")!.message, /used only Earthquake.*may be Choice-locked \(Choice Band 30% on the ladder\)/);
  assert.match(report.guards.find((guard) => guard.kind === "priority_caveat")!.message, /Possible Bullet Punch \(priority\) can KO Fezandipiti/);
  assert.ok(report.guards.filter((guard) => ["tera_survival", "choice_lock", "priority_caveat"].includes(guard.kind)).every((guard) => guard.severity === "amber"));
  assert.deepEqual(report.flagged, {});
});

// Matters: "Choice Band 1%… likely locked" was refuted the same turn, and "Choice Specs 39%" fired
// six times after observed damage had ruled Specs out (the engine's own posterior had dropped it). The warning needs a
// meaningful share, from this battle's posterior when it has battle evidence, and says "may be".
test("choice lock warns only on a meaningful Choice share, from the posterior once the battle has evidence", () => {
  const lock = (mutate: (e: any) => void) => { const e = scizorVsMetagross(); mutate(e); return computeTacticalGuards(e).guards.find((g) => g.kind === "choice_lock"); };
  const opponent = (e: any) => e.semantic.localIntel.opponents[0];
  assert.match(lock(() => {})!.message, /^Metagross has used only Earthquake since switching in; it may be Choice-locked \(Choice Band 30% on the ladder\)\.$/);
  assert.equal(lock((e) => { opponent(e).likelyItems = [{ name: "Leftovers", share: 0.6 }, { name: "Choice Band", share: 0.01 }]; }), undefined, "a 1% share is no warning");
  const posterior = (weights: Array<[string, number]>, evidenceKinds = ["damage"]) => ({ confidenceTier: "usable", evidenceKinds,
    topHypotheses: weights.map(([item, weight]) => ({ item, weight, ability: null, teraType: null, statArchetype: "bulky_phys", nature: "Adamant", evs: {}, effectiveSpeed: null, support: [] })) });
  assert.equal(lock((e) => { opponent(e).posterior = posterior([["Assault Vest", 0.7], ["Leftovers", 0.3]]); }), undefined, "observed damage ruled the Choice items out");
  assert.match(lock((e) => { opponent(e).posterior = posterior([["Choice Band", 0.55], ["Assault Vest", 0.45]]); })!.message, /may be Choice-locked \(Choice Band 55% given this battle\)/);
  assert.match(lock((e) => { opponent(e).posterior = posterior([["Assault Vest", 0.9], ["Choice Band", 0.1]], ["moves"]); })!.message, /Choice Band 30% on the ladder/,
    "without battle evidence the ladder share stands");
  assert.match(lock((e) => { e.semantic.snapshot.opponentSide.active.item = "Choice Band"; })!.message, /Choice Band revealed/);
});

// Matters: guards read engine data only for an ordinary decision; preview and unsupported envelopes (empty engine data)
// must produce nothing rather than guesses.
test("no guards outside a supported move or forced-switch request", () => {
  for (const mutate of [(e: any) => { e.semantic.capabilities.status = "unsupported"; }, (e: any) => { e.semantic.snapshot.phase = "preview"; },
    (e: any) => { e.semantic.snapshot.rawRequestSummary.requestKind = "team_preview"; }]) {
    const envelope = scizorVsMetagross(); mutate(envelope);
    assert.deepEqual(computeTacticalGuards(envelope).guards, []);
  }
});

// Matters: a forced switch (Arcanine into an intact Disguise) ran no guards at all. A
// forced switch still chooses a switch-in, so the switch-in facts apply: a hazard KO is certain (red); a KO by every
// reply is a warning (after a faint the switch-in may act first); staying in is no alternative; move guards never fire.
test("forced switches run the switch-in guards, with staying in no alternative", () => {
  const forced = (targets: any[], fainted = true) => {
    const e = scizorVsMetagross({ hp: fainted ? 0 : 16.2 });
    e.semantic.snapshot.rawRequestSummary.requestKind = "forced_switch"; e.semantic.identity.requestKind = "forced_switch";
    Object.assign(e.semantic.snapshot.yourSide.active, { fainted });
    e.semantic.snapshot.yourSide.team.push({ species: "Slowking", instanceId: "p1:4", hpPercent: 100, fainted: false, active: false });
    e.semantic.snapshot.legalActions = [swap(3, "Fezandipiti"), swap(4, "Slowking")];
    e.semantic.localIntel.opponentThreatPreview = [{ moveName: "Earthquake", moveSource: "known",
      currentTarget: { species: "Scizor", targetCurrentHpPercent: fainted ? 0 : 16.2, bands: fainted ? [] : bands(20, 25) }, switchTargets: targets }];
    return computeTacticalGuards(e);
  };
  const fez = { instanceId: "p1:3", species: "Fezandipiti", targetCurrentHpPercent: 52.9, bands: bands(80.5, 94.7), summary: "" };
  const slowking = { instanceId: "p1:4", species: "Slowking", targetCurrentHpPercent: 100, bands: bands(30, 36), summary: "" };
  for (const fainted of [true, false]) {
    const report = forced([fez, slowking], fainted);
    assert.deepEqual(report.guards.map((g) => [g.kind, g.severity, g.actionIds]), [["switch_into_ko", "amber", ["switch:3"]]], `fainted=${fainted}`);
    assert.match(report.guards[0]!.message, /^Fezandipiti is KO'd by every likely reply \(Earthquake\) if it takes one; another switch-in survives them\.$/);
    assert.deepEqual(report.flagged, {});
  }
  const hazard = forced([{ ...fez, bands: [], summary: "Projected entry hazards KO this switch target before the reply." }, slowking]);
  assert.deepEqual(hazard.flagged, { "switch:3": ["switch_into_ko"] }); assert.match(hazard.guards[0]!.message, /^Entry hazards KO Fezandipiti on the switch\./);
  assert.deepEqual(forced([fez, { ...slowking, bands: bands(120, 140) }], false).guards, [], "every switch-in dies: staying in is not an option, so no alternative");
});

// Matters: metamon-rerank@2. A rules-certain failure (occupied delayed-attack slot)
// gets no mass; tactical flags (pre-move KO, setup dead end, switch into a KO) keep at most τ jointly, unflagged actions
// share the rest in Metamon's own proportions; with nothing unflagged Metamon's p stands (there is nowhere to move it).
test("metamon-rerank@2 zeroes rules-certain failures and caps tactical flags at τ", () => {
  const p = { fs: 0.5, ko: 0.3, bp: 0.15, sw: 0.05 };
  const q = rerankDistribution(p, { fs: ["delayed_slot_occupied"], ko: ["pre_move_ko"] }, { tau: 0.2, demoted: [] });
  assert.equal(q.fs, 0, "the certain failure gets no mass");
  assert.ok(Math.abs(q.ko! - 0.2) < 1e-12, "tactical mass capped at τ");
  assert.ok(Math.abs(q.bp! / q.sw! - 3) < 1e-12 && Math.abs(q.bp! + q.sw! - 0.8) < 1e-12, "unflagged keep Metamon's odds");
  const under = rerankDistribution({ ko: 0.1, bp: 0.9 }, { ko: ["setup_dead_end"] }, { tau: 0.2, demoted: [] });
  assert.ok(Math.abs(under.ko! - 0.1) < 1e-12, "below the cap nothing moves");
  const everything = rerankDistribution({ ko: 0.7, cc: 0.3 }, { ko: ["pre_move_ko"], cc: ["pre_move_ko"] }, { tau: 0.2, demoted: [] });
  assert.deepEqual(everything, { cc: 0.3, ko: 0.7 }, "nothing unflagged: p' = p");
  const only = rerankDistribution({ fs: 1 }, { fs: ["delayed_slot_occupied"] }, { tau: 0.2, demoted: [] });
  assert.deepEqual(only, { fs: 1 }, "a certain failure that is the only option keeps its mass");
  const capAfterZero = rerankDistribution({ fs: 0.6, ko: 0.3, sw: 0.1 }, { fs: ["delayed_slot_occupied"], ko: ["switch_into_ko"] }, { tau: 0.5, demoted: [] });
  assert.ok(Math.abs(capAfterZero.ko! - 0.5) < 1e-12 && Math.abs(capAfterZero.sw! - 0.5) < 1e-12, "the cap applies after the zeroed mass is removed");
  // Live default: a sack into a KO can be right, so only the rules-certain failure may move mass.
  assert.deepEqual(DEFAULT_RERANK_CONFIG, { tau: 0.05, demoted: ["pre_move_ko", "setup_dead_end", "switch_into_ko"] });
  assert.throws(() => rerankDistribution(p, {}, { tau: 0, demoted: [] }), /τ/);
  // A kind the precision audit demotes to amber no longer moves mass, and is shown as a warning.
  const demoted = rerankDecision(scizorVsMetagross(), { "move:3|tera=0": 0.9, "move:2|tera=0": 0.1 }, "move:3|tera=0", "k", { tau: 0.2, demoted: ["pre_move_ko"] });
  assert.deepEqual(demoted.flagged, {}); assert.deepEqual(demoted.rerankedProbabilities, demoted.rawProbabilities);
  assert.ok(demoted.guards.filter((guard) => guard.kind === "pre_move_ko").every((guard) => guard.severity === "amber"));
});

// Matters: the paired evaluation compares arms on identical seeds; coupling keeps Metamon's own pick whenever it is not
// penalized (so arms differ only where a guard fires) while the re-ranked pick is still an exact sample from p'.
test("coupled re-ranked pick keeps unpenalized raw picks and has marginal exactly p'", () => {
  const p = { a: 0.5, b: 0.3, c: 0.2 }, q = rerankDistribution(p, { a: ["pre_move_ko"], c: ["delayed_slot_occupied"] }, { tau: 0.2, demoted: [] });
  for (let i = 0; i < 200; i++) assert.equal(coupledRerankPick(p, q, "b", `seed-${i}`), "b");
  const counts: Record<string, number> = {};
  let state = 12345;
  const uniform = () => { state = (state * 1103515245 + 12345) % 2 ** 31; return state / 2 ** 31; };
  const n = 40000;
  for (let i = 0; i < n; i++) {
    const u = uniform(), raw = u < 0.5 ? "a" : u < 0.8 ? "b" : "c";
    const pick = coupledRerankPick(p, q, raw, `marginal-${i}`);
    counts[pick] = (counts[pick] ?? 0) + 1;
  }
  for (const id of Object.keys(q)) assert.ok(Math.abs((counts[id] ?? 0) / n - q[id]!) <= 5 * Math.sqrt(q[id]! * (1 - q[id]!) / n), `${id}: ${(counts[id] ?? 0) / n} vs ${q[id]}`);
  assert.equal(counts.c, undefined, "a zero-mass action is never picked");
  assert.deepEqual(decisionUniforms("same"), decisionUniforms("same"), "replayable from the seed key alone");
  assert.equal(rerankSeedKey(7, "p2", { rqid: 9, stateRevision: 3 }), "metamon-rerank@2:7:p2:9:3");
  const unrecorded = rerankDecision(scizorVsMetagross(), undefined, "move:3|tera=0", "k");
  assert.equal(unrecorded.rerankActionId, null); assert.equal(unrecorded.rawProbabilities, null);
  assert.ok(unrecorded.guards.length > 0, "guards still computed without a distribution");
});

// The transport double is protocol only (no Metamon inference): it proposes Future Sight whenever Slowking can.
const mockWorker = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});let request;
rl.on('line',line=>{const m=JSON.parse(line);const r={version:m.version,id:m.id,ok:true};
 if(m.op==='observe'){r.context=m.context;for(const l of m.data.split('\n'))if(l.startsWith('|request|'))request=JSON.parse(l.slice(9));}
 else{r.binding={requestId:m.requestId,identity:m.identity,resultHash:m.resultHash,sequence:m.sequence};
  if(m.op!=='propose')r.choice=m.choice;
  else if(request.teamPreview)r.choice={kind:'team',team:[4,1,2,3,5,6]};
  else if(request.forceSwitch?.[0]){const slot=request.side.pokemon.findIndex(p=>!p.active&&!p.condition.endsWith(' fnt'))+1;r.choice={kind:'switch',switchSlot:slot};r.actionProbabilities={['switch '+slot]:1};}
  else{const moves=request.active[0].moves;const fs=moves.findIndex(x=>x.id==='futuresight'&&!x.disabled)+1;const other=moves.findIndex(x=>x.id!=='futuresight'&&!x.disabled)+1;
   if(fs){r.choice={kind:'move',moveSlot:fs,terastallize:false};r.actionProbabilities={['move '+fs]:0.5,['move '+other]:0.5};}
   else{r.choice={kind:'move',moveSlot:other,terastallize:false};r.actionProbabilities={['move '+other]:1};}}
  if(process.env.RERANK_LOG)require('node:fs').appendFileSync(process.env.RERANK_LOG,JSON.stringify({op:m.op,choice:r.choice})+'\n');}
 process.stdout.write(JSON.stringify(r)+'\n');});`;

// Matters: the B1 arm end to end on the official simulator with real engine envelopes. Turn 2's Future Sight into the
// occupied slot is penalized, the executed action is the coupled re-ranked pick, and the worker's recurrence commits the
// EXECUTED action (its ordinary deviation path); shadow mode (B0) logs the same features but executes the raw pick.
for (const mode of ["rerank", "shadow"] as const) test(`re-rank seat (${mode}) on the official simulator: penalized Future Sight, executed pick, worker commit`, async () => {
  const team = await fs.readFile(new URL("../../../../examples/gen9uu-scizor-proposal.txt", import.meta.url), "utf8");
  const log = path.join(directory, `${mode}-rpc.jsonl`), rows: any[] = [];
  const seat = new RerankedMetamonPolicy(new MetamonBattlePolicy({ command: process.execPath, args: ["-e", mockWorker], env: { RERANK_LOG: log } }),
    { id: mode === "rerank" ? "metamon:Kakuna:epoch34+rerank@2" : "metamon:Kakuna:epoch34", mode, seed: 11, side: "p1", onRecord: (row) => rows.push(row) });
  const result = await runBattleMatch({ p1: seat, p2: new DeterministicBattlePolicy(), teams: { p1: team, p2: team }, format: "gen9uu", seed: [1, 2, 3, 4], maxTurns: 2, fallback: "none" });
  assert.deepEqual(result.errors, []);
  const occupied = rows.find((row) => row.guards.some((guard: any) => guard.kind === "delayed_slot_occupied"));
  assert.ok(occupied, "turn 2 Future Sight is into an occupied slot");
  assert.deepEqual(occupied.flagged[occupied.rawActionId], ["delayed_slot_occupied"]);
  assert.equal(occupied.rerankedProbabilities[occupied.rawActionId], 0, "the certain failure has no mass under @2");
  assert.ok(rows.filter((row) => row !== occupied && row.rawProbabilities).every((row) => !row.flagged[row.rawActionId]), "the first cast is not flagged");
  for (const row of rows.filter((entry) => entry.rawProbabilities)) {
    assert.equal(row.rerankActionId, coupledRerankPick(row.rawProbabilities, row.rerankedProbabilities, row.rawActionId, row.seedKey));
    assert.equal(row.executedActionId, mode === "rerank" ? row.rerankActionId : row.rawActionId);
  }
  assert.notEqual(occupied.rerankActionId, occupied.rawActionId, "zero mass: always re-ranked away from the failing move");
  const executed = result.trajectory.filter((entry) => entry.side === "p1").map((entry) => entry.choice);
  const commits = (await fs.readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.op === "commit")
    .map((m) => m.choice.kind === "team" ? `team ${m.choice.team.join("")}` : m.choice.kind === "switch" ? `switch ${m.choice.switchSlot}` : `move ${m.choice.moveSlot}`);
  assert.deepEqual(commits, executed, "the worker learns the executed action");
  assert.equal(result.players.p1!.policyId, mode === "rerank" ? "metamon:Kakuna:epoch34+rerank@2" : "metamon:Kakuna:epoch34");
});

// Matters: a re-ranked switch can hit a hidden trap. The worker's pending proposal is Metamon's raw pick, so the seat
// must stage the executed switch before the rejection or the worker cannot re-choose (shadow never deviates).
test("a re-ranked switch is staged with the worker before its trapped rejection is observed", async () => {
  const calls: string[] = [];
  const envelope = scizorVsMetagross();
  const transport = {
    requiresSupportedMechanics: false,
    decide: async (input: any) => ({ requestId: input.requestId, identity: input.envelope.semantic.identity, actionId: "move:3|tera=0" }),
    proposalDistribution: () => ({ "move:3|tera=0": 0.97, "switch:3": 0.03 }),
    stageSwitch: async (_input: any, actionId: string) => { calls.push(`stage ${actionId}`); },
    observe: async (data: string) => { calls.push(`observe ${data.split("\n")[0]}`); },
    commit: async () => { calls.push("commit"); }, close: async () => {}
  };
  const op = { deadlineAt: Date.now() + 5000, signal: new AbortController().signal };
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    calls.length = 0;
    // Staging mechanics need a re-rankable tactical flag; the live default only warns on pre_move_ko.
    const seat = new RerankedMetamonPolicy(transport as any, { id: "metamon:Kakuna:epoch34+rerank@2", mode: "rerank", seed, side: "p1", onRecord: () => {},
      config: { tau: 0.2, demoted: [] } });
    const decision = await seat.decide({ requestId: "r1", envelope } as any, op);
    if (decision.actionId !== "switch:3") continue;
    await seat.observe(TRAPPED_SWITCH_ERROR, {} as any, op);
    assert.deepEqual(calls, ["stage switch:3", `observe ${TRAPPED_SWITCH_ERROR}`]);
    const shadow = new RerankedMetamonPolicy(transport as any, { id: "metamon:Kakuna:epoch34", mode: "shadow", seed, side: "p1", onRecord: () => {} });
    calls.length = 0;
    assert.equal((await shadow.decide({ requestId: "r2", envelope } as any, op)).actionId, "move:3|tera=0");
    await shadow.observe(TRAPPED_SWITCH_ERROR, {} as any, op);
    assert.deepEqual(calls, [`observe ${TRAPPED_SWITCH_ERROR}`]);
    return;
  }
  assert.fail("no seed in 1..8 re-ranked to the switch");
});
