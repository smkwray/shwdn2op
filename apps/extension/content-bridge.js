const BRAND_NAME = "shwdn2op";
const SOURCE = "showdnass";
const CONTENT_BRIDGE_VERSION = "2026-03-31-bridge-2";
const OVERLAY_ID = "showdnass-overlay";
const OVERLAY_POSITION_KEY = "showdnass.overlay-position";
const OVERLAY_COLLAPSED_KEY = "showdnass.overlay-collapsed";
const OVERLAY_WIDTH_KEY = "showdnass.overlay-width";
const OVERLAY_HEIGHT_KEY = "showdnass.overlay-height";
const PANEL_STORAGE_PREFIX = "showdnass.panel";
const PANEL_STACK_BASE_Z = 10000;

const SIDEBAR_ID = "showdnass-sidebar";
const SIDEBAR_POSITION_KEY = "showdnass.sidebar-position";
const SIDEBAR_WIDTH_KEY = "showdnass.sidebar-width";
const SIDEBAR_HEIGHT_KEY = "showdnass.sidebar-height";
const SIDEBAR_COLLAPSED_KEY = "showdnass.sidebar-collapsed";
const SIDEBAR_ACTIVE_TAB_KEY = "showdnass.sidebar-active-tab";
const SIDEBAR_TAB_LABELS = {
  intel: "Intel",
  opponentAction: "Threat",
  selfAction: "Line",
  damage: "Dmg",
  mechanics: "Mech",
  debug: "Debug"
};
const GROUP_STORAGE_PREFIX = "showdnass.group";
const GROUP_DOM_PREFIX = "showdnass-group-";

const LEGACY_INTEL_PANEL_POSITION_KEY = "showdown-second-opinion.intel-position";
const LEGACY_INTEL_PANEL_VISIBLE_KEY = "showdown-second-opinion.intel-visible";
const PANEL_DEFS = [
  { key: "intel", id: "showdnass-panel-intel", title: "Local Intel", width: 360, zIndex: 10002, background: "rgba(18, 32, 24, 0.97)", border: "rgba(86, 202, 122, 0.24)" },
  { key: "opponentAction", id: "showdnass-panel-opponent-action", title: "Line To Respect", width: 360, zIndex: 10003, background: "rgba(38, 28, 18, 0.97)", border: "rgba(246, 173, 85, 0.24)" },
  { key: "selfAction", id: "showdnass-panel-self-action", title: "Best Line", width: 360, zIndex: 10004, background: "rgba(18, 29, 38, 0.97)", border: "rgba(94, 210, 255, 0.24)" },
  { key: "damage", id: "showdnass-panel-damage", title: "Damage Matrix", width: 390, zIndex: 10005, background: "rgba(34, 19, 19, 0.97)", border: "rgba(255, 124, 124, 0.24)" },
  { key: "mechanics", id: "showdnass-panel-mechanics", title: "Mechanics", width: 390, zIndex: 10006, background: "rgba(18, 23, 38, 0.97)", border: "rgba(109, 169, 255, 0.24)" },
  { key: "debug", id: "showdnass-panel-debug", title: "Debug", width: 420, zIndex: 10007, background: "rgba(24, 24, 28, 0.98)", border: "rgba(210, 210, 210, 0.18)" }
];

