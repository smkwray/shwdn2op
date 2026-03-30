import fs from "node:fs/promises";
import path from "node:path";
import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import { config } from "../config.js";
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
  LikelihoodEntry,
  LocalIntelSnapshot,
  OpponentIntelEntry,
  PokemonSnapshot,
  SpeedEvidenceTag,
  SpeedPreview,
  SwitchSpeedMatchup
} from "../types.js";
import { buildDamagePreview, buildThreatPreview } from "../prompting/damageNotes.js";
import { buildOpponentActionPrediction } from "../prediction/opponentActionPredictor.js";
import { buildOpponentLeadPrediction } from "../prediction/opponentLeadPredictor.js";
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
type FieldSpeedAbilityRule = {
  abilityId: string;
  label: string;
  multiplier: number;
  weather?: RegExp | undefined;
  terrain?: RegExp | undefined;
};

const FIELD_SPEED_ABILITY_RULES: readonly FieldSpeedAbilityRule[] = [
  { abilityId: "chlorophyll", label: "Chlorophyll", multiplier: 2, weather: /sun/i },
  { abilityId: "sandrush", label: "Sand Rush", multiplier: 2, weather: /sand/i },
  { abilityId: "slushrush", label: "Slush Rush", multiplier: 2, weather: /snow|hail/i },
  { abilityId: "swiftswim", label: "Swift Swim", multiplier: 2, weather: /rain/i },
  { abilityId: "surgesurfer", label: "Surge Surfer", multiplier: 2, terrain: /electric/i }
] as const;
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
  pokemon: PokemonSnapshot | null | undefined,
  likelyItems: LikelihoodEntry[] | undefined
) {
  if (!pokemon) return [];
  if (!pokemon.item && pokemon.removedItem) return [];
  return likelyItems?.map((entry) => entry.name) ?? [];
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

function matchingFieldSpeedAbilityRule(
  abilityId: string | null | undefined,
  field: BattleSnapshot["field"]
) {
  const normalized = normalizedAbilityId(abilityId);
  if (!normalized) return null;
  const weather = String(field.weather ?? "");
  const terrain = String(field.terrain ?? "");
  return FIELD_SPEED_ABILITY_RULES.find((rule) =>
    rule.abilityId === normalized
    && (!rule.weather || rule.weather.test(weather))
    && (!rule.terrain || rule.terrain.test(terrain))
  ) ?? null;
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
  } catch {
    return normalizeExternalCuratedStore(fallback?.externalCurated ?? fallback?.sampleTeams);
  }
}

async function readStore(): Promise<IntelStore> {
  try {
    const text = await fs.readFile(config.localIntelStorePath, "utf8");
    const parsed = JSON.parse(text) as PersistedIntelStore;
    const externalCurated = await readExternalCuratedStore(parsed);
    return {
      version: parsed.version ?? EMPTY_STORE.version,
      updatedAt: parsed.updatedAt ?? EMPTY_STORE.updatedAt,
      species: parsed.species ?? {},
      battles: parsed.battles ?? {},
      externalCurated
    };
  } catch {
    return {
      ...structuredClone(EMPTY_STORE),
      externalCurated: await readExternalCuratedStore()
    };
  }
}

async function writeStore(store: IntelStore) {
  await ensureStoreDirs();
  store.updatedAt = new Date().toISOString();
  const persisted: PersistedIntelStore = {
    version: store.version,
    updatedAt: store.updatedAt,
    species: store.species,
    battles: store.battles
  };
  await fs.writeFile(config.localIntelStorePath, JSON.stringify(persisted, null, 2));
  await fs.writeFile(config.externalCuratedStorePath, JSON.stringify(store.externalCurated, null, 2));
}

function withStoreWrite<T>(operation: (store: IntelStore) => Promise<T> | T): Promise<T> {
  const run = writeChain.then(async () => {
    const store = await readStore();
    const result = await operation(store);
    await writeStore(store);
    return result;
  });
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
    defensiveBoostContextKey(pokemon)
  ].join("|");
}

