import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BattleSnapshot, DamageAssumptionBand, OpponentPosteriorPreview, PokemonSnapshot } from "../types.js";

const storePath = path.join(os.tmpdir(), `shwdn2op-local-intel-${process.pid}-${Date.now()}.json`);
const externalCuratedStorePath = path.join(os.tmpdir(), `shwdn2op-external-curated-${process.pid}-${Date.now()}.json`);
process.env.LOCAL_INTEL_STORE_PATH = storePath;
process.env.EXTERNAL_CURATED_STORE_PATH = externalCuratedStorePath;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");

const { buildLocalIntelSnapshot, updateLocalIntelFromSnapshot, importExternalCuratedTeamPriors } = await import("../history/opponentIntelStore.js");
const { buildOpponentPosterior } = await import("../inference/posterior.js");
const { filterLiveLikelyHeldItemEntries, filterLiveLikelyHeldItemNames } = await import("../mechanics/liveLikelyItems.js");
const { buildDamagePreview, buildThreatPreview } = await import("../prompting/damageNotes.js");
const { buildAnalysisPrompt } = await import("../prompting/analysisPrompt.js");
const { buildGeminiPrompt } = await import("../providers/geminiProvider.js");
const { buildSelfActionRecommendation, selectReplyAwareSearchActionIds, weightedOpponentReplies } = await import("../prediction/selfActionRecommender.js");
const { buildPlayerLeadRecommendation } = await import("../prediction/playerLeadPredictor.js");

async function loadExampleJson(relativePath: string) {
  return JSON.parse(await fs.readFile(path.resolve(repoRoot, relativePath), "utf8"));
}

async function readLocalIntelStore() {
  return JSON.parse(await fs.readFile(storePath, "utf8"));
}

function makePokemon(overrides: Partial<PokemonSnapshot> = {}): PokemonSnapshot {
  return {
    ident: "p1a: Testmon",
    species: "Scizor",
    displayName: "Scizor",
    level: 100,
    conditionText: "100/100",
    hpPercent: 100,
    status: null,
    fainted: false,
    active: false,
    revealed: true,
    boosts: {},
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    knownMoves: [],
    item: null,
    removedItem: null,
    ability: null,
    types: ["Bug", "Steel"],
    teraType: null,
    terastallized: false,
    ...overrides
  } as PokemonSnapshot;
}

function findLikelyBand(bands: DamageAssumptionBand[] | undefined) {
  return Array.isArray(bands) ? bands.find((band) => band.label === "likely") ?? bands[0] : undefined;
}

function makeSnapshot(overrides: Partial<BattleSnapshot> = {}): BattleSnapshot {
  const yourActive = makePokemon({
    ident: "p1a: Scizor",
    species: "Scizor",
    displayName: "Scizor",
    active: true,
    knownMoves: ["Bullet Punch", "U-turn", "Swords Dance", "Roost"],
    item: "Choice Band",
    ability: "Technician",
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
  });
  const yourSwitch = makePokemon({
    ident: "p1b: Weavile",
    species: "Weavile",
    displayName: "Weavile",
    stats: { hp: 281, atk: 339, def: 166, spa: 126, spd: 206, spe: 383 }
  });
  const opponentActive = makePokemon({
    ident: "p2a: Noivern",
    species: "Noivern",
    displayName: "Noivern",
    active: true,
    stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
    types: ["Flying", "Dragon"]
  });

  return {
    version: "0.1.0",
    capturedAt: new Date().toISOString(),
    roomId: "battle-test-1",
    title: "Test Battle",
    format: "[Gen 9] UU",
    turn: 5,
    phase: "turn" as const,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourActive,
      team: [yourActive, yourSwitch]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentActive,
      team: [opponentActive]
    },
    field: {
      weather: null,
      terrain: null,
      pseudoWeather: [],
      yourSideConditions: [],
      opponentSideConditions: []
    },
    legalActions: [
      { id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" },
      { id: "move:uturn", kind: "move", label: "U-turn", moveName: "U-turn" }
    ],
    recentLog: [],
    rawRequestSummary: {},
    notes: [],
    ...overrides
  } as BattleSnapshot;
}

test.after(async () => {
  await fs.rm(storePath, { force: true });
  await fs.rm(externalCuratedStorePath, { force: true });
});

test("suppresses likely other moves when four moves are already known", async () => {
  const snapshot = makeSnapshot({
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Slowking",
        species: "Slowking",
        displayName: "Slowking",
        active: true,
        knownMoves: ["Scald", "Future Sight", "Slack Off", "Chilly Reception"],
        stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
        types: ["Water", "Psychic"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Slowking",
          species: "Slowking",
          displayName: "Slowking",
          active: true,
          knownMoves: ["Scald", "Future Sight", "Slack Off", "Chilly Reception"],
          stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
          types: ["Water", "Psychic"]
        })
      ]
    }
  });

  await updateLocalIntelFromSnapshot(snapshot);
  const intel = await buildLocalIntelSnapshot(snapshot);
  assert.equal(intel.opponents[0]?.likelyMoves.length, 0);
});

test("learnset fallback likely moves stay advisory and out of threat preview", async () => {
  const opponentSkarmory = makePokemon({
    ident: "p2a: Skarmory-fallback",
    species: "Skarmory",
    displayName: "Skarmory",
    active: true,
    hpPercent: 76,
    knownMoves: ["Spikes", "Roost"],
    stats: { hp: 334, atk: 176, def: 416, spa: 136, spd: 176, spe: 176 },
    types: ["Steel", "Flying"]
  });
  const yourClodsire = makePokemon({
    ident: "p1a: Clodsire-fallback",
    species: "Clodsire",
    displayName: "Clodsire",
    active: true,
    knownMoves: ["Earthquake"],
    stats: { hp: 394, atk: 186, def: 236, spa: 126, spd: 236, spe: 96 },
    types: ["Poison", "Ground"]
  });
  const snapshot = makeSnapshot({
    roomId: "battle-fallback-likely-moves",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourClodsire,
      team: [yourClodsire]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentSkarmory,
      team: [opponentSkarmory]
    },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  assert.ok((intel.opponents[0]?.likelyMoves.length ?? 0) > 0);
  assert.ok((intel.opponents[0]?.likelyMoves ?? []).every((entry) => entry.sampleCount === 0 && entry.confidenceTier === "thin"));
  assert.equal((intel.opponentThreatPreview ?? []).length, 0);
  assert.equal(intel.opponentActionPrediction?.topActionClass, "status_or_setup");
});

test("suppresses likely item ability and tera once already revealed", async () => {
  const prior = makeSnapshot({
    roomId: "battle-test-2-prior",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Skarmory",
        species: "Skarmory",
        displayName: "Skarmory",
        active: true,
        item: "Rocky Helmet",
        ability: "Sturdy",
        teraType: "Ghost",
        terastallized: true,
        types: ["Steel", "Flying"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Skarmory",
          species: "Skarmory",
          displayName: "Skarmory",
          active: true,
          item: "Rocky Helmet",
          ability: "Sturdy",
          teraType: "Ghost",
          terastallized: true,
          types: ["Steel", "Flying"]
        })
      ]
    }
  });
  await updateLocalIntelFromSnapshot(prior);
  const current = makeSnapshot({
    roomId: "battle-test-2-current",
    opponentSide: prior.opponentSide
  });
  const intel = await buildLocalIntelSnapshot(current);
  assert.deepEqual(intel.opponents[0]?.likelyItems ?? [], []);
  assert.deepEqual(intel.opponents[0]?.likelyAbilities ?? [], []);
  assert.deepEqual(intel.opponents[0]?.likelyTeraTypes ?? [], []);
});

test("likelihood entries include sample count and confidence tier", async () => {
  const prior = makeSnapshot({
    roomId: "battle-likelihood-confidence",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Slowking",
        species: "Slowking",
        displayName: "Slowking",
        active: true,
        knownMoves: ["Scald"],
        item: "Heavy-Duty Boots",
        ability: "Regenerator",
        stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
        types: ["Water", "Psychic"]
      }),
      team: [makePokemon({
        ident: "p2a: Slowking",
        species: "Slowking",
        displayName: "Slowking",
        active: true,
        knownMoves: ["Scald"],
        item: "Heavy-Duty Boots",
        ability: "Regenerator",
        stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
        types: ["Water", "Psychic"]
      })]
    }
  });

  await updateLocalIntelFromSnapshot(prior);
  const current = makeSnapshot({
    roomId: "battle-likelihood-confidence-current",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Slowking",
        species: "Slowking",
        displayName: "Slowking",
        active: true,
        knownMoves: ["Scald"],
        item: null,
        ability: null,
        stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
        types: ["Water", "Psychic"]
      }),
      team: [makePokemon({
        ident: "p2a: Slowking",
        species: "Slowking",
        displayName: "Slowking",
        active: true,
        knownMoves: ["Scald"],
        item: null,
        ability: null,
        stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
        types: ["Water", "Psychic"]
      })]
    }
  });
  const intel = await buildLocalIntelSnapshot(current);
  const likelyItem = intel.opponents[0]?.likelyItems[0];
  assert.ok((likelyItem?.sampleCount ?? 0) >= 1);
  assert.equal(likelyItem?.confidenceTier, "thin");
});

test("imported external curated teams inform priors without pretending to be observed battles", async () => {
  await importExternalCuratedTeamPriors({
    format: "[Gen 9] UU",
    formatId: "gen9uu",
    sourceUrl: "https://data.pkmn.cc/teams/gen9uu.json",
    teams: [
      {
        data: [
          {
            species: "Hydrapple",
            item: "Heavy-Duty Boots",
            ability: "Regenerator",
            teraType: "Steel",
            moves: ["Draco Meteor", "Earth Power", "Giga Drain", "Nasty Plot"]
          }
        ]
      },
      {
        data: [
          {
            species: "Hydrapple",
            item: "Choice Specs",
            ability: "Regenerator",
            teraType: "Fairy",
            moves: ["Draco Meteor", "Earth Power", "Leaf Storm", "Giga Drain"]
          }
        ]
      }
    ]
  });

  const opponent = makePokemon({
    ident: "p2a: Hydrapple",
    species: "Hydrapple",
    displayName: "Hydrapple",
    active: true,
    knownMoves: [],
    item: null,
    ability: null,
    teraType: null,
    stats: { hp: 384, atk: 186, def: 284, spa: 256, spd: 196, spe: 106 },
    types: ["Grass", "Dragon"]
  });
  const snapshot = makeSnapshot({
    roomId: "battle-sample-team-priors",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponent,
      team: [opponent]
    }
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const hydrapple = intel.opponents[0];

  assert.equal(hydrapple?.battlesSeen, 0);
  assert.equal(hydrapple?.curatedTeamCount, 2);
  assert.equal(hydrapple?.externalCurated?.teamCount, 2);
  assert.equal(hydrapple?.externalCurated?.effectiveConfidenceSamples, 0.7);
  assert.equal(hydrapple?.blendedPriorCount, 0.7);
  assert.equal(hydrapple?.likelyItems[0]?.sampleCount, 2);
  assert.equal(hydrapple?.likelyItems[0]?.confidenceTier, "thin");
  assert.equal(hydrapple?.posterior?.evidence[0]?.kind, "priors");
  assert.match(hydrapple?.posterior?.evidence[0]?.label ?? "", /imported sample team/i);
});

test("imported sample teams raise prior coverage without promoting confidence as fast as observed battles", async () => {
  await fs.writeFile(storePath, JSON.stringify({
    version: "0.1.0",
    updatedAt: new Date().toISOString(),
    species: {
      slowking: {
        species: "Slowking",
        formats: {
          "[Gen 9] UU": {
            battlesSeen: 5,
            leadCount: 0,
            moves: {
              "Chilly Reception": 3,
              "Future Sight": 3,
              "Scald": 2,
              "Slack Off": 2
            },
            items: {},
            abilities: {},
            teraTypes: {
              Bug: 1
            },
            observedDamage: {},
            observedTakenDamage: {},
            observedDamageByContext: {},
            observedTakenDamageByContext: {},
            speedFirstVs: {},
            speedSecondVs: {},
            speedFasterThan: {},
            speedSlowerThan: {}
          }
        }
      }
    },
    battles: {},
    externalCurated: {
      species: {},
      imports: {}
    }
  }, null, 2));

  await importExternalCuratedTeamPriors({
    format: "[Gen 9] UU",
    formatId: "gen9uu",
    sourceUrl: "https://data.pkmn.cc/teams/gen9uu.json",
    teams: Array.from({ length: 8 }, () => ({
      data: [
        {
          species: "Slowking",
          item: "Heavy-Duty Boots",
          ability: "Regenerator",
          teraType: "Fairy",
          moves: ["Scald", "Chilly Reception", "Slack Off", "Thunder Wave"]
        }
      ]
    }))
  });

  const opponent = makePokemon({
    ident: "p2a: Slowking",
    species: "Slowking",
    displayName: "Slowking",
    active: true,
    knownMoves: [],
    item: null,
    ability: null,
    teraType: null,
    stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
    types: ["Water", "Psychic"]
  });
  const snapshot = makeSnapshot({
    roomId: "battle-sample-team-confidence",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponent,
      team: [opponent]
    }
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const slowking = intel.opponents[0];

  assert.equal(slowking?.battlesSeen, 5);
  assert.equal(slowking?.curatedTeamCount, 8);
  assert.equal(slowking?.externalCurated?.teamCount, 8);
  assert.equal(slowking?.externalCurated?.effectiveConfidenceSamples, 7.8);
  assert.equal(slowking?.blendedPriorCount, 7.8);
  assert.equal(slowking?.likelyItems[0]?.sampleCount, 13);
  assert.equal(slowking?.likelyItems[0]?.name, "Heavy-Duty Boots");
  assert.equal(slowking?.likelyItems[0]?.confidenceTier, "usable");
  assert.equal(slowking?.likelyAbilities[0]?.name, "Regenerator");
  assert.equal(slowking?.likelyAbilities[0]?.confidenceTier, "usable");
});

test("damage preview keeps uncapped max damage and current hp coverage separate", () => {
  const snapshot = makeSnapshot({
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Noivern",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        hpPercent: 45,
        stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
        types: ["Flying", "Dragon"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Noivern",
          species: "Noivern",
          displayName: "Noivern",
          active: true,
          hpPercent: 45,
          stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
          types: ["Flying", "Dragon"]
        })
      ]
    }
  });
  const preview = buildDamagePreview(snapshot);
  const bulletPunch = preview.find((entry) => entry.moveName === "Bullet Punch");
  assert.ok(bulletPunch);
  const likelyBand = bulletPunch?.bands.find((band) => band.label === "likely");
  assert.ok(likelyBand);
  assert.notEqual(likelyBand?.maxPercent, 55);
  assert.equal(likelyBand?.coverage, "can_cover_current_hp");
});

test("damage preview emits sturdy and focus sash caveats", () => {
  const sturdySnapshot = makeSnapshot({
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Skarmory",
        species: "Skarmory",
        displayName: "Skarmory",
        active: true,
        ability: "Sturdy",
        hpPercent: 100,
        types: ["Steel", "Flying"]
      }),
      team: [makePokemon({ ident: "p2a: Skarmory", species: "Skarmory", displayName: "Skarmory", active: true, ability: "Sturdy", hpPercent: 100, types: ["Steel", "Flying"] })]
    }
  });
  const sturdyPreview = buildDamagePreview(sturdySnapshot);
  assert.ok(sturdyPreview.some((entry) => entry.survivalCaveats.some((caveat) => caveat.kind === "Sturdy")));

  const sashPreview = buildDamagePreview(makeSnapshot(), { likelyDefenderItems: ["Focus Sash"] });
  assert.ok(sashPreview.some((entry) => entry.survivalCaveats.some((caveat) => caveat.kind === "Focus Sash")));
});

test("damage preview accounts for burn and attack boosts on physical moves", () => {
  const yourDragonite = makePokemon({
    ident: "p1a: Dragonite-burn",
    species: "Dragonite",
    displayName: "Dragonite",
    active: true,
    knownMoves: ["Earthquake"],
    stats: { hp: 323, atk: 403, def: 226, spa: 236, spd: 236, spe: 259 },
    types: ["Dragon", "Flying"]
  });
  const opponentEmpoleon = makePokemon({
    ident: "p2a: Empoleon-burn",
    species: "Empoleon",
    displayName: "Empoleon",
    active: true,
    stats: { hp: 311, atk: 198, def: 238, spa: 339, spd: 247, spe: 196 },
    types: ["Water", "Steel"]
  });

  const baseSnapshot = makeSnapshot({
    roomId: "battle-damage-burn-boost",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourDragonite,
      team: [yourDragonite]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentEmpoleon,
      team: [opponentEmpoleon]
    },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }]
  });

  const baseBand = findLikelyBand(buildDamagePreview(baseSnapshot)[0]?.bands);
  const burnedBand = findLikelyBand(buildDamagePreview({
    ...baseSnapshot,
    yourSide: {
      ...baseSnapshot.yourSide,
      active: { ...yourDragonite, status: "brn" },
      team: [{ ...yourDragonite, status: "brn" }]
    }
  })[0]?.bands);
  const boostedBand = findLikelyBand(buildDamagePreview({
    ...baseSnapshot,
    yourSide: {
      ...baseSnapshot.yourSide,
      active: { ...yourDragonite, boosts: { atk: 2 } },
      team: [{ ...yourDragonite, boosts: { atk: 2 } }]
    }
  })[0]?.bands);

  assert.ok(Number(baseBand?.minPercent ?? 0) > 0);
  assert.ok(Number(burnedBand?.maxPercent ?? 0) < Number(baseBand?.maxPercent ?? 0));
  assert.ok(Number(boostedBand?.minPercent ?? 0) > Number(baseBand?.minPercent ?? 0));
});

test("damage preview handles multi-hit moves without inflating the total range", () => {
  const yourDragonite = makePokemon({
    ident: "p1a: Dragonite-multihit",
    species: "Dragonite",
    displayName: "Dragonite",
    active: true,
    knownMoves: ["Dual Wingbeat"],
    stats: { hp: 323, atk: 403, def: 226, spa: 236, spd: 236, spe: 259 },
    types: ["Dragon", "Flying"]
  });
  const opponentBreloom = makePokemon({
    ident: "p2a: Breloom-multihit",
    species: "Breloom",
    displayName: "Breloom",
    active: true,
    stats: { hp: 261, atk: 359, def: 156, spa: 156, spd: 156, spe: 262 },
    types: ["Grass", "Fighting"]
  });

  const preview = buildDamagePreview(makeSnapshot({
    roomId: "battle-damage-multihit",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourDragonite,
      team: [yourDragonite]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentBreloom,
      team: [opponentBreloom]
    },
    legalActions: [{ id: "move:dualwingbeat", kind: "move", label: "Dual Wingbeat", moveName: "Dual Wingbeat" }]
  }));

  const likelyBand = findLikelyBand(preview[0]?.bands);
  assert.ok(Number(likelyBand?.minPercent ?? 0) > 150);
  assert.ok(Number(likelyBand?.maxPercent ?? 0) < 400);
});

test("damage preview respects revealed abilities like Levitate", () => {
  const snapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Clodsire",
        species: "Clodsire",
        displayName: "Clodsire",
        active: true,
        knownMoves: ["Earthquake"],
        stats: { hp: 394, atk: 186, def: 236, spa: 126, spd: 236, spe: 96 },
        types: ["Poison", "Ground"]
      }),
      team: [
        makePokemon({
          ident: "p1a: Clodsire",
          species: "Clodsire",
          displayName: "Clodsire",
          active: true,
          knownMoves: ["Earthquake"],
          stats: { hp: 394, atk: 186, def: 236, spa: 126, spd: 236, spe: 96 },
          types: ["Poison", "Ground"]
        })
      ]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Rotom-Wash",
        species: "Rotom-Wash",
        displayName: "Rotom-Wash",
        active: true,
        ability: "Levitate",
        stats: { hp: 304, atk: 166, def: 250, spa: 233, spd: 250, spe: 218 },
        types: ["Electric", "Water"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Rotom-Wash",
          species: "Rotom-Wash",
          displayName: "Rotom-Wash",
          active: true,
          ability: "Levitate",
          stats: { hp: 304, atk: 166, def: 250, spa: 233, spd: 250, spe: 218 },
          types: ["Electric", "Water"]
        })
      ]
    },
    legalActions: [
      { id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }
    ]
  });
  const preview = buildDamagePreview(snapshot);
  const earthquake = preview.find((entry) => entry.moveName === "Earthquake");
  assert.ok(earthquake);
  assert.equal(earthquake?.bands.length, 1);
  assert.equal(earthquake?.bands[0]?.outcome, "immune");
  assert.match(earthquake?.bands[0]?.detail ?? "", /levitate/i);
  assert.equal(earthquake?.bands[0]?.maxPercent, 0);
});

test("damage preview ignores a removed Air Balloon even if stale item priors still suggest it", () => {
  const snapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Donphan",
        species: "Donphan",
        displayName: "Donphan",
        active: true,
        knownMoves: ["Earthquake"],
        item: "Choice Band",
        ability: "Sturdy",
        stats: { hp: 384, atk: 372, def: 276, spa: 140, spd: 156, spe: 176 },
        types: ["Ground"]
      }),
      team: [
        makePokemon({
          ident: "p1a: Donphan",
          species: "Donphan",
          displayName: "Donphan",
          active: true,
          knownMoves: ["Earthquake"],
          item: "Choice Band",
          ability: "Sturdy",
          stats: { hp: 384, atk: 372, def: 276, spa: 140, spd: 156, spe: 176 },
          types: ["Ground"]
        })
      ]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Excadrill",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        item: null,
        removedItem: "Air Balloon",
        ability: "Mold Breaker",
        hpPercent: 100,
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Excadrill",
          species: "Excadrill",
          displayName: "Excadrill",
          active: true,
          item: null,
          removedItem: "Air Balloon",
          ability: "Mold Breaker",
          hpPercent: 100,
          stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
          types: ["Ground", "Steel"]
        })
      ]
    },
    legalActions: [
      { id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }
    ]
  });

  const preview = buildDamagePreview(snapshot, {
    likelyDefenderItems: ["Air Balloon"]
  });
  const earthquake = preview.find((entry) => entry.moveName === "Earthquake");
  const likelyBand = findLikelyBand(earthquake?.bands);
  assert.ok(earthquake);
  assert.notEqual(likelyBand?.outcome, "immune");
  assert.ok(Number(likelyBand?.maxPercent ?? 0) > 0);
});

test("posterior damage preview ignores removed items on the live board", () => {
  const snapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Donphan-posterior",
        species: "Donphan",
        displayName: "Donphan",
        active: true,
        knownMoves: ["Earthquake"],
        item: "Choice Band",
        ability: "Sturdy",
        stats: { hp: 384, atk: 372, def: 276, spa: 140, spd: 156, spe: 176 },
        types: ["Ground"]
      }),
      team: [
        makePokemon({
          ident: "p1a: Donphan-posterior",
          species: "Donphan",
          displayName: "Donphan",
          active: true,
          knownMoves: ["Earthquake"],
          item: "Choice Band",
          ability: "Sturdy",
          stats: { hp: 384, atk: 372, def: 276, spa: 140, spd: 156, spe: 176 },
          types: ["Ground"]
        })
      ]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Excadrill-posterior",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        item: null,
        removedItem: "Air Balloon",
        hpPercent: 100,
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Excadrill-posterior",
          species: "Excadrill",
          displayName: "Excadrill",
          active: true,
          item: null,
          removedItem: "Air Balloon",
          hpPercent: 100,
          stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
          types: ["Ground", "Steel"]
        })
      ]
    },
    legalActions: [
      { id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }
    ]
  });
  const defenderPosterior: OpponentPosteriorPreview = {
    confidenceTier: "usable",
    evidenceKinds: ["priors", "reveals"],
    evidence: [],
    usedFallback: false,
    statBands: [],
    topHypotheses: [
      {
        ability: "Mold Breaker",
        item: "Air Balloon",
        teraType: null,
        statArchetype: "fast_phys",
        weight: 0.82,
        nature: "Jolly",
        evs: { hp: 4, atk: 252, spe: 252 },
        effectiveSpeed: 302,
        support: ["stale item prior"]
      }
    ]
  };

  const preview = buildDamagePreview(snapshot, { defenderPosterior });
  const earthquake = preview.find((entry) => entry.moveName === "Earthquake");
  const likelyBand = findLikelyBand(earthquake?.bands);
  assert.ok(earthquake);
  assert.equal(earthquake?.likelyBandSource, "posterior");
  assert.notEqual(likelyBand?.outcome, "immune");
  assert.ok(Number(likelyBand?.maxPercent ?? 0) > 0);
});

