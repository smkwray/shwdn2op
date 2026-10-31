#!/usr/bin/env python3
"""Closed-run gate: exact canonical/native replay, worker joins, seeds, IDs, unload."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
from analyze import rows
from evaluate import check_priors, job_for, remote, pins_local, runtime_pins, write, PROJECT
from spec import BASE_SHA, TEAM_POOL, is_rerank, sha, validate


def verify_recurrence(es, attempts, proposed=None):
    """Every attempted neural choice is proposed; only accepted choices commit. `proposed` is the worker's own pick
    per attempt: the attempted choice by default, Metamon's raw pick on a re-rank seat (which commits the executed one;
    a re-ranked trapped switch is staged with the worker, so its re-choice reuses the same forward)."""
    proposed = [r['choice'] for r in attempts] if proposed is None else proposed
    assert len(proposed) == len(attempts), 'PROPOSAL_ALIGNMENT'
    counts = Counter(e['event'] for e in es)
    neural = [(r, p) for r, p in zip(attempts, proposed) if r['identity']['requestKind'] != 'team_preview']
    accepted = [r for r, _ in neural if r['accepted']]
    assert all(r['accepted'] for r in attempts if r['identity']['requestKind'] == 'team_preview'), 'REJECTED_PREVIEW'
    assert counts['forward'] == counts['commit'] == len(accepted), 'EXACT_COMMIT_RECURRENCE'
    assert counts['proposal'] == len(neural), 'EXACT_ATTEMPT_PROPOSALS'
    proposals = [e for e in es if e['event'] == 'proposal']
    commits = [e for e in es if e['event'] == 'commit']
    def token(ch):
        return ('move '+str(ch['moveSlot'])+(' terastallize' if ch['terastallize'] else '')) if ch['kind']=='move' else 'switch '+str(ch['switchSlot'])
    step = 0
    for i, (event, (row, choice)) in enumerate(zip(proposals, neural)):
        assert token(event['choice']) == choice, 'PROPOSED_ATTEMPT_JOIN'
        assert event['step'] == step + 1 and event['forwards'] == step + 1, 'RECHOICE_STEPPED_MODEL'
        if not row['accepted']:
            assert row['choice'].startswith('switch ') and i+1 < len(neural), 'UNPROVED_REJECTION'
            nxt = neural[i+1][0]
            assert nxt['accepted'] and nxt['rqid'] == row['rqid'] and nxt['identity'] != row['identity'], 'UNPROVED_RECHOICE'
            assert nxt['choice'].startswith('move '), 'TRAPPED_SWITCH_RECHOICE'
        else:
            step += 1
    for event, row in zip(commits, accepted):
        assert token(event['choice']) == row['choice'], 'EXECUTED_COMMIT_JOIN'
    return counts


def raw_choices(d, side, attempts):
    """Choice tokens of Metamon's raw picks (rerank-trace rawActionId) in the verified envelopes, per attempt."""
    legal={x['requestId']:x['envelope']['semantic']['snapshot']['legalActions'] for x in rows(d/'reconstructed-envelopes.jsonl') if x['side']==side}
    raw={t['requestId']:t['rawActionId'] for t in rows(d/'rerank-trace.jsonl')}
    result=[]
    for r in attempts:
        match=[a['choice'] for a in legal[r['requestId']] if a['id']==raw[r['requestId']]]
        assert len(match)==1,'RAW_ACTION_JOIN'
        result.append(match[0])
    return result


def failed_games(terminal, spec, allow=False):
    """Game IDs a finished run recorded as failed. The pre-registration excludes incomplete pairs from paired statistics,
    so a run that attempted every game, with no cohort failure, unchanged pins, every game unloaded and fewer than three
    failures (the hardstop), still verifies its completed games. Anything else is never verifiable."""
    if terminal['status'] == 'COMPLETED':
        return set()
    games = terminal.get('games') or []
    failed = {r['gameID'] for r in games if r['exitCode'] != 0}
    assert allow and terminal.get('failure') is None and terminal.get('producerAndRuntimeUnchanged') \
        and len(games) == len(spec['games']) and 0 < len(failed) < 3 and all(r['unloaded'] for r in games), \
        ('NOT_VERIFIABLE', terminal.get('failure'), len(failed))
    return failed


