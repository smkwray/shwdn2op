import { outgoingBattleEvents, currentMetamonAdvice } from "./lib/metamon.js";
import { splitProtocolPacket, roomToSnapshot } from "./lib/showdown-parser.js";
import { DEFAULT_SETTINGS, PROVIDER_MODEL_OPTIONS, getSettings, setSettings } from "./lib/storage.js";
import { buildTabSelection, TAB_STATUS } from "./lib/tab-state.js";
import { createDecisionIdentity, hashCanonical, sameDecision as sameBaseDecision } from "./lib/decision-identity.js";
import { displayIntel } from "./lib/staged-intel.js";

function sameDecision(left, right) {
  return sameBaseDecision(left, right) && left.stateRevision === right.stateRevision && left.requestKind === right.requestKind;
}

async function identityForSnapshot(state, snapshot) {
  const identity = state.roomIdentities.get(snapshot.roomId);
  return sameBaseDecision(identity, await createDecisionIdentity(snapshot)) ? identity : null;
}

const tabStates = new Map();
const WORKER_STARTED_AT = Date.now();
let lastStatusReportAt = 0;
const CONTENT_BRIDGE_FILE = "content-bridge.js";
const SHOWDOWN_URL_RE = /^https:\/\/(?:play\.)?pokemonshowdown\.com\/?/i;

function isShowdownUrl(url) {
  return typeof url === "string" && SHOWDOWN_URL_RE.test(url);
}

async function refreshActionForTab(tabId, url) {
  if (typeof tabId !== "number") return;
  // Best effort: the tab can close in between, and Vivaldi reports panel/internal tabs that chrome.action cannot
  // address ("No tab with id"). Toolbar state never affects capture or advice.
  try {
    if (isShowdownUrl(url)) await chrome.action.enable(tabId);
    else await chrome.action.disable(tabId);
  } catch {}
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
      activeRoomAmbiguous: false,
      captureSession: makeRequestId(),
      rooms: new Map(),
      roomIdentities: new Map(),
      historyRevision: null,
      evaluatingDecisions: new Set(),
      observationSequence: 0,
      observationIds: new Set(),
      pendingObservations: [],
      pendingMetamonEvents: [],
      metamonSequence: 0,
      metamonAdvice: null,
      metamonTimerId: null,
      flushPromise: null,
      captureError: null,
      lastEnvelope: null,
      lastRoomProtocolByRoomId: new Map(),
      savedReplayRoomIds: new Set(),
      observeTimerId: null,
      retryTimerId: null,
      lastLocalIntelIdentity: null,
      lastAnalysisIdentity: null,
      captureRevision: 0,
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
  void reattachShowdownTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshAllTabActions();
  void reattachShowdownTabs();
});

const PAGE_HOOK_FILE = "page-hook.js";
const SHOWDOWN_TAB_PATTERNS = ["https://play.pokemonshowdown.com/*", "https://pokemonshowdown.com/*"];
// Reloading or updating the extension orphans the content bridge in every open Showdown tab, while the page hook (page
// world) keeps capturing; refreshing a tab mid-battle could cost the player their seat. Re-inject the bridge where none
// answers (and the hook only where the page has none); the new bridge retires the orphan and asks the hook to replay
// each battle from |init|, so advice resumes without a page refresh. Returns the tab IDs whose bridge answers.
async function reattachShowdownTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: SHOWDOWN_TAB_PATTERNS }); } catch { return []; }
  const ready = await Promise.all(tabs.map(async (tab) => {
    if (typeof tab.id !== "number" || tab.discarded) return null;
    try {
      const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => window.__showdownSecondOpinionHookVersion ?? null });
      if (!probe?.result) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: [PAGE_HOOK_FILE] });
    } catch {
      // A tab that cannot be scripted (crashed, still loading an error page) keeps its manifest scripts on next load.
    }
    return await ensureContentBridge(tab.id) ? tab.id : null;
  }));
  return ready.filter((id) => id !== null);
}

chrome.tabs.onRemoved.addListener((tabId) => resetTabState(tabId));

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await refreshActionForTab(tabId, tab.url);
  } catch {
    // Ignore transient tab lookup failures.
  }
});

function resetTabState(tabId) {
  const state = tabStates.get(tabId);
  if (state?.observeTimerId) clearTimeout(state.observeTimerId);
  if (state?.retryTimerId) clearTimeout(state.retryTimerId);
  state?.activeAnalysisAbortController?.abort();
  void closeMetamonTab(state);
  tabStates.delete(tabId);
}