test("local intel does not turn a top historical item into a hard immunity fact", async () => {
  await fs.writeFile(storePath, JSON.stringify({
    version: "0.1.0",
    updatedAt: new Date().toISOString(),
    species: {
      excadrill: {
        species: "Excadrill",
        formats: {
          "[Gen 9] UU": {
            battlesSeen: 10,
            leadCount: 0,
            moves: { "Earthquake": 6, "Stealth Rock": 3 },
            items: { "Air Balloon": 1, "Life Orb": 1, "Focus Sash": 1 },
            abilities: { "Mold Breaker": 10 },
            teraTypes: { "Ground": 1 },
            observedDamage: {},
            observedTakenDamage: {},
            observedDamageByContext: {},
            observedTakenDamageByContext: {},
            speedFirstVs: {},
            speedSecondVs: {},
            speedFasterThan: {},
            speedSlowerThan: {}
          }
        }
      }
    },
    battles: {}
  }, null, 2));

  const snapshot = makeSnapshot({
    turn: 34,
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Donphan-live-intel",
        species: "Donphan",
        displayName: "Donphan",
        active: true,
        knownMoves: ["Earthquake"],
        item: null,
        removedItem: "Leftovers",
        ability: "Sturdy",
        boosts: { spe: 2 },
        hpPercent: 43.1,
        stats: { hp: 383, atk: 308, def: 332, spa: 140, spd: 156, spe: 141 },
        types: ["Ground"]
      }),
      team: [
        makePokemon({
          ident: "p1a: Donphan-live-intel",
          species: "Donphan",
          displayName: "Donphan",
          active: true,
          knownMoves: ["Earthquake"],
          item: null,
          removedItem: "Leftovers",
          ability: "Sturdy",
          boosts: { spe: 2 },
          hpPercent: 43.1,
          stats: { hp: 383, atk: 308, def: 332, spa: 140, spd: 156, spe: 141 },
          types: ["Ground"]
        })
      ]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Excadrill-live-intel",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        hpPercent: 98,
        ability: "Mold Breaker",
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Excadrill-live-intel",
          species: "Excadrill",
          displayName: "Excadrill",
          active: true,
          hpPercent: 98,
          ability: "Mold Breaker",
          stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
          types: ["Ground", "Steel"]
        })
      ]
    },
    legalActions: [
      { id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const earthquake = intel.playerDamagePreview?.find((entry) => entry.moveName === "Earthquake");
  const likelyBand = findLikelyBand(earthquake?.bands);
  assert.ok(intel.opponents.find((entry) => entry.species === "Excadrill")?.likelyItems.some((item) => item.name === "Air Balloon"));
  assert.ok(earthquake);
  assert.notEqual(likelyBand?.outcome, "immune");
  assert.ok(Number(likelyBand?.maxPercent ?? 0) > 0);

  await fs.writeFile(storePath, JSON.stringify({
    version: "0.1.0",
    updatedAt: new Date().toISOString(),
    species: {},
    battles: {}
  }, null, 2));
});

test("damage preview respects absorb and immunity abilities", () => {
  const waterAbsorb = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Primarina",
        species: "Primarina",
        displayName: "Primarina",
        active: true,
        knownMoves: ["Hydro Pump"],
        stats: { hp: 364, atk: 146, def: 185, spa: 394, spd: 266, spe: 196 },
        types: ["Water", "Fairy"]
      }),
      team: [makePokemon({
        ident: "p1a: Primarina",
        species: "Primarina",
        displayName: "Primarina",
        active: true,
        knownMoves: ["Hydro Pump"],
        stats: { hp: 364, atk: 146, def: 185, spa: 394, spd: 266, spe: 196 },
        types: ["Water", "Fairy"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Vaporeon",
        species: "Vaporeon",
        displayName: "Vaporeon",
        active: true,
        ability: "Water Absorb",
        stats: { hp: 464, atk: 166, def: 156, spa: 256, spd: 226, spe: 166 },
        types: ["Water"]
      }),
      team: [makePokemon({
        ident: "p2a: Vaporeon",
        species: "Vaporeon",
        displayName: "Vaporeon",
        active: true,
        ability: "Water Absorb",
        stats: { hp: 464, atk: 166, def: 156, spa: 256, spd: 226, spe: 166 },
        types: ["Water"]
      })]
    },
    legalActions: [{ id: "move:hydropump", kind: "move", label: "Hydro Pump", moveName: "Hydro Pump" }]
  });
  const hydro = buildDamagePreview(waterAbsorb)[0];
  assert.equal(hydro?.bands.length, 1);
  assert.equal(hydro?.bands[0]?.outcome, "immune");
  assert.match(hydro?.bands[0]?.detail ?? "", /water absorb/i);
  assert.equal(hydro?.bands[0]?.maxPercent, 0);

  const flashFire = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Arcanine-Hisui",
        species: "Arcanine-Hisui",
        displayName: "Arcanine-Hisui",
        active: true,
        knownMoves: ["Flare Blitz"],
        stats: { hp: 341, atk: 361, def: 196, spa: 212, spd: 196, spe: 251 },
        types: ["Fire", "Rock"]
      }),
      team: [makePokemon({
        ident: "p1a: Arcanine-Hisui",
        species: "Arcanine-Hisui",
        displayName: "Arcanine-Hisui",
        active: true,
        knownMoves: ["Flare Blitz"],
        stats: { hp: 341, atk: 361, def: 196, spa: 212, spd: 196, spe: 251 },
        types: ["Fire", "Rock"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Chandelure",
        species: "Chandelure",
        displayName: "Chandelure",
        active: true,
        ability: "Flash Fire",
        stats: { hp: 261, atk: 146, def: 216, spa: 427, spd: 216, spe: 284 },
        types: ["Ghost", "Fire"]
      }),
      team: [makePokemon({
        ident: "p2a: Chandelure",
        species: "Chandelure",
        displayName: "Chandelure",
        active: true,
        ability: "Flash Fire",
        stats: { hp: 261, atk: 146, def: 216, spa: 427, spd: 216, spe: 284 },
        types: ["Ghost", "Fire"]
      })]
    },
    legalActions: [{ id: "move:flareblitz", kind: "move", label: "Flare Blitz", moveName: "Flare Blitz" }]
  });
  const flareBlitz = buildDamagePreview(flashFire)[0];
  assert.equal(flareBlitz?.bands.length, 1);
  assert.equal(flareBlitz?.bands[0]?.outcome, "immune");
  assert.match(flareBlitz?.bands[0]?.detail ?? "", /flash fire/i);
  assert.equal(flareBlitz?.bands[0]?.maxPercent, 0);
});

test("damage preview reflects defensive abilities like Thick Fat and Unaware", () => {
  const baseFire = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Infernape",
        species: "Infernape",
        displayName: "Infernape",
        active: true,
        knownMoves: ["Flamethrower"],
        stats: { hp: 293, atk: 307, def: 178, spa: 307, spd: 178, spe: 346 },
        types: ["Fire", "Fighting"]
      }),
      team: [makePokemon({
        ident: "p1a: Infernape",
        species: "Infernape",
        displayName: "Infernape",
        active: true,
        knownMoves: ["Flamethrower"],
        stats: { hp: 293, atk: 307, def: 178, spa: 307, spd: 178, spe: 346 },
        types: ["Fire", "Fighting"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Mamoswine",
        species: "Mamoswine",
        displayName: "Mamoswine",
        active: true,
        stats: { hp: 361, atk: 394, def: 196, spa: 176, spd: 156, spe: 284 },
        types: ["Ice", "Ground"]
      }),
      team: [makePokemon({
        ident: "p2a: Mamoswine",
        species: "Mamoswine",
        displayName: "Mamoswine",
        active: true,
        stats: { hp: 361, atk: 394, def: 196, spa: 176, spd: 156, spe: 284 },
        types: ["Ice", "Ground"]
      })]
    },
    legalActions: [{ id: "move:flamethrower", kind: "move", label: "Flamethrower", moveName: "Flamethrower" }]
  });
  const thickFat = makeSnapshot({
    ...baseFire,
    opponentSide: {
      ...baseFire.opponentSide,
      active: makePokemon({ ...baseFire.opponentSide.active, ability: "Thick Fat" }),
      team: [makePokemon({ ...baseFire.opponentSide.active, ability: "Thick Fat" })]
    }
  });
  const baseLikely = buildDamagePreview(baseFire)[0]?.bands.find((band) => band.label === "likely");
  const thickLikely = buildDamagePreview(thickFat)[0]?.bands.find((band) => band.label === "likely");
  assert.ok(baseLikely && thickLikely);
  assert.ok(Number(thickLikely.maxPercent) < Number(baseLikely.maxPercent));

  const boosted = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Garchomp",
        species: "Garchomp",
        displayName: "Garchomp",
        active: true,
        knownMoves: ["Earthquake"],
        boosts: { atk: 2 },
        stats: { hp: 357, atk: 394, def: 226, spa: 176, spd: 206, spe: 333 },
        types: ["Dragon", "Ground"]
      }),
      team: [makePokemon({
        ident: "p1a: Garchomp",
        species: "Garchomp",
        displayName: "Garchomp",
        active: true,
        knownMoves: ["Earthquake"],
        boosts: { atk: 2 },
        stats: { hp: 357, atk: 394, def: 226, spa: 176, spd: 206, spe: 333 },
        types: ["Dragon", "Ground"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Quagsire",
        species: "Quagsire",
        displayName: "Quagsire",
        active: true,
        stats: { hp: 394, atk: 206, def: 206, spa: 166, spd: 166, spe: 146 },
        types: ["Water", "Ground"]
      }),
      team: [makePokemon({
        ident: "p2a: Quagsire",
        species: "Quagsire",
        displayName: "Quagsire",
        active: true,
        stats: { hp: 394, atk: 206, def: 206, spa: 166, spd: 166, spe: 146 },
        types: ["Water", "Ground"]
      })]
    },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }]
  });
  const unaware = makeSnapshot({
    ...boosted,
    opponentSide: {
      ...boosted.opponentSide,
      active: makePokemon({ ...boosted.opponentSide.active, ability: "Unaware" }),
      team: [makePokemon({ ...boosted.opponentSide.active, ability: "Unaware" })]
    }
  });
  const boostedLikely = buildDamagePreview(boosted)[0]?.bands.find((band) => band.label === "likely");
  const unawareLikely = buildDamagePreview(unaware)[0]?.bands.find((band) => band.label === "likely");
  assert.ok(boostedLikely && unawareLikely);
  assert.ok(Number(unawareLikely.maxPercent) < Number(boostedLikely.maxPercent));
});

test("battle-shaped snapshot keeps structured damage context", async () => {
  const snapshot = await loadExampleJson("examples/battle-snapshot.gen9ou.turn14.json") as BattleSnapshot;
  const preview = buildDamagePreview(snapshot);
  assert.ok(preview.length > 0);
  assert.ok(preview.every((entry) => typeof entry.targetCurrentHpPercent === "number" || entry.targetCurrentHpPercent === null));
});

test("observed local damage history feeds threat previews", async () => {
  const before = makeSnapshot({
    roomId: "battle-observed-damage",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Noivern",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        knownMoves: ["Hurricane"],
        stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
        types: ["Flying", "Dragon"]
      }),
      team: [makePokemon({
        ident: "p2a: Noivern",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        knownMoves: ["Hurricane"],
        stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
        types: ["Flying", "Dragon"]
      })]
    },
    recentLog: ["Turn 5 started."]
  });
  const after = makeSnapshot({
    ...before,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    yourSide: {
      ...before.yourSide,
      active: makePokemon({ ...before.yourSide.active, hpPercent: 70 }),
      team: [makePokemon({ ...before.yourSide.active, hpPercent: 70 }), ...before.yourSide.team.slice(1)]
    },
    recentLog: ["Turn 5 started.", "Noivern used Hurricane."]
  });

  await updateLocalIntelFromSnapshot(before);
  await updateLocalIntelFromSnapshot(after);

  const future = makeSnapshot({
    roomId: "battle-observed-damage-future",
    opponentSide: after.opponentSide
  });
  const intel = await buildLocalIntelSnapshot(future);
  const hurricane = intel.opponentThreatPreview?.find((entry) => entry.moveName === "Hurricane");
  assert.ok(hurricane?.currentTarget.observedRange);
  assert.equal(hurricane?.currentTarget.observedRange?.sampleCount, 1);
  assert.equal(hurricane?.currentTarget.observedRange?.minPercent, 30);
  assert.equal(hurricane?.currentTarget.observedRange?.maxPercent, 30);
});

test("observed local damage history feeds player move previews", async () => {
  const before = makeSnapshot({
    roomId: "battle-observed-outgoing",
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Scizor",
        species: "Scizor",
        displayName: "Scizor",
        active: true,
        knownMoves: ["Bullet Punch"],
        item: "Choice Band",
        ability: "Technician",
        stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
      }),
      team: [makePokemon({
        ident: "p1a: Scizor",
        species: "Scizor",
        displayName: "Scizor",
        active: true,
        knownMoves: ["Bullet Punch"],
        item: "Choice Band",
        ability: "Technician",
        stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Noivern",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        hpPercent: 100,
        stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
        types: ["Flying", "Dragon"]
      }),
      team: [makePokemon({
        ident: "p2a: Noivern",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        hpPercent: 100,
        stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
        types: ["Flying", "Dragon"]
      })]
    },
    recentLog: ["Turn 6 started."],
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const after = makeSnapshot({
    ...before,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    opponentSide: {
      ...before.opponentSide,
      active: makePokemon({ ...before.opponentSide.active, hpPercent: 58 }),
      team: [makePokemon({ ...before.opponentSide.active, hpPercent: 58 })]
    },
    recentLog: ["Turn 6 started.", "Scizor used Bullet Punch."]
  });

  await updateLocalIntelFromSnapshot(before);
  await updateLocalIntelFromSnapshot(after);

  const future = makeSnapshot({
    roomId: "battle-observed-outgoing-future",
    yourSide: before.yourSide,
    opponentSide: before.opponentSide,
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const intel = await buildLocalIntelSnapshot(future);
  const bulletPunch = intel.playerDamagePreview?.find((entry) => entry.moveName === "Bullet Punch");
  assert.ok(bulletPunch?.observedRange);
  assert.equal(bulletPunch?.observedRange?.sampleCount, 1);
  assert.equal(bulletPunch?.observedRange?.minPercent, 42);
  assert.equal(bulletPunch?.observedRange?.maxPercent, 42);
  assert.equal(bulletPunch?.likelyBandSource, "context");
  const likelyBand = bulletPunch?.bands.find((band) => band.label === "likely");
  assert.equal(likelyBand?.minPercent, 42);
  assert.equal(likelyBand?.maxPercent, 42);
});

test("observed damage skips noisy windows with switches", async () => {
  const before = makeSnapshot({
    roomId: "battle-observed-noisy-switch",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Kilowattrel",
        species: "Kilowattrel",
        displayName: "Kilowattrel",
        active: true,
        knownMoves: ["Thunderbolt"],
        hpPercent: 100,
        stats: { hp: 281, atk: 176, def: 156, spa: 339, spd: 176, spe: 383 },
        types: ["Electric", "Flying"]
      }),
      team: [makePokemon({
        ident: "p2a: Kilowattrel",
        species: "Kilowattrel",
        displayName: "Kilowattrel",
        active: true,
        knownMoves: ["Thunderbolt"],
        hpPercent: 100,
        stats: { hp: 281, atk: 176, def: 156, spa: 339, spd: 176, spe: 383 },
        types: ["Electric", "Flying"]
      })]
    },
    recentLog: ["Turn 9 started."]
  });
  const after = makeSnapshot({
    ...before,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    yourSide: {
      ...before.yourSide,
      active: makePokemon({ ...before.yourSide.active, hpPercent: 70 }),
      team: [makePokemon({ ...before.yourSide.active, hpPercent: 70 }), ...before.yourSide.team.slice(1)]
    },
    recentLog: [
      "Turn 9 started.",
      "Kilowattrel used Thunderbolt.",
      "Clodsire entered the field."
    ]
  });

  await updateLocalIntelFromSnapshot(before);
  await updateLocalIntelFromSnapshot(after);

  const future = makeSnapshot({
    roomId: "battle-observed-noisy-switch-future",
    opponentSide: before.opponentSide
  });
  const intel = await buildLocalIntelSnapshot(future);
  const thunderbolt = intel.opponentThreatPreview?.find((entry) => entry.moveName === "Thunderbolt");
  assert.equal(thunderbolt?.currentTarget.observedRange, undefined);
});

test("context-matched observed damage is preferred over aggregate history", async () => {
  const baseOpponent = {
    slot: "p2",
    name: "Opponent",
    active: makePokemon({
      ident: "p2a: Noivern",
      species: "Noivern",
      displayName: "Noivern",
      active: true,
      hpPercent: 100,
      stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
      types: ["Flying", "Dragon"]
    }),
    team: [makePokemon({
      ident: "p2a: Noivern",
      species: "Noivern",
      displayName: "Noivern",
      active: true,
      hpPercent: 100,
      stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
      types: ["Flying", "Dragon"]
    })]
  };

  const bandedBefore = makeSnapshot({
    roomId: "battle-context-choice-band",
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Scizor",
        species: "Scizor",
        displayName: "Scizor",
        active: true,
        knownMoves: ["Bullet Punch"],
        item: "Choice Band",
        ability: "Technician",
        stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
      }),
      team: [makePokemon({
        ident: "p1a: Scizor",
        species: "Scizor",
        displayName: "Scizor",
        active: true,
        knownMoves: ["Bullet Punch"],
        item: "Choice Band",
        ability: "Technician",
        stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
      })]
    },
    opponentSide: baseOpponent,
    recentLog: ["Turn 7 started."],
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const bandedAfter = makeSnapshot({
    ...bandedBefore,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    opponentSide: {
      ...baseOpponent,
      active: makePokemon({ ...baseOpponent.active, hpPercent: 58 }),
      team: [makePokemon({ ...baseOpponent.active, hpPercent: 58 })]
    },
    recentLog: ["Turn 7 started.", "Scizor used Bullet Punch."]
  });

  const plainBefore = makeSnapshot({
    roomId: "battle-context-no-item",
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Scizor",
        species: "Scizor",
        displayName: "Scizor",
        active: true,
        knownMoves: ["Bullet Punch"],
        item: null,
        ability: "Technician",
        stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
      }),
      team: [makePokemon({
        ident: "p1a: Scizor",
        species: "Scizor",
        displayName: "Scizor",
        active: true,
        knownMoves: ["Bullet Punch"],
        item: null,
        ability: "Technician",
        stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
      })]
    },
    opponentSide: baseOpponent,
    recentLog: ["Turn 8 started."],
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const plainAfter = makeSnapshot({
    ...plainBefore,
    capturedAt: new Date(Date.now() + 2_000).toISOString(),
    opponentSide: {
      ...baseOpponent,
      active: makePokemon({ ...baseOpponent.active, hpPercent: 70 }),
      team: [makePokemon({ ...baseOpponent.active, hpPercent: 70 })]
    },
    recentLog: ["Turn 8 started.", "Scizor used Bullet Punch."]
  });

  await updateLocalIntelFromSnapshot(bandedBefore);
  await updateLocalIntelFromSnapshot(bandedAfter);
  await updateLocalIntelFromSnapshot(plainBefore);
  await updateLocalIntelFromSnapshot(plainAfter);

  const future = makeSnapshot({
    roomId: "battle-context-future",
    yourSide: bandedBefore.yourSide,
    opponentSide: baseOpponent,
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const intel = await buildLocalIntelSnapshot(future);
  const bulletPunch = intel.playerDamagePreview?.find((entry) => entry.moveName === "Bullet Punch");
  assert.ok(bulletPunch?.observedRange);
  assert.equal(bulletPunch?.observedRange?.source, "context");
  assert.equal(bulletPunch?.observedRange?.minPercent, 42);
  assert.equal(bulletPunch?.observedRange?.maxPercent, 42);
  assert.equal(bulletPunch?.likelyBandSource, "context");
  const likelyBand = bulletPunch?.bands.find((band) => band.label === "likely");
  assert.equal(likelyBand?.minPercent, 42);
  assert.equal(likelyBand?.maxPercent, 42);
});

test("defender context narrows observed damage history", async () => {
  const baseYourSide = {
    slot: "p1",
    name: "You",
    active: makePokemon({
      ident: "p1a: Scizor",
      species: "Scizor",
      displayName: "Scizor",
      active: true,
      knownMoves: ["Bullet Punch"],
      item: "Choice Band",
      ability: "Technician",
      stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
    }),
    team: [makePokemon({
      ident: "p1a: Scizor",
      species: "Scizor",
      displayName: "Scizor",
      active: true,
      knownMoves: ["Bullet Punch"],
      item: "Choice Band",
      ability: "Technician",
      stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
    })]
  };

  const evioliteBefore = makeSnapshot({
    roomId: "battle-defender-context-eviolite",
    yourSide: baseYourSide,
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Porygon2",
        species: "Porygon2",
        displayName: "Porygon2",
        active: true,
        item: "Eviolite",
        ability: "Download",
        hpPercent: 100,
        stats: { hp: 374, atk: 176, def: 256, spa: 246, spd: 266, spe: 156 },
        types: ["Normal"]
      }),
      team: [makePokemon({
        ident: "p2a: Porygon2",
        species: "Porygon2",
        displayName: "Porygon2",
        active: true,
        item: "Eviolite",
        ability: "Download",
        hpPercent: 100,
        stats: { hp: 374, atk: 176, def: 256, spa: 246, spd: 266, spe: 156 },
        types: ["Normal"]
      })]
    },
    recentLog: ["Turn 9 started."],
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const evioliteAfter = makeSnapshot({
    ...evioliteBefore,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    opponentSide: {
      ...evioliteBefore.opponentSide,
      active: makePokemon({ ...evioliteBefore.opponentSide.active, hpPercent: 75 }),
      team: [makePokemon({ ...evioliteBefore.opponentSide.active, hpPercent: 75 })]
    },
    recentLog: ["Turn 9 started.", "Scizor used Bullet Punch."]
  });

  const plainBefore = makeSnapshot({
    roomId: "battle-defender-context-plain",
    yourSide: baseYourSide,
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Porygon2",
        species: "Porygon2",
        displayName: "Porygon2",
        active: true,
        item: null,
        ability: "Download",
        hpPercent: 100,
        stats: { hp: 374, atk: 176, def: 256, spa: 246, spd: 266, spe: 156 },
        types: ["Normal"]
      }),
      team: [makePokemon({
        ident: "p2a: Porygon2",
        species: "Porygon2",
        displayName: "Porygon2",
        active: true,
        item: null,
        ability: "Download",
        hpPercent: 100,
        stats: { hp: 374, atk: 176, def: 256, spa: 246, spd: 266, spe: 156 },
        types: ["Normal"]
      })]
    },
    recentLog: ["Turn 10 started."],
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const plainAfter = makeSnapshot({
    ...plainBefore,
    capturedAt: new Date(Date.now() + 2_000).toISOString(),
    opponentSide: {
      ...plainBefore.opponentSide,
      active: makePokemon({ ...plainBefore.opponentSide.active, hpPercent: 60 }),
      team: [makePokemon({ ...plainBefore.opponentSide.active, hpPercent: 60 })]
    },
    recentLog: ["Turn 10 started.", "Scizor used Bullet Punch."]
  });

  await updateLocalIntelFromSnapshot(evioliteBefore);
  await updateLocalIntelFromSnapshot(evioliteAfter);
  await updateLocalIntelFromSnapshot(plainBefore);
  await updateLocalIntelFromSnapshot(plainAfter);

  const future = makeSnapshot({
    roomId: "battle-defender-context-future",
    yourSide: baseYourSide,
    opponentSide: plainBefore.opponentSide,
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const intel = await buildLocalIntelSnapshot(future);
  const bulletPunch = intel.playerDamagePreview?.find((entry) => entry.moveName === "Bullet Punch");
  assert.equal(bulletPunch?.observedRange?.source, "context");
  assert.equal(bulletPunch?.observedRange?.minPercent, 40);
  assert.equal(bulletPunch?.observedRange?.maxPercent, 40);
  assert.equal(bulletPunch?.likelyBandSource, "context");
});

