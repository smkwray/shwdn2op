import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-battle-agent-"));
// Executable mocks use require(), even if TMPDIR is inside this ESM project.
await fs.writeFile(path.join(directory, "package.json"), '{"type":"commonjs"}\n');
process.env.LOCAL_INTEL_STORE_PATH = path.join(directory, "history.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(directory, "curated.json");
const { DecisionEngine } = await import("../state/decisionEngine.js");
const { evaluateDecision } = await import("../state/decisionEnvelope.js");
const { captureIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
const { BattleAgent, BattleActionExecutor, DeterministicBattlePolicy } = await import("../battle-agent/battleAgent.js");
const { BATTLE_PROMPT_VARIANTS, CLAUDE_CODE_SONNET, GROK_46, OpenCodeBattlePolicy, OPENCODE_BATTLE_MODELS, buildBattlePolicyPrompt } = await import("../battle-agent/opencode.js");
const { HEURISTIC_PRESENTATIONS } = await import("../battle-agent/decisionCard.js");
import type { BattleAdvice, BattlePolicy, BattleDecision, BattlePolicyInput } from "../battle-agent/battleAgent.js";
import type { OpenCodeAttemptEvent, OpenCodeBattlePolicyOptions } from "../battle-agent/opencode.js";

const source = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
const initial = source.replace(/^\|request\|(.*)$/m, (_line, data) => `|request|${JSON.stringify({ ...JSON.parse(data), rqid: 47 })}`);
const roomId = "battle-gen9ou-123456789", sessionId = "agent-test";
async function fixture() {
  const engine = new DecisionEngine();
  const current = await engine.ingest({ roomId, sessionId, observationId: "initial", sequence: 1, source: "protocol", data: initial });
  const context = await captureIntelEvaluationContext();
  const envelope = await evaluateDecision(engine, sessionId, current.identity!, context);
  return { engine, envelope, context };
}

test("OpenCode receives the same forced-switch timing qualification as the human recommendation", async () => {
  const { envelope } = await fixture();
  const timing = { status: "unknown" as const, summary: "Opponent action timing is unresolved.", factIds: ["synthetic:turn"] };
  const prediction = envelope.semantic.localIntel.opponentActionPrediction!;
  prediction.replyTiming = timing;
  const body = buildBattlePolicyPrompt({ requestId: "timing", envelope }).split("\n\n")
    .filter((part) => part.startsWith("{" )).map((part) => JSON.parse(part)).find((part) => part.engineAnalysis);
  assert.deepEqual(body.engineAnalysis.replyTiming, timing);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const mockBaseDirectory = path.join(directory, "PRIVATE_SERVER_CONFIG with spaces=1");
const readyModels = Object.values(OPENCODE_BATTLE_MODELS).map((model) => ({
  providerID: model.providerID, id: model.id, enabled: true, variants: [{ id: model.variant }]
}));

/** Serve metadata separately, leaving every generation fixture's argv, output
 * and call counter assertions intact. The server config directory deliberately
 * differs from cwd and from the later project directory discovery entry. */
function mockOpenCodeScript(generation: string, catalog = `process.stdout.write(JSON.stringify({location:{directory:${JSON.stringify(mockBaseDirectory)}},data:${JSON.stringify(readyModels)}}));`,
  config = `process.stdout.write(JSON.stringify([{type:'document',info:{PRIVATE_CONFIG:'PRIVATE_CONFIG'}},{type:'directory',path:${JSON.stringify(mockBaseDirectory)}},{type:'directory',path:'PRIVATE_PROJECT_DIRECTORY'}]));`,
  server = `process.stdout.write(JSON.stringify({version:'2.0.20',pid:1,urls:['PRIVATE_SERVER_URL'],paths:{tmp:'PRIVATE_SERVER_TMP'}}));`) {
  return `#!/usr/bin/env node
if (process.argv[2]==='api' && process.argv[3]==='server.info') {
  require('node:assert/strict').deepEqual(process.argv.slice(2),['api','server.info']);
  ${server}
} else if (process.argv[2]==='api' && process.argv[3]==='config.get') {
  require('node:assert/strict').deepEqual(process.argv.slice(2),['api','config.get']);
  ${config}
} else if (process.argv[2]==='api' && process.argv[3]==='model.list') {
  require('node:assert/strict').deepEqual(process.argv.slice(2),['api','model.list','--param',${JSON.stringify(`location[directory]=${mockBaseDirectory}`)}]);
  ${catalog}
} else {
  ${generation}
}
`;
}

/** Local executable fixtures only: count generation separately from metadata
 * and allow either reply to wait for an engine/cancellation change. */
async function recoveryMock(replies: Array<{ text?: string; stdout?: string; exitCode?: number; hold?: boolean; holdChild?: boolean }>,
  catalogs: Array<{ data?: unknown; stdout?: string; exitCode?: number; hold?: boolean }> = [{ data: readyModels }]) {
  const dir = await fs.mkdtemp(path.join(directory, "recovery-"));
  const binary = path.join(dir, "opencode"), callsFile = path.join(dir, "calls.jsonl"), releaseFile = path.join(dir, "release");
  const catalogsFile = path.join(dir, "catalogs.jsonl");
  const pidsFile = path.join(dir, "pids.json");
  await fs.writeFile(binary, mockOpenCodeScript(`
const fs = require('node:fs');
const body = JSON.parse(process.argv[5]);
let prior = '';
try { prior = fs.readFileSync(${JSON.stringify(callsFile)},'utf8'); } catch {}
const index = prior.trim() ? prior.trim().split('\\n').length : 0;
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(body)+'\\n');
const response = ${JSON.stringify(replies)}[index];
if (!response) process.exit(77);
const data = body.prompt.split('\\n\\n').filter(p=>p.startsWith('{')).map(p=>JSON.parse(p)).find(p=>p.battle);
const reply = () => {
  process.stderr.write('PRIVATE_STDERR_CANARY');
  process.stdout.write(response.stdout ?? JSON.stringify({data:{text:response.text ?? JSON.stringify({actionId:data.legalActions.find(a=>a.choice && !a.disabled).id})}}));
  process.exitCode = response.exitCode ?? 0;
};
if (response.hold) {
  const child = response.holdChild ? require('node:child_process').spawn(process.execPath,
    ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'inherit'}) : undefined;
  fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, ...(child ? [child.pid] : [])]));
  const timer = setInterval(()=>{ if (fs.existsSync(${JSON.stringify(releaseFile)})) { clearInterval(timer); reply(); } },5);
} else reply();
`, `
const fs = require('node:fs');
let prior = '';
try { prior = fs.readFileSync(${JSON.stringify(catalogsFile)},'utf8'); } catch {}
const index = prior.trim() ? prior.trim().split('\\n').length : 0;
fs.appendFileSync(${JSON.stringify(catalogsFile)},JSON.stringify(process.argv.slice(2))+'\\n');
const responses = ${JSON.stringify(catalogs)};
const response = responses[Math.min(index,responses.length-1)];
const reply = () => {
  process.stderr.write('PRIVATE_CATALOG_STDERR');
  process.stdout.write(response.stdout ?? JSON.stringify({location:{directory:${JSON.stringify(mockBaseDirectory)}},data:response.data}));
  process.exitCode = response.exitCode ?? 0;
};
if (response.hold) {
  const timer = setInterval(()=>{ if (fs.existsSync(${JSON.stringify(releaseFile)})) { clearInterval(timer); reply(); } },5);
} else reply();
`), { mode: 0o700 });
  const calls = async (): Promise<Array<{ prompt: string; model: unknown }>> => {
    const lines = await fs.readFile(callsFile, "utf8").catch(() => "");
    return lines.trim() ? lines.trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  const catalogCalls = async (): Promise<string[][]> => {
    const lines = await fs.readFile(catalogsFile, "utf8").catch(() => "");
    return lines.trim() ? lines.trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  return { binary, calls, catalogCalls, pids: async (): Promise<number[]> => JSON.parse(await fs.readFile(pidsFile, "utf8")),
    release: () => fs.writeFile(releaseFile, "go"), async waitForCatalog(count: number) {
    const until = performance.now() + 2000;
    while (performance.now() < until && (await catalogCalls()).length < count) await delay(5);
    assert.equal((await catalogCalls()).length, count, "expected mock metadata query must start");
  }, async waitFor(count: number) {
    const until = performance.now() + 2000;
    while (performance.now() < until && (await calls()).length < count) await delay(5);
    assert.equal((await calls()).length, count, "expected mock generation must start");
  } };
}

async function promptly<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Operation still pending behind engine lock.")), 250);
    })]);
  } finally { clearTimeout(timer!); }
}

test("battle-agent binds a proposal to its current envelope and never dispatches in advisory mode", async () => {
  const { engine, envelope } = await fixture();
  const agent = new BattleAgent(engine, sessionId, new DeterministicBattlePolicy());
  const decision = await agent.decide(envelope, { requestId: "bound", deadlineMs: 1000 });
  assert.equal(decision.requestId, "bound");
  assert.deepEqual(decision.identity, envelope.semantic.identity);
  assert.equal(decision.inputResultHash, envelope.resultHash);
  assert.ok(envelope.semantic.snapshot.legalActions.some((action) => action.id === decision.actionId));
  let sent = 0;
  const executor = new BattleActionExecutor(engine, sessionId, () => { sent++; return true; });
  await assert.rejects(executor.execute(decision), /not authorized/);
  assert.equal(sent, 0);
  await assert.rejects(agent.decide({ ...envelope, resultHash: "sha256:wrong" }, { deadlineMs: 1000 }), /envelope hash/);
});

// Matters: Metamon chooses only from the server's legal actions and models Substitute/Transform itself, so engine
// mechanics-analysis gaps must not stop it (real human UU teams use Substitute). Identity, continuity and lifecycle
// gaps, finished games and policies that consume engine mechanics must still fail closed.
test("mechanics-only engine gaps permit only policies that do not consume engine mechanics", async () => {
  const { hashCanonical } = await import("../../../extension/lib/decision-identity.js");
  const { MetamonBattlePolicy } = await import("../battle-agent/metamon.js");
  const { engine, envelope } = await fixture();
  const gapped = async (limitations: string[], edit: (semantic: any) => void = () => {}) => {
    const semantic = structuredClone(envelope.semantic) as any;
    semantic.capabilities = { ...semantic.capabilities, status: "unsupported", actionable: false, limitations: [...limitations, "heuristic_ranking", "uncalibrated_confidence"] };
    edit(semantic);
    return { ...envelope, semantic, resultHash: await hashCanonical(semantic) };
  };
  const choose = async (input: BattlePolicyInput) => ({ requestId: input.requestId, identity: input.envelope.semantic.identity,
    actionId: input.envelope.semantic.snapshot.legalActions.find((action) => !action.disabled)!.id });
  const metamonLike: BattlePolicy = { id: "metamon-like", requiresSupportedMechanics: false, decide: choose };
  const llmLike: BattlePolicy = { id: "llm-like", decide: choose };
  for (const gap of ["substitute_mechanics_unavailable", "transform_mechanics_unavailable", "suppressed_mechanics_unavailable", "temporary_ability_forecasts_unavailable"]) {
    const gappedEnvelope = await gapped([gap]);
    const decision = await new BattleAgent(engine, sessionId, metamonLike).decide(gappedEnvelope, { deadlineMs: 1000 });
    assert.ok(gappedEnvelope.semantic.snapshot.legalActions.some((action: { id: string }) => action.id === decision.actionId), gap);
    await assert.rejects(new BattleAgent(engine, sessionId, llmLike).decide(gappedEnvelope, { deadlineMs: 1000 }), /not actionable/);
  }
  for (const gap of ["identity_ambiguous", "history_lineage_conflict", "recovery_public_continuity_unknown", "same_epoch_recovery_conflict", "preview_reset_unavailable", "revival_ranking_unavailable"]) {
    await assert.rejects(new BattleAgent(engine, sessionId, metamonLike).decide(await gapped(["substitute_mechanics_unavailable", gap]), { deadlineMs: 1000 }), /not actionable/, gap);
  }
  await assert.rejects(new BattleAgent(engine, sessionId, metamonLike).decide(
    await gapped(["substitute_mechanics_unavailable"], (semantic) => { semantic.snapshot.phase = "finished"; }), { deadlineMs: 1000 }), /not actionable/);
  assert.equal(new MetamonBattlePolicy({ command: "never-executed", args: [] }).requiresSupportedMechanics, false);
});

// Matters: an opposing Illusion user in Team Preview leaves every other opposing appearance unresolved for the whole
// game. That only withholds the engine's species-dependent analysis; Metamon reads the same public protocol a human
// does and picks from the request's own legal actions, so a UU team with Zoroark-Hisui must not make its opponent's
// seat unplayable. Policies that consume engine mechanics, and any own-side identity gap, must still fail closed.
test("an opposing Illusion disguise permits only policies that do not consume engine mechanics", async () => {
  const { hashCanonical } = await import("../../../extension/lib/decision-identity.js");
  const room = "battle-gen9uu-illusion", session = "illusion-test";
  const mon = (name: string, details: string, active: boolean, moves: string[]) => ({ ident: `p1: ${name}`, details,
    condition: "300/300", active, stats: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 }, moves, baseAbility: "flashfire",
    item: "leftovers", pokeball: "pokeball", ability: "flashfire", commanding: false, reviving: false, teraType: "Fairy", terastallized: "" });
  const party = (lead: boolean) => [mon("Heatran", "Heatran, M", lead, ["magmastorm", "earthpower"]), mon("Swampert", "Swampert, F", false, ["earthquake", "flipturn"])];
  const decisionFor = async (opponentBench: string) => {
    const engine = new DecisionEngine({ source: "owned_offline_simulator" });
    const frames = [
      `|init|battle\n|gametype|singles\n|player|p1|A||\n|player|p2|B||\n|gen|9\n|tier|[Gen 9] UU\n|clearpoke\n|poke|p1|Heatran, M|\n|poke|p1|Swampert, F|\n|poke|p2|Hydrapple, M|\n|poke|p2|${opponentBench}|\n|teampreview`,
      `|request|${JSON.stringify({ teamPreview: true, side: { name: "A", id: "p1", pokemon: party(false) }, rqid: 1 })}`,
      "|\n|teamsize|p1|2\n|teamsize|p2|2\n|start\n|switch|p1a: Heatran|Heatran, M|300/300\n|switch|p2a: Hydrapple|Hydrapple, M|100/100\n|turn|1",
      `|request|${JSON.stringify({ active: [{ moves: [{ move: "Magma Storm", id: "magmastorm", pp: 8, maxpp: 8, target: "normal", disabled: false },
        { move: "Earth Power", id: "earthpower", pp: 16, maxpp: 16, target: "normal", disabled: false }] }], side: { name: "A", id: "p1", pokemon: party(true) }, rqid: 2 })}`];
    let current: any;
    for (const [index, data] of frames.entries()) current = await engine.ingest({ sessionId: session, roomId: room, source: "protocol",
      observationId: `f${index}`, sequence: index + 1, data: `>${room}\n${data}` });
    return { engine, envelope: await evaluateDecision(engine, session, current.identity!, await captureIntelEvaluationContext()) };
  };
  const choose = async (input: BattlePolicyInput) => ({ requestId: input.requestId, identity: input.envelope.semantic.identity,
    actionId: input.envelope.semantic.snapshot.legalActions.find((action) => !action.disabled)!.id });
  const metamonLike: BattlePolicy = { id: "metamon-like", requiresSupportedMechanics: false, decide: choose };
  const llmLike: BattlePolicy = { id: "llm-like", decide: choose };

  const control = await decisionFor("Swampert, M");
  assert.equal(control.envelope.semantic.capabilities.actionable, true);
  const { engine, envelope } = await decisionFor("Zoroark-Hisui, M");
  assert.equal(envelope.semantic.capabilities.actionable, false);
  assert.ok(envelope.semantic.capabilities.limitations.includes("identity_ambiguous"));
  const decision = await new BattleAgent(engine, session, metamonLike).decide(envelope, { deadlineMs: 1000 });
  assert.ok(envelope.semantic.snapshot.legalActions.some((action) => action.id === decision.actionId && !action.disabled));
  await assert.rejects(new BattleAgent(engine, session, llmLike).decide(envelope, { deadlineMs: 1000 }), /not actionable/);
  // Own-side identity gaps are not hidden information; they stay fail-closed even beside an opposing disguise.
  for (const own of ["request-slot:1", `${room}:p1a:appearance:1`]) {
    const semantic = structuredClone(envelope.semantic) as any;
    semantic.snapshot.canonicalEvidence.ambiguities.push(own);
    await assert.rejects(new BattleAgent(engine, session, metamonLike).decide({ ...envelope, semantic, resultHash: await hashCanonical(semantic) },
      { deadlineMs: 1000 }), /not actionable/, own);
  }
});


test("malformed identity, unknown action and extra fields fail closed", async () => {
  for (const mode of ["identity", "action", "extra"] as const) {
    const { engine, envelope } = await fixture();
    const policy: BattlePolicy = { id: mode, async decide({ requestId }) {
      return { requestId, identity: { ...envelope.semantic.identity, ...(mode === "identity" ? { rqid: 9999 } : {}) },
        actionId: mode === "action" ? "move:999|tera=0" : envelope.semantic.snapshot.legalActions[0]!.id,
        ...(mode === "extra" ? { choice: "arbitrary command" } : {}) };
    } };
    await assert.rejects(new BattleAgent(engine, sessionId, policy).decide(envelope, { deadlineMs: 1000 }));
  }
});

test("an in-flight policy cannot publish request N after N+1 arrives", async () => {
  const { engine, envelope } = await fixture();
  let resolve!: (decision: BattleDecision) => void;
  let started!: () => void;
  const began = new Promise<void>((done) => { started = done; });
  const agent = new BattleAgent(engine, sessionId, { id: "delayed", decide({ requestId }) {
    started(); return new Promise((done) => { resolve = (value) => done({ ...value, requestId }); });
  } });
  const pending = agent.decide(envelope, { deadlineMs: 1000 });
  const rejected = assert.rejects(pending, /no longer current/);
  await began;
  const request = JSON.parse(initial.split("\n").find((line) => line.startsWith("|request|"))!.slice(9));
  await engine.ingest({ roomId, sessionId, observationId: "next", sequence: 2, source: "protocol",
    data: `>${roomId}\n|request|${JSON.stringify({ ...request, rqid: 999 })}` });
  resolve({ requestId: "ignored", identity: envelope.semantic.identity, actionId: envelope.semantic.snapshot.legalActions[0]!.id });
  await rejected;
});

test("policy deadline and cancellation discard late output", async () => {
  const { engine, envelope } = await fixture();
  let calls = 0;
  const policy: BattlePolicy = { id: "slow", async decide(input) {
    calls++; await delay(80);
    return { requestId: input.requestId, identity: input.envelope.semantic.identity, actionId: input.envelope.semantic.snapshot.legalActions[0]!.id };
  } };
  const agent = new BattleAgent(engine, sessionId, policy);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(agent.decide(envelope, { deadlineMs: 1000, signal: controller.signal }));
  assert.equal(calls, 0);
  await assert.rejects(agent.decide(envelope, { deadlineMs: 10 }), /timeout/i);
  await delay(90);
  assert.equal(calls, 1);
});

