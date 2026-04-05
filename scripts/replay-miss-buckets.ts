import fs from "node:fs/promises";
import path from "node:path";

import type { ReplayPolicyCandidateFeature, ReplayPolicyExample } from "../apps/companion/src/ml/replayPolicyExample.js";
import { DEFAULT_REPLAY_OUTPUT, readJsonl } from "./replay-common.js";

type BucketName =
  | "search_width"
  | "hidden_switch"
  | "preserve_sack"
  | "setup_hazard"
  | "wrong_item"
  | "wrong_ability"
  | "wrong_speed"
  | "wrong_damage"
  | "wrong_switch_target"
  | "other";
type RecurringPatternSummary = {
  signature: string;
  missCount: number;
  distinctReplayCount: number;
  yourActiveSpecies: string | null;
  opponentActiveSpecies: string | null;
  label: string;
  predictedTop: string | null;
  sampleReplayFiles: string[];
};
type BucketReadinessStatus = "broad_repeated_signal" | "mixed_signal_collect_more" | "thin_signal_do_not_tune";

const ALL_BUCKET_NAMES: BucketName[] = [
  "wrong_item", "wrong_ability", "wrong_speed", "wrong_damage", "wrong_switch_target",
  "search_width", "hidden_switch", "preserve_sack", "setup_hazard", "other"
];

const SETUP_OR_HAZARD_MOVES = new Set([
  "agility",
  "calmmind",
  "curse",
  "defog",
  "dragondance",
  "nastyplot",
  "rapidspin",
  "recover",
  "roost",
  "slackoff",
  "spikes",
  "stealthrock",
  "substitute",
  "swordsdance",
  "taunt",
  "thunderwave",
  "toxic",
  "uturn",
  "voltswitch",
  "willowisp"
]);

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function searchScore(candidate: ReplayPolicyCandidateFeature | null | undefined) {
  return candidate?.scoreBreakdown?.find((entry) => entry.key === "search")?.value ?? 0;
}

function preserveScore(candidate: ReplayPolicyCandidateFeature | null | undefined) {
  return candidate?.scoreBreakdown?.find((entry) => entry.key === "preserve")?.value ?? 0;
}

function replayPatternSignature(example: ReplayPolicyExample, topCandidate: ReplayPolicyCandidateFeature | null) {
  const yourSpecies = example.snapshot.yourSide.active?.species ?? example.snapshot.yourSide.active?.displayName ?? "unknown";
  const opponentSpecies = example.snapshot.opponentSide.active?.species ?? example.snapshot.opponentSide.active?.displayName ?? "unknown";
  const labelFocus = example.label.kind === "switch"
    ? example.label.switchTargetSpecies ?? example.label.label
    : example.label.moveName ?? example.label.label;
  const topFocus = topCandidate?.kind === "switch"
    ? topCandidate.switchTargetSpecies ?? topCandidate.label
    : topCandidate?.moveName ?? topCandidate?.label ?? "unknown";
  return [
    normalizeName(yourSpecies),
    normalizeName(opponentSpecies),
    `${example.label.kind}:${normalizeName(labelFocus)}`,
    `${topCandidate?.kind ?? "unknown"}:${normalizeName(topFocus)}`
  ].join("|");
}

function priorityScore(bucket: BucketName) {
  switch (bucket) {
    // Mechanics buckets are highest priority — they point at deterministic layer errors
    case "wrong_item":
      return 8;
    case "wrong_ability":
      return 8;
    case "wrong_speed":
      return 7;
    case "wrong_damage":
      return 7;
    case "wrong_switch_target":
      return 6;
    // Strategic buckets
    case "setup_hazard":
      return 5;
    case "preserve_sack":
      return 4;
    case "hidden_switch":
      return 3;
    case "search_width":
      return 2;
    default:
      return 1;
  }
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Number((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2).toFixed(1));
}

