/**
 * Every new piece of information must update what the advisor shows. Replays one battle's protocol frames through
 * the production decision path (DecisionEngine ingestion, canonical history projection, evaluateDecision) and checks, at
 * every decision, that each fact observed so far is reflected in what the advisor shows. The facts are read from the
 * canonical protocol facts by rules written here, independently of the belief code they check:
 *   item_fact       a revealed, removed or traded item (-item, -enditem, [from] item:) is the snapshot's item state
 *   item_belief     a known item leaves no other likely item, posterior item or Choice Scarf caveat
 *   hazard_proof    an entry onto Stealth Rock / grounded Spikes without HP loss proves Heavy-Duty Boots (no Magic Guard possible)
 *   order_verdict   an observed priority-0 order is never contradicted later under the same Speed state (Trick Room flips it)
 *   order_used      an observed clean order of the active opponent is part of its Speed evidence
 *   damage_used     every clean damage observation of an opponent is in its posterior
 *   choice          two moves in one stint rule out Choice items; a known Choice item locks a one-move stint
 *   choice_repeat   repeats of one move this stint are in the posterior; a hidden item never shows above 99%
 *   reveal          revealed moves, abilities and Tera are the opponent's known set
 */
import { Dex } from "@pkmn/dex";
import { DecisionEngine } from "../state/decisionEngine.js";
import { evaluateDecision } from "../state/decisionEnvelope.js";
import { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } from "../history/opponentIntelStore.js";
import type { MetaMovePrior } from "../history/metaPriorStore.js";
import type { BattleSnapshot, LocalIntelSnapshot, PokemonSnapshot } from "../types.js";

export interface BeliefViolation { invariant: string; turn: number; rqid: number | null; subject: string; detail: string }
export interface BeliefReport { decisions: number; checks: Record<string, number>; violations: BeliefViolation[] }

type Fact = NonNullable<BattleSnapshot["canonicalEvidence"]>["facts"][number];
const id = (value: string | null | undefined) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ORDER_ABILITIES = ["galewings", "triage", "stall", "quickdraw", "myceliummight", "prankster",
  "chlorophyll", "swiftswim", "sandrush", "slushrush", "surgesurfer", "unburden", "quickfeet", "protosynthesis", "quarkdrive", "slowstart"];
const CHOICE = ["choiceband", "choicespecs", "choicescarf"];

/** Who an "[of]" reference names: its instance, or the instance its appearance resolved to. */
function referencedInstance(fact: Fact, facts: Fact[], argIndex: number) {
  const ref = fact.references[argIndex];
  return ref?.instanceId ?? facts.find((entry) => ref?.appearanceId && entry.subject.appearanceId === ref.appearanceId)?.ownerInstanceId;
}

/** The item state the protocol has established for an instance up to `end` (exclusive): unknown, held or removed. */
export function itemTimeline(facts: Fact[], instanceId: string, end = facts.length) {
  let state: { kind: "unknown" } | { kind: "held" | "removed"; item: string; factId: string } = { kind: "unknown" };
  for (const fact of facts.slice(0, end)) {
    if (fact.source.channel === "recovery") continue;
    const from = fact.args.findIndex((arg) => /^\[from\]\s*item:/i.test(arg));
    if (fact.kind === "-item" && fact.ownerInstanceId === instanceId) state = { kind: "held", item: fact.args[1]!, factId: fact.id };
    else if (fact.kind === "-enditem" && fact.ownerInstanceId === instanceId) state = { kind: "removed", item: fact.args[1]!, factId: fact.id };
    else if (fact.kind === "-activate" && fact.ownerInstanceId === instanceId && /^item:/i.test(fact.args[1] ?? "") && state.kind === "unknown") {
      state = { kind: "held", item: fact.args[1]!.replace(/^item:\s*/i, ""), factId: fact.id };
    } else if (from >= 0) {
      const of = fact.args.findIndex((arg) => arg.startsWith("[of]"));
      const owner = of >= 0 ? referencedInstance(fact, facts, of) : fact.ownerInstanceId;
      const item = fact.args[from]!.replace(/^\[from\]\s*item:\s*/i, "");
      // A consumed berry prints -enditem before its effect: a removed item stays removed.
      if (owner === instanceId && state.kind === "unknown") state = { kind: "held", item, factId: fact.id };
    }
  }
  return state;
}

