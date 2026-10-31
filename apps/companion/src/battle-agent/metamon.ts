import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { toID } from "@pkmn/dex";
import { battleDecisionSchema, battleOverrideSchema, inspectBattleAdvice, withinDeadline, type BattleAdvice, type BattleAdviceMode, type BattleDecision,
  type BattlePolicy, type BattlePolicyDecideOptions, type BattlePolicyInput } from "./battleAgent.js";
import { hasCardField } from "./decisionCard.js";
import type { CanonicalDecisionIdentity } from "../state/decisionEngine.js";
import type { LegalAction } from "../types.js";

/** Worker/runtime pins and launch instructions live in scripts/metamon-worker.py.
 * One instance per side per match. observe AFTER canonical ingestion, including
 * preview, wait, error and terminal frames. Never pass simulator omniscient data.
 * Caller must await observations and close in finally; a failed worker is terminal.
 */
export interface MetamonObservationContext {
  roomId: string;
  side: "p1" | "p2";
  format: string;
  sequence: number;
  identity: CanonicalDecisionIdentity | null;
}
export interface MetamonOperation { deadlineAt: number; signal: AbortSignal }
export interface MetamonWorkerOptions {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  onFailure?: (code: string) => void;
  /** Live Showdown can begin at rqid 2; the pinned worker numbers its first request 1. */
  renumberRequests?: boolean;
}
const choiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), moveSlot: z.number().int().min(1).max(4), terastallize: z.boolean() }).strict(),
  z.object({ kind: z.literal("switch"), switchSlot: z.number().int().min(1).max(6) }).strict(),
  z.object({ kind: z.literal("team"), team: z.array(z.number().int().min(1).max(6)).length(6)
    .refine((slots) => new Set(slots).size === 6) }).strict()
]);
export type MetamonChoice = z.infer<typeof choiceSchema>;

/** No new legal actions, fuzzy names, raw network indices, or default moves. */
export function mapMetamonChoice(value: unknown, actions: readonly LegalAction[]): string {
  const choice = choiceSchema.parse(value);
  const token = choice.kind === "move" ? `move ${choice.moveSlot}${choice.terastallize ? " terastallize" : ""}`
    : choice.kind === "switch" ? `switch ${choice.switchSlot}` : `team ${choice.team.join("")}`;
  const matches = actions.filter((action) => !action.disabled && action.legality !== "disabled" && action.choice === token
    && action.kind === choice.kind && (choice.kind === "move"
      ? action.moveSlot === choice.moveSlot && Boolean(action.terastallize) === choice.terastallize
      : choice.kind === "switch" ? action.targetSlot === choice.switchSlot : isDeepStrictEqual(action.teamSpec, choice.team)));
  if (matches.length !== 1) throw new Error("Metamon choice has no unique canonical action.");
  return matches[0]!.id;
}

const probabilitySchema = z.record(z.string().regex(/^(?:move [1-4](?: terastallize)?|switch [1-6])$/), z.number().finite().min(0).max(1));

/** The optional propose-reply distribution (our worker wrappers, scripts/metamon_port/action_probs.py): the worker's
 * own legal-action conditional keyed by choice token. Re-keyed by canonical action ID; every key must name exactly one
 * enabled action, the mass must sum to 1 and the proposal itself must have mass. Anything else is a broken worker. */
export function mapMetamonDistribution(value: unknown, actions: readonly LegalAction[], proposedActionId: string): Record<string, number> {
  const parsed = probabilitySchema.safeParse(value);
  if (!parsed.success) throw failure("protocol");
  const result: Record<string, number> = {};
  let total = 0;
  for (const [token, p] of Object.entries(parsed.data)) {
    const matches = actions.filter((action) => action.choice === token && !action.disabled && action.legality !== "disabled");
    if (matches.length !== 1 || matches[0]!.id in result) throw failure("official_action");
    result[matches[0]!.id] = p; total += p;
  }
  if (Math.abs(total - 1) > 1e-5 || !(result[proposedActionId]! > 0)) throw failure("official_action");
  return result;
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const leadModelSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), checkpointSha256: sha256, leadProbabilities: z.array(z.number().finite().min(0).max(1)).length(6),
    inferenceMs: z.number().finite().min(0) }).strict(),
  z.object({ status: z.literal("unavailable"), checkpointSha256: sha256,
    reason: z.enum(["checkpoint_missing", "checkpoint_mismatch", "load_failed", "opponent_not_6", "team_unmatched", "inference_failed"]) }).strict()
]);
export type MetamonLeadReason = Extract<z.infer<typeof leadModelSchema>, { status: "unavailable" }>["reason"];
/** The UU lead model's reply (scripts/metamon_port/lead_model.py): request-slot probabilities, re-keyed by the legal action
 * that leads that slot with the rest in ascending order. It imitates rated human leads; it is not a win estimate. */
