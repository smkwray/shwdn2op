import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import pokemonSeed from "./data/pokemon.seed.json" with { type: "json" };

const gens = new Generations(Dex as any);
const gen9 = gens.get(9);

const curatedPokemonData = pokemonSeed as Record<string, {
  types: string[];
  roles: string[];
  commonItems: string[];
  commonMoves: string[];
  commonTeraTypes: string[];
}>;

export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findCuratedPokemon(name: string) {
  const normalized = normalizeName(name);
  for (const [key, value] of Object.entries(curatedPokemonData)) {
    if (normalizeName(key) === normalized) return { name: key, ...value };
  }
  return null;
}

function findDexSpecies(name: string) {
  const direct = gen9.species.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const species of gen9.species) {
    if (normalizeName(species.name) === normalized) return species;
  }
  return undefined;
}

function findDexMove(name: string) {
  const direct = gen9.moves.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const move of gen9.moves) {
    if (normalizeName(move.name) === normalized) return move;
  }
  return undefined;
}

function typeMultiplier(attackingType: string, defendingType: string) {
  const atk = gen9.types.get(attackingType);
  if (!atk) return null;
  const effectiveness = atk.effectiveness as Record<string, number | undefined>;
  const multiplier = effectiveness?.[defendingType];
  return typeof multiplier === "number" ? multiplier : null;
}

export function findPokemon(name: string) {
  const species = findDexSpecies(name);
  const curated = findCuratedPokemon(name);

  if (!species && !curated) return null;

  return {
    name: species?.name ?? curated?.name ?? name,
    types: species?.types ?? curated?.types ?? [],
    roles: curated?.roles ?? [],
    commonItems: curated?.commonItems ?? [],
    commonMoves: curated?.commonMoves ?? [],
    commonTeraTypes: curated?.commonTeraTypes ?? [],
    tier: species?.tier ?? null,
    baseStats: species?.baseStats ?? null,
    weightkg: species?.weightkg ?? null
  };
}

export function findMove(name: string) {
  const move = findDexMove(name);
  if (!move) return null;
  return {
    name: move.name,
    type: move.type,
    category: move.category,
    power: move.basePower ?? null,
    accuracy: move.accuracy ?? null,
    priority: move.priority ?? 0,
    target: move.target ?? null
  };
}

export function effectivenessFor(attackingType: string, defendingTypes: string[]) {
  const atk = gen9.types.get(attackingType);
  if (!atk) {
    return {
      multiplier: null,
      details: [`Unknown attacking type: ${attackingType}`]
    };
  }

  let multiplier = 1;
  const details: string[] = [];

  for (const defendingType of defendingTypes) {
    const value = typeMultiplier(attackingType, defendingType);
    if (typeof value !== "number") {
      details.push(`Unknown defending type: ${defendingType}`);
      continue;
    }
    multiplier *= value;
    details.push(`${attackingType} -> ${defendingType} = ${value}x`);
  }

  return { multiplier, details };
}
