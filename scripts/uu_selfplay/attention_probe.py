"""Fail-closed forward AND backward parity on actual training attention modules."""
import argparse
import json
import os
from pathlib import Path
import time

import torch
from amago.nets.transformer import SlidingWindowFlexAttention
from training_attention import WindowSDPA


def probe(mode, length, batch, seed, dtype=torch.float32, compiled=False):
    torch.manual_seed(seed)
    x = torch.randn(batch, length, 3, 12, 75, device="cuda").to(dtype).requires_grad_()
    ref_x = x.detach().float().clone().requires_grad_()
    layer = (SlidingWindowFlexAttention(True, 0., 96) if mode == "flex"
             else WindowSDPA(True, 0., 96, mode)).train()
    if compiled:
        # A full graph proves that the tested attention itself was compiled,
        # rather than silently checking an eager graph-break fallback.
        layer = torch.compile(layer, fullgraph=True)
    torch.cuda.synchronize()
    start = time.monotonic()
    out = layer(x)
    # A nonuniform upstream gradient also tests more than a squared-output loss.
    upstream = torch.randn_like(out)
    (out * upstream).sum().backward()
    q, k, v = (a.transpose(1, 2) for a in ref_x.unbind(2))
    ix = torch.arange(length, device=x.device)
    distance = ix[:, None] - ix[None, :]
    mask = (distance >= 0) & (distance <= 96)
    logits = (q @ k.transpose(-1, -2)) / 75 ** .5
    ref = (logits.masked_fill(~mask, -torch.inf).softmax(-1) @ v).transpose(1, 2).to(dtype)
    (ref * upstream).sum().backward()
    torch.cuda.synchronize()
    ref_grad = ref_x.grad.to(dtype)
    oe = float((out-ref).detach().float().abs().max())
    ge = float((x.grad-ref_grad).float().abs().max())
    tolerance = (3e-5,3e-4,5e-5,5e-4) if dtype==torch.float32 else (.01,.02,.01,.02)
    passed = (torch.allclose(out,ref,atol=tolerance[0],rtol=tolerance[1])
              and torch.allclose(x.grad,ref_grad,atol=tolerance[2],rtol=tolerance[3]))
    return {"length": length, "batch": batch, "seed": seed, "outputMaxError": oe,
            "gradientMaxError": ge, "seconds": time.monotonic()-start,"tolerances":tolerance,"pass": bool(passed)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mode", choices=["flex", "MATH", "EFFICIENT_ATTENTION", "CUDNN_ATTENTION"], required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--lengths", type=int, nargs="+", default=[37,64,96,100,120,127,128,129])
    p.add_argument("--batches", type=int, nargs="+", default=[2,8])
    p.add_argument("--seeds", type=int, nargs="+", default=[0,17])
    p.add_argument("--dtype",choices=["float32","bfloat16"],default="float32")
    p.add_argument("--compiled",action="store_true",help="Require full-graph Inductor forward/backward parity")
    a = p.parse_args()
    if a.compiled and (torch._dynamo.config.disable or os.environ.get("TORCHDYNAMO_DISABLE")=="1"):
        raise ValueError("Compiled parity requested while Dynamo is globally disabled")
    result = {"torch": torch.__version__,"dtype":a.dtype,"mode": a.mode,
              "compiled":a.compiled,"rows": [], "pass": False}
    with a.out.open("x") as stream:
        try:
            for batch in a.batches:
                for seed in a.seeds:
                    for length in a.lengths:
                        row = probe(a.mode,length,batch,seed,getattr(torch,a.dtype),a.compiled)
                        result["rows"].append(row)
                        print(json.dumps(row), flush=True)
            result["pass"] = all(r["pass"] for r in result["rows"])
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"
        json.dump(result, stream, indent=2, allow_nan=False)
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
