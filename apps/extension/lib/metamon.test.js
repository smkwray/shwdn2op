import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { setImmediate } from "node:timers/promises";
import { outgoingBattleEvents, currentMetamonAdvice, metamonText } from "./metamon.js";
import { DEFAULT_SETTINGS } from "./storage.js";

// Matters: unrelated chat and lobby commands must never enter the private advisor stream.
test("Metamon forwards battle /choose, /team and /undo only, plus explicit room lifecycle", () => {
  for (const choice of ["move 2", "move 2 terastallize", "switch 6", "team 213456"]) {
    assert.deepEqual(outgoingBattleEvents(`battle-gen9uu-123|/choose ${choice}|47`), [{ kind: "choice", roomId: "battle-gen9uu-123", data: `/choose ${choice}|47` }]);
  }
  assert.equal(outgoingBattleEvents("battle-gen9uu-123|/undo|47")[0].data, "/undo|47");
  // The default (old) Showdown client sends team preview as `/team <order>|rqid`, never via /choose.
  assert.deepEqual(outgoingBattleEvents("battle-gen9uu-123|/team 321456|1"), [{ kind: "choice", roomId: "battle-gen9uu-123", data: "/team 321456|1" }]);
  assert.deepEqual(outgoingBattleEvents("|/leave battle-gen9uu-123"), [{ kind: "leave", roomId: "battle-gen9uu-123" }]);
  for (const data of ["|/search gen9uu", "lobby|/choose move 1", "battle-gen9uu-123|hi", "|/pm someone, hi", "battle-gen9uu-123|/forfeit"]) assert.deepEqual(outgoingBattleEvents(data), []);
});

// Matters: ready advice belongs to one exact legal-action view, never a newer turn or another room. It is bound to the
// canonical decision identity, not to the deterministic result, so the pick can show before (or without) the damage,
// speed and threat sections (each shows as soon as it is available).
test("Metamon stale-advice suppression checks every identity field and action legality, not the deterministic result", () => {
  const identity = { roomId: "battle-gen9uu-123", rqid: 3, stateRevision: 9, requestKind: "move", snapshotHash: "snapshot", legalActionSetHash: "legal" };
  const snapshot = { legalActions: [{ id: "move:1", disabled: false }] };
  const advice = { status: "ready", identity, resultHash: "pick-input", actionId: "move:1", label: "Scald" };
  assert.equal(currentMetamonAdvice(advice, identity, snapshot), advice, "no envelope is needed");
  for (const key of Object.keys(identity)) assert.equal(currentMetamonAdvice({ ...advice, identity: { ...identity, [key]: "changed" } }, identity, snapshot), null, key);
  assert.equal(currentMetamonAdvice({ ...advice, actionId: "illegal" }, identity, snapshot), null);
  assert.equal(currentMetamonAdvice({ ...advice, actionId: "move:1" }, identity, { legalActions: [{ id: "move:1", disabled: true }] }), null);
  assert.equal(currentMetamonAdvice({ status: "warming", identity }, identity, null)?.status, "warming", "a pending pick needs no snapshot");
  assert.equal(metamonText(advice), "Metamon: Scald");
  assert.equal(metamonText({ status: "unavailable", reason: "sync_lost" }), "Metamon unavailable (sync lost)");
  assert.equal(DEFAULT_SETTINGS.showMetamonAdvice, true);
});

