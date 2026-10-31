// Capture only human commands. This module has no game transport or execution API.
export function outgoingBattleEvents(data) {
  if (typeof data !== "string") return [];
  return data.split("\n").flatMap((line) => {
    // The default Showdown client sends team preview as `/team <order>|rqid`, not via /choose.
    const choice = /^(battle-[a-z0-9-]+)\|(\/(?:choose(?: .*)?|team .*|undo(?:\|\d+(?:\.[0-9a-f]+)?)?))$/.exec(line);
    if (choice) return [{ kind: "choice", roomId: choice[1], data: choice[2] }];
    const leave = /^(battle-[a-z0-9-]+)\|\/leave$|^\|\/leave (battle-[a-z0-9-]+)$/.exec(line);
    return leave ? [{ kind: "leave", roomId: leave[1] ?? leave[2] }] : [];
  });
}

// Advice belongs to one exact canonical decision (room, rqid, snapshot, legal actions, state revision, request kind), and
// a ready pick to one of that snapshot's enabled actions. It is independent of the deterministic result.
export function currentMetamonAdvice(advice, identity, snapshot) {
  const a = advice?.identity, b = identity;
  if (!a || !b || ["roomId", "rqid", "snapshotHash", "legalActionSetHash", "stateRevision", "requestKind"].some((key) => a[key] !== b[key])) return null;
  if (advice.status === "ready" && !snapshot?.legalActions?.some((action) => action.id === advice.actionId && !action.disabled && action.legality !== "disabled")) return null;
  return advice;
}
export function metamonText(advice) {
  if (!advice) return "";
  if (advice.status === "ready") return `Metamon: ${advice.label}`;
  if (advice.status === "unavailable") return `Metamon unavailable${advice.reason === "sync_lost" ? " (sync lost)" : ""}`;
  return `Metamon: ${advice.status}`;
}
