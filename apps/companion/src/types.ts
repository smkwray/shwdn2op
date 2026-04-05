export type ProviderName = "mock" | "codex" | "claude" | "gemini";

export interface LegalAction {
  id: string;
  kind: "move" | "switch" | "special";
  label: string;
  moveName?: string | null | undefined;
  target?: string | null | undefined;
  pp?: number | null | undefined;
  disabled?: boolean | null | undefined;
  details?: string | null | undefined;
}

export interface PokemonSnapshot {
  ident: string | null;
  species: string | null;
  displayName: string | null;
  level: number | null;
  conditionText: string | null;
  hpPercent: number | null;
  status: string | null;
  fainted: boolean;
  active: boolean;
  revealed: boolean;
  boosts: Record<string, number>;
  stats?: Record<string, number> | undefined;
  knownMoves: string[];
  item: string | null;
  removedItem: string | null;
  ability: string | null;
  types: string[];
  teraType: string | null;
  terastallized: boolean;
}

export interface SideSnapshot {
  slot: string;
  name: string | null;
  active: PokemonSnapshot | null;
  team: PokemonSnapshot[];
}

export interface BattleSnapshot {
  version: string;
  capturedAt: string;
  roomId: string;
  title: string | null;
  format: string;
  turn: number;
  phase: "preview" | "turn" | "finished" | "unknown";
  yourSide: SideSnapshot;
  opponentSide: SideSnapshot;
  field: {
    weather: string | null;
    terrain: string | null;
    pseudoWeather: string[];
    yourSideConditions: string[];
    opponentSideConditions: string[];
  };
  legalActions: LegalAction[];
  recentLog: string[];
  rawRequestSummary?: Record<string, unknown> | null | undefined;
  notes: string[];
}

export interface RankedAction {
  actionId: string;
  label: string;
  score: number;
  rationale: string;
  assumptions: string[];
  risks: string[];
}

export interface AnalysisResult {
  summary: string;
  topChoiceActionId: string;
  rankedActions: RankedAction[];
  assumptions: string[];
  dangerFlags: string[];
  toolsUsed?: string[] | undefined;
  confidence: "low" | "medium" | "high";
}

export interface LikelihoodEntry {
  name: string;
  count: number;
  share: number;
  sampleCount: number;
  confidenceTier: "thin" | "usable" | "strong";
}

export interface DamageAssumptionBand {
  label: string;
  minPercent: number | null;
  maxPercent: number | null;
  coverage: "covers_current_hp" | "can_cover_current_hp" | "misses_current_hp" | "unknown";
  outcome?: "damage" | "status" | "immune" | "blocked" | undefined;
  detail?: string | undefined;
}

export interface SurvivalCaveat {
  kind: "Sturdy" | "Focus Sash" | "Multiscale";
  certainty: "known" | "historically_possible";
  note: string;
}

export interface ObservedRangeSummary {
  minPercent: number;
  maxPercent: number;
  sampleCount: number;
  source?: "context" | "aggregate" | undefined;
}

export interface InteractionHint {
  label: string;
  detail: string;
  certainty: "known" | "possible";
}

export type PosteriorEvidenceKind = "priors" | "reveals" | "moves" | "speed" | "damage" | "inference";

export interface PosteriorEvidence {
  kind: PosteriorEvidenceKind;
  label: string;
  detail?: string | undefined;
}

export interface PosteriorHypothesis {
  ability: string | null;
  item: string | null;
  teraType: string | null;
  statArchetype:
    | "fast_phys"
    | "fast_spec"
    | "bulky_phys"
    | "bulky_spec"
    | "physdef"
    | "spdef"
    | "scarf_phys"
    | "scarf_spec";
  weight: number;
  nature: string;
  evs: Partial<Record<"hp" | "atk" | "def" | "spa" | "spd" | "spe", number>>;
  effectiveSpeed?: number | null | undefined;
  support: string[];
}

export interface StatPosteriorBand {
  stat: "atk" | "def" | "spa" | "spd" | "spe";
  min: number;
  likelyLow: number;
  likelyHigh: number;
  max: number;
}

export interface OpponentPosteriorPreview {
  topHypotheses: PosteriorHypothesis[];
  statBands: StatPosteriorBand[];
  confidenceTier: "thin" | "usable" | "strong";
  evidenceKinds: PosteriorEvidenceKind[];
  evidence: PosteriorEvidence[];
  usedFallback: boolean;
}

