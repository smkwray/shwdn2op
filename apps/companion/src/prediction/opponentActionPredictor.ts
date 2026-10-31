import { projectSwitchEntry, withholdEntryDamage } from "../mechanics/switchEntry.js";
import { battlePosteriorItems, choiceScarfImplied } from "../mechanics/liveLikelyItems.js";
import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";

import { buildDamagePreview, buildDelayedDamagePreview, buildDamageSummary } from "../prompting/damageNotes.js";
import type {
  BattleSnapshot,
  DamageAssumptionBand,
  DamagePreview,
  OpponentActionCandidate,
  OpponentActionPrediction,
  OpponentIntelEntry,
  PokemonSnapshot,
  ThreatPreview
} from "../types.js";

const gens = new Generations(Dex as any);

type MoveRelation = "faster" | "slower" | "overlap" | "unknown";

type SwitchTargetPreview = {
  pokemon: PokemonSnapshot;
  entry?: OpponentIntelEntry | undefined;
  damagePreview: DamagePreview[];
  hazardDamagePercent: number;
  entryFainted: boolean;
  entryHpUncertain: boolean;
  entryDamageQualified: boolean;
  entryNotes: string[];
  stickyWeb: boolean;
  source: "revealed_switch" | "previewed_switch";
};

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function generationFromFormat(format: string): number {
  const match = String(format ?? "").match(/\[Gen\s*(\d+)\]/i);
  const parsed = Number.parseInt(match?.[1] ?? "9", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 9;
}

function dataGen(format: string) {
  return gens.get(generationFromFormat(format) as Parameters<Generations["get"]>[0]);
}

function lookupMove(gen: ReturnType<typeof dataGen>, name: string | null | undefined) {
  if (!name) return undefined;
  const direct = gen.moves.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const move of gen.moves) {
    if (normalizeName(move.name) === normalized) return move;
  }
  return undefined;
}

function lookupSpecies(gen: ReturnType<typeof dataGen>, name: string | null | undefined) {
  if (!name) return undefined;
  const direct = gen.species.get(name);
  if (direct) return direct;
  const normalized = normalizeName(name);
  for (const species of gen.species) {
    if (normalizeName(species.name) === normalized) return species;
  }
  return undefined;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = normalizeName(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(0, value).toFixed(1));
}

function likelyBand(bands: DamageAssumptionBand[] | null | undefined) {
  if (!Array.isArray(bands) || bands.length === 0) return null;
  const selected = bands.find((band) => band.label === "likely") ?? bands[0]!;
  // Raw likely pressure remains heuristic. Immediate claims require support
  // across every represented profile, not just the median/likely raw band.
  const outcomes = bands.map((band) => band.immediate?.ko ?? "unknown");
  const ko = outcomes.every((value) => value === "all_rolls") ? "all_rolls"
    : outcomes.every((value) => value === "no_ko") ? "no_ko"
      : outcomes.some((value) => value === "unknown") ? "unknown"
        : outcomes.every((value) => value === "all_rolls" || value === "some_rolls") ? "some_rolls" : "conditional";
  const lower = bands.map((band) => band.immediate?.minHpLossPercent);
  const upper = bands.map((band) => band.immediate?.maxHpLossPercent);
  return { ...selected, immediate: { ...selected.immediate, ko,
    ...(ko !== selected.immediate?.ko ? { note: "Immediate KO varies across represented profiles." } : {}),
    minHpLossPercent: ko !== "unknown" && lower.every((value) => typeof value === "number" && Number.isFinite(value)) ? Math.min(...lower as number[]) : null,
    maxHpLossPercent: ko !== "unknown" && upper.every((value) => typeof value === "number" && Number.isFinite(value)) ? Math.max(...upper as number[]) : null
  } } as DamageAssumptionBand;
}

function bandAveragePercent(band: DamageAssumptionBand | null | undefined) {
  if (!band || (band.outcome && band.outcome !== "damage")) return 0;
  if (!Number.isFinite(band.minPercent) || !Number.isFinite(band.maxPercent)) return 0;
  return (Number(band.minPercent) + Number(band.maxPercent)) / 2;
}

