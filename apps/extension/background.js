import { applyRawFrameToRoomMap, roomToSnapshot } from "./lib/showdown-parser.js";
import { DEFAULT_SETTINGS, PROVIDER_MODEL_OPTIONS, getSettings, setSettings } from "./lib/storage.js";
import { buildTabSelection, TAB_STATUS } from "./lib/tab-state.js";

const tabStates = new Map();
const CONTENT_BRIDGE_FILE = "content-bridge.js";
const SHOWDOWN_URL_RE = /^https:\/\/(?:play\.)?pokemonshowdown\.com\/?/i;

function isShowdownUrl(url) {
  return typeof url === "string" && SHOWDOWN_URL_RE.test(url);
}

async function refreshActionForTab(tabId, url) {
  if (typeof tabId !== "number") return;
  if (isShowdownUrl(url)) {
    await chrome.action.enable(tabId);
    return;
  }
  await chrome.action.disable(tabId);
}

async function refreshAllTabActions() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => refreshActionForTab(tab.id, tab.url)));
}

function getOrCreateTabState(tabId) {
  let state = tabStates.get(tabId);
  if (!state) {
    state = {
      activeRoomId: null,
      rooms: new Map(),
      lastFrameAt: 0,
      lastFrameData: null,
      lastRoomProtocolByRoomId: new Map(),
      savedReplayRoomIds: new Set(),
      observeTimerId: null,
      lastObservedCapturedAt: null,
      analysisRunSeq: 0,
      activeAnalysisAbortController: null,
      lastAnalysis: null,
      lastLocalIntel: null,
      lastProviderHealth: null,
      lastProviderDebug: null,
      lastError: null,
      lastStatus: TAB_STATUS.NO_SNAPSHOT,
      lastStatusMessage: "No active Showdown battle snapshot was found for this tab yet."
    };
    tabStates.set(tabId, state);
  }
  return state;
}

async function initializeDefaults() {
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...current };
  await chrome.storage.local.set(merged);
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeDefaults();
  void refreshAllTabActions();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshAllTabActions();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const state = tabStates.get(tabId);
  if (state?.observeTimerId) clearTimeout(state.observeTimerId);
  state?.activeAnalysisAbortController?.abort();
  tabStates.delete(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await refreshActionForTab(tabId, tab.url);
  } catch {
    // Ignore transient tab lookup failures.
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!("url" in changeInfo) && changeInfo.status !== "loading" && changeInfo.status !== "complete") return;
  void refreshActionForTab(tabId, changeInfo.url ?? tab.url);
});

async function getActiveBattleSnapshot(tabId) {
  const state = tabStates.get(tabId);
  return buildTabSelection(state).snapshot;
}

async function ensureContentBridge(tabId) {
  if (typeof tabId !== "number") return false;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (response?.ok) return true;
  } catch {
    // Fall through to reinjection.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_BRIDGE_FILE]
    });
  } catch {
    return false;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function broadcastOverlayConfigRefresh() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map(async (tab) => {
        const tabId = tab.id;
        if (typeof tabId !== "number") return;
        const ready = await ensureContentBridge(tabId);
        if (!ready) return;
        try {
          await chrome.tabs.sendMessage(tabId, { type: "refresh-overlay-config" });
        } catch {
          // Ignore tabs without the bridge or without a reachable page context.
        }
      })
  );
}

async function pushOverlaySettingsToTab(tabId, settings) {
  const ready = await ensureContentBridge(tabId);
  if (!ready) return false;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "apply-overlay-settings",
      settings
    });
    return true;
  } catch {
    return false;
  }
}

function providerLabel(provider, model) {
  return `${provider}:${model}`;
}

function modelForProvider(settings, provider, compare = false) {
  if (compare) {
    if (provider === "claude") return settings.compareClaudeModel;
    if (provider === "gemini") return settings.compareGeminiModel;
    return settings.compareCodexModel;
  }
  if (provider === "claude") return settings.claudeModel;
  if (provider === "gemini") return settings.geminiModel;
  return settings.codexModel;
}

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fetchCompanionHealth(settings) {
  try {
    const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}/api/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function runSingleAnalysisRequest(settings, snapshot, provider, model, signal) {
  const url = `${settings.companionUrl.replace(/\/$/, "")}/api/analyze`;
  const requestId = makeRequestId();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      provider,
      model,
      requestId,
      snapshot
    })
  });

  if (!response.ok) {
    let errorPayload = null;
    try {
      errorPayload = await response.json();
    } catch {
      const errorText = await response.text();
      throw new Error(`Companion returned ${response.status}: ${errorText}`);
    }
    const error = new Error(
      `Companion returned ${response.status}: ${typeof errorPayload?.error === "string" ? errorPayload.error : JSON.stringify(errorPayload)}`
    );
    error.localIntel = errorPayload?.localIntel ?? null;
    error.requestId = errorPayload?.requestId ?? requestId;
    error.providerDebug = errorPayload?.providerDebug ?? null;
    throw error;
  }

  const json = await response.json();
  return {
    requestId,
    response: json
  };
}

