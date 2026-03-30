import type { AnalysisRequestContext, BattleSnapshot, DamageAssumptionBand, LocalIntelSnapshot } from "../types.js";
import { buildDeterministicNotes } from "./deterministicNotes.js";

export interface AnalysisPromptOptions {
  analysisMode?: "tactical" | "strategic" | undefined;
  includeToolHint?: boolean;
  maxDeterministicNotes?: number;
  maxRecentLogEntries?: number;
  maxSnapshotNotes?: number;
  prettySnapshot?: boolean;
  compactSnapshot?: boolean;
  localIntel?: LocalIntelSnapshot | undefined;
  requestContext?: AnalysisRequestContext | undefined;
}

function analysisModeForOptions(options: AnalysisPromptOptions): "tactical" | "strategic" {
  return options.analysisMode === "strategic" ? "strategic" : "tactical";
}

function compactPokemonForPrompt(pokemon: BattleSnapshot["yourSide"]["active"] | null | undefined) {
  if (!pokemon) return null;
  return {
    ident: pokemon.ident,
    species: pokemon.species,
    displayName: pokemon.displayName,
    hpPercent: pokemon.hpPercent,
    status: pokemon.status,
    fainted: pokemon.fainted,
    active: pokemon.active,
    revealed: pokemon.revealed,
    boosts: pokemon.boosts,
    stats: pokemon.stats,
    knownMoves: pokemon.knownMoves,
    item: pokemon.item,
    removedItem: pokemon.removedItem,
    ability: pokemon.ability,
    types: pokemon.types,
    teraType: pokemon.teraType,
    terastallized: pokemon.terastallized
  };
}

function compactSideForPrompt(side: BattleSnapshot["yourSide"]) {
  return {
    slot: side.slot,
    name: side.name,
    active: compactPokemonForPrompt(side.active),
    reserves: side.team
      .filter((pokemon) => !pokemon.active)
      .map((pokemon) => compactPokemonForPrompt(pokemon))
  };
}

function buildPromptSnapshot(snapshot: BattleSnapshot, options: AnalysisPromptOptions) {
  const maxRecentLogEntries = options.maxRecentLogEntries ?? snapshot.recentLog.length;
  const maxSnapshotNotes = options.maxSnapshotNotes ?? snapshot.notes.length;
  const trimmed = {
    ...snapshot,
    recentLog: snapshot.recentLog.slice(-maxRecentLogEntries),
    notes: snapshot.notes.slice(-maxSnapshotNotes)
  };
  if (!options.compactSnapshot) {
    return trimmed;
  }
  return {
    version: trimmed.version,
    capturedAt: trimmed.capturedAt,
    format: trimmed.format,
    turn: trimmed.turn,
    phase: trimmed.phase,
    yourSide: compactSideForPrompt(trimmed.yourSide),
    opponentSide: compactSideForPrompt(trimmed.opponentSide),
    field: trimmed.field,
    legalActions: trimmed.legalActions.map((action) => ({
      id: action.id,
      kind: action.kind,
      label: action.label,
      moveName: action.moveName,
      target: action.target,
      details: action.details,
      disabled: action.disabled
    })),
    recentLog: trimmed.recentLog,
    rawRequestSummary: trimmed.rawRequestSummary,
    notes: trimmed.notes
  };
}


function describeDeterministicBand(band: DamageAssumptionBand | undefined) {
  if (!band?.outcome || band.outcome === "damage") return null;
  const outcomeText = band.outcome === "immune"
    ? "immune"
    : band.outcome === "blocked"
      ? "blocked"
      : "non-damaging status";
  const detail = typeof band.detail === "string" ? band.detail.replace(/[.\s]+$/g, "") : undefined;
  return detail ? `${outcomeText} (${detail})` : outcomeText;
}

function describePosterior(entry: NonNullable<LocalIntelSnapshot["opponents"]>[number]["posterior"]) {
  if (!entry) return null;
  const hypotheses = entry.topHypotheses.slice(0, 3).map((hypothesis) => {
    const parts = [
      hypothesis.item ?? "item ?",
      hypothesis.ability ?? "ability ?",
      hypothesis.teraType ? `tera ${hypothesis.teraType}` : "tera ?",
      `${Math.round(hypothesis.weight * 100)}%`,
      hypothesis.statArchetype
    ];
    return parts.join(" / ");
  });
  const statBands = entry.statBands.map((band) =>
    `${band.stat} ${Math.round(band.min)}-${Math.round(band.max)} (likely ${Math.round(band.likelyLow)}-${Math.round(band.likelyHigh)})`
  );
  return [
    `posterior ${entry.confidenceTier}`,
    hypotheses.length > 0 ? `hypotheses ${hypotheses.join(", ")}` : null,
    statBands.length > 0 ? `stat bands ${statBands.join(", ")}` : null,
    entry.evidenceKinds.length > 0 ? `evidence ${entry.evidenceKinds.join(", ")}` : null,
    entry.usedFallback ? "fallback active" : null
  ].filter(Boolean).join("; ");
}

