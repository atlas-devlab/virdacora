import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

const receiptLimit = 64 * 1024 * 1024;
const registryLimit = 1024 * 1024;
const chunkSize = 64 * 1024;
const usage = "Usage: pnpm verify:evidence <receipt.json> <trusted-registry.json>";
const failure = "Evidence receipt verification failed.";

// Treat output failures as an unsuccessful CLI invocation without printing raw
// filesystem or runtime errors. Verification never needs network or DB access.
process.stdout.on("error", () => { process.exitCode = 1; });
process.stderr.on("error", () => { process.exitCode = 1; });

async function readJsonFile(filePath: string, limit: number): Promise<unknown> {
  // Only explicit filesystem paths are supported, never stdin, URL loading,
  // UNC shares, symlinks, devices, directories or other stream-like inputs.
  if (filePath === "-" || /^[a-z][a-z0-9+.-]*:\/\//i.test(filePath) || /^[/\\]{2}/.test(filePath)) {
    throw new Error("unsupported input");
  }
  const before = await lstat(filePath);
  if (!before.isFile() || before.size > limit) throw new Error("unsupported input");
  // Nonblocking/no-follow flags also protect the lstat/open interval on systems
  // supporting them. fstat verifies the opened object before any content read.
  const file = await open(filePath,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("unsupported input");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      // Read at most one byte beyond the cap, including if the file grows after
      // the metadata check. readFile() alone would not provide that bound.
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, limit - total + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new Error("input too large");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    return JSON.parse(text) as unknown;
  } finally {
    await file.close();
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 2 || arguments_.includes("-")) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const receipt = await readJsonFile(arguments_[0]!, receiptLimit);
    const trustedSensors = await readJsonFile(arguments_[1]!, registryLimit);
    // Load the verifier only after positional/file validation; even a loading
    // failure stays on the same static error path, without exposing paths.
    const { verifyEvidenceReceipt } = await import("../services/oracle/src/evidence-receipt.js");
    const assessment = await verifyEvidenceReceipt(receipt, trustedSensors);
    process.stdout.write(`${JSON.stringify({
      valid: true,
      assessmentId: assessment.assessmentId,
      evidenceHash: assessment.evidenceHash,
      modelVersion: assessment.modelVersion,
      observationCount: assessment.observationCount,
      scope: "signed-observations-and-assessment-replay",
      trust: "caller-supplied-registry"
    })}\n`);
  } catch {
    process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  }
}

await main();
