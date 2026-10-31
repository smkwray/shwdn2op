import fs from "node:fs/promises";
import path from "node:path";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { toID } from "@pkmn/dex";
import { TRAPPED_SWITCH_ERROR, trappedSwitchRejection, MetamonBattlePolicy, type MetamonLeadReason, type MetamonObservationContext, type MetamonWorkerOptions } from "./metamon.js";
import { rerankDecision, rerankSeedKey, type RerankRecord } from "./rerank.js";
import type { TacticalGuard } from "./tacticalGuards.js";
import type { BattleDecision, BattlePolicyInput } from "./battleAgent.js";
import { sameCanonicalDecision, type BattleObservation, type CanonicalDecisionIdentity, type DecisionEngine } from "../state/decisionEngine.js";
import { sharedDecisionEnvelope } from "../state/decisionEnvelope.js";
import type { IntelEvaluationContext } from "../history/opponentIntelStore.js";
import type { BattleSnapshot, LegalAction } from "../types.js";
import { hashCanonical } from "../../../extension/lib/decision-identity.js";
import { OperationStalled, withinDeadline } from "../state/deadline.js";

// maxWorkers: how many battles may each run their own worker at once (several game tabs at once). It is
// device configuration: one GPU model process on a remote box, a few MLX workers on a large Mac.
const launchSchema = z.object({ command: z.string().min(1), args: z.array(z.string()), workerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  maxWorkers: z.number().int().min(1).max(8).default(1) });
export type LiveMetamonLaunch = MetamonWorkerOptions & { maxWorkers?: number };
export async function readLiveMetamonLaunch(file: string): Promise<LiveMetamonLaunch> {
  const bytes = await fs.readFile(file, "utf8");
  if (bytes.length > 16_384) throw new Error("Metamon launch file exceeds size limit.");
  const launch = launchSchema.parse(JSON.parse(bytes));
  if (!launch.args.some((arg) => arg.includes("{seed}"))) throw new Error("Metamon launch requires {seed}.");
  // This is a recorded remote producer pin, not a claim that remote bytes were verified locally.
  return { command: launch.command, args: launch.args, maxWorkers: launch.maxWorkers };
}

const eventBase = { eventId: z.string().min(1).max(240), sequence: z.number().int().positive(), sessionId: z.string().min(1).max(100), roomId: z.string().startsWith("battle-") };
export const liveEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...eventBase, kind: z.literal("observation"), observationId: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal("choice"), data: z.string().max(256) }).strict(),
  z.object({ ...eventBase, kind: z.literal("leave") }).strict()
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;
/** One request's first-paint times on the page, in ms after the page saw the request (no names). */
export const decisionTimingSchema = z.object({ roomId: z.string().startsWith("battle-").max(200), rqid: z.number().int().positive(),
  kind: z.string().max(20), sections: z.record(z.string().max(20), z.number().finite().min(0).max(600_000)) }).strict();
export type DecisionTiming = z.infer<typeof decisionTimingSchema>;
type Accepted = { observation: BattleObservation; current: Awaited<ReturnType<DecisionEngine["read"]>> & { changed?: boolean }; context: IntelEvaluationContext };
type Frame = Accepted & { data: string };
export interface LiveMetamonAdvice {
  status: "warming" | "ready" | "unavailable" | "disabled";
  /** Bound to the canonical decision identity only (it names the exact snapshot and legal actions): the pick never waits
   * for the deterministic sections. resultHash is the pick input's own hash (ready advice only). */
  identity: CanonicalDecisionIdentity; resultHash?: string; requestId: string | null;
  actionId: string | null; label: string | null; latencyMs: number | null;
  reason?: "sync_lost" | "worker_stalled" | "ended" | "idle" | "stale_advice" | "shutdown" | "capacity" | "unsupported_format";
  /** Plain-language explanation for the strip (capacity: how many battles hold workers, and the limit). */
  detail?: string;
  /** capacity only: a worker is free now, so a full replay of this battle will start one. */
  slotFree?: boolean;
  /** What the pick is: "top" = Metamon's most probable legal action (probability set); "lead_model" = the UU lead model's
   * most usual lead among rated humans (probability set; imitation, not a win estimate); "random_preview" = the worker's
   * official random team preview (no lead model, or it is off: the label says why); "sample" = a worker that reports no
   * distribution. */
  basis?: "top" | "lead_model" | "random_preview" | "sample";
  probability?: number | null;
  /** The worker's own temperature-1 sample, which it proposed; the shown pick can differ. */
  sampledActionId?: string;
  /** The second most probable action when within CLOSE_MARGIN of the top one. */
  runnerUp?: { actionId: string; label: string; probability: number };
  /** Metamon's own best action of the other kind (for a player who would rather switch, or stay): its most
   * probable switch beside a move pick, its most probable move beside a switch pick. Probability within the full distribution;
   * guards are that action's own warnings. No rule and no re-rank: it is read off the same distribution. */
  alternative?: { kind: "switch" | "stay"; actionId: string; label: string; probability: number; guards?: NonNullable<LiveMetamonAdvice["guards"]> };
  /** Shadow re-ranker (experimental): present only when its top action differs from the shown pick, which stays the advice. */
  rerank?: { actionId: string; label: string };
  /** Tactical guards on the raw or re-ranked pick, plus state-level warnings; red = penalized fact, amber = warning.
   * short is the strip's one line, message its tooltip; onPick marks a warning about the shown pick itself. */
  guards?: Array<{ kind: string; severity: "red" | "amber"; message: string; short: string; onPick: boolean }>;
  /** Ready before the deterministic sections finished: the guards (warnings) follow when they do. */
  guardsPending?: boolean;
}
type Session = {
  sessionId: string; roomId: string; side?: "p1" | "p2"; seed?: number; createdAt: number; touchedAt: number; teamNote?: string; resynced?: boolean;
  state: LiveMetamonAdvice["status"]; reason?: LiveMetamonAdvice["reason"];
  chain: Promise<void>; policy?: MetamonBattlePolicy | undefined; controller: AbortController;
  closing?: Promise<void>;
  sequence: number; frames: Frame[]; bytes: number; initialized: boolean;
  input?: BattlePolicyInput | undefined; proposal?: BattleDecision | undefined; shownActionId?: string | undefined; finalChoice?: string | undefined; awaitingAdvance: boolean; trappedAwaitingRequest?: boolean;
  request?: any; rqid: number; advice?: LiveMetamonAdvice | undefined;
  journal?: string; journalChain: Promise<void>; journalError?: string; timed?: Set<number>;
};

