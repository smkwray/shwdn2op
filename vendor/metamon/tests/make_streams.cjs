// Producer of the decoder-test streams: one seeded random-player battle in Pokemon Showdown's own simulator
// (pokemon-showdown 0.11.11), written as each side's private stream, one JSON string per chunk the player receives.
// Usage: node make_streams.cjs PS_PACKAGE_DIR OUT.json FORMAT SEED P1_TEAM_FILE P2_TEAM_FILE [MOVE_PROB]
const fs = require("fs");
const [psDir, out, format, seed, team1, team2, move = "0.7"] = process.argv.slice(2);
const { BattleStream, getPlayerStreams, Teams } = require(psDir);
const { RandomPlayerAI } = require(`${psDir}/dist/sim/tools/random-player-ai`);
const pack = (file) => Teams.pack(Teams.import(fs.readFileSync(file, "utf8")));
const streams = getPlayerStreams(new BattleStream());
const frames = { p1: [], p2: [] };
class Recorder extends RandomPlayerAI {
  constructor(side, n) { super(streams[side], { seed: [n, n + 1, n + 2, n + 3], move: Number(move) }); this.side = side; }
  receive(chunk) { frames[this.side].push(chunk); super.receive(chunk); }
}
const n = Number(seed);
void new Recorder("p1", 4 * n).start();
void new Recorder("p2", 4 * n + 100).start();
(async () => {
  void streams.omniscient.write(`>start ${JSON.stringify({ formatid: format, seed: [n, 7, 11, 13] })}
>player p1 ${JSON.stringify({ name: "Offline p1", team: pack(team1) })}
>player p2 ${JSON.stringify({ name: "Offline p2", team: pack(team2) })}`);
  for await (const _ of streams.omniscient) { /* drain */ }
  fs.writeFileSync(out, JSON.stringify({ format, seed: n, teams: [team1, team2].map((f) => f.split(/[\\/]/).slice(-3).join("/")), frames }));
})();
