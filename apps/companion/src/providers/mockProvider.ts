import type { AnalysisResult, BattleSnapshot } from "../types.js";
import type { Provider, ProviderContext } from "./base.js";

function scoreAction(action: BattleSnapshot["legalActions"][number], index: number): number {
  if (action.kind === "move") {
    if (/rapid spin/i.test(action.label)) return 0.82;
    if (/knock off/i.test(action.label)) return 0.74;
    if (/ice spinner/i.test(action.label)) return 0.67;
    return Math.max(0.5, 0.72 - index * 0.05);
  }
  return Math.max(0.4, 0.58 - index * 0.04);
}

export class MockProvider implements Provider {
  readonly name = "mock" as const;

  resolveModel(): string {
    return "mock-local";
  }

  async isAvailable(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: "Built-in mock provider" };
  }

  async analyze(snapshot: BattleSnapshot, _context: ProviderContext): Promise<AnalysisResult> {
    const rankedActions = snapshot.legalActions
      .slice(0, 5)
      .map((action, index) => ({
        actionId: action.id,
        label: action.label,
        score: scoreAction(action, index),
        rationale:
          action.kind === "move"
            ? "Mock rationale: this move looks broadly useful in the current position."
            : "Mock rationale: switching is a lower-commitment fallback line.",
        assumptions: ["This is a mock provider result, not a real model judgment."],
        risks: ["Use a real model provider before trusting this ranking."]
      }))
      .sort((a, b) => b.score - a.score);

    const top = rankedActions[0] ?? {
      actionId: "none",
      label: "No action",
      score: 0,
      rationale: "No legal actions were available in the snapshot.",
      assumptions: [],
      risks: []
    };

    return {
      summary:
        rankedActions.length > 0
          ? `Mock provider: ${top.label} is the current placeholder top choice.`
          : "Mock provider: no legal actions were present in the snapshot.",
      topChoiceActionId: top.actionId,
      rankedActions,
      assumptions: ["This output exists to test the local pipeline without Codex or Claude."],
      dangerFlags: ["Do not use the mock provider for actual play decisions."],
      toolsUsed: [],
      confidence: "low"
    };
  }
}
