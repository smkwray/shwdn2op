import { Dex } from "@pkmn/dex";
import { battlePosteriorItems, choiceScarfImplied, stintRepeat } from "../mechanics/liveLikelyItems.js";
import { buildDamagePreview, MOVE_TYPE_IMMUNITY_ABILITY_LABELS } from "../prompting/damageNotes.js";
import { ownAnswerTo, type OwnAnswer } from "../history/opponentIntelStore.js";
import type { BattleSnapshot, DamageAssumptionBand, LegalAction, LocalIntelSnapshot, PokemonSnapshot, ThreatPreview, ThreatTargetPreview } from "../types.js";
import type { DecisionEnvelope } from "./battleAgent.js";

/** Deterministic tactical guards from the decision envelope's engine data only (pre-registered re-ranker). Red guards are facts that hold at the engine's set-prior ("likely") min roll under strict Speed/priority
 * order; only FLAG_KINDS are flagged for the re-ranker (the later kinds are shown, never re-ranked). Anything
 * that depends on an overlapping Speed range, an unquantified pending effect or a usage guess is a warning ("amber"). Crits, accuracy below 100%, and rare order items
 * (Lagging Tail on the opponent) are outside every claim; moves under 100% accuracy never support a certain KO. */
export const GUARDS_VERSION = "tactical-guards@6";

/** Hazard moves and the layers at which another use fails. */
const HAZARD_MAX: Record<string, number> = { stealthrock: 1, stickyweb: 1, spikes: 3, toxicspikes: 2 };
const REMOVAL_MOVES = ["rapidspin", "defog", "mortalspin", "tidyup", "courtchange"];
/** Species that can learn hazard removal in Gen 9 (own, base-forme or pre-evolution learnset). Only these can clear a
 * maxed hazard before our move and let it work again (re-setting Stealth Rock against a Pokémon that
 * cannot remove it is a certain failure). */
const HAZARD_REMOVERS: ReadonlySet<string> = await (async () => {
  const out = new Set<string>();
  for (const species of Dex.forGen(9).species.all()) {
    if (!species.exists) continue;
    const chain = [species.id];
    if (species.baseSpecies !== species.name) chain.push(Dex.species.get(species.baseSpecies).id);
    for (let cur = species; cur.prevo; ) { cur = Dex.species.get(cur.prevo); chain.push(cur.id); }
    for (const id of chain) {
      const learnset = (await Dex.learnsets.get(id))?.learnset;
      if (learnset && REMOVAL_MOVES.some((move) => (learnset[move] ?? []).some((source) => source.startsWith("9")))) { out.add(species.id); break; }
    }
  }
  return out;
})();
export type FlagKind = "delayed_slot_occupied" | "hazard_maxed" | "pre_move_ko" | "setup_dead_end" | "switch_into_ko";
export type GuardKind = FlagKind | "choice_lock" | "tera_survival" | "priority_caveat" | "last_answer" | "tera_resist"
  | "retaliation_ko" | "ability_immune" | "no_progress" | "no_safe_option";
export interface TacticalGuard {
  kind: GuardKind;
  severity: "red" | "amber";
  /** Actions the fact is about; empty = a state-level warning. */
  actionIds: string[];
  /** The full fact, for a tooltip. */
  message: string;
  /** One line for the strip (≤ SHORT_MAX characters). */
  short: string;
}
/** A warning line must fit the strip without wrapping, or it resizes Showdown's controls; the full message is the tooltip. */
export const SHORT_MAX = 56;
/** The first variant that fits, else the last one cut with an ellipsis. */
export function fitShort(...variants: string[]): string {
  const fitting = variants.find((text) => text.length <= SHORT_MAX);
  if (fitting !== undefined) return fitting;
  const last = variants.at(-1) ?? "";
  return `${last.slice(0, SHORT_MAX - 1).trimEnd()}…`;
}
/** flagged: each action's red (re-rankable) kinds. */
export interface GuardReport { version: typeof GUARDS_VERSION; guards: TacticalGuard[]; flagged: Record<string, FlagKind[]> }

const FLAG_KINDS: readonly GuardKind[] = ["delayed_slot_occupied", "hazard_maxed", "pre_move_ko", "setup_dead_end", "switch_into_ko"];
/** Each action's red kinds, in a stable order. */
export function flaggedBy(guards: readonly TacticalGuard[]): Record<string, FlagKind[]> {
  const flagged: Record<string, FlagKind[]> = {};
  for (const guard of guards) if (guard.severity === "red" && FLAG_KINDS.includes(guard.kind)) for (const id of guard.actionIds) {
    const kinds = (flagged[id] ??= []);
    if (!kinds.includes(guard.kind as FlagKind)) kinds.push(guard.kind as FlagKind);
  }
  for (const kinds of Object.values(flagged)) kinds.sort((a, b) => FLAG_KINDS.indexOf(a) - FLAG_KINDS.indexOf(b));
  return flagged;
}

const dex = Dex.forGen(9);
const CHOICE_ITEMS = ["choiceband", "choicespecs", "choicescarf"];
/** Combined Choice share below which a one-move stint is no lock warning. */
const MIN_CHOICE_SHARE = 0.1;
/** Combined ladder share of defensive Teras that must save the opponent before a KO counts as at risk. */
const MIN_BLUNT_SHARE = 0.25;
/** Combined ladder share of nullifying abilities/items below which an unrevealed one is not named. */
const MIN_NULLIFY_SHARE = 0.2;
/** Ladder Tera share below which a defensive Tera is not named. */
const MIN_TERA_SHARE = 0.1;
/** An unrevealed item is never shown as certain. */
const sharePct = (share: number) => `${Math.min(99, Math.round(share * 100))}%`;
const shortItem = (name: string) => name.replace(/^Choice /, "");
const EPS = 0.05; // engine bands are rounded to 0.1%
const pct = (value: number) => `${Math.round(value)}%`;
const range = (lo: number, hi: number) => `${Math.round(lo)}–${Math.round(hi)}%`;
const norm = (value: string | null | undefined) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const damaging = (band: DamageAssumptionBand | undefined) => Boolean(band && (band.outcome ?? "damage") === "damage"
  && Number.isFinite(band.minPercent) && Number.isFinite(band.maxPercent));
const likely = (bands: DamageAssumptionBand[] | undefined) => (bands ?? []).find((band) => band.label === "likely");
const highest = (bands: DamageAssumptionBand[] | undefined) => Math.max(...(bands ?? []).filter(damaging).map((band) => band.maxPercent!), Number.NEGATIVE_INFINITY);
type Bounds = { min: number; max: number };

function typeMultiplier(moveType: string, types: string[]) {
  if (!types.length) return null;
  return dex.getImmunity(moveType, types) ? 2 ** dex.getEffectiveness(moveType, types) : 0;
}

function actionPriority(active: PokemonSnapshot, moveName: string) {
  const move = dex.moves.get(moveName);
  if (!move.exists) return null;
  const ability = norm(active.ability);
  let priority = move.priority;
  if (ability === "prankster" && move.category === "Status") priority += 1;
  if (ability === "galewings" && move.type === "Flying" && (active.hpPercent ?? 0) >= 100) priority += 1;
  if (ability === "triage" && move.flags.heal) priority += 3;
  return priority;
}

