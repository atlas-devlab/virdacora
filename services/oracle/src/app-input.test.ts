import { generateKeyPairSync } from "node:crypto";

import { signObservation } from "@terravoce/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { MemoryObservationStore } from "./store.js";

const policySource = `
policy "po-water-oxygen" version 1 {
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
const now = new Date("2026-07-15T12:00:00.000Z");
const apps: ReturnType<typeof buildApp>[] = [];
const storeMethods = [
  "registerSensor", "getSensor", "addObservation", "listObservations",
  "saveAssessment", "latestAssessment"
] as const;

function harness() {
  const store = new MemoryObservationStore();
  const calls = storeMethods.map((name) => vi.spyOn(store, name));
  const app = buildApp({ store, policySource, adminToken: "admin-secret",
    oracleToken: "oracle-secret", now: () => now });
  apps.push(app);
  return { app, store, calls };
}

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64")
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("oracle input boundaries", () => {
  it.each([
    { name: "malformed JSON", payload: '{"private-payload-secret":', type: "application/json", status: 400, code: "FST_ERR_CTP_INVALID_JSON_BODY" },
    { name: "empty JSON", payload: "", type: "application/json", status: 400, code: "FST_ERR_CTP_EMPTY_JSON_BODY" },
    { name: "oversized JSON", payload: " ".repeat(65_537), type: "application/json", status: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" },
    { name: "unsupported media", payload: "private-payload-secret", type: "application/xml", status: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" }
  ])("rejects $name before touching storage and remains healthy", async ({ payload, type, status, code }) => {
    const { app, calls } = harness();
    const response = await app.inject({ method: "POST", url: "/v1/observations",
      headers: { "content-type": type }, payload });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: code });
    expect(response.body).not.toContain("private-payload-secret");
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");
  });

  it("accepts a valid JSON body at exactly the 64 KiB byte limit", async () => {
    const { app, store } = harness();
    const pair = keys();
    const body = JSON.stringify({ sensorId: "sensor-limit", regionId: "IT-PO-DELTA",
      publicKeyDerBase64: pair.publicKey, label: "Boundary sensor" });
    const payload = body + " ".repeat(65_536 - Buffer.byteLength(body));
    expect(Buffer.byteLength(payload)).toBe(65_536);
    const response = await app.inject({ method: "POST", url: "/v1/sensors",
      headers: { "content-type": "application/json", "x-admin-token": "admin-secret" }, payload });
    expect(response.statusCode).toBe(201);
    expect((await store.getSensor("sensor-limit"))?.active).toBe(true);
  });

  it("rejects a mismatched Content-Length before touching storage", async () => {
    const { app, calls } = harness();
    const response = await app.inject({ method: "POST", url: "/v1/observations",
      headers: { "content-type": "application/json", "content-length": "1" }, payload: "{}" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "FST_ERR_CTP_INVALID_CONTENT_LENGTH" });
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("keeps valid JSON with invalid schema on the existing validation path", async () => {
    const { app, calls } = harness();
    const response = await app.inject({ method: "POST", url: "/v1/observations", payload: [] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_INPUT");
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it.each([false, true])("hides unexpected storage failures, including spoofed parser metadata (%s)", async (spoofed) => {
    const { app, store } = harness();
    const error = new Error("private-store-secret");
    if (spoofed) Object.assign(error, { code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413 });
    vi.mocked(store.getSensor).mockRejectedValueOnce(error);
    const pair = keys();
    const payload = signObservation({ sensorId: "sensor-error", regionId: "IT-PO-DELTA",
      metric: "water.oxygen.mg_l", value: 5, unit: "mg/L", observedAt: now.toISOString(), sequence: 1 }, pair.privateKey);
    const response = await app.inject({ method: "POST", url: "/v1/observations", payload });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("private-store-secret");
  });
});

describe("oracle concurrent replay protection", () => {
  it.each(["exact duplicate", "same sequence with different signed values"] as const)(
    "accepts exactly one concurrent %s", async (scenario) => {
      const { app, store } = harness();
      const pair = keys();
      await store.registerSensor({ sensorId: "sensor-race", regionId: "IT-PO-DELTA",
        publicKeyDerBase64: pair.publicKey, label: "Concurrent sensor" });
      const unsigned = { sensorId: "sensor-race", regionId: "IT-PO-DELTA",
        metric: "water.oxygen.mg_l", value: 5, unit: "mg/L", observedAt: now.toISOString(), sequence: 7 };
      const first = signObservation(unsigned, pair.privateKey);
      const observations = Array.from({ length: 16 }, (_, index) => scenario === "exact duplicate"
        ? first : signObservation({ ...unsigned, value: 5 + index / 10 }, pair.privateKey));
      const responses = await Promise.all(observations.map((payload) =>
        app.inject({ method: "POST", url: "/v1/observations", payload })));
      expect(responses.filter((response) => response.statusCode === 202)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(15);
      for (const response of responses.filter((entry) => entry.statusCode === 409)) {
        expect(response.json().error).toBe("OBSERVATION_REPLAY");
      }
      const stored = await store.listObservations("IT-PO-DELTA", "water.oxygen.mg_l", 512);
      expect(stored).toHaveLength(1);
      const accepted = responses.find((response) => response.statusCode === 202)!;
      expect(stored[0]?.observationId).toBe(accepted.json().observationId);
      expect(observations).toContainEqual(stored[0]?.observation);
    }
  );
});
