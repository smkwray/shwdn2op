(() => {
  const SOURCE = "showdnass";
  if (window.__showdownSecondOpinionHookInstalled) return;
  window.__showdownSecondOpinionHookInstalled = true;
  let lastRoomId = null;
  let hooksInstalled = false;
  const lastProtocolByRoomId = new Map();

  function emit(direction, url, data) {
    window.postMessage(
      {
        source: SOURCE,
        kind: "websocket-frame",
        direction,
        url,
        data,
        timestamp: Date.now()
      },
      "*"
    );
  }

  function detectActiveRoomId() {
    try {
      return window.app?.curRoom?.id ?? null;
    } catch {
      return null;
    }
  }

  function emitActiveRoom() {
    const roomId = detectActiveRoomId();
    if (roomId === lastRoomId) return;
    lastRoomId = roomId;
    window.postMessage(
      {
        source: SOURCE,
        kind: "active-room",
        roomId,
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

  function sanitizeBattlePokemon(entry) {
    if (!entry || typeof entry !== "object") return null;
    const ident = normalizeOptionalString(entry.ident);
    const details = normalizeOptionalString(entry.details)
      ?? (normalizeOptionalString(entry.speciesForme)
        ? `${entry.speciesForme}${Number.isFinite(entry.level) ? `, L${Number(entry.level)}` : ""}`
        : null);
    if (!ident && !details) return null;
    const condition = buildConditionFromBattlePokemon(entry);
    return {
      ident,
      details,
      condition,
      active: Boolean(entry.active),
      level: Number.isFinite(entry.level) ? Number(entry.level) : undefined,
      stats: sanitizeStats(entry.stats),
      moves: Array.isArray(entry.moves)
        ? entry.moves.map((move) => normalizeOptionalString(move)).filter(Boolean)
        : undefined,
      item: normalizeOptionalString(entry.item),
      ability: normalizeOptionalString(entry.ability),
      baseAbility: normalizeOptionalString(entry.baseAbility),
      teraType: normalizeOptionalString(entry.teraType),
      terastallized: Boolean(entry.terastallized)
    };
  }

  function buildSupplementalBattleState(room) {
    if (!room || typeof room !== "object") return null;
    const playerSide = roomSideLabelToSlot(room.request?.side?.id)
      ?? roomSideLabelToSlot(room.battle?.mySide?.sideid)
      ?? roomSideLabelToSlot(room.battle?.mySide?.id);
    const myPokemon = Array.isArray(room.battle?.myPokemon)
      ? room.battle.myPokemon.map((entry) => sanitizeBattlePokemon(entry)).filter(Boolean)
      : [];
    if (!playerSide && myPokemon.length === 0) return null;
    return {
      playerSide,
      myPokemon
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
      const rooms = window.app?.rooms;
      if (!rooms || typeof rooms !== "object") return;

      const seenRoomIds = new Set();
      for (const room of Object.values(rooms)) {
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
            roomId: room.id,
            roomSlot: roomSideLabelToSlot(room.request?.side?.id) ?? roomSideLabelToSlot(room.battle?.mySide?.sideid) ?? roomSideLabelToSlot(room.battle?.mySide?.id) ?? null,
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
    if (target[key].__ssoWrapped) return true;

    const original = target[key];
    const wrapped = wrapper(original);
    wrapped.__ssoWrapped = true;
    target[key] = wrapped;
    return true;
  }

  function installAppHooks() {
    try {
      const app = window.app;
      if (!app) return;

      const receiveWrapped = wrapFunction(app, "receive", (original) => function receiveHook(data, ...rest) {
        try {
          if (typeof data === "string") {
            emit("in", "app.receive", data);
            emitActiveRoom();
          }
        } catch (error) {
          console.warn("[SSO] failed to emit app.receive payload", error);
        }
        return original.call(this, data, ...rest);
      });

      const sendWrapped = wrapFunction(app, "send", (original) => function sendHook(data, ...rest) {
        try {
          if (typeof data === "string") {
            emit("out", "app.send", data);
          }
        } catch (error) {
          console.warn("[SSO] failed to emit app.send payload", error);
        }
        return original.call(this, data, ...rest);
      });

      hooksInstalled = hooksInstalled || receiveWrapped || sendWrapped;
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
          emit("in", url, event.data);
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

  window.addEventListener("hashchange", emitActiveRoom);
  window.addEventListener("popstate", emitActiveRoom);
  window.setInterval(installAppHooks, 1000);
  window.setInterval(emitActiveRoom, 1000);
  window.setInterval(emitBattleProtocolSnapshots, 1500);
  window.setTimeout(installAppHooks, 250);
  window.setTimeout(emitActiveRoom, 250);
  window.setTimeout(emitBattleProtocolSnapshots, 500);
})();
