"""Dev-only preregistration; both arms are expansions of one immutable slot list."""
import copy
import hashlib
import json
from pathlib import Path

BASE_SHA = '7e7474d5b2ec6624afdeb29a7cf1dc5c84817d5aee8ec39c1d35a153b18df26c'
WORKER_SHA = '170fa1cb954ca2189066f69f5c96b8548c6c65291cf77a3b251e731fb3a75107'
# The device-local roster pool a real cohort registers; tests use the synthetic fixtures/team-pool instead.
TEAM_POOL = Path(__file__).resolve().parents[2]/'.local-data/uu-team-pool-v1'
# Re-ranker arm: base Kakuna weights + metamon-rerank@2 over the tactical guards (penalty decision: zero mass for a
# rules-certain failure, tactical flags capped jointly at τ). The versions are what a
# re-rank cohort registers and verify.py checks every trace row against; they must equal the companion's RERANKER_VERSION
# and GUARDS_VERSION (test_eval pins that), so a guard change re-registers here before a new cohort.
RERANK_POLICY = 'metamon:Kakuna:epoch34+rerank@2'
RERANKER_VERSION = 'metamon-rerank@2'
GUARDS_VERSION = 'tactical-guards@6'
FLAG_KINDS = ('delayed_slot_occupied', 'pre_move_ko', 'setup_dead_end', 'switch_into_ko')

def is_rerank(spec):
    """Cohort kind: B1 = base weights + re-ranker. Otherwise (no kind) B1 = an exported UUFinetuned candidate."""
    return spec['candidate'].get('kind') == 'rerank'

def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def slot_seed(slot):
    key = f"{slot['seedFamily']}:{slot['stratum']}:{slot['seat']}:{','.join(map(str,slot['seed']))}"
    return int.from_bytes(hashlib.sha256(key.encode()).digest()[:4], 'big') >> 1

def side_seed(seed, side):
    return int.from_bytes(hashlib.sha256(f'{seed}:{side}'.encode()).digest()[:4], 'big') >> 1

def dev_families(pool):
    m = json.loads((pool/'manifest.json').read_text())
    dev = sorted((f for f in m['families'] if f['split'] == 'dev'), key=lambda f:f['sha256'])
    assert len(dev) >= 3, 'Need three dev families'
    result = []
    for f in dev:
        path = (pool/f['representative']).resolve()
        assert path.is_relative_to((pool/'teams/uu_dev_v1').resolve()), 'DEV_ONLY'
        result.append(dict(family=f['sha256'], key=f['key'], teamFile=str(path), teamSha256=sha(path),
                           stratum='imputed_human_roster', split='dev'))
    assert len({f['family'] for f in result}) == len(result)
    return result

def games_for(slots):
    games = []
    for i, slot in enumerate(slots):
        for arm in (('B0','B1') if i % 2 == 0 else ('B1','B0')):
            games.append({**copy.deepcopy(slot), 'arm':arm, 'gameID':slot['slotID']+'-'+arm})
    return games

def seed_design(plan):
    if plan is None:return 'uu-dev-v1', [[43,37,19,7], [71,53,29,11]]
    assert isinstance(plan,dict) and set(plan)=={'schema','namespace','vectors'}, 'SEED_PLAN_FIELDS'
    assert plan['schema']=='uu-eval-seeds@1', 'SEED_PLAN_SCHEMA'
    namespace=plan['namespace'];vectors=plan['vectors']
    assert isinstance(namespace,str) and namespace.isascii() and namespace.replace('-','').replace('_','').isalnum(), 'SEED_PLAN_NAMESPACE'
    assert isinstance(vectors,list) and vectors, 'SEED_PLAN_VECTORS'
    assert all(isinstance(v,list) and len(v)==4 and all(type(x) is int and 0<=x<65536 for x in v) for v in vectors), 'SEED_PLAN_NATIVE_VECTOR'
    assert len({tuple(v) for v in vectors})==len(vectors), 'SEED_PLAN_DUPLICATE_VECTOR'
    return namespace,vectors

