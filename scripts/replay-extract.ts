import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ReplayPolicyExample } from "../apps/companion/src/ml/replayPolicyExample.js";
import {
  DEFAULT_REPLAY_DIR,
  DEFAULT_REPLAY_OUTPUT,
  dedupeExamples,
  extractReplayExamples,
  listReplayFiles,
  readReplaySource,
  writeJsonl
} from "./replay-common.js";

async function main() {
  const inputPath = process.argv[2] ?? DEFAULT_REPLAY_DIR;
  const outputPath = process.argv[3] ?? DEFAULT_REPLAY_OUTPUT;
  const tempStorePath = path.join(os.tmpdir(), `showdnass-replay-extract-${process.pid}-${Date.now()}.json`);
  const tempCuratedPath = path.join(os.tmpdir(), `showdnass-replay-extract-curated-${process.pid}-${Date.now()}.json`);
  process.env.LOCAL_INTEL_STORE_PATH = tempStorePath;
  process.env.EXTERNAL_CURATED_STORE_PATH = tempCuratedPath;

  const { buildLocalIntelSnapshot } = await import("../apps/companion/src/history/opponentIntelStore.js");

  const replayFiles = await listReplayFiles(inputPath);
  const extracted: ReplayPolicyExample[] = [];
  for (const replayFile of replayFiles) {
    const source = await readReplaySource(replayFile);
    const examples = await extractReplayExamples(source, { buildLocalIntelSnapshot });
    extracted.push(...examples);
  }

  const deduped = dedupeExamples(extracted);
  await writeJsonl(outputPath, deduped);

  const summary = {
    generatedAt: new Date().toISOString(),
    inputPath: path.resolve(inputPath),
    outputPath: path.resolve(outputPath),
    replayFileCount: replayFiles.length,
    rawExampleCount: extracted.length,
    dedupedExampleCount: deduped.length,
    formats: Object.fromEntries(
      [...deduped.reduce((map, example) => {
        map.set(example.source.format, (map.get(example.source.format) ?? 0) + 1);
        return map;
      }, new Map<string, number>()).entries()].sort((a, b) => a[0].localeCompare(b[0]))
    ),
    actionKinds: Object.fromEntries(
      [...deduped.reduce((map, example) => {
        map.set(example.label.kind, (map.get(example.label.kind) ?? 0) + 1);
        return map;
      }, new Map<string, number>()).entries()].sort((a, b) => a[0].localeCompare(b[0]))
    ),
    replayKinds: Object.fromEntries(
      [...deduped.reduce((map, example) => {
        map.set(example.source.replayKind, (map.get(example.source.replayKind) ?? 0) + 1);
        return map;
      }, new Map<string, number>()).entries()].sort((a, b) => a[0].localeCompare(b[0]))
    )
  };

  const summaryPath = outputPath.replace(/\.jsonl$/i, ".summary.json");
  await fs.mkdir(path.dirname(path.resolve(summaryPath)), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(summary, null, 2));

  await fs.rm(tempStorePath, { force: true });
  await fs.rm(tempCuratedPath, { force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