async function showOverlay(tabId, payload) {
  await chrome.tabs.sendMessage(tabId, {
    type: "show-analysis-overlay",
    payload
  }).catch(() => {});
}

async function pushLocalIntelUpdate(tabId) {
  const selection = buildTabSelection(tabStates.get(tabId));
  const state = getOrCreateTabState(tabId);
  await chrome.tabs.sendMessage(tabId, {
    type: "update-local-intel",
    payload: {
      turn: selection.room?.turn ?? "?",
      status: selection.status,
      localIntel: state.lastLocalIntel ?? null
    }
  }).catch(() => {});
}

async function maybeAutoSaveReplay(tabId, roomId, settingsOverride) {
  if (typeof tabId !== "number" || typeof roomId !== "string" || !roomId.startsWith("battle-")) return;
  const state = getOrCreateTabState(tabId);
  if (state.savedReplayRoomIds.has(roomId)) return;
  const room = state.rooms.get(roomId);
  if (!room || room.phase !== "finished") return;
  const protocol = state.lastRoomProtocolByRoomId.get(roomId);
  if (typeof protocol !== "string" || !protocol.trim()) return;

  const settings = settingsOverride ?? await getSettings();
  if (!settings.autoDownloadReplay) return;

  try {
    const snapshot = roomToSnapshot(room);
    const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}/api/save-replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId,
        format: snapshot.format,
        capturedAt: snapshot.capturedAt,
        protocol
      })
    });
    if (!response.ok) return;
    const json = await response.json();
    if (json?.ok) {
      state.savedReplayRoomIds.add(roomId);
    }
  } catch {
    // Ignore replay-save failures; analysis should still work.
  }
}

function setTabStatus(tabId, selection) {
  const state = getOrCreateTabState(tabId);
  state.lastStatus = selection.status;
  state.lastStatusMessage = selection.message;
  return state;
}

async function observeSnapshotForTab(tabId) {
  const settings = await getSettings();
  const state = getOrCreateTabState(tabId);
  const selection = buildTabSelection(state);
  const snapshot = selection.snapshot;

  if (!snapshot) return;
  if (state.lastObservedCapturedAt === snapshot.capturedAt) return;

  try {
    const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}/api/observe-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot })
    });
    if (!response.ok) return;
    const json = await response.json();
    state.lastObservedCapturedAt = snapshot.capturedAt;
    if (json?.localIntel) {
      state.lastLocalIntel = json.localIntel;
      await pushLocalIntelUpdate(tabId);
    }
  } catch {
    // Ignore observe failures; analysis remains the user-visible path.
  }
}

function scheduleSnapshotObservation(tabId) {
  const state = getOrCreateTabState(tabId);
  if (state.observeTimerId) clearTimeout(state.observeTimerId);
  const selection = buildTabSelection(state);
  const delayMs = selection.snapshot?.phase === "preview" ? 250 : 1200;
  state.observeTimerId = setTimeout(() => {
    state.observeTimerId = null;
    void observeSnapshotForTab(tabId);
  }, delayMs);
}

