"""Synthetic numbers and provenance only; no real archive is loaded by tests."""
import copy
import gzip
import math
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import owasco_lad_data as data


def fake_row(origin, prefix):
    values = [8.0 + j/8 for j in range(12)]
    clock = (origin.hour*3600 + origin.minute*60 + origin.second)/86400*2*math.pi
    return {
        "origin": data.metadata.stamp(origin),
        "target": data.metadata.stamp(origin + timedelta(hours=1)),
        "actual": 9.5,
        "features": [values[-1], values[-1] - values[-2], values[-1] - values[-5],
                     values[-1] - values[0], math.sin(clock), math.cos(clock), 16.5, .25],
        "oxygenHistory": [{"timeUTC": data.metadata.stamp(origin - timedelta(minutes=30*(11-j))),
                           "value": value} for j, value in enumerate(values)],
        "evidence": {"oxygen": [prefix + "-o-" + str(j) for j in range(12)],
                     "temperature": [prefix + "-t-" + str(j) for j in range(12)],
                     "targetOxygen": prefix + "-target"},
        "predictionsMgL": {data.PERSISTENCE: values[-1], data.OLD_RIDGE: 9.625},
    }


def fake_source(month, cohort_id, role, prefix):
    start = datetime(2030, month, 1, tzinfo=timezone.utc)
    end = start + timedelta(days=28)
    report = {"stationId": data.metadata.STATION, "horizonSeconds": 3600,
              "window": {"id": data.metadata.WINDOW_IDS[cohort_id],
                         "start": data.metadata.stamp(start), "end": data.metadata.stamp(end)},
              "rows": [fake_row(start + timedelta(hours=5.5), prefix + "-first"),
                       fake_row(end - timedelta(hours=1), prefix + "-last")]}
    raw = data.metadata.encoded(report)
    cohort = {"id": cohort_id, "role": role, "file": "invented/" + prefix + ".json",
              "rawSha256": data.metadata.sha256(raw), "pairs": 2,
              "window": {"start": report["window"]["start"], "end": report["window"]["end"]}}
    return report, cohort, raw


def synthetic_spec(cohorts):
    return {"version": data.metadata.PROTOCOL_VERSION,
            "status": "PROTOCOL_ONLY_NO_ENVIRONMENTAL_FIT", "stationId": data.metadata.STATION,
            "horizonSeconds": 3600, "features": data.metadata.FEATURES.copy(),
            "cohorts": copy.deepcopy(cohorts),
            "preflight": data.metadata.PREFLIGHT_SETTINGS | {
                "allowedFields": "Synthetic fixture metadata.", "scopeLimit": "No numerical fit."},
            "preservedFiles": [{"file": data.metadata.MODEL_FILE,
                                "rawSha256": data.metadata.MODEL_SHA256}]}