def build(pool, qualification=False, validate_result=True, seed_plan=None):
    namespace,seeds=seed_design(seed_plan)
    families = dev_families(pool)
    slots = []
    # Ring offsets are two permutations: every family is home twice and opponent twice.
    for i, home in enumerate(families):
        for offset in (1, 2):
            opponent = families[(i+offset) % len(families)]
            for seat in ('p1','p2'):
                for j, seed in enumerate(seeds):
                    other = 'p2' if seat == 'p1' else 'p1'
                    s = dict(slotID=f'slot-{len(slots):04d}', family=home['family'],
                             opponentFamily=opponent['family'], assignment=offset,
                             seat=seat, seed=list(seed), seedFamily=f'{namespace}-seed{j+1}',
                             stratum=home['family']+'-opp'+str(offset),
                             teamFiles={seat:home['teamFile'], other:opponent['teamFile']},
                             teamSha256={seat:home['teamSha256'], other:opponent['teamSha256']})
                    s['workerSeed'] = slot_seed(s)
                    s['sideSeeds'] = {side:side_seed(s['workerSeed'],side) for side in ('p1','p2')}
                    slots.append(s)
    if qualification:
        # Two home families, one assignment, both seats, one seed = four paired slots.
        slots = [s for s in slots if s['family'] in [f['family'] for f in families[:2]]
                 and s['assignment']==1 and s['seedFamily']==f'{namespace}-seed1']
    spec = dict(schema='uu-paired-slot@1', split='dev', qualification=qualification,
                poolManifestSha256=sha(pool/'manifest.json'), families=families,
                opponentAssignment='families sorted by SHA256; ring offsets +1,+2 modulo N; no self-match',
                bootstrapUnit='home source-roster family; all assignments/seats/seeds kept together',
                bootstrapReplicates=10000, analysisSeed=20261020,
                dependenceLimit='Fixed dev panel inference conditional on opponents; opponents recur across clusters.',
                exclusions=['infrastructure failure, crash, timeout, turn cap: missing/censored; never impute terminal',
                            'no retries or replacement slots; incomplete pairs excluded only from paired statistics',
                            'legality, provenance, replay or unload failures prohibit qualification'],
                slots=slots, games=games_for(slots),
                fullDevSlotsPerArm=len(families)*4*len(seeds))
    if seed_plan is not None:spec['seedPlan']=copy.deepcopy(seed_plan)
    if validate_result:validate(spec, pool)
    return spec

def validate(spec, pool):
    assert spec['split']=='dev', 'DEV_ONLY'
    assert 'seedPlan' not in spec or isinstance(spec['seedPlan'],dict), 'SEED_PLAN_OBJECT'
    assert spec['poolManifestSha256']==sha(pool/'manifest.json'), 'POOL_DRIFT'
    expected=build(pool,spec['qualification'],False,spec.get('seedPlan'))
    assert spec['slots']==expected['slots'], 'PREREGISTERED_SLOT_DESIGN_DRIFT'
    assert spec['fullDevSlotsPerArm']==expected['fullDevSlotsPerArm'], 'PREREGISTERED_SLOT_COUNT_DRIFT'
    families = dev_families(pool)
    assert spec['families']==families, 'FAMILY_DRIFT_OR_HELD_OUT'
    assert spec['games']==games_for(spec['slots']), 'ARMS_MUST_SHARE_SLOTS_TEAMS_SEEDS_AND_ORDER'
    assert len({s['slotID'] for s in spec['slots']})==len(spec['slots']), 'DUPLICATE_SLOT'
    byid={f['family']:f for f in families}
    for s in spec['slots']:
        assert s['family'] in byid and s['opponentFamily'] in byid, 'HELD_OUT_OR_UNKNOWN_FAMILY'
        assert s['workerSeed']==slot_seed(s) and s['sideSeeds']=={side:side_seed(slot_seed(s),side) for side in ('p1','p2')}, 'SEED_DRIFT'
        for side,family in [(s['seat'],s['family']),('p2' if s['seat']=='p1' else 'p1',s['opponentFamily'])]:
            assert s['teamFiles'][side]==byid[family]['teamFile'], 'DEV_TEAM_BINDING'
            assert s['teamSha256'][side]==sha(s['teamFiles'][side])==byid[family]['teamSha256'], 'TEAM_DRIFT'
    return spec
