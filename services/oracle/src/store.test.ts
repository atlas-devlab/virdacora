import type { Assessment, SensorRegistration } from "@terravoce/protocol";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresObservationStore } from "./postgres-store.js";
import { MemoryObservationStore, type StoredObservation } from "./store.js";

const id = (value: number): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const entry = (value: number, overrides: Partial<StoredObservation["observation"]> = {}): StoredObservation => ({
  observationId: id(value),
  observation: {
    sensorId: "sensor-01", regionId: "region-01", metric: "water.oxygen.mg_l",
    value, unit: "mg/L", observedAt: new Date(Date.UTC(2026, 9, 1, 0, value)).toISOString(),
    sequence: value, signature: "YQ==", ...overrides
  }
});
const assessment = (value: number, overrides: Partial<Assessment> = {}): Assessment => ({
  assessmentId: id(value), regionId: "region-01", metric: "water.oxygen.mg_l",
  generatedAt: new Date(Date.UTC(2026, 9, 1, 0, value)).toISOString(),
  modelVersion: "synthetic-test", observationCount: 5, currentValue: 5, forecastValue: 5,
  forecastHorizonSeconds: 3600, slopePerHour: 0, anomalyScore: 0, confidence: 0,
  risk: 0, evidenceHash: id(value + 1000), ...overrides
});
const registration: SensorRegistration = {
  sensorId: "sensor-01", regionId: "region-01", publicKeyDerBase64: "YQ==", label: "synthetic"
};

const reference = (entries: StoredObservation[], regionId: string, metric: string, limit: number) =>
  entries.filter(({ observation }) => observation.regionId === regionId && observation.metric === metric)
    .sort((left, right) => {
      const time = Date.parse(left.observation.observedAt) - Date.parse(right.observation.observedAt);
      return time === 0
        ? left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0
        : time;
    }).slice(-limit);

afterEach(() => vi.restoreAllMocks());

