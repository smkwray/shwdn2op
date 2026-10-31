"""Replay a recorded worker RPC transcript through a live launch config; require exact replies.

  python wire_replay.py --launch config/local/metamon-live-amdbox.json --wire rpc-wire.jsonl --seed N
         [--stop-after K [--abandon]] [--close eof|companion] [--out report.json]

The launch's {seed} is replaced by N (the recorded worker seed). Each recorded request is
sent as one JSON line; each reply must equal the recorded reply (dict equality). Then the
session is closed either by stdin EOF only, or as MetamonBattlePolicy.close() does
(stdin end, SIGTERM to the local process group at 50 ms, SIGKILL at 150 ms). Runs on the
companion host; launches nothing but the configured command.
"""

import argparse
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import time


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--launch", type=Path, required=True)
    ap.add_argument("--wire", type=Path, required=True)
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--stop-after", type=int)
    ap.add_argument("--abandon", action="store_true", help="after --stop-after frames, send the next request and close without its reply")
    ap.add_argument("--close", choices=("eof", "companion"), default="eof")
    ap.add_argument("--timeout", type=float, default=240)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    launch = json.loads(a.launch.read_text())
    argv = [launch["command"], *(arg.replace("{seed}", str(a.seed)) for arg in launch["args"])]
    frames = [json.loads(line) for line in a.wire.read_text().splitlines() if line.strip()]
    abandoned = frames[a.stop_after] if a.abandon and a.stop_after is not None else None
    if a.stop_after is not None:
        frames = frames[:a.stop_after]
    child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    buffer, rows, started = b"", [], time.monotonic()

    def read_line(deadline):
        nonlocal buffer
        while b"\n" not in buffer:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([child.stdout], [], [], left)[0]:
                raise TimeoutError("no reply")
            chunk = os.read(child.stdout.fileno(), 65536)
            if not chunk:
                raise EOFError("worker closed stdout")
            buffer += chunk
        line, buffer = buffer.split(b"\n", 1)
        return line

    error = None
    try:
        for frame in frames:
            sent = time.monotonic()
            child.stdin.write((json.dumps(frame["request"], separators=(",", ":")) + "\n").encode())
            child.stdin.flush()
            raw = read_line(sent + a.timeout)
            reply = json.loads(raw)
            rows.append({"id": frame["request"]["id"], "op": frame["request"]["op"], "ms": round((time.monotonic() - sent) * 1000, 1),
                         "match": reply == frame["response"], "crlf": raw.endswith(b"\r"),
                         **({} if reply == frame["response"] else {"got": reply, "want": frame["response"]})})
    except Exception as e:  # reported, never hidden
        error = f"{type(e).__name__}: {e}"
    if abandoned and not error:
        child.stdin.write((json.dumps(abandoned["request"], separators=(",", ":")) + "\n").encode())
        child.stdin.flush()
    closed_at = time.monotonic()
    child.stdin.close()
    if a.close == "companion":
        time.sleep(0.05)
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):  # already exited (macOS: EPERM for a zombie leader)
            pass
        time.sleep(0.1)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):  # already exited (macOS: EPERM for a zombie leader)
            pass
    try:
        code = child.wait(timeout=60)
    except subprocess.TimeoutExpired:
        code = "timeout"
    proposes = [r["ms"] for r in rows if r["op"] == "propose"]
    report = {"launch": str(a.launch), "wire": str(a.wire), "seed": a.seed, "frames": len(frames), "replies": len(rows),
              "matches": sum(r["match"] for r in rows), "mismatches": [r for r in rows if not r["match"]][:5],
              "crlf_replies": sum(r["crlf"] for r in rows), "error": error, "close": a.close,
              "abandoned": abandoned["request"]["op"] if abandoned else None,
              "local_exit_code": code, "local_exit_s": round(time.monotonic() - closed_at, 2),
              "first_propose_ms": proposes[0] if proposes else None,
              "propose_ms_sorted": sorted(proposes[1:]), "wall_s": round(time.monotonic() - started, 1),
              "ops": {op: sum(r["op"] == op for r in rows) for op in sorted({r["op"] for r in rows})}}
    text = json.dumps(report, indent=1)
    if a.out:
        a.out.write_text(text)
    print(json.dumps({k: v for k, v in report.items() if k != "propose_ms_sorted"}))
    return 0 if not error and report["matches"] == len(frames) else 1


if __name__ == "__main__":
    raise SystemExit(main())
