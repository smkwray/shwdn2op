import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import { buildDamagePreview } from "../prompting/damageNotes.js";
import type {
  BattleSnapshot,
  DamageAssumptionBand,
  DamagePreview,
  OpponentActionCandidate,
  OpponentActionPrediction,
  OpponentIntelEntry,
  PokemonSnapshot,
  ThreatPreview
} from "../types.js";

const gens = new Generations(Dex as any);

type MoveRelation = "faster" | "slower" | "overlap" | "unknown";

type SwitchTargetPreview = {
  pokemon: PokemonSnapshot;
  entry?: OpponentIntelEntry | undefined;
  damagePreview: DamagePreview[];
  hazardDamagePercent: number;
  stickyWeb: boolean;
  source: "revealed_switch" | "previewed_switch";
};

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
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

function isDamagingBand(band: DamageAssumptionBand | null | undefined) {
  return Boolean(band) && (!band?.outcome || band.outcome === "damage");
}

function isImmuneOrBlockedBand(band: DamageAssumptionBand | null | undefined) {
  return band?.outcome === "immune" || band?.outcome === "blocked";
}

function relationAfterTrickRoomFromYourPerspective(snapshot: BattleSnapshot, relation: MoveRelation): MoveRelation {
  const trickRoomActive = snapshot.field.pseudoWeather.some((value) => /trick room/i.test(String(value ?? "")));
  if (!trickRoomActive) return relation;
  if (relation === "faster") return "slower";
  if (relation === "slower") return "faster";
  return relation;
}

function opponentMoveOrderRelation(snapshot: BattleSnapshot, relation: MoveRelation): MoveRelation {
  const adjusted = relationAfterTrickRoomFromYourPerspective(snapshot, relation);
  if (adjusted === "faster") return "slower";
  if (adjusted === "slower") return "faster";
  return adjusted;
}

