"""One pinned policy, independent recurrent state and RNG per client, ready batching.

The worker's propose/commit and observation code remain the implementation. Only
its get_actions call is scheduled and its global RNG becomes a client generator.
"""
import copy
import contextlib
from concurrent.futures import Future
import math
import queue
import threading
import time
from types import SimpleNamespace

import numpy as np
import torch
from torch.nn.attention.flex_attention import flex_attention


CUDA_INFERENCE_LOCK = threading.Lock()


@torch.compile
def bounded_flex_attention(q, k, v, score_mod, block_mask):
    return flex_attention(q, k, v, score_mod, block_mask,
                          kernel_options={"BLOCK_M":16,"BLOCK_N":32,"num_stages":1})


@contextlib.contextmanager
def capacity_kernel(policy):
    """Bound shared memory only inside batched forwards; retain native reference."""
    modules = [m for m in policy.modules() if hasattr(m,"flex_attention_inf")]
    if not modules:
        raise ValueError("CUDA collection requires native FlexAttention modules")
    original = [(m,"flex_attention_inf" in m.__dict__,m.flex_attention_inf) for m in modules]
    try:
        for module in modules:
            module.flex_attention_inf = bounded_flex_attention
        yield
    finally:
        for module,local,value in original:
            if local:module.flex_attention_inf = value
            else:del module.flex_attention_inf


def temperature_probabilities(distribution, logits, probabilities, temperatures):
    """Use Metamon's own temperature-before-clipping distribution, per group."""
    if any(not math.isfinite(t) or t<=0 for t in temperatures):
        raise ValueError("Temperatures must be positive and finite")
    original = distribution.temperature
    if original!=1.:
        raise ValueError("Shared actor must produce its reference logits at temperature 1")
    result = probabilities.clone()
    try:
        for temperature in sorted(set(temperatures)-{1.}):
            indices = [i for i,t in enumerate(temperatures) if t==temperature]
            distribution.temperature = temperature
            result[indices] = distribution(logits[indices]).probs
    finally:
        distribution.temperature = original
    return result


def pack_hidden(states):
    """Pack heterogeneous cache positions; never alias another client's storage."""
    result = copy.copy(states[0])
    for name in ("key_cache", "val_cache"):
        cache = copy.copy(getattr(states[0], name))
        cache.data = torch.cat([getattr(s, name).data for s in states], dim=1)
        setattr(result, name, cache)
    result.seq_lens = torch.cat([s.seq_lens for s in states])
    return result


def unpack_hidden(packed, states):
    for i, state in enumerate(states):
        state.key_cache.data.copy_(packed.key_cache.data[:, i:i+1])
        state.val_cache.data.copy_(packed.val_cache.data[:, i:i+1])
        state.seq_lens.copy_(packed.seq_lens[i:i+1])


class Batcher:
    def __init__(self, base, max_batch=32, wait_ms=2.):
        self.base, self.max_batch, self.wait = base, max_batch, wait_ms/1000
        self.queue = queue.Queue(maxsize=max_batch*2)
        self.stats = {"batches":0, "decisions":0, "maxBatch":0, "inferenceSeconds":0.}
        # AMAGO PolicyOutput is a callable ABC, not an nn.Module.
        distribution = base.policy.actor.policy_dist
        original = distribution.forward
        def capture_logits(vec, *args, **kwargs):
            self.logits = vec.detach()
            return original(vec,*args,**kwargs)
        distribution.forward = capture_logits
        self.thread = threading.Thread(target=self.run, name="shared-policy", daemon=True)
        self.thread.start()

    def submit(self, owner, inputs):
        future = Future()
        self.queue.put((owner, inputs, future), timeout=120)
        return future.result(timeout=120)

    def run(self):
        while True:
            jobs = [self.queue.get()]
            deadline = time.monotonic()+self.wait
            while len(jobs) < self.max_batch:
                try:
                    jobs.append(self.queue.get(timeout=max(0,deadline-time.monotonic())))
                except queue.Empty:
                    break
            try:
                self.forward(jobs)
            except BaseException as e:
                for _,_,future in jobs:
                    if not future.done():future.set_exception(e)

    def forward(self, jobs):
        # Torch's FX/Dynamo tracing state can be shared across model threads.
        # CPU is the eager reference; one CUDA device executes model calls in
        # order while independent game preparation and ready batching continue.
        cuda = self.base.experiment.DEVICE.type=="cuda"
        if not cuda or not getattr(self.base.experiment,'compiledFlex',True):torch.compiler.set_stance("force_eager")
        with CUDA_INFERENCE_LOCK if cuda else contextlib.nullcontext():
            return self._forward(jobs)

    def _forward(self, jobs):
        if len({id(owner) for owner,_,_ in jobs}) != len(jobs):
            raise ValueError("Concurrent requests from the same recurrent state")
        inputs = [x for _,x,_ in jobs]
        states = [x["hidden_state"] for x in inputs]
        hidden = pack_hidden(states)
        obs = {k:torch.cat([x["obs"][k] for x in inputs]) for k in inputs[0]["obs"]}
        rl2s = torch.cat([x["rl2s"] for x in inputs])
        times = torch.cat([x["time_idxs"] for x in inputs])
        if self.base.experiment.DEVICE.type == "cuda":
            torch.cuda.synchronize()
        start = time.monotonic()
        kernel = capacity_kernel(self.base.policy) if self.base.experiment.DEVICE.type=="cuda" and getattr(self.base.experiment,'compiledFlex',True) else contextlib.nullcontext()
        with torch.no_grad(), self.base.experiment.caster(), kernel:
            _, hidden = self.base.policy.get_actions(obs=obs, rl2s=rl2s, time_idxs=times,
                                                     hidden_state=hidden, sample=False)
            probabilities = self.base.last_dist.probs.detach()
            temperatures = [getattr(owner,"temperature",1.) for owner,_,_ in jobs]
            if any(t!=1. for t in temperatures):
                probabilities = temperature_probabilities(self.base.policy.actor.policy_dist,
                    self.logits,probabilities,temperatures)
        unpack_hidden(hidden, states)
        if self.base.experiment.DEVICE.type == "cuda":
            torch.cuda.synchronize()
        self.stats["inferenceSeconds"] += time.monotonic()-start
        self.stats["batches"] += 1
        self.stats["decisions"] += len(jobs)
        self.stats["maxBatch"] = max(self.stats["maxBatch"],len(jobs))
        for i,(owner,_,future) in enumerate(jobs):
            probs = probabilities[i:i+1].clone()
            owner.last_dist = SimpleNamespace(probs=probs)
            # Categorical.sample draws once for every gamma, then get_actions
            # selects the primary gamma. Preserve that number/order of draws.
            draws = torch.multinomial(probs.reshape(-1,probs.shape[-1]),1,
                                      generator=owner.generator)
            action = draws.reshape(*probs.shape[:-1],1)[...,-1,:]
            future.set_result((action,states[i]))