export type MetamonLead = { status: "ok"; checkpointSha256: string; leadProbabilities: number[]; inferenceMs: number; distribution: Record<string, number> }
  | { status: "unavailable"; checkpointSha256: string; reason: MetamonLeadReason };

/** The optional team-preview reply field. Every slot must name exactly one enabled team action and the mass must sum
 * to 1; anything else is a broken worker. Singles preview only picks the lead (bench order is never modelled). */
export function mapMetamonLead(value: unknown, actions: readonly LegalAction[]): MetamonLead {
  const parsed = leadModelSchema.safeParse(value);
  if (!parsed.success) throw failure("protocol");
  if (parsed.data.status === "unavailable") return parsed.data;
  const probabilities = parsed.data.leadProbabilities;
  if (Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) > 1e-4) throw failure("protocol");
  const distribution: Record<string, number> = {};
  probabilities.forEach((p, index) => {
    const slot = index + 1, token = `team ${slot}${[1, 2, 3, 4, 5, 6].filter((other) => other !== slot).join("")}`;
    const matches = actions.filter((action) => action.kind === "team" && action.choice === token && !action.disabled && action.legality !== "disabled");
    if (matches.length !== 1) throw failure("official_action");
    distribution[matches[0]!.id] = p;
  });
  return { ...parsed.data, distribution };
}

export const TRAPPED_SWITCH_ERROR ="|error|[Unavailable choice] Can't switch: The active Pokémon is trapped";

/** Validate exactly one rejection/re-request exchange, possibly split across two chunks. */
export function trappedSwitchRejection(data: string, rqid: number, awaitingRequest = false): boolean {
  const lines = data.split("\n").filter(Boolean);
  if (!awaitingRequest && lines.shift() !== TRAPPED_SWITCH_ERROR) throw failure("uncommitted_action");
  if (lines.length > 1 || (awaitingRequest && lines.length !== 1)) throw failure("uncommitted_action");
  if (!lines.length) return false;
  if (!lines[0]!.startsWith("|request|")) throw failure("uncommitted_action");
  const request = JSON.parse(lines[0]!.slice(9));
  if (request?.rqid !== rqid || request.active?.length !== 1 || request.active[0].trapped !== true
    || request.wait || request.forceSwitch?.some(Boolean)) throw failure("identity");
  return true;
}

const VERSION = "metamon-worker@2";
const MAX_FRAME = 262_144;
const failure = (code: string) => new Error(`Metamon worker failed (${code}).`);

/** Showdown names a disguised Zoroark as the mon it imitates even in its own side's private stream, while that side's
 * request shows Zoroark active. The pinned decoder then tracks the imitated mon as active: Kakuna sees the wrong mon
 * and, when the imitated mon is the only switch left, no legal action remains (e2 dev cohort failures, 2026-10-21).
 * A player knows its own team, so name our disguised position as the real mon until it leaves and drop the then
 * redundant |replace|. The real mon is the only other Illusion holder in our last request whose max HP equals the
 * line's exact private HP; anything less certain is passed through unchanged. */
export class OwnIllusion {
  private party: { ident: string; details: string; maxHp: string | undefined; illusion: boolean }[] = [];
  private disguise: { shown: string; real: string } | undefined;
  constructor(private readonly side: "p1" | "p2") {}

