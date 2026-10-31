"""Join recorded-choice verification after a deadline; retain the failed attempt."""
import hashlib
import json
from pathlib import Path

INPUTS = {'summary.json','replay-inputs.json','trajectory.jsonl','replay.log',
          'p1-private.jsonl','p2-private.jsonl'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def combine(original, extension, out):
    original, extension, out = map(Path, (original, extension, out))
    old, new = (json.loads(p.read_bytes()) for p in (original, extension))
    if (old['pass'] is not False or new['pass'] is not True or old['modelCalls'] or new['modelCalls']
            or old['censoredRawRetainedGames'] or new['censoredRawRetainedGames']
            or old['verifierSha256'] != new['verifierSha256'] or out.exists()):
        raise ValueError('Explicit failed deadline attempt and unchanged exact verifier required')
    prior = {Path(r['game']).name:r for r in old['rows']}
    repaired = {Path(r['game']).name:r for r in new['rows']}
    missing = {name for name,r in prior.items() if r['returncode'] != 0}
    if (len(prior)!=old['games'] or len(repaired)!=new['games']
            or not missing or set(repaired)!=missing
            or old['verifiedCompletedGames']!=len(prior)-len(missing)
            or new['verifiedCompletedGames']!=len(missing)):
        raise ValueError('Every failed game, and only those same games, must be verified')
    rows, failures = [], []
    for name,row in prior.items():
        game=Path(row['game'])
        if set(row['inputs'])!=INPUTS or any(sha(game/key)!=digest for key,digest in row['inputs'].items()):
            raise ValueError('Original replay inputs changed')
        if name in repaired:
            fresh=repaired[name]; copy=Path(fresh['game']); marker=game/'native-replay-failure-r2.json'
            failure=json.loads(marker.read_bytes())
            if (failure['status']!='truncated' or not failure['errors']
                    or any(r['stage']!='harness' or r['message']!='Match deadline expired.'
                           for r in failure['errors']) or fresh['returncode']!=0
                    or fresh['inputs']!=row['inputs']
                    or any(sha(copy/key)!=digest for key,digest in row['inputs'].items())
                    or (game/'native-replay.json').exists()):
                raise ValueError('Only unchanged recorded inputs after a retained deadline qualify')
            proof=copy/'native-replay.json'
            failures.append(dict(game=name,originalReturncode=row['returncode'],
                                 failureMarkerSha256=sha(marker)))
            updated={**row, 'game':str(copy), 'returncode':0, 'proofSha256':fresh['proofSha256'],
                     'reverification':dict(originalReportSha256=sha(original),
                                          extensionReportSha256=sha(extension),
                                          originalGame=str(game),
                                          originalReturncode=row['returncode'])}
            rows.append(updated)
        else:
            proof=game/'native-replay.json';rows.append(row)
        value=json.loads(proof.read_bytes())
        if (sha(proof)!=rows[-1]['proofSha256']
                or value['status']!='PASS_EXACT_RECORDED_CHOICE_NATIVE_REPLAY'
                or value['modelOrNNCalls']!=0
                or value['publicAndBothPrivateTracesEqualExceptWallclock'] is not True):
            raise ValueError('Canonical exact public/private zero-NN proof required')
    # Positive extension proofs stay with their exact-input copies. The original
    # failed directories, timeout markers, logs and reports are never written.
    result={**old, 'pass':True, 'verifiedCompletedGames':len(rows), 'rows':rows,
            'producerSha256':sha(__file__), 'priorFailureReport':str(original),
            'priorFailureReportSha256':sha(original), 'extensionReport':str(extension),
            'extensionReportSha256':sha(extension), 'retainedDeadlineFailures':failures,
            'newGames':0, 'replacementGames':0, 'originalFailureRemainsFailed':True}
    with out.open('x') as stream:json.dump(result,stream,indent=2);stream.write('\n')
    return result
