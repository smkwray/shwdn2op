import test from "node:test";
import assert from "node:assert/strict";
import { displayIntel, envelopeStage } from "./staged-intel.js";

const envelope = (stage, localIntel) => ({ semantic: { ...(stage ? { stage } : {}), localIntel } });

// Matters: no section waits for the others: each section shows the moment its
// stage is ready; until then a section of an earlier view of the same decision stays (stale, marked updating) rather than
// vanishing, and with no earlier view it is pending. A complete envelope has no stage and replaces everything.
test("each section shows when its stage is ready; an earlier view fills the rest as stale, never as fresh", () => {
  const previous = { speedPreview: { activeRelation: "faster" }, opponents: [{ species: "Old" }], playerDamagePreview: [{ actionId: "move:1|tera=0" }],
    opponentThreatPreview: [{ moveName: "Old move" }], opponentActionPrediction: { topActionClass: "stay_attack" } };
  const board = envelope("board", { speedPreview: { activeRelation: "slower" }, opponents: [{ species: "New" }] });
  const first = displayIntel(board, null);
  assert.deepEqual(first.pending, ["damage", "threats", "analysis"]);
  assert.deepEqual(first.stale, []);
  assert.equal(first.localIntel.playerDamagePreview, undefined, "nothing invented for a pending section");

  const revalidating = displayIntel(board, previous);
  assert.equal(revalidating.localIntel.speedPreview.activeRelation, "slower", "a ready section is never overwritten by the earlier view");
  assert.equal(revalidating.localIntel.opponents[0].species, "New");
  assert.deepEqual(revalidating.stale, ["damage", "threats", "analysis"]);
  assert.equal(revalidating.localIntel.playerDamagePreview, previous.playerDamagePreview);
  assert.deepEqual(revalidating.pending, []);

  const threats = displayIntel(envelope("threats", { speedPreview: {}, opponents: [], playerDamagePreview: [], opponentThreatPreview: [] }), previous);
  assert.deepEqual(threats.stale, ["analysis"]);
  assert.deepEqual(threats.localIntel.playerDamagePreview, [], "an empty computed section stays empty");

  const complete = displayIntel(envelope(null, { opponents: [] }), previous);
  assert.deepEqual(complete.stale, []); assert.deepEqual(complete.pending, []);
  assert.equal(complete.localIntel.speedPreview, undefined, "the complete result is shown as computed");
  assert.equal(envelopeStage(envelope(null, {})), "final");

  const none = displayIntel(null, previous);
  assert.equal(none.localIntel, null);
  assert.deepEqual(none.pending, ["speed", "sets", "damage", "threats", "analysis"]);
});
