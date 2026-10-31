// Human-only offline live-path replay. Does not connect to Showdown or send moves.
// Usage: node --import tsx scripts/metamon_port/live_replay.mts GAME SIDE OUT LAUNCH
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
// The live advice shows Metamon's top action; recorded games executed the worker's own sample (`sampledActionId`).
const sampledOf = (advice: any): string | null => advice?.sampledActionId ?? advice?.actionId ?? null;
const [gameDir, side, outFile, liveFile] = process.argv.slice(2);
const root = fileURLToPath(new URL("../../", import.meta.url));
if (!gameDir || !["p1", "p2"].includes(side) || !outFile || !liveFile) throw new Error("GAME_DIR SIDE OUT_JSON LAUNCH_JSON required");
const scratch = path.join(root, "tmp/metamon-port/live-mlx");
await fs.mkdir(scratch, { recursive: true });
const tmp = await fs.mkdtemp(path.join(scratch, "store-"));
process.env.LOCAL_INTEL_STORE_PATH = path.join(tmp, "intel.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(tmp, "curated.json");
process.env.MOVE_PRIOR_DESCRIPTOR = "";
delete process.env.SHWDN2OP_METAMON_LIVE_LAUNCH;
const src = path.join(root, "apps/companion/src");
const { LiveMetamonAdvisor, readLiveMetamonLaunch } = await import(`${src}/battle-agent/liveMetamon.ts`);
const { buildServer } = await import(`${src}/server.ts`);

await readLiveMetamonLaunch(liveFile); // the owner's real launch file must validate
const recorded = JSON.parse(await fs.readFile(path.join(gameDir, "metamon-launch.json"), "utf8"));
const raw = JSON.parse(await fs.readFile(liveFile, "utf8"));
// Validate the supplied config, then fix the recorded base seed for reproducible
// recurrence. The unused env value retains the launch reader's {seed} contract.
const workerPins = { recorded: recorded.worker_sha256, deployed: raw.workerSha256 };
const command = raw.command;
raw.args = ["SHWDN2OP_REPLAY_NONCE={seed}", command, ...raw.args.map((a: string) => a.replaceAll("{seed}", String(recorded.workerSeed)))];
raw.command = "/usr/bin/env";
const pinned = path.join(tmp, "launch.json");
await fs.writeFile(pinned, JSON.stringify(raw));
let now = Date.now();
const advisor = new LiveMetamonAdvisor(await readLiveMetamonLaunch(pinned), { now: () => now, idleMs: 600_000, ...(process.env.JOURNAL_DIR ? { journalDir: process.env.JOURNAL_DIR } : {}) });
const app = buildServer({ liveMetamon: advisor });
await app.ready();
const post = async (url: string, payload: object) => { const r = await app.inject({ method: "POST", url, payload }); return { code: r.statusCode, body: r.json() }; };
const chunks = (await fs.readFile(path.join(gameDir, `${side}-private.jsonl`), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string);
const trajectory = (await fs.readFile(path.join(gameDir, "trajectory.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((t) => t.side === side && t.accepted);
// Veto games: Metamon's recorded advice is the oracle; the executed (often different) choice is the "human" move.
const adviceFile = path.join(gameDir, "metamon-advice.jsonl");
const vetoAdvice = new Map<number, string>();
for (const l of (await fs.readFile(adviceFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)) {
  const a = JSON.parse(l);
  if (a.phase === "commit" && a.side === side) vetoAdvice.set(a.identity.rqid, a.adviceActionId);
}
const game = path.basename(gameDir);
const sessionId = `exact-${game}-${side}`, roomId = `battle-gen9uu-exact-${game}-${side}`;
let seq = 0;
const rows: any[] = [];
const started = Date.now();
const limit = Number(process.env.STOP_AFTER_CHUNKS ?? Infinity);
const stopMode = process.env.STOP_MODE ?? "leave";
const pids = new Set<number>();
const waits: number[] = [];
const inject = process.env.INJECT_LIVE === "1";
const withLive = (chunk: string, i: number) => {
  if (!inject || chunk.includes("|request|")) return chunk;
  if (chunk.includes("|teampreview")) return `|j|☆Alice\n|j|☆Bob\n|badge|p1|bronze|gen9uu|100-10\n|uhtml|medal-msg|<div class="broadcast-blue">Ladder Seasons</div>\n|html|<div class="broadcast-blue"><strong>[Gen 9] UU is currently suspecting X!</strong></div>\n${chunk}`;
  if (chunk.includes("|start")) return `${chunk}\n|c|☆Bob|GLHF\n|inactive|Battle timer is ON: inactive players will automatically lose when time's up. (requested by Bob)`;
  if (chunk.includes("|win|")) return `${chunk}\n|raw|Alice's rating: 1383 &rarr; <strong>1407</strong><br />(+24 for winning)\n|l|☆Bob`;
  return i % 5 ? `${chunk}\n|inactive|Alice has 120 seconds left.` : `${chunk}\n|c|☆Alice|nice\n|l|☆Carol\n|inactiveoff|Battle timer is now OFF.`;
};
let obsSeq = 0;
const observe = async (data: string, tag: string) => {
  const observationId = `o${++obsSeq}-${tag}`, s = ++seq;
  const r = await post("/v1/observations", { observations: [{ observationId, sessionId, sequence: obsSeq, roomId, source: "protocol", data: `>${roomId}\n${data}` }],
    metamonEvents: [{ kind: "observation", eventId: `e${s}`, sequence: s, sessionId, roomId, observationId }] });
  if (r.code !== 200) throw new Error(`observation ${observationId}: ${r.code} ${JSON.stringify(r.body).slice(0, 400)}`);
  return r;
};
try {
for (const [i, chunk] of chunks.entries()) {
  if (i >= limit) {
    // Mid-game departure: the extension's leave event must unload the remote worker.
    if (stopMode === "idle") { now += 600_001; await advisor.sweep(); }
    else {
      const l = ++seq;
      await post("/v1/metamon/events", { metamonEvents: [{ kind: "leave", eventId: `e${l}`, sequence: l, sessionId, roomId }] });
    }
    break;
  }
  const r = await observe(withLive(chunk, i), `c${i + 1}`);
  const req = chunk.split("\n").find((l) => l.startsWith("|request|"));
  if (!req) continue;
  const request = JSON.parse(req.slice(9));
  if (request.wait) { waits.push(request.rqid); continue; }
  const result = r.body.results[0];
  const identity = result.identity ?? result.current?.identity;
  const ev = await post("/v1/evaluate", { sessionId, identity, historyRevision: r.body.historyRevision });
  if (ev.code !== 200) throw new Error(`evaluate rqid ${request.rqid}: ${ev.code} ${JSON.stringify(ev.body).slice(0, 400)}`);
  const envelope = ev.body.envelope;
  let advice: any;
  for (const deadline = Date.now() + 240_000; ;) {
    advice = (await post("/v1/metamon/advice", { sessionId, identity, historyRevision: r.body.historyRevision, resultHash: envelope.resultHash })).body.metamonAdvice;
    if (advice?.status !== "warming" || Date.now() > deadline) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  await advisor.settled();
  for (const status of advisor.status()) if (status.pid) pids.add(status.pid);
  const want = trajectory.filter((t) => t.rqid === request.rqid).at(-1);
  const legal = envelope.semantic.snapshot.legalActions as any[];
  const advisedChoice = legal.find((a) => a.id === sampledOf(advice))?.choice ?? null;
  rows.push({ rqid: request.rqid, status: advice?.status, reason: advice?.reason ?? null, latencyMs: advice?.latencyMs ?? null,
    advisedActionId: sampledOf(advice) ?? null, advisedChoice, recordedActionId: want?.actionId ?? null, recordedChoice: want?.choice ?? null,
    oracle: vetoAdvice.size ? "advice" : "executed", oracleActionId: vetoAdvice.get(request.rqid) ?? want?.actionId ?? null,
    diverged: vetoAdvice.size ? vetoAdvice.get(request.rqid) !== want?.actionId : false,
    match: sampledOf(advice) != null && sampledOf(advice) === (vetoAdvice.size ? vetoAdvice.get(request.rqid) : want?.actionId), label: advice?.label ?? null });
  if (advice?.status !== "ready" || !want) throw new Error(`Advice failed rqid ${request.rqid}: ${JSON.stringify(advice)}`);
  if (inject) { await observe("|inactive|Alice has 60 seconds left.", "timer"); await observe("|c|☆Bob|hmm", "chat"); }
  const c = ++seq;
  const ce = await post("/v1/metamon/events", { metamonEvents: [{ kind: "choice", eventId: `e${c}`, sequence: c, sessionId, roomId, data: `/choose ${want.choice}|${request.rqid}` }] });
  if (ce.code !== 200) throw new Error(`choice ${request.rqid}: ${ce.code}`);
}
await advisor.settled();
const live = (await app.inject({ method: "GET", url: "/v1/metamon/live" })).json();
await app.close();
const processes = [...pids].map(pid => { let alive = true; try { process.kill(pid, 0); } catch { alive = false; } return { pid, absent: !alive }; });
assert.ok(processes.length && processes.every(p => p.absent), "all MLX workers must exit");
assert.ok(live.rooms.every((r: any) => r.state === "unavailable" && r.pid === null));
assert.ok(live.rooms.every((r: any) => r.reason === (limit < chunks.length ? stopMode === "idle" ? "idle" : "ended" : "ended")));
await fs.rm(tmp, { recursive: true, force: true });
const decisions = rows.length, matches = rows.filter((r) => r.match).length;
const diverged = rows.filter((r) => r.diverged).length;
const report = { workerPins, game, diverged, side, workerSeed: recorded.workerSeed, recordedHost: "gpubox", liveHost: "macbox MLX", decisions, matches,
  recordedDecisions: trajectory.length, chunks: chunks.length, wallMs: Date.now() - started, rows, processes, waits, liveAfter: live };
await fs.writeFile(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ processes, waits: waits.length, game, side, diverged, decisions, recordedDecisions: trajectory.length, matches, liveAfter: live.rooms }));

} finally { await app.close(); await fs.rm(tmp, { recursive: true, force: true }); }
