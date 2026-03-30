import type { Provider, ProviderContext } from "./base.js";
import { MockProvider } from "./mockProvider.js";
import { CodexProvider } from "./codexProvider.js";
import { ClaudeProvider } from "./claudeProvider.js";
import { GeminiProvider } from "./geminiProvider.js";
import type { ProviderName } from "../types.js";

const providers: Record<ProviderName, Provider> = {
  mock: new MockProvider(),
  codex: new CodexProvider(),
  claude: new ClaudeProvider(),
  gemini: new GeminiProvider()
};

export function getProvider(name: ProviderName): Provider {
  return providers[name];
}

export async function getProviderHealth() {
  const entries = await Promise.all(
    Object.entries(providers).map(async ([name, provider]) => {
      const health = await provider.isAvailable();
      return [name, health] as const;
    })
  );
  return Object.fromEntries(entries);
}