for (const phase of ["initial", "final"] as const) for (const mode of ["cancel", "deadline"] as const) {
  test(`${mode} bounds the ${phase} engine check without publishing a decision`, async () => {
    const { engine, envelope } = await fixture();
    const held = gate(), release = gate(), waiting = gate();
    let lock: Promise<void> | undefined, calls = 0, checks = 0;
    const hold = () => engine.withCurrent(sessionId, envelope.semantic.identity, async () => {
      held.release(); await release.promise;
    });
    const original = engine.assertCurrent.bind(engine);
    engine.assertCurrent = (...args) => {
      if (++checks === (phase === "initial" ? 1 : 2)) waiting.release();
      return original(...args);
    };
    if (phase === "initial") { lock = hold(); await held.promise; }
    const controller = new AbortController();
    const agent = new BattleAgent(engine, sessionId, { id: "lock", async decide(input) {
      calls++;
      if (phase === "final") { lock = hold(); await held.promise; }
      return { requestId: input.requestId, identity: envelope.semantic.identity, actionId: envelope.semantic.snapshot.legalActions[0]!.id };
    } });
    const rejected = assert.rejects(agent.decide(envelope, {
      deadlineMs: mode === "deadline" ? 40 : 1000, signal: controller.signal
    }), mode === "cancel" ? /caller cancelled/ : /timeout/i);
    try {
      await promptly(waiting.promise);
      if (mode === "cancel") controller.abort(new Error("caller cancelled"));
      await promptly(rejected); // Must settle before the lock is released.
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { release.release(); await lock; }
    await delay(0); // Flush the late engine settlement, including rejection handlers.
    assert.equal(calls, phase === "initial" ? 0 : 1);
  });
}

test("abort listeners are removed even for nonsettling, late-rejecting and synchronously throwing policies", async () => {
  const { engine, envelope } = await fixture();
  for (const mode of ["never", "late-reject", "throw", "success"] as const) {
    const began = gate(), controller = new AbortController();
    let signal!: AbortSignal, rejectLater!: (error: Error) => void;
    const policy: BattlePolicy = { id: mode, decide(input, options) {
      signal = options.signal; began.release();
      if (mode === "throw") throw new Error("synchronous failure");
      if (mode === "success") return new DeterministicBattlePolicy().decide(input);
      return new Promise((_resolve, reject) => { rejectLater = reject; });
    } };
    const pending = new BattleAgent(engine, sessionId, policy).decide(envelope, { deadlineMs: 1000, signal: controller.signal });
    const checked = mode === "success" ? pending : assert.rejects(pending, /cancelled|synchronous failure/);
    await began.promise;
    if (mode === "never" || mode === "late-reject") controller.abort(new Error("cancelled"));
    await checked;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    if (mode === "late-reject") { rejectLater(new Error("late failure")); await delay(0); }
  }
});

test("executor dispatches exactly once per rqid even when public state changes", async () => {
  const { engine, envelope, context } = await fixture();
  const policy = new DeterministicBattlePolicy();
  const first = await new BattleAgent(engine, sessionId, policy).decide(envelope, { deadlineMs: 1000 });
  const sent: string[] = [];
  const executor = new BattleActionExecutor(engine, sessionId, (choice) => { sent.push(choice); return true; });
  executor.authorize(roomId, Date.now() + 10_000);
  const result = await executor.execute(first);
  assert.equal(result.status, "dispatched");
  assert.equal(result.choice, envelope.semantic.snapshot.legalActions.find((action) => action.id === first.actionId)!.choice);
  await assert.rejects(executor.execute(first), /already dispatched/);
  const next = await engine.ingest({ roomId, sessionId, observationId: "public-change", sequence: 2, source: "protocol", data: `>${roomId}\n|-boost|p2a: Dragapult|atk|1` });
  const changed = await evaluateDecision(engine, sessionId, next.identity!, context);
  const second = await new BattleAgent(engine, sessionId, policy).decide(changed, { deadlineMs: 1000 });
  await assert.rejects(executor.execute(second), /already dispatched/);
  assert.equal(sent.length, 1);
});

test("revocation, expiry and cancellation prevent dispatch", async () => {
  const { engine, envelope } = await fixture();
  const decision = await new BattleAgent(engine, sessionId, new DeterministicBattlePolicy()).decide(envelope, { deadlineMs: 1000 });
  let sent = 0;
  const executor = new BattleActionExecutor(engine, sessionId, () => { sent++; return true; });
  executor.authorize(roomId, Date.now() + 10_000); executor.revoke();
  await assert.rejects(executor.execute(decision), /not authorized/);
  executor.authorize(roomId, Date.now() + 10_000);
  await assert.rejects(executor.execute({ ...decision, deadlineAt: Date.now() - 1 }), /deadline expired/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executor.execute(decision, { signal: controller.signal }));
  assert.equal(sent, 0);
});

for (const mode of ["cancel", "deadline"] as const) test(`queued executor ${mode} settles before lock release and never sends later`, async () => {
  const { engine, envelope } = await fixture();
  const decision = await new BattleAgent(engine, sessionId, new DeterministicBattlePolicy()).decide(envelope, { deadlineMs: 1000 });
  const held = gate(), release = gate();
  const lock = engine.withCurrent(sessionId, decision.identity, async () => { held.release(); await release.promise; });
  await held.promise;
  let sends = 0;
  const executor = new BattleActionExecutor(engine, sessionId, () => { sends++; return true; });
  executor.authorize(roomId, Date.now() + 1000);
  const controller = new AbortController();
  if (mode === "deadline") decision.deadlineAt = Date.now() + 40;
  const rejected = assert.rejects(executor.execute(decision, { signal: controller.signal }), /cancelled|timeout/i);
  try {
    await delay(0); // Queue withCurrent before aborting.
    if (mode === "cancel") controller.abort(new Error("cancelled"));
    await promptly(rejected);
  } finally { release.release(); await lock; }
  await delay(0);
  assert.equal(sends, 0);
});

test("concurrent dispatch and a rejected transport never submit the same request twice", async () => {
  const { engine, envelope } = await fixture();
  const decision = await new BattleAgent(engine, sessionId, new DeterministicBattlePolicy()).decide(envelope, { deadlineMs: 1000 });
  let calls = 0;
  const executor = new BattleActionExecutor(engine, sessionId, () => { calls++; return true; });
  executor.authorize(roomId, Date.now() + 1000);
  const results = await Promise.allSettled([executor.execute(decision), executor.execute(decision)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
  const rejected = new BattleActionExecutor(engine, sessionId, () => { calls++; return false; });
  rejected.authorize(roomId, Date.now() + 1000);
  await assert.rejects(rejected.execute(decision), /Transport rejected/);
  await assert.rejects(rejected.execute(decision), /already dispatched/);
  assert.equal(calls, 2);
});

test("unnumbered legacy requests remain advisory-only", async () => {
  const engine = new DecisionEngine();
  const current = await engine.ingest({ roomId, sessionId, observationId: "legacy", sequence: 1, source: "protocol", data: source });
  assert.equal(current.identity!.rqid, null);
  const envelope = await evaluateDecision(engine, sessionId, current.identity!, await captureIntelEvaluationContext());
  const decision = await new BattleAgent(engine, sessionId, new DeterministicBattlePolicy()).decide(envelope, { deadlineMs: 1000 });
  const executor = new BattleActionExecutor(engine, sessionId, () => { throw new Error("must not dispatch"); });
  executor.authorize(roomId, Date.now() + 1000);
  await assert.rejects(executor.execute(decision), /numbered request/);
});

test("OpenCode waits for the exact enabled model and variant in the server generation location", async () => {
  const { envelope } = await fixture();
  const mock = await recoveryMock([{}], [{ data: [] }, { data: readyModels }]);
  const events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, mock.binary, { onAttempt: (event) => { events.push(event); } });
  const result = policy.decide({ requestId: "startup", envelope }, {
    signal: new AbortController().signal, deadlineAt: Date.now() + 3000
  });
  await mock.waitForCatalog(1);
  assert.equal((await mock.calls()).length, 0);
  assert.equal(events.length, 0, "metadata queries are not generation attempts");
  await result;
  assert.equal((await mock.catalogCalls()).length, 2);
  assert.equal((await mock.calls()).length, 1);
  assert.deepEqual(events.map((event) => [event.attempt, event.outcome]), [[1, "accepted"]]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test("OpenCode readiness permits an enabled model without a requested variant regardless of status", async () => {
  const { envelope } = await fixture();
  const model = { providerID: OPENCODE_BATTLE_MODELS.sonnet.providerID, id: OPENCODE_BATTLE_MODELS.sonnet.id };
  const mock = await recoveryMock([{}], [{ data: [{ ...model, enabled: true, variants: [], status: "deprecated" }] }]);
  await new OpenCodeBattlePolicy(model, mock.binary).decide({ requestId: "no-variant", envelope }, {
    signal: new AbortController().signal, deadlineAt: Date.now() + 3000
  });
  assert.equal((await mock.calls()).length, 1);
  assert.equal((await mock.catalogCalls()).length, 1);
});

for (const mismatch of ["provider", "model", "variant", "disabled"] as const) {
  test(`OpenCode never generates while the exact model readiness has a ${mismatch} mismatch`, async () => {
    const { envelope } = await fixture();
    const row = { ...readyModels[0]!, variants: readyModels[0]!.variants,
      ...(mismatch === "provider" ? { providerID: "PRIVATE_OTHER_PROVIDER" } : {}),
      ...(mismatch === "model" ? { id: "PRIVATE_OTHER_MODEL" } : {}),
      ...(mismatch === "variant" ? { variants: [{ id: "PRIVATE_OTHER_VARIANT" }] } : {}),
      ...(mismatch === "disabled" ? { enabled: false } : {}) };
    const mock = await recoveryMock([{}], [{ data: [row, readyModels[1]] }]);
    const controller = new AbortController(), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, mock.binary, { onAttempt: (event) => { events.push(event); } });
    await assert.rejects(policy.decide({ requestId: mismatch, envelope }, {
      signal: controller.signal, deadlineAt: Date.now() + 500
    }), (error: Error) => {
      assert.match(error.message, /readiness|deadline|timeout/i);
      assert.doesNotMatch(String(error.stack), /PRIVATE_/);
      return true;
    });
    assert.ok((await mock.catalogCalls()).length >= 1);
    assert.equal((await mock.calls()).length, 0);
    assert.deepEqual(events, []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("OpenCode readiness rejects malformed catalogs and nonzero metadata without exporting private text", async () => {
  const { envelope } = await fixture();
  const responses = [
    { stdout: "PRIVATE_CATALOG_TEXT" }, { stdout: "x".repeat(1_048_577) },
    { stdout: JSON.stringify({ location: { directory: "PRIVATE_WRONG_LOCATION" }, data: readyModels }) },
    { data: {} }, { data: [null] },
    { data: [{ ...readyModels[0], enabled: "true" }] },
    { data: [{ ...readyModels[0], variants: ["low"] }] },
    { stdout: JSON.stringify({ _tag: "InvalidRequestError", message: "PRIVATE_CATALOG_TEXT" }), exitCode: 1 }
  ];
  for (const response of responses) {
    const mock = await recoveryMock([{}], [response]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, mock.binary, {
      captureRejectedText: true, captureTransportErrors: true, onAttempt: (event) => { events.push(event); }
    });
    await assert.rejects(policy.decide({ requestId: "metadata-private", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 3000
    }), (error: Error) => {
      assert.match(error.message, /OpenCode model readiness failed/);
      assert.doesNotMatch(String(error.stack), /PRIVATE_|http_invalid_request|declaredHttpStatus/);
      assert.equal(error.cause, undefined);
      assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["message", "stack"]);
      return true;
    });
    assert.equal((await mock.catalogCalls()).length, 1, "malformed metadata cannot be polled or retried");
    assert.equal((await mock.calls()).length, 0);
    assert.deepEqual(events, []);
  }
});

test("OpenCode readiness rejects unsupported server versions and unproved config directory discovery", async () => {
  const { envelope } = await fixture();
  for (const [server, config] of [
    [JSON.stringify({ version: "2.0.21", PRIVATE_URL: "PRIVATE_SERVER_URL" }), undefined],
    [JSON.stringify([{ version: "2.0.20" }]), undefined],
    [undefined, "PRIVATE_CONFIG_TEXT"],
    [undefined, JSON.stringify([{ type: "directory", path: 1 }])],
    [undefined, JSON.stringify([{ type: "document", info: "PRIVATE_CONFIG_TEXT" }, { type: "directory", path: mockBaseDirectory }])],
    [undefined, JSON.stringify([{ type: "document", info: { PRIVATE_CONFIG: true } }])],
    [undefined, JSON.stringify([{ type: "PRIVATE_TYPE", path: "PRIVATE_PATH" }])]
  ] as Array<[string | undefined, string | undefined]>) {
    const dir = await fs.mkdtemp(path.join(directory, "locator-")), binary = path.join(dir, "opencode");
    const generated = path.join(dir, "generated"), catalog = path.join(dir, "catalog");
    await fs.writeFile(binary, mockOpenCodeScript(`require('node:fs').writeFileSync(${JSON.stringify(generated)},'1');`,
      `require('node:fs').writeFileSync(${JSON.stringify(catalog)},'1');`,
      config === undefined ? undefined : `process.stdout.write(${JSON.stringify(config)});`,
      server === undefined ? undefined : `process.stdout.write(${JSON.stringify(server)});`), { mode: 0o700 });
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, binary, { onAttempt: (event) => { events.push(event); } });
    await assert.rejects(policy.decide({ requestId: "locator", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 3000
    }), (error: Error) => {
      assert.match(error.message, /OpenCode model readiness failed/);
      assert.doesNotMatch(String(error.stack), /PRIVATE_/);
      return true;
    });
    assert.equal(await fs.stat(generated).then(() => true, () => false), false);
    assert.equal(await fs.stat(catalog).then(() => true, () => false), false);
    assert.deepEqual(events, []);
  }
});

test("OpenCode rechecks live state after pending readiness before any generation", async () => {
  const { engine, envelope } = await fixture();
  const mock = await recoveryMock([{}], [{ data: readyModels, hold: true }]);
  const events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, mock.binary, { onAttempt: (event) => { events.push(event); } });
  const rejected = assert.rejects(new BattleAgent(engine, sessionId, policy).decide(envelope, { deadlineMs: 3000 }), /no longer current/);
  try {
    await mock.waitForCatalog(1);
    await engine.ingest({ roomId, sessionId, observationId: "readiness-stale", sequence: 2, source: "protocol", data: `>${roomId}\n|-boost|p2a: Dragapult|atk|1` });
  } finally { await mock.release(); }
  await rejected;
  assert.equal((await mock.calls()).length, 0);
  assert.deepEqual(events, []);
});

test("OpenCode readiness caps a valid unavailable catalog before a longer decision deadline", async () => {
  const { envelope } = await fixture();
  const mock = await recoveryMock([{}], [{ data: [] }]), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, mock.binary, { onAttempt: (event) => { events.push(event); } });
  const began = Date.now();
  await assert.rejects(policy.decide({ requestId: "readiness-cap", envelope }, {
    signal: new AbortController().signal, deadlineAt: began + 6500
  }), /OpenCode model readiness failed \(timeout\)/);
  assert.ok(Date.now() - began < 6000, "readiness must use its own bounded portion of the original decision deadline");
  assert.ok((await mock.catalogCalls()).length > 1);
  assert.equal((await mock.calls()).length, 0);
  assert.deepEqual(events, []);
});

test("OpenCode cancellation during readiness polling starts no generation or attempt event", async () => {
  const { envelope } = await fixture();
  const mock = await recoveryMock([{}], [{ data: [] }]), controller = new AbortController();
  const events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, mock.binary, { onAttempt: (event) => { events.push(event); } });
  const rejected = assert.rejects(policy.decide({ requestId: "readiness-cancel", envelope }, {
    signal: controller.signal, deadlineAt: Date.now() + 3000
  }), /cancel/i);
  await mock.waitForCatalog(1);
  controller.abort(new Error("cancelled"));
  await promptly(rejected);
  assert.equal((await mock.calls()).length, 0);
  assert.deepEqual(events, []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const mode of ["cancel", "deadline", "leader-exit", "held-pipes"] as const) {
  test(`OpenCode readiness ${mode} tears down metadata descendants without generation or private events`, { skip: process.platform === "win32" }, async () => {
    const { envelope } = await fixture();
    const dir = await fs.mkdtemp(path.join(directory, "metadata-kill-")), binary = path.join(dir, "opencode");
    const leaderFile = path.join(dir, "leader.pid"), childFile = path.join(dir, "child.pid"), generated = path.join(dir, "generated");
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(childFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    await fs.writeFile(binary, mockOpenCodeScript(`require('node:fs').writeFileSync(${JSON.stringify(generated)},'1');`, `
const fs = require('node:fs');
process.on('SIGTERM',()=>{});
fs.writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:${JSON.stringify(mode === "leader-exit" ? "ignore" : ["ignore", "inherit", "inherit"])}}).unref();
let wrote = false;
setInterval(()=>{
  if (wrote || !fs.existsSync(${JSON.stringify(childFile)})) return;
  wrote = true;
  fs.writeSync(1,JSON.stringify({_tag:'InvalidRequestError',message:'PRIVATE_METADATA_RESPONSE'}));
  ${mode === "leader-exit" || mode === "held-pipes" ? "process.exit(1);" : ""}
},5);
`), { mode: 0o700 });
    const controller = new AbortController(), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, binary, {
      captureRejectedText: true, captureTransportErrors: true, onAttempt: (event) => { events.push(event); }
    });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const rejected = assert.rejects(policy.decide({ requestId: mode, envelope }, {
      signal: controller.signal, deadlineAt: Date.now() + (mode === "deadline" || mode === "held-pipes" ? 700 : 3000)
    }), (error: Error) => {
      assert.match(error.message, /OpenCode model readiness failed/);
      assert.doesNotMatch(String(error.stack), /PRIVATE_|http_invalid_request|declaredHttpStatus/);
      return true;
    });
    try {
      const untilReady = Date.now() + 2000;
      while (Date.now() < untilReady && !await fs.stat(childFile).catch(() => false)) await delay(5);
      await fs.stat(childFile);
      if (mode === "cancel") controller.abort(new Error("cancelled"));
      await rejected;
      const pids = await Promise.all([leaderFile, childFile].map(async (file) => Number(await fs.readFile(file, "utf8"))));
      const untilDead = Date.now() + 1000;
      while (Date.now() < untilDead && pids.some(alive)) await delay(10);
      assert.ok(pids.every((pid) => !alive(pid)), "metadata must use the same referenced SIGKILL cleanup as generation");
      assert.equal(await fs.stat(generated).then(() => true, () => false), false);
      assert.deepEqual(events, []);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      for (const file of [leaderFile, childFile]) {
        const pid = await fs.readFile(file, "utf8").then(Number, () => 0);
        if (pid) { try { process.kill(file === leaderFile ? -pid : pid, "SIGKILL"); } catch {} }
      }
      controller.abort(); await rejected;
    }
  });
}

test("OpenCode missing CLI fails readiness with no generation attempt or private path", async () => {
  const { envelope } = await fixture(), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, path.join(directory, "PRIVATE_MISSING_BINARY"), {
    captureRejectedText: true, captureTransportErrors: true, onAttempt: (event) => { events.push(event); }
  });
  await assert.rejects(policy.decide({ requestId: "missing", envelope }, {
    signal: new AbortController().signal, deadlineAt: Date.now() + 1000
  }), (error: Error) => {
    assert.equal(error.message, "OpenCode model readiness failed (spawn; code=ENOENT).");
    assert.doesNotMatch(String(error.stack), /PRIVATE_/);
    return true;
  });
  assert.deepEqual(events, []);
});

test("OpenCode v2 transport uses literal argv and strict JSON instead of an agent session", async () => {
  const { engine, envelope } = await fixture();
  const binary = path.join(directory, "fake-opencode");
  await fs.writeFile(binary, mockOpenCodeScript(`
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2,5),['api','experimental.generate.text','--data']);
assert.equal(process.argv.length,6);
const body = JSON.parse(process.argv[5]);
assert.deepEqual(Object.keys(body).sort(), ['model','prompt']);
assert.equal(body.model.providerID,'anthropic');
assert.equal(body.model.id,'claude-sonnet-5-5');
const input = body.prompt.split('\\n\\n').filter(part => part.startsWith('{')).map(part => JSON.parse(part)).find(part => part.legalActions);
assert(!('requestId' in input));
assert(!('identity' in input));
process.stdout.write(JSON.stringify({data:{text:JSON.stringify({actionId:input.legalActions[0].id,reason:'fixture'})}}));
`), { mode: 0o700 });
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, binary);
  const result = await new BattleAgent(engine, sessionId, policy).decide(envelope, { requestId: "locally-bound", deadlineMs: 2000 });
  assert.equal(result.policyId, "opencode:anthropic/claude-sonnet-5-5#high");
  assert.equal(result.reason, "fixture");
  assert.equal(result.requestId, "locally-bound");
  assert.deepEqual(result.identity, envelope.semantic.identity);
  await fs.writeFile(binary, mockOpenCodeScript("process.stdout.write(JSON.stringify({data:{text:'not JSON'}}));"), { mode: 0o700 });
  await assert.rejects(policy.decide({ requestId: "bad", envelope }, { signal: new AbortController().signal, deadlineAt: Date.now() + 2000 }));
});

test("OpenCode accepts only a minimal action and optional bounded reason, without retries", async () => {
  const { envelope } = await fixture();
  const binary = path.join(directory, "wire-opencode"), calls = path.join(directory, "wire-calls.txt");
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, binary);
  const input = { requestId: "wire-bound", envelope };
  const actionId = envelope.semantic.snapshot.legalActions.find((action) => !action.disabled && action.choice)!.id;
  let count = 0;
  const respond = async (decision: unknown) => {
    count++;
    await fs.writeFile(binary, mockOpenCodeScript(`
require('node:fs').appendFileSync(${JSON.stringify(calls)},'1');
process.stdout.write(${JSON.stringify(JSON.stringify({ data: { text: JSON.stringify(decision) } }))});
`), { mode: 0o700 });
    return policy.decide(input, { signal: new AbortController().signal, deadlineAt: Date.now() + 2000 });
  };
  for (const wire of [{ actionId }, { actionId, reason: "x".repeat(240) }]) {
    const decision = await respond(wire);
    assert.deepEqual(decision, { requestId: input.requestId, identity: envelope.semantic.identity, ...wire });
    assert.notEqual(decision.identity, envelope.semantic.identity);
  }
  const canary = "PRIVATE_SCHEMA_CANARY";
  const invalid: Array<[unknown, string]> = [
    [null, "object.type=null"], [[], "object.type=array"], [canary, "object.type=string"],
    [true, "object.type=boolean"], [1, "object.type=number"], [{}, "actionId.type=undefined"],
    [{ actionId: 1 }, "actionId.type=number"], [{ actionId: null }, "actionId.type=null"],
    [{ actionId: false }, "actionId.type=boolean"], [{ actionId: [canary] }, "actionId.type=array"],
    [{ actionId: { [canary]: canary } }, "actionId.type=object"], [{ actionId: "" }, "actionId.empty"],
    [{ actionId, reason: 1 }, "reason.type=number"], [{ actionId, reason: null }, "reason.type=null"],
    [{ actionId, reason: true }, "reason.type=boolean"], [{ actionId, reason: [canary] }, "reason.type=array"],
    [{ actionId, reason: { [canary]: canary } }, "reason.type=object"],
    [{ actionId, reason: canary.padEnd(241, "x") }, "reason.overlength; length=241; max=240"],
    [{ actionId, reason: "🙂".repeat(121) }, "reason.overlength; length=242; max=240"],
    [{ actionId, requestId: input.requestId }, "extra_fields"],
    [{ actionId, identity: envelope.semantic.identity }, "extra_fields"],
    [{ actionId, requestId: input.requestId, identity: envelope.semantic.identity }, "extra_fields"],
    [{ actionId, requestId: "wrong", identity: { ...envelope.semantic.identity, rqid: 999 } }, "extra_fields"],
    [{ actionId, choice: "move 1" }, "extra_fields"], [{ actionId, [canary]: canary }, "extra_fields"],
    [{ actionId, __proto__: null, constructor: canary, toString: canary }, "extra_fields"],
    [{ actionId: null, reason: canary.padEnd(241, "x"), [canary]: { [canary]: canary } },
      "actionId.type=null, reason.overlength; length=241; max=240, extra_fields"]
  ];
  for (const [wire, category] of invalid) {
    await assert.rejects(respond(wire), (error: Error) => {
      assert.equal(error.message, `OpenCode returned an invalid decision schema (${category}).`);
      assert.doesNotMatch(String(error.stack), /PRIVATE_SCHEMA_CANARY|wire-bound/);
      assert.equal(error.cause, undefined);
      assert.deepEqual(Object.keys(error), [], "validation input and Zod issues must not be attached to the error");
      return true;
    });
  }
  for (const unavailable of ["PRIVATE_UNKNOWN_ACTION", ` ${actionId}`, `${actionId} `, actionId.toUpperCase(),
    envelope.semantic.snapshot.legalActions.find((action) => action.id === actionId)!.choice]) {
    await assert.rejects(respond({ actionId: unavailable }), { message: "OpenCode selected an unavailable action." });
  }
  const action = envelope.semantic.snapshot.legalActions.find((action) => action.id === actionId)!;
  action.disabled = true;
  await assert.rejects(respond({ actionId }), { message: "OpenCode selected an unavailable action." });
  action.disabled = false;
  action.choice = "";
  await assert.rejects(respond({ actionId }), { message: "OpenCode selected an unavailable action." });
  assert.equal(await fs.readFile(calls, "utf8"), "1".repeat(count), "exactly one generation per proposal; no retry or fallback");
});

test("OpenCode recovery requires explicit bounded options, a recorder and a live-state checker", async () => {
  const { envelope } = await fixture();
  const mock = await recoveryMock([{}]);
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2 }), /requires an attempt recorder/);
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { captureRejectedText: true }), /requires an attempt recorder/);
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary,
    { maxAttempts: 3 as 2, onAttempt() {} }), /must be 1 or 2/);
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, onAttempt() {} });
  await assert.rejects(policy.decide({ requestId: "missing-check", envelope }, {
    signal: new AbortController().signal, deadlineAt: Date.now() + 1000
  }), /requires a live-state checker/);
  assert.equal((await mock.calls()).length, 0);
});

for (const failureCode of ["decision_json", "decision_schema", "unavailable_action"] as const) {
  test(`OpenCode explicitly recovers once from ${failureCode} using the pinned prompt`, async () => {
    const { engine, envelope } = await fixture();
    const bad = failureCode === "decision_json" ? "PRIVATE_INVALID_REPLY"
      : JSON.stringify(failureCode === "decision_schema" ? { actionId: 3, PRIVATE_INVALID_REPLY: true } : { actionId: "PRIVATE_INVALID_REPLY" });
    const mock = await recoveryMock([{ text: bad }, {}]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2,
      onAttempt: (event) => { events.push(event); } });
    const checks: unknown[] = [];
    const original = engine.assertCurrent.bind(engine);
    engine.assertCurrent = (session, identity) => { checks.push(structuredClone(identity)); return original(session, identity); };
    let sends = 0;
    const executor = new BattleActionExecutor(engine, sessionId, () => { sends++; return true; });
    executor.authorize(roomId, Date.now() + 5000);
    const result = await new BattleAgent(engine, sessionId, policy).decide(envelope, { requestId: "recover", deadlineMs: 3000 });
    assert.equal(result.policyId, policy.id);
    assert.equal(sends, 0);
    assert.deepEqual(events.map((event) => [event.attempt, event.outcome, event.failureCode]), [[1, "rejected", failureCode], [2, "accepted", null]]);
    for (const event of events) {
      assert.equal(event.requestId, "recover"); assert.equal(event.inputResultHash, envelope.resultHash);
      assert.deepEqual(event.identity, envelope.semantic.identity);
      assert.deepEqual(Object.keys(event).sort(), ["attempt", "attemptKind", "failureCode", "generationModel", "identity", "inputResultHash", "outcome", "requestId"]);
    }
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_INVALID_REPLY|PRIVATE_STDERR_CANARY/);
    assert.equal(checks.length, 5, "initial, before readiness, each generation, and final common freshness check");
    assert.ok(checks.every((identity) => JSON.stringify(identity) === JSON.stringify(envelope.semantic.identity)));
    const calls = await mock.calls();
    assert.equal(calls.length, 2);
    assert.equal((await mock.catalogCalls()).length, 1, "format correction reuses this decide operation's completed readiness");
    assert.equal(calls[0]!.prompt, buildBattlePolicyPrompt({ requestId: "recover", envelope }));
    assert.ok(calls[1]!.prompt.startsWith(`${calls[0]!.prompt}\n\n`));
    assert.match(calls[1]!.prompt.slice(calls[0]!.prompt.length), /exactly one field, "actionId"/);
    assert.doesNotMatch(calls[1]!.prompt, /PRIVATE_INVALID_REPLY/);
    await executor.execute(result);
    assert.equal(sends, 1);
  });
}

test("OpenCode stops after two strict rejections, including disabled, unknown and extra fields", async () => {
  for (const mode of ["json", "extra", "unknown", "disabled", "no-choice"] as const) {
    const { envelope } = await fixture();
    const action = envelope.semantic.snapshot.legalActions.find((entry) => !entry.disabled && entry.choice)!;
    if (mode === "disabled") action.disabled = true;
    if (mode === "no-choice") action.choice = "";
    const text = mode === "json" ? '{}\n{"actionId":"anything"}'
      : JSON.stringify({ actionId: mode === "unknown" ? "not-an-id" : action.id, ...(mode === "extra" ? { choice: "move 1" } : {}) });
    const mock = await recoveryMock([{ text }, { text }, {}]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, onAttempt: (event) => { events.push(event); } });
    await assert.rejects(policy.decide({ requestId: mode, envelope }, {
      deadlineAt: Date.now() + 2000, signal: new AbortController().signal, async assertCurrent() {}
    }), /invalid decision|unavailable action/);
    assert.equal((await mock.calls()).length, 2);
    assert.deepEqual(events.map((event) => [event.attempt, event.outcome]), [[1, "rejected"], [2, "rejected"]]);
  }
});

test("OpenCode captures only explicitly requested bounded rejected text", async () => {
  const { envelope } = await fixture();
  for (const length of [9, 65_536, 65_537]) {
    const text = "x".repeat(length), mock = await recoveryMock([{ text }]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      captureRejectedText: true, onAttempt: (event) => { events.push(event); }
    });
    await assert.rejects(policy.decide({ requestId: "capture", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000
    }), { message: "OpenCode returned invalid decision JSON." });
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.outcome, "rejected");
    if (event.outcome === "rejected") assert.deepEqual(event.rejectedReply, {
      text: text.slice(0, 65_536), originalLength: length, truncated: length > 65_536
    });
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_STDERR_CANARY/);
    assert.equal((await mock.calls()).length, 1, "capture alone does not enable recovery");
  }
});

