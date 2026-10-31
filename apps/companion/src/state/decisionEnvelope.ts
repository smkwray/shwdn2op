import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashCanonical } from "../../../extension/lib/decision-identity.js";
import { buildLocalIntelSnapshot, illusionPresumption, INTEL_STAGES, type IntelEvaluationContext, type IntelStage } from "../history/opponentIntelStore.js";
import type { BattleSnapshot, LocalIntelSnapshot } from "../types.js";
import { DecisionConflict, DecisionEngine, type CanonicalDecisionIdentity } from "./decisionEngine.js";
import { withinDeadline } from "./deadline.js";

// Identify the actual source/build bytes and mechanics data versions, including
// uncommitted development builds. No Git-clean or release claim is implied.
let version: Promise<string> | undefined;
function engineVersion() {
  if (version) return version;
  const build = withinDeadline("engine version", 3000, async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files: Array<[string, string]> = [];
  for (const name of ["schema", "types", "config", "server"]) {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    files.push([name, await fs.readFile(path.join(root, `${name}.${extension}`), "utf8")]);
  }
  for (const dir of ["history", "inference", "mechanics", "prediction", "prompting", "state"]) {
    for (const name of (await fs.readdir(path.join(root, dir))).filter((name) => /\.(?:ts|js)$/.test(name)).sort()) {
      files.push([`${dir}/${name}`, await fs.readFile(path.join(root, dir, name), "utf8")]);
    }
  }
  files.push(["reducer", await fs.readFile(new URL("../../../extension/lib/showdown-parser.js", import.meta.url), "utf8")]);
  files.push(["identity", await fs.readFile(new URL("../../../extension/lib/decision-identity.js", import.meta.url), "utf8")]);
  for (const pkg of ["@pkmn/data", "@pkmn/dex", "@smogon/calc"]) {
    const metadata = JSON.parse(await fs.readFile(new URL(`../../../../node_modules/${pkg}/package.json`, import.meta.url), "utf8"));
    files.push([pkg, metadata.version]);
  }
  return `shwdn2op:${await hashCanonical(files)}`;
  });
  version = build;
  void build.catch(() => { if (version === build) version = undefined; });
  return build;
}

export async function evaluateDecision(
  engine: DecisionEngine, sessionId: string, identity: CanonicalDecisionIdentity, context: IntelEvaluationContext
) {
  const current = await engine.assertCurrent(sessionId, identity);
  if (!current.snapshot) throw new DecisionConflict("No canonical private battle view is available.");
  const envelope = await sharedDecisionEnvelope(sessionId, current.snapshot, identity, context, current.room.lastRequest?.side?.pokemon ?? []);
  await engine.assertCurrent(sessionId, identity);
  return envelope;
}

/** The next result for a decision after the stage the caller already has: a partial stage as soon as it is ready, or
 * the complete envelope. Waits at most `waitMs` for something newer, holding no lock, then returns the newest result. */
export async function evaluateDecisionStage(engine: DecisionEngine, sessionId: string, identity: CanonicalDecisionIdentity,
  context: IntelEvaluationContext, after: IntelStage | null, waitMs: number) {
  const current = await engine.assertCurrent(sessionId, identity);
  if (!current.snapshot) throw new DecisionConflict("No canonical private battle view is available.");
  const build = await stagedDecisionBuild(sessionId, current.snapshot, identity, context, current.room.lastRequest?.side?.pokemon ?? []);
  const newer = () => build.stages.filter((entry) => INTEL_STAGES.indexOf(entry.stage) > (after ? INTEL_STAGES.indexOf(after) : -1)).at(-1);
  const until = Date.now() + waitMs;
  while (!build.settled && !newer() && Date.now() < until) {
    await Promise.race([build.changed, new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())))]);
  }
  const result = build.settled ? { stage: null, envelope: structuredClone(await build.final), final: true as const }
    : { ...structuredClone(newer() ?? build.stages.at(-1) ?? { stage: null, envelope: null }), final: false as const };
  await engine.assertCurrent(sessionId, identity);
  return result;
}

// The live advisor, /v1/evaluate and /v1/feedback each built the same deterministic envelope (~40-70 ms of CPU apiece)
// for one decision (2026-10-23). They now share one build per capture session, decision identity, exact snapshot
// content and history revision. Each caller gets its own copy; a failed build is not kept. Its partial stages are kept
// as they complete (each with its own result hash) so a client can show each section the moment it is ready.
type DecisionEnvelope = Awaited<ReturnType<typeof buildDecisionEnvelope>>;
type PartialEnvelope = { semantic: Record<string, unknown> & { stage: IntelStage }; resultHash: string };
type StagedBuild = { stages: Array<{ stage: IntelStage; envelope: PartialEnvelope }>; final: Promise<DecisionEnvelope>; settled: boolean; changed: Promise<void> };
const envelopes = new Map<string, StagedBuild>();
async function stagedDecisionBuild(sessionId: string, snapshot: BattleSnapshot, identity: CanonicalDecisionIdentity,
  context: IntelEvaluationContext, party: Array<{ details?: string }>) {
  const key = JSON.stringify([sessionId, identity, context.revision, context.analysisMode ?? "full", await hashCanonical({ snapshot: { ...snapshot, capturedAt: null }, party })]);
  let build = envelopes.get(key);
  if (!build) {
    let notify = () => {};
    const created: StagedBuild = build = { stages: [], settled: false, changed: new Promise<void>((resolve) => { notify = resolve; }), final: undefined! };
    const changed = () => { const wake = notify; created.changed = new Promise<void>((resolve) => { notify = resolve; }); wake(); };
    created.final = withinDeadline("deterministic envelope", 4000, async () => buildDecisionEnvelope(snapshot, identity, context, party, async (stage, semantic) => {
      created.stages.push({ stage, envelope: { semantic, resultHash: await hashCanonical(semantic) } });
      changed();
    }));
    envelopes.set(key, created);
    while (envelopes.size > 32) envelopes.delete(envelopes.keys().next().value!);
    created.final.then(() => { created.settled = true; changed(); },
      () => { if (envelopes.get(key) === created) envelopes.delete(key); created.settled = true; changed(); });
  }
  return build;
}
export async function sharedDecisionEnvelope(sessionId: string, snapshot: BattleSnapshot, identity: CanonicalDecisionIdentity,
  context: IntelEvaluationContext, party: Array<{ details?: string }> = []) {
  return withinDeadline("deterministic evaluation", 5000, async () =>
    structuredClone(await (await stagedDecisionBuild(sessionId, snapshot, identity, context, party)).final));
}

