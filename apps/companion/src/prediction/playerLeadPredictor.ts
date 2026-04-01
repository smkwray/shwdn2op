import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import type {
  BattleSnapshot,
  OpponentIntelEntry,
  OpponentLeadPrediction,
  PlayerLeadCandidate,
  PlayerLeadRecommendation,
  PokemonSnapshot
} from "../types.js";

const gens = new Generations(Dex as any);

const HAZARD_MOVES = new Set(["stealthrock", "spikes", "toxicspikes", "stickyweb"]);
const PIVOT_MOVES = new Set(["uturn", "voltswitch", "flipturn", "partingshot", "chillyreception", "batonpass"]);
const ANTI_LEAD_MOVES = new Set(["fakeout", "firstimpression", "taunt", "spore", "nuzzle"]);
const TEMPO_MOVES = new Set(["encore", "thunderwave", "willowisp", "toxic", "rapidspin"]);

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

function currentBattleTypes(pokemon: PokemonSnapshot, dexTypes: string[] | undefined) {
  if (pokemon.terastallized && pokemon.teraType) {
    return [pokemon.teraType];
  }
  if (Array.isArray(pokemon.types) && pokemon.types.length > 0) {
    return pokemon.types;
  }
  return dexTypes ?? [];
}

function typeMultiplier(
  gen: ReturnType<typeof dataGen>,
  attackingType: string,
  defendingTypes: string[]
) {
  if (!defendingTypes.length) return null;
  return gen.types.totalEffectiveness(attackingType as any, defendingTypes as any);
}

function movePool(entry: OpponentIntelEntry | undefined, pokemon: PokemonSnapshot) {
  const known = pokemon.knownMoves.map((name) => ({ name, source: "known" as const }));
  const likely = (entry?.likelyMoves ?? [])
    .filter((move) => !pokemon.knownMoves.some((knownMove) => normalizeName(knownMove) === normalizeName(move.name)))
    .filter((move) => move.confidenceTier === "strong" || move.confidenceTier === "usable" || move.share >= 0.35)
    .slice(0, 4)
    .map((move) => ({ name: move.name, source: "likely" as const }));
  const result = new Map<string, { name: string; source: "known" | "likely" }>();
  for (const move of [...known, ...likely]) {
    const moveId = normalizeName(move.name);
    if (!moveId || result.has(moveId)) continue;
    result.set(moveId, move);
  }
  return [...result.values()];
}

function weightedOpponentLeads(
  snapshot: BattleSnapshot,
  opponentLeadPrediction: OpponentLeadPrediction | undefined
) {
  const previewCandidates = snapshot.opponentSide.team.filter((pokemon) => !pokemon.fainted && pokemon.revealed);
  if (previewCandidates.length === 0) return [];
  const predictedCandidates = (opponentLeadPrediction?.topCandidates ?? [])
    .map((candidate) => previewCandidates.find((entry) => normalizeName(entry.species ?? entry.displayName) === normalizeName(candidate.species)) ?? null)
    .filter((candidate): candidate is PokemonSnapshot => Boolean(candidate))
    .map((candidate, index, list) => ({
      pokemon: candidate,
      rawScore: Math.max(1, list.length - index)
    }));
  const rankedKeys = new Set(predictedCandidates.map((candidate) => normalizeName(candidate.pokemon.species ?? candidate.pokemon.displayName)));
  const residualWeight = opponentLeadPrediction?.confidenceTier === "high"
    ? 1
    : opponentLeadPrediction?.confidenceTier === "medium"
      ? 2
      : 3;
  const omittedCandidates = previewCandidates
    .filter((pokemon) => !rankedKeys.has(normalizeName(pokemon.species ?? pokemon.displayName)))
    .map((pokemon) => ({ pokemon, rawScore: residualWeight }));
  const weighted = predictedCandidates.length > 0
    ? [...predictedCandidates, ...omittedCandidates]
    : previewCandidates.map((pokemon) => ({ pokemon, rawScore: 1 }));
  const total = weighted.reduce((sum, candidate) => sum + candidate.rawScore, 0) || 1;
  return weighted.map((candidate) => ({
    pokemon: candidate.pokemon,
    weight: candidate.rawScore / total
  }));
}

function capConfidenceByOpponentRead(
  confidence: "low" | "medium" | "high",
  opponentConfidence: "low" | "medium" | "high" | undefined
) {
  if (opponentConfidence === "low") return "low" as const;
  if (opponentConfidence === "medium" && confidence === "high") return "medium" as const;
  return confidence;
}

