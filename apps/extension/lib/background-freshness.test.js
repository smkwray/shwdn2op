import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { applyRawFrameToRoomMap, roomToSnapshot } from "./showdown-parser.js";
import { createDecisionIdentity, hashCanonical } from "./decision-identity.js";

for (const failure of ["unknown-evaluate", "aborted-capture", "new-instance", "stale-without-envelope", "prolonged-sync-loss", "quiet-heartbeat", "queued-init", "initial-fragment", "lobby-before-battle"]) {
  test(`background automatically reboots capture after ${failure} without a page refresh`, async (t) => {
    const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const listeners = {}, sent = [], timers = new Map(), rooms = new Map(), received = [];
    let timerId = 0, serial = 0, instance = "first", aborted = false, unknown = failure === "unknown-evaluate";
    let lost = failure === "prolonged-sync-loss", allowReplay = false;
    const realNow = Date.now; let now = realNow(); Date.now = () => now;
    const roomId = "battle-gen9uu-recovery";
    const raw = (await fs.readFile(new URL("../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8")).replaceAll("battle-gen9ou-123456789", roomId);
    const dispatch = (message) => new Promise((resolve) => listeners.message(message, { tab: { id: 17 } }, resolve));
    const frame = (data) => dispatch({ type: "showdown-frame", payload: { data, captureId: "page", observationId: `page-${++serial}` } });
    const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
    globalThis.chrome = {
      runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
      commands: { onCommand: event("command") },
      tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"), query: async () => [],
        get: async () => ({ url: "https://play.pokemonshowdown.com/" }), sendMessage: async (_id, message) => {
          sent.push(message);
          if (message.type === "bootstrap" && allowReplay) { unknown = false; lost = false; void frame(raw); }
          return { ok: true };
        } },
      action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
      storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
    };
    globalThis.setTimeout = (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; };
    globalThis.clearTimeout = (id) => timers.delete(id);
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith("/v1/client/status")) return { ok: true };
      if (url.endsWith("/v1/observations")) {
        received.push(body.observations.map((o) => o.observationId));
        if (failure === "queued-init" && serial > 1 && !allowReplay) throw new DOMException("The user aborted a request.", "AbortError");
        if (failure === "aborted-capture" && !aborted) { aborted = true; throw new DOMException("The user aborted a request.", "AbortError"); }
        const results = [];
        for (const o of body.observations) {
          applyRawFrameToRoomMap(rooms, o.data);
          const room = rooms.get(o.roomId), snapshot = roomToSnapshot(room);
          results.push({ room: structuredClone(room), observationId: o.observationId, acknowledgedSequence: o.sequence,
            identity: snapshot ? { ...await createDecisionIdentity(snapshot), stateRevision: o.sequence, requestKind: snapshot.rawRequestSummary.requestKind } : null });
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: instance, results, historyRevision: "h" }) };
      }
      if (url.endsWith("/v1/evaluate") && (unknown || (failure === "stale-without-envelope" && !allowReplay))) {
        return { ok: false, status: 409, json: async () => ({ error: "Unknown capture session or room." }) };
      }
      const semantic = { identity: body.identity, historyRevision: body.historyRevision, localIntel: { marker: "deterministic" } };
      const resultHash = await hashCanonical(semantic);
      const metamonAdvice = { status: lost ? "unavailable" : "ready", ...(lost ? { reason: "sync_lost" } : {}), identity: body.identity, resultHash };
      return { ok: true, status: 200, json: async () => ({ envelope: { semantic, resultHash }, metamonAdvice }) };
    };
    t.after(() => { Object.assign(globalThis, original); Date.now = realNow; });
    await import(`../background.js?recovery=${failure}-${now}`);
    const settle = async () => { for (let i = 0; i < 300; i++) await setImmediate(); };
    const fire = async (ms) => {
      const entry = [...timers].find(([, value]) => value.ms === ms);
      assert.ok(entry, `a ${ms} ms retry must remain scheduled`);
      timers.delete(entry[0]); entry[1].callback(); await settle();
    };
    const bootstraps = () => sent.filter((m) => m.type === "bootstrap");
    if (failure === "lobby-before-battle") {
      await dispatch({ type: "showdown-active-room", payload: { roomId: "lobby", captureId: "page" } });
      await fire(0); now += 10000;
    }
    await frame(["initial-fragment", "lobby-before-battle"].includes(failure) ? `>${roomId}\n|init|battle` : raw); await settle();
    if (failure === "unknown-evaluate") {
      assert.equal(bootstraps().length, 1, "evaluate itself requests init, without an advice poll");
    } else if (failure === "aborted-capture") {
      now += 5001; await fire(5000);
      assert.deepEqual(received[0], received[1], "an abort retains the original observation IDs for ordered retry");
    } else if (failure === "new-instance") {
      instance = "restarted"; now += 6000;
      await frame(`>${roomId}\n|turn|15`); await settle();
      assert.ok(bootstraps().length, "a partial acknowledgement from a new process requires init");
    } else if (failure === "stale-without-envelope") {
      now += 60000; await fire(5000);
      assert.ok(bootstraps().length >= 2, "staleness does not prevent rebuilding a missing envelope");
    } else if (["initial-fragment", "lobby-before-battle"].includes(failure)) {
      assert.equal(bootstraps().length, 0, "the initial public fragment must not trigger a redundant replay before its private request arrives");
      await frame(raw); await settle();
      assert.equal(bootstraps().length, 0);
    } else if (failure === "queued-init") {
      now += 60000;
      await frame(raw); await settle();
      assert.equal(bootstraps().length, 0, "an init retained for retry must suppress additional bootstrap requests");
    } else if (failure === "quiet-heartbeat") {
      const snapshot = () => dispatch({ type: "showdown-room-protocol-snapshot", payload: { data: raw,
        captureId: "page", roomId, observationId: `page-${++serial}` } });
      await snapshot(); await settle();
      const count = received.length;
      now += 15000; await snapshot(); await settle();
      assert.equal(received.length, count + 1, "an unchanged heartbeat must reach the companion to prove capture liveness");
      assert.equal(bootstraps().length, 0, "a healthy quiet decision needs no model restart");
    } else {
      // Keep valid captures flowing to isolate the advice retry budget from capture-age expiry.
      for (let i = 0; i < 8; i++) { now += 30001; await frame(`>${roomId}\n|t:|${i}`); await settle(); }
      assert.ok(bootstraps().length > 6, "six failed replays must never permanently disable recovery");
    }
    allowReplay = true; now += 31000;
    // A page-side full replay is the response to the next automatic bootstrap, never a navigation.
    await frame(`>${roomId}\n|t:|finish`); await settle();
    for (let i = 0; i < 3 && !sent.some((m) => m.payload?.localIntel?.marker === "deterministic"); i++) {
      if ([...timers.values()].some((v) => v.ms === 5000)) { now += 6000; await fire(5000); }
    }
    assert.equal(sent.filter((m) => m.type === "update-local-intel").at(-1)?.payload?.localIntel?.marker, "deterministic");
  });
}

