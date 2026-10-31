#!/bin/zsh
# (Re)start the companion on this Mac: build, stop the running one, start with the live Metamon launch config and, when
# present, the newest monthly ladder priors (device-local data in tmp/meta-priors). Log: tmp/companion-live.log.
# Usage: zsh scripts/start_companion.sh [LAUNCH_JSON]   (default config/local/metamon-live.json, device-local)
set -eu
cd "$(dirname "$0")/.."
LAUNCH=${1:-config/local/metamon-live.json}
(cd apps/companion && npm run build >/dev/null)
DESC=$(ls tmp/meta-priors/*.descriptor.json 2>/dev/null | sort | tail -1 || true)
P=$(pgrep -f "apps/companion/dist/index.js" || true)
if [ -n "$P" ]; then kill $P; while kill -0 $P 2>/dev/null; do sleep 0.5; done; fi
echo "=== $(date -u +%FT%TZ) start launch=$LAUNCH priors=${DESC:-none}" >> tmp/companion-live.log
nohup env SHWDN2OP_METAMON_LIVE_LAUNCH="$PWD/$LAUNCH" ${DESC:+MOVE_PRIOR_DESCRIPTOR=$PWD/$DESC} node apps/companion/dist/index.js \
  >> tmp/companion-live.log 2>&1 < /dev/null &
for i in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:6127/v1/metamon/live >/dev/null && { echo "companion up (priors: ${DESC:-none})"; exit 0; }; sleep 1; done
echo "companion did not start; see tmp/companion-live.log"; exit 1
