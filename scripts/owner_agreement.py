#!/usr/bin/env python3
"""Owner agreement and outcome per live game, from the live advisor's journals (.local-data/metamon-live/). CPU only.

A game is the owner's unless our side's player name starts with the given test-account prefix (passed at run time so no
account name enters this file). Segments of one battle (a replay after lost sync) are merged; a decision is an advised
request the owner then resolved: a `commit` row, or the `end` row's final choice. `followed` is the companion's current
rule (same action; at team preview, the same lead) recomputed from the journaled action IDs; an `end` row's final choice
keeps its journaled field. Advice is split by `basis`: `sampled` (before the top pick was shown, no basis field), `top`,
`random_preview`, `lead_model`. The result comes only
from an `end` row (`source` marks an owner report); otherwise it is unknown. Player names are never printed.

    python3 scripts/owner_agreement.py JOURNAL_DIR --exclude-player-prefix PREFIX [--json OUT.json]
"""
import argparse
import collections
import json
import re
from pathlib import Path

BASES = ('sampled', 'top', 'random_preview', 'lead_model')


def same_decision(chosen, advised, request):
    """liveMetamon.ts sameDecision: singles preview only picks the lead (unless Illusion follows party order)."""
    if chosen == advised: return True
    a, b = (re.fullmatch(r'team:(\d+)', x or '') for x in (chosen, advised))
    illusion = any('illusion' in (p.get('ability'), p.get('baseAbility')) for p in (request or {}).get('side', {}).get('pokemon', []))
    return bool(a and b and not illusion and a[1][0] == b[1][0])


def choice_label(choice, request):
    """A Showdown choice string in words, from the request it answered."""
    parts = (choice or '').split()
    mons = (request or {}).get('side', {}).get('pokemon', [])
    species = lambda slot: mons[slot - 1]['details'].split(',')[0] if 0 < slot <= len(mons) else f'slot {slot}'
    try:
        if parts[0] == 'move':
            name = request['active'][0]['moves'][int(parts[1]) - 1]['move']
            return f'Tera + {name}' if 'terastallize' in parts else name
        if parts[0] == 'switch': return f'Switch to {species(int(parts[1]))}'
        if parts[0] == 'team': return f'Lead {species(int(parts[1][0]))}'
    except (IndexError, KeyError, ValueError): pass
    return choice or '?'


def read_segment(path):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    start = next(r for r in rows if r['kind'] == 'start')
    names, title, turn, requests = {}, None, 0, {}
    for r in rows:
        if r['kind'] != 'frame': continue
        for line in r['data'].split('\n'):
            f = line.split('|')
            if line.startswith('|player|') and len(f) > 3 and f[3]: names[f[2]] = f[3]
            elif line.startswith('|title|'): title = line[7:]
            elif line.startswith('|turn|'): turn = int(f[2])
            elif line.startswith('|request|'):
                q = json.loads(line[9:])
                if not q.get('wait'): requests[q['rqid']] = (turn, q)
    if start['side'] not in names and title and ' vs. ' in title:  # a segment that never saw |player|
        names.update(zip(('p1', 'p2'), title.split(' vs. ', 1)))
    return rows, start, names.get(start['side']), requests


def battle_of(room):
    return re.match(r'battle-[a-z0-9]+-(\d+)', room)[1]


