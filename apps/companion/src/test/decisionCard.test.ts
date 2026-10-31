import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ACTION_POLICY_INSTRUCTIONS, buildDecisionCard, hasCardField, HEURISTIC_PRESENTATIONS } from "../battle-agent/decisionCard.js";
import { buildBattlePolicyPrompt, BATTLE_PROMPT_VARIANTS } from "../battle-agent/opencode.js";
import type { BattlePolicyInput } from "../battle-agent/battleAgent.js";
import type { DamagePreview, LegalAction, OpponentIntelEntry, PokemonSnapshot } from "../types.js";

const serialized = (value: unknown) => JSON.parse(JSON.stringify(value));

// Synthetic serialization fixtures only: these numbers are supplied evidence,
// not claims that a calculator, canonical reducer or battle verified mechanics.
function pokemon(instanceId: string): PokemonSnapshot {
  return { instanceId, appearanceId: `${instanceId}-appearance`, identityStatus: "resolved",
    candidateInstanceIds: [instanceId], evidenceRefs: ["fact-current"], canonicalSpecies: "Synthetic",
    appearanceMoves: ["Observed Move"], turnsSinceEntry: 2, ident: null, species: "Synthetic",
    displayName: "Synthetic", level: 100, conditionText: "37/100", hpPercent: 37, status: null,
    fainted: false, active: true, revealed: true, boosts: { atk: 1 }, stats: { spe: 120 },
    knownMoves: ["Observed Move"], item: null, removedItem: "Consumed Item", ability: "Slow Start",
    types: ["Normal"], teraType: null, terastallized: false, paradoxBoostedStat: null,
    unburdenActive: false, slowStartActive: true };
}

function intel(instanceId: string): OpponentIntelEntry {
  return { instanceId, species: "Synthetic", displayName: null, battlesSeen: 3,
    revealedMoves: ["Observed Move"], revealedItem: null, revealedAbility: "Observed Ability",
    revealedTeraType: null, currentTerastallized: false,
    likelyMoves: [{ name: "Unrevealed Guess", count: 0, share: 0.4, sampleCount: 0, confidenceTier: "thin" }],
    likelyItems: [], likelyAbilities: [], likelyTeraTypes: [], speedNotes: ["Speed unresolved"],
    posterior: { confidenceTier: "thin", evidenceKinds: ["priors", "reveals"], usedFallback: true,
      evidence: [{ kind: "reveals", label: "Observed Move", detail: "fact-current" }],
      statBands: [{ stat: "spe", min: 80, likelyLow: 90, likelyHigh: 140, max: 180 }],
      topHypotheses: [0.4, 0.3, 0.2, 0.1].map((weight) => ({ ability: null, item: null, teraType: null,
        statArchetype: "fast_phys", weight, nature: "Synthetic", evs: { spe: 252 },
        effectiveSpeed: null, support: ["prior, not observation"] })) } };
}