test("OpenCode transport, HTTP envelopes, exit and spawn failures never get a second generation", async () => {
  const { envelope } = await fixture();
  for (const [reply, code] of [
    [{ stdout: "PRIVATE_TRANSPORT" }, "transport_json"],
    [{ stdout: JSON.stringify({ error: { message: "PRIVATE_HTTP_FAILURE" } }) }, "missing_text"],
    [{ stdout: "PRIVATE_TRANSPORT", exitCode: 1 }, "generation"],
    [null, "generation"]
  ] as const) {
    const mock = await recoveryMock(reply ? [reply, {}] : []);
    if (!reply) await fs.writeFile(mock.binary, mockOpenCodeScript("", `
require('node:fs').unlinkSync(process.argv[1]);
process.stdout.write(JSON.stringify({location:{directory:${JSON.stringify(mockBaseDirectory)}},data:${JSON.stringify(readyModels)}}));
`), { mode: 0o700 });
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, captureRejectedText: true, onAttempt: (event) => { events.push(event); }
    });
    await assert.rejects(policy.decide({ requestId: "transport", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000, async assertCurrent() {}
    }), (error: Error) => { assert.doesNotMatch(String(error.stack), /PRIVATE_/); return true; });
    assert.equal((await mock.calls()).length, reply ? 1 : 0);
    assert.deepEqual(events.map((event) => [event.attempt, event.outcome, event.failureCode]), [[1, "failed", code]]);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|rejectedReply/);
  }
});

for (const [tag, category, declaredHttpStatus] of [
  ["InvalidRequestError", "http_invalid_request", 400],
  ["UnauthorizedError", "http_unauthorized", 401],
  ["ServiceUnavailableError", "http_service_unavailable", 503]
] as const) test(`OpenCode classifies only the fixed ${tag} metadata on a nonzero exit`, async () => {
  const { envelope } = await fixture();
  const stdout = JSON.stringify({ _tag: tag, message: "PRIVATE_MESSAGE", PRIVATE_KEY: { PRIVATE_NESTED: true },
    kind: "PRIVATE_KIND", field: "PRIVATE_FIELD", service: "PRIVATE_SERVICE", status: 999,
    declaredHttpStatus: 999, category: "PRIVATE_CATEGORY", statusText: "PRIVATE_STATUS_TEXT",
    constructor: "PRIVATE_CONSTRUCTOR", toString: "PRIVATE_TO_STRING", ["__proto__"]: { _tag: "PRIVATE_TAG" } });
  for (const captureTransportErrors of [false, true]) {
    const mock = await recoveryMock([{ stdout, exitCode: 1 }, {}]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, captureRejectedText: true, ...(captureTransportErrors ? { captureTransportErrors } : {}),
      onAttempt: (event) => { events.push(event); }
    });
    await assert.rejects(policy.decide({ requestId: "http-error", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000, async assertCurrent() {}
    }), (error: Error) => {
      assert.equal(error.message, `OpenCode generation failed (exit; code=1; signal=null; category=${category}; declaredHttpStatus=${declaredHttpStatus}).`);
      assert.doesNotMatch(String(error.stack), /PRIVATE_|999/);
      assert.equal(error.cause, undefined);
      assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["message", "stack"]);
      return true;
    });
    assert.deepEqual(events, [{ requestId: "http-error", identity: envelope.semantic.identity,
      inputResultHash: envelope.resultHash, generationModel: OPENCODE_BATTLE_MODELS.luna, attemptKind: "initial", attempt: 1, outcome: "failed", failureCode: "generation",
      transportError: { category, declaredHttpStatus },
      ...(captureTransportErrors ? { transportReply: { text: stdout, originalLength: stdout.length, truncated: false } } : {}) }]);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_STDERR_CANARY|rejectedReply/);
    if (!captureTransportErrors) assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
    assert.equal((await mock.calls()).length, 1, "a transport failure never consumes the formatting retry");
  }
});

test("OpenCode unknown or malformed exit bodies stay generic, including nested and forged tags", async () => {
  const { envelope } = await fixture();
  const actionId = envelope.semantic.snapshot.legalActions.find((action) => !action.disabled && action.choice)!.id;
  const responses = ["PRIVATE_MALFORMED", '{"_tag":"InvalidRequestError",', "null", "7", '"InvalidRequestError"',
    JSON.stringify([{ _tag: "InvalidRequestError" }]), JSON.stringify({ error: { _tag: "InvalidRequestError" } }),
    ...["PRIVATE_UNKNOWN_TAG", "invalidrequesterror", "InvalidRequestError ", "constructor", "__proto__", "toString", null, 400,
      { _tag: "InvalidRequestError" }].map((_tag) => JSON.stringify({ _tag, PRIVATE_KEY: "PRIVATE_MESSAGE" })),
    JSON.stringify({ ["__proto__"]: { _tag: "InvalidRequestError" }, message: "PRIVATE_MESSAGE" }),
    JSON.stringify({ data: { text: JSON.stringify({ actionId }) } })];
  for (const stdout of responses) {
    const mock = await recoveryMock([{ stdout, exitCode: 7 }, {}]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, onAttempt: (event) => { events.push(event); }
    });
    await assert.rejects(policy.decide({ requestId: "unknown", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000, async assertCurrent() {}
    }), { message: "OpenCode generation failed (exit; code=7; signal=null)." });
    assert.deepEqual(events, [{ requestId: "unknown", identity: envelope.semantic.identity,
      inputResultHash: envelope.resultHash, generationModel: OPENCODE_BATTLE_MODELS.luna, attemptKind: "initial", attempt: 1, outcome: "failed", failureCode: "generation" }]);
    assert.equal((await mock.calls()).length, 1);
  }
});

test("OpenCode transport capture requires a recorder and explicitly bounds stdout in JS characters", async () => {
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", { captureTransportErrors: true }),
    { message: "OpenCode transport-error capture requires an attempt recorder." });
  assert.doesNotThrow(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", { captureTransportErrors: false }));
  const { envelope } = await fixture();
  for (const stdout of ["", "PRIVATE_UNKNOWN", "x".repeat(65_536), "x".repeat(65_537),
    JSON.stringify({ _tag: "InvalidRequestError", message: "🙂".repeat(33_000) })]) {
    const mock = await recoveryMock([{ stdout, exitCode: 1 }]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      captureTransportErrors: true, captureRejectedText: true, onAttempt: (event) => { events.push(event); }
    });
    await assert.rejects(policy.decide({ requestId: "capture-exit", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000
    }), /generation failed \(exit; code=1; signal=null/);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.outcome, "failed");
    if (event.outcome !== "failed") throw new Error("Expected failed attempt");
    assert.deepEqual(event.transportReply, stdout ? {
      text: stdout.slice(0, 65_536), originalLength: stdout.length, truncated: stdout.length > 65_536
    } : undefined);
    assert.equal("rejectedReply" in event, false);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_STDERR_CANARY/);
    assert.equal((await mock.calls()).length, 1, "transport capture alone does not enable recovery");
  }
});

test("OpenCode transport capture never adds service metadata or raw stdout to zero-exit events", async () => {
  const { envelope } = await fixture();
  for (const [reply, outcome, failureCode] of [
    [{}, "accepted", null],
    [{ text: "PRIVATE_REJECTED_TEXT" }, "rejected", "decision_json"],
    [{ stdout: JSON.stringify({ _tag: "InvalidRequestError", message: "PRIVATE_MESSAGE" }) }, "failed", "missing_text"],
    [{ stdout: "PRIVATE_MALFORMED" }, "failed", "transport_json"]
  ] as const) {
    const mock = await recoveryMock([reply]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      captureTransportErrors: true, onAttempt: (event) => { events.push(event); }
    });
    const pending = policy.decide({ requestId: "zero-exit", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000
    });
    if (outcome === "accepted") await pending;
    else await assert.rejects(pending, (error: Error) => { assert.doesNotMatch(String(error.stack), /PRIVATE_/); return true; });
    assert.deepEqual(events, [{ requestId: "zero-exit", identity: envelope.semantic.identity,
      inputResultHash: envelope.resultHash, generationModel: OPENCODE_BATTLE_MODELS.luna, attemptKind: "initial", attempt: 1, outcome, failureCode }]);
    assert.equal((await mock.calls()).length, 1);
  }
});

for (const mode of ["cancel", "deadline", "stdout-overflow", "stderr-overflow", "signal", "spawn"] as const) {
  test(`OpenCode ${mode} cannot capture or classify a partial service response`, { skip: mode === "signal" && process.platform === "win32" }, async () => {
    const { envelope } = await fixture();
    const dir = await fs.mkdtemp(path.join(directory, "transport-guard-"));
    const binary = path.join(dir, "opencode"), ready = path.join(dir, "ready"), calls = path.join(dir, "calls");
    if (mode !== "spawn") await fs.writeFile(binary, mockOpenCodeScript(`
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)},'1');
fs.writeSync(1,JSON.stringify({_tag:'InvalidRequestError',message:'PRIVATE_PARTIAL_RESPONSE'}));
fs.writeFileSync(${JSON.stringify(ready)},'ready');
${mode.endsWith("overflow") ? `process.${mode === "stdout-overflow" ? "stdout" : "stderr"}.write(' '.repeat(1_048_577)); process.exitCode=1;`
  : mode === "signal" ? "process.kill(process.pid,'SIGTERM');" : "setInterval(()=>{},1000);"}
`), { mode: 0o700 });
    else await fs.writeFile(binary, mockOpenCodeScript("", `
require('node:fs').unlinkSync(process.argv[1]);
process.stdout.write(JSON.stringify({location:{directory:${JSON.stringify(mockBaseDirectory)}},data:${JSON.stringify(readyModels)}}));
`), { mode: 0o700 });
    const controller = new AbortController(), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, binary, {
      maxAttempts: 2, captureTransportErrors: true, captureRejectedText: true,
      onAttempt: (event) => { events.push(event); }
    });
    const rejected = assert.rejects(policy.decide({ requestId: mode, envelope }, {
      signal: controller.signal, deadlineAt: Date.now() + (mode === "deadline" ? 500 : 3000), async assertCurrent() {}
    }), (error: Error) => {
      assert.doesNotMatch(String(error.stack), /PRIVATE_|http_invalid_request|declaredHttpStatus/);
      assert.match(error.message, mode === "cancel" ? /cancel/ : mode === "deadline" ? /deadline|timeout/i
        : mode.endsWith("overflow") ? /MAXBUFFER/ : mode === "signal" ? /signal=SIGTERM/ : /spawn; code=ENOENT/);
      assert.equal(error.cause, undefined);
      assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["message", "stack"]);
      return true;
    });
    if (mode === "cancel") {
      const until = Date.now() + 2000;
      while (Date.now() < until && !await fs.stat(ready).catch(() => false)) await delay(5);
      assert.ok(await fs.stat(ready));
      controller.abort(new Error("cancelled"));
    }
    await rejected;
    assert.deepEqual(events, [{ requestId: mode, identity: envelope.semantic.identity,
      inputResultHash: envelope.resultHash, generationModel: OPENCODE_BATTLE_MODELS.luna, attemptKind: "initial", attempt: 1, outcome: "failed",
      failureCode: mode === "cancel" ? "cancelled" : mode === "deadline" ? "deadline" : "generation" }]);
    assert.equal(await fs.readFile(calls, "utf8").catch(() => ""), mode === "spawn" ? "" : "1");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("OpenCode transport recorder failures cannot expose captured stdout or retry generation", async () => {
  const { envelope } = await fixture();
  for (const asyncThrow of [false, true]) {
    const mock = await recoveryMock([{ stdout: JSON.stringify({ _tag: "InvalidRequestError", message: "PRIVATE_CAPTURED" }), exitCode: 1 }, {}]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, captureTransportErrors: true, onAttempt(event) {
        events.push(event);
        const failure = new Error(JSON.stringify(event));
        if (asyncThrow) return Promise.reject(failure);
        throw failure;
      }
    });
    await assert.rejects(policy.decide({ requestId: "recorder-exit", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000, async assertCurrent() {}
    }), (error: Error) => {
      assert.equal(error.message, "OpenCode attempt recorder failed.");
      assert.doesNotMatch(String(error.stack), /PRIVATE_/);
      assert.equal(error.cause, undefined);
      assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["message", "stack"]);
      return true;
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.outcome, "failed");
    assert.match(JSON.stringify(events), /PRIVATE_CAPTURED/);
    assert.equal((await mock.calls()).length, 1);
  }
});

for (const mode of ["cancel", "deadline"] as const) test(`OpenCode ${mode} bounds a transport recorder with captured stdout`, async () => {
  const { envelope } = await fixture();
  const mock = await recoveryMock([{ stdout: JSON.stringify({ _tag: "ServiceUnavailableError", message: "PRIVATE_CAPTURED" }), exitCode: 1 }, {}]);
  const entered = gate(), release = gate(), controller = new AbortController(), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
    maxAttempts: 2, captureTransportErrors: true, async onAttempt(event) {
      events.push(event); entered.release(); await release.promise; throw new Error("PRIVATE_LATE_RECORDER_FAILURE");
    }
  });
  const rejected = assert.rejects(policy.decide({ requestId: "recording-exit", envelope }, {
    signal: controller.signal, deadlineAt: Date.now() + (mode === "deadline" ? 500 : 3000), async assertCurrent() {}
  }), (error: Error) => { assert.match(error.message, /cancel|deadline|timeout/i); assert.doesNotMatch(String(error.stack), /PRIVATE_/); return true; });
  try {
    await entered.promise;
    if (mode === "cancel") controller.abort(new Error("cancelled"));
    await rejected;
  } finally { release.release(); }
  await delay(0);
  assert.equal(events.length, 1);
  assert.equal((await mock.calls()).length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const heldPipes of [false, true]) test(`OpenCode tears down descendants after the leader exits with ${heldPipes ? "held" : "closed"} pipes`, { skip: process.platform === "win32" }, async () => {
  const { envelope } = await fixture();
  const dir = await fs.mkdtemp(path.join(directory, "leader-exit-"));
  const binary = path.join(dir, "opencode"), leaderFile = path.join(dir, "leader.pid"), childFile = path.join(dir, "child.pid");
  const descendant = `const fs = require('node:fs');
process.on('SIGTERM',()=>{});
fs.writeFileSync(${JSON.stringify(childFile)},String(process.pid));
setInterval(()=>{},1000);`;
  await fs.writeFile(binary, mockOpenCodeScript(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:${JSON.stringify(heldPipes ? ["ignore", "inherit", "inherit"] : "ignore")}}).unref();
const timer = setInterval(()=>{
  if (!fs.existsSync(${JSON.stringify(childFile)})) return;
  clearInterval(timer);
  fs.writeSync(1,JSON.stringify({_tag:'InvalidRequestError',message:'PRIVATE_LEADER_EXIT'}));
  process.exit(1);
},5);
`), { mode: 0o700 });
  const events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, binary, {
    maxAttempts: 2, captureTransportErrors: true, onAttempt: (event) => { events.push(event); }
  });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await assert.rejects(policy.decide({ requestId: "leader-exit", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + (heldPipes ? 500 : 2000), async assertCurrent() {}
    }), heldPipes ? /timeout|deadline/i : /category=http_invalid_request; declaredHttpStatus=400/);
    const pids = await Promise.all([leaderFile, childFile].map(async (file) => Number(await fs.readFile(file, "utf8"))));
    const untilDead = Date.now() + 1000;
    while (Date.now() < untilDead && pids.some(alive)) await delay(10);
    assert.ok(pids.every((pid) => !alive(pid)), "the referenced SIGKILL grace must survive the leader's exit");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.outcome, "failed");
    assert.equal(events[0]!.failureCode, heldPipes ? "deadline" : "generation");
    if (heldPipes) assert.doesNotMatch(JSON.stringify(events), /transportError|transportReply|PRIVATE_/);
    else assert.match(JSON.stringify(events), /transportReply.*PRIVATE_LEADER_EXIT/);
  } finally {
    for (const file of [leaderFile, childFile]) {
      const pid = await fs.readFile(file, "utf8").then(Number, () => 0);
      if (pid) { try { process.kill(file === leaderFile ? -pid : pid, "SIGKILL"); } catch {} }
    }
  }
});

for (const mode of ["cancel", "deadline"] as const) test(`OpenCode ${mode} during generation records failure and never retries`, async () => {
  const { envelope } = await fixture();
  const mock = await recoveryMock([{ hold: true }, {}]), controller = new AbortController();
  const events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
    maxAttempts: 2, onAttempt: (event) => { events.push(event); }
  });
  const rejected = assert.rejects(policy.decide({ requestId: mode, envelope }, {
    // Include readiness/process startup so this case reaches the held generation
    // under suite contention; shorter pre-generation expiry has separate tests.
    signal: controller.signal, deadlineAt: Date.now() + 2000, async assertCurrent() {}
  }), /cancel|deadline|timeout/i);
  await mock.waitFor(1);
  if (mode === "cancel") controller.abort(new Error("cancelled"));
  await rejected;
  assert.equal((await mock.calls()).length, 1);
  assert.deepEqual(events.map((event) => [event.outcome, event.failureCode]), [["failed", mode === "cancel" ? "cancelled" : "deadline"]]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("OpenCode recorder failures are sanitized and never recover or return an accepted reply", async () => {
  const { envelope } = await fixture();
  for (const accepted of [false, true]) for (const asyncThrow of [false, true]) {
    const mock = await recoveryMock([accepted ? {} : { text: "PRIVATE_REJECTED_TEXT" }, {}]);
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, captureRejectedText: true, onAttempt() {
        const error = new Error("/PRIVATE_PATH/PRIVATE_CONTENT");
        if (asyncThrow) return Promise.reject(error);
        throw error;
      }
    });
    await assert.rejects(policy.decide({ requestId: "recorder", envelope }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 2000, async assertCurrent() {}
    }), (error: Error) => {
      assert.equal(error.message, "OpenCode attempt recorder failed.");
      assert.doesNotMatch(String(error.stack), /PRIVATE_/);
      assert.equal(error.cause, undefined); assert.deepEqual(Object.keys(error), []); return true;
    });
    assert.equal((await mock.calls()).length, 1);
  }
});

for (const mode of ["cancel", "deadline"] as const) test(`OpenCode ${mode} bounds a pending recorder without starting recovery`, async () => {
  const { envelope } = await fixture();
  const mock = await recoveryMock([{ text: "invalid" }, {}]), entered = gate(), release = gate();
  const controller = new AbortController();
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, async onAttempt() {
    entered.release(); await release.promise; throw new Error("PRIVATE_LATE_RECORDER_FAILURE");
  } });
  const deadlineAt = Date.now() + (mode === "deadline" ? 2000 : 3000);
  const rejected = assert.rejects(policy.decide({ requestId: "recording", envelope }, {
    signal: controller.signal, deadlineAt, async assertCurrent() {}
  }), (error: Error) => { assert.match(error.message, /cancel|deadline|timeout/i); assert.doesNotMatch(String(error.stack), /PRIVATE_/); return true; });
  try {
    await Promise.race([entered.promise, rejected.then(() => assert.fail("recorder must be entered before cancellation/deadline"))]);
    if (mode === "cancel") controller.abort(new Error("cancelled"));
    else await delay(Math.max(0, deadlineAt - Date.now() - 50));
    await promptly(rejected);
  } finally { release.release(); }
  await delay(0);
  assert.equal((await mock.calls()).length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("OpenCode pins bindings, legal actions, model and prompt before any await or callback mutation", async () => {
  const { envelope } = await fixture();
  const originalEnvelope = structuredClone(envelope);
  const mock = await recoveryMock([{ text: "invalid" }, {}]);
  const input = { requestId: "original", envelope }, model = { ...OPENCODE_BATTLE_MODELS.luna };
  const events: OpenCodeAttemptEvent[] = [];
  const options: OpenCodeBattlePolicyOptions = { maxAttempts: 2, onAttempt(event) {
    events.push(structuredClone(event)); event.identity.rqid = 777; event.requestId = "callback-mutated";
  } };
  const policy = new OpenCodeBattlePolicy(model, mock.binary, options);
  let checks = 0;
  const result = await policy.decide(input, { signal: new AbortController().signal, deadlineAt: Date.now() + 3000, async assertCurrent() {
    checks++;
    input.requestId = "mutated"; envelope.semantic.identity.rqid = 999;
    envelope.resultHash = "mutated"; envelope.semantic.snapshot.legalActions = [];
    model.id = "mutated-model"; options.maxAttempts = 1; options.onAttempt = () => { throw new Error("wrong recorder"); };
  } });
  assert.equal(checks, 3, "before readiness and before each generation");
  assert.equal(result.requestId, "original"); assert.deepEqual(result.identity, originalEnvelope.semantic.identity);
  assert.ok(originalEnvelope.semantic.snapshot.legalActions.some((action) => action.id === result.actionId));
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.requestId, "original"); assert.deepEqual(event.identity, originalEnvelope.semantic.identity);
    assert.equal(event.inputResultHash, originalEnvelope.resultHash);
  }
  const calls = await mock.calls();
  assert.deepEqual(calls[0]!.model, OPENCODE_BATTLE_MODELS.luna); assert.deepEqual(calls[1]!.model, calls[0]!.model);
  assert.equal(calls[0]!.prompt, buildBattlePolicyPrompt({ requestId: "original", envelope: originalEnvelope }));
  assert.ok(calls[1]!.prompt.startsWith(`${calls[0]!.prompt}\n\n`));
});

for (const mode of ["immediate", "callback"] as const) test(`battle-agent captures its caller envelope before ${mode} mutation`, async () => {
  const { engine, envelope } = await fixture();
  const captured = structuredClone(envelope), mock = await recoveryMock([{}]);
  const mutate = () => {
    envelope.resultHash = "sha256:mutated";
    envelope.semantic.identity.rqid = 999;
    envelope.semantic.snapshot.legalActions = [];
  };
  const events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { onAttempt(event) {
    events.push(structuredClone(event));
    if (mode === "callback") mutate();
  } });
  const pending = new BattleAgent(engine, sessionId, policy).decide(envelope, { requestId: "captured", deadlineMs: 3000 });
  if (mode === "immediate") mutate();
  const decision = await pending;
  assert.equal(decision.inputResultHash, captured.resultHash);
  assert.deepEqual(decision.identity, captured.semantic.identity);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.inputResultHash, decision.inputResultHash);
  assert.deepEqual(events[0]!.identity, decision.identity);
  assert.equal((await mock.calls())[0]!.prompt, buildBattlePolicyPrompt({ requestId: "captured", envelope: captured }));
  let sends = 0;
  const executor = new BattleActionExecutor(engine, sessionId, () => { sends++; return true; });
  executor.authorize(roomId, Date.now() + 5000);
  await executor.execute(decision);
  assert.equal(sends, 1);
});

test("a state change after rejection prevents the second process and all execution", async () => {
  const { engine, envelope } = await fixture();
  const mock = await recoveryMock([{ text: "invalid" }, {}]), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, async onAttempt(event) {
    events.push(event);
    await engine.ingest({ roomId, sessionId, observationId: "changed", sequence: 2, source: "protocol", data: `>${roomId}\n|-boost|p2a: Dragapult|atk|1` });
  } });
  let sends = 0;
  const executor = new BattleActionExecutor(engine, sessionId, () => { sends++; return true; });
  executor.authorize(roomId, Date.now() + 5000);
  await assert.rejects(new BattleAgent(engine, sessionId, policy).decide(envelope, { deadlineMs: 3000 }).then((decision) => executor.execute(decision)), /no longer current/);
  assert.equal((await mock.calls()).length, 1); assert.equal(events.length, 1); assert.equal(sends, 0);
});

for (const mode of ["cancel", "deadline"] as const) test(`shared ${mode} bounds the retry engine lock and prevents later generation`, async () => {
  const { engine, envelope } = await fixture();
  const mock = await recoveryMock([{ text: "invalid" }, {}]);
  const release = gate(), held = gate(), waiting = gate(), controller = new AbortController();
  let lock: Promise<void> | undefined, checks = 0;
  const original = engine.assertCurrent.bind(engine);
  engine.assertCurrent = (...args) => { if (++checks === 4) waiting.release(); return original(...args); };
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, async onAttempt() {
    lock = engine.withCurrent(sessionId, envelope.semantic.identity, async () => { held.release(); await release.promise; });
    await held.promise;
  } });
  let sends = 0;
  const executor = new BattleActionExecutor(engine, sessionId, () => { sends++; return true; });
  executor.authorize(roomId, Date.now() + 5000);
  // Metadata startup is part of this same decision deadline. Give setup time
  // to reach the retry lock, and observe terminal completion if it wins first.
  const deadlineMs = 3000, deadlineAt = Date.now() + deadlineMs;
  const rejected = assert.rejects(new BattleAgent(engine, sessionId, policy).decide(envelope, {
    deadlineMs, signal: controller.signal
  }).then((decision) => executor.execute(decision)), /cancel|timeout/i);
  let timer!: ReturnType<typeof setTimeout>;
  const bounded = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Decision did not settle within the original test deadline.")),
      Math.max(1, deadlineAt - Date.now()) + 250);
  });
  try {
    const phase = await Promise.race([waiting.promise.then(() => "waiting"), rejected.then(() => "terminal"), bounded]);
    assert.equal(phase, "waiting", "decision ended before the retry lock was reached");
    if (mode === "cancel") {
      controller.abort(new Error("cancelled"));
      await promptly(rejected);
    } else await Promise.race([rejected, bounded]);
  } finally { clearTimeout(timer); controller.abort(); release.release(); await lock; }
  await delay(10);
  assert.equal((await mock.calls()).length, 1);
  assert.equal(sends, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("a recovered second generation arriving after a newer request cannot publish or execute", async () => {
  const { engine, envelope, context } = await fixture();
  const mock = await recoveryMock([{ text: "invalid" }, { hold: true }, {}]), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, onAttempt: (event) => { events.push(event); } });
  const agent = new BattleAgent(engine, sessionId, policy), sends: number[] = [];
  const executor = new BattleActionExecutor(engine, sessionId, (_choice, identity) => { sends.push(identity.rqid!); return true; });
  executor.authorize(roomId, Date.now() + 5000);
  const rejected = assert.rejects(agent.decide(envelope, { requestId: "older", deadlineMs: 5000 }).then((decision) => executor.execute(decision)), /no longer current/);
  try {
    await mock.waitFor(2);
    const request = JSON.parse(initial.split("\n").find((line) => line.startsWith("|request|"))!.slice(9));
    const next = await engine.ingest({ roomId, sessionId, observationId: "new-request", sequence: 2, source: "protocol",
      data: `>${roomId}\n|request|${JSON.stringify({ ...request, rqid: 48 })}` });
    const newerEnvelope = await evaluateDecision(engine, sessionId, next.identity!, context);
    const decision = await agent.decide(newerEnvelope, { requestId: "newer", deadlineMs: 2000 });
    await executor.execute(decision);
    await mock.release(); await rejected;
    assert.deepEqual(sends, [48]);
    assert.deepEqual(events.map((event) => [event.requestId, event.identity.rqid, event.inputResultHash, event.attempt, event.outcome]), [
      ["older", 47, envelope.resultHash, 1, "rejected"], ["newer", 48, newerEnvelope.resultHash, 1, "accepted"],
      ["older", 47, envelope.resultHash, 2, "accepted"]
    ]);
  } finally { await mock.release(); await rejected; }
});

test("out-of-order OpenCode calls keep their own bindings; stale results cannot publish or dispatch", async () => {
  const { engine, envelope, context } = await fixture();
  const dir = await fs.mkdtemp(path.join(directory, "interleave-"));
  const binary = path.join(dir, "opencode"), firstReady = path.join(dir, "first.ready"), release = path.join(dir, "release");
  await fs.writeFile(binary, mockOpenCodeScript(`
const fs = require('node:fs');
const body = JSON.parse(process.argv[5]);
const data = body.prompt.split('\\n\\n').filter(p=>p.startsWith('{')).map(p=>JSON.parse(p)).find(p=>p.battle);
const reply = () => process.stdout.write(JSON.stringify({data:{text:JSON.stringify({actionId:data.legalActions[0].id})}}));
if (!fs.existsSync(${JSON.stringify(firstReady)})) {
  fs.writeFileSync(${JSON.stringify(firstReady)},'ready');
  const timer = setInterval(()=>{
    if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); reply(); }
  },10);
} else reply();
`), { mode: 0o700 });
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, binary);
  const original = policy.decide.bind(policy);
  const replies = new Map<string, BattleDecision>();
  policy.decide = async (input, options) => {
    const decision = await original(input, options);
    replies.set(input.requestId, decision);
    return decision;
  };
  const agent = new BattleAgent(engine, sessionId, policy);
  const sent: number[] = [];
  const executor = new BattleActionExecutor(engine, sessionId, (_choice, identity) => { sent.push(identity.rqid!); return true; });
  executor.authorize(roomId, Date.now() + 5000);
  // An already-published decision must also become undispatchable at N+1.
  const oldPublished = await new BattleAgent(engine, sessionId, new DeterministicBattlePolicy()).decide(envelope, { deadlineMs: 5000 });
  let published = false;
  const older = agent.decide(envelope, { requestId: "older", deadlineMs: 5000 }).then(async (decision) => {
    published = true;
    await executor.execute(decision);
    return decision;
  });
  const rejected = assert.rejects(older, /no longer current/);
  try {
    const until = Date.now() + 2000;
    while (Date.now() < until && !await fs.stat(firstReady).then(() => true, () => false)) await delay(10);
    await fs.stat(firstReady);
    const request = JSON.parse(initial.split("\n").find((line) => line.startsWith("|request|"))!.slice(9));
    const next = await engine.ingest({ roomId, sessionId, observationId: "opencode-next", sequence: 2, source: "protocol",
      data: `>${roomId}\n|request|${JSON.stringify({ ...request, rqid: 48 })}` });
    const newerEnvelope = await evaluateDecision(engine, sessionId, next.identity!, context);
    const newer = await agent.decide(newerEnvelope, { requestId: "newer", deadlineMs: 2000 });
    assert.equal(newer.requestId, "newer");
    assert.deepEqual(newer.identity, newerEnvelope.semantic.identity);
    await assert.rejects(executor.execute(oldPublished), /no longer current/);
    await executor.execute(newer);
    await fs.writeFile(release, "go");
    await rejected;
    assert.equal(published, false);
    assert.equal(replies.get("older")!.requestId, "older");
    assert.deepEqual(replies.get("older")!.identity, envelope.semantic.identity);
    // Even a directly captured late adapter proposal cannot bypass the executor.
    await assert.rejects(executor.execute({ ...oldPublished, ...replies.get("older")! }), /no longer current/);
    assert.deepEqual(sent, [48]);
  } finally {
    await fs.writeFile(release, "go");
    await rejected;
  }
});

test("OpenCode exit diagnostics contain only numeric status, caught signal and fixed spawn codes", async () => {
  const { envelope } = await fixture();
  const binary = path.join(directory, "exit-opencode");
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, binary);
  const cases = [
    { script: "process.exit(7);", message: "OpenCode generation failed (exit; code=7; signal=null)." },
    ...(process.platform === "win32" ? [] : [{ script: "process.kill(process.pid,'SIGTERM');", message: "OpenCode generation failed (exit; code=null; signal=SIGTERM)." }])
  ];
  for (const { script, message } of cases) {
    await fs.writeFile(binary, mockOpenCodeScript(`
