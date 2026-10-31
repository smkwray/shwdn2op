import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { BattleAgent } from "../battle-agent/battleAgent.js";
import { BATTLE_PROMPT_VARIANTS, OpenCodeBattlePolicy, OPENCODE_BATTLE_MODELS, refreshBattlePlan, type BattlePromptVariant } from "../battle-agent/opencode.js";
import { HEURISTIC_PRESENTATIONS, type HeuristicPresentation } from "../battle-agent/decisionCard.js";
import { inspectStrategicLedger } from "../battle-agent/strategicLedger.js";
import { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } from "../history/opponentIntelStore.js";
import { DecisionEngine } from "../state/decisionEngine.js";
import { evaluateDecision } from "../state/decisionEnvelope.js";

const controller = new AbortController();
let cancellationSignal: "SIGINT" | "SIGTERM" | null = null;
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
const cancel = (signal: "SIGINT" | "SIGTERM") => {
  if (cancellationSignal) return;
  cancellationSignal = signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  controller.abort(new Error("Battle-agent cancelled by caller."));
  shutdownTimer = setTimeout(() => { cleanup(); process.exit(process.exitCode); }, 2000);
  shutdownTimer.unref();
};
const sigint = () => cancel("SIGINT"), sigterm = () => cancel("SIGTERM");
process.on("SIGINT", sigint); process.on("SIGTERM", sigterm);
const cleanup = () => {
  clearTimeout(shutdownTimer);
  process.off("SIGINT", sigint); process.off("SIGTERM", sigterm);
  process.off("beforeExit", cleanup);
};
// Keep repeated signals from terminating the CLI during process-group cleanup.
process.once("beforeExit", cleanup);

