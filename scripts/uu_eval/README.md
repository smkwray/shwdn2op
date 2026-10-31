# Gen 9 UU (UnderUsed) paired-slot dev evaluation

> **Status.** This dev evaluator is now qualification-only. `evaluate.py prepare` and `run` refuse anything but a
> `--qualification` (8-game pipeline) run with `CERTIFICATION_CAMPAIGN_HOLD`. That covers full candidate cohorts and
> the re-rank arm. Its design and analysis code remain the reference for the paired-slot method, and
> `scripts/uu_selfplay/progress_eval.py` reuses them. Historical cohorts keep their frozen producers. Future strength
> claims go through the certification campaign (see "Certification campaign" below), which is on hold. The live advisor
> runs Kakuna epoch 34, and no candidate has been shown to beat it.
>
> This is frozen-producer tooling: `spec.py` pins the qualified eval-host worker (`WORKER_SHA`), not the tracked
> `scripts/metamon-worker.py`, so a run from this checkout fails closed at `checkpoint_proof`; it needs the matching
> qualified runtime.

Offline macbox official simulator; gpubox production CLI workers over SSH. Run from
the project root. No browser, server, public ladder, package installation, paid
API, or move actuation. Existing project files and the pinned worker are unchanged.

`evaluate.py prepare` preregisters 35 dev roster families, ring opponents +1/+2
in SHA256 order, both home seats and two native seed vectors: 280 slots/arm,
560 games. Each family appears as home and opponent in eight slots/arm. Exactly
one manifest representative per family; no Cartesian product. The pool contains
human rosters with imputed sets, not full human exports. Held-out team files are
never opened. Qualification selects two home families, offset +1, both seats,
first seed: four slots/arm, eight games.

B0 home and opponent are epoch-34 Kakuna. B1 changes only the home actor to the
explicit export/run/epoch/SHA256. Opponent stays epoch-34. Adjacent pairs alternate
B0/B1 execution order. The seed formula, inherited from an earlier harness, uses the first four SHA256 bytes,
shifted right one, of `seedFamily:stratum:seat:comma-separated-native-seed`;
`stratum` binds the home family and opponent assignment. Both workers receive
that seed and `--seed-per-side`; the pinned worker derives each side's stream
(including preview) from `sha256(slot_seed:side)[:4] >> 1`. Later random events
need not stay aligned once actions diverge.

The standalone `match.ts` uses the existing `runBattleMatch`, Metamon transport,
and candidateSeat factory. It is the per-seat CLI seam missing from the existing
simulation CLI; no existing file is edited. Workers use identical production
PYTHONPATH, Flex attention, temperature, deadlines and mappings. The passive
neural observer joins executed commits to exact owned PID/start-time identities,
policy IDs, export SHA256 and side seeds without changing wire messages.

One match/two worker roots at a time. Admission 80 GiB available, spawn
reservation 40 GiB, active 32 GiB, per-game tree 8 GiB and aggregate 40 GiB guards
remain. Claims/heavy-job query failures, ambiguous ownership, boot/worker drift,
new foreign GPU processes and swap growth stop the run. CPU/load remain telemetry
by design. The bounded CPU-counter capacity is 2,048
(previously 512; the live host has over 512 processes). The only shared GPU
exception is an exact, initially observed `metamon.rl.finetune --run_name
uu_iter1` PID/start-time/argv hash. It is never signalled. Its ordinary exit is
permitted; PID reuse grants no exception. Released owned GPU contexts get a
bounded grace period; successful unload still needs process/tree and GPU absence.

The existing worker EOF cancellation and transport close are followed by exact
local SSH/process cleanup and remote `/proc` plus nvidia-smi verification after
every game. No next game follows unproved unload. Failed games are never retried
or replaced; originals are retained. Three crashed games stop the cohort. Match
cap: 1,000 turns / 12,012 decisions / 3,600 seconds; per-decision 120 seconds.
A crash, deadline or turn cap is censored, never a draw or terminal HP carry.

Each run retains its source producer ZIP, manifest, source tree and a complete
byte/link manifest of the installed node_modules, before and after. A cohort is
bound to those retained producer bytes, and runs from a frozen source snapshot,
not the mutable checkout.
Checkpoint/worker hashes are checked remotely before and after; the candidate
export receipt and production worker's original runtime gate are mandatory.
Dev team hashes and pool manifest are bound in the spec and checked during
preparation, execution, verification and analysis.

## Run a specific exported candidate

**Retired for certification.** These cohorts now stop with `CERTIFICATION_CAMPAIGN_HOLD` unless `--qualification` is
given. The commands are kept as a record of the registered design.

