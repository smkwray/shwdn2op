// Tactical-guard precision audit (penalty decision for metamon-rerank@2). CPU only.
// Reconstructs every accepted move decision of finished uu_eval cohorts in memory (verify_canonical.ts's DecisionEngine
// replay, but with the live ladder set priors), computes the tactical guards, and checks each red fire on the executed
// action against the public log. Cohort directories are only read; every output goes under tmp/guard-audit-*/.
// Usage (from the project root):
//   node --import tsx scripts/uu_eval/guard_audit.mts plan OUT COHORT_DIR...
//   node --import tsx scripts/uu_eval/guard_audit.mts run OUT SHARD COUNT [WORKLIST.json] [LIMIT]
//   node --import tsx scripts/uu_eval/guard_audit.mts summarize OUT
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Dex } from "@pkmn/dex";

export type FlagKind = "delayed_slot_occupied" | "pre_move_ko" | "setup_dead_end" | "switch_into_ko";
export type Outcome = "confirmed" | "refuted" | "unresolved";
export type TurnEnd = "turn" | "game_end" | "log_end";
export const FLAG_KINDS: readonly FlagKind[] = ["delayed_slot_occupied", "pre_move_ko", "setup_dead_end", "switch_into_ko"];
const TACTICAL: readonly FlagKind[] = ["pre_move_ko", "setup_dead_end", "switch_into_ko"];
const KAKUNA = "metamon:Kakuna:epoch34";
const PRIORS = "tmp/meta-priors/gen9uu-2026-09.descriptor.json";

const noise = (line: string) => line === "" || line === "|" || line.startsWith("|t:|");
const gameEnd = (line: string) => line.startsWith("|win|") || line === "|tie" || line.startsWith("|tie|");

/** The public-log lines that resolve `turn` (after `|turn|<turn>`, before `|turn|<turn+1>`), without timestamps and
 * blank separators. end: "turn" = the next turn started; "game_end" = `|win|`/`|tie` (included); "log_end" = the log
 * stops first (a failed or truncated game). null when the log never reached `|turn|<turn>`. */
export function turnLines(log: string | readonly string[], turn: number): { lines: string[]; end: TurnEnd } | null {
  const all = typeof log === "string" ? log.split("\n") : log;
  const start = all.indexOf(`|turn|${turn}`);
  if (start < 0) return null;
  const lines: string[] = [];
  for (const line of all.slice(start + 1)) {
    if (line === `|turn|${turn + 1}`) return { lines, end: "turn" };
    if (noise(line)) continue;
    lines.push(line);
    if (gameEnd(line)) return { lines, end: "game_end" };
  }
  return { lines, end: "log_end" };
}

type Event = { type: string; args: string[]; line: string };
const parse = (line: string): Event => { const parts = line.split("|"); return { type: parts[1] ?? "", args: parts.slice(2), line }; };
const result = (outcome: Outcome, reason: string) => ({ outcome, reason });
const norm = (value: string | undefined) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const DELAYED = new Set(["futuresight", "doomdesire"]);
/** A move line that is a reaction (Magic Bounce, Dancer), not the Pokémon's own action. */
const reaction = (event: Event) => /\[from\]\s*ability:/i.test(event.line);
const damagingMove = (name: string | undefined) => { const move = Dex.forGen(9).moves.get(name ?? ""); return move.exists && move.category !== "Status"; };
const endReason = (end: TurnEnd) => end === "game_end" ? "game_ended" : end === "log_end" ? "log_ended" : "turn_ended";

/** Classify one executed red fire against the public log. `side` is our side ("p1"/"p2"); our active is the Pokémon
 * in slot `<side>a` when the turn starts (or, for switch_into_ko, the one our switch brings in); it stops being ours
 * when another Pokémon enters the slot (`switch`/`drag`), and an Illusion `replace` keeps it. */
