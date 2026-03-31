import fs from "node:fs/promises";
import path from "node:path";

type LedgerEntry = {
  schemaVersion: string;
  recordedAt: string;
  label: string;
  git?: {
    branch?: string | null;
    commit?: string | null;
    dirty?: boolean | null;
  } | undefined;
  metrics?: {
    overall?: {
      top1Accuracy?: number | null;
      top3Accuracy?: number | null;
      meanReciprocalRank?: number | null;
      confidence?: {
        highUnderperformsMedium?: boolean | null;
      } | undefined;
    } | null | undefined;
    goldHoldout?: {
      top1Accuracy?: number | null;
      top3Accuracy?: number | null;
      meanReciprocalRank?: number | null;
      confidence?: {
        highUnderperformsMedium?: boolean | null;
      } | undefined;
    } | null | undefined;
  } | undefined;
  buckets?: {
    counts?: Record<string, number> | undefined;
    readiness?: Record<string, { status?: string | null; crossReplayCoverageShare?: number | null }> | undefined;
    stablePatternCounts?: Record<string, number> | undefined;
  } | undefined;
  plateauSignals?: {
    confidenceNeedsCalibration?: boolean | null;
    hiddenSwitchReadiness?: string | null;
    setupHazardReadiness?: string | null;
    frozenSnapshotPassing?: boolean | null;
  } | undefined;
};

function diffNumber(current: number | null | undefined, previous: number | null | undefined) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return Number((Number(current) - Number(previous)).toFixed(3));
}

function compareDirection(delta: number | null, invert = false) {
  if (delta === null) return "unknown";
  if (delta === 0) return "flat";
  if (invert) return delta < 0 ? "better" : "worse";
  return delta > 0 ? "better" : "worse";
}

async function readLedger(filePath: string): Promise<LedgerEntry[]> {
  const text = await fs.readFile(path.resolve(filePath), "utf8");
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

async function main() {
  const ledgerPath = process.argv[2] ?? "ml-artifacts/experiment-ledger.jsonl";
  const outputPath = process.argv[3] ?? path.resolve(path.dirname(ledgerPath), "experiment-ledger.compare.json");
  const entries = await readLedger(ledgerPath);
  const current = entries.at(-1) ?? null;
  const previous = entries.at(-2) ?? null;

  if (!current) {
    throw new Error(`No ledger entries found in ${path.resolve(ledgerPath)}`);
  }

  const comparison = previous
    ? {
        generatedAt: new Date().toISOString(),
        ledgerPath: path.resolve(ledgerPath),
        previous: {
          label: previous.label,
          recordedAt: previous.recordedAt,
          commit: previous.git?.commit ?? null
        },
        current: {
          label: current.label,
          recordedAt: current.recordedAt,
          commit: current.git?.commit ?? null
        },
        deltas: {
          goldTop1: {
            delta: diffNumber(current.metrics?.goldHoldout?.top1Accuracy, previous.metrics?.goldHoldout?.top1Accuracy),
            direction: compareDirection(diffNumber(current.metrics?.goldHoldout?.top1Accuracy, previous.metrics?.goldHoldout?.top1Accuracy))
          },
          goldTop3: {
            delta: diffNumber(current.metrics?.goldHoldout?.top3Accuracy, previous.metrics?.goldHoldout?.top3Accuracy),
            direction: compareDirection(diffNumber(current.metrics?.goldHoldout?.top3Accuracy, previous.metrics?.goldHoldout?.top3Accuracy))
          },
          goldMrr: {
            delta: diffNumber(current.metrics?.goldHoldout?.meanReciprocalRank, previous.metrics?.goldHoldout?.meanReciprocalRank),
            direction: compareDirection(diffNumber(current.metrics?.goldHoldout?.meanReciprocalRank, previous.metrics?.goldHoldout?.meanReciprocalRank))
          },
          hiddenSwitchMisses: {
            delta: diffNumber(current.buckets?.counts?.hidden_switch, previous.buckets?.counts?.hidden_switch),
            direction: compareDirection(diffNumber(current.buckets?.counts?.hidden_switch, previous.buckets?.counts?.hidden_switch), true)
          },
          setupHazardMisses: {
            delta: diffNumber(current.buckets?.counts?.setup_hazard, previous.buckets?.counts?.setup_hazard),
            direction: compareDirection(diffNumber(current.buckets?.counts?.setup_hazard, previous.buckets?.counts?.setup_hazard), true)
          },
          hiddenSwitchStablePatterns: {
            delta: diffNumber(current.buckets?.stablePatternCounts?.hidden_switch, previous.buckets?.stablePatternCounts?.hidden_switch),
            direction: compareDirection(diffNumber(current.buckets?.stablePatternCounts?.hidden_switch, previous.buckets?.stablePatternCounts?.hidden_switch), true)
          }
        },
        statusChanges: {
          confidenceNeedsCalibration: {
            previous: previous.plateauSignals?.confidenceNeedsCalibration ?? null,
            current: current.plateauSignals?.confidenceNeedsCalibration ?? null
          },
          hiddenSwitchReadiness: {
            previous: previous.plateauSignals?.hiddenSwitchReadiness ?? null,
            current: current.plateauSignals?.hiddenSwitchReadiness ?? null
          },
          setupHazardReadiness: {
            previous: previous.plateauSignals?.setupHazardReadiness ?? null,
            current: current.plateauSignals?.setupHazardReadiness ?? null
          },
          frozenSnapshotPassing: {
            previous: previous.plateauSignals?.frozenSnapshotPassing ?? null,
            current: current.plateauSignals?.frozenSnapshotPassing ?? null
          }
        },
        summary: [
          `gold top-1 ${compareDirection(diffNumber(current.metrics?.goldHoldout?.top1Accuracy, previous.metrics?.goldHoldout?.top1Accuracy))}`,
          `gold top-3 ${compareDirection(diffNumber(current.metrics?.goldHoldout?.top3Accuracy, previous.metrics?.goldHoldout?.top3Accuracy))}`,
          `hidden_switch ${compareDirection(diffNumber(current.buckets?.counts?.hidden_switch, previous.buckets?.counts?.hidden_switch), true)}`,
          `setup_hazard ${compareDirection(diffNumber(current.buckets?.counts?.setup_hazard, previous.buckets?.counts?.setup_hazard), true)}`
        ]
      }
    : {
        generatedAt: new Date().toISOString(),
        ledgerPath: path.resolve(ledgerPath),
        current: {
          label: current.label,
          recordedAt: current.recordedAt,
          commit: current.git?.commit ?? null
        },
        message: "Only one experiment entry exists. Record at least one more ledger entry before comparing deltas.",
        baseline: {
          goldTop1: current.metrics?.goldHoldout?.top1Accuracy ?? null,
          goldTop3: current.metrics?.goldHoldout?.top3Accuracy ?? null,
          hiddenSwitchMisses: current.buckets?.counts?.hidden_switch ?? null,
          setupHazardMisses: current.buckets?.counts?.setup_hazard ?? null,
          confidenceNeedsCalibration: current.plateauSignals?.confidenceNeedsCalibration ?? null
        }
      };

  const absoluteOutputPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  await fs.writeFile(absoluteOutputPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(comparison, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
