import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { observationId, signObservation, verifyObservation } from "../packages/protocol/src/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const reportDirectory = join(root, "outputs", "oracle-shutdown");
const postgresImage = "postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const owner = randomUUID();
const ownerLabel = "virdacora.shutdown-owner";
const networkName = `virdacora-shutdown-net-${owner}`;
const postgresName = `virdacora-shutdown-pg-${owner}`;
const oracleName = `virdacora-shutdown-oracle-${owner}`;
const applicationName = `virdacora-shutdown-${owner}`;
const shutdownMarker = "VIRDACORA_ORACLE_SHUTDOWN_STARTED";
const startedAt = new Date().toISOString();
let interrupted = false;
let postgresId: string | undefined;
let oracleId: string | undefined;
let networkId: string | undefined;
let temporaryDirectory: string | undefined;
let oracleImage = `virdacora-oracle-shutdown:${owner}`;
let ownImageBuilt = false;
let oracleImageId: string | undefined;
let oraclePort: number | undefined;
let pool: DatabasePool | undefined;
let poolErrorObserved = false;
const cases: Record<string, unknown>[] = [];
const failures: string[] = [];
const cleanup: Record<string, boolean> = {};
let setupStage = "INITIALIZE";
let setupErrorCode: string | undefined;
const controls: Record<string, unknown> = {
  owner, syntheticDataOnly: true, postgresImage, noAutomaticWriteRetries: true,
  productionDatabaseUrlRead: false, actualLinuxContainerSignals: true,
  compiledServerEntrypointIntended: true, shutdownMarker,
  hungCloseDeadlineNotTestedHere: true
};
process.on("SIGINT", () => { interrupted = true; });
process.on("SIGTERM", () => { interrupted = true; });

type Rows = { rows: Record<string, any>[] };
type DatabaseClient = { query(text: string, values?: unknown[]): Promise<Rows>; release(): void };
type DatabasePool = {
  query(text: string, values?: unknown[]): Promise<Rows>;
  connect(): Promise<DatabaseClient>;
  on(event: "error", listener: () => void): void;
  end(): Promise<void>;
};
type HttpOutcome = { kind: "http"; statusCode: number; body: unknown; cacheControl?: string }
  | { kind: "transport-error"; code: string };
class ShutdownFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
function active(): void {
  if (interrupted) throw new ShutdownFailure("RUN_INTERRUPTED");
}
function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ShutdownFailure(code);
}
async function docker(args: string[], allowFailure = false, includeStderr = false, timeout = 45_000): Promise<{ ok: boolean; stdout: string }> {
  return await new Promise((resolve, reject) => {
    execFile("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null && !allowFailure) reject(new ShutdownFailure("DOCKER_COMMAND_FAILED"));
      else resolve({ ok: error === null, stdout: error === null ? `${stdout}${includeStderr ? stderr : ""}`.trim() : "" });
    });
  });
}
async function inspectOwnedContainer(id: string, name: string): Promise<Record<string, any>> {
  const result = await docker(["inspect", "--type=container", id]);
  const item = (JSON.parse(result.stdout) as Record<string, any>[])[0];
  assert.equal(item?.Id, id);
  assert.equal(item?.Name, `/${name}`);
  assert.equal(item?.Config?.Labels?.[ownerLabel], owner);
  assert.equal(item?.HostConfig?.NetworkMode, networkName);
  return item!;
}
async function inspectOwnedNetwork(): Promise<void> {
  const result = await docker(["network", "inspect", networkName]);
  const item = (JSON.parse(result.stdout) as Record<string, any>[])[0];
  assert.equal(item?.Id, networkId);
  assert.equal(item?.Name, networkName);
  assert.equal(item?.Labels?.[ownerLabel], owner);
}
async function chooseOraclePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function http(path: string, payload?: unknown, headers: Record<string, string> = {}, timeout = 15_000): Promise<HttpOutcome> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: HttpOutcome) => { if (!settled) { settled = true; resolve(result); } };
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const outgoing = request({ hostname: "127.0.0.1", port: oraclePort, path,
      method: payload === undefined ? "GET" : "POST", agent: false,
      headers: { ...headers, ...(body === undefined ? {} : {
        "content-type": "application/json", "content-length": String(Buffer.byteLength(body))
      }) } }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) outgoing.destroy(new Error("TEST_RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("error", () => finish({ kind: "transport-error", code: "RESPONSE_STREAM_ERROR" }));
      response.on("end", () => {
        try {
          finish({ kind: "http", statusCode: response.statusCode ?? -1,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")), cacheControl: response.headers["cache-control"] });
        } catch { finish({ kind: "transport-error", code: "INVALID_TEST_RESPONSE" }); }
      });
    });
    outgoing.setTimeout(timeout, () => outgoing.destroy(Object.assign(new Error("test request timed out"), { code: "TEST_REQUEST_TIMEOUT" })));
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "TRANSPORT_ERROR";
      finish({ kind: "transport-error", code });
    });
    outgoing.end(body);
  });
}
function expectHttp(outcome: HttpOutcome, statusCode: number, code: string): asserts outcome is Extract<HttpOutcome, { kind: "http" }> {
  requireCondition(outcome.kind === "http" && outcome.statusCode === statusCode, code);
}
async function waitUntilReady(): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    active();
    const state = await inspectOwnedContainer(oracleId!, oracleName);
    requireCondition(state.State.Running === true, "ORACLE_EXITED_DURING_STARTUP");
    const response = await http("/readyz", undefined, {}, 3_000);
    if (response.kind === "http" && response.statusCode === 200) {
      assert.deepEqual(response.body, { status: "ready" });
      assert.equal(response.cacheControl, "no-store");
      return;
    }
    await delay(100);
  }
  throw new ShutdownFailure("ORACLE_READINESS_TIMEOUT");
}
async function assertPidOne(): Promise<void> {
  const state = await inspectOwnedContainer(oracleId!, oracleName);
  // The official Node image has docker-entrypoint.sh, which execs the CMD.
  // Inspect both the intended command and Linux's actual PID 1 rather than
  // incorrectly requiring Docker's pre-exec Path to be the Node executable.
  assert.deepEqual(state.Config?.Cmd, ["node", "dist/server.js"]);
  assert.equal(state.Image, oracleImageId);
  const result = await docker(["exec", oracleId!, "node", "-e",
    "process.stdout.write(require('node:fs').readFileSync('/proc/1/cmdline','utf8'))"]);
  assert.equal(result.stdout, "node\u0000dist/server.js\u0000");
}
async function restartOracle(): Promise<void> {
  const state = await inspectOwnedContainer(oracleId!, oracleName);
  if (state.State.Running !== true) await docker(["start", oracleId!]);
  const binding = (await inspectOwnedContainer(oracleId!, oracleName)).NetworkSettings?.Ports?.["8787/tcp"];
  assert.equal(binding?.length, 1);
  assert.equal(binding?.[0]?.HostIp, "127.0.0.1");
  assert.equal(binding?.[0]?.HostPort, String(oraclePort));
  await waitUntilReady();
  await assertPidOne();
}
async function runCase(signal: "SIGTERM" | "SIGINT", adminToken: string): Promise<void> {
  const record: Record<string, unknown> = { signal, status: "fail", syntheticDataOnly: true };
  let stage = "START";
  let blocker: DatabaseClient | undefined;
  let transactionOpen = false;
  let pendingRequest: Promise<HttpOutcome> | undefined;
  let requestSettled = false;
  try {
    await restartOracle();
    const beforeState = await inspectOwnedContainer(oracleId!, oracleName);
    record.hostProcessIdBefore = beforeState.State.Pid;
    record.pidOneEntrypointVerified = true;
    stage = "REGISTER_SENSOR";
    const sensorId = `synthetic-shutdown-${signal.toLowerCase()}`;
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expectHttp(await http("/v1/sensors", { sensorId, regionId: "IT-PO-DELTA",
      publicKeyDerBase64: publicKey, label: "Synthetic shutdown verification" }, { "x-admin-token": adminToken }),
    201, "SENSOR_REGISTRATION_FAILED");
    const unsigned = { sensorId, regionId: "IT-PO-DELTA", metric: "water.oxygen.mg_l", value: 6.25,
      unit: "mg/L", observedAt: new Date().toISOString(), sequence: 1 };
    const observation = signObservation(unsigned, privateKey);
    const expectedId = observationId(unsigned);
    stage = "BLOCK_INSERT";
    blocker = await pool!.connect();
    await blocker.query("BEGIN");
    transactionOpen = true;
    await blocker.query("LOCK TABLE observations IN ACCESS EXCLUSIVE MODE");
    pendingRequest = http("/v1/observations", observation).then(outcome => { requestSettled = true; return outcome; });
    const waitDeadline = performance.now() + 5_000;
    let blockedInsertObserved = false;
    while (performance.now() < waitDeadline) {
      active();
      const activity = await pool!.query(
        `SELECT pid FROM pg_stat_activity WHERE application_name = $1
          AND wait_event_type = 'Lock' AND state = 'active'
          AND query ~ '^\\s*INSERT\\s+INTO\\s+observations([[:space:]]|$)'`, [applicationName]);
      if (activity.rows.length === 1) { blockedInsertObserved = true; record.postgresInsertProcessId = activity.rows[0]!.pid; break; }
      requireCondition(!requestSettled, "REQUEST_FINISHED_BEFORE_LOCK_OBSERVED");
      await delay(25);
    }
    requireCondition(blockedInsertObserved, "BLOCKED_INSERT_NOT_OBSERVED");
    record.blockedInsertObservedBeforeSignal = true;
    stage = "SIGNAL";
    const signalStartedAt = new Date().toISOString();
    const signalStarted = performance.now();
    await inspectOwnedContainer(oracleId!, oracleName);
    await docker(["kill", "--signal", signal, oracleId!]);
    const markerDeadline = performance.now() + 3_000;
    let shutdownStarted = false;
    while (performance.now() < markerDeadline) {
      const logs = await docker(["logs", "--since", signalStartedAt, oracleId!], false, true);
      shutdownStarted = logs.stdout.split(/\r?\n/).includes(shutdownMarker);
      const state = await inspectOwnedContainer(oracleId!, oracleName);
      if (!state.State.Running) {
        record.exitCodeBeforeDrain = state.State.ExitCode;
        record.shutdownStartedMarkerObserved = shutdownStarted;
        record.pendingRequestAtEarlyExit = !requestSettled;
        throw new ShutdownFailure("ORACLE_EXITED_BEFORE_DRAIN");
      }
      if (shutdownStarted) break;
      await delay(25);
    }
    if (!shutdownStarted) {
      // Baseline diagnostics must not rest solely on a newly introduced log
      // marker. Independently check whether the old server still accepts a new
      // real HTTP connection after receiving the Linux signal.
      const stillAlive = await inspectOwnedContainer(oracleId!, oracleName);
      record.oracleRunningAfterSignalWithoutMarker = stillAlive.State.Running === true;
      record.pendingRequestAfterSignalWithoutMarker = !requestSettled;
      const liveness = await http("/healthz", undefined, {}, 2_000);
      record.livenessAfterSignalWithoutMarker = liveness.kind === "http"
        ? { kind: "http", statusCode: liveness.statusCode }
        : { kind: "transport-error", code: liveness.code };
      record.acceptsNewHttpConnectionAfterSignalWithoutMarker = liveness.kind === "http" && liveness.statusCode === 200;
    }
    requireCondition(shutdownStarted, "SHUTDOWN_START_MARKER_NOT_OBSERVED");
    record.shutdownStartedMarkerObserved = true;
    requireCondition(!requestSettled, "PENDING_REQUEST_DID_NOT_SURVIVE_SIGNAL");
    record.pendingRequestSurvivedSignal = true;
    const drainingState = await inspectOwnedContainer(oracleId!, oracleName);
    requireCondition(drainingState.State.Running === true, "ORACLE_NOT_ALIVE_DURING_DRAIN");
    assert.equal(drainingState.State.Pid, beforeState.State.Pid);
    record.sameProcessAliveDuringDrain = true;
    stage = "LATE_REQUEST";
    // A distinct valid sequence makes an accidentally accepted late write
    // detectable; replaying the first observation could hide it behind 409.
    const lateUnsigned = { ...unsigned, sequence: 2, value: 6.5 };
    const lateObservation = signObservation(lateUnsigned, privateKey);
    const lateId = observationId(lateUnsigned);
    const late = await http("/v1/observations", lateObservation, {}, 2_000);
    record.lateRequest = late.kind === "http" ? { kind: "http", statusCode: late.statusCode }
      : { kind: "transport-error", code: late.code };
    requireCondition((late.kind === "http" && late.statusCode === 503) ||
      (late.kind === "transport-error" && ["ECONNREFUSED", "ECONNRESET"].includes(late.code)),
      "LATE_REQUEST_NOT_REJECTED_AS_EXPECTED");
    // Docker's published-port proxy can reset rather than refuse a new TCP
    // connection. Neither transport error alone proves a missing DB commit.
    stage = "RELEASE_LOCK";
    await blocker.query("ROLLBACK");
    transactionOpen = false;
    blocker.release();
    blocker = undefined;
    const accepted = await pendingRequest;
    expectHttp(accepted, 202, "DRAINED_REQUEST_NOT_ACKNOWLEDGED");
    assert.equal((accepted.body as { observationId?: string }).observationId, expectedId);
    record.drainedRequestStatus = 202;
    record.acknowledgedObservationIdMatches = true;
    stage = "WAIT_CLEAN_EXIT";
    const exitDeadline = performance.now() + 15_000;
    let stopped: Record<string, any> | undefined;
    while (performance.now() < exitDeadline) {
      const state = await inspectOwnedContainer(oracleId!, oracleName);
      if (!state.State.Running) { stopped = state; break; }
      await delay(25);
    }
    requireCondition(stopped !== undefined, "ORACLE_DID_NOT_EXIT_AFTER_DRAIN");
    assert.equal(stopped.State.ExitCode, 0);
    assert.equal(stopped.State.OOMKilled, false);
    record.exitCodeAfterAcknowledgement = 0;
    record.signalToCleanExitMsDiagnosticOnly = Math.round(performance.now() - signalStarted);
    requireCondition(Number(record.signalToCleanExitMsDiagnosticOnly) < 20_000, "SUCCESSFUL_DRAIN_EXCEEDED_TEST_BOUND");
    const rows = await pool!.query("SELECT observation_id, body FROM observations WHERE sensor_id = $1", [sensorId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.observation_id, expectedId);
    assert.deepEqual(rows.rows[0]!.body, observation);
    assert.equal(verifyObservation(rows.rows[0]!.body, publicKey), true);
    assert.equal(rows.rows.some(row => row.observation_id === lateId), false);
    record.exactlyOneSignedRecordVerified = true;
    stage = "RESTART_AND_REPLAY";
    await restartOracle();
    const restartedState = await inspectOwnedContainer(oracleId!, oracleName);
    record.hostProcessIdAfterRestart = restartedState.State.Pid;
    const replay = await http("/v1/observations", observation);
    expectHttp(replay, 409, "REPLAY_NOT_REJECTED_AFTER_RESTART");
    assert.equal((replay.body as { error?: string }).error, "OBSERVATION_REPLAY");
    const tamper = await http("/v1/observations", { ...observation, sequence: 2, value: 99 });
    expectHttp(tamper, 401, "TAMPER_NOT_REJECTED_AFTER_RESTART");
    assert.equal((tamper.body as { error?: string }).error, "INVALID_SIGNATURE");
    const afterRows = await pool!.query("SELECT observation_id, body FROM observations WHERE sensor_id = $1", [sensorId]);
    assert.deepEqual(afterRows.rows, rows.rows);
    record.distinctLateObservationAbsentAfterExitAndRestart = true;
    record.lateRequestNotAccepted = true;
    record.readyAfterRestart = 200;
    record.replayStatusAfterRestart = 409;
    record.tamperStatusAfterRestart = 401;
    record.signedRecordUnchangedAfterRestart = true;
    record.status = "pass";
  } catch (error) {
    record.failedStage = stage;
    record.failure = error instanceof ShutdownFailure ? error.code : "SHUTDOWN_CASE_ASSERTION_FAILED";
  } finally {
    if (blocker !== undefined) {
      try { if (transactionOpen) await blocker.query("ROLLBACK"); }
      catch { record.blockerRollbackFailed = true; }
      finally { blocker.release(); }
    }
    if (pendingRequest !== undefined) {
      const result = await pendingRequest;
      record.finalRequestOutcome = result.kind === "http" ? { kind: "http", statusCode: result.statusCode }
        : { kind: "transport-error", code: result.code };
      if (record.failure === "SHUTDOWN_START_MARKER_NOT_OBSERVED") {
        // The lock is now released and the real request has settled. Record
        // process lifecycle independently from the missing instrumentation.
        const afterResponse = await inspectOwnedContainer(oracleId!, oracleName);
        record.oracleRunningAfterUnlockedRequestCompleted = afterResponse.State.Running === true;
        record.hostProcessIdAfterUnlockedRequestCompleted = afterResponse.State.Pid;
        record.exitCodeAfterUnlockedRequestCompleted = afterResponse.State.Running ? null : afterResponse.State.ExitCode;
      }
    }
    cases.push(record);
    console.log(`Oracle shutdown ${signal}: ${record.status}`);
  }
}

try {
  setupStage = "CLI_AND_DOCKER";
  active();
  const arguments_ = process.argv.slice(2);
  requireCondition(arguments_.length === 0 || (arguments_.length === 2 && arguments_[0] === "--oracle-image"), "INVALID_CLI_ARGUMENTS");
  if (arguments_.length === 2) {
    requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(arguments_[1] ?? ""), "INVALID_ORACLE_IMAGE_TAG");
    oracleImage = arguments_[1]!;
  }
  await docker(["version", "--format", "{{.Server.Version}}"]);
  if (!(await docker(["image", "inspect", postgresImage], true)).ok) await docker(["pull", postgresImage]);
  if (arguments_.length === 0) {
    setupStage = "BUILD_ORACLE_IMAGE";
    await docker(["build", "--label", `${ownerLabel}=${owner}`, "--file", "services/oracle/Dockerfile", "--tag", oracleImage, "."], false, false, 300_000);
    ownImageBuilt = true;
  }
  const imageInspection = (JSON.parse((await docker(["image", "inspect", oracleImage])).stdout) as Record<string, any>[])[0];
  oracleImageId = imageInspection?.Id;
  requireCondition(typeof oracleImageId === "string" && /^sha256:[a-f0-9]{64}$/.test(oracleImageId), "ORACLE_IMAGE_ID_NOT_ESTABLISHED");
  controls.oracleImage = oracleImage;
  controls.oracleImageId = oracleImageId;
  controls.imageBuiltByRunner = ownImageBuilt;
  setupStage = "CREATE_TEST_NETWORK_AND_CREDENTIALS";
  networkId = (await docker(["network", "create", "--label", `${ownerLabel}=${owner}`, networkName])).stdout;
  await inspectOwnedNetwork();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "virdacora-shutdown-"));
  const password = randomBytes(24).toString("hex");
  const adminToken = randomBytes(24).toString("hex");
  const postgresEnv = join(temporaryDirectory, "postgres.env");
  const oracleEnv = join(temporaryDirectory, "oracle.env");
  await writeFile(postgresEnv, `POSTGRES_USER=virdacora_test\nPOSTGRES_DB=virdacora_test\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
  await writeFile(oracleEnv, `DATABASE_URL=postgresql://virdacora_test:${password}@${postgresName}:5432/virdacora_test?application_name=${applicationName}\nADMIN_API_TOKEN=${adminToken}\nORACLE_API_TOKEN=${randomBytes(24).toString("hex")}\nPOLICY_PATH=/app/policies/po-water-v1.terra\nPORT=8787\nHOST=0.0.0.0\n`, { mode: 0o600 });
  setupStage = "CREATE_AND_START_POSTGRES";
  postgresId = (await docker(["create", "--name", postgresName, "--label", `${ownerLabel}=${owner}`,
    "--network", networkName, "--env-file", postgresEnv, "--publish", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql:rw,size=268435456", "--memory", "512m", "--cpus", "2", postgresImage])).stdout;
  assert.match(postgresId, /^[a-f0-9]{64}$/);
  await inspectOwnedContainer(postgresId, postgresName);
  await docker(["start", postgresId]);
  setupStage = "WAIT_FOR_POSTGRES_TCP";
  const pgDeadline = performance.now() + 45_000;
  let postgresReady = false;
  while (performance.now() < pgDeadline) {
    active();
    // The official image starts a socket-only temporary server during initdb.
    // Require TCP so that server cannot produce a premature ready signal.
    if ((await docker(["exec", postgresId, "pg_isready", "-h", "127.0.0.1", "-U", "virdacora_test", "-d", "virdacora_test"], true)).ok) {
      postgresReady = true; break;
    }
    await delay(100);
  }
  requireCondition(postgresReady, "POSTGRES_START_TIMEOUT");
  controls.postgresTcpReadinessRequired = true;
  setupStage = "INSPECT_POSTGRES_BINDING";
  const pgState = await inspectOwnedContainer(postgresId, postgresName);
  const pgBinding = pgState.NetworkSettings?.Ports?.["5432/tcp"];
  assert.equal(pgBinding?.length, 1);
  assert.equal(pgBinding?.[0]?.HostIp, "127.0.0.1");
  const pgPort = String(pgBinding?.[0]?.HostPort);
  assert.match(pgPort, /^\d{1,5}$/);
  setupStage = "CONNECT_POSTGRES_INSPECTOR";
  const oracleRequire = createRequire(new URL("../services/oracle/package.json", import.meta.url));
  const { Pool } = oracleRequire("pg") as { Pool: new (options: Record<string, unknown>) => DatabasePool };
  pool = new Pool({ connectionString: `postgresql://virdacora_test:${password}@127.0.0.1:${pgPort}/virdacora_test`,
    max: 3, connectionTimeoutMillis: 5_000, options: "-cstatement_timeout=10000 -clock_timeout=5000 -cidle_in_transaction_session_timeout=30000" });
  pool.on("error", () => { poolErrorObserved = true; });
  const version = await pool.query("SELECT current_setting('server_version') AS version");
  assert.match(String(version.rows[0]?.version), /^18\./);
  controls.postgresVersion = version.rows[0]?.version;
  setupStage = "APPLY_MIGRATIONS";
  const migrations = await Promise.all(["001_init.sql", "002_timestamp_order.sql", "003_evidence_receipts.sql", "004_receipt_catalog.sql"].map(file =>
    readFile(new URL(`../services/oracle/db/${file}`, import.meta.url), "utf8")));
  await pool.query(migrations.join("\n"));
  oraclePort = await chooseOraclePort();
  setupStage = "CREATE_ORACLE";
  oracleId = (await docker(["create", "--name", oracleName, "--label", `${ownerLabel}=${owner}`,
    "--network", networkName, "--env-file", oracleEnv, "--publish", `127.0.0.1:${oraclePort}:8787`,
    "--memory", "256m", "--cpus", "2", oracleImage])).stdout;
  assert.match(oracleId, /^[a-f0-9]{64}$/);
  setupStage = "RUN_SIGNAL_CASES";
  for (const signal of ["SIGTERM", "SIGINT"] as const) await runCase(signal, adminToken);
  requireCondition(!poolErrorObserved, "INSPECTOR_POOL_ERROR_OBSERVED");
} catch (error) {
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)) {
    setupErrorCode = error.code;
  }
  failures.push(error instanceof ShutdownFailure ? error.code : "SHUTDOWN_SETUP_OR_ASSERTION_FAILED");
} finally {
  if (pool !== undefined) {
    try { await pool.end(); cleanup.inspectorPoolClosed = true; }
    catch { cleanup.inspectorPoolClosed = false; failures.push("INSPECTOR_POOL_CLOSE_FAILED"); }
  }
  for (const [kind, id, name] of [["oracle", oracleId, oracleName], ["postgres", postgresId, postgresName]] as const) {
    if (id === undefined) continue;
    try {
      await inspectOwnedContainer(id, name);
      await docker(["rm", "--force", id]);
      assert.equal((await docker(["ps", "--all", "--quiet", "--filter", `id=${id}`])).stdout, "");
      cleanup[`${kind}ContainerRemoved`] = true;
    } catch { cleanup[`${kind}ContainerRemoved`] = false; failures.push("OWNED_CONTAINER_CLEANUP_FAILED"); }
  }
  if (networkId !== undefined) {
    try {
      await inspectOwnedNetwork();
      await docker(["network", "rm", networkId]);
      assert.equal((await docker(["network", "ls", "--quiet", "--filter", `id=${networkId}`])).stdout, "");
      cleanup.networkRemoved = true;
    } catch { cleanup.networkRemoved = false; failures.push("OWNED_NETWORK_CLEANUP_FAILED"); }
  }
  if (temporaryDirectory !== undefined) {
    try {
      for (const file of ["postgres.env", "oracle.env"]) await unlink(join(temporaryDirectory, file));
      await rmdir(temporaryDirectory);
      cleanup.credentialFilesRemoved = true;
    } catch { cleanup.credentialFilesRemoved = false; failures.push("CREDENTIAL_FILE_CLEANUP_FAILED"); }
  }
  if (ownImageBuilt && oracleImageId !== undefined) {
    try {
      const image = (JSON.parse((await docker(["image", "inspect", oracleImage])).stdout) as Record<string, any>[])[0];
      assert.equal(image?.Id, oracleImageId);
      assert.equal(image?.Config?.Labels?.[ownerLabel], owner);
      await docker(["image", "rm", oracleImage]);
      cleanup.runnerBuiltImageRemoved = true;
    } catch { cleanup.runnerBuiltImageRemoved = false; failures.push("OWNED_IMAGE_CLEANUP_FAILED"); }
  }
  if (interrupted) failures.push("RUN_INTERRUPTED");
  const status = failures.length === 0 && cases.length === 2 && cases.every(item => item.status === "pass") ? "pass" : "fail";
  const report = { schemaVersion: 1, status, startedAt, completedAt: new Date().toISOString(), controls,
    cases, cleanup, setupStage, setupErrorCode, failures: [...new Set(failures)], limitations: [
      "Synthetic signed requests against the compiled Oracle server running as PID 1 in Linux containers.",
      "Positive drain cases only; a never-settling close deadline is tested separately with a unit fake clock.",
      "Transport errors are distinguished from real HTTP responses; no synthetic HTTP status zero.",
      "No host power loss, environmental field validation, write retry, exactly-once guarantee or availability SLA.",
      "Durations are diagnostics for this test execution, not production performance benchmarks."
    ] };
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Oracle shutdown result: ${status}; sanitized report: outputs/oracle-shutdown/results.json`);
  process.exitCode = status === "pass" ? 0 : 1;
}