const secret = 'PRIVATE_EXIT_PAYLOAD Authorization: Bearer SECRET_HEADER '+process.argv[5];
process.stderr.write(secret);
process.stdout.write(secret);
${script}
`), { mode: 0o700 });
    const signal = new AbortController().signal;
    await assert.rejects(policy.decide({ requestId: "private-request", envelope }, { signal, deadlineAt: Date.now() + 2000 }),
      (error: Error) => {
        assert.equal(error.message, message);
        assert.doesNotMatch(String(error.stack), /PRIVATE_EXIT_PAYLOAD|Authorization|SECRET_HEADER|private-request|CHOOSE_AN_ENABLED_ACTION_ID/);
        assert.equal(error.cause, undefined);
        return true;
      });
    assert.equal(getEventListeners(signal, "abort").length, 0);
  }
});

test("OpenCode rejects oversized output and bounds a hung CLI locally", async () => {
  const { envelope } = await fixture();
  const binary = path.join(directory, "bounded-opencode");
  const input = { requestId: "bounded", envelope };
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, binary);
  for (const stream of ["stdout", "stderr"]) {
    await fs.writeFile(binary, mockOpenCodeScript(`process.${stream}.write('x'.repeat(1100000));`), { mode: 0o700 });
    const signal = new AbortController().signal;
    await assert.rejects(policy.decide(input, { signal, deadlineAt: Date.now() + 2000 }), /MAXBUFFER/);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  }
  const beganGeneration = path.join(directory, "bounded-generation-started");
  await fs.writeFile(binary, mockOpenCodeScript(`require('node:fs').writeFileSync(${JSON.stringify(beganGeneration)},'1');setInterval(()=>{},1000);`), { mode: 0o700 });
  const began = Date.now();
  await assert.rejects(policy.decide(input, { signal: new AbortController().signal, deadlineAt: Date.now() + 500 }), /generation failed/);
  await fs.stat(beganGeneration); // The bound must cover a hung generation, after metadata readiness.
  assert.ok(Date.now() - began < 1000);
});

test("advisory CLI keeps both model aliases and the strict template; error logs never echo private data", async () => {
  const dir = await fs.mkdtemp(path.join(directory, "privacy-"));
  const input = path.join(dir, "input.txt"), history = path.join(dir, "history.json"), curated = path.join(dir, "curated.json");
  await fs.writeFile(input, initial.replaceAll("p1: Gholdengo", "p1: AUDIT_PRIVATE_BENCH_CANARY"));
  const sentinel = '{"PRIVATE_HISTORY_CANARY":"unchanged"}\n';
  await fs.writeFile(history, sentinel); await fs.writeFile(curated, sentinel);
  await fs.writeFile(path.join(dir, "opencode"), mockOpenCodeScript(`
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2,5),['api','experimental.generate.text','--data']);
assert.equal(process.argv.length,6);
const body = JSON.parse(process.argv[5]);
assert.deepEqual(Object.keys(body).sort(),['model','prompt']);
assert.equal(body.model.id,process.env.MOCK_MODEL==='sonnet'?'claude-sonnet-5-5':'gpt-6-luna');
assert.equal(body.model.providerID,process.env.MOCK_MODEL==='sonnet'?'anthropic':'openai');
assert.equal(body.model.variant,process.env.MOCK_MODEL==='sonnet'?'high':'xhigh');
assert(!body.prompt.includes('PRIVATE_HISTORY_CANARY'));
assert(body.prompt.includes('AUDIT_PRIVATE_BENCH_CANARY'));
const parts = body.prompt.split('\\n\\n');
const data = parts.filter(p=>p.startsWith('{')).map(p=>JSON.parse(p)).find(p=>p.battle);
const template = JSON.parse(parts.at(-1));
assert.equal(template.actionId,'CHOOSE_AN_ENABLED_ACTION_ID');
assert.deepEqual(Object.keys(template),['actionId']);
assert(body.prompt.includes('Do not include reason, analysis, markdown or Showdown commands.'));
assert(!('requestId' in data));
assert(!('identity' in data));
const decision = {actionId:data.legalActions[0].id,reason:'mock only'};
const secret = 'Q9SECRET AUDIT_PRIVATE_BENCH_CANARY';
switch(process.env.MOCK_MODE){
case 'stderr': process.stderr.write(secret+body.prompt); process.exit(1);
case 'transport': process.stdout.write(secret); process.exit(0);
case 'prose': process.stdout.write(JSON.stringify({data:{text:secret}})); process.exit(0);
case 'missing': process.stdout.write(JSON.stringify({data:{secret}})); process.exit(0);
case 'schema': decision[secret]=body.prompt; break;
case 'nested-schema': decision.identity={[secret]:body.prompt}; break;
case 'reason-type': decision.reason={[secret]:body.prompt}; break;
case 'reason-overlength': decision.reason=secret.padEnd(241,'x'); break;
case 'action-type': decision.actionId={[secret]:body.prompt}; break;
}
process.stdout.write(JSON.stringify({data:{text:JSON.stringify(decision)}}));
`), { mode: 0o700 });
  const execute = promisify(execFile);
  const command = new URL("../tools/battle-agent-decide.ts", import.meta.url).pathname;
  const failures = { stderr: "OpenCode generation failed (exit; code=1; signal=null).", transport: "OpenCode returned invalid transport JSON.",
    prose: "OpenCode returned invalid decision JSON.", missing: "OpenCode did not return a text generation.",
    schema: "OpenCode returned an invalid decision schema (extra_fields).", "nested-schema": "OpenCode returned an invalid decision schema (extra_fields).",
    "reason-type": "OpenCode returned an invalid decision schema (reason.type=object).",
    "reason-overlength": "OpenCode returned an invalid decision schema (reason.overlength; length=241; max=240).",
    "action-type": "OpenCode returned an invalid decision schema (actionId.type=object)." };
  for (const [model, mode] of [["sonnet", "valid"], ["luna", "valid"], ...Object.keys(failures).map((mode) => ["luna", mode])] as Array<["sonnet" | "luna", string]>) {
    const pending = execute(process.execPath, ["--import", "tsx", command, "--input", input, "--model", model, "--deadline-ms", "2000"], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, MOCK_MODEL: model, MOCK_MODE: mode,
        LOCAL_INTEL_STORE_PATH: history, EXTERNAL_CURATED_STORE_PATH: curated }, timeout: 5000, killSignal: "SIGKILL"
    });
    if (mode === "valid") {
      const { stdout } = await pending;
      const result = JSON.parse(stdout);
      assert.equal(result.mode, "advisory");
      assert.equal(result.decision.policyId, `opencode:${OPENCODE_BATTLE_MODELS[model].providerID}/${OPENCODE_BATTLE_MODELS[model].id}#${OPENCODE_BATTLE_MODELS[model].variant}${model === "luna" ? `|overload=${OPENCODE_BATTLE_MODELS.sonnet.providerID}/${OPENCODE_BATTLE_MODELS.sonnet.id}#${OPENCODE_BATTLE_MODELS.sonnet.variant}` : ""}`);
      assert.equal(result.decision.reason, "mock only");
    } else await assert.rejects(pending, (error: any) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.ok(error.stderr.includes(failures[mode as keyof typeof failures]));
      assert.doesNotMatch(error.stderr, /Q9SECRET|AUDIT_PRIVATE_BENCH_CANARY|PRIVATE_HISTORY_CANARY|CHOOSE_AN_ENABLED_ACTION_ID/);
      return true;
    });
  }
  assert.equal(await fs.readFile(history, "utf8"), sentinel);
  assert.equal(await fs.readFile(curated, "utf8"), sentinel);
  const { envelope } = await fixture();
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, path.join(dir, "Q9SECRET-missing"));
  await assert.rejects(policy.decide({ requestId: "missing", envelope }, {
    deadlineAt: Date.now() + 1000, signal: new AbortController().signal
  }), { message: "OpenCode model readiness failed (spawn; code=ENOENT)." });
});

for (const cli of ["advisory", "simulator"] as const) for (const mode of ["SIGINT", "SIGTERM", "deadline"] as const) test(`${cli} CLI ${mode} kills a SIGTERM-ignoring mock and its child`, { skip: process.platform === "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(directory, "kill-"));
  const leaderFile = path.join(dir, "leader.pid"), childFile = path.join(dir, "child.pid"), termFile = path.join(dir, "term.txt");
  const output = path.join(dir, cli === "advisory" ? "result.json" : "artifacts");
  const listenerFile = path.join(dir, "listeners.json"), preload = path.join(dir, "listeners.mjs");
  await fs.writeFile(preload, `import fs from 'node:fs';
const events = ['SIGINT','SIGTERM','beforeExit'];
const before = events.map(event => process.listenerCount(event));
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(listenerFile)},JSON.stringify({before,after:events.map(event=>process.listenerCount(event))})));
`);
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(childFile)},String(process.pid));
process.on('SIGTERM',()=>require('node:fs').appendFileSync(${JSON.stringify(termFile)},'child\\n'));setInterval(()=>{},1000);`;
  await fs.writeFile(path.join(dir, "opencode"), mockOpenCodeScript(`
