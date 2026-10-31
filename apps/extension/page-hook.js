(() => {
  const SOURCE = "showdnass";
  const PAGE_HOOK_VERSION = "2026-10-22-hook-8";
  if (window.__showdownSecondOpinionHookVersion === PAGE_HOOK_VERSION) return;
  window.__showdownSecondOpinionHookInstalled = true;
  window.__showdownSecondOpinionHookVersion = PAGE_HOOK_VERSION;
  let lastRoomId = null;
  const captureId = window.crypto.randomUUID();
  let sequence = 0;
  const lastProtocolByRoomId = new Map();

  function observationMetadata() {
    sequence += 1;
    return { observationId: `${captureId}:${sequence}`, captureId, sequence };
  }

  function emit(direction, url, data) {
    window.postMessage(
      {
        source: SOURCE,
        kind: "websocket-frame",
        ...observationMetadata(),
        direction,
        url,
        data,
        timestamp: Date.now()
      },
      "*"
    );
  }

  // The two clients expose different application roots but share the battle
  // protocol. Keep private client access here; WebSocket capture is independent.
  function clientAdapter() {
    const preact = window.PS?.rooms && typeof window.PS.receive === "function" ? window.PS : null;
    const root = preact ?? window.app ?? null;
    const kind = preact ? "preact" : root ? "legacy" : "protocol-only";
    return {
      kind,
      root,
      isAmbiguous() {
        return kind === "legacy" && root.curRoom?.id?.startsWith("battle-") && root.curSideRoom?.id?.startsWith("battle-")
          && root.curRoom.id !== root.curSideRoom.id;
      },
      getActiveRoomId() {
        if (this.isAmbiguous()) return null;
        const focused = preact ? root.room : root?.curRoom;
        const room = focused?.id?.startsWith("battle-") ? focused : preact ? root.baseRoom : root?.curSideRoom;
        return room?.id?.startsWith("battle-") ? room.id : null;
      },
      listBattleRooms() {
        return Object.values(root?.rooms ?? {}).filter((room) => room?.id?.startsWith("battle-"));
      }
    };
  }

  function detectActiveRoomId() {
    try {
      return clientAdapter().getActiveRoomId();
    } catch {
      return null;
    }
  }

  function emitActiveRoom() {
    const roomId = detectActiveRoomId();
    const ambiguous = Boolean(clientAdapter().isAmbiguous());
    const selection = `${roomId ?? ""}|${ambiguous}`;
    if (selection === lastRoomId) return;
    lastRoomId = selection;
    window.postMessage(
      {
        source: SOURCE,
        kind: "active-room",
        roomId,
        ambiguous,
        captureId,
        timestamp: Date.now()
      },
      "*"
    );
  }

  function roomSideLabelToSlot(label) {
    if (typeof label !== "string") return null;
    const normalized = label.toLowerCase();
    if (normalized === "p1" || normalized === "p2") return normalized;
    return null;
  }

  function normalizeOptionalString(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  function sanitizeStats(stats) {
    if (!stats || typeof stats !== "object") return undefined;
    const next = {};
    for (const [key, value] of Object.entries(stats)) {
      if (Number.isFinite(value)) {
        next[key] = Number(value);
      }
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  function sanitizeBoosts(boosts) {
    if (!boosts || typeof boosts !== "object") return undefined;
    const next = {};
    for (const [key, value] of Object.entries(boosts)) {
      if (Number.isFinite(value)) {
        next[key] = Number(value);
      }
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  function buildConditionFromBattlePokemon(entry) {
    const condition = normalizeOptionalString(entry?.condition);
    if (condition) return condition;
    const hp = Number(entry?.hp);
    const maxhp = Number(entry?.maxhp);
    const status = normalizeOptionalString(entry?.status);
    const fainted = Boolean(entry?.fainted) || (Number.isFinite(hp) && hp <= 0);
    if (Number.isFinite(hp) && Number.isFinite(maxhp) && maxhp > 0) {
      const suffix = fainted ? " fnt" : status ? ` ${status}` : "";
      return `${Math.max(0, Math.round(hp))}/${Math.round(maxhp)}${suffix}`;
    }
    return fainted ? "0 fnt" : status ? `100/100 ${status}` : null;
  }

  function sanitizeBattlePokemon(entry, side) {
    if (!entry || typeof entry !== "object") return null;
    const ident = normalizeOptionalString(entry.ident);
    const details = normalizeOptionalString(entry.details)
      ?? (normalizeOptionalString(entry.speciesForme)
        ? `${entry.speciesForme}${Number.isFinite(entry.level) ? `, L${Number(entry.level)}` : ""}`
        : null);
    if (!ident && !details) return null;
    const condition = buildConditionFromBattlePokemon(entry);
    const pokemon = {
      ident,
      details,
      condition,
      active: Boolean(entry.active),
      level: Number.isFinite(entry.level) ? Number(entry.level) : undefined,
      stats: sanitizeStats(entry.stats),
      boosts: sanitizeBoosts(entry.boosts),
      moves: Array.isArray(entry.moves)
        ? entry.moves.map((move) => normalizeOptionalString(move)).filter(Boolean)
        : undefined,
      item: normalizeOptionalString(entry.item),
      ability: normalizeOptionalString(entry.ability),
      baseAbility: normalizeOptionalString(entry.baseAbility),
      teraType: normalizeOptionalString(entry.teraType),
      terastallized: Boolean(entry.terastallized)
    };
    if (side) pokemon.side = side;
    return pokemon;
  }

  function normalizeEffectList(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeOptionalString(entry)).filter(Boolean);
    }
    if (value && typeof value === "object") {
      return Object.keys(value).map((entry) => normalizeOptionalString(entry)).filter(Boolean);
    }
    return [];
  }

  function mergeSupplementalPokemon(existing, next) {
    if (!existing) return next;
    if (!next) return existing;
    return {
      ...existing,
      ...next,
      side: next.side ?? existing.side,
      ident: next.ident ?? existing.ident,
      details: next.details ?? existing.details,
      condition: next.condition ?? existing.condition,
      active: Boolean(next.active || existing.active),
      level: next.level ?? existing.level,
      stats: next.stats ? { ...(existing.stats ?? {}), ...next.stats } : existing.stats,
      boosts: next.boosts ? { ...(existing.boosts ?? {}), ...next.boosts } : existing.boosts,
      moves: next.moves?.length ? [...new Set([...(existing.moves ?? []), ...next.moves])] : existing.moves,
      item: next.item ?? existing.item,
      ability: next.ability ?? existing.ability,
      baseAbility: next.baseAbility ?? existing.baseAbility,
      teraType: next.teraType ?? existing.teraType,
      terastallized: Boolean(next.terastallized || existing.terastallized)
    };
  }

  function supplementalPokemonKey(entry) {
    return entry?.ident ?? `${entry?.side ?? "?"}:${entry?.details ?? "unknown"}`;
  }

  function pushSupplementalPokemon(collection, entry, sideId = null) {
    const sanitized = sanitizeBattlePokemon(entry, sideId);
    if (!sanitized) return;
    const key = supplementalPokemonKey(sanitized);
    collection.set(key, mergeSupplementalPokemon(collection.get(key), sanitized));
  }

  function sideSnapshotCandidate(sideLike, fallbackSideId = null) {
    if (!sideLike || typeof sideLike !== "object") return null;
    const sideId = roomSideLabelToSlot(sideLike.sideid) ?? roomSideLabelToSlot(sideLike.id) ?? fallbackSideId;
    const pokemon = Array.isArray(sideLike.pokemon) ? sideLike.pokemon : [];
    if (!sideId && pokemon.length === 0) return null;
    return {
      sideId,
      name: normalizeOptionalString(sideLike.name),
      pokemon,
      sideConditions: normalizeEffectList(sideLike.sideConditions ?? sideLike.conditions)
    };
  }

  function buildSupplementalBattleState(room) {
    if (!room || typeof room !== "object") return null;
    const playerSide = roomSideLabelToSlot(room.request?.side?.id)
      ?? roomSideLabelToSlot(room.side?.id)
      ?? roomSideLabelToSlot(room.battle?.mySide?.sideid)
      ?? roomSideLabelToSlot(room.battle?.mySide?.id);
    const opponentSide = playerSide === "p1" ? "p2" : playerSide === "p2" ? "p1" : null;
    const pokemon = new Map();
    const sideNames = {};
    const sideConditions = {};

    const pushSideCandidate = (candidate) => {
      if (!candidate) return;
      if (candidate.sideId && candidate.name) sideNames[candidate.sideId] = candidate.name;
      if (candidate.sideId && candidate.sideConditions.length > 0) {
        sideConditions[candidate.sideId] = [...new Set(candidate.sideConditions)];
      }
      for (const entry of candidate.pokemon) {
        pushSupplementalPokemon(pokemon, entry, candidate.sideId);
      }
    };

    if (Array.isArray(room.battle?.myPokemon)) {
      for (const entry of room.battle.myPokemon) pushSupplementalPokemon(pokemon, entry, playerSide);
    }
    if (Array.isArray(room.battle?.yourPokemon)) {
      for (const entry of room.battle.yourPokemon) pushSupplementalPokemon(pokemon, entry, opponentSide);
    }
    pushSideCandidate(sideSnapshotCandidate(room.side, playerSide));

    pushSideCandidate(sideSnapshotCandidate(room.battle?.mySide, playerSide));
    pushSideCandidate(sideSnapshotCandidate(room.battle?.yourSide, opponentSide));
    pushSideCandidate(sideSnapshotCandidate(room.battle?.nearSide));
    pushSideCandidate(sideSnapshotCandidate(room.battle?.farSide));

    if (Array.isArray(room.battle?.sides)) {
      for (const sideLike of room.battle.sides) {
        pushSideCandidate(sideSnapshotCandidate(sideLike));
      }
    }

    const field = {
      weather: normalizeOptionalString(room.battle?.weather),
      terrain: normalizeOptionalString(room.battle?.terrain),
      pseudoWeather: normalizeEffectList(room.battle?.pseudoWeather),
      yourSideConditions: playerSide ? sideConditions[playerSide] ?? [] : [],
      opponentSideConditions: opponentSide ? sideConditions[opponentSide] ?? [] : []
    };

    if (!playerSide && pokemon.size === 0) return null;
    return {
      playerSide,
      sideNames,
      pokemon: [...pokemon.values()],
      field
    };
  }

  function buildBattleProtocolSnapshot(room) {
    if (!room || typeof room.id !== "string" || !room.id.startsWith("battle-")) return null;
    const stepQueue = Array.isArray(room.battle?.stepQueue) ? room.battle.stepQueue.filter((line) => typeof line === "string") : [];
    const request = room.request && typeof room.request === "object" ? room.request : null;
    const supplementalState = buildSupplementalBattleState(room);
    const lines = [...stepQueue];
    if (request) {
      lines.push(`|request|${JSON.stringify(request)}`);
    }
    if (supplementalState) {
      lines.push(`|sso-state|${JSON.stringify(supplementalState)}`);
    }
    if (lines.length === 0) return null;
    return `>${room.id}\n${lines.join("\n")}`;
  }

  function emitBattleProtocolSnapshots() {
    try {
      const adapter = clientAdapter();

      const seenRoomIds = new Set();
      for (const room of adapter.listBattleRooms()) {
        if (!room || typeof room !== "object") continue;
        if (typeof room.id !== "string" || !room.id.startsWith("battle-")) continue;
        const protocol = buildBattleProtocolSnapshot(room);
        if (!protocol) continue;
        seenRoomIds.add(room.id);
        if (lastProtocolByRoomId.get(room.id) === protocol) continue;
        lastProtocolByRoomId.set(room.id, protocol);
        window.postMessage(
          {
            source: SOURCE,
            kind: "room-protocol-snapshot",
            ...observationMetadata(),
            clientKind: adapter.kind,
            roomId: room.id,
            roomSlot: roomSideLabelToSlot(room.request?.side?.id) ?? roomSideLabelToSlot(room.side?.id) ?? roomSideLabelToSlot(room.battle?.mySide?.sideid) ?? roomSideLabelToSlot(room.battle?.mySide?.id) ?? null,
            data: protocol,
            timestamp: Date.now()
          },
          "*"
        );
      }

      for (const roomId of [...lastProtocolByRoomId.keys()]) {
        if (!seenRoomIds.has(roomId)) {
          lastProtocolByRoomId.delete(roomId);
        }
      }
    } catch (error) {
      console.warn("[SSO] failed to emit room protocol snapshot", error);
    }
  }

  function wrapFunction(target, key, wrapper) {
    if (!target || typeof target[key] !== "function") return false;
    if (target[key].__ssoHookVersion === PAGE_HOOK_VERSION) return true;

    const original = target[key];
    const wrapped = wrapper(original);
    wrapped.__ssoWrapped = true;
    wrapped.__ssoHookVersion = PAGE_HOOK_VERSION;
    target[key] = wrapped;
    return true;
  }

  function installAppHooks() {
    try {
      const adapter = clientAdapter();
      const app = adapter.root;
      if (!app) return;

      wrapFunction(app, "receive", (original) => function receiveHook(data, ...rest) {
        try {
          if (typeof data === "string") {
            emit("in", `${adapter.kind}.receive`, data);
            emitActiveRoom();
          }
        } catch (error) {
          console.warn("[SSO] failed to emit app.receive payload", error);
        }
        return original.call(this, data, ...rest);
      });

      wrapFunction(app, "send", (original) => function sendHook(data, ...rest) {
        try {
          if (typeof data === "string") {
            // app.send(data, roomId) prefixes the room itself; forward the wire line. The SockJS socket
            // bypasses the WebSocket wrapper, so this is the only path for human choices.
            const room = rest[0];
            emit("out", `${adapter.kind}.send`, typeof room === "string" && room && room !== "lobby" ? `${room}|${data}` : data);
          }
        } catch (error) {
          console.warn("[SSO] failed to emit app.send payload", error);
        }
        return original.call(this, data, ...rest);
      });

    } catch (error) {
      console.warn("[SSO] failed to install app hooks", error);
    }
  }

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) {
    window.setInterval(installAppHooks, 1000);
    window.setTimeout(installAppHooks, 250);
    return;
  }

  function InstrumentedWebSocket(url, protocols) {
    const ws = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);

    try {
      const originalSend = ws.send.bind(ws);
      ws.send = (data) => {
        try {
          emit("out", url, data);
        } catch (error) {
          console.warn("[SSO] failed to emit outgoing WS frame", error);
        }
        return originalSend(data);
      };

      ws.addEventListener("message", (event) => {
        try {
          // Existing sockets are captured through receive; newly instrumented
          // sockets use this fallback only if receive could not be wrapped.
          // This avoids treating one server frame as two observations.
          if (!clientAdapter().root?.receive?.__ssoWrapped) emit("in", url, event.data);
          emitActiveRoom();
        } catch (error) {
          console.warn("[SSO] failed to emit incoming WS frame", error);
        }
      });
    } catch (error) {
      console.warn("[SSO] failed to instrument websocket", error);
    }

    return ws;
  }

  InstrumentedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(InstrumentedWebSocket, NativeWebSocket);
  window.WebSocket = InstrumentedWebSocket;

  // The background asks for this when it has no history for a battle (its service worker restarted, or the page loaded
  // mid-battle): replay each battle's full client log once, as Showdown would on joining, so state rebuilds from |init|.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data?.kind !== "bootstrap-request") return;
    try {
      // One room only when the background names it: replaying every open battle restarted healthy advisors too.
      const only = typeof event.data.roomId === "string" ? event.data.roomId : null;
      for (const room of clientAdapter().listBattleRooms()) {
        if (only && room.id !== only) continue;
        const log = Array.isArray(room.battle?.stepQueue) ? room.battle.stepQueue.filter((line) => typeof line === "string") : [];
        if (!log.length) continue;
        const request = room.request && typeof room.request === "object" ? [`|request|${JSON.stringify(room.request)}`] : [];
        emit("in", "bootstrap", `>${room.id}\n|init|battle\n${[...log, ...request].join("\n")}`);
      }
    } catch (error) {
      console.warn("[SSO] failed to emit bootstrap", error);
    }
  });
  window.addEventListener("hashchange", emitActiveRoom);
  window.addEventListener("popstate", emitActiveRoom);
  window.setInterval(installAppHooks, 1000);
  window.setInterval(emitActiveRoom, 1000);
  window.setInterval(emitBattleProtocolSnapshots, 1500);
  // Chrome may stop the extension service worker mid-battle and drop its captured state; re-send each battle
  // snapshot periodically so the background rebuilds within seconds (unchanged snapshots are no-ops downstream).
  window.setInterval(() => { lastProtocolByRoomId.clear(); emitBattleProtocolSnapshots(); }, 15000);
  window.setTimeout(installAppHooks, 250);
  window.setTimeout(emitActiveRoom, 250);
  window.setTimeout(emitBattleProtocolSnapshots, 500);
})();
