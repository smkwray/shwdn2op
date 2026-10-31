import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "companion-stall-test-"));
process.env.LOCAL_INTEL_STORE_PATH = path.join(directory, "intel.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(directory, "curated.json");
const { buildServer } = await import("../server.js");
after(() => fs.rm(directory, { recursive: true, force: true }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: PromiseLike<T>, label: string, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} stalled`)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const route of ["evaluate", "metamon/advice"]) {
  test(`a held ${route} HTTP response cannot serialize later battle observations`, async () => {
    const app = buildServer(), sending = deferred(), release = deferred();
    let response: Promise<unknown> | undefined;
    app.addHook("onSend", async (request, _reply, payload) => {
      if (request.url === `/v1/${route}`) { sending.resolve(); await release.promise; }
      return payload;
    });
    try {
      const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
      const observation = { observationId: "first", sessionId: `held-${route}`, sequence: 1,
        roomId: "battle-gen9ou-123456789", source: "protocol", data: raw };
      const initial = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
      assert.equal(initial.statusCode, 200, initial.body);
      const { results, historyRevision } = initial.json();
      response = Promise.resolve(app.inject({ method: "POST", url: `/v1/${route}`, payload: {
        sessionId: observation.sessionId, identity: results[0].identity, historyRevision
      } }));
      await bounded(sending.promise, "response construction");
      const next = await bounded(app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [{
        ...observation, observationId: "second", sequence: 2, data: `>${observation.roomId}\n|-boost|p2a: Dragapult|atk|1`
      }] } }), "ingestion behind held response");
      assert.equal(next.statusCode, 200, next.body);
    } finally { release.resolve(); await response; await app.close(); }
  });

  test(`a disconnected ${route} client cannot hold ingestion after its response socket has closed`, async () => {
    const app = buildServer();
    const entered = deferred(), resume = deferred(), closed = deferred(), sending = deferred();
    app.addHook("preHandler", async (request, reply) => {
      if (request.url !== `/v1/${route}`) return;
      reply.raw.once("close", closed.resolve);
      entered.resolve();
      await resume.promise;
    });
    app.addHook("onSend", async (request, _reply, payload) => {
      if (request.url === `/v1/${route}`) sending.resolve();
      return payload;
    });
    try {
      const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
      const observation = { observationId: "first", sessionId: `aborted-${route}`, sequence: 1,
        roomId: "battle-gen9ou-123456789", source: "protocol", data: raw };
      const initial = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
      assert.equal(initial.statusCode, 200, initial.body);
      const { results, historyRevision } = initial.json();
      const payload = { sessionId: observation.sessionId, identity: results[0].identity, historyRevision };
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const client = http.request(`${address}/v1/${route}`, { method: "POST", headers: { "content-type": "application/json" } });
      client.on("error", () => {});
      client.end(JSON.stringify(payload));
      await bounded(entered.promise, "request arrival");
      client.destroy();
      await bounded(closed.promise, "socket close");
      resume.resolve();
      await bounded(sending.promise, "response construction");
      const next = await bounded(app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [{
        ...observation, observationId: "second", sequence: 2, data: `>${observation.roomId}\n|-boost|p2a: Dragapult|atk|1`
      }] } }), "ingestion after abort");
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(next.json().results[0].identity.stateRevision, results[0].identity.stateRevision + 1);
    } finally {
      resume.resolve();
      app.server.closeAllConnections();
      await app.close();
    }
  });
}

test("timed-out ingestion releases the queue and fences its late staged state; the original ID remains retryable", async () => {
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  const engine = new DecisionEngine({ operationMs: 80 }), held = deferred();
  const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const first = { observationId: "first", sessionId: "fenced", sequence: 1,
    roomId: "battle-gen9ou-123456789", source: "protocol" as const, data: raw };
  try {
    await assert.rejects(bounded(engine.ingestBatch([first], async () => held.promise), "watchdog", 1000), /ingestion stalled after/);
    assert.match(engine.synchronizationStatus().lastFailure!, /ingestion stalled/);
    const accepted = await engine.ingest(first);
    assert.equal(accepted.applied, true, "the failed transaction never consumed its idempotency key");
    const next = await engine.ingest({ ...first, observationId: "second", sequence: 2, data: `>${first.roomId}\n|turn|15` });
    held.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual((await engine.read(first.sessionId, first.roomId)).identity, next.identity, "late completion cannot roll back the room");
  } finally { held.resolve(); }
});

test("a shared envelope whose hash never finishes expires, is evicted, and never blocks ingestion", async (t) => {
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  const { sharedDecisionEnvelope } = await import("../state/decisionEnvelope.js");
  const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  const engine = new DecisionEngine(), context = await createEphemeralIntelEvaluationContext();
  const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const observation = { observationId: "first", sessionId: "envelope-stall", sequence: 1,
    roomId: "battle-gen9ou-123456789", source: "protocol" as const, data: raw };
  const current = await engine.ingest(observation), held = deferred(), entered = deferred();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let stalled = false;
  t.mock.method(crypto.subtle, "digest", async (...args: Parameters<typeof crypto.subtle.digest>) => {
    if (!stalled && new TextDecoder().decode(args[1]).includes('"contractVersion":"showdown-decision@1"')) {
      stalled = true; entered.resolve(); await held.promise;
    }
    return digest(...args);
  });
  const build = () => sharedDecisionEnvelope(observation.sessionId, current.snapshot!, current.identity!, context);
  try {
    const pending = assert.rejects(bounded(build(), "envelope watchdog", 6000), /deterministic envelope stalled/);
    await bounded(entered.promise, "envelope hash");
    const next = await bounded(engine.ingest({ ...observation, observationId: "next", sequence: 2,
      data: `>${observation.roomId}\n|-boost|p2a: Dragapult|atk|1` }), "independent ingestion");
    assert.equal(next.applied, true);
    await pending;
    const retried = await bounded(build(), "envelope retry");
    assert.ok(retried.semantic.localIntel.playerDamagePreview?.length);
    held.resolve();
    assert.deepEqual(await build(), retried);
  } finally { held.resolve(); t.mock.restoreAll(); }
});

test("a stuck history read times out without publishing late history or poisoning following transactions", async (t) => {
  const { commitCanonicalSnapshots, flushIntelStore, captureIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  await flushIntelStore();
  const stat = fs.stat.bind(fs), entered = deferred(), held = deferred();
  let stopped = false;
  t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    if (!stopped && args[0] === process.env.LOCAL_INTEL_STORE_PATH) { stopped = true; entered.resolve(); await held.promise; }
    return stat(...args);
  });
  try {
    const pending = assert.rejects(bounded(commitCanonicalSnapshots([]), "history watchdog", 4500), /canonical history commit stalled/);
    await bounded(entered.promise, "history read");
    await pending;
    const next = await bounded(commitCanonicalSnapshots([]), "history retry");
    held.resolve();
    assert.equal((await captureIntelEvaluationContext()).revision, next.revision);
  } finally { held.resolve(); t.mock.restoreAll(); }
});

test("a stalled persistence write is visible in health state while memory commits continue", async (t) => {
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  const { commitCanonicalSnapshots, flushIntelStore, intelStorePersistence } = await import("../history/opponentIntelStore.js");
  await flushIntelStore();
  const engine = new DecisionEngine();
  const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const current = await engine.ingest({ observationId: "persist", sessionId: "persist", sequence: 1,
    roomId: "battle-gen9ou-123456789", source: "protocol", data: raw });
  await commitCanonicalSnapshots([current.snapshot!]);
  const entered = deferred(), held = deferred(), write = fs.writeFile.bind(fs), now = Date.now;
  let flushing: Promise<void> | undefined;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(`${process.env.LOCAL_INTEL_STORE_PATH}.pending-`)) { entered.resolve(); await held.promise; }
    return write(...args);
  });
  try {
    flushing = flushIntelStore();
    await bounded(entered.promise, "persistence write");
    t.mock.method(Date, "now", () => now() + 6000);
    assert.equal(intelStorePersistence().error, "history_persistence_stalled");
    assert.equal(intelStorePersistence().pending, true);
    await bounded(commitCanonicalSnapshots([]), "memory-only commit during persistence stall");
    held.resolve(); await flushing;
    assert.equal(intelStorePersistence().error, null);
  } finally { held.resolve(); await flushing; t.mock.restoreAll(); }
});

test("malformed existing history is never replaced with an empty store on retry", async () => {
  const { commitCanonicalSnapshots, flushIntelStore } = await import("../history/opponentIntelStore.js");
  await flushIntelStore();
  for (const file of [process.env.LOCAL_INTEL_STORE_PATH!, process.env.EXTERNAL_CURATED_STORE_PATH!]) {
    const before = await fs.readFile(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    try {
      await fs.writeFile(file, "{malformed history}");
      await assert.rejects(commitCanonicalSnapshots([]), SyntaxError);
      assert.equal(await fs.readFile(file, "utf8"), "{malformed history}", "rejected input is never overwritten");
    } finally {
      if (before) await fs.writeFile(file, before);
      else await fs.rm(file, { force: true });
    }
  }
  await commitCanonicalSnapshots([]);
});

// Matters: each section should show as soon as its information is available, not after everything is ready: the speed line and the revealed/likely sets come first, while damage is still being calculated, and each
// later stage follows on the next held request. Every stage is bound to the decision and history view and carries its own
// integrity hash; the complete result is unchanged; ingestion never waits for any of it.
test("staged evaluation answers with the board before damage completes, and ingestion never waits for the stages", async (t) => {
  const { hashCanonical } = await import("../../../extension/lib/decision-identity.js");
  const app = buildServer(), held = deferred(), entered = deferred();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "digest", async (...args: Parameters<typeof crypto.subtle.digest>) => {
    // Hold the damage stage's own result hash: the board is ready, everything after it is not.
    if (new TextDecoder().decode(args[1] as ArrayBuffer).includes('"stage":"damage"')) { entered.resolve(); await held.promise; }
    return digest(...args);
  });
  try {
    const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
    const observation = { observationId: "staged-1", sessionId: "staged", sequence: 1, roomId: "battle-gen9ou-123456789", source: "protocol", data: raw };
    const ingested = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
    assert.equal(ingested.statusCode, 200, ingested.body);
    const query = { sessionId: "staged", identity: ingested.json().results[0].identity, historyRevision: ingested.json().historyRevision };
    const first = await bounded(app.inject({ method: "POST", url: "/v1/evaluate", payload: query }), "board stage");
    assert.equal(first.statusCode, 200, first.body);
    const board = first.json();
    assert.equal(board.final, false); assert.equal(board.stage, "board"); assert.equal(board.envelope.semantic.stage, "board");
    assert.deepEqual(board.envelope.semantic.identity, query.identity);
    assert.equal(board.envelope.semantic.historyRevision, query.historyRevision);
    assert.equal(board.envelope.resultHash, await hashCanonical(board.envelope.semantic));
    assert.ok(board.envelope.semantic.localIntel.speedPreview, "speed first");
    assert.ok(board.envelope.semantic.localIntel.opponents.length, "revealed and likely sets first");
    assert.equal(board.envelope.semantic.localIntel.playerDamagePreview, undefined, "damage is not waited for");
    assert.equal(board.envelope.semantic.snapshot, undefined, "a partial stage does not resend the client's own request view");
    await bounded(entered.promise, "damage stage started");
    // While the build is held, observations still commit, and the held request waits without any lock.
    const next = app.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "board" } });
    const other = await bounded(app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [{
      ...observation, sessionId: "other-capture", observationId: "other-1" }] } }), "independent ingestion");
    assert.equal(other.statusCode, 200, other.body);
    held.resolve();
    const later = (await bounded(next, "next stage", 5000)).json();
    assert.notEqual(later.stage, "board");
    assert.ok(later.envelope.semantic.localIntel.playerDamagePreview?.length);
    const complete = (await bounded(app.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "threats" } }), "complete", 5000)).json();
    assert.equal(complete.final, true); assert.equal(complete.envelope.semantic.stage, undefined);
    assert.ok(complete.envelope.semantic.snapshot, "the complete envelope is unchanged");
    for (const key of ["speedPreview", "hazardSummary"]) {
      assert.deepEqual(board.envelope.semantic.localIntel[key], complete.envelope.semantic.localIntel[key], `${key} is the complete result's own value`);
    }
    assert.deepEqual(board.envelope.semantic.localIntel.opponents.map(({ posterior: _p, ...entry }: any) => entry),
      complete.envelope.semantic.localIntel.opponents.map(({ posterior: _p, ...entry }: any) => entry));
  } finally { held.resolve(); t.mock.restoreAll(); await app.close(); }
});

// Matters: Promise.all around synchronous CPU work does not let anything else run. The staged build yields to the event
// loop after each stage (and between the remaining posteriors), so a ready stage can be sent and a model reply read
// before the next stage's calculation.
test("the staged deterministic build yields to the event loop between stages", async () => {
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  const { buildDecisionEnvelope } = await import("../state/decisionEnvelope.js");
  const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
  const raw = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const engine = new DecisionEngine(), context = await createEphemeralIntelEvaluationContext();
  const current = await engine.ingest({ observationId: "yield-1", sessionId: "yield", sequence: 1, roomId: "battle-gen9ou-123456789", source: "protocol", data: raw });
  const order: string[] = [];
  await buildDecisionEnvelope(current.snapshot!, current.identity!, context, [], async (stage) => {
    order.push(stage);
    setImmediate(() => order.push(`macrotask after ${stage}`));
  });
  assert.deepEqual(order, ["board", "macrotask after board", "damage", "macrotask after damage", "threats", "macrotask after threats"]);
});
