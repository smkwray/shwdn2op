import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { applyRawFrameToRoomMap, roomToSnapshot } from "./showdown-parser.js";
import { buildTabSelection } from "./tab-state.js";

const hookSource = await fs.readFile(new URL("../page-hook.js", import.meta.url), "utf8");
const roomId = "battle-gen9uu-contract";
const side = {
  id: "p1", name: "You", pokemon: [
    { ident: "p1: Mamoswine", details: "Mamoswine, L100", condition: "341/341", active: true,
      stats: { atk: 359, def: 196, spa: 158, spd: 157, spe: 284 },
      moves: ["earthquake", "iceshard"], ability: "Thick Fat", item: "Heavy-Duty Boots", teraType: "Ice" },
    { ident: "p1: Slowking", details: "Slowking, L100", condition: "394/394", active: false,
      moves: ["scald"], ability: "Regenerator", item: "Heavy-Duty Boots", teraType: "Fairy" }
  ]
};
const active = { moves: [
  { move: "Earthquake", id: "earthquake", pp: 16, target: "allAdjacent" },
  { move: "Ice Shard", id: "iceshard", pp: 48, target: "normal" }
] };
const protocol = [
  "|init|battle", "|tier|[Gen 9] UU", "|gametype|singles", "|player|p1|You", "|player|p2|Them",
  "|poke|p1|Mamoswine, L100", "|poke|p1|Slowking, L100", "|poke|p2|Donphan, L100",
  "|switch|p1a: Mamoswine|Mamoswine, L100|341/341", "|switch|p2a: Donphan|Donphan, L100|100/100", "|turn|7"
];

// Constructed contracts matching the official legacy app / Preact PS object
// shapes. These are deliberately not described as recorded live-client proof.
function clientRoom(kind, request, lines = protocol, id = roomId) {
  const privateSide = structuredClone(request?.side ?? side);
  return {
    id, request: structuredClone(request),
    ...(kind === "preact" ? { side: privateSide } : {}),
    battle: {
      stepQueue: [...lines],
      ...(kind === "legacy" ? { mySide: { ...privateSide, sideid: "p1" }, myPokemon: privateSide.pokemon } : {}),
      yourSide: { sideid: "p2", name: "Them", pokemon: [
        { ident: "p2: Donphan", details: "Donphan, L100", condition: "100/100", active: true }
      ] },
      weather: "", terrain: "", pseudoWeather: []
    }
  };
}

