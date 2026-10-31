from datetime import datetime
import json
from logging import Logger
import re
from typing import Any, Dict, List, Optional, Set, Tuple
import warnings

import poke_env.environment as pe

import metamon.backend.replay_parser as mrp
from metamon.backend.replay_parser.replay_state import (
    Pokemon,
    Turn,
    Winner,
    Nothing,
    Move,
)
from metamon.interface import UniversalPokemon


class OwnIllusion:
    """Resolve only our identity; buffer ambiguous events until private request or reveal.

    Private max HP still resolves unambiguous switches immediately. Equal/unknown
    HP needs the authoritative active flag before events reach the replay parser.
    Opponent identities are never corrected from private own-side information.
    """

    def __init__(self):
        self.side = None
        self.party = []
        self.shown = None
        self.disguise = None
        self.pending = []

    @staticmethod
    def max_hp(hp) -> Optional[str]:
        found = re.match(r"\d+/(\d+)", hp) if isinstance(hp, str) else None
        return found.group(1) if found else None

    def _request(self, fields):
        request = json.loads("|".join(fields[2:]))
        side = request.get("side") if isinstance(request, dict) else None
        party = side.get("pokemon") if isinstance(side, dict) else None
        if not isinstance(party, list):
            return None
        self.side = side["id"]
        self.party = [{"ident": str(mon["ident"]), "details": str(mon["details"]),
                       "max_hp": self.max_hp(mon.get("condition")),
                       "illusion": "illusion" in (mon.get("ability"), mon.get("baseAbility")),
                       "fainted": str(mon.get("condition", "")).endswith(" fnt"),
                       "active": mon.get("active") is True} for mon in party]
        active = [mon for mon in self.party if mon["active"]]
        if len(active) > 1:
            raise ValueError("Own active reconciliation requires a singles request")
        return active[0] if active else None

    def _translate(self, fields):
        if self.disguise is None:
            return [fields]
        shown, real = self.disguise
        if len(fields) > 2 and fields[1] == "replace" and fields[2] in (shown, real):
            self.disguise = None
            self.shown = real
            return []
        return [[real if field == shown else f"[of] {real}" if field == f"[of] {shown}" else field
                 for field in fields]]

    def _flush(self, active):
        queued, self.pending = self.pending, []
        first = queued[0]
        real = f"{self.side}a: " + active["ident"][len(self.side) + 2:]
        self.shown = first[2]
        self.disguise = (self.shown, real) if self.shown != real else None
        result = [[*first[:2], real, active["details"], *first[4:]]]
        for fields in queued[1:]:
            result.extend(self._translate(fields))
        return result

    def rewrite(self, fields: List[str]) -> List[List[str]]:
        kind = fields[1] if len(fields) > 1 else None
        own = self.side and len(fields) > 2 and fields[2].startswith(f"{self.side}a: ")
        if kind == "request":
            active = self._request(fields)
            if self.pending:
                self.pending.append(fields)
                return self._flush(active) if active else []
            if active and self.shown:
                real = f"{self.side}a: " + active["ident"][len(self.side) + 2:]
                self.disguise = (self.shown, real) if self.shown != real else None
            return [fields]
        if self.pending:
            if (own and kind in ("switch", "drag")) or kind in ("win", "tie"):
                raise ValueError("Unresolved own switch before another switch or terminal")
            self.pending.append(fields)
            if own and kind == "replace":
                species = fields[3].split(",")[0]
                revealed = [mon for mon in self.party if mon["details"].split(",")[0] == species]
                if len(revealed) != 1:
                    raise ValueError("Ambiguous own Illusion reveal")
                return self._flush(revealed[0])
            return []
        if own and kind in ("switch", "drag"):
            self.shown, self.disguise = fields[2], None
            hp = self.max_hp(fields[4]) if len(fields) > 4 else None
            position = f"{self.side}a: "
            named = [mon for mon in self.party
                     if mon["ident"] == f"{self.side}: {fields[2][len(position):]}"]
            named = named[0] if len(named) == 1 else None
            possible = [mon for mon in self.party if mon is not named and mon["illusion"] and not mon["fainted"]
                        and (hp is None or mon["max_hp"] is None or mon["max_hp"] == hp)]
            if not possible or named and named["illusion"]:
                return [fields]
            if named and named["max_hp"] != hp and len(possible) == 1 and hp and possible[0]["max_hp"] == hp:
                real = possible[0]
                self.disguise = (fields[2], f"{self.side}a: " + real["ident"][len(self.side) + 2:])
                return [[*fields[:2], self.disguise[1], real["details"], *fields[4:]]]
            self.pending = [fields]
            return []
        return self._translate(fields)


