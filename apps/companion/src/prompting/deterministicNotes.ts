import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import type { BattleSnapshot } from "../types.js";
import { buildDamageNotes } from "./damageNotes.js";

const gens = new Generations(Dex as any);

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function generationFromFormat(format: string): number {
  const match = String(format ?? "").match(/\[Gen\s*(\d+)\]/i);
  const parsed = Number.parseInt(match?.[1] ?? "9", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 9;
}

function lookupSpecies(gen: ReturnType<Generations["get"]>, name: string | null | undefined) {
  if (!name) return undefined;
  const direct = gen.species.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const species of gen.species) {
    if (normalizeName(species.name) === normalized) return species;
  }
  return undefined;
}

function lookupMove(gen: ReturnType<Generations["get"]>, name: string | null | undefined) {
  if (!name) return undefined;
  const direct = gen.moves.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const move of gen.moves) {
    if (normalizeName(move.name) === normalized) return move;
  }
  return undefined;
}

function typeMultiplier(
  gen: ReturnType<Generations["get"]>,
  attackingType: string,
  defendingTypes: string[]
) {
  if (!defendingTypes.length) return null;
  return gen.types.totalEffectiveness(attackingType as any, defendingTypes as any);
}

function currentBattleTypes(
  pokemon: BattleSnapshot["yourSide"]["active"] | BattleSnapshot["opponentSide"]["active"],
  dexTypes: string[] | undefined
) {
  if (!pokemon) return dexTypes ?? [];
  if (pokemon.terastallized && pokemon.teraType) {
    return [pokemon.teraType];
  }
  if (Array.isArray(pokemon.types) && pokemon.types.length > 0) {
    return pokemon.types;
  }
  return dexTypes ?? [];
}

function formatKnownStats(stats: Record<string, number> | undefined) {
  if (!stats || Object.keys(stats).length === 0) return null;
  const ordered = ["hp", "atk", "def", "spa", "spd", "spe"]
    .filter((key) => Number.isFinite(stats[key]))
    .map((key) => `${key.toUpperCase()} ${stats[key]}`);
  return ordered.length > 0 ? ordered.join(", ") : null;
}

function estimateNonHpStat(base: number, level: number, ev: number, nature: number) {
  const evContribution = Math.floor(ev / 4);
  const core = Math.floor(((2 * base + 31 + evContribution) * level) / 100) + 5;
  return Math.floor(core * nature);
}

function speedRangeForSpecies(
  species: ReturnType<ReturnType<Generations["get"]>["species"]["get"]>,
  level: number | null | undefined
) {
  if (!species || !Number.isFinite(level)) return null;
  const spe = species.baseStats?.spe;
  if (!Number.isFinite(spe)) return null;
  const actualLevel = Number(level);
  return {
    min: estimateNonHpStat(spe, actualLevel, 0, 0.9),
    max: estimateNonHpStat(spe, actualLevel, 252, 1.1),
    base: spe
  };
}

function speedStageMultiplier(stage: number) {
  if (stage === 0) return 1;
  if (stage > 0) return (2 + stage) / 2;
  return 2 / (2 + Math.abs(stage));
}

function paralysisSpeedMultiplier(genNum: number) {
  return genNum >= 7 ? 0.5 : 0.25;
}

function sideHasCondition(conditions: string[], pattern: RegExp) {
  return conditions.some((value) => pattern.test(value));
}

function effectiveSpeedRange(
  genNum: number,
  range: { min: number; max: number } | null,
  pokemon: BattleSnapshot["yourSide"]["active"] | BattleSnapshot["opponentSide"]["active"] | null,
  sideConditions: string[]
) {
  if (!range || !pokemon) return null;
  let multiplier = speedStageMultiplier(Number(pokemon.boosts?.spe ?? 0));
  if (pokemon.status === "par" && pokemon.ability !== "Quick Feet") {
    multiplier *= paralysisSpeedMultiplier(genNum);
  }
  if (pokemon.status && pokemon.ability === "Quick Feet") {
    multiplier *= 1.5;
  }
  if (pokemon.item === "Choice Scarf") {
    multiplier *= 1.5;
  }
  if (pokemon.item === "Iron Ball") {
    multiplier *= 0.5;
  }
  if (sideHasCondition(sideConditions, /tailwind/i)) {
    multiplier *= 2;
  }
  return {
    min: Math.floor(range.min * multiplier),
    max: Math.floor(range.max * multiplier)
  };
}

function effectiveShownSpeed(
  genNum: number,
  pokemon: BattleSnapshot["yourSide"]["active"] | BattleSnapshot["opponentSide"]["active"] | null,
  sideConditions: string[]
) {
  const shown = pokemon?.stats?.spe;
  if (!Number.isFinite(shown)) return null;
  return effectiveSpeedRange(genNum, { min: Number(shown), max: Number(shown) }, pokemon, sideConditions);
}

