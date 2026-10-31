import { calculate, Generations, Pokemon, toID } from "@smogon/calc";
import type { ImmediateDamageAssessment, PokemonSnapshot } from "../types.js";
import { speedStageMultiplier } from "./speed.js";

/** The calculator clones inputs (and some child attackers). Keep captured
 * stats and HP through those clones instead of reconstructing a guessed set. */
export class BattlePokemon extends Pokemon {
  abilityActivationUncertain = false;

  constructor(...[gen, name, options = {}]: ConstructorParameters<typeof Pokemon>) {
    // Private requests use IDs; calculator mechanics compare display names.
    const data = typeof gen === "number" ? Generations.get(gen) : gen;
    super(data, name, { ...options,
      ...(options.ability ? { ability: data.abilities.get(toID(options.ability))?.name ?? options.ability } : {}),
      ...(options.item ? { item: data.items.get(toID(options.item))?.name ?? options.item } : {})
    });
  }

  override clone(): BattlePokemon {
    const copy = super.clone();
    Object.setPrototypeOf(copy, BattlePokemon.prototype);
    copy.rawStats = { ...this.rawStats };
    copy.stats = { ...this.stats };
    copy.originalCurHP = this.originalCurHP;
    copy.types = [...this.types] as Pokemon["types"];
    (copy as BattlePokemon).abilityActivationUncertain = this.abilityActivationUncertain;
    return copy as BattlePokemon;
  }
}

export function applyAbilityState(pokemon: BattlePokemon, snapshot: PokemonSnapshot) {
  if (pokemon.hasAbility("Slow Start")) {
    pokemon.abilityOn = snapshot.slowStartActive === true;
    pokemon.abilityActivationUncertain = snapshot.slowStartActive === undefined;
    return;
  }
  if (!pokemon.hasAbility("Protosynthesis", "Quark Drive")) return;
  // 'auto' selects a stat from this concrete spread, but only activates under
  // the calculator's matching field/item condition. Explicit null stays off.
  if (snapshot.paradoxBoostedStat === null) delete pokemon.boostedStat;
  else pokemon.boostedStat = snapshot.paradoxBoostedStat ?? "auto";
  pokemon.abilityActivationUncertain = snapshot.paradoxBoostedStat === undefined
    && snapshot.removedItem === "Booster Energy" && !pokemon.item;
}

function activationScenarios(pokemon: Pokemon) {
  if (!(pokemon instanceof BattlePokemon) || !pokemon.abilityActivationUncertain) return [pokemon];
  const active = pokemon.clone();
  if (pokemon.hasAbility("Slow Start")) {
    const inactive = pokemon.clone();
    inactive.abilityOn = false;
    active.abilityOn = true;
    return [inactive, active];
  }
  const stats = ["atk", "def", "spa", "spd", "spe"] as const;
  const value = (stat: typeof stats[number]) => Math.floor(active.rawStats[stat] * speedStageMultiplier(active.boosts[stat]));
  active.boostedStat = stats.reduce((best, stat) => value(stat) > value(best) ? stat : best);
  // Item-loss knowledge cannot establish whether activation survived this
  // stint. Retain both scenarios as an interval; do not invent a probability.
  return [pokemon, active];
}

export function calculateDamageScenarios(...[gen, attacker, defender, move, field]: Parameters<typeof calculate>) {
  return activationScenarios(attacker).flatMap((attack) => activationScenarios(defender).map((defense) =>
    calculate(gen, attack, defense, move, field)));
}

/** Use an exact private HP fraction only when its denominator matches known max HP. */
export function exactSnapshotHp(snapshot: PokemonSnapshot, maxHp: number): number | null {
  const match = snapshot.conditionText?.match(/^(\d+)\/(\d+)(?:\s|$)/);
  if (!match || Number(match[2]) !== maxHp) return null;
  const hp = Number(match[1]);
  return hp >= 0 && hp <= maxHp ? hp : null;
}

/** Assess a connecting, immediate hit. HP knowledge must come from the caller,
 * never from the calculator's default full-HP constructor. */