// Matters: reading a recommendation can never execute it. The sole send wrapper forwards a human call once.
test("Metamon extension never sends choices or calls any game action API", async () => {
  const hook = await fs.readFile(new URL("../page-hook.js", import.meta.url), "utf8");
  const sent = [], callbacks = [], messages = [];
  class WebSocket {
    send(data) { sent.push(data); }
    addEventListener() {}
  }
  const window = { WebSocket, crypto: { randomUUID: () => "test" }, postMessage: (m) => messages.push(m),
    setInterval: (fn) => callbacks.push(fn), setTimeout: (fn) => callbacks.push(fn), addEventListener() {} };
  vm.runInNewContext(hook, { window, console, Date });
  const socket = new window.WebSocket("wss://sim3.psim.us/showdown/websocket");
  callbacks.forEach((fn) => fn());
  window.postMessage({ source: "showdnass", metamonAdvice: { actionId: "move:1", label: "Scald", status: "ready" } });
  assert.deepEqual(sent, []);
  socket.send("battle-gen9uu-123|/choose move 1|47");
  assert.deepEqual(sent, ["battle-gen9uu-123|/choose move 1|47"]);
  assert.equal(messages.filter((m) => m.direction === "out").length, 1);
  for (const name of ["background.js", "content-bridge.js", "popup.js", "page-hook.js", "lib/metamon.js"]) {
    const source = await fs.readFile(new URL(`../${name}`, import.meta.url), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    function inspect(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        assert.ok(!["send", "choose", "sendTeam", "makeChoice"].includes(node.expression.name.text), `${name} calls a game send/action method`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
  }
});

// Matters: the default client's SockJS socket bypasses the WebSocket wrapper, so human choices arrive only through
// app.send(data, roomId), which adds the room prefix itself. Live Showdown also suffixes rqids with a hash.
test("Metamon captures legacy app.send(data, room) choices with the room prefix and hashed rqids", async () => {
  const hook = await fs.readFile(new URL("../page-hook.js", import.meta.url), "utf8");
  const calls = [], callbacks = [], messages = [];
  const app = { send(...args) { calls.push(args); }, receive() {} };
  const window = { WebSocket: class {}, app, crypto: { randomUUID: () => "test" }, postMessage: (m) => messages.push(m),
    setInterval: (fn) => callbacks.push(fn), setTimeout: (fn) => callbacks.push(fn), addEventListener() {} };
  vm.runInNewContext(hook, { window, console, Date });
  callbacks.forEach((fn) => fn());
  const room = "battle-gen9uu-123456789";
  window.app.send("/team 123456|3", room);
  window.app.send("/choose move 1|5.87ee3ef5880f6771", room);
  window.app.send("/undo|5.87ee3ef5880f6771", room);
  window.app.send("/search gen9uu");
  assert.deepEqual(calls, [["/team 123456|3", room], ["/choose move 1|5.87ee3ef5880f6771", room], ["/undo|5.87ee3ef5880f6771", room], ["/search gen9uu"]]);
  const events = messages.filter((m) => m.direction === "out").flatMap((m) => outgoingBattleEvents(m.data));
  assert.deepEqual(events, [
    { kind: "choice", roomId: room, data: "/team 123456|3" },
    { kind: "choice", roomId: room, data: "/choose move 1|5.87ee3ef5880f6771" },
    { kind: "choice", roomId: room, data: "/undo|5.87ee3ef5880f6771" }
  ]);
});

// Matters: after a restarted extension worker the background has no history; the page must replay each battle's full
// client log from |init| so damage, speed and Metamon rebuild instead of staying blank for the rest of the game.
test("page hook replays each battle's full log from |init| on a bootstrap request", async () => {
  const hook = await fs.readFile(new URL("../page-hook.js", import.meta.url), "utf8");
  const listeners = [], messages = [];
  const room = { id: "battle-gen9uu-77", battle: { stepQueue: ["|j|☆a", "|start", "|turn|3"] }, request: { rqid: 9, side: { id: "p1" } } };
  const window = { WebSocket: class {}, app: { send() {}, receive() {}, rooms: { [room.id]: room } }, crypto: { randomUUID: () => "t" },
    postMessage: (m) => messages.push(m), setInterval() {}, setTimeout() {}, addEventListener: (type, fn) => listeners.push([type, fn]) };
  vm.runInNewContext(hook, { window, console, Date });
  for (const [type, fn] of listeners) if (type === "message") fn({ source: window, data: { source: "showdnass", kind: "bootstrap-request" } });
  const frames = messages.filter((m) => m.direction === "in" && m.url === "bootstrap");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, `>${room.id}\n|init|battle\n|j|☆a\n|start\n|turn|3\n|request|${JSON.stringify(room.request)}`);
});

// Matters: the player reads the opponent's likely moves/item/Tera from their own games and real ladder play; revealed facts
// must be marked as known, the rest ranked by ladder share with their own counts, and the sources named.
test("likely set shows revealed facts ticked, ladder shares, the owner's counts and sources", async () => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const pick = (name) => { const start = source.indexOf(`  function ${name}(`); return source.slice(start, source.indexOf("\n  }\n", start) + 4); };
  const markup = vm.runInNewContext(`${pick("escapeHtml")}\n${pick("normalizeName")}\n${pick("likelySetMarkup")}\nlikelySetMarkup`, {});
  const entry = { species: "Hydreigon", displayName: "Hydreigon", battlesSeen: 3, revealedMoves: ["Dark Pulse"], revealedItem: null, revealedAbility: "Levitate", revealedTeraType: null,
    metaMovePrior: { source: { period: "2026-09", ratingCutoff: 1500 }, moves: [{ name: "Dark Pulse", setInclusionShare: 0.95 }, { name: "Draco Meteor", setInclusionShare: 0.85 }, { name: "Flash Cannon", setInclusionShare: 0.4 }] },
    likelyMoves: [{ name: "U-turn", count: 2, share: 0.67, sampleCount: 3, confidenceTier: "thin" }],
    likelyItems: [{ name: "Choice Scarf", count: 0, share: 0.39, sampleCount: 900, confidenceTier: "usable", source: "monthly_ladder" }],
    likelyAbilities: [], likelyTeraTypes: [{ name: "Steel", count: 0, share: 0.4, sampleCount: 900, confidenceTier: "usable", source: "monthly_ladder" }] };
  const html = markup({ opponents: [entry] }, { opponentSide: { active: { species: "Hydreigon" } } });
  assert.match(html, /<b>Dark Pulse<\/b> ✓/); assert.ok(!/Dark Pulse 95%/.test(html), "a revealed move is not re-listed as a guess");
  assert.match(html, /Draco Meteor 85% · Flash Cannon 40% · U-turn \(you 2\/3\)/);
  assert.match(html, /Choice Scarf 39%/); assert.match(html, /<b>Levitate<\/b> ✓/); assert.match(html, /Steel 40%/);
  assert.match(html, /ladder: Smogon 2026-09 ≥1500 · your games: 3/);
  assert.equal(markup({ opponents: [] }, { opponentSide: { active: { species: "Hydreigon" } } }), "");
});

// Matters: on Vivaldi the old UI's saved layout (Threat and Line popped out and grouped) kept re-rendering on
// every battle update after the Metamon-only change, with no control left to close it. Saved legacy layout must never
// render, and anything an older version left in the page must go.
test("legacy panel layout never renders from saved state and leftover panels are removed", async () => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const pick = (name) => { const start = source.indexOf(`  function ${name}(`); return source.slice(start, source.indexOf("\n  }\n", start) + 4); };
  const removed = [];
  const element = (id) => ({ id, remove() { removed.push(id); } });
  const present = new Map(["showdnass-opponent-action-panel", "showdnass-group-g1", "showdnass-sidebar"].map((id) => [id, element(id)]));
  const forbidden = () => { throw new Error("legacy panel rendering must not run"); };
  const context = {
    PANEL_DEFS: [{ key: "opponentAction", id: "showdnass-opponent-action-panel" }, { key: "selfAction", id: "showdnass-self-action-panel" }],
    GROUP_DOM_PREFIX: "showdnass-group-", SIDEBAR_ID: "showdnass-sidebar",
    overlaySettings: { panelLayout: "sidebar" },
    getPanelState: () => ({ visible: true, docked: false, group: "g1" }), // the saved Threat + Line pop-out group
    renderPanel: forbidden, ensurePanel: forbidden, renderPanelGroup: forbidden, renderSidebar: forbidden, renderPanels: forbidden,
    acknowledgeRenderedDecision: () => {},
    document: {
      getElementById: (id) => present.get(id) ?? null,
      querySelectorAll: (selector) => [...present.values()].filter((el) => selector.includes("showdnass-group-") && el.id.startsWith("showdnass-group-"))
    }
  };
  const render = vm.runInNewContext(`${pick("renderPanelLayout")}\nrenderPanelLayout`, context);
  render();
  assert.deepEqual(removed.sort(), ["showdnass-group-g1", "showdnass-opponent-action-panel", "showdnass-sidebar"]);
});

// Matters: an immune move's note was the engine's whole sentence ("Resolved Fighting-type attack
// produces zero damage against Ghost-type/Fairy-type typing."), which spilled over the Tera checkbox. A note must be a
// short label that fits one line under the button; damage keeps its range and KO marker.
test("inline damage notes use short outcome labels and keep ranges with KO markers", async () => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const pick = (name) => { const start = source.indexOf(`  function ${name}(`); return source.slice(start, source.indexOf("\n  }\n", start) + 4); };
  const labels = source.slice(source.indexOf("  const OUTCOME_LABELS"), source.indexOf("\n", source.indexOf("  const OUTCOME_LABELS")));
  const rangeText = vm.runInNewContext(`${labels}\n${pick("findLikelyBand")}\n${pick("formatPercentRange")}\n${pick("formatCompactThreatBand")}\n${pick("rangeText")}\nrangeText`, {});
  const band = (b) => [{ likelihood: "likely", probability: 1, ...b }];
  const sentence = "Resolved Fighting-type attack produces zero damage against Ghost-type/Fairy-type typing.";
  assert.equal(rangeText(band({ outcome: "immune", detail: sentence }), 100), "✗ no effect");
  assert.equal(rangeText(band({ outcome: "blocked", detail: "Protect" }), 100), "✗ blocked");
  assert.equal(rangeText(band({ outcome: "status", detail: "non-damaging status move" }), 100), "status");
  assert.match(rangeText(band({ outcome: "damage", minPercent: 74, maxPercent: 87 }), 80), /^74.*87% · may KO$/);
  assert.match(rangeText(band({ outcome: "damage", minPercent: 48, maxPercent: 57 }), 40), /· KO$/);
  assert.doesNotMatch(rangeText(band({ outcome: "damage", minPercent: 20, maxPercent: 25 }), 100), /KO/);
  // Head Smash into an intact Disguise read "74–87% · may KO"; the engine's immediate assessment
  // says the Disguise takes the hit, so the note must say so instead of claiming a KO (Sturdy/Focus Sash likewise).
  const disguise = { ko: "no_ko", minHpLossPercent: 12.5, maxHpLossPercent: 12.5, note: "Intact Disguise absorbs the hit; its form change deals one-eighth max HP, rounded down." };
  assert.match(rangeText(band({ outcome: "damage", minPercent: 74, maxPercent: 87, immediate: disguise }), 56), /^74.*87% · Disguise: no KO$/);
  assert.match(rangeText(band({ outcome: "damage", minPercent: 120, maxPercent: 140, immediate: { ko: "no_ko", note: "Sturdy caps a lethal hit at 1 HP." } }), 100), /· Sturdy: no KO$/);
  assert.match(rangeText(band({ outcome: "damage", minPercent: 74, maxPercent: 87, immediate: { ko: "all_rolls", note: "Disguise chip KO" } }), 10), /· KO$/);
});

