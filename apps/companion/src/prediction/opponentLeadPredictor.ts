import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import type {
  BattleSnapshot,
  LikelihoodEntry,
  OpponentIntelEntry,
  OpponentLeadCandidate,
  OpponentLeadPrediction,
  PokemonSnapshot
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

function likelyMovePool(entry: OpponentIntelEntry | undefined, pokemon: PokemonSnapshot) {
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

function leadLikelihood(entry: OpponentIntelEntry | undefined): LikelihoodEntry | null {
  if (!entry || !Number.isFinite(entry.historicalLeadCount) || !Number.isFinite(entry.historicalLeadShare)) return null;
  return {
    name: entry.species,
    count: Number(entry.historicalLeadCount),
    share: Number(entry.historicalLeadShare),
    sampleCount: Number(entry.battlesSeen ?? 0),
    confidenceTier: entry.battlesSeen >= 8 ? "strong" : entry.battlesSeen >= 3 ? "usable" : "thin"
  };
}

function candidateConfidenceScore(likelihood: LikelihoodEntry | null) {
  if (!likelihood) return 0;
  if (likelihood.confidenceTier === "strong") return 10;
  if (likelihood.confidenceTier === "usable") return 6;
  return 2;
}

export function buildOpponentLeadPrediction(params: {
  snapshot: BattleSnapshot;
  allOpponentEntries?: OpponentIntelEntry[] | undefined;
}): OpponentLeadPrediction | undefined {
  if (params.snapshot.phase !== "preview" || params.snapshot.opponentSide.active) return undefined;
  const candidates = params.snapshot.opponentSide.team.filter((pokemon) => !pokemon.fainted && pokemon.revealed);
  if (candidates.length === 0) return undefined;

  const gen = dataGen(params.snapshot.format);
  const scored: OpponentLeadCandidate[] = candidates.map((pokemon) => {
    const speciesName = pokemon.species ?? pokemon.displayName ?? "Unknown";
    const entry = params.allOpponentEntries?.find((candidate) => normalizeName(candidate.species) === normalizeName(speciesName));
    const species = lookupSpecies(gen, speciesName);
    const leadStats = leadLikelihood(entry);
    const movePool = likelyMovePool(entry, pokemon);
    const moveNames = movePool.map((move) => move.name);
    const reasons: string[] = [];
    const riskFlags: string[] = [];
    let score = 12;

    if (leadStats && leadStats.count > 0) {
      score += leadStats.share * 42;
      score += candidateConfidenceScore(leadStats);
      reasons.push(`historically leads ${Math.round(leadStats.share * 100)}% of seen games`);
    }

    const hazardMoves = moveNames.filter((moveName) => ["stealthrock", "spikes", "toxicspikes", "stickyweb"].includes(normalizeName(moveName)));
    if (hazardMoves.length > 0) {
      score += 16;
      reasons.push("likely to open hazards early");
    }

    const pivotMoves = moveNames.filter((moveName) => ["uturn", "voltswitch", "flipturn", "partingshot", "chillyreception", "batonpass"].includes(normalizeName(moveName)));
    if (pivotMoves.length > 0) {
      score += 10;
      reasons.push("has a safe pivot opener");
    }

    const antiLeadMoves = moveNames.filter((moveName) => ["fakeout", "firstimpression", "taunt", "spore", "nuzzle"].includes(normalizeName(moveName)));
    if (antiLeadMoves.length > 0) {
      score += 10;
      reasons.push("has strong opener pressure");
    }

    const statusLeadMoves = moveNames.filter((moveName) => ["encore", "thunderwave", "willowisp", "toxic", "rapidspin"].includes(normalizeName(moveName)));
    if (statusLeadMoves.length > 0) {
      score += 5;
      reasons.push("can force early utility tempo");
    }

    const baseSpeed = Number(pokemon.stats?.spe ?? species?.baseStats?.spe ?? 0);
    if (baseSpeed >= 120) {
      score += 10;
      reasons.push("very fast lead candidate");
    } else if (baseSpeed >= 100) {
      score += 6;
      reasons.push("fast enough to pressure common leads");
    } else if (baseSpeed <= 55 && hazardMoves.length === 0) {
      score -= 4;
      riskFlags.push("slow opener without a clear hazard role");
    }

    const likelyItem = entry?.revealedItem ?? entry?.likelyItems?.[0]?.name ?? null;
    if (["Focus Sash", "Heavy-Duty Boots"].some((item) => normalizeName(item) === normalizeName(likelyItem))) {
      score += 4;
      reasons.push("item profile fits an opener");
    }

    if ((entry?.posterior?.confidenceTier ?? "thin") === "thin" && !leadStats) {
      riskFlags.push("light local history on this species");
    }

    return {
      species: speciesName,
      score: clampScore(score),
      historicalLeadShare: leadStats?.share,
      reasons: uniqueStrings(reasons).slice(0, 3),
      riskFlags: uniqueStrings(riskFlags).slice(0, 2)
    };
  }).sort((a, b) => b.score - a.score || a.species.localeCompare(b.species));

  const top = scored[0];
  const runnerUp = scored[1];
  const gap = (top?.score ?? 0) - (runnerUp?.score ?? 0);
  const confidence = !top || top.score < 24
    ? "low"
    : top.score >= 46 && gap >= 10
      ? "high"
      : top.score >= 32 && gap >= 5
        ? "medium"
        : "low";

  return {
    confidenceTier: confidence,
    topLeadSpecies: top?.species ?? null,
    topCandidates: scored.slice(0, 4),
    reasons: uniqueStrings(top?.reasons ?? []),
    riskFlags: uniqueStrings(top?.riskFlags ?? [])
  };
}
