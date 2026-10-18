import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const reportDirectory = join(root, "outputs", "postgres-recovery");
const image = "postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const owner = randomUUID();
const label = "virdacora.recovery-owner";
const containerName = `virdacora-recovery-${owner}`;
const volumeName = `virdacora-recovery-data-${owner}`;
const started = performance.now();
let interrupted = false;
let containerId: string | undefined;
let temporaryDirectory: string | undefined;
let worker: ChildProcess | undefined;
let workerExited = false;
let workerHadStderr = false;
let workerUnhandledErrorObserved = false;
let workerExitCode: number | null | undefined;
let workerPid: number | undefined;
let volumeCreated = false;
let fixedHostPort: number | undefined;
const cases: Record<string, unknown>[] = [];
const controls: Record<string, unknown> = { image, owner, syntheticDataOnly: true,
  writesRetriedAutomatically: false, sameOracleProcessAndStoreIntendedAcrossBothInterruptions: true,
  productionDatabaseUrlRead: false };
const cleanup: Record<string, unknown> = {};
const failures: string[] = [];
process.on("SIGINT", () => { interrupted = true; });
process.on("SIGTERM", () => { interrupted = true; });

class RecoveryFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
function ensureActive(): void {
  if (interrupted) throw new RecoveryFailure("RUN_INTERRUPTED");
}
async function chooseLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // Docker must use this explicit port on every start. A bind race fails setup;
  // it never takes over another listener or silently chooses a different port.
  return port;
}
async function docker(args: string[], allowedFailure = false, includeStderr = false): Promise<{ ok: boolean; stdout: string }> {
  return await new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: 45_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null && !allowedFailure) reject(new RecoveryFailure("DOCKER_COMMAND_FAILED"));
        else resolve({ ok: error === null,
          stdout: error === null ? `${stdout}${includeStderr ? stderr : ""}`.trim() : "" });
      });
  });
}
async function inspectContainer(): Promise<Record<string, any>> {
  if (containerId === undefined) throw new RecoveryFailure("CONTAINER_ID_NOT_ESTABLISHED");
  const result = await docker(["inspect", "--type=container", containerId]);
  const item = (JSON.parse(result.stdout) as Record<string, any>[])[0];
  assert.equal(item?.Id, containerId);
  assert.equal(item?.Name, `/${containerName}`);
  assert.equal(item?.Config?.Labels?.[label], owner);
  assert.equal(item?.Mounts?.length, 1);
  assert.equal(item?.Mounts?.[0]?.Type, "volume");
  assert.equal(item?.Mounts?.[0]?.Name, volumeName);
  assert.equal(item?.Mounts?.[0]?.Destination, "/var/lib/postgresql");
  const bindings = item?.HostConfig?.PortBindings?.["5432/tcp"];
  assert.equal(bindings?.length, 1);
  assert.equal(bindings?.[0]?.HostIp, "127.0.0.1");
  assert.equal(bindings?.[0]?.HostPort, String(fixedHostPort));
  return item!;
}
async function inspectVolume(): Promise<void> {
  const result = await docker(["volume", "inspect", volumeName]);
  const item = (JSON.parse(result.stdout) as Record<string, any>[])[0];
  assert.equal(item?.Name, volumeName);
  assert.equal(item?.Labels?.[label], owner);
}
async function startOwnedContainer(): Promise<void> {
  ensureActive();
  await inspectContainer();
  await inspectVolume();
  await docker(["start", containerId!]);
  const started = await inspectContainer();
  assert.equal(started.NetworkSettings?.Ports?.["5432/tcp"]?.[0]?.HostPort, String(fixedHostPort));
}
async function waitForPostgres(): Promise<void> {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    ensureActive();
    const result = await docker(["exec", containerId!, "pg_isready", "-U", "virdacora_test", "-d", "virdacora_test"], true);
    if (result.ok) return;
    await delay(250);
  }
  throw new RecoveryFailure("POSTGRES_START_TIMEOUT");
}
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> };
const requests = new Map<number, Pending>();
let requestId = 0;
async function ask(command: string): Promise<Record<string, unknown>> {
  ensureActive();
  if (worker === undefined || workerExited || !worker.connected) throw new RecoveryFailure("WORKER_UNAVAILABLE");
  const id = ++requestId;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new RecoveryFailure("WORKER_COMMAND_TIMEOUT")); }, 60_000);
    requests.set(id, { resolve, reject, timer });
    worker!.send({ id, command }, error => {
      if (error === null) return;
      clearTimeout(timer);
      requests.delete(id);
      reject(new RecoveryFailure("WORKER_IPC_FAILED"));
    });
  });
}
async function launchWorker(databaseUrl: string): Promise<void> {
  const permittedEnvironment = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => permittedEnvironment.has(name)));
  worker = fork(fileURLToPath(new URL("./postgres-recovery-worker.ts", import.meta.url)), [], {
    cwd: root, execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...environment, NODE_ENV: "test", VIRDACORA_RECOVERY_DATABASE_URL: databaseUrl }
  });
  worker.stdout?.on("data", () => { /* Never forward child output or credentials. */ });
  worker.stderr?.on("data", (chunk: Buffer) => {
    workerHadStderr = true;
    if (/Unhandled ['"]error['"] event|uncaught|Emitted ['"]error['"] event/i.test(chunk.toString("utf8"))) {
      workerUnhandledErrorObserved = true;
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RecoveryFailure("WORKER_START_TIMEOUT")), 30_000);
    worker!.on("message", (message: any) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        workerPid = message.processId;
        resolve();
        return;
      }
      const pending = requests.get(message?.id);
      if (pending === undefined) return;
      requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok !== true) pending.reject(new RecoveryFailure("WORKER_ASSERTION_FAILED"));
      else if (message.result?.processId !== workerPid) pending.reject(new RecoveryFailure("WORKER_PROCESS_CHANGED"));
      else pending.resolve(message.result);
    });
    worker!.on("error", () => { clearTimeout(timer); reject(new RecoveryFailure("WORKER_START_FAILED")); });
    worker!.on("exit", code => {
      workerExited = true;
      workerExitCode = code;
      clearTimeout(timer);
      const error = new RecoveryFailure(code === 0 ? "WORKER_EXITED" : "WORKER_EXITED_NONZERO");
      reject(error);
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
      requests.clear();
    });
  });
}

