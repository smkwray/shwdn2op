import type { AnalysisResult, BattleSnapshot } from "../types.js";
import { parseJsonFromMixedText } from "./json.js";

function normalizeConfidence(value: unknown): AnalysisResult["confidence"] {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function normalizeScore(rawScore: number): number {
  if (!Number.isFinite(rawScore)) return 0;
  if (rawScore <= 1) return Math.max(0, rawScore);
  if (rawScore <= 10) return Math.max(0, Math.min(1, rawScore / 10));
  if (rawScore <= 100) return Math.max(0, Math.min(1, rawScore / 100));
  return Math.max(0, Math.min(1, rawScore));
}

function extractRecommendationActionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/\b((?:move|switch|special):[^\s,;`"]+)/i);
  return match?.[1] ?? null;
}

export function extractStructuredOutput(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  if ("structured_output" in parsed) {
    return parsed.structured_output;
  }

  if ("result" in parsed && typeof parsed.result === "string" && parsed.result.trim()) {
    try {
      return parseJsonFromMixedText(parsed.result);
    } catch {
      return parsed;
    }
  }

  if ("response" in parsed && typeof parsed.response === "string" && parsed.response.trim()) {
    try {
      return parseJsonFromMixedText(parsed.response);
    } catch {
      return parsed;
    }
  }

  return parsed;
}

function titleCaseWords(value: string) {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function prettifyActionId(actionId: string) {
  if (actionId.startsWith("move:")) {
    return titleCaseWords(actionId.slice("move:".length));
  }
  if (actionId.startsWith("switch:")) {
    return `Switch to ${actionId.slice("switch:".length).replace(/^p\d[a-z]?:\s*/i, "")}`;
  }
  if (actionId.startsWith("special:")) {
    return titleCaseWords(actionId.slice("special:".length));
  }
  return actionId;
}

function resolveActionLabel(actionId: string, label: string | null | undefined, snapshot?: BattleSnapshot) {
  const matchedAction = snapshot?.legalActions.find((entry) => entry.id === actionId);
  if (matchedAction?.label) return matchedAction.label;

  const normalizedLabel = typeof label === "string" ? label.trim() : "";
  if (!normalizedLabel || /^rank[_\s-]*\d+$/i.test(normalizedLabel) || /^option[_\s-]*\d+$/i.test(normalizedLabel)) {
    return prettifyActionId(actionId);
  }
  return normalizedLabel;
}

export function canonicalizeAnalysisResult(result: AnalysisResult, snapshot?: BattleSnapshot): AnalysisResult {
  return {
    ...result,
    rankedActions: result.rankedActions.map((entry) => ({
      ...entry,
      label: resolveActionLabel(entry.actionId, entry.label, snapshot)
    }))
  };
}

export function normalizeLooseAnalysisResult(candidate: unknown, snapshot?: BattleSnapshot): AnalysisResult | null {
  if (!candidate || typeof candidate !== "object") return null;
  const candidateRecord = candidate as Record<string, unknown>;

  const rankedSource: unknown[] | null = Array.isArray(candidateRecord.rankedActions)
    ? candidateRecord.rankedActions
    : Array.isArray(candidateRecord.ranking)
      ? candidateRecord.ranking
    : null;

  if (!rankedSource || rankedSource.length === 0) return null;

  const rankedActions = rankedSource
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const actionId = typeof record.actionId === "string"
        ? record.actionId
        : typeof record.id === "string"
          ? record.id
          : null;
      const rationale = typeof record.rationale === "string"
        ? record.rationale
        : typeof record.reasoning === "string"
          ? record.reasoning
          : typeof record.reason === "string"
            ? record.reason
            : null;
      if (!actionId || !rationale) return null;
      const label = resolveActionLabel(actionId, typeof record.label === "string" ? record.label : null, snapshot);
      if (!label) return null;

      const rawScore = typeof record.score === "number"
        ? record.score
        : typeof record.rank === "number"
          ? Math.max(0, 1 - (record.rank - 1) * 0.1)
          : Math.max(0, 1 - index * 0.1);

      return {
        actionId,
        label,
        score: normalizeScore(rawScore),
        rationale,
        assumptions: Array.isArray(record.assumptions)
          ? record.assumptions.filter((value): value is string => typeof value === "string")
          : [],
        risks: Array.isArray(record.risks)
          ? record.risks.filter((value): value is string => typeof value === "string")
          : []
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (rankedActions.length === 0) return null;
  const firstRankedAction = rankedActions[0];
  if (!firstRankedAction) return null;

  const topChoiceActionId =
    (typeof candidateRecord.topChoiceActionId === "string" ? candidateRecord.topChoiceActionId : null) ??
    extractRecommendationActionId(candidateRecord.recommendation) ??
    firstRankedAction.actionId;

  return canonicalizeAnalysisResult({
    summary:
      (typeof candidateRecord.summary === "string" ? candidateRecord.summary : null) ??
      (typeof candidateRecord.recommendation === "string" ? candidateRecord.recommendation : null) ??
      `${firstRankedAction.label} is the current top choice.`,
    topChoiceActionId,
    rankedActions,
    assumptions: Array.isArray(candidateRecord.assumptions)
      ? candidateRecord.assumptions.filter((value): value is string => typeof value === "string")
      : [],
    dangerFlags: Array.isArray(candidateRecord.dangerFlags)
      ? candidateRecord.dangerFlags.filter((value): value is string => typeof value === "string")
      : [],
    confidence: normalizeConfidence(candidateRecord.confidence),
    toolsUsed: Array.isArray(candidateRecord.toolsUsed)
      ? candidateRecord.toolsUsed.filter((value): value is string => typeof value === "string")
      : undefined
  }, snapshot);
}
