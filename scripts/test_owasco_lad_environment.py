"""Synthetic-only tests: no scientific package, LP or environmental row needed."""

import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import owasco_lad_environment as env


def encoded_hash(value):
    return "sha256=" + base64.urlsafe_b64encode(
        hashlib.sha256(value).digest()
    ).decode("ascii").rstrip("=")


def record(path, value=None):
    return {
        "path": path,
        "recordHash": encoded_hash(value) if value is not None else None,
        "recordBytes": len(value) if value is not None else None,
    }


def runtime(system="Windows", machine="AMD64", version="3.13.5"):
    return {
        "pythonVersion": version, "implementation": "CPython",
        "platform": {"system": system, "machine": machine, "pointerBits": 64,
                     "release": "synthetic", "version": "synthetic"},
    }


def module_info(name):
    return {"available": True,
            "version": env.EXPECTED_PINS[name],
            "file": "synthetic", "reason": None}


def distribution_snapshot(name, distribution, module):
    return {
        "available": True, "version": distribution.version,
        "runtimeVersion": module["version"], "runtimeAvailable": True,
        "runtimeReason": None, "runtimeFileWithinDistribution": True,
        "metadataFiles": {"WHEEL": {}, "METADATA": {}, "RECORD": {}},
        "fileManifest": {"entries": [], "counts": {}, "manifestSha256": "fixture"},
        "reason": None,
    }


