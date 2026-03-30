import fs from "node:fs/promises";
import path from "node:path";

import { battleSnapshotSchema } from "../schema.js";
import { getProvider } from "../providers/factory.js";
import type { ProviderName } from "../types.js";

async function main() {
  const providerName = (process.argv[2] ?? "mock") as ProviderName;
  const snapshotPath = process.argv[3]
    ? path.resolve(process.cwd(), process.argv[3])
    : path.resolve(process.cwd(), "../../examples/battle-snapshot.gen9ou.turn14.json");
  const requestedModel =
    process.argv[4] ??
    (providerName === "codex"
      ? process.env.SMOKE_CODEX_MODEL ?? "gpt-5.3-codex-spark"
      : providerName === "claude"
        ? process.env.SMOKE_CLAUDE_MODEL ?? "sonnet"
        : providerName === "gemini"
          ? process.env.SMOKE_GEMINI_MODEL ?? "gemini-3-flash-preview"
        : undefined);

  const text = await fs.readFile(snapshotPath, "utf8");
  const snapshot = battleSnapshotSchema.parse(JSON.parse(text));
  const provider = getProvider(providerName);

  const result = await provider.analyze(snapshot, { requestedModel });
  console.log(JSON.stringify(result, null, 2));
}

void main();