// Matters: the re-ranker is an unvalidated experiment. The strip must keep Metamon's raw pick as the headline, add a
// clearly labelled "Re-ranked (experimental)" line only when that pick differs, and show at most three escaped guard
// lines coloured by severity (red = a penalized fact, amber = a warning), so the strip stays compact.
test("Metamon strip labels the experimental re-rank and shows escaped red/amber guards under the pick", async () => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const pick = (name) => { const start = source.indexOf(`  function ${name}(`); return source.slice(start, source.indexOf("\n  }\n", start) + 4); };
  const markup = vm.runInNewContext(`${pick("escapeHtml")}\n${pick("metamonGuardMarkup")}\nmetamonGuardMarkup`, {});
  const guards = [
    { kind: "pre_move_ko", severity: "red", message: "Metagross moves first; its Earthquake KOs <Scizor>" },
    { kind: "choice_lock", severity: "amber", message: "Metagross has used only Earthquake" },
    { kind: "priority_caveat", severity: "amber", message: "Bullet Punch (priority) can KO" },
    { kind: "tera_survival", severity: "amber", message: "a fourth line" }
  ];
  const html = markup({ status: "ready", actionId: "move:1|tera=0", label: "Swords Dance", rerank: { actionId: "move:2|tera=0", label: "Bullet <Punch>" }, guards });
  assert.match(html, /Re-ranked \(experimental\): Bullet &lt;Punch&gt;/);
  assert.equal((html.match(/data-s2o-guard=/g) ?? []).length, 3, "at most three guard lines");
  assert.match(html, /data-s2o-guard="red"[^>]*color:#b42318[^>]*>[^<]*Earthquake KOs &lt;Scizor&gt;/);
  assert.match(html, /data-s2o-guard="amber"[^>]*color:#9a5b00/);
  assert.ok(html.indexOf("Re-ranked") < html.indexOf("data-s2o-guard"), "the re-ranked line comes first, guards below");
  assert.doesNotMatch(markup({ status: "ready", actionId: "a", label: "Scald", guards }), /Re-ranked/, "no re-rank line when the picks agree");
  assert.equal(markup({ status: "ready", actionId: "a", label: "Scald" }), "");
  assert.equal(markup({ status: "warming", rerank: { label: "x" }, guards }), "", "only a ready pick carries guards");
  assert.match(source, /metamonGuardMarkup\(advice\)/, "renderMetamonBox uses it");
});

// Matters: a warning is one short line that never wraps or resizes the controls,
// with the full fact in a tooltip; and a KO'd-first warning on the shown pick is red even as an amber guard, because the
// pick never happens if it is right. The pick itself is untouched.
test("Metamon strip shows each guard's short line, nowrap, with the full message as its tooltip; KO'd-first on the pick is red", async () => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const pick = (name) => { const start = source.indexOf(`  function ${name}(`); return source.slice(start, source.indexOf("\n  }\n", start) + 4); };
  const markup = vm.runInNewContext(`${pick("escapeHtml")}\n${pick("metamonGuardMarkup")}\nmetamonGuardMarkup`, {});
  const guards = [
    { kind: "pre_move_ko", severity: "amber", onPick: true, short: "May be KO'd first by Psychic Noise", message: "Gardevoir moves first (Speed 176–284 vs your 117); its likely Psychic Noise KOs <Fezandipiti>" },
    { kind: "last_answer", severity: "amber", onPick: false, short: "Last fast answer to Serperior", message: "Arcanine-Hisui is your last healthy Pokémon that outspeeds Serperior" },
    { kind: "pre_move_ko", severity: "amber", onPick: false, short: "May be KO'd first by Leaf Storm", message: "on another action" }
  ];
  const html = markup({ status: "ready", actionId: "move:4|tera=0", label: "U-turn (63%)", guards });
  const lines = html.match(/<div data-s2o-guard=[^>]*>[^<]*<\/div>/g);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^<div data-s2o-guard="red" data-s2o-guard-pick title="Gardevoir moves first[^"]*&lt;Fezandipiti&gt;"[^>]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#b42318">⚠ Pick · May be KO&#39;d first by Psychic Noise<\/div>$/);
  assert.match(lines[1], /data-s2o-guard="amber" title="Arcanine-Hisui is your last[^"]*"[^>]*white-space:nowrap[^>]*>⚠ Last fast answer to Serperior</);
  assert.match(lines[2], /data-s2o-guard="amber"/, "KO'd first on another action stays amber");
  assert.ok(lines.every((line) => /white-space:nowrap/.test(line)), "no line wraps");
});

// Matters: the isolated-world bridge must show escaped status and highlight only an exactly bound action.
test("Metamon overlay binds, escapes, highlights and obeys the display toggle", async () => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const names = ["escapeHtml", "decisionKey", "currentMetamonAdvice", "renderMetamonAdvice"];
  const functions = names.map((name) => {
    const start = source.indexOf(`  function ${name}(`);
    let end = source.indexOf("\n  function ", start + 1);
    if (name === "decisionKey") end = source.indexOf("\n  window.addEventListener", start);
    return source.slice(start, end);
  });
  const identity = { roomId: "battle-gen9uu-1", rqid: 2, snapshotHash: "a", legalActionSetHash: "b", stateRevision: 3, requestKind: "move" };
  // No deterministic envelope yet: the pick shows from the decision's own snapshot.
  const context = { overlaySettings: {}, latestLocalIntelPayload: { envelope: null, decisionIdentity: identity, snapshot: { legalActions: [{ id: "m" }] },
    metamonAdvice: { status: "ready", identity, actionId: "m", label: "<Scald>", latencyMs: 20 } } };
  const render = vm.runInNewContext(functions.join("\n") + "\nrenderMetamonAdvice", context);
  assert.match(render(), /Metamon: &lt;Scald&gt;/); assert.match(render(), /ready.*20 ms/);
  context.overlaySettings.showMetamonAdvice = false; assert.equal(render(), "");
  context.overlaySettings.showMetamonAdvice = true;
  context.latestLocalIntelPayload.metamonAdvice.actionId = "gone"; assert.equal(render(), "", "a pick that is not a legal action is hidden");
  context.latestLocalIntelPayload.metamonAdvice.actionId = "m";
  context.latestLocalIntelPayload.decisionIdentity = { ...identity, roomId: "battle-gen9uu-other" }; assert.equal(render(), "", "another room's pick is hidden");
  assert.match(source, /data-metamon-match=.*currentMetamonAdvice/);
});

