// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fetchWqpOxygen } from "./wqp.js";

const query = { stationId: "USGS-14211720", start: "2025-08-01", end: "2025-08-31" };
const sample = {
  Org_Identifier: "USGS",
  Location_Identifier: query.stationId,
  Location_Name: "WILLAMETTE RIVER AT PORTLAND, OR",
  Activity_ActivityIdentifier: "activity-1",
  Activity_Media: "Water",
  Activity_StartDate: "2025-08-18",
  Activity_StartTime: "11:20:00",
  Activity_StartTimeZone: "PDT",
  Result_Characteristic: "Dissolved oxygen (DO)",
  Result_DataLoggerLine: "",
  Result_MeasureIdentifier: "measurement-1",
  Result_Measure: "8.6",
  Result_MeasureUnit: "mg/L",
  Result_MeasureStatusIdentifier: "Provisional",
  Result_MeasureQualifierCode: "",
  Result_ResultDetectionCondition: "",
};

function csv(...rows: Partial<typeof sample>[]): string {
  const data = rows.map(row => Object.values({ ...sample, ...row })
    .map(value => `"${value.replaceAll('"', '""')}"`).join(","));
  return [Object.keys(sample).join(","), ...data, ""].join("\r\n");
}

function fromPortal(body: string) {
  return vi.fn<typeof fetch>(async () => new Response(body));
}

describe("Water Quality Portal dissolved oxygen", () => {
  it("loads one bounded WQX 3.0 CSV and preserves the submitting organization and local time", async () => {
    const raw = csv({});
    const fetchImpl = fromPortal(raw);
    const result = await fetchWqpOxygen(query, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://waterqualitydata.us/wqx3/Result/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      siteid: query.stationId,
      characteristicName: "Dissolved oxygen (DO)",
      sampleMedia: "Water",
      startDateLo: "08-01-2025",
      startDateHi: "08-31-2025",
      mimeType: "csv",
      dataProfile: "fullPhysChem",
    });
    expect(result).toMatchObject({ provider: "wqp", inputRows: 1, sourceUrl: url.href });
    expect(result.sourceSha256).toBe(`0x${createHash("sha256").update(raw).digest("hex")}`);
    expect(result.readings).toEqual([{
      stationId: query.stationId,
      stationName: "WILLAMETTE RIVER AT PORTLAND, OR",
      organization: "USGS",
      activityId: "activity-1",
      recordId: "measurement-1",
      seriesId: null,
      observedAtUtc: null,
      reportedTime: { date: "2025-08-18", time: "11:20:00", zone: "PDT" },
      valueText: "8.6",
      unit: "mg/L",
      valueMgL: 8.6,
      status: "Provisional",
      qualifiers: [],
      detectionCondition: null,
    }]);
  });

  it("handles explicit time offsets while retaining detection, qualifiers and units", async () => {
    const result = await fetchWqpOxygen(query, fromPortal(csv(
      {
        Activity_StartTimeZone: "-07:00",
        Result_Measure: "8600",
        Result_MeasureUnit: "ug/L",
        Result_MeasureIdentifier: "measurement-1",
        Result_MeasureQualifierCode: '["J","Q"]',
      },
      {
        Activity_StartTimeZone: "UTC",
        Result_DataLoggerLine: "provider line 17",
        Result_MeasureIdentifier: "measurement-2",
        Result_Measure: "0.1",
        Result_MeasureQualifierCode: "U",
        Result_ResultDetectionCondition: "Not Detected",
      },
      {
        Activity_StartTime: "",
        Result_MeasureIdentifier: "measurement-3",
        Result_Measure: "95",
        Result_MeasureUnit: "%",
      },
    )));
    expect(result.readings).toMatchObject([
      { observedAtUtc: "2025-08-18T18:20:00.000Z", qualifiers: ["J", "Q"], valueMgL: 8.6 },
      { observedAtUtc: null, qualifiers: ["U"], detectionCondition: "Not Detected", valueText: "0.1", valueMgL: null },
      { observedAtUtc: null, unit: "%", valueText: "95", valueMgL: null },
    ]);
  });

  it("accepts an empty result and rejects a partial or out-of-scope response", async () => {
    await expect(fetchWqpOxygen(query, fromPortal(csv()))).resolves.toMatchObject({ inputRows: 0, readings: [] });
    await expect(fetchWqpOxygen(query, fromPortal(csv({}) + "ERROR: INCOMPLETE DATA - RETRY\n")))
      .rejects.toThrow("incomplete download");
    await expect(fetchWqpOxygen(query, fromPortal(csv({ Location_Identifier: "OTHER-station" }))))
      .rejects.toThrow("outside the requested station");
    await expect(fetchWqpOxygen(query, fromPortal(csv({ Activity_StartDate: "2025-09-01" }))))
      .rejects.toThrow("outside the requested station");
  });

  it("validates the date window before network access", async () => {
    const fetchImpl = fromPortal(csv());
    await expect(fetchWqpOxygen({ ...query, end: "2025-09-01" }, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