function runHook(kind, rooms = [], focused = rooms[0]) {
  const messages = [], timeouts = [], intervals = [], sockets = [];
  class WebSocket {
    constructor(url) { this.url = url; this.listeners = {}; sockets.push(this); }
    send(data) { this.sent = data; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }
  const root = { rooms: Object.fromEntries(rooms.map((room) => [room.id, room])), receive() {}, send() {} };
  if (kind === "preact") Object.assign(root, { room: focused, baseRoom: rooms[0] });
  else root.curRoom = focused;
  const window = {
    crypto: { randomUUID: () => "contract-capture" },
    WebSocket, postMessage(message) { messages.push(structuredClone(message)); }, addEventListener() {},
    setTimeout(callback) { timeouts.push(callback); }, setInterval(callback) { intervals.push(callback); },
    ...(kind === "preact" ? { PS: root } : kind === "legacy" ? { app: root } : {})
  };
  vm.runInNewContext(hookSource, { window, console, Date });
  timeouts.forEach((callback) => callback());
  return { window, root, messages, intervals, sockets };
}

function reduceCapture(capture) {
  const rooms = new Map();
  for (const message of capture.messages.filter((message) => message.kind === "room-protocol-snapshot")) {
    applyRawFrameToRoomMap(rooms, message.data);
  }
  const normalize = (snapshot) => ({ ...snapshot, capturedAt: "normalized" });
  return { rooms, snapshots: [...rooms.values()].map((room) => normalize(roomToSnapshot(room))) };
}

const cases = [
  ["team preview", { teamPreview: true, side: { ...side, pokemon: side.pokemon.map((mon) => ({ ...mon, active: false })) } }, "preview"],
  ["normal move and voluntary switch", { active: [active], side }, "turn"],
  ["forced switch", { forceSwitch: [true], side }, "turn"],
  ["possibly trapped", { active: [{ ...active, maybeTrapped: true }], side }, "turn"],
  ["trapped", { active: [{ ...active, trapped: true }], side }, "turn"],
  ["disabled move", { active: [{ moves: [{ ...active.moves[0], disabled: true }, active.moves[1]] }], side }, "turn"],
  ["Tera available", { active: [{ ...active, canTerastallize: "Ice" }], side }, "turn"],
  ["mid-battle reconnect", { active: [active], side }, "turn"],
  ["waiting without a request side", { wait: true }, "turn"],
  ["completed battle", { wait: true }, "finished", [...protocol, "|win|You"]]
];

for (const [name, request, phase, lines] of cases) {
  test(`legacy and Preact capture agree: ${name}`, () => {
    const make = (kind) => runHook(kind, [clientRoom(kind, { rqid: 47, ...request }, lines)]);
    const legacy = make("legacy"), preact = make("preact");
    const left = reduceCapture(legacy).snapshots[0], right = reduceCapture(preact).snapshots[0];
    assert.deepEqual(left, right);
    assert.equal(left.phase, phase);
    assert.equal(left.rawRequestSummary.rqid, 47);
    assert.equal(left.yourSide.team.length, 2);
    assert.equal(left.yourSide.team.find((mon) => mon.species === "Mamoswine").stats.spe, 284);
    for (const [capture, kind] of [[legacy, "legacy"], [preact, "preact"]]) {
      const emission = capture.messages.find((message) => message.kind === "room-protocol-snapshot");
      assert.equal(emission.clientKind, kind);
      assert.equal(emission.roomSlot, "p1");
      assert.equal(capture.messages.find((message) => message.kind === "active-room").roomId, roomId);
    }
    if (name === "possibly trapped") assert.equal(left.legalActions.find((action) => action.kind === "switch").uncertainLegal, true);
    if (name === "trapped") assert.equal(left.legalActions.some((action) => action.kind === "switch"), false);
    if (name === "forced switch") assert.ok(left.legalActions.every((action) => action.kind === "switch"));
    if (name === "disabled move") assert.equal(left.legalActions.find((action) => action.moveName === "Earthquake").disabled, true);
    if (name === "Tera available") {
      assert.deepEqual(left.legalActions.filter((action) => action.kind === "move").map((action) => action.id), [
        "move:1|tera=0", "move:1|tera=1", "move:2|tera=0", "move:2|tera=1"
      ]);
      assert.equal(left.legalActions.find((action) => action.terastallize).label, "Tera + Earthquake");
    }
    if (name === "waiting without a request side" || name === "completed battle") assert.equal(left.legalActions.length, 0);
  });
}

test("two battle rooms and Preact popup focus preserve the underlying battle selection", () => {
  for (const kind of ["legacy", "preact"]) {
    const rooms = [clientRoom(kind, { rqid: 1, active: [active], side }), clientRoom(kind, { rqid: 2, active: [active], side }, protocol, `${roomId}-other`)];
    const capture = runHook(kind, rooms, rooms[1]);
    const reduced = reduceCapture(capture);
    assert.equal(reduced.snapshots.length, 2);
    const focused = capture.messages.find((message) => message.kind === "active-room").roomId;
    assert.equal(buildTabSelection({ rooms: reduced.rooms, activeRoomId: focused }).snapshot.roomId, rooms[1].id);
    capture.root[kind === "preact" ? "room" : "curRoom"] = { id: "options" };
    if (kind === "preact") capture.root.baseRoom = rooms[1];
    capture.intervals.forEach((callback) => callback());
    const latestFocus = capture.messages.filter((message) => message.kind === "active-room").at(-1).roomId;
    assert.equal(latestFocus, kind === "preact" ? rooms[1].id : null);
    // The 1.5 s pass re-sends nothing unchanged; only the periodic full re-send (which rebuilds a restarted MV3 service
    // worker's state mid-battle) repeats each room once. Broken deduplication would give 6.
    assert.equal(capture.messages.filter((message) => message.kind === "room-protocol-snapshot").length, 4);
  }
});

test("legacy right-panel battle selection is independent of room insertion order; two visible battles remain ambiguous", () => {
  const a = clientRoom("legacy", { rqid: 1, active: [active], side });
  const b = clientRoom("legacy", { rqid: 2, active: [active], side }, protocol, `${roomId}-right`);
  for (const ordered of [[a, b], [b, a]]) {
    const capture = runHook("legacy", ordered, { id: "" });
    capture.root.curSideRoom = b;
    capture.intervals.forEach((callback) => callback());
    let hint = capture.messages.filter((message) => message.kind === "active-room").at(-1);
    assert.equal(hint.roomId, b.id);
    assert.equal(hint.ambiguous, false);
    capture.root.curRoom = a;
    capture.intervals.forEach((callback) => callback());
    hint = capture.messages.filter((message) => message.kind === "active-room").at(-1);
    assert.equal(hint.roomId, null);
    assert.equal(hint.ambiguous, true);
    assert.equal(buildTabSelection({ rooms: reduceCapture(capture).rooms, activeRoomId: null, activeRoomAmbiguous: true }).status, "room_ambiguous");
  }
});

test("protocol-only capture works without either client global", () => {
  const capture = runHook("protocol-only");
  const ws = new capture.window.WebSocket("wss://sim.example/showdown");
  const data = `>${roomId}\n${protocol.join("\n")}\n|request|${JSON.stringify({ rqid: 8, active: [active], side })}`;
  ws.listeners.message({ data });
  ws.send(`${roomId}|/choose move 1`);
  const frames = capture.messages.filter((message) => message.kind === "websocket-frame");
  assert.deepEqual(frames.map((frame) => frame.direction), ["in", "out"]);
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, frames[0].data);
  assert.equal(roomToSnapshot(rooms.get(roomId)).rawRequestSummary.rqid, 8);
  assert.equal(ws.sent, `${roomId}|/choose move 1`);
});