// Matters: the real background queue must preserve capture/choose/undo order and flush choices without a new incoming frame.
test("Metamon background forwards ordered human choices and closes a removed tab", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, requests = [], timers = new Map();
  let timerId = 0;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"),
      query: async () => [], sendMessage: async () => ({ ok: true }) },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    assert.ok(!url.includes("/api/analyze"), "Metamon + checks never uses an LLM endpoint");
    return { ok: true, json: async () => ({ ok: true, historyRevision: "history", results: (body.observations ?? []).map((o) => ({
      observationId: o.observationId, acknowledgedSequence: o.sequence, identity: null,
      room: { roomId: o.roomId, updatedAt: Date.now(), sides: {}, legalActions: [] }
    })) }) };
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?metamon=${Date.now()}`);
  const dispatch = (data, direction = "out") => new Promise((resolve) => listeners.message({ type: "showdown-frame", payload: { data, direction, observationId: "observed-1" } }, { tab: { id: 7 } }, resolve));
  const room = "battle-gen9uu-ordered";
  await dispatch(`>${room}\n|init|battle`, "in");
  await dispatch(`${room}|/choose move 1|2`);
  await dispatch(`${room}|/undo|2`);
  await dispatch(`${room}|/choose move 2 terastallize|2`);
  await dispatch("lobby|/choose move 1");
  const eventually = async (condition) => {
    for (let i = 0; i < 200; i++) { if (condition()) return; await setImmediate(); }
    assert.fail("background did not drain the ordered Metamon queue");
  };
  const events = () => requests.flatMap((r) => r.body.metamonEvents ?? []);
  await eventually(() => events().length === 4);
  assert.deepEqual(events().map((e) => e.kind), ["observation", "choice", "choice", "choice"]);
  assert.deepEqual(events().map((e) => e.sequence), [1, 2, 3, 4]);
  assert.deepEqual(events().slice(1).map((e) => e.data), ["/choose move 1|2", "/undo|2", "/choose move 2 terastallize|2"]);
  listeners.removed(7);
  await eventually(() => events().some((e) => e.kind === "leave"));
  assert.equal(events().at(-1).roomId, room);
});
// Matters: on Vivaldi every tab update for a closed or panel tab threw "No tab with id" from the toolbar
// refresh, filling the extension's error page. Toolbar state is best effort and must never reject.
test("toolbar refresh for a vanished or unaddressable tab never leaves an unhandled rejection", async (t) => {
  const original = { chrome: globalThis.chrome, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const listeners = {}, unhandled = [];
  // The background's own polls and keepalives must not hold the test process open.
  globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {}; globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  const onUnhandled = (reason) => unhandled.push(String(reason));
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { process.off("unhandledRejection", onUnhandled); Object.assign(globalThis, original); });
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const gone = async (tabId) => { throw new Error(`No tab with id: ${tabId}.`); };
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"),
      query: async () => [{ id: 1977704490, url: "chrome://newtab/" }, { id: 7, url: "https://play.pokemonshowdown.com/" }],
      get: async (tabId) => ({ id: tabId, url: "https://play.pokemonshowdown.com/" }), sendMessage: async () => ({ ok: true }) },
    action: { enable: gone, disable: gone }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  await import(`../background.js?toolbar=${Date.now()}`);
  listeners.updated(1977704490, { status: "complete" }, { id: 1977704490, url: "chrome://newtab/" });
  listeners.updated(7, { url: "https://play.pokemonshowdown.com/" }, { id: 7, url: "https://play.pokemonshowdown.com/" });
  listeners.startup();
  await listeners.activated({ tabId: 7 });
  for (let i = 0; i < 20; i++) await setImmediate();
  assert.deepEqual(unhandled, []);
});

// Matters: a restarted extension worker sees a battle mid-stream. Forwarding a fragment without |init| cannot build state
// (no damage or speed for the rest of the battle); it must ask the page to replay the full log.
test("background drops a battle fragment without |init| and asks the page for a full replay", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, requests = [], timers = new Map();
  let timerId = 0;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"),
      query: async () => [], sendMessage: async () => ({ ok: true }) },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    assert.ok(!url.includes("/api/analyze"), "Metamon + checks never uses an LLM endpoint");
    return { ok: true, json: async () => ({ ok: true, historyRevision: "history", results: (body.observations ?? []).map((o) => ({
      observationId: o.observationId, acknowledgedSequence: o.sequence, identity: null,
      room: { roomId: o.roomId, updatedAt: Date.now(), sides: {}, legalActions: [] }
    })) }) };
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?metamon=${Date.now()}`);
  const sent = [];
  globalThis.chrome.tabs.sendMessage = async (tabId, message) => { sent.push([tabId, message.type]); return { ok: true }; };
  const dispatch = (data, id) => new Promise((resolve) => listeners.message({ type: "showdown-frame", payload: { data, direction: "in", observationId: id } }, { tab: { id: 8 } }, resolve));
  const room = "battle-gen9uu-midstream";
  await dispatch(`>${room}\n|move|p1a: Scizor|Knock Off|p2a: Rotom\n|turn|5`, "mid-1");
  for (let i = 0; i < 50; i++) await setImmediate();
  assert.deepEqual(sent.filter(([, type]) => type === "bootstrap"), [[8, "bootstrap"]]);
  assert.equal(requests.flatMap((r) => r.body.observations ?? []).length, 0, "the fragment is never forwarded");
  await dispatch(`>${room}\n|init|battle\n|j|☆a\n|turn|5`, "boot-1");
  for (let i = 0; i < 200 && !requests.some((r) => (r.body.observations ?? []).length); i++) await setImmediate();
  assert.match(requests.flatMap((r) => r.body.observations ?? [])[0].data, /^>battle-gen9uu-midstream\n\|init\|battle/);
});


