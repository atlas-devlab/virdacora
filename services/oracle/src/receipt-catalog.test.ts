import { generateKeyPairSync } from "node:crypto";

import { observationId, signObservation } from "@terravoce/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeEvidence } from "./analysis.js";
import { buildApp } from "./app.js";
import { createEvidenceReceipt, evidenceReceiptId, type EvidenceReceipt } from "./evidence-receipt.js";
import { MemoryObservationStore, type StoredObservation } from "./store.js";

const regionId = "IT-PO-DELTA";
const metric = "water.oxygen.mg_l";
const oracleToken = "synthetic-catalog-oracle";
const unknownId = `0x${"f".repeat(64)}`;
const policySource = `
policy "receipt-catalog-test" version 1 {
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

function packets(count: number): EvidenceReceipt[] {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const sensor = { sensorId: "synthetic-catalog-sensor", regionId,
    publicKeyDerBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const rows: StoredObservation[] = Array.from({ length: 6 }, (_, index) => {
    const micro = index % 2 === 1;
    const unsigned = { sensorId: sensor.sensorId, regionId, metric,
      value: (8 - index * 0.4) * (micro ? 1_000 : 1), unit: micro ? "\u00b5g/L" : "mg/L",
      sequence: index + 1, observedAt: new Date(Date.UTC(2026, 9, 21, index + 4)).toISOString() };
    return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
  });
  const base = createEvidenceReceipt(analyzeEvidence(rows, 3_600), { observations: rows, sensors: [sensor] });
  const result: EvidenceReceipt[] = [];
  const permutations = (prefix: StoredObservation[], rest: StoredObservation[]): void => {
    if (result.length >= count) return;
    if (rest.length === 0) {
      result.push({ ...structuredClone(base), observations: structuredClone(prefix) });
      return;
    }
    for (let index = 0; index < rest.length && result.length < count; index += 1) {
      permutations([...prefix, rest[index]!], rest.filter((_row, position) => position !== index));
    }
  };
  permutations([], rows);
  if (result.length !== count) throw new Error("synthetic permutation count exceeded");
  return result;
}

const apps: ReturnType<typeof buildApp>[] = [];
function appFixture(store = new MemoryObservationStore()) {
  const app = buildApp({ store, policySource, adminToken: "synthetic-catalog-admin", oracleToken });
  apps.push(app);
  const get = (assessmentId: string, query = "", token: string | null = oracleToken) =>
    app.inject({ method: "GET", url: `/v1/assessments/${assessmentId}/evidence-receipts${query}`,
      headers: token === null ? {} : { "x-oracle-token": token } });
  return { app, store, get };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
});

describe("memory receipt catalog", () => {
  it("pages authentic variants in ascending lowercase hexadecimal order with a bounded continuation cursor", async () => {
    const receipts = packets(5);
    const store = new MemoryObservationStore();
    for (const packet of [receipts[3]!, receipts[1]!, receipts[4]!, receipts[0]!, receipts[2]!]) {
      await store.saveAssessmentWithReceipt(packet);
    }
    const expected = receipts.map(evidenceReceiptId).sort();
    const assessmentId = receipts[0]!.assessment.assessmentId;
    const first = await store.listEvidenceReceipts(assessmentId, 2);
    expect(first).toEqual({ assessmentId, receiptIds: expected.slice(0, 2), nextAfter: expected[1] });
    const second = await store.listEvidenceReceipts(assessmentId, 2, first.nextAfter);
    expect(second).toEqual({ assessmentId, receiptIds: expected.slice(2, 4), nextAfter: expected[3] });
    const third = await store.listEvidenceReceipts(assessmentId, 2, second.nextAfter);
    expect(third).toEqual({ assessmentId, receiptIds: expected.slice(4) });
    expect(third).not.toHaveProperty("nextAfter");
    expect([...first.receiptIds, ...second.receiptIds, ...third.receiptIds]).toEqual(expected);
    const exactLimit = await store.listEvidenceReceipts(assessmentId, 5);
    expect(exactLimit).toEqual({ assessmentId, receiptIds: expected });
    expect(exactLimit).not.toHaveProperty("nextAfter");
  });

  it("does not duplicate packets or mix assessments and leaves unknown and legacy parents empty", async () => {
    const [packet] = packets(1);
    const receipt = packet!;
    const other = createEvidenceReceipt(analyzeEvidence(receipt.observations, 7_200), {
      observations: receipt.observations, sensors: receipt.sensors
    });
    const legacy = analyzeEvidence(receipt.observations, 10_800).assessment;
    const store = new MemoryObservationStore();
    await store.saveAssessmentWithReceipt(receipt);
    await store.saveAssessmentWithReceipt(structuredClone(receipt));
    await store.saveAssessmentWithReceipt(other);
    await store.saveAssessment(legacy);
    expect(await store.listEvidenceReceipts(receipt.assessment.assessmentId, 20)).toEqual({
      assessmentId: receipt.assessment.assessmentId, receiptIds: [evidenceReceiptId(receipt)]
    });
    expect(await store.listEvidenceReceipts(other.assessment.assessmentId, 20)).toEqual({
      assessmentId: other.assessment.assessmentId, receiptIds: [evidenceReceiptId(other)]
    });
    expect(await store.listEvidenceReceipts(legacy.assessmentId, 20)).toEqual({ assessmentId: legacy.assessmentId, receiptIds: [] });
    expect(await store.listEvidenceReceipts(unknownId, 20)).toEqual({ assessmentId: unknownId, receiptIds: [] });
  });

  it("returns isolated arrays and page objects, never references to internal catalog state", async () => {
    const receipts = packets(3);
    const store = new MemoryObservationStore();
    for (const receipt of receipts) await store.saveAssessmentWithReceipt(receipt);
    const assessmentId = receipts[0]!.assessment.assessmentId;
    const expectedIds = receipts.map(evidenceReceiptId).sort();
    const page = await store.listEvidenceReceipts(assessmentId, 2);
    page.receiptIds.reverse();
    page.receiptIds.push(unknownId);
    page.receiptIds[0] = "private-caller-mutation";
    page.assessmentId = unknownId;
    page.nextAfter = unknownId;
    expect(await store.listEvidenceReceipts(assessmentId, 2)).toEqual({
      assessmentId, receiptIds: expectedIds.slice(0, 2), nextAfter: expectedIds[1]
    });
  });

  it("accepts a valid cursor that is not an existing receipt and applies a strict greater-than bound", async () => {
    const receipts = packets(3);
    const store = new MemoryObservationStore();
    for (const receipt of receipts) await store.saveAssessmentWithReceipt(receipt);
    const assessmentId = receipts[0]!.assessment.assessmentId;
    const expected = receipts.map(evidenceReceiptId).sort();
    const before = `0x${"0".repeat(64)}`;
    expect(expected).not.toContain(before);
    expect(expected).not.toContain(unknownId);
    expect(await store.listEvidenceReceipts(assessmentId, 100, before)).toEqual({ assessmentId, receiptIds: expected });
    expect(await store.listEvidenceReceipts(assessmentId, 100, expected[1])).toEqual({ assessmentId, receiptIds: expected.slice(2) });
    expect(await store.listEvidenceReceipts(assessmentId, 100, unknownId)).toEqual({ assessmentId, receiptIds: [] });
  });

  it("documents live keyset pagination: interleaved inserts behind the cursor are omitted while later IDs can appear", async () => {
    const ordered = packets(9).sort((left, right) => evidenceReceiptId(left) < evidenceReceiptId(right) ? -1 : 1);
    const store = new MemoryObservationStore();
    for (const index of [0, 3, 6]) await store.saveAssessmentWithReceipt(ordered[index]!);
    const assessmentId = ordered[0]!.assessment.assessmentId;
    const first = await store.listEvidenceReceipts(assessmentId, 2);
    expect(first).toEqual({ assessmentId,
      receiptIds: [evidenceReceiptId(ordered[0]!), evidenceReceiptId(ordered[3]!)],
      nextAfter: evidenceReceiptId(ordered[3]!) });
    await store.saveAssessmentWithReceipt(ordered[2]!); // Behind the saved cursor.
    await store.saveAssessmentWithReceipt(ordered[5]!); // Ahead of the saved cursor.
    const next = await store.listEvidenceReceipts(assessmentId, 2, first.nextAfter);
    expect(next).toEqual({ assessmentId,
      receiptIds: [evidenceReceiptId(ordered[5]!), evidenceReceiptId(ordered[6]!)] });
    expect([...first.receiptIds, ...next.receiptIds]).not.toContain(evidenceReceiptId(ordered[2]!));
  });

  it.each([
    { name: "zero limit", limit: 0 }, { name: "negative limit", limit: -1 },
    { name: "fractional limit", limit: 1.5 }, { name: "NaN limit", limit: Number.NaN },
    { name: "infinite limit", limit: Number.POSITIVE_INFINITY }, { name: "over-cap limit", limit: 101 },
    { name: "unsafe limit", limit: Number.MAX_SAFE_INTEGER + 1 },
    { name: "string limit", limit: "2" as unknown as number },
    { name: "missing limit", limit: undefined as unknown as number },
    { name: "bad assessment", assessmentId: "bad", limit: 20 },
    { name: "uppercase prefix", assessmentId: `0X${"a".repeat(64)}`, limit: 20 },
    { name: "uppercase hex", assessmentId: `0x${"A".repeat(64)}`, limit: 20 },
    { name: "empty cursor", limit: 20, after: "" },
    { name: "bad cursor", limit: 20, after: "bad" },
    { name: "uppercase cursor", limit: 20, after: `0x${"A".repeat(64)}` }
  ])("rejects $name before accessing a catalog", async ({ assessmentId = unknownId, limit, ...options }) => {
    const store = new MemoryObservationStore();
    const after = "after" in options ? options.after : undefined;
    await expect(store.listEvidenceReceipts(assessmentId, limit, after)).rejects.toMatchObject({
      statusCode: 400, code: "INVALID_RECEIPT_PAGE", message: "invalid receipt page request"
    });
    expect(await store.listEvidenceReceipts(unknownId, 20)).toEqual({ assessmentId: unknownId, receiptIds: [] });
  });
});

describe("assessment receipt catalog API", () => {
  it("returns an authenticated empty catalog for an unknown assessment", async () => {
    const f = appFixture();
    const response = await f.get(unknownId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assessmentId: unknownId, receiptIds: [] });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("authenticates the catalog before validating its path or query", async () => {
    const f = appFixture();
    const lookup = vi.spyOn(f.store, "listEvidenceReceipts");
    const response = await f.get("malformed", "?limit=0&after=", null);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "UNAUTHORIZED", message: "invalid oracle token" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("uses default20 and forwards an explicit cursor without requiring it to exist", async () => {
    const f = appFixture();
    const cursor = `0x${"0".repeat(64)}`;
    const lookup = vi.spyOn(f.store, "listEvidenceReceipts");
    const response = await f.get(unknownId, `?after=${cursor}`);
    expect(response.statusCode).toBe(200);
    expect(lookup.mock.calls).toHaveLength(1);
    expect(lookup.mock.calls[0]).toEqual([unknownId, 20, cursor]);
    expect(response.json()).toEqual({ assessmentId: unknownId, receiptIds: [] });
  });

  it("accepts the maximum100 while keeping the result metadata-only", async () => {
    const f = appFixture();
    const lookup = vi.spyOn(f.store, "listEvidenceReceipts");
    const response = await f.get(unknownId, "?limit=100");
    expect(response.statusCode).toBe(200);
    expect(lookup.mock.calls[0]?.slice(0, 2)).toEqual([unknownId, 100]);
    expect(Object.keys(response.json()).sort()).toEqual(["assessmentId", "receiptIds"]);
  });

  it("returns only the bounded ID page without reading packet bodies, keys, observations or writing results", async () => {
    const receipts = packets(3);
    const f = appFixture();
    for (const receipt of receipts) await f.store.saveAssessmentWithReceipt(receipt);
    const forbidden = ["getEvidenceReceipt", "getSensor", "listObservations", "latestAssessment",
      "saveAssessment", "saveAssessmentWithReceipt"] as const;
    const spies = forbidden.map(method => vi.spyOn(f.store, method).mockRejectedValue(new Error("private-forbidden-data-access")));
    const expected = receipts.map(evidenceReceiptId).sort();
    const assessmentId = receipts[0]!.assessment.assessmentId;
    const response = await f.get(assessmentId, "?limit=2");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ assessmentId, receiptIds: expected.slice(0, 2), nextAfter: expected[1] });
    expect(Object.keys(response.json()).sort()).toEqual(["assessmentId", "nextAfter", "receiptIds"]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const field of ["observations", "sensors", "publicKeyDerBase64", "totalCount", "body"]) {
      expect(response.json()).not.toHaveProperty(field);
    }
  });

  it("keeps a legacy assessment without receipts as an empty catalog", async () => {
    const [receipt] = packets(1);
    const f = appFixture();
    await f.store.saveAssessment(receipt!.assessment);
    const response = await f.get(receipt!.assessment.assessmentId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assessmentId: receipt!.assessment.assessmentId, receiptIds: [] });
  });

  it("rejects a wrong token even for invalid paging before any storage lookup", async () => {
    const f = appFixture();
    const lookup = vi.spyOn(f.store, "listEvidenceReceipts");
    const response = await f.get("malformed", "?limit=1e2&after=bad", "wrong-token");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "UNAUTHORIZED", message: "invalid oracle token" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    { name: "empty limit", query: "?limit=" }, { name: "zero limit", query: "?limit=0" },
    { name: "negative limit", query: "?limit=-1" }, { name: "fractional limit", query: "?limit=1.5" },
    { name: "exponential limit", query: "?limit=1e2" }, { name: "over-cap limit", query: "?limit=101" },
    { name: "leading whitespace", query: "?limit=%202" }, { name: "trailing whitespace", query: "?limit=2%20" },
    { name: "positive sign", query: "?limit=%2B2" }, { name: "NaN limit", query: "?limit=NaN" },
    { name: "infinite limit", query: "?limit=Infinity" }, { name: "repeated limit", query: "?limit=1&limit=2" },
    { name: "empty cursor", query: "?after=" }, { name: "bad cursor", query: "?after=bad" },
    { name: "uppercase cursor", query: `?after=0x${"A".repeat(64)}` },
    { name: "repeated cursor", query: `?after=${unknownId}&after=${unknownId}` }
  ])("rejects $name before calling storage", async ({ query }) => {
    const f = appFixture();
    const lookup = vi.spyOn(f.store, "listEvidenceReceipts");
    const response = await f.get(unknownId, query);
    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["malformed", `0X${"a".repeat(64)}`, `0x${"A".repeat(64)}`])("rejects malformed assessment ID %s before storage", async id => {
    const f = appFixture();
    const lookup = vi.spyOn(f.store, "listEvidenceReceipts");
    const response = await f.get(id);
    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps storage failures generic without exposing connection or query details", async () => {
    const f = appFixture();
    vi.spyOn(f.store, "listEvidenceReceipts").mockRejectedValue(new Error("postgres://private-user:private-password@private-host/private-db"));
    const response = await f.get(unknownId);
    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("private-");
  });
});
