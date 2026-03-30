# Extension

This is a plain Chromium MV3 unpacked extension.

Why plain JS?

- no build step required to load it
- easiest way to get an unpacked extension running in Vivaldi quickly
- easiest handoff to Codex for iterative development

## Files

- `manifest.json` – MV3 manifest
- `background.js` – service worker, state store, companion calls
- `content-bridge.js` – content script bridge + in-page overlay
- `page-hook.js` – injected main-world hook for WebSocket traffic
- `popup.*` – settings, panel toggles, and manual Ask a Friend UI
- `lib/showdown-parser.js` – deterministic battle-state reducer
- `lib/storage.js` – settings persistence

## Load in browser

1. open `vivaldi://extensions` or `chrome://extensions`
2. enable **Developer mode**
3. click **Load unpacked**
4. pick this folder

## Dev notes

The page hook is intentionally tiny. Keep battle logic in `background.js` + `lib/showdown-parser.js`, not in the page hook.
