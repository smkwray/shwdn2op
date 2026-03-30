# Companion daemon

Local HTTP daemon that accepts a `BattleSnapshot`, calls a provider adapter, and returns a structured `AnalysisResult`.

## Endpoints

- `GET /api/health`
- `POST /api/analyze`
- `POST /api/observe-snapshot`
- `POST /api/save-replay`

## Providers

- `mock`
- `codex`
- `claude`

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
