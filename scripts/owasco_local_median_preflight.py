"""Metadata-only preflight for a proposed local Owasco median regression.

This module has no training, preprocessing, prediction or scoring functions.
Only timestamp and provenance identifiers are projected from archived rows.
"""
import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HALF_HOUR = timedelta(minutes=30)
HORIZON = timedelta(hours=1)
HISTORY_SAMPLES = 12
VERSION = "owasco-local-median-preflight-v1"
PROTOCOL_VERSION = "owasco-local-median-protocol-v1"
FEATURES = ["oxygenNow", "oxygenDelta30m", "oxygenDelta2h", "oxygenDelta5h30m",
            "clockSinUTC", "clockCosUTC", "temperatureNow", "temperatureDelta2h"]
STATION = "USGS-425327076313601"
MODEL_FILE = "docs/evidence/willamette-multiseason/frozen-model.json"
MODEL_SHA256 = "72d7d14221c7b14c173dba59d69d2a1d36cbb27ee146378b9e046eea998762c9"
COHORTS = [
    {"id": "july-2020", "role": "training",
     "file": "docs/evidence/owasco-lake-transfer/evaluation.json",
     "rawSha256": "7bd27ec609a7c4f471385498b61fff7b9d74546de13711559e84fcb16536ff85",
     "pairs": 1275, "window": {"start": "2020-07-01T00:00:00Z", "end": "2020-07-29T00:00:00Z"}},
    {"id": "august-2020", "role": "development",
     "file": "docs/evidence/owasco-temporal-validation/evaluation.json",
     "rawSha256": "65e1b3793c78982e1496eaf9b3e56e8157d684b6df84343ed5f5b5e0abe98853",
     "pairs": 1306, "window": {"start": "2020-08-01T00:00:00Z", "end": "2020-08-29T00:00:00Z"}},
]
WINDOW_IDS = {"july-2020": "owasco-july-2020", "august-2020": "owasco-august-2020"}
PREFLIGHT_SETTINGS = {
    "historyPoints": 12, "historyStepSeconds": 1800, "originGridSeconds": 1800,
    "requiredGapSeconds": 259200,
    "expectedLastTrainingTarget": "2020-07-29T00:00:00Z",
    "expectedFirstDevelopmentHistory": "2020-08-01T00:00:00Z",
}


def instant(value):
    """Parse an aware UTC timestamp without consulting an observation value."""
    if not isinstance(value, str) or not value:
        raise ValueError("Need a UTC timestamp string")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Malformed UTC timestamp") from exc
    if stamp.utcoffset() != timedelta(0):
        raise ValueError("Need timezone-aware UTC timestamps")
    return stamp


