import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Dex } from "@pkmn/dex";
import { Generations, toID } from "@pkmn/data";
import { z } from "zod";

const gen = new Generations(Dex as any).get(9);
/** Spreads kept per species: the most common, enough for the modal attacking spread. */
const SPREAD_LIMIT = 24;
const sourceSchema = z.object({ url: z.string(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  formatId: z.literal("gen9uu"), ratingCutoff: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const moveSchema = z.object({ id: z.string().min(1), name: z.string().min(1), setInclusionShare: z.number().finite().min(0).max(1) }).strict();
const shareSchema = z.object({ id: z.string().min(1), name: z.string().min(1), share: z.number().finite().min(0).max(1) }).strict();
const evSchema = z.number().int().min(0).max(252);
/** One EV spread as Smogon writes it ("Jolly:0/252/0/0/4/252" = HP/Atk/Def/SpA/SpD/Spe). */
const spreadSchema = z.object({ nature: z.string().min(1), evs: z.tuple([evSchema, evSchema, evSchema, evSchema, evSchema, evSchema]),
  share: z.number().finite().min(0).max(1) }).strict();
/** Per-species monthly usage of held items, abilities, Tera types and the most common EV spreads; rawCount is Smogon's
 * species "Raw count". */
const setSchema = z.object({ rawCount: z.number().int().nonnegative(), items: z.array(shareSchema), abilities: z.array(shareSchema), teraTypes: z.array(shareSchema),
  spreads: z.array(spreadSchema).max(SPREAD_LIMIT) }).strict();
const priorSchema = z.object({ version: z.literal(1), source: sourceSchema, species: z.record(z.array(moveSchema)),
  sets: z.record(setSchema).optional(), revision: z.string() }).strict();
type MetaSetKind = "items" | "abilities" | "teraTypes";
const setLookup: Record<MetaSetKind, (id: string) => { id: string; name: string } | undefined> = {
  items: (id) => gen.items.get(id), abilities: (id) => gen.abilities.get(id), teraTypes: (id) => gen.types.get(id)
};
export type MetaMoveSource = z.infer<typeof sourceSchema>;
export type MetaMovePrior = z.infer<typeof priorSchema>;
export interface MetaMovePriorView {
  source: MetaMoveSource; revision: string;
  status: "cold_start" | "unrevealed_slots" | "moves_known" | "format_mismatch" | "species_missing" | "no_supported_candidate";
  moves: z.infer<typeof moveSchema>[];
  note: string;
}
const note = "Weighted population set-inclusion prevalence, not next-action probability or joint-set evidence. Source URL/hash are declared provenance, not remote-origin authentication; replay verifies the normalized revision.";
function source(value: unknown) {
  const s = sourceSchema.parse(value);
  if (s.url !== `https://www.smogon.com/stats/${s.period}/chaos/${s.formatId}-${s.ratingCutoff}.json`) throw new Error("Move prior source URL/period/format/cutoff mismatch.");
  return s;
}
function normalized(s: MetaMoveSource, species: MetaMovePrior["species"], sets?: MetaMovePrior["sets"]): MetaMovePrior {
  const sorted: MetaMovePrior["species"] = {};
  for (const id of Object.keys(species).sort()) {
    if (gen.species.get(id)?.id !== id) throw new Error("Unknown move-prior species ID.");
    const entries = species[id]!;
    if (new Set(entries.map((m) => m.id)).size !== entries.length) throw new Error("Duplicate move-prior move ID.");
    for (const m of entries) if (gen.moves.get(m.id)?.name !== m.name || gen.moves.get(m.id)?.id !== m.id) throw new Error("Unknown move-prior move ID/name.");
    sorted[id] = entries.map((m) => Object.freeze({ ...m })).sort((a, b) => b.setInclusionShare - a.setInclusionShare || a.id.localeCompare(b.id));
    Object.freeze(sorted[id]);
  }
  // Set usage is optional so move-only priors keep their established revision.
  let sortedSets: MetaMovePrior["sets"];
  if (sets) {
    sortedSets = {};
    for (const id of Object.keys(sets).sort()) {
      if (gen.species.get(id)?.id !== id) throw new Error("Unknown set-prior species ID.");
      const set = sets[id]!, out = { rawCount: set.rawCount } as NonNullable<MetaMovePrior["sets"]>[string];
      for (const kind of ["items", "abilities", "teraTypes"] as const) {
        const entries = set[kind];
        if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error(`Duplicate set-prior ${kind} ID.`);
        for (const e of entries) if (setLookup[kind](e.id)?.name !== e.name || setLookup[kind](e.id)?.id !== e.id) throw new Error(`Unknown set-prior ${kind} ID/name.`);
        out[kind] = Object.freeze(entries.map((e) => Object.freeze({ ...e })).sort((a, b) => b.share - a.share || a.id.localeCompare(b.id))) as typeof entries;
      }
      if (new Set(set.spreads.map((e) => `${e.nature}:${e.evs.join("/")}`)).size !== set.spreads.length) throw new Error("Duplicate set-prior spread.");
      for (const e of set.spreads) if (gen.natures.get(e.nature)?.name !== e.nature) throw new Error("Unknown set-prior spread nature.");
      out.spreads = Object.freeze(set.spreads.map((e) => Object.freeze({ ...e, evs: Object.freeze([...e.evs]) }))
        .sort((a, b) => b.share - a.share || `${a.nature}:${a.evs.join("/")}`.localeCompare(`${b.nature}:${b.evs.join("/")}`))) as typeof set.spreads;
      sortedSets[id] = Object.freeze(out);
    }
    Object.freeze(sortedSets);
  }
  const body = { version: 1 as const, source: s, species: sorted, ...(sortedSets ? { sets: sortedSets } : {}) };
  const revision = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
  Object.freeze(s); Object.freeze(sorted);
  const result = Object.freeze({ ...body, revision });
  normalizedPriors.add(result);
  return result;
}
// normalized() output is deeply frozen: it needs neither a defensive copy nor revalidation. Revalidating the monthly
// prior cost ~55 ms on every observation batch (2026-10-23).
const normalizedPriors = new WeakSet<object>();
/** A validated, immutable prior detached from the caller's object. */
export function detachMetaMovePrior(value: MetaMovePrior): MetaMovePrior {
  return normalizedPriors.has(value) ? value : validateMetaMovePrior(structuredClone(value));
}
/** Internal content binding only: normalized replay cannot reverify raw bytes or remote origin. */
export function validateMetaMovePrior(value: unknown): MetaMovePrior {
  const p = priorSchema.parse(value), result = normalized(source(p.source), p.species, p.sets);
  if (result.revision !== p.revision) throw new Error("Move prior normalized revision mismatch.");
  return result;
}
/** Explicit import. No network, file lookup, clock, history or curated mutation. */
export function parseMetaMovePrior(raw: Uint8Array, declaredSource: unknown): MetaMovePrior {
  if (raw.byteLength > 5_000_000) throw new Error("Move prior raw data exceeds 5 MB.");
  const s = source(declaredSource);
  if (createHash("sha256").update(raw).digest("hex") !== s.sha256) throw new Error("Move prior raw SHA-256 mismatch.");
  const weights = z.record(z.number().finite().nonnegative());
  const input = z.object({ info: z.object({ metagame: z.string(), cutoff: z.number(), "team type": z.null() }).passthrough(),
    data: z.record(z.object({ Abilities: weights, Moves: weights, Items: weights.optional(), "Tera Types": weights.optional(), Spreads: weights.optional(),
      "Raw count": z.number().int().nonnegative().optional() }).passthrough()) }).parse(JSON.parse(Buffer.from(raw).toString("utf8")));
  if (input.info.metagame !== s.formatId || input.info.cutoff !== s.ratingCutoff) throw new Error("Move prior raw format/cutoff mismatch.");
  const species: MetaMovePrior["species"] = {}, sets: NonNullable<MetaMovePrior["sets"]> = {};
  for (const [name, entry] of Object.entries(input.data)) {
    const id = gen.species.get(name)?.id;
    if (!id || species[id]) throw new Error("Unknown or duplicate move-prior species.");
    // Smogon adds one ability weight per set; move weights count each move.
    // Only this scalar mass is used. Ability choices never enter inference.
    const mass = Object.values(entry.Abilities).reduce((a, b) => a + b, 0);
    if (!Number.isFinite(mass) || mass <= 0) throw new Error("Move prior needs positive finite species mass.");
    species[id] = Object.entries(entry.Moves).filter(([move]) => move !== "").map(([move, weight]) => {
      const known = gen.moves.get(move), share = weight / mass;
      if (!known || !Number.isFinite(share) || share > 1 + 1e-8) throw new Error("Unknown move-prior move or invalid marginal.");
      return { id: known.id, name: known.name, setInclusionShare: Math.min(1, share) };
    });
    // One held item, ability and Tera type per set: each weight over the same species mass is its usage share.
    if (entry.Items && entry["Tera Types"] && entry["Raw count"] !== undefined) {
      const shares = (kind: MetaSetKind, weightsByKey: Record<string, number>) => Object.entries(weightsByKey).filter(([key]) => key !== "" && key !== "nothing").map(([key, weight]) => {
        const known = setLookup[kind](key), share = weight / mass;
        if (!known || !Number.isFinite(share) || share > 1 + 1e-8) throw new Error(`Unknown set-prior ${kind} entry or invalid share.`);
        return { id: known.id, name: known.name, share: Math.min(1, share) };
      });
      const spreads = Object.entries(entry.Spreads ?? {}).map(([key, weight]) => {
        const match = /^([A-Za-z]+):(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(key), share = weight / mass;
        if (!match || !gen.natures.get(match[1]!) || !Number.isFinite(share) || share > 1 + 1e-8) throw new Error("Unknown set-prior spread or invalid share.");
        return { nature: gen.natures.get(match[1]!)!.name, evs: match.slice(2).map(Number) as [number, number, number, number, number, number], share: Math.min(1, share) };
      }).sort((a, b) => b.share - a.share).slice(0, SPREAD_LIMIT);
      sets[id] = { rawCount: entry["Raw count"], items: shares("items", entry.Items), abilities: shares("abilities", entry.Abilities), teraTypes: shares("teraTypes", entry["Tera Types"]), spreads };
    }
  }
  return normalized(s, species, Object.keys(sets).length ? sets : undefined);
}
/** A battle-only forme (Mimikyu-Busted, Eiscue-Noice, Palafin-Hero...) is the same Pokémon mid-battle: the ladder
 * records it under the forme it starts in. Without this a Disguise break dropped Mimikyu's priors (Shadow Sneak). */
export function priorSpeciesId(species: string) {
  const forme = gen.species.get(species);
  return toID(typeof forme?.battleOnly === "string" ? forme.battleOnly : species);
}

/** Existing 0.45 admission heuristic; never interpreted as action probability/confidence. */
export function metaMovePriorView(prior: MetaMovePrior, format: string, species: string, revealedMoves: readonly string[]): MetaMovePriorView {
  const known = new Set<string>(revealedMoves.map(toID));
  const entries = prior.species[priorSpeciesId(species)];
  const moves = entries?.filter((m) => m.setInclusionShare >= 0.45 && !known.has(m.id)).slice(0, Math.max(0, 4 - known.size)) ?? [];
  const status = toID(format) !== prior.source.formatId ? "format_mismatch" : known.size >= 4 ? "moves_known"
    : !entries ? "species_missing" : !moves.length ? "no_supported_candidate" : known.size ? "unrevealed_slots" : "cold_start";
  return { source: prior.source, revision: prior.revision, status,
    moves: status === "cold_start" || status === "unrevealed_slots" ? moves : [], note };
}

/** Every ladder move of the species with its set-inclusion share (the expected make-up of an unrevealed set). */
export function metaMoveInclusion(prior: MetaMovePrior, format: string, species: string) {
  if (toID(format) !== prior.source.formatId) return [];
  return (prior.species[priorSpeciesId(species)] ?? []).map((entry) => ({ name: entry.name, share: entry.setInclusionShare }));
}

/** Monthly ladder usage (items, abilities, Tera types) as likely entries for the existing consumers. Tagged with
 * its provenance; count stays 0 so it never reads as the owner's observed history or curated teams. */
export function metaSetPriorEntries(prior: MetaMovePrior, format: string, species: string, kind: MetaSetKind, exclude: readonly string[] = [], limit = 4) {
  if (toID(format) !== prior.source.formatId) return [];
  const set = prior.sets?.[priorSpeciesId(species)], excluded = new Set<string>(exclude.map(toID));
  return (set?.[kind] ?? []).filter((entry) => !excluded.has(entry.id)).slice(0, limit)
    .map((entry) => ({ name: entry.name, count: 0, share: entry.share, sampleCount: set!.rawCount, confidenceTier: "usable" as const, source: "monthly_ladder" as const }));
}

const ATTACK_STAT = { Physical: { index: 1, stat: "atk" }, Special: { index: 3, stat: "spa" } } as const;
/** The ladder's modal attacking spread per category: spreads grouped by what sets the attacking stat (its EVs and the
 * nature's effect on it), the largest group's most common nature. Mimikyu: Jolly 252 Atk (~74% of spreads), whatever the
 * other EVs. A representative nature keeps the group's multiplier; the share is the group's share of all spreads. */
export function metaAttackProfile(prior: MetaMovePrior, format: string, species: string) {
  if (toID(format) !== prior.source.formatId) return undefined;
  const spreads = prior.sets?.[priorSpeciesId(species)]?.spreads ?? [];
  if (!spreads.length) return undefined;
  const pick = <C extends keyof typeof ATTACK_STAT>(category: C) => {
    const { index, stat } = ATTACK_STAT[category];
    const effect = (nature: string) => { const n = gen.natures.get(nature)!; return n.plus === stat && n.minus !== stat ? 1 : n.minus === stat && n.plus !== stat ? -1 : 0; };
    const groups = new Map<string, { share: number; ev: number; natures: Map<string, number> }>();
    for (const spread of spreads) {
      const key = `${spread.evs[index]}:${effect(spread.nature)}`, group = groups.get(key) ?? { share: 0, ev: spread.evs[index]!, natures: new Map() };
      group.share += spread.share; group.natures.set(spread.nature, (group.natures.get(spread.nature) ?? 0) + spread.share); groups.set(key, group);
    }
    const best = [...groups.values()].sort((a, b) => b.share - a.share || b.ev - a.ev)[0]!;
    const nature = [...best.natures.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    return { nature, evs: { [stat]: best.ev } as Record<typeof stat, number>, share: best.share };
  };
  return { Physical: pick("Physical"), Special: pick("Special") };
}

// Inputs must be explicitly cached outside this project or in its device-local
// tmp/ (gitignored, and Syncthing ignores proj/*/tmp). Arbitrary sync roots
// cannot be inferred: the caller must choose an unsynced location.
export async function loadMetaMovePriorDescriptor(file: string, projectRoot: string) {
  if (!path.isAbsolute(file)) throw new Error("Move priors require an absolute descriptor path.");
  const project = await fs.realpath(projectRoot);
  const read = async (name: string, limit: number) => {
    const resolved = await fs.realpath(name), relative = path.relative(project, resolved);
    const inScratch = relative.startsWith(`tmp${path.sep}`);
    if (!relative || (!inScratch && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) throw new Error("Move prior inputs must be outside the project or under its tmp/.");
    const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Move prior inputs must be regular files.");
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw new Error("Move prior input exceeds its size limit.");
      return { resolved, bytes: buffer.subarray(0, length) };
    } finally { await handle.close(); }
  };
  const descriptor = await read(file, 16_384), d = JSON.parse(descriptor.bytes.toString("utf8"));
  if (!d || d.version !== 1 || typeof d.rawFile !== "string" || !d.rawFile || d.rawFile.includes("\0") || Object.keys(d).some((k) => !["version", "source", "rawFile"].includes(k))) throw new Error("Invalid move prior descriptor.");
  const raw = await read(path.resolve(path.dirname(descriptor.resolved), d.rawFile), 5_000_000);
  return parseMetaMovePrior(raw.bytes, d.source);
}
