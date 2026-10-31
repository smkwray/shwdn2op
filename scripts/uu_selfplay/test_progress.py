"""Progress pairing, partial-result honesty and non-training replay admission."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from progress_eval import slots, summarize, validate_censored_drain


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.panel = {"schema":"uu-progress-panel@1","certification":False,
            "progress":[{"family":str(i)} for i in range(3)],
            "collection":[{"family":"train"}],"excludedCertificationFamilies":["dev","test"]}
        self.members = [{"name":"G0","sha256":"base","policyId":"base"},
                        {"name":"G1","sha256":"candidate","policyId":"candidate"}]
        self.job = {"seed":7,"policies":self.members,"progressSlots":slots(self.panel,"G1","G0",7)}

    def games(self):
        return [{"id":s["id"],"policySeed":s["policySeed"],"families":s["families"],
            "actors":{side:{**next(m for m in self.members if m["name"]==s["models"][side]),"temperature":1}
                      for side in ("p1","p2")},"winner":s["home"],"status":"completed",
            "errors":[],"fallbacks":[]} for s in self.job["progressSlots"]]

    def test_paired_seeds_rosters_seats_and_disjoint_families(self):
        rows = self.job["progressSlots"]
        self.assertEqual(len(rows),12)
        for b0,b1 in zip(rows[::2],rows[1::2]):
            for key in ("slot","policySeed","families","home"):self.assertEqual(b0[key],b1[key])
            self.assertEqual(b0["models"][b0["home"]],"G0")
            self.assertEqual(b1["models"][b1["home"]],"G1")
        self.panel["collection"].append({"family":"0"})
        with self.assertRaisesRegex(ValueError,"overlap"):slots(self.panel,"G1","G0",7)

    def test_full_null_candidate_and_retained_failures(self):
        games = self.games()
        report = summarize(self.job,games)
        self.assertTrue(report["complete"])
        self.assertEqual(report["paired"]["mean"],0)
        self.assertFalse(report["progressTrigger"])
        games[0]["status"] = "failed"
        report = summarize(self.job,games)
        self.assertFalse(report["complete"])
        self.assertEqual(report["paired"]["pairs"],5)
        self.assertEqual(report["failedGames"],[games[0]["id"]])
        self.assertFalse(summarize(self.job,games[1:])["complete"])
        with self.assertRaisesRegex(ValueError,"duplicate"):summarize(self.job,games[1:]+games[1:2])
        games = self.games();games[0]["actors"]["p1"]["sha256"] = "wrong"
        with self.assertRaisesRegex(ValueError,"actor drift"):summarize(self.job,games)

    def test_freezer_rejects_progress_even_if_moved_under_training_piles(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);block = root/"piles/block";model = block/"G0/metamon/gen9uu"
            model.mkdir(parents=True)
            (root/"block-manifest.json").write_text(json.dumps({"source_sha256":{
                "source/metamon/env/metamon_battle.py":"fixed synthetic decoder"}}))
            for side in ("p1","p2"):
                f = model/f"{side}.json.lz4";f.write_bytes(b"must never be read")
                Path(str(f)+".meta").write_text(json.dumps({"purpose":"progress","training_eligible":False,
                    "battle_tag":"one","player":side,"opponent":"p2" if side=="p1" else "p1"}))
            run = subprocess.run([sys.executable,str(Path(__file__).with_name("freeze_pile.py")),str(root/"frozen"),str(block)],capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr)
            manifest = json.loads((root/"frozen/manifest.json").read_text())
            self.assertEqual(manifest["trajectories"],0)
            self.assertEqual(manifest["excluded"],{"not_training_data":2})

    def censor_fixture(self, families=24, repetitions=10):
        self.panel["progress"] = [{"family":str(i)} for i in range(families)]
        self.job.update(purpose="progress", progressSlots=slots(self.panel,"G1","G0",7,repetitions),
                        progressCensoring={"schema":"uu-progress-censoring@1","maxFraction":.02})
        games=self.games()
        for game,slot in zip(games,self.job["progressSlots"]):
            game.update(censored=False,stopReason="completed")
            game["winner"]=slot["home"] if slot["arm"]=="B1" else ("p2" if slot["home"]=="p1" else "p1")
        return games

    def censor(self, game):
        game.update(status="truncated",winner=None,stopReason="deadline",censored=True,
                    errors=[{"stage":"harness","side":None,"rqid":None,"message":"Match deadline expired."}])

    def test_progress_censor_cap_is_exact_and_missing_games_never_become_censors(self):
        games=self.censor_fixture()
        for game in games[:19]:self.censor(game)
        report=summarize(self.job,games)
        self.assertFalse(report["complete"])
        self.assertTrue(report["cohortFinished"] and report["validProgressScreen"])
        self.assertEqual(len(report["censoredGames"]),19)
        self.assertEqual(report["conservative"]["paired"]["pairs"],480)
        self.assertFalse(summarize(self.job,games[:-1])["validProgressScreen"])
        self.censor(games[19]);report=summarize(self.job,games)
        self.assertTrue(report["censoringLimitExceeded"])
        self.assertFalse(report["validProgressScreen"] or report["progressTrigger"])

    def test_worst_case_all_planned_bound_can_block_a_positive_completed_pair_screen(self):
        games=self.censor_fixture();indices={}
        for game,slot in zip(games,self.job["progressSlots"]):
            key=(slot["family"],slot["arm"]);index=indices.get(key,0);indices[key]=index+1
            win=(index==19 if slot["arm"]=="B1" else index<19) if slot["family"]=="0" else index<(13 if slot["arm"]=="B1" else 11)
            game["winner"]=slot["home"] if win else ("p2" if slot["home"]=="p1" else "p1")
            if slot["family"]=="0" and slot["arm"]=="B1" and index<19:self.censor(game)
        report=summarize(self.job,games)
        self.assertTrue(report["validProgressScreen"])
        self.assertGreater(report["candidateScore"],.60)
        self.assertGreater(report["paired"]["ci95"][0],.05)
        self.assertLessEqual(report["conservative"]["paired"]["ci95"][0],.05)
        self.assertFalse(report["progressTrigger"])

    def test_control_censor_is_imputed_as_home_win_and_candidate_as_home_loss(self):
        games=self.censor_fixture(families=3,repetitions=17)
        for game in games[:2]:self.censor(game)
        report=summarize(self.job,games)
        self.assertEqual(report["paired"]["pairs"],101)
        self.assertEqual(report["paired"]["mean"],1)
        self.assertAlmostEqual(report["conservative"]["paired"]["mean"],1-2/102)
        self.assertEqual(report["censoredByArm"],{"B0":1,"B1":1})
        # Every possible terminal completion is at least this pessimistic bound.
        for candidate in (0,.5,1):
            for control in (0,.5,1):
                self.assertLessEqual(report["conservative"]["paired"]["mean"],(101+candidate-control)/102)

    def test_other_failures_stay_fatal_and_strict_default_is_unchanged(self):
        for change in ({"stopReason":"cancelled"},{"stopReason":"max_turns"},
                       {"errors":[{"stage":"policy","message":"Match deadline expired."}]},
                       {"fallbacks":[{"reason":"fallback"}]},{"winner":"p1"}):
            games=self.censor_fixture();self.censor(games[0]);games[0].update(change,censored=False)
            report=summarize(self.job,games)
            self.assertFalse(report["validProgressScreen"])
            self.assertEqual(report["failedGames"],[games[0]["id"]])
        games=self.censor_fixture();self.censor(games[0]);self.job.pop("progressCensoring")
        self.assertFalse(summarize(self.job,games)["complete"])
        self.job["progressCensoring"]={"schema":"uu-progress-censoring@1","maxFraction":.02}
        self.job["purpose"]="selfplay"
        with self.assertRaisesRegex(ValueError,"progress-only"):summarize(self.job,games)

    def test_session_drain_accounts_for_censored_sessions_without_waiving_other_failures(self):
        games=self.censor_fixture(families=3,repetitions=1);self.censor(games[0]);events=[]
        for game in games:
            for side in ("p1","p2"):
                if game is games[0] and side=="p2":continue
                events.extend([{"event":"started","game":game["id"],"side":side},
                    {"event":"failed_or_censored" if game is games[0] else "completed","game":game["id"],"side":side}])
        closed={"active":0,"connections":23,"completedPOVs":22,"failedPOVs":1}
        self.assertTrue(validate_censored_drain(self.job,games,events,closed)["allSessionsClosed"])
        for changed_events,changed_counts in ((events[:-1],closed),(events,{**closed,"active":1}),
                (events,{**closed,"failedPOVs":0}),(events+[events[-1]],closed)):
            with self.assertRaises(ValueError):validate_censored_drain(self.job,games,changed_events,changed_counts)

    def test_worker_terminal_at_harness_deadline_remains_censored_without_a_drain_failure(self):
        games=self.censor_fixture(families=3,repetitions=1);self.censor(games[0]);events=[]
        for game in games:
            for side in ("p1","p2"):
                events.extend([{"event":"started","game":game["id"],"side":side},
                               {"event":"completed","game":game["id"],"side":side}])
        closed={"active":0,"connections":24,"completedPOVs":24,"failedPOVs":0}
        proof=validate_censored_drain(self.job,games,events,closed)
        self.assertTrue(proof["allSessionsClosed"])
        self.assertEqual(proof["censoredGames"],1)
        self.assertEqual(proof["censoredStartedPOVs"],2)


if __name__=="__main__":unittest.main()
