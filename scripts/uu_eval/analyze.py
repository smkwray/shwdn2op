#!/usr/bin/env python3
"""Exact-private-HP material and preregistered family-level paired inference."""
import argparse
from collections import Counter, defaultdict
from fractions import Fraction
import csv
import itertools
import json
import math
from pathlib import Path
import random
import statistics as st
from spec import TEAM_POOL, is_rerank, validate, sha

METRICS=['score','M5','M10','M15','M20','M25','AUC5-15','AUC15-25']
TRACE_STATS=('rerankDecisions','redGuardDecisions','executedFlagged','rerankedAway')
ADOPTION_RULE=('Adopted rule (penalty decision for metamon-rerank@2): '
    'primary = paired terminal score B1-B0 with equal family weights; it passes only if the family-cluster bootstrap 95% '
    'lower bound > 0 AND the exact sign-flip permutation p < 0.05. A secondary (AUC5-15, AUC15-25) regresses only if its '
    'family-cluster 95% CI lies entirely below 0. Adopt the re-ranker as the live default only if the primary passes and '
    'no secondary regresses. Otherwise extend (one more 560-game cohort with seed vectors 3-4, pooled with a 97.5% lower-'
    'bound gate) if the point estimate > 0, the lower bound <= 0 and N_div >= 20; else stop (shadow-only). Nothing is '
    'decided on an unverified, partial or qualification cohort, and a determinism failure (a pair without an executed '
    're-rank whose results differ) invalidates the run. The loss-turn tactical suite is a regression report, not evidence.')


def rows(path):
    with Path(path).open() as f:
        for line in f:
            if line.strip():yield json.loads(line)

def hp_of(text):
    if 'fnt' in text:return 0.0
    n=text.split()[0]
    if '/' in n:
        a,b=n.split('/');return 100*float(a)/float(b)
    return float(n)

# Exact material producer reused from R60b (same turn-boundary and terminal semantics).
def private_material(path, side):
    hp, starts, start_requests, turn, final_turn = {}, {}, {}, 0, 0
    for chunk in rows(path):
        assert isinstance(chunk, str)
        for line in chunk.splitlines():
            p = line.split('|')
            if len(p)<3:continue
            tag = p[1]
            if tag=='turn':turn = final_turn = int(p[2])
            elif tag=='request':
                rq=json.loads(p[2]);mons=rq.get('side',{}).get('pokemon',[])
                if mons:
                    assert rq['side']['id']==side and len(mons)==6
                    hp={m['ident'].split(': ',1)[1]:hp_of(m['condition']) for m in mons}
                    assert len(hp)==6 and all(0<=v<=100 for v in hp.values())
                    if rq.get('active') and not rq.get('forceSwitch') and not rq.get('wait'):
                        boundary=(rq.get('rqid'),dict(hp))
                        if turn in starts:
                            assert rq.get('rqid') is not None and start_requests[turn]==boundary, 'REPEATED_MATERIAL_REQUEST_DRIFT'
                        else:
                            starts[turn]=sum(hp.values())
                            start_requests[turn]=boundary
            elif p[2].startswith(side) and tag in ('switch','drag','-damage','-heal','-sethp','faint'):
                nick=p[2].split(': ',1)[1]
                hp[nick]=0.0 if tag=='faint' else hp_of(p[4] if tag in ('switch','drag') else p[3])
    assert len(hp)==6 and set(starts)==set(range(1,final_turn+1))
    return starts,sum(hp.values())

def quant(xs,q):
    if not xs:return None
    xs=sorted(xs);i=(len(xs)-1)*q;a=math.floor(i);b=math.ceil(i)
    return xs[a]+(xs[b]-xs[a])*(i-a)

def exact_sign_flip_p(values):
    """Exact two-sided sign-flip permutation p for the mean of `values` (exact rationals): P(|sum s_i v_i| >= |sum v_i|)
    over all 2^n sign vectors, by dynamic programming over integer-scaled sums (n = 35 families is 2^35 vectors)."""
    values=[Fraction(v) for v in values]
    scale=math.lcm(*(v.denominator for v in values)) if values else 1
    counts={0:1}
    for v in values:
        k=int(v*scale);nxt=defaultdict(int)
        for total,c in counts.items():nxt[total+k]+=c;nxt[total-k]+=c
        counts=nxt
    observed=abs(int(sum(values)*scale))
    return sum(c for total,c in counts.items() if abs(total)>=observed)/2**len(values)

