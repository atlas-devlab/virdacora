import type { Assessment, SensorRegistration } from "@terravoce/protocol";

import { DomainError } from "../../domain/errors.js";
import type { EvidenceReceipt } from "../../domain/evidence-receipt.js";
import type { SensorRegistry, StoredObservation, StoredSensor } from "../../domain/observations.js";
import type { EvidenceReceiptPage } from "../../domain/receipt-catalog.js";

export interface SensorRegistrar {
  registerSensor(sensor: SensorRegistration): Promise<StoredSensor>;
}

export interface ObservationWriter {
  addObservation(entry: StoredObservation): Promise<void>;
}

export interface ObservationReader {
  listObservations(regionId: string, metric: string, limit: number): Promise<StoredObservation[]>;
}

export interface AssessmentWriter {
  saveAssessment(assessment: Assessment): Promise<void>;
}

export interface EvidenceReceiptWriter {
  // The assessment and its exact receipt are one persistence operation.
  saveAssessmentWithReceipt(receipt: EvidenceReceipt): Promise<`0x${string}`>;
}

export interface EvidenceReceiptReader {
  getEvidenceReceipt(receiptId: string): Promise<EvidenceReceipt | undefined>;
  listEvidenceReceipts(assessmentId: string, limit: number, after?: string): Promise<EvidenceReceiptPage>;
}

export interface AssessmentReader {
  latestAssessment(regionId: string, metric: string, modelVersion?: string): Promise<Assessment | undefined>;
}

export interface StoreLifecycle {
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

// Retain the established aggregate for existing application callers and stores.
export interface ObservationStore extends SensorRegistry, SensorRegistrar, ObservationWriter,
  ObservationReader, AssessmentWriter, EvidenceReceiptWriter, EvidenceReceiptReader,
  AssessmentReader, StoreLifecycle {}

export const validateObservationLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new DomainError("observation limit must be a positive safe integer", 400, "INVALID_LIMIT");
  }
};
