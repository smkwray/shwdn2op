import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The tactical suite (scripts/uu_eval/tactical_suite.mts) measures a model's mass on each case's bad actions; a dropped
// case, a case mapped to another request, or a bad predicate that also catches the better action would silently change
// what "bad-action mass" means. Its real case tables are private (not shipped); this file drives the same machinery
// with a synthetic suite and synthetic frames.
const suiteModule = await import(new URL("../../../../scripts/uu_eval/tactical_suite.mts", import.meta.url).href);
const { checkSuite, locateCase, checkLabels, variantGrid, variantId, stays, exactly, switchTo, loadSuites } = suiteModule;

const LABELS = ["Brave Bird", "Tera + Brave Bird", "Roost", "Tera + Roost", "U-turn", "Defog",
  "Switch to Gholdengo, slot 2", "Switch to Toxapex (Pex), slot 3"];
const synthetic = () => ({
  idPrefix: "s-",
  turns: [
    { turn: 7, rqid: 20, active: "Corviknight", bad: stays(["Roost"]), badText: "synthetic: recovery into a setup sweeper", trapped: false },
    { turn: 9, rqid: 26, active: "Corviknight", bad: exactly(["Tera + Brave Bird"]), badText: "synthetic: Tera spent on a resisted hit",
      hp: { mon: "Corviknight", max: 399, from: 200, values: [150, 200] } },
    { turn: 12, rqid: 33, active: "Corviknight", bad: switchTo("Toxapex"), badText: "synthetic: switch into a known KO", trapped: false }
  ],
  armTurns: [7, 9], switchTurns: [12],
  regression: { 7: { id: "s-t7", fired: [] }, 9: { id: "s-t9-hp200", fired: ["tera_survival"] }, 12: { id: "s-t12", fired: ["switch_into_ko"] } }
});

// Matters: the bad predicates decide which actions count as bad. A plain move and its Tera choice are different actions
// for `exactly`, the same line for `stays`; a switch matches its own target only, nicknamed or not, never a prefix.
test("bad predicates split the legal actions exactly as written", () => {
  const [stay, tera, sw] = synthetic().turns;
  assert.deepEqual(checkLabels(stay, LABELS), ["Roost", "Tera + Roost"]);
  assert.deepEqual(checkLabels(tera, LABELS), ["Tera + Brave Bird"]);
  assert.deepEqual(checkLabels(sw, LABELS), ["Switch to Toxapex (Pex), slot 3"]);
  assert.equal(switchTo("Gholdengo")("Switch to Gholdengo, slot 2"), true);
  assert.equal(switchTo("Ghold")("Switch to Gholdengo, slot 2"), false, "a name prefix is another Pokémon");
});

// Matters: a bad predicate that matches nothing (a renamed move) or everything (no better action) makes the case's
// bad-action mass 0 or 1 regardless of the model.
test("checkLabels rejects a bad predicate that does not split the legal actions", () => {
  const roost = synthetic().turns[0];
  assert.throws(() => checkLabels(roost, ["Brave Bird", "Switch to Gholdengo, slot 2"]), /T7: bad predicate matches 0 of 2/);
  assert.throws(() => checkLabels(roost, ["Roost", "Tera + Roost"]), /matches 2 of 2/);
  // Trapping removes the switches by design: an all-bad trapped state is measured (mass 1), a no-bad one is not.
  assert.deepEqual(checkLabels(roost, ["Roost"], true), ["Roost"]);
  assert.throws(() => checkLabels(roost, ["Defog"], true), /matches 0 of 1/);
});

