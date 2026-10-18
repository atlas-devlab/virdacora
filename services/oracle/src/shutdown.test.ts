import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerGracefulShutdown, type ShutdownRuntime } from "./shutdown.js";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};

const createRuntime = () => {
  const signals = new EventEmitter();
  const warnings = vi.fn();
  const info = vi.fn();
  const exit = vi.fn();
  const runtime: ShutdownRuntime = {
    on: (signal, listener) => { signals.on(signal, listener); },
    off: (signal, listener) => { signals.off(signal, listener); },
    setTimeout: (listener, milliseconds) => setTimeout(listener, milliseconds),
    clearTimeout: (timer) => clearTimeout(timer),
    info,
    warn: warnings,
    exit
  };
  return { runtime, signals, warnings, info, exit };
};

const expectDetached = (signals: EventEmitter) => {
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Oracle graceful shutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("drains close before a successful exit for %s", async (signal) => {
    const { runtime, signals, warnings, info, exit } = createRuntime();
    const draining = deferred();
    const order: string[] = [];
    const close = vi.fn(() => {
      order.push("close started");
      return draining.promise.then(() => { order.push("close completed"); });
    });
    exit.mockImplementation(() => { order.push("exit"); });
    info.mockImplementation(() => { order.push("drain marker"); });
    registerGracefulShutdown({ close }, runtime);

    signals.emit(signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(order).toEqual(["close started", "drain marker"]);
    expect(info).toHaveBeenCalledExactlyOnceWith("VIRDACORA_ORACLE_SHUTDOWN_STARTED");

    draining.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(order).toEqual(["close started", "drain marker", "close completed", "exit"]);
    expect(warnings).not.toHaveBeenCalled();
    expectDetached(signals);
  });

  it("does not start closing before a signal arrives", () => {
    const { runtime, signals, info, exit } = createRuntime();
    const close = vi.fn().mockResolvedValue(undefined);
    const dispose = registerGracefulShutdown({ close }, runtime);

    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    dispose();
    expectDetached(signals);
  });

  it("is idempotent for repeated and mixed signals while close is pending", async () => {
    const { runtime, signals, info, exit } = createRuntime();
    const draining = deferred();
    const close = vi.fn(() => draining.promise);
    registerGracefulShutdown({ close }, runtime);

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    signals.emit("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledExactlyOnceWith("VIRDACORA_ORACLE_SHUTDOWN_STARTED");
    expect(vi.getTimerCount()).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    draining.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expectDetached(signals);
  });

  it.each(["synchronous", "asynchronous"] as const)("sanitizes a %s close failure and exits once", async (mode) => {
    const { runtime, signals, warnings, info, exit } = createRuntime();
    const privateError = new Error("private SQL postgresql://private-user:private-password@private-host/db");
    const close = vi.fn(() => {
      if (mode === "synchronous") throw privateError;
      return Promise.reject(privateError);
    });
    registerGracefulShutdown({ close }, runtime);

    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(warnings).toHaveBeenCalledExactlyOnceWith("Oracle shutdown failed; exiting");
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("private");
    expect(info).toHaveBeenCalledTimes(mode === "synchronous" ? 0 : 1);
    expectDetached(signals);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits with failure at 20 seconds when close never completes", async () => {
    const { runtime, signals, warnings, exit } = createRuntime();
    const close = vi.fn(() => new Promise<void>(() => {}));
    registerGracefulShutdown({ close }, runtime);

    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(warnings).toHaveBeenCalledExactlyOnceWith("Oracle shutdown did not finish within 20 seconds; exiting");
    expectDetached(signals);
  });

  it.each(["resolve", "reject"] as const)("does not exit twice when close later %ss after the deadline", async (outcome) => {
    const { runtime, signals, warnings, info, exit } = createRuntime();
    const draining = deferred();
    const close = vi.fn(() => draining.promise);
    registerGracefulShutdown({ close }, runtime);

    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    if (outcome === "resolve") draining.resolve();
    else draining.reject(new Error("private late failure"));
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledExactlyOnceWith("VIRDACORA_ORACLE_SHUTDOWN_STARTED");
    expectDetached(signals);
  });

  it("does not extend the original deadline when a second signal arrives", async () => {
    const { runtime, signals, exit } = createRuntime();
    const close = vi.fn(() => new Promise<void>(() => {}));
    registerGracefulShutdown({ close }, runtime);

    signals.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(15_000);
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expectDetached(signals);
  });

  it("disposes listeners and the deadline without exiting or acting on late completion", async () => {
    const { runtime, signals, warnings, exit } = createRuntime();
    const draining = deferred();
    const close = vi.fn(() => draining.promise);
    const dispose = registerGracefulShutdown({ close }, runtime);
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    dispose();
    dispose();
    expectDetached(signals);
    draining.resolve();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(exit).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
