import { generateKeyPairSync } from "node:crypto";
import { analyzeObservations, type StoredObservation } from "@terravoce/oracle";
import { observationId, signObservation } from "@terravoce/protocol";
import type { Dataset, Measurement } from "./dataset.js";

export function importerObservations(measurements: Measurement[]) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const observations: StoredObservation[] = measurements.map((m, sequence) => {
    const unsigned = { sensorId: "usgs-http-importer-14211720", regionId: "US-USGS-14211720",
      metric: "water.oxygen.mg_l", value: m.value, unit: "mg/L", observedAt: m.time, sequence };
    return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateDer) };
  });
  return { observations, publicKeyDerBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}
export function windowAt(dataset: Dataset, originTime: string): Measurement[] {
  const index = dataset.measurements.findIndex((m) => m.time === originTime);
  if (index < dataset.manifest.windowSize - 1) throw new Error("Insufficient origin history");
  const window = dataset.measurements.slice(index - dataset.manifest.windowSize + 1, index + 1);
  for (let i = 1; i < window.length; i++) {
    if (Date.parse(window[i]!.time) - Date.parse(window[i - 1]!.time) !== dataset.manifest.cadenceSeconds * 1000) {
      throw new Error("Gap in training window");
    }
  }
  return window;
}
export function forecastWindow(dataset: Dataset, window: Measurement[]) {
  return analyzeObservations(importerObservations(window).observations, dataset.manifest.horizonSeconds);
}
export function replay(dataset: Dataset) {
  const rows: { origin: string; target: string; actual: number; linear: number; persistence: number }[] = [];
  let modelVersion = "";
  let skippedGapsOrMissingTargets = 0;
  const byTime = new Map(dataset.measurements.map((m) => [m.time, m]));
  for (const origin of dataset.measurements) {
    if (Date.parse(origin.time) < Date.parse(dataset.manifest.evaluationStart) ||
        Date.parse(origin.time) + dataset.manifest.horizonSeconds * 1000 > Date.parse(dataset.manifest.end)) continue;
    const targetTime = new Date(Date.parse(origin.time) + dataset.manifest.horizonSeconds * 1000).toISOString();
    const target = byTime.get(targetTime);
    let window: Measurement[];
    try { window = windowAt(dataset, origin.time); }
    catch { skippedGapsOrMissingTargets++; continue; }
    if (!target) { skippedGapsOrMissingTargets++; continue; }
    const assessment = forecastWindow(dataset, window);
    if (modelVersion && modelVersion !== assessment.modelVersion) throw new Error("Mixed assessment model versions");
    modelVersion = assessment.modelVersion;
    rows.push({ origin: origin.time, target: targetTime, actual: target.value,
      linear: assessment.forecastValue, persistence: origin.value });
  }
  if (!rows.length) throw new Error("No chronological evaluation pairs");
  const threshold = dataset.manifest.illustrativeThresholdMgL;
  const score = (model: "linear" | "persistence") => ({
    maeMgL: rows.reduce((s, r) => s + Math.abs(r[model] - r.actual), 0) / rows.length,
    rmseMgL: Math.sqrt(rows.reduce((s, r) => s + (r[model] - r.actual) ** 2, 0) / rows.length),
    falseAlerts: rows.filter((r) => r[model] < threshold && r.actual >= threshold).length,
    missedLowOxygen: rows.filter((r) => r[model] >= threshold && r.actual < threshold).length
  });
  return { version: "oxygen-replay-v1", sourceHash: dataset.manifest.sourceHash,
    dataVintage: "retrospective approved archive; not an as-of-origin availability backtest",
    modelVersion, horizonSeconds: dataset.manifest.horizonSeconds,
    windowSize: dataset.manifest.windowSize, evaluationStart: dataset.manifest.evaluationStart,
    evaluatedPairs: rows.length, skippedGapsOrMissingTargets, quality: dataset.quality,
    threshold: { mgL: threshold, status: "illustrative; not a local legal or ecological standard" },
    observedLowOxygenEvents: rows.filter((r) => r.actual < threshold).length,
    linear: score("linear"), persistence: score("persistence"), rows };
}