/** Pure evaluation of an already accepted observation, including intermediate requests in a batch. */
/** Limitations that degrade a part of the analysis (handled where it is built) without withholding the decision. */
const DEGRADED_LIMITATIONS = new Set(["opponent_substitute_active"]);

export async function buildDecisionEnvelope(snapshot: BattleSnapshot, identity: CanonicalDecisionIdentity, context: IntelEvaluationContext,
  party: Array<{ details?: string }> = [], onStage?: (stage: IntelStage, semantic: PartialEnvelope["semantic"]) => Promise<void>) {
  const degraded = (snapshot.canonicalEvidence?.limitations ?? []).filter((value) => DEGRADED_LIMITATIONS.has(value));
  const unsupported = [
    snapshot.canonicalEvidence?.ambiguities.length ? "identity_ambiguous" : null,
    ...(snapshot.canonicalEvidence?.limitations ?? []).filter((value) => !DEGRADED_LIMITATIONS.has(value)),
    context.store.canonicalBattles?.[snapshot.roomId]?.lineageConflict ? "history_lineage_conflict" : null,
    snapshot.legalActions.some((action) => action.reviving) ? "revival_ranking_unavailable" : null,
    snapshot.rawRequestSummary?.capability && snapshot.rawRequestSummary.capability !== "supported" ? String(snapshot.rawRequestSummary.capability) : null,
    /\[Gen\s*9\]/i.test(snapshot.format) ? null : "unsupported_generation"
  ].filter((value): value is string => Boolean(value));
  const { capturedAt: _captureTime, ...semanticSnapshot } = snapshot;
  const actionable = unsupported.length === 0 && snapshot.legalActions.some((action) => !action.disabled)
    && snapshot.rawRequestSummary?.wait !== true && snapshot.phase !== "finished";
  const capabilities = (intel: LocalIntelSnapshot) => ({
    status: unsupported.length ? "unsupported" : "degraded",
    limitations: [...unsupported, ...degraded, ...(intel.opponentActionPrediction?.replyTiming?.status === "unknown" ? ["reply_timing_unknown"] : []), "heuristic_ranking", "uncalibrated_confidence", "damage_evidence_requires_clean_supported_window", "speed_order_requires_known_modifiers"],
    actionable,
    confidenceMeaning: "heuristic decision margin and evidence coverage; not a probability"
  });
  const base = { contractVersion: "showdown-decision@1", engineVersion: await engineVersion(), identity, historyRevision: context.revision };
  // A partial stage carries its name; its sections are exactly the complete result's (cloned when they are ready).
  // A possible Illusion disguise alone does not withhold the sections: they assume the shown species and say so. The
  // decision stays unsupported (no ranking, no guards) because the identity is still uncertain.
  const withheld = unsupported.some((reason) => reason !== "identity_ambiguous") || (unsupported.length > 0 && !await illusionPresumption(snapshot));
  const intel: LocalIntelSnapshot = withheld ? { generatedAt: "", note: unsupported.join(", "), opponents: [] }
    : await buildLocalIntelSnapshot(snapshot, context, onStage && (async (stage, { generatedAt: _partialTime, ...partial }) => {
      // No snapshot on a partial stage: the client already holds this exact view (its identity names the snapshot hash),
      // and the snapshot is most of each stage's bytes. The complete envelope keeps it.
      await onStage(stage, structuredClone({ ...base, stage, capabilities: capabilities(partial as LocalIntelSnapshot), localIntel: partial }));
    }));
  if (!unsupported.length && snapshot.phase === "preview") {
    const team = party;
    const rankedActions = snapshot.legalActions.filter((action) => action.kind === "team").map((action) => {
      const species = String(team[(action.teamSpec?.[0] ?? 1) - 1]?.details ?? "").split(",")[0];
      const lead = intel.playerLeadRecommendation?.topCandidates.find((candidate) => candidate.species === species);
      return {
        actionId: action.id, kind: action.kind, label: action.label, score: lead?.score ?? 0,
        reasons: lead?.reasons ?? [], riskFlags: [...(lead?.riskFlags ?? []), "Only the lead is scored; remaining team order uses a stable tie-break."],
        scoreBreakdown: [{ key: "lead", label: "Preview lead heuristic", value: lead?.score ?? 0 }]
      };
    }).sort((a, b) => b.score - a.score || (a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0));
    if (rankedActions.length) intel.selfActionRecommendation = {
      topActionId: rankedActions[0]!.actionId, rankedActions, confidenceTier: "low",
      reasons: rankedActions[0]!.reasons, riskFlags: rankedActions[0]!.riskFlags,
      summary: rankedActions[0]!.label
    };
  }
  const { generatedAt: _intelTime, ...localIntel } = intel;
  const semantic = { ...base, capabilities: capabilities(intel), snapshot: semanticSnapshot, localIntel };
  return { semantic, resultHash: await hashCanonical(semantic) };
}
