"""Fixed-N bounded family inference; component only, no campaign admission.

For independent X_i in [-1,1], possibly with different means, freeze N and
constant c values before results. For m > -1, E_c(m)=prod(1+c*(X_i-m)/(1+m)).
Nonnegative factors and independence give E[E_c(m)] <= 1 whenever the average
mean <= m, by AM-GM. A fixed mixture preserves this bound. Markov's inequality
therefore gives an alpha test at E(m)>1/alpha; monotonic inversion gives an LCB.
This is NOT an optional-stopping guarantee for heterogeneous family means.

Betting background: https://doi.org/10.1093/jrsssb/qkad009 . The heterogeneous
fixed-N argument above is our explicit derivation, not a claim from that paper.
Roster/seed independence, complete planned families, exposure integration and
actual-design power qualification remain separate mandatory campaign gates.
"""
from fractions import Fraction
import math

C = tuple(map(Fraction, ('1/20', '1/10', '1/5', '2/5', '3/5', '4/5', '19/20')))


def exact_e(values, margin):
    """Exact arithmetic is the authority for every reported rejection/bound."""
    return sum((math.prod(1+c*(x-margin)/(1+margin) for x in values)
                for c in C), Fraction()) / len(C)


def log_e(values, margin):
    terms = [math.fsum(math.log1p(float(c)*(float(x)-margin)/(1+margin))
                       for x in values) for c in C]
    peak = max(terms)
    return peak + math.log(math.fsum(math.exp(x-peak) for x in terms)/len(C))


def infer(families, alpha, margin=Fraction(1, 20)):
    if (not isinstance(families, dict) or len(families)<2
            or any(not isinstance(k, str) or not k for k in families)
            or any(type(v) is not Fraction or not -1<=v<=1 for v in families.values())
            or type(alpha) is not Fraction or not 0<alpha<1
            or type(margin) is not Fraction or not -1<margin<1):
        raise ValueError('Complete exact bounded family means and rational alpha/margin required')
    values = tuple(families[k] for k in sorted(families))
    threshold = 1/alpha
    lo, hi = -1+2**-40, 1.
    for _ in range(48):
        mid = (lo+hi)/2
        if log_e(values, mid)>math.log(float(threshold)):lo=mid
        else:hi=mid
    # Floating point proposes a bound only. Exact monotone inversion checks it.
    lower = Fraction(math.floor(lo*10**6), 10**6)
    for _ in range(16):
        if lower<=-1:
            lower=Fraction(-1);break
        if exact_e(values, lower)>threshold:break
        lower-=Fraction(1, 10**6)
    else:raise ArithmeticError('Exact confidence-bound validation failed')
    reject = exact_e(values, margin)>threshold
    return dict(method='fixed-N constant-bet mixture; exact checked', families=len(values),
                mean=str(sum(values)/len(values)), alpha=str(alpha), margin=str(margin),
                lowerBound=str(lower), exactMarginReject=reject,
                passResult=reject and lower>margin,
                status='COMPONENT_ONLY_NOT_CAMPAIGN_ADMISSION')
