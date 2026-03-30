import { z } from "zod";

export const pokemonSnapshotSchema = z.object({
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
  removedItem: z.string().nullable().optional().default(null),
  ability: z.string().nullable(),
  types: z.array(z.string()),
  teraType: z.string().nullable(),
  terastallized: z.boolean()
});

export const sideSnapshotSchema = z.object({
  slot: z.string(),
  name: z.string().nullable(),
  active: pokemonSnapshotSchema.nullable(),
  team: z.array(pokemonSnapshotSchema)
});

export const legalActionSchema = z.object({
  id: z.string(),
  kind: z.enum(["move", "switch", "special"]),
  label: z.string(),
  moveName: z.string().nullable().optional(),
  target: z.string().nullable().optional(),
  pp: z.number().int().nullable().optional(),
  disabled: z.boolean().nullable().optional(),
  details: z.string().nullable().optional()
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

export const analyzeRequestSchema = z.object({
  provider: z.enum(["mock", "codex", "claude", "gemini"]),
  model: z.string().optional(),
  requestId: z.string().optional(),
  snapshot: battleSnapshotSchema
});

export const observeSnapshotRequestSchema = z.object({
  snapshot: battleSnapshotSchema
});

export const saveReplayRequestSchema = z.object({
  roomId: z.string().min(1),
  format: z.string().optional(),
  capturedAt: z.string().optional(),
  protocol: z.string().min(1)
});
