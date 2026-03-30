import type {
  AnalysisRequestContext,
  AnalysisResult,
  BattleSnapshot,
  LocalIntelSnapshot,
  ProviderDebug,
  ProviderName
} from "../types.js";

export interface ProviderContext {
  requestedModel?: string | undefined;
  analysisMode?: "tactical" | "strategic" | undefined;
  localIntel?: LocalIntelSnapshot | undefined;
  requestContext?: AnalysisRequestContext | undefined;
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
