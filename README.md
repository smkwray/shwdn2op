<h1>
  <img src="logo.png" alt="shwdn2op logo" width="56" />
  shwdn2op
</h1>

**shwdn2op** (Showdown second opinion) is a local advisor for Pokémon Showdown Gen 9 UU (the UnderUsed tier). A Chromium Manifest V3 (MV3) extension
streams the battle to a local companion. Under Showdown's own controls, the companion shows the pick of a Metamon
policy (Kakuna, epoch 34), together with deterministic damage, speed, threat and likely-set notes. It is advisory only:
it never clicks, sends a choice, ladders or plays for you. A separate **battle-agent** can play local simulated matches
through validated actions.

## What it does today

During a Pokémon Showdown battle the extension forwards ordered protocol observations and private requests to the local companion. The companion reduces the canonical state, enumerates actions and builds a deterministic read: hidden-set hypotheses, speed relationships, damage ranges and scored candidate actions. A versioned decision envelope binds those results to the room, request, state revision and hashes. The extension renders that same result, rejecting responses for an older decision. See the [deterministic API contract](apps/companion/README.md).

In battle, the extension annotates Showdown's own move and switch buttons (no overlay):

- **Metamon's pick** — the model's most probable action with its probability, a close runner-up, and its best
  action of the other kind (a switch beside a move pick, a move beside a switch pick)
- **Warnings** — one short line each (full fact in the tooltip) for likely mistakes; warnings never change the pick
- **Speed, damage and threats** — the engine's move order, damage bands (hover a move for its band against every
  opposing Pokémon seen so far) and the opponent's threatening replies
- **Likely set** — the opponent's revealed facts plus likely items, abilities, Tera and moves from your locally
  accumulated battle history and monthly ladder usage
- **Usual lead** — at team preview, a lead model's usual lead for your team

Each section shows as soon as it is ready, and every unavailable state says why. The main path uses text protocol and
private requests. Legacy and Preact page adapters supply recovery data and active-room hints. Screenshots and browser
automation are not runtime dependencies.

## Gen 9 UU model advisor

- **Model.** The companion runs [Metamon](https://github.com/UT-Austin-RPL/metamon)'s Kakuna checkpoint (epoch 34,
  unchanged weights) through a pinned worker. The worker uses the project's MIT fork in `vendor/metamon`.
  - Gen 9 UU is out of distribution for Kakuna. Its format token is unknown to the tokenizer.
  - The worker samples from Metamon's own action distribution. The deterministic layer never replaces the pick.
  - A shadow re-ranker logs where rules-certain failures would be avoided, but it does not change the advice.
  - Short warnings flag likely mistakes.
- **Lead suggestion.** At team preview, a separate lead model shows the *usual* lead ("Usual lead: X (NN%)").
- **Self-play and fine-tuning.** `scripts/uu_selfplay` produces self-play data in Metamon's replay format, freezes it into
  hash-manifested piles, and fine-tunes candidates. A candidate replaces the live model only after it passes the
  certification described under Evaluation. None has.

## Safety boundaries

- The browser extension is advisory; you submit its recommendations manually
- The separately authorized battle-agent executor currently targets offline simulations; no live autonomous ladder operation is enabled
- No screenshot-first or browser-control-first architecture
- Hidden information (unrevealed sets, opponent team preview choices) is surfaced as assumptions, never presented as known

If you play in events with anti-ghosting rules, do not use live advice tools during those events.

## Supported providers

| Provider | CLI | Default model |
|----------|-----|---------------|
| `codex` (default) | `codex` | `gpt-5.4-mini` |
| `claude` | `claude` | `sonnet` |
| `gemini` | `gemini` | `gemini-3-flash-preview` |
| `mock` | — | — |

These providers back the companion's legacy `/api/analyze` endpoint; the extension's Metamon-only UI no longer calls
them. Each provider calls the corresponding local CLI. You need that CLI installed and authenticated separately. `mock` returns a canned response with no external calls and is the easiest way to smoke-test the provider path before trying a real provider.

## OpenCode battle-agent and offline matches

The separate battle-agent uses the same canonical state, deterministic analysis and exact legal actions. It supports configured OpenCode models: **GPT-6 Luna** (`openai/gpt-6-luna#xhigh`) and **Sonnet 5.5** (`anthropic/claude-sonnet-5-5#high`). It uses OpenCode v2 stateless generation with no model tools. The prompt includes canonical pending attacks and recent events as observations, with current state and legality taking precedence; this is not persistent plan memory. Invalid JSON, stale identities and unavailable actions are rejected.

