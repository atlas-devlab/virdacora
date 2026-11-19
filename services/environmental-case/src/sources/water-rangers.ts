// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { decodeSource, normalizeOxygenValue, parseSourceCsv, type OxygenSourceBatch, type WaterOxygenReading } from "./source.js";

const platform = "https://data.waterrangers.com";
const dataLicense = "https://opendatacommons.org/licenses/by/1-0/";

export function importWaterRangersOxygen(input: {
  bytes: Uint8Array;
  datasetUrl: string;
  attribution: string;
}): OxygenSourceBatch {
  const datasetUrl = new URL(input.datasetUrl);
  if (datasetUrl.origin !== platform || datasetUrl.username || datasetUrl.password ||
      datasetUrl.search || datasetUrl.hash ||
      !/^\/datasets\/[\w-]+(?:\/observations)?\/?$/.test(datasetUrl.pathname)) {
    throw new Error("Provide the public Water Rangers dataset page URL.");
  }
  const attribution = input.attribution.trim();
  if (!attribution) throw new Error("Provide the dataset attribution shown by Water Rangers.");

  // Water Rangers documents these column keys for its one-observation-per-row table.
  // The separate reading-level export has a different schema.
  const { text, sha256 } = decodeSource(input.bytes);
  const rows = parseSourceCsv(text, ["location", "observed_on", "oxygen", "observation_id"]);
  const readings: WaterOxygenReading[] = [];
  for (const row of rows) {
    const valueText = row.oxygen?.trim();
    if (!valueText) continue;
    const stationName = row.location?.trim();
    const recordId = row.observation_id?.trim();
    const date = row.observed_on?.trim();
    if (!stationName || !recordId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("A Water Rangers oxygen observation is missing its location, ID or date.");
    }
    const calendarDate = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(calendarDate.valueOf()) || calendarDate.toISOString().slice(0, 10) !== date) {
      throw new Error("A Water Rangers observation date is invalid.");
    }

    // The dictionary makes site_id optional; the published location is then
    // the dataset's location reference. A date alone never becomes a UTC time.
    readings.push({
      stationId: row.site_id?.trim() || stationName, stationName,
      seriesId: null, activityId: null, recordId, organization: null,
      observedAtUtc: null, reportedTime: { date, time: null, zone: null },
      valueText, unit: "mg/L", valueMgL: normalizeOxygenValue(valueText, "mg/L"),
      status: null, qualifiers: [], detectionCondition: null,
    });
  }

  return {
    schema: "virdacora-oxygen-source-v1", provider: "water-rangers", sourceUrl: datasetUrl.href,
    termsUrl: dataLicense, attribution, retrievedAt: null, sourceSha256: sha256,
    inputRows: rows.length, readings,
  };
}
