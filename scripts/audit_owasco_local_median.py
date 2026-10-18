"""Independent stdlib algebra audit of saved Owasco LAD artifacts; never refit.

This module imports neither the production runner, core, data loader, nor
metadata preflight. Default mode reads July only. --report additionally verifies
the already-created August report. No mode writes files or acquires observations.
"""
import argparse
import gzip
import hashlib
import json
import math
import re
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = "docs/datasets/owasco-local-median/protocol.json"
PROTOCOL_SHA = "e92fa18d16ed82b72e45089e8a0c86d9f49c924ce8cd449aec090a9cd34e6b51"
FREEZE = "docs/evidence/owasco-local-median/implementation-freeze.json"
MODEL = "docs/evidence/owasco-local-median/frozen-model.json"
REPORT = "docs/evidence/owasco-local-median/development.json.gz"
SUMMARY = "docs/evidence/owasco-local-median/development-summary.json"
FEATURES = ["oxygenNow", "oxygenDelta30m", "oxygenDelta2h", "oxygenDelta5h30m",
            "clockSinUTC", "clockCosUTC", "temperatureNow", "temperatureDelta2h"]
COHORTS = {
    "training": {"id": "july-2020", "file": "docs/evidence/owasco-lake-transfer/evaluation.json",
                 "rawSha256": "7bd27ec609a7c4f471385498b61fff7b9d74546de13711559e84fcb16536ff85",
                 "pairs": 1275, "start": "2020-07-01T00:00:00Z", "end": "2020-07-29T00:00:00Z",
                 "folder": "docs/datasets/owasco-lake-transfer", "windowId": "owasco-july-2020"},
    "development": {"id": "august-2020", "file": "docs/evidence/owasco-temporal-validation/evaluation.json",
                    "rawSha256": "65e1b3793c78982e1496eaf9b3e56e8157d684b6df84343ed5f5b5e0abe98853",
                    "pairs": 1306, "start": "2020-08-01T00:00:00Z", "end": "2020-08-29T00:00:00Z",
                    "folder": "docs/datasets/owasco-temporal-validation", "windowId": "owasco-august-2020"},
}
TOL = 1e-9
CERT_TOL = 1e-7
STATION = "USGS-425327076313601"
P = "persistence"
R = "same-frozen-ridge-without-fallback"
CODE_FILES = (
    "scripts/owasco_local_median.py", "scripts/owasco_lad_core.py", "scripts/owasco_lad_data.py",
    "scripts/owasco_lad_environment.py", "scripts/owasco_local_median_preflight.py",
    "scripts/audit_owasco_local_median.py", "scripts/requirements-owasco-lad.txt",
)


def finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def number(value, label):
    if not finite(value):
        raise ValueError("Nonfinite or non-real field: " + label)
    return value


def vector(value, size, label):
    if not isinstance(value, list) or len(value) != size or not all(finite(x) for x in value):
        raise ValueError("Invalid numerical vector: " + label)
    return value


def require(condition, label):
    if not condition:
        raise ValueError(label)


def close(left, right, label, tolerance=TOL):
    require(finite(left) and finite(right) and abs(left-right) <= tolerance,
            "Arithmetic mismatch: " + label)


def reject_constant(value):
    raise ValueError("Non-standard JSON numeric constant")


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def loads(raw):
    return json.loads(raw, object_pairs_hook=unique_pairs, parse_constant=reject_constant)


def path(root, name):
    require(isinstance(name, str) and name and ":" not in name and "\\" not in name
            and not name.startswith("/") and all(p not in ("", ".", "..") for p in name.split("/")),
            "Unsafe repository-relative audit path")
    root = Path(root).resolve()
    result = (root / name).resolve()
    require(result.is_relative_to(root), "Audit path escapes repository")
    return result


def raw_read(root, name):
    raw = path(root, name).read_bytes()
    return raw, hashlib.sha256(raw).hexdigest()