def verify(root, allow_failed=False):
    spec=json.loads((root/'spec.json').read_text());rt=spec['runtime'];rerank=is_rerank(spec)
    validate(spec,TEAM_POOL)
    check_priors(root,spec)
    assert pins_local(root/'producer')==json.loads((root/'producer-manifest.json').read_text()),'SOURCE_DRIFT'
    assert runtime_pins()==json.loads((root/'runtime-manifest.json').read_text()),'RUNTIME_DRIFT'
    terminal=json.loads((root/'terminal.json').read_text());failed=failed_games(terminal,spec,allow_failed);excluded=[]
    command=['node','--import','tsx',str(Path(__file__).with_name('verify_teams.ts')),str(root)]
    p=subprocess.run(command,cwd=PROJECT,text=True,capture_output=True,timeout=120,env={**os.environ,'TMPDIR':str(root/'scratch'),'TSX_DISABLE_CACHE':'1'})
    write(root/'verify-teams-transport.json',{'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
    assert p.returncode==0,('ACTUAL_TEAM_SLOT_JOIN',p.stderr)
    result=[]
    for g in spec['games']:
        d=root/g['gameID'];summary=json.loads((d/'summary.json').read_text())
        if g['gameID'] in failed:
            assert summary['status']!='completed' and json.loads((d/'lifecycle.json').read_text())['unloaded'],'FAILED_GAME_RECORD'
            excluded.append({'gameID':g['gameID'],'slotID':g['slotID'],'arm':g['arm'],'errors':summary['errors']});continue
        assert summary['status']=='completed'
        lifecycle=json.loads((d/'lifecycle.json').read_text());assert lifecycle['unloaded'] and len(lifecycle['capturedWorkers'])==2
        if rerank:assert json.loads((d/'job.json').read_text())==job_for(root,spec,g),'JOB_SPEC_BINDING'
        # verify_rerank.ts reads the envelopes verify_canonical.ts reconstructs.
        for name in ('canonical','native')+(('rerank',) if rerank else ()):
            command=['node','--import','tsx',str(root/f'producer/scripts/uu_eval/verify_{name}.ts'),str(d)]
            p=subprocess.run(command,cwd=root/'producer',text=True,capture_output=True,timeout=1800,
                             env={**os.environ,'TMPDIR':str(root/'scratch'),'TSX_DISABLE_CACHE':'1'})
            write(d/f'verify-{name}-transport.json',{'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
            assert p.returncode==0,(g['gameID'],name,p.stderr[-1000:])
        events={}
        code="""import sys,json
from pathlib import Path
x=json.loads(sys.argv[1]);print(json.dumps({s:(Path(x['root'])/'events'/(x['game']+'-'+s+'.jsonl')).read_text() for s in ['p1','p2']}))"""
        texts=remote(rt,code,{'root':rt['remoteRoot'],'game':g['gameID']})
        traj=list(rows(d/'trajectory.jsonl'))
        for side,text in texts.items():
            (d/(side+'-neural-events.jsonl')).write_text(text)
            es=[json.loads(line) for line in text.splitlines() if line.strip()];counts=Counter(e['event'] for e in es)
            init=[e for e in es if e['event']=='initialized'];assert len(init)==1
            c=g['arm']=='B1' and side==g['seat'];expected=spec['candidate']['policyId'] if c else 'metamon:Kakuna:epoch34'
            assert init[0]['seed']==g['sideSeeds'][side], 'SIDE_SEED_BINDING'
            assert all(e['policyId']==expected for e in es),'WORKER_POLICY_ID'
            assert all(e['checkpointSha256']==(spec['candidate']['sha256'] if c else BASE_SHA) for e in es),'WORKER_CHECKPOINT'
            assert any(x['pid']==init[0]['workerPid'] and x['start_ticks']==init[0]['workerStartTicks'] for x in lifecycle['capturedWorkers']),'PROCESS_JOIN'
            executed=[r for r in traj if r['side']==side];proposed=None
            if rerank and side==g['seat']:
                c=spec['candidate']
                assert all((t['version'],t['guardsVersion'])==(c['rerankerVersion'],c['guardsVersion']) for t in rows(d/'rerank-trace.jsonl')),'RERANKER_VERSION'
                proposed=raw_choices(d,side,executed)
            counts=verify_recurrence(es,executed,proposed)
            assert summary['players'][side]['policyId']==expected
            assert all(r['policyId']==expected and not r['fallback'] for r in executed)
            events[side]={'policyId':expected,'seed':init[0]['seed'],'counts':dict(counts),
                          'redraws':sum(bool(e.get('redrawn')) for e in es)}
        inputs=json.loads((d/'replay-inputs.json').read_text());assert inputs['seed']==g['seed']
        result.append({'gameID':g['gameID'],'slotID':g['slotID'],'arm':g['arm'],'seed':g['seed'],
                       'workerSeed':g['workerSeed'],'teamSha256':g['teamSha256'],'workers':events,
                       'choices':len(traj),'canonical':'PASS','native':'PASS',**({'rerank':'PASS'} if rerank else {}),'unloaded':True})
    receipt={'status':'PASS','completedGames':len(result),'failedGames':excluded,'slotsPerArm':len(spec['slots']),
             'identicalSlotsAcrossArms':True,'games':result,'candidatePolicyId':spec['candidate']['policyId']}
    write(root/'verification.json',receipt)
    return {k:v for k,v in receipt.items() if k!='games'}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root')
    p.add_argument('--allow-failed-games',action='store_true',help='verify a run with fewer than three failed games (excluded as incomplete pairs)')
    a=p.parse_args();print(json.dumps(verify(Path(a.root).resolve(),a.allow_failed_games),indent=2))
