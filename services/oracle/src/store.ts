import type {
  Assessment,
  SensorRegistration,
  SignedObservation
} from "@terravoce/protocol";

import { DomainError } from "./errors.js";
import { evidenceReceiptId, evidenceReceiptSchema, type EvidenceReceipt } from "./evidence-receipt.js";
import { assertAssessmentMatches, readStoredEvidenceReceipt } from "./receipt-storage.js";
import { compareTimestampKeys, timestampMilliseconds } from "./timestamp-order.js";

export interface StoredSensor extends SensorRegistration {
  active: boolean;
}

export interface StoredObservation {
  observationId: `0x${string}`;
  observation: SignedObservation;
}

export interface ObservationStore {
  checkReadiness(): Promise<void>;
  registerSensor(sensor: SensorRegistration): Promise<StoredSensor>;
  getSensor(sensorId: string): Promise<StoredSensor | undefined>;
  addObservation(entry: StoredObservation): Promise<void>;
  listObservations(
    regionId: string,
    metric: string,
    limit: number
  ): Promise<StoredObservation[]>;
  saveAssessment(assessment: Assessment): Promise<void>;
  saveAssessmentWithReceipt(receipt: EvidenceReceipt): Promise<`0x${string}`>;
  getEvidenceReceipt(receiptId: string): Promise<EvidenceReceipt | undefined>;
  latestAssessment(regionId: string, metric: string, modelVersion?: string): Promise<Assessment | undefined>;
  close(): Promise<void>;
}

export const validateObservationLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new DomainError("observation limit must be a positive safe integer", 400, "INVALID_LIMIT");
  }
};

interface IndexedObservation {
  entry: StoredObservation;
  observedAt: number;
}

interface IndexedAssessment {
  assessment: Assessment;
  generatedAt: number;
}

const seriesKey = (regionId: string, metric: string): string => JSON.stringify([regionId, metric]);
const assessmentVersionKey = (regionId: string, metric: string, modelVersion: string): string =>
  JSON.stringify([regionId, metric, modelVersion]);

const copyObservation = (entry: StoredObservation): StoredObservation => ({
  observationId: entry.observationId,
  observation: { ...entry.observation }
});

const compareObservations = (left: IndexedObservation, right: IndexedObservation): number =>
  compareTimestampKeys(left.observedAt, left.entry.observationId,
    right.observedAt, right.entry.observationId);

export class MemoryObservationStore implements ObservationStore {
  private readonly sensors = new Map<string, StoredSensor>();
  private readonly observationIds = new Set<`0x${string}`>();
  private readonly sequenceKeys = new Set<string>();
  private readonly observationSeries = new Map<string, IndexedObservation[]>();
  private readonly assessmentRecords = new Map<string, Assessment>();
  private readonly evidenceReceipts = new Map<string, EvidenceReceipt>();
  private readonly assessments = new Map<string, IndexedAssessment>();
  private readonly assessmentsByVersion = new Map<string, IndexedAssessment>();

  public async checkReadiness(): Promise<void> {}

  public async registerSensor(sensor: SensorRegistration): Promise<StoredSensor> {
    if (this.sensors.has(sensor.sensorId)) {
      throw new DomainError("sensor already exists", 409, "SENSOR_EXISTS");
    }
    const stored = { ...sensor, active: true };
    this.sensors.set(sensor.sensorId, stored);
    return { ...stored };
  }

  public async getSensor(sensorId: string): Promise<StoredSensor | undefined> {
    const sensor = this.sensors.get(sensorId);
    return sensor === undefined ? undefined : { ...sensor };
  }