  rewrite(data: string): string {
    const position = `${this.side}a: `, maxHp = (hp = "") => /^\d+\/(\d+)/.exec(hp)?.[1];
    return data.split("\n").flatMap((line) => {
      const fields = line.split("|");
      if (fields[1] === "request") {
        const party = JSON.parse(line.slice(9))?.side?.pokemon;
        if (Array.isArray(party)) this.party = party.map((mon) => ({ ident: String(mon.ident), details: String(mon.details),
          maxHp: maxHp(mon.condition), illusion: [mon.ability, mon.baseAbility].includes("illusion") }));
        return [line];
      }
      if ((fields[1] === "switch" || fields[1] === "drag") && fields[2]?.startsWith(position)) {
        this.disguise = undefined;
        const named = this.party.find((mon) => mon.ident === `${this.side}: ${fields[2]!.slice(position.length)}`);
        const real = this.party.filter((mon) => mon !== named && mon.illusion && mon.maxHp && mon.maxHp === maxHp(fields[4]));
        if (!named || named.maxHp === maxHp(fields[4]) || real.length !== 1) return [line];
        this.disguise = { shown: fields[2], real: position + real[0]!.ident.slice(this.side.length + 2) };
        fields[2] = this.disguise.real; fields[3] = real[0]!.details;
        return [fields.join("|")];
      }
      const disguise = this.disguise;
      if (!disguise) return [line];
      if (fields[1] === "replace" && fields[2] === disguise.real) { this.disguise = undefined; return []; }
      return [fields.map((field) => field === disguise.shown ? disguise.real
        : field === `[of] ${disguise.shown}` ? `[of] ${disguise.real}` : field).join("|")];
    }).join("\n");
  }
}

export class MetamonBattlePolicy implements BattlePolicy {
  readonly id = "metamon:Kakuna:epoch34";
  /** Chooses from the request's legal actions and models mechanics itself (worker's own state tracker). */
  readonly requiresSupportedMechanics = false;
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private closing: Promise<void> | undefined;
  private serial = 0;
  // Live Showdown shares one rqid counter across sides (3, 5, 7...); the pinned worker requires 1, 2, 3...
  private readonly toWorkerRqid = new Map<number, number>();
  private readonly toServerRqid = new Map<number, number>();
  private output = Buffer.alloc(0);
  private bytes = 0;
  private context: MetamonObservationContext | undefined;
  private illusion: OwnIllusion | undefined;
  private decidedRqid: number | null = null;
  private trappedAwaitingRequest = false;
  private staged: { binding: Record<string, unknown>; actions: LegalAction[]; decision: BattleDecision; distribution?: Record<string, number>; lead?: MetamonLead } | undefined;
  private committed?: { binding: Record<string, unknown>; choice: MetamonChoice };
  private pending: { id: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void } | undefined;

  constructor(private readonly worker: MetamonWorkerOptions) {}

