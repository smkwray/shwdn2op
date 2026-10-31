import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { parseInferenceEvents } from "../mechanics/inferenceEvents.js";
import { filterLiveLikelyHeldItemNames } from "../mechanics/liveLikelyItems.js";
import { battleSnapshotSchema } from "../schema.js";
import { buildSelfActionRecommendation } from "../prediction/selfActionRecommender.js";

// Use the extension's canonical JS reducer to exercise the actual protocol/log
// boundary instead of constructing inference events by hand.
const parserUrl = new URL("../../../extension/lib/showdown-parser.js", import.meta.url);
const { applyRawFrameToRoomMap, roomToSnapshot } = await import(parserUrl.href);
const frameUrl = new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url);

for (const [trapped, maybeTrapped, forceSwitch, expectedSwitches, uncertain] of [
  [false, true, false, 1, true],
  [true, true, false, 0, false],
  [true, true, true, 1, false],
  [false, false, false, 1, false]
] as const) {
  test(`switch legality: trapped=${trapped}, maybeTrapped=${maybeTrapped}, forced=${forceSwitch}`, async () => {
    const rooms = new Map();
    applyRawFrameToRoomMap(rooms, await fs.readFile(frameUrl, "utf8"));
    const room = rooms.get("battle-gen9ou-123456789");
    const request = structuredClone(room.lastRequest);
    request.active[0].trapped = trapped;
    request.active[0].maybeTrapped = maybeTrapped;
    if (forceSwitch) request.forceSwitch = [true];
    applyRawFrameToRoomMap(rooms, `>${room.roomId}\n|request|${JSON.stringify(request)}`);
    const snapshot = battleSnapshotSchema.parse(roomToSnapshot(room));
    const switches = snapshot.legalActions.filter((action) => action.kind === "switch");
    assert.equal(switches.length, expectedSwitches);
    for (const action of switches) {
      assert.equal(Boolean(action.uncertainLegal), uncertain);
      if (uncertain) {
        assert.match(action.details!, /trapping.*cannot be undone/);
        const ranked = buildSelfActionRecommendation({ snapshot, playerDamagePreview: [], opponentThreatPreview: [] });
        assert.ok(ranked?.rankedActions.find((candidate) => candidate.actionId === action.id)
          ?.riskFlags.some((risk) => risk.includes("hidden trapping")));
      }
    }
  });
}

test("Paradox boosted stat is captured and cleared when activation ends or the Pokemon switches out", async () => {
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, await fs.readFile(frameUrl, "utf8"));
  const room = rooms.get("battle-gen9ou-123456789");
  const update = (lines: string) => {
    applyRawFrameToRoomMap(rooms, `>${room.roomId}\n${lines}`);
    return battleSnapshotSchema.parse(roomToSnapshot(room));
  };
  update("|switch|p2a: Iron Valiant|Iron Valiant, L100|100/100\n|-enditem|p2a: Iron Valiant|Booster Energy");
  let snapshot = update("|-activate|p2a: Iron Valiant|ability: Quark Drive|[fromitem]\n|-start|p2a: Iron Valiant|quarkdrivespa");
  assert.equal(snapshot.opponentSide.active!.paradoxBoostedStat, "spa");
  snapshot = update("|-end|p2a: Iron Valiant|Quark Drive");
  assert.equal(snapshot.opponentSide.active!.paradoxBoostedStat, null);
  snapshot = update("|-start|p2a: Iron Valiant|quarkdrivespe");
  assert.equal(snapshot.opponentSide.active!.paradoxBoostedStat, "spe");
  snapshot = update("|switch|p2a: Dragapult|Dragapult, L100|100/100");
  assert.equal(snapshot.opponentSide.team.find((mon) => mon.species === "Iron Valiant")!.paradoxBoostedStat, null);
  snapshot = update("|switch|p2a: Iron Valiant|Iron Valiant, L100|100/100");
  assert.equal(snapshot.opponentSide.active!.paradoxBoostedStat, null);
  assert.equal(snapshot.opponentSide.active!.removedItem, "Booster Energy");
  snapshot = update("|-start|p1a: Great Tusk|protosynthesisatk");
  assert.equal(snapshot.yourSide.active!.paradoxBoostedStat, "atk");
  snapshot = update("|-end|p1a: Great Tusk|Protosynthesis");
  assert.equal(snapshot.yourSide.active!.paradoxBoostedStat, null);
});

for (const status of [null, "psn", "par"]) {
  test(`Toxic Spikes without HP damage does not imply item immunity (status ${status})`, async () => {
    const rooms = new Map();
    applyRawFrameToRoomMap(rooms, await fs.readFile(frameUrl, "utf8"));
    applyRawFrameToRoomMap(rooms, [
      ">battle-gen9ou-123456789",
      "|-sidestart|p2: Bob|move: Toxic Spikes",
      `|switch|p2a: Greninja|Greninja, L100|100/100${status === "par" ? " par" : ""}`,
      ...(status === "psn" ? ["|-status|p2a: Greninja|psn|[from] move: Toxic Spikes"] : []),
      "|turn|15"
    ].join("\n"));

    const snapshot = roomToSnapshot(rooms.get("battle-gen9ou-123456789"));
    assert.equal(snapshot.opponentSide.active.status, status);
    const events = parseInferenceEvents(snapshot);
    assert.equal(events.some((event) => event.kind === "hazard_immunity" && event.species === "Greninja"), false);
    const items = ["Heavy-Duty Boots", "Choice Specs", "Life Orb"];
    assert.deepEqual(filterLiveLikelyHeldItemNames(snapshot.format, snapshot.opponentSide.active, items, {
      inferenceEvents: events
    }), items);
  });
}

