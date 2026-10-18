"""Synthetic-only LAD/core tests: no environmental archive is opened."""
import copy
import math
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import warnings

try:
    import numpy as np
    import scipy
    SCIENTIFIC_AVAILABLE = True
except ImportError:
    np = None
    SCIENTIFIC_AVAILABLE = False

import owasco_lad_core as lad


def recipe():
    return {"id": lad.CANDIDATE_ID, "optimizer": {
        "implementation": "scipy.optimize.linprog", "method": "highs-ds",
        "attempts": 1, "options": dict(lad.OPTIONS), "acceptance": {
            "maxConstraintViolationMgL": 1e-7,
            "objectiveRecompositionToleranceMgL": 1e-9}}}


def row(x, delta, persistence=10.0):
    return {"features": [persistence, float(x), 0.0, 0.0, 0.0, 0.0, 20.0, 0.0],
            "actual": persistence + delta, "persistence": persistence}


def exact_rows():
    return [row(x, -2.0 - 0.5*x) for x in range(-2, 3)]


def fake_result(n=3):
    return SimpleNamespace(success=True, status=0, message="Synthetic success", nit=0,
                           x=np.zeros(9+n), fun=0.0,
                           ineqlin=SimpleNamespace(marginals=np.zeros(2*n),
                                                   residual=np.zeros(2*n)))


