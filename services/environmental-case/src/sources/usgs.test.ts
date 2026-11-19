// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fetchUsgsOxygen } from "./usgs.js";

const window = { stationId: "USGS-14211720", start: "2025-08-08", end: "2025-08-08" };
const properties = {
  monitoring_location_id: window.stationId, time_series_id: "fixture-series", parameter_code: "00300",
  statistic_id: "00011",
  time: "2025-08-07T17:00:00.251234-07:00", value: "8.40", unit_of_measure: "mg/l",
  approval_status: "Approved", qualifier: null,
};

function feature(id: string, overrides: Record<string, unknown> = {}) {
  return { type: "Feature", id, properties: { ...properties, ...overrides } };
}

function response(features: ReturnType<typeof feature>[], fields: Record<string, unknown> = {}) {
  const text = JSON.stringify({
    type: "FeatureCollection", features, numberReturned: features.length, links: [], ...fields,
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(text, {
    headers: { "Content-Type": "application/geo+json" },
  }));
  return { fetchImpl, sha256: createHash("sha256").update(text).digest("hex") };
}

describe("USGS continuous oxygen source", () => {
  it("queries the official endpoint and keeps the original measure, series, UTC and quality", async () => {
    const { fetchImpl, sha256 } = response([
      feature("valid-feature"),
      feature("provisional-feature", {
        time: "2025-08-08T23:59:59.999Z", value: null, approval_status: "Provisional", qualifier: "Ice",
      }),
      feature("next-day-boundary", { time: "2025-08-09T00:00:00Z" }),
    ]);
    const batch = await fetchUsgsOxygen(window, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(batch.sourceUrl);
    expect(url.origin + url.pathname).toBe("https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items");
    expect(url.searchParams.get("parameter_code")).toBe("00300");
    expect(url.searchParams.get("statistic_id")).toBe("00011");
    expect(url.searchParams.get("monitoring_location_id")).toBe(window.stationId);
    expect(url.searchParams.get("time")).toBe("2025-08-08T00:00:00.000Z/2025-08-09T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("2000");
    expect(batch.sourceSha256).toMatch(new RegExp(`${sha256}$`));
    expect(batch).toMatchObject({ provider: "usgs", inputRows: 3 });
    expect(batch.readings).toHaveLength(2);
    expect(batch.readings[0]).toEqual({
      stationId: window.stationId, stationName: null, seriesId: "fixture-series",
      activityId: null, recordId: "valid-feature", organization: "USGS",
      observedAtUtc: "2025-08-08T00:00:00.251Z",
      reportedTime: { date: "2025-08-07", time: "17:00:00.251234", zone: "-07:00" },
      valueText: "8.40", unit: "mg/l", valueMgL: 8.4, status: "Approved",
      qualifiers: [], detectionCondition: null,
    });
    expect(batch.readings[1]).toMatchObject({
      recordId: "provisional-feature", valueText: null, valueMgL: null, status: "Provisional", qualifiers: ["Ice"],
    });
  });

  it.each([
    { links: [{ rel: "next", href: "https://example.invalid/" }] },
    { numberMatched: 2 },
    { numberReturned: 2 },
  ])("rejects a partial response (%j)", async (metadata) => {
    const { fetchImpl } = response([feature("only-row")], metadata);
    await expect(fetchUsgsOxygen(window, fetchImpl)).rejects.toThrow(/incomplete USGS/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects other stations, duplicate records and invalid station IDs", async () => {
    const outside = response([feature("other", { monitoring_location_id: "USGS-14212000" })]);
    await expect(fetchUsgsOxygen(window, outside.fetchImpl)).rejects.toThrow(/outside the requested station/);

    const duplicates = response([feature("duplicate"), feature("duplicate")]);
    await expect(fetchUsgsOxygen(window, duplicates.fetchImpl)).rejects.toThrow(/duplicate record ID/);

    const invalid = response([]);
    await expect(fetchUsgsOxygen({ ...window, stationId: "LOCAL-1" }, invalid.fetchImpl)).rejects.toThrow(/USGS monitoring location ID/);
    expect(invalid.fetchImpl).not.toHaveBeenCalled();
  });
});
