import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Showdown from "pokemon-showdown";
import type { BattleSnapshot, LocalIntelSnapshot, SpeedPreview } from "../types.js";

// Tests never touch the owner's history: an empty in-memory context, and the store paths point at a scratch directory.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-belief-"));
process.env.LOCAL_INTEL_STORE_PATH = path.join(scratch, "history.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(scratch, "curated.json");
after(() => fs.rm(scratch, { recursive: true, force: true }));
const { DecisionEngine } = await import("../state/decisionEngine.js");
const { evaluateDecision } = await import("../state/decisionEnvelope.js");
const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots, speedVerdict } = await import("../history/opponentIntelStore.js");
const { checkBattleBeliefs, checkDecision } = await import("../tools/beliefInvariants.js");
const { computeTacticalGuards } = await import("../battle-agent/tacticalGuards.js");
const { BattleStream, getPlayerStreams, Teams } = Showdown as any;

/** A seeded synthetic battle from p1's side (its public log and private requests), as the browser receives it. */
async function simulate(p1: string, p2: string, steps: Array<[string, string]>, seed = [1, 2, 3, 4]) {
  const streams = getPlayerStreams(new BattleStream()), frames: string[] = [];
  void (async () => { for await (const chunk of streams.p1) frames.push(chunk); })();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const pack = (team: string) => Teams.pack(Teams.import(team));
  await streams.omniscient.write(`>start {"formatid":"gen9customgame","seed":${JSON.stringify(seed)}}\n>player p1 {"name":"Alpha","team":"${pack(p1)}"}\n>player p2 {"name":"Beta","team":"${pack(p2)}"}`);
  await settle();
  for (const [one, two] of steps) { await streams.omniscient.write(`>p1 ${one}\n>p2 ${two}`); await settle(); }
  frames[0] = `|init|battle\n${frames[0]}`;
  // The server numbers each request (rqid); the bare simulator does not.
  let rqid = 0;
  return frames.map((frame) => frame.startsWith("|request|") ? `|request|${JSON.stringify({ ...JSON.parse(frame.slice(9)), rqid: ++rqid })}` : frame);
}

/** Every decision through the production path: canonical ingestion, history projection, the complete envelope. */
async function decisions(frames: string[], roomId = "battle-gen9customgame-1") {
  const engine = new DecisionEngine({ source: "owned_offline_simulator" });
  let context = await createEphemeralIntelEvaluationContext(), sequence = 0;
  const out: Array<{ snapshot: BattleSnapshot; intel: LocalIntelSnapshot; envelope: any }> = [];
  for (const data of frames) {
    sequence += 1;
    const current = await engine.ingest({ sessionId: "t", roomId, source: "protocol", observationId: `f${sequence}`, sequence, data: `>${roomId}\n${data}` });
    if (current.snapshot) context = await projectCanonicalSnapshots([current.snapshot], context);
    if (!current.identity || current.snapshot?.rawRequestSummary?.wait || out.some((entry) => entry.snapshot.rawRequestSummary?.rqid === current.identity!.rqid)) continue;
    const envelope: any = await evaluateDecision(engine, "t", current.identity, context);
    out.push({ snapshot: envelope.semantic.snapshot, intel: envelope.semantic.localIntel, envelope });
  }
  return out;
}

const WEAVILE = `Weavile @ Focus Sash
Ability: Pressure
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Stealth Rock
- Knock Off
- Ice Spinner
- Low Kick`;
const BOOTS_TEAM = `Skarmory @ Leftovers
Ability: Sturdy
- Roost
- Brave Bird

Thundurus-Therian @ Heavy-Duty Boots
Ability: Volt Absorb
- Thunderbolt
- Grass Knot

Clefable @ Life Orb
Ability: Magic Guard
- Moonblast`;
// Rocks up (T1); Thundurus-Therian enters unharmed (T2); Weavile knocks its Boots off (T3); Clefable enters unharmed (T4).
const bootsGame = () => simulate(WEAVILE, BOOTS_TEAM, [["team 1", "team 123"], ["move 1", "move 1"], ["move 1", "switch 2"], ["move 2", "move 1"], ["move 1", "switch 3"]]);