test("speed preview respects trick room tailwind paralysis boosts and scarf", async () => {
  const base = makeSnapshot({
    roomId: "battle-speed-base",
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Scizor",
        species: "Scizor",
        displayName: "Scizor",
        active: true,
        stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
      }),
      team: [
        makePokemon({
          ident: "p1a: Scizor",
          species: "Scizor",
          displayName: "Scizor",
          active: true,
          stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
        })
      ]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Clodsire",
        species: "Clodsire",
        displayName: "Clodsire",
        active: true,
        stats: { hp: 394, atk: 186, def: 236, spa: 126, spd: 236, spe: 96 },
        types: ["Poison", "Ground"]
      }),
      team: [makePokemon({ ident: "p2a: Clodsire", species: "Clodsire", displayName: "Clodsire", active: true, stats: { hp: 394, atk: 186, def: 236, spa: 126, spd: 236, spe: 96 }, types: ["Poison", "Ground"] })]
    }
  });
  let intel = await buildLocalIntelSnapshot(base);
  assert.equal(intel.speedPreview?.activeRelation, "faster");
  assert.ok(Array.isArray(intel.speedPreview?.evidence));
  assert.equal(intel.speedPreview?.reason, "base_range");

  intel = await buildLocalIntelSnapshot({ ...base, field: { ...base.field, pseudoWeather: ["Trick Room"] } });
  assert.match(intel.speedPreview?.activeSummary ?? "", /Trick Room flips order/);
  assert.equal(intel.speedPreview?.reason, "confounded");
  assert.ok((intel.speedPreview?.confounders ?? []).includes("Trick Room"));

  intel = await buildLocalIntelSnapshot({ ...base, field: { ...base.field, opponentSideConditions: ["Tailwind"] } });
  assert.equal(intel.speedPreview?.activeRelation, "overlap");

  intel = await buildLocalIntelSnapshot({
    ...base,
    opponentSide: {
      ...base.opponentSide,
      active: makePokemon({ ...base.opponentSide.active, status: "par" })
    }
  });
  assert.equal(intel.speedPreview?.activeRelation, "faster");

  intel = await buildLocalIntelSnapshot({
    ...base,
    opponentSide: {
      ...base.opponentSide,
      active: makePokemon({ ...base.opponentSide.active, boosts: { spe: 2 } })
    }
  });
  assert.equal(intel.speedPreview?.activeRelation, "overlap");

  intel = await buildLocalIntelSnapshot({
    ...base,
    opponentSide: {
      ...base.opponentSide,
      active: makePokemon({ ...base.opponentSide.active, item: "Choice Scarf" })
    }
  });
  assert.equal(intel.speedPreview?.activeRelation, "overlap");

  intel = await buildLocalIntelSnapshot({
    ...base,
    yourSide: {
      ...base.yourSide,
      active: makePokemon({ ...base.yourSide.active, item: "choicescarf" }),
      team: [makePokemon({ ...base.yourSide.active, item: "choicescarf" })]
    }
  });
  assert.equal(intel.speedPreview?.activeRelation, "faster");
  assert.ok((intel.speedPreview?.confounders ?? []).includes("your Choice Scarf"));
});

test("speed preview widens for unrevealed field speed abilities like Sand Rush", async () => {
  const base = makeSnapshot({
    roomId: "battle-speed-sand-rush",
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Arcanine",
        species: "Arcanine-Hisui",
        displayName: "Arcanine-Hisui",
        active: true,
        item: "Choice Scarf",
        ability: "Rock Head",
        stats: { hp: 331, atk: 329, def: 196, spa: 203, spd: 197, spe: 306 },
        types: ["Fire", "Rock"]
      }),
      team: [makePokemon({
        ident: "p1a: Arcanine",
        species: "Arcanine-Hisui",
        displayName: "Arcanine-Hisui",
        active: true,
        item: "Choice Scarf",
        ability: "Rock Head",
        stats: { hp: 331, atk: 329, def: 196, spa: 203, spd: 197, spe: 306 },
        types: ["Fire", "Rock"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Excadrill",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        stats: { hp: 341, atk: 369, def: 156, spa: 126, spd: 166, spe: 281 },
        types: ["Ground", "Steel"]
      }),
      team: [makePokemon({
        ident: "p2a: Excadrill",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        stats: { hp: 341, atk: 369, def: 156, spa: 126, spd: 166, spe: 281 },
        types: ["Ground", "Steel"]
      })]
    },
    field: {
      weather: "Sandstorm",
      terrain: null,
      pseudoWeather: [],
      yourSideConditions: [],
      opponentSideConditions: []
    }
  });

  const unrevealed = await buildLocalIntelSnapshot(base);
  assert.equal(unrevealed.speedPreview?.activeRelation, "overlap");
  assert.ok(Number(unrevealed.speedPreview?.effectiveRange?.max ?? 0) >= 604);
  assert.ok((unrevealed.speedPreview?.confounders ?? []).includes("possible opponent Sand Rush"));

  const moldBreaker = await buildLocalIntelSnapshot({
    ...base,
    opponentSide: {
      ...base.opponentSide,
      active: makePokemon({ ...base.opponentSide.active, ability: "Mold Breaker" }),
      team: [makePokemon({ ...base.opponentSide.active, ability: "Mold Breaker" })]
    }
  });
  assert.equal(moldBreaker.speedPreview?.activeRelation, "faster");
  assert.ok(!(moldBreaker.speedPreview?.confounders ?? []).includes("possible opponent Sand Rush"));
});

test("knocked off items stay revealed for intel without being treated as currently held", async () => {
  const prior = makeSnapshot({
    roomId: "battle-knockoff-history-prior",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Salamence",
        species: "Salamence",
        displayName: "Salamence",
        active: true,
        item: null,
        removedItem: "Heavy-Duty Boots",
        stats: { hp: 331, atk: 369, def: 196, spa: 256, spd: 196, spe: 328 },
        types: ["Dragon", "Flying"]
      }),
      team: [makePokemon({
        ident: "p2a: Salamence",
        species: "Salamence",
        displayName: "Salamence",
        active: true,
        item: null,
        removedItem: "Heavy-Duty Boots",
        stats: { hp: 331, atk: 369, def: 196, spa: 256, spd: 196, spe: 328 },
        types: ["Dragon", "Flying"]
      })]
    }
  });

  await updateLocalIntelFromSnapshot(prior);

  const current = makeSnapshot({
    roomId: "battle-knockoff-history-current",
    opponentSide: prior.opponentSide
  });
  const intel = await buildLocalIntelSnapshot(current);
  const salamence = intel.opponents.find((entry) => entry.species === "Salamence");

  assert.equal(salamence?.revealedItem, "Heavy-Duty Boots");
  assert.deepEqual(salamence?.likelyItems ?? [], []);
});

test("speed preview falls back to the format battle level when opponent level capture is missing or implausible", async () => {
  const snapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Kilowattrel",
        species: "Kilowattrel",
        displayName: "Kilowattrel",
        active: true,
        stats: { hp: 297, atk: 176, def: 156, spa: 309, spd: 176, spe: 353 },
        types: ["Electric", "Flying"]
      }),
      team: [makePokemon({
        ident: "p1a: Kilowattrel",
        species: "Kilowattrel",
        displayName: "Kilowattrel",
        active: true,
        stats: { hp: 297, atk: 176, def: 156, spa: 309, spd: 176, spe: 353 },
        types: ["Electric", "Flying"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Tyranitar",
        species: "Tyranitar",
        displayName: "Tyranitar",
        level: 1,
        active: true,
        status: "par",
        stats: { hp: 404, atk: 350, def: 256, spa: 203, spd: 236 },
        types: ["Rock", "Dark"]
      }),
      team: [makePokemon({
        ident: "p2a: Tyranitar",
        species: "Tyranitar",
        displayName: "Tyranitar",
        level: 1,
        active: true,
        status: "par",
        stats: { hp: 404, atk: 350, def: 256, spa: 203, spd: 236 },
        types: ["Rock", "Dark"]
      })]
    }
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  assert.ok(Number(intel.speedPreview?.effectiveRange?.max) > 2);
  assert.equal(intel.speedPreview?.activeRelation, "faster");
  assert.match(intel.speedPreview?.activeSummary ?? "", /live/i);
});

test("builds opponent threat preview from known and likely moves", async () => {
  const prior = makeSnapshot({
    roomId: "battle-threat-prior",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Noivern",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        knownMoves: ["Hurricane", "Flamethrower"],
        types: ["Flying", "Dragon"]
      }),
      team: [makePokemon({ ident: "p2a: Noivern", species: "Noivern", displayName: "Noivern", active: true, knownMoves: ["Hurricane", "Flamethrower"], types: ["Flying", "Dragon"] })]
    }
  });
  await updateLocalIntelFromSnapshot(prior);
  const current = makeSnapshot({
    roomId: "battle-threat-current",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Noivern",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        knownMoves: ["Hurricane"],
        types: ["Flying", "Dragon"]
      }),
      team: [makePokemon({ ident: "p2a: Noivern", species: "Noivern", displayName: "Noivern", active: true, knownMoves: ["Hurricane"], types: ["Flying", "Dragon"] })]
    }
  });
  const intel = await buildLocalIntelSnapshot(current);
  assert.ok((intel.opponentThreatPreview ?? []).some((entry) => entry.moveName === "Hurricane"));
  assert.ok((intel.opponentThreatPreview ?? []).some((entry) => entry.moveName === "Flamethrower"));
});


test("speed preview reports capture gaps when your shown Speed is missing", async () => {
  const yourActive = makePokemon({
    ident: "p1a: Scizor",
    species: "Scizor",
    displayName: "Scizor",
    active: true,
    knownMoves: ["Bullet Punch", "U-turn"],
    item: "Choice Band",
    ability: "Technician",
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196 }
  });
  const snapshot = makeSnapshot({
    roomId: "battle-speed-capture-gap",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourActive,
      team: [yourActive]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Umbreon",
        species: "Umbreon",
        displayName: "Umbreon",
        active: true,
        stats: { hp: 394, atk: 166, def: 350, spa: 156, spd: 394, spe: 166 },
        types: ["Dark"]
      }),
      team: [makePokemon({
        ident: "p2a: Umbreon",
        species: "Umbreon",
        displayName: "Umbreon",
        active: true,
        stats: { hp: 394, atk: 166, def: 350, spa: 156, spd: 394, spe: 166 },
        types: ["Dark"]
      })]
    }
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  assert.equal(intel.speedPreview?.reason, "capture_gap");
  assert.ok((intel.speedPreview?.evidence ?? []).some((entry) => entry.kind === "capture_gap"));
  assert.match(intel.speedPreview?.activeSummary ?? "", /Your Speed is missing/i);
  assert.ok(intel.speedPreview?.effectiveRange);
  assert.equal(intel.speedPreview?.yourActiveEffectiveSpeed, undefined);
});

test("single speed samples stay advisory until repeated clean observations tighten the range", async () => {
  const makeUmbreonSnapshot = (roomId: string, recentLog: string[]) => makeSnapshot({
    roomId,
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Umbreon",
        species: "Umbreon",
        displayName: "Umbreon",
        active: true,
        knownMoves: ["Foul Play"],
        stats: { hp: 394, atk: 166, def: 350, spa: 156, spd: 394, spe: 166 },
        types: ["Dark"]
      }),
      team: [makePokemon({
        ident: "p2a: Umbreon",
        species: "Umbreon",
        displayName: "Umbreon",
        active: true,
        knownMoves: ["Foul Play"],
        stats: { hp: 394, atk: 166, def: 350, spa: 156, spd: 394, spe: 166 },
        types: ["Dark"]
      })]
    },
    recentLog
  });

  const baseline = await buildLocalIntelSnapshot(makeUmbreonSnapshot("battle-speed-history-baseline", []));
  const baselineRange = baseline.speedPreview?.effectiveRange ? { ...baseline.speedPreview.effectiveRange } : null;
  assert.ok(baselineRange);

  await updateLocalIntelFromSnapshot(makeUmbreonSnapshot("battle-speed-history-1", [
    "Turn 5 started.",
    "Scizor used U-turn.",
    "Umbreon used Foul Play."
  ]));
  const afterOne = await buildLocalIntelSnapshot(makeUmbreonSnapshot("battle-speed-history-future-1", []));
  assert.deepEqual(afterOne.speedPreview?.effectiveRange, baselineRange);
  assert.equal(afterOne.speedPreview?.reason, "history");
  assert.match(afterOne.speedPreview?.evidence.find((entry) => entry.kind === "history")?.detail ?? "", /single samples stay advisory/i);

  await updateLocalIntelFromSnapshot(makeUmbreonSnapshot("battle-speed-history-2", [
    "Turn 8 started.",
    "Scizor used U-turn.",
    "Umbreon used Foul Play."
  ]));
  const afterTwo = await buildLocalIntelSnapshot(makeUmbreonSnapshot("battle-speed-history-future-2", []));
  assert.ok(Number(afterTwo.speedPreview?.effectiveRange?.max) < Number(baselineRange?.max));
  assert.ok(Number(afterTwo.speedPreview?.effectiveRange?.max) <= 165);
  assert.equal(afterTwo.speedPreview?.activeRelation, "faster");
});

test("status move previews surface immune outcomes for Tera typing and defensive abilities", () => {
  const teraGroundSnapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Pawmot",
        species: "Pawmot",
        displayName: "Pawmot",
        active: true,
        knownMoves: ["Thunder Wave"],
        stats: { hp: 281, atk: 339, def: 176, spa: 176, spd: 176, spe: 339 },
        types: ["Electric", "Fighting"]
      }),
      team: [makePokemon({
        ident: "p1a: Pawmot",
        species: "Pawmot",
        displayName: "Pawmot",
        active: true,
        knownMoves: ["Thunder Wave"],
        stats: { hp: 281, atk: 339, def: 176, spa: 176, spd: 176, spe: 339 },
        types: ["Electric", "Fighting"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Rotom-Wash",
        species: "Rotom-Wash",
        displayName: "Rotom-Wash",
        active: true,
        terastallized: true,
        teraType: "Ground",
        stats: { hp: 304, atk: 166, def: 250, spa: 233, spd: 250, spe: 218 },
        types: ["Electric", "Water"]
      }),
      team: [makePokemon({
        ident: "p2a: Rotom-Wash",
        species: "Rotom-Wash",
        displayName: "Rotom-Wash",
        active: true,
        terastallized: true,
        teraType: "Ground",
        stats: { hp: 304, atk: 166, def: 250, spa: 233, spd: 250, spe: 218 },
        types: ["Electric", "Water"]
      })]
    },
    legalActions: [{ id: "move:thunderwave", kind: "move", label: "Thunder Wave", moveName: "Thunder Wave" }]
  });
  const teraGroundPreview = buildDamagePreview(teraGroundSnapshot);
  assert.equal(teraGroundPreview[0]?.category, "Status");
  assert.equal(teraGroundPreview[0]?.bands[0]?.outcome, "immune");
  assert.match(teraGroundPreview[0]?.bands[0]?.detail ?? "", /ground-type/i);
  assert.equal(teraGroundPreview[0]?.bands[0]?.minPercent, null);
  assert.equal(teraGroundPreview[0]?.bands[0]?.maxPercent, null);

  const purifyingSaltSnapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Talonflame",
        species: "Talonflame",
        displayName: "Talonflame",
        active: true,
        knownMoves: ["Will-O-Wisp"],
        stats: { hp: 297, atk: 287, def: 170, spa: 166, spd: 176, spe: 329 },
        types: ["Fire", "Flying"]
      }),
      team: [makePokemon({
        ident: "p1a: Talonflame",
        species: "Talonflame",
        displayName: "Talonflame",
        active: true,
        knownMoves: ["Will-O-Wisp"],
        stats: { hp: 297, atk: 287, def: 170, spa: 166, spd: 176, spe: 329 },
        types: ["Fire", "Flying"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Garganacl",
        species: "Garganacl",
        displayName: "Garganacl",
        active: true,
        ability: "Purifying Salt",
        stats: { hp: 404, atk: 236, def: 394, spa: 126, spd: 216, spe: 106 },
        types: ["Rock"]
      }),
      team: [makePokemon({
        ident: "p2a: Garganacl",
        species: "Garganacl",
        displayName: "Garganacl",
        active: true,
        ability: "Purifying Salt",
        stats: { hp: 404, atk: 236, def: 394, spa: 126, spd: 216, spe: 106 },
        types: ["Rock"]
      })]
    },
    legalActions: [{ id: "move:willowisp", kind: "move", label: "Will-O-Wisp", moveName: "Will-O-Wisp" }]
  });
  const purifyingSaltPreview = buildDamagePreview(purifyingSaltSnapshot);
  assert.equal(purifyingSaltPreview[0]?.bands[0]?.outcome, "immune");
  assert.match(purifyingSaltPreview[0]?.bands[0]?.detail ?? "", /purifying salt/i);
});

test("damage and status previews surface possible hidden-ability immunity hints", () => {
  const waterSnapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Greninja",
        species: "Greninja",
        displayName: "Greninja",
        active: true,
        knownMoves: ["Hydro Pump"],
        stats: { hp: 289, atk: 226, def: 170, spa: 305, spd: 178, spe: 377 },
        types: ["Water", "Dark"]
      }),
      team: [makePokemon({
        ident: "p1a: Greninja",
        species: "Greninja",
        displayName: "Greninja",
        active: true,
        knownMoves: ["Hydro Pump"],
        stats: { hp: 289, atk: 226, def: 170, spa: 305, spd: 178, spe: 377 },
        types: ["Water", "Dark"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Vaporeon",
        species: "Vaporeon",
        displayName: "Vaporeon",
        active: true,
        stats: { hp: 464, atk: 166, def: 240, spa: 256, spd: 226, spe: 166 },
        types: ["Water"]
      }),
      team: [makePokemon({
        ident: "p2a: Vaporeon",
        species: "Vaporeon",
        displayName: "Vaporeon",
        active: true,
        stats: { hp: 464, atk: 166, def: 240, spa: 256, spd: 226, spe: 166 },
        types: ["Water"]
      })]
    },
    legalActions: [{ id: "move:hydropump", kind: "move", label: "Hydro Pump", moveName: "Hydro Pump" }]
  });
  const waterPreview = buildDamagePreview(waterSnapshot, { likelyDefenderAbilities: ["Water Absorb"] });
  assert.equal(waterPreview[0]?.bands[0]?.outcome, undefined);
  assert.equal(waterPreview[0]?.interactionHints[0]?.label, "Water Absorb");
  assert.match(waterPreview[0]?.interactionHints[0]?.detail ?? "", /Hydro Pump.*0/i);

  const waveSnapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Pawmot",
        species: "Pawmot",
        displayName: "Pawmot",
        active: true,
        knownMoves: ["Thunder Wave"],
        stats: { hp: 281, atk: 339, def: 176, spa: 176, spd: 176, spe: 339 },
        types: ["Electric", "Fighting"]
      }),
      team: [makePokemon({
        ident: "p1a: Pawmot",
        species: "Pawmot",
        displayName: "Pawmot",
        active: true,
        knownMoves: ["Thunder Wave"],
        stats: { hp: 281, atk: 339, def: 176, spa: 176, spd: 176, spe: 339 },
        types: ["Electric", "Fighting"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Dudunsparce",
        species: "Dudunsparce",
        displayName: "Dudunsparce",
        active: true,
        stats: { hp: 414, atk: 236, def: 216, spa: 206, spd: 216, spe: 176 },
        types: ["Normal"]
      }),
      team: [makePokemon({
        ident: "p2a: Dudunsparce",
        species: "Dudunsparce",
        displayName: "Dudunsparce",
        active: true,
        stats: { hp: 414, atk: 236, def: 216, spa: 206, spd: 216, spe: 176 },
        types: ["Normal"]
      })]
    },
    legalActions: [{ id: "move:thunderwave", kind: "move", label: "Thunder Wave", moveName: "Thunder Wave" }]
  });
  const wavePreview = buildDamagePreview(waveSnapshot, { likelyDefenderAbilities: ["Limber"] });
  assert.equal(wavePreview[0]?.bands[0]?.outcome, "status");
  assert.equal(wavePreview[0]?.interactionHints[0]?.label, "Limber");
  assert.match(wavePreview[0]?.interactionHints[0]?.detail ?? "", /block Thunder Wave/i);

  const balloonSnapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Great Tusk-hidden-balloon",
        species: "Great Tusk",
        displayName: "Great Tusk",
        active: true,
        knownMoves: ["Headlong Rush"],
        stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
        types: ["Ground", "Fighting"]
      }),
      team: [makePokemon({
        ident: "p1a: Great Tusk-hidden-balloon",
        species: "Great Tusk",
        displayName: "Great Tusk",
        active: true,
        knownMoves: ["Headlong Rush"],
        stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
        types: ["Ground", "Fighting"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Excadrill-hidden-balloon",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      }),
      team: [makePokemon({
        ident: "p2a: Excadrill-hidden-balloon",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      })]
    },
    legalActions: [{ id: "move:headlongrush", kind: "move", label: "Headlong Rush", moveName: "Headlong Rush" }]
  });
  const balloonPreview = buildDamagePreview(balloonSnapshot, { likelyDefenderItems: ["Air Balloon"] });
  assert.notEqual(balloonPreview[0]?.bands[0]?.outcome, "immune");
  assert.equal(balloonPreview[0]?.interactionHints[0]?.label, "Air Balloon");
  assert.match(balloonPreview[0]?.interactionHints[0]?.detail ?? "", /Headlong Rush.*0/i);

  const thousandArrowsSnapshot: BattleSnapshot = {
    ...balloonSnapshot,
    yourSide: {
      ...balloonSnapshot.yourSide,
      active: makePokemon({
        ident: "p1a: Zygarde-balloon-exception",
        species: "Zygarde-10%",
        displayName: "Zygarde-10%",
        active: true,
        knownMoves: ["Thousand Arrows"],
        stats: { hp: 289, atk: 299, def: 226, spa: 136, spd: 226, spe: 361 },
        types: ["Dragon", "Ground"]
      }),
      team: [makePokemon({
        ident: "p1a: Zygarde-balloon-exception",
        species: "Zygarde-10%",
        displayName: "Zygarde-10%",
        active: true,
        knownMoves: ["Thousand Arrows"],
        stats: { hp: 289, atk: 299, def: 226, spa: 136, spd: 226, spe: 361 },
        types: ["Dragon", "Ground"]
      })]
    },
    legalActions: [{ id: "move:thousandarrows", kind: "move", label: "Thousand Arrows", moveName: "Thousand Arrows" }]
  };
  const thousandArrowsPreview = buildDamagePreview(thousandArrowsSnapshot, { likelyDefenderItems: ["Air Balloon"] });
  assert.notEqual(thousandArrowsPreview[0]?.bands[0]?.outcome, "immune");
  assert.equal(thousandArrowsPreview[0]?.interactionHints.length, 0);
});

