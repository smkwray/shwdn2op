"""Kakuna fp32 inference in MLX, without torch tensors in the forward path.

Evaluation only. SigmaReparam matrices are frozen at conversion using AMAGO's
einsum order. QKV has the unusual (three, head_dim, heads) storage order.
Window 96 is inclusive: current token plus at most 96 predecessors.
"""

import json
import math
from pathlib import Path

from common import CKPT_SHA, digest


def convert(checkpoint, destination, expected=CKPT_SHA):
    """One CPU conversion process; retain only weights used by get_actions."""
    import numpy as np
    import torch
    import mlx.core as mx
    from einops import einsum
    torch.set_num_threads(4)
    if digest(checkpoint) != expected:
        raise RuntimeError("Checkpoint SHA256 mismatch")
    mx.set_default_device(mx.cpu)
    state = torch.load(checkpoint, weights_only=True, map_location="cpu", mmap=True)
    weights = {}
    folded = []
    for name, value in state.items():
        if not name.startswith(("tstep_encoder.", "traj_encoder.", "actor.")):
            continue  # critics/targets/PopArt are not in the inference graph
        prefix = name.rsplit(".", 1)[0]
        if name.endswith((".gamma", ".u", ".v")):
            continue
        if name.endswith(".weight") and prefix + ".gamma" in state:
            sigma = einsum(state[prefix + ".u"], value, state[prefix + ".v"], "d, d c, c->")
            value = state[prefix + ".gamma"] / sigma * value
            folded.append(prefix)
        weights[name] = mx.array(np.asarray(value.detach().float().numpy()).copy())
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    mx.save_safetensors(str(destination), weights)
    metadata = {"checkpoint_sha256": expected, "weights_sha256": digest(destination),
                "dtype": "float32", "tensors": len(weights),
                "elements": sum(x.size for x in weights.values()), "sigma_folded": folded,
                "semantics": "eval; causal inclusive distance <=96; actor final gamma; probability clamp [0.001,0.99]"}
    destination.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n")
    return metadata