function describeActionClass(
  value: NonNullable<LocalIntelSnapshot["opponentActionPrediction"]>["topActionClass"] | undefined
) {
  if (value === "stay_attack") return "stay and attack";
  if (value === "switch") return "switch";
  if (value === "status_or_setup") return "status or setup";
  return "unknown";
}

function describePredictionAction(
  action: NonNullable<LocalIntelSnapshot["opponentActionPrediction"]>["topActions"][number]
) {
  const kind = action.type === "likely_switch"
    ? "switch"
    : action.actionClass === "status_or_setup"
      ? "status/setup"
      : action.type === "likely_hidden_move"
        ? "likely hidden move"
        : "known move";
  return `${action.label} (${kind}, score ${Math.round(action.score)})`;
}

function describeLeadCandidate(
  candidate: NonNullable<LocalIntelSnapshot["opponentLeadPrediction"]>["topCandidates"][number]
) {
  const historical = Number.isFinite(candidate.historicalLeadShare)
    ? `, historical lead ${Math.round(Number(candidate.historicalLeadShare) * 100)}%`
    : "";
  return `${candidate.species} (score ${Math.round(candidate.score)}${historical})`;
}

function describeSelfRecommendationAction(
  action: NonNullable<LocalIntelSnapshot["selfActionRecommendation"]>["rankedActions"][number]
) {
  const kind = action.kind === "switch" ? "switch" : action.kind === "move" ? "move" : action.kind;
  return `${action.label} (${kind}, score ${Math.round(action.score)})`;
}

