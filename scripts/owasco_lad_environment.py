"""Capture the frozen LAD runtime without observations, model fitting or an LP.

The manifest identifies installed bytes. It is not an original wheel-archive
hash, software authenticity check, or mathematical/environmental validation.
"""

from __future__ import annotations

import base64
import csv
from datetime import datetime, timezone
import hashlib
import importlib
import importlib.metadata
import io
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import platform
import struct
import sys
from typing import Callable, Iterable

VERSION = "owasco-lad-environment-v1"
EXPECTED_PINS = {
    "python": "3.13.5",
    "numpy": "2.3.5",
    "scipy": "1.17.1",
    "system": "Windows",
    "machine": "AMD64",
    "pointerBits": 64,
}
DISTRIBUTIONS = ("numpy", "scipy")


class EnvironmentCaptureError(RuntimeError):
    """A required runtime could not be identified or does not match the pins."""


def _canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _hash_file(path: Path) -> dict:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
    return {"bytes": size, "sha256": digest.hexdigest()}


def _relative_record_path(value: str) -> str:
    """Keep installation-relative paths; never publish absolute host paths."""
    value = str(value).replace("\\", "/")
    if not value or value.startswith("/") or PureWindowsPath(value).drive:
        raise EnvironmentCaptureError("RECORD contains a non-relative file path")
    path = PurePosixPath(value)
    if str(path) in ("", "."):
        raise EnvironmentCaptureError("RECORD contains an empty file path")
    return str(path)


def _is_bytecode(path: str) -> bool:
    return "__pycache__" in PurePosixPath(path).parts or path.endswith((".pyc", ".pyo"))


def _parse_record(text: str) -> list[dict]:
    records = []
    seen = set()
    try:
        for row in csv.reader(io.StringIO(text)):
            if len(row) != 3:
                raise EnvironmentCaptureError("RECORD has a malformed CSV row")
            path = _relative_record_path(row[0])
            if path in seen:
                raise EnvironmentCaptureError("RECORD has a duplicate file path")
            seen.add(path)
            expected_size = None
            if row[2]:
                if not row[2].isdigit():
                    raise EnvironmentCaptureError("RECORD has an invalid file size")
                expected_size = int(row[2])
            records.append({
                "path": path, "recordHash": row[1] or None,
                "recordBytes": expected_size,
            })
    except csv.Error as exc:
        raise EnvironmentCaptureError("RECORD CSV cannot be parsed") from exc
    return records


def _inside(path: Path, roots: Iterable[Path]) -> bool:
    resolved = path.resolve()
    return any(resolved.is_relative_to(root.resolve()) for root in roots)


def _record_hash_check(expected: str | None, actual_sha256: str) -> tuple[bool | None, str]:
    if expected is None:
        return None, "not-recorded"
    mode, separator, encoded = expected.partition("=")
    if not separator:
        return False, "malformed-record-hash"
    if mode != "sha256":
        return None, "unsupported-record-hash-algorithm"
    try:
        padded = encoded + "=" * (-len(encoded) % 4)
        claimed = base64.b64decode(padded, altchars=b"-_", validate=True)
        if len(claimed) != 32:
            return False, "malformed-record-hash"
        return claimed == bytes.fromhex(actual_sha256), "sha256"
    except (ValueError, TypeError):
        return False, "malformed-record-hash"