/** Threat bands against the active's defensive typing after this action's Terastallization (damage is linear in the
 * type multiplier); null when that rescale is unsafe (Stellar keeps types, immunity, missing data). */
function teraScaled(band: DamageAssumptionBand, moveName: string, active: PokemonSnapshot, action: LegalAction): Bounds | null {
  const base = { min: band.minPercent!, max: band.maxPercent! };
  if (!action.terastallize || active.terastallized) return base;
  const move = dex.moves.get(moveName), tera = active.teraType;
  if (!move.exists || !tera || norm(tera) === "stellar") return null;
  const current = active.types?.length ? active.types : [...dex.species.get(active.species ?? "").types];
  const before = typeMultiplier(move.type, current), after = typeMultiplier(move.type, [tera]);
  if (!before || after === null) return null;
  return { min: base.min * after / before, max: base.max * after / before };
}

/** Our survival items/abilities that break a KO claim (full-HP ones, and an intact Disguise at any HP). */
const fullHpShield = (mon: PokemonSnapshot) => (norm(mon.ability) === "disguise" && !/busted/i.test(mon.species ?? ""))
  || ((mon.hpPercent ?? 0) >= 100 && (norm(mon.item) === "focussash" || ["sturdy", "multiscale", "shadowshield"].includes(norm(mon.ability))));