function possibleAbilities(mon: PokemonSnapshot) {
  if (mon.ability) return [id(mon.ability)];
  const species = Dex.species.get(mon.canonicalSpecies ?? mon.species ?? "");
  return Object.values(species.abilities ?? {}).map(id);
}

function sideConditionsAt(facts: Fact[], side: string, end: number) {
  const conditions: string[] = [];
  for (const fact of facts.slice(0, end)) {
    if (!["-sidestart", "-sideend"].includes(fact.kind) || !fact.args[0]?.startsWith(side)) continue;
    const name = id(fact.args[1]?.replace(/^move:\s*/i, ""));
    if (fact.kind === "-sidestart") conditions.push(name);
    else for (let index = conditions.indexOf(name); index >= 0; index = conditions.indexOf(name)) conditions.splice(index, 1);
  }
  return conditions;
}

function fieldOnAt(facts: Fact[], name: RegExp, end: number) {
  const last = facts.slice(0, end).filter((fact) => ["-fieldstart", "-fieldend"].includes(fact.kind) && name.test(fact.args[0] ?? "")).at(-1);
  return last?.kind === "-fieldstart";
}

const ENTRY_END = new Set(["move", "cant", "turn", "upkeep", "win", "tie", "request"]);

/** Heavy-Duty Boots entries: an opponent entry onto Stealth Rock (or grounded Spikes) with no HP loss before its side's next
 * entry or the next action, while its item was unknown and no Magic Guard was possible. */
function bootsEntries(snapshot: BattleSnapshot) {
  const facts = snapshot.canonicalEvidence!.facts, side = snapshot.opponentSide.slot;
  const proofs: Array<{ instanceId: string; turn: number; index: number; hazard: string }> = [];
  for (const [index, fact] of facts.entries()) {
    if (!["switch", "drag"].includes(fact.kind) || !fact.subject.side || fact.subject.side !== side || fact.identityStatus !== "resolved" || !fact.ownerInstanceId) continue;
    const mon = snapshot.opponentSide.team.find((entry) => entry.instanceId === fact.ownerInstanceId);
    if (!mon) continue;
    const end = facts.findIndex((entry, at) => at > index && (ENTRY_END.has(entry.kind) || (["switch", "drag"].includes(entry.kind) && entry.subject.side === side)));
    if (end < 0) continue;
    const window = facts.slice(index + 1, end);
    if (window.some((entry) => entry.kind === "-damage" && entry.ownerInstanceId === mon.instanceId) || itemTimeline(facts, mon.instanceId!, index).kind !== "unknown") continue;
    if (fieldOnAt(facts, /magic room/i, index) || possibleAbilities(mon).includes("magicguard")) continue;
    const conditions = sideConditionsAt(facts, side, index);
    const tera = facts.slice(0, index).find((entry) => entry.kind === "-terastallize" && entry.ownerInstanceId === mon.instanceId)?.args[1];
    const types = (tera && tera !== "Stellar" ? [tera] : [...Dex.species.get(fact.args[1]?.split(",")[0] ?? mon.species ?? "").types]).map(id);
    const grounded = fieldOnAt(facts, /gravity/i, index) || (!types.includes("flying") && !possibleAbilities(mon).includes("levitate"));
    const hazard = conditions.includes("stealthrock") ? "Stealth Rock" : conditions.includes("spikes") && grounded ? "Spikes" : null;
    if (hazard) proofs.push({ instanceId: mon.instanceId!, turn: fact.turn, index, hazard });
  }
  return proofs;
}

