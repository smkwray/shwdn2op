"""Real-browser end-to-end check of the extension + companion live advisor.
Test guest accounts play private gen9uu challenges on play.pokemonshowdown.com. Side A has the unpacked extension and
clicks real buttons; side B is a plain local browser that picks Showdown's default. At every decision of every battle the
strip must show Metamon's pick, damage notes, speed and the threats table, on screen and uncovered, with the picked
control marked in words; a forced switch marks the picked switch, a Tera pick marks Showdown's Terastallize checkbox.
A separate test companion on :6128 with a throwaway history keeps test battles out of the owner's real history.

Modes:
  normal | team4 (opponent brings 4) | swkill (extension service worker killed mid-battle) | idle (80 s on one decision)
  reload (page reload + name reclaim) | guards (A leads Slowking and repeats Future Sight: the re-ranker's red guard)
  multi (three concurrent battles: two rooms in one tab plus a second tab; every decision of each)
  capacity (worker limit 2, three battles: the third explains the wait, then starts when a battle ends)
  samesession-replay (the page replays the battle from |init| mid-battle in the same capture session)
  companion-restart (the test companion restarts mid-battle; recovery without a page reload)
  worker-stall (pause this run's model worker; fresh damage/speed remain visible, watchdog and replay recover)
  ext-reload (the extension reloads mid-battle: the re-injected bridge recovers the decision with NO tab refresh, one strip)
  stale-room (a finished battle stays open, the service worker restarts, then a new battle runs in the same tab)
Browsers: --browser chrome (Chrome for Testing, default) | vivaldi. --attach-a CDP_URL runs side A in a new tab of an
existing browser (the owner's play browser); --attach-forward USER@HOST forwards that host's 127.0.0.1:6128 to this
test companion, the extension is pointed there with read-back, and restored to :6127 afterwards even on failure.
--server https://127.0.0.1:PORT plays on a loopback Showdown server (pregame_check.sh --server local starts the pinned
one) instead of the public one: the same public client page, extension and protocol, but Config.server is preset in the
test browsers only (an init script), loopback access is granted to the Showdown origin, and only that server's own TLS
key is trusted. No public battle rate limit applies, so modes can run at once (--test-port gives each its companion).
Usage: python3 scripts/extension_e2e.py MODE [DECISIONS] [--browser chrome|vivaldi] [--attach-a URL --attach-forward U@H]
       [--server public|https://127.0.0.1:PORT] [--test-port PORT]
The last line is "RESULT <mode> <browser> PASS|FAIL ...". Exit status 0 only on PASS."""
import argparse, base64, hashlib, json, os, pathlib, re, signal, socket, ssl, subprocess, sys, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # run the finally blocks: never orphan the test companion
def _overdue(*_): raise TimeoutError("mode exceeded its 20-minute budget (a page or the site stopped responding)")
signal.signal(signal.SIGALRM, _overdue); signal.alarm(1200)
MODES = ("normal", "team4", "swkill", "idle", "reload", "guards", "multi", "capacity", "samesession-replay",
         "companion-restart", "ext-reload", "stale-room", "worker-stall")
ATTACH_MODES = ("normal", "team4", "idle", "guards", "multi", "samesession-replay", "companion-restart", "stale-room")
ap = argparse.ArgumentParser()
ap.add_argument("mode", choices=MODES); ap.add_argument("decisions", nargs="?", type=int, default=7)
ap.add_argument("--browser", choices=("chrome", "vivaldi"), default="chrome")
ap.add_argument("--attach-a"); ap.add_argument("--attach-forward")
ap.add_argument("--pick-max", type=float, default=float(os.environ.get("E2E_PICK_MAX_S", "2.5")),
                help="seconds from a request reaching the page to Metamon's pick on screen")
ap.add_argument("--server", default="public", help="public, or https://127.0.0.1:PORT (a loopback Showdown server)")
ap.add_argument("--test-port", type=int, default=6128, help="this run's own test companion port")
args = ap.parse_args()
MODE, N = args.mode, args.decisions
if args.attach_a and MODE not in ATTACH_MODES: sys.exit(f"{MODE} would disturb the attached browser; attach supports {ATTACH_MODES}")
if args.attach_a and not args.attach_forward: sys.exit("--attach-a needs --attach-forward USER@HOST so the remote extension reaches the test companion")
TEST_PORT, LIVE_PORT = args.test_port, 6127
if TEST_PORT == LIVE_PORT: sys.exit("--test-port must not be the live companion's port")
if args.attach_a and (TEST_PORT != 6128 or args.server != "public"): sys.exit("attach runs on the public server with test port 6128 only")
LOCAL = None if args.server == "public" else re.fullmatch(r"https://127\.0\.0\.1:(\d+)", args.server)
if args.server != "public" and not LOCAL: sys.exit("--server must be public or https://127.0.0.1:PORT")
SPKI = ""
if LOCAL:  # trust exactly the local server's key (Chrome's SPKI pin), nothing else
    pem = ssl.get_server_certificate(("127.0.0.1", int(LOCAL.group(1))), timeout=5)
    der = subprocess.run("openssl x509 -pubkey -noout | openssl pkey -pubin -outform der", shell=True, input=pem.encode(), capture_output=True, check=True).stdout
    SPKI = base64.b64encode(hashlib.sha256(der).digest()).decode()
BROWSER = "attach" if args.attach_a else args.browser
OUT = ROOT / "tmp/ext-e2e" / f"{BROWSER}-{MODE}{'-local' if LOCAL else ''}-{time.strftime('%Y%m%dT%H%M%S')}"; OUT.mkdir(parents=True)
# Direct invocations have the same live-game fence as the matrix. Unknown status is not permission to start workers.
try:
    owner_rooms = json.load(urllib.request.urlopen(f"http://127.0.0.1:{LIVE_PORT}/v1/metamon/live", timeout=5))["rooms"]
except Exception as exc:
    sys.exit(f"REFUSED: cannot establish live companion idle: {exc}")
if any(r.get("state") in ("ready", "warming") for r in owner_rooms):
    sys.exit("REFUSED: live battle in progress")
