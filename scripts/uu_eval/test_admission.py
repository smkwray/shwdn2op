"""Admission regression against a retained server-rejected trapped switch."""
import copy
import json
from pathlib import Path
import zipfile
import tempfile
import unittest

from analyze import rows, trajectory_admitted, private_material


class CampaignHold(unittest.TestCase):
    def test_legacy_preparation_cannot_open_another_certification_panel(self):
        from types import SimpleNamespace
        from evaluate import prepare, require_qualification
        with self.assertRaisesRegex(RuntimeError,'CERTIFICATION_CAMPAIGN_HOLD'):
            prepare(SimpleNamespace(qualification=False))
        require_qualification(True)


class TrappedRetryAdmission(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).with_name('fixtures') / 'trapped-switch.zip'
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'game'
        self.directory.mkdir()
        with zipfile.ZipFile(source) as archive:
            archive.extractall(self.directory)
        self.trajectory = list(rows(self.directory / 'trajectory.jsonl'))
        self.verification = json.loads((self.directory / 'verification-row.json').read_text())
        self.rejected = next(i for i, row in enumerate(self.trajectory) if not row['accepted'])

    def admitted(self):
        return trajectory_admitted(self.directory, self.trajectory, self.verification)

    def test_retained_verified_retry_is_admitted(self):
        self.assertEqual(sum(not row['accepted'] for row in self.trajectory), 2)
        self.assertTrue(self.admitted())

    def test_retry_preserves_one_material_boundary_per_turn(self):
        starts, _ = private_material(self.directory / 'p1-private.jsonl', 'p1')
        self.assertEqual(set(starts), set(range(1, 29)))

    def test_repeated_material_request_must_match_rqid_and_hp(self):
        source = (self.directory / 'p1-private.jsonl').read_text()
        for mode in ('rqid', 'hp'):
            chunks = [json.loads(line) for line in source.splitlines()]
            seen = set()
            changed = False
            for i, chunk in enumerate(chunks):
                lines = chunk.splitlines()
                for j, line in enumerate(lines):
                    if not line.startswith('|request|'): continue
                    request = json.loads(line[len('|request|'):])
                    if not request.get('active') or request.get('wait') or request.get('forceSwitch'): continue
                    if request['rqid'] in seen:
                        if mode == 'rqid': request['rqid'] += 1000
                        else: request['side']['pokemon'][0]['condition'] = '1/999'
                        lines[j] = '|request|' + json.dumps(request)
                        chunks[i] = '\n'.join(lines)
                        changed = True
                        break
                    seen.add(request['rqid'])
                if changed: break
            self.assertTrue(changed)
            path = self.directory / ('mutated-' + mode + '.jsonl')
            path.write_text(''.join(json.dumps(chunk) + '\n' for chunk in chunks))
            with self.subTest(mode=mode), self.assertRaises(AssertionError):
                private_material(path, 'p1')

    def test_other_rejections_or_fallback_still_exclude(self):
        original = copy.deepcopy(self.trajectory)
        for change in ('move_rejected', 'new_rqid', 'same_identity', 'fallback', 'no_recovery'):
            with self.subTest(change=change):
                self.trajectory = copy.deepcopy(original)
                rejected = self.trajectory[self.rejected]
                following = next(row for row in self.trajectory[self.rejected + 1:] if row['side'] == rejected['side'])
                if change == 'move_rejected': rejected['choice'] = 'move 1'
                if change == 'new_rqid': following['rqid'] += 1
                if change == 'same_identity': following['identity'] = rejected['identity']
                if change == 'fallback': following['fallback'] = True
                if change == 'no_recovery': following['accepted'] = False
                self.assertFalse(self.admitted())

    def test_verifier_proof_is_required(self):
        for name in ('canonical-reconstruction.json', 'native-replay.json', 'p1-neural-events.jsonl'):
            with self.subTest(name=name):
                path = self.directory / name
                value = path.read_bytes()
                path.unlink()
                self.assertFalse(self.admitted())
                path.write_bytes(value)
        self.assertFalse(trajectory_admitted(self.directory, self.trajectory, None))

    def test_broken_proposal_commit_recurrence_excludes(self):
        path = self.directory / 'p1-neural-events.jsonl'
        events = list(rows(path))
        events = [event for event in events if event['event'] != 'commit']
        path.write_text(''.join(json.dumps(event) + '\n' for event in events))
        self.assertFalse(self.admitted())

    def test_unrejected_game_keeps_existing_admission(self):
        clean = [row for row in self.trajectory if row['accepted']]
        self.assertTrue(trajectory_admitted(self.directory, clean))


if __name__ == '__main__':
    unittest.main()
