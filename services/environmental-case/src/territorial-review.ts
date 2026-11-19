// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { prepareCase, verifyResult, type EnvironmentalCase } from "./case.js";
import { loadDataset, type Dataset } from "./dataset.js";

export type TerritorialReviewErrorCode =
  | "SOURCE_INTEGRITY_FAILED"
  | "FUNDED_CASE_MISMATCH"
  | "RESULT_COMMITMENT_MISMATCH"
  | "DELIVERY_NOT_REPRODUCED";

export class TerritorialReviewError extends Error {
  constructor(readonly code: TerritorialReviewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerritorialReviewError";
  }
}

export interface TerritorialDeliveryReviewInput {
  datasetFolder: string;
  policySource: string;
  committedCase: EnvironmentalCase;
  fundedCaseHash: string;
  submittedResultHash: string;
  candidate: unknown;
}

export interface TerritorialDeliveryReview {
  verified: true;
  caseHash: string;
  resultHash: string;
  archiveReloaded: true;
  scope: string;
}

/**
 * Reload the archive for this review; never trust an executor's normalized Dataset.
 * The caller must read fundedCaseHash/submittedResultHash from the bound escrow
 * and verify its proposal, terms and reviewer identity before authorizing payment.
 * A matching archive proves reproducibility, not source authenticity, calibrated
 * environmental safety, independent people, or an ecological improvement.
 */
export async function reviewTerritorialDelivery({
  datasetFolder, policySource, committedCase, fundedCaseHash, submittedResultHash, candidate
}: TerritorialDeliveryReviewInput): Promise<TerritorialDeliveryReview> {
  let dataset: Dataset;
  try {
    dataset = await loadDataset(datasetFolder);
  } catch (cause) {
    throw new TerritorialReviewError("SOURCE_INTEGRITY_FAILED",
      "The archive could not be freshly loaded and validated", { cause });
  }

  let expectedCase: EnvironmentalCase;
  try {
    expectedCase = prepareCase(dataset, policySource);
    if (expectedCase.caseHash !== fundedCaseHash || committedCase.caseHash !== fundedCaseHash ||
        canonicalJson(committedCase) !== canonicalJson(expectedCase)) {
      throw new Error("The full case does not match its funded commitment");
    }
  } catch (cause) {
    throw new TerritorialReviewError("FUNDED_CASE_MISMATCH",
      "The reloaded source, policy and complete case must reproduce the funded case", { cause });
  }

  let reviewedCandidate: Record<string, unknown>;
  try {
    // Review one JSON snapshot for both its commitment and its contents.
    const snapshot: unknown = JSON.parse(canonicalJson(candidate));
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("A result object is required");
    }
    reviewedCandidate = snapshot as Record<string, unknown>;
    const { resultHash, ...core } = reviewedCandidate;
    if (typeof resultHash !== "string" || !/^0x[0-9a-f]{64}$/.test(resultHash) ||
        resultHash !== submittedResultHash ||
        sha256Hex(`environmental-result-v1:${canonicalJson(core)}`) !== resultHash) {
      throw new Error("Declared, recomputed and submitted result hashes must agree");
    }
  } catch (cause) {
    throw new TerritorialReviewError("RESULT_COMMITMENT_MISMATCH",
      "The delivered result does not match the submitted result commitment", { cause });
  }

  try {
    const verified = verifyResult(dataset, policySource, expectedCase, reviewedCandidate);
    return { ...verified, verified: true, archiveReloaded: true };
  } catch (cause) {
    throw new TerritorialReviewError("DELIVERY_NOT_REPRODUCED",
      "The complete delivery is not reproduced from the freshly reloaded committed archive", { cause });
  }
}
