import { Dex } from "@pkmn/dex";
import type { BattleSnapshot, PokemonSnapshot, DamageAssumptionBand } from "../types.js";
import { exactSnapshotHp } from "./calcPokemon.js";

const id = (value: string | null | undefined) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Heavy-Duty Boots is the only item that stops entry hazards, so an entry they did not affect proves it unless a cause the
 * Pokémon may have explains it: Magic Guard (damage), Flying type, Levitate or Gravity (grounding), typing, a blocking
 * ability, Safeguard or Misty Terrain (Toxic Spikes). Magic Room voids items, and any HP loss on entry rules Boots out.
 * Callers pass a complete, identity-resolved entry of a Pokémon whose item is still unknown. Returns the proving hazard. */
export function bootsProvenByEntry(entry: { species: string; hazards: string[]; types: string[]; damaged: boolean; statused: boolean; statusAtEntry: boolean },
  ability: string | null, field: { magicRoom: boolean; gravity: boolean; mistyTerrain: boolean }, generation = 9): string | null {
  const species = Dex.forGen(generation).species.get(entry.species);
  if (field.magicRoom || entry.damaged || !species.exists) return null;
  const abilities = ability ? [id(ability)] : Object.values(species.abilities).map(id);
  const may = (...names: string[]) => abilities.some((value) => names.includes(value));
  const hazards = new Set(entry.hazards.map(id)), types = new Set((entry.types.length ? entry.types : species.types).map(id));
  const grounded = field.gravity || (!types.has("flying") && !may("levitate"));
  if (!may("magicguard") && hazards.has("stealthrock")) return "Stealth Rock";
  if (!may("magicguard") && hazards.has("spikes") && grounded) return "Spikes";
  if (hazards.has("toxicspikes") && grounded && !entry.statused && !entry.statusAtEntry && !types.has("poison") && !types.has("steel")
    && !hazards.has("safeguard") && !field.mistyTerrain && !may("immunity", "pastelveil", "comatose", "purifyingsalt", "leafguard", "shieldsdown", "flowerveil")) return "Toxic Spikes";
  return null;
}

/** Retain explicit unknown rows; unqualified form stats must not leak in detail. */
export function withholdEntryDamage(bands: DamageAssumptionBand[], notes: string[], discardDetail = false): DamageAssumptionBand[] {
  return bands.map((band) => ({ ...band, outcome: undefined, minPercent: null, maxPercent: null,
    immediate: { ko: "unknown", minHpLossPercent: null, maxHpLossPercent: null },
    detail: [discardDetail ? undefined : band.detail, ...notes].filter(Boolean).join(" ") }));
}

/** A hypothetical entry only. Canonical bench HP and stint evidence stay intact.
 * Unknown protection produces a conditional forecast, never a definite KO/order. */
