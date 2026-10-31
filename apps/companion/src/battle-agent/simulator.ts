import { TRAPPED_SWITCH_ERROR, trappedSwitchRejection } from "./metamon.js";
import { validateMetaMovePrior, type MetaMovePrior } from "../history/metaPriorStore.js";
import fs from "node:fs/promises";
import { Battle, Teams, TeamValidator, extractChannelMessages, PRNG, type PokemonSet } from "./nativeSimulator.js";
import { hashCanonical } from "../../../extension/lib/decision-identity.js";
import { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } from "../history/opponentIntelStore.js";
import { DecisionEngine } from "../state/decisionEngine.js";
import { evaluateDecision } from "../state/decisionEnvelope.js";
import { BattleAgent, BattleActionExecutor, DeterministicBattlePolicy, withinDeadline, type BattlePolicy, type BattlePolicyInput, type BattleAgentDecision, type DecisionEnvelope } from "./battleAgent.js";

export type SimulatorSide = "p1" | "p2";
export type BattleSeed = readonly [number, number, number, number];
export type BattleTeam = string | readonly PokemonSet[];
const SIDES = ["p1", "p2"] as const;

/** Owned full-native offline state only; never a public/live snapshot import.
 * The caller must drain its external output queue before capture and separately
 * retain ledger/rqid/policy state. producerHash is a caller-owned frozen producer
 * binding: pin runtime + data dependencies externally, keep installed modules
 * immutable during a process. Package version alone cannot detect edited builds
 * or promise cross-version serialization compatibility.
 */
export interface OwnedBattleCheckpoint {
  simulatorVersion: string;
  producerHash: string;
  checkpointJson: string;
}
export interface OwnedBattleChoice { side: SimulatorSide; choice: string }
export interface OwnedBattleMessage { type: string; data: string | string[] }

async function ownedSimulatorVersion() {
  const metadata = JSON.parse(await fs.readFile(new URL("../../../../node_modules/pokemon-showdown/package.json", import.meta.url), "utf8"));
  return `${metadata.name}@${metadata.version}`;
}

export async function checkpointOwnedBattle(battle: Battle, producerHash: string): Promise<OwnedBattleCheckpoint> {
  if (typeof producerHash !== "string" || !producerHash.trim()) throw new Error("Owned checkpoint requires a frozen producer hash.");
  if (battle.gen !== 9 || battle.gameType !== "singles") throw new Error("Owned checkpoints support Gen 9 singles only.");
  // Text is mandatory: native object-form restoration aliases log/Pokemon.set.
  const checkpointJson = JSON.stringify(battle.toJSON());
  return { simulatorVersion: await ownedSimulatorVersion(), producerHash, checkpointJson };
}

/** Each call restores a detached branch. No speculative choice touches the
 * original or a sibling; failed branches return neither state nor partial output.
 * Raw native channels (including private/null requests and end teams) are owned
 * data, not a player-safe projection. Route them before use by any player policy.
 */
export async function advanceOwnedBattle(checkpoint: OwnedBattleCheckpoint, choices: readonly OwnedBattleChoice[], expectedProducerHash: string) {
  const captured = structuredClone(checkpoint), inputs = structuredClone(choices);
  if (typeof expectedProducerHash !== "string" || !expectedProducerHash.trim() || captured?.producerHash !== expectedProducerHash) throw new Error("Owned checkpoint producer mismatch.");
  if (captured.simulatorVersion !== await ownedSimulatorVersion()) throw new Error("Owned checkpoint simulator version mismatch.");
  if (typeof captured.checkpointJson !== "string" || !Array.isArray(inputs) || inputs.some((input) => !input || !SIDES.includes(input.side) || typeof input.choice !== "string" || !input.choice.trim())) throw new Error("Invalid owned checkpoint or choice input.");
  const battle = Battle.fromJSON(captured.checkpointJson);
  const emittedMessages: OwnedBattleMessage[] = [];
  try {
    if (battle.gen !== 9 || battle.gameType !== "singles") throw new Error("Owned checkpoints support Gen 9 singles only.");
    battle.restart((type, data) => emittedMessages.push({ type, data: structuredClone(data) }));
    for (const { side, choice } of inputs) {
      if (!battle.choose(side, choice)) throw new Error(`Native simulator rejected ${side} choice.`);
      battle.sendUpdates();
      if (emittedMessages.some(({ data }) => (Array.isArray(data) ? data : data.split("\n")).some((line) => line.startsWith("|error|")))) throw new Error("Native simulator emitted a choice error.");
    }
    return { checkpoint: { ...captured, checkpointJson: JSON.stringify(battle.toJSON()) }, emittedMessages };
  } finally { battle.destroy(); }
}

