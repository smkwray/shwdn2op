import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { BattleObservation } from "../state/decisionEngine.js";
import type { LiveEvent } from "../battle-agent/liveMetamon.js";

// All new test artifacts stay inside the permitted source tree and are removed.
const directory = await fs.mkdtemp(fileURLToPath(new URL("./.live-metamon-", import.meta.url)));
process.env.LOCAL_INTEL_STORE_PATH = path.join(directory, "intel.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(directory, "curated.json");
const { LiveMetamonAdvisor, pickInput, readLiveMetamonLaunch } = await import("../battle-agent/liveMetamon.js");
const { DecisionEngine } = await import("../state/decisionEngine.js");
const { MetamonBattlePolicy } = await import("../battle-agent/metamon.js");
const { buildDecisionEnvelope } = await import("../state/decisionEnvelope.js");
const { createEphemeralIntelEvaluationContext } = await import("../history/opponentIntelStore.js");
const { buildServer } = await import("../server.js");
after(() => fs.rm(directory, { recursive: true, force: true }));
const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/liveMetamon.json", import.meta.url), "utf8"));
const roomId = "battle-gen9uu-live-test", sessionId = "live-test";
const mockWorker = String.raw`
const fs=require('node:fs'), rl=require('node:readline').createInterface({input:process.stdin});
let pending=false,request;
function log(m){fs.appendFileSync(process.env.LIVE_TEST_LOG,JSON.stringify({...m,pid:process.pid})+'\n');}
rl.on('line', line=>{
 const m=JSON.parse(line);log(m);
 if(process.env.LIVE_TEST_FAIL==='1'){process.stdout.write('bad json\n');return;}
 if(process.env.LIVE_TEST_HANG==='1')return;
 const r={version:m.version,id:m.id,ok:true};
 if(m.op==='observe'){
  if(pending && !m.data.startsWith("|error|[Unavailable choice] Can't switch: The active Pokémon is trapped") && !request?.active?.[0]?.maybeTrapped)throw Error('uncommitted action');
  r.context=m.context;
  // As the pinned worker: the first request is rqid 1, then each is the previous +1 (or the same on a trapped retry).
  for(const line of m.data.split('\n'))if(line.startsWith('|request|')){const n=JSON.parse(line.slice(9));if(n.rqid!==(request?.rqid??0)+1&&n.rqid!==request?.rqid)throw Error('identity: rqid '+n.rqid+' after '+request?.rqid);request=n;}
 }else{
  if(m.identity.rqid!==request.rqid)throw Error('identity: binding rqid');
  r.binding={requestId:m.requestId,identity:m.identity,resultHash:m.resultHash,sequence:m.sequence};
  r.choice=['commit','stage_switch'].includes(m.op)?m.choice:request.teamPreview?{kind:'team',team:[1,2,3,4,5,6]}:request.forceSwitch?{kind:'switch',switchSlot:2}:process.env.LIVE_TEST_SWITCH==='1' && !request.active?.[0]?.trapped?{kind:'switch',switchSlot:2}:{kind:'move',moveSlot:1,terastallize:process.env.LIVE_TEST_TERA==='1'};
  // As our wrappers: the worker's own legal-action distribution on a network (non-preview) proposal.
  if(m.op==='propose' && process.env.LIVE_TEST_PROBS==='1' && r.choice.kind==='move')r.actionProbabilities={'move 1':0.9,'move 2':0.1};
  if(m.op==='propose' && process.env.LIVE_TEST_PROBS_JSON && r.choice.kind==='move')r.actionProbabilities=JSON.parse(process.env.LIVE_TEST_PROBS_JSON);
  // As our lead-model wrapper: one field on the team-preview proposal; the proposal itself stays the random draw.
  if(m.op==='propose' && process.env.LIVE_TEST_LEAD_JSON && r.choice.kind==='team')r.leadModel=JSON.parse(process.env.LIVE_TEST_LEAD_JSON);
  pending=m.op!=='commit';
 }
 const reply=()=>process.stdout.write(JSON.stringify(r)+'\n');
 if(m.op==='propose' && Number(process.env.LIVE_TEST_DELAY_MS))setTimeout(reply,Number(process.env.LIVE_TEST_DELAY_MS));else reply();
});
rl.on('close',()=>{log({op:'eof'});process.exit(0);});
`;
const species = ["Scizor", "Donphan", "Arcanine-Hisui", "Slowking", "Thundurus", "Ogerpon"];
function side(active = 0) {
  return { id: "p1", name: "Player 1", pokemon: species.map((name, index) => ({ ident: `p1: ${name}`, details: name,
    condition: "300/300", active: index === active, baseAbility: "Pressure", item: "", moves: ["knockoff", "voltswitch"],
    stats: { hp: 300, atk: 200, def: 200, spa: 200, spd: 200, spe: 200 } })) };
}
const request = (rqid: number, extra: object = {}) => ({ rqid, side: side(), active: [{ canTerastallize: "Flying", moves: [
  { id: "knockoff", move: "Knock Off", pp: 20 }, { id: "voltswitch", move: "Volt Switch", pp: 20 }
] }], ...extra });
const line = (r: object) => `|request|${JSON.stringify(r)}`;
let serial = 0;
async function harness(options: { idleMs?: number; operationMs?: number; now?: () => number; hang?: boolean; fail?: boolean; switch?: boolean; journalDir?: string; probs?: boolean; tera?: boolean; maxWorkers?: number; distribution?: Record<string, number>; delayMs?: number; lead?: object } = {}) {
  const logFile = path.join(directory, `rpc-${++serial}.jsonl`);
  const launch = { command: process.execPath, args: ["-e", mockWorker, "seed={seed}"], env: { LIVE_TEST_LOG: logFile, LIVE_TEST_HANG: options.hang ? "1" : "0", LIVE_TEST_FAIL: options.fail ? "1" : "0", LIVE_TEST_SWITCH: options.switch ? "1" : "0", LIVE_TEST_PROBS: options.probs ? "1" : "0", LIVE_TEST_TERA: options.tera ? "1" : "0",
    ...(options.distribution ? { LIVE_TEST_PROBS_JSON: JSON.stringify(options.distribution) } : {}),
    ...(options.lead ? { LIVE_TEST_LEAD_JSON: JSON.stringify(options.lead) } : {}), LIVE_TEST_DELAY_MS: String(options.delayMs ?? 0) } };
  const advisor = new LiveMetamonAdvisor(launch, { ...options, operationMs: options.operationMs ?? 3000 });
  const engine = new DecisionEngine(), context = await createEphemeralIntelEvaluationContext();
  let sequence = 0, eventSequence = 0;
  const event = (fields: any): LiveEvent => ({ sessionId, roomId, eventId: `event-${++eventSequence}`, sequence: eventSequence, ...fields });
  const records: any[] = [];
  return { advisor, engine, context, launch, logFile, event, records,
    async frame(data: string, source: "protocol" | "recovery" = "protocol", settle = true) {
      const observation: BattleObservation = { sessionId, roomId, observationId: `frame-${++sequence}`, sequence, source, data: `>${roomId}\n${data}` };
      const current = await engine.ingest(observation);
      const accepted = { observation, current, context }; records.push({ ...accepted, data });
      advisor.accept([event({ kind: "observation", observationId: observation.observationId })], [accepted]);
      if (settle) await advisor.settled();
      return current;
    },
    async choice(data: string) { advisor.accept([event({ kind: "choice", data })]); await advisor.settled(); },
    async preview() { return this.frame(`|init|battle\n${fixture.replay.preview}\n${line({ rqid: 1, teamPreview: true, side: side(-1) })}`); },
    async turn() { return this.frame(`|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(2))}`); },
    async log() { return (await fs.readFile(logFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Matters: the recurrent network must see exactly the same side-private history as the offline adapter.
test("live Metamon replay observe order equals simulator observe/decide/commit order", async () => {
  const h = await harness();
  const referenceLog = path.join(directory, "reference.jsonl");
  const reference = new MetamonBattlePolicy({ ...h.launch, env: { LIVE_TEST_LOG: referenceLog } });
  try {
    await h.preview(); await h.choice("/choose team 512346|1");
    await h.frame(`${fixture.replay.start}\n${line(request(2, { side: side(4) }))}`);
    await h.choice("/choose move 1|2");
    await h.frame(`${fixture.replay.turn1}\n${line(request(3, { side: side(4) }))}`);
    const logs = (await h.log()).filter((m) => m.op !== "eof");
    assert.deepEqual(logs.map((m) => m.op), ["observe", "propose", "commit", "observe", "propose", "commit", "observe", "propose"]);
    // Same literal chunks/context and exact executed choices through the simulator's direct policy API.
    for (const m of logs) {
      const op = { deadlineAt: Date.now() + 3000, signal: new AbortController().signal };
      if (m.op === "observe") await reference.observe(m.data, m.context, op);
      else {
        const record = h.records.find((r) => r.current.identity?.rqid === m.identity.rqid);
        // The live advisor's own input: the request view alone (the deterministic sections no longer gate the pick).
        const envelope = await pickInput(record.current.snapshot, record.current.identity);
        const input = { requestId: m.requestId, envelope };
        if (m.op === "propose") await reference.decide(input, op);
        else {
          const token = m.choice.kind === "team" ? `team ${m.choice.team.join("")}` : `move ${m.choice.moveSlot}`;
          const actionId = envelope.semantic.snapshot.legalActions.find((a) => a.choice === token)!.id;
          await reference.commit(input, { requestId: m.requestId, identity: m.identity, actionId }, op);
        }
      }
    }
    const direct = (await fs.readFile(referenceLog, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(logs.map(({ pid, ...m }) => m), direct.map(({ pid, ...m }) => m));
    assert.equal(logs.filter((m) => m.op === "propose").length, 3, "every request proposes once");
  } finally { await h.advisor.close(); await reference.close(); }
});

// Matters: recurrence follows the human's final choice, even when it differs from the suggestion.
test("live Metamon commits final /undo, preview, Tera and forced-switch human choices", async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice("/choose team 213456|1"); await h.choice("/undo|1"); await h.choice("/choose team 123456|1"); await h.turn();
    await h.choice("/choose move 1|2"); await h.choice("/undo|2"); await h.choice("/choose move 2 terastallize|2");
    await h.frame(`|-terastallize|p1a: Scizor|Flying\n|move|p1a: Scizor|Volt Switch|p2a: Rotom\n${line(request(3, { forceSwitch: [true], active: undefined }))}`);
    await h.choice("/choose switch 2|3");
    await h.frame(`|switch|p1a: Donphan|Donphan|300/300\n|turn|2\n${line(request(4, { side: side(1) }))}`);
    assert.equal(h.advisor.status()[0]!.state, "ready");
    assert.deepEqual((await h.log()).filter((m) => m.op === "commit").map((m) => m.choice), [
      { kind: "team", team: [1, 2, 3, 4, 5, 6] }, { kind: "move", moveSlot: 2, terastallize: true }, { kind: "switch", switchSlot: 2 }
    ]);
    assert.equal((await h.log()).filter((m) => m.op === "propose").length, 4);
  } finally { await h.advisor.close(); }
});

// Matters: Chrome sends team preview as `/team 321456|1` (old client) or `/choose team 3, 1, ...|1` (Preact client);
// a lead-only order is completed exactly as the simulator completes it.
for (const [data, team] of [["/team 321456|1", [3, 2, 1, 4, 5, 6]], ["/team 3|1", [3, 1, 2, 4, 5, 6]],
  ["/choose team 3, 1, 2, 4, 5, 6|1", [3, 1, 2, 4, 5, 6]]] as const) test(`live Metamon commits real-client preview choice ${data}`, async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice(data);
    await h.frame(`|start\n|switch|p1a: Arcanine-Hisui|Arcanine-Hisui|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(2, { side: side(2) }))}`);
    assert.equal(h.advisor.status()[0]!.state, "ready");
    assert.deepEqual((await h.log()).filter((m) => m.op === "commit").map((m) => m.choice), [{ kind: "team", team }]);
  } finally { await h.advisor.close(); }
});

// Matters: after a page reload or a restarted extension worker, the page replays the whole battle from |init| mid-game.
// Requiring team preview made Metamon "sync lost" for the rest of the battle; it must restart and say it resynced.
test("live Metamon restarts from a mid-battle full replay and labels the pick as resynced", async () => {
  const h = await harness();
  try {
    await h.frame(`|init|battle\n${fixture.replay.preview}\n|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n|move|p1a: Scizor|Knock Off|p2a: Rotom\n|turn|2\n${line(request(7))}`);
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]!.state, "ready");
    const advice = (h.advisor as any).rooms.values().next().value.advice;
    assert.match(advice.label, /\(resynced mid-battle\)$/);
  } finally { await h.advisor.close(); }
});

// Matters: on one Chromium browser the client replayed the battle from |init| in the SAME capture session
// six seconds into a game, and the advisor went "sync lost (Battle replaced)" for the rest of it. A same-session replay
// must restart the worker from the full log and keep advising, labelled as resynced.
test("live Metamon restarts on a same-session full replay instead of losing sync", async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice("/choose team 123456|1"); await h.turn();
    const before = h.advisor.status()[0]!;
    assert.equal(before.state, "ready");
    await h.frame(`|init|battle\n${fixture.replay.preview}\n|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n|move|p1a: Scizor|Knock Off|p2a: Rotom\n|turn|2\n${line(request(7))}`);
    await h.advisor.settled();
    const after = h.advisor.status()[0]!;
    assert.equal(after.state, "ready", `reason: ${after.reason}`);
    assert.notEqual(after.pid, before.pid, "a fresh worker reads the full log");
    assert.match((h.advisor as any).rooms.values().next().value.advice.label, /\(resynced mid-battle\)$/);
  } finally { await h.advisor.close(); }
});

