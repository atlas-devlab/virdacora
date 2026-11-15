import {
  assessmentSchema,
  canonicalJson,
  sha256Hex,
  type Assessment
} from "@terravoce/protocol";

import type { StoredObservation } from "./observations.js";
import { compareTimestampKeys, timestampMilliseconds } from "./timestamp-order.js";
import { OXYGEN_METRIC, valueForAnalysis } from "./observation-units.js";

export const OXYGEN_ANALYSIS_MODEL_VERSION = "terravoce-linear-risk-v2-oxygen-units";

export interface MetricProfile {
  direction: "above" | "below";
  caution: number;
  critical: number;
  physicalMin?: number;
  physicalMax?: number;
}

const illustrativeProfiles: Record<string, MetricProfile> = {
  "water.oxygen.mg_l": { direction: "below", caution: 5, critical: 2, physicalMin: 0 },
  "air.pm25.ug_m3": { direction: "above", caution: 15, critical: 55, physicalMin: 0 },
  "water.temperature.c": { direction: "above", caution: 24, critical: 32 }
};

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const linearRegression = (x: number[], y: number[]) => {
  const xMean = x.reduce((sum, value) => sum + value, 0) / x.length;
  const yMean = y.reduce((sum, value) => sum + value, 0) / y.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < x.length; index += 1) {
    const xValue = x[index] ?? 0;
    const yValue = y[index] ?? 0;
    numerator += (xValue - xMean) * (yValue - yMean);
    denominator += (xValue - xMean) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = yMean - slope * xMean;
  const residuals = y.map((value, index) => value - (intercept + slope * (x[index] ?? 0)));
  const rmse = Math.sqrt(
    residuals.reduce((sum, value) => sum + value ** 2, 0) / residuals.length
  );
  return { slope, intercept, rmse };
};

const riskFor = (profile: MetricProfile, forecast: number): number => {
  if (profile.direction === "below") {
    return clamp((profile.caution - forecast) / (profile.caution - profile.critical));
  }
  return clamp((forecast - profile.caution) / (profile.critical - profile.caution));
};

export const analyzeEvidence = (
  entries: StoredObservation[],
  forecastHorizonSeconds: number,
  profile?: MetricProfile
) => {
  if (entries.length < 5) throw new Error("at least five observations are required");
  if (!Number.isInteger(forecastHorizonSeconds) || forecastHorizonSeconds <= 0) {
    throw new Error("forecast horizon must be a positive integer");
  }

  const indexed = entries.map(entry => ({ entry,
    milliseconds: timestampMilliseconds(entry.observation.observedAt) }));
  indexed.sort((left, right) => compareTimestampKeys(left.milliseconds, left.entry.observationId,
    right.milliseconds, right.entry.observationId));
  const sorted = indexed.map(({ entry }) => entry);
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  if (first === undefined || latest === undefined) throw new Error("observation series is empty");

  const regionId = first.observation.regionId;
  const metric = first.observation.metric;
  if (
    sorted.some(
      ({ observation }) => observation.regionId !== regionId || observation.metric !== metric
    )
  ) {
    throw new Error("all observations must share region and metric");
  }

  const origin = indexed[0]!.milliseconds;
  const hours = indexed.map(({ milliseconds }) => (milliseconds - origin) / 3_600_000);
  // Keep canonical numbers separate from signed evidence. All numerical paths
  // below, including the latest value and anomaly calculation, use this vector.
  const values = sorted.map(({ observation }) => valueForAnalysis(observation));
  const latestValue = values[values.length - 1]!;
  const regression = linearRegression(hours, values);
  const latestHour = hours[hours.length - 1] ?? 0;
  const horizonHours = forecastHorizonSeconds / 3_600;
  const rawForecastValue = regression.intercept + regression.slope * (latestHour + horizonHours);

  const previous = values.slice(0, -1);
  const previousMean = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  const variance =
    previous.reduce((sum, value) => sum + (value - previousMean) ** 2, 0) /
    Math.max(1, previous.length - 1);
  const deviation = Math.sqrt(variance);
  const zScore = deviation === 0 ? 0 : Math.abs(latestValue - previousMean) / deviation;
  const anomalyScore = clamp(1 - Math.exp(-zScore / 2));

  const valueScale = Math.max(1, Math.abs(previousMean));
  const fit = 1 / (1 + regression.rmse / valueScale);
  const confidence = clamp((sorted.length / 12) * fit);
  const selectedProfile = profile ?? illustrativeProfiles[metric];
  if (selectedProfile === undefined) throw new Error(`no metric profile configured for '${metric}'`);
  const forecastValue = Math.max(
    selectedProfile.physicalMin ?? Number.NEGATIVE_INFINITY,
    Math.min(selectedProfile.physicalMax ?? Number.POSITIVE_INFINITY, rawForecastValue)
  );
  const risk = Math.max(riskFor(selectedProfile, forecastValue), anomalyScore * 0.65);

  const evidenceCore = {
    modelVersion: metric === OXYGEN_METRIC ? OXYGEN_ANALYSIS_MODEL_VERSION : "terravoce-linear-risk-v1",
    regionId,
    metric,
    generatedAt: latest.observation.observedAt,
    observationIds: sorted.map(({ observationId }) => observationId),
    forecastHorizonSeconds,
    currentValue: round(latestValue),
    forecastValue: round(forecastValue),
    slopePerHour: round(regression.slope),
    anomalyScore: round(anomalyScore),
    confidence: round(confidence),
    risk: round(risk)
  };
  const evidenceHash = sha256Hex(`evidence:${canonicalJson(evidenceCore)}`);
  const assessmentId = sha256Hex(`assessment:${canonicalJson(evidenceCore)}`);

  const assessment = assessmentSchema.parse({
    assessmentId,
    regionId,
    metric,
    modelVersion: evidenceCore.modelVersion,
    generatedAt: evidenceCore.generatedAt,
    observationCount: sorted.length,
    currentValue: evidenceCore.currentValue,
    forecastValue: evidenceCore.forecastValue,
    forecastHorizonSeconds,
    slopePerHour: evidenceCore.slopePerHour,
    anomalyScore: evidenceCore.anomalyScore,
    confidence: evidenceCore.confidence,
    risk: evidenceCore.risk,
    evidenceHash
  });
  return { assessment, evidenceCore };
};

export type EvidenceAnalysis = ReturnType<typeof analyzeEvidence>;

// Keep the established numerical API and persisted assessment shape intact.
export const analyzeObservations = (
  entries: StoredObservation[],
  forecastHorizonSeconds: number,
  profile?: MetricProfile
): Assessment => analyzeEvidence(entries, forecastHorizonSeconds, profile).assessment;