function fixture(): BattlePolicyInput {
  const actions: LegalAction[] = [
    { id: "move:1", kind: "move", label: "Move", moveName: "Observed Move", moveSlot: 1, choice: "move 1", legality: "certain" },
    { id: "move:1:tera", kind: "move", label: "Tera Move", moveSlot: 1, terastallize: true, choice: "move 1 terastallize" },
    { id: "switch:2", kind: "switch", label: "Switch", choice: "switch 2", targetInstanceId: "own-reserve" },
    { id: "move:2", kind: "move", label: "Uncertain", legality: "uncertain", choice: "move 2", uncertainLegal: true },
    { id: "special", kind: "special", label: "Special", choice: "special" },
    { id: "move:3", kind: "move", label: "Other", choice: "move 3" },
    { id: "disabled-boolean", kind: "move", label: "Disabled", disabled: true },
    { id: "disabled-legality", kind: "move", label: "Disabled", legality: "disabled" }
  ];
  const preview: DamagePreview = { actionId: "move:1", label: "Move", moveName: "Observed Move", targetName: "Synthetic",
    category: "Special", targetCurrentHpPercent: null,
    bands: [{ label: "unsupported", minPercent: null, maxPercent: null,
      immediate: { ko: "unknown", minHpLossPercent: null, maxHpLossPercent: null, note: "Unsupported entry form" },
      detail: "Unknown HP; do not replace with zero" }],
    summary: "Unqualified", survivalCaveats: [{ kind: "Sturdy", certainty: "historically_possible", note: "Not observed" }],
    interactionHints: [{ label: "Unknown", detail: "Conditional on target position", certainty: "possible" }],
    observedRange: { minPercent: 12, maxPercent: 18, sampleCount: 2, source: "context" }, likelyBandSource: "posterior",
    delayed: { kind: "delayed", delayTurns: 2, phase: "end_of_turn", immediateDamagePercent: 0,
      scheduling: "unknown", dueTurn: null, targetSide: "p2", targetPosition: "a", recipient: "slot_at_impact",
      factIds: ["fact-pending"], bands: [{ label: "eventual", minPercent: null, maxPercent: null,
        immediate: { ko: "unknown", minHpLossPercent: null, maxHpLossPercent: null } }] } };
  return { requestId: "synthetic-request", envelope: { resultHash: "synthetic-result-hash", semantic: {
    contractVersion: "showdown-decision@1", engineVersion: "synthetic-engine", historyRevision: "synthetic-context",
    identity: { roomId: "synthetic-room", rqid: 7, snapshotHash: "synthetic-snapshot", legalActionSetHash: "synthetic-legal", stateRevision: 9, requestKind: "move" },
    capabilities: { status: "degraded", limitations: ["uncalibrated_confidence"], actionable: true, confidenceMeaning: "Not probability" },
    snapshot: { version: "synthetic", roomId: "synthetic-room", title: null, format: "[Gen 9] UU", phase: "turn", turn: 12,
      yourSide: { slot: "p2", name: null, active: pokemon("own-active"), team: [pokemon("own-active"), { ...pokemon("own-reserve"), active: false, fainted: true, hpPercent: 0 }] },
      opponentSide: { slot: "p1", name: null, active: pokemon("opponent-active"), team: [pokemon("opponent-active"), { ...pokemon("opponent-reserve"), active: false, hpPercent: null, identityStatus: "ambiguous", candidateInstanceIds: ["maybe-a", "maybe-b"] }] },
      field: { weather: "Snow", terrain: null, pseudoWeather: ["Trick Room"], yourSideConditions: ["Spikes"], opponentSideConditions: ["Stealth Rock"] },
      legalActions: actions, rawRequestSummary: { forceSwitch: [true], wait: false, capability: "supported" },
      pendingAttacks: [{ moveId: "futuresight", moveName: "Future Sight", sourceSide: "p2", sourceInstanceId: "own-active", sourceAppearanceId: "own-active-appearance", targetSide: "p1", targetPosition: "a", castTurn: 11, dueTurn: 13, phase: "end_of_turn", status: "scheduled", factIds: ["fact-pending", "fact-cast"] }],
      canonicalEvidence: { version: "synthetic-canonical", facts: [], contributions: [], ambiguities: ["reserve ambiguous"], limitations: ["capture limitation"] },
      recentLog: Array.from({ length: 13 }, (_, i) => `stale log ${i}: HP 100, weather clear`), notes: ["Current evidence supplied"] },
    localIntel: { note: "Synthetic evidence", opponents: [intel("opponent-active"), intel("opponent-reserve")],
      playerDamagePreview: [preview], opponentThreatPreview: [{ moveName: "Observed Move", moveSource: "known", targetName: "Synthetic", summary: "Unknown",
        currentTarget: { species: "Synthetic", relation: "unknown", bands: preview.bands, summary: "Unknown", interactionHints: preview.interactionHints, delayed: preview.delayed }, switchTargets: [] }],
      hazardSummary: "Known Spikes", survivalCaveats: ["Unknown coverage"],
      speedPreview: { opponentSpecies: "Synthetic", activeRelation: "unknown", evidence: [{ kind: "capture_gap", label: "Unresolved", factIds: ["fact-current"] }], confounders: ["Slow Start"], switchMatchups: [], historyNotes: [] },
      opponentActionPrediction: { replyTiming: { status: "unknown", summary: "Forced replacement timing unknown", factIds: ["fact-request"] }, topActionClass: "unknown", confidenceTier: "low", reasons: ["Uncalibrated"], riskFlags: [], classScores: { stayAttack: 22, switchOut: 13, statusOrSetup: -1 },
        topActions: [{ type: "known_move", actionClass: "stay_attack", label: "Observed Move", score: 22, reasons: [], riskFlags: [] }],
        topSwitchTargets: [{ type: "likely_switch", actionClass: "switch", label: "Reserve", score: 13, reasons: [], riskFlags: [], switchTargetPlayerPreview: [preview] }] },
      selfActionRecommendation: { topActionId: "disabled-boolean", confidenceTier: "low", summary: "Uncalibrated", reasons: [], riskFlags: [],
        rankedActions: [actions[6]!, ...actions.slice(0, 6), actions[0]!].map((action, i) => ({ actionId: action.id, kind: action.kind, label: action.label, score: 100 - i, reasons: ["Supplied heuristic"], riskFlags: ["Not probability"], scoreBreakdown: [{ key: "synthetic", label: "Supplied", value: 100 - i }] })) }
    }
  } } };
}