process.stderr.write('SIGNAL_PRIVATE_PAYLOAD'+process.argv.at(-1));
process.on('SIGTERM',()=>require('node:fs').appendFileSync(${JSON.stringify(termFile)},'leader\\n'));
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});
require('node:fs').writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));
setInterval(()=>{},1000);
`), { mode: 0o700 });
  const command = new URL(cli === "advisory" ? "../tools/battle-agent-decide.ts" : "../tools/battle-agent-sim.ts", import.meta.url).pathname;
  const input = new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url).pathname;
  const team = path.join(dir, "team.txt");
  await fs.writeFile(team, "Scizor @ Choice Band\nAbility: Technician\nTera Type: Fire\nEVs: 252 Atk / 4 SpD / 252 Spe\nAdamant Nature\n- Bullet Punch\n- Close Combat\n");
  const args = cli === "advisory" ? ["--input", input, "--deadline-ms", mode === "deadline" ? "600" : "10000"]
    : ["--p1", "sonnet", "--team", team, "--decision-ms", "10000", "--timeout-ms", mode === "deadline" ? "600" : "12000"];
  const pending = promisify(execFile)(process.execPath, ["--no-deprecation", "--import", "tsx", "--import", preload, command, ...args, "--output", output], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 5000, killSignal: "SIGKILL"
  });
  const result = pending.then(() => { throw new Error("Hung mock published a decision."); }, (error) => error);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let pids: number[] = [];
  try {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      try { pids = await Promise.all([leaderFile, childFile].map(async (file) => Number(await fs.readFile(file, "utf8")))); break; }
      catch { await delay(10); }
    }
    assert.equal(pids.length, 2, "mock and descendant must be ready before cancellation");
    assert.ok(pids.every(alive));
    const began = Date.now();
    if (mode !== "deadline") {
      pending.child.kill(mode);
      // Reproduce the advisory CLI's former handler-removal window: after
      // SIGTERM reaches the group, interrupt again before the SIGKILL grace.
      const termDeadline = Date.now() + 1000;
      while (Date.now() < termDeadline) {
        const term = await fs.readFile(termFile, "utf8").catch(() => "");
        if (term.includes("leader") && term.includes("child")) break;
        await delay(5);
      }
      assert.equal(pending.child.exitCode, null, "runner must stay alive through process cleanup");
      assert.equal(pending.child.signalCode, null);
      assert.equal(pending.child.kill(mode === "SIGINT" ? "SIGTERM" : "SIGINT"), true);
    }
    const error = await result;
    assert.equal(error.code, mode === "SIGINT" ? 130 : mode === "SIGTERM" ? 143 : cli === "simulator" ? 2 : 1);
    assert.equal(error.signal, null);
    assert.doesNotMatch(error.stderr + error.stdout, /SIGNAL_PRIVATE_PAYLOAD|CHOOSE_AN_ENABLED_ACTION_ID/);
    if (cli === "simulator" || mode !== "deadline") {
      const artifact = JSON.parse(await fs.readFile(cli === "advisory" ? output : path.join(output, "summary.json"), "utf8"));
      assert.deepEqual(JSON.parse(error.stdout), artifact);
      assert.equal(artifact.cancellationSignal, mode === "deadline" ? null : mode);
      if (cli === "advisory") {
        assert.equal(artifact.status, "cancelled"); assert.equal(artifact.decision, null); assert.equal(artifact.choice, null);
      } else {
        assert.equal(artifact.status, "truncated"); assert.equal(artifact.stopReason, mode === "deadline" ? "deadline" : "cancelled");
        assert.equal(artifact.outcome, null); assert.equal(artifact.winner, null);
        assert.deepEqual(artifact.fallbacks, []);
        if (mode !== "deadline") assert.deepEqual(artifact.errors, []);
        assert.equal((await fs.readFile(artifact.paths.trajectory, "utf8")).trim(), "");
        const producer = JSON.parse(await fs.readFile(artifact.paths.producer, "utf8"));
        const { hashCanonical } = await import("../../../extension/lib/decision-identity.js");
        // Matters: a re-ranked (B1) game's own producer record must cover the guard and re-rank code that chose its actions.
        assert.deepEqual(producer.sources.map(([name]: [string, string]) => name), ["simulator", "nativeSimulator", "battleAgent", "opencode", "decisionCard", "strategicLedger", "metamon", "tacticalGuards", "rerank", "metamon-worker.py"]);
        assert.equal(await hashCanonical(producer.sources), artifact.versions.producer);
        assert.equal(producer.hash, artifact.versions.producer);
      }
      if (cli === "simulator") assert.deepEqual(JSON.parse(error.stderr), {
        event: "model_reply", model: "sonnet", configuredModel: "sonnet", generationModel: OPENCODE_BATTLE_MODELS.sonnet, attemptKind: "initial", requestId: "p1-1-attempt-1", attempt: 1, outcome: "failed",
        failureCode: mode === "deadline" ? "deadline" : "cancelled"
      });
      else {
        const event = JSON.parse(error.stderr);
        assert.equal(event.event, "model_reply"); assert.equal(event.model, "luna");
        assert.deepEqual(event.generationModel, OPENCODE_BATTLE_MODELS.luna);
        assert.equal(event.failureCode, "cancelled");
      }
    } else {
      // Either the common timer or the adapter's deadline check may settle first.
      assert.match(error.stderr, /timeout|deadline/i); assert.equal(error.stdout, "");
    }
    const listeners = JSON.parse(await fs.readFile(listenerFile, "utf8"));
    assert.deepEqual(listeners.after, listeners.before, "CLI must remove its signal and beforeExit listeners");
    const untilDead = began + 1500;
    while (Date.now() < untilDead && pids.some(alive)) await delay(10);
    assert.ok(Date.now() - began < 1500, "CLI must exit within the bounded cleanup grace");
    assert.ok(pids.every((pid) => !alive(pid)), "no local mock process may survive cancellation");
    const term = await fs.readFile(termFile, "utf8");
    assert.match(term, /leader/); assert.match(term, /child/);
  } finally {
    // Keep failed regressions from leaving fixtures alive, including when only
    // one PID became ready. The production runner owns this group, never a shell.
    for (const file of [leaderFile, childFile]) {
      const pid = await fs.readFile(file, "utf8").then(Number, () => 0);
      if (pid) { try { process.kill(file === leaderFile && process.platform !== "win32" ? -pid : pid, "SIGKILL"); } catch {} }
    }
    if (pending.child.exitCode === null) pending.child.kill("SIGKILL");
    await result;
  }
});

test("six-mon preview preserves every ordered action with bounded prompt size", async () => {
  const { engine, context } = await fixture();
  const pokemon = ["Fezandipiti", "Donphan", "Arcanine-Hisui", "Slowking", "Thundurus", "Scizor"].map((species) => ({ ident: `p1: ${species}`, details: species, active: false, condition: "300/300", moves: ["tackle"] }));
  const next = await engine.ingest({ roomId, sessionId, observationId: "preview", sequence: 2, source: "protocol", data: `>${roomId}\n|init|battle\n|tier|[Gen 9] UU\n|request|${JSON.stringify({ rqid: 1, teamPreview: true, side: { id: "p1", pokemon } })}` });
  const envelope = await evaluateDecision(engine, sessionId, next.identity!, context);
  assert.equal(envelope.semantic.snapshot.legalActions.length, 720);
  const prompt = buildBattlePolicyPrompt({ requestId: "preview", envelope });
  const body = prompt.split("\n\n").filter((part) => part.startsWith("{")).map((part) => JSON.parse(part)).find((part) => part.legalActions);
  assert.equal(body.legalActions.length, 720);
  assert.equal(body.engineAnalysis.rankedActions.length, 6);
  assert.ok(Buffer.byteLength(prompt) < 32_000);
});


test("battle policy temporal context retains a canonical pending attack after the caster switches", async () => {
  const engine = new DecisionEngine();
  await engine.ingest({ roomId, sessionId, observationId: "temporal-initial", sequence: 1, source: "protocol",
    data: initial.replaceAll("Dragapult", "Slowking") });
  const request = JSON.parse(initial.match(/^\|request\|(.*)$/m)![1]!);
  const next = await engine.ingest({ roomId, sessionId, observationId: "temporal-pivot", sequence: 2, source: "protocol",
    data: `>${roomId}\n|move|p2a: Slowking|Future Sight|p1a: Great Tusk\n|-start|p2a: Slowking|move: Future Sight\n|switch|p2a: Scizor|Scizor, L100|100/100\n|turn|15\n|request|${JSON.stringify({ ...request, rqid: 48 })}` });
  const envelope = await evaluateDecision(engine, sessionId, next.identity!, await captureIntelEvaluationContext());
  const snapshot = envelope.semantic.snapshot;
  assert.equal(snapshot.opponentSide.active?.species, "Scizor");
  assert.ok(!snapshot.opponentSide.active?.knownMoves?.includes("Future Sight"));
  assert.ok(!snapshot.legalActions.some((action) => action.moveName === "Future Sight"));
  assert.equal(snapshot.pendingAttacks?.length, 1, "canonical scheduler independently retains the attack");
  assert.equal(snapshot.pendingAttacks![0]!.moveName, "Future Sight");
  assert.equal(snapshot.pendingAttacks![0]!.dueTurn, 16);
  const before = structuredClone(envelope);
  const prompt = buildBattlePolicyPrompt({ requestId: "temporal-pivot", envelope });
  const body = prompt.split("\n\n").filter((part) => part.startsWith("{")).map((part) => JSON.parse(part)).find((part) => part.battle);
  assert.deepEqual(body.battle.pendingAttacks, snapshot.pendingAttacks);
  assert.deepEqual(body.battle.recentLog, snapshot.recentLog);
  assert.match(prompt, /Current canonical state and enabled legal actions take precedence/);
  assert.deepEqual(envelope, before, "prompt projection must not alter the evaluated input");
});

test("battle policy temporal context preserves the canonical recent-event bound and chronology", async () => {
  const { engine, context } = await fixture();
  const request = JSON.parse(initial.match(/^\|request\|(.*)$/m)![1]!);
  const next = await engine.ingest({ roomId, sessionId, observationId: "temporal-log", sequence: 2, source: "protocol",
    data: `>${roomId}\n${Array.from({ length: 30 }, (_, i) => `|turn|${i + 15}`).join("\n")}\n|request|${JSON.stringify({ ...request, rqid: 48 })}` });
  const envelope = await evaluateDecision(engine, sessionId, next.identity!, context);
  const snapshot = envelope.semantic.snapshot;
  assert.equal(snapshot.recentLog.length, 20, "reuse the parser's existing bound, without another history buffer");
  assert.deepEqual(snapshot.recentLog, Array.from({ length: 20 }, (_, i) => `Turn ${i + 25} started.`));
  snapshot.notes = ["PRIVATE_CONTEXT_CANARY"];
  Object.assign(envelope, { privateContext: "PRIVATE_CONTEXT_CANARY" });
  const prompt = buildBattlePolicyPrompt({ requestId: "temporal-log", envelope });
  const body = prompt.split("\n\n").filter((part) => part.startsWith("{")).map((part) => JSON.parse(part)).find((part) => part.battle);
  assert.deepEqual(body.battle.recentLog, snapshot.recentLog);
  assert.doesNotMatch(prompt, /PRIVATE_CONTEXT_CANARY/);
  assert.equal("notes" in body.battle, false);
  assert.equal("canonicalEvidence" in body.battle, false);
});

test("battle policy temporal context omits absent empty or null pending attacks without inventing history", async () => {
  const { envelope } = await fixture();
  for (const pendingAttacks of [undefined, [], null]) {
    // Null is a defensive projection control, not an accepted canonical schema value.
    Object.assign(envelope.semantic.snapshot, { pendingAttacks, recentLog: [] });
    const prompt = buildBattlePolicyPrompt({ requestId: "temporal-empty", envelope });
    const body = prompt.split("\n\n").filter((part) => part.startsWith("{")).map((part) => JSON.parse(part)).find((part) => part.battle);
    assert.equal("pendingAttacks" in body.battle, false);
    assert.deepEqual(body.battle.recentLog, []);
  }
});

test("battle policy shared effort defaults are Luna xhigh and Sonnet high", () => {
  assert.deepEqual(OPENCODE_BATTLE_MODELS, {
    sonnet: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" },
    luna: { providerID: "openai", id: "gpt-6-luna", variant: "xhigh" }
  });
});


const declaredOverload = JSON.stringify({ _tag: "ServiceUnavailableError", service: "openai",
  message: "  server_is_overloaded: Our servers are currently overloaded. Please try again later." });

for (const sequence of ["hop", "hop-correct", "correct-hop"] as const) test(`declared overload route ${sequence} shares one correction and exact models`, async () => {
  const { engine, envelope } = await fixture();
  const replies = sequence === "hop" ? [{ stdout: declaredOverload, exitCode: 1 }, {}]
    : sequence === "hop-correct" ? [{ stdout: declaredOverload, exitCode: 1 }, { text: "not JSON" }, {}]
    : [{ text: "not JSON" }, { stdout: declaredOverload, exitCode: 1 }, {}];
  const mock = await recoveryMock(replies), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
    maxAttempts: 2, overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt(event) { events.push(event); }
  });
  const id = policy.id;
  const decision = await new BattleAgent(engine, sessionId, policy).decide(envelope, { requestId: sequence, deadlineMs: 4000 });
  const calls = await mock.calls();
  assert.equal(calls.length, sequence === "hop" ? 2 : 3);
  assert.deepEqual(events.map((e) => e.attempt), calls.map((_, i) => i + 1));
  assert.deepEqual(events.map((e) => e.attemptKind), sequence === "hop" ? ["initial", "capacity_fallback"]
    : sequence === "hop-correct" ? ["initial", "capacity_fallback", "format_correction"] : ["initial", "format_correction", "capacity_fallback"]);
  assert.deepEqual(calls.map((c) => c.model), sequence === "correct-hop"
    ? [OPENCODE_BATTLE_MODELS.luna, OPENCODE_BATTLE_MODELS.luna, OPENCODE_BATTLE_MODELS.sonnet]
    : [OPENCODE_BATTLE_MODELS.luna, ...calls.slice(1).map(() => OPENCODE_BATTLE_MODELS.sonnet)]);
  for (const [i, e] of events.entries()) {
    assert.deepEqual(e.generationModel, calls[i]!.model);
    assert.deepEqual(e.identity, envelope.semantic.identity); assert.equal(e.inputResultHash, envelope.resultHash);
    assert.equal(e.requestId, sequence);
  }
  const failure = events.find((e) => e.outcome === "failed")!;
  assert.equal(failure.outcome === "failed" && failure.transportError?.category === "http_service_unavailable" && failure.transportError.declaredCode, "server_is_overloaded");
  assert.equal((await mock.catalogCalls()).length, 2, "both models are checked, same deadline");
  assert.equal(decision.policyId, id); assert.equal(policy.id, id); assert.match(id, /\|overload=anthropic/);
  assert.doesNotMatch(JSON.stringify(events), /Our servers|PRIVATE_/);
});

test("declared overload route requires recorder and live checker even for one structural attempt", async () => {
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", { overloadFallback: OPENCODE_BATTLE_MODELS.sonnet }), /recorder/);
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", { overloadFallback: { ...OPENCODE_BATTLE_MODELS.luna, variant: "other" }, onAttempt() {} }), /different model/);
  const { envelope } = await fixture(), mock = await recoveryMock([{}]);
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt() {} });
  await assert.rejects(policy.decide({ requestId: "no-checker", envelope }, { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 }), /live-state checker/);
  assert.equal((await mock.catalogCalls()).length, 0); assert.equal((await mock.calls()).length, 0);
});

test("declared overload route excludes unknown statuses providers wrappers and non-prefix text", async () => {
  const { envelope } = await fixture();
  const cases = [
    { stdout: JSON.stringify({ _tag: "ServiceUnavailableError", service: "openai", message: "server unavailable" }), exitCode: 1 },
    { stdout: JSON.stringify({ _tag: "ServiceUnavailableError", service: "anthropic", message: "server_is_overloaded: no" }), exitCode: 1 },
    { stdout: JSON.stringify({ _tag: "ServiceUnavailableError", service: "openai", message: "prefix server_is_overloaded:" }), exitCode: 1 },
    ...["UnauthorizedError", "InvalidRequestError", "TooManyRequestsError"].map((_tag) => ({ stdout: JSON.stringify({ _tag, service: "openai", message: "server_is_overloaded:" }), exitCode: 1 })),
    { stdout: declaredOverload, exitCode: 0 }, { stdout: "not JSON", exitCode: 1 },
    { stdout: JSON.stringify({ data: { _tag: "ServiceUnavailableError", service: "openai", message: "server_is_overloaded:" } }), exitCode: 1 },
    { text: "not JSON" }, { text: JSON.stringify({ actionId: "unavailable" }) }
  ];
  for (const response of cases) {
    const mock = await recoveryMock([response, {}]), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 1, overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt(e) { events.push(e); }
    });
    await assert.rejects(policy.decide({ requestId: "excluded", envelope }, { signal: new AbortController().signal, deadlineAt: Date.now() + 2000, async assertCurrent() {} }));
    assert.equal((await mock.calls()).length, 1); assert.equal(events.length, 1); assert.equal(events[0]!.attemptKind, "initial");
  }
  const mock = await recoveryMock([{ stdout: declaredOverload, exitCode: 1 }, {}]);
  const other = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, mock.binary, { overloadFallback: OPENCODE_BATTLE_MODELS.luna, onAttempt() {} });
  await assert.rejects(other.decide({ requestId: "other-primary", envelope }, { signal: new AbortController().signal, deadlineAt: Date.now() + 2000, async assertCurrent() {} }));
  assert.equal((await mock.calls()).length, 1);
});

test("declared overload route never resets shared correction or hops back", async () => {
  const { envelope } = await fixture();
  for (const [maxAttempts, replies, expected] of [
    [1, [{ stdout: declaredOverload, exitCode: 1 }, { text: "invalid" }, {}], 2],
    [2, [{ text: "invalid" }, { stdout: declaredOverload, exitCode: 1 }, { text: "invalid" }, {}], 3],
    [2, [{ stdout: declaredOverload, exitCode: 1 }, { stdout: declaredOverload, exitCode: 1 }, {}], 2]
  ] as const) {
    const mock = await recoveryMock([...replies]), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts, overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt(e) { events.push(e); } });
    await assert.rejects(policy.decide({ requestId: "ceiling", envelope }, { signal: new AbortController().signal, deadlineAt: Date.now() + 3000, async assertCurrent() {} }));
    assert.equal((await mock.calls()).length, expected); assert.equal(events.filter((e) => e.attemptKind === "capacity_fallback").length, 1);
  }
});

test("declared overload route captures models binary prompt bindings before recorder mutation", async () => {
  const { envelope } = await fixture(), before = structuredClone(envelope);
  const mock = await recoveryMock([{ stdout: declaredOverload, exitCode: 1 }, {}]);
  const fallback = { ...OPENCODE_BATTLE_MODELS.sonnet }, input = { requestId: "immutable", envelope };
  const events: OpenCodeAttemptEvent[] = [];
  const options: OpenCodeBattlePolicyOptions = { overloadFallback: fallback, onAttempt(e) {
    events.push(structuredClone(e)); e.generationModel.id = "PRIVATE_MUTATION"; e.identity.rqid = 0;
    fallback.id = "PRIVATE_MUTATION"; input.requestId = "changed"; envelope.resultHash = "changed";
    envelope.semantic.snapshot.legalActions = []; options.overloadFallback = OPENCODE_BATTLE_MODELS.luna;
    Object.assign(policy, { binary: "PRIVATE_WRONG_BINARY" });
  } };
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, options), id = policy.id;
  const result = await policy.decide(input, { signal: new AbortController().signal, deadlineAt: Date.now() + 3000, async assertCurrent() {} });
  assert.equal(result.requestId, "immutable"); assert.deepEqual(result.identity, before.semantic.identity);
  assert.deepEqual((await mock.calls()).map((c) => c.model), [OPENCODE_BATTLE_MODELS.luna, OPENCODE_BATTLE_MODELS.sonnet]);
  assert.equal((await mock.calls())[0]!.prompt, (await mock.calls())[1]!.prompt);
  assert.equal(events[1]!.inputResultHash, before.resultHash); assert.equal(policy.id, id);
});

for (const stop of ["recorder", "stale", "cancel", "deadline", "readiness"] as const) test(`declared overload route ${stop} prevents fallback generation`, async () => {
  const { envelope } = await fixture(), controller = new AbortController(); let failed = false;
  const mock = await recoveryMock([{ stdout: declaredOverload, exitCode: 1 }, {}], stop === "readiness"
    ? [{ data: readyModels }, { data: readyModels.filter((m) => m.id !== OPENCODE_BATTLE_MODELS.sonnet.id) }] : undefined);
  const events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt(e) {
    events.push(e); failed = true;
    if (stop === "recorder") throw new Error("PRIVATE_RECORDER");
    if (stop === "cancel") controller.abort();
    if (stop === "deadline") return delay(500);
  } });
  await assert.rejects(policy.decide({ requestId: stop, envelope }, { signal: controller.signal, deadlineAt: Date.now() + (stop === "deadline" || stop === "readiness" ? 350 : 2000), async assertCurrent() {
    if (failed && stop === "stale") throw new Error("no longer current");
  } }));
  await delay(20); assert.equal((await mock.calls()).length, 1); assert.equal(events.length, 1);
});

test("declared overload advisory CLI defaults to Sonnet hop and retains safe actual-model metadata", async () => {
  const dir = await fs.mkdtemp(path.join(directory, "overload-cli-")), input = path.join(dir, "input.txt");
  await fs.writeFile(input, initial);
  const calls = path.join(dir, "calls");
  await fs.writeFile(path.join(dir, "opencode"), mockOpenCodeScript(`
const fs=require('node:fs'); const body=JSON.parse(process.argv[5]);
fs.appendFileSync(${JSON.stringify(calls)},body.model.id+'\\n');
if(body.model.providerID==='openai'){process.stdout.write(${JSON.stringify(declaredOverload)});process.exitCode=1;}
else { const data=body.prompt.split('\\n\\n').filter(p=>p.startsWith('{')).map(p=>JSON.parse(p)).find(p=>p.battle);
process.stdout.write(JSON.stringify({data:{text:JSON.stringify({actionId:data.legalActions.find(a=>a.choice&&!a.disabled).id})}}));}
`), { mode: 0o700 });
  const command = new URL("../tools/battle-agent-decide.ts", import.meta.url).pathname;
  const execute = promisify(execFile);
  const result = await execute(process.execPath, ["--import", "tsx", command, "--input", input, "--model", "luna"], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 5000 });
  const data = JSON.parse(result.stdout), progress = JSON.parse(result.stderr);
  assert.deepEqual(data.modelReplies.map((e: any) => [e.model, e.configuredModel, e.attemptKind]), [["luna", "luna", "initial"], ["sonnet", "luna", "capacity_fallback"]]);
  assert.deepEqual(data.modelReplies[1].generationModel, OPENCODE_BATTLE_MODELS.sonnet);
  assert.match(data.decision.policyId, /\|overload=anthropic/);
  assert.equal(progress.model, "luna"); assert.equal(progress.failureCode, "generation");
  assert.doesNotMatch(result.stdout + result.stderr, /Our servers|server_is_overloaded:|PRIVATE_/);
  for (const cli of ["battle-agent-decide.ts", "battle-agent-sim.ts"]) {
    const file = new URL(`../tools/${cli}`, import.meta.url).pathname;
    await assert.rejects(execute(process.execPath, ["--import", "tsx", file, ...(cli.includes("decide") ? ["--model", "sonnet"] : ["--p1", "sonnet"]), "--fallback", "sonnet"], { timeout: 3000 }), /requires.*[Ll]una/);
  }
  assert.equal((await fs.readFile(calls, "utf8")).trim().split("\n").length, 2, "invalid CLI routes never invoke a provider");
});


test("declared overload simulator CLI journals actual aliases and separates capacity hops from corrections without native execution", async () => {
  const ts = await import("typescript"), vm = await import("node:vm"), { EventEmitter } = await import("node:events");
  const cli = new URL("../tools/battle-agent-sim.ts", import.meta.url);
  const source = (await fs.readFile(cli, "utf8")).replaceAll("import.meta.url", JSON.stringify(cli.href))
    .replace("main().catch((error)", "globalThis.finished = main().catch((error)");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  for (const route of [undefined, "none", "deterministic", "reset"] as const) {
    const output = await fs.mkdtemp(path.join(directory, "sim-journal-"));
    let stdout = "", stderr = "", called = 0;
    const localProcess = Object.assign(new EventEmitter(), { platform: process.platform, exitCode: 0,
      stdout: { write(text: string) { stdout += text; } }, stderr: { write(text: string) { stderr += text; } } });
    class Policy { constructor(readonly model: unknown, readonly binary: string, readonly options: OpenCodeBattlePolicyOptions) {} }
    const args = ["--p1", "deterministic", "--p2", "luna", "--output", output, "--progress", ...(route ? ["--fallback", route === "reset" ? "none" : route] : []), ...(route === "reset" ? ["--retry-connection-reset"] : [])];
    const simulated = async (options: any) => {
      called++; assert.equal(options.fallback, route === "deterministic" ? "deterministic" : "none");
      const adapter = options.p2 as Policy;
      assert.equal(adapter.options.retryConnectionReset, route === "reset");
      assert.deepEqual(adapter.options.overloadFallback, route === undefined ? OPENCODE_BATTLE_MODELS.sonnet : undefined);
      const base = { requestId: "journal", identity: (await fixture()).envelope.semantic.identity, inputResultHash: "hash" };
      const events = route === undefined ? [
        { ...base, attempt: 1, attemptKind: "initial", generationModel: OPENCODE_BATTLE_MODELS.luna, outcome: "failed", failureCode: "generation" },
        { ...base, attempt: 2, attemptKind: "capacity_fallback", generationModel: OPENCODE_BATTLE_MODELS.sonnet, outcome: "rejected", failureCode: "decision_json" },
        { ...base, attempt: 3, attemptKind: "format_correction", generationModel: OPENCODE_BATTLE_MODELS.sonnet, outcome: "accepted", failureCode: null }
      ] : route === "reset" ? [
        { ...base, attempt: 1, attemptKind: "initial", generationModel: OPENCODE_BATTLE_MODELS.luna, outcome: "failed", failureCode: "generation",
          transportError: { category: "http_service_unavailable", declaredHttpStatus: 503, declaredCode: "connection_reset" } },
        { ...base, attempt: 2, attemptKind: "transport_reset", generationModel: OPENCODE_BATTLE_MODELS.luna, outcome: "accepted", failureCode: null }
      ] : [{ ...base, attempt: 1, attemptKind: "initial", generationModel: OPENCODE_BATTLE_MODELS.luna, outcome: "accepted", failureCode: null }];
      for (const event of events) await adapter.options.onAttempt!(event as OpenCodeAttemptEvent);
      return { trajectory: [], replay: "", replayInputs: {}, producerSources: [], status: "completed", versions: { producer: "mock" } };
    };
    const modules: Record<string, unknown> = {
      "../history/metaPriorStore.js": {}, "node:fs/promises": fs, "node:os": os, "node:path": path,
      "node:util": { parseArgs(options: any) { return requireUtil.parseArgs({ ...options, args }); } }, "node:url": await import("node:url"),
      "../battle-agent/battleAgent.js": { DeterministicBattlePolicy: class {} },
      "../battle-agent/opencode.js": { BATTLE_PROMPT_VARIANTS, CLAUDE_CODE_SONNET, GROK_46, OpenCodeBattlePolicy: Policy, OPENCODE_BATTLE_MODELS },
      "../battle-agent/decisionCard.js": { HEURISTIC_PRESENTATIONS },
      "../battle-agent/metamon.js": {}, "../battle-agent/simulator.js": { runBattleMatch: simulated }
    };
    const requireUtil = await import("node:util");
    const context = vm.createContext({ exports: {}, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
      process: localProcess, AbortController, setTimeout, clearTimeout, console, URL });
    vm.runInContext(code, context); await context.finished;
    assert.equal(called, 1); assert.equal(localProcess.exitCode, 0);
    const summary = JSON.parse(stdout), journal = (await fs.readFile(summary.paths.modelReplies, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(summary.modelReplies.connectionResetRecoveryEnabled, route === "reset");
    assert.equal(summary.modelReplies.resetRetries, route === "reset" ? 1 : 0);
    assert.equal(summary.modelReplies.resetRecovered, route === "reset" ? 1 : 0);
    assert.equal(summary.modelReplies.recovered, route === undefined ? 1 : 0);
    assert.equal(summary.modelReplies.capacityHops, route === undefined ? 1 : 0);
    assert.equal(summary.modelReplies.fallbackAccepted, route === undefined ? 1 : 0);
    assert.equal(summary.modelReplies.maxGenerationsPerDecision, route === undefined ? 3 : 2);
    assert.deepEqual(journal.map((e) => e.model), route === undefined ? ["luna", "sonnet", "sonnet"] : route === "reset" ? ["luna", "luna"] : ["luna"]);
    assert.ok(journal.every((e) => e.configuredModel === "luna"));
    assert.deepEqual(JSON.parse(stderr.trim().split("\n").at(-1)!).generationModel, journal.at(-1)!.generationModel);
    assert.equal((await fs.stat(summary.paths.modelReplies)).mode & 0o777, 0o600);
    assert.ok(journal.every((e) => !("rejectedReply" in e) && !("transportReply" in e)));
  }
});


test("one-attempt OpenCode request size excludes the unused correction while max2 stays bounded", async (t) => {
  const { envelope } = await fixture();
  envelope.semantic.snapshot.yourSide.name = "";
  const bytes = () => Buffer.byteLength(JSON.stringify({ prompt: buildBattlePolicyPrompt({ requestId: "size", envelope }), model: OPENCODE_BATTLE_MODELS.luna }));
  envelope.semantic.snapshot.yourSide.name = "x".repeat(95_990 - bytes());
  assert.equal(bytes(), 95_990, "the actual primary generation body fits the existing96KB bound");
  const mock = await recoveryMock([{}]);
  const single = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary);
  const result = await single.decide({ requestId: "size", envelope }, { signal: new AbortController().signal, deadlineAt: Date.now() + 3000 });
  assert.ok(envelope.semantic.snapshot.legalActions.some((a) => a.id === result.actionId));
  assert.equal((await mock.calls()).length, 1);
  const double = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, onAttempt() {} });
  await assert.rejects(double.decide({ requestId: "size", envelope }, { signal: new AbortController().signal, deadlineAt: Date.now() + 3000, async assertCurrent() {} }), /bounded OpenCode CLI request size/);
  assert.equal((await mock.calls()).length, 1, "the genuinely enabled oversized correction still fails before readiness or generation");
  t.diagnostic("primary body=95990bytes; max1 accepts; max2 correction remains over96000 and rejected");
});


test("advisory prompt ablations preserve the input and exact action set without changing effort", async () => {
  const dir = await fs.mkdtemp(path.join(directory, "prompt-ablation-"));
  const calls = path.join(dir, "calls.jsonl"), input = path.join(dir, "input.txt");
  await fs.writeFile(input, initial);
  await fs.writeFile(path.join(dir, "opencode"), mockOpenCodeScript(`
const fs = require('node:fs'), assert = require('node:assert/strict');
const body = JSON.parse(process.argv[5]);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(body)+'\\n');
assert.equal(body.model.variant,'xhigh');
const context=body.prompt.split('\\n\\n').filter(p=>p.startsWith('{')).map(p=>JSON.parse(p))
 .find(p=>p.battle || p.contractVersion==='battle-decision-card@1');
assert(context);
const first=context.legalActions[0];
process.stdout.write(JSON.stringify({data:{text:JSON.stringify({actionId:typeof first==='string'?first:first.id})}}));
`), { mode: 0o700 });
  const execute = promisify(execFile), cli = new URL("../tools/battle-agent-decide.ts", import.meta.url).pathname;
  const conditions = [["baseline"], ["temporal"], ["card", "raw"], ["card", "banded"], ["card", "hidden"]] as const;
  const outputs = [];
  for (const [variant, heuristics] of conditions) {
    const { stdout, stderr } = await execute(process.execPath, ["--import", "tsx", cli, "--input", input,
      "--model", "luna", "--fallback", "none", "--prompt", variant, ...(heuristics ? ["--heuristics", heuristics] : [])],
      { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 5000 });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout); outputs.push(result);
    assert.equal(result.promptContext.variant, variant);
    assert.equal(result.promptContext.heuristics, heuristics ?? "raw");
    assert.equal(result.modelReplies.length, 1);
    assert.deepEqual(result.modelReplies[0].generationModel, OPENCODE_BATTLE_MODELS.luna);
    assert.equal(result.modelReplies[0].outcome, "accepted");
  }
  assert.equal(new Set(outputs.map((o) => o.decision.inputResultHash)).size, 1);
  assert.equal(new Set(outputs.map((o) => JSON.stringify(o.decision.identity))).size, 1);
  assert.equal(new Set(outputs.map((o) => o.decision.actionId)).size, 1);
  const bodies = (await fs.readFile(calls, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const contexts = bodies.map((b) => b.prompt.split("\n\n").filter((p: string) => p.startsWith("{"))
    .map((p: string) => JSON.parse(p)).find((p: any) => p.battle || p.contractVersion === "battle-decision-card@1"));
  assert.ok(!("recentLog" in contexts[0].battle));
  assert.ok(Array.isArray(contexts[1].battle.recentLog));
  assert.equal(contexts[2].heuristicPresentation, "raw");
  assert.equal(contexts[3].heuristicPresentation, "banded");
  assert.ok(!("ownShortlist" in contexts[4]));
  const legalIds = (c: any) => c.legalActions.map((a: any) => typeof a === "string" ? a : a.id);
  assert.ok(contexts.every((c) => JSON.stringify(legalIds(c)) === JSON.stringify(legalIds(contexts[0]))));
  for (const [file, args, pattern] of [
    [cli, ["--input", input, "--ledger", input], /ledger requires/i],
    [cli, ["--input", input, "--task", "plan", "--fallback", "none"], /shadow plan task/i],
    [new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname, ["--p1", "luna", "--prompt", "card-ledger"], /live ledger carry/i]
  ] as const) {
    await assert.rejects(execute(process.execPath, ["--import", "tsx", file, ...args], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 5000
    }), (error: any) => { assert.match(error.stderr, pattern); return true; });
  }
  assert.equal((await fs.readFile(calls, "utf8")).trim().split("\n").length, 5, "invalid configurations never generate");
});


test("shadow plan CLI is non-executable and only reuses a ledger for the identical canonical request", async () => {
  const dir = await fs.mkdtemp(path.join(directory, "shadow-cli-"));
  const input = path.join(dir, "input.txt"), changed = path.join(dir, "next.txt"), output = path.join(dir, "plan-result.json");
  const ledger = path.join(dir, "ledger.json"), calls = path.join(dir, "calls.jsonl");
  await fs.writeFile(input, initial);
  await fs.writeFile(changed, initial.replace(/"rqid":47/, '"rqid":48'));
  const plan = { phase: "midgame", winConditions: [], mustPreserve: [], opponentEndgames: [], hypotheses: [], replanTriggers: [], notes: ["PLAN_CANARY hypothesis only"] };
  await fs.writeFile(path.join(dir, "opencode"), mockOpenCodeScript(`
