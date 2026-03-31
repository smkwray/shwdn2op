import type { ActionScoreComponent, BattleSnapshot, LegalAction } from "../types.js";

export type ReplaySplitTag = "train" | "dev" | "gold";

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

export interface ReplayDeterministicSummary {
  selfActionRecommendation?: {
    topActionId: string | null;
    confidenceTier: "low" | "medium" | "high";
    topScore: number | null;
    secondScore: number | null;
    topScoreGap: number | null;
  } | undefined;
  opponentActionPrediction?: {
    topActionClass: "stay_attack" | "switch" | "status_or_setup" | "unknown";
    confidenceTier: "low" | "medium" | "high";
    topActionLabel: string | null;
  } | undefined;
  opponentLeadPrediction?: {
    topLeadSpecies: string | null;
    confidenceTier: "low" | "medium" | "high";
  } | undefined;
  playerLeadRecommendation?: {
    topLeadSpecies: string | null;
    confidenceTier: "low" | "medium" | "high";
  } | undefined;
  speedPreview?: {
    activeRelation: "faster" | "slower" | "overlap" | "unknown";
    yourActiveEffectiveSpeed: number | null;
    opponentEffectiveSpeedMin: number | null;
    opponentEffectiveSpeedMax: number | null;
    reason: string | null;
  } | undefined;
  hazardSummary?: string | null | undefined;
}

export interface ReplayPolicyExample {
  schemaVersion: "replay-policy-example@0.1" | "replay-policy-example@0.2";
  exampleId: string;
  extractedAt: string;
  splitTag: ReplaySplitTag;
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
  deterministic?: ReplayDeterministicSummary | undefined;
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
