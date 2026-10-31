import { detachMetaMovePrior, metaMoveInclusion, metaMovePriorView, metaSetPriorEntries, metaAttackProfile, type MetaMovePrior } from "./metaPriorStore.js";
import { projectSwitchEntry } from "../mechanics/switchEntry.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";
import { createDecisionIdentity, hashCanonical, sameDecision, type DecisionIdentity } from "../../../extension/lib/decision-identity.js";

import { config } from "../config.js";
import { withinDeadline } from "../state/deadline.js";
import {
  buildOpponentPosterior,
  type PosteriorBattleDamageObservation,
  type PosteriorBattleSpeciesEvidence,
  type PosteriorBattleSpeedObservation
} from "../inference/posterior.js";
import {
  createExternalCuratedFormatRecord,
  createExternalCuratedStore,
  normalizeExternalCuratedFormatRecord,
  normalizeExternalCuratedStore,
  type ExternalCuratedFormatRecord,
  type ExternalCuratedStore,
  type SampleTeamPriorImportParams
} from "./externalCuratedStore.js";
import type {
  BattleSnapshot,
  DamageAssumptionBand,
  DamagePreview,
  InferenceEvent,
  LikelihoodEntry,
  LocalIntelSnapshot,
  MoveTargetPreview,
  OpponentIntelEntry,
  PokemonSnapshot,
  SpeedEvidenceTag,
  SpeedPreview,
  SwitchSpeedMatchup
} from "../types.js";
import { choiceRefutedByStint, filterLiveLikelyHeldItemEntries, filterLiveLikelyHeldItemNames } from "../mechanics/liveLikelyItems.js";
import { parseInferenceEvents } from "../mechanics/inferenceEvents.js";
import {
  effectiveSpeed,
  effectiveSpeedRange,
  effectiveSpeedField,
  FIELD_SPEED_ABILITY_RULES,
  matchingFieldSpeedAbilityRule,
  speedAbilityMultiplierRange,
  type FieldSpeedAbilityRule
} from "../mechanics/speed.js";
import { buildDamagePreview, buildThreatPreview } from "../prompting/damageNotes.js";
import { buildOpponentActionPrediction } from "../prediction/opponentActionPredictor.js";
import { buildOpponentLeadPrediction } from "../prediction/opponentLeadPredictor.js";
import { buildPlayerLeadRecommendation } from "../prediction/playerLeadPredictor.js";
import { buildSelfActionRecommendation } from "../prediction/selfActionRecommender.js";

interface IntelFormatRecord {
  battlesSeen: number;
  leadCount: number;
  moves: Record<string, number>;
  items: Record<string, number>;
  abilities: Record<string, number>;
  teraTypes: Record<string, number>;
  observedDamage: Record<string, { count: number; min: number; max: number; total: number }>;
  observedTakenDamage: Record<string, { count: number; min: number; max: number; total: number }>;
  observedDamageByContext: Record<string, { count: number; min: number; max: number; total: number }>;
  observedTakenDamageByContext: Record<string, { count: number; min: number; max: number; total: number }>;
  speedFirstVs: Record<string, number>;
  speedSecondVs: Record<string, number>;
  speedFasterThan: Record<string, number>;
  speedSlowerThan: Record<string, number>;
}

interface IntelSpeciesRecord {
  species: string;
  formats: Record<string, IntelFormatRecord>;
}

interface BattleSpeciesLedger {
  battleRecorded: boolean;
  moves: Record<string, true>;
  items: Record<string, true>;
  abilities: Record<string, true>;
  teraTypes: Record<string, true>;
  damageKeys: Record<string, true>;
  speedKeys: Record<string, true>;
  incomingDamage: PosteriorBattleDamageObservation[];
  outgoingDamage: PosteriorBattleDamageObservation[];
  speedObservations: PosteriorBattleSpeedObservation[];
}

interface BattleLedger {
  roomId: string;
  format: string;
  updatedAt: string;
  leadRecorded?: boolean | undefined;
  species: Record<string, BattleSpeciesLedger>;
  instances?: Record<string, BattleSpeciesLedger> | undefined;
  predictionHistory?: Array<{
    turn: number;
    predictedClass: "stay_attack" | "switch" | "status_or_setup" | "unknown";
    predictedLabel: string | null;
    actualClass: "stay_attack" | "switch" | "status_or_setup" | "unknown";
    actualLabel: string | null;
    matched: boolean;
    predictedAt: string;
    resolvedAt: string;
  }> | undefined;
  pendingPrediction?: {
    turn: number;
    predictedClass: "stay_attack" | "switch" | "status_or_setup" | "unknown";
    predictedLabel: string | null;
    predictedAt: string;
  } | undefined;
  lastSeen?: {
    recentLog: string[];
    yourActiveName: string | null;
    yourActiveSpecies: string | null;
    opponentActiveName: string | null;
    opponentActiveSpecies: string | null;
    yourHpPercent: number | null;
    opponentHpPercent: number | null;
    yourActive?: PokemonSnapshot | null;
    opponentActive?: PokemonSnapshot | null;
    field?: BattleSnapshot["field"] | null;
  } | undefined;
}

type PredictionHistoryEntry = NonNullable<BattleLedger["predictionHistory"]>[number];

interface IntelStore {
  version: string;
  updatedAt: string;
  species: Record<string, IntelSpeciesRecord>;
  battles: Record<string, BattleLedger>;
  externalCurated: ExternalCuratedStore;
  canonicalBattles?: Record<string, { format: string; contributions: NonNullable<BattleSnapshot["canonicalEvidence"]>["contributions"];
    confirmedFacts: Record<string, string>; lineageConflict?: boolean | undefined }> | undefined;
}

type PersistedIntelStore = Omit<IntelStore, "externalCurated"> & {
  externalCurated?: ExternalCuratedStore | undefined;
  sampleTeams?: ExternalCuratedStore | undefined;
};

const EMPTY_STORE: IntelStore = {
  version: "0.1.0",
  updatedAt: new Date(0).toISOString(),
  species: {},
  battles: {},
  externalCurated: createExternalCuratedStore()
};

let writeChain = Promise.resolve();
const gens = new Generations(Dex as any);
const MIN_HISTORY_SPEED_BOUND_SAMPLES = 2;
const CURATED_PRIOR_CONFIDENCE_WEIGHT = 0.35;
const LEARNSET_FALLBACK_CACHE = new Map<string, Promise<string[]>>();
const LOW_SIGNAL_FALLBACK_MOVE_IDS = new Set([
  "attract",
  "celebrate",
  "confide",
  "covet",
  "cut",
  "doubleteam",
  "echoedvoice",
  "flash",
  "frustration",
  "gigaimpact",
  "growl",
  "helpinghand",
  "hiddenpower",
  "leer",
  "metronome",
  "mimic",
  "mudslap",
  "naturalgift",
  "protect",
  "psychup",
  "raindance",
  "rest",
  "return",
  "round",
  "secretpower",
  "sleeptalk",
  "snore",
  "substitute",
  "sunnyday",
  "swagger",
  "workup"
]);

function normalizeName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizedItemId(value: string | null | undefined): string {
  return normalizeName(value);
}

function normalizedAbilityId(value: string | null | undefined): string {
  return normalizeName(value);
}

function revealedItemName(pokemon: PokemonSnapshot | null | undefined): string | null {
  return pokemon?.item ?? pokemon?.removedItem ?? null;
}

