import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import {
  observationId, signObservation, verifyObservation,
  type Assessment, type SignedObservation
} from "../packages/protocol/src/index.js";
import { analyzeObservations } from "../services/oracle/src/analysis.js";
import { buildApp } from "../services/oracle/src/app.js";
import { PostgresObservationStore } from "../services/oracle/src/postgres-store.js";
import type { StoredObservation } from "../services/oracle/src/store.js";

// This process owns one application and one store for both database interruptions.
// It never restarts itself and never retries a write automatically.
const databaseUrl = process.env.VIRDACORA_RECOVERY_DATABASE_URL;
if (databaseUrl === undefined || process.send === undefined) {
  console.error("The PostgreSQL recovery worker requires its isolated IPC runner");
  process.exit(1);
}
const now = new Date("2026-10-18T12:00:00.000Z");
const regionId = "IT-PO-DELTA";
const metric = "water.oxygen.mg_l";
const sensorId = "synthetic-recovery-sensor";
const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const store = new PostgresObservationStore(databaseUrl);
const app = buildApp({ store,
  policySource: await readFile(new URL("../policies/po-water-v1.terra", import.meta.url), "utf8"),
  adminToken: "synthetic-recovery-admin", oracleToken: "synthetic-recovery-oracle", now: () => now });
let expected: StoredObservation[] = [];
let expectedAssessment: Assessment | undefined;
let nextSequence = 8;
let pending: SignedObservation | undefined;
let closed = false;

