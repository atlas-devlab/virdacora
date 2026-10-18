import { generateKeyPairSync } from "node:crypto";

import type { Assessment, SensorRegistration } from "@terravoce/protocol";
import { observationId, signObservation, verifyObservation } from "@terravoce/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresFixture, REQUIRE_DATABASE_ENV, TEST_DATABASE_ENV,
  validateTestDatabaseUrl, type PostgresFixture
} from "../test/postgres-fixture.js";
import { buildApp } from "./app.js";
import { analyzeObservations } from "./analysis.js";
import { MemoryObservationStore, type StoredObservation } from "./store.js";

const configuredUrl = process.env[TEST_DATABASE_ENV];
const databaseUrl = configuredUrl !== undefined || process.env[REQUIRE_DATABASE_ENV] === "1"
  ? validateTestDatabaseUrl(configuredUrl) : undefined;

const id = (value: number): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const registration: SensorRegistration = {
  sensorId: "sensor-01", regionId: "region-01", publicKeyDerBase64: "YQ==",
  label: "Synthetic water-quality sensor"
};
const entry = (value: number, overrides: Partial<StoredObservation["observation"]> = {}): StoredObservation => ({
  observationId: id(value),
  observation: {
    sensorId: "sensor-01", regionId: "region-01", metric: "water.oxygen.mg_l",
    value, unit: "mg/L", observedAt: new Date(Date.UTC(2026, 9, 1, 0, value)).toISOString(),
    sequence: value, signature: "YQ==", ...overrides
  }
});
const assessment = (value: number, overrides: Partial<Assessment> = {}): Assessment => ({
  assessmentId: id(value), regionId: "region-01", metric: "water.oxygen.mg_l",
  generatedAt: new Date(Date.UTC(2026, 9, 1, 0, value)).toISOString(),
  modelVersion: "synthetic-postgres-test", observationCount: 5, currentValue: 5,
  forecastValue: 5, forecastHorizonSeconds: 3_600, slopePerHour: 0,
  anomalyScore: 0, confidence: 0, risk: 0, evidenceHash: id(value + 10_000), ...overrides
});
const reference = (rows: StoredObservation[], regionId: string, metric: string, limit: number) =>
  rows.filter(({ observation }) => observation.regionId === regionId && observation.metric === metric)
    .sort((left, right) => {
      const time = Date.parse(left.observation.observedAt) - Date.parse(right.observation.observedAt);
      return time === 0
        ? left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0
        : time;
    }).slice(-limit);
const policySource = `
policy "po-water-oxygen" version 1 {
  region "IT-PO-DELTA";
  metric "water.oxygen.mg_l";
  when risk >= 0.72 and confidence >= 0.80 and observations >= 5;
  allow "WATER_AERATION" reversible;
  budget 250 USDC per 7 days;
  challenge 24 hours;
  require community challenge;
  require guardian pause;
  forbid irreversible;
}`;