def document(root, name):
    raw, digest = raw_read(root, name)
    return loads(gzip.decompress(raw) if name.endswith(".gz") else raw), digest


def instant(value):
    require(isinstance(value, str), "Timestamp must be a string")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(stamp.utcoffset() == timedelta(0), "Timestamp must be aware UTC")
    return stamp


def source_bindings(spec, role):
    require(isinstance(role, str) and role in COHORTS, "Unknown audit cohort role")
    expected = COHORTS[role]
    candidates = [item for item in spec["cohorts"] if item.get("role") == role]
    require(len(candidates) == 1, "Need one exact cohort per role")
    selected = candidates[0]
    for key in ("id", "file", "rawSha256", "pairs"):
        require(type(selected[key]) is type(expected[key]) and selected[key] == expected[key],
                "Fixed cohort commitment changed: " + key)
    require(selected["window"] == {"start": expected["start"], "end": expected["end"]},
            "Fixed cohort window changed")
    preserved = {item["file"]: item["rawSha256"] for item in spec["preservedFiles"]}
    require(len(preserved) == len(spec["preservedFiles"]), "Duplicate preservation pin")
    result = [{"kind": "evaluation", "file": selected["file"], "rawSha256": selected["rawSha256"]}]
    for kind in ("oxygen", "temperature"):
        name = expected["folder"] + "/" + kind + ".json.gz"
        require(name in preserved, "Missing raw source preservation pin")
        result.append({"kind": kind, "file": name, "rawSha256": preserved[name]})
    return result


def read_cohort(root, spec, role):
    bindings = source_bindings(spec, role)
    raw_files = {}
    for item in bindings:
        raw, digest = raw_read(root, item["file"])
        require(digest == item["rawSha256"], "Bound selected-role source hash changed")
        raw_files[item["kind"]] = raw
    source = loads(raw_files["evaluation"])
    fixed = COHORTS[role]
    require(source["stationId"] == STATION and type(source["horizonSeconds"]) is int
            and source["horizonSeconds"] == 3600 and source["window"] == {
                "id": fixed["windowId"], "start": fixed["start"], "end": fixed["end"]},
            "Source station, horizon or window changed")
    rows = source["rows"]
    require(isinstance(rows, list) and len(rows) == fixed["pairs"], "Wrong full-cohort row count")
    records, previous, targets = [], None, set()
    for i, row in enumerate(rows):
        origin, target = instant(row["origin"]), instant(row["target"])
        history = row["oxygenHistory"]
        require(target-origin == timedelta(hours=1) and origin.minute in (0, 30)
                and not origin.second and not origin.microsecond
                and (previous is None or origin > previous) and target not in targets,
                "Invalid source chronology or horizon")
        require(isinstance(history, list) and len(history) == 12
                and [instant(h["timeUTC"]) for h in history] == [origin-timedelta(minutes=30*j) for j in range(11, -1, -1)]
                and instant(history[0]["timeUTC"]) >= instant(fixed["start"])
                and target <= instant(fixed["end"]), "Invalid exact source history or window bounds")
        values = [number(h["value"], "history") for h in history]
        require(all(v >= 0 for v in values), "Negative oxygen history")
        p, actual = number(row["predictionsMgL"][P], "P"), number(row["actual"], "actual")
        x = vector(row["features"], 8, "features")
        require(actual >= 0 and p == values[-1] and x[:4] == [values[-1], values[-1]-values[-2],
                values[-1]-values[-5], values[-1]-values[0]], "Source oxygen features/P disagree")
        clock = (origin.hour*3600 + origin.minute*60 + origin.second)/86400*2*math.pi
        close(x[4], math.sin(clock), "clock sine", 1e-12)
        close(x[5], math.cos(clock), "clock cosine", 1e-12)
        records.append({"index": i, "origin": row["origin"], "target": row["target"], "actual": actual,
                        "persistence": p, "features": x, "oldR": number(row["predictionsMgL"][R], "old R")})
        previous = origin
        targets.add(target)
    return records, bindings


