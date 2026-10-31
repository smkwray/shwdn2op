"""Probe flex_attention forward+backward on this GPU at Kakuna's shapes (B2 H12 D75 fp32, window 96) against a
dense reference. Usage: python flex_probe.py EAGER|KERNEL_OPTIONS_JSON|null [L]. Prints one JSON line.
GB10/torch 2.11 (2026-10-20): compiled backward grad error 311 at L=100 and 420 at L=127; eager <= 2.8e-5.
Re-run across L (e.g. 37 64 96 100 120 127 128) after any torch/driver change before compiled training."""
import json, sys, time, torch
from torch.nn.attention.flex_attention import flex_attention, create_block_mask, and_masks
eager = sys.argv[1] == "EAGER"
opts = None if eager else json.loads(sys.argv[1])
B, H, D, W = 2, 12, 75, 96
L = int(sys.argv[2]) if len(sys.argv) > 2 else 128
torch.manual_seed(0)
q, k, v = (torch.randn(B, H, L, D, device="cuda", requires_grad=True) for _ in range(3))
mask = create_block_mask(and_masks(lambda b, h, qi, ki: qi - ki <= W, lambda b, h, qi, ki: qi >= ki), None, None, L, L)
fa = (lambda q, k, v: flex_attention(q, k, v, block_mask=mask)) if eager else torch.compile(lambda q, k, v: flex_attention(q, k, v, block_mask=mask, kernel_options=opts))
try:
    t = time.time(); out = fa(q, k, v); out.square().sum().backward(); torch.cuda.synchronize()
    g = [x.grad.clone() for x in (q, k, v)]
    for x in (q, k, v): x.grad = None
    i = torch.arange(L, device="cuda"); m = (i[:, None] >= i[None, :]) & (i[:, None] - i[None, :] <= W)
    ref = torch.softmax((q @ k.transpose(-1, -2)) / D ** 0.5 + torch.where(m, 0.0, float("-inf")), -1) @ v
    ref.square().sum().backward()
    print(json.dumps({"opts": opts, "ok": True, "first_s": round(time.time() - t, 1), "out_err": float((out - ref).abs().max()),
                      "grad_err": max(float((a - b.grad).abs().max()) for a, b in zip(g, (q, k, v)))}))
except Exception as e:
    print(json.dumps({"opts": opts, "ok": False, "error": f"{type(e).__name__}: {str(e)[:160]}"}))
