/**
 * Event-driven item/ability evidence parser.
 *
 * Parses a BattleSnapshot (recentLog + side state + field) into typed
 * InferenceEvent values.  Consumers: posterior (evidence weights),
 * liveLikelyItems (filtering), damage notes (interaction hints).
 */

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
  const events: InferenceEvent[] = [];
  const log = snapshot.recentLog ?? [];

  parseHpChangeEvents(snapshot, log, events);
  parseHazardImmunityEvents(snapshot, log, events);
  parseSnapshotItemConsumedEvents(snapshot, events);
  parseSnapshotAbilityRevealEvents(snapshot, events);

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

/**
 * Detect entries through active hazards where no follow-up damage is logged.
 *
 * Logic: scan recentLog for "X entered the field."  If the entering side has
 * HP-damaging hazards (Stealth Rock, Spikes, Toxic Spikes), check whether the
 * NEXT few lines contain an HP-change line for that same mon.  If not →
 * hazard_immunity event.  Sticky Web is excluded — it lowers Speed, not HP.
 *
 * The event includes the mon's types so consumers can disambiguate item-based
 * immunity (Boots) from type-based immunity (Flying vs Spikes) or ability
 * (Levitate, Magic Guard).
 */
function parseHazardImmunityEvents(
  snapshot: BattleSnapshot,
  log: string[],
  events: InferenceEvent[]
): void {
  const HAZARD_PATTERNS = ["stealth rock", "spikes", "toxic spikes"];

  const opponentHazards = (snapshot.field.opponentSideConditions ?? [])
    .filter((cond) => HAZARD_PATTERNS.some((h) => cond.toLowerCase().includes(h)));
  const playerHazards = (snapshot.field.yourSideConditions ?? [])
    .filter((cond) => HAZARD_PATTERNS.some((h) => cond.toLowerCase().includes(h)));

  if (opponentHazards.length === 0 && playerHazards.length === 0) return;

  let activeTurn = snapshot.turn;

  for (let i = 0; i < log.length; i++) {
    const turnNum = extractTurnNumber(log[i]!);
    if (turnNum !== null) { activeTurn = turnNum; continue; }

    const enteredName = extractEnteredFieldName(log[i]!);
    if (!enteredName) continue;

    const resolved = resolveMon(snapshot, enteredName);
    if (!resolved) continue;

    const relevantHazards = resolved.side === "opponent" ? opponentHazards : playerHazards;
    if (relevantHazards.length === 0) continue;

    // Look ahead for an HP-change line for this mon within the next few lines
    // (before the next turn marker, entry, or move usage by someone else)
    let tookDamage = false;
    for (let j = i + 1; j < Math.min(i + 6, log.length); j++) {
      const nextLine = log[j]!;
      // Stop scanning at next turn, entry, or faint
      if (extractTurnNumber(nextLine) !== null) break;
      if (extractEnteredFieldName(nextLine) !== null) break;
      if (nextLine.endsWith(" fainted.")) break;

      const hpChange = extractHpChangeSource(nextLine);
      if (hpChange && nameMatchesPokemon(hpChange.actor, resolved.pokemon)) {
        tookDamage = true;
        break;
      }
      // Also check for untagged damage (the parser doesn't log these to
      // recentLog, so their absence from the log is safe to treat as "no damage")
    }

    if (!tookDamage) {
      const species = speciesDisplayName(resolved.pokemon);
      if (species) {
        events.push({
          kind: "hazard_immunity",
          side: resolved.side,
          species,
          turn: activeTurn,
          hazards: relevantHazards,
          monTypes: resolved.pokemon.types ?? []
        });
      }
    }
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
