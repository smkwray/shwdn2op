import { Dex } from "@pkmn/dex";
import { Generations as DataGenerations } from "@pkmn/data";
import { calculate, Field, Generations as CalcGenerations, Move, Pokemon, Side } from "@smogon/calc";

import type {
  BattleSnapshot,
  InferenceEvent,
  OpponentPosteriorPreview,
  PokemonSnapshot,
  PosteriorEvidence,
  PosteriorHypothesis,
  StatPosteriorBand
} from "../types.js";

import {
  speedStageMultiplier,
  paralysisSpeedMultiplier,
  matchingFieldSpeedAbilityRule
} from "../mechanics/speed.js";

type StatArchetypeId = PosteriorHypothesis["statArchetype"];
type StatId = "hp" | "atk" | "def" | "spa" | "spd" | "spe";
type DamageDirection = "incoming" | "outgoing";

export interface PosteriorBattleDamageObservation {
  key: string;
  direction: DamageDirection;
  turn: number;
  moveName: string;
  percent: number;
  attacker: PokemonSnapshot;
  defender: PokemonSnapshot;
  field: BattleSnapshot["field"];
}

export interface PosteriorBattleSpeedObservation {
  key: string;
  turn: number;
  relation: "first" | "second";
  yourSpecies: string;
  yourSpeedStat: number;
}

export interface PosteriorBattleSpeciesEvidence {
  incomingDamage: PosteriorBattleDamageObservation[];
  outgoingDamage: PosteriorBattleDamageObservation[];
  speedObservations: PosteriorBattleSpeedObservation[];
}

export interface PosteriorFormatStats {
  observedBattlesSeen: number;
  curatedTeamCount?: number | undefined;
  observedMoves: Record<string, number>;
  observedItems: Record<string, number>;
  observedAbilities: Record<string, number>;
  observedTeraTypes: Record<string, number>;
  curatedMoves: Record<string, number>;
  curatedItems: Record<string, number>;
  curatedAbilities: Record<string, number>;
  curatedTeraTypes: Record<string, number>;
}

interface PosteriorBuildParams {
  format: string;
  opponent: PokemonSnapshot;
  formatStats: PosteriorFormatStats;
  battleSnapshot?: BattleSnapshot | undefined;
  battleEvidence?: PosteriorBattleSpeciesEvidence | undefined;
  inferenceEvents?: InferenceEvent[] | undefined;
}

interface SkeletonCandidate {
  ability: string | null;
  item: string | null;
  teraType: string | null;
  logScore: number;
}

type ArchetypeConfig = {
  id: StatArchetypeId;
  nature: string;
  evs: Partial<Record<StatId, number>>;
  role: "physical" | "special" | "defensive";
};

const calcGens = CalcGenerations;
const dataGens = new DataGenerations(Dex as any);

const DEFAULT_ITEMS = [
  "Choice Scarf",
  "Choice Band",
  "Choice Specs",
  "Heavy-Duty Boots",
  "Leftovers",
  "Life Orb",
  "Assault Vest",
  "Eviolite"
];
const CURATED_PRIOR_WEIGHT = 0.35;

const ARCHETYPES: ArchetypeConfig[] = [
  { id: "fast_phys", nature: "Jolly", evs: { hp: 4, atk: 252, spe: 252 }, role: "physical" },
  { id: "fast_spec", nature: "Timid", evs: { hp: 4, spa: 252, spe: 252 }, role: "special" },
  { id: "bulky_phys", nature: "Adamant", evs: { hp: 252, atk: 252, spd: 4 }, role: "physical" },
  { id: "bulky_spec", nature: "Modest", evs: { hp: 252, spa: 252, def: 4 }, role: "special" },
  { id: "physdef", nature: "Bold", evs: { hp: 252, def: 252, spa: 4 }, role: "defensive" },
  { id: "spdef", nature: "Calm", evs: { hp: 252, spd: 252, spa: 4 }, role: "defensive" },
  { id: "scarf_phys", nature: "Adamant", evs: { hp: 4, atk: 252, spe: 252 }, role: "physical" },
  { id: "scarf_spec", nature: "Modest", evs: { hp: 4, spa: 252, spe: 252 }, role: "special" }
];

