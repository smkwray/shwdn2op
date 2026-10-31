#!/usr/bin/env python3
"""Opt-in real Metal/live-HTTP integration tests; sequential, offline, no game socket.

Run with tmp/metamon-port/.venv/bin/python -B scripts/metamon_port/test_mlx_live.py.
Needs the existing recorded cohort, CUDA dump, and trapped RPC fixture in tmp/.
Every child is reaped before starting the next one. Evidence is retained in tmp/.
"""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time
import unittest

from action_probs import legal_distribution
from common import CHECKPOINT, COHORT, DEFAULT_GAMES, OUT, ROOT, structural_record
from mlx_worker import WORKER_SHA, worker_module

DEST = OUT / "live-mlx"
DEST.mkdir(parents=True, exist_ok=True)
SCRATCH = DEST / "scratch"
SCRATCH.mkdir(exist_ok=True)
ENV = {**os.environ, "TMPDIR": str(SCRATCH), "TSX_DISABLE_CACHE": "1", "PYTHONDONTWRITEBYTECODE": "1"}
LAUNCH = ROOT / "config/local/metamon-live.json"


def read(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]


def save(name, obj):
    (DEST / name).write_text(json.dumps(obj, indent=2, allow_nan=False) + "\n")


def absent(pid):
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True


def token(action_id):
    """Companion action ID -> the worker's choice token (move:N|tera=1 -> 'move N terastallize', switch:N -> 'switch N')."""
    kind, rest = action_id.split(":", 1)
    if kind == "switch":
        return f"switch {rest}"
    slot, tera = rest.split("|tera=")
    return f"move {slot}" + (" terastallize" if tera == "1" else "")


def replay(game, tag, **extra):
    trace, report = DEST / f"{tag}.jsonl", DEST / f"{tag}.json"
    trace.unlink(missing_ok=True)
    command = ["node", "--import", "tsx", str(ROOT / "scripts/metamon_port/live_replay.mts"),
               str(COHORT / game), "p1", str(report), str(LAUNCH)]
    with (DEST / f"{tag}.log").open("w") as stream:
        subprocess.run(command, cwd=ROOT, env={**ENV, "SHWDN2OP_MLX_TRACE": str(trace), **extra},
                       stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=480)
    return json.loads(report.read_text()), read(trace)


class RPC:
    def __init__(self, tag, trace=True, extra=()):
        self.trace = DEST / f"{tag}.jsonl"
        self.trace.unlink(missing_ok=True)
        self.log = (DEST / f"{tag}.log").open("w")
        self.process = subprocess.Popen([sys.executable, "-B", "-u", str(ROOT / "scripts/metamon_port/mlx_worker.py"),
            "--checkpoint", str(CHECKPOINT), "--seed", "1206387275", "--seed-per-side", *extra], cwd=ROOT,
            env={**{k: v for k, v in ENV.items() if k != "SHWDN2OP_MLX_TRACE"}, **({"SHWDN2OP_MLX_TRACE": str(self.trace)} if trace else {})}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.log, text=True, start_new_session=True)
        self.wire, self.ms = [], []
        self.tag = tag

    def call(self, message):
        self.sent = time.perf_counter()
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        if not select.select([self.process.stdout], [], [], 90)[0]:
            raise TimeoutError("MLX worker RPC timeout")
        response = json.loads(self.process.stdout.readline())
        self.wire.append({"request": message, "response": response})
        self.ms.append((time.perf_counter() - self.sent) * 1000)  # kept apart: test_07 compares wires exactly
        return response

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            # Only this test's isolated child, never any other model/process.
            self.process.kill()
            self.process.wait()
            raise
        finally:
            self.log.close()
            self.process.stdout.close()
            save(f"{self.tag}-process.json", {"pid": self.process.pid, "exit_code": self.process.returncode,
                "pid_absent": absent(self.process.pid), "wire": self.wire})
        assert absent(self.process.pid)


