"""The diagnostic must use all critics at the policy's primary gamma."""
import unittest
import torch
from critic_returns import primary_value, actor_scores, append_checkpoint, checkpoint_rows, digest, compare_reports


class CriticReturnsTests(unittest.TestCase):
    def test_cross_report_parity_requires_same_inputs_and_actions(self):
        import copy
        a={'diagnosticManifestSha256':'manifest','inputs':[{'sha256':'pov','metaSha256':'meta'}],
           'models':{'candidate':{'checkpointSha256':'model','gamma':.999,'rewardMultiplier':10.,'povs':1,'states':1,
           'rows':[{'_inputIndex':0,'states':1,'won':True,'observedReturns':[10.],'probabilities':[[.51,.49]],'predicted':[9.]}]}}}
        b=copy.deepcopy(a);b['models']['candidate']['rows'][0]['predicted']=[9.00001]
        self.assertTrue(compare_reports(a,b)['pass'])
        b['models']['candidate']['rows'][0]['probabilities']=[[.49,.51]]
        self.assertFalse(compare_reports(a,b)['allArgmaxActionsEqual'])
        b=copy.deepcopy(a);b['inputs'][0]['sha256']='other'
        with self.assertRaises(AssertionError):compare_reports(a,b)

    def test_durable_resume_keeps_partial_record_and_rejects_tampering(self):
        import tempfile, json
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'povs.jsonl'
            row = {'_inputIndex':0, '_inputSha256':'input', '_modelSha256':'model', 'mse':2.}
            append_checkpoint(path,row)
            with path.open('ab') as stream:
                stream.write(b'{"incomplete":')
            original = path.read_bytes()
            rows,partial = checkpoint_rows([path],[{'sha256':'input'}],'model')
            self.assertEqual(rows[0]['mse'],2.)
            self.assertEqual(partial[0]['sha256'],digest(path))
            self.assertEqual(path.read_bytes(),original)
            second = Path(directory)/'next.jsonl'
            append_checkpoint(second,{'_inputIndex':1,'_inputSha256':'next','_modelSha256':'model','mse':3.})
            rows,_ = checkpoint_rows([path,second],[{'sha256':'input'},{'sha256':'next'}],'model')
            self.assertEqual(set(rows),{0,1})
            changed = json.loads(second.read_text()); changed['mse']=99
            second.write_text(json.dumps(changed)+'\n')
            with self.assertRaisesRegex(ValueError,'checksum'):
                checkpoint_rows([second],[{'sha256':'input'},{'sha256':'next'}],'model')

    def test_resume_rejects_duplicate_and_foreign_provenance(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'povs.jsonl'
            append_checkpoint(path,{'_inputIndex':0,'_inputSha256':'input','_modelSha256':'model'})
            with self.assertRaisesRegex(ValueError,'Duplicate'):
                checkpoint_rows([path,path],[{'sha256':'input'}],'model')
            with self.assertRaisesRegex(ValueError,'provenance'):
                checkpoint_rows([path],[{'sha256':'foreign'}],'model')
    def test_primary_gamma_is_last_and_ensemble_is_averaged(self):
        # Native axes: action samples, batch, time, critics, gammas, scalar.
        q = torch.full((1,1,1,2,3,1),20.)
        q[0,0,0,0,-1,0] = 1.
        q[0,0,0,1,-1,0] = 3.
        self.assertEqual(primary_value(q),2.)

    def test_incomplete_or_multiple_timestep_tensors_are_rejected(self):
        for shape in [(1,1,2,3,1),(1,1,2,2,3,1),(2,1,1,2,3,1)]:
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                primary_value(torch.zeros(shape))

    def test_observed_actor_nll_and_top1(self):
        import math
        row = actor_scores([[.8,.2],[.7,.3]],[0,1])
        self.assertAlmostEqual(row['nll'],-(math.log(.8)+math.log(.3))/2)
        self.assertEqual(row['top1'],.5)

    def test_zero_probability_is_counted_and_floor_is_explicit(self):
        import math
        row = actor_scores([[1.,0.]],[1])
        self.assertAlmostEqual(row['nll'],-math.log(1e-12))
        self.assertEqual(row['probabilitiesBelowFloor'],1)

    def test_invalid_distributions_and_action_indices_fail(self):
        for probabilities,actions in [([[.4,.4]],[0]),([[float('nan'),1.]],[0]),
                                     ([[1.,0.]],[2]),([[1.,0.]],[.5])]:
            with self.subTest(probabilities=probabilities,actions=actions), self.assertRaises(ValueError):
                actor_scores(probabilities,actions)


if __name__ == "__main__":
    unittest.main()
