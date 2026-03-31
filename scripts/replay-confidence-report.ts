import fs from "node:fs/promises";
import path from "node:path";

type ConfidenceBucket = {
  total: number;
  top1Accuracy: number;
};

type EvalSlice = {
  exampleCount: number;
  top1Accuracy: number;
  top3Accuracy: number;
  meanReciprocalRank: number;
  bySelfConfidenceTier?: Record<string, ConfidenceBucket> | undefined;
};

type EvalSummary = {
  generatedAt: string;
  inputPath: string;
  overall?: EvalSlice | undefined;
  goldHoldout?: EvalSlice | null | undefined;
  bySplit?: Record<string, EvalSlice> | undefined;
};

function safeNumber(value: unknown) {
  return Number.isFinite(value) ? Number(value) : null;
}

function tierAccuracy(slice: EvalSlice | null | undefined, tier: string) {
  return safeNumber(slice?.bySelfConfidenceTier?.[tier]?.top1Accuracy);
}

function tierCount(slice: EvalSlice | null | undefined, tier: string) {
  return Number(slice?.bySelfConfidenceTier?.[tier]?.total ?? 0);
}

function monotonicityFlags(slice: EvalSlice | null | undefined) {
  const low = tierAccuracy(slice, "low");
  const medium = tierAccuracy(slice, "medium");
  const high = tierAccuracy(slice, "high");
  return {
    low,
    medium,
    high,
    lowToMediumDelta: low !== null && medium !== null ? Number((medium - low).toFixed(3)) : null,
    mediumToHighDelta: medium !== null && high !== null ? Number((high - medium).toFixed(3)) : null,
    lowToHighDelta: low !== null && high !== null ? Number((high - low).toFixed(3)) : null,
    monotonic: low !== null && medium !== null && high !== null ? low <= medium && medium <= high : null,
    highUnderperformsMedium: high !== null && medium !== null ? high < medium : null,
    highUnderperformsLow: high !== null && low !== null ? high < low : null
  };
}

function confidenceSpread(slice: EvalSlice | null | undefined) {
  const low = tierAccuracy(slice, "low");
  const high = tierAccuracy(slice, "high");
  if (low === null || high === null) return null;
  return Number((high - low).toFixed(3));
}

function calibrationAssessment(slice: EvalSlice | null | undefined) {
  const flags = monotonicityFlags(slice);
  const spread = confidenceSpread(slice);
  if (flags.monotonic === null) {
    return {
      status: "insufficient_data",
      recommendation: "Not enough confidence-tier coverage to assess calibration yet."
    };
  }
  if (flags.highUnderperformsMedium || flags.highUnderperformsLow) {
    return {
      status: "miscalibrated",
      recommendation: "Do not trust the current tier thresholds; high confidence is not the most accurate bucket."
    };
  }
  if (spread !== null && spread < 0.05) {
    return {
      status: "weak_separation",
      recommendation: "Tier ordering is acceptable, but the accuracy gap is too small to make the labels very informative."
    };
  }
  return {
    status: "usable",
    recommendation: "Confidence tiers are ordered sensibly enough to use as a rough trust signal."
  };
}

function summarizeSlice(name: string, slice: EvalSlice | null | undefined) {
  const flags = monotonicityFlags(slice);
  const assessment = calibrationAssessment(slice);
  return {
    name,
    exampleCount: slice?.exampleCount ?? 0,
    baselineTop1: slice?.top1Accuracy ?? null,
    tiers: {
      low: {
        total: tierCount(slice, "low"),
        top1Accuracy: tierAccuracy(slice, "low")
      },
      medium: {
        total: tierCount(slice, "medium"),
        top1Accuracy: tierAccuracy(slice, "medium")
      },
      high: {
        total: tierCount(slice, "high"),
        top1Accuracy: tierAccuracy(slice, "high")
      }
    },
    deltas: {
      lowToMedium: flags.lowToMediumDelta,
      mediumToHigh: flags.mediumToHighDelta,
      lowToHigh: flags.lowToHighDelta
    },
    monotonic: flags.monotonic,
    assessment
  };
}

async function main() {
  const inputPath = process.argv[2] ?? "ml-artifacts/replay-policy-examples.eval.json";
  const outputPath = process.argv[3] ?? inputPath.replace(/\.eval\.json$/i, ".confidence.json");
  const summary = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8")) as EvalSummary;

  const overall = summarizeSlice("overall", summary.overall);
  const gold = summarizeSlice("goldHoldout", summary.goldHoldout ?? null);
  const dev = summarizeSlice("dev", summary.bySplit?.dev);
  const train = summarizeSlice("train", summary.bySplit?.train);

  const report = {
    generatedAt: new Date().toISOString(),
    inputPath: path.resolve(inputPath),
    overall,
    goldHoldout: gold,
    bySplit: {
      dev,
      train
    },
    notes: [
      "This is a confidence-tier sanity check built on imitation-style replay eval, not a calibrated probability guarantee.",
      "Treat `goldHoldout` as the main plateau/calibration signal.",
      "If `high` underperforms `medium`, confidence labels should be retuned or simplified before trusting them."
    ],
    recommendedNextStep: gold.assessment.status === "miscalibrated"
      ? "Retune or collapse self-recommendation confidence thresholds before using confidence as a trust signal."
      : gold.assessment.status === "weak_separation"
        ? "Keep current tiers provisional and look for stronger separation before leaning on them heavily."
        : "Confidence ordering looks usable; keep tracking it after deterministic changes."
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
