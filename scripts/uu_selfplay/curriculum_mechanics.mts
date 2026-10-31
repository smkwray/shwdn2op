/**
 * Gen 9 mechanics facts for curriculum.py, read from the pinned Pokemon Showdown simulator data and the companion's own
 * ability-immunity table (so the curriculum and the live warnings share one source). Generic: types, move flags and
 * ability behaviour; no species. Usage: node --import tsx scripts/uu_selfplay/curriculum_mechanics.mts OUT.json
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { MOVE_TYPE_IMMUNITY_ABILITY_LABELS } from "../../apps/companion/src/prompting/damageNotes.js";

const require = createRequire(import.meta.url);
const { Dex } = require("pokemon-showdown");
const dex = Dex.forGen(9);
const id = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const src = (f: unknown) => (typeof f === "function" ? f.toString() : "");

const types = dex.types.all().filter((t: any) => t.exists && t.isNonstandard !== "Future").map((t: any) => t.name);
const chart: Record<string, Record<string, number>> = {};
for (const atk of types) {
  chart[id(atk)] = {};
  for (const def of types) {
    chart[id(atk)][id(def)] = !dex.getImmunity(atk, [def]) ? 0 : 2 ** dex.getEffectiveness(atk, [def]);
  }
}

const moves: Record<string, unknown> = {};
for (const m of dex.moves.all()) {
  if (!m.exists) continue;
  const boosts = Object.values(m.self?.boosts ?? {}) as number[];
  moves[m.id] = {
    type: id(m.type), category: id(m.category), basePower: m.basePower, priority: m.priority,
    recoil: Boolean(m.recoil || m.mindBlownRecoil || m.struggleRecoil),
    selfDrop: boosts.some((b) => b < 0),
    // A direct self-heal (fails at full HP): heal flag, targets the user, not a delayed slot effect or a self-KO wish.
    directHeal: Boolean(m.flags?.heal && m.target === "self" && !m.slotCondition && !m.selfdestruct),
    ignoreAbility: Boolean(m.ignoreAbility), ignoreImmunity: Boolean(m.ignoreImmunity), changesType: Boolean(m.onModifyType),
  };
}

const abilities: Record<string, unknown> = {};
for (const a of dex.abilities.all()) {
  if (!a.exists) continue;
  const modify = src(a.onModifyMove) + src(a.onAnyModifyMove);
  abilities[a.id] = {
    ignoresAbilities: modify.includes("ignoreAbility"), ignoresImmunity: modify.includes("ignoreImmunity"),
    changesMoveType: Boolean(a.onModifyType),
  };
}

const immunityAbilities: Record<string, string> = {};
for (const [type, labels] of Object.entries(MOVE_TYPE_IMMUNITY_ABILITY_LABELS)) {
  for (const label of labels) immunityAbilities[id(label)] = id(type);
}

const out = { producer: "scripts/uu_selfplay/curriculum_mechanics.mts", showdown: require("pokemon-showdown/package.json").version,
  typeChart: chart, moves, abilities, immunityAbilities };
writeFileSync(process.argv[2], JSON.stringify(out));
console.log(JSON.stringify({ types: types.length, moves: Object.keys(moves).length, abilities: Object.keys(abilities).length,
  immunityAbilities, ignoresAbilities: Object.entries(abilities).filter(([, v]: any) => v.ignoresAbilities).map(([k]) => k),
  ignoresImmunity: Object.entries(abilities).filter(([, v]: any) => v.ignoresImmunity).map(([k]) => k) }));