def summarize(directory, prefix):
    games = collections.defaultdict(list)
    for path in sorted(Path(directory).glob('*.jsonl')):
        rows, start, me, requests = read_segment(path)
        games[battle_of(start['roomId'])].append((path, rows, start, me, requests))
    out, excluded, unclassified = [], 0, []
    for battle, segments in games.items():
        me = next((s[3] for s in segments if s[3]), None)
        if me is None: unclassified.append(battle); continue  # no player name or title: owner or test is unknown
        if me.lower().startswith(prefix.lower()):
            excluded += 1; continue
        advice, commits, requests, result, source, final = {}, {}, {}, None, None, None
        for _, rows, _, _, reqs in segments:
            requests.update(reqs)
            for r in rows:
                if r['kind'] == 'advice': advice[r['rqid']] = r
                elif r['kind'] == 'commit': commits[r['rqid']] = r
                elif r['kind'] == 'end':
                    w = r.get('result')
                    result = 'tie' if w == 'tie' else None if w is None else 'win' if w.get('winner') == me else 'loss'
                    source = r.get('source')
                    if r.get('finalChoice'): final = r
        if final:  # the end row resolves the last advised request the worker never saw committed
            open_rqids = [q for q in advice if q not in commits]
            if open_rqids: commits[max(open_rqids)] = {**final, 'choice': final['finalChoice'], 'rqid': max(open_rqids)}
        decisions = []
        for rqid in sorted(advice):
            a, c = advice[rqid], commits.get(rqid)
            if not c: continue
            turn, request = requests.get(rqid, (None, None))
            # The current rule, not the field journaled at the time (before 2026-10-22 a same-lead preview was "not followed").
            followed = same_decision(c['actionId'], a['actionId'], request) if c.get('actionId') else c.get('followed')
            if followed is None: raise SystemExit(f'battle {battle} rqid {rqid}: resolved without an action or followed field')
            decisions.append({'rqid': rqid, 'turn': turn, 'basis': a.get('basis') or 'sampled', 'followed': bool(followed),
                              **({'journalFollowed': c['followed']} if 'followed' in c and c['followed'] != followed else {}),
                              'advised': a.get('label'), 'probability': a.get('probability'), 'chose': choice_label(c.get('choice'), request)})
        by = {b: [d for d in decisions if d['basis'] == b] for b in BASES}
        unknown = sorted({d['basis'] for d in decisions} - set(BASES))
        if unknown: raise SystemExit(f'battle {battle}: unknown advice basis {unknown}')
        out.append({'battle': battle, 'side': segments[0][2]['side'], 'started': segments[0][2]['at'], 'segments': len(segments),
                    'stops': [r.get('reason') for _, rows, *_ in segments for r in rows if r['kind'] == 'stop'],
                    'advised': len(advice), 'decisions': len(decisions), 'followed': sum(d['followed'] for d in decisions),
                    'byBasis': {b: [sum(d['followed'] for d in ds), len(ds)] for b, ds in by.items()},
                    'result': result, 'resultSource': source, 'deviations': [d for d in decisions if not d['followed']]})
    return {'games': sorted(out, key=lambda g: g['started']), 'excludedTestGames': excluded, 'unclassified': unclassified}


def markdown(report):
    rate = lambda f, n: f'{f}/{n} ({100 * f / n:.0f}%)' if n else '-'
    lines = ['| battle | started (UTC) | side | segments | decisions | followed | sampled | top | random_preview | lead_model | result |',
             '|---|---|---|---|---|---|---|---|---|---|---|']
    total = collections.Counter()
    for g in report['games']:
        res = (g['result'] or 'unknown') + (' (owner report)' if g['resultSource'] else '')
        lines.append(f"| {g['battle']} | {g['started'][:16]} | {g['side']} | {g['segments']} | {g['decisions']} of {g['advised']} advised | "
                     f"{rate(g['followed'], g['decisions'])} | " + ' | '.join(rate(*g['byBasis'][b]) for b in BASES) + f' | {res} |')
        total['d'] += g['decisions']; total['f'] += g['followed']
        for b in BASES: total[b + 'f'] += g['byBasis'][b][0]; total[b + 'n'] += g['byBasis'][b][1]
    lines.append(f"| **all** | | | | {total['d']} | {rate(total['f'], total['d'])} | " + ' | '.join(rate(total[b + 'f'], total[b + 'n']) for b in BASES) + ' | |')
    lines += ['', f"Excluded test-account games: {report['excludedTestGames']}. Unclassified (no player name): {len(report['unclassified'])}"
              + (f" {report['unclassified']}" if report['unclassified'] else '') + '.', '', '## Deviations', '']
    for g in report['games']:
        for d in g['deviations']:
            p = f" ({100 * d['probability']:.0f}%)" if isinstance(d['probability'], (int, float)) and d['basis'] == 'sampled' else ''
            lines.append(f"- {g['battle']} T{d['turn']} rqid {d['rqid']} [{d['basis']}]: advised {d['advised']}{p} -> chose {d['chose']}")
    return '\n'.join(lines)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('journals'); p.add_argument('--exclude-player-prefix', required=True); p.add_argument('--json')
    a = p.parse_args()
    report = summarize(a.journals, a.exclude_player_prefix)
    if a.json: Path(a.json).write_text(json.dumps(report, indent=1) + '\n')
    print(markdown(report))