EXT = str(ROOT / "apps/extension")
CFT = sorted(pathlib.Path.home().glob("Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
             key=lambda p: int(re.search(r"chromium-(\d+)", str(p)).group(1)))[-1]
VIVALDI = "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"
TEAM = (ROOT / "examples/gen9uu-scizor-proposal.txt").read_text()
TEAM_B = "\n\n".join(TEAM.strip().split("\n\n")[:4]) if MODE == "team4" else TEAM
PIVOTS = ("U-turn", "Volt Switch", "Chilly Reception", "Flip Turn", "Parting Shot")
log = open(OUT / "log.txt", "w")
def say(*a):
    s = " ".join(map(str, a)); print(s, flush=True); log.write(s + "\n"); log.flush()
def live(): return json.load(urllib.request.urlopen(f"http://127.0.0.1:{TEST_PORT}/v1/metamon/live", timeout=5))
fails, guarded, covered = [], [], {"forced_switch": 0, "tera": 0, "preview": 0, "move": 0, "switch": 0, "hover": 0}
latencies, peak, timeline = [], {"workers": 0, "rss_mb": []}, []

# ---------- test companion ----------
desc = sorted((ROOT / "tmp/meta-priors").glob("*.descriptor.json"))
launch = ROOT / "config/local/metamon-live.json"
if MODE == "capacity":  # same worker, a limit of 2 so a third battle must wait
    cfg = json.loads(launch.read_text()); cfg["maxWorkers"] = 2
    launch = OUT / "launch-capacity.json"; launch.write_text(json.dumps(cfg))
env = {**os.environ, "COMPANION_PORT": str(TEST_PORT), "LOCAL_INTEL_STORE_PATH": str(OUT / "intel.json"),
       "EXTERNAL_CURATED_STORE_PATH": str(OUT / "curated.json"),
       "SHWDN2OP_METAMON_LIVE_LAUNCH": str(launch), "SHWDN2OP_METAMON_LIVE_JOURNAL": str(OUT / "journal"), "REPLAYS_DIR": str(OUT / "replays"),  # never the owner's replays/
       **({"MOVE_PRIOR_DESCRIPTOR": str(desc[-1])} if desc else {})}
companion = None
def listener_pids(port):
    return set(subprocess.run(["lsof", "-t", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split())
def start_companion():
    global companion
    # A leftover companion on the test port would answer instead of ours, with older code: every result would be its.
    for _ in range(20):
        if not listener_pids(TEST_PORT): break
        time.sleep(0.5)
    else: raise RuntimeError(f"port {TEST_PORT} is held by another process {listener_pids(TEST_PORT)}; refusing to test against a companion this run did not start")
    companion = subprocess.Popen(["node", str(ROOT / "apps/companion/dist/index.js")], env=env, cwd=ROOT,
                                 stdout=open(OUT / "companion.log", "a"), stderr=subprocess.STDOUT)
    for _ in range(60):
        if companion.poll() is not None: break
        try:
            live()
            if listener_pids(TEST_PORT) == {str(companion.pid)}: return
        except Exception: pass
        time.sleep(0.5)
    raise RuntimeError("test companion did not start (or another process answers on its port); see companion.log")
def stop_companion():
    if companion and companion.poll() is None:
        companion.terminate()
        try: companion.wait(timeout=30)
        except subprocess.TimeoutExpired: companion.kill()

# ---------- page scripts ----------
STATE = """r => { const c = document.getElementById('room-' + r)?.querySelector('.battle-controls'); if (!c) return null;
  const strip = c.querySelector('[data-s2o=strip]');
  const notes = [...c.querySelectorAll('button[name=chooseMove] [data-s2o=note]')].map(e => e.textContent);
  return { engine: strip?.dataset.engine || '', rqid: strip?.dataset.rqid || '', pick: strip?.dataset.pick || '', strip: strip?.innerText.replace(/\\s+/g, ' ') || '', notes,
    switchNotes: [...c.querySelectorAll('button[name=chooseSwitch] [data-s2o=note]')].map(e => e.textContent).filter(t => t.trim()).length,
    table: c.querySelector('[data-s2o=threats]')?.innerText.replace(/\\s+/g, ' ').slice(0, 160) || '', setText: c.querySelector('[data-s2o=set]')?.innerText.replace(/\\s+/g, ' ') || '',
    moves: c.querySelectorAll('button[name=chooseMove]').length, switches: c.querySelectorAll('button[name=chooseSwitch]').length, preview: c.querySelectorAll('button[name=chooseTeamPreview]').length,
    guards: [...c.querySelectorAll('[data-s2o-guard]')].map(e => e.dataset.s2oGuard + ': ' + e.textContent), rerank: c.querySelector('[data-s2o-rerank]')?.textContent || '',
    hover: [...c.querySelectorAll('button[name=chooseMove] [data-s2o=note]')].map(e => /vs their team:/.test(e.title) ? (e.title.match(/^• /gm) || []).length + ((e.title.match(/^• .*\\(in[,)]/gm) || []).length === 1 ? 0 : 100) : -1) }; }"""
# Showdown's open move tooltip: its own heading kept, our section with n rows, fully on screen.
TIP = """n => { const t = document.querySelector('#tooltipwrapper .tooltip-move'), s = t?.querySelector('[data-s2o-tip]'); if (!s) return { ok: false, why: t ? 'no section' : 'no tooltip' };
  const b = t.getBoundingClientRect(), rows = s.querySelectorAll('[data-s2o-tip-row]').length, onScreen = b.width > 0 && b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth;
  return { ok: !!t.querySelector('h2') && /vs their team/.test(s.textContent) && rows === n && onScreen, rows, want: n, onScreen, text: s.innerText.replace(/\\s+/g, ' ').slice(0, 200) }; }"""
# On screen and not covered: the element's centre is inside the viewport and the topmost element there belongs to it.
VISIBLE = """([r, pick]) => { const c = document.getElementById('room-' + r)?.querySelector('.battle-controls'); if (!c) return {ok: false, why: 'no controls'};
  const seen = (el) => { if (!el) return 'missing'; const b = el.getBoundingClientRect(); if (!b.width || !b.height) return 'zero size';
    const x = b.left + b.width / 2, y = b.top + Math.min(b.height / 2, 12);
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return `off screen (${Math.round(x)},${Math.round(y)} in ${innerWidth}x${innerHeight})`;
    const top = document.elementFromPoint(x, y); return top && (el === top || el.contains(top)) ? '' : `covered by ${top?.tagName}.${top?.className}`; };
  const problems = []; const strip = c.querySelector('[data-s2o=strip]'); const sp = seen(strip); if (sp) problems.push('strip ' + sp);
  const want = []; const m = /^move:(\\d)\\|tera=(\\d)$/.exec(pick), s = /^switch:(\\d)$/.exec(pick), t = /^team:(\\d)/.exec(pick);
  if (m) { want.push(['move', c.querySelector(`button[name=chooseMove][value="${m[1]}"]`)]); if (m[2] === '1') want.push(['tera', c.querySelector('input[name=terastallize]')?.closest('label')]); }
  if (s) want.push(['switch', c.querySelector(`button[name=chooseSwitch][value="${Number(s[1]) - 1}"]`)]);
  if (t) want.push(['lead', c.querySelector(`button[name=chooseTeamPreview][value="${Number(t[1]) - 1}"]`)]);
  if (!pick) problems.push('no pick on strip');
  for (const [kind, el] of want) { const v = seen(el); if (v) problems.push(`${kind} ${v}`);
    else if (el.dataset.s2oPick !== '1') problems.push(`${kind} not marked`);
    else { const cue = el.querySelector('[data-s2o=badge], [data-s2o=tera]');
      if (!cue || !/★ Metamon/.test(cue.textContent)) problems.push(`${kind} has no textual cue`);
      else if (cue.scrollWidth > cue.clientWidth + 1) problems.push(`${kind} cue is truncated`);
      else { const v2 = seen(cue); if (v2) problems.push(`${kind} cue ${v2}`); } } }
  const stray = [...c.querySelectorAll('[data-s2o-pick]')].filter((el) => !want.some(([, w]) => w === el));
  if (stray.length) problems.push(`${stray.length} wrong control(s) marked`);
  return { ok: !problems.length, why: problems.join('; '), kinds: want.map(([k]) => k) }; }"""
# Per-decision timeline in side A's pages, sampled every 25 ms (epoch ms): req = the page has the request, pick = the
# strip shows Metamon's pick for it, intel = the engine's damage/speed data is on the page, btn = Showdown shows the buttons,
# notes = buttons with their notes. lost = times the pick or the data vanished again before the choice (flicker).
TIMELINE = """(() => { if (window.__s2oTL) return; const tl = window.__s2oTL = {};
  setInterval(() => { try { const now = Date.now();
    for (const [r, room] of Object.entries(window.app?.rooms || {})) {
      const q = room?.request; if (!r.startsWith('battle-') || !q || q.wait) continue;
      const e = tl[r + '#' + q.rqid] ??= { room: r, rqid: q.rqid, req: now, lost: 0 }; if (e.done) continue;
      const c = document.getElementById('room-' + r)?.querySelector('.battle-controls'), strip = c?.querySelector('[data-s2o=strip]');
      // Only this request's result counts (the strip names its rqid; a build without that attribute is taken at its word).
      const mine = !!strip && (strip.dataset.rqid === undefined || strip.dataset.rqid === String(q.rqid));
      let intel = false; try { intel = mine && JSON.parse(strip.dataset.engine || '{}').intel === true; } catch {}
      const pick = mine && !!strip.dataset.pick, btn = !!c?.querySelector('button[name=chooseMove], button[name=chooseSwitch], button[name=chooseTeamPreview]');
      const moves = [...(c?.querySelectorAll('button[name=chooseMove]') || [])];
      if (e.btn && !btn) { e.done = now; if (e.gone) { e.lost++; (e.losses ??= []).push({ at: e.gone.at - e.req, ms: now - e.gone.at, text: e.gone.text }); } continue; }
      // A loss counts when the pick or data stays away for 50 ms or more (Showdown's own redraw of its controls removes the
      // strip until the next animation frame re-adds it; that is a blip, counted apart).
      const showing = (!e.hasPick || pick) && (!e.hasIntel || intel);
      if (!showing && !e.gone) e.gone = { at: now, text: strip ? strip.innerText.replace(/\\s+/g, ' ').slice(0, 90) : 'no strip' };
      if (showing && e.gone) { const ms = now - e.gone.at; if (ms >= 50) { e.lost++; (e.losses ??= []).push({ at: e.gone.at - e.req, ms, text: e.gone.text }); } else e.blips = (e.blips || 0) + 1; e.gone = null; }
      if (!e.gone) { e.hasPick = pick; e.hasIntel = intel; }
      e.pick ||= pick && now; e.intel ||= intel && now; e.btn ||= btn && now;
      e.notes ||= btn && pick && intel && (!moves.length || moves.some((b) => /\\d|status/.test(b.querySelector('[data-s2o=note]')?.textContent || ''))) && now;
    } } catch {} }, 25); })()"""
# --server: the client's own config.js keeps a predefined Config (`var Config = Config || {}`) and its storage keeps a
# preset Config.server, so the unmodified public client connects to the loopback server over SockJS/TLS, framed exactly
# as it is to the public one. Not registered: the client skips that server's custom CSS and lobby autojoin.
SERVER_INIT = LOCAL and ("window.Config = Object.assign(window.Config || {}, { server: { id: 'e2elocal', host: '127.0.0.1', port: %s,"
                         " httpport: %s, https: true, registered: false } });" % (LOCAL.group(1), LOCAL.group(1)))
SHOWDOWN = "https://play.pokemonshowdown.com"
def use_server(ctx):
    if not LOCAL: return
    ctx.add_init_script(SERVER_INIT)
    ctx.grant_permissions(["local-network-access"], origin=SHOWDOWN)  # Chrome's loopback prompt, answered for this origin only
def free_port():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
# foeGone: the opposing active has fainted and nothing replaced it yet (read from the protocol log, which is complete
# before Showdown's animations catch up).
REQ = """r => { const room = app.rooms[r], q = room?.request; if (!q) return null;
  const foe = q.side?.id === 'p1' ? 'p2' : 'p1'; let gone = false;
  for (const l of room.battle?.stepQueue || []) { if (l.startsWith(`|switch|${foe}a`) || l.startsWith(`|drag|${foe}a`)) gone = false; if (l.startsWith(`|faint|${foe}a`)) gone = true; }
  return {rqid: q.rqid, tp: !!q.teamPreview, wait: !!q.wait, force: !!(q.forceSwitch && q.forceSwitch[0]), foeGone: gone}; }"""

def name(pg, n):
    for _ in range(5):
        # Local: the loopback server takes a guest name without the public login server's assertion (setup only; that
        # server intermittently answered "invalid login key" for it, and parallel runs would multiply the requests).
        pg.evaluate("n => app.send('/trn ' + n)" if LOCAL else "n => app.user.rename(n)", n)
        try: pg.wait_for_function("n => app.user.get('name') === n", arg=n, timeout=15000); return
        except Exception:
            say(f"  rename to {n} not accepted: {pg.evaluate('() => (app.popups || []).map(p => p.$el?.text?.() || \"\").join(\" | \").slice(0, 200)') or 'no popup'}")
            pg.evaluate("() => { while (app.popups && app.popups.length) app.closePopup(); }"); pg.wait_for_timeout(32000)
    evidence(pg, f"rename-{n}")
    raise RuntimeError(f"rename to {n} failed 5 times")
def ready(pg):
    for attempt in range(3):  # play.pokemonshowdown.com occasionally closes the first connection (ERR_CONNECTION_CLOSED)
        try:
            pg.goto("https://play.pokemonshowdown.com/", wait_until="domcontentloaded")
            pg.wait_for_function("() => window.app && app.user && app.socket && app.user.get('userid')", timeout=60000)
            if LOCAL and pg.evaluate("() => Config.server.id + ' ' + Config.server.port") != f"e2elocal {LOCAL.group(1)}":
                raise SystemExit(f"--server: the page connected to {pg.evaluate('() => Config.server.host')}, not the local server")
            return
        except Exception as e:
            say(f"  page load attempt {attempt + 1} failed: {str(e)[:120]}"); pg.wait_for_timeout(5000)
    raise RuntimeError("Showdown did not load")
def rooms_of(pg): return pg.evaluate("() => Object.keys(app.rooms).filter(r => r.startsWith('battle-'))")
def act(pg, js, arg=None, timeout=20000):
    """Run a side-B action with a deadline. A plain page.evaluate has none, and twice an opponent page stopped answering
    and hung the whole mode until its 20-minute budget (capacity, 2026-10-22). Now it fails at once, by name."""
    try: pg.wait_for_function(f"(arg) => {{ ({js})(arg); return true; }}", arg=arg, timeout=timeout, polling=100)
    except Exception as e:
        evidence(pg, "opponent-unresponsive")
        raise RuntimeError(f"opponent page {pg.url} did not answer within {timeout} ms: {str(e)[:160]}")
def evidence(pg, tag):
    """Best-effort screenshot and Showdown popup text of a page at a failure, each with its own short deadline."""
    stamp = time.strftime('%H%M%S')
    try: pg.screenshot(path=str(OUT / f"evidence-{tag}-{stamp}.png"), timeout=10000)
    except Exception as e: say(f"  evidence {tag}: no screenshot ({str(e)[:80]})")
    try:
        pg.wait_for_function("() => { window.__s2oPopup = [...document.querySelectorAll('.ps-popup, .popup')].map(e => e.innerText).join(' | ').slice(0, 400); return true; }", timeout=5000, polling=100)
        say(f"  evidence {tag}: popups: {pg.evaluate('window.__s2oPopup') or 'none'}")
    except Exception as e: say(f"  evidence {tag}: page not answering ({str(e)[:80]})")

class Battle:
    def __init__(self, label, a, b, room):
        self.label, self.a, self.b, self.room = label, a, b, room
        self.last, self.step, self.waited, self.first_seen, self.done, self.pivoted = None, 0, time.time(), {}, False, False
    def ended(self): return self.a.evaluate("r => !!app.rooms[r]?.battle?.ended", self.room)

def challenge(a, b, na, nb, team_b, label):
    before = set(rooms_of(a)); new = []
    # Setup only (not the advisor under test): late in a matrix the site sometimes ignores a guest challenge; one logged
    # retry after a pause, then fail with evidence.
    for attempt in range(2):
        act(b, "t => app.send('/utm ' + Storage.packTeam(Storage.importTeam(t)))", team_b)
        act(b, "n => app.send('/challenge ' + n + ', gen9uu')", na); a.wait_for_timeout(3000); a.evaluate("n => app.send('/accept ' + n)", nb)
        for _ in range(60):
            new = [r for r in rooms_of(a) if r not in before]
            if new: break
            a.wait_for_timeout(500)
        if new: break
        evidence(a, f"{label}-challenger-side"); evidence(b, f"{label}-challenge-sender")
        say(f"  {label}: challenge attempt {attempt + 1} did not start a battle")
        if attempt == 0: a.wait_for_timeout(30000)
    else: raise RuntimeError(f"{label}: the challenge did not start a battle")
    room = new[0]; say(f"battle {label}: {room}")
    for _ in range(40):
        if any(r["roomId"] == room for r in live()["rooms"]): break
        a.wait_for_timeout(500)
    else: raise RuntimeError(f"{label}: the battle is not reaching the test companion; aborting before it pollutes real history")
    return Battle(label, a, b, room)

def opponent(bt, lead="123456"):
    act(bt.b, "([r, lead]) => { const q = app.rooms[r]?.request; if (q && !q.wait && q.rqid !== (window.__lb || {})[r]) { (window.__lb ||= {})[r] = q.rqid; q.teamPreview ? app.send('/team ' + lead, r) : app.send('/choose default', r); } }", [bt.room, lead])

def sample_workers():
    pids = [r["pid"] for r in live()["rooms"] if r["pid"]]
    peak["workers"] = max(peak["workers"], len(pids))
    if pids:
        out = subprocess.run(["ps", "-o", "rss=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout.split()
        peak["rss_mb"] += [int(x) / 1024 for x in out]

def complete(st, q):
    # A double KO leaves no opposing active: nothing threatens the switch-in, so no table is expected then.
    return st and st["pick"] and "Metamon:" in st["strip"] and (q["tp"] or (q["force"] and q["foeGone"]) or (st["table"] and "none predicted" not in st["table"] and "calculating" not in st["table"]
        and (st["moves"] == 0 or any(re.search(r"\d|status", n) for n in st["notes"]))))

def decide(bt, hooks):
    """One poll of one battle. Returns True when a decision was checked and clicked."""
    if bt.done: return False
    if bt.step >= N or bt.ended(): bt.done = True; return False
    opponent(bt, "312456" if MODE == "guards" else "123456")
    q = bt.a.evaluate(REQ, bt.room)
    if not q or q["wait"] or q["rqid"] == bt.last:
        if time.time() - bt.waited > 120: fails.append(f"{bt.label}: stalled after step {bt.step}"); bt.done = True
        return False
    bt.first_seen.setdefault(q["rqid"], time.time())
    hooks.get("before", lambda bt, q: None)(bt, q)
    a = bt.a
    a.bring_to_front()
    if a.evaluate("r => app.curRoom && app.curRoom.id !== r", bt.room): a.evaluate("r => app.focusRoom(r)", bt.room); a.wait_for_timeout(300)
    a.mouse.move(5, 5)  # Showdown's hover tooltip would cover the strip
    t0 = bt.first_seen[q["rqid"]]; st = a.evaluate(STATE, bt.room); pick_at = None
    # Showdown shows the decision's buttons only after its turn animation; the marks can only be checked on them. The pick
    # itself is timed from the request, animation or not.
    limit, buttons = hooks.get("limit", 25), lambda st: st and (st["moves"] or st["switches"] or st["preview"])
    while time.time() - t0 < limit + 30 and not (complete(st, q) and buttons(st)):
        if pick_at is None and st and st["pick"]: pick_at = time.time()
        if time.time() - t0 > limit and not (st and st["pick"]): break
        a.wait_for_timeout(100); st = a.evaluate(STATE, bt.room)
    if pick_at is None and st and st["pick"]: pick_at = time.time()
    ok = complete(st, q)
    vis = a.evaluate(VISIBLE, [bt.room, st["pick"] if st else ""]) if ok else {"ok": False, "why": "incomplete"}
    pick_s = (pick_at - t0) if pick_at else None
    kind = "preview" if q["tp"] else "forced_switch" if q["force"] else "move"
    if ok and vis["ok"]:
        covered[kind] += 1
        for k in vis["kinds"]:
            if k in ("tera", "switch"): covered[k] += 1
    if ok and q["tp"]:  # the UU lead model's usual lead; team4's 4-mon opponent preview gets the labelled random fallback
        want = r"Random lead: .*lead model off \(opponent shows fewer than 6\)" if MODE == "team4" else r"Usual lead: \S.* \(\d+%\)"
        if not re.search(want, st["strip"]): fails.append(f"{bt.label} step {bt.step}: preview strip lacks /{want}/: {st['strip'][:140]}")
    slow = pick_s is None or (pick_s > args.pick_max and not hooks.get("slow_ok", lambda bt, q: False)(bt, q))
    if not ok or not vis["ok"] or slow:
        try:  # what the companion and the extension's self-report knew at the failure
            (OUT / f"fail-{bt.label}-{bt.step:02d}.json").write_text(json.dumps({"live": live(), "clients": json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{TEST_PORT}/v1/client/status", timeout=5)), "state": st}, indent=1))
        except Exception as e: say(f"  (diagnostics unavailable: {e})")
        fails.append(f"{bt.label} step {bt.step}: " + ("incomplete" if not ok else vis["why"] if not vis["ok"] else f"pick took {pick_s if pick_s is None else round(pick_s, 1)} s"))
    if pick_s is not None: latencies.append(pick_s)
    sample_workers()
    a.screenshot(path=str(OUT / f"{bt.label}-step-{bt.step:02d}-{kind}.png"))
    say(f"{bt.label} step {bt.step} rqid={q['rqid']} {kind} {'OK' if ok and vis['ok'] else 'FAIL'} pick {pick_s if pick_s is None else f'{pick_s:.2f}'}s full {time.time()-t0:.1f}s"
        f" | {st['strip'] if st else None} | pick={st['pick'] if st else None} notes={st['notes'] if st else None} sw={st['switchNotes'] if st else None}"
        f" | {vis['why'] or 'visible+marked: ' + ','.join(vis['kinds'])} | {st['table'][:70] if st else None}")
    if st and st.get("guards"):
        guarded.append(f"{bt.label}:{bt.step}"); a.locator(f"#room-{bt.room} [data-s2o=strip]").screenshot(path=str(OUT / f"{bt.label}-strip-guard-{bt.step:02d}.png"))
        say(f"  GUARD shown: {st['guards']} | {st['rerank'] or 'no re-rank line'}")
    # Hover detail: each move's tooltip lists its band against every opposing Pokémon, the active marked
    # "in" once. It comes with the complete result, a moment after the notes.
    if ok and kind == "move" and st["moves"] and not q["foeGone"]:
        hover_until = time.time() + 6
        while time.time() < hover_until and not (st and st["hover"] and all(0 < n < 100 for n in st["hover"])):
            a.wait_for_timeout(100); st = a.evaluate(STATE, bt.room)
        if not (st and st["hover"] and all(0 < n < 100 for n in st["hover"])):
            fails.append(f"{bt.label} step {bt.step}: move tooltips lack the per-opponent damage lines {st['hover'] if st else None}")
        elif MODE != "normal": covered["hover"] += 1
        else:  # really hover; Showdown's own tooltip must show every line, on screen
            a.locator(f"#room-{bt.room} .battle-controls button[name=chooseMove]").first.hover(); tip, tip_until = None, time.time() + 3
            while time.time() < tip_until and not (tip and tip["ok"]):
                a.wait_for_timeout(100); tip = a.evaluate(TIP, st["hover"][0])
            a.screenshot(path=str(OUT / f"{bt.label}-step-{bt.step:02d}-tooltip.png")); a.mouse.move(5, 5)
            if tip["ok"]: covered["hover"] += 1
            else: fails.append(f"{bt.label} step {bt.step}: hovered move tooltip lacks the per-opponent lines {tip}")
    hooks.get("after_check", lambda bt, q, st: None)(bt, q, st)
    tl = a.evaluate("k => window.__s2oTL && window.__s2oTL[k]", f"{bt.room}#{q['rqid']}")
    if tl:
        timeline.append({"label": bt.label, "step": bt.step, "kind": kind, **tl})
        ms = lambda k, base="req": f"{(tl[k] - tl[base]) / 1000:.2f}" if tl.get(k) and tl.get(base) else "-"
        say(f"  timeline: pick {ms('pick')} data {ms('intel')} buttons {ms('btn')} notes {ms('notes')} (after buttons {ms('notes', 'btn')}) lost {tl['lost']}"
            + "".join(f" [at {x['at'] / 1000:.2f}s for {x['ms']} ms: {x['text']}]" for x in tl.get("losses") or []))
    ctl = f"#room-{bt.room} .battle-controls "
    sel = ctl + "button[name=chooseTeamPreview]:visible" if q["tp"] else ctl + "button[name=chooseMove]:visible, " + ctl + "button[name=chooseSwitch]:not(.disabled):visible"
    if MODE == "guards":  # lead Slowking, then Future Sight whenever it is clickable
        fs = a.locator(ctl + "button[name=chooseMove]:visible:has-text('Future Sight')")
        sel = ctl + "button[name=chooseTeamPreview]:visible:has-text('Slowking')" if q["tp"] else (ctl + "button[name=chooseMove]:visible:has-text('Future Sight')" if fs.count() else sel)
    elif not q["tp"] and not bt.pivoted:  # pivot once so every run checks a forced-switch decision
        for move in PIVOTS:
            loc = a.locator(ctl + f"button[name=chooseMove]:visible:has-text('{move}')")
            if loc.count(): sel = ctl + f"button[name=chooseMove]:visible:has-text('{move}')"; bt.pivoted = True; break
    a.locator(sel).first.click(timeout=15000)  # real click: fails if anything covers the button
    bt.last = q["rqid"]; bt.step += 1; bt.waited = time.time()
    return True

def play(battles, hooks=None, until=None):
    hooks = hooks or {}
    while not all(bt.done for bt in battles):
        if until and until(): return
        progressed = False
        for bt in battles:
            try: progressed |= decide(bt, hooks)
            except Exception as e:  # a crashed battle is a named failure in the RESULT line, never a silent stop
                fails.append(f"{bt.label} step {bt.step}: {type(e).__name__}: {str(e)[:160]}"); bt.done = True
        if not progressed: battles[0].a.wait_for_timeout(250)

# ---------- side A browser ----------
def ext_page(ctx, ext_id):
    pg = ctx.new_page(); pg.goto(f"chrome-extension://{ext_id}/popup.html"); return pg
def set_companion(ctx, ext_id, url):
    pg = ext_page(ctx, ext_id)
    try:
        for _ in range(20):
            pg.evaluate("url => chrome.storage.local.set({ companionUrl: url })", url); pg.wait_for_timeout(500)
            if pg.evaluate("() => chrome.storage.local.get('companionUrl').then(s => s.companionUrl)") == url: return
        raise RuntimeError(f"extension companionUrl would not read back as {url}")
    finally: pg.close()
def find_ext_id(ctx, cdp_targets=None):
    for w in ctx.service_workers:
        m = re.match(r"chrome-extension://([a-p]{32})/background\.js$", w.url)
        if m: return m.group(1)
    for t in cdp_targets or []:
        m = re.match(r"chrome-extension://([a-p]{32})/background\.js$", t.get("url", ""))
        if m: return m.group(1)
    return None
def sw_of(ctx, ext_id):
    for w in ctx.service_workers:
        if w.url.startswith(f"chrome-extension://{ext_id}/"): return w
    return ctx.wait_for_event("serviceworker", predicate=lambda w: w.url.startswith(f"chrome-extension://{ext_id}/"), timeout=20000)

def cdp_ws(http_url):
    """The browser's ws endpoint, rewritten to the host:port we reach it on (an SSH forward reports the remote port)."""
    info = json.load(urllib.request.urlopen(f"{http_url.rstrip('/')}/json/version", timeout=10))
    ws = info["webSocketDebuggerUrl"]; hostport = re.sub(r"^https?://", "", http_url.rstrip("/"))
    return re.sub(r"^ws://[^/]+", f"ws://{hostport}", ws), info

forward = None; attach_restore = None; vivaldi_proc = None; own_pages = []
start_companion()
try:
    with sync_playwright() as p:
        try:
            if BROWSER == "attach":
                forward = subprocess.Popen(["ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-R", f"127.0.0.1:{TEST_PORT}:127.0.0.1:{TEST_PORT}", args.attach_forward])
                for _ in range(30):
                    r = subprocess.run(["ssh", "-o", "BatchMode=yes", args.attach_forward, f"curl -s -m 3 http://127.0.0.1:{TEST_PORT}/v1/metamon/live"], capture_output=True, text=True)
                    if '"ok":true' in r.stdout: break
                    time.sleep(1)
                else: raise RuntimeError("the remote host cannot reach the test companion through the forward")
                ws, info = cdp_ws(args.attach_a); say("attached browser:", info.get("Browser"))
                br = p.chromium.connect_over_cdp(ws, timeout=30000); A = br.contexts[0]
                # The worker sleeps when idle; a Showdown tab of our own wakes it (lobby only, before any battle).
                own_pages.append(A.new_page()); ready(own_pages[0])
                for _ in range(40):
                    targets = json.load(urllib.request.urlopen(f"{args.attach_a.rstrip('/')}/json/list", timeout=10))
                    ext_id = find_ext_id(A, targets)
                    if ext_id: break
                    time.sleep(0.5)
                else: raise RuntimeError("the attached browser has no shwdn2op service worker")
                attach_restore = (A, ext_id)
                set_companion(A, ext_id, f"http://127.0.0.1:{TEST_PORT}")
                say(f"attached extension {ext_id} now uses the test companion :{TEST_PORT} (read back)")
                first = [own_pages[0]]
                new_tab = lambda: first.pop() if first else (own_pages.append(A.new_page()), own_pages[-1])[1]
            else:
                port = free_port()  # parallel runs: a shared random port could connect one run to another's browser
                pin = [f"--ignore-certificate-errors-spki-list={SPKI}"] if SPKI else []
                if BROWSER == "vivaldi":
                    # --disable-vivaldi: Vivaldi's own browser engine without its UI. With the UI, CDP clients hang on its UI page
                    # target and a Playwright launch crashes (2026-10-22), so Vivaldi-UI-specific behaviour is not covered here.
                    vivaldi_proc = subprocess.Popen([VIVALDI, f"--user-data-dir={OUT / 'profileA'}", "--no-first-run", "--headless=new", "--disable-vivaldi", f"--remote-debugging-port={port}",
                        f"--load-extension={EXT}", "--disable-features=DisableLoadExtensionCommandLineSwitch", "--window-size=1600,1000", *pin, "about:blank"],
                        stdout=open(OUT / "vivaldi.log", "w"), stderr=subprocess.STDOUT)
                    for _ in range(60):
                        try: ws, info = cdp_ws(f"http://127.0.0.1:{port}"); break
                        except Exception: time.sleep(0.5)
                    say("vivaldi:", info.get("Browser"), subprocess.run(["defaults", "read", "/Applications/Vivaldi.app/Contents/Info.plist", "CFBundleShortVersionString"], capture_output=True, text=True).stdout.strip())
                    br = p.chromium.connect_over_cdp(ws, timeout=60000); A = br.contexts[0]
                else:
                    A = p.chromium.launch_persistent_context(str(OUT / "profileA"), executable_path=str(CFT), headless=True,
                        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", f"--remote-debugging-port={port}", *pin], viewport={"width": 1600, "height": 1000})
                for _ in range(40):
                    ext_id = find_ext_id(A)
                    if ext_id: break
                    try: A.wait_for_event("serviceworker", timeout=500)  # sync Playwright only learns of workers while waiting on it
                    except Exception: pass
                else: raise RuntimeError("the extension's service worker never started")
                # The extension's first-run defaults can land after an early write; set, read back and fail loudly if it won't stick.
                set_companion(A, ext_id, f"http://127.0.0.1:{TEST_PORT}")
                if MODE == "ext-reload":
                    # As scripts/play_browser.sh does: without Developer mode a reload DISABLES a command-line unpacked extension.
                    pg = A.new_page(); pg.goto("chrome://extensions/")
                    pg.evaluate("() => new Promise(r => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}, r))"); pg.close()
                new_tab = lambda: A.new_page()
            if BROWSER != "attach": A.add_init_script(TIMELINE); use_server(A)  # never into the owner's browser
            say("test browser", BROWSER, "extension", ext_id, "companion", f"http://127.0.0.1:{TEST_PORT}", "server", args.server)
            bb = p.chromium.launch(executable_path=str(CFT), headless=True, args=[f"--ignore-certificate-errors-spki-list={SPKI}"] if SPKI else [])
            def opponent_page(n):
                # The opponent is test scaffolding: only Showdown itself loads there. Its third-party ad scripts twice froze
                # an opponent renderer outright (no JS, no screenshot) mid-matrix (2026-10-22).
                ctx = bb.new_context(); use_server(ctx)
                ctx.route("**/*", lambda route: route.continue_() if re.search(r"(^|\.)(pokemonshowdown\.com|psim\.us)$" + (r"|^127\.0\.0\.1$" if LOCAL else ""), urllib.parse.urlparse(route.request.url).hostname or "") or route.request.url.startswith("data:") else route.abort())
                pg = ctx.new_page(); ready(pg); name(pg, n); return pg
            tag = MODE.replace("-", "")[:3] + BROWSER[:1]
            a = new_tab()  # attach keeps the real window size: visibility is checked as the owner sees it
            if BROWSER != "attach": ready(a)
            say("page hook in side A:", a.evaluate("() => window.__showdownSecondOpinionHookVersion || 'none'"))
            NA = f"s2oA{tag}"; name(a, NA)
            a.evaluate("t => app.send('/utm ' + Storage.packTeam(Storage.importTeam(t)))", TEAM)
            hooks = {}

            if MODE in ("normal", "team4", "guards", "idle", "swkill", "reload", "samesession-replay", "companion-restart", "ext-reload", "worker-stall"):
                b = opponent_page(f"s2oB{tag}"); bt = challenge(a, b, NA, f"s2oB{tag}", TEAM_B, "b1")
                def before(bt, q):
                    if bt.step != 3 or getattr(bt, "_hooked", False): return
                    bt._hooked = True
                    if MODE == "idle": say("  idling 80 s on this decision"); a.wait_for_timeout(80000); bt.first_seen[q["rqid"]] = time.time()
                    if MODE == "swkill":
                        cdp = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}").new_browser_cdp_session()
                        sws = [t for t in cdp.send("Target.getTargets")["targetInfos"] if t["type"] == "service_worker" and ext_id in t["url"]]
                        for t in sws: cdp.send("Target.closeTarget", {"targetId": t["targetId"]})
                        say("  stopped extension service worker", len(sws))
                    if MODE == "reload":
                        a.reload(wait_until="domcontentloaded", timeout=60000); a.wait_for_function("() => window.app && app.user && app.socket && app.user.get('userid')", timeout=60000)
                        name(a, NA); a.wait_for_function("r => app.rooms[r] && app.rooms[r].request", arg=bt.room, timeout=60000); say("  page reloaded and name reclaimed")
                        bt.first_seen[q["rqid"]] = time.time()
                    if MODE == "samesession-replay":
                        a.evaluate("r => window.postMessage({ source: 'showdnass', kind: 'bootstrap-request', roomId: r }, '*')", bt.room)
                        say("  page replayed the battle from |init| in the same capture session"); bt.replayed = True
                    if MODE == "companion-restart":
                        # Force the real failure shape: an aborted capture clears the envelope, then the outage
                        # outlasts the 30 s freshness window. A healthy-envelope advice poll alone is insufficient.
                        stop_companion(); say("  test companion stopped")
                        a.evaluate("r => window.postMessage({ source: 'showdnass', kind: 'bootstrap-request', roomId: r }, '*')", bt.room)
                        a.wait_for_timeout(35000)
                        start_companion(); say("  test companion restarted after a 35 s capture outage")
                        bt.first_seen[q["rqid"]] = time.time()
                    if MODE == "worker-stall":
                        # A NEW request must acquire its own deterministic envelope while the worker is frozen.
                        deadline = time.time() + 12
                        def independent(st):
                            engine = json.loads(st.get("engine") or "{}") if st else {}
                            return st and st["rqid"] == str(q["rqid"]) and engine.get("intel") and engine.get("speed") and (st["notes"] or st["switchNotes"]) and st["table"]
                        st = a.evaluate(STATE, bt.room)
                        while time.time() < deadline and not independent(st):
                            a.wait_for_timeout(100); st = a.evaluate(STATE, bt.room)
                        if not independent(st): fails.append("worker-stall: fresh damage/speed/threats did not render while model was frozen")
                        else:
                            say("  frozen worker: fresh damage, speed and threats are visible", st["engine"])
                            a.screenshot(path=str(OUT / "worker-stalled-data.png"))
                            for _ in range(10):
                                a.wait_for_timeout(500)
                                if not independent(a.evaluate(STATE, bt.room)): fails.append("worker-stall: deterministic info vanished while model was frozen"); break
                    if MODE == "ext-reload":
                        # A reload once orphaned the tab and a mid-battle refresh disconnected the player. The
                        # background re-injects the bridge and the page replays the battle: the pick must return on this
                        # decision with the page never refreshed and never asking for a refresh, and with one bridge only.
                        a.evaluate("() => { window.__s2oNoRefresh = 1; }")  # page-world marker: any navigation drops it
                        sw = sw_of(A, ext_id); t_reload = time.time(); sw.evaluate("() => chrome.runtime.reload()"); say("  extension reloaded")
                        try: A.wait_for_event("serviceworker", timeout=20000)
                        except Exception: pass
                        set_companion(A, ext_id, f"http://127.0.0.1:{TEST_PORT}")
                        a.bring_to_front(); a.mouse.move(5, 5)
                        asked, st, deadline = False, None, time.time() + 45
                        while time.time() < deadline:
                            st = a.evaluate(STATE, bt.room)
                            asked |= bool(st and "refresh this tab" in st["strip"])
                            if complete(st, q) and st["rqid"] == str(q["rqid"]): break
                            a.wait_for_timeout(200)
                        if asked: fails.append("ext-reload: the page asked for a tab refresh")
                        if a.evaluate("() => window.__s2oNoRefresh") != 1: fails.append("ext-reload: the page was refreshed or navigated")
                        if not (complete(st, q) and st["rqid"] == str(q["rqid"])): fails.append(f"ext-reload: no recovery without a refresh within 45 s ({st['strip'] if st else None})")
                        else: say(f"  recovered without a refresh {time.time() - t_reload:.1f} s after the reload | {st['strip']}")
                        dup = a.evaluate("""r => { const c = document.querySelector('#room-' + r + ' .battle-controls'); if (!c) return null;
                          return { strips: c.querySelectorAll('[data-s2o=strip]').length, notes: Math.max(0, ...[...c.querySelectorAll('button[name=chooseMove], button[name=chooseSwitch]')].map(b => b.querySelectorAll('[data-s2o=note]').length)),
                            windows: document.querySelectorAll('#showdnass-overlay').length }; }""", bt.room)
                        if not dup or dup["strips"] != 1 or dup["notes"] > 1 or dup["windows"] > 1: fails.append(f"ext-reload: duplicate bridge output {dup}")
                        a.locator(f"#room-{bt.room} [data-s2o=strip]").screenshot(path=str(OUT / "b1-recovered-without-refresh.png"))
                        bt.first_seen[q["rqid"]] = time.time()
                hooks["before"] = before
                # A recovery decision may take a worker cold start plus a full-log replay; every other decision must be immediate.
                hooks["slow_ok"] = lambda bt, q: q["tp"] or (MODE in ("swkill", "reload", "samesession-replay", "companion-restart", "ext-reload", "worker-stall") and bt.step == 3)
                if MODE == "worker-stall":
                    hooks["limit"] = 55
                    def freeze_worker(bt, q, st):
                        if bt.step != 2: return
                        row = next(r for r in live()["rooms"] if r["roomId"] == bt.room and r["state"] == "ready")
                        assert row["pid"], "this isolated battle must own a worker"
                        os.kill(row["pid"], signal.SIGSTOP)
                        say("  paused this isolated battle's model worker", row["pid"])
                    hooks["after_check"] = freeze_worker
                if MODE == "idle":
                    # A player may think for 30+ s on hard turns (one clicked 34 s after the pick). The pick, notes and marks
                    # must still be on screen after a long think with no new battle frames.
                    def hold(bt, q, st):
                        if bt.step != 3: return
                        a.wait_for_timeout(45000); a.mouse.move(5, 5); st2 = a.evaluate(STATE, bt.room)
                        vis = a.evaluate(VISIBLE, [bt.room, st2["pick"] if st2 else ""])
                        a.screenshot(path=str(OUT / "b1-after-45s-think.png"))
                        say(f"  after a 45 s think: {'OK' if complete(st2, q) and vis['ok'] else 'GONE'} | {st2['strip'] if st2 else None} | {vis['why']}")
                        if not (complete(st2, q) and vis["ok"]): fails.append(f"idle: the pick did not stay on screen through a 45 s think ({vis['why'] or (st2 or {}).get('strip')})")
                    hooks["after_check"] = hold
                if MODE == "samesession-replay":
                    hooks["after_check"] = lambda bt, q, st: (bt.step == 3 and st and "resynced" not in st["strip"]) and fails.append("samesession-replay: the pick after the replay is not labelled resynced")
                if BROWSER in ("chrome", "vivaldi") and MODE == "normal":
                    # Scripted Tera state (test browser only): rewrite one ready move pick into its Tera variant on its way to the
                    # page, so the real render path must mark the Terastallize checkbox. Never done in an attached browser.
                    sw = sw_of(A, ext_id)
                    sw.evaluate("""() => { if (self.__s2oTera) return; self.__s2oTera = { armed: false, used: false }; const send = chrome.tabs.sendMessage.bind(chrome.tabs);
                      chrome.tabs.sendMessage = (tabId, message, ...rest) => { const t = self.__s2oTera, adv = message?.payload?.metamonAdvice, env = message?.payload?.envelope;
                        if (t.armed && message?.type === 'update-local-intel' && adv?.status === 'ready' && /^move:\\d\\|tera=0$/.test(adv.actionId)) {
                          const alt = (env?.semantic?.snapshot ?? message.payload.snapshot)?.legalActions?.find((a) => a.id === adv.actionId.replace('tera=0', 'tera=1'));
                          if (alt) { message = { ...message, payload: { ...message.payload, metamonAdvice: { ...adv, actionId: alt.id, label: 'Terastallize (scripted) + ' + alt.moveName } } }; t.used = true; } }
                        return send(tabId, message, ...rest); }; }""")
                    def tera_before(bt, q, prev=before):
                        prev(bt, q)
                        if bt.step >= 2 and not q["tp"] and not q["force"] and not covered["tera"]: sw_of(A, ext_id).evaluate("() => { self.__s2oTera.armed = true; }")
                    def tera_after(bt, q, st):
                        # Check while the rewrite is still armed: any later update (a stage, a chat line) re-sends the
                        # real pick, which used to undo the scripted one between disarming and reading the strip.
                        if sw_of(A, ext_id).evaluate("() => { const t = self.__s2oTera; return t.armed && t.used; }"):
                            try: a.wait_for_function("r => /tera=1$/.test(document.querySelector('#room-' + r + ' [data-s2o=strip]')?.dataset.pick || '')", arg=bt.room, timeout=5000)
                            except Exception: pass
                            pick = a.evaluate(STATE, bt.room)["pick"]; vis = a.evaluate(VISIBLE, [bt.room, pick])
                            if vis["ok"] and "tera" in vis["kinds"]: covered["tera"] += 1
                            else: fails.append(f"scripted Tera pick {pick}: {vis['why'] or 'checkbox not checked'}")
                            a.mouse.move(5, 5); a.screenshot(path=str(OUT / "b1-tera-decision.png"))
                            say(f"  scripted Tera pick {pick}: {'visible+marked: ' + ','.join(vis['kinds']) if vis['ok'] else vis['why']}")
                        sw_of(A, ext_id).evaluate("() => { self.__s2oTera.armed = false; self.__s2oTera.used = false; }")
                    hooks["before"], hooks["after_check"] = tera_before, tera_after
                play([bt], hooks)
                battles = [bt]

            elif MODE == "stale-room":
                b1 = opponent_page(f"s2oB{tag}"); old = challenge(a, b1, NA, f"s2oB{tag}", TEAM, "old")
                hooks["slow_ok"] = lambda bt, q: q["tp"]
                N_OLD = 2
                while old.step < N_OLD: decide(old, hooks) or a.wait_for_timeout(250)
                act(b1, "r => app.send('/forfeit', r)", old.room); a.wait_for_function("r => !!app.rooms[r]?.battle?.ended", arg=old.room, timeout=30000)
                say("  old battle finished; its room stays open in the tab")
                if BROWSER != "attach":
                    cdp = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}").new_browser_cdp_session()
                    sws = [t for t in cdp.send("Target.getTargets")["targetInfos"] if t["type"] == "service_worker" and ext_id in t["url"]]
                    for t in sws: cdp.send("Target.closeTarget", {"targetId": t["targetId"]})
                    say("  stopped extension service worker between the battles", len(sws))
                b2 = opponent_page(f"s2oC{tag}"); new = challenge(a, b2, NA, f"s2oC{tag}", TEAM, "new")
                assert any(r == old.room for r in rooms_of(a)), "the old room must stay open"
                def bootstrap_mid(bt, q):
                    if bt is new and bt.step == 3 and not getattr(bt, "_boot", False):
                        bt._boot = True; a.evaluate("r => window.postMessage({ source: 'showdnass', kind: 'bootstrap-request', roomId: r }, '*')", new.room); say("  replayed the new battle mid-game")
                hooks["before"] = bootstrap_mid; hooks["slow_ok"] = lambda bt, q: q["tp"] or bt.step == 3
                play([new], hooks); battles = [old, new]
                states = {r["roomId"]: r for r in live()["rooms"]}
                say("  companion rooms:", json.dumps([{k: r[k] for k in ("roomId", "state", "reason")} for r in live()["rooms"]]))

            elif MODE in ("multi", "capacity"):
                # Tab 1 plays two battles (two rooms, one Showdown tab); tab 2 plays the third.
                a2 = new_tab(); ready(a2); NA2 = f"s2oA2{tag}"; name(a2, NA2)
                a2.evaluate("t => app.send('/utm ' + Storage.packTeam(Storage.importTeam(t)))", TEAM)
                bs = [opponent_page(f"s2o{c}{tag}") for c in "BCD"]
                battles = [challenge(a, bs[0], NA, f"s2oB{tag}", TEAM, "t1r1"), challenge(a, bs[1], NA, f"s2oC{tag}", TEAM, "t1r2"),
                           challenge(a2, bs[2], NA2, f"s2oD{tag}", TEAM, "t2r1")]
                hooks["slow_ok"] = lambda bt, q: q["tp"]
                if MODE == "multi": play(battles, hooks)
                else:
                    waiting = battles[2]
                    play(battles[:2], hooks, until=lambda: all(bt.step >= 2 for bt in battles[:2]))
                    # The third battle is over the limit: its strip must explain the wait, never a bare "unavailable".
                    a2.bring_to_front(); t0 = time.time(); text = ""
                    while time.time() - t0 < 30:
                        opponent(waiting); text = a2.evaluate(f"() => document.querySelector('#room-{waiting.room} [data-s2o=strip]')?.innerText || ''")
                        if re.search(r"busy|limit", text, re.I): break
                        a2.wait_for_timeout(500)
                    say("  over-limit strip:", text.replace("\n", " "))
                    a2.screenshot(path=str(OUT / "t2r1-over-limit.png"))
                    if not re.search(r"busy|limit", text, re.I): fails.append("capacity: the over-limit battle did not explain the wait")
                    act(bs[0], "r => app.send('/forfeit', r)", battles[0].room); battles[0].done = True; say("  battle t1r1 ended: a worker is free")
                    t_free = time.time()
                    hooks["slow_ok"] = lambda bt, q: q["tp"] or (bt is waiting and time.time() - t_free < 40)
                    play([battles[1], waiting], hooks)
                say("  peak concurrent workers:", peak["workers"])
                if MODE == "multi" and peak["workers"] < 3: fails.append(f"multi: only {peak['workers']} workers ever ran together")
                if MODE == "capacity" and peak["workers"] > 2: fails.append(f"capacity: {peak['workers']} workers ran with a limit of 2")

            for bt in battles:
                if not bt.ended():
                    try: act(bt.b, "r => app.send('/forfeit', r)", bt.room, 5000)
                    except Exception: pass
            a.wait_for_timeout(2500)
            for pg in own_pages:  # attach: close only the tabs this run opened
                try: pg.close()
                except Exception: pass
            if BROWSER == "chrome": A.close()
            bb.close()
        finally:
            for pg in own_pages:  # attach: never leave a tab of ours in the owner's browser
                try: pg.close()
                except Exception: pass
finally:
    if attach_restore:
        with sync_playwright() as p2:
            try:
                ws, _ = cdp_ws(args.attach_a); br2 = p2.chromium.connect_over_cdp(ws, timeout=30000)
                set_companion(br2.contexts[0], attach_restore[1], f"http://127.0.0.1:{LIVE_PORT}")
                say(f"attached extension restored to the live companion :{LIVE_PORT} (read back)")
            except Exception as e:
                say(f"RESTORE FAILED: set the extension's companionUrl back to http://127.0.0.1:{LIVE_PORT} by hand ({e})"); fails.append("restore failed")
    if forward: forward.terminate()
    if vivaldi_proc:  # a leftover browser keeps its Showdown tabs, and their guest names, alive for the next run
        vivaldi_proc.terminate()
        try: vivaldi_proc.wait(timeout=15)
        except subprocess.TimeoutExpired: vivaldi_proc.kill(); vivaldi_proc.wait(timeout=15)
    stop_companion()
need = [] if MODE == "guards" else ["forced_switch"] if MODE in ("normal", "multi") else []
if BROWSER in ("chrome", "vivaldi") and MODE == "normal": need += ["tera", "hover"]
for k in need:
    if not covered[k]: fails.append(f"no {k.replace('_', ' ')} decision was checked")
if MODE == "guards" and not guarded: fails.append("no guard line was shown")
if latencies: say(f"pick latency s: median {sorted(latencies)[len(latencies) // 2]:.2f} max {max(latencies):.2f} over {len(latencies)}")
def pct(xs, q): xs = sorted(xs); return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else float("nan")
if timeline:
    (OUT / "timeline.json").write_text(json.dumps(timeline, indent=1))
    for k, base in (("pick", "req"), ("intel", "req"), ("notes", "btn")):
        xs = [(t[k] - t[base]) / 1000 for t in timeline if t.get(k) and t.get(base)]
        say(f"timeline {k} after {base} s: p50 {pct(xs, .5):.2f} p90 {pct(xs, .9):.2f} max {max(xs, default=float('nan')):.2f} over {len(xs)}")
    say(f"timeline: pick or data vanished before the choice in {sum(1 for t in timeline if t['lost'])} of {len(timeline)} decisions")
if peak["rss_mb"]: say(f"worker RSS MB: max {max(peak['rss_mb']):.0f}")
say("coverage:", json.dumps(covered))
say("RESULT", MODE, BROWSER, "PASS" if not fails else f"FAIL {fails}", "guards", guarded, "out", OUT)
sys.exit(0 if not fails else 1)
