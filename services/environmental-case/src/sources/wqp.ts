// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import {
  decodeSource, normalizeOxygenValue, parseSourceCsv, readProviderResponse, validateStationWindow,
  type OxygenSourceBatch, type StationWindow, type WaterOxygenReading,
} from "./source.js";

const resultsEndpoint = "https://waterqualitydata.us/wqx3/Result/search";
const dissolvedOxygen = "Dissolved oxygen (DO)";
const requiredColumns = [
  "Org_Identifier", "Location_Identifier", "Location_Name", "Activity_ActivityIdentifier",
  "Activity_Media", "Activity_StartDate", "Activity_StartTime", "Activity_StartTimeZone",
  "Result_Characteristic", "Result_DataLoggerLine", "Result_MeasureIdentifier", "Result_Measure",
  "Result_MeasureUnit", "Result_MeasureStatusIdentifier", "Result_MeasureQualifierCode",
  "Result_ResultDetectionCondition",
];

function searchDate(date: string): string {
  return [date.slice(5, 7), date.slice(8, 10), date.slice(0, 4)].join("-");
}

function asUtc(date: string, time: string | null, zone: string | null): string | null {
  if (time === null || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(time)) return null;
  if (zone === "UTC" || zone === "GMT" || zone === "Z") zone = "Z";
  else if (zone === null || zone === "-00:00" || !/^(?:[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(zone)) {
    return null;
  }
  return new Date(`${date}T${time}${zone}`).toISOString();
}

function parseQualifiers(raw: string | null): string[] {
  if (raw === null) return [];
  if (!raw.startsWith("[")) return [raw];
  const list: unknown = JSON.parse(raw);
  if (!Array.isArray(list) || !list.every(code => typeof code === "string" && code.trim().length > 0)) {
    throw new Error("Water Quality Portal returned an invalid qualifier list.");
  }
  return list;
}

function readRow(row: Record<string, string>, query: StationWindow): WaterOxygenReading {
  const field = (name: string) => row[name]?.trim() || null;
  const stationId = field("Location_Identifier");
  const date = field("Activity_StartDate");
  const dateValue = new Date(`${date}T00:00:00Z`);
  if (stationId !== query.stationId || field("Activity_Media") !== "Water" ||
      field("Result_Characteristic") !== dissolvedOxygen || date === null ||
      date < query.start || date > query.end || !Number.isFinite(dateValue.valueOf()) ||
      dateValue.toISOString().slice(0, 10) !== date) {
    throw new Error("Water Quality Portal returned a row outside the requested station, metric or date window.");
  }
  const valueText = field("Result_Measure");
  const unit = field("Result_MeasureUnit");
  const detectionCondition = field("Result_ResultDetectionCondition");
  const qualifiers = parseQualifiers(field("Result_MeasureQualifierCode"));
  const censored = detectionCondition !== null || qualifiers.some(code => /[<>≤≥]|\b(?:U|UJ|ND)\b/i.test(code));
  const time = field("Activity_StartTime");
  const zone = field("Activity_StartTimeZone");
  return {
    stationId, stationName: field("Location_Name"), seriesId: null,
    activityId: field("Activity_ActivityIdentifier"), recordId: field("Result_MeasureIdentifier"),
    organization: field("Org_Identifier"),
    // WQX activity time is reported separately from a logger's own reading time.
    observedAtUtc: field("Result_DataLoggerLine") === null ? asUtc(date, time, zone) : null,
    reportedTime: { date, time, zone },
    valueText, unit, valueMgL: censored ? null : normalizeOxygenValue(valueText, unit),
    status: field("Result_MeasureStatusIdentifier"), qualifiers, detectionCondition,
  };
}

function wqpResultsUrl(query: StationWindow): URL {
  validateStationWindow(query);
  const url = new URL(resultsEndpoint);
  url.search = new URLSearchParams({
    siteid: query.stationId,
    characteristicName: dissolvedOxygen,
    sampleMedia: "Water",
    startDateLo: searchDate(query.start),
    startDateHi: searchDate(query.end),
    mimeType: "csv",
    dataProfile: "fullPhysChem",
  }).toString();
  return url;
}

function parseWqpPayload(
  { text, sha256 }: ReturnType<typeof decodeSource>, query: StationWindow, url: URL, retrievedAt: string,
  requireDiscrete = false,
): OxygenSourceBatch {
  const retrieval = new Date(retrievedAt);
  if (!Number.isFinite(retrieval.valueOf()) || retrieval.toISOString() !== retrievedAt) {
    throw new Error("Expected the WQP retrieval timestamp in canonical UTC format.");
  }
  if (/^ERROR:\s+INCOMPLETE DATA\b/im.test(text)) {
    throw new Error("Water Quality Portal reported an incomplete download.");
  }
  const rows = parseSourceCsv(text, requiredColumns);
  if (requireDiscrete && rows.some(row => row.Result_DataLoggerLine?.trim())) {
    throw new Error("The WQP response includes logger records. Choose a discrete-sample dataset for this territorial review.");
  }
  return {
    schema: "virdacora-oxygen-source-v1",
    provider: "wqp",
    sourceUrl: url.toString(),
    termsUrl: "https://waterqualitydata.us/beta/portal_userguide/",
    attribution: "Water Quality Portal (National Water Quality Monitoring Council, USGS, EPA), DOI 10.5066/P9QRKUVJ. Credit the submitting organization recorded on each result.",
    retrievedAt,
    sourceSha256: sha256,
    inputRows: rows.length,
    readings: rows.map(row => readRow(row, query)),
  };
}

/** Reproduce the normalized batch from exact WQX 3.0 response bytes offline. */
export function parseWqpOxygen(
  bytes: Uint8Array, query: StationWindow, retrievedAt: string, options: { requireDiscrete?: boolean } = {},
): OxygenSourceBatch {
  const url = wqpResultsUrl(query);
  return parseWqpPayload(decodeSource(bytes), query, url, retrievedAt, options.requireDiscrete);
}

/** Load the public WQX 3.0 physical/chemical results profile for one station. */
export async function captureWqpOxygen(
  query: StationWindow, fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; batch: OxygenSourceBatch }> {
  const url = wqpResultsUrl(query);
  const payload = await readProviderResponse(url, fetchImpl);
  const batch = parseWqpPayload(payload, query, url, new Date().toISOString());
  return { bytes: payload.bytes, batch };
}

export async function fetchWqpOxygen(query: StationWindow, fetchImpl: typeof fetch = fetch): Promise<OxygenSourceBatch> {
  return (await captureWqpOxygen(query, fetchImpl)).batch;
}