describe("memory observation storage", () => {
  it("isolates registration inputs and returned sensor objects", async () => {
    const store = new MemoryObservationStore();
    const input = { ...registration };
    const created = await store.registerSensor(input);
    input.label = "input changed";
    created.active = false;
    created.regionId = "changed";
    const retrieved = await store.getSensor(registration.sensorId);
    expect(retrieved).toEqual({ ...registration, active: true });
    retrieved!.label = "retrieval changed";
    expect(await store.getSensor(registration.sensorId)).toEqual({ ...registration, active: true });
    expect(await store.getSensor("missing")).toBeUndefined();
    await expect(store.registerSensor(registration)).rejects.toMatchObject({ code: "SENSOR_EXISTS" });
  });

  it("isolates observation inputs and every returned snapshot", async () => {
    const store = new MemoryObservationStore();
    const input = entry(1);
    const original = structuredClone(input);
    await store.addObservation(input);
    input.observation.regionId = "changed";
    input.observation.value = 100;
    input.observation.sequence = 2;
    input.observationId = id(2);
    const rows = await store.listObservations("region-01", "water.oxygen.mg_l", 10);
    expect(rows).toEqual([original]);
    rows[0]!.observation.regionId = "retrieved-changed";
    rows[0]!.observation.value = 200;
    rows[0]!.observationId = id(3);
    rows.length = 0;
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 10)).toEqual([original]);
    expect(await store.listObservations("changed", "water.oxygen.mg_l", 10)).toEqual([]);
    await expect(store.addObservation(original)).rejects.toMatchObject({ code: "OBSERVATION_REPLAY" });
  });

  it("matches a full-sort reference for shuffled arrivals, ties, offsets and bounded tails", async () => {
    const store = new MemoryObservationStore();
    const rows = Array.from({ length: 400 }, (_, value) => entry(value, {
      regionId: value % 3 === 0 ? "other-region" : "region-01",
      metric: value % 7 === 0 ? "water.temperature.c" : "water.oxygen.mg_l",
      observedAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(value / 8))).toISOString()
    }));
    rows.push(entry(500, { observedAt: "2026-10-01T01:00:00.000+01:00" }));
    const shuffled = [...rows].sort((left, right) =>
      ((left.observation.sequence * 131) % 409) - ((right.observation.sequence * 131) % 409));
    for (const row of shuffled) await store.addObservation(row);
    for (const regionId of ["region-01", "other-region", "missing"]) {
      for (const metric of ["water.oxygen.mg_l", "water.temperature.c"]) {
        for (const limit of [1, 2, 7, 64, 512, Number.MAX_SAFE_INTEGER]) {
          expect(await store.listObservations(regionId, metric, limit)).toEqual(reference(rows, regionId, metric, limit));
        }
      }
    }
  });

  it("preserves Date.parse millisecond and ID ordering for submillisecond timestamps", async () => {
    const store = new MemoryObservationStore();
    const rows = [entry(1, { observedAt: "2026-10-01T00:00:00.1239Z" }),
      entry(2, { observedAt: "2026-10-01T00:00:00.1231Z" })];
    for (const row of [...rows].reverse()) await store.addObservation(row);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 2)).toEqual(reference(rows, "region-01", "water.oxygen.mg_l", 2));
  });

  it("orders submillisecond and offset ties by ASCII ID and takes the greatest bounded tail", async () => {
    const store = new MemoryObservationStore();
    const earlier = entry(1, { observedAt: "1969-12-31T23:59:59.1229Z" });
    const digit = entry(9, { observedAt: "1969-12-31T23:59:59.1239Z" });
    const letter = entry(10, { observedAt: "1970-01-01T00:59:59.1231+01:00" });
    for (const row of [letter, earlier, digit]) await store.addObservation(row);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 3))
      .toEqual([earlier, digit, letter]);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 1)).toEqual([letter]);
    await store.saveAssessment(assessment(10, { generatedAt: letter.observation.observedAt }));
    await store.saveAssessment(assessment(9, { generatedAt: digit.observation.observedAt }));
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l"))
      .toEqual(assessment(10, { generatedAt: letter.observation.observedAt }));
  });

  it("rejects invalid times without consuming an observation ID, sequence or assessment ID", async () => {
    const store = new MemoryObservationStore();
    await expect(store.addObservation(entry(1, { observedAt: "invalid" })))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_TIME" });
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 10)).toEqual([]);
    const valid = entry(1);
    await store.addObservation(valid);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 10)).toEqual([valid]);
    await expect(store.saveAssessment(assessment(1, { generatedAt: "invalid" })))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_TIME" });
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toBeUndefined();
    await store.saveAssessment(assessment(1));
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(assessment(1));
  });

  it("keeps region/metric keys distinct even when a colon concatenation would collide", async () => {
    const store = new MemoryObservationStore();
    const first = entry(1, { regionId: "region:water", metric: "oxygen" });
    const second = entry(2, { regionId: "region", metric: "water:oxygen" });
    await store.addObservation(first);
    await store.addObservation(second);
    expect(await store.listObservations("region:water", "oxygen", 10)).toEqual([first]);
    expect(await store.listObservations("region", "water:oxygen", 10)).toEqual([second]);
  });

  it("rejects both duplicate IDs and sensor sequences without changing the index", async () => {
    const store = new MemoryObservationStore();
    const original = entry(1);
    await store.addObservation(original);
    await expect(store.addObservation({ ...entry(2), observationId: original.observationId }))
      .rejects.toMatchObject({ code: "OBSERVATION_REPLAY" });
    await expect(store.addObservation(entry(3, { sequence: original.observation.sequence })))
      .rejects.toMatchObject({ code: "OBSERVATION_REPLAY" });
    const otherSensor = entry(4, { sensorId: "sensor-02", sequence: original.observation.sequence });
    await store.addObservation(otherSensor);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 10)).toEqual([original, otherSensor]);
  });

  it("accepts exactly one concurrent duplicate write", async () => {
    const store = new MemoryObservationStore();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.addObservation(entry(1))));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(({ status }) => status === "rejected");
    expect(rejected).toHaveLength(19);
    for (const result of rejected) {
      if (result.status === "rejected") expect(result.reason.code).toBe("OBSERVATION_REPLAY");
    }
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 10)).toEqual([entry(1)]);
  });

  it("rejects concurrent sequence replays without reserving rejected observation IDs", async () => {
    const store = new MemoryObservationStore();
    const rows = Array.from({ length: 10 }, (_, value) => entry(value + 1, { sequence: 1 }));
    const results = await Promise.allSettled(rows.map((row) => store.addObservation(row)));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const retried = entry(2, { sequence: 2 });
    await store.addObservation(retried);
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 10)).toEqual([rows[0], retried]);
  });

  it("keeps the newest assessment regardless of completion order and breaks time ties by ID", async () => {
    const store = new MemoryObservationStore();
    const newest = assessment(3);
    await store.saveAssessment(newest);
    await store.saveAssessment(assessment(1));
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(newest);
    const higherId = assessment(4, { generatedAt: newest.generatedAt });
    await store.saveAssessment(higherId);
    await store.saveAssessment(assessment(2, { generatedAt: newest.generatedAt }));
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(higherId);
    expect(await store.latestAssessment("missing", "water.oxygen.mg_l")).toBeUndefined();
  });

  it("isolates assessment snapshots and ignores conflicting duplicate IDs as PostgreSQL does", async () => {
    const store = new MemoryObservationStore();
    const input = assessment(3);
    const original = { ...input };
    await store.saveAssessment(input);
    input.generatedAt = "2026-10-02T00:00:00Z";
    input.forecastValue = 100;
    const retrieved = await store.latestAssessment("region-01", "water.oxygen.mg_l");
    expect(retrieved).toEqual(original);
    retrieved!.forecastValue = 200;
    await store.saveAssessment({ ...input });
    expect(await store.latestAssessment("region-01", "water.oxygen.mg_l")).toEqual(original);
    await store.saveAssessment({ ...input, regionId: "other-region" });
    expect(await store.latestAssessment("other-region", "water.oxygen.mg_l")).toBeUndefined();
  });

  it("keeps assessment series distinct for ambiguous colon pairs", async () => {
    const store = new MemoryObservationStore();
    const first = assessment(1, { regionId: "region:water", metric: "oxygen" });
    const second = assessment(2, { regionId: "region", metric: "water:oxygen" });
    await store.saveAssessment(first);
    await store.saveAssessment(second);
    expect(await store.latestAssessment("region:water", "oxygen")).toEqual(first);
    expect(await store.latestAssessment("region", "water:oxygen")).toEqual(second);
  });
});