// Matters: Showdown changes its URL with history.pushState on every battle start and room switch, and Chrome reports
// that as tab status "loading". Resetting the tab there dropped the new battle's |init| mid-flush and sent "leave" for
// every open battle: a new game never reached the companion (zero observations at team preview).
// In-app navigation must keep the capture; only a new page (a new page-hook captureId) or leaving Showdown resets it.
test("background keeps a tab's capture across in-app navigation and resets only for a new page", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, requests = [], timers = new Map();
  let timerId = 0;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"),
      query: async () => [], sendMessage: async () => ({ ok: true }) },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    return { ok: true, json: async () => ({ ok: true, historyRevision: "history", results: (body.observations ?? []).map((o) => ({
      observationId: o.observationId, acknowledgedSequence: o.sequence, identity: null,
      room: { roomId: o.roomId, updatedAt: Date.now(), sides: {}, legalActions: [] }
    })) }) };
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?navigation=${Date.now()}`);
  const dispatch = (data, captureId, n) => new Promise((resolve) => listeners.message({ type: "showdown-frame",
    payload: { data, direction: "in", captureId, observationId: `${captureId}:${n}` } }, { tab: { id: 9 } }, resolve));
  const settle = async () => { for (let i = 0; i < 200; i++) await setImmediate(); };
  const room = "battle-gen9uu-pushstate";
  // The |init| lands, then the client pushes /battle-… before the flush runs (getSettings is async).
  await dispatch(`>${room}\n|init|battle\n|j|☆a`, "page-1", 1);
  listeners.updated(9, { status: "loading", url: `https://play.pokemonshowdown.com/${room}` }, { id: 9, url: `https://play.pokemonshowdown.com/${room}` });
  await dispatch(`>${room}\n|request|{"rqid":1,"teamPreview":true}`, "page-1", 2);
  await settle();
  const observations = () => requests.flatMap((r) => r.body.observations ?? []);
  const events = () => requests.flatMap((r) => r.body.metamonEvents ?? []);
  assert.equal(observations().length, 2, "both frames reach the companion");
  assert.match(observations()[0].data, /\|init\|battle/);
  assert.equal(new Set(observations().map((o) => o.sessionId)).size, 1, "one capture session across the pushState");
  assert.equal(events().filter((e) => e.kind === "leave").length, 0, "in-app navigation never ends a battle");
  // A reload is a new page hook: the old capture ends its rooms and the new page gets a new session.
  await dispatch(`>${room}\n|init|battle\n|j|☆a`, "page-2", 1);
  await settle();
  assert.deepEqual(events().filter((e) => e.kind === "leave").map((e) => [e.roomId, e.sessionId]), [[room, observations()[0].sessionId]]);
  assert.notEqual(observations().at(-1).sessionId, observations()[0].sessionId);
  // Leaving Showdown ends the page's battles too.
  listeners.updated(9, { status: "loading", url: "https://example.com/" }, { id: 9, url: "https://example.com/" });
  await settle();
  assert.equal(events().filter((e) => e.kind === "leave").length, 2);
});

// Matters: a bootstrap replays a battle from |init|, which restarts that room's advisor (it resyncs). Replaying every
// open battle when one needed it restarted healthy advisors in the same tab (two battles, or an old one left open).
test("page hook replays only the requested battle on a per-room bootstrap request", async () => {
  const hook = await fs.readFile(new URL("../page-hook.js", import.meta.url), "utf8");
  const listeners = [], messages = [];
  const rooms = Object.fromEntries(["battle-gen9uu-1", "battle-gen9uu-2"].map((id) => [id, { id, battle: { stepQueue: ["|j|☆a", "|turn|3"] }, request: null }]));
  const window = { WebSocket: class {}, app: { send() {}, receive() {}, rooms }, crypto: { randomUUID: () => "t" },
    postMessage: (m) => messages.push(m), setInterval() {}, setTimeout() {}, addEventListener: (type, fn) => listeners.push([type, fn]) };
  vm.runInNewContext(hook, { window, console, Date });
  for (const [type, fn] of listeners) if (type === "message") fn({ source: window, data: { source: "showdnass", kind: "bootstrap-request", roomId: "battle-gen9uu-2" } });
  assert.deepEqual(messages.filter((m) => m.url === "bootstrap").map((m) => m.data.split("\n")[0]), [">battle-gen9uu-2"]);
});

const bridgeFunctions = async (names) => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const pick = (name) => { const start = source.indexOf(`  function ${name}(`); assert.ok(start >= 0, `${name} exists`); return source.slice(start, source.indexOf("\n  }\n", start) + 4); };
  return { source, code: names.map(pick).join("\n") };
};

// Matters: a 96% "Tera + Slack Off" pick was once played without Tera: only the move was outlined. A Tera
// pick must mark Showdown's own Terastallize checkbox too, with words, and a plain pick must leave it unmarked.
test("a Tera pick marks the Terastallize checkbox with a textual cue; a plain pick clears it", async () => {
  const { source, code } = await bridgeFunctions(["pickMarks", "markPick", "markTeraBox"]);
  const element = () => ({ style: {}, dataset: {}, children: [], textContent: "",
    append(child) { this.children.push(child); }, querySelector(sel) { return this.children.find((c) => sel === `[data-s2o=${c.dataset.s2o}]`) ?? null; } });
  const label = element();
  const controls = { querySelector: (sel) => sel === "input[name=terastallize]" ? { closest: (s) => s === "label" ? label : null } : null };
  const context = { document: { createElement: element } };
  const { pickMarks, markTeraBox } = vm.runInNewContext(`${code}\n({ pickMarks, markTeraBox })`, context);
  const snapshot = { legalActions: [
    { id: "move:2|tera=0", kind: "move", moveSlot: 2, terastallize: false },
    { id: "move:2|tera=1", kind: "move", moveSlot: 2, terastallize: true },
    { id: "switch:3", kind: "switch", targetSlot: 3 }, { id: "team:1", kind: "team", teamSpec: [4, 1, 2, 3, 5, 6] }] };
  const tera = pickMarks(snapshot, { status: "ready", actionId: "move:2|tera=1" });
  assert.deepEqual({ ...tera }, { moveSlot: 2, tera: true, switchSlot: null, leadSlot: null });
  markTeraBox(controls, tera.tera);
  assert.equal(label.dataset.s2oPick, "1"); assert.match(label.style.outline, /solid/);
  assert.equal(label.children[0].textContent, "★ Metamon: Terastallize");
  const plain = pickMarks(snapshot, { status: "ready", actionId: "move:2|tera=0" });
  assert.equal(plain.tera, false); assert.equal(plain.moveSlot, 2);
  markTeraBox(controls, plain.tera);
  assert.equal(label.dataset.s2oPick, undefined); assert.equal(label.style.outline, ""); assert.equal(label.children[0].textContent, "");
  assert.equal(pickMarks(snapshot, { status: "ready", actionId: "switch:3" }).switchSlot, 3);
  assert.equal(pickMarks(snapshot, { status: "ready", actionId: "team:1" }).leadSlot, 4);
  assert.equal(pickMarks(snapshot, { status: "warming", actionId: "move:2|tera=1" }).tera, false, "only a ready pick marks");
  assert.match(source, /markTeraBox\(controls, marks\.tera\)/, "renderMetamonBox marks the checkbox");
});