// Generic pnpm test visibly skips this block without the dedicated URL.
// scripts/run-postgres-tests.ts requires the URL and sets REQUIRE_DATABASE_ENV.
describe.skipIf(databaseUrl === undefined)("real PostgreSQL observation storage", () => {
  let fixture: PostgresFixture;
  let store: ReturnType<PostgresFixture["createStore"]>;

  beforeEach(async () => {
    fixture = await createPostgresFixture(databaseUrl!);
    store = fixture.createStore();
  }, 20_000);
  afterEach(async () => { await fixture?.close(); }, 20_000);

  it("applies the actual migration twice in a private schema with no public fallback", async () => {
    await fixture.inspector.query(fixture.migration);
    const tables = await fixture.inspector.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename",
      [fixture.schema]);
    expect(tables.rows.map(({ tablename }) => tablename)).toEqual(["assessments", "observations", "sensors"]);
    const scope = await fixture.inspector.query<{ database: string; schema: string; path: string; version: string }>(
      `SELECT current_database() AS database, current_schema() AS schema,
              current_setting('search_path') AS path, current_setting('server_version') AS version`);
    expect(scope.rows[0]?.database).toMatch(/^virdacora_test(?:_[a-z0-9]+)?$/);
    expect(scope.rows[0]?.schema).toBe(fixture.schema);
    expect(scope.rows[0]?.path).toBe(fixture.schema);
    expect(scope.rows[0]?.version).toMatch(/^18\./);
    console.info(`PostgreSQL integration server version: ${scope.rows[0]?.version}`);
  });

  it("roundtrips sensor Unicode and keeps input and read snapshots isolated", async () => {
    const input = { ...registration, label: "Sensore qualità dell’acqua 🌍" };
    const original = { ...input, active: true };
    const writing = store.registerSensor(input);
    input.label = "changed after call";
    const created = await writing;
    expect(created).toEqual(original);
    created.active = false;
    created.regionId = "changed returned region";
    const retrieved = await store.getSensor(registration.sensorId);
    expect(retrieved).toEqual(original);
    retrieved!.label = "changed retrieved label";
    expect(await store.getSensor(registration.sensorId)).toEqual(original);
    expect(await store.getSensor("missing")).toBeUndefined();
    await expect(store.registerSensor(registration)).rejects.toMatchObject({ code: "SENSOR_EXISTS", statusCode: 409 });
  });

  it("lets exactly one of sixteen concurrent sensor registrations succeed across two pools", async () => {
    const second = fixture.createStore();
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
      (index % 2 === 0 ? store : second).registerSensor(registration)));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter(({ status }) => status === "rejected")) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "SENSOR_EXISTS", statusCode: 409 });
    }
    const count = await fixture.inspector.query<{ count: string }>("SELECT count(*) FROM sensors");
    expect(count.rows[0]?.count).toBe("1");
  });

  it("roundtrips exact signed timestamp text and safe integer sequence with isolated snapshots", async () => {
    await store.registerSensor(registration);
    const input = entry(1, { value: 5.125, sequence: Number.MAX_SAFE_INTEGER,
      observedAt: "2026-10-01T01:00:00.123+01:00" });
    const original = structuredClone(input);
    const writing = store.addObservation(input);
    input.observation.value = 123;
    input.observation.observedAt = "2026-10-03T00:00:00Z";
    input.observationId = id(99);
    await writing;
    const rows = await store.listObservations("region-01", "water.oxygen.mg_l", 512);
    expect(rows).toEqual([original]);
    rows[0]!.observation.signature = "changed";
    rows[0]!.observation.value = 321;
    rows[0]!.observationId = id(999);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 512)).toEqual([original]);
  });

  it("enforces the real sensor foreign key without converting it to a replay error", async () => {
    const row = entry(1);
    await expect(store.addObservation(row)).rejects.toMatchObject({ code: "23503" });
    await store.registerSensor(registration);
    await store.addObservation(row);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 512)).toEqual([row]);
  });

  it.each(["identical observation", "different IDs with the same sensor sequence"] as const)(
    "accepts one of sixteen concurrent writes: %s", async (scenario) => {
      await store.registerSensor(registration);
      const second = fixture.createStore();
      const candidates = Array.from({ length: 16 }, (_, index) => scenario === "identical observation"
        ? entry(1) : entry(index + 1, { sequence: 1, value: 5 + index / 10 }));
      const results = await Promise.allSettled(candidates.map((row, index) =>
        (index % 2 === 0 ? store : second).addObservation(row)));
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter(({ status }) => status === "rejected");
      expect(rejected).toHaveLength(15);
      for (const result of rejected) {
        if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "OBSERVATION_REPLAY", statusCode: 409 });
      }
      const rows = await store.listObservations("region-01", "water.oxygen.mg_l", 512);
      expect(rows).toHaveLength(1);
      expect(candidates).toContainEqual(rows[0]);
      const winner = results.findIndex(({ status }) => status === "fulfilled");
      expect(rows[0]).toEqual(candidates[winner]);
      const count = await fixture.inspector.query<{ count: string }>("SELECT count(*) FROM observations");
      expect(count.rows[0]?.count).toBe("1");
    });

  it("rolls back rejected primary-key and sequence collisions without reserving the other key", async () => {
    await store.registerSensor(registration);
    const original = entry(1);
    await store.addObservation(original);
    await expect(store.addObservation({ ...entry(2), observationId: original.observationId }))
      .rejects.toMatchObject({ code: "OBSERVATION_REPLAY" });
    const freeSequence = entry(3, { sequence: 2 });
    await store.addObservation(freeSequence);
    const rejectedId = entry(4, { sequence: 1 });
    await expect(store.addObservation(rejectedId)).rejects.toMatchObject({ code: "OBSERVATION_REPLAY" });
    const reusedId = entry(4, { sequence: 4 });
    await store.addObservation(reusedId);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 512))
      .toEqual([original, freeSequence, reusedId]);
  });

  it("allows equal sequences from different registered sensors", async () => {
    await store.registerSensor(registration);
    await store.registerSensor({ ...registration, sensorId: "sensor-02" });
    const rows = [entry(1, { sequence: 7 }), entry(2, { sensorId: "sensor-02", sequence: 7 })];
    await Promise.all(rows.map((row) => store.addObservation(row)));
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 512)).toEqual(rows);
  });

  it("matches bounded chronological tails for shuffled rows, metric/region partitions and offset ties", async () => {
    await store.registerSensor(registration);
    await store.registerSensor({ ...registration, sensorId: "sensor-02", regionId: "region-02" });
    const rows = Array.from({ length: 850 }, (_, value) => entry(value + 1, {
      regionId: value % 7 === 0 ? "region-02" : "region-01",
      sensorId: value % 7 === 0 ? "sensor-02" : "sensor-01",
      metric: value % 11 === 0 ? "water.temperature.c" : "water.oxygen.mg_l",
      observedAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(value / 3))).toISOString()
    }));
    rows.push(entry(1_000, { observedAt: "2026-10-01T01:00:00.000+01:00" }),
      entry(1_001, { observedAt: "2026-10-01T00:00:00.000Z" }),
      entry(1_002, { observedAt: "2026-09-30T19:00:00.000-05:00" }));
    const shuffled = [...rows].sort((left, right) =>
      ((left.observation.sequence * 131) % 857) - ((right.observation.sequence * 131) % 857));
    for (let offset = 0; offset < shuffled.length; offset += 32) {
      await Promise.all(shuffled.slice(offset, offset + 32).map((row) => store.addObservation(row)));
    }
    for (const region of ["region-01", "region-02", "missing"]) {
      for (const metric of ["water.oxygen.mg_l", "water.temperature.c"]) {
        for (const limit of [1, 7, 512]) {
          expect(await store.listObservations(region, metric, limit)).toEqual(reference(rows, region, metric, limit));
        }
      }
    }
    expect(reference(rows, "region-01", "water.oxygen.mg_l", 10_000).length).toBeGreaterThan(512);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store.listObservations("region-01", "water.oxygen.mg_l", limit))
        .rejects.toMatchObject({ code: "INVALID_LIMIT", statusCode: 400 });
    }
  }, 20_000);

  it("keeps the latest assessment despite completion order, ties and duplicate-ID conflicts", async () => {
    const newest = assessment(3);
    await store.saveAssessment(newest);
    await store.saveAssessment(assessment(1));
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(newest);
    const higherId = assessment(4, { generatedAt: newest.generatedAt });
    await Promise.all([store.saveAssessment(higherId),
      store.saveAssessment(assessment(2, { generatedAt: newest.generatedAt }))]);
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(higherId);
    await store.saveAssessment({ ...higherId, generatedAt: "2026-10-03T00:00:00Z", forecastValue: 999 });
    await store.saveAssessment({ ...higherId, regionId: "other-region" });
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(higherId);
    expect(await store.latestAssessment("other-region", "water.oxygen.mg_l")).toBeUndefined();
    expect(await store.latestAssessment("region-01", "water.temperature.c")).toBeUndefined();
    const count = await fixture.inspector.query<{ count: string }>("SELECT count(*) FROM assessments");
    expect(count.rows[0]?.count).toBe("4");
  });

  it("isolates assessment inputs and returned JSONB snapshots", async () => {
    const input = assessment(1);
    const original = { ...input };
    const writing = store.saveAssessment(input);
    input.forecastValue = 999;
    input.generatedAt = "2026-10-03T00:00:00Z";
    await writing;
    const read = await store.latestAssessment("region-01", "water.oxygen.mg_l");
    expect(read).toEqual(original);
    read!.risk = 1;
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(original);
  });

  it("persists sensor, observation and assessment across closing and reopening independent clients", async () => {
    const originalObservation = entry(1);
    const originalAssessment = assessment(1);
    await store.registerSensor(registration);
    await store.addObservation(originalObservation);
    await store.saveAssessment(originalAssessment);
    await fixture.closeStore(store);
    const reopened = fixture.createStore();
    expect(await reopened.getSensor(registration.sensorId)).toEqual({ ...registration, active: true });
    expect(await reopened.listObservations("region-01", "water.oxygen.mg_l", 512)).toEqual([originalObservation]);
    expect(await reopened.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(originalAssessment);
    await expect(reopened.addObservation(originalObservation)).rejects.toMatchObject({ code: "OBSERVATION_REPLAY" });
  });

  it.each([
    { name: "submillisecond values with inversely ordered IDs", ids: [1, 2], times: [
      "2026-10-01T00:00:00.1239Z", "2026-10-01T00:00:00.1231Z"
    ] },
    { name: "seven and nine fractional digits before a millisecond boundary", ids: [1, 2, 3], times: [
      "2026-10-01T00:00:00.1239999Z", "2026-10-01T00:00:00.124000000Z",
      "2026-10-01T00:00:00.123000001Z"
    ] },
    { name: "rounding across a UTC day boundary", ids: [1, 2, 3], times: [
      "2026-09-30T23:59:59.999999999Z", "2026-10-01T00:00:00.000000000Z",
      "2026-09-30T23:59:59.999000001Z"
    ] },
    { name: "negative epoch values before 1970", ids: [1, 2, 3], times: [
      "1969-12-31T23:59:59.9999999Z", "1970-01-01T00:00:00.000000000Z",
      "1969-12-31T23:59:59.999000001Z"
    ] },
    { name: "equivalent UTC offsets and fractional spellings", ids: [1, 2, 3], times: [
      "2026-10-01T00:00:00.1239999Z", "2026-10-01T01:00:00.123+01:00",
      "2026-09-30T19:00:00.123000001-05:00"
    ] },
    { name: "minute precision without seconds", ids: [1, 2, 3], times: [
      "2026-10-01T00:00Z", "2026-10-01T01:00+01:00", "2026-10-01T00:00:00.000000001Z"
    ] },
    { name: "ASCII digit-to-letter ID ties", ids: [9, 10, 15], times: [
      "2026-10-01T00:00:00.1239Z", "2026-10-01T00:00:00.1231Z", "2026-10-01T00:00:00.123Z"
    ] }
  ])("matches memory millisecond tails and latest assessments for $name", async ({ times, ids }) => {
    await store.registerSensor(registration);
    const memory = new MemoryObservationStore();
    await memory.registerSensor(registration);
    const rows = times.map((observedAt, index) => ({
      ...entry(index + 1, { observedAt }), observationId: id(ids[index]!)
    }));
    // Different insertion orders must not change either the bounded tail or latest result.
    for (const row of [...rows].reverse()) await store.addObservation(row);
    for (const row of rows) await memory.addObservation(row);
    for (const limit of [1, 2, rows.length, rows.length + 1]) {
      const expected = reference(rows, "region-01", "water.oxygen.mg_l", limit);
      expect(await store.listObservations("region-01", "water.oxygen.mg_l", limit)).toEqual(expected);
      expect(await memory.listObservations("region-01", "water.oxygen.mg_l", limit)).toEqual(expected);
    }
    const keys = await fixture.inspector.query<{ observationId: string; milliseconds: string }>(
      `SELECT observation_id AS "observationId", observed_at_ms::text AS milliseconds FROM observations`);
    for (const row of rows) {
      expect(keys.rows.find(key => key.observationId === row.observationId)?.milliseconds)
        .toBe(String(Date.parse(row.observation.observedAt)));
    }
    const assessments = rows.map(row => assessment(row.observation.sequence, {
      assessmentId: row.observationId, generatedAt: row.observation.observedAt
    }));
    for (const row of assessments) await store.saveAssessment(row);
    for (const row of [...assessments].reverse()) await memory.saveAssessment(row);
    const latestId = reference(rows, "region-01", "water.oxygen.mg_l", 1)[0]!.observationId;
    const expectedLatest = assessments.find(row => row.assessmentId === latestId);
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(expectedLatest);
    expect(await memory.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(expectedLatest);
    await memory.close();
  });

  it("upgrades legacy rows from their signed raw timestamps without rewriting bodies or PostgreSQL timestamps", async () => {
    await fixture.close();
    fixture = await createPostgresFixture(databaseUrl!, { legacySchema: true });
    store = fixture.createStore();
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    await store.registerSensor({ ...registration, publicKeyDerBase64: publicKey });
    const times = ["1969-12-31T23:59:59.9999999Z", "2026-09-30T23:59:59.999999999Z",
      "2026-10-01T01:00:00.1239999+01:00", "2026-10-01T00:00Z"];
    const rows = times.map((observedAt, index): StoredObservation => {
      const { signature: _signature, ...unsigned } = entry(index + 1, { observedAt }).observation;
      return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
    });
    const assessments = times.map((generatedAt, index) => assessment(index + 1, { generatedAt }));
    for (const row of rows) {
      await fixture.inspector.query(
        `INSERT INTO observations (observation_id, sensor_id, region_id, metric, observed_at, sequence, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.observationId, row.observation.sensorId, row.observation.regionId, row.observation.metric,
          row.observation.observedAt, row.observation.sequence, row.observation]);
    }
    for (const row of assessments) {
      await fixture.inspector.query(
        `INSERT INTO assessments (assessment_id, region_id, metric, generated_at, body)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.assessmentId, row.regionId, row.metric, row.generatedAt, row]);
    }
    const snapshot = async () => ({
      observations: (await fixture.inspector.query(
        `SELECT observation_id, observed_at::text AS timestamp, body FROM observations
         ORDER BY observation_id COLLATE "C"`)).rows,
      assessments: (await fixture.inspector.query(
        `SELECT assessment_id, generated_at::text AS timestamp, body FROM assessments
         ORDER BY assessment_id COLLATE "C"`)).rows
    });
    const before = await snapshot();
    const migrationClient = await fixture.inspector.connect();
    try {
      // Explicit-offset source text must backfill identically outside a UTC session.
      await migrationClient.query("SET TimeZone = 'Pacific/Honolulu'");
      await migrationClient.query(fixture.timestampMigration);
    } catch (error) {
      await migrationClient.query("ROLLBACK");
      throw error;
    } finally {
      try { await migrationClient.query("RESET TimeZone"); } finally { migrationClient.release(); }
    }
    expect(await snapshot()).toEqual(before);
    const storedKeys = await fixture.inspector.query<{ observationId: string; milliseconds: string }>(
      `SELECT observation_id AS "observationId", observed_at_ms::text AS milliseconds FROM observations
        ORDER BY observation_id COLLATE "C"`);
    const generatedKeys = await fixture.inspector.query<{ assessmentId: string; milliseconds: string }>(
      `SELECT assessment_id AS "assessmentId", generated_at_ms::text AS milliseconds FROM assessments
        ORDER BY assessment_id COLLATE "C"`);
    for (const row of rows) {
      expect(storedKeys.rows.find(key => key.observationId === row.observationId)?.milliseconds)
        .toBe(String(Date.parse(row.observation.observedAt)));
    }
    for (const row of assessments) {
      expect(generatedKeys.rows.find(key => key.assessmentId === row.assessmentId)?.milliseconds)
        .toBe(String(Date.parse(row.generatedAt)));
    }
    const constraints = await fixture.inspector.query<{
      tableName: string; columnName: string; nullable: string; dataType: string;
    }>(
      `SELECT table_name AS "tableName", column_name AS "columnName", is_nullable AS nullable,
              data_type AS "dataType" FROM information_schema.columns
        WHERE table_schema = $1 AND column_name IN ('observed_at_ms', 'generated_at_ms')
        ORDER BY table_name`, [fixture.schema]);
    expect(constraints.rows).toEqual([
      { tableName: "assessments", columnName: "generated_at_ms", nullable: "NO", dataType: "bigint" },
      { tableName: "observations", columnName: "observed_at_ms", nullable: "NO", dataType: "bigint" }
    ]);
    const upgraded = await store.listObservations("region-01", "water.oxygen.mg_l", 512);
    expect(upgraded).toEqual(reference(rows, "region-01", "water.oxygen.mg_l", 512));
    for (const row of upgraded) {
      expect(verifyObservation(row.observation, publicKey)).toBe(true);
      const { signature: _signature, ...unsigned } = row.observation;
      expect(observationId(unsigned)).toBe(row.observationId);
    }
    const sortedAssessments = [...assessments].sort((left, right) =>
      Date.parse(left.generatedAt) - Date.parse(right.generatedAt) ||
      (left.assessmentId < right.assessmentId ? -1 : left.assessmentId > right.assessmentId ? 1 : 0));
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(sortedAssessments.at(-1));
    // Reapply both actual files, including the already completed backfill.
    await fixture.inspector.query(fixture.migration);
    expect(await snapshot()).toEqual(before);
    expect((await fixture.inspector.query(
      `SELECT observation_id AS "observationId", observed_at_ms::text AS milliseconds FROM observations
        ORDER BY observation_id COLLATE "C"`)).rows)
      .toEqual(storedKeys.rows);
    expect((await fixture.inspector.query(
      `SELECT assessment_id AS "assessmentId", generated_at_ms::text AS milliseconds FROM assessments
        ORDER BY assessment_id COLLATE "C"`)).rows)
      .toEqual(generatedKeys.rows);
  });

  it.each(["observation", "assessment"] as const)(
    "rolls back all timestamp migration changes when a legacy %s lacks an explicit time zone", async kind => {
      await fixture.close();
      fixture = await createPostgresFixture(databaseUrl!, { legacySchema: true });
      store = fixture.createStore();
      await store.registerSensor(registration);
      const row = entry(1, { observedAt: kind === "observation"
        ? "2026-10-01T00:00:00" : "2026-10-01T00:00:00Z" });
      const report = assessment(1, { generatedAt: kind === "assessment"
        ? "2026-10-01T00:00:00" : "2026-10-01T00:00:00Z" });
      // Deliberately malformed legacy JSON, with valid separately stored TIMESTAMPTZ metadata.
      await fixture.inspector.query(
        `INSERT INTO observations (observation_id, sensor_id, region_id, metric, observed_at, sequence, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.observationId, row.observation.sensorId, row.observation.regionId, row.observation.metric,
          "2026-10-01T00:00:00Z", row.observation.sequence, row.observation]);
      await fixture.inspector.query(
        `INSERT INTO assessments (assessment_id, region_id, metric, generated_at, body)
         VALUES ($1, $2, $3, $4, $5)`,
        [report.assessmentId, report.regionId, report.metric, "2026-10-01T00:00:00Z", report]);
      const snapshot = async () => ({
        observations: (await fixture.inspector.query(
          "SELECT observation_id, observed_at::text AS timestamp, body FROM observations")).rows,
        assessments: (await fixture.inspector.query(
          "SELECT assessment_id, generated_at::text AS timestamp, body FROM assessments")).rows
      });
      const before = await snapshot();
      const client = await fixture.inspector.connect();
      try {
        await expect(client.query(fixture.timestampMigration)).rejects.toMatchObject({ code: "P0001" });
        await expect(client.query("SELECT 1")).rejects.toMatchObject({ code: "25P02" });
      } finally {
        try { await client.query("ROLLBACK"); } finally { client.release(); }
      }
      const columns = await fixture.inspector.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND column_name IN ('observed_at_ms', 'generated_at_ms')`, [fixture.schema]);
      expect(columns.rows).toEqual([]);
      const indexes = await fixture.inspector.query(
        `SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = $1
          AND indexname IN ('observations_region_metric_time_ms', 'assessments_region_metric_time_ms')`, [fixture.schema]);
      expect(indexes.rows).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });

  it("provides matching time-and-ID indexes for bounded reads without claiming a performance benchmark", async () => {
    await store.registerSensor(registration);
    for (let value = 1; value <= 32; value += 1) {
      await store.addObservation(entry(value));
      await store.saveAssessment(assessment(value));
    }
    const definitions = await fixture.inspector.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_catalog.pg_indexes
        WHERE schemaname = $1 AND indexname IN
          ('observations_region_metric_time_ms', 'assessments_region_metric_time_ms')`, [fixture.schema]);
    expect(definitions.rows).toHaveLength(2);
    for (const row of definitions.rows) expect(row.indexdef).toContain('COLLATE "C"');
    const client = await fixture.inspector.connect();
    try {
      await client.query("BEGIN");
      // Force a diagnostic index-availability check. This does not measure the production planner or latency.
      await client.query("SET LOCAL enable_seqscan = off");
      for (const [table, timeColumn, idColumn, expectedIndex] of [
        ["observations", "observed_at_ms", "observation_id", "observations_region_metric_time_ms"],
        ["assessments", "generated_at_ms", "assessment_id", "assessments_region_metric_time_ms"]
      ] as const) {
        const result = await client.query<{ "QUERY PLAN": { Plan: Record<string, unknown> }[] }>(
          `EXPLAIN (FORMAT JSON, COSTS OFF) SELECT body FROM ${table}
            WHERE region_id = $1 AND metric = $2
            ORDER BY ${timeColumn} DESC, ${idColumn} COLLATE "C" DESC LIMIT $3`,
          ["region-01", "water.oxygen.mg_l", 1]);
        const plan = JSON.stringify(result.rows[0]?.["QUERY PLAN"]);
        expect(plan).toContain(expectedIndex);
        expect(plan).toMatch(/Index(?: Only)? Scan/);
        expect(plan).not.toContain('"Node Type":"Sort"');
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("selects identical signed evidence and analysis hashes through both backends", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const memory = new MemoryObservationStore();
    await store.registerSensor({ ...registration, publicKeyDerBase64: publicKey });
    await memory.registerSensor({ ...registration, publicKeyDerBase64: publicKey });
    const times = ["2026-10-01T00:00:00.1239999Z", "2026-10-01T00:30:00.0000001Z",
      "2026-10-01T02:00+01:00", "2026-10-01T01:00:00.123000001Z",
      "2026-10-01T02:00:00.000Z", "2026-10-01T02:00:00.000000001Z",
      "2026-10-01T03:00:00.9999999Z"];
    const rows = times.map((observedAt, index): StoredObservation => {
      const { signature: _signature, ...unsigned } = entry(index + 1, { observedAt, value: 5 + index / 10 }).observation;
      return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
    });
    for (const row of rows) await store.addObservation(row);
    for (const row of [...rows].reverse()) await memory.addObservation(row);
    const expected = reference(rows, "region-01", "water.oxygen.mg_l", 5);
    const postgresRows = await store.listObservations("region-01", "water.oxygen.mg_l", 5);
    const memoryRows = await memory.listObservations("region-01", "water.oxygen.mg_l", 5);
    expect(postgresRows).toEqual(expected);
    expect(memoryRows).toEqual(expected);
    for (const row of postgresRows) {
      expect(verifyObservation(row.observation, publicKey)).toBe(true);
      const { signature: _signature, ...unsigned } = row.observation;
      expect(observationId(unsigned)).toBe(row.observationId);
    }
    const postgresAssessment = analyzeObservations(postgresRows, 3_600);
    const memoryAssessment = analyzeObservations(memoryRows, 3_600);
    expect(postgresAssessment).toEqual(memoryAssessment);
    expect(postgresAssessment.evidenceHash).toBe(analyzeObservations(expected, 3_600).evidenceHash);
    await store.saveAssessment(postgresAssessment);
    await memory.saveAssessment(memoryAssessment);
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l"))
      .toEqual(await memory.latestAssessment("region-01", "water.oxygen.mg_l"));
    await memory.close();
  });

  it.each(["not-a-timestamp", "2026-99-99T99:99:99Z", ""])(
    "rejects unparseable timestamps without consuming observation keys or assessment IDs: case %#", async (invalidTime) => {
      const memory = new MemoryObservationStore();
      await store.registerSensor(registration);
      await memory.registerSensor(registration);
      const invalid = entry(1, { observedAt: invalidTime });
      for (const target of [store, memory]) {
        await expect(target.addObservation(invalid)).rejects.toMatchObject({ code: "INVALID_TIME", statusCode: 422 });
        expect(await target.listObservations("region-01", "water.oxygen.mg_l", 1)).toEqual([]);
        await target.addObservation(entry(1));
        expect(await target.listObservations("region-01", "water.oxygen.mg_l", 1)).toEqual([entry(1)]);
        await expect(target.saveAssessment(assessment(1, { generatedAt: invalidTime })))
          .rejects.toMatchObject({ code: "INVALID_TIME", statusCode: 422 });
        expect(await target.latestAssessment("region-01", "water.oxygen.mg_l")).toBeUndefined();
        await target.saveAssessment(assessment(1));
        expect(await target.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(assessment(1));
      }
      await memory.close();
    });

  it("uses actual Ed25519 API verification with PostgreSQL and preserves rejected sequence availability", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const now = new Date("2026-10-18T12:00:00.000Z");
    const app = buildApp({ store, policySource, adminToken: "synthetic-admin",
      oracleToken: "synthetic-oracle", now: () => now });
    fixture.useStoreOwner(store, () => app.close());
    const registered = await app.inject({ method: "POST", url: "/v1/sensors",
      headers: { "x-admin-token": "synthetic-admin" }, payload: {
        sensorId: "sensor-api", regionId: "IT-PO-DELTA", publicKeyDerBase64: publicKey, label: "Synthetic API sensor"
      } });
    expect(registered.statusCode).toBe(201);
    const unsigned = { sensorId: "sensor-api", regionId: "IT-PO-DELTA",
      metric: "water.oxygen.mg_l", value: 5.5, unit: "mg/L", observedAt: now.toISOString(), sequence: 1 };
    const signed = signObservation(unsigned, privateKey);
    expect((await app.inject({ method: "POST", url: "/v1/observations", payload: signed })).statusCode).toBe(202);
    const replay = await app.inject({ method: "POST", url: "/v1/observations", payload: signed });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe("OBSERVATION_REPLAY");
    const tampered = await app.inject({ method: "POST", url: "/v1/observations",
      payload: { ...signed, value: 99, sequence: 2 } });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().error).toBe("INVALID_SIGNATURE");
    const count = await fixture.inspector.query<{ count: string }>("SELECT count(*) FROM observations");
    expect(count.rows[0]?.count).toBe("1");
    const next = signObservation({ ...unsigned, sequence: 2 }, privateKey);
    expect((await app.inject({ method: "POST", url: "/v1/observations", payload: next })).statusCode).toBe(202);
    const stored = await store.listObservations("IT-PO-DELTA", "water.oxygen.mg_l", 512);
    expect(stored).toHaveLength(2);
    expect(stored.map(({ observation }) => observation)).toContainEqual(signed);
    expect(stored.map(({ observation }) => observation)).toContainEqual(next);
    for (let sequence = 3; sequence <= 5; sequence += 1) {
      const payload = signObservation({ ...unsigned, sequence, value: 6 + sequence / 10,
        observedAt: new Date(now.getTime() - sequence * 3_600_000).toISOString() }, privateKey);
      expect((await app.inject({ method: "POST", url: "/v1/observations", payload })).statusCode).toBe(202);
    }
    const evidence = await store.listObservations("IT-PO-DELTA", "water.oxygen.mg_l", 512);
    const expected = analyzeObservations(evidence, 3_600);
    const result = await app.inject({ method: "POST", url: "/v1/assessments/run",
      headers: { "x-oracle-token": "synthetic-oracle" }, payload: {
        regionId: "IT-PO-DELTA", metric: "water.oxygen.mg_l", forecastHorizonHours: 1,
        requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC"
      } });
    expect(result.statusCode).toBe(201);
    expect(result.json().assessment.observationCount).toBe(5);
    expect(result.json().assessment.forecastHorizonSeconds).toBe(3_600);
    expect(result.json().assessment.evidenceHash).toBe(expected.evidenceHash);
    const latest = await app.inject({ method: "GET",
      url: "/v1/regions/IT-PO-DELTA/metrics/water.oxygen.mg_l/latest" });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toEqual(result.json().assessment);
  });
});