  private start() {
    if (this.closed) throw failure("closed");
    if (this.child) return;
    this.child = spawn(this.worker.command, [...this.worker.args], { shell: false, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"], ...(this.worker.env ? { env: { ...process.env, ...this.worker.env } } : {}) });
    const child = this.child;
    child.on("error", () => this.fail("spawn"));
    child.on("exit", () => this.fail("exit"));
    child.stdin.on("error", () => this.fail("transport"));
    child.stdout.on("error", () => this.fail("transport"));
    child.stderr.on("error", () => this.fail("transport"));
    child.stderr.on("data", (chunk: Buffer) => {
      // Drain, bound and discard upstream logs; they can contain private state.
      this.bytes += chunk.length;
      if (this.bytes > 4_194_304) this.fail("output_limit");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.output = Buffer.concat([this.output, chunk]);
      if (this.output.length > MAX_FRAME) { this.fail("output_limit"); return; }
      let newline: number;
      while ((newline = this.output.indexOf(10)) !== -1) {
        const line = this.output.subarray(0, newline).toString("utf8");
        this.output = this.output.subarray(newline + 1);
        let reply: Record<string, unknown>;
        try { reply = JSON.parse(line); } catch { this.fail("invalid_json"); return; }
        if (!reply || Array.isArray(reply) || reply.version !== VERSION || !this.pending || reply.id !== this.pending.id) {
          this.fail("protocol"); return;
        }
        if (reply.ok !== true) {
          // Codes are intentionally fixed by this worker, never reflected messages.
          const codes = ["missing_assets", "runtime", "provenance", "protocol", "identity", "private_channel", "unsupported", "official_parser", "official_action"];
          this.fail(typeof reply.error === "string" && codes.includes(reply.error) ? reply.error : "worker_error"); return;
        }
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(reply);
      }
    });
  }

  get pid(): number | null { return this.closed ? null : this.child?.pid ?? null; }

  private fail(code: string) {
    const notify = !this.closed;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(failure(code));
    void this.close();
    if (notify) this.worker.onFailure?.(code);
  }

  private wireBinding(body: Record<string, unknown>, map: Map<number, number>) {
    const copy = structuredClone(body) as any;
    const mapped = (rqid: number) => { const value = map.get(rqid); if (value === undefined) throw failure("identity"); return value; };
    for (const identity of [copy.identity, copy.context?.identity, copy.binding?.identity]) {
      if (typeof identity?.rqid === "number") identity.rqid = mapped(identity.rqid);
    }
    if (map === this.toWorkerRqid && typeof copy.data === "string") copy.data = copy.data.split("\n").map((line: string) => {
      if (!line.startsWith("|request|")) return line;
      const request = JSON.parse(line.slice(9));
      request.rqid = mapped(request.rqid);
      return `|request|${JSON.stringify(request)}`;
    }).join("\n");
    return copy as Record<string, unknown>;
  }

  private async rpc(body: Record<string, unknown>, { deadlineAt, signal }: MetamonOperation) {
    if (signal.aborted) { this.fail("cancelled"); throw failure("cancelled"); }
    const remaining = deadlineAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 300_000) throw failure("deadline");
    if (this.pending) { this.fail("concurrent_operation"); throw failure("concurrent_operation"); }
    const id = ++this.serial;
    const line = JSON.stringify({ ...(this.worker.renumberRequests ? this.wireBinding(body, this.toWorkerRqid) : body), version: VERSION, id }) + "\n";
    if (Buffer.byteLength(line) > MAX_FRAME) { this.fail("input_limit"); throw failure("input_limit"); }
    this.start();
    const abort = () => this.fail("cancelled");
    const timer = setTimeout(() => this.fail("timeout"), Math.ceil(remaining));
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else this.child!.stdin.write(line);
      });
      if (this.closed || signal.aborted || Date.now() >= deadlineAt) throw failure("expired");
      return this.worker.renumberRequests ? this.wireBinding(result, this.toServerRqid) : result;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }

  async observe(data: string, context: MetamonObservationContext, options: MetamonOperation): Promise<void> {
    try {
      let rechoice = false;
      if (this.staged) {
        const action = this.staged.actions.find(a => a.id === this.staged!.decision.actionId);
        if (action?.kind !== "switch") throw failure("uncommitted_action");
        rechoice = trappedSwitchRejection(data, this.staged.decision.identity.rqid!, this.trappedAwaitingRequest);
        if (rechoice && (!context.identity || context.identity.rqid !== this.staged.decision.identity.rqid
          || isDeepStrictEqual(context.identity, this.staged.decision.identity))) throw failure("identity");
      }
      if (!["gen9ou", "gen9uu"].includes(context.format)
        || !new RegExp(`^battle-${context.format}-[a-zA-Z0-9-]+$`).test(context.roomId)
        || context.sequence !== (this.context?.sequence ?? 0) + 1
        || (this.context && ["roomId", "side", "format"].some((key) => context[key as keyof MetamonObservationContext] !== this.context![key as keyof MetamonObservationContext]))) throw failure("observation_context");
      if (context.identity && context.identity.roomId !== context.roomId) throw failure("identity");
      if (data.split("\n").some((line) => line.startsWith("|init|") && (this.context || line !== "|init|battle"))) throw failure("protocol_reset");
      if (data.split("\n").some((line) => line.startsWith("|split|"))) throw failure("private_channel");
      for (const line of data.split("\n").filter((line) => line.startsWith("|request|"))) {
        let request;
        try { request = JSON.parse(line.slice(9)); } catch { throw failure("protocol"); }
        if (request?.side?.id !== context.side) throw failure("private_channel");
        if (this.worker.renumberRequests && Number.isSafeInteger(request.rqid) && request.rqid >= 1 && !this.toWorkerRqid.has(request.rqid)) {
          const workerRqid = this.toWorkerRqid.size + 1;
          this.toWorkerRqid.set(request.rqid, workerRqid); this.toServerRqid.set(workerRqid, request.rqid);
        }
      }
      const frame = structuredClone(context);
      this.illusion ??= new OwnIllusion(context.side);
      const reply = await this.rpc({ op: "observe", data: this.illusion.rewrite(data), context: frame }, options);
      if (!isDeepStrictEqual(reply.context, frame)) throw failure("identity");
      this.context = frame;
      if (this.staged) {
        this.trappedAwaitingRequest = !rechoice;
        if (rechoice) this.staged = undefined;
      }
    } catch (error) { await this.close(); throw error; }
  }

  async decide(input: BattlePolicyInput, options: MetamonOperation): Promise<BattleDecision> {
    try {
      if (this.closed) throw failure("closed");
      if (this.trappedAwaitingRequest) throw failure("identity");
      input = structuredClone(input);
      const { identity, snapshot } = input.envelope.semantic;
      if (!this.context || !isDeepStrictEqual(this.context.identity, identity) || snapshot.yourSide.slot !== this.context.side
        || toID(snapshot.format) !== this.context.format || identity.rqid === null || identity.rqid === this.decidedRqid) throw failure("identity");
      const binding = { requestId: input.requestId, identity: structuredClone(identity), resultHash: input.envelope.resultHash, sequence: this.context.sequence };
      if (this.staged) {
        if (!isDeepStrictEqual(this.staged.binding, binding)) throw failure("identity");
        if (options.signal.aborted || Date.now() >= options.deadlineAt) throw failure("expired");
        return structuredClone(this.staged.decision);
      }
      const actions = structuredClone(snapshot.legalActions);
      const reply = await this.rpc({ op: "propose", ...binding }, options);
      if (!isDeepStrictEqual(reply.binding, binding)) throw failure("identity");
      const actionId = mapMetamonChoice(reply.choice, actions);
      const decision = { requestId: input.requestId, identity: structuredClone(identity), actionId,
        ...(snapshot.phase === "preview" ? { reason: "Official random team preview; no Kakuna network decision." } : {}) };
      // Optional: older wrappers and the plain pinned worker send no distribution.
      const distribution = reply.actionProbabilities === undefined ? undefined : mapMetamonDistribution(reply.actionProbabilities, actions, actionId);
      // Optional too: only our lead-model wrapper sends it, and only on a team preview.
      if (reply.leadModel !== undefined && snapshot.phase !== "preview") throw failure("protocol");
      const lead = reply.leadModel === undefined ? undefined : mapMetamonLead(reply.leadModel, actions);
      this.staged = { binding, actions, decision, ...(distribution ? { distribution } : {}), ...(lead ? { lead } : {}) };
      return structuredClone(decision);
    } catch (error) { await this.close(); throw error; }
  }

  /** The staged proposal's legal-action distribution (what the worker sampled from), when the worker reports it. */
  proposalDistribution(requestId: string): Record<string, number> | undefined {
    return this.staged?.decision.requestId === requestId && this.staged.distribution ? structuredClone(this.staged.distribution) : undefined;
  }

  /** The staged team preview's lead-model reply, when the worker reports one (never what the worker sampled from). */
  proposalLead(requestId: string): MetamonLead | undefined {
    return this.staged?.decision.requestId === requestId && this.staged.lead ? structuredClone(this.staged.lead) : undefined;
  }

  /** Bind a human's submitted switch before observing its rejection; no commit or RNG draw. */
  async stageSwitch(input: BattlePolicyInput, actionId: string, options: MetamonOperation): Promise<void> {
    try {
      const binding = { requestId: input.requestId, identity: structuredClone(input.envelope.semantic.identity),
        resultHash: input.envelope.resultHash, sequence: this.context?.sequence };
      if (!this.staged || this.trappedAwaitingRequest || !isDeepStrictEqual(this.staged.binding, binding)
        || !isDeepStrictEqual(this.context?.identity, binding.identity)) throw failure("identity");
      const action = this.staged.actions.find(a => a.id === actionId && a.kind === "switch" && !a.disabled && a.legality !== "disabled");
      if (!action) throw failure("official_action");
      const choice: MetamonChoice = { kind: "switch", switchSlot: action.targetSlot! };
      const reply = await this.rpc({ op: "stage_switch", ...binding, choice }, options);
      if (!isDeepStrictEqual(reply.binding, binding) || !isDeepStrictEqual(reply.choice, choice)) throw failure("identity");
      this.staged.decision = { ...this.staged.decision, actionId };
    } catch (error) { await this.close(); throw error; }
  }

  async commit(input: BattlePolicyInput, decision: BattleDecision, options: MetamonOperation): Promise<void> {
    try {
      if (this.closed) throw failure("closed");
      if (options.signal.aborted || !Number.isFinite(options.deadlineAt) || Date.now() >= options.deadlineAt) throw failure("expired");
      input = structuredClone(input);
      const identity = input.envelope.semantic.identity;
      const binding = { requestId: input.requestId, identity: structuredClone(identity), resultHash: input.envelope.resultHash, sequence: this.context?.sequence };
      if (!this.context || !isDeepStrictEqual(identity, this.context.identity)
        || decision.requestId !== input.requestId || !isDeepStrictEqual(decision.identity, identity)) throw failure("identity");
      if (!this.staged) {
        if (isDeepStrictEqual(this.committed?.binding, binding)
          && mapMetamonChoice(this.committed!.choice, input.envelope.semantic.snapshot.legalActions) === decision.actionId) return;
        throw failure("uncommitted_action");
      }
      if (!isDeepStrictEqual(this.staged.binding, binding)) throw failure("identity");
      const action = this.staged.actions.find((entry) => entry.id === decision.actionId && !entry.disabled && entry.legality !== "disabled");
      const choice: MetamonChoice = choiceSchema.parse(action?.kind === "move"
        ? { kind: "move", moveSlot: action.moveSlot, terastallize: Boolean(action.terastallize) }
        : action?.kind === "switch" ? { kind: "switch", switchSlot: action.targetSlot }
        : action?.kind === "team" ? { kind: "team", team: action.teamSpec } : null);
      if (mapMetamonChoice(choice, this.staged.actions) !== decision.actionId) throw failure("identity");
      const reply = await this.rpc({ op: "commit", ...binding, choice }, options);
      if (!isDeepStrictEqual(reply.binding, binding) || !isDeepStrictEqual(reply.choice, choice)) throw failure("identity");
      this.decidedRqid = identity.rqid;
      this.committed = { binding, choice };
      this.staged = undefined;
    } catch (error) { await this.close(); throw error; }
  }

  /** Also kills descendants after the leader exits, bounded to 150 ms. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.pending?.reject(failure("closed")); this.pending = undefined;
    const child = this.child;
    const kill = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ }
    };
    // EOF reaches the remote worker through ssh and frees its GPU allocation.
    // Give it a bounded grace period, then retain the existing process-group kill.
    child?.stdin.end();
    this.closing = new Promise<void>((resolve) => {
      if (!child) { resolve(); return; }
      setTimeout(() => kill("SIGTERM"), 50);
      setTimeout(() => {
        kill("SIGKILL");
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        this.output = Buffer.alloc(0); resolve();
      }, 150);
    });
    return this.closing;
  }
}

type AdviceBinding = { requestId: string; identity: CanonicalDecisionIdentity; inputResultHash: string };
type AdviceUnavailableReason = "timeout" | "advisor_failed" | "stale_advice";
type AdviceRouting = {
  adviceActionId: string | null; modelActionId: string; executedActionId: string;
  override: "none" | "accepted" | "rejected:missing_override" | "rejected:invalid_card_field" | "rejected:illegal_action";
  cardField: string | null;
  fallback?: "unavailable";
};
export type MetamonAdviceEvent = AdviceBinding & { mode: BattleAdviceMode } & (
  | { phase: "opinion"; eligible: boolean; status: "available" | "hidden_preview" | "hidden_singleton"; proposedActionId: string }
  | { phase: "opinion"; eligible: boolean; status: "unavailable"; reason: AdviceUnavailableReason }
  | ({ phase: "commit"; status: "committed" | "unavailable"; adviceShown: boolean; selectedActionId: string; proposedActionId?: string } & AdviceRouting)
);

/** One actor-side advisor, distinct from the opponent. Missing advice preserves
 * ordinary model behavior; veto adjudication never requests another generation. */
