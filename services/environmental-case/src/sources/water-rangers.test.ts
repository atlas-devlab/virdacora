// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { importWaterRangersOxygen } from "./water-rangers.js";

const requiredFields = "location,site_id,observed_on,oxygen,observation_id,observed_by,testers";
const input = {
  datasetUrl: "https://data.waterrangers.com/datasets/example/observations",
  attribution: "SOURCE: Example dataset by Example Organization is licensed under Open Data Commons Attribution Licence (ODC-By).",
  bytes: Buffer.from([
    "\uFEFF" + requiredFields,
    '"Creek, east bank",LOC-1,2025-05-21,8.25,17,Sample Person,Other Person',
    "Creek west bank,,2025-05-22,<1,18,,",
    "Creek upper bank,,2025-05-23,,19,,",
  ].join("\r\n")),
};

describe("Water Rangers simple observation table", () => {
  it("retains provenance, a date-only observation, and the raw nonnumeric reading", () => {
    const batch = importWaterRangersOxygen(input);
    expect(batch).toMatchObject({
      provider: "water-rangers", sourceUrl: input.datasetUrl,
      sourceSha256: `0x${createHash("sha256").update(input.bytes).digest("hex")}`,
      retrievedAt: null, attribution: input.attribution, inputRows: 3,
      termsUrl: "https://opendatacommons.org/licenses/by/1-0/",
    });
    expect(batch.readings).toHaveLength(2);
    expect(batch.readings[0]).toEqual({
      stationId: "LOC-1", stationName: "Creek, east bank", seriesId: null, activityId: null,
      recordId: "17", organization: null, observedAtUtc: null,
      reportedTime: { date: "2025-05-21", time: null, zone: null },
      valueText: "8.25", unit: "mg/L", valueMgL: 8.25, status: null, qualifiers: [], detectionCondition: null,
    });
    expect(batch.readings[1]).toMatchObject({ stationId: "Creek west bank", valueText: "<1", valueMgL: null });
    expect(JSON.stringify(batch)).not.toMatch(/Sample Person|Other Person/);
  });

  it("requires the documented table, dataset attribution and safe source URL", () => {
    expect(() => importWaterRangersOxygen({ ...input, bytes: Buffer.from("location,oxygen\nCreek,8.25") })).toThrow();
    expect(() => importWaterRangersOxygen({ ...input, attribution: " " })).toThrow(/attribution/);
    expect(() => importWaterRangersOxygen({ ...input, datasetUrl: "https://data.waterrangers.com.evil.example/datasets/a" })).toThrow(/dataset page/);
    expect(() => importWaterRangersOxygen({ ...input, datasetUrl: "https://data.waterrangers.com/datasets/a?api_key=sample" })).toThrow(/dataset page/);
  });

  it("rejects a day that would be silently shifted by a date parser", () => {
    expect(() => importWaterRangersOxygen({
      ...input, bytes: Buffer.from(`${requiredFields}\nCreek,,2025-02-30,8.25,42,,`),
    })).toThrow(/date is invalid/);
  });
});
