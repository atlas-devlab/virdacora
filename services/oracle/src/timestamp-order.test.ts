import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { describe, expect, it } from "vitest";

import { analyzeObservations } from "./analysis.js";
import type { StoredObservation } from "./store.js";
import { compareIdsASCII, compareTimestampKeys, timestampMilliseconds } from "./timestamp-order.js";

const id = (value: number): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;

describe("timestamp ordering contract", () => {
  it.each([
    ["1970-01-01T00:00:00.1231Z", 123],
    ["1970-01-01T00:00:00.1239Z", 123],
    ["1970-01-01T00:00:00.9999999Z", 999],
    ["1969-12-31T23:59:59.1239Z", -877],
    ["1969-12-31T23:59:59.9999Z", -1],
    ["1970-01-01T01:00:00.1239+01:00", 123],
    ["1969-12-31T19:00:00.1231-05:00", 123],
    ["1970-01-01T00:00:00Z", 0],
    ["2000-02-29T00:00:00Z", 951782400000]
  ] as const)("resolves %s to epoch milliseconds %s without rounding", (value, expected) => {
    expect(timestampMilliseconds(value)).toBe(expected);
  });

  it.each(["", "invalid", "2026-13-01T00:00:00Z", "+999999-01-01T00:00:00Z"])
    ("rejects nonfinite parsed time %j", value => {
      expect(() => timestampMilliseconds(value)).toThrow(expect.objectContaining({
        code: "INVALID_TIME", statusCode: 422
      }));
    });

  it("uses locale-independent ASCII IDs only after millisecond ties", () => {
    expect(compareIdsASCII(id(9), id(10))).toBe(-1);
    expect(compareIdsASCII(id(10), id(9))).toBe(1);
    expect(compareIdsASCII(id(10), id(10))).toBe(0);
    expect(compareIdsASCII("A", "a")).toBe(-1);
    expect(compareTimestampKeys(-877, id(9), -877, id(10))).toBe(-1);
    expect(compareTimestampKeys(124, id(1), 123, id(10))).toBeGreaterThan(0);
  });
});

describe("analysis ordering without changing the numerical recipe", () => {
  const timestamps = ["2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z",
    "2026-10-01T02:00:00Z", "2026-10-01T03:00:00.1239Z", "2026-10-01T03:00:00.1231Z"];
  const ids = [1, 2, 3, 9, 10];
  const rows: StoredObservation[] = timestamps.map((observedAt, index) => ({
    observationId: id(ids[index]!), observation: {
      sensorId: "sensor-01", regionId: "region-01", metric: "water.oxygen.mg_l",
      value: 5, unit: "mg/L", observedAt, sequence: index + 1, signature: "YQ=="
    }
  }));

  it("keeps original timestamp text and the same evidence for every arrival order", () => {
    const before = structuredClone(rows);
    const expectedCore = {
      modelVersion: "terravoce-linear-risk-v1", regionId: "region-01", metric: "water.oxygen.mg_l",
      generatedAt: "2026-10-01T03:00:00.1231Z", observationIds: ids.map(id),
      forecastHorizonSeconds: 3600, currentValue: 5, forecastValue: 5, slopePerHour: 0,
      anomalyScore: 0, confidence: 0.416667, risk: 0
    };
    const expected = analyzeObservations(rows, 3600);
    expect(expected.modelVersion).toBe(expectedCore.modelVersion);
    expect(expected.evidenceHash).toBe(sha256Hex(`evidence:${canonicalJson(expectedCore)}`));
    expect(expected.assessmentId).toBe(sha256Hex(`assessment:${canonicalJson(expectedCore)}`));
    expect(expected.generatedAt).toBe(expectedCore.generatedAt);
    for (const order of [[...rows].reverse(), [rows[3]!, rows[1]!, rows[4]!, rows[0]!, rows[2]!]]) {
      expect(analyzeObservations(order, 3600)).toEqual(expected);
    }
    expect(rows).toEqual(before);
  });

  it("rejects invalid time even in a series where sorting might not compare every row", () => {
    const invalid = structuredClone(rows);
    invalid[2]!.observation.observedAt = "invalid";
    expect(() => analyzeObservations(invalid, 3600)).toThrow(expect.objectContaining({
      code: "INVALID_TIME", statusCode: 422
    }));
  });
});
