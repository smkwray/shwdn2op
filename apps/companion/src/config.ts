import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const companionRoot = path.resolve(here, "..");
export const repoRoot = path.resolve(companionRoot, "..", "..");

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export const config = {
  host: env("COMPANION_HOST", "127.0.0.1"),
  port: Number.parseInt(env("COMPANION_PORT", "6127"), 10),
  codexBin: env("CODEX_BIN", "codex"),
  claudeBin: env("CLAUDE_BIN", "claude"),
  geminiBin: env("GEMINI_BIN", "gemini"),
  defaultProvider: env("DEFAULT_PROVIDER", "codex"),
  defaultCodexModel: env("DEFAULT_CODEX_MODEL", "gpt-5.4-mini"),
  defaultClaudeModel: env("DEFAULT_CLAUDE_MODEL", "sonnet"),
  defaultGeminiModel: env("DEFAULT_GEMINI_MODEL", "gemini-3-flash-preview"),
  claudeTimeoutMs: Number.parseInt(env("CLAUDE_TIMEOUT_MS", "240000"), 10),
  claudeEnableMcp: envBoolean("CLAUDE_ENABLE_MCP", false),
  geminiTimeoutMs: Number.parseInt(env("GEMINI_TIMEOUT_MS", "120000"), 10),
  localIntelStorePath: env("LOCAL_INTEL_STORE_PATH", path.resolve(repoRoot, ".local-data/opponent-intel.json")),
  externalCuratedStorePath: env("EXTERNAL_CURATED_STORE_PATH", path.resolve(repoRoot, ".local-data/external-curated-priors.json")),
  replaysDir: env("REPLAYS_DIR", path.resolve(repoRoot, "replays")),
  analysisSchemaPath: path.resolve(repoRoot, "packages/schemas/analysis-result.schema.json"),
  battleSnapshotSchemaPath: path.resolve(repoRoot, "packages/schemas/battle-snapshot.schema.json"),
  claudeMcpConfigPath: path.resolve(repoRoot, ".mcp.json")
};
