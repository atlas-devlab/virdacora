// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@terravoce/protocol";
import { deliverResult, prepareCase } from "./case.js";
import { loadDataset } from "./dataset.js";
import { replay } from "./replay.js";
import { reviewTerritorialDelivery, TerritorialReviewError } from "./territorial-review.js";

const archive = new URL("../../../docs/evidence/territorial-job/", import.meta.url);
const datasetFolder = fileURLToPath(new URL("../../../docs/datasets/usgs-willamette/", import.meta.url));
const policy = new URL("../../../policies/usgs-data-review-v1.terra", import.meta.url);

// Commitments from the local demonstration archived in Git at 8e0d0d6.
// A delivered candidate does not supply its own trusted result hash.
const referenceRevision = "8e0d0d68f8dbaa58eb0d89ce0b7cdcb5790ae94e";
const fundedCaseHash = "0x3cee978fda3fd8e84c92e2b0a94dec7bdb5fe0c64560c4b13e8e3babd4414f84";
const deliveries = [
  { id: "positive", submittedResultHash: "0x68aba721f7c3c0933aa20c8a1849d64189dc41fd419d40f434cb19444fee90bc" },
  { id: "altered_delivery", submittedResultHash: "0xdd036ba8669d2eaffa8dcfda59326a8ba1308dc0de044ccad5c36f8d0537e149" },
  { id: "insufficient_delivery", submittedResultHash: "0x850f2342846007e18718f97c8ea726f3671d932367bb8f44bb7ebe77a34266f5" },
] as const;

async function readArchiveJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, archive), "utf8")) as unknown;
}

export async function reviewArchivedTerritorialCase() {
  const [dataset, policySource, archivedCase] = await Promise.all([
    loadDataset(datasetFolder), readFile(policy, "utf8"), readArchiveJson("case.json"),
  ]);
  const committedCase = prepareCase(dataset, policySource);
  if (committedCase.caseHash !== fundedCaseHash || canonicalJson(archivedCase) !== canonicalJson(committedCase)) {
    throw new Error("The archived case does not match the pinned case commitment.");
  }

  const scenarios = await Promise.all(deliveries.map(async ({ id, submittedResultHash }) => {
    const candidate = await readArchiveJson(`${id}/candidate.json`);
    try {
      await reviewTerritorialDelivery({
        datasetFolder, policySource, committedCase, fundedCaseHash, submittedResultHash, candidate,
      });
    } catch (error) {
      if (id !== "positive" && error instanceof TerritorialReviewError && error.code === "DELIVERY_NOT_REPRODUCED") {
        return { id, outcome: "rejected", reason: error.code } as const;
      }
      throw error;
    }
    if (id !== "positive") throw new Error(`An invalid archived delivery was accepted: ${id}`);
    return { id, outcome: "verified", reason: null } as const;
  }));

  const { manifest, quality } = dataset;
  const result = deliverResult(dataset, committedCase);
  const evaluation = replay(dataset);

  return {
    version: "territorial-archive-review-v1",
    scope: "offline delivery review against repository-pinned commitments from a local simulation",
    source: {
      stationId: manifest.stationId, timeSeriesId: manifest.timeSeriesId,
      parameterCode: manifest.parameterCode, sourceUrl: manifest.sourceUrl, stationUrl: manifest.stationUrl,
      retrievedAt: manifest.retrievedAt, start: manifest.start, end: manifest.end,
      sourceHash: manifest.sourceHash, stationHash: manifest.stationHash, license: manifest.license,
      unit: quality.unit, approvalFilter: "Approved with no qualifiers", referenceRevision,
    },
    case: {
      caseHash: result.caseHash, resultHash: result.resultHash, policyHash: committedCase.policyHash,
      modelVersion: committedCase.assessment.modelVersion,
      originUtc: committedCase.origin, targetUtc: result.targetRecord.time, targetRecordId: result.targetRecord.id,
      observedMgL: result.targetRecord.value, linearMgL: result.predictionMgL, persistenceMgL: result.persistenceMgL,
      linearErrorMgL: result.absoluteErrorMgL, persistenceErrorMgL: result.persistenceAbsoluteErrorMgL,
    },
    evaluation: {
      startUtc: evaluation.evaluationStart, horizonSeconds: evaluation.horizonSeconds, windowSize: evaluation.windowSize,
      acceptedObservations: quality.accepted, sourceObservations: quality.total,
      missingIntervals: quality.missingIntervals, excludedObservations: quality.excluded.length,
      skippedPairs: evaluation.skippedGapsOrMissingTargets, observedLowOxygenEvents: evaluation.observedLowOxygenEvents,
      illustrativeThresholdMgL: evaluation.threshold.mgL, assessedPairs: evaluation.evaluatedPairs,
      dataVintage: evaluation.dataVintage, thresholdStatus: evaluation.threshold.status,
      linear: evaluation.linear, persistence: evaluation.persistence, rows: evaluation.rows,
    },
    scenarios,
  } as const;
}

export type ArchivedTerritorialReview = Awaited<ReturnType<typeof reviewArchivedTerritorialCase>>;
