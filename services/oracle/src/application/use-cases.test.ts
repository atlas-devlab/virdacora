import { generateKeyPairSync } from "node:crypto";

import { canonicalJson, observationId, signObservation } from "@terravoce/protocol";
import { describe, expect, it, vi } from "vitest";

import { evidenceReceiptId, verifyEvidenceReceipt, type EvidenceReceipt } from "../domain/evidence-receipt.js";
import type { StoredObservation, StoredSensor } from "../domain/observations.js";
import { createOracleUseCases } from "./use-cases.js";
import type { ObservationStore } from "./ports/observation-store.js";
import type { PolicyDecision, PolicyPort } from "./ports/policy.js";

const regionId = "IT-PO-DELTA";
const metric = "water.oxygen.mg_l";
const origin = new Date("2026-10-22T12:00:00.000Z");
const policyHash = `0x${"a".repeat(64)}` as const;
const input = { regionId, metric, forecastHorizonHours: 1, requestedAction: "WATER_AERATION",
  requestedAmount: 10, asset: "USDC" };

function fixture() {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const sensor: StoredSensor = { sensorId: "synthetic-usecase-sensor", regionId, active: true,
    publicKeyDerBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    label: "Synthetic port fixture" };
  const trusted = [{ sensorId: sensor.sensorId, regionId, publicKeyDerBase64: sensor.publicKeyDerBase64 }];
  const rows: StoredObservation[] = Array.from({ length: 6 }, (_, index) => {
    const micro = index % 2 === 1;
    const unsigned = { sensorId: sensor.sensorId, regionId, metric, value: micro ? 6_000 : 6,
      unit: micro ? "\u00b5g/L" : "mg/L", sequence: index + 1,
      observedAt: new Date(origin.getTime() - (6 - index) * 3_600_000).toISOString() };
    return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
  });
  const events: string[] = [];
  const retained = new Map<string, EvidenceReceipt>();
  const read = vi.fn(async () => { events.push("read-window"); return structuredClone(rows); });
  const registry = vi.fn(async (sensorId: string) => {
    events.push("verify-registry");
    return sensorId === sensor.sensorId ? { ...sensor } : undefined;
  });
  const atomicSave = vi.fn(async (receipt: EvidenceReceipt) => {
    events.push("atomic-save");
    // The fake port checks that application orchestration sent the original
    // authenticated evidence, using trust fixed before receiving the packet.
    await expect(verifyEvidenceReceipt(receipt, trusted)).resolves.toEqual(receipt.assessment);
    const id = evidenceReceiptId(receipt);
    retained.set(id, structuredClone(receipt));
    return id;
  });
  const write = vi.fn(async (_entry: StoredObservation) => { events.push("write-observation"); });
  const legacySave = vi.fn(async () => { events.push("legacy-save"); });
  const register = vi.fn(async () => ({ ...sensor }));
  const store: ObservationStore = {
    checkReadiness: vi.fn(async () => {}), close: vi.fn(async () => {}),
    registerSensor: register, getSensor: registry, addObservation: write,
    listObservations: read, saveAssessment: legacySave, saveAssessmentWithReceipt: atomicSave,
    getEvidenceReceipt: vi.fn(async id => retained.get(id)),
    listEvidenceReceipts: vi.fn(async assessmentId => ({ assessmentId, receiptIds: [] })),
    latestAssessment: vi.fn(async () => [...retained.values()].at(-1)?.assessment)
  };
  const decision: PolicyDecision = { allowed: true, reasons: [], policyHash };
  const evaluate = vi.fn((_context: Parameters<PolicyPort["evaluate"]>[0]): PolicyDecision => {
    events.push("policy");
    return decision;
  });
  const policy: PolicyPort = { policyHash, challengeSeconds: 86_400, evaluate };
  const now = vi.fn(() => new Date(origin.getTime()));
  const service = createOracleUseCases({ store, policy, now });
  return { service, sensor, rows, privateKey, events, retained, read, registry, atomicSave,
    legacySave, evaluate, write, register, now, decision };
}