// Matters: after a companion restart the browser's capture continues mid-sequence, and a lost room used to stay lost for
// the rest of the game. A mid-capture first event is not a gap, and the client's |init| replay revives the room.
test("live Metamon revives a sync-lost room from a full replay, including after a companion restart", async () => {
  const h = await harness();
  try {
    await h.preview();
    h.advisor.accept([{ ...h.event({ kind: "choice", data: "/choose team 123456" }), sequence: 99 }]); // a real gap
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]!.reason, "sync_lost");
    await h.frame(`|init|battle\n${fixture.replay.preview}\n|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n|move|p1a: Scizor|Knock Off|p2a: Rotom\n|turn|2\n${line(request(7))}`);
    await h.advisor.settled();
    const revived = h.advisor.status()[0]!;
    assert.equal(revived.state, "ready", `reason: ${revived.reason}`);
    assert.match((h.advisor as any).rooms.values().next().value.advice.label, /\(resynced mid-battle\)$/);
  } finally { await h.advisor.close(); }
});

// Matters: a reload or restarted extension worker opens a new session for the same battle; the old one still held the
// one-model lock, so the new worker could not load. The newer session for that battle takes over immediately.
test("live Metamon hands the model to a newer session for the same battle at once", async () => {
  const h = await harness();
  try {
    await h.preview();
    const oldPid = h.advisor.status()[0]!.pid!;
    const observation = { sessionId: "live-test-reloaded", roomId, observationId: "r-1", sequence: 1, source: "protocol" as const,
      data: `>${roomId}\n|init|battle\n${fixture.replay.preview}\n${line({ rqid: 1, teamPreview: true, side: side(-1) })}` };
    const current = await h.engine.ingest(observation);
    h.advisor.accept([{ sessionId: "live-test-reloaded", roomId, eventId: "r-e1", sequence: 1, kind: "observation", observationId: "r-1" } as LiveEvent],
      [{ observation, current, context: h.context }]);
    await h.advisor.settled();
    const fresh = h.advisor.status().find((r) => r.sessionId === "live-test-reloaded")!;
    assert.equal(fresh.state, "ready"); assert.equal(alive(oldPid), false);
  } finally { await h.advisor.close(); }
});

// Matters: one model runs at a time (the MLX worker holds a lock). A battle abandoned without a leave (crashed tab,
// killed browser) held it for the 15-minute idle sweep and made the next real battle "sync lost". A holder silent for a
// minute hands the model over; a recently active one does not.
test("live Metamon hands the model to a new battle when the holder has been silent for a minute", async () => {
  let now = 1_000_000;
  const h = await harness({ now: () => now });
  try {
    await h.preview();
    const firstPid = h.advisor.status()[0]!.pid!;
    const start = async (n: number) => {
      const room = `battle-gen9uu-live-test-${n}`, sid = `live-test-${n}`;
      const observation = { sessionId: sid, roomId: room, observationId: `b-${n}`, sequence: 1, source: "protocol" as const,
        data: `>${room}\n|init|battle\n${fixture.replay.preview}\n${line({ rqid: 1, teamPreview: true, side: side(-1) })}` };
      const current = await h.engine.ingest(observation);
      h.advisor.accept([{ sessionId: sid, roomId: room, eventId: `b-e${n}`, sequence: 1, kind: "observation", observationId: observation.observationId } as LiveEvent],
        [{ observation, current, context: h.context }]);
      await h.advisor.settled();
      return Object.fromEntries(h.advisor.status().map((r) => [r.roomId, r]));
    };
    now += 30_000;
    assert.equal((await start(2))[roomId]!.state, "ready", "a holder active within the minute keeps the model");
    now += 61_000;
    const rooms = await start(3);
    assert.equal(rooms[roomId]!.reason, "idle"); assert.equal(alive(firstPid), false);
    assert.equal(rooms["battle-gen9uu-live-test-3"]!.state, "ready");
  } finally { await h.advisor.close(); }
});

// Matters: upstream Metamon rejects any team that is not 6 (UnusualTeamSize; trained on 6v6). A real opponent brought 4
// and the advisor died as "sync lost". The worker is fed 6 (its full-game parse then succeeds), and each pick says so.
test("live Metamon keeps advising against a 4-Pokemon opponent and labels the assumption", async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice("/team 123456|1");
    await h.frame(`|teamsize|p1|6\n|teamsize|p2|4\n|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(2))}`);
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]!.state, "ready");
    const advice = (h.advisor as any).rooms.values().next().value.advice;
    assert.match(advice.label, /\(opponent has 4; Metamon assumes 6\)$/);
    assert.ok((await h.log()).filter((m) => m.op === "observe").every((m) => !/\|teamsize\|p2\|4/.test(m.data)), "the worker never sees a non-6 team");
  } finally { await h.advisor.close(); }
});

// Matters: the in-battle box must say who to lead in words; a digit string ("Team order 642531") was unreadable mid-game.
// Kakuna has no lead model (the worker's preview is the official random draw, with no distribution), so the lead must
// read as random, never as a recommendation.
test("live Metamon labels the preview pick as a named lead and order drawn at random", async () => {
  const h = await harness();
  try {
    await h.preview(); await h.advisor.settled();
    const s = h.advisor.status()[0]!;
    assert.equal(s.state, "ready");
    const advice = (h.advisor as any).rooms.values().next().value.advice;
    assert.equal(advice.label, "Random lead: Scizor (then Donphan, Arcanine-Hisui, Slowking, Thundurus, Ogerpon); Metamon has no lead model");
    assert.equal(advice.basis, "random_preview"); assert.equal(advice.probability, null);
  } finally { await h.advisor.close(); }
});