test("Mold Breaker suppresses possible ability nullifier hints", () => {
  const snapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Excadrill-mold-breaker",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        ability: "Mold Breaker",
        knownMoves: ["Earthquake"],
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      }),
      team: [makePokemon({
        ident: "p1a: Excadrill-mold-breaker",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        ability: "Mold Breaker",
        knownMoves: ["Earthquake"],
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Rotom-Wash-hidden-levitate",
        species: "Rotom-Wash",
        displayName: "Rotom-Wash",
        active: true,
        stats: { hp: 304, atk: 166, def: 344, spa: 309, spd: 344, spe: 298 },
        types: ["Electric", "Water"]
      }),
      team: [makePokemon({
        ident: "p2a: Rotom-Wash-hidden-levitate",
        species: "Rotom-Wash",
        displayName: "Rotom-Wash",
        active: true,
        stats: { hp: 304, atk: 166, def: 344, spa: 309, spd: 344, spe: 298 },
        types: ["Electric", "Water"]
      })]
    },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }]
  });

  const preview = buildDamagePreview(snapshot, { likelyDefenderAbilities: ["Levitate"] });
  assert.equal(preview[0]?.interactionHints.length, 0);
});

test("opponent threat preview preserves blocked status outcomes", () => {
  const snapshot = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Hydreigon",
        species: "Hydreigon",
        displayName: "Hydreigon",
        active: true,
        stats: { hp: 323, atk: 246, def: 216, spa: 383, spd: 216, spe: 324 },
        types: ["Dark", "Dragon"]
      }),
      team: [makePokemon({
        ident: "p1a: Hydreigon",
        species: "Hydreigon",
        displayName: "Hydreigon",
        active: true,
        stats: { hp: 323, atk: 246, def: 216, spa: 383, spd: 216, spe: 324 },
        types: ["Dark", "Dragon"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Grimmsnarl",
        species: "Grimmsnarl",
        displayName: "Grimmsnarl",
        active: true,
        ability: "Prankster",
        knownMoves: ["Thunder Wave"],
        stats: { hp: 394, atk: 339, def: 196, spa: 206, spd: 196, spe: 156 },
        types: ["Dark", "Fairy"]
      }),
      team: [makePokemon({
        ident: "p2a: Grimmsnarl",
        species: "Grimmsnarl",
        displayName: "Grimmsnarl",
        active: true,
        ability: "Prankster",
        knownMoves: ["Thunder Wave"],
        stats: { hp: 394, atk: 339, def: 196, spa: 206, spd: 196, spe: 156 },
        types: ["Dark", "Fairy"]
      })]
    }
  });

  const threats = buildThreatPreview(snapshot, {
    moveCandidates: [{ name: "Thunder Wave", source: "known" }]
  });
  assert.equal(threats.length, 1);
  assert.equal(threats[0]?.currentTarget.bands[0]?.outcome, "blocked");
  assert.match(threats[0]?.currentTarget.summary ?? "", /blocked/i);
});

test("predictor treats blocked repeat status as a switch catch, not a live active-target line", async () => {
  const yourHydreigon = makePokemon({
    ident: "p1a: Hydreigon-paralyzed",
    species: "Hydreigon",
    displayName: "Hydreigon",
    active: true,
    status: "par",
    knownMoves: ["Dark Pulse"],
    hpPercent: 78,
    stats: { hp: 323, atk: 246, def: 216, spa: 383, spd: 216, spe: 324 },
    types: ["Dark", "Dragon"]
  });
  const opponentGrimmsnarl = makePokemon({
    ident: "p2a: Grimmsnarl-repeat-status",
    species: "Grimmsnarl",
    displayName: "Grimmsnarl",
    active: true,
    ability: "Prankster",
    knownMoves: ["Thunder Wave", "Spirit Break"],
    stats: { hp: 394, atk: 339, def: 196, spa: 206, spd: 196, spe: 156 },
    types: ["Dark", "Fairy"]
  });
  const snapshot = makeSnapshot({
    roomId: "battle-predictor-repeat-status",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourHydreigon,
      team: [yourHydreigon]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGrimmsnarl,
      team: [opponentGrimmsnarl]
    },
    legalActions: [{ id: "move:darkpulse", kind: "move", label: "Dark Pulse", moveName: "Dark Pulse" }]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const prediction = intel.opponentActionPrediction;
  assert.ok(prediction);
  assert.equal(prediction?.topActionClass, "stay_attack");
  assert.equal(prediction?.topActions[0]?.moveName, "Spirit Break");
  const thunderWave = prediction?.topActions.find((candidate) => candidate.moveName === "Thunder Wave");
  assert.ok(thunderWave);
  assert.ok(!(thunderWave?.reasons ?? []).includes("status line is live into your active"));
  assert.ok((thunderWave?.riskFlags ?? []).includes("your active can ignore or block this status"));
});

test("damage preview respects direct immunities, Tera overrides, Purifying Salt, and Multiscale", () => {
  const electricIntoGround = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Jolteon",
        species: "Jolteon",
        displayName: "Jolteon",
        active: true,
        knownMoves: ["Thunderbolt"],
        stats: { hp: 271, atk: 166, def: 156, spa: 319, spd: 226, spe: 394 },
        types: ["Electric"]
      }),
      team: [makePokemon({
        ident: "p1a: Jolteon",
        species: "Jolteon",
        displayName: "Jolteon",
        active: true,
        knownMoves: ["Thunderbolt"],
        stats: { hp: 271, atk: 166, def: 156, spa: 319, spd: 226, spe: 394 },
        types: ["Electric"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Clodsire",
        species: "Clodsire",
        displayName: "Clodsire",
        active: true,
        stats: { hp: 394, atk: 186, def: 236, spa: 126, spd: 236, spe: 96 },
        types: ["Poison", "Ground"]
      }),
      team: [makePokemon({
        ident: "p2a: Clodsire",
        species: "Clodsire",
        displayName: "Clodsire",
        active: true,
        stats: { hp: 394, atk: 186, def: 236, spa: 126, spd: 236, spe: 96 },
        types: ["Poison", "Ground"]
      })]
    },
    legalActions: [{ id: "move:thunderbolt", kind: "move", label: "Thunderbolt", moveName: "Thunderbolt" }]
  });
  const electricImmuneBand = findLikelyBand(buildDamagePreview(electricIntoGround)[0]?.bands);
  assert.equal(electricImmuneBand?.outcome, "immune");
  assert.equal(electricImmuneBand?.maxPercent, 0);

  const teraGroundGyarados = makeSnapshot({
    yourSide: electricIntoGround.yourSide,
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Gyarados",
        species: "Gyarados",
        displayName: "Gyarados",
        active: true,
        terastallized: true,
        teraType: "Ground",
        stats: { hp: 331, atk: 383, def: 194, spa: 140, spd: 236, spe: 287 },
        types: ["Water", "Flying"]
      }),
      team: [makePokemon({
        ident: "p2a: Gyarados",
        species: "Gyarados",
        displayName: "Gyarados",
        active: true,
        terastallized: true,
        teraType: "Ground",
        stats: { hp: 331, atk: 383, def: 194, spa: 140, spd: 236, spe: 287 },
        types: ["Water", "Flying"]
      })]
    },
    legalActions: [{ id: "move:thunderbolt", kind: "move", label: "Thunderbolt", moveName: "Thunderbolt" }]
  });
  const teraImmuneBand = findLikelyBand(buildDamagePreview(teraGroundGyarados)[0]?.bands);
  assert.equal(teraImmuneBand?.outcome, "immune");
  assert.equal(teraImmuneBand?.maxPercent, 0);

  const airBalloonExcadrill = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Great Tusk-air-balloon",
        species: "Great Tusk",
        displayName: "Great Tusk",
        active: true,
        knownMoves: ["Headlong Rush"],
        stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
        types: ["Ground", "Fighting"]
      }),
      team: [makePokemon({
        ident: "p1a: Great Tusk-air-balloon",
        species: "Great Tusk",
        displayName: "Great Tusk",
        active: true,
        knownMoves: ["Headlong Rush"],
        stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
        types: ["Ground", "Fighting"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Excadrill-air-balloon",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        item: "Air Balloon",
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      }),
      team: [makePokemon({
        ident: "p2a: Excadrill-air-balloon",
        species: "Excadrill",
        displayName: "Excadrill",
        active: true,
        item: "Air Balloon",
        stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
        types: ["Ground", "Steel"]
      })]
    },
    legalActions: [{ id: "move:headlongrush", kind: "move", label: "Headlong Rush", moveName: "Headlong Rush" }]
  });
  const airBalloonBand = findLikelyBand(buildDamagePreview(airBalloonExcadrill)[0]?.bands);
  assert.equal(airBalloonBand?.outcome, "immune");
  assert.match(airBalloonBand?.detail ?? "", /air balloon/i);

  const shadowBallBase = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Gengar",
        species: "Gengar",
        displayName: "Gengar",
        active: true,
        knownMoves: ["Shadow Ball"],
        stats: { hp: 261, atk: 166, def: 156, spa: 394, spd: 186, spe: 350 },
        types: ["Ghost", "Poison"]
      }),
      team: [makePokemon({
        ident: "p1a: Gengar",
        species: "Gengar",
        displayName: "Gengar",
        active: true,
        knownMoves: ["Shadow Ball"],
        stats: { hp: 261, atk: 166, def: 156, spa: 394, spd: 186, spe: 350 },
        types: ["Ghost", "Poison"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Garganacl",
        species: "Garganacl",
        displayName: "Garganacl",
        active: true,
        ability: "Sturdy",
        hpPercent: 80,
        stats: { hp: 404, atk: 236, def: 394, spa: 126, spd: 216, spe: 106 },
        types: ["Rock"]
      }),
      team: [makePokemon({
        ident: "p2a: Garganacl",
        species: "Garganacl",
        displayName: "Garganacl",
        active: true,
        ability: "Sturdy",
        hpPercent: 80,
        stats: { hp: 404, atk: 236, def: 394, spa: 126, spd: 216, spe: 106 },
        types: ["Rock"]
      })]
    },
    legalActions: [{ id: "move:shadowball", kind: "move", label: "Shadow Ball", moveName: "Shadow Ball" }]
  });
  const shadowBallSalt = makeSnapshot({
    ...shadowBallBase,
    opponentSide: {
      ...shadowBallBase.opponentSide,
      active: makePokemon({ ...shadowBallBase.opponentSide.active, ability: "Purifying Salt" }),
      team: [makePokemon({ ...shadowBallBase.opponentSide.active, ability: "Purifying Salt" })]
    }
  });
  const shadowBallBaseLikely = buildDamagePreview(shadowBallBase)[0]?.bands.find((band) => band.label === "likely");
  const shadowBallSaltLikely = buildDamagePreview(shadowBallSalt)[0]?.bands.find((band) => band.label === "likely");
  assert.ok(Number(shadowBallSaltLikely?.maxPercent) < Number(shadowBallBaseLikely?.maxPercent));

  const iceBeamBase = makeSnapshot({
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Starmie",
        species: "Starmie",
        displayName: "Starmie",
        active: true,
        knownMoves: ["Ice Beam"],
        stats: { hp: 261, atk: 186, def: 206, spa: 299, spd: 206, spe: 361 },
        types: ["Water", "Psychic"]
      }),
      team: [makePokemon({
        ident: "p1a: Starmie",
        species: "Starmie",
        displayName: "Starmie",
        active: true,
        knownMoves: ["Ice Beam"],
        stats: { hp: 261, atk: 186, def: 206, spa: 299, spd: 206, spe: 361 },
        types: ["Water", "Psychic"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Dragonite",
        species: "Dragonite",
        displayName: "Dragonite",
        active: true,
        ability: "Inner Focus",
        hpPercent: 100,
        stats: { hp: 386, atk: 403, def: 226, spa: 236, spd: 236, spe: 284 },
        types: ["Dragon", "Flying"]
      }),
      team: [makePokemon({
        ident: "p2a: Dragonite",
        species: "Dragonite",
        displayName: "Dragonite",
        active: true,
        ability: "Inner Focus",
        hpPercent: 100,
        stats: { hp: 386, atk: 403, def: 226, spa: 236, spd: 236, spe: 284 },
        types: ["Dragon", "Flying"]
      })]
    },
    legalActions: [{ id: "move:icebeam", kind: "move", label: "Ice Beam", moveName: "Ice Beam" }]
  });
  const iceBeamScale = makeSnapshot({
    ...iceBeamBase,
    opponentSide: {
      ...iceBeamBase.opponentSide,
      active: makePokemon({ ...iceBeamBase.opponentSide.active, ability: "Multiscale" }),
      team: [makePokemon({ ...iceBeamBase.opponentSide.active, ability: "Multiscale" })]
    }
  });
  const iceBeamBaseLikely = buildDamagePreview(iceBeamBase)[0]?.bands.find((band) => band.label === "likely");
  const iceBeamScaleLikely = buildDamagePreview(iceBeamScale)[0]?.bands.find((band) => band.label === "likely");
  assert.ok(Number(iceBeamScaleLikely?.maxPercent) < Number(iceBeamBaseLikely?.maxPercent));
});

test("observed damage learning skips windows with sourced HP changes", async () => {
  const before = makeSnapshot({
    roomId: "battle-observed-noisy-source",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Togekiss",
        species: "Togekiss",
        displayName: "Togekiss",
        active: true,
        knownMoves: ["Air Slash"],
        hpPercent: 100,
        stats: { hp: 374, atk: 176, def: 226, spa: 339, spd: 266, spe: 284 },
        types: ["Fairy", "Flying"]
      }),
      team: [makePokemon({
        ident: "p2a: Togekiss",
        species: "Togekiss",
        displayName: "Togekiss",
        active: true,
        knownMoves: ["Air Slash"],
        hpPercent: 100,
        stats: { hp: 374, atk: 176, def: 226, spa: 339, spd: 266, spe: 284 },
        types: ["Fairy", "Flying"]
      })]
    },
    recentLog: ["Turn 9 started."]
  });
  const after = makeSnapshot({
    ...before,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    yourSide: {
      ...before.yourSide,
      active: makePokemon({ ...before.yourSide.active, hpPercent: 70 }),
      team: [makePokemon({ ...before.yourSide.active, hpPercent: 70 }), ...before.yourSide.team.slice(1)]
    },
    recentLog: [
      "Turn 9 started.",
      "Togekiss used Air Slash.",
      "Scizor had HP change from burn."
    ]
  });

  await updateLocalIntelFromSnapshot(before);
  await updateLocalIntelFromSnapshot(after);

  const future = makeSnapshot({
    roomId: "battle-observed-noisy-source-future",
    opponentSide: after.opponentSide
  });
  const intel = await buildLocalIntelSnapshot(future);
  const airSlash = intel.opponentThreatPreview?.find((entry) => entry.moveName === "Air Slash");
  assert.equal(airSlash?.currentTarget.observedRange, undefined);
});

test("observed critical-hit damage is normalized before entering observed history", async () => {
  const before = makeSnapshot({
    roomId: "battle-observed-crit-before",
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Fezandipiti",
        species: "Fezandipiti",
        displayName: "Fezandipiti",
        active: true,
        hpPercent: 100,
        knownMoves: ["Moonblast"],
        stats: { hp: 380, atk: 176, def: 262, spa: 176, spd: 262, spe: 260 },
        types: ["Poison", "Fairy"]
      }),
      team: [makePokemon({
        ident: "p1a: Fezandipiti",
        species: "Fezandipiti",
        displayName: "Fezandipiti",
        active: true,
        hpPercent: 100,
        knownMoves: ["Moonblast"],
        stats: { hp: 380, atk: 176, def: 262, spa: 176, spd: 262, spe: 260 },
        types: ["Poison", "Fairy"]
      })]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Pincurchin",
        species: "Pincurchin",
        displayName: "Pincurchin",
        active: true,
        hpPercent: 74,
        stats: { hp: 288, atk: 265, def: 296, spa: 229, spd: 226, spe: 140 },
        types: ["Electric"]
      }),
      team: [makePokemon({
        ident: "p2a: Pincurchin",
        species: "Pincurchin",
        displayName: "Pincurchin",
        active: true,
        hpPercent: 74,
        stats: { hp: 288, atk: 265, def: 296, spa: 229, spd: 226, spe: 140 },
        types: ["Electric"]
      })]
    },
    legalActions: [{ id: "move:moonblast", kind: "move", label: "Moonblast", moveName: "Moonblast" }],
    recentLog: ["Turn 16 started."]
  });
  const afterCrit = makeSnapshot({
    ...before,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    opponentSide: {
      ...before.opponentSide,
      active: makePokemon({ ...before.opponentSide.active, hpPercent: 35 }),
      team: [makePokemon({ ...before.opponentSide.active, hpPercent: 35 })]
    },
    recentLog: [
      "Turn 16 started.",
      "Fezandipiti used Moonblast.",
      "It was a critical hit."
    ]
  });

  await updateLocalIntelFromSnapshot(before);
  await updateLocalIntelFromSnapshot(afterCrit);

  const future = makeSnapshot({
    ...afterCrit,
    roomId: "battle-observed-crit-future",
    turn: 17,
    recentLog: ["Turn 17 started."]
  });

  const intel = await buildLocalIntelSnapshot(future);
  const moonblast = intel.playerDamagePreview?.find((entry) => entry.moveName === "Moonblast");
  assert.ok(moonblast?.observedRange);
  assert.equal(moonblast?.likelyBandSource, "context");
  assert.equal(moonblast?.observedRange?.minPercent, 26);
  assert.equal(moonblast?.observedRange?.maxPercent, 26);
  const likelyBand = moonblast?.bands.find((band) => band.label === "likely");
  assert.equal(likelyBand?.minPercent, 26);
  assert.equal(likelyBand?.maxPercent, 26);
});

test("posterior collapses item hypotheses when the item is revealed", async () => {
  const prior = makeSnapshot({
    roomId: "battle-posterior-item-prior",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Slowking",
        species: "Slowking",
        displayName: "Slowking",
        active: true,
        knownMoves: ["Scald"],
        ability: "Regenerator",
        types: ["Water", "Psychic"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Slowking",
          species: "Slowking",
          displayName: "Slowking",
          active: true,
          knownMoves: ["Scald"],
          ability: "Regenerator",
          types: ["Water", "Psychic"]
        })
      ]
    }
  });
  await updateLocalIntelFromSnapshot(prior);

  const current = makeSnapshot({
    roomId: "battle-posterior-item-current",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Slowking",
        species: "Slowking",
        displayName: "Slowking",
        active: true,
        item: "Choice Scarf",
        ability: "Regenerator",
        knownMoves: ["Scald"],
        types: ["Water", "Psychic"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Slowking",
          species: "Slowking",
          displayName: "Slowking",
          active: true,
          item: "Choice Scarf",
          ability: "Regenerator",
          knownMoves: ["Scald"],
          types: ["Water", "Psychic"]
        })
      ]
    }
  });

  const intel = await buildLocalIntelSnapshot(current);
  const posterior = intel.opponents[0]?.posterior;
  assert.ok(posterior);
  assert.ok((posterior?.topHypotheses ?? []).length > 0);
  assert.ok((posterior?.topHypotheses ?? []).every((hypothesis) => hypothesis.item === "Choice Scarf"));
  assert.ok((posterior?.evidenceKinds ?? []).includes("reveals"));
});

test("posterior favors scarf hypotheses after a clean speed observation", async () => {
  const before = makeSnapshot({
    roomId: "battle-posterior-speed-scarf",
    yourSide: {
      slot: "p1",
      name: "You",
      active: makePokemon({
        ident: "p1a: Kilowattrel",
        species: "Kilowattrel",
        displayName: "Kilowattrel",
        active: true,
        stats: { hp: 281, atk: 176, def: 156, spa: 309, spd: 176, spe: 383 },
        types: ["Electric", "Flying"]
      }),
      team: [
        makePokemon({
          ident: "p1a: Kilowattrel",
          species: "Kilowattrel",
          displayName: "Kilowattrel",
          active: true,
          stats: { hp: 281, atk: 176, def: 156, spa: 309, spd: 176, spe: 383 },
          types: ["Electric", "Flying"]
        })
      ]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Breloom",
        species: "Breloom",
        displayName: "Breloom",
        active: true,
        knownMoves: ["Seed Bomb"],
        types: ["Grass", "Fighting"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Breloom",
          species: "Breloom",
          displayName: "Breloom",
          active: true,
          knownMoves: ["Seed Bomb"],
          types: ["Grass", "Fighting"]
        })
      ]
    },
    recentLog: ["Turn 1 started."]
  });
  const after = makeSnapshot({
    ...before,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    recentLog: ["Turn 1 started.", "Breloom used Seed Bomb.", "Kilowattrel used Air Slash."]
  });

  await updateLocalIntelFromSnapshot(before);
  await updateLocalIntelFromSnapshot(after);

  const intel = await buildLocalIntelSnapshot(after);
  const posterior = intel.opponents[0]?.posterior;
  const posteriorDebug = intel.debug?.posterior as { confidenceTier?: string; topHypotheses?: unknown[] } | undefined;
  assert.ok(posterior);
  assert.ok((posterior?.evidenceKinds ?? []).includes("speed"));
  assert.equal(posterior?.topHypotheses[0]?.item, "Choice Scarf");
  assert.equal(posteriorDebug?.confidenceTier, posterior?.confidenceTier);
  assert.ok((posteriorDebug?.topHypotheses ?? []).length > 0);
  const seedBombThreat = intel.opponentThreatPreview?.find((entry) => entry.moveName === "Seed Bomb");
  assert.equal(seedBombThreat?.currentTarget.likelyBandSource, "posterior");
  const prompt = buildAnalysisPrompt(after, { localIntel: intel, includeToolHint: false });
  assert.match(prompt, /posterior/);
  assert.match(prompt, /evidence .*speed/i);
});

