import { type SampleTeamPriorImportTeam } from "../apps/companion/src/history/externalCuratedStore.js";
import { importExternalCuratedTeamPriors } from "../apps/companion/src/history/opponentIntelStore.js";

function inferFormatLabel(formatId: string) {
  const normalized = String(formatId ?? "").trim().toLowerCase();
  const match = normalized.match(/^gen(\d+)([a-z0-9]+)$/i);
  if (!match) return formatId;
  const [, gen, suffix] = match;
  return `[Gen ${gen}] ${suffix.toUpperCase()}`;
}

async function fetchTeams(sourceUrl: string) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sample teams from ${sourceUrl}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`Expected an array of sample teams from ${sourceUrl}`);
  }
  return payload as SampleTeamPriorImportTeam[];
}

async function main() {
  const formatId = process.argv[2]?.trim() || "gen9uu";
  const format = process.argv[3]?.trim() || inferFormatLabel(formatId);
  const sourceUrl = process.argv[4]?.trim() || `https://data.pkmn.cc/teams/${formatId}.json`;

  const teams = await fetchTeams(sourceUrl);
  const result = await importExternalCuratedTeamPriors({
    format,
    formatId,
    sourceUrl,
    teams
  });

  console.log(JSON.stringify({
    ok: true,
    ...result
  }, null, 2));
}

void main();
