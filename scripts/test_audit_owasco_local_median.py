"""Synthetic algebra/certificate counterexamples; never open environmental data."""
import copy
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import audit_owasco_local_median as audit


def certificate_fixture():
    # theta=0 is optimal: alternating residual signs are orthogonal both to
    # the intercept and the only nonconstant feature. All arithmetic is invented.
    x, delta = [-1.0, -1.0, 1.0, 1.0], [-1.0, 1.0, 1.0, -1.0]
    rows = [{"features": [x[i]]+[0.0]*7, "actual": 10.0+delta[i],
             "persistence": 10.0} for i in range(4)]
    model = {
        "preprocessing": {"means": [0.0]*8, "variances": [1.0]+[0.0]*7,
                          "scales": [1.0]*8, "constantMask": [False]+[True]*7},
        "coefficients": {"intercept": 0.0, "weights": [0.0]*8},
        "solver": {"success": True, "status": 0, "objective": 1.0,
                   "slacks": [1.0]*4, "absoluteResidualBounds": [1.0]*4,
                   "inequalitySlacks": [0.0, 2.0, 2.0, 0.0, 2.0, 0.0, 0.0, 2.0],
                   "inequalityMarginals": [-.25, 0.0, 0.0, -.25, 0.0, -.25, -.25, 0.0],
                   "lowerMarginals": [0.0]*13},
        "trainingDiagnostics": {"pairs": 4, "maePersistence": 1.0,
                                "maeCandidate": 1.0, "deltaResidualMAE": 1.0,
                                "maxConstraintViolation": 0.0, "objectiveDifference": 0.0},
    }
    return model, rows


def report_fixture():
    model, _ = certificate_fixture()
    model["coefficients"]["intercept"] = .125
    rows, records = [], []
    for i, actual in enumerate((11.0, 9.0, 10.0, 10.0)):
        day, hour = 1+i//2, i % 2
        origin, target = f"2030-07-{day:02d}T{hour:02d}:00:00Z", f"2030-07-{day:02d}T{hour+1:02d}:00:00Z"
        rows.append({"index": i, "origin": origin, "target": target, "actual": actual,
                     "persistence": 10.0, "oldR": 10.5, "features": [0.0]*8})
        record = {"sourceRowIndex": i, "origin": origin, "target": target,
                  "actualMgL": actual, "persistenceMgL": 10.0, "oldRMgL": 10.5,
                  "deltaHatMgL": .125, "predictionMgL": 10.125, "candidateValid": True,
                  "predictionChanged": True,
                  "absoluteErrorsMgL": {"P": abs(10.0-actual), "L": abs(10.125-actual), "oldR": abs(10.5-actual)},
                  "gainAgainstPersistenceMgL": .125 if i == 0 else -.125,
                  "signedErrorMgL": 10.125-actual, "outcome": "helps" if i == 0 else "harms"}
        records.append(record)
    def fixture_summary(items):
        n = len(items)
        avg = lambda key: sum(key(item) for item in items)/n if n else None
        return {"pairs": n,
                "maePersistenceMgL": avg(lambda r: r["absoluteErrorsMgL"]["P"]),
                "maeCandidateMgL": avg(lambda r: r["absoluteErrorsMgL"]["L"]),
                "maeOldRMgL": avg(lambda r: r["absoluteErrorsMgL"]["oldR"]),
                "meanGainAgainstPersistenceMgL": avg(lambda r: r["gainAgainstPersistenceMgL"]),
                "meanSignedErrorMgL": avg(lambda r: r["signedErrorMgL"]),
                "maxCandidateAbsoluteErrorMgL": max((r["absoluteErrorsMgL"]["L"] for r in items), default=None),
                "invalidPredictions": 0, "changedPredictions": n}
    report = {
        "rows": records, "summary": fixture_summary(records),
        "outcomeGroups": {label: fixture_summary([r for r in records if r["outcome"] == label])
                          for label in ("helps", "ties", "harms", "invalid")},
        "utcDays": {day: fixture_summary([r for r in records if r["origin"][:10] == day])
                    for day in ("2030-07-01", "2030-07-02")},
        "examples": {"helps": records[0], "harms": records[1]},
        "decision": {"gainMgL": -.0625, "numericalToleranceMgL": 1e-9,
                     "primaryMetric": "Full-cohort August MAE against persistence",
                     "passedDevelopmentScreen": False, "status": "STOP_CANDIDATE",
                     "independentValidation": False, "septemberOpened": False},
    }
    return model, rows, report


