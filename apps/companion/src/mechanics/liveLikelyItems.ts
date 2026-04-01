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

function namesForPokemon(pokemon: PokemonSnapshot | null | undefined) {
  return [...new Set([pokemon?.displayName, pokemon?.species, pokemon?.ident].map((value) => {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return text.includes(":") ? text.split(":").slice(1).join(":").trim() : text;
  }).filter(Boolean))];
}

function extractEnteredFieldName(line: string) {
  const match = String(line).match(/^(.+?) entered the field\.$/);
  return match?.[1]?.trim() ?? null;
}

function extractUsedMove(line: string) {
  const match = String(line).match(/^(.+?) used (.+)\.$/);
  if (!match) return null;
  return {
    actor: match[1]?.trim() ?? null,
    move: match[2]?.trim() ?? null
  };
}

function actorMatchesPokemonName(actor: string | null | undefined, pokemon: PokemonSnapshot | null | undefined) {
  if (!actor) return false;
  const actorId = normalizeName(actor);
  return namesForPokemon(pokemon).some((name) => normalizeName(name) === actorId);
}

function revealedDistinctMoveCountInCurrentStint(pokemon: PokemonSnapshot | null | undefined, recentLog: string[] | undefined) {
  if (!pokemon || !Array.isArray(recentLog) || recentLog.length === 0) return null;

  let lastEntryIndex = -1;
  for (let index = recentLog.length - 1; index >= 0; index -= 1) {
    const enteredName = extractEnteredFieldName(String(recentLog[index] ?? ""));
    if (actorMatchesPokemonName(enteredName, pokemon)) {
      lastEntryIndex = index;
      break;
    }
  }

  if (lastEntryIndex < 0) return null;

  const revealedMoves = new Set<string>();
  for (const line of recentLog.slice(lastEntryIndex + 1)) {
    const usedMove = extractUsedMove(String(line ?? ""));
    if (!usedMove || !actorMatchesPokemonName(usedMove.actor, pokemon)) continue;
    const moveId = normalizeName(usedMove.move);
    if (moveId) revealedMoves.add(moveId);
  }
  return revealedMoves.size;
}

type LiveLikelyItemContext = {
  recentLog?: string[] | undefined;
};

function itemStillLive(
  format: string,
  pokemon: PokemonSnapshot | null | undefined,
  itemName: string | null | undefined,
  context: LiveLikelyItemContext = {}
) {
  if (!pokemon || !itemName) return false;
  if (pokemon.item || pokemon.removedItem) return false;

  const itemId = normalizeName(itemName);
  if (!itemId) return false;

  if (["choicescarf", "choiceband", "choicespecs"].includes(itemId)) {
    const sameStintMoveCount = revealedDistinctMoveCountInCurrentStint(pokemon, context.recentLog);
    if (sameStintMoveCount !== null && sameStintMoveCount >= 2) {
      return false;
    }
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
  likelyItems: LikelihoodEntry[] | undefined,
  context: LiveLikelyItemContext = {}
) {
  if (!pokemon || pokemon.item || (!pokemon.item && pokemon.removedItem)) return [];
  return (likelyItems ?? []).filter((entry) => itemStillLive(format, pokemon, entry.name, context));
}

export function filterLiveLikelyHeldItemNames(
  format: string,
  pokemon: PokemonSnapshot | null | undefined,
  likelyItems: string[] | undefined,
  context: LiveLikelyItemContext = {}
) {
  if (!pokemon || pokemon.item || (!pokemon.item && pokemon.removedItem)) return [];
  return (likelyItems ?? []).filter((itemName) => itemStillLive(format, pokemon, itemName, context));
}