export interface BattleMatchOptions {
  p1: BattlePolicy;
  p2: BattlePolicy;
  teams: Record<SimulatorSide, BattleTeam>;
  format?: string;
  seed?: BattleSeed;
  maxTurns?: number;
  maxDecisions?: number;
  /** Total wall time, including evaluation and both players. */
  timeoutMs?: number;
  /** Cancels pending policy/execution and reports a cancelled truncation. */
  callerAbortSignal?: AbortSignal;
  decisionDeadlineMs?: number;
  /** Bounded policy resource cleanup; default remains 1 second. */
  cleanupDeadlineMs?: number;
  fallbackDeadlineMs?: number;
  fallback?: "deterministic" | "none";
  /** Retains separately routed player protocol, including that player's requests. */
  trace?: boolean;
  /** Privileged owned-native captures at 1-based trajectory entries, including
   * rejected dispatches. Requires trace; never passed to a player policy. */
  ownedCheckpointAt?: readonly number[];
  /** Explicit normalized cold-start move prior; detached before any match await. */
  movePriors?: MetaMovePrior;
  /** Owned collection policies using their own mechanics may omit advisory analysis. */
  analysisMode?: "policy-only";
  onDecision?: (event: { side: SimulatorSide; envelope: DecisionEnvelope; decision: BattleAgentDecision; choice: string }) => void;
}

export interface SimulatorDecisionRecord {
  side: SimulatorSide;
  turn: number;
  rqid: number;
  requestId: string;
  identity: BattleAgentDecision["identity"];
  policyId: string;
  fallback: boolean;
  inputResultHash: string;
  actionId: string;
  choice: string;
  accepted: boolean;
  latencyMs: number;
  reason: string | null;
}

/** Full-information evaluator data. Prefix pointers are not serialized
 * canonical ledgers, evaluation contexts or recurrent policy checkpoints. */
export interface OwnedDecisionCheckpoint {
  contractVersion: "owned-offline-decision-checkpoint@1";
  trajectoryIndex: number;
  side: SimulatorSide;
  roomId: string;
  requestId: string;
  identity: BattleAgentDecision["identity"];
  inputResultHash: string;
  engineVersion: string;
  nodeVersion: string;
  checkpoint: OwnedBattleCheckpoint;
  checkpointHash: string;
  externalContext: Record<SimulatorSide, { rqid: number; sequence: number; tracePrefixLength: number }>;
}

export interface SimulatorError {
  side: SimulatorSide | null;
  turn: number;
  rqid: number | null;
  stage: "policy" | "simulator" | "harness";
  message: string;
}

function positiveInteger(name: string, value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  return value;
}

function seedText(seed: BattleSeed): `${number},${string}` {
  if (seed.length !== 4 || seed.some((word) => !Number.isInteger(word) || word < 0 || word > 65535)) throw new Error("Seed must contain four integers from 0 to 65535.");
  return `${seed[0]},${seed[1]},${seed[2]},${seed[3]}`;
}

/** Independent policy RNG: never consumes or inspects the simulator's PRNG. */
export class RandomBattlePolicy implements BattlePolicy {
  readonly id: string;
  private rng: PRNG;
  constructor(seed: BattleSeed = [5, 6, 7, 8]) {
    this.id = `random:${seedText(seed)}`;
    this.rng = new PRNG(seedText(seed));
  }
  async decide({ requestId, envelope }: BattlePolicyInput) {
    const actions = envelope.semantic.snapshot.legalActions.filter((action) => !action.disabled && action.choice);
    const action = actions[this.rng.random(actions.length)];
    if (!action) throw new Error("No enabled random action.");
    return { requestId, identity: envelope.semantic.identity, actionId: action.id };
  }
}

/** Offline, singles-only match. No sockets, browser, persistent intel, hidden
 * state projections, or speculative choose() probes are used. Only the selected
 * exact action.choice reaches the official simulator through the executor.
 *
 * Local transport framing: Native simulator requests have no server-owned rqid. Each
 * emitted private request is assigned a monotonically increasing per-side rqid.
 * Only an exact trapped rejection retains its rqid for the corrected request.
 * A rejected choice without an updated request reissues only that side's last
 * genuine request under a fresh rqid, permitting a bounded explicit fallback.
 */