describe("observation query limits", () => {
  const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  it.each(invalid)("rejects invalid limit %s before querying either backend", async (limit) => {
    const query = vi.spyOn(Pool.prototype, "query");
    const memory = new MemoryObservationStore();
    const postgres = new PostgresObservationStore("postgres://unused.invalid/test");
    await expect(memory.listObservations("region-01", "water.oxygen.mg_l", limit))
      .rejects.toMatchObject({ statusCode: 400, code: "INVALID_LIMIT" });
    await expect(postgres.listObservations("region-01", "water.oxygen.mg_l", limit))
      .rejects.toMatchObject({ statusCode: 400, code: "INVALID_LIMIT" });
    expect(query).not.toHaveBeenCalled();
    await postgres.close();
  });
});

describe("PostgreSQL query contracts without a database", () => {
  it("snapshots observation and assessment bodies before the pool can queue writes", async () => {
    const query = vi.spyOn(Pool.prototype, "query").mockResolvedValue({ rows: [] } as never);
    const store = new PostgresObservationStore("postgres://unused.invalid/test");
    const observationInput = entry(1);
    const originalObservation = structuredClone(observationInput);
    const observationWrite = store.addObservation(observationInput);
    observationInput.observation.value = 100;
    observationInput.observation.regionId = "changed";
    await observationWrite;
    expect(query.mock.calls[0]![1]).toEqual([
      originalObservation.observationId, originalObservation.observation.sensorId,
      originalObservation.observation.regionId, originalObservation.observation.metric,
      originalObservation.observation.observedAt, originalObservation.observation.sequence,
      originalObservation.observation, Date.parse(originalObservation.observation.observedAt)
    ]);
    const assessmentInput = assessment(1);
    const originalAssessment = { ...assessmentInput };
    const assessmentWrite = store.saveAssessment(assessmentInput);
    assessmentInput.forecastValue = 100;
    assessmentInput.generatedAt = "2026-10-02T00:00:00Z";
    await assessmentWrite;
    expect(query.mock.calls[1]![1]).toEqual([
      originalAssessment.assessmentId, originalAssessment.regionId, originalAssessment.metric,
      originalAssessment.generatedAt, originalAssessment, Date.parse(originalAssessment.generatedAt)
    ]);
    await store.close();
  });

  it("keeps descending SQL tie ordering and returns chronological rows", async () => {
    const rows = [entry(2), entry(1)];
    const query = vi.spyOn(Pool.prototype, "query").mockResolvedValue({ rows } as never);
    const store = new PostgresObservationStore("postgres://unused.invalid/test");
    expect(await store.listObservations("region-01", "water.oxygen.mg_l", 512)).toEqual([entry(1), entry(2)]);
    expect(query.mock.calls[0]![0]).toContain('ORDER BY observed_at_ms DESC, observation_id COLLATE "C" DESC');
    expect(query.mock.calls[0]![1]).toEqual(["region-01", "water.oxygen.mg_l", 512]);
    await store.close();
  });

  it("rejects invalid observation and assessment times before any database query", async () => {
    const query = vi.spyOn(Pool.prototype, "query").mockResolvedValue({ rows: [] } as never);
    const store = new PostgresObservationStore("postgres://unused.invalid/test");
    await expect(store.addObservation(entry(1, { observedAt: "invalid" })))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_TIME" });
    await expect(store.saveAssessment(assessment(1, { generatedAt: "invalid" })))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_TIME" });
    expect(query).not.toHaveBeenCalled();
    await store.addObservation(entry(1));
    await store.saveAssessment(assessment(1));
    expect(query).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it("writes epoch-millisecond keys separately while preserving signed fractional timestamps", async () => {
    const query = vi.spyOn(Pool.prototype, "query").mockResolvedValue({ rows: [] } as never);
    const store = new PostgresObservationStore("postgres://unused.invalid/test");
    const original = entry(9, { observedAt: "1969-12-31T23:59:59.1239Z" });
    const result = assessment(10, { generatedAt: "1970-01-01T00:59:59.1231+01:00" });
    await store.addObservation(original);
    await store.saveAssessment(result);
    expect(query.mock.calls[0]![1]).toEqual([original.observationId, "sensor-01", "region-01",
      "water.oxygen.mg_l", original.observation.observedAt, 9, original.observation, -877]);
    expect(query.mock.calls[1]![1]).toEqual([result.assessmentId, "region-01", "water.oxygen.mg_l",
      result.generatedAt, result, -877]);
    await store.latestAssessment("region-01", "water.oxygen.mg_l");
    expect(query.mock.calls[2]![0])
      .toContain('ORDER BY generated_at_ms DESC, assessment_id COLLATE "C" DESC');
    await store.close();
  });
});
