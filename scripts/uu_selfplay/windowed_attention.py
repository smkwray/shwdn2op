"""Production-equivalent sliding-window attention for devices without flex/Triton (ROCm on
Windows, Apple CPU/MPS). Bound by gin, so serve_model needs no source patch: the run's
base-window.gin starts with `import windowed_attention`, which gin executes while parsing
UU_BASE_GIN, before the model is built. The module must be on PYTHONPATH (RUN/ext).

Semantics = gpubox's transformer.SlidingWindowFlexAttention(window_size=96) KV-cache mask:
the query at cache index s sees key kv iff kv <= s and s - kv <= window_size. amago's
VanillaAttention masks only kv > s (full causal); this class ORs in the window bound and
is otherwise amago's VanillaAttention._inference_with_cache. Cache indices roll with
amago's Cache, so the window is relative, as in production. Inference only.
"""

import math

import gin
import torch
from amago.nets.transformer import VanillaAttention


@gin.configurable(module="windowed_attention")
class SlidingWindowVanillaAttention(VanillaAttention):
    def __init__(self, causal: bool, dropout: float, window_size: int = gin.REQUIRED):
        super().__init__(causal=causal, dropout=dropout)
        if int(window_size) <= 0:
            raise ValueError("window_size must be positive")
        self.window_size = int(window_size)

    def _inference_with_cache(self, qkv, key_cache, val_cache, cache_seqlens):
        queries, keys, values = torch.unbind(qkv, dim=2)
        B, L, H, E = queries.shape
        assert L == 1
        scale = 1.0 / math.sqrt(E)
        cache_idxs = torch.arange(key_cache.shape[0], device=key_cache.device)
        key_cache[cache_idxs, cache_seqlens] = keys[:, 0]
        val_cache[cache_idxs, cache_seqlens] = values[:, 0]
        end = cache_seqlens + 1
        max_len = end.max()
        k_cache = torch.nan_to_num(key_cache[:, :max_len])
        v_cache = torch.nan_to_num(val_cache[:, :max_len])
        scores = scale * torch.einsum("blhe,blhe->blh", queries, k_cache)
        kv = torch.arange(max_len, device=cache_seqlens.device)[None, :]
        # The only change from upstream: OR in the window bound.
        mask = (kv >= end[:, None]) | (cache_seqlens[:, None] - kv > self.window_size)
        scores.masked_fill_(mask[:, :, None], -torch.inf)
        A = self.dropout(torch.softmax(scores, dim=1))
        return torch.einsum("blh,blhd->bhd", A, v_cache).unsqueeze(1)

    def forward(self, qkv, key_cache=None, val_cache=None, cache_seqlens=None):
        if key_cache is None or val_cache is None or cache_seqlens is None:
            raise RuntimeError("inference-only attention: the no-cache (training) path is not windowed")
        assert not self.training
        return self._inference_with_cache(qkv, key_cache, val_cache, cache_seqlens)
