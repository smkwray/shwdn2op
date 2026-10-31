import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DecisionEngine } from "../state/decisionEngine.js";
import { evaluateDecision } from "../state/decisionEnvelope.js";
import { createEphemeralIntelEvaluationContext } from "../history/opponentIntelStore.js";
import { createStrategicLedger, inspectStrategicLedger, STRATEGIC_LEDGER_MAX_BYTES } from "../battle-agent/strategicLedger.js";
import { buildBattlePolicyPrompt, OpenCodeBattlePolicy, OPENCODE_BATTLE_MODELS, refreshBattlePlan } from "../battle-agent/opencode.js";
import type { BattlePolicyInput } from "../battle-agent/battleAgent.js";

const base = async () => {
  const data = await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8");
  const roomId = data.match(/^>([^\n]+)/)![1]!, engine = new DecisionEngine(), sessionId = "shadow-test";
  const current = await engine.ingest({ roomId, sessionId, observationId: "initial", sequence: 1, source: "protocol", data });
  return { engine, sessionId, input: { requestId: "plan-correlation", envelope: await evaluateDecision(engine, sessionId, current.identity!, await createEphemeralIntelEvaluationContext()) } };
};
const fixture = base();
const plan = { phase: "midgame", winConditions: [], mustPreserve: [{ pokemonOrRole: "Own reserve", reason: "Policy hypothesis, not a mechanics fact", until: "Reconsider with new evidence" }],
  opponentEndgames: [], hypotheses: [], replanTriggers: ["new request"], notes: ["Visible evidence only"] };
