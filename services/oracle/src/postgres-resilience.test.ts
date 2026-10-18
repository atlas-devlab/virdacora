import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresObservationStore } from "./postgres-store.js";
import type { StoredObservation } from "./store.js";

const { poolConstructor } = vi.hoisted(() => ({ poolConstructor: vi.fn() }));

vi.mock("pg", () => ({ Pool: poolConstructor }));

const connectionString = "postgresql://test-user:synthetic-password@127.0.0.1/virdacora_test";
const observation: StoredObservation = {
  observationId: `0x${"1".repeat(64)}`,
  observation: {
    sensorId: "synthetic-sensor",
    regionId: "synthetic-region",
    metric: "water.oxygen.mg_l",
    value: 8,
    unit: "mg/L",
    observedAt: "2026-10-18T12:00:00.000Z",
    sequence: 1,
    signature: "YQ=="
  }
};

class FakePool extends EventEmitter {
  public readonly query = vi.fn();
  public readonly end = vi.fn().mockResolvedValue(undefined);
}

let pool: FakePool;

beforeEach(() => {
  pool = new FakePool();
  poolConstructor.mockReset();
  poolConstructor.mockImplementation(function () { return pool; });
});

afterEach(() => vi.restoreAllMocks());

describe("PostgreSQL connection resilience", () => {
  it("handles an idle pool error without crashing or issuing recovery queries", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    new PostgresObservationStore(connectionString);

    expect(() => pool.emit("error", new Error("idle connection lost"), {})).not.toThrow();

    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("reports an idle disconnect without exposing the error, connection URL or client", () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    new PostgresObservationStore(connectionString);
    const error = Object.assign(new Error(`private-error: ${connectionString}`), {
      detail: "private-server-detail",
      stack: "private-error-stack"
    });
    const client = { password: "private-client-password", host: "private-client-host" };

    expect(() => pool.emit("error", error, client)).not.toThrow();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toEqual(expect.any(String));
    expect(warning.mock.calls[0]?.[1]).toMatchObject({ code: "POSTGRES_IDLE_CONNECTION_LOST" });
    const rendered = JSON.stringify(warning.mock.calls);
    for (const forbidden of [
      connectionString, "synthetic-password", "private-error", "private-server-detail",
      "private-client-password", "private-client-host"
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("allows a later operation to obtain a healthy connection after an idle disconnect", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const store = new PostgresObservationStore(connectionString);
    const sensor = {
      sensorId: "synthetic-sensor", regionId: "synthetic-region",
      publicKeyDerBase64: "YQ==", label: "synthetic", active: true
    };

    expect(() => pool.emit("error", new Error("idle disconnect"), {})).not.toThrow();
    pool.query.mockResolvedValueOnce({ rows: [sensor] });

    await expect(store.getSensor(sensor.sensorId)).resolves.toEqual(sensor);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(poolConstructor).toHaveBeenCalledTimes(1);
  });

  it.each(["ECONNRESET", "57014", "ETIMEDOUT"])(
    "propagates an operation failure (%s) without retrying an uncertain write",
    async (code) => {
      const store = new PostgresObservationStore(connectionString);
      const error = Object.assign(new Error("operation outcome is not known"), { code });
      pool.query.mockRejectedValueOnce(error);

      await expect(store.addObservation(observation)).rejects.toBe(error);
      expect(pool.query).toHaveBeenCalledTimes(1);

      pool.query.mockResolvedValueOnce({ rows: [] });
      await expect(store.getSensor("missing")).resolves.toBeUndefined();
      expect(pool.query).toHaveBeenCalledTimes(2);
    }
  );

  it("bounds pool size and connection, server statement and client query waits", () => {
    new PostgresObservationStore(connectionString);

    expect(poolConstructor).toHaveBeenCalledTimes(1);
    expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      query_timeout: 12_000
    }));
  });

  it("waits for pool shutdown to finish without submitting another operation", async () => {
    const store = new PostgresObservationStore(connectionString);
    let finishShutdown: (() => void) | undefined;
    pool.end.mockReturnValueOnce(new Promise<void>((resolve) => { finishShutdown = resolve; }));
    let closed = false;
    const closing = store.close().then(() => { closed = true; });

    await Promise.resolve();
    expect(closed).toBe(false);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();

    finishShutdown!();
    await closing;
    expect(closed).toBe(true);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
