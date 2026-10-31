"""Internal paired progress selection on train-reserved families, never certification."""
import argparse
from collections import Counter
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys


def censoring_rule(job):
    rule = job.get("progressCensoring")
    if rule is not None and (job.get("purpose") != "progress" or set(rule) != {"schema", "maxFraction"}
            or rule["schema"] != "uu-progress-censoring@1" or type(rule["maxFraction"]) not in (int, float)
            or not 0 <= Fraction(str(rule["maxFraction"])) <= Fraction(1, 50)):
        raise ValueError("Explicit progress-only censoring rule at most two percent required")
    return rule


def deadline_censored(game, rule):
    return bool(rule is not None and game["status"] == "truncated" and game.get("stopReason") == "deadline"
        and game["winner"] is None and not game["fallbacks"] and len(game["errors"]) == 1
        and game["errors"][0].get("stage") == "harness"
        and game["errors"][0].get("side") is None and game["errors"][0].get("rqid") is None
        and game["errors"][0].get("message") == "Match deadline expired.")


def validate_censored_drain(job, games, events, closed):
    """Account for actual worker sessions without using censored terminal outcomes."""
    rule = censoring_rule(job)
    if rule is None:raise ValueError("Censoring rule required")
    planned = {slot["id"] for slot in job["progressSlots"]}
    rows = {game["id"]: game for game in games}
    if len(rows) != len(games) or set(rows) != planned:raise ValueError("Progress records incomplete or duplicated")
    censored = {key for key, game in rows.items() if deadline_censored(game, rule)}
    if any(not (game["status"] == "completed" and not game["errors"] and not game["fallbacks"])
           for key, game in rows.items() if key not in censored):raise ValueError("Non-censor progress failure")
    started, ended = set(), {}
    for event in events:
        key = (event["game"], event["side"])
        if key[0] not in planned or key[1] not in ("p1", "p2"):raise ValueError("Unknown neural session")
        if event["event"] == "started":
            if key in started:raise ValueError("Duplicate neural session")
            started.add(key)
        else:
            expected = {"completed", "failed_or_censored"} if key[0] in censored else {"completed"}
            if key not in started or key in ended or event["event"] not in expected:raise ValueError("Neural session close mismatch")
            ended[key] = event["event"]
    expected_complete = {(key, side) for key in planned-censored for side in ("p1", "p2")}
    actual_complete = {key for key, event in ended.items() if event == "completed"}
    if (set(ended) != started or not expected_complete <= actual_complete
            or closed.get("active") != 0 or closed.get("connections") != len(started)
            or closed.get("completedPOVs") != len(actual_complete)
            or closed.get("failedPOVs") != len(started)-len(actual_complete)):
        raise ValueError("Neural progress sessions have not drained exactly")
    return {"completedPOVs":len(actual_complete), "completedGamePOVs":len(expected_complete),
            "censoredStartedPOVs":len(started)-len(expected_complete), "censoredWorkerTerminalPOVs":len(actual_complete-expected_complete),
            "censoredGames":len(censored), "allSessionsClosed":True}


def slots(panel, candidate, baseline, seed, repetitions=1):
    if panel["schema"]!="uu-progress-panel@1" or panel["certification"] is not False:
        raise ValueError("Progress panel required")
    progress = [r["family"] for r in panel["progress"]]
    forbidden = {r["family"] for r in panel["collection"]}|set(panel["excludedCertificationFamilies"])
    if len(progress)<3 or len(set(progress))!=len(progress) or set(progress)&forbidden:
        raise ValueError("Progress family overlap or insufficient families")
    if type(repetitions) is not int or repetitions<1:raise ValueError("Positive repetitions required")
    result = []
    for repeat in range(repetitions):
        for index,family in enumerate(progress):
            away = progress[(index+1+repeat%(len(progress)-1))%len(progress)]
            for seat in ("p1","p2"):
                slot = f"r{repeat}-f{index}-{seat}"
                policy_seed = int.from_bytes(hashlib.sha256(f"{seed}:{slot}".encode()).digest()[:4],"big")>>1
                for arm,model in (("B0",baseline),("B1",candidate)):
                    result.append({"id":f"{slot}-{arm}","slot":slot,"arm":arm,"home":seat,
                        "family":family,"policySeed":policy_seed,
                        "families":{seat:family,"p2" if seat=="p1" else "p1":away},
                        "models":{seat:model,"p2" if seat=="p1" else "p1":baseline}})
    return result


