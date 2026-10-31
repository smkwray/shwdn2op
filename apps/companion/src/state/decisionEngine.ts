import { z } from "zod";
import { createDecisionIdentity, hashCanonical, sameDecision, type DecisionIdentity } from "../../../extension/lib/decision-identity.js";
import { battleSnapshotSchema } from "../schema.js";
import type { BattleSnapshot } from "../types.js";
import { withinDeadline } from "./deadline.js";
import { createCanonicalLedger, appendCanonicalLines, materializeCanonicalLedger, isCanonicalTimelineLine, type CanonicalLedger } from "./canonicalLedger.js";

// The existing reducer remains shared during the move to companion-owned
// observations. There is one implementation, used by fixtures and replay too.
const { roomToSnapshot, splitProtocolPacket } = await import(
  new URL("../../../extension/lib/showdown-parser.js", import.meta.url).href
);

export const observationSchema = z.object({
  observationId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(100),
  sequence: z.number().int().positive(),
  roomId: z.string().startsWith("battle-"),
  source: z.enum(["protocol", "recovery"]),
  data: z.string().min(1).max(2_000_000)
}).strict();
export type BattleObservation = z.infer<typeof observationSchema>;
export interface CanonicalDecisionIdentity extends DecisionIdentity {
  stateRevision: number;
  requestKind: string;
}
type RoomRecord = {
  room: any;
  ledger: CanonicalLedger;
  sequence: number;
  stateRevision: number;
  observations: Array<BattleObservation & { payloadHash: string }>;
  ids: Map<string, string>;
  quarantinedRequests: Array<{ observationId: string; lineIndex: number; rqid: number | null; digest: string; reason: string }>;
};
type ObservationResult = {
  applied: boolean; changed: boolean; room: any; snapshot: BattleSnapshot | null;
  identity: CanonicalDecisionIdentity | null; sequence: number;
};

export class DecisionConflict extends Error {}

export function sameCanonicalDecision(left: CanonicalDecisionIdentity, right: CanonicalDecisionIdentity) {
  return sameDecision(left, right) && left.stateRevision === right.stateRevision && left.requestKind === right.requestKind;
}

/** Ordered, idempotent, per-capture canonical state; evaluation never mutates it. */
export class DecisionEngine {
  private rooms = new Map<string, RoomRecord>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly ownedOfflineStream: boolean;
  private readonly operationMs: number;
  private active: { operation: string; startedAt: number } | null = null;
  private lastFailure: string | null = null;
  private queued = 0;

  /** Internal producer authority, never taken from observations or HTTP input.
   * Only the simulator bridge owns a complete, separately routed side stream. */
  constructor(options: { source?: "owned_offline_simulator"; operationMs?: number } = {}) {
    this.ownedOfflineStream = options.source === "owned_offline_simulator";
    this.operationMs = options.operationMs ?? 5000;
  }

  synchronizationStatus() {
    return { ...this.active, ageMs: this.active ? Date.now() - this.active.startedAt : 0,
      queued: this.queued, lastFailure: this.lastFailure };
  }

