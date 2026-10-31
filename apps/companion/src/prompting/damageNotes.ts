import { Dex } from "@pkmn/dex";
import { Generations as DataGenerations } from "@pkmn/data";
import { calculate, Field, Generations as CalcGenerations, Move, Side } from "@smogon/calc";
import { BattlePokemon as Pokemon, applyAbilityState, calculateDamageScenarios, exactSnapshotHp, assessImmediateDamage } from "../mechanics/calcPokemon.js";

import type {
  BattleSnapshot,
  DamageAssumptionBand,
  LadderAttackProfile,
  DamagePreview,
  DelayedDamagePreview,
  InteractionHint,
  ImmediateDamageAssessment,
  OpponentPosteriorPreview,
  ObservedRangeSummary,
  PokemonSnapshot,
  PosteriorHypothesis,
  SurvivalCaveat,
  ThreatPreview,
  ThreatTargetPreview
} from "../types.js";
import { filterLiveLikelyHeldItemNames } from "../mechanics/liveLikelyItems.js";
import { projectSwitchEntry, withholdEntryDamage } from "../mechanics/switchEntry.js";
import { snapshotForAction } from "../mechanics/actions.js";

const calcGens = CalcGenerations;
const dataGens = new DataGenerations(Dex as any);

type DamageOptions = {
  likelyDefenderItems?: string[] | undefined;
  likelyDefenderAbilities?: string[] | undefined;
  likelyAttackerItems?: string[] | undefined;
  likelyAttackerAbilities?: string[] | undefined;
  /** The ladder's modal attacking spread per category and its live-plausible modal item, for the opponent's "likely" band. */
  likelyAttackerProfile?: LadderAttackProfile | undefined;
  observedPlayerDamage?: Record<string, ObservedRangeSummary> | undefined;
  observedPlayerDamageResolver?: ((moveName: string, attacker: PokemonSnapshot, defender: PokemonSnapshot) => ObservedRangeSummary | undefined) | undefined;
  attackerPosterior?: OpponentPosteriorPreview | undefined;
  defenderPosterior?: OpponentPosteriorPreview | undefined;
};

type DamageProfile = "low" | "likely" | "high";

type Range = {
  min: number;
  max: number;
  exactMin?: number;
  exactMax?: number;
};

type StatusOutcome = Pick<DamageAssumptionBand, "label" | "outcome" | "detail">;

/** Abilities that make a move of this type do nothing (no damage). */
export const MOVE_TYPE_IMMUNITY_ABILITY_LABELS: Record<string, string[]> = {
  ground: ["Levitate", "Earth Eater"],
  fire: ["Flash Fire", "Well-Baked Body"],
  water: ["Water Absorb", "Dry Skin", "Storm Drain"],
  electric: ["Volt Absorb", "Lightning Rod", "Motor Drive"],
  grass: ["Sap Sipper"]
};

const MOVE_TYPE_IMMUNITY_ITEM_LABELS: Record<string, string[]> = {
  ground: ["Air Balloon"]
};

const STATUS_IMMUNITY_ABILITY_LABELS: Record<string, string[]> = {
  par: ["Limber"],
  brn: ["Water Veil", "Water Bubble"],
  slp: ["Insomnia", "Vital Spirit", "Sweet Veil"],
  psn: ["Immunity", "Pastel Veil"],
  tox: ["Immunity", "Pastel Veil"]
};
function generationFromFormat(format: string): number {
  const match = String(format ?? "").match(/\[Gen\s*(\d+)\]/i);
  const parsed = Number.parseInt(match?.[1] ?? "9", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 9;
}

function inferredBattleLevel(format: string) {
  const normalized = String(format ?? "").toLowerCase();
  if (/(^|[^a-z])(lc|little cup)([^a-z]|$)/i.test(normalized)) {
    return 5;
  }
  if (/battle stadium|bss|vgc|regulation/i.test(normalized)) {
    return 50;
  }
  return 100;
}

function normalizedBattleLevel(format: string, level: number | null | undefined) {
  const inferred = inferredBattleLevel(format);
  const parsed = Number(level);
  if (!Number.isFinite(parsed) || parsed <= 0) return inferred;
  if (inferred > 5 && parsed <= 5) return inferred;
  return parsed;
}

function calcGen(genNum: number) {
  return calcGens.get(genNum as Parameters<typeof calcGens.get>[0]);
}

function dataGen(genNum: number) {
  return dataGens.get(genNum as Parameters<typeof dataGens.get>[0]);
}

function normalizeEffectLabel(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized && normalized !== "fnt" ? normalized : undefined;
}

function clampBoostStage(value: number | null | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-6, Math.min(6, Number(value)));
}

function calcBoosts(boosts: Record<string, number> | undefined) {
  return {
    atk: clampBoostStage(boosts?.atk),
    def: clampBoostStage(boosts?.def),
    spa: clampBoostStage(boosts?.spa),
    spd: clampBoostStage(boosts?.spd),
    spe: clampBoostStage(boosts?.spe)
  };
}

function mapWeather(weather: string | null | undefined) {
  const normalized = normalizeEffectLabel(weather);
  if (!normalized) return undefined;
  if (normalized.includes("sun")) return "Sun";
  if (normalized.includes("rain")) return "Rain";
  if (normalized.includes("sand")) return "Sand";
  if (normalized.includes("snow")) return "Snow";
  if (normalized.includes("hail")) return "Hail";
  return undefined;
}

function mapTerrain(terrain: string | null | undefined) {
  const normalized = normalizeEffectLabel(terrain);
  if (!normalized) return undefined;
  if (normalized.includes("electric")) return "Electric";
  if (normalized.includes("grassy")) return "Grassy";
  if (normalized.includes("misty")) return "Misty";
  if (normalized.includes("psychic")) return "Psychic";
  return undefined;
}

function sideFromConditions(conditions: string[]) {
  const normalized = conditions.map((value) => normalizeEffectLabel(value));
  const side: Record<string, unknown> = {};
  const spikes = normalized.filter((value) => value === "spikes").length;
  if (spikes > 0) side.spikes = spikes;
  if (normalized.includes("stealth rock")) side.isSR = true;
  if (normalized.includes("reflect")) side.isReflect = true;
  if (normalized.includes("light screen")) side.isLightScreen = true;
  if (normalized.includes("aurora veil")) side.isAuroraVeil = true;
  if (normalized.includes("tailwind")) side.isTailwind = true;
  return new Side(side as ConstructorParameters<typeof Side>[0]);
}

function buildField(snapshot: BattleSnapshot, attackerSide: "your" | "opponent") {
  const yourSide = sideFromConditions(snapshot.field.yourSideConditions);
  const opponentSide = sideFromConditions(snapshot.field.opponentSideConditions);
  const field: Record<string, unknown> = {
    gameType: "Singles",
    attackerSide: attackerSide === "your" ? yourSide : opponentSide,
    defenderSide: attackerSide === "your" ? opponentSide : yourSide
  };
  const weather = mapWeather(snapshot.field.weather);
  const terrain = mapTerrain(snapshot.field.terrain);
  if (weather) field.weather = weather;
  if (terrain) field.terrain = terrain;
  if (snapshot.field.pseudoWeather.some((value) => /gravity/i.test(value))) field.isGravity = true;
  return new Field(field as ConstructorParameters<typeof Field>[0]);
}

function applyKnownStats(pokemon: Pokemon, snapshotMon: PokemonSnapshot) {
  const stats = snapshotMon.stats ?? {};
  for (const stat of ["hp", "atk", "def", "spa", "spd", "spe"] as const) {
    if (!Number.isFinite(stats[stat])) continue;
    pokemon.rawStats[stat] = Number(stats[stat]);
    pokemon.stats[stat] = Number(stats[stat]);
  }
  if (Number.isFinite(stats.hp) && Number.isFinite(snapshotMon.hpPercent)) {
    const currentHp = exactSnapshotHp(snapshotMon, Number(stats.hp)) ?? Math.max(1, Math.floor((Number(stats.hp) * Number(snapshotMon.hpPercent)) / 100));
    pokemon.originalCurHP = Math.min(currentHp, pokemon.rawStats.hp);
  }
}

function relevantStat(category: "Physical" | "Special") {
  return category === "Physical" ? "atk" : "spa";
}

function relevantDefenseStat(category: "Physical" | "Special") {
  return category === "Physical" ? "def" : "spd";
}

function offensiveProfile(profile: DamageProfile, category: "Physical" | "Special") {
  const stat = relevantStat(category);
  if (profile === "low") {
    return { evs: { [stat]: 0 }, nature: "Serious" };
  }
  if (profile === "likely") {
    return { evs: { [stat]: 128 }, nature: "Serious" };
  }
  return {
    evs: { [stat]: 252 },
    nature: category === "Physical" ? "Adamant" : "Modest"
  };
}

