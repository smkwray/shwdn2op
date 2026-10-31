const MAX_LOG = 20;

function pushRecent(list, entry) {
  list.push(entry);
  while (list.length > MAX_LOG) list.shift();
}

function sanitizeSpecies(details) {
  if (!details) return null;
  const base = details.split(",")[0]?.trim() ?? "";
  return base || null;
}

function extractLevel(details) {
  if (!details) return null;
  const match = String(details).match(/\bL(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function sortByMostRecent(a, b) {
  return (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0);
}

function normalizeIdent(ident) {
  if (!ident || typeof ident !== "string") {
    return { side: null, position: null, name: null, teamKey: null };
  }
  const match = ident.match(/^(p\d)([a-z])?:\s*(.+)$/i);
  if (!match) {
    return { side: null, position: null, name: ident, teamKey: ident };
  }
  const [, side, position, name] = match;
  return {
    side,
    position: position ?? null,
    name: name.trim(),
    teamKey: `${side}: ${name.trim()}`
  };
}

// Canonical callers supply a label resolved from the side-qualified fact.
// Presentation text is never used to identify the mechanics owner.
function logPokemonName(room, ident) {
  return room.observationContext?.presentationName ?? normalizeIdent(ident).name ?? ident;
}

function parseConditionText(conditionText) {
  if (!conditionText) {
    return { conditionText: null, hpPercent: null, status: null, fainted: false };
  }

  const trimmed = String(conditionText).trim();
  if (trimmed === "0 fnt" || trimmed === "0/100 fnt") {
    return { conditionText: trimmed, hpPercent: 0, status: "fnt", fainted: true };
  }

  const parts = trimmed.split(" ");
  const hpPart = parts[0] ?? "";
  const status = parts[1] ?? null;
  let hpPercent = null;
  let fainted = status === "fnt";

  if (hpPart.includes("/")) {
    const [currentRaw, maxRaw] = hpPart.split("/");
    const current = Number(currentRaw);
    const max = Number(maxRaw);
    if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
      hpPercent = Number(((current / max) * 100).toFixed(1));
      if (current <= 0) fainted = true;
    }
  } else if (hpPart.endsWith("%")) {
    const pct = Number(hpPart.replace("%", ""));
    if (Number.isFinite(pct)) {
      hpPercent = pct;
      if (pct <= 0) fainted = true;
    }
  }

  return {
    conditionText: trimmed,
    hpPercent,
    status,
    fainted
  };
}

function clampBoostStage(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-6, Math.min(6, Number(value)));
}

function blankPokemon(ident = null) {
  return {
    ident,
    species: null,
    displayName: ident ? normalizeIdent(ident).name : null,
    level: null,
    conditionText: null,
    hpPercent: null,
    status: null,
    fainted: false,
    active: false,
    revealed: false,
    boosts: {},
    stats: {},
    knownMoves: [],
    item: null,
    removedItem: null,
    ability: null,
    types: [],
    teraType: null,
    terastallized: false
  };
}

function ensureSide(room, sideId) {
  if (!room.sides[sideId]) {
    room.sides[sideId] = {
      slot: sideId,
      name: null,
      team: {},
      activeKey: null
    };
  }
  return room.sides[sideId];
}

function ensurePokemon(room, ident) {
  const parsed = normalizeIdent(ident);
  const side = parsed.side ? ensureSide(room, parsed.side) : null;
  const key = parsed.teamKey ?? ident;
  if (side) {
    if (!side.team[key]) {
      side.team[key] = blankPokemon(key);
      side.team[key].displayName = parsed.name ?? ident;
    }
    return side.team[key];
  }
  if (!room.unownedTeam[key]) {
    room.unownedTeam[key] = blankPokemon(key);
  }
  return room.unownedTeam[key];
}

function setKnownMove(pokemon, moveName) {
  if (!moveName) return;
  if (!pokemon.knownMoves.includes(moveName)) {
    pokemon.knownMoves.push(moveName);
  }
}

function updatePokemonFromDetails(pokemon, details, condition, preview = false) {
  if (details) {
    pokemon.species = sanitizeSpecies(details);
    pokemon.level = extractLevel(details) ?? (preview ? pokemon.level : 100);
    const teraType = String(details).match(/,\s*tera:([^,]+)/i)?.[1]?.trim();
    if (teraType) {
      pokemon.teraType = teraType;
      pokemon.terastallized = true;
      observeFields(pokemon, ["teraType", "terastallized"]);
    }
    if (!pokemon.displayName) {
      pokemon.displayName = pokemon.species;
    }
  }
  if (condition !== undefined) {
    const parsed = parseConditionText(condition);
    pokemon.conditionText = parsed.conditionText;
    pokemon.hpPercent = parsed.hpPercent;
    pokemon.status = parsed.status;
    pokemon.fainted = parsed.fainted;
  }
  pokemon.revealed = true;
}


function mergeFiniteStats(existing, next) {
  const merged = {
    ...(existing ?? {})
  };
  if (next && typeof next === "object") {
    for (const [key, value] of Object.entries(next)) {
      if (Number.isFinite(value)) {
        merged[key] = Number(value);
      }
    }
  }
  return merged;
}

function mergeUniqueStrings(existing, next) {
  const merged = [];
  for (const value of [...(existing ?? []), ...(next ?? [])]) {
    if (typeof value !== "string") continue;
    if (!merged.includes(value)) merged.push(value);
  }
  return merged;
}

const FIELD_AUTHORITY = { supplemental: 1, recovery: 2, request: 3, protocol: 4 };

function observeFields(target, fields, source = "protocol") {
  target.fieldSources ??= {};
  for (const field of fields) {
    if ((FIELD_AUTHORITY[source] ?? 0) >= (FIELD_AUTHORITY[target.fieldSources[field]] ?? 0)) target.fieldSources[field] = source;
  }
}

function observedValue(previous, next, field) {
  const nextSource = next?.fieldSources?.[field];
  const previousSource = previous?.fieldSources?.[field];
  if (nextSource && (FIELD_AUTHORITY[nextSource] ?? 0) >= (FIELD_AUTHORITY[previousSource] ?? 0)) return next[field];
  if (previousSource) return previous[field];
  return previous?.[field] ?? next?.[field];
}

function mergedFieldSources(previous, next) {
  const result = { ...(previous?.fieldSources ?? {}) };
  for (const [field, source] of Object.entries(next?.fieldSources ?? {})) {
    if ((FIELD_AUTHORITY[source] ?? 0) >= (FIELD_AUTHORITY[result[field]] ?? 0)) result[field] = source;
  }
  return result;
}

function normalizeKnownString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isStackableSideCondition(condition) {
  return /^(spikes|toxic spikes)$/i.test(String(condition ?? "").trim());
}

function applyKnownPokemonState(room, entry, fallbackSideId = null, source = "request") {
  if (!entry || typeof entry !== "object") return null;
  const ident = normalizeKnownString(entry.ident)
    ?? (fallbackSideId && entry.details ? `${fallbackSideId}: ${sanitizeSpecies(entry.details)}` : null);
  if (!ident) return null;

  const pokemon = ensurePokemon(room, ident);
  entry = { ...entry };
  if (source === "supplemental") {
    // Page internals only fill capture gaps. An explicit protocol/request
    // observation, including a clear, cannot be undone by page state.
    for (const field of ["active", "item", "ability", "baseAbility", "boosts", "teraType", "terastallized"]) {
      const observed = pokemon.fieldSources?.[field === "baseAbility" ? "ability" : field];
      if (observed && observed !== "supplemental") delete entry[field];
    }
    if (["conditionText", "hpPercent", "status", "fainted"].some((field) => ["protocol", "request"].includes(pokemon.fieldSources?.[field]))) delete entry.condition;
    if (pokemon.fieldSources?.species && pokemon.fieldSources.species !== "supplemental") delete entry.details;
    if (entry.stats && pokemon.fieldSources?.stats && pokemon.fieldSources.stats !== "supplemental") {
      entry.stats = Object.fromEntries(Object.entries(entry.stats).filter(([key]) => !Number.isFinite(pokemon.stats?.[key])));
    }
  }
  updatePokemonFromDetails(pokemon, entry.details, entry.condition);
  if (entry.details) observeFields(pokemon, ["species", "level"], source);
  if (entry.condition !== undefined) observeFields(pokemon, ["conditionText", "hpPercent", "status", "fainted"], source);
  if (Object.prototype.hasOwnProperty.call(entry, "active")) {
    pokemon.active = Boolean(entry.active);
    observeFields(pokemon, ["active"], source);
  }
  pokemon.level = Number.isFinite(entry.level) ? Number(entry.level) : pokemon.level;
  pokemon.stats = mergeFiniteStats(pokemon.stats, entry.stats);
  // Own private requests report exact HP as current/max; their stats object
  // omits HP. Public protocol percentages must never become a fake HP stat.
  const privateHp = source === "request" && !parseConditionText(entry.condition).fainted
    ? String(entry.condition ?? "").match(/^\d+\/(\d+)(?:\s|$)/) : null;
  if (privateHp && Number(privateHp[1]) > 0) pokemon.stats.hp = Number(privateHp[1]);
  if (entry.boosts) pokemon.boosts = mergeFiniteStats({}, entry.boosts);
  if (entry.stats || privateHp) observeFields(pokemon, ["stats"], source);
  if (entry.boosts) observeFields(pokemon, ["boosts"], source);

  if (Object.prototype.hasOwnProperty.call(entry, "item")) {
    const nextItem = normalizeKnownString(entry.item) ?? null;
    pokemon.item = nextItem;
    if (nextItem) {
      pokemon.removedItem = null;
      pokemon.unburdenActive = false;
    }
    observeFields(pokemon, ["item", ...(nextItem ? ["removedItem", "unburdenActive"] : [])], source);
  }

  const abilityValue = normalizeKnownString(entry.ability) ?? normalizeKnownString(entry.baseAbility);
  if (abilityValue) {
    pokemon.ability = abilityValue;
    observeFields(pokemon, ["ability"], source);
  }

  if (Object.prototype.hasOwnProperty.call(entry, "teraType")) {
    pokemon.teraType = normalizeKnownString(entry.teraType) ?? pokemon.teraType;
    observeFields(pokemon, ["teraType"], source);
  }
  if (Object.prototype.hasOwnProperty.call(entry, "terastallized")) {
    pokemon.terastallized = Boolean(entry.terastallized);
    observeFields(pokemon, ["terastallized"], source);
  }
  if (Array.isArray(entry.moves)) {
    for (const moveId of entry.moves) {
      setKnownMove(pokemon, moveId);
    }
  }
  return pokemon;
}

function applySupplementalState(room, payload) {
  if (!payload || typeof payload !== "object") return;
  if (!room.playerSide && (payload.playerSide === "p1" || payload.playerSide === "p2")) {
    room.playerSide = payload.playerSide;
    room.opponentSideId = payload.playerSide === "p1" ? "p2" : "p1";
  }

  if (payload.sideNames && typeof payload.sideNames === "object") {
    for (const [sideId, sideName] of Object.entries(payload.sideNames)) {
      if (sideId !== "p1" && sideId !== "p2") continue;
      if (!sideName) continue;
      ensureSide(room, sideId).name = sideName;
    }
  }

  if (payload.field && typeof payload.field === "object") {
    room.hasSupplementalFieldSnapshot = true;
    if (Object.prototype.hasOwnProperty.call(payload.field, "weather")) {
      if ((!room.field.fieldSources?.weather || room.field.fieldSources.weather === "supplemental")) room.field.weather = normalizeKnownString(payload.field.weather) ?? null;
      if ((!room.field.fieldSources?.weather || room.field.fieldSources.weather === "supplemental")) observeFields(room.field, ["weather"], "supplemental");
    }
    if (Object.prototype.hasOwnProperty.call(payload.field, "terrain")) {
      if ((!room.field.fieldSources?.terrain || room.field.fieldSources.terrain === "supplemental")) room.field.terrain = normalizeKnownString(payload.field.terrain) ?? null;
      if ((!room.field.fieldSources?.terrain || room.field.fieldSources.terrain === "supplemental")) observeFields(room.field, ["terrain"], "supplemental");
    }
    if (Array.isArray(payload.field.pseudoWeather)) {
      if ((!room.field.fieldSources?.pseudoWeather || room.field.fieldSources.pseudoWeather === "supplemental")) {
        room.field.pseudoWeather = [...payload.field.pseudoWeather];
        observeFields(room.field, ["pseudoWeather"], "supplemental");
      }
    }
    if (room.playerSide && Array.isArray(payload.field.yourSideConditions)) {
      if ((!room.sideConditions.fieldSources?.[room.playerSide] || room.sideConditions.fieldSources[room.playerSide] === "supplemental")) {
        room.sideConditions[room.playerSide] = payload.field.yourSideConditions.filter((value) => typeof value === "string");
        observeFields(room.sideConditions, [room.playerSide], "supplemental");
      }
    }
    if (room.opponentSideId && Array.isArray(payload.field.opponentSideConditions)) {
      if ((!room.sideConditions.fieldSources?.[room.opponentSideId] || room.sideConditions.fieldSources[room.opponentSideId] === "supplemental")) {
        room.sideConditions[room.opponentSideId] = payload.field.opponentSideConditions.filter((value) => typeof value === "string");
        observeFields(room.sideConditions, [room.opponentSideId], "supplemental");
      }
    }
  }

  const sideId = room.playerSide;
  const side = sideId ? ensureSide(room, sideId) : null;
  const activeKeysBySide = new Map();
  const supplementalPokemon = Array.isArray(payload.pokemon)
    ? payload.pokemon
    : Array.isArray(payload.myPokemon)
      ? payload.myPokemon
      : [];
  if (supplementalPokemon.length > 0) {
    for (const entry of supplementalPokemon) {
      const entrySideId = entry?.side === "p1" || entry?.side === "p2"
        ? entry.side
        : sideId;
      const pokemon = applyKnownPokemonState(room, entry, entrySideId, "supplemental");
      if (!pokemon) continue;
      if (entry?.active && pokemon.active && !["protocol", "request"].includes(ensureSide(room, entrySideId).fieldSources?.activeKey)) {
        const parsed = normalizeIdent(entry.ident ?? pokemon.ident);
        if (parsed.side && parsed.teamKey) {
          activeKeysBySide.set(parsed.side, parsed.teamKey);
        }
      }
    }
  }

  for (const [entrySideId, activeKey] of activeKeysBySide.entries()) {
    const targetSide = ensureSide(room, entrySideId);
    targetSide.activeKey = activeKey;
    observeFields(targetSide, ["activeKey"], "supplemental");
    for (const [teamKey, pokemon] of Object.entries(targetSide.team)) {
      pokemon.active = teamKey === activeKey;
    }
  }
  if (side && activeKeysBySide.has(sideId)) {
    side.activeKey = activeKeysBySide.get(sideId);
  }
  if (room.notes[room.notes.length - 1] !== "Merged supplemental page-state for live battle state.") {
    pushRecent(room.notes, "Merged supplemental page-state for live battle state.");
  }
}

function addSideCondition(room, sideId, condition) {
  const conditions = room.sideConditions[sideId];
  if (!conditions) return;
  if (isStackableSideCondition(condition) || !conditions.includes(condition)) {
    conditions.push(condition);
  }
}

function removeSideCondition(room, sideId, condition) {
  const conditions = room.sideConditions[sideId];
  if (!conditions) return;
  room.sideConditions[sideId] = conditions.filter((value) => value !== condition);
}

function sideRefToSideId(sideRef) {
  const match = String(sideRef ?? "").match(/^(p\d)/i);
  return match?.[1] ?? null;
}

function parseLine(line) {
  if (!line || !line.startsWith("|")) return null;
  const parts = line.split("|");
  return {
    tag: parts[1] ?? "",
    args: parts.slice(2)
  };
}

function asEffectLabel(value) {
  return String(value ?? "")
    .replace(/^\[(?:from|of)\]\s*/i, "")
    .replace(/^move:\s*/i, "")
    .replace(/^ability:\s*/i, "")
    .replace(/^item:\s*/i, "")
    .trim();
}

function effectOwnerPokemon(room, pokemon, args, startIndex = 0) {
  for (const raw of args.slice(startIndex)) {
    const value = String(raw ?? "").trim();
    const match = value.match(/^\[of\]\s*(.+)$/i);
    if (match?.[1]) {
      return ensurePokemon(room, match[1]);
    }
  }
  return pokemon;
}

/** ownEffect: the effect belongs to the line's own Pokémon even with an [of] (a -heal's [of] is the heal's source: Water
 * Absorb healing Clodsire names the Slowking whose Scald it absorbed). */
function applyEffectSources(room, pokemon, args, startIndex = 0, ownEffect = false) {
  const owner = ownEffect ? pokemon : effectOwnerPokemon(room, pokemon, args, startIndex);
  for (const raw of args.slice(startIndex)) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    if (/^\[(?:from|of)\]\s*item:/i.test(value) || /^item:/i.test(value)) {
      owner.item = asEffectLabel(value) || owner.item;
      observeFields(owner, ["item"]);
    }
    if (/^\[(?:from|of)\]\s*ability:/i.test(value) || /^ability:/i.test(value)) {
      owner.ability = asEffectLabel(value) || owner.ability;
      observeFields(owner, ["ability"]);
    }
  }
}