def check_components(model, rows):
    n = len(rows)
    require(n > 0, "Need training rows")
    pre, coefficients = model["preprocessing"], model["coefficients"]
    for key in ("means", "variances", "scales"):
        vector(pre[key], 8, key)
    weights = vector(coefficients["weights"], 8, "weights")
    number(coefficients["intercept"], "intercept")
    mask = pre["constantMask"]
    require(isinstance(mask, list) and len(mask) == 8 and all(type(flag) is bool for flag in mask), "Invalid constant mask")
    means = [math.fsum(r["features"][j] for r in rows)/n for j in range(8)]
    variances = [math.fsum((r["features"][j]-means[j])*(r["features"][j]-means[j]) for r in rows)/n for j in range(8)]
    for j in range(8):
        close(pre["means"][j], means[j], "training mean")
        close(pre["variances"][j], variances[j], "population variance")
        require(mask[j] == (variances[j] == 0) and pre["variances"][j] >= 0 and pre["scales"][j] > 0,
                "Invalid variance, mask or scale")
        expected_scale = 1.0 if variances[j] == 0 else math.sqrt(variances[j])
        close(pre["scales"][j], expected_scale, "training scale")
        if mask[j]:
            require(pre["scales"][j] == 1 and weights[j] == 0, "Constant coefficient must be fixed to zero")
    return {"reconstructedTrainingRows": n, "scalerVerified": True, "constantMaskVerified": True}


def design_row(model, row):
    pre = model["preprocessing"]
    return [1.0] + [0.0 if pre["constantMask"][j] else
                    (row["features"][j]-pre["means"][j])/pre["scales"][j] for j in range(8)]


def prediction(model, row):
    x = design_row(model, row)
    theta = [model["coefficients"]["intercept"]] + model["coefficients"]["weights"]
    delta = math.fsum(theta[j]*x[j] for j in range(9))
    return delta, row["persistence"] + delta