function defensiveProfile(profile: DamageProfile, category: "Physical" | "Special") {
  const stat = relevantDefenseStat(category);
  if (profile === "high") {
    return { evs: { hp: 0, [stat]: 0 }, nature: "Serious" };
  }
  if (profile === "likely") {
    return { evs: { hp: 252, [stat]: 128 }, nature: "Serious" };
  }
  return {
    evs: { hp: 252, [stat]: 252 },
    nature: category === "Physical" ? "Impish" : "Careful"
  };
}

function createPokemonFromSnapshot(
  format: string,
  genNum: number,
  snapshotMon: PokemonSnapshot,
  options: {
    profile: DamageProfile;
    role: "attacker" | "defender";
    category: "Physical" | "Special";
    likelyItem?: string | undefined;
    likelyAbility?: string | undefined;
    posteriorHypothesis?: PosteriorHypothesis | undefined;
    useSnapshotStats?: boolean | undefined;
    /** Replaces the generic "likely" attacking profile (the ladder's modal spread). */
    attackProfile?: { nature: string; evs: Record<string, number> } | undefined;
  }
) {
  const species = snapshotMon.species ?? snapshotMon.displayName;
  if (!species) return null;
  const knownStatus = normalizeStatus(snapshotMon.status);
  const posterior = options.posteriorHypothesis;
  const profileOptions = posterior
    ? { evs: posterior.evs, nature: posterior.nature }
    : options.role === "attacker"
      ? (options.profile === "likely" && options.attackProfile ? options.attackProfile : offensiveProfile(options.profile, options.category))
      : defensiveProfile(options.profile, options.category);
  const config: Record<string, unknown> = {
    level: normalizedBattleLevel(format, snapshotMon.level),
    ability: "No Ability",
    boosts: calcBoosts(snapshotMon.boosts),
    ...profileOptions
  };

  const ability = snapshotMon.ability ?? posterior?.ability ?? options.likelyAbility;
  const item = snapshotMon.item
    ?? (!snapshotMon.removedItem ? (posterior?.item ?? options.likelyItem) : undefined);
  if (ability) config.ability = ability;
  if (item) config.item = item;
  if (knownStatus) config.status = knownStatus;
  if (snapshotMon.terastallized && snapshotMon.teraType) config.teraType = snapshotMon.teraType;
  if (options.role === "attacker" && snapshotMon.knownMoves.length > 0) {
    config.moves = snapshotMon.knownMoves;
  }

  const pokemon = new Pokemon(calcGen(genNum), species, config as ConstructorParameters<typeof Pokemon>[2]);
  if (options.useSnapshotStats !== false) {
    applyKnownStats(pokemon, snapshotMon);
  }
  applyAbilityState(pokemon, snapshotMon);
  if (options.role === "defender" && (options.useSnapshotStats === false || !snapshotMon.stats?.hp) && Number.isFinite(snapshotMon.hpPercent)) {
    pokemon.originalCurHP = Math.max(1, Math.floor((pokemon.rawStats.hp * Number(snapshotMon.hpPercent)) / 100));
  }
  return pokemon;
}

function lookupSpecies(gen: ReturnType<typeof dataGen>, name: string | null | undefined) {
  if (!name) return undefined;
  const direct = gen.species.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const species of gen.species) {
    if (normalizeName(species.name) === normalized) return species;
  }
  return undefined;
}

/** A species whose dex lists one ability has it before any reveal (Mimikyu's Disguise, Thundurus-T's Volt Absorb,
 * Volcanion's Water Absorb). An unresolved identity (a possible Illusion) assumes nothing. A usable posterior already
 * enumerates the species' abilities per hypothesis, so this fills only the profile (non-posterior) path. */
function withSoleAbility(genNum: number, mon: PokemonSnapshot): PokemonSnapshot {
  if (mon.ability || (mon.identityStatus !== undefined && mon.identityStatus !== "resolved")) return mon;
  const abilities = [...new Set(Object.values(lookupSpecies(dataGen(genNum), mon.species ?? mon.displayName)?.abilities ?? {}))];
  return abilities.length === 1 ? { ...mon, ability: abilities[0]! } : mon;
}

/** Knock Off's 1.5x needs a held item: an unrevealed one is assumed held (its likely item, else any) unless one was removed. */
function knockOffHeldItem(moveName: string, defender: PokemonSnapshot, likelyItems: readonly string[]) {
  if (normalizeName(moveName) !== "knockoff" || defender.item || defender.removedItem) return undefined;
  return likelyItems[0] ?? "Leftovers";
}

function lookupMoveData(gen: ReturnType<typeof dataGen>, name: string | null | undefined) {
  if (!name) return undefined;
  const direct = gen.moves.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const move of gen.moves) {
    if (normalizeName(move.name) === normalized) return move;
  }
  return undefined;
}

function currentBattleTypes(gen: ReturnType<typeof dataGen>, pokemon: PokemonSnapshot | null | undefined) {
  if (!pokemon) return [];
  if (pokemon.terastallized && pokemon.teraType && pokemon.teraType !== "Stellar") {
    return [pokemon.teraType];
  }
  if (Array.isArray(pokemon.types) && pokemon.types.length > 0) {
    return pokemon.types;
  }
  return lookupSpecies(gen, pokemon.species ?? pokemon.displayName)?.types ?? [];
}

function moveTargetsSpecificFoe(move: ReturnType<typeof lookupMoveData>) {
  const target = String(move?.target ?? "");
  return !["self", "allySide", "allyTeam", "foeSide", "all", "allAdjacent", "scripted", "adjacentAlly", "allyAlly"].includes(target);
}

function attackerIgnoresDefenderAbility(attacker: PokemonSnapshot | null | undefined) {
  const ability = normalizeName(attacker?.ability);
  return ability === "moldbreaker" || ability === "teravolt" || ability === "turboblaze";
}

function makeStatusBand(outcome: StatusOutcome): DamageAssumptionBand {
  return {
    label: outcome.label,
    minPercent: null,
    maxPercent: null,
    immediate: { ko: "no_ko", minHpLossPercent: 0, maxHpLossPercent: 0 },
    outcome: outcome.outcome,
    detail: outcome.detail
  };
}

function makeDamagingImmunityBand(outcome: StatusOutcome): DamageAssumptionBand {
  return {
    label: outcome.label,
    minPercent: 0,
    maxPercent: 0,
    immediate: { ko: "no_ko", minHpLossPercent: 0, maxHpLossPercent: 0 },
    outcome: outcome.outcome,
    detail: outcome.detail
  };
}

function moveTypeImmunityAbilityOutcome(moveType: string | undefined, defenderAbility: string | null | undefined): StatusOutcome | null {
  const abilityId = normalizeName(defenderAbility);
  const moveTypeId = normalizeName(moveType);
  if (!abilityId || !moveTypeId) return null;

  if (["levitate", "eartheater"].includes(abilityId) && moveTypeId === "ground") {
    return { label: "immune", outcome: "immune", detail: `${defenderAbility} blocks Ground-type moves.` };
  }
  if (["flashfire", "wellbakedbody"].includes(abilityId) && moveTypeId === "fire") {
    return { label: "immune", outcome: "immune", detail: `${defenderAbility} blocks Fire-type moves.` };
  }
  if (["waterabsorb", "dryskin", "stormdrain"].includes(abilityId) && moveTypeId === "water") {
    return { label: "immune", outcome: "immune", detail: `${defenderAbility} blocks Water-type moves.` };
  }
  if (["voltabsorb", "lightningrod", "motordrive"].includes(abilityId) && moveTypeId === "electric") {
    return { label: "immune", outcome: "immune", detail: `${defenderAbility} blocks Electric-type moves.` };
  }
  if (abilityId === "sapsipper" && moveTypeId === "grass") {
    return { label: "immune", outcome: "immune", detail: "Sap Sipper blocks Grass-type moves." };
  }
  return null;
}

function airBalloonBlocksMove(move: ReturnType<typeof lookupMoveData>) {
  if (!move) return false;
  return normalizeName(move.type) === "ground" && normalizeName(move.name) !== "thousandarrows";
}

