"""Synthetic inference qualification; no real family assets or outcomes."""
from fractions import Fraction as F
import itertools
import math
import unittest
from campaign_inference import exact_e, infer


class FixedFamilyInference(unittest.TestCase):
    def test_heterogeneous_independent_null_exhaustive(self):
        for margin in (F(), F(1,20)):
            probabilities=tuple(p+margin/2 for p in map(F, ('1/10','9/10','1/5','4/5','3/10','7/10','2/5','3/5')))
            expectation=F();rejection=F()
            for outcomes in itertools.product((-1,1), repeat=8):
                weight=math.prod(p if x==1 else 1-p for p,x in zip(probabilities,outcomes))
                e=exact_e(outcomes,margin)
                expectation+=weight*e
                if e>4:rejection+=weight
            self.assertLessEqual(expectation,1)
            self.assertLessEqual(rejection,F(1,4))

    def test_bound_is_exact_checked_and_permutation_invariant(self):
        values={str(i):F(3,25) for i in range(128)}
        result=infer(values,F(1,40))
        self.assertTrue(result['passResult'])
        lower=F(result['lowerBound'])
        self.assertGreater(exact_e(values.values(),lower),40)
        self.assertLess(lower,F(3,25))
        self.assertEqual(infer(dict(reversed(list(values.items()))),F(1,40)),result)
        self.assertFalse(infer({'a':F(-1),'b':F(-1)},F(1,40))['passResult'])

    def test_missing_nonfinite_or_nonexact_values_refused(self):
        for values in ({},{'a':F(0)},{'a':F(0),'b':float('nan')},
                       {'a':F(0),'b':.5},{'a':F(0),'b':F(2)}):
            with self.assertRaises(ValueError):infer(values,F(1,40))


if __name__=='__main__':unittest.main()
