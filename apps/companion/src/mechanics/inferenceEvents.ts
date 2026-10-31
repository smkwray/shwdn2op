/**
 * Event-driven item/ability evidence parser.
 *
 * Parses a BattleSnapshot (recentLog + side state + field) into typed
 * InferenceEvent values.  Consumers: posterior (evidence weights),
 * liveLikelyItems (filtering), damage notes (interaction hints).
 */

import { Dex } from "@pkmn/dex";

import type {
  BattleSnapshot,
  InferenceEvent,
  InferenceEventSide,
  PokemonSnapshot
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function speciesDisplayName(pokemon: PokemonSnapshot | null | undefined): string {
  return String(pokemon?.species ?? pokemon?.displayName ?? "").trim();
}

function sideForIdent(ident: string | null | undefined): InferenceEventSide | null {
  const text = String(ident ?? "").trim();
  if (text.startsWith("p1")) return "player";
  if (text.startsWith("p2")) return "opponent";
  return null;
}

/**
 * Extract the mon name from a recentLog line like "Great Tusk entered the field."
 */
function extractEnteredFieldName(line: string): string | null {
  const match = line.match(/^(.+?) entered the field\.$/);
  return match?.[1]?.trim() ?? null;
}

/**
 * Extract actor and source from "X had HP change from Y."
 */
function extractHpChangeSource(line: string): { actor: string; source: string } | null {
  const match = line.match(/^(.+?) had HP change from (.+)\.$/);
  if (!match) return null;
  return { actor: match[1]!.trim(), source: match[2]!.trim() };
}

/**
 * Extract actor and move from "X used Y."
 */
function extractUsedMove(line: string): { actor: string; move: string } | null {
  const match = line.match(/^(.+?) used (.+)\.$/);
  if (!match) return null;
  return { actor: match[1]!.trim(), move: match[2]!.trim() };
}

/**
 * Extract actor, status, and source from "X gained status Y from Z."
 */
function extractStatusSource(line: string): { actor: string; status: string; source: string } | null {
  const match = line.match(/^(.+?) gained status (\w+) from (.+)\.$/);
  if (!match) return null;
  return { actor: match[1]!.trim(), status: match[2]!.trim(), source: match[3]!.trim() };
}

function extractTurnNumber(line: string): number | null {
  const match = line.match(/^Turn (\d+) started\.$/);
  return match ? Number(match[1]) : null;
}

function nameMatchesPokemon(name: string, pokemon: PokemonSnapshot | null | undefined): boolean {
  if (!name || !pokemon) return false;
  const nameId = normalizeName(name);
  if (!nameId) return false;
  for (const candidate of [pokemon.species, pokemon.displayName]) {
    const candidateText = String(candidate ?? "").trim();
    const bare = candidateText.includes(":")
      ? candidateText.split(":").slice(1).join(":").trim()
      : candidateText;
    if (bare && normalizeName(bare) === nameId) return true;
  }
  // Also try ident without side prefix
  if (pokemon.ident) {
    const identBare = pokemon.ident.includes(":")
      ? pokemon.ident.split(":").slice(1).join(":").trim()
      : pokemon.ident;
    if (identBare && normalizeName(identBare) === nameId) return true;
  }
  return false;
}

/**
 * Resolve which side + pokemon a name from recentLog belongs to.
 */
function resolveMon(
  snapshot: BattleSnapshot,
  name: string
): { pokemon: PokemonSnapshot; side: InferenceEventSide } | null {
  // Check opponent side first (most inference events are about the opponent)
  for (const mon of snapshot.opponentSide.team) {
    if (nameMatchesPokemon(name, mon)) return { pokemon: mon, side: "opponent" };
  }
  for (const mon of snapshot.yourSide.team) {
    if (nameMatchesPokemon(name, mon)) return { pokemon: mon, side: "player" };
  }
  // Also check active mons by displayName directly
  if (nameMatchesPokemon(name, snapshot.opponentSide.active)) {
    return { pokemon: snapshot.opponentSide.active!, side: "opponent" };
  }
  if (nameMatchesPokemon(name, snapshot.yourSide.active)) {
    return { pokemon: snapshot.yourSide.active!, side: "player" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HP-change source → event-kind mapping
// ---------------------------------------------------------------------------

/** Sources that indicate the mon's own held item caused self-damage after attacking. */
const ATTACK_RECOIL_SOURCES = new Set(["lifeorb"]);

/** Sources that indicate passive end-of-turn healing from the mon's item. */
const RESIDUAL_HEAL_SOURCES = new Set(["leftovers", "blacksludge"]);

/** Sources that indicate contact-triggered damage to the attacker. */
const CONTACT_RECOIL_SOURCES = new Set(["rockyhelmet", "roughskin", "ironbarbs"]);

/** Sources that indicate healing on switch-out (ability). */
const SWITCH_HEAL_SOURCES = new Set(["regenerator"]);

/** Items that inflict a status on the holder at end of turn. */
const SELF_STATUS_ITEM_SOURCES = new Set(["flameorb", "toxicorb"]);

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse a BattleSnapshot into InferenceEvent[].
 *
 * Events are derived from:
 * 1. recentLog "had HP change from X" lines (positive item/ability evidence)
 * 2. Entry through active hazards with no follow-up damage (hazard immunity)
 * 3. PokemonSnapshot.removedItem (item consumed)
 * 4. PokemonSnapshot.ability (ability reveal)
 */
export function parseInferenceEvents(snapshot: BattleSnapshot): InferenceEvent[] {
  if (snapshot.canonicalEvidence) return parseCanonicalInferenceEvents(snapshot);
  const events: InferenceEvent[] = [];
  const log = snapshot.recentLog ?? [];

  parseHpChangeEvents(snapshot, log, events);
  parseHazardImmunityEvents(snapshot, log, events);
  parseSnapshotItemConsumedEvents(snapshot, events);
  parseSnapshotAbilityRevealEvents(snapshot, events);

  return events;
}

/** Canonical consumers use semantic subjects and immutable fact ancestry.
 * The legacy prose parser below is restricted to untrusted snapshot tooling. */
function parseCanonicalInferenceEvents(snapshot: BattleSnapshot): InferenceEvent[] {
  const facts = snapshot.canonicalEvidence!.facts;
  const events: InferenceEvent[] = [];
  const mons = [...snapshot.yourSide.team, ...snapshot.opponentSide.team];
  const owner = (id: string | undefined) => mons.find((mon) => mon.instanceId === id && mon.identityStatus === "resolved");
  const base = (fact: typeof facts[number], id = fact.ownerInstanceId, reference?: typeof fact.subject) => {
    const mon = owner(id);
    const proof = reference ? facts.find((entry) => entry.subject.appearanceId === reference.appearanceId && entry.ownerInstanceId === id) : fact;
    const factIds = [...new Set([...fact.supportingFactIds, ...(proof?.supportingFactIds ?? [])])];
    if (!mon || (reference && !proof) || factIds.some((id) => !facts.some((entry) => entry.id === id && entry.source.channel !== "recovery"))) return null;
    const appearanceId = reference?.appearanceId ?? fact.subject.appearanceId;
    return { instanceId: id!, ...(appearanceId ? { appearanceId } : {}),
      side: (snapshot.opponentSide.team.some((entry) => entry.instanceId === id) ? "opponent" : "player") as InferenceEventSide,
      species: mon.canonicalSpecies ?? mon.species ?? "", turn: fact.turn, factIds };
  };
  for (const fact of facts) {
    if (fact.identityStatus !== "resolved" || fact.source.channel === "recovery") continue;
    const subject = base(fact);
    if (!subject) continue;
    if (fact.kind === "-ability") events.push({ ...subject, kind: "ability_reveal", abilityName: fact.args[1]! });
    if (fact.kind === "-enditem") {
      events.push({ ...subject, kind: "item_consumed", itemName: fact.args[1]!, trigger: "removed" });
      if (["ejectbutton", "ejectpack"].includes(normalizeName(fact.args[1]))) events.push({ ...subject, kind: "forced_switch", itemName: fact.args[1]! });
    }
    const source = fact.args.find((arg) => arg.startsWith("[from]"))?.replace(/^\[from\]\s*(?:item:|ability:)?\s*/i, "");
    const sourceId = normalizeName(source);
    if (fact.kind === "-status" && SELF_STATUS_ITEM_SOURCES.has(sourceId)) events.push({ ...subject, kind: "self_inflicted_status", status: fact.args[1]! });
    if (!["-damage", "-heal"].includes(fact.kind)) continue;
    if (ATTACK_RECOIL_SOURCES.has(sourceId)) events.push({ ...subject, kind: "attack_recoil", recoilPercent: 10 });
    if (RESIDUAL_HEAL_SOURCES.has(sourceId)) events.push({ ...subject, kind: "residual_heal", healPercent: 6.25, source });
    if (SWITCH_HEAL_SOURCES.has(sourceId)) events.push({ ...subject, kind: "switch_heal", healPercent: 33 });
    if (CONTACT_RECOIL_SOURCES.has(sourceId)) {
      // Contact damage belongs to the explicitly tagged defender; never the
      // current occupant of the opposite side in a later snapshot.
      const index = fact.args.findIndex((arg) => arg.startsWith("[of]"));
      const ref = fact.references[index];
      const defenderId = ref?.instanceId ?? facts.find((entry) => ref?.appearanceId && entry.subject.appearanceId === ref.appearanceId)?.ownerInstanceId;
      const defender = base(fact, defenderId, ref);
      if (defender) events.push({ ...defender, kind: "contact_recoil", attackerSpecies: subject.species,
        recoilPercent: sourceId === "rockyhelmet" ? 16.67 : 12.5, source });
    }
  }
  const generation = Number(snapshot.format.match(/\[Gen\s*(\d+)\]/i)?.[1] ?? 9);
  for (const entry of snapshot.entryObservations ?? []) {
    if (!entry.complete || entry.damageObserved || entry.identityStatus !== "resolved" || !entry.factIds?.length) continue;
    const mon = owner(entry.instanceId);
    const supporting = entry.factIds.map((id) => facts.find((fact) => fact.id === id));
    if (!mon || supporting.some((fact) => !fact || fact.source.channel === "recovery")) continue;
    const hazards = entry.hazards.filter((hazard) => ["stealthrock", "spikes"].includes(normalizeName(hazard)));
    if (!hazards.length) continue;
    events.push({ kind: "hazard_immunity", instanceId: mon.instanceId, appearanceId: entry.appearanceId,
      side: entry.side === snapshot.yourSide.slot ? "player" : "opponent", species: mon.canonicalSpecies ?? entry.species,
      turn: entry.turn, hazards, monTypes: entry.types.length ? entry.types : [...Dex.forGen(generation).species.get(mon.canonicalSpecies ?? entry.species).types],
      factIds: entry.factIds });
  }
  return events;
}

// ---------------------------------------------------------------------------
// 1. HP-change source events
// ---------------------------------------------------------------------------

function parseHpChangeEvents(
  snapshot: BattleSnapshot,
  log: string[],
  events: InferenceEvent[]
): void {
  let currentTurn = snapshot.turn;
  // Walk backward to find the latest turn marker
  for (let i = log.length - 1; i >= 0; i--) {
    const turn = extractTurnNumber(log[i]!);
    if (turn !== null) { currentTurn = turn; break; }
  }

  // Track the last move used by each actor (for attack_recoil attribution)
  let lastMoveByActor: { actor: string; move: string } | null = null;
  let activeTurn = currentTurn;

  // Track which mon is active on each side based on log entries, so contact
  // recoil is attributed to whoever was defending at the time (not whoever
  // happens to be active in the post-resolution snapshot).
  const activeByLogContext: Record<InferenceEventSide, { pokemon: PokemonSnapshot; species: string } | null> = {
    opponent: snapshot.opponentSide.active
      ? { pokemon: snapshot.opponentSide.active, species: speciesDisplayName(snapshot.opponentSide.active) }
      : null,
    player: snapshot.yourSide.active
      ? { pokemon: snapshot.yourSide.active, species: speciesDisplayName(snapshot.yourSide.active) }
      : null
  };

  for (const line of log) {
    const turnNum = extractTurnNumber(line);
    if (turnNum !== null) {
      activeTurn = turnNum;
      lastMoveByActor = null;
      continue;
    }

    // Update active-mon tracking when a mon enters the field
    const enteredName = extractEnteredFieldName(line);
    if (enteredName) {
      const entryResolved = resolveMon(snapshot, enteredName);
      if (entryResolved) {
        activeByLogContext[entryResolved.side] = {
          pokemon: entryResolved.pokemon,
          species: speciesDisplayName(entryResolved.pokemon)
        };
      }
    }

    const usedMove = extractUsedMove(line);
    if (usedMove) {
      lastMoveByActor = usedMove;
      continue;
    }

    // Self-inflicted status from item (Flame Orb → brn, Toxic Orb → tox)
    const statusSource = extractStatusSource(line);
    if (statusSource) {
      const statusSourceId = normalizeName(statusSource.source);
      if (SELF_STATUS_ITEM_SOURCES.has(statusSourceId)) {
        const resolved = resolveMon(snapshot, statusSource.actor);
        if (resolved) {
          const species = speciesDisplayName(resolved.pokemon);
          if (species) {
            events.push({
              kind: "self_inflicted_status",
              side: resolved.side,
              species,
              turn: activeTurn,
              status: statusSource.status
            });
          }
        }
      }
      continue;
    }

    const hpChange = extractHpChangeSource(line);
    if (!hpChange) continue;

    const sourceId = normalizeName(hpChange.source);
    const resolved = resolveMon(snapshot, hpChange.actor);
    if (!resolved) continue;
    const species = speciesDisplayName(resolved.pokemon);
    if (!species) continue;

    if (ATTACK_RECOIL_SOURCES.has(sourceId)) {
      events.push({
        kind: "attack_recoil",
        side: resolved.side,
        species,
        turn: activeTurn,
        recoilPercent: 10, // Life Orb is always ~10%
        moveName: lastMoveByActor && nameMatchesPokemon(lastMoveByActor.actor, resolved.pokemon)
          ? lastMoveByActor.move
          : undefined
      });
      continue;
    }

    if (RESIDUAL_HEAL_SOURCES.has(sourceId)) {
      events.push({
        kind: "residual_heal",
        side: resolved.side,
        species,
        turn: activeTurn,
        healPercent: 6.25,
        source: hpChange.source
      });
      continue;
    }

    if (CONTACT_RECOIL_SOURCES.has(sourceId)) {
      // For contact recoil, the actor who took damage is the ATTACKER,
      // but the source (Rocky Helmet/Rough Skin/Iron Barbs) belongs to
      // the DEFENDER.  We attribute the event to the defender using
      // log-context tracking (not snapshot active, which may have changed
      // if the defender fainted from the same hit).
      const defenderSide: InferenceEventSide = resolved.side === "opponent" ? "player" : "opponent";
      const defenderCtx = activeByLogContext[defenderSide];
      const defenderSpecies = defenderCtx?.species;
      if (defenderSpecies) {
        events.push({
          kind: "contact_recoil",
          side: defenderSide,
          species: defenderSpecies,
          turn: activeTurn,
          attackerSpecies: species,
          recoilPercent: sourceId === "rockyhelmet" ? 16.67 : 12.5,
          source: hpChange.source
        });
      }
      continue;
    }

    if (SWITCH_HEAL_SOURCES.has(sourceId)) {
      events.push({
        kind: "switch_heal",
        side: resolved.side,
        species,
        turn: activeTurn,
        healPercent: 33
      });
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Hazard immunity detection
// ---------------------------------------------------------------------------

/** Entry-time protocol observations are authoritative; UI text cannot prove absence. */
function parseHazardImmunityEvents(snapshot: BattleSnapshot, _log: string[], events: InferenceEvent[]): void {
  const generation = Number(snapshot.format.match(/\[Gen\s*(\d+)\]/i)?.[1] ?? 9);
  for (const entry of snapshot.entryObservations ?? []) {
    if (!entry.complete || entry.damageObserved || entry.observationIds.length === 0) continue;
    const hazards = entry.hazards.filter((hazard) => ["stealthrock", "spikes"].includes(normalizeName(hazard)));
    if (!hazards.length) continue;
    const speciesTypes = Dex.forGen(generation).species.get(entry.species).types;
    events.push({
      kind: "hazard_immunity", side: entry.side === snapshot.yourSide.slot ? "player" : "opponent",
      species: entry.species, turn: entry.turn, hazards,
      monTypes: entry.types.length ? entry.types : [...(speciesTypes ?? [])],
      observationIds: [...entry.observationIds]
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Item-consumed events from snapshot state
// ---------------------------------------------------------------------------

function parseSnapshotItemConsumedEvents(
  snapshot: BattleSnapshot,
  events: InferenceEvent[]
): void {
  const allMons: Array<{ pokemon: PokemonSnapshot; side: InferenceEventSide }> = [];
  for (const mon of snapshot.opponentSide.team) {
    allMons.push({ pokemon: mon, side: "opponent" });
  }
  for (const mon of snapshot.yourSide.team) {
    allMons.push({ pokemon: mon, side: "player" });
  }

  for (const { pokemon, side } of allMons) {
    if (!pokemon.removedItem) continue;
    const species = speciesDisplayName(pokemon);
    if (!species) continue;
    events.push({
      kind: "item_consumed",
      side,
      species,
      turn: snapshot.turn,
      itemName: pokemon.removedItem,
      trigger: "consumed"
    });

    // Eject Button / Eject Pack → also emit forced_switch
    const removedId = normalizeName(pokemon.removedItem);
    if (removedId === "ejectbutton" || removedId === "ejectpack") {
      events.push({
        kind: "forced_switch",
        side,
        species,
        turn: snapshot.turn,
        itemName: pokemon.removedItem
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Ability-reveal events from snapshot state
// ---------------------------------------------------------------------------

function parseSnapshotAbilityRevealEvents(
  snapshot: BattleSnapshot,
  events: InferenceEvent[]
): void {
  const allMons: Array<{ pokemon: PokemonSnapshot; side: InferenceEventSide }> = [];
  for (const mon of snapshot.opponentSide.team) {
    allMons.push({ pokemon: mon, side: "opponent" });
  }
  for (const mon of snapshot.yourSide.team) {
    allMons.push({ pokemon: mon, side: "player" });
  }

  for (const { pokemon, side } of allMons) {
    if (!pokemon.ability) continue;
    const species = speciesDisplayName(pokemon);
    if (!species) continue;
    events.push({
      kind: "ability_reveal",
      side,
      species,
      turn: snapshot.turn,
      abilityName: pokemon.ability
    });
  }
}
