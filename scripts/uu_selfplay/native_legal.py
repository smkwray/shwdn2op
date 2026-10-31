"""Match the pinned worker's legal redraw and cached trapped-switch retry."""
import copy,hashlib,json,re
from pathlib import Path
from types import SimpleNamespace

TRAPPED="[Unavailable choice] Can't switch: The active Pokémon is trapped"

def team_preview(lead,battle):
    from lead_model import preview_order
    return '/team '+''.join(map(str,preview_order(lead.predict(battle,battle._last_request))))

def turn_limit_notice(row):
    if len(row)!=3 or row[1]!='bigerror':return False
    match=re.fullmatch(r"You will auto-tie if the battle doesn't end in (\d+) (turns?) \(on turn 1000\)\.",row[2])
    return bool(match and 0<=int(match[1])<=500 and match[2]==('turn' if int(match[1])==1 else 'turns'))

def trapped_reissue(before,after):
    if (not isinstance(before,dict) or not isinstance(after,dict)
        or len(after.get('active',[]))!=1 or after['active'][0].get('trapped') is not True
        or after.get('wait') or after.get('teamPreview') or any(after.get('forceSwitch',[]))):return False
    old=copy.deepcopy(before);new=copy.deepcopy(after)
    old_id=old.pop('rqid',None);new_id=new.pop('rqid',None)
    if type(old_id) is not int or type(new_id) is not int:return False
    if new_id!=old_id and not (new_id>old_id and new.get('update') is True):return False
    if new.get('update') is True:new.pop('update')
    if len(old.get('active',[]))!=1:return False
    old['active'][0].pop('maybeTrapped',None);old['active'][0]['trapped']=True
    return old==new

def install_sampling(experiment,worker,seed=None,context=None):
    """Keep the native draw, then use the pinned worker's redraw if it is masked."""
    import torch
    policy=experiment.policy;original=policy.get_actions;actor=policy.actor.forward
    state={};experiment.native_legal=state
    def capture(*args,**kwargs):
        distribution=actor(*args,**kwargs);state['distribution']=distribution
        return distribution
    policy.actor.forward=capture
    def actions(*args,**kwargs):
        if kwargs.get('sample') is not True:raise ValueError('Native collection requires stochastic policy sampling')
        if seed is not None:
            env=context['env'];battle=env.current_battle
            if state.get('battle')!=battle.battle_tag:
                game_seed=int.from_bytes(hashlib.sha256(f'{seed}:{battle.battle_tag}'.encode()).digest()[:4],'big')
                torch.manual_seed(worker.side_seed(game_seed,battle._last_request['side']['id']))
                state['battle']=battle.battle_tag;env.shwdn2op_policy_seed=game_seed
        value,hidden=original(*args,**kwargs)
        if value.shape!=(1,1,1):raise ValueError('One per-game actor required')
        mask=kwargs['obs']['illegal_actions'][0,-1].bool()
        legal=torch.nonzero(~mask,as_tuple=False).flatten().tolist()
        if not legal:raise ValueError('No native request-legal action')
        holder=SimpleNamespace(last_dist=state['distribution'])
        if int(value.item()) not in legal:
            value=value.clone();value[0,0,0]=worker.KakunaPolicy.redraw(holder,legal)
        state['lastAction']=int(value.item());state['forwards']=state.get('forwards',0)+1
        return value,hidden
    policy.get_actions=actions
    def rechoose(env,battle,state_now,mapping):
        holder=SimpleNamespace(last_dist=state['distribution'])
        return worker.KakunaPolicy.redraw(holder,sorted({i for _,i in mapping}))
    return rechoose

