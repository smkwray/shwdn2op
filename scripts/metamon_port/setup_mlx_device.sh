#!/bin/bash
# Run later on the target Mac. All installs, sources, assets and caches stay in tmp/.
set -euo pipefail
if [[ $# != 1 || "$1" == --help ]]; then
  echo "Usage: $0 CHECKPOINT_PATH_OR_SCP_SOURCE"
  echo "Requires native arm64 macOS and Python 3.12 (PYTHON may select it)."
  echo "Example: $0 user@macbox:/path/to/shwdn2op/tmp/metamon-port/ckpt/policy_epoch_34.pt"
  exit 0
fi
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'Native Apple Silicon macOS required' >&2; exit 1; }
PROJECT=$(cd "$(dirname "$0")/../.." && pwd -P)
DEVICE="$PROJECT/tmp/metamon-port"
export TMPDIR="$DEVICE/scratch" PIP_CACHE_DIR="$DEVICE/cache/pip" XDG_CACHE_HOME="$DEVICE/cache/xdg"
export PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
export HF_HOME="$DEVICE/cache/hf" TORCH_HOME="$DEVICE/cache/torch" MPLCONFIGDIR="$DEVICE/cache/matplotlib"
mkdir -p "$TMPDIR" "$PIP_CACHE_DIR" "$DEVICE/ckpt"
PYTHON=${PYTHON:-python3.12}
"$PYTHON" -c 'import platform,sys; assert platform.machine()=="arm64" and sys.version_info[:2]==(3,12), "native Python 3.12 required"'
# Never replace a running model's environment/assets or overlap another setup.
exec 9>"$DEVICE/model.lock"
# macOS has no flock CLI; Python holds the exact same fcntl lock across exec.
exec "$PYTHON" -B - "$PROJECT" "$1" 9 <<'PY'
import fcntl, hashlib, json, os, pathlib, shutil, subprocess, sys, urllib.request, zipfile
root, checkpoint_source = pathlib.Path(sys.argv[1]), sys.argv[2]
out = root / 'tmp/metamon-port'
fd = int(sys.argv[3])
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
# This parent holds the lock throughout all child commands.
checkpoint = out / 'ckpt/policy_epoch_34.pt'
expected = '7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c'
def digest(p):
    with pathlib.Path(p).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()
def run(argv):
    subprocess.run([str(x) for x in argv], cwd=root, check=True)
if not checkpoint.exists():
    partial = checkpoint.with_suffix('.partial')
    if ':' in checkpoint_source:
        # Only a checkpoint transfer: no inference or remote process management.
        run(['scp', '-B', checkpoint_source, partial])
    else:
        shutil.copyfile(checkpoint_source, partial)
    if digest(partial) != expected:
        raise RuntimeError('Copied checkpoint hash mismatch; partial retained for inspection')
    partial.replace(checkpoint)
if digest(checkpoint) != expected:
    raise RuntimeError('Existing checkpoint hash mismatch; refusing to overwrite it')
venv = out / '.venv'
if not venv.exists():
    run([sys.executable, '-m', 'venv', venv])
python = venv / 'bin/python'
run([python, '-m', 'ensurepip'])
# The package lock includes all macbox distributions and exact upstream VCS commits.
# --no-deps prevents upstream unpinned VCS requirements from overriding them.
run([python, '-m', 'pip', 'install', '--no-deps', '-r', root / 'scripts/metamon_port/requirements-mlx.txt'])
# Metamon is the project's fork (vendor/metamon); only its large upstream data files come from the upstream archive.
fork = out / 'fork'
if not fork.exists():
    data = out / 'upstream-data'
    archive = out / 'metamon-0a00a759.zip'
    if not archive.exists():
        urllib.request.urlretrieve('https://codeload.github.com/UT-Austin-RPL/metamon/zip/0a00a759c9a4382a2877088d828302ec294a05a5', archive)
    with zipfile.ZipFile(archive) as z:
        prefix = 'metamon-0a00a759c9a4382a2877088d828302ec294a05a5/'
        # Extract only the fork's hash-listed data files, never arbitrary archive paths.
        for line in (root / 'vendor/metamon/data.sha256').read_text().splitlines():
            sha, name = line.split('  ', 1)
            blob = z.read(prefix + name)
            if hashlib.sha256(blob).hexdigest() != sha:
                raise RuntimeError(f'Pinned data mismatch: {name}')
            target = data / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(blob)
    fork.mkdir()
    pin = json.loads((root / 'scripts/uu_selfplay/source-pins.json').read_text())['metamon']['tree_sha256']
    run([python, '-I', root / 'vendor/metamon/assemble.py', 'build', fork, '--data-from', data, '--expect', pin])
# Original runtime checks remain mandatory: fork tree pin and installed VCS provenance.
run([python, '-B', '-c', '''import sys
sys.path.insert(0, 'tmp/metamon-port/fork')
sys.path.insert(0, 'scripts/metamon_port')
from common import setup, CHECKPOINT
setup('mlx')
from mlx_worker import worker_module
worker_module().check_runtime(CHECKPOINT)
'''])
weights = out / 'kakuna-fp32.safetensors'
if not weights.exists():
    run([python, '-B', '-c', '''import sys
sys.path.insert(0, 'scripts/metamon_port')
from common import setup, CHECKPOINT, OUT
setup('mlx')
from mlx_kakuna import convert
convert(CHECKPOINT, OUT / 'kakuna-fp32.safetensors')
'''])
metadata = json.loads(weights.with_suffix('.json').read_text())
if metadata['checkpoint_sha256'] != expected or metadata['weights_sha256'] != digest(weights):
    raise RuntimeError('Converted weights provenance mismatch')
launch = {'command': str(python), 'args': ['-B', '-u', str(root / 'scripts/metamon_port/mlx_worker.py'),
    '--checkpoint', str(checkpoint), '--seed', '{seed}', '--seed-per-side'],
    'workerSha256': '917558eddf56e58dd1cd05332974df11d937549542fc4bc3674c8323d05ab5e9'}
config = out / 'metamon-live-mlx.json'
config.write_text(json.dumps(launch, indent=2) + '\n')
print(f'Ready for local qualification. Launch config: {config}')
print('No companion was started or restarted. Run the live parity tests before enabling.')
PY