// Matters: switch-button species came from button.textContent, which includes our own appended note (and Showdown shows
// nicknames), so "Arcanine" + note stopped matching "Arcanine-Hisui" and the note blanked every other render. The
// species comes from the request's party slot (Showdown's button value + 1), never from the button's text.
test("switch buttons resolve species from the request party slot, not the button text", async () => {
  const { source, code } = await bridgeFunctions(["partySpecies"]);
  const partySpecies = vm.runInNewContext(`${code}\npartySpecies`, {});
  const snapshot = { legalActions: [{ id: "switch:3", kind: "switch", targetSlot: 3, target: "p1: Arcanine" }, { id: "switch:4", kind: "switch", targetSlot: 4, target: "p1: Fluffy" }],
    yourSide: { team: [{ ident: "p1: Scizor", species: "Scizor" }, { ident: "p1: Arcanine", species: "Arcanine-Hisui" }, { ident: "p1: Fluffy", species: "Slowking-Galar" }] } };
  assert.equal(partySpecies(snapshot, 3), "Arcanine-Hisui");
  assert.equal(partySpecies(snapshot, 4), "Slowking-Galar", "a nickname resolves to its species");
  assert.equal(partySpecies(snapshot, 2), null, "no legal switch, no species");
  const loop = source.slice(source.indexOf('querySelectorAll("button[name=chooseSwitch]")'), source.indexOf('querySelectorAll("button[name=chooseTeamPreview]")'));
  assert.doesNotMatch(loop, /textContent/, "the switch loop never reads button text");
  assert.match(loop, /partySpecies\(snapshot, slot\)/);
});

// Matters: a broken client could only be diagnosed from the player's devtools. Each page ping makes the worker report
// its per-tab capture state (session, rooms with |init|, errors, queue sizes, advice state) to the companion.
test("background reports per-tab capture state to the companion on the page's ping", async (t) => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const listeners = {}, requests = [];
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  globalThis.chrome = {
    runtime: { id: "ext", getManifest: () => ({ version: "0.1.0" }), onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    commands: { onCommand: event("command") },
    tabs: { onRemoved: event("removed"), onActivated: event("activated"), onUpdated: event("updated"), query: async () => [], sendMessage: async () => ({ ok: true }) },
    action: { enable: async () => {}, disable: async () => {} }, scripting: { executeScript: async () => {} },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } }
  };
  globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {};
  globalThis.fetch = async (url, options) => { const body = JSON.parse(options.body); requests.push({ url, body });
    return { ok: true, json: async () => ({ ok: true, historyRevision: "h", results: (body.observations ?? []).map((o) => ({ observationId: o.observationId, acknowledgedSequence: o.sequence, identity: null, room: { roomId: o.roomId, updatedAt: Date.now(), sides: {}, legalActions: [] } })) }) }; };
  t.after(() => Object.assign(globalThis, original));
  await import(`../background.js?report=${Date.now()}`);
  await new Promise((resolve) => listeners.message({ type: "showdown-frame", payload: { data: ">battle-gen9uu-rep\n|init|battle", direction: "in", captureId: "page", observationId: "page:1" } }, { tab: { id: 4 } }, resolve));
  await new Promise((resolve) => listeners.message({ type: "ping", bridge: "bridge-x" }, { tab: { id: 4 } }, resolve));
  for (let i = 0; i < 200 && !requests.some((r) => r.url.endsWith("/v1/client/status")); i++) await setImmediate();
  const report = requests.find((r) => r.url.endsWith("/v1/client/status"))?.body;
  assert.ok(report, "a status report is sent");
  assert.equal(report.tabs[0].pageCaptureId, "page"); assert.equal(report.tabs[0].bridgeVersion, "bridge-x");
  assert.deepEqual(report.tabs[0].initRooms, ["battle-gen9uu-rep"]); assert.ok(report.workerStartedAt > 0);
});

// Matters: the UU lead model imitates rated human leads; the picked lead button must say "usual" with its share and never
// read as best or as a win estimate, and a random draw must still say so (a review finding). One short line:
// the explanation lives in the tooltip.
test("lead button note says usual lead with its share, or random draw, in one short line", async () => {
  const source = await fs.readFile(new URL("../content-bridge.js", import.meta.url), "utf8");
  const pick = (name) => { const start = source.indexOf(`  function ${name}(`); return source.slice(start, source.indexOf("\n  }\n", start) + 4); };
  const leadNote = vm.runInNewContext(`${pick("leadNote")}\nleadNote`, {});
  const usual = leadNote({ basis: "lead_model", probability: 0.412 });
  assert.equal(usual.text, "usual lead 41%"); assert.match(usual.detail, /not a win estimate/); assert.doesNotMatch(usual.text + usual.detail, /best/i);
  assert.equal(leadNote({ basis: "random_preview", probability: null }).text, "random draw");
  assert.equal(leadNote(null).text, "lead");
  for (const note of [usual, leadNote({ basis: "random_preview" })]) assert.ok(note.text.length <= 16, note.text);
});

// Matters: against a possible Zoroark-Hisui the strip showed only the pick and "Speed: not enough
// information yet" all game, without saying why. A possible Illusion now gets one short line naming the
// possible Illusion user and the shown species the numbers assume, plus the Illusion user's own speed when known; any
// other withheld state says in words why the engine paused.
test("the strip names a possible Illusion in one line and says why sections are paused", async () => {
  const { source, code } = await bridgeFunctions(["escapeHtml", "illusionLine", "pausedReason"]);
  const start = source.indexOf("  const PAUSED = ");
  const { illusionLine, pausedReason } = vm.runInNewContext(`${source.slice(start, source.indexOf("};\n", start) + 3)}\n${code}\n({ illusionLine, pausedReason })`, {});
  const intel = { opponents: [{}], illusion: { shown: "Volcanion", possible: ["Zoroark-Hisui"] },
    illusionAlternative: { species: "Zoroark-Hisui", speedPreview: { yourActiveEffectiveSpeed: 353, effectiveRange: { min: 230, max: 350 }, activeRelation: "faster",
      verdict: { text: "You move first (you 353 vs 230-350)", tone: "faster" } } } };
  const line = illusionLine(intel, { opponentSide: { active: { item: "Leftovers" } } });
  assert.match(line, /⚠ Possible Illusion \(Zoroark-Hisui\): numbers assume Volcanion · if Zoroark-Hisui: you move first \(you 353 vs 230-350\)/);
  assert.match(line, /white-space:nowrap;overflow:hidden;text-overflow:ellipsis/, "one line, never wraps");
  assert.match(illusionLine({ opponents: [{}], illusion: intel.illusion }), /numbers assume Volcanion<\/div>$/, "no alternative yet: the caveat alone");
  assert.equal(illusionLine({ opponents: [] }), "", "no caveat once revealed or ruled out");
  const unsupported = { capabilities: { status: "unsupported", limitations: ["identity_ambiguous", "heuristic_ranking"] } };
  assert.equal(pausedReason(unsupported, { opponents: [] }), "Engine paused: an opposing Pokémon's identity is uncertain");
  assert.equal(pausedReason(unsupported, intel), null, "a possible Illusion shows its sections, not a pause");
  assert.equal(pausedReason({ capabilities: { status: "degraded", limitations: [] } }, { opponents: [] }), null);
  assert.match(source, /pausedReason\(semantic, intel\) \?\? "Speed: not enough information yet"/);
  assert.match(source, /!intel \|\| pendingSections\.has\("speed"\) \? "Speed: calculating…"/);
  assert.match(source, /\+ illusionLine\(intel, /);
});

// Matters: latency is measured in real games, not only in e2e. The page notes when it saw each request
// and when each section first painted for it, and reports the record once (when the room's next request or its end
// arrives). A replayed old request (battle bootstrap) starts no new record.
test("the page records per-request first-paint times and reports each record once", async () => {
  const { source, code } = await bridgeFunctions(["noteRequestSeen", "recordPaint", "reportTimings"]);
  const declaration = "  const decisionTimings = new Map(), latestTimedRqid = new Map();";
  assert.ok(source.includes(declaration));
  const sent = []; let now = 1000;
  const { noteRequestSeen, recordPaint } = vm.runInNewContext(`${declaration}\n${code}\n({ noteRequestSeen, recordPaint })`,
    { Date: { now: () => now }, safeSendRuntimeMessage: (message) => sent.push(message) });
  const room = "battle-gen9uu-9", identity = { roomId: room, rqid: 4 };
  noteRequestSeen(`>${room}\n|request|${JSON.stringify({ rqid: 4, active: [{}] })}`);
  now = 1150; recordPaint(identity, new Set(["damage", "threats"]), { status: "warming" });
  now = 1300; recordPaint(identity, new Set(["threats"]), { status: "ready", guardsPending: true });
  now = 1400; recordPaint(identity, new Set(), { status: "ready" });
  now = 1500; recordPaint(identity, new Set(), { status: "ready" });
  noteRequestSeen(`>${room}\n|request|${JSON.stringify({ rqid: 4, active: [{}] })}`);
  assert.equal(sent.length, 0, "nothing is reported before the decision is over; a replayed request is not new");
  noteRequestSeen(`>${room}\n|request|${JSON.stringify({ rqid: 6, side: {}, forceSwitch: [true] })}`);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: "decision-timing", payload: { roomId: room, rqid: 4, kind: "move",
    sections: { speed: 150, sets: 150, damage: 300, pick: 300, threats: 400, warnings: 400 } } }]);
  noteRequestSeen(`>${room}\n|win|B`);
  assert.equal(sent.length, 1, "a request that painted nothing reports nothing");
  assert.match(source, /recordPaint\(identity, pendingSections, advice\);/, "renderMetamonBox records what it painted");
});