function hpChangeSourceLabel(args, startIndex = 0) {
  for (const raw of args.slice(startIndex)) {
    const value = String(raw ?? "").trim();
    if (!value || /^\[of\]/i.test(value)) continue;
    if (/^\[(?:from|of)\]/i.test(value) || !value.startsWith("[")) {
      return asEffectLabel(value) || null;
    }
  }
  return null;
}

function applyRequest(room, request) {
  room.lastRequest = request ?? null;
  room.requestCurrent = request !== null;
  room.legalActions = [];
  if (!request || typeof request !== "object") return;

  const isTeamPreview = Boolean(request.teamPreview);

  if (request.side?.id) {
    room.playerSide = request.side.id;
    room.opponentSideId = request.side.id === "p1" ? "p2" : "p1";
  }

  if (request.side?.name && room.playerSide) {
    ensureSide(room, room.playerSide).name = request.side.name;
  }

  if (Array.isArray(request.side?.pokemon)) {
    for (const entry of request.side.pokemon) {
      const pokemon = applyKnownPokemonState(room, entry, request.side?.id ?? room.playerSide ?? null);
      if (!pokemon) continue;
      if (entry.active) {
        const parsed = normalizeIdent(entry.ident ?? pokemon.ident);
        if (parsed.side && parsed.teamKey) {
          ensureSide(room, parsed.side).activeKey = parsed.teamKey;
          observeFields(ensureSide(room, parsed.side), ["activeKey"], "request");
          for (const [teamKey, mon] of Object.entries(ensureSide(room, parsed.side).team)) {
            mon.active = teamKey === parsed.teamKey;
          }
        }
      }
    }
  }

  if (room.winner) return;
  room.capability = (room.gameType && room.gameType !== "singles") || request.active?.length > 1 || request.forceSwitch?.length > 1
    ? "unsupported_game_type" : "supported";
  if (room.capability !== "supported") return;

  if (request.wait) {
    room.phase = room.winner ? "finished" : room.phase;
    return;
  }

  const activeRequest = Array.isArray(request.active) ? request.active[0] : null;
  const forceSwitch = Array.isArray(request.forceSwitch) ? Boolean(request.forceSwitch[0]) : Boolean(request.forceSwitch);
  const reviving = Boolean(request.reviving || request.side?.pokemon?.some((entry) => entry.reviving));
  if (isTeamPreview) {
    const entries = request.side?.pokemon ?? [];
    const chosenSize = request.maxChosenTeamSize ?? entries.length;
    if (entries.length > 6 || !Number.isInteger(chosenSize) || chosenSize < 1 || chosenSize > entries.length) {
      room.capability = "unsupported_team_size";
      return;
    }
    const enumerate = (order) => {
      if (order.length === chosenSize) {
        const teamSpec = order.join("");
        room.legalActions.push({
          id: `team:${teamSpec}`, kind: "team", actorSlot: 1, teamSpec: [...order],
          label: `Lead ${normalizeIdent(entries[order[0] - 1].ident).name}; order ${teamSpec}`,
          choice: `team ${teamSpec}`, legality: "certain", canUndo: !request.noCancel
        });
        return;
      }
      for (let slot = 1; slot <= entries.length; slot++) if (!order.includes(slot)) enumerate([...order, slot]);
    };
    enumerate([]);
    room.phase = "preview";
    return;
  }
  if (typeof activeRequest?.canTerastallize === "string" && room.playerSide) {
    const side = ensureSide(room, room.playerSide);
    const active = side.team[side.activeKey];
    if (active) active.teraType = activeRequest.canTerastallize;
  }
  if (activeRequest?.moves && !forceSwitch && !reviving) {
    for (const [index, move] of activeRequest.moves.entries()) {
      const moveId = String(move.id || move.move || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
      const action = {
        id: `move:${index + 1}|tera=0`,
        kind: "move",
        moveSlot: index + 1,
        moveId,
        actorSlot: 1,
        choice: `move ${index + 1}`,
        legality: move.disabled || move.pp === 0 ? "disabled" : activeRequest.maybeDisabled ? "uncertain" : "certain",
        canUndo: !(request.noCancel || activeRequest.maybeDisabled || activeRequest.maybeTrapped),
        ...(activeRequest.maybeDisabled ? { uncertainLegal: true } : {}),
        ...(activeRequest.maybeDisabled ? { uncertaintyReason: "maybe_disabled" } : {}),
        terastallize: false,
        label: move.move ?? move.id ?? moveId,
        moveName: move.move ?? move.id ?? null,
        target: move.target ?? null,
        pp: Number.isFinite(move.pp) ? move.pp : null,
        disabled: Boolean(move.disabled) || move.pp === 0,
        details: null
      };
      room.legalActions.push(action);
      if (activeRequest.canTerastallize) {
        room.legalActions.push({
          ...action,
          id: `move:${index + 1}|tera=1`,
          label: `Tera + ${action.label}`,
          terastallize: true,
          choice: `move ${index + 1} terastallize`,
          details: `Terastallize into ${activeRequest.canTerastallize === true ? "your Tera type" : activeRequest.canTerastallize}`
        });
      }
    }
  }

  const canSwitch = reviving || forceSwitch || (activeRequest && !forceSwitch && !activeRequest.trapped);
  const uncertainSwitch = !reviving && !forceSwitch && Boolean(activeRequest?.maybeTrapped);
  if (canSwitch && Array.isArray(request.side?.pokemon)) {
    for (const [index, entry] of request.side.pokemon.entries()) {
      const parsedCondition = parseConditionText(entry.condition);
      if (entry.active) continue;
      if (reviving ? !parsedCondition.fainted : parsedCondition.fainted) continue;
      room.legalActions.push({
        id: `switch:${index + 1}`,
        kind: "switch",
        targetSlot: index + 1,
        actorSlot: 1,
        ...(reviving ? { reviving: true } : {}),
        choice: `switch ${index + 1}`,
        legality: uncertainSwitch ? "uncertain" : "certain",
        canUndo: !(request.noCancel || uncertainSwitch),
        label: `${reviving ? "Revive" : "Switch to"} ${normalizeIdent(entry.ident).name ?? entry.ident}`,
        moveName: null,
        target: entry.ident,
        pp: null,
        disabled: null,
        details: uncertainSwitch
          ? "May be blocked by a hidden trapping ability; attempting the switch cannot be undone."
          : parsedCondition.hpPercent === null ? null : `${parsedCondition.hpPercent}%`,
        ...(uncertainSwitch ? { uncertainLegal: true } : {}),
        ...(uncertainSwitch ? { uncertaintyReason: "hidden_trapping_ability" } : {})
      });
    }
  }

  if (activeRequest?.canTerastallize || request.side?.canTerastallize) {
    pushRecent(room.notes, "Terastallization is available.");
  }
  room.phase = room.winner ? "finished" : isTeamPreview ? "preview" : "turn";
}

export function roomHasActionableRequest(room) {
  if (room?.requestCurrent === false || room?.winner) return false;
  if (room?.capability && room.capability !== "supported") return false;
  if (!room?.lastRequest || room.lastRequest.wait) return false;
  if (room.lastRequest.teamPreview) return true;
  if (!Array.isArray(room.legalActions) || room.legalActions.length === 0) return false;
  return true;
}

function reduceLine(room, line) {
  const parsed = parseLine(line);
  if (!parsed) return;
  const { tag, args } = parsed;

  switch (tag) {
    case "init":
      if (args[0] === "battle") room.phase = "preview";
      return;
    case "title":
      room.title = args[0] ?? room.title;
      return;
    case "tier":
      room.format = args[0] ?? room.format;
      return;
    case "gametype":
      room.gameType = args[0] ?? room.gameType;
      return;
    case "player": {
      const sideId = args[0];
      const sideName = args[1] ?? null;
      if (!sideId) return;
      ensureSide(room, sideId).name = sideName;
      return;
    }
    case "poke": {
      const sideId = args[0];
      const details = args[1];
      if (!sideId || !details) return;
      const side = ensureSide(room, sideId);
      const pseudoIdent = `${sideId}: ${sanitizeSpecies(details)}`;
      const pokemon = ensurePokemon(room, pseudoIdent);
      updatePokemonFromDetails(pokemon, details, undefined, true);
      pokemon.revealed = true;
      if (!side.team[pseudoIdent]) side.team[pseudoIdent] = pokemon;
      return;
    }
    case "turn":
      room.turn = Number(args[0] ?? room.turn) || room.turn;
      room.phase = room.winner ? "finished" : "turn";
      pushRecent(room.recentLog, `Turn ${room.turn} started.`);
      return;
    case "request": {
      try {
        const request = JSON.parse(args.join("|"));
        applyRequest(room, request);
      } catch (error) {
        pushRecent(room.notes, `Failed to parse request JSON: ${String(error)}`);
      }
      return;
    }
    case "sso-state": {
      try {
        const payload = JSON.parse(args.join("|"));
        applySupplementalState(room, payload);
      } catch (error) {
        pushRecent(room.notes, `Failed to parse supplemental state JSON: ${String(error)}`);
      }
      return;
    }
    case "switch":
    case "drag":
    case "replace": {
      const ident = args[0];
      const details = args[1];
      const condition = args[2];
      const parsedIdent = normalizeIdent(ident);
      if (!parsedIdent.side || !parsedIdent.teamKey) return;
      const side = ensureSide(room, parsedIdent.side);
      const pokemon = ensurePokemon(room, ident);
      // Paradox activation is tied to this stay on the field, not the lifetime
      // record of a consumed Booster Energy. Illusion replacement isn't entry.
      if (tag !== "replace") {
        for (const mon of Object.values(side.team)) {
          if (mon.active || mon === pokemon) {
            mon.boosts = {};
            // A new entry has no observed activation yet. Do not carry an
            // expired timer (or an old active timer) across field stints.
            delete mon.slowStartActive;
            observeFields(mon, ["slowStartActive"]);
            if (mon.unburdenActive !== undefined || /^unburden$/i.test(mon.ability ?? "")) {
              mon.unburdenActive = false;
              observeFields(mon, ["unburdenActive"]);
            }
            observeFields(mon, ["boosts"]);
            if (mon.paradoxBoostedStat !== undefined || mon.removedItem === "Booster Energy") {
              mon.paradoxBoostedStat = null;
            }
          }
        }
      }
      updatePokemonFromDetails(pokemon, details, condition);
      pokemon.active = true;
      side.activeKey = parsedIdent.teamKey;
      observeFields(side, ["activeKey"]);
      for (const [key, mon] of Object.entries(side.team)) {
        if (key !== parsedIdent.teamKey) mon.active = false;
        observeFields(mon, ["active"]);
      }
      if (tag !== "replace") pushRecent(room.recentLog, `${logPokemonName(room, ident)} entered the field.`);
      return;
    }
    case "move": {
      const source = ensurePokemon(room, args[0]);
      const moveName = args[1];
      if (room.observationContext?.recordMove !== false) setKnownMove(source, moveName);
      pushRecent(room.recentLog, `${logPokemonName(room, args[0])} used ${moveName}.`);
      return;
    }
    case "cant": {
      const reason = asEffectLabel(args[1]) || "could not move";
      pushRecent(room.recentLog, `${logPokemonName(room, args[0])} could not move (${reason}).`);
      return;
    }
    case "faint": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.fainted = true;
      pokemon.hpPercent = 0;
      pokemon.conditionText = "0 fnt";
      pokemon.status = "fnt";
      pokemon.active = false;
      delete pokemon.slowStartActive;
      observeFields(pokemon, ["slowStartActive"]);
      pushRecent(room.recentLog, `${logPokemonName(room, args[0])} fainted.`);
      return;
    }
    case "-damage":
    case "-heal": {
      const pokemon = ensurePokemon(room, args[0]);
      const parsedCondition = parseConditionText(args[1]);
      pokemon.conditionText = parsedCondition.conditionText;
      pokemon.hpPercent = parsedCondition.hpPercent;
      pokemon.status = parsedCondition.status ?? pokemon.status;
      pokemon.fainted = parsedCondition.fainted;
      applyEffectSources(room, pokemon, args, 2, tag === "-heal");
      const sourceLabel = hpChangeSourceLabel(args, 2);
      if (sourceLabel) {
        pushRecent(room.recentLog, `${logPokemonName(room, args[0])} had HP change from ${sourceLabel}.`);
      }
      return;
    }
    case "-status": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.status = args[1] ?? pokemon.status;
      applyEffectSources(room, pokemon, args, 2);
      const statusSourceLabel = hpChangeSourceLabel(args, 2);
      if (statusSourceLabel) {
        pushRecent(room.recentLog, `${logPokemonName(room, args[0])} gained status ${pokemon.status} from ${statusSourceLabel}.`);
      }
      return;
    }
    case "-curestatus": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.status = null;
      return;
    }
    case "-boost": {
      const pokemon = ensurePokemon(room, args[0]);
      const stat = args[1];
      const amount = Number(args[2] ?? 0);
      pokemon.boosts[stat] = clampBoostStage((pokemon.boosts[stat] ?? 0) + amount);
      return;
    }
    case "-unboost": {
      const pokemon = ensurePokemon(room, args[0]);
      const stat = args[1];
      const amount = Number(args[2] ?? 0);
      pokemon.boosts[stat] = clampBoostStage((pokemon.boosts[stat] ?? 0) - amount);
      return;
    }
    case "-setboost": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.boosts[args[1]] = clampBoostStage(Number(args[2] ?? 0));
      return;
    }
    case "-clearboost":
      ensurePokemon(room, args[0]).boosts = {};
      return;
    case "-clearallboost":
      for (const side of Object.values(room.sides)) {
        for (const mon of Object.values(side.team)) mon.boosts = {};
      }
      return;
    case "-start": {
      if (/^slow start$/i.test(asEffectLabel(args[1]))) {
        const pokemon = ensurePokemon(room, args[0]);
        pokemon.ability = "Slow Start";
        pokemon.slowStartActive = true;
        observeFields(pokemon, ["ability", "slowStartActive"]);
      }
      const match = asEffectLabel(args[1]).toLowerCase().match(/^(protosynthesis|quarkdrive)(atk|def|spa|spd|spe)$/);
      if (match) {
        const pokemon = ensurePokemon(room, args[0]);
        pokemon.ability = match[1] === "protosynthesis" ? "Protosynthesis" : "Quark Drive";
        pokemon.paradoxBoostedStat = match[2];
        observeFields(pokemon, ["ability", "paradoxBoostedStat"]);
      }
      return;
    }
    case "-end": {
      if (/^slow start$/i.test(asEffectLabel(args[1]))) {
        const pokemon = ensurePokemon(room, args[0]);
        pokemon.slowStartActive = false;
        observeFields(pokemon, ["slowStartActive"]);
      }
      if (/^(protosynthesis|quark drive|quarkdrive)$/i.test(asEffectLabel(args[1]))) {
        ensurePokemon(room, args[0]).paradoxBoostedStat = null;
        observeFields(ensurePokemon(room, args[0]), ["paradoxBoostedStat"]);
      }
      if (/^unburden$/i.test(asEffectLabel(args[1]))) {
        ensurePokemon(room, args[0]).unburdenActive = false;
        observeFields(ensurePokemon(room, args[0]), ["unburdenActive"]);
      }
      return;
    }
    case "-ability": {
      const pokemon = ensurePokemon(room, args[0]);
      const ability = asEffectLabel(args[1]);
      if (ability.toLowerCase().replace(/[^a-z]/g, "") !== String(pokemon.ability ?? "").toLowerCase().replace(/[^a-z]/g, "")) {
        delete pokemon.slowStartActive;
        observeFields(pokemon, ["slowStartActive"]);
      }
      pokemon.ability = ability;
      if (pokemon.ability.toLowerCase().replace(/[^a-z]/g, "") !== "unburden") pokemon.unburdenActive = false;
      return;
    }
    case "-endability": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.ability = null;
      delete pokemon.slowStartActive;
      observeFields(pokemon, ["slowStartActive"]);
      pokemon.unburdenActive = false;
      return;
    }
    case "-item": {
      const pokemon = ensurePokemon(room, args[0]);
      const nextItem = normalizeKnownString(args[1]) ?? pokemon.item;
      pokemon.item = nextItem;
      if (nextItem) {
        pokemon.removedItem = null;
        pokemon.unburdenActive = false;
      }
      return;
    }
    case "-enditem": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.removedItem = normalizeKnownString(args[1]) ?? pokemon.item ?? pokemon.removedItem;
      pokemon.item = null;
      pokemon.unburdenActive = true;
      return;
    }
    case "-terastallize": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.terastallized = true;
      pokemon.teraType = args[1] ?? pokemon.teraType;
      pushRecent(room.recentLog, `${logPokemonName(room, args[0])} Terastallized${pokemon.teraType ? ` into ${pokemon.teraType}` : ""}.`);
      return;
    }
    case "-activate": {
      const pokemon = ensurePokemon(room, args[0]);
      // Skill Swap exposes both resulting abilities in source/target order.
      // A subsequent Slow Start -start establishes the new activation stint.
      const target = args.find((arg) => arg.startsWith("[of] "))?.slice(5);
      if (/^(?:move: )?skill swap$/i.test(args[1] ?? "") && target && args[2] && args[3]
          && !args[2].startsWith("[") && !args[3].startsWith("[")) {
        for (const [mon, ability] of [[pokemon, args[2]], [ensurePokemon(room, target), args[3]]]) {
          mon.ability = asEffectLabel(ability);
          delete mon.slowStartActive;
          mon.unburdenActive = false;
          observeFields(mon, ["ability", "slowStartActive", "unburdenActive"]);
        }
      }
      applyEffectSources(room, pokemon, args, 1);
      return;
    }
    case "detailschange":
    case "-formechange": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.species = sanitizeSpecies(args[1]);
      if (tag === "detailschange") updatePokemonFromDetails(pokemon, args[1], args[2]);
      return;
    }
    case "-weather":
      room.field.weather = !args[0] || args[0] === "none" ? null : asEffectLabel(args[0]);
      return;
    case "-fieldstart": {
      const effect = asEffectLabel(args[0]);
      if (!room.field.pseudoWeather.includes(effect)) room.field.pseudoWeather.push(effect);
      if (/terrain/i.test(effect)) room.field.terrain = effect;
      return;
    }
    case "-fieldend": {
      const effect = asEffectLabel(args[0]);
      room.field.pseudoWeather = room.field.pseudoWeather.filter((value) => value !== effect);
      if (room.field.terrain === effect) room.field.terrain = null;
      return;
    }
    case "-sidestart": {
      const sideId = sideRefToSideId(args[0]);
      const effect = asEffectLabel(args[1]);
      if (sideId && effect) addSideCondition(room, sideId, effect);
      return;
    }
    case "-sideend": {
      const sideId = sideRefToSideId(args[0]);
      const effect = asEffectLabel(args[1]);
      if (sideId && effect) removeSideCondition(room, sideId, effect);
      return;
    }
    case "-supereffective":
      pushRecent(room.recentLog, "It was super effective.");
      return;
    case "-resisted":
      pushRecent(room.recentLog, "It was resisted.");
      return;
    case "-immune":
      applyEffectSources(room, ensurePokemon(room, args[0]), args, 1);
      pushRecent(room.recentLog, "The target was immune.");
      return;
    case "-crit":
      pushRecent(room.recentLog, "It was a critical hit.");
      return;
    case "-fail":
      pushRecent(room.recentLog, "A move or effect failed.");
      return;
    case "win":
      room.winner = args[0] ?? null;
      room.phase = "finished";
      pushRecent(room.recentLog, `Winner: ${room.winner}`);
      return;
    case "tie":
      room.winner = "tie";
      room.phase = "finished";
      return;
    default:
      return;
  }
}