def certificate(model, rows):
    """Check primal feasibility and a dual LAD optimality certificate, no solver."""
    n = len(rows)
    require(n > 0, "Need a nonempty certificate cohort")
    solver = model["solver"]
    require(solver["success"] is True and type(solver["status"]) is int and solver["status"] == 0,
            "Saved solver did not succeed")
    u = vector(solver["absoluteResidualBounds"], n, "absolute residual bounds")
    slacks = vector(solver["inequalitySlacks"], 2*n, "inequality slacks")
    marginals = vector(solver["inequalityMarginals"], 2*n, "inequality marginals")
    objective = number(solver["objective"], "objective")
    if "slacks" in solver:
        require(vector(solver["slacks"], n, "legacy u alias") == u, "Saved u aliases differ")
    designs = [design_row(model, row) for row in rows]
    outputs = [prediction(model, row) for row in rows]
    require(all(finite(d) and finite(p) for d, p in outputs), "Training prediction is nonfinite")
    deltas = [row["actual"]-row["persistence"] for row in rows]
    residuals = [deltas[i]-outputs[i][0] for i in range(n)]
    reconstructed_slacks = [u[i]+residuals[i] for i in range(n)] + [u[i]-residuals[i] for i in range(n)]
    primal_violation = max([0.0] + [-v for v in u] + [abs(residuals[i])-u[i] for i in range(n)])
    require(primal_violation <= CERT_TOL, "Primal LAD feasibility failed")
    for observed, expected in zip(slacks, reconstructed_slacks):
        close(observed, expected, "saved inequality slack", CERT_TOL)
    require(min(slacks) >= -CERT_TOL and max(marginals) <= CERT_TOL,
            "Inequality slack or marginal sign failed")
    q = [marginals[i]-marginals[n+i] for i in range(n)]
    free = [0] + [j+1 for j, fixed in enumerate(model["preprocessing"]["constantMask"]) if not fixed]
    stationarity = max(abs(math.fsum(designs[i][j]*q[i] for i in range(n))) for j in free)
    require(stationarity <= CERT_TOL, "Free coefficient dual stationarity failed")
    reduced = [1.0/n + marginals[i]+marginals[n+i] for i in range(n)]
    require(min(reduced) >= -CERT_TOL, "Residual-bound reduced cost sign failed")
    if solver.get("lowerMarginals") is not None:
        lower = vector(solver["lowerMarginals"], n+9, "lower-bound marginals")
        for j in free:
            close(lower[j], 0.0, "free coefficient lower marginal", CERT_TOL)
        for i in range(n):
            close(lower[9+i], reduced[i], "residual-bound lower marginal", CERT_TOL)
    complementarity = max([abs(u[i]*reduced[i]) for i in range(n)] +
                          [abs(slacks[i]*marginals[i]) for i in range(2*n)])
    require(complementarity <= CERT_TOL, "LAD complementarity failed")
    primal, dual = math.fsum(u)/n, math.fsum(deltas[i]*q[i] for i in range(n))
    gap = abs(primal-dual)
    require(gap <= CERT_TOL, "LAD primal-dual objective gap failed")
    residual_mae = math.fsum(abs(x) for x in residuals)/n
    close(objective, primal, "solver/primal objective")
    close(objective, residual_mae, "solver/residual objective")
    saved = model["trainingDiagnostics"]
    require(type(saved["pairs"]) is int and saved["pairs"] == n, "Wrong training diagnostic count")
    p_mae = math.fsum(abs(r["persistence"]-r["actual"]) for r in rows)/n
    l_mae = math.fsum(abs(outputs[i][1]-rows[i]["actual"]) for i in range(n))/n
    for key, actual in (("maePersistence", p_mae), ("maeCandidate", l_mae),
                        ("deltaResidualMAE", residual_mae), ("maxConstraintViolation", primal_violation),
                        ("objectiveDifference", abs(objective-residual_mae))):
        close(saved[key], actual, "training diagnostic " + key)
    require(l_mae <= p_mae+CERT_TOL, "Training sanity check failed")
    return {"rows": n, "primalObjective": primal, "dualObjective": dual,
            "absoluteDualityGap": gap, "maximumConstraintViolation": primal_violation,
            "maximumFreeCoefficientStationarity": stationarity,
            "maximumComplementarityResidual": complementarity,
            "maePersistenceMgL": p_mae, "maeCandidateMgL": l_mae,
            "negativeTrainingPredictions": sum(p < 0 for _, p in outputs), "certificatePassed": True}


def safe(value):
    return value if finite(value) else None


def mean(values):
    if not values or not all(finite(v) for v in values):
        return None
    try:
        return safe(math.fsum(values)/len(values))
    except (OverflowError, ValueError):
        return None


def report_row(model, row):
    try:
        delta, forecast = prediction(model, row)
    except (OverflowError, ValueError):
        delta = forecast = None
    actual, p, old = row["actual"], row["persistence"], row["oldR"]
    errors = {"P": safe(abs(p-actual)), "L": safe(abs(forecast-actual)) if finite(forecast) else None,
              "oldR": safe(abs(old-actual))}
    gain = safe(errors["P"]-errors["L"]) if errors["L"] is not None else None
    valid = finite(forecast) and forecast >= 0
    outcome = "invalid" if not valid or gain is None else "helps" if gain > TOL else "harms" if gain < -TOL else "ties"
    return {"sourceRowIndex": row["index"], "origin": row["origin"], "target": row["target"],
            "actualMgL": actual, "persistenceMgL": p, "oldRMgL": old,
            "deltaHatMgL": safe(delta), "predictionMgL": safe(forecast), "candidateValid": valid,
            "predictionChanged": forecast != p if finite(forecast) else None, "absoluteErrorsMgL": errors,
            "gainAgainstPersistenceMgL": gain, "signedErrorMgL": safe(forecast-actual) if finite(forecast) else None,
            "outcome": outcome}