function combatContextKey(
  attacker: PokemonSnapshot | null | undefined,
  defender: PokemonSnapshot | null | undefined,
  fieldContext = "weather:none|terrain:none|pseudo:none|your:none|opp:none"
) {
  return `${attackerContextKey(attacker)}|def:${defenderContextKey(defender)}|field:${fieldContext}`;
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
  return notes;
}

function extractMoveNameFromLog(line: string) {
  const match = line.match(/ used (.+)\.$/i);
  return match?.[1] ?? null;
}

function extractLastTurnMoveOrder(snapshot: BattleSnapshot) {
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

function speedStageMultiplier(stage: number) {
  if (!Number.isFinite(stage)) return 1;
  stage = Math.max(-6, Math.min(6, Number(stage)));
  if (stage === 0) return 1;
  if (stage > 0) return (2 + stage) / 2;
  return 2 / (2 + Math.abs(stage));
}

function paralysisSpeedMultiplier(format: string) {
  return generationFromFormat(format) >= 7 ? 0.5 : 0.25;
}

function effectiveSpeedRangeForPokemon(
  format: string,
  range: { min: number; max: number } | null,
  pokemon: PokemonSnapshot | null | undefined,
  sideConditions: string[],
  field: BattleSnapshot["field"]
) {
  if (!range || !pokemon) return null;
  let multiplier = speedStageMultiplier(Number(pokemon.boosts?.spe ?? 0));
  const itemId = normalizedItemId(pokemon.item);
  const abilityId = normalizedAbilityId(pokemon.ability);
  if (pokemon.status === "par" && abilityId !== "quickfeet") {
    multiplier *= paralysisSpeedMultiplier(format);
  }
  if (pokemon.status && abilityId === "quickfeet") {
    multiplier *= 1.5;
  }
  if (itemId === "choicescarf") {
    multiplier *= 1.5;
  }
  if (itemId === "ironball") {
    multiplier *= 0.5;
  }
  if (sideConditions.some((value) => /tailwind/i.test(value))) {
    multiplier *= 2;
  }
  const revealedFieldSpeedAbility = matchingFieldSpeedAbilityRule(abilityId, field);
  if (revealedFieldSpeedAbility) {
    multiplier *= revealedFieldSpeedAbility.multiplier;
  }
  const possibleFieldSpeedMultiplier = possibleFieldSpeedAbilityRules(format, pokemon, field)
    .reduce((maxMultiplier, rule) => Math.max(maxMultiplier, rule.multiplier), 1);
  return {
    min: Math.floor(range.min * multiplier),
    max: Math.floor(range.max * multiplier * possibleFieldSpeedMultiplier)
  };
}

function effectiveShownSpeed(format: string, pokemon: PokemonSnapshot | null | undefined, sideConditions: string[]) {
  const shown = pokemon?.stats?.spe;
  if (!Number.isFinite(shown)) return null;
  return effectiveSpeedRangeForPokemon(
    format,
    { min: Number(shown), max: Number(shown) },
    pokemon,
    sideConditions,
    {
      weather: null,
      terrain: null,
      pseudoWeather: [],
      yourSideConditions: [],
      opponentSideConditions: []
    }
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

function buildCurrentSpeedIntel(snapshot: BattleSnapshot, speciesName: string, formatRecord: IntelFormatRecord) {
  const opponentActive = snapshot.opponentSide.active;
  if (!opponentActive || normalizeName(speciesNameFromSnapshot(opponentActive)) !== normalizeName(speciesName)) {
    return {
      currentSpeedRange: undefined,
      currentSpeedSummary: undefined,
      switchSpeedMatchups: undefined,
      speedEvidence: undefined,
      speedConfounders: undefined,
      speedReason: undefined
    };
  }

  const trickRoomActive = snapshot.field.pseudoWeather.some((value) => /trick room/i.test(value));
  const confounders = getSpeedConfounders(snapshot);
  const activeYourSpecies = snapshot.yourSide.active?.species ?? snapshot.yourSide.active?.displayName;
  const observation = extractLastTurnMoveOrder(snapshot);
  const neutralRange = narrowRangeWithCurrentObservation(
    narrowRangeWithHistory(
      speedRangeForSpecies(snapshot.format, speciesName, opponentActive.level),
      formatRecord,
      activeYourSpecies
    ),
    snapshot,
    speciesName,
    activeYourSpecies
  );
  const opponentRange = effectiveSpeedRangeForPokemon(
    snapshot.format,
    neutralRange,
    opponentActive,
    snapshot.field.opponentSideConditions,
    snapshot.field
  );
  const activeSpeed = effectiveShownSpeed(snapshot.format, snapshot.yourSide.active, snapshot.field.yourSideConditions);
  const relation = speedRelation(activeSpeed, opponentRange);
  const activeSpeedText = formatRange(activeSpeed);
  const opponentSpeedText = formatRange(opponentRange);
  const historyFaster = activeYourSpecies ? formatRecord.speedFirstVs[activeYourSpecies] ?? 0 : 0;
  const historySlower = activeYourSpecies ? formatRecord.speedSecondVs[activeYourSpecies] ?? 0 : 0;
  const hasYourShownSpeed = Number.isFinite(snapshot.yourSide.active?.stats?.spe ?? null);
  const speedEvidence: SpeedEvidenceTag[] = [];
  const usedCurrentTurnObservation = Boolean(
    observation &&
    normalizeName(observation.opponentSpecies) === normalizeName(speciesName) &&
    normalizeName(observation.yourSpecies) === normalizeName(activeYourSpecies)
  );
  if (usedCurrentTurnObservation) {
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
  if (!hasYourShownSpeed) {
    speedEvidence.push({
      kind: "capture_gap",
      label: "Your active Speed stat is missing from the captured snapshot",
      detail: "State capture could not compare your exact live Speed against the opponent range yet."
    });
  }
  if (confounders.length > 0) {
    speedEvidence.push({
      kind: "confounded",
      label: "Current turn order is confounded",
      detail: confounders.join(", ")
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
    ? `Active speed: ${compactRelationLabel(relation)}${activeSpeedText ? ` (you ${activeSpeedText}, opp est ${opponentSpeedText})` : ` (opp est ${opponentSpeedText})`}${!activeSpeedText ? "; your exact Speed is missing from the snapshot" : ""}${trickRoomActive ? "; Trick Room flips move order." : ""}${confounders.length > 0 ? `; confounded by ${confounders.join(", ")}.` : "."}`
    : undefined;

  const switchSpeedMatchups: SwitchSpeedMatchup[] = snapshot.yourSide.team
    .filter((pokemon) => !pokemon.fainted)
    .map((pokemon) => {
      const speed = effectiveShownSpeed(snapshot.format, pokemon, snapshot.field.yourSideConditions);
      return {
        species: pokemon.species ?? pokemon.displayName ?? "Unknown",
        effectiveSpeed: speed?.min ?? null,
        relation: speedRelation(speed, opponentRange)
      };
    })
    .filter((entry) => entry.effectiveSpeed !== null || entry.relation !== "unknown")
    .sort((a, b) => (Number(b.effectiveSpeed ?? -1) - Number(a.effectiveSpeed ?? -1)));

  return {
    currentSpeedRange: opponentRange ?? undefined,
    currentSpeedSummary,
    switchSpeedMatchups: switchSpeedMatchups.length > 0 ? switchSpeedMatchups : undefined,
    neutralRange: neutralRange ?? undefined,
    activeRelation: relation,
    activeSpeed: activeSpeed?.min ?? undefined,
    speedEvidence: speedEvidence,
    speedConfounders: confounders,
    speedReason
  };
}

function pickThreatMoves(entry: OpponentIntelEntry | undefined) {
  if (!entry) return [];
  const knownMoves = entry.revealedMoves.map((name) => ({ name, source: "known" as const }));
  if (knownMoves.length >= 4) return knownMoves.slice(0, 4);
  const likelyMoves = entry.likelyMoves
    .filter((move) => move.sampleCount > 0 || move.confidenceTier !== "thin" || move.share >= 0.45)
    .filter((move) => !entry.revealedMoves.includes(move.name))
    .slice(0, Math.max(0, 4 - knownMoves.length))
    .map((move) => ({ name: move.name, source: "likely" as const }));
  return [...knownMoves, ...likelyMoves];
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

export async function updateLocalIntelFromSnapshot(snapshot: BattleSnapshot): Promise<void> {
  await withStoreWrite(async (store) => {
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
  });
}

export async function buildLocalIntelSnapshot(snapshot: BattleSnapshot): Promise<LocalIntelSnapshot> {
  const store = await readStore();
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

  for (const pokemon of snapshot.opponentSide.team) {
    const speciesName = speciesNameFromSnapshot(pokemon);
    if (!speciesName) continue;
    const speciesKey = normalizeName(speciesName);
    const existing = mergedOpponents.get(speciesKey);
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
    mergedOpponents.set(speciesKey, merged);
  }

  const opponents: OpponentIntelEntry[] = await Promise.all([...mergedOpponents.entries()].map(async ([speciesKey, merged]) => {
    const speciesRecord = store.species[speciesKey];
    const formatRecord = normalizeFormatRecord(speciesRecord?.formats?.[snapshot.format]);
    const curatedFormatRecord = externalCuratedFormatRecord(store, speciesKey, snapshot.format);
    const confidenceSamples = effectivePriorConfidenceSamples(formatRecord.battlesSeen, curatedFormatRecord.teamCount);
    const revealedMoves = [...merged.revealedMoves];
    const currentSpeedIntel = buildCurrentSpeedIntel(snapshot, merged.species, formatRecord);
    const battleSpecies = normalizeBattleSpeciesLedger(activeBattle?.species?.[speciesKey]);
    const importInfo = store.externalCurated.imports[snapshot.format] ?? null;
    const posterior = buildOpponentPosterior({
      format: snapshot.format,
      opponent: merged.pokemon,
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
        curatedTeraTypes: curatedFormatRecord.teraTypes
      },
      battleEvidence: {
        incomingDamage: battleSpecies.incomingDamage,
        outgoingDamage: battleSpecies.outgoingDamage,
        speedObservations: battleSpecies.speedObservations
      }
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
    const likelyMoves = revealedMoves.length >= 4
      ? []
      : likelyMovesFromHistory.length > 0
      ? likelyMovesFromHistory
      : await fallbackLikelyMoveEntries(snapshot.format, merged.species, revealedMoves, 4);

    return {
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
      likelyItems: summarizeEntries({
        observedRecord: formatRecord.items,
        observedSamples: formatRecord.battlesSeen,
        curatedRecord: curatedFormatRecord.items,
        curatedSamples: curatedFormatRecord.teamCount,
        exclude: merged.revealedItem ? [merged.revealedItem] : []
      }),
      likelyAbilities: summarizeEntries(
        {
          observedRecord: formatRecord.abilities,
          observedSamples: formatRecord.battlesSeen,
          curatedRecord: curatedFormatRecord.abilities,
          curatedSamples: curatedFormatRecord.teamCount,
          exclude: merged.revealedAbility ? [merged.revealedAbility] : []
        }
      ),
      likelyTeraTypes: summarizeEntries(
        {
          observedRecord: formatRecord.teraTypes,
          observedSamples: formatRecord.battlesSeen,
          curatedRecord: curatedFormatRecord.teraTypes,
          curatedSamples: curatedFormatRecord.teamCount,
          exclude: merged.revealedTeraType ? [merged.revealedTeraType] : []
        }
      ),
      neutralSpeedRange: currentSpeedIntel.neutralRange,
      currentSpeedRange: currentSpeedIntel.currentSpeedRange,
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
      posterior
    };
  }));

  const activeOpponentSpecies = snapshot.opponentSide.active?.species ?? snapshot.opponentSide.active?.displayName ?? null;
  const activeOpponentEntry = opponents.find((entry) => normalizeName(entry.species) === normalizeName(activeOpponentSpecies));
  const activeSpeciesKey = normalizeName(activeOpponentSpecies);
  const activeSpeciesRecord = activeSpeciesKey ? store.species[activeSpeciesKey] : undefined;
  const activeFormatRecord = normalizeFormatRecord(activeSpeciesRecord?.formats?.[snapshot.format]);
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
  const speedPreview: SpeedPreview | undefined = activeOpponentEntry
    ? {
        opponentSpecies: activeOpponentEntry.species,
        neutralRange: activeOpponentEntry.neutralSpeedRange,
        effectiveRange: activeOpponentEntry.currentSpeedRange,
        yourActiveEffectiveSpeed: activeOpponentEntry.activeYourEffectiveSpeed,
        activeRelation: activeOpponentEntry.activeSpeedRelation ?? "unknown",
        activeSummary: activeOpponentEntry.currentSpeedSummary,
        reason: activeOpponentEntry.speedReason ?? "unknown",
        evidence: activeOpponentEntry.speedEvidence ?? [],
        confounders: activeOpponentEntry.speedConfounders ?? [],
        switchMatchups: activeOpponentEntry.switchSpeedMatchups ?? [],
        historyNotes: activeOpponentEntry.speedNotes
      }
    : undefined;
  const threatMoves = pickThreatMoves(activeOpponentEntry);
  const opponentThreatPreview = buildThreatPreview(snapshot, {
    moveCandidates: threatMoves,
    likelyAttackerItems: liveLikelyHeldItems(snapshot.opponentSide.active, activeOpponentEntry?.likelyItems),
    likelyAttackerAbilities: activeOpponentEntry?.likelyAbilities.map((entry) => entry.name) ?? [],
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
      relation: speedPreview?.switchMatchups.find((matchup) => matchup.species === target.species)?.relation ?? "unknown"
    }))
  }));
  const playerDamagePreview = buildDamagePreview(snapshot, {
    likelyDefenderItems: liveLikelyHeldItems(snapshot.opponentSide.active, activeOpponentEntry?.likelyItems),
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
    opponentActionPrediction
  });
  const opponentLeadPrediction = buildOpponentLeadPrediction({
    snapshot,
    allOpponentEntries: opponents
  });
  const currentBattlePredictionStats = summarizePredictionHistory(activeBattle?.predictionHistory ?? []);
  const overallPredictionStats = summarizePredictionHistory(
    Object.values(store.battles).flatMap((battle) => battle.predictionHistory ?? [])
  );

  if (
    opponentActionPrediction
    && snapshot.phase === "turn"
    && snapshot.opponentSide.active
    && !hasOpponentActionInCurrentTurn(snapshot)
  ) {
    await withStoreWrite(async (store) => {
      const battle = ensureBattleLedger(store, snapshot);
      battle.pendingPrediction = {
        turn: snapshot.turn,
        predictedClass: opponentActionPrediction.topActionClass,
        predictedLabel: opponentActionPrediction.topActions[0]?.label ?? null,
        predictedAt: snapshot.capturedAt
      };
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    note:
      "Local opponent intel keeps observed species-format history, imported external-curated priors, and clean battle-local evidence as separate channels. Posterior set guesses stay bounded and deterministic, and thin-confidence cases still fall back to generic calc ranges.",
    playerDamagePreview,
    opponentThreatPreview,
    opponentActionPrediction,
    opponentLeadPrediction,
    selfActionRecommendation,
    speedPreview,
    hazardSummary: [
      snapshot.field.yourSideConditions.length > 0 ? `Your side: ${snapshot.field.yourSideConditions.join(", ")}` : null,
      snapshot.field.opponentSideConditions.length > 0 ? `Opponent side: ${snapshot.field.opponentSideConditions.join(", ")}` : null
    ].filter(Boolean).join(" | ") || undefined,
    survivalCaveats: [
      ...new Set(
        playerDamagePreview
          .flatMap((entry) => entry.survivalCaveats.map((caveat) => caveat.note))
      )
    ],
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
      predictionStats: {
        currentBattle: currentBattlePredictionStats,
        overall: overallPredictionStats
      }
    },
    opponents
  };
}
