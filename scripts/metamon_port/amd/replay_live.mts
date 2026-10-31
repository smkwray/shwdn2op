// Exactness check of the live advisor path for any launch config: replay a recorded side through
// the companion's HTTP advisor (in-process server; no port, no running companion touched) with
// the real remote worker and the game's recorded seed. Parameterized copy of
// tmp/shwdn2op-live-exact/replay.mts. Run from apps/companion:
//   node --import tsx ../../scripts/metamon_port/amd/replay_live.mts GAME_DIR SIDE OUT.json LAUNCH.json
// Env: LEAVE_AFTER_CHUNKS=N (mid-game leave), IDLE_AFTER_CHUNKS=N with IDLE_MS (stop feeding,
// let the idle sweep unload), INJECT_LIVE=1 (chat/timer noise), JOURNAL_DIR (advisor journal),
// HUMAN_SWITCH="switch N" (a recorded rejected attempt is submitted as this switch instead, which
// drives the advisor's stage_switch). Every recorded attempt, rejected ones included, is replayed in order.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The live advice shows Metamon's top action; recorded games executed the worker's own sample (`sampledActionId`).
const sampledOf = (advice: any): string | null => advice?.sampledActionId ?? advice?.actionId ?? null;
const [gameDir, side, outFile, launchArg] = process.argv.slice(2);
if (!gameDir || !side || !outFile || !launchArg) throw new Error("usage: GAME_DIR SIDE OUT.json LAUNCH.json");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = path.join(root, "tmp", "replay-live-scratch");
await fs.mkdir(scratch, { recursive: true });
const tmp = await fs.mkdtemp(path.join(scratch, "store-"));
process.env.LOCAL_INTEL_STORE_PATH = path.join(tmp, "intel.json");
process.env.EXTERNAL_CURATED_STORE_PATH = path.join(tmp, "curated.json");
process.env.MOVE_PRIOR_DESCRIPTOR = "";
delete process.env.SHWDN2OP_METAMON_LIVE_LAUNCH;
const src = path.join(root, "apps/companion/src");
const { LiveMetamonAdvisor, readLiveMetamonLaunch } = await import(`${src}/battle-agent/liveMetamon.ts`);
const { buildServer } = await import(`${src}/server.ts`);
const liveFile = path.resolve(launchArg);
await readLiveMetamonLaunch(liveFile); // the launch file under test must validate as-is
const recorded = JSON.parse(await fs.readFile(path.join(gameDir, "metamon-launch.json"), "utf8"));
const raw = JSON.parse(await fs.readFile(liveFile, "utf8"));
// Pin the recorded seed in --seed; an informational {seed} (e.g. --label) must remain so the
// advisor's per-battle substitution still runs and the launch still validates.
raw.args = raw.args.map((arg: string) => arg.replace(/--seed '?\{seed\}'?/g, `--seed ${recorded.workerSeed}`));
if (!raw.args.some((arg: string) => arg.includes("{seed}"))) {
  const last = raw.args.length - 1;
  if (!raw.args[last].includes("/usr/bin/env ")) throw new Error("launch keeps no informational {seed} after pinning --seed");
  raw.args[last] = raw.args[last].replace("/usr/bin/env ", "/usr/bin/env SHWDN2OP_LIVE_SEED_UNUSED={seed} ");
}
if (!raw.args.some((arg: string) => arg.includes(`--seed ${recorded.workerSeed}`))) throw new Error("launch seed placeholder missing");
const workerPins = { recorded: recorded.worker_sha256, deployed: raw.workerSha256 };
const pinned = path.join(tmp, "launch.json");
await fs.writeFile(pinned, JSON.stringify(raw));
const idleMs = process.env.IDLE_MS ? Number(process.env.IDLE_MS) : undefined;
const advisor = new LiveMetamonAdvisor(await readLiveMetamonLaunch(pinned),
  { ...(process.env.JOURNAL_DIR ? { journalDir: process.env.JOURNAL_DIR } : {}), ...(idleMs ? { idleMs } : {}) });