const OVERLAY_DEFAULT_OPTIONS = {
  codex: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.3-codex-spark"],
  claude: ["sonnet", "haiku", "opus"],
  gemini: ["gemini-3.1-pro", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
};

const PANEL_SETTING_KEYS = {
  intel: "showLocalIntelPanel",
  opponentAction: "showOpponentActionPanel",
  selfAction: "showSelfActionPanel",
  damage: "showDamagePanel",
  mechanics: "showMechanicsPanel",
  debug: "showDebugPanel"
};

if (window.__showdownSecondOpinionContentBridgeVersion !== CONTENT_BRIDGE_VERSION) {
  window.__showdownSecondOpinionContentBridgeInstalled = true;
  window.__showdownSecondOpinionContentBridgeVersion = CONTENT_BRIDGE_VERSION;

  let extensionContextValid = true;
  let overlayVisible = true;
  let overlayCollapsed = loadBooleanSetting(OVERLAY_COLLAPSED_KEY, false);
  let latestOverlayPayload = null;
  let latestLocalIntelPayload = null;
  let panelState = loadPanelState();
  let overlaySettings = {
    provider: "codex",
    codexModel: "gpt-5.4-mini",
    claudeModel: "sonnet",
    geminiModel: "gemini-3-flash-preview",
    analysisMode: "tactical",
    compareMode: false,
    compareProvider: "claude",
    compareCodexModel: "gpt-5.4-mini",
    compareClaudeModel: "sonnet",
    compareGeminiModel: "gemini-2.5-flash",
    showAskFriendCard: true,
    showMoveSuggestions: true,
    showLocalIntelPanel: false,
    showOpponentActionPanel: false,
    showSelfActionPanel: false,
    showDamagePanel: false,
    showMechanicsPanel: false,
    showDebugPanel: false
  };
  let overlayProviderModelOptions = { ...OVERLAY_DEFAULT_OPTIONS };
  let overlayHealth = null;
  let topStackZ = 10008;
  let sidebarActiveTab = loadStringSetting(SIDEBAR_ACTIVE_TAB_KEY, "intel");
  let sidebarCollapsed = loadBooleanSetting(SIDEBAR_COLLAPSED_KEY, false);

  function panelVisibleKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.visible`;
  }

  function panelPositionKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.position`;
  }

  function panelCollapsedKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.collapsed`;
  }

  function panelDockedKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.docked`;
  }

  function panelGroupKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.group`;
  }

  function panelWidthKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.width`;
  }

  function panelHeightKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.height`;
  }

  function getPanelDef(panelKey) {
    return PANEL_DEFS.find((panel) => panel.key === panelKey) ?? null;
  }

  function getPanelState(panelKey) {
    if (!panelState[panelKey]) {
      panelState[panelKey] = { visible: false, collapsed: false, docked: true, group: null };
    }
    return panelState[panelKey];
  }

  function loadBooleanSetting(key, fallbackValue) {
    try {
      const value = window.localStorage.getItem(key);
      if (value === "true") return true;
      if (value === "false") return false;
    } catch {
      // Ignore storage failures.
    }
    return fallbackValue;
  }

  function saveBooleanSetting(key, value) {
    try {
      window.localStorage.setItem(key, value ? "true" : "false");
    } catch {
      // Ignore storage failures.
    }
  }

  function loadStringSetting(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return typeof value === "string" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function saveStringSetting(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // Ignore storage failures.
    }
  }

  function loadPositionSetting(key) {
    try {
      const text = window.localStorage.getItem(key);
      if (!text) return null;
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed.left !== "number" || typeof parsed.top !== "number") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function savePositionSetting(key, left, top) {
    try {
      window.localStorage.setItem(key, JSON.stringify({ left, top }));
    } catch {
      // Ignore storage failures.
    }
  }

  function loadWidthSetting(key) {
    try {
      const value = Number(window.localStorage.getItem(key));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  function saveWidthSetting(key, width) {
    try {
      window.localStorage.setItem(key, String(width));
    } catch {
      // Ignore storage failures.
    }
  }

  function loadHeightSetting(key) {
    try {
      const value = Number(window.localStorage.getItem(key));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  function saveHeightSetting(key, height) {
    try {
      window.localStorage.setItem(key, String(height));
    } catch {
      // Ignore storage failures.
    }
  }

  function loadPanelState() {
    const nextState = {};
    for (const panel of PANEL_DEFS) {
      const panelKey = panel.key;
      const legacyVisibleKey = panelKey === "intel" ? LEGACY_INTEL_PANEL_VISIBLE_KEY : null;
      const visible = loadBooleanSetting(
        panelVisibleKey(panelKey),
        legacyVisibleKey ? loadBooleanSetting(legacyVisibleKey, false) : false
      );
      const collapsed = loadBooleanSetting(panelCollapsedKey(panelKey), false);
      const docked = loadBooleanSetting(panelDockedKey(panelKey), true);
      const group = loadStringSetting(panelGroupKey(panelKey), null) || null;
      nextState[panelKey] = { visible, collapsed, docked, group };
    }
    return nextState;
  }

  function bringToFront(element) {
    if (!element) return;
    const current = Number.parseInt(String(element.style.zIndex || window.getComputedStyle(element).zIndex || PANEL_STACK_BASE_Z), 10);
    topStackZ = Math.max(topStackZ, Number.isFinite(current) ? current : PANEL_STACK_BASE_Z) + 1;
    element.style.zIndex = String(topStackZ);
  }

  function markExtensionContextInvalid(error) {
    extensionContextValid = false;
    if (error instanceof Error && !/Extension context invalidated/i.test(error.message)) {
      console.warn("[showdnass] runtime messaging disabled:", error.message);
    }
  }

  function safeSendRuntimeMessage(message) {
    if (!extensionContextValid) {
      return Promise.resolve(null);
    }
    try {
      return chrome.runtime.sendMessage(message).catch((error) => {
        if (error instanceof Error && /Extension context invalidated/i.test(error.message)) {
          markExtensionContextInvalid(error);
          return null;
        }
        throw error;
      });
    } catch (error) {
      markExtensionContextInvalid(error);
      return Promise.resolve(null);
    }
  }

  function injectPageHook() {
    if (!extensionContextValid) return;
    const script = document.createElement("script");
    try {
      script.src = chrome.runtime.getURL("page-hook.js");
    } catch (error) {
      markExtensionContextInvalid(error);
      return;
    }
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  async function refreshOverlayConfig() {
    const [configResponse, healthResponse] = await Promise.all([
      safeSendRuntimeMessage({ type: "get-overlay-config" }),
      safeSendRuntimeMessage({ type: "companion-health" })
    ]);
    if (configResponse?.ok) {
      overlaySettings = { ...overlaySettings, ...(configResponse.settings ?? {}) };
      overlayProviderModelOptions = {
        ...OVERLAY_DEFAULT_OPTIONS,
        ...(configResponse.providerModelOptions ?? {})
      };
      syncPanelVisibilityWithSettings();
    }
    overlayHealth = healthResponse?.ok ? healthResponse.health ?? null : null;
    if (!configResponse?.ok) return null;
    return {
      settings: overlaySettings,
      providerModelOptions: overlayProviderModelOptions,
      health: overlayHealth
    };
  }

  function syncPanelVisibilityWithSettings() {
    for (const [panelKey, settingKey] of Object.entries(PANEL_SETTING_KEYS)) {
      const state = getPanelState(panelKey);
      const nextVisible = Boolean(overlaySettings?.[settingKey]);
      state.visible = nextVisible;
      saveBooleanSetting(panelVisibleKey(panelKey), nextVisible);
    }
  }

  function buildPlaceholderOverlayPayload() {
    return {
      providerLabel: "Ask a Friend",
      turn: latestLocalIntelPayload?.turn ?? "?",
      status: latestLocalIntelPayload?.status ?? "no_snapshot",
      result: {
        summary: "Ask a Friend is visible. Use the popup button to analyze the current board state.",
        rankedActions: [],
        confidence: "low"
      }
    };
  }

  async function persistOverlayVisibilitySetting(visible) {
    const response = await safeSendRuntimeMessage({
      type: "save-settings",
      payload: { showOverlay: Boolean(visible) }
    });
    if (response?.ok) {
      overlaySettings = { ...overlaySettings, ...(response.settings ?? { showOverlay: Boolean(visible) }) };
    } else {
      overlaySettings = { ...overlaySettings, showOverlay: Boolean(visible) };
    }
  }

  function hideOverlayOnly() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.style.display = "none";
    }
  }

  function syncWindowVisibility() {
    if (!overlayVisible) {
      hideOverlayOnly();
      hideAllClassicPanels();
      hideSidebar();
      for (const el of document.querySelectorAll(`[id^="${GROUP_DOM_PREFIX}"]`)) {
        el.style.display = "none";
      }
      return;
    }

    if (overlaySettings.showOverlay) {
      const payload = latestOverlayPayload ?? buildPlaceholderOverlayPayload();
      void renderOverlay(payload);
    } else {
      document.getElementById(OVERLAY_ID)?.remove();
    }
    renderPanelLayout();
  }

  function applyOverlaySettings(settings) {
    if (!settings || typeof settings !== "object") return;
    overlaySettings = { ...overlaySettings, ...settings };
    syncPanelVisibilityWithSettings();

    if (overlaySettings.showOverlay === false) {
      document.getElementById(OVERLAY_ID)?.remove();
    } else if (overlayVisible && !document.getElementById(OVERLAY_ID)) {
      void renderOverlay(latestOverlayPayload ?? buildPlaceholderOverlayPayload());
    }
    renderPanelLayout();
  }

  async function persistPanelVisibilitySetting(panelKey, visible) {
    const settingKey = PANEL_SETTING_KEYS[panelKey];
    if (!settingKey) return;
    const payload = { [settingKey]: Boolean(visible) };
    const response = await safeSendRuntimeMessage({
      type: "save-settings",
      payload
    });
    if (response?.ok) {
      overlaySettings = { ...overlaySettings, ...(response.settings ?? payload) };
    } else {
      overlaySettings = { ...overlaySettings, ...payload };
    }
  }

  function loadOverlayPosition() {
    return loadPositionSetting(OVERLAY_POSITION_KEY);
  }

  function saveOverlayPosition(left, top) {
    savePositionSetting(OVERLAY_POSITION_KEY, left, top);
  }

  function loadPanelPosition(panelKey) {
    const primary = loadPositionSetting(panelPositionKey(panelKey));
    if (primary) return primary;
    if (panelKey === "intel") {
      return loadPositionSetting(LEGACY_INTEL_PANEL_POSITION_KEY);
    }
    return null;
  }

  function savePanelPosition(panelKey, left, top) {
    savePositionSetting(panelPositionKey(panelKey), left, top);
  }

  function inferActionKind(entry) {
    if (typeof entry?.actionId === "string") {
      if (entry.actionId.startsWith("switch:")) return "switch";
      if (entry.actionId.startsWith("move:")) return "move";
    }
    if (/^switch\b/i.test(entry?.label ?? "")) return "switch";
    return "move";
  }

  function getSelectedModelForProvider(provider) {
    if (provider === "claude") return overlaySettings.claudeModel;
    if (provider === "gemini") return overlaySettings.geminiModel;
    return overlaySettings.codexModel;
  }

  function getSelectedCompareModelForProvider(provider) {
    if (provider === "claude") return overlaySettings.compareClaudeModel;
    if (provider === "gemini") return overlaySettings.compareGeminiModel;
    return overlaySettings.compareCodexModel;
  }

  function formatActionScore(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return "";
    if (score > 1.25) return `${score.toFixed(score >= 10 ? 0 : 1)}/10`;
    return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
  }

  function formatShare(entry) {
    if (!entry || typeof entry.share !== "number") return "";
    const rounded = Math.round(entry.share * 100);
    if (rounded >= 100) return "100%*";
    return `${rounded}%`;
  }

  function renderModelOptionsMarkup(provider, selectedValue) {
    const models = overlayProviderModelOptions[provider] ?? [];
    return models
      .map((model) => `<option value="${model}" ${model === selectedValue ? "selected" : ""}>${model}</option>`)
      .join("");
  }

  function renderProviderOptionsMarkup(selectedValue) {
    return ["codex", "claude", "gemini"]
      .map((provider) => `<option value="${provider}" ${provider === selectedValue ? "selected" : ""}>${provider}</option>`)
      .join("");
  }

  function renderProviderHealthMarkup() {
    const providers = overlayHealth?.providers;
    if (!providers || typeof providers !== "object") return "";
    return `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        ${Object.entries(providers).map(([name, info]) => `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:${info?.available ? "rgba(74,222,128,0.14)" : "rgba(248,113,113,0.14)"};font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">${name}</strong>
            <span style="opacity:.78">${info?.available ? "ready" : "down"}</span>
          </span>
        `).join("")}
      </div>
    `;
  }

  function formatTabStatusLabel(status) {
    switch (status) {
      case "ready":
        return "Ready";
      case "room_ambiguous":
        return "Pick a battle";
      case "waiting_or_not_your_turn":
        return "Waiting";
      case "stale_snapshot":
        return "Needs refresh";
      case "provider_error":
        return "Provider error";
      case "analyzing":
        return "Analyzing";
      case "extension_reloaded":
        return "Reload required";
      case "no_snapshot":
      default:
        return "No battle found";
    }
  }

  function renderAnalysisCard(title, analysis) {
    const ranked = Array.isArray(analysis?.rankedActions) ? analysis.rankedActions : [];
    return `
      <div style="min-width:0;background:rgba(255,255,255,0.05);border-radius:10px;padding:10px">
        <div style="font-weight:700">${title}</div>
        <div style="margin-top:6px;opacity:.9">${analysis?.summary ?? "No summary available."}</div>
        <div style="margin-top:8px">
          ${ranked.slice(0, 3).map((entry, index) => `
            <div style="padding:6px 0;border-top:${index === 0 ? "none" : "1px solid rgba(255,255,255,0.08)"}">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <div style="font-weight:600">${index + 1}. ${entry.label}</div>
                <span style="font-size:11px;opacity:.72">${formatActionScore(entry.score)}</span>
              </div>
              <div style="opacity:.8;margin-top:2px">${entry.rationale}</div>
            </div>
          `).join("") || "<div>No ranked actions.</div>"}
        </div>
      </div>
    `;
  }

  function renderCompactChip(label, value, tone = "neutral", title = "") {
    const style = tone === "positive"
      ? "background:rgba(74,222,128,0.14);border-color:rgba(74,222,128,0.24)"
      : tone === "warn"
        ? "background:rgba(251,191,36,0.14);border-color:rgba(251,191,36,0.24)"
        : tone === "danger"
          ? "background:rgba(248,113,113,0.14);border-color:rgba(248,113,113,0.24)"
          : tone === "accent"
            ? "background:rgba(96,165,250,0.14);border-color:rgba(96,165,250,0.24)"
            : "background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.08)";
    return `
      <span title="${escapeHtml(title || `${label}${value ? `: ${value}` : ""}`)}" style="display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);${style};font-size:11px;line-height:1.2;white-space:nowrap">
        <strong style="font-weight:600">${escapeHtml(label)}</strong>
        ${value ? `<span>${escapeHtml(value)}</span>` : ""}
      </span>
    `;
  }

  function likelihoodTone(entry) {
    if (entry?.share >= 0.65) return "positive";
    if (entry?.share >= 0.35) return "warn";
    return "neutral";
  }

  function renderLikelihoodList(title, entries) {
    const hasEntries = Array.isArray(entries) && entries.length > 0;
    if (!hasEntries) return "";
    return `
      <div style="margin-top:6px">
        <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">${title}</div>
        <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px">
          ${entries.map((entry) => renderCompactChip(
            entry.name,
            formatShare(entry),
            likelihoodTone(entry),
            `${entry.name}: ${formatShare(entry)} from ${entry.sampleCount} sample${entry.sampleCount === 1 ? "" : "s"}`
          )).join("")}
        </div>
      </div>
    `;
  }

  function renderCurrentReveal(entry) {
    const rows = [];
    if (Array.isArray(entry?.revealedMoves) && entry.revealedMoves.length > 0) {
      rows.push(`
        <div style="margin-top:6px">
          <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Known moves</div>
          <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px">${entry.revealedMoves.map((moveName) => renderCompactChip("move", moveName, "accent", moveName)).join("")}</div>
        </div>
      `);
    }
    if (entry?.revealedItem) {
      rows.push(`
        <div style="margin-top:6px">
          <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px">${renderCompactChip("item", entry.revealedItem, "neutral", `Known item: ${entry.revealedItem}`)}</div>
        </div>
      `);
    }
    if (entry?.revealedAbility) {
      rows.push(`
        <div style="margin-top:6px">
          <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px">${renderCompactChip("ability", entry.revealedAbility, "neutral", `Known ability: ${entry.revealedAbility}`)}</div>
        </div>
      `);
    }
    if (entry?.revealedTeraType && !entry?.currentTerastallized) {
      rows.push(`
        <div style="margin-top:6px">
          <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px">${renderCompactChip("tera", entry.revealedTeraType, "accent", `Known Tera type: ${entry.revealedTeraType}`)}</div>
        </div>
      `);
    }
    return rows.join("");
  }

  function formatPercentRange(minPercent, maxPercent) {
    if (!Number.isFinite(minPercent) || !Number.isFinite(maxPercent)) return "?";
    if (minPercent === maxPercent) return `${Math.round(minPercent)}%`;
    return `${Math.round(minPercent)}-${Math.round(maxPercent)}%`;
  }

  function formatRemainingRange(minPercent, maxPercent, currentHpPercent) {
    const hp = Number(currentHpPercent);
    if (!Number.isFinite(hp) || hp <= 0) return null;
    const minRemaining = Number(minPercent) / hp * 100;
    const maxRemaining = Number(maxPercent) / hp * 100;
    if (!Number.isFinite(minRemaining) || !Number.isFinite(maxRemaining)) return null;
    if (Math.round(minRemaining) === Math.round(maxRemaining)) return `${Math.round(minRemaining)}% rem`;
    return `${Math.round(minRemaining)}-${Math.round(maxRemaining)}% rem`;
  }

  function formatBandCoverage(coverage) {
    if (coverage === "covers_current_hp") return "KOs";
    if (coverage === "can_cover_current_hp") return "rolls";
    if (coverage === "misses_current_hp") return "no KO";
    return "unknown";
  }

  function compactBandLabel(label) {
    if (label === "conservative") return "cons";
    if (label === "likely") return "likely";
    if (label === "high") return "high";
    return label ?? "band";
  }

  function bandTone(label, coverage, outcome) {
    if (outcome === "immune") return "accent";
    if (outcome === "blocked") return "warn";
    if (coverage === "covers_current_hp") return "positive";
    if (coverage === "can_cover_current_hp") return "warn";
    if (coverage === "misses_current_hp") return "danger";
    if (label === "conservative") return "accent";
    if (label === "high") return "danger";
    return "neutral";
  }

  function renderBandChip(band, currentHpPercent, likelyBandSource) {
    if (band?.outcome && band.outcome !== "damage") {
      const outcomeText = band.detail
        ?? (band.outcome === "status" ? "non-damaging status move" : band.outcome);
      return renderCompactChip(compactBandLabel(band?.label ?? band.outcome), outcomeText, bandTone(band?.label, band?.coverage, band?.outcome), outcomeText);
    }

    const rangeText = formatPercentRange(band?.minPercent, band?.maxPercent);
    const remainingText = formatRemainingRange(band?.minPercent, band?.maxPercent, currentHpPercent);
    const coverageText = formatBandCoverage(band?.coverage);
    const likelySourceText = band?.label === "likely" && likelyBandSource && likelyBandSource !== "calc"
      ? likelyBandSource === "context"
        ? "local match"
        : likelyBandSource === "aggregate"
          ? "local agg"
          : likelyBandSource
      : "";
    const label = compactBandLabel(band?.label);
    const value = remainingText ?? rangeText;
    const detail = `${band?.label ?? "band"}: ${value}${remainingText ? ` (${rangeText} max)` : ""}; ${coverageText}${likelySourceText ? `; ${likelySourceText}` : ""}`;
    return renderCompactChip(label, value, bandTone(band?.label, band?.coverage, band?.outcome), detail);
  }

  function renderCaveatChips(caveats) {
    if (!Array.isArray(caveats) || caveats.length === 0) return "";
    return `
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
        ${caveats.map((caveat) => `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">${caveat.kind}</strong>
            <span style="opacity:.74">${caveat.certainty === "known" ? "known" : "possible"}</span>
          </span>
        `).join("")}
      </div>
    `;
  }

  function renderInteractionHints(hints) {
    if (!Array.isArray(hints) || hints.length === 0) return "";
    return `
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
        ${hints.map((hint) => renderCompactChip(
          hint.certainty === "possible" ? "maybe" : "immune",
          hint.label,
          hint.certainty === "possible" ? "warn" : "accent",
          hint.detail ?? hint.label
        )).join("")}
      </div>
    `;
  }

  function renderObservedDamageNote(observedRange) {
    if (!observedRange || !Number.isFinite(observedRange.minPercent) || !Number.isFinite(observedRange.maxPercent) || !Number.isFinite(observedRange.sampleCount)) {
      return "";
    }
    const rangeText = formatPercentRange(observedRange.minPercent, observedRange.maxPercent);
    return `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px">${renderCompactChip("seen", rangeText, "accent", `Seen locally: ${rangeText} of max HP from ${observedRange.sampleCount} sample${observedRange.sampleCount === 1 ? "" : "s"}`)}</div>`;
  }

  function renderDamageBandRow(bands, currentHpPercent, likelyBandSource) {
    if (!Array.isArray(bands) || bands.length === 0) return "";
    return `
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
        ${bands.map((band) => renderBandChip(band, currentHpPercent, likelyBandSource)).join("")}
      </div>
    `;
  }

  function findLikelyBand(bands) {
    if (!Array.isArray(bands) || bands.length === 0) return null;
    return bands.find((band) => band.label === "likely") ?? bands[0] ?? null;
  }

  function formatCompactThreatBand(band) {
    if (!band) return "";
    if (band.outcome && band.outcome !== "damage") {
      return band.detail ?? (band.outcome === "status" ? "status" : band.outcome);
    }
    if (band.minPercent !== null && band.maxPercent !== null) {
      return formatPercentRange(band.minPercent, band.maxPercent);
    }
    return "unknown";
  }

  function compactHintLabel(hints) {
    if (!Array.isArray(hints) || hints.length === 0) return "";
    return hints[0]?.label ?? "";
  }

  function switchCandidatesForPrediction(prediction) {
    if (Array.isArray(prediction?.topSwitchTargets) && prediction.topSwitchTargets.length > 0) {
      return prediction.topSwitchTargets;
    }
    return Array.isArray(prediction?.topActions)
      ? prediction.topActions.filter((candidate) => candidate?.actionClass === "switch")
      : [];
  }

  function renderSwitchDamagePeek(summaryLabel, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return "";
    return `
      <details style="margin-top:6px">
        <summary style="cursor:pointer;font-size:11px;opacity:.72">${escapeHtml(summaryLabel)}</summary>
        <div style="margin-top:6px;display:grid;gap:6px">
          ${rows.map((row) => `
            <div style="padding:6px 8px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);font-size:11px;line-height:1.35">
              <strong style="font-weight:600">${escapeHtml(row.label ?? "Unknown")}</strong>
              <span style="opacity:.84"> ${escapeHtml(row.damageText ?? "unknown")}</span>
              ${row.note ? `<span style="opacity:.62"> · ${escapeHtml(row.note)}</span>` : ""}
            </div>
          `).join("")}
        </div>
      </details>
    `;
  }

  function collectSwitchInRowsForMove(prediction, moveName) {
    const normalizedMove = String(moveName ?? "").trim().toLowerCase();
    const switchCandidates = switchCandidatesForPrediction(prediction);
    if (!normalizedMove || switchCandidates.length === 0) return [];
    const seen = new Set();
    const rows = [];
    for (const candidate of switchCandidates) {
      if (!candidate?.switchTargetSpecies || !Array.isArray(candidate?.switchTargetPlayerPreview)) continue;
      const preview = candidate.switchTargetPlayerPreview.find((entry) => String(entry?.moveName ?? "").trim().toLowerCase() === normalizedMove);
      if (!preview) continue;
      const key = String(candidate.switchTargetSpecies).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        label: candidate.switchTargetSpecies,
        damageText: formatCompactThreatBand(findLikelyBand(preview.bands)),
        note: compactHintLabel(preview.interactionHints)
      });
    }
    return rows;
  }

  function activeOpponentIntelEntry(localIntel, snapshot) {
    const activeSpecies = snapshot?.opponentSide?.active?.species ?? snapshot?.opponentSide?.active?.displayName;
    const entries = Array.isArray(localIntel?.opponents) ? localIntel.opponents : [];
    return entries.find((entry) => normalizeName(entry?.species ?? entry?.displayName) === normalizeName(activeSpecies)) ?? entries[0] ?? null;
  }

  function renderBoardSummaryStrip(localIntel) {
    const snapshot = latestOverlayPayload?.snapshot ?? null;
    if (!localIntel || !snapshot) return "";

    const chips = [];
    if (localIntel.hazardSummary) {
      chips.push(renderCompactChip("board", localIntel.hazardSummary, "warn", localIntel.hazardSummary));
    }

    const activeEntry = activeOpponentIntelEntry(localIntel, snapshot);
    const opponentTeraUsed = Array.isArray(snapshot?.opponentSide?.team) && snapshot.opponentSide.team.some((pokemon) => pokemon?.terastallized);
    const likelyTera = Array.isArray(activeEntry?.likelyTeraTypes) ? activeEntry.likelyTeraTypes : [];
    if (opponentTeraUsed) {
      chips.push(renderCompactChip("tera", "opponent spent", "neutral", "Opponent Terastallized already."));
    } else if (likelyTera.length > 0) {
      const topTera = likelyTera[0]?.name ?? "unknown";
      chips.push(renderCompactChip("tera", `opponent live (${topTera})`, "warn", `Opponent still has Tera available; top local hint: ${topTera}.`));
    }

    for (const caveat of (localIntel.survivalCaveats ?? []).slice(0, 3)) {
      chips.push(renderCompactChip("caveat", caveat, "danger", caveat));
    }

    if (chips.length === 0) return "";
    return `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${chips.join("")}</div>`;
  }

  function collectThreatSwitchRows(threatEntry) {
    const targets = Array.isArray(threatEntry?.switchTargets) ? threatEntry.switchTargets : [];
    return targets.map((target) => ({
      label: target.species ?? "Unknown",
      damageText: formatCompactThreatBand(findLikelyBand(target.bands)),
      note: compactHintLabel(target.interactionHints) || (target.relation ? formatSpeedRelation(target.relation) : "")
    }));
  }

  function formatSpeedRange(range) {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return "?";
    if (range.min === range.max) return `${Math.round(range.min)}`;
    return `${Math.round(range.min)}-${Math.round(range.max)}`;
  }

  function formatSpeedRelation(relation) {
    if (relation === "faster") return "you outspeed";
    if (relation === "slower") return "they outspeed";
    if (relation === "overlap") return "range overlap";
    return "speed unclear";
  }

  function relationFromSpeedNumber(yourSpeed, opponentRange) {
    if (!Number.isFinite(yourSpeed) || !opponentRange || !Number.isFinite(opponentRange.min) || !Number.isFinite(opponentRange.max)) {
      return "unknown";
    }
    if (yourSpeed > opponentRange.max) return "faster";
    if (yourSpeed < opponentRange.min) return "slower";
    return "overlap";
  }

  function formatSwitchSpeedText(matchup, possibleRange) {
    const liveLabel = formatSpeedRelation(matchup?.relation);
    const possibleRelation = relationFromSpeedNumber(Number(matchup?.effectiveSpeed), possibleRange);
    if (!possibleRange || possibleRelation === "unknown" || possibleRelation === matchup?.relation) {
      return liveLabel;
    }
    if (matchup?.relation === "faster" && possibleRelation !== "faster") {
      return "you outspeed live; item risk";
    }
    if (matchup?.relation === "overlap" && possibleRelation === "slower") {
      return "range overlap; item risk";
    }
    return `${liveLabel}; item risk`;
  }

  function renderMechanicsCard(title, body, footer = "") {
    return `
      <div style="flex:1 1 170px;min-width:0;padding:7px 8px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:rgba(255,255,255,0.04)">
        <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">${title}</div>
        <div style="margin-top:5px">${body}</div>
        ${footer ? `<div style="margin-top:5px;font-size:10px;opacity:.56">${footer}</div>` : ""}
      </div>
    `;
  }

  function renderSpeedSummaryMarkup(speedPreview, relation) {
    const yourSpeed = Number(speedPreview?.yourActiveEffectiveSpeed);
    const neutralRange = speedPreview?.neutralRange;
    const opponentRange = speedPreview?.effectiveRange;
    const possibleRange = speedPreview?.possibleRange;
    const hasYourSpeed = Number.isFinite(yourSpeed);
    const hasNeutralRange = neutralRange && Number.isFinite(neutralRange.min) && Number.isFinite(neutralRange.max);
    const hasOpponentRange = opponentRange && Number.isFinite(opponentRange.min) && Number.isFinite(opponentRange.max);
    const hasPossibleRange = possibleRange && Number.isFinite(possibleRange.min) && Number.isFinite(possibleRange.max);
    if (!hasYourSpeed && !hasOpponentRange) {
      return speedPreview?.activeSummary
        ? `<div style="margin-top:4px;opacity:.72">${speedPreview.activeSummary}</div>`
        : `<div style="margin-top:4px;opacity:.72">No structured speed range available yet.</div>`;
    }

    const relationStyle = relation === "faster"
      ? "background:rgba(74,222,128,0.16);border-color:rgba(74,222,128,0.28)"
      : relation === "slower"
        ? "background:rgba(248,113,113,0.16);border-color:rgba(248,113,113,0.26)"
        : relation === "overlap"
          ? "background:rgba(251,191,36,0.16);border-color:rgba(251,191,36,0.28)"
          : "background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.08)";

    return `
      <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px">
        <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);${relationStyle};font-size:11px;line-height:1.2;white-space:nowrap">
          <strong style="font-weight:600">relation</strong>
          <span>${formatSpeedRelation(relation)}</span>
        </span>
        ${hasYourSpeed ? `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">you</strong>
            <span>${Math.round(yourSpeed)}</span>
          </span>
        ` : `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">you</strong>
            <span>?</span>
          </span>
        `}
        ${hasNeutralRange ? `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">base est</strong>
            <span>${formatSpeedRange(neutralRange)}</span>
          </span>
        ` : ""}
        ${hasOpponentRange ? `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">live est</strong>
            <span>${formatSpeedRange(opponentRange)}</span>
          </span>
        ` : ""}
        ${hasPossibleRange ? `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(251,191,36,0.12);border-color:rgba(251,191,36,0.28);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">item range</strong>
            <span>${formatSpeedRange(possibleRange)}</span>
          </span>
        ` : ""}
      </div>
      ${speedPreview?.activeSummary ? `<div style="margin-top:4px;font-size:10px;opacity:.66">${speedPreview.activeSummary}</div>` : ""}
    `;
  }

  function renderSpeedEvidence(speedPreview) {
    const evidence = Array.isArray(speedPreview?.evidence) ? speedPreview.evidence : [];
    const confounders = Array.isArray(speedPreview?.confounders) ? speedPreview.confounders : [];
    if (evidence.length === 0 && confounders.length === 0) return "";
    return `
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
        ${evidence.map((entry) => renderCompactChip(
          entry.kind.replace(/_/g, " "),
          entry.label,
          entry.kind === "confounded" || entry.kind === "capture_gap" ? "warn" : "neutral",
          `${entry.label}${entry.detail ? `: ${entry.detail}` : ""}`
        )).join("")}
        ${confounders.map((entry) => renderCompactChip("confounder", entry, "warn", entry)).join("")}
      </div>
    `;
  }

  function getLocalIntel() {
    return latestLocalIntelPayload?.localIntel ?? null;
  }

  function normalizeName(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatPredictionClassLabel(actionClass) {
    if (actionClass === "stay_attack") return "Stay + attack";
    if (actionClass === "switch") return "Switch";
    if (actionClass === "status_or_setup") return "Status / setup";
    return "Unknown";
  }

  function predictionClassChipStyle(actionClass) {
    if (actionClass === "stay_attack") return "background:rgba(248,113,113,0.16);border-color:rgba(248,113,113,0.28)";
    if (actionClass === "switch") return "background:rgba(96,165,250,0.16);border-color:rgba(96,165,250,0.28)";
    if (actionClass === "status_or_setup") return "background:rgba(74,222,128,0.16);border-color:rgba(74,222,128,0.28)";
    return "background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.08)";
  }

  function predictionConfidenceChipStyle(confidenceTier) {
    if (confidenceTier === "high") return "background:rgba(74,222,128,0.16);border-color:rgba(74,222,128,0.28)";
    if (confidenceTier === "medium") return "background:rgba(251,191,36,0.16);border-color:rgba(251,191,36,0.28)";
    return "background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.08)";
  }

  function formatPredictionSource(candidate) {
    if (!candidate) return "candidate";
    if (candidate.type === "known_move") return "known move";
    if (candidate.type === "likely_hidden_move") return "likely hidden move";
    if (candidate.type === "likely_switch") return "revealed pivot";
    if (candidate.type === "known_status_or_setup") return "known utility";
    if (candidate.type === "likely_status_or_setup") return "likely hidden utility";
    return candidate.source ?? "candidate";
  }

  function formatSelfActionKind(candidate) {
    if (!candidate) return "action";
    if (candidate.kind === "switch") return "switch";
    if (candidate.kind === "move") return "move";
    return candidate.kind ?? "action";
  }

  function renderPredictionChip(text, tone = "neutral") {
    const style = tone === "reason"
      ? "background:rgba(74,222,128,0.12);border-color:rgba(74,222,128,0.24)"
      : tone === "risk"
        ? "background:rgba(248,113,113,0.12);border-color:rgba(248,113,113,0.24)"
        : "background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.08)";
    return `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);${style};font-size:11px;line-height:1.2">${escapeHtml(text)}</span>`;
  }

  function formatPredictionScore(score) {
    return Number.isInteger(score) ? String(score) : Number(score).toFixed(1);
  }

  function renderOpponentActionPanelMarkup() {
    const localIntel = getLocalIntel();
    const prediction = localIntel?.opponentActionPrediction ?? null;
    const leadPrediction = localIntel?.opponentLeadPrediction ?? null;
    if (!prediction && leadPrediction) {
      const topCandidates = Array.isArray(leadPrediction.topCandidates) ? leadPrediction.topCandidates : [];
      return `
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(246,173,85,0.16);border-color:rgba(246,173,85,0.28);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">lead</strong>
            <span>${escapeHtml(leadPrediction.topLeadSpecies ?? "Unknown")}</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);${predictionConfidenceChipStyle(leadPrediction.confidenceTier)};font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">confidence</strong>
            <span>${escapeHtml(leadPrediction.confidenceTier)}</span>
          </span>
        </div>
        ${topCandidates.length > 0 ? `
          <div style="margin-top:10px;display:grid;gap:8px">
            ${topCandidates.slice(0, 3).map((candidate, index) => `
              <div style="padding:8px 9px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08)">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
                  <div>
                    <div style="font-weight:600">${index + 1}. ${escapeHtml(candidate.species ?? "Candidate")}</div>
                    <div style="margin-top:2px;font-size:11px;opacity:.62">${Number.isFinite(candidate.historicalLeadShare) ? `historical lead ${Math.round(Number(candidate.historicalLeadShare) * 100)}%` : "preview candidate"}</div>
                  </div>
                  <span style="font-size:11px;opacity:.74">${escapeHtml(formatPredictionScore(candidate.score))}</span>
                </div>
                ${candidate.reasons?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${candidate.reasons.slice(0, 2).map((reason) => renderPredictionChip(reason, "reason")).join("")}</div>` : ""}
                ${candidate.riskFlags?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${candidate.riskFlags.slice(0, 2).map((flag) => renderPredictionChip(flag, "risk")).join("")}</div>` : ""}
              </div>
            `).join("")}
          </div>
        ` : `<div style="margin-top:10px;opacity:.72">No ranked lead candidates yet.</div>`}
      `;
    }
    if (!prediction) {
      return `
        <div style="margin-top:10px;font-size:12px;opacity:.72">
          No opponent line-to-respect view yet for this board state.
        </div>
      `;
    }

    const topActions = Array.isArray(prediction.topActions) ? prediction.topActions : [];
    const classScores = prediction.classScores ?? null;

    return `
      ${renderBoardSummaryStrip(localIntel)}
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
        <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);${predictionClassChipStyle(prediction.topActionClass)};font-size:11px;line-height:1.2;white-space:nowrap">
          <strong style="font-weight:600">class</strong>
          <span>${escapeHtml(formatPredictionClassLabel(prediction.topActionClass))}</span>
        </span>
        <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);${predictionConfidenceChipStyle(prediction.confidenceTier)};font-size:11px;line-height:1.2;white-space:nowrap">
          <strong style="font-weight:600">confidence</strong>
          <span>${escapeHtml(prediction.confidenceTier)}</span>
        </span>
        ${classScores ? `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">stay</strong>
            <span>${escapeHtml(formatPredictionScore(classScores.stayAttack))}</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">switch</strong>
            <span>${escapeHtml(formatPredictionScore(classScores.switchOut))}</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">status</strong>
            <span>${escapeHtml(formatPredictionScore(classScores.statusOrSetup))}</span>
          </span>
        ` : ""}
      </div>
      ${topActions.length > 0 ? `
        <div style="margin-top:10px;display:grid;gap:8px">
          ${topActions.slice(0, 3).map((candidate, index) => `
            <div style="padding:8px 9px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08)">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
                <div>
                  <div style="font-weight:600">${index + 1}. ${escapeHtml(candidate.label ?? "Candidate")}</div>
                  <div style="margin-top:2px;font-size:11px;opacity:.62">${escapeHtml(formatPredictionClassLabel(candidate.actionClass))} · ${escapeHtml(formatPredictionSource(candidate))}</div>
                </div>
                <span style="font-size:11px;opacity:.74">${escapeHtml(formatPredictionScore(candidate.score))}</span>
              </div>
              ${candidate.reasons?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${candidate.reasons.slice(0, 2).map((reason) => renderPredictionChip(reason, "reason")).join("")}</div>` : ""}
              ${candidate.riskFlags?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${candidate.riskFlags.slice(0, 2).map((flag) => renderPredictionChip(flag, "risk")).join("")}</div>` : ""}
            </div>
          `).join("")}
        </div>
      ` : `<div style="margin-top:10px;opacity:.72">No ranked concrete action lines yet.</div>`}
    `;
  }

  function renderSelfActionPanelMarkup() {
    const localIntel = getLocalIntel();
    const recommendation = localIntel?.selfActionRecommendation ?? null;
    const leadRecommendation = localIntel?.playerLeadRecommendation ?? null;
    if (!recommendation && leadRecommendation) {
      const topCandidates = Array.isArray(leadRecommendation.topCandidates) ? leadRecommendation.topCandidates : [];
      return `
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(94,210,255,0.16);border-color:rgba(94,210,255,0.28);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">starter</strong>
            <span>${escapeHtml(leadRecommendation.topLeadSpecies ?? "Unknown")}</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);${predictionConfidenceChipStyle(leadRecommendation.confidenceTier)};font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">confidence</strong>
            <span>${escapeHtml(leadRecommendation.confidenceTier)}</span>
          </span>
        </div>
        ${topCandidates.length > 0 ? `
          <div style="margin-top:10px;display:grid;gap:8px">
            ${topCandidates.slice(0, 3).map((candidate, index) => `
              <div style="padding:8px 9px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08)">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
                  <div>
                    <div style="font-weight:600">${index + 1}. ${escapeHtml(candidate.species ?? "Starter")}</div>
                    <div style="margin-top:2px;font-size:11px;opacity:.62">preview starter candidate</div>
                  </div>
                  <span style="font-size:11px;opacity:.74">${escapeHtml(formatPredictionScore(candidate.score))}</span>
                </div>
                ${candidate.reasons?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${candidate.reasons.slice(0, 2).map((reason) => renderPredictionChip(reason, "reason")).join("")}</div>` : ""}
                ${candidate.riskFlags?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${candidate.riskFlags.slice(0, 2).map((flag) => renderPredictionChip(flag, "risk")).join("")}</div>` : ""}
              </div>
            `).join("")}
          </div>
        ` : `<div style="margin-top:10px;opacity:.72">No ranked starter candidates yet.</div>`}
      `;
    }
    if (!recommendation) {
      return `
        <div style="margin-top:10px;font-size:12px;opacity:.72">
          No self-recommendation yet for this board state.
        </div>
      `;
    }

    const rankedActions = Array.isArray(recommendation.rankedActions) ? recommendation.rankedActions : [];
    return `
      ${renderBoardSummaryStrip(localIntel)}
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
        <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(94,210,255,0.16);border-color:rgba(94,210,255,0.28);font-size:11px;line-height:1.2;white-space:nowrap">
          <strong style="font-weight:600">top</strong>
          <span>${escapeHtml(rankedActions[0]?.label ?? recommendation.topActionId ?? "Unknown")}</span>
        </span>
        <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);${predictionConfidenceChipStyle(recommendation.confidenceTier)};font-size:11px;line-height:1.2;white-space:nowrap">
          <strong style="font-weight:600">confidence</strong>
          <span>${escapeHtml(recommendation.confidenceTier)}</span>
        </span>
      </div>
      ${rankedActions.length > 0 ? `
        <div style="margin-top:10px;display:grid;gap:8px">
          ${rankedActions.slice(0, 4).map((candidate, index) => `
            <div style="padding:8px 9px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08)">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
                <div>
                  <div style="font-weight:600">${index + 1}. ${escapeHtml(candidate.label ?? "Action")}</div>
                  <div style="margin-top:2px;font-size:11px;opacity:.62">${escapeHtml(formatSelfActionKind(candidate))}</div>
                </div>
                <span style="font-size:11px;opacity:.74">${escapeHtml(formatPredictionScore(candidate.score))}</span>
              </div>
              ${candidate.reasons?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${candidate.reasons.slice(0, 3).map((reason) => renderPredictionChip(reason, "reason")).join("")}</div>` : ""}
              ${candidate.riskFlags?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${candidate.riskFlags.slice(0, 2).map((flag) => renderPredictionChip(flag, "risk")).join("")}</div>` : ""}
            </div>
          `).join("")}
        </div>
      ` : `<div style="margin-top:10px;opacity:.72">No ranked legal actions yet.</div>`}
    `;
  }

  function renderIntelPanelMarkup() {
    const localIntel = getLocalIntel();
    const opponents = Array.isArray(localIntel?.opponents) ? localIntel.opponents : [];
    if (opponents.length === 0) {
      return `
        <div style="margin-top:6px;font-size:11px;opacity:.6">${localIntel?.note ?? ""}</div>
        <div style="margin-top:10px;font-size:12px;opacity:.72">
          No local opponent intel yet. Play more battles in this format and this panel will fill in automatically.
        </div>
      `;
    }
    return `
      <div style="margin-top:6px;font-size:11px;opacity:.6">${localIntel?.note ?? ""}</div>
      ${opponents
        .map(
          (entry) => `
            <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)">
              <div style="font-weight:600">${entry.species}</div>
              ${renderCurrentReveal(entry)}
              ${renderLikelihoodList("Likely other moves", entry.likelyMoves)}
              ${entry.revealedItem ? "" : renderLikelihoodList("Likely items", entry.likelyItems)}
              ${entry.revealedAbility ? "" : renderLikelihoodList("Likely abilities", entry.likelyAbilities)}
              ${entry.revealedTeraType || entry.currentTerastallized ? "" : renderLikelihoodList("Likely Tera types", entry.likelyTeraTypes)}
            </div>
          `
        )
        .join("")}
    `;
  }

  function renderDamagePanelMarkup() {
    const localIntel = getLocalIntel();
    const playerDamagePreview = Array.isArray(localIntel?.playerDamagePreview) ? localIntel.playerDamagePreview : [];
    const opponentThreatPreview = Array.isArray(localIntel?.opponentThreatPreview) ? localIntel.opponentThreatPreview : [];
    const opponentActionPrediction = localIntel?.opponentActionPrediction ?? null;

    const yourMoves = playerDamagePreview.length
      ? `
          <div style="margin-top:8px;font-weight:600">Your moves</div>
          ${playerDamagePreview
            .map(
              (entry) => {
                const switchInRows = collectSwitchInRowsForMove(opponentActionPrediction, entry.moveName ?? entry.label);
                return `
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
                  <div style="font-weight:600">${entry.label}</div>
                  <div style="margin-top:2px;font-size:11px;opacity:.62">${entry.targetName ?? "Opponent active"}</div>
                  ${renderDamageBandRow(entry.bands, entry.targetCurrentHpPercent, entry.likelyBandSource)}
                  ${renderObservedDamageNote(entry.observedRange)}
                  ${renderCaveatChips(entry.survivalCaveats)}
                  ${renderInteractionHints(entry.interactionHints)}
                  ${renderSwitchDamagePeek("switch-ins", switchInRows)}
                </div>
              `;
              }
            )
            .join("")}
        `
      : `<div style="margin-top:8px;opacity:.72">No player move damage preview yet.</div>`;

    const threats = opponentThreatPreview.length
      ? `
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)">
            <div style="font-weight:600">Opponent threats</div>
            ${opponentThreatPreview
              .map(
                (entry) => {
                  const switchRows = collectThreatSwitchRows(entry);
                  return `
                  <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
                  <div style="font-weight:600">${entry.moveName ?? entry.label ?? "Likely move"}${entry.moveSource ? ` · ${entry.moveSource}` : ""}</div>
                  <div style="margin-top:2px;font-size:11px;opacity:.62">${entry.currentTarget?.species ?? "Your active"}</div>
                    ${renderDamageBandRow(entry.currentTarget?.bands, entry.currentTarget?.targetCurrentHpPercent, entry.currentTarget?.likelyBandSource)}
                    ${renderObservedDamageNote(entry.currentTarget?.observedRange)}
                    ${renderInteractionHints(entry.currentTarget?.interactionHints)}
                    ${renderSwitchDamagePeek("your switches", switchRows)}
                  </div>
                `;
                }
              )
              .join("")}
          </div>
        `
      : "";

    return `
      ${yourMoves}
      ${threats}
    `;
  }

  function renderMechanicsPanelMarkup() {
    const localIntel = getLocalIntel();
    const speedPreview = localIntel?.speedPreview ?? null;
    const possibleRange = speedPreview?.possibleRange ?? null;
    const switchSpeedMatchups = Array.isArray(speedPreview?.switchMatchups) ? speedPreview.switchMatchups : [];
    const speedNotes = Array.isArray(speedPreview?.historyNotes) ? speedPreview.historyNotes : [];
    const switchSpeedMarkup = switchSpeedMatchups.length > 0
      ? `${switchSpeedMatchups.map((matchup) => renderCompactChip(
          matchup.species ?? matchup.label ?? "Unknown",
          `${Number.isFinite(matchup.effectiveSpeed) ? Math.round(matchup.effectiveSpeed) : "?"} · ${formatSwitchSpeedText(matchup, possibleRange)}`,
          matchup.relation === "faster" ? "positive" : matchup.relation === "slower" ? "danger" : "neutral",
          `${matchup.species ?? matchup.label ?? "Unknown"}: ${Number.isFinite(matchup.effectiveSpeed) ? `${Math.round(matchup.effectiveSpeed)} Speed` : "unknown Speed"}; ${formatSwitchSpeedText(matchup, possibleRange)}`
        )).join("")}`
      : "";

    return `
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start">
        ${renderMechanicsCard(
          "Speed",
          `
            ${renderSpeedSummaryMarkup(speedPreview, speedPreview?.activeRelation ?? "unknown")}
            ${renderSpeedEvidence(speedPreview)}
            ${switchSpeedMarkup ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${switchSpeedMarkup}</div>` : ""}
          `,
          speedNotes.length > 0 ? speedNotes.join(" ") : ""
        )}
      </div>
    `;
  }

  function renderDebugPanelMarkup() {
    const debugBundle = {
      requestId: latestOverlayPayload?.requestId ?? null,
      compareMode: Boolean(latestOverlayPayload?.compareResults?.length),
      health: overlayHealth ?? null,
      snapshot: latestOverlayPayload?.snapshot ?? null,
      localIntel: latestLocalIntelPayload?.localIntel ?? latestOverlayPayload?.localIntel ?? null,
      providerDebug: latestOverlayPayload?.providerDebug ?? null,
      compareResults: latestOverlayPayload?.compareResults ?? null
    };
    const serialized = JSON.stringify(debugBundle, null, 2);
    const escaped = serialized
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `
      <div style="margin-top:6px;font-size:11px;opacity:.62">Inspect the exact snapshot, local intel, provider metadata, and health used by the overlay.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button id="${OVERLAY_ID}-debug-copy" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:7px 9px;border-radius:8px;font:inherit;cursor:pointer">Copy JSON</button>
        <button id="${OVERLAY_ID}-debug-download" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:7px 9px;border-radius:8px;font:inherit;cursor:pointer">Download JSON</button>
      </div>
      <details style="margin-top:10px" open>
        <summary style="cursor:pointer;opacity:.84">Live debug bundle</summary>
        <pre style="margin-top:8px;white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,0.04);padding:10px;border-radius:10px;max-height:480px;overflow:auto">${escaped}</pre>
      </details>
    `;
  }

  function renderPanelBody(panelKey) {
    if (panelKey === "intel") return renderIntelPanelMarkup();
    if (panelKey === "opponentAction") return renderOpponentActionPanelMarkup();
    if (panelKey === "selfAction") return renderSelfActionPanelMarkup();
    if (panelKey === "damage") return renderDamagePanelMarkup();
    if (panelKey === "mechanics") return renderMechanicsPanelMarkup();
    if (panelKey === "debug") return renderDebugPanelMarkup();
    return '<div style="margin-top:8px;opacity:.72">No panel renderer configured.</div>';
  }

  function currentDebugBundle() {
    return {
      requestId: latestOverlayPayload?.requestId ?? null,
      compareMode: Boolean(latestOverlayPayload?.compareResults?.length),
      health: overlayHealth ?? null,
      snapshot: latestOverlayPayload?.snapshot ?? null,
      localIntel: latestLocalIntelPayload?.localIntel ?? latestOverlayPayload?.localIntel ?? null,
      providerDebug: latestOverlayPayload?.providerDebug ?? null,
      compareResults: latestOverlayPayload?.compareResults ?? null
    };
  }

  async function copyDebugBundle() {
    const text = JSON.stringify(currentDebugBundle(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore clipboard failures.
    }
  }

  function downloadDebugBundle() {
    const text = JSON.stringify(currentDebugBundle(), null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `showdnass-debug-${Date.now()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clampPanelPosition(element, left, top) {
    const width = element.offsetWidth || 360;
    const height = element.offsetHeight || 240;
    const minLeft = 8;
    const minTop = 8;
    const maxLeft = Math.max(minLeft, window.innerWidth - width - 8);
    const maxTop = Math.max(minTop, window.innerHeight - height - 8);
    return {
      left: Math.min(Math.max(left, minLeft), maxLeft),
      top: Math.min(Math.max(top, minTop), maxTop)
    };
  }

  function clampResizableWidth(width, fallbackWidth) {
    const minWidth = 260;
    const maxWidth = Math.max(minWidth, window.innerWidth - 24);
    const nextWidth = Number.isFinite(width) ? width : fallbackWidth;
    return Math.min(Math.max(nextWidth, minWidth), maxWidth);
  }

  function clampResizableHeight(height, fallbackHeight) {
    const minHeight = 180;
    const maxHeight = Math.max(minHeight, window.innerHeight - 24);
    const nextHeight = Number.isFinite(height) ? height : fallbackHeight;
    return Math.min(Math.max(nextHeight, minHeight), maxHeight);
  }

  function applyOverlayPosition(overlay, left, top) {
    const next = clampPanelPosition(overlay, left, top);
    overlay.style.left = `${next.left}px`;
    overlay.style.top = `${next.top}px`;
    overlay.style.right = "auto";
    overlay.style.bottom = "auto";
    saveOverlayPosition(next.left, next.top);
  }

  function applyPanelPosition(panel, panelKey, left, top, persist) {
    const next = clampPanelPosition(panel, left, top);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    if (persist) savePanelPosition(panelKey, next.left, next.top);
  }

  function installPanelDrag(panel, onMove) {
    const handle = panel.querySelector("[data-overlay-drag-handle]");
    if (!handle) return;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      bringToFront(panel);
      const rect = panel.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const move = (moveEvent) => {
        onMove(panel, moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    });
  }

  function installHorizontalResize(element, getWidthKey, fallbackWidth) {
    const handle = element.querySelector("[data-overlay-resize-handle]");
    if (!handle) return;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      bringToFront(element);
      const rect = element.getBoundingClientRect();
      const startWidth = rect.width;
      const startX = event.clientX;
      const move = (moveEvent) => {
        const nextWidth = clampResizableWidth(startWidth + (moveEvent.clientX - startX), fallbackWidth);
        element.style.width = `${nextWidth}px`;
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        const finalWidth = clampResizableWidth(element.getBoundingClientRect().width, fallbackWidth);
        element.style.width = `${finalWidth}px`;
        saveWidthSetting(getWidthKey(), finalWidth);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    });
  }

  function installVerticalResize(element, getHeightKey, fallbackHeight) {
    const handle = element.querySelector("[data-overlay-resize-handle-y]");
    if (!handle) return;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      bringToFront(element);
      const rect = element.getBoundingClientRect();
      const startHeight = rect.height;
      const startY = event.clientY;
      const move = (moveEvent) => {
        const nextHeight = clampResizableHeight(startHeight + (moveEvent.clientY - startY), fallbackHeight);
        element.style.height = `${nextHeight}px`;
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        const finalHeight = clampResizableHeight(element.getBoundingClientRect().height, fallbackHeight);
        element.style.height = `${finalHeight}px`;
        saveHeightSetting(getHeightKey(), finalHeight);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    });
  }

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      "position: fixed",
      "top: 12px",
      "right: 12px",
      "z-index: 10006",
      "width: 440px",
      "max-width: calc(100vw - 24px)",
      "max-height: calc(100vh - 24px)",
      "overflow:auto",
      "background: rgba(10, 10, 12, 0.98)",
      "color: #fff",
      "border: 1px solid rgba(255,255,255,0.1)",
      "border-radius: 12px",
      "padding: 12px 14px",
      "box-shadow: 0 10px 30px rgba(0,0,0,0.35)",
      "font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    ].join(";");
    const savedWidth = loadWidthSetting(OVERLAY_WIDTH_KEY);
    overlay.style.width = `${clampResizableWidth(savedWidth, 440)}px`;
    const savedHeight = loadHeightSetting(OVERLAY_HEIGHT_KEY);
    if (savedHeight) {
      overlay.style.height = `${clampResizableHeight(savedHeight, 520)}px`;
    }
    document.documentElement.appendChild(overlay);
    bringToFront(overlay);
    overlay.addEventListener("pointerdown", () => bringToFront(overlay));

    const savedPosition = loadOverlayPosition();
    if (savedPosition) {
      applyOverlayPosition(overlay, savedPosition.left, savedPosition.top);
    }
    return overlay;
  }

  function ensurePanel(panelKey) {
    const def = getPanelDef(panelKey);
    if (!def) return null;
    let panel = document.getElementById(def.id);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = def.id;
    panel.dataset.panelKey = panelKey;
    panel.style.cssText = [
      "position: fixed",
      "top: 12px",
      "left: 464px",
      `z-index: ${def.zIndex}`,
      `width: ${def.width}px`,
      "max-width: calc(100vw - 24px)",
      "max-height: calc(100vh - 24px)",
      "overflow:auto",
      `background: ${def.background}`,
      "color: #fff",
      `border: 1px solid ${def.border}`,
      "border-radius: 12px",
      "padding: 12px 14px",
      "box-shadow: 0 10px 30px rgba(0,0,0,0.35)",
      "font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "display:none"
    ].join(";");
    const savedWidth = loadWidthSetting(panelWidthKey(panelKey));
    panel.style.width = `${clampResizableWidth(savedWidth, def.width)}px`;
    document.documentElement.appendChild(panel);
    bringToFront(panel);
    panel.addEventListener("pointerdown", () => bringToFront(panel));

    const savedPosition = loadPanelPosition(panelKey);
    if (savedPosition) {
      applyPanelPosition(panel, panelKey, savedPosition.left, savedPosition.top, false);
    }
    return panel;
  }

  function defaultPanelPosition(panelKey) {
    const panelIndex = Math.max(0, PANEL_DEFS.findIndex((panel) => panel.key === panelKey));
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      const overlayRect = overlay.getBoundingClientRect();
      return {
        left: overlayRect.right + 12,
        top: overlayRect.top + (panelIndex * 72)
      };
    }
    return {
      left: 464,
      top: 12 + (panelIndex * 72)
    };
  }

  function renderPanel(panelKey) {
    const def = getPanelDef(panelKey);
    const state = getPanelState(panelKey);
    const panel = ensurePanel(panelKey);
    if (!def || !panel) return;
    const collapsed = Boolean(state.collapsed);
    const collapsedWidth = Math.min(def.width, 240);

    if (collapsed) {
      panel.innerHTML = `
          <div data-overlay-drag-handle style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move">
            <div style="font-size:12px;font-weight:700;letter-spacing:.04em;opacity:.92">${def.title}</div>
            <div style="display:flex;align-items:center;gap:6px">
              ${overlaySettings.panelLayout === "sidebar" ? `<button id="${def.id}-dock-c" title="Dock to sidebar" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer;font-size:11px">\u21A9</button>` : ""}
              <button id="${def.id}-expand" title="Expand" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">+</button>
              <button id="${def.id}-hide" title="Close" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">\u00d7</button>
            </div>
          </div>
          <div data-overlay-resize-handle title="Resize width" style="position:absolute;top:6px;right:-4px;width:10px;height:28px;cursor:ew-resize;opacity:.28;background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
        `;

      panel.style.padding = "8px 10px";
      panel.style.width = `${collapsedWidth}px`;
      panel.style.height = "auto";
      panel.style.maxHeight = "40px";
      panel.style.overflow = "hidden";
      installPanelDrag(panel, (element, left, top) => {
        applyPanelPosition(element, panelKey, left, top, true);
      });
      panel.querySelector(`#${def.id}-dock-c`)?.addEventListener("click", () => {
        setPanelDocked(panelKey, true);
      });
      panel.querySelector(`#${def.id}-expand`)?.addEventListener("click", () => {
        setPanelCollapsed(panelKey, false);
      });
      panel.querySelector(`#${def.id}-hide`)?.addEventListener("click", () => {
        setPanelVisible(panelKey, false);
      });
      installHorizontalResize(panel, () => panelWidthKey(panelKey), def.width);
      panel.addEventListener("dblclick", () => setPanelCollapsed(panelKey, false), { once: true });
      return;
    }

    panel.style.padding = "12px 14px";
    panel.style.width = `${clampResizableWidth(loadWidthSetting(panelWidthKey(panelKey)), def.width)}px`;
    panel.style.maxHeight = "calc(100vh - 24px)";
    panel.style.overflow = "auto";
    const savedHeight = loadHeightSetting(panelHeightKey(panelKey));
    panel.style.height = savedHeight ? `${clampResizableHeight(savedHeight, 420)}px` : "auto";

    panel.innerHTML = `
      <div data-overlay-drag-handle style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:move">
        <div>
          <div style="font-size:12px;opacity:.7">${BRAND_NAME}</div>
          <div style="font-size:15px;font-weight:700;margin-top:2px">${def.title}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${overlaySettings.panelLayout === "sidebar" ? `<button id="${def.id}-dock" title="Dock to sidebar" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer;font-size:13px">\u21A9</button><button id="${def.id}-group" title="Group with panel" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer;font-size:13px">\u229E</button>` : ""}
          <button id="${def.id}-collapse" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer">\u2212</button>
          <button id="${def.id}-hide" title="Close" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer">\u00d7</button>
        </div>
      </div>
      <div style="margin-top:8px;font-size:12px;opacity:.68">Turn ${latestLocalIntelPayload?.turn ?? "?"}${latestLocalIntelPayload?.status ? ` \u00b7 ${formatTabStatusLabel(latestLocalIntelPayload.status)}` : ""}</div>
      ${renderPanelBody(panelKey)}
      <div data-overlay-resize-handle title="Resize width" style="position:absolute;top:10px;right:-4px;width:10px;height:calc(100% - 20px);cursor:ew-resize;opacity:.22;background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
      <div data-overlay-resize-handle-y title="Resize height" style="position:absolute;left:10px;right:10px;bottom:-4px;height:10px;cursor:ns-resize;opacity:.22;background:linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
    `;

    installPanelDrag(panel, (element, left, top) => {
      applyPanelPosition(element, panelKey, left, top, true);
    });
    installHorizontalResize(panel, () => panelWidthKey(panelKey), def.width);
    installVerticalResize(panel, () => panelHeightKey(panelKey), 420);

    panel.querySelector(`#${def.id}-dock`)?.addEventListener("click", () => {
      setPanelDocked(panelKey, true);
    });
    panel.querySelector(`#${def.id}-group`)?.addEventListener("click", () => {
      showGroupPickList(panelKey, panel.querySelector(`#${def.id}-group`));
    });
    panel.querySelector(`#${def.id}-hide`)?.addEventListener("click", () => {
      setPanelVisible(panelKey, false);
    });
    panel.querySelector(`#${def.id}-collapse`)?.addEventListener("click", () => {
      setPanelCollapsed(panelKey, true);
    });
    if (panelKey === "debug") {
      panel.querySelector(`#${OVERLAY_ID}-debug-copy`)?.addEventListener("click", () => {
        void copyDebugBundle();
      });
      panel.querySelector(`#${OVERLAY_ID}-debug-download`)?.addEventListener("click", () => {
        downloadDebugBundle();
      });
    }
  }

  // ── Sidebar mode ──────────────────────────────────────────────

  function defaultSidebarPosition() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      const rect = overlay.getBoundingClientRect();
      return { left: rect.right + 12, top: rect.top };
    }
    return { left: 464, top: 12 };
  }

  function ensureSidebarStyles() {
    if (document.getElementById("showdnass-sidebar-styles")) return;
    const style = document.createElement("style");
    style.id = "showdnass-sidebar-styles";
    style.textContent = `
      #showdnass-sidebar [data-sidebar-tab]:hover {
        background: rgba(255,255,255,0.10) !important;
      }
      #showdnass-sidebar [data-sidebar-tab][data-active="true"] {
        border-bottom: 2px solid #5b7cff !important;
        color: #fff !important;
        opacity: 1 !important;
      }
      #showdnass-sidebar [data-sidebar-content] {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 10px 14px;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureSidebar() {
    let sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar) return sidebar;

    sidebar = document.createElement("div");
    sidebar.id = SIDEBAR_ID;
    sidebar.style.cssText = [
      "position: fixed",
      "top: 12px",
      "right: 12px",
      "z-index: 10006",
      "width: 400px",
      "max-width: calc(100vw - 24px)",
      "max-height: calc(100vh - 24px)",
      "overflow: hidden",
      "background: rgba(10, 10, 12, 0.98)",
      "color: #fff",
      "border: 1px solid rgba(255,255,255,0.1)",
      "border-radius: 12px",
      "box-shadow: 0 10px 30px rgba(0,0,0,0.35)",
      "font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "display: flex",
      "flex-direction: column"
    ].join(";");

    const savedWidth = loadWidthSetting(SIDEBAR_WIDTH_KEY);
    sidebar.style.width = `${clampResizableWidth(savedWidth, 400)}px`;
    const savedHeight = loadHeightSetting(SIDEBAR_HEIGHT_KEY);
    sidebar.style.height = savedHeight
      ? `${clampResizableHeight(savedHeight, 520)}px`
      : "calc(100vh - 24px)";

    sidebar.tabIndex = 0;
    sidebar.style.outline = "none";
    document.documentElement.appendChild(sidebar);
    bringToFront(sidebar);
    sidebar.addEventListener("pointerdown", () => {
      bringToFront(sidebar);
      sidebar.focus();
    });

    const savedPosition = loadPositionSetting(SIDEBAR_POSITION_KEY);
    if (savedPosition) {
      const clamped = clampPanelPosition(sidebar, savedPosition.left, savedPosition.top);
      sidebar.style.left = `${clamped.left}px`;
      sidebar.style.top = `${clamped.top}px`;
      sidebar.style.right = "auto";
    } else {
      const pos = defaultSidebarPosition();
      const clamped = clampPanelPosition(sidebar, pos.left, pos.top);
      sidebar.style.left = `${clamped.left}px`;
      sidebar.style.top = `${clamped.top}px`;
      sidebar.style.right = "auto";
    }

    ensureSidebarStyles();
    return sidebar;
  }

  function resolveActiveTab() {
    const visibleKeys = PANEL_DEFS
      .filter(def => { const s = getPanelState(def.key); return s.visible && s.docked; })
      .map(def => def.key);
    if (visibleKeys.length === 0) return null;
    if (visibleKeys.includes(sidebarActiveTab)) return sidebarActiveTab;
    sidebarActiveTab = visibleKeys[0];
    saveStringSetting(SIDEBAR_ACTIVE_TAB_KEY, sidebarActiveTab);
    return sidebarActiveTab;
  }

  function wireSidebarContentListeners(sidebar, panelKey) {
    if (panelKey === "debug") {
      sidebar.querySelector(`#${OVERLAY_ID}-debug-copy`)?.addEventListener("click", () => {
        void copyDebugBundle();
      });
      sidebar.querySelector(`#${OVERLAY_ID}-debug-download`)?.addEventListener("click", () => {
        downloadDebugBundle();
      });
    }
  }

  function renderSidebar() {
    const sidebar = ensureSidebar();
    sidebar.style.display = "flex";
    const activeTab = resolveActiveTab();

    if (sidebarCollapsed) {
      sidebar.innerHTML = `
        <div data-overlay-drag-handle style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;padding:8px 10px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.04em;opacity:.92">${BRAND_NAME}</div>
          <div style="display:flex;align-items:center;gap:6px">
            <button id="${SIDEBAR_ID}-expand" title="Expand" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">+</button>
            <button id="${SIDEBAR_ID}-hide" title="Close" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">×</button>
          </div>
        </div>
      `;
      sidebar.style.height = "auto";
      sidebar.style.maxHeight = "40px";
      sidebar.style.overflow = "hidden";

      installPanelDrag(sidebar, (el, left, top) => {
        const clamped = clampPanelPosition(el, left, top);
        el.style.left = `${clamped.left}px`;
        el.style.top = `${clamped.top}px`;
        el.style.right = "auto";
        savePositionSetting(SIDEBAR_POSITION_KEY, clamped.left, clamped.top);
      });

      sidebar.querySelector(`#${SIDEBAR_ID}-expand`)?.addEventListener("click", () => {
        sidebarCollapsed = false;
        saveBooleanSetting(SIDEBAR_COLLAPSED_KEY, false);
        renderSidebar();
      });
      sidebar.querySelector(`#${SIDEBAR_ID}-hide`)?.addEventListener("click", () => {
        sidebar.style.display = "none";
      });
      return;
    }

    // Expanded state — only show docked+visible panels as tabs
    const visibleTabs = PANEL_DEFS.filter(def => {
      const s = getPanelState(def.key);
      return s.visible && s.docked;
    });

    const tabStripHtml = visibleTabs.map((def, idx) => {
      const isActive = def.key === activeTab;
      const label = SIDEBAR_TAB_LABELS[def.key] || def.title;
      const num = idx + 1;
      return `<button data-sidebar-tab data-tab-key="${def.key}" data-active="${isActive}"
        style="appearance:none;border:none;border-bottom:2px solid transparent;background:none;color:#fff;opacity:${isActive ? "1" : ".6"};padding:8px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:4px"
      ><span style="font-size:10px;opacity:.5;font-weight:400">${num}</span>${label}<span data-undock-key="${def.key}" title="Pop out" style="font-size:10px;opacity:.35;cursor:pointer;margin-left:2px">\u29C9</span></button>`;
    }).join("");

    const contentHtml = activeTab
      ? renderPanelBody(activeTab)
      : '<div style="padding:20px;opacity:.6">Enable panels in the popup to see them here.</div>';

    const turnLabel = latestLocalIntelPayload?.turn ?? "?";
    const statusLabel = latestLocalIntelPayload?.status
      ? ` · ${formatTabStatusLabel(latestLocalIntelPayload.status)}`
      : "";

    sidebar.style.height = loadHeightSetting(SIDEBAR_HEIGHT_KEY)
      ? `${clampResizableHeight(loadHeightSetting(SIDEBAR_HEIGHT_KEY), 520)}px`
      : "calc(100vh - 24px)";
    sidebar.style.maxHeight = "calc(100vh - 24px)";
    sidebar.style.overflow = "hidden";

    sidebar.innerHTML = `
      <div data-overlay-drag-handle style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:move;padding:10px 14px 0">
        <div>
          <div style="font-size:12px;opacity:.7">${BRAND_NAME}</div>
          <div style="font-size:11px;opacity:.55;margin-top:2px">Turn ${turnLabel}${statusLabel}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button id="${SIDEBAR_ID}-collapse" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">\u2212</button>
          <button id="${SIDEBAR_ID}-hide" title="Close" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">\u00d7</button>
        </div>
      </div>
      <div style="display:flex;border-bottom:1px solid rgba(255,255,255,0.08);margin-top:6px;padding:0 10px;overflow-x:auto">
        ${tabStripHtml}
      </div>
      <div data-sidebar-content>
        ${contentHtml}
      </div>
      <div data-overlay-resize-handle title="Resize width" style="position:absolute;top:10px;right:-4px;width:10px;height:calc(100% - 20px);cursor:ew-resize;opacity:.22;background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
      <div data-overlay-resize-handle-y title="Resize height" style="position:absolute;left:10px;right:10px;bottom:-4px;height:10px;cursor:ns-resize;opacity:.22;background:linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
    `;

    // Wire event listeners
    installPanelDrag(sidebar, (el, left, top) => {
      const clamped = clampPanelPosition(el, left, top);
      el.style.left = `${clamped.left}px`;
      el.style.top = `${clamped.top}px`;
      el.style.right = "auto";
      savePositionSetting(SIDEBAR_POSITION_KEY, clamped.left, clamped.top);
    });
    installHorizontalResize(sidebar, () => SIDEBAR_WIDTH_KEY, 400);
    installVerticalResize(sidebar, () => SIDEBAR_HEIGHT_KEY, 520);

    sidebar.querySelector(`#${SIDEBAR_ID}-collapse`)?.addEventListener("click", () => {
      sidebarCollapsed = true;
      saveBooleanSetting(SIDEBAR_COLLAPSED_KEY, true);
      renderSidebar();
    });
    sidebar.querySelector(`#${SIDEBAR_ID}-hide`)?.addEventListener("click", () => {
      sidebar.style.display = "none";
    });

    // Tab click listeners
    for (const btn of sidebar.querySelectorAll("[data-sidebar-tab]")) {
      btn.addEventListener("click", (e) => {
        // If undock icon was clicked, undock instead of switching
        if (e.target.closest("[data-undock-key]")) return;
        const key = btn.dataset.tabKey;
        if (key === sidebarActiveTab) return;
        switchSidebarTab(sidebar, key);
      });
    }

    // Undock click listeners
    for (const icon of sidebar.querySelectorAll("[data-undock-key]")) {
      icon.addEventListener("click", (e) => {
        e.stopPropagation();
        setPanelDocked(icon.dataset.undockKey, false);
      });
    }

    // Keyboard: number keys switch tabs when sidebar is focused
    sidebar.addEventListener("keydown", (e) => {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= visibleTabs.length) {
        e.preventDefault();
        e.stopPropagation();
        const targetDef = visibleTabs[num - 1];
        if (targetDef) switchSidebarTab(sidebar, targetDef.key);
      }
      if (e.key === "Escape") {
        sidebar.blur();
      }
    });

    wireSidebarContentListeners(sidebar, activeTab);
  }

  function switchSidebarTab(sidebar, key) {
    sidebarActiveTab = key;
    saveStringSetting(SIDEBAR_ACTIVE_TAB_KEY, key);
    for (const tab of sidebar.querySelectorAll("[data-sidebar-tab]")) {
      tab.dataset.active = String(tab.dataset.tabKey === key);
      tab.style.opacity = tab.dataset.tabKey === key ? "1" : ".6";
    }
    const contentArea = sidebar.querySelector("[data-sidebar-content]");
    if (contentArea) {
      contentArea.innerHTML = renderPanelBody(key);
      wireSidebarContentListeners(sidebar, key);
    }
  }

  // ── Layout branching ─────────────────────────────────────────

  function hideAllClassicPanels() {
    for (const def of PANEL_DEFS) {
      const panel = document.getElementById(def.id);
      if (panel) panel.style.display = "none";
    }
  }

  function hideSidebar() {
    const sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar) sidebar.style.display = "none";
  }

  function showGroupPickList(panelKey, anchorEl) {
    // Remove any existing pick list
    document.getElementById("showdnass-group-picklist")?.remove();

    // Collect targets: other undocked visible panels or existing groups
    const targets = [];
    const seenGroups = new Set();
    for (const def of PANEL_DEFS) {
      if (def.key === panelKey) continue;
      const s = getPanelState(def.key);
      if (!s.visible || s.docked) continue;
      if (s.group) {
        if (seenGroups.has(s.group)) continue;
        seenGroups.add(s.group);
        const members = getVisibleGroupMembers(s.group);
        const label = members.map(k => SIDEBAR_TAB_LABELS[k] || k).join(" + ");
        targets.push({ type: "group", groupId: s.group, label: `Group: ${label}` });
      } else {
        const label = SIDEBAR_TAB_LABELS[def.key] || def.title;
        targets.push({ type: "panel", key: def.key, label });
      }
    }

    if (targets.length === 0) return;

    const list = document.createElement("div");
    list.id = "showdnass-group-picklist";
    list.style.cssText = [
      "position: fixed",
      "z-index: 99999",
      "background: rgba(20, 20, 24, 0.98)",
      "border: 1px solid rgba(255,255,255,0.15)",
      "border-radius: 8px",
      "box-shadow: 0 8px 24px rgba(0,0,0,0.4)",
      "padding: 4px",
      "font: 12px/1.4 system-ui, -apple-system, sans-serif",
      "color: #fff",
      "min-width: 140px"
    ].join(";");

    for (const target of targets) {
      const row = document.createElement("div");
      row.textContent = target.label;
      row.style.cssText = "padding:8px 12px;cursor:pointer;border-radius:6px;white-space:nowrap";
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,0.1)"; });
      row.addEventListener("mouseleave", () => { row.style.background = "none"; });
      row.addEventListener("click", () => {
        list.remove();
        if (target.type === "group") {
          setPanelGroup(panelKey, target.groupId);
        } else {
          // Create new group with the target panel as host
          setPanelGroup(panelKey, target.key);
        }
      });
      list.appendChild(row);
    }

    document.documentElement.appendChild(list);

    // Position near the anchor button
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      list.style.left = `${rect.left}px`;
      list.style.top = `${rect.bottom + 4}px`;
    }

    // Dismiss on click outside
    const dismiss = (e) => {
      if (!list.contains(e.target)) {
        list.remove();
        document.removeEventListener("pointerdown", dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
  }

  function ensureGroupContainer(groupId) {
    const domId = GROUP_DOM_PREFIX + groupId;
    let container = document.getElementById(domId);
    if (container) return container;

    container = document.createElement("div");
    container.id = domId;
    container.tabIndex = 0;
    container.style.cssText = [
      "position: fixed",
      "top: 80px",
      "right: 12px",
      "z-index: 10006",
      "width: 380px",
      "max-width: calc(100vw - 24px)",
      "max-height: calc(100vh - 24px)",
      "overflow: hidden",
      "background: rgba(10, 10, 12, 0.98)",
      "color: #fff",
      "border: 1px solid rgba(255,255,255,0.12)",
      "border-radius: 12px",
      "box-shadow: 0 10px 30px rgba(0,0,0,0.35)",
      "font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "display: flex",
      "flex-direction: column",
      "outline: none"
    ].join(";");

    const savedWidth = loadWidthSetting(groupWidthKey(groupId));
    if (savedWidth) container.style.width = `${clampResizableWidth(savedWidth, 380)}px`;
    const savedHeight = loadHeightSetting(groupHeightKey(groupId));
    if (savedHeight) container.style.height = `${clampResizableHeight(savedHeight, 300)}px`;

    document.documentElement.appendChild(container);
    bringToFront(container);
    container.addEventListener("pointerdown", () => {
      bringToFront(container);
      container.focus();
    });

    const savedPosition = loadPositionSetting(groupPositionKey(groupId));
    if (savedPosition) {
      const clamped = clampPanelPosition(container, savedPosition.left, savedPosition.top);
      container.style.left = `${clamped.left}px`;
      container.style.top = `${clamped.top}px`;
      container.style.right = "auto";
    } else {
      // Place near center-ish
      const left = Math.max(12, window.innerWidth / 2 - 190);
      const clamped = clampPanelPosition(container, left, 80);
      container.style.left = `${clamped.left}px`;
      container.style.top = `${clamped.top}px`;
      container.style.right = "auto";
    }

    ensureSidebarStyles();
    return container;
  }

  function renderPanelGroup(groupId) {
    const memberKeys = getVisibleGroupMembers(groupId);
    if (memberKeys.length === 0) return;

    const container = ensureGroupContainer(groupId);
    container.style.display = "flex";

    const collapsed = loadBooleanSetting(groupCollapsedKey(groupId), false);

    if (collapsed) {
      const firstDef = getPanelDef(memberKeys[0]);
      const title = memberKeys.map(k => SIDEBAR_TAB_LABELS[k] || k).join(" + ");
      container.innerHTML = `
        <div data-overlay-drag-handle style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;padding:8px 10px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.04em;opacity:.92">${title}</div>
          <div style="display:flex;align-items:center;gap:6px">
            <button data-group-expand title="Expand" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">+</button>
          </div>
        </div>
      `;
      container.style.height = "auto";
      container.style.maxHeight = "40px";
      container.style.overflow = "hidden";

      installPanelDrag(container, (el, left, top) => {
        const clamped = clampPanelPosition(el, left, top);
        el.style.left = `${clamped.left}px`;
        el.style.top = `${clamped.top}px`;
        el.style.right = "auto";
        savePositionSetting(groupPositionKey(groupId), clamped.left, clamped.top);
      });
      container.querySelector("[data-group-expand]")?.addEventListener("click", () => {
        saveBooleanSetting(groupCollapsedKey(groupId), false);
        renderPanelGroup(groupId);
      });
      return;
    }

    // Resolve active tab for this group
    let activeKey = loadStringSetting(groupActiveTabKey(groupId), memberKeys[0]);
    if (!memberKeys.includes(activeKey)) activeKey = memberKeys[0];

    const tabStripHtml = memberKeys.map((key, idx) => {
      const isActive = key === activeKey;
      const label = SIDEBAR_TAB_LABELS[key] || key;
      const num = idx + 1;
      return `<button data-sidebar-tab data-tab-key="${key}" data-active="${isActive}"
        style="appearance:none;border:none;border-bottom:2px solid transparent;background:none;color:#fff;opacity:${isActive ? "1" : ".6"};padding:8px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:4px"
      ><span style="font-size:10px;opacity:.5;font-weight:400">${num}</span>${label}<span data-eject-key="${key}" title="Pop out" style="font-size:10px;opacity:.35;cursor:pointer;margin-left:2px">\u29C9</span></button>`;
    }).join("");

    const contentHtml = renderPanelBody(activeKey);

    container.style.height = loadHeightSetting(groupHeightKey(groupId))
      ? `${clampResizableHeight(loadHeightSetting(groupHeightKey(groupId)), 300)}px`
      : "auto";
    container.style.maxHeight = "calc(100vh - 24px)";
    container.style.overflow = "hidden";

    container.innerHTML = `
      <div data-overlay-drag-handle style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:move;padding:8px 10px 0">
        <div style="font-size:11px;opacity:.55">${BRAND_NAME}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <button data-group-collapse title="Collapse" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">\u2212</button>
        </div>
      </div>
      <div style="display:flex;border-bottom:1px solid rgba(255,255,255,0.08);margin-top:4px;padding:0 8px;overflow-x:auto">
        ${tabStripHtml}
      </div>
      <div data-sidebar-content>
        ${contentHtml}
      </div>
      <div data-overlay-resize-handle title="Resize width" style="position:absolute;top:10px;right:-4px;width:10px;height:calc(100% - 20px);cursor:ew-resize;opacity:.22;background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
      <div data-overlay-resize-handle-y title="Resize height" style="position:absolute;left:10px;right:10px;bottom:-4px;height:10px;cursor:ns-resize;opacity:.22;background:linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
    `;

    installPanelDrag(container, (el, left, top) => {
      const clamped = clampPanelPosition(el, left, top);
      el.style.left = `${clamped.left}px`;
      el.style.top = `${clamped.top}px`;
      el.style.right = "auto";
      savePositionSetting(groupPositionKey(groupId), clamped.left, clamped.top);
    });
    installHorizontalResize(container, () => groupWidthKey(groupId), 380);
    installVerticalResize(container, () => groupHeightKey(groupId), 300);

    container.querySelector("[data-group-collapse]")?.addEventListener("click", () => {
      saveBooleanSetting(groupCollapsedKey(groupId), true);
      renderPanelGroup(groupId);
    });

    // Tab click listeners
    for (const btn of container.querySelectorAll("[data-sidebar-tab]")) {
      btn.addEventListener("click", (e) => {
        if (e.target.closest("[data-eject-key]")) return;
        const key = btn.dataset.tabKey;
        if (key === activeKey) return;
        switchGroupTab(container, groupId, key);
      });
    }

    // Eject (pop out) listeners
    for (const icon of container.querySelectorAll("[data-eject-key]")) {
      icon.addEventListener("click", (e) => {
        e.stopPropagation();
        setPanelGroup(icon.dataset.ejectKey, null);
      });
    }

    // Number key switching
    container.addEventListener("keydown", (e) => {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= memberKeys.length) {
        e.preventDefault();
        e.stopPropagation();
        switchGroupTab(container, groupId, memberKeys[num - 1]);
      }
      if (e.key === "Escape") container.blur();
    });

    wireSidebarContentListeners(container, activeKey);
  }

  function switchGroupTab(container, groupId, key) {
    saveStringSetting(groupActiveTabKey(groupId), key);
    for (const tab of container.querySelectorAll("[data-sidebar-tab]")) {
      tab.dataset.active = String(tab.dataset.tabKey === key);
      tab.style.opacity = tab.dataset.tabKey === key ? "1" : ".6";
    }
    const contentArea = container.querySelector("[data-sidebar-content]");
    if (contentArea) {
      contentArea.innerHTML = renderPanelBody(key);
      wireSidebarContentListeners(container, key);
    }
  }

  function renderPanelLayout() {
    if (overlaySettings.panelLayout === "sidebar") {
      const activeGroups = new Set();

      for (const def of PANEL_DEFS) {
        const state = getPanelState(def.key);
        const panel = document.getElementById(def.id);
        if (state.visible && !state.docked && !state.group) {
          // Undocked + visible + standalone → render as classic floating panel
          renderPanel(def.key);
          const p = ensurePanel(def.key);
          if (p) {
            p.style.display = "block";
            const savedPos = loadPanelPosition(def.key);
            if (savedPos) {
              applyPanelPosition(p, def.key, savedPos.left, savedPos.top, false);
            } else {
              const next = defaultPanelPosition(def.key);
              applyPanelPosition(p, def.key, next.left, next.top, false);
            }
          }
        } else if (state.visible && !state.docked && state.group) {
          // Undocked + visible + in group → hide classic panel, track group
          if (panel) panel.style.display = "none";
          activeGroups.add(state.group);
        } else if (panel) {
          panel.style.display = "none";
        }
      }

      // Render each active group as a tabbed container
      for (const groupId of activeGroups) {
        renderPanelGroup(groupId);
      }

      // Hide stale group containers
      for (const el of document.querySelectorAll(`[id^="${GROUP_DOM_PREFIX}"]`)) {
        const gid = el.id.slice(GROUP_DOM_PREFIX.length);
        if (!activeGroups.has(gid)) el.remove();
      }

      renderSidebar();
    } else {
      hideSidebar();
      // Also hide any group containers
      for (const el of document.querySelectorAll(`[id^="${GROUP_DOM_PREFIX}"]`)) {
        el.remove();
      }
      renderPanels();
    }
  }

  function renderPanels() {
    for (const def of PANEL_DEFS) {
      const panelKey = def.key;
      const panel = ensurePanel(panelKey);
      if (!panel) continue;
      if (!overlayVisible || !getPanelState(panelKey).visible) {
        panel.style.display = "none";
        continue;
      }
      renderPanel(panelKey);
      panel.style.display = "block";
      const savedPosition = loadPanelPosition(panelKey);
      if (savedPosition) {
        applyPanelPosition(panel, panelKey, savedPosition.left, savedPosition.top, false);
      } else {
        const next = defaultPanelPosition(panelKey);
        applyPanelPosition(panel, panelKey, next.left, next.top, false);
      }
    }
  }

  function setPanelVisible(panelKey, visible) {
    const state = getPanelState(panelKey);
    if (!visible && state.group) {
      const oldGroup = state.group;
      clearPanelGroup(panelKey);
      dissolveIfSingle(oldGroup);
    }
    state.visible = visible;
    saveBooleanSetting(panelVisibleKey(panelKey), visible);
    void persistPanelVisibilitySetting(panelKey, visible);
    renderPanelLayout();
  }

  function setPanelCollapsed(panelKey, collapsed) {
    const state = getPanelState(panelKey);
    state.collapsed = collapsed;
    saveBooleanSetting(panelCollapsedKey(panelKey), collapsed);
    renderPanelLayout();
  }

  function setPanelDocked(panelKey, docked) {
    const state = getPanelState(panelKey);
    if (docked) clearPanelGroup(panelKey);
    state.docked = docked;
    saveBooleanSetting(panelDockedKey(panelKey), docked);
    renderPanelLayout();
  }

  function clearPanelGroup(panelKey) {
    const state = getPanelState(panelKey);
    state.group = null;
    saveStringSetting(panelGroupKey(panelKey), "");
  }

  function getVisibleGroupMembers(groupId) {
    return PANEL_DEFS
      .filter(def => {
        const s = getPanelState(def.key);
        return s.visible && !s.docked && s.group === groupId;
      })
      .map(def => def.key);
  }

  function groupActiveTabKey(groupId) {
    return `${GROUP_STORAGE_PREFIX}.${groupId}.active-tab`;
  }
  function groupPositionKey(groupId) {
    return `${GROUP_STORAGE_PREFIX}.${groupId}.position`;
  }
  function groupWidthKey(groupId) {
    return `${GROUP_STORAGE_PREFIX}.${groupId}.width`;
  }
  function groupHeightKey(groupId) {
    return `${GROUP_STORAGE_PREFIX}.${groupId}.height`;
  }
  function groupCollapsedKey(groupId) {
    return `${GROUP_STORAGE_PREFIX}.${groupId}.collapsed`;
  }

  function setPanelGroup(panelKey, groupId) {
    const state = getPanelState(panelKey);
    const oldGroup = state.group;

    if (groupId) {
      // Joining a group — ensure the target also has the group set
      const targetState = getPanelState(groupId);
      if (!targetState.group) {
        targetState.group = groupId;
        saveStringSetting(panelGroupKey(groupId), groupId);
      }
      state.group = targetState.group;
      saveStringSetting(panelGroupKey(panelKey), state.group);
    } else {
      clearPanelGroup(panelKey);
    }

    // Dissolve old group if only 1 member left
    if (oldGroup) dissolveIfSingle(oldGroup);

    renderPanelLayout();
  }

  function dissolveIfSingle(groupId) {
    const members = getVisibleGroupMembers(groupId);
    if (members.length <= 1) {
      for (const key of members) {
        clearPanelGroup(key);
      }
      const container = document.getElementById(GROUP_DOM_PREFIX + groupId);
      if (container) container.remove();
    }
  }

  async function saveOverlaySettingsFromControls(overlay) {
    const provider = overlay.querySelector(`#${OVERLAY_ID}-provider`)?.value ?? overlaySettings.provider;
    const model = overlay.querySelector(`#${OVERLAY_ID}-model`)?.value ?? getSelectedModelForProvider(provider);
    const compareProvider = overlay.querySelector(`#${OVERLAY_ID}-compare-provider`)?.value ?? overlaySettings.compareProvider;
    const compareModel = overlay.querySelector(`#${OVERLAY_ID}-compare-model`)?.value ?? getSelectedCompareModelForProvider(compareProvider);
    const compareMode = Boolean(overlay.querySelector(`#${OVERLAY_ID}-compare-mode`)?.checked ?? overlaySettings.compareMode);
    const payload = { provider, compareProvider, compareMode };
    if (provider === "claude") {
      payload.claudeModel = model;
    } else if (provider === "gemini") {
      payload.geminiModel = model;
    } else {
      payload.codexModel = model;
    }
    if (compareProvider === "claude") {
      payload.compareClaudeModel = compareModel;
    } else if (compareProvider === "gemini") {
      payload.compareGeminiModel = compareModel;
    } else {
      payload.compareCodexModel = compareModel;
    }

    const response = await safeSendRuntimeMessage({
      type: "save-settings",
      payload
    });
    if (response?.ok) {
      overlaySettings = { ...overlaySettings, ...(response.settings ?? payload) };
    } else {
      overlaySettings = { ...overlaySettings, ...payload };
    }
  }

  function installOverlayConfigControls(overlay) {
    const providerEl = overlay.querySelector(`#${OVERLAY_ID}-provider`);
    const modelEl = overlay.querySelector(`#${OVERLAY_ID}-model`);
    const compareModeEl = overlay.querySelector(`#${OVERLAY_ID}-compare-mode`);
    const compareProviderEl = overlay.querySelector(`#${OVERLAY_ID}-compare-provider`);
    const compareModelEl = overlay.querySelector(`#${OVERLAY_ID}-compare-model`);
    if (!providerEl || !modelEl) return;

    providerEl.addEventListener("change", async () => {
      const provider = providerEl.value;
      const selectedModel = getSelectedModelForProvider(provider) ?? (overlayProviderModelOptions[provider] ?? [])[0] ?? "";
      modelEl.innerHTML = renderModelOptionsMarkup(provider, selectedModel);
      await saveOverlaySettingsFromControls(overlay);
    });
    modelEl.addEventListener("change", async () => {
      await saveOverlaySettingsFromControls(overlay);
    });
    compareModeEl?.addEventListener("change", async () => {
      await saveOverlaySettingsFromControls(overlay);
      void renderOverlay(latestOverlayPayload);
    });
    compareProviderEl?.addEventListener("change", async () => {
      const provider = compareProviderEl.value;
      const selectedModel = getSelectedCompareModelForProvider(provider) ?? (overlayProviderModelOptions[provider] ?? [])[0] ?? "";
      if (compareModelEl) compareModelEl.innerHTML = renderModelOptionsMarkup(provider, selectedModel);
      await saveOverlaySettingsFromControls(overlay);
    });
    compareModelEl?.addEventListener("change", async () => {
      await saveOverlaySettingsFromControls(overlay);
    });
  }

  function setOverlayCollapsed(collapsed) {
    overlayCollapsed = collapsed;
    saveBooleanSetting(OVERLAY_COLLAPSED_KEY, collapsed);
    if (overlayVisible && overlaySettings.showOverlay) {
      void renderOverlay(latestOverlayPayload ?? buildPlaceholderOverlayPayload());
    }
  }

  async function triggerAnalyzeFromPage() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      await saveOverlaySettingsFromControls(overlay);
    }
    const response = await safeSendRuntimeMessage({ type: "analyze-current-state", forceOverlay: true });
    if (!response) {
      renderOverlay({
        providerLabel: "local",
        turn: "?",
        status: "extension_reloaded",
        result: {
          summary: "The extension was reloaded. Refresh this Showdown tab once, then analyze again.",
          rankedActions: [],
          confidence: "low"
        }
      });
      return;
    }
    if (response.ok || response.summary || response.error) {
      return;
    }
  }

  async function renderOverlay(payload) {
    await refreshOverlayConfig();
    latestOverlayPayload = payload;
    if (payload?.health) {
      overlayHealth = payload.health;
    }
    if (payload?.localIntel) {
      latestLocalIntelPayload = {
        turn: payload.turn,
        status: payload.status,
        localIntel: payload.localIntel
      };
    }
    const overlay = ensureOverlay();
    overlayVisible = true;
    overlay.style.display = overlaySettings.showOverlay ? "block" : "none";
    const ranked = Array.isArray(payload?.result?.rankedActions) ? payload.result.rankedActions : [];
    const compareResults = Array.isArray(payload?.compareResults) ? payload.compareResults : [];
    const status = payload?.status ?? null;
    const isAnalyzing = status === "analyzing";
    const compareEnabled = Boolean(overlaySettings.compareMode);
    const showAskFriendCard = overlaySettings.showAskFriendCard !== false;
    const showMoveSuggestions = overlaySettings.showMoveSuggestions !== false;
    if (overlayCollapsed) {
      overlay.innerHTML = `
        <div data-overlay-drag-handle style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:move">
          <div>
            <div style="font-size:12px;opacity:.7">${BRAND_NAME}</div>
            <div style="font-size:14px;font-weight:700;margin-top:2px">${payload.providerLabel ?? "Analysis"}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <button id="${OVERLAY_ID}-expand" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer">+</button>
            <button id="${OVERLAY_ID}-hide" title="Close" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer">×</button>
          </div>
        </div>
        <div data-overlay-resize-handle title="Resize width" style="position:absolute;top:6px;right:-4px;width:10px;height:28px;cursor:ew-resize;opacity:.28;background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
      `;
      overlay.style.height = "auto";
      installPanelDrag(overlay, applyOverlayPosition);
      installHorizontalResize(overlay, () => OVERLAY_WIDTH_KEY, 440);
      overlay.querySelector(`#${OVERLAY_ID}-expand`)?.addEventListener("click", () => {
        setOverlayCollapsed(false);
      });
      overlay.querySelector(`#${OVERLAY_ID}-hide`)?.addEventListener("click", () => {
        void persistOverlayVisibilitySetting(false);
        document.getElementById(OVERLAY_ID)?.remove();
      });
      renderPanelLayout();
      return;
    }
    const listHtml = ranked
      .slice(0, 5)
      .map(
        (entry, index) => `
          <div style="padding:8px 0;border-top:${index === 0 ? "none" : "1px solid rgba(255,255,255,0.08)"}">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <div style="font-weight:600">${index + 1}. ${entry.label}</div>
              <span style="font-size:11px;line-height:1;padding:4px 6px;border-radius:999px;background:${inferActionKind(entry) === "switch" ? "rgba(94, 210, 255, 0.18)" : "rgba(121, 245, 144, 0.18)"};color:${inferActionKind(entry) === "switch" ? "#9de7ff" : "#aef5bc"};text-transform:uppercase;letter-spacing:.04em">${inferActionKind(entry)}</span>
              <span style="font-size:11px;opacity:.72">${formatActionScore(entry.score)}</span>
            </div>
            <div style="opacity:.85;margin-top:2px">${entry.rationale}</div>
          </div>
        `
      )
      .join("");
    const compareHtml = compareResults.length > 0
      ? `
          <div style="display:grid;grid-template-columns:repeat(${Math.min(compareResults.length, 2)}, minmax(0, 1fr));gap:10px;margin-top:10px">
            ${compareResults.map((entry) => renderAnalysisCard(entry.providerLabel, entry.result)).join("")}
          </div>
        `
      : "";
    const askFriendMarkup = !showAskFriendCard
      ? `<div style="margin-top:10px;background:rgba(255,255,255,0.06);border-radius:10px;padding:10px;opacity:.8">Ask a Friend output is hidden in the popup toggles. Turn it back on from the shwdn2op popup if you want the summary card here.</div>`
      : `
          <div style="margin-top:8px;opacity:.92">${payload?.result?.summary ?? "No summary available."}</div>
          ${isAnalyzing ? '<div style="margin-top:8px;font-size:12px;color:#b8c7ff">Working on the current battle state now. You can switch provider/model and click Ask Again to replace this request.</div>' : ""}
          ${showMoveSuggestions
            ? (compareHtml || `<div style="margin-top:10px;background:rgba(255,255,255,0.06);border-radius:10px;padding:10px">${listHtml || "<div>No ranked actions.</div>"}</div>`)
            : '<div style="margin-top:10px;background:rgba(255,255,255,0.06);border-radius:10px;padding:10px;opacity:.78">Move suggestions are hidden in the popup toggles.</div>'}
        `;

    overlay.innerHTML = `
      <div data-overlay-drag-handle style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:move">
        <div>
          <div style="font-size:12px;opacity:.7">${BRAND_NAME}</div>
          <div style="font-size:15px;font-weight:700;margin-top:2px">${payload.providerLabel ?? "Analysis"}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button id="${OVERLAY_ID}-analyze" style="appearance:none;border:none;background:${isAnalyzing ? "#7a8fff" : "#5b7cff"};color:#fff;padding:8px 10px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer">${isAnalyzing ? "Ask Again" : "Ask a Friend"}</button>
          <button id="${OVERLAY_ID}-collapse" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer">−</button>
          <button id="${OVERLAY_ID}-close" style="appearance:none;border:none;background:transparent;color:#fff;font-size:18px;cursor:pointer;opacity:.8">×</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:110px 1fr;gap:8px;margin-top:10px">
        <select id="${OVERLAY_ID}-provider" style="appearance:none;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:#fff;padding:8px 10px;border-radius:8px;font:inherit">
          ${renderProviderOptionsMarkup(overlaySettings.provider)}
        </select>
        <select id="${OVERLAY_ID}-model" style="appearance:none;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:#fff;padding:8px 10px;border-radius:8px;font:inherit">
          ${renderModelOptionsMarkup(overlaySettings.provider, getSelectedModelForProvider(overlaySettings.provider))}
        </select>
      </div>
      <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:8px;margin-top:8px;align-items:center">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;opacity:.84"><input id="${OVERLAY_ID}-compare-mode" type="checkbox" ${compareEnabled ? "checked" : ""}>Compare</label>
        <select id="${OVERLAY_ID}-compare-provider" style="appearance:none;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:#fff;padding:8px 10px;border-radius:8px;font:inherit">
          ${renderProviderOptionsMarkup(overlaySettings.compareProvider)}
        </select>
        <select id="${OVERLAY_ID}-compare-model" style="appearance:none;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:#fff;padding:8px 10px;border-radius:8px;font:inherit">
          ${renderModelOptionsMarkup(overlaySettings.compareProvider, getSelectedCompareModelForProvider(overlaySettings.compareProvider))}
        </select>
      </div>
      ${renderProviderHealthMarkup()}
      ${askFriendMarkup}
      <div style="margin-top:8px;font-size:12px;opacity:.68">Turn ${payload.turn ?? "?"} · confidence: ${payload?.result?.confidence ?? "unknown"}${status ? ` · ${formatTabStatusLabel(status)}` : ""}</div>
      <div style="margin-top:4px;font-size:11px;opacity:.55">Shortcut on Showdown: Alt+Shift+S shows or hides your shwdn2op windows.</div>
      <div data-overlay-resize-handle title="Resize width" style="position:absolute;top:10px;right:-4px;width:10px;height:calc(100% - 20px);cursor:ew-resize;opacity:.22;background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
      <div data-overlay-resize-handle-y title="Resize height" style="position:absolute;left:10px;right:10px;bottom:-4px;height:10px;cursor:ns-resize;opacity:.22;background:linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
    `;

    installPanelDrag(overlay, applyOverlayPosition);
    installHorizontalResize(overlay, () => OVERLAY_WIDTH_KEY, 440);
    installVerticalResize(overlay, () => OVERLAY_HEIGHT_KEY, 520);
    installOverlayConfigControls(overlay);

    overlay.querySelector(`#${OVERLAY_ID}-analyze`)?.addEventListener("click", () => {
      void triggerAnalyzeFromPage();
    });
    overlay.querySelector(`#${OVERLAY_ID}-collapse`)?.addEventListener("click", () => {
      setOverlayCollapsed(true);
    });
    overlay.querySelector(`#${OVERLAY_ID}-close`)?.addEventListener("click", () => {
      void persistOverlayVisibilitySetting(false);
      document.getElementById(OVERLAY_ID)?.remove();
    });

    renderPanelLayout();
  }

  function handleWindowMessage(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== SOURCE) return;
    if (event.data.kind === "active-room") {
      void safeSendRuntimeMessage({
        type: "showdown-active-room",
        payload: { roomId: event.data.roomId ?? null }
      });
      return;
    }
    if (event.data.kind === "room-protocol-snapshot") {
      void safeSendRuntimeMessage({
        type: "showdown-room-protocol-snapshot",
        payload: {
          roomId: event.data.roomId ?? null,
          roomSlot: event.data.roomSlot ?? null,
          data: event.data.data ?? null,
          timestamp: event.data.timestamp ?? Date.now()
        }
      });
      return;
    }
    void safeSendRuntimeMessage({
      type: "showdown-frame",
      payload: event.data
    });
  }

  function handleKeydown(event) {
    const tagName = event.target?.tagName?.toLowerCase();
    const isEditable =
      event.target?.isContentEditable ||
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select";
    if (isEditable) return;

    const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
    const withShift = event.shiftKey;
    const usesFallbackModifier = event.altKey || event.metaKey;

    if (usesFallbackModifier && withShift && key === "x") {
      event.preventDefault();
      overlayVisible = !overlayVisible;
      syncWindowVisibility();
    }
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!message || typeof message !== "object") return false;
    if (message.type === "ping") {
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "refresh-overlay-config") {
      void refreshOverlayConfig().then(async () => {
        if (overlayVisible) syncWindowVisibility();
        else renderPanelLayout();
        sendResponse({ ok: true });
      });
      return true;
    }
    if (message.type === "apply-overlay-settings") {
      applyOverlaySettings(message.settings ?? {});
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "toggle-overlay-windows") {
      overlayVisible = !overlayVisible;
      syncWindowVisibility();
      sendResponse({ ok: true, visible: overlayVisible });
      return true;
    }
    if (message.type === "show-analysis-overlay") {
      void renderOverlay(message.payload);
    }
    if (message.type === "update-local-intel") {
      latestLocalIntelPayload = message.payload ?? latestLocalIntelPayload;
      renderPanelLayout();
    }
    if (message.type === "clear-analysis-overlay") {
      document.getElementById(OVERLAY_ID)?.remove();
    }
    return false;
  }

  window.addEventListener("message", handleWindowMessage);
  window.addEventListener("keydown", handleKeydown, true);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  injectPageHook();
  void refreshOverlayConfig();
}
