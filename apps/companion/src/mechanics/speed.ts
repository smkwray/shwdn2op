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
 * Returns the matching field-speed ability rule if the ability + field
 * combination triggers a speed multiplier, or null otherwise.
 *
 * `abilityId` is normalized internally — callers may pass either a raw
 * display name (e.g. "Sand Rush") or a pre-normalized id ("sandrush").
 *
 * `field` only needs `weather` and `terrain` properties; extra keys
 * (e.g. `pseudoWeather`, side conditions) are ignored.
 */
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