// Matters: hovering over a move shows how much it does to each Pokémon on the other side. The move's tooltip lists the engine's band against every opposing Pokémon (the active marked "in", a Tera named,
// KO read at that Pokémon's HP; one not yet in battle is at full HP); the button's own note stays one short line.
test("a move's tooltip lists its damage against each opposing Pokémon", async () => {
  const { source, code } = await bridgeFunctions(["findLikelyBand", "formatPercentRange", "formatCompactThreatBand", "rangeText", "moveTargetRows", "moveTargetLines"]);
  const labels = source.slice(source.indexOf("  const OUTCOME_LABELS = "), source.indexOf("};\n", source.indexOf("  const OUTCOME_LABELS = ")) + 3);
  const run = vm.runInNewContext(`${labels}\n${code}\nmoveTargetLines`, {}), lines = (...args) => [...run(...args)];
  const band = (min, max, outcome) => ({ label: "likely", minPercent: min, maxPercent: max, immediate: {}, ...(outcome ? { outcome } : {}) });
  const preview = [{ actionId: "move:1|tera=0", moveName: "Earthquake", targets: [
    { species: "Mienshao", active: true, hpPercent: 40, band: band(45, 53) },
    { species: "Thundurus-Therian", active: false, hpPercent: 100, band: band(null, null, "immune") },
    { species: "Gastrodon", active: false, hpPercent: null, teraType: "Water", band: band(20, 24) }] }];
  assert.deepEqual(lines(preview, "move:1|tera=0"), ["Earthquake vs their team:", "• Mienshao (in, 40%): 45-53% · KO",
    "• Thundurus-Therian (100%): ✗ no effect", "• Gastrodon (Tera Water, 100%): 20-24%"]);
  assert.deepEqual(lines(preview, "move:2|tera=0"), []);
  assert.deepEqual(lines(undefined, "move:1|tera=0"), []);
  assert.match(source, /moveTargetLines\(intel\?\.moveTargetPreview, `move:\$\{slot\}\|tera=0`\)/, "each move button's note carries its lines");
});