function bestDamageSignal(
  gen: ReturnType<typeof dataGen>,
  attacker: PokemonSnapshot,
  defender: PokemonSnapshot,
  attackerEntry?: OpponentIntelEntry | undefined
) {
  const attackerSpecies = lookupSpecies(gen, attacker.species ?? attacker.displayName);
  const defenderSpecies = lookupSpecies(gen, defender.species ?? defender.displayName);
  const attackerTypes = currentBattleTypes(attacker, attackerSpecies?.types as string[] | undefined);
  const defenderTypes = currentBattleTypes(defender, defenderSpecies?.types as string[] | undefined);
  const pool = movePool(attackerEntry, attacker);
  let best:
    | {
        score: number;
        moveName: string;
        multiplier: number | null;
        isStab: boolean;
        priority: number;
      }
    | undefined;

  for (const moveRef of pool) {
    const move = lookupMove(gen, moveRef.name);
    if (!move || move.category === "Status" || !Number.isFinite(move.basePower) || move.basePower <= 0) continue;
    const multiplier = typeMultiplier(gen, move.type, defenderTypes);
    const stab = attackerTypes.some((type) => normalizeName(type) === normalizeName(move.type));
    const priority = Number(move.priority ?? 0);
    const score = move.basePower * (multiplier ?? 1) * (stab ? 1.2 : 1) + priority * 18;
    if (!best || score > best.score) {
      best = { score, moveName: move.name, multiplier, isStab: stab, priority };
    }
  }

  return best;
}

function matchupScore(params: {
  gen: ReturnType<typeof dataGen>;
  yourLead: PokemonSnapshot;
  opponentLead: PokemonSnapshot;
  opponentEntry?: OpponentIntelEntry | undefined;
}) {
  const offensive = bestDamageSignal(params.gen, params.yourLead, params.opponentLead);
  const defensive = bestDamageSignal(params.gen, params.opponentLead, params.yourLead, params.opponentEntry);
  const yourSpecies = lookupSpecies(params.gen, params.yourLead.species ?? params.yourLead.displayName);
  const opponentSpecies = lookupSpecies(params.gen, params.opponentLead.species ?? params.opponentLead.displayName);
  const yourSpeed = Number(params.yourLead.stats?.spe ?? yourSpecies?.baseStats?.spe ?? 0);
  const opponentSpeed = Number(params.opponentLead.stats?.spe ?? opponentSpecies?.baseStats?.spe ?? 0);

  let score = 0;
  const reasons: string[] = [];
  const riskFlags: string[] = [];

  if (offensive) {
    score += offensive.score / 22;
    if ((offensive.multiplier ?? 1) >= 2) {
      reasons.push(`pressures likely ${params.opponentLead.species ?? params.opponentLead.displayName ?? "lead"} with ${offensive.moveName}`);
    } else if ((offensive.multiplier ?? 1) === 0) {
      riskFlags.push(`${offensive.moveName} is blanked by ${params.opponentLead.species ?? params.opponentLead.displayName ?? "that lead"} typing`);
      score -= 8;
    }
  } else {
    riskFlags.push(`limited direct pressure into ${params.opponentLead.species ?? params.opponentLead.displayName ?? "common leads"}`);
    score -= 3;
  }

  if (defensive) {
    score -= defensive.score / 28;
    if ((defensive.multiplier ?? 1) >= 2) {
      riskFlags.push(`likely ${params.opponentLead.species ?? params.opponentLead.displayName ?? "lead"} pressures back with ${defensive.moveName}`);
    } else if ((defensive.multiplier ?? 1) <= 0.5) {
      reasons.push(`absorbs likely ${params.opponentLead.species ?? params.opponentLead.displayName ?? "lead"} pressure well`);
    }
  }

  if (yourSpeed >= opponentSpeed + 12) {
    score += 5;
    reasons.push(`outspeeds likely ${params.opponentLead.species ?? params.opponentLead.displayName ?? "lead"} on shown stats`);
  } else if (opponentSpeed >= yourSpeed + 12) {
    score -= 4;
    riskFlags.push(`slower than likely ${params.opponentLead.species ?? params.opponentLead.displayName ?? "lead"}`);
  }

  return { score, reasons, riskFlags };
}