type OrderSample = { turn: number; opponentId: string; youId: string; opponentFirst: boolean };
/** Turns whose first two actions were priority-0 damaging moves by the two actives, with no order-changing activation. */
function orderSamples(snapshot: BattleSnapshot): OrderSample[] {
  const facts = snapshot.canonicalEvidence!.facts, samples: OrderSample[] = [];
  const opponentSide = snapshot.opponentSide.slot;
  for (const [index, turnFact] of facts.entries()) {
    if (turnFact.kind !== "turn") continue;
    const next = facts.findIndex((fact, at) => at > index && fact.kind === "turn");
    const turnFacts = facts.slice(index + 1, next < 0 ? facts.length : next);
    if (next < 0) continue;
    const actions = turnFacts.filter((fact) => ["move", "switch", "drag", "cant"].includes(fact.kind));
    const [first, second] = actions;
    if (!first || !second || first.kind !== "move" || second.kind !== "move" || first.subject.side === second.subject.side) continue;
    if ([first, second].some((fact) => fact.identityStatus !== "resolved" || !fact.ownerInstanceId || fact.args.some((arg) => arg.startsWith("[from]")))) continue;
    const upTo = turnFacts.slice(0, turnFacts.indexOf(second));
    if (upTo.some((fact) => fact.args.some((arg) => /quick claw|custap|quick draw|quash|after you|instruct/i.test(arg)))) continue;
    const moves = [first, second].map((fact) => Dex.moves.get(fact.args[1] ?? ""));
    if (moves.some((move) => !move.exists || move.category === "Status" || move.priority !== 0 || move.id === "grassyglide")) continue;
    const mons = [first, second].map((fact) => [...snapshot.opponentSide.team, ...snapshot.yourSide.team].find((mon) => mon.instanceId === fact.ownerInstanceId));
    if (mons.some((mon) => !mon || possibleAbilities(mon).some((ability) => ORDER_ABILITIES.includes(ability)))) continue;
    if (mons.some((mon) => ["laggingtail", "fullincense", "quickclaw", "custapberry"].includes(id(mon!.item)))) continue;
    const [opponent, own] = first.subject.side === opponentSide ? [first, second] : [second, first];
    samples.push({ turn: turnFact.turn, opponentId: opponent.ownerInstanceId!, youId: own.ownerInstanceId!, opponentFirst: first === opponent });
  }
  return samples;
}

/** The opponent's Speed-relevant state and the field's, as a comparable key. */
function speedState(snapshot: BattleSnapshot, mon: PokemonSnapshot) {
  const field = snapshot.field;
  return JSON.stringify({ spe: mon.boosts?.spe ?? 0, status: mon.status === "par" ? "par" : null, item: id(mon.item), removed: id(mon.removedItem),
    unburden: mon.unburdenActive ?? null, paradox: mon.paradoxBoostedStat ?? null, slowStart: mon.slowStartActive ?? null,
    weather: id(field.weather), terrain: id(field.terrain), room: field.pseudoWeather.filter((name) => /trick room|magic room|wonder room/i.test(name)).map(id).sort(),
    tailwind: field.opponentSideConditions.some((name) => /tailwind/i.test(name)) });
}

/** The posterior's count of one evidence kind ("Clean damage observations: N"). */
function evidenceCount(posterior: any, kind: "damage" | "speed") {
  const entry = posterior?.evidence?.find((item: any) => item.kind === kind);
  return Number(String(entry?.label ?? "").match(/(\d+)$/)?.[1] ?? 0);
}

type DecisionRecord = { turn: number; youId?: string | undefined; opponentId?: string | undefined; you?: number | undefined; state?: string | undefined; trickRoom: boolean };

