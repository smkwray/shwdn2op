"""Run an owned GPU job only while TTS/evaluation and foreign GPU work are absent.

The caller must run under remrun. This gate does not signal foreign work. The
project lock serializes flywheel jobs; monitoring yields to an external cohort.
"""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import os
import subprocess
import time

import psutil


# These closed-run entry points only replay retained simulator events and do
# statistics. A live hold still blocks them; unknown evaluation work stays
# conservative, and nvidia-smi independently excludes every foreign GPU context.
CPU_EVALUATION = {"verify.py", "analyze.py", "verify_native.ts",
                  "verify_canonical.ts", "verify_rerank.ts", "verify_teams.ts",
                  "runtime_fixture.ts", "test_revival_decoder.py"}


def capture_tree(captured, roots):
    """Retain birth identities across reparenting and independent child sessions."""
    for pid in set(roots) | set(captured):
        try:
            process = psutil.Process(pid)
            if pid in captured and process.create_time() != captured[pid]:
                continue
            for member in [process, *process.children(recursive=True)]:
                captured.setdefault(member.pid, member.create_time())
        except psutil.NoSuchProcess:
            continue
    return live_owned(captured)


def live_owned(captured):
    found = []
    for pid, born in captured.items():
        try:
            process = psutil.Process(pid)
            if process.create_time() == born and process.status() != psutil.STATUS_ZOMBIE:
                found.append(process)
        except psutil.NoSuchProcess:
            pass
    return found


def stop_owned(captured):
    processes = capture_tree(captured, ())
    for process in reversed(processes):
        try:process.terminate()
        except psutil.NoSuchProcess:pass
    _, alive = psutil.wait_procs(processes, timeout=15)
    for process in alive:
        try:process.kill()
        except psutil.NoSuchProcess:pass
    psutil.wait_procs(alive, timeout=5)
    assert not live_owned(captured), 'Owned GPU descendants failed to unload'


def released_owned_gpu(pid, captured, seen_gpu, released, now):
    """A previously observed owned CUDA context may briefly outlive its process."""
    if pid not in captured or seen_gpu.get(pid) != captured[pid]:
        return False
    try:
        process = psutil.Process(pid)
        if process.create_time() != captured[pid] or process.status() not in (psutil.STATUS_ZOMBIE, psutil.STATUS_DEAD):
            return False
    except psutil.NoSuchProcess:
        pass
    first = released.setdefault(pid, now)
    return 0 <= now-first <= 30


