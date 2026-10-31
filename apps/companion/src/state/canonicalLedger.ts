import type { BattleSnapshot, PendingAttack, PokemonSnapshot } from "../types.js";
import assert from "node:assert/strict";
import { Dex } from "@pkmn/dex";
import { bootsProvenByEntry } from "../mechanics/switchEntry.js";

export type IdentityStatus = "resolved" | "provisional" | "ambiguous";
type SideId = "p1" | "p2";
type Subject = { side?: SideId | undefined; appearanceId?: string | undefined; instanceId?: string | undefined; candidateInstanceIds?: string[] | undefined };
export interface CanonicalFact {
  id: string;
  kind: string;
  args: string[];
  subject: Subject;
  references: Record<number, Subject>;
  requestSlots?: Subject[] | undefined;
  overlaySpecies?: string | undefined;
  source: { observationId: string; sequence: number; lineIndex: number; channel: "protocol" | "private-request" | "recovery"; rqid?: number | undefined };
  turn: number;
}
export interface MonInstance {
  id: string;
  side: SideId;
  origin: "private-party" | "team-preview" | "first-seen";
  ordinal: number;
  species: string;
  details: string;
  aliases: string[];
  establishedBy: string;
  privateSignature?: string;
}
export interface Appearance {
  id: string;
  side: SideId;
  position: string;
  ordinal: number;
  startedBy: string;
  endedBy?: string;
  apparent: { ident: string; details: string };
  candidateInstanceIds: string[];
  instanceId?: string;
  resolution: IdentityStatus;
  resolvedBy: string[];
  revealedDetails?: string;
  revealedIdent?: string;
  forme?: string;
}
export interface CanonicalLedger {
  roomId: string;
  facts: CanonicalFact[];
  instances: Record<string, MonInstance>;
  appearances: Record<string, Appearance>;
  active: Record<string, string>;
  privateSides: SideId[];
  turn: number;
  recoveryQuarantines: Array<{ observationId: string; reason: string }>;
}
const metadataTags = new Set(["init", "title", "player", "tier", "gametype", "teamsize"]);
const semanticTags = new Set([...metadataTags, "poke", "start", "clearpoke", "teampreview", "turn", "request", "switch", "drag", "replace", "move", "cant", "faint", "-damage", "-heal", "-status", "-curestatus", "-boost", "-unboost", "-setboost", "-clearboost", "-clearallboost", "-start", "-end", "-ability", "-endability", "-item", "-enditem", "-terastallize", "-activate", "detailschange", "-formechange", "-transform", "-weather", "-fieldstart", "-fieldend", "-sidestart", "-sideend", "-supereffective", "-resisted", "-immune", "-crit", "-fail", "-miss", "-hitcount", "-singleturn", "upkeep", "win", "tie"]);
export function isCanonicalTimelineLine(line: string) {
  const tag = line.split("|")[1] ?? "";
  return semanticTags.has(tag) && !metadataTags.has(tag) && tag !== "request";
}
export interface EvidenceContribution {
  id: string;
  instanceId: string;
  species: string;
  factIds: string[];
  metric: "battle-seen" | "move" | "item" | "ability" | "tera" | "damage" | "speed";
  value: string;
  eligibility: "active" | "quarantined" | "retracted";
  damage?: {
    turn: number; moveName: string; percent: number;
    attacker: PokemonSnapshot; defender: PokemonSnapshot; field: BattleSnapshot["field"];
  } | undefined;
  speed?: {
    turn: number; relation: "first" | "second"; pokemon: PokemonSnapshot; other: PokemonSnapshot;
    moveName: string; otherMoveName: string; field: BattleSnapshot["field"];
    /** The other side fainted to this move before acting this turn (otherMoveName is empty): it chose a move, so the
     * order still bounds Speed when none of its moves could have had lower priority (checked by the consumer). */
    unacted?: boolean | undefined;
  } | undefined;
}
const species = (details: string) => String(details ?? "").split(",")[0]!.trim();
const ident = (text: string) => String(text).match(/^(p[12])([a-z])?:\s*(.*)$/);
const nickname = (text: string) => ident(text)?.[3] ?? text;
const unique = <T>(values: T[]) => [...new Set(values)];
/** Whether a species can have Illusion: read from the Dex, never from a list of species. */
const illusion = (name: string) => {
  const entry = Dex.species.get(name);
  return entry.exists && Object.values(entry.abilities).includes("Illusion");
};
/** Opponent instances an Illusion user could be: Illusion-capable, and not known to have fainted (unless revived). */
function possibleIllusionUsers(ledger: CanonicalLedger, side: SideId) {
  const fainted = new Set<string>();
  for (const fact of ledger.facts) {
    const id = resolvedInstance(ledger, fact.subject)?.id ?? (fact.kind === "-heal" ? resolveSubject(ledger, fact.args[0] ?? "").instanceId : undefined);
    if (!id) continue;
    if (fact.kind === "faint") fainted.add(id);
    else if (fact.kind === "-heal" && fact.args.some((arg) => /revival blessing/i.test(arg))) fainted.delete(id);
  }
  return sideInstances(ledger, side).filter((entry) => illusion(entry.species) && !fainted.has(entry.id));
}
/** The instance an unresolved opposing appearance shows: its one displayed-species candidate, when every other candidate
 * is a possible Illusion user. Its state and facts are presented as that instance's until the disguise is resolved;
 * history evidence still requires a resolved appearance. */
