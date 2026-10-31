#!/bin/bash
# GPU/process receipt for a run dir: owned self-play processes (by executable) and CUDA compute apps.
source "$1/env.sh"
echo "at $(date -u +%FT%TZ) host $(hostname)"
command -v nvidia-smi >/dev/null && echo "compute-apps: $(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | tr '\n' ';')"
echo "owned: $(ps -eo pid=,args= | awk -v py="$PY" '($2 == py && /serve_model|run_bounded/) || /node pokemon-showdown start/' | grep -v awk | cut -c1-110 | tr '\n' ';')"
free -m 2>/dev/null | awk 'NR==2{print "mem used_mb "$3" avail_mb "$7}'
