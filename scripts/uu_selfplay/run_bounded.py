#!/usr/bin/env python3
"""Run finite jobs in owned process groups; clean descendants even after success.

Usage: python3 run_bounded.py --seconds 1800 --grace 15 jobs.json
jobs.json: [{"argv": ["python", "-m", "..."], "cwd": "/run", "log": "/run/a.log"}]
No shell, restart, discovery, or host-wide process killing. GPU absence needs a
separate host observer after this runner exits. Unix only (gpubox intended).
"""
import argparse
import json
import os
import signal
import subprocess
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, required=True)
    parser.add_argument('--grace', type=float, default=15)
    parser.add_argument('jobs', type=Path)
    args = parser.parse_args()
    if args.seconds <= 0 or args.grace <= 0:
        parser.error('seconds and grace must be positive')
    jobs = json.loads(args.jobs.read_text())
    if not jobs:
        parser.error('at least one job required')
    procs, logs = [], []
    interrupted = False

    def stop(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    def send(sig):
        for proc in procs:
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    reason = 'completed'
    cleanup_survivors = []
    try:
        for job in jobs:
            argv = job['argv']
            if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
                raise ValueError('argv must be a nonempty array of strings')
            log = open(job['log'], 'xb')
            logs.append(log)
            procs.append(subprocess.Popen(argv, cwd=job['cwd'], stdout=log,
                                          stderr=subprocess.STDOUT, start_new_session=True))
        deadline = time.monotonic() + args.seconds
        while True:
            statuses = [p.poll() for p in procs]
            if interrupted:
                reason = 'interrupted'
                break
            if any(s not in (None, 0) for s in statuses):
                reason = 'job_failed'
                break
            if all(s == 0 for s in statuses):
                break
            if time.monotonic() >= deadline:
                reason = 'deadline'
                break
            time.sleep(0.2)
    finally:
        # Parent exit does not establish descendant exit. Signal the owned groups.
        for sig, delay in ((signal.SIGINT, args.grace), (signal.SIGTERM, 2), (signal.SIGKILL, 0.2)):
            send(sig)
            until = time.monotonic() + delay
            while time.monotonic() < until:
                for p in procs:
                    p.poll()  # Reap direct children before checking process-group absence.
                live = []
                for p in procs:
                    try:
                        os.killpg(p.pid, 0)
                        live.append(p.pid)
                    except ProcessLookupError:
                        pass
                if not live:
                    break
                time.sleep(0.1)
        for p in procs:
            p.wait()
            try:
                os.killpg(p.pid, 0)
                cleanup_survivors.append(p.pid)
            except ProcessLookupError:
                pass
        for log in logs:
            log.close()
    result = {'reason': reason, 'pids': [p.pid for p in procs],
              'returncodes': [p.returncode for p in procs],
              'survivingProcessGroups': cleanup_survivors,
              'gpuAbsenceVerified': False}
    print(json.dumps(result))
    return 0 if reason == 'completed' and not cleanup_survivors else 1


if __name__ == '__main__':
    raise SystemExit(main())
