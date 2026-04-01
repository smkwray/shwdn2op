import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import type {
  ActionScoreComponent,
  BattleSnapshot,
  DamageAssumptionBand,
  DamagePreview,
  LegalAction,
  OpponentActionPrediction,
  OpponentIntelEntry,
  PokemonSnapshot,
  SelfActionCandidate,
  SelfActionRecommendation,
  SpeedPreview,
  ThreatPreview,
  ThreatTargetPreview
} from "../types.js";

const gens = new Generations(Dex as any);
const SEARCH_PLAYER_MIN_COUNT = 4;
const SEARCH_PLAYER_SCORE_BAND = 8;
const SEARCH_OPPONENT_MIN_COUNT = 3;
const SEARCH_OPPONENT_SCORE_BAND = 10;
const SEARCH_OPPONENT_WEIGHT_COVERAGE = 0.85;

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = normalizeName(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(0, value).toFixed(1));
}

function generationFromFormat(format: string): number {
  const match = String(format ?? "").match(/\[Gen\s*(\d+)\]/i);
  const parsed = Number.parseInt(match?.[1] ?? "9", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 9;
}

function dataGen(format: string) {
  return gens.get(generationFromFormat(format) as Parameters<Generations["get"]>[0]);
}

function lookupMove(gen: ReturnType<typeof dataGen>, name: string | null | undefined) {
  if (!name) return undefined;
  const direct = gen.moves.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const move of gen.moves) {
    if (normalizeName(move.name) === normalized) return move;
  }
  return undefined;
}

function lookupSpecies(gen: ReturnType<typeof dataGen>, name: string | null | undefined) {
  if (!name) return undefined;
  const direct = gen.species.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const species of gen.species) {
    if (normalizeName(species.name) === normalized) return species;
  }
  return undefined;
}

function likelyBand(bands: DamageAssumptionBand[] | null | undefined) {
  if (!Array.isArray(bands) || bands.length === 0) return null;
  return bands.find((band) => band.label === "likely") ?? bands[0] ?? null;
}

function bandAveragePercent(band: DamageAssumptionBand | null | undefined) {
  if (!band || (band.outcome && band.outcome !== "damage")) return 0;
  if (!Number.isFinite(band.minPercent) || !Number.isFinite(band.maxPercent)) return 0;
  return (Number(band.minPercent) + Number(band.maxPercent)) / 2;
}

function bandMaxPercent(band: DamageAssumptionBand | null | undefined) {
  if (!band || (band.outcome && band.outcome !== "damage")) return 0;
  return Number.isFinite(band.maxPercent) ? Number(band.maxPercent) : 0;
}

function bandCoverageScore(band: DamageAssumptionBand | null | undefined) {
  if (!band || (band.outcome && band.outcome !== "damage")) return 0;
  if (band.coverage === "covers_current_hp") return 2;
  if (band.coverage === "can_cover_current_hp") return 1;
  return 0;
}

function isImmuneOrBlockedBand(band: DamageAssumptionBand | null | undefined) {
  return band?.outcome === "immune" || band?.outcome === "blocked";
}

function isStatusBand(band: DamageAssumptionBand | null | undefined) {
  return band?.outcome === "status";
}

function earlyTurn(snapshot: BattleSnapshot) {
  return Number(snapshot.turn ?? 0) > 0 && Number(snapshot.turn ?? 0) <= 3;
}

function lateTurn(snapshot: BattleSnapshot) {
  return Number(snapshot.turn ?? 0) >= 8;
}

function veryLateTurn(snapshot: BattleSnapshot) {
  return Number(snapshot.turn ?? 0) >= 12;
}

function trickRoomActive(snapshot: BattleSnapshot) {
  return snapshot.field.pseudoWeather.some((value) => /trick room/i.test(String(value ?? "")));
}

function relationAfterTrickRoomFromYourPerspective(snapshot: BattleSnapshot, relation: "faster" | "slower" | "overlap" | "unknown") {
  if (!trickRoomActive(snapshot)) return relation;
  if (relation === "faster") return "slower" as const;
  if (relation === "slower") return "faster" as const;
  return relation;
}

function movePriorityClass(priority: number | null | undefined) {
  const numeric = Number(priority ?? 0);
  if (numeric > 0) return "positive" as const;
  if (numeric < 0) return "negative" as const;
  return "neutral" as const;
}

function moveOrderRelation(snapshot: BattleSnapshot, speedPreview: SpeedPreview | undefined, priority: number | null | undefined) {
  const priorityClass = movePriorityClass(priority);
  if (priorityClass === "positive") return "priority" as const;
  if (priorityClass === "negative") return "last" as const;
  return relationAfterTrickRoomFromYourPerspective(snapshot, speedPreview?.activeRelation ?? "unknown");
}

function currentBattleTypes(gen: ReturnType<typeof dataGen>, pokemon: PokemonSnapshot | null | undefined) {
  if (!pokemon) return [];
  if (pokemon.terastallized && pokemon.teraType) {
    return [pokemon.teraType];
  }
  if (Array.isArray(pokemon.types) && pokemon.types.length > 0) {
    return pokemon.types;
  }
  const species = lookupSpecies(gen, pokemon.species ?? pokemon.displayName);
  return species?.types ?? [];
}

function hazardLayerCount(conditions: string[], name: string) {
  return conditions.filter((value) => normalizeName(value) === normalizeName(name)).length;
}

function groundedForSpikes(snapshot: BattleSnapshot, pokemon: PokemonSnapshot) {
  if (snapshot.field.pseudoWeather.some((value) => /gravity/i.test(String(value ?? "")))) {
    return true;
  }
  const gen = dataGen(snapshot.format);
  const types = currentBattleTypes(gen, pokemon);
  if (types.includes("Flying")) return false;
  if (normalizeName(pokemon.item) === "airballoon") return false;
  if (normalizeName(pokemon.ability) === "levitate") return false;
  return true;
}

function estimateSwitchEntryHazards(snapshot: BattleSnapshot, pokemon: PokemonSnapshot) {
  if (normalizeName(pokemon.item) === "heavydutyboots") {
    return { damagePercent: 0, stickyWeb: false };
  }

  const gen = dataGen(snapshot.format);
  const conditions = snapshot.field.yourSideConditions ?? [];
  const types = currentBattleTypes(gen, pokemon);
  let damagePercent = 0;

  if (hazardLayerCount(conditions, "Stealth Rock") > 0 && types.length > 0) {
    const rockEffectiveness = gen.types.totalEffectiveness("Rock" as any, types as any);
    damagePercent += 12.5 * Number(rockEffectiveness);
  }

  const spikesLayers = hazardLayerCount(conditions, "Spikes");
  if (spikesLayers > 0 && groundedForSpikes(snapshot, pokemon)) {
    damagePercent += spikesLayers >= 3 ? 25 : spikesLayers === 2 ? 16.7 : 12.5;
  }

  const stickyWeb = hazardLayerCount(conditions, "Sticky Web") > 0 && groundedForSpikes(snapshot, pokemon);
  return {
    damagePercent: Number(damagePercent.toFixed(1)),
    stickyWeb
  };
}

function summarizeBestThreat(threats: ThreatPreview[]) {
  let best: { entry: ThreatPreview; target: ThreatTargetPreview; band: DamageAssumptionBand | null } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const entry of threats) {
    const band = likelyBand(entry.currentTarget?.bands);
    const score = bandCoverageScore(band) * 100 + bandAveragePercent(band) * 2 + bandMaxPercent(band);
    if (score > bestScore) {
      bestScore = score;
      best = { entry, target: entry.currentTarget, band };
    }
  }

  return best;
}

function summarizeThreatForMove(threats: ThreatPreview[], moveName: string | null | undefined) {
  const normalizedMove = normalizeName(moveName);
  if (!normalizedMove) return null;
  const entry = threats.find((candidate) => normalizeName(candidate.moveName) === normalizedMove);
  if (!entry) return null;
  return {
    entry,
    target: entry.currentTarget,
    band: likelyBand(entry.currentTarget?.bands)
  };
}

function summarizeBestDamage(previews: DamagePreview[]) {
  let best: { entry: DamagePreview; band: DamageAssumptionBand | null } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const entry of previews) {
    const band = likelyBand(entry.bands);
    const score = bandCoverageScore(band) * 100 + bandAveragePercent(band) * 2 + bandMaxPercent(band);
    if (score > bestScore) {
      bestScore = score;
      best = { entry, band };
    }
  }

  return best;
}

function predictionConfidenceWeight(prediction: OpponentActionPrediction | undefined) {
  if (!prediction) return 0;
  if (prediction.confidenceTier === "high") return 1;
  if (prediction.confidenceTier === "medium") return 0.7;
  return 0.35;
}

function moveTargetsSpecificFoe(move: ReturnType<typeof lookupMove>) {
  const target = String(move?.target ?? "");
  return !["self", "allySide", "allyTeam", "foeSide", "all", "allAdjacent", "scripted", "adjacentAlly", "allyAlly"].includes(target);
}

function hasPositiveBoosts(boosts: Record<string, number> | null | undefined) {
  if (!boosts) return false;
  return Object.values(boosts).some((value) => Number(value) > 0);
}

