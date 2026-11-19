// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { deliverResult, prepareCase } from "./case.js";
import { captureWillametteSnapshot } from "./willamette-capture.js";

const fixtureDirectory = new URL("../../../docs/datasets/usgs-willamette/", import.meta.url);
const [continuous, station, recipeText, policy] = await Promise.all([
  readFile(new URL("continuous.json", fixtureDirectory)),
  readFile(new URL("station.json", fixtureDirectory)),
  readFile(new URL("manifest.json", fixtureDirectory), "utf8"),
  readFile(new URL("../../../policies/usgs-data-review-v1.terra", import.meta.url), "utf8"),
]);
const recipe = JSON.parse(recipeText) as {
  sourceUrl: string; stationUrl: string; retrievedAt: string; evaluationStart: string;
};

type ContinuousFixture = {
  features: { id: string; properties: { time: string; time_series_id: string } }[];
  links: { rel: string; href: string }[];
  numberReturned: number;
};

function providerBody(change: (fixture: ContinuousFixture) => void) {
  const fixture = JSON.parse(continuous.toString("utf8")) as ContinuousFixture;
  change(fixture);
  fixture.numberReturned = fixture.features.length;
  return Buffer.from(JSON.stringify(fixture));
}

function mockProvider({
  continuousBody = continuous,
  stationBody = station,
  stationStatus = 200,
}: { continuousBody?: Uint8Array; stationBody?: Uint8Array; stationStatus?: number } = {}) {
  return vi.fn<typeof fetch>(async (request) => {
    const url = request instanceof Request ? request.url : request.toString();
    if (url === recipe.sourceUrl) return new Response(Uint8Array.from(continuousBody));
    if (url === recipe.stationUrl) return new Response(Uint8Array.from(stationBody), { status: stationStatus });
    throw new Error(`Unexpected USGS request: ${url}`);
  });
}

function sha256(bytes: Uint8Array) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("fresh Willamette evidence capture", () => {
  it("retains exact provider bytes and builds a new manifest for a reproducible territorial case", async () => {
    const continuousBody = Buffer.concat([continuous, Buffer.from("\n")]);
    const stationBody = Buffer.concat([station, Buffer.from("\n")]);
    const fetchImpl = mockProvider({ continuousBody, stationBody });
    const before = Date.now();
    const capture = await captureWillametteSnapshot(fetchImpl);

    const urls = fetchImpl.mock.calls.map(([input]) => (input instanceof Request ? input.url : input.toString()));
    expect(urls.sort()).toEqual([recipe.sourceUrl, recipe.stationUrl].sort());
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(Buffer.from(capture.continuous).equals(continuousBody)).toBe(true);
    expect(Buffer.from(capture.station).equals(stationBody)).toBe(true);
    expect(capture.manifest).toMatchObject({
      sourceUrl: recipe.sourceUrl, stationUrl: recipe.stationUrl, evaluationStart: recipe.evaluationStart,
      sourceHash: sha256(continuousBody), stationHash: sha256(stationBody),
    });
    expect(capture.manifest.retrievedAt).not.toBe(recipe.retrievedAt);
    expect(Date.parse(capture.manifest.retrievedAt)).toBeGreaterThanOrEqual(before);
    expect(capture.dataset.manifest).toEqual(capture.manifest);
    expect(capture.dataset.quality).toMatchObject({ accepted: 673, missingIntervals: 0, excluded: [] });

    const prepared = prepareCase(capture.dataset, policy);
    const delivered = deliverResult(capture.dataset, prepared);
    expect(prepared).toMatchObject({ sourceHash: capture.manifest.sourceHash, origin: "2025-08-08T00:00:00.000Z" });
    expect(delivered.targetRecord).toMatchObject({ time: "2025-08-08T01:00:00.000Z", value: 8.2 });
  });

  it("rejects missing or mismatched station metadata", async () => {
    const notFound = mockProvider({ stationStatus: 404 });
    await expect(captureWillametteSnapshot(notFound)).rejects.toThrow(/404/);

    const stationBody = Buffer.from(JSON.stringify({ properties: { id: "USGS-99999999", agency_code: "USGS" } }));
    await expect(captureWillametteSnapshot(mockProvider({ stationBody }))).rejects.toThrow(/station metadata mismatch/i);
  });

  it("does not accept a partial, off-cadence, or mixed-series response", async () => {
    const partial = providerBody((fixture) => {
      fixture.links.push({ rel: "next", href: recipe.sourceUrl });
    });
    const offCadence = providerBody((fixture) => {
      fixture.features[0]!.properties.time = "2025-08-01T00:01:00Z";
    });
    const mixedSeries = providerBody((fixture) => {
      fixture.features[0]!.properties.time_series_id = "wrong-series";
    });

    await expect(captureWillametteSnapshot(mockProvider({ continuousBody: partial }))).rejects.toThrow(/incomplete|partial/i);
    await expect(captureWillametteSnapshot(mockProvider({ continuousBody: offCadence }))).rejects.toThrow(/cadence|interval/i);
    await expect(captureWillametteSnapshot(mockProvider({ continuousBody: mixedSeries }))).rejects.toThrow(/series/i);
  });

  it.each(["2025-08-07T23:30:00Z", "2025-08-08T01:00:00Z"])(
    "rejects an otherwise valid response without the required observation at %s", async (requiredTime) => {
      const continuousBody = providerBody((fixture) => {
        fixture.features = fixture.features.filter((feature) => Date.parse(feature.properties.time) !== Date.parse(requiredTime));
      });
      await expect(captureWillametteSnapshot(mockProvider({ continuousBody }))).rejects.toThrow();
    },
  );
});