test("full threat preview freezes Card and prompt bytes across every variant, heuristic and advice mode", () => {
  // Capture the pre-ablation renderer on a populated Card, including switch
  // damage, delayed attacks and threat prose; null-only fixtures miss leaks.
  const cards = createHash("sha256"), prompts = createHash("sha256");
  for (const heuristics of HEURISTIC_PRESENTATIONS) {
    const value = fixture();
    const hash = `sha256:${"a".repeat(64)}`;
    value.envelope.resultHash = hash;
    value.envelope.semantic.identity.snapshotHash = hash;
    value.envelope.semantic.identity.legalActionSetHash = hash;
    const threat = value.envelope.semantic.localIntel.opponentThreatPreview![0]!;
    threat.switchTargets = [{ ...structuredClone(threat.currentTarget), instanceId: "own-reserve" }];
    for (const candidate of value.envelope.semantic.localIntel.selfActionRecommendation!.rankedActions.filter(c => c.kind === "switch")) {
      candidate.reasons.push("switch target absorbs the likely attack");
      candidate.riskFlags.push("switch target can still be broken immediately");
    }
    const fullCard = JSON.stringify(buildDecisionCard(value, { heuristics, threatPreview: "full" }));
    assert.equal(fullCard, JSON.stringify(buildDecisionCard(value, { heuristics })));
    cards.update(fullCard);
    for (const promptVariant of BATTLE_PROMPT_VARIANTS) for (const mode of [undefined, "suggest", "veto"] as const) {
      if (mode === undefined) delete value.advice;
      else value.advice = { source: "metamon", policyId: "metamon:Kakuna:epoch34", requestId: value.requestId,
        identity: value.envelope.semantic.identity, inputResultHash: value.envelope.resultHash, actionId: "move:1", mode };
      const options = { promptVariant, heuristicPresentation: heuristics };
      const full = buildBattlePolicyPrompt(value, { ...options, threatPreview: "full" }, 1000, 1000);
      assert.equal(full, buildBattlePolicyPrompt(value, options, 1000, 1000));
      prompts.update(full);
    }
  }
  assert.deepEqual({ cards: cards.digest("hex"), prompts: prompts.digest("hex") }, {
    cards: "8dd51c98c4823afc67c128d9944a8d618b6801dd57c89866e8696b79e083408e",
    prompts: "16be27dfe0a60b13d7715162b0e0f02ce75fa1417ea754a8fef4b872fb865188"
  });
});

test("hidden threat preview changes exactly the incoming matrix, switch threat prose and display claim", () => {
  // Compare entire detached objects, not just an absent key: legality, damage,
  // coverage, Speed, scores and unrelated switch advice must survive ablation.
  const input = fixture(), intel = input.envelope.semantic.localIntel;
  const threat = intel.opponentThreatPreview![0]!;
  threat.switchTargets = [{ ...structuredClone(threat.currentTarget), instanceId: "own-reserve" }];
  intel.opponentThreatCoverage = { consideredMoves: [{ name: "Observed Move", source: "known" }],
    omittedMoves: [], uncomputedMoves: [], unrevealedSlots: 3, note: "Missing rows do not establish safety." };
  const candidate = intel.selfActionRecommendation!.rankedActions.find(c => c.kind === "switch")!;
  candidate.reasons = ["switch target absorbs the likely attack", "Among considered move forecasts: safer than staying",
    "safer than the obvious stay line", "immunity in the conditional matchup", "obvious immunity on the likely line",
    "favorable conditional defensive matchup", "limits the conditional damage forecast", "switch target limits the likely damage",
    "covers hidden threat range", "lines up well into their top attacking move",
    "entry hazards tax this switch", "faster after switching", "preserves a still-useful active"];
  candidate.riskFlags = ["conditional forecast includes a heavy hit", "switch target still takes a heavy hit",
    "conditional forecast can KO this target", "switch target can still be broken immediately",
    "one or more incoming attacking matchups are unknown; reply value is conditional", "their top attacking move still pressures this switch",
    "hidden Tera or prediction uncertainty can punish a hard switch"];
  const before = structuredClone(input);
  for (const heuristics of HEURISTIC_PRESENTATIONS) {
    const options = { heuristics, strategicLedger: { note: "Untrusted planning stays unchanged" } };
    const full = buildDecisionCard(input, options), hidden = buildDecisionCard(input, { ...options, threatPreview: "hidden" });
    const expected = structuredClone(full);
    delete expected.mechanics.opponentThreatPreview;
    expected.projectionCapabilities.evidenceDisplay = expected.projectionCapabilities.evidenceDisplay.replace("damage/threat/delayed", "player damage/delayed");
    const displayed = expected.ownShortlist?.candidates.find(c => c.kind === "switch");
    if (displayed) {
      displayed.reasons = ["entry hazards tax this switch", "faster after switching", "preserves a still-useful active"];
      displayed.riskFlags = ["hidden Tera or prediction uncertainty can punish a hard switch"];
    }
    assert.deepEqual(hidden, expected, heuristics);
    assert.ok(hasCardField(full, "mechanics.opponentThreatPreview.0.switchTargets.0.bands"));
    assert.equal(hasCardField(hidden, "mechanics.opponentThreatPreview"), false);
    assert.equal(hasCardField(hidden, "mechanics.opponentThreatPreview.0.switchTargets.0.bands"), false);
    assert.deepEqual(hidden.mechanics.playerDamagePreview, full.mechanics.playerDamagePreview);
  }
  assert.deepEqual(input, before, "ablation must not alter canonical evidence or future decisions");
  delete intel.opponentThreatPreview;
  assert.equal(Object.hasOwn(buildDecisionCard(input, { threatPreview: "hidden" }).mechanics, "opponentThreatPreview"), false);
});

