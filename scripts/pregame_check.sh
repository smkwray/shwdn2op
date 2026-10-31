#!/bin/zsh
# One command before the owner plays: the full real-browser matrix on the current code, a PASS/FAIL table and a receipt.
# Usage: zsh scripts/pregame_check.sh [--browsers "chrome vivaldi"] [--modes "normal ..."] [--remote USER@HOST]
#                                    [--attach-cdp URL] [--server local|public] [--jobs N]
#   --server local       (default; the pre-deploy gate: 10 minutes at most) the matrix against an owned
#                        loopback Showdown server (pinned master, TLS so the client uses SockJS as on the public one),
#                        --jobs modes at once (default 4), each with its own test companion. Same public client page,
#                        extension and protocol; the attach test still runs on the public server.
#   --server public      the same matrix on play.pokemonshowdown.com, one mode a minute (its rate limit): ~19 minutes.
#                        The real-server cross-check, e.g. after moving the local server pin.
#   --remote USER@HOST   another machine whose synced extension files and companion tunnel are compared, read-only
#                        (reported, never decisive). Also PREGAME_REMOTE.
#   --attach-cdp URL     the owner's play browser's DevTools endpoint as reached from here (an SSH forward): runs the
#                        DECIDING attach test there (needs --remote for the test-companion forward). Also PREGAME_ATTACH_CDP.
#                        Only with the owner's go for that browser.
# Refuses while the live companion (127.0.0.1:6127) has a battle in progress: e2e workers compete for the model.
# Receipt: tmp/pregame/<UTC stamp>.json (git status hash, content hashes of the files exercised, every result).
set -u
cd "$(dirname "$0")/.."
BROWSERS="chrome"
# The two modes that sign in five guest names run first and last: back to back, Showdown refused guest renames.
MODES="capacity normal team4 swkill idle reload guards samesession-replay companion-restart ext-reload stale-room worker-stall multi"
REMOTE=${PREGAME_REMOTE:-}; ATTACH=${PREGAME_ATTACH_CDP:-}; SERVER=local; JOBS=
while [ $# -gt 0 ]; do
  case $1 in
    --browsers) BROWSERS=$2; shift 2;; --modes) MODES=$2; shift 2;;
    --remote) REMOTE=$2; shift 2;; --attach-cdp) ATTACH=$2; shift 2;;
    --server) SERVER=$2; shift 2;; --jobs) JOBS=$2; shift 2;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
case $SERVER in public) JOBS=1;; local) JOBS=${JOBS:-4};;
  *) echo "--server public|local"; exit 2;; esac