function attackOrderBonus(relation: MoveRelation) {
  if (relation === "faster") return 14;
  if (relation === "overlap") return 4;
  if (relation === "slower") return -12;
  return 0;
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

function livingReserveCount(team: PokemonSnapshot[], excludeActive = true) {
  return team.filter((pokemon) => !pokemon.fainted && (!excludeActive || !pokemon.active)).length;
}

function currentBattleTypes(
  gen: ReturnType<typeof dataGen>,
  pokemon: PokemonSnapshot | null | undefined,
  entry?: OpponentIntelEntry | undefined
) {
  if (!pokemon) return [];
  if (pokemon.terastallized && pokemon.teraType) {
    return [pokemon.teraType];
  }
  if (Array.isArray(pokemon.types) && pokemon.types.length > 0) {
    return pokemon.types;
  }
  const species = lookupSpecies(gen, pokemon.species ?? pokemon.displayName ?? entry?.species);
  return species?.types ?? [];
}

function moveTargetsSpecificFoe(move: ReturnType<typeof lookupMove>) {
  const target = String(move?.target ?? "");
  return !["self", "allySide", "allyTeam", "foeSide", "all", "allAdjacent", "scripted", "adjacentAlly", "allyAlly"].includes(target);
}

function turnsStartedSinceActiveEntered(snapshot: BattleSnapshot, pokemon: PokemonSnapshot | null | undefined) {
  const actorNames = uniqueStrings([pokemon?.displayName, pokemon?.species]);
  if (actorNames.length === 0) return null;
  let lastEntryIndex = -1;
  for (let index = snapshot.recentLog.length - 1; index >= 0; index -= 1) {
    const line = String(snapshot.recentLog[index] ?? "");
    if (!line.endsWith("entered the field.")) continue;
    const actor = line.replace(/ entered the field\.$/, "").trim();
    if (actorNames.some((name) => normalizeName(name) === normalizeName(actor))) {
      lastEntryIndex = index;
      break;
    }
  }
  if (lastEntryIndex < 0) return null;
  return snapshot.recentLog.slice(lastEntryIndex + 1).filter((line) => /^Turn \d+ started\./.test(String(line ?? ""))).length;
}

function moveCurrentlyUsable(snapshot: BattleSnapshot, pokemon: PokemonSnapshot | null | undefined, moveName: string | null | undefined) {
  const moveId = normalizeName(moveName);
  if (!["firstimpression", "fakeout"].includes(moveId)) return true;
  const turnsSinceEntry = turnsStartedSinceActiveEntered(snapshot, pokemon);
  if (turnsSinceEntry === null) return true;
  return turnsSinceEntry <= 1;
}

function hazardLayerCount(conditions: string[], name: string) {
  return conditions.filter((value) => normalizeName(value) === normalizeName(name)).length;
}

function posteriorConsensusValue(
  entry: OpponentIntelEntry | undefined,
  field: "item" | "ability" | "teraType"
) {
  const posterior = entry?.posterior;
  if (!posterior || (posterior.confidenceTier !== "usable" && posterior.confidenceTier !== "strong")) return null;
  const top = posterior.topHypotheses.slice(0, 3).map((hypothesis) => hypothesis[field]).filter(Boolean);
  if (top.length === 0) return null;
  return top.every((value) => normalizeName(value) === normalizeName(top[0])) ? top[0] ?? null : null;
}

function stronglyInferredField(
  pokemon: PokemonSnapshot,
  entry: OpponentIntelEntry | undefined,
  field: "item" | "ability"
) {
  const direct = pokemon[field] ?? (field === "item" ? entry?.revealedItem : entry?.revealedAbility);
  if (direct) return direct;
  const posterior = posteriorConsensusValue(entry, field === "item" ? "item" : "ability");
  if (posterior) return posterior;
  const likelyEntries = field === "item" ? entry?.likelyItems : entry?.likelyAbilities;
  const top = likelyEntries?.[0];
  if (!top) return null;
  if (top.confidenceTier === "strong" || top.share >= 0.65) return top.name;
  return null;
}

function groundedForSpikes(snapshot: BattleSnapshot, pokemon: PokemonSnapshot, entry: OpponentIntelEntry | undefined) {
  if (snapshot.field.pseudoWeather.some((value) => /gravity/i.test(String(value ?? "")))) {
    return true;
  }
  const gen = dataGen(snapshot.format);
  const types = currentBattleTypes(gen, pokemon, entry);
  if (types.includes("Flying")) return false;
  const item = stronglyInferredField(pokemon, entry, "item");
  if (normalizeName(item) === "airballoon") return false;
  const ability = stronglyInferredField(pokemon, entry, "ability");
  if (normalizeName(ability) === "levitate") return false;
  return true;
}

function estimateSwitchEntryHazards(snapshot: BattleSnapshot, pokemon: PokemonSnapshot, entry: OpponentIntelEntry | undefined) {
  const item = stronglyInferredField(pokemon, entry, "item");
  if (normalizeName(item) === "heavydutyboots") {
    return { damagePercent: 0, stickyWeb: false };
  }

  const conditions = snapshot.field.opponentSideConditions ?? [];
  const gen = dataGen(snapshot.format);
  const types = currentBattleTypes(gen, pokemon, entry);
  let damagePercent = 0;

  if (hazardLayerCount(conditions, "Stealth Rock") > 0 && types.length > 0) {
    const rockEffectiveness = gen.types.totalEffectiveness("Rock" as any, types as any);
    damagePercent += 12.5 * Number(rockEffectiveness);
  }

  const spikesLayers = hazardLayerCount(conditions, "Spikes");
  if (spikesLayers > 0 && groundedForSpikes(snapshot, pokemon, entry)) {
    damagePercent += spikesLayers >= 3 ? 25 : spikesLayers === 2 ? 16.7 : 12.5;
  }

  const stickyWeb = hazardLayerCount(conditions, "Sticky Web") > 0 && groundedForSpikes(snapshot, pokemon, entry);
  return {
    damagePercent: Number(damagePercent.toFixed(1)),
    stickyWeb
  };
}

function summarizeBestDamage(previews: DamagePreview[] | null | undefined) {
  const entries = Array.isArray(previews) ? previews : [];
  let best: { entry: DamagePreview; band: DamageAssumptionBand | null } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const band = likelyBand(entry.bands);
    const score = bandCoverageScore(band) * 100 + bandAveragePercent(band) * 2 + bandMaxPercent(band);
    if (score > bestScore) {
      bestScore = score;
      best = { entry, band };
    }
  }

  return best;
}