class LiveMLXTests(unittest.TestCase):
    def test_01_live_probability_parity(self):
        import numpy as np
        reference = read(OUT / "torch-cuda-flex.jsonl")
        errors, legal_errors, latency, total, rss, active, peak, cold, load = [], [], [], [], [], [], [], [], []
        decisions = after_window = waits = commits = 0
        wire_errors, cuda_errors, wire_decisions, reranked = [], [], 0, 0
        for game in DEFAULT_GAMES:
            journal = DEST / f"journal-{game}"
            for stale in journal.glob("*.jsonl"):
                stale.unlink()
            report, events = replay(game, game, JOURNAL_DIR=str(journal))
            self.assertEqual(report["decisions"], report["recordedDecisions"])
            self.assertTrue(all(p["absent"] for p in report["processes"]))
            self.assertEqual(report["liveAfter"]["rooms"][0]["reason"], "ended")
            forwards = [e for e in events if e["event"] == "forward"]
            proposals = [e for e in events if e["event"] == "proposal"]
            committed = [e for e in events if e["event"] == "commit"]
            expected = [e for e in reference if e["game"] == game and e["side"] == "p1"]
            self.assertEqual(len(expected), len(forwards))
            self.assertEqual(len(proposals), len(forwards))
            for ref, row, prop in zip(expected, forwards, proposals):
                self.assertEqual(row["input_sha256"], ref["input_sha256"])
                self.assertEqual(row["step"], ref["step"])
                self.assertEqual(row["network_calls"], row["step"] + 1)
                self.assertEqual(prop["rqid"], ref["rqid"])
                mask = np.zeros(13, bool)
                mask[prop["legal"]] = True
                self.assertEqual(mask.tolist(), ref["legal_mask"])
                p = np.array(row["probs"])
                self.assertEqual(p.shape, (13,))
                self.assertTrue(np.isfinite(p).all() and (p >= 0).all())
                self.assertLess(abs(float(p.sum()) - 1), 1e-5)
                error = float(np.max(np.abs(p - ref["probs"])))
                errors.append(error)
                self.assertLessEqual(error, 1e-5)
                self.assertEqual(row["argmax"], ref["argmax"])
                conditional = p * mask
                conditional /= conditional.sum()
                legal_errors.append(float(np.max(np.abs(conditional - ref["legal_probs"]))))
                self.assertTrue(row["device"]["metal_available"])
                self.assertEqual(row["device"]["device"], "Device(gpu, 0)")
                self.assertGreater(row["gpu_active_bytes"], 0)
                after_window += row["step"] > 96
                (cold if row["step"] == 0 else latency).append(row["latency_ms"])
                total.append(prop["total_ms"])
                rss.append(row["rss_bytes"])
                active.append(row["gpu_active_bytes"])
                peak.append(row["gpu_peak_bytes"])
                if row["step"] == 0:
                    load.append(row["load_ms"])
            for commit in committed:
                ref = expected[commit["step"]]
                self.assertEqual(commit["choice"], structural_record({"actionId": ref["commit"]}))
                self.assertIn(commit["index"], ref["commit_indices"])
            # The live adapter intentionally unloads at terminal without advancing
            # the final pending human action. All earlier recurrence commits match.
            self.assertEqual(len(committed), len(expected) - 1)
            # The propose reply's actionProbabilities (re-keyed by the companion, journaled per decision) equal the
            # legal conditional of the stored distribution the worker sampled/redrew from, keyed by the pinned decoder.
            advice = [r for f in sorted(journal.glob("*.jsonl")) for r in read(f) if r["kind"] == "advice" and r["rerank"]["rawProbabilities"]]
            self.assertEqual(len(advice), len(proposals))
            for record, prop, ref in zip(advice, proposals, expected):
                wire = {token(action_id): p for action_id, p in record["rerank"]["rawProbabilities"].items()}
                mapping = [(choice, index) for choice, index in prop["mapping"]]
                own = legal_distribution(prop["probs"], mapping)
                cuda = legal_distribution(ref["probs"], mapping)
                self.assertEqual(set(wire), set(own))
                wire_errors.append(max(abs(wire[k] - own[k]) for k in own))
                cuda_errors.append(max(abs(wire[k] - cuda[k]) for k in own))
                self.assertLessEqual(wire_errors[-1], 1e-12)
                self.assertLessEqual(cuda_errors[-1], 1e-5)
                self.assertGreater(wire[token(record["actionId"])], 0)
                self.assertEqual(record["actionId"], record["rerank"]["rawActionId"])
                self.assertAlmostEqual(sum(wire.values()), 1, delta=1e-9)
                reranked += record["rerank"]["rerankActionId"] != record["actionId"]
                wire_decisions += 1
            decisions += len(forwards)
            waits += len(report["waits"])
            commits += len(committed)
        self.assertGreaterEqual(decisions, 169)
        self.assertGreater(waits, 0)
        save("parity.json", {"passed": True, "games": DEFAULT_GAMES, "decisions": decisions,
            "commits_verified": commits, "terminal_pending_not_committed": 3, "wait_requests": waits,
            "max_abs_error": max(errors), "max_legal_conditional_abs_error": max(legal_errors),
            "argmax_agreement": 1.0, "decisions_after_window_boundary": after_window,
            "warm_network_p50_ms": float(np.percentile(latency, 50)), "warm_network_p95_ms": float(np.percentile(latency, 95)),
            "cold_network_ms": cold, "model_load_ms": load,
            "proposal_p50_ms": float(np.percentile(total, 50)), "proposal_p95_ms": float(np.percentile(total, 95)),
            "max_rss_bytes": max(rss), "gpu_active_range_bytes": [min(active), max(active)], "gpu_peak_bytes": max(peak),
            "sampling": "seeded numpy temperature-1 first draw; unchanged torch CPU legal redraw", "worker_sha256": WORKER_SHA,
            "action_probabilities": {"decisions": wire_decisions, "max_abs_vs_stored_legal_conditional": max(wire_errors),
                "max_abs_vs_cuda_flex_legal_conditional": max(cuda_errors), "shadow_rerank_changed_pick": reranked}})

    def test_02_trapped_stage_switch_and_stored_distribution(self):
        fixture = ROOT / "tmp/trapped-rechoice-20261020/stage-protocol/rpc-wire.jsonl"
        rpc = RPC("trapped")
        try:
            for row in read(fixture):
                response = rpc.call(row["request"])
                self.assertTrue(response["ok"], response)
        finally:
            rpc.close()
        self.assertEqual(rpc.process.returncode, 0)
        events = read(rpc.trace)
        forwards = [e for e in events if e["event"] == "forward"]
        retries = [e for e in events if e["event"] == "proposal" and e["rechoose"]]
        self.assertEqual(len(retries), 1)
        retry = retries[0]
        initial = [e for e in events if e["event"] == "proposal" and not e["rechoose"]][-1]
        self.assertEqual(retry["probs"], initial["probs"])
        self.assertEqual(retry["network_calls"], initial["network_calls"])
        self.assertEqual(retry["step"], initial["step"])
        self.assertEqual(retry["choice"]["kind"], "move")
        self.assertEqual(retry["legal"], [0, 1, 2, 3])
        self.assertEqual(len(forwards), 15)
        save("trapped-result.json", {"passed": True, "retry": retry, "forward_count": len(forwards),
            "stage_switch_count": sum(r["request"]["op"] == "stage_switch" for r in rpc.wire)})

    def test_03_leave_unloads(self):
        report, _ = replay(DEFAULT_GAMES[0], "leave", STOP_AFTER_CHUNKS="8", STOP_MODE="leave")
        self.assertTrue(all(p["absent"] for p in report["processes"]))

    def test_04_idle_unloads(self):
        report, _ = replay(DEFAULT_GAMES[0], "idle", STOP_AFTER_CHUNKS="8", STOP_MODE="idle")
        self.assertTrue(all(p["absent"] for p in report["processes"]))
        self.assertEqual(report["liveAfter"]["rooms"][0]["reason"], "idle")

    def test_05_wait_cannot_propose(self):
        rows = read(ROOT / "tmp/trapped-rechoice-20261020/stage-protocol/rpc-wire.jsonl")
        prefix = [r["request"] for r in rows[:3]]
        rpc = RPC("wait")
        try:
            for message in prefix:
                self.assertTrue(rpc.call(message)["ok"])
            preview = json.loads(prefix[-1]["data"][9:])
            identity = {**rows[3]["request"]["identity"], "rqid": 2, "requestKind": "wait", "stateRevision": 999}
            context = {**prefix[-1]["context"], "sequence": 4, "identity": identity}
            req = {"rqid": 2, "wait": True, "side": preview["side"]}
            self.assertTrue(rpc.call({"version": "metamon-worker@2", "id": 4, "op": "observe",
                "data": "|request|" + json.dumps(req), "context": context})["ok"])
            response = rpc.call({**rows[3]["request"], "id": 5, "identity": identity, "sequence": 4})
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"], "identity")
        finally:
            rpc.close()
        self.assertEqual(rpc.process.returncode, 1)
        self.assertFalse(rpc.trace.exists(), "wait must not instantiate a network")

    def test_06_unchanged_action_and_protocol_methods(self):
        # Installation without tracing changes construction only; all protocol,
        # action mappings, stored-distribution redraw and recurrence stay original.
        from mlx_worker import install, SOURCE, WEIGHTS
        worker = worker_module()
        methods = {name: getattr(worker.KakunaPolicy, name) for name in ("propose", "redraw", "resolve_index", "commit")}
        main, decoder = worker.main, worker.SocketlessBattle
        install(worker, SOURCE, WEIGHTS)
        self.assertIs(main, worker.main)
        self.assertIs(decoder, worker.SocketlessBattle)
        for name, method in methods.items():
            self.assertIs(method, getattr(worker.KakunaPolicy, name))


    def test_07_trace_disabled_preserves_samples(self):
        fixture = ROOT / "tmp/trapped-rechoice-20261020/stage-protocol/rpc-wire.jsonl"
        expected = json.loads((DEST / "trapped-process.json").read_text())["wire"]
        rpc = RPC("trace-off", trace=False)
        try:
            for row in read(fixture):
                self.assertTrue(rpc.call(row["request"])["ok"])
        finally:
            rpc.close()
        self.assertEqual(rpc.process.returncode, 0)
        self.assertEqual(rpc.wire, expected, "passive tracing must not alter seeded samples or protocol")
        self.assertFalse(rpc.trace.exists())

    def test_08_live_worker_is_rejected_while_an_offline_run_holds_the_lock(self):
        import fcntl
        with (OUT / "model.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            completed = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/metamon_port/mlx_worker.py"),
                "--checkpoint", str(CHECKPOINT)], env=ENV, capture_output=True, text=True, timeout=15)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("BlockingIOError", completed.stderr)
        self.assertEqual(completed.stdout, "")
        save("lock-test.json", {"passed": True, "exit_code": completed.returncode, "stderr": completed.stderr})

    def test_09_lead_model_reply_leaves_the_random_preview_unchanged(self):
        # The real worker with and without the UU lead model: identical replies and random preview apart from the one
        # field; the field is a 6-slot distribution from the pinned checkpoint. Timings are the real cost at preview.
        rows = read(ROOT / "tmp/trapped-rechoice-20261020/stage-protocol/rpc-wire.jsonl")[:5]
        launch = json.loads(LAUNCH.read_text())["args"]
        lead = launch[launch.index("--lead-checkpoint") + 1]
        runs = {}
        for tag, extra in (("lead-off", ()), ("lead-on", ("--lead-checkpoint", lead))):
            rpc = RPC(tag, trace=False, extra=extra)
            try:
                for row in rows:
                    self.assertTrue(rpc.call(row["request"])["ok"])
            finally:
                rpc.close()
            self.assertEqual(rpc.process.returncode, 0)
            runs[tag] = rpc
        off, on = runs["lead-off"], runs["lead-on"]
        field = on.wire[3]["response"].pop("leadModel")
        self.assertEqual([w["response"] for w in on.wire], [w["response"] for w in off.wire])
        self.assertEqual(field["status"], "ok", field)
        self.assertEqual(field["checkpointSha256"], "317b5a21bebefd6093d3b11ed8e5bf22d07f80045082552736b36e5b4755dd8c")
        self.assertEqual(len(field["leadProbabilities"]), 6)
        self.assertAlmostEqual(sum(field["leadProbabilities"]), 1, delta=1e-5)
        ms = lambda rpc: {"first_observe": rpc.ms[0], "preview_propose": rpc.ms[3]}
        save("lead-model.json", {"passed": True, "field": field, "lead_off_ms": ms(off), "lead_on_ms": ms(on)})


if __name__ == "__main__":
    unittest.main(verbosity=2)
