import { DEFAULT_SETTINGS, PROVIDER_MODEL_OPTIONS } from "./lib/storage.js";

const providerEl = document.getElementById("provider");
const codexRow = document.getElementById("codexModelRow");
const claudeRow = document.getElementById("claudeModelRow");
const geminiRow = document.getElementById("geminiModelRow");
const compareProviderRow = document.getElementById("compareProviderRow");
const compareCodexRow = document.getElementById("compareCodexModelRow");
const compareClaudeRow = document.getElementById("compareClaudeModelRow");
const compareGeminiRow = document.getElementById("compareGeminiModelRow");
const companionUrlEl = document.getElementById("companionUrl");
const codexModelEl = document.getElementById("codexModel");
const claudeModelEl = document.getElementById("claudeModel");
const geminiModelEl = document.getElementById("geminiModel");
const analysisModeEl = document.getElementById("analysisMode");
const compareModeEl = document.getElementById("compareMode");
const compareProviderEl = document.getElementById("compareProvider");
const compareCodexModelEl = document.getElementById("compareCodexModel");
const compareClaudeModelEl = document.getElementById("compareClaudeModel");
const compareGeminiModelEl = document.getElementById("compareGeminiModel");
const showOverlayEl = document.getElementById("showOverlay");
const autoDownloadReplayEl = document.getElementById("autoDownloadReplay");
const showLocalIntelPanelEl = document.getElementById("showLocalIntelPanel");
const showOpponentActionPanelEl = document.getElementById("showOpponentActionPanel");
const showSelfActionPanelEl = document.getElementById("showSelfActionPanel");
const showDamagePanelEl = document.getElementById("showDamagePanel");
const showMechanicsPanelEl = document.getElementById("showMechanicsPanel");
const showDebugPanelEl = document.getElementById("showDebugPanel");
const summaryEl = document.getElementById("summary");
const snapshotInfoEl = document.getElementById("snapshotInfo");
const roomStatusEl = document.getElementById("roomStatus");
const healthEl = document.getElementById("health");
const saveEl = document.getElementById("save");
const analyzeEl = document.getElementById("analyze");

function humanizeStatus(status) {
  switch (status) {
    case "ready":
      return "ready";
    case "room_ambiguous":
      return "ambiguous";
    case "waiting_or_not_your_turn":
      return "waiting";
    case "stale_snapshot":
      return "stale";
    case "provider_error":
      return "provider error";
    case "no_snapshot":
    default:
      return "no snapshot";
  }
}

function currentTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab);
}

function renderModelOptions(selectEl, models, selectedValue) {
  selectEl.innerHTML = "";

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selectedValue;
    selectEl.appendChild(option);
  }
}

function populateModelLists(settings) {
  renderModelOptions(
    codexModelEl,
    PROVIDER_MODEL_OPTIONS.codex,
    settings.codexModel || DEFAULT_SETTINGS.codexModel
  );
  renderModelOptions(
    claudeModelEl,
    PROVIDER_MODEL_OPTIONS.claude,
    settings.claudeModel || DEFAULT_SETTINGS.claudeModel
  );
  renderModelOptions(
    geminiModelEl,
    PROVIDER_MODEL_OPTIONS.gemini,
    settings.geminiModel || DEFAULT_SETTINGS.geminiModel
  );
  renderModelOptions(
    compareCodexModelEl,
    PROVIDER_MODEL_OPTIONS.codex,
    settings.compareCodexModel || DEFAULT_SETTINGS.compareCodexModel
  );
  renderModelOptions(
    compareClaudeModelEl,
    PROVIDER_MODEL_OPTIONS.claude,
    settings.compareClaudeModel || DEFAULT_SETTINGS.compareClaudeModel
  );
  renderModelOptions(
    compareGeminiModelEl,
    PROVIDER_MODEL_OPTIONS.gemini,
    settings.compareGeminiModel || DEFAULT_SETTINGS.compareGeminiModel
  );
}

function refreshModelRows() {
  const provider = providerEl.value;
  const compareProvider = compareProviderEl.value;
  const compareEnabled = compareModeEl.checked;
  codexRow.style.display = provider === "codex" ? "grid" : "none";
  claudeRow.style.display = provider === "claude" ? "grid" : "none";
  geminiRow.style.display = provider === "gemini" ? "grid" : "none";
  compareProviderRow.style.display = compareEnabled ? "grid" : "none";
  compareCodexRow.style.display = compareEnabled && compareProvider === "codex" ? "grid" : "none";
  compareClaudeRow.style.display = compareEnabled && compareProvider === "claude" ? "grid" : "none";
  compareGeminiRow.style.display = compareEnabled && compareProvider === "gemini" ? "grid" : "none";
}