test("hidden threat preview removes instruction references and legacy prompt leaks across all variants and advice modes", () => {
  // A Card-only change could leave the baseline/temporal threat matrix visible,
  // or veto could validate a different, unablated Card than the model saw.
  const value = fixture(), hash = `sha256:${"b".repeat(64)}`;
  value.envelope.resultHash = hash;
  value.envelope.semantic.identity.snapshotHash = hash;
  value.envelope.semantic.identity.legalActionSetHash = hash;
  const switchCandidate = value.envelope.semantic.localIntel.selfActionRecommendation!.rankedActions.find(c => c.kind === "switch")!;
  switchCandidate.reasons = ["switch target absorbs the likely attack", "preserves a still-useful active"];
  for (const promptVariant of BATTLE_PROMPT_VARIANTS) for (const heuristicPresentation of HEURISTIC_PRESENTATIONS)
    for (const mode of [undefined, "suggest", "veto"] as const) {
      if (mode === undefined) delete value.advice;
      else value.advice = { source: "metamon", policyId: "metamon:Kakuna:epoch34", requestId: value.requestId,
        identity: value.envelope.semantic.identity, inputResultHash: hash, actionId: "move:1", mode };
      const options = { promptVariant, heuristicPresentation };
      const full = buildBattlePolicyPrompt(value, options, 1000, 1000);
      const hidden = buildBattlePolicyPrompt(value, { ...options, threatPreview: "hidden" }, 1000, 1000);
      assert.notEqual(hidden, full);
      assert.doesNotMatch(hidden, /"opponentThreatPreview"|"threats":|empty incoming rows|damage\/threat\/delayed|switch target absorbs the likely attack/);
      if (promptVariant.startsWith("card")) {
        const expectedInstructions = ACTION_POLICY_INSTRUCTIONS.replace("Unknown damage, empty incoming rows or", "Unknown damage or");
        assert.equal(hidden.split("\n\n")[0], mode === "veto" ? expectedInstructions.split("\n").slice(0, -1).join("\n") : expectedInstructions);
      }
      const objects = hidden.split("\n\n").filter(p => p.startsWith("{")).map(p => JSON.parse(p));
      const card = objects.find(p => p.contractVersion === "battle-decision-card@1");
      if (card) assert.deepEqual(card, serialized(buildDecisionCard(value, { heuristics: heuristicPresentation, threatPreview: "hidden",
        ...(promptVariant === "card-ledger" ? { strategicLedger: { status: "missing" } } : {}) })));
      const legacy = objects.find(p => p.engineAnalysis);
      if (legacy) {
        const original = full.split("\n\n").filter(p => p.startsWith("{")).map(p => JSON.parse(p)).find(p => p.engineAnalysis);
        delete original.engineAnalysis.threats;
        original.engineAnalysis.rankedActions.find((c: { kind: string }) => c.kind === "switch").reasons = ["preserves a still-useful active"];
        assert.deepEqual(legacy, original);
      }
    }
});

test("threat preview rejects invalid options before rendering or transport setup", () => {
  const value = fixture(), threatPreview = "other" as "hidden";
  assert.throws(() => buildDecisionCard(value, { threatPreview }), /Unknown threat preview presentation/);
  assert.throws(() => buildBattlePolicyPrompt(value, { threatPreview }), /Invalid threat preview presentation/);
});