def paired_inference(pairs,metric,replicates=10000,seed=20261020):
    families=defaultdict(list)
    for r in pairs:families[r['family']].append(r[metric])
    if not families:return {'pairs':0,'families':0,'mean':None,'ci95':None,'signP':None,'permutationP':None}
    # Equal family weights; each bootstrap draw carries every within-family slot.
    means=[st.mean(x) for _,x in sorted(families.items())];n=len(means);rng=random.Random(seed)
    effect=st.mean(means)
    boot=[st.mean(rng.choices(means,k=n)) for _ in range(replicates)] if n>1 else []
    nonzero=[v for v in means if abs(v)>1e-12];pos=sum(v>0 for v in nonzero);neg=len(nonzero)-pos
    sign=min(1.0,2*sum(math.comb(len(nonzero),i) for i in range(min(pos,neg)+1))/2**len(nonzero)) if nonzero else 1.0
    if metric=='score':
        # Terminal score differences are multiples of 1/2, so family means are exact rationals: exact for any n.
        permutation=exact_sign_flip_p([sum(Fraction(v) for v in x)/len(x) for _,x in sorted(families.items())]);method='exact'
    elif n<=16:
        null=[abs(sum(v*s for v,s in zip(means,signs))/n) for signs in itertools.product((-1,1),repeat=n)]
        permutation=sum(v>=abs(effect)-1e-12 for v in null)/len(null);method='exact'
    else:
        null=[abs(sum(v*rng.choice((-1,1)) for v in means)/n) for _ in range(replicates)]
        permutation=(1+sum(v>=abs(effect)-1e-12 for v in null))/(1+replicates);method='monte_carlo'
    return {'pairs':len(pairs),'families':n,'mean':effect,'ci95':[quant(boot,.025),quant(boot,.975)] if boot else None,
            'signP':sign,'permutationP':permutation,'permutationMethod':method,'unit':'home family means; B1-B0',
            'positiveFamilies':pos,'negativeFamilies':neg,'zeroFamilies':n-pos-neg}

def trace_stats(path):
    """Home-seat guard telemetry; both arms log the same re-ranker features (B0 as a shadow)."""
    if not path.exists():return dict.fromkeys(TRACE_STATS)
    ts=list(rows(path))
    return {'rerankDecisions':len(ts),'redGuardDecisions':sum(any(x['severity']=='red' for x in t['guards']) for t in ts),
            'executedFlagged':sum(bool(t['flagged'].get(t['executedActionId'])) for t in ts),
            'rerankedAway':sum(t['executedActionId']!=t['rawActionId'] for t in ts)}

def tactical_suite(path):
    """Loss-turn tactical suite: a guard-firing regression report bound by its SHA-256, never adoption evidence."""
    r=json.loads(Path(path).read_text())
    assert str(r.get('schema','')).startswith('tactical-suite@') and isinstance(r.get('arms'),dict),'TACTICAL_SUITE_REPORT'
    return {'file':str(Path(path).resolve()),'sha256':sha(path),'schema':r['schema'],'arms':r['arms'],
            **({'regression':r['regression']} if 'regression' in r else {}),'evidence':False}

def divergence_report(pairs, divergent, replicates, seed):
    """N_div from B1's own trace; N_flip; the conditional effect over divergent pairs; the determinism premise."""
    hit=[r for r in pairs if r['slotID'] in divergent];quiet=[r for r in pairs if r['slotID'] not in divergent]
    violations=[r['slotID'] for r in quiet if any(abs(r[m])>1e-9 for m in METRICS)]
    return {'N_div':len(hit),'N_flip':sum(abs(r['score'])>1e-9 for r in pairs),'N_flipDivergent':sum(abs(r['score'])>1e-9 for r in hit),
            'conditional':paired_inference(hit,'score',replicates,seed),
            'determinism':{'pairs':len(quiet),'violations':violations,'pass':not violations}}