// Presence is distinct from value. A freshly reduced clear can equal an
// empty-room default and still must replace an older observation.
function handleLine(room, line) {
  const parsed = parseLine(line);
  if (!parsed) return;
  room.protocolSequence = (room.protocolSequence ?? 0) + 1;
  const reference = room.observationContext?.lineId ?? `${room.roomId}:${room.protocolSequence}`;
  const pending = (room.entryObservations ?? []).filter((entry) => !entry.complete);
  for (const entry of pending) {
    entry.observationIds.push(reference);
    // Simultaneous entries (a double replacement) print both switches before either side's hazards apply (Showdown queues
    // each runSwitch), so another side's switch does not end this entry; its own side's next switch does.
    const sameSideSwitch = ["switch", "drag"].includes(parsed.tag) && normalizeIdent(parsed.args[0]).side === entry.side;
    if (sameSideSwitch || ["move", "cant", "turn", "request", "upkeep", "win", "tie"].includes(parsed.tag)) entry.complete = true;
    if (parsed.tag === "-damage" && normalizeIdent(parsed.args[0]).teamKey === entry.ident) entry.damageObserved = true;
  }
  reduceLine(room, line);
  const { tag, args } = parsed;
  if (tag === "switch" || tag === "drag") {
    const parsedIdent = normalizeIdent(args[0]);
    const hazards = [...(room.sideConditions[parsedIdent.side] ?? [])];
    if (hazards.some((hazard) => /^(Stealth Rock|Spikes|Toxic Spikes)$/i.test(hazard))) {
      const pokemon = ensurePokemon(room, args[0]);
      room.entryObservations ??= [];
      room.entryObservations.push({
        ident: pokemon.ident, species: pokemon.species, side: parsedIdent.side, turn: room.turn,
        hazards, types: pokemon.terastallized && pokemon.teraType && pokemon.teraType !== "Stellar" ? [pokemon.teraType] : [...pokemon.types],
        damageObserved: false, complete: false, observationIds: [reference]
      });
      room.entryObservations = room.entryObservations.slice(-64);
    }
  }
  const roomFields = { turn: "turn", tier: "format", gametype: "gameType", title: "title", win: "winner", tie: "winner" };
  if (roomFields[tag]) observeFields(room, [roomFields[tag]]);
  if (["move", "cant", "switch", "drag", "turn", "win", "tie"].includes(tag)) {
    room.requestCurrent = false;
    room.legalActions = [];
  }
  const fields = {
    switch: ["species", "level", "conditionText", "hpPercent", "status", "fainted", "active", "boosts", "unburdenActive"],
    drag: ["species", "level", "conditionText", "hpPercent", "status", "fainted", "active", "boosts", "unburdenActive"],
    replace: ["species", "level", "conditionText", "hpPercent", "status", "fainted", "active"],
    "-damage": ["conditionText", "hpPercent", "status", "fainted"],
    "-heal": ["conditionText", "hpPercent", "status", "fainted"],
    faint: ["conditionText", "hpPercent", "status", "fainted", "active"],
    "-status": ["status"], "-curestatus": ["status"],
    "-boost": ["boosts"], "-unboost": ["boosts"], "-setboost": ["boosts"], "-clearboost": ["boosts"],
    "-item": ["item", "removedItem", "unburdenActive"], "-enditem": ["item", "removedItem", "unburdenActive"],
    "-ability": ["ability", "unburdenActive"], "-endability": ["ability", "unburdenActive"],
    "-terastallize": ["terastallized", "teraType"], "-formechange": ["species"],
    detailschange: ["species", "level", "conditionText", "hpPercent", "status", "fainted"]
  }[tag];
  if (fields && args[0]) {
    const pokemon = ensurePokemon(room, args[0]);
    observeFields(pokemon, fields.filter((field) => pokemon[field] !== undefined));
  }
  if (tag === "-clearallboost") {
    for (const side of Object.values(room.sides)) for (const mon of Object.values(side.team)) observeFields(mon, ["boosts"]);
  }
  if (tag === "-weather") observeFields(room.field, ["weather"]);
  if (tag === "-fieldstart" || tag === "-fieldend") {
    observeFields(room.field, ["pseudoWeather", ...(/terrain/i.test(args[0]) ? ["terrain"] : [])]);
  }
  if (tag === "-sidestart" || tag === "-sideend") observeFields(room.sideConditions, [sideRefToSideId(args[0])]);
}