// Matters: a Thundurus-Therian that switches onto Stealth Rock without damage can only hold Heavy-
// Duty Boots, yet the item posterior kept Choice Scarf and Sitrus Berry and the speed line said "You move
// first unless Choice Scarf". A proven item must change every belief at once; a fact that removes it must replace it, and
// a Pokémon that may have Magic Guard proves nothing.
test("an entry that Stealth Rock did not affect proves Heavy-Duty Boots for every belief until a fact replaces it", async () => {
  const all = await decisions(await bootsGame());
  const at = (species: string) => all.find((entry) => entry.snapshot.opponentSide.active?.species === species)!;
  const { snapshot, intel } = at("Thundurus-Therian");
  const thundurus = snapshot.opponentSide.active!;
  assert.equal(thundurus.item, "Heavy-Duty Boots");
  assert.equal(thundurus.itemProof?.hazard, "Stealth Rock");
  const entry = intel.opponents.find((candidate) => candidate.instanceId === thundurus.instanceId)!;
  assert.deepEqual(entry.likelyItems, []);
  assert.deepEqual(entry.posterior!.itemShares!.map((share) => share.name), ["Heavy-Duty Boots"]);
  // Weavile's 383 Speed is above every Thundurus-Therian Speed but below a Scarf one: only the proven item ends the caveat.
  assert.equal(intel.speedPreview!.yourActiveEffectiveSpeed, 383);
  assert.match(intel.speedPreview!.verdict!.text, /^You move first \(you 383 vs \d+-331\)$/);
  // Knock Off is a fact about the item: removed, nothing proven any more.
  const knocked = all.find((candidate) => candidate.snapshot.turn === 4)!.snapshot.opponentSide.team.find((mon) => mon.instanceId === thundurus.instanceId)!;
  assert.equal(knocked.item, null); assert.equal(knocked.removedItem, "Heavy-Duty Boots"); assert.equal(knocked.itemProof, undefined);
  // Clefable may have Magic Guard: its unharmed entry proves no item.
  const clefable = at("Clefable").snapshot.opponentSide.active!;
  assert.equal(clefable.item, null); assert.equal(clefable.itemProof, undefined);
});

// Matters: after a double KO Showdown prints both replacements before either side's hazards apply. Ending an entry at the
// other side's switch read the second Pokémon's Stealth Rock damage as "no damage", which now would prove Boots falsely.
test("a double replacement keeps each entry open until its own hazard damage", async () => {
  const p1 = `Glimmora @ Life Orb\nAbility: Toxic Debris\nEVs: 252 Atk\nAdamant Nature\n- Stealth Rock\n- Explosion\n\nGarchomp @ Leftovers\nAbility: Rough Skin\n- Earthquake`;
  const p2 = `Weavile @ Leftovers\nAbility: Pressure\n- Stealth Rock\n- Ice Shard\n\nGarchomp @ Leftovers\nAbility: Rough Skin\n- Earthquake`;
  const frames = await simulate(p1, p2, [["team 12", "team 12"], ["move 1", "move 1"], ["move 2", "move 1"], ["switch 2", "switch 2"]]);
  const text = frames.join("\n");
  assert.ok(text.indexOf("|switch|p1a: Garchomp") < text.indexOf("|-damage|p2a: Garchomp|"), "fixture: both replacements print before the hazards");
  const last = (await decisions(frames)).at(-1)!.snapshot;
  const garchomp = last.opponentSide.active!;
  assert.equal(garchomp.species, "Garchomp");
  assert.equal(garchomp.item, null, "Stealth Rock hit it: no Boots");
  assert.equal(garchomp.itemProof, undefined);
});

