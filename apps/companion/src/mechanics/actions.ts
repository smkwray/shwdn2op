import type { BattleSnapshot, LegalAction } from "../types.js";

/** Project the board at move execution without mutating captured evidence. */
export function snapshotForAction(snapshot: BattleSnapshot, action: LegalAction): BattleSnapshot {
  if (!action.terastallize) return snapshot;
  const active = snapshot.yourSide.active;
  if (action.kind !== "move" || !active?.teraType || active.terastallized) {
    throw new Error(`Cannot project Tera action ${action.id}: requires an un-Terastallized active with a known Tera type.`);
  }
  const projected = { ...active, terastallized: true };
  return {
    ...snapshot,
    yourSide: {
      ...snapshot.yourSide,
      active: projected,
      team: snapshot.yourSide.team.map((mon) => mon.active || (active.instanceId ? mon.instanceId === active.instanceId : active.ident !== null && mon.ident === active.ident) ? projected : mon)
    }
  };
}