function signed(sequence: number, observedAt: string): SignedObservation {
  return signObservation({ sensorId, regionId, metric, value: 6 + sequence / 100,
    unit: "mg/L", observedAt, sequence }, privateKey);
}
function asEntry(observation: SignedObservation): StoredObservation {
  const { signature: _signature, ...unsigned } = observation;
  return { observationId: observationId(unsigned), observation };
}
async function runAssessment(): Promise<Assessment> {
  const response = await app.inject({ method: "POST", url: "/v1/assessments/run",
    headers: { "x-oracle-token": "synthetic-recovery-oracle" }, payload: {
      regionId, metric, forecastHorizonHours: 1, requestedAction: "EXTRA_SAMPLING",
      requestedAmount: 0, asset: "USDC"
    } });
  assert.equal(response.statusCode, 201);
  const assessment = response.json<{ assessment: Assessment }>().assessment;
  assert.deepEqual(assessment, analyzeObservations(await store.listObservations(regionId, metric, 512), 3_600));
  return assessment;
}
async function verifySnapshot(): Promise<void> {
  const rows = await store.listObservations(regionId, metric, 512);
  const sortedExpected = [...expected].sort((left, right) =>
    Date.parse(left.observation.observedAt) - Date.parse(right.observation.observedAt) ||
    (left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0));
  assert.deepEqual(rows, sortedExpected);
  for (const row of rows) {
    assert.equal(verifyObservation(row.observation, publicKey), true);
    assert.equal(asEntry(row.observation).observationId, row.observationId);
  }
  assert.deepEqual(await store.getSensor(sensorId), {
    sensorId, regionId, publicKeyDerBase64: publicKey, label: "Synthetic recovery test", active: true
  });
  assert.deepEqual(await store.latestAssessment(regionId, metric), expectedAssessment);
  assert.deepEqual(analyzeObservations(rows, 3_600), expectedAssessment);
  const latest = await app.inject({ method: "GET",
    url: `/v1/regions/${regionId}/metrics/${metric}/latest` });
  assert.equal(latest.statusCode, 200);
  assert.deepEqual(latest.json(), expectedAssessment);
}
async function readReadiness(): Promise<200 | 503> {
  const readiness = await app.inject({ method: "GET", url: "/readyz" });
  assert(readiness.statusCode === 200 || readiness.statusCode === 503);
  assert.equal(readiness.headers["cache-control"], "no-store");
  // An exact small body also guards against leaking SQL, schema, connection
  // metadata, error messages or the temporary credentials through readiness.
  assert.deepEqual(readiness.json(), { status: readiness.statusCode === 200 ? "ready" : "not_ready" });
  return readiness.statusCode;
}
async function verifyReadiness(statusCode: 200 | 503): Promise<void> {
  assert.equal(await readReadiness(), statusCode);
}
async function command(name: string): Promise<Record<string, unknown>> {
  if (name === "before-fault") {
    await verifyReadiness(200);
    return { processId: process.pid, readinessBefore: 200, readinessCacheControlNoStore: true };
  }
  if (name === "seed") {
    assert.equal(expected.length, 0);
    await verifyReadiness(200);
    const registration = await app.inject({ method: "POST", url: "/v1/sensors",
      headers: { "x-admin-token": "synthetic-recovery-admin" }, payload: {
        sensorId, regionId, publicKeyDerBase64: publicKey, label: "Synthetic recovery test"
      } });
    assert.equal(registration.statusCode, 201);
    const times = ["2026-10-18T07:00:00.000Z", "2026-10-18T08:00:00.000Z",
      "2026-10-18T09:00:00.000Z", "2026-10-18T10:00:00.1239999Z",
      "2026-10-18T10:00:00.1231000Z", "2026-10-18T11:00:00.000Z",
      "2026-10-18T11:30:00.000Z"];
    for (const [index, timestamp] of times.entries()) {
      const observation = signed(index + 1, timestamp);
      const response = await app.inject({ method: "POST", url: "/v1/observations", payload: observation });
      assert.equal(response.statusCode, 202);
      assert.equal(response.json().observationId, asEntry(observation).observationId);
      expected.push(asEntry(observation));
    }
    expectedAssessment = await runAssessment();
    await verifySnapshot();
    return { processId: process.pid, observations: expected.length,
      evidenceHash: expectedAssessment.evidenceHash, signedSnapshotsVerified: true, readinessBefore: 200 };
  }
  if (name === "while-down") {
    assert.equal(pending, undefined);
    const observedAt = new Date(now.getTime() - (10 - nextSequence) * 60_000)
      .toISOString().replace(".000Z", ".1239999Z");
    pending = signed(nextSequence, observedAt);
    const started = performance.now();
    const response = await app.inject({ method: "POST", url: "/v1/observations", payload: pending });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: "INTERNAL_ERROR" });
    const writeDurationMs = Math.round(performance.now() - started);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    // Keep this after the failed POST. In the locked-table scenario the first
    // server statement timeout must still belong to the real observation INSERT.
    await verifyReadiness(503);
    return { processId: process.pid, unavailableResponse: { statusCode: 500, body: response.json() },
      durationMsDiagnosticOnly: Math.round(performance.now() - started),
      writeDurationMsDiagnosticOnly: writeDurationMs,
      livenessStatus: 200, readinessDuring: 503, readinessBodyGeneric: true,
      readinessCacheControlNoStore: true,
      livenessIsNotDatabaseReadiness: true, pendingSequence: nextSequence };
  }
  if (name === "after-recovery") {
    const deadline = performance.now() + 45_000;
    let recovered = false;
    while (performance.now() < deadline) {
      // A preceding HTTP deadline may finish just before its shared probe
      // settles. Observe readiness recovery through the public endpoint itself.
      recovered = await readReadiness() === 200;
      if (recovered) break;
      await delay(250);
    }
    assert.equal(recovered, true, "The existing store did not reconnect within the diagnostic bound");
    assert.equal((await store.getSensor(sensorId))?.sensorId, sensorId);
    await verifyReadiness(200);
    await verifySnapshot();
    assert.notEqual(pending, undefined);
    const observation = pending!;
    const accepted = await app.inject({ method: "POST", url: "/v1/observations", payload: observation });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().observationId, asEntry(observation).observationId);
    expected.push(asEntry(observation));
    const replay = await app.inject({ method: "POST", url: "/v1/observations", payload: observation });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error, "OBSERVATION_REPLAY");
    const tampered = await app.inject({ method: "POST", url: "/v1/observations",
      payload: { ...observation, sequence: nextSequence + 1, value: 99 } });
    assert.equal(tampered.statusCode, 401);
    assert.equal(tampered.json().error, "INVALID_SIGNATURE");
    nextSequence += 1;
    pending = undefined;
    expectedAssessment = await runAssessment();
    await verifySnapshot();
    return { processId: process.pid, observations: expected.length,
      evidenceHash: expectedAssessment.evidenceHash, priorAcknowledgedRecordsUnchanged: true,
      signedSnapshotsVerified: true, newWriteStatus: 202, replayStatus: 409, tamperStatus: 401,
      readinessAfter: 200, readinessCacheControlNoStore: true };
  }
  if (name === "close") {
    await app.close();
    closed = true;
    return { processId: process.pid, closed: true };
  }
  throw new Error("Unknown recovery worker command");
}

let queue: Promise<void> = Promise.resolve();
process.on("message", (message: unknown) => {
  const request = message as { id?: unknown; command?: unknown };
  if (!Number.isSafeInteger(request?.id) || typeof request.command !== "string") return;
  queue = queue.then(async () => {
    try {
      const result = await command(request.command as string);
      process.send?.({ id: request.id, ok: true, result });
    } catch {
      // Assertion messages and database errors may include internal connection metadata.
      process.send?.({ id: request.id, ok: false, failure: "WORKER_ASSERTION_FAILED" });
    }
    if (closed) process.disconnect();
  });
});
process.on("disconnect", () => {
  if (!closed) void app.close().finally(() => process.exit(1));
});
process.send({ type: "ready", processId: process.pid });
