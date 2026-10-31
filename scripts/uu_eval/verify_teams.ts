/** Join actual simulator inputs to the preregistered dev-only team bytes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Teams, TeamValidator } from '../../apps/companion/src/battle-agent/nativeSimulator.js';
const root = path.resolve(process.argv[2]!);
const spec = JSON.parse(await fs.readFile(path.join(root, 'spec.json'), 'utf8'));
const slots = new Map<string, any>();
for (const game of spec.games) {
  const input = JSON.parse(await fs.readFile(path.join(root, game.gameID, 'replay-inputs.json'), 'utf8'));
  assert.equal(input.format, 'gen9uu'); assert.deepEqual(input.seed, game.seed);
  for (const side of ['p1','p2']) {
    assert.ok(game.teamFiles[side].includes('/teams/uu_dev_v1/'));
    const bytes = await fs.readFile(game.teamFiles[side]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), game.teamSha256[side]);
    const team = Teams.import(bytes.toString('utf8'))!;
    assert.equal(new TeamValidator('gen9uu').validateTeam(team), null);
    assert.equal(Teams.pack(team), input.teams[side]);
  }
  const previous = slots.get(game.slotID);
  if (previous) assert.deepEqual(previous, input);
  else slots.set(game.slotID, input);
}
await fs.writeFile(path.join(root, 'team-slot-verification.json'), JSON.stringify({status:'PASS',
  games:spec.games.length, pairs:slots.size, actualTeamsAndNativeSeedsEqualAcrossArms:true,
  nativePackedTeamsMatchPreregisteredDevExports:true},null,2)+'\n', {flag:'wx',mode:0o600});
