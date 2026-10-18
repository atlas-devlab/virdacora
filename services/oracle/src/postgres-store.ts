import type {
  Assessment,
  SensorRegistration,
  SignedObservation
} from "@terravoce/protocol";
import { Pool } from "pg";

import { DomainError } from "./errors.js";
import {
  validateObservationLimit,
  type ObservationStore,
  type StoredObservation,
  type StoredSensor
} from "./store.js";

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

export class PostgresObservationStore implements ObservationStore {
  private readonly pool: Pool;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  public async registerSensor(sensor: SensorRegistration): Promise<StoredSensor> {
    try {
      const result = await this.pool.query<StoredSensor>(
        `INSERT INTO sensors (sensor_id, region_id, public_key_der_base64, label)
         VALUES ($1, $2, $3, $4)
         RETURNING sensor_id AS "sensorId", region_id AS "regionId",
                   public_key_der_base64 AS "publicKeyDerBase64", label, active`,
        [sensor.sensorId, sensor.regionId, sensor.publicKeyDerBase64, sensor.label]
      );
      const stored = result.rows[0];
      if (stored === undefined) throw new Error("sensor insert returned no row");
      return stored;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError("sensor already exists", 409, "SENSOR_EXISTS");
      }
      throw error;
    }
  }

  public async getSensor(sensorId: string): Promise<StoredSensor | undefined> {
    const result = await this.pool.query<StoredSensor>(
      `SELECT sensor_id AS "sensorId", region_id AS "regionId",
              public_key_der_base64 AS "publicKeyDerBase64", label, active
         FROM sensors WHERE sensor_id = $1`,
      [sensorId]
    );
    return result.rows[0];
  }

  public async addObservation(entry: StoredObservation): Promise<void> {
    const snapshot = { observationId: entry.observationId, observation: { ...entry.observation } };
    try {
      await this.pool.query(
        `INSERT INTO observations
           (observation_id, sensor_id, region_id, metric, observed_at, sequence, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          snapshot.observationId,
          snapshot.observation.sensorId,
          snapshot.observation.regionId,
          snapshot.observation.metric,
          snapshot.observation.observedAt,
          snapshot.observation.sequence,
          snapshot.observation
        ]
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError("observation replay detected", 409, "OBSERVATION_REPLAY");
      }
      throw error;
    }
  }

  public async listObservations(
    regionId: string,
    metric: string,
    limit: number
  ): Promise<StoredObservation[]> {
    validateObservationLimit(limit);
    const result = await this.pool.query<{
      observationId: `0x${string}`;
      observation: SignedObservation;
    }>(
      `SELECT observation_id AS "observationId", body AS observation
         FROM observations
        WHERE region_id = $1 AND metric = $2
        ORDER BY observed_at DESC, observation_id DESC
        LIMIT $3`,
      [regionId, metric, limit]
    );
    return result.rows.reverse();
  }

  public async saveAssessment(assessment: Assessment): Promise<void> {
    const snapshot = { ...assessment };
    await this.pool.query(
      `INSERT INTO assessments
         (assessment_id, region_id, metric, generated_at, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (assessment_id) DO NOTHING`,
      [
        snapshot.assessmentId,
        snapshot.regionId,
        snapshot.metric,
        snapshot.generatedAt,
        snapshot
      ]
    );
  }

  public async latestAssessment(
    regionId: string,
    metric: string
  ): Promise<Assessment | undefined> {
    const result = await this.pool.query<{ body: Assessment }>(
      `SELECT body FROM assessments
        WHERE region_id = $1 AND metric = $2
        ORDER BY generated_at DESC, assessment_id DESC
        LIMIT 1`,
      [regionId, metric]
    );
    return result.rows[0]?.body;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

