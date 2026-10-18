import type {
  Assessment,
  SensorRegistration,
  SignedObservation
} from "@terravoce/protocol";

import { DomainError } from "./errors.js";
import { compareTimestampKeys, timestampMilliseconds } from "./timestamp-order.js";

export interface StoredSensor extends SensorRegistration {
  active: boolean;
}

export interface StoredObservation {
  observationId: `0x${string}`;
  observation: SignedObservation;
}

export interface ObservationStore {
  registerSensor(sensor: SensorRegistration): Promise<StoredSensor>;
  getSensor(sensorId: string): Promise<StoredSensor | undefined>;
  addObservation(entry: StoredObservation): Promise<void>;
  listObservations(
    regionId: string,
    metric: string,
    limit: number
  ): Promise<StoredObservation[]>;
  saveAssessment(assessment: Assessment): Promise<void>;
  latestAssessment(regionId: string, metric: string): Promise<Assessment | undefined>;
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
  private readonly assessmentIds = new Set<string>();
  private readonly assessments = new Map<string, IndexedAssessment>();

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
    if (this.assessmentIds.has(assessment.assessmentId)) return;
    const key = seriesKey(assessment.regionId, assessment.metric);
    const latest = this.assessments.get(key);
    if (latest === undefined || compareTimestampKeys(generatedAt, assessment.assessmentId,
      latest.generatedAt, latest.assessment.assessmentId) > 0) {
      this.assessments.set(key, { assessment: { ...assessment }, generatedAt });
    }
    this.assessmentIds.add(assessment.assessmentId);
  }

  public async latestAssessment(
    regionId: string,
    metric: string
  ): Promise<Assessment | undefined> {
    const assessment = this.assessments.get(seriesKey(regionId, metric));
    return assessment === undefined ? undefined : { ...assessment.assessment };
  }

  public async close(): Promise<void> {}
}