export function splitProtocolPacket(raw) {
  const lines = String(raw ?? "").replace(/\r/g, "").split("\n");
  const packets = [];
  let currentRoomId = null;
  let currentLines = [];

  for (const line of lines) {
    if (line.startsWith(">")) {
      if (currentRoomId || currentLines.length) {
        packets.push({ roomId: currentRoomId, lines: currentLines });
      }
      currentRoomId = line.slice(1).trim() || null;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentRoomId || currentLines.length) {
    packets.push({ roomId: currentRoomId, lines: currentLines });
  }

  return packets;
}

export function createEmptyRoomState(roomId) {
  return {
    roomId,
    title: null,
    format: "Unknown",
    gameType: null,
    turn: 0,
    phase: "unknown",
    winner: null,
    playerSide: null,
    opponentSideId: null,
    lastRequest: null,
    legalActions: [],
    recentLog: [],
    notes: [],
    sides: {
      p1: { slot: "p1", name: null, team: {}, activeKey: null },
      p2: { slot: "p2", name: null, team: {}, activeKey: null }
    },
    unownedTeam: {},
    field: {
      weather: null,
      terrain: null,
      pseudoWeather: []
    },
    hasSupplementalFieldSnapshot: false,
    sideConditions: {
      p1: [],
      p2: []
    },
    updatedAt: Date.now()
  };
}

export function applyRawFrameToRoomMap(roomMap, rawPacket, observationContext = null) {
  const packets = splitProtocolPacket(rawPacket);
  for (const packet of packets) {
    const roomId = packet.roomId;
    if (!roomId || !roomId.startsWith("battle-")) continue;
    const room = roomMap.get(roomId) ?? createEmptyRoomState(roomId);
    for (const [index, line] of packet.lines.entries()) {
      room.observationContext = observationContext ? { lineId: observationContext.lineId ?? `${observationContext.observationId}#${index + 1}`, recordMove: observationContext.recordMove, presentationName: observationContext.presentationName } : null;
      handleLine(room, line);
    }
    delete room.observationContext;
    room.updatedAt = Date.now();
    roomMap.set(roomId, room);
  }
}

function toPokemonSnapshot(mon) {
  if (!mon) return null;
  return {
    ident: mon.ident ?? null,
    species: mon.species ?? null,
    displayName: mon.displayName ?? mon.species ?? null,
    level: mon.level ?? null,
    conditionText: mon.conditionText ?? null,
    hpPercent: mon.hpPercent ?? null,
    status: mon.status ?? null,
    fainted: Boolean(mon.fainted),
    active: Boolean(mon.active),
    revealed: Boolean(mon.revealed),
    boosts: mon.boosts ?? {},
    stats: mon.stats ?? {},
    knownMoves: [...(mon.knownMoves ?? [])],
    item: mon.item ?? null,
    removedItem: mon.removedItem ?? null,
    ability: mon.ability ?? null,
    types: [...(mon.types ?? [])],
    teraType: mon.teraType ?? null,
    terastallized: Boolean(mon.terastallized),
    ...Object.fromEntries(["instanceId", "appearanceId", "identityStatus", "presumedInstanceId", "candidateInstanceIds", "evidenceRefs", "canonicalSpecies", "appearanceMoves", "turnsSinceEntry", "itemProof"].filter((field) => mon[field] !== undefined).map((field) => [field, mon[field]])),
    ...(mon.paradoxBoostedStat !== undefined ? { paradoxBoostedStat: mon.paradoxBoostedStat } : {}),
    ...(mon.unburdenActive !== undefined ? { unburdenActive: mon.unburdenActive } : {}),
    ...(mon.slowStartActive !== undefined ? { slowStartActive: mon.slowStartActive } : {})
  };
}

function sideToSnapshot(side) {
  const team = Object.values(side.team).map(toPokemonSnapshot);
  const active = side.activeKey ? toPokemonSnapshot(side.team[side.activeKey]) : null;
  team.sort((a, b) => {
    if (a?.active && !b?.active) return -1;
    if (!a?.active && b?.active) return 1;
    return String(a?.displayName ?? "").localeCompare(String(b?.displayName ?? ""));
  });
  return {
    slot: side.slot,
    name: side.name,
    active,
    team
  };
}

export function roomToSnapshot(room) {
  if (!room || !room.playerSide) return null;
  const yourSide = room.sides[room.playerSide];
  const opponentSide = room.sides[room.opponentSideId ?? (room.playerSide === "p1" ? "p2" : "p1")];
  if (!yourSide || !opponentSide) return null;

  return {
    version: "0.1.0",
    capturedAt: new Date(room.updatedAt).toISOString(),
    roomId: room.roomId,
    title: room.title,
    format: room.format || "Unknown",
    turn: room.turn,
    phase: room.phase,
    yourSide: sideToSnapshot(yourSide),
    opponentSide: sideToSnapshot(opponentSide),
    field: {
      weather: room.field.weather,
      terrain: room.field.terrain,
      pseudoWeather: [...room.field.pseudoWeather],
      yourSideConditions: [...(room.sideConditions[room.playerSide] ?? [])],
      opponentSideConditions: [...(room.sideConditions[room.opponentSideId ?? (room.playerSide === "p1" ? "p2" : "p1")] ?? [])]
    },
    legalActions: [...room.legalActions],
    ...(room.canonicalEvidence ? { canonicalEvidence: room.canonicalEvidence } : {}),
    ...(room.pendingAttacks?.length ? { pendingAttacks: structuredClone(room.pendingAttacks) } : {}),
    ...(room.entryObservations?.length ? { entryObservations: structuredClone(room.entryObservations) } : {}),
    recentLog: [...room.recentLog],
    rawRequestSummary: room.lastRequest
      ? {
          ...(Number.isSafeInteger(room.lastRequest.rqid) ? { rqid: room.lastRequest.rqid } : {}),
          forceSwitch: room.lastRequest.forceSwitch ?? false,
          wait: room.requestCurrent === false || (room.lastRequest.wait ?? false),
          teamPreview: room.lastRequest.teamPreview ?? false,
          gameType: room.gameType ?? "singles",
          reviving: Boolean(room.lastRequest.reviving || room.lastRequest.side?.pokemon?.some((entry) => entry.reviving)),
          capability: room.capability ?? "supported",
          requestKind: room.winner ? "finished" : room.capability && room.capability !== "supported" ? "unsupported" : room.requestCurrent === false ? "resolving" : room.lastRequest.wait ? "wait" : room.lastRequest.teamPreview ? "team_preview" : (Array.isArray(room.lastRequest.forceSwitch) ? room.lastRequest.forceSwitch.some(Boolean) : room.lastRequest.forceSwitch) ? "forced_switch" : "move",
          sideId: room.lastRequest.side?.id ?? null,
          canTerastallize:
            room.lastRequest.side?.canTerastallize ??
            room.lastRequest.active?.[0]?.canTerastallize ??
            false
        }
      : null,
    notes: [...room.notes].slice(-10)
  };
}

function mergePokemonState(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  const merged = {
    ...previous,
    ...next,
    ident: next.ident ?? previous.ident,
    species: next.species ?? previous.species,
    displayName: next.displayName ?? previous.displayName,
    level: next.level ?? previous.level,
    conditionText: next.conditionText ?? previous.conditionText,
    hpPercent: next.hpPercent ?? previous.hpPercent,
    status: next.status ?? previous.status,
    fainted: Boolean(next.fainted || previous.fainted),
    active: Boolean(next.active || previous.active),
    revealed: Boolean(next.revealed || previous.revealed),
    boosts: mergeFiniteStats(previous.boosts, next.boosts),
    stats: (FIELD_AUTHORITY[next.fieldSources?.stats] ?? 0) >= (FIELD_AUTHORITY[previous.fieldSources?.stats] ?? 0)
      ? mergeFiniteStats(previous.stats, next.stats) : mergeFiniteStats(next.stats, previous.stats),
    knownMoves: mergeUniqueStrings(previous.knownMoves, next.knownMoves),
    item: next.item ?? previous.item,
    removedItem: next.removedItem ?? previous.removedItem,
    ability: next.ability ?? previous.ability,
    ...(next.paradoxBoostedStat !== undefined
      ? { paradoxBoostedStat: next.paradoxBoostedStat }
      : previous.paradoxBoostedStat !== undefined ? { paradoxBoostedStat: previous.paradoxBoostedStat } : {}),
    types: mergeUniqueStrings(previous.types, next.types),
    teraType: next.teraType ?? previous.teraType,
    terastallized: Boolean(next.terastallized || previous.terastallized),
    fieldSources: mergedFieldSources(previous, next)
  };
  for (const field of ["species", "level", "conditionText", "hpPercent", "status", "fainted", "active", "boosts", "item", "removedItem", "ability", "unburdenActive", "slowStartActive", "paradoxBoostedStat", "teraType", "terastallized"]) {
    merged[field] = observedValue(previous, next, field);
    const previousSource = previous.fieldSources?.[field];
    const nextSource = next.fieldSources?.[field];
    if ((FIELD_AUTHORITY[previousSource] ?? 0) > (FIELD_AUTHORITY[nextSource] ?? 0)) merged.fieldSources[field] = previousSource;
  }
  const rejectedItemSource = next.fieldSources?.item;
  if (rejectedItemSource && (FIELD_AUTHORITY[previous.fieldSources?.item] ?? 0) > (FIELD_AUTHORITY[rejectedItemSource] ?? 0)) {
    for (const field of ["removedItem", "unburdenActive"]) {
      if (next.fieldSources?.[field] !== rejectedItemSource) continue;
      if (previous[field] === undefined) delete merged[field];
      else merged[field] = previous[field];
    }
  }
  return merged;
}

function mergeSideState(previous, next) {
  const mergedTeam = {};
  const keys = new Set([
    ...Object.keys(previous?.team ?? {}),
    ...Object.keys(next?.team ?? {})
  ]);
  for (const key of keys) {
    const mergedPokemon = mergePokemonState(previous?.team?.[key], next?.team?.[key]);
    if (mergedPokemon) mergedTeam[key] = mergedPokemon;
  }

  const activeKey = observedValue(previous, next, "activeKey") ?? null;
  if (activeKey) {
    for (const [teamKey, pokemon] of Object.entries(mergedTeam)) {
      pokemon.active = teamKey === activeKey;
    }
  }

  return {
    slot: next?.slot ?? previous?.slot ?? null,
    name: next?.name ?? previous?.name ?? null,
    team: mergedTeam,
    activeKey,
    fieldSources: mergedFieldSources(previous, next)
  };
}

export function mergeRoomState(previous, next) {
  if (!previous) return next;
  if (!next) return previous;

  const playerSide = previous.playerSide ?? next.playerSide ?? null;
  const opponentSideId = previous.opponentSideId ?? next.opponentSideId ?? (playerSide === "p1" ? "p2" : playerSide === "p2" ? "p1" : null);
  const winner = observedValue(previous, next, "winner");

  const merged = {
    ...previous,
    ...next,
    title: observedValue(previous, next, "title"),
    format: observedValue(previous, next, "format"),
    gameType: observedValue(previous, next, "gameType"),
    turn: observedValue(previous, next, "turn"),
    phase: winner ? "finished" : next.lastRequest ? next.phase : previous.phase !== "unknown" ? previous.phase : next.phase,
    winner,
    fieldSources: mergedFieldSources(previous, next),
    playerSide,
    opponentSideId,
    lastRequest: next.lastRequest ?? previous.lastRequest,
    requestCurrent: next.lastRequest ? next.requestCurrent : previous.requestCurrent,
    legalActions: winner ? [] : next.lastRequest ? [...(next.legalActions ?? [])] : [...(previous.legalActions ?? [])],
    // Recovery is not a new wire event. Replaying its rolling UI projection
    // here can fabricate chronology in history/inference and regress phase.
    recentLog: previous.recentLog?.length ? [...previous.recentLog] : [...(next.recentLog ?? [])],
    notes: [...(previous.notes ?? []), ...(next.notes ?? []).filter((note) => !previous.notes?.includes(note))].slice(-MAX_LOG),
    sides: {
      p1: mergeSideState(previous.sides?.p1, next.sides?.p1),
      p2: mergeSideState(previous.sides?.p2, next.sides?.p2)
    },
    unownedTeam: {
      ...(previous.unownedTeam ?? {}),
      ...(next.unownedTeam ?? {})
    },
    entryObservations: previous.entryObservations ?? next.entryObservations,
    field: {
      weather: observedValue(previous.field, next.field, "weather") ?? null,
      terrain: observedValue(previous.field, next.field, "terrain") ?? null,
      pseudoWeather: [...(observedValue(previous.field, next.field, "pseudoWeather") ?? [])],
      fieldSources: mergedFieldSources(previous.field, next.field)
    },
    hasSupplementalFieldSnapshot: Boolean(previous.hasSupplementalFieldSnapshot || next.hasSupplementalFieldSnapshot),
    sideConditions: {
      p1: [...(observedValue(previous.sideConditions, next.sideConditions, "p1") ?? [])],
      p2: [...(observedValue(previous.sideConditions, next.sideConditions, "p2") ?? [])],
      fieldSources: mergedFieldSources(previous.sideConditions, next.sideConditions)
    },
    updatedAt: Math.max(previous.updatedAt ?? 0, next.updatedAt ?? 0)
  };
  // Canonical recovery ingestion admits only a newer request here. Its own
  // private domains supersede older public/private observations of that team.
  if (next.lastRequest && !merged.winner) applyRequest(merged, next.lastRequest);
  return merged;
}

export function pickBestSnapshotForTab(tabState) {
  if (!tabState) return null;
  const rooms = [...tabState.rooms.values()].sort(sortByMostRecent);
  const activeRoom = tabState.activeRoomId ? tabState.rooms.get(tabState.activeRoomId) : null;
  const best = activeRoom ?? rooms.find((room) => roomHasActionableRequest(room)) ?? rooms[0] ?? null;
  return roomToSnapshot(best);
}

/** Initialize a companion-owned canonical roster before fact materialization. */
export function seedCanonicalRoster(room, entries) {
  for (const entry of entries) applyKnownPokemonState(room, entry, null, "supplemental");
}
