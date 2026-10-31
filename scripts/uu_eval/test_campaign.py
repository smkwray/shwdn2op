"""Campaign writer qualification uses synthetic hashes and never opens real panels."""
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from campaign import BINDINGS, Ledger, alpha, sha
import campaign

REAL_RULE = campaign.PROJECT / 'do/certification/campaign-rule.json'  # private; absent in a public clone
TORCH = importlib.util.find_spec('torch') is not None


class Reservations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'attempts'
        self.history = self.root.parent/'historical-uses.json'
        self.history.write_text(json.dumps(dict(schema='uu-certification-historical-uses@1', uses=[])))
        self.rule = dict(schema='uu-certification-campaign-rule@1', status='QUALIFIED_CAMPAIGN',
                         familywiseAlpha=.05, canonicalLedger=dict(
                             path=str(self.root),
                             historicalUses=dict(path=str(self.history), sha256=sha(self.history)),
                             singleControllerBinding=hashlib.sha256(b'controller').hexdigest(),
                             ledgerProducer=sha(campaign.__file__)))
        self.bindings = {k: '1'*64 for k in BINDINGS}

    def ledger(self, controller='controller'):
        return Ledger(self.root, self.rule, controller)

    def test_unqualified_rule_holds_before_any_ledger_write(self):
        # Matters: a registered but unqualified rule must never write a reservation, whatever else it binds.
        rule = dict(self.rule, status='REGISTERED_RULE_ASSETS_AND_IMPLEMENTATION_UNQUALIFIED')
        with self.assertRaisesRegex(RuntimeError, 'CAMPAIGN_HOLD'):
            Ledger(self.root, rule, 'controller').reserve('heldout', 'a'*64, self.bindings)
        self.assertFalse(self.root.exists())

    @unittest.skipUnless(REAL_RULE.is_file(), 'private campaign rule not present in this checkout')
    def test_current_real_rule_holds_before_any_ledger_write(self):
        rule = json.loads(REAL_RULE.read_bytes())
        with self.assertRaisesRegex(RuntimeError, 'CAMPAIGN_HOLD'):
            Ledger(self.root, rule).reserve('heldout', 'a'*64, self.bindings)
        self.assertFalse(self.root.exists())

    def test_wrong_controller_cannot_create_or_consume(self):
        with self.assertRaisesRegex(RuntimeError, 'CAMPAIGN_HOLD'):
            self.ledger('other').reserve('heldout', 'a'*64, self.bindings)
        self.assertFalse(self.root.exists())

    def test_different_output_directory_cannot_reset_campaign(self):
        other = self.root.with_name('renamed-output')
        with self.assertRaisesRegex(RuntimeError, 'canonical ledger directory'):
            Ledger(other, self.rule, 'controller').reserve('heldout', 'a'*64, self.bindings)
        self.assertFalse(other.exists())

    def test_candidate_stage_is_deduplicated_across_bindings(self):
        self.ledger().reserve('dev', 'a'*64, self.bindings)
        with self.assertRaisesRegex(ValueError, 'already reserved'):
            self.ledger().reserve('dev', 'a'*64, {k:'2'*64 for k in BINDINGS})
        self.assertEqual(self.ledger().reserve('heldout', 'a'*64, self.bindings)['attemptIndex'], 1)

    def test_global_alpha_does_not_reset_for_another_candidate(self):
        a = self.ledger().reserve('heldout', 'a'*64, self.bindings)
        b = self.ledger().reserve('heldout', 'b'*64, {**self.bindings, 'modelWeights':'2'*64})
        self.assertEqual((a['alpha'], b['alpha']), ('1/40', '1/120'))
        self.assertEqual(sum((alpha(k) for k in range(1, 10001)), Fraction()),
                         Fraction(1,20)-Fraction(1,200020))

    def test_concurrent_duplicate_consumes_exactly_once(self):
        def attempt(_):
            try:
                self.ledger().reserve('heldout', 'a'*64, self.bindings)
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(attempt, range(2))), 1)
        self.assertEqual(len(json.loads((self.root/'ledger.json').read_bytes())['reservations']), 1)

    def test_corrupt_history_is_not_reset(self):
        self.ledger().reserve('heldout', 'a'*64, self.bindings)
        path = self.root/'ledger.json'
        data = json.loads(path.read_bytes());data['reservations'][0]['alpha']='1/20'
        path.write_text(json.dumps(data));before=path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'history malformed'):
            self.ledger().reserve('heldout', 'b'*64, self.bindings)
        self.assertEqual(path.read_bytes(), before)

    def test_incomplete_bindings_cannot_consume(self):
        with self.assertRaises(ValueError):
            self.ledger().reserve('heldout', 'a'*64, {})
        self.assertFalse(self.root.exists())

    def test_unknown_historical_stage_cannot_hide_an_alpha_allocation(self):
        self.ledger().reserve('heldout', 'a'*64, self.bindings)
        path = self.root/'ledger.json';data=json.loads(path.read_bytes())
        data['reservations'][0]['stage']='unknown';path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'history malformed'):
            self.ledger().reserve('heldout', 'b'*64, self.bindings)

    def test_imported_legacy_uses_block_reuse_without_spending_future_alpha(self):
        self.history.write_text(json.dumps(dict(schema='uu-certification-historical-uses@1', uses=[
            dict(candidateSha256='a'*64, stage='heldout', receiptSha256='3'*64,
                 modelWeightsSha256='1'*64)])))
        self.rule['canonicalLedger']['historicalUses']['sha256']=sha(self.history)
        with self.assertRaisesRegex(ValueError, 'already reserved'):
            self.ledger().reserve('heldout', 'a'*64, self.bindings)
        row=self.ledger().reserve('heldout', 'b'*64, {**self.bindings, 'modelWeights':'2'*64})
        self.assertEqual((row['attemptIndex'],row['alpha']),(1,'1/40'))

    @unittest.skipUnless(TORCH, 'needs torch')
    def test_reserialized_tensor_alias_cannot_reset_either_stage(self):
        import torch
        root=Path(self.temp.name)
        a,b=root/'epoch_1.pt',root/'epoch_2.pt'
        state={'actor':torch.tensor([[1.,2.],[3.,4.]]), 'counter':torch.tensor(7)}
        torch.save(state,a);torch.save(dict(reversed(list(state.items()))),b)
        first,second=campaign.model_weights(a),campaign.model_weights(b)
        self.assertNotEqual(first['checkpointSha256'],second['checkpointSha256'])
        self.assertEqual(first['modelWeightsSha256'],second['modelWeightsSha256'])
        bindings={**self.bindings,'modelWeights':first['modelWeightsSha256']}
        for stage in ['dev','heldout']:
            self.ledger().reserve(stage,first['checkpointSha256'],bindings)
            with self.assertRaisesRegex(ValueError,'already reserved'):
                self.ledger().reserve(stage,second['checkpointSha256'],bindings)
        state['actor'][0,0]+=1;torch.save(state,b)
        changed=campaign.model_weights(b)['modelWeightsSha256']
        self.assertNotEqual(changed,first['modelWeightsSha256'])
        state['actor']=state['actor'].double();torch.save(state,b)
        self.assertNotEqual(campaign.model_weights(b)['modelWeightsSha256'],changed)

    def test_same_file_cannot_declare_different_tensor_identity(self):
        self.ledger().reserve('dev','a'*64,self.bindings)
        with self.assertRaisesRegex(ValueError,'tensor identity changed'):
            self.ledger().reserve('heldout','a'*64,{**self.bindings,'modelWeights':'2'*64})

    @unittest.skipUnless(TORCH, 'needs torch')
    def test_ensemble_renames_and_reserialization_preserve_identity(self):
        import torch
        root=Path(self.temp.name);manifests=[]
        for alias in ['first','renamed']:
            rows=[]
            for i in range(3):
                p=root/f'{alias}-{i}.pt';torch.save({'actor':torch.tensor([float(i)])},p)
                rows.append(dict(name=f'{alias}-{i}',path=str(p),epoch=i,sha256=sha(p)))
            p=root/(alias+'.json');p.write_text(json.dumps(rows));manifests.append(p)
        identities=[campaign.policy_identity('ensemble',p,sha(p)) for p in manifests]
        self.assertNotEqual(identities[0]['checkpointSha256'],identities[1]['checkpointSha256'])
        self.assertEqual(identities[0]['modelWeightsSha256'],identities[1]['modelWeightsSha256'])
        rows[2]=rows[0];p.write_text(json.dumps(rows))
        with self.assertRaisesRegex(ValueError,'distinct tensor identities'):
            campaign.policy_identity('ensemble',p,sha(p))

    def test_history_missing_tensor_identity_holds_before_any_write(self):
        self.history.write_text(json.dumps(dict(schema='uu-certification-historical-uses@1',uses=[
            dict(candidateSha256='a'*64,stage='heldout',receiptSha256='3'*64)])))
        self.rule['canonicalLedger']['historicalUses']['sha256']=sha(self.history)
        with self.assertRaises(ValueError):self.ledger().reserve('heldout','b'*64,self.bindings)
        self.assertFalse(self.root.exists())

    def test_historical_tensor_alias_blocks_a_new_file_hash(self):
        self.history.write_text(json.dumps(dict(schema='uu-certification-historical-uses@1',uses=[
            dict(candidateSha256='a'*64,stage='heldout',receiptSha256='3'*64,
                 modelWeightsSha256=self.bindings['modelWeights'])])))
        self.rule['canonicalLedger']['historicalUses']['sha256']=sha(self.history)
        with self.assertRaisesRegex(ValueError,'already reserved'):
            self.ledger().reserve('heldout','b'*64,self.bindings)
        self.assertFalse((self.root/'ledger.json').exists())


if __name__ == '__main__':
    unittest.main()