export function buildPlayerLeadRecommendation(params: {
  snapshot: BattleSnapshot;
  allOpponentEntries?: OpponentIntelEntry[] | undefined;
  opponentLeadPrediction?: OpponentLeadPrediction | undefined;
}): PlayerLeadRecommendation | undefined {
  if (params.snapshot.phase !== "preview" || params.snapshot.yourSide.active) return undefined;
  const candidates = params.snapshot.yourSide.team.filter((pokemon) => !pokemon.fainted && (pokemon.revealed || params.snapshot.phase === "preview"));
  if (candidates.length === 0) return undefined;

  const gen = dataGen(params.snapshot.format);
  const weightedOpponents = weightedOpponentLeads(params.snapshot, params.opponentLeadPrediction);
  const scored: PlayerLeadCandidate[] = candidates.map((pokemon) => {
    const speciesName = pokemon.species ?? pokemon.displayName ?? "Unknown";
    const species = lookupSpecies(gen, speciesName);
    const yourMovePool = movePool(undefined, pokemon);
    const moveNames = yourMovePool.map((move) => move.name);
    const reasons: string[] = [];
    const riskFlags: string[] = [];
    let score = 14;

    const hazardMoves = moveNames.filter((moveName) => HAZARD_MOVES.has(normalizeName(moveName)));
    if (hazardMoves.length > 0) {
      score += 10;
      reasons.push("can set immediate hazard pressure");
    }

    const pivotMoves = moveNames.filter((moveName) => PIVOT_MOVES.has(normalizeName(moveName)));
    if (pivotMoves.length > 0) {
      score += 9;
      reasons.push("keeps opener tempo with a safe pivot");
    }

    const antiLeadMoves = moveNames.filter((moveName) => ANTI_LEAD_MOVES.has(normalizeName(moveName)));
    if (antiLeadMoves.length > 0) {
      score += 8;
      reasons.push("has anti-lead utility");
    }

    const tempoMoves = moveNames.filter((moveName) => TEMPO_MOVES.has(normalizeName(moveName)));
    if (tempoMoves.length > 0) {
      score += 4;
      reasons.push("can force early tempo with utility");
    }

    const priorityAttack = yourMovePool.some((moveRef) => {
      const move = lookupMove(gen, moveRef.name);
      return Boolean(move && move.category !== "Status" && Number(move.priority ?? 0) > 0);
    });
    if (priorityAttack) {
      score += 4;
      reasons.push("has priority to punish frail leads");
    }

    const baseSpeed = Number(pokemon.stats?.spe ?? species?.baseStats?.spe ?? 0);
    if (baseSpeed >= 120) {
      score += 8;
      reasons.push("very fast lead candidate");
    } else if (baseSpeed >= 100) {
      score += 5;
      reasons.push("fast enough to pressure common leads");
    } else if (baseSpeed <= 65 && hazardMoves.length === 0 && pivotMoves.length === 0) {
      score -= 4;
      riskFlags.push("slow opener without clear utility");
    }

    if (yourMovePool.length === 0) {
      riskFlags.push("preview move data is thin for this starter");
    }

    for (const candidate of weightedOpponents) {
      const opponentEntry = params.allOpponentEntries?.find(
        (entry) => normalizeName(entry.species) === normalizeName(candidate.pokemon.species ?? candidate.pokemon.displayName)
      );
      const matchup = matchupScore({
        gen,
        yourLead: pokemon,
        opponentLead: candidate.pokemon,
        opponentEntry
      });
      score += matchup.score * candidate.weight;
      reasons.push(...matchup.reasons);
      riskFlags.push(...matchup.riskFlags);
    }

    return {
      species: speciesName,
      score: clampScore(score),
      reasons: uniqueStrings(reasons).slice(0, 4),
      riskFlags: uniqueStrings(riskFlags).slice(0, 3)
    };
  }).sort((a, b) => b.score - a.score || a.species.localeCompare(b.species));

  const top = scored[0];
  const runnerUp = scored[1];
  const gap = (top?.score ?? 0) - (runnerUp?.score ?? 0);
  const baseConfidence = !top || top.score < 24
    ? "low"
    : top.score >= 38 && gap >= 8
      ? "high"
      : top.score >= 28 && gap >= 4
        ? "medium"
        : "low";
  const confidence = capConfidenceByOpponentRead(baseConfidence, params.opponentLeadPrediction?.confidenceTier);

  const summaryParts = [
    `${params.opponentLeadPrediction?.confidenceTier === "low" ? "Lean starter" : "Best starter"} ${top?.species ?? "unknown"}`,
    `confidence ${confidence}`
  ];
  if (top?.reasons?.[0]) {
    summaryParts.push(top.reasons[0]);
  }
  if (top?.riskFlags?.[0]) {
    summaryParts.push(`watch ${top.riskFlags[0]}`);
  }

  return {
    confidenceTier: confidence,
    topLeadSpecies: top?.species ?? null,
    topCandidates: scored.slice(0, 4),
    reasons: uniqueStrings(top?.reasons ?? []).slice(0, 3),
    riskFlags: uniqueStrings(top?.riskFlags ?? []).slice(0, 2),
    summary: `${summaryParts.join("; ")}.`
  };
}