class RecordManifestTests(unittest.TestCase):
    def test_record_parser_rejects_duplicate_and_absolute_paths(self):
        for text in ("x.py,,\nx.py,,\n", "/outside/data,,\n",
                     "C:/outside/data,,\n", "x.py,,bad\n", "x.py,extra\n"):
            with self.subTest(text=text), self.assertRaises(env.EnvironmentCaptureError):
                env._parse_record(text)

    def test_manifest_hashes_actual_bytes_and_checks_record(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "module.py").write_bytes(b"synthetic-code\n")
            output = env.build_file_manifest(
                [record("module.py", b"synthetic-code\n")],
                lambda path: root / path, allowed_roots=[root],
            )
            entry = output["entries"][0]
            self.assertEqual(entry["sha256"], hashlib.sha256(b"synthetic-code\n").hexdigest())
            self.assertTrue(entry["recordHashMatches"])
            self.assertTrue(entry["recordSizeMatches"])
            self.assertTrue(output["allIncludedFilesHashed"])

    def test_tampering_changes_manifest_and_is_not_hidden(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "module.py"
            records = [record("module.py", b"original")]
            path.write_bytes(b"original")
            before = env.build_file_manifest(records, lambda p: root / p, allowed_roots=[root])
            path.write_bytes(b"changed-and-longer")
            after = env.build_file_manifest(records, lambda p: root / p, allowed_roots=[root])
            self.assertNotEqual(before["manifestSha256"], after["manifestSha256"])
            self.assertEqual(after["counts"]["recordHashMismatches"], 1)
            self.assertEqual(after["counts"]["recordSizeMismatches"], 1)
            self.assertFalse(after["allAvailableRecordChecksMatch"])

    def test_missing_record_retained_and_bytecode_explicitly_excluded(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            result = env.build_file_manifest(
                [record("missing.py"), record("cache.pyc"),
                 record("__pycache__/generated.bin")],
                lambda p: root / p, allowed_roots=[root],
            )
            self.assertEqual(result["counts"]["recordRows"], 3)
            self.assertEqual(result["counts"]["excludedBytecode"], 2)
            self.assertEqual(result["counts"]["included"], 1)
            self.assertEqual(result["entries"][0]["status"], "missing")
            self.assertFalse(result["allIncludedFilesHashed"])

    def test_record_order_does_not_choose_manifest_identity(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("a.py", "b.py"):
                (root / name).write_bytes(name.encode("ascii"))
            records = [record("b.py"), record("a.py")]
            first = env.build_file_manifest(records, lambda p: root / p, allowed_roots=[root])
            second = env.build_file_manifest(list(reversed(records)), lambda p: root / p,
                                             allowed_roots=[root])
            self.assertEqual(first["manifestSha256"], second["manifestSha256"])
            self.assertEqual([e["path"] for e in first["entries"]], ["a.py", "b.py"])

    def test_outside_installation_record_never_reaches_hasher(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / "installation"
            root.mkdir()
            with patch.object(env, "_hash_file", side_effect=AssertionError("read forbidden")):
                result = env.build_file_manifest(
                    [record("../outside.py")], lambda p: root / p, allowed_roots=[root],
                )
            self.assertEqual(result["entries"][0]["status"], "outside-installation-roots")
            self.assertEqual(result["counts"]["outsideInstallationRoots"], 1)

    def test_unreadable_file_remains_explicit(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "module.py").write_bytes(b"x")
            result = env.build_file_manifest(
                [record("module.py")], lambda p: root / p, allowed_roots=[root],
                hash_file=lambda p: (_ for _ in ()).throw(OSError("synthetic")),
            )
            self.assertEqual(result["entries"][0]["status"], "unreadable")
            self.assertEqual(result["counts"]["unreadable"], 1)

    def test_unknown_hash_algorithm_not_reported_as_verified(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "module.py").write_bytes(b"x")
            result = env.build_file_manifest(
                [{"path": "module.py", "recordHash": "sha512=synthetic", "recordBytes": 1}],
                lambda p: root / p, allowed_roots=[root],
            )
            entry = result["entries"][0]
            self.assertIsNone(entry["recordHashMatches"])
            self.assertEqual(entry["recordHashCheck"], "unsupported-record-hash-algorithm")
            self.assertEqual(entry["sha256"], hashlib.sha256(b"x").hexdigest())

    def test_missing_record_hash_is_not_an_original_wheel_digest(self):
        self.assertEqual(env._record_hash_check(None, "0" * 64), (None, "not-recorded"))
        self.assertFalse(env._record_hash_check("sha256=!", "0" * 64)[0])


class CaptureEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.patches = [
            patch.object(env, "_runtime_info", side_effect=runtime),
            patch.object(env, "_get_distribution",
                         side_effect=lambda name: SimpleNamespace(version=env.EXPECTED_PINS[name])),
            patch.object(env, "_module_info", side_effect=module_info),
            patch.object(env, "_capture_distribution", side_effect=distribution_snapshot),
            patch.object(env, "_capture_highs", return_value={
                "available": True, "version": "1.12.0",
                "coreFile": {"path": "scipy/mock-core.pyd", "bytes": 1, "sha256": "0" * 64},
                "reason": None,
            }),
            patch.object(env, "_capture_python_executable", return_value={
                "name": "python.exe", "bytes": 1, "sha256": "1" * 64,
            }),
        ]
        self.mocks = [item.start() for item in self.patches]
        self.addCleanup(self._stop_patches)

    def _stop_patches(self):
        for item in reversed(self.patches):
            item.stop()

    def test_matching_pins_yield_json_and_no_wheel_archive_claim(self):
        result = env.capture_environment()
        self.assertTrue(result["pins"]["matched"])
        self.assertEqual(result["versions"]["highs"], "1.12.0")
        self.assertFalse(result["solverInvoked"])
        self.assertFalse(result["environmentalDataOpened"])
        for name in ("numpy", "scipy"):
            self.assertIsNone(result["originalWheelArchives"][name]["sha256"])
            self.assertIn("WHEEL metadata", result["originalWheelArchives"][name]["reason"])
        json.dumps(result, allow_nan=False)

    def test_mismatch_stops_before_manifest_and_solver_probe(self):
        self.mocks[0].side_effect = lambda: runtime(version="3.13.6")
        with self.assertRaisesRegex(env.EnvironmentCaptureError, "python"):
            env.capture_environment()
        self.mocks[3].assert_not_called()
        self.mocks[4].assert_not_called()

    def test_false_captures_ci_platform_without_requiring_pinned_host(self):
        self.mocks[0].side_effect = lambda: runtime(system="Linux", machine="x86_64")
        result = env.capture_environment(require_pins=False)
        self.assertFalse(result["pins"]["matched"])
        self.assertEqual(result["platform"]["system"], "Linux")
        self.assertEqual({m["field"] for m in result["pins"]["mismatches"]},
                         {"system", "machine"})

    def test_runtime_version_must_match_installed_distribution(self):
        self.mocks[2].side_effect = lambda name: {
            **module_info(name), "version": "0.0.synthetic",
        }
        with self.assertRaisesRegex(env.EnvironmentCaptureError, "runtimeVersion"):
            env.capture_environment()

    def test_shadow_module_location_is_not_accepted(self):
        self.mocks[3].side_effect = lambda *args: {
            **distribution_snapshot(*args), "runtimeFileWithinDistribution": False,
        }
        with self.assertRaisesRegex(env.EnvironmentCaptureError, "runtimeFile"):
            env.capture_environment()

    def test_missing_distributions_are_reported_in_nonrequired_mode(self):
        self.mocks[1].side_effect = importlib.metadata.PackageNotFoundError("synthetic")
        self.mocks[4].return_value = {
            "available": False, "version": None, "coreFile": None,
            "reason": "scipy-distribution-unavailable",
        }
        result = env.capture_environment(require_pins=False)
        self.assertFalse(result["distributions"]["numpy"]["available"])
        self.assertIsNone(result["versions"]["numpy"])
        self.mocks[2].assert_not_called()

    def test_require_pins_flag_is_a_boolean(self):
        with self.assertRaises(TypeError):
            env.capture_environment(require_pins=1)


class HighsMetadataTests(unittest.TestCase):
    def test_highs_version_constants_need_no_solver_instance(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            core = root / "scipy" / "core.pyd"
            core.parent.mkdir()
            core.write_bytes(b"synthetic-native-library")
            fake = SimpleNamespace(
                HIGHS_VERSION_MAJOR=1, HIGHS_VERSION_MINOR=12,
                HIGHS_VERSION_PATCH=0, __file__=str(core),
                Highs=lambda: (_ for _ in ()).throw(AssertionError("solver instance forbidden")),
            )
            distribution = SimpleNamespace(locate_file=lambda p: root / p)
            with patch.object(env.importlib, "import_module", return_value=fake) as importer:
                result = env._capture_highs(distribution)
            importer.assert_called_once_with("scipy.optimize._highspy._core")
            self.assertEqual(result["version"], "1.12.0")
            self.assertEqual(result["coreFile"]["path"], "scipy/core.pyd")
            self.assertEqual(result["coreFile"]["sha256"],
                             hashlib.sha256(b"synthetic-native-library").hexdigest())
            self.assertNotIn(directory, json.dumps(result))

    def test_ambiguous_highs_version_is_rejected(self):
        fake = SimpleNamespace(
            HIGHS_VERSION_MAJOR=True, HIGHS_VERSION_MINOR=12,
            HIGHS_VERSION_PATCH=0,
        )
        with patch.object(env.importlib, "import_module", return_value=fake):
            with self.assertRaises(env.EnvironmentCaptureError):
                env._capture_highs(SimpleNamespace())


if __name__ == "__main__":
    unittest.main()