// Matters: the UU lead model replaces the random lead on screen. It imitates rated human leads, so it reads as
// "Usual lead" with its probability and a close runner-up, never as "best"; the worker still proposes its random draw and
// learns the human's actual order; the journal keeps all six probabilities and the checkpoint; "followed" is the lead.
const LEAD_SHA = "317b5a21bebefd6093d3b11ed8e5bf22d07f80045082552736b36e5b4755dd8c";
test("live Metamon shows the lead model's usual lead with its probability and close runner-up, and journals it", async () => {
  const journalDir = path.join(directory, "journal-lead-model");
  const leadProbabilities = [0.33, 0.05, 0.41, 0.1, 0.06, 0.05];
  const h = await harness({ journalDir, lead: { status: "ok", checkpointSha256: LEAD_SHA, leadProbabilities, inferenceMs: 2.1 } });
  try {
    await h.preview(); await h.advisor.settled();
    const advice = (h.advisor as any).rooms.values().next().value.advice;
    assert.equal(advice.label, "Usual lead: Arcanine-Hisui (41%) · close: Scizor (33%)");
    assert.equal(advice.basis, "lead_model"); assert.equal(advice.probability, 0.41);
    assert.equal(advice.actionId, "team:312456", "the lead model's top slot, the rest in order");
    assert.equal(advice.sampledActionId, "team:123456", "the worker's own proposal stays its random draw");
    assert.deepEqual(advice.runnerUp, { actionId: "team:123456", label: "Lead Scizor", probability: 0.33 });
    assert.doesNotMatch(advice.label, /best/i);
    await h.choice("/team 365412|1");
    await h.frame(`|start\n|switch|p1a: Arcanine-Hisui|Arcanine-Hisui|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(2, { side: side(2) }))}`);
    await h.advisor.settled(); await h.advisor.close();
    assert.deepEqual((await h.log()).filter((m) => m.op === "commit").map((m) => m.choice), [{ kind: "team", team: [3, 6, 5, 4, 1, 2] }],
      "the worker learns the human's order");
    const [file] = await fs.readdir(journalDir);
    const journal = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const row = journal.find((r) => r.kind === "advice" && r.rqid === 1);
    assert.deepEqual(row.lead, { status: "ok", checkpointSha256: LEAD_SHA, leadProbabilities, inferenceMs: 2.1 });
    assert.equal(row.basis, "lead_model"); assert.equal(row.sampledActionId, "team:123456");
    assert.deepEqual(journal.filter((r) => r.kind === "commit").map((r) => [r.adviceActionId, r.actionId, r.followed]),
      [["team:312456", "team:365412", true]], "same lead, other order: followed");
  } finally { await h.advisor.close(); }
});

test("live Metamon shows no lead runner-up beyond the close margin", async () => {
  const h = await harness({ lead: { status: "ok", checkpointSha256: LEAD_SHA, leadProbabilities: [0.6, 0.1, 0.1, 0.1, 0.05, 0.05], inferenceMs: 1 } });
  try {
    await h.preview(); await h.advisor.settled();
    const advice = (h.advisor as any).rooms.values().next().value.advice;
    assert.equal(advice.label, "Usual lead: Scizor (60%)"); assert.equal(advice.runnerUp, undefined);
  } finally { await h.advisor.close(); }
});

// Matters: a refused or failed lead model must never silently look like advice or vanish: the strip falls
// back to the random draw and says why; a malformed field is a broken worker, shown as lost sync.
test("live Metamon falls back to the labelled random lead with the lead model's reason", async () => {
  const journalDir = path.join(directory, "journal-lead-off");
  const h = await harness({ journalDir, lead: { status: "unavailable", reason: "checkpoint_mismatch", checkpointSha256: LEAD_SHA } });
  try {
    await h.preview(); await h.advisor.settled();
    const advice = (h.advisor as any).rooms.values().next().value.advice;
    assert.equal(advice.label, "Random lead: Scizor (then Donphan, Arcanine-Hisui, Slowking, Thundurus, Ogerpon); lead model off (model file changed)");
    assert.equal(advice.basis, "random_preview"); assert.equal(advice.probability, null);
    await h.advisor.close();
    const [file] = await fs.readdir(journalDir);
    const journal = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(journal.find((r) => r.kind === "advice").lead, { status: "unavailable", reason: "checkpoint_mismatch", checkpointSha256: LEAD_SHA });
  } finally { await h.advisor.close(); }
  const broken = await harness({ lead: { status: "ok", checkpointSha256: LEAD_SHA, leadProbabilities: [1, 1, 0, 0, 0, 0], inferenceMs: 1 } });
  try {
    await broken.preview(); await broken.advisor.settled();
    assert.equal(broken.advisor.status()[0]!.state, "unavailable"); assert.equal(broken.advisor.status()[0]!.reason, "sync_lost");
  } finally { await broken.advisor.close(); }
});

// Matters: the shown pick was once the worker's temperature-1 sample with no probability; 6 of 39 picks
// were not Metamon's top choice (one at 0.4%) and the player followed all six. The shown pick is the most probable action
// with its probability, plus a close runner-up; the worker still samples and learns the human's action unchanged, the
// journal keeps the sample beside the shown pick, and "followed" is judged against what was shown.
test("live Metamon shows its most probable action with its probability and a close runner-up", async () => {
  const journalDir = path.join(directory, "journal-top");
  const h = await harness({ journalDir, distribution: { "move 1": 0.31, "move 2": 0.69 } });
  try {
    await h.preview(); await h.choice("/team 123456|1");
    const current = await h.turn();
    const envelope = await buildDecisionEnvelope(current.snapshot!, current.identity!, h.context, current.room.lastRequest!.side.pokemon);
    const advice = h.advisor.advice(sessionId, current.identity!);
    assert.equal(advice.status, "ready"); assert.equal(advice.actionId, "move:2|tera=0", "the top action, not the sampled Knock Off");
    assert.equal(advice.label, "Volt Switch (69%)"); assert.equal(advice.probability, 0.69); assert.equal(advice.basis, "top");
    assert.equal(advice.sampledActionId, "move:1|tera=0"); assert.equal(advice.runnerUp, undefined, "0.31 is not close to 0.69");
    await h.choice("/choose move 1|2");
    await h.frame(`|move|p1a: Scizor|Knock Off|p2a: Rotom
|upkeep
|turn|2
${line(request(3))}`);
    await h.advisor.settled(); await h.advisor.close();
    assert.deepEqual((await h.log()).filter((m) => m.op === "commit").map((m) => m.choice), [{ kind: "team", team: [1, 2, 3, 4, 5, 6] }, { kind: "move", moveSlot: 1, terastallize: false }],
      "the worker learns the human's action exactly as before");
    const [file] = await fs.readdir(journalDir);
    const journal = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const row = journal.find((r) => r.kind === "advice" && r.rqid === 2);
    assert.deepEqual([row.actionId, row.sampledActionId, row.probability, row.basis], ["move:2|tera=0", "move:1|tera=0", 0.69, "top"]);
    assert.equal(row.rerank.rawActionId, "move:1|tera=0", "the re-ranker stays coupled to the worker's own sample");
    assert.deepEqual(journal.find((r) => r.kind === "commit" && r.rqid === 2) && [journal.find((r) => r.kind === "commit" && r.rqid === 2).adviceActionId, journal.find((r) => r.kind === "commit" && r.rqid === 2).followed],
      ["move:2|tera=0", false], "following the sample is not following the shown pick");
  } finally { await h.advisor.close(); }
  const close = await harness({ distribution: { "move 1": 0.43, "move 2": 0.37, "switch 2": 0.2 } });
  try {
    await close.preview(); await close.choice("/team 123456|1"); await close.turn();
    const advice = (close.advisor as any).rooms.values().next().value.advice;
    assert.equal(advice.label, "Knock Off (43%) · close: Volt Switch (37%)");
    assert.deepEqual(advice.runnerUp, { actionId: "move:2|tera=0", label: "Volt Switch", probability: 0.37 });
  } finally { await close.advisor.close(); }
});

// Matters: a player may switch instead of following the pick, so the strip names one short alternative. Beside a move pick, Metamon's own most probable
// switch (beside a switch pick, its most probable move), with its probability in the full distribution; it is read off the
// same distribution (no rule, no re-rank), journaled with the advice, and absent when it is already the shown runner-up.
test("live Metamon names its best switch beside a move pick and its best move beside a switch pick", async () => {
  const journalDir = path.join(directory, "journal-alternative");
  const h = await harness({ journalDir, distribution: { "move 1": 0.6, "move 2": 0.25, "switch 2": 0.1, "switch 3": 0.05 } });
  try {
    await h.preview(); await h.choice("/team 123456|1"); await h.turn(); await h.advisor.settled();
    const advice = (h.advisor as any).rooms.values().next().value.advice;
    assert.equal(advice.label, "Knock Off (60%)");
    assert.deepEqual({ ...advice.alternative, guards: undefined }, { kind: "switch", actionId: "switch:2", label: "If switching: Donphan (10%)", probability: 0.1, guards: undefined });
    await h.advisor.close();
    const [file] = await fs.readdir(journalDir);
    const journal = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(journal.find((r) => r.kind === "advice" && r.rqid === 2).alternative, { actionId: "switch:2", probability: 0.1 });
  } finally { await h.advisor.close(); }
  const staying = await harness({ distribution: { "switch 3": 0.6, "move 2": 0.3, "move 1": 0.1 } });
  try {
    await staying.preview(); await staying.choice("/team 123456|1"); await staying.turn();
    const advice = (staying.advisor as any).rooms.values().next().value.advice;
    assert.equal(advice.alternative.label, "If staying: Volt Switch (30%)"); assert.equal(advice.alternative.kind, "stay");
  } finally { await staying.advisor.close(); }
  const close = await harness({ distribution: { "move 1": 0.45, "switch 2": 0.4, "move 2": 0.15 } });
  try {
    await close.preview(); await close.choice("/team 123456|1"); await close.turn();
    const advice = (close.advisor as any).rooms.values().next().value.advice;
    assert.match(advice.label, /· close: Switch to Donphan \(40%\)$/); assert.equal(advice.alternative, undefined, "the runner-up already names it");
  } finally { await close.advisor.close(); }
});

