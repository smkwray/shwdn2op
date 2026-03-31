import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type EvalSummary = {
  generatedAt: string;
  inputPath: string;
  splitCounts?: Record<string, number> | undefined;
  overall?: {
    exampleCount: number;
    top1Accuracy: number;
    top3Accuracy: number;
    meanReciprocalRank: number;
    bySelfConfidenceTier?: Record<string, { total: number; top1Accuracy: number }> | undefined;
  } | undefined;
  goldHoldout?: {
    exampleCount: number;
    top1Accuracy: number;
    top3Accuracy: number;
    meanReciprocalRank: number;
    bySelfConfidenceTier?: Record<string, { total: number; top1Accuracy: number }> | undefined;
  } | null | undefined;
};

type BucketSummary = {
  generatedAt: string;
  inputPath: string;
  replayCount?: number | undefined;
  exampleCount?: number | undefined;
  bucketCounts?: Record<string, number> | undefined;
  tuningReadinessByBucket?: Record<string, {
    status: string;
    missCount: number;
    distinctReplayCount: number;
    crossReplayCoverageShare: number;
  }> | undefined;
  stablePatternsByBucket?: Record<string, unknown[]> | undefined;
};

type SnapshotEvalSummary = {
  generatedAt?: string | undefined;
  summary?: {
    caseCount?: number | undefined;
    passCount?: number | undefined;
    failCount?: number | undefined;
  } | undefined;
} | Array<unknown>;

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8")) as T;
}

async function maybeGit(command: string[], cwd: string) {
  try {
    const result = await execFileAsync(command[0] ?? "git", command.slice(1), { cwd });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function confidenceSignal(summary: EvalSummary["goldHoldout"] | EvalSummary["overall"] | null | undefined) {
  const tiers = summary?.bySelfConfidenceTier ?? {};
  const low = tiers.low?.top1Accuracy ?? null;
  const medium = tiers.medium?.top1Accuracy ?? null;
  const high = tiers.high?.top1Accuracy ?? null;
  return {
    low,
    medium,
    high,
    highUnderperformsMedium: high !== null && medium !== null ? high < medium : null,
    highUnderperformsLow: high !== null && low !== null ? high < low : null
  };
}

async function main() {
  const evalPath = process.argv[2] ?? "ml-artifacts/replay-policy-examples.eval.json";
  const bucketPath = process.argv[3] ?? "ml-artifacts/replay-policy-examples.miss-buckets.json";
  const snapshotEvalPath = process.argv[4] ?? "ml-artifacts/frozen-snapshot-eval.json";
  const ledgerPath = process.argv[5] ?? "ml-artifacts/experiment-ledger.jsonl";
  const label = process.argv[6] ?? "baseline";
  const cwd = process.cwd();

  const [evalSummary, bucketSummary, snapshotEval] = await Promise.all([
    readJson<EvalSummary>(evalPath),
    readJson<BucketSummary>(bucketPath),
    readJson<SnapshotEvalSummary>(snapshotEvalPath)
  ]);

  const [gitBranch, gitCommit, gitDirtyPorcelain] = await Promise.all([
    maybeGit(["git", "branch", "--show-current"], cwd),
    maybeGit(["git", "rev-parse", "HEAD"], cwd),
    maybeGit(["git", "status", "--short"], cwd)
  ]);

  const gold = evalSummary.goldHoldout ?? null;
  const overall = evalSummary.overall ?? null;
  const snapshotCases = Array.isArray(snapshotEval)
    ? snapshotEval.length
    : Number(snapshotEval.summary?.caseCount ?? 0);
  const snapshotFails = Array.isArray(snapshotEval)
    ? snapshotEval.filter((entry) => typeof entry === "object" && entry !== null && "ok" in entry && !(entry as { ok?: boolean }).ok).length
    : Number(snapshotEval.summary?.failCount ?? 0);

  const entry = {
    schemaVersion: "experiment-ledger-entry@0.1",
    recordedAt: new Date().toISOString(),
    label,
    paths: {
      evalPath: path.resolve(evalPath),
      bucketPath: path.resolve(bucketPath),
      snapshotEvalPath: path.resolve(snapshotEvalPath)
    },
    git: {
      branch: gitBranch,
      commit: gitCommit,
      dirty: Boolean(gitDirtyPorcelain)
    },
    corpus: {
      splitCounts: evalSummary.splitCounts ?? {},
      replayCount: bucketSummary.replayCount ?? null,
      exampleCount: bucketSummary.exampleCount ?? overall?.exampleCount ?? null
    },
    snapshotEval: {
      caseCount: snapshotCases,
      failCount: snapshotFails
    },
    metrics: {
      overall: overall
        ? {
            exampleCount: overall.exampleCount,
            top1Accuracy: overall.top1Accuracy,
            top3Accuracy: overall.top3Accuracy,
            meanReciprocalRank: overall.meanReciprocalRank,
            confidence: confidenceSignal(overall)
          }
        : null,
      goldHoldout: gold
        ? {
            exampleCount: gold.exampleCount,
            top1Accuracy: gold.top1Accuracy,
            top3Accuracy: gold.top3Accuracy,
            meanReciprocalRank: gold.meanReciprocalRank,
            confidence: confidenceSignal(gold)
          }
        : null
    },
    buckets: {
      counts: bucketSummary.bucketCounts ?? {},
      readiness: bucketSummary.tuningReadinessByBucket ?? {},
      stablePatternCounts: Object.fromEntries(
        Object.entries(bucketSummary.stablePatternsByBucket ?? {}).map(([bucket, patterns]) => [
          bucket,
          Array.isArray(patterns) ? patterns.length : 0
        ])
      )
    },
    plateauSignals: {
      goldExists: Boolean(gold),
      frozenSnapshotPassing: snapshotFails === 0,
      hiddenSwitchReadiness: bucketSummary.tuningReadinessByBucket?.hidden_switch?.status ?? null,
      setupHazardReadiness: bucketSummary.tuningReadinessByBucket?.setup_hazard?.status ?? null,
      confidenceNeedsCalibration: (() => {
        const high = gold?.bySelfConfidenceTier?.high?.top1Accuracy ?? null;
        const medium = gold?.bySelfConfidenceTier?.medium?.top1Accuracy ?? null;
        return high !== null && medium !== null ? high < medium : null;
      })()
    }
  };

  const absoluteLedgerPath = path.resolve(ledgerPath);
  await fs.mkdir(path.dirname(absoluteLedgerPath), { recursive: true });
  let priorLines = "";
  try {
    priorLines = await fs.readFile(absoluteLedgerPath, "utf8");
  } catch {
    priorLines = "";
  }
  const nextText = `${priorLines}${JSON.stringify(entry)}\n`;
  await fs.writeFile(absoluteLedgerPath, nextText, "utf8");

  const latestSummaryPath = absoluteLedgerPath.replace(/\.jsonl$/i, ".latest.json");
  await fs.writeFile(latestSummaryPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    recordedAt: entry.recordedAt,
    label: entry.label,
    ledgerPath: absoluteLedgerPath,
    latestSummaryPath,
    goldTop1: entry.metrics.goldHoldout?.top1Accuracy ?? null,
    goldTop3: entry.metrics.goldHoldout?.top3Accuracy ?? null,
    hiddenSwitchReadiness: entry.plateauSignals.hiddenSwitchReadiness,
    setupHazardReadiness: entry.plateauSignals.setupHazardReadiness,
    confidenceNeedsCalibration: entry.plateauSignals.confidenceNeedsCalibration
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