def build_file_manifest(
    records: list[dict],
    locate_file: Callable[[str], Path],
    *,
    allowed_roots: Iterable[Path],
    hash_file: Callable[[Path], dict] | None = None,
) -> dict:
    """Hash a synthetic or installed RECORD without imports or optimization.

    Missing/non-file/outside-installation records remain explicit entries.
    The helper can be supplied synthetic roots and a small fake hasher in tests.
    """
    hasher = _hash_file if hash_file is None else hash_file
    roots = tuple(Path(root) for root in allowed_roots)
    entries = []
    excluded = 0
    for record in records:
        relative = _relative_record_path(record["path"])
        if _is_bytecode(relative):
            excluded += 1
            continue
        entry = {
            "path": relative,
            "recordHash": record.get("recordHash"),
            "recordBytes": record.get("recordBytes"),
            "status": None, "bytes": None, "sha256": None,
            "recordHashMatches": None, "recordSizeMatches": None,
            "recordHashCheck": "not-checked",
        }
        path = Path(locate_file(relative))
        if not _inside(path, roots):
            entry["status"] = "outside-installation-roots"
        elif not path.exists():
            entry["status"] = "missing"
        elif not path.is_file():
            entry["status"] = "not-a-file"
        else:
            try:
                actual = hasher(path)
            except OSError:
                entry["status"] = "unreadable"
            else:
                entry["status"] = "hashed"
                entry["bytes"] = actual["bytes"]
                entry["sha256"] = actual["sha256"]
                check, method = _record_hash_check(
                    entry["recordHash"], entry["sha256"],
                )
                entry["recordHashMatches"] = check
                entry["recordHashCheck"] = method
                if entry["recordBytes"] is not None:
                    entry["recordSizeMatches"] = (
                        entry["recordBytes"] == entry["bytes"]
                    )
        entries.append(entry)
    entries.sort(key=lambda entry: entry["path"])
    counts = {
        "recordRows": len(records), "excludedBytecode": excluded,
        "included": len(entries),
        "hashed": sum(e["status"] == "hashed" for e in entries),
        "missing": sum(e["status"] == "missing" for e in entries),
        "outsideInstallationRoots": sum(
            e["status"] == "outside-installation-roots" for e in entries
        ),
        "notFiles": sum(e["status"] == "not-a-file" for e in entries),
        "unreadable": sum(e["status"] == "unreadable" for e in entries),
        "recordHashMismatches": sum(e["recordHashMatches"] is False for e in entries),
        "recordSizeMismatches": sum(e["recordSizeMatches"] is False for e in entries),
        "recordHashesNotVerified": sum(
            e["recordHashMatches"] is None for e in entries
        ),
    }
    complete = counts["hashed"] == counts["included"]
    checks_match = (
        counts["recordHashMismatches"] == 0 and counts["recordSizeMismatches"] == 0
    )
    return {
        "entries": entries, "counts": counts,
        "manifestSha256": _canonical_sha256(entries),
        "canonicalization": (
            "SHA-256 of UTF-8 JSON entries, sorted path order, sorted object "
            "keys, compact separators, ensure_ascii=True, allow_nan=False"
        ),
        "exclusionPolicy": "RECORD .pyc/.pyo and __pycache__ entries excluded",
        "allIncludedFilesHashed": complete,
        "allAvailableRecordChecksMatch": checks_match,
        "limitation": (
            "Installed-file identity and local RECORD consistency only; "
            "not original wheel archive identity or software authenticity"
        ),
    }


def _runtime_info() -> dict:
    return {
        "pythonVersion": platform.python_version(),
        "implementation": platform.python_implementation(),
        "platform": {
            "system": platform.system(), "machine": platform.machine(),
            "pointerBits": struct.calcsize("P") * 8,
            "release": platform.release(), "version": platform.version(),
        },
    }


def _get_distribution(name: str):
    return importlib.metadata.distribution(name)


def _module_info(name: str) -> dict:
    try:
        module = importlib.import_module(name)
    except Exception as exc:
        return {
            "available": False, "version": None, "file": None,
            "reason": "runtime-import-failed:" + type(exc).__name__,
        }
    return {
        "available": True, "version": getattr(module, "__version__", None),
        "file": getattr(module, "__file__", None), "reason": None,
    }


def _capture_distribution(name: str, distribution, module_info: dict) -> dict:
    root = Path(distribution.locate_file("")).resolve()
    record_text = distribution.read_text("RECORD")
    if record_text is None:
        return {
            "available": True, "version": distribution.version,
            "runtimeVersion": module_info["version"],
            "runtimeAvailable": module_info["available"],
            "runtimeReason": module_info["reason"],
            "runtimeFileWithinDistribution": False,
            "metadataFiles": {"WHEEL": None, "METADATA": None, "RECORD": None},
            "fileManifest": None, "reason": "installed-RECORD-unavailable",
        }
    manifest = build_file_manifest(
        _parse_record(record_text), distribution.locate_file,
        allowed_roots=(root, Path(sys.prefix)),
    )
    metadata_files = {}
    for filename in ("WHEEL", "METADATA", "RECORD"):
        matches = [
            entry for entry in manifest["entries"]
            if entry["path"].endswith(".dist-info/" + filename)
        ]
        if len(matches) > 1:
            raise EnvironmentCaptureError(
                f"Multiple {filename} metadata files in {name} RECORD"
            )
        metadata_files[filename] = matches[0] if matches else None
    runtime_file = module_info.get("file")
    within = (
        bool(runtime_file)
        and Path(runtime_file).resolve().is_relative_to(root)
    )
    return {
        "available": True, "version": distribution.version,
        "runtimeVersion": module_info["version"],
        "runtimeAvailable": module_info["available"],
        "runtimeReason": module_info["reason"],
        "runtimeFileWithinDistribution": within,
        "metadataFiles": metadata_files, "fileManifest": manifest,
        "reason": None,
    }


def _capture_highs(scipy_distribution) -> dict:
    if scipy_distribution is None:
        return {"available": False, "version": None, "coreFile": None,
                "reason": "scipy-distribution-unavailable"}
    try:
        core = importlib.import_module("scipy.optimize._highspy._core")
    except Exception as exc:
        return {"available": False, "version": None, "coreFile": None,
                "reason": "bundled-highs-import-failed:" + type(exc).__name__}
    parts = [
        getattr(core, "HIGHS_VERSION_" + field, None)
        for field in ("MAJOR", "MINOR", "PATCH")
    ]
    if not all(type(value) is int and value >= 0 for value in parts):
        raise EnvironmentCaptureError("Bundled HiGHS version constants unavailable")
    root = Path(scipy_distribution.locate_file("")).resolve()
    path = Path(core.__file__).resolve()
    if not path.is_relative_to(root):
        raise EnvironmentCaptureError("Bundled HiGHS core is outside SciPy installation")
    return {
        "available": True,
        "version": ".".join(str(value) for value in parts),
        "major": parts[0], "minor": parts[1], "patch": parts[2],
        "versionMethod": "bundled-core-version-constants-no-Highs-instance",
        "coreFile": {"path": path.relative_to(root).as_posix(), **_hash_file(path)},
        "reason": None,
    }


