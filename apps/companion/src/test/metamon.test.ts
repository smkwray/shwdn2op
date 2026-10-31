import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Battle, Teams, TeamValidator, extractChannelMessages } from "../battle-agent/nativeSimulator.js";
import { MetamonAdvisedBattlePolicy, MetamonBattlePolicy, mapMetamonChoice, mapMetamonLead, trappedSwitchRejection, TRAPPED_SWITCH_ERROR, type MetamonAdviceEvent, type MetamonObservationContext } from "../battle-agent/metamon.js";
import type { BattleAdviceMode, BattlePolicy, BattlePolicyInput } from "../battle-agent/battleAgent.js";
import { hasCardField } from "../battle-agent/decisionCard.js";
import type { LegalAction } from "../types.js";

const workerPath = fileURLToPath(new URL("../../../../scripts/metamon-worker.py", import.meta.url));

test("runtime bootstrap rejects project and Syncthing placement before downloads", { skip: process.platform === "win32" }, async () => {
  const code = String.raw`
import contextlib, importlib.util, io, json, pathlib, sys, tempfile
script = pathlib.Path(sys.argv[1]); project = script.parent.parent
spec = importlib.util.spec_from_file_location('runtime_storage_test', script)
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
calls = []
w.bootstrap = lambda root, venv: calls.append('bootstrap')
w.smoke = lambda root: calls.append('smoke')
with tempfile.TemporaryDirectory() as directory:
    temp = pathlib.Path(directory); external = temp / 'local'; synced = temp / 'sync'
    (synced / '.stfolder').mkdir(parents=True)
    link = temp / 'linked-sync'; link.symlink_to(synced, target_is_directory=True)
    cases = [(project / 'models', external / 'venv'), (external, project / '.venv'),
             (synced / 'models', external / 'venv'), (external, synced / 'env'),
             (pathlib.Path('relative'), external / 'venv'), (link / 'models', external / 'venv')]
    for root, venv in cases:
        sys.argv = [str(script), 'bootstrap', '--root', str(root), '--venv', str(venv)]
        with contextlib.redirect_stderr(io.StringIO()):
            try: w.main()
            except SystemExit as error: assert error.code == 2
            else: raise AssertionError('unsafe placement reached bootstrap')
        assert calls == []
    for command in ['bootstrap', 'smoke']:
        sys.argv = [str(script), command, '--root', str(external), '--venv', str(temp / 'env')]
        w.main()
    assert calls == ['bootstrap', 'smoke']
    assert not external.exists(), 'placement preflight must not create model directories'
print(json.dumps({'rejected': len(cases), 'safeEntrypoints': calls, 'downloads': 0}))
`;
  const helper = fileURLToPath(new URL("../../../../scripts/metamon-runtime.py", import.meta.url));
  const result = await promisify(execFile)(process.env.METAMON_PARSE_PYTHON ?? "python3", ["-B", "-c", code, helper], { timeout: 5000 });
  assert.deepEqual(JSON.parse(result.stdout), { rejected: 6, safeEntrypoints: ["bootstrap", "smoke"], downloads: 0 });
});

const hash = `sha256:${"a".repeat(64)}`;
const context = (format = "gen9ou"): MetamonObservationContext => ({ roomId: `battle-${format}-offline`, side: "p1", format, sequence: 1,
  identity: { roomId: `battle-${format}-offline`, rqid: 1, snapshotHash: hash, legalActionSetHash: hash, stateRevision: 1, requestKind: "move" } });
const actions: LegalAction[] = [
  { id: "base", kind: "move", label: "Bullet Punch", moveSlot: 2, choice: "move 2", terastallize: false },
  { id: "tera", kind: "move", label: "Bullet Punch + Tera", moveSlot: 2, choice: "move 2 terastallize", terastallize: true },
  { id: "switch", kind: "switch", label: "Corviknight", targetSlot: 6, choice: "switch 6" },
  { id: "team", kind: "team", label: "preview", teamSpec: [2, 1, 3, 4, 5, 6], choice: "team 213456" }
];
const input = (ctx = context()): BattlePolicyInput => ({ requestId: "attempt-1", envelope: {
  resultHash: hash, semantic: { identity: ctx.identity, snapshot: { format: ctx.format, phase: "move", yourSide: { slot: ctx.side }, legalActions: actions } }
} } as unknown as BattlePolicyInput);
const options = (ms = 2000) => ({ deadlineAt: Date.now() + ms, signal: new AbortController().signal });
const request = (side = "p1") => `|request|${JSON.stringify({ rqid: 1, side: { id: side } })}`;

// The transport mock is explicitly not Metamon inference. It only echoes the
// protocol and manufactures bad replies to exercise the fail-closed boundary.
const mockWorker = String.raw`
const readline = require('node:readline');
const mode = process.env.METAMON_TEST_MODE;
let request, pending=false;
if (mode === 'tree') {
  process.on('SIGTERM', () => {});
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'ignore'});
  require('node:fs').writeFileSync(process.env.METAMON_TEST_PIDS, JSON.stringify([process.pid,child.pid]));
}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(mode==='hang'||mode==='tree') return;
 if(mode==='noise'){process.stdout.write('upstream log\n');return;}
 if(mode==='huge'){process.stdout.write('x'.repeat(300000));return;}
 if(mode==='exit'){process.exit(2);return;}
 const r={version:m.version,id:m.id,ok:true};
 if(m.op==='observe' && pending){r.ok=false;r.error='identity';process.stdout.write(JSON.stringify(r)+'\n');return;}
 if(m.op==='observe') {
  r.context=m.context;
  for(const line of m.data.split('\n')) if(line.startsWith('|request|')) request=JSON.parse(line.slice(9));
 }
 else {
  r.binding={requestId:m.requestId,identity:m.identity,resultHash:m.resultHash,sequence:m.sequence};
  r.choice={kind:'move',moveSlot:2,terastallize:false};
  if(mode==='cli' && request.teamPreview)r.choice={kind:'team',team:[1,2,3,4,5,6]};
  if(mode==='stale')r.binding.identity.stateRevision++;
  if(mode==='hash')r.binding.resultHash='sha256:'+'b'.repeat(64);
  if(mode==='sequence')r.binding.sequence++;
  if(mode==='request')r.binding.requestId='other';
  if(mode==='illegal')r.choice.moveSlot=3;
  if(mode==='index')r.choice={actionIndex:0};
  if(m.op==='propose'&&mode.startsWith('probs'))r.actionProbabilities=mode==='probs'?{'move 2':0.7,'move 2 terastallize':0.2,'switch 6':0.1}
   :mode==='probs_sum'?{'move 2':0.7,'switch 6':0.1}:mode==='probs_token'?{'move 2':0.9,'move 3':0.1}
   :mode==='probs_zero'?{'move 2':0,'switch 6':1}:{'move 2':'0.9'};
 }
 if(m.op==='propose')pending=true;
 if(m.op==='commit'){r.choice=m.choice;pending=false;}
 if(process.env.METAMON_TEST_RPC_LOG)require('node:fs').appendFileSync(process.env.METAMON_TEST_RPC_LOG,JSON.stringify(m)+'\n');
 if(mode==='wrong_id')r.id++;
 process.stdout.write(JSON.stringify(r)+'\n');
});`;
const policy = (mode = "", env: NodeJS.ProcessEnv = {}) => new MetamonBattlePolicy({ command: process.execPath, args: ["-e", mockWorker],
  env: { METAMON_TEST_MODE: mode, ...env } });

const currentOptions = (ms = 2000) => ({ ...options(ms), assertCurrent: async () => {} });
function advisorFixture() {
  const events: MetamonAdviceEvent[] = [], received: BattlePolicyInput[] = [], commits: string[] = [];
  let proposals = 0, closes = 0;
  const advisor = {
    id: "metamon:Kakuna:epoch34" as const,
    observe: async () => {},
    decide: async (value: BattlePolicyInput) => { proposals++; return { requestId: value.requestId, identity: value.envelope.semantic.identity, actionId: "base" }; },
    commit: async (_value: BattlePolicyInput, decision: { actionId: string }) => { commits.push(decision.actionId); },
    close: async () => { closes++; }
  };
  const model: BattlePolicy = { id: "scripted-model", decide: async (value) => {
    received.push(structuredClone(value));
    return { requestId: value.requestId, identity: value.envelope.semantic.identity, actionId: "switch" };
  } };
  const make = (waitMs = 5000, mode: BattleAdviceMode = "suggest") => new MetamonAdvisedBattlePolicy(model, advisor, { onAdvice: (event) => { events.push(event); }, waitMs, mode });
  return { advisor, model, events, received, commits, make, counts: () => ({ proposals, closes }) };
}

// These cases distinguish deterministic veto routing from the old behavior of
// executing every model choice. Card contents here stand in for adapter output;
// battleAgent.test.ts separately checks the exact rendered Card round-trip.
for (const c of [
  { name: "accepting the default executes it", actionId: "base", status: "none", expected: "base" },
  { name: "a cited enabled override executes the model action", actionId: "switch", field: "current.phase", status: "accepted", expected: "switch" },
  { name: "an invalid path executes the default", actionId: "switch", field: "current.absent", status: "rejected:invalid_card_field", expected: "base" },
  { name: "a missing override executes the default", actionId: "switch", status: "rejected:missing_override", expected: "base" },
  { name: "an illegal action executes the default", actionId: "absent", field: "current.phase", status: "rejected:illegal_action", expected: "base" },
  { name: "a disabled action executes the default", actionId: "switch", field: "current.phase", disabled: true, status: "rejected:illegal_action", expected: "base" },
  { name: "an invalid citation takes precedence over an illegal action", actionId: "absent", field: "absent", status: "rejected:invalid_card_field", expected: "base" }
]) test(`veto: ${c.name}, preserving the RL default unless the contract permits an override`, async () => {
  const f = advisorFixture(), value = input();
  value.envelope.semantic.snapshot.legalActions = structuredClone(actions);
  if ("disabled" in c) value.envelope.semantic.snapshot.legalActions.find(a => a.id === "switch")!.legality = "disabled";
  let calls = 0;
  f.model.decide = async (received) => {
    calls++;
    assert.equal(received.advice?.mode, "veto");
    return { requestId: received.requestId, identity: received.envelope.semantic.identity, actionId: c.actionId,
      veto: { card: { current: { phase: "move" } }, ...("field" in c ? { override: { cardField: c.field!, reason: "A cited risk" } } : {}) } };
  };
  const p = f.make(5000, "veto");
  try {
    assert.match(p.id, /\|advice=veto$/);
    const decision = await p.decide(value, currentOptions());
    assert.equal(decision.actionId, c.expected); assert.equal("veto" in decision, false);
    await p.commit(value, decision, currentOptions());
    assert.deepEqual(f.commits, [c.expected], "the recurrent advisor must learn the executed action, never an unexecuted model proposal");
    const event = f.events[1]!; assert.equal(event.phase, "commit");
    if (event.phase !== "commit") throw new Error("Missing commit");
    assert.equal(event.mode, "veto"); assert.equal(event.adviceActionId, "base");
    assert.equal(event.modelActionId, c.actionId); assert.equal(event.executedActionId, c.expected);
    assert.equal(event.override, c.status); assert.equal(event.cardField, "field" in c ? c.field : null);
    assert.equal(calls, 1, "contract rejection must not spend another model call");
  } finally { await p.close(); }
});

test("veto Card paths use only fields in the serialized JSON, preventing prototype or omitted-field citations", () => {
  const card = JSON.parse(JSON.stringify({ current: { phase: "move", omitted: undefined, unknown: null }, rows: [{ damage: 42 }] }));
  for (const field of ["current.phase", "current.unknown", "rows.0.damage", "rows.0", "rows"]) assert.equal(hasCardField(card, field), true, field);
  for (const field of ["", ".current", "current.", "current..phase", "current.omitted", "current.unknown.x", "rows.1", "rows.00", "rows.-1", "rows[0].damage", "rows.length", "constructor", "__proto__", "current.toString", "x".repeat(201)]) {
    assert.equal(hasCardField(card, field), false, field);
  }
});

