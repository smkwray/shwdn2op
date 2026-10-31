// The companion completes its deterministic result in stages (each section shows as soon as its
// information is available). A partial envelope names its stage; the complete one has none. Each section lists the
// localIntel fields it fills and the stage that fills them.
const STAGES = ["board", "damage", "threats", "final"];
export const SECTIONS = {
  speed: { stage: "board", keys: ["speedPreview", "hazardSummary"] },
  sets: { stage: "board", keys: ["opponents"] },
  damage: { stage: "damage", keys: ["playerDamagePreview", "survivalCaveats"] },
  threats: { stage: "threats", keys: ["opponentThreatPreview", "opponentThreatCoverage"] },
  analysis: { stage: "final", keys: ["opponentActionPrediction", "selfActionRecommendation", "opponentLeadPrediction", "playerLeadRecommendation", "illusionAlternative", "moveTargetPreview", "debug"] }
};

export function envelopeStage(envelope) {
  return envelope ? envelope.semantic?.stage ?? "final" : null;
}

/** What the page shows for one decision: the sections this envelope has computed; for each section it has not computed
 * yet, the same section from an earlier view of the same decision (stale, shown as updating) or nothing (pending). */
export function displayIntel(envelope, previous) {
  const names = Object.keys(SECTIONS);
  if (!envelope?.semantic?.localIntel) return { localIntel: null, pending: names, stale: [] };
  const reached = STAGES.indexOf(envelopeStage(envelope));
  const localIntel = { ...envelope.semantic.localIntel }, pending = [], stale = [];
  for (const name of names) {
    const { stage, keys } = SECTIONS[name];
    if (STAGES.indexOf(stage) <= reached) continue;
    if (previous && keys.some((key) => previous[key] !== undefined)) {
      for (const key of keys) if (previous[key] !== undefined) localIntel[key] = previous[key];
      stale.push(name);
    } else pending.push(name);
  }
  return { localIntel, pending, stale };
}
