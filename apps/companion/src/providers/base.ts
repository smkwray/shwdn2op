import type { AnalysisResult, BattleSnapshot, LocalIntelSnapshot, ProviderDebug, ProviderName } from "../types.js";

export interface ProviderContext {
  requestedModel?: string | undefined;
  localIntel?: LocalIntelSnapshot | undefined;
}

export interface ProviderRunResult {
  analysis: AnalysisResult;
  providerDebug?: ProviderDebug | undefined;
}

export interface Provider {
  readonly name: ProviderName;
  resolveModel(requestedModel?: string): string;
  analyze(snapshot: BattleSnapshot, context: ProviderContext): Promise<AnalysisResult>;
  analyzeDetailed?(snapshot: BattleSnapshot, context: ProviderContext): Promise<ProviderRunResult>;
  isAvailable(): Promise<{ available: boolean; detail: string }>;
}