test("veto team preview uses Metamon's full order as the default so preview cannot silently bypass the gate", async () => {
  const f = advisorFixture(), value = input(); value.envelope.semantic.snapshot.phase = "preview";
  value.envelope.semantic.snapshot.legalActions = [structuredClone(actions[3]!), { ...structuredClone(actions[3]!), id: "other-team", teamSpec: [1, 2, 3, 4, 5, 6], choice: "team 123456" }];
  f.advisor.decide = async v => ({ requestId: v.requestId, identity: v.envelope.semantic.identity, actionId: "team" });
  f.model.decide = async v => {
    assert.equal(v.advice?.actionId, "team");
    return { requestId: v.requestId, identity: v.envelope.semantic.identity, actionId: "other-team" };
  };
  const p = f.make(5000, "veto");
  try {
    const decision = await p.decide(value, currentOptions()); assert.equal(decision.actionId, "team");
    await p.commit(value, decision, currentOptions()); assert.deepEqual(f.commits, ["team"]);
    assert.equal(f.events[0]!.status, "available");
    assert.equal(f.events[1]!.phase === "commit" && f.events[1]!.override, "rejected:missing_override");
  } finally { await p.close(); }
});

for (const failure of ["failed", "stale", "timeout"] as const) test(`veto ${failure} advice preserves ordinary model behavior and journals fallback, because no valid default exists`, async () => {
  const f = advisorFixture();
  f.advisor.decide = async v => {
    if (failure === "failed") throw new Error("mock advisor failed");
    if (failure === "timeout") return new Promise(() => {});
    return { requestId: "stale-request", identity: v.envelope.semantic.identity, actionId: "base" };
  };
  const p = f.make(20, "veto"), value = input();
  try {
    const decision = await p.decide(value, currentOptions()); assert.equal(decision.actionId, "switch");
    assert.equal(f.received[0]!.advice, undefined);
    const opinion = f.events[0]!;
    assert.equal(opinion.phase === "opinion" && opinion.status === "unavailable" && opinion.reason,
      failure === "stale" ? "stale_advice" : failure === "timeout" ? "timeout" : "advisor_failed");
    await p.commit(value, decision, currentOptions());
    const event = f.events[1]!;
    assert.equal(event.phase === "commit" && event.fallback, "unavailable");
    assert.equal(event.phase === "commit" && event.adviceActionId, null);
    assert.equal(event.phase === "commit" && event.override, "none");
    assert.deepEqual(f.commits, []);
  } finally { await p.close(); }
});

test("veto recorder mutation cannot change routing or the executed action committed to the advisor", async () => {
  // Recorders are observers: mutating the opinion must not change the default,
  // and mutating a commit event must not change idempotency or recurrent input.
  const f = advisorFixture(), value = input();
  const p = new MetamonAdvisedBattlePolicy(f.model, f.advisor, { mode: "veto", onAdvice(event) {
    f.events.push(structuredClone(event)); event.mode = "suggest"; event.identity.rqid = 999;
    if (event.phase === "opinion" && event.status !== "unavailable") event.proposedActionId = "switch";
    if (event.phase === "commit") { event.executedActionId = "switch"; event.override = "accepted"; }
  } });
  try {
    const decision = await p.decide(value, currentOptions()); assert.equal(decision.actionId, "base");
    await assert.rejects(p.commit(value, { ...decision, actionId: "switch" }, currentOptions()), /differs from advice routing/);
    await p.commit(value, decision, currentOptions()); await p.commit(value, decision, currentOptions());
    assert.deepEqual(f.commits, ["base"]); assert.equal(f.events.length, 2);
  } finally { await p.close(); }
});