const app = buildServer({ liveMetamon: advisor });
await app.ready();
const post = async (url: string, payload: object) => { const r = await app.inject({ method: "POST", url, payload }); return { code: r.statusCode, body: r.json() }; };
const chunks = (await fs.readFile(path.join(gameDir, `${side}-private.jsonl`), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string);
const trajectory = (await fs.readFile(path.join(gameDir, "trajectory.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((t) => t.side === side);
const attempts = new Map<number, any[]>();
for (const t of trajectory) attempts.set(t.rqid, [...(attempts.get(t.rqid) ?? []), t]);
const used = new Map<number, number>();
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
const leaveAfter = Number(process.env.LEAVE_AFTER_CHUNKS ?? Infinity);
const idleAfter = Number(process.env.IDLE_AFTER_CHUNKS ?? Infinity);
const inject = process.env.INJECT_LIVE === "1";
const withLive = (chunk: string, i: number) => {
  if (!inject || chunk.includes("|request|")) return chunk;
  if (chunk.includes("|teampreview")) return `|j|☆Alice\n|j|☆Bob\n|badge|p1|bronze|gen9uu|100-10\n${chunk}`;
  if (chunk.includes("|start")) return `${chunk}\n|c|☆Bob|GLHF\n|inactive|Battle timer is ON: inactive players will automatically lose when time's up. (requested by Bob)`;
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
let ending = chunks.some((c) => /^\|(win|tie)\|/m.test(c)) ? "win" : "end_of_recording";
let waits = 0;
for (const [i, chunk] of chunks.entries()) {
  if (i >= leaveAfter) {
    const l = ++seq;
    await post("/v1/metamon/events", { metamonEvents: [{ kind: "leave", eventId: `e${l}`, sequence: l, sessionId, roomId }] });
    ending = "leave";
    break;
  }
  if (i >= idleAfter) {
    ending = "idle";
    const deadline = Date.now() + (idleMs ?? 900_000) + 30_000;
    while (Date.now() < deadline) {
      const rooms = (await app.inject({ method: "GET", url: "/v1/metamon/live" })).json().rooms;
      if (rooms.every((r: any) => r.state === "unavailable")) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    break;
  }
  const r = await observe(withLive(chunk, i), `c${i + 1}`);
  const req = chunk.split("\n").find((l) => l.startsWith("|request|"));
  if (!req) continue;
  const request = JSON.parse(req.slice(9));
  if (request.wait) { waits++; continue; }
  const result = r.body.results[0];
  const identity = result.identity ?? result.current?.identity;
  const ev = await post("/v1/evaluate", { sessionId, identity, historyRevision: r.body.historyRevision });
  if (ev.code !== 200) throw new Error(`evaluate rqid ${request.rqid}: ${ev.code} ${JSON.stringify(ev.body).slice(0, 400)}`);
  const envelope = ev.body.envelope;
  const asked = Date.now();
  let advice: any;
  for (const deadline = Date.now() + 240_000; ;) {
    advice = (await post("/v1/metamon/advice", { sessionId, identity, historyRevision: r.body.historyRevision, resultHash: envelope.resultHash })).body.metamonAdvice;
    if (advice?.status !== "warming" || Date.now() > deadline) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const tries = attempts.get(request.rqid) ?? [], attempt = used.get(request.rqid) ?? 0;
  const want = tries[attempt];
  const human = want && want.accepted === false && process.env.HUMAN_SWITCH ? process.env.HUMAN_SWITCH : want?.choice;
  const legal = envelope.semantic.snapshot.legalActions as any[];
  rows.push({ rqid: request.rqid, attempt, accepted: want?.accepted ?? null, humanChoice: human ?? null, status: advice?.status, reason: advice?.reason ?? null, latencyMs: advice?.latencyMs ?? null,
    pollMs: Date.now() - asked, advisedActionId: sampledOf(advice) ?? null,
    advisedChoice: legal.find((a) => a.id === sampledOf(advice))?.choice ?? null, recordedActionId: want?.actionId ?? null,
    oracle: vetoAdvice.size ? "advice" : "executed", oracleActionId: vetoAdvice.get(request.rqid) ?? want?.actionId ?? null,
    match: sampledOf(advice) != null && sampledOf(advice) === (vetoAdvice.size ? vetoAdvice.get(request.rqid) : want?.actionId), label: advice?.label ?? null });
  if (advice?.status !== "ready" || !want) break;
  if (inject) { await observe("|inactive|Alice has 60 seconds left.", "timer"); await observe("|c|☆Bob|hmm", "chat"); }
  const c = ++seq;
  used.set(request.rqid, attempt + 1);
  const ce = await post("/v1/metamon/events", { metamonEvents: [{ kind: "choice", eventId: `e${c}`, sequence: c, sessionId, roomId, data: `/choose ${human}|${request.rqid}` }] });
  if (ce.code !== 200) throw new Error(`choice ${request.rqid}: ${ce.code}`);
}
const liveBefore = (await app.inject({ method: "GET", url: "/v1/metamon/live" })).json();
await advisor.settled();
const live = (await app.inject({ method: "GET", url: "/v1/metamon/live" })).json();
await app.close();
await fs.rm(tmp, { recursive: true, force: true });
const decisions = rows.length, matches = rows.filter((r) => r.match).length;
const report = { workerPins, game, side, ending, waits, workerSeed: recorded.workerSeed, launch: liveFile, liveHost: raw.host ?? null,
  decisions, matches, recordedDecisions: trajectory.length, chunks: chunks.length, wallMs: Date.now() - started,
  rows, liveBeforeSettle: liveBefore, liveAfter: live };
await fs.writeFile(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ game, side, ending, waits, decisions, recordedDecisions: trajectory.length, matches, liveAfter: live.rooms }));
