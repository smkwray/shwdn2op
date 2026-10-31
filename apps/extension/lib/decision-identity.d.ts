export interface DecisionIdentity {
  roomId: string;
  rqid: number | null;
  snapshotHash: string;
  legalActionSetHash: string;
}
export function hashCanonical(value: unknown): Promise<string>;
export function createDecisionIdentity(snapshot: unknown): Promise<DecisionIdentity>;
export function sameDecision(left: DecisionIdentity | null | undefined, right: DecisionIdentity | null | undefined): boolean;
