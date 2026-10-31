import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashCanonical } from "../../../extension/lib/decision-identity.js";
import { decisionIdentitySchema } from "../schema.js";
import { DecisionConflict, DecisionEngine, sameCanonicalDecision, type CanonicalDecisionIdentity } from "../state/decisionEngine.js";
import type { evaluateDecision } from "../state/decisionEnvelope.js";

export type DecisionEnvelope = Awaited<ReturnType<typeof evaluateDecision>>;
export const battleDecisionSchema = z.object({
  requestId: z.string().min(1),
  identity: decisionIdentitySchema.extend({ stateRevision: z.number().int().positive(), requestKind: z.string() }).strict(),
  actionId: z.string().min(1),
  reason: z.string().max(1200).optional()
}).strict();
export type BattleDecision = z.infer<typeof battleDecisionSchema>;
export const battleOverrideSchema = z.object({
  cardField: z.string().max(200),
  reason: z.string().max(240)
}).strict();
/** Adapter-only metadata, consumed by the advised policy before BattleAgent.
 * card is the JSON round-trip of the exact Card rendered to the model. */
export interface BattlePolicyProposal extends BattleDecision {
  veto?: { card: unknown; override?: z.infer<typeof battleOverrideSchema> };
}
export type BattleAdviceMode = "suggest" | "veto";
export const battleAdviceSchema = z.object({
  source: z.literal("metamon"),
  policyId: z.literal("metamon:Kakuna:epoch34"),
  requestId: z.string().min(1),
  identity: battleDecisionSchema.shape.identity,
  inputResultHash: z.string().min(1),
  actionId: z.string().min(1),
  mode: z.enum(["suggest", "veto"]).optional()
}).strict();
export type BattleAdvice = z.infer<typeof battleAdviceSchema>;
/** Engine limitations that only degrade the engine's own mechanics analysis; legal actions still come from the request. */
const MECHANICS_ONLY_GAPS = new Set(["substitute_mechanics_unavailable", "suppressed_mechanics_unavailable",
  "temporary_ability_forecasts_unavailable", "transform_mechanics_unavailable"]);
/** Notes every envelope carries; they never make a decision unsupported. */
const DEGRADED_NOTES = new Set(["reply_timing_unknown", "opponent_substitute_active", "heuristic_ranking", "uncalibrated_confidence",
  "damage_evidence_requires_clean_supported_window", "speed_order_requires_known_modifiers"]);
/** Actionable as published, or (for a policy that does not consume engine mechanics) unsupported only by
 * mechanics-analysis gaps with an enabled legal action, no wait and an unfinished battle. Unresolved opposing
 * appearances (an unbroken Illusion disguise) are hidden information that withholds only species-dependent engine
 * analysis; own-side identity gaps stay fail-closed. */
export function actionableFor(envelope: DecisionEnvelope, policy: BattlePolicy): boolean {
  const { capabilities, snapshot } = envelope.semantic;
  if (capabilities.actionable) return true;
  if (policy.requiresSupportedMechanics !== false) return false;
  const opponent = `${snapshot.roomId}:${snapshot.yourSide.slot === "p1" ? "p2" : "p1"}`;
  const ambiguities = snapshot.canonicalEvidence?.ambiguities ?? [];
  const opponentDisguise = ambiguities.length > 0 && ambiguities.every((id) => id.startsWith(opponent) && id.includes(":appearance:"));
  const reasons = capabilities.limitations.filter((reason) => !DEGRADED_NOTES.has(reason));
  return reasons.length > 0 && reasons.every((reason) => MECHANICS_ONLY_GAPS.has(reason) || (reason === "identity_ambiguous" && opponentDisguise))
    && snapshot.legalActions.some((action) => !action.disabled)
    && snapshot.rawRequestSummary?.wait !== true && snapshot.phase !== "finished";
}

export interface BattlePolicyInput { requestId: string; envelope: DecisionEnvelope; advice?: BattleAdvice }

/** An opinion is separate from the canonical envelope and supplies no confidence
 * or mechanics. Only a current, enabled action from this same input can appear. */
