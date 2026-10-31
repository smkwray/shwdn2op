import assert from "node:assert/strict";
import test from "node:test";

// The precision audit's outcome classifier (scripts/uu_eval/guard_audit.mts) decides which red guard kinds may re-rank
// and sets τ; a misread log turns a false positive into a "confirmed" fire or the reverse.
const { classifyOutcome, turnLines } = await import(new URL("../../../../scripts/uu_eval/guard_audit.mts", import.meta.url).href);
const log = (...lines: string[]) => ["|start", "|switch|p1a: Slowbro|Slowbro, M|100/100", "|switch|p2a: Hydrapple|Hydrapple, M|100/100", ...lines].join("\n");
const classify = (kind: string, text: string, turn: number, side = "p1", moveName?: string) => classifyOutcome({ kind, log: text, turn, side, moveName });

// Matters: every outcome is read from exactly the resolution of the decision's turn. `|turn|1` must not match
// `|turn|10`, and a log that stops early must say so rather than look like a resolved turn.
test("turn slicing is exact and reports how the turn ended", () => {
  const text = log("|turn|1", "|move|p1a: Slowbro|Scald|p2a: Hydrapple", "|turn|2", "|move|p1a: Slowbro|Slack Off|p1a: Slowbro", "|turn|10", "|move|p1a: Slowbro|Surf|p2a: Hydrapple", "|win|Offline p1");
  assert.deepEqual(turnLines(text, 1), { lines: ["|move|p1a: Slowbro|Scald|p2a: Hydrapple"], end: "turn" });
  assert.deepEqual(turnLines(text, 10), { lines: ["|move|p1a: Slowbro|Surf|p2a: Hydrapple", "|win|Offline p1"], end: "game_end" });
  assert.deepEqual(turnLines(log("|turn|3", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro"), 3), { lines: ["|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro"], end: "log_end" });
  assert.equal(turnLines(text, 4), null, "a turn the log never reached");
});

// Matters: a second delayed attack into an occupied slot is the one rules-certain red guard; only our own side's
// `-fail` right after our Future Sight confirms it, and a scheduled one refutes it.
test("delayed_slot_occupied: our -fail confirms, a scheduled Future Sight refutes", () => {
  const failed = log("|turn|5", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|40/100",
    "|move|p1a: Slowbro|Future Sight||[still]", "|-fail|p1a: Slowbro", "|", "|upkeep", "|turn|6");
  assert.equal(classify("delayed_slot_occupied", failed, 5, "p1", "Future Sight").outcome, "confirmed");
  // The opponent's own failed Future Sight is not ours: our scheduled one still refutes the claim.
  const scheduled = log("|turn|5", "|move|p2a: Hydrapple|Future Sight||[still]", "|-fail|p2a: Hydrapple",
    "|move|p1a: Slowbro|Future Sight|p2a: Hydrapple", "|-start|p1a: Slowbro|move: Future Sight", "|upkeep", "|turn|6");
  assert.equal(classify("delayed_slot_occupied", scheduled, 5, "p1", "Future Sight").outcome, "refuted");
});

// Matters: a delayed move that never ran cannot test the rules claim, so fainting first, `cant` and a game that ends
// first are unresolved, never refutations.
test("delayed_slot_occupied: a move that never executed is unresolved", () => {
  const fainted = log("|turn|5", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|0 fnt", "|faint|p1a: Slowbro", "|upkeep", "|turn|6");
  const cant = log("|turn|5", "|cant|p1a: Slowbro|par", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|30/100", "|upkeep", "|turn|6");
  const ended = log("|turn|5", "|move|p2a: Hydrapple|Explosion|p1a: Slowbro", "|-damage|p1a: Slowbro|10/100", "|faint|p2a: Hydrapple", "|win|Offline p1");
  for (const text of [fainted, cant, ended]) assert.equal(classify("delayed_slot_occupied", text, 5, "p1", "Future Sight").outcome, "unresolved");
});

// Matters: Gen 5+ also prints our `-fail` when the move has no target (the foe fainted earlier that turn), which says
// nothing about an occupied slot; counting it would inflate the rules-certain guard's precision.
test("delayed_slot_occupied: a no-target -fail is unresolved, not a confirmation", () => {
  const noTarget = log("|turn|5", "|move|p2a: Hydrapple|Explosion|p1a: Slowbro", "|-damage|p1a: Slowbro|20/100", "|faint|p2a: Hydrapple",
    "|move|p1a: Slowbro|Future Sight||[notarget]", "|-fail|p1a: Slowbro", "|upkeep", "|turn|6");
  assert.equal(classify("delayed_slot_occupied", noTarget, 5, "p1", "Future Sight").outcome, "unresolved");
});

// Matters: the pre-move KO claim is exactly "our active faints before it acts this turn"; side prefixes identify our
// active (here we are p2), and an opponent's faint must not count as ours.
test("pre_move_ko: fainting before our move confirms, moving first refutes", () => {
  const ko = log("|turn|19", "|switch|p1a: Hydreigon|Hydreigon, F|100/100", "|move|p1a: Hydreigon|Dark Pulse|p2a: Hydrapple",
    "|-damage|p2a: Hydrapple|0 fnt", "|faint|p2a: Hydrapple", "|upkeep", "|turn|20");
  assert.equal(classify("pre_move_ko", ko, 19, "p2").outcome, "confirmed");
  assert.equal(classify("pre_move_ko", ko, 19, "p1").outcome, "refuted", "p1 switched and survived: no KO of p1's active");
  const first = log("|turn|19", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|0 fnt", "|faint|p1a: Slowbro",
    "|move|p1a: Slowbro|Scald|p2a: Hydrapple");
  const movedFirst = log("|turn|19", "|move|p1a: Slowbro|Scald|p2a: Hydrapple", "|-damage|p2a: Hydrapple|50/100",
    "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|0 fnt", "|faint|p1a: Slowbro", "|upkeep", "|turn|20");
  assert.equal(classify("pre_move_ko", first, 19, "p1").outcome, "confirmed");
  assert.equal(classify("pre_move_ko", movedFirst, 19, "p1").outcome, "refuted", "our move ran before the KO");
});

// Matters: surviving to the action point refutes the KO claim even when our active then cannot move (flinch,
// paralysis), and a later turn's faint must not leak back; only a log that stops mid-turn is unresolved.
test("pre_move_ko: alive at the action point refutes; a truncated turn is unresolved", () => {
  const flinch = log("|turn|19", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|5/100", "|cant|p1a: Slowbro|flinch",
    "|upkeep", "|turn|20", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|0 fnt", "|faint|p1a: Slowbro");
  const para = log("|turn|19", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|20/100", "|cant|p1a: Slowbro|par", "|upkeep", "|turn|20");
  const silent = log("|turn|19", "|move|p2a: Hydrapple|Protect|p2a: Hydrapple", "|upkeep", "|turn|20");
  for (const text of [flinch, para, silent]) assert.equal(classify("pre_move_ko", text, 19, "p1").outcome, "refuted");
  const truncated = log("|turn|19", "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|20/100");
  assert.equal(classify("pre_move_ko", truncated, 19, "p1").outcome, "unresolved");
  assert.equal(classify("pre_move_ko", log("|turn|18"), 19, "p1").outcome, "unresolved", "the turn was never reached");
});

// Matters: the setup dead-end claim is "the setup user dies by the end of next turn without cashing the boost out";
// status moves are not a cash-out, a damaging move is, and surviving the next turn refutes it.
test("setup_dead_end: dying without a damaging move confirms; cashing out or surviving refutes", () => {
  const head = ["|turn|30", "|move|p2a: Hydrapple|Earth Power|p1a: Slowbro", "|-damage|p1a: Slowbro|40/100",
    "|move|p1a: Slowbro|Calm Mind|p1a: Slowbro", "|-boost|p1a: Slowbro|spa|1", "|upkeep", "|turn|31"];
  const dead = log(...head, "|move|p2a: Hydrapple|Earth Power|p1a: Slowbro", "|-damage|p1a: Slowbro|0 fnt", "|faint|p1a: Slowbro", "|upkeep", "|turn|32");
  const statusThenDead = log(...head, "|move|p1a: Slowbro|Slack Off|p1a: Slowbro", "|-heal|p1a: Slowbro|90/100",
    "|move|p2a: Hydrapple|Earth Power|p1a: Slowbro", "|-damage|p1a: Slowbro|0 fnt", "|faint|p1a: Slowbro", "|upkeep", "|turn|32");
  assert.equal(classify("setup_dead_end", dead, 30).outcome, "confirmed");
  assert.equal(classify("setup_dead_end", statusThenDead, 30).outcome, "confirmed", "a status move is no cash-out");
  const cashed = log(...head, "|move|p1a: Slowbro|Psyshock|p2a: Hydrapple", "|-damage|p2a: Hydrapple|30/100",
    "|move|p2a: Hydrapple|Earth Power|p1a: Slowbro", "|-damage|p1a: Slowbro|0 fnt", "|faint|p1a: Slowbro", "|upkeep", "|turn|32");
  const survived = log(...head, "|move|p2a: Hydrapple|Earth Power|p1a: Slowbro", "|-damage|p1a: Slowbro|3/100", "|upkeep", "|turn|32");
  assert.equal(classify("setup_dead_end", cashed, 30).outcome, "refuted");
  assert.equal(classify("setup_dead_end", survived, 30).outcome, "refuted");
});

// Matters: switching the setup user out or the game ending first leaves the dead-end claim untested.
test("setup_dead_end: switching out first or the game ending is unresolved", () => {
  const head = ["|turn|30", "|move|p1a: Slowbro|Calm Mind|p1a: Slowbro", "|-boost|p1a: Slowbro|spa|1", "|upkeep", "|turn|31"];
  const switched = log(...head, "|switch|p1a: Donphan|Donphan, F|100/100", "|move|p2a: Hydrapple|Earth Power|p1a: Donphan",
    "|-damage|p1a: Donphan|0 fnt", "|faint|p1a: Donphan", "|upkeep", "|turn|32");
  const ended = log(...head, "|move|p2a: Hydrapple|Draco Meteor|p1a: Slowbro", "|-damage|p1a: Slowbro|10/100", "|-damage|p2a: Hydrapple|0 fnt|[from] Leftovers",
    "|faint|p2a: Hydrapple", "|win|Offline p1");
  for (const text of [switched, ended]) assert.equal(classify("setup_dead_end", text, 30).outcome, "unresolved");
});

// Matters: the switch-in KO claim is about the Pokémon we switched in, including a hazard KO on entry; one that is
// alive when the turn ends refutes it, and a game that ends first cannot test it.
test("switch_into_ko: fainting that turn confirms, alive at turn end refutes, game end is unresolved", () => {
  const hit = log("|turn|6", "|switch|p1a: Donphan|Donphan, F|100/100", "|move|p2a: Hydrapple|Giga Drain|p1a: Donphan",
    "|-damage|p1a: Donphan|0 fnt", "|faint|p1a: Donphan", "|upkeep", "|switch|p1a: Slowbro|Slowbro, M|100/100", "|turn|7");
  const hazard = log("|turn|6", "|switch|p1a: Volcarona|Volcarona, F|100/100", "|-damage|p1a: Volcarona|0 fnt|[from] Stealth Rock",
    "|faint|p1a: Volcarona", "|upkeep", "|turn|7");
  for (const text of [hit, hazard]) assert.equal(classify("switch_into_ko", text, 6).outcome, "confirmed");
  const alive = log("|turn|6", "|switch|p1a: Donphan|Donphan, F|100/100", "|move|p2a: Hydrapple|Giga Drain|p1a: Donphan",
    "|-damage|p1a: Donphan|35/100", "|upkeep", "|turn|7");
  assert.equal(classify("switch_into_ko", alive, 6).outcome, "refuted");
  const ended = log("|turn|6", "|switch|p1a: Donphan|Donphan, F|100/100", "|move|p2a: Hydrapple|Draco Meteor|p1a: Donphan",
    "|-damage|p1a: Donphan|60/100", "|-damage|p2a: Hydrapple|0 fnt|[from] item: Life Orb", "|faint|p2a: Hydrapple", "|win|Offline p1");
  const truncated = log("|turn|6", "|switch|p1a: Donphan|Donphan, F|100/100");
  for (const text of [ended, truncated]) assert.equal(classify("switch_into_ko", text, 6).outcome, "unresolved");
});
