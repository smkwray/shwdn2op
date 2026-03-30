import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyRawFrameToRoomMap, roomToSnapshot } from "./showdown-parser.js";
import { buildTabSelection, TAB_STATUS } from "./tab-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function loadText(relativePath) {
  return fs.readFile(path.resolve(repoRoot, relativePath), "utf8");
}

async function loadJson(relativePath) {
  return JSON.parse(await loadText(relativePath));
}

function normalizeSnapshot(snapshot) {
  const normalizePokemon = (pokemon) => pokemon ? {
    ...pokemon,
    removedItem: pokemon.removedItem ?? null
  } : pokemon;
  const normalizeSide = (side) => side ? {
    ...side,
    active: normalizePokemon(side.active),
    team: Array.isArray(side.team) ? side.team.map(normalizePokemon) : side.team
  } : side;
  return {
    ...snapshot,
    yourSide: normalizeSide(snapshot?.yourSide),
    opponentSide: normalizeSide(snapshot?.opponentSide),
    capturedAt: "normalized"
  };
}

test("sample raw frame reduces to the paired snapshot fixture", async () => {
  const raw = await loadText("examples/raw-showdown-frame.sample.txt");
  const expected = await loadJson("examples/battle-snapshot.gen9ou.turn14.json");
  const rooms = new Map();

  applyRawFrameToRoomMap(rooms, raw);

  const snapshot = roomToSnapshot(rooms.get("battle-gen9ou-123456789"));
  assert.deepEqual(normalizeSnapshot(snapshot), normalizeSnapshot(expected));
});

test("multiple actionable rooms are ambiguous until an active room is known", async () => {
  const raw = await loadText("examples/raw-showdown-frame.multibattle.txt");
  const rooms = new Map();

  applyRawFrameToRoomMap(rooms, raw);

  const ambiguous = buildTabSelection({ activeRoomId: null, rooms });
  assert.equal(ambiguous.status, TAB_STATUS.ROOM_AMBIGUOUS);
  assert.deepEqual(ambiguous.actionableRoomIds.sort(), [
    "battle-gen9ou-alpha",
    "battle-gen9ou-omega"
  ]);

  const focused = buildTabSelection({ activeRoomId: "battle-gen9ou-omega", rooms });
  assert.equal(focused.status, TAB_STATUS.READY);
  assert.equal(focused.snapshot?.roomId, "battle-gen9ou-omega");
  assert.equal(focused.snapshot?.yourSide?.active?.species, "Iron Valiant");
});

test("wait requests are surfaced as waiting_or_not_your_turn", async () => {
  const raw = await loadText("examples/raw-showdown-frame.waiting.txt");
  const rooms = new Map();

  applyRawFrameToRoomMap(rooms, raw);

  const selection = buildTabSelection({ activeRoomId: "battle-gen9ou-waiting", rooms });
  assert.equal(selection.status, TAB_STATUS.WAITING_OR_NOT_YOUR_TURN);
  assert.match(selection.message, /waiting/i);
});

test("stale snapshots are rejected before provider analysis", () => {
  const room = {
    roomId: "battle-gen9ou-stale",
    title: "Old battle",
    format: "[Gen 9] OU",
    turn: 19,
    phase: "turn",
    playerSide: "p1",
    opponentSideId: "p2",
    lastRequest: { side: { id: "p1" } },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake" }],
    recentLog: [],
    notes: [],
    sides: {
      p1: { slot: "p1", name: "Alice", team: {}, activeKey: null },
      p2: { slot: "p2", name: "Bob", team: {}, activeKey: null }
    },
    field: { weather: null, terrain: null, pseudoWeather: [] },
    sideConditions: { p1: [], p2: [] },
    updatedAt: 1_000
  };

  const selection = buildTabSelection(
    { activeRoomId: "battle-gen9ou-stale", rooms: new Map([[room.roomId, room]]) },
    { now: 40_500, staleMs: 30_000 }
  );

  assert.equal(selection.status, TAB_STATUS.STALE_SNAPSHOT);
  assert.match(selection.message, /stale/i);
});

