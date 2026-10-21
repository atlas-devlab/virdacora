import { generateKeyPairSync } from "node:crypto";

import {
  canonicalJson, observationId, signObservation, verifyObservation,
  type Assessment
} from "@terravoce/protocol";
import { evaluatePolicy } from "@terravoce/terralex";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeObservations } from "./analysis.js";
import { buildApp } from "./app.js";
import { MemoryObservationStore, type StoredObservation } from "./store.js";

// Preserve the real policy evaluator while observing whether invalid evidence
// ever reaches it; successful API cases still execute the actual evaluator.
vi.mock("@terravoce/terralex", async importOriginal => {
  const actual = await importOriginal<typeof import("@terravoce/terralex")>();
  return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

const now = new Date("2026-10-18T12:00:00.000Z");
const sensorId = "synthetic-oxygen-unit-sensor";
const regionId = "IT-PO-DELTA";
const metric = "water.oxygen.mg_l";
const microUnits = ["ug/L", "\u00b5g/L", "\u03bcg/L"] as const;
// Nonconstant, nonlinear, with nonzero residuals and a nonzero latest anomaly.
// A flat series would miss accidental use of raw latest values in zScore.
const canonicalValues = [8, 7, 6.5, 6.25, 6];
const policySource = `
policy "oxygen-unit-verification" version 1 {
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

const makeKeys = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
};
type Keys = ReturnType<typeof makeKeys>;
const entryFor = (keys: Keys, index: number, unit: string, metricName = metric): StoredObservation => {
  const unsigned = { sensorId, regionId, metric: metricName,
    value: canonicalValues[index]! * (unit === "mg/L" ? 1 : 1_000), unit,
    observedAt: new Date(now.getTime() - (4 - index) * 3_600_000).toISOString(), sequence: index + 1 };
  return { observationId: observationId(unsigned), observation: signObservation(unsigned, keys.privateKey) };
};
const series = (keys: Keys, units: string[]): StoredObservation[] =>
  canonicalValues.map((_value, index) => entryFor(keys, index, units[index]!));
const snapshot = (rows: StoredObservation[]) => ({
  rawPayloads: rows.map(row => ({ ...row.observation })),
  canonicalPayloads: rows.map(row => canonicalJson(row.observation)),
  ids: rows.map(row => row.observationId),
  signatures: rows.map(row => row.observation.signature)
});
function verifyOriginalEvidence(rows: StoredObservation[], keys: Keys): void {
  for (const row of rows) {
    expect(verifyObservation(row.observation, keys.publicKey)).toBe(true);
    const { signature: _signature, ...unsigned } = row.observation;
    expect(observationId(unsigned)).toBe(row.observationId);
  }
}
const numericalResult = (assessment: Assessment) => ({
  currentValue: assessment.currentValue, forecastValue: assessment.forecastValue,
  slopePerHour: assessment.slopePerHour, anomalyScore: assessment.anomalyScore,
  confidence: assessment.confidence, risk: assessment.risk
});
const assessmentRequest = {
  regionId, metric, forecastHorizonHours: 1, requestedAction: "WATER_AERATION",
  requestedAmount: 0, asset: "USDC"
};
const createApi = async (keys: Keys) => {
  const store = new MemoryObservationStore();
  const app = buildApp({ store, policySource, adminToken: "synthetic-unit-admin",
    oracleToken: "synthetic-unit-oracle", now: () => now });
  const registration = await app.inject({ method: "POST", url: "/v1/sensors",
    headers: { "x-admin-token": "synthetic-unit-admin" }, payload: {
      sensorId, regionId, publicKeyDerBase64: keys.publicKey, label: "Synthetic unit verification"
    } });
  expect(registration.statusCode).toBe(201);
  return { store, app };
};

beforeEach(() => vi.clearAllMocks());

describe("oxygen analysis uses canonical mg/L while preserving signed raw evidence", () => {
  it.each(microUnits)("normalizes an all-%s nonlinear series, including its latest 6000 value", unit => {
    const keys = makeKeys();
    const control = series(keys, Array(5).fill("mg/L"));
    const micro = series(keys, Array(5).fill(unit));
    const before = snapshot(micro);
    const expected = analyzeObservations(control, 3_600);
    const actual = analyzeObservations(micro, 3_600);

    expect(expected.currentValue).toBe(6);
    expect(expected.slopePerHour).not.toBe(0);
    expect(expected.anomalyScore).toBeGreaterThan(0);
    expect(numericalResult(actual)).toEqual(numericalResult(expected));
    expect(actual.evidenceHash).not.toBe(expected.evidenceHash);
    expect(actual.assessmentId).not.toBe(expected.assessmentId);
    expect(snapshot(micro)).toEqual(before);
    verifyOriginalEvidence(micro, keys);
  });

  it.each(microUnits)("normalizes mixed mg/L and %s without using raw latest values in anomaly or confidence", unit => {
    const keys = makeKeys();
    const control = series(keys, Array(5).fill("mg/L"));
    const mixed = series(keys, ["mg/L", unit, "mg/L", unit, unit]);
    const before = snapshot(mixed);
    expect(mixed.at(-1)!.observation.value).toBe(6_000);
    const expected = analyzeObservations(control, 3_600);
    const actual = analyzeObservations(mixed, 3_600);
    expect(numericalResult(actual)).toEqual(numericalResult(expected));
    expect(actual.evidenceHash).not.toBe(expected.evidenceHash);
    expect(snapshot(mixed)).toEqual(before);
    verifyOriginalEvidence(mixed, keys);
  });

  it("keeps the same evidence hash for permutations of the same mixed signed payloads", () => {
    const keys = makeKeys();
    const rows = series(keys, ["mg/L", "ug/L", "\u00b5g/L", "mg/L", "\u03bcg/L"]);
    const before = snapshot(rows);
    for (const row of rows) { Object.freeze(row.observation); Object.freeze(row); }
    const expected = analyzeObservations(rows, 3_600);
    for (const permutation of [[...rows].reverse(), [rows[2]!, rows[4]!, rows[0]!, rows[3]!, rows[1]!]]) {
      expect(analyzeObservations(permutation, 3_600)).toEqual(expected);
    }
    expect(snapshot(rows)).toEqual(before);
    verifyOriginalEvidence(rows, keys);
  });

  it("rejects unsupported legacy oxygen units instead of silently mixing dimensions", () => {
    const keys = makeKeys();
    const rows = series(keys, ["mg/L", "mg/L", "%", "mg/L", "mg/L"]);
    const before = snapshot(rows);
    expect(() => analyzeObservations(rows, 3_600)).toThrowError(
      expect.objectContaining({ statusCode: 422, code: "INVALID_OBSERVATION_UNIT" }));
    expect(snapshot(rows)).toEqual(before);
    verifyOriginalEvidence(rows, keys);
  });

  it("does not apply the oxygen conversion to another metric", () => {
    const keys = makeKeys();
    const rows = canonicalValues.map((_value, index) => entryFor(keys, index, "ug/m3", "air.pm25.ug_m3"));
    const assessment = analyzeObservations(rows, 3_600);
    expect(assessment.currentValue).toBe(6_000);
    expect(assessment.modelVersion).toBe("terravoce-linear-risk-v1");
  });
});

describe("oxygen unit validation through the signed Memory API", () => {
  it.each(microUnits)("stores raw mixed %s evidence but returns the canonical one-hour assessment", async unit => {
    const keys = makeKeys();
    const { app, store } = await createApi(keys);
    try {
      const rows = series(keys, ["mg/L", unit, "mg/L", unit, unit]);
      const before = snapshot(rows);
      const expected = analyzeObservations(series(keys, Array(5).fill("mg/L")), 3_600);
      for (const row of rows) {
        const accepted = await app.inject({ method: "POST", url: "/v1/observations", payload: row.observation });
        expect(accepted.statusCode).toBe(202);
        expect(accepted.json().observationId).toBe(row.observationId);
      }
      expect(snapshot(await store.listObservations(regionId, metric, 512))).toEqual(before);
      const result = await app.inject({ method: "POST", url: "/v1/assessments/run",
        headers: { "x-oracle-token": "synthetic-unit-oracle" }, payload: assessmentRequest });
      expect(result.statusCode).toBe(201);
      const actual = result.json<{ assessment: Assessment }>().assessment;
      expect(numericalResult(actual)).toEqual(numericalResult(expected));
      expect(actual.evidenceHash).not.toBe(expected.evidenceHash);
      expect(actual.evidenceHash).toBe(analyzeObservations(rows, 3_600).evidenceHash);
      expect(vi.mocked(evaluatePolicy)).toHaveBeenCalledTimes(1);
      const storedAfter = await store.listObservations(regionId, metric, 512);
      expect(snapshot(storedAfter)).toEqual(before);
      expect(snapshot(rows)).toEqual(before);
      verifyOriginalEvidence(storedAfter, keys);
    } finally { await app.close(); }
  });

  it.each([
    { unit: "ug/L" }, { value: 6_000 }, { unit: "ug/L", value: 6_000 }, { unit: "%" }
  ])("requires a new signature after changing raw unit/value, case %#", async changes => {
    const keys = makeKeys();
    const { app, store } = await createApi(keys);
    try {
      const original = entryFor(keys, 4, "mg/L");
      const tampered = await app.inject({ method: "POST", url: "/v1/observations",
        payload: { ...original.observation, ...changes } });
      expect(tampered.statusCode).toBe(401);
      expect(tampered.json().error).toBe("INVALID_SIGNATURE");
      expect(await store.listObservations(regionId, metric, 512)).toEqual([]);
      const accepted = await app.inject({ method: "POST", url: "/v1/observations", payload: original.observation });
      expect(accepted.statusCode).toBe(202);
      expect(await store.listObservations(regionId, metric, 512)).toEqual([original]);
    } finally { await app.close(); }
  });

  it.each(["%", "mL/L", "g/L", "ppm", "mg/l", " mg/L", "mg/L "])("rejects a validly signed unsupported %s before storage and preserves its sequence", async unit => {
    const keys = makeKeys();
    const { app, store } = await createApi(keys);
    try {
      const unsupported = entryFor(keys, 4, unit);
      const rejected = await app.inject({ method: "POST", url: "/v1/observations", payload: unsupported.observation });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().error).toBe("INVALID_OBSERVATION_UNIT");
      expect(await store.listObservations(regionId, metric, 512)).toEqual([]);
      const corrected = entryFor(keys, 4, "mg/L");
      const accepted = await app.inject({ method: "POST", url: "/v1/observations", payload: corrected.observation });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json().observationId).toBe(corrected.observationId);
      expect(await store.listObservations(regionId, metric, 512)).toEqual([corrected]);
    } finally { await app.close(); }
  });

  it("fails closed on legacy unsupported oxygen evidence without saving an assessment or evaluating policy", async () => {
    const keys = makeKeys();
    const { app, store } = await createApi(keys);
    try {
      const legacy = series(keys, ["mg/L", "ug/L", "%", "mg/L", "\u03bcg/L"]);
      for (const row of legacy) await store.addObservation(row);
      const before = snapshot(await store.listObservations(regionId, metric, 512));
      const save = vi.spyOn(store, "saveAssessmentWithReceipt");
      const response = await app.inject({ method: "POST", url: "/v1/assessments/run",
        headers: { "x-oracle-token": "synthetic-unit-oracle" }, payload: assessmentRequest });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual(expect.objectContaining({ error: "INVALID_OBSERVATION_UNIT" }));
      expect(response.json()).not.toHaveProperty("assessment");
      expect(response.json()).not.toHaveProperty("decision");
      expect(response.json()).not.toHaveProperty("actionDraft");
      expect(save).not.toHaveBeenCalled();
      expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
      expect(await store.latestAssessment(regionId, metric)).toBeUndefined();
      const after = await store.listObservations(regionId, metric, 512);
      expect(snapshot(after)).toEqual(before);
      verifyOriginalEvidence(after, keys);
    } finally { await app.close(); }
  });

  it("produces the same illustrative critical decision for 2 mg/L and 2000 micrograms/L", async () => {
    const keys = makeKeys();
    const outputs: { assessment: Assessment; decision: unknown; actionDraft: { reversible: boolean } }[] = [];
    for (const unit of ["mg/L", "\u00b5g/L"]) {
      const { app } = await createApi(keys);
      try {
        for (let sequence = 1; sequence <= 12; sequence += 1) {
          const signed = signObservation({ sensorId, regionId, metric, unit,
            value: unit === "mg/L" ? 2 : 2_000, sequence,
            observedAt: new Date(now.getTime() - (12 - sequence) * 3_600_000).toISOString() }, keys.privateKey);
          expect((await app.inject({ method: "POST", url: "/v1/observations", payload: signed })).statusCode).toBe(202);
        }
        const result = await app.inject({ method: "POST", url: "/v1/assessments/run",
          headers: { "x-oracle-token": "synthetic-unit-oracle" }, payload: assessmentRequest });
        expect(result.statusCode).toBe(201);
        const output = result.json<typeof outputs[number]>();
        expect(output.assessment.currentValue).toBe(2);
        expect(output.assessment.risk).toBe(1);
        expect(output.decision).toMatchObject({ allowed: true });
        expect(output.actionDraft.reversible).toBe(true); // A draft only: no execution or funds.
        outputs.push(output);
      } finally { await app.close(); }
    }
    expect(numericalResult(outputs[1]!.assessment)).toEqual(numericalResult(outputs[0]!.assessment));
    expect(outputs[1]!.decision).toEqual(outputs[0]!.decision);
    expect(outputs[1]!.assessment.evidenceHash).not.toBe(outputs[0]!.assessment.evidenceHash);
  });

  it("serves the current oxygen version even when a preserved v1 ID wins the unfiltered timestamp tie", async () => {
    const keys = makeKeys();
    const { app, store } = await createApi(keys);
    try {
      const rows = series(keys, ["mg/L", "ug/L", "\u00b5g/L", "mg/L", "\u03bcg/L"]);
      for (const row of rows) await store.addObservation(row);
      const current = analyzeObservations(rows, 3_600);
      const legacy: Assessment = { ...current, modelVersion: "terravoce-linear-risk-v1",
        assessmentId: `0x${"f".repeat(64)}`, evidenceHash: `0x${"e".repeat(64)}`, currentValue: 6_000 };
      const before = structuredClone(legacy);
      await store.saveAssessment(legacy);
      const latestUrl = `/v1/regions/${regionId}/metrics/${metric}/latest`;
      expect((await app.inject({ method: "GET", url: latestUrl })).statusCode).toBe(404);
      const run = await app.inject({ method: "POST", url: "/v1/assessments/run",
        headers: { "x-oracle-token": "synthetic-unit-oracle" }, payload: assessmentRequest });
      expect(run.statusCode).toBe(201);
      expect(run.json().assessment).toEqual(current);
      const latest = await app.inject({ method: "GET", url: latestUrl });
      expect(latest.statusCode).toBe(200);
      expect(latest.json()).toEqual(current);
      expect(await store.latestAssessment(regionId, metric)).toEqual(before);
      expect(legacy).toEqual(before);
      expect(await store.listObservations(regionId, metric, 512)).toEqual(rows);
      verifyOriginalEvidence(rows, keys);
    } finally { await app.close(); }
  });
});
