export const PROVIDER_MODEL_OPTIONS = {
  codex: [
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.3-codex-spark"
  ],
  claude: [
    "sonnet",
    "haiku",
    "opus"
  ],
  gemini: [
    "gemini-3.1-pro",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite"
  ]
};

export const DEFAULT_SETTINGS = {
  companionUrl: "http://127.0.0.1:6127",
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
  autoAnalyzeOnRequest: false,
  autoDownloadReplay: true,
  panelLayout: "classic",
  showOverlay: true,
  showAskFriendCard: true,
  showMoveSuggestions: true,
  showLocalIntelPanel: false,
  showOpponentActionPanel: false,
  showSelfActionPanel: false,
  showDamagePanel: false,
  showMechanicsPanel: false,
  showDebugPanel: false
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set(next);
  return next;
}