test("parser learns item and ability reveals from source annotations", () => {
  const raw = `
>battle-gen9uu-parser
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Scizor|Scizor, L100|100/100
|switch|p2a: Garchomp|Garchomp, L100|100/100
|-heal|p2a: Garchomp|100/100|[from] item: Leftovers
|-damage|p1a: Scizor|88/100|[from] ability: Rough Skin|[of] p2a: Garchomp
|switch|p2a: Iron Leaves|Iron Leaves, L100|100/100
|-activate|p2a: Iron Leaves|item: Booster Energy
|turn|4
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Scizor","details":"Scizor, L100","condition":"88/100","active":true,"stats":{"hp":344,"atk":394,"def":236,"spa":146,"spd":196,"spe":166},"moves":["Bullet Punch"]}]},"active":[{"moves":[{"move":"Bullet Punch","id":"bulletpunch","pp":30}]}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-parser"));
  const opponentTeam = snapshot?.opponentSide?.team ?? [];
  const garchomp = opponentTeam.find((mon) => mon?.species === "Garchomp");
  const ironLeaves = opponentTeam.find((mon) => mon?.species === "Iron Leaves");

  assert.equal(garchomp?.item, "Leftovers");
  assert.equal(garchomp?.ability, "Rough Skin");
  assert.equal(ironLeaves?.item, "Booster Energy");
});

test("parser preserves knocked off item identity separately from the current held item", () => {
  const raw = `
>battle-gen9uu-knockoff
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Quaquaval|Quaquaval, L100|100/100
|switch|p2a: Salamence|Salamence, L100|100/100
|-item|p2a: Salamence|Heavy-Duty Boots
|move|p1a: Quaquaval|Knock Off|p2a: Salamence
|-enditem|p2a: Salamence|Heavy-Duty Boots|[from] move: Knock Off|[of] p1a: Quaquaval
|turn|7
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Quaquaval","details":"Quaquaval, L100","condition":"100/100","active":true,"stats":{"hp":341,"atk":295,"def":236,"spa":185,"spd":236,"spe":295},"moves":["Knock Off"]}]},"active":[{"moves":[{"move":"Knock Off","id":"knockoff","pp":31}]}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-knockoff"));
  const salamence = snapshot?.opponentSide?.team?.find((mon) => mon?.species === "Salamence");

  assert.equal(salamence?.item, null);
  assert.equal(salamence?.removedItem, "Heavy-Duty Boots");
});

test("parser learns immunity abilities from immune lines", () => {
  const raw = `
>battle-gen9uu-immune
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Clodsire|Clodsire, L100|100/100
|switch|p2a: Rotom-Wash|Rotom-Wash, L100|100/100
|-immune|p2a: Rotom-Wash|[from] ability: Levitate
|turn|3
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Clodsire","details":"Clodsire, L100","condition":"100/100","active":true,"stats":{"hp":394,"atk":186,"def":236,"spa":126,"spd":236,"spe":96},"moves":["Earthquake"]}]},"active":[{"moves":[{"move":"Earthquake","id":"earthquake","pp":16}]}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-immune"));
  const opponent = snapshot?.opponentSide?.team?.find((mon) => mon?.species === "Rotom-Wash");
  assert.equal(opponent?.ability, "Levitate");
});

test("parser learns absorb and source-based item reveals from protocol tags", () => {
  const raw = `
>battle-gen9uu-absorbs
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Clodsire|Clodsire, L100|100/100
|switch|p2a: Vaporeon|Vaporeon, L100|100/100
|switch|p2b: Toxicroak|Toxicroak, L100|100/100
|switch|p2c: Talonflame|Talonflame, L100|100/100
|switch|p2d: Iron Bundle|Iron Bundle, L100|100/100
|switch|p2e: Swampert|Swampert, L100|100/100
|-immune|p2a: Vaporeon|[from] ability: Water Absorb
|-immune|p2b: Toxicroak|[from] ability: Dry Skin
|-immune|p2c: Talonflame|[from] ability: Flash Fire
|-activate|p2d: Iron Bundle|item: Booster Energy
|-heal|p2e: Swampert|100/100|[from] item: Leftovers
|turn|4
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Clodsire","details":"Clodsire, L100","condition":"100/100","active":true,"stats":{"hp":394,"atk":186,"def":236,"spa":126,"spd":236,"spe":96},"moves":["Earthquake"]}]},"active":[{"moves":[{"move":"Earthquake","id":"earthquake","pp":16}]}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-absorbs"));
  const team = snapshot?.opponentSide?.team ?? [];

  assert.equal(team.find((mon) => mon?.species === "Vaporeon")?.ability, "Water Absorb");
  assert.equal(team.find((mon) => mon?.species === "Toxicroak")?.ability, "Dry Skin");
  assert.equal(team.find((mon) => mon?.species === "Talonflame")?.ability, "Flash Fire");
  assert.equal(team.find((mon) => mon?.species === "Iron Bundle")?.item, "Booster Energy");
  assert.equal(team.find((mon) => mon?.species === "Swampert")?.item, "Leftovers");
});