export function computeTacticalGuards(envelope: DecisionEnvelope): GuardReport {
  const snapshot = envelope.semantic.snapshot as BattleSnapshot, intel = envelope.semantic.localIntel as LocalIntelSnapshot;
  const guards: TacticalGuard[] = [];
  const report = (): GuardReport => {
    // One guard per distinct fact: identical findings (e.g. plain and Tera variants) share an entry.
    const merged: TacticalGuard[] = [];
    for (const guard of guards) {
      const same = merged.find((entry) => entry.kind === guard.kind && entry.severity === guard.severity && entry.message === guard.message);
      if (same) same.actionIds.push(...guard.actionIds.filter((id) => !same.actionIds.includes(id)));
      else merged.push({ ...guard, actionIds: [...guard.actionIds] });
    }
    return { version: GUARDS_VERSION, guards: merged, flagged: flaggedBy(merged) };
  };
  const request = snapshot.rawRequestSummary as { requestKind?: string; wait?: boolean } | null | undefined;
  const you = snapshot.yourSide.active, them = snapshot.opponentSide.active;
  // A forced switch (a faint or our own pivot) still chooses a switch-in: only the switch-in guard (d) applies.
  const forced = request?.requestKind === "forced_switch";
  if (envelope.semantic.capabilities.status === "unsupported" || snapshot.phase !== "turn" || request?.wait
    || (request?.requestKind && request.requestKind !== "move" && !forced) || !you || !them || (you.fainted && !forced) || them.fainted) return report();
  const hp = you.hpPercent, oppHp = them.hpPercent;
  if (!forced && (!Number.isFinite(hp) || !Number.isFinite(oppHp))) return report();
  const enabled = snapshot.legalActions.filter((action) => action.choice && !action.disabled && action.legality !== "disabled");
  const moves = enabled.filter((action) => action.kind === "move" && action.moveName);
  const damage = intel.playerDamagePreview ?? [];
  const threats = intel.opponentThreatPreview ?? [];
  const speed = intel.speedPreview;
  const name = (mon: PokemonSnapshot) => mon.species ?? mon.displayName ?? "the active";
  const youName = name(you), themName = name(them);
  const trickRoom = snapshot.field.pseudoWeather.some((entry) => /trick room/i.test(entry));
  // Strict order at equal priority: the engine's own relation, never across Trick Room or a capture gap. The relation
  // applies paralysis, stages, Tailwind and known items exactly and widens possible abilities and order conflicts into
  // its range ("unknown" for a conflict); a listed confounder is no reason to doubt it.
  const orderKnown = Boolean(speed && !trickRoom && speed.activeRelation !== "unknown" && speed.reason !== "capture_gap");
  const oppFirst = orderKnown && speed!.activeRelation === "slower";
  const youFirst = orderKnown && speed!.activeRelation === "faster" && !(speed!.possibleRange && Number.isFinite(speed!.yourActiveEffectiveSpeed)
    && speed!.possibleRange.max >= speed!.yourActiveEffectiveSpeed!);
  const ownOrderItem = ["quickclaw", "custapberry"].includes(norm(you.item)) || norm(you.ability) === "quickdraw";
  // When only a possible item (a Choice Scarf) can make it faster, say so: "Speed 208–324 vs your 459" read as a
  // contradiction of "may move first".
  const possibleItems = speed?.evidence?.find((entry) => entry.kind === "item_ability_assumption" && /^Possible item range/.test(entry.label))?.detail;
  const itemFaster = Boolean(speed?.activeRelation === "faster" && speed.possibleRange && Number.isFinite(speed.yourActiveEffectiveSpeed)
    && speed.possibleRange.max >= speed.yourActiveEffectiveSpeed!);
  const speedText = speed?.effectiveRange && Number.isFinite(speed.yourActiveEffectiveSpeed)
    ? ` (Speed ${speed.effectiveRange.min}–${speed.effectiveRange.max}${itemFaster ? `, ≤${speed.possibleRange!.max} with ${possibleItems ?? "a Speed item"}` : ""} vs your ${speed.yourActiveEffectiveSpeed})` : "";
  // A Choice item known, or a Choice Scarf the observed turn order implies (no item-free Speed fits it), and one move used
  // this stint: only that move remains usable.
  const scarfImplied = choiceScarfImplied(them, speed?.evidence);
  const choiceItem = CHOICE_ITEMS.includes(norm(them.item)) ? them.item! : scarfImplied ? "Choice Scarf" : null;
  const choiceKnown = Boolean(choiceItem);
  const stint = them.appearanceMoves ?? [];
  const lockedInto = choiceKnown && stint.length === 1 ? norm(stint[0]) : null;
  // Fake Out / First Impression only work on a stint's first turn (the engine's own priority-move rule).
  const firstTurnOnly = (name: string) => ["fakeout", "firstimpression"].includes(norm(name)) && (them.turnsSinceEntry ?? 0) > 1;
  const usable = (threat: ThreatPreview) => (!lockedInto || norm(threat.moveName) === lockedInto) && !firstTurnOnly(threat.moveName);
  // An opponent that may not act this turn (asleep, frozen, possibly fully paralysed) makes no hit certain.
  const mayNotAct = ["slp", "frz", "par"].includes(norm(them.status));
  /** Moves that fail into our action: Sucker Punch/Thunderclap into a status move, Upper Hand into a non-priority one. */
  const failsInto = (threatName: string, ownMove: string) => {
    const threat = norm(threatName), own = dex.moves.get(ownMove);
    return (["suckerpunch", "thunderclap"].includes(threat) && own.category === "Status") || (threat === "upperhand" && own.priority <= 0);
  };
  // Possible from ladder/history items or from this battle's posterior (repeats of one move raise it there).
  const choicePossible = choiceKnown || (!them.item && !them.removedItem && (intel.opponents ?? []).some((entry) => entry.instanceId === them.instanceId
    && [...entry.likelyItems, ...battlePosteriorItems(entry)].some((item) => CHOICE_ITEMS.includes(norm(item.name)) && item.share > 0)));
  const possiblyLockedElsewhere = (threat: ThreatPreview) => choicePossible && !choiceKnown && stint.length === 1 && norm(stint[0]) !== norm(threat.moveName);
  const sure = (moveName: string) => { const move = dex.moves.get(moveName); return move.exists && (move.accuracy === true || move.accuracy >= 100); };

  // (d) Switch target KO'd by every considered reply while an alternative survives them all. On a forced switch staying in
  // is no alternative, and a reply KO is only a warning: after a faint the switch-in can act before the reply.
  const switchGuards = () => {
    const considered = threats.filter(usable);
    const surviveAll = (targetOf: (threat: ThreatPreview) => ThreatTargetPreview | undefined) =>
      considered.every((threat) => {
        const target = targetOf(threat), band = likely(target?.bands);
        if (!target || !Number.isFinite(target.targetCurrentHpPercent)) return false;
        return !damaging(band) ? (target.bands ?? []).length > 0 : band!.maxPercent! + EPS < target.targetCurrentHpPercent!;
      });
    const switches = enabled.filter((action) => action.kind === "switch");
    if (!considered.length || !considered.some((threat) => threat.moveSource === "known")) return;
    const targetFor = (action: LegalAction) => (threat: ThreatPreview) => threat.switchTargets.find((entry) => entry.instanceId && entry.instanceId === action.targetInstanceId);
    for (const action of switches) {
      const targets = considered.map(targetFor(action));
      const hazardKo = targets.some((target) => target?.summary.startsWith("Projected entry hazards KO"));
      const allKo = hazardKo || targets.every((target) => {
        const band = likely(target?.bands);
        return damaging(band) && Number.isFinite(target!.targetCurrentHpPercent) && band!.minPercent! - EPS >= target!.targetCurrentHpPercent!
          && considered.every((threat) => sure(threat.moveName));
      });
      if (!allKo || mayNotAct) continue;
      const alternative = (!forced && surviveAll((threat) => threat.currentTarget)) || switches.some((other) => other !== action && surviveAll(targetFor(other)));
      if (!alternative) continue;
      const targetName = action.label.replace(/^Switch to /, "").replace(/, slot \d+$/, "");
      const moves = considered.map((threat) => threat.moveName).join(", ");
      guards.push({ kind: "switch_into_ko", severity: hazardKo || !forced ? "red" : "amber", actionIds: [action.id],
        message: hazardKo ? `Entry hazards KO ${targetName} on the switch.` : forced ? `${targetName} is KO'd by every likely reply (${moves}) if it takes one; another switch-in survives them.`
          : `${targetName} is KO'd on entry by every likely reply (${moves}); another option survives them.`,
        short: hazardKo ? fitShort(`Hazards KO ${targetName} on entry`, "Hazards KO it on entry") : fitShort(`${targetName} is KO'd on entry`, "KO'd on entry") });
    }
  };
  if (forced) { switchGuards(); return report(); }

  // (a) Rules-certain failure: a delayed attack into an occupied slot.
  for (const action of moves) {
    const preview = damage.find((entry) => entry.actionId === action.id);
    if (preview?.delayed?.scheduling !== "occupied") continue;
    const pending = (snapshot.pendingAttacks ?? []).find((entry) => entry.targetSide === preview.delayed!.targetSide);
    guards.push({ kind: "delayed_slot_occupied", severity: "red", actionIds: [action.id],
      message: `${preview.moveName} will fail: ${pending ? `a ${pending.moveName} already lands at the end of turn ${pending.dueTurn}` : "one is already pending"}. Switching or sacrificing ${youName} remain options.`,
      short: fitShort(`${preview.moveName} fails: one is already pending`, "Fails: one is already pending") });
  }

  // (a2) Rules-certain failure: a hazard already at its maximum layers fails unless the opponent removes it first, and the
  // active cannot (no Gen 9 removal move, or four revealed moves without one; a possible Illusion user keeps it a warning).
  // Envelopes without side conditions (eval-side snapshots) cannot prove a hazard is up: no guard rather than a guess.
  const theirHazards = Array.isArray(snapshot.field?.opponentSideConditions) ? snapshot.field.opponentSideConditions.map(norm) : null;
  const revealed = ((intel.opponents ?? []).find((entry) => entry.instanceId === them.instanceId)?.revealedMoves ?? []).map(norm);
  const illusionPossible = (snapshot.opponentSide.team ?? []).some((entry) => /^zoroark/i.test(entry.species ?? "") && !entry.fainted && entry.instanceId !== them.instanceId);
  const canRemove = HAZARD_REMOVERS.has(norm(them.species)) && !(revealed.length >= 4 && !revealed.some((move) => REMOVAL_MOVES.includes(move)));
  for (const action of moves) {
    const hazard = norm(action.moveName), max = HAZARD_MAX[hazard];
    if (!max || !theirHazards || theirHazards.filter((entry) => entry === hazard).length < max) continue;
    const certain = !canRemove && !illusionPossible;
    guards.push({ kind: "hazard_maxed", severity: certain ? "red" : "amber", actionIds: [action.id],
      message: `${action.moveName} is already up${max > 1 ? ` (${max} layers)` : ""}; it ${certain ? `fails: ${themName} cannot remove hazards` : `only works if ${themName} removes it first`}.`,
      short: fitShort(certain ? `${action.moveName} already up: fails` : `${action.moveName} already up`, "Already up") });
  }

  // KO facts for one threat against our active under one action (Tera rescales our defensive typing).
  const koAgainst = (threat: ThreatPreview, action: LegalAction) => {
    const band = likely(threat.currentTarget.bands);
    if (!damaging(band)) return null;
    const scaled = teraScaled(band!, threat.moveName, you, action);
    if (!scaled) return null;
    return { ...scaled, ko: scaled.min - EPS >= hp! && !fullHpShield(you), survives: scaled.max + EPS < hp! };
  };

  // (b) Pre-move KO when staying with a non-priority action.
  const preMove = new Map<string, { certain: boolean; orderCertain: boolean; threat: string; bounds: Bounds; priority: boolean }>();
  for (const action of moves) {
    const ours = actionPriority(you, action.moveName!);
    if (ours === null) continue;
    for (const threat of threats) {
      if (!usable(threat)) continue;
      const ko = koAgainst(threat, action), move = dex.moves.get(threat.moveName);
      if (!ko?.ko || !move.exists || failsInto(threat.moveName, action.moveName!)) continue;
      const theirs = move.priority;
      const certainOrder = !ownOrderItem && (theirs > ours || (theirs === ours && oppFirst));
      const possibleOrder = theirs > ours || (theirs === ours && !youFirst);
      if (!possibleOrder) continue;
      const certain = certainOrder && threat.moveSource === "known" && sure(threat.moveName) && !possiblyLockedElsewhere(threat) && !mayNotAct;
      const prior = preMove.get(action.id);
      if (!prior || (certain && !prior.certain)) preMove.set(action.id, { certain, orderCertain: certainOrder, threat: threat.moveName, bounds: ko, priority: theirs > ours });
    }
  }
  const preMoveGroups = new Map<string, { certain: boolean; orderCertain: boolean; ids: string[]; threat: string; bounds: Bounds; priority: boolean }>();
  for (const [id, fact] of preMove) {
    const key = `${fact.certain}|${fact.orderCertain}|${fact.threat}|${fact.bounds.min.toFixed(1)}|${fact.bounds.max.toFixed(1)}|${fact.priority}`;
    const group = preMoveGroups.get(key) ?? { ...fact, ids: [] };
    group.ids.push(id); preMoveGroups.set(key, group);
  }
  for (const group of preMoveGroups.values()) {
    // "May" belongs to whichever part is uncertain: the order, or the hit (an unrevealed move, accuracy, a possible lock).
    const order = group.priority ? `${group.threat} has priority` : group.orderCertain ? `${themName} moves first${speedText}` : `${themName} may move first${speedText}`;
    guards.push({ kind: "pre_move_ko", severity: group.certain ? "red" : "amber", actionIds: group.ids,
      message: `${order}; its ${group.certain ? "" : "likely "}${group.threat} KOs ${youName} (${range(group.bounds.min, group.bounds.max)} vs ${pct(hp!)} HP) before ${youName} moves.`,
      // "KO'd first" contradicts the pick: if it is right, the pick never happens. The strip shows it red on the pick.
      short: group.certain ? fitShort(`KO'd first by ${group.threat}`, "KO'd before it moves") : fitShort(`May be KO'd first by ${group.threat}`, "May be KO'd before it moves") });
  }

  // (e) Retaliation (warnings only): our attack may act first but does not KO at the likely max, and a
  // revealed reply then KOs from the state that attack leaves: its own stat drops (Close Combat's Defense; Foul Play
  // reads our Attack stages), recoil, Life Orb and the target's contact punishers, under this action's Tera typing. A
  // "may be KO'd first" alone understates a Close Combat whose Defense drop makes Foul Play a KO in either order.
  const ownMaxHp = maxHpOf(you), oppMaxHpLow = minMaxHp(them);
  for (const action of moves) {
    const own = dex.moves.get(action.moveName!), ours = actionPriority(you, action.moveName!);
    if (!own.exists || own.category === "Status" || own.selfSwitch || own.flags.futuremove || ours === null) continue;
    const mine = likely(damage.find((entry) => entry.actionId === action.id)?.bands);
    if (!damaging(mine) || mine!.maxPercent! + EPS >= oppHp!) continue;
    const effect = selfEffects(you, own, Math.min(mine!.minPercent!, oppHp!), ownMaxHp, oppMaxHpLow);
    const contact = own.flags.contact ? (norm(them.item) === "rockyhelmet" ? 100 / 6 : 0) + (["roughskin", "ironbarbs"].includes(norm(them.ability)) ? 12.5 : 0) : 0;
    const hpAfter = hp! - effect.hpLoss - contact;
    if (hpAfter <= EPS) continue; // its own recoil ends it: not a retaliation fact
    let best: { certain: boolean; threat: string; known: boolean; bounds: Bounds; orderCertain: boolean } | null = null;
    for (const threat of threats) {
      if (!usable(threat) || failsInto(threat.moveName, action.moveName!)) continue;
      const band = likely(threat.currentTarget.bands), threatMove = dex.moves.get(threat.moveName);
      if (!damaging(band) || !threatMove.exists) continue;
      if (threatMove.priority > ours || (threatMove.priority === ours && oppFirst)) continue; // it hits first: pre-move guard
      const scaled = teraScaled(band!, threat.moveName, you, action);
      if (!scaled) continue;
      const factor = stageFactor(you, them, threatMove, effect.boosts);
      const bounds = { min: scaled.min * factor, max: scaled.max * factor };
      if (bounds.min - EPS < hpAfter) continue;
      const orderCertain = !ownOrderItem && (ours > threatMove.priority || youFirst);
      const koAnyway = scaled.min - EPS >= hp!;
      const known = threat.moveSource === "known";
      const certain = known && orderCertain && sure(threat.moveName) && !mayNotAct && !possiblyLockedElsewhere(threat) && (koAnyway || sure(action.moveName!));
      if (!best || (certain && !best.certain) || (known && !best.known && !best.certain)) best = { certain, threat: threat.moveName, known, bounds, orderCertain };
    }
    if (!best) continue;
    const after = [effect.label, contact ? "contact damage" : ""].filter(Boolean).join(", ");
    guards.push({ kind: "retaliation_ko", severity: best.certain ? "red" : "amber", actionIds: [action.id],
      message: `${best.orderCertain ? "" : "If it moves first, "}${own.name} does not KO ${themName} (≤${pct(mine!.maxPercent!)} vs ${pct(oppHp!)} HP); then ${best.known ? "" : "its likely "}${best.threat} KOs ${youName} (≈${range(best.bounds.min, best.bounds.max)} vs ${pct(Math.max(0, hpAfter))} HP${after ? ` after ${after}` : ""}).`,
      short: fitShort(`No KO; ${best.threat} KOs back${effect.short ? ` (after ${effect.short})` : ""}`, `No KO; ${best.threat} KOs back`, "Fails to KO; retaliation KOs") });
  }

  // (f) Nullified move: every band of the action is immune or blocked (a revealed ability, the type chart, a known item) —
  // red; or an unrevealed ability this Pokémon runs (ladder or history shares) would nullify its type — amber with that share (e.g.
  // Scald into a Clodsire with 67% Water Absorb on the ladder, and again once Water Absorb is revealed).
  const themEntry = (intel.opponents ?? []).find((entry) => entry.instanceId === them.instanceId);
  for (const action of moves) {
    const preview = damage.find((entry) => entry.actionId === action.id);
    if (!preview) continue;
    const bands = preview.bands ?? [];
    if (bands.length && bands.every((band) => band.outcome === "immune" || band.outcome === "blocked")) {
      const moveType = effectiveMoveType(you, action), types = them.types?.length ? them.types : [...dex.species.get(them.species ?? "").types];
      const immuneType = moveType ? types.find((type) => typeMultiplier(moveType, [type]) === 0) : undefined;
      const label = immuneType ? `${immuneType} type` : them.ability ?? them.item ?? "immune";
      guards.push({ kind: "ability_immune", severity: "red", actionIds: [action.id],
        message: `${preview.moveName} does nothing to ${themName} (${label}).`,
        short: fitShort(`${preview.moveName} does nothing (${label})`, `${preview.moveName} does nothing`, "Does nothing") });
      continue;
    }
    const moveType = effectiveMoveType(you, action), own = dex.moves.get(action.moveName!);
    if (them.ability || !moveType || own.category === "Status" || ["moldbreaker", "teravolt", "turboblaze"].includes(norm(you.ability))) continue;
    const nullifying = new Set((MOVE_TYPE_IMMUNITY_ABILITY_LABELS[norm(moveType)] ?? []).map(norm));
    const possible = (themEntry?.likelyAbilities ?? []).filter((entry) => nullifying.has(norm(entry.name)) && entry.share > 0)
      .map((entry) => ({ label: entry.name, share: entry.share })).sort((a, b) => b.share - a.share);
    const total = possible.reduce((sum, entry) => sum + entry.share, 0);
    if (!possible.length || total < MIN_NULLIFY_SHARE) continue;
    guards.push({ kind: "ability_immune", severity: "amber", actionIds: [action.id],
      message: `${preview.moveName} would do nothing if ${themName} has ${possible.map((entry) => `${entry.label} (${sharePct(entry.share)} on the ladder)`).join(" or ")}.`,
      short: fitShort(`${possible[0]!.label} ${sharePct(total)}: ${preview.moveName} may do nothing`, `${possible[0]!.label} ${sharePct(total)}: may do nothing`, `May do nothing (${sharePct(total)})`) });
  }

  // (g) No progress: the active used this recovery move on each of the last turns against the same opponent while the
  // opponent's HP, status, hazards and stat stages did not get worse (e.g. repeated Slack Offs into a full-HP
  // Clodsire). The board recurs; the recovery PP is the only thing spent.
  const facts = snapshot.canonicalEvidence?.facts ?? [];
  const theirSide = snapshot.opponentSide.slot;
  for (const moveName of [...new Set(moves.map((action) => action.moveName!))]) {
    const move = dex.moves.get(moveName);
    if (!you.appearanceId || !them.appearanceId || !move.exists || move.category !== "Status" || move.target !== "self" || !move.flags.heal) continue;
    const used = (turn: number) => facts.filter((fact) => fact.kind === "move" && fact.turn === turn && fact.subject.appearanceId === you.appearanceId && !fact.args.some((arg) => arg.startsWith("[from]")));
    let streak = 0;
    while (streak < snapshot.turn) { const turnMoves = used(snapshot.turn - 1 - streak); if (!turnMoves.length || turnMoves.some((fact) => norm(fact.args[1]) !== norm(moveName))) break; streak++; }
    const start = snapshot.turn - streak;
    if (streak < 2) continue;
    const ofThem = (fact: (typeof facts)[number]) => fact.subject.appearanceId === them.appearanceId;
    // The same opponent stint (appearance) throughout: one that entered during the streak has no HP before it.
    const hpBefore = [...facts].reverse().find((fact) => fact.turn < start && ofThem(fact) && ["switch", "drag", "-damage", "-heal", "-sethp"].includes(fact.kind));
    const before = hpPercentOf(hpBefore?.args[hpBefore.kind === "switch" || hpBefore.kind === "drag" ? 2 : 1]);
    const worse = facts.some((fact) => fact.turn >= start && ((ofThem(fact) && ["-status", "-unboost"].includes(fact.kind))
      || (fact.kind === "-sidestart" && String(fact.args[0] ?? "").startsWith(theirSide))));
    if (before === null || worse || (oppHp! < before - 1)) continue;
    const nth = ordinal(streak + 1);
    guards.push({ kind: "no_progress", severity: "amber", actionIds: moves.filter((action) => action.moveName === moveName).map((action) => action.id),
      message: `${youName} has used ${moveName} on each of the last ${streak} turns against ${themName}, whose HP (${pct(before)} → ${pct(oppHp!)}), status, hazards and stat stages did not get worse; this would be the ${nth}.`,
      short: fitShort(`No progress: ${nth} ${moveName} in a row`, `No progress: ${nth} in a row`) });
  }

  // (c) Two-ply setup dead end: the setup survives this hit but the same revealed hit KOs next turn before any
  // non-priority move, and no priority move can KO even at the boosted stage.
  const ownPending = (snapshot.pendingAttacks ?? []).filter((entry) => entry.sourceSide === snapshot.yourSide.slot && entry.dueTurn <= snapshot.turn);
  const teraUsedByOpponent = snapshot.opponentSide.team.some((mon) => mon.terastallized);
  /** Upper bound on our own delayed attacks landing on the opponent before next turn (exact caster stats, the engine's
   * own delayed bands against the current opponent); null when unbounded (it can still Terastallize). */
  const pendingMax = (): number | null => {
    let total = 0;
    for (const entry of ownPending) {
      const source = snapshot.yourSide.team.find((mon) => mon.instanceId === entry.sourceInstanceId);
      if (!source || !teraUsedByOpponent) return null; // an unrevealed Tera can change the delayed hit's effectiveness
      const caster = { ...source, active: true, fainted: false, hpPercent: 100, boosts: source.active ? source.boosts : {} };
      const preview = buildDamagePreview({ ...snapshot, yourSide: { ...snapshot.yourSide, active: caster },
        legalActions: [{ id: "pending", kind: "move", label: entry.moveName, moveName: entry.moveName, moveSlot: 1, choice: "move 1" }] })[0];
      const bound = highest(preview?.delayed?.bands);
      if (!Number.isFinite(bound)) return null;
      total += bound;
    }
    return total;
  };
  /** Upper bound on the opponent's own HP loss before next turn's actions (status, sand, a possible Life Orb,
   * our contact punishers); null when unbounded (Toxic's counter is not tracked). */
  const residualMax = (threatMove: ReturnType<typeof dex.moves.get>): number | null => {
    const status = norm(them.status);
    if (status === "tox") return null;
    let chip = status === "brn" ? 6.25 : status === "psn" ? 12.5 : 0;
    if (/sand/i.test(snapshot.field.weather ?? "") && !(them.types ?? []).some((type) => ["Rock", "Ground", "Steel"].includes(type))) chip += 6.25;
    if (!them.item && !them.removedItem) chip += 10; // a possible Life Orb when it attacks
    if (threatMove.flags.contact) chip += (norm(you.item) === "rockyhelmet" ? 100 / 6 : 0) + (["roughskin", "ironbarbs"].includes(norm(you.ability)) ? 12.5 : 0);
    return chip;
  };
  for (const action of moves) {
    const move = dex.moves.get(action.moveName!);
    if (!move.exists || move.category !== "Status" || move.target !== "self") continue;
    const boosts = (move.boosts ?? {}) as Partial<Record<"atk" | "def" | "spa" | "spd" | "spe", number>>;
    const setup = Object.values(boosts).some((stage) => (stage ?? 0) > 0);
    const heal = Boolean(move.flags.heal) && Array.isArray(move.heal) && !/^(?:rest|synthesis|moonlight|morningsun|shoreup)$/.test(norm(move.name));
    if (!setup && !heal) continue;
    const candidates: Array<{ certain: boolean; message: string; short: string }> = [];
    for (const threat of threats) {
      if (!usable(threat) || threat.moveSource !== "known") continue;
      const hit = koAgainst(threat, action), threatMove = dex.moves.get(threat.moveName);
      if (!hit || !threatMove.exists || hit.ko) continue; // a first-hit KO is the pre-move guard's case
      if ((threatMove.category === "Physical" && (boosts.def ?? 0) > 0) || (threatMove.category === "Special" && (boosts.spd ?? 0) > 0)) continue;
      const healed = heal ? 100 * (move.heal as number[])[0]! / (move.heal as number[])[1]! : 0;
      // Upper bound on HP after this turn for either order (hit then heal, or capped heal then hit).
      const remaining = Math.min(100, hp! - hit.min + healed);
      if (hit.min - EPS < remaining) continue; // the same hit need not KO next turn
      // Next turn our cash-out is a priority-0 move: the opponent still acts first (no Speed boost from this setup).
      const stillSlower = threatMove.priority > 0 || (oppFirst && !((boosts.spe ?? 0) > 0));
      const pending = pendingMax(), residual = residualMax(threatMove);
      const target = pending === null || residual === null ? null : oppHp! - pending - residual;
      if (target !== null && target <= EPS) continue; // the opponent may already fall before next turn
      // Escape: a priority move above the threat's that could KO at the boosted stage (max band, linear in the stat).
      const escapes = moves.filter((other) => {
        const priority = actionPriority(you, other.moveName!);
        return priority !== null && priority > threatMove.priority && dex.moves.get(other.moveName!).category !== "Status" && !other.terastallize;
      }).map((other) => {
        const category = dex.moves.get(other.moveName!).category;
        const current = Math.max(0, (category === "Physical" ? you.boosts?.atk : you.boosts?.spa) ?? 0);
        const added = Math.max(0, (category === "Physical" ? boosts.atk : boosts.spa) ?? 0);
        return { name: other.moveName!, max: highest(damage.find((entry) => entry.actionId === other.id)?.bands) * (2 + Math.min(6, current + added)) / (2 + current) };
      });
      const escape = escapes.some((entry) => target === null || !Number.isFinite(entry.max) || entry.max + EPS >= target);
      if (escape && target !== null) continue; // a priority move can cash the boost out: not a dead end
      const certain = stillSlower && !escape && target !== null && sure(threat.moveName) && !ownOrderItem && !possiblyLockedElsewhere(threat) && !mayNotAct;
      if (!certain && !(stillSlower || (!youFirst && !((boosts.spe ?? 0) > 0)))) continue;
      const priorityText = !escapes.length ? "no priority move acts first"
        : `only ${escapes.map((entry) => entry.name).join("/")} acts first${target !== null && !escape ? ` and cannot KO (≤${pct(Math.max(...escapes.map((entry) => entry.max)))} vs ${pct(target)})` : ""}`;
      const caveat = certain ? "" : pending === null ? "; pending delayed damage is not quantified" : residual === null ? "; its residual damage is unknown" : stillSlower ? "" : "; Speed order is not certain";
      candidates.push({ certain, short: fitShort(`${action.label}: dead end vs ${threat.moveName}`, `Setup dead end vs ${threat.moveName}`, "Setup is a dead end"), message: `${action.label} is a dead end: ${threat.moveName} leaves ${youName} at ≤${pct(Math.max(0, remaining))} and KOs it next turn before it can use the boost; ${priorityText}${caveat}.` });
    }
    const chosen = candidates.find((candidate) => candidate.certain) ?? candidates[0];
    if (chosen) guards.push({ kind: "setup_dead_end", severity: chosen.certain ? "red" : "amber",
      actionIds: [action.id], message: chosen.message, short: chosen.short });
  }

  switchGuards();

  // Warnings only. A Choice lock needs a meaningful Choice share: this battle's posterior once it has battle evidence
  // (observed damage, order or item events can rule the items out), otherwise ladder usage. "Choice Band 1%… likely
  // locked" and a Specs warning after damage had ruled Specs out misled the player (a game review finding).
  if (choicePossible && stint.length === 1) {
    const entry = (intel.opponents ?? []).find((candidate) => candidate.instanceId === them.instanceId);
    const battleEvidence = entry?.posterior?.evidenceKinds?.some((kind) => ["damage", "speed", "inference"].includes(kind));
    const shares = new Map<string, number>();
    // The posterior's item marginals; its topHypotheses alone are a truncated view (they can read "Choice Scarf 100%"
    // after a single Moonblast).
    for (const [name, share] of battleEvidence ? (entry!.posterior!.itemShares?.map((item) => [item.name, item.share] as const)
      ?? entry!.posterior!.topHypotheses.map((h) => [h.item ?? "", h.weight] as const))
      : (entry?.likelyItems ?? []).map((item) => [item.name, item.share] as const)) if (CHOICE_ITEMS.includes(norm(name))) shares.set(name, (shares.get(name) ?? 0) + share);
    const total = [...shares.values()].reduce((sum, share) => sum + share, 0);
    if (choiceKnown || total >= MIN_CHOICE_SHARE) {
      const evidence = choiceKnown ? (scarfImplied ? "Choice Scarf implied by turn order" : `${them.item} revealed`) : [...shares].filter(([, share]) => share > 0).sort((a, b) => b[1] - a[1])
        .map(([name, share]) => `${name} ${sharePct(share)}`).join(", ") + (battleEvidence ? " given this battle" : " on the ladder");
      const top = [...shares].sort((a, b) => b[1] - a[1])[0];
      const shortWhy = choiceKnown ? shortItem(choiceItem!) : top ? `${shortItem(top[0])} ${sharePct(top[1])}` : "";
      // Repeats of the one move are posterior evidence: the line names them with the combined Choice share.
      const repeat = choiceKnown ? null : stintRepeat(snapshot, them);
      const repeated = repeat ? ` (${repeat.uses}× in a row)` : "";
      guards.push({ kind: "choice_lock", severity: "amber", actionIds: [],
        message: `${themName} has used only ${stint[0]}${repeated} since switching in; it ${choiceKnown ? "is" : "may be"} Choice-locked (${evidence}).`,
        short: repeat ? fitShort(`${themName} used ${repeat.move} ${repeat.uses}× in a row: Choice item ${sharePct(total)}`,
          `${themName} used ${repeat.move} ${repeat.uses}×: Choice item ${sharePct(total)}`, `${repeat.uses}× ${repeat.move}: Choice item ${sharePct(total)}`)
          : fitShort(`${themName} ${choiceKnown ? "is" : "may be"} locked into ${stint[0]} (${shortWhy})`, `${themName} ${choiceKnown ? "is" : "may be"} Choice-locked (${shortWhy})`,
          `${choiceKnown ? "Choice-locked" : "May be Choice-locked"} (${shortWhy})`) });
    }
  }
  for (const action of moves.filter((entry) => entry.terastallize && !you.terastallized)) {
    for (const threat of threats.filter(usable)) {
      const band = likely(threat.currentTarget.bands);
      if (!damaging(band)) continue;
      const after = teraScaled(band!, threat.moveName, you, action);
      if (!after) continue;
      const nowKo = band!.minPercent! - EPS >= hp!, nowSurvives = band!.maxPercent! + EPS < hp!;
      const text = nowKo && after.max + EPS < hp! ? `no longer KOs` : nowSurvives && after.min - EPS >= hp! ? `becomes a KO` : null;
      if (!text) continue;
      guards.push({ kind: "tera_survival", severity: "amber", actionIds: [action.id],
        message: `Tera ${you.teraType}: ${threat.moveName} ${text} (≈${range(after.min, after.max)} vs ${pct(hp!)} HP; now ${range(band!.minPercent!, band!.maxPercent!)}).`,
        short: fitShort(`Tera ${you.teraType}: ${threat.moveName} ${text}`, `Tera: ${threat.moveName} ${text}`, `Tera: ${text}`) });
    }
  }
  // A priority hit that can KO the active, on each stay-in action under its own Tera typing (it was a state-level line, so
  // it stood beside a Tera pick that resists it, e.g. Tera Fairy vs First Impression).
  for (const moveName of speed?.priorityMoves ?? []) {
    const threat = threats.find((entry) => norm(entry.moveName) === norm(moveName));
    const band = likely(threat?.currentTarget.bands);
    if (!threat || !usable(threat) || !damaging(band)) continue;
    const priority = dex.moves.get(threat.moveName).priority;
    const groups = new Map<string, { bounds: Bounds; ids: string[] }>();
    for (const action of moves) {
      const ours = actionPriority(you, action.moveName!), scaled = teraScaled(band!, threat.moveName, you, action);
      if (ours === null || ours >= priority || !scaled || scaled.max + EPS < hp! || failsInto(threat.moveName, action.moveName!) || fullHpShield(you)
        || preMove.get(action.id)?.threat === threat.moveName) continue;
      const key = `${scaled.min.toFixed(1)}|${scaled.max.toFixed(1)}`;
      const group = groups.get(key) ?? { bounds: scaled, ids: [] };
      group.ids.push(action.id); groups.set(key, group);
    }
    for (const { bounds, ids } of groups.values()) guards.push({ kind: "priority_caveat", severity: "amber", actionIds: ids,
      message: `${threat.moveSource === "known" ? "" : "Possible "}${threat.moveName} (priority) can KO ${youName} before it moves (${range(bounds.min, bounds.max)} vs ${pct(hp!)} HP).`,
      short: fitShort(`${threat.moveSource === "known" ? "" : "Possible "}${threat.moveName} (priority) can KO`, "Priority move can KO") });
  }

  // Last answer (warning only): the active is our only living Pokémon that answers a remaining opponent (the engine's
  // Speed and damage: outspeeds and KOs, or survives and KOs), and staying may lose it (e.g. an Arcanine locked into
  // Cobalion's Body Press while it is the last Serperior answer). Warning only; the pick is never changed.
  const lockedMove = CHOICE_ITEMS.includes(norm(you.item)) && you.appearanceMoves?.length === 1 ? you.appearanceMoves[0]!
    : CHOICE_ITEMS.includes(norm(you.item)) && new Set(moves.map((action) => norm(action.moveName))).size === 1 && moves.length < snapshot.legalActions.filter((action) => action.kind === "move").length
      ? moves[0]?.moveName ?? null : null;
  const themTypes = them.types?.length ? them.types : [...dex.species.get(them.species ?? "").types];
  const teraOpen = !them.terastallized && !teraUsedByOpponent;
  /** Ladder-common Tera types (still available to the opponent) that cut this move's type effectiveness, with it. */
  const bluntingTeras = (action: LegalAction) => {
    const moveType = effectiveMoveType(you, action), now = moveType ? typeMultiplier(moveType, themTypes) : null;
    if (!teraOpen || !moveType || !now) return { now, teras: [] as Array<{ name: string; share: number; after: number }> };
    const teras = (themEntry?.likelyTeraTypes ?? []).filter((entry) => entry.share >= MIN_TERA_SHARE && norm(entry.name) !== "stellar")
      .map((entry) => ({ name: entry.name, share: entry.share, after: typeMultiplier(moveType, [entry.name]) ?? now })).filter((entry) => entry.after < now)
      .sort((a, b) => b.share - a.share);
    return { now, teras };
  };
  // A plain KO is no risk to the role: it acts first and KOs at the likely minimum, unless ladder-common Teras (together
  // ≥ MIN_BLUNT_SHARE) blunt it below a KO. A 459-Speed Head Smash that surely KOs is no "last answer" risk.
  const locked = (action: LegalAction) => Boolean(lockedMove && norm(action.moveName) === norm(lockedMove));
  const koFirst = (action: LegalAction) => {
    const band = likely(damage.find((entry) => entry.actionId === action.id)?.bands);
    if (!youFirst || !damaging(band) || band!.minPercent! - EPS < oppHp!) return false;
    const { now, teras } = bluntingTeras(action);
    const saving = teras.filter((entry) => band!.minPercent! * entry.after / now! - EPS < oppHp!);
    return saving.reduce((sum, entry) => sum + entry.share, 0) < MIN_BLUNT_SHARE;
  };
  // A stay risks the active when it does not surely KO first and a considered hit (the likely band) can KO it from here:
  // in one hit, or in two when it is Choice-locked into this move and must repeat it. A Body Press doing 78–92% into a
  // locked Arcanine is the two-hit case; a free Arcanine 2HKO'd by Foul Play is not.
  const strongestHit = (action: LegalAction) => {
    let best: { move: string; bounds: Bounds } | null = null;
    for (const threat of threats) {
      if (!usable(threat)) continue;
      const band = likely(threat.currentTarget.bands);
      const scaled = damaging(band) ? teraScaled(band!, threat.moveName, you, action) : null;
      if (scaled && (!best || scaled.max > best.bounds.max)) best = { move: threat.moveName, bounds: scaled };
    }
    return best;
  };
  // Forced positions are no choice of role: with no switch-in that survives entry (e.g. the last Pokémon), there is
  // nothing to preserve it for.
  const switchAlternative = enabled.some((action) => action.kind === "switch" && !guards.some((guard) => guard.kind === "switch_into_ko" && guard.actionIds.includes(action.id)));
  const risky = !switchAlternative ? [] : moves.filter((action) => {
    const hit = strongestHit(action);
    return !koFirst(action) && hit && (locked(action) ? 2 : 1) * hit.bounds.max + EPS >= hp!;
  });
  if (risky.length) {
    const bench = snapshot.yourSide.team.filter((mon) => !mon.active && !mon.fainted && (mon.hpPercent ?? 0) > 0);
    const sole: Array<{ name: string; answer: OwnAnswer }> = [];
    for (const opponent of snapshot.opponentSide.team) {
      if (opponent.fainted || !((opponent.hpPercent ?? 0) > 0) || (opponent.identityStatus && opponent.identityStatus !== "resolved")) continue;
      const mine = ownAnswerTo(snapshot, intel, you, opponent);
      if (mine && !bench.some((mon) => ownAnswerTo(snapshot, intel, mon, opponent))) sole.push({ name: name(opponent), answer: mine });
    }
    if (sole.length) {
      const fast = sole.every((entry) => entry.answer.kind === "outspeeds_ko") ? "fast " : "";
      const names = sole.map((entry) => entry.name);
      const how = sole.map(({ name: target, answer }) => answer.kind === "outspeeds_ko"
        ? `outspeeds ${target} (${answer.yourSpeed} vs ≤${answer.theirMaxSpeed}) and KOs it (${answer.move} ${range(answer.ko.min, answer.ko.max)})`
        : `survives ${target}'s considered hits and KOs it (${answer.move} ${range(answer.ko.min, answer.ko.max)})`).join("; ");
      const hit = strongestHit(risky[0]!)!;
      guards.push({ kind: "last_answer", severity: "amber", actionIds: risky.map((action) => action.id),
        message: `${youName} is your last healthy Pokémon that ${how}. Staying in risks it: it does not surely KO first, and ${hit.move} (up to ${pct(hit.bounds.max)} vs ${pct(hp!)} HP) can KO it ${locked(risky[0]!) ? "within two hits while it is Choice-locked" : "in one hit"}.`,
        short: fitShort(`Last ${fast}answer to ${names.join(", ")}`, ...(names.length > 1 ? [`Last ${fast}answer to ${names[0]} +${names.length - 1}`] : []),
          `Last ${fast}answer to ${names.length > 1 ? `${names.length} foes` : names[0]}`) });
    }
  }

  // Locked move vs a defensive Tera (warning only): our Choice lock repeats one move, the opponent can still
  // Terastallize, and a ladder-common Tera type resists or blocks that move (e.g. Tera Water Cobalion).
  if (lockedMove) {
    for (const action of moves.filter((entry) => norm(entry.moveName) === norm(lockedMove))) {
      const { now, teras } = bluntingTeras(action);
      const resisting = teras.filter((entry) => entry.after < 1);
      if (!now || now < 1 || !resisting.length) continue;
      const list = resisting.map((entry) => `${entry.name} ${sharePct(entry.share)}`);
      const verb = resisting.every((entry) => entry.after === 0) ? "block it" : "resist";
      guards.push({ kind: "tera_resist", severity: "amber", actionIds: [action.id],
        message: `${youName} is locked into ${lockedMove}; ${themName} has not Terastallized and ladder Tera ${resisting.map((entry) =>
          `${entry.name} (${sharePct(entry.share)}, ${entry.after === 0 ? "immune" : "resists"})`).join(", ")} would blunt it (now ×${now}).`,
        short: fitShort(`${themName} may Tera to ${verb} (${list.join(", ")})`, `${themName} may Tera to ${verb} (${list[0]})`, `May Tera to ${verb} (${list[0]})`) });
    }
  }

  // No safe option: every legal action carries a KO fact or risk for the Pokémon it puts in front of the reply (a stay-in
  // KO'd before or after it acts, a switch-in KO'd on entry). A fact about the position, not advice: with
  // Arcanine last and locked into Head Smash, First Impression can KO whatever is chosen.
  const LOSING: readonly GuardKind[] = ["pre_move_ko", "retaliation_ko", "priority_caveat", "switch_into_ko"];
  const losing = (action: LegalAction) => guards.filter((guard) => LOSING.includes(guard.kind) && guard.actionIds.includes(action.id));
  if (enabled.length && enabled.every((action) => losing(action).length)) {
    const certain = enabled.every((action) => losing(action).some((guard) => guard.severity === "red"));
    guards.push({ kind: "no_safe_option", severity: certain ? "red" : "amber", actionIds: enabled.map((action) => action.id),
      message: `No legal action is safe: ${enabled.length === 1 ? `the only one ${certain ? "loses" : "risks"}` : `all ${enabled.length} ${certain ? "lose" : "risk"}`} a Pokémon to a KO (${[...new Set(enabled.flatMap((action) => losing(action).map((guard) => guard.short)))].join("; ")}).`,
      short: certain ? "No safe option: every action loses a Pokémon" : "No safe option: every action risks a KO" });
  }
  return report();
}


