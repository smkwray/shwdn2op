#!/bin/zsh
# Deploy a frozen copy of the extension for a play browser. The play browser must never load apps/extension directly:
# that folder is the synced working tree other sessions edit, so any browser restart would pick up untested code (an
# in-progress extension against an older companion can lose its speed line).
# Usage: zsh scripts/deploy_extension.sh HOST|local [GIT_REF]
#   GIT_REF given: deploy apps/extension exactly as committed there.
#   No GIT_REF: deploy the working tree only if every extension file matches the newest browser-gate receipt
#   (tmp/pregame/*.json "files"), i.e. exactly what the gate tested.
# Writes <project>/tmp/deployed-extension on HOST (device-local, unsynced) atomically, with DEPLOYED.txt naming the
# source. Reload the extension in the play browser afterwards (no tab refresh needed).
set -eu
cd "$(dirname "$0")/.."
HOST=${1:?usage: deploy_extension.sh HOST|local [GIT_REF]} REF=${2:-}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
if [ -n "$REF" ]; then
  git archive "$REF" apps/extension | tar -x -C "$stage"
  src="git $REF ($(git rev-parse --short "$REF"))"
else
  receipt=$(ls -t tmp/pregame/*.json 2>/dev/null | head -1)
  [ -n "$receipt" ] || { echo "no browser-gate receipt; pass a GIT_REF"; exit 1; }
  python3 - "$receipt" <<'PY' || exit 1
import hashlib, json, pathlib, sys
files = {k: v for k, v in json.load(open(sys.argv[1]))["files"].items() if k.startswith("apps/extension/")}
if not files: sys.exit("receipt lists no extension files")
bad = [k for k, v in files.items() if not pathlib.Path(k).exists() or hashlib.sha256(pathlib.Path(k).read_bytes()).hexdigest() != v]
if bad: sys.exit(f"working tree differs from the gated files ({len(bad)}), e.g. {bad[:3]}; run the gate or pass a GIT_REF")
PY
  mkdir -p "$stage/apps" && cp -R apps/extension "$stage/apps/extension"
  src="working tree gated by $(basename "$receipt")"
fi
find "$stage/apps/extension" -name '*.test.js' -delete
print -r -- "$src deployed $(date -u +%FT%TZ)" > "$stage/apps/extension/DEPLOYED.txt"
if [ "$HOST" = local ]; then
  rm -rf tmp/deployed-extension.new && cp -R "$stage/apps/extension" tmp/deployed-extension.new
  rm -rf tmp/deployed-extension.old; [ ! -e tmp/deployed-extension ] || mv tmp/deployed-extension tmp/deployed-extension.old
  mv tmp/deployed-extension.new tmp/deployed-extension
else
  P=$(ssh -o BatchMode=yes "$HOST" 'cd ~/malus/proj/shwdn2op && pwd')
  tar -C "$stage/apps" -cf - extension | ssh -o BatchMode=yes "$HOST" "cd '$P/tmp' && rm -rf deployed-extension.new && mkdir deployed-extension.new && tar -x -C deployed-extension.new --strip-components=1 && rm -rf deployed-extension.old && { [ ! -e deployed-extension ] || mv deployed-extension deployed-extension.old; } && mv deployed-extension.new deployed-extension && cat deployed-extension/DEPLOYED.txt"
fi
echo "deployed: $src → $HOST"