function generationFromFormat(format: string): number {
  const match = String(format ?? "").match(/\[Gen\s*(\d+)\]/i);
  const parsed = Number.parseInt(match?.[1] ?? "9", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 9;
}

function calcGen(genNum: number) {
  return calcGens.get(genNum as Parameters<typeof calcGens.get>[0]);
}

function dataGen(genNum: number) {
  return dataGens.get(genNum as Parameters<typeof dataGens.get>[0]);
}

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
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

function topRecordNames(record: Record<string, number>, limit: number) {
  return Object.entries(record ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

function smoothedShare(record: Record<string, number>, value: string | null, battlesSeen: number, candidateCount: number) {
  if (!value) return 1 / Math.max(1, candidateCount);
  const count = record[value] ?? 0;
  return (count + 1) / Math.max(1, battlesSeen + candidateCount);
}

function totalRecordedCounts(record: Record<string, number>) {
  return Object.values(record ?? {}).reduce((sum, count) => sum + count, 0);
}

function combinedSmoothedShare(params: {
  observedRecord: Record<string, number>;
  observedSamples: number;
  curatedRecord: Record<string, number>;
  curatedSamples: number;
  value: string | null;
  candidateCount: number;
}) {
  const observedWeight = params.observedSamples > 0 && totalRecordedCounts(params.observedRecord) > 0 ? 1 : 0;
  const curatedWeight = params.curatedSamples > 0 && totalRecordedCounts(params.curatedRecord) > 0 ? CURATED_PRIOR_WEIGHT : 0;
  const totalWeight = observedWeight + curatedWeight;
  if (totalWeight <= 0) return 1 / Math.max(1, params.candidateCount);
  const observedShare = observedWeight > 0
    ? smoothedShare(params.observedRecord, params.value, params.observedSamples, params.candidateCount)
    : 0;
  const curatedShare = curatedWeight > 0
    ? smoothedShare(params.curatedRecord, params.value, params.curatedSamples, params.candidateCount)
    : 0;
  return ((observedShare * observedWeight) + (curatedShare * curatedWeight)) / totalWeight;
}

function combinedTopRecordNames(records: Array<Record<string, number>>, limit: number) {
  const combined = new Map<string, number>();
  for (const record of records) {
    for (const [name, count] of Object.entries(record ?? {})) {
      combined.set(name, (combined.get(name) ?? 0) + count);
    }
  }
  return [...combined.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

function uniqueNames(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = normalizeName(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function mapWeather(weather: string | null | undefined) {
  const normalized = String(weather ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("sun")) return "Sun";
  if (normalized.includes("rain")) return "Rain";
  if (normalized.includes("sand")) return "Sand";
  if (normalized.includes("snow")) return "Snow";
  if (normalized.includes("hail")) return "Hail";
  return undefined;
}

function mapTerrain(terrain: string | null | undefined) {
  const normalized = String(terrain ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("electric")) return "Electric";
  if (normalized.includes("grassy")) return "Grassy";
  if (normalized.includes("misty")) return "Misty";
  if (normalized.includes("psychic")) return "Psychic";
  return undefined;
}

function sideFromConditions(conditions: string[]) {
  const normalized = conditions.map((value) => String(value).trim().toLowerCase());
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

function buildField(fieldState: BattleSnapshot["field"], attackerSide: "your" | "opponent") {
  const yourSide = sideFromConditions(fieldState.yourSideConditions);
  const opponentSide = sideFromConditions(fieldState.opponentSideConditions);
  const field: Record<string, unknown> = {
    gameType: "Singles",
    attackerSide: attackerSide === "your" ? yourSide : opponentSide,
    defenderSide: attackerSide === "your" ? opponentSide : yourSide
  };
  const weather = mapWeather(fieldState.weather);
  const terrain = mapTerrain(fieldState.terrain);
  if (weather) field.weather = weather;
  if (terrain) field.terrain = terrain;
  if (fieldState.pseudoWeather.some((value) => /gravity/i.test(value))) field.isGravity = true;
  return new Field(field as ConstructorParameters<typeof Field>[0]);
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

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized && normalized !== "fnt" ? normalized : undefined;
}

function natureMultiplier(stat: Exclude<StatId, "hp">, nature: string) {
  const loweredRaised: Record<string, { up?: Exclude<StatId, "hp">; down?: Exclude<StatId, "hp"> }> = {
    Adamant: { up: "atk", down: "spa" },
    Modest: { up: "spa", down: "atk" },
    Jolly: { up: "spe", down: "spa" },
    Timid: { up: "spe", down: "atk" },
    Bold: { up: "def", down: "atk" },
    Calm: { up: "spd", down: "atk" },
    Impish: { up: "def", down: "spa" },
    Careful: { up: "spd", down: "spa" },
    Serious: {}
  };
  const mapping = loweredRaised[nature] ?? {};
  if (mapping.up === stat) return 1.1;
  if (mapping.down === stat) return 0.9;
  return 1;
}

function estimateHpStat(base: number, level: number, ev: number) {
  const evContribution = Math.floor(ev / 4);
  return Math.floor(((2 * base + 31 + evContribution) * level) / 100) + level + 10;
}

function estimateNonHpStat(base: number, level: number, ev: number, nature: number) {
  const evContribution = Math.floor(ev / 4);
  const core = Math.floor(((2 * base + 31 + evContribution) * level) / 100) + 5;
  return Math.floor(core * nature);
}

function createPokemonForCalc(params: {
  format: string;
  snapshotMon: PokemonSnapshot;
  side: "your" | "opponent";
  category: "Physical" | "Special";
  hypothesis?: PosteriorHypothesis | undefined;
}) {
  const genNum = generationFromFormat(params.format);
  const speciesName = params.snapshotMon.species ?? params.snapshotMon.displayName;
  if (!speciesName) return null;
  const gen = dataGen(genNum);
  const species = lookupSpecies(gen, speciesName);
  if (!species) return null;
  const level = normalizedBattleLevel(params.format, params.snapshotMon.level);
  const config: Record<string, unknown> = {
    level,
    boosts: calcBoosts(params.snapshotMon.boosts)
  };
  const hypothesis = params.hypothesis;
  if (hypothesis) {
    config.evs = hypothesis.evs;
    config.nature = hypothesis.nature;
    if (!params.snapshotMon.removedItem && hypothesis.item) config.item = hypothesis.item;
    if (hypothesis.ability) config.ability = hypothesis.ability;
    if (params.snapshotMon.terastallized && params.snapshotMon.teraType) {
      config.teraType = params.snapshotMon.teraType;
    }
  } else {
    config.item = params.snapshotMon.item ?? undefined;
    config.ability = params.snapshotMon.ability ?? undefined;
    if (params.snapshotMon.terastallized && params.snapshotMon.teraType) config.teraType = params.snapshotMon.teraType;
  }
  const status = normalizeStatus(params.snapshotMon.status);
  if (status) config.status = status;
  if (params.side === "your" && params.snapshotMon.knownMoves.length > 0) {
    config.moves = params.snapshotMon.knownMoves;
  }

  const pokemon = new Pokemon(calcGen(genNum), species.name, config as ConstructorParameters<typeof Pokemon>[2]);

  if (!hypothesis || params.side === "your") {
    const stats = params.snapshotMon.stats ?? {};
    for (const stat of ["hp", "atk", "def", "spa", "spd", "spe"] as const) {
      if (!Number.isFinite(stats[stat])) continue;
      pokemon.rawStats[stat] = Number(stats[stat]);
      pokemon.stats[stat] = Number(stats[stat]);
    }
  }

  if (hypothesis) {
    const evs = hypothesis.evs;
    pokemon.rawStats.hp = estimateHpStat(species.baseStats.hp, level, evs.hp ?? 0);
    pokemon.stats.hp = pokemon.rawStats.hp;
    for (const stat of ["atk", "def", "spa", "spd", "spe"] as const) {
      const base = species.baseStats[stat];
      const ev = evs[stat] ?? 0;
      const nature = natureMultiplier(stat, hypothesis.nature);
      const value = estimateNonHpStat(base, level, ev, nature);
      pokemon.rawStats[stat] = value;
      pokemon.stats[stat] = value;
    }
  }

  if (Number.isFinite(params.snapshotMon.hpPercent)) {
    const currentHp = Math.max(1, Math.floor((pokemon.rawStats.hp * Number(params.snapshotMon.hpPercent)) / 100));
    pokemon.originalCurHP = Math.min(currentHp, pokemon.rawStats.hp);
  }

  return pokemon;
}

function flattenDamageRolls(damage: unknown): number[] {
  if (Array.isArray(damage)) {
    return damage.flatMap((entry) =>
      Array.isArray(entry)
        ? [entry.reduce((sum, value) => sum + Number(value), 0)]
        : [Number(entry)]
    );
  }
  if (typeof damage === "number") return [damage];
  return [];
}

function damageRangePercent(result: ReturnType<typeof calculate>, defender: Pokemon) {
  const rolls = flattenDamageRolls(result.damage).filter((value) => Number.isFinite(value) && value >= 0);
  if (rolls.length === 0) return null;
  const hp = defender.maxHP();
  if (!Number.isFinite(hp) || hp <= 0) return null;
  return {
    min: (Math.min(...rolls) / hp) * 100,
    max: (Math.max(...rolls) / hp) * 100
  };
}

function isItemKnownImpossible(item: string | null, moves: string[], format: string) {
  if (normalizeName(item) !== "assaultvest") return false;
  const gen = dataGen(generationFromFormat(format));
  return moves.some((moveName) => lookupMoveData(gen, moveName)?.category === "Status");
}

function moveDamageMix(moves: string[], format: string) {
  const gen = dataGen(generationFromFormat(format));
  let physical = 0;
  let special = 0;
  for (const moveName of moves) {
    const move = lookupMoveData(gen, moveName);
    if (move?.category === "Physical") physical += 1;
    if (move?.category === "Special") special += 1;
  }
  return { physical, special };
}

function moveCompatibilityScore(item: string | null, archetype: ArchetypeConfig, moves: string[], format: string) {
  if (isItemKnownImpossible(item, moves, format)) return Number.NEGATIVE_INFINITY;
  const itemId = normalizeName(item);
  const mix = moveDamageMix(moves, format);
  if (itemId === "choiceband" && mix.special > 0 && mix.physical === 0) return Number.NEGATIVE_INFINITY;
  if (itemId === "choicespecs" && mix.physical > 0 && mix.special === 0) return Number.NEGATIVE_INFINITY;
  if (itemId === "choiceband" && archetype.role === "special") return Number.NEGATIVE_INFINITY;
  if (itemId === "choicespecs" && archetype.role === "physical") return Number.NEGATIVE_INFINITY;
  if (itemId === "choicescarf" && !archetype.id.startsWith("scarf_")) return -0.35;
  if (itemId !== "choicescarf" && archetype.id.startsWith("scarf_")) return -0.7;
  if (mix.physical > mix.special && archetype.role === "special") return -1.1;
  if (mix.special > mix.physical && archetype.role === "physical") return -1.1;
  if (mix.physical > 0 && archetype.role === "physical") return 0.35;
  if (mix.special > 0 && archetype.role === "special") return 0.35;
  return 0;
}

function effectiveSpeedForHypothesis(
  format: string,
  opponent: PokemonSnapshot,
  hypothesis: PosteriorHypothesis,
  options: {
    battleSnapshot?: BattleSnapshot | undefined;
    includeCurrentBoardModifiers?: boolean | undefined;
  } = {}
) {
  const genNum = generationFromFormat(format);
  const gen = dataGen(genNum);
  const species = lookupSpecies(gen, opponent.species ?? opponent.displayName);
  if (!species) return null;
  const level = normalizedBattleLevel(format, opponent.level);
  let speed = estimateNonHpStat(species.baseStats.spe, level, hypothesis.evs.spe ?? 0, natureMultiplier("spe", hypothesis.nature));
  if (normalizeName(hypothesis.item) === "choicescarf") speed = Math.floor(speed * 1.5);
  if (normalizeName(hypothesis.item) === "ironball") speed = Math.floor(speed * 0.5);
  if (!options.includeCurrentBoardModifiers) return speed;

  const abilityId = normalizeName(hypothesis.ability);
  speed = Math.floor(speed * speedStageMultiplier(opponent.boosts?.spe ?? 0));
  if (opponent.status === "par" && abilityId !== "quickfeet") {
    speed = Math.floor(speed * paralysisSpeedMultiplier(genNum));
  }
  if (opponent.status && abilityId === "quickfeet") {
    speed = Math.floor(speed * 1.5);
  }
  if (options.battleSnapshot?.field.opponentSideConditions.some((value) => /tailwind/i.test(value))) {
    speed = Math.floor(speed * 2);
  }
  const fieldSpeedRule = matchingFieldSpeedAbilityRule(abilityId, options.battleSnapshot?.field);
  if (fieldSpeedRule) {
    speed = Math.floor(speed * fieldSpeedRule.multiplier);
  }
  return speed;
}

function speedObservationLogScore(format: string, opponent: PokemonSnapshot, hypothesis: PosteriorHypothesis, observation: PosteriorBattleSpeedObservation) {
  const speed = effectiveSpeedForHypothesis(format, opponent, hypothesis);
  if (!Number.isFinite(speed)) return 0;
  if (observation.relation === "first") {
    if (Number(speed) > observation.yourSpeedStat) return Math.log(0.97);
    if (Number(speed) === observation.yourSpeedStat) return Math.log(0.55);
    return Math.log(0.01);
  }
  if (Number(speed) < observation.yourSpeedStat) return Math.log(0.97);
  if (Number(speed) === observation.yourSpeedStat) return Math.log(0.55);
  return Math.log(0.01);
}

function damageObservationLogScore(
  format: string,
  opponent: PokemonSnapshot,
  hypothesis: PosteriorHypothesis,
  observation: PosteriorBattleDamageObservation
) {
  const genNum = generationFromFormat(format);
  const moveData = lookupMoveData(dataGen(genNum), observation.moveName);
  const category = moveData?.category === "Physical" || moveData?.category === "Special" ? moveData.category : null;
  if (!category) return 0;
  const move = new Move(calcGen(genNum), observation.moveName);
  const attacker = observation.direction === "incoming"
    ? createPokemonForCalc({ format, snapshotMon: observation.attacker, side: "opponent", category, hypothesis })
    : createPokemonForCalc({ format, snapshotMon: observation.attacker, side: "your", category });
  const defender = observation.direction === "incoming"
    ? createPokemonForCalc({ format, snapshotMon: observation.defender, side: "your", category })
    : createPokemonForCalc({ format, snapshotMon: observation.defender, side: "opponent", category, hypothesis });
  if (!attacker || !defender) return 0;
  const result = calculate(
    calcGen(genNum),
    attacker,
    defender,
    move,
    buildField(observation.field, observation.direction === "incoming" ? "opponent" : "your")
  );
  const range = damageRangePercent(result, defender);
  if (!range) return 0;
  const observed = observation.percent;
  if (observed >= range.min - 2 && observed <= range.max + 2) return Math.log(0.95);
  if (observed >= range.min - 5 && observed <= range.max + 5) return Math.log(0.6);
  if (observed >= range.min - 10 && observed <= range.max + 10) return Math.log(0.2);
  return Math.log(0.03);
}

function inferenceEventLogScore(hypothesis: PosteriorHypothesis, events: InferenceEvent[]): number {
  let logScore = 0;
  const hypothesisItemId = normalizeName(hypothesis.item);
  const hypothesisAbilityId = normalizeName(hypothesis.ability);

  for (const event of events) {
    switch (event.kind) {
      case "attack_recoil": {
        // Life Orb confirmed — strong boost if hypothesis item matches, strong penalty otherwise
        if (hypothesisItemId === "lifeorb") logScore += Math.log(0.97);
        else logScore += Math.log(0.03);
        break;
      }
      case "residual_heal": {
        if (event.source) {
          const sourceId = normalizeName(event.source);
          if (hypothesisItemId === sourceId) logScore += Math.log(0.97);
          else logScore += Math.log(0.05);
        }
        break;
      }
      case "contact_recoil": {
        if (event.source && normalizeName(event.source) === "rockyhelmet") {
          if (hypothesisItemId === "rockyhelmet") logScore += Math.log(0.97);
          else logScore += Math.log(0.05);
        }
        // Rough Skin / Iron Barbs → ability evidence
        if (event.source && normalizeName(event.source) !== "rockyhelmet") {
          const sourceAbilityId = normalizeName(event.source);
          if (hypothesisAbilityId === sourceAbilityId) logScore += Math.log(0.97);
          else logScore += Math.log(0.1);
        }
        break;
      }
      case "hazard_immunity": {
        // Heavy-Duty Boots explains hazard immunity
        if (hypothesisItemId === "heavydutyboots") logScore += Math.log(0.9);
        // Magic Guard ability also explains it
        else if (hypothesisAbilityId === "magicguard") logScore += Math.log(0.85);
        // Penalty for hypotheses that can't explain it (moderate — could be type immunity)
        else logScore += Math.log(0.3);
        break;
      }
      case "ability_reveal": {
        const eventAbilityId = normalizeName(event.abilityName);
        if (hypothesisAbilityId === eventAbilityId) logScore += Math.log(0.97);
        else logScore += Math.log(0.03);
        break;
      }
      case "item_consumed": {
        // Item was consumed — hypothesis with that item gets a boost,
        // and hypothesis should have null item going forward (handled by candidateItems)
        const eventItemId = normalizeName(event.itemName);
        if (hypothesisItemId === eventItemId) logScore += Math.log(0.95);
        else if (!hypothesis.item) logScore += Math.log(0.5);
        else logScore += Math.log(0.1);
        break;
      }
      case "switch_heal": {
        // Regenerator confirmed
        if (hypothesisAbilityId === "regenerator") logScore += Math.log(0.97);
        else logScore += Math.log(0.03);
        break;
      }
      default:
        break;
    }
  }
  return logScore;
}

function weightedPercentile(values: Array<{ value: number; weight: number }>, percentile: number) {
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

function confidenceTier(topHypotheses: PosteriorHypothesis[], evidenceKinds: PosteriorEvidence["kind"][]) {
  const topWeight = topHypotheses[0]?.weight ?? 0;
  const totalTopTwo = (topHypotheses[0]?.weight ?? 0) + (topHypotheses[1]?.weight ?? 0);
  const topThree = topHypotheses.slice(0, 3);
  const sharedItem = topThree.length >= 2 && Boolean(topThree[0]?.item) && topThree.every((entry) => entry.item === topThree[0]?.item);
  const sharedArchetypePrefix = topThree.length >= 2 && topThree.every((entry) => entry.statArchetype.split("_")[0] === topThree[0]?.statArchetype.split("_")[0]);
  if (evidenceKinds.length >= 2 && (topWeight >= 0.7 || totalTopTwo >= 0.9)) return "strong" as const;
  if ((evidenceKinds.includes("speed") && sharedItem) || (evidenceKinds.includes("damage") && sharedArchetypePrefix)) {
    return "usable" as const;
  }
  if (evidenceKinds.length >= 1 && (topWeight >= 0.45 || totalTopTwo >= 0.75)) return "usable" as const;
  return "thin" as const;
}

function candidateAbilities(opponent: PokemonSnapshot, format: string) {
  if (opponent.ability) return [opponent.ability];
  const gen = dataGen(generationFromFormat(format));
  const species = lookupSpecies(gen, opponent.species ?? opponent.displayName);
  if (!species?.abilities) return [];
  return uniqueNames(Object.values(species.abilities));
}

function candidateItems(opponent: PokemonSnapshot, formatStats: PosteriorFormatStats) {
  if (!opponent.item && opponent.removedItem) return [null];
  if (opponent.item) return [opponent.item];
  return uniqueNames([
    ...combinedTopRecordNames([formatStats.observedItems, formatStats.curatedItems], 4),
    ...DEFAULT_ITEMS
  ]);
}

function candidateTeraTypes(opponent: PokemonSnapshot, format: string, formatStats: PosteriorFormatStats) {
  if (opponent.teraType) return [opponent.teraType];
  const gen = dataGen(generationFromFormat(format));
  const species = lookupSpecies(gen, opponent.species ?? opponent.displayName);
  return uniqueNames([
    ...combinedTopRecordNames([formatStats.observedTeraTypes, formatStats.curatedTeraTypes], 4),
    ...(species?.types ?? [])
  ]);
}

function buildEvidenceSummary(params: {
  opponent: PokemonSnapshot;
  battleEvidence?: PosteriorBattleSpeciesEvidence | undefined;
  formatStats: PosteriorFormatStats;
  inferenceEvents?: InferenceEvent[] | undefined;
}) {
  const evidence: PosteriorEvidence[] = [];
  if (params.formatStats.observedBattlesSeen > 0 || (params.formatStats.curatedTeamCount ?? 0) > 0) {
    const observed = params.formatStats.observedBattlesSeen;
    const curated = params.formatStats.curatedTeamCount ?? 0;
    const parts = [
      observed > 0 ? `${observed} stored battle${observed === 1 ? "" : "s"}` : null,
      curated > 0 ? `${curated} imported sample team${curated === 1 ? "" : "s"}` : null
    ].filter(Boolean);
    evidence.push({
      kind: "priors",
      label: `Species-format priors from ${parts.join(" + ") || "curated support"}`
    });
  }
  if (params.opponent.item || params.opponent.ability || params.opponent.teraType) {
    evidence.push({
      kind: "reveals",
      label: "Active reveals constrain the posterior",
      detail: [params.opponent.item, params.opponent.ability, params.opponent.teraType].filter(Boolean).join(", ")
    });
  } else if (params.opponent.removedItem) {
    evidence.push({
      kind: "reveals",
      label: "Active reveals constrain the posterior",
      detail: `${params.opponent.removedItem} was removed or consumed, so no current held item is assumed`
    });
  }
  if ((params.opponent.knownMoves ?? []).length > 0) {
    evidence.push({
      kind: "moves",
      label: "Revealed move mix shapes role assumptions",
      detail: params.opponent.knownMoves.join(", ")
    });
  }
  if ((params.battleEvidence?.speedObservations.length ?? 0) > 0) {
    evidence.push({
      kind: "speed",
      label: `Clean speed observations: ${params.battleEvidence?.speedObservations.length ?? 0}`
    });
  }
  const damageObservationCount = (params.battleEvidence?.incomingDamage.length ?? 0) + (params.battleEvidence?.outgoingDamage.length ?? 0);
  if (damageObservationCount > 0) {
    evidence.push({
      kind: "damage",
      label: `Clean damage observations: ${damageObservationCount}`
    });
  }
  if (params.inferenceEvents && params.inferenceEvents.length > 0) {
    const kinds = [...new Set(params.inferenceEvents.map((e) => e.kind))];
    evidence.push({
      kind: "inference",
      label: `Inference events: ${params.inferenceEvents.length} (${kinds.join(", ")})`
    });
  }
  return evidence;
}

export function buildOpponentPosterior(params: PosteriorBuildParams): OpponentPosteriorPreview | undefined {
  const speciesName = params.opponent.species ?? params.opponent.displayName;
  if (!speciesName) return undefined;
  const gen = dataGen(generationFromFormat(params.format));
  const species = lookupSpecies(gen, speciesName);
  if (!species) return undefined;

  const abilities = candidateAbilities(params.opponent, params.format);
  const items = candidateItems(params.opponent, params.formatStats);
  const teraTypes = candidateTeraTypes(params.opponent, params.format, params.formatStats);
  const evidence = buildEvidenceSummary(params);
  const evidenceKinds = [...new Set(evidence.map((entry) => entry.kind))];

  const skeletons: SkeletonCandidate[] = [];
  for (const ability of abilities.length > 0 ? abilities : [null]) {
    for (const item of items.length > 0 ? items : [null]) {
      for (const teraType of teraTypes.length > 0 ? teraTypes : [null]) {
        let logScore = 0;
        logScore += Math.log(combinedSmoothedShare({
          observedRecord: params.formatStats.observedAbilities,
          observedSamples: params.formatStats.observedBattlesSeen,
          curatedRecord: params.formatStats.curatedAbilities,
          curatedSamples: params.formatStats.curatedTeamCount ?? 0,
          value: ability,
          candidateCount: Math.max(1, abilities.length)
        }));
        logScore += Math.log(combinedSmoothedShare({
          observedRecord: params.formatStats.observedItems,
          observedSamples: params.formatStats.observedBattlesSeen,
          curatedRecord: params.formatStats.curatedItems,
          curatedSamples: params.formatStats.curatedTeamCount ?? 0,
          value: item,
          candidateCount: Math.max(1, items.length)
        }));
        logScore += Math.log(combinedSmoothedShare({
          observedRecord: params.formatStats.observedTeraTypes,
          observedSamples: params.formatStats.observedBattlesSeen,
          curatedRecord: params.formatStats.curatedTeraTypes,
          curatedSamples: params.formatStats.curatedTeamCount ?? 0,
          value: teraType,
          candidateCount: Math.max(1, teraTypes.length)
        }));
        skeletons.push({ ability, item, teraType, logScore });
      }
    }
  }

  const topSkeletons = skeletons
    .sort((a, b) => b.logScore - a.logScore)
    .slice(0, 24);

  const scoredHypotheses: PosteriorHypothesis[] = [];
  for (const skeleton of topSkeletons) {
    for (const archetype of ARCHETYPES) {
      const compatibility = moveCompatibilityScore(skeleton.item, archetype, params.opponent.knownMoves, params.format);
      if (!Number.isFinite(compatibility)) continue;
      const hypothesis: PosteriorHypothesis = {
        ability: skeleton.ability,
        item: skeleton.item,
        teraType: skeleton.teraType,
        statArchetype: archetype.id,
        weight: 0,
        nature: archetype.nature,
        evs: archetype.evs,
        effectiveSpeed: null,
        support: [
          skeleton.item ? `item ${skeleton.item}` : "item unknown",
          skeleton.ability ? `ability ${skeleton.ability}` : "ability unknown",
          `archetype ${archetype.id.replace(/_/g, " ")}`
        ]
      };
      let logScore = skeleton.logScore + compatibility;
      for (const observation of params.battleEvidence?.speedObservations ?? []) {
        logScore += speedObservationLogScore(params.format, params.opponent, hypothesis, observation);
      }
      for (const observation of params.battleEvidence?.incomingDamage ?? []) {
        logScore += damageObservationLogScore(params.format, params.opponent, hypothesis, observation);
      }
      for (const observation of params.battleEvidence?.outgoingDamage ?? []) {
        logScore += damageObservationLogScore(params.format, params.opponent, hypothesis, observation);
      }
      if (params.inferenceEvents && params.inferenceEvents.length > 0) {
        logScore += inferenceEventLogScore(hypothesis, params.inferenceEvents);
      }
      hypothesis.effectiveSpeed = effectiveSpeedForHypothesis(params.format, params.opponent, hypothesis, {
        battleSnapshot: params.battleSnapshot,
        includeCurrentBoardModifiers: true
      });
      hypothesis.weight = logScore;
      scoredHypotheses.push(hypothesis);
    }
  }

  if (scoredHypotheses.length === 0) return undefined;
  const maxLogScore = Math.max(...scoredHypotheses.map((entry) => entry.weight));
  const normalized = scoredHypotheses
    .map((entry) => ({
      ...entry,
      weight: Math.exp(entry.weight - maxLogScore)
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12);
  const totalWeight = normalized.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const topHypotheses: PosteriorHypothesis[] = normalized.map((entry) => ({
    ...entry,
    weight: Number((entry.weight / totalWeight).toFixed(3))
  }));

  const level = normalizedBattleLevel(params.format, params.opponent.level);
  const statBands: StatPosteriorBand[] = (["atk", "def", "spa", "spd", "spe"] as const).map((stat) => {
    const values = topHypotheses.map((entry) => {
      const nature = natureMultiplier(stat, entry.nature);
      const value = estimateNonHpStat(species.baseStats[stat], level, entry.evs[stat] ?? 0, nature);
      return { value, weight: entry.weight };
    });
    return {
      stat,
      min: weightedPercentile(values, 0.05),
      likelyLow: weightedPercentile(values, 0.25),
      likelyHigh: weightedPercentile(values, 0.75),
      max: weightedPercentile(values, 0.95)
    };
  });

  const tier = confidenceTier(topHypotheses, evidenceKinds);
  return {
    topHypotheses,
    statBands,
    confidenceTier: tier,
    evidenceKinds,
    evidence,
    usedFallback: tier === "thin"
  };
}