class MLXBatcher(Batcher):
    """Independent incremental MLX caches, with the same native CPU actor/RNG."""
    def configure(self, base, config, checkpoint_sha):
        from native_mlx_backbone import load, encode
        if base.experiment.DEVICE.type != "cpu":raise ValueError("Native CPU actor required")
        self.network = load(config, checkpoint_sha)
        def embedding(*, obs, rl2s, time_idxs, hidden_state=None):
            owner = self.current_owner
            if not hasattr(owner, "mlx_network"):
                owner.mlx_network = copy.copy(self.network)
                owner.mlx_network.reset()
                owner.mlx_step = 0
            if int(time_idxs.item()) != owner.mlx_step:raise ValueError("MLX stream position drift")
            result = encode(owner.mlx_network, owner.mlx_step, obs, rl2s)
            owner.mlx_step += 1
            return result, hidden_state
        base.policy.get_state_embedding = embedding

    def __init__(self, base, config, checkpoint_sha, max_batch=32):
        self.configure(base, config, checkpoint_sha)
        super().__init__(base, max_batch)

    def _forward(self, jobs):
        if len({id(owner) for owner,_,_ in jobs}) != len(jobs):
            raise ValueError("Concurrent requests from the same recurrent state")
        for job in jobs:
            self.current_owner = job[0]
            super()._forward([job])


def client_policy(worker, batcher, seed, temperature=1.):
    base = batcher.base
    policy = object.__new__(worker.KakunaPolicy)
    policy.model = copy.copy(base.model)
    policy.model.observation_space = copy.deepcopy(base.model.observation_space)
    policy.model.observation_space.reset()
    from metamon.rl.metamon_to_amago import make_placeholder_env
    policy.wrapper = make_placeholder_env(policy.model.observation_space,policy.model.action_space)
    policy.experiment = base.experiment
    policy.generator = torch.Generator(device=base.experiment.DEVICE).manual_seed(seed)
    if not math.isfinite(temperature) or temperature<=0:
        raise ValueError("Temperature must be positive and finite")
    policy.temperature = temperature
    policy.policy = SimpleNamespace(get_actions=lambda **kw:batcher.submit(policy,kw))
    policy.hidden = base.policy.traj_encoder.init_hidden_state(1,base.experiment.DEVICE)
    policy.previous_state = None
    policy.previous_action = np.zeros((1,policy.wrapper.action_size),dtype=policy.wrapper.action_dtype)
    policy.step, policy.pending, policy.seed = 0, None, seed

    def redraw(legal):
        probs = policy.last_dist.probs[0,-1,-1].float()
        keep = torch.zeros_like(probs)
        keep[legal] = 1.
        probs = probs*keep
        worker.require(bool(probs.sum()>0),"official_action")
        return int(torch.multinomial(probs/probs.sum(),1,generator=policy.generator).item())
    policy.redraw = redraw
    if hasattr(batcher,"members"):
        from ensemble_policy import install
        install(policy)
    return policy