export function buildAnalysisPrompt(snapshot: BattleSnapshot, options: AnalysisPromptOptions = {}): string {
  const analysisMode = analysisModeForOptions(options);
  const promptSnapshot = buildPromptSnapshot(snapshot, options);
  const compactSnapshot = JSON.stringify(promptSnapshot, null, options.prettySnapshot === false ? 0 : 2);
  const deterministicNotes = buildDeterministicNotes(snapshot).slice(0, options.maxDeterministicNotes ?? 12);
  const noteLines = deterministicNotes.length > 0
    ? ["", "Deterministic notes:", ...deterministicNotes.map((line) => `- ${line}`)]
    : [];
  const localIntelLines = Array.isArray(options.localIntel?.opponents) && options.localIntel.opponents.length > 0
    ? [
        "",
        "Local battle-history priors:",
        ...options.localIntel.opponents.flatMap((entry) => {
          const segments = [];
          if (entry.likelyMoves.length > 0) {
            segments.push(
              `likely hidden moves ${entry.likelyMoves.map((move) => `${move.name} (${Math.round(move.share * 100)}%, ${move.confidenceTier})`).join(", ")}`
            );
          }
          if (entry.likelyItems.length > 0) {
            segments.push(
              `likely items ${entry.likelyItems.map((item) => `${item.name} (${Math.round(item.share * 100)}%, ${item.confidenceTier})`).join(", ")}`
            );
          }
          if (entry.likelyAbilities.length > 0) {
            segments.push(
              `likely abilities ${entry.likelyAbilities.map((ability) => `${ability.name} (${Math.round(ability.share * 100)}%, ${ability.confidenceTier})`).join(", ")}`
            );
          }
          if (entry.likelyTeraTypes.length > 0) {
            segments.push(
              `likely Tera types ${entry.likelyTeraTypes.map((tera) => `${tera.name} (${Math.round(tera.share * 100)}%, ${tera.confidenceTier})`).join(", ")}`
            );
          }
          if (entry.posterior) {
            const posteriorLine = describePosterior(entry.posterior);
            if (posteriorLine) segments.push(posteriorLine);
          }
          if (options.localIntel?.speedPreview?.effectiveRange) {
            segments.push(
              `active speed ${options.localIntel.speedPreview.activeRelation}; you ${options.localIntel.speedPreview.yourActiveEffectiveSpeed ?? "?"}; opp ${options.localIntel.speedPreview.effectiveRange.min}-${options.localIntel.speedPreview.effectiveRange.max}; why ${options.localIntel.speedPreview.reason ?? "unknown"}`
            );
          } else if (entry.speedNotes.length > 0) {
            segments.push(entry.speedNotes[0]);
          }
          if (segments.length === 0) return [];
          return [`- ${entry.species}: ${segments.join("; ")}.`];
        }).slice(0, 6)
      ]
    : [];
  const opponentActionLines = options.localIntel?.opponentActionPrediction
    ? [
        "",
        "Deterministic opponent next-action view:",
        `- Predicted class ${describeActionClass(options.localIntel.opponentActionPrediction.topActionClass)}; confidence ${options.localIntel.opponentActionPrediction.confidenceTier}.`,
        ...(options.localIntel.opponentActionPrediction.topActions.slice(0, 3).map((action) => `- ${describePredictionAction(action)}.`)),
        ...(options.localIntel.opponentActionPrediction.reasons.slice(0, 3).map((reason) => `- Why: ${reason}.`)),
        ...(options.localIntel.opponentActionPrediction.riskFlags.slice(0, 2).map((risk) => `- Risk: ${risk}.`))
      ]
    : [];
  const opponentLeadLines = options.localIntel?.opponentLeadPrediction
    ? [
        "",
        "Deterministic opponent lead view:",
        `- Predicted lead ${options.localIntel.opponentLeadPrediction.topLeadSpecies ?? "unknown"}; confidence ${options.localIntel.opponentLeadPrediction.confidenceTier}.`,
        ...(options.localIntel.opponentLeadPrediction.topCandidates.slice(0, 3).map((candidate) => `- ${describeLeadCandidate(candidate)}.`)),
        ...(options.localIntel.opponentLeadPrediction.reasons.slice(0, 3).map((reason) => `- Why: ${reason}.`)),
        ...(options.localIntel.opponentLeadPrediction.riskFlags.slice(0, 2).map((risk) => `- Risk: ${risk}.`))
      ]
    : [];
  const requestContextLines = options.requestContext
    ? [
        "",
        "Request context:",
        `- Tab status ${options.requestContext.tabStatus}; actionable now ${options.requestContext.actionableNow ? "yes" : "no"}.`,
        ...(Number.isFinite(options.requestContext.snapshotAgeMs)
          ? [`- Snapshot age ${Math.round(Number(options.requestContext.snapshotAgeMs))} ms.`]
          : []),
        ...(options.requestContext.wait ? ["- The page reports the battle is waiting for the opponent or an animation."] : []),
        ...(options.requestContext.forceSwitch ? ["- A forced switch is pending in the captured request state."] : []),
        ...(options.requestContext.teamPreview ? ["- The current state is team preview rather than a live turn."] : [])
      ]
    : [];
  const selfRecommendationLines = analysisMode === "strategic" && options.localIntel?.selfActionRecommendation
    ? [
        "",
        "Deterministic self-recommendation:",
        `- Top legal action ${options.localIntel.selfActionRecommendation.topActionId ?? "unknown"}; confidence ${options.localIntel.selfActionRecommendation.confidenceTier}.`,
        `- Summary: ${options.localIntel.selfActionRecommendation.summary}`,
        ...(options.localIntel.selfActionRecommendation.rankedActions.slice(0, 4).map((action) => `- ${describeSelfRecommendationAction(action)}.`)),
        ...(options.localIntel.selfActionRecommendation.reasons.slice(0, 3).map((reason) => `- Why: ${reason}.`)),
        ...(options.localIntel.selfActionRecommendation.riskFlags.slice(0, 2).map((risk) => `- Risk: ${risk}.`))
      ]
    : [];
  const structuredMechanicsLines = [
    ...opponentLeadLines,
    ...selfRecommendationLines,
    ...opponentActionLines,
    ...(Array.isArray(options.localIntel?.playerDamagePreview) && options.localIntel.playerDamagePreview.length > 0
      ? [
          "",
          "Current damage ranges:",
          ...options.localIntel.playerDamagePreview.slice(0, 4).map((entry) => {
            const likelyBand = entry.bands.find((band) => band.label === "likely") ?? entry.bands[0];
            const lowBand = entry.bands.find((band) => band.label === "conservative");
            const highBand = entry.bands.find((band) => band.label === "high");
            const deterministic = describeDeterministicBand(likelyBand);
            const caveats = entry.survivalCaveats.length > 0 ? `; caveats ${entry.survivalCaveats.map((caveat) => caveat.kind).join(", ")}` : "";
            const observed = entry.observedRange
              ? `; seen locally ${entry.observedRange.minPercent}-${entry.observedRange.maxPercent}% over ${entry.observedRange.sampleCount} sample(s)`
              : "";
            const likelySource = entry.likelyBandSource && entry.likelyBandSource !== "calc"
              ? entry.likelyBandSource === "posterior"
                ? "; likely band from posterior-weighted set inference"
                : `; likely band from ${entry.likelyBandSource}-matched local history`
              : "";
            if (deterministic) {
              return `- ${entry.label}: ${deterministic}${caveats}.`;
            }
            return `- ${entry.label}: likely ${likelyBand?.minPercent ?? "?"}-${likelyBand?.maxPercent ?? "?"}% with outer envelope ${lowBand?.minPercent ?? "?"}-${lowBand?.maxPercent ?? "?"}% to ${highBand?.minPercent ?? "?"}-${highBand?.maxPercent ?? "?"}%${likelySource}${observed}${caveats}.`;
          })
        ]
      : []),
    ...(Array.isArray(options.localIntel?.opponentThreatPreview) && options.localIntel.opponentThreatPreview.length > 0
      ? [
          "",
          "Opponent threat ranges:",
          ...options.localIntel.opponentThreatPreview.slice(0, 4).map((entry) => {
            const likelyBand = entry.currentTarget.bands.find((band) => band.label === "likely") ?? entry.currentTarget.bands[0];
            const deterministic = describeDeterministicBand(likelyBand);
            const observed = entry.currentTarget.observedRange
              ? `; seen locally ${entry.currentTarget.observedRange.minPercent}-${entry.currentTarget.observedRange.maxPercent}% over ${entry.currentTarget.observedRange.sampleCount} sample(s)`
              : "";
            const likelySource = entry.currentTarget.likelyBandSource && entry.currentTarget.likelyBandSource !== "calc"
              ? entry.currentTarget.likelyBandSource === "posterior"
                ? "; likely band from posterior-weighted set inference"
                : `; likely band from ${entry.currentTarget.likelyBandSource}-matched local history`
              : "";
            if (deterministic) {
              return `- Opponent ${entry.moveSource} ${entry.moveName} into your active: ${deterministic} (${entry.currentTarget.relation}).`;
            }
            return `- Opponent ${entry.moveSource} ${entry.moveName} into your active: likely ${likelyBand?.minPercent ?? "?"}-${likelyBand?.maxPercent ?? "?"}% (${entry.currentTarget.relation})${likelySource}${observed}.`;
          })
        ]
      : []),
    ...(options.localIntel?.speedPreview?.effectiveRange
      ? [
          "",
          "Structured speed preview:",
          `- Opponent range ${options.localIntel.speedPreview.effectiveRange.min}-${options.localIntel.speedPreview.effectiveRange.max}; your active ${options.localIntel.speedPreview.yourActiveEffectiveSpeed ?? "?"}; relation ${options.localIntel.speedPreview.activeRelation}; why ${options.localIntel.speedPreview.reason ?? "unknown"}.`,
          ...(options.localIntel.speedPreview.evidence.slice(0, 3).map((entry) => `- ${entry.label}${entry.detail ? `: ${entry.detail}` : ""}`))
        ]
      : [])
  ];
  const toolHint = options.includeToolHint === false
    ? []
    : ["- If MCP tools are available, you may use them for type matchups, move lookups, or seed common sets."];
  const modeLines = analysisMode === "strategic"
    ? [
        "Task:",
        "- Give broader strategic guidance from the current board state, hidden-info predictions, and deterministic previews.",
        "- Only rank current legal actions when requestContext.actionableNow is true.",
        "- If requestContext.actionableNow is false, or snapshot.legalActions is empty, use synthetic action IDs from this set only: special:plan-primary, special:plan-secondary, special:plan-avoid.",
        "- Return structured JSON only.",
        "",
        "Rules:",
        "- Use the deterministic predictions, posterior hints, speed clues, and damage ranges below as evidence, not as blind truth.",
        "- Focus on preserve vs sack decisions, scouting, tera timing, win conditions, hazard posture, and what information matters next.",
        "- Keep the output actionable for the next few turns, not just the immediate click.",
        "- Treat stale or waiting snapshots as planning context, not as permission to recommend an immediate click.",
        "- If you use a synthetic strategic action ID, make the label and rationale read like a concrete game-plan recommendation.",
        ...toolHint,
        "- Be concise and practical.",
        "- This is a second opinion, not an autopilot."
      ]
    : [
        "Task:",
        "- Rank the legal actions in the provided snapshot.",
        "- Return structured JSON only.",
        "- Use only the legal action IDs that appear in snapshot.legalActions.",
        "",
        "Rules:",
        "- Never invent illegal moves or switches.",
        "- Use the deterministic predictions, posterior hints, speed clues, and damage ranges below as evidence, not as blind truth.",
        "- Form an independent ranking from the snapshot and opponent context; do not assume a hidden deterministic best line exists.",
        "- Prefer the best practical current-turn recommendation from this board state.",
        "- Prefer revealed information over guesses.",
        "- If you make metagame assumptions, put them in assumptions fields.",
        ...toolHint,
        "- Be concise and practical.",
        "- This is a second opinion, not an autopilot."
      ];

  return [
    "You are a Pokemon Showdown second-opinion assistant.",
    "",
    `Analysis mode: ${analysisMode}.`,
    "",
    ...modeLines,
    ...noteLines,
    ...requestContextLines,
    ...structuredMechanicsLines,
    ...localIntelLines,
    "",
    "Battle snapshot:",
    compactSnapshot
  ]
    .join("\n");
}
