# shwdn2op fork of Metamon

Metamon by the UT Robot Perception and Learning Lab (Jake Grigsby et al.), <https://github.com/UT-Austin-RPL/metamon>,
MIT licence (`LICENSE`, unchanged). This fork starts at upstream commit `0a00a759c9a4382a2877088d828302ec294a05a5`
(metamon 1.6.0). It is the only Metamon source shwdn2op runs; there is no patch step.

Changes from upstream, all in `metamon/` (`diff -r` against an upstream checkout lists exactly these files):

| File | Change |
| --- | --- |
| `env/metamon_battle.py` | `OwnIllusion`: our own disguised Zoroark is named as itself before the replay parser sees it (same rule as `OwnIllusion` in `apps/companion/src/battle-agent/metamon.ts`; tests in `tests/`) |
| `config.py`, `rl/evaluate/ladder_self_play/{launch_models,serve_model}.py` | `gen9uu` accepted as a format |
| `rl/pretrained.py` | `LocalFinetunedModel` passes the base observation space and gin overrides; `UUKakuna` / `UUFinetuned` registrations read paths from the environment |
| `env/wrappers.py` | date-only trajectory timestamp; a `<file>.meta` sidecar per trajectory (battle tag, result, invalid orders, parse errors, team file) |
| `env/metamon_player.py` | counts replay-parser exceptions on the battle for the sidecar |
| `rl/metamon_to_amago.py`, `rl/train.py` | pass `traj_save_len` as an int (amago 3.4.0's float default `1e10` fails `random.randint`) |
| `backend/team_preview/preview.py` | a format with no tokenizer token (`gen9uu`) gets no format prefix, in both training and inference; the preview trainer accepts `--val_dset_root` (a separate validation set) and `--init_checkpoint` |
| `data/parsed_replay_dset.py` | a native replay with a `schema` field is validated with `interface.replay_outcome` when loaded |
| `interface.py` | states carry explicit terminal and roster provenance (`player_remaining`, `battle_complete`, `terminal_score`); `state_outcome`/`replay_outcome` validate it and never infer a draw from missing flags; the HP-change reward term is a reusable `hp_change` |
| `rl/custom_agent.py` | the BC actor head and optional importance-sampling correction are computed only when enabled; when disabled, a zero-weighted term keeps BC gradients, AdamW decay and optimizer resume state unchanged |
| `rl/finetune.py` | a `--reward_function` override is resolved before the agent is built, so it reaches the agent |

## Data files and assembly

The 24 upstream files listed in `data.sha256` (Showdown dex move/pokedex/learnset JSON and four `.pt` weight files,
about 78 MB) are not kept here. `assemble.py` builds a runnable package from this tree plus those files, copied and
hash-checked from an upstream checkout at the commit above (`git clone https://github.com/UT-Austin-RPL/metamon`,
`git checkout 0a00a759`) or from any existing run source:

```sh
python assemble.py build RUN/source --data-from UPSTREAM_CHECKOUT --expect TREE_SHA256
python assemble.py swap RUN/source --expect TREE_SHA256    # between blocks; the old tree moves to RUN/source-retired/
python assemble.py tree RUN/source                          # print the tree hash
```

The tree hash covers every file of the assembled `metamon/` package. Its pin lives in
`scripts/uu_selfplay/source-pins.json`. Any change under `metamon/` needs a new pin and must pass `tests/` plus the
self-play kit's parity and replay checks before a run source uses it.

## Tests

```sh
PYTHONPATH=RUN/source python -m unittest discover -s vendor/metamon/tests -v
```

`tests/streams.json.gz` holds private streams of seeded random-player battles in Pokémon Showdown 0.11.11's own
simulator, made by `tests/make_streams.cjs` with UU team-pool teams (test accounts only).