export class MetamonAdvisedBattlePolicy implements BattlePolicy {
  readonly id: string;
  private unavailable: AdviceUnavailableReason | undefined;
  private pending: { binding: AdviceBinding; proposedActionId?: string; staged: boolean; shown: boolean; routing?: AdviceRouting } | undefined;
  private committed: { binding: AdviceBinding; actionId: string } | undefined;
  private closed = false;
  private readonly waitMs: number;
  private readonly mode: BattleAdviceMode;
  private readonly onAdvice: (event: MetamonAdviceEvent) => void | Promise<void>;

  constructor(private readonly model: BattlePolicy,
    private readonly advisor: Pick<MetamonBattlePolicy, "id" | "observe" | "decide" | "commit" | "close">,
    options: { onAdvice: (event: MetamonAdviceEvent) => void | Promise<void>; waitMs?: number; mode?: BattleAdviceMode }) {
    if (model === advisor || model.id === advisor.id || advisor.id !== "metamon:Kakuna:epoch34") throw new Error("A model and a separate actor-side Kakuna advisor are required.");
    this.waitMs = options.waitMs ?? 5000;
    if (!Number.isInteger(this.waitMs) || this.waitMs < 1 || this.waitMs > 5000
      || typeof options.onAdvice !== "function") throw new Error("Advice requires a recorder and a wait budget from 1 to 5000 ms.");
    this.onAdvice = options.onAdvice;
    this.mode = options.mode ?? "suggest";
    if (this.mode !== "suggest" && this.mode !== "veto") throw new Error("Advice mode must be suggest or veto.");
    this.id = `${model.id}+metamon-advice@1${this.mode === "veto" ? "|advice=veto" : ""}`;
  }