Request an advisory decision without submitting a move:

```bash
npm run battle-agent:decide -- --model luna
npm run battle-agent:decide -- --model sonnet
```

Run a seeded local Gen 9 UU match against a random policy, or explicitly select two models:

```bash
npm run battle-agent:sim -- --output /tmp/shwdn2op-local-match
npm run battle-agent:sim -- --p1 sonnet --p2 luna --max-turns 100 --output /tmp/shwdn2op-model-match
```

The default matchup makes no model calls. Model matchups use your existing OpenCode authentication and provider usage. Matches isolate each player's private requests and use ephemeral history. The simulator permits one correction for rejected JSON, schema or action selection by default. With Luna, `--fallback sonnet` is the default: one one-way hop is allowed only after a nonzero Luna CLI exit declares OpenAI's `server_is_overloaded:` code. Generic 503 errors, invalid formatting and cancellation do not trigger that hop. One shared correction plus one hop allows at most three generations with `--model-attempts 2`, or two with `--model-attempts 1`, all within the original deadline and current identity. `--fallback none` disables the hop and stops on policy failure; `--fallback deterministic` explicitly selects the separate deterministic fallback instead. Reports attribute each attempt to its actual model and count corrections and capacity hops separately. `--help` lists teams, seeds, deadlines and output options. Team legality is checked against the pinned simulator rules; this is not a current live-validator certificate.

