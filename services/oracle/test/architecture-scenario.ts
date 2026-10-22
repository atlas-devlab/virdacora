import { createPrivateKey, createPublicKey } from "node:crypto";

import { canonicalJson, signObservation } from "@terravoce/protocol";
import type { InjectOptions } from "fastify";

import { buildApp } from "../src/app.js";
import { MemoryObservationStore } from "../src/store.js";

// Deliberately public deterministic test key. Never use it for real sensors.
const privateKey = createPrivateKey({ format: "der", type: "pkcs8",
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 19)]) });
const privateKeyBase64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
const regionId = "synthetic-architecture-region";
const metric = "water.oxygen.mg_l";
const adminToken = "synthetic-architecture-admin-test-only";
const oracleToken = "synthetic-architecture-oracle-test-only";
const readerToken = "synthetic-architecture-reader-test-only";
const policySource = `
policy "architecture-contract" version 1 {
  region "synthetic-architecture-region";
  metric "water.oxygen.mg_l";
  when risk >= 0.10 and confidence >= 0.10 and observations >= 5;
  allow "WATER_AERATION" reversible;
  budget 250 USDC per 7 days;
  challenge 24 hours;
  require community challenge;
  require guardian pause;
  forbid irreversible;
}`;

export async function oracleHttpContractScenario() {
  const store = new MemoryObservationStore();
  const app = buildApp({ store, policySource, adminToken, oracleToken, evidenceReadToken: readerToken,
    now: () => new Date("2026-10-22T08:00:00.000Z") });
  const responses: { name: string; status: number; body: unknown; cacheControl: string | null }[] = [];
  const capture = async (name: string, options: InjectOptions) => {
    const result = await app.inject(options);
    const body: unknown = result.json();
    responses.push({ name, status: result.statusCode, body,
      cacheControl: typeof result.headers["cache-control"] === "string" ? result.headers["cache-control"] : null });
    return result;
  };
  try {
    await capture("health", { method: "GET", url: "/healthz" });
    await capture("readiness", { method: "GET", url: "/readyz" });
    await capture("run-auth-before-invalid-input", { method: "POST", url: "/v1/assessments/run", payload: {} });
    await capture("sensor-registration", { method: "POST", url: "/v1/sensors",
      headers: { "x-admin-token": adminToken }, payload: { sensorId: "synthetic-architecture-sensor",
        regionId, publicKeyDerBase64: publicKey, label: "Deterministic synthetic architecture fixture" } });
    const times = ["2026-10-22T02:00:00.000Z", "2026-10-22T03:00:00.000Z",
      "2026-10-22T04:00:00.1239Z", "2026-10-22T04:00:00.1231Z",
      "2026-10-22T05:00:00.000Z", "2026-10-22T06:00:00.000Z"];
    const rows = times.map((observedAt, index) => signObservation({ sensorId: "synthetic-architecture-sensor",
      regionId, metric, value: (8 - index * 0.5) * (index % 2 ? 1_000 : 1),
      unit: index % 2 ? "\u00b5g/L" : "mg/L", observedAt, sequence: index + 1 }, privateKeyBase64));
    for (const index of [5, 2, 0, 4, 1, 3]) await capture(`observation-${index}`, {
      method: "POST", url: "/v1/observations", payload: rows[index]! });
    await capture("replay", { method: "POST", url: "/v1/observations", payload: rows[0]! });
    await capture("tampered-signature", { method: "POST", url: "/v1/observations",
      payload: { ...rows[0]!, sequence: 100, value: 99 } });
    const request = { regionId, metric, forecastHorizonHours: 1,
      requestedAction: "WATER_AERATION", requestedAmount: 0, asset: "USDC" };
    await capture("reader-denied-write", { method: "POST", url: "/v1/assessments/run",
      headers: { "x-oracle-token": readerToken }, payload: request });
    const run = await capture("assessment", { method: "POST", url: "/v1/assessments/run",
      headers: { "x-oracle-token": oracleToken }, payload: request });
    if (run.statusCode !== 201) throw new Error("synthetic baseline assessment failed");
    const output = run.json<{ evidenceReceiptId: string; assessment: { assessmentId: string } }>();
    await capture("catalog", { method: "GET",
      url: `/v1/assessments/${output.assessment.assessmentId}/evidence-receipts?limit=1`,
      headers: { "x-evidence-token": readerToken } });
    await capture("packet", { method: "GET", url: `/v1/evidence-receipts/${output.evidenceReceiptId}`,
      headers: { "x-evidence-token": readerToken } });
    await capture("unknown-packet", { method: "GET", url: `/v1/evidence-receipts/0x${"f".repeat(64)}`,
      headers: { "x-evidence-token": readerToken } });
    await capture("invalid-catalog-limit", { method: "GET",
      url: `/v1/assessments/${output.assessment.assessmentId}/evidence-receipts?limit=101`,
      headers: { "x-evidence-token": readerToken } });
    await capture("latest", { method: "GET", url: `/v1/regions/${regionId}/metrics/${metric}/latest` });
    return JSON.parse(canonicalJson({ fixture: "synthetic-oracle-http-architecture-v1", responses,
      archivedRows: await store.listObservations(regionId, metric, 512) })) as unknown;
  } finally { await app.close(); }
}
