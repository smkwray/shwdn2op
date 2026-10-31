"""Offline behaviour-cloning screen: held-out action NLL and top-1 accuracy of a UU model on frozen trajectory dirs.

  heldout_nll.py score MODEL CHECKPOINT OUT.json DATA_DIR [DATA_DIR ...] [--batch N] [--limit N] [--probs PROBS.jsonl]
  heldout_nll.py compare BASE.json ARM.json [ARM.json ...]      (paired, battle-clustered differences vs BASE)

Environment as for a self-play worker (env.json / env.sh), with sliding-window FLEX attention gins (UU_BASE_GIN, and
UU_FT_CKPT_DIR / UU_FT_RUN / UU_FT_GIN for UUFinetuned); AMAGO_FLEX_TRAIN_EAGER=1 or TORCHDYNAMO_DISABLE=1 keeps the
flex call eager (flex_probe.py). MODEL is UUKakuna (CHECKPOINT 34) or UUFinetuned (CHECKPOINT = epoch), built and loaded
by Metamon's registry (initialize_agent: strict load, on_checkpoint_loaded, i.e. the promoted weights the eval harness
plays). Each DATA_DIR holds gen9uu/*.json.lz4. Trajectories go through Metamon's MetamonDataset at full length and
MetamonAMAGODataset._process_data, then amago's RLData_pad_collate, get_state_embedding and actor: teacher-forced over
the whole game with window-96 attention, as inference sees it (policy in eval mode; only the flex modules in train
mode, which amago's full-sequence path requires and which has no dropout). The distribution is the actor's masked one at
temperature 1, last (test-time) gamma head, as get_actions uses. Scored: real decisions whose action is known; a known
action the mask calls illegal is counted (illegal_chosen), not scored. Per-file sums are written so arms pair exactly.
--probs also writes, per file, every decision's legal-renormalised action distribution and the recorded action id
(-1 unknown), indexed like the trajectory's states (curriculum.py screen reads it).
BC loss on held-out games is not playing strength; it is a screen only.
"""
import argparse, hashlib, json, math, os, pathlib, platform, re, sys, time


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cluster(name):  # one battle: block prefix (frozen piles) + the replay/battle number
    m = re.search(r"gen9uu-(\d+)", name)
    if not m:
        raise SystemExit(f"no battle id in {name}")
    return (name.split("--")[0] + ":" if "--" in name else "") + m.group(1)


def parts(path):  # results may come from a Windows host
    return (pathlib.PureWindowsPath(path) if "\\" in path else pathlib.PurePosixPath(path)).parts


def label(d):  # a frozen pile dir ends STRATUM/UUKakuna/metamon; a human split dir is its own name
    p = parts(d)
    return p[-3] if p[-2:] == ("UUKakuna", "metamon") else p[-1]


