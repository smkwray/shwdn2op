// Replays live journals (default: every .local-data/metamon-live/*.jsonl) through the production decision path and reports
// every belief that failed to follow an observed fact (apps/companion/src/tools/beliefInvariants.ts lists the invariants).
// Usage: node --import tsx scripts/belief-invariants.ts [--priors DESCRIPTOR.json] [--json] [JOURNAL.jsonl ...]
// It reads the journals only; history is an empty in-memory store, never the owner's.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "belief-invariants-"));
process.env.LOCAL_INTEL_STORE_PATH = path.join(scratch, "history.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(scratch, "curated.json");
const { checkBattleBeliefs } = await import("../apps/companion/src/tools/beliefInvariants.js");
const { loadMetaMovePriorDescriptor } = await import("../apps/companion/src/history/metaPriorStore.js");

const args = process.argv.slice(2);
const json = args.includes("--json");
const priorsAt = args.indexOf("--priors");
const movePriors = priorsAt >= 0 ? await loadMetaMovePriorDescriptor(path.resolve(args[priorsAt + 1]!), root) : undefined;
const named = args.filter((arg, index) => !arg.startsWith("--") && index !== priorsAt + 1);
const directory = path.join(root, ".local-data/metamon-live");
const journals = named.length ? named : (await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(directory, name));

const totals: Record<string, number> = {};
let decisions = 0, violations = 0, failed = 0;
for (const journal of journals) {
  const rows = (await fs.readFile(journal, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const frames = rows.filter((row) => row.kind === "frame").map((row) => String(row.data));
  const roomId = rows.find((row) => row.roomId)?.roomId;
  if (!roomId || !frames.length) continue;
  try {
    const report = await checkBattleBeliefs(frames, roomId, { movePriors });
    decisions += report.decisions; violations += report.violations.length;
    for (const [name, count] of Object.entries(report.checks)) totals[name] = (totals[name] ?? 0) + count;
    if (json) console.log(JSON.stringify({ journal: path.basename(journal), ...report }));
    else {
      console.log(`${path.basename(journal)}: ${report.decisions} decisions, ${report.violations.length} violations`);
      for (const violation of report.violations) console.log(`  ${violation.invariant} T${violation.turn} rq${violation.rqid} ${violation.subject}: ${violation.detail}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`${path.basename(journal)}: replay FAILED ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`TOTAL ${journals.length} journals (${failed} failed to replay), ${decisions} decisions, ${violations} violations; checks ${JSON.stringify(totals)}`);
await fs.rm(scratch, { recursive: true, force: true });
process.exitCode = violations || failed ? 1 : 0;