// A tab's captured state belongs to one page instance (the page hook's captureId). Showdown changes its URL with
// history.pushState on every room switch and battle start, and Chrome reports that as status "loading": resetting there
// dropped each new battle's |init| mid-flush and sent "leave" for every open battle, so a new battle never
// reached the companion. A real reload is a new page hook, hence a new captureId.
function stateForCapture(tabId, captureId) {
  let state = getOrCreateTabState(tabId);
  if (typeof captureId !== "string" || !captureId) return state;
  if (state.pageCaptureId && state.pageCaptureId !== captureId) { resetTabState(tabId); state = getOrCreateTabState(tabId); }
  state.pageCaptureId = captureId;
  return state;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Leaving Showdown ends the page's battles; in-app navigation (pushState) does not.
  if (changeInfo.status === "loading" && typeof changeInfo.url === "string" && !isShowdownUrl(changeInfo.url)) resetTabState(tabId);
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

async function runSingleAnalysisRequest(settings, snapshot, provider, model, analysisMode, signal, requestContext, decisionIdentity) {
  const url = `${settings.companionUrl.replace(/\/$/, "")}/api/analyze`;
  const requestId = makeRequestId();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      provider,
      model,
      analysisMode,
      requestId,
      decisionIdentity,
      requestContext,
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
  if (!sameBaseDecision(json.decisionIdentity, decisionIdentity)) {
    throw new Error("Companion returned a different decision identity.");
  }
  return {
    requestId,
    response: json
  };
}

async function isCurrentDecision(tabId, state, identity, allowStale = false) {
  if (tabStates.get(tabId) !== state || state.pendingObservations.length || state.captureError) return false;
  const revision = state.captureRevision;
  const selection = buildTabSelection(state);
  if (!selection.snapshot || selection.status === TAB_STATUS.ROOM_AMBIGUOUS
    || (!allowStale && selection.status === TAB_STATUS.STALE_SNAPSHOT)) return false;
  const current = await identityForSnapshot(state, selection.snapshot);
  return tabStates.get(tabId) === state && state.captureRevision === revision && sameDecision(identity, current);
}

async function showOverlay(tabId, payload) {
  if (payload.snapshot) {
    const state = tabStates.get(tabId);
    const identity = state ? await identityForSnapshot(state, payload.snapshot) : null;
    if (!state || !await isCurrentDecision(tabId, state, identity, payload.analysisMode === "strategic")) return;
    payload = { ...payload, decisionIdentity: identity, captureSession: state.captureSession, captureRevision: state.captureRevision };
  }
  await chrome.tabs.sendMessage(tabId, {
    type: "show-analysis-overlay",
    payload
  }).catch(() => {});
}

// Whether the shown decision may stay on screen (marked updating) while newer frames or history are checked. Every
// frame used to blank it until a fresh evaluation landed, so chat, timer, spectator and other battles' frames made the
// pick and notes vanish and come back. It is replaced at once when a
// different decision is known: a captured request with another rqid, or an acknowledged identity whose request or legal
// actions differ. Within the same request, damage and speed may depend on the new state, so they are re-evaluated and
// replaced when that result arrives.
export function keepShownDecision(state, shown, current) {
  if (!shown || !current || shown.roomId !== current.roomId || shown.rqid !== current.rqid
    || shown.requestKind !== current.requestKind || shown.legalActionSetHash !== current.legalActionSetHash) return false;
  return !state.pendingObservations.some((o) => o.source === "protocol" && o.roomId === shown.roomId && carriesNewRequest(o.data, shown.rqid));
}

function carriesNewRequest(data, rqid) {
  const line = String(data).split("\n").find((l) => l.startsWith("|request|"));
  if (line === undefined) return false;
  try { return JSON.parse(line.slice(9))?.rqid !== rqid; } catch { return true; }
}

async function pushLocalIntelUpdate(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return;
  const revision = state.captureRevision;
  const selection = buildTabSelection(state);
  const decisionIdentity = selection.snapshot ? await identityForSnapshot(state, selection.snapshot) : null;
  if (tabStates.get(tabId) !== state || state.captureRevision !== revision) return;
  const displayable = !state.captureError && selection.status !== TAB_STATUS.ROOM_AMBIGUOUS && selection.status !== TAB_STATUS.STALE_SNAPSHOT;
  if (selection.status === TAB_STATUS.STALE_SNAPSHOT && selection.room && !selection.room.winner) {
    requestBootstrap(tabId, state, selection.room.roomId, 10000);
    scheduleCaptureRetry(tabId, state);
  }
  state.lastStatus = selection.status;
  state.lastStatusMessage = selection.message;
  // Stale-while-revalidate: the shown decision stays up until a different decision is known, then is replaced.
  const shown = state.lastLocalIntelIdentity;
  const exact = sameDecision(shown, decisionIdentity) && state.lastEnvelope?.semantic.historyRevision === state.historyRevision;
  if (!displayable || !keepShownDecision(state, shown, decisionIdentity)) {
    state.lastLocalIntel = null;
    state.lastLocalIntelIdentity = null;
    state.lastEnvelope = null;
    state.staleIntel = null;
  }
  if (!displayable || !sameDecision(state.lastAnalysisIdentity, decisionIdentity)) {
    state.lastAnalysis = null;
    state.lastAnalysisIdentity = null;
  }
  // Each section shows as soon as its stage is ready; a section not yet recomputed for a newer view of the same decision
  // stays (stale, marked updating) and a new decision clears them all.
  const view = displayIntel(displayable ? state.lastEnvelope : null, state.staleIntel);
  state.shownIntel = view.localIntel;
  await chrome.tabs.sendMessage(tabId, {
    type: "update-local-intel",
    payload: {
      turn: selection.room?.turn ?? "?",
      status: selection.status,
      message: state.captureError ?? (state.pendingObservations.length ? "Capturing the current battle state…" : selection.message),
      // A header only: the page shows the merged sections (localIntel) for the request view it is sent (snapshot).
      envelope: displayable ? envelopeHeader(state.lastEnvelope) : null,
      // The shown result is being re-checked against newer captured frames or history.
      updating: Boolean(displayable && state.lastEnvelope && (!exact || state.pendingObservations.some((o) => o.roomId === shown?.roomId))),
      pendingSections: view.pending,
      staleSections: view.stale,
      metamonAdvice: displayable ? shownAdvice(state, decisionIdentity, selection.snapshot) : null,
      decisionIdentity,
      captureSession: state.captureSession,
      captureRevision: state.captureRevision,
      snapshot: selection.snapshot,
      localIntel: view.localIntel
    }
  }).catch(() => {});
}

function envelopeHeader(envelope) {
  if (!envelope) return null;
  const { snapshot: _snapshot, localIntel: _localIntel, ...semantic } = envelope.semantic;
  return { resultHash: envelope.resultHash, semantic };
}

// The pick is bound to its canonical decision identity (which names the snapshot and the legal actions), never to the
// deterministic result, so it shows the moment it is ready. Like the sections, it stays through frames that do not change
// the request and is dropped at once for a different decision.
function shownAdvice(state, identity, snapshot) {
  const advice = state.metamonAdvice;
  return advice?.identity && keepShownDecision(state, advice.identity, identity) ? currentMetamonAdvice(advice, advice.identity, snapshot) : null;
}

// A verified envelope (a partial stage or the complete result) replaces the shown one. Sections of an earlier view of the
// same decision that this envelope has not reached yet stay shown, marked stale, until it does.
function showEnvelope(state, envelope, identity) {
  if (!state.lastEnvelope || !sameDecision(state.lastEnvelope.semantic.identity, identity)
    || state.lastEnvelope.semantic.historyRevision !== envelope.semantic.historyRevision) state.staleIntel = state.lastEnvelope ? state.shownIntel : null;
  if (!envelope.semantic.stage) state.staleIntel = null;
  state.lastEnvelope = envelope;
  state.lastLocalIntel = envelope.semantic.localIntel;
  state.lastLocalIntelIdentity = identity;
}

async function reportClientStatus(force = false) {
  if (!force && Date.now() - lastStatusReportAt < 5000) return;
  lastStatusReportAt = Date.now();
  try { await sendClientStatus(); } catch {}  // diagnostics only: never affects capture or advice
}

async function sendClientStatus() {
  const settings = await getSettings();
  const tabs = [...tabStates.entries()].map(([tabId, s]) => ({
    tabId, captureSession: s.captureSession, pageCaptureId: s.pageCaptureId ?? null, bridgeVersion: s.bridgeVersion ?? null,
    activeRoomId: s.activeRoomId, rooms: [...s.rooms.keys()], initRooms: [...(s.initRooms ?? [])],
    captureError: s.captureError, pendingObservations: s.pendingObservations.length, pendingMetamonEvents: s.pendingMetamonEvents.length,
    lastFrameAt: s.lastFrameAt ?? null, lastStatus: s.lastStatus,
    advice: s.metamonAdvice ? { status: s.metamonAdvice.status, reason: s.metamonAdvice.reason ?? null, roomId: s.metamonAdvice.identity?.roomId ?? null, rqid: s.metamonAdvice.identity?.rqid ?? null } : null,
    decision: s.lastEnvelope ? (({ roomId, rqid, stateRevision, requestKind, legalActionSetHash }) => ({ roomId, rqid, stateRevision, requestKind,
      legalActionSetHash: String(legalActionSetHash).slice(0, 19) }))(s.lastEnvelope.semantic.identity) : null,
    bootstrapAskedAt: Object.fromEntries(s.bootstrapAskedAt ?? []), timings: s.timings ?? []
  }));
  await fetch(`${settings.companionUrl.replace(/\/$/, "")}/v1/client/status`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ clientId: `${chrome.runtime.id}:${WORKER_STARTED_AT}`, workerStartedAt: WORKER_STARTED_AT,
      extensionVersion: chrome.runtime.getManifest().version, companionUrl: settings.companionUrl, userAgent: navigator.userAgent, tabs })
  });
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

