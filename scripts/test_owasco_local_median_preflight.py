"""Invented timestamp/UUID fixtures only; no environmental values or scores."""
import copy
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import owasco_local_median_preflight as pre


def fake_row(origin, prefix):
    return {
        "origin": pre.stamp(origin), "target": pre.stamp(origin + timedelta(hours=1)),
        "oxygenHistory": [{"timeUTC": pre.stamp(origin - timedelta(minutes=30*j))}
                          for j in range(11, -1, -1)],
        "evidence": {"oxygen": [prefix + "-o-" + str(j) for j in range(12)],
                     "temperature": [prefix + "-t-" + str(j) for j in range(12)],
                     "targetOxygen": prefix + "-label"},
    }


def fake_month(month, prefix):
    start = datetime(2030, month, 1, tzinfo=timezone.utc)
    end = start + timedelta(days=28)
    rows = [fake_row(start + timedelta(hours=5.5), prefix + "-first"),
            fake_row(end - timedelta(hours=1), prefix + "-last")]
    report = {"stationId": "USGS-INVENTED", "horizonSeconds": 3600,
              "window": {"id": prefix, "start": pre.stamp(start), "end": pre.stamp(end)},
              "rows": rows}
    expected = {"stationId": "USGS-INVENTED", "windowId": prefix,
                "start": pre.stamp(start), "end": pre.stamp(end), "pairs": 2}
    return report, expected


def protocol_fixture():
    return {"version": pre.PROTOCOL_VERSION, "status": "PROTOCOL_ONLY_NO_ENVIRONMENTAL_FIT",
            "stationId": pre.STATION, "horizonSeconds": 3600, "features": pre.FEATURES.copy(),
            "cohorts": copy.deepcopy(pre.COHORTS),
            "preflight": pre.PREFLIGHT_SETTINGS | {
                "allowedFields": "Invented timestamp and observation identifiers only.",
                "scopeLimit": "Metadata checks do not review future training code."},
            "preservedFiles": [{"file": pre.MODEL_FILE, "rawSha256": pre.MODEL_SHA256}]}


