// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { z } from "zod";
import {
  normalizeOxygenValue, readProviderResponse, validateStationWindow,
  type OxygenSourceBatch, type StationWindow, type WaterOxygenReading,
} from "./source.js";

const endpoint = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items";
const termsUrl = "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits";
const parameterCode = "00300";
const statisticCode = "00011";
const maxRows = 2_000;
const dayMs = 86_400_000;

function readUsgsGeoJson(url: URL, fetchImpl: typeof fetch) {
  if (url.origin !== new URL(endpoint).origin || url.username || url.password) {
    throw new Error("Expected an official USGS endpoint.");
  }
  return readProviderResponse(url, fetchImpl, { headers: { accept: "application/geo+json, application/json" } });
}

export function readUsgsContinuousPayload(url: URL, fetchImpl: typeof fetch) {
  if (url.pathname !== new URL(endpoint).pathname) throw new Error("Expected the USGS continuous endpoint.");
  return readUsgsGeoJson(url, fetchImpl);
}

export function readUsgsStationPayload(url: URL, stationId: string, fetchImpl: typeof fetch) {
  if (!/^USGS-\d{8,15}$/.test(stationId) ||
      url.pathname !== `/ogcapi/v1/collections/monitoring-locations/items/${stationId}`) {
    throw new Error("Expected the USGS monitoring-location endpoint for this station.");
  }
  return readUsgsGeoJson(url, fetchImpl);
}

const collection = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.object({
    type: z.literal("Feature"),
    id: z.string().min(1),
    properties: z.object({
      monitoring_location_id: z.string().min(1),
      time_series_id: z.string().min(1),
      parameter_code: z.literal(parameterCode),
      statistic_id: z.literal(statisticCode),
      time: z.iso.datetime({ offset: true }),
      value: z.string().nullable(),
      unit_of_measure: z.string().nullish(),
      approval_status: z.string().nullish(),
      qualifier: z.string().nullish(),
    }),
  })).max(maxRows),
  numberReturned: z.number().int().nonnegative().optional(),
  numberMatched: z.number().int().nonnegative().optional(),
  links: z.array(z.object({ rel: z.string() })),
});

export async function fetchUsgsOxygen(
  query: StationWindow, fetchImpl: typeof fetch = fetch,
): Promise<OxygenSourceBatch> {
  validateStationWindow(query);
  if (!/^USGS-\d{8,15}$/.test(query.stationId)) throw new Error("Expected a USGS monitoring location ID");
  const start = new Date(`${query.start}T00:00:00Z`);
  const endExclusive = new Date(Date.parse(`${query.end}T00:00:00Z`) + dayMs);
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    f: "json", monitoring_location_id: query.stationId, parameter_code: parameterCode, statistic_id: statisticCode,
    time: `${start.toISOString()}/${endExclusive.toISOString()}`, limit: String(maxRows),
  }).toString();

  const { text, sha256 } = await readUsgsContinuousPayload(url, fetchImpl);
  const page = collection.parse(JSON.parse(text));
  if (page.links.some(link => link.rel === "next") ||
      (page.features.length === maxRows && page.numberMatched === undefined) ||
      (page.numberReturned !== undefined && page.numberReturned !== page.features.length) ||
      (page.numberMatched !== undefined && page.numberMatched !== page.features.length)) {
    throw new Error("Incomplete USGS response. Use a shorter date range");
  }

  const readings: WaterOxygenReading[] = [];
  const recordIds = new Set<string>();
  for (const { id, properties } of page.features) {
    const observed = new Date(properties.time);
    if (properties.monitoring_location_id !== query.stationId || observed < start || observed > endExclusive) {
      throw new Error("USGS returned a reading outside the requested station or dates");
    }
    // The upstream interval includes both endpoints. The next day's opening
    // reading is outside the requested inclusive range of calendar days.
    if (observed.getTime() === endExclusive.getTime()) continue;
    if (recordIds.has(id)) throw new Error("USGS returned a duplicate record ID");
    recordIds.add(id);

    const zone = properties.time.endsWith("Z") ? "Z" : properties.time.slice(-6);
    const unit = properties.unit_of_measure ?? null;
    const qualifier = properties.qualifier?.trim() || null;
    readings.push({
      stationId: properties.monitoring_location_id,
      stationName: null,
      seriesId: properties.time_series_id,
      activityId: null,
      recordId: id,
      organization: "USGS",
      observedAtUtc: observed.toISOString(),
      reportedTime: {
        date: properties.time.slice(0, 10),
        time: properties.time.slice(11, -zone.length),
        zone,
      },
      valueText: properties.value,
      unit,
      valueMgL: qualifier && /^[<>≤≥]/.test(qualifier) ? null : normalizeOxygenValue(properties.value, unit),
      status: properties.approval_status ?? null,
      qualifiers: properties.qualifier ? [properties.qualifier] : [],
      detectionCondition: null,
    });
  }
  return {
    schema: "virdacora-oxygen-source-v1",
    provider: "usgs",
    sourceUrl: url.href,
    termsUrl,
    attribution: "U.S. Geological Survey, USGS Water Data for the Nation",
    retrievedAt: new Date().toISOString(),
    sourceSha256: sha256,
    inputRows: page.features.length,
    readings,
  };
}