test("background rejects reordered, mismatched, switched-room, and pre-navigation observations", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {};
  const messages = [];
  const pending = [];
  const timers = new Map();
  let timerId = 0;
  let observationId = 0;
  const canonicalRooms = new Map();
  const roomRevisions = new Map();
  const receivedIds = [];
  const acknowledgedIds = new Set();
  let omitFirstAcknowledgement = true;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: {
      onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"),
      query: async () => [], get: async () => ({ url: "https://play.pokemonshowdown.com/" }),
      sendMessage: async (_id, message) => { messages.push(message); return { ok: true }; }
    },
    action: { enable: async () => {}, disable: async () => {} },
    scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (callback) => { timers.set(++timerId, callback); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/v1/observations")) {
      const results = [];
      for (const observation of body.observations) {
        receivedIds.push(observation.observationId);
        if (!acknowledgedIds.has(observation.observationId)) {
          applyRawFrameToRoomMap(canonicalRooms, observation.data);
          roomRevisions.set(observation.roomId, (roomRevisions.get(observation.roomId) ?? 0) + 1);
          acknowledgedIds.add(observation.observationId);
        }
        const room = canonicalRooms.get(observation.roomId);
        const revision = roomRevisions.get(observation.roomId);
        const snapshot = roomToSnapshot(room);
        results.push({ room: structuredClone(room), observationId: observation.observationId, acknowledgedSequence: observation.sequence,
          sequence: observation.sequence, identity: { ...await createDecisionIdentity(snapshot), stateRevision: revision,
          requestKind: snapshot.rawRequestSummary.requestKind } });
      }
      if (omitFirstAcknowledgement) {
        omitFirstAcknowledgement = false;
        return { ok: true, json: async () => ({ ok: true, results: [], historyRevision: "test-history" }) };
      }
      return { ok: true, json: async () => ({ ok: true, results, historyRevision: "test-history" }) };
    }
    assert.match(url, /\/v1\/evaluate$/);
    return new Promise((resolve) => pending.push({ body, resolve }));
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?freshness=${Date.now()}`);
  const raw = await fs.readFile(new URL("../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const request = JSON.parse(raw.split("\n").find((line) => line.startsWith("|request|")).slice(9));
  const room = "battle-gen9uu-freshness";
  const initial = raw.replace(/battle-gen9ou-123456789/g, room);
  const dispatch = (message) => new Promise((resolve) => listeners.message(message, { tab: { id: 7 } }, resolve));
  const frame = (data) => dispatch({ type: "showdown-frame", payload: { data, observationId: `test-${++observationId}` } });
  const changeRequest = (rqid) => frame(`>${room}\n|request|${JSON.stringify({ ...request, rqid })}`);
  const eventually = async (condition) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await setImmediate();
    }
    assert.fail("background did not reach the expected state");
  };
  const flush = async (count) => {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
    await eventually(() => pending.length === count);
  };
  const respond = (index, marker, identity = pending[index].body.identity) => pending[index].resolve({
    ok: true, json: async () => {
      const semantic = { identity, historyRevision: pending[index].body.historyRevision, localIntel: { marker } };
      return { envelope: { semantic, resultHash: await hashCanonical(semantic) } };
    }
  });
  const latest = () => dispatch({ type: "get-last-analysis" });

  await frame(initial);
  await eventually(() => messages.some((message) => message.payload?.message?.includes("acknowledgement is incomplete")));
  // Simulate a lost/malformed acknowledgement after successful server ingest.
  // The next flush must retain exactly the original idempotency key.
  // A stale injected hook and global lobby packets cannot poison a working
  // current capture session.
  await dispatch({ type: "showdown-frame", payload: { data: initial } });
  await dispatch({ type: "showdown-frame", payload: { data: "|updateuser|You|1|1" } });
  await changeRequest(1);
  await flush(1);
  assert.equal(receivedIds[0], receivedIds[1]);
  await changeRequest(2); // Same turn, new server request.
  await flush(2);
  assert.equal((await latest()).localIntel, null);
  respond(1, "current");
  await eventually(() => messages.some((message) => message.payload?.localIntel?.marker === "current"));
  pending[0].resolve({ ok: false, status: 409, json: async () => ({ error: "The decision is no longer current." }) });
  await setImmediate();
  assert.equal((await latest()).localIntel.marker, "current");
  assert.equal(messages.some((message) => message.payload?.localIntel?.marker === "old"), false);
  assert.equal(messages.some((message) => message.type === "bootstrap"), false, "a superseded evaluation must not restart a healthy current worker");

  await changeRequest(3);
  await flush(3);
  assert.equal((await latest()).localIntel, null); // Cached advice clears immediately.
  respond(2, "wrong-echo", pending[1].body.identity);
  await setImmediate();
  assert.equal((await latest()).localIntel, null);

  await changeRequest(4);
  await flush(4);
  await frame(initial.replaceAll(room, "battle-gen9uu-other"));
  await dispatch({ type: "showdown-active-room", payload: { roomId: "battle-gen9uu-other", captureId: "test-capture" } });
  respond(3, "wrong-room");
  await setImmediate();
  assert.equal((await latest()).localIntel, null);
  assert.equal(messages.some((message) => message.payload?.localIntel?.marker === "wrong-room"), false);

  await flush(5);
  // A reload is a new page hook (new captureId); Showdown's own pushState "loading" events are not navigations.
  await dispatch({ type: "showdown-frame", payload: { data: initial, captureId: "reloaded-page", observationId: "reloaded-page:1" } });
  respond(4, "pre-navigation");
  for (let i = 0; i < 50; i++) await setImmediate();
  assert.equal((await latest()).localIntel, null);
  assert.equal(messages.some((message) => message.payload?.localIntel?.marker === "pre-navigation"), false);
});

// Matters: a battle over the worker limit must keep checking and replay itself the moment a worker frees, and a battle
// whose companion restarted must be replayed into it; otherwise the owner sits on "unavailable" for the whole game.
test("background replays a waiting battle when a worker frees and after a companion restart", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, sent = [], timers = new Map(), canonicalRooms = new Map();
  let timerId = 0, advice = { status: "unavailable", reason: "capacity", slotFree: false, detail: "2 other battles already use Metamon (limit 2)" }, adviceStatus = 200;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"), query: async () => [],
      get: async () => ({ url: "https://play.pokemonshowdown.com/" }), sendMessage: async (_id, message) => { sent.push(message); return { ok: true }; } },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/v1/observations")) {
      const results = [];
      for (const observation of body.observations) {
        applyRawFrameToRoomMap(canonicalRooms, observation.data);
        const room = canonicalRooms.get(observation.roomId), snapshot = roomToSnapshot(room);
        results.push({ room: structuredClone(room), observationId: observation.observationId, acknowledgedSequence: observation.sequence,
          identity: { ...await createDecisionIdentity(snapshot), stateRevision: 1, requestKind: snapshot.rawRequestSummary.requestKind } });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, results, historyRevision: "h" }) };
    }
    const semantic = { identity: body.identity, historyRevision: body.historyRevision, localIntel: { marker: "x" } };
    const resultHash = await hashCanonical(semantic);
    const bound = { ...advice, identity: body.identity, resultHash, requestId: null, actionId: null, label: null, latencyMs: null };
    if (url.endsWith("/v1/evaluate")) return { ok: true, status: 200, json: async () => ({ ok: true, envelope: { semantic, resultHash }, metamonAdvice: bound }) };
    if (adviceStatus === 409) return { ok: false, status: 409, json: async () => ({ ok: false, error: "Unknown capture session or room." }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, metamonAdvice: bound }) };
  };
  const realNow = Date.now; let now = realNow();
  Date.now = () => now;
  t.after(() => { Object.assign(globalThis, original); Date.now = realNow; });
  await import(`../background.js?capacity=${now}`);
  const raw = await fs.readFile(new URL("../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const room = "battle-gen9uu-waiting";
  await new Promise((resolve) => listeners.message({ type: "showdown-frame", payload: { data: raw.replace(/battle-gen9ou-123456789/g, room), captureId: "p", observationId: "p:1" } }, { tab: { id: 3 } }, resolve));
  const settle = async () => { for (let i = 0; i < 300; i++) await setImmediate(); };
  const fire = async (match) => { const [id, timer] = [...timers.entries()].find(([, v]) => match(v)) ?? []; if (!id) return false; timers.delete(id); timer.callback(); await settle(); return true; };
  await settle();
  // The pick is followed from the acknowledged identity at once (a 0 ms poll), independent of the evaluation.
  assert.ok(await fire((v) => v.ms === 0), "the advice poll starts on acknowledgement");
  // The evaluation runs on the capture's acknowledgement, with no timer.
  const bootstraps = () => sent.filter((m) => m.type === "bootstrap").map((m) => m.roomId);
  assert.deepEqual(bootstraps(), [], "no replay while every worker is busy");
  assert.ok([...timers.values()].some((v) => v.ms === 1500), "a waiting battle keeps checking");
  advice = { ...advice, slotFree: true };
  assert.ok(await fire((v) => v.ms === 1500));
  assert.deepEqual(bootstraps(), [room], "a free worker triggers a replay of exactly this battle");
  const strip = sent.filter((m) => m.type === "update-local-intel").at(-1).payload.metamonAdvice;
  assert.equal(strip.reason, "capacity"); assert.match(strip.detail, /limit 2/);
  // Companion restarted: it no longer knows the capture. The poll asks for a replay instead of going quiet.
  advice = { status: "warming" }; adviceStatus = 409; now += 60_000;
  assert.ok(await fire((v) => v.ms === 1500));
  assert.deepEqual(bootstraps(), [room, room], "the restarted companion gets this battle replayed");
  assert.ok([...timers.values()].some((v) => v.ms === 2000), "and the client keeps polling until the replay lands");
});

// Matters: a browser on one machine can reach the companion on another through a tunnel. The companion stamps
// rooms with its own clock; comparing that with the browser's clock made decisions look "stale" by the clock skew and
// the strip never got its envelope. Freshness must use the browser's own receive time.
test("background judges freshness by its own clock, not the companion's", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, sent = [], timers = new Map(), canonicalRooms = new Map();
  let timerId = 0;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"), query: async () => [],
      get: async () => ({ url: "https://play.pokemonshowdown.com/" }), sendMessage: async (_id, message) => { sent.push(message); return { ok: true }; } },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/v1/observations")) {
      const results = [];
      for (const observation of body.observations) {
        applyRawFrameToRoomMap(canonicalRooms, observation.data);
        const room = canonicalRooms.get(observation.roomId), snapshot = roomToSnapshot(room);
        // The companion's clock runs 2 minutes behind the browser's.
        results.push({ room: { ...structuredClone(room), updatedAt: Date.now() - 120_000 }, observationId: observation.observationId, acknowledgedSequence: observation.sequence,
          identity: { ...await createDecisionIdentity(snapshot), stateRevision: 1, requestKind: snapshot.rawRequestSummary.requestKind } });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, results, historyRevision: "h" }) };
    }
    const semantic = { identity: body.identity, historyRevision: body.historyRevision, localIntel: { marker: "fresh" } };
    return { ok: true, status: 200, json: async () => ({ ok: true, envelope: { semantic, resultHash: await hashCanonical(semantic) } }) };
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?skew=${Date.now()}`);
  const raw = await fs.readFile(new URL("../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  await new Promise((resolve) => listeners.message({ type: "showdown-frame", payload: { data: raw.replace(/battle-gen9ou-123456789/g, "battle-gen9uu-skew"), captureId: "p", observationId: "p:1" } }, { tab: { id: 5 } }, resolve));
  for (let i = 0; i < 300; i++) await setImmediate();
  for (const [id, timer] of [...timers.entries()]) { timers.delete(id); timer.callback(); }
  for (let i = 0; i < 300; i++) await setImmediate();
  assert.ok(sent.some((m) => m.type === "update-local-intel" && m.payload.localIntel?.marker === "fresh"), "the decision is displayed");
});

