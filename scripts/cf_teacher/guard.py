"""Bound a teacher subprocess and yield to production or evaluation work.

Config supplies argv, cwd, heavy-status command and event path. Never discovers
processes to kill: cancellation signals only the direct owned child; its worker
transport cancels each owned inference group on EOF, including compiler children.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time

import psutil


def sample(child_pid, status_command):
    heavy = json.loads(subprocess.check_output(status_command, text=True, timeout=10))
    if not heavy.get('ok') or 'current' not in heavy:
        raise ValueError('Malformed production status')
    gpu = subprocess.check_output(['nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader'], text=True, timeout=10)
    gpu_pids = {int(line.strip()) for line in gpu.splitlines() if line.strip()}
    owned = set()
    if child_pid is not None:
        try:
            root = psutil.Process(child_pid)
            owned = {child_pid, *(p.pid for p in root.children(recursive=True))}
        except psutil.NoSuchProcess:
            pass
    eval_processes = 0
    for proc in psutil.process_iter(['pid', 'cmdline']):
        if proc.pid in owned:
            continue
        try:
            cmd = proc.info['cmdline'] or []
            if any(x.endswith('/queue_dev.sh') or x.endswith('/uu_eval/evaluate.py') for x in cmd):
                eval_processes += 1
        except psutil.Error:
            raise ValueError('Evaluation process inventory unavailable')
    return {'heavyActive': heavy['current'] is not None, 'foreignGpuPids': sorted(gpu_pids - owned),
            'ownedGpuPids': sorted(gpu_pids & owned), 'evalProcesses': eval_processes,
            'availableGiB': psutil.virtual_memory().available / 2**30}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('config', type=Path)
    a = p.parse_args()
    c = json.loads(a.config.read_text())
    wall_seconds = c.get('wallSeconds', 2700)
    if type(wall_seconds) is not int or not 1 <= wall_seconds <= 10800:
        raise ValueError('wallSeconds must be an integer in 1..10800')
    child = None
    interrupted = False
    def interrupt(_s, _f):
        nonlocal interrupted
        interrupted = True
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    reason = 'completed'
    started = time.monotonic()
    with open(c['events'], 'x') as events:
        def record(row):
            events.write(json.dumps({'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **row}) + '\n')
            events.flush()
        try:
            before = sample(None, c['statusCommand'])
            record(before)
            if before['heavyActive'] or before['foreignGpuPids'] or before['evalProcesses']:
                raise RuntimeError('Admission refused: production/GPU/evaluation active')
            child = subprocess.Popen(c['argv'], cwd=c['cwd'], start_new_session=True)
            while child.poll() is None:
                s = sample(child.pid, c['statusCommand'])
                record(s)
                if interrupted or time.monotonic() - started >= wall_seconds:
                    reason = 'interrupted_or_deadline'; break
                if s['heavyActive'] or s['foreignGpuPids'] or s['evalProcesses']:
                    reason = 'yield_to_production_or_eval'; break
                time.sleep(5)
        except Exception as e:
            reason = f'guard_error: {e}'
        finally:
            if child is not None and child.poll() is None:
                child.send_signal(signal.SIGTERM)
                try:
                    child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    # Capture exact owned identities before any escalation. This
                    # process's descendants are exclusive to this one pilot.
                    descendants = psutil.Process(child.pid).children(recursive=True)
                    for proc in descendants:
                        try:
                            proc.terminate()
                        except psutil.NoSuchProcess:
                            pass
                    child.kill()
                    child.wait()
                    _, live = psutil.wait_procs(descendants, timeout=5)
                    for proc in live:
                        proc.kill()
                    psutil.wait_procs(live, timeout=5)
            # Query GPU after normal transport EOF cleanup; foreign work is recorded.
            after = sample(None, c['statusCommand'])
            record({'reason': reason, 'returncode': child.returncode if child else None, 'after': after})
    return 0 if child is not None and child.returncode == 0 and reason == 'completed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