function liveLikelyHeldItems(
  format: string,
  pokemon: PokemonSnapshot | null | undefined,
  likelyItems: LikelihoodEntry[] | undefined,
  recentLog?: string[] | undefined,
  inferenceEvents?: InferenceEvent[] | undefined
) {
  return filterLiveLikelyHeldItemNames(
    format,
    pokemon,
    likelyItems?.map((entry) => entry.name) ?? [],
    { recentLog, inferenceEvents }
  );
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = normalizeName(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function lookupMove(gen: ReturnType<Generations["get"]>, moveName: string | null | undefined) {
  if (!moveName) return undefined;
  const direct = gen.moves.get(moveName);
  if (direct) return direct;
  const normalized = normalizeName(moveName);
  for (const move of gen.moves) {
    if (normalizeName(move.name) === normalized) return move;
  }
  return undefined;
}

function displayNameForMoveId(gen: ReturnType<Generations["get"]>, moveId: string) {
  const move = gen.moves.get(moveId);
  return move?.name ?? moveId;
}

function lookupSpecies(gen: ReturnType<Generations["get"]>, speciesName: string | null | undefined) {
  if (!speciesName) return undefined;
  const direct = gen.species.get(speciesName);
  if (direct) return direct;
  const normalized = normalizeName(speciesName);
  for (const species of gen.species) {
    if (normalizeName(species.name) === normalized) return species;
  }
  return undefined;
}

function possibleFieldSpeedAbilityRules(
  format: string,
  pokemon: PokemonSnapshot | null | undefined,
  field: BattleSnapshot["field"]
) {
  if (!pokemon || normalizedAbilityId(pokemon.ability)) return [];
  const speciesName = speciesNameFromSnapshot(pokemon);
  if (!speciesName) return [];
  const gen = gens.get(generationFromFormat(format));
  const species = lookupSpecies(gen, speciesName);
  if (!species?.abilities) return [];
  const possibleAbilities = Object.values(species.abilities)
    .map((value) => matchingFieldSpeedAbilityRule(value, field))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const seen = new Set<string>();
  return possibleAbilities.filter((rule) => {
    if (seen.has(rule.abilityId)) return false;
    seen.add(rule.abilityId);
    return true;
  });
}

function formatPossibleFieldSpeedAbilityConfounder(sideLabel: "your" | "opponent", rules: ReturnType<typeof possibleFieldSpeedAbilityRules>) {
  if (rules.length === 0) return null;
  const names = rules.map((rule) => rule.label).join(" / ");
  return `possible ${sideLabel} ${names}`;
}

function createFormatRecord(): IntelFormatRecord {
  return {
    battlesSeen: 0,
    leadCount: 0,
    moves: {},
    items: {},
    abilities: {},
    teraTypes: {},
    observedDamage: {},
    observedTakenDamage: {},
    observedDamageByContext: {},
    observedTakenDamageByContext: {},
    speedFirstVs: {},
    speedSecondVs: {},
    speedFasterThan: {},
    speedSlowerThan: {}
  };
}

function normalizeFormatRecord(formatRecord: Partial<IntelFormatRecord> | undefined): IntelFormatRecord {
  return {
    ...createFormatRecord(),
    ...(formatRecord ?? {})
  };
}

function createBattleSpeciesLedger(): BattleSpeciesLedger {
  return {
    battleRecorded: false,
    moves: {},
    items: {},
    abilities: {},
    teraTypes: {},
    damageKeys: {},
    speedKeys: {},
    incomingDamage: [],
    outgoingDamage: [],
    speedObservations: []
  };
}

function normalizeBattleSpeciesLedger(ledger: Partial<BattleSpeciesLedger> | undefined): BattleSpeciesLedger {
  return {
    ...createBattleSpeciesLedger(),
    ...(ledger ?? {})
  };
}

async function ensureStoreDirs() {
  await fs.mkdir(path.dirname(config.localIntelStorePath), { recursive: true });
  await fs.mkdir(path.dirname(config.externalCuratedStorePath), { recursive: true });
}

async function readExternalCuratedStore(fallback?: PersistedIntelStore): Promise<ExternalCuratedStore> {
  try {
    const text = await fs.readFile(config.externalCuratedStorePath, "utf8");
    const parsed = JSON.parse(text) as Partial<ExternalCuratedStore>;
    return normalizeExternalCuratedStore(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return normalizeExternalCuratedStore(fallback?.externalCurated ?? fallback?.sampleTeams);
  }
}

async function readStoreFiles(): Promise<IntelStore> {
  try {
    const text = await fs.readFile(config.localIntelStorePath, "utf8");
    const parsed = JSON.parse(text) as PersistedIntelStore;
    const externalCurated = await readExternalCuratedStore(parsed);
    return {
      version: parsed.version ?? EMPTY_STORE.version,
      updatedAt: parsed.updatedAt ?? EMPTY_STORE.updatedAt,
      species: parsed.species ?? {},
      battles: parsed.battles ?? {},
      canonicalBattles: parsed.canonicalBattles ?? {},
      externalCurated
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return {
      ...structuredClone(EMPTY_STORE),
      externalCurated: await readExternalCuratedStore()
    };
  }
}

// This process keeps the parsed history in memory and never mutates an installed store in place (each change installs
// a new object), so evaluation contexts share it without copies. Persistence is write-behind: changes are coalesced
// and written atomically (temporary file + rename) within PERSIST_DELAY_MS, off the request path, and flushed on
// shutdown. A failed write keeps the change pending, is retried and is reported by intelStorePersistence(); no
// in-memory change is dropped. The files are read again only when nothing is pending and another process changed them.
// Reading, hashing, cloning and rewriting the ~3 MB file on every observation cost ~75 ms per batch (2026-10-23).
const PERSIST_DELAY_MS = 1000, PERSIST_RETRY_MS = 5000;
let cache: { key: string; signature: [string, string]; store: IntelStore } | undefined;
let revisionMemo: { store: IntelStore; prior: string | undefined; revision: Promise<string> } | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined, persistRun: Promise<void> | undefined, curatedPending = false;
let persistStartedAt: number | null = null;
const persistence = { pending: false, failures: 0, error: null as string | null, lastWrittenAt: null as string | null };

function fileSignature(file: string) {
  return fs.stat(file).then((s) => `${s.size}:${s.mtimeMs}`, (error) => {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  });
}

async function readStore(check: () => void = () => {}): Promise<IntelStore> {
  const key = `${config.localIntelStorePath}\n${config.externalCuratedStorePath}`;
  if (cache?.key === key && (persistence.pending || persistRun)) return cache.store;
  const signature: [string, string] = [await fileSignature(config.localIntelStorePath), await fileSignature(config.externalCuratedStorePath)];
  if (cache?.key !== key || cache.signature.join("|") !== signature.join("|")) {
    const store = await readStoreFiles();
    check(); // A timed-out load cannot overwrite a newer committed store.
    cache = { key, signature, store };
  }
  return cache.store;
}

function installStore(store: IntelStore, curated: boolean) {
  cache!.store = store;
  persistence.pending = true;
  curatedPending ||= curated;
  schedulePersist(PERSIST_DELAY_MS);
}

function schedulePersist(delayMs: number) {
  persistTimer ??= setTimeout(() => {
    persistTimer = undefined;
    drainPersistence().catch((error) => {
      console.error(`[opponent-intel] history write failed (${persistence.failures}x); kept in memory and retrying`, error);
      schedulePersist(PERSIST_RETRY_MS);
    });
  }, delayMs);
}

function drainPersistence(): Promise<void> {
  // With nothing pending the run below would settle synchronously, clear persistRun in its finally, and only then be
  // assigned to it: a settled run left installed blocks every later write and flush.
  if (!persistRun && !persistence.pending) return Promise.resolve();
  persistRun ??= (async () => {
    persistStartedAt = Date.now();
    try {
      while (persistence.pending) {
        const store = cache!.store, curated = curatedPending;
        persistence.pending = false; curatedPending = false;
        try {
          await writeObservedStore(store);
          if (curated) await fs.writeFile(config.externalCuratedStorePath, JSON.stringify(store.externalCurated, null, 2));
          // Only the files written here are taken as known; another process's edit of the other is still noticed.
          cache!.signature = [await fileSignature(config.localIntelStorePath), curated ? await fileSignature(config.externalCuratedStorePath) : cache!.signature[1]];
          persistence.error = null; persistence.lastWrittenAt = new Date().toISOString();
        } catch (error) {
          persistence.pending = true; curatedPending ||= curated; persistence.failures += 1;
          persistence.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
    } finally {
      persistRun = undefined;
      persistStartedAt = null;
    }
  })();
  return persistRun;
}

/** Write every pending history change now; rejects while the files cannot be written. */
export async function flushIntelStore(): Promise<void> {
  await withinDeadline("history flush", 5000, async (check) => {
    await writeChain;
    check();
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined; }
    await persistRun?.catch(() => undefined);
    check();
    if (persistence.pending) await drainPersistence();
  });
}

/** Write-behind state of the history file, for status endpoints. */
export function intelStorePersistence() {
  const writingMs = persistStartedAt === null ? 0 : Date.now() - persistStartedAt;
  return { ...persistence, writing: Boolean(persistRun), writingMs,
    ...(writingMs >= 5000 ? { error: "history_persistence_stalled", pending: true } : {}) };
}

function storeRevision(store: IntelStore, prior?: MetaMovePrior): Promise<string> {
  if (revisionMemo?.store !== store || revisionMemo.prior !== prior?.revision) {
    const revision = withinDeadline("history revision", 3000, async () => hashCanonical(prior ? { store, metaPriorRevision: prior.revision } : store));
    revisionMemo = { store, prior: prior?.revision, revision };
    void revision.catch(() => { if (revisionMemo?.revision === revision) revisionMemo = undefined; });
  }
  return revisionMemo.revision;
}

async function writeObservedStore(store: IntelStore) {
  await ensureStoreDirs();
  const temporaryPath = `${config.localIntelStorePath}.pending-${process.pid}`;
  const persisted: PersistedIntelStore = { version: store.version, updatedAt: store.updatedAt, species: store.species, battles: store.battles,
    ...(store.canonicalBattles ? { canonicalBattles: store.canonicalBattles } : {}) };
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(persisted, null, 2));
    await fs.rename(temporaryPath, config.localIntelStorePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function withStoreWrite<T>(operation: (store: IntelStore) => Promise<T> | T, parentCheck: () => void = () => {}): Promise<T> {
  const run = writeChain.then(() => withinDeadline("history transaction", 3000, async (check) => {
    const fence = () => { check(); parentCheck(); };
    fence();
    const store = structuredClone(await readStore(fence));
    fence();
    const result = await operation(store);
    fence();
    store.updatedAt = new Date().toISOString();
    installStore(store, true);
    return result;
  }));
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

function ensureSpeciesFormat(store: IntelStore, speciesName: string, format: string) {
  const speciesKey = normalizeName(speciesName);
  if (!store.species[speciesKey]) {
    store.species[speciesKey] = {
      species: speciesName,
      formats: {}
    };
  }
  const speciesRecord = store.species[speciesKey];
  if (!speciesRecord.formats[format]) {
    speciesRecord.formats[format] = createFormatRecord();
  } else {
    speciesRecord.formats[format] = normalizeFormatRecord(speciesRecord.formats[format]);
  }
  return {
    speciesKey,
    speciesRecord,
    formatRecord: speciesRecord.formats[format]
  };
}

function ensureExternalCuratedSpeciesFormat(store: IntelStore, speciesName: string, format: string) {
  const speciesKey = normalizeName(speciesName);
  if (!store.externalCurated.species[speciesKey]) {
    store.externalCurated.species[speciesKey] = {
      species: speciesName,
      formats: {}
    };
  }
  const speciesRecord = store.externalCurated.species[speciesKey];
  if (!speciesRecord.formats[format]) {
    speciesRecord.formats[format] = createExternalCuratedFormatRecord();
  } else {
    speciesRecord.formats[format] = normalizeExternalCuratedFormatRecord(speciesRecord.formats[format]);
  }
  return {
    speciesKey,
    speciesRecord,
    formatRecord: speciesRecord.formats[format]
  };
}

function externalCuratedFormatRecord(store: IntelStore, speciesKey: string, format: string) {
  return normalizeExternalCuratedFormatRecord(store.externalCurated.species[speciesKey]?.formats?.[format]);
}

function effectivePriorConfidenceSamples(observedSamples: number, curatedSamples: number) {
  return observedSamples + curatedSamples * CURATED_PRIOR_CONFIDENCE_WEIGHT;
}

function totalRecordedCounts(record: Record<string, number>) {
  return Object.values(record ?? {}).reduce((sum, count) => sum + count, 0);
}

function effectivePriorShare(params: {
  observedCount: number;
  observedSamples: number;
  observedRecordTotal: number;
  curatedCount: number;
  curatedSamples: number;
  curatedRecordTotal: number;
}) {
  const observedWeight = params.observedSamples > 0 && params.observedRecordTotal > 0 ? 1 : 0;
  const curatedWeight = params.curatedSamples > 0 && params.curatedRecordTotal > 0 ? CURATED_PRIOR_CONFIDENCE_WEIGHT : 0;
  const totalWeight = observedWeight + curatedWeight;
  if (totalWeight <= 0) return 0;
  const observedShare = params.observedSamples > 0 ? params.observedCount / params.observedSamples : 0;
  const curatedShare = params.curatedSamples > 0 ? params.curatedCount / params.curatedSamples : 0;
  return Number((((observedShare * observedWeight) + (curatedShare * curatedWeight)) / totalWeight).toFixed(3));
}

function ensureBattleLedger(store: IntelStore, snapshot: BattleSnapshot) {
  if (!store.battles[snapshot.roomId]) {
    store.battles[snapshot.roomId] = {
      roomId: snapshot.roomId,
      format: snapshot.format,
      updatedAt: snapshot.capturedAt,
      species: {}
    };
  }
  const ledger = store.battles[snapshot.roomId];
  if (!ledger) {
    throw new Error(`Failed to create battle ledger for ${snapshot.roomId}`);
  }
  ledger.updatedAt = snapshot.capturedAt;
  ledger.format = snapshot.format;
  for (const speciesKey of Object.keys(ledger.species ?? {})) {
    ledger.species[speciesKey] = normalizeBattleSpeciesLedger(ledger.species[speciesKey]);
  }
  if (!Array.isArray(ledger.predictionHistory)) {
    ledger.predictionHistory = [];
  }
  return ledger;
}

function incrementCount(record: Record<string, number>, name: string) {
  record[name] = (record[name] ?? 0) + 1;
}

function updateObservedDamageRecord(
  record: Record<string, { count: number; min: number; max: number; total: number }>,
  key: string,
  percent: number
) {
  const next = record[key] ?? { count: 0, min: percent, max: percent, total: 0 };
  next.count += 1;
  next.total += percent;
  next.min = Math.min(next.min, percent);
  next.max = Math.max(next.max, percent);
  record[key] = next;
}

function normalizeContextToken(value: string | null | undefined, emptyValue = "unknown") {
  return value ? normalizeName(value) : emptyValue;
}

function relevantDamageSideConditions(conditions: string[] | undefined) {
  return (conditions ?? [])
    .map((value) => normalizeContextToken(value))
    .filter((value) => value === "reflect" || value === "lightscreen" || value === "auroraveil")
    .sort();
}

function fieldDamageContextFromField(field: BattleSnapshot["field"] | null | undefined) {
  if (!field) {
    return "weather:none|terrain:none|pseudo:none|your:none|opp:none";
  }
  const pseudoWeather = (field.pseudoWeather ?? [])
    .map((value) => normalizeContextToken(value, "none"))
    .filter((value) => value !== "none")
    .sort();
  const yourSide = relevantDamageSideConditions(field.yourSideConditions);
  const opponentSide = relevantDamageSideConditions(field.opponentSideConditions);
  return [
    `weather:${normalizeContextToken(field.weather, "none")}`,
    `terrain:${normalizeContextToken(field.terrain, "none")}`,
    `pseudo:${pseudoWeather.join("+") || "none"}`,
    `your:${yourSide.join("+") || "none"}`,
    `opp:${opponentSide.join("+") || "none"}`
  ].join("|");
}

function fieldDamageContextKey(snapshot: BattleSnapshot | null | undefined) {
  return fieldDamageContextFromField(snapshot?.field);
}

function boostContextKey(pokemon: PokemonSnapshot | null | undefined) {
  const atk = Number(pokemon?.boosts?.atk ?? 0);
  const spa = Number(pokemon?.boosts?.spa ?? 0);
  return `atk${atk}|spa${spa}`;
}

function defensiveBoostContextKey(pokemon: PokemonSnapshot | null | undefined) {
  const def = Number(pokemon?.boosts?.def ?? 0);
  const spd = Number(pokemon?.boosts?.spd ?? 0);
  return `def${def}|spd${spd}`;
}

function attackerContextKey(pokemon: PokemonSnapshot | null | undefined) {
  if (!pokemon) return "unknown-context";
  return [
    `item:${normalizeContextToken(pokemon.item)}`,
    `ability:${normalizeContextToken(pokemon.ability)}`,
    `tera:${pokemon.terastallized ? normalizeContextToken(pokemon.teraType) : "none"}`,
    `status:${normalizeContextToken(pokemon.status)}`,
    `paradox:${pokemon.paradoxBoostedStat === undefined ? "unknown" : pokemon.paradoxBoostedStat ?? "inactive"}`,
    ...(normalizedAbilityId(pokemon.ability) === "slowstart" ? [`slowstart:${pokemon.slowStartActive ?? "unknown"}`] : []),
    boostContextKey(pokemon)
  ].join("|");
}

function defenderContextKey(pokemon: PokemonSnapshot | null | undefined) {
  if (!pokemon) return "unknown-defender";
  return [
    `item:${normalizeContextToken(pokemon.item)}`,
    `ability:${normalizeContextToken(pokemon.ability)}`,
    `tera:${pokemon.terastallized ? normalizeContextToken(pokemon.teraType) : "none"}`,
    `status:${normalizeContextToken(pokemon.status)}`,
    `paradox:${pokemon.paradoxBoostedStat === undefined ? "unknown" : pokemon.paradoxBoostedStat ?? "inactive"}`,
    ...(normalizedAbilityId(pokemon.ability) === "slowstart" ? [`slowstart:${pokemon.slowStartActive ?? "unknown"}`] : []),
    defensiveBoostContextKey(pokemon)
  ].join("|");
}

function combatContextKey(
  attacker: PokemonSnapshot | null | undefined,
  defender: PokemonSnapshot | null | undefined,
  fieldContext = "weather:none|terrain:none|pseudo:none|your:none|opp:none"
) {
  const stats = (pokemon: PokemonSnapshot | null | undefined) => JSON.stringify([pokemon?.level,
    ...["hp", "atk", "def", "spa", "spd", "spe"].map((stat) => pokemon?.stats?.[stat] ?? null)]);
  return `${attackerContextKey(attacker)}|stats:${stats(attacker)}|def:${defenderContextKey(defender)}|stats:${stats(defender)}|field:${fieldContext}`;
}

function hasNeutralAttackerContext(pokemon: PokemonSnapshot | null | undefined) {
  if (!pokemon) return true;
  return !pokemon.item
    && !pokemon.ability
    && !(pokemon.terastallized && pokemon.teraType)
    && !pokemon.status
    && Number(pokemon.boosts?.atk ?? 0) === 0
    && Number(pokemon.boosts?.spa ?? 0) === 0;
}

function hasNeutralDefenderContext(pokemon: PokemonSnapshot | null | undefined) {
  if (!pokemon) return true;
  return !pokemon.item
    && !pokemon.ability
    && !(pokemon.terastallized && pokemon.teraType)
    && !pokemon.status
    && Number(pokemon.boosts?.def ?? 0) === 0
    && Number(pokemon.boosts?.spd ?? 0) === 0;
}

function hasNeutralDamageField(snapshot: BattleSnapshot | null | undefined) {
  if (!snapshot) return true;
  return !snapshot.field.weather
    && !snapshot.field.terrain
    && (snapshot.field.pseudoWeather?.length ?? 0) === 0
    && relevantDamageSideConditions(snapshot.field.yourSideConditions).length === 0
    && relevantDamageSideConditions(snapshot.field.opponentSideConditions).length === 0;
}

function allowAggregateObservedRange(
  snapshot: BattleSnapshot | null | undefined,
  attacker: PokemonSnapshot | null | undefined,
  defender: PokemonSnapshot | null | undefined
) {
  if (snapshot?.canonicalEvidence) return false; // Cross-spread aggregate HP percentages are descriptive, not exact mechanics.
  return hasNeutralDamageField(snapshot)
    && hasNeutralAttackerContext(attacker)
    && hasNeutralDefenderContext(defender);
}

function maybeRecordCount(record: Record<string, number>, ledgerRecord: Record<string, true>, value: string | null | undefined) {
  if (!value) return false;
  if (ledgerRecord[value]) return false;
  ledgerRecord[value] = true;
  incrementCount(record, value);
  return true;
}

function maybeRecordSampleTeamValue(record: Record<string, number>, seen: Set<string>, value: string | null | undefined) {
  if (!value) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  incrementCount(record, value);
  return true;
}

export async function importExternalCuratedTeamPriors(params: SampleTeamPriorImportParams) {
  return withStoreWrite(async (store) => {
    for (const [speciesKey, speciesRecord] of Object.entries(store.externalCurated.species)) {
      if (speciesRecord.formats?.[params.format]) {
        delete speciesRecord.formats[params.format];
      }
      if (Object.keys(speciesRecord.formats ?? {}).length === 0) {
        delete store.externalCurated.species[speciesKey];
      }
    }

    for (const team of params.teams) {
      if (!Array.isArray(team?.data) || team.data.length === 0) continue;

      team.data.forEach((set, index) => {
        const speciesName = set?.species?.trim();
        if (!speciesName) return;

        const { formatRecord } = ensureExternalCuratedSpeciesFormat(store, speciesName, params.format);
        formatRecord.teamCount += 1;
        if (index === 0) {
          formatRecord.leadSlotCount += 1;
        }

        const seenMoves = new Set<string>();
        for (const moveName of set.moves ?? []) {
          maybeRecordSampleTeamValue(formatRecord.moves, seenMoves, moveName);
        }
        maybeRecordSampleTeamValue(formatRecord.items, new Set<string>(), set.item ?? null);
        maybeRecordSampleTeamValue(formatRecord.abilities, new Set<string>(), set.ability ?? null);
        maybeRecordSampleTeamValue(formatRecord.teraTypes, new Set<string>(), set.teraType ?? null);
      });
    }

    store.externalCurated.imports[params.format] = {
      formatId: params.formatId,
      sourceUrl: params.sourceUrl,
      importedAt: new Date().toISOString(),
      teamsImported: params.teams.length
    };

    return {
      format: params.format,
      formatId: params.formatId,
      teamsImported: params.teams.length,
      sourceUrl: params.sourceUrl
    };
  }).then(async (result) => {
    await flushIntelStore();  // an import is durable when it returns (its CLI exits next)
    return result;
  });
}

export const importSampleTeamPriors = importExternalCuratedTeamPriors;

function maybeRecordOpponentLead(store: IntelStore, battle: BattleLedger, snapshot: BattleSnapshot) {
  if (battle.leadRecorded) return;
  if (snapshot.phase === "preview" || snapshot.turn > 1) return;
  const leadSpecies = snapshot.opponentSide.active?.species ?? snapshot.opponentSide.active?.displayName;
  if (!leadSpecies) return;
  const { formatRecord } = ensureSpeciesFormat(store, leadSpecies, snapshot.format);
  formatRecord.leadCount += 1;
  battle.leadRecorded = true;
}

function clonePokemonSnapshot(pokemon: PokemonSnapshot): PokemonSnapshot {
  return {
    ...pokemon,
    boosts: { ...(pokemon.boosts ?? {}) },
    stats: pokemon.stats ? { ...pokemon.stats } : undefined,
    knownMoves: [...pokemon.knownMoves],
    types: [...pokemon.types]
  };
}

function appendedRecentLog(previous: string[] | undefined, current: string[]) {
  const prev = Array.isArray(previous) ? previous : [];
  const next = Array.isArray(current) ? current : [];
  const maxOverlap = Math.min(prev.length, next.length);
  for (let overlap = maxOverlap; overlap >= 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (prev[prev.length - overlap + index] !== next[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return next.slice(overlap);
    }
  }
  return next;
}

function extractUsedMove(line: string) {
  const match = String(line).match(/^(.+?) used (.+)\.$/);
  if (!match) return null;
  return {
    actor: match[1]?.trim() ?? null,
    move: match[2]?.trim() ?? null
  };
}

function extractCouldNotMove(line: string) {
  const match = String(line).match(/^(.+?) could not move(?: \((.+)\))?\.$/);
  if (!match) return null;
  return {
    actor: match[1]?.trim() ?? null,
    reason: match[2]?.trim() ?? null
  };
}

function namesForPokemon(pokemon: PokemonSnapshot | null | undefined) {
  return uniqueStrings([pokemon?.displayName, pokemon?.species, pokemon?.ident]).map((value) => {
    const text = String(value ?? "");
    return text.includes(":") ? text.split(":").slice(1).join(":").trim() : text;
  });
}

function lineActorMatchesNameSet(line: string, names: string[]) {
  const used = extractUsedMove(line);
  if (used?.actor && names.some((name) => normalizeName(name) === normalizeName(used.actor))) {
    return true;
  }
  const couldNotMove = extractCouldNotMove(line);
  if (couldNotMove?.actor && names.some((name) => normalizeName(name) === normalizeName(couldNotMove.actor))) {
    return true;
  }
  return false;
}

function activePokemonBySpeciesOrName(side: BattleSnapshot["yourSide"] | BattleSnapshot["opponentSide"], name: string | null | undefined) {
  if (!name) return null;
  return side.team.find((pokemon) => namesForPokemon(pokemon).some((candidate) => normalizeName(candidate) === normalizeName(name))) ?? null;
}

function summarizeSideConditions(sideConditions: string[]) {
  const ordered: string[] = [];
  const counts = new Map<string, number>();
  for (const value of sideConditions) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (!counts.has(value)) ordered.push(value);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return ordered.map((value) => {
    const count = counts.get(value) ?? 0;
    return count > 1 ? `${value} x${count}` : value;
  });
}

function cloneFieldSnapshot(field: BattleSnapshot["field"] | null | undefined) {
  if (!field) return null;
  return {
    weather: field.weather ?? null,
    terrain: field.terrain ?? null,
    pseudoWeather: [...(field.pseudoWeather ?? [])],
    yourSideConditions: [...(field.yourSideConditions ?? [])],
    opponentSideConditions: [...(field.opponentSideConditions ?? [])]
  };
}

function extractEnteredFieldName(line: string) {
  const match = String(line).match(/^(.+?) entered the field\.$/);
  return match?.[1]?.trim() ?? null;
}

function currentTurnLines(snapshot: BattleSnapshot) {
  const startIndex = [...snapshot.recentLog]
    .map((line, index) => ({ line, index }))
    .reverse()
    .find(({ line }) => /^Turn \d+ started\./.test(String(line ?? "")))
    ?.index ?? -1;
  return startIndex >= 0 ? snapshot.recentLog.slice(startIndex + 1) : [...snapshot.recentLog];
}

function opponentActorNames(snapshot: BattleSnapshot) {
  return uniqueStrings(
    snapshot.opponentSide.team.flatMap((pokemon) => [pokemon.displayName, pokemon.species, pokemon.ident])
  ).map((value) => {
    const identName = String(value ?? "").includes(":") ? String(value).split(":").slice(1).join(":").trim() : value;
    return identName;
  });
}

function hasOpponentActionInCurrentTurn(snapshot: BattleSnapshot) {
  const names = opponentActorNames(snapshot);
  if (names.length === 0) return false;
  for (const line of currentTurnLines(snapshot)) {
    const used = extractUsedMove(String(line ?? ""));
    if (used && names.some((name) => normalizeName(name) === normalizeName(used.actor))) {
      return true;
    }
    const entered = extractEnteredFieldName(String(line ?? ""));
    if (entered && names.some((name) => normalizeName(name) === normalizeName(entered))) {
      return true;
    }
  }
  return false;
}

function extractOpponentResolvedAction(snapshot: BattleSnapshot, battle: BattleLedger) {
  const previous = battle.lastSeen;
  if (!previous) return null;
  const newLines = appendedRecentLog(previous.recentLog, snapshot.recentLog);
  if (newLines.length === 0) return null;

  const gen = gens.get(generationFromFormat(snapshot.format));
  const previousOpponentNames = uniqueStrings([previous.opponentActiveName, previous.opponentActiveSpecies]);
  const currentOpponentNames = uniqueStrings([
    snapshot.opponentSide.active?.displayName,
    snapshot.opponentSide.active?.species
  ]);

  for (const line of newLines) {
    const enteredName = extractEnteredFieldName(line);
    if (
      enteredName
      && currentOpponentNames.some((name) => normalizeName(name) === normalizeName(enteredName))
      && !previousOpponentNames.some((name) => normalizeName(name) === normalizeName(enteredName))
    ) {
      return {
        actualClass: "switch" as const,
        actualLabel: snapshot.opponentSide.active?.species ?? enteredName
      };
    }

    const used = extractUsedMove(line);
    if (used && previousOpponentNames.some((name) => normalizeName(name) === normalizeName(used.actor))) {
      const move = lookupMove(gen, used.move);
      return {
        actualClass: move?.category === "Status" ? "status_or_setup" as const : "stay_attack" as const,
        actualLabel: used.move
      };
    }
  }

  return null;
}

function maybeResolvePendingPrediction(snapshot: BattleSnapshot, battle: BattleLedger) {
  const pending = battle.pendingPrediction;
  if (!pending) return;
  const resolved = extractOpponentResolvedAction(snapshot, battle);
  if (!resolved) return;
  battle.predictionHistory = battle.predictionHistory ?? [];
  battle.predictionHistory.push({
    turn: pending.turn,
    predictedClass: pending.predictedClass,
    predictedLabel: pending.predictedLabel,
    actualClass: resolved.actualClass,
    actualLabel: resolved.actualLabel,
    matched: pending.predictedClass === resolved.actualClass,
    predictedAt: pending.predictedAt,
    resolvedAt: snapshot.capturedAt
  });
  if (battle.predictionHistory.length > 200) {
    battle.predictionHistory = battle.predictionHistory.slice(-200);
  }
  delete battle.pendingPrediction;
}

function summarizePredictionHistory(entries: Array<PredictionHistoryEntry | null | undefined>) {
  const usableEntries = entries.filter(Boolean) as PredictionHistoryEntry[];
  const byPredictedClass: Record<string, { total: number; matched: number; accuracy: number }> = {};
  for (const entry of usableEntries) {
    const bucket = byPredictedClass[entry.predictedClass] ?? { total: 0, matched: 0, accuracy: 0 };
    bucket.total += 1;
    bucket.matched += entry.matched ? 1 : 0;
    bucket.accuracy = Number((bucket.matched / bucket.total).toFixed(3));
    byPredictedClass[entry.predictedClass] = bucket;
  }
  const matched = usableEntries.filter((entry) => entry.matched).length;
  return {
    total: usableEntries.length,
    matched,
    accuracy: usableEntries.length > 0 ? Number((matched / usableEntries.length).toFixed(3)) : 0,
    byPredictedClass
  };
}

function isCleanObservedDamageWindow(lines: string[]) {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  const normalized = lines.map((line) => String(line).trim().toLowerCase());
  if (!normalized.some((line) => / used .+\.$/.test(line))) return false;
  if (normalized.some((line) => line.includes("entered the field"))) return false;
  if (normalized.some((line) => line.includes("could not move"))) return false;
  if (normalized.some((line) => line.includes("had hp change from"))) return false;
  if (normalized.some((line) => line.includes("terastallized"))) return false;
  if (normalized.some((line) => line.startsWith("winner:"))) return false;
  return true;
}

function combatStageMultiplier(stage: number) {
  if (stage >= 0) return (2 + stage) / 2;
  return 2 / (2 - stage);
}

function clampCombatStage(value: number | null | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-6, Math.min(6, Number(value)));
}

function criticalHitActorsFromLines(lines: string[]) {
  const criticalActors = new Set<string>();
  let lastMoveActor: string | null = null;
  for (const line of lines) {
    const move = extractUsedMove(line);
    if (move?.actor) {
      lastMoveActor = move.actor;
      continue;
    }
    if (/critical hit/i.test(line) && lastMoveActor) {
      criticalActors.add(normalizeName(lastMoveActor));
    }
  }
  return criticalActors;
}

function hasRelevantScreen(sideConditions: string[], category: "Physical" | "Special") {
  const normalized = sideConditions.map((value) => normalizeName(value));
  if (normalized.includes("auroraveil")) return true;
  if (category === "Physical") return normalized.includes("reflect");
  return normalized.includes("lightscreen");
}

function normalizeCriticalObservedDamage(params: {
  format: string;
  moveName: string;
  attacker: PokemonSnapshot;
  defender: PokemonSnapshot;
  field: BattleSnapshot["field"];
  attackerSide: "your" | "opponent";
  delta: number;
}) {
  const gen = gens.get(generationFromFormat(params.format));
  const move = lookupMove(gen, params.moveName);
  if (!move || move.category === "Status") {
    return Number(params.delta.toFixed(1));
  }

  let critRatio = 1.5;
  if (move.category === "Physical") {
    const attackerStage = clampCombatStage(params.attacker.boosts?.atk);
    const defenderStage = clampCombatStage(params.defender.boosts?.def);
    if (attackerStage < 0) critRatio *= combatStageMultiplier(0) / combatStageMultiplier(attackerStage);
    if (defenderStage > 0) critRatio *= combatStageMultiplier(defenderStage) / combatStageMultiplier(0);
  } else {
    const attackerStage = clampCombatStage(params.attacker.boosts?.spa);
    const defenderStage = clampCombatStage(params.defender.boosts?.spd);
    if (attackerStage < 0) critRatio *= combatStageMultiplier(0) / combatStageMultiplier(attackerStage);
    if (defenderStage > 0) critRatio *= combatStageMultiplier(defenderStage) / combatStageMultiplier(0);
  }

  const defenderSideConditions = params.attackerSide === "your"
    ? params.field.opponentSideConditions
    : params.field.yourSideConditions;
  if (hasRelevantScreen(defenderSideConditions, move.category)) {
    critRatio *= 2;
  }

  return Number((params.delta / Math.max(1, critRatio)).toFixed(1));
}

function hpDeltaWasKoCapped(
  previousHpPercent: number | null | undefined,
  currentDefender: PokemonSnapshot | null | undefined,
  delta: number
) {
  const previousHp = Number(previousHpPercent);
  if (!Number.isFinite(previousHp) || !Number.isFinite(delta) || delta <= 0) return false;
  const currentHp = Number(currentDefender?.hpPercent ?? (currentDefender?.fainted ? 0 : Number.NaN));
  if (currentDefender?.fainted || currentHp <= 0) {
    return delta >= previousHp - 0.1;
  }
  return false;
}

function maybeRecordObservedDamage(store: IntelStore, battle: BattleLedger, snapshot: BattleSnapshot) {
  const previous = battle.lastSeen;
  if (!previous) return;
  const currentYourActive = snapshot.yourSide.active;
  const currentOpponentActive = snapshot.opponentSide.active;
  if (!currentYourActive || !currentOpponentActive) return;

  const newLines = appendedRecentLog(previous.recentLog, snapshot.recentLog);
  if (!isCleanObservedDamageWindow(newLines)) return;
  const previousYourActive = previous.yourActive ?? activePokemonBySpeciesOrName(snapshot.yourSide, previous.yourActiveSpecies ?? previous.yourActiveName);
  const previousOpponentActive = previous.opponentActive ?? activePokemonBySpeciesOrName(snapshot.opponentSide, previous.opponentActiveSpecies ?? previous.opponentActiveName);
  if (!previousYourActive || !previousOpponentActive) return;
  const yourActorNames = namesForPokemon(previousYourActive);
  const opponentActorNames = namesForPokemon(previousOpponentActive);
  const opponentMoveLines = newLines
    .map((line) => extractUsedMove(line))
    .filter((entry) => entry?.actor && opponentActorNames.some((name) => normalizeName(name) === normalizeName(entry.actor)) && entry.move);
  const yourMoveLines = newLines
    .map((line) => extractUsedMove(line))
    .filter((entry) => entry?.actor && yourActorNames.some((name) => normalizeName(name) === normalizeName(entry.actor)) && entry.move);
  const criticalHitActors = criticalHitActorsFromLines(newLines);

  const opponentSpecies = currentOpponentActive.species ?? currentOpponentActive.displayName;
  const yourSpecies = currentYourActive.species ?? currentYourActive.displayName;
  if (!opponentSpecies || !yourSpecies) return;

  const { speciesKey, formatRecord } = ensureSpeciesFormat(store, opponentSpecies, snapshot.format);
  if (!battle.species[speciesKey]) {
    battle.species[speciesKey] = createBattleSpeciesLedger();
  }
  const battleSpecies = battle.species[speciesKey];
  if (!battleSpecies) return;
  const fieldForDamage = cloneFieldSnapshot(previous.field) ?? cloneFieldSnapshot(snapshot.field);
  const fieldContext = fieldDamageContextFromField(fieldForDamage);

  if (
    opponentMoveLines.length === 1 &&
    previous.yourActiveSpecies === yourSpecies &&
    previous.opponentActiveSpecies === opponentSpecies &&
    Number.isFinite(previous.yourHpPercent) &&
    Number.isFinite(currentYourActive.hpPercent)
  ) {
    const delta = Number(previous.yourHpPercent) - Number(currentYourActive.hpPercent);
    const moveName = opponentMoveLines[0]?.move ?? null;
    if (
      moveName &&
      Number.isFinite(delta) &&
      delta > 0.5 &&
      !hpDeltaWasKoCapped(previous.yourHpPercent, currentYourActive, delta)
    ) {
      const normalizedDelta = criticalHitActors.has(normalizeName(opponentMoveLines[0]?.actor ?? ""))
        ? normalizeCriticalObservedDamage({
            format: snapshot.format,
            moveName,
            attacker: previousOpponentActive,
            defender: previousYourActive,
            field: fieldForDamage ?? snapshot.field,
            attackerSide: "opponent",
            delta
          })
        : Number(delta.toFixed(1));
      const damageKey = `incoming|${moveName}|${yourSpecies}|${snapshot.turn}`;
      if (!battleSpecies.damageKeys[damageKey]) {
        battleSpecies.damageKeys[damageKey] = true;
        updateObservedDamageRecord(formatRecord.observedDamage, `${moveName}|${yourSpecies}`, normalizedDelta);
        updateObservedDamageRecord(
          formatRecord.observedDamageByContext,
          `${moveName}|${yourSpecies}|${combatContextKey(previousOpponentActive, previousYourActive, fieldContext)}`,
          normalizedDelta
        );
        battleSpecies.incomingDamage.push({
          key: damageKey,
          direction: "incoming",
          turn: snapshot.turn,
          moveName,
          percent: normalizedDelta,
          attacker: clonePokemonSnapshot(previousOpponentActive),
          defender: clonePokemonSnapshot(previousYourActive),
          field: fieldForDamage ? structuredClone(fieldForDamage) : structuredClone(snapshot.field)
        });
      }
    }
  }

  if (
    yourMoveLines.length === 1 &&
    previous.yourActiveSpecies === yourSpecies &&
    previous.opponentActiveSpecies === opponentSpecies &&
    Number.isFinite(previous.opponentHpPercent) &&
    Number.isFinite(currentOpponentActive.hpPercent)
  ) {
    const outgoingDelta = Number(previous.opponentHpPercent) - Number(currentOpponentActive.hpPercent);
    const moveName = yourMoveLines[0]?.move ?? null;
    if (
      moveName &&
      Number.isFinite(outgoingDelta) &&
      outgoingDelta > 0.5 &&
      !hpDeltaWasKoCapped(previous.opponentHpPercent, currentOpponentActive, outgoingDelta)
    ) {
      const normalizedDelta = criticalHitActors.has(normalizeName(yourMoveLines[0]?.actor ?? ""))
        ? normalizeCriticalObservedDamage({
            format: snapshot.format,
            moveName,
            attacker: previousYourActive,
            defender: previousOpponentActive,
            field: fieldForDamage ?? snapshot.field,
            attackerSide: "your",
            delta: outgoingDelta
          })
        : Number(outgoingDelta.toFixed(1));
      const takenKey = `outgoing|${moveName}|${yourSpecies}|${snapshot.turn}`;
      if (!battleSpecies.damageKeys[takenKey]) {
        battleSpecies.damageKeys[takenKey] = true;
        updateObservedDamageRecord(formatRecord.observedTakenDamage, `${moveName}|${yourSpecies}`, normalizedDelta);
        updateObservedDamageRecord(
          formatRecord.observedTakenDamageByContext,
          `${moveName}|${yourSpecies}|${combatContextKey(previousYourActive, previousOpponentActive, fieldContext)}`,
          normalizedDelta
        );
        battleSpecies.outgoingDamage.push({
          key: takenKey,
          direction: "outgoing",
          turn: snapshot.turn,
          moveName,
          percent: normalizedDelta,
          attacker: clonePokemonSnapshot(previousYourActive),
          defender: clonePokemonSnapshot(previousOpponentActive),
          field: fieldForDamage ? structuredClone(fieldForDamage) : structuredClone(snapshot.field)
        });
      }
    }
  }
}

function generationFromFormat(format: string): number {
  const match = String(format ?? "").match(/\[Gen\s*(\d+)\]/i);
  const parsed = Number.parseInt(match?.[1] ?? "9", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 9;
}

function lookupMovePriority(format: string, moveName: string | null | undefined) {
  if (!moveName) return null;
  const gen = gens.get(generationFromFormat(format));
  const direct = gen.moves.get(moveName);
  if (direct) return direct.priority ?? 0;
  const normalized = normalizeName(moveName);
  for (const move of gen.moves) {
    if (normalizeName(move.name) === normalized) {
      return move.priority ?? 0;
    }
  }
  return null;
}

function hasSpeedConfounders(snapshot: BattleSnapshot) {
  return getSpeedConfounders(snapshot).length > 0;
}

/** getSpeedConfounders entries that effectiveSpeed applies exactly to a known stat or range. */
const EXACT_SPEED_MODIFIER = /^(?:your|opponent) (?:Tailwind|paralysis|Speed boosts|Choice Scarf|Iron Ball|Quick Feet)$/;

function getSpeedConfounders(snapshot: BattleSnapshot) {
  const notes: string[] = [];
  const pseudoWeather = snapshot.field.pseudoWeather.map((value) => String(value).toLowerCase());
  const yourItem = normalizedItemId(snapshot.yourSide.active?.item);
  const opponentItem = normalizedItemId(snapshot.opponentSide.active?.item);
  const yourAbility = normalizedAbilityId(snapshot.yourSide.active?.ability);
  const opponentAbility = normalizedAbilityId(snapshot.opponentSide.active?.ability);
  if (pseudoWeather.some((value) => value.includes("trick room"))) notes.push("Trick Room");
  if (snapshot.field.yourSideConditions.some((value) => /tailwind/i.test(value))) notes.push("your Tailwind");
  if (snapshot.field.opponentSideConditions.some((value) => /tailwind/i.test(value))) notes.push("opponent Tailwind");
  if (snapshot.yourSide.active?.status === "par") notes.push("your paralysis");
  if (snapshot.opponentSide.active?.status === "par") notes.push("opponent paralysis");
  if ((snapshot.yourSide.active?.boosts?.spe ?? 0) !== 0) notes.push("your Speed boosts");
  if ((snapshot.opponentSide.active?.boosts?.spe ?? 0) !== 0) notes.push("opponent Speed boosts");
  if (yourItem === "choicescarf") notes.push("your Choice Scarf");
  if (opponentItem === "choicescarf") notes.push("opponent Choice Scarf");
  if (yourItem === "ironball") notes.push("your Iron Ball");
  if (opponentItem === "ironball") notes.push("opponent Iron Ball");
  if (yourAbility === "quickfeet" && snapshot.yourSide.active?.status) notes.push("your Quick Feet");
  if (opponentAbility === "quickfeet" && snapshot.opponentSide.active?.status) notes.push("opponent Quick Feet");
  const yourPossibleFieldSpeedAbility = formatPossibleFieldSpeedAbilityConfounder(
    "your",
    possibleFieldSpeedAbilityRules(snapshot.format, snapshot.yourSide.active, snapshot.field)
  );
  const opponentPossibleFieldSpeedAbility = formatPossibleFieldSpeedAbilityConfounder(
    "opponent",
    possibleFieldSpeedAbilityRules(snapshot.format, snapshot.opponentSide.active, snapshot.field)
  );
  if (yourPossibleFieldSpeedAbility) notes.push(yourPossibleFieldSpeedAbility);
  if (opponentPossibleFieldSpeedAbility) notes.push(opponentPossibleFieldSpeedAbility);
  for (const [label, pokemon] of [["your", snapshot.yourSide.active], ["opponent", snapshot.opponentSide.active]] as const) {
    const range = speedAbilityMultiplierRange(pokemon?.ability, snapshot.field, pokemon?.removedItem, pokemon?.paradoxBoostedStat, pokemon?.slowStartActive);
    if (range.max > 1) {
      notes.push(`${range.min !== range.max ? "possible " : ""}${label} ${pokemon?.ability} Speed boost`);
    }
    if (normalizedAbilityId(pokemon?.ability) === "slowstart" && pokemon?.slowStartActive !== false) {
      notes.push(`${label} Slow Start ${pokemon?.slowStartActive === true ? "active" : "activation unknown"}`);
    }
  }
  return notes;
}

function extractMoveNameFromLog(line: string) {
  const match = line.match(/ used (.+)\.$/i);
  return match?.[1] ?? null;
}

function extractLastTurnMoveOrder(snapshot: BattleSnapshot) {
  if (snapshot.canonicalEvidence) return null; // Prose cannot establish canonical move-order evidence.
  const yourActive = snapshot.yourSide.active;
  const opponentActive = snapshot.opponentSide.active;
  const yourNames = namesForPokemon(yourActive);
  const opponentNames = namesForPokemon(opponentActive);
  const yourSpecies = yourActive?.species ?? yourActive?.displayName;
  const opponentSpecies = opponentActive?.species ?? opponentActive?.displayName;
  const yourSpeedStat = yourActive?.stats?.spe ?? null;
  if (yourNames.length === 0 || opponentNames.length === 0 || !yourSpecies || !opponentSpecies || !Number.isFinite(yourSpeedStat)) return null;
  if (hasSpeedConfounders(snapshot)) return null;

  const startIndex = [...snapshot.recentLog]
    .map((line, index) => ({ line, index }))
    .reverse()
    .find(({ line }) => /^Turn \d+ started\./.test(line))
    ?.index ?? 0;

  const turnLines = snapshot.recentLog.slice(startIndex + 1);
  const actionIndices = turnLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => / used | could not move /i.test(line));

  const yourAction = actionIndices.find(({ line }) => lineActorMatchesNameSet(line, yourNames));
  const opponentAction = actionIndices.find(({ line }) => lineActorMatchesNameSet(line, opponentNames));
  const yourIndex = yourAction?.index;
  const opponentIndex = opponentAction?.index;
  if (typeof yourIndex !== "number" || typeof opponentIndex !== "number" || yourIndex === opponentIndex) {
    return null;
  }

  const yourMovePriority = lookupMovePriority(snapshot.format, extractMoveNameFromLog(yourAction?.line ?? ""));
  const opponentMovePriority = lookupMovePriority(snapshot.format, extractMoveNameFromLog(opponentAction?.line ?? ""));
  if (yourMovePriority !== 0 || opponentMovePriority !== 0) {
    return null;
  }

  return {
    opponentSpecies,
    yourSpecies,
    yourSpeedStat,
    relation: opponentIndex < yourIndex ? "first" : "second"
  } as const;
}

function summarizeEntries(params: {
  observedRecord: Record<string, number>;
  observedSamples: number;
  curatedRecord: Record<string, number>;
  curatedSamples: number;
  exclude?: string[];
  limit?: number;
}): LikelihoodEntry[] {
  const exclude = params.exclude ?? [];
  const limit = params.limit ?? 4;
  const confidenceDenominator = effectivePriorConfidenceSamples(params.observedSamples, params.curatedSamples);
  const totalSampleCount = params.observedSamples + params.curatedSamples;
  const observedRecordTotal = totalRecordedCounts(params.observedRecord);
  const curatedRecordTotal = totalRecordedCounts(params.curatedRecord);
  const names = new Set([
    ...Object.keys(params.observedRecord ?? {}),
    ...Object.keys(params.curatedRecord ?? {})
  ]);

  return [...names]
    .filter((name) => !exclude.includes(name))
    .map((name) => ({
      name,
      count: (params.observedRecord?.[name] ?? 0) + (params.curatedRecord?.[name] ?? 0),
      share: effectivePriorShare({
        observedCount: params.observedRecord?.[name] ?? 0,
        observedSamples: params.observedSamples,
        observedRecordTotal,
        curatedCount: params.curatedRecord?.[name] ?? 0,
        curatedSamples: params.curatedSamples,
        curatedRecordTotal
      }),
      sampleCount: totalSampleCount
    }))
    .sort((a, b) => b.share - a.share || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      confidenceTier: confidenceDenominator >= 8 ? "strong" : confidenceDenominator >= 3 ? "usable" : "thin"
    }));
}

function fallbackMoveScore(
  gen: ReturnType<Generations["get"]>,
  species: ReturnType<typeof lookupSpecies>,
  moveId: string
) {
  const move = gen.moves.get(moveId);
  if (!move || move.isNonstandard) return Number.NEGATIVE_INFINITY;
  if (LOW_SIGNAL_FALLBACK_MOVE_IDS.has(moveId)) return -1000;

  let score = 0;
  const types = species?.types ? [...species.types] : [];
  const isStab = types.includes(move.type);
  const normalizedTarget = String(move.target ?? "");
  const normalizedName = normalizeName(move.name);
  const isPivot = Boolean(move.selfSwitch) || ["uturn", "voltswitch", "flipturn", "partingshot", "chillyreception"].includes(normalizedName);
  const isRecovery = Boolean(move.heal) || /recover|roost|slackoff|softboiled|moonlight|morningsun|shoreup|synthesis|wish/i.test(normalizedName);
  const isHazard = ["stealthrock", "spikes", "toxicspikes", "stickyweb"].includes(normalizedName);
  const isRemoval = ["rapidspin", "defog", "mortalspin"].includes(normalizedName);
  const isSetup = Boolean(move.boosts) || Boolean(move.self?.boosts) || ["agility", "bulkup", "calmmind", "curse", "dragondance", "irondefense", "nastyplot", "quiverdance", "shellsmash", "shiftgear", "swordsdance", "trailblaze"].includes(normalizedName);
  const statusMove = move.category === "Status";

  if (!statusMove) {
    score += Math.max(0, Number(move.basePower ?? 0)) * (isStab ? 1.2 : 0.7);
    if (isStab) score += 28;
    if (Number(move.priority ?? 0) > 0) score += 18;
    if (Number(move.basePower ?? 0) >= 90) score += 18;
    if (Number(move.accuracy ?? 100) < 75) score -= 8;
  } else {
    score += 8;
  }

  if (isPivot) score += 26;
  if (isRecovery) score += 24;
  if (isHazard) score += 22;
  if (isRemoval) score += 20;
  if (isSetup) score += 24;
  if (move.status) score += 14;
  if (move.volatileStatus) score += 10;
  if (normalizedTarget === "self") score += 6;
  if (move.breaksProtect) score += 8;
  if (["fakeout", "firstimpression", "encore", "taunt", "knockoff", "u-turn", "uturn", "voltswitch", "rapidspin", "stealthrock", "spikes", "toxicspikes", "stickyweb", "thunderwave", "willowisp", "scald", "earthquake", "roost", "recover", "slackoff", "chillyreception"].includes(normalizedName)) {
    score += 16;
  }

  return score;
}

async function fallbackLikelyMoveEntries(
  format: string,
  speciesName: string,
  exclude: string[] = [],
  limit = 4
): Promise<LikelihoodEntry[]> {
  const cacheKey = `${generationFromFormat(format)}|${normalizeName(speciesName)}`;
  let promise = LEARNSET_FALLBACK_CACHE.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      const gen = gens.get(generationFromFormat(format));
      const species = lookupSpecies(gen, speciesName);
      const learnset = await Dex.learnsets.get(normalizeName(speciesName));
      if (!learnset?.exists || !learnset.learnset || !species) return [];
      return Object.keys(learnset.learnset)
        .filter((moveId) => {
          const sources = learnset.learnset?.[moveId] ?? [];
          return sources.some((source) => source.startsWith(String(generationFromFormat(format))));
        })
        .map((moveId) => ({
          moveId,
          name: displayNameForMoveId(gen, moveId),
          score: fallbackMoveScore(gen, species, moveId)
        }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .map((entry) => entry.name);
    })();
    LEARNSET_FALLBACK_CACHE.set(cacheKey, promise);
  }

  const excluded = new Set(exclude.map((value) => normalizeName(value)));
  const moves = (await promise)
    .filter((name) => !excluded.has(normalizeName(name)))
    .slice(0, limit);

  return moves.map((name) => ({
    name,
    count: 0,
    share: 0,
    sampleCount: 0,
    confidenceTier: "thin" as const
  }));
}

function buildSpeedNotes(
  formatRecord: IntelFormatRecord,
  yourSpeciesName: string | null | undefined,
  yourSpeedStat: number | null | undefined
) {
  if (!yourSpeciesName) return [];
  const faster = formatRecord.speedFirstVs[yourSpeciesName] ?? 0;
  const slower = formatRecord.speedSecondVs[yourSpeciesName] ?? 0;
  const notes: string[] = [];
  const speedText = Number.isFinite(yourSpeedStat) ? ` (${yourSpeedStat} Spe shown on your side)` : "";
  const fasterBounds = Object.entries(formatRecord.speedFasterThan)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([key, count]) => {
      const [spe, speciesName] = key.split("|");
      return `Observed faster than ${speciesName || "your active"} at ${spe} Spe in ${count} stored neutral-priority turns.`;
    });
  const slowerBounds = Object.entries(formatRecord.speedSlowerThan)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([key, count]) => {
      const [spe, speciesName] = key.split("|");
      return `Observed slower than ${speciesName || "your active"} at ${spe} Spe in ${count} stored neutral-priority turns.`;
    });
  notes.push(...fasterBounds, ...slowerBounds);
  if (faster > 0) {
    notes.push(`Moved before ${yourSpeciesName}${speedText} in ${faster} stored neutral-priority turns with no Trick Room, Tailwind, paralysis, or Speed-stage modifiers.`);
  }
  if (slower > 0) {
    notes.push(`Moved after ${yourSpeciesName}${speedText} in ${slower} stored neutral-priority turns with no Trick Room, Tailwind, paralysis, or Speed-stage modifiers.`);
  }
  return notes;
}

function speciesNameFromSnapshot(pokemon: PokemonSnapshot) {
  return pokemon.species ?? pokemon.displayName ?? null;
}

function estimateNonHpStat(base: number, level: number, ev: number, nature: number) {
  const evContribution = Math.floor(ev / 4);
  const core = Math.floor(((2 * base + 31 + evContribution) * level) / 100) + 5;
  return Math.floor(core * nature);
}

function inferredBattleLevel(format: string) {
  const normalized = String(format ?? "").toLowerCase();
  if (/(^|[^a-z])(lc|little cup)([^a-z]|$)/i.test(normalized)) {
    return 5;
  }
  if (/battle stadium|bss|vgc|regulation/i.test(normalized)) {
    return 50;
  }
  return 100;
}

function normalizedBattleLevel(format: string, level: number | null | undefined) {
  const inferred = inferredBattleLevel(format);
  const parsed = Number(level);
  if (!Number.isFinite(parsed) || parsed <= 0) return inferred;
  if (inferred > 5 && parsed <= 5) return inferred;
  return parsed;
}

function speedRangeForSpecies(format: string, speciesName: string | null | undefined, level: number | null | undefined) {
  if (!speciesName) return null;
  const gen = gens.get(generationFromFormat(format));
  const species = lookupSpecies(gen, speciesName);
  if (!species || !Number.isFinite(species.baseStats?.spe)) return null;
  const actualLevel = normalizedBattleLevel(format, level);
  return {
    min: estimateNonHpStat(species.baseStats.spe, actualLevel, 0, 0.9),
    max: estimateNonHpStat(species.baseStats.spe, actualLevel, 252, 1.1)
  };
}

function narrowRangeWithHistory(
  baseRange: { min: number; max: number } | null,
  formatRecord: IntelFormatRecord,
  yourSpeciesName: string | null | undefined
) {
  if (!baseRange || !yourSpeciesName) return baseRange;
  let nextMin = baseRange.min;
  let nextMax = baseRange.max;

  for (const [key, count] of Object.entries(formatRecord.speedFasterThan)) {
    const [spe, speciesName] = key.split("|");
    if (speciesName === yourSpeciesName && Number.isFinite(Number(spe)) && Number(count) >= MIN_HISTORY_SPEED_BOUND_SAMPLES) {
      nextMin = Math.max(nextMin, Number(spe) + 1);
    }
  }
  for (const [key, count] of Object.entries(formatRecord.speedSlowerThan)) {
    const [spe, speciesName] = key.split("|");
    if (speciesName === yourSpeciesName && Number.isFinite(Number(spe)) && Number(count) >= MIN_HISTORY_SPEED_BOUND_SAMPLES) {
      nextMax = Math.min(nextMax, Number(spe) - 1);
    }
  }

  if (nextMin > nextMax) {
    return baseRange;
  }
  return {
    min: nextMin,
    max: nextMax
  };
}

function narrowRangeWithCurrentObservation(
  baseRange: { min: number; max: number } | null,
  snapshot: BattleSnapshot,
  opponentSpeciesName: string | null | undefined,
  yourSpeciesName: string | null | undefined
) {
  if (!baseRange || !opponentSpeciesName || !yourSpeciesName) return baseRange;
  const observation = extractLastTurnMoveOrder(snapshot);
  if (!observation) return baseRange;
  if (normalizeName(observation.opponentSpecies) !== normalizeName(opponentSpeciesName)) return baseRange;
  if (normalizeName(observation.yourSpecies) !== normalizeName(yourSpeciesName)) return baseRange;

  const threshold = Number(observation.yourSpeedStat);
  if (!Number.isFinite(threshold)) return baseRange;
  if (observation.relation === "first") {
    const nextMin = Math.max(baseRange.min, threshold + 1);
    if (nextMin > baseRange.max) return baseRange;
    return {
      min: nextMin,
      max: baseRange.max
    };
  }
  const nextMax = Math.min(baseRange.max, threshold - 1);
  if (nextMax < baseRange.min) return baseRange;
  return {
    min: baseRange.min,
    max: nextMax
  };
}

function effectiveSpeedRangeForPokemon(
  format: string,
  range: { min: number; max: number } | null,
  pokemon: PokemonSnapshot | null | undefined,
  sideConditions: string[],
  field: BattleSnapshot["field"]
) {
  if (!range || !pokemon || pokemon.fainted || (pokemon.hpPercent ?? 100) <= 0) return null;
  const gen = generationFromFormat(format);
  const base = effectiveSpeedRange(gen, range, pokemon, sideConditions, field);
  if (!base) return null;
  const possibleRules = possibleFieldSpeedAbilityRules(format, pokemon, field);
  const possible = possibleRules.map((rule) => effectiveSpeedRange(gen, range, { ...pokemon, ability: rule.label }, sideConditions, field));
  return { min: base.min, max: Math.max(base.max, ...possible.map((candidate) => candidate?.max ?? base.max)) };
}

function effectiveShownSpeed(format: string, pokemon: PokemonSnapshot | null | undefined, sideConditions: string[], field: BattleSnapshot["field"]) {
  const shown = pokemon?.stats?.spe;
  if (!Number.isFinite(shown)) return null;
  return effectiveSpeedRangeForPokemon(
    format,
    { min: Number(shown), max: Number(shown) },
    pokemon,
    sideConditions,
    field
  );
}

function speedRelation(
  yourSpeed: { min: number; max: number } | null,
  opponentSpeed: { min: number; max: number } | null
): "faster" | "slower" | "overlap" | "unknown" {
  if (!yourSpeed || !opponentSpeed) return "unknown";
  if (yourSpeed.min > opponentSpeed.max) return "faster";
  if (yourSpeed.max < opponentSpeed.min) return "slower";
  return "overlap";
}

/** Possible abilities that change priority-0 order or Speed under these conditions. A known ability is applied
 * exactly by effectiveSpeed; an unknown one is acceptable only when no candidate of the species changes Speed. */
function orderAbilityUnsupported(format: string, mon: PokemonSnapshot, field: BattleSnapshot["field"]) {
  const known = normalizedAbilityId(mon.ability);
  const candidates = known ? [known] : Object.values(lookupSpecies(gens.get(generationFromFormat(format)), mon.canonicalSpecies ?? mon.species)?.abilities ?? {}).map(normalizedAbilityId);
  if (!candidates.length) return true;
  return candidates.some((id) => {
    if (["galewings", "triage", "stall", "quickdraw"].includes(id)) return true;
    const range = speedAbilityMultiplierRange(id, field, mon.removedItem, mon.paradoxBoostedStat, mon.slowStartActive);
    if (range.min !== range.max) return true;
    return !known && (range.min !== 1 || (id === "quickfeet" && Boolean(mon.status)) || (id === "unburden" && Boolean(mon.unburdenActive)));
  });
}

type InBattleOrderSample = { turn: number; relation: "first" | "second"; atLeast: boolean; threshold: number; otherSpecies: string;
  pokemon: PokemonSnapshot; field: BattleSnapshot["field"]; factIds: string[] };

/** Item the opponent held when an order happened. A hidden item is the one its next item fact reveals (Knock Off,
 * consumption, Frisk; the item the other side receives in a Trick); with no later item fact it is the current item. */
function itemHeldAtOrder(evidence: NonNullable<BattleSnapshot["canonicalEvidence"]>, opponent: PokemonSnapshot, sample: PokemonSnapshot, factIndex: number) {
  if (sample.item || sample.removedItem) return sample.item;
  const facts = evidence.facts, index = facts.findIndex((fact, i) => i > factIndex && fact.ownerInstanceId === opponent.instanceId && ["-item", "-enditem"].includes(fact.kind));
  const next = facts[index];
  if (!next) return opponent.item ?? null;
  if (next.kind === "-enditem") return next.args[1] ?? null;
  if (!next.args.some((arg) => /^\[from\] move: (?:trick|switcheroo)$/i.test(arg))) return next.args[1] ?? null;
  const given = facts.slice(Math.max(0, index - 2), index + 3).find((fact) => fact.kind === "-item" && fact.ownerInstanceId !== opponent.instanceId
    && fact.args.some((arg) => /^\[from\] move: (?:trick|switcheroo)$/i.test(arg)));
  return given?.args[1] ?? null;
}

/** A forme change keeps a Speed sample only when base Speed is unchanged (Mimikyu's Disguise busting mid-turn did not). */
function sameBaseSpeed(gen: ReturnType<typeof gens.get>, left: string | null | undefined, right: string | null | undefined) {
  if (normalizeName(left) === normalizeName(right)) return true;
  const a = lookupSpecies(gen, left), b = lookupSpecies(gen, right);
  return Boolean(a && b && a.baseStats.spe === b.baseStats.spe);
}

/** Priority-0, non-status move orders of the current opponent Pokemon (every stint: raw Speed cannot change), each
 * with your effective Speed and its own stage/status/Tailwind/held item at that time; Trick Room flips the
 * inequality. A forme with a different base Speed is skipped. Current modifiers are applied later. */
function inBattleOrderSamples(snapshot: BattleSnapshot): InBattleOrderSample[] {
  const evidence = snapshot.canonicalEvidence, opponent = snapshot.opponentSide.active;
  if (!evidence || !opponent?.instanceId || !opponent.appearanceId) return [];
  const gen = gens.get(generationFromFormat(snapshot.format));
  const factsById = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const factIndex = new Map(evidence.facts.map((fact, index) => [fact.id, index]));
  const samples: InBattleOrderSample[] = [];
  for (const contribution of evidence.contributions) {
    const sample = contribution.speed;
    if (contribution.metric !== "speed" || contribution.eligibility !== "active" || !sample || !contribution.factIds.length
        || contribution.instanceId !== opponent.instanceId || sample.pokemon.instanceId !== opponent.instanceId
        || !sameBaseSpeed(gen, sample.pokemon.species, opponent.species)) continue;
    const facts = contribution.factIds.map((id) => factsById.get(id));
    if (facts.some((fact) => !fact || fact.source.channel === "recovery")) continue;
    const turnFacts = facts.filter((fact): fact is NonNullable<typeof fact> => fact!.turn === sample.turn);
    const moveFacts = turnFacts.filter((fact) => fact.kind === "move");
    if (moveFacts.length !== (sample.unacted ? 1 : 2) || moveFacts.some((fact) => fact.args.some((arg) => arg.startsWith("[from]")))
        || turnFacts.some((fact) => fact.args.some((arg) => /quick claw|custap|quick draw|lagging tail|full incense/i.test(arg)))) continue;
    const moves = (sample.unacted ? [sample.moveName] : [sample.moveName, sample.otherMoveName]).map((name) => lookupMove(gen, name));
    if (moves.some((move) => !move || move.category === "Status" || move.priority !== 0 || ["grassyglide", "round"].includes(normalizeName(move.name)))) continue;
    if (sample.unacted && !unactedOrderBounds(gen, sample.other)) continue;
    if ([sample.pokemon, sample.other].some((mon) => ["quickclaw", "custapberry", "laggingtail", "fullincense"].includes(normalizedItemId(mon.item)))) continue;
    const field = effectiveSpeedField(sample.field, [sample.pokemon, sample.other]);
    if (orderAbilityUnsupported(snapshot.format, sample.pokemon, field) || orderAbilityUnsupported(snapshot.format, sample.other, field)) continue;
    const yours = effectiveShownSpeed(snapshot.format, sample.other, field.yourSideConditions, field);
    if (!yours || yours.min !== yours.max) continue;
    const trickRoom = field.pseudoWeather.some((name) => /trick room/i.test(name));
    const ownMove = moveFacts.find((fact) => fact.ownerInstanceId === opponent.instanceId);
    const held = itemHeldAtOrder(evidence, opponent, sample.pokemon, ownMove ? factIndex.get(ownMove.id) ?? -1 : -1);
    if (["quickclaw", "custapberry", "laggingtail", "fullincense"].includes(normalizedItemId(held))) continue;
    samples.push({ turn: sample.turn, relation: sample.relation, atLeast: (sample.relation === "first") !== trickRoom, threshold: yours.min,
      otherSpecies: sample.other.canonicalSpecies ?? sample.other.species ?? "your active", pokemon: { ...sample.pokemon, item: held }, field, factIds: contribution.factIds });
  }
  return samples.sort((a, b) => a.turn - b.turn);
}

/** Our active fainted to a priority-0 move before acting: it chose a move (a switch comes first), and that move had
 * priority 0 unless its request could have held a lower-priority one. Only then is the KO a Speed order (an item-free
 * Armarouge that KOs a 353-Speed Thundurus first must hold a Choice Scarf). Our own moves are known exactly. */
function unactedOrderBounds(gen: ReturnType<typeof gens.get>, own: PokemonSnapshot) {
  if (!own.knownMoves.length || normalizedAbilityId(own.ability) === "myceliummight") return false;
  return own.knownMoves.every((name) => { const move = lookupMove(gen, name); return move && move.priority >= 0 && !move.flags.recharge; });
}

/** Raw (pre-modifier) Speed interval consistent with every sample, ties allowed. `item` undefined keeps each
 * sample's own known item (none when hidden); a name assumes that held item. Empty interval: null. */
function boundedRawSpeed(format: string, rawRange: { min: number; max: number } | null, samples: InBattleOrderSample[], item?: string) {
  if (!rawRange) return null;
  const genNum = generationFromFormat(format);
  let { min, max } = rawRange;
  for (const sample of samples) {
    const mon = item === undefined ? sample.pokemon : { ...sample.pokemon, item, removedItem: null };
    const paradox = speedAbilityMultiplierRange(mon.ability, sample.field, mon.removedItem, mon.paradoxBoostedStat, mon.slowStartActive).min === 1.5;
    const fits = (raw: number) => {
      const speed = effectiveSpeed(genNum, raw, mon, sample.field.opponentSideConditions, sample.field, paradox);
      return speed !== null && (sample.atLeast ? speed >= sample.threshold : speed <= sample.threshold);
    };
    // Effective Speed is monotone in raw Speed: binary-search the feasible edge.
    let lo = min, hi = max;
    if (sample.atLeast) {
      if (!fits(max)) return null;
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (fits(mid)) hi = mid; else lo = mid + 1; }
      min = lo;
    } else {
      if (!fits(min)) return null;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
      max = lo;
    }
  }
  return { min, max };
}

function formatOrderSamples(samples: InBattleOrderSample[]) {
  return samples.map((sample) => `T${sample.turn} ${sample.relation === "first" ? "before" : "after"} ${sample.otherSpecies} ${sample.threshold}`).join("; ");
}

function relationSummary(relation: "faster" | "slower" | "overlap" | "unknown", trickRoomActive: boolean) {
  if (relation === "faster") {
    return trickRoomActive ? "Faster on raw Speed; Trick Room flips move order." : "Faster.";
  }
  if (relation === "slower") {
    return trickRoomActive ? "Slower on raw Speed; Trick Room flips move order." : "Slower.";
  }
  if (relation === "overlap") {
    return trickRoomActive ? "Ranges overlap; Trick Room flips move order." : "Range overlap.";
  }
  return trickRoomActive ? "Speed unclear; Trick Room flips move order." : "Speed unclear.";
}

function compactRelationLabel(relation: "faster" | "slower" | "overlap" | "unknown") {
  if (relation === "faster") return "you faster";
  if (relation === "slower") return "you slower";
  if (relation === "overlap") return "speed overlap";
  return "speed unclear";
}

function formatRange(range: { min: number; max: number } | null | undefined) {
  if (!range) return null;
  return range.min === range.max ? `${range.min}` : `${range.min}-${range.max}`;
}

function likelySpeedItemEntries(likelyItems: LikelihoodEntry[] | undefined) {
  return (likelyItems ?? []).filter((entry) => {
    const itemId = normalizedItemId(entry.name);
    if (!["choicescarf", "ironball"].includes(itemId)) return false;
    return entry.confidenceTier === "strong" || entry.confidenceTier === "usable" || entry.share >= 0.45;
  });
}

function possibleItemAdjustedSpeedRange(params: {
  format: string;
  neutralRange: { min: number; max: number } | null;
  currentRange: { min: number; max: number } | null;
  pokemon: PokemonSnapshot | null | undefined;
  sideConditions: string[];
  field: BattleSnapshot["field"];
  likelyItems: LikelihoodEntry[] | undefined;
  /** In-battle order makes Choice Scarf decidable even without a prior. */
  extraItems?: string[] | undefined;
  /** Raw range consistent with in-battle order under an assumed item; null rules the item out. */
  neutralFor?: ((item: string) => { min: number; max: number } | null) | undefined;
}) {
  if (!params.neutralRange || !params.currentRange || !params.pokemon || params.pokemon.item || params.pokemon.removedItem) {
    return null;
  }

  const candidates = [...likelySpeedItemEntries(params.likelyItems).map((entry) => entry.name), ...(params.extraItems ?? [])]
    .filter((name, index, all) => all.findIndex((other) => normalizedItemId(other) === normalizedItemId(name)) === index)
    .map((name) => ({ name }));
  if (candidates.length === 0) return null;

  let range: { min: number; max: number } | null = null;
  const labels: string[] = [];
  for (const candidate of candidates) {
    const neutral = params.neutralFor ? params.neutralFor(candidate.name) : params.neutralRange;
    if (!neutral) continue;
    const adjusted = effectiveSpeedRangeForPokemon(
      params.format,
      neutral,
      {
        ...params.pokemon,
        item: candidate.name,
        removedItem: null
      },
      params.sideConditions,
      params.field
    );
    if (!adjusted) continue;
    if (adjusted.min === params.currentRange.min && adjusted.max === params.currentRange.max) continue;
    range = range
      ? {
          min: Math.min(range.min, adjusted.min),
          max: Math.max(range.max, adjusted.max)
        }
      : adjusted;
    labels.push(candidate.name);
  }

  if (!range || labels.length === 0) return null;
  return {
    range,
    labels: uniqueStrings(labels)
  };
}

function buildCurrentSpeedIntel(
  snapshot: BattleSnapshot,
  speciesName: string,
  formatRecord: IntelFormatRecord,
  likelyItems?: LikelihoodEntry[]
) {
  const observedField = snapshot.field;
  snapshot = { ...snapshot, field: effectiveSpeedField(observedField, [snapshot.yourSide.active, snapshot.opponentSide.active]) };
  const opponentActive = snapshot.opponentSide.active;
  if (!opponentActive || normalizeName(speciesNameFromSnapshot(opponentActive)) !== normalizeName(speciesName)) {
    return {
      currentSpeedRange: undefined,
      possibleSpeedRange: undefined,
      currentSpeedSummary: undefined,
      switchSpeedMatchups: undefined,
      speedEvidence: undefined,
      speedConfounders: undefined,
      speedReason: undefined
    };
  }

  const trickRoomActive = snapshot.field.pseudoWeather.some((value) => /trick room/i.test(value));
  // The relation below applies these exactly (effectiveSpeed: paralysis, stages, Tailwind, revealed Scarf/Iron Ball, Quick
  // Feet); they confound only the legacy raw-stat path. Listing them made every guard read "may move first" (e.g. a
  // paralysed Serperior at 117–178 vs a 459-Speed Arcanine). Possible abilities stay: their range is shown widened.
  const confounders = getSpeedConfounders(snapshot).filter((entry) => !EXACT_SPEED_MODIFIER.test(entry));
  const activeYourSpecies = snapshot.yourSide.active?.species ?? snapshot.yourSide.active?.displayName;
  const speciesRange = speedRangeForSpecies(snapshot.format, speciesName, opponentActive.level);
  // Canonical snapshots: one bound per opponent active stint from its observed priority-0 order. The legacy
  // prose/aggregate narrowing below only serves non-canonical /api snapshots.
  const orderSamples = snapshot.canonicalEvidence ? inBattleOrderSamples(snapshot) : [];
  const observation = snapshot.canonicalEvidence ? null : extractLastTurnMoveOrder(snapshot);
  const itemHidden = !opponentActive.item && !opponentActive.removedItem && orderSamples.every((sample) => !sample.pokemon.item && !sample.pokemon.removedItem);
  // Choice Scarf stays a hypothesis only while the item is hidden and no stint has used two moves.
  const scarfPossible = itemHidden && !choiceRefutedByStint(opponentActive);
  const orderBound = orderSamples.length ? boundedRawSpeed(snapshot.format, speciesRange, orderSamples) : null;
  const scarfBound = orderSamples.length && scarfPossible ? boundedRawSpeed(snapshot.format, speciesRange, orderSamples, "Choice Scarf") : null;
  const impliedItem = orderSamples.length && !orderBound && scarfBound ? "Choice Scarf" : null;
  const conflict = orderSamples.length > 0 && !orderBound && !impliedItem;
  const neutralRange = snapshot.canonicalEvidence
    ? (impliedItem ? scarfBound : orderBound) ?? speciesRange
    : narrowRangeWithCurrentObservation(narrowRangeWithHistory(speciesRange, formatRecord, activeYourSpecies), snapshot, speciesName, activeYourSpecies);
  const rangeMon = impliedItem ? { ...opponentActive, item: impliedItem } : opponentActive;
  const opponentRange = effectiveSpeedRangeForPokemon(
    snapshot.format,
    neutralRange,
    rangeMon,
    snapshot.field.opponentSideConditions,
    snapshot.field
  );
  const possibleItemRange = impliedItem || conflict ? null : possibleItemAdjustedSpeedRange({
    format: snapshot.format,
    neutralRange,
    currentRange: opponentRange,
    pokemon: opponentActive,
    sideConditions: snapshot.field.opponentSideConditions,
    field: snapshot.field,
    likelyItems,
    ...(orderSamples.length ? { extraItems: scarfPossible ? ["Choice Scarf"] : [], neutralFor: (item: string) => boundedRawSpeed(snapshot.format, speciesRange, orderSamples, item) } : {})
  });
  const activeSpeed = effectiveShownSpeed(snapshot.format, snapshot.yourSide.active, snapshot.field.yourSideConditions, snapshot.field);
  const relation = conflict ? "unknown" : speedRelation(activeSpeed, opponentRange);
  if (conflict) confounders.push("observed order contradicts the supported Speed range; unresolved modifier");
  const activeSpeedText = formatRange(activeSpeed);
  const opponentSpeedText = formatRange(opponentRange);
  const historyFaster = activeYourSpecies ? formatRecord.speedFirstVs[activeYourSpecies] ?? 0 : 0;
  const historySlower = activeYourSpecies ? formatRecord.speedSecondVs[activeYourSpecies] ?? 0 : 0;
  const yourActiveFainted = Boolean(snapshot.yourSide.active && (snapshot.yourSide.active.fainted || (snapshot.yourSide.active.hpPercent ?? 100) <= 0));
  const hasYourShownSpeed = !yourActiveFainted && Number.isFinite(snapshot.yourSide.active?.stats?.spe ?? null);
  const speedEvidence: SpeedEvidenceTag[] = [];
  const orderText = formatOrderSamples(orderSamples);
  const orderFactIds = uniqueStrings(orderSamples.flatMap((sample) => sample.factIds));
  if (orderSamples.length && !conflict) {
    speedEvidence.push(impliedItem
      ? { kind: "item_ability_assumption", label: `${impliedItem} implied (${orderText})`, detail: "Observed order exceeds the item-free Speed range; the item stays unrevealed.", factIds: orderFactIds }
      : { kind: "current_turn_order", label: `Observed order: ${orderText}`, detail: `Raw Speed ${formatRange(neutralRange)} after applying the order.`, factIds: orderFactIds });
    if (!impliedItem && scarfPossible && !scarfBound) speedEvidence.push({ kind: "item_ability_assumption", label: "Choice Scarf ruled out by observed order", factIds: orderFactIds });
  }
  const usedLegacyObservation = Boolean(
    observation &&
    normalizeName(observation.opponentSpecies) === normalizeName(speciesName) &&
    normalizeName(observation.yourSpecies) === normalizeName(activeYourSpecies)
  );
  const usedCurrentTurnObservation = (orderSamples.length > 0 && !conflict) || usedLegacyObservation;
  if (usedLegacyObservation) {
    speedEvidence.push({
      kind: "current_turn_order",
      label: observation?.relation === "first" ? "Opponent moved first this turn" : "You moved first this turn",
      detail: Number.isFinite(observation?.yourSpeedStat) ? `Threshold from your shown ${observation?.yourSpeedStat} Spe.` : undefined
    });
  }
  if (historyFaster > 0 || historySlower > 0) {
    const trustedHistoryThresholds = [
      ...Object.entries(formatRecord.speedFasterThan).filter(([key, count]) => key.endsWith(`|${activeYourSpecies}`) && Number(count) >= MIN_HISTORY_SPEED_BOUND_SAMPLES),
      ...Object.entries(formatRecord.speedSlowerThan).filter(([key, count]) => key.endsWith(`|${activeYourSpecies}`) && Number(count) >= MIN_HISTORY_SPEED_BOUND_SAMPLES)
    ].length;
    speedEvidence.push({
      kind: "history",
      label: `Stored neutral-priority speed samples: ${historyFaster + historySlower}`,
      detail: `${historyFaster > 0 && historySlower > 0
        ? `${historyFaster} faster / ${historySlower} slower`
        : historyFaster > 0
          ? `${historyFaster} faster`
          : `${historySlower} slower`}${trustedHistoryThresholds > 0 ? `; ${trustedHistoryThresholds} threshold${trustedHistoryThresholds === 1 ? "" : "s"} trusted for narrowing` : "; single samples stay advisory"}`
    });
  }
  const opponentItemId = normalizedItemId(opponentActive.item);
  const opponentAbilityId = normalizedAbilityId(opponentActive.ability);
  const revealedFieldSpeedAbility = matchingFieldSpeedAbilityRule(opponentAbilityId, snapshot.field);
  if (
    opponentItemId === "choicescarf"
    || opponentItemId === "ironball"
    || (opponentAbilityId === "quickfeet" && opponentActive.status)
    || revealedFieldSpeedAbility
  ) {
    speedEvidence.push({
      kind: "item_ability_assumption",
      label: "Opponent revealed a Speed-modifying item or ability",
      detail: [
        opponentActive.item,
        opponentAbilityId === "quickfeet" && opponentActive.status ? "Quick Feet" : null,
        revealedFieldSpeedAbility?.label ?? null
      ].filter(Boolean).join(", ")
    });
  }
  if (possibleItemRange) {
    speedEvidence.push({
      kind: "item_ability_assumption",
      label: `Possible item range: ${formatRange(possibleItemRange.range)}`,
      detail: possibleItemRange.labels.join(", ")
    });
  }
  if (!hasYourShownSpeed) {
    speedEvidence.push({
      kind: "capture_gap",
      label: yourActiveFainted ? "Your active has fainted" : "Your active Speed stat is missing from the captured snapshot",
      detail: yourActiveFainted ? "Use the living replacement Speed comparisons." : "State capture could not compare your exact live Speed against the opponent range yet."
    });
  }
  if (confounders.length > 0) {
    speedEvidence.push({
      kind: "confounded",
      label: conflict ? "Observed order conflicts with the supported Speed range" : "Current turn order is confounded",
      detail: conflict ? `${confounders.join(", ")} (${orderText})` : confounders.join(", "),
      ...(conflict ? { factIds: orderFactIds } : {})
    });
  }
  if (speedEvidence.length === 0) {
    speedEvidence.push({
      kind: "base_range",
      label: "Only species base-range estimate is available"
    });
  }
  const speedReason: "history" | "current_turn_order" | "item_ability_assumption" | "confounded" | "base_range" | "capture_gap" = confounders.length > 0
    ? "confounded"
    : !hasYourShownSpeed
      ? "capture_gap"
      : usedCurrentTurnObservation
        ? "current_turn_order"
        : historyFaster > 0 || historySlower > 0
          ? "history"
          : speedEvidence.some((entry) => entry.kind === "item_ability_assumption")
            ? "item_ability_assumption"
            : "base_range";
  const currentSpeedSummary = opponentSpeedText
    ? [
        activeSpeedText ? `You ${activeSpeedText}; ${conflict ? "conditional model" : "live"} ${opponentSpeedText}.` : `Live ${opponentSpeedText}.`,
        possibleItemRange ? `Item range ${formatRange(possibleItemRange.range)} via ${possibleItemRange.labels.join(", ")}.` : null,
        !activeSpeedText ? (yourActiveFainted ? "Compare living replacements." : "Your Speed is missing.") : null,
        trickRoomActive ? "Trick Room flips order." : null,
        confounders.length > 0 ? `Confounded by ${confounders.join(", ")}.` : null
      ].filter(Boolean).join(" ")
    : undefined;

  const switchSpeedMatchups: SwitchSpeedMatchup[] = snapshot.yourSide.team
    .filter((pokemon) => !pokemon.fainted)
    .map((pokemon) => {
      const entry = !pokemon.active ? projectSwitchEntry(snapshot, pokemon, "your") : null;
      const entering = entry?.pokemon ?? pokemon;
      const switchedField = effectiveSpeedField(observedField, [entering, opponentActive]);
      const speed = entry && (!entry.speedCertain || entry.fainted) ? null : effectiveShownSpeed(snapshot.format, entering, switchedField.yourSideConditions, switchedField);
      const switchedOpponentRange = effectiveSpeedRangeForPokemon(snapshot.format, neutralRange, rangeMon, switchedField.opponentSideConditions, switchedField);
      return {
        instanceId: pokemon.instanceId,
        species: pokemon.species ?? pokemon.displayName ?? "Unknown",
        effectiveSpeed: speed && speed.min === speed.max ? speed.min : null,
        relation: conflict ? "unknown" : speedRelation(speed, switchedOpponentRange)
      };
    })
    .filter((entry) => entry.effectiveSpeed !== null || entry.relation !== "unknown")
    .sort((a, b) => (Number(b.effectiveSpeed ?? -1) - Number(a.effectiveSpeed ?? -1)));

  return {
    currentSpeedRange: opponentRange ?? undefined,
    possibleSpeedRange: possibleItemRange?.range ?? undefined,
    currentSpeedSummary,
    switchSpeedMatchups: switchSpeedMatchups.length > 0 ? switchSpeedMatchups : undefined,
    neutralRange: neutralRange ?? undefined,
    activeRelation: relation,
    activeSpeed: activeSpeed && activeSpeed.min === activeSpeed.max ? activeSpeed.min : undefined,
    speedEvidence: speedEvidence,
    speedConfounders: confounders,
    speedReason
  };
}

function pickThreatMoves(entry: OpponentIntelEntry | undefined) {
  if (!entry) return { moves: [], omitted: [] };
  const knownMoves = entry.revealedMoves.map((name) => ({ name, source: "known" as const }));
  const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Set(knownMoves.map((move) => key(move.name)));
  const omitted: NonNullable<LocalIntelSnapshot["opponentThreatCoverage"]>["omittedMoves"] = [];
  const likelyMoves = entry.likelyMoves
    .filter((move) => {
      if (seen.has(key(move.name))) return false;
      const admitted = move.sampleCount > 0 || move.confidenceTier !== "thin" || move.share >= 0.45;
      if (!admitted) omitted.push({ name: move.name, reason: "admission_threshold" });
      return admitted;
    })
    .map((move) => ({ name: move.name, source: "likely" as const }));
  const moves: Array<{ name: string; source: "known" | "likely" }> = knownMoves.slice(0, 4);
  for (const move of [...likelyMoves, ...(entry.metaMovePrior?.moves ?? []).map((move) => ({ name: move.name, source: "likely" as const }))]) {
    if (seen.has(key(move.name))) continue;
    seen.add(key(move.name));
    if (moves.length < 4) moves.push(move);
    else omitted.push({ name: move.name, reason: "move_slot_limit" });
  }
  // A monthly candidate can supersede a zero-sample fallback's rejection.
  return { moves, omitted: omitted.filter((entry) => !moves.some((move) => key(move.name) === key(entry.name))) };
}

function summarizeObservedThreats(
  observedDamage: Record<string, { count: number; min: number; max: number; total: number }> | undefined
) {
  const result: Record<string, { minPercent: number; maxPercent: number; sampleCount: number }> = {};
  for (const [key, value] of Object.entries(observedDamage ?? {})) {
    if (!value || !Number.isFinite(value.count) || value.count <= 0) continue;
    result[key] = {
      minPercent: Number(value.min.toFixed(1)),
      maxPercent: Number(value.max.toFixed(1)),
      sampleCount: value.count
    };
  }
  return result;
}

function summarizeObservedThreatsWithContext(
  observedAggregate: Record<string, { count: number; min: number; max: number; total: number }> | undefined,
  observedByContext: Record<string, { count: number; min: number; max: number; total: number }> | undefined,
  attacker: PokemonSnapshot | null | undefined,
  defender: PokemonSnapshot | null | undefined,
  fieldContext = "weather:none|terrain:none|pseudo:none|your:none|opp:none",
  allowAggregateFallback = true
) {
  const aggregate = summarizeObservedThreats(observedAggregate);
  const result: Record<string, { minPercent: number; maxPercent: number; sampleCount: number; source: "context" | "aggregate" }> = {};
  const contextKey = combatContextKey(attacker, defender, fieldContext);

  if (allowAggregateFallback) {
    for (const [key, value] of Object.entries(aggregate)) {
      result[key] = { ...value, source: "aggregate" };
    }
  }
  for (const [key, value] of Object.entries(observedByContext ?? {})) {
    if (!value || !Number.isFinite(value.count) || value.count <= 0) continue;
    if (!key.endsWith(`|${contextKey}`)) continue;
    const baseKey = key.slice(0, -1 * (`|${contextKey}`.length));
    result[baseKey] = {
      minPercent: Number(value.min.toFixed(1)),
      maxPercent: Number(value.max.toFixed(1)),
      sampleCount: value.count,
      source: "context"
    };
  }
  return result;
}

function applySnapshotToStore(store: IntelStore, snapshot: BattleSnapshot): void {
    const battle = ensureBattleLedger(store, snapshot);
    maybeResolvePendingPrediction(snapshot, battle);
    maybeRecordOpponentLead(store, battle, snapshot);
    maybeRecordObservedDamage(store, battle, snapshot);

    for (const pokemon of snapshot.opponentSide.team) {
      const speciesName = speciesNameFromSnapshot(pokemon);
      if (!speciesName) continue;

      const { speciesKey, formatRecord } = ensureSpeciesFormat(store, speciesName, snapshot.format);
      if (!battle.species[speciesKey]) {
        battle.species[speciesKey] = createBattleSpeciesLedger();
      }
      const battleSpecies = battle.species[speciesKey];
      if (!battleSpecies) continue;

      if (!battleSpecies.battleRecorded && pokemon.revealed) {
        battleSpecies.battleRecorded = true;
        formatRecord.battlesSeen += 1;
      }

      for (const moveName of pokemon.knownMoves) {
        maybeRecordCount(formatRecord.moves, battleSpecies.moves, moveName);
      }
      maybeRecordCount(formatRecord.items, battleSpecies.items, revealedItemName(pokemon));
      maybeRecordCount(formatRecord.abilities, battleSpecies.abilities, pokemon.ability);
      if (pokemon.terastallized && pokemon.teraType) {
        maybeRecordCount(formatRecord.teraTypes, battleSpecies.teraTypes, pokemon.teraType);
      }
    }

    const speedObservation = extractLastTurnMoveOrder(snapshot);
    if (speedObservation) {
      const { speciesKey, formatRecord } = ensureSpeciesFormat(store, speedObservation.opponentSpecies, snapshot.format);
      if (!battle.species[speciesKey]) {
        battle.species[speciesKey] = createBattleSpeciesLedger();
      }
      const battleSpecies = battle.species[speciesKey];
      if (!battleSpecies) return;
      const speedKey = `${speedObservation.relation}:${speedObservation.yourSpecies}`;
      if (!battleSpecies.speedKeys[speedKey]) {
        battleSpecies.speedKeys[speedKey] = true;
        const thresholdKey = `${speedObservation.yourSpeedStat}|${speedObservation.yourSpecies}`;
        if (speedObservation.relation === "first") {
          incrementCount(formatRecord.speedFirstVs, speedObservation.yourSpecies);
          incrementCount(formatRecord.speedFasterThan, thresholdKey);
        } else {
          incrementCount(formatRecord.speedSecondVs, speedObservation.yourSpecies);
          incrementCount(formatRecord.speedSlowerThan, thresholdKey);
        }
        battleSpecies.speedObservations.push({
          key: `${snapshot.turn}:${speedKey}`,
          turn: snapshot.turn,
          relation: speedObservation.relation,
          yourSpecies: speedObservation.yourSpecies,
          yourSpeedStat: Number(speedObservation.yourSpeedStat)
        });
      }
    }

    const staleThreshold = Date.now() - 1000 * 60 * 60 * 24 * 30;
    for (const [roomId, ledger] of Object.entries(store.battles)) {
      if (new Date(ledger.updatedAt).getTime() < staleThreshold) {
        delete store.battles[roomId];
      }
    }

    battle.lastSeen = {
      recentLog: [...snapshot.recentLog],
      yourActiveName: snapshot.yourSide.active?.displayName ?? snapshot.yourSide.active?.species ?? null,
      yourActiveSpecies: snapshot.yourSide.active?.species ?? snapshot.yourSide.active?.displayName ?? null,
      opponentActiveName: snapshot.opponentSide.active?.displayName ?? snapshot.opponentSide.active?.species ?? null,
      opponentActiveSpecies: snapshot.opponentSide.active?.species ?? snapshot.opponentSide.active?.displayName ?? null,
      yourHpPercent: snapshot.yourSide.active?.hpPercent ?? null,
      opponentHpPercent: snapshot.opponentSide.active?.hpPercent ?? null,
      yourActive: snapshot.yourSide.active ? clonePokemonSnapshot(snapshot.yourSide.active) : null,
      opponentActive: snapshot.opponentSide.active ? clonePokemonSnapshot(snapshot.opponentSide.active) : null,
      field: cloneFieldSnapshot(snapshot.field)
    };
}

export async function updateLocalIntelFromSnapshot(snapshot: BattleSnapshot): Promise<void> {
  await withStoreWrite((store) => applySnapshotToStore(store, snapshot));
}

export interface IntelEvaluationContext {
  readonly revision: string;
  readonly store: Readonly<IntelStore>;
  readonly movePriors?: MetaMovePrior;
  readonly analysisMode?: "policy-only";
}

// Only server private fields used by the mechanics projection support a damage
// context. Client-added presentation fields cannot conflict with that support.
function privateHistorySupport(request: any) {
  const fields = ["ident", "details", "condition", "active", "stats", "item", "ability", "baseAbility", "boosts", "teraType", "moves", "reviving"];
  return { rqid: request?.rqid ?? null, side: request?.side?.id ?? null,
    pokemon: (request?.side?.pokemon ?? []).map((entry: any) => Object.fromEntries(fields.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]))) };
}