function bucketForMiss(params: {
  example: ReplayPolicyExample;
  topCandidate: ReplayPolicyCandidateFeature | null;
  labelCandidate: ReplayPolicyCandidateFeature | null;
  rank: number | null;
  scoreGap: number | null;
}) {
  const { example, topCandidate, labelCandidate, rank, scoreGap } = params;
  const activeHp = example.snapshot.yourSide.active?.hpPercent ?? null;
  const labelMove = normalizeName(example.label.moveName ?? example.label.label);
  const topMove = normalizeName(topCandidate?.moveName ?? topCandidate?.label);
  const hasPartialOpponentInfo = example.notes.some((note) => /partially revealed/i.test(note))
    || example.snapshot.opponentSide.team.some((pokemon) => !pokemon.revealed);
  const thinBoard = example.snapshot.turn <= 6 || example.observation.opponentReserveCount >= 3;
  const moveSwitchDisagreement = example.label.kind !== topCandidate?.kind
    && (example.label.kind === "switch" || topCandidate?.kind === "switch");
  const topRiskFlags = topCandidate?.riskFlags ?? [];
  const topPreserveScore = preserveScore(topCandidate);
  const searchDelta = Math.abs(searchScore(topCandidate) - searchScore(labelCandidate));

  const candidates: Array<{ bucket: BucketName; reason: string }> = [];
  const opponentActive = example.snapshot.opponentSide.active;
  const allRiskFlags = [...(topCandidate?.riskFlags ?? []), ...(labelCandidate?.riskFlags ?? [])];
  const allReasons = [...(topCandidate?.reasons ?? []), ...(labelCandidate?.reasons ?? [])];
  const allText = [...allRiskFlags, ...allReasons].join(" ").toLowerCase();

  // ---- Mechanics-specific buckets (P3) ----

  // wrong_item: opponent item was revealed/removed and risk flags or reasons mention item
  // interactions, or the label vs top diverge on an item-sensitive choice
  if (
    (opponentActive?.item || opponentActive?.removedItem)
    && (
      allText.includes("item") || allText.includes("choice") || allText.includes("scarf")
      || allText.includes("boots") || allText.includes("orb") || allText.includes("balloon")
      || allText.includes("sash") || allText.includes("vest")
    )
  ) {
    candidates.push({
      bucket: "wrong_item",
      reason: `Opponent item ${opponentActive.item ?? opponentActive.removedItem} was revealed and item-related reasoning appeared in candidate text.`
    });
  }

  // wrong_ability: opponent ability was revealed and risk flags mention ability interactions
  if (
    opponentActive?.ability
    && (
      allText.includes("ability") || allText.includes("immune") || allText.includes("absorb")
      || allText.includes("levitate") || allText.includes("flash fire") || allText.includes("intimidate")
      || allText.includes("mold breaker") || allText.includes("regenerator")
    )
  ) {
    candidates.push({
      bucket: "wrong_ability",
      reason: `Opponent ability ${opponentActive.ability} was revealed and ability-related reasoning appeared in candidate text.`
    });
  }

  // wrong_speed: speed relation in deterministic data appears to have been wrong
  // Evidence: risk flags mention speed overlap, or the deterministic speedPreview
  // relation disagrees with what the move order implies (if label went first but
  // speed said slower, or vice versa)
  {
    const speedRelation = example.deterministic?.speedPreview?.activeRelation;
    const speedMentioned = allText.includes("speed") || allText.includes("outspeed")
      || allText.includes("faster") || allText.includes("slower") || allText.includes("priority");
    const speedOverlap = speedRelation === "overlap" || speedRelation === "unknown";
    if (speedMentioned && (speedOverlap || allRiskFlags.some((f) => /speed.*overlap/i.test(f)))) {
      candidates.push({
        bucket: "wrong_speed",
        reason: `Speed was ${speedRelation ?? "unknown"} and speed-related reasoning appeared in candidate text.`
      });
    }
  }

  // wrong_damage: tactical score component differed significantly between label
  // and top candidate, suggesting damage estimate was off
  {
    const topTactical = topCandidate?.scoreBreakdown?.find((e) => e.key === "tactical")?.value ?? 0;
    const labelTactical = labelCandidate?.scoreBreakdown?.find((e) => e.key === "tactical")?.value ?? 0;
    const tacticalDelta = Math.abs(topTactical - labelTactical);
    const bothMoves = topCandidate?.kind === "move" && example.label.kind === "move";
    if (bothMoves && tacticalDelta >= 15) {
      candidates.push({
        bucket: "wrong_damage",
        reason: `Large tactical score gap (${tacticalDelta.toFixed(1)}) between top move and label move suggests damage assumptions differed.`
      });
    }
  }

  // wrong_switch_target: label was a switch and top was also a switch but to a
  // different target, or label was a switch but top was a move (and the target
  // appears in risk flags as penalized)
  if (
    example.label.kind === "switch"
    && topCandidate?.kind === "switch"
    && example.label.switchTargetSpecies
    && topCandidate.switchTargetSpecies
    && normalizeName(example.label.switchTargetSpecies) !== normalizeName(topCandidate.switchTargetSpecies)
  ) {
    candidates.push({
      bucket: "wrong_switch_target",
      reason: `Both label and top are switches but to different targets: label=${example.label.switchTargetSpecies}, top=${topCandidate.switchTargetSpecies}.`
    });
  }

  // ---- Strategic buckets (existing) ----

  if (SETUP_OR_HAZARD_MOVES.has(labelMove) || SETUP_OR_HAZARD_MOVES.has(topMove)) {
    candidates.push({
      bucket: "setup_hazard",
      reason: "Chosen or predicted top line was a setup, hazard, recovery, or pivot utility move."
    });
  }

  if (
    (example.label.kind === "switch" && (
      topPreserveScore <= -4
      || topRiskFlags.some((flag) => /low-HP piece|preserving the active matters/i.test(flag))
    ))
    || (example.label.kind === "move" && activeHp !== null && activeHp <= 45 && topCandidate?.kind === "move" && rank !== null && rank > 0)
  ) {
    candidates.push({
      bucket: "preserve_sack",
      reason: "Miss looks tied to preserving a pressured active or accepting a sack line."
    });
  }

  if ((hasPartialOpponentInfo || thinBoard) && (moveSwitchDisagreement || labelMove !== topMove)) {
    candidates.push({
      bucket: "hidden_switch",
      reason: hasPartialOpponentInfo
        ? "Opponent roster was still partially hidden, so unseen switch-ins may have changed the preferred line."
        : "Early-turn move-vs-switch disagreement suggests hidden reserve respect or switch-in coverage pressure."
    });
  }

  if ((rank !== null && rank <= 3) || searchDelta >= 4 || (scoreGap !== null && scoreGap <= 25)) {
    candidates.push({
      bucket: "search_width",
      reason: "Chosen action stayed near the top of the deterministic list or search contribution differed materially."
    });
  }

  const primary = candidates.sort((a, b) => priorityScore(b.bucket) - priorityScore(a.bucket))[0]
    ?? { bucket: "other" as BucketName, reason: "No heuristic bucket matched cleanly." };

  return {
    primaryBucket: primary.bucket,
    reason: primary.reason,
    tags: [...new Set(candidates.map((entry) => entry.bucket))]
  };
}

