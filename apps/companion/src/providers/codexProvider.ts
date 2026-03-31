import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { config, repoRoot } from "../config.js";
import { analysisResultSchema } from "../schema.js";
import type { AnalysisResult, BattleSnapshot } from "../types.js";
import { runCommand } from "../util/process.js";
import { buildAnalysisPrompt } from "../prompting/analysisPrompt.js";
import { canonicalizeAnalysisResult } from "../util/analysisResult.js";
import type { Provider, ProviderContext, ProviderRunResult } from "./base.js";

export class CodexProvider implements Provider {
  readonly name = "codex" as const;

  resolveModel(requestedModel?: string): string {
    return requestedModel?.trim() || config.defaultCodexModel;
  }

  async isAvailable(): Promise<{ available: boolean; detail: string }> {
    try {
      const result = await runCommand(config.codexBin, ["--version"], {
        cwd: repoRoot,
        timeoutMs: 8000
      });
      return {
        available: result.exitCode === 0,
        detail: (result.stdout || result.stderr).trim() || "codex present"
      };
    } catch (error) {
      return {
        available: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async analyze(snapshot: BattleSnapshot, context: ProviderContext): Promise<AnalysisResult> {
    const result = await this.analyzeDetailed(snapshot, context);
    return result.analysis;
  }

  async analyzeDetailed(snapshot: BattleSnapshot, context: ProviderContext): Promise<ProviderRunResult> {
    const prompt = buildAnalysisPrompt(snapshot, {
      analysisMode: context.analysisMode,
      localIntel: context.localIntel,
      requestContext: context.requestContext
    });
    const model = this.resolveModel(context.requestedModel);
    const timeoutMs = context.analysisMode === "strategic"
      ? config.strategicTimeoutMs
      : 120000;
    const tempFile = path.join(os.tmpdir(), `sso-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const schemaFile = path.join(os.tmpdir(), `sso-codex-schema-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

    try {
      const schema = JSON.parse(await fs.readFile(config.analysisSchemaPath, "utf8"));
      if (schema && typeof schema === "object" && schema.properties) {
        schema.required = Object.keys(schema.properties);
      }
      await fs.writeFile(schemaFile, JSON.stringify(schema));

      const result = await runCommand(
        config.codexBin,
        [
          "exec",
          "--model",
          model,
          "--skip-git-repo-check",
          "--output-schema",
          schemaFile,
          "-o",
          tempFile,
          prompt
        ],
        {
          cwd: repoRoot,
          timeoutMs
        }
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || `codex exited with code ${String(result.exitCode)}`);
      }

      const text = await fs.readFile(tempFile, "utf8");
      const parsed = JSON.parse(text);
      return {
        analysis: canonicalizeAnalysisResult(analysisResultSchema.parse(parsed), snapshot),
        providerDebug: {
          provider: this.name,
          model,
          command: config.codexBin,
          args: ["exec", "--model", model, "--skip-git-repo-check", "--output-schema", "<temp-schema>", "-o", "<temp-output>", "<prompt>"],
          stdoutSnippet: result.stdout.slice(0, 4000) || undefined,
          stderrSnippet: result.stderr.slice(0, 4000) || undefined,
          rawOutputSnippet: text.slice(0, 4000) || undefined
        }
      };
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => {});
      await fs.rm(schemaFile, { force: true }).catch(() => {});
    }
  }
}
