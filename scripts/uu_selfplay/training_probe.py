"""Measure the selected Metamon trainer, including data loading and real updates.

Pass normal metamon.rl.finetune flags after --. Probes never save model files.
Every measured row binds the actual optimizer counter, losses and batch shape.
"""
import argparse
import json
import math
from pathlib import Path
import random
import runpy
import sys
import time

import psutil
import numpy as np
import torch
from metamon.rl.metamon_to_amago import MetamonAMAGOExperiment


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--warmup", type=int, default=3)
    p.add_argument("--mixed-precision",choices=["no","bf16"],default="no")
    a, trainer = p.parse_known_args()
    if trainer[:1] == ["--"]:
        trainer = trainer[1:]
    torch.manual_seed(2718)
    random.seed(2718)
    np.random.seed(2718)
    # The first compiled call normally disables distribution validation. SDPA
    # need not compile; preserve the trainer's padded-distribution semantics.
    torch.distributions.Distribution.set_default_validate_args(False)
    original = MetamonAMAGOExperiment.train_step
    post_init = MetamonAMAGOExperiment.__post_init__
    def initialize(self):
        self.mixed_precision = a.mixed_precision
        post_init(self)
    MetamonAMAGOExperiment.__post_init__ = initialize
    rows, previous, critic = [], None, None

    def step(self, batch, log_step):
        nonlocal previous, critic
        self.verbose = False
        self.always_save_latest = False
        self.ckpt_interval = None
        if critic is None:
            critic = next(self.policy.critics.parameters())
            self._probe_critic_start = critic.detach().clone()
            from amago.nets.transformer import SlidingWindowFlexAttention
            attention = next(m for m in self.policy.traj_encoder.modules() if isinstance(m,SlidingWindowFlexAttention))
            def capture_dtype(module,inputs,keywords):self._probe_attention_dtype = str(keywords["qkv"].dtype)
            attention.register_forward_pre_hook(capture_dtype,with_kwargs=True)
        torch.cuda.synchronize()
        start = time.monotonic()
        result = original(self,batch,log_step)
        torch.cuda.synchronize()
        end = time.monotonic()
        expected = "torch.bfloat16" if a.mixed_precision=="bf16" else "torch.float32"
        if self._probe_attention_dtype!=expected:
            raise ValueError(f"Wrong actual attention precision: {self._probe_attention_dtype}, expected {expected}")
        scalars = {k: float(v.detach().float().mean()) if isinstance(v, torch.Tensor) else float(v)
                   for k,v in result.items() if isinstance(v, (torch.Tensor, int, float))}
        nonfinite = {k:repr(v) for k,v in scalars.items() if not math.isfinite(v)}
        critical = {k:v for k,v in nonfinite.items() if "loss" in k.lower() or "grad" in k.lower()}
        if critical:
            raise FloatingPointError(f"Nonfinite trainer loss/gradient: {critical}")
        gradients = [torch.isfinite(p.grad).all() for p in self.policy.parameters() if p.grad is not None]
        if not gradients or not bool(torch.stack(gradients).all()):
            raise FloatingPointError("Nonfinite or absent parameter gradients")
        # Upstream logs unbiased std of a singleton temperature tensor as NaN.
        # Keep unavailable diagnostics explicit; never confuse them with loss.
        scalars = {k:v if math.isfinite(v) else None for k,v in scalars.items()}
        row = {"microbatch": len(rows), "updates": int(self.grad_update_counter),
               "computeSeconds": end-start, "wallSeconds": None if previous is None else end-previous,
               "shape": list(batch.rl2s.shape), "losses": scalars,"nonfiniteDiagnostics":nonfinite,
               "mixedPrecision":self.mixed_precision,"attentionDtype":self._probe_attention_dtype,
               "gpuPeakBytes": torch.cuda.max_memory_allocated(),
               "rssBytes": psutil.Process().memory_info().rss,
               "availableBytes": psutil.virtual_memory().available,
               "criticMaxChange": float((critic-self._probe_critic_start).abs().max())}
        rows.append(row)
        with a.out.open("a") as f:
            f.write(json.dumps(row, allow_nan=False)+"\n")
        print(json.dumps(row, allow_nan=False), flush=True)
        previous = end
        return result

    if a.out.exists():
        raise FileExistsError(a.out)
    MetamonAMAGOExperiment.train_step = step
    sys.argv = ["metamon.rl.finetune", *trainer]
    runpy.run_module("metamon.rl.finetune", run_name="__main__", alter_sys=True)
    measured = rows[a.warmup:]
    elapsed = sum(r["wallSeconds"] for r in measured)
    updates = rows[-1]["updates"] - rows[a.warmup-1]["updates"]
    report = {"torch": torch.__version__,"mixedPrecision":a.mixed_precision,"attentionDtype":rows[-1]["attentionDtype"],
              "loggingCadence":"production log_step; explicit finite-gradient check each update",
              "updates": updates, "seconds": elapsed,
              "updatesPerHour": updates*3600/elapsed,
              "trajectorySamplesPerHour": sum(r["shape"][0] for r in measured)*3600/elapsed,
              "maxSequenceLength": max(r["shape"][1] for r in rows),
              "gpuPeakBytes": max(r["gpuPeakBytes"] for r in rows),
              "criticMaxChange": rows[-1]["criticMaxChange"], "rows": len(rows)}
    a.out.with_suffix(".summary.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
