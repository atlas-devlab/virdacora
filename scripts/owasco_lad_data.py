"""Strict, role-isolated data loading for the fixed Owasco LAD experiment.

There is no fitting, preprocessing statistic, prediction or scoring here. The
public loader selects a single cohort before any file access. It deliberately
does not call the metadata preflight, which reads both development months.
"""
import copy
import gzip
import io
import math
from datetime import timedelta

import owasco_local_median_preflight as metadata


PERSISTENCE = "persistence"
OLD_RIDGE = "same-frozen-ridge-without-fallback"
CLOCK_TOLERANCE = 1e-12
ROLE_IDS = {"training": "july-2020", "development": "august-2020"}
SOURCE_FOLDERS = {"july-2020": "docs/datasets/owasco-lake-transfer",
                  "august-2020": "docs/datasets/owasco-temporal-validation"}
SOURCE_IDENTITIES = {
    "oxygen": {"parameterCode": "00300", "timeSeriesId": "b3904dc881b44599bc5f7eeb63da5a40", "unit": "mg/l"},
    "temperature": {"parameterCode": "00010", "timeSeriesId": "d584a0bd0b6f4e979451c8498c85a192", "unit": "degC"},
}
MAX_DECOMPRESSED_BYTES = 10_000_000


def number(value, label):
    """Only finite JSON real numbers; bool is not a numerical observation."""
    try:
        valid = type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError("Missing or nonfinite real numeric field: " + label)
    return value


def validate_numeric_row(row, index):
    """Validate one source row using past information, preserving saved R.

    Query-window bounds and chronology across rows are checked by load_source.
    Temperature inputs are required finite here. The production loader additionally
    reconstructs them from the bound raw archive via verify_lineage.
    """
    if type(index) is not int or index < 0:
        raise ValueError("Need a nonnegative exact source row index")
    projected = metadata.project_row(row)
    origin, target = projected["origin"], projected["target"]
    history_times = projected["history"]
    if (target - origin != timedelta(hours=1)
            or origin.second or origin.microsecond or origin.minute not in (0, 30)
            or history_times != [origin - timedelta(minutes=30*j) for j in range(11, -1, -1)]):
        raise ValueError("Source row differs from the exact origin/history/target grid")
    try:
        features, predictions = row["features"], row["predictionsMgL"]
        if not isinstance(features, list) or len(features) != 8 or not isinstance(predictions, dict):
            raise ValueError("Need eight fixed-order features and saved predictions")
        actual = number(row["actual"], "actual")
        values = [number(item["value"], "oxygenHistory") for item in row["oxygenHistory"]]
        if actual < 0 or any(value < 0 for value in values):
            raise ValueError("Negative observed oxygen or target")
        for j, value in enumerate(features):
            number(value, "features[" + str(j) + "]")
        persistence = number(predictions[PERSISTENCE], "saved persistence")
        old_ridge = number(predictions[OLD_RIDGE], "saved old ridge")
    except (KeyError, TypeError) as exc:
        raise ValueError("Missing required numeric source-row field") from exc
    if persistence != values[-1]:
        raise ValueError("Saved persistence differs from the final history observation")
    expected = [values[-1], values[-1] - values[-2],
                values[-1] - values[-5], values[-1] - values[0]]
    if features[:4] != expected:
        raise ValueError("Saved oxygen features disagree with exact past history")
    clock = (origin.hour*3600 + origin.minute*60 + origin.second)/86400*2*math.pi
    if (abs(features[4] - math.sin(clock)) > CLOCK_TOLERANCE
            or abs(features[5] - math.cos(clock)) > CLOCK_TOLERANCE):
        raise ValueError("Saved UTC clock features disagree with the origin")
    return {
        "index": index,
        "origin": row["origin"],
        "target": row["target"],
        "actual": actual,
        "persistence": persistence,
        "features": features.copy(),
        "oldR": old_ridge,
        "evidence": copy.deepcopy(row["evidence"]),
        "oxygenHistory": copy.deepcopy(row["oxygenHistory"]),
    }