function moveRole(move: ReturnType<typeof lookupMove>) {
  const id = normalizeName(move?.name);
  const hazardMove = ["stealthrock", "spikes", "toxicspikes", "stickyweb"].includes(normalizeName(String(move?.sideCondition ?? "")));
  const hazardRemovalMove = ["defog", "rapidspin", "mortalspin", "tidyup", "courtchange"].includes(id);
  const pivotMove = Boolean(move?.selfSwitch) || ["uturn", "voltswitch", "flipturn", "partingshot", "chillyreception", "batonpass", "teleport"].includes(id);
  const recoveryMove = Boolean(move?.heal) || /recover|roost|slackoff|softboiled|moonlight|morningsun|wish|rest/i.test(String(move?.name ?? ""));
  const setupMove = hasPositiveBoosts(move?.self?.boosts as Record<string, number> | undefined)
    || (moveTargetsSpecificFoe(move) ? false : hasPositiveBoosts(move?.boosts as Record<string, number> | undefined));
  const targetedStatusMove = moveTargetsSpecificFoe(move) && (Boolean(move?.status) || Boolean(move?.volatileStatus));
  return {
    hazardMove,
    hazardRemovalMove,
    pivotMove,
    recoveryMove,
    setupMove,
    targetedStatusMove
  };
}

function predictedClassIs(prediction: OpponentActionPrediction | undefined, expected: OpponentActionPrediction["topActionClass"]) {
  return prediction?.topActionClass === expected;
}

function hazardsPunishOpponentSwitches(snapshot: BattleSnapshot) {
  const opponentSide = snapshot.field.opponentSideConditions.map((value) => normalizeName(value));
  return opponentSide.some((value) => ["stealthrock", "spikes", "toxicspikes", "stickyweb"].includes(value));
}

function livingReserveCount(team: PokemonSnapshot[], excludeActive = true) {
  return team.filter((pokemon) => !pokemon.fainted && (!excludeActive || !pokemon.active)).length;
}

function classProbabilities(prediction: OpponentActionPrediction | undefined) {
  if (prediction?.classScores) {
    const rawStay = Math.max(0.01, Number(prediction.classScores.stayAttack ?? 0));
    const rawSwitch = Math.max(0.01, Number(prediction.classScores.switchOut ?? 0));
    const rawStatus = Math.max(0.01, Number(prediction.classScores.statusOrSetup ?? 0));
    const total = rawStay + rawSwitch + rawStatus;
    return {
      stayAttack: rawStay / total,
      switchOut: rawSwitch / total,
      statusOrSetup: rawStatus / total
    };
  }

  const lowConfidence = !prediction || prediction.confidenceTier === "low";
  const mediumConfidence = prediction?.confidenceTier === "medium";
  const presets = prediction?.topActionClass === "switch"
    ? lowConfidence
      ? { stayAttack: 0.33, switchOut: 0.39, statusOrSetup: 0.28 }
      : mediumConfidence
        ? { stayAttack: 0.24, switchOut: 0.52, statusOrSetup: 0.24 }
        : { stayAttack: 0.18, switchOut: 0.64, statusOrSetup: 0.18 }
    : prediction?.topActionClass === "status_or_setup"
      ? lowConfidence
        ? { stayAttack: 0.31, switchOut: 0.25, statusOrSetup: 0.44 }
        : mediumConfidence
          ? { stayAttack: 0.24, switchOut: 0.18, statusOrSetup: 0.58 }
          : { stayAttack: 0.16, switchOut: 0.14, statusOrSetup: 0.70 }
      : prediction?.topActionClass === "stay_attack"
        ? lowConfidence
          ? { stayAttack: 0.46, switchOut: 0.24, statusOrSetup: 0.30 }
          : mediumConfidence
            ? { stayAttack: 0.58, switchOut: 0.18, statusOrSetup: 0.24 }
            : { stayAttack: 0.70, switchOut: 0.12, statusOrSetup: 0.18 }
        : { stayAttack: 0.4, switchOut: 0.25, statusOrSetup: 0.35 };
  return presets;
}

function pushScoreComponent(components: ActionScoreComponent[], key: string, label: string, value: number) {
  if (!Number.isFinite(value)) return;
  const rounded = Number(value.toFixed(1));
  if (Math.abs(rounded) < 0.1) return;
  components.push({ key, label, value: rounded });
}