function buildSettingsPayload() {
  return {
    companionUrl: companionUrlEl.value.trim(),
    provider: providerEl.value,
    codexModel: codexModelEl.value,
    claudeModel: claudeModelEl.value,
    geminiModel: geminiModelEl.value,
    analysisMode: analysisModeEl.value,
    compareMode: compareModeEl.checked,
    compareProvider: compareProviderEl.value,
    compareCodexModel: compareCodexModelEl.value,
    compareClaudeModel: compareClaudeModelEl.value,
    compareGeminiModel: compareGeminiModelEl.value,
    showOverlay: showOverlayEl.checked,
    autoDownloadReplay: autoDownloadReplayEl.checked,
    showLocalIntelPanel: showLocalIntelPanelEl.checked,
    showOpponentActionPanel: showOpponentActionPanelEl.checked,
    showSelfActionPanel: showSelfActionPanelEl.checked,
    showDamagePanel: showDamagePanelEl.checked,
    showMechanicsPanel: showMechanicsPanelEl.checked,
    showDebugPanel: showDebugPanelEl.checked,
    showAskFriendCard: true,
    showMoveSuggestions: true
  };
}

function refreshAnalyzeButtonLabel() {
  analyzeEl.textContent = analysisModeEl.value === "strategic"
    ? "Ask a Friend: Strategic"
    : "Ask a Friend: Tactical";
}

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ type: "get-settings" });
  const settings = response.settings;
  companionUrlEl.value = settings.companionUrl;
  providerEl.value = settings.provider;
  populateModelLists(settings);
  analysisModeEl.value = settings.analysisMode || DEFAULT_SETTINGS.analysisMode;
  compareModeEl.checked = Boolean(settings.compareMode);
  compareProviderEl.value = settings.compareProvider || DEFAULT_SETTINGS.compareProvider;
  compareCodexModelEl.value = settings.compareCodexModel || DEFAULT_SETTINGS.compareCodexModel;
  compareClaudeModelEl.value = settings.compareClaudeModel || DEFAULT_SETTINGS.compareClaudeModel;
  compareGeminiModelEl.value = settings.compareGeminiModel || DEFAULT_SETTINGS.compareGeminiModel;
  showOverlayEl.checked = Boolean(settings.showOverlay);
  autoDownloadReplayEl.checked = Boolean(settings.autoDownloadReplay);
  showLocalIntelPanelEl.checked = Boolean(settings.showLocalIntelPanel);
  showOpponentActionPanelEl.checked = Boolean(settings.showOpponentActionPanel);
  showSelfActionPanelEl.checked = Boolean(settings.showSelfActionPanel);
  showDamagePanelEl.checked = Boolean(settings.showDamagePanel);
  showMechanicsPanelEl.checked = Boolean(settings.showMechanicsPanel);
  showDebugPanelEl.checked = Boolean(settings.showDebugPanel);
  refreshModelRows();
  refreshAnalyzeButtonLabel();
}

async function saveSettings() {
  return chrome.runtime.sendMessage({
    type: "save-settings",
    payload: buildSettingsPayload()
  });
}

async function refreshActiveTabOverlayConfig(settingsPayload = buildSettingsPayload()) {
  const tab = await currentTab();
  if (!tab?.id) return;
  await chrome.runtime.sendMessage({
    type: "push-overlay-settings",
    tabId: tab.id,
    settings: settingsPayload
  }).catch(() => null);
}

async function autoSaveSettings() {
  const response = await saveSettings();
  await refreshActiveTabOverlayConfig(response?.settings ?? buildSettingsPayload());
  await refreshHealth();
}

async function refreshHealth() {
  healthEl.textContent = "checking...";
  const response = await chrome.runtime.sendMessage({ type: "companion-health" });
  if (!response?.ok) {
    healthEl.textContent = response?.error ?? "offline";
    return;
  }
  const health = response.health;
  const codex = health.providers?.codex?.available ? "codex ✓" : "codex ×";
  const claude = health.providers?.claude?.available ? "claude ✓" : "claude ×";
  const gemini = health.providers?.gemini?.available ? "gemini ✓" : "gemini ×";
  healthEl.textContent = `${codex} · ${claude} · ${gemini}`;
}