test("actor-side advice is outside canonical facts and commits the model override through the actual worker transport", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metamon-advice-")), log = path.join(directory, "rpc.jsonl");
  const f = advisorFixture(), actor = policy("", { METAMON_TEST_RPC_LOG: log });
  const advised = new MetamonAdvisedBattlePolicy(f.model, actor, { onAdvice: (event) => { f.events.push(event); } });
  const original = input(), before = structuredClone(original);
  try {
    await advised.observe(request(), context(), options());
    const decision = await advised.decide(original, currentOptions());
    assert.equal(f.received[0]!.advice!.actionId, "base");
    assert.equal(f.received[0]!.envelope.resultHash, before.envelope.resultHash);
    assert.deepEqual(original, before);
    await advised.commit(original, decision, currentOptions());
    await advised.commit(original, decision, currentOptions());
    const messages = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(messages.map((message) => message.op), ["observe", "propose", "commit"]);
    assert.deepEqual(messages[2].choice, { kind: "switch", switchSlot: 6 });
    assert.deepEqual(f.events.map((event) => [event.phase, event.status]), [["opinion", "available"], ["commit", "committed"]]);
    assert.equal(f.events[1]!.phase === "commit" && f.events[1]!.selectedActionId, "switch");
    const next = context(); next.sequence = 2; next.identity = { ...next.identity!, rqid: 2 };
    await advised.observe(request(), next, options());
  } finally { await advised.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("preview and singleton advice is hidden while proposal and actual-action history still advance", async () => {
  for (const preview of [false, true]) {
    const f = advisorFixture(), advised = f.make(), value = input();
    value.envelope.semantic.snapshot.phase = preview ? "preview" : "turn";
    value.envelope.semantic.snapshot.legalActions = [structuredClone(actions.find((action) => action.id === "base")!)];
    f.model.decide = async (captured) => { f.received.push(captured); return { requestId: captured.requestId, identity: captured.envelope.semantic.identity, actionId: "base" }; };
    try {
      const decision = await advised.decide(value, currentOptions());
      assert.equal(f.received[0]!.advice, undefined);
      await advised.commit(value, decision, currentOptions());
      assert.equal(f.counts().proposals, 1); assert.deepEqual(f.commits, ["base"]);
      assert.equal(f.events[0]!.status, preview ? "hidden_preview" : "hidden_singleton");
      assert.equal(f.events[0]!.phase === "opinion" && f.events[0]!.eligible, false);
    } finally { await advised.close(); }
  }
});

test("bounded advice timeout retires the advisor, preserves the model deadline and never changes the arm", async () => {
  const f = advisorFixture(); let advisorAborted = false, modelDeadline = 0;
  f.advisor.decide = async (_value, operation?: { signal: AbortSignal }) => {
    operation?.signal.addEventListener("abort", () => { advisorAborted = true; }, { once: true });
    return new Promise(() => {});
  };
  f.model.decide = async (value, operation) => { modelDeadline = operation.deadlineAt; f.received.push(value);
    return { requestId: value.requestId, identity: value.envelope.semantic.identity, actionId: "switch" }; };
  const advised = f.make(20), operation = currentOptions();
  try {
    const decision = await advised.decide(input(), operation);
    assert.equal(modelDeadline, operation.deadlineAt); assert.equal(advisorAborted, true);
    assert.equal(f.received[0]!.advice, undefined); assert.match(advised.id, /metamon-advice@1$/);
    assert.equal(f.events[0]!.phase === "opinion" && f.events[0]!.status === "unavailable" && f.events[0]!.reason, "timeout");
    await advised.commit(input(), decision, operation);
    const next = input(); next.requestId = "next"; next.envelope.semantic.identity.rqid = 2;
    await advised.decide(next, currentOptions());
    assert.equal(f.received.length, 2); assert.equal(f.received[1]!.advice, undefined);
  } finally { await advised.close(); }
});

test("stale advice and failed recording stop before model generation", async () => {
  const stale = advisorFixture(), advised = stale.make(); let checks = 0;
  try {
    await assert.rejects(advised.decide(input(), { ...options(), assertCurrent: async () => { if (++checks === 2) throw new Error("stale"); } }), /stale/);
    assert.equal(stale.received.length, 0);
    await assert.rejects(advised.observe(request(), context(), options()), /committed/);
  } finally { await advised.close(); }
  const failed = advisorFixture(), recorder = new MetamonAdvisedBattlePolicy(failed.model, failed.advisor, { onAdvice: () => { throw new Error("PRIVATE_RECORDER_DETAIL"); } });
  try {
    await assert.rejects(recorder.decide(input(), currentOptions()), { message: "Metamon advice recorder failed." });
    assert.equal(failed.received.length, 0);
  } finally { await recorder.close(); }
});

test("invalid opinion never reaches the prompt, and failed actual commit disables later advice", async () => {
  const f = advisorFixture(); f.advisor.decide = async (value) => ({ requestId: "wrong", identity: value.envelope.semantic.identity, actionId: "base" });
  const invalid = f.make();
  try {
    await invalid.decide(input(), currentOptions()); assert.equal(f.received[0]!.advice, undefined);
    assert.equal(f.events[0]!.status, "unavailable");
  } finally { await invalid.close(); }
  const g = advisorFixture(); g.advisor.commit = async () => { throw new Error("PRIVATE_WORKER_DETAIL"); };
  const failing = g.make();
  try {
    const value = input(), decision = await failing.decide(value, currentOptions());
    await assert.rejects(failing.commit({ ...value, requestId: "wrong" }, decision, currentOptions()), /match/);
    await failing.commit(value, decision, currentOptions());
    assert.equal(g.events[1]!.status, "unavailable");
    const next = input(); next.requestId = "next"; next.envelope.semantic.identity.rqid = 2;
    await failing.decide(next, currentOptions());
    assert.equal(g.received[1]!.advice, undefined);
  } finally { await failing.close(); }
});

// Matters: the re-ranker reweights exactly the distribution the worker samples from. The optional reply field is
// re-keyed by canonical action ID; a reply without it still works, and a malformed one (mass not 1, an unknown or
// illegal token, zero mass on the proposal itself, non-numbers) is a broken worker and must close it, never reach p'.
test("worker-reported legal distribution is re-keyed by action, optional, and validated fail-closed", async () => {
  const plain = policy();
  try {
    await plain.observe(request(), context(), options());
    const decision = await plain.decide(input(), options());
    assert.equal(decision.actionId, "base"); assert.equal(plain.proposalDistribution("attempt-1"), undefined);
  } finally { await plain.close(); }
  const reported = policy("probs");
  try {
    await reported.observe(request(), context(), options());
    await reported.decide(input(), options());
    assert.deepEqual(reported.proposalDistribution("attempt-1"), { base: 0.7, tera: 0.2, switch: 0.1 });
    assert.equal(reported.proposalDistribution("another-request"), undefined, "bound to the staged request");
  } finally { await reported.close(); }
  for (const mode of ["probs_sum", "probs_token", "probs_zero", "probs_type"]) {
    const broken = policy(mode);
    try {
      await broken.observe(request(), context(), options());
      await assert.rejects(broken.decide(input(), options()), /Metamon worker failed \((?:protocol|official_action)\)/, mode);
      assert.equal(broken.pid, null, `${mode}: the worker is closed`);
    } finally { await broken.close(); }
  }
});

test("typed choices map to one enabled structural action, including Tera and full preview order", () => {
  assert.equal(mapMetamonChoice({ kind: "move", moveSlot: 2, terastallize: false }, actions), "base");
  assert.equal(mapMetamonChoice({ kind: "move", moveSlot: 2, terastallize: true }, actions), "tera");
  assert.equal(mapMetamonChoice({ kind: "switch", switchSlot: 6 }, actions), "switch");
  assert.equal(mapMetamonChoice({ kind: "team", team: [2, 1, 3, 4, 5, 6] }, actions), "team");
  for (const bad of [{ actionIndex: 0 }, { kind: "move", moveSlot: 0, terastallize: false },
    { kind: "move", moveSlot: 2, terastallize: false, extra: true }, { kind: "team", team: [1, 1, 3, 4, 5, 6] }]) {
    assert.throws(() => mapMetamonChoice(bad, actions));
  }
  const move = { kind: "move", moveSlot: 2, terastallize: false };
  assert.throws(() => mapMetamonChoice(move, actions.map((a) => ({ ...a, disabled: true }))));
  assert.throws(() => mapMetamonChoice(move, [...actions, { ...actions[0]!, id: "duplicate" }]), /unique/);
  assert.throws(() => mapMetamonChoice(move, [{ ...actions[0]!, moveSlot: 1 }]), /unique/);
});

// Matters: the lead model's slot probabilities must land on the action that leads that slot (Showdown's `/team` digits);
// a shifted or unmatched slot would show the wrong lead as "usual". Malformed replies are a broken worker, not a guess.
test("lead model slots map to the team action leading that slot; malformed or unmatched replies fail closed", () => {
  const perms = (rest: number[]): number[][] => rest.length <= 1 ? [rest] : rest.flatMap((x) => perms(rest.filter((y) => y !== x)).map((p) => [x, ...p]));
  const team: LegalAction[] = perms([1, 2, 3, 4, 5, 6]).map((teamSpec) => ({ id: `team:${teamSpec.join("")}`, kind: "team", label: "Team order", teamSpec, choice: `team ${teamSpec.join("")}` }));
  const sha = "3".repeat(64), probabilities = [0.2, 0.1, 0.05, 0.22, 0.28, 0.15];
  const lead = mapMetamonLead({ status: "ok", checkpointSha256: sha, leadProbabilities: probabilities, inferenceMs: 1.5 }, team);
  assert.equal(lead.status, "ok");
  assert.deepEqual(lead.status === "ok" && lead.distribution, { "team:123456": 0.2, "team:213456": 0.1, "team:312456": 0.05,
    "team:412356": 0.22, "team:512346": 0.28, "team:612345": 0.15 });
  assert.deepEqual(mapMetamonLead({ status: "unavailable", reason: "checkpoint_mismatch", checkpointSha256: sha }, team),
    { status: "unavailable", reason: "checkpoint_mismatch", checkpointSha256: sha });
  for (const bad of [{ status: "ok", checkpointSha256: sha, leadProbabilities: probabilities.slice(1), inferenceMs: 1 },
    { status: "ok", checkpointSha256: sha, leadProbabilities: [0.5, 0.5, 0.5, 0, 0, 0], inferenceMs: 1 },
    { status: "ok", checkpointSha256: "x", leadProbabilities: probabilities, inferenceMs: 1 },
    { status: "ok", checkpointSha256: sha, leadProbabilities: probabilities, inferenceMs: 1, extra: true },
    { status: "unavailable", reason: "because", checkpointSha256: sha }, null]) assert.throws(() => mapMetamonLead(bad, team), /protocol/);
  const missing = team.filter((action) => action.id !== "team:412356");
  assert.throws(() => mapMetamonLead({ status: "ok", checkpointSha256: sha, leadProbabilities: probabilities, inferenceMs: 1 }, missing), /official_action/);
  const disabled = team.map((action) => action.id === "team:123456" ? { ...action, disabled: true } : action);
  assert.throws(() => mapMetamonLead({ status: "ok", checkpointSha256: sha, leadProbabilities: probabilities, inferenceMs: 1 }, disabled), /official_action/);
});

for (const format of ["gen9ou", "gen9uu"]) test(`${format} observation/decision preserves exact identity and canonical ID`, async () => {
  const p = policy();
  const ctx = context(format);
  try {
    await p.observe(request(), ctx, options());
    const decision = await p.decide(input(ctx), options());
    assert.deepEqual(decision, { requestId: "attempt-1", identity: ctx.identity, actionId: "base" });
    assert.deepEqual(await p.decide(input(ctx), options()), decision, "repeat reuses cached proposal");
    await p.commit(input(ctx), decision, options());
    await assert.rejects(p.decide(input(ctx), options()), /identity/);
  } finally { await p.close(); await p.close(); }
});

test("cached proposals commit the executed override against origin slots, once and before new observations", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metamon-commit-"));
  const log = path.join(directory, "rpc.jsonl"), p = policy("", { METAMON_TEST_RPC_LOG: log });
  const ctx = context(), current = structuredClone(input(ctx));
  try {
    await p.observe(request(), ctx, options());
    const proposed = await p.decide(current, options());
    assert.deepEqual(await p.decide(current, options()), proposed);
    assert.deepEqual(await p.decide(current, options()), proposed);
    const actual = { ...proposed, actionId: "switch" };
    // Reordering later caller arrays cannot remap the origin's switch slot6.
    current.envelope.semantic.snapshot.legalActions.reverse();
    await p.commit(current, actual, options());
    await p.commit(current, actual, options());
    const rows = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.op), ["observe", "propose", "commit"]);
    assert.deepEqual(rows[2].choice, { kind: "switch", switchSlot: 6 });
    assert.deepEqual(rows[2].identity, rows[1].identity);
    const next = { ...ctx, sequence: 2, identity: { ...ctx.identity!, rqid: 2, stateRevision: 2 } };
    await p.observe(request().replace('"rqid":1', '"rqid":2'), next, options());
    assert.equal((await p.decide(input(next), options())).actionId, "base");
  } finally { await p.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

// e2 dev cohort, 2026-10-21: our Zoroark-Hisui came in as "Hydrapple" in our own private stream while the request showed
// it active; the pinned decoder kept Hydrapple active and found no legal action (three failed games, cohort stopped).
test("our own disguised Zoroark reaches the worker as itself until it leaves; the foe's disguise and uncertain cases pass through", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metamon-illusion-"));
  const log = path.join(directory, "rpc.jsonl"), p = policy("", { METAMON_TEST_RPC_LOG: log });
  const mon = (ident: string, details: string, condition: string, ability: string) => ({ ident, details, condition, active: false, ability, baseAbility: ability });
  const party = (hydrapple: string) => `|request|${JSON.stringify({ rqid: 1, forceSwitch: [true], side: { id: "p1", pokemon: [
    mon("p1: Talonflame", "Talonflame, M", "0 fnt", "flamebody"), mon("p1: Zoroark", "Zoroark-Hisui, M", "252/252", "illusion"),
    mon("p1: Hydrapple", "Hydrapple, M", hydrapple, "regenerator")] } })}`;
  const frames = [party("203/353"),
    "|switch|p1a: Hydrapple|Hydrapple, M|252/252\n|move|p1a: Hydrapple|Shadow Ball|p2a: Heatran\n|-damage|p2a: Heatran|50/100|[from] item: Rocky Helmet|[of] p1a: Hydrapple"
      + "\n|switch|p2a: Hydrapple|Hydrapple, F|100/100\n|move|p2a: Hydrapple|Earth Power|p1a: Hydrapple"
      + "\n|replace|p1a: Zoroark|Zoroark-Hisui, M\n|-end|p1a: Zoroark|Illusion\n|-damage|p1a: Zoroark|100/252",
    "|switch|p1a: Hydrapple|Hydrapple, M|203/353\n|move|p1a: Hydrapple|Giga Drain|p2a: Hydrapple",
    // Zoroark's max HP equal to the imitated mon's: no certain identity, so the decoder gets Showdown's line.
    party("203/252"), "|switch|p1a: Hydrapple|Hydrapple, M|252/252"];
  try {
    for (const [i, data] of frames.entries()) await p.observe(data, { ...context(), sequence: i + 1, identity: null }, options());
    const seen = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line).data);
    assert.equal(seen[1], "|switch|p1a: Zoroark|Zoroark-Hisui, M|252/252\n|move|p1a: Zoroark|Shadow Ball|p2a: Heatran"
      + "\n|-damage|p2a: Heatran|50/100|[from] item: Rocky Helmet|[of] p1a: Zoroark"
      + "\n|switch|p2a: Hydrapple|Hydrapple, F|100/100\n|move|p2a: Hydrapple|Earth Power|p1a: Zoroark"
      + "\n|-end|p1a: Zoroark|Illusion\n|-damage|p1a: Zoroark|100/252", "the redundant |replace| would make the decoder swap Zoroark for itself");
    assert.deepEqual([seen[2], seen[4]], [frames[2], frames[4]], "the real Hydrapple and an ambiguous switch must stay as sent");
  } finally { await p.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

for (const actionId of ["base", "tera", "switch"]) test(`actual ${actionId} commit retains exact choice and rejects changed binding`, async () => {
  const p = policy(), current = input();
  try {
    await p.observe(request(), context(), options());
    const proposed = await p.decide(current, options());
    await p.commit(current, { ...proposed, actionId }, options());
    await assert.rejects(p.commit({ ...current, requestId: "other" }, { ...proposed, actionId }, options()), /identity|uncommitted/);
  } finally { await p.close(); }
});

test("uncommitted or expired cached proposal cannot survive into another observation", async () => {
  const p = policy();
  try {
    await p.observe(request(), context(), options());
    await p.decide(input(), options());
    await assert.rejects(p.observe("|turn|2", { ...context(), sequence: 2 }, options()), /uncommitted_action/);
    await assert.rejects(p.decide(input(), options()), /closed/);
  } finally { await p.close(); }
  const expired = policy();
  try {
    await expired.observe(request(), context(), options());
    const proposed = await expired.decide(input(), options());
    await assert.rejects(expired.commit(input(), proposed, { ...options(), deadlineAt: Date.now() - 1 }), /expired/);
  } finally { await expired.close(); }
});

test("Python actual-action commit uses saved official inverse mapping, not later party order", async () => {
  const code = String.raw`
import importlib.util,sys,types
s=importlib.util.spec_from_file_location('worker',sys.argv[1]);w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
sys.modules['numpy']=types.SimpleNamespace(array=lambda value,dtype:('action_rep',value),int64='int64')
p=object.__new__(w.KakunaPolicy);p.previous_action='unchanged';p.previous_state='old'
p.wrapper=types.SimpleNamespace(make_action_rep=lambda array:array)
origin=object();move={'kind':'move','moveSlot':1,'terastallize':True};switch={'kind':'switch','switchSlot':6}
p.pending=(origin,[(move,4),(switch,11)])
for bad in [dict(move,moveSlot=True),dict(move,extra=1),{'kind':'switch','switchSlot':2}]:
 try:p.commit(bad);raise AssertionError('invalid commit accepted')
 except w.WorkerError:pass
 assert p.previous_action=='unchanged' and p.previous_state=='old' and p.pending is not None
p.commit(switch);assert p.previous_action==('action_rep',[[11]]) and p.previous_state is origin and p.pending is None
try:p.commit(switch);raise AssertionError('duplicate neural commit')
except w.WorkerError:pass
print('origin inverse mapping PASS; zero neural forwards')
`;
  const result = await promisify(execFile)("python3", ["-B", "-c", code, workerPath], { timeout: 5000 });
  assert.match(result.stdout, /origin inverse mapping PASS/);
});

test("Struggle/Recharge index aliases commit one executed action; other ambiguity still fails", async () => {
  // A long game reaching Struggle used to kill the Metamon actor on commit (R56 continuation, turn 129):
  // upstream maps all four move indices to the one forced order.
  const code = String.raw`
import importlib.util,sys,types
s=importlib.util.spec_from_file_location('worker',sys.argv[1]);w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
sys.modules['numpy']=types.SimpleNamespace(array=lambda value,dtype:('action_rep',value),int64='int64')
def fresh(sampled,forced):
 p=object.__new__(w.KakunaPolicy);p.previous_action='unchanged';p.previous_state='old'
 p.wrapper=types.SimpleNamespace(make_action_rep=lambda array:array)
 struggle={'kind':'move','moveSlot':1,'terastallize':False};switch={'kind':'switch','switchSlot':3}
 p.pending=(object(),[(struggle,0),(struggle,1),(struggle,2),(struggle,3),(switch,5)]);p.pending_alias=(sampled,forced)
 return p,struggle,switch
p,struggle,_=fresh(2,True);p.commit(struggle);assert p.previous_action==('action_rep',[[2]]) and p.pending is None
p,struggle,_=fresh(5,True);p.commit(struggle);assert p.previous_action==('action_rep',[[0]]),'override records lowest alias'
p,_,switch=fresh(2,True);p.commit(switch);assert p.previous_action==('action_rep',[[5]])
p,struggle,_=fresh(2,False)
try:p.commit(struggle);raise AssertionError('unforced ambiguity accepted')
except w.WorkerError as e:assert str(e)=='official_action' and p.pending is not None and p.previous_action=='unchanged'
p,_,_=fresh(2,True)
try:p.commit({'kind':'switch','switchSlot':4});raise AssertionError('unknown choice accepted')
except w.WorkerError as e:assert str(e)=='official_action'
p,struggle,_=fresh(2,True);p.commit(struggle)
try:p.commit(struggle);raise AssertionError('duplicate neural commit')
except w.WorkerError as e:assert str(e)=='identity'
print('forced-move alias PASS')
# Per-side seeds: with one shared seed every actor drew the same uniform stream, so seat-swapped
# Metamon-only games replayed identically. Each side must get its own, reproducible stream.
assert w.side_seed(1,'p1')==729352539 and w.side_seed(1,'p2')==118223021
assert len({w.side_seed(s,side) for s in range(50) for side in ('p1','p2')})==100
assert all(0<=w.side_seed(s,side)<2**31 for s in (0,1,2**32-1) for side in ('p1','p2'))
try:w.side_seed(1,'p3');raise AssertionError('unknown side seeded')
except w.WorkerError as e:assert str(e)=='identity'
`;
  const result = await promisify(execFile)("python3", ["-B", "-c", code, workerPath], { timeout: 5000 });
  assert.match(result.stdout, /forced-move alias PASS/);
});

for (const format of ["gen9ou", "gen9uu"]) test(`${format} official protocol labels bind to the same canonical format ID`, async () => {
  const { DecisionEngine } = await import("../state/decisionEngine.js");
  const engine = new DecisionEngine(), p = policy();
  const roomId = `battle-${format}-offline`;
  let sequence = 0;
  let last: Awaited<ReturnType<InstanceType<typeof DecisionEngine>["ingest"]>>;
  try {
    for (const data of officialFixture(format).p2!) {
      last = await engine.ingest({ roomId, sessionId: "format-test", observationId: `format-${++sequence}`,
        sequence, source: "protocol", data: `>${roomId}\n${data}` });
      await p.observe(data, { roomId, side: "p2", format, sequence, identity: last.identity ?? null }, options());
    }
    assert.equal(last!.snapshot!.format, format === "gen9uu" ? "[Gen 9] UU" : "[Gen 9] OU");
    const ctx = { roomId, side: "p2" as const, format, sequence, identity: last!.identity! };
    const current = input(ctx);
    current.envelope.semantic.snapshot = last!.snapshot!;
    const decision = await p.decide(current, options());
    const action = last!.snapshot!.legalActions.find((entry) => entry.id === decision.actionId)!;
    assert.equal(action.choice, "move 2");
    assert.deepEqual(decision.identity, last!.identity);
  } finally { await p.close(); }
});

for (const format of ["gen9ou", "gen9uu"]) test(`${format} midstream initialization closes a worker before another decision`, async () => {
  const p = policy();
  const ctx = context(format);
  try {
    await p.observe("|init|battle", ctx, options());
    await assert.rejects(p.observe("|init|battle", { ...ctx, sequence: 2 }, options()), /protocol_reset/);
    await assert.rejects(p.decide(input(ctx), options()), /closed/);
  } finally { await p.close(); }
});

for (const format of ["gen9ou", "gen9uu"]) test(`${format} stale identity, hash, sequence, request and unbound actions fail closed`, async () => {
  for (const mode of ["stale", "hash", "sequence", "request", "illegal", "index"]) {
    const p = policy(mode);
    try {
      const ctx = context(format);
      await p.observe(request(), ctx, options());
      await assert.rejects(p.decide(input(ctx), options()));
      await assert.rejects(p.observe(request(), { ...ctx, sequence: 2 }, options()), /closed/);
    } finally { await p.close(); }
  }
});

for (const format of ["gen9ou", "gen9uu"]) test(`${format} cross-side private requests, split channels and observation reordering fail`, async () => {
  const base = context(format);
  for (const [data, ctx] of [[request("p2"), base], ["|split|p1\n|-damage|p1a: Scizor|1/200", base],
    [request(), { ...base, sequence: 2 }]] as const) {
    const p = policy();
    try { await assert.rejects(p.observe(data, ctx, options())); } finally { await p.close(); }
  }
  const p = policy();
  try {
    await p.observe(request(), base, options());
    await assert.rejects(p.observe(request("p2"), { ...base, sequence: 2, side: "p2" }, options()), /context/);
  } finally { await p.close(); }
});

test("unsupported formats and mismatched room tags reject before worker launch", async () => {
  const cases = ["gen8ou", "gen8uu", "gen9ru", "gen9doublesou", "gen9nationaldex", "Gen9UU", "[Gen 9] UU", ""].map(context);
  for (const format of ["gen9ou", "gen9uu"]) {
    for (const roomId of [`battle-${format === "gen9uu" ? "gen9ou" : "gen9uu"}-offline`, `battle-${format}-`,
      `battle-${format}-offline\n`, `prefix-battle-${format}-offline`, `battle-${format}-offline/extra`]) {
      cases.push({ ...context(format), roomId, identity: null });
    }
  }
  for (const ctx of cases) {
    const p = new MetamonBattlePolicy({ command: "/nonexistent/metamon-python", args: [] });
    try { await assert.rejects(p.observe(request(), ctx, options()), /observation_context/); }
    finally { await p.close(); }
  }
});

for (const format of ["gen9ou", "gen9uu"]) test(`${format} mismatched identity, snapshot and disabled actions reject`, async () => {
  const invalid = policy(), ctx = context(format);
  try {
    await assert.rejects(invalid.observe(request(), { ...ctx, identity: { ...ctx.identity!, roomId: "battle-other" } }, options()), /identity/);
  } finally { await invalid.close(); }
  for (const change of ["format", "side", "disabled", "legality", "unavailable"] as const) {
    const p = policy();
    try {
      await p.observe(request(), ctx, options());
      const current = input(structuredClone(ctx));
      const snapshot = current.envelope.semantic.snapshot;
      snapshot.legalActions = structuredClone(actions);
      if (change === "format") snapshot.format = format === "gen9uu" ? "gen9ou" : "gen9uu";
      else if (change === "side") snapshot.yourSide.slot = "p2";
      else if (change === "disabled") snapshot.legalActions[0]!.disabled = true;
      else if (change === "legality") snapshot.legalActions[0]!.legality = "disabled";
      else snapshot.legalActions = snapshot.legalActions.slice(1);
      await assert.rejects(p.decide(current, options()), /identity|unique canonical action/);
      await assert.rejects(p.observe(request(), { ...ctx, sequence: 2 }, options()), /closed/);
    } finally { await p.close(); }
  }
});

test("Python format/room boundary admits only matching OU or UU before decoder construction", { skip: process.platform === "win32" }, async () => {
  // Execute the source observe method with only its parser import removed and a
  // sentinel constructor. This tests the entry guard, NOT the official parser.
  const code = String.raw`
import ast,importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
tree=ast.parse(pathlib.Path(sys.argv[1]).read_text())
cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='SocketlessBattle')
method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='observe')
assert isinstance(method.body[0],ast.ImportFrom) and method.body[0].module=='metamon.env.metamon_battle'
method.body.pop(0)
class ReachedDecoder(Exception):pass
def decoder(room,*args):raise ReachedDecoder(room)
scope={**vars(w),'MetamonBackendBattle':decoder}
exec(compile(ast.Module(body=[method],type_ignores=[]),'<source-boundary>','exec'),scope)
def observe(fmt,room):
    ctx={'roomId':room,'side':'p1','format':fmt,'sequence':1,'identity':None}
    scope['observe'](w.SocketlessBattle(),'',ctx)
for fmt in ('gen9ou','gen9uu'):
    room='battle-'+fmt+'-offline'
    try:observe(fmt,room)
    except ReachedDecoder as error:assert str(error)==room
    else:raise AssertionError('matching format did not reach decoder')
    for bad in ('battle-'+('gen9ou' if fmt=='gen9uu' else 'gen9uu')+'-offline', 'battle-'+fmt+'-', room+'\n', 'prefix-'+room, room+'/extra'):
        try:observe(fmt,bad)
        except w.WorkerError as error:assert str(error)=='unsupported'
        else:raise AssertionError('bad room accepted')
for fmt in ('gen8ou','gen8uu','gen9ru','gen9doublesou','gen9nationaldex','Gen9UU','[Gen 9] UU',''):
    try:observe(fmt,'battle-'+fmt+'-offline')
    except w.WorkerError as error:assert str(error)=='unsupported'
    else:raise AssertionError('unsupported format accepted')
assert 'torch' not in sys.modules and 'metamon' not in sys.modules
print('format boundary passed; no parser or model imports')
`;
  const result = await promisify(execFile)("python3", ["-B", "-c", code, workerPath], { timeout: 5000 });
  assert.match(result.stdout, /format boundary passed; no parser or model imports/);
});

test("malformed JSON, wrong RPC ID, oversized output and exit settle and close", async () => {
  for (const mode of ["noise", "wrong_id", "huge", "exit"]) {
    const p = policy(mode);
    try { await assert.rejects(p.observe(request(), context(), options())); } finally { await p.close(); }
  }
  const p = new MetamonBattlePolicy({ command: "/nonexistent/metamon-python", args: [] });
  try { await assert.rejects(p.observe(request(), context(), options()), /spawn/); } finally { await p.close(); }
});

for (const format of ["gen9ou", "gen9uu"]) test(`${format} cancellation and deadline bound a nonresponsive worker`, async () => {
  for (const cancel of [true, false]) {
    const p = policy("hang"), controller = new AbortController(), start = Date.now();
    const pending = p.observe(request(), context(format), { deadlineAt: Date.now() + (cancel ? 2000 : 100), signal: controller.signal });
    if (cancel) controller.abort();
    try { await assert.rejects(pending, cancel ? /cancelled/ : /timeout/); } finally { await p.close(); }
    assert.ok(Date.now() - start < 1500);
  }
});

test("unobserved state changes and concurrent operations close the instance", async () => {
  const p = policy();
  try {
    await p.observe(request(), context(), options());
    const changed = input(); changed.envelope.semantic.identity.stateRevision++;
    await assert.rejects(p.decide(changed, options()), /identity/);
  } finally { await p.close(); }
  const hanging = policy("hang");
  const first = hanging.observe(request(), context(), options());
  const firstRejected = assert.rejects(first, /concurrent_operation/);
  try {
    await assert.rejects(hanging.observe(request(), context(), options()), /concurrent_operation/);
    await firstRejected;
  } finally { await hanging.close(); }
});

test("close kills a SIGTERM-ignoring leader and descendant", { skip: process.platform === "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metamon-process-"));
  const pidsFile = path.join(directory, "pids.json"), p = policy("tree", { METAMON_TEST_PIDS: pidsFile });
  const pending = p.observe(request(), context(), options(5000));
  const rejected = assert.rejects(pending, /closed/);
  try {
    let pids: number[] | undefined;
    for (let i = 0; i < 50; i++) {
      try { pids = JSON.parse(await fs.readFile(pidsFile, "utf8")); break; } catch { await delay(20); }
    }
    assert.ok(pids);
    await p.close(); await rejected;
    for (let i = 0; i < 50 && pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }); i++) await delay(20);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  } finally { await p.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

// Exercise the real Python entry point/reader. Only runtime/decoder work is
// substituted, so no Torch/assets are needed for transport cancellation races.
const pythonTransport = String.raw`
import importlib.util,json,os,signal,subprocess,sys,time,types
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
mode,ready=sys.argv[2:4]
sys.argv=[sys.argv[1],'--checkpoint','/nonexistent/policy_epoch_34.pt']
for name in ('metamon','metamon.rl','metamon.rl.pretrained'):sys.modules[name]=types.ModuleType(name)
def check(_):
 if mode=='blocked':
  child=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("ready",flush=True);time.sleep(120)'],stdout=subprocess.PIPE)
  assert child.stdout.readline()==b'ready\n'
  with open(ready,'w') as f:json.dump([os.getpid(),child.pid],f)
  time.sleep(120) # stands for a blocking import/init/native call
w.check_runtime=check
w.SocketlessBattle.observe=lambda self,data,context:setattr(self,'context',context)
sys.exit(w.main())
`;

test("Python transport EOF cancels blocked initialization and its SIGTERM-ignoring descendant", {
  skip: process.platform === "win32", timeout: 15_000
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metamon-eof-"));
  const ready = path.join(directory, "pids.json");
  // NOT detached: the Python worker must create its own private session, without
  // signalling this test runner or its inherited process group.
  const child = spawn(process.env.METAMON_PARSE_PYTHON ?? "python3", ["-u", "-c", pythonTransport, workerPath, "blocked", ready]);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; }); child.stderr.resume();
  let pids: number[] = [];
  try {
    child.stdin.write(JSON.stringify({ version: "metamon-worker@2", id: 1, op: "observe", data: request(), context: context() }) + "\n");
    for (let i = 0; i < 100; i++) {
      try { pids = JSON.parse(await fs.readFile(ready, "utf8")); break; } catch { await delay(20); }
    }
    assert.equal(pids.length, 2);
    assert.equal(pids[0], child.pid);
    const start = Date.now();
    // An unread partial next frame must not conceal EOF or spin on HUP.
    child.stdin.end('{"incomplete":');
    const result = await exited;
    // The explicit _exit(1) may beat SIGKILL delivery to the leader on Darwin;
    // both are cancellation, and the descendant must still be dead below.
    assert.ok(result.signal === "SIGKILL" || result.code === 1);
    assert.ok(Date.now() - start < 2000);
    assert.equal(output, "");
    for (let i = 0; i < 100 && pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }); i++) await delay(20);
    for (const pid of pids) {
      // Linux may retain an orphan zombie until PID 1 reaps it; it cannot run
      // or retain a GPU context. Darwin's init reaps it immediately.
      if (process.platform === "linux") {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
        assert.ok(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "));
      } else assert.throws(() => process.kill(pid, 0));
    }
  } finally {
    child.kill("SIGKILL");
    for (const pid of pids.slice(1)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await exited; await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Python transport flushes each ack before immediate next RPC/normal EOF and exits zero", {
  skip: process.platform === "win32", timeout: 15_000
}, async () => {
  const child = spawn(process.env.METAMON_PARSE_PYTHON ?? "python3", ["-u", "-c", pythonTransport, workerPath, "normal", "unused"]);
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stderr.resume();
  let output = "", count = 0;
  const send = () => child.stdin.write(JSON.stringify({ version: "metamon-worker@2", id: count + 1, op: "observe", data: request(), context: context() }) + "\n");
  const replies: unknown[] = [];
  child.stdout.on("data", (chunk) => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) !== -1) {
      replies.push(JSON.parse(output.slice(0, newline))); output = output.slice(newline + 1);
      if (++count === 30) child.stdin.end(); else send();
    }
  });
  try {
    send();
    assert.equal(await exited, 0);
    assert.equal(output, ""); assert.equal(count, 30);
    assert.deepEqual(replies, Array.from({ length: 30 }, (_, i) => ({ version: "metamon-worker@2", id: i + 1, ok: true, context: context() })));
  } finally { child.kill("SIGKILL"); await exited; }
});