  private binding(input: BattlePolicyInput): AdviceBinding {
    return { requestId: input.requestId, identity: structuredClone(input.envelope.semantic.identity), inputResultHash: input.envelope.resultHash };
  }
  private check(options: MetamonOperation) {
    options.signal.throwIfAborted();
    if (this.closed || !Number.isFinite(options.deadlineAt) || Date.now() >= options.deadlineAt) throw new Error("Advised decision is closed or expired.");
  }
  private retire(reason: AdviceUnavailableReason) {
    this.unavailable = reason;
    // The transport has its own bounded shutdown. Do not extend the advice wait
    // while a slow/failed worker is being retired; its late result is consumed.
    void this.advisor.close().catch(() => {});
  }
  private async record(event: MetamonAdviceEvent, options: MetamonOperation) {
    try {
      await withinDeadline(options.deadlineAt, options.signal, async () => this.onAdvice(structuredClone(event)));
    } catch {
      this.check(options);
      throw new Error("Metamon advice recorder failed.");
    }
  }

  async observe(data: string, context: MetamonObservationContext, options: MetamonOperation): Promise<void> {
    options = Object.freeze({ deadlineAt: options.deadlineAt, signal: options.signal });
    this.check(options);
    if (this.pending) throw new Error("Executor acceptance must be committed before another observation.");
    await this.model.observe?.(data, structuredClone(context), options);
    if (!this.unavailable) {
      try { await this.advisor.observe(data, structuredClone(context), options); }
      catch { this.check(options); this.retire("advisor_failed"); }
    }
    this.check(options);
  }

