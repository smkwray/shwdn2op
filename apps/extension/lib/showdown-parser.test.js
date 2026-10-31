import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyRawFrameToRoomMap, mergeRoomState, roomToSnapshot } from "./showdown-parser.js";
import { buildTabSelection, TAB_STATUS } from "./tab-state.js";


const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

test("protocol details distinguish hidden preview level, default level 100, Tera and permanent forme changes; ties finish the battle", () => {
  const rooms = new Map();
  const roomId = "battle-gen9uu-details";
  const update = (data) => {
    applyRawFrameToRoomMap(rooms, `>${roomId}\n${data}`);
    return rooms.get(roomId);
  };
  let room = update("|poke|p2|Ogerpon\n|poke|p2|Pikachu, L50");
  assert.equal(room.sides.p2.team["p2: Ogerpon"].level, null);
  assert.equal(room.sides.p2.team["p2: Pikachu"].level, 50);
  room = update("|switch|p2a: Ogerpon|Ogerpon, tera:Grass|100/100");
  const mon = room.sides.p2.team[room.sides.p2.activeKey];
  assert.equal(mon.level, 100);
  assert.equal(mon.terastallized, true);
  assert.equal(mon.teraType, "Grass");
  update("|detailschange|p2a: Ogerpon|Ogerpon-Teal-Tera, tera:Grass|90/100");
  assert.equal(mon.species, "Ogerpon-Teal-Tera");
  assert.equal(mon.hpPercent, 90);
  room = update("|tie");
  assert.equal(room.phase, "finished");
  assert.equal(room.requestCurrent, false);
});

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

test("supplemental page-state can rebuild opponent team on a fresh reload snapshot", () => {
  const raw = `
>battle-gen9uu-sso-restore-opponent
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Fezandipiti","details":"Fezandipiti, L100","condition":"100/100","active":true,"stats":{"hp":380,"atk":176,"def":262,"spa":176,"spd":262,"spe":260},"moves":["Moonblast","Roost"]}]},"active":[{"moves":[{"move":"Moonblast","id":"moonblast","pp":15},{"move":"Roost","id":"roost","pp":16}]}]}
|sso-state|{"playerSide":"p1","sideNames":{"p1":"You","p2":"Opponent"},"pokemon":[{"side":"p1","ident":"p1: Fezandipiti","details":"Fezandipiti, L100","condition":"100/100","active":true,"stats":{"hp":380,"atk":176,"def":262,"spa":176,"spd":262,"spe":260},"moves":["moonblast","roost"],"item":"Heavy-Duty Boots","ability":"Toxic Chain","teraType":"Water","terastallized":false},{"side":"p2","ident":"p2: Slowking","details":"Slowking, L100","condition":"100/100","active":true,"moves":["Scald","Future Sight"],"item":"Heavy-Duty Boots","ability":"Regenerator","teraType":"Fairy","terastallized":false},{"side":"p2","ident":"p2: Thundurus","details":"Thundurus, L100","condition":"100/100","active":false,"moves":["Volt Switch","Thunder Wave"],"item":"Heavy-Duty Boots","ability":"Prankster","teraType":"Steel","terastallized":false}],"field":{"weather":null,"terrain":null,"pseudoWeather":[],"yourSideConditions":["Stealth Rock"],"opponentSideConditions":[]}}
`;
  const rooms = new Map();

  applyRawFrameToRoomMap(rooms, raw);

  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-sso-restore-opponent"));
  assert.equal(snapshot?.opponentSide?.active?.species, "Slowking");
  assert.deepEqual(
    snapshot?.opponentSide?.team?.map((mon) => mon?.species).sort(),
    ["Slowking", "Thundurus"]
  );
  assert.equal(snapshot?.field?.yourSideConditions?.[0], "Stealth Rock");
});