test("choice ABI preserves move and party slots, Tera tokens, and exact preview orders", () => {
  const reduce = (request, gameType = "singles") => {
    const rooms = new Map();
    applyRawFrameToRoomMap(rooms, `>${roomId}\n|gametype|${gameType}\n|request|${JSON.stringify(request)}`);
    return rooms.get(roomId);
  };
  const request = { rqid: 5, side, active: [{ ...active, canTerastallize: "Ice", maybeTrapped: true }] };
  const room = reduce(request);
  assert.deepEqual(room.legalActions.map((action) => action.choice), ["move 1", "move 1 terastallize", "move 2", "move 2 terastallize", "switch 2"]);
  assert.ok(room.legalActions.every((action) => action.canUndo === false));
  assert.equal(room.legalActions.at(-1).legality, "uncertain");
  assert.equal(reduce({ side, active: [active] }).legalActions.some((action) => action.terastallize), false);
  const disabled = reduce({ side, active: [{ moves: [{ ...active.moves[0], pp: 0 }] }] });
  assert.equal(disabled.legalActions[0].legality, "disabled");
  assert.equal(disabled.legalActions[0].disabled, true);
  const duplicateNames = { ...side, pokemon: [side.pokemon[0], { ...side.pokemon[1], ident: "p1: Mamoswine" }, { ...side.pokemon[1], ident: "p1: Mamoswine" }] };
  const switches = reduce({ side: duplicateNames, forceSwitch: [true] }).legalActions;
  assert.deepEqual(switches.map((action) => action.choice), ["switch 2", "switch 3"]);
  assert.deepEqual(switches.map((action) => action.targetSlot), [2, 3]);
  const preview = reduce({ teamPreview: true, side });
  assert.deepEqual(preview.legalActions.map((action) => action.choice), ["team 12", "team 21"]);
  assert.ok(preview.legalActions.every((action) => action.kind === "team"));
  assert.deepEqual(preview.legalActions[1].teamSpec, [2, 1]);
  const six = { ...side, pokemon: Array.from({ length: 6 }, (_, index) => ({ ...side.pokemon[0], ident: `p1: Mon${index}` })) };
  assert.equal(reduce({ teamPreview: true, side: six }).legalActions.length, 720);
});

test("unsupported game types do not yield partial singles decisions", () => {
  for (const [gameType, request] of [
    ["doubles", { side, active: [active, active] }], ["multi", { side, forceSwitch: [true, false] }],
    ["singles", { side, active: [active, active] }]
  ]) {
    const rooms = new Map();
    applyRawFrameToRoomMap(rooms, `>${roomId}\n|gametype|${gameType}\n|request|${JSON.stringify(request)}`);
    const selection = buildTabSelection({ rooms, activeRoomId: roomId });
    assert.equal(selection.snapshot.rawRequestSummary.capability, "unsupported_game_type");
    assert.equal(selection.snapshot.legalActions.length, 0);
    assert.notEqual(selection.status, "ready");
    assert.match(selection.message, /unsupported_game_type/);
  }
});

test("choices expire as execution starts and require a new private request", () => {
  const rooms = new Map();
  const request = { rqid: 5, side, active: [active] };
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|request|${JSON.stringify(request)}`);
  assert.equal(buildTabSelection({ rooms, activeRoomId: roomId }).status, "ready");
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|move|p1a: Mamoswine|Earthquake|p2a: Donphan`);
  assert.equal(roomToSnapshot(rooms.get(roomId)).legalActions.length, 0);
  assert.notEqual(buildTabSelection({ rooms, activeRoomId: roomId }).status, "ready");
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|request|${JSON.stringify({ ...request, rqid: 6 })}`);
  assert.equal(buildTabSelection({ rooms, activeRoomId: roomId }).status, "ready");
});

test("a false per-actor forceSwitch flag retains normal choices and request kind", () => {
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|request|${JSON.stringify({ rqid: 9, side, active: [active], forceSwitch: [false] })}`);
  const snapshot = roomToSnapshot(rooms.get(roomId));
  assert.equal(snapshot.rawRequestSummary.requestKind, "move");
  assert.ok(snapshot.legalActions.some((action) => action.kind === "move"));
  assert.ok(snapshot.legalActions.some((action) => action.kind === "switch"));
});

test("Revival Blessing chooses only fainted reserves using the server party slot", () => {
  const rooms = new Map();
  const request = { rqid: 10, forceSwitch: [true], side: { ...side, pokemon: [
    { ...side.pokemon[0], reviving: true },
    { ident: "p1: Fainted", details: "Scizor", condition: "0 fnt", active: false },
    { ident: "p1: Healthy", details: "Slowking", condition: "200/350", active: false }
  ] } };
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|request|${JSON.stringify(request)}`);
  const snapshot = roomToSnapshot(rooms.get(roomId));
  assert.equal(snapshot.legalActions.length, 1);
  assert.equal(snapshot.legalActions[0].choice, "switch 2");
  assert.equal(snapshot.legalActions[0].reviving, true);
  assert.equal(snapshot.legalActions[0].targetSlot, 2);
  assert.equal(snapshot.rawRequestSummary.reviving, true);
});
