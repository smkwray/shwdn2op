import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ReplayDeterministicSummary, ReplayPolicyExample, ReplaySplitTag } from "../apps/companion/src/ml/replayPolicyExample.js";
import type { BattleSnapshot, LegalAction, LocalIntelSnapshot } from "../apps/companion/src/types.js";
import { DecisionEngine } from "../apps/companion/src/state/decisionEngine.js";
import { roomToSnapshot } from "../apps/extension/lib/showdown-parser.js";

export const DEFAULT_REPLAY_DIR = "replays";
export const DEFAULT_REPLAY_OUTPUT = "ml-artifacts/replay-policy-examples.jsonl";

const PIVOT_SWITCH_RE = /\[from\]\s*(?:U-turn|Volt Switch|Flip Turn|Parting Shot|Baton Pass|Chilly Reception|move: U-turn|move: Volt Switch|move: Flip Turn|move: Parting Shot|move: Baton Pass|move: Chilly Reception)/i;

type SideId = "p1" | "p2";

type ObservedAction = {
  side: SideId;
  actionId: string;
  kind: "move" | "switch";
  label: string;
  moveName?: string | undefined;
  terastallize?: boolean | undefined;
  switchTargetSpecies?: string | undefined;
  revealedThisTurn: boolean;
};

export interface ReplaySource {
  filePath: string;
  replayFile: string;
  replayKind: "log" | "html";
  roomId: string;
  lines: string[];
}

export interface ReplayExtractionContext {
  buildLocalIntelSnapshot: (snapshot: BattleSnapshot) => Promise<LocalIntelSnapshot>;
}

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function moveActionId(moveName: string, terastallize = false) {
  return `move:${normalizeName(moveName)}|tera=${terastallize ? 1 : 0}`;
}

function teraIdentKey(ident: string) {
  return normalizeName(ident.replace(/^(p[12])[a-z]:/, "$1:"));
}

