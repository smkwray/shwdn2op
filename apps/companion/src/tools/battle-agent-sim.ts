import { loadMetaMovePriorDescriptor } from "../history/metaPriorStore.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DeterministicBattlePolicy, type BattlePolicy } from "../battle-agent/battleAgent.js";
import { BATTLE_PROMPT_VARIANTS, CLAUDE_CODE_SONNET, GROK_46, OpenCodeBattlePolicy, OPENCODE_BATTLE_MODELS, type OpenCodeAttemptEvent, type BattlePromptVariant } from "../battle-agent/opencode.js";
import { HEURISTIC_PRESENTATIONS, type HeuristicPresentation, type ThreatPreviewPresentation } from "../battle-agent/decisionCard.js";
import { MetamonAdvisedBattlePolicy, MetamonBattlePolicy, type MetamonAdviceEvent } from "../battle-agent/metamon.js";
import { RandomBattlePolicy, runBattleMatch, type BattleSeed } from "../battle-agent/simulator.js";

const controller = new AbortController();
let cancellationSignal: "SIGINT" | "SIGTERM" | null = null;
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
const cancel = (signal: "SIGINT" | "SIGTERM") => {
  if (cancellationSignal) return;
  cancellationSignal = signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  controller.abort(new Error("Match cancelled by caller."));
  // Bound artifact I/O after cancellation, allowing the existing 150ms local
  // process-group cleanup to finish. Normal completion need not wait two seconds.
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
// A policy rejection precedes its process-group escalation. Keep handling even
// repeated signals until the referenced cleanup timers and artifact I/O finish.
process.once("beforeExit", cleanup);

const HELP = `Offline agent-vs-agent simulator (no browser, network battle, or real history writes).

Usage: node --import tsx apps/companion/src/tools/battle-agent-sim.ts [options]
  --p1 deterministic|random|sonnet|luna|claude-sonnet|grok|metamon   Default: deterministic
  --p2 deterministic|random|sonnet|luna|claude-sonnet|grok|metamon   Default: random
  --metamon-command EXECUTABLE          Required with metamon; explicit worker launcher
  --metamon-args JSON_ARRAY             Literal worker argv (no local shell); default: []
  --metamon-advice p1|p2|both           Opt in for model players; separate actor advisor, 5s wait
  --metamon-advice-mode suggest|veto   Default: suggest; requires --metamon-advice
  --team FILE                          Both teams; default: examples/gen9uu-scizor-proposal.txt
  --team-p1 FILE --team-p2 FILE         Override individual teams (Showdown import text)
  --format FORMAT                      Default: gen9uu (pinned simulator validation)
  --seed A,B,C,D                        Four integers 0..65535; default: 1,2,3,4
  --max-turns N                        Default: 200; truncation is not a win/tie
  --max-decisions N                    Default: max-turns * 12 + 12 (includes retries)
  --timeout-ms N                       Whole match deadline; default: 1800000
  --decision-ms N                      Per-policy budget; default: 30000
  --model-attempts 1|2                  OpenCode only; default: 2, one logged correction
  --retry-connection-reset              Opt in to one declared-reset retry, sharing the correction allowance
  --retry-service-unavailable           Opt in to one same-model retry on a generic declared 503, sharing the correction
                                        allowance; with --fallback sonnet a second declared 503 may hop to Sonnet
  --retry-stalled-ms N                  Opt in to one same-model retry after 10000–110000 ms, sharing the correction
                                        allowance and original deadline; requires a model player and --model-attempts 2
                                        modelReplies: stallRetries, stallRecovered, stallRetryEnabledMs (null when off)
  --prompt baseline|temporal|card      OpenCode only; default: temporal; live ledger carry is unavailable
  --heuristics raw|banded|hidden       Card only; default: banded; exact legal set is unchanged
  --card-threat full|hidden            Default: full; requires a model player; ablate incoming damage previews
  --fallback sonnet|none|deterministic  Default: sonnet with Luna, otherwise none; declared overload only
  --fallback-ms N                      Fresh fallback budget; default: 5000
  --output DIRECTORY                   Artifacts directory; default: a new system temp directory
  --move-priors FILE                   Explicit local monthly move-prior descriptor; default: off
  --trace                              Write private p1/p2 traces as JSONL frame strings
  --owned-checkpoint-at NUMBER         Repeatable privileged native capture at a 1-based trajectory entry;
                                      requires --trace and private output outside this project
  --progress                           Write accepted-decision progress to stderr
  --help

The default matchup is free. Selecting sonnet/luna explicitly makes model calls
through the configured local OpenCode CLI. Model IDs:
  sonnet: ${OPENCODE_BATTLE_MODELS.sonnet.providerID}/${OPENCODE_BATTLE_MODELS.sonnet.id}
  luna:   ${OPENCODE_BATTLE_MODELS.luna.providerID}/${OPENCODE_BATTLE_MODELS.luna.id}
  claude-sonnet: ${CLAUDE_CODE_SONNET.id} effort ${CLAUDE_CODE_SONNET.variant} through the isolated Claude Code CLI (CLAUDE_BIN, default claude)
  grok:   ${GROK_46.id} effort ${GROK_46.variant} through the isolated Grok CLI (GROK_BIN, default grok)
Metamon uses a separately installed, pinned Kakuna worker and requires an explicit
--format gen9ou or --format gen9uu. UU is experimental/out_of_distribution, not
trained UU support; bounded compatibility checks do not qualify full UU lifecycle or strength.
Each selected side starts its own worker. Team preview uses the upstream random policy.
Exit codes: 0 completed, 2 truncated, 1 failed/rejected configuration, 130 SIGINT, 143 SIGTERM.
`;


async function main() {
  const { values } = parseArgs({ options: {
    p1: { type: "string" }, p2: { type: "string" }, team: { type: "string" },
    "team-p1": { type: "string" }, "team-p2": { type: "string" }, format: { type: "string" },
    seed: { type: "string" }, "max-turns": { type: "string" }, "max-decisions": { type: "string" },
    "timeout-ms": { type: "string" }, "decision-ms": { type: "string" }, "fallback-ms": { type: "string" },
    "move-priors": { type: "string" }, "model-attempts": { type: "string" }, "retry-connection-reset": { type: "boolean" }, "retry-service-unavailable": { type: "boolean" }, "retry-stalled-ms": { type: "string" }, "owned-checkpoint-at": { type: "string", multiple: true },
    prompt: { type: "string" }, heuristics: { type: "string" }, "card-threat": { type: "string" },
    fallback: { type: "string" }, output: { type: "string" }, trace: { type: "boolean" }, progress: { type: "boolean" }, help: { type: "boolean" },
    "metamon-command": { type: "string" }, "metamon-args": { type: "string" }, "metamon-advice": { type: "string" },
    "metamon-advice-mode": { type: "string" }
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (values["metamon-advice-mode"] !== undefined && values["metamon-advice"] === undefined) throw new Error("--metamon-advice-mode requires --metamon-advice.");
  const adviceMode = values["metamon-advice-mode"] ?? "suggest";
  if (adviceMode !== "suggest" && adviceMode !== "veto") throw new Error("--metamon-advice-mode must be suggest or veto.");
  const ownedCheckpointAt = values["owned-checkpoint-at"]?.map((value) => {
    const index = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || index < 1) throw new Error("--owned-checkpoint-at requires positive safe integers.");
    return index;
  });
  if (new Set(ownedCheckpointAt).size !== (ownedCheckpointAt?.length ?? 0)) throw new Error("--owned-checkpoint-at entries must be unique.");
  let ownedDirectory: string | undefined;
  if (ownedCheckpointAt !== undefined) {
    if (!values.trace) throw new Error("--owned-checkpoint-at requires --trace.");
    const project = await fs.realpath(fileURLToPath(new URL("../../../../", import.meta.url)));
    let ancestor = values.output ? path.resolve(values.output) : await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-sim-"));
    const missing: string[] = [];
    // Resolve the nearest existing ancestor before creating anything, including
    // destinations reached through a symlink to the project.
    for (;;) {
      try { ownedDirectory = path.join(await fs.realpath(ancestor), ...missing); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
      }
    }
    const relative = path.relative(project, ownedDirectory);
    if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) throw new Error("Owned checkpoint output must be outside the project.");
    await fs.mkdir(ownedDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && ((await fs.stat(ownedDirectory)).mode & 0o077)) throw new Error("Owned checkpoint output directory must be private (0700).");
  }
  const movePriors = values["move-priors"] === undefined ? undefined : await loadMetaMovePriorDescriptor(values["move-priors"], fileURLToPath(new URL("../../../../", import.meta.url)));
  const words = (values.seed ?? "1,2,3,4").split(",").map(Number);
  if (words.length !== 4 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 65535)) throw new Error("Invalid --seed; expected four integers from 0 to 65535.");
  const seed = words as unknown as BattleSeed;
  if (values["metamon-advice"] !== undefined && !["p1", "p2", "both"].includes(values["metamon-advice"])) throw new Error("--metamon-advice must be p1, p2 or both.");
  const advisedSides = values["metamon-advice"] === undefined ? [] : values["metamon-advice"] === "both" ? [1, 2]
    : [values["metamon-advice"] === "p1" ? 1 : 2];
  for (const side of advisedSides) if (!["luna", "sonnet", "claude-sonnet", "grok"].includes((side === 1 ? values.p1 : values.p2) ?? "")) throw new Error("Metamon advice requires a model player on each selected side.");
  const usesMetamon = [values.p1, values.p2].includes("metamon") || advisedSides.length > 0;
  let metamonArgs: string[] = [];
  if (usesMetamon) {
    if (values.format !== "gen9ou" && values.format !== "gen9uu") throw new Error("Kakuna requires explicit --format gen9ou or --format gen9uu (experimental/out_of_distribution, not trained UU support).");
    if (!values["metamon-command"]?.trim()) throw new Error("Metamon requires --metamon-command for a qualified worker runtime.");
    const args: unknown = JSON.parse(values["metamon-args"] ?? "[]");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("--metamon-args must be a JSON array of literal strings.");
    metamonArgs = args;
  } else if (values["metamon-command"] !== undefined || values["metamon-args"] !== undefined) {
    throw new Error("Metamon launch options require a metamon player.");
  }
  const usesOpenCode = [values.p1, values.p2].some((name) => name === "sonnet" || name === "luna" || name === "claude-sonnet" || name === "grok");
  const threatPreview = values["card-threat"] ?? "full";
  if (threatPreview !== "full" && threatPreview !== "hidden") throw new Error("--card-threat must be full or hidden.");
  if (!usesOpenCode && values["card-threat"] !== undefined) throw new Error("--card-threat requires a model player.");
  const promptVariant = values.prompt ?? "temporal", heuristics = values.heuristics ?? "banded";
  if (!BATTLE_PROMPT_VARIANTS.includes(promptVariant as BattlePromptVariant) || promptVariant === "card-ledger") throw new Error("Simulator --prompt must be baseline, temporal or card; live ledger carry is unavailable.");
  if (!HEURISTIC_PRESENTATIONS.includes(heuristics as HeuristicPresentation)) throw new Error("Unsupported --heuristics presentation.");
  if (!usesOpenCode && (values.prompt !== undefined || values.heuristics !== undefined)) throw new Error("Prompt options require an OpenCode player.");
  if (values.heuristics !== undefined && promptVariant !== "card") throw new Error("--heuristics requires --prompt card.");
  const promptContext: NonNullable<OpenCodeAttemptEvent["promptContext"]> = {
    variant: promptVariant as BattlePromptVariant,
    heuristics: promptVariant === "card" ? heuristics as HeuristicPresentation : "raw",
    threatPreview
  };
  const modelAttempts = Number(values["model-attempts"] ?? "2");
  if (modelAttempts !== 1 && modelAttempts !== 2) throw new Error("--model-attempts must be 1 or 2.");
  if (!usesOpenCode && values["model-attempts"] !== undefined) throw new Error("--model-attempts requires an OpenCode player.");
  if (values["retry-connection-reset"] && (!usesOpenCode || modelAttempts !== 2)) throw new Error("--retry-connection-reset requires an OpenCode player and --model-attempts 2.");
  if (values["retry-service-unavailable"] && (!usesOpenCode || modelAttempts !== 2)) throw new Error("--retry-service-unavailable requires an OpenCode player and --model-attempts 2.");
  const stallRetryEnabledMs = values["retry-stalled-ms"] === undefined ? undefined : Number(values["retry-stalled-ms"]);
  if (stallRetryEnabledMs !== undefined) {
    if (!usesOpenCode || modelAttempts !== 2) throw new Error("--retry-stalled-ms requires an OpenCode player and --model-attempts 2.");
    if (!Number.isInteger(stallRetryEnabledMs) || stallRetryEnabledMs < 10_000 || stallRetryEnabledMs > 110_000) throw new Error("--retry-stalled-ms must be an integer from 10000 to 110000.");
  }
  const fallback = values.fallback ?? ([values.p1, values.p2].includes("luna") ? "sonnet" : "none");
  if (!["sonnet", "none", "deterministic"].includes(fallback)) throw new Error("--fallback must be sonnet, none or deterministic.");
  if (fallback === "sonnet" && ![values.p1, values.p2].includes("luna")) throw new Error("--fallback sonnet requires a Luna player.");
  type ModelPlayer = "sonnet" | "luna" | "claude-sonnet" | "grok";
  const replyAttempts: Array<OpenCodeAttemptEvent & { model: ModelPlayer; configuredModel: ModelPlayer; promptContext: typeof promptContext }> = [];
  const adviceEvents: Array<MetamonAdviceEvent & { side: "p1" | "p2" }> = [];
  const basePolicy = (name: string, side: number): BattlePolicy => {
    if (name === "deterministic") return new DeterministicBattlePolicy();
    if (name === "random") return new RandomBattlePolicy([seed[0], seed[1], seed[2], (seed[3] + side) % 65536]);
    if (name === "sonnet" || name === "luna" || name === "claude-sonnet" || name === "grok") return new OpenCodeBattlePolicy(
      name === "claude-sonnet" ? CLAUDE_CODE_SONNET : name === "grok" ? GROK_46 : OPENCODE_BATTLE_MODELS[name],
      name === "claude-sonnet" ? process.env.CLAUDE_BIN ?? "claude" : name === "grok" ? process.env.GROK_BIN ?? "grok" : "opencode", {
      promptVariant: promptVariant as BattlePromptVariant,
      threatPreview: threatPreview as ThreatPreviewPresentation,
      ...(promptVariant === "card" ? { heuristicPresentation: heuristics as HeuristicPresentation } : {}),
      ...(name === "luna" && fallback === "sonnet" ? { overloadFallback: OPENCODE_BATTLE_MODELS.sonnet } : {}),
      maxAttempts: modelAttempts, retryConnectionReset: values["retry-connection-reset"] ?? false,
      retryServiceUnavailable: values["retry-service-unavailable"] ?? false,
      ...(stallRetryEnabledMs === undefined ? {} : { retryStalledGeneration: { afterMs: stallRetryEnabledMs } }),
      captureRejectedText: values.trace ?? false, captureTransportErrors: values.trace ?? false,
      onAttempt: (attempt) => {
        const model = attempt.generationModel.providerID === CLAUDE_CODE_SONNET.providerID ? "claude-sonnet"
          : attempt.generationModel.providerID === GROK_46.providerID ? "grok"
          : attempt.generationModel.providerID === OPENCODE_BATTLE_MODELS.luna.providerID
          && attempt.generationModel.id === OPENCODE_BATTLE_MODELS.luna.id ? "luna" : "sonnet";
        replyAttempts.push({ ...attempt, model, configuredModel: name, promptContext: { ...promptContext } });
        if (values.progress || attempt.outcome !== "accepted") process.stderr.write(JSON.stringify({
          event: "model_reply", model, configuredModel: name, generationModel: attempt.generationModel, attemptKind: attempt.attemptKind, requestId: attempt.requestId, attempt: attempt.attempt,
          outcome: attempt.outcome, failureCode: attempt.failureCode
        }) + "\n");
      }
    });
    if (name === "metamon") return new MetamonBattlePolicy({ command: values["metamon-command"]!, args: metamonArgs });
    throw new Error(`Unknown policy: ${name}. See --help.`);
  };
  const policy = (name: string, side: number): BattlePolicy => {
    const base = basePolicy(name, side);
    return !advisedSides.includes(side) ? base : new MetamonAdvisedBattlePolicy(base,
      new MetamonBattlePolicy({ command: values["metamon-command"]!, args: metamonArgs }), {
        mode: adviceMode,
        onAdvice: (event) => { adviceEvents.push({ ...structuredClone(event), side: side === 1 ? "p1" : "p2" }); }
      });
  };
  const defaultTeam = values.team ?? fileURLToPath(new URL("../../../../examples/gen9uu-scizor-proposal.txt", import.meta.url));
  const result = await runBattleMatch({ p1: policy(values.p1 ?? "deterministic", 1), p2: policy(values.p2 ?? "random", 2),
    teams: { p1: await fs.readFile(values["team-p1"] ?? defaultTeam, "utf8"), p2: await fs.readFile(values["team-p2"] ?? defaultTeam, "utf8") },
    seed, fallback: fallback === "deterministic" ? "deterministic" : "none", trace: values.trace ?? false, callerAbortSignal: controller.signal,
    ...(ownedCheckpointAt === undefined ? {} : { ownedCheckpointAt }),
    ...(movePriors === undefined ? {} : { movePriors }),
    ...(values.progress ? { onDecision: ({ side, envelope, decision }) => process.stderr.write(JSON.stringify({
      event: "decision_accepted", side, turn: envelope.semantic.snapshot.turn, rqid: decision.identity.rqid,
      policyId: decision.policyId, latencyMs: decision.latencyMs
    }) + "\n") } : {}),
    ...(values.format ? { format: values.format } : {}),
    ...(values["max-turns"] ? { maxTurns: Number(values["max-turns"]) } : {}),
    ...(values["max-decisions"] ? { maxDecisions: Number(values["max-decisions"]) } : {}),
    ...(values["timeout-ms"] ? { timeoutMs: Number(values["timeout-ms"]) } : {}),
    ...(values["decision-ms"] ? { decisionDeadlineMs: Number(values["decision-ms"]) } : {}),
    ...(values["fallback-ms"] ? { fallbackDeadlineMs: Number(values["fallback-ms"]) } : {})
  });
  const { trajectory, replay, replayInputs, playerTraces, producerSources, ownedCheckpoints, ...matchSummary } = result;
  const summary = { ...matchSummary, cancellationSignal,
    ...(advisedSides.length ? { metamonAdvice: { sides: advisedSides.map((side) => side === 1 ? "p1" : "p2"), waitMs: 5000, mode: adviceMode,
      vetoProposals: adviceEvents.filter((event) => event.mode === "veto" && event.phase === "opinion" && event.status === "available").length,
      vetoAccepted: adviceEvents.filter((event) => event.phase === "commit" && event.mode === "veto" && event.override === "accepted").length,
      vetoRejected: Object.fromEntries(["missing_override", "invalid_card_field", "illegal_action"].map((code) => [code,
        adviceEvents.filter((event) => event.phase === "commit" && event.mode === "veto" && event.override === `rejected:${code}`).length])),
      eligible: adviceEvents.filter((event) => event.phase === "opinion" && event.eligible).length,
      available: adviceEvents.filter((event) => event.phase === "opinion" && event.status === "available").length,
      unavailable: adviceEvents.filter((event) => event.phase === "opinion" && event.eligible && event.status === "unavailable").length,
      commits: adviceEvents.filter((event) => event.phase === "commit" && event.status === "committed").length,
      overrides: adviceEvents.filter((event) => event.phase === "commit" && event.status === "committed" && event.adviceShown
        && event.proposedActionId !== undefined && event.proposedActionId !== event.selectedActionId).length
    } } : {}),
    ...(usesMetamon ? { metamon: {
      formatQualification: values.format === "gen9uu" ? "experimental_out_of_distribution" : "gen9ou_baseline",
      notes: (values.format === "gen9uu"
        ? "Unchanged Kakuna epoch34; not trained UU support. Only bounded parser and teacher-forced recurrent compatibility is qualified; full UU gameplay/lifecycle and strength remain unqualified. "
        : "Kakuna epoch34 Gen 9 OU baseline. ") + "Team preview uses the upstream random policy, not the network."
    } } : {}),
    ...(usesOpenCode ? { promptContext, modelReplies: { maxAttemptsPerDecision: modelAttempts, maxGenerationsPerDecision: modelAttempts + (fallback === "sonnet" ? 1 : 0), attempts: replyAttempts.length,
      accepted: replyAttempts.filter((entry) => entry.outcome === "accepted").length,
      rejected: replyAttempts.filter((entry) => entry.outcome === "rejected").length,
      failed: replyAttempts.filter((entry) => entry.outcome === "failed").length,
      recovered: replyAttempts.filter((entry) => entry.outcome === "accepted" && entry.attemptKind === "format_correction").length,
      connectionResetRecoveryEnabled: values["retry-connection-reset"] ?? false,
      resetRetries: replyAttempts.filter((entry) => entry.attemptKind === "transport_reset").length,
      resetRecovered: replyAttempts.filter((entry) => entry.outcome === "accepted" && entry.attemptKind === "transport_reset").length,
      serviceRetryEnabled: values["retry-service-unavailable"] ?? false,
      serviceRetries: replyAttempts.filter((entry) => entry.attemptKind === "service_retry").length,
      serviceRecovered: replyAttempts.filter((entry) => entry.outcome === "accepted" && entry.attemptKind === "service_retry").length,
      stallRetryEnabledMs: stallRetryEnabledMs ?? null,
      stallRetries: replyAttempts.filter((entry) => entry.attemptKind === "stall_retry").length,
      stallRecovered: replyAttempts.filter((entry) => entry.outcome === "accepted" && entry.attemptKind === "stall_retry").length,
      capacityHops: replyAttempts.filter((entry) => entry.attemptKind === "capacity_fallback").length,
      fallbackAccepted: replyAttempts.filter((entry) => entry.outcome === "accepted" && entry.model !== entry.configuredModel).length
    } } : {}) };
  const paths: Record<string, string> = {};
  {
    const directory = ownedDirectory ?? (values.output ? path.resolve(values.output) : await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-sim-")));
    await fs.mkdir(directory, { recursive: true });
    const write = async (key: string, name: string, content: string, privateData = false) => {
      paths[key] = path.join(directory, name);
      await fs.writeFile(paths[key]!, content, { flag: "wx", ...(privateData ? { mode: 0o600 } : {}) });
    };
    await write("trajectory", "trajectory.jsonl", trajectory.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await write("replay", "replay.log", replay);
    await write("replayInputs", "replay-inputs.json", JSON.stringify(replayInputs, null, 2) + "\n", true);
    await write("producer", "producer-source.json", JSON.stringify({ hash: result.versions.producer, sources: producerSources }, null, 2) + "\n");
    if (playerTraces) for (const side of ["p1", "p2"] as const) {
      const frames = playerTraces[side].map((frame) => JSON.stringify(frame));
      await write(`${side}Trace`, `${side}-private.jsonl`, frames.join("\n") + (frames.length ? "\n" : ""), true);
    }
    if (ownedCheckpoints) await write("ownedCheckpoints", "owned-checkpoints.jsonl", ownedCheckpoints.map((entry) => JSON.stringify(entry)).join("\n") + (ownedCheckpoints.length ? "\n" : ""), true);
    if (usesOpenCode) await write("modelReplies", "model-replies.jsonl", replyAttempts.map((entry) => JSON.stringify(entry)).join("\n") + "\n", true);
    if (advisedSides.length) await write("metamonAdvice", "metamon-advice.jsonl", adviceEvents.map((entry) => JSON.stringify(entry)).join("\n") + (adviceEvents.length ? "\n" : ""), true);
    paths.summary = path.join(directory, "summary.json");
    await fs.writeFile(paths.summary, JSON.stringify({ ...summary, paths }, null, 2) + "\n", { flag: "wx" });
  }
  process.stdout.write(JSON.stringify({ ...summary, paths }, null, 2) + "\n");
  if (!cancellationSignal) process.exitCode = result.status === "completed" ? 0 : result.status === "truncated" ? 2 : 1;
}

main().catch((error) => {
  console.error(cancellationSignal ? "Match cancelled by caller; artifact writing did not finish." : error instanceof Error ? error.message : String(error));
  if (!cancellationSignal) process.exitCode = 1;
});
