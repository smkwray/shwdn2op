import { config, repoRoot } from "../config.js";
import { analysisResultSchema } from "../schema.js";
import type { AnalysisResult, BattleSnapshot } from "../types.js";
import { buildAnalysisPrompt } from "../prompting/analysisPrompt.js";
import { canonicalizeAnalysisResult, extractStructuredOutput, normalizeLooseAnalysisResult } from "../util/analysisResult.js";
import { parseJsonFromMixedText } from "../util/json.js";
import { runCommand } from "../util/process.js";
import type { Provider, ProviderContext, ProviderRunResult } from "./base.js";

export function buildGeminiPrompt(snapshot: BattleSnapshot, context: ProviderContext): string {
  const strategicActionRule = context.analysisMode === "strategic"
    ? "Use legal action IDs from snapshot.legalActions only when requestContext.actionableNow is true. Otherwise use only these synthetic strategic IDs: special:plan-primary, special:plan-secondary, special:plan-avoid."
    : "Use only action IDs from snapshot.legalActions.";
  const basePrompt = buildAnalysisPrompt(snapshot, {
    analysisMode: context.analysisMode,
    includeToolHint: false,
    maxDeterministicNotes: 6,
    maxRecentLogEntries: 12,
    maxSnapshotNotes: 6,
    prettySnapshot: false,
    localIntel: context.localIntel,
    requestContext: context.requestContext
  });
  return [
    "Return one JSON object only. No markdown fences.",
    "Top-level keys required: summary, topChoiceActionId, rankedActions, assumptions, dangerFlags, confidence.",
    "Each rankedActions entry must contain: actionId, label, score, rationale, assumptions, risks.",
    strategicActionRule,
    basePrompt
  ].join("\n\n");
}

export class GeminiProvider implements Provider {
  readonly name = "gemini" as const;

  resolveModel(requestedModel?: string): string {
    return requestedModel?.trim() || config.defaultGeminiModel;
  }

  async isAvailable(): Promise<{ available: boolean; detail: string }> {
    try {
      const result = await runCommand(config.geminiBin, ["--version"], {
        cwd: repoRoot,
        timeoutMs: 8000
      });
      return {
        available: result.exitCode === 0,
        detail: (result.stdout || result.stderr).trim() || "gemini present"
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
    const prompt = buildGeminiPrompt(snapshot, context);
    const timeoutMs = context.analysisMode === "strategic"
      ? Math.max(config.geminiTimeoutMs, config.strategicTimeoutMs)
      : config.geminiTimeoutMs;

    const result = await runCommand(
      config.geminiBin,
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--approval-mode",
        "plan",
        "-m",
        this.resolveModel(context.requestedModel)
      ],
      {
        cwd: repoRoot,
        timeoutMs
      }
    );

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `gemini exited with code ${String(result.exitCode)}`);
    }

    const parsed = parseJsonFromMixedText(result.stdout);
    const structured = extractStructuredOutput(parsed);
    let normalizedFromLoose = false;

    try {
      return {
        analysis: canonicalizeAnalysisResult(analysisResultSchema.parse(structured), snapshot),
        providerDebug: {
          provider: this.name,
          model: this.resolveModel(context.requestedModel),
          command: config.geminiBin,
          args: ["-p", "<prompt>", "--output-format", "json", "--approval-mode", "plan", "-m", this.resolveModel(context.requestedModel)],
          stdoutSnippet: result.stdout.slice(0, 4000) || undefined,
          stderrSnippet: result.stderr.slice(0, 4000) || undefined,
          rawOutputSnippet: JSON.stringify(structured).slice(0, 4000) || undefined,
          normalizedFromLoose
        }
      };
    } catch {
      const fallback = normalizeLooseAnalysisResult(structured, snapshot);
      if (fallback) {
        normalizedFromLoose = true;
        return {
          analysis: canonicalizeAnalysisResult(analysisResultSchema.parse(fallback), snapshot),
          providerDebug: {
            provider: this.name,
            model: this.resolveModel(context.requestedModel),
            command: config.geminiBin,
            args: ["-p", "<prompt>", "--output-format", "json", "--approval-mode", "plan", "-m", this.resolveModel(context.requestedModel)],
            stdoutSnippet: result.stdout.slice(0, 4000) || undefined,
            stderrSnippet: result.stderr.slice(0, 4000) || undefined,
            rawOutputSnippet: JSON.stringify(structured).slice(0, 4000) || undefined,
            normalizedFromLoose
          }
        };
      }
      throw new Error(
        `Gemini returned JSON that did not match AnalysisResult. Top-level keys: ${parsed && typeof parsed === "object" ? Object.keys(parsed).join(", ") : "(non-object)"}`
      );
    }
  }
}
