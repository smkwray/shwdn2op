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
  const parsed = Number(match?.[1] ?? "");
  return Number.isFinite(parsed) ? parsed : null;
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

function updatePokemonFromDetails(pokemon, details, condition) {
  if (details) {
    pokemon.species = sanitizeSpecies(details);
    pokemon.level = extractLevel(details) ?? pokemon.level;
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

function normalizeKnownString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isStackableSideCondition(condition) {
  return /^(spikes|toxic spikes)$/i.test(String(condition ?? "").trim());
}

function applyKnownPokemonState(room, entry, fallbackSideId = null) {
  if (!entry || typeof entry !== "object") return null;
  const ident = normalizeKnownString(entry.ident)
    ?? (fallbackSideId && entry.details ? `${fallbackSideId}: ${sanitizeSpecies(entry.details)}` : null);
  if (!ident) return null;

  const pokemon = ensurePokemon(room, ident);
  updatePokemonFromDetails(pokemon, entry.details, entry.condition);
  if (Object.prototype.hasOwnProperty.call(entry, "active")) {
    pokemon.active = Boolean(entry.active);
  }
  pokemon.level = Number.isFinite(entry.level) ? Number(entry.level) : pokemon.level;
  pokemon.stats = mergeFiniteStats(pokemon.stats, entry.stats);
  pokemon.boosts = mergeFiniteStats(pokemon.boosts, entry.boosts);

  if (Object.prototype.hasOwnProperty.call(entry, "item")) {
    const nextItem = normalizeKnownString(entry.item) ?? null;
    pokemon.item = nextItem;
    if (nextItem) {
      pokemon.removedItem = null;
    }
  }

  const abilityValue = normalizeKnownString(entry.ability) ?? normalizeKnownString(entry.baseAbility);
  if (abilityValue) {
    pokemon.ability = abilityValue;
  }

  if (Object.prototype.hasOwnProperty.call(entry, "teraType")) {
    pokemon.teraType = normalizeKnownString(entry.teraType) ?? pokemon.teraType;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "terastallized")) {
    pokemon.terastallized = Boolean(entry.terastallized);
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
  if (payload.playerSide === "p1" || payload.playerSide === "p2") {
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
      room.field.weather = normalizeKnownString(payload.field.weather) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(payload.field, "terrain")) {
      room.field.terrain = normalizeKnownString(payload.field.terrain) ?? null;
    }
    if (Array.isArray(payload.field.pseudoWeather)) {
      room.field.pseudoWeather = mergeUniqueStrings(room.field.pseudoWeather, payload.field.pseudoWeather);
    }
    if (room.playerSide && Array.isArray(payload.field.yourSideConditions)) {
      room.sideConditions[room.playerSide] = payload.field.yourSideConditions.filter((value) => typeof value === "string");
    }
    if (room.opponentSideId && Array.isArray(payload.field.opponentSideConditions)) {
      room.sideConditions[room.opponentSideId] = payload.field.opponentSideConditions.filter((value) => typeof value === "string");
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
      const pokemon = applyKnownPokemonState(room, entry, entrySideId);
      if (!pokemon) continue;
      if (entry?.active) {
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

function applyEffectSources(room, pokemon, args, startIndex = 0) {
  const owner = effectOwnerPokemon(room, pokemon, args, startIndex);
  for (const raw of args.slice(startIndex)) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    if (/^\[(?:from|of)\]\s*item:/i.test(value) || /^item:/i.test(value)) {
      owner.item = asEffectLabel(value) || owner.item;
    }
    if (/^\[(?:from|of)\]\s*ability:/i.test(value) || /^ability:/i.test(value)) {
      owner.ability = asEffectLabel(value) || owner.ability;
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
          for (const [teamKey, mon] of Object.entries(ensureSide(room, parsed.side).team)) {
            mon.active = teamKey === parsed.teamKey;
          }
        }
      }
    }
  }

  room.legalActions = [];

  if (request.wait) {
    room.phase = room.winner ? "finished" : room.phase;
    return;
  }

  const activeRequest = Array.isArray(request.active) ? request.active[0] : null;
  if (activeRequest?.moves) {
    for (const move of activeRequest.moves) {
      const moveId = String(move.id || move.move || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
      room.legalActions.push({
        id: `move:${moveId}`,
        kind: "move",
        label: move.move ?? move.id ?? moveId,
        moveName: move.move ?? move.id ?? null,
        target: move.target ?? null,
        pp: Number.isFinite(move.pp) ? move.pp : null,
        disabled: Boolean(move.disabled),
        details: activeRequest.canTerastallize ? "Tera available" : null
      });
    }
  }

  const forceSwitch = Array.isArray(request.forceSwitch)
    ? request.forceSwitch.some(Boolean)
    : Boolean(request.forceSwitch);
  const canSwitch = forceSwitch || (!activeRequest?.trapped && !activeRequest?.maybeTrapped);
  if (canSwitch && Array.isArray(request.side?.pokemon)) {
    for (const entry of request.side.pokemon) {
      const parsedCondition = parseConditionText(entry.condition);
      if (entry.active) continue;
      if (parsedCondition.fainted) continue;
      room.legalActions.push({
        id: `switch:${entry.ident}`,
        kind: "switch",
        label: `Switch to ${normalizeIdent(entry.ident).name ?? entry.ident}`,
        moveName: null,
        target: entry.ident,
        pp: null,
        disabled: null,
        details: parsedCondition.hpPercent === null ? null : `${parsedCondition.hpPercent}%`
      });
    }
  }

  if (activeRequest?.canTerastallize || request.side?.canTerastallize) {
    pushRecent(room.notes, "Terastallization is available.");
  }
  room.phase = room.winner ? "finished" : isTeamPreview ? "preview" : "turn";
}

export function roomHasActionableRequest(room) {
  if (!room?.lastRequest || room.lastRequest.wait) return false;
  if (room.lastRequest.teamPreview) return true;
  if (!Array.isArray(room.legalActions) || room.legalActions.length === 0) return false;
  return true;
}

function handleLine(room, line) {
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
      updatePokemonFromDetails(pokemon, details, undefined);
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
      updatePokemonFromDetails(pokemon, details, condition);
      pokemon.active = true;
      side.activeKey = parsedIdent.teamKey;
      for (const [key, mon] of Object.entries(side.team)) {
        if (key !== parsedIdent.teamKey) mon.active = false;
      }
      pushRecent(room.recentLog, `${parsedIdent.name ?? ident} entered the field.`);
      return;
    }
    case "move": {
      const source = ensurePokemon(room, args[0]);
      const moveName = args[1];
      setKnownMove(source, moveName);
      const parsedIdent = normalizeIdent(args[0]);
      pushRecent(room.recentLog, `${parsedIdent.name ?? args[0]} used ${moveName}.`);
      return;
    }
    case "cant": {
      const parsedIdent = normalizeIdent(args[0]);
      const reason = asEffectLabel(args[1]) || "could not move";
      pushRecent(room.recentLog, `${parsedIdent.name ?? args[0]} could not move (${reason}).`);
      return;
    }
    case "faint": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.fainted = true;
      pokemon.hpPercent = 0;
      pokemon.conditionText = "0 fnt";
      pokemon.status = "fnt";
      pokemon.active = false;
      const parsedIdent = normalizeIdent(args[0]);
      pushRecent(room.recentLog, `${parsedIdent.name ?? args[0]} fainted.`);
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
      applyEffectSources(room, pokemon, args, 2);
      const sourceLabel = hpChangeSourceLabel(args, 2);
      if (sourceLabel) {
        const parsedIdent = normalizeIdent(args[0]);
        pushRecent(room.recentLog, `${parsedIdent.name ?? args[0]} had HP change from ${sourceLabel}.`);
      }
      return;
    }
    case "-status": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.status = args[1] ?? pokemon.status;
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
    case "-clearboost":
      ensurePokemon(room, args[0]).boosts = {};
      return;
    case "-clearallboost":
      for (const side of Object.values(room.sides)) {
        for (const mon of Object.values(side.team)) mon.boosts = {};
      }
      return;
    case "-ability": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.ability = asEffectLabel(args[1]);
      return;
    }
    case "-item": {
      const pokemon = ensurePokemon(room, args[0]);
      const nextItem = normalizeKnownString(args[1]) ?? pokemon.item;
      pokemon.item = nextItem;
      if (nextItem) {
        pokemon.removedItem = null;
      }
      return;
    }
    case "-enditem": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.removedItem = normalizeKnownString(args[1]) ?? pokemon.item ?? pokemon.removedItem;
      pokemon.item = null;
      return;
    }
    case "-terastallize": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.terastallized = true;
      pokemon.teraType = args[1] ?? pokemon.teraType;
      const parsedIdent = normalizeIdent(args[0]);
      pushRecent(room.recentLog, `${parsedIdent.name ?? args[0]} Terastallized${pokemon.teraType ? ` into ${pokemon.teraType}` : ""}.`);
      return;
    }
    case "-activate": {
      const pokemon = ensurePokemon(room, args[0]);
      applyEffectSources(room, pokemon, args, 1);
      return;
    }
    case "-formechange": {
      const pokemon = ensurePokemon(room, args[0]);
      pokemon.species = sanitizeSpecies(args[1]);
      return;
    }
    case "-weather":
      room.field.weather = asEffectLabel(args[0]) || null;
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
    default:
      return;
  }
}

