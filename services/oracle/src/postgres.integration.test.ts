import { generateKeyPairSync } from "node:crypto";

import type { Assessment, SensorRegistration } from "@terravoce/protocol";
import { canonicalJson, observationId, sha256Hex, signObservation, verifyObservation } from "@terravoce/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPostgresFixture, REQUIRE_DATABASE_ENV, TEST_DATABASE_ENV,
  validateTestDatabaseUrl, type PostgresFixture
} from "../test/postgres-fixture.js";
import { buildApp } from "./app.js";
import { analyzeEvidence, analyzeObservations } from "./analysis.js";
import { createEvidenceReceipt, verifyEvidenceReceipt, type EvidenceReceipt } from "./evidence-receipt.js";
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

  const createSignedArchive = async (historical = false, mixedUnits = false) => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const now = new Date("2026-10-18T12:00:00.000Z");
    const app = buildApp({ store, policySource, adminToken: "synthetic-admin",
      oracleToken: "synthetic-oracle", now: () => now });
    fixture.useStoreOwner(store, () => app.close());
    const sensor = { ...registration, regionId: "IT-PO-DELTA", publicKeyDerBase64: publicKey };
    if (historical) await store.registerSensor(sensor);
    else expect((await app.inject({ method: "POST", url: "/v1/sensors",
      headers: { "x-admin-token": "synthetic-admin" }, payload: sensor })).statusCode).toBe(201);
    const origin = historical ? Date.parse("2026-08-01T00:00:00.000Z") : now.getTime() - 5 * 3_600_000;
    const rows = Array.from({ length: 6 }, (_, index): StoredObservation => {
      const { signature: _signature, ...unsigned } = entry(index + 1, { regionId: sensor.regionId,
        observedAt: new Date(origin + index * 3_600_000).toISOString(),
        value: mixedUnits && index % 2 === 1 ? 6_000 : 6,
        unit: mixedUnits && index % 2 === 1 ? "\u00b5g/L" : "mg/L" }).observation;
      return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
    });
    for (const row of rows) {
      if (historical) await store.addObservation(row); // Represents already accepted, genuinely signed history.
      else expect((await app.inject({ method: "POST", url: "/v1/observations", payload: row.observation })).statusCode)
        .toBe(202);
    }
    const run = () => app.inject({ method: "POST", url: "/v1/assessments/run",
      headers: { "x-oracle-token": "synthetic-oracle" }, payload: {
        regionId: sensor.regionId, metric: "water.oxygen.mg_l", forecastHorizonHours: 1,
        requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC"
      } });
    const snapshot = async () => (await fixture.inspector.query<StoredObservation>(
      `SELECT observation_id AS "observationId", body AS observation FROM observations
        ORDER BY observed_at_ms, observation_id COLLATE "C"`)).rows;
    expect(await snapshot()).toEqual(rows);
    return { app, publicKey, privateKey, now, sensor, rows, run, snapshot };
  };

  const packetFor = (archive: Awaited<ReturnType<typeof createSignedArchive>>, horizonSeconds = 3_600): EvidenceReceipt =>
    createEvidenceReceipt(analyzeEvidence(archive.rows, horizonSeconds), {
      observations: archive.rows,
      sensors: [{ sensorId: archive.sensor.sensorId, regionId: archive.sensor.regionId,
        publicKeyDerBase64: archive.publicKey }]
    });
  const packetId = (receipt: EvidenceReceipt) => sha256Hex(`receipt:${canonicalJson(receipt)}`);

  const permutedPackets = (receipt: EvidenceReceipt, count: number): EvidenceReceipt[] => {
    const packets: EvidenceReceipt[] = [];
    const visit = (remaining: number[], selected: number[]) => {
      if (packets.length >= count) return;
      if (remaining.length === 0) {
        const packet = structuredClone(receipt);
        packet.observations = selected.map(index => structuredClone(receipt.observations[index]!));
        packets.push(packet);
        return;
      }
      for (const index of remaining) {
        visit(remaining.filter(candidate => candidate !== index), [...selected, index]);
        if (packets.length >= count) break;
      }
    };
    visit(receipt.observations.map((_row, index) => index), []);
    expect(packets).toHaveLength(count);
    expect(new Set(packets.map(packetId)).size).toBe(count);
    return packets;
  };

  const expectNoStoredAssessment = async () => {
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessments")).rows)
      .toEqual([{ count: 0 }]);
  };

  it("applies the actual migration twice in a private schema with no public fallback", async () => {
    await fixture.inspector.query(fixture.migration);
    const tables = await fixture.inspector.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename",
      [fixture.schema]);
    expect(tables.rows.map(({ tablename }) => tablename))
      .toEqual(["assessment_evidence", "assessments", "observations", "sensors"]);
    const scope = await fixture.inspector.query<{ database: string; schema: string; path: string; version: string }>(
      `SELECT current_database() AS database, current_schema() AS schema,
              current_setting('search_path') AS path, current_setting('server_version') AS version`);
    expect(scope.rows[0]?.database).toMatch(/^virdacora_test(?:_[a-z0-9]+)?$/);
    expect(scope.rows[0]?.schema).toBe(fixture.schema);
    expect(scope.rows[0]?.path).toBe(fixture.schema);
    expect(scope.rows[0]?.version).toMatch(/^18\./);
    console.info(`PostgreSQL integration server version: ${scope.rows[0]?.version}`);
  });

  it("rejects legacy schema readiness until the actual timestamp and evidence migrations are applied", async () => {
    await fixture.close();
    fixture = await createPostgresFixture(databaseUrl!, { legacySchema: true });
    store = fixture.createStore();
    await expect(store.checkReadiness()).rejects.toBeDefined();
    await fixture.inspector.query(fixture.timestampMigration);
    await expect(store.checkReadiness()).rejects.toBeDefined();
    await fixture.inspector.query(fixture.evidenceMigration);
    await expect(store.checkReadiness()).resolves.toBeUndefined();
    for (const table of ["sensors", "observations", "assessments", "assessment_evidence"]) {
      expect((await fixture.inspector.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows)
        .toEqual([{ count: 0 }]);
    }
  });

  it("fails readiness when a required column disappears and recovers after it is restored", async () => {
    await expect(store.checkReadiness()).resolves.toBeUndefined();
    // Only the generated fixture schema is in search_path. Rename rather than
    // rebuild the column so its type, data, defaults and constraints survive.
    await fixture.inspector.query("ALTER TABLE sensors RENAME COLUMN active TO readiness_test_hidden_active");
    try {
      await expect(store.checkReadiness()).rejects.toBeDefined();
    } finally {
      await fixture.inspector.query("ALTER TABLE sensors RENAME COLUMN readiness_test_hidden_active TO active");
    }
    await expect(store.checkReadiness()).resolves.toBeUndefined();
  });

  it("rejects a read-only session without using writes as readiness probes", async () => {
    const readOnly = fixture.createStore({ readOnly: true });
    // A read-only client can read schema metadata but must not be declared
    // ready for an Oracle that accepts signed observation writes.
    await expect(readOnly.getSensor("missing")).resolves.toBeUndefined();
    await expect(readOnly.checkReadiness()).rejects.toBeDefined();
    await expect(store.checkReadiness()).resolves.toBeUndefined();
    for (const table of ["sensors", "observations", "assessments"]) {
      expect((await fixture.inspector.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows)
        .toEqual([{ count: 0 }]);
    }
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
    // Reapply all actual migration files, including the already completed backfill.
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

  it("analyzes signed mixed oxygen units identically across PostgreSQL and memory without rewriting originals", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const now = new Date("2026-10-18T12:00:00.000Z");
    const app = buildApp({ store, policySource, adminToken: "synthetic-admin",
      oracleToken: "synthetic-oracle", now: () => now });
    fixture.useStoreOwner(store, () => app.close());
    const memory = new MemoryObservationStore();
    const sensor = { ...registration, regionId: "IT-PO-DELTA", publicKeyDerBase64: publicKey };
    expect((await app.inject({ method: "POST", url: "/v1/sensors",
      headers: { "x-admin-token": "synthetic-admin" }, payload: sensor })).statusCode).toBe(201);
    await memory.registerSensor(sensor);
    // All four accepted spellings occur; the chronologically latest row is
    // micrograms, so currentValue must be normalized as well as the regression.
    const units = ["mg/L", "ug/L", "\u00b5g/L", "\u03bcg/L", "mg/L", "\u00b5g/L"];
    const rows = units.map((unit, index): StoredObservation => {
      const { signature: _signature, ...unsigned } = entry(index + 1, {
        regionId: sensor.regionId, unit, value: unit === "mg/L" ? 6 : 6_000,
        observedAt: new Date(now.getTime() - (units.length - index) * 3_600_000).toISOString()
      }).observation;
      return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
    });
    const originals = structuredClone(rows);
    for (const row of rows) {
      expect((await app.inject({ method: "POST", url: "/v1/observations", payload: row.observation })).statusCode)
        .toBe(202);
      await memory.addObservation(row);
    }
    const signedSnapshot = async () => (await fixture.inspector.query<StoredObservation>(
      `SELECT observation_id AS "observationId", body AS observation FROM observations
        ORDER BY observed_at_ms, observation_id COLLATE "C"`)).rows;
    expect(await signedSnapshot()).toEqual(originals);
    const memoryRows = await memory.listObservations(sensor.regionId, "water.oxygen.mg_l", 512);
    expect(await store.listObservations(sensor.regionId, "water.oxygen.mg_l", 512)).toEqual(memoryRows);
    const expected = analyzeObservations(memoryRows, 3_600);
    const result = await app.inject({ method: "POST", url: "/v1/assessments/run",
      headers: { "x-oracle-token": "synthetic-oracle" }, payload: {
        regionId: sensor.regionId, metric: "water.oxygen.mg_l", forecastHorizonHours: 1,
        requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC"
      } });
    expect(result.statusCode).toBe(201);
    expect(result.json().assessment).toEqual(expected);
    expect(result.json().assessment).toMatchObject({ observationCount: rows.length,
      currentValue: 6, forecastValue: 6, slopePerHour: 0, anomalyScore: 0 });
    expect((await app.inject({ method: "POST", url: "/v1/observations", payload: rows.at(-1)!.observation }))
      .statusCode).toBe(409);
    expect(await signedSnapshot()).toEqual(originals);
    await fixture.closeStore(store); // The app drains and closes this pool through its owner.
    const reopened = fixture.createStore();
    const reopenedRows = await reopened.listObservations(sensor.regionId, "water.oxygen.mg_l", 512);
    expect(reopenedRows).toEqual(originals);
    expect(await reopened.latestAssessment(sensor.regionId, "water.oxygen.mg_l")).toEqual(expected);
    for (const row of reopenedRows) {
      expect(verifyObservation(row.observation, publicKey)).toBe(true);
      const { signature: _signature, ...unsigned } = row.observation;
      expect(observationId(unsigned)).toBe(row.observationId);
    }
    expect(rows).toEqual(originals);
    expect(await memory.listObservations(sensor.regionId, "water.oxygen.mg_l", 512)).toEqual(originals);
    await memory.close();
  });

  it("rejects a newly submitted unsupported oxygen unit before inserting or reserving its sequence", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const now = new Date("2026-10-18T12:00:00.000Z");
    const app = buildApp({ store, policySource, adminToken: "synthetic-admin",
      oracleToken: "synthetic-oracle", now: () => now });
    fixture.useStoreOwner(store, () => app.close());
    await store.registerSensor({ ...registration, regionId: "IT-PO-DELTA", publicKeyDerBase64: publicKey });
    const { signature: _signature, ...unsigned } = entry(1, { regionId: "IT-PO-DELTA",
      observedAt: now.toISOString(), value: 0.006, unit: "g/L" }).observation;
    const unsupported = signObservation(unsigned, privateKey);
    expect(verifyObservation(unsupported, publicKey)).toBe(true);

    const rejected = await app.inject({ method: "POST", url: "/v1/observations", payload: unsupported });

    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe("INVALID_OBSERVATION_UNIT");
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM observations")).rows)
      .toEqual([{ count: 0 }]);
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessments")).rows)
      .toEqual([{ count: 0 }]);
    const supported = signObservation({ ...unsigned, unit: "mg/L", value: 6 }, privateKey);
    expect((await app.inject({ method: "POST", url: "/v1/observations", payload: supported })).statusCode).toBe(202);
    expect(await store.listObservations("IT-PO-DELTA", "water.oxygen.mg_l", 512))
      .toEqual([{ observationId: observationId({ ...unsigned, unit: "mg/L", value: 6 }), observation: supported }]);
  });

  it("rejects analysis of an unsupported legacy oxygen unit without an assessment, action draft or signed-data rewrite", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const now = new Date("2026-10-18T12:00:00.000Z");
    const app = buildApp({ store, policySource, adminToken: "synthetic-admin",
      oracleToken: "synthetic-oracle", now: () => now });
    fixture.useStoreOwner(store, () => app.close());
    await store.registerSensor({ ...registration, regionId: "IT-PO-DELTA", publicKeyDerBase64: publicKey });
    const rows = Array.from({ length: 5 }, (_, index): StoredObservation => {
      const { signature: _signature, ...unsigned } = entry(index + 1, { regionId: "IT-PO-DELTA",
        unit: index === 2 ? "g/L" : "mg/L", value: index === 2 ? 0.006 : 6,
        observedAt: new Date(now.getTime() - (5 - index) * 3_600_000).toISOString() }).observation;
      return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
    });
    for (const row of rows) await store.addObservation(row); // Simulate an existing archive, bypassing new HTTP validation.
    const originals = structuredClone(rows);

    const rejected = await app.inject({ method: "POST", url: "/v1/assessments/run",
      headers: { "x-oracle-token": "synthetic-oracle" }, payload: {
        regionId: "IT-PO-DELTA", metric: "water.oxygen.mg_l", forecastHorizonHours: 1,
        requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC"
      } });

    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe("INVALID_OBSERVATION_UNIT");
    expect(rejected.json()).not.toHaveProperty("assessment");
    expect(rejected.json()).not.toHaveProperty("actionDraft");
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessments")).rows)
      .toEqual([{ count: 0 }]);
    expect(await store.latestAssessment("IT-PO-DELTA", "water.oxygen.mg_l")).toBeUndefined();
    const stored = await store.listObservations("IT-PO-DELTA", "water.oxygen.mg_l", 512);
    expect(stored).toEqual(originals);
    for (const row of stored) {
      expect(verifyObservation(row.observation, publicKey)).toBe(true);
      const { signature: _signature, ...unsigned } = row.observation;
      expect(observationId(unsigned)).toBe(row.observationId);
    }
  });

  it("serves the current oxygen model assessment without letting a larger legacy ID hide it or rewriting history", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const now = new Date("2026-10-18T12:00:00.000Z");
    const currentVersion = "terravoce-linear-risk-v2-oxygen-units";
    const app = buildApp({ store, policySource, adminToken: "synthetic-admin",
      oracleToken: "synthetic-oracle", now: () => now });
    fixture.useStoreOwner(store, () => app.close());
    await store.registerSensor({ ...registration, regionId: "IT-PO-DELTA", publicKeyDerBase64: publicKey });
    const legacy = assessment(1, { assessmentId: `0x${"f".repeat(64)}`, regionId: "IT-PO-DELTA",
      modelVersion: "terravoce-linear-risk-v1", generatedAt: now.toISOString() });
    await store.saveAssessment(legacy);
    const legacyBefore = (await fixture.inspector.query<{ body: Assessment }>(
      "SELECT body FROM assessments WHERE assessment_id = $1", [legacy.assessmentId])).rows[0]?.body;
    expect(legacyBefore).toEqual(legacy);
    const latestUrl = "/v1/regions/IT-PO-DELTA/metrics/water.oxygen.mg_l/latest";
    const before = await app.inject({ method: "GET", url: latestUrl });
    expect(before.statusCode).toBe(404);
    expect(before.json().error).toBe("ASSESSMENT_NOT_FOUND");
    expect(await store.latestAssessment("IT-PO-DELTA", "water.oxygen.mg_l", currentVersion)).toBeUndefined();
    expect(await store.latestAssessment("IT-PO-DELTA", "water.oxygen.mg_l")).toEqual(legacy);

    const rows = Array.from({ length: 6 }, (_, index): StoredObservation => {
      const { signature: _signature, ...unsigned } = entry(index + 1, { regionId: "IT-PO-DELTA",
        unit: index % 2 === 0 ? "mg/L" : "\u00b5g/L", value: index % 2 === 0 ? 6 : 6_000,
        observedAt: new Date(now.getTime() - (5 - index) * 3_600_000).toISOString() }).observation;
      return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
    });
    for (const row of rows) {
      expect((await app.inject({ method: "POST", url: "/v1/observations", payload: row.observation })).statusCode)
        .toBe(202);
    }
    const run = await app.inject({ method: "POST", url: "/v1/assessments/run",
      headers: { "x-oracle-token": "synthetic-oracle" }, payload: {
        regionId: "IT-PO-DELTA", metric: "water.oxygen.mg_l", forecastHorizonHours: 1,
        requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC"
      } });
    expect(run.statusCode).toBe(201);
    const current = run.json<{ assessment: Assessment }>().assessment;
    expect(current).toMatchObject({ modelVersion: currentVersion, generatedAt: legacy.generatedAt,
      currentValue: 6, forecastValue: 6, slopePerHour: 0, anomalyScore: 0 });
    expect(current.assessmentId < legacy.assessmentId).toBe(true);
    const latest = await app.inject({ method: "GET", url: latestUrl });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toEqual(current);
    expect(await store.latestAssessment("IT-PO-DELTA", "water.oxygen.mg_l", currentVersion)).toEqual(current);
    // Preserve the default max(timestamp, ID) contract across all versions.
    expect(await store.latestAssessment("IT-PO-DELTA", "water.oxygen.mg_l")).toEqual(legacy);
    const archived = (await fixture.inspector.query<{ assessmentId: string; body: Assessment }>(
      'SELECT assessment_id AS "assessmentId", body FROM assessments')).rows;
    expect(archived).toHaveLength(2);
    expect(archived.find(({ assessmentId }) => assessmentId === legacy.assessmentId)?.body).toEqual(legacyBefore);
    expect(archived.find(({ assessmentId }) => assessmentId === current.assessmentId)?.body).toEqual(current);
    expect(await store.listObservations("IT-PO-DELTA", "water.oxygen.mg_l", 512)).toEqual(rows);
    for (const row of rows) expect(verifyObservation(row.observation, publicKey)).toBe(true);
  });

  it("rejects altered archived JSONB without repair and recovers after the exact signed original is restored", async () => {
    const archive = await createSignedArchive();
    const originals = structuredClone(archive.rows);
    const altered = archive.rows[2]!;
    const expected = analyzeObservations(originals, 3_600);
    await fixture.inspector.query(
      "UPDATE observations SET body = jsonb_set(body, '{value}', '6000'::jsonb) WHERE observation_id = $1",
      [altered.observationId]);

    const rejected = await archive.run();

    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe("INVALID_ARCHIVED_EVIDENCE");
    for (const field of ["assessment", "decision", "actionDraft"]) expect(rejected.json()).not.toHaveProperty(field);
    await expectNoStoredAssessment();
    const corruptedSnapshot = await archive.snapshot();
    expect(corruptedSnapshot).toEqual(originals.map((row, index) => index === 2
      ? { ...row, observation: { ...row.observation, value: 6_000 } } : row));
    expect(verifyObservation(corruptedSnapshot[2]!.observation, archive.publicKey)).toBe(false);
    // Readiness describes the accessible database, not cryptographic validity of its rows.
    expect((await archive.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);

    await fixture.inspector.query("UPDATE observations SET body = $1::jsonb WHERE observation_id = $2",
      [originals[2]!.observation, altered.observationId]);
    const recovered = await archive.run();
    expect(recovered.statusCode).toBe(201);
    expect(recovered.json().assessment).toEqual(expected);
    expect(await archive.snapshot()).toEqual(originals);
    expect((await archive.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    for (const row of await archive.snapshot()) {
      expect(verifyObservation(row.observation, archive.publicKey)).toBe(true);
      const { signature: _signature, ...unsigned } = row.observation;
      expect(observationId(unsigned)).toBe(row.observationId);
    }
  });

  it("rejects a forged archived observation ID even while its original signed body remains intact", async () => {
    const archive = await createSignedArchive();
    const original = archive.rows[2]!;
    const forgedId = `0x${"0".repeat(64)}`;
    expect(archive.rows.every(({ observationId: storedId }) => storedId !== forgedId)).toBe(true);
    await fixture.inspector.query("UPDATE observations SET observation_id = $1 WHERE observation_id = $2",
      [forgedId, original.observationId]);

    const rejected = await archive.run();

    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe("INVALID_ARCHIVED_EVIDENCE");
    for (const field of ["assessment", "decision", "actionDraft"]) expect(rejected.json()).not.toHaveProperty(field);
    await expectNoStoredAssessment();
    const archived = (await fixture.inspector.query<StoredObservation>(
      'SELECT observation_id AS "observationId", body AS observation FROM observations WHERE observation_id = $1',
      [forgedId])).rows[0];
    expect(archived).toEqual({ observationId: forgedId, observation: original.observation });
    expect(verifyObservation(archived!.observation, archive.publicKey)).toBe(true);
    const { signature: _signature, ...unsigned } = archived!.observation;
    expect(observationId(unsigned)).toBe(original.observationId);
    expect(observationId(unsigned)).not.toBe(archived!.observationId);
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM observations")).rows)
      .toEqual([{ count: archive.rows.length }]);
  });

  it("rechecks the current sensor public key for every assessment request without changing archived bodies", async () => {
    const archive = await createSignedArchive();
    const originals = structuredClone(archive.rows);
    const expected = analyzeObservations(originals, 3_600);
    // Warm a possible positive cache before changing the registry. A failed
    // first request followed only by recovery would not catch that cache.
    const initial = await archive.run();
    expect(initial.statusCode).toBe(201);
    expect(initial.json().assessment).toEqual(expected);
    const assessmentsBefore = (await fixture.inspector.query("SELECT assessment_id, body FROM assessments")).rows;
    expect(assessmentsBefore).toHaveLength(1);
    const differentKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    await fixture.inspector.query("UPDATE sensors SET public_key_der_base64 = $1 WHERE sensor_id = $2",
      [differentKey, archive.sensor.sensorId]);

    const rejected = await archive.run();

    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe("INVALID_ARCHIVED_EVIDENCE");
    for (const field of ["assessment", "decision", "actionDraft"]) expect(rejected.json()).not.toHaveProperty(field);
    expect((await fixture.inspector.query("SELECT assessment_id, body FROM assessments")).rows).toEqual(assessmentsBefore);
    expect(await archive.snapshot()).toEqual(originals);
    expect((await store.getSensor(archive.sensor.sensorId))?.publicKeyDerBase64).toBe(differentKey);

    await fixture.inspector.query("UPDATE sensors SET public_key_der_base64 = $1 WHERE sensor_id = $2",
      [archive.publicKey, archive.sensor.sensorId]);
    const recovered = await archive.run();
    expect(recovered.statusCode).toBe(201);
    expect(recovered.json().assessment).toEqual(expected);
    expect((await fixture.inspector.query("SELECT assessment_id, body FROM assessments")).rows).toEqual(assessmentsBefore);
    expect(await archive.snapshot()).toEqual(originals);
    expect((await store.getSensor(archive.sensor.sensorId))?.publicKeyDerBase64).toBe(archive.publicKey);
  });

  it("keeps valid old signed evidence usable after sensor deactivation while rejecting new submissions", async () => {
    const archive = await createSignedArchive(true);
    const originals = structuredClone(archive.rows);
    expect(archive.rows.every(({ observation }) =>
      Date.parse(observation.observedAt) < archive.now.getTime() - 30 * 24 * 3_600_000)).toBe(true);
    await fixture.inspector.query("UPDATE sensors SET active = false WHERE sensor_id = $1", [archive.sensor.sensorId]);
    expect((await store.getSensor(archive.sensor.sensorId))?.active).toBe(false);

    const historical = await archive.run();

    expect(historical.statusCode).toBe(201);
    expect(historical.json().assessment).toEqual(analyzeObservations(originals, 3_600));
    const freshUnsigned = { sensorId: archive.sensor.sensorId, regionId: archive.sensor.regionId,
      metric: "water.oxygen.mg_l", value: 6, unit: "mg/L", observedAt: archive.now.toISOString(), sequence: 7 };
    const fresh = signObservation(freshUnsigned, archive.privateKey);
    expect(verifyObservation(fresh, archive.publicKey)).toBe(true);
    const rejected = await archive.app.inject({ method: "POST", url: "/v1/observations", payload: fresh });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error).toBe("SENSOR_INACTIVE");
    expect(await archive.snapshot()).toEqual(originals);
    for (const row of await archive.snapshot()) expect(verifyObservation(row.observation, archive.publicKey)).toBe(true);
  });

  it("verifies a detached evidence receipt after the archive changes and all fixture database clients are closed", async () => {
    const archive = await createSignedArchive(false, true);
    // Trust comes from the test registration/key material before the response,
    // never from the sensor descriptors inside the received packet.
    const trustedSensors = [{ sensorId: archive.sensor.sensorId, regionId: archive.sensor.regionId,
      publicKeyDerBase64: archive.publicKey }];
    const run = await archive.run();
    expect(run.statusCode).toBe(201);
    const payload = run.json<{ assessment: Assessment; evidenceReceipt: Record<string, unknown> }>();
    const receipt = payload.evidenceReceipt;
    const preservedReceipt = structuredClone(receipt);
    expect(Object.keys(receipt).sort()).toEqual(["assessment", "evidenceCore", "formatVersion", "observations", "sensors"]);
    expect(receipt.formatVersion).toBe("virdacora-evidence-receipt-v1");
    expect(receipt.assessment).toEqual(payload.assessment);
    expect(receipt.observations).toEqual(archive.rows);
    expect(receipt.sensors).toEqual(trustedSensors);
    expect(payload.assessment).toMatchObject({ currentValue: 6, forecastValue: 6, slopePerHour: 0, anomalyScore: 0 });
    await expect(verifyEvidenceReceipt(receipt, trustedSensors)).resolves.toEqual(payload.assessment);
    const persisted = (await fixture.inspector.query<{ body: Assessment }>(
      "SELECT body FROM assessments WHERE assessment_id = $1", [payload.assessment.assessmentId])).rows[0]?.body;
    expect(persisted).toEqual(payload.assessment);
    for (const field of ["evidenceReceipt", "evidenceCore", "observations", "sensors"]) {
      expect(persisted).not.toHaveProperty(field);
    }

    const next = signObservation({ sensorId: archive.sensor.sensorId, regionId: archive.sensor.regionId,
      metric: "water.oxygen.mg_l", value: 7, unit: "mg/L", sequence: 7,
      observedAt: new Date(archive.now.getTime() + 60_000).toISOString() }, archive.privateKey);
    expect((await archive.app.inject({ method: "POST", url: "/v1/observations", payload: next })).statusCode).toBe(202);
    await fixture.inspector.query(
      "UPDATE observations SET body = jsonb_set(body, '{value}', '999'::jsonb) WHERE observation_id = $1",
      [archive.rows[0]!.observationId]);
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM observations")).rows)
      .toEqual([{ count: 7 }]);
    expect((await fixture.inspector.query<{ body: StoredObservation["observation"] }>(
      "SELECT body FROM observations WHERE observation_id = $1", [archive.rows[0]!.observationId])).rows[0]?.body.value)
      .toBe(999);
    // Closing the fixture also drops its private archive schema. Verification
    // must therefore use the old signed packet and separately retained trust.
    await fixture.close();
    await expect(verifyEvidenceReceipt(receipt, trustedSensors)).resolves.toEqual(payload.assessment);
    expect(receipt).toEqual(preservedReceipt);
  });

  it("builds the evidence receipt from the validated sensor snapshot instead of rereading a changed registry", async () => {
    const archive = await createSignedArchive(false, true);
    const trustedSensors = [{ sensorId: archive.sensor.sensorId, regionId: archive.sensor.regionId,
      publicKeyDerBase64: archive.publicKey }];
    const replacementKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const saveOriginal = store.saveAssessmentWithReceipt.bind(store);
    const lookup = vi.spyOn(store, "getSensor");
    const saving = vi.spyOn(store, "saveAssessmentWithReceipt").mockImplementationOnce(async (generated) => {
      // The gate already validated the original key when this hook is reached.
      await fixture.inspector.query("UPDATE sensors SET public_key_der_base64 = $1 WHERE sensor_id = $2",
        [replacementKey, archive.sensor.sensorId]);
      return saveOriginal(generated);
    });
    try {
      const run = await archive.run();
      expect(run.statusCode).toBe(201);
      const payload = run.json<{ assessment: Assessment; evidenceReceipt: Record<string, unknown> }>();
      expect(saving).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(1); // One lookup for the single sensor in this batch, none for repackaging.
      expect(payload.evidenceReceipt.sensors).toEqual(trustedSensors);
      expect(payload.evidenceReceipt.observations).toEqual(archive.rows);
      await expect(verifyEvidenceReceipt(payload.evidenceReceipt, trustedSensors)).resolves.toEqual(payload.assessment);
      const changedTrust = [{ ...trustedSensors[0]!, publicKeyDerBase64: replacementKey }];
      await expect(verifyEvidenceReceipt(payload.evidenceReceipt, changedTrust))
        .rejects.toMatchObject({ statusCode: 422, code: "INVALID_EVIDENCE_RECEIPT" });
      expect((await fixture.inspector.query<{ publicKey: string }>(
        'SELECT public_key_der_base64 AS "publicKey" FROM sensors WHERE sensor_id = $1',
        [archive.sensor.sensorId])).rows[0]?.publicKey).toBe(replacementKey);
      expect(await archive.snapshot()).toEqual(archive.rows);
      expect((await fixture.inspector.query<{ body: Assessment }>(
        "SELECT body FROM assessments WHERE assessment_id = $1", [payload.assessment.assessmentId])).rows[0]?.body)
        .toEqual(payload.assessment);
    } finally {
      saving.mockRestore();
      lookup.mockRestore();
    }
  });

  it.each(["table", "body column"] as const)("fails readiness when the receipt %s is unavailable and recovers after restoration", async kind => {
    await expect(store.checkReadiness()).resolves.toBeUndefined();
    const hide = kind === "table"
      ? "ALTER TABLE assessment_evidence RENAME TO receipt_readiness_hidden"
      : "ALTER TABLE assessment_evidence RENAME COLUMN body TO receipt_readiness_hidden";
    const restore = kind === "table"
      ? "ALTER TABLE receipt_readiness_hidden RENAME TO assessment_evidence"
      : "ALTER TABLE assessment_evidence RENAME COLUMN receipt_readiness_hidden TO body";
    await fixture.inspector.query(hide);
    try { await expect(store.checkReadiness()).rejects.toBeDefined(); }
    finally { await fixture.inspector.query(restore); }
    await expect(store.checkReadiness()).resolves.toBeUndefined();
  });

  it("rolls back a new assessment when the receipt insert fails and accepts the same run after repair", async () => {
    const archive = await createSignedArchive(false, true);
    const candidate = packetFor(archive);
    const previous = { ...candidate.assessment, assessmentId: id(33_001),
      generatedAt: "2026-10-17T12:00:00.000Z" };
    await store.saveAssessment(previous);
    const originals = structuredClone(await archive.snapshot());
    await fixture.inspector.query(`CREATE FUNCTION reject_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'private synthetic receipt insert failure'; END; $$`);
    await fixture.inspector.query(`CREATE TRIGGER reject_test_receipt BEFORE INSERT ON assessment_evidence
      FOR EACH ROW EXECUTE FUNCTION reject_test_receipt()`);
    try {
      const rejected = await archive.run();
      expect(rejected.statusCode).toBe(500);
      expect(rejected.json()).toEqual({ error: "INTERNAL_ERROR" });
      expect((await fixture.inspector.query("SELECT assessment_id, body FROM assessments")).rows)
        .toEqual([{ assessment_id: previous.assessmentId, body: previous }]);
      expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessment_evidence")).rows)
        .toEqual([{ count: 0 }]);
      expect(await store.latestAssessment(previous.regionId, previous.metric)).toEqual(previous);
      expect(await store.getEvidenceReceipt(packetId(candidate))).toBeUndefined();
      expect(await archive.snapshot()).toEqual(originals);
    } finally {
      await fixture.inspector.query("DROP TRIGGER reject_test_receipt ON assessment_evidence");
      await fixture.inspector.query("DROP FUNCTION reject_test_receipt()");
    }
    const recovered = await archive.run();
    expect(recovered.statusCode).toBe(201);
    expect(recovered.json().evidenceReceiptId).toBe(packetId(candidate));
    expect(recovered.json().assessment).toEqual(candidate.assessment);
    expect(await store.getEvidenceReceipt(packetId(candidate))).toEqual(candidate);
    expect(await store.latestAssessment(previous.regionId, previous.metric)).toEqual(candidate.assessment);
    expect(await archive.snapshot()).toEqual(originals);
  });

  it("stores one immutable receipt for sixteen identical concurrent writes through two pools", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const expected = structuredClone(receipt);
    const otherStore = fixture.createStore();
    const ids = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      (index % 2 === 0 ? store : otherStore).saveAssessmentWithReceipt(structuredClone(receipt))));
    expect(new Set(ids)).toEqual(new Set([packetId(expected)]));
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessments")).rows)
      .toEqual([{ count: 1 }]);
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessment_evidence")).rows)
      .toEqual([{ count: 1 }]);
    const retrieved = await otherStore.getEvidenceReceipt(packetId(expected));
    expect(retrieved).toEqual(expected);
    retrieved!.observations[0]!.observation.value = 999;
    retrieved!.sensors[0]!.publicKeyDerBase64 = "YQ==";
    expect(await store.getEvidenceReceipt(packetId(expected))).toEqual(expected);
    expect(await archive.snapshot()).toEqual(archive.rows);
  });

  it("preserves concurrent receipt idempotence when both clients inherit a serializable transaction default", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const first = fixture.createStore({ serializableDefault: true });
    const second = fixture.createStore({ serializableDefault: true });
    // An externally configured isolation default must not turn identical
    // concurrent saves into serialization errors or require automatic retries.
    const ids = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      (index % 2 === 0 ? first : second).saveAssessmentWithReceipt(structuredClone(receipt))));
    expect(ids).toEqual(Array.from({ length: 16 }, () => packetId(receipt)));
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessments")).rows)
      .toEqual([{ count: 1 }]);
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessment_evidence")).rows)
      .toEqual([{ count: 1 }]);
    expect(await first.getEvidenceReceipt(packetId(receipt))).toEqual(receipt);
    expect(await second.getEvidenceReceipt(packetId(receipt))).toEqual(receipt);
    expect(await archive.snapshot()).toEqual(archive.rows);
  });

  it("keeps distinct signed receipt variants for the same assessment without overwriting either", async () => {
    const archive = await createSignedArchive(false, true);
    const original = packetFor(archive);
    const replacement = generateKeyPairSync("ed25519");
    const variant = structuredClone(original);
    const replacementPrivate = replacement.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    variant.sensors[0]!.publicKeyDerBase64 = replacement.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    for (const row of variant.observations) {
      const { signature: _signature, ...unsigned } = row.observation;
      row.observation = signObservation(unsigned, replacementPrivate);
      expect(observationId(unsigned)).toBe(row.observationId);
    }
    expect(variant.assessment).toEqual(original.assessment);
    expect(packetId(variant)).not.toBe(packetId(original));
    // These synthetic packets deliberately differ in trust authority. Storage
    // must retain their identities; it does not select which authority to trust.
    const otherStore = fixture.createStore();
    const inputs = Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? original : variant);
    const ids = await Promise.all(inputs.map((receipt, index) =>
      (index % 3 === 0 ? otherStore : store).saveAssessmentWithReceipt(receipt)));
    expect(ids).toEqual(inputs.map(packetId));
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessments")).rows)
      .toEqual([{ count: 1 }]);
    const stored = await fixture.inspector.query<{ receipt_id: string; assessment_id: string; body: EvidenceReceipt }>(
      "SELECT receipt_id, assessment_id, body FROM assessment_evidence ORDER BY receipt_id");
    expect(stored.rows).toEqual([original, variant]
      .map(body => ({ receipt_id: packetId(body), assessment_id: body.assessment.assessmentId, body }))
      .sort((left, right) => left.receipt_id.localeCompare(right.receipt_id)));
    expect(await otherStore.getEvidenceReceipt(packetId(original))).toEqual(original);
    expect(await store.getEvidenceReceipt(packetId(variant))).toEqual(variant);
    expect(await archive.snapshot()).toEqual(archive.rows);
    await expect(verifyEvidenceReceipt(variant, original.sensors)).rejects.toMatchObject({ code: "INVALID_EVIDENCE_RECEIPT" });
    await expect(verifyEvidenceReceipt(variant, variant.sensors)).resolves.toEqual(original.assessment);
  });

  it("snapshots receipt inputs before the first database await and attaches an exact legacy assessment idempotently", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const expected = structuredClone(receipt);
    await store.saveAssessment(receipt.assessment);
    const saving = store.saveAssessmentWithReceipt(receipt);
    receipt.observations[0]!.observation.value = 999;
    receipt.evidenceCore.observationIds.reverse();
    receipt.sensors[0]!.publicKeyDerBase64 = "YQ==";
    receipt.assessment.forecastValue = 999;
    await expect(saving).resolves.toBe(packetId(expected));
    expect(await store.getEvidenceReceipt(packetId(expected))).toEqual(expected);
    expect(await store.latestAssessment(expected.assessment.regionId, expected.assessment.metric)).toEqual(expected.assessment);
    await expect(store.saveAssessmentWithReceipt(expected)).resolves.toBe(packetId(expected));
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessments")).rows)
      .toEqual([{ count: 1 }]);
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessment_evidence")).rows)
      .toEqual([{ count: 1 }]);
  });

  it("rejects an assessment identity conflict before associating any receipt or changing historical content", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const incompatible = { ...receipt.assessment, forecastValue: receipt.assessment.forecastValue + 1 };
    await store.saveAssessment(incompatible);
    await expect(store.saveAssessmentWithReceipt(receipt)).rejects.toMatchObject({ statusCode: 409,
      code: "ASSESSMENT_CONFLICT", message: "assessment identity conflict" });
    expect(await store.getEvidenceReceipt(packetId(receipt))).toBeUndefined();
    expect((await fixture.inspector.query("SELECT assessment_id, body FROM assessments")).rows)
      .toEqual([{ assessment_id: incompatible.assessmentId, body: incompatible }]);
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessment_evidence")).rows)
      .toEqual([{ count: 0 }]);
    expect(await archive.snapshot()).toEqual(archive.rows);
  });

  it("retrieves the original receipt after reopening application and pool despite archive and live key changes", async () => {
    const archive = await createSignedArchive(false, true);
    const trusted = [{ sensorId: archive.sensor.sensorId, regionId: archive.sensor.regionId,
      publicKeyDerBase64: archive.publicKey }];
    const run = await archive.run();
    expect(run.statusCode).toBe(201);
    const result = run.json<{ evidenceReceiptId: string; assessment: Assessment; evidenceReceipt: EvidenceReceipt }>();
    expect(result.evidenceReceiptId).toBe(packetId(result.evidenceReceipt));
    const differentKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    await fixture.inspector.query("UPDATE sensors SET public_key_der_base64 = $1, active = false WHERE sensor_id = $2",
      [differentKey, archive.sensor.sensorId]);
    await fixture.inspector.query("UPDATE observations SET body = jsonb_set(body, '{value}', '999'::jsonb)");
    await fixture.closeStore(store); // Closes the first app and its pool, but preserves this fixture's schema.
    store = fixture.createStore();
    const reopened = buildApp({ store, policySource, adminToken: "synthetic-admin", oracleToken: "synthetic-oracle" });
    fixture.useStoreOwner(store, () => reopened.close());
    const lookup = vi.spyOn(store, "getSensor").mockRejectedValue(new Error("live-key lookup must not replace historical proof"));
    try {
      const retrieved = await reopened.inject({ method: "GET", url: `/v1/evidence-receipts/${result.evidenceReceiptId}`,
        headers: { "x-oracle-token": "synthetic-oracle" } });
      expect(retrieved.statusCode).toBe(200);
      expect(retrieved.headers["cache-control"]).toBe("no-store");
      expect(retrieved.json()).toEqual(result.evidenceReceipt);
      expect(retrieved.json().observations).toEqual(archive.rows);
      expect(lookup).not.toHaveBeenCalled();
      await expect(verifyEvidenceReceipt(retrieved.json(), trusted)).resolves.toEqual(result.assessment);
      expect((await fixture.inspector.query<{ body: StoredObservation["observation"] }>(
        "SELECT body FROM observations LIMIT 1")).rows[0]?.body.value).toBe(999);
    } finally { lookup.mockRestore(); }
  });

  it("returns missing receipt for legacy assessments without inventing an export from the current window", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    await store.saveAssessment(receipt.assessment);
    const response = await archive.app.inject({ method: "GET", url: `/v1/evidence-receipts/${packetId(receipt)}`,
      headers: { "x-oracle-token": "synthetic-oracle" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "EVIDENCE_RECEIPT_NOT_FOUND", message: "evidence receipt not found" });
    expect(await store.latestAssessment(receipt.assessment.regionId, receipt.assessment.metric)).toEqual(receipt.assessment);
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessment_evidence")).rows)
      .toEqual([{ count: 0 }]);
  });

  it("rejects a changed stored receipt body instead of returning it under its original content ID", async () => {
    const archive = await createSignedArchive(false, true);
    const run = await archive.run();
    expect(run.statusCode).toBe(201);
    const result = run.json<{ evidenceReceiptId: string; assessment: Assessment; evidenceReceipt: EvidenceReceipt }>();
    const changed = structuredClone(result.evidenceReceipt);
    changed.observations[0]!.observation.value += 1;
    await fixture.inspector.query("UPDATE assessment_evidence SET body = $1 WHERE receipt_id = $2",
      [changed, result.evidenceReceiptId]);
    const retrieved = await archive.app.inject({ method: "GET", url: `/v1/evidence-receipts/${result.evidenceReceiptId}`,
      headers: { "x-oracle-token": "synthetic-oracle" } });
    expect(retrieved.statusCode).toBe(500);
    expect(retrieved.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(await store.latestAssessment(result.assessment.regionId, result.assessment.metric)).toEqual(result.assessment);
    expect(await archive.snapshot()).toEqual(archive.rows);
    expect((await fixture.inspector.query<{ body: EvidenceReceipt }>(
      "SELECT body FROM assessment_evidence WHERE receipt_id = $1", [result.evidenceReceiptId])).rows[0]?.body)
      .toEqual(changed); // A rejected read does not silently repair the test alteration.
  });

  it("applies the receipt catalogue index migration idempotently without changing signed data or claiming a timing benchmark", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    await store.saveAssessmentWithReceipt(receipt);
    const before = {
      observations: await archive.snapshot(),
      assessments: (await fixture.inspector.query("SELECT assessment_id, body FROM assessments")).rows,
      evidence: (await fixture.inspector.query("SELECT receipt_id, assessment_id, body FROM assessment_evidence")).rows
    };
    await fixture.inspector.query(fixture.catalogMigration);
    await fixture.inspector.query(fixture.catalogMigration);
    const indexes = await fixture.inspector.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_catalog.pg_indexes
       WHERE schemaname = $1 AND tablename = 'assessment_evidence'`, [fixture.schema]);
    expect(indexes.rows.filter(({ indexdef }) =>
      indexdef.includes('USING btree (assessment_id, receipt_id COLLATE "C")'))).toHaveLength(1);
    expect({
      observations: await archive.snapshot(),
      assessments: (await fixture.inspector.query("SELECT assessment_id, body FROM assessments")).rows,
      evidence: (await fixture.inspector.query("SELECT receipt_id, assessment_id, body FROM assessment_evidence")).rows
    }).toEqual(before);
  });

  it("matches memory receipt page traversal in C order with bounded pages, partitions and idempotent duplicates", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const packets = permutedPackets(receipt, 8);
    const otherAssessment = packetFor(archive, 7_200);
    const memory = new MemoryObservationStore();
    try {
      for (const packet of [otherAssessment, ...packets].reverse()) {
        await store.saveAssessmentWithReceipt(packet);
        await memory.saveAssessmentWithReceipt(packet);
        await store.saveAssessmentWithReceipt(structuredClone(packet));
      }
      const expectedIds = packets.map(packetId).sort();
      const collected: string[] = [];
      let after: string | undefined;
      for (let offset = 0; offset < expectedIds.length; offset += 3) {
        const page = await store.listEvidenceReceipts(receipt.assessment.assessmentId, 3, after);
        expect(page).toEqual(await memory.listEvidenceReceipts(receipt.assessment.assessmentId, 3, after));
        const ids = expectedIds.slice(offset, offset + 3);
        expect(page).toEqual({ assessmentId: receipt.assessment.assessmentId, receiptIds: ids,
          ...(offset + 3 < expectedIds.length ? { nextAfter: ids.at(-1) } : {}) });
        collected.push(...page.receiptIds);
        after = page.nextAfter;
      }
      expect(collected).toEqual(expectedIds);
      expect(new Set(collected).size).toBe(expectedIds.length);
      expect(after).toBeUndefined();
      expect(await store.listEvidenceReceipts(otherAssessment.assessment.assessmentId, 100))
        .toEqual({ assessmentId: otherAssessment.assessment.assessmentId, receiptIds: [packetId(otherAssessment)] });
      // A cursor is a strict ID bound, not a reference that must exist in storage.
      expect(expectedIds).not.toContain(id(0));
      expect(await store.listEvidenceReceipts(receipt.assessment.assessmentId, 3, id(0)))
        .toEqual({ assessmentId: receipt.assessment.assessmentId, receiptIds: expectedIds.slice(0, 3),
          nextAfter: expectedIds[2] });
      expect(await store.listEvidenceReceipts(receipt.assessment.assessmentId, 3, `0x${"f".repeat(64)}`))
        .toEqual({ assessmentId: receipt.assessment.assessmentId, receiptIds: [] });
      expect(await archive.snapshot()).toEqual(archive.rows);
      for (const packet of packets) {
        await expect(verifyEvidenceReceipt(packet, receipt.sensors)).resolves.toEqual(receipt.assessment);
      }
    } finally { await memory.close(); }
  });

  it("rejects invalid direct receipt page requests with the explicit bounded-page domain error", async () => {
    const invalid: [string, number, string | undefined][] = [
      ["not-a-hash", 20, undefined], [id(1).toUpperCase(), 20, undefined],
      [id(1), 0, undefined], [id(1), -1, undefined], [id(1), 101, undefined],
      [id(1), 1.5, undefined], [id(1), Number.NaN, undefined], [id(1), Number.POSITIVE_INFINITY, undefined],
      [id(1), "20" as unknown as number, undefined],
      [id(1), 20, ""], [id(1), 20, "not-a-cursor"], [id(1), 20, id(2).toUpperCase()],
      [id(1), 20, null as unknown as string]
    ];
    for (const [assessmentId, limit, after] of invalid) {
      await expect(store.listEvidenceReceipts(assessmentId, limit, after)).rejects.toMatchObject({
        statusCode: 400, code: "INVALID_RECEIPT_PAGE", message: "invalid receipt page request"
      });
    }
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessment_evidence")).rows)
      .toEqual([{ count: 0 }]);
  });

  it("uses a live strict cursor bound when receipts arrive before and after the previous page", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const ordered = permutedPackets(receipt, 12).sort((left, right) =>
      packetId(left) < packetId(right) ? -1 : packetId(left) > packetId(right) ? 1 : 0);
    const memory = new MemoryObservationStore();
    try {
      for (const index of [1, 5, 9]) {
        await store.saveAssessmentWithReceipt(ordered[index]!);
        await memory.saveAssessmentWithReceipt(ordered[index]!);
      }
      const first = await store.listEvidenceReceipts(receipt.assessment.assessmentId, 1);
      expect(first).toEqual({ assessmentId: receipt.assessment.assessmentId,
        receiptIds: [packetId(ordered[1]!)], nextAfter: packetId(ordered[1]!) });
      for (const index of [0, 3]) {
        await store.saveAssessmentWithReceipt(ordered[index]!);
        await memory.saveAssessmentWithReceipt(ordered[index]!);
      }
      const second = await store.listEvidenceReceipts(receipt.assessment.assessmentId, 10, first.nextAfter);
      expect(second).toEqual(await memory.listEvidenceReceipts(receipt.assessment.assessmentId, 10, first.nextAfter));
      expect(second).toEqual({ assessmentId: receipt.assessment.assessmentId,
        receiptIds: [3, 5, 9].map(index => packetId(ordered[index]!)) });
      // Newly inserted IDs above the bound can appear; an insertion below it is
      // omitted from this continuation. Pagination does not promise a snapshot.
      expect(second.receiptIds).not.toContain(packetId(ordered[0]!));
      expect(await store.listEvidenceReceipts(receipt.assessment.assessmentId, 100))
        .toEqual({ assessmentId: receipt.assessment.assessmentId,
          receiptIds: [0, 1, 3, 5, 9].map(index => packetId(ordered[index]!)) });
      expect(new Set([...first.receiptIds, ...second.receiptIds]).size).toBe(4);
    } finally { await memory.close(); }
  });

  it("discovers receipt IDs from a known assessment after reopening and then verifies the separately retrieved packet", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const trusted = structuredClone(receipt.sensors);
    const packets = permutedPackets(receipt, 21);
    for (const packet of packets) await store.saveAssessmentWithReceipt(packet);
    const expectedIds = packets.map(packetId).sort();
    await fixture.inspector.query("UPDATE sensors SET public_key_der_base64 = 'YQ==', active = false");
    await fixture.inspector.query("UPDATE observations SET body = jsonb_set(body, '{value}', '999'::jsonb)");
    await fixture.closeStore(store);
    store = fixture.createStore();
    const reopened = buildApp({ store, policySource, adminToken: "synthetic-admin", oracleToken: "synthetic-oracle" });
    fixture.useStoreOwner(store, () => reopened.close());
    const keyLookup = vi.spyOn(store, "getSensor").mockRejectedValue(new Error("catalogue must not read live keys"));
    const windowLookup = vi.spyOn(store, "listObservations").mockRejectedValue(new Error("catalogue must not rebuild the window"));
    const packetLookup = vi.spyOn(store, "getEvidenceReceipt");
    try {
      const url = `/v1/assessments/${receipt.assessment.assessmentId}/evidence-receipts`;
      const unauthorized = await reopened.inject({ method: "GET", url });
      expect(unauthorized.statusCode).toBe(401);
      const first = await reopened.inject({ method: "GET", url,
        headers: { "x-oracle-token": "synthetic-oracle" } });
      expect(first.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.json()).toEqual({ assessmentId: receipt.assessment.assessmentId,
        receiptIds: expectedIds.slice(0, 20), nextAfter: expectedIds[19] });
      const next = await reopened.inject({ method: "GET", url: `${url}?limit=20&after=${first.json().nextAfter}`,
        headers: { "x-oracle-token": "synthetic-oracle" } });
      expect(next.statusCode).toBe(200);
      expect(next.json()).toEqual({ assessmentId: receipt.assessment.assessmentId, receiptIds: expectedIds.slice(20) });
      const invalidLimit = await reopened.inject({ method: "GET", url: `${url}?limit=101`,
        headers: { "x-oracle-token": "synthetic-oracle" } });
      expect(invalidLimit.statusCode).toBe(400);
      expect(packetLookup).not.toHaveBeenCalled();
      const discoveredId = first.json<{ receiptIds: string[] }>().receiptIds[0]!;
      const actual = await reopened.inject({ method: "GET", url: `/v1/evidence-receipts/${discoveredId}`,
        headers: { "x-oracle-token": "synthetic-oracle" } });
      expect(actual.statusCode).toBe(200);
      expect(packetId(actual.json<EvidenceReceipt>())).toBe(discoveredId);
      await expect(verifyEvidenceReceipt(actual.json(), trusted)).resolves.toEqual(receipt.assessment);
      expect(packetLookup).toHaveBeenCalledExactlyOnceWith(discoveredId);
      expect(keyLookup).not.toHaveBeenCalled();
      expect(windowLookup).not.toHaveBeenCalled();
    } finally {
      keyLookup.mockRestore(); windowLookup.mockRestore(); packetLookup.mockRestore();
    }
  });

  it("lists metadata IDs without reading a corrupted packet while exact packet retrieval still rejects it", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const receiptId = await store.saveAssessmentWithReceipt(receipt);
    await fixture.inspector.query("UPDATE assessment_evidence SET body = '{}'::jsonb WHERE receipt_id = $1", [receiptId]);
    const readOnly = fixture.createStore({ readOnly: true });
    expect(await readOnly.listEvidenceReceipts(receipt.assessment.assessmentId, 20))
      .toEqual({ assessmentId: receipt.assessment.assessmentId, receiptIds: [receiptId] });
    const catalogue = await archive.app.inject({ method: "GET",
      url: `/v1/assessments/${receipt.assessment.assessmentId}/evidence-receipts`,
      headers: { "x-oracle-token": "synthetic-oracle" } });
    expect(catalogue.statusCode).toBe(200);
    expect(catalogue.json()).toEqual({ assessmentId: receipt.assessment.assessmentId, receiptIds: [receiptId] });
    const packet = await archive.app.inject({ method: "GET", url: `/v1/evidence-receipts/${receiptId}`,
      headers: { "x-oracle-token": "synthetic-oracle" } });
    expect(packet.statusCode).toBe(500);
    expect(packet.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect((await fixture.inspector.query("SELECT body FROM assessment_evidence WHERE receipt_id = $1", [receiptId])).rows)
      .toEqual([{ body: {} }]);
  });

  it("returns empty catalogues for unknown and legacy assessments without manufacturing historical receipts", async () => {
    const legacy = assessment(44_001);
    await store.saveAssessment(legacy);
    for (const assessmentId of [legacy.assessmentId, id(44_002)]) {
      expect(await store.listEvidenceReceipts(assessmentId, 100))
        .toEqual({ assessmentId, receiptIds: [] });
    }
    const app = buildApp({ store, policySource, adminToken: "synthetic-admin", oracleToken: "synthetic-oracle" });
    fixture.useStoreOwner(store, () => app.close());
    const response = await app.inject({ method: "GET", url: `/v1/assessments/${legacy.assessmentId}/evidence-receipts`,
      headers: { "x-oracle-token": "synthetic-oracle" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ assessmentId: legacy.assessmentId, receiptIds: [] });
    expect((await fixture.inspector.query("SELECT count(*)::integer AS count FROM assessment_evidence")).rows)
      .toEqual([{ count: 0 }]);
    expect(await store.latestAssessment(legacy.regionId, legacy.metric)).toEqual(legacy);
  });

  it("lets an evidence reader discover and verify an exact signed receipt after application restart through a read-only PostgreSQL client", async () => {
    const archive = await createSignedArchive(false, true);
    const trusted = [{ sensorId: archive.sensor.sensorId, regionId: archive.sensor.regionId,
      publicKeyDerBase64: archive.publicKey }];
    const run = await archive.run();
    expect(run.statusCode).toBe(201);
    const result = run.json<{ evidenceReceiptId: string; assessment: Assessment; evidenceReceipt: EvidenceReceipt }>();
    const snapshot = async () => ({
      sensors: (await fixture.inspector.query("SELECT * FROM sensors ORDER BY sensor_id")).rows,
      observations: await archive.snapshot(),
      assessments: (await fixture.inspector.query("SELECT * FROM assessments ORDER BY assessment_id")).rows,
      receipts: (await fixture.inspector.query("SELECT * FROM assessment_evidence ORDER BY receipt_id")).rows
    });
    const before = await snapshot();
    await fixture.closeStore(store);
    store = fixture.createStore({ readOnly: true });
    const readerToken = "synthetic-evidence-reader-2026-10-21-read-only";
    const reopened = buildApp({ store, policySource, adminToken: "synthetic-admin", oracleToken: "synthetic-oracle",
      evidenceReadToken: readerToken });
    fixture.useStoreOwner(store, () => reopened.close());
    const keyLookup = vi.spyOn(store, "getSensor").mockRejectedValue(new Error("reader must not use live keys"));
    const windowLookup = vi.spyOn(store, "listObservations").mockRejectedValue(new Error("reader must not reconstruct a window"));
    try {
      const catalogue = await reopened.inject({ method: "GET",
        url: `/v1/assessments/${result.assessment.assessmentId}/evidence-receipts`,
        headers: { "x-evidence-token": readerToken } });
      expect(catalogue.statusCode).toBe(200);
      expect(catalogue.headers["cache-control"]).toBe("no-store");
      expect(catalogue.json()).toEqual({ assessmentId: result.assessment.assessmentId,
        receiptIds: [result.evidenceReceiptId] });
      const discoveredId = catalogue.json<{ receiptIds: string[] }>().receiptIds[0]!;
      const proof = await reopened.inject({ method: "GET", url: `/v1/evidence-receipts/${discoveredId}`,
        headers: { "x-evidence-token": readerToken } });
      expect(proof.statusCode).toBe(200);
      expect(proof.headers["cache-control"]).toBe("no-store");
      expect(proof.json()).toEqual(result.evidenceReceipt);
      expect(proof.json().observations).toEqual(archive.rows);
      expect(packetId(proof.json<EvidenceReceipt>())).toBe(result.evidenceReceiptId);
      await expect(verifyEvidenceReceipt(proof.json(), trusted)).resolves.toEqual(result.assessment);
      const legacyOracleRead = await reopened.inject({ method: "GET", url: `/v1/evidence-receipts/${discoveredId}`,
        headers: { "x-oracle-token": "synthetic-oracle" } });
      expect(legacyOracleRead.statusCode).toBe(200);
      expect(legacyOracleRead.json()).toEqual(result.evidenceReceipt);
      expect(canonicalJson(proof.json())).not.toContain(readerToken);
      expect(keyLookup).not.toHaveBeenCalled();
      expect(windowLookup).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    } finally { keyLookup.mockRestore(); windowLookup.mockRestore(); }
  });

  it("rejects reader credentials on assessment and sensor writes before any side effects on a writable database", async () => {
    const archive = await createSignedArchive(false, true);
    const receipt = packetFor(archive);
    const receiptId = await store.saveAssessmentWithReceipt(receipt);
    const snapshot = async () => ({
      sensors: (await fixture.inspector.query("SELECT * FROM sensors ORDER BY sensor_id")).rows,
      observations: await archive.snapshot(),
      assessments: (await fixture.inspector.query("SELECT * FROM assessments ORDER BY assessment_id")).rows,
      receipts: (await fixture.inspector.query("SELECT * FROM assessment_evidence ORDER BY receipt_id")).rows
    });
    const before = await snapshot();
    await fixture.closeStore(store);
    store = fixture.createStore(); // Writable: passing cannot be attributed to DB write denial.
    const readerToken = "synthetic-evidence-reader-2026-10-21-no-writer";
    const app = buildApp({ store, policySource, adminToken: "synthetic-admin", oracleToken: "synthetic-oracle",
      evidenceReadToken: readerToken });
    fixture.useStoreOwner(store, () => app.close());
    const saving = vi.spyOn(store, "saveAssessmentWithReceipt");
    const registering = vi.spyOn(store, "registerSensor");
    const readingWindow = vi.spyOn(store, "listObservations");
    try {
      const assessmentPayload = { regionId: archive.sensor.regionId, metric: "water.oxygen.mg_l",
        forecastHorizonHours: 1, requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC" };
      for (const headers of [{ "x-evidence-token": readerToken }, { "x-oracle-token": readerToken }]) {
        const rejected = await app.inject({ method: "POST", url: "/v1/assessments/run", headers,
          payload: assessmentPayload });
        expect(rejected.statusCode).toBe(401);
        expect(rejected.json()).toEqual({ error: "UNAUTHORIZED", message: "invalid oracle token" });
      }
      for (const headers of [{ "x-evidence-token": readerToken }, { "x-admin-token": readerToken }]) {
        const rejected = await app.inject({ method: "POST", url: "/v1/sensors", headers,
          payload: { ...archive.sensor, sensorId: "synthetic-reader-write-attempt" } });
        expect(rejected.statusCode).toBe(401);
        expect(rejected.json()).toEqual({ error: "UNAUTHORIZED", message: "invalid administrator token" });
      }
      expect(saving).not.toHaveBeenCalled();
      expect(registering).not.toHaveBeenCalled();
      expect(readingWindow).not.toHaveBeenCalled();
      const catalogue = await app.inject({ method: "GET",
        url: `/v1/assessments/${receipt.assessment.assessmentId}/evidence-receipts`,
        headers: { "x-evidence-token": readerToken } });
      expect(catalogue.statusCode).toBe(200);
      expect(catalogue.json()).toEqual({ assessmentId: receipt.assessment.assessmentId, receiptIds: [receiptId] });
      const proof = await app.inject({ method: "GET", url: `/v1/evidence-receipts/${receiptId}`,
        headers: { "x-evidence-token": readerToken } });
      expect(proof.statusCode).toBe(200);
      expect(proof.json()).toEqual(receipt);
      expect(await snapshot()).toEqual(before);
    } finally { saving.mockRestore(); registering.mockRestore(); readingWindow.mockRestore(); }
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
