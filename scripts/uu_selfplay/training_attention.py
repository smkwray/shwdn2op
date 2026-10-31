"""Explicit fp32 SDPA training alternative; cached inference remains upstream Flex.

Use only after attention_probe.py passes on the target runtime. The mask is the
same inclusive causal window as SlidingWindowFlexAttention, including distance 96.
"""
import gin
import torch
from torch.nn.attention import SDPBackend, sdpa_kernel
from amago.nets.transformer import SlidingWindowFlexAttention


@gin.configurable(module="training_attention")
class WindowSDPA(SlidingWindowFlexAttention):
    def __init__(self, causal, dropout, window_size=96, backend="MATH"):
        super().__init__(causal, dropout, window_size)
        if not causal:
            raise ValueError("WindowSDPA requires causal attention")
        self.window_size = window_size
        self.backend = SDPBackend.__members__[backend]

    def forward(self, qkv, key_cache=None, val_cache=None, cache_seqlens=None):
        if any(x is not None for x in (key_cache, val_cache, cache_seqlens)):
            return super().forward(qkv, key_cache, val_cache, cache_seqlens)
        q, k, v = (x.transpose(1, 2) for x in qkv.unbind(2))
        ix = torch.arange(q.shape[-2], device=q.device)
        distance = ix[:, None] - ix[None, :]
        mask = (distance >= 0) & (distance <= self.window_size)
        with sdpa_kernel(self.backend):
            out = torch.nn.functional.scaled_dot_product_attention(q, k, v, attn_mask=mask)
        return out.transpose(1, 2)