def load_source(root, cohort, station):
    """Open one explicitly bound cohort only; useful with synthetic fixtures.

    Production callers must use load_cohort, which first validates the unchanged
    protocol and its exact July/training and August/development commitments.
    """
    if (not isinstance(cohort, dict) or cohort.get("id") not in metadata.WINDOW_IDS
            or cohort.get("role") not in ROLE_IDS
            or ROLE_IDS[cohort["role"]] != cohort["id"]
            or not isinstance(station, str) or not station):
        raise ValueError("Unknown or inconsistent fixed cohort role")
    try:
        raw = metadata.safe_path(root, cohort["file"]).read_bytes()
        if metadata.sha256(raw) != cohort["rawSha256"]:
            raise ValueError("Pinned evaluation bytes changed for the selected cohort")
        return _validated_source(raw, cohort, station)
    except (KeyError, TypeError) as exc:
        raise ValueError("Malformed fixed source-cohort specification") from exc


def load_cohort(root, spec, role):
    """Load evaluation plus O/T raw archives of one role, never the other month."""
    cohort, bindings = select_bindings(spec, role)
    raw_files = {}
    # All three hashes pass before any selected cohort is numerically validated.
    for item in bindings:
        raw = metadata.safe_path(root, item["file"]).read_bytes()
        if metadata.sha256(raw) != item["rawSha256"]:
            raise ValueError("Pinned selected-role source bytes changed: " + item["file"])
        raw_files[item["kind"]] = raw
    rows = _validated_source(raw_files["evaluation"], cohort, spec["stationId"])
    verify_lineage(rows, raw_files["oxygen"], raw_files["temperature"], cohort, spec["stationId"])
    return rows


def select_bindings(spec, role):
    if not isinstance(role, str) or role not in ROLE_IDS:
        raise ValueError("Role must be training or development")
    metadata.validate_protocol(spec)  # In-memory schema validation; performs no I/O.
    selected = [cohort for cohort in spec["cohorts"] if cohort["role"] == role]
    if len(selected) != 1 or selected[0]["id"] != ROLE_IDS[role]:
        raise ValueError("Protocol does not provide the exact cohort for this role")
    cohort = selected[0]
    preserved = {item["file"]: item["rawSha256"] for item in spec["preservedFiles"]}
    bindings = [{"kind": "evaluation", "file": cohort["file"], "rawSha256": cohort["rawSha256"]}]
    for kind in ("oxygen", "temperature"):
        name = SOURCE_FOLDERS[cohort["id"]] + "/" + kind + ".json.gz"
        if name not in preserved:
            raise ValueError("Selected-role raw source commitment is missing: " + kind)
        bindings.append({"kind": kind, "file": name, "rawSha256": preserved[name]})
    return cohort, bindings


def source_bindings(spec, role):
    """Return three selected-role source commitments without opening any file."""
    return select_bindings(spec, role)[1]


def _validated_source(raw, cohort, station):
    report = metadata.loads(raw)
    expected = {"stationId": station, "windowId": metadata.WINDOW_IDS[cohort["id"]],
                "pairs": cohort["pairs"], **cohort["window"]}
    metadata.check_month(metadata.project_month(report), expected)
    return [validate_numeric_row(row, index) for index, row in enumerate(report["rows"])]


