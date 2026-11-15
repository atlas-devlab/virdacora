import { canonicalJson, sha256Hex, type Assessment } from "@terravoce/protocol";
import { compileTerraLex, evaluatePolicy } from "@terravoce/terralex";
import type { Dataset } from "./dataset.js";
import { forecastWindow, windowAt } from "./replay.js";

export function prepareCase(dataset: Dataset, policySource: string) {
  // Fixed origin selected by the protocol, before examining forecast errors or alerts.
  const origin = new Date(dataset.manifest.evaluationStart).toISOString();
  const window = windowAt(dataset, origin);
  const assessment = forecastWindow(dataset, window);
  const bundle = compileTerraLex(policySource);
  const decision = evaluatePolicy(bundle, { regionId: assessment.regionId, metric: assessment.metric,
    risk: assessment.risk, confidence: assessment.confidence, observations: assessment.observationCount,
    requestedAction: "DATA_REVIEW", requestedAmount: 10, requestedAsset: "TEST" });
  if (!decision.allowed) throw new Error(`Case policy denied: ${decision.reasons.join(", ")}`);
  const core = {
    version: "environmental-case-v1", mode: "historical-replay/local-governance",
    objective: "Verify delivery of a public-data oxygen review; no physical sampling or restoration claim",
    datasetManifestHash: sha256Hex(canonicalJson(dataset.manifest)),
    sourceHash: dataset.manifest.sourceHash, stationId: dataset.manifest.stationId,
    timeSeriesId: dataset.manifest.timeSeriesId, regionId: assessment.regionId,
    origin, targetTime: new Date(Date.parse(origin) + dataset.manifest.horizonSeconds * 1000).toISOString(),
    sourceRecordIds: window.map((m) => m.id), assessment,
    policyHash: bundle.policyHash, policySourceHash: sha256Hex(policySource),
    action: "DATA_REVIEW", requestedAmount: 10, asset: "TEST", reversible: true,
    challengeSeconds: bundle.policy.challengeSeconds,
    acceptance: { sameStationAndSeries: true, exactTargetTime: true,
      approvedUnqualifiedMeasurement: true, reproducibleErrors: true,
      requireScientificAndCommunityReview: true, ecologicalImprovementClaim: false }
  };
  return { ...core, caseHash: sha256Hex(`environmental-case-v1:${canonicalJson(core)}`) };
}
export type EnvironmentalCase = ReturnType<typeof prepareCase>;
export function deliverResult(dataset: Dataset, spec: EnvironmentalCase) {
  const target = dataset.measurements.find((m) => m.time === spec.targetTime);
  if (!target) throw new Error("Approved exact-time follow-up unavailable; case stays pending");
  const core = { version: "environmental-result-v1", caseHash: spec.caseHash,
    sourceHash: dataset.manifest.sourceHash, stationId: dataset.manifest.stationId,
    timeSeriesId: dataset.manifest.timeSeriesId,
    deliveredAction: "DATA_REVIEW", targetRecord: target, unit: "mg/L", approval: "Approved",
    predictionMgL: spec.assessment.forecastValue, persistenceMgL: spec.assessment.currentValue,
    absoluteErrorMgL: Math.abs(spec.assessment.forecastValue - target.value),
    persistenceAbsoluteErrorMgL: Math.abs(spec.assessment.currentValue - target.value),
    outcome: "public-data-review-delivered", ecologicalImprovementVerified: false };
  return { ...core, resultHash: sha256Hex(`environmental-result-v1:${canonicalJson(core)}`) };
}
export type EnvironmentalResult = ReturnType<typeof deliverResult>;
export function verifyResult(dataset: Dataset, policySource: string, spec: unknown, candidate: unknown) {
  const expectedCase = prepareCase(dataset, policySource);
  if (canonicalJson(spec) !== canonicalJson(expectedCase)) throw new Error("Case commitment mismatch");
  const expected = deliverResult(dataset, expectedCase);
  if (canonicalJson(candidate) !== canonicalJson(expected)) throw new Error("Result not reproduced from committed source");
  return { verified: true, caseHash: expectedCase.caseHash, resultHash: expected.resultHash,
    scope: "reproducibility against pinned USGS snapshot; not independent field review" };
}
export function sameAssessment(left: Assessment, right: Assessment) {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error("Oracle assessment mismatch");
}
