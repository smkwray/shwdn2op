// Tactical suite: perturbed decision states around the tactical turns of recorded games, replayed through the real
// live advisor path (LiveMetamonAdvisor + the given worker launch), reporting Metamon's raw vs re-ranked probability
// mass on each turn's identified bad actions.
// The journal's side and worker seed (its `start` record) select its suite; use one OUT_DIR per journal. Since the
// metamon-rerank@2 penalty decision it is
// NOT evidence: metamon-rerank@2 numbers are "tuned on this suite"; the pre-set @1 penalties (4/3/2) are shown beside
// them; and `regression` pins which guards fire, red or amber, on the bad actions of the unperturbed states. One model
// process at a time (each variant is a fresh worker, closed before the next). Private inputs/outputs stay in project tmp/.
// The case tables (turns, request ids, HP values) come from private journals: they live in a gitignored module
// (PRIVATE_CASES) that is not shipped, and the script stops with a clear error when it is missing.
// Every case is checked against its journal before any worker starts (exact `|turn|`, our active, a live request) and
// against the target's legal labels (its bad predicate must split them), so a dropped or mis-mapped case fails loudly.
// Usage: node --import tsx scripts/uu_eval/tactical_suite.mts JOURNAL.jsonl LAUNCH.json PRIORS.descriptor.json OUT_DIR [VARIANT_FILTER]
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Turn = { turn: number; rqid: number; bad: (label: string) => boolean; badText: string;
  /** Our active Pokémon at the target request, as the request names it (`p1: Arcanine` → "Arcanine"). */
  active: string;
  hp?: { mon: string; max: number; from: number; values: number[] };
  oppHp?: { mon: string; from: number; values: number[] }; item?: { ident: string; to: string };
  /** false: no trapped variant (a switch-selection case cannot switch when trapped). */
  trapped?: boolean };
// The pre-set metamon-rerank@1 log-penalties per guard kind, fixed before any result.
const PRESET: Record<string, number> = { delayed_slot_occupied: 4, pre_move_ko: 3, setup_dead_end: 3, switch_into_ko: 2 };
export const stays = (names: string[]) => (label: string) => names.some((name) => label === name || label === `Tera + ${name}`);
/** Exactly these labels (a Tera choice is "Tera + Move"; the plain move is a different action). */
export const exactly = (labels: string[]) => (label: string) => labels.includes(label);
export const switchTo = (name: string) => (label: string) => label.startsWith(`Switch to ${name},`) || label.startsWith(`Switch to ${name} (`);
export type Suite = { idPrefix: string; turns: Turn[]; armTurns: number[]; switchTurns?: number[];
  /** Real (unperturbed) state per turn: guard kinds expected on its bad actions (exactly none when empty) and state-level ones. */
  regression: Record<number, { id: string; fired: string[]; state?: string[] }> };
/** The private case tables: `SUITES`, keyed by the journal's `start` side and seed. Gitignored and never shipped. */
export const PRIVATE_CASES = fileURLToPath(new URL("../../config/local/tactical-suite/cases.mts", import.meta.url));
/** Load the case tables; a missing module or one without suites is an error, never an empty suite. */
export async function loadSuites(file = PRIVATE_CASES): Promise<Record<string, Suite>> {
  try { await fs.access(file); }
  catch { throw new Error(`Private tactical cases missing: ${file}. The real case tables are private and not shipped; this script needs that gitignored module.`); }
  const { SUITES } = await import(pathToFileURL(file).href);
  if (!SUITES || typeof SUITES !== "object" || !Object.keys(SUITES).length) throw new Error(`${file} exports no SUITES.`);
  return SUITES;
}

export const requestOf = (data: string) => { const line = data.split("\n").find((l) => l.startsWith("|request|")); return line ? JSON.parse(line.slice(9)) : undefined; };
type Variant = { hp?: number; oppHp?: number; item?: boolean; trapped?: boolean };
/** The perturbation grid of one case: HP × opponent HP × item × trapped (no trapped variant when `trapped: false`). */
export function variantGrid(t: Turn): Variant[] {
  const grid: Variant[] = [];
  for (const hp of t.hp?.values ?? [undefined]) for (const oppHp of t.oppHp?.values ?? [undefined])
    for (const item of t.item ? [false, true] : [false]) for (const trapped of t.trapped === false ? [false] : [false, true])
      grid.push({ ...(hp === undefined ? {} : { hp }), ...(oppHp === undefined ? {} : { oppHp }), ...(t.item ? { item } : {}), trapped });
  return grid;
}
export const variantId = (suite: Suite, t: Turn, variant: Variant) =>
  `${suite.idPrefix}t${t.turn}-${Object.entries(variant).map(([k, v]) => `${k}${v === true ? "" : v === false ? "0" : v}`).join("-")}`.replace(/-trapped0$/, "");