// Matters: live Showdown sends `/choose move 1|5.87ee3ef5880f6771`: the rqid carries a hash suffix.
// Rejecting it dropped the first real browser game to sync_lost.
test("live Metamon commits choices whose rqid has a client hash suffix", async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice("/team 123456|1.5a0c3e9f2b7d4e61"); await h.turn();
    await h.choice("/choose move 1|2.87ee3ef5880f6771");
    await h.frame(`|move|p1a: Scizor|Knock Off|p2a: Rotom\n|upkeep\n|turn|2\n${line(request(3))}`);
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]!.state, "ready");
    assert.deepEqual((await h.log()).filter((m) => m.op === "commit").map((m) => m.choice.kind), ["team", "move"]);
  } finally { await h.advisor.close(); }
});

// Matters: the real server shares one rqid counter across both sides, so a side's requests step by 2 (3, 5, 7...).
// Requiring +1 dropped the first real browser game at turn 1 ("Private epoch gap"); stale or repeated rqids still fail.
test("live Metamon follows real-server rqids that skip the other side's numbers", async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice("/team 123456|1");
    await h.frame(`|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(3))}`);
    assert.equal(h.advisor.status()[0]!.state, "ready");
    await h.choice("/choose move 1|3.87ee3ef5880f6771");
    await h.frame(`|move|p1a: Scizor|Knock Off|p2a: Rotom\n|upkeep\n|turn|2\n${line(request(5))}`);
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]!.state, "ready");
    assert.deepEqual((await h.log()).filter((m) => m.op === "commit").map((m) => m.choice.kind), ["team", "move"]);
    await h.choice("/choose move 1|5");
    await h.frame(`|move|p1a: Scizor|Knock Off|p2a: Rotom\n|upkeep\n|turn|3\n${line(request(5))}`);
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]!.reason, "sync_lost", "a repeated rqid is still an epoch error");
  } finally { await h.advisor.close(); }
});

// Matters: in real games the human's chosen move often never prints a |move| line, or prints it only after a
// mid-turn wait request; each of these must commit the human's choice instead of dropping the advisor.
for (const mode of ["opponent_pivot_wait", "phazed", "confusion", "eject_button", "game_ends_first"] as const) test(`live Metamon keeps recurrence through ${mode}`, async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice("/choose team 123456|1"); await h.turn();
    await h.choice("/choose move 1|2");
    if (mode === "opponent_pivot_wait") {
      await h.frame("|\n|move|p2a: Rotom|Volt Switch|p1a: Scizor\n|-damage|p1a: Scizor|250/300");
      await h.frame(line(request(3, { wait: true, active: undefined })));
      await h.frame("|\n|switch|p2a: Umbreon|Umbreon, M|100/100|[from] Volt Switch\n|move|p1a: Scizor|Knock Off|p2a: Umbreon\n|upkeep\n|turn|2");
      await h.frame(line(request(4)));
    } else if (mode === "phazed") {
      await h.frame(`|move|p2a: Rotom|Whirlwind|p1a: Scizor\n|drag|p1a: Donphan|Donphan|300/300\n|upkeep\n|turn|2\n${line(request(3, { side: side(1) }))}`);
    } else if (mode === "confusion") {
      await h.frame(`|-activate|p1a: Scizor|confusion\n|-damage|p1a: Scizor|260/300|[from] confusion\n|upkeep\n|turn|2\n${line(request(3))}`);
    } else if (mode === "eject_button") {
      await h.frame("|move|p2a: Rotom|Hydro Pump|p1a: Scizor\n|-damage|p1a: Scizor|200/300\n|-enditem|p1a: Scizor|Eject Button");
      await h.frame(line(request(3, { forceSwitch: [true], active: undefined })));
    } else {
      await h.frame("|move|p2a: Rotom|Hydro Pump|p1a: Scizor\n|-damage|p1a: Scizor|200/300\n|-damage|p2a: Rotom|0 fnt|[from] item: Life Orb\n|faint|p2a: Rotom\n|win|Player 1");
    }
    await h.advisor.settled();
    const status = h.advisor.status()[0]!;
    if (mode === "game_ends_first") {
      assert.equal(status.state, "unavailable"); assert.equal(status.reason, "ended"); assert.equal(status.pid, null);
      return;
    }
    assert.equal(status.state, "ready", `${mode} must not lose sync`);
    const logs = await h.log();
    assert.deepEqual(logs.filter((m) => m.op === "commit").map((m) => m.choice).at(-1), { kind: "move", moveSlot: 1, terastallize: false });
    assert.equal(logs.filter((m) => m.op === "propose").length, 3);
    // The commit precedes every observation of the turn's frames, matching the offline observe/decide/commit order.
    const commit = logs.map((m) => m.op).lastIndexOf("commit");
    assert.ok(logs.slice(commit + 1).some((m) => m.op === "observe") && !logs.slice(commit + 1).some((m) => m.op === "commit"));
  } finally { await h.advisor.close(); }
});

// Matters: an uncertain executed action must never corrupt hidden recurrent state.
for (const mode of ["missing", "undo_only", "different_without_undo", "mismatch", "wrong_rqid", "recovery", "gap", "reset", "side", "tera_mismatch", "error"] as const) test(`live Metamon fails closed on ${mode}`, async () => {
  const h = await harness();
  try {
    await h.preview();
    if (!["missing", "wrong_rqid", "gap", "reset", "side", "error"].includes(mode)) await h.choice("/choose team 123456|1");
    if (mode === "undo_only") await h.choice("/undo|1");
    if (mode === "different_without_undo") await h.choice("/choose team 213456|1");
    if (mode === "wrong_rqid") await h.choice("/choose team 123456|99");
    if (mode === "gap") h.advisor.accept([{ ...h.event({ kind: "choice", data: "/choose team 123456" }), sequence: 99 }]);
    else if (mode === "reset") await h.frame("|init|battle");
    else if (mode === "side") await h.frame(line(request(2, { side: { ...side(), id: "p2" } })));
    else if (mode === "error") await h.frame("|error|[Invalid choice] Can't do that");
    else if (mode === "recovery") await h.frame("|turn|1", "recovery");
    else if (mode === "mismatch") await h.frame(`|switch|p1a: Donphan|Donphan|300/300\n|turn|1\n${line(request(2))}`);
    else if (mode === "tera_mismatch") {
      await h.turn(); await h.choice("/choose move 1 terastallize|2");
      await h.frame(`|move|p1a: Scizor|Knock Off|p2a: Rotom\n|turn|2\n${line(request(3))}`);
    } else await h.turn();
    await h.advisor.settled();
    const status = h.advisor.status()[0]!;
    // A same-session |init| replay discards the old recurrence like every other case, but waits for the replay's request
    // to restart from the full log instead of staying lost (the advisor must never stay in lost sync).
    if (mode === "reset") { assert.equal(status.state, "warming"); assert.equal(status.reason ?? null, null); }
    else { assert.equal(status.state, "unavailable"); assert.equal(status.reason, "sync_lost"); }
    assert.equal(status.pid, null, "the old worker and its recurrent state are gone");
    const commits = (await h.log()).filter((m) => m.op === "commit");
    assert.equal(commits.length, mode === "tera_mismatch" ? 1 : 0, "never commit an unproved action");
  } finally { await h.advisor.close(); }
});

// Matters: GPU ownership must end on all lifecycle boundaries, including during warm-up.
for (const mode of ["win", "tie", "forfeit", "deinit", "leave", "idle", "shutdown", "warming_win"] as const) test(`live Metamon unloads on ${mode} with no process survivors`, async () => {
  let now = 0;
  const h = await harness({ idleMs: 100, now: () => now, hang: mode === "warming_win" });
  try {
    if (mode === "warming_win") {
      await h.frame(`|init|battle\n${fixture.replay.preview}\n${line({ rqid: 1, teamPreview: true, side: side(-1) })}`, "protocol", false);
      for (let i = 0; i < 100 && !(await h.log()).length; i++) await new Promise((r) => setTimeout(r, 10));
    } else await h.preview();
    const pid = h.advisor.status()[0]!.pid!; assert.ok(pid && alive(pid));
    if (mode === "shutdown") await h.advisor.close();
    else if (mode === "idle") { now = 101; await h.advisor.sweep(); }
    else if (mode === "leave") { h.advisor.accept([h.event({ kind: "leave" })]); await h.advisor.settled(); }
    else await h.frame(mode === "tie" ? "|tie|" : mode === "forfeit" ? "|message|Player 2 forfeited." : mode === "deinit" ? "|deinit|" : "|win|Player 1");
    await h.advisor.settled();
    assert.ok(h.advisor.status().every((s) => s.pid === null && s.state === "unavailable"), "the lifecycle event itself unloads, before explicit close");
    assert.equal(alive(pid), false);
    await h.advisor.close();
    assert.deepEqual(h.advisor.status(), []);
    assert.ok((await h.log()).some((m) => m.op === "eof"), "stdin EOF reaches the worker before process-group kill");
  } finally { await h.advisor.close(); }
});

// Matters: a reply belongs to one request and its legal actions. Chat, timer and inactivity lines arrive while the
// human decides and bump the revision/result hash; dropping the pick then showed "stale advice" mid-turn.
test("live Metamon keeps advice for the same request and legal actions, never for another request or room", async () => {
  const h = await harness();
  try {
    const current = await h.preview();
    const envelope = await buildDecisionEnvelope(current.snapshot!, current.identity!, h.context, current.room.lastRequest.side.pokemon);
    assert.equal(h.advisor.advice(sessionId, current.identity!).status, "ready");
    for (const identity of [{ ...current.identity!, rqid: 99 }, { ...current.identity!, legalActionSetHash: "other" },
      { ...current.identity!, requestKind: "switch" as const }, { ...current.identity!, roomId: "battle-gen9uu-other" }]) {
      assert.equal(h.advisor.advice(sessionId, identity).actionId, null);
    }
    const chat = h.advisor.advice(sessionId, { ...current.identity!, stateRevision: 99, snapshotHash: "after-chat" });
    assert.equal(chat.status, "ready"); assert.equal(chat.actionId, h.advisor.advice(sessionId, current.identity!).actionId);
    // Rebound to the newer identity; the pick's own input hash is unchanged (it never depended on the envelope).
    assert.equal(chat.identity.stateRevision, 99); assert.equal(chat.resultHash, h.advisor.advice(sessionId, current.identity!).resultHash);
    const pid = h.advisor.status()[0]!.pid!;
    h.advisor.accept([{ ...h.event({ kind: "leave" }), sessionId: "replacement" }]);
    await h.advisor.close(); assert.equal(alive(pid), false);
  } finally { await h.advisor.close(); }
});