function bandHpLossMax(band: DamageAssumptionBand | null | undefined) {
  const value = band?.immediate?.ko !== "unknown" ? band?.immediate?.maxHpLossPercent : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bandKoScore(band: DamageAssumptionBand | null | undefined) {
  if (!band || (band.outcome && band.outcome !== "damage")) return 0;
  if (band.immediate?.ko === "all_rolls") return 2;
  if (band.immediate?.ko === "some_rolls") return 1;
  return 0;
}

function isDamagingBand(band: DamageAssumptionBand | null | undefined) {
  return Boolean(band) && (!band?.outcome || band.outcome === "damage");
}

function bandThreatScore(band: DamageAssumptionBand | null | undefined) {
  return bandKoScore(band) * 1000 + (bandHpLossMax(band) ?? 0) * 2
    + Math.min(100, bandAveragePercent(band)) * 0.01;
}

function isImmuneOrBlockedBand(band: DamageAssumptionBand | null | undefined) {
  return Boolean((band?.outcome === "immune" || band?.outcome === "blocked")
    && band.immediate?.ko === "no_ko" && bandHpLossMax(band) === 0);
}

function relationAfterTrickRoomFromYourPerspective(snapshot: BattleSnapshot, relation: MoveRelation): MoveRelation {
  const trickRoomActive = snapshot.field.pseudoWeather.some((value) => /trick room/i.test(String(value ?? "")));
  if (!trickRoomActive) return relation;
  if (relation === "faster") return "slower";
  if (relation === "slower") return "faster";
  return relation;
}

function opponentMoveOrderRelation(snapshot: BattleSnapshot, relation: MoveRelation): MoveRelation {
  const adjusted = relationAfterTrickRoomFromYourPerspective(snapshot, relation);
  if (adjusted === "faster") return "slower";
  if (adjusted === "slower") return "faster";
  return adjusted;
}

function attackOrderBonus(relation: MoveRelation) {
  if (relation === "faster") return 14;
  if (relation === "overlap") return 4;
  if (relation === "slower") return -12;
  return 0;
}

function earlyTurn(snapshot: BattleSnapshot) {
  return Number(snapshot.turn ?? 0) > 0 && Number(snapshot.turn ?? 0) <= 3;
}

function lateTurn(snapshot: BattleSnapshot) {
  return Number(snapshot.turn ?? 0) >= 8;
}

function veryLateTurn(snapshot: BattleSnapshot) {
  return Number(snapshot.turn ?? 0) >= 12;
}

function livingReserveCount(team: PokemonSnapshot[], excludeActive = true) {
  return team.filter((pokemon) => !pokemon.fainted && (!excludeActive || !pokemon.active)).length;
}

function moveTargetsSpecificFoe(move: ReturnType<typeof lookupMove>) {
  const target = String(move?.target ?? "");
  return !["self", "allySide", "allyTeam", "foeSide", "all", "allAdjacent", "scripted", "adjacentAlly", "allyAlly"].includes(target);
}

function turnsStartedSinceActiveEntered(snapshot: BattleSnapshot, pokemon: PokemonSnapshot | null | undefined) {
  if (snapshot.canonicalEvidence) return pokemon?.turnsSinceEntry ?? null;
  const actorNames = uniqueStrings([pokemon?.displayName, pokemon?.species]);
  if (actorNames.length === 0) return null;
  let lastEntryIndex = -1;
  for (let index = snapshot.recentLog.length - 1; index >= 0; index -= 1) {
    const line = String(snapshot.recentLog[index] ?? "");
    if (!line.endsWith("entered the field.")) continue;
    const actor = line.replace(/ entered the field\.$/, "").trim();
    if (actorNames.some((name) => normalizeName(name) === normalizeName(actor))) {
      lastEntryIndex = index;
      break;
    }
  }
  if (lastEntryIndex < 0) return null;
  return snapshot.recentLog.slice(lastEntryIndex + 1).filter((line) => /^Turn \d+ started\./.test(String(line ?? ""))).length;
}

function moveCurrentlyUsable(snapshot: BattleSnapshot, pokemon: PokemonSnapshot | null | undefined, moveName: string | null | undefined) {
  const moveId = normalizeName(moveName);
  if (!["firstimpression", "fakeout"].includes(moveId)) return true;
  const turnsSinceEntry = turnsStartedSinceActiveEntered(snapshot, pokemon);
  if (turnsSinceEntry === null) return true;
  return turnsSinceEntry <= 1;
}

function summarizeBestDamage(previews: DamagePreview[] | null | undefined) {
  const entries = Array.isArray(previews) ? previews : [];
  let best: { entry: DamagePreview; band: DamageAssumptionBand | null } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    // Both choices are simultaneous: do not assume the player spends Tera
    // when estimating the opponent's pre-choice pressure. Branch previews
    // retain both action variants for evaluating the actual reply.
    if (entry.terastallize) continue;
    const band = likelyBand(entry.bands);
    const score = bandThreatScore(band);
    if (score > bestScore) {
      bestScore = score;
      best = { entry, band };
    }
  }

  return best;
}

function statusThreatPreviewForMove(threats: ThreatPreview[], moveName: string) {
  const moveId = normalizeName(moveName);
  return threats.find((entry) => normalizeName(entry.moveName) === moveId) ?? null;
}

function hasSupportedHiddenMove(activeOpponentEntry: OpponentIntelEntry | undefined, moveName: string) {
  const likely = activeOpponentEntry?.likelyMoves.find((entry) => normalizeName(entry.name) === normalizeName(moveName));
  return Boolean(activeOpponentEntry?.metaMovePrior?.moves.some((move) => normalizeName(move.name) === normalizeName(moveName)))
    || Boolean(likely && (likely.confidenceTier === "strong" || likely.confidenceTier === "usable" || likely.share >= 0.45));
}

function createSwitchSnapshot(snapshot: BattleSnapshot, switchTarget: PokemonSnapshot): BattleSnapshot {
  const targetIdent = switchTarget.ident;
  const nextActive = { ...switchTarget, active: true };
  const nextTeam = snapshot.opponentSide.team.map((pokemon) => pokemon.ident === targetIdent
    ? { ...nextActive } : { ...pokemon, active: false });
  return {
    ...snapshot,
    opponentSide: {
      ...snapshot.opponentSide,
      active: nextActive,
      team: nextTeam
    }
  };
}

function buildSwitchTargetPreview(
  snapshot: BattleSnapshot,
  pokemon: PokemonSnapshot,
  entry: OpponentIntelEntry | undefined,
  source: "revealed_switch" | "previewed_switch"
): SwitchTargetPreview {
  const entryProjection = projectSwitchEntry(snapshot, pokemon, "opponent");
  const simulated = createSwitchSnapshot(snapshot, entryProjection.pokemon);
  const damagePreview = entryProjection.fainted ? [] : buildDamagePreview(simulated, {
    likelyDefenderItems: entry?.likelyItems.map((value) => value.name) ?? [],
    likelyDefenderAbilities: entry?.likelyAbilities.map((value) => value.name) ?? [],
    defenderPosterior: entry?.posterior
  }).map((preview) => {
    const withheld = !entryProjection.damageQualified || !entryProjection.hpCertain || (!entryProjection.speedCertain
      && ["gyroball", "electroball"].includes(normalizeName(preview.moveName)));
    const bands = withheld ? withholdEntryDamage(preview.bands, entryProjection.notes, !entryProjection.damageQualified) : preview.bands;
    const delayed = preview.delayed && !entryProjection.damageQualified
      ? { ...preview.delayed, bands: withholdEntryDamage(preview.delayed.bands, entryProjection.notes, true) } : preview.delayed;
    const summary = !entryProjection.damageQualified ? delayed
      ? `${preview.label}: zero immediate damage; conditional eventual matchup is unknown; recipient at impact may change.`
      : buildDamageSummary(preview.label, bands, [])
      : withheld && !preview.delayed ? buildDamageSummary(preview.label, bands, preview.survivalCaveats) : preview.summary;
    return { ...preview, bands, ...(delayed ? { delayed } : {}),
      ...(!entryProjection.damageQualified ? { observedRange: undefined, likelyBandSource: undefined, interactionHints: [], survivalCaveats: [] } : {}),
      summary: [summary, ...entryProjection.notes].join(" ") };
  });
  const hazardInfo = entryProjection;
  return {
    pokemon,
    entry,
    damagePreview,
    hazardDamagePercent: hazardInfo.damagePercent,
    entryFainted: hazardInfo.fainted,
    entryHpUncertain: !hazardInfo.hpCertain,
    entryDamageQualified: hazardInfo.damageQualified,
    entryNotes: hazardInfo.notes,
    stickyWeb: hazardInfo.stickyWeb,
    source
  };
}