function scoreComponentsForOutput(components: ActionScoreComponent[]) {
  return components
    .slice()
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

export function weightedOpponentReplies(prediction: OpponentActionPrediction | undefined) {
  const combined = [
    ...(prediction?.topActions ?? []),
    ...(prediction?.topSwitchTargets ?? [])
  ];
  const seen = new Set<string>();
  const actions = combined.filter((candidate) => {
    const key = `${candidate?.actionClass ?? "unknown"}|${candidate?.moveName ?? ""}|${candidate?.switchTargetSpecies ?? ""}|${candidate?.label ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (actions.length === 0) return [] as Array<{ candidate: OpponentActionPrediction["topActions"][number]; weight: number }>;

  const weighted = actions.map((candidate, index) => ({
    candidate,
    rawWeight: Math.max(0.1, Number(candidate.score ?? 0)) * (index === 0 ? 1.15 : 1)
  }));
  const totalRawWeight = weighted.reduce((sum, entry) => sum + entry.rawWeight, 0);
  if (!Number.isFinite(totalRawWeight) || totalRawWeight <= 0) {
    return [] as Array<{ candidate: OpponentActionPrediction["topActions"][number]; weight: number }>;
  }

  const leaderScore = Number(weighted[0]?.candidate.score ?? 0);
  const selected: Array<{ candidate: OpponentActionPrediction["topActions"][number]; rawWeight: number }> = [];
  let coveredWeight = 0;

  for (let index = 0; index < weighted.length; index += 1) {
    const entry = weighted[index];
    if (!entry) continue;
    const candidateScore = Number(entry.candidate.score ?? 0);
    const withinScoreBand = candidateScore >= leaderScore - SEARCH_OPPONENT_SCORE_BAND;
    const needsMoreCoverage = coveredWeight < SEARCH_OPPONENT_WEIGHT_COVERAGE;
    if (index >= SEARCH_OPPONENT_MIN_COUNT && !withinScoreBand && !needsMoreCoverage) {
      break;
    }
    selected.push(entry);
    coveredWeight += entry.rawWeight / totalRawWeight;
  }

  const selectedTotal = selected.reduce((sum, entry) => sum + entry.rawWeight, 0);
  if (!Number.isFinite(selectedTotal) || selectedTotal <= 0) {
    return [] as Array<{ candidate: OpponentActionPrediction["topActions"][number]; weight: number }>;
  }

  return selected.map((entry) => ({
    candidate: entry.candidate,
    weight: entry.rawWeight / selectedTotal
  }));
}

function hazardPressureOnYourSide(snapshot: BattleSnapshot) {
  const normalized = (snapshot.field.yourSideConditions ?? []).map((value) => normalizeName(value));
  let pressure = 0;
  if (normalized.includes("stealthrock")) pressure += 1.3;
  pressure += normalized.filter((value) => value === "spikes").length * 0.8;
  if (normalized.includes("stickyweb")) pressure += 0.8;
  pressure += normalized.filter((value) => value === "toxicspikes").length * 0.6;
  return pressure * Math.max(1, livingReserveCount(snapshot.yourSide.team));
}

function likelyKoLine(
  band: DamageAssumptionBand | null | undefined,
  orderRelation: ReturnType<typeof moveOrderRelation>
) {
  return bandCoverageScore(band) === 2 && (orderRelation === "faster" || orderRelation === "priority");
}

function activePreservationValue(params: {
  snapshot: BattleSnapshot;
  playerDamagePreview: DamagePreview[];
  speedPreview?: SpeedPreview | undefined;
}) {
  const active = params.snapshot.yourSide.active;
  if (!active) return 0;
  const currentHp = Number(active.hpPercent ?? 100);
  const reserveCount = livingReserveCount(params.snapshot.yourSide.team);
  const bestAttack = summarizeBestDamage(params.playerDamagePreview);
  let value = reserveCount <= 1 ? 7 : reserveCount === 2 ? 5 : 3;

  if (currentHp >= 70) value += 4;
  else if (currentHp >= 45) value += 3;
  else if (currentHp >= 25) value += 2;
  else value += 1;

  if ((active.knownMoves ?? []).some((moveName) => /roost|recover|slackoff|softboiled|moonlight|morningsun|wish|rest/i.test(moveName))) {
    value += 2;
  }
  if ((active.knownMoves ?? []).some((moveName) => /swordsdance|nastyplot|calmmind|dragondance|quiverdance|bulkup|agility|tidyup/i.test(normalizeName(moveName)))) {
    value += 2;
  }
  if ((active.knownMoves ?? []).some((moveName) => /uturn|voltswitch|flipturn|partingshot|chillyreception/i.test(normalizeName(moveName)))) {
    value += 1;
  }
  if (params.speedPreview?.activeRelation === "faster") {
    value += 2;
  }
  if (bestAttack?.band && (bandCoverageScore(bestAttack.band) >= 1 || bandAveragePercent(bestAttack.band) >= 55)) {
    value += 3;
  }

  return value;
}

function activeSackTolerance(params: {
  snapshot: BattleSnapshot;
  playerDamagePreview: DamagePreview[];
  speedPreview?: SpeedPreview | undefined;
}) {
  const active = params.snapshot.yourSide.active;
  if (!active) return 0;
  const currentHp = Number(active.hpPercent ?? 100);
  const reserveCount = livingReserveCount(params.snapshot.yourSide.team);
  const bestAttack = summarizeBestDamage(params.playerDamagePreview);
  let tolerance = 0;
  if (currentHp <= 20) tolerance += 4;
  else if (currentHp <= 30) tolerance += 2;
  if (reserveCount >= 3) tolerance += 2;
  if (params.speedPreview?.activeRelation === "slower") tolerance += 2;
  if (bestAttack?.band && bandCoverageScore(bestAttack.band) === 2) tolerance -= 3;
  return Math.max(0, tolerance);
}

function activePreservePressure(params: {
  snapshot: BattleSnapshot;
  playerDamagePreview: DamagePreview[];
  speedPreview?: SpeedPreview | undefined;
}) {
  return Math.max(0, activePreservationValue(params) - activeSackTolerance(params));
}

function switchFeelsSafe(band: DamageAssumptionBand | null | undefined) {
  return Boolean(
    isImmuneOrBlockedBand(band)
      || (band && band.coverage === "misses_current_hp" && bandMaxPercent(band) <= 50)
  );
}

function switchFeelsGreat(band: DamageAssumptionBand | null | undefined) {
  return Boolean(
    isImmuneOrBlockedBand(band)
      || (band && band.coverage === "misses_current_hp" && bandMaxPercent(band) <= 35)
  );
}

function predictionUncertaintyPenalty(prediction: OpponentActionPrediction | undefined, predictionSensitive: boolean) {
  if (!predictionSensitive) return 0;
  return !prediction || prediction.confidenceTier === "low" ? 4 : 0;
}

function teraUncertaintyPenalty(snapshot: BattleSnapshot, teraSensitive: boolean) {
  if (!teraSensitive || snapshot.opponentSide.active?.terastallized) return 0;
  return 3;
}

function moveLineIsTeraSensitive(params: {
  snapshot: BattleSnapshot;
  move: ReturnType<typeof lookupMove>;
  likely: DamageAssumptionBand | null;
  hazardMove: boolean;
  hazardRemovalMove: boolean;
  setupMove: boolean;
  recoveryMove: boolean;
  targetedStatusMove: boolean;
}) {
  if (!params.move) return false;
  if (params.hazardMove || params.hazardRemovalMove || params.setupMove || params.recoveryMove) return false;
  if (params.targetedStatusMove) {
    return isImmuneOrBlockedBand(params.likely);
  }

  const category = String(params.move.category ?? "");
  if (category === "Status") return false;

  const gen = dataGen(params.snapshot.format);
  const effectiveness = moveEffectivenessAgainstTarget(gen, params.move, params.snapshot.opponentSide.active);
  if (effectiveness !== null && effectiveness !== 1) return true;
  if (bandCoverageScore(params.likely) >= 1) return true;
  if (isImmuneOrBlockedBand(params.likely)) return true;
  return false;
}

function normalizedSwitchTargets(action: LegalAction) {
  return uniqueStrings([
    action.target,
    String(action.id ?? "").replace(/^switch:/i, ""),
    String(action.label ?? "").replace(/^switch\s+to\s+/i, ""),
    String(action.details ?? "").replace(/^switch\s+to\s+/i, "")
  ])
    .map((value) => normalizeName(value))
    .filter(Boolean);
}

function switchTargetMatchScore(actionTargets: string[], pokemon: PokemonSnapshot) {
  if (pokemon.fainted || pokemon.active || actionTargets.length === 0) return 0;
  const species = normalizeName(pokemon.species);
  const displayName = normalizeName(pokemon.displayName);
  const ident = normalizeName(pokemon.ident);

  let bestScore = 0;
  for (const target of actionTargets) {
    if (!target) continue;
    if (species && target === species) bestScore = Math.max(bestScore, 400);
    if (displayName && target === displayName) bestScore = Math.max(bestScore, 300);
    if (ident && target === ident) bestScore = Math.max(bestScore, 200);
    if (species && target.includes(species)) bestScore = Math.max(bestScore, 120);
    if (displayName && target.includes(displayName)) bestScore = Math.max(bestScore, 80);
    if (ident && target.includes(ident)) bestScore = Math.max(bestScore, 40);
  }

  return bestScore;
}

function switchTargetForAction(snapshot: BattleSnapshot, action: LegalAction) {
  const actionTargets = normalizedSwitchTargets(action);
  let best: PokemonSnapshot | null = null;
  let bestScore = 0;

  for (const pokemon of snapshot.yourSide.team) {
    const score = switchTargetMatchScore(actionTargets, pokemon);
    if (score > bestScore) {
      best = pokemon;
      bestScore = score;
    }
  }

  return best;
}

function damagePreviewForAction(action: LegalAction, previews: DamagePreview[]) {
  const actionId = normalizeName(action.id);
  const moveId = normalizeName(action.moveName ?? action.label);
  return previews.find((entry) => normalizeName(entry.actionId) === actionId)
    ?? previews.find((entry) => normalizeName(entry.moveName) === moveId)
    ?? null;
}

function interactionHintLabels(hints: Array<{ label: string }> | null | undefined) {
  return uniqueStrings((hints ?? []).map((hint) => hint.label));
}

function formatNullifierLabels(labels: string[]) {
  return uniqueStrings(labels).slice(0, 2).join(" / ");
}

function possibleNullifierRiskText(labels: string[], suffix: string) {
  const formatted = formatNullifierLabels(labels);
  return formatted ? `possible ${formatted} ${suffix}` : null;
}

function cleanBandDetail(detail: string | undefined) {
  return typeof detail === "string" ? detail.replace(/[.\s]+$/g, "") : null;
}

function hasSideCondition(conditions: string[], sideCondition: string | null | undefined) {
  const expected = normalizeName(sideCondition);
  if (!expected) return false;
  return (conditions ?? []).some((value) => normalizeName(value) === expected);
}

function switchThreatSummaryForSpecies(threats: ThreatPreview[], species: string | null | undefined) {
  const normalizedSpecies = normalizeName(species);
  if (!normalizedSpecies) return [] as Array<{ entry: ThreatPreview; target: ThreatTargetPreview; band: DamageAssumptionBand | null }>;
  return threats
    .map((entry) => {
      const target = (entry.switchTargets ?? []).find((candidate) => normalizeName(candidate.species) === normalizedSpecies);
      if (!target) return null;
      return {
        entry,
        target,
        band: likelyBand(target.bands)
      };
    })
    .filter(Boolean) as Array<{ entry: ThreatPreview; target: ThreatTargetPreview; band: DamageAssumptionBand | null }>;
}

function bestSwitchThreat(threats: ThreatPreview[], species: string | null | undefined) {
  const entries = switchThreatSummaryForSpecies(threats, species);
  let best: { entry: ThreatPreview; target: ThreatTargetPreview; band: DamageAssumptionBand | null } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of entries) {
    const score = bandCoverageScore(candidate.band) * 100 + bandAveragePercent(candidate.band) * 2 + bandMaxPercent(candidate.band);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function switchThreatForMove(threats: ThreatPreview[], moveName: string | null | undefined, species: string | null | undefined) {
  const normalizedMove = normalizeName(moveName);
  const normalizedSpecies = normalizeName(species);
  if (!normalizedMove || !normalizedSpecies) return null;
  const threat = threats.find((entry) => normalizeName(entry.moveName) === normalizedMove);
  const target = threat?.switchTargets?.find((candidate) => normalizeName(candidate.species) === normalizedSpecies);
  if (!threat || !target) return null;
  return {
    entry: threat,
    target,
    band: likelyBand(target.bands)
  };
}

function findOpponentPokemon(snapshot: BattleSnapshot, species: string | null | undefined) {
  const normalized = normalizeName(species);
  if (!normalized) return null;
  return snapshot.opponentSide.team.find((pokemon) => {
    const names = uniqueStrings([pokemon.species, pokemon.displayName, pokemon.ident]);
    return names.some((name) => normalizeName(name) === normalized);
  }) ?? null;
}

function moveEffectivenessAgainstTarget(
  gen: ReturnType<typeof dataGen>,
  move: ReturnType<typeof lookupMove>,
  target: PokemonSnapshot | null | undefined
) {
  if (!move || !target || String(move.category ?? "") === "Status") return null;
  const types = currentBattleTypes(gen, target);
  if (types.length === 0) return null;
  return Number(gen.types.totalEffectiveness(move.type as any, types as any));
}

function safeIntoThreatBand(band: DamageAssumptionBand | null | undefined) {
  return !band || isImmuneOrBlockedBand(band) || (band.coverage === "misses_current_hp" && bandMaxPercent(band) <= 45);
}

type ProjectedBranchState = {
  hpSwingPercent: number;
  tempoGain: number;
  cleanKo: boolean;
  safeSetup: boolean;
  preserveActive: boolean;
  activeStillPressured: boolean;
  establishHazard: boolean;
  removeHazards: boolean;
};

function projectedBoardValueDelta(params: {
  snapshot: BattleSnapshot;
  yourReserveCount: number;
  opponentReserveCount: number;
  state: ProjectedBranchState;
}) {
  let value = 0;

  if (Number.isFinite(params.state.hpSwingPercent)) {
    value += Math.max(-12, Math.min(12, Number(params.state.hpSwingPercent) * 0.1));
  }

  if (Number.isFinite(params.state.tempoGain)) {
    value += Math.max(-8, Math.min(8, Number(params.state.tempoGain)));
  }

  if (params.state.cleanKo) {
    if (params.opponentReserveCount <= 0) value += veryLateTurn(params.snapshot) ? 18 : lateTurn(params.snapshot) ? 14 : 0;
    else if (params.opponentReserveCount === 1) value += veryLateTurn(params.snapshot) ? 12 : lateTurn(params.snapshot) ? 8 : 0;
    else if (params.opponentReserveCount === 2 && veryLateTurn(params.snapshot)) value += 6;
  }

  if (params.state.safeSetup) {
    if (veryLateTurn(params.snapshot)) value += 12 + Math.max(0, 2 - params.opponentReserveCount) * 3;
    else if (lateTurn(params.snapshot)) value += 8 + Math.max(0, 2 - params.opponentReserveCount) * 2;
  }

  if (params.state.preserveActive) {
    value += 4 + (lateTurn(params.snapshot) ? 2 : 0) + Math.max(0, 2 - params.yourReserveCount);
  }

  if (params.state.activeStillPressured) {
    value -= 5 + (lateTurn(params.snapshot) ? 2 : 0);
  }

  if (params.state.establishHazard) {
    if (lateTurn(params.snapshot) && params.opponentReserveCount <= 1) value -= 14;
    else if (veryLateTurn(params.snapshot) && params.opponentReserveCount <= 2) value -= 10;
    else if (params.opponentReserveCount >= 3 && !lateTurn(params.snapshot)) value += 4;
    else value += 1;
  }

  if (params.state.removeHazards) {
    value += hazardPressureOnYourSide(params.snapshot) * 1.6;
    if (veryLateTurn(params.snapshot)) value += 2;
  }

  return Number(value.toFixed(1));
}

function makeProjectedBranchState(state: Partial<ProjectedBranchState>): ProjectedBranchState {
  return {
    hpSwingPercent: Number(state.hpSwingPercent ?? 0),
    tempoGain: Number(state.tempoGain ?? 0),
    cleanKo: Boolean(state.cleanKo),
    safeSetup: Boolean(state.safeSetup),
    preserveActive: Boolean(state.preserveActive),
    activeStillPressured: Boolean(state.activeStillPressured),
    establishHazard: Boolean(state.establishHazard),
    removeHazards: Boolean(state.removeHazards)
  };
}

function searchContributionForMove(params: {
  snapshot: BattleSnapshot;
  action: LegalAction;
  playerDamagePreview: DamagePreview[];
  opponentThreatPreview: ThreatPreview[];
  speedPreview?: SpeedPreview | undefined;
  opponentActionPrediction?: OpponentActionPrediction | undefined;
}) {
  const replies = weightedOpponentReplies(params.opponentActionPrediction);
  if (replies.length === 0) return { score: 0, reasons: [] as string[], riskFlags: [] as string[] };

  const gen = dataGen(params.snapshot.format);
  const move = lookupMove(gen, params.action.moveName ?? params.action.label);
  const preview = damagePreviewForAction(params.action, params.playerDamagePreview);
  const likely = likelyBand(preview?.bands);
  const bestThreat = summarizeBestThreat(params.opponentThreatPreview);
  const bestThreatBand = bestThreat?.band ?? null;
  const priority = Number(move?.priority ?? 0);
  const orderRelation = moveOrderRelation(params.snapshot, params.speedPreview, priority);
  const { hazardMove, hazardRemovalMove, pivotMove, recoveryMove, setupMove, targetedStatusMove } = moveRole(move);
  const existingHazard = hasSideCondition(params.snapshot.field.opponentSideConditions, String(move?.sideCondition ?? ""));
  const immediatePressure = bandAveragePercent(likely);
  const preservePressure = activePreservePressure({
    snapshot: params.snapshot,
    playerDamagePreview: params.playerDamagePreview,
    speedPreview: params.speedPreview
  });
  const activeHp = Number(params.snapshot.yourSide.active?.hpPercent ?? 100);
  const reserveCount = livingReserveCount(params.snapshot.yourSide.team);
  const opponentReserveCount = livingReserveCount(params.snapshot.opponentSide.team);
  const endgameSetupWindow = setupMove && activeHp >= 55 && reserveCount <= 2;
  const cleanKo = likelyKoLine(likely, orderRelation);
  const searchReasons: string[] = [];
  const searchRisks: string[] = [];
  let punishedLikelySwitchTarget = false;
  let punishedSpecificStayAttack = false;
  let rewardedLikelySwitchPunish = false;
  let preserveRisk = false;
  let preserveReward = false;
  let setupConversionReward = false;
  let lateHazardDrag = false;
  let endgameCollapseReward = false;
  const possibleSwitchNullifierLabels = new Set<string>();
  const hardSwitchNullifierDetails = new Set<string>();
  let hardSwitchNullifier = false;
  let expectedScore = 0;

  for (const reply of replies) {
    let branchScore = 0;
    if (reply.candidate.actionClass === "stay_attack") {
      const specificThreat = summarizeThreatForMove(params.opponentThreatPreview, reply.candidate.moveName);
      const replyThreatBand = specificThreat?.band ?? bestThreatBand;
      const projectedEnemyDamage = cleanKo && (orderRelation === "faster" || orderRelation === "priority")
        ? 0
        : bandAveragePercent(replyThreatBand);
      const projectedHpSwing = (cleanKo ? 100 : immediatePressure) - projectedEnemyDamage;
      const projectedTempoGain = (
        (orderRelation === "faster" || orderRelation === "priority" ? 4 : orderRelation === "overlap" ? 1 : -3)
        + (pivotMove ? 2 : 0)
        - (replyThreatBand?.coverage === "covers_current_hp" ? 2 : 0)
      );
      if (cleanKo) {
        branchScore += 18;
      } else if (immediatePressure >= 55) {
        branchScore += 6;
      }

      if (pivotMove && orderRelation !== "slower" && orderRelation !== "last") {
        branchScore += 6;
      }

      if ((hazardMove || hazardRemovalMove || setupMove || recoveryMove) && replyThreatBand) {
        if (replyThreatBand.coverage === "covers_current_hp" && orderRelation !== "faster" && orderRelation !== "priority") {
          branchScore -= 18;
          punishedSpecificStayAttack = true;
        } else if (replyThreatBand.coverage === "can_cover_current_hp" && orderRelation !== "faster" && orderRelation !== "priority") {
          branchScore -= 10;
          punishedSpecificStayAttack = true;
        }
      }

      if (preservePressure > 0 && reserveCount > 0 && !likelyKoLine(likely, orderRelation) && !pivotMove) {
        if (replyThreatBand?.coverage === "covers_current_hp") {
          const penalty = recoveryMove && orderRelation === "faster"
            ? Math.max(0, 4 + preservePressure * 0.4)
            : 6 + preservePressure * 1.2;
          branchScore -= penalty;
          preserveRisk = true;
        } else if (replyThreatBand?.coverage === "can_cover_current_hp" && activeHp <= 45 && !recoveryMove) {
          branchScore -= 3 + preservePressure * 0.8;
          preserveRisk = true;
        } else if (recoveryMove && activeHp <= 45) {
          branchScore += 4 + preservePressure * 0.8;
          preserveReward = true;
        }
      }

      if (targetedStatusMove && isStatusBand(likely)) {
        branchScore += 4;
      }

      const branchState = makeProjectedBranchState({
        hpSwingPercent: projectedHpSwing,
        tempoGain: projectedTempoGain,
        cleanKo: cleanKo && safeIntoThreatBand(replyThreatBand),
        safeSetup: endgameSetupWindow && safeIntoThreatBand(replyThreatBand),
        preserveActive: recoveryMove && activeHp <= 45 && replyThreatBand?.coverage !== "covers_current_hp",
        activeStillPressured: preservePressure > 0 && !cleanKo && !pivotMove && (
          replyThreatBand?.coverage === "covers_current_hp"
          || (replyThreatBand?.coverage === "can_cover_current_hp" && activeHp <= 45 && !recoveryMove)
        ),
        establishHazard: hazardMove && !existingHazard,
        removeHazards: hazardRemovalMove && hazardPressureOnYourSide(params.snapshot) > 0 && safeIntoThreatBand(replyThreatBand)
      });
      const boardValueDelta = projectedBoardValueDelta({
        snapshot: params.snapshot,
        yourReserveCount: reserveCount,
        opponentReserveCount,
        state: branchState
      });
      branchScore += boardValueDelta;
      if (boardValueDelta > 0 && branchState.cleanKo) {
        endgameCollapseReward = true;
      }
      if (boardValueDelta > 0 && branchState.safeSetup) {
        setupConversionReward = true;
      }
    } else if (reply.candidate.actionClass === "switch") {
      const switchPreview = damagePreviewForAction(params.action, reply.candidate.switchTargetPlayerPreview ?? []);
      const switchBand = likelyBand(switchPreview?.bands);
      const switchHintLabels = interactionHintLabels(switchPreview?.interactionHints);
      const switchPunishDamage = switchBand
        ? bandAveragePercent(switchBand)
        : 0;
      const projectedTempoGain = (pivotMove ? 4 : 0) + (hazardMove && !existingHazard ? 1 : 0) + (setupMove ? 2 : 0);

      if (switchBand) {
        if (isImmuneOrBlockedBand(switchBand)) {
          branchScore -= 24;
          punishedLikelySwitchTarget = true;
          hardSwitchNullifier = true;
          const detail = cleanBandDetail(switchBand.detail);
          if (detail) hardSwitchNullifierDetails.add(detail);
        } else if (switchHintLabels.length > 0) {
          branchScore -= 12;
          punishedLikelySwitchTarget = true;
          for (const label of switchHintLabels) possibleSwitchNullifierLabels.add(label);
        } else if (switchBand.coverage === "misses_current_hp" && bandMaxPercent(switchBand) <= 25) {
          branchScore -= 18;
          punishedLikelySwitchTarget = true;
        } else if (switchBand.coverage === "misses_current_hp" && bandMaxPercent(switchBand) <= 45) {
          branchScore -= 10;
          punishedLikelySwitchTarget = true;
        } else if (switchBand.coverage === "covers_current_hp" || bandAveragePercent(switchBand) >= 65) {
          branchScore += 12;
          rewardedLikelySwitchPunish = true;
        } else if (switchBand.coverage === "can_cover_current_hp" || bandAveragePercent(switchBand) >= 35) {
          branchScore += 6;
          rewardedLikelySwitchPunish = true;
        }
      } else {
        const switchTarget = findOpponentPokemon(params.snapshot, reply.candidate.switchTargetSpecies);
        const effectiveness = moveEffectivenessAgainstTarget(gen, move, switchTarget);
        if (effectiveness !== null && effectiveness <= 0) {
          branchScore -= 10;
          punishedLikelySwitchTarget = true;
        }
      }

      if (hazardMove && !existingHazard) {
        branchScore += 16;
      }
      if (setupMove) {
        branchScore += 12;
      }
      if (pivotMove) {
        branchScore += 10;
      }
      if (recoveryMove) {
        branchScore += 4;
      }
      if (targetedStatusMove) {
        branchScore -= 6;
      }
      if (!hazardMove && !setupMove && !pivotMove && immediatePressure < 45) {
        branchScore -= 5;
      }

      if (pivotMove && preservePressure > 0 && activeHp <= 45) {
        branchScore += 3 + preservePressure * 0.5;
        preserveReward = true;
      }

      const branchState = makeProjectedBranchState({
        hpSwingPercent: switchPunishDamage,
        tempoGain: projectedTempoGain,
        safeSetup: endgameSetupWindow && opponentReserveCount <= 2,
        preserveActive: pivotMove && preservePressure > 0 && activeHp <= 45,
        establishHazard: hazardMove && !existingHazard,
        removeHazards: hazardRemovalMove && hazardPressureOnYourSide(params.snapshot) > 0
      });
      const boardValueDelta = projectedBoardValueDelta({
        snapshot: params.snapshot,
        yourReserveCount: reserveCount,
        opponentReserveCount,
        state: branchState
      });
      branchScore += boardValueDelta;
      if (boardValueDelta > 0 && branchState.safeSetup) {
        setupConversionReward = true;
      }
    } else if (reply.candidate.actionClass === "status_or_setup") {
      const projectedTempoGain = (
        (bandCoverageScore(likely) >= 1 || immediatePressure >= 50 ? 2 : 0)
        + (setupMove ? 2 : 0)
        + (hazardMove && !existingHazard ? 1 : 0)
      );
      if (bandCoverageScore(likely) >= 1 || immediatePressure >= 50) {
        branchScore += 10;
      }
      if (setupMove) {
        branchScore -= 10;
      }
      if (hazardMove && !existingHazard) {
        branchScore += 4;
      }

      const branchState = makeProjectedBranchState({
        hpSwingPercent: immediatePressure * 0.4,
        tempoGain: projectedTempoGain,
        safeSetup: endgameSetupWindow && safeIntoThreatBand(bestThreatBand),
        establishHazard: hazardMove && !existingHazard
      });
      const boardValueDelta = projectedBoardValueDelta({
        snapshot: params.snapshot,
        yourReserveCount: reserveCount,
        opponentReserveCount,
        state: branchState
      });
      branchScore += boardValueDelta;
      if (boardValueDelta > 0 && branchState.safeSetup) {
        setupConversionReward = true;
      }
    }

    if (hazardMove && !existingHazard) {
      if ((lateTurn(params.snapshot) && opponentReserveCount <= 1) || (veryLateTurn(params.snapshot) && opponentReserveCount <= 2)) {
        lateHazardDrag = true;
      }
    }

    if (reply.candidate.source === "likely") {
      branchScore *= 0.9;
    }
    expectedScore += branchScore * reply.weight;
  }

  const rounded = Number(expectedScore.toFixed(1));
  if (rewardedLikelySwitchPunish) {
    searchReasons.push("punishes the likely switch target");
  }
  if (punishedLikelySwitchTarget) {
    searchRisks.push("likely switch target blunts this line");
  }
  if (hardSwitchNullifier) {
    const detail = [...hardSwitchNullifierDetails][0];
    searchRisks.push(detail ? `likely switch target blanks this move (${detail})` : "likely switch target blanks this move");
  }
  const possibleSwitchNullifierRisk = possibleNullifierRiskText([...possibleSwitchNullifierLabels], "switch-in");
  if (possibleSwitchNullifierRisk) {
    searchRisks.push(possibleSwitchNullifierRisk);
  }
  if (punishedSpecificStayAttack) {
    searchRisks.push("top opposing punish line still contests this");
  }
  if (preserveRisk) {
    searchRisks.push("staying risks a still-valuable active");
  }
  if (preserveReward) {
    searchReasons.push("preserves a pressured active across likely replies");
  }
  if (setupConversionReward) {
    searchReasons.push("setup converts well if this turn sticks");
  }
  if (lateHazardDrag) {
    searchRisks.push("hazards may be too slow for this game state");
  }
  if (endgameCollapseReward) {
    searchReasons.push("clean hit sharply improves the endgame");
  }

  if (rounded >= 6) {
    searchReasons.push("holds up across likely replies");
  } else if (rounded >= 3) {
    searchReasons.push("still acceptable into the main reply tree");
  } else if (rounded <= -6) {
    searchRisks.push("fragile if the opponent's top replies are right");
  } else if (rounded <= -3) {
    searchRisks.push("reply tree is shakier than the base score suggests");
  }

  return { score: rounded, reasons: searchReasons, riskFlags: searchRisks };
}

function searchContributionForSwitch(params: {
  snapshot: BattleSnapshot;
  action: LegalAction;
  opponentThreatPreview: ThreatPreview[];
  playerDamagePreview: DamagePreview[];
  speedPreview?: SpeedPreview | undefined;
  opponentActionPrediction?: OpponentActionPrediction | undefined;
}) {
  const replies = weightedOpponentReplies(params.opponentActionPrediction);
  const target = switchTargetForAction(params.snapshot, params.action);
  if (replies.length === 0 || !target) return { score: 0, reasons: [] as string[], riskFlags: [] as string[] };

  const bestIntoSwitch = bestSwitchThreat(params.opponentThreatPreview, target.species ?? target.displayName);
  const switchBand = bestIntoSwitch?.band ?? null;
  const hazardInfo = estimateSwitchEntryHazards(params.snapshot, target);
  const switchRelation = bestIntoSwitch?.target?.relation ?? "unknown";
  const preservePressure = activePreservePressure({
    snapshot: params.snapshot,
    playerDamagePreview: params.playerDamagePreview,
    speedPreview: params.speedPreview
  });
  const activeHp = Number(params.snapshot.yourSide.active?.hpPercent ?? 100);
  const reserveCount = livingReserveCount(params.snapshot.yourSide.team);
  const opponentReserveCount = livingReserveCount(params.snapshot.opponentSide.team);
  const searchReasons: string[] = [];
  const searchRisks: string[] = [];
  let matchedSpecificMove = false;
  let specificMovePunish = false;
  let preserveReward = false;
  let expectedScore = 0;

  for (const reply of replies) {
    let branchScore = 0;
    if (reply.candidate.actionClass === "stay_attack") {
      const specificThreat = switchThreatForMove(
        params.opponentThreatPreview,
        reply.candidate.moveName,
        target.species ?? target.displayName
      );
      const replyBand = specificThreat?.band ?? switchBand;
      const projectedEnemyDamage = bandAveragePercent(replyBand) + hazardInfo.damagePercent;
      const projectedTempoGain = (switchFeelsSafe(replyBand) ? 3 : -2) + (switchRelation === "faster" ? 2 : switchRelation === "slower" ? -1 : 0);
      if (specificThreat) matchedSpecificMove = true;

      if (switchFeelsGreat(replyBand)) {
        branchScore += 18;
      } else if (switchFeelsSafe(replyBand)) {
        branchScore += 10;
      } else if (replyBand?.coverage === "can_cover_current_hp") {
        branchScore -= 10;
        if (specificThreat) specificMovePunish = true;
      } else if (replyBand?.coverage === "covers_current_hp") {
        branchScore -= 18;
        if (specificThreat) specificMovePunish = true;
      }

      if (preservePressure > 0 && reserveCount > 0 && switchFeelsSafe(replyBand)) {
        branchScore += 4 + preservePressure * 1.1;
        preserveReward = true;
      }

      const branchState = makeProjectedBranchState({
        hpSwingPercent: -projectedEnemyDamage,
        tempoGain: projectedTempoGain,
        preserveActive: preservePressure > 0 && reserveCount > 0 && switchFeelsSafe(replyBand),
        activeStillPressured: !switchFeelsSafe(replyBand) && (replyBand?.coverage === "covers_current_hp" || replyBand?.coverage === "can_cover_current_hp")
      });
      const boardValueDelta = projectedBoardValueDelta({
        snapshot: params.snapshot,
        yourReserveCount: reserveCount,
        opponentReserveCount,
        state: branchState
      });
      branchScore += boardValueDelta;
    } else if (reply.candidate.actionClass === "switch") {
      branchScore -= 10;
      if (hazardsPunishOpponentSwitches(params.snapshot)) {
        branchScore += 3;
      }
      if (preservePressure > 0 && activeHp <= 35) {
        branchScore += 2 + preservePressure * 0.4;
        preserveReward = true;
      }

      const branchState = makeProjectedBranchState({
        hpSwingPercent: -hazardInfo.damagePercent,
        tempoGain: -2,
        preserveActive: preservePressure > 0 && activeHp <= 35
      });
      const boardValueDelta = projectedBoardValueDelta({
        snapshot: params.snapshot,
        yourReserveCount: reserveCount,
        opponentReserveCount,
        state: branchState
      });
      branchScore += boardValueDelta;
    } else if (reply.candidate.actionClass === "status_or_setup") {
      branchScore += switchFeelsSafe(switchBand) ? 4 : -2;
      if (switchRelation === "faster") {
        branchScore += 3;
      }
      if (preservePressure > 0 && switchFeelsSafe(switchBand)) {
        branchScore += 2 + preservePressure * 0.5;
        preserveReward = true;
      }

      const branchState = makeProjectedBranchState({
        hpSwingPercent: -hazardInfo.damagePercent * 0.6,
        tempoGain: switchFeelsSafe(switchBand) ? 2 : -1,
        preserveActive: preservePressure > 0 && switchFeelsSafe(switchBand)
      });
      const boardValueDelta = projectedBoardValueDelta({
        snapshot: params.snapshot,
        yourReserveCount: reserveCount,
        opponentReserveCount,
        state: branchState
      });
      branchScore += boardValueDelta;
    }

    if (hazardInfo.damagePercent >= 25) branchScore -= 8;
    else if (hazardInfo.damagePercent >= 12.5) branchScore -= 4;
    if (hazardInfo.stickyWeb) branchScore -= 3;

    if (reply.candidate.source === "likely") {
      branchScore *= 0.9;
    }
    expectedScore += branchScore * reply.weight;
  }

  const rounded = Number(expectedScore.toFixed(1));
  if (matchedSpecificMove && !specificMovePunish) {
    searchReasons.push("lines up well into their top attacking move");
  }
  if (specificMovePunish) {
    searchRisks.push("their top attacking move still pressures this switch");
  }
  if (preserveReward) {
    searchReasons.push("preserves a pressured active across likely replies");
  }

  if (rounded >= 6) {
    searchReasons.push("best against the opponent's likely reply tree");
  } else if (rounded >= 3) {
    searchReasons.push("still gains value across common replies");
  } else if (rounded <= -6) {
    searchRisks.push("reply-aware check dislikes this switch");
  } else if (rounded <= -3) {
    searchRisks.push("opponent replies reduce the value of this switch");
  }

  return { score: rounded, reasons: searchReasons, riskFlags: searchRisks };
}

export function selectReplyAwareSearchActionIds(candidates: SelfActionCandidate[]) {
  const sorted = candidates
    .slice()
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const leaderScore = Number(sorted[0]?.score ?? 0);
  return new Set(
    sorted
      .filter((candidate, index) => (
        candidate.kind === "switch"
        || index < SEARCH_PLAYER_MIN_COUNT
        || Number(candidate.score ?? 0) >= leaderScore - SEARCH_PLAYER_SCORE_BAND
      ))
      .map((candidate) => candidate.actionId)
  );
}

function applyReplyAwareSearch(params: {
  snapshot: BattleSnapshot;
  candidates: SelfActionCandidate[];
  legalActions: LegalAction[];
  playerDamagePreview: DamagePreview[];
  opponentThreatPreview: ThreatPreview[];
  speedPreview?: SpeedPreview | undefined;
  opponentActionPrediction?: OpponentActionPrediction | undefined;
}) {
  const topActionIds = selectReplyAwareSearchActionIds(params.candidates);
  const actionById = new Map(params.legalActions.map((action) => [action.id, action]));

  return params.candidates.map((candidate) => {
    if (!topActionIds.has(candidate.actionId)) {
      return candidate;
    }

    const action = actionById.get(candidate.actionId);
    if (!action) return candidate;

    const searchContribution = candidate.kind === "switch"
      ? searchContributionForSwitch({
          snapshot: params.snapshot,
          action,
          opponentThreatPreview: params.opponentThreatPreview,
          playerDamagePreview: params.playerDamagePreview,
          speedPreview: params.speedPreview,
          opponentActionPrediction: params.opponentActionPrediction
        })
      : searchContributionForMove({
          snapshot: params.snapshot,
          action,
          playerDamagePreview: params.playerDamagePreview,
          opponentThreatPreview: params.opponentThreatPreview,
          speedPreview: params.speedPreview,
          opponentActionPrediction: params.opponentActionPrediction
        });

    if (!searchContribution.score) {
      return candidate;
    }

    const nextBreakdown = [...(candidate.scoreBreakdown ?? []).filter((entry) => entry.key !== "search")];
    pushScoreComponent(nextBreakdown, "search", "Reply-aware search", searchContribution.score);

    return {
      ...candidate,
      score: clampScore(candidate.score + searchContribution.score),
      reasons: uniqueStrings([...candidate.reasons, ...searchContribution.reasons]).slice(0, 4),
      riskFlags: uniqueStrings([...candidate.riskFlags, ...searchContribution.riskFlags]).slice(0, 4),
      scoreBreakdown: scoreComponentsForOutput(nextBreakdown)
    };
  });
}

function scoreConfidenceTier(topScore: number, runnerUpScore: number, topAction: SelfActionCandidate | undefined) {
  const gap = topScore - runnerUpScore;
  if (!topAction || topScore < 24) return "low" as const;
  if (topScore >= 64 && gap >= 14 && topAction.riskFlags.length <= 1) return "high" as const;
  if (topScore >= 42 && gap >= 7) return "medium" as const;
  return "low" as const;
}

function formatReasonList(reasons: string[]) {
  const unique = uniqueStrings(reasons).slice(0, 3);
  if (unique.length === 0) return "No strong deterministic edge yet.";
  return unique.join("; ");
}

function buildMoveCandidate(params: {
  snapshot: BattleSnapshot;
  action: LegalAction;
  preview: DamagePreview | null;
  speedPreview?: SpeedPreview | undefined;
  opponentThreatPreview: ThreatPreview[];
  opponentActionPrediction?: OpponentActionPrediction | undefined;
  playerDamagePreview: DamagePreview[];
}): SelfActionCandidate {
  const gen = dataGen(params.snapshot.format);
  const opponentCanSwitch = livingReserveCount(params.snapshot.opponentSide.team) > 0;
  const move = lookupMove(gen, params.action.moveName ?? params.action.label);
  const likely = likelyBand(params.preview?.bands);
  const bestThreat = summarizeBestThreat(params.opponentThreatPreview);
  const bestThreatBand = bestThreat?.band ?? null;
  const classProb = classProbabilities(params.opponentActionPrediction);
  const reasons: string[] = [];
  const riskFlags: string[] = [];
  const priority = Number(move?.priority ?? 0);
  const orderRelation = moveOrderRelation(params.snapshot, params.speedPreview, priority);
  const { hazardMove, hazardRemovalMove, pivotMove, recoveryMove, setupMove, targetedStatusMove } = moveRole(move);
  const preserveValue = activePreservationValue({
    snapshot: params.snapshot,
    playerDamagePreview: params.playerDamagePreview,
    speedPreview: params.speedPreview
  });
  const sackTolerance = activeSackTolerance({
    snapshot: params.snapshot,
    playerDamagePreview: params.playerDamagePreview,
    speedPreview: params.speedPreview
  });
  const breakdown: ActionScoreComponent[] = [];
  let baseScore = 10;
  let tacticalScore = 0;
  let boardScore = 0;
  let predictionScore = 0;
  let preserveScore = 0;
  let hazardScore = 0;
  let riskScore = 0;

  if (params.action.disabled) {
    riskScore -= 100;
    riskFlags.push("move is currently disabled");
  }

  if (params.preview) {
    if (isImmuneOrBlockedBand(likely)) {
      tacticalScore -= 40;
      riskFlags.push("current target can ignore or block this move");
    } else if (isStatusBand(likely)) {
      tacticalScore += 8;
      if (targetedStatusMove) {
        reasons.push("status line is live into the current board");
      }
    } else {
      const avgPercent = bandAveragePercent(likely);
      const coverage = bandCoverageScore(likely);
      tacticalScore += avgPercent * 0.48;
      tacticalScore += coverage === 2 ? 38 : coverage === 1 ? 20 : 0;

      if (coverage === 2 && orderRelation === "faster") {
        reasons.push("faster and can KO");
      } else if (coverage === 2 && orderRelation === "priority") {
        reasons.push("priority gives a clean KO line");
      } else if (coverage === 1 && (orderRelation === "faster" || orderRelation === "priority")) {
        reasons.push("faster and has a KO roll");
      } else if (avgPercent >= 55) {
        reasons.push("strong immediate damage");
      }

      if (params.preview.likelyBandSource && params.preview.likelyBandSource !== "calc") {
        tacticalScore += 3;
        reasons.push(
          params.preview.likelyBandSource === "posterior"
            ? "covers hidden threat range"
            : "backed by local observed damage"
        );
      }

      if (params.preview.observedRange && params.preview.observedRange.sampleCount >= 2) {
        tacticalScore += 2;
      }
    }

    if (!isImmuneOrBlockedBand(likely)) {
      const possibleCurrentNullifierRisk = possibleNullifierRiskText(
        interactionHintLabels(params.preview.interactionHints),
        "on the current target"
      );
      if (possibleCurrentNullifierRisk) {
        riskScore -= 10;
        riskFlags.push(possibleCurrentNullifierRisk);
      }
    }
  }

  if (orderRelation === "faster") {
    tacticalScore += 12;
  } else if (orderRelation === "priority") {
    tacticalScore += 8;
    reasons.push("priority compresses the speed race");
    riskFlags.push("opponent priority can still contest the turn");
  } else if (orderRelation === "overlap") {
    tacticalScore += 3;
    riskFlags.push("speed still overlaps");
  } else if (orderRelation === "slower") {
    tacticalScore -= 10;
    riskFlags.push("you likely move second");
  } else if (orderRelation === "last") {
    tacticalScore -= 18;
    riskFlags.push("negative priority loses initiative");
  }

  if (bestThreatBand && (orderRelation === "slower" || orderRelation === "overlap" || orderRelation === "unknown")) {
    if (bestThreatBand.coverage === "covers_current_hp") {
      riskScore -= 26;
      riskFlags.push("opponent can KO before or during this line");
    } else if (bestThreatBand.coverage === "can_cover_current_hp") {
      riskScore -= 14;
      riskFlags.push("opponent has a live punish roll");
    }
  }

  if (pivotMove && opponentCanSwitch) {
    predictionScore += 5 + 12 * classProb.switchOut + 4 * classProb.statusOrSetup;
    reasons.push(classProb.switchOut >= 0.35 ? "keeps initiative into switch-heavy lines" : "keeps initiative if they switch");
  }

  if (hazardMove) {
    const sideCondition = normalizeName(String(move?.sideCondition ?? ""));
    const existingHazards = params.snapshot.field.opponentSideConditions.map((value) => normalizeName(value));
    if (!existingHazards.includes(sideCondition)) {
      hazardScore += 12;
      reasons.push("hazard pressure makes switching costly");
      if (earlyTurn(params.snapshot)) {
        hazardScore += 8;
        reasons.push("early-game hazard turn is still valuable");
      }
      if (opponentCanSwitch) {
        const windowScore = 10 * classProb.switchOut + 4 * classProb.statusOrSetup;
        hazardScore += windowScore;
        if (windowScore >= 6) {
          reasons.push("opponent tempo gives a hazard window");
        }
      }
    } else {
      hazardScore -= 10;
      riskFlags.push("that hazard is already up");
    }
    if (lateTurn(params.snapshot)) {
      hazardScore -= 14;
      riskFlags.push("late-game hazards are less valuable now");
    }
  }

  if (hazardRemovalMove) {
    const removalPressure = hazardPressureOnYourSide(params.snapshot);
    if (removalPressure > 0) {
      hazardScore += 8 + removalPressure * 3.5;
      reasons.push("removing hazards improves the full board");
      if (veryLateTurn(params.snapshot)) {
        hazardScore += 3;
      }
    } else {
      hazardScore -= 8;
      riskFlags.push("hazard removal is low value with no hazards up");
    }
    if (bestThreatBand?.coverage === "covers_current_hp" && orderRelation !== "faster" && orderRelation !== "priority") {
      hazardScore -= 10;
      riskFlags.push("removal line can be punished before it pays off");
    }
    if (normalizeName(move?.name) === "rapidspin") {
      tacticalScore += 4;
    }
  }

  if (setupMove) {
    boardScore += 6;
    const safeBoard = !bestThreatBand || (bestThreatBand.coverage === "misses_current_hp" && bandMaxPercent(bestThreatBand) <= 45);
    if (safeBoard) {
      boardScore += 12;
      reasons.push("safe enough board to set up");
    }
    const setupWindow = 16 * classProb.switchOut + 9 * classProb.statusOrSetup - 10 * classProb.stayAttack;
    predictionScore += setupWindow;
    if (setupWindow >= 8) {
      reasons.push("predicted line leaves a real setup window");
    }
    if (lateTurn(params.snapshot)) {
      boardScore -= 16;
      riskFlags.push("late-game immediate damage is usually stronger than setup");
    }
  }

  if (recoveryMove) {
    const currentHp = Number(params.snapshot.yourSide.active?.hpPercent ?? 100);
    if (currentHp <= 45) {
      preserveScore += 18;
      reasons.push("preserves win condition");
    } else {
      preserveScore -= 4;
    }
    predictionScore += (1 - classProb.stayAttack) * 6;
    if (bestThreatBand?.coverage === "covers_current_hp" && orderRelation !== "faster" && orderRelation !== "priority") {
      preserveScore -= 14;
      riskFlags.push("recovery can still be punished immediately");
    }
  }

  if (targetedStatusMove) {
    if (isStatusBand(likely)) {
      tacticalScore += 10;
    } else if (isImmuneOrBlockedBand(likely)) {
      tacticalScore -= 16;
      riskFlags.push("status line is blocked by typing or ability");
    }
  }

  if (!hazardMove && !hazardRemovalMove && !setupMove && !recoveryMove && lateTurn(params.snapshot)) {
    boardScore += 6;
    reasons.push("late-game immediate damage is stronger than setup");
  }

  if (!hazardMove && !hazardRemovalMove && !setupMove && !recoveryMove && earlyTurn(params.snapshot) && opponentCanSwitch) {
    predictionScore += 4 * classProb.switchOut;
  }

  if (veryLateTurn(params.snapshot) && !hazardMove && !setupMove) {
    boardScore += 4;
  }

  if (hazardsPunishOpponentSwitches(params.snapshot) && opponentCanSwitch && !hazardMove) {
    predictionScore += 4 * classProb.switchOut;
    if (classProb.switchOut >= 0.35) {
      reasons.push("hazards punish likely switch lines");
    }
  }

  const hasForcedKo = likelyKoLine(likely, orderRelation);
  if (bestThreatBand && (bestThreatBand.coverage === "covers_current_hp" || bestThreatBand.coverage === "can_cover_current_hp") && !hasForcedKo) {
    const preservePenalty = Math.max(0, preserveValue * 0.9 - sackTolerance);
    preserveScore -= preservePenalty;
    if (preservePenalty >= 4) {
      riskFlags.push("preserving the active matters more than trading here");
    }
  }

  if ((params.snapshot.yourSide.active?.hpPercent ?? 100) <= 30 && !recoveryMove && !pivotMove && !hazardMove && !hazardRemovalMove && !setupMove) {
    riskFlags.push("staying may throw away a low-HP piece");
  }

  const predictionPenalty = predictionUncertaintyPenalty(params.opponentActionPrediction, true);
  const teraPenalty = teraUncertaintyPenalty(
    params.snapshot,
    moveLineIsTeraSensitive({
      snapshot: params.snapshot,
      move,
      likely,
      hazardMove,
      hazardRemovalMove,
      setupMove,
      recoveryMove,
      targetedStatusMove
    })
  );
  riskScore -= predictionPenalty + teraPenalty;
  if (predictionPenalty > 0 && teraPenalty > 0) {
    riskFlags.push("hidden Tera or prediction uncertainty can swing this line");
  } else if (teraPenalty > 0) {
    riskFlags.push("unspent Tera can still shift this line");
  } else if (predictionPenalty > 0) {
    riskFlags.push("prediction uncertainty still makes this line thin");
  }

  pushScoreComponent(breakdown, "tactical", "Immediate tactical value", tacticalScore);
  pushScoreComponent(breakdown, "board", "Board-position value", boardScore);
  pushScoreComponent(breakdown, "prediction", "Expected value vs likely lines", predictionScore);
  pushScoreComponent(breakdown, "preserve", "Preserve or sack pressure", preserveScore);
  pushScoreComponent(breakdown, "hazard", "Hazard game", hazardScore);
  pushScoreComponent(breakdown, "risk", "Punish and uncertainty", riskScore);

  const score = clampScore(
    baseScore
      + tacticalScore
      + boardScore
      + predictionScore
      + preserveScore
      + hazardScore
      + riskScore
  );

  return {
    actionId: params.action.id,
    kind: params.action.kind,
    label: params.action.label,
    score,
    reasons: uniqueStrings(reasons).slice(0, 4),
    riskFlags: uniqueStrings(riskFlags).slice(0, 4),
    moveName: params.action.moveName ?? move?.name ?? undefined,
    scoreBreakdown: scoreComponentsForOutput(breakdown)
  };
}

function buildSwitchCandidate(params: {
  snapshot: BattleSnapshot;
  action: LegalAction;
  speedPreview?: SpeedPreview | undefined;
  opponentThreatPreview: ThreatPreview[];
  opponentActionPrediction?: OpponentActionPrediction | undefined;
  playerDamagePreview: DamagePreview[];
}): SelfActionCandidate | null {
  const target = switchTargetForAction(params.snapshot, params.action);
  if (!target) return null;

  const bestActiveAttack = summarizeBestDamage(params.playerDamagePreview);
  const bestActiveThreat = summarizeBestThreat(params.opponentThreatPreview);
  const bestIntoSwitch = bestSwitchThreat(params.opponentThreatPreview, target.species ?? target.displayName);
  const switchBand = bestIntoSwitch?.band ?? null;
  const classProb = classProbabilities(params.opponentActionPrediction);
  const hazardInfo = estimateSwitchEntryHazards(params.snapshot, target);
  const currentThreatBand = bestActiveThreat?.band ?? null;
  const switchRelation = params.speedPreview?.switchMatchups?.find((entry) => normalizeName(entry.species) === normalizeName(target.species ?? target.displayName))?.relation ?? "unknown";
  const preserveValue = activePreservationValue({
    snapshot: params.snapshot,
    playerDamagePreview: params.playerDamagePreview,
    speedPreview: params.speedPreview
  });
  const sackTolerance = activeSackTolerance({
    snapshot: params.snapshot,
    playerDamagePreview: params.playerDamagePreview,
    speedPreview: params.speedPreview
  });
  const reasons: string[] = [];
  const riskFlags: string[] = [];
  const breakdown: ActionScoreComponent[] = [];
  let baseScore = 12;
  let tacticalScore = 0;
  let boardScore = 0;
  let predictionScore = 0;
  let preserveScore = 0;
  let hazardScore = 0;
  let riskScore = 0;

  if (bestActiveAttack?.band && bandCoverageScore(bestActiveAttack.band) === 2) {
    tacticalScore -= 16;
    riskFlags.push("switching gives up a clean attacking line");
  } else if (bestActiveAttack?.band && bandCoverageScore(bestActiveAttack.band) === 1) {
    tacticalScore -= 8;
  }

  if (currentThreatBand && (currentThreatBand.coverage === "covers_current_hp" || currentThreatBand.coverage === "can_cover_current_hp")) {
    if (!switchBand || switchFeelsSafe(switchBand)) {
      preserveScore += currentThreatBand.coverage === "covers_current_hp" ? 30 : 20;
      predictionScore += 12 * classProb.stayAttack;
      reasons.push("safer than the obvious stay line");
    }
  }

  if (!switchBand) {
    tacticalScore += 10;
  } else if (isImmuneOrBlockedBand(switchBand)) {
    tacticalScore += 28;
    reasons.push("obvious immunity on the likely line");
  } else if (switchBand.coverage === "misses_current_hp" && bandMaxPercent(switchBand) <= 35) {
    tacticalScore += 22;
    reasons.push("switch target absorbs the likely attack");
  } else if (switchBand.coverage === "misses_current_hp" && bandMaxPercent(switchBand) <= 50) {
    tacticalScore += 10;
    reasons.push("safer than staying");
  } else if (switchBand.coverage === "can_cover_current_hp") {
    riskScore -= 12;
    riskFlags.push("switch target still takes a heavy hit");
  } else if (switchBand.coverage === "covers_current_hp") {
    riskScore -= 24;
    riskFlags.push("switch target can still be broken immediately");
  }

  if (bestIntoSwitch?.target?.likelyBandSource && bestIntoSwitch.target.likelyBandSource !== "calc" && switchFeelsSafe(switchBand)) {
    tacticalScore += 3;
    reasons.push("covers hidden threat range");
  }

  if (hazardInfo.damagePercent >= 25) {
    hazardScore -= 24;
    riskFlags.push("entry hazards punish this switch heavily");
  } else if (hazardInfo.damagePercent >= 12.5) {
    hazardScore -= 12;
    riskFlags.push("entry hazards tax this switch");
  } else if (hazardInfo.damagePercent > 0) {
    hazardScore -= 5;
    riskFlags.push("light hazard chip still matters");
  }
  if (hazardInfo.stickyWeb) {
    hazardScore -= 4;
    riskFlags.push("Sticky Web cuts Speed on entry");
  }

  if (switchRelation === "faster") {
    boardScore += 6;
    reasons.push("faster after switching");
  } else if (switchRelation === "overlap") {
    riskFlags.push("speed still overlaps after the switch");
  } else if (switchRelation === "slower") {
    boardScore -= 4;
  }

  if (switchFeelsGreat(switchBand)) {
    predictionScore += 10 * classProb.stayAttack;
  }
  if (switchFeelsSafe(switchBand)) {
    predictionScore -= 8 * classProb.switchOut;
    if (classProb.switchOut >= 0.4) {
      riskFlags.push("hard switch can lose tempo into a likely opposing switch");
    }
  }

  const preserveBonus = Math.max(0, preserveValue - sackTolerance) * 0.9;
  if (switchFeelsSafe(switchBand) && preserveBonus > 0) {
    preserveScore += preserveBonus;
    if (preserveBonus >= 5) {
      reasons.push("preserves a still-useful active");
    }
  }
  if ((params.snapshot.yourSide.active?.hpPercent ?? 100) <= 35) {
    preserveScore += 8;
    reasons.push("preserves win condition");
  }

  if (lateTurn(params.snapshot)) {
    if ((params.snapshot.yourSide.active?.hpPercent ?? 100) <= 50) {
      preserveScore += 8;
      reasons.push("late-game preservation still matters");
    }
    if (livingReserveCount(params.snapshot.yourSide.team) <= 1) {
      preserveScore -= 6;
      riskFlags.push("few reserve pivots remain late-game");
    }
  }

  const predictionPenalty = predictionUncertaintyPenalty(params.opponentActionPrediction, true);
  const teraPenalty = teraUncertaintyPenalty(params.snapshot, true);
  riskScore -= predictionPenalty + teraPenalty;
  if (predictionPenalty + teraPenalty >= 5 && !riskFlags.includes("hard switch can lose tempo into a likely opposing switch")) {
    riskFlags.push("hidden Tera or prediction uncertainty can punish a hard switch");
  }

  pushScoreComponent(breakdown, "tactical", "Immediate tactical value", tacticalScore);
  pushScoreComponent(breakdown, "board", "Board-position value", boardScore);
  pushScoreComponent(breakdown, "prediction", "Expected value vs likely lines", predictionScore);
  pushScoreComponent(breakdown, "preserve", "Preserve or sack pressure", preserveScore);
  pushScoreComponent(breakdown, "hazard", "Hazard game", hazardScore);
  pushScoreComponent(breakdown, "risk", "Punish and uncertainty", riskScore);

  const score = clampScore(
    baseScore
      + tacticalScore
      + boardScore
      + predictionScore
      + preserveScore
      + hazardScore
      + riskScore
  );

  return {
    actionId: params.action.id,
    kind: params.action.kind,
    label: params.action.label,
    score,
    reasons: uniqueStrings(reasons).slice(0, 4),
    riskFlags: uniqueStrings(riskFlags).slice(0, 4),
    switchTargetSpecies: target.species ?? target.displayName ?? undefined,
    scoreBreakdown: scoreComponentsForOutput(breakdown)
  };
}

export function buildSelfActionRecommendation(params: {
  snapshot: BattleSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  playerDamagePreview?: DamagePreview[] | undefined;
  opponentThreatPreview?: ThreatPreview[] | undefined;
  speedPreview?: SpeedPreview | undefined;
  opponentActionPrediction?: OpponentActionPrediction | undefined;
}): SelfActionRecommendation | undefined {
  const legalActions = (params.snapshot.legalActions ?? []).filter((action) => !action.disabled);
  const playerDamagePreview = Array.isArray(params.playerDamagePreview) ? params.playerDamagePreview : [];
  const opponentThreatPreview = Array.isArray(params.opponentThreatPreview) ? params.opponentThreatPreview : [];
  const opponentCanSwitch = livingReserveCount(params.snapshot.opponentSide.team) > 0;
  if (legalActions.length === 0 || params.snapshot.phase !== "turn" || !params.snapshot.yourSide.active || !params.snapshot.opponentSide.active) {
    return undefined;
  }

  const candidates: SelfActionCandidate[] = [];
  for (const action of legalActions) {
    if (action.kind === "move") {
      candidates.push(buildMoveCandidate({
        snapshot: params.snapshot,
        action,
        preview: damagePreviewForAction(action, playerDamagePreview),
        speedPreview: params.speedPreview,
        opponentThreatPreview,
        opponentActionPrediction: params.opponentActionPrediction,
        playerDamagePreview
      }));
      continue;
    }
    if (action.kind === "switch") {
      const candidate = buildSwitchCandidate({
        snapshot: params.snapshot,
        action,
        speedPreview: params.speedPreview,
        opponentThreatPreview,
        opponentActionPrediction: params.opponentActionPrediction,
        playerDamagePreview
      });
      if (candidate) candidates.push(candidate);
      continue;
    }
  }

  if (candidates.length === 0) return undefined;

  const searchedCandidates = applyReplyAwareSearch({
    snapshot: params.snapshot,
    candidates,
    legalActions,
    playerDamagePreview,
    opponentThreatPreview,
    speedPreview: params.speedPreview,
    opponentActionPrediction: params.opponentActionPrediction
  });

  const rankedActions = searchedCandidates
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const top = rankedActions[0];
  const confidenceTier = scoreConfidenceTier(top?.score ?? 0, rankedActions[1]?.score ?? 0, top);
  const reasons = uniqueStrings([
    ...(top?.reasons ?? []),
    ...(lateTurn(params.snapshot) && top?.kind === "move" ? ["late-game immediate damage is stronger than setup"] : []),
    ...(opponentCanSwitch && predictedClassIs(params.opponentActionPrediction, "switch") && top?.moveName ? ["punishes likely switch"] : [])
  ]).slice(0, 4);
  const riskFlags = uniqueStrings([
    ...(top?.riskFlags ?? []),
    ...((params.activeOpponentEntry?.likelyTeraTypes?.length ?? 0) > 0 && !params.snapshot.opponentSide.active?.terastallized ? ["unspent Tera can still change this line"] : []),
    ...((params.opponentActionPrediction?.confidenceTier ?? "low") === "low" ? ["opponent line is still uncertain"] : [])
  ]).slice(0, 4);
  const summary = top
    ? `${top.label}: ${formatReasonList(top.reasons)}${top.riskFlags.length > 0 ? `; watch ${top.riskFlags[0]}` : ""}.`
    : "No deterministic recommendation yet.";

  return {
    topActionId: top?.actionId ?? null,
    confidenceTier,
    rankedActions,
    reasons,
    riskFlags,
    summary
  };
}
