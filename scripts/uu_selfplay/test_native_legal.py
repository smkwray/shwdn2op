"""Selected native sampler/protocol versus the pinned worker, without NN weights."""
import asyncio,contextlib,copy,json,logging,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
import numpy as np
import torch
from candidate_worker import worker_module
from metamon.rl.pretrained import Kakuna
from metamon.rl.metamon_to_amago import make_placeholder_env
from metamon.rl.metamon_to_amago import MetamonAMAGOWrapper
from metamon.interface import UniversalState,UniversalAction
from metamon.env.wrappers import PokeEnvWrapper
from metamon.env.metamon_player import MetamonPlayer
from native_legal import install_sampling,install_protocol,TRAPPED,trapped_reissue

worker=worker_module();fixture=json.loads(Path(sys.argv[1]).read_bytes());sys.argv=sys.argv[:1]
def prefix(need_invalid=False):
 d=worker.SocketlessBattle();model=Kakuna()
 for row in fixture['rows']:
  if row['op']!='observe':continue
  d.observe(row['data'],row['context'])
  if not d.request or d.request.get('wait') or d.request.get('teamPreview') or any(d.request.get('forceSwitch',[])):continue
  state=UniversalState.from_Battle(d.battle)
  legal=sorted(model.action_space.action_to_agent_output(state,a) for a in UniversalAction.definitely_valid_actions(state,d.battle))
  switches=[i for i in legal if 4<=i<9]
  if switches and (not need_invalid or len(legal)<13):return d,model,legal,switches[0]
 raise ValueError('Recorded fixture lacks required legal-mask case')
class FakeActor:
 def forward(self,*args,**kwargs):return SimpleNamespace(probs=torch.arange(1,14,dtype=torch.float32).reshape(1,1,1,13)/91)
class FakePolicy:
 def __init__(self,index,owner=None):self.index=index;self.owner=owner;self.actor=FakeActor();self.calls=0
 def get_actions(self,**kw):
  self.calls+=1;self.inputs=kw;dist=self.actor.forward(None)
  if self.owner is not None:self.owner.last_dist=dist
  return torch.tensor([[[self.index]]]),kw['hidden_state']
def reference(model,index):
 p=worker.KakunaPolicy.__new__(worker.KakunaPolicy);p.model=copy.deepcopy(model)
 p.model.observation_space.reset();p.wrapper=make_placeholder_env(p.model.observation_space,p.model.action_space)
 p.previous_state=None;p.previous_action=np.zeros((1,p.wrapper.action_size),dtype=p.wrapper.action_dtype)
 p.step=0;p.pending=None;p.hidden=object();p.experiment=SimpleNamespace(DEVICE=torch.device('cpu'),caster=contextlib.nullcontext)
 p.policy=FakePolicy(index,p)
 return p