function splitProtocolPacket(raw) {
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

export function applyRawFrameToRoomMap(roomMap, rawPacket) {
  const packets = splitProtocolPacket(rawPacket);
  for (const packet of packets) {
    const roomId = packet.roomId;
    if (!roomId || !roomId.startsWith("battle-")) continue;
    const room = roomMap.get(roomId) ?? createEmptyRoomState(roomId);
    for (const line of packet.lines) {
      handleLine(room, line);
    }
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
    terastallized: Boolean(mon.terastallized)
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
    recentLog: [...room.recentLog],
    rawRequestSummary: room.lastRequest
      ? {
          forceSwitch: room.lastRequest.forceSwitch ?? false,
          wait: room.lastRequest.wait ?? false,
          teamPreview: room.lastRequest.teamPreview ?? false,
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
  return {
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
    stats: mergeFiniteStats(previous.stats, next.stats),
    knownMoves: mergeUniqueStrings(previous.knownMoves, next.knownMoves),
    item: next.item ?? previous.item,
    removedItem: next.removedItem ?? previous.removedItem,
    ability: next.ability ?? previous.ability,
    types: mergeUniqueStrings(previous.types, next.types),
    teraType: next.teraType ?? previous.teraType,
    terastallized: Boolean(next.terastallized || previous.terastallized)
  };
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

  const activeKey = next?.activeKey ?? previous?.activeKey ?? null;
  if (activeKey) {
    for (const [teamKey, pokemon] of Object.entries(mergedTeam)) {
      pokemon.active = teamKey === activeKey;
    }
  }

  return {
    slot: next?.slot ?? previous?.slot ?? null,
    name: next?.name ?? previous?.name ?? null,
    team: mergedTeam,
    activeKey
  };
}

export function mergeRoomState(previous, next) {
  if (!previous) return next;
  if (!next) return previous;

  const playerSide = next.playerSide ?? previous.playerSide ?? null;
  const opponentSideId = next.opponentSideId ?? previous.opponentSideId ?? (playerSide === "p1" ? "p2" : playerSide === "p2" ? "p1" : null);

  return {
    ...previous,
    ...next,
    title: next.title ?? previous.title,
    format: next.format ?? previous.format,
    gameType: next.gameType ?? previous.gameType,
    turn: Math.max(previous.turn ?? 0, next.turn ?? 0),
    phase: next.phase && next.phase !== "unknown" ? next.phase : previous.phase,
    winner: next.winner ?? previous.winner,
    playerSide,
    opponentSideId,
    lastRequest: next.lastRequest ?? previous.lastRequest,
    legalActions: next.lastRequest ? [...(next.legalActions ?? [])] : [...(previous.legalActions ?? [])],
    recentLog: next.recentLog?.length ? [...next.recentLog] : [...(previous.recentLog ?? [])],
    notes: next.notes?.length ? [...next.notes] : [...(previous.notes ?? [])],
    sides: {
      p1: mergeSideState(previous.sides?.p1, next.sides?.p1),
      p2: mergeSideState(previous.sides?.p2, next.sides?.p2)
    },
    unownedTeam: {
      ...(previous.unownedTeam ?? {}),
      ...(next.unownedTeam ?? {})
    },
    field: {
      weather: next.hasSupplementalFieldSnapshot ? (next.field?.weather ?? null) : (next.field?.weather ?? previous.field?.weather ?? null),
      terrain: next.hasSupplementalFieldSnapshot ? (next.field?.terrain ?? null) : (next.field?.terrain ?? previous.field?.terrain ?? null),
      pseudoWeather: next.hasSupplementalFieldSnapshot
        ? [...(next.field?.pseudoWeather ?? [])]
        : next.field?.pseudoWeather?.length
          ? [...next.field.pseudoWeather]
          : [...(previous.field?.pseudoWeather ?? [])]
    },
    hasSupplementalFieldSnapshot: Boolean(previous.hasSupplementalFieldSnapshot || next.hasSupplementalFieldSnapshot),
    sideConditions: {
      p1: next.hasSupplementalFieldSnapshot
        ? [...(next.sideConditions?.p1 ?? [])]
        : next.sideConditions?.p1?.length
          ? [...next.sideConditions.p1]
          : [...(previous.sideConditions?.p1 ?? [])],
      p2: next.hasSupplementalFieldSnapshot
        ? [...(next.sideConditions?.p2 ?? [])]
        : next.sideConditions?.p2?.length
          ? [...next.sideConditions.p2]
          : [...(previous.sideConditions?.p2 ?? [])]
    },
    updatedAt: Math.max(previous.updatedAt ?? 0, next.updatedAt ?? 0)
  };
}

export function pickBestSnapshotForTab(tabState) {
  if (!tabState) return null;
  const rooms = [...tabState.rooms.values()].sort(sortByMostRecent);
  const activeRoom = tabState.activeRoomId ? tabState.rooms.get(tabState.activeRoomId) : null;
  const best = activeRoom ?? rooms.find((room) => roomHasActionableRequest(room)) ?? rooms[0] ?? null;
  return roomToSnapshot(best);
}