@unittest.skipUnless(SCIENTIFIC_AVAILABLE, "Synthetic fits need NumPy and SciPy")
class LadCoreTests(unittest.TestCase):
    def test_exact_small_fit_uses_negative_free_intercept_and_slope(self):
        model = lad.fit_lad(exact_rows(), recipe())
        self.assertAlmostEqual(model["coefficients"]["intercept"], -2.0, places=12)
        self.assertAlmostEqual(model["coefficients"]["weights"][1], -math.sqrt(2.0)/2,
                               places=12)
        self.assertAlmostEqual(model["trainingDiagnostics"]["maeCandidate"], 0.0, places=12)
        self.assertEqual(model["trainingDiagnostics"]["pairs"], 5)
        self.assertEqual(len(model["solver"]["slacks"]), 5)
        self.assertEqual(len(model["solver"]["inequalityMarginals"]), 10)
        self.assertEqual(len(model["solver"]["inequalitySlacks"]), 10)
        self.assertEqual(len(model["solver"]["lowerMarginals"]), 14)
        self.assertEqual(model["solver"]["slacks"], model["solver"]["absoluteResidualBounds"])
        self.assertTrue(model["solver"]["success"])

    def test_synthetic_dual_certificate_retains_original_inequality_order(self):
        data = [row(x, -0.3 + 0.2*x + noise)
                for x, noise in zip(range(-2, 3), [0.5, -0.1, 0.0, 0.1, -0.5])]
        model = lad.fit_lad(data, recipe())
        n = len(data)
        certificate = model["solver"]
        duals = certificate["inequalityMarginals"]
        q = [duals[i] - duals[n+i] for i in range(n)]
        delta = [item["actual"]-item["persistence"] for item in data]
        primal = math.fsum(certificate["absoluteResidualBounds"]) / n
        dual = math.fsum(delta[i]*q[i] for i in range(n))
        self.assertAlmostEqual(primal, dual, places=10)
        self.assertAlmostEqual(math.fsum(q), 0.0, places=10)
        standardized = [lad.transformed(item["features"], model["preprocessing"])
                        for item in data]
        for j, constant in enumerate(model["preprocessing"]["constantMask"]):
            if not constant:
                self.assertAlmostEqual(math.fsum(standardized[i][j]*q[i] for i in range(n)),
                                       0.0, places=10)
        for i in range(n):
            self.assertGreaterEqual(1.0/n + duals[i] + duals[n+i], -1e-9)

    def test_constant_intercept_is_median_not_mean_with_outlier(self):
        data = [row(0, delta) for delta in [-0.5, 0.25, 0.25, 0.25, 2.0]]
        model = lad.fit_lad(data, recipe())
        self.assertAlmostEqual(model["coefficients"]["intercept"], 0.25, places=12)
        self.assertAlmostEqual(model["trainingDiagnostics"]["deltaResidualMAE"], 0.5,
                               places=12)
        self.assertEqual(model["coefficients"]["weights"], [0.0]*8)

    def test_constant_future_mask_stays_zero_while_current_p_is_added(self):
        model = lad.fit_lad([row(0, 0.25) for _ in range(3)], recipe())
        original = copy.deepcopy(model)
        result = lad.predict(model, [14.0, 9e8, -2e7, 9.0, 1.0, 1.0, 30.0, 2.0], 14.0)
        self.assertEqual(result, {"deltaHat": 0.25, "prediction": 14.25})
        self.assertEqual(model, original)
        self.assertEqual(model["preprocessing"]["constantMask"], [True]*8)
        self.assertEqual(model["preprocessing"]["scales"], [1.0]*8)

    def test_scaler_uses_only_supplied_rows_and_no_future_predict_statistics(self):
        data = exact_rows()
        before, spec = copy.deepcopy(data), recipe()
        original_spec = copy.deepcopy(spec)
        model = lad.fit_lad(data, spec)
        self.assertEqual(model["preprocessing"]["means"][1], 0.0)
        self.assertEqual(model["preprocessing"]["variances"][1], 2.0)
        self.assertEqual(data, before)
        self.assertEqual(spec, original_spec)
        frozen = lad.freeze_model_components(model)
        lad.predict(model, [10.0, 123456.0, 0, 0, 0, 0, 20.0, 0], 10.0)
        self.assertEqual(lad.freeze_model_components(model), frozen)
        shifted = copy.deepcopy(data)
        for item in shifted:
            item["features"][1] += 100
        other = lad.fit_lad(shifted, recipe())
        self.assertEqual(other["preprocessing"]["means"][1], 100.0)
        self.assertEqual(model["preprocessing"]["means"][1], 0.0)

    def test_lp_has_explicit_free_coefficients_and_exact_ordered_recipe(self):
        real_solver = lad.linprog
        with patch.object(lad, "linprog", wraps=real_solver) as optimizer:
            model = lad.fit_lad(exact_rows(), recipe())
        kwargs = optimizer.call_args.kwargs
        self.assertEqual(optimizer.call_count, 1)
        self.assertEqual(kwargs["method"], "highs-ds")
        self.assertEqual(kwargs["options"], lad.OPTIONS)
        self.assertEqual(kwargs["bounds"][0], (None, None))
        self.assertEqual(kwargs["bounds"][1], (0, 0))
        self.assertEqual(kwargs["bounds"][2], (None, None))
        self.assertEqual(kwargs["bounds"][9:], [(0, None)]*5)
        np.testing.assert_array_equal(kwargs["c"], [0.0]*9 + [0.2]*5)
        np.testing.assert_array_equal(kwargs["b_ub"], [-1, -1.5, -2, -2.5, -3,
                                                      1, 1.5, 2, 2.5, 3])
        self.assertEqual(kwargs["A_ub"].shape, (10, 14))
        self.assertLess(model["coefficients"]["weights"][1], 0.0)

    def test_wrong_feature_lengths_and_nonfinite_rows_are_rejected_before_fit(self):
        for bad in ([0.0]*7, [0.0]*9, [0.0]*7+[float("nan")]):
            data = [row(0, 0)]
            data[0]["features"] = bad
            with self.subTest(bad=bad), patch.object(lad, "linprog") as solver:
                with self.assertRaises(ValueError):
                    lad.fit_lad(data, recipe())
                solver.assert_not_called()

    def test_invalid_rows_are_not_silently_dropped(self):
        for field, bad in (("actual", float("inf")), ("persistence", -1),
                           ("actual", True), ("actual", -0.1)):
            data = exact_rows()
            data[2][field] = bad
            with self.subTest(field=field, bad=bad), patch.object(lad, "linprog") as solver:
                with self.assertRaises(ValueError):
                    lad.fit_lad(data, recipe())
                solver.assert_not_called()

    def test_solver_failure_stops_after_single_attempt(self):
        failed = fake_result()
        failed.success, failed.status, failed.message = False, 1, "Iteration limit"
        with patch.object(lad, "linprog", return_value=failed) as solver:
            with self.assertRaisesRegex(ValueError, "did not succeed"):
                lad.fit_lad([row(0, 0)]*3, recipe())
        self.assertEqual(solver.call_count, 1)

    def test_solver_exception_stops_without_retry(self):
        with patch.object(lad, "linprog", side_effect=RuntimeError("Synthetic failure")) as solver:
            with self.assertRaisesRegex(ValueError, "attempt failed"):
                lad.fit_lad([row(0, 0)]*3, recipe())
        self.assertEqual(solver.call_count, 1)

    def test_optimizer_warning_is_not_ignored(self):
        def warned(**kwargs):
            warnings.warn("Unrecognized options detected: synthetic", RuntimeWarning)
            return fake_result()
        with patch.object(lad, "linprog", side_effect=warned) as solver:
            with self.assertRaisesRegex(ValueError, "optimizer warning"):
                lad.fit_lad([row(0, 0)]*3, recipe())
        self.assertEqual(solver.call_count, 1)

    def test_nonfinite_solution_or_missing_dual_evidence_is_rejected(self):
        for field in ("nonfinite", "marginals"):
            result = fake_result()
            if field == "nonfinite":
                result.x[0] = float("nan")
            else:
                del result.ineqlin.marginals
            with self.subTest(field=field), patch.object(lad, "linprog", return_value=result):
                with self.assertRaisesRegex(ValueError, "optimizer result"):
                    lad.fit_lad([row(0, 0)]*3, recipe())

    def test_constraint_violation_rejected_independently_of_success_flag(self):
        result = fake_result()
        result.x[0] = 1.0
        with patch.object(lad, "linprog", return_value=result):
            with self.assertRaisesRegex(ValueError, "constraint acceptance"):
                lad.fit_lad([row(0, 0)]*3, recipe())

    def test_objective_recomposition_rejected_independently_of_success_flag(self):
        result = fake_result()
        result.fun = 0.1
        with patch.object(lad, "linprog", return_value=result):
            with self.assertRaisesRegex(ValueError, "objective recomposition"):
                lad.fit_lad([row(0, 0)]*3, recipe())

    def test_training_sanity_rejects_feasible_but_inferior_optimizer_output(self):
        result = fake_result()
        result.x[0] = 1.0
        result.x[9:] = 1.0
        result.fun = 1.0
        with patch.object(lad, "linprog", return_value=result):
            with self.assertRaisesRegex(ValueError, "training sanity"):
                lad.fit_lad([row(0, 0)]*3, recipe())

    def test_changed_recipe_cannot_swap_solver_or_add_tuning(self):
        for key, value in (("method", "highs-ipm"), ("attempts", 2)):
            spec = recipe()
            spec["optimizer"][key] = value
            with self.subTest(key=key), patch.object(lad, "linprog") as solver:
                with self.assertRaises(ValueError):
                    lad.fit_lad([row(0, 0)]*3, spec)
                solver.assert_not_called()
        spec = recipe()
        spec["optimizer"]["options"]["primal_feasibility_tolerance"] = 1e-7
        with self.assertRaises(ValueError):
            lad.fit_lad([row(0, 0)]*3, spec)

    def test_freeze_detaches_and_rejects_inconsistent_scaler_mask_and_weights(self):
        model = lad.fit_lad(exact_rows(), recipe())
        frozen = lad.freeze_model_components(model)
        self.assertEqual(set(frozen), {"preprocessing", "coefficients"})
        frozen["coefficients"]["weights"][1] = 123
        self.assertNotEqual(frozen["coefficients"]["weights"], model["coefficients"]["weights"])
        for mutation in ("mask", "scale", "weight"):
            bad = copy.deepcopy(model)
            if mutation == "mask":
                bad["preprocessing"]["constantMask"][1] = True
            elif mutation == "scale":
                bad["preprocessing"]["scales"][1] = 0.0
            else:
                bad["coefficients"]["weights"][0] = 0.1
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                lad.freeze_model_components(bad)

    def test_predict_preserves_negative_result_without_clipping_or_fallback(self):
        model = lad.fit_lad([row(0, 0)]*3, recipe())
        model["coefficients"]["intercept"] = -20.0
        self.assertEqual(lad.predict(model, row(0, 0)["features"], 10.0),
                         {"deltaHat": -20.0, "prediction": -10.0})

    def test_predict_reports_nonfinite_arithmetic_without_replacing_by_p(self):
        model = {"preprocessing": {"means": [0.0]*8, "variances": [1.0]*8,
                                   "scales": [1.0]*8, "constantMask": [False]*8},
                 "coefficients": {"intercept": 0.0, "weights": [1e308]+[0.0]*7}}
        result = lad.predict(model, [1e308]+[0.0]*7, 10.0)
        self.assertTrue(math.isinf(result["deltaHat"]))
        self.assertTrue(math.isinf(result["prediction"]))

    def test_predict_uses_fsum_and_does_not_reorder_cancelling_terms(self):
        model = {"preprocessing": {"means": [0.0]*8, "variances": [1.0]*8,
                                   "scales": [1.0]*8, "constantMask": [False]*8},
                 "coefficients": {"intercept": 1e16, "weights": [1.0, -1e16]+[0.0]*6}}
        self.assertEqual(lad.predict(model, [1.0, 1.0]+[0.0]*6, 10.0),
                         {"deltaHat": 1.0, "prediction": 11.0})


