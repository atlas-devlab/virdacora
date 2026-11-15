import { writeSync } from "node:fs";

type ShutdownSignal = "SIGINT" | "SIGTERM";
type Timer = ReturnType<typeof setTimeout>;

export interface ShutdownRuntime {
  on(signal: ShutdownSignal, listener: () => void): void;
  off(signal: ShutdownSignal, listener: () => void): void;
  setTimeout(listener: () => void, milliseconds: number): Timer;
  clearTimeout(timer: Timer): void;
  info(message: string): void;
  warn(message: string): void;
  exit(code: number): void;
}

const processRuntime: ShutdownRuntime = {
  on: (signal, listener) => { process.on(signal, listener); },
  off: (signal, listener) => { process.off(signal, listener); },
  setTimeout: (listener, milliseconds) => setTimeout(listener, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
  info: (message) => console.info(message),
  warn: (message) => {
    // emitWarning() is asynchronous and may be lost immediately before exit().
    // A broken stderr must not prevent the bounded process exit either.
    try { writeSync(2, `${message}\n`); } catch { /* No secondary error details. */ }
  },
  exit: (code) => process.exit(code)
};

/** Drain Fastify requests and its onClose hooks before exiting, with a bounded wait. */
export const registerGracefulShutdown = (
  app: { close(): Promise<void> },
  runtime: ShutdownRuntime = processRuntime
): (() => void) => {
  let started = false;
  let finished = false;
  let deadline: Timer | undefined;

  const dispose = () => {
    finished = true;
    runtime.off("SIGINT", shutdown);
    runtime.off("SIGTERM", shutdown);
    if (deadline !== undefined) {
      runtime.clearTimeout(deadline);
      deadline = undefined;
    }
  };

  const finish = (code: number, warning?: string) => {
    if (finished) return;
    dispose();
    // Errors and connection details must never reach the process warning.
    if (warning !== undefined) runtime.warn(warning);
    runtime.exit(code);
  };

  const shutdown = () => {
    if (started || finished) return;
    started = true;
    // Keep the deadline referenced: pending promises alone do not keep Node alive.
    deadline = runtime.setTimeout(() => {
      finish(1, "Oracle shutdown did not finish within 20 seconds; exiting");
    }, 20_000);
    // Deferring the call also catches a synchronous close() exception.
    void Promise.resolve().then(() => {
      const closing = app.close();
      // Emitted once only after close() has actually started draining requests.
      runtime.info("VIRDACORA_ORACLE_SHUTDOWN_STARTED");
      return closing;
    }).then(
      () => finish(0),
      () => finish(1, "Oracle shutdown failed; exiting")
    );
  };

  runtime.on("SIGINT", shutdown);
  runtime.on("SIGTERM", shutdown);
  return dispose;
};