class MetadataPreflightTests(unittest.TestCase):
    def check(self, report, expected):
        return pre.check_month(pre.project_month(report), expected)

    def test_metadata_only_fixtures_and_archived_gaps_are_valid(self):
        report, expected = fake_month(7, "train")
        result = self.check(report, expected)
        self.assertEqual(result["receipt"]["pairs"], 2)
        self.assertNotIn("actual", report["rows"][0])
        self.assertNotIn("features", report["rows"][0])
        self.assertNotIn("predictionsMgL", report["rows"][0])

    def test_excluded_value_fields_are_never_accessed(self):
        class MetadataOnly(dict):
            def __getitem__(self, key):
                if key in ("actual", "features", "predictionsMgL", "value"):
                    raise AssertionError("A forbidden value field was accessed")
                return super().__getitem__(key)
        report, expected = fake_month(7, "train")
        report["rows"] = [MetadataOnly(row) for row in report["rows"]]
        for row in report["rows"]:
            row["actual"] = row["features"] = row["predictionsMgL"] = object()
            row["oxygenHistory"] = [MetadataOnly(item) for item in row["oxygenHistory"]]
        self.check(report, expected)

    def test_valid_split_has_positive_exact_gap(self):
        train, te = fake_month(7, "train")
        dev, de = fake_month(8, "dev")
        receipt = pre.check_split(self.check(train, te), self.check(dev, de))
        self.assertEqual(receipt["targetToHistoryGapSeconds"], 72*3600)
        self.assertTrue(receipt["noMechanicalOverlap"])

    def test_wrong_station_window_count_and_horizon_are_rejected(self):
        report, expected = fake_month(7, "train")
        mutations = [("stationId", "wrong"), ("horizonSeconds", 1800),
                     ("horizonSeconds", True)]
        for key, value in mutations:
            bad = copy.deepcopy(report)
            bad[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.check(bad, expected)
        bad = copy.deepcopy(report)
        bad["rows"].pop()
        with self.assertRaises(ValueError):
            self.check(bad, expected)
        bad = copy.deepcopy(report)
        bad["window"]["id"] = "wrong"
        with self.assertRaises(ValueError):
            self.check(bad, expected)

    def test_missing_duplicate_future_and_wrong_step_history_fail(self):
        report, expected = fake_month(7, "train")
        bad_histories = [report["rows"][0]["oxygenHistory"][:-1],
                         report["rows"][0]["oxygenHistory"][:1]*12]
        for index, delta in ((0, timedelta(minutes=1)), (11, timedelta(minutes=30))):
            history = copy.deepcopy(report["rows"][0]["oxygenHistory"])
            history[index]["timeUTC"] = pre.stamp(pre.instant(history[index]["timeUTC"]) + delta)
            bad_histories.append(history)
        for history in bad_histories:
            bad = copy.deepcopy(report)
            bad["rows"][0]["oxygenHistory"] = history
            with self.subTest(history=history), self.assertRaises(ValueError):
                self.check(bad, expected)

    def test_duplicate_origin_reverse_order_and_wrong_horizon_fail(self):
        report, expected = fake_month(7, "train")
        for rows in ([report["rows"][0]]*2, list(reversed(report["rows"]))):
            bad = copy.deepcopy(report)
            bad["rows"] = rows
            with self.assertRaises(ValueError):
                self.check(bad, expected)
        bad = copy.deepcopy(report)
        bad["rows"][0]["target"] = bad["rows"][0]["origin"]
        with self.assertRaises(ValueError):
            self.check(bad, expected)

    def test_naive_non_utc_and_malformed_timestamps_fail(self):
        for value in ("2030-07-01T00:00:00", "2030-07-01T01:00:00+01:00", "bad", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                pre.instant(value)

    def test_unaligned_origin_and_history_outside_window_fail(self):
        report, expected = fake_month(7, "train")
        for offset in (timedelta(minutes=1), -timedelta(minutes=30)):
            bad = copy.deepcopy(report)
            origin = pre.instant(bad["rows"][0]["origin"]) + offset
            bad["rows"][0] = fake_row(origin, "other")
            with self.assertRaises(ValueError):
                self.check(bad, expected)

    def test_reused_or_missing_provenance_fails(self):
        report, expected = fake_month(7, "train")
        bads = []
        bad = copy.deepcopy(report)
        bad["rows"][1]["evidence"]["targetOxygen"] = bad["rows"][0]["evidence"]["targetOxygen"]
        bads.append(bad)
        bad = copy.deepcopy(report)
        bad["rows"][0]["evidence"]["oxygen"] = ["same"]*12
        bads.append(bad)
        bad = copy.deepcopy(report)
        bad["rows"][0]["evidence"]["temperature"].pop()
        bads.append(bad)
        bad = copy.deepcopy(report)
        bad["rows"][0]["evidence"]["targetOxygen"] = ""
        bads.append(bad)
        for bad in bads:
            with self.assertRaises(ValueError):
                self.check(bad, expected)

    def test_duplicate_label_id_across_months_fails_despite_distinct_dates(self):
        train, te = fake_month(7, "train")
        dev, de = fake_month(8, "dev")
        dev["rows"][0]["evidence"]["targetOxygen"] = train["rows"][0]["evidence"]["targetOxygen"]
        with self.assertRaises(ValueError):
            pre.check_split(self.check(train, te), self.check(dev, de))

    def test_training_target_id_in_development_history_fails(self):
        train, te = fake_month(7, "train")
        dev, de = fake_month(8, "dev")
        dev["rows"][0]["evidence"]["oxygen"][0] = train["rows"][0]["evidence"]["targetOxygen"]
        with self.assertRaises(ValueError):
            pre.check_split(self.check(train, te), self.check(dev, de))

    def test_zero_or_negative_split_gap_fails(self):
        train, te = fake_month(7, "train")
        dev, de = fake_month(8, "dev")
        tr, dr = self.check(train, te), self.check(dev, de)
        for delta in (timedelta(0), -timedelta(minutes=30)):
            bad = copy.deepcopy(dr)
            bad["histories"].add(max(tr["targets"]) + delta)
            with self.assertRaises(ValueError):
                pre.check_split(tr, bad)

    def test_protocol_accepts_metadata_contract_without_solver_recipe(self):
        spec = protocol_fixture()
        self.assertIs(pre.validate_protocol(spec), spec)

    def test_preflight_prose_keys_allow_different_nonempty_descriptions(self):
        spec = protocol_fixture()
        spec["preflight"]["allowedFields"] = "Alternate description of approved metadata."
        spec["preflight"]["scopeLimit"] = "Alternate explanation of limitations."
        self.assertIs(pre.validate_protocol(spec), spec)
        for key in ("allowedFields", "scopeLimit"):
            for value in (None, "", "   ", ["metadata"]):
                bad = copy.deepcopy(spec)
                bad["preflight"][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    pre.validate_protocol(bad)
            bad = copy.deepcopy(spec)
            del bad["preflight"][key]
            with self.assertRaises(ValueError):
                pre.validate_protocol(bad)
        spec["futureRecipe"] = {"notYetReviewed": True}
        self.assertIs(pre.validate_protocol(spec), spec)

    def test_protocol_rejects_changed_phase_roles_features_counts_windows_and_gap(self):
        original = protocol_fixture()
        bads = []
        for key, value in (("version", "other"), ("status", "FIT_AUTHORIZED"),
                           ("stationId", "other"), ("horizonSeconds", True),
                           ("features", list(reversed(pre.FEATURES)))):
            bad = copy.deepcopy(original)
            bad[key] = value
            bads.append(bad)
        for key, value in (("role", "development"), ("pairs", 1274),
                           ("file", "another.json"), ("rawSha256", "a"*64)):
            bad = copy.deepcopy(original)
            bad["cohorts"][0][key] = value
            bads.append(bad)
        bad = copy.deepcopy(original)
        bad["cohorts"].reverse()
        bads.append(bad)
        bad = copy.deepcopy(original)
        bad["cohorts"][0]["window"]["end"] = "2020-07-28T00:00:00Z"
        bads.append(bad)
        bad = copy.deepcopy(original)
        bad["preflight"]["requiredGapSeconds"] = 0
        bads.append(bad)
        for bad in bads:
            with self.subTest(spec=bad), self.assertRaises(ValueError):
                pre.validate_protocol(bad)

    def test_protocol_requires_original_model_and_unique_valid_preservation_pins(self):
        spec = protocol_fixture()
        for preserved in ([], [{"file": pre.MODEL_FILE, "rawSha256": "a"*64}],
                          spec["preservedFiles"]*2,
                          spec["preservedFiles"] + [{"file": "another", "rawSha256": "bad"}]):
            bad = copy.deepcopy(spec)
            bad["preservedFiles"] = preserved
            with self.assertRaises(ValueError):
                pre.validate_protocol(bad)

    def test_safe_paths_reject_traversal_absolute_ambiguous_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("../outside", "/absolute", "C:/outside", "a\\b", "a//b", "a/./b", ""):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    pre.safe_path(root, name)
            self.assertEqual(pre.safe_path(root, "safe/file.json"), root / "safe/file.json")
            # Platform permissions can forbid symlink creation; the other checks still run.
            try:
                (root / "escape").symlink_to(root.parent, target_is_directory=True)
            except OSError:
                pass
            else:
                with self.assertRaises(ValueError):
                    pre.safe_path(root, "escape/outside.json")

    def test_hash_binding_rejects_changed_bytes_before_metadata_projection(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "source.json"
            raw = pre.encoded({"onlyMetadata": True})
            path.write_bytes(raw)
            spec = {"cohorts": [{"file": "source.json", "rawSha256": pre.sha256(raw)}],
                    "preservedFiles": []}
            files, bindings = pre.verify_bound_files(root, spec)
            self.assertEqual(files["source.json"], raw)
            self.assertEqual(bindings[0]["rawSha256"], pre.sha256(raw))
            path.write_bytes(raw + b" ")
            with self.assertRaisesRegex(ValueError, "bytes changed"):
                pre.verify_bound_files(root, spec)

    def test_conflicting_hashes_and_unsafe_reference_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for spec in (
                {"cohorts": [{"file": "same", "rawSha256": "a"*64}],
                 "preservedFiles": [{"file": "same", "rawSha256": "b"*64}]},
                {"cohorts": [{"file": "../outside", "rawSha256": "a"*64}], "preservedFiles": []},
            ):
                with self.assertRaises(ValueError):
                    pre.verify_bound_files(root, spec)

    def test_json_duplicate_keys_constants_and_malformed_content_are_rejected(self):
        for raw in (b'{"a":1,"a":2}', b'{"metadata":NaN}', b'{"metadata":Infinity}', b'{'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                pre.loads(raw)

    def test_missing_bound_archive_stops_before_any_row_projection(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "protocol.json"
            spec = protocol_fixture()
            path.write_bytes(pre.encoded(spec))
            with patch.object(pre, "inspect_bound_metadata", side_effect=AssertionError("Must not inspect rows")):
                # No input archive exists: bindings must stop execution before projection.
                with self.assertRaises(OSError):
                    pre.preflight(path, root)

    def test_exclusive_output_and_replay_without_writes(self):
        invented_receipt = {"version": pre.VERSION, "scope": "metadata-only",
                            "protocolRawSHA256": "a"*64, "fitExecuted": False}
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "receipt.json"
            with (patch.object(pre, "preflight", return_value=invented_receipt),
                  redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO())):
                pre.main(["--protocol", "invented.json", "--output", str(output)])
                original = output.read_bytes()
                before = {p.name: p.read_bytes() for p in Path(folder).iterdir()}
                pre.main(["--protocol", "invented.json", "--verify-report", str(output)])
                self.assertEqual(before, {p.name: p.read_bytes() for p in Path(folder).iterdir()})
                self.assertEqual(original, pre.encoded(invented_receipt))
                with self.assertRaises(SystemExit):
                    pre.main(["--protocol", "invented.json", "--output", str(output)])
                self.assertEqual(output.read_bytes(), original)
                changed = invented_receipt | {"protocolRawSHA256": "b"*64}
                output.write_bytes(pre.encoded(changed))
                with self.assertRaises(SystemExit):
                    pre.main(["--protocol", "invented.json", "--verify-report", str(output)])

    def test_history_identifier_reuse_across_months_is_rejected(self):
        train, te = fake_month(7, "train")
        dev, de = fake_month(8, "dev")
        for kind in ("oxygen", "temperature"):
            bad = copy.deepcopy(dev)
            bad["rows"][0]["evidence"][kind][0] = train["rows"][0]["evidence"][kind][0]
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                pre.check_split(self.check(train, te), self.check(bad, de))

    def test_changed_protocol_is_rejected_before_any_bound_file_access(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec = protocol_fixture()
            spec["cohorts"][0]["role"] = "development"
            (root / "protocol.json").write_bytes(pre.encoded(spec))
            with patch.object(pre, "verify_bound_files", side_effect=AssertionError("Must not read bound files")):
                with self.assertRaisesRegex(ValueError, "cohort"):
                    pre.preflight("protocol.json", root)


if __name__ == "__main__":
    unittest.main()
