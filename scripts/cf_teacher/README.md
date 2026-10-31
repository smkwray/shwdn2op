# Conditional counterfactual teacher pilot

Offline only. This tooling never connects to Showdown or a companion and never trains a model.
`pilot.mjs` runs independent e34 self-play, captures detached native Battle JSON plus player-specific
protocol, and enumerates all request-legal move, Tera and switch actions. It retains failed branches.
`worker.py` reuses the existing worker's official decoder, actor, action mapping and e34 weights;
only branch state is copied. Root distributions are checked against chronological replay, and
same-seed continuations must repeat. `guard.py` yields to production, foreign GPU or evaluation work.

Run the correctness checks from the project root:

```sh
node --test scripts/cf_teacher/test_pilot.mjs
python3 -m unittest scripts/cf_teacher/test_guard.py
```

A run needs a private config with `design`, `registration`, `output`, `teams`, `exclusions` and
`worker`. Teams carry file hashes, species, families and public-source provenance. The registration
must bind the exact design and config SHA256 before source generation. A retained immutable producer
must include the worker, assembled fork pin, dependency hashes, public input teams and registration.
The CUDA worker uses the project's existing qualified runtime; it downloads no model or dependency.
Launch `node scripts/cf_teacher/pilot.mjs CONFIG` through `guard.py` inside the approved visible job
runner. The guard config provides `argv`, `cwd`, `statusCommand` and `events`.

The fixed pilot has at most 6 source games / 40 turns, 12 states (4 engineering, 8 held aside),
4 common seeds per action, a 2-turn horizon, a 32-dispatch branch cap and a 45-minute wall bound.
Per-state JSON contains legal actions, e34 mass/argmax, individual outcomes, material scores,
Student-t intervals, paired differences, soft targets and robustness. These small-sample intervals
are descriptive; seed stability is not belief stability or playing-strength evidence.

All labels are conditional on the original hidden world. Opponent replies are sampled e34 actions,
not exhaustive best replies. The leaf score is terminal outcome or transparent HP material, not a
learned critic or terminal win estimate. `datasetReady` is always false. Full distillation requires
public-history-consistent hidden-set sampling, stronger reply coverage, longer/terminal target
validation, independent useful-sacrifice/recovery controls and a separate pre-registration.

## Round 2

`round2.mjs` reuses the native session, legal-action enumeration and worker transport above.
`belief.mjs` supplies the factorized monthly-ladder sampler, public-history constraints,
reply coverage, world/seed aggregation and independent mechanical controls. The original
pilot is preserved. Run all correctness checks with:

```sh
node --test scripts/cf_teacher/test_*.mjs
python3 -m unittest scripts/cf_teacher/test_guard.py scripts/cf_teacher/test_worker.py
```

Round-2 configs add a hash-bound monthly raw `prior`, `games`, source `turns`, `worlds`,
`worldAttempts`, `seeds`, paired `shortTurns`/`longTurns`, `terminalEvery`, `terminalTurns`,
`dispatchCap`, `terminalDispatchCap`, `wallSeconds` and conjunctive `gates`. Reuse the round-1 retained-producer
assembly and owned-child guard. Guard wall time is configurable up to three hours; its
default remains 45 minutes. No runner connects to a server or companion.

Each accepted world is rebuilt from battle start with sampled hidden sets and chance,
then checked against the complete acting-side public prefix and known private requests.
Revealed sets constrain the prior; rejected proposals are counted. Inability to fill K
worlds invalidates the state. The prior is a declared marginal construction (31 IVs),
not an empirical joint-set posterior or e34 historical action-likelihood posterior.
Unsupported transformations/exchanges fail explicitly. Each accepted world's regenerated
private requests are replayed through its seat's official decoder and recurrence.

Every legal root reply is evaluated for every own action, world and seed. Full e34
reply probabilities weight expectations; worst-reply values are reported separately.
The paired leaves share one continuation, and the fixed terminal subset compares the
registered alternatives with common sampled replies to game end (censoring retained).
Four independently specified sacrifice/recovery diagnostics are separate from source
states. All labels remain `datasetReady=false`; no model-strength or deployment claim
follows from a signal test.

Root worst-reply reporting averages chance seeds for each reply before minimizing, then
averages worlds. `longWorstChanceBound` separately retains the more pessimistic per-seed
minimum. A frozen cohort predating this reporting correction is audited from its retained
rows; weighted preferences, robustness and sealed gates are unchanged.

Source/replay choices use the actual native request menu, including collapsed forced
menus; Struggle/Recharge never become sampled learned moves. These cases were repaired
after the frozen round-2 cohort and have failing-first tests. The frozen run remains FAIL;
no post-repair signal result or dataset admission is implied.