Use a fresh project `tmp/` output on macbox and fresh `remoteRoot` under the gpubox
project's `tmp/`. `--candidate` is a gpubox path in the exported
`RUN/ckpts/policy_weights/policy_epoch_N.pt` layout, with its adjacent exporter
receipt. Export from the fine-tune is a separate step; this runner never touches
training files. Keep at most the plan's three predeclared checkpoints on dev.

The qualification runtime JSON is device-local at
`tmp/uu-eval-prep-20261020/runtime-b.json`. It records the qualified production
Python, base checkpoint, production PYTHONPATH and cache environment. Create a
fresh runtime JSON from it by changing only `remoteRoot`, using a project-local
path on gpubox. Example exact commands from macbox (set the four candidate values):

```sh
CANDIDATE=/path/to/shwdn2op/tmp/uu-selfplay-20261020/eval-prep/exports/uu_iter1/ckpts/policy_weights/policy_epoch_2.pt
RUN=uu_iter1
EPOCH=2
SHA256=REPLACE_WITH_DECLARED_EXPORT_SHA256
OUT="tmp/uu-eval-dev-${RUN}-e${EPOCH}-${SHA256}"
python3 -B - "$OUT" <<'PY'
import json,sys
from pathlib import Path
out=Path(sys.argv[1])
r=json.loads(Path('tmp/uu-eval-prep-20261020/runtime-b.json').read_text())
r['remoteRoot']=r['project']+'/tmp/'+out.name
p=Path('tmp')/(out.name+'-runtime.json')
with p.open('x') as f:json.dump(r,f,indent=2)
print(p)
PY
python3 -B scripts/uu_eval/evaluate.py prepare --out "$OUT" --runtime "${OUT}-runtime.json" --candidate "$CANDIDATE" --run "$RUN" --epoch "$EPOCH" --sha256 "$SHA256"
python3 -B scripts/uu_eval/evaluate.py run "$OUT"
python3 -B scripts/uu_eval/verify.py "$OUT"
python3 -B scripts/uu_eval/analyze.py "$OUT"
```

Run the three execution/verification/analysis commands in sequence and inspect
any nonzero exit. Preparation alone makes no remote calls. Execution admits once,
refuses reuse, and never restarts. A resource hold requires a fresh output/spec;
it cannot replay the same run. SIGINT cancels at the next bounded observer return.
Do not run a full dev evaluation as part of the eight-game qualification.

## Re-ranker arm (B0 raw vs B1 re-ranked)

This experiment was pre-registered on 2026-10-21; the adoption rule is `ADOPTION_RULE` in `analyze.py`.
`prepare --rerank` replaces the four candidate arguments; the two forms cannot be mixed.

**Arms.** Both arms run the pinned production worker on the epoch-34 base checkpoint. The epoch-34 opponent, slots,
seeds and team families are identical to the dev design.
- B1's home seat executes the `metamon-rerank@2` pick (`apps/companion/src/battle-agent/rerank.ts`): actions red-flagged by
  `spec.py` `GUARDS_VERSION` (now `tactical-guards@6`) as a rules-certain failure (`delayed_slot_occupied`, `hazard_maxed`) get no mass; tactical flags (`pre_move_ko`,
  `setup_dead_end`, `switch_into_ko`) keep at most τ jointly, unflagged actions share the rest in Metamon's proportions,
  and p' = p when nothing is unflagged. The draw is maximally coupled to Metamon's own sample.
