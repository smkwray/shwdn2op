import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BattleSnapshot, PokemonSnapshot } from "../apps/companion/src/types.js";

function makePokemon(overrides: Partial<PokemonSnapshot> = {}): PokemonSnapshot {
  return {
    ident: "p1a: Testmon",
    species: "Scizor",
    displayName: "Scizor",
    level: 100,
    conditionText: "100/100",
    hpPercent: 100,
    status: null,
    fainted: false,
    active: false,
    revealed: true,
    boosts: {},
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    knownMoves: [],
    item: null,
    removedItem: null,
    ability: null,
    types: ["Bug", "Steel"],
    teraType: null,
    terastallized: false,
    ...overrides
  } as PokemonSnapshot;
}

function makeSnapshot(overrides: Partial<BattleSnapshot> = {}): BattleSnapshot {
  const yourActive = makePokemon({
    ident: "p1a: Scizor",
    species: "Scizor",
    displayName: "Scizor",
    active: true,
    knownMoves: ["Bullet Punch", "U-turn", "Swords Dance", "Roost"],
    item: "Choice Band",
    ability: "Technician",
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
  });
  const yourSwitch = makePokemon({
    ident: "p1b: Weavile",
    species: "Weavile",
    displayName: "Weavile",
    stats: { hp: 281, atk: 339, def: 166, spa: 126, spd: 206, spe: 383 }
  });
  const opponentActive = makePokemon({
    ident: "p2a: Noivern",
    species: "Noivern",
    displayName: "Noivern",
    active: true,
    stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
    types: ["Flying", "Dragon"]
  });

  return {
    version: "0.1.0",
    capturedAt: "2026-03-30T00:00:00.000Z",
    roomId: "battle-frozen-suite",
    title: "Frozen Snapshot Suite",
    format: "[Gen 9] UU",
    turn: 5,
    phase: "turn",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourActive,
      team: [yourActive, yourSwitch]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentActive,
      team: [opponentActive]
    },
    field: {
      weather: null,
      terrain: null,
      pseudoWeather: [],
      yourSideConditions: [],
      opponentSideConditions: []
    },
    legalActions: [
      { id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" },
      { id: "move:uturn", kind: "move", label: "U-turn", moveName: "U-turn" }
    ],
    recentLog: [],
    rawRequestSummary: {},
    notes: [],
    ...overrides
  } as BattleSnapshot;
}

type FrozenCaseResult = {
  id: string;
  area: "prompting" | "opponent_prediction" | "self_recommendation";
  ok: boolean;
  summary: string;
  details: Record<string, unknown>;
};