test("Card preserves binding, complete enabled legality, Tera distinctions and final shortlist ordering", () => {
  const input = fixture(), card = buildDecisionCard(input);
  assert.deepEqual(card.binding, { requestId: input.requestId, identity: input.envelope.semantic.identity, inputResultHash: input.envelope.resultHash, side: "p2", phase: "turn" });
  assert.deepEqual(card.capabilities, input.envelope.semantic.capabilities);
  assert.deepEqual(card.legalActions, input.envelope.semantic.snapshot.legalActions.slice(0, 6));
  assert.ok(card.ownShortlist);
  assert.deepEqual(card.ownShortlist.candidates.map((c) => [c.actionId, c.rank, c.band]), [
    ["move:1", 1, "top"], ["move:1:tera", 2, "competitive"], ["switch:2", 3, "competitive"], ["move:2", 4, "fallback"], ["special", 5, "fallback"] ]);
  assert.equal(Object.keys(card).at(-1), "ownShortlist");
  assert.match(card.ownShortlist.meaning, /Ordinal.*uncalibrated/);
});

test("raw, banded and hidden only vary heuristic presentation, never facts or legal actions", () => {
  const input = fixture(), cards = HEURISTIC_PRESENTATIONS.map((heuristics) => buildDecisionCard(input, { heuristics }));
  const [raw, banded, hidden] = cards;
  assert.deepEqual(buildDecisionCard(input), banded);
  for (const card of cards) {
    assert.deepEqual(card.binding, raw!.binding); assert.deepEqual(card.legalActions, raw!.legalActions);
    assert.deepEqual(card.current, raw!.current); assert.deepEqual(card.mechanics, raw!.mechanics);
  }
  assert.equal(raw!.ownShortlist!.candidates[0]!.score, 99);
  assert.equal(raw!.ownShortlist!.candidates[0]!.scoreBreakdown![0]!.value, 99);
  assert.equal("score" in banded!.ownShortlist!.candidates[0]!, false);
  assert.equal("scoreBreakdown" in banded!.ownShortlist!.candidates[0]!, false);
  assert.equal("ownShortlist" in hidden!, false);
  for (const card of [banded!, hidden!]) {
    const prediction = card.inferredIntel.opponentActionPrediction!;
    assert.equal("classScores" in prediction, false);
    assert.equal("score" in prediction.topActions[0]!, false);
    assert.equal("score" in prediction.topSwitchTargets![0]!, false);
    assert.deepEqual(prediction.topSwitchTargets![0]!.switchTargetForecast, { status: "not_displayed", rows: 1, sourceField: "switchTargetPlayerPreview", note: "Optional hypothetical-switch matrix omitted; omission establishes no safety or immunity." });
  }
  assert.deepEqual(raw!.inferredIntel.opponentActionPrediction!.classScores, input.envelope.semantic.localIntel.opponentActionPrediction!.classScores);
  assert.equal(raw!.inferredIntel.opponentActionPrediction!.topActions[0]!.score, 22);
  assert.equal(raw!.inferredIntel.opponentActionPrediction!.topSwitchTargets![0]!.score, 13);
});

test("720 preview permutations remain distinct legal IDs while shortlist deduplicates leads", () => {
  const permutations = (xs: number[]): number[][] => xs.length ? xs.flatMap((x) => permutations(xs.filter((y) => y !== x)).map((tail) => [x, ...tail])) : [[]];
  const input = fixture(), snapshot = input.envelope.semantic.snapshot;
  snapshot.phase = "preview";
  const actions: LegalAction[] = permutations([1, 2, 3, 4, 5, 6]).map((teamSpec) => ({ id: `team:${teamSpec.join("")}`, kind: "team", label: "Team order", teamSpec, choice: `team ${teamSpec.join("")}` }));
  snapshot.legalActions = [...actions, { id: "disabled-team", kind: "team", label: "Disabled", disabled: true }];
  input.envelope.semantic.localIntel.selfActionRecommendation!.rankedActions = actions.map((action) => ({ actionId: action.id, kind: "team", label: action.label, score: 1, reasons: [], riskFlags: [] }));
  const card = buildDecisionCard(input);
  assert.equal(card.legalActions.length, 720);
  assert.equal(new Set(card.legalActions.map((action) => typeof action === "string" ? action : action.id)).size, 720);
  assert.deepEqual(card.legalActions, actions.map((a) => a.id));
  const leads = card.ownShortlist!.candidates.map((c) => actions.find((a) => a.id === c.actionId)!.teamSpec![0]);
  assert.deepEqual(leads, [1, 2, 3, 4, 5]);
});

