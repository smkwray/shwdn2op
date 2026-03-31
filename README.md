<h1>
  <img src="logo.png" alt="shwdn2op logo" width="56" />
  shwdn2op
</h1>

**shwdn2op** — Showdown second opinion. A local tool for Pokémon Showdown that reads the live battle state, tracks likely hidden information from your local history, estimates speed and damage, and surfaces a structured recommendation. You make the final call — it never clicks, submits, or plays for you.

## What it does today

During a Pokémon Showdown battle the extension captures a structured snapshot of the current turn — teams, HP, boosts, field conditions, legal actions, and recent log — and sends it to the local companion daemon. The companion builds a deterministic read of the position first: likely opposing sets and team tendencies from stored local history, estimated speed relationships, damage ranges, type-based interactions, known move tracking, and hidden-info assumptions. That deterministic layer is the foundation of the recommendation system.

The extension currently surfaces:

- **Local Intel** — likely item, ability, Tera, move, and set patterns inferred from reveals plus your locally accumulated battle history
- **Line to Respect** — the opponent-side action or punish line you most need to account for from the current board and inferred hidden info
- **Best Line** — your-side recommended action based on deterministic battle-state analysis of the current position
- **Damage Matrix** and **Mechanics** — damage estimates, speed context, and other structured matchup details
- A debug panel for raw snapshot inspection
- **Ask a Friend** — optional one-shot model analysis layered on top of the deterministic snapshot and local intel

The main path is text-first. Battle state is extracted from the Showdown page DOM and protocol messages, not from screenshots or browser automation.

## Safety boundaries

- Advisory only — all recommendations require you to act on them manually
- No auto-clicking, no move submission, no unattended play
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

Each provider calls the corresponding local CLI. You need that CLI installed and authenticated separately. `mock` returns a canned response with no external calls and is the easiest way to smoke-test the full pipeline before trying a real provider.

## Quick start

### Requirements

- Node 20+
- One or more supported CLIs installed locally (`codex`, `claude`, or `gemini`)

### Install dependencies

```bash
npm install
```

### Start the companion

```bash
npm run companion:dev
```

The companion listens on `http://127.0.0.1:6127` by default.

### Load the extension

1. Open `vivaldi://extensions` or `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `apps/extension` directory

### Try it on Showdown

1. Open [Pokémon Showdown](https://play.pokemonshowdown.com/)
2. Start or join a battle
3. Open the extension popup
4. Confirm the **Companion URL** is `http://127.0.0.1:6127`
5. Confirm the popup says **Companion: reachable** before you start relying on the overlay or **Ask a Friend**
6. Select a provider — use `mock` for a safe smoke test, or `codex` for the real default path
7. Click **Ask a Friend**

If the popup says `unreachable`, the local companion daemon is not answering on `http://127.0.0.1:6127` and battle snapshots will not analyze correctly.

The popup reports the current room status once the companion is reachable:

| Status | Meaning |
|--------|---------|
| `ready` | Snapshot captured, analysis should work |
| `waiting` | Not your turn yet |
| `ambiguous` | Multiple battle tabs open — focus the one you want |
| `stale` | No recent battle traffic; wait for the next turn |

**Keyboard shortcut:** `Alt+Shift+S` toggles the in-page overlay panels.

## Testing with mock

The `mock` provider exercises the full path from extension through companion without calling any external CLI:

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

## Replay extraction and eval

`shwdn2op` includes offline tooling for extracting labeled examples from saved Showdown replay logs and evaluating the deterministic recommender against them.

### Extract examples from replays

```bash
npm run replay:extract
```

Reads replay logs from `replays/`, extracts per-turn decision examples with the action the player actually chose as the label, and writes JSONL output under `ml-artifacts/`.

### Evaluate the recommender

```bash
npm run replay:eval
```

Scores the deterministic recommender's top-1 and top-3 accuracy, MRR, and action-kind breakdowns against extracted examples. This is imitation-style offline eval against replay actions, not a solved best-play benchmark.

Generated outputs go to `ml-artifacts/` and are gitignored.

## Publishing from the main folder

The repo is set up so you can publish directly from the main folder instead of maintaining a separate release-staging tree.

Local-only and internal material is meant to stay out via `.gitignore`, especially:

- `do/`
- `docs/`
- `replays/`
- `ml-artifacts/`
- `.env`, `.mcp.json`, and `.codex/`
- internal prompt and agent notes

Before pushing, the practical check is just:

```bash
npm test --silent
```

## Project structure

```
apps/
  extension/        Chromium MV3 extension (unpacked)
  companion/        Local Fastify server + provider adapters + deterministic analysis
  pokemon-mcp/      Optional MCP server for Pokémon data
packages/
  schemas/          Shared JSON schemas (BattleSnapshot, AnalysisResult)
examples/           Sample snapshots and raw protocol frames
scripts/            Replay extraction, eval, and small local utilities
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

- Protocol coverage is incomplete — some battle formats, edge cases, and multi-battle scenarios may produce partial or missing snapshots
- Deterministic analysis quality varies; the damage calc and threat-assessment layers are still being calibrated
- No learned priors or rerankers yet — the core recommender is still mostly deterministic
- UX is functional but unpolished
- The MCP server covers a starter subset of dex data, not the full Pokédex surface
- Only tested on Vivaldi and Chrome; other Chromium browsers may work but are not verified

## License

MIT — see [LICENSE](LICENSE).

The project is original-code-first and avoids copying code from AGPL-licensed extensions like Showdex.