test("posterior effectiveSpeed reflects current board speed modifiers on hypotheses", () => {
  const formatStats = {
    observedBattlesSeen: 0,
    curatedTeamCount: 0,
    observedMoves: {},
    observedItems: {},
    observedAbilities: {},
    observedTeraTypes: {},
    curatedMoves: {},
    curatedItems: {},
    curatedAbilities: {},
    curatedTeraTypes: {}
  };
  const excadrill = makePokemon({
    ident: "p2a: Excadrill-posterior-speed-live",
    species: "Excadrill",
    displayName: "Excadrill",
    active: true,
    ability: "Sand Rush",
    item: "Choice Scarf",
    boosts: { spe: 1 },
    stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
    types: ["Ground", "Steel"]
  });
  const excadrillBoard = makeSnapshot({
    format: "[Gen 9] UU",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: excadrill,
      team: [excadrill]
    },
    field: {
      weather: "Sandstorm",
      terrain: null,
      pseudoWeather: [],
      yourSideConditions: [],
      opponentSideConditions: ["Tailwind"]
    }
  });
  const excadrillNeutral = buildOpponentPosterior({
    format: "[Gen 9] UU",
    opponent: excadrill,
    formatStats
  });
  const excadrillBoosted = buildOpponentPosterior({
    format: "[Gen 9] UU",
    opponent: excadrill,
    battleSnapshot: excadrillBoard,
    formatStats
  });

  const neutralScarf = excadrillNeutral?.topHypotheses.find((hypothesis) => hypothesis.statArchetype === "scarf_phys");
  const boostedScarf = excadrillBoosted?.topHypotheses.find((hypothesis) => hypothesis.statArchetype === "scarf_phys");
  assert.ok(neutralScarf);
  assert.ok(boostedScarf);
  assert.ok(Number(boostedScarf?.effectiveSpeed ?? 0) > Number(neutralScarf?.effectiveSpeed ?? 0));

  const ursaring = makePokemon({
    ident: "p2a: Ursaring-posterior-speed-live",
    species: "Ursaring",
    displayName: "Ursaring",
    active: true,
    ability: "Quick Feet",
    status: "par",
    stats: { hp: 341, atk: 394, def: 186, spa: 166, spd: 186, spe: 229 },
    types: ["Normal"]
  });
  const ursaringBoard = makeSnapshot({
    format: "[Gen 9] UU",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: ursaring,
      team: [ursaring]
    },
    field: {
      weather: null,
      terrain: null,
      pseudoWeather: [],
      yourSideConditions: [],
      opponentSideConditions: ["Tailwind"]
    }
  });
  const ursaringNeutral = buildOpponentPosterior({
    format: "[Gen 9] UU",
    opponent: ursaring,
    formatStats
  });
  const ursaringBoosted = buildOpponentPosterior({
    format: "[Gen 9] UU",
    opponent: ursaring,
    battleSnapshot: ursaringBoard,
    formatStats
  });

  const neutralFast = ursaringNeutral?.topHypotheses.find((hypothesis) => hypothesis.statArchetype === "fast_phys");
  const boostedFast = ursaringBoosted?.topHypotheses.find((hypothesis) => hypothesis.statArchetype === "fast_phys");
  assert.ok(neutralFast);
  assert.ok(boostedFast);
  assert.ok(Number(boostedFast?.effectiveSpeed ?? 0) > Number(neutralFast?.effectiveSpeed ?? 0));
});

test("posterior tightens defensive archetypes after repeated clean damage windows", async () => {
  const baseYourSide = {
    slot: "p1",
    name: "You",
    active: makePokemon({
      ident: "p1a: Scizor",
      species: "Scizor",
      displayName: "Scizor",
      active: true,
      knownMoves: ["Bullet Punch"],
      item: "Choice Band",
      ability: "Technician",
      stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
    }),
    team: [
      makePokemon({
        ident: "p1a: Scizor",
        species: "Scizor",
        displayName: "Scizor",
        active: true,
        knownMoves: ["Bullet Punch"],
        item: "Choice Band",
        ability: "Technician",
        stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 }
      })
    ]
  };

  const before = makeSnapshot({
    roomId: "battle-posterior-damage-tighten",
    yourSide: baseYourSide,
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Porygon2",
        species: "Porygon2",
        displayName: "Porygon2",
        active: true,
        item: "Eviolite",
        ability: "Download",
        hpPercent: 100,
        stats: { hp: 374, atk: 176, def: 256, spa: 246, spd: 266, spe: 156 },
        types: ["Normal"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Porygon2",
          species: "Porygon2",
          displayName: "Porygon2",
          active: true,
          item: "Eviolite",
          ability: "Download",
          hpPercent: 100,
          stats: { hp: 374, atk: 176, def: 256, spa: 246, spd: 266, spe: 156 },
          types: ["Normal"]
        })
      ]
    },
    recentLog: ["Turn 1 started."],
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const afterOne = makeSnapshot({
    ...before,
    capturedAt: new Date(Date.now() + 1_000).toISOString(),
    opponentSide: {
      ...before.opponentSide,
      active: makePokemon({ ...before.opponentSide.active, hpPercent: 75 }),
      team: [makePokemon({ ...before.opponentSide.active, hpPercent: 75 })]
    },
    recentLog: ["Turn 1 started.", "Scizor used Bullet Punch."]
  });
  const afterTwo = makeSnapshot({
    ...afterOne,
    capturedAt: new Date(Date.now() + 2_000).toISOString(),
    turn: 2,
    opponentSide: {
      ...afterOne.opponentSide,
      active: makePokemon({ ...afterOne.opponentSide.active, hpPercent: 50 }),
      team: [makePokemon({ ...afterOne.opponentSide.active, hpPercent: 50 })]
    },
    recentLog: ["Turn 2 started.", "Scizor used Bullet Punch."]
  });

  await updateLocalIntelFromSnapshot(before);
  await updateLocalIntelFromSnapshot(afterOne);
  const intelAfterOne = await buildLocalIntelSnapshot(afterOne);
  const posteriorAfterOne = intelAfterOne.opponents[0]?.posterior;
  assert.ok(posteriorAfterOne);
  assert.ok((posteriorAfterOne?.evidenceKinds ?? []).includes("damage"));

  await updateLocalIntelFromSnapshot(afterTwo);
  const intelAfterTwo = await buildLocalIntelSnapshot(afterTwo);
  const posteriorAfterTwo = intelAfterTwo.opponents[0]?.posterior;
  assert.ok(posteriorAfterTwo);
  const defBandAfterOne = posteriorAfterOne?.statBands.find((band) => band.stat === "def");
  const defBandAfterTwo = posteriorAfterTwo?.statBands.find((band) => band.stat === "def");
  assert.ok(defBandAfterOne);
  assert.ok(defBandAfterTwo);
  assert.ok((defBandAfterTwo!.max - defBandAfterTwo!.min) <= (defBandAfterOne!.max - defBandAfterOne!.min));
  assert.ok(["physdef", "bulky_phys"].includes(posteriorAfterTwo?.topHypotheses[0]?.statArchetype ?? ""));
});

test("posterior falls back cleanly when there is no battle evidence", async () => {
  const snapshot = makeSnapshot({
    roomId: "battle-posterior-fallback",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Hatterene",
        species: "Hatterene",
        displayName: "Hatterene",
        active: true,
        item: null,
        ability: null,
        stats: { hp: 364, atk: 156, def: 226, spa: 361, spd: 346, spe: 166 },
        types: ["Psychic", "Fairy"]
      }),
      team: [
        makePokemon({
          ident: "p2a: Hatterene",
          species: "Hatterene",
          displayName: "Hatterene",
          active: true,
          item: null,
          ability: null,
          stats: { hp: 364, atk: 156, def: 226, spa: 361, spd: 346, spe: 166 },
          types: ["Psychic", "Fairy"]
        })
      ]
    }
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const posterior = intel.opponents[0]?.posterior;
  assert.ok(posterior);
  assert.equal(posterior?.confidenceTier, "thin");
  assert.equal(posterior?.usedFallback, true);
  assert.deepEqual(posterior?.evidenceKinds ?? [], []);
});

test("posterior hidden tera does not rewrite current typing before terastallization", () => {
  const jolteon = makePokemon({
    ident: "p1a: Jolteon",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });
  const gyarados = makePokemon({
    ident: "p2a: Gyarados",
    species: "Gyarados",
    displayName: "Gyarados",
    active: true,
    stats: { hp: 331, atk: 349, def: 194, spa: 156, spd: 236, spe: 287 },
    types: ["Water", "Flying"],
    teraType: null,
    terastallized: false
  });
  const defenderPosterior: OpponentPosteriorPreview = {
    topHypotheses: [
      {
        ability: null,
        item: null,
        teraType: "Ground",
        statArchetype: "bulky_spec",
        weight: 0.5,
        nature: "Calm",
        evs: { hp: 252, spd: 252 },
        support: ["test"]
      },
      {
        ability: null,
        item: null,
        teraType: "Ground",
        statArchetype: "physdef",
        weight: 0.3,
        nature: "Bold",
        evs: { hp: 252, def: 252 },
        support: ["test"]
      },
      {
        ability: null,
        item: null,
        teraType: "Ground",
        statArchetype: "spdef",
        weight: 0.2,
        nature: "Careful",
        evs: { hp: 252, spd: 252 },
        support: ["test"]
      }
    ],
    statBands: [],
    confidenceTier: "usable",
    evidenceKinds: ["priors"],
    evidence: [{ kind: "priors", label: "test posterior" }],
    usedFallback: false
  };
  const snapshot = makeSnapshot({
    roomId: "battle-hidden-tera-regression",
    yourSide: {
      slot: "p1",
      name: "You",
      active: jolteon,
      team: [jolteon]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: gyarados,
      team: [gyarados]
    },
    legalActions: [{ id: "move:thunderbolt", kind: "move", label: "Thunderbolt", moveName: "Thunderbolt" }]
  });

  const preview = buildDamagePreview(snapshot, { defenderPosterior });
  const thunderbolt = preview.find((entry) => entry.moveName === "Thunderbolt");
  const likely = findLikelyBand(thunderbolt?.bands);
  assert.ok(thunderbolt);
  assert.equal(thunderbolt?.likelyBandSource, "posterior");
  assert.notEqual(likely?.outcome, "immune");
  assert.ok((likely?.maxPercent ?? 0) > 0);
});

test("damage preview normalizes implausible captured levels outside LC formats", () => {
  const opponentLowLevel = makePokemon({
    ident: "p2a: Noivern",
    species: "Noivern",
    displayName: "Noivern",
    active: true,
    level: 1,
    stats: undefined,
    types: ["Flying", "Dragon"]
  });
  const opponentNormalLevel = makePokemon({
    ...opponentLowLevel,
    level: 100
  });

  const lowLevelSnapshot = makeSnapshot({
    roomId: "battle-level-normalization-low",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentLowLevel,
      team: [opponentLowLevel]
    },
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });
  const normalLevelSnapshot = makeSnapshot({
    roomId: "battle-level-normalization-normal",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentNormalLevel,
      team: [opponentNormalLevel]
    },
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });

  const lowLikely = findLikelyBand(buildDamagePreview(lowLevelSnapshot)[0]?.bands);
  const normalLikely = findLikelyBand(buildDamagePreview(normalLevelSnapshot)[0]?.bands);
  assert.ok(lowLikely && normalLikely);
  assert.equal(lowLikely?.minPercent, normalLikely?.minPercent);
  assert.equal(lowLikely?.maxPercent, normalLikely?.maxPercent);
});

test("predictor prefers staying in to click a faster known KO move", async () => {
  const yourToxapex = makePokemon({
    ident: "p1a: Toxapex",
    species: "Toxapex",
    displayName: "Toxapex",
    active: true,
    hpPercent: 35,
    knownMoves: ["Surf"],
    stats: { hp: 304, atk: 146, def: 443, spa: 166, spd: 343, spe: 106 },
    types: ["Water", "Poison"]
  });
  const opponentJolteon = makePokemon({
    ident: "p2a: Jolteon",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });
  const snapshot = makeSnapshot({
    roomId: "battle-predictor-stay-attack",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourToxapex,
      team: [yourToxapex]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentJolteon,
      team: [opponentJolteon]
    },
    legalActions: [{ id: "move:surf", kind: "move", label: "Surf", moveName: "Surf" }]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const prediction = intel.opponentActionPrediction;
  assert.ok(prediction);
  assert.equal(prediction?.topActionClass, "stay_attack");
  assert.equal(prediction?.topActions[0]?.moveName, "Thunderbolt");
  assert.ok(prediction?.topActions[0]?.reasons.includes("faster and can KO"));
});

test("predictor prefers a revealed switch immunity when the active mon is threatened", async () => {
  const yourJolteon = makePokemon({
    ident: "p1a: Jolteon",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });
  const opponentGyarados = makePokemon({
    ident: "p2a: Gyarados",
    species: "Gyarados",
    displayName: "Gyarados",
    active: true,
    knownMoves: ["Waterfall"],
    hpPercent: 88,
    stats: { hp: 331, atk: 349, def: 194, spa: 156, spd: 236, spe: 287 },
    types: ["Water", "Flying"]
  });
  const gastrodon = makePokemon({
    ident: "p2b: Gastrodon",
    species: "Gastrodon",
    displayName: "Gastrodon",
    active: false,
    knownMoves: ["Earth Power"],
    ability: "Storm Drain",
    stats: { hp: 426, atk: 185, def: 251, spa: 203, spd: 251, spe: 107 },
    types: ["Water", "Ground"]
  });
  const snapshot = makeSnapshot({
    roomId: "battle-predictor-switch",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourJolteon,
      team: [yourJolteon]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGyarados,
      team: [opponentGyarados, gastrodon]
    },
    legalActions: [{ id: "move:thunderbolt", kind: "move", label: "Thunderbolt", moveName: "Thunderbolt" }]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const prediction = intel.opponentActionPrediction;
  assert.ok(prediction);
  assert.equal(prediction?.topActionClass, "switch");
  assert.ok(prediction?.topActions.some((candidate) => candidate.switchTargetSpecies === "Gastrodon"));
  assert.ok(
    prediction?.topActions[0]?.reasons.includes("slower and threatened by KO")
      || prediction?.reasons.includes("slower and threatened by KO")
  );
});

test("predictor can use a preview-known unrevealed reserve as a switch target", async () => {
  const yourJolteon = makePokemon({
    ident: "p1a: Jolteon-preview-switch",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });
  const opponentGyarados = makePokemon({
    ident: "p2a: Gyarados-preview-switch",
    species: "Gyarados",
    displayName: "Gyarados",
    active: true,
    knownMoves: ["Waterfall"],
    hpPercent: 88,
    stats: { hp: 331, atk: 349, def: 194, spa: 156, spd: 236, spe: 287 },
    types: ["Water", "Flying"]
  });
  const gastrodon = makePokemon({
    ident: "p2b: Gastrodon-preview-switch",
    species: "Gastrodon",
    displayName: "Gastrodon",
    active: false,
    revealed: false,
    knownMoves: [],
    ability: null,
    stats: { hp: 426, atk: 185, def: 251, spa: 203, spd: 251, spe: 107 },
    types: ["Water", "Ground"]
  });
  const snapshot = makeSnapshot({
    roomId: "battle-predictor-preview-switch",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourJolteon,
      team: [yourJolteon]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGyarados,
      team: [opponentGyarados, gastrodon]
    },
    legalActions: [{ id: "move:thunderbolt", kind: "move", label: "Thunderbolt", moveName: "Thunderbolt" }]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const prediction = intel.opponentActionPrediction;
  const gastrodonSwitch = prediction?.topActions.find((candidate) => candidate.switchTargetSpecies === "Gastrodon");

  assert.ok(prediction);
  assert.equal(prediction?.topActionClass, "switch");
  assert.equal(gastrodonSwitch?.source, "previewed_switch");
  assert.ok(
    (gastrodonSwitch?.reasons ?? []).some((reason) => /known reserve|absorbs your best attacks|obvious immunity/i.test(reason))
  );
});

test("predictor surfaces a likely hidden coverage move when priors make it credible", async () => {
  for (let index = 0; index < 3; index += 1) {
    const priorAzelf = makePokemon({
      ident: `p2a: Azelf-prior-${index}`,
      species: "Azelf",
      displayName: "Azelf",
      active: true,
      knownMoves: ["Psychic", "Fire Blast"],
      stats: { hp: 291, atk: 286, def: 176, spa: 349, spd: 176, spe: 361 },
      types: ["Psychic"]
    });
    const priorSnapshot = makeSnapshot({
      roomId: `battle-predictor-hidden-prior-${index}`,
      opponentSide: {
        slot: "p2",
        name: "Opponent",
        active: priorAzelf,
        team: [priorAzelf]
      }
    });
    await updateLocalIntelFromSnapshot(priorSnapshot);
  }

  const yourScizor = makePokemon({
    ident: "p1a: Scizor-hidden",
    species: "Scizor",
    displayName: "Scizor",
    active: true,
    knownMoves: ["Roost"],
    item: null,
    ability: "Technician",
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    types: ["Bug", "Steel"]
  });
  const currentAzelf = makePokemon({
    ident: "p2a: Azelf-current",
    species: "Azelf",
    displayName: "Azelf",
    active: true,
    knownMoves: ["Psychic"],
    stats: { hp: 291, atk: 286, def: 176, spa: 349, spd: 176, spe: 361 },
    types: ["Psychic"]
  });
  const currentSnapshot = makeSnapshot({
    roomId: "battle-predictor-hidden-current",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourScizor,
      team: [yourScizor]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: currentAzelf,
      team: [currentAzelf]
    },
    legalActions: [{ id: "move:roost", kind: "move", label: "Roost", moveName: "Roost" }]
  });

  const intel = await buildLocalIntelSnapshot(currentSnapshot);
  const prediction = intel.opponentActionPrediction;
  const fireBlast = prediction?.topActions.find((candidate) => candidate.moveName === "Fire Blast");
  assert.ok(prediction);
  assert.equal(prediction?.topActionClass, "stay_attack");
  assert.ok(fireBlast);
  assert.equal(fireBlast?.type, "likely_hidden_move");
  assert.ok(fireBlast?.reasons.includes("likely coverage move available"));
});

test("predictor can prefer status or setup on a safe board", async () => {
  const yourClodsire = makePokemon({
    ident: "p1a: Clodsire-predict",
    species: "Clodsire",
    displayName: "Clodsire",
    active: true,
    knownMoves: ["Earthquake"],
    stats: { hp: 394, atk: 186, def: 236, spa: 126, spd: 236, spe: 96 },
    types: ["Poison", "Ground"]
  });
  const opponentSkarmory = makePokemon({
    ident: "p2a: Skarmory-predict",
    species: "Skarmory",
    displayName: "Skarmory",
    active: true,
    hpPercent: 76,
    knownMoves: ["Spikes", "Roost"],
    stats: { hp: 334, atk: 176, def: 416, spa: 136, spd: 176, spe: 176 },
    types: ["Steel", "Flying"]
  });
  const snapshot = makeSnapshot({
    roomId: "battle-predictor-status",
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourClodsire,
      team: [yourClodsire]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentSkarmory,
      team: [opponentSkarmory]
    },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const prediction = intel.opponentActionPrediction;
  assert.ok(prediction);
  assert.equal(prediction?.topActionClass, "status_or_setup");
  assert.ok(prediction?.topActions.some((candidate) => candidate.moveName === "Spikes" || candidate.moveName === "Roost"));
  assert.ok(
    prediction?.topActions[0]?.reasons.includes("safe enough board for setup/status")
      || prediction?.reasons.includes("safe enough board for setup/status")
  );
});

test("predictor weighs setup more early and less later in the game", async () => {
  const yourClodsire = makePokemon({
    ident: "p1a: Clodsire-turn-aware",
    species: "Clodsire",
    displayName: "Clodsire",
    active: true,
    knownMoves: ["Earthquake"],
    hpPercent: 100,
    stats: { hp: 394, atk: 186, def: 276, spa: 136, spd: 336, spe: 106 },
    types: ["Poison", "Ground"]
  });
  const opponentSkarmory = makePokemon({
    ident: "p2a: Skarmory-turn-aware",
    species: "Skarmory",
    displayName: "Skarmory",
    active: true,
    hpPercent: 100,
    knownMoves: ["Spikes", "Roost"],
    stats: { hp: 334, atk: 176, def: 416, spa: 136, spd: 176, spe: 176 },
    types: ["Steel", "Flying"]
  });

  const earlyIntel = await buildLocalIntelSnapshot(makeSnapshot({
    roomId: "battle-predictor-turn-aware-early",
    turn: 2,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourClodsire,
      team: [yourClodsire]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentSkarmory,
      team: [opponentSkarmory]
    },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }]
  }));
  const lateIntel = await buildLocalIntelSnapshot(makeSnapshot({
    roomId: "battle-predictor-turn-aware-late",
    turn: 10,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourClodsire,
      team: [yourClodsire]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentSkarmory,
      team: [opponentSkarmory]
    },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }]
  }));

  const earlySpikes = earlyIntel.opponentActionPrediction?.topActions.find((candidate) => candidate.moveName === "Spikes");
  const lateSpikes = lateIntel.opponentActionPrediction?.topActions.find((candidate) => candidate.moveName === "Spikes");
  assert.ok(Number(earlySpikes?.score ?? 0) > Number(lateSpikes?.score ?? 0));
});

test("predictor only considers First Impression while the opponent is on its first turn out", async () => {
  const yourAlakazam = makePokemon({
    ident: "p1a: Alakazam-predict",
    species: "Alakazam",
    displayName: "Alakazam",
    active: true,
    hpPercent: 62,
    knownMoves: ["Psychic"],
    stats: { hp: 251, atk: 136, def: 126, spa: 369, spd: 226, spe: 372 },
    types: ["Psychic"]
  });
  const opponentSlitherWing = makePokemon({
    ident: "p2a: Slither Wing-predict",
    species: "Slither Wing",
    displayName: "Slither Wing",
    active: true,
    knownMoves: ["First Impression"],
    stats: { hp: 391, atk: 405, def: 266, spa: 131, spd: 256, spe: 287 },
    types: ["Bug", "Fighting"]
  });

  const legalSnapshot = makeSnapshot({
    roomId: "battle-predictor-first-impression-legal",
    turn: 2,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourAlakazam,
      team: [yourAlakazam]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentSlitherWing,
      team: [opponentSlitherWing]
    },
    legalActions: [{ id: "move:psychic", kind: "move", label: "Psychic", moveName: "Psychic" }],
    recentLog: [
      "Slither Wing entered the field.",
      "Turn 2 started."
    ]
  });
  const legalIntel = await buildLocalIntelSnapshot(legalSnapshot);
  assert.equal(legalIntel.opponentActionPrediction?.topActionClass, "stay_attack");
  assert.equal(legalIntel.opponentActionPrediction?.topActions[0]?.moveName, "First Impression");

  const illegalSnapshot = makeSnapshot({
    ...legalSnapshot,
    roomId: "battle-predictor-first-impression-illegal",
    turn: 3,
    recentLog: [
      "Slither Wing entered the field.",
      "Turn 2 started.",
      "Turn 3 started."
    ]
  });
  const illegalIntel = await buildLocalIntelSnapshot(illegalSnapshot);
  assert.ok(!(illegalIntel.opponentActionPrediction?.topActions ?? []).some((candidate) => candidate.moveName === "First Impression"));
});

test("predictor only considers Fake Out while the opponent is on its first turn out", async () => {
  const yourHydreigon = makePokemon({
    ident: "p1a: Hydreigon-predict",
    species: "Hydreigon",
    displayName: "Hydreigon",
    active: true,
    hpPercent: 78,
    knownMoves: ["Dark Pulse"],
    stats: { hp: 323, atk: 226, def: 216, spa: 383, spd: 216, spe: 324 },
    types: ["Dark", "Dragon"]
  });
  const opponentAmbipom = makePokemon({
    ident: "p2a: Ambipom-predict",
    species: "Ambipom",
    displayName: "Ambipom",
    active: true,
    knownMoves: ["Fake Out"],
    stats: { hp: 291, atk: 299, def: 156, spa: 140, spd: 176, spe: 361 },
    types: ["Normal"]
  });

  const legalSnapshot = makeSnapshot({
    roomId: "battle-predictor-fake-out-legal",
    turn: 6,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourHydreigon,
      team: [yourHydreigon]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentAmbipom,
      team: [opponentAmbipom]
    },
    legalActions: [{ id: "move:darkpulse", kind: "move", label: "Dark Pulse", moveName: "Dark Pulse" }],
    recentLog: [
      "Ambipom entered the field.",
      "Turn 6 started."
    ]
  });
  const legalIntel = await buildLocalIntelSnapshot(legalSnapshot);
  assert.equal(legalIntel.opponentActionPrediction?.topActionClass, "stay_attack");
  assert.equal(legalIntel.opponentActionPrediction?.topActions[0]?.moveName, "Fake Out");

  const illegalSnapshot = makeSnapshot({
    ...legalSnapshot,
    roomId: "battle-predictor-fake-out-illegal",
    turn: 7,
    recentLog: [
      "Ambipom entered the field.",
      "Turn 6 started.",
      "Turn 7 started."
    ]
  });
  const illegalIntel = await buildLocalIntelSnapshot(illegalSnapshot);
  assert.ok(!(illegalIntel.opponentActionPrediction?.topActions ?? []).some((candidate) => candidate.moveName === "Fake Out"));
});