export async function runBattleMatch(options: BattleMatchOptions) {
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof runBattleMatchCore>> | undefined;
  let cleanupDeadlineMs = 1000;
  try {
    cleanupDeadlineMs = positiveInteger("cleanupDeadlineMs", options.cleanupDeadlineMs ?? 1000, 300_000);
    const movePriors = options.movePriors === undefined ? undefined : validateMetaMovePrior(structuredClone(options.movePriors));
    result = await runBattleMatchCore({ ...options, ...(movePriors ? { movePriors } : {}) });
    return result;
  } finally {
    // Policies can acquire resources before the match starts. Preflight and
    // producer failures require the same bounded cleanup as a played match.
    await Promise.all([...new Set([options.p1, options.p2])].map(async (policy) => {
      if (!policy.close) return;
      try {
        await withinDeadline(Date.now() + cleanupDeadlineMs, undefined, async () => policy.close!());
      } catch {
        if (result) {
          result.status = "failed"; result.outcome = null; result.winner = null; result.stopReason = "error";
          result.errors.push({ side: null, turn: result.turn, rqid: null, stage: "harness", message: "Policy cleanup failed." });
        }
        // Preserve the original preflight rejection when no report exists.
      }
    }));
    if (result) result.elapsedMs = Date.now() - startedAt;
  }
}

