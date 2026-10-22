import { DomainError } from "./errors.js";

export interface EvidenceReceiptPage {
  assessmentId: string;
  receiptIds: string[];
  nextAfter?: string;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);

export const validateReceiptPage = (assessmentId: string, limit: number, after?: string): void => {
  if (!validId(assessmentId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (after !== undefined && !validId(after))) {
    throw new DomainError("invalid receipt page request", 400, "INVALID_RECEIPT_PAGE");
  }
};

// First ID strictly greater than a bound; also the insertion point for a new
// immutable receipt ID. An absent bound starts at the beginning, including zero.
export const receiptPageStart = (ids: readonly string[], after?: string): number => {
  if (after === undefined) return 0;
  let left = 0;
  let right = ids.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (ids[middle]! <= after) left = middle + 1;
    else right = middle;
  }
  return left;
};

export const makeEvidenceReceiptPage = (
  assessmentId: string, ids: readonly string[], limit: number, after?: string
): EvidenceReceiptPage => {
  if (ids.length > limit + 1 || ids.some((id, index) => !validId(id) ||
      (after !== undefined && id <= after) || (index > 0 && id <= ids[index - 1]!))) {
    throw new Error("receipt catalog is inconsistent");
  }
  const receiptIds = ids.slice(0, limit);
  return { assessmentId, receiptIds,
    ...(ids.length > limit ? { nextAfter: receiptIds.at(-1)! } : {}) };
};