  async decide(input: BattlePolicyInput, options: BattlePolicyDecideOptions): Promise<BattleDecision> {
    options = Object.freeze({ deadlineAt: options.deadlineAt, signal: options.signal,
      ...(options.assertCurrent === undefined ? {} : { assertCurrent: options.assertCurrent }) });
    this.check(options);
    if (this.pending || input.advice !== undefined || typeof options.assertCurrent !== "function") throw new Error("Advice requires one current, unadvised decision input.");
    const captured = structuredClone(input), binding = this.binding(captured);
    const snapshot = captured.envelope.semantic.snapshot;
    const enabled = structuredClone(snapshot.legalActions.filter((action) => action.choice && !action.disabled && action.legality !== "disabled"));
    const eligible = this.mode === "veto" || (snapshot.phase !== "preview" && enabled.length >= 2);
    const current = async () => {
      this.check(options);
      await withinDeadline(options.deadlineAt, options.signal, async () => options.assertCurrent!());
      this.check(options);
    };
    await current();
    this.pending = { binding, staged: false, shown: false };
    let proposal: BattleDecision | undefined;
    if (!this.unavailable) {
      const adviceDeadline = Math.min(options.deadlineAt, Date.now() + this.waitMs);
      let rejection: AdviceUnavailableReason | undefined;
      try {
        proposal = await withinDeadline(adviceDeadline, options.signal, async (signal) =>
          this.advisor.decide(structuredClone(captured), { deadlineAt: adviceDeadline, signal }));
        const parsed = battleDecisionSchema.safeParse(proposal);
        if (this.mode === "veto" && parsed.success && (proposal.requestId !== binding.requestId
          || !isDeepStrictEqual(proposal.identity, binding.identity))) rejection = "stale_advice";
        if (!parsed.success || proposal.requestId !== binding.requestId
          || !isDeepStrictEqual(proposal.identity, binding.identity)
          || !captured.envelope.semantic.snapshot.legalActions.some((action) => action.id === proposal!.actionId
            && action.choice && !action.disabled && action.legality !== "disabled")) throw new Error();
        proposal = structuredClone(parsed.data);
        this.pending.staged = true; this.pending.proposedActionId = proposal.actionId;
      } catch {
        this.check(options);
        this.retire(rejection ?? (Date.now() >= adviceDeadline ? "timeout" : "advisor_failed")); proposal = undefined;
      }
    }
    await current();
    if (proposal) {
      const status = this.mode === "veto" ? "available" : snapshot.phase === "preview" ? "hidden_preview" : enabled.length < 2 ? "hidden_singleton" : "available";
      if (status === "available") {
        this.pending.shown = true;
        captured.advice = { source: "metamon", policyId: "metamon:Kakuna:epoch34", ...structuredClone(binding), actionId: proposal.actionId,
          ...(this.mode === "veto" ? { mode: "veto" as const } : {}) } satisfies BattleAdvice;
        inspectBattleAdvice(captured);
      }
      await this.record({ ...binding, mode: this.mode, phase: "opinion", eligible, status, proposedActionId: proposal.actionId }, options);
    } else await this.record({ ...binding, mode: this.mode, phase: "opinion", eligible, status: "unavailable", reason: this.unavailable! }, options);
    await current();
    const result = structuredClone(await this.model.decide(captured, options));
    await current();
    const { veto, ...plain } = result;
    const vetoActive = this.mode === "veto" && proposal !== undefined;
    const decision = vetoActive ? plain : result;
    // Validate the ordinary binding even when the proposed action is illegal.
    // Only veto changes action legality into a deterministic rejection/default.
    if (vetoActive && (!battleDecisionSchema.safeParse(decision).success || decision.requestId !== binding.requestId
      || !isDeepStrictEqual(decision.identity, binding.identity))) throw new Error("Model returned an invalid advised decision.");
    const routing: AdviceRouting = { adviceActionId: proposal?.actionId ?? null, modelActionId: decision.actionId,
      executedActionId: decision.actionId, override: "none", cardField: vetoActive ? veto?.override?.cardField ?? null : null,
      ...(proposal === undefined ? { fallback: "unavailable" as const } : {}) };
    if (vetoActive && proposal && decision.actionId !== proposal.actionId) {
      const override = battleOverrideSchema.safeParse(veto?.override);
      // Rejection precedence is missing object, invalid citation, then legality.
      const code = veto?.override === undefined ? "missing_override"
        : !override.success || !hasCardField(veto?.card, override.data.cardField) ? "invalid_card_field"
        : !enabled.some((action) => action.id === decision.actionId) ? "illegal_action" : undefined;
      routing.override = code ? `rejected:${code}` : "accepted";
      if (code) {
        decision.actionId = proposal.actionId;
        delete decision.reason;
      }
      routing.executedActionId = decision.actionId;
    }
    this.pending!.routing = routing;
    return decision;
  }