class IndependentAuditTests(unittest.TestCase):
    def test_exact_invented_primal_dual_certificate_passes(self):
        model, rows = certificate_fixture()
        self.assertTrue(audit.check_components(model, rows)["scalerVerified"])
        proof = audit.certificate(model, rows)
        self.assertEqual(proof["primalObjective"], 1.0)
        self.assertEqual(proof["dualObjective"], 1.0)
        self.assertEqual(proof["maximumFreeCoefficientStationarity"], 0.0)
        self.assertTrue(proof["certificatePassed"])

    def test_scaler_mean_variance_mask_scale_and_constant_weight_tampering_fails(self):
        model, rows = certificate_fixture()
        for where, key, index, value in (("preprocessing", "means", 0, .001),
                ("preprocessing", "variances", 0, .9), ("preprocessing", "scales", 0, 2.0),
                ("preprocessing", "constantMask", 0, True), ("coefficients", "weights", 1, 1.0)):
            bad = copy.deepcopy(model)
            bad[where][key][index] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                audit.check_components(bad, rows)

    def test_primal_infeasibility_and_malformed_certificate_shapes_fail(self):
        model, rows = certificate_fixture()
        for key, value in (("absoluteResidualBounds", [0.0]*4),
                           ("inequalityMarginals", [0.0]*7),
                           ("inequalitySlacks", [0.0]*7),
                           ("status", True), ("success", False)):
            bad = copy.deepcopy(model)
            bad["solver"][key] = value
            if key == "absoluteResidualBounds": bad["solver"]["slacks"] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                audit.certificate(bad, rows)

    def test_wrong_saved_slack_and_positive_marginal_fail(self):
        model, rows = certificate_fixture()
        for key, position, value in (("inequalitySlacks", 0, .1),
                                     ("inequalityMarginals", 0, .1)):
            bad = copy.deepcopy(model)
            bad["solver"][key][position] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                audit.certificate(bad, rows)

    def test_dual_stationarity_reduced_cost_and_gap_are_not_optional(self):
        model, rows = certificate_fixture()
        for marginals in (
                [-.20, 0.0, 0.0, -.25, 0.0, -.25, -.25, 0.0],
                [-.3, 0.0, 0.0, -.3, 0.0, -.3, -.3, 0.0],
                [0.0]*8):
            bad = copy.deepcopy(model)
            bad["solver"]["inequalityMarginals"] = marginals
            bad["solver"]["lowerMarginals"] = None
            with self.assertRaises(ValueError):
                audit.certificate(bad, rows)

    def test_complementarity_rejects_dual_weight_on_nonbinding_constraint(self):
        model, rows = certificate_fixture()
        # Move all dual mass onto the inactive opposite inequalities. Signs and
        # coefficient stationarity still hold, but complementarity must fail.
        model["solver"]["inequalityMarginals"] = [0.0, -.25, -.25, 0.0, -.25, 0.0, 0.0, -.25]
        with self.assertRaisesRegex(ValueError, "complementarity"):
            audit.certificate(model, rows)

    def test_objective_and_training_diagnostics_are_recomposed(self):
        model, rows = certificate_fixture()
        for location, key in (("solver", "objective"), ("trainingDiagnostics", "maePersistence"),
                              ("trainingDiagnostics", "maeCandidate"), ("trainingDiagnostics", "deltaResidualMAE")):
            bad = copy.deepcopy(model)
            bad[location][key] += .01
            with self.subTest(key=key), self.assertRaises(ValueError):
                audit.certificate(bad, rows)

    def test_optional_lower_marginals_are_checked_but_fixed_theta_is_not_free(self):
        model, rows = certificate_fixture()
        model["solver"]["lowerMarginals"][2] = 12.0
        # theta2 is fixed at zero; its bound multiplier need not vanish.
        self.assertTrue(audit.certificate(model, rows)["certificatePassed"])
        for index in (0, 1, 9):
            bad = copy.deepcopy(model)
            bad["solver"]["lowerMarginals"][index] = .01
            with self.subTest(index=index), self.assertRaises(ValueError):
                audit.certificate(bad, rows)

    def test_nonfinite_or_boolean_certificate_values_are_rejected(self):
        model, rows = certificate_fixture()
        for value in (True, float("nan"), float("inf"), None, "0"):
            bad = copy.deepcopy(model)
            bad["solver"]["absoluteResidualBounds"][0] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                audit.certificate(bad, rows)

    def test_prediction_and_full_report_arithmetic_are_checked_independently(self):
        model, rows, report = report_fixture()
        self.assertEqual(audit.prediction(model, rows[0]), (.125, 10.125))
        result = audit.check_report(report, model, rows)
        self.assertEqual(result["summary"]["maePersistenceMgL"], .5)
        self.assertEqual(result["summary"]["maeCandidateMgL"], .5625)
        self.assertEqual(result["summary"]["maeOldRMgL"], .75)
        self.assertEqual(result["summary"]["meanSignedErrorMgL"], .125)
        self.assertFalse(result["passedDevelopmentScreen"])

    def test_row_origin_forecast_error_gain_and_example_mutations_fail(self):
        model, rows, report = report_fixture()
        bads = []
        for key, value in (("origin", "2030-07-03T00:00:00Z"), ("predictionMgL", 10.0),
                           ("gainAgainstPersistenceMgL", .25), ("actualMgL", 12.0), ("sourceRowIndex", 9)):
            bad = copy.deepcopy(report); bad["rows"][0][key] = value; bads.append(bad)
        bad = copy.deepcopy(report); bad["rows"][0]["absoluteErrorsMgL"]["L"] = 0; bads.append(bad)
        bad = copy.deepcopy(report); bad["examples"]["harms"] = bad["rows"][2]; bads.append(bad)
        for bad in bads:
            with self.assertRaises(ValueError):
                audit.check_report(bad, model, rows)

    def test_group_day_counts_and_decision_cannot_override_full_cohort_mae(self):
        model, rows, report = report_fixture()
        bads = []
        bad = copy.deepcopy(report); bad["outcomeGroups"]["helps"]["pairs"] += 1; bads.append(bad)
        bad = copy.deepcopy(report); bad["utcDays"]["2030-07-02"]["maeCandidateMgL"] = 0; bads.append(bad)
        bad = copy.deepcopy(report); bad["summary"]["maeCandidateMgL"] = 0; bads.append(bad)
        bad = copy.deepcopy(report); bad["decision"]["passedDevelopmentScreen"] = True; bads.append(bad)
        for bad in bads:
            with self.assertRaises(ValueError):
                audit.check_report(bad, model, rows)

    def test_empty_groups_preserve_nulls_and_negative_predictions_stay_counted(self):
        model, rows, report = report_fixture()
        self.assertIsNone(audit.summarize([])["maeCandidateMgL"])
        model["coefficients"]["intercept"] = -20.0
        record = audit.report_row(model, rows[0])
        self.assertFalse(record["candidateValid"])
        self.assertEqual(record["predictionMgL"], -10.0)
        self.assertEqual(record["outcome"], "invalid")
        self.assertEqual(audit.summarize([record])["pairs"], 1)

    def test_near_zero_gain_uses_frozen_tolerance_and_boolean_is_not_a_number(self):
        model, rows, _ = report_fixture()
        model["coefficients"]["intercept"] = 5e-10
        self.assertEqual(audit.report_row(model, rows[0])["outcome"], "ties")
        with self.assertRaises(ValueError):
            audit.compare(True, 1.0, "numeric bool")
        with self.assertRaises(ValueError):
            audit.compare(1.0, 1, "exact counter")

    def test_strict_json_and_safe_paths(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}'):
            with self.assertRaises(ValueError): audit.loads(raw)
        with tempfile.TemporaryDirectory() as folder:
            for name in ("../bad", "C:/bad", "/bad", "a//b", "a\\b"):
                with self.assertRaises(ValueError): audit.path(Path(folder), name)

    def test_cli_only_prints_and_never_writes_a_report(self):
        with patch.object(audit, "audit", return_value={"status": "PASS"}) as run:
            output = io.StringIO()
            with redirect_stdout(output): audit.main(["--root", ".", "--report"])
            self.assertIn('"status": "PASS"', output.getvalue())
            self.assertIs(run.call_args.args[1], True)

    def test_default_entry_point_does_not_request_august_or_the_development_report(self):
        spec = {"stationId": audit.STATION, "features": audit.FEATURES, "horizonSeconds": 3600,
                "candidate": {"id": "invented", "optimizer": {"method": "invented", "options": {}}}}
        frozen = {"version": "owasco-local-lad-implementation-freeze-v1",
                  "protocolRawSha256": audit.PROTOCOL_SHA, "environmentalFitExecuted": False,
                  "candidatePredictionsOrScoresComputed": False, "implementationCommit": "a"*40,
                  "codeFiles": [{"file": name, "rawSha256": "c"*64} for name in audit.CODE_FILES]}
        model = {"version": "owasco-july-local-lad-model-v1", "candidateId": "invented",
                 "protocolRawSha256": audit.PROTOCOL_SHA, "implementationFreezeRawSha256": "d"*64,
                 "implementationCommit": "a"*40, "features": audit.FEATURES, "trainingPairs": 1275,
                 "trainedOnlyOnJuly": True, "developmentPredictionsComputed": False,
                 "trainingSources": [], "solver": {"method": "invented", "options": {}}}
        docs = {audit.PROTOCOL: (spec, audit.PROTOCOL_SHA), audit.FREEZE: (frozen, "d"*64), audit.MODEL: (model, "e"*64)}
        opened, roles = [], []
        def read_doc(root, name):
            opened.append(name)
            if name not in docs: raise AssertionError("A development or unrelated document was opened")
            return docs[name]
        def cohort(root, spec, role):
            roles.append(role)
            if role != "training": raise AssertionError("August was requested")
            return [{}]*1275, []
        with (patch.object(audit, "document", side_effect=read_doc),
              patch.object(audit, "raw_read", return_value=(b"invented-code", "c"*64)),
              patch.object(audit, "read_cohort", side_effect=cohort),
              patch.object(audit, "check_components", return_value={"scalerVerified": True}),
              patch.object(audit, "certificate", return_value={"certificatePassed": True})):
            result = audit.audit(Path("."))
        self.assertEqual(opened, [audit.PROTOCOL, audit.FREEZE, audit.MODEL])
        self.assertEqual(roles, ["training"])
        self.assertFalse(result["developmentOpened"])


if __name__ == "__main__":
    unittest.main()
