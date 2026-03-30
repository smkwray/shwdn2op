import type { ActionScoreComponent, BattleSnapshot, LegalAction } from "../types.js";

export interface ReplayPolicyLabel {
  actionId: string;
  kind: Extract<LegalAction["kind"], "move" | "switch">;
  label: string;
  moveName?: string | undefined;
  switchTargetSpecies?: string | undefined;
  revealedThisTurn?: boolean | undefined;
}

export interface ReplayPolicyCandidateFeature {
  actionId: string;
  kind: LegalAction["kind"];
  label: string;
  moveName?: string | undefined;
  switchTargetSpecies?: string | undefined;
  deterministicScore?: number | undefined;
  scoreBreakdown?: ActionScoreComponent[] | undefined;
  reasons: string[];
  riskFlags: string[];
}

export interface ReplayPolicyExample {
  schemaVersion: "replay-policy-example@0.1";
  extractedAt: string;
  source: {
    replayFile: string;
    replayKind: "log" | "html";
    format: string;
    roomId: string;
    turn: number;
    actingSide: "p1" | "p2";
    actingPlayerName?: string | null | undefined;
    opponentPlayerName?: string | null | undefined;
    winnerSide?: "p1" | "p2" | null | undefined;
    didActingSideWin?: boolean | null | undefined;
  };
  snapshot: BattleSnapshot;
  label: ReplayPolicyLabel;
  candidateFeatures: ReplayPolicyCandidateFeature[];
  observation: {
    knownMoveCount: number;
    hiddenMoveSlots: number;
    reserveCount: number;
    opponentRevealedCount: number;
    opponentReserveCount: number;
  };
  notes: string[];
}