async function runBattleMatchCore(options: BattleMatchOptions) {
  // Freeze selection before the first await; callers cannot retarget a run.
  if (options.ownedCheckpointAt !== undefined && !Array.isArray(options.ownedCheckpointAt)) throw new Error("ownedCheckpointAt must be an array of unique positive safe integers.");
  const ownedCheckpointAt = options.ownedCheckpointAt === undefined ? undefined : [...options.ownedCheckpointAt];
  if (ownedCheckpointAt?.some((index) => !Number.isSafeInteger(index) || index < 1) || new Set(ownedCheckpointAt).size !== (ownedCheckpointAt?.length ?? 0)) throw new Error("ownedCheckpointAt must contain unique positive safe integers.");
  if (ownedCheckpointAt !== undefined && !options.trace) throw new Error("ownedCheckpointAt requires trace.");
  const ownedCheckpoints: OwnedDecisionCheckpoint[] = [];
  const seed: BattleSeed = [...(options.seed ?? [1, 2, 3, 4])];
  const rngSeed = seedText(seed);
  const maxTurns = positiveInteger("maxTurns", options.maxTurns ?? 200, 1000);
  const maxDecisions = positiveInteger("maxDecisions", options.maxDecisions ?? maxTurns * 12 + 12, 100_000);
  const timeoutMs = positiveInteger("timeoutMs", options.timeoutMs ?? 1_800_000, 86_400_000);
  const decisionDeadlineMs = positiveInteger("decisionDeadlineMs", options.decisionDeadlineMs ?? 30_000, 300_000);
  const fallbackDeadlineMs = positiveInteger("fallbackDeadlineMs", options.fallbackDeadlineMs ?? 5_000, 300_000);
  if (options.p1 === options.p2 && options.p1.observe) throw new Error("Recurrent policies require a separate instance per player.");
  if (options.analysisMode !== undefined && (options.analysisMode !== "policy-only"
    || SIDES.some(side => options[side].requiresSupportedMechanics !== false))) {
    throw new Error("Policy-only analysis requires two policies with independent mechanics.");
  }
  const validator = new TeamValidator(options.format ?? "gen9uu");
  if (validator.gen !== 9 || validator.format.gameType !== "singles") throw new Error("Offline harness supports Gen 9 singles only.");
  const teams = {} as Record<SimulatorSide, string>;
  for (const side of SIDES) {
    const input = options.teams[side];
    const team = typeof input === "string" ? Teams.import(input) : structuredClone([...input]);
    if (!team?.length) throw new Error(`${side}: empty or unreadable team.`);
    const problems = validator.validateTeam(team);
    if (problems?.length) throw new Error(`${side} team rejected by ${validator.format.id}: ${problems.join("; ")}`);
    teams[side] = Teams.pack(team);
  }
  const metadata = JSON.parse(await fs.readFile(new URL("../../../../node_modules/pokemon-showdown/package.json", import.meta.url), "utf8"));
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const producerSources = await Promise.all(["simulator", "nativeSimulator", "battleAgent", "opencode", "decisionCard", "strategicLedger", "metamon", "tacticalGuards", "rerank"].map(async (name) =>
    [name, await fs.readFile(new URL(`./${name}.${extension}`, import.meta.url), "utf8")]));
  producerSources.push(["metamon-worker.py", await fs.readFile(new URL("../../../../scripts/metamon-worker.py", import.meta.url), "utf8")]);
  const producer = await hashCanonical(producerSources);
  const startedAt = Date.now(), expiresAt = startedAt + timeoutMs;
  const roomId = `battle-${validator.format.id}-offline`;
  const queue: Array<{ type: string; data: string }> = [];
  const replay: string[] = [];
  const playerTraces: Record<SimulatorSide, string[]> = { p1: [], p2: [] };
  const trajectory: SimulatorDecisionRecord[] = [];
  const errors: SimulatorError[] = [];
  const fallbacks: Array<{ side: SimulatorSide; turn: number; rqid: number; reason: string; policyId: string }> = [];
  const engineVersions = new Set<string>();
  let turn = 0, attempts = 0;
  let outcome: "win" | "tie" | null = null;
  let winner: SimulatorSide | null = null;
  let stopReason: "max_turns" | "max_decisions" | "deadline" | "cancelled" | "error" | null = null;
  const simulator = new Battle({ formatid: validator.format.id, seed: rngSeed,
    send(type, data) { if (type !== "end") queue.push({ type, data: Array.isArray(data) ? data.join("\n") : data }); } });
  // The simulator's end payload contains both teams. Deliberately discard it.
  const makePlayer = async (side: SimulatorSide) => {
    const engine = new DecisionEngine({ source: "owned_offline_simulator" }), sessionId = `offline-${side}`;
    const player = {
      side, engine, sessionId, policy: options[side],
      context: { ...await createEphemeralIntelEvaluationContext(options.movePriors),
        ...(options.analysisMode ? { analysisMode: options.analysisMode } : {}) },
      sequence: 0, rqid: 0, ready: false, request: null as Record<string, unknown> | null,
      trappedRetry: false, trappedRecovered: false,
      rejected: new Set<string>(), retry: null as string | null,
      stats: { requests: 0, decisions: 0, actions: 0, moves: 0, switches: 0, tera: 0, previews: 0, errors: 0, fallbacks: 0,
        policyLatencyMs: [] as number[], evaluationLatencyMs: [] as number[] },
      executor: new BattleActionExecutor(engine, sessionId, (choice) => simulator.choose(side, choice))
    };
    return player;
  };
  const players = { p1: await makePlayer("p1"), p2: await makePlayer("p2") };
  type Player = typeof players.p1;
  const observe = async (player: Player, data: string) => {
    if (!data) return;
    if (options.trace) playerTraces[player.side].push(data);
    const current = await player.engine.ingest({ sessionId: player.sessionId, roomId, sequence: ++player.sequence,
      observationId: `${player.side}-${player.sequence}`, source: "protocol", data: `>${roomId}\n${data}` });
    if (current.snapshot) player.context = await projectCanonicalSnapshots([current.snapshot], player.context);
    if (player.policy.observe) {
      const deadlineAt = Math.min(expiresAt, Date.now() + decisionDeadlineMs);
      await withinDeadline(deadlineAt, matchAbort.signal, async (signal, check) => {
        check();
        await player.policy.observe!(data, { roomId, side: player.side, format: validator.format.id,
          sequence: player.sequence, identity: structuredClone(current.identity ?? null) }, { deadlineAt, signal });
        check();
      });
    }
  };
  const frameRequest = async (player: Player, request: Record<string, unknown>, reissue = false) => {
    const own = request.side as { id?: unknown } | undefined;
    if (own?.id !== player.side) throw new Error(`Wrong private request recipient: ${player.side}.`);
    const trapped = player.trappedRetry;
    if (trapped) trappedSwitchRejection(`|request|${JSON.stringify({ ...request, rqid: player.rqid })}`, player.rqid, true);
    if (!reissue) { player.rejected.clear(); player.retry = null; }
    player.request = structuredClone(request);
    player.stats.requests++;
    player.ready = request.wait !== true;
    await observe(player, `|request|${JSON.stringify({ ...request, rqid: trapped ? player.rqid : ++player.rqid })}`);
    if (trapped) { player.trappedRetry = false; player.trappedRecovered = true; }
  };
  const flush = async () => {
    for (const { type, data } of queue.splice(0)) {
      if (type === "update") {
        const channels = extractChannelMessages(data, [0, 1, 2]);
        replay.push(...channels[0]);
        for (const line of channels[0]) {
          if (line.startsWith("|turn|")) turn = Number(line.slice(6));
          if (line.startsWith("|win|")) { outcome = "win"; winner = line.slice(5) === "Offline p1" ? "p1" : "p2"; }
          if (line === "|tie|" || line === "|tie") { outcome = "tie"; winner = null; }
        }
        await observe(players.p1, channels[1].join("\n"));
        await observe(players.p2, channels[2].join("\n"));
      } else if (type === "sideupdate") {
        const newline = data.indexOf("\n"), side = data.slice(0, newline);
        if (side !== "p1" && side !== "p2") throw new Error("Unexpected simulator recipient.");
        const player = players[side];
        for (const line of data.slice(newline + 1).split("\n")) {
          if (line.startsWith("|request|")) {
            const request = JSON.parse(line.slice(9));
            if (request) await frameRequest(player, request);
            else {
              player.ready = false;
              // Unsupported nonempty input must fail closed, never disappear
              // from a stream claiming complete chronological coverage.
              await observe(player, line);
              throw new Error("Simulator request was cleared; further decisions are unsupported.");
            }
          } else {
            if (line === TRAPPED_SWITCH_ERROR) {
              const attempt = trajectory.at(-1);
              if (!attempt || attempt.side !== side || attempt.accepted || !attempt.choice.startsWith("switch ") || player.trappedRetry) throw new Error("Unexpected trapped rejection.");
              player.trappedRetry = true;
            }
            await observe(player, line);
            if (line.startsWith("|error|") && line !== TRAPPED_SWITCH_ERROR) {
              player.stats.errors++;
              errors.push({ side, turn, rqid: player.rqid, stage: "simulator", message: line.slice(7) });
            }
          }
        }
      } else throw new Error(`Unexpected simulator message type: ${type}.`);
    }
  };
  const evaluate = async (player: Player) => {
    const start = Date.now();
    const current = await player.engine.read(player.sessionId, roomId);
    if (!current.identity) throw new Error(`${player.side} has no decision identity.`);
    const envelope = await evaluateDecision(player.engine, player.sessionId, current.identity, player.context);
    player.stats.evaluationLatencyMs.push(Date.now() - start);
    engineVersions.add(envelope.semantic.engineVersion);
    return envelope;
  };
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  const fallbackPolicy = (player: Player): BattlePolicy => ({
    id: "deterministic-fallback",
    // Exclude only actions already rejected by this player's real choose call.
    // This is never an all-actions legality probe (which could reveal traps).
    decide(input) {
      const visible = structuredClone(input);
      visible.envelope.semantic.snapshot.legalActions = visible.envelope.semantic.snapshot.legalActions.filter((action) => !player.rejected.has(action.id));
      return new DeterministicBattlePolicy().decide(visible);
    }
  });
  const matchAbort = new AbortController();
  const stop = (reason: "cancelled" | "deadline") => {
    if (matchAbort.signal.aborted) return;
    stopReason = reason;
    // Caller reasons can contain private data; retain only the classification.
    matchAbort.abort(new Error(reason === "cancelled" ? "Match cancelled by caller." : "Match deadline expired."));
  };
  const cancel = () => stop("cancelled");
  const check = () => {
    if (Date.now() >= expiresAt) stop("deadline");
    matchAbort.signal.throwIfAborted();
  };
  // Keep a stalled policy alive until its deadline, even if it creates no I/O
  // handles (AbortSignal.timeout alone uses an unref'ed timer in Node).
  const deadlineTimer = setTimeout(() => stop("deadline"), Math.max(1, expiresAt - Date.now()));
  try {
    options.callerAbortSignal?.addEventListener("abort", cancel, { once: true });
    if (options.callerAbortSignal?.aborted) cancel();
    check();
    for (const side of SIDES) if (Date.now() < expiresAt) players[side].executor.authorize(roomId, expiresAt);
    for (const side of SIDES) await observe(players[side], "|init|battle");
    simulator.setPlayer("p1", { name: "Offline p1", team: teams.p1 });
    simulator.setPlayer("p2", { name: "Offline p2", team: teams.p2 });
    simulator.sendUpdates();
    await flush();
    while (!outcome) {
      check();
      // Finish all subrequests of turn maxTurns, but never choose on maxTurns+1.
      if (turn > maxTurns) { stopReason = "max_turns"; break; }
      if (attempts >= maxDecisions) { stopReason = "max_decisions"; break; }
      const player = SIDES.map((side) => players[side]).find((player) => player.ready);
      if (!player) throw new Error("Simulator stalled without a player request or terminal result.");
      let envelope = await evaluate(player);
      check();
      let fallbackReason = player.retry;
      const decide = async (policy: BattlePolicy, budget: number) => {
        check();
        if (attempts >= maxDecisions) throw new Error("Decision attempt cap reached.");
        const remaining = Math.min(budget, expiresAt - Date.now());
        if (remaining <= 0) throw new Error("Match deadline expired.");
        attempts++; player.stats.decisions++;
        const start = Date.now();
        try { return await new BattleAgent(player.engine, player.sessionId, policy).decide(envelope, {
          deadlineMs: remaining, signal: matchAbort.signal, requestId: `${player.side}-${player.rqid}-attempt-${attempts}`
        }); } finally { player.stats.policyLatencyMs.push(Date.now() - start); }
      };
      let decision: BattleAgentDecision | undefined;
      if (!fallbackReason) {
        try { decision = await decide(player.policy, decisionDeadlineMs); }
        catch (error) {
          check();
          fallbackReason = errorText(error);
          player.stats.errors++;
          errors.push({ side: player.side, turn, rqid: player.rqid, stage: "policy", message: fallbackReason });
        }
      }
      if (fallbackReason) {
        check();
        if (attempts >= maxDecisions) { stopReason = "max_decisions"; break; }
        if (options.fallback === "none") throw new Error(`Fallback disabled: ${fallbackReason}`);
        player.stats.fallbacks++;
        fallbacks.push({ side: player.side, turn, rqid: player.rqid, reason: fallbackReason, policyId: "deterministic-fallback" });
        // Refresh identity/evaluation and give the fallback its own full budget.
        envelope = await evaluate(player);
        decision = await decide(fallbackPolicy(player), fallbackDeadlineMs);
      }
      if (!decision) throw new Error("No decision produced.");
      const action = envelope.semantic.snapshot.legalActions.find((entry) => entry.id === decision.actionId)!;
      const record: SimulatorDecisionRecord = { side: player.side, turn, rqid: player.rqid, requestId: decision.requestId,
        identity: structuredClone(decision.identity),
        policyId: decision.policyId, fallback: Boolean(fallbackReason), inputResultHash: decision.inputResultHash,
        actionId: action.id, choice: action.choice!, accepted: false, latencyMs: decision.latencyMs, reason: decision.reason ?? null };
      trajectory.push(record);
      if (ownedCheckpointAt?.includes(trajectory.length)) {
        const capture = await withinDeadline(decision.deadlineAt, matchAbort.signal, async (_signal, checkCapture) => {
          checkCapture();
          if (queue.length) throw new Error("Owned checkpoint requires a drained output queue.");
          const externalContext = Object.fromEntries(SIDES.map((side) => [side, { rqid: players[side].rqid,
            sequence: players[side].sequence, tracePrefixLength: playerTraces[side].length }])) as OwnedDecisionCheckpoint["externalContext"];
          const checkpoint = await checkpointOwnedBattle(simulator, producer);
          checkCapture();
          const checkpointHash = await hashCanonical(checkpoint.checkpointJson);
          checkCapture();
          return { contractVersion: "owned-offline-decision-checkpoint@1" as const, trajectoryIndex: trajectory.length,
            side: player.side, roomId, requestId: record.requestId, identity: structuredClone(record.identity),
            inputResultHash: record.inputResultHash, engineVersion: envelope.semantic.engineVersion,
            nodeVersion: process.version, checkpoint, checkpointHash, externalContext };
        });
        // Retain only a completed, still-in-budget capture. Late work cannot append.
        ownedCheckpoints.push(capture);
      }
      const priorRqid = player.rqid;
      player.trappedRecovered = false;
      let rejection: unknown;
      try { await player.executor.execute(decision, { signal: matchAbort.signal }); record.accepted = true; }
      catch (error) { rejection = error; }
      if (record.accepted) {
        player.ready = false; player.retry = null;
        player.stats.actions++;
        if (action.kind === "move") player.stats.moves++;
        if (action.kind === "switch") player.stats.switches++;
        if (action.kind === "team") player.stats.previews++;
        if (action.terastallize) player.stats.tera++;
        if (player.policy.commit) await withinDeadline(decision.deadlineAt, matchAbort.signal, async (signal) => {
          await player.policy.commit!({ requestId: decision.requestId, envelope: structuredClone(envelope) }, structuredClone(decision),
            { deadlineAt: decision.deadlineAt, signal });
        });
        options.onDecision?.({ side: player.side, envelope: structuredClone(envelope), decision: structuredClone(decision), choice: action.choice! });
      }
      simulator.sendUpdates();
      await flush();
      check();
      if (player.trappedRetry) throw new Error("Trapped rejection missing re-request.");
      if (rejection && player.trappedRecovered) {
        // The general executor intentionally locks a dispatched rqid. Only this
        // proven native rejection/re-request authorizes a fresh offline executor.
        player.executor.revoke();
        player.executor = new BattleActionExecutor(player.engine, player.sessionId, choice => simulator.choose(player.side, choice));
        player.executor.authorize(roomId, expiresAt);
        continue;
      }
      if (rejection) {
        // An error is recoverable only after the selected action was rejected by
        // the simulator, never after an unknown executor/transport failure.
        if (!errors.some((error) => error.side === player.side && error.rqid === priorRqid && error.stage === "simulator")) throw rejection;
        if (player.rqid === priorRqid) await frameRequest(player, player.request!, true);
        player.rejected.add(action.id);
        player.retry = errorText(rejection);
      }
    }
  } catch (error) {
    if (!matchAbort.signal.aborted) stopReason = Date.now() >= expiresAt ? "deadline" : attempts >= maxDecisions ? "max_decisions" : "error";
    // An interrupted terminal update must not turn manual cancellation into a win.
    outcome = null; winner = null;
    if (!options.callerAbortSignal?.aborted || !matchAbort.signal.aborted) {
      errors.push({ side: null, turn, rqid: null, stage: "harness", message: errorText(error) });
    }
  } finally {
    clearTimeout(deadlineTimer);
    options.callerAbortSignal?.removeEventListener("abort", cancel);
    for (const side of SIDES) players[side].executor.revoke();
    simulator.destroy();
  }
  return {
    contractVersion: "offline-battle-match@1", status: outcome ? "completed" : stopReason === "error" ? "failed" : "truncated",
    outcome, winner, stopReason, format: validator.format.id, seed, turn,
    limits: { maxTurns, maxDecisions, timeoutMs, decisionDeadlineMs, fallbackDeadlineMs,
      ...(options.cleanupDeadlineMs === undefined ? {} : { cleanupDeadlineMs: options.cleanupDeadlineMs }) },
    versions: { simulator: `${metadata.name}@${metadata.version}`, producer, engines: [...engineVersions].sort(), node: process.version },
    players: Object.fromEntries(SIDES.map((side) => [side, { policyId: players[side].policy.id, ...players[side].stats }])),
    elapsedMs: Date.now() - startedAt, errors, fallbacks, trajectory, producerSources, replay: replay.join("\n") + "\n",
    replayInputs: { format: validator.format.id, seed, teams, ...(options.movePriors ? { movePriors: structuredClone(options.movePriors) } : {}),
      ...(options.analysisMode ? { analysisMode: options.analysisMode } : {}) },
    ...(options.trace ? { playerTraces } : {}),
    ...(ownedCheckpointAt === undefined ? {} : { ownedCheckpoints, ownedCheckpointSelection: {
      requested: ownedCheckpointAt, captured: ownedCheckpoints.map((entry) => entry.trajectoryIndex),
      uncaptured: ownedCheckpointAt.filter((index) => index <= trajectory.length && !ownedCheckpoints.some((entry) => entry.trajectoryIndex === index)),
      unreached: ownedCheckpointAt.filter((index) => index > trajectory.length)
    } })
  };
}
