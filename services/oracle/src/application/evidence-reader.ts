import type { EvidenceReadUseCases } from "./use-cases.js";

// A TypeScript Pick alone leaves all original methods on the runtime object.
// Construct an actual two-operation capability before handing it to a reader.
// This is not caller authentication; the surrounding adapter still owns it.
export const createEvidenceReader = (source: EvidenceReadUseCases): Readonly<EvidenceReadUseCases> => {
  const get = source.getEvidenceReceipt.bind(source);
  const list = source.listEvidenceReceipts.bind(source);
  return Object.freeze({
    getEvidenceReceipt: (receiptId: string) => get(receiptId),
    listEvidenceReceipts: (assessmentId: string, limit: number, after?: string) => list(assessmentId, limit, after)
  });
};