let passed = false;
try {
  ensureActive();
  assert.match(owner, /^[a-f0-9-]{36}$/);
  await docker(["version", "--format", "{{.Server.Version}}"]);
  if (!(await docker(["image", "inspect", image], true)).ok) await docker(["pull", image]);
  await docker(["volume", "create", "--label", `${label}=${owner}`, volumeName]);
  volumeCreated = true;
  await inspectVolume();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "virdacora-recovery-"));
  const password = randomBytes(24).toString("hex");
  const envFile = join(temporaryDirectory, "container.env");
  await writeFile(envFile, `POSTGRES_USER=virdacora_test\nPOSTGRES_DB=virdacora_test\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
  fixedHostPort = await chooseLoopbackPort();
  const created = await docker(["create", "--name", containerName, "--label", `${label}=${owner}`,
    "--env-file", envFile, "--publish", `127.0.0.1:${fixedHostPort}:5432`, "--memory", "512m", "--cpus", "2",
    "--mount", `type=volume,source=${volumeName},target=/var/lib/postgresql`, image]);
  assert.match(created.stdout, /^[a-f0-9]{64}$/);
  containerId = created.stdout;
  await startOwnedContainer();
  await waitForPostgres();
  const inspected = await inspectContainer();
  const binding = inspected.NetworkSettings?.Ports?.["5432/tcp"];
  assert.equal(binding?.length, 1);
  assert.equal(binding?.[0]?.HostIp, "127.0.0.1");
  const port = String(binding?.[0]?.HostPort);
  assert.match(port, /^\d{1,5}$/);
  assert.equal(port, String(fixedHostPort));
  controls.explicitLoopbackPortStableAcrossRestarts = true;
  controls.stopSignal = inspected.Config.StopSignal;
  assert.equal(controls.stopSignal, "SIGINT");
  controls.volumeMount = { type: "volume", destination: "/var/lib/postgresql", freshOwnerVerified: true };
  controls.containerMemoryLimitBytes = inspected.HostConfig.Memory;
  assert.equal(controls.containerMemoryLimitBytes, 512 * 1024 * 1024);
  const databaseUrl = `postgresql://virdacora_test:${password}@127.0.0.1:${port}/virdacora_test`;
  const oracleRequire = createRequire(new URL("../services/oracle/package.json", import.meta.url));
  const { Pool } = oracleRequire("pg") as { Pool: new (options: Record<string, unknown>) => {
    query(text: string): Promise<{ rows: Record<string, string>[] }>;
    connect(): Promise<{ query(text: string): Promise<unknown>; release(): void }>;
    on(event: "error", listener: () => void): void;
    end(): Promise<void>;
  } };
  const migration = (await Promise.all(["001_init.sql", "002_timestamp_order.sql"].map(file =>
    readFile(new URL(`../services/oracle/db/${file}`, import.meta.url), "utf8")))).join("\n");
  // No administrative/inspection pool remains connected during the interruptions.
  const deadline = performance.now() + 60_000;
  let migrated = false;
  while (!migrated && performance.now() < deadline) {
    ensureActive();
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000 });
    try {
      const { rows } = await pool.query(`SELECT current_setting('server_version') AS version,
        current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit,
        current_setting('full_page_writes') AS full_page_writes`);
      assert.match(rows[0]?.version ?? "", /^18\./);
      for (const name of ["fsync", "synchronous_commit", "full_page_writes"]) assert.equal(rows[0]?.[name], "on");
      controls.databaseSettings = rows[0];
      await pool.query(migration);
      migrated = true;
    } catch {
      // Only setup/readiness is retried on a fresh, isolated and initially empty database.
      // The migration files are idempotent; no runtime application write is retried.
      if (performance.now() >= deadline) throw new RecoveryFailure("DATABASE_SETUP_TIMEOUT");
      await delay(250);
    } finally { await pool.end(); }
  }
  if (!migrated) throw new RecoveryFailure("DATABASE_SETUP_TIMEOUT");
  await launchWorker(databaseUrl);
  controls.workerProcessId = workerPid;
  controls.seed = await ask("seed");
  for (const scenario of ["clean-stop", "sigkill"] as const) {
    ensureActive();
    const before = await inspectContainer();
    assert.equal(before.State.Running, true);
    await inspectVolume();
    const scenarioStarted = performance.now();
    const scenarioStartedAt = new Date().toISOString();
    if (scenario === "clean-stop") await docker(["stop", "--time", "30", containerId!]);
    else await docker(["kill", "--signal", "SIGKILL", containerId!]);
    const stopped = await inspectContainer();
    assert.equal(stopped.State.Running, false);
    assert.equal(stopped.State.OOMKilled, false);
    assert.equal(stopped.State.ExitCode, scenario === "sigkill" ? 137 : 0);
    const down = await ask("while-down");
    await startOwnedContainer();
    await waitForPostgres();
    const recovered = await ask("after-recovery");
    const log = await docker(["logs", "--since", scenarioStartedAt, containerId!], false, true);
    const recoveryMarkers = {
      cleanShutdown: /database system is shut down/.test(log.stdout),
      interrupted: /database system was interrupted/.test(log.stdout),
      automaticRecovery: /automatic recovery in progress/.test(log.stdout),
      redoStarted: /redo starts at/.test(log.stdout),
      ready: /database system is ready to accept connections/.test(log.stdout)
    };
    if (scenario === "clean-stop") assert.equal(recoveryMarkers.cleanShutdown, true);
    else {
      assert.equal(recoveryMarkers.interrupted, true);
      assert.equal(recoveryMarkers.automaticRecovery, true);
    }
    cases.push({ name: scenario, status: "pass", signal: scenario === "clean-stop" ? "SIGINT" : "SIGKILL",
      observedStoppedExitCode: stopped.State.ExitCode, down, recovered, recoveryMarkers,
      durationMsDiagnosticOnly: Math.round(performance.now() - scenarioStarted) });
    console.log(`PostgreSQL recovery ${scenario}: passed`);
  }
  // A running database can also stop making progress on one write. Hold an
  // explicit test-only table lock and require the server statement timeout,
  // rather than a process crash, to reject the Oracle's pending INSERT.
  ensureActive();
  await inspectContainer();
  const blockedStarted = performance.now();
  const blockedStartedAt = new Date().toISOString();
  const blockerPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000,
    options: "-cstatement_timeout=10000 -clock_timeout=5000 -cidle_in_transaction_session_timeout=30000" });
  let blockerPoolErrorObserved = false;
  blockerPool.on("error", () => { blockerPoolErrorObserved = true; });
  let blockedResponse: Record<string, unknown> | undefined;
  try {
    const client = await blockerPool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("LOCK TABLE observations IN ACCESS EXCLUSIVE MODE");
        blockedResponse = await ask("while-down");
      } finally { await client.query("ROLLBACK"); }
    } finally { client.release(); }
  } finally { await blockerPool.end(); }
  assert.equal(blockerPoolErrorObserved, false);
  const recoveredAfterBlockedWrite = await ask("after-recovery");
  const blockedLog = await docker(["logs", "--since", blockedStartedAt, containerId!], false, true);
  const statementTimeoutObserved = /canceling statement due to statement timeout/i.test(blockedLog.stdout);
  assert.equal(statementTimeoutObserved, true);
  cases.push({ name: "blocked-write", status: "pass", fault: "test-only exclusive observations table lock",
    down: blockedResponse, recovered: recoveredAfterBlockedWrite, statementTimeoutObserved,
    blockerTransactionRolledBack: true, blockerPoolClosed: true,
    durationMsDiagnosticOnly: Math.round(performance.now() - blockedStarted) });
  console.log("PostgreSQL recovery blocked-write: passed");
  await ask("close");
  passed = true;
} catch (error) {
  failures.push(error instanceof RecoveryFailure ? error.code : "RECOVERY_ASSERTION_FAILED");
} finally {
  // Restore a stopped owned server before closing a still-running worker.
  if (containerId !== undefined) {
    try {
      const item = await inspectContainer();
      if (!item.State.Running && worker !== undefined && !workerExited) {
        await docker(["start", containerId]);
        await waitForPostgres();
      }
    } catch { failures.push("OWNED_SERVER_RESTORE_FAILED"); }
  }
  if (worker !== undefined && !workerExited) {
    try { if (worker.connected && !interrupted) await ask("close"); } catch { /* Forced cleanup follows. */ }
    if (!workerExited) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { worker?.kill("SIGKILL"); resolve(); }, 5_000);
        worker!.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  cleanup.workerExited = worker === undefined || workerExited;
  if (worker !== undefined && (!workerExited || workerExitCode !== 0)) {
    failures.push("WORKER_DID_NOT_EXIT_CLEANLY");
  }
  if (containerId !== undefined) {
    try {
      await inspectContainer();
      await docker(["rm", "--force", containerId]);
      const remaining = await docker(["ps", "--all", "--quiet", "--filter", `id=${containerId}`]);
      assert.equal(remaining.stdout, "");
      cleanup.containerRemoved = true;
    } catch { cleanup.containerRemoved = false; failures.push("OWNED_CONTAINER_CLEANUP_FAILED"); }
  }
  if (volumeCreated) {
    try {
      await inspectVolume();
      const references = await docker(["ps", "--all", "--quiet", "--filter", `volume=${volumeName}`]);
      assert.equal(references.stdout, "");
      await docker(["volume", "rm", volumeName]);
      const remaining = await docker(["volume", "ls", "--quiet", "--filter", `name=^${volumeName}$`]);
      assert.equal(remaining.stdout, "");
      cleanup.volumeRemoved = true;
    } catch { cleanup.volumeRemoved = false; failures.push("OWNED_VOLUME_CLEANUP_FAILED"); }
  }
  if (temporaryDirectory !== undefined) {
    try {
      await unlink(join(temporaryDirectory, "container.env"));
      await rmdir(temporaryDirectory);
      cleanup.credentialFileRemoved = true;
    } catch { cleanup.credentialFileRemoved = false; failures.push("CREDENTIAL_FILE_CLEANUP_FAILED"); }
  }
  if (interrupted) failures.push("RUN_INTERRUPTED");
  controls.workerProducedStderr = workerHadStderr;
  controls.workerUnhandledErrorObserved = workerUnhandledErrorObserved;
  controls.workerExitCode = workerExitCode ?? null;
  const interruptionCases = cases.filter(item => item.name === "clean-stop" || item.name === "sigkill");
  controls.sameOracleProcessAndStoreAcrossBothInterruptionsVerified = interruptionCases.length === 2 &&
    interruptionCases.every(item => item.status === "pass");
  controls.sameOracleProcessAndStoreAcrossAllThreeScenariosVerified = cases.length === 3 &&
    cases.every(item => item.status === "pass");
  const status = passed && failures.length === 0 ? "pass" : "fail";
  const report = { schemaVersion: 1, status, completedAt: new Date().toISOString(),
    durationMsDiagnosticOnly: Math.round(performance.now() - started), controls, cases, cleanup,
    failures: [...new Set(failures)], limitations: [
      "Synthetic API/store recovery test; no environmental field validation or forecast-skill claim.",
      "SIGKILL interrupts the PostgreSQL container process, not the host, Docker VM, disk or electrical power.",
      "Acknowledged records are checked; interrupted requests with unknown commit outcomes are not tested.",
      "No automatic write retries, exactly-once guarantee, replication, failover or availability SLA.",
      "Durations are diagnostics, not performance benchmarks or service objectives."
    ] };
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PostgreSQL recovery result: ${status}; sanitized report: outputs/postgres-recovery/results.json`);
  process.exitCode = status === "pass" ? 0 : 1;
}
