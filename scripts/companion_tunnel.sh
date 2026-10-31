#!/bin/zsh
# Use the live companion running on another machine from this machine's browser. The companion listens only on
# loopback, so this forwards 127.0.0.1:6127 here to 127.0.0.1:6127 on HOST over SSH, and reconnects after sleep or a
# network change. The extension keeps its default companion URL (http://127.0.0.1:6127).
# Usage: nohup zsh scripts/companion_tunnel.sh USER@HOST >/dev/null 2>&1 &      Stop: pkill -f companion_tunnel.sh
set -u
target=${1:?usage: companion_tunnel.sh USER@HOST}
while true; do
  ssh -N -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    -L 127.0.0.1:6127:127.0.0.1:6127 "$target"
  sleep 5
done