test("merging a reduced room snapshot preserves known opponent team state", () => {
  const fullRaw = `
>battle-gen9uu-merge-room
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Fezandipiti|Fezandipiti, L100|100/100
|switch|p2a: Slowking|Slowking, L100|100/100
|poke|p2|Thundurus, L100
|turn|5
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Fezandipiti","details":"Fezandipiti, L100","condition":"100/100","active":true,"stats":{"spe":260},"moves":["Moonblast"]}]},"active":[{"moves":[{"move":"Moonblast","id":"moonblast","pp":15}]}]}
`;
  const reducedRaw = `
>battle-gen9uu-merge-room
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Fezandipiti","details":"Fezandipiti, L100","condition":"100/100","active":true,"stats":{"spe":260},"moves":["Moonblast"]}]},"active":[{"moves":[{"move":"Moonblast","id":"moonblast","pp":15}]}]}
|sso-state|{"playerSide":"p1","pokemon":[{"side":"p1","ident":"p1: Fezandipiti","details":"Fezandipiti, L100","condition":"100/100","active":true,"stats":{"spe":260},"moves":["moonblast"]}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, fullRaw);
  const previousRoom = rooms.get("battle-gen9uu-merge-room");
  const snapshotRooms = new Map();
  applyRawFrameToRoomMap(snapshotRooms, reducedRaw);
  const reducedRoom = snapshotRooms.get("battle-gen9uu-merge-room");

  const merged = mergeRoomState(previousRoom, reducedRoom);
  const snapshot = roomToSnapshot(merged);

  assert.deepEqual(
    snapshot?.opponentSide?.team?.map((mon) => mon?.species).sort(),
    ["Slowking", "Thundurus"]
  );
  assert.equal(snapshot?.opponentSide?.active?.species, "Slowking");
});

test("protocol side conditions survive supplemental contradiction and clear on protocol removal", () => {
  const raw = `
>battle-gen9uu-side-conditions
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Forretress|Forretress, L100|100/100
|switch|p2a: Hippowdon|Hippowdon, L100|100/100
|-sidestart|p1: You|Spikes
|-sidestart|p1: You|Spikes
|-sidestart|p1: You|Stealth Rock
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Forretress","details":"Forretress, L100","condition":"100/100","active":true,"stats":{"spe":96},"moves":["Rapid Spin"]}]},"active":[{"moves":[{"move":"Rapid Spin","id":"rapidspin","pp":64}]}]}
|sso-state|{"playerSide":"p1","pokemon":[{"side":"p1","ident":"p1: Forretress","details":"Forretress, L100","condition":"100/100","active":true,"stats":{"spe":96},"moves":["rapidspin"]}],"field":{"weather":null,"terrain":null,"pseudoWeather":[],"yourSideConditions":["Spikes","Spikes","Stealth Rock"],"opponentSideConditions":[]}}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  let snapshot = roomToSnapshot(rooms.get("battle-gen9uu-side-conditions"));
  assert.deepEqual(snapshot?.field?.yourSideConditions, ["Spikes", "Spikes", "Stealth Rock"]);

  const clearedRaw = `
>battle-gen9uu-side-conditions
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Forretress","details":"Forretress, L100","condition":"100/100","active":true,"stats":{"spe":96},"moves":["Rapid Spin"]}]},"active":[{"moves":[{"move":"Rapid Spin","id":"rapidspin","pp":63}]}]}
|sso-state|{"playerSide":"p1","pokemon":[{"side":"p1","ident":"p1: Forretress","details":"Forretress, L100","condition":"100/100","active":true,"stats":{"spe":96},"moves":["rapidspin"]}],"field":{"weather":null,"terrain":null,"pseudoWeather":[],"yourSideConditions":[],"opponentSideConditions":[]}}
`;
  const nextRooms = new Map(rooms);
  const reducedRooms = new Map();
  applyRawFrameToRoomMap(reducedRooms, clearedRaw);
  const merged = mergeRoomState(
    nextRooms.get("battle-gen9uu-side-conditions"),
    reducedRooms.get("battle-gen9uu-side-conditions")
  );
  snapshot = roomToSnapshot(merged);
  assert.deepEqual(snapshot?.field?.yourSideConditions, ["Spikes", "Spikes", "Stealth Rock"]);
  applyRawFrameToRoomMap(new Map([[merged.roomId, merged]]), `>${merged.roomId}\n|-sideend|p1: You|Spikes\n|-sideend|p1: You|Stealth Rock`);
  snapshot = roomToSnapshot(merged);
  assert.deepEqual(snapshot?.field?.yourSideConditions, []);
});