class MetamonBackendBattle(pe.AbstractBattle):
    """Replace poke-env's Showdown protocol/sim interpreter with Metamon's verison.

    A hacky version of the poke-env Battle object that lets the Metamon replay parser
    do all the showdown sim protocol interpretation. Creates an online env
    that replicates all the offline verisons's behavior... with the notable improvement
    of having access to the Showdown move request messages.

    Notes:
        - Do not try to access attributes that the metamon.interface does not use.
    """

    def __init__(
        self,
        battle_tag: str,
        username: str,
        logger: Logger,
        save_replays: str | bool,
        gen: int,
    ):
        self._battle_tag = battle_tag
        self._username = username
        self._logger = logger
        self._save_replays = save_replays
        self._gen = gen
        self._mm_battle = mrp.replay_state.ParsedReplay(
            gameid=battle_tag, time_played=datetime.now(), gen=gen
        )
        self._sim_protocol = mrp.forward.SimProtocol(self._mm_battle)
        self._own_illusion = OwnIllusion()

        # Turn choice attributes
        self.in_teampreview: bool = False
        self._teampreview = False
        self._wait: bool = False
        self._available_moves: List[Move] = []
        self._available_switches: List[Pokemon] = []
        self._can_dynamax: bool = False
        self._can_mega_evolve: bool = False
        self._can_tera: Optional[pe.PokemonType] = None
        self._can_z_move: bool = False
        self._opponent_can_dynamax = True
        self._opponent_can_mega_evolve = True
        self._opponent_can_z_move = True
        self._player_role = None
        self._opponent_can_tera: bool = False
        self._force_switch: bool = False
        self._maybe_trapped: bool = False
        self._trapped: bool = False

    @property
    def _current_turn(self) -> Turn:
        return self._mm_battle.turnlist[-1]

    def parse_message(self, split_message: List[str]):
        """
        Completely outsource all PS sim protocol messages to built-in
        Metamon replay parser (after OwnIllusion names our own disguise).
        """
        for message in self._own_illusion.rewrite(split_message):
            self._sim_protocol.interpret_message(message[1:])

    def parse_request(self, request: Dict[str, Any]):
        """
        Battle boilerplate, then call _update_turn_from_request
        """
        # Direct delivery and repeated requests use the same idempotent flush.
        for fields in self._own_illusion.rewrite(["", "request", json.dumps(request)]):
            if fields[1] != "request":
                self._sim_protocol.interpret_message(fields[1:])
        self._wait = request.get("wait", False)
        side = request["side"]
        if side["pokemon"]:
            self._player_role = side["pokemon"][0]["ident"][:2]
        self._can_mega_evolve = False
        self._can_z_move = False
        self._can_dynamax = False
        self._can_tera = None
        self._maybe_trapped = False
        self._reviving = any(
            [m["reviving"] for m in side.get("pokemon", []) if "reviving" in m]
        )
        self._trapped = False
        self._force_switch = request.get("forceSwitch", [False])[0]
        self._last_request = request
        self._teampreview = request.get("teamPreview", False)
        if self._teampreview:
            number_of_mons = len(request["side"]["pokemon"])
            self._max_team_size = request.get("maxTeamSize", number_of_mons)
        if "active" in request:
            active_request = request["active"][0]
            if active_request.get("trapped"):
                self._trapped = True
            if active_request.get("canMegaEvo", False):
                self._can_mega_evolve = True
            if active_request.get("canZMove", False):
                self._can_z_move = True
            if active_request.get("canDynamax", False):
                self._can_dynamax = True
            if active_request.get("maybeTrapped", False):
                self._maybe_trapped = True
            if active_request.get("canTerastallize", False):
                self._can_tera = pe.PokemonType.from_name(
                    active_request["canTerastallize"]
                )
        self._update_turn_from_request(request)

    def _update_turn_from_request(self, request: Dict[str, Any]):
        """
        The main advantage that the online version has over the offline
        (replay parser) version: we can get free info from Showdown's move
        request messages. Use this to discover the entire player's team
        on the first turn, valid/invalid moves, and PP counts.
        """
        self._available_moves = []
        self._available_switches = []

        active_pokemon = None
        side = request.get("side", False)
        if side:
            active_pokemon = self._update_turn_from_side_request(side)
            if active_pokemon is not None:
                self._reconcile_own_active(active_pokemon)

        active = request.get("active", False)
        if active and active_pokemon is not None and not self.reviving:
            self._update_turn_from_active_request(active[0], active_pokemon)

    def _reconcile_own_active(self, pokemon):
        """Own private active flags are authoritative, including equal/unknown HP."""
        self._current_turn.get_active_pokemon(self.player_role == "p1")[0] = pokemon

    def _parse_condition_from_side_request(
        self, condition: str
    ) -> Tuple[int, int, Optional[pe.Status]]:
        current_hp, max_hp, status = None, None, None

        condition = condition.strip()
        words = condition.split(" ")
        hp_part = words[0]
        if "/" in hp_part:
            current_hp, max_hp = hp_part.split("/")
            current_hp, max_hp = int(current_hp), int(max_hp)
        elif hp_part == "0":
            current_hp, max_hp = 0, 0
        if len(words) == 2:
            status_part = words[1]
            status = pe.Status[status_part.upper()]
        else:
            status = None
        return current_hp, max_hp, status

    def _update_pokemon_from_side_request(
        self, poke: Dict[str, Any], metamon_p: Pokemon
    ):
        """
        Reveal information about (our team's) pokemon from a "side" request
        """

        # update condition from request
        current_hp, max_hp, status = self._parse_condition_from_side_request(
            poke["condition"]
        )
        if current_hp is not None:
            metamon_p.status = status if status is not None else Nothing.NO_STATUS
        if current_hp is not None:
            metamon_p.current_hp = current_hp
        if max_hp is not None:
            metamon_p.max_hp = max_hp

        # update ability from request
        if poke["baseAbility"] == "noability":
            if metamon_p.had_ability is None:
                metamon_p.had_ability = Nothing.NO_ABILITY
            metamon_p.active_ability = Nothing.NO_ABILITY
        else:
            if metamon_p.had_ability is None:
                metamon_p.had_ability = poke["baseAbility"]
            metamon_p.active_ability = poke["baseAbility"]

        # get tera type, matching bug fix in poke-env update_from_request
        tera_type = poke.get("teraType", None)
        if tera_type is not None and metamon_p.tera_type is None:
            metamon_p.tera_type = tera_type

        # update item from request
        if poke["item"] == "":
            if metamon_p.had_item is None:
                metamon_p.had_item = Nothing.NO_ITEM
            metamon_p.active_item = Nothing.NO_ITEM
        else:
            if metamon_p.had_item is None:
                metamon_p.had_item = poke["item"]
            metamon_p.active_item = poke["item"]

        # discover initial moveset from request
        if not metamon_p.had_moves:
            for move in poke["moves"]:
                metamon_p.reveal_move(Move(move, gen=self._gen))

    def _update_turn_from_side_request(
        self, side_request: Dict[str, Any]
    ) -> Optional[Pokemon]:
        """
        Update the turn from a "side" request, and create self.available_switches
        """
        p1 = self.player_role == "p1"
        turn = self._current_turn
        active_pokemon = None
        request_pokemon = side_request.get("pokemon", False)
        if request_pokemon:

            for poke in request_pokemon:
                if not poke:
                    continue
                details = poke["details"]
                metamon_p = self._sim_protocol.get_or_create_pokemon_from_details(
                    details=details, poke_list=turn.get_pokemon(p1)
                )
                self._update_pokemon_from_side_request(poke, metamon_p)
                # build available_switches
                if poke["active"]:
                    active_pokemon = metamon_p
                elif (
                    not self.trapped
                    and not self.reviving
                    and metamon_p.status != pe.Status.FNT
                ):
                    self._available_switches.append(metamon_p)
                elif (
                    not self.trapped
                    and self.reviving
                    and metamon_p.status == pe.Status.FNT
                ):
                    self._available_switches.append(metamon_p)

        return active_pokemon

    def _update_turn_from_active_request(
        self, active_request: Dict[str, Any], active_pokemon: Pokemon
    ) -> None:
        """
        Update the turn from an "active" request, and create self.available_moves
        """
        active_moves = active_request["moves"]
        known_active_moves = {m.lookup_name: m for m in active_pokemon.moves.values()}
        override_active_moves = True
        available_moves = []
        for active_move in active_moves:
            move_id = mrp.str_parsing.move_name(active_move["id"])
            move_name = active_move["move"]
            disabled = active_move.get("disabled", False)
            if move_id in known_active_moves:
                # update PP counts from requests --- bailing us out of the main
                # thing the replay parser can't do well.
                known_active_moves[move_id].set_pp(
                    active_move.get("pp", known_active_moves[move_id].pp)
                )
                move = known_active_moves[move_id]
            elif move_id in {"recharge", "struggle", "fight"}:
                # these are handled as special cases in the action space, replay parser,
                # and here. The agent does not see recharge, struggle, or fight as its moves.
                move = Move(move_name, gen=self._gen)
                move.set_pp(active_move.get("pp", move.pp))
                override_active_moves = False
            else:
                known_had_moves = {
                    m.lookup_name: m for m in active_pokemon.had_moves.values()
                }
                plausible_reasons_to_discover = {
                    "copycat",
                    "metronome",
                    "mefirst",
                    "mirrormove",
                    "assist",
                    "transform",
                    "mimic",
                }
                if not plausible_reasons_to_discover.intersection(known_had_moves):
                    warnings.warn(
                        f"Unknown move {move_name} (lookup_name: {move_id}) discovered with known_had_moves: {known_had_moves}, known_active_moves: {known_active_moves}"
                    )
                move = Move(move_name, gen=self._gen)
                move.set_pp(active_move.get("pp", move.max_pp))
            available_moves.append((move, disabled))

        if override_active_moves:
            # use request to update the sim's moveset directly
            # (helpful for handling Mimic/Transform cases where the
            # replay parser normally fails.)
            active_pokemon.moves = {m.entry["name"]: m for m, _ in available_moves}

        # outward-facing Battle.available_moves needs to remove "disabled" moves
        self._available_moves = [m for m, disabled in available_moves if not disabled]

    def _convert_pokemon(self, pokemon: Pokemon) -> pe.Pokemon:
        p1 = self.player_role == "p1"
        active = self._current_turn.get_active_pokemon(p1)[0]
        if active is not None:
            is_active = pokemon.unique_id == active.unique_id
        else:
            is_active = False
        pe_p = UniversalPokemon.metamon_to_poke_env(pokemon, is_active=is_active)
        return pe_p

    @property
    def active_pokemon(self) -> Any:
        p1 = self.player_role == "p1"
        metamon_p = self._current_turn.get_active_pokemon(p1)[0]
        pe_p = self._convert_pokemon(metamon_p)
        return pe_p

    @property
    def all_active_pokemons(self) -> List[Optional[pe.Pokemon]]:
        raise NotImplementedError

    @property
    def available_moves(self) -> Any:
        return self._available_moves

    @property
    def available_switches(self) -> Any:
        pe_switches = [self._convert_pokemon(p) for p in self._available_switches]
        return pe_switches

    @property
    def battle_tag(self) -> str:
        """
        :return: The battle identifier.
        :rtype: str
        """
        return self._battle_tag

    def clear_all_boosts(self):
        pass

    @property
    def dynamax_turns_left(self) -> Optional[int]:
        """
        :return: How many turns of dynamax are left. None if dynamax is not active
        :rtype: int, optional
        """
        return None

    def end_illusion(self):
        pass

    @property
    def fields(self) -> Dict[pe.Field, int]:
        """
        :return: A Dict mapping fields to the turn they have been activated.
        :rtype: Dict[Field, int]
        """
        return self._current_turn.battle_field

    @property
    def finished(self) -> bool:
        """
        :return: A boolean indicating whether the battle is finished.
        :rtype: Optional[bool]
        """
        return self._mm_battle.winner is not None

    @property
    def force_switch(self) -> Any:
        return self._force_switch

    @property
    def format(self) -> Optional[str]:
        """
        :return: The format of the battle, in accordance with Showdown protocol
        :rtype: Optional[str]
        """
        return self._mm_battle.format

    @property
    def gen(self) -> int:
        """
        :return: The generation of the battle; will be the parameter with which the
            the battle was initiated
        :rtype: int
        """
        return self._gen

    @property
    def last_request(self) -> Dict[str, Any]:
        """
        The last request received from the server. This allows players to track
            rqid and also maintain parallel battle copies for search/inference

        :return: The last request.
        :rtype: Dict[str, Any]
        """
        return self._last_request

    @property
    def lost(self) -> Optional[bool]:
        """
        :return: If the battle is finished, a boolean indicating whether the battle is
            lost. Otherwise None.
        :rtype: Optional[bool]
        """
        if self._mm_battle.winner == Winner.TIE:
            return False
        won = self.won
        if won is not None:
            return not won
        return None

    @property
    def max_team_size(self) -> Optional[int]:
        """
        :return: The maximum acceptable size of the team to return in teampreview, if
            applicable.
        :rtype: int, optional
        """
        return self._max_team_size

    @property
    def maybe_trapped(self) -> Any:
        return self._maybe_trapped

    @property
    def opponent_active_pokemon(self) -> Any:
        p1 = self.player_role == "p1"
        metamon_p = self._current_turn.get_active_pokemon(not p1)[0]
        pe_p = self._convert_pokemon(metamon_p)
        return pe_p

    @property
    def opponent_can_dynamax(self) -> Any:
        return self._opponent_can_dynamax

    @opponent_can_dynamax.setter
    def opponent_can_dynamax(self, value: bool) -> Any:
        self._opponent_can_dynamax = value

    @property
    def opponent_dynamax_turns_left(self) -> Optional[int]:
        """
        :return: How many turns of dynamax are left for the opponent's pokemon.
            None if dynamax is not active
        :rtype: int | None
        """
        return None

    @property
    def opponent_role(self) -> Optional[str]:
        """
        :return: Opponent's role in given battle. p1/p2
        :rtype: str, optional
        """
        if self.player_role == "p1":
            return "p2"
        if self.player_role == "p2":
            return "p1"
        return None

    @property
    def opponent_side_conditions(self) -> Dict[pe.SideCondition, int]:
        """
        :return: The opponent's side conditions. Keys are SideCondition objects, values
            are:

            - the number of layers of the SideCondition if the side condition is
                stackable
            - the turn where the SideCondition was setup otherwise
        :rtype: Dict[SideCondition, int]
        """
        p1 = self.player_role == "p1"
        return self._current_turn.get_conditions(not p1)

    @property
    def opponent_team(self) -> Dict[str, pe.Pokemon]:
        """
        During teampreview, keys are not definitive: please rely on values.

        :return: The opponent's team. Keys are identifiers, values are pokemon objects.
        :rtype: Dict[str, Pokemon]
        """
        p1 = self.player_role == "p1"
        metamon_team = self._current_turn.get_team_dict(not p1)
        pe_team = {
            k: self._convert_pokemon(v)
            for k, v in metamon_team.items()
            if v is not None
        }
        return pe_team

    @property
    def opponent_username(self) -> Optional[str]:
        """
        :return: The opponent's username, or None if unknown.
        :rtype: str, optional.
        """
        p1 = self.player_role == "p1"
        return self._mm_battle.players[1] if p1 else self._mm_battle.players[0]

    @opponent_username.setter
    def opponent_username(self, value: str):
        self._opponent_username = value

    @property
    def player_role(self) -> Optional[str]:
        """
        :return: Player's role in given battle. p1/p2
        :rtype: str, optional
        """
        return self._player_role

    @player_role.setter
    def player_role(self, value: Optional[str]):
        self._player_role = value

    @property
    def player_username(self) -> str:
        """
        :return: The player's username.
        :rtype: str
        """
        p1 = self.player_role == "p1"
        return self._mm_battle.players[0] if p1 else self._mm_battle.players[1]

    @property
    def players(self) -> Tuple[str, str]:
        """
        :return: The pair of players' usernames.
        :rtype: Tuple[str, str]
        """
        return self._mm_battle.players

    @players.setter
    def players(self, players: Tuple[str, str]):
        """Sets the battle player's name:

        :param player_1: First player's username.
        :type player_1: str
        :param player_1: Second player's username.
        :type player_2: str
        """
        self._mm_battle.players = players

    @property
    def rating(self) -> Optional[int]:
        """
        Player's rating after the end of the battle, if it was received.

        :return: The player's rating after the end of the battle.
        :rtype: int, optional
        """
        p1 = self.player_role == "p1"
        ratings = self._mm_battle.ratings
        return ratings[0] if p1 else ratings[1]

    @property
    def opponent_rating(self) -> Optional[int]:
        """
        Opponent's rating after the end of the battle, if it was received.

        :return: The opponent's rating after the end of the battle.
        :rtype: int, optional
        """
        p1 = self.player_role == "p1"
        ratings = self._mm_battle.ratings
        return ratings[1] if p1 else ratings[0]

    @property
    def side_conditions(self) -> Dict[pe.SideCondition, int]:
        """
        :return: The player's side conditions. Keys are SideCondition objects, values
            are:

            - the number of layers of the side condition if the side condition is
                stackable
            - the turn where the SideCondition was setup otherwise
        :rtype: Dict[SideCondition, int]
        """
        return self._current_turn.get_conditions(self.player_role == "p1")

    def switch(self, pokemon_str: str, details: str, hp_status: str):
        pass

    @property
    def team(self) -> Dict[str, pe.Pokemon]:
        """
        :return: The player's team. Keys are identifiers, values are pokemon objects.
        :rtype: Dict[str, Pokemon]
        """
        p1 = self.player_role == "p1"
        metamon_team = self._current_turn.get_team_dict(p1)
        metamon_active = self._current_turn.get_active_pokemon(p1)[0]
        pe_team = {}
        total_active = 0
        for k, v in metamon_team.items():
            pe_p = self._convert_pokemon(v)
            if metamon_active is not None:
                pe_p._active = v.unique_id == metamon_active.unique_id
            else:
                pe_p._active = False
            if pe_p._active:
                total_active += 1
            if total_active > 1:
                raise mrp.exceptions.ForwardException(
                    f"Multiple active Pokemon in team: {metamon_team}"
                )
            pe_team[k] = pe_p
        return pe_team

    @team.setter
    def team(self, value: Dict[str, pe.Pokemon]):
        raise NotImplementedError

    @property
    def team_size(self) -> int:
        """
        :return: The number of Pokemon in the player's team.
        :rtype: int
        """
        p1 = self.player_role == "p1"
        return len(self._current_turn.get_pokemon(p1))

    @property
    def teampreview_opponent_team(self) -> Set[pe.Pokemon]:
        p1 = self.player_role == "p1"
        teampreview = self._current_turn.get_teampreview(not p1)
        return set(self._convert_pokemon(p) for p in teampreview)

    @property
    def trapped(self) -> Any:
        return self._trapped

    @trapped.setter
    def trapped(self, value: Any):
        self._trapped = value

    @property
    def turn(self) -> int:
        """
        :return: The current battle turn.
        :rtype: int
        """
        return self._current_turn.turn_number

    @property
    def weather(self) -> Dict[pe.Weather, int]:
        """
        :return: A Dict mapping the battle's weather (if any) to its starting turn
        :rtype: Dict[Weather, int]
        """
        # NOTE: we don't implement this turn counting system
        # and don't reccomend using it in observations. It will
        # always say the weather started on the current turn.
        weather = self._current_turn.weather
        if weather == Nothing.NO_WEATHER:
            return {}
        return {weather: self._current_turn.turn_number}

    @property
    def won(self) -> Optional[bool]:
        """
        :return: If the battle is finished, a boolean indicating whether the battle is
            won. Otherwise None.
        :rtype: Optional[bool]
        """
        winner = self._mm_battle.winner
        p1 = self.player_role == "p1"
        if winner is None:
            return None
        elif p1:
            return winner == Winner.PLAYER_1
        return winner == Winner.PLAYER_2

    @property
    def reviving(self) -> bool:
        return self._reviving

    @property
    def maybe_trapped(self) -> Any:
        return self._maybe_trapped

    @property
    def can_dynamax(self) -> Any:
        return self._can_dynamax

    @property
    def can_mega_evolve(self) -> Any:
        return self._can_mega_evolve

    @property
    def can_z_move(self) -> Any:
        return self._can_z_move

    @property
    def can_tera(self) -> Any:
        return self._can_tera

    @property
    def opponent_can_dynamax(self) -> bool:
        return self._opponent_can_dynamax