function buildSwitchCandidates(params: {
  snapshot: BattleSnapshot;
  activeOpponent: PokemonSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  allOpponentEntries: OpponentIntelEntry[];
}): SwitchTargetPreview[] {
  const activeKey = normalizeName(params.activeOpponent.ident ?? params.activeOpponent.species ?? params.activeOpponent.displayName);
  return params.snapshot.opponentSide.team
    .filter((pokemon) => !pokemon.fainted && !pokemon.active)
    .filter((pokemon) => Boolean(pokemon.species ?? pokemon.displayName))
    .filter((pokemon) => normalizeName(pokemon.ident ?? pokemon.species ?? pokemon.displayName) !== activeKey)
    .map((pokemon) => {
      const entry = params.allOpponentEntries.find((candidate) => pokemon.instanceId ? candidate.instanceId === pokemon.instanceId : normalizeName(candidate.species) === normalizeName(pokemon.species ?? pokemon.displayName));
      return buildSwitchTargetPreview(
        params.snapshot,
        pokemon,
        entry,
        pokemon.revealed ? "revealed_switch" : "previewed_switch"
      );
    })
    .slice(0, 5);
}

function pushUnique(list: string[], value: string | null | undefined) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function switchReplyTiming(snapshot: BattleSnapshot): OpponentActionPrediction["replyTiming"] {
  const active = snapshot.yourSide.active;
  const summary = snapshot.rawRequestSummary;
  if (snapshot.phase !== "turn" || !active || active.fainted || active.hpPercent === 0
    || summary?.requestKind !== "forced_switch") return undefined;
  const unknown = (factIds: string[] = []): NonNullable<OpponentActionPrediction["replyTiming"]> => ({
    status: "unknown", factIds,
    summary: "Opponent action timing is unresolved; damage forecasts are conditional and immediate reply scoring is withheld."
  });
  const evidence = snapshot.canonicalEvidence;
  if (!evidence || evidence.limitations.some((entry) => /recovery|reset/.test(entry)) || active.hpPercent === null) return unknown();
  const facts = evidence.facts;
  const reversed = [...facts].reverse();
  const turnFact = reversed.find((fact) => fact.kind === "turn" && Number(fact.args[0]) === snapshot.turn);
  const requestFact = reversed.find((fact) => fact.kind === "request");
  const turnIndex = turnFact ? facts.indexOf(turnFact) : -1;
  const requestIndex = requestFact ? facts.indexOf(requestFact) : -1;
  if (turnIndex < 0 || requestIndex <= turnIndex) return unknown();
  const parseRequest = (index: number) => {
    try { return JSON.parse(facts[index]!.args[0] ?? "null"); } catch { return null; }
  };
  const request = parseRequest(requestIndex);
  if (!request || request.side?.id !== snapshot.yourSide.slot || request.rqid !== summary.rqid
    || !Array.isArray(request.forceSwitch) || request.forceSwitch[0] !== true || request.wait || request.teamPreview
    || !requestFact!.requestSlots?.some((slot) => slot.appearanceId === active.appearanceId && slot.side === snapshot.yourSide.slot)) return unknown();
  const window = facts.slice(turnIndex, requestIndex);
  const refs = [facts[turnIndex]!.id, facts[requestIndex]!.id];
  const coverage = snapshot.turnCoverage;
  if (!coverage || coverage.source !== "owned_offline_simulator" || coverage.turn !== snapshot.turn
    || coverage.turnFactId !== turnFact!.id || coverage.requestFactId !== requestFact!.id
    || !Number.isInteger(coverage.fromSequence) || !Number.isInteger(coverage.throughSequence)
    || coverage.fromSequence !== turnFact!.source.sequence || coverage.throughSequence < requestFact!.source.sequence
    || active.identityStatus !== "resolved" || snapshot.opponentSide.active?.identityStatus !== "resolved") return unknown(refs);
  if (window.some((fact) => fact.kind === "upkeep" || fact.kind === "win" || fact.kind === "tie")) return unknown(refs);
  const normal = [...window].reverse().find((fact) => {
    if (fact.kind !== "request") return false;
    try {
      const previous = JSON.parse(fact.args[0] ?? "null");
      return previous?.side?.id === snapshot.yourSide.slot && previous.rqid < request.rqid
        && fact.requestSlots?.some((slot) => slot.appearanceId === active.appearanceId && slot.side === snapshot.yourSide.slot)
        && previous.active?.length === 1 && !previous.wait && !previous.teamPreview && !previous.forceSwitch;
    } catch { return false; }
  });
  if (!normal) return unknown(refs);
  const normalIndex = window.indexOf(normal);
  refs.push(normal.id);
  const events = window.slice(normalIndex + 1);
  // Position changes and called moves do not establish expenditure of the
  // opponent's selected action (e.g. forced items, Dancer, or incomplete recovery).
  if (events.some((fact) => fact.subject.side === snapshot.opponentSide.slot
    && (["switch", "drag", "replace"].includes(fact.kind)
      || (["move", "cant"].includes(fact.kind) && fact.subject.appearanceId !== snapshot.opponentSide.active?.appearanceId)))) return unknown(refs);
  // Instruct can emit an untagged extra move; absence of [from] is not enough.
  // Start with a narrow researched event window, leaving other contexts explicit.
  const allowed = new Set(["move", "cant", "-damage", "-supereffective", "-resisted", "-crit", "-immune", "-fail", "-weather", "-enditem"]);
  if (events.some((fact) => !allowed.has(fact.kind)
    || (fact.kind === "move" && (normalizeName(fact.args[1]) === "instruct" || fact.args.some((arg) => arg.startsWith("[from]"))))
    || (fact.kind === "-enditem" && (fact.subject.side !== snapshot.yourSide.slot || normalizeName(fact.args[1]) !== "ejectbutton"))
    || (fact.kind === "-damage" && fact.args.some((arg) => arg.startsWith("[from]"))))) return unknown(refs);
  const opponentActions = events.filter((fact) => fact.subject.side === snapshot.opponentSide.slot
    && (fact.kind === "move" || fact.kind === "cant"));
  const ownMoves = events.filter((fact) => fact.kind === "move" && fact.subject.side === snapshot.yourSide.slot);
  const pivot = ownMoves.length === 1 && ownMoves[0]!.subject.appearanceId === active.appearanceId
    && active.appearanceId && lookupMove(dataGen(snapshot.format), ownMoves[0]!.args[1])?.selfSwitch ? ownMoves[0] : undefined;
  const eject = ownMoves.length === 0 && events.some((fact) => fact.kind === "-enditem");
  if (!pivot && !eject) return unknown(refs);
  if (events.some((fact) => fact.kind === "-weather") && normalizeName(pivot?.args[1]) !== "chillyreception") return unknown(refs);
  const opponentAction = opponentActions.length === 1 ? opponentActions[0] : undefined;
  if (opponentAction && (opponentAction.kind === "move"
    || ["par", "frz", "flinch", "recharge", "nopp", "truant"].includes(normalizeName(opponentAction.args[1])))) return { status: "spent", factIds: [...refs, opponentAction.id],
    summary: "Opponent already used its action this turn; damage forecasts describe a later exchange, not another immediate attack." };
  if (opponentActions.length || !pivot
    || events.slice(events.indexOf(pivot) + 1).some((fact) => ["-fail", "-immune", "cant", "faint"].includes(fact.kind))) return unknown(refs);
  return { status: "pending", factIds: [...refs, pivot.id],
    summary: "Opponent has not used its queued action this turn; it may hit the replacement. Its committed choice remains hidden." };
}