function addMetamonEvent(state, event) {
  state.pendingMetamonEvents.push({ ...event, sessionId: state.captureSession,
    eventId: `${state.captureSession}:metamon:${++state.metamonSequence}`, sequence: state.metamonSequence });
}

async function closeMetamonTab(state) {
  if (!state) return;
  if (state.metamonTimerId) clearTimeout(state.metamonTimerId);
  const settings = await getSettings();
  // The in-flight capture must finish before its final leave notification.
  await state.flushPromise?.catch(() => {});
  const rooms = new Set([...state.rooms.keys(), ...state.pendingObservations.map((o) => o.roomId)]);
  const metamonEvents = [...rooms].map((roomId) => ({ kind: "leave", roomId, sessionId: state.captureSession,
    eventId: `${state.captureSession}:leave:${++state.metamonSequence}`, sequence: state.metamonSequence }));
  if (metamonEvents.length) await fetch(`${settings.companionUrl.replace(/\/$/, "")}/v1/metamon/events`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metamonEvents }), signal: AbortSignal.timeout(5000)
  }).catch(() => {});
}

async function flushObservations(tabId, state, settings) {
  if (state.flushPromise) return state.flushPromise;
  let sentObservations = false;
  state.flushPromise = (async () => {
    while ((state.pendingObservations.length || state.pendingMetamonEvents.length) && tabStates.get(tabId) === state) {
      const metamonEvents = [];
      let observationCount = 0;
      for (const event of state.pendingMetamonEvents.slice(0, 300)) {
        if (event.kind === "observation" && ++observationCount > 100) break;
        metamonEvents.push(event);
      }
      const ids = new Set(metamonEvents.filter((e) => e.kind === "observation").map((e) => e.observationId));
      const observations = state.pendingObservations.filter((o) => ids.has(o.observationId));
      const endpoint = observations.length ? "/v1/observations" : "/v1/metamon/events";
      const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}${endpoint}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(observations.length ? { observations } : {}), metamonEvents }),
        signal: AbortSignal.timeout(15000)
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(`Capture rejected: ${body.error ?? response.status}`);
      if (tabStates.get(tabId) !== state) return;
      if (!observations.length) {
        state.pendingMetamonEvents.splice(0, metamonEvents.length);
        continue;
      }
      if (body.results?.length !== observations.length || typeof body.historyRevision !== "string") {
        throw new Error("Capture acknowledgement is incomplete; retaining observations for retry.");
      }
      for (let index = 0; index < observations.length; index += 1) {
        const result = body.results[index];
        const sent = observations[index];
        if (result.room?.roomId !== sent.roomId || result.acknowledgedSequence !== sent.sequence
          || result.observationId !== sent.observationId
          || (result.identity && result.identity.roomId !== sent.roomId)) {
          throw new Error("Capture acknowledgement does not match the submitted observations.");
        }
      }
      for (const result of body.results) {
        // Freshness is this browser's receive time. The companion's own clock (another machine through the tunnel) is
        // not comparable: a few seconds' skew made every decision look stale and hid it.
        state.rooms.set(result.room.roomId, { ...result.room, updatedAt: Date.now() });
        if (result.identity) state.roomIdentities.set(result.room.roomId, result.identity);
        else state.roomIdentities.delete(result.room.roomId);
      }
      state.historyRevision = body.historyRevision;
      // A restarted process may accept a queued mid-battle fragment before the next evaluate/advice call. That is
      // not proof it has the battle's prefix. Rebuild every initialized room without dropping any unacknowledged input.
      if (state.companionInstance && body.instanceId && state.companionInstance !== body.instanceId) {
        for (const roomId of state.initRooms ?? []) requestBootstrap(tabId, state, roomId);
      }
      if (body.instanceId) state.companionInstance = body.instanceId;
      sentObservations = true;
      state.pendingObservations.splice(0, observations.length);
      state.pendingMetamonEvents.splice(0, metamonEvents.length);
      state.captureError = null;
    }
    state.captureError = null;
    if (state.retryTimerId) clearTimeout(state.retryTimerId);
    state.retryTimerId = null;
  })();
  try {
    await state.flushPromise;
    // Evaluate as soon as the companion has acknowledged the frames: the flush itself batches frames that arrive while a
    // capture is in flight. A trailing 200 ms timer, restarted by every frame, used to sit between them (2026-10-23).
    if (sentObservations && tabStates.get(tabId) === state && !state.pendingObservations.length) void observeSnapshotForTab(tabId);
    if (tabStates.get(tabId) === state) await pushLocalIntelUpdate(tabId);
  } catch (error) {
    state.captureError = error instanceof Error ? error.message : String(error);
    scheduleCaptureRetry(tabId, state);
    throw error;
  } finally {
    state.flushPromise = null;
    if (!state.captureError && tabStates.get(tabId) === state && (state.pendingObservations.length || state.pendingMetamonEvents.length)) {
      void flushObservations(tabId, state, settings).catch(() => {});
    }
  }
}