// Matters: the browser polls as soon as a request lands. While the previous commit is still in flight the current
// decision is pending, never a terminal "unavailable" that stops polling for the whole turn.
test("live Metamon reports warming, not stale, while the previous commit is in flight", async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice("/choose team 123456|1");
    const current = await h.frame(`|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(2))}`, "protocol", false);
    const early = h.advisor.advice(sessionId, current.identity!);
    assert.equal(early.status, "warming"); assert.equal(early.actionId, null);
    await h.advisor.settled();
    const envelope = await buildDecisionEnvelope(current.snapshot!, current.identity!, h.context, current.room.lastRequest.side.pokemon);
    assert.equal(h.advisor.advice(sessionId, current.identity!).status, "ready");
    const older = h.advisor.advice(sessionId, { ...current.identity!, rqid: 1 });
    assert.equal(older.status, "unavailable"); assert.equal(older.reason, "stale_advice");
  } finally { await h.advisor.close(); }
});

// Matters: in singles only the lead is chosen at team preview, so a same-lead order is the advised pick (a same-lead
// pick was once wrongly counted as ignored); with Illusion the party order decides the disguise.
for (const [illusion, followed] of [[false, true], [true, false]] as const) test(`live Metamon judges a same-lead preview as ${followed ? "followed" : "not followed"}${illusion ? " with Illusion" : ""}`, async () => {
  const journalDir = path.join(directory, `journal-lead-${illusion}`);
  const h = await harness({ journalDir });
  try {
    const team = side(-1); if (illusion) team.pokemon[5]!.baseAbility = "illusion";
    await h.frame(`|init|battle\n${fixture.replay.preview}\n${line({ rqid: 1, teamPreview: true, side: team })}`);
    await h.choice("/team 165432|1"); await h.turn();
    await h.advisor.settled(); await h.advisor.close();
    const [file] = await fs.readdir(journalDir);
    const journal = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(journal.filter((r) => r.kind === "commit").map((r) => [r.adviceActionId, r.actionId, r.followed]),
      [["team:123456", "team:165432", followed]]);
  } finally { await h.advisor.close(); }
});

// Matters: collected live games must replay exactly offline: the journal holds the worker's exact input stream,
// the seed it ran with, each recommendation and the human's final choice. The result and the last turn arrive after the
// human's final choice and never reach the worker; a journal must not lose them.
test("live Metamon journals the worker-observed stream, seed, advice, the human's choices and the result", async () => {
  const journalDir = path.join(directory, "journal");
  const h = await harness({ journalDir });
  try {
    await h.preview(); await h.choice("/team 123456|1"); await h.turn();
    await h.choice("/choose move 2|2");
    await h.frame(`|move|p1a: Scizor|Volt Switch|p2a: Rotom\n|upkeep\n|turn|2\n${line(request(3))}`);
    await h.choice("/choose move 1|3");
    const last = "|move|p1a: Scizor|Knock Off|p2a: Rotom\n|faint|p2a: Rotom\n|win|Player 1";
    await h.frame(last);
    await h.advisor.settled(); await h.advisor.close();
    const [file] = await fs.readdir(journalDir);
    assert.match(file!, /^battle-gen9uu-live-test-p1-\d{8}T\d{6}Z\.jsonl$/, "portable per-battle file name");
    const journal = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const start = journal[0];
    assert.equal(start.kind, "start"); assert.equal(start.side, "p1"); assert.ok(Number.isSafeInteger(start.seed));
    assert.equal(start.args.at(-1), `seed=${start.seed}`, "the journaled seed is the one the worker received");
    const worker = (await h.log()).filter((m) => m.op === "observe").map((m) => m.data);
    assert.deepEqual(journal.filter((r) => r.kind === "frame").map((r) => r.data), worker, "journal frames equal the worker's input, in order");
    assert.deepEqual(journal.filter((r) => r.kind === "advice").map((r) => [r.rqid, r.actionId]),
      [[1, "team:123456"], [2, "move:1|tera=0"], [3, "move:1|tera=0"]]);
    assert.deepEqual(journal.filter((r) => r.kind === "commit").map((r) => [r.rqid, r.choice, r.followed]),
      [[1, "team 123456", true], [2, "move 2", false]]);
    const { at: _at, ...end } = journal.at(-2);
    assert.deepEqual(end, { kind: "end", result: { winner: "Player 1" }, data: last, finalChoice: "move 1", adviceActionId: "move:1|tera=0", followed: true });
    assert.deepEqual(journal.at(-1), { ...journal.at(-1), kind: "stop", reason: "ended" });
  } finally { await h.advisor.close(); }
});

// Matters: the re-ranker is SHADOW-only live. Metamon's raw pick stays the advice; a guard (here a rules-certain Future
// Sight failure) and a differing re-ranked pick are added beside it, and the journal keeps raw p, p', both picks and the
// guards so the experiment can be audited per decision and every re-ranked pick recomputed from its seed key.
test("live Metamon shadow re-ranker keeps the raw pick, shows guards, and journals raw p, p' and both picks", async () => {
  const { coupledRerankPick, rerankDistribution } = await import("../battle-agent/rerank.js");
  const journalDir = path.join(directory, "journal-rerank");
  const h = await harness({ journalDir, probs: true });
  const fsSide = () => ({ ...side(), pokemon: side().pokemon.map((mon) => ({ ...mon, moves: ["futuresight", "knockoff"] })) });
  const fsRequest = (rqid: number) => ({ rqid, side: fsSide(), active: [{ canTerastallize: "Flying", moves: [
    { id: "futuresight", move: "Future Sight", pp: 15 }, { id: "knockoff", move: "Knock Off", pp: 20 }] }] });
  try {
    // No Illusion user on the opposing preview: the envelope is fully supported, so the engine data exist.
    const preview = fixture.replay.preview.replace("|poke|p2|Zoroark-Hisui, M|", "|poke|p2|Gyarados, M|");
    await h.frame(`|init|battle\n${preview}\n${line({ rqid: 1, teamPreview: true, side: side(-1) })}`); await h.choice("/team 123456|1");
    const first = await h.frame(`|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(fsRequest(2))}`);
    const firstEnvelope = await buildDecisionEnvelope(first.snapshot!, first.identity!, h.context, first.room.lastRequest.side.pokemon);
    const before = h.advisor.advice(sessionId, first.identity!);
    assert.equal(before.actionId, "move:1|tera=0"); assert.equal(before.rerank, undefined, "nothing pending yet: no re-rank");
    await h.choice("/choose move 1|2");
    const current = await h.frame(`|move|p1a: Scizor|Future Sight|p2a: Rotom\n|-start|p1a: Scizor|move: Future Sight\n|upkeep\n|turn|2\n${line(fsRequest(3))}`);
    const envelope = await buildDecisionEnvelope(current.snapshot!, current.identity!, h.context, current.room.lastRequest.side.pokemon);
    const advice = h.advisor.advice(sessionId, current.identity!);
    assert.equal(advice.status, "ready"); assert.equal(advice.actionId, "move:1|tera=0", "the advice is Metamon's raw pick");
    const red = advice.guards?.find((guard) => guard.kind === "delayed_slot_occupied");
    assert.equal(red?.severity, "red"); assert.match(red!.message, /^Future Sight will fail/);
    await h.advisor.settled(); await h.advisor.close();
    const [file] = await fs.readdir(journalDir);
    const journal = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const records = journal.filter((r) => r.kind === "advice");
    const record = records.find((r) => r.rqid === 3)!.rerank;
    assert.deepEqual(record.rawProbabilities, { "move:1|tera=0": 0.9, "move:2|tera=0": 0.1 });
    assert.deepEqual(record.flagged["move:1|tera=0"], ["delayed_slot_occupied"]);
    assert.deepEqual(record.config, { tau: 0.05, demoted: ["pre_move_ko", "setup_dead_end", "switch_into_ko"] });
    assert.deepEqual(record.rerankedProbabilities, rerankDistribution(record.rawProbabilities, record.flagged, record.config));
    assert.deepEqual(record.rerankedProbabilities, { "move:1|tera=0": 0, "move:2|tera=0": 1 }, "@2: the certain failure gets no mass");
    assert.equal(record.rawActionId, "move:1|tera=0");
    assert.equal(record.rerankActionId, coupledRerankPick(record.rawProbabilities, record.rerankedProbabilities, record.rawActionId, record.seedKey));
    assert.equal(record.seedKey, `metamon-rerank@2:${journal[0].seed}:p1:3:${current.identity!.stateRevision}`, "the battle's journaled seed drives the pick");
    assert.deepEqual(advice.rerank, { actionId: "move:2|tera=0", label: "Knock Off" }, "the differing re-ranked pick is shown");
    assert.equal(records.find((r) => r.rqid === 1).rerank.rawProbabilities, null, "preview has no network distribution");
  } finally { await h.advisor.close(); }
});

// Matters: a full disk or bad path must cost the record, never the live recommendation.
test("live Metamon journal failure is reported without affecting advice", async () => {
  const blocker = path.join(directory, "not-a-directory");
  await fs.writeFile(blocker, "");
  const h = await harness({ journalDir: blocker });
  try {
    await h.preview(); await h.advisor.settled();
    const status = h.advisor.status()[0]!;
    assert.equal(status.state, "ready");
    assert.ok(status.journalError, "the failure is visible in /v1/metamon/live");
  } finally { await h.advisor.close(); }
});

