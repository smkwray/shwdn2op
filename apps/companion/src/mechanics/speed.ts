import { Field, Generations, Pokemon, Side } from "@smogon/calc";
import { checkItem, getFinalSpeed } from "@smogon/calc/dist/mechanics/util.js";
import type { BattleSnapshot, PokemonSnapshot } from "../types.js";

export function effectiveSpeedField(field: BattleSnapshot["field"], combatants: Array<PokemonSnapshot | null | undefined>) {
  return combatants.some((mon) => mon && !mon.fainted && ["cloudnine", "airlock"].includes(normalizeId(mon.ability)))
    ? { ...field, weather: null } : field;
}

/** Exact stage/chained-modifier/paralysis rounding, shared by captured and
 * hypothesized stats. Paradox uncertainty is resolved by callers per branch. */
export function effectiveSpeed(
  genNum: number, rawSpeed: number, pokemon: PokemonSnapshot,
  sideConditions: string[], fieldState: BattleSnapshot["field"] | undefined,
  paradoxSpeed = false
): number | null {
  if (normalizeId(pokemon.ability) === "slowstart" && pokemon.slowStartActive === undefined) return null;
  const gen = Generations.get(genNum as Parameters<typeof Generations.get>[0]);
  const ability = gen.abilities.get(normalizeId(pokemon.ability) as Parameters<typeof gen.abilities.get>[0])?.name ?? "";
  const item = gen.items.get(normalizeId(pokemon.item) as Parameters<typeof gen.items.get>[0])?.name ?? "";
  const mon = new Pokemon(gen, normalizeId(pokemon.species) === "ditto" ? "Ditto" : "Pikachu", {
    ability, item, status: pokemon.status ?? "",
    boosts: { spe: pokemon.boosts?.spe ?? 0 },
    abilityOn: normalizeId(ability) === "slowstart" ? pokemon.slowStartActive === true
      : normalizeId(ability) === "unburden" && Boolean(pokemon.unburdenActive) && !pokemon.item
  } as ConstructorParameters<typeof Pokemon>[2]);
  mon.rawStats.spe = rawSpeed;
  if (paradoxSpeed) mon.boostedStat = "spe";
  else delete mon.boostedStat;
  const weather = String(fieldState?.weather ?? "").toLowerCase();
  const terrain = String(fieldState?.terrain ?? "").toLowerCase();
  const field = new Field();
  if (weather.includes("sun")) field.weather = "Sun";
  else if (weather.includes("rain")) field.weather = "Rain";
  else if (weather.includes("sand")) field.weather = "Sand";
  else if (weather.includes("snow")) field.weather = "Snow";
  else if (weather.includes("hail")) field.weather = "Hail";
  if (terrain.includes("electric")) field.terrain = "Electric";
  field.isMagicRoom = fieldState?.pseudoWeather.some((value) => /magic room/i.test(value)) ?? false;
  checkItem(mon, field.isMagicRoom);
  return getFinalSpeed(gen, mon, field, new Side({ isTailwind: sideConditions.some((value) => /tailwind/i.test(value)) }));
}

/** Resolve interval endpoints through the same native rounding as exact Speed.
 * Unobserved activation supplies bounds, never an invented branch probability. */
export function effectiveSpeedRange(
  genNum: number, rawRange: { min: number; max: number }, pokemon: PokemonSnapshot,
  sideConditions: string[], fieldState: BattleSnapshot["field"] | undefined
): { min: number; max: number } | null {
  if (![rawRange.min, rawRange.max].every((value) => Number.isFinite(value) && value > 0) || rawRange.min > rawRange.max) return null;
  const ability = normalizeId(pokemon.ability);
  const range = speedAbilityMultiplierRange(ability, fieldState, pokemon.removedItem, pokemon.paradoxBoostedStat, pokemon.slowStartActive);
  const slowStartStates = ability === "slowstart" && pokemon.slowStartActive === undefined ? [false, true] : [pokemon.slowStartActive];
  const paradoxStates = ["protosynthesis", "quarkdrive"].includes(ability) && range.min !== range.max ? [false, true] : [range.min === 1.5];
  const values = [rawRange.min, rawRange.max].flatMap((raw) => slowStartStates.flatMap((slowStartActive) =>
    paradoxStates.map((paradoxSpeed) => effectiveSpeed(genNum, raw, { ...pokemon, slowStartActive }, sideConditions, fieldState, paradoxSpeed))));
  if (values.some((value) => value === null || !Number.isFinite(value))) return null;
  return { min: Math.min(...values as number[]), max: Math.max(...values as number[]) };
}

