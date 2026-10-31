#!/bin/zsh
# Dedicated Showdown play browser on this Mac: Chrome for Testing with the unpacked extension and a local DevTools
# port, so agents can set up and verify the page without the per-connection "Allow remote debugging?" prompt that
# guards the everyday Chrome profile. Human-only play: the extension never sends choices.
# Usage: zsh scripts/play_browser.sh   (profile and logs in the device-local tmp/play-browser; port 9333)
# After launch it turns on Developer mode in the profile: without it Chrome 151 DISABLES a command-line-loaded unpacked
# extension on any reload (disable reason 1<<24, seen 2026-10-22). It then checks that the extension's worker runs and
# that the page hook in the Showdown tab is this checkout's version, and fails loudly otherwise. Last, each Showdown tab
# on the home page gets the owner's team (PLAY_TEAM, default examples/gen9uu-scizor-proposal.txt) if missing, with
# Gen 9 UU selected; a tab in a battle is never touched.
set -eu
cd "$(dirname "$0")/.."
BIN=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | sort -V | tail -1)
# The browser loads a frozen deployed copy (scripts/deploy_extension.sh), never the synced working tree apps/extension.
EXT="$PWD/tmp/deployed-extension"
[ -f "$EXT/manifest.json" ] || { echo "no deployed extension at $EXT; run: zsh scripts/deploy_extension.sh local GIT_REF (or after a gate, no ref)"; exit 1; }
[ -x "$BIN" ] || { echo "Chrome for Testing not found (install with: python3 -m playwright install chromium)"; exit 1; }
if curl -s -m 2 http://127.0.0.1:9333/json/version >/dev/null; then echo "play browser already running on 9333"; else
  mkdir -p tmp/play-browser
  nohup "$BIN" --user-data-dir="$PWD/tmp/play-browser/profile" --remote-debugging-port=9333 --remote-allow-origins=http://127.0.0.1:9333 \
    --disable-extensions-except="$EXT" --load-extension="$EXT" \
    --mute-audio --no-first-run --no-default-browser-check --window-size=1600,1000 https://play.pokemonshowdown.com/ \
    >> tmp/play-browser/browser.log 2>&1 < /dev/null &
  for i in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:9333/json/version >/dev/null && break; sleep 1; done
  curl -s -m 2 http://127.0.0.1:9333/json/version >/dev/null || { echo "play browser did not open its DevTools port"; exit 1; }
  echo "play browser up on 9333"
fi
HOOK=$(sed -n 's/.*PAGE_HOOK_VERSION = "\([^"]*\)".*/\1/p' "$EXT/page-hook.js")
# The check needs Playwright, which may be installed for only one of the machine's Pythons.
PY=$(for c in python3 /opt/homebrew/bin/python3 /opt/homebrew/bin/python3.1{4,3,2,1}; do
  "$c" -c 'import playwright' 2>/dev/null && { echo "$c"; break; }; done || true)
[ -n "$PY" ] || { echo "no Python with Playwright found (pip install playwright)"; exit 1; }
"$PY" - "$HOOK" "${PLAY_TEAM:-examples/gen9uu-scizor-proposal.txt}" <<'PY'
import json, re, sys, time, urllib.request
from playwright.sync_api import sync_playwright
want, team_file = sys.argv[1], sys.argv[2]
TEAM = "shwdn2op UU (Scizor)"
info = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json/version", timeout=5))
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(info["webSocketDebuggerUrl"], timeout=30000); ctx = browser.contexts[0]
    page = ctx.new_page()  # our own chrome://extensions tab; the Showdown tab is only read
    try:
        page.goto("chrome://extensions/")
        page.evaluate("() => new Promise(r => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}, r))")
        dev = page.evaluate("() => new Promise(r => chrome.developerPrivate.getProfileConfiguration(c => r(c.inDeveloperMode)))")
        exts = page.evaluate("() => new Promise(r => chrome.developerPrivate.getExtensionsInfo(list => r(list.map(e => ({name: e.name, state: e.state, reasons: e.disableReasons})))))")
    finally:
        page.close()
    ours = [e for e in exts if e["name"] == "shwdn2op"]
    hooks = []
    for _ in range(20):
        hooks = [pg.evaluate("window.__showdownSecondOpinionHookVersion || 'none'") for pg in ctx.pages if pg.url.startswith("https://play.pokemonshowdown.com")]
        if hooks and all(h == want for h in hooks): break
        time.sleep(1)
    print(f"developer mode: {dev}; shwdn2op: {ours}; page hooks: {hooks} (checkout {want})")
    if not dev or not ours or ours[0]["state"] != "ENABLED" or not hooks or any(h != want for h in hooks):
        sys.exit("PLAY BROWSER NOT READY: see the line above (refresh the Showdown tab if its hook is older)")
    text = open(team_file).read()
    for pg in [pg for pg in ctx.pages if pg.url.startswith("https://play.pokemonshowdown.com")]:
        if pg.evaluate("() => location.pathname") != "/": continue  # a battle or other room: never touched
        pg.wait_for_function("() => window.app && window.Storage && Storage.teams", timeout=30000)
        mons = pg.evaluate("""([name, text]) => {
          if (!Storage.teams.some(t => t.name === name)) {
            Storage.teams.unshift({name, format: 'gen9uu', team: Storage.packTeam(Storage.importTeam(text)), folder: '', iconCache: ''});
            Storage.saveTeams();
          }
          return Storage.unpackTeam(Storage.teams.find(t => t.name === name).team).map(m => m.species);
        }""", [TEAM, text])
        pg.click("button.select.formatselect", timeout=10000); pg.click("button[name=selectFormat][value=gen9uu]", timeout=10000)
        pg.wait_for_function("name => document.querySelector('button.teamselect')?.innerText.startsWith(name)", arg=TEAM, timeout=10000)
        print(f"team ready: {TEAM} ({', '.join(mons)}), format gen9uu")
PY
