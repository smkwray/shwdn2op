"""The power path uses the registered paired law and canonical inference kernel."""
from fractions import Fraction
import unittest

import numpy as np

from campaign_inference import exact_e
from campaign_power import difference_probabilities, prefix_log_e


class PowerTest(unittest.TestCase):
    def test_joint_difference_law_and_no_clipping(self):
        baseline = np.asarray([.2, .5, .8]); effect = np.asarray([-.1, .08, .1])
        for shared in [0., .5, .9, 1.]:
            positive, negative = difference_probabilities(baseline, effect, shared)
            np.testing.assert_allclose(positive-negative, effect, atol=1e-15)
            self.assertTrue(np.all(positive >= 0) and np.all(negative >= 0))
        with self.assertRaises(ValueError):
            difference_probabilities(baseline, np.ones(3), .5)
        with self.assertRaises(ValueError):
            difference_probabilities(np.asarray([float('nan')]), np.asarray([0.]), .5)

    def test_selected_power_kernel_against_exact_rational_mixture(self):
        values = np.asarray([[.1, -.2, .4, 0.], [-1., 1., -.5, .5]])
        margin = Fraction(25001, 500000)
        logs = prefix_log_e(values, [2, 4], float(margin))
        for row in range(2):
            for column, n in enumerate([2, 4]):
                exact = exact_e(tuple(Fraction(str(x)) for x in values[row, :n]), margin)
                self.assertAlmostEqual(float(np.exp(logs[row, column])), float(exact), places=13)


if __name__ == '__main__':
    unittest.main()