// ---------------------------------------------------------------------------
// Inference events — observable battle phenomena that imply item/ability/stat
// identity.  Emitted by the P2 event-driven evidence parser from recentLog.
// Consumers: posterior (evidence weights), liveLikelyItems (filtering),
// damage notes (interaction hints), intel store (per-species evidence).
// ---------------------------------------------------------------------------

export type InferenceEventSide = "opponent" | "player";

interface InferenceEventBase {
  side: InferenceEventSide;
  /** Species name (display form, e.g. "Great Tusk"). */
  species: string;
  /** Turn the event was observed on. */
  turn: number;
}

/** Mon took no entry-hazard damage despite hazards being active. */
export interface HazardImmunityEvent extends InferenceEventBase {
  kind: "hazard_immunity";
  /** Which hazards were up (e.g. ["Stealth Rock", "Spikes"]). */
  hazards: string[];
  /** The mon's known types at the time of entry (for disambiguation). */
  monTypes: string[];
}

/** Mon healed a small amount at end of turn (not from a move). */
export interface ResidualHealEvent extends InferenceEventBase {
  kind: "residual_heal";
  healPercent: number;
  /** Source tag if identifiable from log text (e.g. "Leftovers"). */
  source?: string | undefined;
}

/** Mon took self-damage after using an attacking move (~10% → Life Orb). */
export interface AttackRecoilEvent extends InferenceEventBase {
  kind: "attack_recoil";
  recoilPercent: number;
  moveName?: string | undefined;
}

/** Mon gained a status at end of turn from its own item (Flame/Toxic Orb). */
export interface SelfInflictedStatusEvent extends InferenceEventBase {
  kind: "self_inflicted_status";
  status: string;
}

/** Attacker took contact-recoil damage from this mon (Rocky Helmet / Rough Skin / Iron Barbs). */
export interface ContactRecoilEvent extends InferenceEventBase {
  kind: "contact_recoil";
  attackerSpecies: string;
  recoilPercent: number;
  /** Source tag if identifiable (e.g. "Rocky Helmet", "Rough Skin"). */
  source?: string | undefined;
}

/** An item was consumed, destroyed, or popped (Air Balloon, Focus Sash, etc.). */
export interface ItemConsumedEvent extends InferenceEventBase {
  kind: "item_consumed";
  itemName: string;
  /** How it was consumed (e.g. "activated", "knocked_off", "popped", "used"). */
  trigger?: string | undefined;
}

/** An ability was explicitly activated or revealed through a game mechanic. */
export interface AbilityRevealEvent extends InferenceEventBase {
  kind: "ability_reveal";
  abilityName: string;
  /** What triggered the reveal (e.g. "on_entry", "on_contact", "on_switch_out"). */
  trigger?: string | undefined;
}

/** Mon healed when switching out (~33% → Regenerator). */
export interface SwitchHealEvent extends InferenceEventBase {
  kind: "switch_heal";
  healPercent: number;
}

/** Mon was forced to switch after being hit (Eject Button / Eject Pack). */
export interface ForcedSwitchEvent extends InferenceEventBase {
  kind: "forced_switch";
  itemName?: string | undefined;
}

export type InferenceEvent =
  | HazardImmunityEvent
  | ResidualHealEvent
  | AttackRecoilEvent
  | SelfInflictedStatusEvent
  | ContactRecoilEvent
  | ItemConsumedEvent
  | AbilityRevealEvent
  | SwitchHealEvent
  | ForcedSwitchEvent;

export type InferenceEventKind = InferenceEvent["kind"];

// ---------------------------------------------------------------------------
// Per-mon mechanics state — accumulated by the P2 evidence parser during a
// battle.  Not persisted across sessions; rebuilt from log on each snapshot.
// ---------------------------------------------------------------------------

export interface MechanicsState {
  species: string;
  side: InferenceEventSide;
  /** Whether this mon is currently on the field. */
  active: boolean;
  /** Turn the mon most recently entered the field (null if never seen active). */
  entryTurn: number | null;
  /** HP percent at the start of the current turn (for residual-change detection). */
  hpPercentAtTurnStart: number | null;
  /** Items confirmed consumed or removed this battle. */
  consumedItems: string[];
  /** Ability confirmed via explicit activation this battle. */
  revealedAbility: string | null;
  /** All inference events observed for this mon so far. */
  events: InferenceEvent[];
}

