import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { observationId, signObservation, type UnsignedObservation } from "@terravoce/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeObservations } from "./analysis.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../scripts/verify-evidence-receipt.ts", import.meta.url));
const usage = "Usage: pnpm verify:evidence <receipt.json> <trusted-registry.json>\n";
const failure = "Evidence receipt verification failed.\n";
let directory: string;
let files: Set<string>;
let directories: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "virdacora-receipt-cli-"));
  files = new Set();
  directories = [];
});
afterEach(() => {
  // Remove only this test's explicitly created files and empty directories.
  for (const file of files) if (existsSync(file)) unlinkSync(file);
  for (const child of directories.reverse()) rmdirSync(child);
  rmdirSync(directory);
});

function write(name: string, content: string | Buffer): string {
  const path = join(directory, name);
  files.add(path);
  writeFileSync(path, content);
  return path;
}

function fixture(sensorId = "synthetic-cli-sensor") {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const regionId = "IT-PO-DELTA";
  const observations = [8, 7, 6.5, 6.25, 6].map((value, index) => {
    const micro = index % 2 === 0;
    const unsigned: UnsignedObservation = { sensorId, regionId, metric: "water.oxygen.mg_l",
      value: micro ? value * 1_000 : value, unit: micro ? "\u00b5g/L" : "mg/L",
      observedAt: new Date(Date.UTC(2026, 9, 18, index)).toISOString(), sequence: index + 1 };
    return { observationId: observationId(unsigned), observation: signObservation(unsigned, privateKey) };
  });
  const assessment = analyzeObservations(observations, 3_600);
  // Independent external-file fixture: do not use the receipt producer to test
  // the CLI consumer. This is the existing evidence core's exact field set.
  const { assessmentId: _assessmentId, evidenceHash: _evidenceHash,
    observationCount: _observationCount, ...coreFields } = assessment;
  const evidenceCore = { ...coreFields, observationIds: observations.map(row => row.observationId) };
  const registry = [{ sensorId, regionId, publicKeyDerBase64: publicKey }];
  const receipt = { formatVersion: "virdacora-evidence-receipt-v1", assessment, evidenceCore,
    observations, sensors: registry.map(sensor => ({ ...sensor })) };
  const receiptFile = write("receipt sample.json", JSON.stringify(receipt));
  const registryFile = write("trusted registry.json", JSON.stringify(registry));
  return { receipt, registry, receiptFile, registryFile };
}

function run(arguments_: string[]) {
  // Only local runtime paths and deliberately fake credentials reach the child.
  // Valid verification must work despite an unusable database configuration.
  const environment: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgresql://private-cli-user:private-cli-password@127.0.0.1:1/private-db",
    ADMIN_API_TOKEN: "private-cli-admin", ORACLE_API_TOKEN: "private-cli-oracle",
    OPENAI_API_KEY: "private-cli-unused-key"
  };
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...arguments_], {
    cwd: root, env: environment, encoding: "utf8", shell: false, windowsHide: true,
    timeout: 15_000, maxBuffer: 1024 * 1024
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function expectFailure(arguments_: string[], expectedStderr = failure): void {
  const result = run(arguments_);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(expectedStderr);
  expect(result.stderr).not.toContain(directory);
  expect(result.stderr).not.toContain("private-cli");
}

function invalidEncoding(json: string): Buffer {
  const valid = Buffer.from(json, "utf8");
  const replacement = Buffer.from("\ufffd", "utf8");
  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const index = valid.indexOf(replacement, position);
    if (index < 0) break;
    chunks.push(valid.subarray(position, index), Buffer.from([0xff]));
    position = index + replacement.length;
  }
  expect(position).toBeGreaterThan(0);
  chunks.push(valid.subarray(position));
  const invalid = Buffer.concat(chunks);
  // A replacement decoder would recreate the authentic signed fixture exactly.
  // Failure therefore specifically requires rejecting malformed UTF-8 bytes.
  expect(new TextDecoder("utf-8").decode(invalid)).toBe(json);
  return invalid;
}