async function main() {
  const outputPath = process.argv[2] ?? "ml-artifacts/frozen-snapshot-eval.json";
  const tempStorePath = path.join(os.tmpdir(), `shwdn2op-frozen-local-${process.pid}-${Date.now()}.json`);
  const tempCuratedPath = path.join(os.tmpdir(), `shwdn2op-frozen-curated-${process.pid}-${Date.now()}.json`);
  process.env.LOCAL_INTEL_STORE_PATH = tempStorePath;
  process.env.EXTERNAL_CURATED_STORE_PATH = tempCuratedPath;

  const [{ buildAnalysisPrompt }, { buildLocalIntelSnapshot }, { buildDamagePreview, buildThreatPreview }, { buildSelfActionRecommendation }] = await Promise.all([
    import("../apps/companion/src/prompting/analysisPrompt.js"),
    import("../apps/companion/src/history/opponentIntelStore.js"),
    import("../apps/companion/src/prompting/damageNotes.js"),
    import("../apps/companion/src/prediction/selfActionRecommender.js")
  ]);

  const results: FrozenCaseResult[] = [];

  const staleSnapshot = makeSnapshot({
    roomId: "battle-frozen-strategic-stale",
    legalActions: [{ id: "move:uturn", kind: "move", label: "U-turn", moveName: "U-turn" }]
  });
  const stalePrompt = buildAnalysisPrompt(staleSnapshot, {
    analysisMode: "strategic",
    includeToolHint: false,
    requestContext: {
      tabStatus: "stale_snapshot",
      actionableNow: false,
      snapshotAgeMs: 42_000,
      wait: false,
      forceSwitch: false,
      teamPreview: false
    }
  });
  const staleOk = /Tab status stale_snapshot; actionable now no\./.test(stalePrompt)
    && /Only rank current legal actions when requestContext\.actionableNow is true\./.test(stalePrompt)
    && /Treat stale or waiting snapshots as planning context, not as permission to recommend an immediate click\./.test(stalePrompt);
  results.push({
    id: "strategic_stale_context",
    area: "prompting",
    ok: staleOk,
    summary: staleOk
      ? "Strategic prompt keeps stale snapshots in planning-only mode."
      : "Strategic stale-snapshot prompt contract regressed.",
    details: {
      tabStatus: "stale_snapshot",
      actionableNow: false
    }
  });

  const yourJolteon = makePokemon({
    ident: "p1a: Jolteon-preview-switch",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });
  const opponentGyarados = makePokemon({
    ident: "p2a: Gyarados-preview-switch",
    species: "Gyarados",
    displayName: "Gyarados",
    active: true,
    knownMoves: ["Waterfall"],
    hpPercent: 88,
    stats: { hp: 331, atk: 349, def: 194, spa: 156, spd: 236, spe: 287 },
    types: ["Water", "Flying"]
  });
  const gastrodon = makePokemon({
    ident: "p2b: Gastrodon-preview-switch",
    species: "Gastrodon",
    displayName: "Gastrodon",
    active: false,
    revealed: false,
    knownMoves: [],
    stats: { hp: 426, atk: 185, def: 251, spa: 203, spd: 251, spe: 107 },
    types: ["Water", "Ground"]
  });
  const previewSwitchSnapshot = makeSnapshot({
    roomId: "battle-frozen-preview-switch",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourJolteon,
      team: [yourJolteon]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGyarados,
      team: [opponentGyarados, gastrodon]
    },
    legalActions: [{ id: "move:thunderbolt", kind: "move", label: "Thunderbolt", moveName: "Thunderbolt" }]
  });
  const previewSwitchIntel = await buildLocalIntelSnapshot(previewSwitchSnapshot);
  const gastrodonSwitch = previewSwitchIntel.opponentActionPrediction?.topActions.find(
    (candidate) => candidate.switchTargetSpecies === "Gastrodon"
  );
  const previewSwitchOk = previewSwitchIntel.opponentActionPrediction?.topActionClass === "switch"
    && gastrodonSwitch?.source === "previewed_switch";
  results.push({
    id: "preview_known_hidden_switch_in",
    area: "opponent_prediction",
    ok: previewSwitchOk,
    summary: previewSwitchOk
      ? "Opponent predictor still considers preview-known unrevealed absorbers."
      : "Preview-known hidden switch-in support regressed.",
    details: {
      topActionClass: previewSwitchIntel.opponentActionPrediction?.topActionClass ?? null,
      switchTargetSpecies: gastrodonSwitch?.switchTargetSpecies ?? null,
      source: gastrodonSwitch?.source ?? null
    }
  });

  const yourGreatTusk = makePokemon({
    ident: "p1a: Great Tusk-fourth-reply",
    species: "Great Tusk",
    displayName: "Great Tusk",
    active: true,
    hpPercent: 100,
    knownMoves: ["Headlong Rush", "Stealth Rock"],
    stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
    types: ["Ground", "Fighting"]
  });
  const opponentGholdengo = makePokemon({
    ident: "p2a: Gholdengo-fourth-reply",
    species: "Gholdengo",
    displayName: "Gholdengo",
    active: true,
    hpPercent: 64,
    knownMoves: ["Make It Rain", "Shadow Ball"],
    stats: { hp: 304, atk: 176, def: 226, spa: 389, spd: 236, spe: 276 },
    types: ["Steel", "Ghost"]
  });
  const opponentDragonite = makePokemon({
    ident: "p2b: Dragonite-fourth-reply",
    species: "Dragonite",
    displayName: "Dragonite",
    hpPercent: 100,
    knownMoves: ["Extreme Speed"],
    stats: { hp: 386, atk: 403, def: 226, spa: 236, spd: 236, spe: 259 },
    types: ["Dragon", "Flying"]
  });
  const fourthReplySnapshot = makeSnapshot({
    roomId: "battle-frozen-fourth-reply",
    turn: 4,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourGreatTusk,
      team: [yourGreatTusk]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGholdengo,
      team: [opponentGholdengo, opponentDragonite]
    },
    legalActions: [
      { id: "move:headlongrush", kind: "move", label: "Headlong Rush", moveName: "Headlong Rush" },
      { id: "move:stealthrock", kind: "move", label: "Stealth Rock", moveName: "Stealth Rock" }
    ]
  });
  const playerDamagePreview = buildDamagePreview(fourthReplySnapshot);
  const opponentThreatPreview = buildThreatPreview(fourthReplySnapshot, {
    moveCandidates: [
      { name: "Make It Rain", source: "known" },
      { name: "Shadow Ball", source: "known" }
    ]
  });
  const basePrediction = {
    topActionClass: "stay_attack" as const,
    confidenceTier: "medium" as const,
    reasons: [],
    riskFlags: [],
    topActions: [
      { type: "known_move" as const, actionClass: "stay_attack" as const, label: "Make It Rain", moveName: "Make It Rain", score: 100, reasons: [], riskFlags: [] },
      { type: "known_move" as const, actionClass: "stay_attack" as const, label: "Shadow Ball", moveName: "Shadow Ball", score: 94, reasons: [], riskFlags: [] },
      { type: "known_status_or_setup" as const, actionClass: "status_or_setup" as const, label: "Nasty Plot", moveName: "Nasty Plot", score: 90, reasons: [], riskFlags: [] }
    ]
  };
  const withoutFourthReply = buildSelfActionRecommendation({
    snapshot: fourthReplySnapshot,
    playerDamagePreview,
    opponentThreatPreview,
    opponentActionPrediction: basePrediction
  });
  const withFourthReply = buildSelfActionRecommendation({
    snapshot: fourthReplySnapshot,
    playerDamagePreview,
    opponentThreatPreview,
    opponentActionPrediction: {
      ...basePrediction,
      topActions: [
        ...basePrediction.topActions,
        { type: "likely_switch" as const, actionClass: "switch" as const, label: "Switch Dragonite", switchTargetSpecies: "Dragonite", source: "revealed_switch" as const, score: 86, reasons: [], riskFlags: [] }
      ]
    }
  });
  const noFourthSearch = withoutFourthReply?.rankedActions.find((candidate) => candidate.actionId === "move:headlongrush")?.scoreBreakdown
    ?.find((entry) => entry.key === "search")?.value ?? 0;
  const withFourthSearch = withFourthReply?.rankedActions.find((candidate) => candidate.actionId === "move:headlongrush")?.scoreBreakdown
    ?.find((entry) => entry.key === "search")?.value ?? 0;
  const fourthReplyOk = withFourthSearch < noFourthSearch;
  results.push({
    id: "weighted_fourth_reply_search",
    area: "self_recommendation",
    ok: fourthReplyOk,
    summary: fourthReplyOk
      ? "Self recommender still widens search when a weighted fourth reply matters."
      : "Weighted fourth-reply search effect regressed.",
    details: {
      noFourthSearch,
      withFourthSearch
    }
  });

  const yourToxapex = makePokemon({
    ident: "p1a: Toxapex-switch-collision",
    species: "Toxapex",
    displayName: "Toxapex",
    active: true,
    hpPercent: 44,
    knownMoves: ["Surf"],
    stats: { hp: 304, atk: 146, def: 443, spa: 166, spd: 343, spe: 106 },
    types: ["Water", "Poison"]
  });
  const taurosCombatNicknamedBlaze = makePokemon({
    ident: "p1b: Tauros-Paldea-Blaze",
    species: "Tauros-Paldea-Combat",
    displayName: "Tauros-Paldea-Blaze",
    hpPercent: 100,
    stats: { hp: 291, atk: 319, def: 216, spa: 156, spd: 176, spe: 350 },
    types: ["Fighting"]
  });
  const taurosBlaze = makePokemon({
    ident: "p1c: Tauros-Paldea-Blaze-actual",
    species: "Tauros-Paldea-Blaze",
    displayName: "Tauros-Paldea-Blaze",
    hpPercent: 100,
    stats: { hp: 291, atk: 319, def: 216, spa: 156, spd: 176, spe: 350 },
    types: ["Fighting", "Fire"]
  });
  const opponentJolteon = makePokemon({
    ident: "p2a: Jolteon-switch-collision",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });
  const switchCollisionSnapshot = makeSnapshot({
    roomId: "battle-frozen-switch-collision",
    turn: 8,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourToxapex,
      team: [yourToxapex, taurosCombatNicknamedBlaze, taurosBlaze]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentJolteon,
      team: [opponentJolteon]
    },
    legalActions: [
      { id: "move:surf", kind: "move", label: "Surf", moveName: "Surf" },
      {
        id: "switch:taurospaldeablaze",
        kind: "switch",
        label: "Switch to Tauros-Paldea-Blaze",
        target: "Tauros-Paldea-Blaze"
      }
    ]
  });
  const switchCollisionIntel = await buildLocalIntelSnapshot(switchCollisionSnapshot);
  const switchCollisionCandidate = switchCollisionIntel.selfActionRecommendation?.rankedActions.find(
    (candidate) => candidate.actionId === "switch:taurospaldeablaze"
  );
  const switchCollisionOk = switchCollisionCandidate?.switchTargetSpecies === "Tauros-Paldea-Blaze";
  results.push({
    id: "switch_label_collision",
    area: "self_recommendation",
    ok: switchCollisionOk,
    summary: switchCollisionOk
      ? "Switch label resolution still prefers the intended species over nickname collisions."
      : "Switch label resolution regressed on nickname/species collisions.",
    details: {
      switchTargetSpecies: switchCollisionCandidate?.switchTargetSpecies ?? null
    }
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    outputPath: path.resolve(outputPath),
    caseCount: results.length,
    passed: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    results
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));

  await fs.rm(tempStorePath, { force: true });
  await fs.rm(tempCuratedPath, { force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