function buildAttackCandidates(params: {
  snapshot: BattleSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  opponentThreatPreview: ThreatPreview[];
  playerPressure: { entry: DamagePreview; band: DamageAssumptionBand | null } | null;
  switchTargets: SwitchTargetPreview[];
  replyTiming?: OpponentActionPrediction["replyTiming"];
}): OpponentActionCandidate[] {
  const candidates: OpponentActionCandidate[] = [];
  const gen = dataGen(params.snapshot.format);
  const active = params.snapshot.yourSide.active;
  const useReplacementForecasts = Boolean(active && (active.fainted || (active.hpPercent ?? 100) <= 0)) || params.replyTiming?.status === "pending";
  const relation = useReplacementForecasts ? "unknown" : opponentMoveOrderRelation(params.snapshot, params.opponentThreatPreview[0]?.currentTarget?.relation ?? "unknown");
  // A replacement forecast supports the reply, never damage to the outgoing mon.
  // Use its strongest supported band; the recommender evaluates each target separately.
  const attackPreviews = params.opponentThreatPreview.filter((entry) => !lookupMove(gen, entry.moveName)?.flags.futuremove).map((entry) => ({
    entry,
    band: useReplacementForecasts
      ? entry.switchTargets.filter((target) => params.replyTiming?.status !== "pending"
        || (target.instanceId && params.snapshot.legalActions.some((action) => action.kind === "switch"
          && !action.disabled && action.legality !== "disabled" && !action.reviving && action.targetInstanceId === target.instanceId)))
        .map((target) => likelyBand(target.bands))
        .filter((band) => isDamagingBand(band) && Number.isFinite(band?.minPercent) && Number.isFinite(band?.maxPercent))
        .sort((a, b) => bandThreatScore(b) - bandThreatScore(a))[0] ?? null
      : likelyBand(entry.currentTarget.bands)
  }));
  const bestKnownAttack = attackPreviews
    .filter(({ entry }) => entry.moveSource === "known")
    .sort((a, b) => bandThreatScore(b.band) - bandThreatScore(a.band))[0] ?? null;
  const safeSwitchExists = params.switchTargets.some((target) => {
    if (target.entryFainted || target.entryHpUncertain || !target.entryDamageQualified) return false;
    const bestIntoSwitch = summarizeBestDamage(target.damagePreview);
    const band = bestIntoSwitch?.band;
    return Boolean(band && bandHpLossMax(band) !== null
      && band.immediate?.ko === "no_ko"
      && bandHpLossMax(band) !== null && bandHpLossMax(band)! <= 40 && target.hazardDamagePercent <= 16.7);
  });
  const hazardsPunishMostSwitches = params.switchTargets.length > 0 && params.switchTargets.every((target) => target.hazardDamagePercent >= 12.5);
  // One move used this stint plus a possible Choice item: repeating it is the likely click.
  const opponentActive = params.snapshot.opponentSide.active;
  const choiceIds = ["choiceband", "choicespecs", "choicescarf"];
  // A Choice Scarf the turn order implies is as certain as a revealed Choice item (the guards treat it so too).
  const choiceKnown = choiceIds.includes(normalizeName(opponentActive?.item)) || choiceScarfImplied(opponentActive, params.activeOpponentEntry?.speedEvidence);
  const choicePossible = choiceKnown || (!opponentActive?.item && !opponentActive?.removedItem
    && [...(params.activeOpponentEntry?.likelyItems ?? []), ...battlePosteriorItems(params.activeOpponentEntry)]
      .some((entry) => choiceIds.includes(normalizeName(entry.name)) && entry.share > 0));
  const stintMoves = opponentActive?.appearanceMoves ?? [];
  const lockedMove = choicePossible && stintMoves.length === 1 ? normalizeName(stintMoves[0]) : null;
  const opponentReserveCount = livingReserveCount(params.snapshot.opponentSide.team);
  const playerReserveCount = livingReserveCount(params.snapshot.yourSide.team);

  for (const { entry: threat, band } of attackPreviews) {
    if (!moveCurrentlyUsable(params.snapshot, params.snapshot.opponentSide.active, threat.moveName)) {
      continue;
    }
    if (!isDamagingBand(band)) continue;

    const hiddenMove = threat.moveSource === "likely";
    const hiddenSupported = hiddenMove ? hasSupportedHiddenMove(params.activeOpponentEntry, threat.moveName) : true;
    const bestKnownBand = bestKnownAttack?.band ?? null;
    const hiddenClearlyBetter = hiddenMove && (
      bandKoScore(band) > bandKoScore(bestKnownBand)
      || bandAveragePercent(band) >= bandAveragePercent(bestKnownBand) + 18
    );
    if (hiddenMove && !hiddenSupported && !hiddenClearlyBetter) {
      continue;
    }

    const reasons: string[] = [];
    const riskFlags: string[] = [];
    if (band?.immediate.note && (band.immediate.ko === "conditional" || band.immediate.ko === "unknown" || band.immediate.ko === "no_ko")) riskFlags.push(band.immediate.note);
    if (useReplacementForecasts) {
      pushUnique(reasons, "damage available into living replacements");
      pushUnique(riskFlags, "attack value depends on the replacement");
    }
    let score = 12;
    const moveData = lookupMove(gen, threat.moveName);
    const pivotMove = Boolean(moveData?.selfSwitch) || ["uturn", "voltswitch", "flipturn"].includes(normalizeName(threat.moveName));
    const avgPercent = bandAveragePercent(band);
    const coverageScore = bandKoScore(band);
    score += avgPercent * 0.55;
    score += coverageScore === 2 ? 28 : coverageScore === 1 ? 14 : 0;
    score += attackOrderBonus(relation);
    score += hiddenMove ? (hiddenSupported ? 4 : -6) : 8;
    if (lockedMove && normalizeName(threat.moveName) === lockedMove) {
      score += choiceKnown ? 30 : 14;
      pushUnique(reasons, `${choiceKnown ? "" : "may be "}Choice-locked into ${threat.moveName}`);
    }

    if (relation === "faster" && coverageScore === 2) {
      pushUnique(reasons, "faster and can KO");
    } else if (relation === "faster" && coverageScore === 1) {
      pushUnique(reasons, "faster and has a KO roll");
    } else if (avgPercent >= 60) {
      pushUnique(reasons, hiddenMove ? "likely coverage move available" : "best known damage line");
    }

    if (hiddenMove) {
      pushUnique(reasons, "likely coverage move available");
      pushUnique(riskFlags, "depends on hidden-move inference");
    }

    if (pivotMove && safeSwitchExists) {
      score += 10;
      pushUnique(reasons, "pivot keeps initiative");
      if (earlyTurn(params.snapshot)) {
        score += 6;
        pushUnique(reasons, "early-game pivot keeps momentum flexible");
      }
    }

    if (params.playerPressure?.band && relation !== "faster") {
      if (params.playerPressure.band.immediate?.ko === "all_rolls") {
        score -= safeSwitchExists ? 24 : 10;
        pushUnique(riskFlags, "staying risks losing the current mon");
      } else if (params.playerPressure.band.immediate?.ko === "some_rolls") {
        score -= safeSwitchExists ? 14 : 6;
        pushUnique(riskFlags, "player has a live KO roll if they attack");
      }
    }

    if (hazardsPunishMostSwitches) {
      score += 8;
      pushUnique(reasons, "hazards punish switch");
    }

    if (earlyTurn(params.snapshot) && coverageScore === 0 && !pivotMove) {
      score -= 4;
    }

    if (lateTurn(params.snapshot)) {
      score += 4;
      pushUnique(reasons, "later turn favors immediate damage");
      if (opponentReserveCount <= 1) {
        score += 6;
        pushUnique(reasons, "few reserves left makes immediate trades stronger");
      }
      if (veryLateTurn(params.snapshot) && coverageScore >= 1) {
        score += 4;
      }
    }

    if (playerReserveCount <= 1 && coverageScore >= 1) {
      score += 4;
      pushUnique(reasons, "player has fewer pivots left to absorb damage");
    }

    if (relation === "overlap") {
      pushUnique(riskFlags, "speed still overlaps");
    }
    if (relation === "unknown" && params.replyTiming?.status !== "pending") {
      pushUnique(riskFlags, "move order is still unclear");
    }

    if (!hiddenMove && bestKnownAttack && normalizeName(bestKnownAttack.entry.moveName) === normalizeName(threat.moveName)) {
      pushUnique(reasons, "best known damage line");
    }

    candidates.push({
      type: hiddenMove ? "likely_hidden_move" : "known_move",
      actionClass: "stay_attack",
      label: threat.moveName,
      moveName: threat.moveName,
      source: hiddenMove ? "likely" : "known",
      score: clampScore(score),
      reasons: uniqueStrings(reasons),
      riskFlags: uniqueStrings(riskFlags)
    });
  }

  return candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function buildSwitchActionCandidates(params: {
  snapshot: BattleSnapshot;
  activeOpponent: PokemonSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  switchTargets: SwitchTargetPreview[];
  playerPressure: { entry: DamagePreview; band: DamageAssumptionBand | null } | null;
}): OpponentActionCandidate[] {
  const candidates: OpponentActionCandidate[] = [];
  const opponentReserveCount = livingReserveCount(params.snapshot.opponentSide.team);
  if (opponentReserveCount <= 0) return candidates;
  const yourOrderRelation = relationAfterTrickRoomFromYourPerspective(
    params.snapshot,
    params.activeOpponentEntry?.activeSpeedRelation ?? "unknown"
  );
  const playerMovesFirst = yourOrderRelation === "faster";
  const playerCoverage = params.playerPressure?.band?.immediate?.ko ?? "unknown";
  const currentUnderImmediateThreat = playerMovesFirst && (playerCoverage === "all_rolls" || playerCoverage === "some_rolls");
  const regeneratorLikely = normalizeName(params.activeOpponent.ability ?? params.activeOpponentEntry?.revealedAbility ?? params.activeOpponentEntry?.likelyAbilities[0]?.name) === "regenerator";

  for (const target of params.switchTargets) {
    const bestIntoSwitch = summarizeBestDamage(target.damagePreview);
    const band = target.entryDamageQualified ? bestIntoSwitch?.band ?? null : null;
    const reasons: string[] = [];
    const riskFlags: string[] = [];
    let score = 8;

    if (currentUnderImmediateThreat) {
      score += playerCoverage === "all_rolls" ? 36 : 24;
      pushUnique(reasons, "slower and threatened by KO");
    } else if (bandAveragePercent(params.playerPressure?.band) >= 60) {
      score += 12;
      pushUnique(reasons, "current position is under heavy damage pressure");
    }

    if (regeneratorLikely && Number(params.activeOpponent.hpPercent ?? 100) < 90) {
      score += 8;
      pushUnique(reasons, "Regenerator rewards pivoting");
    }

    if (Number(params.activeOpponent.hpPercent ?? 100) <= 35 && opponentReserveCount > 0) {
      score += 6;
      pushUnique(reasons, "low HP makes preservation attractive");
    }

    if (lateTurn(params.snapshot) && Number(params.activeOpponent.hpPercent ?? 100) <= 70) {
      score += 5;
      pushUnique(reasons, "later turn makes preservation more valuable");
    }

    if (!band) {
      pushUnique(riskFlags, "immediate switch damage is unknown");
    } else if (isImmuneOrBlockedBand(band)) {
      score += 28;
      pushUnique(reasons, "obvious immunity or hard stop on board");
    } else if (band.immediate?.ko === "no_ko" && bandHpLossMax(band) !== null && bandHpLossMax(band)! <= 35) {
      score += 24;
      pushUnique(reasons, "switch target absorbs your best attacks");
    } else if (band.immediate?.ko === "no_ko" && bandHpLossMax(band) !== null && bandHpLossMax(band)! <= 50) {
      score += 12;
      pushUnique(reasons, target.source === "previewed_switch" ? "known reserve looks safer than staying" : "revealed pivot is safer than staying");
    } else if (band.immediate?.ko === "some_rolls") {
      score -= 12;
      pushUnique(riskFlags, target.source === "previewed_switch" ? "best known reserve can still take a heavy hit" : "best revealed switch can still take a heavy hit");
    } else if (band.immediate?.ko === "all_rolls") {
      score -= 24;
      pushUnique(riskFlags, target.source === "previewed_switch" ? "best known reserve can still be punished hard" : "best revealed switch can still be punished hard");
    }

    if (target.hazardDamagePercent >= 25) {
      score -= 24;
      pushUnique(riskFlags, "entry hazards punish this switch heavily");
    } else if (target.hazardDamagePercent >= 12.5) {
      score -= 12;
      pushUnique(riskFlags, "entry hazards tax this switch");
    }
    if (target.hazardDamagePercent > 0 && target.hazardDamagePercent < 12.5) {
      pushUnique(riskFlags, "light hazard chip still matters on entry");
    }
    if (target.stickyWeb) {
      score -= 4;
      pushUnique(riskFlags, "Sticky Web cuts Speed on entry");
    }

    if (opponentReserveCount <= 1 && !currentUnderImmediateThreat) {
      score -= 8;
      pushUnique(riskFlags, "few reserves left makes switching less attractive now");
    }

    if (lateTurn(params.snapshot) && target.hazardDamagePercent > 0) {
      score -= 4;
    }

    if (target.entryFainted) { score -= 100; reasons.length = 0; riskFlags.unshift("entry hazards KO this switch target before any reply"); }
    for (const note of target.entryNotes) pushUnique(riskFlags, note);
    candidates.push({
      type: "likely_switch",
      actionClass: "switch",
      label: `Switch to ${target.pokemon.species ?? target.pokemon.displayName ?? "reserve"}`,
      switchTargetSpecies: target.pokemon.species ?? target.pokemon.displayName ?? "reserve",
      switchTargetPlayerPreview: target.damagePreview,
      source: target.source,
      score: clampScore(score),
      reasons: uniqueStrings(reasons),
      riskFlags: uniqueStrings(riskFlags)
    });
  }

  return candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function buildStatusCandidates(params: {
  snapshot: BattleSnapshot;
  activeOpponent: PokemonSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  opponentThreatPreview: ThreatPreview[];
  playerPressure: { entry: DamagePreview; band: DamageAssumptionBand | null } | null;
  bestAttackScore: number;
}): OpponentActionCandidate[] {
  const gen = dataGen(params.snapshot.format);
  const opponentReserveCount = livingReserveCount(params.snapshot.opponentSide.team);
  const playerReserveCount = livingReserveCount(params.snapshot.yourSide.team);
  const movePool = [
    ...params.activeOpponent.knownMoves.map((name) => ({ name, source: "known" as const })),
    ...(params.activeOpponentEntry?.metaMovePrior?.moves ?? []).map((move) => ({ name: move.name, source: "likely" as const })),
    ...(params.activeOpponentEntry?.likelyMoves ?? [])
      .filter((entry) => !params.activeOpponent.knownMoves.some((moveName) => normalizeName(moveName) === normalizeName(entry.name)))
      .filter((entry) => entry.confidenceTier === "usable" || entry.confidenceTier === "strong" || entry.share >= 0.45)
      .slice(0, 3)
      .map((entry) => ({ name: entry.name, source: "likely" as const }))
  ];

  const uniqueMoves = new Map<string, { name: string; source: "known" | "likely" }>();
  for (const move of movePool) {
    const moveId = normalizeName(move.name);
    if (!moveId || uniqueMoves.has(moveId)) continue;
    uniqueMoves.set(moveId, move);
  }

  const playerBand = params.playerPressure?.band ?? null;
  const safeBoard = Boolean(playerBand && playerBand.immediate?.ko === "no_ko"
    && bandHpLossMax(playerBand) !== null && bandHpLossMax(playerBand)! <= 35);
  const candidates: OpponentActionCandidate[] = [];

  for (const move of uniqueMoves.values()) {
    if (!moveCurrentlyUsable(params.snapshot, params.activeOpponent, move.name)) continue;
    const moveData = lookupMove(gen, move.name);
    if (!moveData || (moveData.category !== "Status" && !moveData.flags.futuremove)) continue;
    if (moveData.flags.futuremove) {
      const delayed = statusThreatPreviewForMove(params.opponentThreatPreview, move.name)?.currentTarget.delayed
        ?? buildDelayedDamagePreview(params.snapshot, move.name, params.snapshot.yourSide.slot === "p2" ? "p2" : "p1", []);
      if (!delayed) continue;
      const pressure = delayed.scheduling === "clear" ? Math.min(12, bandAveragePercent(likelyBand(delayed.bands)) * 0.12) : 0;
      const riskFlags = ["zero immediate damage; your ordinary action is not prevented", "recipient at impact and caster state may change"];
      let score = (move.source === "known" ? 12 : 6) + pressure;
      if (delayed.scheduling === "occupied") { score -= 60; riskFlags.unshift("target slot already has a pending attack; another cast fails"); }
      if (delayed.scheduling === "unknown") { score -= 8; riskFlags.unshift("scheduling is unknown from this capture"); }
      if (playerBand?.immediate?.ko === "all_rolls") { score -= 26; riskFlags.push("the player can still KO before the delayed impact"); }
      else if (playerBand?.immediate?.ko === "some_rolls") { score -= 14; riskFlags.push("the player retains an immediate KO roll"); }
      if (move.source === "likely") riskFlags.push("depends on hidden-move inference");
      candidates.push({ type: move.source === "known" ? "known_status_or_setup" : "likely_status_or_setup", actionClass: "status_or_setup", label: move.name,
        moveName: move.name, source: move.source, score: clampScore(score), reasons: pressure > 0 ? ["conditional delayed pressure; heuristic value capped at 12"] : [], riskFlags });
      continue;
    }

    const reasons: string[] = [];
    const riskFlags: string[] = [];
    let score = 14;
    const matchingThreat = statusThreatPreviewForMove(params.opponentThreatPreview, move.name);
    const currentBand = likelyBand(matchingThreat?.currentTarget?.bands);
    const liveSwitchStatusCount = (matchingThreat?.switchTargets ?? [])
      .map((target) => likelyBand(target.bands))
      .filter((band) => band?.outcome === "status")
      .length;
    const sideCondition = normalizeName(String(moveData.sideCondition ?? ""));
    const hasBoosts = Boolean(moveData.boosts) || Boolean(moveData.self?.boosts);
    const selfTargeting = String(moveData.target ?? "") === "self";
    const recoveryMove = Boolean(moveData.heal) || /recover|roost|slackoff|softboiled|moonlight|morningsun|wish/i.test(moveData.name);
    const targetedStatus = moveTargetsSpecificFoe(moveData) && (Boolean(moveData.status) || Boolean(moveData.volatileStatus));
    const hazardMove = ["stealthrock", "spikes", "toxicspikes", "stickyweb"].includes(sideCondition);
    const lowHp = Number(params.activeOpponent.hpPercent ?? 100) <= 60;

    if (safeBoard) {
      score += 20;
      pushUnique(reasons, "safe enough board for setup/status");
    } else if (playerBand?.immediate?.ko === "all_rolls") {
      score -= 30;
      pushUnique(riskFlags, "can be punished immediately if the player attacks");
    } else if (playerBand?.immediate?.ko === "some_rolls") {
      score -= 16;
      pushUnique(riskFlags, "player still has a strong punish line");
    }

    if (hasBoosts || selfTargeting) {
      score += 10;
      pushUnique(reasons, "setup line is available");
    }

    if (earlyTurn(params.snapshot) && (hazardMove || hasBoosts || selfTargeting)) {
      score += 8;
      pushUnique(reasons, "early turn still rewards setup");
      if (hazardMove && playerReserveCount >= 2) {
        score += 6;
        pushUnique(reasons, "player still has multiple reserves to pressure with hazards");
      }
    }

    if (recoveryMove) {
      if (lowHp) {
        score += 14;
        pushUnique(reasons, "recovery line is live");
      } else {
        score -= 5;
      }
    }

    if (hazardMove) {
      const yourConditions = params.snapshot.field.yourSideConditions.map((value) => normalizeName(value));
      if (!yourConditions.includes(sideCondition)) {
        score += 8;
        pushUnique(reasons, "hazard line is still available");
        if (playerReserveCount <= 1) {
          score -= 8;
          pushUnique(riskFlags, "fewer player reserves lowers the payoff of new hazards");
        }
      } else {
        score -= 5;
      }
    }

    if (lateTurn(params.snapshot) && (hazardMove || hasBoosts || selfTargeting) && !recoveryMove) {
      score -= 10;
      pushUnique(riskFlags, "late turn makes slower setup lines less attractive");
      if (opponentReserveCount <= 1) {
        score -= 6;
      }
    }

    if (lateTurn(params.snapshot) && recoveryMove && lowHp) {
      score += 4;
      pushUnique(reasons, "late turn recovery can preserve a win path");
    }

    if (targetedStatus) {
      if (currentBand?.outcome === "status") {
        score += 8;
        pushUnique(reasons, "status line is live into your active");
      } else if (currentBand?.outcome === "immune" || currentBand?.outcome === "blocked") {
        score -= 26;
        pushUnique(riskFlags, "your active can ignore or block this status");
        if (liveSwitchStatusCount > 0 && playerReserveCount > 0) {
          score += liveSwitchStatusCount >= 2 ? 8 : 5;
          pushUnique(reasons, "status mainly punishes a switch, not the current target");
        }
      }
    }

    if (move.source === "likely") {
      score += 2;
      pushUnique(riskFlags, "depends on hidden-move inference");
    } else {
      score += 6;
    }

    if (params.bestAttackScore >= score + 16) {
      score -= 8;
    }

    candidates.push({
      type: move.source === "known" ? "known_status_or_setup" : "likely_status_or_setup",
      actionClass: "status_or_setup",
      label: move.name,
      moveName: move.name,
      source: move.source,
      score: clampScore(score),
      reasons: uniqueStrings(reasons),
      riskFlags: uniqueStrings(riskFlags)
    });
  }

  return candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function confidenceTier(params: {
  topClassScore: number;
  runnerUpScore: number;
  topAction: OpponentActionCandidate | undefined;
}) {
  const gap = params.topClassScore - params.runnerUpScore;
  if (!params.topAction || params.topClassScore < 24) return "low" as const;
  if (params.topClassScore >= 62 && gap >= 18 && params.topAction.riskFlags.length <= 1) return "high" as const;
  if (params.topClassScore >= 38 && gap >= 8) return "medium" as const;
  return "low" as const;
}

function topSwitchTargets(switchCandidates: OpponentActionCandidate[]) {
  if (!Array.isArray(switchCandidates) || switchCandidates.length === 0) return [];
  const leaderScore = Number(switchCandidates[0]?.score ?? 0);
  return switchCandidates.filter((candidate, index) => (
    index < 4
    || Number(candidate.score ?? 0) >= leaderScore - 10
  ));
}

export function buildOpponentActionPrediction(params: {
  snapshot: BattleSnapshot;
  activeOpponentEntry?: OpponentIntelEntry | undefined;
  allOpponentEntries?: OpponentIntelEntry[] | undefined;
  playerDamagePreview?: DamagePreview[] | undefined;
  opponentThreatPreview?: ThreatPreview[] | undefined;
}): OpponentActionPrediction | undefined {
  const activeOpponent = params.snapshot.opponentSide.active;
  const playerDamagePreview = Array.isArray(params.playerDamagePreview) ? params.playerDamagePreview : [];
  const opponentThreatPreview = Array.isArray(params.opponentThreatPreview) ? params.opponentThreatPreview : [];
  const replyTiming = switchReplyTiming(params.snapshot);
  if (replyTiming && (replyTiming.status !== "pending" || !activeOpponent || (playerDamagePreview.length === 0 && opponentThreatPreview.length === 0))) return {
    replyTiming, topActionClass: "unknown", confidenceTier: "low", topActions: [], topSwitchTargets: [],
    reasons: [], riskFlags: [replyTiming.summary], classScores: { stayAttack: 0, switchOut: 0, statusOrSetup: 0 }
  };
  if (!activeOpponent || (playerDamagePreview.length === 0 && opponentThreatPreview.length === 0)) {
    return undefined;
  }

  const playerPressure = summarizeBestDamage(playerDamagePreview);
  const switchTargets = buildSwitchCandidates({
    snapshot: params.snapshot,
    activeOpponent,
    activeOpponentEntry: params.activeOpponentEntry,
    allOpponentEntries: params.allOpponentEntries ?? []
  });
  const attackCandidates = buildAttackCandidates({
    snapshot: params.snapshot,
    activeOpponentEntry: params.activeOpponentEntry,
    opponentThreatPreview,
    playerPressure,
    switchTargets,
    replyTiming
  });
  const switchCandidates = replyTiming ? [] : buildSwitchActionCandidates({
    snapshot: params.snapshot,
    activeOpponent,
    activeOpponentEntry: params.activeOpponentEntry,
    switchTargets,
    playerPressure
  });
  const statusCandidates = buildStatusCandidates({
    snapshot: params.snapshot,
    activeOpponent,
    activeOpponentEntry: params.activeOpponentEntry,
    opponentThreatPreview,
    playerPressure,
    bestAttackScore: attackCandidates[0]?.score ?? 0
  });

  const classScores = {
    stayAttack: clampScore(attackCandidates[0]?.score ?? 0),
    switchOut: clampScore(switchCandidates[0]?.score ?? 0),
    statusOrSetup: clampScore(statusCandidates[0]?.score ?? 0)
  };

  const classRanking = [
    { key: "stay_attack" as const, score: classScores.stayAttack },
    { key: "switch" as const, score: classScores.switchOut },
    { key: "status_or_setup" as const, score: classScores.statusOrSetup }
  ].sort((a, b) => b.score - a.score);

  const topClassEntry = classRanking[0];
  const topClass = topClassEntry && topClassEntry.score >= 18 ? topClassEntry.key : "unknown";
  const allCandidates = [...attackCandidates, ...switchCandidates, ...statusCandidates]
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 4);
  const rankedSwitchTargets = topSwitchTargets(switchCandidates);

  const reasons = uniqueStrings([
    ...(allCandidates[0]?.reasons ?? []),
    ...(topClass === "switch" && playerPressure?.band?.immediate?.ko === "all_rolls" ? ["slower and threatened by KO"] : []),
    ...(topClass === "stay_attack" && attackCandidates[0]?.reasons.includes("hazards punish switch") ? ["hazards punish switch"] : []),
    ...(topClass === "status_or_setup" && statusCandidates[0]?.reasons.includes("safe enough board for setup/status") ? ["safe enough board for setup/status"] : [])
  ]).slice(0, 4);

  const riskFlags = uniqueStrings([
    ...(replyTiming ? [replyTiming.summary] : []),
    ...(allCandidates[0]?.riskFlags ?? []),
    ...((params.activeOpponentEntry?.likelyTeraTypes?.length ?? 0) > 0 && !activeOpponent.terastallized ? ["unspent Tera can still change this line"] : []),
    ...(switchTargets.length === 0 && params.snapshot.opponentSide.team.some((pokemon) => !pokemon.fainted && !pokemon.active)
      ? ["no safe known reserve switch target is available in the current snapshot"]
      : [])
  ]).slice(0, 4);

  const confidence = confidenceTier({
    topClassScore: classRanking[0]?.score ?? 0,
    runnerUpScore: classRanking[1]?.score ?? 0,
    topAction: allCandidates[0]
  });

  return {
    ...(replyTiming ? { replyTiming } : {}),
    topActionClass: topClass,
    confidenceTier: confidence,
    topActions: allCandidates,
    topSwitchTargets: rankedSwitchTargets,
    reasons,
    riskFlags,
    classScores
  };
}