describe("Oracle use cases through application-owned ports", () => {
  it("orchestrates verified evidence, atomic retention, policy and reversible draft without an HTTP server or concrete store", async () => {
    const f = fixture();
    const before = canonicalJson(f.rows);
    const result = await f.service.runAssessment(input);
    expect(f.events).toEqual(["read-window", "verify-registry", "atomic-save", "policy"]);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(regionId, metric, 512);
    expect(f.registry).toHaveBeenCalledExactlyOnceWith(f.sensor.sensorId);
    expect(f.atomicSave).toHaveBeenCalledExactlyOnceWith(result.evidenceReceipt);
    expect(f.legacySave).not.toHaveBeenCalled();
    expect(result.evidenceReceipt.observations).toEqual(f.rows);
    expect(result.evidenceReceiptId).toBe(evidenceReceiptId(result.evidenceReceipt));
    expect(f.retained.get(result.evidenceReceiptId)).toEqual(result.evidenceReceipt);
    expect(result.assessment).toMatchObject({ currentValue: 6, forecastValue: 6,
      forecastHorizonSeconds: 3_600, slopePerHour: 0, anomalyScore: 0 });
    expect(f.evaluate).toHaveBeenCalledExactlyOnceWith({ regionId, metric, risk: result.assessment.risk,
      confidence: result.assessment.confidence, observations: 6, requestedAction: "WATER_AERATION",
      requestedAmount: 10, requestedAsset: "USDC" });
    expect(result.decision).toEqual(f.decision);
    expect(result.actionDraft).toMatchObject({ regionId, evidenceHash: result.assessment.evidenceHash,
      policyHash, action: "WATER_AERATION", reversible: true, requestedAmount: 10, asset: "USDC",
      challengeSeconds: 86_400 });
    expect(f.service.policyHash).toBe(policyHash);
    expect(f.now).not.toHaveBeenCalled();
    expect(canonicalJson(f.rows)).toBe(before);
  });

  it("blocks a coherently reidentified but unsigned archive alteration before retention or policy evaluation", async () => {
    const f = fixture();
    const altered = structuredClone(f.rows);
    altered[0]!.observation.value += 1;
    const { signature: _signature, ...unsigned } = altered[0]!.observation;
    altered[0]!.observationId = observationId(unsigned);
    f.read.mockImplementationOnce(async () => { f.events.push("read-window"); return altered; });
    await expect(f.service.runAssessment(input)).rejects.toMatchObject({
      statusCode: 422, code: "INVALID_ARCHIVED_EVIDENCE", message: "archived observation evidence is invalid"
    });
    expect(f.events).toEqual(["read-window", "verify-registry"]);
    expect(f.atomicSave).not.toHaveBeenCalled();
    expect(f.legacySave).not.toHaveBeenCalled();
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.retained.size).toBe(0);
  });

  it("preserves the existing save-before-policy semantics when a policy adapter fails", async () => {
    const f = fixture();
    const failure = new Error("synthetic policy adapter unavailable");
    f.evaluate.mockImplementationOnce(() => { f.events.push("policy"); throw failure; });
    await expect(f.service.runAssessment(input)).rejects.toBe(failure);
    expect(f.events).toEqual(["read-window", "verify-registry", "atomic-save", "policy"]);
    expect(f.retained.size).toBe(1);
    const receipt = [...f.retained.values()][0]!;
    expect(receipt.observations).toEqual(f.rows);
    expect(receipt.assessment.currentValue).toBe(6);
    expect(f.atomicSave).toHaveBeenCalledTimes(1);
    expect(f.legacySave).not.toHaveBeenCalled();
  });

  it("uses the injected ingestion clock and keeps signed units and values unchanged", async () => {
    const f = fixture();
    const observation = structuredClone(f.rows.at(-1)!.observation);
    const original = canonicalJson(observation);
    const { signature: _signature, ...unsigned } = observation;
    const result = await f.service.ingestObservation(observation);
    expect(result).toEqual({ observationId: observationId(unsigned), accepted: true });
    expect(f.write).toHaveBeenCalledExactlyOnceWith({ observationId: observationId(unsigned), observation });
    expect(f.write.mock.calls[0]![0].observation).toMatchObject({ value: 6_000, unit: "\u00b5g/L",
      signature: observation.signature });
    expect(f.now).toHaveBeenCalledTimes(1);
    expect(canonicalJson(observation)).toBe(original);
    const future = signObservation({ ...unsigned, sequence: unsigned.sequence + 1,
      observedAt: new Date(origin.getTime() + 6 * 60_000).toISOString() }, f.privateKey);
    await expect(f.service.ingestObservation(future)).rejects.toMatchObject({
      statusCode: 422, code: "INVALID_TIME", message: "observation timestamp outside accepted window"
    });
    expect(f.now).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.atomicSave).not.toHaveBeenCalled();
    expect(f.evaluate).not.toHaveBeenCalled();
  });

  it("validates trusted command inputs within the use case rather than relying on an HTTP adapter", async () => {
    const f = fixture();
    await expect(f.service.registerSensor({ sensorId: "x" })).rejects.toBeDefined();
    await expect(f.service.runAssessment({ ...input, forecastHorizonHours: 0 })).rejects.toBeDefined();
    await expect(f.service.ingestObservation({ metric })).rejects.toBeDefined();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.registry).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.atomicSave).not.toHaveBeenCalled();
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.now).not.toHaveBeenCalled();
  });
});