/**
 * Shared speed mechanics engine.
 *
 * All speed-related modifier rules and primitives live here so that
 * posterior, intel-store, and deterministic-notes stay in sync.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldSpeedAbilityRule {
  abilityId: string;
  label: string;
  multiplier: number;
  weather?: RegExp | undefined;
  terrain?: RegExp | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeId(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FIELD_SPEED_ABILITY_RULES: readonly FieldSpeedAbilityRule[] = [
  // Weather/terrain speed doublers
  { abilityId: "chlorophyll", label: "Chlorophyll", multiplier: 2, weather: /sun/i },
  { abilityId: "sandrush", label: "Sand Rush", multiplier: 2, weather: /sand/i },
  { abilityId: "slushrush", label: "Slush Rush", multiplier: 2, weather: /snow|hail/i },
  { abilityId: "swiftswim", label: "Swift Swim", multiplier: 2, weather: /rain/i },
  { abilityId: "surgesurfer", label: "Surge Surfer", multiplier: 2, terrain: /electric/i },

  // Paradox abilities — 1.5× if Speed is the boosted stat (field-activated path).
  // The actual boost only applies when Speed is the Pokemon's highest raw stat,
  // but we cannot determine that without knowing the full EV spread.  Treating
  // these as possible 1.5× confounders is the safe conservative choice: the
  // existing possibleFieldSpeedAbilityRules path will widen speed ranges rather
  // than assert the boost is active.
  { abilityId: "protosynthesis", label: "Protosynthesis", multiplier: 1.5, weather: /sun/i },
  { abilityId: "quarkdrive", label: "Quark Drive", multiplier: 1.5, terrain: /electric/i }
];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Stat-stage multiplier for Speed.  Accepts null/undefined safely (returns 1).
 */
export function speedStageMultiplier(stage: number | null | undefined): number {
  if (!Number.isFinite(stage)) return 1;
  const numeric = Math.max(-6, Math.min(6, Number(stage)));
  if (numeric === 0) return 1;
  if (numeric > 0) return (2 + numeric) / 2;
  return 2 / (2 + Math.abs(numeric));
}

/**
 * Speed multiplier from paralysis.  Gen 7+ halves speed; earlier gens quarter it.
 * Takes the generation *number* — callers that only have a format string should
 * resolve it first.
 */
export function paralysisSpeedMultiplier(genNum: number): number {
  return genNum >= 7 ? 0.5 : 0.25;
}

/**
 * Unburden belongs to the current active stint. Lifetime item-loss knowledge
 * cannot establish it, and holding a new item prevents its Speed effect.
 */
export function unburdenSpeedMultiplier(
  abilityId: string | null | undefined,
  unburdenActive: boolean | undefined,
  currentItem: string | null | undefined
): number {
  if (normalizeId(abilityId) === "unburden" && unburdenActive && !currentItem) return 2;
  return 1;
}

/**
 * Activated ability multiplier bounds. Paradox activation alone does not
 * identify the boosted stat: retain both unboosted and boosted Speed unless
 * the protocol (or a particular set hypothesis) establishes which stat won.
 * An explicit null means the activation ended; absent capture stays uncertain.
 */
export function speedAbilityMultiplierRange(
  abilityId: string | null | undefined,
  field: { weather?: string | null; terrain?: string | null } | null | undefined,
  removedItem: string | null | undefined,
  paradoxBoostedStat?: string | null,
  slowStartActive?: boolean
): { min: number; max: number } {
  const ability = normalizeId(abilityId);
  if (ability === "slowstart") return slowStartActive === undefined
    ? { min: 0.5, max: 1 }
    : { min: slowStartActive ? 0.5 : 1, max: slowStartActive ? 0.5 : 1 };
  const fieldRule = matchingFieldSpeedAbilityRule(ability, field);
  if (ability !== "protosynthesis" && ability !== "quarkdrive") {
    const multiplier = fieldRule?.multiplier ?? 1;
    return { min: multiplier, max: multiplier };
  }
  if (paradoxBoostedStat !== undefined) {
    const multiplier = paradoxBoostedStat === "spe" ? 1.5 : 1;
    return { min: multiplier, max: multiplier };
  }
  const possiblyActive = Boolean(fieldRule) || normalizeId(removedItem) === "boosterenergy";
  return { min: 1, max: possiblyActive ? 1.5 : 1 };
}

export function matchingFieldSpeedAbilityRule(
  abilityId: string | null | undefined,
  field: { weather?: string | null; terrain?: string | null } | null | undefined
): FieldSpeedAbilityRule | null {
  if (!field) return null;
  const normalized = normalizeId(abilityId);
  if (!normalized) return null;
  const weather = String(field.weather ?? "");
  const terrain = String(field.terrain ?? "");
  return FIELD_SPEED_ABILITY_RULES.find((rule) =>
    rule.abilityId === normalized
    && (!rule.weather || rule.weather.test(weather))
    && (!rule.terrain || rule.terrain.test(terrain))
  ) ?? null;
}