// Matters: captured private preview chunks exercise real Chrome framing; they are not private turn evidence.
test("live Metamon replays recorded private Chrome preview and immediate-forfeit fixture", async () => {
  const h = await harness();
  try {
    for (const raw of fixture.recordedPrivate.frames) {
      const data = raw.slice(raw.indexOf("\n") + 1);
      await h.frame(data);
    }
    assert.equal((await h.log()).filter((m) => m.op === "propose").length, 1);
    assert.equal(h.advisor.status()[0]!.pid, null);
    assert.ok((await h.log()).some((m) => m.op === "eof"));
  } finally { await h.advisor.close(); }
});

// Matters: opt-in launch parsing must not accidentally start an ssh or model process.
test("live Metamon launch validates seed and producer pin without spawning", async () => {
  const file = path.join(directory, "launch.json");
  await fs.writeFile(file, JSON.stringify({ command: "never-executed", args: ["--seed", "{seed}"], workerSha256: "a".repeat(64), host: "extra metadata" }));
  assert.deepEqual(await readLiveMetamonLaunch(file), { command: "never-executed", args: ["--seed", "{seed}"], maxWorkers: 1 });
  await fs.writeFile(file, JSON.stringify({ command: "never-executed", args: [], workerSha256: "a".repeat(64) }));
  await assert.rejects(readLiveMetamonLaunch(file), /seed/);
});

// Matters: opt-out preserves deterministic results; only the process identity used for restart detection differs.
test("live Metamon disabled mode preserves HTTP results apart from the companion instance identity", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") });
  const a = buildServer(), b = buildServer();
  try {
    const observation = { sessionId: "disabled-test", roomId, observationId: "disabled-1", sequence: 1, source: "protocol",
      data: `>${roomId}\n|init|battle\n${fixture.replay.preview}\n${line({ rqid: 1, teamPreview: true, side: side(-1) })}` };
    const ra = await a.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
    const rb = await b.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation], metamonEvents: [{ kind: "observation", eventId: "ignored", sequence: 1, sessionId: observation.sessionId, roomId, observationId: observation.observationId }] } });
    assert.equal(ra.statusCode, 200);
    const { instanceId: instanceA, ...resultA } = ra.json(), { instanceId: instanceB, ...resultB } = rb.json();
    assert.equal(typeof instanceA, "string"); assert.notEqual(instanceA, instanceB);
    assert.deepEqual(resultB, resultA);
    assert.deepEqual(Object.keys(ra.json()).sort(), ["contractVersion", "historyRevision", "instanceId", "ok", "results"]);
    const query = { sessionId: observation.sessionId, identity: ra.json().results[0].identity, historyRevision: ra.json().historyRevision };
    const ea = await a.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "threats" } });
    const eb = await b.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "threats" } });
    assert.equal(ea.statusCode, 200); assert.equal(eb.body, ea.body);
    assert.deepEqual(Object.keys(ea.json()).sort(), ["envelope", "evaluatedAt", "final", "ok", "stage"]);
    const feedback = { ...query, resultHash: ea.json().envelope.resultHash };
    assert.equal((await a.inject({ method: "POST", url: "/v1/feedback", payload: feedback })).body,
      (await b.inject({ method: "POST", url: "/v1/feedback", payload: feedback })).body);
    assert.deepEqual((await a.inject({ method: "GET", url: "/v1/metamon/live" })).json(), { ok: true, enabled: false, rooms: [] });
    assert.equal((await a.inject({ method: "POST", url: "/v1/metamon/advice", payload: query })).json().metamonAdvice.status, "disabled");
  } finally { await a.close(); await b.close(); t.mock.timers.reset(); }
});

// Matters: accepted frames and human commands must survive HTTP retries without duplicate recurrent updates.
test("live Metamon HTTP binding, retry idempotence, stale 409 and server shutdown cleanup", async () => {
  const h = await harness(), app = buildServer({ liveMetamon: h.advisor });
  try {
    const observation = { sessionId, roomId, observationId: "http-1", sequence: 1, source: "protocol",
      data: `>${roomId}\n|init|battle\n${fixture.replay.preview}\n${line({ rqid: 2, teamPreview: true, side: side(-1) })}` };
    const metamonEvents = [h.event({ kind: "observation", observationId: observation.observationId })];
    const ingest = () => app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation], metamonEvents } });
    const observed = await ingest(); assert.equal(observed.statusCode, 200, observed.body);
    const initial = observed.json(); await h.advisor.settled(); await ingest(); await h.advisor.settled();
    const query = { sessionId, identity: initial.results[0].identity, historyRevision: initial.historyRevision };
    const evaluated = await app.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "threats" } });
    assert.equal(evaluated.statusCode, 200, evaluated.body);
    const { envelope } = evaluated.json();
    // The pick is bound to the canonical decision identity, not to the deterministic result.
    const { metamonAdvice } = (await app.inject({ method: "POST", url: "/v1/metamon/advice", payload: query })).json();
    assert.equal(metamonAdvice.status, "ready"); assert.equal(metamonAdvice.identity.rqid, 2);
    assert.deepEqual(metamonAdvice.identity, envelope.semantic.identity);
    assert.ok(envelope.semantic.snapshot.legalActions.some((a: any) => a.id === metamonAdvice.actionId));
    assert.equal((await h.log()).filter((m) => m.op === "propose").length, 1);
    const wireRequest = (await h.log()).find((m) => m.op === "propose");
    assert.equal(wireRequest.identity.rqid, 1, "only the pinned worker's private numbering is translated");
    const choice = h.event({ kind: "choice", data: "/choose team 123456|2" });
    for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: "POST", url: "/v1/metamon/events", payload: { metamonEvents: [choice] } })).statusCode, 200);
    const next = { ...observation, observationId: "http-2", sequence: 2, data: `>${roomId}\n|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(3))}` };
    await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [next], metamonEvents: [h.event({ kind: "observation", observationId: next.observationId })] } });
    await h.advisor.settled();
    assert.equal((await h.log()).filter((m) => m.op === "commit").length, 1);
    assert.equal((await app.inject({ method: "POST", url: "/v1/metamon/advice", payload: query })).statusCode, 409);
    const pid = h.advisor.status()[0]!.pid!; assert.ok(alive(pid));
    const status = (await app.inject({ method: "GET", url: "/v1/metamon/live" })).json();
    assert.equal(status.enabled, true); assert.equal(status.rooms[0].pid, pid);
    await app.close(); assert.equal(alive(pid), false); assert.deepEqual(h.advisor.status(), []);
  } finally { await app.close(); await h.advisor.close(); }
});

// Matters: the pick used to wait for the extension's next 250 ms poll after the model had answered. A held advice
// request answers as soon as the pick is ready, and the shared envelope means the advisor and /v1/evaluate build it once.
test("live Metamon advice request held with waitMs answers as soon as the pick is ready", async () => {
  const h = await harness({ delayMs: 400, journalDir: path.join(directory, "journal-wait") }), app = buildServer({ liveMetamon: h.advisor });
  try {
    const observation = { sessionId, roomId, observationId: "wait-1", sequence: 1, source: "protocol",
      data: `>${roomId}\n|init|battle\n${fixture.replay.preview}\n${line({ rqid: 2, teamPreview: true, side: side(-1) })}` };
    const observed = (await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation],
      metamonEvents: [h.event({ kind: "observation", observationId: observation.observationId })] } })).json();
    const query = { sessionId, identity: observed.results[0].identity, historyRevision: observed.historyRevision };
    const evaluated = (await app.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "threats" } })).json();
    const ask = query;
    assert.equal((await app.inject({ method: "POST", url: "/v1/metamon/advice", payload: ask })).json().metamonAdvice.status, "warming", "without waitMs it answers at once");
    const started = Date.now();
    const held = await app.inject({ method: "POST", url: "/v1/metamon/advice?waitMs=4000", payload: ask });
    assert.equal(held.json().metamonAdvice.status, "ready");
    assert.ok(Date.now() - started < 2000, "answered when ready, not at the end of the wait");
    // after="pick" holds a ready pick until its warnings (from the shared deterministic build) are attached.
    const warned = await app.inject({ method: "POST", url: "/v1/metamon/advice?waitMs=4000", payload: { ...ask, after: "pick" } });
    assert.equal(warned.json().metamonAdvice.guardsPending, undefined);
    await h.advisor.settled();
    const advice = (await fs.readFile(h.advisor.status()[0]!.journal!, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.kind === "advice");
    assert.equal(advice.resultHash, evaluated.envelope.resultHash, "the advisor's envelope is the evaluated one (built once)");
  } finally { await app.close(); await h.advisor.close(); }
});

// Matters: harmless periodic recovery must not break every live game; changed recovery must still fail closed.
test("live Metamon ignores accepted no-op recovery without duplicating worker observations", async () => {
  const h = await harness();
  try {
    await h.preview();
    const before = (await h.log()).length;
    await h.frame("|tier|[Gen 9] UU", "recovery");
    assert.equal(h.advisor.status()[0]!.state, "ready"); assert.equal((await h.log()).length, before);
  } finally { await h.advisor.close(); }
});

// Matters: an omitted accepted chunk must never silently claim complete private chronology.
test("live Metamon rejects incomplete event coverage after canonical ingestion", async () => {
  const h = await harness();
  try {
    await h.preview();
    const observation: BattleObservation = { sessionId, roomId, observationId: "omitted", sequence: 2, source: "protocol", data: `>${roomId}\n|turn|1` };
    const current = await h.engine.ingest(observation);
    h.advisor.accept([], [{ observation, current, context: h.context }]);
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]!.state, "unavailable"); assert.equal(h.advisor.status()[0]!.pid, null);
    assert.equal((await h.engine.read(sessionId, roomId)).sequence, 2, "advisor failure cannot roll back ingestion");
  } finally { await h.advisor.close(); }
});

// Matters: worker/protocol errors must close immediately and revoke the visible recommendation.
test("live Metamon worker errors unload and report sync lost", async () => {
  const h = await harness({ fail: true });
  try {
    const current = await h.preview();
    assert.equal(h.advisor.status()[0]!.state, "unavailable");
    const pid = (await h.log())[0].pid;
    assert.equal(alive(pid), false);
    const advice = h.advisor.advice(sessionId, current.identity!);
    assert.equal(advice.status, "unavailable"); assert.equal(advice.reason, "sync_lost"); assert.equal(advice.actionId, null);
  } finally { await h.advisor.close(); }
});

