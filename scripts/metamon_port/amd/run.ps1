# Run one kakuna_port.py job on amdbox with GPU/host memory sampling and an unload proof.
# Usage: pwsh -NoProfile -File run.ps1 -Tag gpu -HarnessArgLine "replay --device cuda ..." (no spaces in paths)
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$HarnessArgLine
)
$HarnessArgs = @($HarnessArgLine.Trim() -split '\s+')
$ErrorActionPreference = 'Stop'
$T = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'tmp\metamon-amd'  # project tmp/
$Py = Join-Path $T 'venv\Scripts\python.exe'
$Harness = Join-Path $T 'harness\kakuna_port.py'
$Logs = Join-Path $T 'logs'
$env:TEMP = Join-Path $T 'scratch'
$env:TMP = $env:TEMP
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONUTF8 = '1'

function Get-GpuMem {
    $c = Get-Counter -Counter '\GPU Adapter Memory(*)\Dedicated Usage', '\GPU Adapter Memory(*)\Shared Usage' -ErrorAction SilentlyContinue
    $o = [ordered]@{}
    foreach ($s in $c.CounterSamples) {
        $kind = if ($s.Path -like '*dedicated usage') { 'dedicated' } else { 'shared' }
        $o["$($s.InstanceName)|$kind"] = [math]::Round($s.CookedValue / 1MB, 1)
    }
    $o
}
function Get-ProcGpuMem([int[]]$Pids) {
    $c = Get-Counter -Counter '\GPU Process Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Shared Usage' -ErrorAction SilentlyContinue
    $d = 0.0; $s = 0.0
    foreach ($x in $c.CounterSamples) {
        foreach ($p in $Pids) {
            if ($x.InstanceName -like "pid_$($p)_*") {
                if ($x.Path -like '*dedicated usage') { $d += $x.CookedValue } else { $s += $x.CookedValue }
            }
        }
    }
    @{ dedicated_mb = [math]::Round($d / 1MB, 1); shared_mb = [math]::Round($s / 1MB, 1) }
}
function Get-OurPython {
    @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*kakuna_port.py*' } |
        Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine)
}

$before = Get-OurPython
if ($before.Count -gt 0) { throw "kakuna_port.py processes already running: $($before.ProcessId -join ',')" }
$baseline = Get-GpuMem
$stdout = Join-Path $Logs "$Tag.stdout.log"
$stderr = Join-Path $Logs "$Tag.stderr.log"
$argList = @('-X', 'utf8', $Harness) + $HarnessArgs
$start = Get-Date
$proc = Start-Process -FilePath $Py -ArgumentList $argList -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$ours = @($proc.Id)
$peakDed = 0.0; $peakShared = 0.0; $peakWs = 0.0; $samples = 0
while (-not $proc.HasExited) {
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" | Select-Object -ExpandProperty ProcessId)
    $ours = @($proc.Id) + $kids | Select-Object -Unique
    $g = Get-ProcGpuMem $ours
    if ($g.dedicated_mb -gt $peakDed) { $peakDed = $g.dedicated_mb }
    if ($g.shared_mb -gt $peakShared) { $peakShared = $g.shared_mb }
    foreach ($p in $ours) {
        $pp = Get-Process -Id $p -ErrorAction SilentlyContinue
        if ($pp -and ($pp.PeakWorkingSet64 / 1MB) -gt $peakWs) { $peakWs = [math]::Round($pp.PeakWorkingSet64 / 1MB, 1) }
    }
    $samples++
    Start-Sleep -Milliseconds 500
}
$proc.WaitForExit()
$exit = $proc.ExitCode
$elapsed = ((Get-Date) - $start).TotalSeconds
Start-Sleep -Seconds 5
$after = Get-OurPython
$stillAlive = @($ours | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
$afterGpu = Get-GpuMem
$delta = [ordered]@{}
foreach ($k in $baseline.Keys) { if ($afterGpu.Contains($k)) { $delta[$k] = [math]::Round($afterGpu[$k] - $baseline[$k], 1) } }
$result = [ordered]@{
    tag = $Tag; args = $HarnessArgs; exit_code = $exit; elapsed_s = [math]::Round($elapsed, 1)
    pids = $ours; sampler_samples = $samples
    proc_gpu_peak_dedicated_mb = $peakDed; proc_gpu_peak_shared_mb = $peakShared; proc_peak_working_set_mb = $peakWs
    gpu_adapter_baseline_mb = $baseline; gpu_adapter_after_mb = $afterGpu; gpu_adapter_delta_mb = $delta
    our_python_after = $after; our_pids_still_alive = $stillAlive
}
$result | ConvertTo-Json -Depth 5 | Out-File -LiteralPath (Join-Path $Logs "$Tag.run.json") -Encoding utf8
$result | ConvertTo-Json -Depth 5
if ($exit -ne 0) { Get-Content -LiteralPath $stderr -Tail 40 }
