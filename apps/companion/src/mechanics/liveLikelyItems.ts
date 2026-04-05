import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import type { InferenceEvent, LikelihoodEntry, PokemonSnapshot } from "../types.js";

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

/**
 * Check if a specific hazard's damage can be explained by the mon's types or
 * known ability, meaning item-based immunity (Boots) is NOT the only
 * explanation.
 *
 * - Stealth Rock: damages all types (amount varies), only Magic Guard prevents
 * - Spikes: only affects grounded mons — Flying type or Levitate makes immune
 * - Toxic Spikes: only affects grounded mons, Poison type absorbs, Steel
 *   type is immune to poison, Flying/Levitate makes immune
 */
function hazardExplainedByTypesOrAbility(
  hazard: string,
  monTypes: string[],
  knownAbility: string | null | undefined
): boolean {
  const hId = normalizeName(hazard);
  const types = new Set(monTypes.map((t) => normalizeName(t)));
  const abilityId = normalizeName(knownAbility);

  // Magic Guard prevents all hazard damage
  if (abilityId === "magicguard") return true;

  if (hId === "stealthrock") {
    // SR damages all types — only Magic Guard (checked above) or Boots prevents
    return false;
  }

  if (hId === "spikes") {
    // Flying type or Levitate → non-grounded, immune to Spikes
    if (types.has("flying")) return true;
    if (abilityId === "levitate") return true;
    return false;
  }

  if (hId === "toxicspikes") {
    // Flying type or Levitate → non-grounded, immune
    if (types.has("flying")) return true;
    if (abilityId === "levitate") return true;
    // Poison type absorbs Toxic Spikes (no damage)
    if (types.has("poison")) return true;
    // Steel type is immune to poison status
    if (types.has("steel")) return true;
    return false;
  }

  // Unknown hazard — can't explain
  return false;
}

type LiveLikelyItemContext = {
  recentLog?: string[] | undefined;
  inferenceEvents?: InferenceEvent[] | undefined;
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

  // Inference-event-based filtering: if events prove a specific item, only
  // that item survives.  If events prove hazard immunity with no other
  // explanation, filter to items that explain it.
  const events = context.inferenceEvents;
  if (Array.isArray(events) && events.length > 0) {
    const monEvents = events.filter((e) =>
      normalizeName(e.species) === normalizeName(pokemon.species ?? pokemon.displayName)
    );

    // attack_recoil from Life Orb → item IS Life Orb
    if (monEvents.some((e) => e.kind === "attack_recoil")) {
      return itemId === "lifeorb";
    }

    // residual_heal with known source → item IS that source
    const healEvent = monEvents.find((e) => e.kind === "residual_heal" && e.source);
    if (healEvent && healEvent.kind === "residual_heal" && healEvent.source) {
      return itemId === normalizeName(healEvent.source);
    }

    // self_inflicted_status → item IS the orb (Flame Orb for brn, Toxic Orb for tox)
    const statusEvent = monEvents.find((e) => e.kind === "self_inflicted_status");
    if (statusEvent && statusEvent.kind === "self_inflicted_status") {
      const orbItem = statusEvent.status === "brn" ? "flameorb" : statusEvent.status === "tox" ? "toxicorb" : null;
      if (orbItem) return itemId === orbItem;
    }

    // contact_recoil from Rocky Helmet → item IS Rocky Helmet (only if item-sourced)
    const contactEvent = monEvents.find(
      (e) => e.kind === "contact_recoil" && e.source && normalizeName(e.source) === "rockyhelmet"
    );
    if (contactEvent) {
      return itemId === "rockyhelmet";
    }

    // hazard_immunity → filter to items that explain no hazard damage,
    // BUT only when the mon's types/ability don't already explain it.
    if (monEvents.some((e) => e.kind === "hazard_immunity")) {
      const hazardEvents = monEvents.filter((e) => e.kind === "hazard_immunity") as Array<
        Extract<InferenceEvent, { kind: "hazard_immunity" }>
      >;

      // Check if types/ability already explain ALL hazard immunities.
      // If so, no item evidence — don't filter.
      const typesExplainAll = hazardEvents.every((e) =>
        e.hazards.every((h) => hazardExplainedByTypesOrAbility(h, e.monTypes, pokemon.ability))
      );
      if (typesExplainAll) {
        return true; // no item conclusion from this evidence
      }

      // Some hazards can't be explained by type/ability → item needed
      const hazardImmunityItems = new Set(["heavydutyboots"]);
      const allHazardsToxicSpikesOnly = hazardEvents.every(
        (e) => e.hazards.length > 0 && e.hazards.every((h) => normalizeName(h) === "toxicspikes")
      );
      if (allHazardsToxicSpikesOnly) {
        hazardImmunityItems.add("safetygoggles");
      }
      return hazardImmunityItems.has(itemId);
    }
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
