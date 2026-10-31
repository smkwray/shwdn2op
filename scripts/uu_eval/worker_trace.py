# R60 passive recurrence/forward observer, extended to the candidate gate.
import hashlib, importlib.util, json, os, pathlib, sys
os.umask(0o077)
path=pathlib.Path(sys.argv.pop(1))
sys.path.insert(0,str(path.parent))
spec=importlib.util.spec_from_file_location('qualified_worker',path)
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
w=entry.worker_module() if path.name=='candidate_worker.py' else entry
if path.name=='candidate_worker.py':entry.worker_module=lambda:w
pid=os.getpid()
stat=pathlib.Path('/proc/self/stat').read_text();start_ticks=stat[stat.rfind(')')+2:].split()[19]
log=pathlib.Path(os.environ['UU_EVAL_EVENTS'])
record_identity={'policyId':os.environ['UU_EVAL_POLICY'], 'checkpointSha256':os.environ['UU_EVAL_CHECKPOINT_SHA256']}
def record(event):
    with log.open('a') as stream:stream.write(json.dumps({'workerPid':pid,'workerStartTicks':start_ticks,'gameID':os.environ.get('SHWDN2OP_GAME_RUN_ID'),**record_identity,**event})+'\n')
init=w.KakunaPolicy.__init__;propose=w.KakunaPolicy.propose;commit=w.KakunaPolicy.commit
def observed_init(self,*args,**kwargs):
    init(self,*args,**kwargs)
    import numpy as np
    self.proof_previous=self.previous_action.copy();self.proof_forwards=0
    get_actions=self.policy.get_actions
    def forward(**inputs):
        assert np.array_equal(self.previous_action,self.proof_previous)
        self.proof_forwards+=1
        result=get_actions(**inputs)
        record({'event':'forward','number':self.proof_forwards,'step':self.step,
            'previousActionSha256':hashlib.sha256(self.previous_action.tobytes()).hexdigest()})
        return result
    self.policy.get_actions=forward
    record({'event':'initialized','workerSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'seed':self.seed})
def observed_propose(self,*args):
    choice=propose(self,*args);self.proof_sample=choice
    record({'event':'proposal','step':self.step,'choice':choice,'forwards':self.proof_forwards,'redrawn':self.redrawn})
    return choice
def observed_commit(self,choice):
    import numpy as np
    origin,mapping=self.pending
    index=self.resolve_index(choice);aliases=sum(candidate==choice for candidate,_ in mapping)
    assert any(candidate==choice and i==index for candidate,i in mapping)
    expected=self.wrapper.make_action_rep(np.array([[index]],dtype=np.int64))
    before=self.proof_forwards;commit(self,choice)
    assert self.previous_state is origin and self.pending is None and np.array_equal(self.previous_action,expected)
    assert self.proof_forwards==before
    self.proof_previous=expected.copy()
    record({'event':'commit','step':self.step,'choice':choice,'sample':self.proof_sample,
        'override':choice!=self.proof_sample,'originActionIndex':index,'aliases':aliases,
        'forwards':self.proof_forwards,'actualPreviousActionSha256':hashlib.sha256(expected.tobytes()).hexdigest()})
w.KakunaPolicy.__init__=observed_init
w.KakunaPolicy.propose=observed_propose
w.KakunaPolicy.commit=observed_commit
# Optional propose-reply field: the worker's own legal-action distribution (re-ranker input). Sampling unchanged.
probs_spec=importlib.util.spec_from_file_location('action_probs',pathlib.Path(__file__).resolve().parents[1]/'metamon_port/action_probs.py')
action_probs=importlib.util.module_from_spec(probs_spec);probs_spec.loader.exec_module(action_probs);action_probs.install(w)
sys.argv[0]=str(path)
sys.exit(entry.main())