/** What the worker's proposal is bound to: the canonical request view alone (no deterministic sections). Its hash is
 * the binding token the worker echoes; the deterministic envelope keeps its own result hash. */
export async function pickInput(snapshot: BattleSnapshot, identity: CanonicalDecisionIdentity) {
  const { capturedAt: _captureTime, ...view } = snapshot;
  const semantic = { contractVersion: "showdown-decision@1", stage: "pick", identity, snapshot: view };
  // The policy reads only identity and snapshot from its input envelope.
  return { semantic, resultHash: await hashCanonical(semantic) } as unknown as BattlePolicyInput["envelope"];
}

/** The guards shown with a pick: those about the shown action, then at most one state-level line. A Tera-only or
 * runner-up warning beside a non-Tera pick reads as a warning about the pick. The no-safe-option
 * state and a KO'd-first pick lead (the contradiction the player must see); the pick itself is
 * never changed: warnings only. */
export function adviceGuards(guards: readonly TacticalGuard[], shownActionId: string): NonNullable<LiveMetamonAdvice["guards"]> {
  const rank = (guard: TacticalGuard) => guard.kind === "no_safe_option" ? 0 : guard.kind === "pre_move_ko" ? 1 : guard.severity === "red" ? 2 : 3;
  const onPick = guards.filter((guard) => guard.actionIds.includes(shownActionId)).sort((a, b) => rank(a) - rank(b));
  const state = guards.filter((guard) => !guard.actionIds.length).sort((a, b) => rank(a) - rank(b)).slice(0, 1);
  return [...onPick, ...state].slice(0, 3)
    .map(({ kind, severity, message, short, actionIds }) => ({ kind, severity, message, short, onPick: actionIds.includes(shownActionId) }));
}

/** A runner-up within this much probability of the top action is shown beside it. */
export const CLOSE_MARGIN = 0.15;
/** Ranked actions of a distribution: probability descending, then action ID (stable). */
function ranked(distribution: Record<string, number>) {
  return Object.entries(distribution).sort(([a, p], [b, q]) => q - p || (a < b ? -1 : a > b ? 1 : 0));
}
/** The shown pick (a game review finding): Metamon's most probable action, not its temperature-1 sample (6 of 39
 * shown picks in one game were not its top choice, one at 0.4%), plus a runner-up within CLOSE_MARGIN. Only what is shown
 * changes: the worker still samples, and commits the human's action. */
export function shownPick(distribution: Record<string, number> | undefined, sampledId: string) {
  if (!distribution) return { actionId: sampledId, probability: null, runnerUp: undefined };
  const [top, second] = ranked(distribution);
  return { actionId: top![0], probability: top![1], runnerUp: second && top![1] - second[1] <= CLOSE_MARGIN ? { actionId: second[0], probability: second[1] } : undefined };
}
/** The other kind's most probable legal action: a switch beside a move pick, a move beside a switch pick (none at team
 * preview, on a forced switch, or when it is already the shown runner-up). */
export function alternativePick(distribution: Record<string, number> | undefined, actions: readonly LegalAction[], shownActionId: string, runnerUpId?: string) {
  const shown = actions.find((action) => action.id === shownActionId);
  if (!distribution || !shown || !["move", "switch"].includes(shown.kind)) return undefined;
  const want = shown.kind === "move" ? "switch" : "move";
  const best = ranked(distribution).find(([id, probability]) => probability > 0 && actions.some((action) => action.id === id && action.kind === want && !action.disabled));
  return best && best[0] !== runnerUpId ? { kind: want === "switch" ? "switch" as const : "stay" as const, actionId: best[0], probability: best[1] } : undefined;
}
const percent = (p: number) => `${Math.round(p * 100)}%`;
/** Why the lead model gave no lead, in words for the strip (every unavailable state shows a reason). */
export const LEAD_OFF: Record<MetamonLeadReason, string> = {
  checkpoint_missing: "model file missing", checkpoint_mismatch: "model file changed", load_failed: "model failed to load",
  opponent_not_6: "opponent shows fewer than 6", team_unmatched: "team not matched", inference_failed: "model error"
};

// Mirrors the simulator's Side.chooseTeam: a partial order is completed with the remaining slots in order.
function teamOrder(data: string) {
  const picked = data.split(data.includes(",") ? "," : "").map((slot) => Number.parseInt(slot, 10));
  for (let slot = 1; picked.length < 6; slot++) if (!picked.includes(slot)) picked.push(slot);
  if (new Set(picked).size !== 6) throw new Error("Ambiguous choice.");
  return `team ${picked.join("")}`;
}

