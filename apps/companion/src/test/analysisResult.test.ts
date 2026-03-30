import test from "node:test";
import assert from "node:assert/strict";

import { extractStructuredOutput, normalizeLooseAnalysisResult } from "../util/analysisResult.js";

test("extractStructuredOutput parses Claude result envelopes with fenced JSON payloads", () => {
  const envelope = {
    type: "result",
    subtype: "success",
    result: "```json\n{\"summary\":\"Test summary\",\"recommendation\":\"move:icespinner\",\"ranking\":[{\"rank\":1,\"id\":\"move:icespinner\",\"label\":\"Ice Spinner\",\"score\":92,\"rationale\":\"Best hit.\",\"assumptions\":[]}],\"dangerFlags\":[]}\n```"
  };

  const structured = extractStructuredOutput(envelope) as Record<string, unknown>;
  assert.equal(structured.summary, "Test summary");
  assert.equal(structured.recommendation, "move:icespinner");
  assert.ok(Array.isArray(structured.ranking));
});

test("normalizeLooseAnalysisResult accepts Claude ranking output and rescales 0-100 scores", () => {
  const result = normalizeLooseAnalysisResult({
    summary: "Ice Spinner is best here.",
    recommendation: "move:icespinner",
    ranking: [
      {
        rank: 1,
        id: "move:icespinner",
        label: "Ice Spinner",
        score: 92,
        rationale: "Best hit.",
        assumptions: ["Damage roll is favorable."],
        risks: ["May miss the KO."]
      },
      {
        rank: 2,
        id: "move:knockoff",
        label: "Knock Off",
        score: 78,
        rationale: "Second-best hit."
      }
    ],
    confidence: "medium"
  });

  assert.ok(result);
  assert.equal(result.topChoiceActionId, "move:icespinner");
  assert.equal(result.rankedActions[0]?.score, 0.92);
  assert.equal(result.rankedActions[1]?.score, 0.78);
  assert.equal(result.rankedActions[0]?.rationale, "Best hit.");
});