class PokeAgentBackendBattle(MetamonBackendBattle):
    """
    Battle that will attempt to maintain backwards compatibility with the MetamonBackend
    that was current during the PokéAgent Challenge, so that all the organizer baselines
    and datasets (about to be released) can maintain their performance. If any major bugs are
    found in MetamonBackendBattle or MetamonPlayer, we will unfix them here :)
    """

    def _update_pokemon_from_side_request(
        self, poke: Dict[str, Any], metamon_p: Pokemon
    ):
        """
        Reveal information about (our team's) pokemon from a "side" request
        """

        # update condition from request
        current_hp, max_hp, status = self._parse_condition_from_side_request(
            poke["condition"]
        )
        if status is not None:
            metamon_p.status = status
        if current_hp is not None:
            metamon_p.current_hp = current_hp
        if max_hp is not None:
            metamon_p.max_hp = max_hp

        # update ability from request
        if poke["baseAbility"] == "noability":
            if metamon_p.had_ability is None:
                metamon_p.had_ability = Nothing.NO_ABILITY
            metamon_p.active_ability = Nothing.NO_ABILITY
        else:
            if metamon_p.had_ability is None:
                metamon_p.had_ability = poke["baseAbility"]
            metamon_p.active_ability = poke["baseAbility"]

        # update item from request
        if poke["item"] == "":
            if metamon_p.had_item is None:
                metamon_p.had_item = Nothing.NO_ITEM
            metamon_p.active_item = Nothing.NO_ITEM
        else:
            if metamon_p.had_item is None:
                metamon_p.had_item = poke["item"]
            metamon_p.active_item = poke["item"]

        # discover initial moveset from request
        if not metamon_p.had_moves:
            for move in poke["moves"]:
                metamon_p.reveal_move(Move(move, gen=self._gen))