export function classifyOutcome(input: { kind: FlagKind; log: string | readonly string[]; turn: number; side: "p1" | "p2"; moveName?: string }): { outcome: Outcome; reason: string } {
  const { kind, log, turn, side } = input;
  const first = turnLines(log, turn);
  if (!first) return result("unresolved", "turn_not_reached");
  const ours = (event: Event) => (event.args[0] ?? "").startsWith(`${side}a:`);
  const entering = (event: Event) => (event.type === "switch" || event.type === "drag") && ours(event);
  const events = first.lines.map(parse);

  if (kind === "delayed_slot_occupied") {
    for (const [index, event] of events.entries()) {
      if (!ours(event)) continue;
      if (event.type === "faint") return result("unresolved", "fainted_before_moving");
      if (event.type === "cant") return result("unresolved", "cant_move");
      if (entering(event)) return result("unresolved", "left_field_before_moving");
      if (event.type !== "move" || reaction(event)) continue;
      if (!DELAYED.has(norm(event.args[1])) || (input.moveName && norm(input.moveName) !== norm(event.args[1]))) return result("unresolved", "other_move_used");
      if (event.line.includes("[notarget]")) return result("unresolved", "no_target"); // Gen 5+ prints -fail for a missing target too
      for (const next of events.slice(index + 1)) {
        if (["move", "switch", "drag", "cant", "faint", "upkeep", "win", "tie"].includes(next.type)) break;
        if (next.type === "-fail" && ours(next)) return result("confirmed", "failed_slot_occupied");
        if (next.type === "-start" && ours(next) && DELAYED.has(norm(next.args[1]?.replace(/^move:\s*/i, "")))) return result("refuted", "scheduled");
      }
      return result("refuted", "executed_without_fail");
    }
    return result("unresolved", `not_executed_${endReason(first.end)}`);
  }

  if (kind === "pre_move_ko") {
    for (const event of events) {
      if (!ours(event)) continue;
      if (event.type === "faint") return result("confirmed", "fainted_before_moving");
      if (event.type === "move" && !reaction(event)) return result("refuted", "moved_first");
      if (event.type === "cant") return result("refuted", `alive_at_action_${norm(event.args[1]) || "cant"}`);
      if (entering(event)) return result("refuted", "left_field_alive");
    }
    if (first.end === "log_end") return result("unresolved", "log_ended");
    return result("refuted", first.end === "game_end" ? "alive_at_game_end" : "alive_at_turn_end");
  }

  if (kind === "setup_dead_end") {
    const second = first.end === "turn" ? turnLines(log, turn + 1) : null;
    for (const event of [...events, ...(second?.lines ?? []).map(parse)]) {
      if (!ours(event)) continue;
      if (event.type === "faint") return result("confirmed", "fainted_without_damaging_move");
      if (entering(event)) return result("unresolved", "switched_out_first");
      if (event.type === "move" && damagingMove(event.args[1])) return result("refuted", "damaging_move_used");
    }
    const end = first.end === "turn" ? second!.end : first.end;
    return end === "turn" ? result("refuted", "alive_after_next_turn") : result("unresolved", endReason(end));
  }

  // switch_into_ko: the first Pokémon entering our slot this turn is our switch-in (switches act before moves).
  let tracking = false;
  for (const event of events) {
    if (!ours(event)) continue;
    if (!tracking) { if (event.type === "switch") tracking = true; continue; }
    if (event.type === "faint") return result("confirmed", "fainted_on_entry_turn");
    if (entering(event)) return result("refuted", "left_field_alive");
  }
  if (!tracking) return result("unresolved", "switch_not_seen");
  return first.end === "turn" ? result("refuted", "alive_at_turn_end") : result("unresolved", endReason(first.end));
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI (no side effects on import).
const root = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const readJsonl = async (file: string) => (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
function outDir(value: string | undefined) {
  if (!value) throw new Error("OUT required");
  const out = path.resolve(value), relative = path.relative(path.join(root, "tmp"), out);
  if (!relative.startsWith("guard-audit-") || relative.startsWith("..")) throw new Error("OUT must be under tmp/guard-audit-*/");
  return out;
}
const stripTimes = (text: string) => text.split("\n").filter((line) => !line.startsWith("|t:|")).join("\n");

/** Games repeat exactly across cohort attempts (fixed seeds), so each game is keyed by its content without timestamps. */
async function plan(out: string, cohorts: string[]) {
  const games: any[] = [];
  for (const cohort of cohorts.map((c) => path.resolve(c))) {
    for (const slot of (await fs.readdir(cohort)).filter((name) => /^slot-\d+-B[01]$/.test(name)).sort()) {
      const dir = path.join(cohort, slot);
      const summary = JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8").catch(() => "null"));
      if (!summary) continue;
      const job = JSON.parse(await fs.readFile(path.join(dir, "job.json"), "utf8"));
      const hash = createHash("sha256");
      hash.update(stripTimes(await fs.readFile(path.join(dir, "replay.log"), "utf8")));
      for (const side of ["p1", "p2"]) for (const frame of await readJsonl(path.join(dir, `${side}-private.jsonl`))) hash.update(`\0${side}\0${stripTimes(frame)}`);
      for (const row of await readJsonl(path.join(dir, "trajectory.jsonl"))) hash.update(JSON.stringify([row.side, row.turn, row.rqid, row.identity, row.actionId, row.choice, row.accepted, row.policyId]));
      games.push({ dir, cohort: path.basename(cohort), slot: slot.replace(/-B[01]$/, ""), arm: job.arm, seat: job.seat, status: summary.status, stopReason: summary.stopReason ?? null, turn: summary.turn, key: hash.digest("hex") });
    }
  }
  // Representative per key: the latest cohort's copy (identical content).
  const byKey = new Map<string, any>();
  for (const game of games) if (!byKey.has(game.key) || byKey.get(game.key).cohort < game.cohort) byKey.set(game.key, game);
  const worklist = [...byKey.values()].map((game) => game.dir);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "games.json"), JSON.stringify(games, null, 1) + "\n");
  await fs.writeFile(path.join(out, "worklist.json"), JSON.stringify(worklist, null, 1) + "\n");
  const slotArms = new Set(games.map((game) => `${game.slot}-${game.arm}`));
  console.log(JSON.stringify({ gameDirs: games.length, distinctContents: worklist.length, distinctSlotArms: slotArms.size, statuses: count(games.map((game) => game.status)) }));
}
const count = (values: string[]) => values.reduce<Record<string, number>>((acc, value) => ((acc[value] = (acc[value] ?? 0) + 1), acc), {});