function switchActionId(speciesName: string) {
  return `switch:${normalizeName(speciesName)}`;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function splitTagForBattle(roomId: string): ReplaySplitTag {
  const bucket = stableHash(String(roomId ?? "")) % 100;
  if (bucket < 15) return "gold";
  if (bucket < 30) return "dev";
  return "train";
}

function uniqueById(actions: LegalAction[]) {
  const seen = new Set<string>();
  const result: LegalAction[] = [];
  for (const action of actions) {
    if (!action.id || seen.has(action.id)) continue;
    seen.add(action.id);
    result.push(action);
  }
  return result;
}

function parseProtocolLine(line: string) {
  if (!line.startsWith("|")) {
    return { tag: "", args: [] as string[] };
  }
  const parts = line.split("|");
  return {
    tag: parts[1] ?? "",
    args: parts.slice(2)
  };
}

function decodeBattleLogHtml(text: string) {
  return text
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function roomIdFromHtml(text: string, filePath: string) {
  const replayIdMatch = text.match(/name=["']replayid["'][^>]*value=["']([^"']+)["']/i);
  const raw = replayIdMatch?.[1]?.trim() || path.basename(filePath, path.extname(filePath));
  return raw.startsWith("battle-") ? raw : `battle-${raw}`;
}

export async function listReplayFiles(inputPath: string) {
  const absoluteInput = path.resolve(inputPath);
  const stat = await fs.stat(absoluteInput);
  if (stat.isFile()) return [absoluteInput];
  const entries = await fs.readdir(absoluteInput, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:log|html)$/i.test(entry.name))
    .map((entry) => path.join(absoluteInput, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export async function readReplaySource(filePath: string): Promise<ReplaySource> {
  const absolutePath = path.resolve(filePath);
  const text = await fs.readFile(absolutePath, "utf8");
  if (/\.html$/i.test(absolutePath)) {
    const match = text.match(/<script[^>]*class=["']battle-log-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match?.[1]) {
      throw new Error(`Could not locate battle-log-data in ${absolutePath}`);
    }
    const roomId = roomIdFromHtml(text, absolutePath);
    const protocol = decodeBattleLogHtml(match[1]).replace(/\r/g, "");
    return {
      filePath: absolutePath,
      replayFile: path.basename(absolutePath),
      replayKind: "html",
      roomId,
      lines: protocol.split("\n")
    };
  }

  const lines = text.replace(/\r/g, "").split("\n");
  const header = lines[0]?.startsWith(">") ? lines[0] : null;
  const roomId = (header?.slice(1).trim() || path.basename(absolutePath, path.extname(absolutePath))).replace(/^\s+|\s+$/g, "");
  return {
    filePath: absolutePath,
    replayFile: path.basename(absolutePath),
    replayKind: "log",
    roomId,
    lines: header ? lines.slice(1) : lines
  };
}

function actingSideFromIdent(ident: string | undefined): SideId | null {
  const match = String(ident ?? "").match(/^(p[12])/i);
  return match?.[1] === "p1" || match?.[1] === "p2" ? match[1] : null;
}

function sanitizeSpecies(details: string | undefined) {
  const base = String(details ?? "").split(",")[0]?.trim();
  return base || null;
}

function parseObservedAction(line: string, preTurnRoom: any, teraSides: Set<SideId>): ObservedAction | null {
  const parsed = parseProtocolLine(line);
  if (parsed.tag === "move") {
    const side = actingSideFromIdent(parsed.args[0]);
    const moveName = parsed.args[1]?.trim();
    if (!side || !moveName) return null;
    const active = preTurnRoom?.sides?.[side]?.activeKey
      ? preTurnRoom?.sides?.[side]?.team?.[preTurnRoom.sides[side].activeKey]
      : null;
    return {
      side,
      actionId: moveActionId(moveName, teraSides.has(side)),
      kind: "move",
      label: teraSides.has(side) ? `Tera + ${moveName}` : moveName,
      moveName,
      terastallize: teraSides.has(side),
      revealedThisTurn: !Array.isArray(active?.knownMoves) || !active.knownMoves.includes(moveName)
    };
  }

  if (parsed.tag === "switch" && !PIVOT_SWITCH_RE.test(line)) {
    const side = actingSideFromIdent(parsed.args[0]);
    // The choice targets the existing party member. Its incoming details can
    // use a different forme (e.g. Ogerpon-Teal-Tera after Tera) without changing
    // which switch action was selected in the pre-turn view.
    const knownTarget = Object.values(preTurnRoom?.sides?.[side ?? ""]?.team ?? {}).find(
      (mon: any) => teraIdentKey(mon.ident ?? "") === teraIdentKey(parsed.args[0] ?? "")) as any;
    const species = knownTarget?.species ?? sanitizeSpecies(parsed.args[1]);
    if (!side || !species) return null;
    return {
      side,
      actionId: switchActionId(species),
      kind: "switch",
      label: `Switch to ${species}`,
      switchTargetSpecies: species,
      revealedThisTurn: false
    };
  }

  return null;
}

function inferLegalActions(preTurnRoom: any, side: SideId, observedAction: ObservedAction) {
  const sideState = preTurnRoom?.sides?.[side];
  const active = sideState?.activeKey ? sideState?.team?.[sideState.activeKey] : null;
  if (!active) return [] as LegalAction[];

  const actions: LegalAction[] = [];
  const knownMoves = Array.isArray(active.knownMoves) ? [...active.knownMoves] : [];
  if (observedAction.kind === "move" && observedAction.moveName && !knownMoves.includes(observedAction.moveName)) {
    knownMoves.push(observedAction.moveName);
  }
  for (const moveName of knownMoves) {
    const action: LegalAction = {
      id: moveActionId(moveName),
      kind: "move",
      label: moveName,
      moveName,
      moveSlot: null,
      actorAppearanceId: active.appearanceId,
      terastallize: false
    };
    actions.push(action);
    if (active.teraType && !Object.values(sideState.team).some((mon: any) => mon.terastallized)) {
      actions.push({ ...action, id: moveActionId(moveName, true), label: `Tera + ${moveName}`, terastallize: true });
    }
  }

  for (const pokemon of Object.values(sideState?.team ?? {})) {
    const speciesName = (pokemon as any)?.species ?? (pokemon as any)?.displayName ?? null;
    if ((pokemon as any)?.fainted || (pokemon as any)?.active || !speciesName) continue;
    actions.push({
      id: switchActionId(speciesName),
      kind: "switch",
      label: `Switch to ${speciesName}`,
      target: speciesName,
      targetInstanceId: (pokemon as any).instanceId,
      actorAppearanceId: active.appearanceId
    });
  }

  return uniqueById(actions);
}

function winnerSideFromRoom(room: any): SideId | null {
  const winnerName = String(room?.winner ?? "").trim();
  if (!winnerName) return null;
  for (const side of ["p1", "p2"] as const) {
    if (String(room?.sides?.[side]?.name ?? "").trim() === winnerName) {
      return side;
    }
  }
  return null;
}

function snapshotForSide(preTurnRoom: any, side: SideId, observedAction: ObservedAction, recoveredTeraTypes: Map<string, string>) {
  const clonedRoom = structuredClone(preTurnRoom);
  clonedRoom.playerSide = side;
  clonedRoom.opponentSideId = side === "p1" ? "p2" : "p1";
  clonedRoom.phase = "turn";
  // A player's own Tera type is private knowledge from team selection. Recover
  // it where the replay eventually proves it, without leaking that future
  // reveal into snapshots where this Pokemon is on the opponent's side.
  for (const mon of Object.values(clonedRoom.sides?.[side]?.team ?? {}) as any[]) {
    mon.teraType ??= recoveredTeraTypes.get(teraIdentKey(mon.ident ?? "")) ?? null;
  }
  clonedRoom.legalActions = inferLegalActions(clonedRoom, side, observedAction);
  return roomToSnapshot(clonedRoom) as BattleSnapshot | null;
}

function candidateFeaturesFromIntel(localIntel: LocalIntelSnapshot | undefined) {
  return (localIntel?.selfActionRecommendation?.rankedActions ?? []).map((candidate) => ({
    actionId: candidate.actionId,
    kind: candidate.kind,
    label: candidate.label,
    moveName: candidate.moveName,
    switchTargetSpecies: candidate.switchTargetSpecies,
    deterministicScore: candidate.score,
    scoreBreakdown: candidate.scoreBreakdown,
    reasons: candidate.reasons,
    riskFlags: candidate.riskFlags
  }));
}

function deterministicSummaryFromIntel(localIntel: LocalIntelSnapshot | undefined): ReplayDeterministicSummary | undefined {
  if (!localIntel) return undefined;
  const selfRanked = localIntel.selfActionRecommendation?.rankedActions ?? [];
  const topScore = Number.isFinite(selfRanked[0]?.score) ? Number(selfRanked[0]?.score) : null;
  const secondScore = Number.isFinite(selfRanked[1]?.score) ? Number(selfRanked[1]?.score) : null;
  const topScoreGap = topScore !== null && secondScore !== null ? Number((topScore - secondScore).toFixed(1)) : null;

  return {
    selfActionRecommendation: localIntel.selfActionRecommendation
      ? {
          topActionId: localIntel.selfActionRecommendation.topActionId,
          confidenceTier: localIntel.selfActionRecommendation.confidenceTier,
          topScore,
          secondScore,
          topScoreGap
        }
      : undefined,
    opponentActionPrediction: localIntel.opponentActionPrediction
      ? {
          topActionClass: localIntel.opponentActionPrediction.topActionClass,
          confidenceTier: localIntel.opponentActionPrediction.confidenceTier,
          topActionLabel: localIntel.opponentActionPrediction.topActions[0]?.label ?? null
        }
      : undefined,
    opponentLeadPrediction: localIntel.opponentLeadPrediction
      ? {
          topLeadSpecies: localIntel.opponentLeadPrediction.topLeadSpecies,
          confidenceTier: localIntel.opponentLeadPrediction.confidenceTier
        }
      : undefined,
    playerLeadRecommendation: localIntel.playerLeadRecommendation
      ? {
          topLeadSpecies: localIntel.playerLeadRecommendation.topLeadSpecies,
          confidenceTier: localIntel.playerLeadRecommendation.confidenceTier
        }
      : undefined,
    speedPreview: localIntel.speedPreview
      ? {
          activeRelation: localIntel.speedPreview.activeRelation,
          yourActiveEffectiveSpeed: localIntel.speedPreview.yourActiveEffectiveSpeed ?? null,
          opponentEffectiveSpeedMin: localIntel.speedPreview.effectiveRange?.min ?? null,
          opponentEffectiveSpeedMax: localIntel.speedPreview.effectiveRange?.max ?? null,
          reason: localIntel.speedPreview.reason ?? null
        }
      : undefined,
    hazardSummary: localIntel.hazardSummary ?? null
  };
}

function observationFromSnapshot(snapshot: BattleSnapshot) {
  const knownMoveCount = snapshot.yourSide.active?.knownMoves?.length ?? 0;
  return {
    knownMoveCount,
    hiddenMoveSlots: Math.max(0, 4 - knownMoveCount),
    reserveCount: snapshot.yourSide.team.filter((pokemon) => !pokemon.fainted && !pokemon.active).length,
    opponentRevealedCount: snapshot.opponentSide.team.filter((pokemon) => pokemon.revealed).length,
    opponentReserveCount: snapshot.opponentSide.team.filter((pokemon) => !pokemon.fainted && !pokemon.active).length
  };
}

export async function extractReplayExamples(source: ReplaySource, context: ReplayExtractionContext): Promise<{ examples: ReplayPolicyExample[]; withheld: Record<string, number> }> {
  const withheld: Record<string, number> = {};
  const engine = new DecisionEngine();
  const preTurnRooms = new Map<number, any>();
  const actionsByTurn = new Map<number, Partial<Record<SideId, ObservedAction>>>();
  const recoveredTeraTypes = new Map<string, string>();
  const teraSides = new Set<SideId>();
  let currentTurn = 0;
  let sequence = 0;
  let pendingLines: string[] = [];
  let finalRoom: any;
  const flush = async () => {
    if (!pendingLines.length) return;
    sequence += 1;
    const result = await engine.ingest({
      sessionId: "replay", observationId: `replay:${source.roomId}:${sequence}`, sequence,
      roomId: source.roomId, source: "protocol", data: `>${source.roomId}\n${pendingLines.join("\n")}`
    });
    pendingLines = [];
    finalRoom = result.room;
  };

  for (const rawLine of source.lines) {
    const line = rawLine.replace(/\r/g, "");
    if (line.startsWith("|-terastallize|")) {
      const { args } = parseProtocolLine(line);
      const side = actingSideFromIdent(args[0]);
      if (side && args[0] && args[1]) {
        teraSides.add(side);
        recoveredTeraTypes.set(teraIdentKey(args[0]), args[1]);
      }
    }
    if (line.startsWith("|turn|")) {
      teraSides.clear();
      pendingLines.push(line);
      await flush();
      currentTurn = Number(line.split("|")[2] ?? currentTurn) || currentTurn;
      if (finalRoom) {
        preTurnRooms.set(currentTurn, structuredClone(finalRoom));
        actionsByTurn.set(currentTurn, {});
      }
      continue;
    }

    if (currentTurn > 0) {
      const preTurnRoom = preTurnRooms.get(currentTurn);
      const observedAction = preTurnRoom ? parseObservedAction(line, preTurnRoom, teraSides) : null;
      if (observedAction) {
        const turnActions = actionsByTurn.get(currentTurn) ?? {};
        if (!turnActions[observedAction.side]) {
          turnActions[observedAction.side] = observedAction;
          actionsByTurn.set(currentTurn, turnActions);
        }
      }
    }

    pendingLines.push(line);
  }
  await flush();
  const winnerSide = winnerSideFromRoom(finalRoom);
  const examples: ReplayPolicyExample[] = [];

  for (const [turn, turnActions] of actionsByTurn.entries()) {
    const preTurnRoom = preTurnRooms.get(turn);
    if (!preTurnRoom) continue;
    for (const side of ["p1", "p2"] as const) {
      const observedAction = turnActions[side];
      if (!observedAction) continue;
      const snapshot = snapshotForSide(preTurnRoom, side, observedAction, recoveredTeraTypes);
      if (!snapshot) continue;
      if (!snapshot.yourSide.active || snapshot.legalActions.length === 0) continue;
      if (snapshot.canonicalEvidence?.ambiguities.length) {
        withheld.identity_ambiguous = (withheld.identity_ambiguous ?? 0) + 1;
        continue;
      }

      const notes: string[] = [];
      if (snapshot.yourSide.team.some((mon) => recoveredTeraTypes.has(teraIdentKey(mon.ident ?? "")))) {
        notes.push("Own Tera types proven later in this replay were restored as private team knowledge; opponent future reveals were not restored.");
      }
      if (!snapshot.yourSide.active.teraType && !snapshot.yourSide.team.some((mon) => mon.terastallized)) {
        notes.push("Own Tera type is unrecoverable from this replay; candidate actions omit unknown Tera alternatives.");
      }
      if (observedAction.revealedThisTurn && observedAction.kind === "move") {
        notes.push("Observed move was first revealed on this turn and was injected into legalActions.");
      }
      if ((snapshot.yourSide.active.knownMoves?.length ?? 0) < 4) {
        notes.push("Self-side move list is replay-observed and may omit still-hidden moves.");
      }
      if (snapshot.opponentSide.team.some((pokemon) => !pokemon.revealed)) {
        notes.push("Opponent roster is only partially revealed at this turn.");
      }

      const localIntel = await context.buildLocalIntelSnapshot(snapshot);
      const candidateFeatures = candidateFeaturesFromIntel(localIntel);
      if (!candidateFeatures.some((candidate) => candidate.actionId === observedAction.actionId)) {
        notes.push("Chosen action was not present in deterministic candidate features after extraction.");
      }
      const exampleId = `${snapshot.roomId}|${turn}|${side}`;

      examples.push({
        schemaVersion: "replay-policy-example@0.3",
        exampleId,
        extractedAt: new Date().toISOString(),
        splitTag: splitTagForBattle(snapshot.roomId),
        source: {
          replayFile: source.replayFile,
          replayKind: source.replayKind,
          format: snapshot.format,
          roomId: snapshot.roomId,
          turn,
          actingSide: side,
          actingPlayerName: snapshot.yourSide.name,
          opponentPlayerName: snapshot.opponentSide.name,
          winnerSide,
          didActingSideWin: winnerSide ? winnerSide === side : null
        },
        snapshot,
        deterministic: deterministicSummaryFromIntel(localIntel),
        label: {
          actionId: observedAction.actionId,
          kind: observedAction.kind,
          label: observedAction.label,
          moveName: observedAction.moveName,
          terastallize: observedAction.terastallize,
          switchTargetSpecies: observedAction.switchTargetSpecies,
          revealedThisTurn: observedAction.revealedThisTurn
        },
        candidateFeatures,
        observation: observationFromSnapshot(snapshot),
        notes
      });
    }
  }

  return { examples, withheld };
}

export function dedupeExamples(examples: ReplayPolicyExample[]) {
  const byKey = new Map<string, ReplayPolicyExample>();
  for (const example of examples) {
    const key = `${example.source.roomId}|${example.source.turn}|${example.source.actingSide}`;
    const current = byKey.get(key);
    const currentPriority = current?.source.replayKind === "log" ? 2 : 1;
    const nextPriority = example.source.replayKind === "log" ? 2 : 1;
    if (!current || nextPriority > currentPriority) {
      byKey.set(key, example);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.source.format.localeCompare(b.source.format)
    || a.source.roomId.localeCompare(b.source.roomId)
    || a.source.turn - b.source.turn
    || a.source.actingSide.localeCompare(b.source.actingSide)
  );
}

export async function writeJsonl(filePath: string, rows: unknown[]) {
  const absolutePath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
  const file = await fs.open(temporaryPath, "wx");
  try {
    for (const row of rows) {
      const line = JSON.stringify(row);
      if (line === undefined) throw new TypeError("A JSONL row must be serializable JSON.");
      await file.writeFile(`${line}\n`, "utf8");
    }
    await file.close();
    await fs.rename(temporaryPath, absolutePath);
  } catch (error) {
    await file.close();
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readJsonl<T = unknown>(filePath: string): Promise<T[]> {
  const input = createReadStream(path.resolve(filePath), { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const rows: T[] = [];
  try {
    for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line) as T);
    return rows;
  } finally {
    lines.close();
    input.destroy();
  }
}
