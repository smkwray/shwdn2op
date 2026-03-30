import fs from "node:fs/promises";

import { config, repoRoot } from "../config.js";
import { analysisResultSchema } from "../schema.js";
import type { AnalysisResult, BattleSnapshot } from "../types.js";
import { runCommand } from "../util/process.js";
import { parseJsonFromMixedText } from "../util/json.js";
import { canonicalizeAnalysisResult, extractStructuredOutput, normalizeLooseAnalysisResult } from "../util/analysisResult.js";
import { buildAnalysisPrompt } from "../prompting/analysisPrompt.js";
import type { Provider, ProviderContext, ProviderRunResult } from "./base.js";

export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;

  resolveModel(requestedModel?: string): string {
    return requestedModel?.trim() || config.defaultClaudeModel;
  }

  async isAvailable(): Promise<{ available: boolean; detail: string }> {
    try {
      const result = await runCommand(config.claudeBin, ["--version"], {
        cwd: repoRoot,
        timeoutMs: 8000
      });
      return {
        available: result.exitCode === 0,
        detail: (result.stdout || result.stderr).trim() || "claude present"
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
      includeToolHint: config.claudeEnableMcp,
      maxDeterministicNotes: 4,
      maxRecentLogEntries: 6,
      maxSnapshotNotes: 3,
      prettySnapshot: false,
      compactSnapshot: true,
      localIntel: context.localIntel,
      requestContext: context.requestContext
    });
    const model = this.resolveModel(context.requestedModel);
    const schema = JSON.parse(await fs.readFile(config.analysisSchemaPath, "utf8"));
    if (schema && typeof schema === "object" && schema.properties) {
      schema.required = Object.keys(schema.properties);
    }
    const schemaText = JSON.stringify(schema);

    const args = [
      "-p",
      "--no-session-persistence",
      "--tools",
      "",
      "--effort",
      "low",
      "--model",
      model,
      "--output-format",
      "json",
      "--json-schema",
      schemaText
    ];

    if (config.claudeEnableMcp) {
      try {
        await fs.access(config.claudeMcpConfigPath);
        args.push("--mcp-config", config.claudeMcpConfigPath, "--strict-mcp-config");
      } catch {
        // ignore missing project config
      }
    } else {
      // Keep Claude isolated from unrelated global MCP servers unless this app explicitly enables them.
      args.push("--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}");
    }

    args.push("--", prompt);

    const result = await runCommand(config.claudeBin, args, {
      cwd: repoRoot,
      timeoutMs: config.claudeTimeoutMs
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `claude exited with code ${String(result.exitCode)}`);
    }

    const parsed = parseJsonFromMixedText(result.stdout);
    const structured = extractStructuredOutput(parsed);
    let normalizedFromLoose = false;

    try {
      return {
        analysis: canonicalizeAnalysisResult(analysisResultSchema.parse(structured), snapshot),
        providerDebug: {
          provider: this.name,
          model,
          command: config.claudeBin,
          args: args.map((value) => value === prompt ? "<prompt>" : value === schemaText ? "<json-schema>" : value),
          stdoutSnippet: result.stdout.slice(0, 4000) || undefined,
          stderrSnippet: result.stderr.slice(0, 4000) || undefined,
          rawOutputSnippet: JSON.stringify(structured).slice(0, 4000) || undefined,
          normalizedFromLoose
        }
      };
    } catch (error) {
      const fallback = normalizeLooseAnalysisResult(structured, snapshot);
      if (fallback) {
        normalizedFromLoose = true;
        return {
          analysis: canonicalizeAnalysisResult(analysisResultSchema.parse(fallback), snapshot),
          providerDebug: {
            provider: this.name,
            model,
            command: config.claudeBin,
            args: args.map((value) => value === prompt ? "<prompt>" : value === schemaText ? "<json-schema>" : value),
            stdoutSnippet: result.stdout.slice(0, 4000) || undefined,
            stderrSnippet: result.stderr.slice(0, 4000) || undefined,
            rawOutputSnippet: JSON.stringify(structured).slice(0, 4000) || undefined,
            normalizedFromLoose
          }
        };
      }
      throw new Error(
        `Claude returned JSON that did not match AnalysisResult. Top-level keys: ${parsed && typeof parsed === "object" ? Object.keys(parsed).join(", ") : "(non-object)"}`
      );
    }
  }
}