class NativeLegalTests(unittest.TestCase):
 def test_native_server_reissue_only_changes_request_envelope_and_trapped_flag(self):
  before={'rqid':8,'active':[{'moves':[{'id':'tackle','pp':12}],'maybeTrapped':True}],'side':{'id':'p1'}}
  after=copy.deepcopy(before);after.update(rqid=10,update=True);after['active'][0].pop('maybeTrapped');after['active'][0]['trapped']=True
  self.assertTrue(trapped_reissue(before,after))
  changed=copy.deepcopy(after);changed['active'][0]['moves'][0]['pp']=11
  self.assertFalse(trapped_reissue(before,changed))
  changed=copy.deepcopy(after);changed.pop('update');self.assertFalse(trapped_reissue(before,changed))
 def test_official_turn_notice_preserves_packet_and_unknown_error_fails(self):
  from unittest.mock import AsyncMock,patch
  names=[(PokeEnvWrapper,n) for n in ('__init__','reset','action_to_move','on_invalid_order')]+[(MetamonPlayer,n) for n in ('_handle_battle_message','_handle_battle_request')]+[(MetamonAMAGOWrapper,'inner_step')]
  originals=[(cls,name,getattr(cls,name)) for cls,name in names]
  packet=[['>battle-gen9uu-offline'],['','switch','p1a: Toxapex','Toxapex','303/303'],['','bigerror',"You will auto-tie if the battle doesn't end in 400 turns (on turn 1000)."],['','turn','600']]
  with TemporaryDirectory() as tmp:
   delegate=AsyncMock()
   try:
    with patch.object(MetamonPlayer,'_handle_battle_message',delegate):
     install_protocol(worker,lambda *a:None,tmp)
     asyncio.run(MetamonPlayer._handle_battle_message(SimpleNamespace(),packet))
     delegate.assert_awaited_once_with(SimpleNamespace(),packet)
     for row in (['','bigerror','Unknown simulator error'],['','error',"You will auto-tie if the battle doesn't end in 400 turns (on turn 1000)."]):
      with self.assertRaisesRegex(RuntimeError,'Unsupported native policy error'):
       asyncio.run(MetamonPlayer._handle_battle_message(SimpleNamespace(),[packet[0],row]))
   finally:
    for cls,name,value in originals:setattr(cls,name,value)
 def test_masked_draw_uses_worker_redraw_rng_and_keeps_cache(self):
  d,model,legal,_=prefix(True);index=next(i for i in range(13) if i not in legal)
  ref=reference(model,index);torch.manual_seed(8192);start=torch.random.get_rng_state()
  expected=ref.propose(d.battle,d.request);expected_index=ref.resolve_index(expected);end=torch.random.get_rng_state()
  native=SimpleNamespace(policy=FakePolicy(index));install_sampling(native,worker)
  torch.random.set_rng_state(start);actual,hidden=native.policy.get_actions(**ref.policy.inputs)
  self.assertEqual(int(actual.item()),expected_index);self.assertTrue(torch.equal(torch.random.get_rng_state(),end))
  self.assertIs(hidden,ref.hidden);self.assertEqual(native.policy.calls,1)
 def test_trapped_protocol_reuses_forward_and_updates_native_action_buffer(self):
  d,model,legal,index=prefix();ref=reference(model,index);ref.propose(d.battle,d.request)
  native=SimpleNamespace(policy=FakePolicy(index));rechoose=install_sampling(native,worker)
  native.policy.get_actions(**ref.policy.inputs)
  old=copy.deepcopy(d.request);new=copy.deepcopy(old);new['active'][0]['trapped']=True
  context={**d.context,'sequence':d.context['sequence']+1}
  d.observe('|error|'+TRAPPED+'\n|request|'+json.dumps(new),context,True)
  torch.manual_seed(7193);start=torch.random.get_rng_state()
  expected=ref.propose(d.battle,d.request,True);expected_index=ref.resolve_index(expected);end=torch.random.get_rng_state()
  action=np.array([index],dtype=np.int64)
  env=SimpleNamespace(metamon_action_space=model.action_space,shwdn2op_pending_action=action,
   shwdn2op_pending_rqid=old['rqid'],shwdn2op_pending_request=old,shwdn2op_rechoice=False,trajectory={'states':[UniversalState.from_Battle(d.battle)]},
   valid_action_counter=1,invalid_action_counter=0)
  class LocalPlayer(MetamonPlayer):
   def choose_move(self,*args):raise AssertionError('Retry must not ask for another action')
  player=object.__new__(LocalPlayer);player._user_funcs=env;player._trying_again=asyncio.Event();sent=[]
  async def get_battle(tag):return d.battle
  async def send(message,room):sent.append((message,room))
  player._get_battle=get_battle;player.ps_client=SimpleNamespace(username='Offline p1',logger=logging.getLogger('test'),send_message=send)
  names=[(PokeEnvWrapper,n) for n in ('__init__','reset','action_to_move','on_invalid_order')]+[(MetamonPlayer,n) for n in ('_handle_battle_message','_handle_battle_request')]+[(MetamonAMAGOWrapper,'inner_step')]
  originals=[(cls,name,getattr(cls,name)) for cls,name in names]
  with TemporaryDirectory() as tmp:
   install_protocol(worker,rechoose,tmp);torch.random.set_rng_state(start)
   try:asyncio.run(player._handle_battle_message([['>'+d.battle.battle_tag],['','error',TRAPPED],['','request',json.dumps(new)]]))
   finally:
    for cls,name,value in originals:setattr(cls,name,value)
  self.assertEqual(int(action.item()),expected_index);self.assertTrue(torch.equal(torch.random.get_rng_state(),end))
  self.assertEqual(native.policy.calls,1);self.assertEqual(native.native_legal['forwards'],1)
  self.assertEqual(env.valid_action_counter,1);self.assertEqual(env.invalid_action_counter,0)
  self.assertEqual(env.shwdn2op_verified_trapped_retries,1);self.assertEqual(len(sent),1)
  actual=env.trajectory['states'][0];expected_state=ref.pending[0]
  left=actual.to_dict();right=expected_state.to_dict()
  # Both production encoders sort this upstream set; compare all other
  # fields exactly and independently prove their encoded observations equal.
  left['opponent_teampreview']=sorted(left['opponent_teampreview'])
  right['opponent_teampreview']=sorted(right['opponent_teampreview'])
  self.assertEqual(left,right)
  actual_obs=copy.deepcopy(ref.model.observation_space).state_to_obs(actual)
  expected_obs=copy.deepcopy(ref.model.observation_space).state_to_obs(expected_state)
  for key in actual_obs:np.testing.assert_array_equal(actual_obs[key],expected_obs[key])
  ref.commit(expected)
  np.testing.assert_array_equal(ref.previous_action,ref.wrapper.make_action_rep(action.reshape(1,1)))
 def test_binds_before_native_scalar_conversion(self):
  import gymnasium as gym
  d,model,legal,index=prefix()
  env=SimpleNamespace(metamon_action_space=model.action_space,valid_action_counter=0,invalid_action_counter=0)
  class Conversion:
   unwrapped=env
   def step(self,action):
    PokeEnvWrapper.action_to_move(env,int(action.item()),d.battle)
    return {'numbers':np.zeros(1)},0.,False,False,{'legal_actions':legal}
  class Wrapper:
   env=Conversion();action_space=gym.spaces.Discrete(13)
   add_illegal_action_mask_to_obs=MetamonAMAGOWrapper.add_illegal_action_mask_to_obs
  names=[(PokeEnvWrapper,n) for n in ('__init__','reset','action_to_move','on_invalid_order')]+[(MetamonPlayer,n) for n in ('_handle_battle_message','_handle_battle_request')]+[(MetamonAMAGOWrapper,'inner_step')]
  originals=[(cls,name,getattr(cls,name)) for cls,name in names]
  with TemporaryDirectory() as tmp:
   install_protocol(worker,lambda *a:None,tmp);action=np.array([index],dtype=np.int64)
   try:MetamonAMAGOWrapper.inner_step(Wrapper(),action)
   finally:
    for cls,name,value in originals:setattr(cls,name,value)
  self.assertIs(env.shwdn2op_pending_action,action)
  self.assertEqual(env.shwdn2op_accepted_index,index)
  self.assertEqual(env.valid_action_counter,1)

if __name__=='__main__':unittest.main()
