// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeOxygenValue, parseSourceCsv, readProviderResponse, validateStationWindow, type OxygenSourceBatch,
} from "./source.js";
import { renderOxygenSourceCsv, renderOxygenSourceHtml } from "./source-export.js";

const sourceUrl = new URL("https://example.invalid/oxygen.csv");
const validWindow = { stationId: "USGS-14211720", start: "2024-02-01", end: "2024-03-02" };

describe("shared oxygen source handling", () => {
  it("accepts inclusive calendar windows with at most 31 days", () => {
    expect(() => validateStationWindow(validWindow)).not.toThrow();
    expect(() => validateStationWindow({ ...validWindow, start: "2024-02-29", end: "2024-02-29" })).not.toThrow();
    expect(() => validateStationWindow({ ...validWindow, end: "2024-03-03" })).toThrow(/1 to 31 calendar days/);
    expect(() => validateStationWindow({ ...validWindow, end: "2024-01-31" })).toThrow(/1 to 31 calendar days/);
    expect(() => validateStationWindow({ ...validWindow, end: "2024-02-30" })).toThrow(/invalid calendar date/i);
    expect(() => validateStationWindow({ ...validWindow, end: "2024-02-29T01:00:00Z" })).toThrow(/YYYY-MM-DD/);
  });

  it("normalizes only finite concentrations with recognized units, preserving zero", () => {
    expect(normalizeOxygenValue("0", "mg/L")).toBe(0);
    expect(normalizeOxygenValue("8400", "μg/L")).toBe(8.4);
    expect(normalizeOxygenValue("8.4e0", " mg/l ")).toBe(8.4);
    for (const value of ["<0.5", "ND", "-1", "1e400", "", null]) {
      expect(normalizeOxygenValue(value, "mg/L")).toBeNull();
    }
    for (const unit of ["%", "mg/kg", null]) expect(normalizeOxygenValue("8.4", unit)).toBeNull();
  });

  it("preserves quoted commas, line breaks and double quotes in a source CSV", () => {
    const csv = '\ufeffstation,remark,value\r\n"Station, river","line one\r\n""two""",0\r\n';
    expect(parseSourceCsv(csv, ["station", "value"])).toEqual([
      { station: "Station, river", remark: 'line one\r\n"two"', value: "0" },
    ]);
    expect(() => parseSourceCsv("station,station,value\nx,y,0\n", ["station"])).toThrow(/duplicate/i);
    expect(() => parseSourceCsv("station,remark\nx,quoted\n", ["value"])).toThrow(/missing.*value/i);
  });

  it("rejects a CSV beyond the row limit instead of returning a partial table", () => {
    expect(() => parseSourceCsv(`station,value\n${"x,0\n".repeat(20_001)}`, ["station", "value"]))
      .toThrow(/20,000-row limit/);
  });

  it("hashes original response bytes and disables redirects with a combined timeout signal", async () => {
    const bytes = Buffer.from("\ufeffstation,value\r\nx,0\r\n");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(Uint8Array.from(bytes)));
    const deadline = new AbortController();
    const caller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const result = await readProviderResponse(sourceUrl, fetchImpl, { signal: caller.signal, redirect: "follow" });
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(result.text).toBe("station,value\r\nx,0\r\n");
      expect(result.sha256).toBe("0x" + createHash("sha256").update(bytes).digest("hex"));
      expect(fetchImpl.mock.calls[0]?.[0]).toEqual(sourceUrl);
      const request = fetchImpl.mock.calls[0]?.[1];
      expect(request?.redirect).toBe("error");
      expect(request?.signal?.aborted).toBe(false);
      caller.abort();
      expect(request?.signal?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects a partial HTTP status and an oversized declared or streamed response", async () => {
    const maxBytes = 8 * 1024 * 1024;
    const partial = vi.fn<typeof fetch>(async () => new Response("partial", { status: 206 }));
    await expect(readProviderResponse(sourceUrl, partial)).rejects.toThrow(/HTTP 206/);
    const declared = vi.fn<typeof fetch>(async () => new Response("body", {
      headers: { "Content-Length": String(maxBytes + 1) },
    }));
    await expect(readProviderResponse(sourceUrl, declared)).rejects.toThrow(/8 MiB limit/);
    const streamed = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(maxBytes + 1)));
    await expect(readProviderResponse(sourceUrl, streamed)).rejects.toThrow(/8 MiB limit/);
  });
});

it("escapes provider text in HTML and neutralizes spreadsheet formulas in CSV", () => {
  const batch: OxygenSourceBatch = {
    schema: "virdacora-oxygen-source-v1", provider: "water-rangers",
    sourceUrl: sourceUrl.href, termsUrl: "https://example.invalid/terms",
    attribution: null, retrievedAt: null, sourceSha256: "0xfixture", inputRows: 1,
    readings: [{
      stationId: '  =HYPERLINK("https://example.invalid")', stationName: "<script>alert(1)</script>",
      seriesId: null, activityId: null, recordId: null, organization: null,
      observedAtUtc: null, reportedTime: null, valueText: "0", unit: "mg/L", valueMgL: 0,
      status: "+unsafe", qualifiers: ["<test>"], detectionCondition: null,
    }],
  };
  const html = renderOxygenSourceHtml(batch);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("&lt;test&gt;");
  const csv = renderOxygenSourceCsv(batch);
  expect(parseSourceCsv(csv, ["station_id", "source_status", "oxygen_mg_l"])[0]).toMatchObject({
    station_id: "'" + batch.readings[0]?.stationId,
    source_status: "'+unsafe",
    oxygen_mg_l: "0",
  });
});