test("current mechanics, compact remaining resources and pending timing remain exact despite stale log", () => {
  const input = fixture(), card = buildDecisionCard(input), s = input.envelope.semantic.snapshot;
  assert.equal("active" in card.resources.own, false);
  assert.equal(card.resources.own.reserves.length, 1);
  assert.equal(card.resources.own.reserves[0]!.instanceId, "own-reserve");
  assert.equal(card.resources.own.reserves[0]!.hpPercent, 0);
  assert.equal(card.resources.own.reserves[0]!.fainted, true);
  assert.deepEqual(card.resources.opponent.reserves[0]!.candidateInstanceIds, ["maybe-a", "maybe-b"]);
  for (const key of ["instanceId", "appearanceId", "identityStatus", "canonicalSpecies", "level", "conditionText", "species", "hpPercent", "status", "fainted", "active", "revealed", "boosts", "stats", "knownMoves", "appearanceMoves", "turnsSinceEntry", "item", "removedItem", "ability", "types", "teraType", "terastallized", "paradoxBoostedStat", "unburdenActive", "slowStartActive"] as const) {
    assert.deepEqual(card.current.ownActive![key], s.yourSide.active![key], key);
  }
  assert.equal(card.current.ownActive!.slowStartActive, true);
  assert.deepEqual(card.current.field, s.field); assert.deepEqual(card.current.request, s.rawRequestSummary);
  assert.deepEqual(card.current.pendingAttacks, s.pendingAttacks);
  assert.deepEqual(card.current.replyTiming, input.envelope.semantic.localIntel.opponentActionPrediction!.replyTiming);
  assert.deepEqual(card.current.speed, input.envelope.semantic.localIntel.speedPreview);
  assert.deepEqual(card.recentLog.entries, s.recentLog.slice(-10));
  assert.equal(card.recentLog.currentStateAuthoritative, false);
  assert.equal(card.current.ownActive!.hpPercent, 37); assert.equal(card.current.field.weather, "Snow");
  assert.deepEqual(card.current.canonicalEvidence.ambiguities, ["reserve ambiguous"]);
  delete s.pendingAttacks;
  assert.equal(buildDecisionCard(input).current.pendingAttacks, null);
  s.pendingAttacks = [];
  assert.deepEqual(buildDecisionCard(input).current.pendingAttacks, []);
  assert.match(card.projectionCapabilities.pendingAttackCompleteness, /Not certified/);
});

test("damage, delayed, observed support, nulls and caveats are transported without numeric fallback", () => {
  const input = fixture(), card = buildDecisionCard(input), intel = input.envelope.semantic.localIntel;
  assert.deepEqual(serialized(card.mechanics.playerDamagePreview), serialized(intel.playerDamagePreview));
  assert.deepEqual(serialized(card.mechanics.opponentThreatPreview), serialized(intel.opponentThreatPreview));
  const preview = card.mechanics.playerDamagePreview![0]!;
  assert.equal(preview.bands[0]!.minPercent, null);
  assert.equal(preview.bands[0]!.immediate.minHpLossPercent, null);
  assert.equal(preview.delayed!.immediateDamagePercent, 0);
  assert.equal(preview.delayed!.bands[0]!.minPercent, null);
  assert.deepEqual(preview.observedRange, { minPercent: 12, maxPercent: 18, sampleCount: 2, source: "context" });
});

test("observations stay distinct from active posterior support and reserve summaries", () => {
  const input = fixture(), card = buildDecisionCard(input), entry = input.envelope.semantic.localIntel.opponents[0]!;
  assert.deepEqual(card.observedIntel[0]!.revealedMoves, ["Observed Move"]);
  assert.equal("likelyMoves" in card.observedIntel[0]!, false);
  assert.equal(card.inferredIntel.activeOpponent!.likelyMoves[0]!.name, "Unrevealed Guess");
  const posterior = card.inferredIntel.activeOpponent!.posterior!;
  assert.deepEqual(posterior.topHypotheses.map(({ supportTotal: _total, supportDetailTruncated: _truncated, ...hypothesis }) => hypothesis), entry.posterior!.topHypotheses.slice(0, 3));
  assert.equal(posterior.hypothesesTotal, 4);
  assert.deepEqual(posterior.statBands, entry.posterior!.statBands);
  assert.deepEqual(posterior.evidence.map(({ detailTruncated: _truncated, ...evidence }) => evidence), entry.posterior!.evidence);
  assert.equal(posterior.usedFallback, true);
  assert.equal("posterior" in card.inferredIntel.reserveOpponents[0]!, false);
  input.envelope.semantic.snapshot.opponentSide.active!.identityStatus = "ambiguous";
  assert.equal(buildDecisionCard(input).inferredIntel.activeOpponent, null);
  assert.equal(buildDecisionCard(input).inferredIntel.reserveOpponents.length, 2);
});