def summarize(job, games):
    rule = censoring_rule(job)
    planned = {s["id"]:s for s in job["progressSlots"]}
    if not planned:raise ValueError("Planned progress games required")
    seen, scores, failures, censored = set(), {}, [], []
    wins = Counter()
    for game in games:
        key = game["id"]
        if key not in planned or key in seen:raise ValueError("Unknown or duplicate progress game")
        seen.add(key);slot = planned[key]
        for field in ("policySeed","families"):
            if game[field]!=slot[field]:raise ValueError(f"Progress {field} drift")
        for side in ("p1","p2"):
            member = next(m for m in job["policies"] if m["name"]==slot["models"][side])
            if game["actors"][side]!={**member,"temperature":1}:raise ValueError("Progress actor drift")
        valid = game["status"]=="completed" and not game["errors"] and not game["fallbacks"]
        winner = game["winner"]
        censor = deadline_censored(game, rule)
        if rule is not None and game.get("censored") is not censor:raise ValueError("Censor label/classification drift")
        if censor:
            censored.append(key);continue
        if not valid or winner not in ("p1","p2",None):
            failures.append(key);continue
        score = .5 if winner is None else float(winner==slot["home"])
        scores[(slot["slot"],slot["arm"])] = score
        if slot["arm"]=="B1":wins["draw" if score==.5 else "win" if score==1 else "loss"] += 1
    pairs = []
    for slot in planned.values():
        key = slot["slot"]
        if slot["arm"]=="B1" and all((key,arm) in scores for arm in ("B0","B1")):
            pairs.append({"family":slot["family"],"slotID":key,
                          "score":scores[(key,"B1")]-scores[(key,"B0")]})
    # Reuse the certification analyzer's inference function; this remains an
    # adaptively reused progress panel and cannot establish model strength.
    sys.path.insert(0,str(Path(__file__).parents[1]/"uu_eval"))
    from analyze import paired_inference
    estimate = paired_inference(pairs,"score",seed=job["seed"])
    complete = len(seen)==len(planned) and not failures and len(pairs)*2==len(planned)
    candidate_scores = [v for (slot,arm),v in scores.items() if arm=="B1"]
    report = {"internalSelectionOnly":True,"certification":False,"complete":complete,
        "plannedGames":len(planned),"recordedGames":len(seen),"failedGames":failures,
        "missingGames":sorted(set(planned)-seen),"candidateResults":dict(wins),
        "candidateScore":sum(candidate_scores)/len(candidate_scores) if candidate_scores else None,
        "paired":estimate,"progressTrigger":bool(complete and candidate_scores and
            sum(candidate_scores)/len(candidate_scores)>=.60 and estimate["ci95"] and estimate["ci95"][0]>.05)}
    if rule is not None:
        paired_ids = {pair["slotID"] for pair in pairs}
        primary_scores = [value for (slot, arm), value in scores.items() if arm == "B1" and slot in paired_ids]
        filled = dict(scores)
        for key in censored:
            slot = planned[key];filled[(slot["slot"], slot["arm"])] = 0. if slot["arm"] == "B1" else 1.
        bound_pairs = [{"family":slot["family"], "slotID":slot["slot"], "score":filled[(slot["slot"], "B1")]-filled[(slot["slot"], "B0")]}
                       for slot in planned.values() if slot["arm"] == "B1" and all((slot["slot"], arm) in filled for arm in ("B0", "B1"))]
        bound = paired_inference(bound_pairs, "score", seed=job["seed"])
        bound_scores = [value for (slot, arm), value in filled.items() if arm == "B1"]
        within_cap = Fraction(len(censored), len(planned)) <= Fraction(str(rule["maxFraction"]))
        finished = len(seen) == len(planned)
        valid_screen = finished and not failures and within_cap and len(bound_pairs)*2 == len(planned)
        passes = lambda values, inference:bool(values and sum(values)/len(values) >= .60 and inference["ci95"] and inference["ci95"][0] > .05)
        report.update(cohortFinished=finished, allGamesCompleted=complete and not censored,
            validProgressScreen=valid_screen, censoredGames=censored, censoringLimitExceeded=not within_cap,
            censoringFraction=len(censored)/len(planned), censoringRule=rule, completedPairs=len(pairs),
            censoredByArm=dict(Counter(planned[key]["arm"] for key in censored)),
            censoredByFamily=dict(Counter(planned[key]["family"] for key in censored)),
            candidateScore=sum(primary_scores)/len(primary_scores) if primary_scores else None,
            conservative={"imputation":{"B1":0,"B0":1}, "paired":bound,
                          "candidateScore":sum(bound_scores)/len(bound_scores) if bound_scores else None,
                          "allPlannedPairs":len(bound_pairs)*2 == len(planned), "observedTerminalOutcomes":False},
            progressTrigger=bool(valid_screen and passes(primary_scores, estimate) and passes(bound_scores, bound)))
    return report