def install_protocol(worker,rechoose,trace_dir,context=None,metadata=None):
    """Resolve a rejected switch inside one environment step, without a forward."""
    import numpy as np
    from metamon.env.wrappers import PokeEnvWrapper
    from metamon.env.metamon_player import MetamonPlayer
    from metamon.interface import UniversalState,UniversalAction
    from metamon.rl.metamon_to_amago import MetamonAMAGOWrapper
    out=Path(trace_dir);out.mkdir(parents=True,exist_ok=True)
    init=PokeEnvWrapper.__init__;move=PokeEnvWrapper.action_to_move;reset=PokeEnvWrapper.reset
    inner_step=MetamonAMAGOWrapper.inner_step
    messages=MetamonPlayer._handle_battle_message;request=MetamonPlayer._handle_battle_request
    def initialize(env,*args,**kwargs):
        # The existing yield controller pauses the private server as well as
        # players. Disable its wall-clock battle timer so a pause cannot forfeit.
        kwargs['start_timer_on_battle_start']=False
        env.shwdn2op_strict_policy=True
        env.shwdn2op_rechoice=False
        if context is not None:context['env']=env
        if metadata is not None:env.shwdn2op_policy_spec=metadata
        init(env,*args,**kwargs)
    def reset_episode(env,*args,**kwargs):
        env.shwdn2op_verified_trapped_retries=0
        env.shwdn2op_rechoice=False
        return reset(env,*args,**kwargs)
    def invalid(env,battle):
        (out/'failure.json').write_text(json.dumps({'battle':battle.battle_tag,'reason':'Native invalid order; no fallback','trainingEligible':False}))
        raise RuntimeError('Native invalid order; retained, no fallback')
    def action_to_move(env,action,battle):
        buffer=env.shwdn2op_pending_buffer
        if not isinstance(buffer,np.ndarray) or buffer.size!=1:raise ValueError('Mutable single-actor action buffer required')
        scalar=np.asarray(action)
        if scalar.size!=1 or not np.issubdtype(scalar.dtype,np.integer) or int(scalar.item())!=int(buffer.item()):raise ValueError('Native scalar action differs from outer action buffer')
        env.shwdn2op_pending_action=buffer
        env.shwdn2op_accepted_index=int(scalar.item())
        env.shwdn2op_pending_rqid=battle._last_request['rqid']
        env.shwdn2op_pending_request=copy.deepcopy(battle._last_request)
        return move(env,action,battle)
    def bound_inner_step(wrapper,action):
        if not isinstance(action,np.ndarray) or action.size!=1:raise ValueError('Single native action buffer required')
        wrapper.env.unwrapped.shwdn2op_pending_buffer=action
        return inner_step(wrapper,action)
    async def observed(player,rows):
        tag=rows[0][0].lstrip('>')
        if not tag.startswith('battle-gen9uu-') or not all(c.isalnum() or c=='-' for c in tag):raise ValueError('Owned private battle required')
        with (out/(tag+'-wire.jsonl')).open('a') as stream:stream.write(json.dumps(rows)+'\n')
        for row in rows[1:]:
            if len(row)>1 and row[1] in ('error','bigerror'):
                # Pinned official battle.ts emits these informational notices;
                # the entire packet must still reach the state decoder.
                if turn_limit_notice(row):continue
                env=getattr(player,'_user_funcs',None)
                if row[1]!='error' or '|'.join(row[2:])!=TRAPPED or env is None or getattr(env,'shwdn2op_rechoice',False):
                    (out/'failure.json').write_text(json.dumps({'battle':tag,'reason':'Unsupported native policy protocol error','row':row,'trainingEligible':False}))
                    raise RuntimeError('Unsupported native policy error; retained, no fallback')
                env.shwdn2op_rechoice=True
        return await messages(player,rows)
    async def handle(player,battle,maybe_default_order=False):
        env=getattr(player,'_user_funcs',None)
        if env is None or not getattr(env,'shwdn2op_rechoice',False):
            return await request(player,battle,maybe_default_order)
        raw=battle._last_request
        if maybe_default_order or not trapped_reissue(env.shwdn2op_pending_request,raw):
            (out/'failure.json').write_text(json.dumps({'battle':battle.battle_tag,'reason':'Malformed native trapped re-request','request':raw,'trainingEligible':False}))
            raise RuntimeError('Malformed native trapped re-request; retained')
        current=UniversalState.from_Battle(battle)
        legal=sorted({env.metamon_action_space.action_to_agent_output(current,a)
            for a in UniversalAction.definitely_valid_actions(current,battle)})
        mapping=[(worker.structural_choice(env.metamon_action_space.agent_output_to_action(current,i).to_BattleOrder(battle),raw),i) for i in legal]
        index=rechoose(env,battle,current,mapping)
        if index not in legal:raise RuntimeError('Cached retry selected a nonlegal action')
        action=env.shwdn2op_pending_action;action[...] = index
        env.shwdn2op_accepted_index=index
        # The outer AMAGO wrapper encodes this same mutable buffer after step()
        # returns. Its recurrent previous-action and native replay stay aligned.
        env.trajectory['states'][-1]=current
        env._most_recent_state=current;env.last_battle=copy.deepcopy(battle)
        env.valid_action_counter-=1
        order=move(env,index,battle)
        env.shwdn2op_rechoice=False
        env.shwdn2op_verified_trapped_retries=getattr(env,'shwdn2op_verified_trapped_retries',0)+1
        player._trying_again.clear()
        with (out/(battle.battle_tag+'-retries.jsonl')).open('a') as stream:
            stream.write(json.dumps({'rqid':raw['rqid'],'acceptedIndex':index,'neuralForwardReused':True})+'\n')
        await player.ps_client.send_message(order.message,battle.battle_tag)
    PokeEnvWrapper.__init__=initialize;PokeEnvWrapper.action_to_move=action_to_move
    PokeEnvWrapper.reset=reset_episode;PokeEnvWrapper.on_invalid_order=invalid
    MetamonAMAGOWrapper.inner_step=bound_inner_step
    MetamonPlayer._handle_battle_message=observed;MetamonPlayer._handle_battle_request=handle

def register_native(name,trace_dir,seed,metadata,backbone_config=None,*,lead_checkpoint):
    import os
    from metamon.rl import pretrained
    from candidate_worker import worker_module
    from lead_model import LeadModel
    from metamon.env.metamon_player import MetamonPlayer
    lead=LeadModel(lead_checkpoint);lead.load()
    if lead.model is None:raise ValueError('Qualified native lead model unavailable')
    def preview(player,battle):
        return team_preview(lead,battle)
    MetamonPlayer.teampreview=preview
    if name not in ('UUKakuna','UUExport'):raise ValueError('Explicit Kakuna-architecture native policy required')
    cls=pretrained.ALL_PRETRAINED_MODELS[name];original=cls.initialize_agent
    def initialize(self,*args,**kwargs):
        experiment=original(self,*args,**kwargs);worker=worker_module()
        worker.check_runtime(Path(os.environ['UU_KAKUNA_CKPT']))
        experiment.sample_actions_val=True
        bound={**metadata,'temperature':kwargs['action_temperature']}
        context={}
        if backbone_config is not None:
            from native_mlx_backbone import install
            bound.update(install(experiment,context,backbone_config,bound))
        experiment.native_legal_context=context
        rechoose=install_sampling(experiment,worker,seed,context)
        install_protocol(worker,rechoose,trace_dir,context,bound)
        return experiment
    cls.initialize_agent=initialize