export function checkDecision(snapshot: BattleSnapshot, intel: LocalIntelSnapshot, history: DecisionRecord[], report: BeliefReport, rqid: number | null) {
  const facts = snapshot.canonicalEvidence?.facts;
  if (!facts) return;
  const violations = new Map(report.violations.map((violation) => [`${violation.invariant}|${violation.subject}|${violation.detail}`, violation]));
  const fail = (invariant: string, subject: string, detail: string) => {
    const key = `${invariant}|${subject}|${detail}`;
    if (!violations.has(key)) { const violation = { invariant, turn: snapshot.turn, rqid, subject, detail }; violations.set(key, violation); report.violations.push(violation); }
  };
  const check = (name: string) => { report.checks[name] = (report.checks[name] ?? 0) + 1; };
  const entryOf = (mon: PokemonSnapshot) => intel.opponents.find((entry) => entry.instanceId === mon.instanceId);
  const label = (mon: PokemonSnapshot) => mon.canonicalSpecies ?? mon.species ?? "?";
  const opponent = snapshot.opponentSide.active;
  const speed = intel.speedPreview;

  for (const mon of snapshot.opponentSide.team) {
    if (mon.identityStatus !== "resolved" || !mon.instanceId) continue;
    const entry = entryOf(mon), posterior = entry?.posterior;
    // item_fact: the protocol's last word on the item is the snapshot's item state.
    const timeline = itemTimeline(facts, mon.instanceId);
    if (timeline.kind !== "unknown") {
      check("item_fact");
      const matches = timeline.kind === "held" ? id(mon.item) === id(timeline.item) : !mon.item && id(mon.removedItem) === id(timeline.item);
      if (!matches) fail("item_fact", label(mon), `${timeline.kind} ${timeline.item} (fact ${timeline.factId}) but snapshot item=${mon.item} removed=${mon.removedItem}`);
    }
    // hazard_proof: an unaffected hazard entry while the item was unknown proves Boots unless a later item fact says otherwise.
    for (const proof of bootsEntries(snapshot).filter((entry) => entry.instanceId === mon.instanceId)) {
      if (itemTimeline(facts, mon.instanceId).kind !== "unknown") continue;
      check("hazard_proof");
      if (id(mon.item) !== "heavydutyboots") fail("hazard_proof", label(mon), `entered ${proof.hazard} unharmed on T${proof.turn}; item=${mon.item ?? "unknown"}`);
    }
    // item_belief: a known (or removed) item leaves nothing else to believe.
    const known = mon.item ?? mon.removedItem;
    if (known && entry) {
      check("item_belief");
      if (entry.likelyItems.length) fail("item_belief", label(mon), `${known} known; likely items still listed: ${entry.likelyItems.map((item) => item.name).join(", ")}`);
      const others = (posterior?.itemShares ?? []).filter((share) => id(share.name) !== id(known) && share.share > 0);
      if (others.length) fail("item_belief", label(mon), `${known} known; posterior still holds ${others.map((share) => `${share.name} ${share.share}`).join(", ")}`);
    }
    // choice: two moves in one stint rule out every Choice item while the item is hidden.
    const stint = new Set((mon.appearanceMoves ?? []).map(id).filter((move) => move !== "struggle"));
    if (!mon.item && !mon.removedItem && stint.size >= 2 && entry) {
      check("choice");
      const choice = [...entry.likelyItems.map((item) => item.name), ...(posterior?.itemShares ?? []).filter((share) => share.share > 0).map((share) => share.name)].filter((name) => CHOICE.includes(id(name)));
      if (choice.length) fail("choice", label(mon), `two moves this stint (${[...stint].join(", ")}) yet ${[...new Set(choice)].join(", ")} still believed`);
      if (mon.instanceId === opponent?.instanceId && /Choice Scarf/.test(speed?.verdict?.text ?? "") ) fail("choice", label(mon), `two moves this stint yet the speed line says "${speed!.verdict!.text}"`);
    }
    // choice_repeat: every repeat of the stint's only move (not called or forced, no Encore/Disable/Torment) is posterior
    // evidence, and an unrevealed item is never shown as certain.
    if (!mon.item && !mon.removedItem && posterior) {
      check("choice_repeat");
      const over = (posterior.itemShares ?? []).filter((share) => share.share > 0.99);
      if (over.length) fail("choice_repeat", label(mon), `hidden item shown above 99%: ${over.map((share) => `${share.name} ${share.share}`).join(", ")}`);
      const appearance = mon.appearanceId;
      const stintFacts = facts.filter((fact) => appearance && fact.subject.appearanceId === appearance);
      const used = stintFacts.filter((fact) => fact.kind === "move" && !fact.args.some((arg) => arg.startsWith("[from]")) && id(fact.args[1]) !== "struggle").map((fact) => id(fact.args[1]));
      const forced = stintFacts.some((fact) => fact.kind === "-start" && /encore|disable|torment/i.test(fact.args[1] ?? ""));
      if (mon.instanceId === opponent?.instanceId && !forced && used.length >= 2 && new Set(used).size === 1
        && !posterior.evidence.some((entry) => new RegExp(`^Used .+ ${used.length}× in a row`).test(entry.label))) {
        fail("choice_repeat", label(mon), `used ${used[0]} ${used.length}× in a row this stint; the posterior does not count it (${posterior.evidence.map((entry) => entry.label).join("; ")})`);
      }
    }
    // reveal: moves, ability and Tera revealed by the protocol are the known set.
    if (entry) {
      check("reveal");
      const moves = facts.filter((fact) => fact.kind === "move" && fact.ownerInstanceId === mon.instanceId && fact.identityStatus === "resolved"
        && !fact.args.some((arg) => arg.startsWith("[from]")) && id(fact.args[1]) !== "struggle").map((fact) => fact.args[1]!);
      const missing = [...new Set(moves)].filter((move) => !entry.revealedMoves.some((known) => id(known) === id(move)));
      if (missing.length) fail("reveal", label(mon), `used ${missing.join(", ")} but revealed moves are ${entry.revealedMoves.join(", ") || "none"}`);
      const swapped = facts.some((fact) => fact.ownerInstanceId === mon.instanceId && (fact.kind === "-transform" || fact.args.some((arg) => /skill swap|trace|entrainment|role play|doodle|worry seed|simple beam/i.test(arg))));
      const ability = [...facts].reverse().find((fact) => fact.kind === "-ability" && fact.ownerInstanceId === mon.instanceId)?.args[1];
      if (ability && !swapped) {
        if (id(mon.ability) !== id(ability)) fail("reveal", label(mon), `ability ${ability} revealed but snapshot ability=${mon.ability}`);
        const wrong = (posterior?.topHypotheses ?? []).filter((hypothesis) => id(hypothesis.ability) !== id(ability));
        if (wrong.length) fail("reveal", label(mon), `ability ${ability} revealed but posterior keeps ${[...new Set(wrong.map((hypothesis) => hypothesis.ability))].join(", ")}`);
      }
      const tera = facts.find((fact) => fact.kind === "-terastallize" && fact.ownerInstanceId === mon.instanceId)?.args[1];
      if (tera) {
        if (!mon.terastallized || id(mon.teraType) !== id(tera)) fail("reveal", label(mon), `Terastallized ${tera} but snapshot tera=${mon.teraType}/${mon.terastallized}`);
        const wrong = (posterior?.topHypotheses ?? []).filter((hypothesis) => id(hypothesis.teraType) !== id(tera));
        if (wrong.length) fail("reveal", label(mon), `Tera ${tera} revealed but posterior keeps Tera ${[...new Set(wrong.map((hypothesis) => hypothesis.teraType))].join(", ")}`);
      }
    }
    // damage_used: each clean damage observation of this opponent is in its posterior.
    if (posterior) {
      // Inverting a hit needs our side's exact stats at the time (absent before the first request of a resynced capture).
      const ours = (sample: NonNullable<typeof snapshot.canonicalEvidence>["contributions"][number]["damage"]) =>
        sample!.attacker.instanceId === mon.instanceId ? sample!.defender : sample!.attacker;
      const observed = snapshot.canonicalEvidence!.contributions.filter((contribution) => contribution.metric === "damage" && contribution.eligibility === "active"
        && contribution.instanceId === mon.instanceId && contribution.damage
        && ["hp", "atk", "def", "spa", "spd", "spe"].every((stat) => Number.isFinite(ours(contribution.damage)!.stats?.[stat]))).length;
      if (observed) {
        check("damage_used");
        if (evidenceCount(posterior, "damage") !== observed) fail("damage_used", label(mon), `${observed} clean damage observations, posterior counts ${evidenceCount(posterior, "damage")}`);
      }
    }
  }

  if (opponent?.instanceId && speed) {
    const known = opponent.item;
    // item_belief (Speed): a known item other than Choice Scarf leaves no Scarf caveat or Scarf range.
    if (known && id(known) !== "choicescarf") {
      check("item_belief");
      if (/Choice Scarf/.test(speed.verdict?.text ?? "")) fail("item_belief", label(opponent), `${known} known (${opponent.itemProof ? `proven by ${opponent.itemProof.hazard}` : "revealed"}) yet the speed line says "${speed.verdict!.text}"`);
    }
    // choice lock: a known Choice item and one move this stint is a lock, stated as such.
    const stint = opponent.appearanceMoves ?? [];
    const implied = speed.evidence.some((entry) => /^Choice Scarf implied/.test(entry.label));
    if ((CHOICE.includes(id(opponent.item)) || implied) && stint.length === 1) {
      const locked = intel.opponentActionPrediction?.topActions.find((action: any) => id(action.moveName ?? action.label) === id(stint[0]));
      if (locked && Dex.moves.get(stint[0]!).category !== "Status") {
        check("choice");
        if (!(locked as any).reasons?.some((reason: string) => /^Choice-locked into/.test(reason))) {
          fail("choice", label(opponent), `${opponent.item ?? "Choice Scarf (implied by order)"} with one move (${stint[0]}) this stint, but the prediction does not state the lock (${(locked as any).reasons?.join("; ")})`);
        }
      }
    }
    // order_verdict / order_used: earlier clean orders against this opponent, under the same Speed state.
    const you = speed.yourActiveEffectiveSpeed, trickRoom = snapshot.field.pseudoWeather.some((name) => /trick room/i.test(name));
    const state = speedState(snapshot, opponent);
    // An order is a Speed bound only against our exact Speed then: a decision of ours that turn shows it was known.
    const samples = orderSamples(snapshot).filter((sample) => sample.opponentId === opponent.instanceId
      && history.some((record) => record.turn === sample.turn && record.youId === sample.youId && Number.isFinite(record.you)));
    if (samples.length && speed.reason !== "capture_gap") {
      check("order_used");
      if (!speed.evidence.some((entry) => ["current_turn_order", "item_ability_assumption", "confounded"].includes(entry.kind) && /T\d+ (?:before|after)/.test(`${entry.label} ${entry.detail ?? ""}`))) {
        fail("order_used", label(opponent), `orders on ${samples.map((sample) => `T${sample.turn} ${sample.opponentFirst ? "they moved first" : "you moved first"}`).join(", ")} absent from Speed evidence (${speed.evidence.map((entry) => entry.label).join("; ")})`);
      }
    }
    for (const sample of samples) {
      const then = [...history].reverse().find((record) => record.turn === sample.turn && record.opponentId === opponent.instanceId && record.youId === sample.youId);
      if (!then || then.state !== state || then.trickRoom !== trickRoom || !Number.isFinite(then.you) || !Number.isFinite(you)) continue;
      // Under Trick Room the slower Pokémon moves first: their Speed was at least yours (ties allowed) when they moved first
      // without it, or second with it. Only a Speed of yours on the same side of that threshold carries the order over.
      const theyAtLeast = sample.opponentFirst !== trickRoom;
      if (theyAtLeast ? you! > then.you! : you! < then.you!) continue;
      check("order_verdict");
      const wrongRelation = theyAtLeast ? speed.activeRelation === "faster" : speed.activeRelation === "slower";
      const text = speed.verdict?.text ?? "";
      const wrongVerdict = sample.opponentFirst ? /^You move first/.test(text) : /^They move first/.test(text);
      if (wrongRelation || wrongVerdict) {
        fail("order_verdict", label(opponent), `T${sample.turn}: ${sample.opponentFirst ? "they" : "you"} moved first (you ${then.you}${trickRoom ? ", Trick Room" : ""}); now you ${you} and the engine says ${speed.activeRelation} / "${speed.verdict?.text}" (range ${JSON.stringify(speed.effectiveRange)})`);
      }
    }
  }
  const requestKind = snapshot.rawRequestSummary?.requestKind;
  if (snapshot.phase === "turn" && requestKind === "move" && opponent && snapshot.yourSide.active) {
    history.push({ turn: snapshot.turn, youId: snapshot.yourSide.active.instanceId, opponentId: opponent.instanceId, you: speed?.yourActiveEffectiveSpeed,
      state: speedState(snapshot, opponent), trickRoom: snapshot.field.pseudoWeather.some((name) => /trick room/i.test(name)) });
  }
}