def summarize(records):
    errors = [r["absoluteErrorsMgL"]["L"] for r in records]
    return {"pairs": len(records), "maePersistenceMgL": mean([r["absoluteErrorsMgL"]["P"] for r in records]),
            "maeCandidateMgL": mean(errors), "maeOldRMgL": mean([r["absoluteErrorsMgL"]["oldR"] for r in records]),
            "meanGainAgainstPersistenceMgL": mean([r["gainAgainstPersistenceMgL"] for r in records]),
            "meanSignedErrorMgL": mean([r["signedErrorMgL"] for r in records]),
            "maxCandidateAbsoluteErrorMgL": max(errors, default=None) if all(e is not None for e in errors) else None,
            "invalidPredictions": sum(not r["candidateValid"] for r in records),
            "changedPredictions": sum(r["predictionChanged"] is True for r in records)}


def compare(saved, expected, label):
    """Compare selected independent facts; runner replay checks the full schema."""
    if isinstance(expected, dict):
        require(isinstance(saved, dict), "Missing object: " + label)
        for key, value in expected.items():
            require(key in saved, "Missing field: " + label + "." + key)
            compare(saved[key], value, label + "." + key)
    elif isinstance(expected, list):
        require(isinstance(saved, list) and len(saved) == len(expected), "Wrong array size: " + label)
        for i, (left, right) in enumerate(zip(saved, expected)):
            compare(left, right, label + "[" + str(i) + "]")
    elif type(expected) in (int, bool) or expected is None or isinstance(expected, str):
        require(type(saved) is type(expected) and saved == expected, "Changed exact field: " + label)
    else:
        close(saved, expected, label)


def check_report(saved, model, rows):
    records = [report_row(model, row) for row in rows]
    compare(saved["rows"], records, "report rows")
    summary = summarize(records)
    compare(saved["summary"], summary, "summary")
    groups = {label: summarize([r for r in records if r["outcome"] == label]) for label in ("helps", "ties", "harms", "invalid")}
    days = {day: summarize([r for r in records if r["origin"][:10] == day]) for day in sorted({r["origin"][:10] for r in records})}
    require(set(saved["outcomeGroups"]) == set(groups) and set(saved["utcDays"]) == set(days), "Group/day keys changed")
    compare(saved["outcomeGroups"], groups, "groups")
    compare(saved["utcDays"], days, "UTC days")
    examples = {label: next((r for r in records if r["outcome"] == label), None) for label in ("helps", "harms")}
    compare(saved["examples"], examples, "first chronological examples")
    gain = None if summary["maeCandidateMgL"] is None else summary["maePersistenceMgL"]-summary["maeCandidateMgL"]
    passed = summary["invalidPredictions"] == 0 and gain is not None and gain > TOL
    compare(saved["decision"], {"gainMgL": gain, "numericalToleranceMgL": TOL, "passedDevelopmentScreen": passed,
                                "primaryMetric": "Full-cohort August MAE against persistence",
                                "status": "DEVELOPMENT_GAIN_ONLY" if passed else "STOP_CANDIDATE",
                                "independentValidation": False, "septemberOpened": False}, "decision")
    return {"rows": len(rows), "summary": summary, "passedDevelopmentScreen": passed, "groupsAndDaysVerified": True,
            "allRowArithmeticAndFirstExamplesVerified": True}


