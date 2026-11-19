// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { readFile } from "node:fs/promises";
import { manifestSchema, validateDataset } from "./dataset.js";
import { windowAt } from "./replay.js";
import { readUsgsContinuousPayload, readUsgsStationPayload } from "./sources/usgs.js";

const recipeFile = new URL("../../../docs/datasets/usgs-willamette/manifest.json", import.meta.url);

/** Acquire the exact historical window required by the existing Willamette policy. */
export async function captureWillametteSnapshot(fetchImpl: typeof fetch = fetch) {
  // Keep the station, series, interval, and evaluation split pinned by the protocol.
  // The archived hashes are replaced only with hashes of the two new HTTP bodies.
  const recipe = manifestSchema.parse(JSON.parse(await readFile(recipeFile, "utf8")));
  const [continuous, station] = await Promise.all([
    readUsgsContinuousPayload(new URL(recipe.sourceUrl), fetchImpl),
    readUsgsStationPayload(new URL(recipe.stationUrl), recipe.stationId, fetchImpl),
  ]);
  const manifest = { ...recipe, sourceHash: continuous.sha256, stationHash: station.sha256,
    retrievedAt: new Date().toISOString() };
  const dataset = validateDataset(continuous.bytes, station.bytes, manifest);
  const origin = new Date(manifest.evaluationStart).toISOString();
  const target = new Date(Date.parse(origin) + manifest.horizonSeconds * 1000).toISOString();
  windowAt(dataset, origin);
  if (!dataset.measurements.some(measurement => measurement.time === target)) {
    throw new Error("The acquired archive has no approved measurement at the territorial target.");
  }
  return { manifest, continuous: continuous.bytes, station: station.bytes, dataset };
}