class MLXKakuna:
    def __init__(self, weights, expected=CKPT_SHA):
        import mlx.core as mx
        self.mx = mx
        if not mx.metal.is_available():
            raise RuntimeError("Metal GPU required; no CPU fallback")
        mx.set_default_device(mx.gpu)
        mx.set_cache_limit(64 * 1024**2)
        mx.set_memory_limit(2 * 1024**3)
        manifest = json.loads(Path(weights).with_suffix(".json").read_text())
        if manifest["checkpoint_sha256"] != expected or manifest["weights_sha256"] != digest(weights):
            raise RuntimeError("Converted weight provenance mismatch")
        self.w = mx.load(str(weights))
        mx.eval(self.w)
        self.metadata = {"device": str(mx.default_device()), "metal_available": mx.metal.is_available(),
                         "gpu": mx.device_info(mx.gpu), "dtype": "float32",
                         "attention": "0 <= q-k <= 96; 97 KV slots"}
        if mx.default_device() != mx.gpu:
            raise RuntimeError("MLX did not select GPU")
        self.reset()

    def reset(self):
        self.cache = [None] * 10

    def linear(self, x, p):
        y = x @ self.w[p + ".weight"].T
        if p + ".bias" in self.w:
            y = y + self.w[p + ".bias"]
        return y

    def norm(self, x, p):
        return self.mx.fast.layer_norm(x, self.w[p + ".weight"], self.w[p + ".bias"], 1e-5)

    def leaky(self, x):
        return self.mx.where(x >= 0, x, x * 0.01)

    def mha(self, query, kv, p, self_attention=False):
        mx = self.mx
        weight, bias = self.w[p + ".in_proj_weight"], self.w[p + ".in_proj_bias"]
        d = query.shape[-1]
        if self_attention:
            q, k, v = mx.split(query @ weight.T + bias, 3, axis=-1)
        else:
            q = query @ weight[:d].T + bias[:d]
            k, v = mx.split(kv @ weight[d:].T + bias[d:], 2, axis=-1)
        split = lambda x: x.reshape(1, x.shape[1], 8, d // 8).transpose(0, 2, 1, 3)
        q, k, v = map(split, (q, k, v))
        out = mx.fast.scaled_dot_product_attention(q, k, v, scale=(d // 8)**-0.5)
        out = out.transpose(0, 2, 1, 3).reshape(1, query.shape[1], d)
        return self.linear(out, p + ".out_proj")

    def timestep(self, obs, rl2):
        mx = self.mx
        p = "tstep_encoder"
        extras = self.leaky(self.linear(mx.sign(rl2) * mx.log(mx.abs(rl2) + 1), p + ".extra_emb"))
        numbers = mx.concatenate((obs["numbers"], extras), axis=-1)
        p += ".turn_embedding"
        table = self.w[p + ".token_embedding.text_emb.weight"]
        tokens = mx.clip(obs["text_tokens"] + 1, 0, table.shape[0])
        text = self.leaky(self.linear(table[tokens], p + ".multimodal_fuse.text_emb"))
        num = self.leaky(self.linear(numbers, p + ".multimodal_fuse.num_emb")).reshape(1, 6, 168)
        seq = mx.concatenate((text, num), axis=1)
        pos = self.w[p + ".learned_pos.pos_emb.weight"]
        seq = seq + pos[mx.minimum(mx.arange(seq.shape[1]), pos.shape[0] - 1)]
        p += ".perceiver"
        latents = self.w[p + ".latents"][None]
        for i in range(10):
            c = f"{p}.cross_blocks.{i}"
            q = self.norm(latents, c + ".norm_q")
            kv = self.norm(seq, c + ".norm_kv")
            latents = latents + self.mha(q, kv, c + ".attn")
            latents = latents + self.perceiver_ff(self.norm(latents, c + ".norm_ff"), c)
            s = f"{p}.self_blocks.{i}"
            q = self.norm(latents, s + ".norm_attn")
            latents = latents + self.mha(q, q, s + ".attn", self_attention=True)
            latents = latents + self.perceiver_ff(self.norm(latents, s + ".norm_ff"), s)
        return latents.reshape(1, 1, -1)

    def perceiver_ff(self, x, p):
        mx = self.mx
        x = self.linear(x, p + ".ff.0")
        return self.linear(x * mx.sigmoid(x), p + ".ff.2")  # SiLU, not leaky_relu

    def trajectory(self, x, step):
        mx = self.mx
        p = "traj_encoder.tformer"
        x = self.linear(x, p + ".inp")
        coeff = mx.exp(mx.arange(0, 900, 2, dtype=mx.float32) * -(math.log(10000.0) / 900))
        angle = coeff * step
        position = mx.stack((mx.sin(angle), mx.cos(angle)), axis=-1).reshape(900)
        x = x + position
        for i in range(10):
            t = f"{p}.layers.{i}"
            a = t + ".attention_layer"
            qkv = self.linear(self.norm(x, t + ".norm1.norm"), a + ".qkv_projection")
            # AMAGO: (three d_qkv heads) -> three heads d_qkv.
            qkv = qkv.reshape(1, 1, 3, 75, 12).transpose(0, 1, 2, 4, 3)
            q, k, v = [qkv[:, :, j].transpose(0, 2, 1, 3) for j in range(3)]
            old = self.cache[i]
            if old is not None:
                k = mx.concatenate((old[0], k), axis=2)[:, :, -97:]
                v = mx.concatenate((old[1], v), axis=2)[:, :, -97:]
            self.cache[i] = (k, v)
            out = mx.fast.scaled_dot_product_attention(q, k, v, scale=75**-0.5)
            out = out.transpose(0, 2, 1, 3) * self.w[a + ".head_scaler"]
            x = x + self.norm(self.linear(out.reshape(1, 1, 900), a + ".out_projection"), t + ".norm2.norm")
            ff = self.leaky(self.linear(self.norm(x, t + ".norm3.norm"), t + ".ff1"))
            x = x + self.linear(self.norm(ff, t + ".norm4.norm"), t + ".ff2")
        return self.norm(x, p + ".norm.norm")

    def actor(self, x, illegal):
        mx = self.mx
        x = self.linear(self.leaky(self.linear(x, "actor.inp.in_layer")), "actor.inp.out_layer")
        for i in range(3):
            p = f"actor.residual_blocks.{i}"
            y = self.leaky(self.norm(self.linear(x, p + ".0"), p + ".1.norm"))
            x = x + self.norm(self.linear(y, p + ".3"), p + ".4.norm")
        logits = self.linear(x, "actor.out").reshape(1, 1, 7, 13)[0, 0, -1]
        mask = mx.logical_and(illegal.reshape(13), ~mx.all(illegal))
        logits = mx.where(mask, -float("inf"), logits)
        probs = mx.clip(mx.softmax(logits), 0.001, 0.99)
        return probs / mx.sum(probs)

    def step(self, obs, rl2, time_idx, *, defer=False):
        import numpy as np
        mx = self.mx
        obs = {k: mx.array(v) for k, v in obs.items()}
        # Kakuna's pinned configuration leaves hide_rewards/hide_rl2s disabled.
        x = self.timestep(obs, mx.array(rl2))
        x = self.trajectory(x, int(time_idx.item()))
        probs = self.actor(x, obs["illegal_actions"])
        if defer:
            return probs
        mx.eval(probs, self.cache)
        return np.array(probs)

    def sync(self):
        self.mx.synchronize()

    def memory(self):
        return {"gpu_active_bytes": self.mx.get_active_memory(), "gpu_peak_bytes": self.mx.get_peak_memory(),
                "gpu_cache_bytes": self.mx.get_cache_memory()}

    def close(self):
        import gc
        self.w, self.cache = {}, []
        gc.collect()
        self.mx.synchronize()
        self.mx.clear_cache()
        return self.memory()