def adoption(paired, divergence, verified, qualification, notRun):
    """Adopted rule (ADOPTION_RULE). adoptLiveDefault is True/False only when the run can decide; else None."""
    score=paired['score'];ci=score['ci95'];lower=ci[0] if ci else None;p=score.get('permutationP')
    primary={'metric':'score','mean':score['mean'],'lowerBound95':lower,'permutationP':p,
             'pass':lower is not None and lower>0 and p is not None and p<.05}
    regressions=[m for m in ('AUC5-15','AUC15-25') if paired[m]['ci95'] and paired[m]['ci95'][1]<0]
    missing=[name for name,gap in (('score lowerBound95 (needs two or more families)',lower is None),
        ('AUC5-15 CI',not paired['AUC5-15']['ci95']),('AUC15-25 CI',not paired['AUC15-25']['ci95']),
        ('verification.json status PASS',not verified),('full dev cohort (a qualification cannot decide)',qualification),
        (f'{notRun} games not run',notRun>0)) if gap]
    ndiv=divergence['N_div']
    if not divergence['determinism']['pass']:
        action,reason='invalid','A pair without an executed re-rank has different results: the arms are not paired as designed.'
    elif missing:action,reason='undetermined','Missing: '+'; '.join(missing)
    elif primary['pass'] and not regressions:action,reason='adopt','Primary passes and no secondary regresses.'
    elif score['mean']>0 and not primary['pass'] and not regressions:
        # Inconclusive-positive: LB <= 0 (the rule's case); LB > 0 with permutation p >= 0.05 is treated the same way.
        action,reason=(('extend','Point estimate > 0 but the primary did not pass, and N_div >= 20: run one more 560-game cohort (seed vectors 3-4) and pool with a 97.5% lower-bound gate.')
                       if ndiv>=20 else ('stop',f'Point estimate > 0 but N_div={ndiv} < 20: keep the re-ranker shadow-only.'))
    else:action,reason='stop','Primary fails without a positive point estimate, or a secondary regresses: keep the re-ranker shadow-only.'
    adopt=None if action in ('undetermined','invalid') else action=='adopt'
    return {'primary':primary,'adoptLiveDefault':adopt,'adoptionRule':ADOPTION_RULE,'recommendation':{'action':action,'reason':reason},
            'adoptionBlockers':{'regressions':regressions,'missing':missing}}

def trajectory_admitted(directory, trajectory, verification=None):
    """Admit only accepted choices or replay-verified trapped-switch recovery.

    The closed-run verifier must prove both server rejection and model recurrence.
    A shape-compatible pair alone is insufficient evidence of a trapped switch.
    """
    if any(t['fallback'] for t in trajectory):
        return False
    rejected=sum(not t['accepted'] for t in trajectory)
    if not rejected:
        return True
    try:
        assert verification and verification['canonical']==verification['native']=='PASS'
        assert verification['unloaded'] and verification['choices']==len(trajectory)
        for name,status in (
            ('canonical-reconstruction.json','PASS_EXACT_CANONICAL_IDENTITIES_LEGAL_CHOICES_AND_RESULT_HASHES'),
            ('native-replay.json','PASS_EXACT_RECORDED_CHOICE_NATIVE_REPLAY')):
            receipt=json.loads((directory/name).read_text())
            assert receipt['status']==status and receipt['choices']==len(trajectory)
            assert receipt['trappedRejections']==rejected
        # Imported here: verify itself imports the analyzer's JSON-lines reader.
        from verify import verify_recurrence
        for side in ('p1','p2'):
            attempts=[t for t in trajectory if t['side']==side]
            events=list(rows(directory/(side+'-neural-events.jsonl')))
            counts=verify_recurrence(events,attempts)
            assert dict(counts)==verification['workers'][side]['counts']
        return True
    except (AssertionError, OSError, KeyError, TypeError, ValueError):
        return False


