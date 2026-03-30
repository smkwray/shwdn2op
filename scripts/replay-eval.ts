import fs from "node:fs/promises";
import path from "node:path";

import type { ReplayPolicyExample } from "../apps/companion/src/ml/replayPolicyExample.js";
import { DEFAULT_REPLAY_OUTPUT, readJsonl } from "./replay-common.js";

function gapBucket(gap: number) {
  if (gap >= 20) return "20+";
  if (gap >= 10) return "10-19.9";
  if (gap >= 5) return "5-9.9";
  return "0-4.9";
}

function safeDivide(numerator: number, denominator: number) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0;
}

async function main() {
  const inputPath = process.argv[2] ?? DEFAULT_REPLAY_OUTPUT;
  const outputPath = process.argv[3] ?? inputPath.replace(/\.jsonl$/i, ".eval.json");
  const rows = await readJsonl<ReplayPolicyExample>(inputPath);

  let total = 0;
  let top1 = 0;
  let top3 = 0;
  let mrrTotal = 0;
  let moveLabels = 0;
  let switchLabels = 0;
  let moveTop1 = 0;
  let switchTop1 = 0;

  const byKnownMoveCount = new Map<string, { total: number; top1: number }>();
  const byGapBucket = new Map<string, { total: number; top1: number }>();
  const worstMisses: Array<{
    replayFile: string;
    turn: number;
    actingSide: string;
    label: string;
    predictedTop: string | null;
    rank: number | null;
    scoreGap: number | null;
  }> = [];

  for (const example of rows) {
    const ranked = [...(example.candidateFeatures ?? [])].sort((a, b) => (b.deterministicScore ?? 0) - (a.deterministicScore ?? 0));
    if (ranked.length === 0) continue;
    total += 1;
    if (example.label.kind === "move") moveLabels += 1;
    if (example.label.kind === "switch") switchLabels += 1;

    const rank = ranked.findIndex((candidate) => candidate.actionId === example.label.actionId);
    const topCandidate = ranked[0] ?? null;
    const scoreGap = ranked.length >= 2
      ? Number(((ranked[0]?.deterministicScore ?? 0) - (ranked[1]?.deterministicScore ?? 0)).toFixed(1))
      : null;

    if (rank === 0) {
      top1 += 1;
      if (example.label.kind === "move") moveTop1 += 1;
      if (example.label.kind === "switch") switchTop1 += 1;
    }
    if (rank >= 0 && rank < 3) {
      top3 += 1;
    }
    if (rank >= 0) {
      mrrTotal += 1 / (rank + 1);
    }

    const moveBucket = String(example.observation.knownMoveCount);
    const moveCounts = byKnownMoveCount.get(moveBucket) ?? { total: 0, top1: 0 };
    moveCounts.total += 1;
    if (rank === 0) moveCounts.top1 += 1;
    byKnownMoveCount.set(moveBucket, moveCounts);

    const gapKey = gapBucket(scoreGap ?? 0);
    const gapCounts = byGapBucket.get(gapKey) ?? { total: 0, top1: 0 };
    gapCounts.total += 1;
    if (rank === 0) gapCounts.top1 += 1;
    byGapBucket.set(gapKey, gapCounts);

    if (rank !== 0) {
      worstMisses.push({
        replayFile: example.source.replayFile,
        turn: example.source.turn,
        actingSide: example.source.actingSide,
        label: example.label.label,
        predictedTop: topCandidate?.label ?? null,
        rank: rank >= 0 ? rank + 1 : null,
        scoreGap
      });
    }
  }

  worstMisses.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (b.scoreGap ?? 0) - (a.scoreGap ?? 0));

  const summary = {
    generatedAt: new Date().toISOString(),
    inputPath: path.resolve(inputPath),
    exampleCount: total,
    top1Accuracy: safeDivide(top1, total),
    top3Accuracy: safeDivide(top3, total),
    meanReciprocalRank: total > 0 ? Number((mrrTotal / total).toFixed(3)) : 0,
    actionKindBreakdown: {
      move: {
        total: moveLabels,
        top1Accuracy: safeDivide(moveTop1, moveLabels)
      },
      switch: {
        total: switchLabels,
        top1Accuracy: safeDivide(switchTop1, switchLabels)
      }
    },
    byKnownMoveCount: Object.fromEntries(
      [...byKnownMoveCount.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([key, value]) => [
        key,
        {
          total: value.total,
          top1Accuracy: safeDivide(value.top1, value.total)
        }
      ])
    ),
    byTopScoreGap: Object.fromEntries(
      [...byGapBucket.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => [
        key,
        {
          total: value.total,
          top1Accuracy: safeDivide(value.top1, value.total)
        }
      ])
    ),
    notes: [
      "This is imitation-style offline eval against replay actions, not a solved best-play benchmark.",
      "Use this to compare deterministic, prior, and reranker variants on the same extracted examples.",
      "Top-score-gap buckets are a first-pass confidence sanity check, not calibrated win probabilities."
    ],
    exampleMisses: worstMisses.slice(0, 25)
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
