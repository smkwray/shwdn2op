import { z } from "zod";

const identityStatus = z.enum(["resolved", "provisional", "ambiguous"]);
const factSubject = z.object({ side: z.enum(["p1", "p2"]).optional(), instanceId: z.string().optional(), appearanceId: z.string().optional(), candidateInstanceIds: z.array(z.string()).optional() });
const canonicalFact = z.object({
  id: z.string(), kind: z.string(), args: z.array(z.string()), subject: factSubject,
  overlaySpecies: z.string().optional(), references: z.record(z.string(), factSubject), requestSlots: z.array(factSubject).optional(), turn: z.number(),
  source: z.object({ observationId: z.string(), sequence: z.number(), lineIndex: z.number(), channel: z.enum(["protocol", "private-request", "recovery"]), rqid: z.number().optional() }),
  ownerInstanceId: z.string().optional(), supportingFactIds: z.array(z.string()).min(1), identityStatus
});

export const pokemonSnapshotSchema = z.object({
  instanceId: z.string().optional(), appearanceId: z.string().optional(), identityStatus: identityStatus.optional(), presumedInstanceId: z.string().optional(),
  candidateInstanceIds: z.array(z.string()).optional(), evidenceRefs: z.array(z.string()).optional(), canonicalSpecies: z.string().optional(), appearanceMoves: z.array(z.string()).optional(), turnsSinceEntry: z.number().optional(),
  ident: z.string().nullable(),
  species: z.string().nullable(),
  displayName: z.string().nullable(),
  level: z.number().int().nullable(),
  conditionText: z.string().nullable(),
  hpPercent: z.number().nullable(),
  status: z.string().nullable(),
  fainted: z.boolean(),
  active: z.boolean(),
  revealed: z.boolean(),
  boosts: z.record(z.string(), z.number()),
  stats: z.record(z.string(), z.number()).optional(),
  knownMoves: z.array(z.string()),
  item: z.string().nullable(),
  itemProof: z.object({ hazard: z.string(), turn: z.number(), factIds: z.array(z.string()) }).strict().optional(),
  removedItem: z.string().nullable().optional().default(null),
  ability: z.string().nullable(),
  types: z.array(z.string()),
  teraType: z.string().nullable(),
  terastallized: z.boolean(),
  paradoxBoostedStat: z.enum(["atk", "def", "spa", "spd", "spe"]).nullable().optional(),
  unburdenActive: z.boolean().optional(),
  slowStartActive: z.boolean().optional()
});

export const sideSnapshotSchema = z.object({
  slot: z.string(),
  name: z.string().nullable(),
  active: pokemonSnapshotSchema.nullable(),
  team: z.array(pokemonSnapshotSchema)
});

export const legalActionSchema = z.object({
  id: z.string(),
  kind: z.enum(["move", "switch", "team", "special"]),
  label: z.string(),
  moveName: z.string().nullable().optional(),
  moveSlot: z.number().int().min(1).max(4).nullable().optional(),
  targetSlot: z.number().int().min(1).max(24).nullable().optional(),
  terastallize: z.boolean().optional(),
  actorSlot: z.number().int().min(1).max(1).optional(),
  moveId: z.string().optional(),
  teamSpec: z.array(z.number().int().min(1).max(6)).min(1).max(6).optional(),
  choice: z.string().optional(),
  legality: z.enum(["certain", "uncertain", "disabled"]).optional(),
  canUndo: z.boolean().optional(),
  target: z.string().nullable().optional(),
  pp: z.number().int().nullable().optional(),
  disabled: z.boolean().nullable().optional(),
  details: z.string().nullable().optional(),
  uncertainLegal: z.boolean().optional(),
  uncertaintyReason: z.enum(["maybe_disabled", "hidden_trapping_ability"]).optional(),
  reviving: z.boolean().optional(),
  actorAppearanceId: z.string().optional(), targetInstanceId: z.string().optional()
});

