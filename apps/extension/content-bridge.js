const BRAND_NAME = "shwdn2op";
const SOURCE = "showdnass";
const OVERLAY_ID = "showdnass-overlay";
const OVERLAY_POSITION_KEY = "showdnass.overlay-position";
const OVERLAY_COLLAPSED_KEY = "showdnass.overlay-collapsed";
const OVERLAY_WIDTH_KEY = "showdnass.overlay-width";
const OVERLAY_HEIGHT_KEY = "showdnass.overlay-height";
const PANEL_STORAGE_PREFIX = "showdnass.panel";
const PANEL_STACK_BASE_Z = 10000;

const LEGACY_INTEL_PANEL_POSITION_KEY = "showdown-second-opinion.intel-position";
const LEGACY_INTEL_PANEL_VISIBLE_KEY = "showdown-second-opinion.intel-visible";
const PANEL_DEFS = [
  { key: "intel", id: "showdnass-panel-intel", title: "Local Intel", width: 360, zIndex: 10002, background: "rgba(18, 32, 24, 0.97)", border: "rgba(86, 202, 122, 0.24)" },
  { key: "opponentAction", id: "showdnass-panel-opponent-action", title: "Line To Respect", width: 360, zIndex: 10003, background: "rgba(38, 28, 18, 0.97)", border: "rgba(246, 173, 85, 0.24)" },
  { key: "selfAction", id: "showdnass-panel-self-action", title: "Best Line", width: 360, zIndex: 10004, background: "rgba(18, 29, 38, 0.97)", border: "rgba(94, 210, 255, 0.24)" },
  { key: "damage", id: "showdnass-panel-damage", title: "Damage Matrix", width: 390, zIndex: 10005, background: "rgba(34, 19, 19, 0.97)", border: "rgba(255, 124, 124, 0.24)" },
  { key: "mechanics", id: "showdnass-panel-mechanics", title: "Mechanics", width: 350, zIndex: 10006, background: "rgba(18, 23, 38, 0.97)", border: "rgba(109, 169, 255, 0.24)" },
  { key: "debug", id: "showdnass-panel-debug", title: "Debug", width: 420, zIndex: 10007, background: "rgba(24, 24, 28, 0.98)", border: "rgba(210, 210, 210, 0.18)" }
];

const OVERLAY_DEFAULT_OPTIONS = {
  codex: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.3-codex-spark"],
  claude: ["sonnet", "haiku", "opus"],
  gemini: ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
};

const PANEL_SETTING_KEYS = {
  intel: "showLocalIntelPanel",
  opponentAction: "showOpponentActionPanel",
  selfAction: "showSelfActionPanel",
  damage: "showDamagePanel",
  mechanics: "showMechanicsPanel",
  debug: "showDebugPanel"
};

