/** Distinct actor identity while reusing the production transport unchanged.
 * For a paired-slot runner: candidateSeat(candidateLaunch) versus
 * new MetamonBattlePolicy(kakunaLaunch). This is an actor, not a veto advisor.
 */
import { MetamonBattlePolicy, type MetamonWorkerOptions } from "../../apps/companion/src/battle-agent/metamon.js";
import type { BattlePolicy } from "../../apps/companion/src/battle-agent/battleAgent.js";

export function candidateSeat(launch: MetamonWorkerOptions & { policyId: string }): BattlePolicy {
  if (!/^(metamon:UUFinetuned:[A-Za-z0-9_-]+:[0-9]+|metamon:Ensemble:[0-9a-f]{64})$/.test(launch.policyId)) {
    throw new Error("Distinct checkpoint or hash-bound ensemble identity required.");
  }
  const flags = launch.args.flatMap((arg, i) => arg === "--policy-id" ? [i] : []);
  if (flags.length !== 1 || launch.args[flags[0]! + 1] !== launch.policyId) {
    throw new Error("Seat identity must match the candidate worker declaration.");
  }
  const transport = new MetamonBattlePolicy(launch);
  return {
    id: launch.policyId,
    requiresSupportedMechanics: transport.requiresSupportedMechanics,
    observe: (data, context, options) => transport.observe(data, context, options),
    decide: (input, options) => transport.decide(input, options),
    commit: (input, decision, options) => transport.commit(input, decision, options),
    close: () => transport.close(),
  };
}
