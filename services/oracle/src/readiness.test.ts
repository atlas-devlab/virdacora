import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { DomainError } from "./errors.js";
import { MemoryObservationStore } from "./store.js";

const policySource = `
policy "readiness-test" version 1 {
  region "synthetic-region";
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
const createApp = () => {
  const store = new MemoryObservationStore();
  const app = buildApp({ store, policySource, adminToken: "test-admin", oracleToken: "test-oracle" });
  apps.push(app);
  return { app, store };
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};

const trackDeadlineCleanup = () => {
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  return () => {
    const deadlines = scheduled.mock.calls.flatMap((call, index) =>
      call[1] === 2_000 ? [scheduled.mock.results[index]?.value] : []);
    expect(deadlines.length).toBeGreaterThan(0);
    for (const deadline of deadlines) expect(cleared).toHaveBeenCalledWith(deadline);
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
});

describe("Oracle readiness", () => {
  it("reports memory-store readiness without cacheable responses", async () => {
    const { app } = createApp();
    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("keeps health independent of the store and preserves its policy hash", async () => {
    const { app, store } = createApp();
    const probe = vi.spyOn(store, "checkReadiness").mockRejectedValue(new Error("unavailable"));

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", policyHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(probe).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error("private SQL postgresql://private-user:private-password@private-host/private-db"),
    new DomainError("private domain detail", 418, "PRIVATE_DOMAIN_CODE"),
    "private string failure",
    { code: "PRIVATE_SQL_CODE", detail: "private table detail" }
  ])("returns only a static unavailable response for failure case %#", async (failure) => {
    const { app, store } = createApp();
    vi.spyOn(store, "checkReadiness").mockRejectedValueOnce(failure);

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("private");
  });

  it("recovers on the next request when a failed probe becomes healthy", async () => {
    const { app, store } = createApp();
    const probe = vi.spyOn(store, "checkReadiness")
      .mockRejectedValueOnce(new Error("connection unavailable"))
      .mockResolvedValueOnce(undefined);

    const unavailable = await app.inject({ method: "GET", url: "/readyz" });
    const recovered = await app.inject({ method: "GET", url: "/readyz" });

    expect(unavailable.statusCode).toBe(503);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ status: "ready" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an earlier success after the store fails", async () => {
    const { app, store } = createApp();
    const probe = vi.spyOn(store, "checkReadiness")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(undefined);

    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent requests while the actual probe is pending", async () => {
    const { app, store } = createApp();
    await app.ready();
    vi.useFakeTimers();
    const checkDeadlineCleanup = trackDeadlineCleanup();
    const pending = deferred();
    const probe = vi.spyOn(store, "checkReadiness").mockReturnValueOnce(pending.promise);
    const requests = Array.from({ length: 8 }, () => app.inject({ method: "GET", url: "/readyz" }).then((r) => r));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);

    pending.resolve();
    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    checkDeadlineCleanup();
  });

  it("returns unavailable at the HTTP deadline without waiting for the store", async () => {
    const { app, store } = createApp();
    await app.ready();
    vi.useFakeTimers();
    const checkDeadlineCleanup = trackDeadlineCleanup();
    const pending = deferred();
    const probe = vi.spyOn(store, "checkReadiness").mockReturnValueOnce(pending.promise);
    let completed = false;
    const request = app.inject({ method: "GET", url: "/readyz" }).then((response) => {
      completed = true;
      return response;
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await request;
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(probe).toHaveBeenCalledTimes(1);
    checkDeadlineCleanup();
    pending.resolve();
    await pending.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect(probe).toHaveBeenCalledTimes(2);
    checkDeadlineCleanup();
  });

  it("keeps sharing a timed-out probe until its late failure, then checks afresh", async () => {
    const { app, store } = createApp();
    await app.ready();
    vi.useFakeTimers();
    const checkDeadlineCleanup = trackDeadlineCleanup();
    const pending = deferred();
    const probe = vi.spyOn(store, "checkReadiness")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(undefined);
    const first = app.inject({ method: "GET", url: "/readyz" }).then((r) => r);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await first).statusCode).toBe(503);

    const second = app.inject({ method: "GET", url: "/readyz" }).then((r) => r);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await second).statusCode).toBe(503);
    expect(probe).toHaveBeenCalledTimes(1);

    pending.reject(new Error("private late connection failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect(probe).toHaveBeenCalledTimes(2);
    checkDeadlineCleanup();
  });

  it("clears the deadline when the probe fails immediately", async () => {
    const { app, store } = createApp();
    await app.ready();
    vi.useFakeTimers();
    const checkDeadlineCleanup = trackDeadlineCleanup();
    vi.spyOn(store, "checkReadiness").mockRejectedValueOnce(new Error("unavailable"));

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    checkDeadlineCleanup();
  });
});