export function buildDeterministicNotes(snapshot: BattleSnapshot): string[] {
  const genNum = generationFromFormat(snapshot.format);
  const gen = gens.get(genNum);
  const yourActive = snapshot.yourSide.active;
  const opponentActive = snapshot.opponentSide.active;
  const yourSpecies = lookupSpecies(gen, yourActive?.species ?? yourActive?.displayName);
  const opponentSpecies = lookupSpecies(gen, opponentActive?.species ?? opponentActive?.displayName);
  const yourActiveTypes = currentBattleTypes(yourActive, yourSpecies?.types);
  const opponentActiveTypes = currentBattleTypes(opponentActive, opponentSpecies?.types);
  const yourRemaining = snapshot.yourSide.team.filter((pokemon) => !pokemon.fainted).length;
  const opponentRemaining = snapshot.opponentSide.team.filter((pokemon) => !pokemon.fainted).length;
  const opponentRevealed = snapshot.opponentSide.team.filter((pokemon) => pokemon.revealed).length;
  const yourKnownStats = formatKnownStats(yourActive?.stats);
  const opponentSpeedRange = speedRangeForSpecies(opponentSpecies, opponentActive?.level);
  const yourEffectiveSpeed = effectiveShownSpeed(genNum, yourActive, snapshot.field.yourSideConditions);
  const opponentEffectiveSpeed = effectiveSpeedRange(genNum, opponentSpeedRange, opponentActive, snapshot.field.opponentSideConditions);
  const trickRoomActive = snapshot.field.pseudoWeather.some((value) => /trick room/i.test(value));

  const lines: string[] = [];
  lines.push(`Format context: ${snapshot.format}.`);
  lines.push(
    `Known remaining Pokemon: your side ${yourRemaining}/${snapshot.yourSide.team.length}; opponent revealed remaining ${opponentRemaining}/${snapshot.opponentSide.team.length} (revealed roster count ${opponentRevealed}).`
  );

  if (yourSpecies) {
    lines.push(
      `Your active ${yourSpecies.name}: current typing ${yourActiveTypes.join("/") || "unknown"}${yourActive?.terastallized && yourActive?.teraType ? ` after Terastallizing to ${yourActive.teraType}` : ""}; listed tier ${yourSpecies.tier}.`
    );
    if (yourKnownStats) {
      lines.push(`Your active live stats from request: ${yourKnownStats}.`);
    }
  }

  if (opponentSpecies) {
    lines.push(
      `Opponent active ${opponentSpecies.name}: current typing ${opponentActiveTypes.join("/") || "unknown"}${opponentActive?.terastallized && opponentActive?.teraType ? ` after Terastallizing to ${opponentActive.teraType}` : ""}; listed tier ${opponentSpecies.tier}.`
    );
    if (opponentSpeedRange) {
      const yourSpeed = snapshot.yourSide.active?.stats?.spe;
      lines.push(
        `Opponent active ${opponentSpecies.name}: base Spe ${opponentSpeedRange.base}, estimated non-boosted speed range at level ${opponentActive?.level ?? "unknown"} is roughly ${opponentSpeedRange.min}-${opponentSpeedRange.max}${Number.isFinite(yourSpeed) ? `; compare against your shown ${yourSpeed} Spe.` : "."}`
      );
    }
  }

  if (yourEffectiveSpeed && opponentEffectiveSpeed) {
    lines.push(
      `Current speed state: your active is effectively around ${yourEffectiveSpeed.min}-${yourEffectiveSpeed.max} Spe after current boosts/status/side conditions; opponent active is roughly ${opponentEffectiveSpeed.min}-${opponentEffectiveSpeed.max}. ${trickRoomActive ? "Trick Room is active, so slower effective Speed moves first." : "Trick Room is inactive, so faster effective Speed moves first."}`
    );
  } else if (trickRoomActive) {
    lines.push("Current speed state: Trick Room is active, so slower effective Speed moves first.");
  }

  if (snapshot.field.yourSideConditions.length > 0 || snapshot.field.opponentSideConditions.length > 0) {
    lines.push(
      `Hazards and side conditions: your side [${snapshot.field.yourSideConditions.join(", ") || "none"}], opponent side [${snapshot.field.opponentSideConditions.join(", ") || "none"}].`
    );
  }

  if (opponentSpecies) {
    const damageNotes = buildDamageNotes(snapshot);
    if (damageNotes.length > 0) {
      lines.push(...damageNotes);
    } else {
      for (const action of snapshot.legalActions) {
        if (action.kind !== "move") continue;
        const move = lookupMove(gen, action.moveName ?? action.label);
        if (!move) continue;
        const multiplier = typeMultiplier(gen, move.type, opponentActiveTypes);
        const matchup = multiplier === null ? "unknown effectiveness" : `${multiplier}x effectiveness`;
        lines.push(
          `Legal move ${action.label}: ${move.type} ${move.category}, base power ${move.basePower}, ${matchup} into ${opponentSpecies.name}.`
        );
      }
    }
  }

  for (const action of snapshot.legalActions) {
    if (action.kind !== "switch") continue;
    const speciesName = action.target?.split(": ").at(-1) ?? action.label.replace(/^Switch to\s+/i, "");
    const species = lookupSpecies(gen, speciesName);
    if (!species) continue;
    lines.push(`Switch target ${species.name}: ${species.types.join("/")} typing; listed tier ${species.tier}.`);
  }

  return lines.slice(0, 12);
}