class StdlibPredictionTests(unittest.TestCase):
    def model(self):
        return {"preprocessing": {"means": [0.0]*8, "variances": [1.0]*8,
                                   "scales": [1.0]*8, "constantMask": [False]*8},
                "coefficients": {"intercept": 1e16, "weights": [1.0, -1e16]+[0.0]*6}}

    def test_fsum_prediction_is_available_without_fitting(self):
        self.assertEqual(lad.predict(self.model(), [1.0, 1.0]+[0.0]*6, 10.0),
                         {"deltaHat": 1.0, "prediction": 11.0})

    def test_freeze_and_prediction_do_not_import_scientific_packages(self):
        import builtins
        original_import = builtins.__import__

        def stdlib_only(name, *args, **kwargs):
            if name.split(".")[0] in ("numpy", "scipy"):
                raise AssertionError("Prediction attempted a scientific import")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=stdlib_only):
            model = lad.freeze_model_components(self.model())
            self.assertEqual(lad.predict(model, [1.0, 1.0]+[0.0]*6, 10.0)["prediction"], 11.0)

    def test_wrong_feature_length_rejected_without_solver(self):
        with patch.object(lad, "linprog") as solver:
            with self.assertRaises(ValueError):
                lad.predict(self.model(), [0.0]*7, 10.0)
            solver.assert_not_called()

    def test_negative_prediction_is_preserved_in_stdlib_path(self):
        model = self.model()
        model["coefficients"] = {"intercept": -20.0, "weights": [0.0]*8}
        self.assertEqual(lad.predict(model, [0.0]*8, 10.0)["prediction"], -10.0)


if __name__ == "__main__":
    unittest.main()
