"""Pure numerical core for the frozen Owasco local LAD recipe.

There is no file discovery, environmental archive reader, CLI, or global scaler.
The caller owns source lineage, July-only eligibility, environment verification,
artifact hashing, and the later complete-cohort development decision.
"""
import math
from numbers import Real
import warnings

FEATURE_COUNT = 8
CANDIDATE_ID = "owasco-july-local-linear-lad-v1"
METHOD = "highs-ds"
OPTIONS = {
    "presolve": True,
    "primal_feasibility_tolerance": 1e-9,
    "dual_feasibility_tolerance": 1e-9,
    "simplex_dual_edge_weight_strategy": "steepest-devex",
    "maxiter": 100000,
    "disp": False,
}
CONSTRAINT_TOLERANCE = 1e-7
OBJECTIVE_TOLERANCE = 1e-9
TRAINING_TOLERANCE = 1e-7


def linprog(**kwargs):
    """Import the scientific solver only when a fit is explicitly requested."""
    from scipy.optimize import linprog as scipy_linprog
    return scipy_linprog(**kwargs)


def finite_number(value, label):
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(label + " must be a finite real number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(label + " must be finite")
    return result


def vector(value, label):
    if not isinstance(value, (list, tuple)) or len(value) != FEATURE_COUNT:
        raise ValueError(label + " must contain exactly eight values")
    return [finite_number(item, label) for item in value]


def validate_recipe(recipe):
    """Reject a different numerical recipe rather than selecting a fallback."""
    if not isinstance(recipe, dict) or recipe.get("id") != CANDIDATE_ID:
        raise ValueError("Need the frozen local LAD candidate recipe")
    optimizer = recipe.get("optimizer")
    if not isinstance(optimizer, dict):
        raise ValueError("Need the fixed optimizer specification")
    options = optimizer.get("options")
    if (optimizer.get("implementation") != "scipy.optimize.linprog"
            or optimizer.get("method") != METHOD
            or type(optimizer.get("attempts")) is not int
            or optimizer["attempts"] != 1
            or not isinstance(options, dict) or set(options) != set(OPTIONS)
            or any(type(options[k]) is not type(v) or options[k] != v
                   for k, v in OPTIONS.items())):
        raise ValueError("Frozen solver, options or single-attempt policy changed")
    acceptance = optimizer.get("acceptance")
    if (not isinstance(acceptance, dict)
            or finite_number(acceptance.get("maxConstraintViolationMgL"),
                             "constraint tolerance") != CONSTRAINT_TOLERANCE
            or finite_number(acceptance.get("objectiveRecompositionToleranceMgL"),
                             "objective tolerance") != OBJECTIVE_TOLERANCE):
        raise ValueError("Frozen numerical acceptance tolerances changed")
    return dict(options)


def validate_model_components(model):
    """Validate and detach just the scaler and coefficients, never refitting."""
    if not isinstance(model, dict):
        raise ValueError("Model must be an object")
    pre = model.get("preprocessing")
    coefficients = model.get("coefficients")
    if not isinstance(pre, dict) or not isinstance(coefficients, dict):
        raise ValueError("Need frozen preprocessing and coefficients")
    means = vector(pre.get("means"), "means")
    variances = vector(pre.get("variances"), "variances")
    scales = vector(pre.get("scales"), "scales")
    weights = vector(coefficients.get("weights"), "weights")
    mask = pre.get("constantMask")
    if (not isinstance(mask, (list, tuple)) or len(mask) != FEATURE_COUNT
            or any(type(flag) is not bool for flag in mask)):
        raise ValueError("Need exactly eight boolean constant-mask entries")
    for j in range(FEATURE_COUNT):
        if variances[j] < 0 or scales[j] <= 0:
            raise ValueError("Variance must be nonnegative and scale positive")
        if mask[j] != (variances[j] == 0):
            raise ValueError("Constant mask must match exactly zero variance")
        if mask[j]:
            if scales[j] != 1 or weights[j] != 0:
                raise ValueError("Constant feature needs scale one and weight zero")
        elif scales[j] != math.sqrt(variances[j]):
            raise ValueError("Frozen scale must equal sqrt(population variance)")
    return {
        "preprocessing": {"means": means, "variances": variances,
                          "scales": scales, "constantMask": list(mask)},
        "coefficients": {
            "intercept": finite_number(coefficients.get("intercept"), "intercept"),
            "weights": weights,
        },
    }


def freeze_model_components(model):
    """Return a detached JSON-compatible prediction payload; no file mutation."""
    return validate_model_components(model)


def transformed(features, preprocessing):
    values = vector(features, "features")
    return [0.0 if preprocessing["constantMask"][j]
            else (values[j] - preprocessing["means"][j]) / preprocessing["scales"][j]
            for j in range(FEATURE_COUNT)]


def _predict(components, features, persistence):
    p = finite_number(persistence, "persistence")
    if p < 0:
        raise ValueError("Persistence must be nonnegative")
    z = transformed(features, components["preprocessing"])
    coefficient = components["coefficients"]
    try:
        delta = math.fsum([coefficient["intercept"]] + [
            coefficient["weights"][j] * z[j] for j in range(FEATURE_COUNT)])
    except (OverflowError, ValueError) as exc:
        raise ValueError("Prediction arithmetic is nonfinite or overflowed") from exc
    # Keep raw negative/nonfinite predictions: the caller must record invalids
    # on its complete cohort, not clip, omit, round, or replace them by P.
    return {"deltaHat": delta, "prediction": p + delta}


def predict(model, features, persistence):
    """Apply the frozen mask/scaler/weights in order, then add current P."""
    return _predict(validate_model_components(model), features, persistence)


def fit_lad(rows, recipe):
    """Fit once on precisely the caller-supplied ordered training rows.

    Each row has features[8], actual and persistence. This function does not
    know or discover months; the caller must pass only its bound July cohort.
    All statistics and diagnostic denominators use every supplied row.
    """
    import numpy as np

    options = validate_recipe(recipe)
    if not isinstance(rows, list) or not rows:
        raise ValueError("Need a nonempty ordered training-row list")
    x, actual, persistence, delta = [], [], [], []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Each training row must be an object")
        x.append(vector(row.get("features"), "features"))
        y = finite_number(row.get("actual"), "actual")
        p = finite_number(row.get("persistence"), "persistence")
        if y < 0 or p < 0:
            raise ValueError("Published actual and persistence must be nonnegative")
        actual.append(y)
        persistence.append(p)
        delta.append(finite_number(y - p, "target delta"))
    n = len(rows)
    try:
        means = [math.fsum(row[j] for row in x) / n for j in range(FEATURE_COUNT)]
        variances = [math.fsum((row[j] - means[j]) * (row[j] - means[j])
                               for row in x) / n for j in range(FEATURE_COUNT)]
        mask = [value == 0 for value in variances]
        scales = [1.0 if mask[j] else math.sqrt(variances[j])
                  for j in range(FEATURE_COUNT)]
    except (OverflowError, ValueError) as exc:
        raise ValueError("Training preprocessing arithmetic failed") from exc
    pre = {"means": means, "variances": variances,
           "scales": scales, "constantMask": mask}
    # Validate derived statistics before constructing or calling any optimizer.
    skeleton = {"preprocessing": pre,
                "coefficients": {"intercept": 0.0, "weights": [0.0] * FEATURE_COUNT}}
    validate_model_components(skeleton)
    z = np.asarray([transformed(row, pre) for row in x], dtype=np.float64)
    if not np.isfinite(z).all():
        raise ValueError("Training standardized features must be finite")
    design = np.column_stack((np.ones(n, dtype=np.float64), z))
    identity = np.eye(n, dtype=np.float64)
    a_ub = np.block([[design, -identity], [-design, -identity]])
    b_ub = np.asarray(delta + [-value for value in delta], dtype=np.float64)
    objective = np.asarray([0.0] * 9 + [1.0 / n] * n, dtype=np.float64)
    bounds = [(None, None)] + [(0, 0) if flag else (None, None) for flag in mask]
    bounds += [(0, None)] * n
    # A warning is a recorded failure, never permission to change the solver.
    try:
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always")
            result = linprog(c=objective, A_ub=a_ub, b_ub=b_ub,
                             bounds=bounds, method=METHOD, options=options)
    except Exception as exc:
        raise ValueError("Single frozen LAD optimizer attempt failed") from exc
    if captured:
        raise ValueError("LAD optimizer warning: " + "; ".join(str(w.message) for w in captured))
    if getattr(result, "success", None) is not True or getattr(result, "status", None) != 0:
        raise ValueError("LAD optimizer did not succeed: " + str(getattr(result, "message", "")))
    try:
        solution = np.asarray(result.x, dtype=np.float64)
        marginals = np.asarray(result.ineqlin.marginals, dtype=np.float64)
        inequality_slacks = np.asarray(result.ineqlin.residual, dtype=np.float64)
        raw_lower = getattr(getattr(result, "lower", None), "marginals", None)
        lower_marginals = (None if raw_lower is None
                           else np.asarray(raw_lower, dtype=np.float64))
        solver_objective = finite_number(result.fun, "solver objective")
        if (solution.shape != (9 + n,) or not np.isfinite(solution).all()
                or marginals.shape != (2 * n,) or not np.isfinite(marginals).all()
                or inequality_slacks.shape != (2 * n,)
                or not np.isfinite(inequality_slacks).all()
                or lower_marginals is not None and (
                    lower_marginals.shape != (9 + n,)
                    or not np.isfinite(lower_marginals).all())
                or not isinstance(result.message, str)
                or isinstance(result.nit, bool) or not isinstance(result.nit, (int, np.integer))
                or result.nit < 0):
            raise ValueError("Malformed or nonfinite optimizer result")
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("Malformed or nonfinite optimizer result") from exc
    coefficients = {"intercept": float(solution[0]), "weights": solution[1:9].tolist()}
    components = validate_model_components({"preprocessing": pre, "coefficients": coefficients})
    slacks = solution[9:].tolist()
    predictions = [_predict(components, x[i], persistence[i]) for i in range(n)]
    if any(not math.isfinite(item["deltaHat"]) or not math.isfinite(item["prediction"])
           for item in predictions):
        raise ValueError("Training prediction arithmetic is nonfinite")
    residuals = [delta[i] - predictions[i]["deltaHat"] for i in range(n)]
    constraint_violation = max([0.0] + [-value for value in slacks]
                               + [abs(residuals[i]) - slacks[i] for i in range(n)])
    residual_mae = math.fsum(abs(value) for value in residuals) / n
    slack_mean = math.fsum(slacks) / n
    objective_difference = abs(solver_objective - residual_mae)
    mae_persistence = math.fsum(abs(persistence[i] - actual[i]) for i in range(n)) / n
    mae_candidate = math.fsum(abs(predictions[i]["prediction"] - actual[i])
                              for i in range(n)) / n
    diagnostics = [constraint_violation, residual_mae, slack_mean, objective_difference,
                   mae_persistence, mae_candidate]
    if not all(math.isfinite(value) for value in diagnostics):
        raise ValueError("Training acceptance diagnostics must be finite")
    if constraint_violation > CONSTRAINT_TOLERANCE:
        raise ValueError("LAD constraint acceptance check failed")
    if (objective_difference > OBJECTIVE_TOLERANCE
            or abs(solver_objective - slack_mean) > OBJECTIVE_TOLERANCE):
        raise ValueError("LAD objective recomposition check failed")
    if mae_candidate > mae_persistence + TRAINING_TOLERANCE:
        raise ValueError("LAD training sanity check failed")
    return {
        **components,
        "solver": {"method": METHOD, "options": options, "success": True,
                   "status": 0, "message": result.message, "nit": int(result.nit),
                   "objective": solver_objective, "slacks": slacks,
                   "absoluteResidualBounds": list(slacks),
                   "inequalitySlacks": inequality_slacks.tolist(),
                   "inequalityMarginals": marginals.tolist(),
                   "lowerMarginals": (None if lower_marginals is None
                                      else lower_marginals.tolist())},
        "trainingDiagnostics": {
            "pairs": n, "maePersistence": mae_persistence,
            "maeCandidate": mae_candidate, "deltaResidualMAE": residual_mae,
            "maxConstraintViolation": constraint_violation,
            "objectiveDifference": objective_difference,
        },
    }
