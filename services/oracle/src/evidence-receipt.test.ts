import { generateKeyPairSync } from "node:crypto";

import { canonicalJson, observationId, sha256Hex, signObservation } from "@terravoce/protocol";
import { describe, expect, it } from "vitest";

import { analyzeEvidence, analyzeObservations } from "./analysis.js";
import { verifyArchivedEvidence } from "./evidence-integrity.js";
import { createEvidenceReceipt, verifyEvidenceReceipt, type EvidenceReceipt } from "./evidence-receipt.js";
import { MemoryObservationStore, type StoredObservation } from "./store.js";

const keyPair = () => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
};
const invalid = { code: "INVALID_EVIDENCE_RECEIPT", statusCode: 422,
  message: "evidence receipt verification failed" };

async function fixture() {
  const keys = keyPair();
  const selection = { regionId: "IT-PO-DELTA", metric: "water.oxygen.mg_l" };
  // The trust source is chosen before creating/reading the receipt.
  const trusted = [{ sensorId: "synthetic-receipt-sensor", regionId: selection.regionId,
    publicKeyDerBase64: keys.publicKey }];
  const store = new MemoryObservationStore();
  await store.registerSensor({ ...trusted[0]!, label: "Synthetic receipt" });
  const rows: StoredObservation[] = Array.from({ length: 6 }, (_, sequence) => {
    const unit = sequence % 2 === 0 ? "mg/L" : "\u00b5g/L";
    const unsigned = { ...selection, sensorId: trusted[0]!.sensorId, sequence, unit,
      value: (8 - sequence * 0.4) * (unit === "mg/L" ? 1 : 1_000),
      observedAt: new Date(Date.UTC(2026, 9, 18, sequence)).toISOString() };
    return { observationId: observationId(unsigned), observation: signObservation(unsigned, keys.privateKey) };
  });
  const archive = await verifyArchivedEvidence(rows, selection, store);
  await store.close();
  const analysis = analyzeEvidence(archive.observations, 3_600);
  const receipt = createEvidenceReceipt(analysis, archive);
  return { trusted, rows, archive, analysis, receipt };
}

