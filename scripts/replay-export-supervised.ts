import fs from "node:fs/promises";
import path from "node:path";

import type { ReplayPolicyExample } from "../apps/companion/src/ml/replayPolicyExample.js";
import type { SupervisedDecisionRow } from "../apps/companion/src/ml/supervisedDecisionRow.js";
import { DEFAULT_REPLAY_OUTPUT, readJsonl, writeJsonl } from "./replay-common.js";

function summarizeLastMon(team: ReplayPolicyExample["snapshot"]["yourSide"]["team"]) {
  return team.filter((pokemon) => !pokemon.fainted).length <= 1;
}

function topScoreGap(example: ReplayPolicyExample) {
  const ranked = [...(example.candidateFeatures ?? [])].sort((a, b) => (b.deterministicScore ?? 0) - (a.deterministicScore ?? 0));
  if (ranked.length < 2) return null;
  return Number((((ranked[0]?.deterministicScore ?? 0) - (ranked[1]?.deterministicScore ?? 0))).toFixed(1));
}

function deterministicRank(example: ReplayPolicyExample) {
  const ranked = [...(example.candidateFeatures ?? [])].sort((a, b) => (b.deterministicScore ?? 0) - (a.deterministicScore ?? 0));
  const rank = ranked.findIndex((candidate) => candidate.actionId === example.label.actionId);
  return rank >= 0 ? rank + 1 : null;
}

function topDeterministicActionId(example: ReplayPolicyExample) {
  return [...(example.candidateFeatures ?? [])]
    .sort((a, b) => (b.deterministicScore ?? 0) - (a.deterministicScore ?? 0))[0]?.actionId ?? null;
}

function toRow(example: ReplayPolicyExample): SupervisedDecisionRow {
  return {
    schemaVersion: "supervised-decision-row@0.1",
    exampleId: example.exampleId,
    splitTag: example.splitTag,
    source: {
      replayFile: example.source.replayFile,
      replayKind: example.source.replayKind,
      format: example.source.format,
      roomId: example.source.roomId,
      turn: example.source.turn,
      actingSide: example.source.actingSide,
      didActingSideWin: example.source.didActingSideWin ?? null
    },
    context: {
      phase: example.snapshot.phase,
      legalActionCount: example.snapshot.legalActions.length,
      weather: example.snapshot.field.weather,
      terrain: example.snapshot.field.terrain,
      pseudoWeather: [...example.snapshot.field.pseudoWeather],
      yourSideConditions: [...example.snapshot.field.yourSideConditions],
      opponentSideConditions: [...example.snapshot.field.opponentSideConditions],
      lastMonYourSide: summarizeLastMon(example.snapshot.yourSide.team),
      lastMonOpponentSide: summarizeLastMon(example.snapshot.opponentSide.team)
    },
    player: {
      activeSpecies: example.snapshot.yourSide.active?.species ?? example.snapshot.yourSide.active?.displayName ?? null,
      activeHpPercent: example.snapshot.yourSide.active?.hpPercent ?? null,
      activeStatus: example.snapshot.yourSide.active?.status ?? null,
      activeTypes: example.snapshot.yourSide.active?.types ?? [],
      activeBoosts: example.snapshot.yourSide.active?.boosts ?? {},
      activeKnownMoves: example.snapshot.yourSide.active?.knownMoves ?? [],
      reserveSpecies: example.snapshot.yourSide.team
        .filter((pokemon) => !pokemon.active && !pokemon.fainted)
        .map((pokemon) => pokemon.species ?? pokemon.displayName ?? "Unknown")
    },
    opponent: {
      activeSpecies: example.snapshot.opponentSide.active?.species ?? example.snapshot.opponentSide.active?.displayName ?? null,
      activeHpPercent: example.snapshot.opponentSide.active?.hpPercent ?? null,
      activeStatus: example.snapshot.opponentSide.active?.status ?? null,
      activeTypes: example.snapshot.opponentSide.active?.types ?? [],
      activeKnownMoves: example.snapshot.opponentSide.active?.knownMoves ?? [],
      reserveSpecies: example.snapshot.opponentSide.team
        .filter((pokemon) => !pokemon.active && !pokemon.fainted)
        .map((pokemon) => pokemon.species ?? pokemon.displayName ?? "Unknown"),
      unrevealedReserveCount: example.snapshot.opponentSide.team.filter((pokemon) => !pokemon.active && !pokemon.fainted && !pokemon.revealed).length
    },
    observation: example.observation,
    deterministic: example.deterministic,
    candidates: example.candidateFeatures,
    label: {
      ...example.label,
      deterministicRank: deterministicRank(example),
      topDeterministicActionId: topDeterministicActionId(example),
      topDeterministicScoreGap: topScoreGap(example)
    },
    notes: example.notes
  };
}

async function main() {
  const inputPath = process.argv[2] ?? DEFAULT_REPLAY_OUTPUT;
  const outputPath = process.argv[3] ?? inputPath.replace(/\.jsonl$/i, ".supervised.jsonl");
  const rows = await readJsonl<ReplayPolicyExample>(inputPath);
  const exported = rows.map(toRow);

  await writeJsonl(outputPath, exported);

  const summary = {
    generatedAt: new Date().toISOString(),
    inputPath: path.resolve(inputPath),
    outputPath: path.resolve(outputPath),
    rowCount: exported.length,
    splitCounts: Object.fromEntries(
      [...exported.reduce((map, row) => {
        map.set(row.splitTag, (map.get(row.splitTag) ?? 0) + 1);
        return map;
      }, new Map<string, number>()).entries()].sort((a, b) => a[0].localeCompare(b[0]))
    ),
    formats: Object.fromEntries(
      [...exported.reduce((map, row) => {
        map.set(row.source.format, (map.get(row.source.format) ?? 0) + 1);
        return map;
      }, new Map<string, number>()).entries()].sort((a, b) => a[0].localeCompare(b[0]))
    ),
    notes: [
      "These rows are the stable supervised-learning export for later ranking or classification work.",
      "They keep raw replay labels plus deterministic summaries and candidate features in one schema.",
      "Battle-level split tags are assigned upstream during replay extraction and should stay stable for the same roomId."
    ]
  };

  const summaryPath = outputPath.replace(/\.jsonl$/i, ".summary.json");
  await fs.mkdir(path.dirname(path.resolve(summaryPath)), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