function scheduleCaptureRetry(tabId, state) {
  if (state.retryTimerId || tabStates.get(tabId) !== state) return;
  state.retryTimerId = setTimeout(() => {
    state.retryTimerId = null;
    if (tabStates.get(tabId) === state) void observeSnapshotForTab(tabId);
  }, 5000);
}

function enqueueObservation(tabId, payload, source) {
  const state = stateForCapture(tabId, payload.captureId);
  state.lastFrameAt = Date.now();
  const packets = splitProtocolPacket(payload.data).filter((packet) => packet.roomId?.startsWith("battle-"));
  if (!packets.length) return;
  if (typeof payload.observationId !== "string") {
    // An earlier injected wrapper may still be alive until page reload. Once
    // the current hook is sending observations, its old emissions are noise.
    if (state.observationIds.size) return;
    state.captureError = "Reload the Showdown page to update its capture hook.";
    scheduleSnapshotObservation(tabId);
    return;
  }
  if (state.observationIds.has(payload.observationId)) return;
  state.observationIds.add(payload.observationId);
  // A battle must start from |init|. Without that history (service worker restarted, page loaded mid-battle) a fragment
  // cannot build state: drop it and ask the page to replay the battle's full log once (rate-limited per room).
  state.initRooms ??= new Set(); state.bootstrapAskedAt ??= new Map();
  for (const packet of packets.splice(0)) {
    if (state.initRooms.has(packet.roomId) || packet.lines.includes("|init|battle")) { state.initRooms.add(packet.roomId); packets.push(packet); continue; }
    requestBootstrap(tabId, state, packet.roomId);
  }
  for (const packet of packets) {
    state.observationSequence += 1;
    state.pendingObservations.push({
      observationId: `${payload.observationId}:${packet.roomId}`, sessionId: state.captureSession,
      sequence: state.observationSequence, roomId: packet.roomId, source,
      data: `>${packet.roomId}\n${packet.lines.join("\n")}`
    });
    addMetamonEvent(state, { kind: "observation", roomId: packet.roomId, observationId: `${payload.observationId}:${packet.roomId}` });
  }
  state.captureRevision += 1;
  void pushLocalIntelUpdate(tabId);
  void getSettings().then((settings) => flushObservations(tabId, state, settings)).catch(() => pushLocalIntelUpdate(tabId));
}