// Matters: hover damage must actually show: the lines lived only in the note's native title, which appears
// after ~1 s over a 14 px line while Showdown's own move tooltip opens on the button. They must show in Showdown's tooltip
// for the hovered move button, follow a new stage without duplicating (or looping on our own mutation), show nothing for
// a button without our note (advisor off, another room), and keep the taller tooltip on screen and off the button.
test("hovering a move button appends its per-opponent lines to Showdown's move tooltip", async () => {
  const { source, code } = await bridgeFunctions(["escapeHtml", "findLikelyBand", "formatPercentRange", "formatCompactThreatBand", "rangeText",
    "moveTargetRows", "moveTipMarkup", "moveTooltips"]);
  const labels = source.slice(source.indexOf("  const OUTCOME_LABELS = "), source.indexOf("};\n", source.indexOf("  const OUTCOME_LABELS = ")) + 3);
  const { moveTipMarkup, moveTooltips } = vm.runInNewContext(`${labels}\n${code}\n({ moveTipMarkup, moveTooltips })`, {});
  // Showdown's tooltip is bottom-anchored at #tooltipwrapper's top: it grows upward, 20 px per line of ours.
  let open = true, inserts = 0;
  const wrapper = { style: { top: "300px" }, querySelector: (sel) => sel === ".tooltip-move" && open ? tooltip : null };
  const tooltip = { sections: [], closest: (sel) => sel === "#tooltipwrapper" ? wrapper : null,
    querySelector(sel) { return sel === "[data-s2o-tip]" ? this.sections[0] ?? null : null; },
    insertAdjacentHTML(where, html) { assert.equal(where, "beforeend"); inserts++; const s = { html, remove: () => this.sections.splice(this.sections.indexOf(s), 1) }; this.sections.push(s); },
    getBoundingClientRect() { const lines = this.sections.reduce((n, s) => n + 1 + (s.html.match(/data-s2o-tip-row/g) ?? []).length, 0); return { top: parseFloat(wrapper.style.top) - 120 - 20 * lines }; } };
  const doc = { getElementById: (id) => id === "tooltipwrapper" ? wrapper : null };
  const button = (tip, { note = true, bottom = 400 } = {}) => ({ isConnected: true, dataset: { tooltip: tip }, closest(sel) { return sel === ".has-tooltip" ? this : null; },
    querySelector: (sel) => sel === "[data-s2o=note]" && note ? {} : null, getBoundingClientRect: () => ({ bottom }) });
  const band = (min, max, outcome) => ({ label: "likely", minPercent: min, maxPercent: max, immediate: {}, ...(outcome ? { outcome } : {}) });
  const preview = [{ actionId: "move:1|tera=0", moveName: "Earthquake", targets: [
    { species: "Mienshao", active: true, hpPercent: 40, band: band(45, 53) },
    { species: "Thundurus-Therian", active: false, hpPercent: 100, band: band(null, null, "immune") },
    { species: "Gastrodon<b>", active: false, hpPercent: null, teraType: "Water", band: band(20, 24) }] }];
  const tips = moveTooltips(doc), quake = button("move|Earthquake|0");
  const shown = () => tooltip.sections.map((s) => s.html);

  // Damage computed, analysis still running: the hovered button's tooltip says so.
  tips.set(quake, moveTipMarkup(undefined, "move:1|tera=0", true, false));
  tips.hover({ target: quake }); tips.augment();
  assert.equal(shown().length, 1); assert.match(shown()[0], /^<p class="tooltip-section" data-s2o-tip><strong>vs their team<\/strong>: <small>calculating…<\/small><\/p>$/);
  // The final stage arrives while the tooltip is open: the section is replaced, never stacked.
  tips.set(quake, moveTipMarkup(preview, "move:1|tera=0", false, false)); tips.augment();
  assert.equal(shown().length, 1);
  const rows = shown()[0].match(/<span data-s2o-tip-row[^>]*>.*?<\/span>(?=<span|<\/p>)/g);
  assert.deepEqual(rows.map((r) => r.replace(/<[^>]+>/g, "")), ["Mienshao (in): 45-53% · KO · 40% HP",
    "Thundurus-Therian: ✗ no effect · 100% HP", "Gastrodon&lt;b&gt; Tera Water: 20-24% · 100% HP"]);
  assert.match(rows[0], /color:#b42318">45-53% · KO</, "a KO is red"); assert.match(rows[2], /color:inherit/);
  assert.equal(wrapper.style.top, "300px", "room above the button: Showdown's placement stands");
  // Our own insert fires the document observer again: same tooltip and markup, nothing changes.
  const before = inserts; tips.augment(); tips.augment(); assert.equal(inserts, before);
  // A stale analysis (an earlier view of this decision) is dimmed and labelled.
  tips.set(quake, moveTipMarkup(preview, "move:1|tera=0", false, true)); tips.augment();
  assert.match(shown()[0], /^<p class="tooltip-section" data-s2o-tip style="opacity:.6"><strong>vs their team<\/strong> <small>updating…<\/small>/);
  assert.match(moveTipMarkup([], "move:1|tera=0", false, false), /no damage data for this move/);
  assert.match(moveTipMarkup([{ actionId: "move:1|tera=0", moveName: "Earthquake", targets: [] }], "move:1|tera=0", false, false), /no opposing Pokémon seen yet/);

  // A move button without our note (advisor off or another room's controls) gets nothing; Showdown's tooltip is untouched.
  const bare = button("move|Earthquake|0", { note: false }); tips.set(bare, shown()[0]);
  tips.hover({ target: bare }); tips.augment(); assert.equal(shown().length, 0);
  // Pointer back on our button, Showdown redraws its tooltip (a new element each time): the section is added again.
  tips.hover({ target: quake }); tooltip.sections = []; open = false; tips.augment(); open = true; tips.augment(); assert.equal(shown().length, 1);

  // Near the top of the window the taller tooltip is moved down to stay on screen.
  wrapper.style.top = "150px"; tooltip.sections = []; open = false; tips.augment(); open = true;
  tips.set(quake, moveTipMarkup(preview, "move:1|tera=0", false, false)); tips.augment();
  assert.equal(wrapper.style.top, "201px", "top 150 - 120 - 4×20 = -50: moved down 51 px to 1");
  // Showdown put it below the button: it keeps its top, so the extra lines never cover the button.
  const low = button("move|Earthquake|0", { bottom: 100 }); tips.set(low, moveTipMarkup(preview, "move:1|tera=0", false, false));
  wrapper.style.top = "300px"; tooltip.sections = []; open = false; tips.augment(); open = true; tips.hover({ target: low }); tips.augment();
  assert.equal(wrapper.style.top, "380px");

  // Wiring: every move button gets its markup, each render and every DOM mutation re-check the open tooltip, and the
  // hovered element is tracked from the same events Showdown uses.
  assert.match(source, /moveTips\.set\(button, moveTipMarkup\(intel\?\.moveTargetPreview, `move:\$\{slot\}\|tera=0`, !intel \|\| pendingSections\.has\("analysis"\), staleSections\.has\("analysis"\)\)\)/);
  assert.match(source, /const annotator = new MutationObserver\(\(\) => \{\n    if \(retired\) return;\n    moveTips\.augment\(\);/);
  assert.match(source, /document\.addEventListener\("mouseover", moveTips\.hover, true\);\n  document\.addEventListener\("focusin", moveTips\.hover, true\);/);
});

// Matters: the player may switch instead of the pick; the strip names Metamon's best switch in one short
// line, its own warnings (it may be taken) in the tooltip, and its button gets a subtle dashed outline, never the pick's.
test("the strip names Metamon's best alternative in one line with its warnings, and marks its button subtly", async () => {
  const { source, code } = await bridgeFunctions(["escapeHtml", "alternativeLine", "markAlternative"]);
  const { alternativeLine, markAlternative } = vm.runInNewContext(`${code}\n({ alternativeLine, markAlternative })`, {});
  const advice = { status: "ready", alternative: { kind: "switch", actionId: "switch:2", label: "If switching: Donphan (10%)", probability: 0.1,
    guards: [{ kind: "switch_into_ko", severity: "red", short: "Donphan is KO'd on entry", message: "Donphan is KO'd on entry by every likely reply (Surf).", onPick: true }] } };
  const line = alternativeLine(advice);
  assert.match(line, /^<div data-s2o-alt title="If switching: Donphan \(10%\)\. Warning: Donphan is KO&#39;d on entry by every likely reply \(Surf\)\."/);
  assert.match(line, /↳ If switching: Donphan \(10%\) <span[^>]*>⚠ Donphan is KO&#39;d on entry<\/span><\/div>$/);
  assert.match(line, /white-space:nowrap;overflow:hidden;text-overflow:ellipsis/, "one line, never wraps");
  assert.equal(alternativeLine({ status: "warming", alternative: advice.alternative }), "");
  assert.match(alternativeLine({ status: "ready", alternative: { ...advice.alternative, guards: undefined } }), /no warnings for it/);
  const button = { style: {}, dataset: {} }, picked = { style: { outline: "3px solid #2f80ed" }, dataset: { s2oPick: "1" } };
  markAlternative(button, true); markAlternative(picked, true);
  assert.match(button.style.outline, /dashed/); assert.equal(button.dataset.s2oAlt, "1");
  assert.equal(picked.style.outline, "3px solid #2f80ed", "the pick keeps its own mark"); assert.equal(picked.dataset.s2oAlt, undefined);
  assert.match(source, /\+ alternativeLine\(advice\)/);
  assert.match(source, /markAlternative\(button, altMarks\.moveSlot === slot\)/); assert.match(source, /markAlternative\(button, altMarks\.switchSlot === slot\)/);
});