/** Internal consistency: every case has a regression entry, every arm, switch and regression turn is a case, and each
 * regression id is one of its variants. */
export function checkSuite(suite: Suite) {
  const turns = new Set(suite.turns.map((t) => t.turn));
  if (turns.size !== suite.turns.length) throw new Error("duplicate case turn");
  for (const turn of turns) if (!suite.regression[turn]) throw new Error(`T${turn} has no regression entry`);
  for (const turn of [...suite.armTurns, ...(suite.switchTurns ?? [])]) if (!turns.has(turn)) throw new Error(`arm turn ${turn} has no case`);
  for (const [turn, expected] of Object.entries(suite.regression)) {
    const t = suite.turns.find((c) => c.turn === Number(turn));
    if (!t) throw new Error(`regression turn ${turn} has no case`);
    if (!variantGrid(t).some((v) => variantId(suite, t, v) === expected.id)) throw new Error(`regression id ${expected.id} is not a T${turn} variant`);
  }
}
/** The frame index of the case's request, checked against the journal: it exists, is a decision (not `wait`), is in the
 * case's turn (the last exact `|turn|N` line before it) and has the case's active Pokémon. */
export function locateCase(frames: ReadonlyArray<{ data: string }>, t: Turn): number {
  const target = frames.findIndex((f) => requestOf(f.data)?.rqid === t.rqid);
  if (target < 0) throw new Error(`T${t.turn}: rqid ${t.rqid} not in journal`);
  const request = requestOf(frames[target]!.data);
  if (request.wait) throw new Error(`T${t.turn}: rqid ${t.rqid} is a wait request`);
  let turn = 0;
  for (const frame of frames.slice(0, target + 1)) for (const line of frame.data.split("\n")) {
    if (line.startsWith("|turn|")) turn = Number(line.slice(6));
    if (line.startsWith("|request|") && JSON.parse(line.slice(9)).rqid === t.rqid) break;
  }
  if (turn !== t.turn) throw new Error(`T${t.turn}: rqid ${t.rqid} is in turn ${turn}`);
  const active = (request.side?.pokemon ?? []).find((mon: any) => mon.active)?.ident?.replace(/^p[12]: /, "");
  if (active !== t.active) throw new Error(`T${t.turn}: rqid ${t.rqid} has ${active} active, not ${t.active}`);
  return target;
}
/** The bad predicate must split the target's enabled actions: matching none (a renamed move) or all (no better choice)
 * means the case measures nothing. A trapped variant removes the switches by design, so there only "none" is an error
 * (a trapped Slowking may have only Future Sight left). */
export function checkLabels(t: Turn, labels: readonly string[], trapped = false) {
  const bad = labels.filter((label) => t.bad(label));
  if (!bad.length || (!trapped && bad.length === labels.length)) throw new Error(`T${t.turn}: bad predicate matches ${bad.length} of ${labels.length} legal actions`);
  return bad;
}