describe("offline evidence receipt CLI", () => {
  it.each([[], ["receipt.json"], ["receipt.json", "registry.json", "extra"],
    ["-", "registry.json"], ["receipt.json", "-"]].map(arguments_ => ({ arguments_ })))("requires two explicit file paths, case %#", ({ arguments_ }) => {
    expectFailure(arguments_, usage);
  });

  it("verifies real signed evidence with caller-supplied trust and leaves both files unchanged", () => {
    const data = fixture();
    const receiptBefore = readFileSync(data.receiptFile);
    const registryBefore = readFileSync(data.registryFile);
    const result = run([data.receiptFile, data.registryFile]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ valid: true,
      assessmentId: data.receipt.assessment.assessmentId, evidenceHash: data.receipt.assessment.evidenceHash,
      modelVersion: data.receipt.assessment.modelVersion, observationCount: 5,
      scope: "signed-observations-and-assessment-replay", trust: "caller-supplied-registry" });
    expect(readFileSync(data.receiptFile)).toEqual(receiptBefore);
    expect(readFileSync(data.registryFile)).toEqual(registryBefore);
  });

  it("does not fall back to bundled keys when the separate trust file is missing or empty", () => {
    const data = fixture();
    expectFailure([data.receiptFile, join(directory, "private-missing-registry.json")]);
    writeFileSync(data.registryFile, "[]");
    expectFailure([data.receiptFile, data.registryFile]);
  });

  it("rejects coherent replacement of bundled keys and signatures against the original trusted registry", () => {
    const data = fixture();
    const replacement = generateKeyPairSync("ed25519");
    const replacementPrivate = replacement.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    data.receipt.sensors[0]!.publicKeyDerBase64 = replacement.publicKey
      .export({ format: "der", type: "spki" }).toString("base64");
    for (const row of data.receipt.observations) {
      const { signature: _signature, ...unsigned } = row.observation;
      row.observation = signObservation(unsigned, replacementPrivate);
      expect(observationId(unsigned)).toBe(row.observationId);
    }
    writeFileSync(data.receiptFile, JSON.stringify(data.receipt));
    expectFailure([data.receiptFile, data.registryFile]);
  });

  it("rejects an altered signed value with only a static failure", () => {
    const data = fixture();
    data.receipt.observations[0]!.observation.value += 1;
    writeFileSync(data.receiptFile, JSON.stringify(data.receipt));
    expectFailure([data.receiptFile, data.registryFile]);
  });

  it.each(["receipt", "registry"] as const)("rejects invalid JSON in the %s without exposing parser input", target => {
    const data = fixture();
    writeFileSync(target === "receipt" ? data.receiptFile : data.registryFile, '{"private-cli-parser-marker":');
    expectFailure([data.receiptFile, data.registryFile]);
  });

  it.each(["receipt", "registry"] as const)("rejects malformed UTF-8 in the %s rather than replacing invalid bytes", target => {
    const data = fixture("synthetic-cli-\ufffd");
    const path = target === "receipt" ? data.receiptFile : data.registryFile;
    writeFileSync(path, invalidEncoding(readFileSync(path, "utf8")));
    expectFailure([data.receiptFile, data.registryFile]);
  });

  it.each(["receipt", "registry"] as const)("rejects an oversized %s before allocating its contents", target => {
    const data = fixture();
    const path = target === "receipt" ? data.receiptFile : data.registryFile;
    truncateSync(path, (target === "receipt" ? 64 * 1024 * 1024 : 1024 * 1024) + 1);
    expectFailure([data.receiptFile, data.registryFile]);
  });

  it("refuses directories and explicit URL or UNC input instead of attempting stream/network loading", () => {
    const data = fixture();
    const child = join(directory, "input directory");
    mkdirSync(child);
    directories.push(child);
    for (const path of [child, "https://private.invalid/receipt.json", "\\\\private-server\\share\\receipt.json"]) {
      expectFailure([path, data.registryFile]);
    }
  });
});