T0=$(date +%s); STAMP=$(date -u +%Y%m%dT%H%M%SZ); OUTDIR=tmp/pregame; mkdir -p $OUTDIR; RESULTS=$OUTDIR/$STAMP.results; : > $RESULTS
live_busy() { curl -s -m 3 http://127.0.0.1:6127/v1/metamon/live | python3 -c 'import json,sys
try: rooms = json.load(sys.stdin).get("rooms", [])
except Exception: print("live-status-unknown"); sys.exit(0)
busy = [r["roomId"] for r in rooms if r.get("state") in ("ready", "warming")]
print(" ".join(busy)); sys.exit(0 if busy else 1)'; }
if busy=$(live_busy); then echo "REFUSED: the live companion has an active battle ($busy). Run this when no game is in progress."; exit 3; fi
WRAP=(); command -v remrun >/dev/null && WRAP=(remrun observe --label "pregame e2e $SERVER" --)
(cd apps/companion && npm run build >/dev/null) || { echo "companion build failed"; exit 4; }
# Pinned smogon/pokemon-showdown master: the npm release (July) rejects today's client choices outright.
PS_PIN=c0845f33d381402dfcb18ce324c20a94f18af075
PSD=tmp/e2e-ps; PS=$PSD/pokemon-showdown; PS_PID=; SRV_ARGS=()
freeport() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
stop_server() { [ -n "$PS_PID" ] && { kill -TERM -- -$PS_PID 2>/dev/null; sleep 2; kill -KILL -- -$PS_PID 2>/dev/null; }; PS_PID=; }
if [ $SERVER = local ]; then
  if [ "$(git -C $PS rev-parse HEAD 2>/dev/null)" != $PS_PIN ] || [ ! -s $PS/dist/server/room-battle.js ]; then
    rm -rf $PS && mkdir -p $PS && git -C $PS init -q && git -C $PS fetch -q --depth 1 https://github.com/smogon/pokemon-showdown $PS_PIN \
      && git -C $PS checkout -q FETCH_HEAD && (cd $PS && npm ci --no-audit --no-fund --omit=dev >/dev/null && node build >/dev/null) \
      || { echo "server build failed"; exit 4; }
  fi
  # play.pokemonshowdown.com signs every /choose rqid ("|5.<hex>", a site script wrapping app.send) and its server accepts
  # that; the open-source server does not. The test server reads the rqid before the signature. Nothing else is changed.
  python3 - $PS/dist/server/room-battle.js <<'PY' || { echo "server patch failed"; exit 4; }
import sys; p = sys.argv[1]; s = open(p).read(); a = 'const [choice, rqid] = data.split("|", 2);'
b = 'const [choice, signedRqid] = data.split("|", 2); const rqid = signedRqid?.replace(/\\.[0-9a-f]+$/, ""); /* e2e: public-site choice signature */'
if b not in s: assert s.count(a) == 1, "choose() changed upstream"; open(p, "w").write(s.replace(a, b))
PY
  [ -s $PSD/tls/key.pem ] || { mkdir -p $PSD/tls && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=127.0.0.1 \
    -addext subjectAltName=IP:127.0.0.1 -keyout $PSD/tls/key.pem -out $PSD/tls/cert.pem 2>/dev/null; } || { echo "TLS key failed"; exit 4; }
  HP=$(freeport); TP=$(freeport)
  # Loopback only; a port on the command line would switch TLS off. cloud-env, when resolvable, reads BIND_IP/PORT.
  { cat $PS/config/config-example.js; printf '\nexports.port = %s;\nexports.bindaddress = "127.0.0.1";\nexports.watchconfig = false;\nexports.repl = false;\nexports.ssl = {port: %s, options: {key: "%s", cert: "%s"}};\n' \
    $HP $TP $PWD/$PSD/tls/key.pem $PWD/$PSD/tls/cert.pem; } > $PS/config/config.js
  mkdir -p $PS/logs/{repl,chat,modlog,tickets} $PS/config/chat-plugins
  (cd $PS && BIND_IP=127.0.0.1 PORT=$HP exec python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    node pokemon-showdown start --skip-build --no-security) > tmp/pregame/$STAMP-server.log 2>&1 &
  PS_PID=$!; trap stop_server EXIT; trap 'exit 130' INT TERM
  for i in {1..60}; do curl -sk -m 2 https://127.0.0.1:$TP/showdown/info | grep -q websocket && break; sleep 1; done
  OPEN=$(lsof -nP -a -g $PS_PID -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $(NF-1)}' | sort -u | tr '\n' ' ')
  case "$OPEN" in *127.0.0.1:$TP*) ;; *) echo "local server did not come up on 127.0.0.1:$TP (see tmp/pregame/$STAMP-server.log)"; exit 4;; esac
  for a in ${=OPEN}; do [[ $a == 127.0.0.1:* ]] || { echo "local server listens beyond loopback ($a)"; exit 4; }; done
  SRV_ARGS=(--server https://127.0.0.1:$TP)
  # Longest first: the matrix then takes about as long as its longest mode.
  ORDER=(idle companion-restart multi capacity stale-room worker-stall reload); M=(${=MODES}); MODES="${(j: :)${ORDER:*M}} ${(j: :)${M:|ORDER}}"
fi
LAST_START=0; PORTN=0; PIDS=()
run() {  # browser mode [extra args...]
  local b=$1 m=$2; shift 2
  # Public: even three-battle modes cannot exceed Showdown's ~12 battles / 3 min window. Local: no such limit.
  while [ $SERVER = public ] && (( $(date +%s) - LAST_START < 60 )); do sleep 5; done
  if busy=$(live_busy); then echo "$b $m SKIPPED live-battle-started($busy)" >> $RESULTS; return; fi
  LAST_START=$(date +%s)
  local log=$OUTDIR/$STAMP-$b-$m.log
  "${WRAP[@]}" python3 scripts/extension_e2e.py $m 7 "$@" > $log 2>&1
  local line=$(grep '^RESULT' $log | tail -1)
  if [ -z "$line" ]; then line="RESULT $m $b FAIL (no result line; crashed: $(tail -1 $log | cut -c1-160))"; fi
  echo "$b $m $(echo $line | awk '{print $4}') $(echo $line | cut -c1-400)" >> $RESULTS
}
for b in ${=BROWSERS}; do for m in ${=MODES}; do
  if [ $SERVER = public ]; then run $b $m --browser $b; continue; fi
  while (( $(for q in $PIDS; do kill -0 $q 2>/dev/null && echo; done | wc -l) >= JOBS )); do sleep 2; done
  run $b $m --browser $b $SRV_ARGS --test-port $((6130 + PORTN)) & PIDS+=($!); PORTN=$((PORTN + 1))
done; done
wait $PIDS 2>/dev/null; stop_server
if [ -n "$ATTACH" ] && [ -n "$REMOTE" ]; then
  for m in normal stale-room; do run attach $m --attach-a "$ATTACH" --attach-forward "$REMOTE"; done
fi
# Remote checks: reported, never decisive.
REMOTE_NOTE="not checked (no --remote)"; TUNNEL_NOTE="not checked (no --remote)"
if [ -n "$REMOTE" ]; then
  REL=${PWD#$HOME/}
  LOCAL_H=$(cd apps/extension && find . -type f \( -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.css' \) | sort | xargs shasum -a 256)
  REMOTE_H=$(ssh -o BatchMode=yes -o ConnectTimeout=8 $REMOTE "cd '$REL/apps/extension' && find . -type f \( -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.css' \) | sort | xargs shasum -a 256" 2>&1)
  if [ "$LOCAL_H" = "$REMOTE_H" ]; then REMOTE_NOTE="extension files identical ($(echo $LOCAL_H | wc -l | tr -d ' ') files)"
  else REMOTE_NOTE="DIFFERENT: $(diff <(echo $LOCAL_H) <(echo $REMOTE_H) | grep '^[<>]' | head -6 | tr '\n' ';')"; fi
  T=$(ssh -o BatchMode=yes -o ConnectTimeout=8 $REMOTE "curl -s -m 3 http://127.0.0.1:6127/v1/metamon/live" 2>&1 | head -c 200)
  case $T in *'"ok":true'*) TUNNEL_NOTE="answers (remote 127.0.0.1:6127 reaches this companion)";; *) TUNNEL_NOTE="NOT answering: $T";; esac
fi
python3 - "$RESULTS" "$STAMP" "$REMOTE_NOTE" "$TUNNEL_NOTE" "$ATTACH" "$SERVER" "$JOBS" "$PS_PIN" "$(( $(date +%s) - T0 ))" <<'PY'
import hashlib, json, pathlib, subprocess, sys
results, stamp, remote_note, tunnel_note, attach, server, jobs, pin, wall = sys.argv[1:10]
rows = [l.split(" ", 3) for l in pathlib.Path(results).read_text().splitlines() if l.strip()]
files = sorted([*pathlib.Path("apps/extension").rglob("*.js"), *pathlib.Path("apps/extension").glob("*.json"), *pathlib.Path("apps/extension").glob("*.html"),
                *pathlib.Path("apps/companion/src").rglob("*.ts"), pathlib.Path("config/local/metamon-live.json"),
                pathlib.Path("scripts/extension_e2e.py"), pathlib.Path("scripts/metamon_port/mlx_worker.py")])
files = [f for f in files if "/test/" not in str(f) and not f.name.endswith(".test.js")]
status = subprocess.run(["git", "status", "--porcelain=v1", "-uall"], capture_output=True, text=True).stdout
head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
receipt = {"stamp": stamp, "head": head, "gitStatusSha256": hashlib.sha256(status.encode()).hexdigest(),
           "files": {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in files},
           "results": [{"browser": r[0], "mode": r[1], "verdict": r[2], "line": r[3] if len(r) > 3 else ""} for r in rows],
           "remoteExtensionFiles": remote_note, "remoteTunnel": tunnel_note,
           "server": "public (play.pokemonshowdown.com)" if server == "public" else f"local smogon/pokemon-showdown {pin} (loopback, TLS, choice-signature strip)", "jobs": int(jobs),
           "wallSeconds": int(wall), "budgetSeconds": 600}
local_ok = all(r[2] == "PASS" for r in rows if r[0] != "attach")
attach_rows = [r for r in rows if r[0] == "attach"]
receipt["deciding"] = ("PASS" if attach_rows and all(r[2] == "PASS" for r in attach_rows) else "FAIL") if attach else "NOT RUN"
receipt["verdict"] = "CLEARED" if rows and local_ok and receipt["deciding"] == "PASS" else "NOT CLEARED"
out = pathlib.Path(f"tmp/pregame/{stamp}.json"); out.write_text(json.dumps(receipt, indent=1))
print(f"{'browser':9} {'mode':20} result")
for r in rows: print(f"{r[0]:9} {r[1]:20} {r[2]}")
print(f"\nremote extension files: {remote_note}\nremote tunnel: {tunnel_note}")
print(f"deciding attach test (owner's play browser): {receipt['deciding']}")
print(f"wall {wall} s of a 600 s budget{' OVER BUDGET' if int(wall) > 600 else ''}; server {receipt['server']}")
print(f"VERDICT: {receipt['verdict']}  receipt {out}")
sys.exit(0 if receipt["verdict"] == "CLEARED" else 1)
PY
