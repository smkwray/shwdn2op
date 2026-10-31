"""Recorded-input recovery cannot hide a failure or replace a game."""
import json
from pathlib import Path
import tempfile
import unittest
from replay_extension import combine,sha,INPUTS


class ReplayExtension(unittest.TestCase):
    def test_input_drift_refused_before_proof_write_then_exact_extension_keeps_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);game=root/'original'/'game';copy=root/'copy'/'game'
            game.mkdir(parents=True);copy.mkdir(parents=True)
            for p in (game,copy):
                for name in INPUTS:(p/name).write_text('immutable')
            failure=game/'native-replay-failure-r2.json'
            failure.write_text(json.dumps(dict(status='truncated',errors=[dict(stage='harness',message='Match deadline expired.')])) )
            proof=copy/'native-replay.json'
            proof.write_text(json.dumps(dict(status='PASS_EXACT_RECORDED_CHOICE_NATIVE_REPLAY',modelOrNNCalls=0,publicAndBothPrivateTracesEqualExceptWallclock=True)))
            row=dict(game=str(game),returncode=1,inputs={name:sha(game/name) for name in INPUTS},proofSha256=None)
            kept=root/'original'/'kept';kept.mkdir()
            for name in INPUTS:(kept/name).write_text('immutable')
            (kept/'native-replay.json').write_bytes(proof.read_bytes());kept_hash=sha(kept/'native-replay.json')
            passed={**row,'game':str(kept),'returncode':0,'proofSha256':kept_hash}
            old=dict(pass_=False,games=2,verifiedCompletedGames=1,rows=[passed,row],modelCalls=0,censoredRawRetainedGames=0,verifierSha256='1'*64)
            old['pass']=old.pop('pass_');original=root/'old.json';original.write_text(json.dumps(old));original_hash=sha(original);failure_hash=sha(failure)
            new={**old,'pass':True,'games':1,'verifiedCompletedGames':1,'rows':[{**row,'game':str(copy),'returncode':0,'proofSha256':sha(proof)}]}
            extension=root/'extension.json';extension.write_text(json.dumps(new));out=root/'combined.json'
            (copy/'trajectory.jsonl').write_text('changed')
            with self.assertRaisesRegex(ValueError,'unchanged'):combine(original,extension,out)
            self.assertFalse((game/'native-replay.json').exists());self.assertFalse(out.exists())
            (copy/'trajectory.jsonl').write_text('immutable');result=combine(original,extension,out)
            self.assertTrue(result['pass']);self.assertEqual(result['replacementGames'],0)
            self.assertEqual((sha(original),sha(failure)),(original_hash,failure_hash))
            self.assertEqual(result['retainedDeadlineFailures'][0]['originalReturncode'],1)
            self.assertFalse((game/'native-replay.json').exists())
            self.assertEqual(result['rows'][1]['game'],str(copy))
            self.assertEqual(sha(kept/'native-replay.json'),kept_hash)
            self.assertEqual(result['verifiedCompletedGames'],2)


if __name__=='__main__':unittest.main()
