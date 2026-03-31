import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import type { LikelihoodEntry, PokemonSnapshot } from "../types.js";

const gens = new Generations(Dex as any);

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function generationFromFormat(format: string): number {
  const match = String(format ?? "").match(/\[Gen\s*(\d+)\]/i);
  const parsed = Number.parseInt(match?.[1] ?? "9", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 9;
}

function dataGen(format: string) {
  return gens.get(generationFromFormat(format) as Parameters<Generations["get"]>[0]);
}

function lookupMove(format: string, moveName: string | null | undefined) {
  if (!moveName) return undefined;
  const gen = dataGen(format);
  const direct = gen.moves.get(moveName);
  if (direct) return direct;
  const normalized = normalizeName(moveName);
  for (const move of gen.moves) {
    if (normalizeName(move.name) === normalized) return move;
  }
  return undefined;
}

function revealedDistinctMoveCount(pokemon: PokemonSnapshot | null | undefined) {
  return new Set((pokemon?.knownMoves ?? []).map((moveName) => normalizeName(moveName)).filter(Boolean)).size;
}

function itemStillLive(format: string, pokemon: PokemonSnapshot | null | undefined, itemName: string | null | undefined) {
  if (!pokemon || !itemName) return false;
  if (pokemon.item || pokemon.removedItem) return false;

  const itemId = normalizeName(itemName);
  if (!itemId) return false;

  if (["choicescarf", "choiceband", "choicespecs"].includes(itemId) && revealedDistinctMoveCount(pokemon) >= 2) {
    return false;
  }

  if (itemId === "assaultvest") {
    const hasRevealedStatusMove = (pokemon.knownMoves ?? []).some((moveName) => lookupMove(format, moveName)?.category === "Status");
    if (hasRevealedStatusMove) return false;
  }

  return true;
}

export function filterLiveLikelyHeldItemEntries(
  format: string,
  pokemon: PokemonSnapshot | null | undefined,
  likelyItems: LikelihoodEntry[] | undefined
) {
  if (!pokemon || pokemon.item || (!pokemon.item && pokemon.removedItem)) return [];
  return (likelyItems ?? []).filter((entry) => itemStillLive(format, pokemon, entry.name));
}

export function filterLiveLikelyHeldItemNames(
  format: string,
  pokemon: PokemonSnapshot | null | undefined,
  likelyItems: string[] | undefined
) {
  if (!pokemon || pokemon.item || (!pokemon.item && pokemon.removedItem)) return [];
  return (likelyItems ?? []).filter((itemName) => itemStillLive(format, pokemon, itemName));
}