async function main() {
  const { values } = parseArgs({ options: {
    model: { type: "string", default: "luna" }, input: { type: "string", default: "examples/raw-showdown-frame.sample.txt" },
    task: { type: "string", default: "action" }, prompt: { type: "string", default: "temporal" },
    heuristics: { type: "string", default: "banded" }, ledger: { type: "string" },
    output: { type: "string" }, fallback: { type: "string" }, "deadline-ms": { type: "string", default: "60000" }, help: { type: "boolean" }
  } });
  if (values.help) {
    console.log("battle-agent:decide --model sonnet|luna --input <one room-routed protocol frame> [--task action|plan] [--prompt baseline|temporal|card|card-ledger] [--heuristics raw|banded|hidden] [--ledger FILE] [--fallback sonnet|none] [--deadline-ms 60000] [--output result.json]\nAdvisory only; isolated history, no game submission. Plan is a separately invoked shadow task, never an action. Ledgers expire on any new request and are not live plan memory. The simulator supports baseline, temporal and card only.");
    return;
  }
  if (values.model !== "sonnet" && values.model !== "luna") throw new Error("Choose --model sonnet or luna; provider-qualified IDs are pinned to the verified OpenCode configuration.");
  if (values.task !== "action" && values.task !== "plan") throw new Error("--task must be action or plan.");
  if (!BATTLE_PROMPT_VARIANTS.includes(values.prompt as BattlePromptVariant)) throw new Error("Unsupported --prompt variant.");
  if (!HEURISTIC_PRESENTATIONS.includes(values.heuristics as HeuristicPresentation)) throw new Error("Unsupported --heuristics presentation.");
  if (values.task === "plan" && (values.ledger !== undefined || values.prompt !== "temporal" || values.heuristics !== "banded" || values.fallback !== undefined)) throw new Error("The shadow plan task does not accept action prompt, ledger, heuristic or fallback options.");
  if (values.ledger !== undefined && values.prompt !== "card-ledger") throw new Error("--ledger requires --prompt card-ledger.");
  if ((values.prompt === "baseline" || values.prompt === "temporal") && values.heuristics !== "banded") throw new Error("Heuristic presentation requires a card prompt.");
  const deadlineMs = Number(values["deadline-ms"]);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 300_000) throw new Error("Decision deadline must be between 1 and 300000 ms.");
  const fallback = values.fallback ?? (values.model === "luna" ? "sonnet" : "none");
  if (fallback !== "sonnet" && fallback !== "none") throw new Error("--fallback must be sonnet or none.");
  if (fallback === "sonnet" && values.model !== "luna") throw new Error("--fallback sonnet requires --model luna.");
  const data = await fs.readFile(values.input, "utf8");
  const roomId = data.match(/^>(battle-[^\r\n]+)\r?$/m)?.[1];
  if (!roomId) throw new Error("Input must contain one >battle-... routed protocol frame.");
  const engine = new DecisionEngine(), sessionId = "battle-agent-advisory";
  const current = await engine.ingest({ roomId, sessionId, observationId: "input-1", sequence: 1, source: "protocol", data });
  if (!current.snapshot || !current.identity) throw new Error("Input contains no decision snapshot.");
  const context = await projectCanonicalSnapshots([current.snapshot], await createEphemeralIntelEvaluationContext());
  const envelope = await evaluateDecision(engine, sessionId, current.identity, context);
  let strategicLedger: unknown;
  if (values.ledger !== undefined) {
    let text: string;
    try {
      const file = await fs.open(values.ledger, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const stat = await file.stat(), buffer = Buffer.alloc(12_001);
        if (!stat.isFile() || stat.size > 12_000) throw new Error();
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 12_000) throw new Error();
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally { await file.close(); }
    } catch { throw new Error("Ledger input must be a readable regular file of at most 12000 bytes."); }
    try {
      const artifact = JSON.parse(text);
      strategicLedger = artifact?.mode === "shadow_plan" && artifact.task === "PLAN_REFRESH" && artifact.authority === "advisory_only"
        ? artifact.ledger : {};
    }
    catch { strategicLedger = {}; }
  }
  const writeResult = async (result: unknown) => {
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (values.output) await fs.writeFile(values.output, text, { mode: 0o600 });
    console.log(text.trimEnd());
  };
  const modelReplies: Array<import("../battle-agent/opencode.js").OpenCodeAttemptEvent & { model: "luna" | "sonnet"; configuredModel: "luna" | "sonnet" }> = [];
  try {
    if (values.task === "plan") {
      const planned = await refreshBattlePlan({ requestId: "shadow-plan", envelope }, OPENCODE_BATTLE_MODELS[values.model], "opencode", {
        deadlineAt: Date.now() + deadlineMs, signal: controller.signal,
        assertCurrent: async () => { await engine.assertCurrent(sessionId, envelope.semantic.identity); }
      });
      await writeResult({ mode: "shadow_plan", task: "PLAN_REFRESH", authority: "advisory_only", ...planned,
        engineVersion: envelope.semantic.engineVersion, historyRevision: context.revision });
      return;
    }
    const ledgerView = inspectStrategicLedger({ requestId: "advisory", envelope }, strategicLedger);
    const promptContext = { variant: values.prompt, heuristics: values.prompt.startsWith("card") ? values.heuristics : "raw",
      ...(values.prompt === "card-ledger" ? { ledgerStatus: ledgerView.status, ledger: ledgerView.status === "valid" ? ledgerView.ledger : null } : {}) };
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS[values.model], "opencode", {
    promptVariant: values.prompt as BattlePromptVariant,
    ...(values.prompt.startsWith("card") ? { heuristicPresentation: values.heuristics as HeuristicPresentation } : {}),
    ...(values.prompt === "card-ledger" ? { strategicLedger } : {}),
    ...(fallback === "sonnet" ? { overloadFallback: OPENCODE_BATTLE_MODELS.sonnet } : {}),
    onAttempt: (attempt) => {
      const model = attempt.generationModel.providerID === OPENCODE_BATTLE_MODELS.luna.providerID
        && attempt.generationModel.id === OPENCODE_BATTLE_MODELS.luna.id ? "luna" : "sonnet";
      modelReplies.push({ ...attempt, model, configuredModel: values.model as "luna" | "sonnet" });
      if (attempt.outcome !== "accepted") process.stderr.write(JSON.stringify({ event: "model_reply", model,
        configuredModel: values.model, generationModel: attempt.generationModel, attemptKind: attempt.attemptKind,
        requestId: attempt.requestId, attempt: attempt.attempt, outcome: attempt.outcome, failureCode: attempt.failureCode }) + "\n");
    }
  });
    const decision = await new BattleAgent(engine, sessionId, policy).decide(envelope, {
      deadlineMs, signal: controller.signal
    });
    const actualContext = modelReplies.filter((attempt) => attempt.outcome === "accepted").at(-1)?.promptContext;
    const result = { mode: "advisory", decision, modelReplies,
      promptContext: { ...promptContext, ...actualContext,
        ...(actualContext?.ledgerStatus && actualContext.ledgerStatus !== "valid" ? { ledger: null } : {}) },
      choice: current.snapshot.legalActions.find((action) => action.id === decision.actionId)!.choice,
      engineVersion: envelope.semantic.engineVersion, historyRevision: context.revision,
      capabilities: envelope.semantic.capabilities };
    await writeResult(result);
  } catch (error) {
    if (!cancellationSignal) throw error;
    const text = `${JSON.stringify({ mode: "advisory", status: "cancelled", cancellationSignal, decision: null, choice: null }, null, 2)}\n`;
    if (values.output) await fs.writeFile(values.output, text);
    process.stdout.write(text);
  }
}
main().catch((error) => {
  console.error(cancellationSignal ? "Battle-agent cancelled by caller; artifact writing did not finish." : error instanceof Error ? error.message : String(error));
  if (!cancellationSignal) process.exitCode = 1;
});
