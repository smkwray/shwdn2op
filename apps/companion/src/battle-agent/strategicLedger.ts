import { z } from "zod";
import { decisionIdentitySchema } from "../schema.js";
import type { BattlePolicyInput } from "./battleAgent.js";

export const STRATEGIC_LEDGER_MAX_BYTES = 4000;
export const STRATEGIC_LEDGER_TTL_MS = 120_000;
const text = z.string().min(1).max(240);
const evidence = z.array(text).min(1).max(4);
const confidence = z.enum(["low", "medium", "high"]);
/** Model hypotheses only. Free-form expiry/falsifiers never control the host. */
export const strategicPlanSchema = z.object({
  phase: z.enum(["opening", "midgame", "endgame", "emergency"]),
  winConditions: z.array(z.object({ route: text, enablers: z.array(text).max(4), blockers: z.array(text).max(4),
    evidence, confidence, falsifiers: z.array(text).max(4) }).strict()).max(2),
  mustPreserve: z.array(z.object({ pokemonOrRole: text, reason: text, until: text,
    minimumUsableState: text.optional() }).strict()).max(4),
  opponentEndgames: z.array(z.object({ threat: text, currentChecks: z.array(text).max(4),
    failureTrigger: text, evidence, confidence }).strict()).max(2),
  progressGoal: z.object({ nextOneToThreeTurns: text, successEvidence: evidence, abortOn: z.array(text).max(4) }).strict().optional(),
  sacrificeOrder: z.array(z.object({ pokemonOrRole: text, allowedOnlyIf: text, preserveBefore: z.array(text).max(4) }).strict()).max(4).optional(),
  teraPlan: z.object({ preferredUserOrRole: text.nullable(), trigger: text, keepUnspentBecause: text }).strict().optional(),
  hypotheses: z.array(z.object({ claim: text, evidence, confidence, falsifier: text }).strict()).max(3),
  replanTriggers: z.array(text).max(6),
  validUntil: text.optional(),
  notes: z.array(text).max(2)
}).strict();
export type StrategicPlan = z.infer<typeof strategicPlanSchema>;
const bindingSchema = z.object({
  identity: decisionIdentitySchema.extend({ stateRevision: z.number().int().positive(), requestKind: z.string() }).strict(),
  inputResultHash: z.string().min(1), roomId: z.string().min(1), side: z.enum(["p1", "p2"]),
  engineVersion: z.string().min(1), historyRevision: z.string().min(1)
}).strict();
const ledgerSchema = z.object({
  contractVersion: z.literal("battle-strategic-ledger@1"), binding: bindingSchema,
  generatedAt: z.number().finite().nonnegative(), expiresAt: z.number().finite().nonnegative(), plan: strategicPlanSchema
}).strict().superRefine((value, context) => {
  if (value.expiresAt <= value.generatedAt || value.expiresAt - value.generatedAt > STRATEGIC_LEDGER_TTL_MS) {
    context.addIssue({ code: "custom", message: "Invalid ledger lifetime." });
  }
});
export type StrategicLedger = z.infer<typeof ledgerSchema>;
function bounded(value: unknown) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= STRATEGIC_LEDGER_MAX_BYTES; }
  catch { return false; }
}
function binding({ envelope }: BattlePolicyInput) {
  const { identity, snapshot, engineVersion, historyRevision } = envelope.semantic;
  return bindingSchema.parse({ identity, inputResultHash: envelope.resultHash, roomId: snapshot.roomId,
    side: snapshot.yourSide.slot, engineVersion, historyRevision });
}
export function createStrategicLedger(input: BattlePolicyInput, plan: unknown, now = Date.now()): StrategicLedger {
  try {
    if (!Number.isFinite(now) || now < 0 || !bounded(plan)) throw new Error();
    const ledger = ledgerSchema.parse({ contractVersion: "battle-strategic-ledger@1", binding: binding(input),
      generatedAt: now, expiresAt: now + STRATEGIC_LEDGER_TTL_MS, plan: strategicPlanSchema.parse(plan) });
    if (ledger.binding.roomId !== ledger.binding.identity.roomId || !bounded(ledger)) throw new Error();
    return structuredClone(ledger);
  } catch { throw new Error("Invalid or oversized strategic plan."); }
}
export type StrategicLedgerInspection = { status: "valid"; plan: StrategicPlan; ledger: StrategicLedger }
  | { status: "missing" | "invalid" | "expired" | "mismatch" };
export function inspectStrategicLedger(input: BattlePolicyInput, candidate: unknown, now = Date.now(), requiredUntil = now): StrategicLedgerInspection {
  if (candidate === null || candidate === undefined) return { status: "missing" };
  if (!bounded(candidate) || !Number.isFinite(now) || now < 0 || !Number.isFinite(requiredUntil)) return { status: "invalid" };
  let parsed: ReturnType<typeof ledgerSchema.safeParse>;
  try { parsed = ledgerSchema.safeParse(candidate); } catch { return { status: "invalid" }; }
  if (!parsed.success) return { status: "invalid" };
  const ledger = parsed.data;
  if (ledger.generatedAt > now || ledger.expiresAt <= now || ledger.expiresAt <= requiredUntil) return { status: "expired" };
  try {
    const current = binding(input), previous = ledger.binding;
    if (previous.roomId !== previous.identity.roomId || Object.keys(current.identity).some((key) =>
      current.identity[key as keyof typeof current.identity] !== previous.identity[key as keyof typeof previous.identity])
      || current.inputResultHash !== previous.inputResultHash || current.roomId !== previous.roomId || current.side !== previous.side
      || current.engineVersion !== previous.engineVersion || current.historyRevision !== previous.historyRevision) return { status: "mismatch" };
  } catch { return { status: "invalid" }; }
  return { status: "valid", plan: structuredClone(ledger.plan), ledger: structuredClone(ledger) };
}