/** Empty observed/curated pools and optional explicit monthly move priors.
 * Memory-only: never reads or writes the user's history or curated files. */
export async function createEphemeralIntelEvaluationContext(prior?: MetaMovePrior): Promise<IntelEvaluationContext> {
  const movePriors = prior === undefined ? undefined : detachMetaMovePrior(prior);
  const store = structuredClone(EMPTY_STORE);
  return { revision: await hashCanonical(movePriors ? { store, metaPriorRevision: movePriors.revision } : store), store, ...(movePriors ? { movePriors } : {}) };
}

/** Pure canonical history projection shared by ingestion and offline matches.
 * The input context and snapshots stay pinned. Time and persistence belong to
 * the caller; repeated input has the same revision, including empty input. */
export async function projectCanonicalSnapshots(
  snapshots: readonly BattleSnapshot[], context: IntelEvaluationContext
): Promise<IntelEvaluationContext> {
  const movePriors = context.movePriors;
  const store = await projectCanonicalStore(snapshots, context.store, context.analysisMode !== "policy-only");
  return { revision: await hashCanonical(movePriors ? { store, metaPriorRevision: movePriors.revision } : store), store,
    ...(movePriors ? { movePriors } : {}), ...(context.analysisMode ? { analysisMode: context.analysisMode } : {}) };
}

