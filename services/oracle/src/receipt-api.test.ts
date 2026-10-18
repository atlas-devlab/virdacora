import { generateKeyPairSync } from "node:crypto";

import {
  canonicalJson, observationId, sha256Hex, signObservation, verifyObservation,
  type Assessment
} from "@terravoce/protocol";
import { evaluatePolicy } from "@terravoce/terralex";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeObservations } from "./analysis.js";
import { buildApp } from "./app.js";
import { MemoryObservationStore, type StoredObservation } from "./store.js";

vi.mock("@terravoce/terralex", async importOriginal => {
  const actual = await importOriginal<typeof import("@terravoce/terralex")>();
  return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

const regionId = "IT-PO-DELTA";
const metric = "water.oxygen.mg_l";
const now = new Date("2026-10-18T12:00:00.000Z");
const sensorIds = ["synthetic-receipt-sensor-0", "synthetic-receipt-sensor-1"];
const adminToken = "synthetic-receipt-admin-private-marker";
const oracleToken = "synthetic-receipt-oracle-private-marker";
const policySource = `
policy "receipt-api-test" version 1 {
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
const keys = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64")
  };
};
const ordered = (rows: StoredObservation[]) => [...rows].sort((left, right) =>
  Date.parse(left.observation.observedAt) - Date.parse(right.observation.observedAt) ||
  (left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0));
const coreFor = (assessment: Assessment, rows: StoredObservation[]) => ({
  modelVersion: assessment.modelVersion, regionId: assessment.regionId, metric: assessment.metric,
  generatedAt: ordered(rows).at(-1)!.observation.observedAt,
  observationIds: ordered(rows).map(row => row.observationId),
  forecastHorizonSeconds: assessment.forecastHorizonSeconds,
  currentValue: assessment.currentValue, forecastValue: assessment.forecastValue,
  slopePerHour: assessment.slopePerHour, anomalyScore: assessment.anomalyScore,
  confidence: assessment.confidence, risk: assessment.risk
});
interface Receipt {
  formatVersion: string;
  assessment: Assessment;
  evidenceCore: ReturnType<typeof coreFor>;
  observations: StoredObservation[];
  sensors: { sensorId: string; regionId: string; publicKeyDerBase64: string }[];
}
async function fixture() {
  const credentials = new Map(sensorIds.map(sensorId => [sensorId, keys()]));
  const registeredKeys = new Map(sensorIds.map(sensorId => [sensorId, credentials.get(sensorId)!.publicKey]));
  const store = new MemoryObservationStore();
  for (const sensorId of sensorIds) await store.registerSensor({ sensorId, regionId,
    publicKeyDerBase64: credentials.get(sensorId)!.publicKey, label: "private-label-not-in-receipt" });
  const times = ["2026-10-18T07:00:00.000Z", "2026-10-18T08:00:00.000Z",
    "2026-10-18T09:00:00.1239Z", "2026-10-18T09:00:00.1231Z",
    "2026-10-18T10:00:00.000Z", "2026-10-18T11:00:00.000Z"];
  const units = ["mg/L", "ug/L", "\u00b5g/L", "mg/L", "\u03bcg/L", "ug/L"];
  const values = [8, 7.5, 7, 6.8, 6.4, 6];
  const rows = times.map((observedAt, index): StoredObservation => {
    const sensorId = sensorIds[index % sensorIds.length]!;
    const unit = units[index]!;
    const unsigned = { sensorId, regionId, metric, unit, observedAt, sequence: index + 1,
      value: values[index]! * (unit === "mg/L" ? 1 : 1_000) };
    return { observationId: observationId(unsigned),
      observation: signObservation(unsigned, credentials.get(sensorId)!.privateKey) };
  });
  // Deliberately different arrival order, including a millisecond timestamp tie.
  for (const index of [5, 2, 0, 4, 1, 3]) await store.addObservation(rows[index]!);
  const getSensor = store.getSensor.bind(store);
  const lookup = vi.spyOn(store, "getSensor").mockImplementation(async sensorId => {
    const registered = await getSensor(sensorId);
    return registered === undefined ? undefined : { ...registered, publicKeyDerBase64: registeredKeys.get(sensorId)! };
  });
  const saveOriginal = store.saveAssessment.bind(store);
  const save = vi.spyOn(store, "saveAssessment");
  const app = buildApp({ store, policySource, adminToken, oracleToken, now: () => now });
  const run = () => app.inject({ method: "POST", url: "/v1/assessments/run",
    headers: { "x-oracle-token": oracleToken }, payload: { regionId, metric,
      forecastHorizonHours: 1, requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC" } });
  return { app, store, rows, credentials, registeredKeys, lookup, saveOriginal, save, run };
}

beforeEach(() => vi.clearAllMocks());

describe("assessment API returns a portable receipt without changing persisted assessments", () => {
  it("includes exact signed evidence, captured public keys and the unchanged domain-separated core", async () => {
    const f = await fixture();
    try {
      const before = structuredClone(f.rows);
      const expected = analyzeObservations(before, 3_600);
      const result = await f.run();
      expect(result.statusCode).toBe(201);
      const output = result.json<{ assessment: Assessment; evidenceReceipt?: Receipt }>();
      expect(output.evidenceReceipt).toBeDefined();
      const receipt = output.evidenceReceipt!;
      expect(Object.keys(receipt).sort()).toEqual(["assessment", "evidenceCore", "formatVersion", "observations", "sensors"]);
      expect(receipt.formatVersion).toBe("virdacora-evidence-receipt-v1");
      expect(receipt.assessment).toEqual(output.assessment);
      expect(output.assessment).toEqual(expected);
      expect(receipt.evidenceCore).toEqual(coreFor(expected, before));
      expect(receipt.evidenceCore.observationIds).toEqual(ordered(before).map(row => row.observationId));
      expect(sha256Hex(`evidence:${canonicalJson(receipt.evidenceCore)}`)).toBe(expected.evidenceHash);
      expect(sha256Hex(`assessment:${canonicalJson(receipt.evidenceCore)}`)).toBe(expected.assessmentId);
      expect(expected.evidenceHash).not.toBe(expected.assessmentId);
      expect(receipt.observations).toEqual(ordered(before));
      expect(receipt.observations.at(-1)!.observation).toMatchObject({ unit: "ug/L", value: 6_000 });
      expect(receipt.assessment.currentValue).toBe(6);
      expect(receipt.sensors).toHaveLength(sensorIds.length);
      for (const sensor of receipt.sensors) {
        expect(Object.keys(sensor).sort()).toEqual(["publicKeyDerBase64", "regionId", "sensorId"]);
        expect(sensor).toEqual({ sensorId: sensor.sensorId, regionId,
          publicKeyDerBase64: f.credentials.get(sensor.sensorId)!.publicKey });
      }
      for (const row of receipt.observations) {
        const { signature: _signature, ...unsigned } = row.observation;
        expect(observationId(unsigned)).toBe(row.observationId);
        expect(verifyObservation(row.observation,
          receipt.sensors.find(sensor => sensor.sensorId === row.observation.sensorId)!.publicKeyDerBase64)).toBe(true);
      }
      const encoded = canonicalJson(receipt);
      for (const privateValue of [adminToken, oracleToken, "private-label-not-in-receipt",
        ...[...f.credentials.values()].map(pair => pair.privateKey)]) expect(encoded).not.toContain(privateValue);
      expect(f.lookup).toHaveBeenCalledTimes(sensorIds.length);
      for (const sensorId of sensorIds) expect(f.lookup.mock.calls.filter(([id]) => id === sensorId)).toHaveLength(1);
      expect(f.save).toHaveBeenCalledExactlyOnceWith(expected);
      const persisted = await f.store.latestAssessment(regionId, metric);
      expect(persisted).toEqual(expected);
      expect(persisted).not.toHaveProperty("evidenceReceipt");
      expect(persisted).not.toHaveProperty("observations");
      expect(persisted).not.toHaveProperty("sensors");
      const latest = await f.app.inject({ method: "GET", url: `/v1/regions/${regionId}/metrics/${metric}/latest` });
      expect(latest.statusCode).toBe(200);
      expect(latest.json()).toEqual(expected);
      expect(await f.store.listObservations(regionId, metric, 512)).toEqual(ordered(before));
      expect(f.rows).toEqual(before);
      expect(canonicalJson(f.rows)).toBe(canonicalJson(before));
    } finally { await f.app.close(); }
  });

  it("uses the keys captured by admission even if the registry changes while saving the assessment", async () => {
    const f = await fixture();
    try {
      const captured = new Map(f.registeredKeys);
      const replacement = keys();
      f.save.mockImplementation(async assessment => {
        await f.saveOriginal(assessment);
        for (const sensorId of sensorIds) f.registeredKeys.set(sensorId, replacement.publicKey);
      });
      const result = await f.run();
      expect(result.statusCode).toBe(201);
      const output = result.json<{ assessment: Assessment; evidenceReceipt?: Receipt }>();
      expect(output.evidenceReceipt).toBeDefined();
      const receipt = output.evidenceReceipt!;
      expect(f.lookup).toHaveBeenCalledTimes(sensorIds.length);
      for (const sensorId of sensorIds) {
        expect(f.registeredKeys.get(sensorId)).toBe(replacement.publicKey);
        expect(receipt.sensors.find(sensor => sensor.sensorId === sensorId)?.publicKeyDerBase64).toBe(captured.get(sensorId));
      }
      for (const row of receipt.observations) {
        expect(verifyObservation(row.observation,
          receipt.sensors.find(sensor => sensor.sensorId === row.observation.sensorId)!.publicKeyDerBase64)).toBe(true);
        expect(verifyObservation(row.observation, replacement.publicKey)).toBe(false);
      }
      expect(receipt.assessment).toEqual(output.assessment);
      expect(await f.store.latestAssessment(regionId, metric)).toEqual(output.assessment);
    } finally { await f.app.close(); }
  });

  it("never emits a receipt or evaluates policy when archived evidence fails admission", async () => {
    const f = await fixture();
    try {
      const original = structuredClone(await f.store.listObservations(regionId, metric, 512));
      const altered = structuredClone(original);
      altered[0]!.observation.value += 0.125;
      const { signature: _signature, ...unsigned } = altered[0]!.observation;
      altered[0]!.observationId = observationId(unsigned);
      vi.spyOn(f.store, "listObservations").mockResolvedValue(altered);
      const result = await f.run();
      expect(result.statusCode).toBe(422);
      expect(result.json()).toEqual({ error: "INVALID_ARCHIVED_EVIDENCE", message: "archived observation evidence is invalid" });
      expect(result.json()).not.toHaveProperty("evidenceReceipt");
      expect(result.json()).not.toHaveProperty("assessment");
      expect(result.json()).not.toHaveProperty("decision");
      expect(result.json()).not.toHaveProperty("actionDraft");
      expect(f.save).not.toHaveBeenCalled();
      expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
      expect(await f.store.latestAssessment(regionId, metric)).toBeUndefined();
      expect(f.rows).toEqual(original.sort((left, right) => left.observation.sequence - right.observation.sequence));
    } finally { await f.app.close(); }
  });
});
