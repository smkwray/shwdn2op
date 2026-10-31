# Companion daemon

Local canonical battle reducer and deterministic evaluator. Hidden-state hypotheses, Speed intervals, posterior-weighted damage and candidate scoring run without an LLM. Optional provider adapters remain available separately.

## Deterministic contract

The initial contract targets Gen 9 singles. Its envelope declares remaining limitations, including heuristic ranking, uncalibrated confidence and explicit ambiguity/recovery restrictions. Actual background Google Chrome certification remains outstanding. Consumers must inspect `capabilities`; `degraded` is not a readiness certificate.

1. `POST /v1/observations` ingests `{observations: [...]}` in capture order. Each observation has `observationId`, `sessionId`, positive `sequence`, `roomId`, `source` (`protocol` or `recovery`), and room-routed raw `data`, for example `>battle-gen9uu-123\n|request|{...}`. Batches are atomic across canonical state and the in-memory observed history; the history file is written behind the request (atomic rename, coalesced within about a second, flushed on shutdown), and a failed write stays pending, is retried and is reported as `historyPersistence` by `GET /api/health`. IDs are immutable and idempotent. A retry must preserve the entire observation. A reused ID with different content or an older sequence receives HTTP 409. Each acknowledgement includes its original ID/sequence and the resulting canonical room/snapshot/identity. The response pins a `historyRevision` for evaluation.
2. `POST /v1/evaluate` accepts `{sessionId, identity, historyRevision, after?}`. `identity` is the exact returned `{roomId, rqid, stateRevision, requestKind, snapshotHash, legalActionSetHash}`; `rqid` may be null. Evaluation is read-only against that canonical state and captured history view. A stale identity or expired history view receives HTTP 409. Ingest an observation to pin a fresh history view rather than silently substituting one.
3. `POST /v1/metamon/advice` (live advisor) accepts the evaluation fields (plus `after: "pick"` to wait for a ready pick's warnings); the pick is bound to the canonical identity only and never waits for the deterministic envelope. With `?waitMs=N` (at most 5000) a pick still being computed is answered as soon as it is ready.
4. `POST /v1/feedback` accepts the evaluation fields plus `resultHash`, after the result was rendered. It verifies the current decision and exact evaluated result before recording prediction history; repeated shown-result feedback is idempotent. Evaluation alone records no shown prediction.

Evaluation is staged: it returns `{ok, evaluatedAt, stage, final, envelope: {semantic, resultHash}}` with the first result newer than `after` (waiting at most 4 s, holding no lock). Partial stages `board` (speed, revealed/likely sets), `damage` and `threats` carry `semantic.stage` and their own `resultHash`; their sections equal the complete result's. The complete envelope (`final: true`, no `stage`) is unchanged; ask with `after: "threats"` to wait for it. The transport timestamp is outside the semantic result. `semantic` contains:

- `contractVersion: "showdown-decision@1"`, source/data `engineVersion`, full decision `identity` and pinned `historyRevision`;
- `capabilities` with status, limitations, actionability and the meaning of confidence;
- canonical `snapshot`, including the exact structural action set;
- `localIntel`, including `selfActionRecommendation.rankedActions`, score components, risks, damage bands and hidden-state assumptions.

Every ranked `actionId` must belong to the returned enabled action set. Tera and ordinary moves are distinct actions (`move:2|tera=0` / `move:2|tera=1`); switches use one-based team slots (`switch:3`); preview choices contain an ordered `teamSpec`. `choice` is the exact Showdown token, such as `move 2 terastallize`, `switch 3` or `team 123456`. It is descriptive; no endpoint submits it to Showdown. Uncertain switches retain `uncertaintyReason: "hidden_trapping_ability"` and `canUndo: false`.

Before displaying a result, verify its semantic hash, history revision and all six identity fields against the latest capture. Invalidate advice as soon as newer observations are pending. Aborting an older HTTP request is only an optimization. The extension follows these checks and renders the same ranked object available to machine consumers.

## Canonical identity and evidence

The companion retains immutable semantic facts with raw observation references. Stable party instances are separate from active appearances and current request slots: Showdown can reorder the private party on a switch. An Illusion `replace` rebinds the existing appearance, so its facts and reversible history contributions project to the revealed instance without copying selected fields between Pokémon.

Public singleton identity requires a completed preview and a matching declared roster count when supplied. Unresolved appearances retain candidate instances and withhold species-dependent advice, history promotion and replay training labels. Repeated public preview resets explicitly degrade as `preview_reset_unavailable`. Supplemental page state cannot establish canonical history. `recentLog` is presentation only in this path. Item, ability, hazard, damage and move-order inference cite fact ancestry. Damage constraints require a supported, closed, uncapped single-hit interval; Speed constraints require known ordinary ordering modifiers and preserve tie likelihood. Unsupported windows remain raw observations.

Observed history is rebuilt from per-battle contribution maps, allowing retraction and reassignment without duplicate counts. Curated priors remain separate. Recovery must align to the public timeline and pass request-epoch checks; uncertain chronology or conflicting requests are quarantined rather than merged into current private state.

## Existing adapter endpoints

- `GET /api/health`
- `POST /api/analyze`
- `POST /api/observe-snapshot`
- `POST /api/save-replay`

Snapshot/provider endpoints remain for existing manual analysis and tools, labelled `legacy_untrusted`; they cannot write canonical observed history. The observation/evaluation contract above is the canonical deterministic live path.

## Providers

- `mock`
- `codex`
- `claude`

## Battle-agent

`src/battle-agent/battleAgent.ts` defines a model-independent `BattlePolicy`. Every proposal copies the full canonical identity and a unique request ID, chooses an enabled action ID, and passes schema, current-state and deadline checks. `BattleActionExecutor` requires expiring authorization for one room, a numbered request and an exact choice token. Dispatch is synchronous under the canonical room lock and occurs at most once per room/rqid. Dispatch does not claim server acknowledgement. There is no action-capable HTTP endpoint.

`OpenCodeBattlePolicy` uses the installed OpenCode v2 CLI's authenticated `api experimental.generate.text` operation. The configured defaults are `openai/gpt-6-luna#xhigh` and `anthropic/claude-sonnet-5-5#high`. Completed model games used low effort; eight isolated Luna xhigh decisions passed. Sonnet high and overload fallback have mock coverage, not completed-game qualification or a strength claim. This stateless route exposes no model tools or coding session. It has no native JSON-schema enforcement or proven upstream cancellation; strict local validation and bounded local deadlines remain necessary. No other provider integration is added to battle-agent yet.

The prompt includes canonical `pendingAttacks` and the existing bounded, chronological `recentLog` as observations. Current canonical state and enabled actions take precedence; no persistent plan memory is added. It requests only `{actionId}`. The strict reply schema also accepts an optional reason of at most 240 characters. The adapter binds the captured request ID and full decision identity locally; the common agent checks freshness again after the reply. Extra fields, invalid JSON and unavailable actions are rejected. A simplified reply does not bypass stale-request or executor checks.

Before generation, the adapter checks the server version and exact configured model/variant in the server's base-location catalog. This source-verified locator supports OpenCode 2.0.20; other versions fail closed. Readiness polls only a valid catalog, for at most five seconds within the original decision deadline. Metadata checks do not count as model attempts and do not retain configuration contents.

The adapter defaults to no format correction. Its optional `maxAttempts: 2` permits one shared extra generation for rejected decision JSON, schema or unavailable actions. Opt-in `retryConnectionReset: true` also makes that same allowance available for a narrowly declared OpenAI connection reset; it adds no separate attempt budget. Optional `overloadFallback` permits one one-way model hop only after an ordinary nonzero generation exit with top-level `ServiceUnavailableError`, service `openai` matching Luna's provider, and a message beginning with `server_is_overloaded:` after leading whitespace. This is a declared code, not proof of backend capacity. Generic 503 errors, other provider errors, invalid formatting, cancellation, expired deadlines and stale state do not trigger a model hop. Correction and fallback require an attempt recorder and live-state checker; all readiness, recording and generation share the captured identity and original deadline. Recorder failure stops the decision.

The simulator enables reset recovery with `--retry-connection-reset --model-attempts 2`. It recognizes only an ordinary nonzero CLI exit carrying a top-level OpenAI `ServiceUnavailableError` with the retained leading `ECONNRESET: The socket connection was closed unexpectedly` signature. That identifies declared text, not the underlying wire cause. The failed attempt is recorded, then the unchanged prompt and model may run once more under the original freshness checks and deadline. Reset recovery never triggers a Sonnet hop. Generic 503 errors, authentication failures, malformed responses, cancellation, stale state, expired deadlines and recorder failures remain terminal. `resetRetries` and `resetRecovered` stay separate from format corrections in the journal summary.

Both CLIs default to `--fallback sonnet` with Luna and `none` otherwise. The advisory CLI permits no format correction by default, so a hop allows at most two generations. The simulator defaults to `--model-attempts 2`: one shared correction plus one hop allows at most three generations; `--model-attempts 1` disables correction and allows at most two. No hop retries the overloaded Luna or returns to it. `--fallback none` disables model fallback and stops on policy failure. The simulator's `--fallback deterministic` remains explicit opt-in with its separate fallback budget; it does not enable Sonnet fallback.

### Experimental decision context

The default `--prompt temporal` keeps the current factual prompt. `--prompt baseline` reproduces the older projection without pending attacks or recent events; it does not change model effort. `--prompt card` puts current facts and mechanics before the heuristic shortlist. Card-only `--heuristics raw|banded|hidden` compares raw scores, ordinal bands (default), or no own shortlist. Every variant preserves the exact enabled legal IDs and the usual action validation.

The Card projects existing evidence; it does not calculate unique roles, certify setup-sweep containment, count no-progress loops or invent missing provenance. Those capabilities are explicitly unavailable. Posterior summaries remain inferred, null damage stays unknown, and supplied delayed-attack timing is preserved. No strategic improvement is established yet.

The projection bounds ancestry and posterior detail, stores active state once, and omits the optional opponent-prediction counterattack matrix with an explicit omission marker. Primary damage, switch-entry threat and delayed-attack forecasts remain present. Omitted detail cannot establish safety; the original decision envelope remains the complete record. Oversized requests still fail against the existing limit.

A separate shadow task produces a bounded, non-executable plan:

```sh
npm run battle-agent:decide -- --task plan --input /tmp/battle-frame.txt --output /tmp/shadow-plan.json
npm run battle-agent:decide -- --prompt card-ledger --input /tmp/battle-frame.txt --ledger /tmp/shadow-plan.json
```

`--ledger` consumes the complete shadow result from the first command. The host supplies its bindings and at most 120-second lifetime; model text cannot supply bindings, expiry or actions. The plan is limited to 4,000 UTF-8 bytes including host metadata. Any different canonical identity, result hash, side, engine or history revision makes it unusable. It must remain valid through the entire action deadline; otherwise the Card omits it and the journal reports its actual disposition. Invalid plan JSON/schema, stale bindings and failed refreshes never become actions.

Planning is explicitly invoked and uses one generation with no correction or fallback. Action decisions never refresh plans automatically. The simulator supports baseline/temporal/card only and rejects card-ledger: cross-turn plan reuse, automatic trigger refresh, Metamon advice and training-label promotion are not implemented in this experiment.

Plan evidence strings and citations are model assertions; the host does not resolve their references or validate the strategy. Passing schema, size and freshness checks does not make a plan fact-checked or an accepted training label.

From the repository root:

```bash
npm run battle-agent:decide -- --model luna --deadline-ms 60000
npm run battle-agent:sim -- --p1 deterministic --p2 random --seed 1,2,3,4 --output /tmp/shwdn2op-match
```

The advisory CLI ingests a room-routed protocol fixture (`--input FILE`) and never dispatches. The simulator uses the pinned official `pokemon-showdown@0.11.11` server simulator (MIT), validates imported teams with the same rules used by battle/checkpoint restoration and runs Gen 9 singles without a browser or public server. Each side has a separate engine and ephemeral history; only public protocol and that side's private requests reach its policy. Simulator requests receive local per-side monotonic rqids because the server wrapper is absent. The result records producer/simulator versions, seed, decisions, latency, rejections and explicit fallbacks. `completed`, `truncated` and `failed` are separate outcomes; truncated games are not wins or draws. Simulator output is local evidence, not a live-browser or strong-play certificate.

Both CLIs handle Ctrl-C and SIGTERM by cancelling pending decisions and cleaning up local OpenCode processes. They write cancellation results and exit with 130 or 143 respectively. A cancelled simulator run reports `truncated` with `stopReason: "cancelled"`; cancellation never starts a fallback. Local process cleanup is tested on macOS; upstream generation cancellation remains unproved.

Use `--progress` on the simulator to stream accepted decisions with turn, side, request ID and latency to stderr while it runs. Final artifacts retain the exact choices separately.

OpenCode simulator runs write `model-replies.jsonl` with every actual generation attempt and its outcome. Every attempt records its actual model descriptor, configured model and kind: initial, format correction or capacity fallback. The summary counts accepted, rejected and failed replies, accepted format corrections, capacity hops and fallback acceptances separately; a second attempt is not necessarily a correction. The advisory result retains the same safe attempt metadata. An accepted reply has passed adapter validation; final freshness checks and simulator acceptance remain separate. With `--trace`, rejected model text and nonzero-exit response stdout are captured only in this private journal, capped at 65,536 characters each with original length and truncation flags. Without `--trace`, neither is retained. The journal, replay inputs and private protocol traces are created with owner-only permissions. Errors and progress output contain fixed failure categories rather than raw responses. Recognized structured service-error tags carry their declared route status; this is distinct from directly observing an HTTP status. Unknown responses retain the generic exit diagnostic. Only the exact declared-overload case above permits a model hop; other transport failures stop the decision.

The optional `metamon` policy launches one pinned Kakuna worker per side, using `--metamon-command` and a literal JSON array in `--metamon-args`. It requires six-member teams and explicit `--format gen9ou` or `--format gen9uu`; omitting the format is rejected even though other policies default to UU. The actual room tag must match the selected format. The worker uses upstream observations, recurrence and action conversion; team preview uses upstream random selection, not the network. It receives only its player's routed protocol, after canonical ingestion, and every returned choice must match exactly one canonical action. Observation failure stops the match rather than starting a fallback from an unsynchronized state. The runner bounds observations and closes recurrent workers on completion, failure or cancellation. Runtime installation, GPU qualification and completed match artifacts establish separate checks; none alone certifies gameplay strength.

Worker contract `metamon-worker@2` separates `propose` from `commit`. Repeated
identical decisions reuse a cached sample. After executor acceptance and before
later observations, the simulator commits the actual legal action using the
inverse mapping saved at the original observation. An override therefore replaces
the proposed previous-action representation without another neural forward or RNG
draw. Uncommitted, stale, ambiguous or invalid transitions close the worker.
Preview commits retain the actual party order without a neural timestep. The host
and deployed worker must use the same protocol; an older worker is rejected.
These boundaries require separate GPU parity qualification before hybrid trials;
source/mock tests do not transfer earlier worker qualification automatically.

Our worker wrappers (MLX, native Windows, the evaluation trace) add one optional
propose-reply field, `actionProbabilities` (`scripts/metamon_port/action_probs.py`):
the legal-only conditional of the stored distribution the worker samples and redraws
from, keyed by choice token. The transport re-keys it by canonical action and rejects
a malformed one; replies without it (the plain pinned worker) are unchanged.
`battle-agent/tacticalGuards.ts` computes red (re-rankable engine fact) and amber
(warning) guards from the envelope, and `battle-agent/rerank.ts` the re-ranker
`metamon-rerank@2` (`src/battle-agent/rerank.ts`): no mass for a rules-certain
failure, tactical flags capped jointly at τ, with a seed-keyed pick maximally coupled to
Metamon's own. The live advisor runs it in shadow only: the advice stays Metamon's raw
pick, carries the guards and a differing re-ranked pick, and the journal keeps raw p,
p', both picks and the guards per decision.

For an opt-in hybrid arm, select a Luna/Sonnet player and add
`--metamon-advice p1`, `p2` or `both`, alongside the explicit Metamon launcher and
format. Each advised player gets its own actor-side worker, separate from any
Metamon opponent. The default remains model-only. One cached opinion is shown on
supported non-preview decisions with at least two enabled actions; it carries an
exact request/result binding and no invented confidence or rationale. The model
can override it. Preview and singleton opinions stay hidden while the accepted
action still advances recurrent history. Advice is outside canonical facts and
posteriors, and model retries reuse the same opinion.

The advice wait is at most five seconds inside the original decision deadline;
it does not reset the model budget. A failed or slow advisor is retired for the
rest of that match and the model continues without advice. The game remains in
the hybrid arm. A failed journal or stale decision stops execution. The private
`metamon-advice.jsonl` records eligibility, availability and actual commits;
`model-replies.jsonl` binds each generation to the opinion actually supplied.
Summary overrides count only displayed advice, excluding hidden preview orders.
Source/mock and scripted simulator checks do not establish actual hybrid playing
strength, full runtime parity or acceptance of a large benchmark.

Gen 9 UU is **experimental/out_of_distribution**, not trained UU support. The CLI summary records `metamon.formatQualification` as `experimental_out_of_distribution` for UU or `gen9ou_baseline` for OU, with explanatory `metamon.notes`. Genuine UU parser/tokenizer/action checks and a bounded teacher-forced recurrent prefix passed using unchanged Kakuna epoch34 weights and the same 13-action contract. The literal `<gen9uu>` token is out of vocabulary and maps to unknown embedding row 0; no OU alias or token/rule/mask/index rewrite is used. Those checks do not qualify a completed UU model game, full terminal/replay/cancellation lifecycle, long-context UU recurrence or strength. Deployment and full runtime qualification remain separate from source and mock-worker tests.

Official Metamon masks illegal logits, then clips probabilities to `[0.001, 0.99]` and renormalizes, deliberately restoring small illegal-action probability mass. The worker still rejects a sampled illegal action; it never resamples or substitutes an action. Use `--fallback none` for runs that must stop on any policy rejection. Deterministic fallback occurs only with explicit `--fallback deterministic` and is logged.

Set up the model on a Linux or WSL host with Python 3.12, Git and a compatible NVIDIA driver. Run from the repository root, keeping the environment, weights and receipts outside the synced checkout:

```bash
python3.12 scripts/metamon-runtime.py bootstrap --root /absolute/runtime --venv /absolute/venv
/absolute/venv/bin/python scripts/metamon-runtime.py smoke --root /absolute/runtime --venv /absolute/venv
```

The helper rejects runtime/environment paths inside the project or a detected Syncthing folder, then installs the pinned lock and selected checkpoint. The GPU smoke tests the official Flex96 backend; it does not certify gameplay strength. Launch the worker with `METAMON_CACHE_DIR=/absolute/runtime/cache`, `PYTHONPATH=/absolute/runtime/source`, the checkpoint path from `setup.json`, and `--attention-backend flex`. Its JSON-lines transport is full duplex, with one request followed by one reply. Closing stdin during a pending request cancels the worker's private process group; closing after a reply exits normally. Native Windows model execution is unsupported; use WSL.

Keep the synced project below 5 GB. Source, small synthetic fixtures and selected compact datasets belong here. Model weights, Python environments, upstream source checkouts and download/compiler caches belong in a device-local runtime outside the synced tree. Each model host can reproduce its runtime from the pinned bootstrap inputs; the helper verifies the selected checkpoint's size and SHA-256. Weights do not need Git LFS or another artifact service.

Keep bulk private capture and match evidence outside the checkout. For datasets worth sharing between devices, retain finalized compressed batches and a small manifest rather than thousands of per-turn files. Existing private data remains separate from the publication surface. Git ignores control publication; Syncthing exclusions come from the sync folder's own rules, not `.gitignore` or an unreferenced nested `.stignore`.

## Why a local daemon

The extension should not shell out to local CLIs directly. A local daemon makes it easier to:

- keep provider logic outside the browser sandbox
- swap providers/models
- add logging, tests, and health checks
- attach MCP tooling consistently
- persist local replay logs safely in the local workspace when the extension asks for it

## Run

```bash
npm run companion:dev
```


### Explicit offline monthly move priors

`battle-agent-sim --move-priors /absolute/unsynced/descriptor.json` opts in to
cold-start move coverage. Default is off. Human inspection uses the same saved canonical JSON view
passed to battle-agent; no model call is needed for deterministic/random games.
The descriptor (at most16KiB) is:

```json
{"version":1,"source":{"url":"https://www.smogon.com/stats/2026-09/chaos/gen9uu-1760.json","period":"2026-09","formatId":"gen9uu","ratingCutoff":1760,"sha256":"REPLACE_WITH_THE_EXACT_64_HEX_RAW_FILE_SHA256"},"rawFile":"gen9uu-1760.json"}
```

Cache descriptor and raw JSON outside the project in an explicitly unsynced
location, or under the project's device-local `tmp/` (gitignored; Syncthing
ignores `proj/*/tmp`), e.g. `tmp/meta-priors/`. Any other project path is refused. The descriptor path must be absolute; relative rawFile paths resolve
beside the descriptor. Only regular files are accepted, checked on nonblocking
opened file descriptors before reading. Symlink-resolved
project aliases are rejected. Arbitrary sync roots cannot be inferred. The CLI
uses bounded file-descriptor reads, verifies SHA/metadata once before policy
construction, and never fetches or refreshes during evaluation. Raw limit is5MB.
Period binds the declared source URL; format/cutoff also match raw metadata.
The raw file has no month field. There is no automatic current/older-month
selection. A bad file fails loudly.