// Matters: in a real-browser run the advisor's pick was ready 3 s after a replay, but the strip said "thinking…" for
// 25 s: the poll's answer landed while a recovery snapshot was being captured, was dropped, and nothing polled again.
test("background keeps polling when the advisor's answer lands during a capture", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, sent = [], timers = new Map(), canonicalRooms = new Map();
  let timerId = 0, adviceCalls = 0, holdObservations = null, frames = 0;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"), query: async () => [],
      get: async () => ({ url: "https://play.pokemonshowdown.com/" }), sendMessage: async (_id, message) => { sent.push(message); return { ok: true }; } },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const raw = await fs.readFile(new URL("../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const room = "battle-gen9uu-race", data = raw.replace(/battle-gen9ou-123456789/g, room);
  // The page's periodic recovery snapshot: captured like a frame, but it never hides the current decision.
  const dispatch = () => new Promise((resolve) => listeners.message({ type: "showdown-room-protocol-snapshot", payload: { roomId: room, data: `${data}\n|t:|${++frames}`, captureId: "p", observationId: `p:${frames + 1}` } }, { tab: { id: 6 } }, resolve));
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/v1/observations")) {
      if (holdObservations) await holdObservations;
      const results = [];
      for (const observation of body.observations) {
        // As the companion: a recovery snapshot that matches the captured state changes nothing.
        if (observation.source !== "recovery") applyRawFrameToRoomMap(canonicalRooms, observation.data);
        const live = canonicalRooms.get(observation.roomId), snapshot = roomToSnapshot(live);
        results.push({ room: structuredClone(live), observationId: observation.observationId, acknowledgedSequence: observation.sequence,
          identity: { ...await createDecisionIdentity(snapshot), stateRevision: 1, requestKind: snapshot.rawRequestSummary.requestKind } });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, results, historyRevision: "h" }) };
    }
    const semantic = { identity: body.identity, historyRevision: body.historyRevision, localIntel: { marker: "m" }, snapshot: { legalActions: [{ id: "move:1|tera=0" }] } };
    const resultHash = await hashCanonical(semantic);
    const advice = (status) => ({ status, identity: body.identity, resultHash, requestId: "r", actionId: status === "ready" ? "move:1|tera=0" : null, label: status === "ready" ? "Scald" : null, latencyMs: 1 });
    if (url.endsWith("/v1/evaluate")) return { ok: true, status: 200, json: async () => ({ ok: true, envelope: { semantic, resultHash }, metamonAdvice: advice("warming") }) };
    adviceCalls += 1;
    // The first ready answer arrives while another frame is still being captured.
    let release = () => {};
    if (adviceCalls === 1) { holdObservations = new Promise((r) => { release = r; }); await dispatch(); }
    const answer = { ok: true, status: 200, json: async () => ({ ok: true, metamonAdvice: advice("ready") }) };
    original.setTimeout(() => { holdObservations = null; release(); }, 20);
    return answer;
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?race=${Date.now()}`);
  await new Promise((resolve) => listeners.message({ type: "showdown-frame", payload: { data, captureId: "p", observationId: "p:1" } }, { tab: { id: 6 } }, resolve));
  // Hashing runs on the crypto thread pool, so let real time pass as well as the microtask queue.
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => original.setTimeout(r, 5)); await setImmediate(); } };
  await settle();
  for (let round = 0; round < 8 && !sent.some((m) => m.payload?.metamonAdvice?.status === "ready"); round++) {
    for (const [id, timer] of [...timers.entries()]) { timers.delete(id); timer.callback(); }
    await settle();
  }
  assert.ok(adviceCalls >= 1, "the advisor was polled");
  assert.ok(sent.some((m) => m.type === "update-local-intel" && m.payload?.metamonAdvice?.status === "ready"), "the ready pick reaches the page");
});

// Matters: the pick and notes once appeared, vanished and came back after another wait: every captured
// frame (chat, timer, spectators, another battle) blanked the shown decision until a fresh evaluation landed, and a
// trailing 200 ms timer, restarted by each frame, stood between capture and evaluation. The shown decision now stays
// (marked updating) until a different decision is known, a new request hides it at once, and evaluation starts as
// soon as the capture is acknowledged.
test("background keeps the shown decision through unrelated frames and evaluates without a timer", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, sent = [], timers = new Map(), canonicalRooms = new Map(), evaluated = [];
  let timerId = 0, hold = null, frames = 0;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"), query: async () => [],
      get: async () => ({ url: "https://play.pokemonshowdown.com/" }), sendMessage: async (_id, message) => { sent.push(message); return { ok: true }; } },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const raw = await fs.readFile(new URL("../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const room = "battle-gen9uu-keep", sample = raw.replace(/battle-gen9ou-123456789/g, room);
  const request = { ...JSON.parse(sample.split("\n").find((line) => line.startsWith("|request|")).slice(9)), rqid: 5 };
  const data = sample.split("\n").map((line) => line.startsWith("|request|") ? `|request|${JSON.stringify(request)}` : line).join("\n");
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/v1/observations")) {
      if (hold) await hold.promise;
      const results = [];
      for (const observation of body.observations) {
        applyRawFrameToRoomMap(canonicalRooms, observation.data);
        const live = canonicalRooms.get(observation.roomId), snapshot = roomToSnapshot(live);
        results.push({ room: structuredClone(live), observationId: observation.observationId, acknowledgedSequence: observation.sequence,
          identity: { ...await createDecisionIdentity(snapshot), stateRevision: 1, requestKind: snapshot.rawRequestSummary.requestKind } });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, results, historyRevision: "h" }) };
    }
    const legalActions = roomToSnapshot(canonicalRooms.get(room)).legalActions;
    const semantic = { identity: body.identity, historyRevision: body.historyRevision, localIntel: { marker: `rqid ${body.identity.rqid}` }, snapshot: { legalActions } };
    const resultHash = await hashCanonical(semantic);
    const advice = { status: "ready", identity: body.identity, resultHash, requestId: "r", actionId: legalActions[0].id, label: "Pick", latencyMs: 1 };
    if (url.includes("/v1/evaluate")) { evaluated.push(body.identity.rqid); return { ok: true, status: 200, json: async () => ({ ok: true, envelope: { semantic, resultHash }, metamonAdvice: advice }) }; }
    return { ok: true, status: 200, json: async () => ({ ok: true, metamonAdvice: advice }) };
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?keep=${Date.now()}`);
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => original.setTimeout(r, 5)); await setImmediate(); } };
  const frame = (text) => new Promise((resolve) => listeners.message({ type: "showdown-frame", payload: { data: text, captureId: "p", observationId: `p:${++frames}` } }, { tab: { id: 8 } }, resolve));
  const shown = () => sent.filter((m) => m.type === "update-local-intel").at(-1).payload;
  const held = () => { let release; const promise = new Promise((r) => { release = r; }); hold = { promise, release }; return () => { hold = null; release(); }; };

  // Only the advice poll (0 ms, started on acknowledgement) is a timer; the evaluation itself needs none.
  const poll = async () => { for (const [id, timer] of [...timers.entries()].filter(([, v]) => v.ms === 0)) { timers.delete(id); timer.callback(); } await settle(); };
  await frame(data);
  await settle();
  assert.deepEqual(evaluated, [request.rqid], "evaluated on acknowledgement, with no timer fired");
  await poll();
  assert.equal(shown().localIntel.marker, `rqid ${request.rqid}`);
  assert.equal(shown().metamonAdvice.status, "ready");

  // Chat and timer lines while the owner thinks: the decision stays on screen throughout, marked updating meanwhile.
  const firstShown = sent.length;
  let release = held();
  await frame(`>${room}\n|c|☆Opponent|good luck`);
  await settle();
  assert.equal(shown().metamonAdvice?.status, "ready", "the pick stays while the frame is captured");
  assert.equal(shown().updating, true);
  release();
  await settle();
  await frame(`>${room}\n|inactive|You have 120 seconds to make your decision.`);
  await settle();
  const updates = sent.slice(firstShown).filter((m) => m.type === "update-local-intel");
  assert.ok(updates.length >= 2);
  assert.ok(updates.every((m) => m.payload.envelope && m.payload.metamonAdvice?.status === "ready"), "never blanked");
  assert.equal(shown().updating, false);

  // A new request is a new decision: the old pick is hidden at once, before the companion acknowledges it.
  release = held();
  await frame(`>${room}\n|request|${JSON.stringify({ ...request, rqid: request.rqid + 1 })}`);
  await settle();
  assert.equal(shown().envelope, null);
  assert.equal(shown().metamonAdvice, null);
  release();
  await settle();
  await poll();
  assert.equal(shown().localIntel.marker, `rqid ${request.rqid + 1}`);
  assert.equal([...timers.values()].filter((v) => v.ms === 200).length, 0, "no trailing evaluation timer");
});