async function analyzeTab(tabId, options = {}) {
  const forceOverlay = Boolean(options.forceOverlay);
  await ensureContentBridge(tabId);
  const settings = await getSettings();
  const state = getOrCreateTabState(tabId);
  const selection = buildTabSelection(state);
  const snapshot = selection.snapshot;

  if (selection.status !== TAB_STATUS.READY || !snapshot) {
    const state = setTabStatus(tabId, selection);
    state.lastError = selection.message;
    if (settings.showOverlay || forceOverlay) {
      await showOverlay(tabId, {
        providerLabel: "local",
        turn: selection.room?.turn ?? "?",
        status: selection.status,
        localIntel: state.lastLocalIntel ?? null,
        result: {
          summary: selection.message,
          rankedActions: [],
          confidence: "low"
        }
      });
    }
    return {
      ok: false,
      status: selection.status,
      summary: selection.message,
      snapshot
    };
  }

  const provider = settings.provider;
  const model = modelForProvider(settings, provider, false);
  const compareProvider = settings.compareProvider;
  const compareModel = modelForProvider(settings, compareProvider, true);
  const compareMode = Boolean(settings.compareMode && compareProvider && compareModel && (compareProvider !== provider || compareModel !== model));
  setTabStatus(tabId, selection);
  state.lastError = null;
  state.analysisRunSeq += 1;
  const analysisRunId = state.analysisRunSeq;
  state.activeAnalysisAbortController?.abort();
  const abortController = new AbortController();
  state.activeAnalysisAbortController = abortController;
  state.lastProviderHealth = await fetchCompanionHealth(settings);

  if (settings.showOverlay || forceOverlay) {
    await showOverlay(tabId, {
      providerLabel: compareMode ? `compare:${provider}+${compareProvider}` : providerLabel(provider, model),
      turn: snapshot.turn,
      status: "analyzing",
      localIntel: state.lastLocalIntel ?? null,
      snapshot,
      health: state.lastProviderHealth,
      result: {
        summary: compareMode
          ? `Analyzing turn ${snapshot.turn} with ${providerLabel(provider, model)} and ${providerLabel(compareProvider, compareModel)}...`
          : `Analyzing turn ${snapshot.turn} with ${providerLabel(provider, model)}...`,
        rankedActions: [],
        confidence: "low"
      }
    });
  }

  try {
    const requests = [
      { provider, model, kind: "primary" },
      ...(compareMode ? [{ provider: compareProvider, model: compareModel, kind: "compare" }] : [])
    ];
    const settled = await Promise.allSettled(
      requests.map((entry) => runSingleAnalysisRequest(settings, snapshot, entry.provider, entry.model, abortController.signal))
    );
    if (state.analysisRunSeq !== analysisRunId) {
      return { ok: false, status: "superseded", summary: "Superseded by a newer analysis request." };
    }
    const compareResults = settled.map((entry, index) => {
      const request = requests[index];
      if (!request) return null;
      if (entry.status === "fulfilled") {
        const result = entry.value.response;
        return {
          provider: request.provider,
          model: request.model,
          providerLabel: providerLabel(request.provider, request.model),
          requestId: result.requestId ?? entry.value.requestId,
          result: result.analysis,
          localIntel: result.localIntel ?? null,
          providerDebug: result.providerDebug ?? null
        };
      }
      const error = entry.reason;
      return {
        provider: request.provider,
        model: request.model,
        providerLabel: providerLabel(request.provider, request.model),
        requestId: error?.requestId ?? null,
        result: {
          summary: error instanceof Error ? error.message : String(error),
          rankedActions: [],
          confidence: "low"
        },
        localIntel: error?.localIntel ?? null,
        providerDebug: error?.providerDebug ?? null,
        error: error instanceof Error ? error.message : String(error)
      };
    }).filter(Boolean);
    const firstSuccess = compareResults.find((entry) => !entry.error);
    const result = firstSuccess ?? compareResults[0];
    if (!result) {
      throw new Error("No provider response was returned.");
    }
    setTabStatus(tabId, selection);
    state.lastAnalysis = result;
    state.lastLocalIntel = result.localIntel ?? state.lastLocalIntel ?? null;
    state.lastProviderDebug = result.providerDebug ?? null;
    state.lastError = result.error ?? null;
    state.activeAnalysisAbortController = null;

    if (settings.showOverlay || forceOverlay) {
      await showOverlay(tabId, {
        providerLabel: compareMode ? `compare:${provider}+${compareProvider}` : providerLabel(provider, model),
        turn: snapshot.turn,
        status: TAB_STATUS.READY,
        requestId: result.requestId ?? null,
        snapshot,
        localIntel: result.localIntel ?? null,
        providerDebug: result.providerDebug ?? null,
        health: state.lastProviderHealth,
        compareResults: compareResults.length > 1 ? compareResults.map((entry) => ({
          providerLabel: entry.providerLabel,
          requestId: entry.requestId ?? null,
          result: entry.result,
          error: entry.error ?? null,
          providerDebug: entry.providerDebug ?? null
        })) : null,
        result: result.result
      });
    }

    return {
      ok: !result.error,
      status: result.error ? TAB_STATUS.PROVIDER_ERROR : TAB_STATUS.READY,
      snapshot,
      analysis: result.result
    };
  } catch (error) {
    if (abortController.signal.aborted || state.analysisRunSeq !== analysisRunId) {
      return { ok: false, status: "superseded", summary: "Superseded by a newer analysis request." };
    }
    const message = error instanceof Error ? error.message : String(error);
    const state = getOrCreateTabState(tabId);
    state.lastStatus = TAB_STATUS.PROVIDER_ERROR;
    state.lastStatusMessage = message;
    state.lastError = message;
    state.lastProviderDebug = error?.providerDebug ?? null;
    state.activeAnalysisAbortController = null;
    await showOverlay(tabId, {
      providerLabel: compareMode ? `compare:${provider}+${compareProvider}` : providerLabel(provider, model),
      turn: snapshot.turn,
      status: TAB_STATUS.PROVIDER_ERROR,
      localIntel: state.lastLocalIntel ?? null,
      snapshot,
      requestId: error?.requestId ?? null,
      providerDebug: error?.providerDebug ?? null,
      health: state.lastProviderHealth,
      result: {
        summary: message,
        rankedActions: [],
        confidence: "low"
      }
    });
    return { ok: false, status: TAB_STATUS.PROVIDER_ERROR, error: message, summary: message };
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "analyze-current-turn") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const ready = await ensureContentBridge(tab.id);
  if (!ready) return;
  await chrome.tabs.sendMessage(tab.id, { type: "toggle-overlay-windows" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "showdown-frame") {
    const tabId = sender.tab?.id;
    const rawData = message.payload?.data;
    if (typeof tabId !== "number" || typeof rawData !== "string") {
      sendResponse({ ok: false });
      return;
    }
    const state = getOrCreateTabState(tabId);
    const now = Date.now();
    if (state.lastFrameData === rawData && now - state.lastFrameAt < 1500) {
      sendResponse({ ok: true, deduped: true });
      return true;
    }
    state.lastFrameData = rawData;
    state.lastFrameAt = now;
    applyRawFrameToRoomMap(state.rooms, rawData);
    scheduleSnapshotObservation(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "showdown-active-room") {
    const tabId = sender.tab?.id;
    const roomId = message.payload?.roomId;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false });
      return true;
    }
    const state = getOrCreateTabState(tabId);
    state.activeRoomId = typeof roomId === "string" && roomId.startsWith("battle-") ? roomId : null;
    scheduleSnapshotObservation(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "showdown-room-protocol-snapshot") {
    const tabId = sender.tab?.id;
    const roomId = message.payload?.roomId;
    const rawData = message.payload?.data;
    if (typeof tabId !== "number" || typeof roomId !== "string" || typeof rawData !== "string") {
      sendResponse({ ok: false });
      return true;
    }
    const state = getOrCreateTabState(tabId);
    if (state.lastRoomProtocolByRoomId.get(roomId) === rawData) {
      sendResponse({ ok: true, deduped: true });
      return true;
    }
    state.lastRoomProtocolByRoomId.set(roomId, rawData);
    const nextRooms = new Map(state.rooms);
    nextRooms.delete(roomId);
    applyRawFrameToRoomMap(nextRooms, rawData);
    state.rooms = nextRooms;
    if (!state.activeRoomId && typeof message.payload?.roomSlot === "string") {
      state.activeRoomId = roomId;
    }
    scheduleSnapshotObservation(tabId);
    void getSettings().then((settings) => maybeAutoSaveReplay(tabId, roomId, settings));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "get-settings") {
    void getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (message.type === "save-settings") {
    void (async () => {
      const settings = await setSettings(message.payload ?? {});
      await broadcastOverlayConfigRefresh();
      sendResponse({ ok: true, settings });
    })();
    return true;
  }

  if (message.type === "push-overlay-settings") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "No tab id available." });
      return true;
    }
    void (async () => {
      const current = await getSettings();
      const settings = { ...current, ...(message.settings ?? {}) };
      const pushed = await pushOverlaySettingsToTab(tabId, settings);
      sendResponse({ ok: pushed });
    })();
    return true;
  }

  if (message.type === "get-overlay-config") {
    void getSettings().then((settings) =>
      sendResponse({
        ok: true,
        settings,
        providerModelOptions: PROVIDER_MODEL_OPTIONS
      })
    );
    return true;
  }

  if (message.type === "get-latest-state") {
    const tabId = sender.tab?.id ?? message.tabId;
    void (async () => {
      if (typeof tabId === "number") {
        await ensureContentBridge(tabId);
      }
      const selection = typeof tabId === "number"
        ? buildTabSelection(tabStates.get(tabId))
        : { status: TAB_STATUS.NO_SNAPSHOT, snapshot: null, message: "No active tab id was available." };
      sendResponse({
        ok: true,
        snapshot: selection.snapshot ?? null,
        status: selection.status,
        message: selection.message,
        roomId: selection.room?.roomId ?? null
      });
    })();
    return true;
  }

  if (message.type === "analyze-current-state") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "No tab id available." });
      return true;
    }
    void analyzeTab(tabId, { forceOverlay: Boolean(message.forceOverlay) }).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === "get-last-analysis") {
    const tabId = sender.tab?.id ?? message.tabId;
    const state = typeof tabId === "number" ? tabStates.get(tabId) : null;
    sendResponse({
      ok: true,
      analysis: state?.lastAnalysis ?? null,
      localIntel: state?.lastLocalIntel ?? null,
      error: state?.lastError ?? null,
      status: state?.lastStatus ?? TAB_STATUS.NO_SNAPSHOT,
      message: state?.lastStatusMessage ?? "No active Showdown battle snapshot was found for this tab yet."
    });
    return true;
  }

  if (message.type === "companion-health") {
    void (async () => {
      const settings = await getSettings();
      try {
        const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}/api/health`);
        const json = await response.json();
        sendResponse({ ok: true, health: json });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true;
  }
});
