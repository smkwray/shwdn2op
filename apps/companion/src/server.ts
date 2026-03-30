import fs from "node:fs/promises";
import path from "node:path";

import Fastify from "fastify";
import cors from "@fastify/cors";

import { config } from "./config.js";
import { analyzeRequestSchema, observeSnapshotRequestSchema, saveReplayRequestSchema } from "./schema.js";
import type { AnalyzeResponse } from "./types.js";
import { buildLocalIntelSnapshot, updateLocalIntelFromSnapshot } from "./history/opponentIntelStore.js";
import { getProvider, getProviderHealth } from "./providers/factory.js";

function replayFileName(roomId: string) {
  const safeRoomId = String(roomId ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return `${safeRoomId || "battle-replay"}.log`;
}

export function buildServer() {
  const app = Fastify({ logger: true });

  void app.register(cors, {
    origin: true
  });

  app.get("/api/health", async () => {
    return {
      ok: true,
      service: "showdnass-companion",
      providerDefaults: {
        codex: config.defaultCodexModel,
        claude: config.defaultClaudeModel,
        gemini: config.defaultGeminiModel
      },
      providers: await getProviderHealth()
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
    const provider = getProvider(body.provider);
    const model = provider.resolveModel(body.model);
    const analysisMode = body.analysisMode === "strategic" ? "strategic" : "tactical";
    const requestId = body.requestId ?? crypto.randomUUID();
    await updateLocalIntelFromSnapshot(body.snapshot);
    const localIntel = await buildLocalIntelSnapshot(body.snapshot);

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
    await updateLocalIntelFromSnapshot(snapshot);
    const localIntel = await buildLocalIntelSnapshot(snapshot);

    return {
      ok: true,
      observedAt: new Date().toISOString(),
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
