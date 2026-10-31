// Metamon-only popup: one on/off toggle and the current recommendation.
import { currentMetamonAdvice, metamonText } from "./lib/metamon.js";

const toggleEl = document.getElementById("showMetamonAdvice");
const adviceEl = document.getElementById("metamonAdvice");
const statusEl = document.getElementById("companionStatus");

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function refresh() {
  if (!toggleEl.checked) { adviceEl.textContent = "Metamon advisor is off."; return; }
  const tab = await currentTab();
  const response = tab?.id ? await chrome.runtime.sendMessage({ type: "get-last-analysis", tabId: tab.id }).catch(() => null) : null;
  const advice = currentMetamonAdvice(response?.metamonAdvice, response?.envelope);
  adviceEl.textContent = advice
    ? metamonText(advice) + (advice.latencyMs == null ? "" : ` · ${Math.round(advice.latencyMs)} ms`)
    : "Open a gen9uu battle to see advice.";
}

async function refreshHealth() {
  const response = await chrome.runtime.sendMessage({ type: "companion-health" }).catch(() => null);
  statusEl.textContent = response?.ok ? "Companion connected." : "Companion unreachable on 127.0.0.1:6127.";
}

toggleEl.addEventListener("change", async () => {
  const response = await chrome.runtime.sendMessage({ type: "save-settings", payload: { showMetamonAdvice: toggleEl.checked } });
  const tab = await currentTab();
  if (tab?.id) await chrome.runtime.sendMessage({ type: "push-overlay-settings", tabId: tab.id, settings: response?.settings ?? { showMetamonAdvice: toggleEl.checked } }).catch(() => null);
  await refresh();
});

const { settings } = await chrome.runtime.sendMessage({ type: "get-settings" });
toggleEl.checked = settings?.showMetamonAdvice !== false;
await Promise.all([refresh(), refreshHealth()]);
const timer = setInterval(() => { void refresh(); }, 1000);
window.addEventListener("unload", () => clearInterval(timer), { once: true });