Moves are weighted **set-inclusion prevalence**, not next-action probabilities,
local observations, confidence samples or joint sets. The denominator is the
sum of ability weights (one per set), not the sum of move weights. The same
species mass turns the Items, Abilities and Tera Types weights into usage shares
(`sets`, with Smogon's species Raw count). These are appended to `likelyItems`,
`likelyAbilities` and `likelyTeraTypes` after the observed/curated entries, tagged
`source: "monthly_ladder"` with `count: 0`, so they never read as owner history.
Spreads and posterior priors are not imported.
Empty move-slot keys are ignored. Revealed moves take precedence, followed by
admitted history/curated hypotheses; monthly candidates fill remaining unrevealed
slots, even after a setup move is revealed. Names are deduplicated and the combined
list is capped at four. The 0.45 inclusion threshold is a candidate-admission
heuristic, not probability calibration. All four revealed moves suppress monthly
fill. Format/species misses stay explicit. Shared `opponentThreatCoverage` names
considered, omitted and uncomputed moves; an empty table does not establish safety.
Damage bands are conditional on supported assumptions, not exhaustive upper bounds.

Both players receive the same detached normalized prior through separate memory
contexts. Its revision participates in the existing context/result hashes.
`replay-inputs.json` retains the entire normalized dataset and declared source
provenance, so `runBattleMatch({...replayInputs,p1,p2})` needs no original file or
network. Normalized revision validation binds declared metadata and derived
content only: it cannot reverify the discarded raw bytes or authenticate remote
origin. Even raw SHA validation proves agreement with a caller's descriptor,
not that the file came from Smogon. OpenCode receives only current opponents'
candidate/provenance views, without rawFile/private paths or the full dataset.
Observed-history and curated-team counts/files remain separate and unchanged.


The normal companion can explicitly opt in at startup with
`MOVE_PRIOR_DESCRIPTOR=/absolute/unsynced/descriptor.json`. Default is off; no
owner environment file is changed automatically. The same validated loader runs
once before the server is ready. Invalid configured input fails startup. Later
file changes have no effect until an explicit restart; there is no request-time
fetch, month selection or silent fallback.

Only canonical `/v1` observations/evaluation contexts receive this prior. Its
normalized revision binds the history view and result hash; legal identities
and observed/curated evidence remain separate. The overlay shows each
opponent's monthly source period, format, rating cutoff and set-inclusion
coverage from the same returned JSON used by battle-agent. Private cache paths
and the full dataset are not exposed. Legacy-untrusted `/api` provider contexts
remain prior-free; this adds no OpenCode provider or browser actuation.

Startup and pure evaluation add no history writes. Existing canonical fact
commits and explicit shown-prediction feedback keep their existing behavior;
feedback can record a different predicted label when advice changes. Monthly
priors never become observed move counts or curated team records.


The development opponent bank is [gen9uu-opponent-bank.txt](../../examples/gen9uu-opponent-bank.txt), prepared 2026-10-19. UU01 and UU02 adapt published [hazard offense](https://pokepast.es/0bb00b8250bd419e) and [Veil offense](https://pokepast.es/e01f28a75cca78db): banned Tera Blast is replaced with Dark Pulse and Thundurus-T's Tera changes to Steel; UU02 also replaces banned Manaphy with Azumarill. UU03 [sand](https://pokepast.es/43a6473e72a3cf85) and UU04 [offense](https://pokepast.es/e2d1197e9b48a4cb) retain published imports. UU05 is an authored pivot balance; UU06 is an authored semi-stall inspired by [a published structure](https://pokepast.es/55c22dd5761401dd). These are representative challenges, not measured most-common teams or validated training labels. The unchanged home team remains separate. Revalidate all imports after any simulator update; record the exact runtime/data producer with results, because rules and native checkpoints are version-specific.