async function main() {
  const inputPath = process.argv[2] ?? DEFAULT_REPLAY_OUTPUT;
  const outputPath = process.argv[3] ?? inputPath.replace(/\.jsonl$/i, ".miss-buckets.json");
  const rows = await readJsonl<ReplayPolicyExample>(inputPath);

  const bucketed: Array<{
    replayFile: string;
    turn: number;
    actingSide: string;
    yourActiveSpecies: string | null;
    opponentActiveSpecies: string | null;
    label: string;
    labelKind: "move" | "switch";
    predictedTop: string | null;
    predictedTopKind: string | null;
    rank: number | null;
    scoreGap: number | null;
    primaryBucket: BucketName;
    tags: BucketName[];
    reason: string;
    patternSignature: string;
  }> = [];

  for (const example of rows) {
    const ranked = [...(example.candidateFeatures ?? [])].sort((a, b) => (b.deterministicScore ?? 0) - (a.deterministicScore ?? 0));
    if (ranked.length === 0) continue;
    const rank = ranked.findIndex((candidate) => candidate.actionId === example.label.actionId);
    if (rank === 0) continue;
    const topCandidate = ranked[0] ?? null;
    const labelCandidate = rank >= 0 ? ranked[rank] ?? null : null;
    const scoreGap = ranked.length >= 2
      ? Number(((ranked[0]?.deterministicScore ?? 0) - (ranked[1]?.deterministicScore ?? 0)).toFixed(1))
      : null;
    const bucket = bucketForMiss({
      example,
      topCandidate,
      labelCandidate,
      rank: rank >= 0 ? rank + 1 : null,
      scoreGap
    });

    bucketed.push({
      replayFile: example.source.replayFile,
      turn: example.source.turn,
      actingSide: example.source.actingSide,
      yourActiveSpecies: example.snapshot.yourSide.active?.species ?? example.snapshot.yourSide.active?.displayName ?? null,
      opponentActiveSpecies: example.snapshot.opponentSide.active?.species ?? example.snapshot.opponentSide.active?.displayName ?? null,
      label: example.label.label,
      labelKind: example.label.kind,
      predictedTop: topCandidate?.label ?? null,
      predictedTopKind: topCandidate?.kind ?? null,
      rank: rank >= 0 ? rank + 1 : null,
      scoreGap,
      primaryBucket: bucket.primaryBucket,
      tags: bucket.tags,
      reason: bucket.reason,
      patternSignature: replayPatternSignature(example, topCandidate)
    });
  }

  const byBucket = new Map<BucketName, typeof bucketed>();
  for (const miss of bucketed) {
    const entries = byBucket.get(miss.primaryBucket) ?? [];
    entries.push(miss);
    byBucket.set(miss.primaryBucket, entries);
  }

  const replayCountsOverall = rows.reduce((map, example) => {
    map.set(example.source.replayFile, (map.get(example.source.replayFile) ?? 0) + 1);
    return map;
  }, new Map<string, number>());
  const formatCounts = rows.reduce((map, example) => {
    map.set(example.source.format, (map.get(example.source.format) ?? 0) + 1);
    return map;
  }, new Map<string, number>());
  const examplesPerReplay = [...replayCountsOverall.values()];
  const topReplays = [...replayCountsOverall.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([replayFile, exampleCount]) => ({
      replayFile,
      exampleCount,
      corpusShare: rows.length > 0 ? Number((exampleCount / rows.length).toFixed(3)) : 0
    }));

  const bucketDiversity = Object.fromEntries(
    ALL_BUCKET_NAMES.map((bucket) => {
      const entries = byBucket.get(bucket) ?? [];
      const replayCounts = new Map<string, number>();
      for (const entry of entries) {
        replayCounts.set(entry.replayFile, (replayCounts.get(entry.replayFile) ?? 0) + 1);
      }
      const distinctReplayCount = replayCounts.size;
      const topReplayCount = Math.max(0, ...replayCounts.values());
      return [bucket, {
        missCount: entries.length,
        distinctReplayCount,
        topReplayCount,
        topReplayShare: entries.length > 0 ? Number((topReplayCount / entries.length).toFixed(3)) : 0
      }];
    })
  );

  const recurringPatternsByBucket = Object.fromEntries(
    ALL_BUCKET_NAMES.map((bucket) => {
      const entries = byBucket.get(bucket) ?? [];
      const byPattern = new Map<string, {
        signature: string;
        missCount: number;
        distinctReplayFiles: Set<string>;
        yourActiveSpecies: string | null;
        opponentActiveSpecies: string | null;
        label: string;
        predictedTop: string | null;
      }>();
      for (const entry of entries) {
        const current = byPattern.get(entry.patternSignature) ?? {
          signature: entry.patternSignature,
          missCount: 0,
          distinctReplayFiles: new Set<string>(),
          yourActiveSpecies: entry.yourActiveSpecies,
          opponentActiveSpecies: entry.opponentActiveSpecies,
          label: entry.label,
          predictedTop: entry.predictedTop
        };
        current.missCount += 1;
        current.distinctReplayFiles.add(entry.replayFile);
        byPattern.set(entry.patternSignature, current);
      }
      return [bucket, [...byPattern.values()]
        .map((entry) => ({
          signature: entry.signature,
          missCount: entry.missCount,
          distinctReplayCount: entry.distinctReplayFiles.size,
          yourActiveSpecies: entry.yourActiveSpecies,
          opponentActiveSpecies: entry.opponentActiveSpecies,
          label: entry.label,
          predictedTop: entry.predictedTop,
          sampleReplayFiles: [...entry.distinctReplayFiles].sort().slice(0, 5)
        }))
        .filter((entry) => entry.missCount >= 2 || entry.distinctReplayCount >= 2)
        .sort((a, b) => b.distinctReplayCount - a.distinctReplayCount || b.missCount - a.missCount)
        .slice(0, 12)];
    })
  ) as Record<BucketName, RecurringPatternSummary[]>;

  const stablePatternsByBucket = Object.fromEntries(
    ALL_BUCKET_NAMES.map((bucket) => [
      bucket,
      recurringPatternsByBucket[bucket]
        .filter((entry) => entry.distinctReplayCount >= 2)
        .slice(0, 8)
    ])
  ) as Record<BucketName, RecurringPatternSummary[]>;

  const tuningReadinessByBucket = Object.fromEntries(
    ALL_BUCKET_NAMES.map((bucket) => {
      const diversity = bucketDiversity[bucket] ?? { missCount: 0, distinctReplayCount: 0, topReplayCount: 0, topReplayShare: 0 };
      const stablePatterns = stablePatternsByBucket[bucket] ?? [];
      const crossReplayMissCount = stablePatterns.reduce((sum, entry) => sum + entry.missCount, 0);
      const crossReplayCoverageShare = diversity.missCount > 0
        ? Number((crossReplayMissCount / diversity.missCount).toFixed(3))
        : 0;

      let status: BucketReadinessStatus = "thin_signal_do_not_tune";
      let recommendation = "Do not tune this bucket yet; collect more replay coverage first.";
      if (
        diversity.distinctReplayCount >= 20
        && diversity.topReplayShare <= 0.15
        && stablePatterns.length >= 3
        && crossReplayCoverageShare >= 0.05
      ) {
        status = "broad_repeated_signal";
        recommendation = "Broad enough to inspect for a narrow deterministic pass, but only around the repeated multi-replay patterns.";
      } else if (
        diversity.distinctReplayCount >= 10
        && stablePatterns.length >= 2
      ) {
        status = "mixed_signal_collect_more";
        recommendation = "Some repeated signal exists, but more replay history would reduce the risk of tuning to a narrow slice of boards.";
      }

      return [bucket, {
        status,
        recommendation,
        missCount: diversity.missCount,
        distinctReplayCount: diversity.distinctReplayCount,
        topReplayShare: diversity.topReplayShare,
        stablePatternCount: stablePatterns.length,
        crossReplayMissCount,
        crossReplayCoverageShare
      }];
    })
  ) as Record<BucketName, {
    status: BucketReadinessStatus;
    recommendation: string;
    missCount: number;
    distinctReplayCount: number;
    topReplayShare: number;
    stablePatternCount: number;
    crossReplayMissCount: number;
    crossReplayCoverageShare: number;
  }>;

  const summary = {
    generatedAt: new Date().toISOString(),
    inputPath: path.resolve(inputPath),
    replayCount: replayCountsOverall.size,
    exampleCount: rows.length,
    formatCounts: Object.fromEntries([...formatCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    examplesPerReplay: {
      min: examplesPerReplay.length > 0 ? Math.min(...examplesPerReplay) : 0,
      median: median(examplesPerReplay),
      mean: mean(examplesPerReplay),
      max: examplesPerReplay.length > 0 ? Math.max(...examplesPerReplay) : 0,
      topReplays
    },
    missCount: bucketed.length,
    bucketCounts: Object.fromEntries(
      ALL_BUCKET_NAMES.map((bucket) => [
        bucket,
        byBucket.get(bucket)?.length ?? 0
      ])
    ),
    bucketDiversity,
    tuningReadinessByBucket,
    recurringPatternsByBucket,
    stablePatternsByBucket,
    topExamplesByBucket: Object.fromEntries(
      ALL_BUCKET_NAMES.map((bucket) => [
        bucket,
        [...(byBucket.get(bucket) ?? [])]
          .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (b.scoreGap ?? 0) - (a.scoreGap ?? 0))
          .slice(0, 12)
      ])
    ),
    notes: [
      "Buckets are heuristic and intended for deterministic tuning triage, not for formal labeling.",
      "A miss can carry multiple tags; `primaryBucket` is the highest-priority heuristic match.",
      "Mechanics buckets (wrong_item, wrong_ability, wrong_speed, wrong_damage, wrong_switch_target) are prioritized over strategic buckets because they point at deterministic layer errors.",
      "Prefer tuning only when a miss pattern repeats across multiple replay files, not from raw single-battle counts.",
      "Use `tuningReadinessByBucket` and `stablePatternsByBucket` before changing weights; high raw miss count alone is not enough.",
      "If a bucket remains `mixed_signal_collect_more` or `thin_signal_do_not_tune`, bias toward collecting more replay history instead of forcing a heuristic change."
    ]
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