  async commit(input: BattlePolicyInput, decision: BattleDecision, options: BattlePolicyDecideOptions): Promise<void> {
    options = Object.freeze({ deadlineAt: options.deadlineAt, signal: options.signal,
      ...(options.assertCurrent === undefined ? {} : { assertCurrent: options.assertCurrent }) });
    this.check(options);
    const captured = structuredClone(input), accepted = structuredClone(decision), binding = this.binding(captured);
    if (accepted.requestId !== binding.requestId || !isDeepStrictEqual(accepted.identity, binding.identity)
      || !captured.envelope.semantic.snapshot.legalActions.some((action) => action.id === accepted.actionId
        && action.choice && !action.disabled && action.legality !== "disabled")) throw new Error("Accepted action does not match the advised decision.");
    if (!this.pending) {
      if (isDeepStrictEqual(this.committed, { binding, actionId: accepted.actionId })) return;
      throw new Error("No advised decision awaits executor acceptance.");
    }
    if (!isDeepStrictEqual(this.pending.binding, binding)) throw new Error("Accepted action has a different advice binding.");
    if (this.mode === "veto" && this.pending.shown && accepted.actionId !== this.pending.routing?.executedActionId) throw new Error("Accepted action differs from advice routing.");
    await this.model.commit?.(structuredClone(captured), structuredClone(accepted), options);
    let status: "committed" | "unavailable" = "unavailable";
    if (this.pending.staged && !this.unavailable) {
      try { await this.advisor.commit(captured, accepted, options); status = "committed"; }
      catch { this.check(options); this.retire("advisor_failed"); }
    }
    await this.record({ ...binding, mode: this.mode, ...this.pending.routing!, executedActionId: accepted.actionId, phase: "commit", status, adviceShown: this.pending.shown, selectedActionId: accepted.actionId,
      ...(this.pending.proposedActionId === undefined ? {} : { proposedActionId: this.pending.proposedActionId }) }, options);
    this.committed = { binding, actionId: accepted.actionId }; this.pending = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([this.model.close?.(), this.advisor.close()]);
  }
}
