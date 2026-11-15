import { describe, expect, it, vi } from "vitest";

import { createEvidenceReader } from "./evidence-reader.js";
import type { EvidenceReadUseCases } from "./use-cases.js";

describe("runtime evidence read capability", () => {
  it("exports only two frozen read operations even when its source also has privileged methods", async () => {
    const getEvidenceReceipt = vi.fn<EvidenceReadUseCases["getEvidenceReceipt"]>();
    const listEvidenceReceipts = vi.fn<EvidenceReadUseCases["listEvidenceReceipts"]>();
    const privileged = vi.fn();
    const source = { getEvidenceReceipt, listEvidenceReceipts, runAssessment: privileged,
      registerSensor: privileged, ingestObservation: privileged, close: privileged };
    const reader = createEvidenceReader(source);
    expect(Object.getOwnPropertyNames(reader).sort()).toEqual(["getEvidenceReceipt", "listEvidenceReceipts"]);
    expect(Object.isFrozen(reader)).toBe(true);
    expect(Reflect.set(reader, "runAssessment", privileged)).toBe(false);
    const before = { assessmentId: "known", receiptIds: ["receipt"] };
    listEvidenceReceipts.mockResolvedValue(before);
    expect(await reader.listEvidenceReceipts("known", 1, "cursor")).toBe(before);
    expect(listEvidenceReceipts).toHaveBeenCalledWith("known", 1, "cursor");
    expect(privileged).not.toHaveBeenCalled();
  });

  it("captures only the read methods, preserving receiver binding and propagating failures without retries", async () => {
    const failure = new Error("synthetic read failure");
    const getEvidenceReceipt = vi.fn<EvidenceReadUseCases["getEvidenceReceipt"]>().mockRejectedValue(failure);
    const source = { marker: "reader", getEvidenceReceipt,
      async listEvidenceReceipts(assessmentId: string) { return { assessmentId, receiptIds: [this.marker] }; } };
    const reader = createEvidenceReader(source);
    source.getEvidenceReceipt = vi.fn();
    await expect(reader.getEvidenceReceipt("receipt")).rejects.toBe(failure);
    expect(getEvidenceReceipt).toHaveBeenCalledExactlyOnceWith("receipt");
    expect(await reader.listEvidenceReceipts("known", 1)).toEqual({ assessmentId: "known", receiptIds: ["reader"] });
  });
});