function statusThreatPreviewForMove(threats: ThreatPreview[], moveName: string) {
  const moveId = normalizeName(moveName);
  return threats.find((entry) => normalizeName(entry.moveName) === moveId) ?? null;
}

function isHighConfidenceHiddenMove(activeOpponentEntry: OpponentIntelEntry | undefined, moveName: string) {
  const likely = activeOpponentEntry?.likelyMoves.find((entry) => normalizeName(entry.name) === normalizeName(moveName));
  if (!likely) return false;
  return likely.confidenceTier === "strong" || likely.confidenceTier === "usable" || likely.share >= 0.45;
}

function createSwitchSnapshot(snapshot: BattleSnapshot, switchTarget: PokemonSnapshot): BattleSnapshot {
  const targetIdent = switchTarget.ident;
  const nextTeam = snapshot.opponentSide.team.map((pokemon) => ({
    ...pokemon,
    active: pokemon.ident === targetIdent
  }));
  const nextActive = { ...switchTarget, active: true };
  return {
    ...snapshot,
    opponentSide: {
      ...snapshot.opponentSide,
      active: nextActive,
      team: nextTeam
    }
  };
}

function buildSwitchTargetPreview(
  snapshot: BattleSnapshot,
  pokemon: PokemonSnapshot,
  entry: OpponentIntelEntry | undefined,
  source: "revealed_switch" | "previewed_switch"
): SwitchTargetPreview {
  const simulated = createSwitchSnapshot(snapshot, pokemon);
  const damagePreview = buildDamagePreview(simulated, {
    likelyDefenderItems: entry?.likelyItems.map((value) => value.name) ?? [],
    likelyDefenderAbilities: entry?.likelyAbilities.map((value) => value.name) ?? [],
    defenderPosterior: entry?.posterior
  });
  const hazardInfo = estimateSwitchEntryHazards(snapshot, pokemon, entry);
  return {
    pokemon,
    entry,
    damagePreview,
    hazardDamagePercent: hazardInfo.damagePercent,
    stickyWeb: hazardInfo.stickyWeb,
    source
  };
}

function buildSwitchCandidates(params: {
  snapshot: BattleSnapshot;
  activeOpponent: PokemonSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  allOpponentEntries: OpponentIntelEntry[];
}): SwitchTargetPreview[] {
  const activeKey = normalizeName(params.activeOpponent.ident ?? params.activeOpponent.species ?? params.activeOpponent.displayName);
  return params.snapshot.opponentSide.team
    .filter((pokemon) => !pokemon.fainted && !pokemon.active)
    .filter((pokemon) => Boolean(pokemon.species ?? pokemon.displayName))
    .filter((pokemon) => normalizeName(pokemon.ident ?? pokemon.species ?? pokemon.displayName) !== activeKey)
    .map((pokemon) => {
      const entry = params.allOpponentEntries.find((candidate) => normalizeName(candidate.species) === normalizeName(pokemon.species ?? pokemon.displayName));
      return buildSwitchTargetPreview(
        params.snapshot,
        pokemon,
        entry,
        pokemon.revealed ? "revealed_switch" : "previewed_switch"
      );
    })
    .slice(0, 5);
}

