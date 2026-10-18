import { get } from "node:http";
import { setImmediate } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { MemoryObservationStore } from "./store.js";

const policySource = `
policy "shutdown-http-test" version 1 {
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
};

describe("Oracle shutdown over a real HTTP connection", () => {
  it("drains an active request before closing the store and completing app.close", async () => {
    const store = new MemoryObservationStore();
    const probeStarted = deferred();
    const releaseProbe = deferred();
    const serverCloseStarted = deferred();
    vi.spyOn(store, "checkReadiness").mockImplementation(async () => {
      probeStarted.resolve();
      await releaseProbe.promise;
    });
    const closeStore = vi.spyOn(store, "close");
    const app = buildApp({ store, policySource, adminToken: "test-admin", oracleToken: "test-oracle" });
    let closing: Promise<void> | undefined;
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const realClose = app.server.close.bind(app.server);
      vi.spyOn(app.server, "close").mockImplementation((callback) => {
        // Delegate to the real HTTP server; this only records when draining starts.
        serverCloseStarted.resolve();
        return realClose(callback);
      });
      const response = new Promise<
        { statusCode: number | undefined; body: string } | { error: string }
      >((resolve) => {
        const request = get(`${address}/readyz`, { agent: false }, (incoming) => {
          incoming.setEncoding("utf8");
          let body = "";
          incoming.on("data", (part: string) => { body += part; });
          incoming.on("end", () => resolve({ statusCode: incoming.statusCode, body }));
          incoming.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.name }));
        });
        request.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.name }));
      });

      await probeStarted.promise;
      let closeFinished = false;
      closing = app.close().then(() => { closeFinished = true; });
      await serverCloseStarted.promise;
      await setImmediate();
      const finishedBeforeRelease = closeFinished;
      const storeClosedBeforeRelease = closeStore.mock.calls.length;
      releaseProbe.resolve();

      expect(await response).toEqual({ statusCode: 200, body: JSON.stringify({ status: "ready" }) });
      expect(finishedBeforeRelease).toBe(false);
      expect(storeClosedBeforeRelease).toBe(0);
      await closing;
      expect(closeFinished).toBe(true);
      expect(closeStore).toHaveBeenCalledTimes(1);
    } finally {
      releaseProbe.resolve();
      await (closing ?? app.close());
      vi.restoreAllMocks();
    }
  });
});