// Matters: reloading the extension orphaned the Showdown tab and a mid-battle refresh disconnected the owner. On install,
// update or startup the background must re-inject the bridge into open Showdown tabs whose bridge no longer answers (and
// the page hook only where the page has none), without touching tabs that are fine or that are not Showdown.
test("extension install/update re-injects the bridge into orphaned Showdown tabs without a page refresh", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, injected = [], reloaded = [];
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  // Tab 1: orphaned bridge, hook alive. Tab 2: healthy bridge. Tab 3: opened before install (no hook, no bridge).
  const bridges = new Set([2]), hooks = new Set([1, 2]);
  const tabs = [1, 2, 3].map((id) => ({ id, url: "https://play.pokemonshowdown.com/battle-gen9uu-1" }));
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"), reload: async (id) => reloaded.push(id),
      query: async (filter) => (filter?.url ? tabs : [...tabs, { id: 9, url: "https://example.com/" }]),
      sendMessage: async (id, message) => { if (message.type === "ping" && !bridges.has(id)) throw new Error("Could not establish connection. Receiving end does not exist."); return { ok: true }; } },
    action: { enable: async () => {}, disable: async () => {} },
    scripting: { executeScript: async ({ target, world, files, func }) => {
      if (func) return [{ result: hooks.has(target.tabId) ? "hook-8" : null }];
      injected.push(`${target.tabId}:${world ?? "ISOLATED"}:${files.join(",")}`);
      if (files.includes("content-bridge.js")) bridges.add(target.tabId);
      if (files.includes("page-hook.js")) hooks.add(target.tabId);
      return [];
    } },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?reattach=${Date.now()}`);
  for (const trigger of ["installed", "startup"]) {
    injected.length = 0; if (trigger === "startup") bridges.delete(1);
    listeners[trigger]({ reason: "update" });
    for (let i = 0; i < 400 && injected.filter((x) => x.includes("content-bridge")).length < (trigger === "installed" ? 2 : 1); i++) await setImmediate();
    for (let i = 0; i < 50; i++) await setImmediate();
    assert.deepEqual(injected.sort(), trigger === "installed"
      ? ["1:ISOLATED:content-bridge.js", "3:ISOLATED:content-bridge.js", "3:MAIN:page-hook.js"]
      : ["1:ISOLATED:content-bridge.js"], trigger);
  }
  assert.deepEqual(reloaded, [], "never refreshes a tab");
});

// Matters: the page hook survives an extension reload, so a new bridge must take over the running page: the orphaned
// bridge (an older extension load, its own JS world) stops at the successor's hello so the two never fight over the
// controls, and the successor asks the hook to replay every battle from |init|. A live bridge ignores a stray hello, a
// normal page load asks for no replay, and an orphan without a successor says "reconnecting…" before, as a last resort,
// asking for a tab refresh.
test("a re-injected bridge retires its orphaned predecessor and replays the battle without a refresh", async () => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const vm = await import("node:vm");
  const listeners = [], posted = [];
  let now = 0;
  const bus = (data) => { posted.push(data.kind); for (const l of [...listeners]) if (l.type === "message") l.fn({ source: l.win, data }); };
  let strip = null;
  const controls = { querySelector: (sel) => (sel === "[data-s2o=strip]" ? strip : null), querySelectorAll: () => [], prepend: (el) => { strip = el; },
    closest: () => ({ id: "room-battle-gen9uu-1" }), contains: () => true };
  const room = { id: "room-battle-gen9uu-1", offsetParent: {}, querySelector: () => controls };
  const document = { readyState: "complete", documentElement: {}, querySelector: () => null, getElementById: () => null, addEventListener() {}, body: { append() {} },
    querySelectorAll: (sel) => (sel === '[id^="room-battle-"]' ? [room] : []),
    createElement: () => ({ style: {}, dataset: {}, append() {}, prepend() {}, querySelector: () => null, querySelectorAll: () => [] }) };
  const world = (readyState = "complete") => {
    const timeouts = [];
    const runtime = { id: "ext", onMessage: { addListener() {}, removeListener() {} }, getURL: (p) => p,
      sendMessage: async () => { if (!runtime.id) throw new Error("Extension context invalidated."); return { ok: true }; } };
    const win = { crypto: globalThis.crypto, postMessage: bus, setInterval: () => 1, clearInterval() {}, setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
      addEventListener: (type, fn) => listeners.push({ type, fn, win }),
      removeEventListener: (type, fn) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1); } };
    const ctx = vm.createContext({ window: win, document: { ...document, readyState }, chrome: { runtime }, localStorage: { getItem: () => null, setItem() {} },
      MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, console, setTimeout: () => 1, getComputedStyle: () => ({}),
      fetch: async () => ({ ok: false, json: async () => ({}) }), Date: { now: () => now }, Error, location: { href: "https://play.pokemonshowdown.com/" } });
    vm.runInContext(source, ctx);
    return { runtime, timeouts, ctx, messageListeners: () => listeners.filter((l) => l.type === "message" && l.win === win).length };
  };
  const pageLoad = world("loading");
  assert.deepEqual(posted, ["bridge-hello"], "a normal page load replays nothing");
  assert.equal(pageLoad.messageListeners(), 1);
  bus({ source: "showdnass", kind: "bridge-hello", instance: "stray" });
  assert.equal(pageLoad.messageListeners(), 1, "a live bridge ignores a hello");

  // The extension reloads: this bridge is orphaned. Its next forward fails, and with no successor yet it says
  // "reconnecting…", then (after the grace period, still alone) asks for a refresh as the last resort.
  pageLoad.runtime.id = undefined;
  bus({ source: "showdnass", kind: "active-room", roomId: "battle-gen9uu-1" });
  for (let i = 0; i < 20; i++) await setImmediate();
  assert.match(strip?.innerHTML ?? "", /reconnecting…/);
  assert.doesNotMatch(strip.innerHTML, /refresh this tab/);
  now += 15000; for (const t of pageLoad.timeouts.filter((t) => t.ms === 15000)) t.fn();
  assert.match(strip.innerHTML, /refresh this tab/, "last resort without a successor");

  // The background injects a successor (a new world): the orphan retires and the successor replays every battle.
  posted.length = 0; strip = null;
  const successor = world("complete");
  assert.deepEqual(posted, ["bridge-hello", "bootstrap-request"]);
  assert.equal(pageLoad.messageListeners(), 0, "the orphan stopped listening");
  assert.equal(successor.messageListeners(), 1);
  now += 15000; for (const t of pageLoad.timeouts) t.fn();
  assert.equal(strip, null, "the retired orphan never writes its refresh message over the successor");
});

// Matters: every section fills as soon as its information is available, not after all of it arrives: the pick shows before any deterministic section when it is ready first; the
// board (speed, sets), damage and threats then show stage by stage; a newer view of the same request keeps each earlier
// section (stale, marked) until its own replacement arrives; the complete result clears every stale mark.
test("background shows the pick and each deterministic stage as soon as each is ready, keeping stale sections per section", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, sent = [], timers = new Map(), canonicalRooms = new Map(), asked = [];
  let timerId = 0, frames = 0, holdEvaluate = null;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"), query: async () => [],
      get: async () => ({ url: "https://play.pokemonshowdown.com/" }), sendMessage: async (_id, message) => { sent.push(message); return { ok: true }; } },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const raw = await fs.readFile(new URL("../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const room = "battle-gen9uu-staged", data = raw.replace(/battle-gen9ou-123456789/g, room);
  const sections = { board: { speedPreview: { activeRelation: "faster" }, opponents: [] }, damage: { playerDamagePreview: [{ actionId: "move:1|tera=0" }] },
    threats: { opponentThreatPreview: [{ moveName: "Hydro Pump" }] }, final: { opponentActionPrediction: { topActionClass: "stay_attack" } } };
  const order = ["board", "damage", "threats", "final"];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/v1/client/status")) return { ok: true };
    if (url.endsWith("/v1/observations")) {
      const results = [];
      for (const o of body.observations) {
        applyRawFrameToRoomMap(canonicalRooms, o.data);
        const live = canonicalRooms.get(o.roomId), snapshot = roomToSnapshot(live);
        results.push({ room: structuredClone(live), observationId: o.observationId, acknowledgedSequence: o.sequence,
          identity: { ...await createDecisionIdentity(snapshot), stateRevision: o.sequence, requestKind: snapshot.rawRequestSummary.requestKind } });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, results, historyRevision: "h" }) };
    }
    const legalActions = roomToSnapshot(canonicalRooms.get(room)).legalActions;
    if (url.includes("/v1/metamon/advice")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, metamonAdvice: { status: "ready", identity: body.identity, requestId: "r",
        actionId: legalActions[0].id, label: "Pick", latencyMs: 1 } }) };
    }
    asked.push(body.after ?? null);
    if (holdEvaluate) await holdEvaluate.promise;
    const stage = order[order.indexOf(body.after ?? "") + 1];
    const localIntel = Object.assign({ marker: `rev ${body.identity.stateRevision}` }, ...order.slice(0, order.indexOf(stage) + 1).map((name) => sections[name]));
    const semantic = { identity: body.identity, historyRevision: body.historyRevision, ...(stage === "final" ? {} : { stage }), localIntel, snapshot: { legalActions } };
    return { ok: true, status: 200, json: async () => ({ ok: true, stage: stage === "final" ? null : stage, final: stage === "final",
      envelope: { semantic, resultHash: await hashCanonical(semantic) } }) };
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?staged=${Date.now()}`);
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => original.setTimeout(r, 5)); await setImmediate(); } };
  const poll = async () => { for (const [id, timer] of [...timers.entries()].filter(([, v]) => v.ms === 0)) { timers.delete(id); timer.callback(); } await settle(); };
  const frame = (text) => new Promise((resolve) => listeners.message({ type: "showdown-frame", payload: { data: text, captureId: "p", observationId: `p:${++frames}` } }, { tab: { id: 9 } }, resolve));
  const updates = () => sent.filter((m) => m.type === "update-local-intel").map((m) => m.payload);
  const hold = () => { let release; const promise = new Promise((r) => { release = r; }); holdEvaluate = { promise }; return () => { holdEvaluate = null; release(); }; };

  let release = hold();
  await frame(data); await settle(); await poll();
  const early = updates().at(-1);
  assert.equal(early.metamonAdvice?.status, "ready", "the pick shows while the deterministic result is still pending");
  assert.equal(early.envelope, null);
  release(); await settle();
  assert.deepEqual(asked, [null, "board", "damage", "threats"], "each stage is asked for as soon as the previous one is shown");
  const stages = updates().filter((u) => u.envelope).map((u) => [u.envelope.semantic.stage ?? "final", u.pendingSections]);
  assert.deepEqual(stages, [["board", ["damage", "threats", "analysis"]], ["damage", ["threats", "analysis"]], ["threats", ["analysis"]], ["final", []]]);
  assert.ok(updates().filter((u) => u.envelope).every((u) => u.metamonAdvice?.status === "ready"), "the pick never waits for or disappears between stages");
  // Each push is cloned onto the page's main thread: it carries the envelope's header, never its snapshot or sections again.
  assert.ok(updates().filter((u) => u.envelope).every((u) => !u.envelope.semantic.snapshot && !u.envelope.semantic.localIntel && u.envelope.resultHash));

  // A chat line: the same request, a newer view. Its board replaces speed and sets; damage and threats stay (stale).
  release = hold();
  await frame(`>${room}\n|c|☆Opponent|hi`); await settle();
  release(); await settle();
  const revalidated = updates().filter((u) => u.envelope && u.localIntel?.marker === "rev 2");
  const boardView = revalidated.find((u) => u.envelope.semantic.stage === "board");
  assert.ok(boardView, "the newer view's board is shown at once");
  assert.deepEqual(boardView.staleSections, ["damage", "threats", "analysis"]);
  assert.deepEqual(boardView.localIntel.playerDamagePreview, sections.damage.playerDamagePreview, "the earlier damage stays until replaced");
  assert.equal(boardView.metamonAdvice?.status, "ready");
  assert.deepEqual(revalidated.at(-1).staleSections, [], "the complete result leaves nothing stale");
});
