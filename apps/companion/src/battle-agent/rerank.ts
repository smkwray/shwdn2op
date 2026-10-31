import { createHash } from "node:crypto";
import { TRAPPED_SWITCH_ERROR, type MetamonBattlePolicy, type MetamonObservationContext, type MetamonOperation } from "./metamon.js";
import { computeTacticalGuards, flaggedBy, GUARDS_VERSION, type FlagKind, type TacticalGuard } from "./tacticalGuards.js";
import type { BattleDecision, BattlePolicy, BattlePolicyDecideOptions, BattlePolicyInput, DecisionEnvelope } from "./battleAgent.js";
import type { CanonicalDecisionIdentity } from "../state/decisionEngine.js";

/** Residual re-ranker over Metamon's own legal-action distribution; guards from tacticalGuards only. Metamon's raw p and
 * raw pick are always kept. metamon-rerank@2 replaced @1's fixed log-penalties: a rules-certain failure gets no mass; tactical flags keep at most
 * τ jointly. τ and kinds demoted to amber are configuration. The default is the adopted live setting:
 * only the rules-certain failure moves mass. The tactical kinds are warnings, because a confirmed KO is not a mistake:
 * 12 of the 20 executed switch_into_ko fires were deliberate sacks. */
export const RERANKER_VERSION = "metamon-rerank@2";
export const REWEIGHT: Record<FlagKind, "zero" | "cap"> = { delayed_slot_occupied: "zero", hazard_maxed: "zero", pre_move_ko: "cap", setup_dead_end: "cap", switch_into_ko: "cap" };
export interface RerankConfig { tau: number; demoted: FlagKind[] }
export const DEFAULT_RERANK_CONFIG: RerankConfig = { tau: 0.05, demoted: ["pre_move_ko", "setup_dead_end", "switch_into_ko"] };

export interface RerankRecord {
  version: typeof RERANKER_VERSION;
  guardsVersion: typeof GUARDS_VERSION;
  config: RerankConfig;
  seedKey: string;
  rawActionId: string;
  /** null: the worker reported no distribution (team preview, an older wrapper). */
  rawProbabilities: Record<string, number> | null;
  rerankedProbabilities: Record<string, number> | null;
  rerankActionId: string | null;
  flagged: Record<string, FlagKind[]>;
  guards: TacticalGuard[];
}

const sorted = (values: Record<string, number>) => Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const mass = (entries: ReadonlyArray<readonly [string, number]>) => entries.reduce((sum, [, value]) => sum + value, 0);

/** @2: zero the actions flagged as rules-certain failures (unless nothing else has mass), then cap the joint mass of
 * tactically flagged actions at τ with unflagged actions renormalized in Metamon's own proportions; with nothing
 * unflagged, p' = p (there is nowhere to move the mass). */
export function rerankDistribution(raw: Record<string, number>, flagged: Record<string, readonly FlagKind[]>, config: RerankConfig): Record<string, number> {
  if (!(config.tau > 0 && config.tau < 1)) throw new Error("Re-ranker τ must lie strictly between 0 and 1.");
  const rule = (id: string) => (flagged[id] ?? []).some((kind) => REWEIGHT[kind] === "zero") ? "zero"
    : (flagged[id] ?? []).some((kind) => REWEIGHT[kind] === "cap") ? "cap" : "free";
  let entries = sorted(raw);
  const total = mass(entries);
  if (!(total > 0)) throw new Error("Re-ranker requires positive probability mass.");
  const kept = entries.map(([id, p]) => [id, rule(id) === "zero" ? 0 : p] as const);
  if (mass(kept) > 0) entries = kept.map(([id, p]) => [id, p / mass(kept)] as const);
  else entries = entries.map(([id, p]) => [id, p / total] as const);
  const capped = mass(entries.filter(([id]) => rule(id) === "cap")), free = mass(entries.filter(([id]) => rule(id) === "free"));
  if (free > 0 && capped > config.tau) entries = entries.map(([id, p]) => [id, rule(id) === "cap" ? p * config.tau / capped : rule(id) === "free" ? p * (1 - config.tau) / free : p] as const);
  return Object.fromEntries(entries);
}

/** Per-decision uniforms from the battle's per-side seed: stateless, so an offline replay reproduces every pick. */
export function decisionUniforms(seedKey: string): [number, number] {
  const digest = createHash("sha256").update(seedKey).digest();
  return [digest.readUInt32BE(0) / 2 ** 32, digest.readUInt32BE(4) / 2 ** 32];
}

/** An exact sample from p', maximally coupled to Metamon's own sample a ~ p: keep a with probability min(1, p'(a)/p(a)),
 * otherwise draw from (p' − p)+. Unpenalized picks never change (p'(a) ≥ p(a) there), so the arms differ only where a
 * guard fires; the marginal is still exactly p'. */
