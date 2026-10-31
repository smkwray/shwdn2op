"""One bounded UU self-play block on Windows or macOS: run_bounded.py + tail_guard.sh +
server.sh + observe.sh semantics for hosts without setsid/Unix process groups (Windows) or
GNU tools (macOS). Reads RUN/env.json from setup_run_portable.py.

Usage: python block_portable.py --run RUN --block w1 --workers 4 --challenges 10 --seconds 3600
  [--grace 30] [--lone-seconds 60] [--mem-start-min 40] [--mem-stop-below 35] [--device cpu|mps|cuda]
  [--min-available-gb 6] [--start-available-gb 10]

Ownership: every process tree (the Showdown server and each serve_model) lives in its own
container: a Windows Job Object (kill-on-close; descendants inherit membership) or a POSIX
session (start_new_session). Finite jobs, no restart, no discovery-based killing; cleanup
always terminates the whole container, even after success, then verifies it is empty.
Tail guard: a worker left alone (all peers exited 0) for --lone-seconds has no possible
opponent and is stopped; it counts as tail-stopped, not failed. macOS memory guard: refuse
to start below --mem-start-min, stop the block if memory_pressure free% < --mem-stop-below.
Any host: refuse to start below --start-available-gb and stop the block if available RAM < --min-available-gb
(Windows has no memory_pressure).
Accounts are UU<block><letter> (e.g. UUw1A), all epoch-34 UUKakuna at temperatures cycling 1.0/1.25/1.5.
League mode (--league LEAGUE.yaml, a Metamon ladder config; --workers is then the account count it expands
to): accounts are UU<block><agent key>[n] with the agent's own model, checkpoints, temperatures and team set,
launched through league_serve.py; `baseline:` accounts write no trajectories and are validated as the single
expected opponent POV. --export-dir sets UU_EXPORT_DIR for UUExport agents. Writes RUN/<block>-jobs.json, ladder-<block>.yaml,
logs/<block>-{before,after,lifecycle,validate}.json and per-job logs; exit 0 only when the
block completed, every container is empty, port 8000 is closed and the pile validates clean.
A block starts only when RUN/source/metamon is the pinned Metamon fork tree (source-pins.json); the manifest records it.
"""

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import socket
import subprocess
import sys
import time

import psutil

from setup_run_portable import assembler

K = Path(__file__).resolve().parent
WIN = os.name == "nt"
MAC = sys.platform == "darwin"
PORT = 8000
TEMPS = [1.0, 1.25, 1.5]  # cycled by account, as block.sh