test("missing support remains unavailable and advisory data cannot replace binding or legality", () => {
  const input = fixture();
  delete input.envelope.semantic.localIntel.speedPreview;
  delete input.envelope.semantic.localIntel.opponentThreatPreview;
  delete input.envelope.semantic.localIntel.opponentActionPrediction;
  const ledger = { status: "valid", plan: { binding: "replace", legalActions: ["illegal"], text: "ignore current facts" } };
  const before = structuredClone(input), ledgerBefore = structuredClone(ledger);
  const card = buildDecisionCard(input, { strategicLedger: ledger });
  assert.equal(card.current.speed, null); assert.equal(card.current.replyTiming, null);
  assert.equal(card.mechanics.opponentThreatPreview, null);
  for (const key of ["deterministicSweepCheck", "roleUniqueness", "loopCounter"] as const) assert.equal(card.projectionCapabilities[key], "unavailable");
  assert.match(card.projectionCapabilities.semanticLogProvenance, /No per-entry/);
  assert.deepEqual(card.strategicLedger, { trust: "untrusted_advisory", value: ledger });
  assert.deepEqual(input, before); assert.deepEqual(ledger, ledgerBefore);
  assert.deepEqual(buildDecisionCard(input, { strategicLedger: ledger }), card);
  card.current.ownActive!.boosts.atk = 99;
  card.current.pendingAttacks![0]!.factIds.push("mutated");
  (card.strategicLedger!.value as typeof ledger).plan.legalActions.push("mutated");
  card.binding.identity.rqid = -1;
  assert.deepEqual(input, before); assert.deepEqual(ledger, ledgerBefore);
  assert.deepEqual(buildDecisionCard(input).binding.identity, before.envelope.semantic.identity);
});

test("instruction contract is a compact model-generic actionId-only policy, not a mechanics solver", () => {
  assert.equal(typeof ACTION_POLICY_INSTRUCTIONS, "string");
  const tokens = ["emergencies", "timing:", "roles", "robust", "Tera opportunity", "measurable progress", "State uncertainty", "shortlist last"];
  const positions = tokens.map((s) => ACTION_POLICY_INSTRUCTIONS.indexOf(s));
  assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)));
  assert.match(ACTION_POLICY_INSTRUCTIONS, /ONLY one JSON object with actionId/);
  assert.match(ACTION_POLICY_INSTRUCTIONS, /uncalibrated/);
  assert.ok(ACTION_POLICY_INSTRUCTIONS.length < 3000);
});

test("Card bounds evidence ancestry and optional forecast display without losing primary mechanics or legal actions", () => {
  const input = fixture(), s = input.envelope.semantic.snapshot, intel = input.envelope.semantic.localIntel;
  const heavyRefs = Array.from({ length: 200 }, (_, i) => `fact-${i}-${"ancestry".repeat(30)}`);
  s.yourSide.active!.evidenceRefs = heavyRefs;
  s.yourSide.team[0]!.evidenceRefs = heavyRefs;
  s.yourSide.team[1]!.evidenceRefs = heavyRefs;
  const p = intel.opponents[0]!.posterior!;
  p.evidence = Array.from({ length: 100 }, () => ({ kind: "damage", label: "Observed damage support", detail: "verbose detail ".repeat(200) }));
  p.topHypotheses[0]!.support = Array.from({ length: 100 }, () => "verbose support ".repeat(200));
  const target = intel.opponentActionPrediction!.topSwitchTargets![0]!;
  intel.opponentActionPrediction!.topActions.push(structuredClone(target));
  (target.switchTargetPlayerPreview![0] as DamagePreview & { debug: unknown }).debug = { duplicate: "not policy evidence".repeat(20_000) };
  // Primary forecasts keep their supported fields; hypothetical matrices are optional display.
  intel.opponentActionPrediction!.topActions[1] = structuredClone(target);
  const before = structuredClone(input), card = buildDecisionCard(input), json = JSON.parse(JSON.stringify(card));
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 30_000, "verbose ancestry/debug mirrors must not dominate the Card");
  assert.equal("active" in json.resources.own, false, "current active is stored once");
  assert.equal(json.current.ownActive.instanceId, "own-active");
  assert.equal(json.current.ownActive.slowStartActive, true);
  assert.equal(json.current.ownActive.evidenceRefs.length, 3);
  assert.equal(json.current.ownActive.evidenceReferenceCount, 200);
  assert.equal(json.current.ownActive.evidenceReferencesTruncated, true);
  assert.equal(json.resources.own.reserves[0].hpPercent, 0);
  assert.equal(json.inferredIntel.activeOpponent.posterior.evidence.length, 3);
  assert.equal(json.inferredIntel.activeOpponent.posterior.evidenceTotal, 100);
  assert.equal(json.inferredIntel.activeOpponent.posterior.evidence[0].detail.length, 240);
  assert.equal(json.inferredIntel.activeOpponent.posterior.evidence[0].detailTruncated, true);
  assert.equal(json.inferredIntel.activeOpponent.posterior.topHypotheses[0].support.length, 3);
  assert.equal(json.inferredIntel.activeOpponent.posterior.topHypotheses[0].supportDetailTruncated, true);
  assert.equal(json.inferredIntel.activeOpponent.posterior.topHypotheses[0].weight, p.topHypotheses[0]!.weight);
  const prediction = json.inferredIntel.opponentActionPrediction;
  assert.equal(prediction.topActions[1].switchTargetForecast.status, "not_displayed");
  assert.equal("switchTargetPlayerPreview" in prediction.topActions[1], false);
  assert.equal("switchTargetPlayerPreview" in prediction.topSwitchTargets[0], false);
  assert.equal(prediction.topSwitchTargets[0].switchTargetForecast.rows, 1);
  assert.equal("debug" in json.mechanics.playerDamagePreview[0], false);
  assert.deepEqual(json.mechanics.playerDamagePreview[0].bands, target.switchTargetPlayerPreview![0]!.bands);
  assert.match(json.projectionCapabilities.evidenceDisplay, /omission.*safety/i);
  assert.deepEqual(input, before);
});