async function observeSnapshotForTab(tabId) {
  const settings = await getSettings();
  const state = getOrCreateTabState(tabId);
  try {
    await flushObservations(tabId, state, settings);
  } catch {
    await pushLocalIntelUpdate(tabId);
    return;
  }
  const selection = buildTabSelection(state);
  const snapshot = selection.snapshot;

  if (!snapshot || selection.status === TAB_STATUS.STALE_SNAPSHOT) {
    // Recovery must not depend on having an envelope or on a model advice poll. The old path stopped here forever
    // after a capture abort/restart, especially once the browser's last acknowledgement aged past 30 seconds.
    const roomId = selection.room?.roomId;
    if (!roomId) { state.missingSnapshot = null; return; }
    // A lobby or a previous battle's timer must not make a newly captured room immediately overdue.
    if (state.missingSnapshot?.roomId !== roomId) state.missingSnapshot = { roomId, since: Date.now() };
    // A normal battle starts with public fragments before its private request. Give that ordered capture one retry
    // interval to finish; replaying immediately restarted healthy cold workers just as preview advice became ready.
    if (snapshot || Date.now() - state.missingSnapshot.since >= 5000) {
      for (const roomId of state.initRooms ?? []) {
        if (!state.rooms.get(roomId)?.winner) requestBootstrap(tabId, state, roomId, 10000);
      }
    }
    scheduleCaptureRetry(tabId, state);
    return;
  }
  state.missingSnapshot = null;
  const decisionIdentity = await identityForSnapshot(state, snapshot);
  if (!decisionIdentity) return;
  if (!await isCurrentDecision(tabId, state, decisionIdentity)) return;
  // The pick does not wait for the deterministic result: follow it from the acknowledged identity at once.
  if (!sameDecision(state.metamonFor, decisionIdentity)) { state.metamonFor = decisionIdentity; scheduleMetamonPoll(tabId, state, 0); }
  if (state.lastLocalIntel && sameDecision(state.lastLocalIntelIdentity, decisionIdentity) && !state.lastEnvelope?.semantic.stage
    && state.lastEnvelope?.semantic.historyRevision === state.historyRevision) return;
  const evaluationKey = `${decisionIdentity.snapshotHash}:${decisionIdentity.stateRevision}:${state.historyRevision}`;
  if (state.evaluatingDecisions.has(evaluationKey)) return;
  state.evaluatingDecisions.add(evaluationKey);
  let superseded = false;

  try {
    const historyRevision = state.historyRevision;
    // Staged: each answer is the next partial result (board, damage, threats) or the complete one; each is shown at once.
    for (let after = null, final = false; !final;) {
      const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}/v1/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: state.captureSession, identity: decisionIdentity, historyRevision, after }),
        signal: AbortSignal.timeout(30000)
      });
      const json = await response.json();
      if (!response.ok) {
        if (response.status === 409 && tabStates.get(tabId) === state && !state.pendingObservations.length
          && sameDecision(state.roomIdentities.get(decisionIdentity.roomId), decisionIdentity) && state.historyRevision === historyRevision) {
          // Unknown room, expired history, or a superseded decision: obtain authoritative input again. In particular,
          // unknown room used to retry evaluate forever because only advice's 409 handler requested |init|.
          requestBootstrap(tabId, state, decisionIdentity.roomId, 5000);
        }
        throw new Error(`Deterministic evaluation rejected (${response.status}): ${json?.error ?? "unavailable"}`);
      }
      final = json.final !== false;
      const envelope = json.envelope;
      // Nothing newer within the companion's wait: ask again (its build is bounded; a stall fails explicitly).
      if (!envelope && !final) continue;
      if (!sameDecision(envelope?.semantic?.identity, decisionIdentity)
        || envelope.semantic.historyRevision !== historyRevision
        || (final ? Boolean(envelope.semantic.stage) : envelope.semantic.stage !== json.stage)
        || await hashCanonical(envelope.semantic) !== envelope.resultHash) {
        throw new Error("Deterministic result does not match the requested decision.");
      }
      if (state.historyRevision !== historyRevision || !await isCurrentDecision(tabId, state, decisionIdentity)) { superseded = true; return; }
      if (!envelope.semantic.localIntel) continue;
      showEnvelope(state, envelope, decisionIdentity);
      await pushLocalIntelUpdate(tabId);
      after = envelope.semantic.stage;
    }
  } catch (error) {
    if (await isCurrentDecision(tabId, state, decisionIdentity)) {
      state.captureError = error instanceof Error ? error.message : String(error);
      scheduleCaptureRetry(tabId, state);
      await pushLocalIntelUpdate(tabId);
    }
  } finally {
    state.evaluatingDecisions.delete(evaluationKey);
    // A dropped result must not strand the newest decision: evaluate it (frames still pending trigger it on their ack).
    if (superseded && tabStates.get(tabId) === state && !state.pendingObservations.length) void observeSnapshotForTab(tabId);
  }
}

