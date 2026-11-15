import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Hex } from "@terravoce/protocol";
import { z } from "zod";

export const manifestSchema = z.object({
  version: z.literal("usgs-snapshot-v1"),
  sourceUrl: z.url(), stationUrl: z.url(), retrievedAt: z.iso.datetime(),
  sourceHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  stationHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  license: z.literal("US Government work; public domain"),
  stationId: z.literal("USGS-14211720"),
  timeSeriesId: z.literal("1ccd1e712b6b4cb69fdcfbf407f7358b"),
  parameterCode: z.literal("00300"),
  start: z.iso.datetime(), end: z.iso.datetime(),
  evaluationStart: z.iso.datetime(),
  cadenceSeconds: z.literal(1800), horizonSeconds: z.literal(3600),
  windowSize: z.literal(12), illustrativeThresholdMgL: z.literal(5)
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
const featureSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    monitoring_location_id: z.string(), time_series_id: z.string(),
    parameter_code: z.string(), statistic_id: z.string(),
    time: z.iso.datetime({ offset: true }), value: z.string().nullable(),
    unit_of_measure: z.string(), approval_status: z.string(),
    qualifier: z.unknown(), last_modified: z.iso.datetime({ offset: true })
  })
});
const collectionSchema = z.object({
  type: z.literal("FeatureCollection"), features: z.array(featureSchema),
  numberReturned: z.number().int().nonnegative().optional(),
  links: z.array(z.object({ rel: z.string(), href: z.string() }))
});
export interface Measurement {
  id: string; time: string; value: number; lastModified: string;
}
export interface Dataset {
  manifest: Manifest;
  measurements: Measurement[];
  quality: { total: number; accepted: number; excluded: { id: string; reason: string }[];
    missingIntervals: number; unit: "mg/L"; approval: "Approved" };
}
export function validateDataset(raw: string, stationRaw: string, input: unknown): Dataset {
  const manifest = manifestSchema.parse(input);
  if (sha256Hex(raw) !== manifest.sourceHash || sha256Hex(stationRaw) !== manifest.stationHash) {
    throw new Error("Snapshot hash mismatch");
  }
  for (const source of [manifest.sourceUrl, manifest.stationUrl]) {
    const url = new URL(source);
    if (url.origin !== "https://api.waterdata.usgs.gov" || url.username || url.password) {
      throw new Error("Untrusted source origin");
    }
  }
  const source = new URL(manifest.sourceUrl);
  if (source.pathname !== "/ogcapi/v1/collections/continuous/items" ||
      source.searchParams.get("monitoring_location_id") !== manifest.stationId ||
      source.searchParams.get("parameter_code") !== manifest.parameterCode ||
      source.searchParams.get("time") !== `${manifest.start}/${manifest.end}` ||
      source.searchParams.get("limit") !== "10000" || source.searchParams.get("f") !== "json" ||
      new URL(manifest.stationUrl).pathname !== `/ogcapi/v1/collections/monitoring-locations/items/${manifest.stationId}`) {
    throw new Error("Source query does not match manifest");
  }
  const station = z.object({ properties: z.object({ id: z.string(), agency_code: z.literal("USGS") }) }).parse(JSON.parse(stationRaw));
  if (station.properties.id !== manifest.stationId) throw new Error("Station metadata mismatch");
  const start = Date.parse(manifest.start), end = Date.parse(manifest.end);
  const evaluationStart = Date.parse(manifest.evaluationStart);
  if (start >= evaluationStart || evaluationStart >= end) throw new Error("Invalid evaluation split");
  const data = collectionSchema.parse(JSON.parse(raw));
  if (data.links.some((link) => link.rel === "next") || data.features.length >= 10000 ||
      (data.numberReturned !== undefined && data.numberReturned !== data.features.length)) {
    throw new Error("Incomplete or inconsistent snapshot");
  }
  const measurements: Measurement[] = [], excluded: Dataset["quality"]["excluded"] = [];
  const ids = new Set<string>(), times = new Set<number>();
  for (const feature of data.features) {
    const p = feature.properties, time = Date.parse(p.time);
    if (ids.has(feature.id) || times.has(time)) throw new Error("Duplicate source id or timestamp");
    ids.add(feature.id); times.add(time);
    if (p.monitoring_location_id !== manifest.stationId || p.time_series_id !== manifest.timeSeriesId ||
        p.parameter_code !== manifest.parameterCode || p.statistic_id !== "00011") {
      throw new Error("Mixed station, parameter, statistic or time series");
    }
    if (!/^(mg\/l)$/i.test(p.unit_of_measure)) throw new Error("Unexpected oxygen unit");
    if (time < start || time > end || (time - start) % (manifest.cadenceSeconds * 1000) !== 0) {
      throw new Error("Timestamp outside interval or cadence");
    }
    const value = p.value === null || p.value.trim() === "" ? NaN : Number(p.value);
    const reason = p.approval_status !== "Approved" ? "not-approved" :
      p.qualifier !== null && p.qualifier !== "" ? "qualified" :
      !Number.isFinite(value) || value < 0 ? "missing-or-invalid-value" : undefined;
    if (reason) { excluded.push({ id: feature.id, reason }); continue; }
    measurements.push({ id: feature.id, time: new Date(time).toISOString(), value,
      lastModified: new Date(p.last_modified).toISOString() });
  }
  measurements.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (measurements.length < 14) throw new Error("Insufficient approved data");
  const expected = (end - start) / (manifest.cadenceSeconds * 1000) + 1;
  return { manifest, measurements, quality: { total: data.features.length, accepted: measurements.length,
    excluded, missingIntervals: expected - measurements.length, unit: "mg/L", approval: "Approved" } };
}
export async function loadDataset(folder: string): Promise<Dataset> {
  const [raw, station, manifest] = await Promise.all([
    readFile(resolve(folder, "continuous.json"), "utf8"),
    readFile(resolve(folder, "station.json"), "utf8"),
    readFile(resolve(folder, "manifest.json"), "utf8")
  ]);
  return validateDataset(raw, station, JSON.parse(manifest));
}