def audit(root=ROOT, include_development=False):
    require(type(include_development) is bool, "Development audit flag must be boolean")
    spec, protocol_hash = document(root, PROTOCOL)
    require(protocol_hash == PROTOCOL_SHA and spec["stationId"] == STATION and spec["features"] == FEATURES
            and spec["horizonSeconds"] == 3600, "Frozen protocol changed")
    frozen, freeze_hash = document(root, FREEZE)
    require(frozen["version"] == "owasco-local-lad-implementation-freeze-v1"
            and frozen["protocolRawSha256"] == PROTOCOL_SHA
            and frozen["environmentalFitExecuted"] is False
            and frozen["candidatePredictionsOrScoresComputed"] is False, "Invalid implementation freeze")
    commit = frozen["implementationCommit"]
    require(isinstance(commit, str) and re.fullmatch("[0-9a-f]{40}", commit), "Invalid implementation commit syntax")
    files = frozen["codeFiles"]
    require(isinstance(files, list) and [item["file"] for item in files] == list(CODE_FILES),
            "Frozen code manifest files changed")
    for item in files:
        _, digest = raw_read(root, item["file"])
        require(digest == item["rawSha256"], "Frozen implementation code bytes changed")
    model, model_hash = document(root, MODEL)
    require(model["version"] == "owasco-july-local-lad-model-v1" and model["candidateId"] == spec["candidate"]["id"]
            and model["protocolRawSha256"] == PROTOCOL_SHA and model["implementationFreezeRawSha256"] == freeze_hash
            and model["implementationCommit"] == frozen["implementationCommit"]
            and model["features"] == FEATURES and type(model["trainingPairs"]) is int and model["trainingPairs"] == 1275
            and model["trainedOnlyOnJuly"] is True and model["developmentPredictionsComputed"] is False,
            "Frozen model provenance changed")
    require(model["solver"]["method"] == spec["candidate"]["optimizer"]["method"]
            and model["solver"]["options"] == spec["candidate"]["optimizer"]["options"],
            "Saved solver recipe differs from the protocol")
    rows, bindings = read_cohort(root, spec, "training")
    require(len(rows) == model["trainingPairs"], "Model/source training row counts differ")
    require(model["trainingSources"] == bindings, "Training source commitments differ")
    components = check_components(model, rows)
    proof = certificate(model, rows)
    result = {"version": "owasco-local-lad-independent-audit-v1", "status": "PASS",
              "protocolRawSha256": protocol_hash, "implementationFreezeRawSha256": freeze_hash,
              "modelRawSha256": model_hash, "training": {**components, **proof},
              "developmentOpened": include_development, "optimizerInvoked": False, "filesWritten": False,
              "productionModulesImported": False, "numericalLibraryImported": False,
              "codeManifestBytesVerified": True, "gitPublicationVerified": False,
              "limitation": "Independent stdlib algebra, same Codex model family; not independent environmental validation. No Git ancestry/publication or execution-history proof; runner checks these separately. Raw archive lineage is checked separately by the production loader."}
    if include_development:
        report, report_hash = document(root, REPORT)
        require(report["version"] == "owasco-august-local-lad-development-v1"
                and report["candidateId"] == spec["candidate"]["id"] and report["protocolRawSha256"] == PROTOCOL_SHA
                and report["modelFile"] == MODEL and report["modelRawSha256"] == model_hash
                and report["stationId"] == STATION and type(report["horizonSeconds"]) is int
                and report["horizonSeconds"] == 3600,
                "Development report provenance changed")
        require(isinstance(report["modelFreezeCommit"], str)
                and re.fullmatch("[0-9a-f]{40}", report["modelFreezeCommit"]), "Invalid model freeze commit syntax")
        development, dev_bindings = read_cohort(root, spec, "development")
        require(report["developmentSources"] == dev_bindings, "Development source commitments differ")
        result["development"] = check_report(report, model, development)
        summary, _ = document(root, SUMMARY)
        require(summary == {key: value for key, value in report.items() if key != "rows"}, "Separate summary differs from full report")
        result["developmentReportRawSha256"] = report_hash
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = audit(args.root, args.report)
    except (ValueError, OSError, KeyError, TypeError, OverflowError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
