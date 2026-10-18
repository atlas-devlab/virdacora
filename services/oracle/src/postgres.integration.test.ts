import { generateKeyPairSync } from "node:crypto";

import type { Assessment, SensorRegistration } from "@terravoce/protocol";
import { signObservation } from "@terravoce/protocol";
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
      return time === 0 ? left.observationId.localeCompare(right.observationId) : time;
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

  it("documents the known PostgreSQL microsecond versus memory millisecond ordering difference", async () => {
    await store.registerSensor(registration);
    const memory = new MemoryObservationStore();
    const rows = [entry(1, { observedAt: "2026-10-01T00:00:00.1239Z" }),
      entry(2, { observedAt: "2026-10-01T00:00:00.1231Z" })];
    for (const row of rows) { await store.addObservation(row); await memory.addObservation(row); }
    const postgresRows = await store.listObservations("region-01", "water.oxygen.mg_l", 512);
    const memoryRows = await memory.listObservations("region-01", "water.oxygen.mg_l", 512);
    expect(postgresRows).toEqual([rows[1], rows[0]]);
    expect(memoryRows).toEqual([rows[0], rows[1]]);
    expect(postgresRows).not.toEqual(memoryRows);
    const newer = assessment(1, { generatedAt: "2026-10-01T00:00:00.1239Z" });
    const higherIdOlderTime = assessment(2, { generatedAt: "2026-10-01T00:00:00.1231Z" });
    for (const row of [newer, higherIdOlderTime]) { await store.saveAssessment(row); await memory.saveAssessment(row); }
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(newer);
    expect(await memory.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(higherIdOlderTime);
    // This is a characterization of an existing limitation, not parity or a precision fix.
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