def score(a):
    import torch
    from amago.loading import RLData_pad_collate
    from amago.nets.transformer import FlexAttention
    from metamon.data.parsed_replay_dset import MetamonDataset
    from metamon.rl.metamon_to_amago import MetamonAMAGODataset
    from metamon.rl.pretrained import get_pretrained_model

    torch.manual_seed(0)
    maker = get_pretrained_model(a.model)
    ckpt = pathlib.Path(maker.get_path_to_checkpoint(a.checkpoint))
    exp = maker.initialize_agent(checkpoint=a.checkpoint, log=False, action_temperature=1.0)
    agent = exp.policy.to("cuda").eval()
    if getattr(agent, "use_tortoise_for_inference", False):
        raise SystemExit("expected the promoted main-policy inference path")
    attn = sorted({type(m).__name__ for m in agent.traj_encoder.modules() if "Attention" in type(m).__name__})
    flex = [m for m in agent.modules() if isinstance(m, FlexAttention)]
    if not flex:
        raise SystemExit(f"traj encoder must use flex attention for full-sequence scoring, found {attn}")
    for m in flex:  # amago's full-sequence (training) flex path asserts .training; flex has no attention dropout
        m.train()
    keys = list(agent.pass_obs_keys_to_actor)
    out = {"model": a.model, "checkpoint": a.checkpoint, "checkpoint_path": str(ckpt), "checkpoint_sha256": sha256(ckpt),
           "attention": attn, "producer_sha256": sha256(__file__), "torch": torch.__version__,
           "gpu": torch.cuda.get_device_name(0), "host_os": platform.system(), "batch": a.batch, "data": {}}
    for d in a.data:
        ds = MetamonDataset(dset_root=d, observation_space=maker.observation_space, action_space=maker.action_space,
                            reward_function=maker.reward_function, formats=["gen9uu"], max_seq_len=None)
        wrap = MetamonAMAGODataset(parsed_replay_dset=ds, dset_name=pathlib.Path(d).name)
        names = list(ds.filenames)[: a.limit or None]
        dump = open(a.probs, "a") if a.probs else None
        rows, t0 = [], time.time()
        for i in range(0, len(names), a.batch):
            chunk = names[i:i + a.batch]
            samples = [wrap._process_data(ds.load_filename(f)) for f in chunk]
            batch = RLData_pad_collate(samples)
            batch.to("cuda")
            with torch.no_grad():
                s_rep, _ = agent.get_state_embedding(obs=batch.obs, rl2s=batch.rl2s, time_idxs=batch.time_idxs)
                dist = agent.actor(s_rep, straight_from_obs={k: batch.obs[k] for k in keys})
                logp = torch.log_softmax(dist.logits[..., -1, :].float(), -1)[:, :-1]  # (B, L-1, A): drop the terminal obs
            chosen = batch.actions.argmax(-1)
            illegal = batch.obs["illegal_actions"][:, :-1].bool()
            missing = batch.obs["missing_action_mask"][:, :-1, 0].bool()
            for j, (f, s) in enumerate(zip(chunk, samples)):
                n = len(s.actions)
                known = ~missing[j, :n]
                bad = known & illegal[j, :n].gather(-1, chosen[j, :n, None])[..., 0]
                ok = known & ~bad
                lp = logp[j, :n].gather(-1, chosen[j, :n, None])[..., 0]
                top = logp[j, :n].argmax(-1) == chosen[j, :n]
                if dump:
                    q = logp[j, :n].exp().masked_fill(illegal[j, :n], 0.0).double()
                    q = q / q.sum(-1, keepdim=True)
                    rec = torch.where(known, chosen[j, :n], torch.full_like(chosen[j, :n], -1))
                    dump.write(json.dumps({"file": pathlib.Path(f).name, "chosen": rec.tolist(),
                                           "probs": [[round(x, 6) for x in r] for r in q.tolist()]}) + "\n")
                rows.append({"file": pathlib.Path(f).name, "decisions": n, "scored": int(ok.sum()),
                             "missing": int((~known).sum()), "illegal_chosen": int(bad.sum()),
                             "nll_sum": float(-lp[ok].double().sum()), "correct": int((top & ok).sum())})
        if dump:
            dump.close()
        scored = sum(r["scored"] for r in rows)
        if not rows or not scored:
            raise SystemExit(f"{d}: nothing scored ({len(rows)} files)")
        if any(not math.isfinite(r["nll_sum"]) for r in rows):
            raise SystemExit(f"{d}: non-finite NLL")
        out["data"][str(d)] = {"files": len(rows), "decisions": sum(r["decisions"] for r in rows), "scored": scored,
                               "missing": sum(r["missing"] for r in rows),
                               "illegal_chosen": sum(r["illegal_chosen"] for r in rows),
                               "nll": sum(r["nll_sum"] for r in rows) / scored,
                               "top1": sum(r["correct"] for r in rows) / scored, "seconds": round(time.time() - t0, 1),
                               "rows": rows}
        print(json.dumps({k: v for k, v in out["data"][str(d)].items() if k != "rows"} | {"dir": str(d)}), flush=True)
    out["peak_vram_gb"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
    pathlib.Path(a.out).write_text(json.dumps(out) + "\n")


def compare(a):
    base = json.loads(pathlib.Path(a.base).read_text())
    for arm_path in a.arms:
        arm = json.loads(pathlib.Path(arm_path).read_text())
        for d, b in base["data"].items():
            if d not in arm["data"]:
                raise SystemExit(f"{arm_path} lacks {d}")
            br = {r["file"]: r for r in b["rows"]}
            ar = {r["file"]: r for r in arm["data"][d]["rows"]}
            if br.keys() != ar.keys() or any(br[f]["scored"] != ar[f]["scored"] for f in br):
                raise SystemExit(f"{arm_path}: files or scored decisions differ from base on {d}")
            n = sum(r["scored"] for r in br.values())
            per = {}  # battle -> [nll diff sum, correct diff sum, scored decisions]
            for f in br:
                c = per.setdefault(cluster(f), [0.0, 0.0, 0])
                c[0] += ar[f]["nll_sum"] - br[f]["nll_sum"]
                c[1] += ar[f]["correct"] - br[f]["correct"]
                c[2] += br[f]["scored"]
            k = len(per)
            mean_nll, mean_top = sum(v[0] for v in per.values()) / n, sum(v[1] for v in per.values()) / n
            # Per-decision mean difference with a battle-clustered standard error (ratio estimator, k/(k-1) correction).
            se = lambda i, m: (math.sqrt(k / (k - 1) * sum((v[i] - v[2] * m) ** 2 for v in per.values())) / n
                               if k > 1 else float("nan"))  # one battle: no clustered error
            row = {"arm": arm["model"] + ":" + parts(arm["checkpoint_path"])[-4], "data": label(d),
                   "battles": k, "scored": n, "base_nll": b["nll"], "arm_nll": arm["data"][d]["nll"],
                   "d_nll": mean_nll, "d_nll_se": se(0, mean_nll), "base_top1": b["top1"], "arm_top1": arm["data"][d]["top1"],
                   "d_top1": mean_top, "d_top1_se": se(1, mean_top)}
            print(json.dumps(row))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score")
    s.add_argument("model"); s.add_argument("checkpoint", type=int); s.add_argument("out")
    s.add_argument("data", nargs="+"); s.add_argument("--batch", type=int, default=8); s.add_argument("--limit", type=int, default=0)
    s.add_argument("--probs", default="")
    c = sub.add_parser("compare")
    c.add_argument("base"); c.add_argument("arms", nargs="+")
    a = p.parse_args()
    if a.cmd == "score":
        for path in filter(None, (a.out, a.probs)):
            if pathlib.Path(path).exists():
                raise SystemExit(f"refusing to overwrite {path}")
        score(a)
    else:
        compare(a)


if __name__ == "__main__":
    main()