export function inspectBattleAdvice(input: BattlePolicyInput): BattleAdvice | undefined {
  if (input.advice === undefined) return;
  const parsed = battleAdviceSchema.safeParse(input.advice);
  const { identity, snapshot } = input.envelope.semantic;
  if (!parsed.success || parsed.data.requestId !== input.requestId
    || parsed.data.inputResultHash !== input.envelope.resultHash
    || !sameCanonicalDecision(parsed.data.identity, identity)
    || (snapshot.phase === "preview" && parsed.data.mode !== "veto")
    || !snapshot.legalActions.some((action) => action.id === parsed.data.actionId && action.choice
      && !action.disabled && action.legality !== "disabled")) throw new DecisionConflict("Battle advice is unavailable for this input.");
  return parsed.data;
}
export interface BattlePolicyDecideOptions {
  deadlineAt: number;
  signal: AbortSignal;
  /** Recheck the captured input identity within the original decision budget. */
  assertCurrent?: () => Promise<void>;
}
export interface BattlePolicyObservationContext {
  roomId: string;
  side: "p1" | "p2";
  format: string;
  sequence: number;
  identity: CanonicalDecisionIdentity | null;
}
export interface BattlePolicy {
  readonly id: string;
  /** False only for policies that choose from the request's legal actions and model battle mechanics
   * themselves (Metamon). They may act through engine mechanics-analysis gaps; see actionableFor. */
  readonly requiresSupportedMechanics?: boolean;
  /** Optional recurrent-policy input: only this player's routed protocol. */
  observe?(data: string, context: BattlePolicyObservationContext, options: { deadlineAt: number; signal: AbortSignal }): Promise<void>;
  decide(input: BattlePolicyInput, options: BattlePolicyDecideOptions): Promise<BattlePolicyProposal>;
  /** Executor acceptance, before routing later observations to a recurrent policy. */
  commit?(input: BattlePolicyInput, decision: BattleDecision, options: BattlePolicyDecideOptions): Promise<void>;
  /** One policy instance belongs to one match; release it on every exit. */
  close?(): Promise<void>;
}
export interface BattleAgentDecision extends BattleDecision {
  contractVersion: "battle-agent-decision@1";
  policyId: string;
  inputResultHash: string;
  deadlineAt: number;
  latencyMs: number;
}

/** Bound the entire operation, including engine locks. A late settlement is
 * consumed; checks inside the operation prevent work continuing after abort. */
export async function withinDeadline<T>(deadlineAt: number, callerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort(callerSignal?.reason);
  const check = () => {
    if (Date.now() >= deadlineAt) controller.abort(new DOMException("Decision timeout: deadline expired.", "TimeoutError"));
    signal.throwIfAborted();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectOnAbort: (() => void) | undefined;
  const armTimer = () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) controller.abort(new DOMException("Decision timeout: deadline expired.", "TimeoutError"));
    else timer = setTimeout(armTimer, Math.min(Math.ceil(remaining), 2_147_483_647));
  };
  try {
    callerSignal?.addEventListener("abort", abort, { once: true });
    if (callerSignal?.aborted) abort();
    check(); armTimer();
    const result = await new Promise<T>((resolve, reject) => {
      rejectOnAbort = () => reject(signal.reason);
      signal.addEventListener("abort", rejectOnAbort, { once: true });
      Promise.resolve().then(() => { check(); return operation(signal, check); }).then(resolve, reject);
    });
    check();
    return result;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
    if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort);
  }
}

/** Owns decision binding, never browser or shell permissions. The policy only
 * proposes an action; a separately authorized executor dispatches its token. */
export class BattleAgent {
  constructor(readonly engine: DecisionEngine, readonly sessionId: string, readonly policy: BattlePolicy) {}

  async decide(envelope: DecisionEnvelope, options: { deadlineMs: number; signal?: AbortSignal; requestId?: string }): Promise<BattleAgentDecision> {
    if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0 || options.deadlineMs > 300_000) throw new Error("Decision deadline must be between 1 and 300000 ms.");
    const requestId = options.requestId ?? randomUUID(), startedAt = Date.now(), deadlineAt = startedAt + options.deadlineMs;
    // Keep the validated input stable even if its caller or a recorder changes
    // the original envelope while hashing, checking freshness or generating.
    const capturedEnvelope = structuredClone(envelope);
    return withinDeadline(deadlineAt, options.signal, async (signal, check) => {
      const resultHash = await hashCanonical(capturedEnvelope.semantic);
      check();
      if (resultHash !== capturedEnvelope.resultHash) throw new DecisionConflict("Invalid input envelope hash.");
      if (!actionableFor(capturedEnvelope, this.policy)) throw new DecisionConflict("Decision is not actionable.");
      const identity = structuredClone(capturedEnvelope.semantic.identity);
      const assertCurrent = async () => {
        check();
        await this.engine.assertCurrent(this.sessionId, identity);
        check();
      };
      await assertCurrent();
      const decision = await this.policy.decide({ requestId, envelope: structuredClone(capturedEnvelope) }, { deadlineAt, signal, assertCurrent });
      check();
      const validation = battleDecisionSchema.safeParse(decision);
      if (!validation.success) throw new DecisionConflict("Policy returned an invalid decision schema.");
      const parsed = validation.data;
      if (parsed.requestId !== requestId || !sameCanonicalDecision(parsed.identity, identity)) throw new DecisionConflict("Policy returned a different decision identity.");
      check();
      const current = await this.engine.assertCurrent(this.sessionId, identity);
      check();
      if (!current.snapshot?.legalActions.some((action) => action.id === parsed.actionId && !action.disabled && action.choice)) throw new DecisionConflict("Policy selected an unavailable action.");
      return { ...parsed, contractVersion: "battle-agent-decision@1", policyId: this.policy.id,
        inputResultHash: resultHash, deadlineAt, latencyMs: Date.now() - startedAt };
    });
  }
}