function targetedTypeImmunityOutcome(
  gen: ReturnType<typeof dataGen>,
  move: ReturnType<typeof lookupMoveData>,
  defenderTypes: string[]
): StatusOutcome | null {
  if (!moveTargetsSpecificFoe(move)) return null;
  if (move?.ignoreImmunity === true) return null;
  if (!move?.type || defenderTypes.length === 0) return null;
  const total = gen.types.totalEffectiveness(move.type as any, defenderTypes as any);
  if (total !== 0) return null;
  const immuneType = defenderTypes.find((type) => gen.types.totalEffectiveness(move.type as any, [type] as any) === 0);
  return {
    label: "immune",
    outcome: "immune",
    detail: immuneType ? `${immuneType}-type is immune to ${move.type}-type moves.` : `Current typing is immune to ${move.type}-type moves.`
  };
}

function statusTypeImmunityOutcome(
  genNum: number,
  move: ReturnType<typeof lookupMoveData>,
  attacker: PokemonSnapshot,
  defenderTypes: string[]
): StatusOutcome | null {
  const status = move?.status;
  const attackerAbility = normalizeName(attacker.ability);

  if ((status === "psn" || status === "tox") && attackerAbility !== "corrosion") {
    if (defenderTypes.includes("Steel")) {
      return { label: "immune", outcome: "immune", detail: "Steel-type is immune to poison unless the attacker has Corrosion." };
    }
    if (defenderTypes.includes("Poison")) {
      return { label: "immune", outcome: "immune", detail: "Poison-type is immune to poison unless the attacker has Corrosion." };
    }
  }
  if (status === "brn" && defenderTypes.includes("Fire")) {
    return { label: "immune", outcome: "immune", detail: "Fire-type is immune to burn." };
  }
  if (status === "par" && genNum >= 6 && defenderTypes.includes("Electric")) {
    return { label: "immune", outcome: "immune", detail: "Electric-type is immune to paralysis in this generation." };
  }
  if (status === "frz" && defenderTypes.includes("Ice")) {
    return { label: "immune", outcome: "immune", detail: "Ice-type is immune to freeze." };
  }
  return null;
}

function specialStatusInteractionOutcome(
  genNum: number,
  move: ReturnType<typeof lookupMoveData>,
  snapshot: BattleSnapshot,
  attacker: PokemonSnapshot,
  defender: PokemonSnapshot,
  defenderTypes: string[]
): StatusOutcome | null {
  if (!moveTargetsSpecificFoe(move)) return null;

  const moveId = normalizeName(move?.name);
  const defenderAbilityId = normalizeName(defender.ability);
  const attackerAbilityId = normalizeName(attacker.ability);

  if (moveId === "leechseed" && defenderTypes.includes("Grass")) {
    return { label: "immune", outcome: "immune", detail: "Grass-type blocks Leech Seed." };
  }
  if (move?.flags?.powder && defenderTypes.includes("Grass")) {
    return { label: "immune", outcome: "immune", detail: "Grass-type is immune to powder moves." };
  }
  if (genNum >= 7 && attackerAbilityId === "prankster" && defenderTypes.includes("Dark")) {
    return { label: "blocked", outcome: "blocked", detail: "Dark-type blocks opposing Prankster-boosted status moves." };
  }
  if (defenderAbilityId === "purifyingsalt" && (Boolean(move?.status) || moveId === "yawn")) {
    return { label: "immune", outcome: "immune", detail: "Purifying Salt prevents status conditions and Yawn." };
  }
  if (defenderAbilityId === "goodasgold" && move?.category === "Status") {
    return { label: "blocked", outcome: "blocked", detail: "Good as Gold blocks opposing status moves." };
  }
  if (defenderAbilityId === "limber" && move?.status === "par") {
    return { label: "immune", outcome: "immune", detail: "Limber prevents paralysis." };
  }
  if (["waterveil", "waterbubble"].includes(defenderAbilityId) && move?.status === "brn") {
    return { label: "immune", outcome: "immune", detail: `${defender.ability} prevents burn.` };
  }
  if (["insomnia", "vitalspirit", "sweetveil"].includes(defenderAbilityId) && move?.status === "slp") {
    return { label: "immune", outcome: "immune", detail: `${defender.ability} prevents sleep.` };
  }
  if (defenderAbilityId === "comatose" && move?.status) {
    return { label: "immune", outcome: "immune", detail: "Comatose prevents other non-volatile status conditions." };
  }
  if (defenderAbilityId === "leafguard" && move?.status && /sun/i.test(snapshot.field.weather ?? "")) {
    return { label: "immune", outcome: "immune", detail: "Leaf Guard prevents status in sun." };
  }
  return null;
}

function buildStatusOutcomeBand(params: {
  genNum: number;
  snapshot: BattleSnapshot;
  attackerMon: PokemonSnapshot;
  defenderMon: PokemonSnapshot;
  moveName: string;
}) {
  const gen = dataGen(params.genNum);
  const move = lookupMoveData(gen, params.moveName);
  if (!move) {
    return makeStatusBand({ label: "status", outcome: "status", detail: "non-damaging status move" });
  }
  if (!moveTargetsSpecificFoe(move)) {
    return makeStatusBand({
      label: "status",
      outcome: "status",
      detail: move.target === "self" ? "self-targeting setup move" : "non-damaging status move"
    });
  }

  const defenderTypes = currentBattleTypes(gen, params.defenderMon);
  if (!attackerIgnoresDefenderAbility(params.attackerMon)) {
    const abilityOutcome = moveTypeImmunityAbilityOutcome(move.type, params.defenderMon.ability);
    if (abilityOutcome) return makeStatusBand(abilityOutcome);
  }

  const typeOutcome = targetedTypeImmunityOutcome(gen, move, defenderTypes);
  if (typeOutcome) return makeStatusBand(typeOutcome);

  const statusTypeOutcome = statusTypeImmunityOutcome(params.genNum, move, params.attackerMon, defenderTypes);
  if (statusTypeOutcome) return makeStatusBand(statusTypeOutcome);

  if (move?.status && params.defenderMon.status && params.defenderMon.status !== "fnt") {
    return makeStatusBand({
      label: "blocked",
      outcome: "blocked",
      detail: `${params.defenderMon.displayName ?? params.defenderMon.species ?? "Target"} already has a non-volatile status.`
    });
  }

  if (!attackerIgnoresDefenderAbility(params.attackerMon)) {
    const specialOutcome = specialStatusInteractionOutcome(
      params.genNum,
      move,
      params.snapshot,
      params.attackerMon,
      params.defenderMon,
      defenderTypes
    );
    if (specialOutcome) return makeStatusBand(specialOutcome);
  }

  return makeStatusBand({ label: "status", outcome: "status", detail: "non-damaging status move" });
}

