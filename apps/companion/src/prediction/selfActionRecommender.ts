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

function moveRole(move: ReturnType<typeof lookupMove>) {
  const id = normalizeName(move?.name);
  const hazardMove = ["stealthrock", "spikes", "toxicspikes", "stickyweb"].includes(normalizeName(String(move?.sideCondition ?? "")));
  const hazardRemovalMove = ["defog", "rapidspin", "mortalspin", "tidyup", "courtchange"].includes(id);
  const pivotMove = Boolean(move?.selfSwitch) || ["uturn", "voltswitch", "flipturn", "partingshot", "chillyreception", "batonpass", "teleport"].includes(id);
  const recoveryMove = Boolean(move?.heal) || /recover|roost|slackoff|softboiled|moonlight|morningsun|wish|rest/i.test(String(move?.name ?? ""));
  const setupMove = Boolean(move?.boosts) || Boolean(move?.self?.boosts);
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

function uncertaintyPenalty(snapshot: BattleSnapshot, prediction: OpponentActionPrediction | undefined, volatileLine: boolean) {
  if (!volatileLine) return 0;
  let penalty = 0;
  if (!prediction || prediction.confidenceTier === "low") penalty += 4;
  if (!snapshot.opponentSide.active?.terastallized) penalty += 3;
  return penalty;
}

function switchTargetForAction(snapshot: BattleSnapshot, action: LegalAction) {
  const fromAction = normalizeName(action.label || action.details || action.id);
  const byId = normalizeName(action.id);
  return snapshot.yourSide.team.find((pokemon) => {
    if (pokemon.fainted || pokemon.active) return false;
    const names = uniqueStrings([pokemon.species, pokemon.displayName, pokemon.ident]);
    return names.some((name) => {
      const normalized = normalizeName(name);
      return normalized && (fromAction.includes(normalized) || byId.includes(normalized));
    });
  }) ?? null;
}

function damagePreviewForAction(action: LegalAction, previews: DamagePreview[]) {
  const actionId = normalizeName(action.id);
  const moveId = normalizeName(action.moveName ?? action.label);
  return previews.find((entry) => normalizeName(entry.actionId) === actionId)
    ?? previews.find((entry) => normalizeName(entry.moveName) === moveId)
    ?? null;
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

  const volatilityPenalty = uncertaintyPenalty(
    params.snapshot,
    params.opponentActionPrediction,
    hazardMove || hazardRemovalMove || setupMove || recoveryMove
  );
  riskScore -= volatilityPenalty;
  if (volatilityPenalty >= 5) {
    riskFlags.push("hidden Tera or prediction uncertainty can swing this line");
  } else if ((params.opponentActionPrediction?.riskFlags?.length ?? 0) > 0 && !params.snapshot.opponentSide.active?.terastallized) {
    riskFlags.push("unspent Tera can still shift this line");
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

  const volatilityPenalty = uncertaintyPenalty(params.snapshot, params.opponentActionPrediction, true);
  riskScore -= volatilityPenalty;
  if (volatilityPenalty >= 5 && !riskFlags.includes("hard switch can lose tempo into a likely opposing switch")) {
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

  const rankedActions = candidates
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
