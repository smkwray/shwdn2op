import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildBattlePolicyPrompt, BATTLE_PROMPT_VARIANTS } from "../battle-agent/opencode.js";
import type { BattlePolicyInput } from "../battle-agent/battleAgent.js";

const hash = `sha256:${"a".repeat(64)}`;
const input = (): BattlePolicyInput => {
  const identity = { roomId: "battle-gen9uu-frozen", rqid: 7, snapshotHash: hash, legalActionSetHash: hash, stateRevision: 1, requestKind: "move" };
  return { requestId: "frozen-suggest", advice: { source: "metamon", policyId: "metamon:Kakuna:epoch34", requestId: "frozen-suggest",
    identity, inputResultHash: hash, actionId: "stay" }, envelope: { resultHash: hash, semantic: { identity, capabilities: {},
    snapshot: { format: "gen9uu", turn: 7, phase: "move", yourSide: { slot: "p1", name: "self", active: null, team: [] },
      opponentSide: { slot: "p2", name: "opponent", active: null, team: [] }, field: {}, recentLog: [], notes: [],
      legalActions: [{ id: "stay", kind: "move", label: "Stay", choice: "move 1", moveSlot: 1 }] },
    localIntel: { opponents: [] } } } } as unknown as BattlePolicyInput;
};

test("suggest prompt remains byte-for-byte identical to the pre-veto prompt in every variant", () => {
  // Frozen SHA-256 of the original renderer on this deliberately tiny fixed
  // input catches whitespace/instruction/schema drift, not just equal objects.
  const expected: Record<string, string> = {
    "baseline:raw": "70d1766cf439d01959b4b6062420d2eeb3bf0b6efea2ae2a75f763a0d2854c2d",
    "baseline:banded": "70d1766cf439d01959b4b6062420d2eeb3bf0b6efea2ae2a75f763a0d2854c2d",
    "baseline:hidden": "70d1766cf439d01959b4b6062420d2eeb3bf0b6efea2ae2a75f763a0d2854c2d",
    "temporal:raw": "812220a2df8b7c34fe478c4a705b7603d7a18ba5324e8dc0509f268de89d9d05",
    "temporal:banded": "812220a2df8b7c34fe478c4a705b7603d7a18ba5324e8dc0509f268de89d9d05",
    "temporal:hidden": "812220a2df8b7c34fe478c4a705b7603d7a18ba5324e8dc0509f268de89d9d05",
    "card:raw": "1316b24a63aabdd4c883546be78f5aed89a8f9dbc7c445fc69f3a28aba0062c6",
    "card:banded": "c203d462b4c08f9f5af86fdfc60ecc74b6353da1608af8a7357418dc1bf4cbb2",
    "card:hidden": "d5ca10761044e3c90647e752f2623dcfb4e56494cc34208c3d37808f7999ef80",
    "card-ledger:raw": "9ecdaf2bf9f1b5fe5a657f6ab73c168b636c73b19db2555b3a18198e96f7e880",
    "card-ledger:banded": "bf15fd18970f2903c3954414bea99c151844ea270881a24ed044cbfa6efa1453",
    "card-ledger:hidden": "c89e4d82de9e76ca4876b9412d1613cb91f767156c31e7875ba09b3b05212da7"
  };
  for (const promptVariant of BATTLE_PROMPT_VARIANTS) for (const heuristicPresentation of ["raw", "banded", "hidden"] as const) {
    const prompt = buildBattlePolicyPrompt(input(), { promptVariant, heuristicPresentation }, 1000, 1000);
    assert.equal(createHash("sha256").update(prompt).digest("hex"), expected[`${promptVariant}:${heuristicPresentation}`]);
  }
});

test("veto prompts expose the default and an exact citable Card across all supported variants", () => {
  // Baseline/temporal previously had no Card. They must display the actual
  // object used for citations rather than silently validating unseen fields.
  for (const promptVariant of BATTLE_PROMPT_VARIANTS) {
    const value = input(); value.advice!.mode = "veto";
    const prompt = buildBattlePolicyPrompt(value, { promptVariant }, 1000, 1000);
    assert.match(prompt, /DEFAULT ACTION/); assert.match(prompt, /will be executed unless/);
    assert.doesNotMatch(prompt, /No reason, analysis, markdown, other fields|exactly one field, actionId/);
    const objects = prompt.split("\n\n").filter(p => p.startsWith("{")).map(p => JSON.parse(p));
    const cards = objects.filter(p => p.contractVersion === "battle-decision-card@1");
    assert.equal(cards.length, 1); assert.equal(cards[0].current.phase, "move");
    assert.equal(objects.find(p => p.defaultAction)?.defaultAction.actionId, "stay");
    assert.deepEqual(objects.at(-2), { actionId: "stay" });
    assert.equal(objects.at(-1).override.cardField, "current.phase");
  }
});