function dedupeInteractionHints(hints: InteractionHint[]) {
  const seen = new Set<string>();
  return hints.filter((hint) => {
    const key = `${hint.certainty}|${hint.label}|${hint.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildPossibleAbilityInteractionHints(params: {
  genNum: number;
  snapshot: BattleSnapshot;
  attackerMon: PokemonSnapshot;
  defenderMon: PokemonSnapshot;
  moveName: string;
  likelyDefenderItems?: string[] | undefined;
  likelyDefenderAbilities?: string[] | undefined;
}): InteractionHint[] {
  const gen = dataGen(params.genNum);
  const move = lookupMoveData(gen, params.moveName);
  if (!move) return [];

  const likelyAbilities = [...new Set((params.likelyDefenderAbilities ?? []).filter(Boolean))];
  const likelyItems = [...new Set((params.likelyDefenderItems ?? []).filter(Boolean))];
  if (likelyAbilities.length === 0 && likelyItems.length === 0) return [];
  const hints: InteractionHint[] = [];

  if (!attackerIgnoresDefenderAbility(params.attackerMon) && !params.defenderMon.ability && likelyAbilities.length > 0) {
    const byNormalized = new Map(likelyAbilities.map((ability) => [normalizeName(ability), ability]));
    const moveTypeCandidates = move.type ? (MOVE_TYPE_IMMUNITY_ABILITY_LABELS[normalizeName(move.type)] ?? []) : [];
    for (const candidate of moveTypeCandidates) {
      const label = byNormalized.get(normalizeName(candidate));
      if (!label) continue;
      hints.push({
        label,
        detail: `${label} would make ${params.moveName} do 0.`,
        certainty: "possible"
      });
    }

    const statusCandidates = move.status ? (STATUS_IMMUNITY_ABILITY_LABELS[normalizeName(move.status)] ?? []) : [];
    for (const candidate of statusCandidates) {
      const label = byNormalized.get(normalizeName(candidate));
      if (!label) continue;
      hints.push({
        label,
        detail: `${label} would block ${params.moveName}.`,
        certainty: "possible"
      });
    }

    if (move.category === "Status") {
      for (const candidate of ["Good as Gold", "Comatose"]) {
        const label = byNormalized.get(normalizeName(candidate));
        if (!label) continue;
        hints.push({
          label,
          detail: `${label} would block ${params.moveName}.`,
          certainty: "possible"
        });
      }
      if ((move.status || normalizeName(move.name) === "yawn")) {
        for (const candidate of ["Purifying Salt"]) {
          const label = byNormalized.get(normalizeName(candidate));
          if (!label) continue;
          hints.push({
            label,
            detail: `${label} would block ${params.moveName}.`,
            certainty: "possible"
          });
        }
        if (/sun/i.test(params.snapshot.field.weather ?? "")) {
          const label = byNormalized.get(normalizeName("Leaf Guard"));
          if (label) {
            hints.push({
              label,
              detail: `${label} would block ${params.moveName} in sun.`,
              certainty: "possible"
            });
          }
        }
      }
    }
  }

  if (!params.defenderMon.item && !params.defenderMon.removedItem && likelyItems.length > 0) {
    const byNormalized = new Map(likelyItems.map((item) => [normalizeName(item), item]));
    const moveTypeCandidates = airBalloonBlocksMove(move)
      ? (move.type ? (MOVE_TYPE_IMMUNITY_ITEM_LABELS[normalizeName(move.type)] ?? []) : [])
      : [];
    for (const candidate of moveTypeCandidates) {
      const label = byNormalized.get(normalizeName(candidate));
      if (!label) continue;
      hints.push({
        label,
        detail: `${label} would make ${params.moveName} do 0.`,
        certainty: "possible"
      });
    }
  }

  return dedupeInteractionHints(hints);
}

function bracketFromResult(result: ReturnType<typeof calculate>, defender: Pokemon): Range | null {
  const maxHp = defender.maxHP();
  if (!Number.isFinite(maxHp) || maxHp <= 0) return null;
  const [minRoll, maxRoll] = result.range();
  if (!Number.isFinite(minRoll) || !Number.isFinite(maxRoll) || minRoll < 0 || maxRoll < 0) return null;
  return {
    exactMin: minRoll / maxHp * 100, exactMax: maxRoll / maxHp * 100,
    min: Number(((minRoll / maxHp) * 100).toFixed(1)),
    max: Number(((maxRoll / maxHp) * 100).toFixed(1))
  };
}

const unknownImmediate = (note = "Immediate outcome is unavailable."): ImmediateDamageAssessment => ({
  ko: "unknown", minHpLossPercent: null, maxHpLossPercent: null, note
});

/** Each represented alternative is support, not a new probability or weight. */
function combineImmediate(values: ImmediateDamageAssessment[]): ImmediateDamageAssessment {
  if (!values.length || values.some((value) => value.ko === "unknown")) return unknownImmediate();
  const mixed = values.some((value) => value.ko !== values[0]!.ko);
  const numeric = values.every((value) => value.minHpLossPercent !== null && value.maxHpLossPercent !== null);
  // Extrema are support bounds, including for unweighted alternatives. They
  // carry no probability or midpoint and cannot strengthen a conditional KO.
  return { ko: mixed ? "conditional" : values[0]!.ko,
    minHpLossPercent: numeric ? Math.min(...values.map((value) => value.minHpLossPercent!)) : null,
    maxHpLossPercent: numeric ? Math.max(...values.map((value) => value.maxHpLossPercent!)) : null,
    ...(mixed ? { note: "Immediate KO depends on represented set or survival alternatives." }
      : values.some((value) => value.note) ? { note: [...new Set(values.map((value) => value.note).filter(Boolean))].join(" ") } : {}) };
}

function impactHp(snapshot: PokemonSnapshot, maxHp: number, genNum: number) {
  const exact = exactSnapshotHp(snapshot, maxHp);
  if (exact !== null) return { currentHp: exact, maxHp };
  const percent = snapshot.hpPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0 || percent > 100) return { currentHp: null, maxHp };
  // Gen 7+ public health deliberately maps a nonfull rounded 100% to 99%.
  if (percent === 100 && genNum >= 7) return { currentHp: maxHp, maxHp };
  if (!Number.isInteger(percent)) return { currentHp: null, maxHp };
  return { currentHp: null, maxHp, currentHpRange: {
    min: Math.max(1, Math.floor((percent - 1) * maxHp / 100) + 1),
    max: percent === 99 && genNum >= 7 ? maxHp - 1 : Math.floor(percent * maxHp / 100)
  } };
}

function supportedSingleHit(genNum: number, moveName: string, result: ReturnType<typeof calculate>) {
  const move = lookupMoveData(dataGen(genNum), moveName);
  return Boolean(move) && !move?.ohko && !move?.multihit && !move?.multiaccuracy && result.move.hits === 1
    && !result.attacker.hasAbility("Parental Bond") && !(Array.isArray(result.damage) && Array.isArray(result.damage[0]));
}

function assessResults(params: {
  genNum: number; snapshot: PokemonSnapshot; attacker: Pokemon; defender: Pokemon;
  moveName: string; field: Field; results: ReturnType<typeof calculate>[];
  possibleItems?: string[] | undefined; possibleAbilities?: string[] | undefined;
}) {
  const { genNum, snapshot, attacker, defender, moveName, field, results } = params;
  const hp = impactHp(snapshot, defender.maxHP(), genNum);
  const assess = (result: ReturnType<typeof calculate>) => assessImmediateDamage(result, {
    ...hp, sequence: supportedSingleHit(genNum, moveName, result) ? "single_hit" : "unsupported",
    defenderFormUncertain: !snapshot.species || (snapshot.identityStatus !== undefined && snapshot.identityStatus !== "resolved")
  });
  const assessments = results.map(assess);
  // Explicit live facts override stale history. Candidate runs only qualify
  // survival/bypass; they never enter raw ranges or duplicate hypothesis mass.
  const abilityKnown = Boolean(snapshot.ability);
  const itemKnown = Boolean(snapshot.item || snapshot.removedItem);
  const abilities = !abilityKnown && !defender.hasAbility("Sturdy") && params.possibleAbilities?.some((value) => normalizeName(value) === "sturdy") ? ["Sturdy"] : [];
  const items = !itemKnown ? (params.possibleItems ?? []).flatMap((value) => {
    const id = normalizeName(value);
    return id === "focussash" ? ["Focus Sash"] : id === "abilityshield" ? ["Ability Shield"] : id === "focusband" ? ["Focus Band"] : [];
  }) : [];
  for (const ability of [undefined, ...abilities]) for (const item of [undefined, ...items]) {
    if (!ability && !item) continue;
    const candidate = defender.clone();
    if (ability) candidate.ability = ability as NonNullable<typeof candidate.ability>;
    if (item) candidate.item = item as NonNullable<typeof candidate.item>;
    assessments.push(...calculateDamageScenarios(calcGen(genNum), attacker, candidate, new Move(calcGen(genNum), moveName), field).map(assess));
  }
  return combineImmediate(assessments);
}

function formatRange(range: Range | null) {
  if (!range) return "no direct damage";
  if (range.min === range.max) return `${range.min}%`;
  return `${range.min}-${range.max}%`;
}

function immediateSummary(immediate: ImmediateDamageAssessment) {
  if (immediate.note) return immediate.note;
  if (immediate.ko === "all_rolls") return "KOs current HP on every represented damage roll, if the hit connects";
  if (immediate.ko === "some_rolls") return "some damage rolls KO if the hit connects";
  if (immediate.ko === "no_ko") return "no immediate KO";
  return immediate.ko === "conditional" ? "immediate KO conditional" : "immediate KO unknown";
}

function applyObservedLikelyBand(
  bands: DamageAssumptionBand[],
  observedRange: ObservedRangeSummary | undefined,
  currentHpPercent: number | null | undefined,
  fallbackSource: DamagePreview["likelyBandSource"] = "calc"
) {
  if (bands.some((band) => band.outcome && band.outcome !== "damage")) {
    return { bands, likelyBandSource: fallbackSource };
  }
  if (!observedRange) {
    return { bands, likelyBandSource: fallbackSource };
  }
  if (observedRange.source === "aggregate" && observedRange.sampleCount < 3) {
    return { bands, likelyBandSource: fallbackSource };
  }
  return {
    bands: bands.map((band) =>
      band.label === "likely"
        ? {
            ...band,
            minPercent: observedRange.minPercent,
            maxPercent: observedRange.maxPercent,
            immediate: unknownImmediate("Observed raw damage does not establish immediate survival at this impact.")
          }
        // The upper scenario never sits below what was observed.
        : band.label === "high" && Number.isFinite(band.maxPercent) && Number.isFinite(band.minPercent)
            && (band.maxPercent! < observedRange.maxPercent || band.minPercent! < observedRange.minPercent)
          ? {
              ...band,
              minPercent: Math.max(band.minPercent!, observedRange.minPercent),
              maxPercent: Math.max(band.maxPercent!, observedRange.maxPercent),
              immediate: unknownImmediate("Raised to the observed damage; immediate survival is not established at this impact."),
              detail: [band.detail, "High raised to the observed likely damage."].filter(Boolean).join(" ")
            }
          : band
    ),
    likelyBandSource: (observedRange.source ?? "aggregate") as "context" | "aggregate"
  };
}

function posteriorConfidenceUsable(posterior: OpponentPosteriorPreview | undefined) {
  return posterior?.confidenceTier === "usable" || posterior?.confidenceTier === "strong";
}

function posteriorConsensusValues(posterior: OpponentPosteriorPreview | undefined, key: "item" | "ability" | "teraType") {
  if (!posterior) return [];
  const values = new Set<string>();
  for (const hypothesis of posterior.topHypotheses) {
    const value = hypothesis[key];
    if (value) values.add(value);
    if (values.size >= 3) break;
  }
  return [...values];
}

function posteriorWeightedPercentile(values: Array<{ value: number; weight: number }>, percentile: number) {
  const filtered = values.filter((entry) => Number.isFinite(entry.value) && entry.weight > 0).sort((a, b) => a.value - b.value);
  if (filtered.length === 0) return 0;
  const total = filtered.reduce((sum, entry) => sum + entry.weight, 0);
  const target = total * percentile;
  let running = 0;
  for (const entry of filtered) {
    running += entry.weight;
    if (running >= target) return entry.value;
  }
  return filtered[filtered.length - 1]?.value ?? 0;
}

function posteriorBandsFromHypotheses(
  snapshot: BattleSnapshot,
  moveName: string,
  attackerMon: PokemonSnapshot,
  defenderMon: PokemonSnapshot,
  direction: "your" | "opponent",
  posterior: OpponentPosteriorPreview | undefined,
  role: "attacker" | "defender",
  possibleItems?: string[],
  possibleAbilities?: string[]
) {
  if (!posteriorConfidenceUsable(posterior) || !posterior || posterior.topHypotheses.length === 0) return null;

  const genNum = generationFromFormat(snapshot.format);
  const gen = calcGen(genNum);
  const dataMove = lookupMoveData(dataGen(genNum), moveName);
  const category = dataMove?.category === "Status"
    ? "Status"
    : dataMove?.category === "Physical" || dataMove?.category === "Special"
      ? dataMove.category
      : "Status";
  if (category === "Status") return null;

  const field = buildField(snapshot, direction);
  const represented: ImmediateDamageAssessment[] = [];
  const samples = posterior.topHypotheses.flatMap((hypothesis) => {
    const attacker = createPokemonFromSnapshot(snapshot.format, genNum, attackerMon, {
      profile: "likely",
      role: "attacker",
      category,
      likelyItem: role === "attacker" ? hypothesis.item ?? undefined : attackerMon.item ?? undefined,
      likelyAbility: role === "attacker" ? hypothesis.ability ?? undefined : attackerMon.ability ?? undefined,
      posteriorHypothesis: role === "attacker" ? hypothesis : undefined,
      useSnapshotStats: role !== "attacker"
    });
    const defender = createPokemonFromSnapshot(snapshot.format, genNum, defenderMon, {
      profile: "likely",
      role: "defender",
      category,
      likelyItem: role === "defender" ? hypothesis.item ?? undefined : defenderMon.item ?? undefined,
      likelyAbility: role === "defender" ? hypothesis.ability ?? undefined : defenderMon.ability ?? undefined,
      posteriorHypothesis: role === "defender" ? hypothesis : undefined,
      useSnapshotStats: role !== "defender"
    });
    if (!attacker || !defender) { represented.push(unknownImmediate()); return []; }
    const results = calculateDamageScenarios(gen, attacker, defender, new Move(gen, moveName), field);
    represented.push(assessResults({ genNum, snapshot: defenderMon, attacker, defender, moveName, field, results,
      possibleItems: role === "defender" && hypothesis.item ? undefined : possibleItems,
      possibleAbilities: role === "defender" && hypothesis.ability ? undefined : possibleAbilities }));
    const ranges = results.map((result) => bracketFromResult(result, defender)).filter((range): range is Range => range !== null);
    if (!ranges.length) return [];
    return [{
      weight: hypothesis.weight,
      uncertainActivation: attacker.abilityActivationUncertain || defender.abilityActivationUncertain,
      exactMin: Math.min(...ranges.map((range) => range.exactMin ?? range.min)),
      exactMax: Math.max(...ranges.map((range) => range.exactMax ?? range.max)),
      minPercent: Math.min(...ranges.map((range) => range.min)),
      maxPercent: Math.max(...ranges.map((range) => range.max))
    }];
  });

  if (samples.length === 0) return null;
  if (samples.every((sample) => sample.maxPercent === 0) && represented.every((value) => value.ko === "no_ko")) {
    return [makeDamagingImmunityBand({ label: "immune", outcome: "immune", detail: "All represented posterior hypotheses produce zero damage." })];
  }

  const bands: DamageAssumptionBand[] = [
    {
      label: "conservative",
      minPercent: Number(posteriorWeightedPercentile(samples.map((sample) => ({ value: sample.minPercent, weight: sample.weight })), 0.1).toFixed(1)),
      maxPercent: Number(posteriorWeightedPercentile(samples.map((sample) => ({ value: sample.maxPercent, weight: sample.weight })), 0.1).toFixed(1)),
      immediate: combineImmediate(represented)
    },
    {
      label: "likely",
      minPercent: Number(posteriorWeightedPercentile(samples.map((sample) => ({ value: sample.minPercent, weight: sample.weight })), 0.5).toFixed(1)),
      maxPercent: Number(posteriorWeightedPercentile(samples.map((sample) => ({ value: sample.maxPercent, weight: sample.weight })), 0.5).toFixed(1)),
      immediate: combineImmediate(represented)
    },
    {
      label: "high",
      minPercent: Number(posteriorWeightedPercentile(samples.map((sample) => ({ value: sample.minPercent, weight: sample.weight })), 0.9).toFixed(1)),
      maxPercent: Number(posteriorWeightedPercentile(samples.map((sample) => ({ value: sample.maxPercent, weight: sample.weight })), 0.9).toFixed(1)),
      immediate: combineImmediate(represented)
    }
  ].map((band) => ({
    ...band,
    ...(samples.some((sample) => sample.uncertainActivation) ? { detail: "Interval includes active and inactive ability scenarios; activation is unobserved." } : {})
  }));

  return bands;
}

function buildSurvivalCaveats(
  defender: PokemonSnapshot,
  options: { likelyItems?: string[] | undefined; likelyAbilities?: string[] | undefined }
): SurvivalCaveat[] {
  if (Number(defender.hpPercent ?? 0) < 100) return [];
  const caveats: SurvivalCaveat[] = [];
  const knownAbility = defender.ability ?? "";
  const knownItem = defender.item ?? "";
  const knownAbilityId = normalizeName(knownAbility);
  const knownItemId = normalizeName(knownItem);
  const likelyAbilityIds = new Set((options.likelyAbilities ?? []).map((value) => normalizeName(value)));
  const likelyItemIds = new Set((options.likelyItems ?? []).map((value) => normalizeName(value)));

  if (knownAbilityId === "sturdy") {
    caveats.push({ kind: "Sturdy", certainty: "known", note: "Known Sturdy can leave the target at 1 HP from full." });
  } else if (!knownAbility && likelyAbilityIds.has("sturdy")) {
    caveats.push({ kind: "Sturdy", certainty: "historically_possible", note: "Stored history suggests Sturdy is possible from full." });
  }

  if (knownItemId === "focussash") {
    caveats.push({ kind: "Focus Sash", certainty: "known", note: "Known Focus Sash can leave the target at 1 HP from full." });
  } else if (!knownItem && !defender.removedItem && likelyItemIds.has("focussash")) {
    caveats.push({ kind: "Focus Sash", certainty: "historically_possible", note: "Stored history suggests Focus Sash is possible from full." });
  }

  if (knownAbilityId === "multiscale") {
    caveats.push({ kind: "Multiscale", certainty: "known", note: "Known Multiscale can reduce damage while the target is at full HP." });
  } else if (!knownAbility && likelyAbilityIds.has("multiscale")) {
    caveats.push({ kind: "Multiscale", certainty: "historically_possible", note: "Stored history suggests Multiscale is possible at full HP." });
  }

  return caveats;
}

function buildBands(params: {
  genNum: number;
  snapshot: BattleSnapshot;
  attackerMon: PokemonSnapshot;
  defenderMon: PokemonSnapshot;
  moveName: string;
  direction: "your" | "opponent";
  attackerPosterior?: OpponentPosteriorPreview | undefined;
  defenderPosterior?: OpponentPosteriorPreview | undefined;
  possibleItems?: string[] | undefined;
  possibleAbilities?: string[] | undefined;
  likelyDefenderItem?: string | undefined;
  likelyDefenderAbility?: string | undefined;
  /** An unrevealed attacker's assumed item for the "likely" and "high" bands (the ladder's modal item). */
  likelyAttackerItem?: string | undefined;
  likelyAttackerAbility?: string | undefined;
  /** The ladder's modal attacking spreads; the "likely" band uses the move category's. */
  likelyAttackerProfile?: LadderAttackProfile | undefined;
  /** Live likely items of an attacker whose item is unknown; "high" takes the strongest. */
  highAttackerItems?: string[] | undefined;
}): DamageAssumptionBand[] {
  const genNum = params.genNum;
  const gen = calcGen(genNum);
  const calcMove = new Move(gen, params.moveName);
  const dataMove = lookupMoveData(dataGen(genNum), params.moveName);
  const category = dataMove?.category === "Status"
    ? "Status"
    : calcMove?.category === "Physical" || calcMove?.category === "Special"
      ? calcMove.category
      : "Status";

  if (category === "Status") {
    return [buildStatusOutcomeBand({
      genNum,
      snapshot: params.snapshot,
      attackerMon: params.attackerMon,
      defenderMon: params.defenderMon,
      moveName: params.moveName
    })];
  }

  const posteriorDirection = params.direction === "your" ? "defender" : "attacker";
  const posterior = posteriorDirection === "attacker" ? params.attackerPosterior : params.defenderPosterior;
  const posteriorBands = posteriorBandsFromHypotheses(
    params.snapshot,
    params.moveName,
    params.attackerMon,
    params.defenderMon,
    params.direction,
    posterior,
    posteriorDirection,
    params.possibleItems, params.possibleAbilities
  );
  if (posteriorBands) return withHighItemAssumption(params, category, posteriorBands);

  const field = buildField(params.snapshot, params.direction === "your" ? "your" : "opponent");
  const profiles: Array<{ profile: DamageProfile; label: string }> = [
    { profile: "low", label: "conservative" },
    { profile: "likely", label: "likely" },
    { profile: "high", label: "high" }
  ];

  let resolvedZero: ReturnType<typeof calculate> | undefined;
  const bands = profiles.map(({ profile, label }) => {
    const attacker = createPokemonFromSnapshot(params.snapshot.format, genNum, params.attackerMon, {
      profile: params.direction === "your" ? "likely" : profile,
      role: "attacker",
      category,
      likelyItem: profile === "low" ? undefined : params.likelyAttackerItem,
      likelyAbility: params.likelyAttackerAbility,
      attackProfile: params.likelyAttackerProfile?.[category]
    });
    const defender = createPokemonFromSnapshot(params.snapshot.format, genNum, params.defenderMon, {
      profile: params.direction === "your" ? profile : "likely",
      role: "defender",
      category,
      likelyItem: params.likelyDefenderItem,
      likelyAbility: params.likelyDefenderAbility
    });
    if (!attacker || !defender) {
      return {
        label,
        minPercent: null,
        maxPercent: null,
        immediate: unknownImmediate()
      };
    }
    const results = calculateDamageScenarios(gen, attacker, defender, calcMove, field);
    resolvedZero ??= results[0];
    const ranges = results.map((result) => bracketFromResult(result, defender)).filter((range): range is Range => range !== null);
    const range = ranges.length ? { min: Math.min(...ranges.map((range) => range.min)), max: Math.max(...ranges.map((range) => range.max)),
      exactMin: Math.min(...ranges.map((range) => range.exactMin ?? range.min)), exactMax: Math.max(...ranges.map((range) => range.exactMax ?? range.max)) } : null;
    return {
      label,
      minPercent: range?.min ?? null,
      maxPercent: range?.max ?? null,
      immediate: assessResults({ genNum, snapshot: params.defenderMon, attacker, defender, moveName: params.moveName, field, results, possibleItems: params.possibleItems, possibleAbilities: params.possibleAbilities }),
      ...(results.length > 1 ? { detail: "Interval includes active and inactive ability scenarios; activation is unobserved." } : {})
    };
  });
  if (bands.every((band) => band.minPercent === 0 && band.maxPercent === 0 && band.immediate.ko === "no_ko")) {
    // Explain only a zero result established by resolved calculator mechanics.
    // Static move typing must not pre-empt Tera Blast, Weather Ball, Scrappy,
    // Gravity or another transformation handled by the maintained calculator.
    const effect = resolvedZero?.rawDesc.defenderAbility ?? resolvedZero?.rawDesc.defenderItem;
    const targetTypes = resolvedZero?.defender.teraType && resolvedZero.defender.teraType !== "Stellar"
      ? [resolvedZero.defender.teraType] : resolvedZero?.defender.types ?? [];
    return [makeDamagingImmunityBand({
      label: "immune", outcome: "immune", detail: `Resolved ${resolvedZero?.move.type ?? "move"}-type attack produces zero damage against ${targetTypes.map((type) => `${type}-type`).join("/")} typing${effect ? ` (${effect})` : ""}.`
    })];
  }
  return withHighItemAssumption(params, category, bands);
}

/** Unknown attacker item: raise "high" to the strongest live likely item (Choice Band, Life Orb, a type booster...)
 * and label the assumption. Items that do not change damage leave the band untouched. */
function withHighItemAssumption(params: Parameters<typeof buildBands>[0], category: "Physical" | "Special", bands: DamageAssumptionBand[]) {
  const attackerMon = params.attackerMon, items = params.highAttackerItems ?? [];
  const high = bands.find((band) => band.label === "high");
  if (!high || !items.length || attackerMon.item || attackerMon.removedItem || bands.some((band) => band.outcome && band.outcome !== "damage")) return bands;
  const gen = calcGen(params.genNum), field = buildField(params.snapshot, params.direction === "your" ? "your" : "opponent");
  let best: { item: string; range: Range; immediate: ImmediateDamageAssessment } | null = null;
  for (const item of items) {
    const attacker = createPokemonFromSnapshot(params.snapshot.format, params.genNum, attackerMon, { profile: "high", role: "attacker", category, likelyItem: item, likelyAbility: params.likelyAttackerAbility });
    const defender = createPokemonFromSnapshot(params.snapshot.format, params.genNum, params.defenderMon, { profile: "likely", role: "defender", category, likelyItem: params.likelyDefenderItem, likelyAbility: params.likelyDefenderAbility });
    if (!attacker || !defender) continue;
    const results = calculateDamageScenarios(gen, attacker, defender, new Move(gen, params.moveName), field);
    const ranges = results.map((result) => bracketFromResult(result, defender)).filter((range): range is Range => range !== null);
    if (!ranges.length) continue;
    const range = { min: Math.min(...ranges.map((r) => r.min)), max: Math.max(...ranges.map((r) => r.max)) };
    if (!best || range.max > best.range.max) best = { item, range, immediate: assessResults({ genNum: params.genNum, snapshot: params.defenderMon, attacker, defender, moveName: params.moveName, field, results, possibleItems: params.possibleItems, possibleAbilities: params.possibleAbilities }) };
  }
  if (!best || best.range.max <= (high.maxPercent ?? Infinity)) return bands;
  return bands.map((band) => band === high ? { ...band, minPercent: Math.max(band.minPercent ?? 0, best!.range.min), maxPercent: best!.range.max, immediate: best!.immediate,
    detail: [band.detail, `High assumes ${best!.item}.`].filter(Boolean).join(" ") } : band);
}

function cleanDeterministicDetail(detail: string | undefined) {
  return typeof detail === "string" ? detail.replace(/[.\s]+$/g, "") : undefined;
}

export function buildDamageSummary(label: string, bands: DamageAssumptionBand[], caveats: SurvivalCaveat[]) {
  const deterministicBand = bands.length === 1 && bands[0]?.outcome && bands[0].outcome !== "damage"
    ? bands[0]
    : null;
  if (deterministicBand) {
    const outcomeText = deterministicBand.outcome === "immune"
      ? "immune"
      : deterministicBand.outcome === "blocked"
        ? "blocked"
        : "status move";
    const caveatText = caveats.length > 0 ? `; ${caveats.map((caveat) => caveat.note).join(" ")}` : "";
    const detail = cleanDeterministicDetail(deterministicBand.detail);
    return `${label}: ${outcomeText}${detail ? ` (${detail})` : ""}${caveatText}.`;
  }

  const labelMap: Record<string, string> = {
    likely: "likely",
    conservative: "conservative",
    high: "high"
  };
  const parts = bands.map((band) => {
    const range = band.minPercent === null || band.maxPercent === null ? "damage unknown" : formatRange({ min: band.minPercent, max: band.maxPercent });
    return `${labelMap[band.label] ?? band.label} raw ${range}; ${immediateSummary(band.immediate)}`;
  });
  const uncertaintyText = [...new Set(bands.map((band) => band.detail).filter(Boolean))].join(" ");
  const caveatText = caveats.length > 0 ? `; ${caveats.map((caveat) => caveat.note).join(" ")}` : "";
  return `${label}: ${parts.join("; ")}${caveatText}.${uncertaintyText ? ` ${uncertaintyText}` : ""}`;
}

function moveCategoryForPreview(genNum: number, moveName: string) {
  const move = lookupMoveData(dataGen(genNum), moveName);
  if (move?.category === "Physical" || move?.category === "Special") return move.category;
  return "Status" as const;
}

/** Calculator bands describe a conditional impact, never the cast turn. */
export function buildDelayedDamagePreview(snapshot: BattleSnapshot, moveName: string, targetSide: "p1" | "p2", bands: DamageAssumptionBand[]): DelayedDamagePreview | undefined {
  if (!lookupMoveData(dataGen(generationFromFormat(snapshot.format)), moveName)?.flags.futuremove) return undefined;
  const matching = (snapshot.pendingAttacks ?? []).filter((entry) => entry.targetSide === targetSide && entry.targetPosition === "a");
  const facts = snapshot.canonicalEvidence?.facts ?? [];
  const complete = snapshot.turnCoverage?.source === "owned_offline_simulator" && snapshot.turnCoverage.turn === snapshot.turn
    && snapshot.canonicalEvidence?.limitations.length === 0 && snapshot.canonicalEvidence.ambiguities.length === 0
    && facts.some((fact) => fact.kind === "init" && fact.args[0] === "battle") && facts.some((fact) => fact.kind === "start")
    && !facts.some((fact) => fact.source.channel === "recovery");
  const scheduling = matching.length ? matching.every((entry) => entry.status === "scheduled" && entry.factIds.length > 0) ? "occupied" : "unknown" : complete ? "clear" : "unknown";
  return { kind: "delayed", delayTurns: 2, phase: "end_of_turn", immediateDamagePercent: 0,
    scheduling, dueTurn: scheduling === "clear" ? snapshot.turn + 2 : null,
    targetSide, targetPosition: "a", recipient: "slot_at_impact",
    factIds: [...new Set(matching.length ? matching.flatMap((entry) => entry.factIds) : complete ? [snapshot.turnCoverage!.turnFactId, snapshot.turnCoverage!.requestFactId] : [])], bands };
}

function delayedDamageSummary(label: string, delayed: DelayedDamagePreview) {
  const ranges = delayed.bands.map((band) => `${band.label} ${band.minPercent === null || band.maxPercent === null ? "unknown damage" : formatRange({ min: band.minPercent, max: band.maxPercent })}`).join("; ");
  const schedule = delayed.scheduling === "occupied" ? "target slot already has a pending attack; another cast fails"
    : delayed.scheduling === "unknown" ? "scheduling is unknown from this capture" : `if the cast succeeds, impact is at the end of turn ${delayed.dueTurn}`;
  return `${label}: zero immediate damage; ${schedule}. Conditional eventual matchup: ${ranges}. Recipient at impact and caster state may change.`;
}

export function buildDamagePreview(snapshot: BattleSnapshot, options: DamageOptions = {}): DamagePreview[] {
  const originalActive = snapshot.yourSide.active;
  if (!originalActive || originalActive.fainted || (originalActive.hpPercent ?? 100) <= 0
    || !snapshot.opponentSide.active || snapshot.opponentSide.active.fainted || (snapshot.opponentSide.active.hpPercent ?? 100) <= 0) return [];

  const genNum = generationFromFormat(snapshot.format);
  const defenderPosterior = options.defenderPosterior;
  const usePosterior = posteriorConfidenceUsable(defenderPosterior);
  const opponentActive = usePosterior ? snapshot.opponentSide.active : withSoleAbility(genNum, snapshot.opponentSide.active);
  const liveLikelyDefenderItems = filterLiveLikelyHeldItemNames(snapshot.format, opponentActive, options.likelyDefenderItems, {
    recentLog: snapshot.recentLog
  });
  return snapshot.legalActions
    .filter((action) => action.kind === "move" && action.moveName)
    .map((action) => {
      const actionSnapshot = snapshotForAction(snapshot, action);
      const yourActive = actionSnapshot.yourSide.active!;
      const category: DamagePreview["category"] = moveCategoryForPreview(genNum, action.moveName ?? action.label);
      const delayedMove = Boolean(lookupMoveData(dataGen(genNum), action.moveName ?? action.label)?.flags.futuremove);
      const bands = buildBands({
        genNum,
        snapshot: actionSnapshot,
        attackerMon: yourActive,
        defenderMon: opponentActive,
        moveName: action.moveName ?? action.label,
        direction: "your",
        defenderPosterior,
        possibleItems: liveLikelyDefenderItems, possibleAbilities: options.likelyDefenderAbilities,
        likelyDefenderItem: knockOffHeldItem(action.moveName ?? action.label, opponentActive, liveLikelyDefenderItems)
      });
      const posteriorItems = posteriorConsensusValues(defenderPosterior, "item");
      const posteriorAbilities = posteriorConsensusValues(defenderPosterior, "ability");
      const resolvedLikelyDefenderItems = filterLiveLikelyHeldItemNames(
        snapshot.format,
        opponentActive,
        posteriorItems.length > 0 ? posteriorItems : liveLikelyDefenderItems,
        { recentLog: snapshot.recentLog }
      );
      const survivalCaveats = buildSurvivalCaveats(opponentActive, {
        likelyItems: resolvedLikelyDefenderItems,
        likelyAbilities: posteriorAbilities.length > 0 ? posteriorAbilities : options.likelyDefenderAbilities
      });
      const interactionHints = buildPossibleAbilityInteractionHints({
        genNum,
        snapshot: actionSnapshot,
        attackerMon: yourActive,
        defenderMon: opponentActive,
        moveName: action.moveName ?? action.label,
        likelyDefenderItems: resolvedLikelyDefenderItems,
        likelyDefenderAbilities: posteriorAbilities.length > 0 ? posteriorAbilities : options.likelyDefenderAbilities
      });
      const observedRange = delayedMove ? undefined : options.observedPlayerDamageResolver?.(
        action.moveName ?? action.label,
        yourActive,
        opponentActive
      ) ?? (action.terastallize ? undefined : options.observedPlayerDamage?.[`${action.moveName ?? action.label}|${yourActive.species ?? yourActive.displayName ?? "Your active"}`]);
      const narrowed = usePosterior
        ? { bands, likelyBandSource: "posterior" as const }
        : applyObservedLikelyBand(bands, observedRange, opponentActive.hpPercent ?? null);
      const likelyBandSource = narrowed.likelyBandSource;
      const delayed = buildDelayedDamagePreview(actionSnapshot, action.moveName ?? action.label, snapshot.opponentSide.slot === "p1" ? "p1" : "p2", narrowed.bands);
      return {
        actionId: action.id,
        terastallize: Boolean(action.terastallize),
        label: action.label,
        moveName: action.moveName ?? action.label,
        targetName: opponentActive.species ?? opponentActive.displayName ?? "Opponent active",
        targetCurrentHpPercent: opponentActive.hpPercent ?? null,
        category,
        bands: delayed ? [] : narrowed.bands,
        ...(delayed ? { delayed } : {}),
        observedRange,
        likelyBandSource,
        survivalCaveats,
        interactionHints,
        summary: delayed ? delayedDamageSummary(action.label, delayed) : buildDamageSummary(action.label, narrowed.bands, survivalCaveats)
      };
    });
}

export function buildThreatPreview(
  snapshot: BattleSnapshot,
  options: DamageOptions & {
    moveCandidates: Array<{ name: string; source: "known" | "likely" }>;
    observedThreats?: Record<string, ObservedRangeSummary> | undefined;
    observedThreatResolver?: ((moveName: string, attacker: PokemonSnapshot, defender: PokemonSnapshot) => ObservedRangeSummary | undefined) | undefined;
  }
): ThreatPreview[] {
  const yourActive = snapshot.yourSide.active;
  if (!yourActive || !snapshot.opponentSide.active || snapshot.opponentSide.active.fainted || (snapshot.opponentSide.active.hpPercent ?? 100) <= 0) return [];
  const currentTargetAvailable = !yourActive.fainted && (yourActive.hpPercent ?? 100) > 0;
  const genNum = generationFromFormat(snapshot.format);
  const opponentActive = posteriorConfidenceUsable(options.attackerPosterior) ? snapshot.opponentSide.active : withSoleAbility(genNum, snapshot.opponentSide.active);
  // The ladder's modal item stands in for an unrevealed one in "likely"/"high"; a revealed or removed item overrides it.
  const likelyAttackerProfile = options.likelyAttackerProfile;
  const likelyAttackerItem = opponentActive.item || opponentActive.removedItem ? undefined : likelyAttackerProfile?.item;
  const attackerPosterior = options.attackerPosterior;
  const usePosterior = posteriorConfidenceUsable(attackerPosterior);
  const liveLikelyDefenderItems = currentTargetAvailable ? filterLiveLikelyHeldItemNames(snapshot.format, yourActive, options.likelyDefenderItems, {
    recentLog: snapshot.recentLog
  }) : [];
  const highAttackerItems = filterLiveLikelyHeldItemNames(snapshot.format, opponentActive, options.likelyAttackerItems, { recentLog: snapshot.recentLog });
  const likelyAttackerAbility = opponentActive.ability ? undefined : options.likelyAttackerAbilities?.[0];

  return options.moveCandidates
    .map((candidate) => {
      const moveData = lookupMoveData(dataGen(genNum), candidate.name);
      const delayedMove = Boolean(moveData?.flags.futuremove);
      if (moveData?.category === "Status" && !moveTargetsSpecificFoe(moveData)) {
        return null;
      }
      const currentBands = currentTargetAvailable ? buildBands({
        genNum,
        snapshot,
        attackerMon: opponentActive,
        defenderMon: yourActive,
        moveName: candidate.name,
        direction: "opponent",
        possibleItems: liveLikelyDefenderItems, possibleAbilities: options.likelyDefenderAbilities,
        attackerPosterior, highAttackerItems, likelyAttackerAbility, likelyAttackerItem, likelyAttackerProfile
      }) : [];
      const currentObservedRange = currentTargetAvailable && !delayedMove ? (options.observedThreatResolver?.(
        candidate.name,
        opponentActive,
        yourActive
      ) ?? options.observedThreats?.[`${candidate.name}|${yourActive.species ?? yourActive.displayName ?? "Your active"}`]) : undefined;
      const currentInteractionHints = currentTargetAvailable ? buildPossibleAbilityInteractionHints({
        genNum,
        snapshot,
        attackerMon: opponentActive,
        defenderMon: yourActive,
        moveName: candidate.name,
        likelyDefenderItems: liveLikelyDefenderItems,
        likelyDefenderAbilities: options.likelyDefenderAbilities
      }) : [];
      const narrowedCurrent = usePosterior
        ? { bands: currentBands, likelyBandSource: "posterior" as const }
        : applyObservedLikelyBand(currentBands, currentObservedRange, yourActive.hpPercent ?? null);
      const currentBandSource = currentTargetAvailable ? narrowedCurrent.likelyBandSource : undefined;
      const currentDelayed = buildDelayedDamagePreview(snapshot, candidate.name, snapshot.yourSide.slot === "p2" ? "p2" : "p1", narrowedCurrent.bands);
      const currentTarget: ThreatTargetPreview = {
        instanceId: yourActive.instanceId,
        species: yourActive.species ?? yourActive.displayName ?? "Your active",
        targetCurrentHpPercent: yourActive.hpPercent ?? null,
        relation: "unknown",
        bands: currentDelayed ? [] : narrowedCurrent.bands,
        ...(currentDelayed ? { delayed: currentDelayed } : {}),
        observedRange: currentObservedRange,
        likelyBandSource: currentBandSource,
        interactionHints: currentInteractionHints,
        summary: currentTargetAvailable
          ? currentDelayed ? delayedDamageSummary(`${candidate.name} into ${yourActive.species ?? yourActive.displayName ?? "your active"}`, currentDelayed)
            : buildDamageSummary(`${candidate.name} into ${yourActive.species ?? yourActive.displayName ?? "your active"}`, narrowedCurrent.bands, [])
          : `${yourActive.species ?? yourActive.displayName ?? "Your active"} has fainted; compare living switch targets.`
      };
      const switchTargets: ThreatTargetPreview[] = snapshot.yourSide.team
        .filter((pokemon) => !pokemon.fainted && (pokemon.hpPercent ?? 100) > 0 && !pokemon.active)
        .map((pokemon) => {
          // A future entry starts a new Slow Start stint, even after prior expiry.
          const entry = projectSwitchEntry(snapshot, pokemon, "your");
          pokemon = entry.pokemon;
          const bands = entry.fainted ? [] : buildBands({
            genNum,
            snapshot,
            attackerMon: opponentActive,
            defenderMon: pokemon,
            moveName: candidate.name,
            direction: "opponent",
            possibleItems: filterLiveLikelyHeldItemNames(snapshot.format, pokemon, options.likelyDefenderItems, { recentLog: snapshot.recentLog }),
            possibleAbilities: options.likelyDefenderAbilities,
            attackerPosterior, highAttackerItems, likelyAttackerAbility, likelyAttackerItem, likelyAttackerProfile
          });
          const observedRange = delayedMove || !entry.damageQualified || entry.notes.length > 0 ? undefined : options.observedThreatResolver?.(
            candidate.name,
            opponentActive,
            pokemon
          ) ?? options.observedThreats?.[`${candidate.name}|${pokemon.species ?? pokemon.displayName ?? "Switch target"}`];
          const interactionHints = buildPossibleAbilityInteractionHints({
            genNum,
            snapshot,
            attackerMon: opponentActive,
            defenderMon: pokemon,
            moveName: candidate.name,
            likelyDefenderItems: filterLiveLikelyHeldItemNames(snapshot.format, pokemon, options.likelyDefenderItems, {
              recentLog: snapshot.recentLog
            }),
            likelyDefenderAbilities: options.likelyDefenderAbilities
          });
          const narrowed = usePosterior
            ? { bands, likelyBandSource: "posterior" as const }
            : applyObservedLikelyBand(bands, observedRange, pokemon.hpPercent ?? null);
          if (!entry.damageQualified) narrowed.bands = withholdEntryDamage(narrowed.bands, entry.notes, true);
          else if (!entry.hpCertain || (!entry.speedCertain && ["gyroball", "electroball"].includes(normalizeName(candidate.name)))) narrowed.bands = narrowed.bands.map((band) => ({ ...band, outcome: undefined, minPercent: null, maxPercent: null, immediate: unknownImmediate(), detail: [band.detail, ...entry.notes].filter(Boolean).join(" ") }));
          const bandSource = entry.damageQualified ? narrowed.likelyBandSource : undefined;
          const delayed = buildDelayedDamagePreview(snapshot, candidate.name, snapshot.yourSide.slot === "p2" ? "p2" : "p1", narrowed.bands);
          return {
            instanceId: pokemon.instanceId,
            species: pokemon.species ?? pokemon.displayName ?? "Switch target",
            targetCurrentHpPercent: pokemon.hpPercent ?? null,
            relation: "unknown",
            bands: delayed ? [] : narrowed.bands,
            ...(delayed ? { delayed } : {}),
            observedRange,
            likelyBandSource: bandSource,
            interactionHints: entry.damageQualified ? interactionHints : [],
            summary: entry.fainted ? "Projected entry hazards KO this switch target before the reply." : [delayed ? delayedDamageSummary(`${candidate.name} into ${pokemon.species ?? pokemon.displayName ?? "switch target"}`, delayed)
              : buildDamageSummary(`${candidate.name} into ${pokemon.species ?? pokemon.displayName ?? "switch target"}`, narrowed.bands, []), ...entry.notes].join(" ")
          };
        });
      return {
        moveName: candidate.name,
        moveSource: candidate.source,
        targetName: currentTarget.species,
        currentTarget,
        switchTargets,
        summary: currentTarget.summary
      };
    })
    .filter((entry): entry is ThreatPreview => Boolean(entry))
    .slice(0, 6);
}

export function buildDamageNotes(snapshot: BattleSnapshot, options: DamageOptions = {}): string[] {
  return buildDamagePreview(snapshot, options).map((entry) => entry.summary);
}