if WIN:
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    for fn in ("SetInformationJobObject", "QueryInformationJobObject"):
        getattr(k32, fn).argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD) + \
            ((ctypes.c_void_p,) if fn.startswith("Query") else ())
    k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    k32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    ntdll.NtResumeProcess.argtypes = (wintypes.HANDLE,)

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]

    class BASIC_LIMIT(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [("Basic", BASIC_LIMIT), ("Io", IO_COUNTERS), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    class ACCOUNTING(ctypes.Structure):
        _fields_ = [("TotalUserTime", ctypes.c_int64), ("TotalKernelTime", ctypes.c_int64),
                    ("ThisPeriodTotalUserTime", ctypes.c_int64), ("ThisPeriodTotalKernelTime", ctypes.c_int64),
                    ("TotalPageFaultCount", wintypes.DWORD), ("TotalProcesses", wintypes.DWORD),
                    ("ActiveProcesses", wintypes.DWORD), ("TotalTerminatedProcesses", wintypes.DWORD)]


def resident_bytes(process):
    """An exited owned process has no current RSS; other sampling errors remain fatal."""
    try:
        return process.memory_info().rss if process.is_running() else None
    except psutil.NoSuchProcess:
        return None


class Container:
    """One owned process tree: Windows Job Object, or POSIX session/process group."""

    def __init__(self, name, argv, cwd, log_path, env):
        self.name = name
        self.log = open(log_path, "xb")
        kw = dict(cwd=cwd, stdout=self.log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env)
        if WIN:
            self.job = k32.CreateJobObjectW(None, None)
            if not self.job:
                raise ctypes.WinError(ctypes.get_last_error())
            info = EXTENDED_LIMIT()
            info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(self.job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            # Suspended until it is in the job, so no descendant can escape membership.
            self.proc = subprocess.Popen(argv, creationflags=0x4 | 0x200, **kw)  # SUSPENDED | NEW_PROCESS_GROUP
            if not k32.AssignProcessToJobObject(self.job, int(self.proc._handle)):
                err = ctypes.WinError(ctypes.get_last_error())
                self.proc.kill()
                raise err
            if ntdll.NtResumeProcess(int(self.proc._handle)) != 0:
                raise OSError("NtResumeProcess failed")
        else:
            self.proc = subprocess.Popen(argv, start_new_session=True, **kw)
        self.pid = self.proc.pid

    def _query(self, cls, struct):
        info = struct()
        if not k32.QueryInformationJobObject(self.job, cls, ctypes.byref(info), ctypes.sizeof(info), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return info

    def active(self):
        self.proc.poll()  # reap the direct child before checking the container
        if WIN:
            return self._query(1, ACCOUNTING).ActiveProcesses
        try:
            os.killpg(self.pid, 0)
            return 1
        except ProcessLookupError:
            return 0
        except PermissionError:
            # macOS answers EPERM for a group whose members are all exited/zombie (or an id reused by another user):
            # nothing of ours is left in it. Raising here crashed block m25 and skipped server cleanup (leaked :8000).
            return 0

    def peak_commit_mb(self):
        return self._query(9, EXTENDED_LIMIT).PeakJobMemoryUsed / 2**20 if WIN else None

    def processes(self):
        try:
            root = psutil.Process(self.pid)
            return [root, *root.children(recursive=True)]
        except psutil.Error:
            return []

    def signal(self, step):
        if WIN:
            if step == "soft":
                try:
                    os.kill(self.pid, signal.CTRL_BREAK_EVENT)  # this job's own console group only
                except OSError:
                    pass
            else:
                k32.TerminateJobObject(self.job, 1)
        else:
            try:
                os.killpg(self.pid, step)
            except ProcessLookupError:
                pass

    def close(self):
        if WIN:
            k32.CloseHandle(self.job)
        self.log.close()


def stop(containers, grace):
    """run_bounded.py's ladder: SIGINT/grace, SIGTERM/2 s, SIGKILL; Windows: CTRL_BREAK/grace,
    TerminateJobObject. Returns names of containers that still hold processes."""
    steps = [("soft", grace), ("hard", 10)] if WIN else [(signal.SIGINT, grace), (signal.SIGTERM, 2), (signal.SIGKILL, 2)]
    for step, delay in steps:
        live = [c for c in containers if c.active()]
        if not live:
            break
        for c in live:
            c.signal(step)
        until = time.monotonic() + delay
        while time.monotonic() < until and any(c.active() for c in live):
            time.sleep(0.1)
    for c in containers:
        try:
            c.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
    return [c.name for c in containers if c.active()]


def listening():
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            return True
    except OSError:
        return False


def memory_free_pct():
    if not MAC:
        return None
    out = subprocess.run(["memory_pressure"], capture_output=True, text=True, timeout=60).stdout
    return int(re.search(r"memory free percentage: (\d+)%", out).group(1))


def typeperf(counters):
    """Windows performance counters (one sample) -> {instance|counter: MB}."""
    out = subprocess.run(["typeperf", *counters, "-sc", "1"], capture_output=True, text=True, timeout=60).stdout
    rows = [r for r in csv.reader(line for line in out.splitlines() if line.startswith('"'))]
    if len(rows) < 2:
        return {}
    result = {}
    for head, value in zip(rows[0][1:], rows[1][1:]):
        m = re.search(r"\(([^)]*)\)\\(.*)$", head)
        if m and value.strip():
            result[f"{m.group(1)}|{m.group(2)}"] = round(float(value) / 2**20, 1)
    return result


def gpu_adapter():
    return typeperf([r"\GPU Adapter Memory(*)\Dedicated Usage", r"\GPU Adapter Memory(*)\Shared Usage"]) if WIN else None


def gpu_by_pid(pids):
    if not WIN or not pids:
        return {}
    usage = {}
    for key, mb in typeperf([r"\GPU Process Memory(*)\Dedicated Usage", r"\GPU Process Memory(*)\Shared Usage"]).items():
        m = re.match(r"pid_(\d+)_.*\|(Dedicated|Shared) Usage", key)
        if m and int(m.group(1)) in pids:
            kind = m.group(2).lower()
            usage[kind] = usage.get(kind, 0.0) + mb
    return usage


def owned(run):
    """Python/node processes working inside this run dir: every block's workers (cwd RUN/source), the Showdown
    server and its children (RUN/ps/...) and validate_pile (RUN). Receipts and the start/after checks only; never
    killed. Command lines are not matched: a foreign job that merely names the run dir (the remrun observe wrapper
    that failed lg6 and blocked lg7) is not a runner. One runner per run dir still holds: a second one finds these
    processes, or port 8000 in use."""
    found = []
    me = psutil.Process()
    skip = {me.pid, *(p.pid for p in me.parents())}  # this runner and the shell that launched it
    root = os.path.normcase(str(run))
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        if p.pid in skip or not re.match(r"(python|node)", (p.info["name"] or "").lower()):
            continue
        try:
            cwd = os.path.normcase(p.cwd())
            if cwd == root or cwd.startswith(root.rstrip(os.sep) + os.sep):
                found.append({"pid": p.pid, "name": p.info["name"], "rss_mb": round(p.memory_info().rss / 2**20, 1),
                              "cwd": p.cwd(), "cmd": " ".join(p.info["cmdline"] or [])[:160]})
        except psutil.Error:
            pass
    return found


def receipt(run, label):
    vm = psutil.virtual_memory()
    procs = owned(run)
    return {"label": label, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "host": platform.node(),
            "owned_processes": procs, "port_8000_listening": listening(),
            "host_mem": {"total_mb": vm.total // 2**20, "available_mb": vm.available // 2**20, "percent": vm.percent},
            "macos_memory_free_pct": memory_free_pct(), "gpu_adapter_mb": gpu_adapter(),
            "owned_gpu_mb": gpu_by_pid({p["pid"] for p in procs})}


def main():
    if "--critic-diagnostic" in sys.argv:
        # Keep offline scoring in the same process tree selected by the live-yield controller.
        ap = argparse.ArgumentParser(description="Reserved-battle CPU diagnostic under the block yield guard")
        ap.add_argument("--run", type=Path, required=True)
        ap.add_argument("--critic-diagnostic", action="store_true")
        ap.add_argument("--job", type=Path, required=True)
        a = ap.parse_args()
        job = json.loads(a.job.read_bytes())
        env = json.loads((a.run / "env.json").read_bytes())
        assert MAC and not a.run.is_absolute() and str(a.run).startswith("tmp/uu-selfplay-")
        scorer = Path(job["scorer"])
        assert hashlib.sha256(scorer.read_bytes()).hexdigest() == job["programSha256"]
        stable = None
        while True:
            if time.time() >= job.get("stopByEpoch", float("inf")):
                print(json.dumps({"phase":"DEFERRED_AUTHORIZED_WINDOW"}),flush=True)
                raise SystemExit(75)
            available = psutil.virtual_memory().available / 2**30
            normal = int(subprocess.check_output(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], text=True)) == 1
            safe = normal and memory_free_pct() >= job["admission"]["minimumFreePercent"] and available >= job["admission"]["minimumAvailableGiB"]
            stable = (stable if stable is not None else time.monotonic()) if safe else None
            if stable is not None and time.monotonic() - stable >= job["admission"]["stableSeconds"]:
                break
            time.sleep(2)
        os.environ.update({key: str(value) for key, value in env.items()})
        sys.path[:0] = env["PYTHONPATH"].split(os.pathsep)
        import runpy
        sys.argv = [str(scorer), "--job", str(a.job)]
        runpy.run_path(str(scorer), run_name="__main__")
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", type=Path, required=True)
    ap.add_argument("--block", required=True)
    ap.add_argument("--workers", type=int)
    ap.add_argument("--league", type=Path, help="Metamon ladder YAML defining a heterogeneous league")
    ap.add_argument("--export-dir", type=Path, help="UU_EXPORT_DIR for UUExport league agents")
    ap.add_argument("--challenges", type=int, required=True)
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--grace", type=float, default=30)
    ap.add_argument("--lone-seconds", type=float, default=60)
    ap.add_argument("--mem-start-min", type=int, default=40)
    ap.add_argument("--mem-stop-below", type=int, default=35)
    ap.add_argument("--device", choices=("cuda", "mps", "cpu"), help="override env.json DEVICE (accelerate placement)")
    ap.add_argument("--min-available-gb", type=float, default=0, help="stop the block if available RAM falls below this")
    ap.add_argument("--start-available-gb", type=float, default=0, help="refuse to start below this available RAM")
    a = ap.parse_args()
    league = None
    if a.league:
        import yaml
        raw = yaml.safe_load(a.league.read_text())
        league = {}
        for key, agent in raw["agents"].items():
            n = (agent or {}).get("num_agents", raw["defaults"].get("num_agents")) or 1
            for i in range(n):
                league[f"UU{a.block}{key}{i + 1 if n > 1 else ''}"] = {**(agent or {}), "num_agents": 1, "league_key": key}
        if any(not re.fullmatch(r"[A-Za-z0-9]{3,18}", n) for n in league):
            ap.error("league account names must be 3-18 alphanumerics: shorten the agent keys")
        a.workers = a.workers or len(league)
        if a.workers != len(league):
            ap.error(f"--workers {a.workers} != {len(league)} league accounts")
    if not (a.workers and 2 <= a.workers <= 26 and a.challenges > 0 and a.seconds > 0 and re.fullmatch(r"[a-z]{1,3}\d+", a.block)):
        ap.error("need 2..26 workers, positive challenges/seconds, block like w1 (lifecycle tests: wx1)")
    run = a.run.resolve()
    cfg = json.loads((run / "env.json").read_text())
    if a.export_dir:
        cfg["UU_EXPORT_DIR"] = str(a.export_dir.resolve())
    if a.device and a.device != cfg["DEVICE"]:
        cfg["DEVICE"] = a.device
        cfg.pop("ACCELERATE_USE_CPU", None)
        if a.device == "cpu":
            cfg["ACCELERATE_USE_CPU"] = "true"
    env = {k: v for k, v in os.environ.items() if k != "ACCELERATE_USE_CPU"}
    env.update(cfg)
    logs, pile = run / "logs", run / "piles" / a.block
    if pile.exists() or list(logs.glob(f"{a.block}-*")):
        raise SystemExit(f"block {a.block} already has a pile or logs")
    if listening():
        raise SystemExit("port 8000 already in use")
    if owned(run):
        raise SystemExit("processes from this run dir are already running")
    pinned = json.loads((K / "source-pins.json").read_text())["metamon"]["tree_sha256"]
    tree, _ = assembler().tree(run / "source")
    if tree != pinned:
        raise SystemExit(f"run source metamon tree {tree} is not the pinned fork {pinned}: "
                         "swap it between blocks with vendor/metamon/assemble.py swap")
    free = memory_free_pct()
    if free is not None and free < a.mem_start_min:
        raise SystemExit(f"memory_pressure free {free}% < {a.mem_start_min}%")
    if (avail := psutil.virtual_memory().available / 2**30) < a.start_available_gb:
        raise SystemExit(f"available RAM {avail:.1f} GB < {a.start_available_gb} GB to start")

    ladder = run / f"ladder-{a.block}.yaml"
    if league is None:
        names = [f"UU{a.block}{chr(65 + i)}" for i in range(a.workers)]
        ladder.write_text("defaults:\n  team_set: uu_train_v1\n  battle_backend: metamon\n  checkpoints: [34]\n"
                          "  temperatures: [1.0]\n  num_agents: 1\nagents:\n" +
                          "".join(f"  {n}: {{model_name: UUKakuna, temperatures: [{TEMPS[i % 3]}]}}\n" for i, n in enumerate(names)))
        entry, members, single = ["-m", "metamon.rl.evaluate.ladder_self_play.serve_model"], None, []
        challenges = {n: a.challenges for n in names}
    else:
        names = list(league)
        ladder.write_text(yaml.safe_dump({"defaults": raw["defaults"], "agents": league}, sort_keys=False))
        entry = [str(K / "league_serve.py")]
        members = {n: {k: league[n].get(k, raw["defaults"].get(k)) for k in
                       ("league_key", "model_name", "checkpoints", "temperatures", "team_set", "sha256")} for n in names}
        single = [n for n in names if str(members[n]["model_name"]).startswith("baseline:")]
        challenges = {n: league[n].get("n_challenges", a.challenges) for n in names}
    jobs = [{"argv": [cfg["PY"], *entry, "--username", n,
                      "--format", "gen9uu", "--config", str(ladder), "--n_challenges", str(challenges[n]),
                      "--save_trajectories_to", str(pile)],
             "cwd": str(run / "source"), "log": str(logs / f"{a.block}-{n}.log")} for n in names]
    (run / f"{a.block}-jobs.json").write_text(json.dumps(jobs, indent=1))
    keys = ("metamon/env/", "ladder_self_play", "rl/pretrained.py", "metamon/config.py", "amago/experiment.py")
    src = {p.relative_to(run).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
           for p in sorted((run / "source").rglob("*.py")) if any(k in p.as_posix() for k in keys)}
    (run / f"{a.block}-manifest.json").write_text(json.dumps({  # block.sh's manifest, plus the attention module
        "block": a.block, "host": platform.node(), "workers": a.workers, "battles_per_account": a.challenges,
        "temperatures": {n: TEMPS[i % 3] for i, n in enumerate(names)} if league is None else None,
        "checkpoint": cfg["UU_KAKUNA_CKPT"], "league": members, "export_dir": cfg.get("UU_EXPORT_DIR"),
        "league_sha256": hashlib.sha256(a.league.read_bytes()).hexdigest() if a.league else None,
        "gin": cfg["UU_BASE_GIN"], "device": cfg.get("DEVICE"), "metamon_tree_sha256": tree, "source_sha256": src,
        "ext_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((run / "ext").glob("*.py"))},
        "kit_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(K.iterdir()) if p.is_file()}}, indent=1))
    (logs / f"{a.block}-before.json").write_text(json.dumps(receipt(run, "before"), indent=1))

    interrupted = False

    def on_signal(_s, _f):
        nonlocal interrupted
        interrupted = True
    for s in (signal.SIGINT, signal.SIGBREAK if WIN else signal.SIGTERM):
        signal.signal(s, on_signal)

    ps_dir = run / "ps/node_modules/pokemon-showdown"
    server, workers, tail_stopped = None, [], []
    peak = {n: {"rss_mb": 0.0, "gpu_dedicated_mb": 0.0, "gpu_shared_mb": 0.0} for n in names}
    mem_min, reason, t0 = free, "completed", time.monotonic()
    avail_min = psutil.virtual_memory().available / 2**30
    try:
        server = Container("ps-server", [cfg["NODE"], "pokemon-showdown", "start", "--skip-build", "--no-security"],
                           ps_dir, logs / f"{a.block}-ps-server.log", env)
        for _ in range(120):
            if listening() or server.proc.poll() is not None:
                break
            time.sleep(1)
        if not listening():
            raise RuntimeError("server failed to listen")
        print(f"server up pid {server.pid}", flush=True)
        t0 = time.monotonic()
        workers = [Container(j["argv"][j["argv"].index("--username") + 1], j["argv"], j["cwd"], j["log"], env) for j in jobs]
        deadline, lone_since, next_sample, next_gpu = t0 + a.seconds, None, 0.0, 0.0
        while True:
            now = time.monotonic()
            codes = {w.name: w.proc.poll() for w in workers}
            alive = [w for w in workers if codes[w.name] is None]
            if interrupted:
                reason = "interrupted"
                break
            if any(c not in (None, 0) and n not in tail_stopped for n, c in codes.items()):
                reason = "job_failed"
                break
            if not alive:
                break
            if server.proc.poll() is not None:
                reason = "server_exited"
                break
            if now >= deadline:
                reason = "deadline"
                break
            if len(alive) == 1:
                lone_since = lone_since or now
                if now - lone_since >= a.lone_seconds:
                    print(f"tail guard: stopping lone worker {alive[0].name} (container)", flush=True)
                    stop([alive[0]], a.grace)
                    tail_stopped.append(alive[0].name)
                    continue
            else:
                lone_since = None
            if now >= next_sample:
                next_sample = now + 10
                for w in alive:
                    samples = [resident_bytes(p) for p in w.processes()]
                    rss = sum(value for value in samples if value is not None) / 2**20
                    peak[w.name]['exited_process_samples'] = peak[w.name].get('exited_process_samples', 0) + samples.count(None)
                    peak[w.name]["rss_mb"] = max(peak[w.name]["rss_mb"], round(rss, 1))
                if WIN and now >= next_gpu:
                    next_gpu = now + 30
                    for w in alive:
                        g = gpu_by_pid({p.pid for p in w.processes()})
                        peak[w.name]["gpu_dedicated_mb"] = max(peak[w.name]["gpu_dedicated_mb"], round(g.get("dedicated", 0), 1))
                        peak[w.name]["gpu_shared_mb"] = max(peak[w.name]["gpu_shared_mb"], round(g.get("shared", 0), 1))
                avail = psutil.virtual_memory().available / 2**30
                avail_min = min(avail_min, avail)
                if avail < a.min_available_gb:
                    reason = "memory_available"
                    print(f"memory guard: available {avail:.1f} GB < {a.min_available_gb} GB", flush=True)
                    break
                free = memory_free_pct()
                if free is not None:
                    mem_min = min(mem_min, free)
                    if free < a.mem_stop_below:
                        reason = "memory_pressure"
                        print(f"memory guard: free {free}% < {a.mem_stop_below}%", flush=True)
                        break
                done = len(list(pile.rglob("*.json.lz4"))) if pile.exists() else 0
                print(f"{time.strftime('%H:%M:%S')} alive {len(alive)}/{len(workers)} trajectories {done}"
                      f" free% {free} available_gb {avail:.2f}", flush=True)
            time.sleep(1)
    except BaseException as e:
        reason = f"runner_error:{type(e).__name__}:{e}"[:200]
    finally:
        elapsed = time.monotonic() - t0
        for w in workers:
            if WIN:
                peak[w.name]["job_peak_commit_mb"] = round(w.peak_commit_mb(), 1)
        worker_survivors = stop(workers, a.grace)
        server_survivors = stop([server], a.grace) if server else []
        codes = [w.proc.returncode for w in workers]
        for c in [*workers, *([server] if server else [])]:
            c.close()
    time.sleep(5)
    after = receipt(run, "after")
    (logs / f"{a.block}-after.json").write_text(json.dumps(after, indent=1))
    with open(logs / f"{a.block}-validate.json", "wb") as out, open(logs / f"{a.block}-validate.err", "wb") as err:
        subprocess.run([cfg["PY"], str(K / "validate_pile.py"), str(pile), "--single-pov-accounts", ",".join(single)],
                       stdout=out, stderr=err, env=env, cwd=str(run))
    try:
        v = json.loads((logs / f"{a.block}-validate.json").read_text())
    except ValueError:
        v = {}
    metas = [json.loads(m.read_text()) for m in pile.rglob("*.json.lz4.meta")] if pile.exists() else []
    decisions = sum(m["states"] - 1 for m in metas)
    flags = v.get("quarantine_flags", {})
    clean = bool(v) and not v["shape_errors"] and not v.get("pairs_bad") and v.get("pairs_exact", 0) + v.get("single_pov_expected", 0) == v.get("battle_tags") \
        and v["sidecars"] == v["trajectories"] and v["dataset_loaded"] == v["trajectories"] and not v["dataset_errors"] \
        and all(flags.get(k, 0) == 0 for k in ("parse_errors", "unfinished", "time_limit", "states_mismatch", "no_winner"))
    games, hours = v.get("pairs_exact", 0) + v.get("single_pov_expected", 0), elapsed / 3600
    result = {"block": a.block, "reason": reason, "workers": a.workers, "challenges": a.challenges, "names": names,
              "pids": [w.pid for w in workers], "returncodes": codes, "tailStopped": tail_stopped,
              "survivingContainers": worker_survivors, "serverSurvivors": server_survivors,
              "ownedProcessesAfter": len(after["owned_processes"]), "port8000ListeningAfter": after["port_8000_listening"],
              "ownedGpuAfterMb": after["owned_gpu_mb"], "elapsed_s": round(elapsed, 1), "games": games,
              "trajectories": v.get("trajectories", 0), "decisions": decisions,
              "games_per_hour": round(games / hours, 1) if hours else None,
              "decisions_per_hour": round(decisions / hours, 1) if hours else None,
              "worker_seconds_per_decision": round(elapsed * a.workers / decisions, 3) if decisions else None,
              "peak_per_worker": peak, "macos_memory_free_min_pct": mem_min,
              "host_available_min_gb": round(avail_min, 1), "validation_clean": clean,
              "device": cfg.get("DEVICE"), "single_pov_expected": v.get("single_pov_expected", 0),
              "pov_vs_opponent": v.get("pov_vs_opponent") if league is not None else None}
    (logs / f"{a.block}-lifecycle.json").write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1), flush=True)
    ok = (reason == "completed" and clean and not worker_survivors and not server_survivors
          and not after["owned_processes"] and not after["port_8000_listening"])
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