def blockers(owned, captured=None, seen_gpu=None, released=None):
    captured = captured if captured is not None else {}
    seen_gpu = seen_gpu if seen_gpu is not None else {}
    released = released if released is not None else {}
    reasons = []
    for claim in Path("tmp/uu-eval-runs").glob("*GPU-HOLD*.json"):
        try:
            value = json.loads(claim.read_text())
        except (OSError,ValueError):
            reasons.append({"kind":"unreadable_eval_claim","file":str(claim)})
            continue
        if not (value.get("status")=="RELEASED" and value.get("gpuUnloadProven") is True):
            reasons.append({"kind":"evaluation_claim","file":str(claim),"status":value.get("status")})
    for proc in psutil.process_iter(["pid", "cmdline"]):
        if proc.pid in owned:
            continue
        args = proc.info["cmdline"] or []
        # Match executable/script arguments, never shell source or grep queries.
        if any((("/uu_eval/" in x and Path(x).name not in CPU_EVALUATION) or "supervise_remote.py" in x or
                ("tts" in Path(x).name.lower() and x.endswith(".py")))
               for x in args[:4]):
            reasons.append({"kind": "priority_process", "pid": proc.pid})
    query = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, check=True, timeout=10)
    if captured:
        owned = owned | {process.pid for process in capture_tree(captured, ())}
    for pid in query.stdout.split():
        pid = int(pid)
        if pid in captured:
            try:
                process = psutil.Process(pid)
                live = process.create_time() == captured[pid] and process.status() not in (psutil.STATUS_ZOMBIE, psutil.STATUS_DEAD)
            except psutil.NoSuchProcess:
                live = False
            if live and pid in owned:
                seen_gpu[pid] = captured[pid]
                continue
            if released_owned_gpu(pid, captured, seen_gpu, released, time.monotonic()):
                continue
        elif pid in owned:
            continue
        reasons.append({"kind": "foreign_gpu", "pid": pid})
    return reasons


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--receipt", required=True, type=Path)
    p.add_argument("--min-available-gib", type=float, default=24.)
    p.add_argument("--adopt-info", type=Path, help="Exact PID/birth/argv binding for an already-owned orphan; never launches a replacement")
    p.add_argument("command", nargs=argparse.REMAINDER)
    a = p.parse_args()
    if a.receipt.exists():
        raise FileExistsError(a.receipt)
    command = a.command[1:] if a.command[:1] == ["--"] else a.command
    a.receipt.parent.mkdir(parents=True, exist_ok=True)
    with Path("tmp/flywheel-gpu.lock").open("a") as lock:
        try:fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            a.receipt.write_text(json.dumps({"status":"WAIT_RESOURCE","reasons":[{"kind":"project_gpu_lease"}],"started":time.time()}))
            return 75
        own = {os.getpid(), *[p.pid for p in psutil.Process().parents()]}
        captured, seen_gpu, released = {}, {}, {}
        adoption = json.loads(a.adopt_info.read_bytes()) if a.adopt_info else None
        if adoption:
            assert not command
            process = psutil.Process(adoption['pid'])
            assert process.create_time() == adoption['birth']
            assert hashlib.sha256(json.dumps(process.cmdline()).encode()).hexdigest() == adoption['commandSha256']
            captured[process.pid] = adoption['birth']
            capture_tree(captured, (process.pid,))
        else:
            assert command, 'A command or exact adoption binding is required'
        reason = blockers(own | {p.pid for p in live_owned(captured)}, captured, seen_gpu, released)
        if psutil.virtual_memory().available < a.min_available_gib*2**30:
            reason.append({"kind": "memory_floor"})
        started = time.time()
        if reason:
            if adoption:stop_owned(captured)
            a.receipt.write_text(json.dumps({"status":"WAIT_RESOURCE", "reasons":reason,"started":started},indent=2))
            return 75
        child = None if adoption else subprocess.Popen(command, start_new_session=True)
        if child:captured[child.pid] = psutil.Process(child.pid).create_time()
        peak_rss,minimum_available,peak_processes = 0,psutil.virtual_memory().available,0
        code, failure = None, None
        cpu_cleanup = []
        try:
            while (bool(live_owned(captured)) if adoption else child.poll() is None):
                processes = capture_tree(captured, ())
                owned = own | {process.pid for process in processes}
                residents = []
                for pid in owned-own:
                    try:residents.append(psutil.Process(pid).memory_info().rss)
                    except psutil.Error:pass
                peak_rss = max(peak_rss,sum(residents));peak_processes = max(peak_processes,len(residents))
                minimum_available = min(minimum_available,psutil.virtual_memory().available)
                reason = blockers(owned, captured, seen_gpu, released)
                if psutil.virtual_memory().available < a.min_available_gib*2**30:
                    reason.append({"kind": "memory_floor"})
                if adoption and time.time() >= adoption['stopByEpoch']:
                    reason.append({"kind": "owned_drain_deadline"})
                if reason:
                    stop_owned(captured)
                    break
                time.sleep(1)
            code = child.wait() if child else None
            if not adoption and code == 0 and live_owned(captured):
                live = {process.pid for process in live_owned(captured)}
                gpu = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader,nounits"],text=True,timeout=10)
                if live.intersection(int(pid) for pid in gpu.split()):
                    reason = [{"kind": "launcher_exited_with_live_gpu_descendants"}]
                else:
                    cpu_cleanup = sorted(live)
        except BaseException as error:
            failure = type(error).__name__ + ': ' + str(error)
            raise
        finally:
            if live_owned(captured):stop_owned(captured)
            if child and child.poll() is None:child.wait()
            a.receipt.write_text(json.dumps({"status":"FAILED" if failure else "YIELDED" if reason else "ADOPTED_PROCESS_ENDED" if adoption else "COMPLETED" if code==0 else "FAILED",
                                            "reasons":reason, "returncode":code,"error":failure,
                                            "adoption":adoption,"capturedProcesses":captured,
                                            "releasedOwnedGpuContexts":{pid:{"birth":seen_gpu[pid],"firstSeenMonotonic":first} for pid,first in released.items()},
                                            "cpuDescendantsCleanedAfterSuccess":cpu_cleanup,
                                            "peakOwnedRssBytes":peak_rss,"peakOwnedProcesses":peak_processes,
                                            "hostAvailableMinimumBytes":minimum_available,
                                            "started":started,"ended":time.time()},indent=2))
        return 75 if reason else code or 0


if __name__ == "__main__":
    raise SystemExit(main())