for (const split of [false, true]) for (const suggestedSwitch of [false, true]) test(`live trapped switch re-chooses without committing the rejected human choice (split=${split}, suggestedSwitch=${suggestedSwitch})`, async () => {
  const h = await harness({ switch: suggestedSwitch });
  try {
    await h.preview(); await h.choice("/team 123456|1");
    await h.frame(`|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Magnezone|Magnezone|100/100\n|turn|1\n${line(request(2, { active: [{ ...request(2).active[0], maybeTrapped: true }] }))}`);
    await h.choice("/choose switch 2|2");
    const error = "|error|[Unavailable choice] Can't switch: The active Pokémon is trapped";
    const trapped = line(request(2, { active: [{ ...request(2).active[0], trapped: true }] }));
    if (split) { await h.frame(error); assert.equal(h.advisor.status()[0]!.state, "warming"); }
    const current = await h.frame(split ? trapped : `${error}\n${trapped}`, "protocol", false);
    assert.equal(h.advisor.advice(sessionId, current.identity!).status, "warming");
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]!.state, "ready");
    const envelope = await buildDecisionEnvelope(current.snapshot!, current.identity!, h.context, current.room.lastRequest.side.pokemon);
    assert.equal(h.advisor.advice(sessionId, current.identity!).actionId, "move:1|tera=0");
    await h.choice("/choose move 1|2");
    await h.frame(`|move|p1a: Scizor|Knock Off|p2a: Magnezone\n|turn|2\n${line(request(3))}`);
    assert.equal(h.advisor.status()[0]!.state, "ready");
    const logs = await h.log();
    assert.deepEqual(logs.filter(m => m.op === "commit").map(m => m.choice), [{ kind: "team", team: [1,2,3,4,5,6] }, { kind: "move", moveSlot: 1, terastallize: false }]);
    assert.equal(logs.filter(m => m.op === "propose" && m.identity.rqid === 2).length, 2);
    assert.equal(logs.filter(m => m.op === "stage_switch").length, suggestedSwitch ? 0 : 1);
  } finally { await h.advisor.close(); }
});

// Matters: a 96% "Tera + Slack Off" pick was once played without Tera. A Tera pick must say
// "Terastallize (<type>)" in words, so it reads as an instruction, not a footnote.
test("live Metamon names the Tera type in a Tera pick's label", async () => {
  const h = await harness({ tera: true });
  try {
    await h.preview(); await h.choice("/choose team 123456|1"); await h.turn();
    const advice = (h.advisor as any).rooms.values().next().value.advice;
    assert.equal(advice.actionId, "move:1|tera=1");
    assert.equal(advice.label, "Terastallize (Flying) + Knock Off");
  } finally { await h.advisor.close(); }
});

// One browser capture session (one Showdown tab) feeding any number of battle rooms, as the extension does.
function capture(h: Awaited<ReturnType<typeof harness>>, sid: string) {
  let seq = 0;
  const event = (rid: string, fields: any): LiveEvent => ({ sessionId: sid, roomId: rid, eventId: `${sid}-e${++seq}`, sequence: seq, ...fields });
  return (rid: string) => ({
    async frame(data: string) {
      const observation: BattleObservation = { sessionId: sid, roomId: rid, observationId: `${sid}-${rid}-${seq + 1}`, sequence: seq + 1, source: "protocol", data: `>${rid}\n${data}` };
      const current = await h.engine.ingest(observation);
      h.advisor.accept([event(rid, { kind: "observation", observationId: observation.observationId })], [{ observation, current, context: h.context }]);
      await h.advisor.settled();
      return current;
    },
    async choice(data: string) { h.advisor.accept([event(rid, { kind: "choice", data })]); await h.advisor.settled(); },
    async leave() { h.advisor.accept([event(rid, { kind: "leave" })]); await h.advisor.settled(); },
    preview() { return this.frame(`|init|battle\n${fixture.replay.preview}\n${line({ rqid: 1, teamPreview: true, side: side(-1) })}`); },
    replay(rqid: number) { return this.frame(`|init|battle\n${fixture.replay.preview}\n|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(rqid))}`); },
    turn() { return this.frame(`|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(request(2))}`); },
    adviceFor(current: any) { return h.advisor.advice(sid, current.identity!); }
  });
}
const byRoom = (h: Awaited<ReturnType<typeof harness>>) => Object.fromEntries(h.advisor.status().filter((r) => r.state !== "unavailable" || r.reason !== "sync_lost").map((r) => [`${r.sessionId}/${r.roomId}`, r]));

// Matters: a player may play several games at once, in multiple tabs.
// With one model at a time, the second battle silently had no advice. Up to maxWorkers battles, in separate tabs or as
// two rooms of one tab, each run their own worker, and one battle's choices never touch another's recurrence.
test("live Metamon advises up to maxWorkers concurrent battles independently, across tabs and within one tab", async () => {
  const h = await harness({ maxWorkers: 3 });
  try {
    const tab1 = capture(h, "tab-1"), tab2 = capture(h, "tab-2");
    const r1 = tab1("battle-gen9uu-c1"), r2 = tab1("battle-gen9uu-c2"), r3 = tab2("battle-gen9uu-c3");
    for (const r of [r1, r2, r3]) await r.preview();
    let rooms = byRoom(h);
    const pids = Object.values(rooms).map((r) => r.pid);
    assert.equal(Object.values(rooms).filter((r) => r.state === "ready").length, 3, JSON.stringify(rooms));
    assert.equal(new Set(pids).size, 3, "one worker per battle");
    // Advance only room 2: rooms 1 and 3 keep their own pending preview decisions.
    await r2.choice("/choose team 123456|1");
    const t2 = await r2.turn();
    assert.equal(r2.adviceFor(t2).status, "ready");
    rooms = byRoom(h);
    assert.ok(["tab-1/battle-gen9uu-c1", "tab-1/battle-gen9uu-c2", "tab-2/battle-gen9uu-c3"].every((k) => rooms[k]!.state === "ready"));
    const workerLog = await h.log();
    const opsBy = (pid: number) => workerLog.filter((m) => m.pid === pid && m.op !== "eof").map((m) => m.op);
    assert.deepEqual(opsBy(rooms["tab-1/battle-gen9uu-c2"]!.pid!), ["observe", "propose", "commit", "observe", "propose"]);
    assert.deepEqual(opsBy(rooms["tab-1/battle-gen9uu-c1"]!.pid!), ["observe", "propose"], "room 1 never saw room 2's choice");
    assert.deepEqual(opsBy(rooms["tab-2/battle-gen9uu-c3"]!.pid!), ["observe", "propose"]);
    // An ended battle releases its worker at once.
    await r1.frame("|win|Player 1");
    assert.equal(alive(pids[0]!), false);
  } finally { await h.advisor.close(); }
});

// Matters: a battle beyond the limit must say why and start by itself when a worker frees; a silent "unavailable"
// was once shown all game.
test("live Metamon explains a battle over the worker limit and starts it once another battle ends", async () => {
  const h = await harness({ maxWorkers: 2 });
  try {
    const tab = capture(h, "tab-1"), other = capture(h, "tab-2");
    const r1 = tab("battle-gen9uu-k1"), r2 = other("battle-gen9uu-k2"), r3 = tab("battle-gen9uu-k3");
    await r1.preview(); await r2.preview();
    const waiting = await r3.preview();
    let advice = r3.adviceFor(waiting);
    assert.equal(advice.status, "unavailable"); assert.equal(advice.reason, "capacity"); assert.equal(advice.slotFree, false);
    assert.match(advice.detail!, /2 other battles already use Metamon \(limit 2\)/);
    assert.equal(h.advisor.status().filter((r) => r.pid).length, 2, "never more workers than the limit");
    await r1.leave();
    advice = r3.adviceFor(waiting);
    assert.equal(advice.reason, "capacity"); assert.equal(advice.slotFree, true, "the client is told to replay now");
    const started = await r3.replay(3);
    assert.equal(r3.adviceFor(started).status, "ready");
    assert.equal(h.advisor.status().filter((r) => r.pid).length, 2);
  } finally { await h.advisor.close(); }
});

// Matters: a non-UU battle must say so instead of "sync lost" (and must not trigger endless client replays).
test("live Metamon reports an unsupported format plainly", async () => {
  const h = await harness();
  try {
    const r = capture(h, "tab-1")("battle-gen9ou-1");
    const current = await r.preview();
    assert.equal(r.adviceFor(current).reason, "unsupported_format");
    assert.equal(h.advisor.status()[0]!.pid, null);
  } finally { await h.advisor.close(); }
});

// Matters: a finished battle left open in the tab shares the capture session with the next battle. Its
// late frames, leave and replays must never touch the new battle's worker or advice.
test("live Metamon keeps a new battle independent of an ended battle in the same capture session", async () => {
  const h = await harness({ maxWorkers: 1 });
  try {
    const tab = capture(h, "tab-1");
    const old = tab("battle-gen9uu-old"), fresh = tab("battle-gen9uu-new");
    await old.preview(); await old.frame("|win|Player 2");
    const current = await fresh.preview();
    const pid = byRoom(h)["tab-1/battle-gen9uu-new"]!.pid!;
    assert.ok(pid, "the ended battle released the only worker");
    await old.frame("|raw|chat after the end");
    await old.replay(9);
    await old.leave();
    const rooms = byRoom(h);
    assert.equal(rooms["tab-1/battle-gen9uu-new"]!.state, "ready"); assert.equal(rooms["tab-1/battle-gen9uu-new"]!.pid, pid);
    assert.equal(rooms["tab-1/battle-gen9uu-old"]!.reason, "ended");
    assert.equal(fresh.adviceFor(current).status, "ready");
  } finally { await h.advisor.close(); }
});