test("explicit clears survive the periodic two-snapshot merge, including empty values", () => {
  const reduce = (lines) => {
    const rooms = new Map();
    applyRawFrameToRoomMap(rooms, `>battle-gen9uu-clears\n${lines.join("\n")}`);
    return rooms.get("battle-gen9uu-clears");
  };
  const initial = reduce([
    "|switch|p2a: Salamence|Salamence, L100|100/100 brn", "|-item|p2a: Salamence|Leftovers", "|-boost|p2a: Salamence|atk|2",
    "|-weather|SunnyDay", "|-fieldstart|move: Electric Terrain", "|-fieldstart|move: Trick Room", "|-sidestart|p2: Them|Stealth Rock"
  ]);
  const clears = [
    "|-curestatus|p2a: Salamence|brn", "|-enditem|p2a: Salamence|Leftovers", "|-clearboost|p2a: Salamence",
    "|-weather|none", "|-fieldend|move: Electric Terrain", "|-fieldend|move: Trick Room", "|-sideend|p2: Them|Stealth Rock"
  ];
  const fresh = reduce(clears);
  const merged = mergeRoomState(initial, fresh);
  const mon = merged.sides.p2.team["p2: Salamence"];
  assert.equal(mon.status, null);
  assert.equal(mon.item, null);
  assert.equal(mon.removedItem, "Leftovers");
  assert.deepEqual(mon.boosts, {});
  for (const field of ["weather", "terrain", "pseudoWeather"]) assert.deepEqual(merged.field[field], fresh.field[field]);
  assert.deepEqual(merged.sideConditions.p2, []);

  const supplemental = reduce([`|sso-state|${JSON.stringify({ playerSide: "p1", pokemon: [
    { side: "p2", ident: "p2: Salamence", details: "Salamence, L100", condition: "100/100 brn", item: "Leftovers", boosts: { atk: 2 } }
  ], field: { weather: "SunnyDay", terrain: "Electric Terrain", pseudoWeather: ["Trick Room"], opponentSideConditions: ["Stealth Rock"] } })}`]);
  const resynced = mergeRoomState(mergeRoomState(merged, supplemental), supplemental);
  const resyncedMon = resynced.sides.p2.team["p2: Salamence"];
  assert.equal(resyncedMon.status, null);
  assert.equal(resyncedMon.item, null);
  assert.deepEqual(resyncedMon.boosts, {});
  assert.equal(resynced.field.weather, null);
  assert.equal(resynced.field.terrain, null);
  assert.deepEqual(resynced.field.pseudoWeather, []);
  assert.deepEqual(resynced.sideConditions.p2, []);
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

test("parser logs critical hits so observed damage learning can ignore them", () => {
  const raw = `
>battle-gen9uu-crit-log
|init|battle
|player|p1|You
|player|p2|Opponent
|tier|[Gen 9] UU
|switch|p1a: Fezandipiti|Fezandipiti, L100|100/100
|switch|p2a: Pincurchin|Pincurchin, L100|100/100
|move|p1a: Fezandipiti|Moonblast|p2a: Pincurchin
|-crit|p2a: Pincurchin
|-damage|p2a: Pincurchin|35/100
|turn|16
|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Fezandipiti","details":"Fezandipiti, L100","condition":"100/100","active":true,"stats":{"hp":380,"atk":176,"def":262,"spa":176,"spd":262,"spe":260},"moves":["Moonblast"]}]},"active":[{"moves":[{"move":"Moonblast","id":"moonblast","pp":15}]}]}
`;
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, raw);
  const snapshot = roomToSnapshot(rooms.get("battle-gen9uu-crit-log"));
  assert.ok(snapshot?.recentLog.some((line) => /critical hit/i.test(line)));
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

test("canonical presentation labels never rename the side-qualified mechanics owner", () => {
  const rooms = new Map();
  const roomId = "battle-gen9ou-log-label";
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|switch|p2a: @team-preview-4|Mandibuzz|100/100`, { presentationName: "Mandibuzz" });
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|move|p2a: @team-preview-4|Defog|p1a: @team-preview-4`, { presentationName: "Mandibuzz" });
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|switch|p1a: @team-preview-4|Pecharunt|100/100`, { presentationName: "Pecharunt" });
  const room = rooms.get(roomId);
  assert.deepEqual(room.recentLog, ["Mandibuzz entered the field.", "Mandibuzz used Defog.", "Pecharunt entered the field."]);
  assert.deepEqual(room.sides.p2.team["p2: @team-preview-4"].knownMoves, ["Defog"]);
  assert.deepEqual(room.sides.p1.team["p1: @team-preview-4"].knownMoves, []);
  applyRawFrameToRoomMap(rooms, `>${roomId}\n|move|p1a: Pecharunt|Shadow Ball|p2a: Mandibuzz`);
  assert.equal(room.recentLog.at(-1), "Pecharunt used Shadow Ball.", "ordinary parser callers retain their original labels");
});

test("a null request clears prior actions while preserving the private side and party", async () => {
  const rooms = new Map();
  const raw = await fs.readFile(new URL("../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  applyRawFrameToRoomMap(rooms, raw);
  const room = rooms.get("battle-gen9ou-123456789");
  const before = roomToSnapshot(room);
  assert.ok(before.legalActions.length);
  applyRawFrameToRoomMap(rooms, `>${room.roomId}\n|request|null`);
  const after = roomToSnapshot(room);
  assert.equal(room.lastRequest, null);
  assert.equal(room.requestCurrent, false);
  assert.deepEqual(after.legalActions, []);
  assert.equal(after.rawRequestSummary, null);
  assert.deepEqual(after.yourSide, before.yourSide);
  assert.deepEqual(after.opponentSide, before.opponentSide);
  const selection = buildTabSelection({ activeRoomId: room.roomId, rooms });
  assert.equal(selection.status, TAB_STATUS.WAITING_OR_NOT_YOUR_TURN);
});


test("Slow Start protocol activation belongs to its stint and survives requests and resync", () => {
  const roomId = "battle-gen9uu-slow-start", rooms = new Map();
  const apply = (data) => { applyRawFrameToRoomMap(rooms, `>${roomId}\n${data}`); return rooms.get(roomId); };
  const active = (side = "p1") => { const room = rooms.get(roomId); return room.sides[side].team[room.sides[side].activeKey]; };
  const request = (extra = {}) => `|request|${JSON.stringify({ rqid: 1, active: [{ moves: [{ move: "Protect", id: "protect", pp: 10 }] }], side: { id: "p1", pokemon: [
    { ident: "p1: Giant", details: "Regigigas", active: true, condition: "424/424", baseAbility: "slowstart", ability: "slowstart", item: "leftovers", stats: { atk: 356, spe: 328 }, moves: ["protect"], ...extra }
  ] } })}`;
  apply("|switch|p1a: Giant|Regigigas|100/100\n|switch|p2a: King|Slowking|100/100");
  assert.equal(active().slowStartActive, undefined, "entry alone cannot establish the timer");
  apply(request({ slowStartActive: true }));
  assert.equal(active().slowStartActive, undefined, "private request extensions cannot invent activation");
  apply("|-start|p1a: Giant|ability: Slow Start");
  assert.equal(active().slowStartActive, true);
  apply(request({ slowStartActive: false }));
  assert.equal(active().slowStartActive, true, "private requests omit the timer");
  const before = structuredClone(rooms.get(roomId));
  apply("|-end|p1a: Giant|Slow Start");
  const ended = structuredClone(rooms.get(roomId));
  assert.equal(mergeRoomState(before, ended).sides.p1.team["p1: Giant"].slowStartActive, false);
  assert.equal(roomToSnapshot(rooms.get(roomId)).yourSide.active.slowStartActive, false);
  apply("|switch|p1a: Nurse|Blissey|100/100\n|switch|p1a: Giant|Regigigas|100/100");
  assert.equal(active().slowStartActive, undefined);
  assert.equal(mergeRoomState(ended, rooms.get(roomId)).sides.p1.team["p1: Giant"].slowStartActive, undefined, "an explicit new-stint clear survives merging");
  apply("|-start|p1a: Giant|ability: Slow Start");
  assert.equal(active().slowStartActive, true);
  apply("|-activate|p2a: King|Skill Swap|Slow Start|Regenerator|[of] p1a: Giant\n|-end|p1a: Giant|Slow Start|[silent]\n|-start|p2a: King|ability: Slow Start");
  assert.equal(active().ability, "Regenerator");
  assert.equal(active("p2").ability, "Slow Start");
  assert.equal(active("p2").slowStartActive, true);
  apply("|-activate|p2a: King|Skill Swap|Regenerator|Slow Start|[of] p1a: Giant\n|-end|p2a: King|Slow Start|[silent]\n|-start|p1a: Giant|ability: Slow Start");
  assert.equal(active().ability, "Slow Start");
  assert.equal(active().slowStartActive, true);
  assert.equal(active("p2").ability, "Regenerator");
  apply("|-endability|p1a: Giant|Slow Start");
  assert.equal(active().slowStartActive, undefined);
});

// Matters: "-heal|p2a: Clodsire|…|[from] ability: Water Absorb|[of] p1a: Slowking" credited
// Slowking with Water Absorb, so Clodsire's ability stayed unrevealed and Scald could be picked into it again. A -heal's
// [of] is the heal's source; the effect belongs to the healed Pokémon. A -damage's [of] still owns its effect.
test("a heal's ability belongs to the healed Pokémon; a damage line's [of] still owns its effect", () => {
  for (const [absorber, ability, attacker] of [["Clodsire", "Water Absorb", "Slowking"], ["Lanturn", "Volt Absorb", "Rotom-Heat"]]) {
    const rooms = new Map();
    const roomId = `battle-gen9uu-heal-${absorber.toLowerCase()}`;
    const update = (data) => { applyRawFrameToRoomMap(rooms, `>${roomId}\n${data}`); return rooms.get(roomId); };
    update(`|init|battle\n|tier|[Gen 9] UU\n|switch|p1a: ${attacker}|${attacker}, L100|300/300\n|switch|p2a: ${absorber}|${absorber}, L100|73/100\n|turn|24`);
    const room = update(`|move|p1a: ${attacker}|Scald|p2a: ${absorber}\n|-heal|p2a: ${absorber}|98/100|[from] ability: ${ability}|[of] p1a: ${attacker}\n|-damage|p1a: ${attacker}|250/300|[from] item: Rocky Helmet|[of] p2a: ${absorber}`);
    assert.equal(room.sides.p2.team[`p2: ${absorber}`].ability, ability);
    assert.equal(room.sides.p2.team[`p2: ${absorber}`].item, "Rocky Helmet", "a damage line's [of] owns the Rocky Helmet");
    const fresh = new Map();
    applyRawFrameToRoomMap(fresh, `>${roomId}\n|init|battle\n|switch|p1a: ${attacker}|${attacker}, L100|300/300\n|switch|p2a: ${absorber}|${absorber}, L100|73/100\n|-heal|p2a: ${absorber}|98/100|[from] ability: ${ability}|[of] p1a: ${attacker}`);
    assert.equal(fresh.get(roomId).sides.p2.team[`p2: ${absorber}`].ability, ability);
    assert.notEqual(fresh.get(roomId).sides.p1.team[`p1: ${attacker}`].ability, ability, "the attacker is not the absorber");
  }
});