// Matters: the order verdict is the line the player reads before every move. It is the engine's (one rule, fed by every
// fact); the cases below are real-game lessons (Scarf Hydreigon; Shadow Sneak) plus later ones:
// a proven item or two moves in one stint end the Scarf caveat, and under Trick Room the slower Pokémon moves first.
test("the order verdict caveats only a still-possible Choice Scarf, names priority, and follows Trick Room", () => {
  const speed = (extra: Partial<SpeedPreview> = {}): SpeedPreview => ({ opponentSpecies: "Hydreigon", yourActiveEffectiveSpeed: 353, effectiveRange: { min: 208, max: 324 },
    activeRelation: "faster", evidence: [], confounders: [], switchMatchups: [], historyNotes: [], ...extra });
  const mon = (extra = {}) => ({ item: null, removedItem: null, knownMoves: [], appearanceMoves: [], ...extra }) as any;
  assert.deepEqual(speedVerdict(speed(), mon()), { text: "You move first unless Choice Scarf (their max 486) (you 353 vs 208-324)", tone: "overlap" });
  for (const known of [mon({ item: "Leftovers" }), mon({ removedItem: "Choice Scarf" }), mon({ item: "Heavy-Duty Boots" }), mon({ appearanceMoves: ["Dark Pulse", "U-turn"] })]) {
    assert.match(speedVerdict(speed(), known).text, /^You move first \(you 353 vs 208-324\)$/);
  }
  assert.match(speedVerdict(speed({ yourActiveEffectiveSpeed: 500 }), mon()).text, /^You move first \(/);
  assert.match(speedVerdict(speed({ effectiveRange: { min: 300, max: 324 }, possibleRange: { min: 450, max: 486 } }), mon({ appearanceMoves: ["Dark Pulse", "U-turn"] })).text, /unless Choice Scarf \(their max 486\)/,
    "the engine's own item range stands");
  assert.match(speedVerdict(speed({ activeRelation: "overlap", effectiveRange: { min: 354, max: 486 }, evidence: [{ kind: "item_ability_assumption", label: "Choice Scarf implied (T17 before Thundurus 353)" }] }), mon()).text, /^Speed uncertain \(you 353 vs 354-486\)$/);
  assert.match(speedVerdict(speed({ evidence: [{ kind: "item_ability_assumption", label: "Choice Scarf ruled out by observed order" }] }), mon()).text, /^You move first \(/);
  const sneak = speed({ priorityMoves: ["Shadow Sneak"] });
  assert.deepEqual(speedVerdict(sneak, mon({ item: "Life Orb", knownMoves: ["Shadow Claw"] })), { text: "You move first (you 353 vs 208-324); they may have Shadow Sneak (priority)", tone: "overlap" });
  assert.match(speedVerdict(sneak, mon({ item: "Life Orb", knownMoves: ["Shadow Sneak"] })).text, /; they have Shadow Sneak \(priority\)$/);
  assert.deepEqual(speedVerdict(speed(), mon({ item: "Life Orb" }), true), { text: "They move first (Trick Room) (you 353 vs 208-324)", tone: "slower" });
  assert.deepEqual(speedVerdict(speed({ activeRelation: "slower" }), mon(), true), { text: "You move first (Trick Room) (you 353 vs 208-324)", tone: "faster" });
});

const SCARF_TEAM = `Garchomp @ Choice Scarf
Ability: Rough Skin
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Earthquake
- Stone Edge`;

// Matters: once the turn order implies a Choice Scarf (Garchomp outsped 383 Weavile, above any item-free Garchomp), its
// one move this stint is a lock, as for a revealed Choice item. The prediction said "may be Choice-locked" while the
// warnings already treated it as locked.
test("a Choice Scarf implied by turn order makes a one-move stint a stated lock", async () => {
  const all = await decisions(await simulate(WEAVILE, SCARF_TEAM, [["team 1", "team 1"], ["move 4", "move 1"]]));
  const { snapshot, intel } = all.at(-1)!;
  assert.deepEqual(snapshot.opponentSide.active!.appearanceMoves, ["Earthquake"]);
  assert.ok(intel.speedPreview!.evidence.some((entry) => /^Choice Scarf implied/.test(entry.label)), "fixture: the order implies a Scarf");
  // The order all but proves the Scarf; while unrevealed it is shown at most 99%.
  assert.deepEqual(intel.opponents[0]!.posterior!.itemShares![0], { name: "Choice Scarf", share: 0.99 });
  const earthquake = intel.opponentActionPrediction!.topActions.find((action: any) => action.moveName === "Earthquake") as any;
  assert.ok(earthquake.reasons.includes("Choice-locked into Earthquake"), earthquake.reasons.join("; "));
});

// Matters: hovering over a move shows how much it does to each Pokémon on the other side.
// Every move gets its band against every opposing Pokémon seen so far; the active's is the damage section's own, a benched
// one is computed at its own HP and set; it is part of the complete result.
test("each move carries its damage band against every opposing Pokémon seen so far", async () => {
  const { intel, snapshot } = (await decisions(await bootsGame())).find((entry) => entry.snapshot.opponentSide.active?.species === "Thundurus-Therian")!;
  const rows = intel.moveTargetPreview!;
  assert.deepEqual(rows.map((row) => row.moveName), ["Stealth Rock", "Knock Off", "Ice Spinner", "Low Kick"]);
  for (const row of rows) assert.deepEqual(row.targets.map((target) => [target.species, target.active]).sort(),
    [["Clefable", false], ["Skarmory", false], ["Thundurus-Therian", true]]);
  const target = (move: string, species: string) => rows.find((row) => row.moveName === move)!.targets.find((entry) => entry.species === species)!;
  const own = intel.playerDamagePreview!.find((preview) => preview.moveName === "Ice Spinner" && !preview.terastallize)!.bands.find((band) => band.label === "likely")!;
  assert.deepEqual([target("Ice Spinner", "Thundurus-Therian").band!.minPercent, target("Ice Spinner", "Thundurus-Therian").band!.maxPercent], [own.minPercent, own.maxPercent]);
  assert.equal(target("Low Kick", "Clefable").band!.outcome ?? "damage", "damage");
  assert.ok(target("Low Kick", "Clefable").band!.maxPercent! > 0);
  assert.equal(target("Stealth Rock", "Skarmory").band!.outcome, "status");
  assert.equal(snapshot.opponentSide.team.length, 3);
});

// Matters: the invariant checker is the guard against stale beliefs; it must pass on a consistent battle and name a belief
// that ignores a fact (here: a likely item kept beside a proven one, and a proof dropped).
test("the belief checker passes a consistent battle and names a stale belief", async () => {
  const frames = await bootsGame();
  const report = await checkBattleBeliefs(frames, "battle-gen9customgame-1");
  assert.deepEqual(report.violations, []);
  assert.ok(report.checks.hazard_proof! > 0 && report.checks.item_fact! > 0 && report.checks.item_belief! > 0, JSON.stringify(report.checks));
  const { snapshot, intel } = (await decisions(frames)).find((entry) => entry.snapshot.opponentSide.active?.species === "Thundurus-Therian")!;
  const stale = structuredClone(intel), unproven = structuredClone(snapshot);
  stale.opponents.find((entry) => entry.species === "Thundurus-Therian")!.likelyItems = [{ name: "Choice Scarf", count: 0, share: 0.3, sampleCount: 1, confidenceTier: "thin" }];
  for (const mon of [unproven.opponentSide.active!, ...unproven.opponentSide.team]) if (mon.species === "Thundurus-Therian") { mon.item = null; delete mon.itemProof; }
  const staleReport = { decisions: 0, checks: {}, violations: [] as any[] };
  checkDecision(snapshot, stale, [], staleReport, null);
  checkDecision(unproven, intel, [], staleReport, null);
  const named = staleReport.violations.map((violation) => violation.invariant);
  assert.ok(named.includes("hazard_proof") && named.includes("item_belief"), named.join(", "));
});

// Matters: a Pokémon that uses the same move over and over should raise the likelihood of an item that locks it in. Each repeat of the stint's only move is certain under a
// Choice item and only as likely as picking it again without one (estimated from the set's other options), so the Choice
// share rises with every repeat, never shows above 99% while hidden, and the warning names the repeats with that share.
// Earthquake into a Flying type does no damage, so the repeats are the only item evidence here.
test("each repeat of one move raises the Choice share, capped, and the warning says so", async () => {
  const p1 = `Corviknight @ Leftovers\nAbility: Pressure\nEVs: 252 HP / 252 Def\nImpish Nature\n- Roost\n- Iron Defense`;
  const p2 = `Garchomp @ Choice Band\nAbility: Rough Skin\nEVs: 252 Atk / 252 Spe\nJolly Nature\n- Earthquake\n- Stone Edge\n- Swords Dance\n- Dragon Claw`;
  const frames = await simulate(p1, p2, [["team 1", "team 1"], ...Array.from({ length: 8 }, () => ["move 2", "move 1"] as [string, string])]);
  const all = (await decisions(frames)).filter((entry) => entry.snapshot.turn >= 1);
  const choice = (entry: typeof all[number]) => entry.intel.opponents[0]!.posterior!.itemShares!
    .filter((share) => /^Choice /.test(share.name)).reduce((sum, share) => sum + share.share, 0);
  const shares = all.map(choice);
  assert.equal(shares.length, 9);
  // shares[1]: one Earthquake (Specs ruled out by the physical move); each later decision follows one more repeat.
  for (let index = 2; index <= 3; index++) assert.ok(shares[index]! > shares[index - 1]!, `Choice share rises with each repeat: ${shares}`);
  const third = all[3]!;
  assert.ok(third.intel.opponents[0]!.posterior!.evidence.some((entry) => entry.label === "Used Earthquake 3× in a row this stint"));
  const lock = computeTacticalGuards(third.envelope).guards.find((guard: any) => guard.kind === "choice_lock")!;
  assert.equal(lock.short, `Garchomp used Earthquake 3× in a row: Choice item ${Math.round(shares[3]! * 100)}%`);
  // Eight uses: the evidence keeps growing but a hidden item is never shown as certain.
  for (const entry of all) assert.ok(entry.intel.opponents[0]!.posterior!.itemShares!.every((share) => share.share <= 0.99), JSON.stringify(entry.intel.opponents[0]!.posterior!.itemShares));
  const final = computeTacticalGuards(all.at(-1)!.envelope).guards.find((guard: any) => guard.kind === "choice_lock")!;
  assert.equal(final.short, "Garchomp used Earthquake 8× in a row: Choice item 99%");
  assert.deepEqual((await checkBattleBeliefs(frames, "battle-gen9customgame-1")).violations, []);
});

// Matters: when Mimikyu's Disguise breaks at the end of a turn whose order was clean, the order used to be dropped, so
// its Speed stayed the species range. A forme change after both moves cannot reorder them.
test("a forme change after both moves keeps the turn order as Speed evidence", async () => {
  const p1 = `Glimmora @ Leftovers\nAbility: Toxic Debris\nEVs: 252 SpA\nModest Nature\n- Power Gem`;
  const p2 = `Mimikyu @ Leftovers\nAbility: Disguise\nEVs: 252 Atk / 252 Spe\nJolly Nature\n- Shadow Claw`;
  const frames = await simulate(p1, p2, [["team 1", "team 1"], ["move 1", "move 1"]]);
  assert.match(frames.join("\n"), /\|move\|p2a: Mimikyu\|Shadow Claw[^]*\|move\|p1a: Glimmora\|Power Gem[^]*\|detailschange\|p2a: Mimikyu\|Mimikyu-Busted/, "fixture: busted after both moves");
  const speed = (await decisions(frames)).at(-1)!.intel.speedPreview!;
  assert.ok(speed.evidence.some((entry) => entry.kind === "current_turn_order" && /T1 before Glimmora/.test(entry.label)), JSON.stringify(speed.evidence));
});

// Matters: an observed order kept "Choice Scarf" as a Speed hypothesis (a possible-item range and the "unless Choice
// Scarf" line) even after two different moves in one stint had ruled every Choice item out.
test("two moves in one stint end Choice Scarf as a Speed hypothesis", async () => {
  const p1 = `Hippowdon @ Leftovers\nAbility: Sand Stream\nEVs: 252 HP / 252 Def\nImpish Nature\n- Earthquake\n- Slack Off`;
  const p2 = `Garchomp @ Assault Vest\nAbility: Rough Skin\nEVs: 252 Atk / 252 Spe\nJolly Nature\n- Earthquake\n- Dragon Claw`;
  const all = await decisions(await simulate(p1, p2, [["team 1", "team 1"], ["move 1", "move 1"], ["move 1", "move 2"]]));
  const after = (uses: number) => all.find((entry) => entry.snapshot.opponentSide.active?.appearanceMoves?.length === uses)!.intel.speedPreview!;
  assert.ok(after(1).evidence.some((entry) => /Possible item range/.test(entry.label) && /Choice Scarf/.test(entry.detail ?? "")), "fixture: one move leaves Scarf possible");
  assert.equal(after(2).possibleRange, undefined);
  assert.ok(!after(2).evidence.some((entry) => /Choice Scarf/.test(`${entry.label} ${entry.detail ?? ""}`)), JSON.stringify(after(2).evidence));
});