export class DeterministicBattlePolicy implements BattlePolicy {
  readonly id = "deterministic";
  async decide({ requestId, envelope }: BattlePolicyInput): Promise<BattleDecision> {
    const legal = envelope.semantic.snapshot.legalActions.filter((action) => !action.disabled && action.choice);
    const ranked = envelope.semantic.localIntel.selfActionRecommendation?.rankedActions ?? [];
    const action = ranked.map((entry) => legal.find((action) => action.id === entry.actionId)).find(Boolean)
      ?? [...legal].sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!action) throw new DecisionConflict("No available action for deterministic policy.");
    return { requestId, identity: envelope.semantic.identity, actionId: action.id, reason: "Deterministic candidate ranking; heuristic, not calibrated." };
  }
}

/** Explicit authorization is local to one battle/session. send() dispatches
 * synchronously (e.g. simulator choose or socket send); it must not wait for an
 * observation/ack under the engine lock. Rejections/unknown outcomes are never
 * retried under the same identity. No action-capable HTTP endpoint is exposed. */
export class BattleActionExecutor {
  private authorization: { roomId: string; expiresAt: number } | undefined;
  private dispatched = new Set<string>();
  constructor(readonly engine: DecisionEngine, readonly sessionId: string, private send: (choice: string, identity: CanonicalDecisionIdentity) => boolean) {}
  authorize(roomId: string, expiresAt: number) {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("Battle authorization must expire in the future.");
    this.authorization = { roomId, expiresAt };
  }
  revoke() { this.authorization = undefined; }

  async execute(input: BattleAgentDecision, options: { signal?: AbortSignal } = {}) {
    const validation = battleDecisionSchema.safeParse({ requestId: input.requestId, identity: input.identity, actionId: input.actionId, ...(input.reason === undefined ? {} : { reason: input.reason }) });
    if (!validation.success) throw new DecisionConflict("Invalid execution decision schema.");
    const decision = validation.data;
    if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now()) throw new DecisionConflict("Decision deadline expired before dispatch.");
    return withinDeadline(input.deadlineAt, options.signal, async (_signal, check) => this.engine.withCurrent(this.sessionId, decision.identity, async (current) => {
      check();
      const now = Date.now();
      if (!this.authorization || this.authorization.roomId !== decision.identity.roomId || this.authorization.expiresAt <= now) throw new DecisionConflict("This battle is not authorized for execution.");
      if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= now) throw new DecisionConflict("Decision deadline expired before dispatch.");
      const action = current.snapshot?.legalActions.find((entry) => entry.id === decision.actionId && !entry.disabled && entry.choice);
      if (!action?.choice || current.snapshot?.rawRequestSummary?.wait || current.snapshot?.phase === "finished") throw new DecisionConflict("Action is not currently executable.");
      if (decision.identity.rqid === null) throw new DecisionConflict("Execution requires an authoritative numbered request.");
      // Public observations may change the state hash while the same request
      // is still pending. They do not authorize another submission.
      const key = `${decision.identity.roomId}\n${decision.identity.rqid}`;
      if (this.dispatched.has(key)) throw new DecisionConflict("This decision was already dispatched; await a fresh request.");
      this.dispatched.add(key);
      if (!this.send(action.choice, decision.identity)) throw new DecisionConflict("Transport rejected the action; refresh the request before retrying.");
      return { status: "dispatched" as const, actionId: action.id, choice: action.choice, identity: decision.identity };
    }));
  }
}
