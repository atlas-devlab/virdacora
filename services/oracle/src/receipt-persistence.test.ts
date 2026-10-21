import { generateKeyPairSync } from "node:crypto";

import { canonicalJson, observationId, sha256Hex, signObservation, type Assessment } from "@terravoce/protocol";
import { evaluatePolicy } from "@terravoce/terralex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeEvidence } from "./analysis.js";
import { buildApp } from "./app.js";
import { createEvidenceReceipt, type EvidenceReceipt } from "./evidence-receipt.js";
import { DomainError } from "./errors.js";
import { MemoryObservationStore, type StoredObservation } from "./store.js";

vi.mock("@terravoce/terralex", async importOriginal => {
  const actual = await importOriginal<typeof import("@terravoce/terralex")>();
  return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

const regionId = "IT-PO-DELTA";
const metric = "water.oxygen.mg_l";
const oracleToken = "synthetic-persistence-oracle";
const policySource = `
policy "receipt-persistence-test" version 1 {
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
const packetId = (receipt: EvidenceReceipt) => sha256Hex(`receipt:${canonicalJson(receipt)}`);
const keys = () => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
};

function synthetic() {
  const credentials = keys();
  const sensor = { sensorId: "synthetic-persistence-sensor", regionId,
    publicKeyDerBase64: credentials.publicKey };
  const rows: StoredObservation[] = Array.from({ length: 6 }, (_, index) => {
    const micro = index % 2 === 1;
    const unsigned = { sensorId: sensor.sensorId, regionId, metric,
      value: (8 - index * 0.4) * (micro ? 1_000 : 1), unit: micro ? "\u00b5g/L" : "mg/L",
      sequence: index + 1, observedAt: new Date(Date.UTC(2026, 9, 21, index + 4)).toISOString() };
    return { observationId: observationId(unsigned), observation: signObservation(unsigned, credentials.privateKey) };
  });
  const receipt = createEvidenceReceipt(analyzeEvidence(rows, 3_600), { observations: rows, sensors: [sensor] });
  return { credentials, sensor, rows, receipt };
}

const apps: ReturnType<typeof buildApp>[] = [];
async function fixture() {
  const data = synthetic();
  const store = new MemoryObservationStore();
  await store.registerSensor({ ...data.sensor, label: "Synthetic private sensor label" });
  for (const row of data.rows) await store.addObservation(row);
  const app = buildApp({ store, policySource, adminToken: "synthetic-persistence-admin", oracleToken,
    now: () => new Date("2026-10-21T12:00:00.000Z") });
  apps.push(app);
  const run = () => app.inject({ method: "POST", url: "/v1/assessments/run",
    headers: { "x-oracle-token": oracleToken }, payload: { regionId, metric, forecastHorizonHours: 1,
      requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC" } });
  return { ...data, store, app, run };
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
});

describe("immutable in-memory receipt storage", () => {
  it("snapshots the full packet before returning and isolates every nested read", async () => {
    const data = synthetic();
    const store = new MemoryObservationStore();
    const expected = structuredClone(data.receipt);
    const writing = store.saveAssessmentWithReceipt(data.receipt);
    data.receipt.observations[0]!.observation.value = 999;
    data.receipt.sensors[0]!.publicKeyDerBase64 = "private-mutated-key";
    data.receipt.evidenceCore.observationIds.reverse();
    data.receipt.assessment.forecastValue = 999;
    const id = await writing;
    expect(id).toBe(packetId(expected));
    const firstRead = await store.getEvidenceReceipt(id);
    expect(firstRead).toEqual(expected);
    firstRead!.observations[0]!.observation.value = 777;
    firstRead!.sensors[0]!.publicKeyDerBase64 = "private-read-mutation";
    firstRead!.evidenceCore.observationIds.reverse();
    firstRead!.assessment.currentValue = 777;
    expect(await store.getEvidenceReceipt(id)).toEqual(expected);
    expect(await store.latestAssessment(regionId, metric)).toEqual(expected.assessment);
    expect(await store.listObservations(regionId, metric, 512)).toEqual([]);
  });

  it("deduplicates an identical canonical packet without nesting receipt data inside the assessment", async () => {
    const { receipt } = synthetic();
    const store = new MemoryObservationStore();
    const id = await store.saveAssessmentWithReceipt(receipt);
    const reorderedKeys: EvidenceReceipt = { sensors: structuredClone(receipt.sensors),
      observations: structuredClone(receipt.observations), evidenceCore: structuredClone(receipt.evidenceCore),
      assessment: structuredClone(receipt.assessment), formatVersion: receipt.formatVersion };
    expect(await store.saveAssessmentWithReceipt(reorderedKeys)).toBe(id);
    expect(await store.getEvidenceReceipt(id)).toEqual(receipt);
    const assessment = await store.latestAssessment(regionId, metric);
    expect(assessment).toEqual(receipt.assessment);
    expect(assessment).not.toHaveProperty("evidenceReceipt");
    expect(assessment).not.toHaveProperty("evidenceReceiptId");
  });

  it("keeps coherently re-signed variants under distinct packet IDs without overwriting either", async () => {
    const { receipt } = synthetic();
    const alternate = structuredClone(receipt);
    const replacement = keys();
    alternate.sensors[0]!.publicKeyDerBase64 = replacement.publicKey;
    for (const row of alternate.observations) {
      const { signature: _signature, ...unsigned } = row.observation;
      row.observation = signObservation(unsigned, replacement.privateKey);
      expect(observationId(unsigned)).toBe(row.observationId);
    }
    const store = new MemoryObservationStore();
    const firstId = await store.saveAssessmentWithReceipt(receipt);
    const alternateId = await store.saveAssessmentWithReceipt(alternate);
    expect(alternateId).not.toBe(firstId);
    expect(alternate.assessment).toEqual(receipt.assessment);
    expect(await store.getEvidenceReceipt(firstId)).toEqual(receipt);
    expect(await store.getEvidenceReceipt(alternateId)).toEqual(alternate);
    expect(await store.latestAssessment(regionId, metric)).toEqual(receipt.assessment);
  });

  it("retains separately addressed packets whose raw arrival order differs", async () => {
    const { receipt } = synthetic();
    const reversed = structuredClone(receipt);
    reversed.observations.reverse();
    const store = new MemoryObservationStore();
    const firstId = await store.saveAssessmentWithReceipt(receipt);
    const reversedId = await store.saveAssessmentWithReceipt(reversed);
    expect(reversedId).not.toBe(firstId);
    expect(await store.getEvidenceReceipt(firstId)).toEqual(receipt);
    expect(await store.getEvidenceReceipt(reversedId)).toEqual(reversed);
  });

  it("can attach an exact receipt to a matching legacy assessment without inventing one beforehand", async () => {
    const { receipt } = synthetic();
    const store = new MemoryObservationStore();
    await store.saveAssessment(receipt.assessment);
    expect(await store.getEvidenceReceipt(packetId(receipt))).toBeUndefined();
    expect(await store.saveAssessmentWithReceipt(receipt)).toBe(packetId(receipt));
    expect(await store.getEvidenceReceipt(packetId(receipt))).toEqual(receipt);
    expect(await store.latestAssessment(regionId, metric)).toEqual(receipt.assessment);
  });

  it("rejects association with a different legacy body under the same assessment ID without partial publication", async () => {
    const { receipt } = synthetic();
    const store = new MemoryObservationStore();
    const legacy = { ...receipt.assessment, forecastValue: receipt.assessment.forecastValue + 1 };
    await store.saveAssessment(legacy);
    await expect(store.saveAssessmentWithReceipt(receipt)).rejects.toMatchObject({
      statusCode: 409, code: "ASSESSMENT_CONFLICT", message: "assessment identity conflict"
    });
    expect(await store.getEvidenceReceipt(packetId(receipt))).toBeUndefined();
    expect(await store.latestAssessment(regionId, metric)).toEqual(legacy);
  });

  it("linearizes concurrent identical and different packets while keeping the common assessment flat", async () => {
    const { receipt } = synthetic();
    const variant = structuredClone(receipt);
    variant.observations.reverse();
    const store = new MemoryObservationStore();
    const ids = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      store.saveAssessmentWithReceipt(index % 2 === 0 ? receipt : variant)));
    expect(new Set(ids)).toEqual(new Set([packetId(receipt), packetId(variant)]));
    expect(await store.getEvidenceReceipt(packetId(receipt))).toEqual(receipt);
    expect(await store.getEvidenceReceipt(packetId(variant))).toEqual(variant);
    expect(await store.latestAssessment(regionId, metric)).toEqual(receipt.assessment);
  });

  it("rejects malformed receipt input before reserving any assessment or packet identity", async () => {
    const { receipt } = synthetic();
    const invalid = structuredClone(receipt);
    invalid.assessment.generatedAt = "not-an-explicit-timestamp";
    const store = new MemoryObservationStore();
    await expect(store.saveAssessmentWithReceipt(invalid)).rejects.toBeDefined();
    expect(await store.latestAssessment(regionId, metric)).toBeUndefined();
    expect(await store.getEvidenceReceipt(packetId(invalid))).toBeUndefined();
    expect(await store.saveAssessmentWithReceipt(receipt)).toBe(packetId(receipt));
    expect(await store.getEvidenceReceipt(packetId(receipt))).toEqual(receipt);
  });
});

describe("evidence receipt persistence API", () => {
  it("returns the complete packet ID from a successful run", async () => {
    const f = await fixture();
    const atomic = vi.spyOn(f.store, "saveAssessmentWithReceipt");
    const legacy = vi.spyOn(f.store, "saveAssessment");
    const response = await f.run();
    expect(response.statusCode).toBe(201);
    const body = response.json<{ assessment: Assessment; evidenceReceipt: EvidenceReceipt; evidenceReceiptId?: string }>();
    expect(body.evidenceReceiptId).toBe(packetId(body.evidenceReceipt));
    expect(body.evidenceReceiptId).not.toBe(body.assessment.assessmentId);
    expect(body.evidenceReceiptId).not.toBe(body.assessment.evidenceHash);
    expect(atomic).toHaveBeenCalledExactlyOnceWith(body.evidenceReceipt);
    expect(legacy).not.toHaveBeenCalled();
    expect(await f.store.getEvidenceReceipt(body.evidenceReceiptId!)).toEqual(body.evidenceReceipt);
  });

  it("authenticates receipt retrieval before looking up a packet", async () => {
    const f = await fixture();
    const lookup = vi.spyOn(f.store, "getEvidenceReceipt");
    const response = await f.app.inject({ method: "GET", url: `/v1/evidence-receipts/${packetId(f.receipt)}` });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "UNAUTHORIZED", message: "invalid oracle token" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("retrieves the exact old packet without rereading keys or selecting a new observation window", async () => {
    const f = await fixture();
    const result = await f.run();
    const body = result.json<{ evidenceReceipt: EvidenceReceipt; evidenceReceiptId: string }>();
    const keyLookup = vi.spyOn(f.store, "getSensor").mockRejectedValue(new Error("current-key-lookup-forbidden"));
    const windowLookup = vi.spyOn(f.store, "listObservations").mockRejectedValue(new Error("new-window-forbidden"));
    const response = await f.app.inject({ method: "GET", url: `/v1/evidence-receipts/${body.evidenceReceiptId}`,
      headers: { "x-oracle-token": oracleToken } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(body.evidenceReceipt);
    expect(keyLookup).not.toHaveBeenCalled();
    expect(windowLookup).not.toHaveBeenCalled();
    const encoded = response.body;
    for (const secret of ["synthetic-persistence-admin", oracleToken, f.credentials.privateKey,
      "Synthetic private sensor label"]) expect(encoded).not.toContain(secret);
    const latest = await f.app.inject({ method: "GET", url: `/v1/regions/${regionId}/metrics/${metric}/latest` });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toEqual(body.evidenceReceipt.assessment);
  });

  it("rejects a wrong token before validating even a malformed receipt ID", async () => {
    const f = await fixture();
    const lookup = vi.spyOn(f.store, "getEvidenceReceipt");
    const response = await f.app.inject({ method: "GET", url: "/v1/evidence-receipts/malformed",
      headers: { "x-oracle-token": "wrong-token" } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "UNAUTHORIZED", message: "invalid oracle token" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["not-a-hash", `0X${"a".repeat(64)}`, `0x${"a".repeat(63)}`])("rejects malformed authorized packet ID %s before lookup", async id => {
    const f = await fixture();
    const lookup = vi.spyOn(f.store, "getEvidenceReceipt");
    const response = await f.app.inject({ method: "GET", url: `/v1/evidence-receipts/${id}`,
      headers: { "x-oracle-token": oracleToken } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_INPUT");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("reports absence without creating a packet from existing observations or an assessment", async () => {
    const f = await fixture();
    await f.store.saveAssessment(f.receipt.assessment);
    const response = await f.app.inject({ method: "GET", url: `/v1/evidence-receipts/${packetId(f.receipt)}`,
      headers: { "x-oracle-token": oracleToken } });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "EVIDENCE_RECEIPT_NOT_FOUND", message: "evidence receipt not found" });
    expect(await f.store.getEvidenceReceipt(packetId(f.receipt))).toBeUndefined();
  });

  it("hides storage errors on retrieval without leaking payloads or connection details", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "getEvidenceReceipt").mockRejectedValue(new Error("postgres://private-user:private-password@private-host/private-db"));
    const response = await f.app.inject({ method: "GET", url: `/v1/evidence-receipts/${packetId(f.receipt)}`,
      headers: { "x-oracle-token": oracleToken } });
    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("private-");
  });

  it("does not evaluate policy or emit a successful result when atomic persistence fails", async () => {
    const f = await fixture();
    const before = structuredClone(f.rows);
    const legacy = vi.spyOn(f.store, "saveAssessment");
    vi.spyOn(f.store, "saveAssessmentWithReceipt").mockRejectedValue(new Error("private-sql-details"));
    const response = await f.run();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(await f.store.latestAssessment(regionId, metric)).toBeUndefined();
    expect(await f.store.getEvidenceReceipt(packetId(f.receipt))).toBeUndefined();
    expect(await f.store.listObservations(regionId, metric, 512)).toEqual(before);
  });

  it("preserves the explicit assessment conflict response and stops before policy evaluation", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "saveAssessmentWithReceipt").mockRejectedValue(new DomainError(
      "assessment identity conflict", 409, "ASSESSMENT_CONFLICT"));
    const response = await f.run();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "ASSESSMENT_CONFLICT", message: "assessment identity conflict" });
    expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
  });
});