  public async addObservation(entry: StoredObservation): Promise<void> {
    const observedAt = timestampMilliseconds(entry.observation.observedAt);
    const sequenceKey = JSON.stringify([entry.observation.sensorId, entry.observation.sequence]);
    if (this.observationIds.has(entry.observationId) || this.sequenceKeys.has(sequenceKey)) {
      throw new DomainError("observation replay detected", 409, "OBSERVATION_REPLAY");
    }

    const snapshot = copyObservation(entry);
    const indexed = { entry: snapshot, observedAt };
    const key = seriesKey(snapshot.observation.regionId, snapshot.observation.metric);
    const series = this.observationSeries.get(key) ?? [];
    const latest = series[series.length - 1];
    if (latest === undefined || compareObservations(latest, indexed) <= 0) {
      series.push(indexed);
    } else {
      let left = 0;
      let right = series.length;
      while (left < right) {
        const middle = Math.floor((left + right) / 2);
        const current = series[middle];
        if (current !== undefined && compareObservations(current, indexed) <= 0) {
          left = middle + 1;
        } else {
          right = middle;
        }
      }
      series.splice(left, 0, indexed);
    }
    this.observationSeries.set(key, series);
    this.observationIds.add(snapshot.observationId);
    this.sequenceKeys.add(sequenceKey);
  }

  public async listObservations(
    regionId: string,
    metric: string,
    limit: number
  ): Promise<StoredObservation[]> {
    validateObservationLimit(limit);
    const series = this.observationSeries.get(seriesKey(regionId, metric));
    return series === undefined ? [] : series.slice(-limit).map(({ entry }) => copyObservation(entry));
  }

  public async saveAssessment(assessment: Assessment): Promise<void> {
    const generatedAt = timestampMilliseconds(assessment.generatedAt);
    if (this.assessmentRecords.has(assessment.assessmentId)) return;
    this.commitAssessment({ ...assessment }, generatedAt);
  }

  private commitAssessment(assessment: Assessment, generatedAt: number): void {
    const key = seriesKey(assessment.regionId, assessment.metric);
    const versionKey = assessmentVersionKey(assessment.regionId, assessment.metric, assessment.modelVersion);
    const indexed = { assessment: { ...assessment }, generatedAt };
    // Keep the existing all-model index and an exact-version view. An older
    // model's larger ID or later origin time must not hide a requested model.
    for (const [index, indexKey] of [
      [this.assessments, key], [this.assessmentsByVersion, versionKey]
    ] as const) {
      const latest = index.get(indexKey);
      if (latest === undefined || compareTimestampKeys(generatedAt, assessment.assessmentId,
        latest.generatedAt, latest.assessment.assessmentId) > 0) {
        index.set(indexKey, indexed);
      }
    }
    this.assessmentRecords.set(assessment.assessmentId, indexed.assessment);
  }

  public async saveAssessmentWithReceipt(input: EvidenceReceipt): Promise<`0x${string}`> {
    // Complete validation and independent copies before publishing either map.
    // No await/callback can observe a half-written pair in memory mode.
    const receipt = evidenceReceiptSchema.parse(input);
    const generatedAt = timestampMilliseconds(receipt.assessment.generatedAt);
    const id = evidenceReceiptId(receipt);
    const stored = this.assessmentRecords.get(receipt.assessment.assessmentId);
    if (stored !== undefined) assertAssessmentMatches(stored, receipt.assessment);
    const previous = this.evidenceReceipts.get(id);
    if (previous !== undefined) {
      readStoredEvidenceReceipt(previous, id, stored);
      return id;
    }
    if (stored === undefined) this.commitAssessment({ ...receipt.assessment }, generatedAt);
    this.evidenceReceipts.set(id, receipt);
    return id;
  }

  public async getEvidenceReceipt(id: string): Promise<EvidenceReceipt | undefined> {
    const receipt = this.evidenceReceipts.get(id);
    return receipt === undefined ? undefined : readStoredEvidenceReceipt(receipt, id,
      this.assessmentRecords.get(receipt.assessment.assessmentId));
  }

  public async latestAssessment(
    regionId: string,
    metric: string,
    modelVersion?: string
  ): Promise<Assessment | undefined> {
    const assessment = modelVersion === undefined
      ? this.assessments.get(seriesKey(regionId, metric))
      : this.assessmentsByVersion.get(assessmentVersionKey(regionId, metric, modelVersion));
    return assessment === undefined ? undefined : { ...assessment.assessment };
  }

  public async close(): Promise<void> {}
}

