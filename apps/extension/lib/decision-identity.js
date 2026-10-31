// Shared by the extension and companion. Capture time is transport metadata;
// every other canonical snapshot field participates in decision identity.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export async function hashCanonical(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createDecisionIdentity(snapshot) {
  if (!snapshot || typeof snapshot.roomId !== "string" || !Array.isArray(snapshot.legalActions)) {
    throw new Error("Cannot identify a snapshot without a room and legal actions.");
  }
  const { capturedAt: _captureTime, ...position } = snapshot;
  if (position.canonicalEvidence) {
    position.canonicalEvidence = { ...position.canonicalEvidence,
      facts: position.canonicalEvidence.facts.filter((fact) => !["init", "title", "player"].includes(fact.kind)).map(({ source: _captureSupport, ...fact }) => fact.kind === "request" ? { ...fact, args: [] } : fact)
    };
    position.entryObservations = position.entryObservations?.map(({ observationIds: _captureReferences, ...entry }) => entry);
  }
  const actions = snapshot.legalActions.map(({ label: _label, details: _details, ...structural }) => JSON.stringify(canonical(structural))).sort();
  const [snapshotHash, legalActionSetHash] = await Promise.all([hashCanonical(position), hashCanonical(actions)]);
  const rqid = snapshot.rawRequestSummary?.rqid;
  return {
    roomId: snapshot.roomId,
    rqid: Number.isSafeInteger(rqid) && rqid >= 0 ? rqid : null,
    snapshotHash,
    legalActionSetHash
  };
}

export function sameDecision(left, right) {
  return Boolean(left && right
    && left.roomId === right.roomId
    && left.rqid === right.rqid
    && left.snapshotHash === right.snapshotHash
    && left.legalActionSetHash === right.legalActionSetHash);
}