export function projectSwitchEntry(snapshot: BattleSnapshot, original: PokemonSnapshot, side: "your" | "opponent") {
  const pokemon: PokemonSnapshot = { ...original, boosts: {}, unburdenActive: false,
    ...(id(original.ability) === "slowstart" ? { slowStartActive: true } : {}),
    ...(["protosynthesis", "quarkdrive"].includes(id(original.ability)) ? { paradoxBoostedStat: undefined } : {}) };
  const conditions = side === "your" ? snapshot.field.yourSideConditions : snapshot.field.opponentSideConditions;
  const count = (name: string) => conditions.filter((value) => id(value) === name).length;
  const species = Dex.species.get(original.species ?? original.displayName ?? "");
  const types = original.terastallized && original.teraType && original.teraType !== "Stellar" ? [original.teraType]
    : original.types.length ? original.types : species.types;
  const ability = id(original.ability), item = id(original.item);
  const possibleAbilities = ability ? [ability] : Object.values(species.abilities ?? {}).map(id);
  const mayHave = (...names: string[]) => !ability && (!possibleAbilities.length || possibleAbilities.some((value) => names.includes(value)));
  const itemsSuppressed = ability === "klutz" || snapshot.field.pseudoWeather.some((value) => /magic room/i.test(value));
  const itemUnknown = original.item === null && !original.removedItem && !itemsSuppressed;
  const boots = !itemsSuppressed && item === "heavydutyboots";
  const gravity = snapshot.field.pseudoWeather.some((value) => /gravity/i.test(value));
  const ironBall = !itemsSuppressed && item === "ironball";
  const grounded = gravity || ironBall || (!types.includes("Flying") && ability !== "levitate" && (itemsSuppressed || item !== "airballoon"));
  const groundingCertain = gravity || ironBall || types.includes("Flying") || ability === "levitate" || (!itemsSuppressed && item === "airballoon")
    || (!itemUnknown && !mayHave("levitate"));
  const notes: string[] = [];
  let hpCertain = true, speedCertain = true, fraction = 0;
  const rock = !boots && ability !== "magicguard" && count("stealthrock") > 0;
  const spikes = !boots && ability !== "magicguard" && grounded ? Math.min(3, count("spikes")) : 0;
  if (rock || spikes) {
    hpCertain = !itemUnknown && !mayHave("magicguard") && (!spikes || groundingCertain) && types.length > 0;
  }
  const maxHp = Number(original.stats?.hp);
  const currentHp = Number.isInteger(maxHp) && maxHp > 0 ? exactSnapshotHp(original, maxHp) : null;
  const rockFraction = rock && types.length ? Math.pow(2, Dex.getEffectiveness("Rock", types)) / 8 : 0;
  const spikesFraction = spikes === 3 ? 1 / 4 : spikes === 2 ? 1 / 6 : spikes === 1 ? 1 / 8 : 0;
  fraction = rockFraction + spikesFraction;
  let damagePercent = fraction * 100;
  if (fraction > 0) {
    if (currentHp !== null) {
      const chip = (rockFraction ? Math.max(1, Math.floor(maxHp * rockFraction)) : 0)
        + (spikesFraction ? Math.max(1, Math.floor(maxHp * spikesFraction)) : 0);
      const hp = Math.max(0, currentHp - chip);
      pokemon.hpPercent = hp / maxHp * 100;
      pokemon.conditionText = `${hp}/${maxHp}${original.status ? ` ${original.status}` : ""}`;
      pokemon.fainted = hp === 0;
      damagePercent = Math.min(currentHp, chip) * 100 / maxHp;
    } else {
      hpCertain = false;
      pokemon.hpPercent = original.hpPercent === null ? null : Math.max(0, original.hpPercent - damagePercent);
      pokemon.conditionText = null;
    }
    notes.push(`${hpCertain ? "Projected" : "Conditional"} entry hazard damage ${Number(damagePercent.toFixed(2))}%${hpCertain ? "" : "; protection or exact HP is unresolved"}.`);
  }
  const stickyWeb = !boots && grounded && count("stickyweb") > 0;
  if (stickyWeb) {
    speedCertain = !["mirrorarmor", "flowerveil"].includes(ability) && !count("mist") && !itemUnknown && groundingCertain && !mayHave("clearbody", "whitesmoke", "fullmetalbody", "contrary", "simple");
    const blocked = ["clearbody", "whitesmoke", "fullmetalbody"].includes(ability) || (!itemsSuppressed && item === "clearamulet");
    if (!blocked) pokemon.boosts.spe = ability === "contrary" ? 1 : ability === "simple" ? -2 : -1;
    notes.push(blocked ? "Sticky Web Speed drop is blocked on entry." : `${speedCertain ? "Projected" : "Conditional"} Sticky Web entry Speed stage ${pokemon.boosts.spe}.`);
  }
  if (!hpCertain) { speedCertain = false; pokemon.hpPercent = null; pokemon.conditionText = null; pokemon.fainted = false; }
  // Noice can restore Ice Face on entry into reported snow/hail. Its private
  // Noice stats do not determine the restored form's stats without set details.
  // Keep HP/hazard facts, but do not rename it or guess replacement stats.
  const damageQualified = original.active || id(original.species) !== "eiscuenoice"
    || !["snow", "snowscape", "hail"].includes(id(snapshot.field.weather))
    || (ability !== "iceface" && !mayHave("iceface"));
  if (!damageQualified) {
    speedCertain = false;
    notes.push("Entry form is unqualified: Eiscue-Noice may restore Ice Face in reported snow or hail; damage and Speed forecasts are withheld.");
  }
  // A possibly lethal entry also cannot establish a later move-order claim.
  if (pokemon.fainted || (pokemon.hpPercent ?? 100) <= 0) speedCertain = false;
  return { pokemon, damagePercent, stickyWeb: stickyWeb && speedCertain && Boolean(pokemon.boosts.spe && pokemon.boosts.spe < 0), hpCertain, speedCertain, damageQualified,
    fainted: hpCertain && pokemon.fainted, notes };
}