def stamp(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def identifier(value):
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("Need a nonempty provenance identifier")
    return value


def project_row(row):
    """Read only the approved metadata keys; values and labels are irrelevant."""
    if not isinstance(row, dict):
        raise ValueError("An archived metadata row must be an object")
    try:
        history = row["oxygenHistory"]
        evidence = row["evidence"]
        if not isinstance(history, list) or not isinstance(evidence, dict):
            raise ValueError("Need timestamp history and provenance metadata")
        oxygen_ids, temperature_ids = evidence["oxygen"], evidence["temperature"]
        if not isinstance(oxygen_ids, list) or not isinstance(temperature_ids, list):
            raise ValueError("Need provenance identifier arrays")
        return {
            "origin": instant(row["origin"]),
            "target": instant(row["target"]),
            "history": [instant(item["timeUTC"]) for item in history],
            "oxygenIds": [identifier(item) for item in oxygen_ids],
            "temperatureIds": [identifier(item) for item in temperature_ids],
            "targetId": identifier(evidence["targetOxygen"]),
        }
    except (KeyError, TypeError) as exc:
        raise ValueError("Missing or malformed timestamp/provenance metadata") from exc


def project_month(report):
    """Project a source report without inspecting actual/features/predictions."""
    if not isinstance(report, dict):
        raise ValueError("Source metadata report must be an object")
    try:
        rows = report["rows"]
        window = report["window"]
        if not isinstance(rows, list) or not isinstance(window, dict):
            raise ValueError("Need source rows and window metadata")
        return {
            "stationId": report["stationId"],
            "horizonSeconds": report["horizonSeconds"],
            "windowId": window["id"],
            "start": instant(window["start"]),
            "end": instant(window["end"]),
            "rows": [project_row(row) for row in rows],
        }
    except (KeyError, TypeError) as exc:
        raise ValueError("Missing source report metadata") from exc


def check_month(metadata, expected):
    """Validate one unchanged cohort, permitting archived gaps between origins."""
    rows = metadata["rows"]
    start, end = metadata["start"], metadata["end"]
    if (metadata["stationId"] != expected["stationId"]
            or type(metadata["horizonSeconds"]) is not int
            or metadata["horizonSeconds"] != 3600
            or metadata["windowId"] != expected["windowId"]
            or start != instant(expected["start"])
            or end != instant(expected["end"])
            or end - start != timedelta(days=28)
            or type(expected["pairs"]) is not int or expected["pairs"] <= 0
            or len(rows) != expected["pairs"]):
        raise ValueError("Source metadata differs from the fixed monthly cohort")
    origins, targets, histories = set(), set(), set()
    target_ids, oxygen_ids, temperature_ids = set(), set(), set()
    previous_origin = previous_target = None
    for row in rows:
        origin, target, history = row["origin"], row["target"], row["history"]
        if (target - origin != HORIZON or origin in origins or target in targets
                or origin.second or origin.microsecond or origin.minute not in (0, 30)
                or history != [origin - HALF_HOUR * j for j in range(11, -1, -1)]
                or history[0] < start or target > end
                or previous_origin is not None and origin <= previous_origin
                or previous_target is not None and target <= previous_target):
            raise ValueError("Invalid history, order, grid, horizon or source bounds")
        if (len(row["oxygenIds"]) != HISTORY_SAMPLES
                or len(set(row["oxygenIds"])) != HISTORY_SAMPLES
                or len(row["temperatureIds"]) != HISTORY_SAMPLES
                or len(set(row["temperatureIds"])) != HISTORY_SAMPLES
                or row["targetId"] in row["oxygenIds"]
                or row["targetId"] in target_ids):
            raise ValueError("Invalid or reused labelled/provenance identifier")
        origins.add(origin)
        targets.add(target)
        histories.update(history)
        oxygen_ids.update(row["oxygenIds"])
        temperature_ids.update(row["temperatureIds"])
        target_ids.add(row["targetId"])
        previous_origin, previous_target = origin, target
    receipt = {
        "pairs": len(rows),
        "firstOriginUTC": stamp(min(origins)),
        "lastOriginUTC": stamp(max(origins)),
        "firstTargetUTC": stamp(min(targets)),
        "lastTargetUTC": stamp(max(targets)),
        "earliestHistoryUTC": stamp(min(histories)),
        "latestHistoryUTC": stamp(max(histories)),
        "uniqueOriginCount": len(origins),
        "uniqueTargetCount": len(targets),
        "uniqueLabelIdCount": len(target_ids),
        "exactHistoryAndGridVerified": True,
    }
    return {"receipt": receipt, "origins": origins, "targets": targets,
            "histories": histories, "targetIds": target_ids,
            "oxygenIds": oxygen_ids, "temperatureIds": temperature_ids}


def check_split(training, development):
    """Reject temporal or provenance overlap without reading target values."""
    gap = min(development["histories"]) - max(training["targets"])
    intersections = {
        "labelTimestampOverlapCount": len(training["targets"] & development["targets"]),
        "trainingLabelInDevelopmentHistoryTimestampCount":
            len(training["targets"] & development["histories"]),
        "labelIdentifierOverlapCount": len(training["targetIds"] & development["targetIds"]),
        "trainingLabelInDevelopmentHistoryIdentifierCount":
            len(training["targetIds"] & development["oxygenIds"]),
        "historyTimestampOverlapCount": len(training["histories"] & development["histories"]),
        "historyIdentifierOverlapCount": len(training["oxygenIds"] & development["oxygenIds"]),
        "temperatureHistoryIdentifierOverlapCount":
            len(training["temperatureIds"] & development["temperatureIds"]),
    }
    if gap <= timedelta(0) or any(intersections.values()):
        raise ValueError("Training and development timestamp/provenance evidence overlaps")
    return {
        "latestTrainingTargetUTC": stamp(max(training["targets"])),
        "earliestDevelopmentHistoryUTC": stamp(min(development["histories"])),
        "targetToHistoryGapSeconds": int(gap.total_seconds()),
        **intersections,
        "noMechanicalOverlap": True,
    }


def reject_constant(value):
    raise ValueError("Non-standard JSON constant is not permitted")


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key is not permitted")
        result[key] = value
    return result


def loads(raw):
    try:
        return json.loads(raw, object_pairs_hook=no_duplicates, parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Malformed JSON document") from exc


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def safe_path(root, relative):
    """Reject ambiguous paths and symlinks escaping the selected repository."""
    if (not isinstance(relative, str) or not relative or "\\" in relative
            or ":" in relative or relative.startswith("/")
            or any(part in ("", ".", "..") for part in relative.split("/"))):
        raise ValueError("Need a safe repository-relative path")
    root = Path(root).resolve()
    result = (root / relative).resolve()
    if not result.is_relative_to(root):
        raise ValueError("Repository-relative path escapes the repository")
    return result


def validate_protocol(spec):
    """Check metadata commitments, not the future numerical recipe or solver."""
    if not isinstance(spec, dict):
        raise ValueError("Protocol must be an object")
    if (spec.get("version") != PROTOCOL_VERSION
            or spec.get("status") != "PROTOCOL_ONLY_NO_ENVIRONMENTAL_FIT"
            or spec.get("stationId") != STATION
            or type(spec.get("horizonSeconds")) is not int
            or spec["horizonSeconds"] != 3600
            or spec.get("features") != FEATURES):
        raise ValueError("Protocol phase, station, horizon or features changed")
    cohorts = spec.get("cohorts")
    if not isinstance(cohorts, list) or len(cohorts) != 2:
        raise ValueError("Need the two fixed training/development cohorts")
    for actual, expected in zip(cohorts, COHORTS):
        if (not isinstance(actual, dict) or set(actual) != set(expected)
                or actual != expected or type(actual.get("pairs")) is not int):
            raise ValueError("Fixed cohort roles, hashes, counts or windows changed")
    settings = spec.get("preflight")
    prose_keys = {"allowedFields", "scopeLimit"}
    if (not isinstance(settings, dict)
            or set(settings) != set(PREFLIGHT_SETTINGS) | prose_keys
            or any(settings[k] != expected for k, expected in PREFLIGHT_SETTINGS.items())
            or any(not isinstance(settings[k], str) or not settings[k].strip() for k in prose_keys)
            or any(type(settings[k]) is not int for k in
                   ("historyPoints", "historyStepSeconds", "originGridSeconds", "requiredGapSeconds"))):
        raise ValueError("Fixed metadata preflight settings changed")
    preserved = spec.get("preservedFiles")
    if not isinstance(preserved, list) or not preserved:
        raise ValueError("Need the historical preservation commitments")
    seen = set()
    for item in preserved:
        if (not isinstance(item, dict) or set(item) != {"file", "rawSha256"}
                or not isinstance(item["file"], str) or item["file"] in seen
                or not isinstance(item["rawSha256"], str) or len(item["rawSha256"]) != 64
                or any(c not in "0123456789abcdef" for c in item["rawSha256"])):
            raise ValueError("Invalid or duplicate historical preservation commitment")
        seen.add(item["file"])
    if {item["file"]: item["rawSha256"] for item in preserved}.get(MODEL_FILE) != MODEL_SHA256:
        raise ValueError("Original ridge model preservation commitment is missing or changed")
    return spec


def verify_bound_files(root, spec):
    """Hash every binding before any archived row metadata can be projected."""
    commitments = {}
    for item in spec["cohorts"] + spec["preservedFiles"]:
        path, expected = item["file"], item["rawSha256"]
        if path in commitments and commitments[path] != expected:
            raise ValueError("Conflicting raw hash commitments")
        commitments[path] = expected
    raw_files = {}
    for name in sorted(commitments):
        raw = safe_path(root, name).read_bytes()
        if sha256(raw) != commitments[name]:
            raise ValueError("Pinned source or historical evidence bytes changed: " + name)
        raw_files[name] = raw
    return raw_files, [{"file": name, "rawSha256": commitments[name]}
                       for name in sorted(commitments)]


def inspect_bound_metadata(raw_files, spec):
    """Inspect approved metadata only after all hashes have passed."""
    checked = []
    for cohort in spec["cohorts"]:
        expected = {"stationId": spec["stationId"], "windowId": WINDOW_IDS[cohort["id"]],
                    "pairs": cohort["pairs"], **cohort["window"]}
        checked.append(check_month(project_month(loads(raw_files[cohort["file"]])), expected))
    split = check_split(*checked)
    settings = spec["preflight"]
    if (split["targetToHistoryGapSeconds"] != settings["requiredGapSeconds"]
            or instant(split["latestTrainingTargetUTC"]) != instant(settings["expectedLastTrainingTarget"])
            or instant(split["earliestDevelopmentHistoryUTC"]) != instant(settings["expectedFirstDevelopmentHistory"])):
        raise ValueError("Fixed training/development temporal extrema or gap changed")
    return [{"id": cohort["id"], "role": cohort["role"], "file": cohort["file"],
             "rawSha256": cohort["rawSha256"], **result["receipt"]}
            for cohort, result in zip(spec["cohorts"], checked)], split


def preflight(protocol_path, root=ROOT):
    root = Path(root).resolve()
    protocol_path = Path(protocol_path)
    if protocol_path.is_absolute():
        resolved = protocol_path.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("Protocol must be inside the selected repository")
    else:
        resolved = safe_path(root, protocol_path.as_posix())
    protocol_raw = resolved.read_bytes()
    spec = validate_protocol(loads(protocol_raw))
    raw_files, bindings = verify_bound_files(root, spec)
    cohorts, split = inspect_bound_metadata(raw_files, spec)
    return {
        "version": VERSION,
        "scope": "metadata-only",
        "protocolFile": resolved.relative_to(root).as_posix(),
        "protocolRawSHA256": sha256(protocol_raw),
        "stationId": spec["stationId"],
        "horizonSeconds": 3600,
        "boundFiles": bindings,
        "preservedFilesCount": len(spec["preservedFiles"]),
        "allBoundFilesVerifiedBeforeMetadataProjection": True,
        "cohorts": cohorts,
        "split": split,
        "fitExecuted": False,
        "preprocessingExecuted": False,
        "candidatePredictionsComputed": False,
        "candidateScoringExecuted": False,
        "newObservationsAcquired": False,
        "futureTrainingImplementationReviewed": False,
        "limitation": "Timestamp/hash integrity does not validate a future numerical recipe or its implementation.",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--protocol", required=True, type=Path)
    parser.add_argument("--root", type=Path, default=ROOT)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path)
    mode.add_argument("--verify-report", type=Path)
    args = parser.parse_args(argv)
    try:
        report = preflight(args.protocol, args.root)
        raw = encoded(report)
        if args.verify_report:
            if encoded(loads(args.verify_report.read_bytes())) != raw:
                raise ValueError("Metadata preflight receipt differs from deterministic replay")
        else:
            # Exclusive creation preserves an existing receipt; no directories are made implicitly.
            with args.output.open("xb") as handle:
                handle.write(raw)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(raw.decode("utf-8"), end="")


if __name__ == "__main__":
    main()