- τ (`prepare --tau`, default 0.2; set from the precision audit's false-positive rate, floor 0.05) and the kinds the
  audit demoted to amber (`--demote kind,kind`) are sealed in `spec.json` as `candidate.rerankConfig`.
- B0's home seat executes Metamon's raw pick. It logs the re-ranker as a shadow, with the same seed.
- Both arms write the same per-decision row to `<game>/rerank-trace.jsonl`: raw p and pick, guards, flags, τ, p',
  the re-ranked pick, and the executed action.
- B1's home policy ID is `metamon:Kakuna:epoch34+rerank@2`. Every other seat is `metamon:Kakuna:epoch34`.
- A non-preview home decision without the worker's distribution fails the game. Otherwise B1 would silently play raw.

**Pinned.**
- On gpubox, before and after: the base checkpoint, `metamon-worker.py`, `worker_trace.py` and
  `metamon_port/action_probs.py`. `worker_trace.py` loads `action_probs.py` by path, so it is deployed and pinned for
  every cohort kind.
- No export receipt is required, because there is no exported checkpoint.
- The live companion's set priors (`tmp/meta-priors/gen9uu-2026-09.descriptor.json` and its raw file) are copied into
  `OUT/guard-priors/`, and their SHA-256 values are sealed in `spec.json`. `run` and `verify.py` stop on drift.
- `match.ts` gives these priors to both arms as `movePriors`. `replay-inputs.json` therefore holds the full normalized
  prior: about 2.4 MB per game, about 1.3 GB per 560-game cohort.

**Verification adds:**
- `job.json` equals the job derived from the spec.
- Worker proposals join Metamon's raw picks; commits join executed choices. A re-ranked switch into a hidden trap is
  staged with the worker, and its re-choice reuses the same forward.
- `verify_rerank.ts` checks every home row against the hash-verified envelope. It recomputes guards, flags, p' and
  the coupled pick from that envelope, the logged p, the job seed and the sealed τ/demotions. It checks the executed rule: shadow executes raw;
  rerank executes the re-ranked pick, or raw when there is no distribution (team preview). It also checks that the
  replay priors equal the pinned files.

**Analysis adds:**
- For every cohort kind: material at turns 20 and 25 (M20, M25) and the area under the material curve (AUC)
  `AUC15-25=(M15+2*M20+M25)/4`, with the same terminal carry as AUC5-15.
- For re-rank cohorts:
  - `primary`: paired terminal score, equal family weights; passes only if the family-cluster bootstrap 95% lower
    bound > 0 AND the exact sign-flip permutation p < 0.05. For the terminal score, family means are exact
    rationals, so the test is exact over all 2^families sign vectors at any family count.
  - `divergence`: `N_div` (pairs whose B1 trace has ≥1 executed re-rank), `N_flip` (pairs whose score differs), the
    conditional effect over the N_div pairs (confidence interval, CI, and exact p), and the determinism check (pairs without an executed
    re-rank must have identical results; a violation makes the recommendation `invalid`).
  - A secondary (AUC5-15, AUC15-25) regresses only if its family-cluster 95% CI is entirely below 0.
  - `recommendation`: `adopt` (primary passes, nothing regresses); `extend` (point estimate > 0, primary not passed,
    N_div ≥ 20; LB > 0 with p ≥ 0.05 is treated as inconclusive-positive too). `extend` is only a text label. The
    follow-up it named (one more 560-game cohort with seed vectors 3-4, pooled under a 97.5% lower-bound gate) is a
    retired prescription, not an available procedure: the analyzer reads one cohort, and no pooled analysis exists; `stop` (shadow-only); `undetermined` on a qualification,
    unverified or partial run; `invalid` on a determinism failure. `adoptLiveDefault` mirrors it (null when not decided).
  - Per-arm `inGameTactical`: decisions, decisions with a red guard, executed flagged actions and their rate, and
    actions re-ranked away.
  - `--tactical`: the tactical suite report, kept as a guard-firing regression report only (never evidence). The
    suite's real case tables are private and not shipped; `tactical_suite.mts` stops with an error without them.

**Commands (retired for certification).** These cohorts now stop with `CERTIFICATION_CAMPAIGN_HOLD` unless
`--qualification` is given. They are kept as a record of the registered design.
`--admission-gib 60 --swap-tolerance-mib 256` copy the current dev queue's settings; the defaults are 80 and 0.

```sh
OUT="tmp/uu-eval-dev-rerank-$(date -u +%Y%m%dT%H%M%SZ)"
python3 -B - "$OUT" <<'PY'
import json,sys
from pathlib import Path
out=Path(sys.argv[1]);r=json.loads(Path('config/local/uu-eval-runtime.json').read_text())
r['remoteRoot']=r['project']+'/tmp/'+out.name
with Path(str(out)+'-runtime.json').open('x') as f:json.dump(r,f,indent=2)
PY
python3 -B scripts/uu_eval/evaluate.py prepare --rerank --tau TAU --demote DEMOTED_KINDS --out "$OUT" --runtime "${OUT}-runtime.json" --admission-gib 60 --swap-tolerance-mib 256
python3 -B scripts/uu_eval/evaluate.py run "$OUT"
python3 -B scripts/uu_eval/verify.py "$OUT"
python3 -B scripts/uu_eval/analyze.py "$OUT" --tactical TACTICAL_SUITE_REPORT.json
```

Add `--qualification` to `prepare` for the eight-game pipeline check. A qualification can never adopt.

## Outputs and interpretation

`verification.json`: every completed game's exact canonical result hashes,
identities, legal actions and choices, then official native recorded-choice
replay with equal public and both private traces except wall clock; worker
forward/proposal/commit counts, executed-choice joins, side seeds, policy IDs,
checkpoint hashes, and unload receipts. Verification invokes no models.

`material.csv`, `paired.csv`, `analysis.json`, `process.json`: exact private HP%
material (home minus opponent, range -600..600), M5/M10/M15/M20/M25,
`AUC5-15=(M5+2*M10+M15)/4` and `AUC15-25=(M15+2*M20+M25)/4`. End-of-turn material comes from the next turn's primary
private requests, including silent bench healing. Earlier true terminal states
carry forward. Incomplete games are missing; incomplete pairs are excluded only
from paired estimates, with every exclusion listed. W/D/L uses completed games.

Paired B1−B0 estimates use equally weighted home-family means. A deterministic 10,000-draw family-cluster bootstrap
(seed 20261020) keeps all of a family's assignments, seats and seeds together, and gives 95% percentile CIs. The
analyzer also reports:
- an exact family-level sign test;
- a sign-flip permutation test. For the terminal score it is exact at any family count. For the material and AUC
  metrics it is exact up to 16 families and seeded Monte Carlo above that.

Opponent families recur across home clusters, so these are conditional dev-panel intervals. They are not population
or human-playing-strength estimates. A single cluster gets no CI. A qualification run has two clusters and cannot
support a promotion claim.

The analyzer also reports crashes and timeouts, missing games, errors, fallbacks, switching and Tera counts, and home
policy latency p50/p95. Failures are never suppressed to show successes only. A game with rejected choices is admitted
only if every rejection is a trapped-switch retry, proven by the closed-run verifier's canonical and native replay
receipts and by model recurrence.

## Certification campaign (HOLD)

Future model-strength claims are certified through a single-controller campaign rather than this dev evaluator.
- **Ledger** (`campaign.py`). It allows one dev reservation and one held-out reservation per candidate.
  - A candidate is its *typed tensor identity*: a SHA-256 over tensor names, dtypes, shapes and little-endian values.
    Renaming or re-serializing a checkpoint therefore cannot reset its budget.
  - Held-out attempt k is tested at α_k = 0.05 / (k(k+1)), so all attempts together spend at most 0.05.
  - There are no refunds, replacements or namespace resets.
  - A reservation never authorizes panel access.
  - **Boundary.** `reserve` records the binding hashes it is given; it does not recompute the candidate identity from
    a checkpoint, and it does not enforce dev success before a held-out reservation. Both belong to the qualified
    controller. The 0.05 budget covers held-out reservations in this prospective campaign's new ledger; historical
    tests imported into the ledger are not charged against it.
- **Inference** (`campaign_inference.py`). A fixed-N exact betting e-value mixture over bounded family scores, with a
  lower confidence bound found by monotonic inversion. N and the mixture are frozen before results. It is not an
  optional-stopping guarantee.
- **Power** (`campaign_power.py`). A synthetic fixed-panel sensitivity check of the actual design. It is planning, not
  calibration.
- **Admission.** The campaign stays on hold until the canonical ledger writer, fresh both-roster family blocks
  (historical families excluded), the native inference qualification and the actual-design power check are frozen and
  qualified. The registered rule instance and its receipts are kept outside Git.

## Internal progress screens

`scripts/uu_selfplay/progress_eval.py` reuses `paired_inference` on training-reserved families. It selects candidates
only and is never certification evidence.
- **Registered design.** 960 games: 24 progress families (`progress_panel.py` default) × 10 repetitions
  (`batch_collect.py --purpose progress --progress-repetitions 10`) × 2 seats × 2 arms. The default of one repetition
  gives 96 games, a pipeline check only.
- **Completeness.** The helper validates completeness against the plan it is given, not against N = 960; a smaller
  plan can still trigger. A selection consumer must check the registered design.
- **Trigger.** Candidate score ≥ 0.60 and paired bootstrap lower bound > +0.05, on a complete cohort.
- **Censoring** (`uu-progress-censoring@1`).
  - Only harness deadline expiries may be censored, up to the job's registered fraction (2% of planned games).
  - The screen must also pass when censored games are re-scored pessimistically (a candidate loss, a baseline win).
  - Any other failure or missing game invalidates the screen.

## Local checks

```sh
python3 -B -m unittest discover -s scripts/uu_eval -p 'test_*.py' -v
```

The design tests use the small synthetic team pool in `scripts/uu_eval/fixtures/team-pool/`; a real run reads the
device-local pool. Tests that need `torch` or the private campaign rule skip with a stated reason when it is absent.

```sh
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck scripts/uu_eval/match.ts scripts/uu_selfplay/candidate_seat.ts scripts/uu_eval/verify_rerank.ts
```

Run/evidence/cache/log artifacts stay under project `tmp/` on each device.
The project ignores that tree in Git and Syncthing. winbox is unused.