// Ask the page to replay a battle's full log from |init| (rate-limited per room). Used when a fragment arrives without
// history, and when the advisor reports a lost sync: the replay restarts it from the whole log.
function requestBootstrap(tabId, state, roomId, minGapMs = 3000) {
  // An unacknowledged init is already the complete recovery input. Asking for more while offline queues repeated
  // worker restarts after reconnection. Keep every queued observation; suppress only redundant replay requests.
  if (state.pendingObservations.some((o) => o.roomId === roomId && /(?:^|\n)\|init\|battle(?:\n|$)/.test(o.data))) return false;
  state.bootstrapAskedAt ??= new Map();
  if (Date.now() - (state.bootstrapAskedAt.get(roomId) ?? 0) <= minGapMs) return false;
  state.bootstrapAskedAt.set(roomId, Date.now());
  void chrome.tabs.sendMessage(tabId, { type: "bootstrap", roomId }).catch(() => {});
  return true;
}

// What the client does with the advisor's answer: keep polling a pending pick; replay the battle from |init| when the
// advisor needs the full log (lost sync, or a worker just freed for a battle that waited); keep checking a waiting battle.
// Retries back off but never stop: a long outage must not require refreshing the page.
function followAdvice(tabId, state, identity) {
  const advice = state.metamonAdvice, roomId = identity?.roomId;
  void reportClientStatus();
  state.bootstrapTries ??= new Map();
  if (advice?.status === "ready") state.bootstrapTries.delete(roomId);
  // A pending pick is asked for again at once: the companion holds that request until the pick is ready. A ready pick is
  // re-checked once a second, enough to notice a lost worker or a restarted companion.
  if (advice?.status === "warming" || (advice?.status === "ready" && advice.guardsPending)) { scheduleMetamonPoll(tabId, state, 0); return; }
  if (advice?.status === "ready") { scheduleMetamonPoll(tabId, state, 1000); return; }
  // The advisor may still be restarting for this decision (a replay): keep asking rather than show an old answer.
  if (advice?.reason === "stale_advice") { scheduleMetamonPoll(tabId, state, 1000); return; }
  if (advice?.reason === "capacity") {
    if (advice.slotFree) requestBootstrap(tabId, state, roomId, 5000);
    scheduleMetamonPoll(tabId, state, 1500); return;
  }
  if (advice?.reason === "sync_lost" || advice?.reason === "worker_stalled") {
    const tries = state.bootstrapTries.get(roomId) ?? 0;
    if (requestBootstrap(tabId, state, roomId, Math.min(30000, 10000 + tries * 2000))) state.bootstrapTries.set(roomId, tries + 1);
    scheduleMetamonPoll(tabId, state, 3000);
  }
}

function scheduleMetamonPoll(tabId, state, delayMs = 250) {
  const askedAt = Date.now();
  if (state.metamonTimerId) clearTimeout(state.metamonTimerId);
  state.metamonTimerId = setTimeout(async () => {
    state.metamonTimerId = null;
    const identity = state.metamonFor;
    if (!identity || tabStates.get(tabId) !== state) return;
    // A capture in flight must delay the poll, not end it: ending it left the page on "thinking…" for the whole turn.
    if (state.pendingObservations.length) { scheduleMetamonPoll(tabId, state); return; }
    // A ready pick whose warnings are still being computed: the companion holds the request until they are ready.
    const held = state.metamonAdvice;
    const after = held?.status === "ready" && held.guardsPending && sameDecision(held.identity, identity) ? "pick" : undefined;
    try {
      const settings = await getSettings();
      const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}/v1/metamon/advice?waitMs=${ADVICE_WAIT_MS}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          sessionId: state.captureSession, identity, historyRevision: state.historyRevision, ...(after ? { after } : {})
        }), signal: AbortSignal.timeout(ADVICE_WAIT_MS + 5000)
      });
      const json = await response.json();
      // A restarted companion no longer knows this capture: replay the battle so it rebuilds (no page reload needed).
      if (response.status === 409 && /Unknown capture session/.test(json?.error ?? "") && state.metamonFor === identity) {
        requestBootstrap(tabId, state, identity.roomId, 5000);
        scheduleMetamonPoll(tabId, state, 2000);
        return;
      }
      // A newer decision replaced this one: it has its own poll.
      if (state.metamonFor !== identity || tabStates.get(tabId) !== state) return;
      if (!response.ok) {
        // The companion moved past this view (a frame we sent changed it): follow the current decision again.
        state.metamonFor = null; scheduleSnapshotObservation(tabId); return;
      }
      // An answer that lands while a capture is in flight cannot be checked yet; dropping it ended the poll and left
      // the strip on "thinking…" for the rest of the turn (e2e stale-room, 2026-10-22). Ask again instead.
      if (!await isCurrentDecision(tabId, state, identity)) {
        if (buildTabSelection(state).status === TAB_STATUS.STALE_SNAPSHOT) void observeSnapshotForTab(tabId);
        if (state.metamonFor === identity) scheduleMetamonPoll(tabId, state);
        return;
      }
      const previous = JSON.stringify(state.metamonAdvice ?? null);
      if (sameDecision(json.metamonAdvice?.identity, identity)) state.metamonAdvice = json.metamonAdvice;
      // An unchanged answer does not redraw the page.
      if (JSON.stringify(state.metamonAdvice ?? null) !== previous) await pushLocalIntelUpdate(tabId);
      // A companion that cannot hold the request (an older build) answers at once: keep the former 250 ms cadence then.
      if (state.metamonAdvice?.status === "warming" && Date.now() - askedAt < 100) { scheduleMetamonPoll(tabId, state); return; }
      followAdvice(tabId, state, identity);
    } catch {
      if (state.metamonFor === identity && tabStates.get(tabId) === state) {
        // The companion did not answer (restarting, tunnel down): say so and keep trying.
        state.metamonAdvice = { status: "unavailable", identity, reason: "companion_unreachable" };
        await pushLocalIntelUpdate(tabId);
        scheduleMetamonPoll(tabId, state, 2000);
      }
    }
  }, delayMs);
}

