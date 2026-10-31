"""Compare critics against observed returns on completed progress-only POVs.

This is an off-policy prediction diagnostic, not counterfactual action evidence or
certification. Both models see the same native dataset observations and recorded
previous actions. Progress trajectories remain ineligible for training.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import time


class DiagnosticPause(RuntimeError):
    pass


def checkpoint_rows(paths, inputs, model_sha):
    rows, partial = {}, []
    for path in paths:
        lines = path.read_bytes().splitlines(keepends=True)
        if lines and not lines[-1].endswith(b'\n'):
            partial.append({'path': str(path), 'sha256': digest(path), 'trailingBytes': len(lines.pop())})
        for line in lines:
            row = json.loads(line)
            checksum = row.get('_rowSha256')
            payload = {key:value for key,value in row.items() if key != '_rowSha256'}
            if hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest() != checksum:
                raise ValueError('Diagnostic checkpoint checksum mismatch')
            index = row['_inputIndex']
            if type(index) is not int or index in rows or not 0 <= index < len(inputs):
                raise ValueError('Duplicate or out-of-range diagnostic checkpoint')
            if row['_modelSha256'] != model_sha or row['_inputSha256'] != inputs[index]['sha256']:
                raise ValueError('Diagnostic checkpoint provenance mismatch')
            rows[index] = row
    return rows, partial


def append_checkpoint(path, row):
    row['_rowSha256'] = hashlib.sha256(json.dumps(row,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    with path.open('a') as stream:
        stream.write(json.dumps(row)+'\n');stream.flush();os.fsync(stream.fileno())


def full_sequence_reference(backend, native, probabilities, predictions):
    """Compare streaming cache outputs with the native full-sequence Q path."""
    from types import MethodType, SimpleNamespace
    import numpy as np
    import torch
    import torch.nn.functional as F
    from amago.nets.transformer import SlidingWindowFlexAttention
    if len(native) > 127:
        raise ValueError('Reference qualification requires a complete <=127-transition POV')
    def dense(module, qkv, key_cache=None, val_cache=None, cache_seqlens=None):
        assert key_cache is None and val_cache is None
        q, k, v = qkv.unbind(2)
        index = torch.arange(q.shape[1], device=q.device)
        distance = index[:, None] - index[None, :]
        mask = ((distance >= 0) & (distance <= 96))[None, None]
        return F.scaled_dot_product_attention(q.transpose(1,2), k.transpose(1,2),
            v.transpose(1,2), attn_mask=mask, dropout_p=0.).transpose(1,2)
    changed = []
    try:
        for layer in backend.policy.traj_encoder.modules():
            if isinstance(layer, SlidingWindowFlexAttention):
                changed.append((layer, layer.forward))
                layer.forward = MethodType(dense, layer)
        assert changed
        batch = SimpleNamespace(obs={k:v.unsqueeze(0) for k,v in native.obs.items()},
            **{k:getattr(native,k).unsqueeze(0) for k in ['actions','rews','dones','rl2s','time_idxs']})
        with torch.no_grad(), torch.compiler.set_stance('force_eager'):
            values = backend.policy.get_values(batch)
        reference_p = backend.last_dist.probs[0,:-1,-1].float().cpu().numpy()
        reference_q = values['q_sa'][0,:,-1,0].float().cpu().numpy()
        return {'probabilityMaxAbs':float(np.abs(reference_p-np.asarray(probabilities)).max()),
                'criticMaxAbs':float(np.abs(reference_q-np.asarray(predictions)).max()),
                'states':len(native), 'nativeFullSequenceAndStreaming':True}
    finally:
        for layer, forward in changed:
            layer.forward = forward


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def compare_reports(reference,candidate,probability_tolerance=2e-5,critic_tolerance=.1):
    """Compare complete fixed-data predictions across CPU implementations."""
    import math
    assert reference['diagnosticManifestSha256']==candidate['diagnosticManifestSha256']
    assert set(reference['models'])==set(candidate['models'])
    for x,y in zip(reference['inputs'],candidate['inputs'],strict=True):
        assert (x['sha256'],x['metaSha256'])==(y['sha256'],y['metaSha256'])
    pmax=qmax=0.;states=0;top1=True
    for name,a in reference['models'].items():
        b=candidate['models'][name]
        for key in ['checkpointSha256','gamma','rewardMultiplier','povs','states']:assert a[key]==b[key],key
        assert a['povs']==len(a['rows'])==len(b['rows'])==len(reference['inputs'])
        for x,y in zip(a['rows'],b['rows'],strict=True):
            assert x['_inputIndex']==y['_inputIndex'] and x['states']==y['states']
            assert x['observedReturns']==y['observedReturns'] and x['won']==y['won']
            assert len(x['probabilities'])==len(y['probabilities'])==len(x['predicted'])==len(y['predicted'])==x['states']
            for p,q in zip(x['probabilities'],y['probabilities'],strict=True):
                for v,w in zip(p,q,strict=True):
                    assert math.isfinite(v) and math.isfinite(w)
                    pmax=max(pmax,abs(v-w))
                top1 &= max(range(len(p)),key=p.__getitem__)==max(range(len(q)),key=q.__getitem__)
            for v,w in zip(x['predicted'],y['predicted'],strict=True):
                assert math.isfinite(v) and math.isfinite(w)
                qmax=max(qmax,abs(v-w))
            states+=x['states']
    return {'pass':pmax<=probability_tolerance and qmax<=critic_tolerance and top1,
            'probabilityMaxAbs':pmax,'criticMaxAbs':qmax,'allArgmaxActionsEqual':top1,
            'observedReturnTargetsEqual':True,'states':states,'povs':len(reference['inputs'])}


def primary_value(q):
    if q.ndim != 6 or q.shape[:3] != (1,1,1) or q.shape[-1] != 1:
        raise ValueError("Expected one action sample, batch and timestep; all critics and gammas")
    return float(q[0,0,0,:,-1,0].mean())


def actor_scores(probabilities, actions, epsilon=1e-12):
    import numpy as np
    p, chosen = np.asarray(probabilities), np.asarray(actions)
    if p.ndim != 2 or chosen.shape != (len(p),) or not np.isfinite(p).all():
        raise ValueError("Finite per-state probabilities and one chosen index required")
    if not ((p >= 0).all() and (p <= 1).all() and np.allclose(p.sum(-1), 1., atol=1e-5)):
        raise ValueError("Normalized action probabilities required")
    if not (np.issubdtype(chosen.dtype, np.integer) and (chosen >= 0).all() and (chosen < p.shape[-1]).all()):
        raise ValueError("Chosen action index out of range")
    actual = p[np.arange(len(p)), chosen]
    return {"nll": float(-np.log(np.maximum(actual, epsilon)).mean()),
            "top1": float((p.argmax(-1) == chosen).mean()),
            "nllProbabilityFloor": epsilon, "probabilitiesBelowFloor": int((actual < epsilon).sum())}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", type=Path)
    p.add_argument("--source", type=Path)
    p.add_argument("--out", type=Path)
    p.add_argument("--job", type=Path, help="Frozen fresh-battle diagnostic job; no progress data required")
    p.add_argument("--povs", type=int, default=8)
    p.add_argument("--min-available-gib", type=float, default=24.)
    a = p.parse_args()
    if a.povs < 1:
        raise ValueError("Positive POV count required")
    if a.job:
        job = json.loads(a.job.read_bytes())
        assert digest(__file__) == job['programSha256']
        a.out, a.source = Path(job['out']), Path(job['source'])
        a.min_available_gib = job['minimumAvailableGiB']
        manifest_path = Path(job['diagnosticManifest'])
        assert digest(manifest_path) == job['diagnosticManifestSha256']
        declaration = json.loads(manifest_path.read_bytes())
        assert declaration['complete'] and declaration['neverInG2'] and declaration['reservedFromFutureTraining']
        inputs = []
        for item in declaration['inputs']:
            path = manifest_path.parent / 'data' / Path(item['path']).name
            assert digest(path) == item['sha256'] and digest(str(path)+'.meta') == item['metaSha256']
            meta = json.loads(Path(str(path)+'.meta').read_bytes())
            assert meta['purpose']=='selfplay' and meta['finished'] and not meta['hit_time_limit']
            assert meta['invalid_actions']==meta['parse_errors']==0
            inputs.append({**item,'path':str(path),'won':meta['won']})
        runtime = Path(job['runtime']) / 'scripts'
        policies_path, baseline_path = Path(job['policies']), job['base']
        job_hash = digest(a.job)
    else:
        if not (a.run and a.source and a.out):
            raise ValueError("Progress run/source/out or explicit diagnostic job required")
        job = json.loads((a.run / "job.json").read_text())
        progress = json.loads((a.run / "progress.json").read_text())
        if job["purpose"] != "progress" or not progress["complete"]:
            raise ValueError("Complete progress-only run required")
        files = sorted((a.run / "server/progress-replays").glob(f"*/{job['focal']}/metamon/gen9uu/*.json.lz4"))
        if len(files) < a.povs:
            raise ValueError("Insufficient completed focal-policy POVs")
        files = files[:a.povs]
        focal = next(m for m in job["policies"] if m["name"] == job["focal"])
        inputs = []
        for path in files:
            meta_path = Path(str(path) + ".meta")
            meta = json.loads(meta_path.read_text())
            if not (meta["purpose"] == "progress" and meta["training_eligible"] is False
                    and meta["finished"] and not meta["hit_time_limit"] and not meta["parse_errors"]
                    and meta["checkpoint_sha256"] == focal["sha256"] and meta["policy_id"] == focal["policyId"]
                    and not meta["invalid_actions"] and type(meta["won"]) is bool):
                raise ValueError("Incomplete or non-progress POV")
            inputs.append({"path":str(path.resolve()), "sha256":digest(path),
                           "metaSha256":digest(meta_path), "won":meta["won"]})
        runtime = a.run / "runtime/scripts"
        policies_path = a.run / 'policies.json'
        baseline_path = next(m['path'] for m in job['policies'] if m['name']=='G0')
        job_hash = digest(a.run / 'job.json')
    if a.job and job.get('qualificationPOVs'):
        inputs = inputs[:job['qualificationPOVs']]
    resume = bool(a.job and job.get('resume'))
    if a.out.exists() and resume and not (a.out/'binding.json').exists():
        raise ValueError('Refusing to adopt an output without a resume binding')
    a.out.mkdir(parents=True, exist_ok=resume)
    binding = {'jobSha256':job_hash,'producerSha256':digest(__file__),
               'inputs':[{'sha256':row['sha256'],'metaSha256':row['metaSha256']} for row in inputs]}
    binding_path = a.out / 'binding.json'
    if binding_path.exists():
        if json.loads(binding_path.read_bytes()) != binding:
            raise ValueError('Diagnostic resume binding changed')
    else:
        binding_path.write_text(json.dumps(binding,indent=2)+'\n')
        (a.out / "inputs.json").write_text(json.dumps(inputs, indent=2))
        (a.out / "producer.py").write_bytes(Path(__file__).read_bytes())
    import psutil
    started = time.monotonic()
    resources = {'minimumAvailableGiB':float('inf'),'peakRssGiB':0.,'minimumFreePercent':100}
    memory_check = [0., None]
    def guard_memory():
        if a.job and time.time() >= job.get('stopByEpoch',float('inf')):
            (a.out/'pause.json').write_text(json.dumps({'phase':'DEFERRED_AUTHORIZED_WINDOW',
                'completedPOVsDurable':True})+'\n')
            raise DiagnosticPause('Declared scoring window ended; completed POV journals retained')
        available = psutil.virtual_memory().available / 2**30
        resources['minimumAvailableGiB'] = min(resources['minimumAvailableGiB'], available)
        resources['peakRssGiB'] = max(resources['peakRssGiB'], psutil.Process().memory_info().rss/2**30)
        safe = available >= a.min_available_gib
        if a.job and job.get('memoryGuard') and time.monotonic()-memory_check[0] >= 2:
            assert sys.platform == 'darwin'
            import re
            free = int(re.search(r'memory free percentage: (\d+)%',
                subprocess.check_output(['memory_pressure','-Q'],text=True)).group(1))
            pressure = int(subprocess.check_output(['sysctl','-n','kern.memorystatus_vm_pressure_level'],text=True))
            memory_check[:] = [time.monotonic(), (free, pressure)]
            resources['minimumFreePercent'] = min(resources['minimumFreePercent'],free)
        if a.job and job.get('memoryGuard') and memory_check[1]:
            free, pressure = memory_check[1]
            safe = safe and free >= job['memoryGuard']['minimumFreePercent'] and pressure == 1
        if not safe:
            (a.out/'pause.json').write_text(json.dumps({'phase':'WAIT_MEMORY','availableGiB':available,
                'minimumAvailableGiB':a.min_available_gib,'completedPOVsDurable':True})+'\n')
            raise DiagnosticPause('Diagnostic reserve; completed POV journals retained for resume')
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    # Reuse this progress run's frozen observation/model implementation.
    sys.path.insert(0, str(runtime / "uu_selfplay"))
    sys.path.insert(0, str(runtime / "metamon_port"))
    import common
    common.OUT = a.out / "work"
    common.setup("torch-cpu")
    from candidate_worker import policy_members
    from torch_backend import TorchBackend
    import numpy as np
    import psutil
    import torch
    from metamon.data.parsed_replay_dset import MetamonDataset
    from metamon.rl.metamon_to_amago import MetamonAMAGODataset
    if a.job:
        for module_name, expected in job['loaderHashes'].items():
            module = __import__(module_name, fromlist=['_'])
            path = Path(module.__file__).resolve()
            assert path.is_relative_to(a.source.resolve()) and digest(path) == expected
    members = policy_members(policies_path, baseline_path)
    if not a.job and {m["name"] for m in members} != {"G0", job["focal"]}:
        raise ValueError("One candidate and G0 required")
    (a.out / "empty-dataset").mkdir(exist_ok=resume)
    report = {"diagnosticOnly":True, "certification":False, "trainingEligible":False,
              "limitation":"Observed chosen-action returns under the focal policy; no counterfactual truth.",
              "jobSha256":job_hash, "inputs":inputs, "models":{}}
    if a.job:
        report.update(diagnosticManifestSha256=job['diagnosticManifestSha256'], fixedCheckpoint=job['checkpoint'],
                      limitation='Observed behavior-action NLL/top1 and discounted shaped-return error on reserved fresh battles; neither imitation accuracy nor off-policy value error establishes playing strength.')
        report['qualificationOnly'] = bool(job.get('qualificationPOVs'))
    probabilities = {}
    cpu_threads = job.get('cpuThreads',1) if a.job else 1
    if type(cpu_threads) is not int or not 1 <= cpu_threads <= 4:
        raise ValueError('CPU diagnostic threads must be an integer from1through4')
    report['cpuThreads'] = cpu_threads
    for member in members:
        guard_memory()
        journals = sorted(a.out.glob(member['name']+'-povs-*.jsonl'))
        completed, partial = checkpoint_rows(journals, inputs, member['sha256'])
        report.setdefault('retainedPartialJournals',[]).extend(partial)
        journal = a.out / (member['name']+f'-povs-{len(journals):03d}.jsonl')
        journal.touch(exist_ok=False)
        backend = TorchBackend("torch-cpu", member["path"], a.source, 0)
        torch.set_num_threads(cpu_threads)
        pol = backend.policy
        capture, original = [], pol.actor.forward
        def actor(state, *args, **kwargs):
            capture[:] = [state.detach()]
            return original(state, *args, **kwargs)
        pol.actor.forward = actor
        dataset = MetamonDataset(str(a.out / "empty-dataset"), backend.model.observation_space,
            backend.model.action_space, backend.model.reward_function, formats=[], max_seq_len=None)
        processor = MetamonAMAGODataset(dataset)
        gamma, multiplier = float(pol.gammas[-1]), float(pol.reward_multiplier)
        rows, probs = [], []
        for index, item in enumerate(inputs):
            if index in completed:
                rows.append(completed[index])
                probs.extend(completed[index]['probabilities'])
                continue
            path = Path(item["path"])
            if digest(path) != item["sha256"]:
                raise ValueError("Replay changed before diagnostic")
            native = processor._process_data(dataset.load_filename(str(path)))
            if not bool(native.dones[-1]) or int(native.dones.sum()) != 1:
                raise ValueError("Exactly one terminal transition required")
            rewards = native.rews[:, 0].numpy().astype(np.float64) * multiplier
            returns = np.empty_like(rewards)
            value = 0.
            for t in reversed(range(len(rewards))):
                value = rewards[t] + gamma * value
                returns[t] = value
            backend.reset()
            predictions, pov_probs = [], []
            for t in range(len(native)):
                guard_memory()
                with torch.compiler.set_stance("force_eager"):
                    probability = backend.step({k:v[t:t+1].numpy() for k,v in native.obs.items()},
                        native.rl2s[t:t+1].numpy(), native.time_idxs[t:t+1].numpy())
                    action = native.actions[t].reshape(1,1,1,1,-1).expand(1,1,1,len(pol.gammas),-1)
                    action = pol.actor.policy_dist.action_from_buffer(action.clone())
                    with torch.no_grad():
                        q = pol.critics.bin_dist_to_raw_vals(pol.critics(capture[-1], action))
                    predictions.append(primary_value(q))
                    probs.append(probability.tolist())
                    pov_probs.append(probability.tolist())
            predicted = np.array(predictions)
            if not np.isfinite(predicted).all() or not np.isfinite(returns).all():
                raise FloatingPointError("Nonfinite critic prediction or return")
            row = {"path":item["path"], "states":len(native), "won":item["won"],
                "mse":float(np.square(predicted-returns).mean()),
                "mae":float(np.abs(predicted-returns).mean()), "bias":float((predicted-returns).mean()),
                "predicted":predictions, "observedReturns":returns.tolist(),
                'probabilities':pov_probs, '_inputIndex':index, '_inputSha256':item['sha256'],
                '_modelSha256':member['sha256'],
                **actor_scores(pov_probs,native.actions.argmax(-1).cpu().numpy().reshape(-1))}
            if a.job and index in job.get('nativeReferenceIndices',[]):
                parity = full_sequence_reference(backend,native,pov_probs,predictions)
                assert parity['probabilityMaxAbs'] <= job['nativeReferenceTolerances']['probabilityMaxAbs'],parity
                assert parity['criticMaxAbs'] <= job['nativeReferenceTolerances']['criticMaxAbs'],parity
                row['nativeReferenceParity'] = parity
            append_checkpoint(journal,row)
            rows.append(row)
            (a.out/'progress.tmp').write_text(json.dumps({'model':member['name'],'completedPOVs':len(rows),
                'plannedPOVs':len(inputs),'completedStates':sum(row['states'] for row in rows)})+'\n')
            (a.out/'progress.tmp').replace(a.out/'progress.json')
        report["models"][member["name"]] = {"checkpointSha256":member["sha256"],
            "gamma":gamma, "rewardMultiplier":multiplier, "povs":len(rows),
            "states":sum(row["states"] for row in rows),
            "meanPovMSE":float(np.mean([r["mse"] for r in rows])),
            "meanPovMAE":float(np.mean([r["mae"] for r in rows])),
            "meanPovBias":float(np.mean([r["bias"] for r in rows])),
            "meanPovNLL":float(np.mean([r['nll'] for r in rows])),
            "meanPovTop1":float(np.mean([r['top1'] for r in rows])), "rows":rows}
        if not a.job and member["name"] != "G0" and "G0" in report["models"]:
            reference = report["models"]["G0"]
            if reference["gamma"] != gamma or reference["rewardMultiplier"] != multiplier or any(
                    x["observedReturns"] != y["observedReturns"] for x,y in zip(reference["rows"],rows)):
                raise ValueError("Critic comparison changed target-return semantics")
        probabilities[member["name"]] = np.array(probs)
        pol.actor.forward = original
        del capture, original, pol, processor, dataset
        backend.close()
    if not a.job:
        baseline, candidate = probabilities["G0"], probabilities[job["focal"]]
        report["nativeDatasetTopActionAgreement"] = float(np.mean(baseline.argmax(-1) == candidate.argmax(-1)))
        report["meanProbabilityL1"] = float(np.abs(baseline-candidate).sum(-1).mean())
    for item in inputs:
        if digest(item["path"]) != item["sha256"] or digest(item["path"]+".meta") != item["metaSha256"]:
            raise ValueError("Replay or metadata changed during diagnostic")
    report['thisAttemptResources'] = {**resources,'elapsedSeconds':time.monotonic()-started}
    (a.out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"diagnosticOnly":True, "models":{name:{k:v for k,v in row.items() if k!="rows"}
        for name,row in report["models"].items()},
        **{key:report[key] for key in ['nativeDatasetTopActionAgreement','meanProbabilityL1'] if key in report}}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except DiagnosticPause as error:
        print(json.dumps({'phase':'WAIT_MEMORY','reason':str(error)}),flush=True)
        raise SystemExit(75)