if (!window.__showdownSecondOpinionContentBridgeInstalled) {
  window.__showdownSecondOpinionContentBridgeInstalled = true;

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

  function panelVisibleKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.visible`;
  }

  function panelPositionKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.position`;
  }

  function panelCollapsedKey(panelKey) {
    return `${PANEL_STORAGE_PREFIX}.${panelKey}.collapsed`;
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
      panelState[panelKey] = { visible: false, collapsed: false };
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
      nextState[panelKey] = { visible, collapsed };
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
      for (const def of PANEL_DEFS) {
        const panel = document.getElementById(def.id);
        if (panel) {
          panel.style.display = "none";
        }
      }
      return;
    }

    if (overlaySettings.showOverlay) {
      const payload = latestOverlayPayload ?? buildPlaceholderOverlayPayload();
      void renderOverlay(payload);
    } else {
      document.getElementById(OVERLAY_ID)?.remove();
    }
    renderPanels();
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
    renderPanels();
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

  function formatSpeedRange(range) {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return "?";
    if (range.min === range.max) return `${Math.round(range.min)}`;
    return `${Math.round(range.min)}-${Math.round(range.max)}`;
  }

  function formatSpeedRelation(relation) {
    if (relation === "faster") return "likely faster";
    if (relation === "slower") return "likely slower";
    if (relation === "overlap") return "roughly even";
    return "speed unclear";
  }

  function renderSpeedSummaryMarkup(speedPreview, relation) {
    const yourSpeed = Number(speedPreview?.yourActiveEffectiveSpeed);
    const opponentRange = speedPreview?.effectiveRange;
    const hasYourSpeed = Number.isFinite(yourSpeed);
    const hasOpponentRange = opponentRange && Number.isFinite(opponentRange.min) && Number.isFinite(opponentRange.max);
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
        ${hasOpponentRange ? `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:11px;line-height:1.2;white-space:nowrap">
            <strong style="font-weight:600">opp est</strong>
            <span>${formatSpeedRange(opponentRange)}</span>
          </span>
        ` : ""}
      </div>
      ${speedPreview?.activeSummary ? `<div style="margin-top:4px;font-size:11px;opacity:.68">${speedPreview.activeSummary}</div>` : ""}
    `;
  }

  function renderSpeedEvidence(speedPreview) {
    const evidence = Array.isArray(speedPreview?.evidence) ? speedPreview.evidence : [];
    const confounders = Array.isArray(speedPreview?.confounders) ? speedPreview.confounders : [];
    if (evidence.length === 0 && confounders.length === 0) return "";
    return `
      <div style="margin-top:6px;font-size:11px;opacity:.68">
        ${evidence.map((entry) => `${entry.label}${entry.detail ? `: ${entry.detail}` : ""}`).join("<br>")}
        ${confounders.length > 0 ? `<div style="margin-top:4px">Confounders: ${confounders.join(", ")}</div>` : ""}
      </div>
    `;
  }

  function getLocalIntel() {
    return latestLocalIntelPayload?.localIntel ?? null;
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
      const reasons = Array.isArray(leadPrediction.reasons) ? leadPrediction.reasons : [];
      const riskFlags = Array.isArray(leadPrediction.riskFlags) ? leadPrediction.riskFlags : [];
      return `
        <div style="margin-top:6px;font-size:11px;opacity:.58">Preview-phase deterministic opening line to respect.</div>
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
        ${reasons.length > 0 ? `
          <div style="margin-top:10px">
            <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Why</div>
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${reasons.map((reason) => renderPredictionChip(reason, "reason")).join("")}</div>
          </div>
        ` : ""}
        ${riskFlags.length > 0 ? `
          <div style="margin-top:10px">
            <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Risk flags</div>
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${riskFlags.map((flag) => renderPredictionChip(flag, "risk")).join("")}</div>
          </div>
        ` : ""}
      `;
    }
    if (!prediction) {
      return `
        <div style="margin-top:6px;font-size:11px;opacity:.58">Deterministic line-to-respect view from speed, damage bands, hazards, revealed pivots, and high-confidence hidden info.</div>
        <div style="margin-top:10px;font-size:12px;opacity:.72">
          No opponent line-to-respect view yet for this board state.
        </div>
      `;
    }

    const topActions = Array.isArray(prediction.topActions) ? prediction.topActions : [];
    const reasons = Array.isArray(prediction.reasons) ? prediction.reasons : [];
    const riskFlags = Array.isArray(prediction.riskFlags) ? prediction.riskFlags : [];
    const classScores = prediction.classScores ?? null;

    return `
      <div style="margin-top:6px;font-size:11px;opacity:.58">Compact deterministic line most worth respecting on the current board.</div>
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
      ${reasons.length > 0 ? `
        <div style="margin-top:10px">
          <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Why</div>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${reasons.map((reason) => renderPredictionChip(reason, "reason")).join("")}</div>
        </div>
      ` : ""}
      ${riskFlags.length > 0 ? `
        <div style="margin-top:10px">
          <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Risk flags</div>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${riskFlags.map((flag) => renderPredictionChip(flag, "risk")).join("")}</div>
        </div>
      ` : ""}
    `;
  }

  function renderSelfActionPanelMarkup() {
    const localIntel = getLocalIntel();
    const recommendation = localIntel?.selfActionRecommendation ?? null;
    if (!recommendation) {
      return `
        <div style="margin-top:6px;font-size:11px;opacity:.58">Compact deterministic ranking for your legal moves and switches.</div>
        <div style="margin-top:10px;font-size:12px;opacity:.72">
          No self-recommendation yet for this board state.
        </div>
      `;
    }

    const rankedActions = Array.isArray(recommendation.rankedActions) ? recommendation.rankedActions : [];
    const reasons = Array.isArray(recommendation.reasons) ? recommendation.reasons : [];
    const riskFlags = Array.isArray(recommendation.riskFlags) ? recommendation.riskFlags : [];

    return `
      <div style="margin-top:6px;font-size:11px;opacity:.58">Compact deterministic recommendation built from damage, threat, speed, hazards, and local opponent intel.</div>
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
      <div style="margin-top:10px;padding:9px 10px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08)">
        ${escapeHtml(recommendation.summary ?? "No summary available.")}
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
      ${reasons.length > 0 ? `
        <div style="margin-top:10px">
          <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Why</div>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${reasons.map((reason) => renderPredictionChip(reason, "reason")).join("")}</div>
        </div>
      ` : ""}
      ${riskFlags.length > 0 ? `
        <div style="margin-top:10px">
          <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Risk flags</div>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${riskFlags.map((flag) => renderPredictionChip(flag, "risk")).join("")}</div>
        </div>
      ` : ""}
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

    const yourMoves = playerDamagePreview.length
      ? `
          <div style="margin-top:8px;font-weight:600">Your moves</div>
          ${playerDamagePreview
            .map(
              (entry) => `
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
                  <div style="font-weight:600">${entry.label}</div>
                  <div style="margin-top:2px;font-size:11px;opacity:.62">${entry.targetName ?? "Opponent active"}</div>
                  ${renderDamageBandRow(entry.bands, entry.targetCurrentHpPercent, entry.likelyBandSource)}
                  ${renderObservedDamageNote(entry.observedRange)}
                  ${renderCaveatChips(entry.survivalCaveats)}
                </div>
              `
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
                (entry) => `
                  <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
                  <div style="font-weight:600">${entry.moveName ?? entry.label ?? "Likely move"}${entry.moveSource ? ` · ${entry.moveSource}` : ""}</div>
                  <div style="margin-top:2px;font-size:11px;opacity:.62">${entry.currentTarget?.species ?? "Your active"}</div>
                    ${renderDamageBandRow(entry.currentTarget?.bands, entry.currentTarget?.targetCurrentHpPercent, entry.currentTarget?.likelyBandSource)}
                    ${renderObservedDamageNote(entry.currentTarget?.observedRange)}
                    ${Array.isArray(entry.switchTargets) && entry.switchTargets.length > 0 ? `
                      <div style="margin-top:6px;font-size:11px;opacity:.62">Switches: ${entry.switchTargets
                        .map((target) => {
                          const band = Array.isArray(target.bands) ? target.bands.find((candidate) => candidate.label === "likely") ?? target.bands[0] : null;
                          const observed = target.observedRange && Number.isFinite(target.observedRange.minPercent)
                            ? ` seen ${formatPercentRange(target.observedRange.minPercent, target.observedRange.maxPercent)}`
                            : "";
                          const bandText = formatCompactThreatBand(band);
                          return `${target.species ?? "Unknown"}${target.relation ? ` (${target.relation})` : ""}${bandText ? ` ${bandText}` : ""}${observed}`;
                        })
                        .join("; ")}</div>
                    ` : ""}
                  </div>
                `
              )
              .join("")}
          </div>
        `
      : "";

    return `
      <div style="margin-top:6px;font-size:11px;opacity:.58">Compact deterministic damage bands from current state and local history priors.</div>
      ${yourMoves}
      ${threats}
    `;
  }

  function renderMechanicsPanelMarkup() {
    const localIntel = getLocalIntel();
    const opponents = Array.isArray(localIntel?.opponents) ? localIntel.opponents : [];
    const teraUsedBy = opponents.find((entry) => entry.currentTerastallized)?.species ?? null;
    const speedPreview = localIntel?.speedPreview ?? null;
    const switchSpeedMatchups = Array.isArray(speedPreview?.switchMatchups) ? speedPreview.switchMatchups : [];
    const speedNotes = Array.isArray(speedPreview?.historyNotes) ? speedPreview.historyNotes : [];
    const survivalCaveats = Array.isArray(localIntel?.survivalCaveats) ? localIntel.survivalCaveats : [];
    const hazards = localIntel?.hazardSummary ?? null;

    return `
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
        ${teraUsedBy
          ? renderCompactChip("tera", `${teraUsedBy} used`, "accent", `${teraUsedBy} has Terastallized in the current game`)
          : renderCompactChip("tera", "unused", "neutral", "The opponent has not Terastallized in the current game")}
      </div>
      <div style="margin-top:6px">
        <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Speed</div>
        ${renderSpeedSummaryMarkup(
          speedPreview,
          speedPreview?.activeRelation ?? "unknown"
        )}
        ${renderSpeedEvidence(speedPreview)}
      </div>
      ${switchSpeedMatchups.length > 0 ? `
        <details style="margin-top:8px">
          <summary style="cursor:pointer;opacity:.78">Switch speed matchups</summary>
          <div style="margin-top:4px">${switchSpeedMatchups.map((matchup) => `${matchup.species ?? matchup.label ?? "Unknown"} · ${Number.isFinite(matchup.effectiveSpeed) ? `${Math.round(matchup.effectiveSpeed)} Spe` : "unknown Spe"} · ${formatSpeedRelation(matchup.relation)}`).join("<br>")}</div>
        </details>
      ` : ""}
      ${hazards ? `
        <div style="margin-top:8px">
          <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Hazards</div>
          <div style="margin-top:2px">${hazards}</div>
        </div>
      ` : ""}
      ${survivalCaveats.length > 0 ? `
        <div style="margin-top:8px">
          <div style="font-size:11px;opacity:.62;text-transform:uppercase;letter-spacing:.05em">Survival caveats</div>
          <div style="margin-top:2px">${survivalCaveats.join("<br>")}</div>
        </div>
      ` : ""}
      <div style="margin-top:8px;font-size:11px;opacity:.56">${speedNotes.length > 0 ? speedNotes.join(" ") : "No clean historical speed observations yet."}</div>
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
              <button id="${def.id}-expand" title="Expand" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">+</button>
              <button id="${def.id}-hide" title="Close" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit;cursor:pointer">×</button>
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
          <button id="${def.id}-collapse" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer">−</button>
          <button id="${def.id}-hide" title="Close" style="appearance:none;border:none;background:rgba(255,255,255,0.08);color:#fff;padding:8px 10px;border-radius:8px;font:inherit;cursor:pointer">×</button>
        </div>
      </div>
      <div style="margin-top:8px;font-size:12px;opacity:.68">Turn ${latestLocalIntelPayload?.turn ?? "?"}${latestLocalIntelPayload?.status ? ` · ${formatTabStatusLabel(latestLocalIntelPayload.status)}` : ""}</div>
      ${renderPanelBody(panelKey)}
      <div data-overlay-resize-handle title="Resize width" style="position:absolute;top:10px;right:-4px;width:10px;height:calc(100% - 20px);cursor:ew-resize;opacity:.22;background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
      <div data-overlay-resize-handle-y title="Resize height" style="position:absolute;left:10px;right:10px;bottom:-4px;height:10px;cursor:ns-resize;opacity:.22;background:linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.18), rgba(255,255,255,.05));border-radius:999px"></div>
    `;

    installPanelDrag(panel, (element, left, top) => {
      applyPanelPosition(element, panelKey, left, top, true);
    });
    installHorizontalResize(panel, () => panelWidthKey(panelKey), def.width);
    installVerticalResize(panel, () => panelHeightKey(panelKey), 420);

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
    state.visible = visible;
    saveBooleanSetting(panelVisibleKey(panelKey), visible);
    void persistPanelVisibilitySetting(panelKey, visible);
    renderPanels();
  }

  function setPanelCollapsed(panelKey, collapsed) {
    const state = getPanelState(panelKey);
    state.collapsed = collapsed;
    saveBooleanSetting(panelCollapsedKey(panelKey), collapsed);
    renderPanels();
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
      renderPanels();
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

    renderPanels();
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
        else renderPanels();
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
      renderPanels();
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