For prompt experiments, `--prompt baseline|temporal|card` keeps model effort independent from context. Card mode supports `--heuristics raw|banded|hidden` and places current evidence before its optional shortlist. The advisory CLI also offers an explicitly invoked `--task plan` shadow task and exact-request `card-ledger` comparison. Plans cannot execute actions or carry across turns; these experimental modes have no demonstrated strength benefit. See the [companion context contract](apps/companion/README.md#experimental-decision-context).

Completed model games used low effort. Eight isolated Luna xhigh decisions passed; Sonnet high and overload fallback have mock coverage, not completed-game qualification. These checks do not establish playing strength.

Local deadlines bound returned decisions; OpenCode's stateless endpoint does not establish upstream request cancellation. Its text output is prompt-constrained and locally validated, so a model may fail a decision. See the [companion contract](apps/companion/README.md) for the Metamon runtime and match interfaces.

Model weights and runtime caches stay outside the checkout. Keep shared datasets compact and use small synthetic test fixtures.

## Quick start

### Requirements

- Node 22.18+
- A supported CLI only if you want optional model analysis; deterministic evaluation runs locally without one

### Install dependencies

```bash
npm install
```

### Start the companion

```bash
npm run companion:dev
```

The companion listens on `http://127.0.0.1:6127` by default. For the Metamon advisor, start it with
`zsh scripts/start_companion.sh LAUNCH_JSON`; without a launch file, only the deterministic notes are shown. The script
logs to `tmp/`, which a fresh clone lacks, so run `mkdir -p tmp` first. `LAUNCH_JSON` describes your local worker
runtime. Its schema is `launchSchema` in
[`apps/companion/src/battle-agent/liveMetamon.ts`](apps/companion/src/battle-agent/liveMetamon.ts); `args` must contain
`{seed}`. For example (the paths are placeholders for your own runtime and checkpoint):

```json
{
  "command": "tmp/metamon-port/.venv/bin/python",
  "args": ["scripts/metamon-worker.py", "--checkpoint", "PATH/TO/kakuna_epoch_34.pt", "--seed", "{seed}", "--seed-per-side"],
  "workerSha256": "SHA-256 OF scripts/metamon-worker.py",
  "maxWorkers": 1
}
```

The runtime itself (Python, Metamon and the Kakuna weights) is not in this repository: see
[`vendor/metamon/README.md`](vendor/metamon/README.md) and [Metamon](https://github.com/UT-Austin-RPL/metamon).

### Load the extension

1. Open `vivaldi://extensions` or `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `apps/extension` directory

### Try it on Showdown

1. Open [Pokémon Showdown](https://play.pokemonshowdown.com/)
2. Start or join a battle
3. Open the extension popup and confirm the companion is reachable; the toggle turns the inline advice on or off
4. The pick and notes appear under Showdown's move and switch buttons on each of your turns

If the companion is unreachable, the inline notes say so instead of showing stale advice.

## Testing with mock

The `mock` smoke calls the mock provider directly, with no browser, extension or HTTP server, and no external CLI:

```bash
npm run smoke:mock
```

This sends a bundled Gen 9 OU example snapshot through the mock provider and prints the analysis result.

Smoke tests for real providers work the same way:

```bash
npm run smoke:codex
npm run smoke:claude
npm run smoke:gemini
```

## Pokémon MCP server

`apps/pokemon-mcp` is an optional local [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes Pokémon data (type effectiveness, move lookups, common sets) as MCP tools. When enabled, model providers that support MCP can call back into it for structured dex queries instead of relying on the model's parametric knowledge.

```bash
npm run mcp:serve
```

## Evaluation

### Replay imitation metrics (deterministic recommender)

`npm run replay:extract` and `npm run replay:eval` score the deterministic recommender against actions taken in saved
replays. They report top-1/top-3 accuracy, mean reciprocal rank (MRR), and accuracy by action kind. This measures agreement with replay
actions, not playing strength. Outputs go to the gitignored `ml-artifacts/`.

### Model strength: paired-slot evaluation

**Current status:** the live advisor runs Kakuna epoch 34. **No fine-tuned model or re-ranker has been shown to play
Gen 9 UU better than it.** The only held-out test run so far failed. New certification is on hold until
every component listed below has qualified. Nothing in this repository is a strength claim.

**Design** (`scripts/uu_eval`).
- **Arms.** Each comparison plays two arms on identical slots:
  - B0 is Kakuna e34 against Kakuna e34;
  - B1 changes only the home seat, to the candidate.
- **Slots.** A slot fixes the home team family, the opponent family (a ring offset), the seat, and a native simulator
  seed vector.
- **Teams.** Families are human-derived rosters, and each family is represented by one team.
- **What is frozen.** The spec, the producer source, the runtime and the team hashes are frozen before any game runs.
  Every game is re-verified by an official recorded-choice replay. Verification uses no model.
- **Failed games.**
  - Crashes, deadlines and turn caps are *censored*. They never count as draws or wins, and they are never retried or
    replaced.
  - An incomplete pair drops out of the paired estimate. The pair is still listed.

**Inference.**
- **Unit of analysis.** Home-family means of the paired terminal score difference (B1 − B0), with equal family weights.
- **Interval.** A deterministic 10,000-draw family-cluster bootstrap gives a 95% percentile interval. All slots of a
  family stay together.
- **Sign-flip test.** For the terminal score it is exact at any number of families, because family means are exact
  rationals. For the secondary material metrics it is exact up to 16 families and seeded Monte Carlo above that.
- **Opponent dependence.** Opponent families recur across clusters, so these intervals are conditional on the fixed dev
  panel. They are not population estimates.
- **Qualification runs.** These are 8-game pipeline checks. They cannot support any claim.

**Certification campaign** (on hold).
- **Retired entry point.** Certification entry through the dev evaluator is retired. `evaluate.py prepare` now refuses
  anything except a `--qualification` run.
- **What replaces it.** A future strength claim must pass a single-controller campaign:
  - **Fresh panels.** Fresh team-family blocks from both rosters; families used historically are excluded.
  - **Reservation.** One dev and one held-out reservation per candidate, where the candidate is identified by its
    *typed tensor identity*: names, dtypes, shapes and values, independent of file name or serialization. This means a
    re-saved or renamed checkpoint cannot reset its budget. There are no refunds or replacements.
  - **Alpha spending.** The global held-out level is α = 0.05, spent as α_k = 0.05 / (k(k+1)) at the k-th held-out
    attempt (`scripts/uu_eval/campaign.py`).
  - **Inference.** A fixed-N exact betting e-value mixture with a lower confidence bound (`campaign_inference.py`). It
    is a fixed-sample test, not an optional-stopping guarantee.
  - **Power.** Design power must be checked by simulation before any run (`campaign_power.py`).
- **Boundary of the campaign code.** `campaign.py` implements the typed tensor identity, but `reserve` records the
  binding hashes it is given; it does not recompute them from a checkpoint. It also does not enforce dev success before
  a held-out reservation. Both belong to the qualified controller, which is not built yet. The 0.05 budget covers the
  held-out reservations in this prospective campaign's new ledger; historical tests imported into the ledger are not
  charged against it.
- **Still open.** Before any campaign is admitted, these must be frozen and qualified:
  - the canonical ledger writer;
  - fresh family blocks;
  - the native inference qualification;
  - the actual-design power check.

**Internal progress screens** (`scripts/uu_selfplay/progress_eval.py`). These select training candidates only; they are
never certification, because they reuse training-reserved families adaptively.
- **Registered design.** A selection screen plays 960 games: 24 progress families × 10 repetitions × 2 seats × 2 arms
  (`progress_panel.py` with its default 24 families, and `batch_collect.py --purpose progress
  --progress-repetitions 10`). The default of one repetition gives a 96-game pipeline check, not a selection screen.
- **What the helper checks.** `progress_eval.py` checks completeness against the plan it is given, not against N = 960,
  so a smaller plan can still trigger. A consumer that selects a candidate must check the registered design itself.
- **Pass rule.** A screen passes only if two conditions hold:
  - the candidate scores at least 0.60;
  - the paired bootstrap lower bound exceeds +0.05.
- **Censoring.**
  - Only deadline censoring is allowed, up to 2% of games.
  - Censored games are re-scored pessimistically (a loss for the candidate, a win for the baseline), and the screen must
    pass that way too.
  - Any other error or missing game fails the screen.

## Privacy and publishing

Private and device-local material is gitignored: `do/`, `tmp/`, `.local-data/`, `config/local/`, model weights, and
agent-local directories. Before a commit, the hooks in `.githooks/` run two checks:
- `scripts/hygiene_check.sh --staged`;
- `python3 scripts/privacy_gate.py --require-private --cached`. This needs a local, gitignored `.private-denylist`.

Before a push, scan exactly the objects being pushed (`<remote>/main..<branch>`) for denylist terms, home and cloud
paths, and secrets, and run the test suites (`npm test`, and `python3 -m unittest` in `scripts/uu_eval`). This
repository ships no continuous-integration (CI) workflow; the recommended CI command is
`python3 scripts/privacy_gate.py --public-ci`.

## Project structure

```
apps/
  extension/        Chromium MV3 extension (unpacked)
  companion/        Local Fastify server + provider adapters + deterministic analysis
  pokemon-mcp/      Optional MCP server for Pokémon data
packages/
  schemas/          Shared JSON schemas (BattleSnapshot, AnalysisResult)
examples/           Sample snapshots and raw protocol frames
scripts/            Live operations, browser checks, replay extraction, uu_selfplay, uu_eval
vendor/metamon/     MIT fork of Metamon used by the model worker
```

## Schemas

- `packages/schemas/battle-snapshot.schema.json` — the structured turn snapshot sent from extension to companion
- `packages/schemas/analysis-result.schema.json` — the ranked-action response returned by providers

## Configuration

The companion reads environment variables for overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPANION_HOST` | `127.0.0.1` | Bind address |
| `COMPANION_PORT` | `6127` | Listen port |
| `DEFAULT_PROVIDER` | `codex` | Default provider if none specified |
| `DEFAULT_CODEX_MODEL` | `gpt-5.4-mini` | Codex model |
| `DEFAULT_CLAUDE_MODEL` | `sonnet` | Claude model |
| `DEFAULT_GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini model |
| `CODEX_BIN` | `codex` | Path to Codex CLI binary |
| `CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `GEMINI_BIN` | `gemini` | Path to Gemini CLI binary |

## Current limitations

- **No certified model.** Kakuna epoch 34 is the live model, and Gen 9 UU is outside its training distribution. No
  fine-tuned candidate has been shown to beat it, and the certification campaign is on hold (see Evaluation).
- **Heuristic notes.** Candidate scores, warnings and confidence tiers are heuristics, not calibrated win probabilities.
- **Withheld advice.** Ambiguous identities and unsupported recovery or mechanics states withhold advice with a stated
  reason.
- **Singles only.** Gen 9 singles is the only action contract. Doubles and multi report an explicit unsupported
  capability.
- **Hardware.** The model worker needs a local GPU or an Apple-silicon MLX runtime. Weights are not distributed in this
  repository: `vendor/metamon/assemble.py` builds a runtime from an upstream Metamon checkout.
- **MCP coverage.** The MCP server covers a starter subset of dex data.
- **Browsers.** Only Chrome-family browsers are tested.

## License

MIT — see [LICENSE](LICENSE).

The project is original-code-first and avoids copying code from AGPL-licensed extensions like Showdex.