/** Replays protocol frames (each the data of one browser frame, as the journals record them) for one room. */
export async function checkBattleBeliefs(frames: string[], roomId: string, options: { movePriors?: MetaMovePrior | undefined } = {}): Promise<BeliefReport> {
  const engine = new DecisionEngine({ source: "owned_offline_simulator" });
  let context = await createEphemeralIntelEvaluationContext(options.movePriors);
  const report: BeliefReport = { decisions: 0, checks: {}, violations: [] };
  const history: DecisionRecord[] = [], seen = new Set<number>();
  let sequence = 0;
  for (const data of frames) {
    sequence += 1;
    const current = await engine.ingest({ sessionId: "belief-check", roomId, source: "protocol", observationId: `frame-${sequence}`, sequence, data: `>${roomId}\n${data}` });
    if (current.snapshot) context = await projectCanonicalSnapshots([current.snapshot], context);
    const rqid = current.identity?.rqid ?? null;
    if (!current.identity || rqid === null || seen.has(rqid) || current.snapshot?.rawRequestSummary?.wait) continue;
    seen.add(rqid);
    const envelope: any = await evaluateDecision(engine, "belief-check", current.identity, context);
    const intel = envelope.semantic.localIntel as LocalIntelSnapshot;
    if (!intel?.opponents?.length && !intel?.speedPreview) continue;
    report.decisions += 1;
    checkDecision(envelope.semantic.snapshot, intel, history, report, rqid);
  }
  return report;
}
