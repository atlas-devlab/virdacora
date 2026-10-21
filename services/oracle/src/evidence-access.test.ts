import { generateKeyPairSync } from "node:crypto";

import { observationId, signObservation } from "@terravoce/protocol";
import { evaluatePolicy } from "@terravoce/terralex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeEvidence } from "./analysis.js";
import { buildApp } from "./app.js";
import { createEvidenceReceipt, evidenceReceiptId, verifyEvidenceReceipt } from "./evidence-receipt.js";
import { MemoryObservationStore, type StoredObservation } from "./store.js";

vi.mock("@terravoce/terralex", async importOriginal => {
  const actual = await importOriginal<typeof import("@terravoce/terralex")>();
  return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

const regionId = "IT-PO-DELTA";
const metric = "water.oxygen.mg_l";
const adminToken = "synthetic-admin-token-for-evidence-access-only";
const oracleToken = "synthetic-oracle-token-for-evidence-access-only";
const readerToken = "synthetic-reader-token-for-evidence-access-only";
const unauthorized = { error: "UNAUTHORIZED", message: "invalid oracle token" };
const policySource = `
policy "evidence-access-test" version 1 {
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

const apps: ReturnType<typeof buildApp>[] = [];
async function fixture(evidenceReadToken: string | null = readerToken) {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const trusted = [{ sensorId: "synthetic-reader-sensor", regionId,
    publicKeyDerBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") }];
  const rows: StoredObservation[] = Array.from({ length: 6 }, (_, index) => {
    const micro = index % 2 === 1;
    const unsigned = { sensorId: trusted[0]!.sensorId, regionId, metric,
      value: (8 - index * 0.4) * (micro ? 1_000 : 1), unit: micro ? "\u00b5g/L" : "mg/L",
      sequence: index + 1, observedAt: new Date(Date.UTC(2026, 9, 21, index + 4)).toISOString() };
    return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
  });
  const receipt = createEvidenceReceipt(analyzeEvidence(rows, 3_600), { observations: rows, sensors: trusted });
  const store = new MemoryObservationStore();
  const receiptId = await store.saveAssessmentWithReceipt(receipt);
  const options = { store, policySource, adminToken, oracleToken,
    ...(evidenceReadToken === null ? {} : { evidenceReadToken }) };
  const app = buildApp(options);
  apps.push(app);
  const catalogUrl = `/v1/assessments/${receipt.assessment.assessmentId}/evidence-receipts`;
  const receiptUrl = `/v1/evidence-receipts/${receiptId}`;
  return { app, store, receipt, receiptId, trusted, privateKey, rows, catalogUrl, receiptUrl };
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
});

describe("separate evidence read capability", () => {
  it("allows the configured reader to discover receipt IDs without the Oracle credential", async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: "GET", url: f.catalogUrl,
      headers: { "x-evidence-token": readerToken } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ assessmentId: f.receipt.assessment.assessmentId, receiptIds: [f.receiptId] });
  });

  it("allows exact reader retrieval and independent signature/numerical replay against separately retained trust", async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: "GET", url: f.receiptUrl,
      headers: { "x-evidence-token": readerToken } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(f.receipt);
    expect(evidenceReceiptId(response.json())).toBe(f.receiptId);
    await expect(verifyEvidenceReceipt(response.json(), f.trusted)).resolves.toEqual(f.receipt.assessment);
    for (const secret of [readerToken, adminToken, oracleToken, f.privateKey]) expect(response.body).not.toContain(secret);
  });

  it.each([
    { name: "legacy Oracle alone", headers: { "x-oracle-token": oracleToken } },
    { name: "Oracle with a wrong reader", headers: { "x-oracle-token": oracleToken, "x-evidence-token": "wrong-reader" } },
    { name: "reader with a wrong Oracle", headers: { "x-oracle-token": "wrong-oracle", "x-evidence-token": readerToken } },
    { name: "both valid capabilities", headers: { "x-oracle-token": oracleToken, "x-evidence-token": readerToken } },
    { name: "Oracle with repeated reader header", headers: { "x-oracle-token": oracleToken,
      "x-evidence-token": [readerToken, readerToken] } },
    { name: "reader with repeated Oracle header", headers: { "x-oracle-token": [oracleToken, oracleToken],
      "x-evidence-token": readerToken } }
  ])("uses OR semantics for $name on both read endpoints", async ({ headers }) => {
    const f = await fixture();
    for (const url of [f.catalogUrl, f.receiptUrl]) {
      const response = await f.app.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it.each([
    { name: "absent credentials", headers: {} },
    { name: "wrong reader", headers: { "x-evidence-token": "wrong-reader" } },
    { name: "empty reader", headers: { "x-evidence-token": "" } },
    { name: "reader with appended whitespace", headers: { "x-evidence-token": `${readerToken} ` } },
    { name: "partial reader", headers: { "x-evidence-token": readerToken.slice(1) } },
    { name: "reader in Oracle header", headers: { "x-oracle-token": readerToken } },
    { name: "reader in admin header", headers: { "x-admin-token": readerToken } },
    { name: "Oracle in reader header", headers: { "x-evidence-token": oracleToken } },
    { name: "admin in reader header", headers: { "x-evidence-token": adminToken } },
    { name: "repeated reader header", headers: { "x-evidence-token": [readerToken, readerToken] } },
    { name: "repeated Oracle header", headers: { "x-oracle-token": [oracleToken, oracleToken] } }
  ])("rejects $name before any read or write lookup", async ({ headers }) => {
    const f = await fixture();
    const reads = [vi.spyOn(f.store, "getEvidenceReceipt"), vi.spyOn(f.store, "listEvidenceReceipts")];
    for (const url of [f.catalogUrl, f.receiptUrl]) {
      const response = await f.app.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(unauthorized);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
  });

  it("disables the new capability when absent without falling back to any other configured token", async () => {
    const f = await fixture(null);
    const reads = [vi.spyOn(f.store, "getEvidenceReceipt"), vi.spyOn(f.store, "listEvidenceReceipts")];
    for (const url of [f.catalogUrl, f.receiptUrl]) {
      for (const token of [readerToken, oracleToken, adminToken, ""]) {
        const response = await f.app.inject({ method: "GET", url, headers: { "x-evidence-token": token } });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(unauthorized);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    for (const url of [f.catalogUrl, f.receiptUrl]) {
      const response = await f.app.inject({ method: "GET", url, headers: { "x-oracle-token": oracleToken } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it.each([
    { name: "reader header only", headers: { "x-evidence-token": readerToken } },
    { name: "reader in Oracle header", headers: { "x-oracle-token": readerToken } },
    { name: "reader in admin header", headers: { "x-admin-token": readerToken } },
    { name: "reader in all credential headers", headers: { "x-evidence-token": readerToken,
      "x-oracle-token": readerToken, "x-admin-token": readerToken } },
    { name: "valid reader and wrong writer credentials", headers: { "x-evidence-token": readerToken,
      "x-oracle-token": "wrong-oracle", "x-admin-token": "wrong-admin" } },
    { name: "repeated reader pretending to be a writer", headers: { "x-oracle-token": [readerToken, readerToken],
      "x-admin-token": [readerToken, readerToken] } }
  ])("does not grant either privileged POST to $name", async ({ headers }) => {
    const f = await fixture();
    const forbidden = ["getSensor", "registerSensor", "listObservations", "getEvidenceReceipt", "listEvidenceReceipts",
      "saveAssessment", "saveAssessmentWithReceipt", "addObservation"] as const;
    const spies = forbidden.map(method => vi.spyOn(f.store, method));
    const run = await f.app.inject({ method: "POST", url: "/v1/assessments/run", headers,
      payload: { regionId, metric, forecastHorizonHours: 1, requestedAction: "WATER_AERATION",
        requestedAmount: 0, asset: "USDC" } });
    expect(run.statusCode).toBe(401);
    expect(run.json()).toEqual(unauthorized);
    const sensor = await f.app.inject({ method: "POST", url: "/v1/sensors", headers,
      payload: { ...f.trusted[0]!, label: "Synthetic registration denied" } });
    expect(sensor.statusCode).toBe(401);
    expect(sensor.json()).toEqual({ error: "UNAUTHORIZED", message: "invalid administrator token" });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
  });

  it("keeps the Oracle writer authorized even when an unrelated reader header is wrong", async () => {
    const f = await fixture();
    await f.store.registerSensor({ ...f.trusted[0]!, label: "Synthetic registered sensor" });
    for (const row of f.rows) await f.store.addObservation(row);
    const saved = vi.spyOn(f.store, "saveAssessmentWithReceipt");
    const response = await f.app.inject({ method: "POST", url: "/v1/assessments/run",
      headers: { "x-oracle-token": oracleToken, "x-evidence-token": "wrong-reader" },
      payload: { regionId, metric, forecastHorizonHours: 1, requestedAction: "WATER_AERATION",
        requestedAmount: 0, asset: "USDC" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().evidenceReceiptId).toBe(f.receiptId);
    expect(saved).toHaveBeenCalledExactlyOnceWith(f.receipt);
    expect(vi.mocked(evaluatePolicy)).toHaveBeenCalledTimes(1);
  });

  it("keeps administrator registration authorized independently of reader headers", async () => {
    const f = await fixture();
    const registration = vi.spyOn(f.store, "registerSensor");
    const response = await f.app.inject({ method: "POST", url: "/v1/sensors",
      headers: { "x-admin-token": adminToken, "x-evidence-token": "wrong-reader" },
      payload: { ...f.trusted[0]!, label: "Synthetic authorized registration" } });
    expect(response.statusCode).toBe(201);
    expect(registration).toHaveBeenCalledExactlyOnceWith({ ...f.trusted[0]!, label: "Synthetic authorized registration" });
    expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
  });

  it("lets a valid reader reach normal input validation without causing a storage lookup", async () => {
    const f = await fixture();
    const reads = [vi.spyOn(f.store, "getEvidenceReceipt"), vi.spyOn(f.store, "listEvidenceReceipts")];
    for (const url of ["/v1/evidence-receipts/malformed", "/v1/assessments/malformed/evidence-receipts",
      `${f.catalogUrl}?limit=1e2`]) {
      const response = await f.app.inject({ method: "GET", url, headers: { "x-evidence-token": readerToken } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("INVALID_INPUT");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });

  it.each(["getEvidenceReceipt", "listEvidenceReceipts"] as const)("keeps reader %s failures generic and uncacheable", async method => {
    const f = await fixture();
    vi.spyOn(f.store, method).mockRejectedValue(new Error(`postgres://private-user:private-password@private-host/private-db ${readerToken}`));
    const response = await f.app.inject({ method: "GET", url: method === "getEvidenceReceipt" ? f.receiptUrl : f.catalogUrl,
      headers: { "x-evidence-token": readerToken } });
    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
    for (const secret of ["private-user", "private-password", "private-host", readerToken]) expect(response.body).not.toContain(secret);
  });
});

describe("evidence read capability configuration", () => {
  it.each([
    { name: "explicit empty", token: "" }, { name: "same as Oracle", token: oracleToken }
  ])("rejects $name configuration with only the static error", ({ token }) => {
    const store = new MemoryObservationStore();
    const options = { store, policySource, adminToken, oracleToken, evidenceReadToken: token as string };
    expect(() => {
      const app = buildApp(options);
      apps.push(app);
      return app;
    }).toThrowError(new Error("invalid evidence read token configuration"));
  });

});