test("preview intel predicts an opponent lead from team context and local lead history", async () => {
  const azelf = makePokemon({
    ident: "p2a: Azelf-preview",
    species: "Azelf",
    displayName: "Azelf",
    revealed: true,
    knownMoves: ["Stealth Rock", "Taunt", "U-turn"],
    stats: { hp: 291, atk: 286, def: 176, spa: 349, spd: 176, spe: 361 },
    types: ["Psychic"]
  });
  const donphan = makePokemon({
    ident: "p2b: Donphan-preview",
    species: "Donphan",
    displayName: "Donphan",
    revealed: true,
    knownMoves: ["Rapid Spin", "Earthquake"],
    stats: { hp: 384, atk: 372, def: 372, spa: 140, spd: 156, spe: 136 },
    types: ["Ground"]
  });
  const mienshao = makePokemon({
    ident: "p2c: Mienshao-preview",
    species: "Mienshao",
    displayName: "Mienshao",
    revealed: true,
    knownMoves: ["Fake Out", "U-turn"],
    stats: { hp: 271, atk: 339, def: 156, spa: 176, spd: 156, spe: 339 },
    types: ["Fighting"]
  });

  const hydreigonPreview = makePokemon({
    ident: "p1a: Hydreigon-preview",
    species: "Hydreigon",
    displayName: "Hydreigon",
    revealed: true,
    knownMoves: ["Dark Pulse", "Flamethrower", "U-turn"],
    stats: { hp: 324, atk: 245, def: 216, spa: 349, spd: 216, spe: 324 },
    item: "Choice Scarf",
    types: ["Dark", "Dragon"]
  });
  const scizorPreview = makePokemon({
    ident: "p1b: Scizor-preview",
    species: "Scizor",
    displayName: "Scizor",
    revealed: true,
    knownMoves: ["Bullet Punch", "U-turn", "Roost", "Swords Dance"],
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    item: "Choice Band",
    types: ["Bug", "Steel"]
  });
  const yourPreviewTeam = [hydreigonPreview, scizorPreview];

  for (const [roomId, leadSpecies] of [
    ["battle-lead-history-1", "Azelf"],
    ["battle-lead-history-2", "Azelf"],
    ["battle-lead-history-3", "Mienshao"]
  ] as const) {
    const activeOpponent = leadSpecies === "Azelf" ? { ...azelf, active: true } : leadSpecies === "Mienshao" ? { ...mienshao, active: true } : { ...donphan, active: true };
    const team = [
      { ...azelf, active: leadSpecies === "Azelf" },
      { ...donphan, active: false },
      { ...mienshao, active: leadSpecies === "Mienshao" }
    ];
    await updateLocalIntelFromSnapshot(makeSnapshot({
      roomId,
      turn: 1,
      phase: "turn",
      yourSide: {
        slot: "p1",
        name: "You",
        active: hydreigonPreview,
        team: yourPreviewTeam
      },
      opponentSide: {
        slot: "p2",
        name: "Opponent",
        active: activeOpponent,
        team
      },
      legalActions: [{ id: "move:darkpulse", kind: "move", label: "Dark Pulse", moveName: "Dark Pulse" }],
      recentLog: ["Turn 1 started."]
    }));
  }

  const preview = makeSnapshot({
    roomId: "battle-lead-preview-now",
    turn: 0,
    phase: "preview",
    yourSide: {
      slot: "p1",
      name: "You",
      active: null,
      team: yourPreviewTeam
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: null,
      team: [azelf, donphan, mienshao]
    },
    legalActions: [],
    recentLog: []
  });

  const intel = await buildLocalIntelSnapshot(preview);
  assert.equal(intel.opponentActionPrediction, undefined);
  assert.equal(intel.opponentLeadPrediction?.topLeadSpecies, "Azelf");
  assert.ok((intel.opponentLeadPrediction?.topCandidates ?? []).some((candidate) => candidate.species === "Mienshao"));
  assert.equal(intel.playerLeadRecommendation?.topLeadSpecies, "Hydreigon");
  assert.ok((intel.playerLeadRecommendation?.topCandidates ?? []).some((candidate) => candidate.species === "Scizor"));
  assert.match(intel.playerLeadRecommendation?.summary ?? "", /Best starter Hydreigon/i);
});

test("player lead summary softens to a lean when the opponent lead read is low confidence", async () => {
  const yourLeadA = makePokemon({
    ident: "p1: Hydreigon-preview-lean",
    species: "Hydreigon",
    displayName: "Hydreigon",
    active: false,
    revealed: true,
    knownMoves: ["U-turn", "Dark Pulse"],
    stats: { hp: 324, atk: 309, def: 216, spa: 349, spd: 216, spe: 324 },
    types: ["Dark", "Dragon"]
  });
  const yourLeadB = makePokemon({
    ident: "p1: Scizor-preview-lean",
    species: "Scizor",
    displayName: "Scizor",
    active: false,
    revealed: true,
    knownMoves: ["Bullet Punch", "U-turn"],
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    types: ["Bug", "Steel"]
  });
  const yourLeadC = makePokemon({
    ident: "p1: Rotom-Heat-preview-lean",
    species: "Rotom-Heat",
    displayName: "Rotom-Heat",
    active: false,
    revealed: true,
    knownMoves: ["Volt Switch", "Overheat"],
    stats: { hp: 304, atk: 149, def: 250, spa: 339, spd: 250, spe: 298 },
    types: ["Electric", "Fire"]
  });

  const opponentPreview = [
    makePokemon({ ident: "p2: Donphan-preview-lean", species: "Donphan", displayName: "Donphan", active: false, revealed: true, knownMoves: [], stats: { hp: 384, atk: 372, def: 276, spa: 140, spd: 156, spe: 176 }, types: ["Ground"] }),
    makePokemon({ ident: "p2: Slowking-preview-lean", species: "Slowking", displayName: "Slowking", active: false, revealed: true, knownMoves: [], stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 }, types: ["Water", "Psychic"] }),
    makePokemon({ ident: "p2: Skarmory-preview-lean", species: "Skarmory", displayName: "Skarmory", active: false, revealed: true, knownMoves: [], stats: { hp: 334, atk: 176, def: 416, spa: 136, spd: 176, spe: 176 }, types: ["Steel", "Flying"] }),
    makePokemon({ ident: "p2: Mienshao-preview-lean", species: "Mienshao", displayName: "Mienshao", active: false, revealed: true, knownMoves: [], stats: { hp: 271, atk: 339, def: 156, spa: 226, spd: 156, spe: 339 }, types: ["Fighting"] }),
    makePokemon({ ident: "p2: Rotom-Wash-preview-lean", species: "Rotom-Wash", displayName: "Rotom-Wash", active: false, revealed: true, knownMoves: [], stats: { hp: 304, atk: 166, def: 344, spa: 309, spd: 344, spe: 298 }, types: ["Electric", "Water"] }),
    makePokemon({ ident: "p2: Salamence-preview-lean", species: "Salamence", displayName: "Salamence", active: false, revealed: true, knownMoves: [], stats: { hp: 331, atk: 369, def: 196, spa: 256, spd: 196, spe: 328 }, types: ["Dragon", "Flying"] })
  ];

  const preview = makeSnapshot({
    roomId: "battle-lead-preview-lean",
    turn: 0,
    phase: "preview",
    yourSide: {
      slot: "p1",
      name: "You",
      active: null,
      team: [yourLeadA, yourLeadB, yourLeadC]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: null,
      team: opponentPreview
    },
    legalActions: [],
    recentLog: []
  });

  const recommendation = buildPlayerLeadRecommendation({
    snapshot: preview,
    opponentLeadPrediction: {
      confidenceTier: "low",
      topLeadSpecies: "Donphan",
      topCandidates: [
        { species: "Donphan", score: 54, reasons: ["one plausible lead among many"], riskFlags: [] },
        { species: "Slowking", score: 51, reasons: ["another plausible lead"], riskFlags: [] },
        { species: "Skarmory", score: 49, reasons: ["another plausible lead"], riskFlags: [] },
        { species: "Mienshao", score: 47, reasons: ["another plausible lead"], riskFlags: [] }
      ],
      reasons: ["preview read is thin"],
      riskFlags: ["multiple omitted leads remain plausible"]
    }
  });

  assert.equal(recommendation?.confidenceTier, "low");
  assert.match(recommendation?.summary ?? "", /Lean starter/i);
});

test("omitted preview leads still influence lead ordering under a thin opponent read", () => {
  const hydreigon = makePokemon({
    ident: "p1: Hydreigon-preview-order",
    species: "Hydreigon",
    displayName: "Hydreigon",
    active: false,
    revealed: true,
    knownMoves: ["Flamethrower", "Dark Pulse"],
    stats: { hp: 324, atk: 245, def: 216, spa: 349, spd: 216, spe: 324 },
    types: ["Dark", "Dragon"]
  });
  const rotomWash = makePokemon({
    ident: "p1: Rotom-Wash-preview-order",
    species: "Rotom-Wash",
    displayName: "Rotom-Wash",
    active: false,
    revealed: true,
    knownMoves: ["Thunderbolt", "Hydro Pump"],
    stats: { hp: 304, atk: 166, def: 250, spa: 339, spd: 250, spe: 298 },
    types: ["Electric", "Water"]
  });
  const breloom = makePokemon({
    ident: "p1: Breloom-preview-order",
    species: "Breloom",
    displayName: "Breloom",
    active: false,
    revealed: true,
    knownMoves: ["Mach Punch", "Bullet Seed"],
    stats: { hp: 261, atk: 359, def: 196, spa: 140, spd: 156, spe: 262 },
    types: ["Grass", "Fighting"]
  });

  const preview = makeSnapshot({
    roomId: "battle-lead-preview-ordering",
    turn: 0,
    phase: "preview",
    yourSide: {
      slot: "p1",
      name: "You",
      active: null,
      team: [hydreigon, rotomWash, breloom]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: null,
      team: [
        makePokemon({ ident: "p2: Skarmory-preview-order", species: "Skarmory", displayName: "Skarmory", active: false, revealed: true, knownMoves: ["Brave Bird"], stats: { hp: 334, atk: 176, def: 416, spa: 136, spd: 176, spe: 176 }, types: ["Steel", "Flying"] }),
        makePokemon({ ident: "p2: Forretress-preview-order", species: "Forretress", displayName: "Forretress", active: false, revealed: true, knownMoves: ["Gyro Ball"], stats: { hp: 354, atk: 216, def: 416, spa: 136, spd: 226, spe: 96 }, types: ["Bug", "Steel"] }),
        makePokemon({ ident: "p2: Gastrodon-preview-order", species: "Gastrodon", displayName: "Gastrodon", active: false, revealed: true, knownMoves: ["Earth Power"], stats: { hp: 426, atk: 180, def: 240, spa: 283, spd: 224, spe: 136 }, types: ["Water", "Ground"] }),
        makePokemon({ ident: "p2: Quagsire-preview-order", species: "Quagsire", displayName: "Quagsire", active: false, revealed: true, knownMoves: ["Earthquake"], stats: { hp: 394, atk: 206, def: 226, spa: 149, spd: 206, spe: 96 }, types: ["Water", "Ground"] }),
        makePokemon({ ident: "p2: Primarina-preview-order", species: "Primarina", displayName: "Primarina", active: false, revealed: true, knownMoves: ["Moonblast"], stats: { hp: 364, atk: 168, def: 186, spa: 361, spd: 266, spe: 156 }, types: ["Water", "Fairy"] })
      ]
    },
    legalActions: [],
    recentLog: []
  });

  const predictedSubset = {
    topLeadSpecies: "Skarmory",
    topCandidates: [
      { species: "Skarmory", score: 80, reasons: [], riskFlags: [] },
      { species: "Forretress", score: 78, reasons: [], riskFlags: [] }
    ],
    reasons: [],
    riskFlags: []
  };

  const highConfidence = buildPlayerLeadRecommendation({
    snapshot: preview,
    opponentLeadPrediction: {
      confidenceTier: "high",
      ...predictedSubset
    }
  });
  const lowConfidence = buildPlayerLeadRecommendation({
    snapshot: preview,
    opponentLeadPrediction: {
      confidenceTier: "low",
      ...predictedSubset
    }
  });

  const highHydreigonIndex = (highConfidence?.topCandidates ?? []).findIndex((candidate) => candidate.species === "Hydreigon");
  const highBreloomIndex = (highConfidence?.topCandidates ?? []).findIndex((candidate) => candidate.species === "Breloom");
  const lowHydreigonIndex = (lowConfidence?.topCandidates ?? []).findIndex((candidate) => candidate.species === "Hydreigon");
  const lowBreloomIndex = (lowConfidence?.topCandidates ?? []).findIndex((candidate) => candidate.species === "Breloom");

  assert.ok(highHydreigonIndex >= 0 && highBreloomIndex >= 0);
  assert.ok(lowHydreigonIndex >= 0 && lowBreloomIndex >= 0);
  assert.ok(highHydreigonIndex < highBreloomIndex);
  assert.ok(lowBreloomIndex < lowHydreigonIndex);
});

test("prediction history records what the opponent actually did after a stored prediction", async () => {
  const yourToxapex = makePokemon({
    ident: "p1a: Toxapex-history",
    species: "Toxapex",
    displayName: "Toxapex",
    active: true,
    hpPercent: 35,
    knownMoves: ["Surf"],
    stats: { hp: 304, atk: 146, def: 443, spa: 166, spd: 343, spe: 106 },
    types: ["Water", "Poison"]
  });
  const opponentJolteon = makePokemon({
    ident: "p2a: Jolteon-history",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });

  const before = makeSnapshot({
    roomId: "battle-predictor-history",
    turn: 5,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourToxapex,
      team: [yourToxapex]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentJolteon,
      team: [opponentJolteon]
    },
    legalActions: [{ id: "move:surf", kind: "move", label: "Surf", moveName: "Surf" }],
    recentLog: ["Turn 5 started."]
  });
  await updateLocalIntelFromSnapshot(before);
  const intel = await buildLocalIntelSnapshot(before);
  assert.equal(intel.opponentActionPrediction?.topActionClass, "stay_attack");

  const after = makeSnapshot({
    ...before,
    recentLog: ["Turn 5 started.", "Jolteon used Thunderbolt."]
  });
  await updateLocalIntelFromSnapshot(after);

  const store = await readLocalIntelStore();
  const battle = store.battles["battle-predictor-history"];
  assert.ok(Array.isArray(battle?.predictionHistory));
  const resolvedEntry = battle.predictionHistory.find((entry: any) => entry.actualLabel === "Thunderbolt");
  assert.ok(resolvedEntry);
  assert.equal(resolvedEntry?.predictedClass, "stay_attack");
  assert.equal(resolvedEntry?.actualClass, "stay_attack");
  assert.equal(resolvedEntry?.actualLabel, "Thunderbolt");
  assert.equal(resolvedEntry?.matched, true);
});

test("predictor history does not queue a second pending prediction after the opponent already acted this turn", async () => {
  const yourToxapex = makePokemon({
    ident: "p1a: Toxapex-history-dedupe",
    species: "Toxapex",
    displayName: "Toxapex",
    active: true,
    hpPercent: 42,
    knownMoves: ["Surf"],
    stats: { hp: 304, atk: 146, def: 443, spa: 166, spd: 343, spe: 106 },
    types: ["Water", "Poison"]
  });
  const opponentJolteon = makePokemon({
    ident: "p2a: Jolteon-history-dedupe",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });

  const before = makeSnapshot({
    roomId: "battle-predictor-history-dedupe",
    turn: 9,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourToxapex,
      team: [yourToxapex]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentJolteon,
      team: [opponentJolteon]
    },
    legalActions: [{ id: "move:surf", kind: "move", label: "Surf", moveName: "Surf" }],
    recentLog: ["Turn 9 started."]
  });

  await updateLocalIntelFromSnapshot(before);
  await buildLocalIntelSnapshot(before);

  const after = makeSnapshot({
    ...before,
    capturedAt: new Date(Date.now() + 1000).toISOString(),
    recentLog: ["Turn 9 started.", "Jolteon used Thunderbolt."]
  });
  await updateLocalIntelFromSnapshot(after);
  const afterIntel = await buildLocalIntelSnapshot(after);

  const stats = (afterIntel.debug as any)?.predictionStats?.currentBattle;
  assert.equal(stats?.total, 1);
  assert.equal(stats?.matched, 1);
  assert.equal(stats?.accuracy, 1);

  const store = await readLocalIntelStore();
  const battle = store.battles["battle-predictor-history-dedupe"];
  assert.equal(battle?.pendingPrediction ?? null, null);
  assert.equal(Array.isArray(battle?.predictionHistory) ? battle.predictionHistory.length : 0, 1);
});