// Matters: the limit is device configuration read from the launch file, not a constant.
test("live Metamon reads maxWorkers from the launch file and defaults to one", async () => {
  const file = path.join(directory, "launch-max.json");
  const base = { command: "/bin/false", args: ["--seed", "{seed}"], workerSha256: "a".repeat(64) };
  await fs.writeFile(file, JSON.stringify({ ...base, maxWorkers: 3 }));
  assert.equal((await readLiveMetamonLaunch(file)).maxWorkers, 3);
  await fs.writeFile(file, JSON.stringify(base));
  assert.equal((await readLiveMetamonLaunch(file)).maxWorkers, 1);
  await fs.writeFile(file, JSON.stringify({ ...base, maxWorkers: 0 }));
  await assert.rejects(readLiveMetamonLaunch(file));
  const config = JSON.parse(await fs.readFile(new URL("../../../../config/local/metamon-live.json", import.meta.url), "utf8"));
  assert.ok(Number.isInteger(config.maxWorkers) && config.maxWorkers >= 2, "the MLX live config allows concurrent battles");
});

// Matters: a broken browser client was invisible from the companion host (zero observations, no errors).
// The extension's self-report is kept per client, newest first, and bounded.
test("companion keeps the extension's self-reported capture state for diagnosis", async () => {
  const app = buildServer();
  try {
    for (let i = 0; i < 22; i++) {
      const res = await app.inject({ method: "POST", url: "/v1/client/status", payload: { clientId: `c${i}`, tabs: [{ tabId: i, initRooms: ["battle-gen9uu-1"], pendingObservations: 0 }] } });
      assert.equal(res.statusCode, 200);
    }
    assert.equal((await app.inject({ method: "POST", url: "/v1/client/status", payload: { tabs: [] } })).statusCode, 400);
    const clients = (await app.inject({ method: "GET", url: "/v1/client/status" })).json().clients;
    assert.equal(clients.length, 20); assert.equal(clients[0].clientId, "c21"); assert.deepEqual(clients[0].tabs[0].initRooms, ["battle-gen9uu-1"]);
    assert.ok(clients[0].receivedAt);
  } finally { await app.close(); }
});

// Matters: a same-session replay restarts the worker, which takes seconds. In between, the browser asked about the
// replayed decision and got "stale advice" (a terminal answer), stopped polling, and never showed the restarted pick.
test("live Metamon answers a replayed decision as pending until the restarted worker picks", { timeout: 30_000 }, async () => {
  const h = await harness();
  try {
    await h.preview(); await h.choice("/choose team 123456|1"); await h.turn();
    const replay = request(2, { active: [{ canTerastallize: "Flying", moves: [{ id: "knockoff", move: "Knock Off", pp: 19 }, { id: "voltswitch", move: "Volt Switch", pp: 20 }] }] });
    const current = await h.frame(`|init|battle\n${fixture.replay.preview}\n|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|100/100\n|turn|1\n${line(replay)}`, "protocol", false);
    assert.equal(h.advisor.advice(sessionId, current.identity!).status, "warming", "pending, never stale, while the worker restarts");
    await h.advisor.settled();
    assert.equal(h.advisor.advice(sessionId, current.identity!).status, "ready");
  } finally { await h.advisor.close(); }
});

test("a stuck model event leaves HTTP damage and speed available, times out explicitly, and cannot poison its revived worker", { timeout: 10000 }, async (t) => {
  const h = await harness({ operationMs: 1000 }), app = buildServer({ liveMetamon: h.advisor });
  let release!: () => void, entered!: () => void;
  let finishClose!: () => void, retiredPolicy: InstanceType<typeof MetamonBattlePolicy> | undefined, replacementObserved = false;
  const closing = new Promise<void>((resolve) => { finishClose = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const observe = MetamonBattlePolicy.prototype.observe;
  const close = MetamonBattlePolicy.prototype.close;
  t.mock.method(MetamonBattlePolicy.prototype, "close", function (this: InstanceType<typeof MetamonBattlePolicy>) {
    const stopped = close.call(this);
    return this === retiredPolicy ? stopped.then(() => closing) : stopped;
  });
  let block = true;
  t.mock.method(MetamonBattlePolicy.prototype, "observe", async function (this: InstanceType<typeof MetamonBattlePolicy>, ...args: Parameters<typeof observe>) {
    if (block) { block = false; retiredPolicy = this; entered(); await held; throw new Error("retired operation finally rejected"); }
    replacementObserved = true;
    return observe.apply(this, args);
  });
  try {
    const data = (await fs.readFile(new URL("../../../../examples/raw-showdown-frame.sample.txt", import.meta.url), "utf8"))
      .replaceAll("battle-gen9ou-123456789", roomId).replaceAll("[Gen 9] OU", "[Gen 9] UU").replace('|request|{', '|request|{"rqid":2,');
    const observation = { sessionId, roomId, observationId: "stuck-1", sequence: 1, source: "protocol", data };
    const first = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [observation] } });
    assert.equal(first.statusCode, 200, first.body);
    await started;
    const body = first.json();
    const query = { sessionId, identity: body.results[0].identity, historyRevision: body.historyRevision };
    const evaluated = await app.inject({ method: "POST", url: "/v1/evaluate", payload: { ...query, after: "threats" } });
    assert.equal(evaluated.statusCode, 200, evaluated.body);
    const intel = evaluated.json().envelope.semantic.localIntel;
    assert.ok(intel.playerDamagePreview?.length, JSON.stringify(evaluated.json().envelope.semantic.capabilities));
    assert.ok(intel.speedPreview, "speed is independent of a model response");
    for (let i = 0; i < 200 && h.advisor.status()[0]?.state !== "unavailable"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.advisor.status()[0]?.reason, "worker_stalled");
    const fresh = await app.inject({ method: "POST", url: "/v1/observations", payload: { observations: [{
      ...observation, observationId: "stuck-replay", sequence: 2
    }] } });
    assert.equal(fresh.statusCode, 200, fresh.body);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(replacementObserved, false, "the replacement cannot overlap a worker still closing");
    finishClose();
    await h.advisor.settled();
    assert.equal(h.advisor.status()[0]?.state, "ready", "replay does not wait for the retired chain");
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.advisor.status()[0]?.state, "ready", "a late rejection cannot stop the replacement worker");
  } finally { release(); finishClose(); t.mock.restoreAll(); await app.close(); }
});

// Matters: Metamon is slower than the deterministic sections, but neither waits for the other: the pick used to wait for the complete deterministic envelope before the worker was even asked. The
// worker's proposal is now bound to the request view alone; its warnings (which need the envelope) follow, and the
// journal keeps the complete envelope's hash and the re-ranker's record.
test("live Metamon proposes and publishes its pick while the deterministic build is still running", async (t) => {
  const journalDir = path.join(directory, "journal-independent");
  const h = await harness({ journalDir, probs: true });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  try {
    await h.preview();
    await h.choice("/team 123456|1");
    t.mock.method(crypto.subtle, "digest", async (...args: Parameters<typeof crypto.subtle.digest>) => {
      // Every deterministic result (each stage and the complete envelope) carries localIntel; the pick input does not.
      if (new TextDecoder().decode(args[1] as ArrayBuffer).includes('"localIntel"')) { entered(); await held; }
      return digest(...args);
    });
    // A board no other test builds (97/100): the shared envelope cache must not already hold its result.
    const current = await h.frame(`|start\n|switch|p1a: Scizor|Scizor|300/300\n|switch|p2a: Rotom|Rotom-Wash|97/100\n|turn|1\n${line(request(2))}`, "protocol", false);
    await started;
    let advice = h.advisor.advice(sessionId, current.identity!);
    for (let i = 0; i < 200 && advice.status !== "ready"; i++) { await new Promise((r) => setTimeout(r, 10)); advice = h.advisor.advice(sessionId, current.identity!); }
    assert.equal(advice.status, "ready", "the pick is ready while the deterministic build is held");
    assert.equal(advice.guardsPending, true, "its warnings are still to come");
    assert.deepEqual(advice.identity, current.identity);
    release();
    await h.advisor.settled();
    advice = h.advisor.advice(sessionId, current.identity!);
    assert.equal(advice.guardsPending, undefined);
    const [file] = await fs.readdir(journalDir);
    const row = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "advice").at(-1);
    const envelope = await buildDecisionEnvelope(current.snapshot!, current.identity!, h.context, current.room.lastRequest!.side.pokemon);
    assert.equal(row.resultHash, envelope.resultHash, "the journal binds the advice to the complete deterministic envelope");
    assert.ok(row.rerank, "the shadow re-ranker still ran on that envelope");
  } finally { release(); t.mock.restoreAll(); await h.advisor.close(); }
});

// Matters: real (not only test) latency is measured per request. The extension's client status carries each request's
// first-paint times; the companion journals them once into that battle's own journal, without names.
test("client paint timings are journaled once per request into the battle's journal", async () => {
  const journalDir = path.join(directory, "journal-latency");
  const h = await harness({ journalDir }), app = buildServer({ liveMetamon: h.advisor });
  try {
    await h.preview();
    const timing = { roomId, rqid: 1, kind: "preview", sections: { speed: 120, sets: 120, pick: 300, warnings: 340 } };
    const report = (timings: unknown[]) => app.inject({ method: "POST", url: "/v1/client/status", payload: { clientId: "c", tabs: [{ captureSession: sessionId, timings }] } });
    assert.equal((await report([timing])).statusCode, 200);
    assert.equal((await report([timing, { ...timing, roomId: "battle-gen9uu-other" }])).statusCode, 200);
    assert.equal((await report([{ ...timing, sections: { speed: "fast" } }])).statusCode, 200, "a malformed timing is ignored, never fatal");
    await h.advisor.settled();
    const [file] = await fs.readdir(journalDir);
    const rows = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "latency");
    assert.deepEqual(rows.map(({ at: _at, ...r }) => r), [{ kind: "latency", rqid: 1, request: "preview", sections: timing.sections }]);
  } finally { await app.close(); await h.advisor.close(); }
});