test("Python worker reports missing assets explicitly before any runtime/model import", { skip: process.platform === "win32" }, async () => {
  const p = new MetamonBattlePolicy({ command: process.env.METAMON_PARSE_PYTHON ?? "python3", args: ["-u", workerPath, "--checkpoint", "/nonexistent/policy_epoch_34.pt"] });
  try { await assert.rejects(p.observe(request(), context(), options()), /missing_assets/); } finally { await p.close(); }
});

// Explicit opt-in to an already provisioned worker, including an SSH launch.
// This exercises main's import order after real private observations, then the
// actual recurrent network, mask and canonical executor. It downloads nothing.
test("live pinned worker accepts preview and successive normal-turn network decisions", {
  skip: !process.env.METAMON_RPC_LAUNCH, timeout: 300_000
}, async () => {
  const { runBattleMatch } = await import("../battle-agent/simulator.js");
  const { DeterministicBattlePolicy } = await import("../battle-agent/battleAgent.js");
  const launch = JSON.parse(await fs.readFile(process.env.METAMON_RPC_LAUNCH!, "utf8"));
  const team = [
    { species: "Scizor", ability: "Technician", item: "Choice Band", teraType: "Fire", moves: ["U-turn", "Bullet Punch", "Close Combat", "Swords Dance"] },
    { species: "Gengar", ability: "Cursed Body", item: "Life Orb", moves: ["Shadow Ball"] },
    { species: "Arcanine", ability: "Intimidate", item: "Heavy-Duty Boots", moves: ["Flare Blitz"] },
    { species: "Dragonite", ability: "Multiscale", item: "Leftovers", moves: ["Dragon Claw"] },
    { species: "Garchomp", ability: "Rough Skin", item: "Rocky Helmet", moves: ["Earthquake"] },
    { species: "Corviknight", ability: "Pressure", item: "Leftovers", moves: ["Brave Bird"] }
  ].map((set) => `${set.species} @ ${set.item}\nAbility: ${set.ability}\nEVs: 4 HP / 252 Atk / 252 Spe\n`
    + (set.teraType ? `Tera Type: ${set.teraType}\n` : "") + set.moves.map((move) => `- ${move}`).join("\n")).join("\n\n");
  const result = await runBattleMatch({ p1: new DeterministicBattlePolicy(), p2: new MetamonBattlePolicy(launch),
    teams: { p1: team, p2: team }, format: "gen9ou", seed: [1, 2, 3, 4], maxTurns: 3, maxDecisions: 16,
    timeoutMs: 280_000, decisionDeadlineMs: 120_000, fallback: "none" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.fallbacks, []);
  const decisions = result.trajectory.filter((entry) => entry.side === "p2");
  assert.ok(decisions.every((entry) => entry.accepted && !entry.fallback && entry.policyId === "metamon:Kakuna:epoch34"));
  assert.equal(decisions[0]?.identity.requestKind, "team_preview");
  assert.match(decisions[0]!.reason!, /no Kakuna network decision/);
  const normal = decisions.filter((entry) => entry.identity.requestKind === "move");
  assert.ok(normal.length >= 2);
  assert.ok(normal.some((entry) => entry.choice.startsWith("move ")));
  assert.ok(normal.every((entry, i) => entry.reason === null && (i === 0 || entry.rqid > normal[i - 1]!.rqid)));
});

const uuTeam = `Scizor @ Choice Band
Ability: Technician
Tera Type: Fire
EVs: 4 HP / 252 Atk / 252 Spe
- U-turn
- Bullet Punch
- Close Combat
- Swords Dance

Gengar @ Life Orb
Ability: Cursed Body
EVs: 4 HP / 252 SpA / 252 Spe
- Shadow Ball

Arcanine @ Heavy-Duty Boots
Ability: Intimidate
EVs: 4 HP / 252 Atk / 252 Spe
- Flare Blitz

Donphan @ Leftovers
Ability: Sturdy
EVs: 4 HP / 252 Atk / 252 Spe
- Earthquake

Slowking @ Leftovers
Ability: Regenerator
EVs: 4 HP / 252 SpA / 252 Spe
- Surf

Mamoswine @ Life Orb
Ability: Thick Fat
EVs: 4 HP / 252 Atk / 252 Spe
- Ice Shard`;

test("mock-only simulator CLI requires explicit Metamon format and labels UU OOD", { timeout: 60_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metamon-cli-"));
  const cli = fileURLToPath(new URL("../tools/battle-agent-sim.ts", import.meta.url));
  const team = path.join(directory, "team.txt");
  await fs.writeFile(team, uuTeam);
  const invoke = async (args: string[]) => {
    try {
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, ...args], {
        timeout: 15_000, maxBuffer: 1_048_576, env: { ...process.env, METAMON_TEST_MODE: "cli" }
      });
      return { ...result, code: 0 };
    } catch (error) {
      const failed = error as Error & { code: number; stdout: string; stderr: string };
      assert.ok(Number.isInteger(failed.code), failed.message);
      return failed;
    }
  };
  try {
    for (const side of ["--p1", "--p2"]) {
      for (const format of [undefined, "gen8ou", "gen8uu", "gen9ru", "gen9doublesou", "gen9nationaldex", "Gen9UU"]) {
        const result = await invoke([side, "metamon", ...(format ? ["--format", format] : []), "--metamon-command", "/nonexistent/metamon-python"]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /explicit --format gen9ou or --format gen9uu/);
        assert.equal(result.stdout, "");
      }
    }
    for (const format of ["gen9ou", "gen9uu", "default"]) {
      const output = path.join(directory, format);
      const metamon = format !== "default";
      const result = await invoke(["--p1", "random", "--p2", metamon ? "metamon" : "random", "--team", team,
        "--max-decisions", "4", "--max-turns", "1", "--fallback", "none", "--output", output,
        ...(metamon ? ["--format", format, "--metamon-command", process.execPath, "--metamon-args", JSON.stringify(["-e", mockWorker])] : [])]);
      assert.equal(result.code, 2, result.stderr || result.stdout);
      const summary = JSON.parse(result.stdout);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, "summary.json"), "utf8")), summary);
      assert.equal(summary.format, metamon ? format : "gen9uu");
      assert.equal(summary.status, "truncated");
      assert.deepEqual(summary.errors, []); assert.deepEqual(summary.fallbacks, []);
      const decisions = (await fs.readFile(path.join(output, "trajectory.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(decisions.length, 4);
      assert.ok(decisions.every((entry) => entry.accepted && !entry.fallback));
      if (metamon) {
        assert.equal(summary.metamon.formatQualification, format === "gen9uu" ? "experimental_out_of_distribution" : "gen9ou_baseline");
        if (format === "gen9uu") assert.match(summary.metamon.notes, /not trained UU support/);
        const own = decisions.filter((entry) => entry.side === "p2");
        assert.equal(own[0].choice, "team 123456");
        assert.match(own[0].reason, /no Kakuna network decision/);
        assert.equal(own[1].choice, "move 2");
      } else assert.equal(summary.metamon, undefined);
    }
    const help = await invoke(["--help"]);
    assert.equal(help.code, 0); assert.match(help.stdout, /experimental.*out_of_distribution/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

function officialFixture(format = "gen9ou") {
  const chunks: Record<string, string[]> = { p1: [], p2: [] }, epochs = { p1: 0, p2: 0 };
  const validator = new TeamValidator(format);
  if (format === "gen9uu") assert.equal(validator.validateTeam(Teams.import(uuTeam)!), null);
  const battle = new Battle({ formatid: validator.format.id, seed: "1,2,3,4", send(type, data) {
    const text = Array.isArray(data) ? data.join("\n") : data;
    if (type === "update") {
      const channels = extractChannelMessages(text, [1, 2]);
      for (const side of ["p1", "p2"] as const) chunks[side]!.push(channels[side === "p1" ? 1 : 2].join("\n"));
    } else if (type === "sideupdate") {
      const side = text.slice(0, 2) as "p1" | "p2";
      if (text.slice(3).startsWith("|request|")) chunks[side]!.push("|request|" + JSON.stringify({ ...JSON.parse(text.slice(12)), rqid: ++epochs[side] }));
    }
  } });
  const team = Teams.pack(Teams.import(format === "gen9uu" ? uuTeam : `Scizor @ Choice Band
Ability: Technician
Tera Type: Fire
- U-turn
- Bullet Punch
- Close Combat
- Swords Dance

Gengar @ Life Orb
Ability: Cursed Body
- Shadow Ball

Volcarona @ Heavy-Duty Boots
Ability: Flame Body
- Fiery Dance

Dragonite @ Leftovers
Ability: Multiscale
- Dragon Claw

Garchomp @ Rocky Helmet
Ability: Rough Skin
- Earthquake

Corviknight @ Leftovers
Ability: Pressure
- Brave Bird`)!);
  battle.setPlayer("p1", { name: "Offline p1", team }); battle.setPlayer("p2", { name: "Offline p2", team }); battle.sendUpdates();
  battle.choose("p1", "team 123456"); battle.choose("p2", "team 123456"); battle.sendUpdates();
  battle.destroy();
  return chunks;
}

// Opt in with a lightweight official parser environment, never a mock Python
// package: METAMON_PARSE_PYTHON=/tmp/.../bin/python PYTHONPATH=<pinned source>.
test("official socketless parser + all 13 action conversions, both private sides, without Torch", {
  skip: !process.env.METAMON_PARSE_PYTHON
}, async () => {
  const code = String.raw`
import importlib.util,json,sys,copy
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
def no_network(event,args):
 if event in ('socket.connect','socket.getaddrinfo'): raise AssertionError('network forbidden')
sys.addaudithook(no_network)
from metamon.interface import UniversalState,get_action_space,TokenizedObservationSpace,get_observation_space
from metamon.tokenizer import get_tokenizer
from poke_env.player import Player
fixtures=json.loads(sys.argv[2])
for side,chunks in fixtures.items():
 d=w.SocketlessBattle()
 for seq,data in enumerate(chunks,1):
  ctx={'roomId':'battle-gen9ou-offline','side':side,'format':'gen9ou','sequence':seq,'identity':None}
  d.observe(data,ctx)
  if d.request and d.request.get('teamPreview'): assert len(Player.random_teampreview(None,d.battle))==12
 s=UniversalState.from_Battle(d.battle)
 obs=TokenizedObservationSpace(get_observation_space('OpponentMoveObservationSpace'),get_tokenizer('DefaultObservationSpace-v1'))
 obs.reset(); assert set(obs.state_to_obs(s))=={'text_tokens','numbers'}
 def choice(index):
  order=get_action_space('DefaultActionSpace').agent_output_to_action(UniversalState.from_Battle(d.battle),index).to_BattleOrder(d.battle)
  return w.structural_choice(order,d.request)
 choices=[choice(i) for i in range(13)]
 assert [c['moveSlot'] for c in choices[:4]]==[2,3,4,1]
 assert [c['switchSlot'] for c in choices[4:9]]==[6,4,5,2,3]
 assert [c['moveSlot'] for c in choices[9:]]==[2,3,4,1]
 assert all(c['terastallize'] for c in choices[9:])
 identity={'roomId':ctx['roomId'],'rqid':d.rqid,'stateRevision':5,'requestKind':'move','snapshotHash':'sha256:'+'a'*64,'legalActionSetHash':'sha256:'+'a'*64}
 d.context['identity']=identity
 msg={'identity':identity,'sequence':ctx['sequence'],'requestId':'test','resultHash':'sha256:'+'a'*64}
 assert d.bind(msg)['identity']==identity
 d.decided_rqid=d.rqid
 try:d.bind(msg);raise AssertionError('duplicate decision accepted')
 except w.WorkerError as error:assert str(error)=='identity'
 d.decided_rqid=None
 for key,value in [('sequence',ctx['sequence']+1),('identity',{**identity,'rqid':1})]:
  try: d.bind({**msg,key:value});raise AssertionError('stale binding accepted')
  except w.WorkerError as error: assert str(error)=='identity'
 r=copy.deepcopy(d.request); r['rqid']+=1; r['active'][0]['moves'][1]['disabled']=True
 ctx={**ctx,'sequence':ctx['sequence']+1,'identity':None};d.observe('|request|'+json.dumps(r),ctx)
 try: choice(0);raise AssertionError('disabled action accepted')
 except w.WorkerError: pass
 r=copy.deepcopy(d.request);r['rqid']+=1;r['active'][0]['moves'][1]['disabled']=False;r['active'][0].pop('canTerastallize',None)
 ctx={**ctx,'sequence':ctx['sequence']+1};d.observe('|request|'+json.dumps(r),ctx)
 assert choice(9)=={'kind':'move','moveSlot':2,'terastallize':False}
 for special in ('recharge','struggle'):
  r=copy.deepcopy(d.request);r['rqid']+=1;r['active'][0]['moves']=[{'id':special,'move':special.title(),'pp':1,'maxpp':1,'target':'normal','disabled':False}]
  ctx={**ctx,'sequence':ctx['sequence']+1};d.observe('|request|'+json.dumps(r),ctx)
  assert choice(0)=={'kind':'move','moveSlot':1,'terastallize':False}
 r=copy.deepcopy(d.request);r['rqid']+=1;r.pop('active');r['forceSwitch']=[True];r['side']['pokemon'][0]['condition']='0 fnt'
 ctx={**ctx,'sequence':ctx['sequence']+1};d.observe('|faint|'+side+'a: Scizor\n|request|'+json.dumps(r),ctx)
 assert choice(4)=={'kind':'switch','switchSlot':6}
 try: choice(0);raise AssertionError('move during forced switch')
 except w.WorkerError: pass
 for data in ('|request|'+json.dumps(r),'|split|p1'):
  try:d.observe(data,{**ctx,'sequence':ctx['sequence']+1});raise AssertionError('bad epoch/channel accepted')
  except w.WorkerError:pass
 before=d.battle.weather.copy()
 try:d.observe('|init|battle',{**ctx,'sequence':ctx['sequence']+1});raise AssertionError('midstream reset accepted')
 except w.WorkerError as error:assert str(error)=='protocol'
 assert d.battle.weather==before
assert 'torch' not in sys.modules
print('official parser/action/tokenizer proof passed; torch absent')
`;
  const result = await promisify(execFile)(process.env.METAMON_PARSE_PYTHON!, ["-B", "-c", code, workerPath, JSON.stringify(officialFixture())], { timeout: 30_000, maxBuffer: 262_144 });
  assert.match(result.stdout, /proof passed; torch absent/);
});

test("advice freshness, recorder and cancellation share the original bounded deadline", async () => {
  for (const held of ["freshness", "recorder", "cancel"] as const) {
    const f = advisorFixture(), controller = new AbortController();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    if (held === "cancel") f.advisor.decide = async () => { entered(); return new Promise<never>(() => {}); };
    const advised = new MetamonAdvisedBattlePolicy(f.model, f.advisor, {
      onAdvice: held === "recorder" ? async () => { entered(); return new Promise<never>(() => {}); } : () => {}
    });
    const operation = { deadlineAt: Date.now() + 1000, signal: controller.signal,
      assertCurrent: held === "freshness" ? async () => { entered(); return new Promise<never>(() => {}); } : async () => {} };
    try {
      const pending = advised.decide(input(), operation);
      const rejected = assert.rejects(pending);
      await Promise.race([started, rejected.then(() => { throw new Error("Bounded test operation ended before entering its gate."); })]);
      if (held === "cancel") controller.abort(new Error("stop"));
      await rejected; assert.equal(f.received.length, 0);
    } finally { await advised.close(); }
  }
});

test("advice captures input and deadline before waiting, and refuses nested opinions or a missing live checker", async () => {
  const f = advisorFixture(); let resume!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  f.advisor.decide = async (value) => { started(); await held;
    return { requestId: value.requestId, identity: value.envelope.semantic.identity, actionId: "base" }; };
  const advised = f.make(), value = input(), captured = structuredClone(value), operation = currentOptions(), deadline = operation.deadlineAt;
  let actualDeadline = 0;
  f.model.decide = async (received, options) => { actualDeadline = options.deadlineAt; f.received.push(received);
    return { requestId: received.requestId, identity: received.envelope.semantic.identity, actionId: "switch" }; };
  try {
    await assert.rejects(advised.decide(value, options()), /live|current/);
    const nested = input(); nested.advice = {} as NonNullable<BattlePolicyInput["advice"]>;
    await assert.rejects(advised.decide(nested, currentOptions()), /unadvised/);
    const pending = advised.decide(value, operation);
    await Promise.race([entered, pending.then(() => { throw new Error("Decision ended before the held advisor."); })]);
    value.requestId = "mutated"; value.envelope.semantic.identity.rqid = 999; value.envelope.semantic.snapshot.legalActions.length = 0;
    operation.deadlineAt += 100000;
    resume(); const decision = await pending;
    assert.equal(actualDeadline, deadline); assert.equal(decision.requestId, captured.requestId);
    assert.deepEqual(f.received[0]!.envelope, captured.envelope);
    await advised.commit(captured, decision, currentOptions());
  } finally { await advised.close(); }
});

test("Python trapped rejection re-proposes from the saved legal conditional with one hidden-state step", async () => {
  // Exercise the actual entry point, decoder and sampler with small deterministic
  // runtime doubles. Real parser/model replay is a separate gpubox qualification.
  const code = String.raw`
import contextlib,copy,importlib.util,json,random,sys,types
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class Array:
 def __getitem__(self,key):return self
 def to(self,*args):return self
 def unsqueeze(self,*args):return self
class Vector:
 def __init__(self,x):self.x=x
 def __getitem__(self,key):return self
 def __setitem__(self,key,value):
  for i in key:self.x[i]=value
 def float(self):return self
 def sum(self):return sum(self.x)
 def __mul__(self,other):return Vector([a*b for a,b in zip(self.x,other.x)])
 def __truediv__(self,n):return Vector([a/n for a in self.x])
rng=random.Random(19);draws=[]
def multinomial(probs,n):
 draws.append(probs.x)
 return types.SimpleNamespace(item=lambda:rng.choices(range(len(probs.x)),weights=probs.x)[0])
sys.modules['torch']=types.SimpleNamespace(no_grad=contextlib.nullcontext,from_numpy=lambda x:x,
 zeros_like=lambda p:Vector([0]*len(p.x)),multinomial=multinomial)
sys.modules['numpy']=types.SimpleNamespace(newaxis=None,array=lambda *a,**kw:Array(),zeros=lambda *a,**kw:Array(),float32='f',int64='i')
class Timestep:
 def __init__(self,**kw):pass
 def as_input(self):return {'x':Array()},Array(),Array()
sys.modules['amago.hindsight']=types.SimpleNamespace(Timestep=Timestep)
for name in ('metamon','metamon.rl','metamon.rl.pretrained'):sys.modules[name]=types.ModuleType(name)
class Battle:
 def __init__(self,*args):self.trapped=False;self.requests=[]
 def parse_message(self,line):pass
 def parse_request(self,r):self.requests.append(r);self.trapped=r['active'][0].get('trapped',False)
sys.modules['metamon.env.metamon_battle']=types.SimpleNamespace(MetamonBackendBattle=Battle)
sys.modules['metamon.interface']=types.SimpleNamespace(
 UniversalState=types.SimpleNamespace(from_Battle=lambda b:object()),
 UniversalAction=types.SimpleNamespace(definitely_valid_actions=lambda s,b:[0,1] if b.trapped else [0,1,2]))
w.structural_choice=lambda order,r:({'kind':'switch','switchSlot':6} if order==2 else {'kind':'move','moveSlot':order+1,'terastallize':False})
room='battle-gen9uu-offline';h='sha256:'+'a'*64
identity={'roomId':room,'rqid':1,'snapshotHash':h,'legalActionSetHash':h,'stateRevision':1,'requestKind':'move'}
request={'rqid':1,'side':{'id':'p1','pokemon':[{'ident':'p1: M'+str(i)} for i in range(6)]},'active':[{'maybeTrapped':True,'moves':[{'id':'a'},{'id':'b'}]}]}
trapped=copy.deepcopy(request);trapped['active'][0]={'trapped':True,'moves':[{'id':'a'},{'id':'b'}]}
error="|error|[Unavailable choice] Can't switch: The active Pokémon is trapped"
Policy=w.KakunaPolicy
for split,stage in ((False,False),(True,False),(False,True),(True,True)):
 p=object.__new__(Policy);p.pending=None;p.step=0;p.hidden=0;p.previous_state=None;p.previous_action=Array()
 p.experiment=types.SimpleNamespace(DEVICE='fake',caster=contextlib.nullcontext)
 p.model=types.SimpleNamespace(action_space=types.SimpleNamespace(action_to_agent_output=lambda s,a:a,
  agent_output_to_action=lambda s,a:types.SimpleNamespace(to_BattleOrder=lambda b:a)),
  observation_space=types.SimpleNamespace(state_to_obs=lambda s:{'x':Array()}))
 p.wrapper=types.SimpleNamespace(add_illegal_action_mask_to_obs=lambda *a:None,make_action_rep=lambda a:a)
 forwards=[]
 def forward(**kw):
  forwards.append(kw);p.last_dist=types.SimpleNamespace(probs=Vector([.1,.3,.6]));return types.SimpleNamespace(item=lambda:0 if stage else 2),p.hidden+1
 p.policy=types.SimpleNamespace(get_actions=forward)
 w.KakunaPolicy=lambda *a:p;w.check_runtime=lambda *a:None
 messages=[]
 def observe(data,seq,new=False):
  ctx={'roomId':room,'side':'p1','format':'gen9uu','sequence':seq,'identity':{**identity,'stateRevision':2} if new else identity}
  messages.append({'op':'observe','data':data,'context':ctx})
 def binding(seq,new=False):return {'requestId':'retry' if new else 'original','identity':{**identity,'stateRevision':2} if new else identity,'resultHash':h,'sequence':seq}
 observe('|request|'+json.dumps(request),1);messages.append({'op':'propose',**binding(1)})
 if stage:messages.append({'op':'stage_switch',**binding(1),'choice':{'kind':'switch','switchSlot':6}})
 if split:observe(error,2);observe('|request|'+json.dumps(trapped),3,True)
 else:observe(error+'\n|request|'+json.dumps(trapped),2,True)
 seq=3 if split else 2
 messages.append({'op':'propose',**binding(seq,True)})
 # An idempotent proposal must neither redraw nor step the model.
 messages.append({'op':'propose',**binding(seq,True)})
 replies=[]
 class Transport:
  def readline(self):
   if not messages:return None
   m=messages.pop(0);return (json.dumps({'version':w.VERSION,'id':len(replies)+1,**m})+'\n').encode()
  def reply(self,wire,r):replies.append(r)
 w.RpcInput=Transport;sys.argv=['worker','--checkpoint','unused'];w.main()
 assert all(r['ok'] for r in replies),replies
 first=replies[1];retry=replies[-1]
 assert first['choice']['kind']==('move' if stage else 'switch') and retry['choice']['kind']=='move'
 assert retry['choice']==replies[-2]['choice']
 assert len(forwards)==1 and p.hidden==1 and p.step==1
 assert draws[-1]==[.25,.7499999999999999,0.0],draws
 # Commit the new mapping only; the rejected switch is no longer executable.
 p.resolve_index(retry['choice'])
 try:p.resolve_index({'kind':'switch','switchSlot':6});raise AssertionError('rejected switch remained legal')
 except w.WorkerError:pass
 p.commit(retry['choice']);assert p.pending is None
assert len(draws)==4
for bad in (error+'!', error+'\n|turn|2', error+'\n|request|'+json.dumps({**trapped,'rqid':2}),
            error+'\n|request|'+json.dumps({**trapped,'active':[{'maybeTrapped':True}]})):
 d=w.SocketlessBattle();ctx={'roomId':room,'side':'p1','format':'gen9uu','sequence':1,'identity':identity}
 d.observe('|request|'+json.dumps(request),ctx)
 try:d.observe(bad,{**ctx,'sequence':2},True);raise AssertionError('invalid trapped exchange accepted')
 except w.WorkerError:pass
 assert len(d.battle.requests)==1,'invalid exchange reached parse_request'
sys.__stdout__.write('trapped conditional PASS; one forward/hidden step; same generator; split and combined\n')
`;
  const result = await promisify(execFile)("python3", ["-B", "-c", code, workerPath], { timeout: 5000 });
  assert.match(result.stdout, /trapped conditional PASS/);
});

// Matters: the re-ranker must reweight exactly what Metamon samples from. Our wrappers add one optional reply field and
// nothing else (identical replies and RNG draws otherwise); the field is the legal conditional keyed by the pinned
// decoder's own choices with aliases summed, a trapped re-choice reports its new legal set, and the worker's real
// two-stage sampler (first draw over all 13 indices, legal redraw) produces exactly the reported marginal.
test("wrapper-exposed actionProbabilities equal the pinned worker's sampled legal conditional and change nothing else", async () => {
  const helper = fileURLToPath(new URL("../../../../scripts/metamon_port/action_probs.py", import.meta.url));
  const code = String.raw`
import contextlib,copy,importlib.util,json,random,sys,types
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class Array:
 def __getitem__(self,key):return self
 def to(self,*args):return self
 def unsqueeze(self,*args):return self
class Vector:
 def __init__(self,x):self.x=list(x)
 def __getitem__(self,key):return self
 def __setitem__(self,key,value):
  for i in key:self.x[i]=value
 def float(self):return self
 def cpu(self):return self
 def tolist(self):return list(self.x)
 def sum(self):return sum(self.x)
 def __mul__(self,other):return Vector([a*b for a,b in zip(self.x,other.x)])
 def __truediv__(self,n):return Vector([a/n for a in self.x])
state={'rng':random.Random(19),'draws':[]}
def multinomial(probs,n):
 state['draws'].append(list(probs.x))
 return types.SimpleNamespace(item=lambda:state['rng'].choices(range(len(probs.x)),weights=probs.x)[0])
sys.modules['torch']=types.SimpleNamespace(no_grad=contextlib.nullcontext,from_numpy=lambda x:x,
 zeros_like=lambda p:Vector([0]*len(p.x)),multinomial=multinomial)
sys.modules['numpy']=types.SimpleNamespace(newaxis=None,array=lambda *a,**kw:Array(),zeros=lambda *a,**kw:Array(),float32='f',int64='i')
class Timestep:
 def __init__(self,**kw):pass
 def as_input(self):return {'x':Array()},Array(),Array()
sys.modules['amago.hindsight']=types.SimpleNamespace(Timestep=Timestep)
for name in ('metamon','metamon.rl','metamon.rl.pretrained'):sys.modules[name]=types.ModuleType(name)
class Battle:
 def __init__(self,*args):self.trapped=False
 def parse_message(self,line):pass
 def parse_request(self,r):self.trapped=r['active'][0].get('trapped',False)
sys.modules['metamon.env.metamon_battle']=types.SimpleNamespace(MetamonBackendBattle=Battle)
sys.modules['metamon.interface']=types.SimpleNamespace(
 UniversalState=types.SimpleNamespace(from_Battle=lambda b:object()),
 UniversalAction=types.SimpleNamespace(definitely_valid_actions=lambda s,b:[0,1,3] if b.trapped else [0,1,2,3]))
# Index 3 aliases move 2 (as Struggle/Recharge aliases do): its mass must add to move 2's.
choice_of=lambda order:{'kind':'switch','switchSlot':6} if order==2 else {'kind':'move','moveSlot':2 if order==3 else order+1,'terastallize':False}
room='battle-gen9uu-offline';h='sha256:'+'a'*64
identity={'roomId':room,'rqid':1,'snapshotHash':h,'legalActionSetHash':h,'stateRevision':1,'requestKind':'move'}
request={'rqid':1,'side':{'id':'p1','pokemon':[{'ident':'p1: M'+str(i)} for i in range(6)]},'active':[{'maybeTrapped':True,'moves':[{'id':'a'},{'id':'b'}]}]}
trapped=copy.deepcopy(request);trapped['active'][0]={'trapped':True,'moves':[{'id':'a'},{'id':'b'}]}
error="|error|[Unavailable choice] Can't switch: The active Pokémon is trapped"
# 13-way stored distribution with illegal floor mass, like upstream's clip_prob_low.
STORED=[.1,.2,.5,.1]+[.01]*9
def run(worker_path,install=None):
 w=load('worker',worker_path);w.structural_choice=lambda order,r:choice_of(order)
 state['rng']=random.Random(19);state['draws']=[]
 Policy=w.KakunaPolicy
 p=object.__new__(Policy);p.pending=None;p.step=0;p.hidden=0;p.previous_state=None;p.previous_action=Array()
 p.experiment=types.SimpleNamespace(DEVICE='fake',caster=contextlib.nullcontext)
 p.model=types.SimpleNamespace(action_space=types.SimpleNamespace(action_to_agent_output=lambda s,a:a,
  agent_output_to_action=lambda s,a:types.SimpleNamespace(to_BattleOrder=lambda b:a)),
  observation_space=types.SimpleNamespace(state_to_obs=lambda s:{'x':Array()}))
 p.wrapper=types.SimpleNamespace(add_illegal_action_mask_to_obs=lambda *a:None,make_action_rep=lambda a:a)
 def forward(**kw):
  # The first draw lands on an illegal index (12), so the worker redraws from the legal conditional.
  p.last_dist=types.SimpleNamespace(probs=Vector(STORED));return types.SimpleNamespace(item=lambda:12),p.hidden+1
 p.policy=types.SimpleNamespace(get_actions=forward)
 def ctx(seq,new=False):return {'roomId':room,'side':'p1','format':'gen9uu','sequence':seq,'identity':{**identity,'stateRevision':2} if new else identity}
 def binding(seq,new=False):return {'requestId':'retry' if new else 'original','identity':{**identity,'stateRevision':2} if new else identity,'resultHash':h,'sequence':seq}
 messages=[{'op':'observe','data':'|request|'+json.dumps(request),'context':ctx(1)},{'op':'propose',**binding(1)},
  {'op':'stage_switch',**binding(1),'choice':{'kind':'switch','switchSlot':6}},
  {'op':'observe','data':error+'\n|request|'+json.dumps(trapped),'context':ctx(2,True)},{'op':'propose',**binding(2,True)},
  {'op':'propose',**binding(2,True)},{'op':'commit',**binding(2,True),'choice':{'kind':'move','moveSlot':1,'terastallize':False}}]
 replies=[]
 class Transport:
  def readline(self):
   if not messages:return None
   m=messages.pop(0);return (json.dumps({'version':w.VERSION,'id':len(replies)+1,**m})+'\n').encode()
  def reply(self,wire,r):replies.append(r)
 w.RpcInput=Transport;w.check_runtime=lambda *a:None
 if install:install(w)
 w.KakunaPolicy=lambda *a:p
 sys.argv=['worker','--checkpoint','unused'];w.main()
 return w,replies,list(state['draws'])
worker_path,helper_path=sys.argv[1],sys.argv[2]
ap=load('action_probs',helper_path)
_,base,base_draws=run(worker_path)
w,exposed,exposed_draws=run(worker_path,ap.install)
assert all(r['ok'] for r in exposed),exposed
assert base_draws==exposed_draws and len(base_draws)==2,'identical RNG path: one redraw per proposal'
strip=lambda r:{k:v for k,v in r.items() if k!='actionProbabilities'}
assert [strip(r) for r in exposed]==base,'every reply is unchanged apart from the one optional field'
has=[('actionProbabilities' in r) for r in exposed]
assert has==[False,True,False,False,True,True,False],has
close=lambda a,b:set(a)==set(b) and all(abs(a[k]-b[k])<1e-12 for k in a)
assert close(exposed[1]['actionProbabilities'],{'move 1':.1/.9,'move 2':.3/.9,'switch 6':.5/.9}),exposed[1]
assert close(exposed[4]['actionProbabilities'],{'move 1':.1/.4,'move 2':.3/.4}),'trapped re-choice: the new legal set'
assert exposed[5]['actionProbabilities']==exposed[4]['actionProbabilities'],'an idempotent proposal repeats it'
assert base_draws[1]==[.25,.5,0.0,.25]+[0.0]*9,base_draws
# The marginal of the worker's own two-stage sampler equals the reported conditional.
legal=[0,1,2,3];mapping=[(choice_of(i),i) for i in legal]
reported=ap.legal_distribution(STORED,mapping)
policy=object.__new__(load('worker2',worker_path).KakunaPolicy);policy.last_dist=types.SimpleNamespace(probs=Vector(STORED))
rng=random.Random(7);state['rng']=random.Random(8);counts={}
N=60000
for _ in range(N):
 first=rng.choices(range(13),weights=STORED)[0]
 index=first if first in legal else policy.redraw(legal)
 token=ap.choice_token(choice_of(index));counts[token]=counts.get(token,0)+1
for token,prob in reported.items():
 sigma=(prob*(1-prob)/N)**.5
 assert abs(counts.get(token,0)/N-prob)<5*sigma,(token,counts,reported)
assert set(counts)==set(reported)
sys.__stdout__.write('actionProbabilities PASS '+json.dumps(reported)+'\n')
`;
  const result = await promisify(execFile)("python3", ["-B", "-c", code, workerPath, helper], { timeout: 60_000 });
  assert.match(result.stdout, /actionProbabilities PASS/);
});

// Matters: the UU lead model replaces the "Random lead" text, not the worker's behaviour. On a team preview our wrapper adds
// one reply field and nothing else: the official random draw (and every reply) is identical with it, the model's
// alphabetical probabilities land on the right request slots, opponents are base species as in training, and every
// refusal (missing or changed checkpoint, load or inference error, short opponent preview, unmatched team) is an
// explicit status while the worker keeps going. A loader that consumed the global RNG would change the draw: checked.
test("lead model adds leadModel to the team-preview reply only, maps slots, refuses loudly and never moves the random draw", async () => {
  const helpers = ["action_probs.py", "lead_model.py"].map((name) => fileURLToPath(new URL(`../../../../scripts/metamon_port/${name}`, import.meta.url)));
  const code = String.raw`
import contextlib,hashlib,importlib.util,json,os,random,re,sys,tempfile,types
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
norm=lambda s:re.sub(r'[^a-z0-9]','',s.lower())
calls={'load':0,'predict':[]}
mode={'load':'ok','predict':'ok','drop':False}
class Mon:
 def __init__(self,sp):self.species=norm(sp);self.base_species=norm(sp.split('-')[0])
class Battle:
 def __init__(self,*a):self.team={};self.teampreview_opponent_team=[]
 def parse_message(self,parts):
  if len(parts)>3 and parts[1]=='poke' and parts[2]=='p2':self.teampreview_opponent_team.append(Mon(parts[3].split(',')[0]))
 def parse_request(self,r):
  # Reversed and keyed by species: the wrapper must map by species, never by dict order.
  for m in reversed(r['side']['pokemon'][1:] if mode['drop'] else r['side']['pokemon']):
   sp=m['details'].split(',')[0];self.team['p1 '+sp]=Mon(sp)
class Probs(list):
 def tolist(self):return list(self)
class Model:
 def predict_lead(self,names,moves,abilities,items,opponents,battle_format='unset',device=None):
  random.random()
  assert battle_format is None and device=='cpu',(battle_format,device)
  calls['predict'].append(list(opponents))
  if mode['predict']=='raise':raise RuntimeError('boom')
  ordered=sorted(names);return ordered[-1],Probs([.05,.1,.15,.2,.22,.28]),ordered
class TeamPreviewModel:
 @classmethod
 def load_from_checkpoint(cls,path,device=None,use_argmax=False):
  calls['load']+=1;random.random();random.random()  # a real nn.Module init draws from the RNGs
  assert device=='cpu' and use_argmax is True
  if mode['load']=='raise':raise RuntimeError('bad checkpoint')
  return Model()
rng={'torch':0}
sys.modules['torch']=types.SimpleNamespace(get_rng_state=lambda:rng['torch'],set_rng_state=lambda s:rng.update(torch=s))
sys.modules['numpy']=types.SimpleNamespace(random=types.SimpleNamespace(get_state=lambda:None,set_state=lambda s:None))
for name in ('metamon','metamon.rl','metamon.rl.pretrained','metamon.backend','metamon.backend.team_preview','metamon.backend.replay_parser'):sys.modules[name]=types.ModuleType(name)
sys.modules['metamon.backend.team_preview.preview']=types.SimpleNamespace(TeamPreviewModel=TeamPreviewModel)
sys.modules['metamon.backend.replay_parser.str_parsing']=types.SimpleNamespace(pokemon_name=norm)
sys.modules['metamon.interface']=types.SimpleNamespace(UniversalPokemon=types.SimpleNamespace(
 from_Pokemon=lambda p:types.SimpleNamespace(name=p.species,moves=[types.SimpleNamespace(name='knockoff')],ability='a',item='i')))
sys.modules['metamon.env.metamon_battle']=types.SimpleNamespace(MetamonBackendBattle=Battle)
sys.modules['poke_env.player']=types.SimpleNamespace(Player=types.SimpleNamespace(
 random_teampreview=lambda self,battle:'/team '+''.join(map(str,random.sample(range(1,7),6)))))
ours=['Scizor','Donphan','Arcanine-Hisui','Slowking','Thundurus','Ogerpon']
theirs=['Arcanine-Hisui','Rotom-Wash','Metagross','Umbreon','Zoroark-Hisui','Excadrill']
room='battle-gen9uu-offline';h='sha256:'+'a'*64
identity={'roomId':room,'rqid':1,'snapshotHash':h,'legalActionSetHash':h,'stateRevision':1,'requestKind':'team_preview'}
def run(worker_path,lead=None,opponents=theirs):
 w=load('worker',worker_path)
 data='\n'.join(['|clearpoke']+['|poke|p1|'+s+'|' for s in ours]+['|poke|p2|'+s+'|' for s in opponents]+['|teampreview',
  '|request|'+json.dumps({'teamPreview':True,'rqid':1,'side':{'id':'p1','pokemon':[{'ident':'p1: Mon '+str(i),'details':s+', F'} for i,s in enumerate(ours)]}})])
 binding={'requestId':'preview','identity':identity,'resultHash':h,'sequence':1}
 messages=[{'op':'observe','data':data,'context':{'roomId':room,'side':'p1','format':'gen9uu','sequence':1,'identity':identity}},
  {'op':'propose',**binding},{'op':'propose',**binding}]
 replies=[]
 class Transport:
  def readline(self):
   if not messages:return None
   m=messages.pop(0);return (json.dumps({'version':w.VERSION,'id':len(replies)+1,**m})+'\n').encode()
  def reply(self,wire,r):
   replies.append(r)
   if len(replies)==3:messages.append({'op':'commit',**binding,'choice':r['choice']})
 w.RpcInput=Transport;w.check_runtime=lambda *a:None
 ap.install(w)  # as live: both wrappers, chained
 if lead:lm.install(w,'unused',lead);lm.install(w,'unused',lm.LeadModel('/nonexistent'))  # the second install is a no-op
 w.KakunaPolicy=lambda *a:object()
 sys.argv=['worker','--checkpoint','unused','--seed','5']
 assert w.main() is None,replies
 return replies
worker_path,ap_path,lm_path=sys.argv[1:4]
ap=load('action_probs',ap_path);lm=load('lead_model',lm_path)
directory=tempfile.mkdtemp();ckpt=os.path.join(directory,'lead.pt');open(ckpt,'wb').write(b'lead weights')
sha=hashlib.sha256(b'lead weights').hexdigest()
base=run(worker_path)
assert [r['ok'] for r in base]==[True]*4 and not any('leadModel' in r for r in base),base
def field(lead,**kw):
 replies=run(worker_path,lead,**kw)
 assert all(r['ok'] for r in replies),replies
 assert [{k:v for k,v in r.items() if k!='leadModel'} for r in replies]==base,'every reply, including the random draw, is unchanged'
 assert ['leadModel' in r for r in replies]==[False,True,True,False],'only the team-preview propose replies carry it'
 assert replies[1]['leadModel']==replies[2]['leadModel'],'a repeated propose repeats it'
 return replies[1]['leadModel']
ok=field(lm.LeadModel(ckpt,sha))
assert isinstance(ok.pop('inferenceMs'),float)
# Alphabetical arcaninehisui .05, donphan .1, ogerpon .15, scizor .2, slowking .22, thundurus .28 -> request slots.
assert ok=={'status':'ok','checkpointSha256':sha,'leadProbabilities':[.2,.1,.05,.22,.28,.15]},ok
assert calls['predict'][-1]==['arcanine','rotom','metagross','umbreon','zoroark','excadrill'],'opponents are base species, as in training'
assert calls['load']==1
unavailable=lambda reason,expected=sha:{'status':'unavailable','reason':reason,'checkpointSha256':expected}
assert field(lm.LeadModel(os.path.join(directory,'absent.pt'),sha))==unavailable('checkpoint_missing')
assert field(lm.LeadModel(ckpt))==unavailable('checkpoint_mismatch',lm.SHA256),'the pinned SHA256 refuses other bytes'
assert calls['load']==1,'a refused checkpoint is never loaded'
mode['load']='raise';assert field(lm.LeadModel(ckpt,sha))==unavailable('load_failed');mode['load']='ok'
mode['predict']='raise';assert field(lm.LeadModel(ckpt,sha))==unavailable('inference_failed');mode['predict']='ok'
assert field(lm.LeadModel(ckpt,sha),opponents=theirs[:4])==unavailable('opponent_not_6')
mode['drop']=True;assert field(lm.LeadModel(ckpt,sha))==unavailable('team_unmatched');mode['drop']=False
# The guard bites: without RNG preservation the loader's draws move the official random preview.
lm.rng_preserved=contextlib.nullcontext
moved=run(worker_path,lm.LeadModel(ckpt,sha))
assert moved[1]['choice']!=base[1]['choice'],'test cannot see an RNG leak'
sys.__stdout__.write('leadModel PASS\n')
`;
  const result = await promisify(execFile)("python3", ["-B", "-c", code, workerPath, ...helpers], { timeout: 30_000 });
  assert.match(result.stdout, /leadModel PASS/);
});

test("trapped recovery rejects every other error, chunk, rqid, request shape and pending move", async () => {
  const trapped = { rqid: 1, side: { id: "p1" }, active: [{ trapped: true }] };
  const frame = (r: unknown) => `|request|${JSON.stringify(r)}`;
  assert.equal(trappedSwitchRejection(TRAPPED_SWITCH_ERROR, 1), false);
  assert.equal(trappedSwitchRejection(frame(trapped), 1, true), true);
  assert.equal(trappedSwitchRejection(`${TRAPPED_SWITCH_ERROR}\n${frame(trapped)}`, 1), true);
  for (const data of ["|turn|2", frame(trapped), `${TRAPPED_SWITCH_ERROR}!`, `${TRAPPED_SWITCH_ERROR}\n|turn|2`,
    `${TRAPPED_SWITCH_ERROR}\n${frame(trapped)}\n${frame(trapped)}`, `${TRAPPED_SWITCH_ERROR}\n${frame({ ...trapped, rqid: 2 })}`,
    `${TRAPPED_SWITCH_ERROR}\n${frame({ ...trapped, active: [{ maybeTrapped: true }] })}`,
    `${TRAPPED_SWITCH_ERROR}\n${frame({ ...trapped, wait: true })}`, `${TRAPPED_SWITCH_ERROR}\n${frame({ ...trapped, forceSwitch: [true] })}`]) {
    assert.throws(() => trappedSwitchRejection(data, 1));
  }
  for (const data of ["", TRAPPED_SWITCH_ERROR, "|turn|2"]) assert.throws(() => trappedSwitchRejection(data, 1, true));
  const p = policy();
  try {
    const current = input();
    current.envelope.semantic.snapshot.legalActions = [{ id: "base", kind: "move", label: "Bullet Punch", moveSlot: 2, choice: "move 2", terastallize: false }];
    await p.observe(request(), context(), options()); await p.decide(current, options());
    await assert.rejects(p.observe(`${TRAPPED_SWITCH_ERROR}\n${frame(trapped)}`, { ...context(), sequence: 2 }, options()), /uncommitted_action/);
  } finally { await p.close(); }
});