if __name__=="__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("run",type=Path)
    a = p.parse_args()
    job = json.loads((a.run/"job.json").read_text())
    if job.get("purpose")!="progress":raise ValueError("Progress run required")
    games = [json.loads(line) for f in sorted(a.run.glob("worker-*/games.jsonl")) for line in f.read_text().splitlines()]
    if censoring_rule(job) is not None:
        verification=json.loads((a.run/"canonical-replay-batch/report.json").read_bytes())
        if not verification["pass"] or verification["games"] != len(games):raise ValueError("Progress verification incomplete")
        verified={Path(row["game"]).resolve():row for row in verification["rows"]}
        if len(verified) != len(games) or verification["modelCalls"] != 0:raise ValueError("Progress verification rows malformed")
        summaries={path.parent.name:path for path in a.run.glob("worker-*/*/summary.json")}
        if len(summaries) != len(games):raise ValueError("Progress summaries incomplete")
        for game in games:
            path=summaries[game["id"]];summary=json.loads(path.read_bytes());proof=verified[path.parent.resolve()]
            if proof["returncode"] != 0 or set(proof["inputs"]) != {"summary.json","replay-inputs.json","trajectory.jsonl","replay.log","p1-private.jsonl","p2-private.jsonl"}:
                raise ValueError("Required progress input proof missing")
            if (any(game[key] != summary[key] for key in ("status","winner","errors","fallbacks","stopReason"))
                    or game["turns"] != summary["turn"]):raise ValueError("Progress summary/record drift")
            for side in ("p1","p2"):
                if summary["players"][side]["policyId"] != game["actors"][side]["policyId"]:raise ValueError("Progress summary actor drift")
            if any(hashlib.sha256((path.parent/name).read_bytes()).hexdigest() != digest for name,digest in proof["inputs"].items()):
                raise ValueError("Progress retained input drift")
            if deadline_censored(summary,job["progressCensoring"]):
                if not proof.get("censoredRawRetained") or proof["proofSha256"] is not None:raise ValueError("Censored terminal cannot be a verified outcome")
            else:
                replay=path.parent/"native-replay.json"
                if (hashlib.sha256(replay.read_bytes()).hexdigest() != proof["proofSha256"]
                        or json.loads(replay.read_bytes())["status"] != "PASS_EXACT_RECORDED_CHOICE_NATIVE_REPLAY"):
                    raise ValueError("Completed progress game lacks exact replay")
    report = summarize(job,games)
    target = a.run/"progress.json"
    with target.open("x") as stream:json.dump(report,stream,indent=2)
    print(json.dumps(report))