def write_source(root, cohort, raw):
    path = root / cohort["file"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return path


def fake_raw_collections(report):
    records = {"oxygen": [], "temperature": []}
    def observation(identity, time, value, kind):
        expected = data.SOURCE_IDENTITIES[kind]
        return {"type": "Feature", "id": identity, "properties": {
            "monitoring_location_id": report["stationId"],
            "parameter_code": expected["parameterCode"], "time_series_id": expected["timeSeriesId"],
            "statistic_id": "00011", "unit_of_measure": expected["unit"],
            "time": time, "value": str(value), "approval_status": "Approved", "qualifier": None}}
    for row in report["rows"]:
        for j, history in enumerate(row["oxygenHistory"]):
            records["oxygen"].append(observation(row["evidence"]["oxygen"][j], history["timeUTC"], history["value"], "oxygen"))
            records["temperature"].append(observation(row["evidence"]["temperature"][j], history["timeUTC"], 15.8125+j*.0625, "temperature"))
        records["oxygen"].append(observation(row["evidence"]["targetOxygen"], row["target"], row["actual"], "oxygen"))
    return {kind: {"type": "FeatureCollection", "features": features,
                   "numberReturned": len(features), "links": []} for kind, features in records.items()}


def compress(collection):
    return gzip.compress(data.metadata.encoded(collection), mtime=0)


def write_raw_sources(root, cohort, collections):
    bindings = []
    for kind in ("oxygen", "temperature"):
        name = data.SOURCE_FOLDERS[cohort["id"]] + "/" + kind + ".json.gz"
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = compress(collections[kind])
        path.write_bytes(raw)
        bindings.append({"file": name, "rawSha256": data.metadata.sha256(raw)})
    return bindings


class LadDataTests(unittest.TestCase):
    def row(self):
        return fake_row(datetime(2030, 7, 1, 5, 30, tzinfo=timezone.utc), "invented")

    def test_valid_row_preserves_values_and_independent_copies(self):
        row = self.row()
        original = copy.deepcopy(row)
        result = data.validate_numeric_row(row, 7)
        self.assertEqual(result["index"], 7)
        self.assertEqual(result["oldR"], row["predictionsMgL"][data.OLD_RIDGE])
        self.assertEqual(result["persistence"], row["oxygenHistory"][-1]["value"])
        self.assertEqual(row, original)
        result["features"][0] = 0
        result["evidence"]["oxygen"][0] = "changed"
        result["oxygenHistory"][0]["value"] = 0
        self.assertEqual(row, original)

    def test_invalid_boolean_nan_inf_and_huge_numeric_values_fail(self):
        for bad_value in (True, False, math.nan, math.inf, -math.inf, 10**1000, "8.0", None):
            for kind in ("actual", "history", "feature", "persistence", "oldR"):
                row = self.row()
                if kind == "actual": row["actual"] = bad_value
                elif kind == "history": row["oxygenHistory"][0]["value"] = bad_value
                elif kind == "feature": row["features"][6] = bad_value
                elif kind == "persistence": row["predictionsMgL"][data.PERSISTENCE] = bad_value
                else: row["predictionsMgL"][data.OLD_RIDGE] = bad_value
                with self.subTest(kind=kind, value=str(bad_value)[:30]), self.assertRaises(ValueError):
                    data.validate_numeric_row(row, 0)

    def test_negative_oxygen_and_missing_values_fail(self):
        for kind in ("actual", "history"):
            row = self.row()
            if kind == "actual": row["actual"] = -1
            else: row["oxygenHistory"][0]["value"] = -1
            with self.assertRaises(ValueError):
                data.validate_numeric_row(row, 0)
        row = self.row()
        del row["predictionsMgL"][data.OLD_RIDGE]
        with self.assertRaises(ValueError):
            data.validate_numeric_row(row, 0)

    def test_negative_finite_saved_ridge_and_temperature_are_not_clipped(self):
        row = self.row()
        row["predictionsMgL"][data.OLD_RIDGE] = -1.25
        row["features"][6] = -0.5
        result = data.validate_numeric_row(row, 0)
        self.assertEqual(result["oldR"], -1.25)
        self.assertEqual(result["features"][6], -0.5)

    def test_exact_persistence_and_past_oxygen_features_are_enforced(self):
        row = self.row()
        row["predictionsMgL"][data.PERSISTENCE] += .125
        with self.assertRaises(ValueError):
            data.validate_numeric_row(row, 0)
        for j in range(4):
            row = self.row()
            row["features"][j] = math.nextafter(row["features"][j], math.inf)
            with self.subTest(feature=j), self.assertRaises(ValueError):
                data.validate_numeric_row(row, 0)

    def test_clock_tolerance_is_only_for_clock_features(self):
        row = self.row()
        row["features"][4] += 5e-13
        data.validate_numeric_row(row, 0)
        for j in (4, 5):
            row = self.row()
            row["features"][j] += 2e-12
            with self.subTest(feature=j), self.assertRaises(ValueError):
                data.validate_numeric_row(row, 0)

    def test_wrong_grid_horizon_history_length_and_feature_width_fail(self):
        bads = []
        row = self.row(); row["target"] = row["origin"]; bads.append(row)
        row = self.row(); row["oxygenHistory"].pop(); bads.append(row)
        row = self.row(); row["oxygenHistory"][0]["timeUTC"] = row["origin"]; bads.append(row)
        row = self.row(); row["features"].pop(); bads.append(row)
        row = self.row(); row["origin"] = "2030-07-01T05:31:00Z"; bads.append(row)
        for row in bads:
            with self.assertRaises(ValueError):
                data.validate_numeric_row(row, 0)
        for index in (-1, True, 1.0):
            with self.assertRaises(ValueError):
                data.validate_numeric_row(self.row(), index)

    def test_single_source_hash_is_checked_before_metadata_or_numeric_access(self):
        _, cohort, raw = fake_source(7, "july-2020", "training", "july")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = write_source(root, cohort, raw + b" ")
            with (patch.object(data.metadata, "project_month", side_effect=AssertionError("No projection")),
                  patch.object(data, "validate_numeric_row", side_effect=AssertionError("No numeric access"))):
                with self.assertRaisesRegex(ValueError, "bytes changed"):
                    data.load_source(root, cohort, data.metadata.STATION)
            self.assertTrue(path.exists())

    def test_single_source_validates_cohort_identity_count_order_and_grid(self):
        report, cohort, _ = fake_source(7, "july-2020", "training", "july")
        bads = []
        bad = copy.deepcopy(report); bad["stationId"] = "wrong"; bads.append(bad)
        bad = copy.deepcopy(report); bad["rows"].pop(); bads.append(bad)
        bad = copy.deepcopy(report); bad["rows"].reverse(); bads.append(bad)
        bad = copy.deepcopy(report); bad["rows"][0]["target"] = bad["rows"][0]["origin"]; bads.append(bad)
        bad = copy.deepcopy(report); bad["window"]["end"] = "2030-07-28T00:00:00Z"; bads.append(bad)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for bad in bads:
                raw = data.metadata.encoded(bad)
                binding = cohort | {"rawSha256": data.metadata.sha256(raw)}
                write_source(root, binding, raw)
                with self.assertRaises(ValueError):
                    data.load_source(root, binding, data.metadata.STATION)

    def test_training_opens_only_three_july_files_and_development_only_august(self):
        fixtures = [fake_source(7, "july-2020", "training", "july"),
                    fake_source(8, "august-2020", "development", "august")]
        cohorts = [item[1] for item in fixtures]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            paths = [write_source(root, cohort, raw).resolve() for _, cohort, raw in fixtures]
            raw_bindings = [write_raw_sources(root, cohort, fake_raw_collections(report))
                            for report, cohort, raw in fixtures]
            spec = synthetic_spec(cohorts)
            spec["preservedFiles"] += [item for month in raw_bindings for item in month]
            original_read = Path.read_bytes
            for role, expected_path, raw_month in zip(("training", "development"), paths, raw_bindings):
                opened = []
                allowed = [expected_path] + [(root/item["file"]).resolve() for item in raw_month]
                def spy(path):
                    opened.append(path.resolve())
                    if path.resolve() not in allowed:
                        raise AssertionError("The other cohort or an unrelated file was opened")
                    return original_read(path)
                with (patch.object(data.metadata, "COHORTS", cohorts),
                      patch.object(data.metadata, "preflight", side_effect=AssertionError("No joint preflight")),
                      patch.object(Path, "read_bytes", spy)):
                    rows = data.load_cohort(root, spec, role)
                self.assertEqual(opened, allowed)
                self.assertEqual(len(rows), 2)
                self.assertEqual([row["index"] for row in rows], [0, 1])

    def test_invalid_role_or_changed_frozen_spec_fails_before_any_file_access(self):
        cohorts = copy.deepcopy(data.metadata.COHORTS)
        spec = synthetic_spec(cohorts)
        bad = copy.deepcopy(spec)
        bad["cohorts"][0]["role"] = "development"
        with patch.object(Path, "read_bytes", side_effect=AssertionError("No file may open")):
            for role in ("validation", "September", None, True):
                with self.subTest(role=role), self.assertRaises(ValueError):
                    data.load_cohort(Path("."), spec, role)
            with self.assertRaises(ValueError):
                data.load_cohort(Path("."), bad, "training")

    def test_source_bindings_are_role_specific_and_perform_no_io(self):
        fixtures = [fake_source(7, "july-2020", "training", "july"),
                    fake_source(8, "august-2020", "development", "august")]
        cohorts = [item[1] for item in fixtures]
        spec = synthetic_spec(cohorts)
        for cohort in cohorts:
            for kind in ("oxygen", "temperature"):
                spec["preservedFiles"].append({"file": data.SOURCE_FOLDERS[cohort["id"]]+"/"+kind+".json.gz", "rawSha256": "a"*64})
        with (patch.object(data.metadata, "COHORTS", cohorts),
              patch.object(Path, "read_bytes", side_effect=AssertionError("No file may open"))):
            for role, cohort in zip(("training", "development"), cohorts):
                bindings = data.source_bindings(spec, role)
                self.assertEqual([item["kind"] for item in bindings], ["evaluation", "oxygen", "temperature"])
                self.assertEqual(bindings[0]["file"], cohort["file"])
                self.assertTrue(all(item["file"].startswith(data.SOURCE_FOLDERS[cohort["id"]]) for item in bindings[1:]))
            bad = copy.deepcopy(spec)
            bad["preservedFiles"] = bad["preservedFiles"][:1]
            with self.assertRaises(ValueError):
                data.source_bindings(bad, "training")

    def test_exact_oxygen_target_and_temperature_lineage_are_reconstructed(self):
        report, cohort, _ = fake_source(7, "july-2020", "training", "july")
        rows = [data.validate_numeric_row(row, index) for index, row in enumerate(report["rows"])]
        collections = fake_raw_collections(report)
        proof = data.verify_lineage(rows, compress(collections["oxygen"]), compress(collections["temperature"]), cohort, report["stationId"])
        self.assertEqual(proof["referencedRowsVerified"], 2)
        self.assertTrue(proof["temperatureHistoryAndFeaturesVerified"])
        self.assertFalse(proof["eligibilityChanged"])

    def test_lineage_mismatch_values_ids_time_units_and_station_fail(self):
        report, cohort, _ = fake_source(7, "july-2020", "training", "july")
        rows = [data.validate_numeric_row(row, index) for index, row in enumerate(report["rows"])]
        originals = fake_raw_collections(report)
        for kind, where, key, value in (
                ("oxygen", 0, "value", "8.125"),
                ("oxygen", 12, "value", "8.125"),
                ("temperature", 11, "value", "17"),
                ("temperature", 7, "value", "17"),
                ("oxygen", 0, "time", "2030-07-01T00:15:00Z"),
                ("temperature", 0, "unit_of_measure", "wrong"),
                ("oxygen", 0, "monitoring_location_id", "wrong"),
                ("temperature", 0, "parameter_code", "wrong")):
            collections = copy.deepcopy(originals)
            collections[kind]["features"][where]["properties"][key] = value
            with self.subTest(kind=kind, where=where, key=key), self.assertRaises(ValueError):
                data.verify_lineage(rows, compress(collections["oxygen"]), compress(collections["temperature"]), cohort, report["stationId"])
        collections = copy.deepcopy(originals)
        collections["oxygen"]["features"][0]["id"] = "unknown"
        with self.assertRaises(ValueError):
            data.verify_lineage(rows, compress(collections["oxygen"]), compress(collections["temperature"]), cohort, report["stationId"])

    def test_raw_source_collection_integrity_and_value_rules(self):
        report, cohort, _ = fake_source(7, "july-2020", "training", "july")
        original = fake_raw_collections(report)["oxygen"]
        for change in ("count", "next", "duplicate", "out-of-window", "wrong-series"):
            bad = copy.deepcopy(original)
            if change == "count": bad["numberReturned"] += 1
            elif change == "next": bad["links"] = [{"rel": "next"}]
            elif change == "duplicate": bad["features"][1] = copy.deepcopy(bad["features"][0])
            elif change == "out-of-window": bad["features"][0]["properties"]["time"] = "2030-08-01T00:00:00Z"
            else: bad["features"][0]["properties"]["time_series_id"] = "other"
            with self.subTest(change=change), self.assertRaises(ValueError):
                data.collection_index(compress(bad), cohort, report["stationId"], "oxygen")
        expected_time = data.metadata.instant(report["rows"][0]["origin"])
        for bad_value in (True, None, "NaN", "Infinity", "not-a-number", "-1"):
            index = {"id": {"time": expected_time, "sourceValue": bad_value}}
            with self.subTest(value=bad_value), self.assertRaises(ValueError):
                data.source_value(index, "id", expected_time, "oxygen")

    def test_unused_unapproved_raw_value_does_not_reselect_the_existing_cohort(self):
        report, cohort, _ = fake_source(7, "july-2020", "training", "july")
        rows = [data.validate_numeric_row(row, index) for index, row in enumerate(report["rows"])]
        collections = fake_raw_collections(report)
        unused = copy.deepcopy(collections["oxygen"]["features"][0])
        unused["id"] = "unused-unapproved"
        unused["properties"].update({"time": "2030-07-01T00:15:00Z", "value": "not-a-number", "approval_status": "Provisional"})
        collections["oxygen"]["features"].append(unused)
        collections["oxygen"]["numberReturned"] += 1
        proof = data.verify_lineage(rows, compress(collections["oxygen"]), compress(collections["temperature"]), cohort, report["stationId"])
        self.assertEqual(proof["referencedRowsVerified"], 2)

    def test_all_selected_role_hashes_pass_before_any_numeric_validation(self):
        report, cohort, raw = fake_source(7, "july-2020", "training", "july")
        _, dev, _ = fake_source(8, "august-2020", "development", "august")
        cohorts = [cohort, dev]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_source(root, cohort, raw)
            bindings = write_raw_sources(root, cohort, fake_raw_collections(report))
            spec = synthetic_spec(cohorts)
            spec["preservedFiles"] += bindings
            path = root / bindings[-1]["file"]
            path.write_bytes(path.read_bytes() + b"changed")
            with (patch.object(data.metadata, "COHORTS", cohorts),
                  patch.object(data, "_validated_source", side_effect=AssertionError("Must not read numeric rows"))):
                with self.assertRaisesRegex(ValueError, "bytes changed"):
                    data.load_cohort(root, spec, "training")

    def test_incomplete_lineage_references_are_not_silently_zipped_away(self):
        report, cohort, _ = fake_source(7, "july-2020", "training", "july")
        rows = [data.validate_numeric_row(row, index) for index, row in enumerate(report["rows"])]
        collections = fake_raw_collections(report)
        for kind in ("oxygen", "temperature"):
            bad = copy.deepcopy(rows)
            bad[0]["evidence"][kind].pop(0)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                data.verify_lineage(bad, compress(collections["oxygen"]), compress(collections["temperature"]), cohort, report["stationId"])


if __name__ == "__main__":
    unittest.main()