describe("offline evidence receipt replay with an independently supplied trust registry", () => {
  it("reproduces the original assessment and domain-separated hashes without mutating frozen inputs", async () => {
    const f = await fixture();
    const before = canonicalJson(f.receipt);
    for (const row of f.receipt.observations) { Object.freeze(row.observation); Object.freeze(row); }
    for (const sensor of f.receipt.sensors) Object.freeze(sensor);
    Object.freeze(f.receipt.observations); Object.freeze(f.receipt.sensors);
    Object.freeze(f.receipt.evidenceCore.observationIds); Object.freeze(f.receipt.evidenceCore);
    Object.freeze(f.receipt.assessment); Object.freeze(f.receipt);
    Object.freeze(f.trusted[0]); Object.freeze(f.trusted);
    expect(await verifyEvidenceReceipt(f.receipt, f.trusted)).toEqual(analyzeObservations(f.rows, 3_600));
    expect(f.receipt.assessment.evidenceHash).toBe(sha256Hex(`evidence:${canonicalJson(f.receipt.evidenceCore)}`));
    expect(f.receipt.assessment.assessmentId).toBe(sha256Hex(`assessment:${canonicalJson(f.receipt.evidenceCore)}`));
    expect(canonicalJson(f.receipt)).toBe(before);
  });

  it("copies receipt data separately from the verified input and producer objects", async () => {
    const f = await fixture();
    const expected = structuredClone(f.receipt);
    f.archive.observations[0]!.observation.value = 999;
    f.archive.sensors[0]!.publicKeyDerBase64 = "YQ==";
    f.analysis.evidenceCore.observationIds.reverse();
    f.analysis.assessment.forecastValue = 999;
    expect(f.receipt).toEqual(expected);
    expect(await verifyEvidenceReceipt(f.receipt, f.trusted)).toEqual(expected.assessment);
  });

  it.each([
    ["raw value", (r: EvidenceReceipt) => { r.observations[0]!.observation.value += 1; }],
    ["raw unit", (r: EvidenceReceipt) => { r.observations[0]!.observation.unit = "ug/L"; }],
    ["stored ID", (r: EvidenceReceipt) => { r.observations[0]!.observationId = `0x${"f".repeat(64)}`; }],
    ["signature", (r: EvidenceReceipt) => { r.observations[0]!.observation.signature = Buffer.alloc(64).toString("base64"); }],
    ["missing observation", (r: EvidenceReceipt) => { r.observations.pop(); }],
    ["duplicate observation", (r: EvidenceReceipt) => { r.observations[5] = structuredClone(r.observations[0]!); }],
    ["wrong core ordering", (r: EvidenceReceipt) => { r.evidenceCore.observationIds.reverse(); }],
    ["unknown format", (r: EvidenceReceipt) => { Object.assign(r, { formatVersion: "future-receipt" }); }],
    ["unknown model", (r: EvidenceReceipt) => { r.assessment.modelVersion = "future-model"; r.evidenceCore.modelVersion = "future-model"; }],
    ["unexpected field", (r: EvidenceReceipt) => { Object.assign(r, { unsignedExtension: "untrusted" }); }]
  ] as const)("rejects tampered or unsupported %s", async (_name, mutate) => {
    const f = await fixture();
    mutate(f.receipt);
    await expect(verifyEvidenceReceipt(f.receipt, f.trusted)).rejects.toMatchObject(invalid);
  });

  it("rejects invented numerical results even after their core and both hashes are recomputed coherently", async () => {
    const f = await fixture();
    f.receipt.assessment.forecastValue += 1;
    f.receipt.evidenceCore.forecastValue = f.receipt.assessment.forecastValue;
    f.receipt.assessment.assessmentId = sha256Hex(`assessment:${canonicalJson(f.receipt.evidenceCore)}`);
    f.receipt.assessment.evidenceHash = sha256Hex(`evidence:${canonicalJson(f.receipt.evidenceCore)}`);
    await expect(verifyEvidenceReceipt(f.receipt, f.trusted)).rejects.toMatchObject(invalid);
  });

  it("rejects a coherently re-signed receipt against the original external trust, even though observation IDs and hashes did not change", async () => {
    const f = await fixture();
    const originalHash = f.receipt.assessment.evidenceHash;
    const replacement = keyPair();
    f.receipt.sensors[0]!.publicKeyDerBase64 = replacement.publicKey;
    for (const row of f.receipt.observations) {
      const { signature: _signature, ...unsigned } = row.observation;
      row.observation = signObservation(unsigned, replacement.privateKey);
      expect(observationId(unsigned)).toBe(row.observationId);
    }
    expect(f.receipt.assessment.evidenceHash).toBe(originalHash);
    await expect(verifyEvidenceReceipt(f.receipt, f.trusted)).rejects.toMatchObject(invalid);
    // Deliberately changing the external trust authority changes what is trusted.
    // Internal consistency cannot authenticate that authority by itself.
    const differentTrust = [{ ...f.trusted[0]!, publicKeyDerBase64: replacement.publicKey }];
    expect(await verifyEvidenceReceipt(f.receipt, differentTrust)).toEqual(f.receipt.assessment);
  });

  it.each([
    { name: "missing", trust: undefined }, { name: "empty", trust: [] },
    { name: "the wrong type", trust: "use-bundled-keys" }
  ])("never defaults to bundled keys when external trust is $name", async ({ trust }) => {
    const f = await fixture();
    await expect(verifyEvidenceReceipt(f.receipt, trust)).rejects.toMatchObject(invalid);
  });

  it("rejects ambiguous or incomplete sensor bindings and allows unused keys only in the external registry", async () => {
    const f = await fixture();
    await expect(verifyEvidenceReceipt(f.receipt, [...f.trusted, f.trusted[0]!])).rejects.toMatchObject(invalid);
    const other = { ...f.trusted[0]!, sensorId: "another-trusted-sensor" };
    expect(await verifyEvidenceReceipt(f.receipt, [...f.trusted, other])).toEqual(f.receipt.assessment);
    f.receipt.sensors.push(other);
    await expect(verifyEvidenceReceipt(f.receipt, [...f.trusted, other])).rejects.toMatchObject(invalid);
    f.receipt.sensors = [];
    await expect(verifyEvidenceReceipt(f.receipt, f.trusted)).rejects.toMatchObject(invalid);
  });

  it("accepts a different raw arrival order while preserving the committed chronological core", async () => {
    const f = await fixture();
    f.receipt.observations.reverse();
    expect(await verifyEvidenceReceipt(f.receipt, f.trusted)).toEqual(f.receipt.assessment);
  });
});
