"""Upstream AMAGO forward, with a dense fp32 reference for flex's mask."""

from common import OUT, configure_model, worker_module


def dense_window(qkv, key_cache, val_cache, cache_seqlens, window=96):
    import torch
    import torch.nn.functional as F
    q, k, v = qkv.unbind(2)
    batch = torch.arange(k.shape[0], device=k.device)
    key_cache[batch, cache_seqlens] = k[:, 0]
    val_cache[batch, cache_seqlens] = v[:, 0]
    end = int(cache_seqlens.max().item()) + 1
    idx = torch.arange(end, device=k.device)
    distance = cache_seqlens[:, None] - idx[None, :]
    mask = ((distance >= 0) & (distance <= window))[:, None, None, :]
    out = F.scaled_dot_product_attention(q.transpose(1, 2),
        torch.nan_to_num(key_cache[:, :end]).transpose(1, 2),
        torch.nan_to_num(val_cache[:, :end]).transpose(1, 2), attn_mask=mask)
    return out.transpose(1, 2)


class TorchBackend:
    def __init__(self, backend, checkpoint, source, seed):
        import torch
        import gin
        from amago.agent import MultiTaskAgent
        from amago.envs.amago_env import SequenceWrapper
        from amago.nets.traj_encoders import TformerTrajEncoder
        from amago.nets.transformer import SlidingWindowFlexAttention
        from metamon.rl.metamon_to_amago import MetamonPerceiverTstepEncoder, make_placeholder_env
        torch.set_num_threads(4)
        torch.manual_seed(seed)
        self.production = backend == "torch-cuda-flex"
        self.device = torch.device({"torch-cpu": "cpu", "torch-mps": "mps", "torch-cuda-flex": "cuda", "torch-cuda-sdpa": "cuda"}[backend])
        if backend == "torch-cuda-sdpa":torch.set_float32_matmul_precision("highest")
        self.worker = worker_module()
        self.model = configure_model(source)
        if self.production:
            # Use the actual pinned worker constructor/get_actions/caster. Only
            # repair config package-data locations in memory; no worker edits.
            import metamon.rl
            from pathlib import Path
            metamon.rl.MODEL_CONFIG_DIR = str(Path(source) / "metamon/rl/configs/models")
            metamon.rl.TRAINING_CONFIG_DIR = str(Path(source) / "metamon/rl/configs/training")
            # PretrainedModel derives its experiment write root from parents[2]
            # of the checkpoint. Keep even that upstream scaffolding in OUT.
            native_checkpoint = OUT / "native/kakuna/ckpts/policy_weights/policy_epoch_34.pt"
            native_checkpoint.parent.mkdir(parents=True, exist_ok=True)
            if native_checkpoint.exists() or native_checkpoint.is_symlink():
                if native_checkpoint.resolve() != Path(checkpoint).resolve():
                    raise RuntimeError("Native checkpoint link points to another asset")
            else:
                native_checkpoint.symlink_to(Path(checkpoint).resolve())
            self.native = self.worker.KakunaPolicy(native_checkpoint, seed, "flex")
            self.policy, self.model = self.native.policy, self.native.model
            self.metadata = {"torch": torch.__version__, "device": str(self.device),
                             "mixed_precision": self.native.experiment.mixed_precision,
                             "attention": "upstream SlidingWindowFlexAttention(96)"}
        else:
            if backend == "torch-mps" and not torch.backends.mps.is_available():
                raise RuntimeError("MPS unavailable")
            class DenseSlidingWindow(SlidingWindowFlexAttention):
                def __init__(self, causal, dropout):
                    super().__init__(causal, dropout, window_size=96)
                def forward(self, qkv, key_cache=None, val_cache=None, cache_seqlens=None):
                    return dense_window(qkv, key_cache, val_cache, cache_seqlens)
            gin.bind_parameter("traj_encoders.TformerTrajEncoder.attention_type", DenseSlidingWindow)
            wrapper = SequenceWrapper(make_placeholder_env(self.model.observation_space, self.model.action_space),
                                      save_every=(10_000_000_000, 10_000_000_000), save_trajs_to=None)
            # Identical to Experiment.init_model, but without optimizer/env runner.
            self.policy = MultiTaskAgent(obs_space=wrapper.rl2_space["obs"],
                rl2_space=wrapper.rl2_space["rl2"], action_space=wrapper.action_space,
                max_seq_len=128, tstep_encoder_type=MetamonPerceiverTstepEncoder,
                traj_encoder_type=TformerTrajEncoder)
            state = torch.load(checkpoint, map_location="cpu", weights_only=True, mmap=True)
            self.model._validate_checkpoint(state, self.policy.state_dict())
            self.policy.load_state_dict(state, strict=True, assign=True)
            self.policy.on_checkpoint_loaded(is_resume=False)
            self.policy.to(self.device).eval()
            # CPU/MPS reference is fp32; compiled CUDA Flex is kept untouched.
            self.metadata = {"torch": torch.__version__, "device": str(self.device),
                             "mixed_precision": "no", "attention": "dense SDPA, 0 <= q-k <= 96"}
            actor_forward = self.policy.actor.forward
            def capture(*args, **kwargs):
                self.last_dist = actor_forward(*args, **kwargs)
                return self.last_dist
            self.policy.actor.forward = capture
        self.reset()

    def reset(self):
        self.hidden = self.policy.traj_encoder.init_hidden_state(1, self.device)

    def sync(self):
        import torch
        if self.device.type == "mps":
            torch.mps.synchronize()
        elif self.device.type == "cuda":
            torch.cuda.synchronize()

    def step(self, obs, rl2, time_idx):
        import contextlib
        import torch
        tensor = lambda x: torch.from_numpy(x).to(self.device).unsqueeze(1)
        caster = self.native.experiment.caster() if self.production else contextlib.nullcontext()
        with torch.no_grad(), caster:
            actions, self.hidden = self.policy.get_actions(obs={k: tensor(v) for k, v in obs.items()},
                rl2s=tensor(rl2), time_idxs=tensor(time_idx), hidden_state=self.hidden, sample=self.production)
            dist = self.native.last_dist if self.production else self.last_dist
            probs = dist.probs[0, -1, -1].float()
            if self.production and bool(obs["illegal_actions"][0, int(actions.item())]):
                # Preserve the production worker's legal-redraw RNG path, even
                # though only recorded commits drive the recurrent inputs.
                keep = ~tensor(obs["illegal_actions"])[0, 0]
                conditional = probs * keep
                torch.multinomial(conditional / conditional.sum(), 1)
            return probs.cpu().numpy()

    def memory(self):
        import torch
        if self.device.type == "mps":
            return {"gpu_active_bytes": torch.mps.current_allocated_memory(),
                    "gpu_driver_bytes": torch.mps.driver_allocated_memory()}
        if self.device.type == "cuda":
            return {"gpu_active_bytes": torch.cuda.memory_allocated(),
                    "gpu_peak_bytes": torch.cuda.max_memory_allocated()}
        return {}

    def close(self):
        import gc
        import torch
        self.hidden = self.policy = None
        self.last_dist = None
        if self.production:
            self.native = None
        gc.collect()
        if self.device.type == "mps":
            torch.mps.synchronize()
            torch.mps.empty_cache()
        elif self.device.type == "cuda":
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
        return self.memory()