/** Human-only adapter. No executor, game socket, provider, or move-sending callback exists here. */
// Singles team preview only picks the lead; the bench order changes nothing unless the team has Illusion, whose
// disguise follows party order.
function sameDecision(chosen: string, advised: string, request: any): boolean {
  if (chosen === advised) return true;
  const [a, b] = [chosen, advised].map((id) => /^team:(\d+)$/.exec(id)?.[1]);
  const illusion = request?.side?.pokemon?.some((p: any) => [p.ability, p.baseAbility].includes("illusion"));
  return Boolean(a && b && !illusion && a[0] === b[0]);
}

export class LiveMetamonAdvisor {
  private rooms = new Map<string, Session>();
  private retired = new Set<Session>();
  private captures = new Map<string, { sequence: number; ids: Map<string, string> }>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly worker: MetamonWorkerOptions;
  readonly maxWorkers: number;
  constructor(launch: LiveMetamonLaunch, private readonly options: {
    idleMs?: number; operationMs?: number; now?: () => number; journalDir?: string; maxWorkers?: number;
  } = {}) {
    const { maxWorkers, ...worker } = launch;
    this.worker = worker;
    this.maxWorkers = options.maxWorkers ?? maxWorkers ?? 1;
    this.timer = setInterval(() => { void this.sweep(); }, 1000);
    this.timer.unref();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private key(sessionId: string, roomId: string) { return `${sessionId}\n${roomId}`; }
  private operation(s: Session) { return { deadlineAt: Date.now() + (this.options.operationMs ?? 120_000), signal: s.controller.signal }; }
  /** Append-only per-battle record for exact offline replay. Failures are reported, never thrown into advice. */
  private record(s: Session, entry: Record<string, unknown>) {
    if (!s.journal) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    s.journalChain = s.journalChain.then(() => fs.appendFile(s.journal!, line, "utf8"))
      .catch((error) => { s.journalError ??= error instanceof Error ? error.message : String(error); });
  }
  /** The battle's result, and its last chunk when the worker never saw it (the game ended after the human's choice). A
   *  journal without them loses the final turn and the winner. */
  private end(s: Session, data: string, observed: boolean) {
    const winner = /^\|win\|(.*)$/m.exec(data)?.[1];
    const action = s.finalChoice ? s.input?.envelope.semantic.snapshot.legalActions.find((a) => a.choice === s.finalChoice) : undefined;
    this.record(s, { kind: "end", result: winner !== undefined ? { winner } : /^\|tie(?:\||$)/m.test(data) ? "tie" : null,
      ...(observed ? {} : { data }),
      ...(s.finalChoice ? { finalChoice: s.finalChoice, adviceActionId: s.shownActionId ?? null,
        followed: Boolean(action && s.shownActionId && sameDecision(action.id, s.shownActionId, s.request)) } : {}) });
  }
  private async stop(s: Session, reason: LiveMetamonAdvice["reason"], cause?: unknown) {
    if (s.state === "unavailable") { await (s.closing ?? s.policy?.close()); return; }
    // The cause is a local code/protocol message (no hidden state); without it a lost game is undiagnosable.
    this.record(s, { kind: "stop", reason, ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }) });
    s.state = "unavailable"; s.reason = reason; s.advice = undefined;
    s.controller.abort(); s.frames = []; s.input = undefined; s.proposal = undefined; s.shownActionId = undefined;
    const policy = s.policy;
    s.policy = undefined;
    s.closing = policy?.close() ?? Promise.resolve();
    await s.closing;
  }
  /** Back to a fresh, uninitialized advisor for the same room; the next |init| replay starts a new worker. */
  private reset(s: Session) {
    s.policy = undefined; s.frames = []; s.bytes = 0; s.sequence = 0; s.rqid = 0; s.request = undefined; s.initialized = false;
    s.awaitingAdvance = false; s.finalChoice = undefined; s.input = undefined; s.proposal = undefined; s.shownActionId = undefined; s.advice = undefined;
    s.trappedAwaitingRequest = false; s.state = "warming"; s.reason = undefined; s.controller = new AbortController();
  }
  private session(event: LiveEvent) {
    const key = this.key(event.sessionId, event.roomId);
    let s = this.rooms.get(key);
    if (!s) {
      // A new browser capture of this room replaces the old recurrence, never resumes it.
      for (const other of this.rooms.values()) if (other.roomId === event.roomId && other.sessionId !== event.sessionId) void this.stop(other, "sync_lost");
      s = { sessionId: event.sessionId, roomId: event.roomId, createdAt: this.now(), touchedAt: this.now(), state: "warming",
        chain: Promise.resolve(), journalChain: Promise.resolve(), controller: new AbortController(), sequence: 0, frames: [], bytes: 0, initialized: false, awaitingAdvance: false, rqid: 0 };
      this.rooms.set(key, s);
    }
    return s;
  }
  /** Called synchronously AFTER canonical acceptance. Work never delays ingestion or changes its outcome. */
  accept(events: LiveEvent[], accepted: Accepted[] = []) {
    if (this.closed) return;
    const frames = new Map(accepted.map((entry) => [entry.observation.observationId, entry]));
    for (const entry of accepted) {
      const matches = events.filter((e) => e.kind === "observation" && e.observationId === entry.observation.observationId
        && e.sessionId === entry.observation.sessionId && e.roomId === entry.observation.roomId);
      if (matches.length !== 1) {
        const event = { kind: "leave" as const, eventId: "invalid-batch", sequence: 1, sessionId: entry.observation.sessionId, roomId: entry.observation.roomId };
        void this.stop(this.session(event), "sync_lost");
      }
    }
    for (const event of events) {
      let s = this.session(event);
      let capture = this.captures.get(event.sessionId);
      // A companion (re)started mid-capture first sees a later sequence; earlier events are unknown, not lost. The room
      // stays uninitialized until the client replays the battle from |init|.
      if (!capture) { capture = { sequence: event.sequence - 1, ids: new Map() }; this.captures.set(event.sessionId, capture); }
      const digest = JSON.stringify(event);
      if (capture.ids.has(event.eventId)) {
        if (capture.ids.get(event.eventId) !== digest) void this.stop(s, "sync_lost");
        continue;
      }
      if (capture.ids.size >= 20_000) { void this.stop(s, "sync_lost"); continue; }
      capture.ids.set(event.eventId, digest);
      if (event.sequence !== capture.sequence + 1) {
        for (const room of this.rooms.values()) if (room.sessionId === event.sessionId) void this.stop(room, "sync_lost");
      }
      capture.sequence = event.sequence;
      s.touchedAt = this.now();
      const frame = event.kind === "observation" ? frames.get(event.observationId) : undefined;
      if (s.state === "unavailable") {
        // The advisor must never stay in lost sync: the client answers a lost sync by replaying the battle
        // from |init|; that replay restarts this room's advisor from the whole log.
        // A battle that waited for a free worker starts the same way once one is free.
        if (!(frame && (s.reason === "sync_lost" || s.reason === "worker_stalled" || s.reason === "capacity") && /(?:^|\n)\|init\|battle(?:\n|$)/.test(frame.observation.data))) continue;
        this.record(s, { kind: "revive" });
        // A stopped generation may still be unwinding a timed-out promise. Never reuse its mutable Session or chain:
        // its delayed catch/close must not stop the replay's new worker, or strand the replay behind the old promise.
        this.retired.add(s);
        const retired = s;
        void Promise.all([retired.chain, retired.closing, retired.journalChain]).then(
          () => this.retired.delete(retired), () => this.retired.delete(retired));
        this.rooms.delete(this.key(event.sessionId, event.roomId));
        s = this.session(event);
        // Wait only for bounded process teardown, never the retired event chain. Do not overlap old/new workers.
        s.chain = retired.closing ?? Promise.resolve();
      }
      if (event.kind === "leave") { void this.stop(s, "ended", "left the battle room"); continue; }
      // A terminal frame must cancel even a cold, blocked model startup immediately.
      const terminal = frame && /(?:^|\n)\|(?:win\||tie(?:\||$)|deinit(?:\||$))|(?:^|\n)\|(?:message|raw)\|[^\n]*\bforfeited\b/.test(frame.observation.data);
      if (terminal && s.state === "warming") { this.end(s, frame!.observation.data.slice(frame!.observation.data.indexOf("\n") + 1), false); void this.stop(s, "ended"); continue; }
      // A full replay of an advised battle restarts its worker (see frame()). Until that runs, the old pick belongs to
      // the old view: answering "stale" made the browser stop polling and miss the restarted pick (e2e, 2026-10-22).
      if (frame && s.initialized && /(?:^|\n)\|init\|battle(?:\n|$)/.test(frame.observation.data)) { s.advice = undefined; s.state = "warming"; }
      // Invalidate immediately on canonical acceptance: same-rqid retries must
      // keep the browser polling while the serialized worker operation catches up.
      if (frame && (s.trappedAwaitingRequest || frame.observation.data.split("\n").includes(TRAPPED_SWITCH_ERROR))) {
        s.advice = undefined; s.state = "warming";
      }
      s.chain = s.chain.then(() => withinDeadline("model event", this.options.operationMs ?? 20_000, async () => {
        if (s.state === "unavailable") return;
        if (event.kind === "choice") this.choice(s, event.data);
        else {
          if (!frame || frame.observation.sessionId !== event.sessionId || frame.observation.roomId !== event.roomId) throw new Error("Unaccepted advisor frame.");
          await this.frame(s, { ...frame, data: frame.observation.data.slice(frame.observation.data.indexOf("\n") + 1) });
        }
      })).catch(async (error) => { await this.stop(s, error instanceof OperationStalled ? "worker_stalled" : "sync_lost", error); });
    }
  }
  private choice(s: Session, data: string) {
    if (!s.input || !s.awaitingAdvance || s.trappedAwaitingRequest) throw new Error("Choice without a pending request.");
    // Old client: `/choose move 1|5`, `/team 321456|1`; Preact client: `/choose team 3, 1, 2, 4, 5, 6|1`.
    // Live Showdown suffixes the rqid with a client hash: `/choose move 1|5.87ee3ef5880f6771`.
    const match = /^\/(?:choose )?(move [1-4](?: terastallize)?|switch [1-6]|team (?:[1-6]{1,6}|[1-6](?:, ?[1-6]){1,5}))(?:\|(\d+)(?:\.[0-9a-f]+)?)?$/.exec(data);
    const undo = /^\/undo(?:\|(\d+)(?:\.[0-9a-f]+)?)?$/.exec(data);
    const rqid = match?.[2] ?? undo?.[1];
    if (rqid !== undefined && Number(rqid) !== s.rqid) throw new Error("Choice epoch mismatch.");
    if (undo) { s.finalChoice = undefined; return; }
    const choice = match?.[1]?.startsWith("team ") ? teamOrder(match[1].slice(5)) : match?.[1];
    if (!choice || (s.finalChoice && s.finalChoice !== choice)) throw new Error("Ambiguous choice.");
    const actions = s.input.envelope.semantic.snapshot.legalActions;
    const matches = actions.filter((a) => a.choice === choice && !a.disabled && a.legality !== "disabled");
    if (matches.length !== 1) throw new Error("Choice is not uniquely legal.");
    s.finalChoice = choice;
  }
  private validateOutcome(s: Session, action: LegalAction, data: string, forcedOut: boolean) {
    const own = `${s.side}a: `;
    const lines = data.split("\n");
    const moves = lines.filter((l) => l.startsWith(`|move|${own}`) && !l.includes("|[from]"));
    const switches = lines.filter((l) => l.startsWith(`|switch|${own}`));
    const tera = lines.filter((l) => l.startsWith(`|-terastallize|${own}`));
    if (lines.some((l) => l.startsWith("|error|"))) throw new Error("Rejected choice.");
    if (action.kind === "move") {
      const move = s.request.active?.[0]?.moves?.[(action.moveSlot ?? 0) - 1];
      if (moves.some((l) => toID(l.split("|")[3]!) !== toID(move?.id ?? move?.move ?? "")) || switches.length) throw new Error("Move outcome mismatch.");
      // A chosen move may never run: cant, fainted, phazed, confusion self-hit, or forced out first (Eject Button/Pack).
      const prevented = lines.some((l) => l.startsWith(`|cant|${own}`) || l.startsWith(`|faint|${own}`) || l.startsWith(`|drag|${own}`)
        || (l.startsWith(`|-damage|${own}`) && l.endsWith("|[from] confusion")));
      if (!moves.length && !prevented && !forcedOut) throw new Error("No move outcome.");
      if (Boolean(action.terastallize) !== (tera.length === 1)) throw new Error("Tera outcome mismatch.");
    } else {
      const slot = action.kind === "team" ? action.teamSpec?.[0] : action.targetSlot;
      const mon = s.request.side.pokemon[(slot ?? 0) - 1];
      if (!mon || switches.length !== 1 || moves.length || tera.length
        || switches[0]!.split("|")[2] !== `${s.side}a: ${String(mon.ident).slice(4)}`
        || toID(switches[0]!.split("|")[3]!.split(",")[0]!) !== toID(String(mon.details).split(",")[0]!)) throw new Error("Switch/preview outcome mismatch.");
    }
  }
  private async observe(s: Session, frame: Frame) {
    const context: MetamonObservationContext = { roomId: s.roomId, side: s.side!, format: "gen9uu", sequence: ++s.sequence, identity: frame.current.identity };
    this.record(s, { kind: "frame", sequence: context.sequence, data: frame.data });
    // Upstream Metamon raises UnusualTeamSize for any team that is not 6 (trained on 6v6). Feed it 6 so the advisor keeps
    // running; it then assumes the missing Pokémon exist but never appear, and every pick says so.
    const short = /^\|teamsize\|(p[12])\|([1-5])$/m.exec(frame.data);
    if (short) s.teamNote = `${short[1] === s.side ? "you have" : "opponent has"} ${short[2]}; Metamon assumes 6`;
    const data = frame.data.replace(/^\|teamsize\|(p[12])\|[1-5]$/gm, "|teamsize|$1|6");
    await s.policy!.observe(data, context, this.operation(s));
  }
  private async frame(s: Session, frame: Frame) {
    const lines = frame.data.split("\n");
    const terminal = lines.some((l) => /^\|(?:win\||tie(?:\||$)|deinit(?:\||$))/.test(l) || /^\|(?:message|raw)\|.*\bforfeited\b/.test(l));
    // Periodic client recovery is not a new simulator chunk. An accepted no-op
    // can be ignored; any recovery that changes canonical state loses continuity.
    if (frame.observation.source === "recovery" && frame.current.changed === false) return;
    const retry = s.trappedAwaitingRequest || lines.includes(TRAPPED_SWITCH_ERROR);
    if (frame.observation.source !== "protocol" || (!retry && lines.some((l) => l.startsWith("|error|")))) throw new Error("Recovery/rejection cannot resume recurrence.");
    if (lines.includes("|init|battle")) {
      // The client replayed this battle from |init| in the same capture session (Vivaldi recycling the extension worker,
      // or the page re-sending its log). Treating it as a replaced battle left the advisor "sync lost" seconds in.
      // Restart from the full log instead, as a mid-battle start does; every pick then says it resynced.
      if (s.initialized) {
        this.record(s, { kind: "resync", rqid: s.rqid });
        await s.policy?.close();
        s.controller.signal.throwIfAborted();
        this.reset(s);
      }
      s.initialized = true;
    }
    const requests = lines.filter((l) => l.startsWith("|request|"));
    if (requests.length > 1) throw new Error("Multiple requests in one chunk.");
    const request = requests.length ? JSON.parse(requests[0]!.slice(9)) : undefined;
    if (requests.length && (!request || !Number.isSafeInteger(request.rqid) || request.side?.id !== (s.side ?? request.side?.id)
      || !["p1", "p2"].includes(request.side?.id) || request.rqid < 1
      // The server's rqid counter is shared by both sides, so one side's requests increase but may skip numbers.
      || (s.rqid > 0 && (retry ? request.rqid !== s.rqid : request.rqid <= s.rqid)))) throw new Error("Private epoch gap or side mismatch.");
    s.bytes += Buffer.byteLength(frame.data);
    if (s.bytes > 16_777_216 || s.frames.length > 2000) throw new Error("Advisor buffer limit.");
    if (retry) {
      if (!s.awaitingAdvance || (!s.trappedAwaitingRequest && !s.finalChoice?.startsWith("switch ")) || s.frames.length) throw new Error("Unexpected trapped rejection.");
      const complete = trappedSwitchRejection(frame.data, s.rqid, s.trappedAwaitingRequest);
      if (!s.trappedAwaitingRequest) {
        const humanSwitch = s.input!.envelope.semantic.snapshot.legalActions.find(a => a.choice === s.finalChoice && a.kind === "switch");
        if (!humanSwitch) throw new Error("Missing rejected human switch.");
        if (humanSwitch.id !== s.proposal!.actionId) await s.policy!.stageSwitch(s.input!, humanSwitch.id, this.operation(s));
        this.record(s, { kind: "rejected", rqid: s.rqid, choice: s.finalChoice, reason: "trapped" });
        s.finalChoice = undefined;
      }
      await this.observe(s, frame);
      s.advice = undefined; s.state = "warming"; s.trappedAwaitingRequest = !complete;
      if (!complete) return;
      s.awaitingAdvance = false; s.finalChoice = undefined; s.input = undefined; s.proposal = undefined; s.shownActionId = undefined;
    } else s.frames.push(frame);
    if (s.awaitingAdvance) {
      // An opponent's mid-turn pivot sends a wait request before the human's own action resolves.
      if (request?.wait) { s.rqid = request.rqid; return; }
      const advances = request !== undefined || lines.some((l) => l.startsWith("|turn|")) || terminal;
      if (!advances) return;
      // The battle can end before the human's action runs; nothing remains to commit.
      if (terminal) { this.end(s, frame.data, false); await this.stop(s, "ended"); return; }
      const action = s.input!.envelope.semantic.snapshot.legalActions.find((a) => a.choice === s.finalChoice);
      if (!action) throw new Error("Missing final human choice.");
      this.validateOutcome(s, action, s.frames.map((f) => f.data).join("\n"), Boolean(request?.forceSwitch?.[0]));
      await s.policy!.commit(s.input!, { ...s.proposal!, actionId: action.id }, this.operation(s));
      this.record(s, { kind: "commit", rqid: s.input!.envelope.semantic.identity.rqid, choice: s.finalChoice, actionId: action.id,
        adviceActionId: s.shownActionId, followed: sameDecision(action.id, s.shownActionId!, s.request) });
      s.awaitingAdvance = false; s.finalChoice = undefined; s.input = undefined; s.proposal = undefined; s.shownActionId = undefined; s.advice = undefined;
      s.state = "warming";
    }
    if (!s.policy && request) {
      // Normally this is team preview. A full replay from |init| mid-battle (reload, restarted extension worker) also
      // starts a fresh worker on the whole public log; it lacks memory of earlier turns, and every pick says so.
      if (!s.initialized) throw new Error("Missing battle start.");
      if (!s.roomId.startsWith("battle-gen9uu-")) { await this.stop(s, "unsupported_format"); return; }
      // A newer session for the same battle (page reload, restarted extension worker) supersedes the old one at once.
      for (const other of [...this.rooms.values()]) if (other !== s && other.policy && other.roomId === s.roomId) await this.stop(other, "sync_lost");
      // Each battle has its own worker, up to maxWorkers. When full, a battle silent for a minute (abandoned without a
      // leave: crashed tab, killed browser) gives its worker up, oldest first; otherwise this battle waits and says so.
      for (let silent = this.silentHolder(s); this.holders(s).length >= this.maxWorkers && silent; silent = this.silentHolder(s)) await this.stop(silent, "idle");
      if (this.holders(s).length >= this.maxWorkers) { await this.stop(s, "capacity"); return; }
      if (!request.teamPreview) s.resynced = true;
      s.side = request.side.id;
      const seed = randomInt(0, 0x80000000);
      s.seed = seed;
      const args = this.worker.args.map((arg) => arg.replaceAll("{seed}", String(seed)));
      if (this.options.journalDir) {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
        s.journal = path.join(this.options.journalDir, `${s.roomId.replace(/[^a-z0-9-]/g, "_")}-${s.side}-${stamp}.jsonl`);
        s.journalChain = fs.mkdir(this.options.journalDir, { recursive: true }).then(() => undefined);
        this.record(s, { kind: "start", version: 1, roomId: s.roomId, side: s.side, seed, args });
      }
      s.policy = new MetamonBattlePolicy({ ...this.worker, renumberRequests: true, args,
        onFailure: (error?: unknown) => { void this.stop(s, "sync_lost", error ?? "worker failure"); } });
    }
    if (s.policy) for (const buffered of s.frames.splice(0)) await this.observe(s, buffered);
    if (request) {
      s.request = request; s.rqid = request.rqid;
      if (!request.wait) {
        const { snapshot, identity, room } = frame.current;
        if (!snapshot || !identity || identity.rqid !== s.rqid || snapshot.yourSide.slot !== s.side) throw new Error("Canonical request unavailable.");
        // The worker reads the public protocol; its proposal needs only this request's identity and legal actions. It no
        // longer waits for the deterministic sections (each shows as soon as its information is
        // available). Those are built at the same time; the re-ranker and its warnings follow when they finish.
        s.input = { requestId: `live:${s.sessionId}:${s.roomId}:${s.rqid}`, envelope: await pickInput(snapshot, identity) };
        const start = Date.now();
        const proposing = s.policy!.decide(s.input, this.operation(s));
        const deterministic = sharedDecisionEnvelope(s.sessionId, snapshot, identity, frame.context, room.lastRequest?.side?.pokemon ?? []);
        deterministic.catch(() => {});  // a failed build costs only the warnings, recorded below
        s.proposal = await proposing;
        s.controller.signal.throwIfAborted();
        const sampled = snapshot.legalActions.find((a) => a.id === s.proposal!.actionId)!;
        const distribution = s.policy!.proposalDistribution(s.input.requestId);
        // Team preview: the worker's pick is the official random draw; the UU lead model, when it answers, is what is shown.
        const lead = snapshot.phase === "preview" ? s.policy!.proposalLead(s.input.requestId) : undefined;
        const leadModel = lead?.status === "ok" ? lead : undefined;
        const shown = shownPick(leadModel?.distribution ?? distribution, sampled.id);
        const action = snapshot.legalActions.find((a) => a.id === shown.actionId)!;
        s.shownActionId = action.id;
        const name = (slot: number) => String(request.side.pokemon[slot - 1].details).split(",")[0];
        const labelOf = (entry: LegalAction) => entry.kind === "switch" ? `Switch to ${name(entry.targetSlot ?? 1)}`
          : entry.kind === "team" ? `Lead ${name(entry.teamSpec![0]!)} (then ${entry.teamSpec!.slice(1).map(name).join(", ")})`
          // Name the Tera type in words: a 96% "Tera + Slack Off" pick was once played without Tera.
          : entry.terastallize ? `Terastallize (${typeof request.active?.[0]?.canTerastallize === "string" ? request.active[0].canTerastallize : "your Tera type"}) + ${entry.moveName ?? entry.label}`
          : entry.label;
        const basis = leadModel ? "lead_model" as const : shown.probability !== null ? "top" as const : action.kind === "team" ? "random_preview" as const : "sample" as const;
        const leadName = (entry: LegalAction) => name(entry.teamSpec![0]!);
        const runnerUpAction = shown.runnerUp && snapshot.legalActions.find((a) => a.id === shown.runnerUp!.actionId)!;
        const runnerUp = shown.runnerUp ? { ...shown.runnerUp, label: basis === "lead_model" ? `Lead ${leadName(runnerUpAction!)}` : labelOf(runnerUpAction!) } : undefined;
        // A random preview pick is the official random draw: say so (it read as a recommendation and was judged as one).
        // The lead model imitates rated human leads; it is "usual", never "best" (no win evidence).
        const label = basis === "lead_model" ? `Usual lead: ${leadName(action)} (${percent(shown.probability!)})${runnerUp ? ` · close: ${leadName(runnerUpAction!)} (${percent(runnerUp.probability)})` : ""}`
          : basis === "random_preview" ? `Random ${labelOf(action).replace(/^Lead /, "lead: ")}; ${lead?.status === "unavailable" ? `lead model off (${LEAD_OFF[lead.reason]})` : "Metamon has no lead model"}`
          : shown.probability === null ? labelOf(action)
          : `${labelOf(action)} (${percent(shown.probability)})${runnerUp ? ` · close: ${runnerUp.label} (${percent(runnerUp.probability)})` : ""}`;
        const advice: LiveMetamonAdvice = s.advice = { status: "ready", identity, resultHash: s.input.envelope.resultHash, requestId: s.input.requestId,
          actionId: action.id, label, latencyMs: Date.now() - start, basis, probability: shown.probability, sampledActionId: sampled.id,
          ...(runnerUp ? { runnerUp } : {}), guardsPending: true };
        const other = basis === "top" ? alternativePick(distribution, snapshot.legalActions, action.id, runnerUp?.actionId) : undefined;
        const otherAction = other && snapshot.legalActions.find((a) => a.id === other.actionId)!;
        if (other) advice.alternative = { ...other, label: other.kind === "switch" ? `If switching: ${name(otherAction!.targetSlot ?? 1)} (${percent(other.probability)})`
          : `If staying: ${labelOf(otherAction!)} (${percent(other.probability)})` };
        if (s.teamNote) advice.label = `${advice.label} (${s.teamNote})`;
        if (s.resynced) advice.label = `${advice.label} (resynced mid-battle)`;
        s.awaitingAdvance = true; s.state = "ready";
        // Shadow re-ranker: never changes the advice; a failure costs only its own record. Its record stays coupled to the
        // worker's own sample (the evaluation's semantics); what is shown is its top action, as for Metamon's.
        let rerank: RerankRecord | undefined, rerankError: string | undefined, envelope: Awaited<typeof deterministic> | undefined;
        try {
          envelope = await deterministic;
          rerank = rerankDecision(envelope, distribution, sampled.id, rerankSeedKey(s.seed!, s.side!, identity));
          const rerankTop = rerank.rerankedProbabilities ? ranked(rerank.rerankedProbabilities)[0]![0] : null;
          const guards = adviceGuards(rerank.guards, action.id);
          if (guards.length) advice.guards = guards;
          // The alternative's own warnings (a switch-in KO, say): the owner may take it.
          const otherGuards = advice.alternative && adviceGuards(rerank.guards, advice.alternative.actionId).filter((guard) => guard.onPick);
          if (otherGuards?.length) advice.alternative!.guards = otherGuards;
          const other = rerankTop && rerankTop !== action.id ? snapshot.legalActions.find((a) => a.id === rerankTop) : undefined;
          if (other) advice.rerank = { actionId: other.id, label: labelOf(other) };
        } catch (error) { rerankError = error instanceof Error ? error.message : String(error); }
        // The shown advice may meanwhile have been withdrawn (a replay or a trapped retry): never revive it.
        delete advice.guardsPending;
        this.record(s, { kind: "advice", rqid: identity.rqid, requestId: s.input.requestId, actionId: action.id, choice: action.choice,
          label: advice.label, basis, probability: shown.probability, sampledActionId: sampled.id, ...(runnerUp ? { runnerUp } : {}),
          ...(advice.alternative ? { alternative: { actionId: advice.alternative.actionId, probability: advice.alternative.probability } } : {}),
          ...(lead ? { lead: lead.status === "ok" ? { status: lead.status, checkpointSha256: lead.checkpointSha256, leadProbabilities: lead.leadProbabilities, inferenceMs: lead.inferenceMs } : lead } : {}),
          latencyMs: advice.latencyMs, resultHash: envelope?.resultHash ?? null, ...(rerank ? { rerank } : { rerankError }) });
      }
    }
    if (terminal) { this.end(s, frame.data, true); await this.stop(s, "ended"); }
  }
  /** A page's paint timings for one request of this battle (milliseconds after it saw the request), journaled once. */
  recordTiming(sessionId: string, timing: DecisionTiming) {
    const s = this.rooms.get(this.key(sessionId, timing.roomId));
    if (!s?.journal || (s.timed ??= new Set()).has(timing.rqid)) return;
    s.timed.add(timing.rqid);
    this.record(s, { kind: "latency", rqid: timing.rqid, request: timing.kind, sections: timing.sections });
  }
  advice(sessionId: string, identity: CanonicalDecisionIdentity): LiveMetamonAdvice {
    const s = this.rooms.get(this.key(sessionId, identity.roomId));
    const binding = { identity, requestId: null, actionId: null, label: null, latencyMs: null };
    if (s?.state === "unavailable" && s.reason === "capacity") {
      const busy = this.holders(s).length;
      return { ...binding, status: "unavailable", reason: "capacity", slotFree: busy < this.maxWorkers,
        detail: `${busy} other battle${busy === 1 ? "" : "s"} already use${busy === 1 ? "s" : ""} Metamon (limit ${this.maxWorkers}); it starts here when one ends` };
    }
    if (!s || s.state === "unavailable") return { ...binding, status: "unavailable", reason: s?.reason ?? "sync_lost" };
    if (s.advice && sameCanonicalDecision(s.advice.identity, identity)) return structuredClone(s.advice);
    // While the human decides, only chat/timer/inactivity lines can arrive; they bump the revision and result hash
    // but not the request. The pick stays bound to the same request and the same legal actions.
    const a = s.advice?.identity;
    if (s.advice?.status === "ready" && a && a.roomId === identity.roomId && a.rqid === identity.rqid
      && a.requestKind === identity.requestKind && a.legalActionSetHash === identity.legalActionSetHash) return { ...structuredClone(s.advice), identity };
    // Advice still held for an earlier request means this one is queued behind that request's commit.
    const queued = !s.advice || (identity.rqid ?? 0) > (s.advice.identity.rqid ?? 0);
    return { ...binding, status: queued ? "warming" : "unavailable", ...(queued ? {} : { reason: "stale_advice" as const }) };
  }
  /** Battles other than `s` that hold a live worker. */
  private holders(s?: Session) { return [...this.rooms.values()].filter((o) => o !== s && o.policy && o.state !== "unavailable"); }
  private silentHolder(s: Session) {
    return this.holders(s).filter((o) => this.now() - o.touchedAt >= 60_000).sort((a, b) => a.touchedAt - b.touchedAt)[0];
  }
  status() {
    return [...this.rooms.values()].map((s) => ({ sessionId: s.sessionId, roomId: s.roomId, side: s.side ?? null,
      state: s.state, reason: s.reason ?? null, pid: s.policy?.pid ?? null, ageMs: this.now() - s.createdAt,
      advice: s.advice ? { rqid: s.advice.identity.rqid, stateRevision: s.advice.identity.stateRevision, requestKind: s.advice.identity.requestKind,
        legalActionSetHash: s.advice.identity.legalActionSetHash.slice(0, 19) } : null,
      journal: s.journal ?? null, journalError: s.journalError ?? null }));
  }
  async settled() {
    const sessions = [...this.rooms.values(), ...this.retired];
    await Promise.all(sessions.map((s) => s.chain));
    await Promise.all(sessions.map((s) => s.closing));
    await Promise.all(sessions.map((s) => s.journalChain));
    for (const s of sessions) this.retired.delete(s);
  }
  async sweep() {
    await Promise.all([...this.rooms.values()].filter((s) => s.state !== "unavailable" && this.now() - s.touchedAt >= (this.options.idleMs ?? 900_000)).map((s) => this.stop(s, "idle")));
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await Promise.all([...this.rooms.values()].map((s) => this.stop(s, "shutdown")));
    await this.settled();
    this.rooms.clear(); this.captures.clear();
  }
}