test("supplemental page-state restores full player stats when request stats are partial", () => {
  const raw = `
>battle-gen9uu-sso-state
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Scizor|Scizor, L100|100/100
|switch|p2a: Noivern|Noivern, L100|100/100
|turn|6
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Scizor","details":"Scizor, L100","condition":"100/100","active":true,"stats":{"atk":394},"moves":["Bullet Punch","U-turn"]}]},"active":[{"moves":[{"move":"Bullet Punch","id":"bulletpunch","pp":30},{"move":"U-turn","id":"uturn","pp":16}]}]}
|sso-state|{"playerSide":"p1","myPokemon":[{"ident":"p1: Scizor","details":"Scizor, L100","condition":"100/100","active":true,"stats":{"hp":344,"atk":394,"def":236,"spa":146,"spd":196,"spe":166},"moves":["bulletpunch","uturn"],"item":"Choice Band","ability":"Technician","teraType":"Steel","terastallized":false}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-sso-state"));
  assert.equal(snapshot?.yourSide?.active?.stats?.spe, 166);
  assert.equal(snapshot?.yourSide?.active?.item, "Choice Band");
  assert.equal(snapshot?.yourSide?.active?.ability, "Technician");
  assert.equal(snapshot?.yourSide?.slot, "p1");
});

test("parser logs sourced HP changes so noisy damage windows can be filtered", () => {
  const raw = `
>battle-gen9uu-hp-source
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Scizor|Scizor, L100|100/100
|switch|p2a: Garchomp|Garchomp, L100|100/100
|-damage|p1a: Scizor|88/100|[from] ability: Rough Skin|[of] p2a: Garchomp
|turn|4
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Scizor","details":"Scizor, L100","condition":"88/100","active":true,"stats":{"hp":344,"atk":394,"def":236,"spa":146,"spd":196,"spe":166},"moves":["Bullet Punch"]}]},"active":[{"moves":[{"move":"Bullet Punch","id":"bulletpunch","pp":30}]}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-hp-source"));
  assert.ok(snapshot?.recentLog.some((line) => /hp change from rough skin/i.test(line)));
});

test("team preview requests stay in preview phase and count as actionable before turn 1", () => {
  const raw = `
>battle-gen9uu-preview-ready
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|poke|p1|Hydreigon, L100
|poke|p1|Scizor, L100
|poke|p2|Azelf, L100
|poke|p2|Mienshao, L100
|request|{"teamPreview":true,"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Hydreigon","details":"Hydreigon, L100","condition":"100/100"},{"ident":"p1: Scizor","details":"Scizor, L100","condition":"100/100"}]}}
`;
  const rooms = new Map();

  applyRawFrameToRoomMap(rooms, raw);

  const room = rooms.get("battle-gen9uu-preview-ready");
  const snapshot = roomToSnapshot(room);
  const selection = buildTabSelection({ activeRoomId: "battle-gen9uu-preview-ready", rooms });

  assert.equal(snapshot?.phase, "preview");
  assert.equal(snapshot?.rawRequestSummary?.teamPreview, true);
  assert.ok((snapshot?.legalActions?.length ?? 0) >= 2);
  assert.equal(selection.status, TAB_STATUS.READY);
  assert.match(selection.message, /team preview/i);
});

test("parser clamps boost stages to the in-battle -6..+6 range", () => {
  const raw = `
>battle-gen9uu-boost-clamp
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Scizor|Scizor, L100|100/100
|switch|p2a: Goodra|Goodra-Hisui, L100|100/100
|-unboost|p2a: Goodra|spa|2
|-unboost|p2a: Goodra|spa|2
|-unboost|p2a: Goodra|spa|2
|-unboost|p2a: Goodra|spa|2
|-boost|p1a: Scizor|atk|3
|-boost|p1a: Scizor|atk|3
|-boost|p1a: Scizor|atk|3
|turn|7
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Scizor","details":"Scizor, L100","condition":"100/100","active":true,"stats":{"hp":344,"atk":394,"def":236,"spa":146,"spd":196,"spe":166},"moves":["Bullet Punch"]}]},"active":[{"moves":[{"move":"Bullet Punch","id":"bulletpunch","pp":30}]}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-boost-clamp"));
  assert.equal(snapshot?.yourSide?.active?.boosts?.atk, 6);
  assert.equal(snapshot?.opponentSide?.active?.boosts?.spa, -6);
});