async function main() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const [journalFile, launchFile, priorsFile, outDir, filter] = process.argv.slice(2);
  if (!journalFile || !launchFile || !priorsFile || !outDir) throw new Error("JOURNAL LAUNCH PRIORS OUT_DIR required");
  const out = path.resolve(outDir);
  if (!out.startsWith(path.join(root, "tmp") + path.sep)) throw new Error("Output must be under project tmp/.");
  const records = (await fs.readFile(journalFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const start = records.find((r) => r.kind === "start");
  const roomId: string = start.roomId;
  const suite = (await loadSuites())[`${start.side}:${start.seed}`];
  if (!suite) throw new Error("No tactical suite for this journal.");
  checkSuite(suite);
  const SUITE = suite.turns;
  const frames = records.filter((r) => r.kind === "frame");
  // Every case is mapped before any worker starts.
  for (const t of SUITE) locateCase(frames, t);
  await fs.mkdir(out, { recursive: true });
  process.env.LOCAL_INTEL_STORE_PATH = path.join(out, "FORBIDDEN-history.json");
  process.env.EXTERNAL_CURATED_STORE_PATH = path.join(out, "FORBIDDEN-curated.json");
  const src = path.join(root, "apps/companion/src");
  const { LiveMetamonAdvisor, readLiveMetamonLaunch } = await import(`${src}/battle-agent/liveMetamon.ts`);
  const { DecisionEngine } = await import(`${src}/state/decisionEngine.ts`);
  const { buildDecisionEnvelope } = await import(`${src}/state/decisionEnvelope.ts`);
  const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } = await import(`${src}/history/opponentIntelStore.ts`);
  const { loadMetaMovePriorDescriptor } = await import(`${src}/history/metaPriorStore.ts`);
  const { rerankDecision } = await import(`${src}/battle-agent/rerank.ts`);
  const opponent = start.side === "p1" ? "p2a" : "p1a";
  const commits = new Map<number, string>(records.filter((r) => r.kind === "commit").map((r) => [r.rqid, r.choice]));
  const movePriors = await loadMetaMovePriorDescriptor(path.resolve(priorsFile), root);
  const launch = JSON.parse(await fs.readFile(launchFile, "utf8"));
  await readLiveMetamonLaunch(launchFile);

  /** Text-level perturbation of the frames up to the target request; every edited value is one the protocol carries. */
  function perturb(t: Turn, variant: Variant) {
    const target = locateCase(frames, t);
    const turnStart = frames.findLastIndex((f, i) => i < target && f.data.split("\n").includes(`|turn|${t.turn}`));
    return frames.slice(0, target + 1).map((frame, index) => {
      let data: string = frame.data;
      // Our max HP is unique per Pokémon and this current value first appears at the damage that set it, so one global
      // substitution changes that damage line and every later public line and private request together.
      if (t.hp && variant.hp !== undefined && variant.hp !== t.hp.from) data = data.split(`${t.hp.from}/${t.hp.max}`).join(`${variant.hp}/${t.hp.max}`);
      if (t.oppHp && variant.oppHp !== undefined && index >= turnStart) data = data.replace(new RegExp(`(${opponent}: ${t.oppHp.mon}\\|)${t.oppHp.from}/100`, "g"), `$1${variant.oppHp}/100`);
      if (variant.item && t.item) data = data.split("\n").map((line) => {
        if (!line.startsWith("|request|")) return line;
        const request = JSON.parse(line.slice(9));
        for (const mon of request.side?.pokemon ?? []) if (mon.ident === t.item!.ident) mon.item = t.item!.to;
        return `|request|${JSON.stringify(request)}`;
      }).join("\n");
      if (variant.trapped && index === target) data = data.split("\n").map((line) => {
        if (!line.startsWith("|request|")) return line;
        const request = JSON.parse(line.slice(9));
        request.active[0].trapped = true;
        return `|request|${JSON.stringify(request)}`;
      }).join("\n");
      return { sequence: frame.sequence, data };
    });
  }

  async function runVariant(t: Turn, variant: Variant, id: string) {
    const sessionId = `tactical-${id}`, journalDir = path.join(out, "journals", id);
    await fs.rm(journalDir, { recursive: true, force: true });
    const fixed = { ...launch, args: launch.args.map((arg: string) => arg.replaceAll("{seed}", String(start.seed))) };
    fixed.args = ["SHWDN2OP_TACTICAL_NONCE={seed}", fixed.command, ...fixed.args]; fixed.command = "/usr/bin/env";
    const pinned = path.join(out, `launch-${id}.json`);
    await fs.writeFile(pinned, JSON.stringify(fixed));
    const advisor = new LiveMetamonAdvisor(await readLiveMetamonLaunch(pinned), { journalDir, operationMs: 240_000, idleMs: 3_600_000 });
    const engine = new DecisionEngine();
    let priors = await createEphemeralIntelEvaluationContext(movePriors), plain = await createEphemeralIntelEvaluationContext();
    let sequence = 0, eventSequence = 0, envelopes: { priors: any; none: any } | undefined;
    const event = (fields: object) => ({ sessionId, roomId, eventId: `e${++eventSequence}`, sequence: eventSequence, ...fields });
    const started = Date.now();
    try {
      const stream = perturb(t, variant);
      for (const [index, frame] of stream.entries()) {
        const observation = { sessionId, roomId, observationId: `f${frame.sequence}`, sequence: ++sequence, source: "protocol" as const, data: `>${roomId}\n${frame.data}` };
        const current = await engine.ingest(observation);
        if (current.changed && current.snapshot) {
          priors = await projectCanonicalSnapshots([current.snapshot], priors);
          plain = await projectCanonicalSnapshots([current.snapshot], plain);
        }
        advisor.accept([event({ kind: "observation", observationId: observation.observationId })], [{ observation, current, context: priors }]);
        await advisor.settled();
        const request = requestOf(frame.data);
        if (index === stream.length - 1) {
          envelopes = { priors: await buildDecisionEnvelope(current.snapshot!, current.identity!, priors, current.room.lastRequest?.side?.pokemon ?? []),
            none: await buildDecisionEnvelope(current.snapshot!, current.identity!, plain, current.room.lastRequest?.side?.pokemon ?? []) };
        } else if (request && !request.wait && commits.has(request.rqid)) {
          const choice = commits.get(request.rqid)!;
          advisor.accept([event({ kind: "choice", data: `/choose ${choice}|${request.rqid}` })]);
          await advisor.settled();
        }
      }
      const status = advisor.status()[0];
      advisor.accept([event({ kind: "leave" })]);
      await advisor.settled(); await advisor.close();
      const [file] = await fs.readdir(journalDir);
      const advice = (await fs.readFile(path.join(journalDir, file!), "utf8")).trim().split("\n").map((l) => JSON.parse(l))
        .find((r) => r.kind === "advice" && r.rqid === t.rqid);
      if (!advice?.rerank?.rawProbabilities) throw new Error(`no target advice (${status?.state}/${status?.reason})`);
      const legal = envelopes!.priors.semantic.snapshot.legalActions as Array<{ id: string; label: string }>;
      const label = (id: string) => legal.find((a) => a.id === id)!.label;
      checkLabels(t, Object.keys(advice.rerank.rawProbabilities).map(label), variant.trapped);
      const mass = (p: Record<string, number>) => Object.entries(p).filter(([id]) => t.bad(label(id))).reduce((sum, [, v]) => sum + v, 0);
      const noPriors = rerankDecision(envelopes!.none, advice.rerank.rawProbabilities, advice.rerank.rawActionId, advice.rerank.seedKey);
      // The superseded pre-set rule (metamon-rerank@1): p' ∝ p·exp(−Σ penalties), 4 rules-certain, 3 pre-move KO/dead end, 2 switch.
      const preset = (() => {
        const weight = Object.entries(advice.rerank.rawProbabilities as Record<string, number>).map(([id, p]) =>
          [id, p * Math.exp(-((advice.rerank.flagged[id] ?? []) as string[]).reduce((sum, kind) => sum + PRESET[kind]!, 0))] as const);
        const total = weight.reduce((sum, [, w]) => sum + w, 0);
        return Object.fromEntries(weight.map(([id, w]) => [id, w / total]));
      })();
      const red = (guards: any[]) => guards.filter((g) => g.severity === "red").map((g) => g.kind);
      return { id, turn: t.turn, rqid: t.rqid, variant, badText: t.badText, ms: Date.now() - started,
        hpPercent: envelopes!.priors.semantic.snapshot.yourSide.active?.hpPercent ?? null,
        rawPick: label(advice.rerank.rawActionId), rerankPick: advice.rerank.rerankActionId ? label(advice.rerank.rerankActionId) : null,
        rawBadMass: mass(advice.rerank.rawProbabilities), rerankBadMass: mass(advice.rerank.rerankedProbabilities), presetBadMass: mass(preset),
        firedOnBad: [...new Set((advice.rerank.guards as Array<{ kind: string; actionIds: string[] }>)
          .filter((g) => g.actionIds.some((id) => t.bad(label(id)))).map((g) => g.kind))].sort(),
        stateGuards: [...new Set((advice.rerank.guards as Array<{ kind: string; actionIds: string[] }>).filter((g) => !g.actionIds.length).map((g) => g.kind))].sort(),
        flagged: Object.fromEntries(Object.entries(advice.rerank.flagged as Record<string, string[]>).map(([id, kinds]) => [label(id), kinds])),
        redGuards: red(advice.rerank.guards), amberGuards: advice.rerank.guards.filter((g: any) => g.severity === "amber").map((g: any) => g.kind),
        noPriors: { rerankBadMass: mass(noPriors.rerankedProbabilities!), redGuards: red(noPriors.guards) },
        raw: Object.fromEntries(Object.entries(advice.rerank.rawProbabilities as Record<string, number>).map(([id, p]) => [label(id), p])),
        reranked: Object.fromEntries(Object.entries(advice.rerank.rerankedProbabilities as Record<string, number>).map(([id, p]) => [label(id), p])),
        guards: advice.rerank.guards.map((g: any) => `[${g.severity}] ${g.message}`) };
    } finally { await advisor.close(); }
  }

  const rowsFile = path.join(out, "rows.jsonl");
  const done = new Set((await fs.readFile(rowsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id));
  for (const t of SUITE) {
    for (const variant of variantGrid(t)) {
      const id = variantId(suite, t, variant);
      if (done.has(id) || (filter && !id.includes(filter))) continue;
      let row;
      // One model at a time: the previous worker's lock is released at its exit; allow it a moment, then one retry.
      try { row = await runVariant(t, variant, id); }
      catch (error) { console.error(`${id}: ${error instanceof Error ? error.message : error}; retrying once`); await new Promise((r) => setTimeout(r, 3000)); row = await runVariant(t, variant, id); }
      await new Promise((r) => setTimeout(r, 500));
      await fs.appendFile(rowsFile, JSON.stringify(row) + "\n");
      console.log(`${id}: raw bad ${row.rawBadMass.toFixed(3)} -> re-ranked ${row.rerankBadMass.toFixed(3)} red=[${row.redGuards}] (${row.ms} ms)`);
    }
  }

  // Report. B0 = Metamon raw p; B1 = metamon-rerank@2 (τ from the live default config), TUNED ON THIS SUITE; B1preset = the
  // superseded pre-set 4/3/2 log-penalties. failureRate = mean over perturbed states of mass on the turn's bad actions.
  const rows = (await fs.readFile(rowsFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const summarize = (subset: any[]) => ({ n: subset.length, B0: mean(subset.map((r) => r.rawBadMass)), B1: mean(subset.map((r) => r.rerankBadMass)),
    B1preset: mean(subset.map((r) => r.presetBadMass)), B1NoPriors: mean(subset.map((r) => r.noPriors.rerankBadMass)), redFired: subset.filter((r) => r.redGuards.length).length });
  const losses = rows.filter((r) => suite.armTurns.includes(r.turn));
  // Guard-firing regression on the REAL states (no perturbation): which kinds fire on Metamon's bad actions, whether
  // they re-rank (red) or only warn (amber, demoted in the live config), and the expected state-level warnings.
  const regression = Object.fromEntries(Object.entries(suite.regression).map(([turn, expected]) => {
    const r = rows.find((row) => row.id === expected.id);
    const fired: string[] | null = r?.firedOnBad ?? null, state: string[] | null = r?.stateGuards ?? null;
    const pass = Boolean(fired) && expected.fired.every((kind) => fired!.includes(kind)) && (expected.fired.length > 0 || fired!.length === 0)
      && (expected.state ?? []).every((kind) => state?.includes(kind));
    return [turn, { id: expected.id, expectedFiredOnBadActions: expected.fired, firedOnBadActions: fired, expectedStateGuards: expected.state ?? [], stateGuards: state,
      red: r?.redGuards ?? null, amber: r?.amberGuards ?? null, pass }];
  }));
  const report = { schema: "tactical-suite@2", evidence: false, label: "metamon-rerank@2 numbers are tuned on this suite (not evidence)",
    journalSha256: createHash("sha256").update(await fs.readFile(journalFile)).digest("hex"),
    priorsDescriptor: path.resolve(priorsFile), launch: path.resolve(launchFile), suite: SUITE.map(({ bad, ...t }) => t),
    definition: "failureRate = mean over perturbed states of probability mass on the turn's identified bad actions (arm turns only); B0 = Metamon raw p, B1 = metamon-rerank@2 p' (tuned on the loss suite), B1preset = pre-set 4/3/2 log-penalties",
    roomId, armTurns: suite.armTurns,
    arms: { B0: { failureRate: summarize(losses).B0, n: losses.length }, B1: { failureRate: summarize(losses).B1, n: losses.length },
      B1preset: { failureRate: summarize(losses).B1preset, n: losses.length } },
    ...(suite.switchTurns ? { switchSelection: summarize(rows.filter((r) => suite.switchTurns!.includes(r.turn))) } : {}),
    perTurn: Object.fromEntries(SUITE.map((t) => [t.turn, summarize(rows.filter((r) => r.turn === t.turn))])),
    untrapped: Object.fromEntries(SUITE.map((t) => [t.turn, summarize(rows.filter((r) => r.turn === t.turn && !r.variant.trapped))])),
    all: summarize(rows), regression: { pass: Object.values(regression).every((r: any) => r.pass), turns: regression } };
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 1) + "\n");
  console.log(JSON.stringify({ arms: report.arms, perTurn: report.perTurn, regression: report.regression.pass }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
