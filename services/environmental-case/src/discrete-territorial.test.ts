// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@terravoce/protocol";
import { describe, expect, it } from "vitest";
import {
  loadDiscreteTerritorialCase, makeDiscreteTerritorialCandidate, prepareDiscreteTerritorialCase,
  reviewDiscreteTerritorialDelivery,
} from "./discrete-territorial.js";

const stationId = "USGS-01463500";
const capturedAt = "2026-01-01T00:00:00.000Z";
const wqpRecord = {
  Org_Identifier: "USGS",
  Location_Identifier: stationId,
  Location_Name: "Test station for the discrete review",
  Activity_ActivityIdentifier: "activity-1",
  Activity_Media: "Water",
  Activity_StartDate: "2022-08-10",
  Activity_StartTime: "10:30:00",
  Activity_StartTimeZone: "EDT",
  Result_Characteristic: "Dissolved oxygen (DO)",
  Result_DataLoggerLine: "",
  Result_MeasureIdentifier: "sample-1",
  Result_Measure: "8.2",
  Result_MeasureUnit: "mg/L",
  Result_MeasureStatusIdentifier: "Accepted",
  Result_MeasureQualifierCode: "",
  Result_ResultDetectionCondition: "",
};

function wqpCsv(...rows: Partial<typeof wqpRecord>[]): Buffer {
  const data = rows.map((record) => Object.values({ ...wqpRecord, ...record })
    .map((value) => `"${value.replaceAll('"', '""')}"`).join(","));
  return Buffer.from([Object.keys(wqpRecord).join(","), ...data, ""].join("\r\n"));
}

const wqpBytes = wqpCsv(
  {},
  {
    Activity_ActivityIdentifier: "activity-2", Activity_StartDate: "2022-08-25",
    Result_MeasureIdentifier: "sample-2", Result_Measure: "8600", Result_MeasureUnit: "ug/L",
    Result_MeasureStatusIdentifier: "Approved",
  },
  { Result_MeasureIdentifier: "provisional", Result_Measure: "109", Result_MeasureStatusIdentifier: "Provisional" },
  { Result_MeasureIdentifier: "qualified", Result_Measure: "7.0", Result_MeasureQualifierCode: "J" },
  { Result_MeasureIdentifier: "censored", Result_Measure: "0.1", Result_ResultDetectionCondition: "Not Detected" },
  { Result_MeasureIdentifier: "non-finite", Result_Measure: "Infinity" },
);
const wqpManifest = {
  schema: "virdacora-discrete-oxygen-archive-v1",
  provider: "wqp",
  stationId,
  capturedAt,
  rawSha256: sha256Hex(wqpBytes),
  start: "2022-08-01",
  end: "2022-08-31",
} as const;

const rangersBytes = Buffer.from([
  "location,site_id,observed_on,oxygen,observation_id",
  `Community sample site,${stationId},2022-08-10,8.2,123`,
  `Community sample site,${stationId},2022-08-25,8.6,456`,
  "",
].join("\n"));
const rangersManifest = {
  schema: "virdacora-discrete-oxygen-archive-v1",
  provider: "water-rangers",
  stationId,
  capturedAt,
  rawSha256: sha256Hex(rangersBytes),
  datasetUrl: "https://data.waterrangers.com/datasets/discrete-test",
  attribution: "SOURCE: Discrete test dataset by Example Community is licensed under Open Data Commons Attribution Licence (ODC-By).",
  origin: "public-record-transcription",
  recordUrls: ["https://data.waterrangers.com/observations/123", "https://data.waterrangers.com/observations/456"],
} as const;

async function withWqpSource(run: (sourceFolder: string, rawPath: string) => Promise<void>) {
  const sourceFolder = await mkdtemp(join(tmpdir(), "virdacora-discrete-test-"));
  const manifestPath = join(sourceFolder, "manifest.json");
  const rawPath = join(sourceFolder, "observations.csv");
  try {
    await writeFile(manifestPath, JSON.stringify(wqpManifest));
    await writeFile(rawPath, wqpBytes);
    await run(sourceFolder, rawPath);
  } finally {
    await rm(rawPath, { force: true });
    await rm(manifestPath, { force: true });
    await rmdir(sourceFolder);
  }
}

