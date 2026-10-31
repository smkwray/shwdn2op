"""Preview choice uses the declared policy without changing the default RNG path."""
import random
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from batch_server import preview_choice


class PreviewChoiceTests(unittest.TestCase):
    def test_learned_argmax_preserves_rng_and_native_party_order(self):
        rng=random.Random(123);state=rng.getstate()
        lead=SimpleNamespace(predict=lambda *args:{"status":"ok","leadProbabilities":[.1,.1,.1,.5,.1,.1]})
        self.assertEqual(preview_choice(rng,object(),{},lead),{"kind":"team","team":[4,1,2,3,5,6]})
        self.assertEqual(rng.getstate(),state)

    def test_missing_or_malformed_prediction_never_becomes_random(self):
        for prediction in ({"status":"missing"},{"status":"ok","leadProbabilities":[1.]},
                           {"status":"ok","leadProbabilities":[float('nan')]*6}):
            with self.subTest(prediction=prediction),self.assertRaises(ValueError):
                preview_choice(random.Random(123),object(),{},SimpleNamespace(predict=lambda *args:prediction))

    def test_default_is_the_original_seeded_permutation(self):
        expected=list(range(1,7));reference=random.Random(123);reference.shuffle(expected)
        actual=random.Random(123)
        self.assertEqual(preview_choice(actual,object(),{}),{"kind":"team","team":expected})
        self.assertEqual(actual.getstate(),reference.getstate())

    def test_tied_nonfirst_lead_keeps_all_remaining_slots_in_native_order(self):
        # A last-slot Illusion disguise depends on all six slots, not just the lead.
        lead=SimpleNamespace(predict=lambda *args:{"status":"ok","leadProbabilities":[0,.5,0,.5,0,0]})
        rng=random.Random(9);before=rng.getstate()
        self.assertEqual(preview_choice(rng,object(),{},lead)["team"],[2,1,3,4,5,6])
        self.assertEqual(rng.getstate(),before)
        sys.path.insert(0,str(Path(__file__).parents[1]/"uu_eval"))
        from ensemble_worker import team_preview
        self.assertEqual(team_preview(lead,object(),{}),"/team 213456")
        from native_legal import team_preview as native_preview
        self.assertEqual(native_preview(lead,SimpleNamespace(_last_request={})),"/team 213456")


if __name__=='__main__':unittest.main()