def analyze(root, tactical=None):
    spec=json.loads((root/'spec.json').read_text())
    validate(spec,TEAM_POOL);rerank=is_rerank(spec)
    assert tactical is None or rerank,'TACTICAL_SUITE_IS_A_RERANK_REPORT'
    suite=tactical_suite(tactical) if tactical else None
    material=[];excluded=[];latency=defaultdict(list);process=[];inputs={};lifecycles={};divergent=set()
    verification=root/'verification.json'
    proof=json.loads(verification.read_text()) if verification.exists() else {}
    verified_games={r['gameID']:r for r in proof.get('games',[]) } if proof.get('status')=='PASS' else {}
    for g in spec['games']:
        d=root/g['gameID'];base={k:g[k] for k in ('gameID','arm','slotID','family','opponentFamily','seat')}
        if (d/'lifecycle.json').exists():lifecycles[g['gameID']]=json.loads((d/'lifecycle.json').read_text())
        p=d/'summary.json'
        if not p.exists():excluded.append({**base,'status':'not_run_or_no_summary'});continue
        s=json.loads(p.read_text())
        inputs[str(p.relative_to(root))]=sha(p)
        traj=list(rows(d/'trajectory.jsonl'));home=[t for t in traj if t['side']==g['seat']]
        expected=spec['candidate']['policyId'] if g['arm']=='B1' else 'metamon:Kakuna:epoch34'
        assert all(t['policyId']==(expected if t['side']==g['seat'] else 'metamon:Kakuna:epoch34') for t in traj),'CANDIDATE_SEAT_IDENTITY'
        accepted=trajectory_admitted(d,traj,verified_games.get(g['gameID']))
        record={**base,'status':s['status'],'turns':s['turn'],'errors':s['errors'],'fallbacks':s['fallbacks'],
                'accepted':accepted,'trappedSwitchRetries':sum(not t['accepted'] for t in traj) if accepted else 0,'homeDecisions':len(home), 'homeSwitches':s['players'][g['seat']]['switches'],
                'homeTera':s['players'][g['seat']]['tera'],'stopReason':s.get('stopReason')}
        envelopes=d/'reconstructed-envelopes.jsonl'
        if envelopes.exists():
            envs={x['requestId']:x['envelope']['semantic']['snapshot'] for x in rows(envelopes) if x['side']==g['seat']}
            assert all(t['requestId'] in envs for t in home), 'LEGAL_ACTION_COVERAGE'
            available=[t for t in home if any(a['kind']=='move' and a.get('choice') and not a.get('disabled') and a.get('legality')!='disabled' for a in envs[t['requestId']]['legalActions'])]
            record.update(moveAvailableDecisions=len(available),voluntarySwitches=sum(t['actionId'].startswith('switch:') for t in available),legalityVerified=True)
        else:record.update(moveAvailableDecisions=None,voluntarySwitches=None,legalityVerified=False)
        if rerank:
            p=d/'rerank-trace.jsonl';record.update(trace_stats(p))
            if p.exists():
                inputs[str(p.relative_to(root))]=sha(p)
                # N_div counts B1's own executed re-ranks only (B0 is a shadow and never executes one).
                if g['arm']=='B1' and any(t['executedActionId']!=t['rawActionId'] for t in rows(p)):divergent.add(g['slotID'])
        process.append(record);latency[g['arm']].extend(t['latencyMs'] for t in home)
        if s['status']!='completed' or s['errors'] or s['fallbacks'] or not accepted:
            excluded.append({**base,'status':s['status'],'stopReason':s.get('stopReason'),'errors':s['errors']});continue
        exact={side:private_material(d/(side+'-private.jsonl'),side) for side in ('p1','p2')}
        opp='p2' if g['seat']=='p1' else 'p1';end=s['turn']
        assert s['winner'] in ('p1','p2','tie',None)
        m={**base,'turns':end,'outcome':'D' if s['winner'] in ('tie',None) else 'W' if s['winner']==g['seat'] else 'L'}
        m['score']={'W':1.,'D':.5,'L':0.}[m['outcome']]
        for t in (5,10,15,20,25):
            vals={side:exact[side][1] if t>=end else exact[side][0][t+1] for side in ('p1','p2')}
            m[f'M{t}']=vals[g['seat']]-vals[opp];m[f'terminalCarried{t}']=end<t
        m['AUC5-15']=(m['M5']+2*m['M10']+m['M15'])/4
        m['AUC15-25']=(m['M15']+2*m['M20']+m['M25'])/4
        material.append(m)
        for name in ('p1-private.jsonl','p2-private.jsonl','trajectory.jsonl','replay-inputs.json'):
            inputs[str((d/name).relative_to(root))]=sha(d/name)
    bykey={(r['slotID'],r['arm']):r for r in material};pairs=[];metrics=METRICS
    for slot in spec['slots']:
        a,b=bykey.get((slot['slotID'],'B0')),bykey.get((slot['slotID'],'B1'))
        if a is None or b is None:continue
        pairs.append({'slotID':slot['slotID'],'family':slot['family'],**{m:b[m]-a[m] for m in metrics}})
    arms={}
    for arm in ('B0','B1'):
        ms=[r for r in material if r['arm']==arm];ps=[r for r in process if r['arm']==arm]
        arms[arm]={'configured':len(spec['slots']),'completed':len(ms),'WDL':dict(Counter(r['outcome'] for r in ms)),
                   **{m:st.mean(r[m] for r in ms) if ms else None for m in metrics},
                   'censoredOrMissing':len(spec['slots'])-len(ms),'latencyP50Ms':quant(latency[arm],.5),
                   'latencyP95Ms':quant(latency[arm],.95),'errors':sum(len(r['errors']) for r in ps),
                   'fallbacks':sum(len(r['fallbacks']) for r in ps),
                   'crashes':sum(lifecycles.get(g['gameID'],{}).get('exitCode') not in (None,0,2) for g in spec['games'] if g['arm']==arm),
                   'voluntarySwitches':sum(r['voluntarySwitches'] for r in ps) if ps and all(r['legalityVerified'] for r in ps) else None,
                   'legalityVerifiedGames':sum(r['legalityVerified'] for r in ps),
                   'timeouts':sum(r['stopReason']=='deadline' for r in ps),
                   'trappedSwitchRetries':sum(r['trappedSwitchRetries'] for r in ps),
                   'unacceptedGames':sum(not r['accepted'] for r in ps)}
        if rerank:
            # A game without its trace makes the arm total unknown, never smaller.
            t={k:sum(r[k] for r in ps) if ps and all(r[k] is not None for r in ps) else None for k in TRACE_STATS}
            t['executedFlaggedRate']=t['executedFlagged']/t['rerankDecisions'] if t['rerankDecisions'] else None
            arms[arm]['inGameTactical']=t
    paired={m:paired_inference(pairs,m,spec['bootstrapReplicates'],spec['analysisSeed']) for m in metrics}
    report={'scope':'dev-only pipeline qualification' if spec['qualification'] else 'dev re-ranker evaluation' if rerank else 'dev candidate evaluation',
            'bootstrapUnit':spec['bootstrapUnit'],'dependenceLimit':spec['dependenceLimit'],
            'strata':{'imputed_human_roster':len(spec['families']),'full_human_export':0},
            'arms':arms,'paired':paired,'excluded':excluded,'promotionOrStrengthClaim':False}
    if rerank:
        v=root/'verification.json';div=divergence_report(pairs,divergent,spec['bootstrapReplicates'],spec['analysisSeed'])
        report['divergence']=div
        report.update(adoption(paired,div,verified=v.exists() and json.loads(v.read_text())['status']=='PASS',
                               qualification=spec['qualification'],notRun=sum(e['status']=='not_run_or_no_summary' for e in excluded)))
        if suite:report['tacticalRegressionReport']=suite;inputs[suite['file']]=suite['sha256']
    for name,data in [('analysis.json',report),('analysis-inputs.json',inputs),('process.json',process)]:
        with (root/name).open('x') as f:json.dump(data,f,indent=2,allow_nan=False);f.write('\n')
    for name,data in [('material.csv',material),('paired.csv',pairs)]:
        if data:
            with (root/name).open('x') as f:
                w=csv.DictWriter(f,list(data[0]));w.writeheader();w.writerows(data)
    return report
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root')
    p.add_argument('--tactical',help='loss-turn tactical-suite report (regression report only, never evidence); re-rank cohorts only')
    a=p.parse_args();print(json.dumps(analyze(Path(a.root).resolve(),a.tactical),indent=2))
