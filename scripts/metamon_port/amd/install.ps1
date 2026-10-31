# Device-local Kakuna inference venv for native Windows GPUs. Everything lands under -Target (a dir
# in the project's ignored tmp\): uv-managed CPython, venv, pip/uv caches, pinned metamon source.
# Process-local env only: no PATH, registry, driver or system Python changes.
#   amdbox (AMD gfx1151, PyTorch ROCm for Windows):
#     -Target C:\path\to\shwdn2op\tmp\metamon-amd -TorchIndex https://stable.repo.amd.com/rocm/whl-next/
#     -TorchSpec 'torch[device-gfx1151]==2.11.0+rocm10.0.0' -Python 3.12.14
#   winbox (NVIDIA RTX 5060 Ti sm_120, production's CUDA 13.0 build):
#     -Target C:\path\to\shwdn2op\tmp\metamon-cuda -TorchIndex https://download.pytorch.org/whl/cu130
#     -TorchSpec 'torch==2.11.0+cu130' -Python 3.12.3
param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$TorchIndex,
    [Parameter(Mandatory = $true)][string]$TorchSpec,
    [Parameter(Mandatory = $true)][string]$Python
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$T = $Target
$Venv = Join-Path $T 'venv'
$Py = Join-Path $Venv 'Scripts\python.exe'
New-Item -ItemType Directory -Force -Path (Join-Path $T 'logs'), (Join-Path $T 'scratch') | Out-Null
$Log = Join-Path $T 'logs\install.log'
# Every step after torch holds torch at the installed build.
$Constraints = Join-Path $T 'logs\constraints.txt'
'torch==' + ($TorchSpec -replace '^torch(\[[^\]]*\])?==', '') | Out-File -LiteralPath $Constraints -Encoding ascii

$env:PIP_CACHE_DIR = Join-Path $T 'cache\pip'
$env:UV_CACHE_DIR = Join-Path $T 'cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $T 'python'
$env:UV_PYTHON_DOWNLOADS = 'manual'
$env:TEMP = Join-Path $T 'scratch'
$env:TMP = $env:TEMP
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONNOUSERSITE = '1'
# Git for Windows is installed but not on the ssh PATH; pip needs it for the pinned VCS installs.
$env:PATH = 'C:\Program Files\Git\cmd;' + $env:PATH
# Upstream LF bytes in every clone (pip's VCS installs included), whatever the user's core.autocrlf.
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'core.autocrlf'
$env:GIT_CONFIG_VALUE_0 = 'false'

function Step([string]$Name, [scriptblock]$Body) {
    "==== $(Get-Date -Format o) $Name" | Out-File -LiteralPath $Log -Append -Encoding utf8
    & $Body 2>&1 | Out-File -LiteralPath $Log -Append -Encoding utf8
}

if (-not (Test-Path -LiteralPath $Py)) {
    # uv-managed CPython inside -Target only: no bin shims, no PEP 514 registry entries.
    Step 'python' { uv python install $Python --no-bin --no-registry }
    Step 'venv' { uv venv --managed-python --python $Python --seed $Venv }
}
# 1. torch from the vendor's official index.
Step 'torch' { & $Py -m pip install --index-url $TorchIndex $TorchSpec }
# 2. Production's frozen dependency set (gpubox venv minus CUDA/Triton/torch/uv/VCS), torch held fixed.
Step 'prod-deps' { & $Py -m pip install -c $Constraints -r (Join-Path $PSScriptRoot 'requirements-prod.txt') }
# 3. amago/metamon/poke-env at production's exact commits; --no-deps so metamon's unpinned
#    poke-env and amago@v3.4.0 URLs cannot override the pins.
Step 'vcs-pins' { & $Py -m pip install --no-deps -c $Constraints -r (Join-Path $PSScriptRoot 'requirements-vcs.txt') }
Step 'pip-check' { & $Py -m pip check }
# 4. As production (scripts/metamon-runtime.py bootstrap): the metamon wheel omits gin,
#    tokenizer and JSON assets, so metamon is imported from the identical pinned source.
$Src = Join-Path $T 'source'
$Commit = '0a00a759c9a4382a2877088d828302ec294a05a5'
if (-not (Test-Path -LiteralPath (Join-Path $Src '.git'))) {
    Step 'metamon-source' {
        git init $Src
        git -C $Src config core.autocrlf false
        git -C $Src remote add origin https://github.com/UT-Austin-RPL/metamon.git
        git -C $Src fetch --depth=1 origin $Commit
        git -C $Src checkout --detach $Commit
    }
}
$head = (git -C $Src rev-parse HEAD).Trim()
$dirty = git -C $Src status --porcelain
if ($head -ne $Commit -or $dirty) { throw "metamon source checkout is not the clean pinned commit" }
"metamon source $head clean" | Out-File -LiteralPath $Log -Append -Encoding utf8
& $Py -m pip freeze --all | Out-File -LiteralPath (Join-Path $T 'logs\pip-freeze.txt') -Encoding utf8
"install ok" | Out-File -LiteralPath $Log -Append -Encoding utf8
"install ok"