// Matters: the perturbation grid and its ids are what the regression entries name; a changed grid or id format would
// orphan every expectation.
test("variantGrid perturbs HP and trapping, and variant ids name the regression states", () => {
  const suite = synthetic();
  const [stay, hp] = suite.turns;
  assert.deepEqual(variantGrid(stay), [{ trapped: false }]);
  assert.deepEqual(variantGrid(hp), [{ hp: 150, trapped: false }, { hp: 150, trapped: true }, { hp: 200, trapped: false }, { hp: 200, trapped: true }]);
  assert.deepEqual(variantGrid(hp).map((v: any) => variantId(suite, hp, v)), ["s-t9-hp150", "s-t9-hp150-trapped", "s-t9-hp200", "s-t9-hp200-trapped"]);
  assert.equal(variantId(suite, stay, { trapped: false }), "s-t7");
});

// Matters: one dropped case or orphaned regression entry must fail here, not pass as a regression over fewer turns.
test("checkSuite accepts a consistent suite and rejects every dropped or mis-keyed case", () => {
  const suite = synthetic();
  checkSuite(suite);
  assert.throws(() => checkSuite({ ...suite, turns: suite.turns.filter((t: any) => t.turn !== 9) }), /regression turn 9 has no case|arm turn 9/);
  assert.throws(() => checkSuite({ ...suite, regression: { ...suite.regression, 9: { id: "s-t9-hp50", fired: [] } } }), /not a T9 variant/);
  const { 7: _dropped, ...rest } = suite.regression;
  assert.throws(() => checkSuite({ ...suite, regression: rest }), /T7 has no regression entry/);
  assert.throws(() => checkSuite({ ...suite, turns: [...suite.turns, suite.turns[0]] }), /duplicate case turn/);
  assert.throws(() => checkSuite({ ...suite, switchTurns: [13] }), /arm turn 13 has no case/);
});

const request = (rqid: number, active: string, extra: object = {}) =>
  `|request|${JSON.stringify({ rqid, side: { id: "p2", pokemon: [{ ident: `p2: ${active}`, active: true }, { ident: "p2: Donphan", active: false }] }, ...extra })}`;
const frames = [
  { data: "|turn|1" }, { data: request(3, "Scizor") }, { data: request(4, "Scizor", { wait: true }) },
  { data: "|move|p1a: Cobalion|Volt Switch|p2a: Scizor\n|turn|10" }, { data: request(5, "Scizor") }
];
const at = (turn: number, rqid: number, active = "Scizor") => ({ turn, rqid, active, bad: () => true, badText: "" });

// Matters: the turn is read from exact `|turn|N` lines before the request (`|turn|1` is not `|turn|10`), and a wait
// request, a missing rqid or another active Pokémon is a mis-mapped case, not a state to measure.
test("locateCase maps a case only to its own turn's decision request", () => {
  assert.equal(locateCase(frames, at(1, 3)), 1);
  assert.equal(locateCase(frames, at(10, 5)), 4);
  assert.throws(() => locateCase(frames, at(1, 5)), /is in turn 10/);
  assert.throws(() => locateCase(frames, at(10, 3)), /is in turn 1$/);
  assert.throws(() => locateCase(frames, at(1, 4)), /wait request/);
  assert.throws(() => locateCase(frames, at(1, 9)), /not in journal/);
  assert.throws(() => locateCase(frames, at(1, 3, "Donphan")), /has Scizor active, not Donphan/);
});

// Matters: the real case tables are private; without them the script must stop with a reason, never run an empty suite.
test("loadSuites fails loudly on a missing or empty case module and returns a present one", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tactical-cases-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(loadSuites(path.join(dir, "absent.mts")), /Private tactical cases missing: .*absent\.mts\. The real case tables are private and not shipped/);
  const empty = path.join(dir, "empty.mts");
  await fs.writeFile(empty, "export const SUITES = {};\n");
  await assert.rejects(loadSuites(empty), /exports no SUITES/);
  const present = path.join(dir, "present.mts");
  await fs.writeFile(present, "export const SUITES = { \"p1:1\": { idPrefix: \"\", turns: [], armTurns: [], regression: {} } };\n");
  assert.deepEqual(Object.keys(await loadSuites(present)), ["p1:1"]);
});