export interface DamagePreview {
  actionId: string;
  label: string;
  moveName: string;
  targetName: string;
  targetCurrentHpPercent?: number | null | undefined;
  category: "Physical" | "Special" | "Status";
  bands: DamageAssumptionBand[];
  observedRange?: ObservedRangeSummary | undefined;
  likelyBandSource?: "calc" | "context" | "aggregate" | "posterior" | undefined;
  summary: string;
  survivalCaveats: SurvivalCaveat[];
  interactionHints: InteractionHint[];
}

export interface ThreatTargetPreview {
  species: string;
  targetCurrentHpPercent?: number | null | undefined;
  relation: "faster" | "slower" | "overlap" | "unknown";
  bands: DamageAssumptionBand[];
  observedRange?: ObservedRangeSummary | undefined;
  likelyBandSource?: "calc" | "context" | "aggregate" | "posterior" | undefined;
  summary: string;
  interactionHints: InteractionHint[];
}

export interface ThreatPreview {
  moveName: string;
  moveSource: "known" | "likely";
  targetName: string;
  currentTarget: ThreatTargetPreview;
  switchTargets: ThreatTargetPreview[];
  summary: string;
}

export interface SwitchSpeedMatchup {
  species: string;
  effectiveSpeed: number | null;
  relation: "faster" | "slower" | "overlap" | "unknown";
}

export interface SpeedEvidenceTag {
  kind: "history" | "current_turn_order" | "item_ability_assumption" | "confounded" | "base_range" | "capture_gap";
  label: string;
  detail?: string | undefined;
}

export interface SpeedPreview {
  opponentSpecies: string;
  neutralRange?: { min: number; max: number } | undefined;
  effectiveRange?: { min: number; max: number } | undefined;
  possibleRange?: { min: number; max: number } | undefined;
  yourActiveEffectiveSpeed?: number | undefined;
  activeRelation: "faster" | "slower" | "overlap" | "unknown";
  activeSummary?: string | undefined;
  reason?: "history" | "current_turn_order" | "item_ability_assumption" | "confounded" | "base_range" | "capture_gap" | "unknown" | undefined;
  evidence: SpeedEvidenceTag[];
  confounders: string[];
  switchMatchups: SwitchSpeedMatchup[];
  historyNotes: string[];
}

export type OpponentActionClass = "stay_attack" | "switch" | "status_or_setup" | "unknown";

export interface OpponentActionClassScores {
  stayAttack: number;
  switchOut: number;
  statusOrSetup: number;
}

export interface OpponentActionCandidate {
  type:
    | "known_move"
    | "likely_hidden_move"
    | "likely_switch"
    | "known_status_or_setup"
    | "likely_status_or_setup";
  actionClass: Exclude<OpponentActionClass, "unknown">;
  label: string;
  moveName?: string | undefined;
  source?: "known" | "likely" | "revealed_switch" | "previewed_switch" | undefined;
  switchTargetSpecies?: string | undefined;
  switchTargetPlayerPreview?: DamagePreview[] | undefined;
  score: number;
  reasons: string[];
  riskFlags: string[];
}

export interface OpponentActionPrediction {
  topActionClass: OpponentActionClass;
  confidenceTier: "low" | "medium" | "high";
  topActions: OpponentActionCandidate[];
  topSwitchTargets?: OpponentActionCandidate[] | undefined;
  reasons: string[];
  riskFlags: string[];
  classScores?: OpponentActionClassScores | undefined;
}

export interface OpponentLeadCandidate {
  species: string;
  score: number;
  historicalLeadShare?: number | undefined;
  reasons: string[];
  riskFlags: string[];
}

export interface ExternalCuratedImportInfo {
  formatId: string;
  sourceUrl: string;
  importedAt: string;
  teamsImported: number;
}

export interface ExternalCuratedPriorSupport {
  channel: "external_curated";
  sourceKind: "sample_teams";
  teamCount: number;
  effectiveConfidenceSamples: number;
  import?: ExternalCuratedImportInfo | null | undefined;
}

export interface OpponentLeadPrediction {
  confidenceTier: "low" | "medium" | "high";
  topLeadSpecies: string | null;
  topCandidates: OpponentLeadCandidate[];
  reasons: string[];
  riskFlags: string[];
}

export interface PlayerLeadCandidate {
  species: string;
  score: number;
  reasons: string[];
  riskFlags: string[];
}

export interface PlayerLeadRecommendation {
  confidenceTier: "low" | "medium" | "high";
  topLeadSpecies: string | null;
  topCandidates: PlayerLeadCandidate[];
  reasons: string[];
  riskFlags: string[];
  summary: string;
}

