import { generateKeyPairSync } from "node:crypto";

import {
  canonicalJson, observationId, signObservation, verifyObservation,
  type UnsignedObservation
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

const now = new Date("2026-10-18T12:00:00.000Z");
const regionId = "IT-PO-DELTA";
const metric = "water.oxygen.mg_l";
const sensorIds = ["synthetic-archive-sensor-0", "synthetic-archive-sensor-1"];
const policySource = `
policy "archive-integrity-test" version 1 {
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
const input = { regionId, metric, forecastHorizonHours: 1,
  requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC" };
const invalidEvidenceBody = { error: "INVALID_ARCHIVED_EVIDENCE", message: "archived observation evidence is invalid" };
const keys = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64")
  };
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
};

async function fixture(options: { historicInactive?: boolean } = {}) {
  const credentials = new Map(sensorIds.map(sensorId => [sensorId, keys()]));
  const store = new MemoryObservationStore();
  for (const sensorId of sensorIds) await store.registerSensor({ sensorId, regionId,
    publicKeyDerBase64: credentials.get(sensorId)!.publicKey, label: "Synthetic archived evidence" });
  const makeEntry = (index: number, overrides: Partial<UnsignedObservation> = {}): StoredObservation => {
    const unsigned: UnsignedObservation = { sensorId: sensorIds[index % 2]!, regionId, metric,
      value: [8, 7, 6.5, 6.25, 6][index]!, unit: "mg/L", sequence: index + 1,
      observedAt: new Date(now.getTime() - (4 - index) * 3_600_000 -
        (options.historicInactive === true ? 60 * 24 * 3_600_000 : 0)).toISOString(), ...overrides };
    return { observationId: observationId(unsigned),
      observation: signObservation(unsigned, credentials.get(unsigned.sensorId)!.privateKey) };
  };
  let rows = Array.from({ length: 5 }, (_value, index) => makeEntry(index));
  for (const row of rows) await store.addObservation(row);
  const storedRows = store.listObservations.bind(store);
  const list = vi.spyOn(store, "listObservations").mockResolvedValue(rows);
  const lookupOriginal = store.getSensor.bind(store);
  const lookup = vi.spyOn(store, "getSensor").mockImplementation(async sensorId => {
    const sensor = await lookupOriginal(sensorId);
    return sensor === undefined ? undefined : { ...sensor,
      active: options.historicInactive === true ? false : sensor.active };
  });
  const save = vi.spyOn(store, "saveAssessment");
  const app = buildApp({ store, policySource, adminToken: "synthetic-archive-admin",
    oracleToken: "synthetic-archive-oracle", now: () => now });
  const run = () => app.inject({ method: "POST", url: "/v1/assessments/run",
    headers: { "x-oracle-token": "synthetic-archive-oracle" }, payload: input });
  return { app, store, credentials, lookupOriginal, lookup, list, save, makeEntry, run, storedRows,
    get rows() { return rows; },
    setRows(replacement: StoredObservation[]) { rows = replacement; list.mockResolvedValue(rows); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function expectRejected(f: Fixture): Promise<void> {
  const rawBefore = canonicalJson(f.rows);
  const persistedBefore = await f.storedRows(regionId, metric, 512);
  const response = await f.run();
  expect(response.statusCode).toBe(422);
  expect(response.json()).toEqual(invalidEvidenceBody);
  expect(response.json()).not.toHaveProperty("assessment");
  expect(response.json()).not.toHaveProperty("decision");
  expect(response.json()).not.toHaveProperty("actionDraft");
  expect(f.save).not.toHaveBeenCalled();
  expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
  expect(await f.store.latestAssessment(regionId, metric)).toBeUndefined();
  expect(canonicalJson(f.rows)).toBe(rawBefore);
  expect(await f.storedRows(regionId, metric, 512)).toEqual(persistedBefore);
}

beforeEach(() => vi.clearAllMocks());

describe("assessment admission verifies archived signed evidence before analysis or policy", () => {
  it("preserves the exact previous assessment for valid signed archived payloads without rewriting them", async () => {
    const f = await fixture();
    try {
      const original = structuredClone(f.rows);
      const expected = analyzeObservations(original, 3_600);
      const result = await f.run();
      expect(result.statusCode).toBe(201);
      expect(result.json().assessment).toEqual(expected);
      expect(f.rows).toEqual(original);
      expect(canonicalJson(f.rows)).toBe(canonicalJson(original));
      for (const row of f.rows) {
        const { signature: _signature, ...unsigned } = row.observation;
        expect(observationId(unsigned)).toBe(row.observationId);
        expect(verifyObservation(row.observation, f.credentials.get(row.observation.sensorId)!.publicKey)).toBe(true);
      }
      expect(f.save).toHaveBeenCalledExactlyOnceWith(expected);
      expect(vi.mocked(evaluatePolicy)).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });

  it("rejects a false observation ID independently of a still-valid signature", async () => {
    const f = await fixture();
    try {
      const row = f.rows[0]!;
      expect(verifyObservation(row.observation, f.credentials.get(row.observation.sensorId)!.publicKey)).toBe(true);
      row.observationId = `0x${"f".repeat(64)}`;
      await expectRejected(f);
    } finally { await f.app.close(); }
  });

  it("rejects a false signature even when the ID is recalculated from the altered raw payload", async () => {
    const f = await fixture();
    try {
      const row = f.rows[0]!;
      row.observation.value += 0.125;
      const { signature: _signature, ...unsigned } = row.observation;
      row.observationId = observationId(unsigned);
      expect(verifyObservation(row.observation, f.credentials.get(row.observation.sensorId)!.publicKey)).toBe(false);
      await expectRejected(f);
    } finally { await f.app.close(); }
  });

  it.each(["signed-body", "stored-wrapper"] as const)("requires a strict archive schema for unknown %s fields", async kind => {
    const f = await fixture();
    try {
      const target = kind === "signed-body" ? f.rows[0]!.observation : f.rows[0]!;
      Object.assign(target, { untrustedArchiveExtension: "private-untrusted-marker" });
      await expectRejected(f);
    } finally { await f.app.close(); }
  });

  it.each(["region", "metric"] as const)("rejects validly signed %s routing that disagrees with the assessment request", async kind => {
    const f = await fixture();
    try {
      const otherRegion = "OTHER-REGION";
      f.setRows(f.rows.map((_row, index) => f.makeEntry(index, kind === "region"
        ? { regionId: otherRegion } : { metric: "air.pm25.ug_m3", unit: "ug/m3" })));
      if (kind === "region") f.lookup.mockImplementation(async sensorId => {
        const registered = await f.lookupOriginal(sensorId);
        return registered === undefined ? undefined : { ...registered, regionId: otherRegion };
      });
      for (const row of f.rows) expect(verifyObservation(row.observation,
        f.credentials.get(row.observation.sensorId)!.publicKey)).toBe(true);
      await expectRejected(f);
    } finally { await f.app.close(); }
  });

  it.each(["missing", "discordant-ID", "discordant-region", "invalid-DER"] as const)(
    "rejects an archive whose sensor registry is %s", async kind => {
      const f = await fixture();
      try {
        f.lookup.mockImplementation(async sensorId => {
          const registered = await f.lookupOriginal(sensorId);
          if (registered === undefined || kind === "missing") return undefined;
          if (kind === "discordant-ID") return { ...registered, sensorId: "different-registry-sensor" };
          if (kind === "discordant-region") return { ...registered, regionId: "OTHER-REGION" };
          return { ...registered, publicKeyDerBase64: Buffer.from("invalid DER private marker").toString("base64") };
        });
        await expectRejected(f);
      } finally { await f.app.close(); }
    });

  it("uses the current registered public key rather than accepting a signature from an unrelated old key", async () => {
    const f = await fixture();
    try {
      const unrelatedKey = keys();
      f.lookup.mockImplementation(async sensorId => {
        const registered = await f.lookupOriginal(sensorId);
        return registered === undefined ? undefined : { ...registered, publicKeyDerBase64: unrelatedKey.publicKey };
      });
      await expectRejected(f);
    } finally { await f.app.close(); }
  });

  it.each(["observation-ID", "sensor-sequence"] as const)("rejects duplicate %s evidence before counting it twice", async kind => {
    const f = await fixture();
    try {
      if (kind === "observation-ID") f.rows[4] = structuredClone(f.rows[0]!);
      else {
        f.rows[4] = f.makeEntry(4, { sensorId: f.rows[0]!.observation.sensorId,
          sequence: f.rows[0]!.observation.sequence, value: 5.5 });
        expect(f.rows[4]!.observationId).not.toBe(f.rows[0]!.observationId);
      }
      await expectRejected(f);
    } finally { await f.app.close(); }
  });

  it("keeps a failed database key lookup as a private generic 500 rather than mislabelling archive corruption", async () => {
    const f = await fixture();
    try {
      f.lookup.mockRejectedValue(new Error("private SQL postgresql://private-user:private-password@private-host/db"));
      const result = await f.run();
      expect(result.statusCode).toBe(500);
      expect(result.json()).toEqual({ error: "INTERNAL_ERROR" });
      expect(result.body).not.toContain("private");
      expect(f.save).not.toHaveBeenCalled();
      expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
      expect(await f.store.latestAssessment(regionId, metric)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("looks up each distinct sensor once per run and does not cache registry results across runs", async () => {
    const f = await fixture();
    try {
      expect((await f.run()).statusCode).toBe(201);
      expect(f.lookup).toHaveBeenCalledTimes(sensorIds.length);
      for (const sensorId of sensorIds) expect(f.lookup.mock.calls.filter(([id]) => id === sensorId)).toHaveLength(1);
      f.lookup.mockClear();
      f.save.mockClear();
      vi.mocked(evaluatePolicy).mockClear();
      f.lookup.mockResolvedValue(undefined);
      const before = await f.store.latestAssessment(regionId, metric);
      const result = await f.run();
      expect(result.statusCode).toBe(422);
      expect(result.json()).toEqual(invalidEvidenceBody);
      expect(f.lookup).toHaveBeenCalledTimes(1);
      expect(f.save).not.toHaveBeenCalled();
      expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
      expect(await f.store.latestAssessment(regionId, metric)).toEqual(before);
    } finally { await f.app.close(); }
  });

  it("snapshots every archived row before the first asynchronous sensor lookup", async () => {
    const f = await fixture();
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    try {
      const original = structuredClone(f.rows);
      const expected = analyzeObservations(original, 3_600);
      let first = true;
      f.lookup.mockImplementation(async sensorId => {
        if (first) {
          first = false;
          lookupStarted.resolve();
          await releaseLookup.promise;
        }
        return f.lookupOriginal(sensorId);
      });
      const pending = f.run();
      const firstEvent = await Promise.race([
        lookupStarted.promise.then(() => "lookup"), pending.then(() => "response-before-lookup")
      ]);
      expect(firstEvent).toBe("lookup");
      // Change a row that has not been looked up yet, its nested payload, and
      // the original array. A shallow copy or lazy per-row clone is insufficient.
      f.rows[1]!.observation.value = 999;
      f.rows[4]!.observation.unit = "%";
      f.rows.splice(2, 1);
      f.rows.reverse();
      releaseLookup.resolve();
      const result = await pending;
      expect(result.statusCode).toBe(201);
      expect(result.json().assessment).toEqual(expected);
      expect(await f.storedRows(regionId, metric, 512)).toEqual(original);
    } finally { releaseLookup.resolve(); await f.app.close(); }
  });

  it("keeps authentic old evidence valid after sensor deactivation while refusing new submissions", async () => {
    const f = await fixture({ historicInactive: true });
    try {
      const original = structuredClone(f.rows);
      const expected = analyzeObservations(original, 3_600);
      const result = await f.run();
      expect(result.statusCode).toBe(201);
      expect(result.json().assessment).toEqual(expected);
      const newSubmission = await f.app.inject({ method: "POST", url: "/v1/observations", payload: f.rows[0]!.observation });
      expect(newSubmission.statusCode).toBe(403);
      expect(newSubmission.json().error).toBe("SENSOR_INACTIVE");
      expect(f.rows).toEqual(original);
      expect(await f.storedRows(regionId, metric, 512)).toEqual(original);
    } finally { await f.app.close(); }
  });
});