const fs=require('node:fs');const body=JSON.parse(process.argv[5]);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(body)+'\\n');
let reply;
if(body.prompt.includes('PLAN_REFRESH')) reply=${JSON.stringify(plan)};
else {
 const card=body.prompt.split('\\n\\n').filter(p=>p.startsWith('{')).map(p=>JSON.parse(p)).find(p=>p.contractVersion==='battle-decision-card@1');
 const action=card.legalActions[0];reply={actionId:typeof action==='string'?action:action.id};
}
process.stdout.write(JSON.stringify({data:{text:JSON.stringify(reply)}}));
`), { mode: 0o700 });
  const execute = promisify(execFile), cli = new URL("../tools/battle-agent-decide.ts", import.meta.url).pathname;
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const planned = await execute(process.execPath, ["--import", "tsx", cli, "--task", "plan", "--input", input, "--output", output], { env, timeout: 5000 });
  assert.equal(planned.stderr, "");
  const artifact = JSON.parse(planned.stdout);
  assert.equal(artifact.mode, "shadow_plan"); assert.equal(artifact.task, "PLAN_REFRESH");
  assert.equal(artifact.authority, "advisory_only");
  assert.ok(!("decision" in artifact) && !("choice" in artifact) && !("actionId" in artifact));
  assert.deepEqual(artifact.ledger.plan, plan);
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), artifact);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  await fs.writeFile(ledger, JSON.stringify(artifact));
  for (const [file, status, budget] of [[input, "valid", "60000"], [changed, "mismatch", "60000"], [input, "expired", "180000"]] as const) {
    const action = await execute(process.execPath, ["--import", "tsx", cli, "--input", file, "--prompt", "card-ledger", "--ledger", ledger, "--fallback", "none", "--deadline-ms", budget], { env, timeout: 5000 });
    assert.equal(action.stderr, "");
    const result = JSON.parse(action.stdout);
    assert.equal(result.promptContext.ledgerStatus, status);
    assert.ok(result.decision.actionId);
    if (status !== "valid") assert.equal(result.promptContext.ledger, null);
  }
  const requests = (await fs.readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(requests.length, 4, "plan is exactly one explicitly requested generation; each action is independent");
  assert.equal(requests[1].prompt.includes("PLAN_CANARY"), true);
  assert.equal(requests[2].prompt.includes("PLAN_CANARY"), false);
  assert.equal(requests[3].prompt.includes("PLAN_CANARY"), false, "advice must outlive the entire action budget");
});

const declaredConnectionReset = JSON.stringify({ _tag: "ServiceUnavailableError", service: "openai",
  message: "ECONNRESET: The socket connection was closed unexpectedly. PRIVATE_RESET_DETAIL" });

test("connection reset recovery requires explicit two-attempt opt-in and recorder", async () => {
  for (const maxAttempts of [undefined, 1] as const) assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", {
    ...(maxAttempts === undefined ? {} : { maxAttempts }), retryConnectionReset: true, onAttempt() {}
  }), /reset recovery requires maxAttempts 2/);
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", {
    maxAttempts: 2, retryConnectionReset: true
  }), /recorder/);
  const { envelope } = await fixture(), mock = await recoveryMock([{}]);
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
    maxAttempts: 2, retryConnectionReset: true, onAttempt() {}
  });
  await assert.rejects(policy.decide({ requestId: "reset-no-check", envelope }, {
    deadlineAt: Date.now() + 2000, signal: new AbortController().signal
  }), /live-state checker/);
  assert.equal((await mock.calls()).length, 0);
});

test("connection reset recovery repeats pinned input once without dispatch or corrective text", async () => {
  const { engine, envelope } = await fixture(), before = structuredClone(envelope);
  const input = { requestId: "reset-pinned", envelope }, model = { ...OPENCODE_BATTLE_MODELS.luna };
  const mock = await recoveryMock([{ stdout: declaredConnectionReset, exitCode: 1 }, {}]);
  const events: OpenCodeAttemptEvent[] = [];
  const options: OpenCodeBattlePolicyOptions = { maxAttempts: 2, retryConnectionReset: true, onAttempt(event) {
    events.push(structuredClone(event));
    event.identity.rqid = 0; event.generationModel.id = "PRIVATE_MUTATION";
    input.requestId = "changed"; envelope.resultHash = "changed"; envelope.semantic.snapshot.legalActions = [];
    model.id = "PRIVATE_MUTATION"; options.retryConnectionReset = false;
    Object.assign(policy, { binary: "PRIVATE_WRONG_BINARY" });
  } };
  const policy = new OpenCodeBattlePolicy(model, mock.binary, options), policyId = policy.id;
  let checks = 0, sends = 0;
  const executor = new BattleActionExecutor(engine, sessionId, () => { sends++; return true; });
  executor.authorize(roomId, Date.now() + 5000);
  const originalCheck = engine.assertCurrent.bind(engine);
  engine.assertCurrent = (session, identity) => { checks++; return originalCheck(session, identity); };
  const decision = await new BattleAgent(engine, sessionId, policy).decide(envelope, { requestId: input.requestId, deadlineMs: 3000 });
  const calls = await mock.calls();
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal((await mock.catalogCalls()).length, 1);
  assert.equal(checks, 5); assert.equal(sends, 0);
  assert.equal(decision.requestId, "reset-pinned"); assert.deepEqual(decision.identity, before.semantic.identity);
  for (const event of events) {
    assert.equal(event.inputResultHash, before.resultHash); assert.deepEqual(event.identity, before.semantic.identity);
    assert.deepEqual(event.generationModel, OPENCODE_BATTLE_MODELS.luna);
  }
  assert.deepEqual(events.map(e => [e.attempt, e.attemptKind, e.outcome]), [[1, "initial", "failed"], [2, "transport_reset", "accepted"]]);
  assert.deepEqual(events[0]!.outcome === "failed" && events[0]!.transportError,
    { category: "http_service_unavailable", declaredHttpStatus: 503, declaredCode: "connection_reset" });
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|transportReply/); assert.equal(policy.id, policyId);
  await executor.execute(decision); assert.equal(sends, 1);
});

test("connection reset and format correction share exactly one extra generation", async () => {
  const { envelope } = await fixture();
  for (const replies of [
    [{ stdout: declaredConnectionReset, exitCode: 1 }, { stdout: declaredConnectionReset, exitCode: 1 }],
    [{ stdout: declaredConnectionReset, exitCode: 1 }, { text: "invalid" }],
    [{ text: "invalid" }, { stdout: declaredConnectionReset, exitCode: 1 }]
  ]) {
    const mock = await recoveryMock([...replies, {}]), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, retryConnectionReset: true, onAttempt(e) { events.push(e); }
    });
    await assert.rejects(policy.decide({ requestId: "shared-reset", envelope }, {
      deadlineAt: Date.now() + 3000, signal: new AbortController().signal, async assertCurrent() {}
    }));
    assert.equal((await mock.calls()).length, 2); assert.equal(events.length, 2);
    assert.equal(events[1]!.attemptKind, replies[0]!.text ? "format_correction" : "transport_reset");
  }
});

test("connection reset recovery excludes unqualified errors and is default off", async () => {
  const { envelope } = await fixture();
  const error = JSON.parse(declaredConnectionReset);
  const cases = [
    { stdout: declaredConnectionReset, exitCode: 1, enabled: false },
    ...["InvalidRequestError", "UnauthorizedError", "OtherError"].map(_tag => ({ stdout: JSON.stringify({ ...error, _tag }), exitCode: 1 })),
    { stdout: JSON.stringify({ ...error, service: "anthropic" }), exitCode: 1 },
    ...["server unavailable", "prefix " + error.message, "ECONNRESET: other"].map(message => ({ stdout: JSON.stringify({ ...error, message }), exitCode: 1 })),
    { stdout: JSON.stringify({ data: error }), exitCode: 1 },
    { stdout: "not JSON", exitCode: 1 }, { stdout: declaredConnectionReset, exitCode: 0 },
    { stdout: declaredConnectionReset, exitCode: 1, otherProvider: true }
  ];
  for (const response of cases) {
    const mock = await recoveryMock([response, {}]), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy("otherProvider" in response ? OPENCODE_BATTLE_MODELS.sonnet : OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, retryConnectionReset: !("enabled" in response), onAttempt(e) { events.push(e); }
    });
    await assert.rejects(policy.decide({ requestId: "excluded-reset", envelope }, {
      deadlineAt: Date.now() + 3000, signal: new AbortController().signal, async assertCurrent() {}
    }));
    assert.equal((await mock.calls()).length, 1); assert.equal(events.length, 1);
  }
});

for (const stop of ["recorder", "stale", "cancel", "deadline"] as const) test(`connection reset recovery ${stop} prevents another generation`, async () => {
  const { envelope } = await fixture(), controller = new AbortController(); let recorded = false;
  const mock = await recoveryMock([{ stdout: declaredConnectionReset, exitCode: 1 }, {}]);
  const events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
    maxAttempts: 2, retryConnectionReset: true, onAttempt(e) {
      events.push(e); recorded = true;
      if (stop === "recorder") throw new Error("PRIVATE_RECORDER");
      if (stop === "cancel") controller.abort();
      if (stop === "deadline") return delay(500);
    }
  });
  await assert.rejects(policy.decide({ requestId: stop, envelope }, {
    signal: controller.signal, deadlineAt: Date.now() + (stop === "deadline" ? 350 : 2000),
    async assertCurrent() { if (recorded && stop === "stale") throw new Error("no longer current"); }
  }));
  assert.equal((await mock.calls()).length, 1); assert.equal(events.length, 1);
});


test("connection reset simulator flag rejects incompatible configurations before policy calls", async () => {
  const execute = promisify(execFile), cli = new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname;
  for (const args of [["--p1", "deterministic", "--p2", "deterministic"], ["--p1", "luna", "--model-attempts", "1"]]) {
    await assert.rejects(execute(process.execPath, ["--import", "tsx", cli, ...args, "--retry-connection-reset"], { timeout: 5000 }),
      /requires an OpenCode player and --model-attempts 2/);
  }
});

test("connection reset does not hop models and preserves the separate exact-overload allowance", async () => {
  const { envelope } = await fixture();
  for (const overload of [false, true]) {
    const mock = await recoveryMock([{ stdout: declaredConnectionReset, exitCode: 1 },
      ...(overload ? [{ stdout: declaredOverload, exitCode: 1 }] : []), {}]);
    const events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, retryConnectionReset: true, overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt(e) { events.push(e); }
    });
    await policy.decide({ requestId: "reset-overload", envelope }, {
      deadlineAt: Date.now() + 3000, signal: new AbortController().signal, async assertCurrent() {}
    });
    assert.deepEqual(events.map(e => e.attemptKind), overload ? ["initial", "transport_reset", "capacity_fallback"] : ["initial", "transport_reset"]);
    assert.deepEqual((await mock.calls()).map(c => c.model), overload
      ? [OPENCODE_BATTLE_MODELS.luna, OPENCODE_BATTLE_MODELS.luna, OPENCODE_BATTLE_MODELS.sonnet]
      : [OPENCODE_BATTLE_MODELS.luna, OPENCODE_BATTLE_MODELS.luna]);
  }
});


test("connection reset and overload routing ignore recorder transport metadata mutations", async () => {
  const { envelope } = await fixture();
  for (const [qualifiedReset, forgedCode] of [[false, "connection_reset"], [false, "server_is_overloaded"], [true, "server_is_overloaded"]] as const) {
    const stdout = qualifiedReset ? declaredConnectionReset : JSON.stringify({ _tag: "ServiceUnavailableError", service: "openai", message: "generic unavailable" });
    const mock = await recoveryMock([{ stdout, exitCode: 1 }, {}]), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, retryConnectionReset: true, overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt(event) {
        events.push(structuredClone(event));
        if (event.outcome === "failed" && event.transportError?.category === "http_service_unavailable") event.transportError.declaredCode = forgedCode;
      }
    });
    const decided = policy.decide({ requestId: "recorder-transport-mutation", envelope }, {
      deadlineAt: Date.now() + 3000, signal: new AbortController().signal, async assertCurrent() {}
    });
    if (qualifiedReset) await decided; else await assert.rejects(decided, /generation failed/);
    const calls = await mock.calls();
    assert.equal(calls.length, qualifiedReset ? 2 : 1);
    assert.deepEqual(calls.map(call => call.model), calls.map(() => OPENCODE_BATTLE_MODELS.luna));
    assert.equal(events.filter(event => event.attemptKind === "capacity_fallback").length, 0);
    if (qualifiedReset) assert.equal(events[1]!.attemptKind, "transport_reset");
  }
});

const genericUnavailable = JSON.stringify({ _tag: "ServiceUnavailableError", service: "openai", message: "PRIVATE_GENERIC_503" });

test("generic 503 retry is opt-in, needs two attempts, and leaves the default no-retry path unchanged", async () => {
  // R56 continuation: two of three cohort-stopping failures were single generic Luna 503s.
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", { retryServiceUnavailable: true, onAttempt() {} }),
    /503 retry requires maxAttempts 2/);
  const { envelope } = await fixture();
  const mock = await recoveryMock([{ stdout: genericUnavailable, exitCode: 1 }, {}]), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
    maxAttempts: 2, overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt(e) { events.push(structuredClone(e)); } });
  await assert.rejects(policy.decide({ requestId: "503-default", envelope }, {
    deadlineAt: Date.now() + 3000, signal: new AbortController().signal, async assertCurrent() {} }), /generation failed/);
  assert.equal((await mock.calls()).length, 1, "without the flag a generic 503 neither retries nor hops");
  assert.deepEqual(events.map(e => e.attemptKind), ["initial"]);
});

test("generic 503 retries the pinned input once on the same model, then may hop to the fallback", async () => {
  const { envelope } = await fixture();
  const cases = [
    { replies: [{ stdout: genericUnavailable, exitCode: 1 }, {}], fallback: true, ok: true,
      kinds: ["initial", "service_retry"], models: ["luna", "luna"] },
    { replies: [{ stdout: genericUnavailable, exitCode: 1 }, { stdout: genericUnavailable, exitCode: 1 }, {}], fallback: true, ok: true,
      kinds: ["initial", "service_retry", "capacity_fallback"], models: ["luna", "luna", "sonnet"] },
    { replies: [{ stdout: genericUnavailable, exitCode: 1 }, { stdout: declaredOverload, exitCode: 1 }, {}], fallback: true, ok: true,
      kinds: ["initial", "service_retry", "capacity_fallback"], models: ["luna", "luna", "sonnet"] },
    { replies: [{ stdout: genericUnavailable, exitCode: 1 }, { stdout: genericUnavailable, exitCode: 1 }], fallback: false, ok: false,
      kinds: ["initial", "service_retry"], models: ["luna", "luna"] },
    { replies: [{ stdout: genericUnavailable, exitCode: 1 }, { stdout: declaredConnectionReset, exitCode: 1 }], fallback: true, ok: false,
      kinds: ["initial", "service_retry"], models: ["luna", "luna"] },
    { replies: [{ text: "not json" }, { stdout: genericUnavailable, exitCode: 1 }], fallback: true, ok: false,
      kinds: ["initial", "format_correction"], models: ["luna", "luna"] }
  ];
  for (const c of cases) {
    const mock = await recoveryMock(c.replies), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, retryServiceUnavailable: true, ...(c.fallback ? { overloadFallback: OPENCODE_BATTLE_MODELS.sonnet } : {}),
      onAttempt(e) { events.push(structuredClone(e));
        if (e.outcome === "failed" && e.transportError?.category === "http_service_unavailable") e.transportError.declaredCode = "server_is_overloaded"; } });
    assert.match(policy.id, /\|503=once/);
    const decided = policy.decide({ requestId: "503-retry", envelope }, {
      deadlineAt: Date.now() + 3000, signal: new AbortController().signal, async assertCurrent() {} });
    if (c.ok) await decided; else await assert.rejects(decided);
    const calls = await mock.calls();
    assert.deepEqual(events.map(e => e.attemptKind), c.kinds);
    assert.deepEqual(calls.map(call => call.model), c.models.map(m => OPENCODE_BATTLE_MODELS[m as "luna" | "sonnet"]));
    if (c.kinds[1] === "service_retry") assert.deepEqual(calls[1], calls[0], "retry repeats the pinned input without corrective text");
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_GENERIC_503/);
  }
});

test("503 retry simulator flag rejects incompatible configurations before policy calls", async () => {
  const execute = promisify(execFile), cli = new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname;
  for (const args of [["--p1", "deterministic", "--p2", "deterministic"], ["--p1", "luna", "--model-attempts", "1"]]) {
    await assert.rejects(execute(process.execPath, ["--import", "tsx", cli, ...args, "--retry-service-unavailable"], { timeout: 5000 }),
      /requires an OpenCode player and --model-attempts 2/);
  }
});

async function claudeMock(replies: Array<{ result?: string; isError?: boolean; exitCode?: number; hold?: boolean }>) {
  const dir = await fs.mkdtemp(path.join(directory, "claude-")), binary = path.join(dir, "claude"), calls = path.join(dir, "calls.jsonl");
  await fs.writeFile(binary, `#!${process.execPath}
const fs = require('node:fs'); const argv = process.argv.slice(2);
let prior = ''; try { prior = fs.readFileSync(${JSON.stringify(calls)}, 'utf8'); } catch {}
const index = prior.trim() ? prior.trim().split('\\n').length : 0;
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()) }) + '\\n');
const reply = ${JSON.stringify(replies)}[index]; if (!reply) process.exit(77);
if (reply.hold) { setInterval(()=>{},1000); return; }
const prompt = argv[argv.indexOf('--') + 1];
const data = prompt.split('\\n\\n').filter(p => p.startsWith('{')).map(p => JSON.parse(p)).find(p => p.battle);
const result = reply.result ?? JSON.stringify({ actionId: data.legalActions.find(a => a.choice && !a.disabled).id });
process.stdout.write(JSON.stringify({ type: 'result', subtype: reply.isError ? 'error' : 'success', is_error: !!reply.isError, result }));
process.exitCode = reply.exitCode ?? 0;
`, { mode: 0o755 });
  return { binary, calls: async () => (await fs.readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

test("Claude Code transport sends OpenCode's exact prompt, isolated, from an empty private directory", async () => {
  // The harness benchmark is only fair if both harnesses see the same prompt and the Claude side
  // carries no tools, MCP, settings/hooks, skills, session or CLAUDE.md context.
  const { envelope } = await fixture(), input = { requestId: "claude-code-parity", envelope };
  const actionId = envelope.semantic.snapshot.legalActions.find((a) => a.choice && !a.disabled)!.id, reply = JSON.stringify({ actionId });
  const claude = await claudeMock([{ result: reply }]), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(CLAUDE_CODE_SONNET, claude.binary, { promptVariant: "card", heuristicPresentation: "banded",
    maxAttempts: 2, retryServiceUnavailable: true, onAttempt(e) { events.push(structuredClone(e)); } });
  assert.match(policy.id, /^claude-code:claude-code\/claude-sonnet-5-5#high\|503=once\|prompt=card:banded$/);
  const decision = await policy.decide(input, { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, async assertCurrent() {} });
  assert.equal(decision.actionId, actionId);
  const [call] = await claude.calls();
  const sep = call.argv.indexOf("--");
  assert.deepEqual(call.argv.slice(0, sep), ["-p", "--no-session-persistence", "--setting-sources", "", "--tools", "", "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--model", "claude-sonnet-5-5", "--effort", "high", "--output-format", "json"]);
  assert.equal(call.argv.length, sep + 2);
  assert.ok(path.basename(call.cwd).startsWith("shwdn2op-claude-code-") && call.entries.length === 0);
  assert.notEqual(path.resolve(call.cwd), path.resolve(process.cwd()));
  const opencode = await recoveryMock([{ text: reply }]);
  await new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, opencode.binary, { promptVariant: "card", heuristicPresentation: "banded",
    maxAttempts: 2, onAttempt() {} }).decide(input, { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, async assertCurrent() {} });
  assert.equal(call.argv[sep + 1], (await opencode.calls())[0]!.prompt, "identical prompt across harnesses");
  assert.deepEqual(events.map((e) => [e.attemptKind, e.outcome, e.generationModel.providerID]), [["initial", "accepted", "claude-code"]]);
});

test("Claude Code declared 529/503 takes the opt-in same-model retry; other errors never retry", async () => {
  const { envelope } = await fixture();
  const overloaded = { isError: true, exitCode: 1, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"PRIVATE_OVERLOAD"}}' };
  const cases = [
    { replies: [overloaded, {}], retry: true, ok: true, kinds: ["initial", "service_retry"], status: 529 },
    { replies: [{ ...overloaded, result: "API Error: 503 PRIVATE" }, {}], retry: true, ok: true, kinds: ["initial", "service_retry"], status: 503 },
    { replies: [overloaded, {}], retry: false, ok: false, kinds: ["initial"], status: 529 },
    { replies: [{ isError: true, exitCode: 1, result: "API Error: 400 PRIVATE" }, {}], retry: true, ok: false, kinds: ["initial"], status: undefined },
    { replies: [{ isError: true, exitCode: 0, result: "PRIVATE" }, {}], retry: true, ok: false, kinds: ["initial"], status: undefined }
  ];
  for (const c of cases) {
    const claude = await claudeMock(c.replies), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(CLAUDE_CODE_SONNET, claude.binary, { maxAttempts: 2, retryServiceUnavailable: c.retry,
      captureTransportErrors: false, onAttempt(e) { events.push(structuredClone(e)); } });
    const decided = policy.decide({ requestId: "claude-code-retry", envelope }, { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, async assertCurrent() {} });
    if (c.ok) await decided; else await assert.rejects(decided);
    assert.deepEqual(events.map((e) => e.attemptKind), c.kinds);
    const first = events[0]!;
    assert.equal(first.outcome === "failed" ? first.transportError?.declaredHttpStatus : undefined, c.status);
    assert.equal((await claude.calls()).length, c.kinds.length);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  }
  assert.throws(() => new OpenCodeBattlePolicy(CLAUDE_CODE_SONNET, "unused", { maxAttempts: 2, overloadFallback: OPENCODE_BATTLE_MODELS.sonnet, onAttempt() {} }),
    /no model fallback/);
});

/** Mock `grok` headless binary: records argv, cwd contents and the GROK_* environment, then answers
 * with Grok's JSON success object or its `{type:"error", message}` object. */
async function grokMock(replies: Array<{ text?: string; error?: string; exitCode?: number; hold?: boolean }>) {
  const dir = await fs.mkdtemp(path.join(directory, "grok-")), binary = path.join(dir, "grok"), calls = path.join(dir, "calls.jsonl");
  await fs.writeFile(binary, `#!${process.execPath}
const fs = require('node:fs'); const argv = process.argv.slice(2);
let prior = ''; try { prior = fs.readFileSync(${JSON.stringify(calls)}, 'utf8'); } catch {}
const index = prior.trim() ? prior.trim().split('\\n').length : 0;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GROK_')));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), env }) + '\\n');
const reply = ${JSON.stringify(replies)}[index]; if (!reply) process.exit(77);
if (reply.hold) { setInterval(()=>{},1000); return; }
const prompt = argv.at(-1).slice('--single='.length);
const data = prompt.split('\\n\\n').filter(p => p.startsWith('{')).map(p => JSON.parse(p)).find(p => p.legalActions);
const action = data.legalActions.find(a => typeof a === 'string' || (a.choice && !a.disabled && a.legality !== 'disabled'));
process.stdout.write(JSON.stringify(reply.error !== undefined ? { type: 'error', message: reply.error, cwd: process.cwd() }
  : { text: reply.text ?? JSON.stringify({ actionId: typeof action === 'string' ? action : action.id }), stopReason: 'end_turn', sessionId: 's', requestId: 'r', cwd: process.cwd() }));