export function assessImmediateDamage(result: ReturnType<typeof calculate>, context: {
  currentHp: number | null;
  maxHp: number | null;
  currentHpRange?: { min: number; max: number };
  sequence: "single_hit" | "unsupported";
  protectionUncertain?: boolean;
  defenderFormUncertain?: boolean;
}): ImmediateDamageAssessment {
  const unknown = (note: string): ImmediateDamageAssessment => ({ ko: "unknown", minHpLossPercent: null, maxHpLossPercent: null, note });
  if (context.sequence !== "single_hit") return unknown("Immediate outcome unavailable for this move sequence.");
  const maxHp = context.maxHp;
  const lowHp = context.currentHpRange?.min ?? context.currentHp;
  const highHp = context.currentHpRange?.max ?? context.currentHp;
  if (maxHp === null || lowHp === null || highHp === null || !Number.isFinite(maxHp) || maxHp <= 0
    || !Number.isFinite(lowHp) || !Number.isFinite(highHp) || lowHp <= 0 || highHp < lowHp || highHp > maxHp) {
    return unknown("Current impact HP is not established.");
  }
  const [min, max] = result.range();
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return unknown("Damage range is unavailable.");
  if (max > 0 && result.defender.hasAbility("Disguise")) {
    const intact = result.defender.named("Mimikyu", "Mimikyu-Totem");
    const busted = result.defender.named("Mimikyu-Busted", "Mimikyu-Busted-Totem");
    if (context.defenderFormUncertain || (!intact && !busted)) return unknown("Disguise's current form is not established.");
    if (intact) {
      if (result.gen.num !== 9 || result.defender.isDynamaxed || min === 0) return unknown("Disguise impact is not qualified for this context.");
      // The resolved calculator ability already accounts for bypass/Ability
      // Shield. Stock damage stays untouched; the native Gen9 form change
      // instead deals floor(base max HP / 8), which can itself cause a KO.
      const chip = Math.floor(maxHp / 8);
      const ko = chip >= highHp ? "all_rolls" : chip < lowHp ? "no_ko" : "conditional";
      return { ko, minHpLossPercent: Math.min(chip, lowHp) / maxHp * 100,
        maxHpLossPercent: Math.min(chip, highHp) / maxHp * 100,
        note: ko === "conditional" ? "Disguise chip KO depends on rounded current HP." : "Intact Disguise absorbs the hit; its form change deals one-eighth max HP, rounded down." };
    }
  }
  // Qualified Gen9 single physical impact; no weather/restoration model.
  if (max > 0 && result.defender.hasAbility("Ice Face") && result.defender.named("Eiscue") && result.move.category === "Physical") {
    if (context.defenderFormUncertain || result.gen.num !== 9 || result.defender.isDynamaxed || min === 0) {
      return unknown("Ice Face impact is not qualified for this context.");
    }
    return { ko: "no_ko", minHpLossPercent: 0, maxHpLossPercent: 0,
      note: "Intact Ice Face absorbs the physical hit and changes form without HP loss." };
  }
  if (((context.protectionUncertain && highHp === maxHp) || result.defender.hasItem("Focus Band")) && max >= lowHp) return { ko: "conditional", minHpLossPercent: null, maxHpLossPercent: null,
    note: "Immediate KO depends on unresolved survival protection." };
  const protection = result.defender.hasAbility("Sturdy") ? "Sturdy" : result.defender.hasItem("Focus Sash") ? "Focus Sash" : null;
  if (protection && lowHp === maxHp && highHp === maxHp) {
    return { ko: "no_ko", minHpLossPercent: Math.min(min, maxHp - 1) / maxHp * 100,
      maxHpLossPercent: Math.min(max, maxHp - 1) / maxHp * 100,
      ...(max >= maxHp ? { note: `${protection} caps a lethal hit at 1 HP.` } : {}) };
  }
  // A rounded HP interval reaching full HP cannot prove protection is inactive.
  if (protection && highHp === maxHp && max >= lowHp) return { ko: "conditional", minHpLossPercent: null, maxHpLossPercent: null,
    note: "Full-HP survival protection depends on unresolved current HP." };
  const ko = min >= highHp ? "all_rolls" : max < lowHp ? "no_ko"
    : min < lowHp && max >= highHp ? "some_rolls" : "conditional";
  return { ko, minHpLossPercent: Math.min(min, lowHp) / maxHp * 100,
    maxHpLossPercent: Math.min(max, highHp) / maxHp * 100,
    ...(ko === "conditional" ? { note: "Immediate KO depends on rounded current HP." } : {}) };
}