function pushUnique(list: string[], value: string | null | undefined) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function buildAttackCandidates(params: {
  snapshot: BattleSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  opponentThreatPreview: ThreatPreview[];
  playerPressure: { entry: DamagePreview; band: DamageAssumptionBand | null } | null;
  switchTargets: SwitchTargetPreview[];
}): OpponentActionCandidate[] {
  const candidates: OpponentActionCandidate[] = [];
  const gen = dataGen(params.snapshot.format);
  const relation = opponentMoveOrderRelation(params.snapshot, params.opponentThreatPreview[0]?.currentTarget?.relation ?? "unknown");
  const bestKnownAttack = params.opponentThreatPreview
    .filter((entry) => entry.moveSource === "known")
    .map((entry) => ({ entry, band: likelyBand(entry.currentTarget.bands) }))
    .sort((a, b) => (bandCoverageScore(b.band) * 100 + bandAveragePercent(b.band)) - (bandCoverageScore(a.band) * 100 + bandAveragePercent(a.band)))[0] ?? null;
  const safeSwitchExists = params.switchTargets.some((target) => {
    const bestIntoSwitch = summarizeBestDamage(target.damagePreview);
    const band = bestIntoSwitch?.band;
    return !band || (bandCoverageScore(band) === 0 && bandMaxPercent(band) <= 40 && target.hazardDamagePercent <= 16.7);
  });
  const hazardsPunishMostSwitches = params.switchTargets.length > 0 && params.switchTargets.every((target) => target.hazardDamagePercent >= 12.5);
  const opponentReserveCount = livingReserveCount(params.snapshot.opponentSide.team);
  const playerReserveCount = livingReserveCount(params.snapshot.yourSide.team);

  for (const threat of params.opponentThreatPreview) {
    if (!moveCurrentlyUsable(params.snapshot, params.snapshot.opponentSide.active, threat.moveName)) {
      continue;
    }
    const band = likelyBand(threat.currentTarget.bands);
    if (!isDamagingBand(band)) continue;

    const hiddenMove = threat.moveSource === "likely";
    const hiddenConfidence = hiddenMove ? isHighConfidenceHiddenMove(params.activeOpponentEntry, threat.moveName) : true;
    const bestKnownBand = bestKnownAttack?.band ?? null;
    const hiddenClearlyBetter = hiddenMove && (
      bandCoverageScore(band) > bandCoverageScore(bestKnownBand)
      || bandAveragePercent(band) >= bandAveragePercent(bestKnownBand) + 18
    );
    if (hiddenMove && !hiddenConfidence && !hiddenClearlyBetter) {
      continue;
    }

    const reasons: string[] = [];
    const riskFlags: string[] = [];
    let score = 12;
    const moveData = lookupMove(gen, threat.moveName);
    const pivotMove = Boolean(moveData?.selfSwitch) || ["uturn", "voltswitch", "flipturn"].includes(normalizeName(threat.moveName));
    const avgPercent = bandAveragePercent(band);
    const coverageScore = bandCoverageScore(band);
    score += avgPercent * 0.55;
    score += coverageScore === 2 ? 28 : coverageScore === 1 ? 14 : 0;
    score += attackOrderBonus(relation);
    score += hiddenMove ? (hiddenConfidence ? 4 : -6) : 8;

    if (relation === "faster" && coverageScore === 2) {
      pushUnique(reasons, "faster and can KO");
    } else if (relation === "faster" && coverageScore === 1) {
      pushUnique(reasons, "faster and has a KO roll");
    } else if (avgPercent >= 60) {
      pushUnique(reasons, hiddenMove ? "likely coverage move available" : "best known damage line");
    }

    if (hiddenMove) {
      pushUnique(reasons, "likely coverage move available");
      pushUnique(riskFlags, "depends on hidden-move inference");
    }

    if (pivotMove && safeSwitchExists) {
      score += 10;
      pushUnique(reasons, "pivot keeps initiative");
      if (earlyTurn(params.snapshot)) {
        score += 6;
        pushUnique(reasons, "early-game pivot keeps momentum flexible");
      }
    }

    if (params.playerPressure?.band && relation !== "faster") {
      if (params.playerPressure.band.coverage === "covers_current_hp") {
        score -= safeSwitchExists ? 24 : 10;
        pushUnique(riskFlags, "staying risks losing the current mon");
      } else if (params.playerPressure.band.coverage === "can_cover_current_hp") {
        score -= safeSwitchExists ? 14 : 6;
        pushUnique(riskFlags, "player has a live KO roll if they attack");
      }
    }

    if (hazardsPunishMostSwitches) {
      score += 8;
      pushUnique(reasons, "hazards punish switch");
    }

    if (earlyTurn(params.snapshot) && coverageScore === 0 && !pivotMove) {
      score -= 4;
    }

    if (lateTurn(params.snapshot)) {
      score += 4;
      pushUnique(reasons, "later turn favors immediate damage");
      if (opponentReserveCount <= 1) {
        score += 6;
        pushUnique(reasons, "few reserves left makes immediate trades stronger");
      }
      if (veryLateTurn(params.snapshot) && coverageScore >= 1) {
        score += 4;
      }
    }

    if (playerReserveCount <= 1 && coverageScore >= 1) {
      score += 4;
      pushUnique(reasons, "player has fewer pivots left to absorb damage");
    }

    if (relation === "overlap") {
      pushUnique(riskFlags, "speed still overlaps");
    }
    if (relation === "unknown") {
      pushUnique(riskFlags, "move order is still unclear");
    }

    if (!hiddenMove && bestKnownAttack && normalizeName(bestKnownAttack.entry.moveName) === normalizeName(threat.moveName)) {
      pushUnique(reasons, "best known damage line");
    }

    candidates.push({
      type: hiddenMove ? "likely_hidden_move" : "known_move",
      actionClass: "stay_attack",
      label: threat.moveName,
      moveName: threat.moveName,
      source: hiddenMove ? "likely" : "known",
      score: clampScore(score),
      reasons: uniqueStrings(reasons),
      riskFlags: uniqueStrings(riskFlags)
    });
  }

  return candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function buildSwitchActionCandidates(params: {
  snapshot: BattleSnapshot;
  activeOpponent: PokemonSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  switchTargets: SwitchTargetPreview[];
  playerPressure: { entry: DamagePreview; band: DamageAssumptionBand | null } | null;
}): OpponentActionCandidate[] {
  const candidates: OpponentActionCandidate[] = [];
  const opponentReserveCount = livingReserveCount(params.snapshot.opponentSide.team);
  if (opponentReserveCount <= 0) return candidates;
  const yourOrderRelation = relationAfterTrickRoomFromYourPerspective(
    params.snapshot,
    params.activeOpponentEntry?.activeSpeedRelation ?? "unknown"
  );
  const playerMovesFirst = yourOrderRelation === "faster";
  const playerCoverage = params.playerPressure?.band?.coverage ?? "unknown";
  const currentUnderImmediateThreat = playerMovesFirst && (playerCoverage === "covers_current_hp" || playerCoverage === "can_cover_current_hp");
  const regeneratorLikely = normalizeName(params.activeOpponent.ability ?? params.activeOpponentEntry?.revealedAbility ?? params.activeOpponentEntry?.likelyAbilities[0]?.name) === "regenerator";

  for (const target of params.switchTargets) {
    const bestIntoSwitch = summarizeBestDamage(target.damagePreview);
    const band = bestIntoSwitch?.band ?? null;
    const reasons: string[] = [];
    const riskFlags: string[] = [];
    let score = 8;

    if (currentUnderImmediateThreat) {
      score += playerCoverage === "covers_current_hp" ? 36 : 24;
      pushUnique(reasons, "slower and threatened by KO");
    } else if (bandAveragePercent(params.playerPressure?.band) >= 60) {
      score += 12;
      pushUnique(reasons, "current position is under heavy damage pressure");
    }

    if (regeneratorLikely && Number(params.activeOpponent.hpPercent ?? 100) < 90) {
      score += 8;
      pushUnique(reasons, "Regenerator rewards pivoting");
    }

    if (Number(params.activeOpponent.hpPercent ?? 100) <= 35 && opponentReserveCount > 0) {
      score += 6;
      pushUnique(reasons, "low HP makes preservation attractive");
    }

    if (lateTurn(params.snapshot) && Number(params.activeOpponent.hpPercent ?? 100) <= 70) {
      score += 5;
      pushUnique(reasons, "later turn makes preservation more valuable");
    }

    if (!band) {
      score += 12;
    } else if (isImmuneOrBlockedBand(band)) {
      score += 28;
      pushUnique(reasons, "obvious immunity or hard stop on board");
    } else if (band.coverage === "misses_current_hp" && bandMaxPercent(band) <= 35) {
      score += 24;
      pushUnique(reasons, "switch target absorbs your best attacks");
    } else if (band.coverage === "misses_current_hp" && bandMaxPercent(band) <= 50) {
      score += 12;
      pushUnique(reasons, target.source === "previewed_switch" ? "known reserve looks safer than staying" : "revealed pivot is safer than staying");
    } else if (band.coverage === "can_cover_current_hp") {
      score -= 12;
      pushUnique(riskFlags, target.source === "previewed_switch" ? "best known reserve can still take a heavy hit" : "best revealed switch can still take a heavy hit");
    } else if (band.coverage === "covers_current_hp") {
      score -= 24;
      pushUnique(riskFlags, target.source === "previewed_switch" ? "best known reserve can still be punished hard" : "best revealed switch can still be punished hard");
    }

    if (target.hazardDamagePercent >= 25) {
      score -= 24;
      pushUnique(riskFlags, "entry hazards punish this switch heavily");
    } else if (target.hazardDamagePercent >= 12.5) {
      score -= 12;
      pushUnique(riskFlags, "entry hazards tax this switch");
    }
    if (target.hazardDamagePercent > 0 && target.hazardDamagePercent < 12.5) {
      pushUnique(riskFlags, "light hazard chip still matters on entry");
    }
    if (target.stickyWeb) {
      score -= 4;
      pushUnique(riskFlags, "Sticky Web cuts Speed on entry");
    }

    if (opponentReserveCount <= 1 && !currentUnderImmediateThreat) {
      score -= 8;
      pushUnique(riskFlags, "few reserves left makes switching less attractive now");
    }

    if (lateTurn(params.snapshot) && target.hazardDamagePercent > 0) {
      score -= 4;
    }

    candidates.push({
      type: "likely_switch",
      actionClass: "switch",
      label: `Switch to ${target.pokemon.species ?? target.pokemon.displayName ?? "reserve"}`,
      switchTargetSpecies: target.pokemon.species ?? target.pokemon.displayName ?? "reserve",
      source: target.source,
      score: clampScore(score),
      reasons: uniqueStrings(reasons),
      riskFlags: uniqueStrings(riskFlags)
    });
  }

  return candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function buildStatusCandidates(params: {
  snapshot: BattleSnapshot;
  activeOpponent: PokemonSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  opponentThreatPreview: ThreatPreview[];
  playerPressure: { entry: DamagePreview; band: DamageAssumptionBand | null } | null;
  bestAttackScore: number;
}): OpponentActionCandidate[] {
  const gen = dataGen(params.snapshot.format);
  const opponentReserveCount = livingReserveCount(params.snapshot.opponentSide.team);
  const playerReserveCount = livingReserveCount(params.snapshot.yourSide.team);
  const movePool = [
    ...params.activeOpponent.knownMoves.map((name) => ({ name, source: "known" as const })),
    ...(params.activeOpponentEntry?.likelyMoves ?? [])
      .filter((entry) => !params.activeOpponent.knownMoves.some((moveName) => normalizeName(moveName) === normalizeName(entry.name)))
      .filter((entry) => entry.confidenceTier === "usable" || entry.confidenceTier === "strong" || entry.share >= 0.45)
      .slice(0, 3)
      .map((entry) => ({ name: entry.name, source: "likely" as const }))
  ];

  const uniqueMoves = new Map<string, { name: string; source: "known" | "likely" }>();
  for (const move of movePool) {
    const moveId = normalizeName(move.name);
    if (!moveId || uniqueMoves.has(moveId)) continue;
    uniqueMoves.set(moveId, move);
  }

  const playerBand = params.playerPressure?.band ?? null;
  const safeBoard = !playerBand || (playerBand.coverage === "misses_current_hp" && bandMaxPercent(playerBand) <= 35);
  const candidates: OpponentActionCandidate[] = [];

  for (const move of uniqueMoves.values()) {
    if (!moveCurrentlyUsable(params.snapshot, params.activeOpponent, move.name)) continue;
    const moveData = lookupMove(gen, move.name);
    if (!moveData || moveData.category !== "Status") continue;

    const reasons: string[] = [];
    const riskFlags: string[] = [];
    let score = 14;
    const matchingThreat = statusThreatPreviewForMove(params.opponentThreatPreview, move.name);
    const currentBand = likelyBand(matchingThreat?.currentTarget?.bands);
    const liveSwitchStatusCount = (matchingThreat?.switchTargets ?? [])
      .map((target) => likelyBand(target.bands))
      .filter((band) => band?.outcome === "status")
      .length;
    const sideCondition = normalizeName(String(moveData.sideCondition ?? ""));
    const hasBoosts = Boolean(moveData.boosts) || Boolean(moveData.self?.boosts);
    const selfTargeting = String(moveData.target ?? "") === "self";
    const recoveryMove = Boolean(moveData.heal) || /recover|roost|slackoff|softboiled|moonlight|morningsun|wish/i.test(moveData.name);
    const targetedStatus = moveTargetsSpecificFoe(moveData) && (Boolean(moveData.status) || Boolean(moveData.volatileStatus));
    const hazardMove = ["stealthrock", "spikes", "toxicspikes", "stickyweb"].includes(sideCondition);
    const lowHp = Number(params.activeOpponent.hpPercent ?? 100) <= 60;

    if (safeBoard) {
      score += 20;
      pushUnique(reasons, "safe enough board for setup/status");
    } else if (playerBand?.coverage === "covers_current_hp") {
      score -= 30;
      pushUnique(riskFlags, "can be punished immediately if the player attacks");
    } else if (playerBand?.coverage === "can_cover_current_hp") {
      score -= 16;
      pushUnique(riskFlags, "player still has a strong punish line");
    }

    if (hasBoosts || selfTargeting) {
      score += 10;
      pushUnique(reasons, "setup line is available");
    }

    if (earlyTurn(params.snapshot) && (hazardMove || hasBoosts || selfTargeting)) {
      score += 8;
      pushUnique(reasons, "early turn still rewards setup");
      if (hazardMove && playerReserveCount >= 2) {
        score += 6;
        pushUnique(reasons, "player still has multiple reserves to pressure with hazards");
      }
    }

    if (recoveryMove) {
      if (lowHp) {
        score += 14;
        pushUnique(reasons, "recovery line is live");
      } else {
        score -= 5;
      }
    }

    if (hazardMove) {
      const yourConditions = params.snapshot.field.yourSideConditions.map((value) => normalizeName(value));
      if (!yourConditions.includes(sideCondition)) {
        score += 8;
        pushUnique(reasons, "hazard line is still available");
        if (playerReserveCount <= 1) {
          score -= 8;
          pushUnique(riskFlags, "fewer player reserves lowers the payoff of new hazards");
        }
      } else {
        score -= 5;
      }
    }

    if (lateTurn(params.snapshot) && (hazardMove || hasBoosts || selfTargeting) && !recoveryMove) {
      score -= 10;
      pushUnique(riskFlags, "late turn makes slower setup lines less attractive");
      if (opponentReserveCount <= 1) {
        score -= 6;
      }
    }

    if (lateTurn(params.snapshot) && recoveryMove && lowHp) {
      score += 4;
      pushUnique(reasons, "late turn recovery can preserve a win path");
    }

    if (targetedStatus) {
      if (currentBand?.outcome === "status") {
        score += 8;
        pushUnique(reasons, "status line is live into your active");
      } else if (currentBand?.outcome === "immune" || currentBand?.outcome === "blocked") {
        score -= 26;
        pushUnique(riskFlags, "your active can ignore or block this status");
        if (liveSwitchStatusCount > 0 && playerReserveCount > 0) {
          score += liveSwitchStatusCount >= 2 ? 8 : 5;
          pushUnique(reasons, "status mainly punishes a switch, not the current target");
        }
      }
    }

    if (move.source === "likely") {
      score += 2;
      pushUnique(riskFlags, "depends on hidden-move inference");
    } else {
      score += 6;
    }

    if (params.bestAttackScore >= score + 16) {
      score -= 8;
    }

    candidates.push({
      type: move.source === "known" ? "known_status_or_setup" : "likely_status_or_setup",
      actionClass: "status_or_setup",
      label: move.name,
      moveName: move.name,
      source: move.source,
      score: clampScore(score),
      reasons: uniqueStrings(reasons),
      riskFlags: uniqueStrings(riskFlags)
    });
  }

  return candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function confidenceTier(params: {
  topClassScore: number;
  runnerUpScore: number;
  topAction: OpponentActionCandidate | undefined;
}) {
  const gap = params.topClassScore - params.runnerUpScore;
  if (!params.topAction || params.topClassScore < 24) return "low" as const;
  if (params.topClassScore >= 62 && gap >= 18 && params.topAction.riskFlags.length <= 1) return "high" as const;
  if (params.topClassScore >= 38 && gap >= 8) return "medium" as const;
  return "low" as const;
}

export function buildOpponentActionPrediction(params: {
  snapshot: BattleSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  allOpponentEntries?: OpponentIntelEntry[] | undefined;
  playerDamagePreview?: DamagePreview[] | undefined;
  opponentThreatPreview?: ThreatPreview[] | undefined;
}): OpponentActionPrediction | undefined {
  const activeOpponent = params.snapshot.opponentSide.active;
  const playerDamagePreview = Array.isArray(params.playerDamagePreview) ? params.playerDamagePreview : [];
  const opponentThreatPreview = Array.isArray(params.opponentThreatPreview) ? params.opponentThreatPreview : [];
  if (!activeOpponent || (playerDamagePreview.length === 0 && opponentThreatPreview.length === 0)) {
    return undefined;
  }

  const playerPressure = summarizeBestDamage(playerDamagePreview);
  const switchTargets = buildSwitchCandidates({
    snapshot: params.snapshot,
    activeOpponent,
    activeOpponentEntry: params.activeOpponentEntry,
    allOpponentEntries: params.allOpponentEntries ?? []
  });
  const attackCandidates = buildAttackCandidates({
    snapshot: params.snapshot,
    activeOpponentEntry: params.activeOpponentEntry,
    opponentThreatPreview,
    playerPressure,
    switchTargets
  });
  const switchCandidates = buildSwitchActionCandidates({
    snapshot: params.snapshot,
    activeOpponent,
    activeOpponentEntry: params.activeOpponentEntry,
    switchTargets,
    playerPressure
  });
  const statusCandidates = buildStatusCandidates({
    snapshot: params.snapshot,
    activeOpponent,
    activeOpponentEntry: params.activeOpponentEntry,
    opponentThreatPreview,
    playerPressure,
    bestAttackScore: attackCandidates[0]?.score ?? 0
  });

  const classScores = {
    stayAttack: clampScore(attackCandidates[0]?.score ?? 0),
    switchOut: clampScore(switchCandidates[0]?.score ?? 0),
    statusOrSetup: clampScore(statusCandidates[0]?.score ?? 0)
  };

  const classRanking = [
    { key: "stay_attack" as const, score: classScores.stayAttack },
    { key: "switch" as const, score: classScores.switchOut },
    { key: "status_or_setup" as const, score: classScores.statusOrSetup }
  ].sort((a, b) => b.score - a.score);

  const topClassEntry = classRanking[0];
  const topClass = topClassEntry && topClassEntry.score >= 18 ? topClassEntry.key : "unknown";
  const allCandidates = [...attackCandidates, ...switchCandidates, ...statusCandidates]
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 4);

  const reasons = uniqueStrings([
    ...(allCandidates[0]?.reasons ?? []),
    ...(topClass === "switch" && playerPressure?.band?.coverage === "covers_current_hp" ? ["slower and threatened by KO"] : []),
    ...(topClass === "stay_attack" && attackCandidates[0]?.reasons.includes("hazards punish switch") ? ["hazards punish switch"] : []),
    ...(topClass === "status_or_setup" && statusCandidates[0]?.reasons.includes("safe enough board for setup/status") ? ["safe enough board for setup/status"] : [])
  ]).slice(0, 4);

  const riskFlags = uniqueStrings([
    ...(allCandidates[0]?.riskFlags ?? []),
    ...((params.activeOpponentEntry?.likelyTeraTypes?.length ?? 0) > 0 && !activeOpponent.terastallized ? ["unspent Tera can still change this line"] : []),
    ...(switchTargets.length === 0 && params.snapshot.opponentSide.team.some((pokemon) => !pokemon.fainted && !pokemon.active)
      ? ["no safe known reserve switch target is available in the current snapshot"]
      : [])
  ]).slice(0, 4);

  const confidence = confidenceTier({
    topClassScore: classRanking[0]?.score ?? 0,
    runnerUpScore: classRanking[1]?.score ?? 0,
    topAction: allCandidates[0]
  });

  return {
    topActionClass: topClass,
    confidenceTier: confidence,
    topActions: allCandidates,
    reasons,
    riskFlags,
    classScores
  };
}