/** The projection on a new store object. Only the projected rooms' records are copied: every other part is shared
 * with `source`, which is never modified. */
async function projectCanonicalStore(snapshots: readonly BattleSnapshot[], source: Readonly<IntelStore>, includeContributions = true): Promise<IntelStore> {
  const store: IntelStore = { ...source, canonicalBattles: { ...(source.canonicalBattles ?? {}) } };
  for (const snapshot of snapshots) {
    if (!snapshot.canonicalEvidence) throw new Error("Canonical history requires fact-derived contributions.");
    // A private recovery epoch cannot establish missing public identity or
    // lifecycle. Keep the last trusted history context until capture resets.
    if (snapshot.canonicalEvidence.limitations.includes("recovery_public_continuity_unknown")) continue;
    store.canonicalBattles ??= {};
    const previous = store.canonicalBattles[snapshot.roomId];
    const confirmedFacts = { ...(previous?.confirmedFacts ?? {}) };
    const signatures = new Map(await Promise.all(snapshot.canonicalEvidence.facts.map(async (fact) =>
      [fact.id, await hashCanonical(fact.kind === "request" ? privateHistorySupport(JSON.parse(fact.args.join("|"))) : { kind: fact.kind, args: fact.args })] as const)));
    const lineageConflict = snapshot.canonicalEvidence.facts.some((fact) => fact.kind !== "request" && confirmedFacts[fact.id] && confirmedFacts[fact.id] !== signatures.get(fact.id));
    // A capture holding the protocol |init| covers the whole battle (e.g. a page reload re-joining it), so it supersedes
    // an earlier record of that room. Unaligned partial captures still cannot replace confirmed history.
    const fromStart = snapshot.canonicalEvidence.facts.some((fact) => fact.kind === "init" && fact.source.channel === "protocol");
    if (lineageConflict && !fromStart) {
      if (previous) store.canonicalBattles[snapshot.roomId] = { ...previous, lineageConflict: true };
      continue;
    }
    if (lineageConflict) for (const id of Object.keys(confirmedFacts)) delete confirmedFacts[id];
    for (const fact of snapshot.canonicalEvidence.facts) if (fact.source.channel !== "recovery") confirmedFacts[fact.id] = signatures.get(fact.id)!;
    const contributions = new Map((includeContributions ? ((lineageConflict ? undefined : previous?.contributions) ?? []) : []).map((entry) => [entry.id, entry]));
    for (const prior of contributions.values()) {
      const direct = snapshot.canonicalEvidence.facts.find((fact) => (`${fact.id}:${prior.metric}` === prior.id || prior.id.startsWith(`${fact.id}:${prior.metric}:`)));
      if (direct?.source.channel === "protocol" && direct.identityStatus !== "resolved") contributions.set(prior.id, { ...prior, eligibility: "quarantined" });
    }
    for (const contribution of includeContributions ? snapshot.canonicalEvidence.contributions : []) {
      if (!contribution.instanceId.includes(`:${snapshot.opponentSide.slot}:`)) continue;
      // Recovery can reuse exactly confirmed semantic support; lower coverage
      // alone must never erase an earlier verified contribution.
      if (contribution.factIds.every((id) => Boolean(confirmedFacts[id]) && confirmedFacts[id] === signatures.get(id))) contributions.set(contribution.id, { ...structuredClone(contribution), eligibility: "active" });
    }
    store.canonicalBattles[snapshot.roomId] = { format: snapshot.format, confirmedFacts,
      contributions: [...contributions.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  }
  return store;
}

/** Stage every canonical snapshot in one store view and install it as the observed history (written behind, see
 * installStore). All fallible context construction precedes installation. */
export function commitCanonicalSnapshots(snapshots: BattleSnapshot[], movePriors?: MetaMovePrior, parentCheck: () => void = () => {}): Promise<IntelEvaluationContext> {
  const prior = movePriors === undefined ? undefined : detachMetaMovePrior(movePriors);
  const run = writeChain.then(() => withinDeadline("canonical history commit", 3000, async (check) => {
    const fence = () => { check(); parentCheck(); };
    fence();
    const source = await readStore(fence);
    fence();
    let store = source;
    if (snapshots.length) {
      store = await projectCanonicalStore(snapshots, source);
      store.updatedAt = new Date().toISOString();
    }
    const context: IntelEvaluationContext = { revision: await storeRevision(store, prior), store, ...(prior ? { movePriors: prior } : {}) };
    fence();
    if (store !== source) installStore(store, false);
    return context;
  }));
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Capture observed history and curated priors once for reproducible evaluation. */
export async function captureIntelEvaluationContext(): Promise<IntelEvaluationContext> {
  await writeChain;
  return withinDeadline("history context", 3000, async (check) => {
    const store = await readStore(check);
    return { revision: await storeRevision(store), store };
  });
}

/** Only provenance-backed contributions enter the canonical observed pool.
 * Old aggregate-only rows are retained on disk for inspection/legacy tooling,
 * but cannot silently become verified canonical priors. Rebuilding buckets
 * also permits correct retraction of future damage extrema. */
function canonicalHistoryView(source: Readonly<IntelStore>): IntelStore {
  // The owner's pre-canonical battles (legacy ledger) still describe real opponents' sets: seed their set counts.
  // Damage and speed observations stay canonical-only (they need the canonical ledger's integrity checks).
  const species: IntelStore["species"] = {};
  for (const [key, record] of Object.entries(source.species ?? {})) {
    species[key] = { species: record.species, formats: Object.fromEntries(Object.entries(record.formats ?? {}).map(([format, legacy]) => {
      const counts = normalizeFormatRecord(structuredClone(legacy));
      return [format, { ...createFormatRecord(), battlesSeen: counts.battlesSeen, leadCount: counts.leadCount,
        moves: counts.moves, items: counts.items, abilities: counts.abilities, teraTypes: counts.teraTypes }];
    })) };
  }
  const view: IntelStore = { ...source, species, battles: {} };
  for (const [roomId, projection] of Object.entries(source.canonicalBattles ?? {})) {
    const battle: BattleLedger = { roomId, format: projection.format, updatedAt: source.updatedAt, species: {}, instances: {} };
    view.battles[roomId] = battle;
    for (const contribution of projection.contributions) {
      if (contribution.eligibility !== "active") continue;
      const { speciesKey, formatRecord } = ensureSpeciesFormat(view, contribution.species, projection.format);
      const ledger = battle.species[speciesKey] ??= createBattleSpeciesLedger();
      if (contribution.metric === "damage" && contribution.damage) {
        const instance = battle.instances![contribution.instanceId] ??= createBattleSpeciesLedger();
        const sample = contribution.damage;
        const incoming = sample.attacker.instanceId === contribution.instanceId;
        const other = incoming ? sample.defender : sample.attacker;
        const observation: PosteriorBattleDamageObservation = { key: contribution.id, direction: incoming ? "incoming" : "outgoing", ...sample, factIds: contribution.factIds };
        const privateStatsKnown = ["hp", "atk", "def", "spa", "spd", "spe"].every((stat) => Number.isFinite(other.stats?.[stat]));
        if (privateStatsKnown) (incoming ? instance.incomingDamage : instance.outgoingDamage).push(observation);
        const key = `${sample.moveName}|${other.canonicalSpecies ?? other.species}`;
        const byContext = `${key}|${combatContextKey(sample.attacker, sample.defender, fieldDamageContextFromField(sample.field))}`;
        // Aggregate ranges are illustrative. Exact context ranges and posterior
        // observations retain the actual private stats and field at impact.
        updateObservedDamageRecord(incoming ? formatRecord.observedDamage : formatRecord.observedTakenDamage, key, sample.percent);
        if (privateStatsKnown) updateObservedDamageRecord(incoming ? formatRecord.observedDamageByContext : formatRecord.observedTakenDamageByContext, byContext, sample.percent);
      } else if (contribution.metric === "speed") {
        const sample = contribution.speed;
        if (!sample) continue;
        const facts = contribution.factIds.map((id) => projection.confirmedFacts[id]);
        if (facts.some((signature) => !signature)) continue;
        const observation = canonicalSpeedObservation(contribution, projection.format);
        if (observation) {
          const instance = battle.instances![contribution.instanceId] ??= createBattleSpeciesLedger();
          instance.speedObservations.push(observation);
        }
      } else if (contribution.metric === "battle-seen") {
        if (!ledger.battleRecorded) { ledger.battleRecorded = true; formatRecord.battlesSeen++; }
      } else if (contribution.metric !== "damage") {
        const field = { move: "moves", item: "items", ability: "abilities", tera: "teraTypes" }[contribution.metric] as "moves" | "items" | "abilities" | "teraTypes";
        maybeRecordCount(formatRecord[field], ledger[field], contribution.value);
      }
    }
  }
  return view;
}

/** An observed action order is not a strict Speed inequality. Initially use
 * only known ordering modifiers; unsupported/hidden contexts remain raw facts. */
function canonicalSpeedObservation(contribution: NonNullable<BattleSnapshot["canonicalEvidence"]>["contributions"][number], format: string): PosteriorBattleSpeedObservation | null {
  const sample = contribution.speed;
  if (!sample || !contribution.factIds.length || sample.field.pseudoWeather.some((name) => /trick room|magic room/i.test(name))) return null;
  // Prankster and Mycelium Might act only on status moves, which are excluded below.
  const unsupportedAbilities = new Set(["galewings", "triage", "stall", "quickdraw", "slowstart", "klutz", "neutralizinggas", "cloudnine", "airlock"]);
  const unsupportedItems = new Set(["quickclaw", "custapberry", "laggingtail", "fullincense", "quickpowder", "machobrace", "poweranklet", "powerband", "powerbelt", "powerbracer", "powerlens", "powerweight"]);
  for (const mon of [sample.pokemon, sample.other]) {
    // The opponent's hidden item is a posterior hypothesis (Choice Scarf can explain the order); a hidden ability
    // is acceptable only when no ability the species can have changes Speed or priority-0 order here.
    const opponent = mon === sample.pokemon;
    const hiddenAbilityOk = opponent && !mon.ability && !orderAbilityUnsupported(format, mon, effectiveSpeedField(sample.field, [sample.pokemon, sample.other]));
    if ((!mon.ability && !hiddenAbilityOk) || (!opponent && !mon.item && !mon.removedItem) || unsupportedAbilities.has(normalizeName(mon.ability)) || unsupportedItems.has(normalizeName(mon.item)) || unsupportedItems.has(normalizeName(mon.removedItem))) return null;
    if (normalizeName(mon.ability) === "unburden" && mon.unburdenActive === undefined) return null;
    const range = speedAbilityMultiplierRange(mon.ability, sample.field, mon.removedItem, mon.paradoxBoostedStat);
    if (range.min !== range.max) return null;
  }
  for (const moveName of sample.unacted ? [sample.moveName] : [sample.moveName, sample.otherMoveName]) {
    const move = lookupMove(gens.get(generationFromFormat(format)), moveName);
    if (!move || move.category === "Status" || move.priority !== 0 || ["grassyglide", "round"].includes(normalizeName(move.name))) return null;
  }
  if (sample.unacted && !unactedOrderBounds(gens.get(generationFromFormat(format)), sample.other)) return null;
  const speed = effectiveShownSpeed(format, sample.other, sample.field.yourSideConditions, sample.field);
  if (!speed || speed.min !== speed.max || speed.min <= 0) return null;
  return { key: contribution.id, turn: sample.turn, relation: sample.relation,
    yourSpecies: sample.other.canonicalSpecies ?? sample.other.species ?? "Unknown", yourSpeedStat: speed.min,
    opponent: sample.pokemon, field: sample.field, factIds: contribution.factIds };
}

/** How one of our living Pokémon answers an opposing one, from the engine's own calcs: it outspeeds every Speed the
 * opponent can have (Trick Room excluded) and KOs it at the likely band's minimum, or it survives every considered hit
 * and then KOs it. A bench Pokémon is projected through entry hazards; an uncertain projection is no answer. */
export interface OwnAnswer { kind: "outspeeds_ko" | "survives_ko"; move: string; ko: { min: number; max: number }; yourSpeed?: number; theirMaxSpeed?: number }
export function ownAnswerTo(snapshot: BattleSnapshot, intel: LocalIntelSnapshot, own: PokemonSnapshot, opponent: PokemonSnapshot): OwnAnswer | null {
  if (own.fainted || opponent.fainted || !Number.isFinite(opponent.hpPercent) || (opponent.hpPercent ?? 0) <= 0) return null;
  const entry = own.active ? null : projectSwitchEntry(snapshot, own, "your");
  if (entry && (entry.fainted || !entry.hpCertain || !entry.speedCertain || !entry.damageQualified)) return null;
  const mon = { ...(entry?.pokemon ?? own), active: true };
  const them = { ...opponent, active: true, ...(opponent.active ? {} : { boosts: {} }) };
  if (!Number.isFinite(mon.hpPercent) || (mon.hpPercent ?? 0) <= 0) return null;
  const info = intel.opponents.find((candidate) => candidate.instanceId ? candidate.instanceId === opponent.instanceId : normalizeName(candidate.species) === normalizeName(speciesNameFromSnapshot(opponent)));
  const gen = gens.get(generationFromFormat(snapshot.format));
  const moves = uniqueStrings((own.knownMoves ?? []).map((name) => lookupMove(gen, name)?.name ?? "").filter((name) => name && lookupMove(gen, name)?.category !== "Status"));
  if (!moves.length) return null;
  const versus = { ...snapshot, yourSide: { ...snapshot.yourSide, active: mon, team: [mon] }, opponentSide: { ...snapshot.opponentSide, active: them } };
  const likelyItems = liveLikelyHeldItems(snapshot.format, them, info?.likelyItems, snapshot.recentLog);
  const damage = buildDamagePreview({ ...versus, legalActions: moves.map((name, index) => ({ id: `answer:${index}`, kind: "move" as const, label: name, moveName: name, moveSlot: index + 1, choice: `move ${index + 1}` })) }, {
    likelyDefenderItems: likelyItems, likelyDefenderAbilities: info?.likelyAbilities.map((item) => item.name) ?? [], defenderPosterior: info?.posterior });
  const kos = damage.map((preview) => ({ move: preview.moveName, band: preview.bands.find((band) => band.label === "likely") }))
    .filter(({ band }) => band && (band.outcome ?? "damage") === "damage" && Number.isFinite(band.minPercent) && band.minPercent! >= opponent.hpPercent!)
    .sort((a, b) => b.band!.minPercent! - a.band!.minPercent!);
  const ko = kos[0];
  if (!ko) return null;
  const koBand = { min: ko.band!.minPercent!, max: ko.band!.maxPercent! };
  const trickRoom = snapshot.field.pseudoWeather.some((value) => /trick room/i.test(value));
  const field = effectiveSpeedField(snapshot.field, [mon, them]);
  const yours = effectiveShownSpeed(snapshot.format, mon, field.yourSideConditions, field);
  let theirMax: number | null = null;
  if (opponent.active && opponent.instanceId === snapshot.opponentSide.active?.instanceId && intel.speedPreview?.effectiveRange && intel.speedPreview.activeRelation !== "unknown") {
    theirMax = Math.max(intel.speedPreview.effectiveRange.max, intel.speedPreview.possibleRange?.max ?? 0);
  } else {
    const neutral = speedRangeForSpecies(snapshot.format, speciesNameFromSnapshot(them), them.level);
    const current = effectiveSpeedRangeForPokemon(snapshot.format, neutral, them, field.opponentSideConditions, field);
    const possible = possibleItemAdjustedSpeedRange({ format: snapshot.format, neutralRange: neutral, currentRange: current, pokemon: them,
      sideConditions: field.opponentSideConditions, field, likelyItems: info?.likelyItems });
    theirMax = current ? Math.max(current.max, possible?.range.max ?? 0) : null;
  }
  if (!trickRoom && yours && yours.min === yours.max && theirMax !== null && yours.min > theirMax) {
    return { kind: "outspeeds_ko", move: ko.move, ko: koBand, yourSpeed: yours.min, theirMaxSpeed: theirMax };
  }
  const threats = buildThreatPreview(versus, {
    moveCandidates: info ? pickThreatMoves(info).moves : (opponent.knownMoves ?? []).map((name) => ({ name, source: "known" as const })),
    likelyAttackerItems: likelyItems, likelyAttackerAbilities: info?.likelyAbilities.map((item) => item.name) ?? [],
    likelyAttackerProfile: info?.ladderAttackProfile, attackerPosterior: info?.posterior });
  if (!threats.length) return null;
  const survives = threats.every((threat) => {
    const band = threat.currentTarget.bands.find((candidate) => candidate.label === "likely");
    if (!band) return false;
    return (band.outcome ?? "damage") !== "damage" || (Number.isFinite(band.maxPercent) && band.maxPercent! < mon.hpPercent!);
  });
  return survives ? { kind: "survives_ko", move: ko.move, ko: koBand } : null;
}

/** The order verdict under Showdown's controls. While the item is hidden and a Choice item is still possible (no stint
 * with two moves), a Choice Scarf can flip "faster": the engine's item range when it has one, else Scarf on the current
 * maximum (a Scarf Hydreigon can outspeed a 353-Speed Thundurus while its item-free range is "208-324"). Item evidence
 * (Scarf implied or ruled out by order) or a revealed or proven item ends that caveat (Boots proven by Stealth Rock must
 * drop "unless Choice Scarf"). The relation is on raw Speed: under Trick Room the slower Pokémon moves first. Speed says
 * nothing about priority: possible priority moves are named. */
export function speedVerdict(speed: SpeedPreview, opponent: PokemonSnapshot | null | undefined, trickRoom = false): NonNullable<SpeedPreview["verdict"]> {
  const you = speed.yourActiveEffectiveSpeed, them = speed.effectiveRange ?? speed.neutralRange ?? speed.possibleRange;
  const range = (value: { min: number; max: number }) => value.min === value.max ? `${Math.round(value.min)}` : `${Math.round(value.min)}-${Math.round(value.max)}`;
  const nums = Number.isFinite(you) && them ? ` (you ${Math.round(you!)} vs ${range(them)})` : "";
  const scarfOpen = Boolean(opponent && !opponent.item && !opponent.removedItem && !choiceRefutedByStint(opponent))
    && !speed.evidence.some((entry) => entry.kind === "item_ability_assumption");
  const scarfMax = speed.possibleRange?.max ?? (scarfOpen && them && Number.isFinite(them.max) ? Math.floor(them.max * 1.5) : null);
  const known = new Set((opponent?.knownMoves ?? []).map(normalizeName));
  const priority = (speed.priorityMoves ?? []).map((name) => `they ${known.has(normalizeName(name)) ? "have" : "may have"} ${name} (priority)`).join("; ");
  const suffix = priority ? `; ${priority}` : "";
  if (!trickRoom && speed.activeRelation === "faster" && Number.isFinite(you) && scarfMax && you! <= scarfMax) {
    return { text: `You move first unless Choice Scarf (their max ${Math.round(scarfMax)})${nums}${suffix}`, tone: "overlap" };
  }
  const order = !trickRoom ? speed.activeRelation : speed.activeRelation === "faster" ? "slower" : speed.activeRelation === "slower" ? "faster" : speed.activeRelation;
  const verdict = { faster: "You move first", slower: "They move first", overlap: "Speed uncertain", unknown: "Speed unknown" }[order];
  return { text: `${verdict}${trickRoom ? " (Trick Room)" : ""}${nums}${suffix}`, tone: priority && order === "faster" ? "overlap" : order };
}

/** Each of our moves against every opposing Pokémon seen so far, shown when hovering over the move. The active's band is the damage section's own; a benched one is
 * computed as if it were in now: its current HP, no boosts, its revealed or likely set and posterior, its Tera once used. */
export function buildMoveTargetPreview(snapshot: BattleSnapshot, opponents: OpponentIntelEntry[], activeRows: DamagePreview[], events: InferenceEvent[]): MoveTargetPreview[] {
  const moves = snapshot.legalActions.filter((action) => action.kind === "move" && action.moveName && !action.terastallize);
  const you = snapshot.yourSide.active, active = snapshot.opponentSide.active;
  if (!moves.length || !you || you.fainted) return [];
  const likely = (bands: DamageAssumptionBand[] | undefined) => {
    const band = bands?.find((entry) => entry.label === "likely") ?? bands?.[0];
    if (!band) return null;
    // A damaging move that rolls 0 everywhere has no effect (typing or an immunity the calc applied).
    const none = !band.outcome && band.maxPercent === 0;
    return { ...band, detail: undefined, ...(none ? { outcome: "immune" as const } : {}) };
  };
  const rows = new Map(moves.map((action) => [action.id, [] as MoveTargetPreview["targets"]]));
  for (const mon of snapshot.opponentSide.team) {
    if (mon.identityStatus !== "resolved" || mon.fainted || !((mon.hpPercent ?? 100) > 0)) continue;
    const isActive = Boolean(active && mon.instanceId === active.instanceId);
    const info = opponents.find((entry) => entry.instanceId ? entry.instanceId === mon.instanceId : normalizeName(entry.species) === normalizeName(speciesNameFromSnapshot(mon)));
    const them: PokemonSnapshot = { ...mon, active: true, boosts: isActive ? mon.boosts : {} };
    const damage = isActive ? activeRows : buildDamagePreview({ ...snapshot, legalActions: moves, opponentSide: { ...snapshot.opponentSide, active: them } }, {
      likelyDefenderItems: liveLikelyHeldItems(snapshot.format, them, info?.likelyItems, snapshot.recentLog, events.filter((event) => event.instanceId === mon.instanceId)),
      likelyDefenderAbilities: info?.likelyAbilities.map((entry) => entry.name) ?? [], defenderPosterior: info?.posterior });
    for (const action of moves) {
      const row = damage.find((entry) => entry.actionId === action.id);
      rows.get(action.id)!.push({ ...(mon.instanceId ? { instanceId: mon.instanceId } : {}), species: speciesNameFromSnapshot(mon) ?? "Unknown", active: isActive,
        hpPercent: mon.hpPercent ?? null, ...(mon.terastallized && mon.teraType ? { teraType: mon.teraType } : {}), band: row && !row.delayed ? likely(row.bands) : null });
    }
  }
  return moves.map((action) => ({ actionId: action.id, moveName: action.moveName!, targets: rows.get(action.id)! }));
}

/** Sections of the deterministic evaluation, in the order they complete. Each partial result is the full result's own
 * fields (the same objects and values), so a later stage only adds to an earlier one. */
export const INTEL_STAGES = ["board", "damage", "threats"] as const;
export type IntelStage = typeof INTEL_STAGES[number];
export type IntelStageListener = (stage: IntelStage, partial: LocalIntelSnapshot) => void | Promise<void>;
// Each stage is synchronous CPU; yielding between them lets the server send what is ready, and the model worker's reply
// be read, before the next stage runs.
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** An opposing appearance that is only possibly an Illusion user in disguise: it shows a team-preview instance (presumed)
 * and is the sole identity gap. Advice then uses the shown species, says so, and adds the Illusion user's own view.
 * Driven by the Illusion ability and Team Preview (canonical ledger), never by species. */
export async function illusionPresumption(snapshot: BattleSnapshot) {
  const shown = snapshot.opponentSide.active;
  const ambiguities = snapshot.canonicalEvidence?.ambiguities ?? [];
  if (!shown?.presumedInstanceId || !ambiguities.length || ambiguities.some((id) => id !== shown.appearanceId)) return undefined;
  const candidates = snapshot.opponentSide.team.filter((mon) => mon.instanceId && mon.instanceId !== shown.presumedInstanceId
    && shown.candidateInstanceIds?.includes(mon.instanceId));
  if (!candidates.length) return undefined;
  // An Illusion user uses its own moves: one it cannot learn, used in this stint (not called by another move), rules it
  // out. With every candidate ruled out, the shown species is proven (users is empty: no caveat).
  const used = uniqueStrings((snapshot.canonicalEvidence?.facts ?? []).filter((fact) => fact.kind === "move" && fact.subject.appearanceId === shown.appearanceId
    && !fact.args.some((arg) => arg.startsWith("[from]"))).map((fact) => fact.args[1])).filter((move) => normalizeName(move) !== "struggle");
  const users: PokemonSnapshot[] = [];
  for (const candidate of candidates) {
    if ((await Promise.all(used.map((move) => mayLearn(snapshot.format, candidate.species ?? "", move)))).every(Boolean)) users.push(candidate);
  }
  return { shown, users, used };
}
/** Whether a species (or its pre-evolutions) can know a move in this generation; unknown data never rules it out. */
async function mayLearn(format: string, speciesName: string, moveName: string) {
  const gen = String(generationFromFormat(format)), move = normalizeName(moveName);
  for (let species = Dex.species.get(speciesName), depth = 0; species?.exists && depth < 4; species = Dex.species.get(species.prevo ?? ""), depth++) {
    const learnset = await Dex.learnsets.get(species.id) ?? (species.baseSpecies !== species.name ? await Dex.learnsets.get(normalizeName(species.baseSpecies)) : undefined);
    if (!learnset?.exists || !learnset.learnset) return true;
    if ((learnset.learnset[move] ?? []).some((source) => source.startsWith(gen))) return true;
    if (!species.prevo) return false;
  }
  return true;
}

/** The board as it would be if the Illusion user were the one on the field: its own species with the shown state. */
function illusionUserView(snapshot: BattleSnapshot, user: PokemonSnapshot, used: string[]): BattleSnapshot {
  const shown = snapshot.opponentSide.active!;
  const active: PokemonSnapshot = { ...structuredClone(user), active: true, identityStatus: "resolved", hpPercent: shown.hpPercent,
    conditionText: shown.conditionText, status: shown.status, fainted: shown.fainted, boosts: structuredClone(shown.boosts),
    knownMoves: uniqueStrings([...user.knownMoves, ...used]), terastallized: shown.terastallized,
    teraType: shown.terastallized ? shown.teraType : user.teraType, ...(shown.turnsSinceEntry !== undefined ? { turnsSinceEntry: shown.turnsSinceEntry } : {}) };
  return { ...snapshot, opponentSide: { ...snapshot.opponentSide, active,
    team: snapshot.opponentSide.team.map((mon) => mon.instanceId === user.instanceId ? active : mon.presumedInstanceId ? { ...mon, active: false } : mon) },
    ...(snapshot.canonicalEvidence ? { canonicalEvidence: { ...snapshot.canonicalEvidence, ambiguities: [] } } : {}) };
}
const ALTERNATIVE_DONE = Symbol("illusion alternative complete");

export async function buildLocalIntelSnapshot(snapshot: BattleSnapshot, context?: IntelEvaluationContext, onStage?: IntelStageListener): Promise<LocalIntelSnapshot> {
  if (context?.analysisMode === "policy-only") return {
    generatedAt: "", note: "Policy-only collection; advisory analysis omitted.", opponents: []
  };
  const illusion = await illusionPresumption(snapshot);
  if (snapshot.canonicalEvidence?.ambiguities.length && !illusion) return { generatedAt: new Date().toISOString(), note: "identity_ambiguous: species-dependent advice withheld", opponents: [] };
  const capturedStore = (context ?? await captureIntelEvaluationContext()).store;
  const store = snapshot.canonicalEvidence ? canonicalHistoryView(capturedStore) : capturedStore;
  const activeBattle = store.battles[snapshot.roomId];
  const mergedOpponents = new Map<
    string,
    {
      pokemon: PokemonSnapshot;
      species: string;
      displayName: string | null;
      revealedMoves: Set<string>;
      revealedItem: string | null;
      revealedAbility: string | null;
      revealedTeraType: string | null;
    }
  >();

  const observedOpponentTeam = snapshot.opponentSide.team.length > 0
    ? snapshot.opponentSide.team
    : snapshot.opponentSide.active
      ? [snapshot.opponentSide.active]
      : [];

  for (const pokemon of observedOpponentTeam) {
    const speciesName = speciesNameFromSnapshot(pokemon);
    if (!speciesName) continue;
    if (pokemon.identityStatus && pokemon.identityStatus !== "resolved" && !(illusion && pokemon.presumedInstanceId)) continue;
    const instanceKey = pokemon.instanceId ?? normalizeName(speciesName);
    const existing = mergedOpponents.get(instanceKey);
    const preferredSpecies =
      existing?.species && !existing.species.includes("*")
        ? existing.species
        : speciesName.includes("*") && existing?.species
          ? existing.species
          : speciesName;
    const merged = existing ?? {
      pokemon,
      species: preferredSpecies,
      displayName: pokemon.displayName,
      revealedMoves: new Set<string>(),
      revealedItem: revealedItemName(pokemon),
      revealedAbility: pokemon.ability ?? null,
      revealedTeraType: pokemon.teraType ?? null
    };
    merged.pokemon = pokemon;
    merged.species = preferredSpecies;
    if (!merged.displayName && pokemon.displayName) merged.displayName = pokemon.displayName;
    for (const moveName of pokemon.knownMoves) merged.revealedMoves.add(moveName);
    if (!merged.revealedItem && revealedItemName(pokemon)) merged.revealedItem = revealedItemName(pokemon);
    if (!merged.revealedAbility && pokemon.ability) merged.revealedAbility = pokemon.ability;
    if (!merged.revealedTeraType && pokemon.teraType) merged.revealedTeraType = pokemon.teraType;
    mergedOpponents.set(instanceKey, merged);
  }

  const allInferenceEvents = parseInferenceEvents(snapshot);

  const posteriors = new Map<OpponentIntelEntry, () => OpponentIntelEntry["posterior"]>();
  const opponents: OpponentIntelEntry[] = await Promise.all([...mergedOpponents.values()].map(async (merged) => {
    const speciesKey = normalizeName(merged.species);
    const speciesRecord = store.species[speciesKey];
    const formatRecord = normalizeFormatRecord(speciesRecord?.formats?.[snapshot.format]);
    const curatedFormatRecord = externalCuratedFormatRecord(store, speciesKey, snapshot.format);
    const confidenceSamples = effectivePriorConfidenceSamples(formatRecord.battlesSeen, curatedFormatRecord.teamCount);
    const speciesInferenceEvents = allInferenceEvents.filter(
      (e) => e.side === "opponent" && (merged.pokemon.instanceId ? e.instanceId === merged.pokemon.instanceId : normalizeName(e.species) === speciesKey)
    );
    const revealedMoves = [...merged.revealedMoves];
    const sampledItems = summarizeEntries({
      observedRecord: formatRecord.items,
      observedSamples: formatRecord.battlesSeen,
      curatedRecord: curatedFormatRecord.items,
      curatedSamples: curatedFormatRecord.teamCount,
      exclude: merged.revealedItem ? [merged.revealedItem] : []
    });
    // Monthly ladder usage is an additional, provenance-tagged source after the owner's observed/curated entries.
    const withMonthly = (sampled: LikelihoodEntry[], kind: "items" | "abilities" | "teraTypes", revealed: string | null) => !context?.movePriors ? sampled
      : [...sampled, ...metaSetPriorEntries(context.movePriors, snapshot.format, merged.species, kind, [...(revealed ? [revealed] : []), ...sampled.map((entry) => entry.name)])];
    const likelyItems = filterLiveLikelyHeldItemEntries(
      snapshot.format,
      merged.pokemon,
      withMonthly(sampledItems, "items", merged.revealedItem),
      { recentLog: snapshot.recentLog, inferenceEvents: speciesInferenceEvents }
    );
    const likelyAbilities = withMonthly(summarizeEntries(
      {
        observedRecord: formatRecord.abilities,
        observedSamples: formatRecord.battlesSeen,
        curatedRecord: curatedFormatRecord.abilities,
        curatedSamples: curatedFormatRecord.teamCount,
        exclude: merged.revealedAbility ? [merged.revealedAbility] : []
      }
    ), "abilities", merged.revealedAbility);
    const currentSpeedIntel = buildCurrentSpeedIntel(snapshot, merged.species, formatRecord, likelyItems);
    // A presumed disguise uses its shown instance's own (resolved) battle evidence.
    const historyInstance = merged.pokemon.presumedInstanceId ?? merged.pokemon.instanceId;
    const battleSpecies = normalizeBattleSpeciesLedger(historyInstance ? activeBattle?.instances?.[historyInstance] : activeBattle?.species?.[speciesKey]);
    const importInfo = store.externalCurated.imports[snapshot.format] ?? null;
    // The posterior is the costly part (all skeletons x archetypes x observations): built for the active opponent first,
    // the others after the damage and threat stages.
    const posterior = () => buildOpponentPosterior({
      format: snapshot.format,
      opponent: merged.pokemon,
      battleSnapshot: snapshot,
      formatStats: {
        observedBattlesSeen: formatRecord.battlesSeen,
        curatedTeamCount: curatedFormatRecord.teamCount,
        observedMoves: formatRecord.moves,
        observedItems: formatRecord.items,
        observedAbilities: formatRecord.abilities,
        observedTeraTypes: formatRecord.teraTypes,
        curatedMoves: curatedFormatRecord.moves,
        curatedItems: curatedFormatRecord.items,
        curatedAbilities: curatedFormatRecord.abilities,
        curatedTeraTypes: curatedFormatRecord.teraTypes,
        ...(context?.movePriors ? { ladderItems: metaSetPriorEntries(context.movePriors, snapshot.format, merged.species, "items", [], 12),
          ladderMoves: metaMoveInclusion(context.movePriors, snapshot.format, merged.species) } : {})
      },
      battleEvidence: {
        incomingDamage: battleSpecies.incomingDamage,
        outgoingDamage: battleSpecies.outgoingDamage,
        speedObservations: battleSpecies.speedObservations
      },
      inferenceEvents: speciesInferenceEvents
    });
    const likelyMovesFromHistory = revealedMoves.length >= 4
      ? []
      : summarizeEntries({
          observedRecord: formatRecord.moves,
          observedSamples: formatRecord.battlesSeen,
          curatedRecord: curatedFormatRecord.moves,
          curatedSamples: curatedFormatRecord.teamCount,
          exclude: revealedMoves
        });
    const metaMovePrior = context?.movePriors ? metaMovePriorView(context.movePriors, snapshot.format, merged.species, revealedMoves) : undefined;
    // The ladder's modal attacking spread, and its most used item still live for this Pokémon (none once one is known).
    const ladderSpreads = context?.movePriors ? metaAttackProfile(context.movePriors, snapshot.format, merged.species) : undefined;
    const ladderItem = context?.movePriors ? metaSetPriorEntries(context.movePriors, snapshot.format, merged.species, "items", [], 8)
      .find((entry) => filterLiveLikelyHeldItemNames(snapshot.format, merged.pokemon, [entry.name], { recentLog: snapshot.recentLog, inferenceEvents: speciesInferenceEvents }).length)?.name : undefined;
    const ladderAttackProfile = ladderSpreads || ladderItem ? { ...ladderSpreads, ...(ladderItem ? { item: ladderItem } : {}) } : undefined;
    const likelyMoves = revealedMoves.length >= 4
      ? []
      : likelyMovesFromHistory.length > 0
      ? likelyMovesFromHistory
      : await fallbackLikelyMoveEntries(snapshot.format, merged.species, revealedMoves, 4);

    const entry = {
      instanceId: merged.pokemon.instanceId,
      species: merged.species,
      displayName: merged.displayName,
      battlesSeen: formatRecord.battlesSeen,
      curatedTeamCount: curatedFormatRecord.teamCount,
      blendedPriorCount: Math.round(confidenceSamples * 1000) / 1000,
      externalCurated: curatedFormatRecord.teamCount > 0
        ? {
            channel: "external_curated",
            sourceKind: "sample_teams",
            teamCount: curatedFormatRecord.teamCount,
            effectiveConfidenceSamples: Math.round(confidenceSamples * 1000) / 1000,
            import: importInfo
          }
        : undefined,
      historicalLeadCount: formatRecord.leadCount,
      historicalLeadShare: formatRecord.battlesSeen > 0 ? Number((formatRecord.leadCount / formatRecord.battlesSeen).toFixed(3)) : 0,
      currentTerastallized: Boolean(merged.pokemon?.terastallized),
      revealedMoves,
      revealedItem: merged.revealedItem,
      revealedAbility: merged.revealedAbility,
      revealedTeraType: merged.revealedTeraType,
      likelyMoves,
      ...(metaMovePrior ? { metaMovePrior } : {}),
      ...(ladderAttackProfile ? { ladderAttackProfile } : {}),
      likelyItems,
      likelyAbilities,
      likelyTeraTypes: withMonthly(summarizeEntries(
        {
          observedRecord: formatRecord.teraTypes,
          observedSamples: formatRecord.battlesSeen,
          curatedRecord: curatedFormatRecord.teraTypes,
          curatedSamples: curatedFormatRecord.teamCount,
          exclude: merged.revealedTeraType ? [merged.revealedTeraType] : []
        }
      ), "teraTypes", merged.revealedTeraType),
      neutralSpeedRange: currentSpeedIntel.neutralRange,
      currentSpeedRange: currentSpeedIntel.currentSpeedRange,
      possibleSpeedRange: currentSpeedIntel.possibleSpeedRange,
      activeYourEffectiveSpeed: currentSpeedIntel.activeSpeed,
      activeSpeedRelation: currentSpeedIntel.activeRelation,
      currentSpeedSummary: currentSpeedIntel.currentSpeedSummary,
      speedReason: currentSpeedIntel.speedReason,
      speedEvidence: currentSpeedIntel.speedEvidence,
      speedConfounders: currentSpeedIntel.speedConfounders,
      switchSpeedMatchups: currentSpeedIntel.switchSpeedMatchups,
      speedNotes: buildSpeedNotes(
        formatRecord,
        snapshot.yourSide.active?.species ?? snapshot.yourSide.active?.displayName,
        snapshot.yourSide.active?.stats?.spe ?? null
      ),
    } satisfies OpponentIntelEntry as OpponentIntelEntry;
    posteriors.set(entry, posterior);
    return entry;
  }));
  const withPosterior = (entry: OpponentIntelEntry | undefined) => {
    const build = entry && posteriors.get(entry);
    if (build) { posteriors.delete(entry); entry.posterior = build(); }
    return Boolean(build);
  };

  const activeOpponentSpecies = snapshot.opponentSide.active?.species ?? snapshot.opponentSide.active?.displayName ?? null;
  const activeOpponentEntry = opponents.find((entry) => snapshot.opponentSide.active?.instanceId ? entry.instanceId === snapshot.opponentSide.active.instanceId : normalizeName(entry.species) === normalizeName(activeOpponentSpecies));
  const activeSpeciesKey = normalizeName(activeOpponentSpecies);
  const activeSpeciesRecord = activeSpeciesKey ? store.species[activeSpeciesKey] : undefined;
  const activeFormatRecord = normalizeFormatRecord(activeSpeciesRecord?.formats?.[snapshot.format]);
  const activeOpponentInferenceEvents = allInferenceEvents.filter(
    (e) => e.side === "opponent" && (snapshot.opponentSide.active?.instanceId ? e.instanceId === snapshot.opponentSide.active.instanceId : normalizeName(e.species) === activeSpeciesKey)
  );
  const activeFieldContext = fieldDamageContextKey(snapshot);
  const allowThreatAggregate = allowAggregateObservedRange(snapshot, snapshot.opponentSide.active, snapshot.yourSide.active);
  const allowPlayerAggregate = allowAggregateObservedRange(snapshot, snapshot.yourSide.active, snapshot.opponentSide.active);
  const opponentObservedThreats = summarizeObservedThreatsWithContext(
    activeFormatRecord.observedDamage,
    activeFormatRecord.observedDamageByContext,
    snapshot.opponentSide.active,
    snapshot.yourSide.active,
    activeFieldContext,
    allowThreatAggregate
  );
  const playerObservedDamage = summarizeObservedThreatsWithContext(
    activeFormatRecord.observedTakenDamage,
    activeFormatRecord.observedTakenDamageByContext,
    snapshot.yourSide.active,
    snapshot.opponentSide.active,
    activeFieldContext,
    allowPlayerAggregate
  );
  const priorityMoves = activeOpponentEntry ? uniqueStrings([...activeOpponentEntry.revealedMoves, ...activeOpponentEntry.likelyMoves.map((entry) => entry.name),
    ...(activeOpponentEntry.metaMovePrior?.moves.map((move) => move.name) ?? [])]).filter((name) => {
    const move = lookupMove(gens.get(generationFromFormat(snapshot.format)), name);
    if (!move || move.category === "Status" || (move.priority ?? 0) <= 0) return false;
    // Fake Out / First Impression only work on the first turn of a stint.
    return !["fakeout", "firstimpression"].includes(normalizeName(move.name)) || (snapshot.opponentSide.active?.turnsSinceEntry ?? 0) <= 1;
  }) : [];
  const speedPreview: SpeedPreview | undefined = activeOpponentEntry
    ? {
        opponentSpecies: activeOpponentEntry.species,
        neutralRange: activeOpponentEntry.neutralSpeedRange,
        effectiveRange: activeOpponentEntry.currentSpeedRange,
        possibleRange: activeOpponentEntry.possibleSpeedRange,
        yourActiveEffectiveSpeed: activeOpponentEntry.activeYourEffectiveSpeed,
        activeRelation: activeOpponentEntry.activeSpeedRelation ?? "unknown",
        activeSummary: [activeOpponentEntry.currentSpeedSummary, priorityMoves.length ? `Priority possible: ${priorityMoves.join(", ")}.` : null].filter(Boolean).join(" ") || undefined,
        reason: activeOpponentEntry.speedReason ?? "unknown",
        evidence: activeOpponentEntry.speedEvidence ?? [],
        confounders: activeOpponentEntry.speedConfounders ?? [],
        switchMatchups: activeOpponentEntry.switchSpeedMatchups ?? [],
        historyNotes: activeOpponentEntry.speedNotes,
        ...(priorityMoves.length ? { priorityMoves } : {})
      }
    : undefined;
  if (speedPreview) speedPreview.verdict = speedVerdict(speedPreview, snapshot.opponentSide.active, snapshot.field.pseudoWeather.some((value) => /trick room/i.test(value)));
  const hazardSummary = [
    snapshot.field.yourSideConditions.length > 0 ? `Your side: ${summarizeSideConditions(snapshot.field.yourSideConditions).join(", ")}` : null,
    snapshot.field.opponentSideConditions.length > 0 ? `Opponent side: ${summarizeSideConditions(snapshot.field.opponentSideConditions).join(", ")}` : null
  ].filter(Boolean).join(" | ") || undefined;
  const note = "Observed history, priors, and current inferences.";
  // Board: speed and the revealed/likely sets need no damage calculation and no posterior.
  const illusionCaveat = illusion?.users.length ? { shown: illusion.shown.species ?? illusion.shown.displayName ?? "the shown Pokémon",
    possible: illusion.users.map((user) => user.species ?? user.displayName ?? "an Illusion user") } : undefined;
  const board: LocalIntelSnapshot = { generatedAt: "", note, speedPreview, hazardSummary, opponents, ...(illusionCaveat ? { illusion: illusionCaveat } : {}) };
  if (onStage) { await onStage("board", board); await yieldToEventLoop(); }
  withPosterior(activeOpponentEntry);
  // Your damage into an opponent's Substitute is not modeled; speed and their threats to you are unaffected.
  const opponentSubstitute = Boolean(snapshot.canonicalEvidence?.limitations.includes("opponent_substitute_active"));
  const playerDamagePreview = opponentSubstitute ? [] : buildDamagePreview(snapshot, {
    likelyDefenderItems: liveLikelyHeldItems(snapshot.format, snapshot.opponentSide.active, activeOpponentEntry?.likelyItems, snapshot.recentLog, activeOpponentInferenceEvents),
    likelyDefenderAbilities: activeOpponentEntry?.likelyAbilities.map((entry) => entry.name) ?? [],
    defenderPosterior: activeOpponentEntry?.posterior,
    observedPlayerDamage: playerObservedDamage,
    observedPlayerDamageResolver: (moveName, attacker, defender) =>
      summarizeObservedThreatsWithContext(
        activeFormatRecord.observedTakenDamage,
        activeFormatRecord.observedTakenDamageByContext,
        attacker,
        defender,
        activeFieldContext,
        allowAggregateObservedRange(snapshot, attacker, defender)
      )[`${moveName}|${attacker.species ?? attacker.displayName ?? "Unknown"}`]
  });
  const survivalCaveats = [...new Set(playerDamagePreview.flatMap((entry) => entry.survivalCaveats.map((caveat) => caveat.note)))];
  if (onStage) { await onStage("damage", { ...board, playerDamagePreview, survivalCaveats }); await yieldToEventLoop(); }
  const threatSelection = pickThreatMoves(activeOpponentEntry);
  const threatMoves = threatSelection.moves;
  const opponentThreatPreview = buildThreatPreview(snapshot, {
    moveCandidates: threatMoves,
    likelyAttackerItems: liveLikelyHeldItems(snapshot.format, snapshot.opponentSide.active, activeOpponentEntry?.likelyItems, snapshot.recentLog, activeOpponentInferenceEvents),
    likelyAttackerAbilities: activeOpponentEntry?.likelyAbilities.map((entry) => entry.name) ?? [],
    likelyAttackerProfile: activeOpponentEntry?.ladderAttackProfile,
    attackerPosterior: activeOpponentEntry?.posterior,
    observedThreats: opponentObservedThreats,
    observedThreatResolver: (moveName, attacker, defender) =>
      summarizeObservedThreatsWithContext(
        activeFormatRecord.observedDamage,
        activeFormatRecord.observedDamageByContext,
        attacker,
        defender,
        activeFieldContext,
        allowAggregateObservedRange(snapshot, attacker, defender)
      )[`${moveName}|${defender.species ?? defender.displayName ?? "Unknown"}`]
  }).map((preview) => ({
    ...preview,
    currentTarget: {
      ...preview.currentTarget,
      relation: speedPreview?.activeRelation ?? "unknown"
    },
    switchTargets: preview.switchTargets.map((target) => ({
      ...target,
      relation: speedPreview?.switchMatchups.find((matchup) => target.instanceId ? matchup.instanceId === target.instanceId : matchup.species === target.species)?.relation ?? "unknown"
    }))
  }));
  const opponentThreatCoverage: NonNullable<LocalIntelSnapshot["opponentThreatCoverage"]> = {
    consideredMoves: threatMoves,
    omittedMoves: threatSelection.omitted,
    uncomputedMoves: threatMoves.filter((move) => !opponentThreatPreview.some((preview) => preview.moveName === move.name))
      .map((move) => ({ name: move.name, reason: "no_damage_forecast" })),
    unrevealedSlots: Math.max(0, 4 - (activeOpponentEntry?.revealedMoves.length ?? 0)),
    note: "Selected move hypotheses only; missing rows do not establish safety. Monthly inclusion is not next-action probability. Damage bands are conditional on supported stat/item/ability/Tera assumptions, not exhaustive upper bounds."
  };
  if (onStage) { await onStage("threats", { ...board, playerDamagePreview, survivalCaveats, opponentThreatPreview, opponentThreatCoverage }); await yieldToEventLoop(); }
  // The other posteriors are the rest of the cost; yield between them so a model reply or a send is not held up.
  for (const entry of opponents) if (withPosterior(entry) && onStage) await yieldToEventLoop();
  const opponentActionPrediction = buildOpponentActionPrediction({
    snapshot,
    activeOpponentEntry,
    allOpponentEntries: opponents,
    playerDamagePreview,
    opponentThreatPreview
  });
  const selfActionRecommendation = buildSelfActionRecommendation({
    snapshot,
    activeOpponentEntry,
    playerDamagePreview,
    opponentThreatPreview,
    speedPreview,
    opponentActionPrediction,
    threatCoverageIncomplete: opponentThreatCoverage.unrevealedSlots > 0 || opponentThreatCoverage.omittedMoves.length > 0
  });
  const opponentLeadPrediction = buildOpponentLeadPrediction({
    snapshot,
    allOpponentEntries: opponents
  });
  const playerLeadRecommendation = buildPlayerLeadRecommendation({
    snapshot,
    allOpponentEntries: opponents,
    opponentLeadPrediction
  });
  const currentBattlePredictionStats = summarizePredictionHistory(activeBattle?.predictionHistory ?? []);
  const overallPredictionStats = summarizePredictionHistory(
    Object.values(store.battles).flatMap((battle) => battle.predictionHistory ?? [])
  );

  // The Illusion user's own speed, damage and threats, as if it were the one on the field (its first view only).
  let illusionAlternative: LocalIntelSnapshot["illusionAlternative"];
  if (illusion?.users.length) {
    const user = illusion.users[0]!;
    try {
      await buildLocalIntelSnapshot(illusionUserView(snapshot, user, illusion.used), context, async (stage, partial) => {
        if (stage !== "threats") return;
        illusionAlternative = { species: user.species ?? user.displayName ?? "an Illusion user", speedPreview: partial.speedPreview,
          playerDamagePreview: partial.playerDamagePreview ?? [], opponentThreatPreview: partial.opponentThreatPreview ?? [] };
        throw ALTERNATIVE_DONE;  // the rest (other posteriors, predictions) is not needed for this view
      });
    } catch (error) { if (error !== ALTERNATIVE_DONE) throw error; }
  }
  // Hover detail, built last (a few ms) so it delays no other section. Behind a Substitute the active has no band.
  const moveTargetPreview = buildMoveTargetPreview(snapshot, opponents, playerDamagePreview, allInferenceEvents);
  return {
    generatedAt: new Date().toISOString(),
    note,
    ...(illusionCaveat ? { illusion: illusionCaveat } : {}),
    ...(illusionAlternative ? { illusionAlternative } : {}),
    playerDamagePreview,
    moveTargetPreview,
    opponentThreatPreview,
    opponentThreatCoverage,
    opponentActionPrediction,
    opponentLeadPrediction,
    playerLeadRecommendation,
    selfActionRecommendation,
    speedPreview,
    hazardSummary,
    survivalCaveats,
    debug: {
      format: snapshot.format,
      roomId: snapshot.roomId,
      activeOpponentSpecies: activeOpponentSpecies ?? null,
      speed: {
        reason: speedPreview?.reason ?? null,
        yourShownSpeed: snapshot.yourSide.active?.stats?.spe ?? null,
        opponentRange: speedPreview?.effectiveRange ?? null,
        evidenceKinds: speedPreview?.evidence.map((entry) => entry.kind) ?? []
      },
      observedRanges: {
        fieldContext: activeFieldContext,
        allowThreatAggregate,
        allowPlayerAggregate,
        threatMoveCandidates: threatMoves
      },
      posterior: {
        confidenceTier: activeOpponentEntry?.posterior?.confidenceTier ?? null,
        evidenceKinds: activeOpponentEntry?.posterior?.evidenceKinds ?? [],
        topHypotheses: activeOpponentEntry?.posterior?.topHypotheses.slice(0, 3) ?? []
      },
      priors: {
        observedBattlesSeen: activeOpponentEntry?.battlesSeen ?? 0,
        externalCuratedTeamCount: activeOpponentEntry?.externalCurated?.teamCount ?? 0,
        effectiveConfidenceSamples: activeOpponentEntry?.externalCurated?.effectiveConfidenceSamples ?? 0,
        import: store.externalCurated.imports[snapshot.format] ?? null
      },
      prediction: opponentActionPrediction
        ? {
            topActionClass: opponentActionPrediction.topActionClass,
            confidenceTier: opponentActionPrediction.confidenceTier,
            classScores: opponentActionPrediction.classScores ?? null,
            topActions: opponentActionPrediction.topActions.slice(0, 4)
          }
        : null,
      selfRecommendation: selfActionRecommendation
        ? {
            topActionId: selfActionRecommendation.topActionId,
            confidenceTier: selfActionRecommendation.confidenceTier,
            rankedActions: selfActionRecommendation.rankedActions.slice(0, 4)
          }
        : null,
      leadPrediction: opponentLeadPrediction
        ? {
            topLeadSpecies: opponentLeadPrediction.topLeadSpecies,
            confidenceTier: opponentLeadPrediction.confidenceTier,
            topCandidates: opponentLeadPrediction.topCandidates.slice(0, 4)
          }
        : null,
      playerLeadRecommendation: playerLeadRecommendation
        ? {
            topLeadSpecies: playerLeadRecommendation.topLeadSpecies,
            confidenceTier: playerLeadRecommendation.confidenceTier,
            topCandidates: playerLeadRecommendation.topCandidates.slice(0, 4)
          }
        : null,
      predictionStats: {
        currentBattle: currentBattlePredictionStats,
        overall: overallPredictionStats
      }
    },
    opponents
  };
}

/** Explicit feedback after a prediction was actually displayed, never a query side effect. */
export async function recordShownPrediction(snapshot: BattleSnapshot, localIntel: LocalIntelSnapshot, identity: DecisionIdentity, assertCurrent?: (() => Promise<unknown>), check?: () => void) {
  if (!sameDecision(identity, await createDecisionIdentity(snapshot))) throw new Error("Prediction feedback identity mismatch.");
  const prediction = localIntel.opponentActionPrediction;
  if (!prediction || snapshot.phase !== "turn" || !snapshot.opponentSide.active || hasOpponentActionInCurrentTurn(snapshot)) return;
  await withStoreWrite(async (store) => {
    await assertCurrent?.();
    const battle = ensureBattleLedger(store, snapshot);
    battle.pendingPrediction = {
      turn: snapshot.turn,
      predictedClass: prediction.topActionClass,
      predictedLabel: prediction.topActions[0]?.label ?? null,
      predictedAt: snapshot.capturedAt
    };
  }, check);
}