process.exitCode = reply.exitCode ?? 0;
`, { mode: 0o755 });
  return { binary, calls: async () => (await fs.readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

test("Grok CLI transport sends OpenCode's exact prompt, isolated, from an empty private directory", async () => {
  // The harness benchmark is only fair if Grok sees the same prompt as OpenCode and carries no tools, web
  // search, subagents, memory, repository rules, or the CLAUDE.md, skills, MCP and hooks Grok imports from Claude Code.
  const { envelope } = await fixture(), input = { requestId: "grok-cli-parity", envelope };
  const actionId = envelope.semantic.snapshot.legalActions.find((a) => a.choice && !a.disabled)!.id, reply = JSON.stringify({ actionId });
  const grok = await grokMock([{ text: reply }]), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(GROK_46, grok.binary, { promptVariant: "card", heuristicPresentation: "banded",
    maxAttempts: 2, retryServiceUnavailable: true, onAttempt(e) { events.push(structuredClone(e)); } });
  assert.match(policy.id, /^grok-cli:grok-cli\/grok-4\.6#low\|503=once\|prompt=card:banded$/);
  const decision = await policy.decide(input, { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, async assertCurrent() {} });
  assert.equal(decision.actionId, actionId);
  const [call] = await grok.calls();
  assert.deepEqual(call.argv.slice(0, -2), ["--verbatim", "--no-memory", "--model", "grok-4.6", "--reasoning-effort", "low",
    "--tools", "todo_write", "--disallowed-tools", "todo_write,search_tool,use_tool", "--disable-web-search", "--no-subagents", "--no-plan",
    "--max-turns", "1", "--output-format", "json", "--cwd"]);
  assert.equal(await fs.realpath(call.argv.at(-2)), call.cwd, "--cwd names the spawn directory");
  assert.ok(call.argv.at(-1).startsWith("--single="), "the prompt is one attached argument, never a separate value or shell text");
  assert.ok(path.basename(call.cwd).startsWith("shwdn2op-grok-cli-") && call.entries.length === 0);
  if (process.platform !== "win32") assert.equal((await fs.stat(call.cwd)).mode & 0o777, 0o700);
  assert.notEqual(path.resolve(call.cwd), path.resolve(process.cwd()));
  for (const vendor of ["CLAUDE", "CURSOR"]) for (const surface of ["AGENTS", "RULES", "SKILLS", "MCPS", "HOOKS"]) {
    assert.equal(call.env[`GROK_${vendor}_${surface}_ENABLED`], "false", `${vendor} ${surface} discovery is off`);
  }
  assert.equal(call.env.GROK_WORKFLOWS, "0");
  const opencode = await recoveryMock([{ text: reply }]);
  await new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.sonnet, opencode.binary, { promptVariant: "card", heuristicPresentation: "banded",
    maxAttempts: 2, onAttempt() {} }).decide(input, { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, async assertCurrent() {} });
  assert.equal(call.argv.at(-1), `--single=${(await opencode.calls())[0]!.prompt}`, "identical prompt across harnesses");
  assert.deepEqual(events.map((e) => [e.attemptKind, e.outcome, e.generationModel.providerID]), [["initial", "accepted", "grok-cli"]]);
});

test("Grok CLI declared 503/529 takes the opt-in same-model retry; other errors never retry", async () => {
  const { envelope } = await fixture();
  const overloaded = { exitCode: 1, error: "Grok is temporarily overloaded. Please try again in a moment. (HTTP 529) PRIVATE_OVERLOAD" };
  const cases = [
    { replies: [overloaded, {}], retry: true, ok: true, kinds: ["initial", "service_retry"], status: 529 },
    { replies: [{ exitCode: 1, error: "Grok is temporarily unavailable. Please try again in a moment. (HTTP 503) PRIVATE" }, {}], retry: true, ok: true, kinds: ["initial", "service_retry"], status: 503 },
    { replies: [overloaded, {}], retry: false, ok: false, kinds: ["initial"], status: 529 },
    // Only Grok's own declared "(HTTP n)" status counts: rate limits, auth and incidental digits never retry.
    { replies: [{ exitCode: 1, error: "Request failed (HTTP 429) PRIVATE" }, {}], retry: true, ok: false, kinds: ["initial"], status: undefined },
    { replies: [{ exitCode: 1, error: "Not signed in. PRIVATE 503" }, {}], retry: true, ok: false, kinds: ["initial"], status: undefined },
    { replies: [{ exitCode: 0, error: "PRIVATE (HTTP 503)" }, {}], retry: true, ok: false, kinds: ["initial"], status: undefined }
  ];
  for (const c of cases) {
    const grok = await grokMock(c.replies), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(GROK_46, grok.binary, { maxAttempts: 2, retryServiceUnavailable: c.retry,
      captureTransportErrors: false, onAttempt(e) { events.push(structuredClone(e)); } });
    const decided = policy.decide({ requestId: "grok-cli-retry", envelope }, { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, async assertCurrent() {} });
    if (c.ok) await decided; else await assert.rejects(decided);
    assert.deepEqual(events.map((e) => e.attemptKind), c.kinds);
    const first = events[0]!;
    assert.equal(first.outcome === "failed" ? first.transportError?.declaredHttpStatus : undefined, c.status);
    const calls = await grok.calls();
    assert.equal(calls.length, c.kinds.length);
    if (c.ok) assert.deepEqual(calls[1].argv, calls[0].argv, "the retry repeats the pinned input on the same model without corrective text");
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  }
  for (const [model, overloadFallback] of [[GROK_46, OPENCODE_BATTLE_MODELS.sonnet], [OPENCODE_BATTLE_MODELS.luna, GROK_46]] as const) {
    assert.throws(() => new OpenCodeBattlePolicy(model, "unused", { maxAttempts: 2, overloadFallback, onAttempt() {} }), /Grok CLI generation takes no model fallback/);
  }
});

test("simulator grok player runs GROK_BIN and journals its replies as grok", async () => {
  const dir = await fs.mkdtemp(path.join(directory, "grok-sim-")), output = path.join(dir, "output");
  const grok = await grokMock([{}, {}, {}, {}]);
  const cli = new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, "--p1", "grok", "--p2", "deterministic", "--format", "gen9uu",
    "--max-turns", "1", "--decision-ms", "5000", "--timeout-ms", "20000", "--prompt", "card", "--fallback", "none", "--output", output],
  { env: { ...process.env, GROK_BIN: grok.binary }, timeout: 25000 })
    .catch((error: { code?: number; stdout: string; stderr: string }) => { if (error.code !== 2) throw error; return error; });
  const summary = JSON.parse(result.stdout), journal = (await fs.readFile(summary.paths.modelReplies, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(summary.status, "truncated"); assert.equal(summary.errors.length, 0);
  assert.ok(journal.length > 0 && journal.every((e) => e.model === "grok" && e.configuredModel === "grok" && e.outcome === "accepted"));
  assert.deepEqual(journal[0].generationModel, GROK_46);
  assert.equal((await grok.calls()).length, journal.length);
  assert.match(summary.players.p1.policyId, /^grok-cli:grok-cli\/grok-4\.6#low\|prompt=card:banded$/);
  const trajectory = (await fs.readFile(summary.paths.trajectory, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(trajectory.filter((entry) => entry.side === "p1").every((entry) => entry.policyId === summary.players.p1.policyId && !entry.fallback));
});

test("bot advice stays outside every canonical prompt variant and invalid bindings fail before generation", async () => {
  const { envelope } = await fixture(), requestId = "advice-prompt";
  const action = envelope.semantic.snapshot.legalActions.find((entry) => entry.choice && !entry.disabled)!;
  const advice: BattleAdvice = { source: "metamon", policyId: "metamon:Kakuna:epoch34", requestId,
    identity: structuredClone(envelope.semantic.identity), inputResultHash: envelope.resultHash, actionId: action.id };
  const value: BattlePolicyInput = { requestId, envelope, advice }, before = structuredClone(value);
  for (const promptVariant of BATTLE_PROMPT_VARIANTS) {
    const plain = buildBattlePolicyPrompt({ requestId, envelope }, { promptVariant });
    const advised = buildBattlePolicyPrompt(value, { promptVariant });
    assert.ok(advised.startsWith(plain + "\n\nIndependent bot opinion, not canonical evidence:"));
    assert.deepEqual(JSON.parse(advised.split("\n\n").at(-1)!).botAdvice, advice);
    assert.match(advised, /Accept or override/);
  }
  assert.deepEqual(value, before);
  for (const mutate of [
    (entry: BattlePolicyInput) => { entry.advice!.requestId = "other"; },
    (entry: BattlePolicyInput) => { entry.advice!.inputResultHash = "other"; },
    (entry: BattlePolicyInput) => { entry.advice!.identity.rqid!++; },
    (entry: BattlePolicyInput) => { entry.advice!.actionId = "absent"; },
    (entry: BattlePolicyInput) => { entry.envelope.semantic.snapshot.phase = "preview"; },
    (entry: BattlePolicyInput) => { entry.envelope.semantic.snapshot.legalActions.find((candidate) => candidate.id === action.id)!.disabled = true; }
  ]) {
    const invalid = structuredClone(value); mutate(invalid);
    assert.throws(() => buildBattlePolicyPrompt(invalid), /advice is unavailable/);
  }
});

test("OpenCode correction reuses the same bound bot opinion and journals the opinion actually sent", async () => {
  const { envelope, engine } = await fixture(), requestId = "advice-recovery";
  const action = envelope.semantic.snapshot.legalActions.find((entry) => entry.choice && !entry.disabled)!;
  const advice: BattleAdvice = { source: "metamon", policyId: "metamon:Kakuna:epoch34", requestId,
    identity: structuredClone(envelope.semantic.identity), inputResultHash: envelope.resultHash, actionId: action.id };
  const value: BattlePolicyInput = { requestId, envelope, advice };
  const original = structuredClone(advice), events: OpenCodeAttemptEvent[] = [];
  const mock = await recoveryMock([{ text: "unstructured" }, { text: JSON.stringify({ actionId: action.id }) }]);
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2,
    onAttempt: (event) => { events.push(structuredClone(event)); event.advice!.actionId = "RECORDER_MUTATION"; } });
  const decision = await policy.decide(value, { deadlineAt: Date.now() + 5000, signal: new AbortController().signal,
    assertCurrent: async () => { await engine.assertCurrent(sessionId, envelope.semantic.identity); } });
  assert.equal(decision.actionId, action.id);
  const calls = await mock.calls(); assert.equal(calls.length, 2);
  const prompt = buildBattlePolicyPrompt(value);
  assert.equal(calls[0]!.prompt, prompt); assert.ok(calls[1]!.prompt.startsWith(prompt + "\n\n"));
  assert.deepEqual(events.map((event) => event.advice), [original, original]);
  assert.deepEqual(value.advice, original);
});

for (const scenario of ["suggest", "veto", "veto-accepted", "veto-invalid", "veto-illegal"] as const) test(`opt-in ${scenario} hybrid CLI writes private advice joins and uses an independent actor transport`, async () => {
  const adviceMode = scenario === "suggest" ? "suggest" : "veto";
  const rejection = scenario === "veto" ? "missing_override" : scenario === "veto-invalid" ? "invalid_card_field" : scenario === "veto-illegal" ? "illegal_action" : undefined;
  const dir = await fs.mkdtemp(path.join(directory, "advised-cli-")), output = path.join(dir, "output");
  const binary = path.join(dir, "opencode");
  await fs.writeFile(binary, mockOpenCodeScript(`
const arg=process.argv[process.argv.indexOf('--data')+1], body=JSON.parse(arg);
const objects=body.prompt.split('\\n\\n').filter(part=>part.startsWith('{')).map(part=>JSON.parse(part));
const battle=objects.find(value=>value.legalActions);
const enabled=battle.legalActions.filter(value=>typeof value==='string'||(!value.disabled&&value.legality!=='disabled'));
const action=enabled[${adviceMode === "veto" ? 1 : 0}];
process.stdout.write(JSON.stringify({data:{text:JSON.stringify({actionId:${scenario === "veto-illegal" ? "'ABSENT'" : "typeof action==='string'?action:action.id"},
  ...${JSON.stringify(scenario === "veto" || scenario === "suggest" ? {} : { override: { cardField: scenario === "veto-invalid" ? "current.absent" : "current.phase", reason: "Cited concern" } })}})}}));
`), { mode: 0o700 });
  const worker = String.raw`