test("mixed hazards retain Stealth Rock evidence without treating Toxic Spikes as damage", async () => {
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, await fs.readFile(frameUrl, "utf8"));
  applyRawFrameToRoomMap(rooms, [
    ">battle-gen9ou-123456789",
    "|-sidestart|p2: Bob|move: Toxic Spikes",
    "|-sidestart|p2: Bob|move: Stealth Rock",
    "|switch|p2a: Greninja|Greninja, L100|100/100",
    "|turn|15"
  ].join("\n"));

  const snapshot = roomToSnapshot(rooms.get("battle-gen9ou-123456789"));
  const events = parseInferenceEvents(snapshot);
  const immunity = events.find((event) => event.kind === "hazard_immunity" && event.species === "Greninja");
  assert.ok(immunity && immunity.kind === "hazard_immunity");
  assert.deepEqual(immunity.hazards, ["Stealth Rock"]);
  assert.deepEqual(filterLiveLikelyHeldItemNames(snapshot.format, snapshot.opponentSide.active,
    ["Heavy-Duty Boots", "Safety Goggles", "Choice Specs"], { inferenceEvents: events }), ["Heavy-Duty Boots"]);
});

test("hazard evidence uses entry-time hazards and raw damage, retaining observation references", async () => {
  const rooms = new Map();
  applyRawFrameToRoomMap(rooms, await fs.readFile(frameUrl, "utf8"));
  const apply = (lines: string[], id: string) => applyRawFrameToRoomMap(rooms, `>battle-gen9ou-123456789\n${lines.join("\n")}`, { observationId: id });
  const snapshot = () => roomToSnapshot(rooms.get("battle-gen9ou-123456789"));
  const immunities = () => parseInferenceEvents(snapshot()).filter((event) => event.kind === "hazard_immunity" && event.species === "Greninja");
  apply(["|switch|p2a: Greninja|Greninja, L100|100/100", "|-sidestart|p2: Bob|Stealth Rock", "|turn|15"], "before-hazards");
  assert.equal(immunities().length, 0);
  apply(["|switch|p2a: Greninja|Greninja, L100|100/100"], "entry-through-rocks");
  assert.equal(immunities().length, 0, "an incomplete protocol interval cannot prove no damage");
  apply(["|turn|16", "|-sideend|p2: Bob|Stealth Rock", "|switch|p2a: Greninja|Greninja, L100|100/100", "|turn|17"], "removed-hazards");
  const evidence = immunities();
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0]!.observationIds, ["entry-through-rocks#1", "removed-hazards#1"]);
  apply(["|-sidestart|p2: Bob|Stealth Rock", "|switch|p2a: Greninja|Greninja, L100|100/100", "|-damage|p2a: Greninja|80/100", "|turn|18"], "untagged-damage");
  assert.equal(immunities().length, 1, "untagged HP damage must prevent a second immunity conclusion");
  // The old text projection no longer participates in this evidence.
  const withoutTrace = { ...snapshot(), entryObservations: undefined, recentLog: ["Greninja entered the field.", "Turn 18 started."] };
  assert.equal(parseInferenceEvents(withoutTrace).some((event) => event.kind === "hazard_immunity"), false);
});

test("unrevealed immunity abilities and live Flying types prevent false Boots certainty", async () => {
  for (const [species, hazard] of [["Clefable", "Stealth Rock"], ["Noivern", "Spikes"], ["Rotom-Wash", "Spikes"]]) {
    const rooms = new Map();
    applyRawFrameToRoomMap(rooms, await fs.readFile(frameUrl, "utf8"));
    applyRawFrameToRoomMap(rooms, `>battle-gen9ou-123456789\n|-sidestart|p2: Bob|${hazard}\n|switch|p2a: ${species}|${species}, L100|100/100\n|turn|15`);
    const snapshot = roomToSnapshot(rooms.get("battle-gen9ou-123456789"));
    const events = parseInferenceEvents(snapshot);
    const items = ["Heavy-Duty Boots", "Choice Specs", "Life Orb"];
    assert.deepEqual(filterLiveLikelyHeldItemNames(snapshot.format, snapshot.opponentSide.active, items, { inferenceEvents: events }), items, species);
  }
});

test("side-correct canonical prose remains presentation only for inference", async () => {
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  const roomId = "battle-gen9ou-side-presentation";
  const request = { rqid: 1, side: { id: "p1", pokemon: [{ ident: "p1: Pecharunt", details: "Pecharunt", condition: "100/100", active: true, moves: ["shadowball"] }] } };
  const result = await new DecisionEngine().ingest({ roomId, sessionId: "sanitized", sequence: 1, observationId: "sanitized", source: "protocol",
    data: `>${roomId}\n|tier|[Gen 9] OU\n|poke|p1|Pecharunt\n|poke|p2|Mandibuzz\n|start\n|switch|p1a: Pecharunt|Pecharunt|100/100\n|switch|p2a: Mandibuzz|Mandibuzz|100/100\n|request|${JSON.stringify(request)}\n|move|p2a: Mandibuzz|Defog|p1a: Pecharunt\n|move|p1a: Pecharunt|Tackle|p2a: Mandibuzz\n|-damage|p1a: Pecharunt|84/100|[from] item: Rocky Helmet|[of] p2a: Mandibuzz` });
  const snapshot = result.snapshot!;
  assert.ok(snapshot.recentLog.includes("Mandibuzz used Defog."));
  const events = parseInferenceEvents(snapshot);
  assert.ok(events.some((event) => event.kind === "contact_recoil" && event.species === "Mandibuzz"));
  for (const recentLog of [[], ["Pecharunt used Defog.", "Pecharunt had HP change from Leftovers."]]) {
    assert.deepEqual(parseInferenceEvents({ ...snapshot, recentLog }), events);
  }
});
