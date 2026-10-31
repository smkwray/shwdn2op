#!/usr/bin/env node
// CPU-only: pinned Showdown validation, order-independent identity, vocabulary audit.
// Usage: node audit_teams.cjs SHOWDOWN_DIR TOKENIZER_JSON TEAM_DIR [TEAM_DIR ...]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [simDir, vocabFile, ...dirs] = process.argv.slice(2);
if (!simDir || !vocabFile || !dirs.length) throw Error('Expected SHOWDOWN_DIR TOKENIZER_JSON TEAM_DIR ...');
const { Teams, TeamValidator } = require(path.resolve(simDir));
const version = JSON.parse(fs.readFileSync(path.join(simDir, 'package.json'))).version;
if (version !== '0.11.11') throw Error(`Wrong simulator: ${version}`);
const vocab = JSON.parse(fs.readFileSync(vocabFile));
const clean = s => [...String(s)].filter(c => /[a-z0-9]/i.test(c)).join('').toLowerCase();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function files(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : e.isFile() && /\.(txt|gen9uu_team)$/.test(e.name) ? [p] : [];
  }).sort();
}
const rows = dirs.flatMap(files).map(file => {
  const text = fs.readFileSync(file, 'utf8');
  const team = Teams.import(text);
  const errors = team ? new TeamValidator('gen9uu').validateTeam(team) || [] : ['Import failed'];
  if (team && team.length !== 6) errors.push(`Expected 6 Pokemon, got ${team.length}`);
  const missing = new Set();
  for (const p of team || []) {
    for (const value of [p.species, p.item, p.ability, ...(p.moves || []), p.teraType]) {
      if (value && !(clean(value) in vocab)) missing.add(clean(value));
    }
  }
  // Normalize via the native exporter, suppress nicknames, then ignore team/move order.
  const canonical = team && team.map(p => ({...p, name: '', moves: [...p.moves].sort()}))
    .map(p => Teams.pack([p])).sort();
  return {file, sourceSha256: sha(text), teamSha256: canonical ? sha(JSON.stringify(canonical)) : null,
    valid: !errors.length, errors, missingTokens: [...missing].sort()};
});
const report = {simulatorVersion: version, format: 'gen9uu', files: rows.length,
  valid: rows.filter(r => r.valid).length,
  distinctValidTeams: new Set(rows.filter(r => r.valid).map(r => r.teamSha256)).size,
  formatTokens: {'<gen9ou>': vocab['<gen9ou>'] ?? -1, '<gen9uu>': vocab['<gen9uu>'] ?? -1},
  missingTokens: [...new Set(rows.flatMap(r => r.missingTokens))].sort(), rows};
console.log(JSON.stringify(report, null, 2));
if (rows.some(r => !r.valid)) process.exitCode = 1;
