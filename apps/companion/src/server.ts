import fs from "node:fs/promises";
import path from "node:path";

import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { createDecisionIdentity, sameDecision } from "../../extension/lib/decision-identity.js";

import { LiveMetamonAdvisor, decisionTimingSchema, liveEventSchema, readLiveMetamonLaunch } from "./battle-agent/liveMetamon.js";
import { config } from "./config.js";
import { loadMetaMovePriorDescriptor, type MetaMovePrior } from "./history/metaPriorStore.js";
import { analyzeRequestSchema, observeSnapshotRequestSchema, saveReplayRequestSchema, decisionIdentitySchema } from "./schema.js";
import type { AnalyzeResponse } from "./types.js";
import { INTEL_STAGES, buildLocalIntelSnapshot, commitCanonicalSnapshots, captureIntelEvaluationContext, flushIntelStore, intelStorePersistence, recordShownPrediction, type IntelEvaluationContext } from "./history/opponentIntelStore.js";
import { getProvider, getProviderHealth } from "./providers/factory.js";
import { DecisionConflict, DecisionEngine, observationSchema } from "./state/decisionEngine.js";
import { evaluateDecision, evaluateDecisionStage } from "./state/decisionEnvelope.js";

function replayFileName(roomId: string) {
  const safeRoomId = String(roomId ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return `${safeRoomId || "battle-replay"}.log`;
}

export function buildServer(options: { movePriorDescriptor?: string; liveMetamon?: LiveMetamonAdvisor } = {}) {
  const descriptor = options.movePriorDescriptor ?? config.movePriorDescriptor;
  const app = Fastify({ logger: true });
  const instanceId = crypto.randomUUID();
  let movePriors: MetaMovePrior | undefined;
  if (descriptor) {
    app.addHook("onReady", async () => {
      movePriors = await loadMetaMovePriorDescriptor(descriptor, config.repoRoot);
    });
    // Fastify injection may be retried even after readiness rejected.
    app.addHook("onRequest", async () => {
      if (!movePriors) throw new Error("Configured monthly move prior is unavailable.");
    });
  }
  let live = options.liveMetamon;
  const launchFile = process.env.SHWDN2OP_METAMON_LIVE_LAUNCH?.trim();
  // Live games are journaled (private, gitignored) so each one can be replayed exactly offline.
  const journalDir = process.env.SHWDN2OP_METAMON_LIVE_JOURNAL?.trim() || path.resolve(config.repoRoot, ".local-data/metamon-live");
  if (!live && launchFile) app.addHook("onReady", async () => { live = new LiveMetamonAdvisor(await readLiveMetamonLaunch(launchFile), { journalDir }); });
  // History is written behind the request path; shutdown writes whatever is pending (and fails loudly if it cannot).
  app.addHook("onClose", async () => { await live?.close(); await flushIntelStore(); });
  const engine = new DecisionEngine();
  const contexts = new Map<string, IntelEvaluationContext>();
  const shownResults = new Map<string, string>();
  const canonicalIdentity = decisionIdentitySchema.extend({ stateRevision: z.number().int().positive(), requestKind: z.string() }).strict();
  const evaluationRequest = z.object({ sessionId: z.string(), identity: canonicalIdentity, historyRevision: z.string() }).strict();
  const pinContext = (context: IntelEvaluationContext) => {
    contexts.delete(context.revision);
    contexts.set(context.revision, context);
    while (contexts.size > 8) contexts.delete(contexts.keys().next().value!);
    return context;
  };
  const contextFor = (revision: string) => {
    const context = contexts.get(revision);
    if (!context) throw new DecisionConflict("History view expired; ingest or refresh observations to pin a new view.");
    return context;
  };

  app.post("/v1/observations", async (request, reply) => {
    const parsed = z.object({ observations: z.array(observationSchema).min(1).max(100), metamonEvents: z.array(liveEventSchema).max(300).optional() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    try {
      let context: IntelEvaluationContext | undefined;
      const committed = await engine.ingestBatch(parsed.data.observations, async (results, check) => {
        context = await commitCanonicalSnapshots(results.filter((result) => result.changed && result.snapshot).map((result) => result.snapshot!), movePriors, check);
      });
      if (live) {
        const events = parsed.data.metamonEvents ?? parsed.data.observations.map((o) => ({
          kind: "observation" as const, eventId: o.observationId, observationId: o.observationId,
          sequence: o.sequence, sessionId: o.sessionId, roomId: o.roomId
        }));
        live.accept(events, committed.map((current, i) => ({ current, observation: parsed.data.observations[i]!, context: context! })));
      }
      const results = committed.map((result, index) => ({ ...result, observationId: parsed.data.observations[index]!.observationId,
        acknowledgedSequence: parsed.data.observations[index]!.sequence }));
      return { ok: true, instanceId, contractVersion: "showdown-observations@1", historyRevision: pinContext(context!).revision, results };
    } catch (error) {
      if (error instanceof DecisionConflict) return reply.code(409).send({ ok: false, error: error.message });
      throw error;
    }
  });

  // Staged: answers with the first deterministic result newer than `after` (a partial stage as soon as it is ready, or the
  // complete envelope), waiting at most 4 s for it without holding any lock. `final` says whether more will follow.
  app.post("/v1/evaluate", async (request, reply) => {
    const parsed = evaluationRequest.extend({ after: z.enum(INTEL_STAGES).nullish() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    try {
      const { sessionId, identity, historyRevision, after } = parsed.data;
      const result = await evaluateDecisionStage(engine, sessionId, identity, contextFor(historyRevision), after ?? null, 4000);
      // Start the send under the freshness guard, but NEVER return Fastify's thenable reply from the lock.
      // A response hook, socket or disconnected client must not gate battle ingestion.
      await engine.withCurrent(sessionId, identity, () => {
        reply.send({ ok: true, evaluatedAt: new Date().toISOString(), ...result });
      });
      return reply;
    } catch (error) {
      if (error instanceof DecisionConflict) return reply.code(409).send({ ok: false, error: error.message });
      throw error;
    }
  });

  // Extension self-reports (capture state per tab, no game data beyond room ids), newest per client, for diagnosis
  // from the companion host without the owner's devtools.
  const clientReports = new Map<string, Record<string, unknown>>();
  app.post("/v1/client/status", async (request, reply) => {
    const parsed = z.object({ clientId: z.string().min(1).max(200) }).passthrough().safeParse(request.body);
    if (!parsed.success || JSON.stringify(request.body).length > 65_536) return reply.code(400).send({ ok: false });
    clientReports.delete(parsed.data.clientId);
    clientReports.set(parsed.data.clientId, { ...parsed.data, receivedAt: new Date().toISOString() });
    while (clientReports.size > 20) clientReports.delete(clientReports.keys().next().value!);
    // Per-request paint timings go into that battle's journal too, so every live game keeps its numbers.
    const tabs = (request.body as { tabs?: unknown }).tabs;
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      const timings = z.array(decisionTimingSchema).max(30).safeParse(tab?.timings);
      if (timings.success && typeof tab?.captureSession === "string") for (const timing of timings.data) live?.recordTiming(tab.captureSession, timing);
    }
    return { ok: true };
  });
  app.get("/v1/client/status", async () => ({ ok: true, clients: [...clientReports.values()].reverse() }));
  app.get("/v1/metamon/live", async () => ({ ok: true, enabled: Boolean(live), ...(live ? { maxWorkers: live.maxWorkers } : {}), rooms: live?.status() ?? [] }));
  app.post("/v1/metamon/events", async (request, reply) => {
    const parsed = z.object({ metamonEvents: z.array(liveEventSchema).min(1).max(300) }).strict().safeParse(request.body);
    if (!parsed.success || parsed.data.metamonEvents.some((e) => e.kind === "observation")) return reply.code(400).send({ ok: false, error: "Expected outgoing choices or leave events." });
    live?.accept(parsed.data.metamonEvents);
    return { ok: true };
  });
  // Bound to the canonical decision identity alone: the pick is shown without waiting for the deterministic sections.
  app.post("/v1/metamon/advice", async (request, reply) => {
    const parsed = evaluationRequest.extend({ after: z.literal("pick").optional() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const { sessionId, identity, after } = parsed.data;
    // ?waitMs=N (at most 5000): while the pick is still being computed (or, after="pick", its warnings), answer as soon
    // as it is ready instead of making the client poll. The wait holds no lock; the answer is still checked against the
    // current decision.
    const waitMs = Math.min(5000, Math.max(0, Number((request.query as { waitMs?: string })?.waitMs) || 0));
    const pending = () => { const advice = live?.advice(sessionId, identity);
      return advice?.status === "warming" || (after === "pick" && advice?.status === "ready" && advice.guardsPending === true); };
    for (const until = Date.now() + waitMs; Date.now() < until && pending();) await new Promise((resolve) => setTimeout(resolve, 15));
    try {
      await engine.withCurrent(sessionId, identity, () => { reply.send({ ok: true,
        metamonAdvice: live?.advice(sessionId, identity) ?? { status: "disabled", identity,
          requestId: null, actionId: null, label: null, latencyMs: null } }); });
      return reply;
    } catch (error) {
      if (error instanceof DecisionConflict) return reply.code(409).send({ ok: false, error: error.message });
      throw error;
    }
  });

  app.post("/v1/feedback", async (request, reply) => {
    const parsed = evaluationRequest.extend({ resultHash: z.string() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    try {
      const { sessionId, identity, historyRevision, resultHash } = parsed.data;
      await engine.assertCurrent(sessionId, identity);
      const feedbackKey = `${sessionId}\n${identity.roomId}`;
      if (shownResults.get(feedbackKey) === resultHash) return { ok: true, alreadyRecorded: true };
      const envelope = await evaluateDecision(engine, sessionId, identity, contextFor(historyRevision));
      if (envelope.resultHash !== resultHash) throw new DecisionConflict("Shown-result hash mismatch.");
      let alreadyRecorded = false;
      await engine.withCurrent(sessionId, identity, async (current, check) => {
        if (shownResults.get(feedbackKey) === resultHash) { alreadyRecorded = true; return; }
        await recordShownPrediction(current.snapshot!, { ...envelope.semantic.localIntel, generatedAt: new Date().toISOString() }, identity, undefined, check);
        check();
        shownResults.set(feedbackKey, resultHash);
      });
      return { ok: true, ...(alreadyRecorded ? { alreadyRecorded: true } : {}) };
    } catch (error) {
      if (error instanceof DecisionConflict) return reply.code(409).send({ ok: false, error: error.message });
      throw error;
    }
  });

  void app.register(cors, {
    origin: true
  });

  app.get("/api/health", async () => {
    return {
      ok: true,
      service: "showdnass-companion",
      repoRoot: config.repoRoot,
      providerDefaults: {
        codex: config.defaultCodexModel,
        claude: config.defaultClaudeModel,
        gemini: config.defaultGeminiModel
      },
      providers: await getProviderHealth(),
      historyPersistence: intelStorePersistence(),
      synchronization: engine.synchronizationStatus()
    };
  });

  app.post("/api/analyze", async (request, reply) => {
    const parsed = analyzeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ok: false,
        error: parsed.error.flatten()
      };
    }

    const body = parsed.data;
    const decisionIdentity = await createDecisionIdentity(body.snapshot);
    if (body.decisionIdentity && !sameDecision(body.decisionIdentity, decisionIdentity)) {
      return reply.code(400).send({ ok: false, error: "Decision identity does not match the supplied snapshot." });
    }
    const provider = getProvider(body.provider);
    const model = provider.resolveModel(body.model);
    const analysisMode = body.analysisMode === "strategic" ? "strategic" : "tactical";
    const requestId = body.requestId ?? crypto.randomUUID();
    const localIntel = await buildLocalIntelSnapshot(body.snapshot, await captureIntelEvaluationContext());

    try {
      const runResult = provider.analyzeDetailed
        ? await provider.analyzeDetailed(body.snapshot, {
            requestedModel: body.model,
            analysisMode,
            localIntel,
            requestContext: body.requestContext
          })
        : {
            analysis: await provider.analyze(body.snapshot, {
              requestedModel: body.model,
              analysisMode,
              localIntel,
              requestContext: body.requestContext
            }),
            providerDebug: undefined
          };

      const response: AnalyzeResponse = {
        analysis: runResult.analysis,
        provider: body.provider,
        model,
        analysisMode,
        createdAt: new Date().toISOString(),
        requestId,
        decisionIdentity,
        historyAuthority: "legacy_untrusted",
        providerDebug: runResult.providerDebug,
        localIntel
      };

      return response;
    } catch (error) {
      request.log.error(error);
      reply.code(500);
      return {
        ok: false,
        provider: body.provider,
        model,
        requestId,
        decisionIdentity,
        error: error instanceof Error ? error.message : String(error),
        localIntel
      };
    }
  });

  app.post("/api/observe-snapshot", async (request, reply) => {
    const parsed = observeSnapshotRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ok: false,
        error: parsed.error.flatten()
      };
    }

    const snapshot = parsed.data.snapshot;
    const decisionIdentity = await createDecisionIdentity(snapshot);
    if (parsed.data.decisionIdentity && !sameDecision(parsed.data.decisionIdentity, decisionIdentity)) {
      return reply.code(400).send({ ok: false, error: "Decision identity does not match the supplied snapshot." });
    }
    const localIntel = await buildLocalIntelSnapshot(snapshot, await captureIntelEvaluationContext());

    return {
      ok: true,
      observedAt: new Date().toISOString(),
      decisionIdentity,
      historyAuthority: "legacy_untrusted",
      localIntel
    };
  });

  app.post("/api/save-replay", async (request, reply) => {
    const parsed = saveReplayRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ok: false,
        error: parsed.error.flatten()
      };
    }

    const body = parsed.data;
    const fileName = replayFileName(body.roomId);
    const outputPath = path.join(config.replaysDir, fileName);
    let existed = false;

    await fs.mkdir(config.replaysDir, { recursive: true });
    try {
      await fs.access(outputPath);
      existed = true;
    } catch {
      const content = body.protocol.endsWith("\n") ? body.protocol : `${body.protocol}\n`;
      await fs.writeFile(outputPath, content, "utf8");
    }

    return {
      ok: true,
      roomId: body.roomId,
      fileName,
      path: outputPath,
      existed
    };
  });

  return app;
}