async function refreshSnapshot() {
  const tab = await currentTab();
  if (!tab?.id) {
    snapshotInfoEl.textContent = "no active tab";
    return;
  }
  const response = await chrome.tabs.sendMessage(tab.id, { type: "ping" }).catch(() => null);
  void response;
  const result = await chrome.runtime.sendMessage({ type: "get-latest-state", tabId: tab.id });
  const snapshot = result?.snapshot;
  roomStatusEl.textContent = humanizeStatus(result?.status);
  if (!snapshot) {
    snapshotInfoEl.textContent = result?.message ?? "no battle detected yet";
    return;
  }
  snapshotInfoEl.textContent = `${snapshot.format} · turn ${snapshot.turn}`;
}

async function refreshLastAnalysis() {
  const tab = await currentTab();
  if (!tab?.id) {
    summaryEl.textContent = "No active tab.";
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "get-last-analysis", tabId: tab.id });
  roomStatusEl.textContent = humanizeStatus(response?.status);
  if (response?.analysis?.analysis?.summary) {
    summaryEl.textContent = response.analysis.analysis.summary;
    return;
  }
  if (response?.analysis?.summary) {
    summaryEl.textContent = response.analysis.summary;
    return;
  }
  if (response?.error) {
    summaryEl.textContent = response.error;
    return;
  }
  if (response?.message) {
    summaryEl.textContent = response.message;
    return;
  }
  summaryEl.textContent = "No analysis yet.";
}

async function analyzeCurrentTurn() {
  await saveSettings();
  const tab = await currentTab();
  if (!tab?.id) {
    summaryEl.textContent = "No active tab.";
    return;
  }
  const analysisMode = analysisModeEl.value || DEFAULT_SETTINGS.analysisMode;
  summaryEl.textContent = analysisMode === "strategic" ? "Running strategic analysis..." : "Running tactical analysis...";
  const response = await chrome.runtime.sendMessage({
    type: "analyze-current-state",
    tabId: tab.id,
    forceOverlay: true,
    analysisMode
  });
  if (!response?.ok) {
    roomStatusEl.textContent = humanizeStatus(response?.status);
    summaryEl.textContent = response?.summary ?? response?.error ?? "Analysis failed.";
    return;
  }
  roomStatusEl.textContent = humanizeStatus(response?.status);
  summaryEl.textContent = response.analysis?.summary ?? "Done.";
  await refreshLastAnalysis();
}

providerEl.addEventListener("change", refreshModelRows);
providerEl.addEventListener("change", autoSaveSettings);
codexModelEl.addEventListener("change", autoSaveSettings);
claudeModelEl.addEventListener("change", autoSaveSettings);
geminiModelEl.addEventListener("change", autoSaveSettings);
analysisModeEl.addEventListener("change", refreshAnalyzeButtonLabel);
analysisModeEl.addEventListener("change", autoSaveSettings);
compareModeEl.addEventListener("change", refreshModelRows);
compareModeEl.addEventListener("change", autoSaveSettings);
compareProviderEl.addEventListener("change", refreshModelRows);
compareProviderEl.addEventListener("change", autoSaveSettings);
compareCodexModelEl.addEventListener("change", autoSaveSettings);
compareClaudeModelEl.addEventListener("change", autoSaveSettings);
compareGeminiModelEl.addEventListener("change", autoSaveSettings);
showOverlayEl.addEventListener("change", autoSaveSettings);
showLocalIntelPanelEl.addEventListener("change", autoSaveSettings);
showOpponentActionPanelEl.addEventListener("change", autoSaveSettings);
showSelfActionPanelEl.addEventListener("change", autoSaveSettings);
showDamagePanelEl.addEventListener("change", autoSaveSettings);
showMechanicsPanelEl.addEventListener("change", autoSaveSettings);
showDebugPanelEl.addEventListener("change", autoSaveSettings);
autoDownloadReplayEl.addEventListener("change", autoSaveSettings);
companionUrlEl.addEventListener("change", autoSaveSettings);
saveEl.addEventListener("click", async () => {
  const response = await saveSettings();
  await refreshActiveTabOverlayConfig(response?.settings ?? buildSettingsPayload());
  await refreshHealth();
});
analyzeEl.addEventListener("click", analyzeCurrentTurn);

await loadSettings();
await refreshHealth();
await refreshSnapshot();
await refreshLastAnalysis();