const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const hpPercentOf = (condition: string | undefined) => {
  const match = String(condition ?? "").match(/^(\d+)\/(\d+)/);
  return match ? 100 * Number(match[1]) / Number(match[2]) : /^0(?: fnt)?$/.test(String(condition ?? "")) ? 0 : null;
};
/** Our exact maximum HP from the request's condition, else null. */
const maxHpOf = (mon: PokemonSnapshot) => { const max = Number(String(mon.conditionText ?? "").match(/^\d+\/(\d+)/)?.[1]); return Number.isFinite(max) && max > 0 ? max : null; };
/** The opponent's smallest plausible maximum HP (0 EVs, 31 IVs): the smallest recoil a hit on it can cause. */
function minMaxHp(mon: PokemonSnapshot) {
  const species = dex.species.get(mon.species ?? ""), level = mon.level ?? 100;
  if (!species.exists) return null;
  return species.baseStats.hp === 1 ? 1 : Math.floor((2 * species.baseStats.hp + 31) * level / 100) + level + 10;
}
const stage = (value: number) => { const clamped = Math.max(-6, Math.min(6, value)); return clamped >= 0 ? (2 + clamped) / 2 : 2 / (2 - clamped); };
type StatBoosts = Partial<Record<"atk" | "def" | "spa" | "spd" | "spe", number>>;
const STAT_SHORT: Record<string, string> = { atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" };
/** What our own move does to us before the reply: its self stat changes (Contrary inverts them) and its recoil and Life
 * Orb as % of our HP (the smallest recoil: least damage dealt, smallest opponent HP). */
function selfEffects(you: PokemonSnapshot, move: ReturnType<typeof dex.moves.get>, dealtPercent: number, ownMaxHp: number | null, oppMaxHp: number | null) {
  const sign = norm(you.ability) === "contrary" ? -1 : 1, boosts: StatBoosts = {};
  for (const source of [move.self?.boosts, move.selfBoost?.boosts]) for (const [stat, value] of Object.entries(source ?? {})) {
    if (stat in STAT_SHORT) boosts[stat as keyof StatBoosts] = (boosts[stat as keyof StatBoosts] ?? 0) + sign * (value as number);
  }
  const ability = norm(you.ability), magicGuard = ability === "magicguard";
  let hpLoss = 0;
  if (!magicGuard && ownMaxHp && oppMaxHp && Array.isArray(move.recoil) && ability !== "rockhead") hpLoss += dealtPercent / 100 * oppMaxHp * move.recoil[0] / move.recoil[1] / ownMaxHp * 100;
  if (!magicGuard && move.mindBlownRecoil) hpLoss += 50;
  if (!magicGuard && norm(you.item) === "lifeorb") hpLoss += 10;
  const drops = Object.entries(boosts).filter(([, value]) => value).map(([stat, value]) => `${value! > 0 ? "+" : "−"}${Math.abs(value!)} ${STAT_SHORT[stat]}`);
  const label = [...drops, hpLoss ? `${pct(hpLoss)} recoil` : ""].filter(Boolean).join(", ");
  return { boosts, hpLoss, label, short: drops.join(" ") || (hpLoss ? "recoil" : "") };
}
/** How a reply's damage scales with our stat-stage changes: our defending stat (Psyshock reads Defense), and our attacking
 * stat for Foul Play-style moves; an Unaware attacker ignores our defensive stages. */
function stageFactor(you: PokemonSnapshot, them: PokemonSnapshot, threat: ReturnType<typeof dex.moves.get>, delta: StatBoosts) {
  const now = (stat: keyof StatBoosts) => you.boosts?.[stat] ?? 0;
  let factor = 1;
  const defStat = (threat.overrideDefensiveStat ?? (threat.category === "Physical" ? "def" : "spd")) as keyof StatBoosts;
  if (delta[defStat] && norm(them.ability) !== "unaware") factor *= stage(now(defStat)) / stage(now(defStat) + delta[defStat]!);
  if (threat.overrideOffensivePokemon === "target") {
    const atkStat = (threat.overrideOffensiveStat ?? (threat.category === "Physical" ? "atk" : "spa")) as keyof StatBoosts;
    if (delta[atkStat]) factor *= stage(now(atkStat) + delta[atkStat]!) / stage(now(atkStat));
  }
  return factor;
}

const ATE: Record<string, string> = { pixilate: "Fairy", aerilate: "Flying", refrigerate: "Ice", galvanize: "Electric" };
/** The attacking type of our move after Tera Blast and the -ate abilities; null when the move is unknown. */
function effectiveMoveType(active: PokemonSnapshot, action: LegalAction) {
  const move = dex.moves.get(action.moveName ?? "");
  if (!move.exists) return null;
  if (norm(move.name) === "terablast" && (active.terastallized || action.terastallize) && active.teraType && norm(active.teraType) !== "stellar") return active.teraType;
  if (norm(active.ability) === "normalize") return "Normal";
  return move.type === "Normal" && ATE[norm(active.ability)] ? ATE[norm(active.ability)]! : move.type;
}