describe("discrete territorial oxygen review", () => {
  it("lists every WQP record and limits descriptive metrics to eligible measurements", () => {
    const { spec, result } = prepareDiscreteTerritorialCase(wqpManifest, wqpBytes);
    expect(spec).toMatchObject({ provider: "wqp", stationId });
    expect(result.summary).toMatchObject({ recordCount: 6, includedCount: 2, excludedCount: 4,
      distinctDates: 2, minMgL: 8.2, maxMgL: 8.6 });
    expect(result.summary.meanMgL).toBeCloseTo(8.4);
    expect(result.readings).toMatchObject([
      { recordId: "sample-1", valueMgL: 8.2, summaryDisposition: "included" },
      { recordId: "sample-2", valueMgL: 8.6, summaryDisposition: "included" },
      { recordId: "provisional", status: "Provisional", summaryDisposition: "provider-quality" },
      { recordId: "qualified", qualifiers: ["J"], summaryDisposition: "provider-quality" },
      { recordId: "censored", detectionCondition: "Not Detected", summaryDisposition: "non-numeric-or-censored" },
      { recordId: "non-finite", valueMgL: null, summaryDisposition: "non-numeric-or-censored" },
    ]);
  });

  it("binds provider station selection and original file bytes at preparation", () => {
    expect(() => prepareDiscreteTerritorialCase({ ...wqpManifest, stationId: "USGS-99999999" }, wqpBytes)).toThrow(/station/i);
    expect(() => prepareDiscreteTerritorialCase(wqpManifest, Buffer.concat([wqpBytes, Buffer.from("\n")]))).toThrow(/hash|digest|sha-256/i);
  });

  it("rejects a WQP logger record in a discrete territorial case", () => {
    const loggerCsv = wqpCsv({ Result_DataLoggerLine: "1" });
    expect(() => prepareDiscreteTerritorialCase({ ...wqpManifest, rawSha256: sha256Hex(loggerCsv) }, loggerCsv))
      .toThrow(/includes logger records/);
  });

  it("keeps dates, attribution, and provider-specific station identity for Water Rangers", () => {
    const wqp = prepareDiscreteTerritorialCase(wqpManifest, wqpBytes);
    const rangers = prepareDiscreteTerritorialCase(rangersManifest, rangersBytes);
    expect(rangers.spec).toMatchObject({ provider: "water-rangers", stationId,
      source: { attribution: rangersManifest.attribution } });
    expect(rangers.spec.regionId).not.toBe(wqp.spec.regionId);
    expect(rangers.spec.caseHash).not.toBe(wqp.spec.caseHash);
    expect(rangers.result.readings).toMatchObject([
      { recordId: "123", status: null, observedAtUtc: null, reportedTime: { date: "2022-08-10", time: null },
        publicRecordUrl: rangersManifest.recordUrls[0] },
      { recordId: "456", status: null, observedAtUtc: null, reportedTime: { date: "2022-08-25", time: null },
        publicRecordUrl: rangersManifest.recordUrls[1] },
    ]);
    expect(() => prepareDiscreteTerritorialCase({ ...rangersManifest,
      recordUrls: ["https://data.waterrangers.com/observations/123"] }, rangersBytes)).toThrow(/record|observation/i);
  });

  it("reloads the source for every review and rejects altered bytes", async () => {
    await withWqpSource(async (sourceFolder, rawPath) => {
      const { spec, result } = await loadDiscreteTerritorialCase(sourceFolder);
      const review = () => reviewDiscreteTerritorialDelivery({ sourceFolder, committedCase: spec,
        fundedCaseHash: spec.caseHash, submittedResultHash: result.resultHash, candidate: result });
      await expect(review()).resolves.toMatchObject({ verified: true });
      await expect(reviewDiscreteTerritorialDelivery({ sourceFolder, committedCase: spec,
        fundedCaseHash: spec.caseHash, submittedResultHash: sha256Hex("unrelated result"), candidate: result }))
        .rejects.toMatchObject({ code: "RESULT_COMMITMENT_MISMATCH" });
      await writeFile(rawPath, Buffer.concat([wqpBytes, Buffer.from("\n")]));
      await expect(review()).rejects.toMatchObject({ code: "SOURCE_INTEGRITY_FAILED" });
    });
  });

  it.each(["altered_delivery", "insufficient_delivery"] as const)(
    "rejects %s even with a recalculated delivery hash", async (scenario) => {
      await withWqpSource(async (sourceFolder) => {
        const { spec, result } = await loadDiscreteTerritorialCase(sourceFolder);
        const candidate = makeDiscreteTerritorialCandidate(result, scenario);
        expect(candidate.resultHash).not.toBe(result.resultHash);
        await expect(reviewDiscreteTerritorialDelivery({ sourceFolder, committedCase: spec,
          fundedCaseHash: spec.caseHash, submittedResultHash: candidate.resultHash, candidate }))
          .rejects.toMatchObject({ code: "DELIVERY_NOT_REPRODUCED" });
      });
    },
  );
});
