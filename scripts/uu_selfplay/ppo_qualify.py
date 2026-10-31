"""Bounded real-model eager-SDPA GPU qualification on retained CPU rollouts."""
import argparse
import gc
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import torch
from ppo import conditional,native_forward,objective,sha,windows
from ppo_train import Rollouts,trainer_sources


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--job',type=Path,required=True)
    args=parser.parse_args();job=json.loads(args.job.read_bytes())
    if job['schema']!='uu-ppo-gpu-qualification@1':raise ValueError('Frozen GPU qualification job required')
    for name,digest in job['hashes'].items():
        if sha(name)!=digest:raise ValueError('Qualification input drift: '+name)
    cpu_proof=json.loads(Path(job['cpuQualification']).read_bytes())
    if cpu_proof['pass'] is not True or cpu_proof['nativeResumeExportIdentical'] is not True:
        raise ValueError('Completed native CPU qualification required')
    out=Path(job['out']);out.mkdir(parents=True,exist_ok=False)
    (out/'job.json').write_bytes(args.job.read_bytes())
    report=dict(pass_=False,phase='GPU_FORWARD_PARITY',backend='torch-cuda-sdpa',qualificationOnly=True,
        trainingEligible=False,newGames=0,trainerSources=trainer_sources(),commands=[],
        checkpointSha256=sha(job['checkpoint']),jobSha256=sha(args.job),resourceGuard=job['resourceGuard'])
    def save():
        report['updatedUnix']=time.time();(out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    save();sys.path.insert(0,str(Path(__file__).parents[1]/'metamon_port'))
    import common
    common.OUT=out/'reference-work'
    from torch_backend import TorchBackend
    cpu=gpu=None
    try:
        if not torch.cuda.is_available():raise RuntimeError('Native CUDA GPU required')
        if torch.__version__!=job['torchVersion']:raise RuntimeError('Torch runtime drift')
        torch.set_num_threads(1);torch.compiler.set_stance('force_eager')
        torch.cuda.reset_peak_memory_stats()
        cpu=TorchBackend('torch-cpu',Path(job['checkpoint']),Path(job['source']),job['seed'])
        gpu=TorchBackend('torch-cuda-sdpa',Path(job['checkpoint']),Path(job['source']),job['seed'])
        torch.set_num_threads(1)
        rollouts=Rollouts(job['manifest'],cpu.model,cpu.device,sha(job['checkpoint']))
        export_epoch=rollouts.manifest['version']+1
        maxima=dict(probability=0.,features=0.,split=0.,cached=0.)
        def compare(label,left,right,atol):
            left,right=left.detach().cpu(),right.detach().cpu()
            maxima[label]=max(maxima[label],float((left-right).abs().max()))
            if not torch.allclose(left,right,atol=atol,rtol=3e-4):raise AssertionError(label+' parity: '+str(maxima[label]))
        episodes=[rollouts.load(row) for row in rollouts.rows]
        def on_device(inputs):
            return dict(obs={k:v.cuda() for k,v in inputs['obs'].items()},rl2s=inputs['rl2s'].cuda(),time_idxs=inputs['time_idxs'].cuda())
        with torch.no_grad():
            for episode in episodes:
                inputs=episode['inputs'];length=inputs['rl2s'].shape[1];device_inputs=on_device(inputs)
                cp,cf=native_forward(cpu.policy,inputs,0,length);gp,gf=native_forward(gpu.policy,device_inputs,0,length)
                compare('probability',cp,gp,3e-5);compare('features',cf,gf,3e-4)
                for _,start,end in windows(length,32):
                    p,f=native_forward(gpu.policy,device_inputs,start,end)
                    compare('split',gp[start:end],p,3e-5);compare('features',gf[start:end],f,3e-4)
            # A qualification-only tensor stream crosses cache rollover even
            # when the four retained games are short. It creates no new game.
            original=episodes[0]['inputs'];indices=torch.arange(150)%original['rl2s'].shape[1]
            stream=dict(obs={k:v[:,indices] for k,v in original['obs'].items()},rl2s=original['rl2s'][:,indices],
                        time_idxs=torch.arange(150).reshape(1,150,1))
            cp,cf=native_forward(cpu.policy,stream,0,150);gp,gf=native_forward(gpu.policy,on_device(stream),0,150)
            compare('probability',cp,gp,3e-5);compare('features',cf,gf,3e-4)
            hidden=cpu.policy.traj_encoder.init_hidden_state(1,cpu.device);cached=[]
            for i in range(150):
                _,hidden=cpu.policy.get_actions(obs={k:v[:,i:i+1] for k,v in stream['obs'].items()},
                    rl2s=stream['rl2s'][:,i:i+1],time_idxs=stream['time_idxs'][:,i:i+1],hidden_state=hidden,sample=False)
                cached.append(cpu.last_dist.probs[0,-1,-1])
            compare('cached',cp,torch.stack(cached),3e-5)
        # Compare a real-model actor gradient after burn-in, independently of
        # the deliberately tiny qualification learning rate.
        gradient_inputs={**stream,'rl2s':stream['rl2s'].detach().clone().requires_grad_()}
        device_inputs=on_device(stream);device_inputs['rl2s']=device_inputs['rl2s'].detach().clone().requires_grad_()
        legal=torch.tensor([episodes[0]['records'][int(i)]['legal'] for i in indices[128:]],dtype=torch.bool)
        p,_=native_forward(cpu.policy,gradient_inputs,128,150);p=conditional(p,legal)
        old=p.detach();actions=old.argmax(-1);advantages=torch.linspace(-1,1,len(p))
        objective(p,old,old,actions,advantages)[0].backward()
        q,_=native_forward(gpu.policy,device_inputs,128,150);q=conditional(q,legal.cuda())
        objective(q,old.cuda(),old.cuda(),actions.cuda(),advantages.cuda())[0].backward()
        norm,difference=0.,0.
        parameters=dict(gpu.policy.named_parameters())
        for name,parameter in cpu.policy.named_parameters():
            other=parameters[name].grad
            if (parameter.grad is None)!=(other is None):raise AssertionError('Gradient presence: '+name)
            if parameter.grad is None:continue
            a,b=parameter.grad,other.detach().cpu()
            if not torch.allclose(a,b,atol=3e-4,rtol=3e-3):raise AssertionError('CPU/GPU gradient: '+name)
            norm+=float(a.double().square().sum());difference+=float((a.double()-b.double()).square().sum())
        relative=(difference/max(norm,1e-30))**.5
        if relative>1e-3:raise AssertionError('Gradient relative L2: '+str(relative))
        for inputs in [gradient_inputs,device_inputs]:
            grad=inputs['rl2s'].grad
            if grad is None or torch.count_nonzero(grad[:,:128]) or not torch.count_nonzero(grad[:,128:]):
                raise AssertionError('Native burn-in input gradient')
        cpu.policy.zero_grad(set_to_none=True);gpu.policy.zero_grad(set_to_none=True)
        report.update(pass_=True,cpuProbabilityParity=True,nativeFullSplitParity=True,cacheRolloverSteps=150,
            cpuGradientParity=True,gradientRelativeL2=relative,burnInZeroPrefixGradient=True,
            realPOVs=len(episodes),maxErrors=maxima,gpuPreflightPeakBytes=torch.cuda.max_memory_allocated(),
            torch=torch.__version__,device=torch.cuda.get_device_name(),float32Precision=torch.get_float32_matmul_precision())
        report['pass']=report.pop('pass_');forward=out/'forward.json';forward.write_text(json.dumps(report,indent=2)+'\n')
        cpu.close();gpu.close();cpu=gpu=None
        del episodes,rollouts,cp,cf,gp,gf,hidden,cached,parameters,gradient_inputs,device_inputs,p,q,old,actions,advantages,inputs,grad,parameter,other,a,b,_
        gc.collect();torch.cuda.empty_cache()
        report.update(pass_=False,phase='NATIVE_TRAINER');report['pass']=report.pop('pass_');save()
        base=json.loads(Path(job['trainTemplate']).read_bytes());base.update(source=job['source'],manifest=job['manifest'],checkpoint=job['checkpoint'],anchor=job['anchor'])
        def train(label,config):
            path=out/(label+'-job.json');path.write_text(json.dumps(config,indent=2)+'\n')
            env={**os.environ,**({'CUDA_VISIBLE_DEVICES':''} if config['backend']=='torch-cpu' else {})}
            begin=time.monotonic()
            with (out/(label+'.log')).open('x') as log:
                result=subprocess.run([sys.executable,str(Path(__file__).with_name('ppo_train.py')),'--job',str(path)],env=env,stdout=log,stderr=subprocess.STDOUT)
            report['commands'].append(dict(label=label,returncode=result.returncode,seconds=time.monotonic()-begin));save()
            if result.returncode:raise RuntimeError(label+' failed; retained')
        cpu_job={**base,'out':str(out/'cpu-train'),'backend':'torch-cpu'};train('cpu-native',cpu_job)
        gpu_job={**base,'out':str(out/'gpu-train'),'backend':'torch-cuda-sdpa',
            'bindings':{**base['bindings'],'gpuForwardQualification':dict(path=str(forward),sha256=sha(forward))}}
        train('gpu-native',gpu_job)
        relative=f'ckpts/policy_weights/policy_epoch_{export_epoch}.pt';weights=out/'gpu-train'/relative;before=sha(weights)
        receipt=json.loads(Path(str(weights)+'.receipt.json').read_bytes())
        cpu_receipt=json.loads(Path(str(out/'cpu-train'/relative)+'.receipt.json').read_bytes())
        if receipt['actorSteps']!=cpu_receipt['actorSteps'] or receipt['actorSteps']<1:raise AssertionError('Native actor update count')
        a=torch.load(out/'cpu-train'/relative,map_location='cpu',weights_only=True,mmap=True)
        b=torch.load(weights,map_location='cpu',weights_only=True,mmap=True)
        for name,value in a.items():
            if not torch.allclose(value,b[name],atol=3e-5,rtol=3e-4):raise AssertionError('CPU/GPU trained weight: '+name)
        gpu_job['resume']=str(out/'gpu-train/resume.pt');train('gpu-resume',gpu_job)
        if sha(weights)!=before:raise AssertionError('GPU resume export changed')
        for name,digest in job['hashes'].items():
            if sha(name)!=digest:raise ValueError('Qualification input changed during execution: '+name)
        report.update(pass_=True,phase='QUALIFIED_GPU_NATIVE_PPO',gpuResumeExportIdentical=True,
            trainedWeightsCpuGpuParity=True,actorSteps=receipt['actorSteps'],gpuTrainPeakBytes=receipt['gpuPeakAllocatedBytes'],
            canonicalExportSha256=before,trainingEligible=False)
        report['pass']=report.pop('pass_')
    except BaseException as error:
        report.update(phase='FAILED_RETAINED',pass_=False,error=repr(error));report['pass']=report.pop('pass_');raise
    finally:
        if cpu is not None:cpu.close()
        if gpu is not None:gpu.close()
        save()


if __name__=='__main__':main()