export const battleSnapshotSchema = z.object({
  version: z.string(),
  capturedAt: z.string(),
  roomId: z.string(),
  title: z.string().nullable(),
  format: z.string(),
  turn: z.number().int().nonnegative(),
  phase: z.enum(["preview", "turn", "finished", "unknown"]),
  yourSide: sideSnapshotSchema,
  opponentSide: sideSnapshotSchema,
  field: z.object({
    weather: z.string().nullable(),
    terrain: z.string().nullable(),
    pseudoWeather: z.array(z.string()),
    yourSideConditions: z.array(z.string()),
    opponentSideConditions: z.array(z.string())
  }),
  legalActions: z.array(legalActionSchema),
  pendingAttacks: z.array(z.object({
    moveId: z.string().min(1), moveName: z.string().min(1), sourceSide: z.enum(["p1", "p2"]),
    sourceInstanceId: z.string().optional(), sourceAppearanceId: z.string().optional(),
    targetSide: z.enum(["p1", "p2"]), targetPosition: z.literal("a"),
    castTurn: z.number().int().safe().positive(), dueTurn: z.number().int().safe().positive(),
    phase: z.literal("end_of_turn"), status: z.enum(["scheduled", "timing_unknown"]),
    factIds: z.array(z.string().min(1)).min(2)
  }).strict()).optional(),
  turnCoverage: z.object({
    source: z.literal("owned_offline_simulator"),
    turn: z.number().int().safe().positive(),
    turnFactId: z.string().min(1), requestFactId: z.string().min(1),
    fromSequence: z.number().int().safe().positive(), throughSequence: z.number().int().safe().positive()
  }).strict().optional(),
  canonicalEvidence: z.object({
    version: z.string(), facts: z.array(canonicalFact), ambiguities: z.array(z.string()), limitations: z.array(z.string()),
    contributions: z.array(z.object({ id: z.string(), instanceId: z.string(), species: z.string(), factIds: z.array(z.string()).min(1),
      damage: z.object({ turn: z.number(), moveName: z.string(), percent: z.number().positive(), attacker: pokemonSnapshotSchema, defender: pokemonSnapshotSchema, field: z.object({ weather: z.string().nullable(), terrain: z.string().nullable(), pseudoWeather: z.array(z.string()), yourSideConditions: z.array(z.string()), opponentSideConditions: z.array(z.string()) }) }).optional(),
      speed: z.object({ turn: z.number(), relation: z.enum(["first", "second"]), pokemon: pokemonSnapshotSchema, other: pokemonSnapshotSchema, moveName: z.string(), otherMoveName: z.string(), unacted: z.boolean().optional(), field: z.object({ weather: z.string().nullable(), terrain: z.string().nullable(), pseudoWeather: z.array(z.string()), yourSideConditions: z.array(z.string()), opponentSideConditions: z.array(z.string()) }) }).optional(),
      metric: z.enum(["battle-seen", "move", "item", "ability", "tera", "damage", "speed"]), value: z.string(), eligibility: z.enum(["active", "quarantined", "retracted"]) }))
  }).optional(),
  entryObservations: z.array(z.object({
    ident: z.string(), species: z.string(), side: z.string(), turn: z.number().int().nonnegative(),
    hazards: z.array(z.string()), types: z.array(z.string()), damageObserved: z.boolean(), complete: z.boolean(), observationIds: z.array(z.string()).min(1),
    factIds: z.array(z.string()).optional(), instanceId: z.string().optional(), appearanceId: z.string().optional(), identityStatus: identityStatus.optional()
  })).max(64).optional(),
  recentLog: z.array(z.string()),
  rawRequestSummary: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.array(z.string())
});

export const rankedActionSchema = z.object({
  actionId: z.string(),
  label: z.string(),
  score: z.number(),
  rationale: z.string(),
  assumptions: z.array(z.string()),
  risks: z.array(z.string())
});

export const analysisResultSchema = z.object({
  summary: z.string(),
  topChoiceActionId: z.string(),
  rankedActions: z.array(rankedActionSchema),
  assumptions: z.array(z.string()),
  dangerFlags: z.array(z.string()),
  toolsUsed: z.array(z.string()).optional(),
  confidence: z.enum(["low", "medium", "high"])
});

export const analysisRequestContextSchema = z.object({
  tabStatus: z.enum([
    "no_snapshot",
    "room_ambiguous",
    "waiting_or_not_your_turn",
    "stale_snapshot",
    "ready",
    "provider_error"
  ]),
  actionableNow: z.boolean(),
  snapshotAgeMs: z.number().nonnegative().nullable().optional(),
  wait: z.boolean().optional(),
  forceSwitch: z.boolean().optional(),
  teamPreview: z.boolean().optional()
});

export const decisionIdentitySchema = z.object({
  roomId: z.string(),
  rqid: z.number().int().nonnegative().nullable(),
  snapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  legalActionSetHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});

export const analyzeRequestSchema = z.object({
  provider: z.enum(["mock", "codex", "claude", "gemini"]),
  model: z.string().optional(),
  analysisMode: z.enum(["tactical", "strategic"]).optional(),
  requestId: z.string().optional(),
  decisionIdentity: decisionIdentitySchema.optional(),
  requestContext: analysisRequestContextSchema.optional(),
  // HTTP caller-supplied snapshots cannot grant producer authority.
  snapshot: battleSnapshotSchema.omit({ turnCoverage: true, pendingAttacks: true })
});

export const observeSnapshotRequestSchema = z.object({
  decisionIdentity: decisionIdentitySchema.optional(),
  snapshot: battleSnapshotSchema.omit({ turnCoverage: true, pendingAttacks: true })
});

export const saveReplayRequestSchema = z.object({
  roomId: z.string().min(1),
  format: z.string().optional(),
  capturedAt: z.string().optional(),
  protocol: z.string().min(1)
});