def collection_index(compressed, cohort, station, kind):
    """Index raw identities/timestamps; do not numerically filter unused records."""
    if kind not in SOURCE_IDENTITIES:
        raise ValueError("Unknown source kind")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as handle:
            raw = handle.read(MAX_DECOMPRESSED_BYTES + 1)
        if len(raw) > MAX_DECOMPRESSED_BYTES:
            raise ValueError("Decompressed raw source exceeds historical size limit")
        obj = metadata.loads(raw)
        features, links = obj["features"], obj["links"]
        if (obj["type"] != "FeatureCollection" or not isinstance(features, list)
                or not isinstance(links, list) or any(link["rel"] == "next" for link in links)
                or len(features) >= 10000
                or type(obj["numberReturned"]) is not int or obj["numberReturned"] != len(features)):
            raise ValueError("Incomplete or inconsistent raw feature collection")
        expected = SOURCE_IDENTITIES[kind]
        start, end = (metadata.instant(cohort["window"][key]) for key in ("start", "end"))
        identities, times = {}, set()
        for feature in features:
            props = feature["properties"]
            identity, time = metadata.identifier(feature["id"]), metadata.instant(props["time"])
            if identity in identities or time in times:
                raise ValueError("Duplicate raw observation identity or timestamp")
            if (props["monitoring_location_id"], props["parameter_code"], props["time_series_id"],
                    props["statistic_id"], props["unit_of_measure"]) != (
                    station, expected["parameterCode"], expected["timeSeriesId"], "00011", expected["unit"]):
                raise ValueError("Raw observation station, series, parameter or units disagree")
            if not start <= time <= end:
                raise ValueError("Raw observation extends beyond the bound source window")
            identities[identity] = {"time": time, "sourceValue": props["value"]}
            times.add(time)
        return identities
    except (KeyError, TypeError, OSError, EOFError) as exc:
        raise ValueError("Malformed bound raw observation collection") from exc


def source_value(index, identity, expected_time, kind):
    if identity not in index or index[identity]["time"] != expected_time:
        raise ValueError("Saved observation identifier/time does not match its raw source")
    raw = index[identity]["sourceValue"]
    if type(raw) not in (str, int, float):
        raise ValueError("Raw observation value must be a finite decimal number")
    try:
        value = float(raw)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("Raw observation value cannot be converted to finite binary64") from exc
    number(value, "raw " + kind)
    if kind == "oxygen" and value < 0:
        raise ValueError("Negative raw oxygen referenced by the accepted cohort")
    return value


def verify_lineage(rows, oxygen_raw, temperature_raw, cohort, station):
    """Reconstruct saved O/T inputs and targets, never predictions or eligibility.

    These exact archives generated the already-accepted cohort. An inconsistency
    is fatal; no record is reselected, silently dropped, repaired or interpolated.
    This does not establish as-of-origin publication or sensor physical accuracy.
    """
    oxygen = collection_index(oxygen_raw, cohort, station, "oxygen")
    temperature = collection_index(temperature_raw, cohort, station, "temperature")
    for row in rows:
        times = [metadata.instant(item["timeUTC"]) for item in row["oxygenHistory"]]
        if (len(times) != 12 or len(row["evidence"]["oxygen"]) != 12
                or len(row["evidence"]["temperature"]) != 12):
            raise ValueError("Lineage requires twelve complete oxygen and temperature references")
        oxygen_values = [source_value(oxygen, identity, time, "oxygen")
                         for identity, time in zip(row["evidence"]["oxygen"], times)]
        if oxygen_values != [item["value"] for item in row["oxygenHistory"]]:
            raise ValueError("Saved oxygen history values disagree with raw source lineage")
        if row["persistence"] != oxygen_values[-1]:
            raise ValueError("Saved persistence disagrees with raw source lineage")
        actual = source_value(oxygen, row["evidence"]["targetOxygen"],
                              metadata.instant(row["target"]), "oxygen")
        if row["actual"] != actual:
            raise ValueError("Saved target disagrees with raw source lineage")
        t = [source_value(temperature, identity, time, "temperature")
             for identity, time in zip(row["evidence"]["temperature"], times)]
        if row["features"][6:] != [t[-1], t[-1] - t[-5]]:
            raise ValueError("Saved temperature features disagree with exact raw history")
    return {"referencedRowsVerified": len(rows), "oxygenHistoryAndTargetVerified": True,
            "temperatureHistoryAndFeaturesVerified": True, "eligibilityChanged": False}
