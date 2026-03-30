import fs from "node:fs/promises";
import path from "node:path";

import type { ReplayPolicyExample } from "../apps/companion/src/ml/replayPolicyExample.js";
import type { BattleSnapshot, LegalAction, LocalIntelSnapshot } from "../apps/companion/src/types.js";
// The extension parser is the canonical reducer for battle protocol.
// It is imported directly here so replay extraction stays aligned with the live capture path.
import { applyRawFrameToRoomMap, roomToSnapshot } from "../apps/extension/lib/showdown-parser.js";

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

function moveActionId(moveName: string) {
  return `move:${normalizeName(moveName)}`;
}

function switchActionId(speciesName: string) {
  return `switch:${normalizeName(speciesName)}`;
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

function parseObservedAction(line: string, preTurnRoom: any): ObservedAction | null {
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
      actionId: moveActionId(moveName),
      kind: "move",
      label: moveName,
      moveName,
      revealedThisTurn: !Array.isArray(active?.knownMoves) || !active.knownMoves.includes(moveName)
    };
  }

  if (parsed.tag === "switch" && !PIVOT_SWITCH_RE.test(line)) {
    const side = actingSideFromIdent(parsed.args[0]);
    const species = sanitizeSpecies(parsed.args[1]);
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
    actions.push({
      id: moveActionId(moveName),
      kind: "move",
      label: moveName,
      moveName
    });
  }

  for (const pokemon of Object.values(sideState?.team ?? {})) {
    const speciesName = (pokemon as any)?.species ?? (pokemon as any)?.displayName ?? null;
    if ((pokemon as any)?.fainted || (pokemon as any)?.active || !speciesName) continue;
    actions.push({
      id: switchActionId(speciesName),
      kind: "switch",
      label: `Switch to ${speciesName}`,
      target: speciesName
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

function snapshotForSide(preTurnRoom: any, side: SideId, observedAction: ObservedAction) {
  const clonedRoom = structuredClone(preTurnRoom);
  clonedRoom.playerSide = side;
  clonedRoom.opponentSideId = side === "p1" ? "p2" : "p1";
  clonedRoom.phase = "turn";
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

export async function extractReplayExamples(source: ReplaySource, context: ReplayExtractionContext): Promise<ReplayPolicyExample[]> {
  const roomMap = new Map<string, any>();
  const preTurnRooms = new Map<number, any>();
  const actionsByTurn = new Map<number, Partial<Record<SideId, ObservedAction>>>();
  let currentTurn = 0;

  const packet = (line: string) => `>${source.roomId}\n${line}\n`;

  for (const rawLine of source.lines) {
    const line = rawLine.replace(/\r/g, "");
    if (line.startsWith("|turn|")) {
      applyRawFrameToRoomMap(roomMap, packet(line));
      currentTurn = Number(line.split("|")[2] ?? currentTurn) || currentTurn;
      const room = roomMap.get(source.roomId);
      if (room) {
        preTurnRooms.set(currentTurn, structuredClone(room));
        actionsByTurn.set(currentTurn, {});
      }
      continue;
    }

    if (currentTurn > 0) {
      const preTurnRoom = preTurnRooms.get(currentTurn);
      const observedAction = preTurnRoom ? parseObservedAction(line, preTurnRoom) : null;
      if (observedAction) {
        const turnActions = actionsByTurn.get(currentTurn) ?? {};
        if (!turnActions[observedAction.side]) {
          turnActions[observedAction.side] = observedAction;
          actionsByTurn.set(currentTurn, turnActions);
        }
      }
    }

    applyRawFrameToRoomMap(roomMap, packet(line));
  }

  const finalRoom = roomMap.get(source.roomId);
  const winnerSide = winnerSideFromRoom(finalRoom);
  const examples: ReplayPolicyExample[] = [];

  for (const [turn, turnActions] of actionsByTurn.entries()) {
    const preTurnRoom = preTurnRooms.get(turn);
    if (!preTurnRoom) continue;
    for (const side of ["p1", "p2"] as const) {
      const observedAction = turnActions[side];
      if (!observedAction) continue;
      const snapshot = snapshotForSide(preTurnRoom, side, observedAction);
      if (!snapshot) continue;
      if (!snapshot.yourSide.active || snapshot.legalActions.length === 0) continue;

      const notes: string[] = [];
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

      examples.push({
        schemaVersion: "replay-policy-example@0.1",
        extractedAt: new Date().toISOString(),
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
        label: {
          actionId: observedAction.actionId,
          kind: observedAction.kind,
          label: observedAction.label,
          moveName: observedAction.moveName,
          switchTargetSpecies: observedAction.switchTargetSpecies,
          revealedThisTurn: observedAction.revealedThisTurn
        },
        candidateFeatures,
        observation: observationFromSnapshot(snapshot),
        notes
      });
    }
  }

  return examples;
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
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(absolutePath, text ? `${text}\n` : "", "utf8");
}

export async function readJsonl<T = unknown>(filePath: string): Promise<T[]> {
  const text = await fs.readFile(path.resolve(filePath), "utf8");
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
