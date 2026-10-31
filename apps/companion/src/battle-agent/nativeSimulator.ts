/// <reference path="../../../../node_modules/pokemon-showdown/dist/sim/global-types.d.ts" />
// The maintained server simulator is CommonJS. Keep its native implementation
// and declarations behind one ESM export boundary; no mechanics are copied.
import Showdown from "pokemon-showdown";
import NativeBattle from "pokemon-showdown/dist/sim/battle.js";
export const { Battle, Teams, TeamValidator, Dex, PRNG } = Showdown;
export const { extractChannelMessages } = NativeBattle;
export type PRNG = InstanceType<typeof PRNG>;
export type Battle = InstanceType<typeof Battle>;
export type PokemonSet = import("pokemon-showdown/dist/sim/teams.js").PokemonSet;