def _capture_python_executable() -> dict:
    path = Path(sys.executable)
    return {"name": path.name, **_hash_file(path)}


def capture_environment(require_pins: bool = True) -> dict:
    """Return a JSON-serializable snapshot; never invoke an LP or read rows.

    True requires exact version/platform pins and identifiable runtime modules.
    False records mismatch/unavailable states for diagnostics, including CI.
    RECORD mismatches and missing files remain explicit integrity diagnostics;
    callers must not interpret pin equality as an authenticity/integrity proof.
    """
    if type(require_pins) is not bool:
        raise TypeError("require_pins must be bool")
    runtime = _runtime_info()
    distributions = {}
    modules = {}
    for name in DISTRIBUTIONS:
        try:
            distributions[name] = _get_distribution(name)
        except importlib.metadata.PackageNotFoundError:
            distributions[name] = None
        modules[name] = _module_info(name) if distributions[name] is not None else {
            "available": False, "version": None, "file": None,
            "reason": "distribution-not-installed",
        }
    observed = {
        "python": runtime["pythonVersion"],
        **{name: distributions[name].version if distributions[name] else None
           for name in DISTRIBUTIONS},
        **{key: runtime["platform"][key]
           for key in ("system", "machine", "pointerBits")},
    }
    mismatches = [
        {"field": key, "expected": expected, "observed": observed[key]}
        for key, expected in EXPECTED_PINS.items() if observed[key] != expected
    ]
    for name in DISTRIBUTIONS:
        if not modules[name]["available"]:
            mismatches.append({"field": name + ".runtime",
                               "expected": "available", "observed": "unavailable"})
        elif modules[name]["version"] != observed[name]:
            mismatches.append({"field": name + ".runtimeVersion",
                               "expected": observed[name],
                               "observed": modules[name]["version"]})
    if require_pins and mismatches:
        fields = ", ".join(mismatch["field"] for mismatch in mismatches)
        raise EnvironmentCaptureError("Frozen LAD environment pin mismatch: " + fields)
    snapshots = {}
    for name in DISTRIBUTIONS:
        distribution = distributions[name]
        snapshots[name] = (
            _capture_distribution(name, distribution, modules[name])
            if distribution is not None else {
                "available": False, "version": None, "runtimeVersion": None,
                "runtimeAvailable": False, "runtimeReason": "distribution-not-installed",
                "runtimeFileWithinDistribution": False,
                "metadataFiles": {"WHEEL": None, "METADATA": None, "RECORD": None},
                "fileManifest": None, "reason": "distribution-not-installed",
            }
        )
    highs = _capture_highs(distributions["scipy"])
    for name, snapshot in snapshots.items():
        if not snapshot["runtimeFileWithinDistribution"]:
            mismatches.append({"field": name + ".runtimeFile",
                               "expected": "within-installed-distribution",
                               "observed": "unavailable-or-outside"})
    if not highs["available"]:
        mismatches.append({"field": "highs.runtime", "expected": "available",
                           "observed": "unavailable"})
    if require_pins and mismatches:
        fields = ", ".join(mismatch["field"] for mismatch in mismatches)
        raise EnvironmentCaptureError("Frozen LAD runtime identification failed: " + fields)
    result = {
        "schemaVersion": VERSION,
        "recordedAtUTC": datetime.now(timezone.utc).isoformat(),
        "captureKind": "metadata-and-installed-file-hashes",
        "platform": runtime["platform"],
        "python": {
            "version": runtime["pythonVersion"],
            "implementation": runtime["implementation"],
            "executable": _capture_python_executable(),
        },
        "versions": {**{key: observed[key] for key in ("python", "numpy", "scipy")},
                     "highs": highs["version"]},
        "distributions": snapshots, "highs": highs,
        "pins": {
            "required": require_pins, "expected": dict(EXPECTED_PINS),
            "observed": observed, "matched": not mismatches, "mismatches": mismatches,
        },
        "originalWheelArchives": {
            name: {
                "sha256": None,
                "reason": (
                    "Original .whl archive was not supplied or inspected; "
                    "installed WHEEL metadata is not an archive digest"
                ),
            } for name in DISTRIBUTIONS
        },
        "solverInvoked": False, "environmentalDataOpened": False,
    }
    # Fail before returning a nonportable or non-JSON artifact.
    json.dumps(result, allow_nan=False)
    return result