export interface ActionScoreComponent {
  key: string;
  label: string;
  value: number;
}

export interface SelfActionCandidate {
  actionId: string;
  kind: LegalAction["kind"];
  label: string;
  score: number;
  reasons: string[];
  riskFlags: string[];
  moveName?: string | undefined;
  switchTargetSpecies?: string | undefined;
  scoreBreakdown?: ActionScoreComponent[] | undefined;
}

export interface SelfActionRecommendation {
  topActionId: string | null;
  confidenceTier: "low" | "medium" | "high";
  rankedActions: SelfActionCandidate[];
  reasons: string[];
  riskFlags: string[];
  summary: string;
}

export interface OpponentIntelEntry {
  species: string;
  displayName: string | null;
  battlesSeen: number;
  curatedTeamCount?: number | undefined;
  blendedPriorCount?: number | undefined;
  externalCurated?: ExternalCuratedPriorSupport | undefined;
  historicalLeadCount?: number | undefined;
  historicalLeadShare?: number | undefined;
  currentTerastallized?: boolean | undefined;
  revealedMoves: string[];
  revealedItem: string | null;
  revealedAbility: string | null;
  revealedTeraType: string | null;
  likelyMoves: LikelihoodEntry[];
  likelyItems: LikelihoodEntry[];
  likelyAbilities: LikelihoodEntry[];
  likelyTeraTypes: LikelihoodEntry[];
  neutralSpeedRange?: { min: number; max: number } | undefined;
  currentSpeedRange?: { min: number; max: number } | undefined;
  possibleSpeedRange?: { min: number; max: number } | undefined;
  activeYourEffectiveSpeed?: number | undefined;
  activeSpeedRelation?: "faster" | "slower" | "overlap" | "unknown" | undefined;
  currentSpeedSummary?: string | undefined;
  speedReason?: "history" | "current_turn_order" | "item_ability_assumption" | "confounded" | "base_range" | "capture_gap" | "unknown" | undefined;
  speedEvidence?: SpeedEvidenceTag[] | undefined;
  speedConfounders?: string[] | undefined;
  switchSpeedMatchups?: SwitchSpeedMatchup[] | undefined;
  speedNotes: string[];
  posterior?: OpponentPosteriorPreview | undefined;
}

export interface LocalIntelSnapshot {
  generatedAt: string;
  note: string;
  playerDamagePreview?: DamagePreview[] | undefined;
  opponentThreatPreview?: ThreatPreview[] | undefined;
  opponentActionPrediction?: OpponentActionPrediction | undefined;
  opponentLeadPrediction?: OpponentLeadPrediction | undefined;
  playerLeadRecommendation?: PlayerLeadRecommendation | undefined;
  selfActionRecommendation?: SelfActionRecommendation | undefined;
  speedPreview?: SpeedPreview | undefined;
  hazardSummary?: string | undefined;
  survivalCaveats?: string[] | undefined;
  debug?: Record<string, unknown> | undefined;
  opponents: OpponentIntelEntry[];
}

export interface AnalysisRequestContext {
  tabStatus:
    | "no_snapshot"
    | "room_ambiguous"
    | "waiting_or_not_your_turn"
    | "stale_snapshot"
    | "ready"
    | "provider_error";
  actionableNow: boolean;
  snapshotAgeMs?: number | null | undefined;
  wait?: boolean | undefined;
  forceSwitch?: boolean | undefined;
  teamPreview?: boolean | undefined;
}

export interface AnalyzeRequest {
  provider: ProviderName;
  model?: string;
  analysisMode?: "tactical" | "strategic";
  requestId?: string;
  requestContext?: AnalysisRequestContext | undefined;
  snapshot: BattleSnapshot;
}

export interface ProviderDebug {
  provider: ProviderName;
  model: string;
  command?: string | undefined;
  args?: string[] | undefined;
  stdoutSnippet?: string | undefined;
  stderrSnippet?: string | undefined;
  rawOutputSnippet?: string | undefined;
  normalizedFromLoose?: boolean | undefined;
}

export interface AnalyzeResponse {
  analysis: AnalysisResult;
  provider: ProviderName;
  model: string;
  analysisMode?: "tactical" | "strategic" | undefined;
  createdAt: string;
  requestId?: string | undefined;
  providerDebug?: ProviderDebug | undefined;
  localIntel?: LocalIntelSnapshot | undefined;
}