const readline=require('node:readline');let request,pending=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),r={id:m.id,version:m.version,ok:true};
 if(m.op==='observe'){
  if(pending)throw Error('uncommitted');r.context=m.context;
  if(m.context.side!=='p1')throw Error('wrong_actor');
  for(const line of m.data.split('\n'))if(line.startsWith('|request|'))request=JSON.parse(line.slice(9));
 }else{
  r.binding={requestId:m.requestId,identity:m.identity,resultHash:m.resultHash,sequence:m.sequence};
  if(m.op==='propose'){pending=true;r.choice=request.teamPreview?{kind:'team',team:[1,2,3,4,5,6]}:{kind:'move',moveSlot:1,terastallize:false};}
  else if(m.op==='commit'){if(!pending)throw Error('no_proposal');pending=false;r.choice=m.choice;}
 }
 process.stdout.write(JSON.stringify(r)+'\n');
});`;
  const cli = new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname;
  const argv = ["--import", "tsx", cli, "--p1", "luna", "--p2", "deterministic", "--format", "gen9uu", "--max-turns", "1",
    "--decision-ms", "5000", "--timeout-ms", "20000", "--prompt", "card", "--fallback", "none", "--trace", "--output", output,
    "--metamon-advice", "p1", "--metamon-command", process.execPath, "--metamon-args", JSON.stringify(["-e", worker]),
    ...(adviceMode === "veto" ? ["--metamon-advice-mode", "veto"] : [])];
  const result = await promisify(execFile)(process.execPath, argv, { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH }, timeout: 25000 })
    .catch((error: { code?: number; stdout: string; stderr: string }) => { if (error.code !== 2) throw error; return error; });
  const summary = JSON.parse(result.stdout), events = (await fs.readFile(summary.paths.metamonAdvice, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const attempts = (await fs.readFile(summary.paths.modelReplies, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(summary.status, "truncated"); assert.equal(summary.errors.length, 0); assert.equal(summary.fallbacks.length, 0);
  assert.equal(summary.metamonAdvice.eligible, adviceMode === "veto" ? 2 : 1); assert.equal(summary.metamonAdvice.available, adviceMode === "veto" ? 2 : 1);
  assert.equal(summary.metamonAdvice.commits, 2); assert.equal(summary.metamonAdvice.overrides, scenario === "veto-accepted" ? 2 : 0);
  assert.equal(summary.metamonAdvice.mode, adviceMode);
  assert.equal(summary.metamonAdvice.vetoProposals, adviceMode === "veto" ? 2 : 0);
  assert.equal(summary.metamonAdvice.vetoAccepted, scenario === "veto-accepted" ? 2 : 0);
  assert.deepEqual(summary.metamonAdvice.vetoRejected, { missing_override: rejection === "missing_override" ? 2 : 0,
    invalid_card_field: rejection === "invalid_card_field" ? 2 : 0, illegal_action: rejection === "illegal_action" ? 2 : 0 });
  assert.equal(attempts.length, 2, "veto rejections do not add model generations");
  if (adviceMode === "veto") {
    assert.match(summary.players.p1.policyId, /\|advice=veto$/);
    for (const event of events.filter(event => event.phase === "commit")) {
      if (scenario === "veto-accepted") {
        assert.equal(event.executedActionId, event.modelActionId); assert.notEqual(event.executedActionId, event.adviceActionId);
      } else {
        assert.equal(event.executedActionId, event.adviceActionId); assert.notEqual(event.modelActionId, event.executedActionId);
      }
      assert.equal(event.override, rejection ? `rejected:${rejection}` : "accepted");
      assert.equal(event.cardField, scenario === "veto" ? null : scenario === "veto-invalid" ? "current.absent" : "current.phase");
    }
  }
  assert.deepEqual(events.map((event) => [event.phase, event.status]), [
    ["opinion", adviceMode === "veto" ? "available" : "hidden_preview"], ["commit", "committed"], ["opinion", "available"], ["commit", "committed"]
  ]);
  if (adviceMode === "suggest") assert.equal(attempts[0].advice, undefined);
  else assert.equal(attempts[0].advice.mode, "veto");
  assert.equal(attempts[1].advice.actionId, events[2].proposedActionId);
  assert.equal(attempts[1].advice.inputResultHash, events[2].inputResultHash);
  if (process.platform !== "win32") assert.equal((await fs.stat(summary.paths.metamonAdvice)).mode & 0o777, 0o600);
});

test("CLI rejects --metamon-advice-mode without --metamon-advice before starting any policy", async () => {
  // A mode without an advisor must not silently run an ordinary model arm.
  const cli = new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname;
  for (const mode of ["suggest", "veto"]) await assert.rejects(promisify(execFile)(process.execPath,
    ["--import", "tsx", cli, "--metamon-advice-mode", mode]), /--metamon-advice-mode requires --metamon-advice/);
  await assert.rejects(promisify(execFile)(process.execPath,
    ["--import", "tsx", cli, "--metamon-advice", "p1", "--metamon-advice-mode", "other"]), /must be suggest or veto/);
});

for (const c of [
  { name: "default", status: "none" },
  { name: "valid citation", field: "current.phase", status: "accepted" },
  { name: "hidden field", field: "ownShortlist.candidates.0.actionId", status: "rejected:invalid_card_field" },
  { name: "missing override", status: "rejected:missing_override" },
  { name: "illegal action", field: "current.phase", status: "rejected:illegal_action" }
]) test(`OpenCode veto ${c.name} binds routing to the exact displayed Card without another generation`, async () => {
  // Adapter integration proves the host cites the serialized projection (hidden
  // heuristics cannot be cited), and that legality failures are vetoes rather
  // than format errors that would otherwise spend another model call.
  const { envelope } = await fixture(), requestId = "veto-rendered-card";
  const enabled = envelope.semantic.snapshot.legalActions.filter(a => a.choice && !a.disabled && a.legality !== "disabled");
  assert.ok(enabled.length >= 2);
  const adviceActionId = enabled[0]!.id;
  const modelActionId = c.name === "default" ? adviceActionId : c.name === "illegal action" ? "ABSENT" : enabled[1]!.id;
  const reply = { actionId: modelActionId, ...("field" in c ? { override: { cardField: c.field, reason: "Cited concern" } } : {}) };
  const mock = await recoveryMock([{ text: JSON.stringify(reply) }]), events: OpenCodeAttemptEvent[] = [];
  const { MetamonAdvisedBattlePolicy } = await import("../battle-agent/metamon.js");
  const adviceEvents: import("../battle-agent/metamon.js").MetamonAdviceEvent[] = [], commits: string[] = [];
  const model = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, promptVariant: "card", heuristicPresentation: "hidden",
    onAttempt(event) { events.push(structuredClone(event)); event.advice!.actionId = "RECORDER_MUTATION"; } });
  const policy = new MetamonAdvisedBattlePolicy(model, { id: "metamon:Kakuna:epoch34", observe: async () => {}, close: async () => {},
    decide: async value => ({ requestId: value.requestId, identity: value.envelope.semantic.identity, actionId: adviceActionId }),
    commit: async (_value, decision) => { commits.push(decision.actionId); }
  }, { mode: "veto", onAdvice: event => { adviceEvents.push(structuredClone(event)); } });
  try {
    const operation = { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, assertCurrent: async () => {} };
    const decision = await policy.decide({ requestId, envelope }, operation);
    const expected = c.status === "accepted" ? modelActionId : adviceActionId;
    assert.equal(decision.actionId, expected); await policy.commit({ requestId, envelope }, decision, operation);
    assert.deepEqual(commits, [expected]);
    const event = adviceEvents[1]!; assert.equal(event.phase === "commit" && event.override, c.status);
    assert.equal(event.phase === "commit" && event.modelActionId, modelActionId);
    const calls = await mock.calls(); assert.equal(calls.length, 1); assert.equal(events[0]!.outcome, "accepted");
    const card = calls[0]!.prompt.split("\n\n").filter(p => p.startsWith("{")).map(p => JSON.parse(p)).find(p => p.contractVersion === "battle-decision-card@1");
    assert.equal(card.current.phase, envelope.semantic.snapshot.phase); assert.equal(card.ownShortlist, undefined);
    assert.equal(events[0]!.advice!.actionId, adviceActionId);
  } finally { await policy.close(); }
});

test("veto wire schema bounds nested override fields while retaining the existing format-correction path", async () => {
  // Structural errors must still be corrected once. Citation/legality rejection
  // is adjudicated later, and must not weaken strict schemas in ordinary modes.
  const { envelope } = await fixture(), requestId = "veto-schema", actionId = envelope.semantic.snapshot.legalActions.find(a => a.choice && !a.disabled)!.id;
  const advice: BattleAdvice = { source: "metamon", policyId: "metamon:Kakuna:epoch34", requestId, identity: envelope.semantic.identity,
    inputResultHash: envelope.resultHash, actionId, mode: "veto" };
  for (const override of [{ cardField: "x".repeat(201), reason: "risk" }, { cardField: "current.phase", reason: "x".repeat(241) },
    { cardField: "current.phase", reason: "risk", extra: true }, { cardField: 1, reason: "risk" }, { cardField: "current.phase" }, null]) {
    const mock = await recoveryMock([{ text: JSON.stringify({ actionId, override }) }, { text: JSON.stringify({ actionId }) }]), events: OpenCodeAttemptEvent[] = [];
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { maxAttempts: 2, onAttempt: event => { events.push(event); } });
    await policy.decide({ requestId, envelope, advice }, { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, assertCurrent: async () => {} });
    assert.equal(events[0]!.failureCode, "decision_schema"); assert.equal(events[1]!.attemptKind, "format_correction");
    const calls = await mock.calls(); assert.equal(calls.length, 2);
    assert.equal(calls[1]!.prompt, calls[0]!.prompt + '\n\nThe previous reply was rejected. Return ONLY one JSON object with exactly one field, "actionId", containing an exact enabled action ID from the original supplied legal actions. Do not include reason, other fields, markdown, analysis, or Showdown commands.');
  }
  for (const boundAdvice of [undefined, { ...advice, mode: undefined }]) {
    const mock = await recoveryMock([{ text: JSON.stringify({ actionId, override: { cardField: "current.phase", reason: "risk" } }) }]);
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary);
    await assert.rejects(policy.decide({ requestId, envelope, ...(boundAdvice ? { advice: boundAdvice } : {}) },
      { deadlineAt: Date.now() + 5000, signal: new AbortController().signal }), /invalid decision schema/);
  }
});

test("unavailable veto advice preserves the ordinary OpenCode prompt and model choice", async () => {
  // With no bound default, neither the veto prompt nor override schema should
  // affect the ordinary model decision or cause another generation.
  const { envelope } = await fixture(), requestId = "veto-unavailable";
  const actionId = envelope.semantic.snapshot.legalActions.filter(a => a.choice && !a.disabled)[1]!.id;
  const mock = await recoveryMock([{ text: JSON.stringify({ actionId }) }]);
  const { MetamonAdvisedBattlePolicy } = await import("../battle-agent/metamon.js");
  const events: import("../battle-agent/metamon.js").MetamonAdviceEvent[] = [];
  const policy = new MetamonAdvisedBattlePolicy(new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, { promptVariant: "card" }), {
    id: "metamon:Kakuna:epoch34", observe: async () => {}, close: async () => {},
    decide: async () => { throw new Error("mock advisor unavailable"); }, commit: async () => { throw new Error("no proposal to commit"); }
  }, { mode: "veto", onAdvice: event => { events.push(event); } });
  try {
    const operation = { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, assertCurrent: async () => {} };
    const value = { requestId, envelope }, decision = await policy.decide(value, operation);
    assert.equal(decision.actionId, actionId); await policy.commit(value, decision, operation);
    const calls = await mock.calls(); assert.equal(calls.length, 1);
    assert.equal(calls[0]!.prompt, buildBattlePolicyPrompt(value, { promptVariant: "card" }));
    assert.equal(events[1]!.phase === "commit" && events[1]!.fallback, "unavailable");
  } finally { await policy.close(); }
});

for (const transport of ["opencode", "claude", "grok"] as const)
  for (const mode of ["suggest", "veto"] as const)
    for (const threatPreview of ["full", "hidden"] as const)
      test(`${transport} ${mode} threat preview ${threatPreview} binds the displayed Card and rejects hidden veto citations`, async () => {
        // Mock all three real transport envelopes. A stale full Card used for
        // validation would incorrectly accept the hidden-field override.
        const { envelope } = await fixture(), requestId = "threat-ablation";
        const enabled = envelope.semantic.snapshot.legalActions.filter(a => a.choice && !a.disabled && a.legality !== "disabled");
        assert.ok(enabled.length >= 2);
        const threat = envelope.semantic.localIntel.opponentThreatPreview![0]!;
        assert.ok(threat);
        threat.switchTargets = [{ ...structuredClone(threat.currentTarget), instanceId: "synthetic-reserve" }];
        const adviceActionId = enabled[0]!.id, modelActionId = enabled[1]!.id;
        const cardField = "mechanics.opponentThreatPreview.0.switchTargets.0.bands";
        const reply = JSON.stringify({ actionId: modelActionId, ...(mode === "veto" ? { override: { cardField, reason: "Incoming risk" } } : {}) });
        const mock = transport === "claude" ? await claudeMock([{ result: reply }])
          : transport === "grok" ? await grokMock([{ text: reply }]) : await recoveryMock([{ text: reply }]);
        const model = transport === "claude" ? CLAUDE_CODE_SONNET : transport === "grok" ? GROK_46 : OPENCODE_BATTLE_MODELS.luna;
        const events: OpenCodeAttemptEvent[] = [];
        const options = { promptVariant: "card" as const, threatPreview, onAttempt: (e: OpenCodeAttemptEvent) => { events.push(e); } };
        const base = new OpenCodeBattlePolicy(model, mock.binary, options);
        assert.equal(base.id, new OpenCodeBattlePolicy(model, mock.binary, { promptVariant: "card" }).id
          + (threatPreview === "hidden" ? "|threat=hidden" : ""));
        const { MetamonAdvisedBattlePolicy } = await import("../battle-agent/metamon.js");
        const adviceEvents: import("../battle-agent/metamon.js").MetamonAdviceEvent[] = [];
        const commits: string[] = [];
        const policy = new MetamonAdvisedBattlePolicy(base, {
          id: "metamon:Kakuna:epoch34", observe: async () => {}, close: async () => {},
          decide: async value => ({ requestId: value.requestId, identity: value.envelope.semantic.identity, actionId: adviceActionId }),
          commit: async (_value, decision) => { commits.push(decision.actionId); }
        }, { mode, onAdvice: e => { adviceEvents.push(e); } });
        try {
          const input = { requestId, envelope }, operation = { deadlineAt: Date.now() + 5000, signal: new AbortController().signal, assertCurrent: async () => {} };
          const result = await policy.decide(input, operation);
          const rejected = mode === "veto" && threatPreview === "hidden";
          assert.equal(result.actionId, rejected ? adviceActionId : modelActionId);
          await policy.commit(input, result, operation);
          assert.deepEqual(commits, [result.actionId]);
          const committed = adviceEvents.find(e => e.phase === "commit")!;
          assert.equal(committed.phase === "commit" && committed.override,
            mode === "suggest" ? "none" : rejected ? "rejected:invalid_card_field" : "accepted");
          const calls = await mock.calls();
          assert.equal(calls.length, 1, "citation rejection must not spend another generation");
          const prompt = transport === "opencode" ? calls[0].prompt : transport === "claude"
            ? calls[0].argv[calls[0].argv.indexOf("--") + 1] : calls[0].argv.at(-1).slice("--single=".length);
          assert.ok(events[0]!.advice);
          assert.equal(prompt, buildBattlePolicyPrompt({ ...input, advice: events[0]!.advice! }, options));
          const card = prompt.split("\n\n").filter((p: string) => p.startsWith("{")).map((p: string) => JSON.parse(p))
            .find((p: any) => p.contractVersion === "battle-decision-card@1");
          assert.equal(Object.hasOwn(card.mechanics, "opponentThreatPreview"), threatPreview === "full");
          assert.equal(events[0]!.promptContext?.threatPreview, threatPreview === "hidden" ? "hidden" : undefined);
        } finally { await policy.close(); }
      });

test("card threat simulator flag rejects invalid values and non-model players before any model can run", async () => {
  const execute = promisify(execFile), cli = new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname;
  for (const threat of ["full", "hidden"]) await assert.rejects(execute(process.execPath,
    ["--import", "tsx", cli, "--p1", "deterministic", "--p2", "random", "--card-threat", threat], { timeout: 5000 }),
    /--card-threat requires a model player/);
  for (const threat of ["other", "FULL", ""]) await assert.rejects(execute(process.execPath,
    ["--import", "tsx", cli, "--p1", "luna", "--card-threat", threat], { timeout: 5000 }), /--card-threat must be full or hidden/);
});

test("card threat simulator wiring records full by default and hidden for every model player, prompt variant and advice mode", async () => {
  // Stub the match boundary: exercise actual CLI parsing, policy construction,
  // summaries and journals without starting a game or invoking a real model.
  const ts = await import("typescript"), vm = await import("node:vm"), { EventEmitter } = await import("node:events");
  const util = await import("node:util"), cli = new URL("../tools/battle-agent-sim.ts", import.meta.url);
  const source = (await fs.readFile(cli, "utf8")).replaceAll("import.meta.url", JSON.stringify(cli.href))
    .replace("main().catch((error)", "globalThis.finished = main().catch((error)");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const identity = (await fixture()).envelope.semantic.identity;
  for (const player of ["luna", "sonnet", "claude-sonnet", "grok"] as const)
    for (const variant of ["baseline", "temporal", "card"])
      for (const threat of [undefined, "full", "hidden"] as const) for (const mode of [undefined, "suggest", "veto"] as const) {
        const output = await fs.mkdtemp(path.join(directory, "threat-sim-journal-"));
        const args = ["--p1", player, "--p2", player, "--fallback", "none", "--prompt", variant, "--output", output,
          ...(threat === undefined ? [] : ["--card-threat", threat]),
          ...(mode === undefined ? [] : ["--metamon-advice", "both", "--metamon-advice-mode", mode, "--format", "gen9uu", "--metamon-command", "mock-advisor"])];
        let stdout = "", called = 0;
        const localProcess = Object.assign(new EventEmitter(), { platform: process.platform, env: {}, exitCode: 0,
          stdout: { write(text: string) { stdout += text; } }, stderr: { write() {} } });
        class Policy { constructor(readonly model: unknown, readonly binary: string, readonly options: OpenCodeBattlePolicyOptions) {} }
        class Advised { constructor(readonly base: Policy, readonly advisor: unknown, readonly options: { mode: string }) {} }
        const modules: Record<string, unknown> = {
          "../history/metaPriorStore.js": {}, "node:fs/promises": fs, "node:os": os, "node:path": path,
          "node:util": { parseArgs(options: any) { return util.parseArgs({ ...options, args }); } }, "node:url": await import("node:url"),
          "../battle-agent/battleAgent.js": { DeterministicBattlePolicy: class {} },
          "../battle-agent/opencode.js": { BATTLE_PROMPT_VARIANTS, CLAUDE_CODE_SONNET, GROK_46, OpenCodeBattlePolicy: Policy, OPENCODE_BATTLE_MODELS },
          "../battle-agent/decisionCard.js": { HEURISTIC_PRESENTATIONS },
          "../battle-agent/metamon.js": { MetamonBattlePolicy: class {}, MetamonAdvisedBattlePolicy: Advised },
          "../battle-agent/simulator.js": { async runBattleMatch(options: any) {
            called++;
            for (const playerPolicy of [options.p1, options.p2]) {
              assert.equal(playerPolicy instanceof Advised, mode !== undefined);
              if (mode !== undefined) assert.equal(playerPolicy.options.mode, mode);
              const adapter = playerPolicy instanceof Advised ? playerPolicy.base : playerPolicy;
              assert.equal(adapter.options.threatPreview, threat ?? "full");
              await adapter.options.onAttempt({ requestId: "journal", identity, inputResultHash: "hash", generationModel: adapter.model,
                attempt: 1, attemptKind: "initial", outcome: "accepted", failureCode: null });
            }
            return { trajectory: [], replay: "", replayInputs: {}, producerSources: [], status: "completed", versions: { producer: "mock" } };
          } }
        };
        const context = vm.createContext({ exports: {}, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
          process: localProcess, AbortController, setTimeout, clearTimeout, console, URL });
        vm.runInContext(code, context); await context.finished;
        assert.equal(called, 1); assert.equal(localProcess.exitCode, 0);
        const summary = JSON.parse(stdout);
        assert.equal(summary.promptContext.threatPreview, threat ?? "full");
        assert.equal(summary.metamonAdvice?.mode, mode);
        const saved = JSON.parse(await fs.readFile(summary.paths.summary, "utf8"));
        assert.deepEqual(saved.promptContext, summary.promptContext);
        const journal = (await fs.readFile(summary.paths.modelReplies, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(journal.length, 2);
        assert.ok(journal.every(e => e.promptContext.threatPreview === (threat ?? "full") && e.promptContext.variant === variant));
      }
});

// Advance only the policy's Date/setTimeout clock, retaining production's 10s
// minimum. Imported timers/promises delay stays real for mock process polling;
// performance.now bounds that polling even when the policy clock is frozen.
async function stallState(predicate: () => Promise<boolean>, why: string) {
  const until = performance.now() + 2000;
  while (performance.now() < until) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail(why);
}
function stallSettles<T>(pending: Promise<T>): Promise<T> {
  return Promise.race([pending, delay(2000, undefined, { ref: false }).then(() => {
    throw new Error("Stall test did not settle; recovery must not depend on a real 10s wait.");
  })]);
}
async function stallFixture(t: TestContext, replies: Parameters<typeof recoveryMock>[0],
  options: OpenCodeBattlePolicyOptions & { stallDisabled?: boolean } = {}, deadlineMs = 120_000) {
  const { envelope } = await fixture(), mock = await recoveryMock(replies), controller = new AbortController();
  const events: OpenCodeAttemptEvent[] = [];
  const { stallDisabled, ...policyOptions } = options;
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
    maxAttempts: 2, ...(stallDisabled ? {} : { retryStalledGeneration: { afterMs: 10_000 } }),
    onAttempt(e) { events.push(structuredClone(e)); }, ...policyOptions
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const pending = policy.decide({ requestId: "stall", envelope }, {
    deadlineAt: Date.now() + deadlineMs, signal: controller.signal, async assertCurrent() {}
  });
  pending.catch(() => {});
  t.after(async () => {
    controller.abort();
    await stallSettles(pending).catch(() => {});
    t.mock.timers.tick(150); // Run the process-group SIGKILL grace before restoring timers.
    t.mock.timers.reset();
  });
  return { mock, policy, pending, events, controller };
}

test("stall retry requires two attempts, recorder, live checker and bounded integer timing to preserve guarded recovery", async () => {
  for (const maxAttempts of [undefined, 1] as const) assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", {
    ...(maxAttempts === undefined ? {} : { maxAttempts }), retryStalledGeneration: { afterMs: 10_000 }, onAttempt() {}
  }), /stall retry requires maxAttempts 2/);
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", {
    maxAttempts: 2, retryStalledGeneration: { afterMs: 10_000 }
  }), /recorder/);
  for (const afterMs of [NaN, Infinity, -Infinity, 0, 9999, 110_001, 10_000.5]) {
    assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", {
      maxAttempts: 2, retryStalledGeneration: { afterMs }, onAttempt() {}
    }), /integer from 10000 to 110000/);
  }
  for (const afterMs of [10_000, 110_000]) {
    const { envelope } = await fixture(), mock = await recoveryMock([{}]);
    const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, mock.binary, {
      maxAttempts: 2, retryStalledGeneration: { afterMs }, onAttempt() {}
    });
    assert.match(policy.id, new RegExp(`\\|stall=${afterMs}$`));
    await assert.rejects(policy.decide({ requestId: "no-check", envelope }, {
      deadlineAt: Date.now() + 2000, signal: new AbortController().signal
    }), /live-state checker/);
    assert.equal((await mock.calls()).length, 0);
  }
});

for (const mutate of [false, true]) test(`stall retry kills a held generation and repeats pinned input${mutate ? " despite recorder mutation" : ""} so a lost answer need not end the game`, async (t) => {
  const events: OpenCodeAttemptEvent[] = [], timing = { afterMs: 10_000 };
  const run = await stallFixture(t, [{ hold: true, holdChild: process.platform !== "win32" }, {}], {
    retryStalledGeneration: timing, onAttempt(e) {
      events.push(structuredClone(e));
      if (mutate) {
        Object.assign(e, { outcome: "accepted", failureCode: "deadline", attemptKind: "format_correction" });
        e.identity.rqid = 0; e.generationModel.id = "PRIVATE_MUTATION";
        timing.afterMs = 110_000;
      }
    }
  });
  await run.mock.waitFor(1);
  await stallState(async () => (await run.mock.pids().catch(() => [])).length > 0, "held mock must publish its PID");
  const pids = await run.mock.pids();
  t.mock.timers.tick(9999);
  assert.equal(events.length, 0, "the soft window must run in full");
  t.mock.timers.tick(1);
  const decision = await stallSettles(run.pending);
  assert.equal(decision.requestId, "stall");
  assert.deepEqual(events.map(e => [e.attemptKind, e.outcome, e.failureCode]), [
    ["initial", "failed", "stalled"], ["stall_retry", "accepted", null]
  ]);
  assert.deepEqual((await run.mock.calls())[1], (await run.mock.calls())[0], "retry must use identical pinned input and model without correction");
  assert.equal((await run.mock.calls()).length, 2);
  assert.equal((await run.mock.catalogCalls()).length, 1, "same-model retry reuses readiness");
  assert.match(run.policy.id, /\|stall=10000$/);
  t.mock.timers.tick(150);
  await stallState(async () => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }),
    "the stalled process group, including a descendant ignoring SIGTERM, must die");
});

test("stall retry default off preserves a held generation's real deadline and one call", async (t) => {
  // Opt-in recovery must not change existing cohort behavior.
  const run = await stallFixture(t, [{ hold: true }, {}], { stallDisabled: true });
  await run.mock.waitFor(1);
  t.mock.timers.tick(10_000);
  assert.equal(run.events.length, 0);
  t.mock.timers.tick(110_000);
  await assert.rejects(stallSettles(run.pending), /timeout|deadline/);
  assert.deepEqual(run.events.map(e => [e.outcome, e.failureCode]), [["failed", "deadline"]]);
  assert.equal((await run.mock.calls()).length, 1);
  assert.doesNotMatch(run.policy.id, /\|stall=/);
});

test("stall retry leaves a reply before the soft limit untouched to avoid duplicate successful work", async (t) => {
  const run = await stallFixture(t, [{ hold: true }, {}]);
  await run.mock.waitFor(1);
  t.mock.timers.tick(9999);
  await run.mock.release();
  await stallSettles(run.pending);
  assert.deepEqual(run.events.map(e => [e.attemptKind, e.outcome]), [["initial", "accepted"]]);
  assert.equal((await run.mock.calls()).length, 1);
});

test("stall retry shares the correction allowance: a format correction cannot restart a later held reply", async (t) => {
  const run = await stallFixture(t, [{ text: "invalid" }, { hold: true }, {}]);
  await run.mock.waitFor(2);
  t.mock.timers.tick(10_000);
  assert.equal(run.events.length, 1, "consumed allowance disables the soft limit");
  t.mock.timers.tick(110_000);
  await assert.rejects(stallSettles(run.pending), /timeout|deadline/);
  assert.deepEqual(run.events.map(e => [e.attemptKind, e.outcome, e.failureCode]), [
    ["initial", "rejected", "decision_json"], ["format_correction", "failed", "deadline"]
  ]);
  assert.equal((await run.mock.calls()).length, 2);
});

test("stall retry spends the correction allowance so a rejected retry fails without a third generation", async (t) => {
  const run = await stallFixture(t, [{ hold: true }, { text: "invalid" }, {}]);
  await run.mock.waitFor(1);
  t.mock.timers.tick(10_000);
  await assert.rejects(stallSettles(run.pending), /invalid decision JSON/);
  assert.deepEqual(run.events.map(e => [e.attemptKind, e.outcome, e.failureCode]), [
    ["initial", "failed", "stalled"], ["stall_retry", "rejected", "decision_json"]
  ]);
  assert.equal((await run.mock.calls()).length, 2);
});

test("stall retry leaves its held retry until the original deadline because the shared allowance is exhausted", async (t) => {
  const run = await stallFixture(t, [{ hold: true }, { hold: true }, {}]);
  await run.mock.waitFor(1);
  t.mock.timers.tick(10_000);
  await run.mock.waitFor(2);
  t.mock.timers.tick(10_000);
  assert.equal(run.events.length, 1);
  t.mock.timers.tick(100_000);
  await assert.rejects(stallSettles(run.pending), /timeout|deadline/);
  assert.deepEqual(run.events.map(e => [e.attemptKind, e.failureCode]), [["initial", "stalled"], ["stall_retry", "deadline"]]);
  assert.equal((await run.mock.calls()).length, 2);
});

test("stall retry failure cannot hop to a configured overload model because recovery must stay on the same model", async (t) => {
  const run = await stallFixture(t, [{ hold: true }, { stdout: declaredOverload, exitCode: 1 }, {}], {
    overloadFallback: OPENCODE_BATTLE_MODELS.sonnet
  });
  await run.mock.waitFor(1);
  t.mock.timers.tick(10_000);
  await assert.rejects(stallSettles(run.pending), /generation failed/);
  assert.deepEqual(run.events.map(e => e.attemptKind), ["initial", "stall_retry"]);
  assert.ok((await run.mock.calls()).every(call => JSON.stringify(call.model) === JSON.stringify(OPENCODE_BATTLE_MODELS.luna)));
  assert.equal((await run.mock.calls()).length, 2);
});

for (const deadlineMs of [5000, 10_000]) test(`stall retry clips its soft limit to the real ${deadlineMs}ms deadline so expiry never grants more time`, async (t) => {
  const run = await stallFixture(t, [{ hold: true }, {}], {}, deadlineMs);
  await run.mock.waitFor(1);
  t.mock.timers.tick(deadlineMs);
  await assert.rejects(stallSettles(run.pending), /timeout|deadline/);
  assert.deepEqual(run.events.map(e => [e.attemptKind, e.failureCode]), [["initial", "deadline"]]);
  assert.equal((await run.mock.calls()).length, 1);
});

test("stall retry cancellation during the soft window starts no retry so an abandoned decision stays abandoned", async (t) => {
  const run = await stallFixture(t, [{ hold: true }, {}]);
  await run.mock.waitFor(1);
  t.mock.timers.tick(5000);
  run.controller.abort(new Error("cancelled"));
  await assert.rejects(stallSettles(run.pending), /cancelled/);
  assert.deepEqual(run.events.map(e => [e.attemptKind, e.failureCode]), [["initial", "cancelled"]]);
  assert.equal((await run.mock.calls()).length, 1);
  assert.equal(getEventListeners(run.controller.signal, "abort").length, 0);
});

for (const stop of ["cancel", "deadline"] as const) test(`stall retry ${stop} in the recorder prevents another call because recording cannot revive an expired decision`, async (t) => {
  const events: OpenCodeAttemptEvent[] = [];
  let run: Awaited<ReturnType<typeof stallFixture>>;
  run = await stallFixture(t, [{ hold: true }, {}], { onAttempt(e) {
    events.push(structuredClone(e));
    if (stop === "cancel") run.controller.abort(new Error("cancelled"));
    else t.mock.timers.tick(110_000);
  } });
  await run.mock.waitFor(1);
  t.mock.timers.tick(10_000);
  await assert.rejects(stallSettles(run.pending), /cancelled|deadline/);
  assert.deepEqual(events.map(e => [e.attemptKind, e.failureCode]), [["initial", "stalled"]]);
  assert.equal((await run.mock.calls()).length, 1);
});

test("stall retry cannot be forged by recorder mutation because event objects are observation only", async (t) => {
  const run = await stallFixture(t, [{ stdout: "invalid transport JSON" }, {}], { onAttempt(e) {
    Object.assign(e, { outcome: "failed", failureCode: "stalled", attemptKind: "initial" });
  } });
  await assert.rejects(stallSettles(run.pending), /invalid transport JSON/);
  assert.equal((await run.mock.calls()).length, 1);
});

for (const transport of ["claude", "grok"] as const) test(`stall retry applies to the ${transport} mock transport so recovery is independent of the CLI harness`, async (t) => {
  const { envelope } = await fixture();
  const mock = await (transport === "claude" ? claudeMock([{ hold: true }, {}]) : grokMock([{ hold: true }, {}]));
  const controller = new AbortController(), events: OpenCodeAttemptEvent[] = [];
  const policy = new OpenCodeBattlePolicy(transport === "claude" ? CLAUDE_CODE_SONNET : GROK_46, mock.binary, {
    maxAttempts: 2, retryStalledGeneration: { afterMs: 10_000 }, onAttempt(e) { events.push(structuredClone(e)); }
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const pending = policy.decide({ requestId: "transport-stall", envelope }, {
    deadlineAt: Date.now() + 120_000, signal: controller.signal, async assertCurrent() {}
  });
  pending.catch(() => {});
  t.after(async () => { controller.abort(); await stallSettles(pending).catch(() => {}); t.mock.timers.tick(150); t.mock.timers.reset(); });
  await stallState(async () => (await mock.calls().catch(() => [])).length === 1, "mock CLI generation must start");
  t.mock.timers.tick(10_000);
  await stallSettles(pending);
  assert.deepEqual(events.map(e => [e.attemptKind, e.outcome, e.failureCode]), [["initial", "failed", "stalled"], ["stall_retry", "accepted", null]]);
  const calls = await mock.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].argv, calls[0].argv, "CLI retry must repeat the pinned prompt and model");
});

test("stall retry simulator flag rejects incompatible configurations and invalid times before policy calls", async () => {
  // Invalid opt-ins must fail before any CLI/model can run.
  const execute = promisify(execFile), cli = new URL("../tools/battle-agent-sim.ts", import.meta.url).pathname;
  for (const args of [["--p1", "deterministic", "--p2", "deterministic"], ["--p1", "luna", "--model-attempts", "1"],
    ["--p1", "claude-sonnet", "--model-attempts", "1"], ["--p1", "grok", "--model-attempts", "1"]]) {
    await assert.rejects(execute(process.execPath, ["--import", "tsx", cli, ...args, "--retry-stalled-ms", "10000"], { timeout: 5000 }),
      /requires an OpenCode player and --model-attempts 2/);
  }
  for (const value of ["NaN", "Infinity", "9999", "110001", "10000.5"]) {
    await assert.rejects(execute(process.execPath, ["--import", "tsx", cli, "--p1", "luna", "--retry-stalled-ms", value], { timeout: 5000 }),
      /must be an integer from 10000 to 110000/);
  }
});

test("stall retry simulator passes the option to every model player and separates retry counts from recovery counts", async () => {
  // Stub the match, as in the overload journal test: inspect real CLI wiring
  // and summaries without any live game, model, or production timing bypass.
  const ts = await import("typescript"), vm = await import("node:vm"), { EventEmitter } = await import("node:events");
  const util = await import("node:util"), cli = new URL("../tools/battle-agent-sim.ts", import.meta.url);
  const source = (await fs.readFile(cli, "utf8")).replaceAll("import.meta.url", JSON.stringify(cli.href))
    .replace("main().catch((error)", "globalThis.finished = main().catch((error)");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const identity = (await fixture()).envelope.semantic.identity;
  for (const player of ["luna", "sonnet", "claude-sonnet", "grok"] as const) for (const enabled of [false, true]) {
    const output = await fs.mkdtemp(path.join(directory, "stall-sim-journal-"));
    const args = ["--p1", player, "--p2", player, "--fallback", "none", "--output", output, ...(enabled ? ["--retry-stalled-ms", "10000"] : [])];
    let stdout = "", called = 0;
    const localProcess = Object.assign(new EventEmitter(), { platform: process.platform, env: {}, exitCode: 0,
      stdout: { write(text: string) { stdout += text; } }, stderr: { write() {} } });
    class Policy { constructor(readonly model: unknown, readonly binary: string, readonly options: OpenCodeBattlePolicyOptions) {} }
    const modules: Record<string, unknown> = {
      "../history/metaPriorStore.js": {}, "node:fs/promises": fs, "node:os": os, "node:path": path,
      "node:util": { parseArgs(options: any) { return util.parseArgs({ ...options, args }); } }, "node:url": await import("node:url"),
      "../battle-agent/battleAgent.js": { DeterministicBattlePolicy: class {} },
      "../battle-agent/opencode.js": { BATTLE_PROMPT_VARIANTS, CLAUDE_CODE_SONNET, GROK_46, OpenCodeBattlePolicy: Policy, OPENCODE_BATTLE_MODELS },
      "../battle-agent/decisionCard.js": { HEURISTIC_PRESENTATIONS }, "../battle-agent/metamon.js": {},
      "../battle-agent/simulator.js": { async runBattleMatch(options: any) {
        called++;
        for (const [i, adapter] of [options.p1, options.p2].entries()) {
          assert.deepEqual(JSON.parse(JSON.stringify(adapter.options.retryStalledGeneration ?? null)), enabled ? { afterMs: 10_000 } : null);
          const base = { requestId: `journal-${i}`, identity, inputResultHash: "hash", generationModel: adapter.model };
          if (enabled) await adapter.options.onAttempt({ ...base, attempt: 1, attemptKind: "initial", outcome: "failed", failureCode: "stalled" });
          await adapter.options.onAttempt({ ...base, attempt: enabled ? 2 : 1, attemptKind: enabled ? "stall_retry" : "initial",
            ...(i === 0 ? { outcome: "accepted", failureCode: null } : { outcome: "rejected", failureCode: "decision_json" }) });
        }
        return { trajectory: [], replay: "", replayInputs: {}, producerSources: [], status: "completed", versions: { producer: "mock" } };
      } }
    };
    const context = vm.createContext({ exports: {}, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
      process: localProcess, AbortController, setTimeout, clearTimeout, console, URL });
    vm.runInContext(code, context); await context.finished;
    assert.equal(called, 1); assert.equal(localProcess.exitCode, 0);
    const summary = JSON.parse(stdout), replies = summary.modelReplies;
    assert.equal(replies.stallRetryEnabledMs, enabled ? 10_000 : null);
    assert.equal(replies.stallRetries, enabled ? 2 : 0);
    assert.equal(replies.stallRecovered, enabled ? 1 : 0, "only accepted stall retries count as recovered");
    assert.equal(replies.recovered, 0); assert.equal(replies.capacityHops, 0);
    const journal = (await fs.readFile(summary.paths.modelReplies, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(journal.every(e => e.model === player && e.configuredModel === player));
    assert.equal(journal.filter(e => e.failureCode === "stalled").length, enabled ? 2 : 0);
  }
});
