import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDecisionIdentity, sameDecision } from "./decision-identity.js";

function snapshot() {
  return {
    capturedAt: "2026-10-18T00:00:00Z", roomId: "battle-gen9uu-test", turn: 7,
    legalActions: [{ id: "move:icebeam", kind: "move", disabled: false }],
    rawRequestSummary: { rqid: 42, wait: false }, field: { weather: null }
  };
}

test("decision hashes are canonical, cryptographic, and independent of capture time", async () => {
  const original = snapshot();
  const identity = await createDecisionIdentity(original);
  const expected = '{"field":{"weather":null},"legalActions":[{"disabled":false,"id":"move:icebeam","kind":"move"}],"rawRequestSummary":{"rqid":42,"wait":false},"roomId":"battle-gen9uu-test","turn":7}';
  assert.equal(identity.snapshotHash, `sha256:${createHash("sha256").update(expected).digest("hex")}`);
  const reordered = { ...Object.fromEntries(Object.entries(original).reverse()), capturedAt: "later" };
  assert.deepEqual(await createDecisionIdentity(reordered), identity);
});

test("room, rqid, turn, board, and legal-action changes each invalidate prior decisions", async () => {
  const original = snapshot();
  const identity = await createDecisionIdentity(original);
  for (const changed of [
    { ...original, roomId: "battle-gen9uu-other" },
    { ...original, turn: 8 },
    { ...original, field: { weather: "SunnyDay" } },
    { ...original, rawRequestSummary: { ...original.rawRequestSummary, rqid: 43 } },
    { ...original, legalActions: [{ ...original.legalActions[0], disabled: true }] },
    { ...original, legalActions: [{ ...original.legalActions[0], uncertainLegal: true }] }
  ]) assert.equal(sameDecision(identity, await createDecisionIdentity(changed)), false);
  assert.equal(sameDecision(null, null), false);
});

test("action-set hash includes action semantics and ignores listing order", async () => {
  const original = snapshot();
  original.legalActions.push({ id: "move:surf", kind: "move", disabled: false });
  const identity = await createDecisionIdentity(original);
  assert.equal((await createDecisionIdentity({ ...original, legalActions: [...original.legalActions].reverse() })).legalActionSetHash,
    identity.legalActionSetHash);
  assert.notEqual((await createDecisionIdentity({ ...original, legalActions: [original.legalActions[0]] })).legalActionSetHash,
    identity.legalActionSetHash);
  const presentation = { ...original, legalActions: original.legalActions.map((action) => ({ ...action, label: "Translated label", details: "UI-only explanation" })) };
  assert.equal((await createDecisionIdentity(presentation)).legalActionSetHash, identity.legalActionSetHash);
  for (const change of [{ terastallize: true }, { targetSlot: 3 }, { moveSlot: 2 }, { disabled: true },
    { uncertainLegal: true, uncertaintyReason: "hidden_trapping_ability" }, { canUndo: false }]) {
    assert.notEqual((await createDecisionIdentity({ ...original, legalActions: [{ ...original.legalActions[0], ...change }, original.legalActions[1]] })).legalActionSetHash,
      identity.legalActionSetHash);
  }
});