async function run(out: string, shard: number, shards: number, worklistFile: string, limit: number) {
  process.env.LOCAL_INTEL_STORE_PATH = path.join(out, "FORBIDDEN-history.json");
  process.env.EXTERNAL_CURATED_STORE_PATH = path.join(out, "FORBIDDEN-curated.json");
  const src = path.join(root, "apps/companion/src");
  const guardsFile = path.join(src, "battle-agent/tacticalGuards.ts");
  const guardsSha = sha256(await fs.readFile(guardsFile));
  const { DecisionEngine } = await import(`${src}/state/decisionEngine.ts`);
  const { evaluateDecision } = await import(`${src}/state/decisionEnvelope.ts`);
  const { createEphemeralIntelEvaluationContext, projectCanonicalSnapshots } = await import(`${src}/history/opponentIntelStore.ts`);
  const { loadMetaMovePriorDescriptor } = await import(`${src}/history/metaPriorStore.ts`);
  const { computeTacticalGuards, GUARDS_VERSION } = await import(`${src}/battle-agent/tacticalGuards.ts`);
  const priors = await loadMetaMovePriorDescriptor(path.join(root, PRIORS), root);
  const worklist: string[] = JSON.parse(await fs.readFile(worklistFile, "utf8"));
  const file = path.join(out, `shard-${shard}-of-${shards}.jsonl`);
  const done = new Set((await readJsonl(file).catch(() => [])).map((record: any) => record.dir));
  const mine = worklist.filter((_, index) => index % shards === shard).filter((dir) => !done.has(dir)).slice(0, limit);
  for (const dir of mine) {
    const started = performance.now();
    const read = (name: string) => fs.readFile(path.join(dir, name), "utf8");
    const inputs = JSON.parse(await read("replay-inputs.json"));
    const rows = (await read("trajectory.jsonl")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const log = (await read("replay.log")).split("\n");
    const sides: Record<string, unknown> = {};
    for (const side of ["p1", "p2"] as const) {
      const own = rows.filter((row: any) => row.side === side), decisions: any[] = [];
      const engine = new DecisionEngine({ source: "owned_offline_simulator" });
      let context = await createEphemeralIntelEvaluationContext(priors), index = 0, sequence = 0, snapshotHashDiffers = 0, error: string | null = null;
      const roomId = `battle-${inputs.format}-offline`;
      try {
        for (const data of await readJsonl(path.join(dir, `${side}-private.jsonl`))) {
          sequence += 1;
          const current = await engine.ingest({ sessionId: `offline-${side}`, roomId, source: "protocol", observationId: `${side}-${sequence}`, sequence, data: `>${roomId}\n${data}` });
          if (current.snapshot) context = await projectCanonicalSnapshots([current.snapshot], context);
          // The live engine's snapshot content (hence snapshotHash) differs from the cohort's producer; the request
          // point is aligned by every other identity field (stateRevision fixes the frame).
          const row = own[index];
          if (!row || !current.identity || !isDeepStrictEqual({ ...current.identity, snapshotHash: null }, { ...row.identity, snapshotHash: null })) continue;
          index += 1;
          if (current.identity.snapshotHash !== row.identity.snapshotHash) snapshotHashDiffers += 1;
          if (!row.accepted || row.identity.requestKind !== "move") continue;
          const base = { turn: row.turn, rqid: row.rqid, requestId: row.requestId, actionId: row.actionId };
          let envelope: any;
          try { envelope = await evaluateDecision(engine, `offline-${side}`, current.identity, context); }
          catch (cause) { decisions.push({ ...base, error: String((cause as Error).message) }); continue; }
          const snapshot = envelope.semantic.snapshot;
          const red = computeTacticalGuards(envelope).guards.filter((guard: any) => guard.severity === "red" && FLAG_KINDS.includes(guard.kind) && guard.actionIds.length);
          const executed = snapshot.legalActions.find((action: any) => action.id === row.actionId), moveName = executed?.moveName;
          const exec = FLAG_KINDS.flatMap((kind) => {
            const guard = red.find((entry: any) => entry.kind === kind && entry.actionIds.includes(row.actionId));
            return guard ? [{ kind, message: guard.message, ...classifyOutcome({ kind, log, turn: row.turn, side, moveName }) }] : [];
          });
          decisions.push({ ...base, snapshotTurn: snapshot.turn, choiceOk: executed?.choice === row.choice, unsupported: envelope.semantic.capabilities?.status === "unsupported",
            red: [...new Set(red.map((guard: any) => guard.kind))], exec });
        }
      } catch (cause) { error = String((cause as Error).message); }
      sides[side] = { policyId: own[0]?.policyId ?? null, rows: own.length, matched: index, snapshotHashDiffers, error, decisions };
    }
    const record = { dir, guardsVersion: GUARDS_VERSION, guardsSha, ms: Math.round(performance.now() - started), sides };
    await fs.appendFile(path.join(out, `shard-${shard}-of-${shards}.jsonl`), JSON.stringify(record) + "\n");
  }
  console.log(JSON.stringify({ shard, shards, games: mine.length, guardsVersion: GUARDS_VERSION, guardsSha }));
}

/** Wilson 95% score interval. */
function wilson(successes: number, n: number) {
  if (!n) return null;
  const z = 1.959964, p = successes / n, denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return [center - half, center + half];
}

type SideGame = { game: any; side: string; policyId: string; home: boolean; decisions: any[] };
function tally(sideGames: SideGame[]) {
  const decisions = sideGames.flatMap((sg) => sg.decisions.filter((d) => !d.error));
  const perKind: Record<string, any> = {};
  for (const kind of FLAG_KINDS) {
    const fires = sideGames.flatMap((sg) => sg.decisions.flatMap((d) => (d.exec ?? []).filter((e: any) => e.kind === kind)));
    const outcomes = count(fires.map((f: any) => f.outcome)), confirmed = outcomes.confirmed ?? 0, refuted = outcomes.refuted ?? 0;
    const n = confirmed + refuted, precision = n ? confirmed / n : null;
    perKind[kind] = {
      decisions: decisions.length, anyActionFireRate: decisions.length ? decisions.filter((d) => d.red.includes(kind)).length / decisions.length : null,
      anyActionFires: decisions.filter((d) => d.red.includes(kind)).length, executedFires: fires.length,
      sideGames: sideGames.length, sideGamesWithExecutedFire: sideGames.filter((sg) => sg.decisions.some((d) => (d.exec ?? []).some((e: any) => e.kind === kind))).length,
      confirmed, refuted, unresolved: outcomes.unresolved ?? 0, precision, wilson95: wilson(confirmed, n),
      verdict: precision !== null && precision >= 0.9 && n >= 10 ? "re-rankable" : "demote to amber",
      reasons: count(fires.map((f: any) => `${f.outcome}:${f.reason}`))
    };
    perKind[kind].sideGameFireFraction = sideGames.length ? perKind[kind].sideGamesWithExecutedFire / sideGames.length : null;
  }
  const kept = TACTICAL.filter((kind) => perKind[kind].verdict === "re-rankable");
  const c = kept.reduce((sum, kind) => sum + perKind[kind].confirmed, 0), r = kept.reduce((sum, kind) => sum + perKind[kind].refuted, 0);
  const fpRate = c + r ? r / (c + r) : null;
  return { sideGames: sideGames.length, decisions: decisions.length, decisionErrors: sideGames.flatMap((sg) => sg.decisions).filter((d) => d.error).length,
    unsupportedDecisions: decisions.filter((d) => d.unsupported).length, perKind, tacticalKept: kept,
    tacticalFalsePositiveRate: fpRate, tacticalFpWilson95: wilson(r, c + r), tauSuggestion: fpRate === null ? null : Math.max(0.05, fpRate) };
}
function ndiv(sideGames: SideGame[], kinds: readonly string[]) {
  const hit = sideGames.filter((sg) => sg.decisions.some((d) => (d.exec ?? []).some((e: any) => kinds.includes(e.kind)))).length;
  const p = sideGames.length ? hit / sideGames.length : null;
  return { kinds, sideGames: sideGames.length, withExecutedFire: hit, p, wilson95: wilson(hit, sideGames.length), nDivUpperBound280: p === null ? null : 280 * p };
}

async function summarize(out: string) {
  const games: any[] = JSON.parse(await fs.readFile(path.join(out, "games.json"), "utf8"));
  const records = new Map<string, any>();
  for (const name of (await fs.readdir(out)).filter((n) => /^shard-\d+-of-\d+\.jsonl$/.test(n))) for (const record of await readJsonl(path.join(out, name))) records.set(record.dir, record);
  const byKey = new Map<string, any>();
  for (const game of games) if (records.has(game.dir)) byKey.set(game.key, records.get(game.dir));
  const missing = games.filter((game) => !byKey.has(game.key));
  if (missing.length) throw new Error(`${missing.length} game dirs have no reconstruction (e.g. ${missing[0].dir})`);
  const versions = count([...records.values()].map((r) => `${r.guardsVersion} ${r.guardsSha}`));
  if (Object.keys(versions).length !== 1) throw new Error(`Mixed tacticalGuards versions across shards: ${JSON.stringify(versions)}`);
  const sideGamesOf = (list: any[]): SideGame[] => list.flatMap((game) => Object.entries(byKey.get(game.key).sides).map(([side, s]: [string, any]) =>
    ({ game, side, policyId: s.policyId, home: side === game.seat, decisions: s.decisions })));
  // Distinct view: one game per slot and arm (completed preferred, then the latest cohort); replicate dirs are the
  // same deterministic games and would count each fire up to six times.
  const distinct = new Map<string, any>();
  for (const game of games) {
    const id = `${game.slot}-${game.arm}`, prior = distinct.get(id);
    const rank = (g: any) => `${g.status === "completed" ? 1 : 0}${g.cohort}`;
    if (!prior || rank(game) > rank(prior)) distinct.set(id, game);
  }
  const views: Record<string, any[]> = { distinct_slot_arm: [...distinct.values()], all_game_dirs: games };
  const reconstruction = {
    games: records.size, rows: 0, matched: 0, sideErrors: [] as string[], turnMismatches: 0, choiceMismatches: 0, snapshotHashDiffers: 0,
    msPerGame: [...records.values()].reduce((s, r) => s + r.ms, 0) / Math.max(1, records.size)
  };
  for (const record of records.values()) for (const [side, s] of Object.entries<any>(record.sides)) {
    reconstruction.rows += s.rows; reconstruction.matched += s.matched;
    if (s.error || s.matched !== s.rows) reconstruction.sideErrors.push(`${path.relative(root, record.dir)} ${side}: matched ${s.matched}/${s.rows}${s.error ? ` (${s.error})` : ""}`);
    reconstruction.turnMismatches += s.decisions.filter((d: any) => !d.error && d.snapshotTurn !== d.turn).length;
    reconstruction.choiceMismatches += s.decisions.filter((d: any) => !d.error && !d.choiceOk).length;
    reconstruction.snapshotHashDiffers += s.snapshotHashDiffers;
  }
  const audit: any = { tool: "scripts/uu_eval/guard_audit.mts", priors: PRIORS, guards: Object.keys(versions)[0], reconstruction,
    distinctContents: byKey.size, slotArmsWithMultipleContents: [...new Set(games.map((g) => `${g.slot}-${g.arm}`))].filter((id) => new Set(games.filter((g) => `${g.slot}-${g.arm}` === id).map((g) => g.key)).size > 1).length,
    views: {} };
  for (const [name, list] of Object.entries(views)) {
    const all = sideGamesOf(list), kakuna = all.filter((sg) => sg.policyId === KAKUNA);
    const pooled = tally(all), kakunaOnly = tally(kakuna);
    const homeB0 = kakuna.filter((sg) => sg.home && sg.game.arm === "B0"), allB0 = kakuna.filter((sg) => sg.game.arm === "B0");
    const kinds = (t: any) => [...(t.perKind.delayed_slot_occupied.verdict === "re-rankable" ? ["delayed_slot_occupied"] : []), ...t.tacticalKept];
    audit.views[name] = { games: list.length, statuses: count(list.map((g) => g.status)), pooled, kakunaOnly,
      nDiv: { reRankableKinds: kinds(pooled), homeB0: ndiv(homeB0, kinds(pooled)), allB0KakunaSides: ndiv(allB0, kinds(pooled)),
        homeB0AllFourKinds: ndiv(homeB0, FLAG_KINDS), homeB0PerKind: Object.fromEntries(FLAG_KINDS.map((kind) => [kind, ndiv(homeB0, [kind])])) } };
  }
  // A tactical fire names the opponent's threat move(s); "refuted" mixes wrong facts (the threat was used and did not
  // do what was claimed) with the opponent simply choosing something else. Split them by what the opponent did.
  const logs = new Map<string, string[]>();
  const opponentActions = async (dir: string, side: string, turn: number, turns: number) => {
    if (!logs.has(dir)) logs.set(dir, (await fs.readFile(path.join(dir, "replay.log"), "utf8")).split("\n"));
    const opp = side === "p1" ? "p2" : "p1", actions: string[] = [];
    for (let t = turn; t < turn + turns; t++) for (const event of (turnLines(logs.get(dir)!, t)?.lines ?? []).map(parse))
      if ((event.args[0] ?? "").startsWith(`${opp}a:`) && (event.type === "move" || event.type === "switch")) actions.push(event.type === "move" ? event.args[1]! : "switch");
    return actions;
  };
  const fires: any[] = [];
  for (const sg of sideGamesOf(views.distinct_slot_arm)) for (const d of sg.decisions) for (const e of d.exec ?? []) {
    const actions = e.kind === "delayed_slot_occupied" ? [] : await opponentActions(sg.game.dir, sg.side, d.turn, e.kind === "setup_dead_end" ? 2 : 1);
    fires.push({ game: path.relative(root, sg.game.dir), side: sg.side, policyId: sg.policyId, turn: d.turn, actionId: d.actionId, kind: e.kind, outcome: e.outcome, reason: e.reason,
      message: e.message, opponentActions: actions, threatUsed: e.kind === "delayed_slot_occupied" ? null : actions.some((name) => name !== "switch" && e.message.includes(name)) });
  }
  audit.conditionalOnThreatUsed = Object.fromEntries(TACTICAL.map((kind) => {
    const used = fires.filter((f) => f.kind === kind && f.threatUsed), c = used.filter((f) => f.outcome === "confirmed").length, r = used.filter((f) => f.outcome === "refuted").length;
    const all = fires.filter((f) => f.kind === kind);
    return [kind, { fires: all.length, threatUsed: used.length, confirmed: c, refuted: r, precision: c + r ? c / (c + r) : null, wilson95: wilson(c, c + r),
      confirmedWithoutThreat: all.filter((f) => !f.threatUsed && f.outcome === "confirmed").length, refutedWithoutThreat: all.filter((f) => !f.threatUsed && f.outcome === "refuted").length }];
  }));
  audit.fires = fires;
  const refuted = fires.filter((f) => f.outcome === "refuted");
  // Wrong facts (threat used) first: they are the false positives worth inspecting.
  audit.refutedExamples = FLAG_KINDS.flatMap((kind) => refuted.filter((e) => e.kind === kind).sort((a, b) => Number(b.threatUsed) - Number(a.threatUsed))
    .slice(0, kind === "pre_move_ko" ? 8 : 3)).slice(0, 12);
  audit.refutedAll = refuted;
  await fs.writeFile(path.join(out, "audit.json"), JSON.stringify(audit, null, 1) + "\n");
  const pct = (v: number | null) => v === null ? "  n/a" : `${(100 * v).toFixed(1)}%`;
  const lines: string[] = [`guards ${audit.guards}; priors ${PRIORS}; reconstruction ${reconstruction.matched}/${reconstruction.rows} rows matched, ${reconstruction.sideErrors.length} side errors, ${reconstruction.turnMismatches} turn mismatches, ${reconstruction.choiceMismatches} choice mismatches, ${reconstruction.snapshotHashDiffers} rows whose live snapshotHash differs from the cohort's`];
  for (const [name, view] of Object.entries<any>(audit.views)) for (const scope of ["pooled", "kakunaOnly"]) {
    const t = view[scope];
    lines.push("", `${name} / ${scope}: ${view.games} games, ${t.sideGames} side-games, ${t.decisions} move decisions (${t.unsupportedDecisions} unsupported, ${t.decisionErrors} errors)`,
      "kind                   anyFire  execFires  sideGames≥1  conf  ref  unres  precision [Wilson 95%]   verdict");
    for (const kind of FLAG_KINDS) {
      const k = t.perKind[kind];
      lines.push(`${kind.padEnd(22)} ${pct(k.anyActionFireRate).padStart(7)} ${String(k.executedFires).padStart(10)} ${pct(k.sideGameFireFraction).padStart(12)} ${String(k.confirmed).padStart(5)} ${String(k.refuted).padStart(4)} ${String(k.unresolved).padStart(6)}  ${pct(k.precision).padStart(6)} [${k.wilson95 ? `${pct(k.wilson95[0])}–${pct(k.wilson95[1])}` : "n/a"}]   ${k.verdict}`);
    }
    lines.push(`tactical kept ${JSON.stringify(t.tacticalKept)}; FP rate ${pct(t.tacticalFalsePositiveRate)}; τ suggestion ${t.tauSuggestion === null ? "n/a (no tactical kind kept)" : t.tauSuggestion.toFixed(3)}`);
    if (scope === "pooled") {
      const n = view.nDiv;
      lines.push(`N_div upper bound (280 pairs, kinds ${JSON.stringify(n.reRankableKinds)}): B0 home ${n.homeB0.withExecutedFire}/${n.homeB0.sideGames} → ${n.homeB0.nDivUpperBound280?.toFixed(1)}; all B0 Kakuna sides ${n.allB0KakunaSides.withExecutedFire}/${n.allB0KakunaSides.sideGames} → ${n.allB0KakunaSides.nDivUpperBound280?.toFixed(1)}; all four kinds (B0 home) → ${n.homeB0AllFourKinds.nDivUpperBound280?.toFixed(1)}`);
    }
  }
  lines.push("", "distinct view, split by whether the opponent used a threat move named in the message (pooled sides):");
  for (const [kind, s] of Object.entries<any>(audit.conditionalOnThreatUsed))
    lines.push(`  ${kind.padEnd(16)} fires ${s.fires}; threat used ${s.threatUsed}: ${s.confirmed} confirmed / ${s.refuted} refuted → precision ${pct(s.precision)} [${s.wilson95 ? `${pct(s.wilson95[0])}–${pct(s.wilson95[1])}` : "n/a"}]; threat not used: ${s.confirmedWithoutThreat} confirmed / ${s.refutedWithoutThreat} refuted`);
  lines.push("", "refuted examples (distinct view):", ...audit.refutedExamples.map((e: any) => `  ${e.game} ${e.side} T${e.turn} ${e.kind} [${e.reason}; opponent: ${e.opponentActions.join(", ") || "-"}] ${e.actionId}: ${e.message}`));
  await fs.writeFile(path.join(out, "audit.txt"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") return plan(outDir(args[0]), args.slice(1));
  if (command === "run") {
    const out = outDir(args[0]), shard = Number(args[1]), shards = Number(args[2]);
    if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 0 || shard >= shards) throw new Error("SHARD COUNT required");
    return run(out, shard, shards, path.resolve(args[3] ?? path.join(out, "worklist.json")), args[4] ? Number(args[4]) : Infinity);
  }
  if (command === "summarize") return summarize(outDir(args[0]));
  throw new Error("usage: guard_audit.mts plan|run|summarize …");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
