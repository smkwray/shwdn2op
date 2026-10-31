import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BattleSnapshot, LocalIntelSnapshot } from "../types.js";
import { snapshotForAction } from "../mechanics/actions.js";
import { buildDamagePreview, buildThreatPreview } from "../prompting/damageNotes.js";
import { buildSelfActionRecommendation } from "../prediction/selfActionRecommender.js";
const { applyRawFrameToRoomMap, roomToSnapshot } = await import(new URL("../../../extension/lib/showdown-parser.js", import.meta.url).href);
const { extractReplayExamples } = await import(new URL("../../../../scripts/replay-common.ts", import.meta.url).href);
const { evaluateRows } = await import(new URL("../../../../scripts/replay-eval.ts", import.meta.url).href);

test("JSONL tools round-trip Unicode and preserve the last complete file on serialization failure", async () => {
  const { writeJsonl, readJsonl } = await import(new URL("../../../../scripts/replay-common.ts", import.meta.url).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "showdown-jsonl-"));
  const output = path.join(directory, "rows.jsonl");
  try {
    const rows = [{ value: "Pokémon\nquoted \"value\"" }, { value: 2 }];
    await writeJsonl(output, rows);
    assert.deepEqual(await readJsonl(output), rows);
    await assert.rejects(writeJsonl(output, [{ value: 3 }, { value: 1n }]), /BigInt/);
    assert.deepEqual(await readJsonl(output), rows);
    assert.deepEqual(await fs.readdir(directory), ["rows.jsonl"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

function snapshot(teraType = "Ice"): BattleSnapshot {
  const rooms = new Map();
  const side = { id: "p1", name: "You", pokemon: [
    { ident: "p1: Mamoswine", details: "Mamoswine, L100", condition: "200/341", active: true,
      stats: { atk: 359, def: 196, spa: 158, spd: 157, spe: 284 }, ability: "Thick Fat", teraType }
  ] };
  applyRawFrameToRoomMap(rooms, `>battle-gen9uu-actions\n${[
    "|init|battle", "|tier|[Gen 9] UU", "|player|p1|You", "|player|p2|Them", "|poke|p1|Mamoswine, L100", "|poke|p2|Donphan, L100",
    "|switch|p1a: Mamoswine|Mamoswine, L100|200/341", "|switch|p2a: Infernape|Infernape, L100|100/100", "|turn|7",
    `|request|${JSON.stringify({ rqid: 47, side, active: [{ canTerastallize: teraType, moves: [
      { move: "Earthquake", id: "earthquake", pp: 16 }, { move: "Ice Shard", id: "iceshard", pp: 48 },
      { move: "Knock Off", id: "knockoff", pp: 32 }, { move: "Icicle Crash", id: "iciclecrash", pp: 16 }
    ] }] })}`
  ].join("\n")}`);
  return roomToSnapshot(rooms.get("battle-gen9uu-actions")) as BattleSnapshot;
}

test("four move slots produce eight distinct Tera choices and full damage previews", () => {
  const state = snapshot();
  assert.equal(state.yourSide.active!.stats?.hp, 341, "private condition supplies exact maximum HP absent from request.stats");
  assert.equal(state.opponentSide.active!.stats?.hp, undefined, "public percentage denominator is not maximum HP");
  assert.equal(new Set(state.legalActions.map((action) => action.id)).size, 8);
  assert.equal(buildDamagePreview(state).length, 8);
  const previews = buildDamagePreview(state);
  const base = previews.find((entry) => entry.actionId === "move:2|tera=0")!;
  const tera = previews.find((entry) => entry.actionId === "move:2|tera=1")!;
  assert.ok(tera.bands[0]!.minPercent! > base.bands[0]!.minPercent!);
  assert.equal(state.yourSide.active!.terastallized, false);
  const projected = snapshotForAction(state, state.legalActions[1]!);
  assert.equal(projected.yourSide.active!.terastallized, true);
  assert.equal(projected.yourSide.team[0]!.terastallized, true);
  assert.throws(() => snapshotForAction({ ...state, yourSide: { ...state.yourSide, active: { ...state.yourSide.active!, teraType: null } } }, state.legalActions[1]!), /known Tera type/);
});

test("ordinary observed damage cannot overwrite a hypothetical Tera band", () => {
  const previews = buildDamagePreview(snapshot(), {
    observedPlayerDamage: { "Ice Shard|Mamoswine": { minPercent: 1, maxPercent: 2, sampleCount: 5, source: "aggregate" } }
  });
  const base = previews.find((entry) => entry.actionId === "move:2|tera=0")!;
  const tera = previews.find((entry) => entry.actionId === "move:2|tera=1")!;
  assert.equal(base.likelyBandSource, "aggregate");
  assert.equal(tera.likelyBandSource, "calc");
  assert.equal(tera.observedRange, undefined);
});

test("Tera recommendation and reply search use the projected defensive typing", () => {
  const state = snapshot("Ghost");
  const options = { moveCandidates: [{ name: "Close Combat", source: "known" as const }] };
  const threats = buildThreatPreview(state, options);
  const teraThreat = buildThreatPreview(snapshotForAction(state, state.legalActions[1]!), options);
  assert.equal(teraThreat[0]!.currentTarget.bands[0]!.outcome, "immune");
  assert.ok(threats[0]!.currentTarget.bands[0]!.maxPercent! > 0);
  const recommendation = buildSelfActionRecommendation({
    snapshot: state, playerDamagePreview: buildDamagePreview(state), opponentThreatPreview: threats,
    speedPreview: { opponentSpecies: "Infernape", activeRelation: "slower", evidence: [], confounders: [], switchMatchups: [], historyNotes: [] },
    opponentActionPrediction: { topActionClass: "stay_attack", confidenceTier: "high", topActions: [
      { type: "known_move", actionClass: "stay_attack", label: "Close Combat", moveName: "Close Combat", score: 100, reasons: [], riskFlags: [] }
    ], reasons: [], riskFlags: [] }
  })!;
  const ordinary = recommendation.rankedActions.find((entry) => entry.actionId === "move:1|tera=0")!;
  const tera = recommendation.rankedActions.find((entry) => entry.actionId === "move:1|tera=1")!;
  assert.ok(tera.score > ordinary.score, JSON.stringify({ ordinary, tera }));
  assert.ok(tera.riskFlags.some((risk) => risk.includes("once-per-battle")));
  assert.ok(tera.scoreBreakdown?.some((component) => component.key === "search"));
});

test("replay labels distinguish Tera and restore only the acting side's proven private type", async () => {
  const source = {
    filePath: "constructed.log", replayFile: "constructed.log", replayKind: "log" as const, roomId: "battle-gen9uu-replay-tera",
    lines: [
      "|init|battle", "|tier|[Gen 9] UU", "|player|p1|You", "|player|p2|Them", "|poke|p1|Mamoswine, L100", "|poke|p2|Donphan, L100",
      "|start|", "|switch|p1a: Mamoswine|Mamoswine, L100|100/100", "|switch|p2a: Donphan|Donphan, L100|100/100", "|turn|1",
      "|-terastallize|p1a: Mamoswine|Ice", "|move|p1a: Mamoswine|Ice Shard|p2a: Donphan", "|move|p2a: Donphan|Earthquake|p1a: Mamoswine",
      "|turn|2", "|move|p1a: Mamoswine|Ice Shard|p2a: Donphan", "|move|p2a: Donphan|Earthquake|p1a: Mamoswine", "|win|You"
    ]
  };
  const { examples } = await extractReplayExamples(source, { buildLocalIntelSnapshot: async (state: BattleSnapshot) => ({
    generatedAt: "test", note: "test", opponents: [], selfActionRecommendation: {
      topActionId: state.legalActions[0]?.id ?? null, confidenceTier: "low", reasons: [], riskFlags: [], summary: "test",
      rankedActions: state.legalActions.map((action) => ({ actionId: action.id, kind: action.kind, label: action.label, moveName: action.moveName ?? undefined, score: 1, reasons: [], riskFlags: [] }))
    }
  } satisfies LocalIntelSnapshot) });
  const first = examples.find((example: any) => example.source.turn === 1 && example.source.actingSide === "p1")!;
  const opponent = examples.find((example: any) => example.source.turn === 1 && example.source.actingSide === "p2")!;
  const second = examples.find((example: any) => example.source.turn === 2 && example.source.actingSide === "p1")!;
  assert.equal(first.label.actionId, "move:iceshard|tera=1");
  assert.equal(first.label.terastallize, true);
  assert.equal(first.snapshot.yourSide.active!.teraType, "Ice");
  assert.equal(first.snapshot.yourSide.active!.terastallized, false);
  assert.equal(opponent.snapshot.opponentSide.active!.teraType, null);
  assert.equal(second.label.actionId, "move:iceshard|tera=0");
  assert.equal(second.snapshot.legalActions.some((action: any) => action.terastallize), false);
  assert.ok(first.candidateFeatures.some((candidate: any) => candidate.actionId === first.label.actionId));

  const base = first.candidateFeatures.find((candidate: any) => candidate.actionId === "move:iceshard|tera=0")!;
  const tera = first.candidateFeatures.find((candidate: any) => candidate.actionId === "move:iceshard|tera=1")!;
  const comparison = { ...first, label: { ...first.label, actionId: base.actionId, terastallize: false }, candidateFeatures: [
    { ...tera, deterministicScore: 100 }, { ...base, deterministicScore: 90 }
  ] };
  assert.equal(evaluateRows([comparison]).top1Accuracy, 0, "strict ABI distinguishes Tera from ordinary choice");
  assert.equal(evaluateRows([comparison], true).top1Accuracy, 1, "legacy comparison removes Tera alternatives and projects move names");
});

test("replay extraction withholds unresolved Illusion labels before calling the evaluator", async () => {
  for (const preview of [["|poke|p2|Mamoswine", "|poke|p2|Zoroark-Hisui"], ["|teamsize|p2|6", "|poke|p2|Mamoswine"]]) {
  let evaluations = 0;
  const result = await extractReplayExamples({
    filePath: "ambiguous.log", replayFile: "ambiguous.log", replayKind: "log", roomId: "battle-gen9uu-ambiguous-label",
    lines: ["|init|battle", "|tier|[Gen 9] UU", "|player|p1|You", "|player|p2|Them",
      "|poke|p1|Slowking", ...preview,
      "|start|", "|switch|p1a: Friend|Slowking|100/100", "|switch|p2a: Mammoth|Mamoswine|100/100", "|turn|1",
      "|move|p1a: Friend|Scald|p2a: Mammoth", "|move|p2a: Mammoth|Hyper Voice|p1a: Friend", "|win|You"]
  }, { buildLocalIntelSnapshot: async () => { evaluations++; throw new Error("ambiguous labels must not be evaluated"); } });
  assert.equal(result.examples.length, 0);
  assert.ok(result.withheld.identity_ambiguous >= 1);
  assert.equal(evaluations, 0);
  }
});
