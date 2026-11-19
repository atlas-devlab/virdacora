// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { reviewArchivedTerritorialCase } from "./archived-review.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../scripts/verify-territorial-archive.ts", import.meta.url));

function runCli(...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

let report: Awaited<ReturnType<typeof reviewArchivedTerritorialCase>>;

beforeAll(async () => {
  report = await reviewArchivedTerritorialCase();
});

describe("offline territorial archive review", () => {
  it("identifies the pinned USGS archive and reproduces the accepted case and result", () => {
    expect(report.version).toBe("territorial-archive-review-v1");
    expect(report.source).toMatchObject({
      stationId: "USGS-14211720",
      timeSeriesId: "1ccd1e712b6b4cb69fdcfbf407f7358b",
      parameterCode: "00300",
      sourceHash: "0x512c37bd9c3b03c76887cd8660945b51bdb32d6e009183f790f6f13b6f72cf57",
      stationHash: "0x298ecdf09d96bf5e30068a150e7ce07a14fbb5d7d05e81c0bb61e8b99d080dea",
      license: "US Government work; public domain",
      unit: "mg/L"
    });
    const source = new URL(report.source.sourceUrl);
    const station = new URL(report.source.stationUrl);
    expect(source.origin).toBe("https://api.waterdata.usgs.gov");
    expect(source.searchParams.get("monitoring_location_id")).toBe(report.source.stationId);
    expect(source.searchParams.get("parameter_code")).toBe(report.source.parameterCode);
    expect(station.origin).toBe(source.origin);
    expect(station.pathname).toContain(`/monitoring-locations/items/${report.source.stationId}`);
    expect(report.source.approvalFilter).toMatch(/approved.*no qualifiers/i);
    expect(Date.parse(report.source.retrievedAt)).toBeGreaterThan(Date.parse(report.source.end));

    expect(report.case).toMatchObject({
      caseHash: "0x3cee978fda3fd8e84c92e2b0a94dec7bdb5fe0c64560c4b13e8e3babd4414f84",
      resultHash: "0x68aba721f7c3c0933aa20c8a1849d64189dc41fd419d40f434cb19444fee90bc",
      policyHash: "0x6dc1ac1dec30cd3a47bee7cadae8b56dcf457ecd7a6789a9ab5a51c0d03eb31a",
      modelVersion: "terravoce-linear-risk-v2-oxygen-units",
      originUtc: "2025-08-08T00:00:00.000Z",
      targetUtc: "2025-08-08T01:00:00.000Z",
      targetRecordId: "538749e2-5a87-4d27-bd89-3424175c6fa4",
      observedMgL: 8.2,
      linearMgL: 8.655594,
      persistenceMgL: 8.4
    });
    expect(report.case.linearErrorMgL).toBeCloseTo(0.455594, 6);
    expect(report.case.persistenceErrorMgL).toBeCloseTo(0.2, 6);
  });

  it("accepts the complete delivery and rejects the altered and incomplete deliveries", () => {
    expect(report.scenarios).toEqual([
      { id: "positive", outcome: "verified", reason: null },
      { id: "altered_delivery", outcome: "rejected", reason: "DELIVERY_NOT_REPRODUCED" },
      { id: "insufficient_delivery", outcome: "rejected", reason: "DELIVERY_NOT_REPRODUCED" }
    ]);
  });

  it("reports the fixed one-hour horizon, persistence advantage and zero low-oxygen events", () => {
    const { evaluation } = report;
    expect(evaluation).toMatchObject({
      horizonSeconds: 3600,
      windowSize: 12,
      acceptedObservations: 673,
      sourceObservations: 673,
      missingIntervals: 0,
      excludedObservations: 0,
      skippedPairs: 0,
      illustrativeThresholdMgL: 5,
      observedLowOxygenEvents: 0,
      assessedPairs: 335
    });
    expect(evaluation.rows).toHaveLength(evaluation.assessedPairs);
    const evaluationStart = Date.parse(evaluation.startUtc);
    expect(evaluationStart).toBe(Date.parse(report.case.originUtc));
    let previousOrigin = evaluationStart - 1;
    for (const row of evaluation.rows) {
      const origin = Date.parse(row.origin);
      const target = Date.parse(row.target);
      expect(origin).toBeGreaterThan(previousOrigin);
      expect(target - origin).toBe(evaluation.horizonSeconds * 1000);
      previousOrigin = origin;
    }
    expect(Date.parse(evaluation.rows.at(-1)!.target)).toBe(Date.parse(report.source.end));
    expect(evaluation.linear.maeMgL).toBeCloseTo(0.242038, 6);
    expect(evaluation.persistence.maeMgL).toBeCloseTo(0.204776, 6);
    expect(evaluation.persistence.maeMgL).toBeLessThan(evaluation.linear.maeMgL);
    expect(evaluation.persistence.rmseMgL).toBeLessThan(evaluation.linear.rmseMgL);
    expect(evaluation.linear).toMatchObject({ falseAlerts: 0, missedLowOxygen: 0 });
    expect(evaluation.persistence).toMatchObject({ falseAlerts: 0, missedLowOxygen: 0 });
  });

  it("repeats the same report without timestamps or generated identities changing it", async () => {
    expect(await reviewArchivedTerritorialCase()).toEqual(report);
  });

  it("keeps JSON and CSV output usable from the command line", () => {
    const json = runCli();
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual(report);

    const csv = runCli("--format", "csv");
    expect(csv.status).toBe(0);
    expect(csv.stderr).toBe("");
    const [header, ...records] = csv.stdout.trimEnd().split("\n");
    expect(header).toContain("origin_utc,target_utc,observed_mg_l,linear_mg_l,persistence_mg_l");
    expect(records).toHaveLength(report.evaluation.assessedPairs);
    const first = report.evaluation.rows[0]!;
    expect(records[0]?.split(",").slice(-5)).toEqual([
      first.origin, first.target, String(first.actual), String(first.linear), String(first.persistence),
    ]);
  }, 22_000);

  it("renders an offline HTML report and rejects an unknown format", () => {
    const html = runCli("--format", "html");
    expect(html.status).toBe(0);
    expect(html.stderr).toBe("");
    expect(html.stdout).toMatch(/^<!doctype html>/);
    expect(html.stdout).toContain(report.source.stationId);
    expect(html.stdout).toContain(report.case.resultHash);
    expect(html.stdout).not.toMatch(/<script\b|<link\b/i);

    const invalid = runCli("--format", "xlsx");
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("Usage:");
  }, 22_000);
});