test("self recommender prefers a priority KO over slower setup", async () => {
  const yourScizor = makePokemon({
    ident: "p1a: Scizor-self-ko",
    species: "Scizor",
    displayName: "Scizor",
    active: true,
    hpPercent: 72,
    knownMoves: ["Bullet Punch", "Swords Dance", "Roost"],
    item: "Choice Band",
    ability: "Technician",
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    types: ["Bug", "Steel"]
  });
  const yourWeavile = makePokemon({
    ident: "p1b: Weavile-self-ko",
    species: "Weavile",
    displayName: "Weavile",
    stats: { hp: 281, atk: 339, def: 166, spa: 126, spd: 206, spe: 383 },
    types: ["Dark", "Ice"]
  });
  const opponentAlakazam = makePokemon({
    ident: "p2a: Alakazam-self-ko",
    species: "Alakazam",
    displayName: "Alakazam",
    active: true,
    hpPercent: 34,
    knownMoves: ["Focus Blast"],
    stats: { hp: 251, atk: 136, def: 126, spa: 369, spd: 226, spe: 372 },
    types: ["Psychic"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-ko",
    turn: 9,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourScizor,
      team: [yourScizor, yourWeavile]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentAlakazam,
      team: [opponentAlakazam]
    },
    legalActions: [
      { id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" },
      { id: "move:swordsdance", kind: "move", label: "Swords Dance", moveName: "Swords Dance" },
      { id: "switch:weavile", kind: "switch", label: "Switch to Weavile" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const recommendation = intel.selfActionRecommendation;
  assert.ok(recommendation);
  assert.equal(recommendation?.topActionId, "move:bulletpunch");
  assert.equal(recommendation?.rankedActions[0]?.moveName, "Bullet Punch");
  assert.ok(
    recommendation?.rankedActions[0]?.reasons.some((reason) => /priority|KO/i.test(reason))
  );
  assert.ok(
    (recommendation?.rankedActions[0]?.scoreBreakdown ?? []).some((entry) => entry.key === "search" && entry.value > 0)
  );
  assert.ok(
    (recommendation?.rankedActions[0]?.reasons ?? []).some((reason) => /endgame/i.test(reason))
  );
  const prompt = buildAnalysisPrompt(snapshot, {
    localIntel: intel,
    includeToolHint: false,
    analysisMode: "tactical"
  });
  assert.doesNotMatch(prompt, /Deterministic self-recommendation:/);
  assert.match(prompt, /Form an independent ranking from the snapshot and opponent context/i);
});

test("self recommender values hazard removal when multiple reserves are taxed", async () => {
  const yourForretress = makePokemon({
    ident: "p1a: Forretress-hazard-removal",
    species: "Forretress",
    displayName: "Forretress",
    active: true,
    hpPercent: 86,
    knownMoves: ["Rapid Spin", "Volt Switch", "Spikes"],
    item: "Leftovers",
    ability: "Sturdy",
    stats: { hp: 354, atk: 216, def: 416, spa: 156, spd: 176, spe: 96 },
    types: ["Bug", "Steel"]
  });
  const yourSalamence = makePokemon({
    ident: "p1b: Salamence-hazard-removal",
    species: "Salamence",
    displayName: "Salamence",
    hpPercent: 100,
    stats: { hp: 331, atk: 369, def: 196, spa: 256, spd: 196, spe: 328 },
    types: ["Dragon", "Flying"]
  });
  const yourChandelure = makePokemon({
    ident: "p1c: Chandelure-hazard-removal",
    species: "Chandelure",
    displayName: "Chandelure",
    hpPercent: 100,
    stats: { hp: 261, atk: 146, def: 216, spa: 427, spd: 216, spe: 284 },
    types: ["Ghost", "Fire"]
  });
  const opponentHippowdon = makePokemon({
    ident: "p2a: Hippowdon-hazard-removal",
    species: "Hippowdon",
    displayName: "Hippowdon",
    active: true,
    hpPercent: 88,
    knownMoves: ["Earthquake", "Slack Off"],
    item: "Leftovers",
    stats: { hp: 420, atk: 256, def: 368, spa: 136, spd: 176, spe: 148 },
    types: ["Ground"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-hazard-removal",
    turn: 11,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourForretress,
      team: [yourForretress, yourSalamence, yourChandelure]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentHippowdon,
      team: [opponentHippowdon]
    },
    field: {
      weather: null,
      terrain: null,
      pseudoWeather: [],
      yourSideConditions: ["Stealth Rock", "Spikes", "Spikes"],
      opponentSideConditions: []
    },
    legalActions: [
      { id: "move:rapidspin", kind: "move", label: "Rapid Spin", moveName: "Rapid Spin" },
      { id: "move:voltswitch", kind: "move", label: "Volt Switch", moveName: "Volt Switch" },
      { id: "move:spikes", kind: "move", label: "Spikes", moveName: "Spikes" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const recommendation = intel.selfActionRecommendation;
  assert.ok(recommendation);
  assert.equal(recommendation?.topActionId, "move:rapidspin");
  assert.ok(
    recommendation?.rankedActions[0]?.reasons.some((reason) => /removing hazards|hazard/i.test(reason))
  );
  assert.ok(
    (recommendation?.rankedActions[0]?.scoreBreakdown ?? []).some((entry) => entry.key === "hazard" && entry.value > 0)
  );
  assert.equal(intel.hazardSummary, "Your side: Stealth Rock, Spikes x2");
});

test("self recommender prefers an immunity switch when staying gets punished", async () => {
  const yourToxapex = makePokemon({
    ident: "p1a: Toxapex-self-switch",
    species: "Toxapex",
    displayName: "Toxapex",
    active: true,
    hpPercent: 42,
    knownMoves: ["Surf"],
    stats: { hp: 304, atk: 146, def: 443, spa: 166, spd: 343, spe: 106 },
    types: ["Water", "Poison"]
  });
  const yourClodsire = makePokemon({
    ident: "p1b: Clodsire-self-switch",
    species: "Clodsire",
    displayName: "Clodsire",
    stats: { hp: 394, atk: 186, def: 276, spa: 136, spd: 336, spe: 106 },
    ability: "Water Absorb",
    types: ["Poison", "Ground"]
  });
  const opponentJolteon = makePokemon({
    ident: "p2a: Jolteon-self-switch",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-switch",
    turn: 8,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourToxapex,
      team: [yourToxapex, yourClodsire]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentJolteon,
      team: [opponentJolteon]
    },
    legalActions: [
      { id: "move:surf", kind: "move", label: "Surf", moveName: "Surf" },
      { id: "switch:clodsire", kind: "switch", label: "Switch to Clodsire" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const recommendation = intel.selfActionRecommendation;
  const surf = recommendation?.rankedActions.find((candidate) => candidate.actionId === "move:surf");
  assert.ok(recommendation);
  assert.equal(recommendation?.topActionId, "switch:clodsire");
  assert.equal(recommendation?.rankedActions[0]?.switchTargetSpecies, "Clodsire");
  assert.ok(
    recommendation?.rankedActions[0]?.reasons.some((reason) => /safer than the obvious stay line|immunity/i.test(reason))
  );
  assert.ok(
    (recommendation?.rankedActions[0]?.scoreBreakdown ?? []).some((entry) => entry.key === "search" && entry.value > 0)
  );
  assert.ok(
    (surf?.scoreBreakdown ?? []).some((entry) => entry.key === "search" && entry.value < 0)
  );
  assert.ok(
    (surf?.riskFlags ?? []).some((flag) => /still-valuable active/i.test(flag))
  );
});

test("self recommender resolves switch labels to the matching species before nickname collisions", async () => {
  const yourToxapex = makePokemon({
    ident: "p1a: Toxapex-switch-collision",
    species: "Toxapex",
    displayName: "Toxapex",
    active: true,
    hpPercent: 44,
    knownMoves: ["Surf"],
    stats: { hp: 304, atk: 146, def: 443, spa: 166, spd: 343, spe: 106 },
    types: ["Water", "Poison"]
  });
  const taurosCombatNicknamedBlaze = makePokemon({
    ident: "p1b: Tauros-Paldea-Blaze",
    species: "Tauros-Paldea-Combat",
    displayName: "Tauros-Paldea-Blaze",
    hpPercent: 100,
    stats: { hp: 291, atk: 319, def: 216, spa: 156, spd: 176, spe: 350 },
    types: ["Fighting"]
  });
  const taurosBlaze = makePokemon({
    ident: "p1c: Tauros-Paldea-Blaze-actual",
    species: "Tauros-Paldea-Blaze",
    displayName: "Tauros-Paldea-Blaze",
    hpPercent: 100,
    stats: { hp: 291, atk: 319, def: 216, spa: 156, spd: 176, spe: 350 },
    types: ["Fighting", "Fire"]
  });
  const opponentJolteon = makePokemon({
    ident: "p2a: Jolteon-switch-collision",
    species: "Jolteon",
    displayName: "Jolteon",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 271, atk: 166, def: 156, spa: 350, spd: 226, spe: 394 },
    types: ["Electric"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-switch-collision",
    turn: 8,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourToxapex,
      team: [yourToxapex, taurosCombatNicknamedBlaze, taurosBlaze]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentJolteon,
      team: [opponentJolteon]
    },
    legalActions: [
      { id: "move:surf", kind: "move", label: "Surf", moveName: "Surf" },
      {
        id: "switch:taurospaldeablaze",
        kind: "switch",
        label: "Switch to Tauros-Paldea-Blaze",
        target: "Tauros-Paldea-Blaze"
      }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const switchCandidate = intel.selfActionRecommendation?.rankedActions.find(
    (candidate) => candidate.actionId === "switch:taurospaldeablaze"
  );

  assert.ok(switchCandidate);
  assert.equal(switchCandidate?.switchTargetSpecies, "Tauros-Paldea-Blaze");
});

test("reply-aware search penalizes obvious immunity switch targets for moves", async () => {
  const yourGreatTusk = makePokemon({
    ident: "p1a: Great Tusk-search-move",
    species: "Great Tusk",
    displayName: "Great Tusk",
    active: true,
    hpPercent: 100,
    knownMoves: ["Headlong Rush", "Stealth Rock"],
    stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
    types: ["Ground", "Fighting"]
  });
  const opponentGholdengo = makePokemon({
    ident: "p2a: Gholdengo-search-move",
    species: "Gholdengo",
    displayName: "Gholdengo",
    active: true,
    hpPercent: 64,
    knownMoves: ["Make It Rain", "Shadow Ball"],
    stats: { hp: 304, atk: 176, def: 226, spa: 389, spd: 236, spe: 276 },
    types: ["Steel", "Ghost"]
  });
  const opponentDragonite = makePokemon({
    ident: "p2b: Dragonite-search-move",
    species: "Dragonite",
    displayName: "Dragonite",
    hpPercent: 100,
    knownMoves: ["Extreme Speed"],
    stats: { hp: 386, atk: 403, def: 226, spa: 236, spd: 236, spe: 259 },
    types: ["Dragon", "Flying"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-search-move",
    turn: 3,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourGreatTusk,
      team: [yourGreatTusk]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGholdengo,
      team: [opponentGholdengo, opponentDragonite]
    },
    legalActions: [
      { id: "move:headlongrush", kind: "move", label: "Headlong Rush", moveName: "Headlong Rush" },
      { id: "move:stealthrock", kind: "move", label: "Stealth Rock", moveName: "Stealth Rock" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const recommendation = intel.selfActionRecommendation;
  const headlongRush = recommendation?.rankedActions.find((candidate) => candidate.actionId === "move:headlongrush");
  const stealthRock = recommendation?.rankedActions.find((candidate) => candidate.actionId === "move:stealthrock");

  assert.ok(recommendation);
  assert.ok(headlongRush);
  assert.ok(stealthRock);
  assert.ok(
    (headlongRush?.scoreBreakdown ?? []).some((entry) => entry.key === "search" && entry.value < 0)
  );
  assert.ok(
    (stealthRock?.scoreBreakdown ?? []).some((entry) => entry.key === "search" && entry.value > 0)
  );
  assert.ok(
    !(headlongRush?.reasons ?? []).some((reason) => /setup window/i.test(reason))
  );
});

test("reply-aware search penalizes a revealed Air Balloon switch target", async () => {
  const yourGreatTusk = makePokemon({
    ident: "p1a: Great Tusk-search-balloon",
    species: "Great Tusk",
    displayName: "Great Tusk",
    active: true,
    hpPercent: 100,
    knownMoves: ["Headlong Rush", "Close Combat"],
    stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
    types: ["Ground", "Fighting"]
  });
  const opponentGholdengo = makePokemon({
    ident: "p2a: Gholdengo-search-balloon",
    species: "Gholdengo",
    displayName: "Gholdengo",
    active: true,
    hpPercent: 58,
    knownMoves: ["Make It Rain", "Shadow Ball"],
    stats: { hp: 304, atk: 176, def: 226, spa: 389, spd: 236, spe: 276 },
    types: ["Steel", "Ghost"]
  });
  const opponentExcadrill = makePokemon({
    ident: "p2b: Excadrill-search-balloon",
    species: "Excadrill",
    displayName: "Excadrill",
    item: "Air Balloon",
    hpPercent: 100,
    stats: { hp: 361, atk: 369, def: 156, spa: 126, spd: 166, spe: 302 },
    types: ["Ground", "Steel"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-search-balloon",
    turn: 4,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourGreatTusk,
      team: [yourGreatTusk]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGholdengo,
      team: [opponentGholdengo, opponentExcadrill]
    },
    legalActions: [
      { id: "move:headlongrush", kind: "move", label: "Headlong Rush", moveName: "Headlong Rush" },
      { id: "move:closecombat", kind: "move", label: "Close Combat", moveName: "Close Combat" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const recommendation = intel.selfActionRecommendation;
  const headlongRush = recommendation?.rankedActions.find((candidate) => candidate.actionId === "move:headlongrush");
  const switchExcadrill = intel.opponentActionPrediction?.topActions.find((candidate) => candidate.switchTargetSpecies === "Excadrill");
  const switchHeadlongRush = switchExcadrill?.switchTargetPlayerPreview?.find((preview) => preview.moveName === "Headlong Rush");

  assert.ok(headlongRush);
  assert.equal(findLikelyBand(switchHeadlongRush?.bands)?.outcome, "immune");
  assert.ok(
    (headlongRush?.riskFlags ?? []).some((flag) => /blanks this move|air balloon/i.test(flag))
  );
});

test("reply-aware search soft-penalizes a possible hidden absorber switch target", async () => {
  await fs.writeFile(storePath, JSON.stringify({
    version: "0.1.0",
    updatedAt: new Date().toISOString(),
    species: {
      bouffalant: {
        species: "Bouffalant",
        formats: {
          "[Gen 9] UU": {
            battlesSeen: 6,
            leadCount: 0,
            moves: { "Body Slam": 4, "Earthquake": 3, "Close Combat": 2 },
            items: { "Leftovers": 3, "Choice Band": 2 },
            abilities: { "Sap Sipper": 5, "Reckless": 1 },
            teraTypes: { "Water": 1 },
            observedDamage: {},
            observedTakenDamage: {},
            observedDamageByContext: {},
            observedTakenDamageByContext: {},
            speedFirstVs: {},
            speedSecondVs: {},
            speedFasterThan: {},
            speedSlowerThan: {}
          }
        }
      }
    },
    battles: {}
  }, null, 2));

  const yourMeowscarada = makePokemon({
    ident: "p1a: Meowscarada-search-sapsipper",
    species: "Meowscarada",
    displayName: "Meowscarada",
    active: true,
    hpPercent: 100,
    knownMoves: ["Flower Trick", "Knock Off"],
    stats: { hp: 301, atk: 350, def: 176, spa: 156, spd: 176, spe: 383 },
    types: ["Grass", "Dark"]
  });
  const opponentSlowking = makePokemon({
    ident: "p2a: Slowking-search-sapsipper",
    species: "Slowking",
    displayName: "Slowking",
    active: true,
    hpPercent: 61,
    knownMoves: ["Scald", "Future Sight"],
    stats: { hp: 394, atk: 156, def: 196, spa: 236, spd: 350, spe: 96 },
    types: ["Water", "Psychic"]
  });
  const opponentBouffalant = makePokemon({
    ident: "p2b: Bouffalant-search-sapsipper",
    species: "Bouffalant",
    displayName: "Bouffalant",
    revealed: false,
    hpPercent: 100,
    stats: { hp: 401, atk: 350, def: 226, spa: 104, spd: 226, spe: 229 },
    types: ["Normal"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-search-sapsipper",
    turn: 6,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourMeowscarada,
      team: [yourMeowscarada]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentSlowking,
      team: [opponentSlowking, opponentBouffalant]
    },
    legalActions: [
      { id: "move:flowertrick", kind: "move", label: "Flower Trick", moveName: "Flower Trick" },
      { id: "move:knockoff", kind: "move", label: "Knock Off", moveName: "Knock Off" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const recommendation = intel.selfActionRecommendation;
  const flowerTrick = recommendation?.rankedActions.find((candidate) => candidate.actionId === "move:flowertrick");

  assert.ok(flowerTrick);
  assert.ok(
    (flowerTrick?.scoreBreakdown ?? []).some((entry) => entry.key === "search" && entry.value < 0)
  );
  assert.ok(
    (flowerTrick?.riskFlags ?? []).some((flag) => /possible sap sipper switch-in/i.test(flag))
  );
});

test("reply-aware search discounts late hazards when few opposing pivots remain", async () => {
  const yourGreatTusk = makePokemon({
    ident: "p1a: Great Tusk-late-hazard",
    species: "Great Tusk",
    displayName: "Great Tusk",
    active: true,
    hpPercent: 82,
    knownMoves: ["Headlong Rush", "Stealth Rock"],
    stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
    types: ["Ground", "Fighting"]
  });
  const opponentGholdengo = makePokemon({
    ident: "p2a: Gholdengo-late-hazard",
    species: "Gholdengo",
    displayName: "Gholdengo",
    active: true,
    hpPercent: 66,
    knownMoves: ["Make It Rain", "Shadow Ball"],
    stats: { hp: 304, atk: 176, def: 226, spa: 389, spd: 236, spe: 276 },
    types: ["Steel", "Ghost"]
  });
  const opponentDragonite = makePokemon({
    ident: "p2b: Dragonite-late-hazard",
    species: "Dragonite",
    displayName: "Dragonite",
    hpPercent: 100,
    knownMoves: ["Extreme Speed"],
    stats: { hp: 386, atk: 403, def: 226, spa: 236, spd: 236, spe: 259 },
    types: ["Dragon", "Flying"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-late-hazard",
    turn: 13,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourGreatTusk,
      team: [yourGreatTusk]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGholdengo,
      team: [opponentGholdengo, opponentDragonite]
    },
    legalActions: [
      { id: "move:headlongrush", kind: "move", label: "Headlong Rush", moveName: "Headlong Rush" },
      { id: "move:stealthrock", kind: "move", label: "Stealth Rock", moveName: "Stealth Rock" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const recommendation = intel.selfActionRecommendation;
  const stealthRock = recommendation?.rankedActions.find((candidate) => candidate.actionId === "move:stealthrock");

  assert.ok(recommendation);
  assert.ok(stealthRock);
  assert.ok(
    (stealthRock?.scoreBreakdown ?? []).some((entry) => entry.key === "search" && entry.value < 0)
  );
  assert.ok(
    (stealthRock?.riskFlags ?? []).some((flag) => /too slow/i.test(flag))
  );
});

test("reply-aware search rewards safe setup conversion in a thin late game", async () => {
  const yourScizor = makePokemon({
    ident: "p1a: Scizor-setup-convert",
    species: "Scizor",
    displayName: "Scizor",
    active: true,
    hpPercent: 88,
    knownMoves: ["Swords Dance", "Bullet Punch", "Roost"],
    item: "Leftovers",
    ability: "Technician",
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    types: ["Bug", "Steel"]
  });
  const yourHydreigon = makePokemon({
    ident: "p1b: Hydreigon-setup-convert",
    species: "Hydreigon",
    displayName: "Hydreigon",
    stats: { hp: 324, atk: 309, def: 216, spa: 349, spd: 216, spe: 324 },
    types: ["Dark", "Dragon"]
  });
  const opponentBlissey = makePokemon({
    ident: "p2a: Blissey-setup-convert",
    species: "Blissey",
    displayName: "Blissey",
    active: true,
    hpPercent: 74,
    knownMoves: ["Soft-Boiled", "Seismic Toss"],
    stats: { hp: 714, atk: 56, def: 130, spa: 186, spd: 405, spe: 146 },
    types: ["Normal"]
  });
  const opponentLatias = makePokemon({
    ident: "p2b: Latias-setup-convert",
    species: "Latias",
    displayName: "Latias",
    hpPercent: 62,
    knownMoves: ["Draco Meteor"],
    stats: { hp: 301, atk: 176, def: 216, spa: 319, spd: 296, spe: 350 },
    types: ["Dragon", "Psychic"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-setup-convert",
    turn: 12,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourScizor,
      team: [yourScizor, yourHydreigon]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentBlissey,
      team: [opponentBlissey, opponentLatias]
    },
    legalActions: [
      { id: "move:swordsdance", kind: "move", label: "Swords Dance", moveName: "Swords Dance" },
      { id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }
    ]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const recommendation = intel.selfActionRecommendation;
  const swordsDance = recommendation?.rankedActions.find((candidate) => candidate.actionId === "move:swordsdance");

  assert.ok(recommendation);
  assert.ok(swordsDance);
  assert.ok(
    (swordsDance?.scoreBreakdown ?? []).some((entry) => entry.key === "search" && entry.value > 0)
  );
  assert.ok(
    (swordsDance?.reasons ?? []).some((reason) => /setup converts well/i.test(reason))
  );
});

test("unspent Tera uncertainty only drags lines that depend on the type matchup", async () => {
  const yourGreatTusk = makePokemon({
    ident: "p1a: Great Tusk-tera-uncertainty",
    species: "Great Tusk",
    displayName: "Great Tusk",
    active: true,
    hpPercent: 92,
    knownMoves: ["Headlong Rush", "Swords Dance"],
    stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
    types: ["Ground", "Fighting"]
  });
  const opponentGholdengo = makePokemon({
    ident: "p2a: Gholdengo-tera-uncertainty",
    species: "Gholdengo",
    displayName: "Gholdengo",
    active: true,
    hpPercent: 82,
    knownMoves: ["Make It Rain", "Shadow Ball"],
    stats: { hp: 304, atk: 176, def: 226, spa: 389, spd: 236, spe: 276 },
    types: ["Steel", "Ghost"],
    teraType: "Steel",
    terastallized: false
  });

  const unspentSnapshot = makeSnapshot({
    roomId: "battle-tera-uncertainty-unspent",
    turn: 6,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourGreatTusk,
      team: [yourGreatTusk]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGholdengo,
      team: [opponentGholdengo]
    },
    legalActions: [
      { id: "move:headlongrush", kind: "move", label: "Headlong Rush", moveName: "Headlong Rush" },
      { id: "move:swordsdance", kind: "move", label: "Swords Dance", moveName: "Swords Dance" }
    ]
  });
  const spentSnapshot = makeSnapshot({
    ...unspentSnapshot,
    roomId: "battle-tera-uncertainty-spent",
    opponentSide: {
      ...unspentSnapshot.opponentSide,
      active: {
        ...opponentGholdengo,
        terastallized: true
      },
      team: [
        {
          ...opponentGholdengo,
          terastallized: true
        }
      ]
    }
  });

  const unspentIntel = await buildLocalIntelSnapshot(unspentSnapshot);
  const spentIntel = await buildLocalIntelSnapshot(spentSnapshot);
  const unspentHeadlongRush = unspentIntel.selfActionRecommendation?.rankedActions.find((candidate) => candidate.actionId === "move:headlongrush");
  const spentHeadlongRush = spentIntel.selfActionRecommendation?.rankedActions.find((candidate) => candidate.actionId === "move:headlongrush");
  const unspentSwordsDance = unspentIntel.selfActionRecommendation?.rankedActions.find((candidate) => candidate.actionId === "move:swordsdance");
  const spentSwordsDance = spentIntel.selfActionRecommendation?.rankedActions.find((candidate) => candidate.actionId === "move:swordsdance");

  assert.ok(unspentHeadlongRush);
  assert.ok(spentHeadlongRush);
  assert.ok(unspentSwordsDance);
  assert.ok(spentSwordsDance);
  assert.ok((spentHeadlongRush?.score ?? 0) > (unspentHeadlongRush?.score ?? 0));
  assert.ok(!(unspentSwordsDance?.riskFlags ?? []).some((flag) => /tera/i.test(flag)));
  assert.ok((spentSwordsDance?.riskFlags ?? []).every((flag) => !/tera/i.test(flag)));
});

test("reply-aware self search includes close-score fifth actions and all switches", () => {
  const actionIds = selectReplyAwareSearchActionIds([
    { actionId: "move:a", kind: "move", label: "A", score: 80, reasons: [], riskFlags: [] },
    { actionId: "move:b", kind: "move", label: "B", score: 79, reasons: [], riskFlags: [] },
    { actionId: "move:c", kind: "move", label: "C", score: 78, reasons: [], riskFlags: [] },
    { actionId: "move:d", kind: "move", label: "D", score: 77, reasons: [], riskFlags: [] },
    { actionId: "move:e", kind: "move", label: "E", score: 74, reasons: [], riskFlags: [] },
    { actionId: "switch:f", kind: "switch", label: "Switch to F", score: 60, reasons: [], riskFlags: [] }
  ]);

  assert.ok(actionIds.has("move:e"));
  assert.ok(actionIds.has("switch:f"));
});

test("reply-aware opponent search expands beyond three replies when the extra branch still carries weight", () => {
  const replies = weightedOpponentReplies({
    topActionClass: "stay_attack",
    confidenceTier: "medium",
    reasons: [],
    riskFlags: [],
    topActions: [
      { type: "known_move", actionClass: "stay_attack", label: "Attack A", moveName: "Thunderbolt", score: 100, reasons: [], riskFlags: [] },
      { type: "known_move", actionClass: "stay_attack", label: "Attack B", moveName: "Volt Switch", score: 94, reasons: [], riskFlags: [] },
      { type: "known_status_or_setup", actionClass: "status_or_setup", label: "Calm Mind", moveName: "Calm Mind", score: 90, reasons: [], riskFlags: [] },
      { type: "likely_switch", actionClass: "switch", label: "Switch Dragonite", switchTargetSpecies: "Dragonite", source: "revealed_switch", score: 86, reasons: [], riskFlags: [] },
      { type: "likely_hidden_move", actionClass: "stay_attack", label: "Hidden Power", moveName: "Hidden Power", source: "likely", score: 20, reasons: [], riskFlags: [] }
    ]
  });

  assert.equal(replies.length, 4);
  assert.equal(replies[3]?.candidate.switchTargetSpecies, "Dragonite");
});

test("reply-aware opponent search includes dedicated switch targets even when topActions omits them", () => {
  const replies = weightedOpponentReplies({
    topActionClass: "stay_attack",
    confidenceTier: "medium",
    reasons: [],
    riskFlags: [],
    topActions: [
      { type: "known_move", actionClass: "stay_attack", label: "Attack A", moveName: "Thunderbolt", score: 100, reasons: [], riskFlags: [] },
      { type: "known_move", actionClass: "stay_attack", label: "Attack B", moveName: "Volt Switch", score: 94, reasons: [], riskFlags: [] },
      { type: "known_status_or_setup", actionClass: "status_or_setup", label: "Calm Mind", moveName: "Calm Mind", score: 90, reasons: [], riskFlags: [] },
      { type: "known_move", actionClass: "stay_attack", label: "Attack C", moveName: "Shadow Ball", score: 88, reasons: [], riskFlags: [] }
    ],
    topSwitchTargets: [
      { type: "likely_switch", actionClass: "switch", label: "Switch Dragonite", switchTargetSpecies: "Dragonite", source: "revealed_switch", score: 86, reasons: [], riskFlags: [] }
    ]
  });

  assert.ok(replies.some((reply) => reply.candidate.switchTargetSpecies === "Dragonite"));
});

test("reply-aware search now respects a weighted fourth opponent branch", () => {
  const yourGreatTusk = makePokemon({
    ident: "p1a: Great Tusk-fourth-reply",
    species: "Great Tusk",
    displayName: "Great Tusk",
    active: true,
    hpPercent: 100,
    knownMoves: ["Headlong Rush", "Stealth Rock"],
    stats: { hp: 401, atk: 371, def: 298, spa: 126, spd: 219, spe: 339 },
    types: ["Ground", "Fighting"]
  });
  const opponentGholdengo = makePokemon({
    ident: "p2a: Gholdengo-fourth-reply",
    species: "Gholdengo",
    displayName: "Gholdengo",
    active: true,
    hpPercent: 64,
    knownMoves: ["Make It Rain", "Shadow Ball"],
    stats: { hp: 304, atk: 176, def: 226, spa: 389, spd: 236, spe: 276 },
    types: ["Steel", "Ghost"]
  });
  const opponentDragonite = makePokemon({
    ident: "p2b: Dragonite-fourth-reply",
    species: "Dragonite",
    displayName: "Dragonite",
    hpPercent: 100,
    knownMoves: ["Extreme Speed"],
    stats: { hp: 386, atk: 403, def: 226, spa: 236, spd: 236, spe: 259 },
    types: ["Dragon", "Flying"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-self-recommend-fourth-reply",
    turn: 4,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourGreatTusk,
      team: [yourGreatTusk]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentGholdengo,
      team: [opponentGholdengo, opponentDragonite]
    },
    legalActions: [
      { id: "move:headlongrush", kind: "move", label: "Headlong Rush", moveName: "Headlong Rush" },
      { id: "move:stealthrock", kind: "move", label: "Stealth Rock", moveName: "Stealth Rock" }
    ]
  });

  const playerDamagePreview = buildDamagePreview(snapshot);
  const opponentThreatPreview = buildThreatPreview(snapshot, {
    moveCandidates: [
      { name: "Make It Rain", source: "known" },
      { name: "Shadow Ball", source: "known" }
    ]
  });
  const basePrediction = {
    topActionClass: "stay_attack" as const,
    confidenceTier: "medium" as const,
    reasons: [],
    riskFlags: [],
    topActions: [
      { type: "known_move" as const, actionClass: "stay_attack" as const, label: "Make It Rain", moveName: "Make It Rain", score: 100, reasons: [], riskFlags: [] },
      { type: "known_move" as const, actionClass: "stay_attack" as const, label: "Shadow Ball", moveName: "Shadow Ball", score: 94, reasons: [], riskFlags: [] },
      { type: "known_status_or_setup" as const, actionClass: "status_or_setup" as const, label: "Nasty Plot", moveName: "Nasty Plot", score: 90, reasons: [], riskFlags: [] }
    ]
  };

  const withoutFourthReply = buildSelfActionRecommendation({
    snapshot,
    playerDamagePreview,
    opponentThreatPreview,
    opponentActionPrediction: basePrediction
  });
  const withFourthReply = buildSelfActionRecommendation({
    snapshot,
    playerDamagePreview,
    opponentThreatPreview,
    opponentActionPrediction: {
      ...basePrediction,
      topActions: [
        ...basePrediction.topActions,
        { type: "likely_switch" as const, actionClass: "switch" as const, label: "Switch Dragonite", switchTargetSpecies: "Dragonite", source: "revealed_switch" as const, score: 86, reasons: [], riskFlags: [] }
      ]
    }
  });

  const noFourthSearch = withoutFourthReply?.rankedActions.find((candidate) => candidate.actionId === "move:headlongrush")?.scoreBreakdown
    ?.find((entry) => entry.key === "search")?.value ?? 0;
  const withFourthSearch = withFourthReply?.rankedActions.find((candidate) => candidate.actionId === "move:headlongrush")?.scoreBreakdown
    ?.find((entry) => entry.key === "search")?.value ?? 0;

  assert.ok(withFourthSearch < noFourthSearch);
});

test("predictor values early pivot attacks when a safe reserve exists", async () => {
  const yourClodsire = makePokemon({
    ident: "p1a: Clodsire-pivot-test",
    species: "Clodsire",
    displayName: "Clodsire",
    active: true,
    hpPercent: 100,
    knownMoves: ["Earthquake"],
    stats: { hp: 394, atk: 186, def: 276, spa: 136, spd: 336, spe: 106 },
    types: ["Poison", "Ground"]
  });
  const opponentScizor = makePokemon({
    ident: "p2a: Scizor-pivot-test",
    species: "Scizor",
    displayName: "Scizor",
    active: true,
    knownMoves: ["U-turn"],
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    types: ["Bug", "Steel"]
  });
  const opponentSkarmory = makePokemon({
    ident: "p2b: Skarmory-pivot-test",
    species: "Skarmory",
    displayName: "Skarmory",
    knownMoves: ["Roost"],
    stats: { hp: 334, atk: 176, def: 416, spa: 136, spd: 176, spe: 176 },
    types: ["Steel", "Flying"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-predictor-pivot-early",
    turn: 2,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourClodsire,
      team: [yourClodsire]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentScizor,
      team: [opponentScizor, opponentSkarmory]
    },
    legalActions: [{ id: "move:earthquake", kind: "move", label: "Earthquake", moveName: "Earthquake" }]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  const uTurn = intel.opponentActionPrediction?.topActions.find((candidate) => candidate.moveName === "U-turn");
  assert.ok(uTurn);
  assert.ok(
    uTurn?.reasons.includes("pivot keeps initiative")
      || uTurn?.reasons.includes("early-game pivot keeps momentum flexible")
  );
});

test("speed preview respects Iron Ball and Quick Feet modifiers", async () => {
  const hydreigonBase = makeSnapshot({
    roomId: "battle-speed-iron-ball",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Hydreigon-speed-mod",
        species: "Hydreigon",
        displayName: "Hydreigon",
        active: true,
        stats: { hp: 324, atk: 309, def: 216, spa: 349, spd: 216, spe: 324 },
        types: ["Dark", "Dragon"]
      }),
      team: [makePokemon({
        ident: "p2a: Hydreigon-speed-mod",
        species: "Hydreigon",
        displayName: "Hydreigon",
        active: true,
        stats: { hp: 324, atk: 309, def: 216, spa: 349, spd: 216, spe: 324 },
        types: ["Dark", "Dragon"]
      })]
    }
  });

  const baselineHydreigon = await buildLocalIntelSnapshot(hydreigonBase);
  const ironBallHydreigon = await buildLocalIntelSnapshot({
    ...hydreigonBase,
    roomId: "battle-speed-iron-ball-active",
    opponentSide: {
      ...hydreigonBase.opponentSide,
      active: makePokemon({ ...hydreigonBase.opponentSide.active, item: "Iron Ball" }),
      team: [makePokemon({ ...hydreigonBase.opponentSide.active, item: "Iron Ball" })]
    }
  });

  assert.equal(baselineHydreigon.speedPreview?.activeRelation, "slower");
  assert.equal(ironBallHydreigon.speedPreview?.activeRelation, "faster");
  assert.ok(Number(ironBallHydreigon.speedPreview?.effectiveRange?.max ?? 0) < Number(baselineHydreigon.speedPreview?.effectiveRange?.max ?? 0));
  assert.ok((ironBallHydreigon.speedPreview?.evidence ?? []).some((entry) => entry.kind === "item_ability_assumption"));

  const ursaringBase = makeSnapshot({
    roomId: "battle-speed-quick-feet",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Ursaring-speed-mod",
        species: "Ursaring",
        displayName: "Ursaring",
        active: true,
        stats: { hp: 364, atk: 394, def: 186, spa: 146, spd: 186, spe: 229 },
        types: ["Normal"]
      }),
      team: [makePokemon({
        ident: "p2a: Ursaring-speed-mod",
        species: "Ursaring",
        displayName: "Ursaring",
        active: true,
        stats: { hp: 364, atk: 394, def: 186, spa: 146, spd: 186, spe: 229 },
        types: ["Normal"]
      })]
    }
  });

  const baselineUrsaring = await buildLocalIntelSnapshot(ursaringBase);
  const quickFeetUrsaring = await buildLocalIntelSnapshot({
    ...ursaringBase,
    roomId: "battle-speed-quick-feet-active",
    opponentSide: {
      ...ursaringBase.opponentSide,
      active: makePokemon({ ...ursaringBase.opponentSide.active, ability: "Quick Feet", status: "brn" }),
      team: [makePokemon({ ...ursaringBase.opponentSide.active, ability: "Quick Feet", status: "brn" })]
    }
  });

  assert.ok(Number(quickFeetUrsaring.speedPreview?.effectiveRange?.max ?? 0) > Number(baselineUrsaring.speedPreview?.effectiveRange?.max ?? 0));
  assert.ok(Number(quickFeetUrsaring.speedPreview?.effectiveRange?.min ?? 0) > Number(baselineUrsaring.speedPreview?.effectiveRange?.min ?? 0));
  assert.ok((quickFeetUrsaring.speedPreview?.evidence ?? []).some((entry) => entry.kind === "item_ability_assumption"));
});

test("speed preview keeps Choice Scarf as a separate item range and invalidates it after multiple revealed moves", async () => {
  const thundurus = makePokemon({
    ident: "p1a: Thundurus-speed-item",
    species: "Thundurus",
    displayName: "Thundurus",
    active: true,
    knownMoves: ["Thunderbolt"],
    stats: { hp: 301, atk: 266, def: 176, spa: 361, spd: 196, spe: 353 },
    types: ["Electric", "Flying"]
  });
  const swampert = makePokemon({
    ident: "p1b: Swampert-speed-item",
    species: "Swampert",
    displayName: "Swampert",
    active: false,
    knownMoves: ["Earthquake"],
    stats: { hp: 404, atk: 350, def: 216, spa: 206, spd: 216, spe: 218 },
    types: ["Water", "Ground"]
  });
  const arcanineHisui = makePokemon({
    ident: "p2a: Arcanine-Hisui-speed-item",
    species: "Arcanine-Hisui",
    displayName: "Arcanine-Hisui",
    active: true,
    knownMoves: ["Flare Blitz"],
    stats: { hp: 321, atk: 361, def: 196, spa: 196, spd: 196, spe: 289 },
    types: ["Fire", "Rock"]
  });

  const priorSnapshot = (roomId: string) => makeSnapshot({
    roomId,
    yourSide: {
      slot: "p1",
      name: "You",
      active: thundurus,
      team: [thundurus, swampert]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({ ...arcanineHisui, item: "Choice Scarf" }),
      team: [makePokemon({ ...arcanineHisui, item: "Choice Scarf" })]
    }
  });

  await updateLocalIntelFromSnapshot(priorSnapshot("battle-speed-item-prior-1"));
  await updateLocalIntelFromSnapshot(priorSnapshot("battle-speed-item-prior-2"));

  const currentSnapshot = makeSnapshot({
    roomId: "battle-speed-item-live",
    yourSide: {
      slot: "p1",
      name: "You",
      active: thundurus,
      team: [thundurus, swampert]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: arcanineHisui,
      team: [arcanineHisui]
    }
  });

  const withItemRisk = await buildLocalIntelSnapshot(currentSnapshot);
  assert.equal(withItemRisk.speedPreview?.activeRelation, "faster");
  assert.ok(Number(withItemRisk.speedPreview?.possibleRange?.max ?? 0) > Number(withItemRisk.speedPreview?.effectiveRange?.max ?? 0));
  assert.match(withItemRisk.speedPreview?.activeSummary ?? "", /Choice Scarf/i);
  assert.ok((withItemRisk.opponents[0]?.likelyItems ?? []).some((entry) => entry.name === "Choice Scarf"));

  const invalidatedSnapshot = {
    ...currentSnapshot,
    roomId: "battle-speed-item-invalidated",
    recentLog: [
      "Arcanine-Hisui entered the field.",
      "Turn 5 started.",
      "Arcanine-Hisui used Flare Blitz.",
      "Turn 6 started.",
      "Arcanine-Hisui used Head Smash."
    ],
    opponentSide: {
      ...currentSnapshot.opponentSide,
      active: makePokemon({ ...arcanineHisui, knownMoves: ["Flare Blitz", "Head Smash"] }),
      team: [makePokemon({ ...arcanineHisui, knownMoves: ["Flare Blitz", "Head Smash"] })]
    }
  };
  const invalidated = await buildLocalIntelSnapshot(invalidatedSnapshot);
  assert.equal(invalidated.speedPreview?.activeRelation, "faster");
  assert.equal(invalidated.speedPreview?.possibleRange, undefined);
  assert.ok(!(invalidated.opponents[0]?.likelyItems ?? []).some((entry) => entry.name === "Choice Scarf"));
});

test("live likely-item filtering drops stale choice assumptions after reveals, removal, or multiple distinct moves", () => {
  const noStintEvidence = makePokemon({
    species: "Hydreigon",
    displayName: "Hydreigon",
    knownMoves: ["Dark Pulse", "Roost"]
  });
  const sameStintChoiceLocked = makePokemon({
    species: "Hydreigon",
    displayName: "Hydreigon",
    knownMoves: ["Dark Pulse", "Roost"]
  });
  const crossStintReveal = makePokemon({
    species: "Hydreigon",
    displayName: "Hydreigon",
    knownMoves: ["Dark Pulse", "Roost"]
  });
  const removedItem = makePokemon({
    species: "Hydreigon",
    displayName: "Hydreigon",
    knownMoves: ["Dark Pulse"],
    removedItem: "Choice Specs"
  });
  const revealedItem = makePokemon({
    species: "Hydreigon",
    displayName: "Hydreigon",
    knownMoves: ["Dark Pulse"],
    item: "Leftovers"
  });

  assert.deepEqual(
    filterLiveLikelyHeldItemNames("[Gen 9] UU", noStintEvidence, ["Choice Specs", "Leftovers"]),
    ["Choice Specs", "Leftovers"]
  );
  assert.deepEqual(
    filterLiveLikelyHeldItemNames("[Gen 9] UU", sameStintChoiceLocked, ["Choice Specs", "Leftovers"], {
      recentLog: [
        "Hydreigon entered the field.",
        "Turn 7 started.",
        "Hydreigon used Dark Pulse.",
        "Turn 8 started.",
        "Hydreigon used Roost."
      ]
    }),
    ["Leftovers"]
  );
  assert.deepEqual(
    filterLiveLikelyHeldItemNames("[Gen 9] UU", crossStintReveal, ["Choice Specs", "Leftovers"], {
      recentLog: [
        "Hydreigon entered the field.",
        "Turn 5 started.",
        "Hydreigon used Dark Pulse.",
        "Hydreigon entered the field.",
        "Turn 8 started.",
        "Hydreigon used Roost."
      ]
    }),
    ["Choice Specs", "Leftovers"]
  );
  assert.deepEqual(
    filterLiveLikelyHeldItemNames("[Gen 9] UU", removedItem, ["Choice Specs", "Leftovers"]),
    []
  );
  assert.deepEqual(
    filterLiveLikelyHeldItemNames("[Gen 9] UU", revealedItem, ["Choice Specs", "Leftovers"]),
    []
  );
  assert.deepEqual(
    filterLiveLikelyHeldItemEntries("[Gen 9] UU", sameStintChoiceLocked, [
      { name: "Choice Specs", count: 8, share: 0.6, sampleCount: 10, confidenceTier: "strong" },
      { name: "Leftovers", count: 2, share: 0.2, sampleCount: 10, confidenceTier: "usable" }
    ], {
      recentLog: [
        "Hydreigon entered the field.",
        "Turn 7 started.",
        "Hydreigon used Dark Pulse.",
        "Turn 8 started.",
        "Hydreigon used Roost."
      ]
    }).map((entry) => entry.name),
    ["Leftovers"]
  );
});

test("damage preview respects Reflect Light Screen and Aurora Veil", () => {
  const physicalBase = makeSnapshot({
    roomId: "battle-damage-screens-physical",
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: makePokemon({
        ident: "p2a: Noivern-screen-test",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
        types: ["Flying", "Dragon"]
      }),
      team: [makePokemon({
        ident: "p2a: Noivern-screen-test",
        species: "Noivern",
        displayName: "Noivern",
        active: true,
        stats: { hp: 311, atk: 176, def: 166, spa: 291, spd: 196, spe: 379 },
        types: ["Flying", "Dragon"]
      })]
    },
    legalActions: [{ id: "move:bulletpunch", kind: "move", label: "Bullet Punch", moveName: "Bullet Punch" }]
  });

  const physicalBaseBand = findLikelyBand(buildDamagePreview(physicalBase).find((entry) => entry.moveName === "Bullet Punch")?.bands);
  const reflectBand = findLikelyBand(buildDamagePreview({
    ...physicalBase,
    field: { ...physicalBase.field, opponentSideConditions: ["Reflect"] }
  }).find((entry) => entry.moveName === "Bullet Punch")?.bands);
  const physicalVeilBand = findLikelyBand(buildDamagePreview({
    ...physicalBase,
    field: { ...physicalBase.field, opponentSideConditions: ["Aurora Veil"] }
  }).find((entry) => entry.moveName === "Bullet Punch")?.bands);

  assert.ok(Number(reflectBand?.maxPercent ?? 0) < Number(physicalBaseBand?.maxPercent ?? 0));
  assert.ok(Number(physicalVeilBand?.maxPercent ?? 0) < Number(physicalBaseBand?.maxPercent ?? 0));

  const hydreigon = makePokemon({
    ident: "p1a: Hydreigon-screen-test",
    species: "Hydreigon",
    displayName: "Hydreigon",
    active: true,
    knownMoves: ["Dark Pulse"],
    stats: { hp: 324, atk: 309, def: 216, spa: 349, spd: 216, spe: 324 },
    types: ["Dark", "Dragon"]
  });
  const slowking = makePokemon({
    ident: "p2a: Slowking-screen-test",
    species: "Slowking",
    displayName: "Slowking",
    active: true,
    stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
    types: ["Water", "Psychic"]
  });
  const specialBase = makeSnapshot({
    roomId: "battle-damage-screens-special",
    yourSide: {
      slot: "p1",
      name: "You",
      active: hydreigon,
      team: [hydreigon]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: slowking,
      team: [slowking]
    },
    legalActions: [{ id: "move:darkpulse", kind: "move", label: "Dark Pulse", moveName: "Dark Pulse" }]
  });

  const specialBaseBand = findLikelyBand(buildDamagePreview(specialBase).find((entry) => entry.moveName === "Dark Pulse")?.bands);
  const lightScreenBand = findLikelyBand(buildDamagePreview({
    ...specialBase,
    field: { ...specialBase.field, opponentSideConditions: ["Light Screen"] }
  }).find((entry) => entry.moveName === "Dark Pulse")?.bands);
  const specialVeilBand = findLikelyBand(buildDamagePreview({
    ...specialBase,
    field: { ...specialBase.field, opponentSideConditions: ["Aurora Veil"] }
  }).find((entry) => entry.moveName === "Dark Pulse")?.bands);

  assert.ok(Number(lightScreenBand?.maxPercent ?? 0) < Number(specialBaseBand?.maxPercent ?? 0));
  assert.ok(Number(specialVeilBand?.maxPercent ?? 0) < Number(specialBaseBand?.maxPercent ?? 0));
});

test("last-mon boards do not frame opponent switching as part of the recommendation", async () => {
  const yourScizor = makePokemon({
    ident: "p1a: Scizor-last-mon",
    species: "Scizor",
    displayName: "Scizor",
    active: true,
    knownMoves: ["U-turn"],
    item: "Choice Band",
    ability: "Technician",
    stats: { hp: 344, atk: 394, def: 236, spa: 146, spd: 196, spe: 166 },
    types: ["Bug", "Steel"]
  });
  const opponentSlowking = makePokemon({
    ident: "p2a: Slowking-last-mon",
    species: "Slowking",
    displayName: "Slowking",
    active: true,
    hpPercent: 58,
    knownMoves: ["Surf"],
    stats: { hp: 394, atk: 166, def: 196, spa: 236, spd: 316, spe: 96 },
    types: ["Water", "Psychic"]
  });

  const snapshot = makeSnapshot({
    roomId: "battle-last-mon-no-switch-framing",
    turn: 12,
    yourSide: {
      slot: "p1",
      name: "You",
      active: yourScizor,
      team: [yourScizor]
    },
    opponentSide: {
      slot: "p2",
      name: "Opponent",
      active: opponentSlowking,
      team: [opponentSlowking]
    },
    legalActions: [{ id: "move:uturn", kind: "move", label: "U-turn", moveName: "U-turn" }]
  });

  const intel = await buildLocalIntelSnapshot(snapshot);
  assert.notEqual(intel.opponentActionPrediction?.topActionClass, "switch");
  const topAction = intel.selfActionRecommendation?.rankedActions[0];
  assert.ok(topAction);
  assert.ok(!(topAction?.reasons ?? []).some((reason) => /switch/i.test(reason)));
  assert.ok(!/switch/i.test(intel.selfActionRecommendation?.summary ?? ""));
});

test("strategic analysis prompt allows synthetic plan ids and emphasizes broader guidance", () => {
  const snapshot = makeSnapshot({
    roomId: "battle-strategic-prompt",
    phase: "turn",
    legalActions: []
  });

  const prompt = buildAnalysisPrompt(snapshot, {
    analysisMode: "strategic",
    includeToolHint: false
  });

  assert.match(prompt, /Analysis mode: strategic\./);
  assert.match(prompt, /special:plan-primary, special:plan-secondary, special:plan-avoid/);
  assert.match(prompt, /broader strategic guidance/i);
  assert.match(prompt, /preserve vs sack decisions, scouting, tera timing, win conditions, hazard posture/i);
});

test("strategic analysis prompt treats stale snapshots as planning context instead of live clicks", () => {
  const snapshot = makeSnapshot({
    roomId: "battle-strategic-stale",
    legalActions: [{ id: "move:uturn", kind: "move", label: "U-turn", moveName: "U-turn" }]
  });

  const prompt = buildAnalysisPrompt(snapshot, {
    analysisMode: "strategic",
    includeToolHint: false,
    requestContext: {
      tabStatus: "stale_snapshot",
      actionableNow: false,
      snapshotAgeMs: 42_000,
      wait: false,
      forceSwitch: false,
      teamPreview: false
    }
  });

  assert.match(prompt, /Tab status stale_snapshot; actionable now no\./);
  assert.match(prompt, /Only rank current legal actions when requestContext\.actionableNow is true\./);
  assert.match(prompt, /Treat stale or waiting snapshots as planning context, not as permission to recommend an immediate click\./);
});

test("tactical analysis prompt avoids injecting the deterministic self recommendation block", () => {
  const snapshot = makeSnapshot();
  const prompt = buildAnalysisPrompt(snapshot, {
    analysisMode: "tactical",
    includeToolHint: false,
    localIntel: {
      generatedAt: new Date().toISOString(),
      note: "test",
      opponents: [],
      selfActionRecommendation: {
        topActionId: "move:bulletpunch",
        confidenceTier: "high",
        rankedActions: [{
          actionId: "move:bulletpunch",
          kind: "move",
          label: "Bullet Punch",
          score: 91,
          reasons: ["priority cleanup"],
          riskFlags: [],
          moveName: "Bullet Punch"
        }],
        reasons: ["priority cleanup"],
        riskFlags: [],
        summary: "Click Bullet Punch."
      }
    }
  });

  assert.doesNotMatch(prompt, /Deterministic self-recommendation:/);
  assert.match(prompt, /Form an independent ranking from the snapshot and opponent context; do not assume a hidden deterministic best line exists\./);
});

test("gemini prompt allows synthetic strategic ids when the snapshot is not actionable", () => {
  const snapshot = makeSnapshot({
    roomId: "battle-gemini-strategic-stale",
    legalActions: [{ id: "move:uturn", kind: "move", label: "U-turn", moveName: "U-turn" }]
  });

  const prompt = buildGeminiPrompt(snapshot, {
    analysisMode: "strategic",
    requestContext: {
      tabStatus: "waiting_or_not_your_turn",
      actionableNow: false,
      snapshotAgeMs: 1800,
      wait: true,
      forceSwitch: false,
      teamPreview: false
    }
  });

  assert.match(prompt, /Otherwise use only these synthetic strategic IDs: special:plan-primary, special:plan-secondary, special:plan-avoid\./);
  assert.doesNotMatch(prompt, /^Use only action IDs from snapshot\.legalActions\.$/m);
});

test("mock provider strategic mode emits strategic plan actions when no legal actions are present", async () => {
  const { MockProvider } = await import("../providers/mockProvider.js");
  const provider = new MockProvider();
  const snapshot = makeSnapshot({
    roomId: "battle-mock-strategic",
    phase: "turn",
    legalActions: []
  });

  const result = await provider.analyze(snapshot, { analysisMode: "strategic" });

  assert.equal(result.topChoiceActionId, "special:plan-primary");
  assert.equal(result.rankedActions[0]?.actionId, "special:plan-primary");
  assert.match(result.summary, /preserve your highest-value piece/i);
});