  private serialize<T>(operation: string, work: (check: () => void) => Promise<T>) {
    this.queued++;
    const run = this.chain.then(async () => {
      this.queued--; this.active = { operation, startedAt: Date.now() };
      try { return await withinDeadline(operation, this.operationMs, work); }
      catch (error) { this.lastFailure = error instanceof Error ? error.message : String(error); throw error; }
      finally { this.active = null; }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private key(sessionId: string, roomId: string) { return `${sessionId}\n${roomId}`; }

  ingest(input: BattleObservation) {
    return this.ingestBatch([input]).then((results) => results[0]!);
  }

  ingestBatch(inputs: BattleObservation[], commit?: (results: ObservationResult[], check: () => void) => Promise<void>) {
    return this.serialize("ingestion", async (check) => {
      const observations = z.array(observationSchema).min(1).max(100).parse(inputs);
      const staged = new Map(this.rooms);
      const affected = new Set(observations.map((entry) => this.key(entry.sessionId, entry.roomId)));
      for (const key of affected) {
        const record = staged.get(key);
        if (record) staged.set(key, { ...record, room: structuredClone(record.room), ledger: structuredClone(record.ledger), observations: [...record.observations], ids: new Map(record.ids) });
      }
      const results = [];
      for (const observation of observations) results.push(await this.apply(observation, staged));
      check();
      await commit?.(results, check);
      check();
      this.rooms = staged;
      return results;
    });
  }

  private async apply(observation: BattleObservation, records: Map<string, RoomRecord>): Promise<ObservationResult> {
    const packets = splitProtocolPacket(observation.data);
    if (packets.length !== 1 || packets[0].roomId !== observation.roomId) throw new DecisionConflict("Observation room and protocol routing differ.");
    const key = this.key(observation.sessionId, observation.roomId);
    const previous = records.get(key);
    const payloadHash = await hashCanonical(observation);
    const knownHash = previous?.ids.get(observation.observationId);
    if (knownHash) {
      if (knownHash !== payloadHash) throw new DecisionConflict("An observation ID was reused with different content.");
      return { applied: false, changed: false, ...await this.readRecord(records.get(key)) };
    }
    if (previous && observation.sequence <= previous.sequence) throw new DecisionConflict("Out-of-order observation; retry missing observations in sequence.");

    const reset = observation.source === "protocol" && packets[0].lines.includes("|init|battle");
    let ledger = previous && !reset ? structuredClone(previous.ledger) : createCanonicalLedger(observation.roomId);
    let room: any;
    if (observation.source === "protocol") {
      // A fresh server initialization starts a new reduction, preserving the
      // outer observation revision so a reconnect cannot reuse an old result.
      appendCanonicalLines(ledger, packets[0].lines, observation);
      room = materializeCanonicalLedger(ledger);
    } else {
      // Classify private epochs before invoking any reducer: dropping
      // lastRequest after reduction cannot undo HP/item/stat mutations.
      // Revocation does not erase the last numbered epoch. Recovery must not
      // restore that epoch merely because the latest wire request was null.
      const priorRequests = [...ledger.facts].reverse().filter((fact) => fact.kind === "request");
      const priorRequest = priorRequests.find((fact) => Number.isSafeInteger(fact.source.rqid)) ?? priorRequests[0];
      let currentRequest = priorRequest ? JSON.parse(priorRequest.args.join("|")) : null;
      const quarantinedRequests = [...(previous?.quarantinedRequests ?? [])];
      const lines: string[] = [];
      for (const [lineIndex, line] of packets[0].lines.entries()) {
        if (line.startsWith("|request|") && currentRequest) {
          let recovered: any;
          try { recovered = JSON.parse(line.slice(9)); }
          catch { throw new DecisionConflict("Malformed recovery request."); }
          if (Number.isSafeInteger(currentRequest.rqid)) {
            if (!Number.isSafeInteger(recovered?.rqid) || recovered.rqid < currentRequest.rqid) { lines.push(""); continue; }
            if (recovered.rqid === currentRequest.rqid) {
              const digest = await hashCanonical(recovered);
              if (digest !== await hashCanonical(currentRequest)) quarantinedRequests.push({
                observationId: observation.observationId, lineIndex, rqid: recovered.rqid, digest,
                reason: "same_epoch_recovery_conflict"
              });
              lines.push(""); continue; // Preserve original line indexes for provenance.
            }
          } else if (!Number.isSafeInteger(recovered?.rqid)) { lines.push(""); continue; }
        }
        lines.push(line);
        if (line.startsWith("|request|")) {
          try { currentRequest = JSON.parse(line.slice(9)); }
          catch { throw new DecisionConflict("Malformed recovery request."); }
        }
      }
      // A no-argument tag may end at the tag or at its separator (|start / |start|).
      // Keep every actual argument, empty argument slot and event ordinal intact.
      const timelineKey = (line: string) => line.replace(/^(\|[^|]+)\|$/, "$1");
      const factLine = (fact: CanonicalLedger["facts"][number]) => ["", fact.kind, ...fact.args].join("|");
      let publicLines = ledger.facts.map(factLine).filter(isCanonicalTimelineLine).map(timelineKey);
      const incoming = lines.filter(isCanonicalTimelineLine).map(timelineKey);
      let aligned = incoming.length >= publicLines.length && publicLines.every((line, index) => line === incoming[index]);
      // A cold public capture may start in the middle of a battle. Only an
      // exact, unique suffix of an anchored queue proves its missing prefix.
      // Never rebase anchored or private histories: their IDs may already
      // support persisted contributions or rqid-scoped decisions.
      if (!aligned && publicLines.length && incoming[0] === "|clearpoke"
          && incoming.filter((line) => line === "|clearpoke").length === 1
          && incoming.filter((line) => line === "|start").length === 1
          && !ledger.facts.some((fact) => ["init", "clearpoke", "poke", "request"].includes(fact.kind))
          && !lines.some((line) => line.startsWith("|request|"))) {
        const offsets = incoming.flatMap((_, index) => publicLines.every((line, offset) => line === incoming[index + offset]) ? [index] : []);
        const offset = offsets.length === 1 ? offsets[0]! : -1;
        const metadata = ledger.facts.filter((fact) => !isCanonicalTimelineLine(factLine(fact)));
        const metadataKey = (line: string) => {
          const [, kind, side] = line.split("|");
          return `${kind}:${["player", "teamsize"].includes(kind ?? "") ? side : ""}`;
        };
        const metadataConflict = lines.some((line) => metadata.some((fact) => metadataKey(line) === metadataKey(factLine(fact)) && line !== factLine(fact)));
        const metadataAligned = metadata.every((fact) =>
          lines.filter((line) => line === factLine(fact)).length === 1
          && metadata.filter((entry) => factLine(entry) === factLine(fact)).length === 1);
        if (offset > 0 && offset + publicLines.length === incoming.length && !metadataConflict && metadataAligned) {
          const prior = ledger;
          ledger = createCanonicalLedger(observation.roomId);
          ledger.recoveryQuarantines = prior.recoveryQuarantines;
          const overlap = prior.facts.filter((fact) => isCanonicalTimelineLine(factLine(fact)));
          let index = 0;
          // Rebuild in the recovery's proven order, including metadata. Moving
          // missing metadata before retained metadata would renumber its IDs.
          for (const [lineIndex, line] of lines.entries()) {
            const retained = isCanonicalTimelineLine(line)
              ? overlap[index++ - offset]
              : metadata.find((fact) => factLine(fact) === line);
            appendCanonicalLines(ledger, [retained ? factLine(retained) : line], retained ? {
              observationId: retained.source.observationId, sequence: retained.source.sequence,
              source: retained.source.channel === "recovery" ? "recovery" : "protocol", lineOffset: retained.source.lineIndex - 1
            } : { ...observation, lineOffset: lineIndex });
          }
          publicLines = ledger.facts.map(factLine).filter(isCanonicalTimelineLine).map(timelineKey);
          aligned = true;
        }
      }
      let publicIndex = 0;
      const admitted = lines.map((line) => {
        if (line.startsWith("|sso-state|")) return "";
        if (!line.startsWith("|") || line.startsWith("|request|")) return line;
        if (!isCanonicalTimelineLine(line)) return previous ? "" : line;
        const index = publicIndex++;
        return aligned && index >= publicLines.length ? line : "";
      });
      const retainedPrefix = incoming.length <= publicLines.length && incoming.every((line, index) => line === publicLines[index]);
      if (!aligned && incoming.length && !retainedPrefix) ledger.recoveryQuarantines.push({ observationId: observation.observationId, reason: "recovery_chronology_quarantined" });
      // Recovery supplies no binding between the end of its public queue and
      // its private request. Even an apparently full queue may be stale.
      // Same/stale requests were filtered above; every new non-null recovery
      // request withholds current decisions until an authoritative reset.
      if (admitted.some((line) => line.startsWith("|request|") && JSON.parse(line.slice(9)) !== null)) {
        ledger.recoveryQuarantines.push({ observationId: observation.observationId, reason: "recovery_public_continuity_unknown" });
      }
      appendCanonicalLines(ledger, admitted, observation);
      room = materializeCanonicalLedger(ledger);
      room.quarantinedRequests = quarantinedRequests;
    }
    if (!room) throw new DecisionConflict("No battle room could be reduced.");
    const record: RoomRecord = {
      room, ledger, sequence: observation.sequence, stateRevision: previous?.stateRevision ?? 0,
      observations: [...(previous?.observations ?? []), { ...observation, payloadHash }],
      ids: new Map(previous?.ids ?? []),
      quarantinedRequests: room.quarantinedRequests ?? previous?.quarantinedRequests ?? []
    };
    const oldSnapshot = previous ? this.snapshot(previous) : null;
    const newSnapshot = this.snapshot(record);
    const changed = !previous || reset
      || await hashCanonical(oldSnapshot && { ...oldSnapshot, capturedAt: null }) !== await hashCanonical(newSnapshot && { ...newSnapshot, capturedAt: null });
    if (changed) record.stateRevision++;
    record.ids.set(observation.observationId, payloadHash);
    records.set(key, record);
    return { applied: true, changed, ...await this.readRecord(record) };
  }

  async read(sessionId: string, roomId: string) {
    return this.readRecord(this.rooms.get(this.key(sessionId, roomId)));
  }

  private turnCoverage(record: RoomRecord, snapshot: BattleSnapshot): BattleSnapshot["turnCoverage"] {
    if (!this.ownedOfflineStream || snapshot.phase !== "turn" || snapshot.turn < 1
        || !["move", "forced_switch"].includes(String(snapshot.rawRequestSummary?.requestKind))
        || record.room.requestCurrent !== true || record.room.winner
        || record.ledger.recoveryQuarantines.length || record.quarantinedRequests.length) return;
    // Keep disqualification in the actual retained stream: a later reset or
    // clean turn cannot erase a gap/recovery, and rollback needs no extra state.
    if (record.observations.length !== record.sequence) return;
    for (const [index, observation] of record.observations.entries()) {
      if (observation.source !== "protocol" || observation.sequence !== index + 1) return;
      const lines: string[] = splitProtocolPacket(observation.data)[0].lines;
      if (index === 0 && lines[0] !== "|init|battle") return;
      if (lines.some((line, lineIndex) => /^\|init(?:\||$)/.test(line) && (index !== 0 || lineIndex !== 0))) return;
    }
    const facts = record.ledger.facts;
    const starts = facts.filter((fact) => fact.kind === "start");
    const turns = facts.filter((fact) => fact.kind === "turn");
    const turn = turns.at(-1), request = facts.at(-1);
    if (starts.length !== 1 || !turn || !request || request.kind !== "request"
        || turns.some((fact, index) => fact.args.length !== 1 || fact.args[0] !== String(index + 1))
        || facts.indexOf(starts[0]!) > facts.indexOf(turns[0]!)
        || facts.filter((fact) => fact.kind === "clearpoke").length > 1
        || facts.slice(facts.indexOf(starts[0]!) + 1).some((fact) => fact.kind === "clearpoke")
        || facts.some((fact) => ["win", "tie"].includes(fact.kind))
        || facts.slice(facts.indexOf(turn)).some((fact) => fact.kind === "upkeep")
        || turn.turn !== snapshot.turn || request.turn !== snapshot.turn
        || facts.indexOf(request) <= facts.indexOf(turn)) return;
    let previousRqid = 0;
    for (const fact of facts.filter((fact) => fact.kind === "request")) {
      const own = JSON.parse(fact.args.join("|"));
      if (fact.source.channel !== "private-request" || own?.side?.id !== snapshot.yourSide.slot
          || !Number.isSafeInteger(own.rqid) || own.rqid <= previousRqid) return;
      previousRqid = own.rqid;
    }
    if (request.source.rqid !== snapshot.rawRequestSummary?.rqid
        || snapshot.rawRequestSummary?.sideId !== snapshot.yourSide.slot) return;
    return { source: "owned_offline_simulator", turn: snapshot.turn, turnFactId: turn.id, requestFactId: request.id,
      fromSequence: turn.source.sequence, throughSequence: record.sequence };
  }

  private snapshot(record: RoomRecord): BattleSnapshot | null {
    const raw = roomToSnapshot(record.room);
    if (!raw) return null;
    const coverage = this.turnCoverage(record, raw);
    if (coverage) raw.turnCoverage = coverage;
    return raw;
  }

  private async readRecord(record: RoomRecord | undefined) {
    if (!record) throw new DecisionConflict("Unknown capture session or room.");
    const raw = this.snapshot(record);
    const snapshot: BattleSnapshot | null = raw ? battleSnapshotSchema.parse(raw) : null;
    const identity: CanonicalDecisionIdentity | null = snapshot ? {
      ...await createDecisionIdentity(snapshot), stateRevision: record.stateRevision,
      requestKind: String(snapshot.rawRequestSummary?.requestKind ?? "none")
    } : null;
    return { room: structuredClone(record.room), snapshot, identity, sequence: record.sequence };
  }

  async assertCurrent(sessionId: string, expected: CanonicalDecisionIdentity) {
    await this.chain;
    return withinDeadline("current decision read", this.operationMs, async () => this.requireCurrent(sessionId, expected));
  }

  private async requireCurrent(sessionId: string, expected: CanonicalDecisionIdentity) {
    const current = await this.read(sessionId, expected.roomId);
    if (!current.identity || !sameCanonicalDecision(current.identity, expected)) throw new DecisionConflict("The decision is no longer current.");
    return current;
  }

  /** Use the same engine→history lock order as ingestion. Feedback may not
   * acquire history and then wait for an ingest which is waiting for history. */
  withCurrent<T>(sessionId: string, expected: CanonicalDecisionIdentity, operation: (current: Omit<ObservationResult, "applied" | "changed">, check: () => void) => T | Promise<T>) {
    return this.serialize("guarded decision", async (check) => {
      const current = await this.requireCurrent(sessionId, expected);
      check();
      return operation(current, check);
    });
  }

  observationReferences(sessionId: string, roomId: string) {
    const record = this.rooms.get(this.key(sessionId, roomId));
    return (record?.observations ?? []).flatMap((observation) => observation.data.split("\n").map((line, index) => ({
      observationId: `${observation.observationId}#${index}`, roomId, sequence: observation.sequence,
      source: observation.source, line
    })).filter((entry) => entry.line.startsWith("|")));
  }
}
