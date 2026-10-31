import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { appendCanonicalLines, createCanonicalLedger, forkCanonicalLedger, materializeCanonicalLedger, reduceCanonicalLedger,
  type CanonicalLedger, type CanonicalReduction } from "../state/canonicalLedger.js";
import { DecisionEngine } from "../state/decisionEngine.js";

const { splitProtocolPacket } = await import(new URL("../../../extension/lib/showdown-parser.js", import.meta.url).href);
// One side's protocol stream of a 397-turn offline self-play game. Reducing every observation from the empty room
// grew to ~4.7 s per observation by its end, so long games tripped the 5 s ingestion watchdog.
const roomId = "battle-gen9uu-1";
const frames: string[] = gunzipSync(fs.readFileSync(new URL("fixtures/long-selfplay-game.jsonl.gz", import.meta.url)))
  .toString("utf8").trim().split("\n").map((line) => `>${roomId}\n${JSON.parse(line)}`);
const observation = (index: number) => ({ observationId: `o${index}`, sessionId: "long", sequence: index + 1, roomId,
  source: "protocol" as const, data: frames[index]! });
const comparable = (room: any) => JSON.stringify({ ...room, updatedAt: 0 });

test("a carried reduction equals reduction from the empty room at every prefix of a long game, at a fraction of its cost", () => {
  delete process.env.CANONICAL_REDUCTION_CHECK; // This test compares (and times) both reductions itself.
  let prior: { ledger: CanonicalLedger; reduction: CanonicalReduction } | undefined;
  let carried = 0;
  const late = { carried: 0, full: 0 };
  for (const [index, frame] of frames.entries()) {
    const ledger = prior ? forkCanonicalLedger(prior.ledger) : createCanonicalLedger(roomId);
    appendCanonicalLines(ledger, splitProtocolPacket(frame)[0].lines, observation(index));
    const started = performance.now();
    const { room, reduction } = reduceCanonicalLedger(ledger, prior);
    const reduced = performance.now();
    const full = materializeCanonicalLedger(ledger);
    if (index >= frames.length - 100) { late.carried += reduced - started; late.full += performance.now() - reduced; }
    assert.equal(comparable(room), comparable(full), `observation ${index + 1}`);
    if (reduction.resumed) carried++;
    prior = { ledger, reduction };
  }
  // Only early identity creation (first sightings) forces a full reduction; replay must not creep back in.
  assert.ok(carried >= frames.length - 20, `${carried}/${frames.length} reductions carried`);
  assert.ok(late.carried < late.full / 3, `last 100: carried ${late.carried.toFixed(0)} ms, full ${late.full.toFixed(0)} ms`);
});

test("a failed transaction neither advances the carried reduction nor consumes its observation", async () => {
  process.env.CANONICAL_REDUCTION_CHECK = "1"; // Each carried reduction is checked against the empty-room reduction.
  try {
    const engine = new DecisionEngine();
    const record = () => (engine as any).rooms.get(`long\n${roomId}`);
    let carried = 0;
    for (let index = 0; index < 120; index++) {
      if (index % 10 === 5) {
        await assert.rejects(engine.ingestBatch([observation(index)], async () => { throw new Error("history unavailable"); }), /history unavailable/);
      }
      assert.equal((await engine.ingest(observation(index))).applied, true);
      if (record().reduction.resumed) carried++;
    }
    assert.ok(carried >= 100, `${carried}/120 reductions carried`);
  } finally { delete process.env.CANONICAL_REDUCTION_CHECK; }
});
