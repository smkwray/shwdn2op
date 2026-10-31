#!/usr/bin/env python3
"""Native Windows GPU launcher for the pinned live worker, scripts/metamon-worker.py: amdbox
(AMD ROCm/HIP) and winbox (NVIDIA CUDA). Neither has Triton, so neither can run production's
compiled flex attention.

It hash-checks the pinned worker, loads it by path and runs the worker's own main(): the
JSON-lines protocol, SocketlessBattle decoder, legality, legal redraw, trapped re-choice,
stage_switch and commit logic are the pinned code, unchanged. Only what native Windows needs
is replaced:

1. RpcInput: the pinned one requires POSIX setsid/killpg. The subclass keeps its reader,
   readline and reply (one bounded in-flight frame; EOF during a request cancels via
   os._exit(1); EOF after a reply ends main normally). Process ownership is a kill-on-close
   Job Object holding this process, created before any import, so nothing it starts can
   outlive it. ssh EOF therefore ends every process of the session.
2. KakunaPolicy.__init__: HIP or CUDA device and windowed_attention.SlidingWindowVanillaAttention
   (window 96 = production's --attention-backend flex mask, validated against amago's
   SlidingWindowFlexAttention) instead of the CUDA-only flex/flash pins. Same Kakuna
   construction, checkpoint gate, seeds, captured distribution and recurrence state.
3. Numerics: hipBLAS(Lt) batch-1 fp32 GEMV accumulates with ~5x CPU's fp32 error, which
   moved probabilities by up to 1.7e-5 vs gpubox CUDA flex. Linear calls with <= 4 rows on HIP
   are computed as an exact-math multiply + sum reduction (same result in real arithmetic,
   ~1e-7 relative error); everything else is untouched. CUDA keeps cuBLAS, as production does:
   without the fix winbox's live path is within 3.5e-6 of gpubox CUDA flex (169/169 decisions).
4. Network: poke-env builds an asyncio loop at import, and on Windows its self-pipe is a
   loopback socketpair, which the worker's guard (installed in main before that import)
   rejects. The policy modules are imported first under a loopback-only guard; the worker's
   own strict guard is then installed unchanged by main().

Wrapper arguments (removed before the worker's argparse): --runtime DIR, the device-local
runtime (venv, metamon fork assembled at RUNTIME/fork by vendor/metamon/assemble.py, cache), and --label TAG, informational only; launch
configs pass {seed} so the companion journal records the backend and battle. All other
arguments go to the pinned worker (--checkpoint, --attention-backend flex, --seed,
--seed-per-side). Propose replies carry the optional actionProbabilities field (the worker's own
legal-action distribution, scripts/metamon_port/action_probs.py). Opt-in METAMON_LIVE_PROB_LOG=DIR writes one JSONL file per process with each
decision's action distribution (validation only: it contains private battle state).
A non-private runtime log (start, device, policy ready, exit) goes to RUNTIME/live-logs/.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WORKER = ROOT / "scripts" / "metamon-worker.py"
WORKER_SHA = "917558eddf56e58dd1cd05332974df11d937549542fc4bc3674c8323d05ab5e9"
KIT = ROOT / "scripts" / "uu_selfplay"  # windowed_attention.py
WINDOW = 96
_JOB = None  # kept open for the life of the process (kill-on-close)


def own_job_object():
    """Put this process in a fresh kill-on-close Job Object; descendants inherit membership."""
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    k32.GetCurrentProcess.restype = wintypes.HANDLE

    class Limits(ctypes.Structure):  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
                    ("Io", ctypes.c_ulonglong * 6), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]
    job = k32.CreateJobObjectW(None, None)
    limits = Limits()
    limits.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not (job and k32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits))
            and k32.AssignProcessToJobObject(job, k32.GetCurrentProcess())):
        raise OSError(f"job object setup failed: {ctypes.get_last_error()}")
    return job


def split_args(argv):
    runtime, label, rest, i = None, None, [], 0
    while i < len(argv):
        if argv[i] in ("--runtime", "--label") and i + 1 < len(argv):
            if argv[i] == "--runtime":
                runtime = Path(argv[i + 1])
            else:
                label = argv[i + 1]
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    if runtime is None or not runtime.is_dir():
        raise SystemExit("--runtime DIR (device-local venv/source/cache) is required")
    return runtime, label, rest


class RuntimeLog:
    """Non-private lifecycle events only (no protocol data)."""

    def __init__(self, runtime, label):
        self.path = runtime / "live-logs" / f"live-{time.strftime('%Y%m%d')}.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.base = {"pid": os.getpid(), "label": label, "runtime": "windows"}  # backend added once torch loads

    def __call__(self, event, **fields):
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, **self.base, **fields})
        with open(self.path, "a", encoding="utf8") as f:
            f.write(line + "\n")


def accurate_small_linear(torch):
    """hipBLAS(Lt) GEMV has ~1e-6 relative error at K=900..3600 (CPU fp32: ~2.5e-7). Rows <= 4
    on HIP use multiply + sum (torch's tree reduction, ~1e-7); same math, all else unchanged."""
    import torch.nn.functional as F
    blas_linear = F.linear

    def linear(x, weight, bias=None):
        if x.is_cuda and x.dtype == torch.float32 and x.dim() >= 1 and x.numel() <= 4 * x.shape[-1]:
            y = (x.unsqueeze(-2) * weight).sum(-1)
            return y if bias is None else y + bias
        return blas_linear(x, weight, bias)
    F.linear = linear


def main():
    global _JOB
    _JOB = own_job_object()  # before imports or threads: ownership of everything this worker starts
    runtime, label, worker_args = split_args(sys.argv[1:])
    log = RuntimeLog(runtime, label)
    cache = runtime / "cache"
    for name, sub in {"METAMON_CACHE_DIR": "metamon", "HF_HOME": "hf", "TORCH_HOME": "torch", "XDG_CACHE_HOME": "xdg"}.items():
        (cache / sub).mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(cache / sub)
    (runtime / "scratch").mkdir(exist_ok=True)
    os.environ["TEMP"] = os.environ["TMP"] = str(runtime / "scratch")
    for name, value in {"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "WANDB_MODE": "disabled",
                        "PYTHONDONTWRITEBYTECODE": "1", "TORCHDYNAMO_DISABLE": "1", "OMP_NUM_THREADS": "1",
                        "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "NUMEXPR_NUM_THREADS": "1"}.items():
        os.environ[name] = value
    sys.dont_write_bytecode = True
    # The project's Metamon fork, assembled with its upstream data; the worker checks its tree against the pin.
    sys.path[:0] = [str(runtime / "fork"), str(KIT)]
    sys.stdout.reconfigure(newline="\n")  # the JSON-lines wire stays LF on Windows

    def loopback_only(event, args):
        if event == "socket.connect" and isinstance(args[1], tuple) and args[1][0] in ("127.0.0.1", "::1"):
            return
        if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto"):
            raise RuntimeError("network is forbidden")
    sys.addaudithook(loopback_only)

    with open(WORKER, "rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    if digest != WORKER_SHA:
        log("refused", reason="worker_sha256", sha256=digest)
        raise SystemExit("pinned worker hash mismatch")
    spec = importlib.util.spec_from_file_location("pinned_metamon_worker", WORKER)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)

    import metamon.rl.pretrained  # noqa: F401  worker's first import (GenData order), before its strict guard
    import torch
    import windowed_attention
    hip = bool(torch.version.hip)
    if hip:
        accurate_small_linear(torch)
    log.base["runtime"] = "rocm-windows-window96-sumlinear" if hip else "cuda-windows-window96"
    props = torch.cuda.get_device_properties(0) if torch.cuda.is_available() else None
    log("start", worker_sha256=WORKER_SHA, torch=torch.__version__, hip=torch.version.hip, cuda=torch.version.cuda,
        device=props.name if props else None,
        arch=(props.gcnArchName if hip else f"sm_{props.major}{props.minor}") if props else None)
    require = worker.require

    class WindowsRpcInput(worker.RpcInput):
        """The pinned reader/readline/reply; Job Object ownership instead of setsid/killpg."""

        def __init__(self):
            self.condition = threading.Condition()
            self.frame = None
            self.busy = False
            self.eof = False
            threading.Thread(target=self._read, name="metamon-stdin", daemon=True).start()

        def _cancel(self):
            try:
                log("cancel", reason="eof_or_protocol_during_request")
            finally:
                os._exit(1)  # kill-on-close then ends anything this process started

    def windows_init(self, checkpoint, seed, attention="flash"):
        import amago
        import gin
        import numpy as np
        from metamon.rl.pretrained import Kakuna
        from metamon.rl.metamon_to_amago import make_placeholder_env
        from amago.nets.transformer import SelfAttention
        window_cls = windowed_attention.SlidingWindowVanillaAttention
        require(amago.__version__ == "3.4.0" and torch.cuda.is_available() and bool(torch.version.hip or torch.version.cuda), "runtime")
        require(attention == "flex", "runtime")  # flex = production window-96 semantics, eager here
        started = time.perf_counter()
        torch.set_num_threads(1)
        torch.manual_seed(seed)
        np.random.seed(seed)
        self.model = Kakuna()

        def local_checkpoint(epoch):
            require(epoch == 34, "provenance")
            gin.bind_parameter("MetamonAMAGOExperiment.traj_save_len", 10_000_000_000)
            gin.bind_parameter("traj_encoders.TformerTrajEncoder.attention_type", window_cls)
            gin.bind_parameter("windowed_attention.SlidingWindowVanillaAttention.window_size", WINDOW)
            return str(checkpoint)
        self.model.get_path_to_checkpoint = local_checkpoint
        self.experiment = self.model.initialize_agent(checkpoint=34, log=False)
        require(self.experiment.DEVICE.type == "cuda", "runtime")
        self.policy = self.experiment.policy
        self.policy.eval()
        self.seed = seed
        actor_forward = self.policy.actor.forward

        def capture(*args, **kwargs):
            self.last_dist = actor_forward(*args, **kwargs)
            return self.last_dist
        self.policy.actor.forward = capture
        layers = [m for m in self.policy.modules() if isinstance(m, SelfAttention)]
        require(len(layers) == 10 and all(type(m) is window_cls and m.window_size == WINDOW for m in layers), "runtime")
        self.wrapper = make_placeholder_env(self.model.observation_space, self.model.action_space)
        self.model.observation_space.reset()
        self.hidden = self.policy.traj_encoder.init_hidden_state(1, self.experiment.DEVICE)
        self.previous_state = None
        self.previous_action = np.zeros((1, self.wrapper.action_size), dtype=self.wrapper.action_dtype)
        self.step = 0
        self.pending = None
        torch.cuda.synchronize()
        log("policy_ready", load_s=round(time.perf_counter() - started, 2), seed=seed,
            gpu_allocated_mb=round(torch.cuda.memory_allocated() / 2**20, 1))

    worker.RpcInput = WindowsRpcInput
    worker.KakunaPolicy.__init__ = windows_init
    prob_dir = os.environ.get("METAMON_LIVE_PROB_LOG")
    if prob_dir:
        Path(prob_dir).mkdir(parents=True, exist_ok=True)
        prob_file = Path(prob_dir) / f"{label or 'nolabel'}-{os.getpid()}.jsonl"
        propose = worker.KakunaPolicy.propose

        def logged_propose(self, battle, request, rechoose=False):
            started = time.perf_counter()
            choice = propose(self, battle, request, rechoose)
            probs = self.last_dist.probs[0, -1, -1].float().cpu()
            legal = sorted({index for _, index in self.pending[1]})
            with open(prob_file, "a", encoding="utf8") as f:
                f.write(json.dumps({"side": request["side"]["id"], "rqid": request["rqid"],
                                    "step": self.step - 1, "rechoose": rechoose,  # a re-choice keeps its decision's step
                                    "probs": probs.tolist(), "legal": legal, "argmax": int(probs.argmax()),
                                    "redrawn": bool(self.redrawn), "choice": choice, "seed": self.seed,
                                    "propose_ms": round((time.perf_counter() - started) * 1000, 2)}) + "\n")
            return choice
        worker.KakunaPolicy.propose = logged_propose

    probs_spec = importlib.util.spec_from_file_location("action_probs", HERE.parent / "action_probs.py")
    action_probs = importlib.util.module_from_spec(probs_spec)
    probs_spec.loader.exec_module(action_probs)
    action_probs.install(worker)  # Optional actionProbabilities on propose replies; sampling unchanged.
    sys.argv = [str(WORKER), *worker_args]
    code = 1
    try:
        code = worker.main()
    finally:
        log("exit", code=code, gpu_allocated_mb=round(torch.cuda.memory_allocated() / 2**20, 1)
            if torch.cuda.is_available() and torch.cuda.is_initialized() else None)
    return code


if __name__ == "__main__":
    sys.exit(main())
