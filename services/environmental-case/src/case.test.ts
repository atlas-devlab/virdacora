import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { loadDataset, validateDataset } from "./dataset.js";
import { deliverResult, prepareCase, verifyResult } from "./case.js";
import { replay } from "./replay.js";

const folder = fileURLToPath(new URL("../../../docs/datasets/usgs-willamette/", import.meta.url));
const policy = await readFile(new URL("../../../policies/usgs-data-review-v1.terra", import.meta.url), "utf8");
const raw = await readFile(`${folder}/continuous.json`, "utf8");
const station = await readFile(`${folder}/station.json`, "utf8");
const manifest = JSON.parse(await readFile(`${folder}/manifest.json`, "utf8"));
const dataset = await loadDataset(folder);
function changedRaw(change: (json: any) => void) {
  const json = JSON.parse(raw); change(json);
  const edited = JSON.stringify(json);
  return () => validateDataset(edited, station, { ...manifest, sourceHash: sha256Hex(edited) });
}
describe("USGS environmental case", () => {
  it("reproduces real measurements and chronological comparison without future leakage", () => {
    expect(dataset.quality).toMatchObject({ accepted: 673, missingIntervals: 0, excluded: [] });
    const report = replay(dataset);
    expect(report.evaluatedPairs).toBe(335);
    expect(report.observedLowOxygenEvents).toBe(0);
    for (const row of report.rows) {
      expect(Date.parse(row.target) - Date.parse(row.origin)).toBe(3600000);
      expect(Date.parse(row.origin)).toBeGreaterThanOrEqual(Date.parse(manifest.evaluationStart));
    }
    const spec = prepareCase(dataset, policy);
    expect(report.modelVersion).toBe(spec.assessment.modelVersion);
    const targetChanged = structuredClone(dataset);
    targetChanged.measurements.find((m) => m.time === spec.targetTime)!.value += 5;
    expect(prepareCase(targetChanged, policy).assessment).toEqual(spec.assessment);
    expect(deliverResult(targetChanged, spec).absoluteErrorMgL).not.toBe(deliverResult(dataset, spec).absoluteErrorMgL);
  });
  it("verifies the delivery and binds all case and result fields", () => {
    const spec = prepareCase(dataset, policy), result = deliverResult(dataset, spec);
    expect(verifyResult(dataset, policy, spec, result).verified).toBe(true);
    expect(() => verifyResult(dataset, policy, { ...spec, requestedAmount: 100 }, result)).toThrow("commitment");
    expect(() => verifyResult(dataset, policy, spec, { ...result, absoluteErrorMgL: 0 })).toThrow("reproduced");
    expect(() => verifyResult(dataset, policy, spec, { ...result, ecologicalImprovementVerified: true })).toThrow("reproduced");
    expect(canonicalJson(prepareCase(dataset, policy))).toBe(canonicalJson(spec));
  });
  it("leaves an unavailable exact follow-up pending", () => {
    const spec = prepareCase(dataset, policy);
    const missing = { ...dataset, measurements: dataset.measurements.filter((m) => m.time !== spec.targetTime) };
    expect(() => deliverResult(missing, spec)).toThrow("pending");
  });
  it("rejects altered raw bytes even if JSON represents the same data", () => {
    expect(() => validateDataset(raw + " ", station, manifest)).toThrow("hash mismatch");
  });
  it.each([
    ["station", (j: any) => j.features[0].properties.monitoring_location_id = "USGS-FAKE"],
    ["series", (j: any) => j.features[0].properties.time_series_id = "wrong-series"],
    ["unit", (j: any) => j.features[0].properties.unit_of_measure = "ug/l"],
    ["statistic", (j: any) => j.features[0].properties.statistic_id = "00003"],
    ["duplicate", (j: any) => j.features.push(j.features[0])],
    ["pagination", (j: any) => j.links.push({ rel: "next", href: "https://api.waterdata.usgs.gov/more" })],
    ["interval", (j: any) => j.features[0].properties.time = "2024-08-01T00:00:00Z"]
  ])("rejects invalid %s even with a recomputed importer hash", (_name, edit) => {
    expect(changedRaw(edit)).toThrow();
  });
  it("preserves quality exclusions and skips gaps, never imputes provisional or estimated values", () => {
    const altered = changedRaw((j) => {
      j.features[337].properties.approval_status = "Provisional";
      j.features[338].properties.qualifier = "e";
      j.features[339].properties.value = "";
    })();
    expect(altered.quality.excluded.map((e) => e.reason)).toEqual(["not-approved", "qualified", "missing-or-invalid-value"]);
    expect(altered.quality.missingIntervals).toBe(3);
    expect(replay(altered).skippedGapsOrMissingTargets).toBeGreaterThan(0);
  });
  it("fails a mismatched source URL or station metadata", () => {
    expect(() => validateDataset(raw, station, { ...manifest, sourceUrl: "https://example.com/data" })).toThrow("origin");
    const other = JSON.stringify({ properties: { id: "other", agency_code: "USGS" } });
    expect(() => validateDataset(raw, other, { ...manifest, stationHash: sha256Hex(other) })).toThrow("metadata mismatch");
  });
});
