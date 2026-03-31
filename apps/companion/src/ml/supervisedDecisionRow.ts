import type { ReplayPolicyCandidateFeature, ReplayPolicyLabel, ReplaySplitTag, ReplayDeterministicSummary } from "./replayPolicyExample.js";

export interface SupervisedDecisionRow {
  schemaVersion: "supervised-decision-row@0.1";
  exampleId: string;
  splitTag: ReplaySplitTag;
  source: {
    replayFile: string;
    replayKind: "log" | "html";
    format: string;
    roomId: string;
    turn: number;
    actingSide: "p1" | "p2";
    didActingSideWin?: boolean | null | undefined;
  };
  context: {
    phase: string;
    legalActionCount: number;
    weather: string | null;
    terrain: string | null;
    pseudoWeather: string[];
    yourSideConditions: string[];
    opponentSideConditions: string[];
    lastMonYourSide: boolean;
    lastMonOpponentSide: boolean;
  };
  player: {
    activeSpecies: string | null;
    activeHpPercent: number | null;
    activeStatus: string | null;
    activeTypes: string[];
    activeBoosts: Record<string, number>;
    activeKnownMoves: string[];
    reserveSpecies: string[];
  };
  opponent: {
    activeSpecies: string | null;
    activeHpPercent: number | null;
    activeStatus: string | null;
    activeTypes: string[];
    activeKnownMoves: string[];
    reserveSpecies: string[];
    unrevealedReserveCount: number;
  };
  observation: {
    knownMoveCount: number;
    hiddenMoveSlots: number;
    reserveCount: number;
    opponentRevealedCount: number;
    opponentReserveCount: number;
  };
  deterministic?: ReplayDeterministicSummary | undefined;
  candidates: ReplayPolicyCandidateFeature[];
  label: ReplayPolicyLabel & {
    deterministicRank: number | null;
    topDeterministicActionId: string | null;
    topDeterministicScoreGap: number | null;
  };
  notes: string[];
}