export function presumedInstance(ledger: CanonicalLedger, appearance: Appearance | undefined) {
  if (!appearance || appearance.resolution === "resolved" || ledger.privateSides.includes(appearance.side)) return undefined;
  const candidates = appearance.candidateInstanceIds.map((id) => ledger.instances[id]).filter((entry): entry is MonInstance => Boolean(entry));
  const shown = candidates.filter((entry) => !illusion(entry.species) && compatibleSpecies(entry.species, species(appearance.apparent.details)));
  return shown.length === 1 && candidates.length > 1 && candidates.every((entry) => entry === shown[0] || illusion(entry.species)) ? shown[0] : undefined;
}
function compatibleSpecies(known: string, observed: string) {
  if (known === observed) return true;
  // Showdown's Team Preview rule emits Base-* for hidden formes. Use the
  // Dex family, not a string prefix or equivalence between concrete formes.
  if (!known.endsWith("-*")) return false;
  const concrete = Dex.species.get(observed);
  return concrete.exists && concrete.baseSpecies === known.slice(0, -2);
}
export function createCanonicalLedger(roomId: string): CanonicalLedger {
  return { roomId, facts: [], instances: {}, appearances: {}, active: {}, privateSides: [], turn: 0, recoveryQuarantines: [] };
}
function createInstance(ledger: CanonicalLedger, side: SideId, origin: MonInstance["origin"], details: string, factId: string, alias?: string): MonInstance {
  const ordinal = Object.values(ledger.instances).filter((entry) => entry.side === side && entry.origin === origin).length + 1;
  const id = `${ledger.roomId}:${side}:${origin}:${ordinal}`;
  return ledger.instances[id] = { id, side, origin, ordinal, species: species(details), details, aliases: alias ? [alias] : [], establishedBy: factId };
}
function sideInstances(ledger: CanonicalLedger, side: SideId) {
  return Object.values(ledger.instances).filter((entry) => entry.side === side && (ledger.privateSides.includes(side) ? entry.origin === "private-party" : entry.origin !== "private-party"));
}
function subjectForAppearance(appearance: Appearance): Subject {
  return { side: appearance.side, appearanceId: appearance.id };
}
function resolveSubject(ledger: CanonicalLedger, text: string): Subject {
  const parsed = ident(text);
  if (!parsed) return {};
  const side = parsed[1] as SideId;
  if (parsed[2]) {
    const appearance = ledger.appearances[ledger.active[`${side}${parsed[2]}`] ?? ""];
    if (appearance) return subjectForAppearance(appearance);
  }
  const candidates = sideInstances(ledger, side).filter((entry) => entry.aliases.includes(parsed[3]!));
  return { side, ...(candidates.length === 1 ? { instanceId: candidates[0]!.id } : { candidateInstanceIds: candidates.map((entry) => entry.id) }) };
}
function bind(appearance: Appearance, candidates: string[], factId: string) {
  appearance.candidateInstanceIds = unique(candidates);
  if (candidates.length === 1) { appearance.instanceId = candidates[0]!; appearance.resolution = "resolved"; }
  else { delete appearance.instanceId; appearance.resolution = candidates.length ? "ambiguous" : "provisional"; }
  appearance.resolvedBy = unique([...appearance.resolvedBy, factId]);
}
function publicRosterProof(ledger: CanonicalLedger, side: SideId): string[] {
  if (ledger.facts.filter((fact) => fact.kind === "clearpoke").length > 1) return [];
  const preview = ledger.facts.filter((fact) => fact.kind === "poke" && fact.args[0] === side);
  const size = [...ledger.facts].reverse().find((fact) => fact.kind === "teamsize" && fact.args[0] === side);
  const boundary = [...ledger.facts].reverse().find((fact) => ["teampreview", "start"].includes(fact.kind));
  if (!preview.length || !boundary || (size && Number(size.args[1]) !== preview.length)) return [];
  if (ledger.facts.indexOf(preview.at(-1)!) > ledger.facts.indexOf(boundary)) return [];
  return [...preview.map((fact) => fact.id), ...(size ? [size.id] : []), boundary.id];
}
function privateSignature(entry: any) {
  // Exclude mutable battle state and the current request slot. Server switches
  // permute side.pokemon; the request index is a choice address, not identity.
  return JSON.stringify([entry.ident, entry.details, entry.baseAbility ?? entry.ability, entry.moves, entry.teraType,
    Object.entries(entry.stats ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}
function ingestPrivateParty(ledger: CanonicalLedger, request: any, fact: CanonicalFact, publicContinuityKnown: boolean): Subject[] {
  if (request === null) return [];
  const side = request.side?.id as SideId;
  if (!Array.isArray(request.side?.pokemon) || !["p1", "p2"].includes(side)) return [];
  const first = !ledger.privateSides.includes(side);
  if (first) ledger.privateSides.push(side);
  const slots = request.side.pokemon.map((entry: any) => {
    let candidates: MonInstance[];
    if (first) {
      const instance = createInstance(ledger, side, "private-party", entry.details ?? "", fact.id, nickname(entry.ident));
      instance.privateSignature = privateSignature(entry);
      candidates = [instance];
    } else {
      const all = sideInstances(ledger, side);
      candidates = all.filter((instance) => instance.privateSignature === privateSignature(entry));
      if (!candidates.length) candidates = all.filter((instance) => instance.aliases.includes(nickname(entry.ident)) && instance.species === species(entry.details));
    }
    const subject: Subject = { side, ...(candidates.length === 1 ? { instanceId: candidates[0]!.id } : { candidateInstanceIds: candidates.map((entry) => entry.id) }) };
    if (entry.active && !request.teamPreview) {
      let appearance = ledger.appearances[ledger.active[`${side}a`] ?? ""];
      if (!appearance) {
        const ordinal = Object.values(ledger.appearances).filter((entry) => entry.side === side && entry.position === "a").length + 1;
        appearance = { id: `${ledger.roomId}:${side}a:appearance:${ordinal}`, side, position: "a", ordinal,
          startedBy: fact.id, apparent: { ident: entry.ident.replace(`${side}:`, `${side}a:`), details: entry.details ?? "" },
          candidateInstanceIds: [], resolution: "provisional", resolvedBy: [] };
        ledger.appearances[appearance.id] = appearance; ledger.active[`${side}a`] = appearance.id;
      }
      if (publicContinuityKnown) bind(appearance, candidates.map((entry) => entry.id), fact.id);
      subject.appearanceId = appearance.id;
    }
    return subject;
  });
  if (first && publicContinuityKnown) {
    // A reconnect's first private roster resolves earlier stints too. Only
    // unique consistent claims bind; the currently active flag is not the
    // sole link between public observations and private party instances.
    for (const appearance of Object.values(ledger.appearances).filter((entry) => entry.side === side && entry.endedBy)) {
      const candidates = sideInstances(ledger, side).filter((instance) => instance.species === species(appearance.revealedDetails ?? appearance.apparent.details)
        && instance.aliases.includes(nickname(appearance.revealedIdent ?? appearance.apparent.ident)));
      bind(appearance, candidates.map((entry) => entry.id), fact.id);
    }
  }
  return slots;
}

/** Append semantic facts once. Appearance bindings may change, facts never do. */
export function appendCanonicalLines(ledger: CanonicalLedger, lines: string[], source: { observationId: string; sequence: number; source: "protocol" | "recovery"; lineOffset?: number }) {
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.startsWith("|")) continue;
    const [, kind = "", ...args] = line.split("|");
    if (!semanticTags.has(kind)) continue; // Page projections and chat are not semantic battle evidence.
    // Imported public history has no binding to the client's current request.
    // Engine filtering omits known facts; retained overlap keeps its source.
    if (source.source === "recovery" && kind !== "request"
        && !ledger.recoveryQuarantines.some((entry) => entry.observationId === source.observationId && entry.reason === "recovery_public_continuity_unknown")) {
      ledger.recoveryQuarantines.push({ observationId: source.observationId, reason: "recovery_public_continuity_unknown" });
    }
    const publicContinuityKnown = !ledger.recoveryQuarantines.some((entry) => entry.reason === "recovery_public_continuity_unknown");
    if (kind === "turn") ledger.turn = Number(args[0]) || ledger.turn;
    const fact: CanonicalFact = {
      id: metadataTags.has(kind) ? `${ledger.roomId}:metadata:${kind}:${ledger.facts.filter((entry) => entry.kind === kind).length + 1}`
        : `${ledger.roomId}:public:${ledger.facts.filter((entry) => entry.kind !== "request" && !metadataTags.has(entry.kind)).length + 1}`, kind, args,
      subject: {}, references: {}, turn: ledger.turn,
      source: { observationId: source.observationId, sequence: source.sequence, lineIndex: lineIndex + 1 + (source.lineOffset ?? 0),
        channel: source.source === "recovery" ? "recovery" : kind === "request" ? "private-request" : "protocol" }
    };
    if (kind === "poke" && /^(p1|p2)$/.test(args[0] ?? "")) {
      const instance = createInstance(ledger, args[0] as SideId, "team-preview", args[1] ?? "", fact.id);
      fact.subject = { side: instance.side, instanceId: instance.id };
    } else if (["switch", "drag"].includes(kind)) {
      const parsed = ident(args[0] ?? "");
      if (parsed) {
        const side = parsed[1] as SideId, position = parsed[2] ?? "a", key = `${side}${position}`;
        const old = ledger.appearances[ledger.active[key] ?? ""];
        if (old) old.endedBy = fact.id;
        const ordinal = Object.values(ledger.appearances).filter((entry) => entry.side === side && entry.position === position).length + 1;
        const appearance: Appearance = { id: `${ledger.roomId}:${key}:appearance:${ordinal}`, side, position, ordinal,
          startedBy: fact.id, apparent: { ident: args[0]!, details: args[1] ?? "" }, candidateInstanceIds: [], resolution: "provisional", resolvedBy: [] };
        let candidates = sideInstances(ledger, side).filter((entry) => compatibleSpecies(entry.species, species(args[1] ?? "")) && (!entry.aliases.length || entry.aliases.includes(parsed[3]!)));
        // An unbroken disguise must not promote species-specific evidence.
        if (!ledger.privateSides.includes(side) && !illusion(species(args[1] ?? ""))) candidates = unique([...candidates, ...possibleIllusionUsers(ledger, side)]);
        const unanchored = !candidates.length;
        if (unanchored) candidates = [createInstance(ledger, side, "first-seen", args[1] ?? "", fact.id, parsed[3])];
        bind(appearance, candidates.map((entry) => entry.id), fact.id);
        if (!ledger.privateSides.includes(side)) {
          const proof = publicRosterProof(ledger, side);
          if (appearance.resolution === "resolved" && (unanchored || !proof.length)) {
            appearance.resolution = "provisional";
            delete appearance.instanceId;
          }
          else appearance.resolvedBy = unique([...appearance.resolvedBy, ...proof]);
        }
        if (appearance.resolution === "resolved") for (const instance of candidates) {
          if (!instance.aliases.includes(parsed[3]!)) instance.aliases.push(parsed[3]!);
          if (instance.species.endsWith("-*")) { instance.species = species(args[1] ?? ""); instance.details = args[1] ?? ""; }
        }
        ledger.appearances[appearance.id] = appearance; ledger.active[key] = appearance.id;
        fact.subject = subjectForAppearance(appearance);
      }
    } else if (kind === "replace") {
      const parsed = ident(args[0] ?? "");
      const appearance = parsed && ledger.appearances[ledger.active[`${parsed[1]}${parsed[2] ?? "a"}`] ?? ""];
      if (appearance && publicContinuityKnown) {
        let candidates = sideInstances(ledger, appearance.side).filter((entry) => compatibleSpecies(entry.species, species(args[1] ?? "")));
        if (!candidates.length) candidates = [createInstance(ledger, appearance.side, "first-seen", args[1] ?? "", fact.id, parsed![3])];
        bind(appearance, candidates.map((entry) => entry.id), fact.id);
        appearance.revealedDetails = args[1] ?? "";
        appearance.revealedIdent = args[0] ?? "";
        for (const instance of candidates) {
          if (!instance.aliases.includes(parsed![3]!)) instance.aliases.push(parsed![3]!);
          if (candidates.length === 1 && instance.species.endsWith("-*")) { instance.species = species(args[1] ?? ""); instance.details = args[1] ?? ""; }
        }
        fact.subject = subjectForAppearance(appearance);
      }
    } else if (kind === "request") {
      let request: any;
      try { request = JSON.parse(args.join("|")); } catch { throw new Error("Malformed canonical private request."); }
      if (request !== null && (typeof request !== "object" || Array.isArray(request))) throw new Error("Malformed canonical private request.");
      if (Number.isSafeInteger(request?.rqid)) fact.source.rqid = request.rqid;
      fact.id = `${ledger.roomId}:request:${request?.rqid ?? "unnumbered"}:${ledger.facts.filter((entry) => entry.kind === "request" && entry.source.rqid === fact.source.rqid).length + 1}`;
      fact.requestSlots = ingestPrivateParty(ledger, request, fact, publicContinuityKnown);
    }
    for (const [index, arg] of args.entries()) {
      const raw = arg.replace(/^\[of\]\s*/, "");
      if (ident(raw)) fact.references[index] = index === 0 && fact.subject.appearanceId ? fact.subject : resolveSubject(ledger, raw);
    }
    if (!fact.subject.appearanceId && !fact.subject.instanceId && fact.references[0]) fact.subject = fact.references[0];
    const appearance = fact.subject.appearanceId ? ledger.appearances[fact.subject.appearanceId] : undefined;
    if (publicContinuityKnown && kind === "detailschange") {
      const instance = resolvedInstance(ledger, fact.subject);
      if (instance) { instance.species = species(args[1] ?? ""); instance.details = args[1] ?? ""; }
      if (appearance) delete appearance.forme;
    }
    if (publicContinuityKnown && appearance && kind === "-formechange") appearance.forme = species(args[1] ?? "");
    // Illusion ends on any damaging hit (the server then sends |replace|). Direct damage from the other side's move that
    // leaves the disguise standing proves this appearance is the species it shows.
    const shown = kind === "-damage" && publicContinuityKnown && !args.some((arg) => arg.startsWith("[from]")) ? presumedInstance(ledger, appearance) : undefined;
    if (shown && appearance) {
      const cause = [...ledger.facts].reverse().find((prior) => ["move", "switch", "drag", "turn", "upkeep", "faint", "cant", "replace"].includes(prior.kind));
      if (cause?.kind === "move" && cause.subject.side && cause.subject.side !== appearance.side && cause.references[2]?.appearanceId === appearance.id) {
        bind(appearance, [shown.id], fact.id);
        appearance.resolvedBy = unique([...appearance.resolvedBy, cause.id]);
      }
    }
    if (publicContinuityKnown && appearance && kind === "-transform") {
      const target = fact.references[1]?.appearanceId ? ledger.appearances[fact.references[1]!.appearanceId!] : undefined;
      if (target) {
        fact.overlaySpecies = target.forme ?? species(target.revealedDetails ?? target.apparent.details);
        appearance.forme = fact.overlaySpecies;
      }
    }
    ledger.facts.push(fact);
  }
}
function resolvedInstance(ledger: CanonicalLedger, subject: Subject) {
  const id = subject.instanceId ?? (subject.appearanceId ? ledger.appearances[subject.appearanceId]?.instanceId : undefined);
  return id ? ledger.instances[id] : undefined;
}
function internalKey(ledger: CanonicalLedger, subject: Subject) {
  const appearance = subject.appearanceId ? ledger.appearances[subject.appearanceId] : undefined;
  const instance = resolvedInstance(ledger, subject) ?? presumedInstance(ledger, appearance);
  return instance ? `${instance.side}: @${instance.origin}-${instance.ordinal}` : appearance ? `${appearance.side}: @appearance-${appearance.ordinal}` : null;
}
function rewrittenIdent(ledger: CanonicalLedger, text: string, subject: Subject) {
  const key = internalKey(ledger, subject);
  if (!key) return text;
  const parsed = ident(text.replace(/^\[of\]\s*/, ""));
  return `${text.startsWith("[of]") ? "[of] " : ""}${key.replace(":", `${parsed?.[2] ?? ""}:`)}`;
}
/** `transformed` holds the subjects of every -transform fact before this one. */
function isBorrowedMove(fact: CanonicalFact, transformed: Set<string | undefined>) {
  return fact.args.some((arg) => arg.startsWith("[from]")) || transformed.has(fact.subject.appearanceId);
}
/** First index of each fact ID; lookups replace linear scans of the ledger. */
function factIndex(ledger: CanonicalLedger) {
  const index = new Map<string, number>();
  ledger.facts.forEach((fact, position) => { if (!index.has(fact.id)) index.set(fact.id, position); });
  return index;
}

/** Compile an authoritative fact to the existing pure mechanics kernel.
 * Rebinding recompiles the SAME appearance facts to the resolved instance;
 * no selective copying from a disguise object is involved. */
function projectFact(ledger: CanonicalLedger, fact: CanonicalFact, transformed: Set<string | undefined>) {
  if (["poke", "sso-state"].includes(fact.kind)) return undefined;
  const args = [...fact.args];
  if (fact.kind === "request") {
    const request = JSON.parse(args.join("|"));
    if (Array.isArray(request?.side?.pokemon)) request.side.pokemon = request.side.pokemon.map((entry: any, index: number) => {
      const subject = fact.requestSlots?.[index];
      // No guessed writes to a persistent instance when reconciliation is ambiguous.
      const borrowed = subject?.appearanceId && transformed.has(subject.appearanceId);
      return { ...entry, ...(borrowed ? { moves: [] } : {}), ident: subject && internalKey(ledger, subject) || `${request.side.id}: @request-${fact.id.split(":").at(-1)}-${index + 1}` };
    });
    return `|request|${JSON.stringify(request)}`;
  }
  for (const [index, subject] of Object.entries(fact.references)) args[Number(index)] = rewrittenIdent(ledger, args[Number(index)]!, subject);
  if (fact.kind === "-transform" && fact.overlaySpecies) return `|-formechange|${args[0]}|${fact.overlaySpecies}`;
  if (["switch", "drag"].includes(fact.kind) && fact.subject.appearanceId) {
    const appearance = ledger.appearances[fact.subject.appearanceId]!;
    if (appearance.revealedDetails) args[1] = appearance.revealedDetails;
  }
  return `|${fact.kind}|${args.join("|")}`;
}
export function canonicalSeed(ledger: CanonicalLedger) {
  return Object.values(ledger.instances).filter((instance) => !ledger.privateSides.includes(instance.side) || instance.origin === "private-party")
    .map((instance) => ({ ident: internalKey(ledger, { instanceId: instance.id })!, details: instance.details }));
}
export function annotateCanonicalRoom(ledger: CanonicalLedger, room: any) {
  const keySubjects = new Map<string, Subject>();
  for (const instance of Object.values(ledger.instances)) keySubjects.set(internalKey(ledger, { instanceId: instance.id })!, { instanceId: instance.id, side: instance.side });
  // A presumed (disguise-unresolved) appearance stands for its instance only while it is on the field.
  for (const appearance of Object.values(ledger.appearances)) {
    if (!appearance.endedBy || !presumedInstance(ledger, appearance)) keySubjects.set(internalKey(ledger, subjectForAppearance(appearance))!, subjectForAppearance(appearance));
  }
  const refs = (subject: Subject) => unique(ledger.facts.filter((fact) => {
    const owner = resolvedInstance(ledger, fact.subject), target = resolvedInstance(ledger, subject);
    const swappedTarget = fact.kind === "-activate" && /^(?:move: )?skill swap$/i.test(fact.args[1] ?? "")
      && Object.values(fact.references).some((reference) => target ? resolvedInstance(ledger, reference)?.id === target.id
        : Boolean(subject.appearanceId && reference.appearanceId === subject.appearanceId));
    return target ? owner?.id === target.id || swappedTarget || fact.requestSlots?.some((slot) => slot.instanceId === target.id)
      : Boolean(subject.appearanceId && subject.appearanceId === fact.subject.appearanceId) || swappedTarget;
  }).flatMap((fact) => supportingFacts(ledger, fact)));
  for (const side of Object.values(room.sides) as any[]) for (const [key, mon] of Object.entries(side.team) as Array<[string, any]>) {
    const subject = keySubjects.get(key);
    if (!subject) continue;
    const instance = resolvedInstance(ledger, subject);
    const appearance = subject.appearanceId ? ledger.appearances[subject.appearanceId] : undefined;
    mon.instanceId = instance?.id ?? appearance?.id;
    mon.identityStatus = appearance?.resolution ?? "resolved";
    mon.candidateInstanceIds = appearance?.candidateInstanceIds ?? (instance ? [instance.id] : []);
    mon.appearanceId = appearance?.id;
    const presumed = presumedInstance(ledger, appearance);
    if (presumed) mon.presumedInstanceId = presumed.id; else delete mon.presumedInstanceId;
    mon.evidenceRefs = refs(subject);
    if (appearance) {
      mon.appearanceMoves = unique(ledger.facts.filter((fact) => fact.kind === "move" && fact.subject.appearanceId === appearance.id).map((fact) => fact.args[1]));
      const startIndex = ledger.facts.findIndex((fact) => fact.id === appearance.startedBy);
      if (ledger.facts[startIndex]?.kind !== "request") mon.turnsSinceEntry = ledger.facts.slice(startIndex + 1).filter((fact) => fact.kind === "turn").length;
    }
    mon.ident = (appearance?.revealedIdent ?? appearance?.apparent.ident)?.replace(/^(p[12])[a-z]:/, "$1:") ?? `${side.slot}: ${instance?.aliases.at(-1) ?? instance?.species ?? "Unknown"}`;
    mon.displayName = instance?.aliases.at(-1) ?? (appearance ? nickname(appearance.apparent.ident) : instance?.species);
    // Historical species is distinct from an active forme/Transform overlay.
    mon.canonicalSpecies = instance?.species;
    if (instance && !mon.active) mon.species = instance.species;
  }
  const requestFact = [...ledger.facts].reverse().find((fact) => fact.kind === "request");
  for (const action of room.legalActions) {
    const active = room.sides[room.playerSide]?.team[room.sides[room.playerSide]?.activeKey];
    if (active?.appearanceId) action.actorAppearanceId = active.appearanceId;
    if (action.kind === "switch") {
      const subject = requestFact?.requestSlots?.[action.targetSlot - 1];
      const target = subject && resolvedInstance(ledger, subject);
      if (!target) {
        const raw = JSON.parse(requestFact!.args.join("|"))?.side?.pokemon?.[action.targetSlot - 1];
        action.label = `${action.reviving ? "Revive" : "Switch to"} ${species(raw?.details ?? "Unknown")}, slot ${action.targetSlot} (identity uncertain)`;
      }
      if (target) { action.targetInstanceId = target.id; action.target = `${target.side}: ${target.aliases.at(-1) ?? target.species}`; action.label = `${action.reviving ? "Revive" : "Switch to"} ${target.species}${target.aliases.at(-1) && target.aliases.at(-1) !== target.species ? ` (${target.aliases.at(-1)})` : ""}, slot ${action.targetSlot}`; }
    }
    if (action.kind === "team") {
      const subject = requestFact?.requestSlots?.[action.teamSpec[0] - 1];
      const lead = subject && resolvedInstance(ledger, subject);
      if (lead) action.label = `Lead ${lead.species}, slot ${action.teamSpec[0]}; order ${action.teamSpec.join("")}`;
    }
  }
  for (const entry of room.entryObservations ?? []) {
    const startFact = ledger.facts.find((fact) => `${fact.source.observationId}#${fact.source.lineIndex}` === entry.observationIds[0]);
    const subject = startFact?.subject;
    if (subject) {
      const instance = resolvedInstance(ledger, subject);
      entry.instanceId = instance?.id; entry.appearanceId = subject.appearanceId;
      entry.identityStatus = subject.appearanceId ? ledger.appearances[subject.appearanceId]?.resolution : "resolved";
      entry.factIds = ledger.facts.filter((fact) => entry.observationIds.includes(`${fact.source.observationId}#${fact.source.lineIndex}`)).flatMap((fact) => supportingFacts(ledger, fact));
      for (const fact of ledger.facts.slice(0, startFact ? ledger.facts.indexOf(startFact) : 0)) {
        if (fact.kind === "-sidestart" && fact.args[0]?.startsWith(entry.side) && entry.hazards.includes(fact.args[1])) entry.factIds.push(fact.id);
      }
      entry.factIds = unique(entry.factIds);
    }
  }
  applyEntryItemProofs(ledger, room);
}
/** An entry that hazards did not affect proves Heavy-Duty Boots (bootsProvenByEntry). It becomes the held item at once, so
 * every belief built on the item (sets, Speed, damage, guards) follows; any item fact (Knock Off, Trick, a reveal) is already
 * applied by the kernel and leaves nothing to prove. The proof is rebuilt from facts on every materialization. */
function applyEntryItemProofs(ledger: CanonicalLedger, room: any) {
  const mons = (Object.values(room.sides) as any[]).flatMap((side) => Object.values(side.team) as any[]);
  const line = (fact: CanonicalFact) => `${fact.source.observationId}#${fact.source.lineIndex}`;
  for (const entry of room.entryObservations ?? []) {
    const mon = mons.find((candidate) => candidate.instanceId === entry.instanceId);
    if (!entry.complete || entry.identityStatus !== "resolved" || !mon || mon.item || mon.removedItem || mon.itemProof) continue;
    const window = ledger.facts.filter((fact) => entry.observationIds.includes(line(fact)));
    const start = window[0];
    if (!start || !["switch", "drag"].includes(start.kind) || window.some((fact) => fact.source.channel === "recovery")) continue;
    const before = ledger.facts.slice(0, ledger.facts.indexOf(start));
    const fieldOn = (name: RegExp) => {
      const last = before.filter((fact) => ["-fieldstart", "-fieldend"].includes(fact.kind) && name.test(fact.args[0] ?? "")).at(-1);
      return last?.kind === "-fieldstart";
    };
    const hazard = bootsProvenByEntry({ species: entry.species, hazards: entry.hazards, types: entry.types, damaged: entry.damageObserved,
      statused: window.some((fact) => fact.kind === "-status" && resolvedInstance(ledger, fact.subject)?.id === entry.instanceId),
      statusAtEntry: /\s(?:par|psn|tox|brn|slp|frz)\b/.test(start.args[2] ?? "") }, mon.ability ?? null,
    { magicRoom: fieldOn(/magic room/i), gravity: fieldOn(/gravity/i), mistyTerrain: fieldOn(/misty terrain/i) },
    Number(room.format.match(/\[Gen\s*(\d+)\]/i)?.[1] ?? 9));
    if (!hazard) continue;
    mon.item = "Heavy-Duty Boots";
    mon.itemProof = { hazard, turn: entry.turn, factIds: entry.factIds };
  }
}
function supportingFacts(ledger: CanonicalLedger, fact: CanonicalFact): string[] {
  const instance = resolvedInstance(ledger, fact.subject);
  const appearance = fact.subject.appearanceId ? ledger.appearances[fact.subject.appearanceId] : undefined;
  return unique([fact.id, ...(instance ? [instance.establishedBy] : []), ...(appearance?.resolvedBy ?? [])]);
}

export function contributionsFromLedger(ledger: CanonicalLedger): EvidenceContribution[] {
  const contributions = new Map<string, EvidenceContribution>();
  const index = factIndex(ledger), transformed = new Set<string | undefined>();
  const emit = (fact: CanonicalFact, metric: EvidenceContribution["metric"], value: string) => {
    const instance = resolvedInstance(ledger, fact.subject);
    const appearance = fact.subject.appearanceId && ledger.appearances[fact.subject.appearanceId];
    if (!instance || (appearance && appearance.resolution !== "resolved") || !value) return;
    const id = `${fact.id}:${metric}`;
    const existing = contributions.get(id);
    if (existing) existing.factIds.push(fact.id);
    else contributions.set(id, { id, instanceId: instance.id, species: instance.species, factIds: supportingFacts(ledger, fact), metric, value,
      eligibility: supportingFacts(ledger, fact).every((id) => ledger.facts[index.get(id) ?? -1]?.source.channel !== "recovery") ? "active" : "quarantined" });
  };
  for (const fact of ledger.facts) {
    if (["switch", "drag"].includes(fact.kind)) emit(fact, "battle-seen", "seen");
    if (fact.kind === "move" && !isBorrowedMove(fact, transformed)) emit(fact, "move", fact.args[1] ?? "");
    if (["-item", "-enditem"].includes(fact.kind)) emit(fact, "item", fact.args[1] ?? "");
    if (fact.kind === "-ability") emit(fact, "ability", fact.args[1] ?? "");
    if (fact.kind === "-terastallize") emit(fact, "tera", fact.args[1] ?? "");
    if (fact.kind === "-transform") transformed.add(fact.subject.appearanceId);
  }
  return [...contributions.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Copy-on-write fork for a staged transaction: facts are never mutated after
 * append, while instance and appearance bindings are revised in place. */
export function forkCanonicalLedger(ledger: CanonicalLedger): CanonicalLedger {
  return { ...ledger, facts: [...ledger.facts], instances: structuredClone(ledger.instances), appearances: structuredClone(ledger.appearances),
    active: { ...ledger.active }, privateSides: [...ledger.privateSides], recoveryQuarantines: [...ledger.recoveryQuarantines] };
}
/** Evidence fact IDs are the ordered union of these parts, expanded with the bindings current at materialization:
 * a fact index (its supporting facts), [index, subject] (the same with that subject), { past } (supporting facts of
 * every earlier fact except moves, cants, turns and battle metadata) or a literal fact ID. */
type FactIdParts = Array<number | string | [number, Subject] | { past: number }>;
type EvidenceGroup = { parts: FactIdParts; contributions: EvidenceContribution[] };
/** The kernel room and reducer state after `applied` facts, before identity annotation. */
export interface CanonicalReduction {
  applied: number;
  resumed: boolean;
  playerSide: string | null;
  room: any;
  damage: EvidenceGroup[];
  order: EvidenceGroup[];
  state: {
    continuityUnknown: boolean; pendingAttacks: Map<string, PendingAttack>; turnFact: CanonicalFact | undefined;
    futureCast: { fact: CanonicalFact; moveId: string; moveName: string; targetSide: SideId } | undefined;
    moves: Array<{ fact: CanonicalFact; actor: PokemonSnapshot; other: PokemonSnapshot; otherKey: string; field: BattleSnapshot["field"]; parts: FactIdParts }>;
    orderSafe: boolean; unactedKo: boolean; suppressedAppearances: Map<string, Set<string>>; gasAppearances: Set<string>;
    substituteAppearances: Set<string>; interval: string[]; transformed: Set<string | undefined>;
    window: { fact: CanonicalFact; attacker: PokemonSnapshot; defender: PokemonSnapshot; field: BattleSnapshot["field"];
      safe: boolean; hits: number; percent: number; targetKey: string; parts: FactIdParts } | null;
  };
}
const requestSide = (ledger: CanonicalLedger) => {
  // A null request revokes choices, not the player's established side or party.
  const request = [...ledger.facts].reverse().find((fact) => fact.kind === "request" && JSON.parse(fact.args.join("|"))?.side?.id);
  return request ? JSON.parse(request.args.join("|")).side?.id ?? null : undefined;
};
/** A reduction carries forward only when every fact it reduced would compile and reduce identically now: same facts,
 * seed, quarantines and identity bindings. An appearance may gain supporting facts (re-rendered on output) and end. */
function resumable(prior: { ledger: CanonicalLedger; reduction: CanonicalReduction } | undefined, ledger: CanonicalLedger) {
  if (!prior || prior.reduction.applied !== prior.ledger.facts.length || prior.ledger.roomId !== ledger.roomId) return false;
  const before = prior.ledger;
  if (before.facts.some((fact, index) => ledger.facts[index] !== fact)
      || JSON.stringify([before.instances, before.privateSides, before.recoveryQuarantines]) !== JSON.stringify([ledger.instances, ledger.privateSides, ledger.recoveryQuarantines])
      || (requestSide(ledger) ?? null) !== prior.reduction.playerSide) return false;
  const structure = (appearance: Appearance, ended: boolean) => JSON.stringify({ ...appearance, resolvedBy: undefined, endedBy: ended ? appearance.endedBy : undefined });
  return Object.values(before.appearances).every((appearance) =>
    ledger.appearances[appearance.id] && structure(appearance, true) === structure(ledger.appearances[appearance.id]!, Boolean(appearance.endedBy)));
}

const kernel = await import(new URL("../../../extension/lib/showdown-parser.js", import.meta.url).href);
export function materializeCanonicalLedger(ledger: CanonicalLedger): any {
  return reduceCanonicalLedger(ledger).room;
}
/** Materialize the ledger, reducing only facts appended since `prior` when its reduction provably carries forward;
 * otherwise from the empty room. Neither input is mutated, so a failed transaction leaves committed state intact. */
export function reduceCanonicalLedger(ledger: CanonicalLedger, prior?: { ledger: CanonicalLedger; reduction: CanonicalReduction }): { room: any; reduction: CanonicalReduction } {
  const resumed = resumable(prior, ledger);
  let reduction: CanonicalReduction;
  if (resumed) {
    const { damage, order, ...rest } = prior!.reduction;
    reduction = { ...structuredClone(rest), damage: [...damage], order: [...order], resumed };
  } else {
    const room = kernel.createEmptyRoomState(ledger.roomId);
    kernel.seedCanonicalRoster(room, canonicalSeed(ledger));
    const playerSide = requestSide(ledger);
    if (playerSide !== undefined) {
      room.playerSide = playerSide;
      room.opponentSideId = room.playerSide === "p1" ? "p2" : "p1";
    }
    reduction = { applied: 0, resumed, playerSide: playerSide ?? null, room, damage: [], order: [], state: {
      continuityUnknown: false, pendingAttacks: new Map(), turnFact: undefined, futureCast: undefined, moves: [], orderSafe: true, unactedKo: false,
      suppressedAppearances: new Map(), gasAppearances: new Set(), substituteAppearances: new Set(), interval: [], transformed: new Set(), window: null } };
  }
  const { room, damage, order } = reduction;
  const { pendingAttacks, suppressedAppearances, gasAppearances, substituteAppearances, transformed } = reduction.state;
  let { continuityUnknown, turnFact, futureCast, moves, orderSafe, unactedKo, interval, window } = reduction.state;
  const rooms = new Map([[ledger.roomId, room]]);
  const factAt = factIndex(ledger), at = (id: string | undefined) => factAt.get(id ?? "") ?? -1;
  const continuityGaps = new Set(ledger.recoveryQuarantines
    .filter((entry) => entry.reason === "recovery_public_continuity_unknown").map((entry) => entry.observationId));
  const gapIndex = ledger.facts.findIndex((fact) => continuityGaps.has(fact.source.observationId));
  const postGapFacts = new Set(gapIndex < 0 ? [] : ledger.facts.slice(gapIndex).map((fact) => fact.id));
  const futureMove = (name: string | undefined) => {
    const move = Dex.forGen(Number(room.format.match(/\[Gen\s*(\d+)\]/i)?.[1] ?? 9)).moves.get((name ?? "").replace(/^move:\s*/i, ""));
    return move.exists && move.flags.futuremove ? move : undefined;
  };
  const forgetUnprovenActivation = () => {
    for (const side of Object.values(room.sides) as any[]) for (const mon of Object.values(side.team) as any[]) {
      delete mon.slowStartActive;
      if (mon.fieldSources) delete mon.fieldSources.slowStartActive;
    }
  };
  const tagMon = (mon: PokemonSnapshot, subject: Subject): PokemonSnapshot => {
    const instance = resolvedInstance(ledger, subject)!;
    return { ...structuredClone(mon), ident: `${instance.side}: ${instance.aliases.at(-1) ?? instance.species}`, displayName: instance.aliases.at(-1) ?? instance.species,
      instanceId: instance.id, canonicalSpecies: instance.species, identityStatus: "resolved", ...(subject.appearanceId ? { appearanceId: subject.appearanceId } : {}) };
  };
  const close = (boundary: CanonicalFact) => {
    if (!window) return;
    if (window.safe && window.hits === 1 && window.percent > 0) {
      const { attacker, defender } = window;
      damage.push({ parts: [...window.parts, boundary.id], contributions: [attacker, defender].map((mon) => ({
        id: `${window!.fact.id}:damage:${mon === attacker ? "attacker" : "defender"}`, instanceId: mon.instanceId!, species: mon.canonicalSpecies!, factIds: [],
        metric: "damage", value: window!.fact.args[1]!, eligibility: "active",
        damage: { turn: window!.fact.turn, moveName: window!.fact.args[1]!, percent: window!.percent,
          attacker: window!.attacker, defender: window!.defender, field: window!.field }
      })) });
    }
    window = null;
  };
  const closeOrder = (boundary: CanonicalFact) => {
    if (orderSafe && moves.length === 2 && moves[0]!.actor.instanceId === moves[1]!.other.instanceId && moves[0]!.other.instanceId === moves[1]!.actor.instanceId) {
      const first = moves[0]!, second = moves[1]!;
      // Singles: the second mover cannot overtake an action that already happened, so later state changes
      // (Knock Off, a Rapid Spin boost) do not alter the order. Record both sides at the first move's state.
      order.push({ parts: [...first.parts, ...second.parts, ...interval, boundary.id], contributions: moves.map((entry, index) => ({
        id: `${first.fact.id}:speed:${index + 1}`, instanceId: entry.actor.instanceId!, species: entry.actor.canonicalSpecies!, factIds: [],
        metric: "speed", value: "observed_order", eligibility: "active",
        speed: { turn: first.fact.turn, relation: index === 0 ? "first" : "second", pokemon: index === 0 ? first.actor : first.other,
          other: index === 0 ? first.other : first.actor, moveName: entry.fact.args[1]!, otherMoveName: moves[1 - index]!.fact.args[1]!, field: first.field }
      })) });
    } else if (orderSafe && unactedKo && moves.length === 1) {
      const only = moves[0]!;
      order.push({ parts: [...only.parts, ...interval, boundary.id], contributions: [{
        id: `${only.fact.id}:speed:1`, instanceId: only.actor.instanceId!, species: only.actor.canonicalSpecies!, factIds: [],
        metric: "speed", value: "observed_order", eligibility: "active",
        speed: { turn: only.fact.turn, relation: "first", pokemon: only.actor, other: only.other, moveName: only.fact.args[1]!, otherMoveName: "", field: only.field, unacted: true }
      }] });
    }
    moves = []; interval = []; orderSafe = true; unactedKo = false;
  };
  for (let position = reduction.applied; position < ledger.facts.length; position++) {
    const fact = ledger.facts[position]!, line = projectFact(ledger, fact, transformed);
    if (line === undefined) continue;
    if (continuityGaps.has(fact.source.observationId)) continuityUnknown = true;
    if (continuityUnknown) {
      forgetUnprovenActivation();
      if (window) window.safe = false;
      orderSafe = false;
    }
    const appearanceId = fact.subject.appearanceId;
    if (appearanceId && fact.source.channel === "protocol" && fact.args[1] === "Substitute") {
      if (fact.kind === "-start") substituteAppearances.add(appearanceId);
      else if (fact.kind === "-end") substituteAppearances.delete(appearanceId);
    }
    if (fact.kind === "turn") turnFact = fact;
    for (const [key, pending] of pendingAttacks) {
      // A fainted target can expire a futuremove without an explicit -end.
      // Keep its cast facts in history, but never its overdue slot occupancy.
      if (fact.turn > pending.dueTurn || (fact.kind === "upkeep" && fact.turn === pending.dueTurn)) pendingAttacks.delete(key);
      else if (continuityUnknown) pending.status = "timing_unknown";
    }
    const delayedEffect = ["-start", "-end"].includes(fact.kind) ? futureMove(fact.args[1]) : undefined;
    if (fact.kind === "-end" && delayedEffect) {
      // The following untagged HP change belongs to the delayed slot attack,
      // never to the preceding immediate move (which may have been protected).
      close(fact);
      const target = ident(fact.args[0] ?? "");
      const key = target?.[2] === "a" ? `${target[1]}a` : undefined;
      if (key && pendingAttacks.get(key)?.moveId === delayedEffect.id) pendingAttacks.delete(key);
    }
    if (["move", "cant", "switch", "drag", "turn", "upkeep", "request", "win", "tie", "-fail", "-miss"].includes(fact.kind)) futureCast = undefined;
    if (!continuityUnknown && fact.source.channel === "protocol" && fact.kind === "move"
        && turnFact?.source.channel === "protocol" && turnFact.turn === fact.turn && fact.turn > 0
        && fact.subject.side && appearanceId) {
      const move = futureMove(fact.args[1]), target = ident(fact.args[2] ?? "");
      if (move && target?.[2] === "a" && fact.references[2]?.side === target[1] && target[1] !== fact.subject.side) {
        futureCast = { fact, moveId: move.id, moveName: move.name, targetSide: target[1] as SideId };
      }
    }
    if (!continuityUnknown && fact.source.channel === "protocol" && fact.kind === "-start" && delayedEffect
        && futureCast?.moveId === delayedEffect.id && futureCast.fact.subject.appearanceId === appearanceId
        && futureCast.fact.turn === fact.turn) {
      const cast = futureCast.fact, key = `${futureCast.targetSide}a`;
      const existing = pendingAttacks.get(key);
      if (existing) existing.status = "timing_unknown"; // Contradictory starts do not establish a new deadline.
      else {
        const caster = ledger.appearances[appearanceId!];
        const resolved = caster?.resolution === "resolved" ? resolvedInstance(ledger, cast.subject) : undefined;
        // Materialization sees final identity bindings. Cite an instance only
        // when a private request explicitly bound this appearance before cast;
        // later Illusion/party resolution must not add an uncited source claim.
        const binding = resolved && ledger.facts.slice(0, at(cast.id)).find((prior) =>
          prior.requestSlots?.some((subject) => subject.appearanceId === appearanceId && subject.instanceId === resolved.id));
        const instance = binding ? resolved : undefined;
        pendingAttacks.set(key, { moveId: futureCast.moveId, moveName: futureCast.moveName,
          sourceSide: cast.subject.side!, sourceAppearanceId: appearanceId!, ...(instance ? { sourceInstanceId: instance.id } : {}),
          targetSide: futureCast.targetSide, targetPosition: "a", castTurn: cast.turn, dueTurn: cast.turn + 2,
          phase: "end_of_turn", status: "scheduled", factIds: unique([turnFact!.id, cast.id, fact.id, caster!.startedBy,
            ...(instance && binding ? [instance.establishedBy, binding.id] : [])]) });
      }
      futureCast = undefined;
    }
    // An open hit stays unsafe even if suppression ends again before its boundary.
    if (appearanceId && ["-start", "-end"].includes(fact.kind) && /embargo|gastro acid/i.test(fact.args[1] ?? "")) {
      if (window) window.safe = false;
      const effects = suppressedAppearances.get(appearanceId) ?? new Set<string>();
      const effect = /embargo/i.test(fact.args[1]!) ? "embargo" : "gastroacid";
      if (fact.kind === "-start") effects.add(effect);
      else effects.delete(effect);
      suppressedAppearances.set(appearanceId, effects);
    }
    if (appearanceId && fact.kind === "-ability") {
      if (window && (gasAppearances.has(appearanceId) || /neutralizing gas/i.test(fact.args[1] ?? ""))) window.safe = false;
      if (/neutralizing gas/i.test(fact.args[1] ?? "")) gasAppearances.add(appearanceId);
      else gasAppearances.delete(appearanceId);
    }
    if (appearanceId && fact.kind === "-endability") {
      // Native Gastro Acid emits only the target, not a named volatile. Keep
      // base ability knowledge, but withhold mechanics until this appearance ends.
      if (!fact.args[1]) {
        if (window) window.safe = false;
        orderSafe = false;
        const effects = suppressedAppearances.get(appearanceId) ?? new Set<string>();
        effects.add("ability");
        suppressedAppearances.set(appearanceId, effects);
      }
      if (window && gasAppearances.has(appearanceId)) window.safe = false;
      gasAppearances.delete(appearanceId);
    }
    // A pivot, forced switch or forme change after both actions cannot reorder them (e.g. Mimikyu's Disguise breaking at
    // the end of a turn whose order was clean).
    if (["turn", "upkeep", "request", "win", "tie"].includes(fact.kind)
      || ((moves.length === 2 || unactedKo) && ["switch", "drag", "-transform", "-formechange", "detailschange"].includes(fact.kind))) closeOrder(fact);
    interval.push(fact.id);
    if (["switch", "drag", "cant", "-transform", "-formechange", "detailschange"].includes(fact.kind)) orderSafe = false;
    if (["move", "cant", "switch", "drag", "turn", "upkeep", "request", "win", "tie"].includes(fact.kind)) close(fact);
    if (fact.kind === "move" && room.playerSide && !isBorrowedMove(fact, transformed)) {
      const activeAtMove = Object.values(ledger.appearances).filter((appearance) =>
        at(appearance.startedBy) <= position && (!appearance.endedBy || at(appearance.endedBy) > position));
      const suppressedAtMove = activeAtMove.some((appearance) => suppressedAppearances.get(appearance.id)?.size || gasAppearances.has(appearance.id));
      if (suppressedAtMove) {
        orderSafe = false;
      }
      const actorKey = internalKey(ledger, fact.subject), actor = resolvedInstance(ledger, fact.subject);
      const opposingSide = fact.subject.side === "p1" ? "p2" : "p1";
      // ledger.active is its final state; use the kernel's chronological
      // occupant and its bound semantic key for the comparison at this move.
      const otherKey = room.sides[opposingSide]?.activeKey;
      const otherSubject = Object.values(ledger.appearances).find((appearance) => internalKey(ledger, subjectForAppearance(appearance)) === otherKey
        && at(appearance.startedBy) <= position && (!appearance.endedBy || at(appearance.endedBy) > position));
      const view = kernel.roomToSnapshot(room), all = [...(view?.yourSide.team ?? []), ...(view?.opponentSide.team ?? [])];
      const actorMon = all.find((mon: PokemonSnapshot) => mon.ident === actorKey), otherMon = all.find((mon: PokemonSnapshot) => mon.ident === otherKey);
      if (actor && actorMon && otherMon && otherSubject?.resolution === "resolved" && ledger.appearances[fact.subject.appearanceId ?? ""]?.resolution === "resolved") {
        const otherRef = subjectForAppearance(otherSubject);
        moves.push({ fact, actor: tagMon(actorMon, fact.subject), other: tagMon(otherMon, otherRef), otherKey: otherKey!, field: structuredClone(view.field),
          parts: [position, [position, otherRef], { past: position }] });
      } else orderSafe = false;
      const attacker = resolvedInstance(ledger, fact.subject), defender = fact.references[2] && resolvedInstance(ledger, fact.references[2]);
      const attackingAppearance = fact.subject.appearanceId && ledger.appearances[fact.subject.appearanceId];
      const defendingAppearance = fact.references[2]?.appearanceId && ledger.appearances[fact.references[2].appearanceId!];
      const move = Dex.forGen(Number(room.format.match(/\[Gen\s*(\d+)\]/i)?.[1] ?? 9)).moves.get(fact.args[1]!);
      const transformedPair = [fact.subject.appearanceId, fact.references[2]?.appearanceId].some((id) => transformed.has(id));
      if (move.exists && move.category !== "Status" && !move.flags.futuremove && !move.multihit && !move.noFaint && !transformedPair
          && !["counter", "mirrorcoat", "metalburst", "comeuppance", "bide", "finalgambit", "endeavor"].includes(move.id)
          && attacker && defender && attacker.side !== defender.side && attackingAppearance && defendingAppearance
          && attackingAppearance.resolution === "resolved" && defendingAppearance.resolution === "resolved") {
        const view = kernel.roomToSnapshot(room);
        const all = [...(view?.yourSide.team ?? []), ...(view?.opponentSide.team ?? [])];
        const attackerKey = internalKey(ledger, fact.subject), defenderKey = internalKey(ledger, fact.references[2]!);
        const attackerMon = all.find((mon: PokemonSnapshot) => mon.ident === attackerKey), defenderMon = all.find((mon: PokemonSnapshot) => mon.ident === defenderKey);
        if (attackerMon && defenderMon && Number.isFinite(defenderMon.hpPercent)) {
          const prior = ledger.facts.slice(0, position).flatMap((entry, priorPosition) => {
            if (["move", "cant", "turn", "init", "title", "player", "poke"].includes(entry.kind)) return [];
            const owner = resolvedInstance(ledger, entry.subject);
            return owner?.id === attacker.id || owner?.id === defender.id || entry.requestSlots?.some((subject) => [attacker.id, defender.id].includes(subject.instanceId ?? ""))
              || (entry.kind === "-activate" && /^(?:move: )?skill swap$/i.test(entry.args[1] ?? "")
                && Object.values(entry.references).some((subject) => [attacker.id, defender.id].includes(resolvedInstance(ledger, subject)?.id ?? "")))
              || ["-weather", "-fieldstart", "-fieldend", "-sidestart", "-sideend", "-clearallboost"].includes(entry.kind) ? [priorPosition] : [];
          });
          window = { fact, attacker: tagMon(attackerMon, fact.subject), defender: tagMon(defenderMon, fact.references[2]!), field: structuredClone(view.field),
            safe: !suppressedAtMove, hits: 0, percent: 0, targetKey: defenderKey!, parts: [position, [position, fact.references[2]!], ...prior] };
        }
      }
    } else if (fact.kind === "move") orderSafe = false;
    const appearance = fact.subject.appearanceId && ledger.appearances[fact.subject.appearanceId];
    const instance = resolvedInstance(ledger, fact.subject);
    // Resolve the actor through its side-qualified subject before the kernel
    // renders prose. Internal nicknames alone collide across sides/ordinals.
    const presentationName = appearance ? nickname(appearance.revealedIdent ?? appearance.apparent.ident)
      : instance?.aliases.at(-1) ?? instance?.species;
    kernel.applyRawFrameToRoomMap(rooms, `>${ledger.roomId}\n${line}`, {
      lineId: `${fact.source.observationId}#${fact.source.lineIndex}`, recordMove: !isBorrowedMove(fact, transformed), presentationName
    });
    if (continuityUnknown) forgetUnprovenActivation();
    if (window) {
      window.parts.push(fact.id);
      if (["-crit", "-miss", "-fail", "-transform", "-formechange", "detailschange", "-hitcount"].includes(fact.kind)
          || (["-activate", "-enditem", "-ability", "-singleturn"].includes(fact.kind) && fact.args.some((arg) => /(?:Focus Sash|Focus Band|Sturdy|Endure)/i.test(arg)))) window.safe = false;
      if (fact.kind === "-damage" && !fact.args.some((arg) => arg.startsWith("[from]")) && internalKey(ledger, fact.subject) === window.targetKey) {
        const current = room.sides[fact.subject.side!]?.team[window.targetKey];
        window.hits++;
        window.percent = Number(((window.defender.hpPercent ?? 0) - (current?.hpPercent ?? 0)).toFixed(1));
        if (!current || current.fainted || current.hpPercent <= 0) {
          window.safe = false; // KO-capped delta is not an exact roll.
          if (moves.length === 1 && moves[0]!.fact === window.fact && moves[0]!.otherKey === window.targetKey) unactedKo = true;
        }
      }
    }
    if (fact.kind === "-transform") transformed.add(fact.subject.appearanceId);
  }
  Object.assign(reduction.state, { continuityUnknown, turnFact, futureCast, moves, orderSafe, unactedKo, interval, window });
  reduction.applied = ledger.facts.length;
  // The carried kernel room is never annotated: annotation reflects bindings current at this materialization.
  const output = structuredClone(room);
  output.updatedAt = Date.now();
  annotateCanonicalRoom(ledger, output);
  if (pendingAttacks.size) output.pendingAttacks = [...pendingAttacks.values()];
  const livingActiveAppearances = Object.values(ledger.active).filter((id) => {
    const appearance = ledger.appearances[id]!;
    const mon = output.sides[appearance.side]?.team[internalKey(ledger, subjectForAppearance(appearance))!];
    return !mon?.fainted;
  });
  const unsupportedSuppression = livingActiveAppearances.some((id) => suppressedAppearances.get(id)?.size || gasAppearances.has(id));
  // Until native Substitute interactions are modeled, even known bypasses are
  // withheld. Only current living appearances count; old stints do not linger.
  // An opponent-only Substitute affects just your damage into it (withheld downstream).
  const substituteSides = new Set(livingActiveAppearances.filter((id) => substituteAppearances.has(id)).map((id) => ledger.appearances[id]!.side));
  const unsupportedSubstitute = output.playerSide ? substituteSides.has(output.playerSide) : substituteSides.size > 0;
  const opponentSubstitute = !unsupportedSubstitute && substituteSides.size > 0;
  output.canonicalEvidence = {
    version: "canonical-evidence@1", facts: ledger.facts.map((fact) => {
      const instance = resolvedInstance(ledger, fact.subject);
      const appearance = fact.subject.appearanceId ? ledger.appearances[fact.subject.appearanceId] : undefined;
      return { ...fact, supportingFactIds: supportingFacts(ledger, fact), ...(instance ? { ownerInstanceId: instance.id } : {}), identityStatus: appearance?.resolution ?? (instance ? "resolved" : "provisional") };
    }),
    // Identity/lifecycle after an unbridged public gap is not established by
    // later wire facts alone. Keep raw facts and complete pre-gap contributions.
    contributions: [...contributionsFromLedger(ledger), ...renderEvidence(ledger, factAt, [...damage, ...order])]
      .filter((entry) => !entry.factIds.some((id) => postGapFacts.has(id))),
    ambiguities: [...Object.values(ledger.appearances).filter((appearance) => !appearance.endedBy && appearance.resolution !== "resolved").map((appearance) => appearance.id),
      ...([...ledger.facts].reverse().find((fact) => fact.kind === "request")?.requestSlots ?? []).flatMap((subject, index) => subject.instanceId ? [] : [`request-slot:${index + 1}`])],
    limitations: unique([...ledger.recoveryQuarantines.map((entry) => entry.reason),
      ...(ledger.facts.filter((fact) => fact.kind === "clearpoke").length > 1 ? ["preview_reset_unavailable"] : []),
      ...(unsupportedSuppression ? ["suppressed_mechanics_unavailable"] : []),
      ...(unsupportedSubstitute ? ["substitute_mechanics_unavailable"] : []),
      ...(opponentSubstitute ? ["opponent_substitute_active"] : []),
      // Current exposed swaps are captured, but base abilities on later entry
      // are not yet modeled. Do not rank from a retained stolen ability.
      ...(ledger.facts.some((fact) => fact.kind === "-activate" && /^(?:move: )?skill swap$/i.test(fact.args[1] ?? ""))
        ? ["temporary_ability_forecasts_unavailable"] : []),
      ...Object.values(ledger.appearances).filter((appearance) => !appearance.endedBy && ledger.facts.some((fact) => fact.kind === "-transform" && fact.subject.appearanceId === appearance.id)).map(() => "transform_mechanics_unavailable")])
  };
  if (resumed && process.env.CANONICAL_REDUCTION_CHECK === "1") {
    // Test aid: a carried reduction must equal reduction of the whole ledger from the empty room.
    const full = { ...materializeCanonicalLedger(ledger), updatedAt: output.updatedAt };
    assert.deepStrictEqual(output, full);
    assert.equal(JSON.stringify(output), JSON.stringify(full));
  }
  return { room: output, reduction };
}
/** Expand evidence fact-ID parts with the current bindings: a later rebinding extends the supporting facts of every
 * contribution that cites the rebound appearance, exactly as a reduction from the empty room would. */
function renderEvidence(ledger: CanonicalLedger, factAt: Map<string, number>, groups: EvidenceGroup[]) {
  const support: string[][] = [];
  const supportAt = (position: number) => support[position] ??= supportingFacts(ledger, ledger.facts[position]!);
  // past[0, pastEnd[p]) is the ordered union of supporting facts before position p, as { past: p } cites them.
  const past: string[] = [], pastEnd: number[] = [], seen = new Set<string>();
  ledger.facts.forEach((fact, position) => {
    pastEnd[position] = past.length;
    if (["move", "cant", "turn", "init", "title", "player"].includes(fact.kind)) return;
    for (const id of supportAt(position)) if (!seen.has(id)) { seen.add(id); past.push(id); }
  });
  return groups.flatMap(({ parts, contributions }) => {
    const ids = new Set<string>();
    for (const part of parts) {
      if (typeof part === "string") ids.add(part);
      else if (typeof part === "number") for (const id of supportAt(part)) ids.add(id);
      else if (Array.isArray(part)) for (const id of supportingFacts(ledger, { ...ledger.facts[part[0]]!, subject: part[1] })) ids.add(id);
      else for (let index = 0; index < pastEnd[part.past]!; index++) ids.add(past[index]!);
    }
    const factIds = [...ids];
    const eligibility = factIds.every((id) => ledger.facts[factAt.get(id) ?? -1]?.source.channel !== "recovery") ? "active" as const : "quarantined" as const;
    return contributions.map((contribution) => ({ ...contribution, factIds, eligibility }));
  });
}