async function input() { return structuredClone((await fixture).input); }
async function mock(response: { text?: string; stdout?: string; exitCode?: number; hold?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shwdn2op-shadow-plan-")), binary = path.join(dir, "opencode"), callsFile = path.join(dir, "calls.jsonl");
  await fs.writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[3]==='server.info') process.stdout.write(JSON.stringify({version:'2.0.20'}));
else if(process.argv[3]==='config.get') process.stdout.write(JSON.stringify([{type:'directory',path:'/mock-config'}]));
else if(process.argv[3]==='model.list') process.stdout.write(JSON.stringify({location:{directory:'/mock-config'},data:${JSON.stringify(Object.values(OPENCODE_BATTLE_MODELS).map((m) => ({ ...m, enabled: true, variants: [{ id: m.variant }] })))}}));
else {fs.appendFileSync(${JSON.stringify(callsFile)},process.argv[5]+'\\n');process.stderr.write('PRIVATE_TRANSPORT');
${response.hold ? "setInterval(()=>{},1000);" : `process.stdout.write(${JSON.stringify(response.stdout ?? JSON.stringify({ data: { text: response.text ?? JSON.stringify(plan) } }))});process.exitCode=${response.exitCode ?? 0};`}}
`, { mode: 0o700 });
  const calls = async (): Promise<Array<{ model: unknown; prompt: string }>> => (await fs.readFile(callsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { binary, calls, async started() { const until = Date.now() + 2000; while (Date.now() < until && !(await calls()).length) await delay(5); assert.equal((await calls()).length, 1); } };
}

test("strategic ledger is detached exact-input data with host-only lifetime and correlation-independent binding", async () => {
  const original = await input(), content = structuredClone(plan), ledger = createStrategicLedger(original, content, 1000);
  content.notes[0] = "changed"; original.envelope.semantic.snapshot.yourSide.name = "changed";
  const current = await input(); current.requestId = "independent-action-correlation";
  const inspected = inspectStrategicLedger(current, ledger, 1001);
  assert.equal(inspected.status, "valid");
  if (inspected.status === "valid") { inspected.plan.notes[0] = "changed"; assert.notEqual(ledger.plan.notes[0], "changed"); }
  assert.equal(inspectStrategicLedger(current, ledger, ledger.expiresAt).status, "expired");
  assert.equal(inspectStrategicLedger(current, null, 1001).status, "missing");
  assert.equal(inspectStrategicLedger(current, { ...ledger, expiresAt: Infinity }, 1001).status, "invalid");
  assert.equal(inspectStrategicLedger(current, { ...ledger, expiresAt: ledger.generatedAt + 120001 }, 1001).status, "invalid");
  assert.equal(inspectStrategicLedger(current, { ...ledger, generatedAt: 2000 }, 1001).status, "expired");
});

test("strategic ledger rejects every changed canonical binding and forged executable fields", async () => {
  const original = await input(), ledger = createStrategicLedger(original, plan, 1000);
  for (const change of [
    (i: BattlePolicyInput) => { i.envelope.semantic.identity.rqid = 99; },
    (i: BattlePolicyInput) => { i.envelope.semantic.identity.stateRevision++; },
    (i: BattlePolicyInput) => { i.envelope.semantic.identity.snapshotHash = "sha256:" + "0".repeat(64); },
    (i: BattlePolicyInput) => { i.envelope.semantic.identity.legalActionSetHash = "sha256:" + "0".repeat(64); },
    (i: BattlePolicyInput) => { i.envelope.semantic.identity.requestKind = "forced_switch"; },
    (i: BattlePolicyInput) => { i.envelope.resultHash = "changed"; },
    (i: BattlePolicyInput) => { i.envelope.semantic.historyRevision = "changed"; },
    (i: BattlePolicyInput) => { i.envelope.semantic.engineVersion = "changed"; },
    (i: BattlePolicyInput) => { i.envelope.semantic.snapshot.yourSide.slot = "p2"; },
    (i: BattlePolicyInput) => { i.envelope.semantic.snapshot.roomId = "different-room"; }
  ]) { const current = structuredClone(original); change(current); assert.equal(inspectStrategicLedger(current, ledger, 1001).status, "mismatch"); }
  for (const extra of [{ binding: {} }, { actionId: "move:1" }, { expiresAt: 999999 }, { version: "forged" }]) assert.throws(() => createStrategicLedger(original, { ...plan, ...extra }, 1000), /Invalid or oversized/);
  assert.equal(inspectStrategicLedger(original, { ...ledger, actionId: "move:1" }, 1001).status, "invalid");
  assert.throws(() => createStrategicLedger(original, { ...plan, notes: ["é".repeat(STRATEGIC_LEDGER_MAX_BYTES)] }), /Invalid or oversized/);
  const many = { ...plan, winConditions: Array.from({ length: 2 }, () => ({ route: "é".repeat(240), enablers: ["é".repeat(240)], blockers: ["é".repeat(240)], evidence: ["é".repeat(240)], confidence: "low", falsifiers: ["é".repeat(240)] })) };
  assert.throws(() => createStrategicLedger(original, many), /Invalid or oversized/, "UTF8 aggregate bound applies even when individual fields fit");
});

test("prompt variants keep temporal default and omit invalid ledgers from card context", async () => {
  const current = await input();
  assert.equal(buildBattlePolicyPrompt(current), buildBattlePolicyPrompt(current, { promptVariant: "temporal", heuristicPresentation: "hidden" }));
  const baseline = buildBattlePolicyPrompt(current, { promptVariant: "baseline" });
  const data = baseline.split("\n\n").filter((p) => p.startsWith("{")).map((p) => JSON.parse(p)).find((p) => p.battle);
  assert.equal("recentLog" in data.battle, false); assert.equal("pendingAttacks" in data.battle, false);
  assert.doesNotMatch(baseline, /Current canonical state and enabled legal actions take precedence/);
  const invalid = buildBattlePolicyPrompt(current, { promptVariant: "card-ledger", strategicLedger: { PRIVATE_FORGED: "SECRET_LEDGER" } });
  assert.doesNotMatch(invalid, /SECRET_LEDGER|PRIVATE_FORGED/); assert.match(invalid, /invalid/);
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", { promptVariant: "invalid" as "card" }), /prompt variant/);
  assert.throws(() => new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", { heuristicPresentation: "invalid" as "raw" }), /heuristic/);
  const ordinary = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna);
  assert.equal(ordinary.id, "opencode:openai/gpt-6-luna#xhigh");
  assert.match(new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, "unused", { promptVariant: "card", heuristicPresentation: "raw" }).id, /\|prompt=card:raw$/);
});

test("shadow planner uses one requested-model generation and immutable input despite callback mutation", async () => {
  const current = await input(), before = structuredClone(current), model = { ...OPENCODE_BATTLE_MODELS.luna }, cli = await mock(); let checks = 0;
  const result = await refreshBattlePlan(current, model, cli.binary, { deadlineAt: Date.now() + 3000, signal: new AbortController().signal, async assertCurrent() {
    checks++; current.envelope.resultHash = "mutated"; current.envelope.semantic.snapshot.yourSide.name = "MUTATED_PRIVATE"; model.id = "MUTATED_MODEL";
  } });
  assert.equal(checks, 3); assert.deepEqual(result.model, OPENCODE_BATTLE_MODELS.luna);
  assert.equal(inspectStrategicLedger(before, result.ledger).status, "valid");
  const calls = await cli.calls(); assert.equal(calls.length, 1); assert.deepEqual(calls[0]!.model, OPENCODE_BATTLE_MODELS.luna);
  assert.doesNotMatch(calls[0]!.prompt, /MUTATED_PRIVATE|MUTATED_MODEL/);
  assert.equal("actionId" in result, false); assert.equal("choice" in result, false);
});

for (const mode of ["exit", "transport", "schema", "json", "stale", "hash", "cancel", "deadline"] as const) test(`shadow planner ${mode} fails closed without action correction or fallback`, async () => {
  const current = await input(), controller = new AbortController();
  const cli = await mock(mode === "exit" ? { stdout: JSON.stringify({ _tag: "ServiceUnavailableError", service: "openai", message: "server_is_overloaded: PRIVATE" }), exitCode: 1 }
    : mode === "transport" ? { stdout: "PRIVATE_TRANSPORT" } : mode === "schema" ? { text: JSON.stringify({ ...plan, actionId: "PRIVATE_ACTION" }) }
    : mode === "json" ? { text: "PRIVATE_REPLY" } : { hold: mode === "cancel" || mode === "deadline" });
  if (mode === "hash") current.envelope.resultHash = "invalid";
  let checks = 0;
  const pending = refreshBattlePlan(current, OPENCODE_BATTLE_MODELS.luna, cli.binary, { signal: controller.signal, deadlineAt: Date.now() + (mode === "deadline" ? 600 : 3000), async assertCurrent() {
    if (mode === "stale" && ++checks === 3) throw new Error("PRIVATE_STALE");
  } });
  const rejected = assert.rejects(pending, (error: Error) => { assert.match(error.message, /^OpenCode plan refresh failed \([a-z_]+\)\.$/); assert.doesNotMatch(String(error.stack), /PRIVATE_/); return true; });
  if (mode === "cancel") { await cli.started(); controller.abort(); }
  await rejected; await delay(20);
  assert.equal((await cli.calls()).length, mode === "hash" ? 0 : 1);
});


test("ledger advice is omitted when it cannot remain valid for the whole action budget", async () => {
  const current = await input(), content = { ...plan, notes: ["EXPIRING_PLAN_CANARY"] };
  const ledger = createStrategicLedger(current, content, Date.now() - 119_000);
  const selected = current.envelope.semantic.snapshot.legalActions.find((action) => !action.disabled && action.choice)!;
  const cli = await mock({ text: JSON.stringify({ actionId: selected.id }) });
  const events: any[] = [];
  const policy = new OpenCodeBattlePolicy(OPENCODE_BATTLE_MODELS.luna, cli.binary, { promptVariant: "card-ledger", strategicLedger: ledger, onAttempt: (event) => { events.push(event); } });
  await policy.decide(current, { deadlineAt: Date.now() + 3000, signal: new AbortController().signal, async assertCurrent() {} });
  const requests = await cli.calls(); assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0]!.prompt, /EXPIRING_PLAN_CANARY/);
  assert.equal(events[0].promptContext.ledgerStatus, "expired");
});