test("compact projection preserves zero, false and unknown while explicitly marking omitted forecast detail", () => {
  const input = fixture(), s = input.envelope.semantic.snapshot, intel = input.envelope.semantic.localIntel;
  s.yourSide.active!.hpPercent = 0; s.yourSide.active!.slowStartActive = false;
  s.yourSide.active!.paradoxBoostedStat = null;
  const target = intel.opponentActionPrediction!.topSwitchTargets![0]!;
  intel.opponentActionPrediction!.topActions = [target];
  delete intel.opponentActionPrediction!.topSwitchTargets;
  const card = buildDecisionCard(input);
  assert.equal(card.current.ownActive!.hpPercent, 0);
  assert.equal(card.current.ownActive!.slowStartActive, false);
  assert.equal(card.current.ownActive!.paradoxBoostedStat, null);
  assert.equal(card.inferredIntel.opponentActionPrediction!.topActions[0]!.switchTargetForecast!.status, "not_displayed");
  assert.equal(card.inferredIntel.opponentActionPrediction!.topActions[0]!.switchTargetForecast!.rows, 1);
  const forecast = card.mechanics.playerDamagePreview![0]!;
  assert.equal(forecast.targetCurrentHpPercent, null);
  assert.equal(forecast.delayed!.immediateDamagePercent, 0);
  assert.equal(forecast.delayed!.dueTurn, null);
  assert.equal(forecast.delayed!.bands[0]!.immediate.minHpLossPercent, null);
  assert.deepEqual(card.legalActions, s.legalActions.slice(0, 6));
});

test("optional matrix omission never removes primary switch-target HP, conditional bands or delayed evidence", () => {
  const input = fixture(), intel = input.envelope.semantic.localIntel;
  const threat = intel.opponentThreatPreview![0]!;
  const target = structuredClone(threat.currentTarget);
  target.instanceId = "own-reserve"; target.targetCurrentHpPercent = 0;
  target.bands[0]!.immediate = { ko: "conditional", minHpLossPercent: null, maxHpLossPercent: null, note: "Unqualified switch entry" };
  target.observedRange = { minPercent: 0, maxPercent: 4, sampleCount: 1, source: "context" };
  target.likelyBandSource = "posterior";
  threat.switchTargets = [target];
  const before = structuredClone(input), card = buildDecisionCard(input);
  assert.deepEqual(serialized(card.mechanics.opponentThreatPreview), serialized(intel.opponentThreatPreview));
  const displayed = card.mechanics.opponentThreatPreview![0]!.switchTargets[0]!;
  assert.equal(displayed.targetCurrentHpPercent, 0);
  assert.equal(displayed.bands[0]!.immediate.ko, "conditional");
  assert.equal(displayed.bands[0]!.immediate.maxHpLossPercent, null);
  assert.deepEqual(displayed.delayed!.factIds, ["fact-pending"]);
  assert.equal(displayed.delayed!.dueTurn, null);
  assert.equal(card.inferredIntel.opponentActionPrediction!.topSwitchTargets![0]!.switchTargetForecast!.status, "not_displayed");
  assert.deepEqual(card.inferredIntel.opponentActionPrediction!.topSwitchTargets![0]!.riskFlags, intel.opponentActionPrediction!.topSwitchTargets![0]!.riskFlags);
  assert.deepEqual(input, before);
});