const ADVICE_WAIT_MS = 4000;

function scheduleSnapshotObservation(tabId) {
  const state = getOrCreateTabState(tabId);
  state.captureRevision += 1;
  void pushLocalIntelUpdate(tabId);
  if (state.observeTimerId) clearTimeout(state.observeTimerId);
  const selection = buildTabSelection(state);
  // Captured frames trigger evaluation when their capture is acknowledged (flushObservations); this path serves room
  // switches and retries, so it only coalesces a synchronous burst.
  const delayMs = 0;
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
  const analysisMode = options.analysisMode === "strategic" ? "strategic" : settings.analysisMode === "strategic" ? "strategic" : "tactical";
  const allowStrategicSnapshot = analysisMode === "strategic" && Boolean(snapshot);
  const canAnalyze = selection.status === TAB_STATUS.READY || allowStrategicSnapshot;
  const requestContext = snapshot
    ? {
        tabStatus: selection.status,
        actionableNow: selection.status === TAB_STATUS.READY,
        snapshotAgeMs: Number.isFinite(selection.ageMs) ? selection.ageMs : undefined,
        wait: Boolean(selection.room?.lastRequest?.wait),
        forceSwitch: Boolean(selection.room?.lastRequest?.forceSwitch),
        teamPreview: Boolean(selection.room?.lastRequest?.teamPreview || selection.room?.phase === "preview")
      }
    : null;

  if (!canAnalyze || !snapshot) {
    await pushLocalIntelUpdate(tabId);
    const state = setTabStatus(tabId, selection);
    state.lastError = selection.message;
    if (settings.showOverlay || forceOverlay) {
      await showOverlay(tabId, {
        providerLabel: "local",
        turn: selection.room?.turn ?? "?",
        status: selection.status,
        analysisMode,
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
      analysisMode,
      summary: selection.message,
      snapshot
    };
  }

  const decisionIdentity = await identityForSnapshot(state, snapshot);
  if (!await isCurrentDecision(tabId, state, decisionIdentity, analysisMode === "strategic")) {
    return { ok: false, status: "superseded", summary: "Battle position changed before analysis started." };
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
  if (!await isCurrentDecision(tabId, state, decisionIdentity, analysisMode === "strategic")) {
    return { ok: false, status: "superseded", summary: "Battle position changed before analysis started." };
  }

  if (settings.showOverlay || forceOverlay) {
      await showOverlay(tabId, {
        providerLabel: compareMode ? `compare:${provider}+${compareProvider}` : providerLabel(provider, model),
        turn: snapshot.turn,
        status: "analyzing",
        analysisMode,
        localIntel: state.lastLocalIntel ?? null,
        snapshot,
        health: state.lastProviderHealth,
        result: {
          summary: compareMode
          ? `Running ${analysisMode} analysis for turn ${snapshot.turn} with ${providerLabel(provider, model)} and ${providerLabel(compareProvider, compareModel)}...`
          : `Running ${analysisMode} analysis for turn ${snapshot.turn} with ${providerLabel(provider, model)}...`,
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
      requests.map((entry) => runSingleAnalysisRequest(
        settings,
        snapshot,
        entry.provider,
        entry.model,
        analysisMode,
        abortController.signal,
        requestContext,
        decisionIdentity
      ))
    );
    if (state.analysisRunSeq !== analysisRunId || !await isCurrentDecision(tabId, state, decisionIdentity, analysisMode === "strategic")) {
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
          analysisMode: result.analysisMode ?? analysisMode,
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
        analysisMode,
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
    state.lastAnalysisIdentity = decisionIdentity;
    state.lastProviderDebug = result.providerDebug ?? null;
    state.lastError = result.error ?? null;
    state.activeAnalysisAbortController = null;

    if (settings.showOverlay || forceOverlay) {
      await showOverlay(tabId, {
        providerLabel: compareMode ? `compare:${provider}+${compareProvider}` : providerLabel(provider, model),
        turn: snapshot.turn,
        status: TAB_STATUS.READY,
        analysisMode,
        requestId: result.requestId ?? null,
        snapshot,
        localIntel: state.lastLocalIntel ?? null,
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
      analysisMode,
      snapshot,
      analysis: result.result
    };
  } catch (error) {
    if (abortController.signal.aborted || state.analysisRunSeq !== analysisRunId
      || !await isCurrentDecision(tabId, state, decisionIdentity, analysisMode === "strategic")) {
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
      analysisMode,
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

  if (message.type === "ping") {
    // The page pings every 20 s; each ping also reports this worker's capture state to the companion, so a broken
    // client is visible from the companion host without the owner's devtools (GET /v1/client/status).
    if (sender.tab?.id !== undefined) {
      const state = tabStates.get(sender.tab.id);
      if (state) state.bridgeVersion = message.bridge ?? null;
    }
    void reportClientStatus();
    sendResponse({ ok: true });
    return true;
  }

  // Per-request paint timings from the page (no names): kept for the companion's client status, which journals them.
  if (message.type === "decision-timing") {
    const state = tabStates.get(sender.tab?.id);
    const t = message.payload;
    if (state && typeof t?.roomId === "string" && Number.isSafeInteger(t.rqid) && t.sections && typeof t.sections === "object") {
      (state.timings ??= []).push({ roomId: t.roomId, rqid: t.rqid, kind: String(t.kind ?? ""),
        sections: Object.fromEntries(Object.entries(t.sections).filter(([, ms]) => Number.isFinite(ms)).slice(0, 12)) });
      state.timings.splice(0, Math.max(0, state.timings.length - 30));
      scheduleStatusReport();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "decision-rendered") {
    void (async () => {
      const tabId = sender.tab?.id;
      const state = tabStates.get(tabId);
      const envelope = state?.lastEnvelope;
      if (!envelope || envelope.semantic.stage || message.payload?.resultHash !== envelope.resultHash
        || !sameDecision(message.payload?.identity, envelope.semantic.identity)
        || !await isCurrentDecision(tabId, state, envelope.semantic.identity)) return sendResponse({ ok: false });
      const settings = await getSettings();
      const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}/v1/feedback`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          sessionId: state.captureSession, identity: envelope.semantic.identity,
          historyRevision: envelope.semantic.historyRevision, resultHash: envelope.resultHash
        }), signal: AbortSignal.timeout(10000)
      });
      sendResponse({ ok: response.ok });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "showdown-frame") {
    const tabId = sender.tab?.id;
    const rawData = message.payload?.data;
    if (typeof tabId !== "number" || typeof rawData !== "string") {
      sendResponse({ ok: false });
      return;
    }
    if (message.payload.direction === "out") {
      const events = outgoingBattleEvents(rawData);
      if (events.length) {
        const state = stateForCapture(tabId, message.payload.captureId);
        for (const event of events) addMetamonEvent(state, event);
        void getSettings().then((settings) => flushObservations(tabId, state, settings)).catch(() => {});
      }
      sendResponse({ ok: true }); return true;
    }
    enqueueObservation(tabId, message.payload, "protocol");
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
    const state = stateForCapture(tabId, message.payload?.captureId);
    if (state.observationIds.size && !message.payload?.captureId) { sendResponse({ ok: true, ignored: true }); return true; }
    state.activeRoomId = typeof roomId === "string" && roomId.startsWith("battle-") ? roomId : null;
    state.activeRoomAmbiguous = Boolean(message.payload?.ambiguous);
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
    const state = stateForCapture(tabId, message.payload.captureId);
    // A periodic identical snapshot is a capture heartbeat, but only a companion acknowledgement proves liveness.
    // Suppressing it forever aged a quiet decision past 30 s and prevented recovery after a restart.
    if (state.lastRoomProtocolByRoomId.get(roomId) === rawData && !state.captureError
      && Date.now() - (state.rooms.get(roomId)?.updatedAt ?? 0) < 10000) {
      sendResponse({ ok: true, deduped: true });
      return true;
    }
    state.lastRoomProtocolByRoomId.set(roomId, rawData);
    enqueueObservation(tabId, message.payload, "recovery");
    if (!state.activeRoomId && !state.activeRoomAmbiguous && typeof message.payload?.roomSlot === "string") {
      state.activeRoomId = roomId;
    }
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
    void analyzeTab(tabId, {
      forceOverlay: Boolean(message.forceOverlay),
      analysisMode: message.analysisMode
    }).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === "get-last-analysis") {
    const tabId = sender.tab?.id ?? message.tabId;
    void (async () => {
      if (typeof tabId === "number") await pushLocalIntelUpdate(tabId);
      const state = typeof tabId === "number" ? tabStates.get(tabId) : null;
      sendResponse({
        ok: true,
        analysis: state?.lastAnalysis ?? null,
        envelope: state?.lastEnvelope ?? null,
        metamonAdvice: state ? shownAdvice(state, state.lastLocalIntelIdentity, buildTabSelection(state).snapshot) : null,
        localIntel: state?.shownIntel ?? null,
        decisionIdentity: state?.lastLocalIntelIdentity ?? state?.lastAnalysisIdentity ?? null,
        error: state?.lastError ?? null,
        status: state?.lastStatus ?? TAB_STATUS.NO_SNAPSHOT,
        message: state?.lastStatusMessage ?? "No active Showdown battle snapshot was found for this tab yet."
      });
    })();
    return true;
  }

  if (message.type === "companion-health") {
    void (async () => {
      const settings = await getSettings();
      try {
        const response = await fetch(`${settings.companionUrl.replace(/\/$/, "")}/api/health`);
        const json = await response.json();
        if (json?.repoRoot) {
          await setSettings({ lastKnownRepoRoot: json.repoRoot });
        }
        sendResponse({ ok: true, health: json });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true;
  }
});
