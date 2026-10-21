import { canonicalJson } from "@terravoce/protocol";
import type {
  Assessment,
  SensorRegistration,
  SignedObservation
} from "@terravoce/protocol";
import { Pool } from "pg";

import { DomainError } from "./errors.js";
import { evidenceReceiptId, evidenceReceiptSchema, type EvidenceReceipt } from "./evidence-receipt.js";
import { assertAssessmentMatches, readStoredEvidenceReceipt } from "./receipt-storage.js";
import { makeEvidenceReceiptPage, validateReceiptPage, type EvidenceReceiptPage } from "./receipt-catalog.js";
import { timestampMilliseconds } from "./timestamp-order.js";
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
    this.pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000, query_timeout: 12_000 });
    // pg already removes a failed idle client. Handle its background event so
    // the process survives; later operations obtain a new connection normally.
    // Never log the original error/client or retry a write of uncertain outcome.
    this.pool.on("error", () => {
      process.emitWarning("PostgreSQL idle connection was lost; subsequent operations will reconnect", {
        code: "POSTGRES_IDLE_CONNECTION_LOST"
      });
    });
  }

  public async checkReadiness(): Promise<void> {
    // Resolve every column used by this store without reading table contents.
    // Separate privilege calls are necessary: a comma-separated list means ANY.
    // This read-only probe cannot guarantee that a subsequent write will succeed.
    const probe = {
      text: `SELECT current_setting('transaction_read_only') = 'off'
          AND has_table_privilege('sensors', 'INSERT')
          AND has_table_privilege('observations', 'INSERT')
          AND has_table_privilege('assessments', 'INSERT')
          AND has_table_privilege('assessment_evidence', 'INSERT')
          AND (SELECT ROW(sensor_id, region_id, public_key_der_base64, label, active)
                 FROM sensors LIMIT 0) IS NULL
          AND (SELECT ROW(observation_id, sensor_id, region_id, metric, observed_at,
                          sequence, body, observed_at_ms)
                 FROM observations LIMIT 0) IS NULL
          AND (SELECT ROW(assessment_id, region_id, metric, generated_at, body,
                          generated_at_ms)
                 FROM assessments LIMIT 0) IS NULL
          AND (SELECT ROW(receipt_id, assessment_id, body)
                 FROM assessment_evidence LIMIT 0) IS NULL AS ready`,
      query_timeout: 2_000
    };
    const result = await this.pool.query<{ ready: boolean }>(probe);
    if (result.rows[0]?.ready !== true) {
      throw new Error("observation store is not ready");
    }
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
    const observedAt = timestampMilliseconds(snapshot.observation.observedAt);
    try {
      await this.pool.query(
        `INSERT INTO observations
           (observation_id, sensor_id, region_id, metric, observed_at, sequence, body, observed_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          snapshot.observationId,
          snapshot.observation.sensorId,
          snapshot.observation.regionId,
          snapshot.observation.metric,
          snapshot.observation.observedAt,
          snapshot.observation.sequence,
          snapshot.observation,
          observedAt
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
        ORDER BY observed_at_ms DESC, observation_id COLLATE "C" DESC
        LIMIT $3`,
      [regionId, metric, limit]
    );
    return result.rows.reverse();
  }

  public async saveAssessment(assessment: Assessment): Promise<void> {
    const snapshot = { ...assessment };
    const generatedAt = timestampMilliseconds(snapshot.generatedAt);
    await this.pool.query(
      `INSERT INTO assessments
         (assessment_id, region_id, metric, generated_at, body, generated_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (assessment_id) DO NOTHING`,
      [
        snapshot.assessmentId,
        snapshot.regionId,
        snapshot.metric,
        snapshot.generatedAt,
        snapshot,
        generatedAt
      ]
    );
  }

  public async latestAssessment(
    regionId: string,
    metric: string,
    modelVersion?: string
  ): Promise<Assessment | undefined> {
    const result = await this.pool.query<{ body: Assessment }>(
      `SELECT body FROM assessments
        WHERE region_id = $1 AND metric = $2${modelVersion === undefined ? "" : " AND body->>'modelVersion' = $3"}
        ORDER BY generated_at_ms DESC, assessment_id COLLATE "C" DESC
        LIMIT 1`,
      modelVersion === undefined ? [regionId, metric] : [regionId, metric, modelVersion]
    );
    return result.rows[0]?.body;
  }

  public async saveAssessmentWithReceipt(input: EvidenceReceipt): Promise<`0x${string}`> {
    // Snapshot before the first pool wait; never retain a caller-owned packet.
    const receipt = evidenceReceiptSchema.parse(input);
    const assessment = receipt.assessment;
    const generatedAt = timestampMilliseconds(assessment.generatedAt);
    const id = evidenceReceiptId(receipt);
    const expectedPacket = canonicalJson(receipt);
    const client = await this.pool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        `INSERT INTO assessments
           (assessment_id, region_id, metric, generated_at, body, generated_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (assessment_id) DO NOTHING`,
        [assessment.assessmentId, assessment.regionId, assessment.metric,
          assessment.generatedAt, assessment, generatedAt]
      );
      // The app never updates an existing assessment. ON CONFLICT waits for a
      // competing first insert; this next READ COMMITTED statement sees it.
      // No FOR UPDATE: reading immutable results must not require UPDATE rights.
      const existing = await client.query<{ body: Assessment }>(
        "SELECT body FROM assessments WHERE assessment_id = $1", [assessment.assessmentId]);
      if (existing.rows[0] === undefined) throw new Error("assessment insert returned no row");
      assertAssessmentMatches(existing.rows[0].body, assessment);
      await client.query(
        `INSERT INTO assessment_evidence (receipt_id, assessment_id, body)
         VALUES ($1, $2, $3) ON CONFLICT (receipt_id) DO NOTHING`,
        [id, assessment.assessmentId, receipt]
      );
      const saved = await client.query<{ assessmentId: string; body: unknown }>(
        `SELECT assessment_id AS "assessmentId", body FROM assessment_evidence
         WHERE receipt_id = $1`, [id]);
      if (saved.rows[0]?.assessmentId !== assessment.assessmentId ||
          canonicalJson(saved.rows[0]?.body) !== expectedPacket) {
        throw new Error("stored evidence receipt is inconsistent");
      }
      await client.query("COMMIT");
      return id;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = new Error("transaction cleanup failed"); }
      // A lost COMMIT response can still mean the server committed. Do not retry
      // automatically or claim rollback is proven for an uncertain outcome.
      throw error;
    } finally {
      client.release(discard);
    }
  }

  public async getEvidenceReceipt(id: string): Promise<EvidenceReceipt | undefined> {
    // One statement observes a consistent receipt/assessment pair. No live key
    // registry lookup, reanalysis, repair or reconstruction occurs on retrieval.
    const result = await this.pool.query<{ assessmentId: string; body: unknown; assessment: Assessment | null }>(
      `SELECT e.assessment_id AS "assessmentId", e.body, a.body AS assessment
       FROM assessment_evidence e LEFT JOIN assessments a ON a.assessment_id = e.assessment_id
       WHERE e.receipt_id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const receipt = readStoredEvidenceReceipt(row.body, id, row.assessment ?? undefined);
    if (receipt.assessment.assessmentId !== row.assessmentId) {
      throw new Error("stored evidence receipt is inconsistent");
    }
    return receipt;
  }

  public async listEvidenceReceipts(assessmentId: string, limit: number, after?: string): Promise<EvidenceReceiptPage> {
    validateReceiptPage(assessmentId, limit, after);
    // Empty string is below every valid fixed-length hex ID, including zero.
    // Both the predicate and ordering match the composite C-collation index.
    const result = await this.pool.query<{ receiptId: string }>(
      `SELECT receipt_id AS "receiptId" FROM assessment_evidence
       WHERE assessment_id = $1 AND receipt_id COLLATE "C" > $2
       ORDER BY receipt_id COLLATE "C" ASC LIMIT $3`,
      [assessmentId, after ?? "", limit + 1]);
    return makeEvidenceReceiptPage(assessmentId, result.rows.map(row => row.receiptId), limit, after);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

