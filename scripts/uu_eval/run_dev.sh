#!/bin/zsh
# Full dev paired evaluation of one eval-host-exported candidate: prepare, run, verify, analyze; writes tmp/uu-eval-dev-*/DONE.
# Usage: zsh scripts/uu_eval/run_dev.sh EXPORT RUN EPOCH SHA256 ADMISSION_GIB SWAP_TOLERANCE_MIB
set -euo pipefail
cd "$(dirname "$0")/../.."  # project root, or a frozen eval snapshot of it (tmp/uu-eval-src-*)
candidate_export=$1 candidate_run=$2 candidate_epoch=$3 candidate_sha=$4 admission=$5 swaptol=$6
cohort_out=$(python3 -B - "$candidate_run" "$candidate_epoch" "$candidate_sha" <<'PY'
import datetime,json,re,sys
from pathlib import Path
run,epoch,sha=sys.argv[1:]
assert re.fullmatch(r'[A-Za-z0-9_-]+',run) and re.fullmatch(r'[0-9]+',epoch) and re.fullmatch(r'[0-9a-f]{64}',sha)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
out=Path('tmp')/f'uu-eval-dev-{run}-e{epoch}-{sha[:12]}-{stamp}'
r=json.loads(Path('config/local/uu-eval-runtime.json').read_text())
r['remoteRoot']=r['project']+'/tmp/'+out.name
with Path(str(out)+'-runtime.json').open('x') as f:json.dump(r,f,indent=2)
print(out)
PY
)
echo "cohort $cohort_out"
python3 -B scripts/uu_eval/evaluate.py prepare --out "$cohort_out" --runtime "${cohort_out}-runtime.json" --candidate "$candidate_export" --run "$candidate_run" --epoch "$candidate_epoch" --sha256 "$candidate_sha" --admission-gib "$admission" --swap-tolerance-mib "$swaptol"
python3 -B scripts/uu_eval/evaluate.py run "$cohort_out"
python3 -B scripts/uu_eval/verify.py "$cohort_out"
python3 -B scripts/uu_eval/analyze.py "$cohort_out"
date -u +%FT%TZ > "$cohort_out/DONE"
