import { canonicalJson, type Assessment } from "@terravoce/protocol";

import { DomainError } from "./errors.js";
import { evidenceReceiptId, evidenceReceiptSchema, type EvidenceReceipt } from "./evidence-receipt.js";

export const assertAssessmentMatches = (stored: Assessment, expected: Assessment): void => {
  if (canonicalJson(stored) !== canonicalJson(expected)) {
    throw new DomainError("assessment identity conflict", 409, "ASSESSMENT_CONFLICT");
  }
};

// Retrieval checks storage consistency, not the authority of bundled keys.
// Independent external trust is still required by the offline verifier.
export const readStoredEvidenceReceipt = (
  input: unknown, receiptId: string, assessment: Assessment | undefined
): EvidenceReceipt => {
  try {
    const receipt = evidenceReceiptSchema.parse(input);
    if (assessment === undefined || evidenceReceiptId(receipt) !== receiptId ||
        canonicalJson(receipt.assessment) !== canonicalJson(assessment)) {
      throw new Error("inconsistent packet");
    }
    return receipt;
  } catch {
    // Stored schema/JSON errors must not become public 400 validation details.
    throw new Error("stored evidence receipt is inconsistent");
  }
};