export function coupledRerankPick(raw: Record<string, number>, reranked: Record<string, number>, rawActionId: string, seedKey: string): string {
  const [keep, draw] = decisionUniforms(seedKey);
  const p = raw[rawActionId] ?? 0, q = reranked[rawActionId] ?? 0;
  if (p > 0 && keep < Math.min(1, q / p)) return rawActionId;
  const residual = sorted(reranked).map(([id, value]) => [id, Math.max(0, value - (raw[id] ?? 0))] as const).filter(([, weight]) => weight > 0);
  const total = residual.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) return rawActionId;
  let x = draw * total;
  for (const [id, weight] of residual) { if (x < weight) return id; x -= weight; }
  return residual.at(-1)![0];
}

export function rerankSeedKey(seed: number, side: string, identity: Pick<CanonicalDecisionIdentity, "rqid" | "stateRevision">) {
  return `${RERANKER_VERSION}:${seed}:${side}:${identity.rqid}:${identity.stateRevision}`;
}

export function rerankDecision(envelope: DecisionEnvelope, rawProbabilities: Record<string, number> | undefined, rawActionId: string, seedKey: string,
  config: RerankConfig = DEFAULT_RERANK_CONFIG): RerankRecord {
  // Kinds the precision audit demoted are warnings: shown amber, never re-ranked.
  const guards = computeTacticalGuards(envelope).guards.map((guard) => config.demoted.includes(guard.kind as FlagKind) ? { ...guard, severity: "amber" as const } : guard);
  const flagged = flaggedBy(guards);
  const base = { version: RERANKER_VERSION, guardsVersion: GUARDS_VERSION, config: structuredClone(config), seedKey, rawActionId, flagged, guards } as const;
  if (!rawProbabilities) return { ...base, rawProbabilities: null, rerankedProbabilities: null, rerankActionId: null };
  const rerankedProbabilities = rerankDistribution(rawProbabilities, flagged, config);
  return { ...base, rawProbabilities, rerankedProbabilities, rerankActionId: coupledRerankPick(rawProbabilities, rerankedProbabilities, rawActionId, seedKey) };
}

export type RerankTraceRow = RerankRecord & { requestId: string; identity: CanonicalDecisionIdentity; mode: "rerank" | "shadow"; executedActionId: string };

/** Actor seat for the evaluation arm. "rerank" executes the re-ranked pick (B1); "shadow" executes Metamon's raw pick
 * and only records what the re-ranker would do (B0 home), so both arms log the same features. The worker commits the
 * executed action through its ordinary human-deviation path; a re-ranked switch is staged before a trapped rejection. */
export class RerankedMetamonPolicy implements BattlePolicy {
  readonly requiresSupportedMechanics: boolean;
  private pending: { input: BattlePolicyInput; raw: string; executed: string } | undefined;
  constructor(private readonly transport: MetamonBattlePolicy, private readonly options: {
    id: string; mode: "rerank" | "shadow"; seed: number; side: "p1" | "p2"; onRecord: (row: RerankTraceRow) => void; config?: RerankConfig;
  }) {
    if (!["rerank", "shadow"].includes(options.mode) || !Number.isSafeInteger(options.seed)) throw new Error("Re-rank seat needs a mode and an integer seed.");
    this.requiresSupportedMechanics = transport.requiresSupportedMechanics;
  }
  get id() { return this.options.id; }

  async observe(data: string, context: MetamonObservationContext, options: MetamonOperation): Promise<void> {
    const pending = this.pending;
    if (pending && pending.executed !== pending.raw && data.split("\n")[0] === TRAPPED_SWITCH_ERROR) {
      await this.transport.stageSwitch(pending.input, pending.executed, options);
      pending.raw = pending.executed;
    }
    await this.transport.observe(data, context, options);
  }

  async decide(input: BattlePolicyInput, options: BattlePolicyDecideOptions): Promise<BattleDecision> {
    const raw = await this.transport.decide(input, options);
    const identity = input.envelope.semantic.identity;
    const record = rerankDecision(input.envelope, this.transport.proposalDistribution(input.requestId), raw.actionId,
      rerankSeedKey(this.options.seed, this.options.side, identity), this.options.config);
    const executed = this.options.mode === "rerank" && record.rerankActionId ? record.rerankActionId : raw.actionId;
    this.pending = { input: structuredClone(input), raw: raw.actionId, executed };
    this.options.onRecord({ ...record, requestId: input.requestId, identity: structuredClone(identity), mode: this.options.mode, executedActionId: executed });
    return { ...raw, actionId: executed, ...(executed !== raw.actionId ? { reason: `Re-ranked (${RERANKER_VERSION}) from Metamon's ${raw.actionId}.` } : {}) };
  }

  async commit(input: BattlePolicyInput, decision: BattleDecision, options: BattlePolicyDecideOptions): Promise<void> {
    await this.transport.commit(input, decision, options);
    this.pending = undefined;
  }

  close() { return this.transport.close(); }
}
