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

function buildStrategicMockResult(snapshot: BattleSnapshot): AnalysisResult {
  const rankedActions = snapshot.legalActions.length > 0
    ? snapshot.legalActions
      .slice(0, 3)
      .map((action, index) => ({
        actionId: action.id,
        label: action.label,
        score: Math.max(0.55, 0.8 - index * 0.08),
        rationale: "Mock strategic rationale: this line best preserves flexibility while advancing the game plan.",
        assumptions: ["This is a mock provider result, not a real model judgment."],
        risks: ["Strategic mode is only as good as the current snapshot and local priors."]
      }))
    : [
        {
          actionId: "special:plan-primary",
          label: "Preserve key win condition",
          score: 0.84,
          rationale: "Mock strategic rationale: protect the best cleaner or wallbreaker and avoid trading it too early.",
          assumptions: ["This is a mock provider result, not a real model judgment."],
          risks: ["Use a real provider before trusting strategic guidance."]
        },
        {
          actionId: "special:plan-secondary",
          label: "Scout the likely punish line",
          score: 0.74,
          rationale: "Mock strategic rationale: gather item, speed, or coverage info before making a high-commitment trade.",
          assumptions: ["This is a mock provider result, not a real model judgment."],
          risks: ["The mock provider does not reason from a real search tree."]
        },
        {
          actionId: "special:plan-avoid",
          label: "Avoid premature sack",
          score: 0.62,
          rationale: "Mock strategic rationale: do not cash in an important defensive piece without a clear payoff.",
          assumptions: ["This is a mock provider result, not a real model judgment."],
          risks: ["The mock provider does not reason from a real search tree."]
        }
      ];

  const top = rankedActions[0];
  return {
    summary:
      snapshot.legalActions.length > 0
        ? `Mock provider: ${top?.label ?? "No action"} is the placeholder strategic top line from the current position.`
        : "Mock provider: preserve your highest-value piece, scout the likely punish line, and avoid low-value sacks.",
    topChoiceActionId: top?.actionId ?? "special:plan-primary",
    rankedActions,
    assumptions: ["This output exists to test the local pipeline without Codex or Claude."],
    dangerFlags: ["Do not use the mock provider for actual play decisions."],
    toolsUsed: [],
    confidence: "low"
  };
}

export class MockProvider implements Provider {
  readonly name = "mock" as const;

  resolveModel(): string {
    return "mock-local";
  }

  async isAvailable(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: "Built-in mock provider" };
  }

  async analyze(snapshot: BattleSnapshot, context: ProviderContext): Promise<AnalysisResult> {
    if (context.analysisMode === "strategic") {
      return buildStrategicMockResult(snapshot);
    }

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
