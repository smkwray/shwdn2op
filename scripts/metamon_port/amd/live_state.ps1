# Live-worker state on this Windows host, one JSON line per sample (unload/memory proof for
# live_worker.py on amdbox or winbox): live_worker.py python processes (venv launcher + interpreter)
# with working set and private commit, max GPU adapter dedicated memory, host available RAM.
#   ssh HOST "& C:\path\to\shwdn2op\scripts\metamon_port\amd\live_state.ps1 [-Seconds 30] [-IntervalMs 500]"
param([double]$Seconds = 0, [int]$IntervalMs = 500)
$end = (Get-Date).AddSeconds($Seconds)
do {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*live_worker.py*' } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        ForEach-Object { [ordered]@{ pid = $_.Id; ws_mb = [int]($_.WorkingSet64 / 1MB); private_mb = [int]($_.PrivateMemorySize64 / 1MB) } })
    $c = (Get-Counter -Counter '\GPU Adapter Memory(*)\Dedicated Usage', '\Memory\Available MBytes').CounterSamples
    [ordered]@{
        at = (Get-Date -Format o); live_python = $procs.Count; procs = $procs
        gpu_dedicated_mb = [math]::Round(($c | Where-Object Path -like '*dedicated usage' | Measure-Object CookedValue -Maximum).Maximum / 1MB, 1)
        available_mb = ($c | Where-Object Path -like '*available mbytes').CookedValue
    } | ConvertTo-Json -Compress -Depth 3
    if ((Get-Date) -lt $end) { Start-Sleep -Milliseconds $IntervalMs }
} while ((Get-Date) -lt $end)
